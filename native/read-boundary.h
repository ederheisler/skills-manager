#ifndef SKILLS_BOUNDARY_READ_H
#define SKILLS_BOUNDARY_READ_H

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include "identity.h"

struct boundary_part {
    char *name;
    struct stat st;
    int fd;
};

/* open_root accepts a component-normalized absolute path. */
static int boundary_absolute(const char *path)
{
    const char *part, *p;
    size_t length;
    if (path == NULL || path[0] != '/') { errno = EINVAL; return -1; }
    if (path[1] == '\0') return 0;
    part = path + 1;
    for (p = part;; ++p) {
        if (*p != '/' && *p != '\0') continue;
        length = (size_t)(p - part);
        if (length == 0 || (length == 1 && part[0] == '.') ||
            (length == 2 && part[0] == '.' && part[1] == '.')) {
            errno = EINVAL;
            return -1;
        }
        if (*p == '\0') return 0;
        part = p + 1;
    }
}

static int boundary_relative_parts(char *path, struct boundary_part **out, size_t *count)
{
    const char *part, *p;
    struct boundary_part *parts;
    size_t n = 0, length, i;
    char *cursor;

    if (path == NULL || path[0] == '\0' || path[0] == '/') {
        errno = EINVAL;
        return -1;
    }
    part = path;
    for (p = path;; ++p) {
        unsigned char byte = (unsigned char)*p;
        if (byte != 0 && byte != '/') continue;
        length = (size_t)(p - part);
        if (length == 0 || (length == 1 && part[0] == '.') ||
            (length == 2 && part[0] == '.' && part[1] == '.') ||
            ascii_name_equal(part, length, STATE)) {
            errno = EINVAL;
            return -1;
        }
        if (n == SIZE_MAX / sizeof(*parts)) { errno = EOVERFLOW; return -1; }
        ++n;
        if (byte == 0) break;
        part = p + 1;
    }
    parts = calloc(n, sizeof(*parts));
    if (parts == NULL) return -1;
    cursor = path;
    for (i = 0; i < n; ++i) {
        char *slash;
        parts[i].name = cursor;
        parts[i].fd = -1;
        slash = strchr(cursor, '/');
        if (slash != NULL) { *slash = '\0'; cursor = slash + 1; }
    }
    *out = parts;
    *count = n;
    return 0;
}

static int boundary_stale_if_missing(void)
{
    if (errno == ENOENT) errno = ESTALE;
    return -1;
}

/* Verify both the held descriptors and their names before using a result. */
static int boundary_check_chain(const char *root, int rootfd,
                                const struct stat *root_st,
                                const struct tree_mount *mount,
                                const struct boundary_part *parts, size_t count)
{
    struct stat st, opened;
    int root_again, parent = rootfd, saved;
    size_t i;

    root_again = open_root(root);
    if (root_again < 0) {
        if (errno == ENOENT || errno == ENOTDIR || errno == ELOOP) errno = ESTALE;
        return -1;
    }
    if (fstat(rootfd, &st) < 0 || fstat(root_again, &opened) < 0 ||
        tree_check_mount_fd(rootfd, mount) < 0 ||
        tree_check_mount_fd(root_again, mount) < 0) {
        saved = errno;
        close(root_again);
        errno = saved;
        return -1;
    }
    close(root_again);
    if (!tree_same_snapshot(root_st, &st) || !tree_same_snapshot(root_st, &opened)) {
        errno = ESTALE;
        return -1;
    }
    for (i = 0; i < count; ++i) {
        if (fstatat(parent, parts[i].name, &st, AT_SYMLINK_NOFOLLOW) < 0)
            return boundary_stale_if_missing();
        if (!tree_same_snapshot(&parts[i].st, &st)) { errno = ESTALE; return -1; }
        if (tree_check_mount_entry(parent, parts[i].name, &st, mount) < 0)
            return boundary_stale_if_missing();
        if (parts[i].fd >= 0) {
            if (fstat(parts[i].fd, &opened) < 0 ||
                tree_check_mount_fd(parts[i].fd, mount) < 0) return -1;
            if (!tree_same_snapshot(&parts[i].st, &opened)) { errno = ESTALE; return -1; }
            parent = parts[i].fd;
        }
    }
    return 0;
}

