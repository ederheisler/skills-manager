#ifndef SKILLS_BOUNDARY_LIST_H
#define SKILLS_BOUNDARY_LIST_H

/* Included after tree.h, open_root(), and fail() in skills-boundary.c. */
#define BOUNDARY_LIST_MAX_ENTRIES 100000U
#define BOUNDARY_LIST_MAX_DEPTH 512U

struct boundary_list_buffer {
    char *data;
    size_t length;
    size_t capacity;
};

struct boundary_list_state {
    struct boundary_list_buffer json;
    struct boundary_list_buffer path;
    struct tree_mount mount;
    size_t entries;
    int include_hidden;
};

static int boundary_list_append(struct boundary_list_buffer *buffer,
                                const char *data, size_t length)
{
    size_t needed, capacity;
    char *larger;

    if (length > SIZE_MAX - buffer->length - 1) {
        errno = EOVERFLOW;
        return -1;
    }
    needed = buffer->length + length + 1;
    if (needed > buffer->capacity) {
        capacity = buffer->capacity == 0 ? 256 : buffer->capacity;
        while (capacity < needed) {
            if (capacity > SIZE_MAX - capacity / 2) {
                capacity = needed;
                break;
            }
            capacity += capacity / 2;
        }
        larger = realloc(buffer->data, capacity);
        if (larger == NULL) return -1;
        buffer->data = larger;
        buffer->capacity = capacity;
    }
    if (length != 0) memcpy(buffer->data + buffer->length, data, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
    return 0;
}

/* A JavaScript path cannot round-trip arbitrary non-UTF-8 POSIX names. */
static int boundary_list_validate_name(const char *name, size_t length)
{
    const unsigned char *bytes = (const unsigned char *)name;
    size_t i = 0;

    while (i < length) {
        unsigned char first = bytes[i];
        size_t count, j;

        if (first < 0x80) {
            ++i;
            continue;
        }
        if (first >= 0xc2 && first <= 0xdf) count = 2;
        else if (first >= 0xe0 && first <= 0xef) count = 3;
        else if (first >= 0xf0 && first <= 0xf4) count = 4;
        else goto invalid;
        if (count > length - i) goto invalid;
        for (j = 1; j < count; ++j) {
            if (bytes[i + j] < 0x80 || bytes[i + j] > 0xbf) goto invalid;
        }
        if ((first == 0xe0 && bytes[i + 1] < 0xa0) ||
            (first == 0xed && bytes[i + 1] > 0x9f) ||
            (first == 0xf0 && bytes[i + 1] < 0x90) ||
            (first == 0xf4 && bytes[i + 1] > 0x8f)) goto invalid;
        i += count;
    }
    return 0;
invalid:
    errno = EILSEQ;
    return -1;
}

static int boundary_list_json_path(struct boundary_list_state *state)
{
    static const char hex[] = "0123456789abcdef";
    const char *path = state->path.data;
    size_t i, start = 0;

    for (i = 0; i < state->path.length; ++i) {
        unsigned char c = (unsigned char)path[i];
        char escaped[6];
        size_t escaped_length;

        if (c >= 0x20 && c != '"' && c != '\\') continue;
        if (boundary_list_append(&state->json, path + start, i - start) < 0)
            return -1;
        if (c == '"' || c == '\\') {
            escaped[0] = '\\';
            escaped[1] = (char)c;
            escaped_length = 2;
        } else {
            escaped[0] = '\\';
            escaped[1] = 'u';
            escaped[2] = '0';
            escaped[3] = '0';
            escaped[4] = hex[c >> 4];
            escaped[5] = hex[c & 15];
            escaped_length = 6;
        }
        if (boundary_list_append(&state->json, escaped, escaped_length) < 0)
            return -1;
        start = i + 1;
    }
    return boundary_list_append(&state->json, path + start,
                                state->path.length - start);
}

static int boundary_list_add(struct boundary_list_state *state, const char *kind)
{
    static const char path_prefix[] = "{\"path\":\"";
    static const char kind_prefix[] = "\",\"kind\":\"";
    static const char suffix[] = "\"}";

    if ((state->entries != 0 && boundary_list_append(&state->json, ",", 1) < 0) ||
        boundary_list_append(&state->json, path_prefix, sizeof(path_prefix) - 1) < 0 ||
        boundary_list_json_path(state) < 0 ||
        boundary_list_append(&state->json, kind_prefix, sizeof(kind_prefix) - 1) < 0 ||
        boundary_list_append(&state->json, kind, strlen(kind)) < 0 ||
        boundary_list_append(&state->json, suffix, sizeof(suffix) - 1) < 0)
        return -1;
    ++state->entries;
    return 0;
}

static int boundary_list_check_named(int parentfd, const char *name,
                                     const struct stat *snapshot,
                                     const struct tree_mount *mount)
{
    struct stat current;
    if (fstatat(parentfd, name, &current, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (!tree_same_snapshot(snapshot, &current)) {
        errno = ESTALE;
        return -1;
    }
    return tree_check_mount_entry(parentfd, name, &current, mount);
}

static int boundary_list_check_opened(int fd, int parentfd, const char *name,
                                      const struct stat *snapshot,
                                      const struct tree_mount *mount)
{
    struct stat current;
    if (tree_check_mount_fd(fd, mount) < 0) return -1;
    if (parentfd >= 0) return tree_check_source(parentfd, name, fd, snapshot, mount);
    if (fstat(fd, &current) < 0) return -1;
    if (!tree_same_snapshot(snapshot, &current)) {
        errno = ESTALE;
        return -1;
    }
    return 0;
}

/* Takes ownership of fd, even on failure. */
static int boundary_list_walk_directory(struct boundary_list_state *state, int fd,
                                        int parentfd, const char *name,
                                        const struct stat *snapshot,
                                        unsigned int depth);

static int boundary_list_visit_entry(struct boundary_list_state *state, int parentfd,
                                     const char *name, unsigned int depth)
{
    struct stat before;
    const char *kind;
    size_t name_length = strlen(name), previous_length = state->path.length;
    int fd = -1, result = -1, saved;

    if (tree_component(name) < 0 || boundary_list_validate_name(name, name_length) < 0)
        goto done;
    if (fstatat(parentfd, name, &before, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_entry(parentfd, name, &before, &state->mount) < 0)
        goto done;

    if (S_ISDIR(before.st_mode)) kind = "directory";
    else if (S_ISREG(before.st_mode)) kind = "file";
    else if (S_ISLNK(before.st_mode)) kind = "symlink";
    else { errno = ENOTSUP; goto done; }

    if (!S_ISLNK(before.st_mode)) {
        int flags;
        if (S_ISDIR(before.st_mode)) {
            flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
        } else {
#if defined(__linux__)
            /* O_PATH pins metadata without requiring file-read permission or
             * opening a swapped-in device. O_NOFOLLOW never opens its target. */
            flags = O_PATH | O_NOFOLLOW | O_CLOEXEC;
#else
            flags = O_EVTONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
#endif
        }
        fd = openat(parentfd, name, flags);
        if (fd < 0 || boundary_list_check_opened(fd, parentfd, name, &before,
                                                  &state->mount) < 0)
            goto done;
    }

    if ((previous_length != 0 && boundary_list_append(&state->path, "/", 1) < 0) ||
        boundary_list_append(&state->path, name, name_length) < 0 ||
        boundary_list_add(state, kind) < 0)
        goto done;

    if (S_ISDIR(before.st_mode)) {
        int owned = fd;
        fd = -1;
        if (boundary_list_walk_directory(state, owned, parentfd, name, &before, depth) < 0 ||
            boundary_list_check_named(parentfd, name, &before, &state->mount) < 0)
            goto done;
    } else if (S_ISREG(before.st_mode)) {
        if (boundary_list_check_opened(fd, parentfd, name, &before, &state->mount) < 0)
            goto done;
    } else if (boundary_list_check_named(parentfd, name, &before, &state->mount) < 0) {
        goto done;
    }
    result = 0;
done:
    saved = errno;
    if (fd >= 0 && close(fd) < 0 && result == 0) { saved = errno; result = -1; }
    state->path.length = previous_length;
    if (state->path.data != NULL) state->path.data[previous_length] = '\0';
    if (result < 0) errno = saved;
    return result;
}

static int boundary_list_walk_directory(struct boundary_list_state *state, int fd,
                                        int parentfd, const char *name,
                                        const struct stat *snapshot,
                                        unsigned int depth)
{
    DIR *dir = fdopendir(fd);
    int result = -1, saved;

    if (dir == NULL) {
        saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    for (;;) {
        struct dirent *entry;
        int read_error;

        if (boundary_list_check_opened(fd, parentfd, name, snapshot, &state->mount) < 0)
            goto done;
        errno = 0;
        entry = readdir(dir);
        read_error = errno;
        if (boundary_list_check_opened(fd, parentfd, name, snapshot, &state->mount) < 0)
            goto done;
        if (entry == NULL) {
            if (read_error != 0) { errno = read_error; goto done; }
            break;
        }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
            continue;
        if (!state->include_hidden &&
            (entry->d_name[0] == '.' || strcmp(entry->d_name, "__pycache__") == 0))
            continue;
        if (state->entries >= BOUNDARY_LIST_MAX_ENTRIES) { errno = E2BIG; goto done; }
        if (depth >= BOUNDARY_LIST_MAX_DEPTH) { errno = ELOOP; goto done; }
        if (boundary_list_visit_entry(state, fd, entry->d_name, depth + 1) < 0)
            goto done;
    }
    result = 0;
done:
    saved = errno;
    if (closedir(dir) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) errno = saved;
    return result;
}

static int boundary_list_write(const struct boundary_list_buffer *json)
{
    static const char hex[] = "0123456789abcdef";
    char encoded[8192];
    size_t offset = 0;

    if (fwrite("READY\t", 1, 6, stdout) != 6) return -1;
    while (offset < json->length) {
        size_t i, count = json->length - offset;
        if (count > sizeof(encoded) / 2) count = sizeof(encoded) / 2;
        for (i = 0; i < count; ++i) {
            unsigned char byte = (unsigned char)json->data[offset + i];
            encoded[2 * i] = hex[byte >> 4];
            encoded[2 * i + 1] = hex[byte & 15];
        }
        if (fwrite(encoded, 1, count * 2, stdout) != count * 2) return -1;
        offset += count;
    }
    if (fputc('\n', stdout) == EOF || fflush(stdout) == EOF) return -1;
    return 0;
}

/* Enumerate a selected directory while retaining every descriptor back to root. */
static int boundary_list_subtree(struct boundary_list_state *state, const char *root,
                                 const char *relative, const char *expected_identity)
{
    struct boundary_walk walk;
    struct boundary_part *selected;
    int listing = -1, result = -1, saved;

    if (boundary_walk_open(root, relative, expected_identity, &walk) < 0) goto done;
    selected = &walk.parts[walk.count - 1];
    if (!S_ISDIR(selected->st.st_mode)) { errno = ENOTDIR; goto done; }
    selected->fd = openat(walk.parent, selected->name,
                          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (selected->fd < 0) { boundary_stale_if_missing(); goto done; }
    state->mount = walk.mount;
    if (boundary_list_check_opened(selected->fd, walk.parent, selected->name,
                                   &selected->st, &state->mount) < 0 ||
        boundary_check_chain(root, walk.rootfd, &walk.root_st, &walk.mount,
                             walk.parts, walk.count) < 0)
        goto done;

    /* fdopendir owns the duplicate; retain the pinned descriptor for revalidation. */
    listing = fcntl(selected->fd, F_DUPFD_CLOEXEC, 0);
    if (listing < 0) goto done;
    {
        int owned = listing;
        listing = -1;
        if (boundary_list_walk_directory(state, owned, walk.parent, selected->name,
                                         &selected->st, 0) < 0)
            goto done;
    }
    if (boundary_check_chain(root, walk.rootfd, &walk.root_st, &walk.mount,
                             walk.parts, walk.count) < 0)
        goto done;
    result = 0;
done:
    saved = errno;
    if (listing >= 0) close(listing);
    boundary_walk_close(&walk);
    if (result < 0) errno = saved;
    return result;
}

static int boundary_list(const char *root, int include_hidden,
                         const char *expected_identity, const char *relative)
{
    struct boundary_list_state state = { 0 };
    struct stat snapshot, reopened;
    int fd = -1, check = -1, result = -1, saved;
    state.include_hidden = include_hidden;

    if (root == NULL) { errno = EINVAL; goto done; }
    if (relative != NULL) {
        if (boundary_list_append(&state.json, "[", 1) < 0 ||
            boundary_list_subtree(&state, root, relative, expected_identity) < 0)
            goto done;
    } else {
        fd = open_root(root);
        if (fd < 0 || fstat(fd, &snapshot) < 0) goto done;
        if (!S_ISDIR(snapshot.st_mode)) { errno = ENOTDIR; goto done; }
        if (expected_identity != NULL) {
            char identity[65];
            if (boundary_identity_fd(fd, identity) < 0) goto done;
            if (strcmp(identity, expected_identity) != 0) { errno = ESTALE; goto done; }
        }
        if (tree_mount_fd(fd, &state.mount) < 0 ||
            boundary_list_append(&state.json, "[", 1) < 0)
            goto done;
        {
            int owned = fd;
            fd = -1;
            if (boundary_list_walk_directory(&state, owned, -1, NULL, &snapshot, 0) < 0)
                goto done;
        }

        /* Confirm that the canonical root still names the pinned directory. */
        check = open_root(root);
        if (check < 0 || fstat(check, &reopened) < 0 ||
            tree_check_mount_fd(check, &state.mount) < 0)
            goto done;
        if (!tree_same_snapshot(&snapshot, &reopened)) { errno = ESTALE; goto done; }
        if (close(check) < 0) { check = -1; goto done; }
        check = -1;
    }
    if (boundary_list_append(&state.json, "]", 1) < 0) goto done;
    errno = 0;
    if (boundary_list_write(&state.json) < 0) {
        if (errno == 0) errno = EIO;
        goto done;
    }
    result = 0;
done:
    saved = errno;
    if (fd >= 0) close(fd);
    if (check >= 0) close(check);
    free(state.path.data);
    free(state.json.data);
    if (result < 0) {
        errno = saved;
        return fail(saved == EILSEQ ? "Cannot list a directory containing invalid UTF-8 names"
                                    : "Cannot safely list the requested directory");
    }
    return 0;
}

#endif