struct boundary_walk {
    char *copy;
    struct boundary_part *parts;
    size_t count;
    int rootfd, parent;
    struct stat root_st;
    struct tree_mount mount;
};

static void boundary_walk_close(struct boundary_walk *walk)
{
    int saved = errno;
    size_t i;
    if (walk->parts != NULL) {
        for (i = 0; i < walk->count; ++i)
            if (walk->parts[i].fd >= 0) close(walk->parts[i].fd);
    }
    if (walk->rootfd >= 0) close(walk->rootfd);
    free(walk->parts);
    free(walk->copy);
    errno = saved;
}

/* Pin the root and every ancestor; the final entry is not followed or opened. */
static int boundary_walk_open(const char *root, const char *relative,
                              const char *expected_identity, struct boundary_walk *walk)
{
    struct stat probe;
    char root_identity[65];
    size_t i, completed = 0;

    memset(walk, 0, sizeof(*walk));
    walk->rootfd = -1;
    walk->parent = -1;
    if (boundary_absolute(root) < 0 || relative == NULL) {
        if (relative == NULL) errno = EINVAL;
        return -1;
    }
    walk->copy = strdup(relative);
    if (walk->copy == NULL ||
        boundary_relative_parts(walk->copy, &walk->parts, &walk->count) < 0) return -1;
    walk->rootfd = open_root(root);
    if (walk->rootfd < 0) return -1;
    if (fstat(walk->rootfd, &walk->root_st) < 0 ||
        tree_mount_fd(walk->rootfd, &walk->mount) < 0 ||
        tree_check_mount_fd(walk->rootfd, &walk->mount) < 0) return -1;
    if (expected_identity != NULL) {
        if (boundary_identity_fd(walk->rootfd, root_identity) < 0) return -1;
        if (strcmp(root_identity, expected_identity) != 0) { errno = ESTALE; return -1; }
    }
    walk->parent = walk->rootfd;
    for (i = 0; i < walk->count; ++i) {
        struct boundary_part *part = &walk->parts[i];
        if (fstatat(walk->parent, part->name, &part->st, AT_SYMLINK_NOFOLLOW) < 0) {
            if (errno == ENOENT) {
                if (boundary_check_chain(root, walk->rootfd, &walk->root_st, &walk->mount,
                                         walk->parts, completed) < 0) return -1;
                if (fstatat(walk->parent, part->name, &probe, AT_SYMLINK_NOFOLLOW) == 0)
                    errno = ESTALE;
            }
            return -1;
        }
        if (i == 0) {
            struct stat controlled;
            int present = entry_stat(walk->rootfd, STATE, &controlled);
            if (present < 0) return -1;
            if (present && same_inode(&controlled, (uint64_t)part->st.st_dev, (uint64_t)part->st.st_ino)) {
                errno = EPERM;
                return -1;
            }
        }
        if (tree_check_mount_entry(walk->parent, part->name, &part->st, &walk->mount) < 0)
            return boundary_stale_if_missing();
        if (i + 1 < walk->count) {
            if (!S_ISDIR(part->st.st_mode)) { errno = ENOTDIR; return -1; }
            part->fd = openat(walk->parent, part->name,
                              O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
            if (part->fd < 0) return boundary_stale_if_missing();
            if (fstat(part->fd, &probe) < 0 || tree_check_mount_fd(part->fd, &walk->mount) < 0)
                return -1;
            if (!S_ISDIR(probe.st_mode) || !tree_same_snapshot(&part->st, &probe)) {
                errno = ESTALE;
                return -1;
            }
            walk->parent = part->fd;
        }
        ++completed;
    }
    return 0;
}

static void boundary_hash_stat(struct tree_sha256 *hash, const struct stat *st)
{
#if defined(__APPLE__)
    const struct timespec *mtime = &st->st_mtimespec, *ctime = &st->st_ctimespec;
#else
    const struct timespec *mtime = &st->st_mtim, *ctime = &st->st_ctim;
#endif
    tree_hash_u64(hash, (uint64_t)st->st_dev);
    tree_hash_u64(hash, (uint64_t)st->st_ino);
    tree_hash_u64(hash, (uint64_t)st->st_mode);
    tree_hash_u64(hash, (uint64_t)st->st_size);
    tree_hash_u64(hash, (uint64_t)mtime->tv_sec);
    tree_hash_u64(hash, (uint64_t)mtime->tv_nsec);
    tree_hash_u64(hash, (uint64_t)ctime->tv_sec);
    tree_hash_u64(hash, (uint64_t)ctime->tv_nsec);
}

/* Directory content changes do not change the identity of the path to a leaf. */
static void boundary_hash_stable_directory(struct tree_sha256 *hash, const struct stat *st)
{
    tree_hash_u64(hash, (uint64_t)st->st_dev);
    tree_hash_u64(hash, (uint64_t)st->st_ino);
    tree_hash_u64(hash, (uint64_t)st->st_mode);
    tree_hash_u64(hash, (uint64_t)st->st_uid);
    tree_hash_u64(hash, (uint64_t)st->st_gid);
}

static void boundary_hash_stable_leaf(struct tree_sha256 *hash, const struct stat *st)
{
    boundary_hash_stat(hash, st);
    tree_hash_u64(hash, (uint64_t)st->st_nlink);
    tree_hash_u64(hash, (uint64_t)st->st_uid);
    tree_hash_u64(hash, (uint64_t)st->st_gid);
    tree_hash_u64(hash, (uint64_t)st->st_rdev);
}

/* Store source bytes in the back half, then encode forwards without a copy. */
static int boundary_content(int parent, const char *name, const struct stat *before,
                            const struct tree_mount *mount, uint64_t max_bytes,
                            struct tree_sha256 *content_hash,
                            int *fd_out, char **hex_out, size_t *hex_length)
{
    static const char digits[] = "0123456789abcdef";
    uint64_t size, wanted;
    size_t take, capacity, used = 0, i;
    unsigned char *buffer = NULL, *bytes;
    struct stat opened;
    int fd = -1, saved;
    ssize_t n;

    if (before->st_size < 0) { errno = EOVERFLOW; return -1; }
    size = (uint64_t)before->st_size;
    wanted = size < max_bytes ? size : max_bytes;
    if (wanted > (uint64_t)((SIZE_MAX - 1) / 2) || wanted > (uint64_t)(SSIZE_MAX - 1)) {
        errno = EOVERFLOW;
        return -1;
    }
    take = (size_t)wanted;
    capacity = take * 2 + 1;
    if (S_ISLNK(before->st_mode) && content_hash != NULL) {
        if (size > (uint64_t)(SIZE_MAX - take - 1) || size > (uint64_t)(SSIZE_MAX - 1)) {
            errno = EOVERFLOW;
            return -1;
        }
        capacity = take + (size_t)size + 1;
    }
    buffer = malloc(capacity);
    if (buffer == NULL) return -1;
    bytes = buffer + take;

    if (S_ISREG(before->st_mode)) {
        fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) { boundary_stale_if_missing(); goto error; }
        if (fstat(fd, &opened) < 0 || tree_check_mount_fd(fd, mount) < 0) goto error;
        if (!S_ISREG(opened.st_mode) || !tree_same_snapshot(before, &opened)) {
            errno = ESTALE;
            goto error;
        }
        while (used < take) {
            size_t chunk = take - used;
            if (chunk > 1024U * 1024U) chunk = 1024U * 1024U;
            n = read(fd, bytes + used, chunk);
            if (n < 0) { if (errno == EINTR) continue; goto error; }
            if (n == 0) { errno = ESTALE; goto error; }
            used += (size_t)n;
        }
        if (content_hash != NULL) {
            uint64_t remaining = size - used;
            unsigned char chunk[16384];
            tree_sha256_update(content_hash, bytes, used);
            while (remaining != 0) {
                size_t wanted_chunk = remaining < sizeof(chunk) ? (size_t)remaining : sizeof(chunk);
                n = read(fd, chunk, wanted_chunk);
                if (n < 0) { if (errno == EINTR) continue; goto error; }
                if (n == 0) { errno = ESTALE; goto error; }
                tree_sha256_update(content_hash, chunk, (size_t)n);
                remaining -= (uint64_t)n;
            }
        }
    } else if (S_ISLNK(before->st_mode)) {
        /* One probe byte verifies st_size even when the requested limit is zero. */
        size_t limit = content_hash != NULL ? (size_t)size : take;
        do { n = readlinkat(parent, name, (char *)bytes, limit + 1); } while (n < 0 && errno == EINTR);
        if (n < 0) { boundary_stale_if_missing(); goto error; }
        if ((uint64_t)n != (content_hash != NULL ? size : size > (uint64_t)take ? (uint64_t)take + 1 : (uint64_t)take)) {
            errno = ESTALE;
            goto error;
        }
        if (content_hash != NULL) tree_sha256_update(content_hash, bytes, (size_t)n);
        used = take;
    } else {
        errno = ENOTSUP;
        goto error;
    }
    for (i = 0; i < used; ++i) {
        unsigned char byte = bytes[i];
        buffer[i * 2] = (unsigned char)digits[byte >> 4];
        buffer[i * 2 + 1] = (unsigned char)digits[byte & 15];
    }
    buffer[used * 2] = '\0';
    *fd_out = fd;
    *hex_out = (char *)buffer;
    *hex_length = used * 2;
    return 0;
error:
    saved = errno;
    if (fd >= 0) close(fd);
    free(buffer);
    errno = saved;
    return -1;
}

static int boundary_read(const char *root, const char *relative, uint64_t max_bytes,
                         const char *expected_identity)
{
    static const char domain[] = "skills-manager-path-identity-v1";
    static const char stable_domain[] = "skills-manager-stable-path-identity-v1";
    struct boundary_walk walk;
    struct boundary_part *leaf;
    struct tree_sha256 hash, stable_hash;
    char *hex = NULL, identity[65], stable_identity[65];
    const char *reason = "Cannot safely read path";
    size_t hex_length = 0, root_length, i;
    int saved, result = -1;
    uint64_t size;

    if (boundary_walk_open(root, relative, expected_identity, &walk) < 0) goto done;
    leaf = &walk.parts[walk.count - 1];
    if (!S_ISREG(leaf->st.st_mode) && !S_ISLNK(leaf->st.st_mode)) {
        errno = ENOTSUP;
        goto done;
    }
    tree_sha256_init(&hash);
    tree_sha256_update(&hash, domain, sizeof(domain) - 1);
    tree_sha256_init(&stable_hash);
    tree_sha256_update(&stable_hash, stable_domain, sizeof(stable_domain) - 1);
    root_length = strlen(root);
    tree_hash_u64(&hash, (uint64_t)root_length);
    tree_sha256_update(&hash, root, root_length);
    tree_hash_u64(&stable_hash, (uint64_t)root_length);
    tree_sha256_update(&stable_hash, root, root_length);
    boundary_hash_stat(&hash, &walk.root_st);
    boundary_hash_stable_directory(&stable_hash, &walk.root_st);
    for (i = 0; i < walk.count; ++i) {
        size_t length = strlen(walk.parts[i].name);
        tree_hash_u64(&hash, (uint64_t)length);
        tree_sha256_update(&hash, walk.parts[i].name, length);
        boundary_hash_stat(&hash, &walk.parts[i].st);
        tree_hash_u64(&stable_hash, (uint64_t)length);
        tree_sha256_update(&stable_hash, walk.parts[i].name, length);
        if (i + 1 == walk.count)
            boundary_hash_stable_leaf(&stable_hash, &walk.parts[i].st);
        else
            boundary_hash_stable_directory(&stable_hash, &walk.parts[i].st);
    }
    if (boundary_content(walk.parent, leaf->name, &leaf->st, &walk.mount,
                         max_bytes, &stable_hash, &leaf->fd, &hex, &hex_length) < 0 ||
        boundary_check_chain(root, walk.rootfd, &walk.root_st, &walk.mount,
                             walk.parts, walk.count) < 0) goto done;

    tree_sha256_hex(&hash, identity);
    tree_sha256_hex(&stable_hash, stable_identity);
    size = (uint64_t)leaf->st.st_size;
    if (printf("READY\t%s\t%o\t%s\t%s\t%" PRIu64 "\t%d\t",
               S_ISREG(leaf->st.st_mode) ? "file" : "symlink",
               (unsigned int)(leaf->st.st_mode & 07777), identity, stable_identity,
               size, size > max_bytes ? 1 : 0) < 0 ||
        fwrite(hex, 1, hex_length, stdout) != hex_length ||
        putchar('\n') == EOF || fflush(stdout) == EOF) {
        reason = "Cannot write read response";
        goto done;
    }
    result = 0;
done:
    saved = errno;
    boundary_walk_close(&walk);
    free(hex);
    if (result == 0) return 0;
    errno = saved;
    return fail(reason);
}

static int boundary_count_lines(const char *root, const char *relative,
                                const char *expected_identity)
{
    struct boundary_walk walk;
    struct boundary_part *leaf;
    struct stat opened;
    unsigned char buffer[16384];
    uint64_t size, total = 0, lines = 0;
    int previous_cr = 0, ended_with_break = 1, result = -1, saved;
    ssize_t n;

    if (boundary_walk_open(root, relative, expected_identity, &walk) < 0) goto done;
    leaf = &walk.parts[walk.count - 1];
    if (!S_ISREG(leaf->st.st_mode)) { errno = ENOTSUP; goto done; }
    if (leaf->st.st_size < 0) { errno = EOVERFLOW; goto done; }
    size = (uint64_t)leaf->st.st_size;
    leaf->fd = openat(walk.parent, leaf->name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (leaf->fd < 0) { boundary_stale_if_missing(); goto done; }
    if (fstat(leaf->fd, &opened) < 0 || tree_check_mount_fd(leaf->fd, &walk.mount) < 0)
        goto done;
    if (!S_ISREG(opened.st_mode) || !tree_same_snapshot(&leaf->st, &opened)) {
        errno = ESTALE;
        goto done;
    }
    while (total < size) {
        uint64_t remaining = size - total;
        size_t i, chunk = remaining < sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
        n = read(leaf->fd, buffer, chunk);
        if (n < 0) { if (errno == EINTR) continue; goto done; }
        if (n == 0) { errno = ESTALE; goto done; }
        total += (uint64_t)n;
        for (i = 0; i < (size_t)n; ++i) {
            if (buffer[i] == '\r') {
                if (lines == UINT64_MAX) { errno = EOVERFLOW; goto done; }
                ++lines;
                previous_cr = 1;
                ended_with_break = 1;
            } else if (buffer[i] == '\n') {
                if (!previous_cr) {
                    if (lines == UINT64_MAX) { errno = EOVERFLOW; goto done; }
                    ++lines;
                }
                previous_cr = 0;
                ended_with_break = 1;
            } else {
                previous_cr = 0;
                ended_with_break = 0;
            }
        }
    }
    if (!ended_with_break) {
        if (lines == UINT64_MAX) { errno = EOVERFLOW; goto done; }
        ++lines;
    }
    if (boundary_check_chain(root, walk.rootfd, &walk.root_st, &walk.mount,
                             walk.parts, walk.count) < 0) goto done;
    if (printf("READY\t%" PRIu64 "\n", lines) < 0 || fflush(stdout) == EOF) goto done;
    result = 0;
done:
    saved = errno;
    boundary_walk_close(&walk);
    if (result == 0) return 0;
    errno = saved;
    return fail("Cannot safely count file lines");
}

static int boundary_directory_identity(const char *absolute)
{
    char token[65];
    int fd, saved;
    if (boundary_absolute(absolute) < 0) return fail("Invalid directory path");
    fd = open_root(absolute);
    if (fd < 0) return fail("Cannot open directory identity");
    if (boundary_identity_fd(fd, token) < 0) {
        saved = errno;
        close(fd);
        errno = saved;
        return fail("Cannot capture directory identity");
    }
    close(fd);
    if (printf("READY\t%s\n", token) < 0 || fflush(stdout) == EOF)
        return fail("Cannot write directory identity");
    return 0;
}

/* Sibling changes may alter a parent's times, size and link count without
   changing its identity or access-controlling metadata. */
static int boundary_same_parent(const struct stat *a, const struct stat *b,
                                int require_snapshot)
{
    if (require_snapshot) return tree_same_snapshot(a, b);
    return tree_same_identity(a, b) && a->st_mode == b->st_mode &&
           a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
           a->st_rdev == b->st_rdev;
}

/* A parent descriptor obtained through '..' must still name the approved parent. */
static int boundary_check_parent(const char *path, int parent,
                                 const struct stat *before,
                                 const struct tree_mount *mount, int require_snapshot)
{
    struct stat held, named;
    int again, saved;
    again = open_root(path);
    if (again < 0) {
        if (errno == ENOENT || errno == ENOTDIR || errno == ELOOP) errno = ESTALE;
        return -1;
    }
    if (fstat(parent, &held) < 0 || fstat(again, &named) < 0 ||
        tree_check_mount_fd(parent, mount) < 0 || tree_check_mount_fd(again, mount) < 0) {
        saved = errno;
        close(again);
        errno = saved;
        return -1;
    }
    close(again);
    if (!boundary_same_parent(before, &held, require_snapshot) ||
        !boundary_same_parent(before, &named, require_snapshot)) {
        errno = ESTALE;
        return -1;
    }
    return 0;
}

static int boundary_read_parent_lock(const char *root, const char *expected_identity)
{
    static const char name[] = ".skill-lock.json";
    const uint64_t limit = UINT64_C(1024) * 1024;
    struct tree_mount root_mount, parent_mount;
    struct stat root_st, parent_st, lock_st, after, opened;
    char *parent_path = NULL, *slash, *hex = NULL;
    char root_identity[65];
    size_t hex_length = 0;
    int rootfd = -1, parent = -1, file = -1, missing = 0, result = -1, saved;

    if (boundary_absolute(root) < 0) return fail("Invalid skills root");
    parent_path = strdup(root);
    if (parent_path == NULL) goto done;
    slash = strrchr(parent_path, '/');
    if (slash == parent_path) slash[1] = '\0';
    else *slash = '\0';
    rootfd = open_root(root);
    if (rootfd < 0) goto done;
    if (fstat(rootfd, &root_st) < 0 || tree_mount_fd(rootfd, &root_mount) < 0) goto done;
    if (expected_identity != NULL) {
        if (boundary_identity_fd(rootfd, root_identity) < 0) goto done;
        if (strcmp(root_identity, expected_identity) != 0) { errno = ESTALE; goto done; }
    }
    parent = openat(rootfd, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (parent < 0 || fstat(parent, &parent_st) < 0 || tree_mount_fd(parent, &parent_mount) < 0)
        goto done;
    if (boundary_check_parent(parent_path, parent, &parent_st, &parent_mount, 1) < 0) goto done;
    if (fstatat(parent, name, &lock_st, AT_SYMLINK_NOFOLLOW) < 0) {
        if (errno != ENOENT) goto done;
        missing = 1;
    } else {
        if (!S_ISREG(lock_st.st_mode)) { errno = ENOTSUP; goto done; }
        if (lock_st.st_size < 0 || (uint64_t)lock_st.st_size > limit) { errno = EFBIG; goto done; }
        if (tree_check_mount_entry(parent, name, &lock_st, &parent_mount) < 0) {
            boundary_stale_if_missing();
            goto done;
        }
        if (boundary_content(parent, name, &lock_st, &parent_mount, limit,
                             NULL, &file, &hex, &hex_length) < 0) goto done;
        if (fstat(file, &opened) < 0 || fstatat(parent, name, &after, AT_SYMLINK_NOFOLLOW) < 0) {
            boundary_stale_if_missing();
            goto done;
        }
        if (!tree_same_snapshot(&lock_st, &opened) || !tree_same_snapshot(&lock_st, &after)) {
            errno = ESTALE;
            goto done;
        }
        if (tree_check_mount_fd(file, &parent_mount) < 0 ||
            tree_check_mount_entry(parent, name, &after, &parent_mount) < 0) {
            boundary_stale_if_missing();
            goto done;
        }
    }
    if (boundary_check_chain(root, rootfd, &root_st, &root_mount, NULL, 0) < 0 ||
        boundary_check_parent(parent_path, parent, &parent_st, &parent_mount, 1) < 0) goto done;
    if (missing) {
        if (fstatat(parent, name, &after, AT_SYMLINK_NOFOLLOW) == 0) { errno = ESTALE; goto done; }
        if (errno != ENOENT) goto done;
        if (puts("READY") == EOF || fflush(stdout) == EOF) goto done;
    } else if (fputs("READY\t", stdout) == EOF ||
               fwrite(hex, 1, hex_length, stdout) != hex_length ||
               putchar('\n') == EOF || fflush(stdout) == EOF) goto done;
    result = 0;
done:
    saved = errno;
    if (file >= 0) close(file);
    if (parent >= 0) close(parent);
    if (rootfd >= 0) close(rootfd);
    free(parent_path);
    free(hex);
    if (result == 0) return 0;
    errno = saved;
    return fail("Cannot safely read parent skill lock");
}

/* Escape protocol controls while retaining a usable, unambiguous cleanup path. */
static int boundary_cleanup_path(char *out, size_t capacity, const char *path)
{
    static const char digits[] = "0123456789abcdef";
    size_t used = 0;
    const unsigned char *p = (const unsigned char *)path;
    for (; *p != 0; ++p) {
        size_t need = (*p < 32 || *p == 127) ? 4 : (*p == '\\' ? 2 : 1);
        if (need >= capacity - used) { errno = ENAMETOOLONG; return -1; }
        if (need == 4) {
            out[used++] = '\\'; out[used++] = 'x';
            out[used++] = digits[*p >> 4]; out[used++] = digits[*p & 15];
        } else {
            if (need == 2) out[used++] = '\\';
            out[used++] = (char)*p;
        }
    }
    out[used] = '\0';
    return 0;
}

static int boundary_dispose_error(const char *reason, const char *path, int saved)
{
    char escaped[320], message[448];
    if (boundary_cleanup_path(escaped, sizeof(escaped), path) < 0)
        snprintf(message, sizeof(message), "%s; manual cleanup at the requested workspace path", reason);
    else
        snprintf(message, sizeof(message), "%s; manual cleanup path: %s", reason, escaped);
    errno = saved;
    return fail(message);
}

static int boundary_remove_disposable(const char *absolute, const char *token)
{
    struct tree_mount parent_mount;
    struct stat parent_st, before, opened, entry;
    char *storage = NULL, *slash, *name, *parent_path;
    char actual[65], quarantine[96], quarantine_path[384], escaped[320];
    const char *cleanup = absolute, *reason = "Cannot safely dispose workspace";
    int parent = -1, workspace = -1, moved = 0, result = -1, saved;
    unsigned int counter;

    if (boundary_absolute(absolute) < 0 || strcmp(absolute, "/") == 0 ||
        token == NULL || strlen(token) != 64) {
        return boundary_dispose_error("Invalid disposable workspace identity or path",
                                      absolute != NULL ? absolute : "(unknown)", EINVAL);
    }
    storage = strdup(absolute);
    if (storage == NULL) goto done;
    slash = strrchr(storage, '/');
    name = slash + 1;
    if (slash == storage) parent_path = "/";
    else { *slash = '\0'; parent_path = storage; }
    parent = open_root(parent_path);
    if (parent < 0) goto done;
    if (fstat(parent, &parent_st) < 0 || tree_mount_fd(parent, &parent_mount) < 0) goto done;
    if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) < 0) goto done;
    if (!S_ISDIR(before.st_mode)) { errno = ENOTDIR; goto done; }
    if (tree_check_mount_entry(parent, name, &before, &parent_mount) < 0) goto done;
    workspace = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (workspace < 0) { boundary_stale_if_missing(); goto done; }
    if (fstat(workspace, &opened) < 0 || tree_check_mount_fd(workspace, &parent_mount) < 0 ||
        boundary_identity_fd(workspace, actual) < 0) goto done;
    if (!tree_same_identity(&before, &opened) || strcmp(actual, token) != 0) {
        errno = ESTALE;
        goto done;
    }
    if (fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) < 0) {
        boundary_stale_if_missing();
        goto done;
    }
    if (!tree_same_identity(&opened, &entry)) { errno = ESTALE; goto done; }
    if (tree_check_mount_entry(parent, name, &entry, &parent_mount) < 0) goto done;
#ifdef SKILLS_MANAGER_TEST_FAULTS
    /* Exercise unrelated sibling creation after the parent snapshot. */
    const char *injected = getenv("SKILLS_BOUNDARY_FAULT");
    if (injected && !strcmp(injected, "dispose-parent-sibling") &&
        mkdirat(parent, ".skills-manager-test-sibling", 0700) < 0) goto done;
#endif
    if (boundary_check_parent(parent_path, parent, &parent_st, &parent_mount, 0) < 0) goto done;
    if (skills_apply_write_boundary(parent, parent_path, -1, NULL) < 0) {
        reason = "Cannot confine workspace cleanup";
        goto done;
    }

    for (counter = 0; counter < 128; ++counter) {
        int length;
        snprintf(quarantine, sizeof(quarantine), ".skills-manager-dispose-%ld-%u",
                 (long)getpid(), counter);
        length = snprintf(quarantine_path, sizeof(quarantine_path), "%s%s%s", parent_path,
                          strcmp(parent_path, "/") == 0 ? "" : "/", quarantine);
        if (length < 0 || (size_t)length >= sizeof(quarantine_path) ||
            boundary_cleanup_path(escaped, sizeof(escaped), quarantine_path) < 0) {
            errno = ENAMETOOLONG;
            reason = "Workspace parent is too long to report a quarantine path";
            goto done;
        }
        if (rename_exclusive(parent, name, parent, quarantine) == 0) {
            moved = 1;
            cleanup = quarantine_path;
            break;
        }
        if (errno != EEXIST) goto done;
    }
    if (!moved) { errno = EEXIST; reason = "Workspace quarantine names are occupied"; goto done; }
    if (fsync(parent) < 0) { reason = "Cannot sync quarantined workspace"; goto rollback; }
    if (fstatat(parent, quarantine, &entry, AT_SYMLINK_NOFOLLOW) < 0) {
        boundary_stale_if_missing();
        goto rollback;
    }
    if (!tree_same_identity(&opened, &entry)) { errno = ESTALE; goto rollback; }
    if (tree_check_mount_entry(parent, quarantine, &entry, &parent_mount) < 0 ||
        tree_check_mount_fd(workspace, &parent_mount) < 0 ||
        fstat(workspace, &before) < 0) goto rollback;
    if (!tree_same_identity(&opened, &before)) { errno = ESTALE; goto rollback; }
    if (tree_remove_known_at(parent, quarantine, &opened, &parent_mount) < 0) {
        reason = "Cannot finish workspace cleanup";
        goto done;
    }
    if (fsync(parent) < 0) {
        reason = "Workspace cleanup completed but its directory could not be synced";
        goto done;
    }
    if (puts("READY") == EOF || fflush(stdout) == EOF) {
        reason = "Workspace cleanup completed but its response could not be written";
        goto done;
    }
    result = 0;
    goto done;
rollback:
    saved = errno;
    if (rename_exclusive(parent, quarantine, parent, name) == 0) {
        cleanup = absolute;
        (void)fsync(parent);
    }
    errno = saved;
done:
    saved = errno;
    if (workspace >= 0) close(workspace);
    if (parent >= 0) close(parent);
    free(storage);
    if (result == 0) return 0;
    return boundary_dispose_error(reason, cleanup, saved);
}

#endif /* SKILLS_BOUNDARY_READ_H */
