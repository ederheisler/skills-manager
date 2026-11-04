#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1

#include <sys/types.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/proc_info.h>
#elif defined(__linux__)
#include <sys/syscall.h>
#ifndef SYS_close_range
#define SYS_close_range 436
#endif
#endif

#include "tree.h"
#include "identity.h"
#include "containment.h"
#include "git-transaction-state.h"
#include "git-transaction.h"

#define SETUP_FAILURE 125
#define MAX_METADATA_SIZE (1024U * 1024U)
#define MAX_SCAN_DEPTH 512U

static int safe_stream(int fd, int output)
{
    struct stat st;
    int flags;
    if (fstat(fd, &st) < 0) return -1;
    if (S_ISSOCK(st.st_mode)) {
        struct sockaddr_storage address;
        socklen_t length = sizeof(address), option_length = sizeof(int);
        int type;
        if (getsockname(fd, (struct sockaddr *)&address, &length) < 0 ||
            address.ss_family != AF_UNIX ||
            getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &option_length) < 0 ||
            type != SOCK_STREAM) {
            errno = EPERM;
            return -1;
        }
    } else if (!S_ISFIFO(st.st_mode)) {
        errno = EPERM;
        return -1;
    }
    flags = fcntl(fd, F_GETFL);
    if (flags < 0) return -1;
    if ((output && (flags & O_ACCMODE) == O_RDONLY) ||
        (!output && (flags & O_ACCMODE) == O_WRONLY)) {
        errno = EPERM;
        return -1;
    }
    return 0;
}

static int failure(const char *message)
{
    int saved = errno;
    if (safe_stream(STDERR_FILENO, 1) == 0)
        fprintf(stderr, "skills-git-boundary: %s: %s\n", message, strerror(saved));
    return SETUP_FAILURE;
}

static int invalid(const char *message)
{
    errno = EINVAL;
    return failure(message);
}

static int valid_path_bytes(const char *path)
{
    for (const unsigned char *p = (const unsigned char *)path; *p; ++p) {
        if (*p < 32 || *p == 127) { errno = EINVAL; return 0; }
    }
    return 1;
}

/* Directory arguments are canonical absolute spellings, not links or aliases. */
static int open_absolute_directory(const char *path)
{
    int fd = -1, saved;
    char *copy = NULL, *part, *cursor;
    if (!path || path[0] != '/' || !path[1] || !valid_path_bytes(path)) {
        errno = EINVAL;
        return -1;
    }
    copy = strdup(path + 1);
    if (!copy) return -1;
    fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) goto fail;
    cursor = copy;
    while ((part = strsep(&cursor, "/")) != NULL) {
        int next;
        if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) {
            errno = EINVAL;
            goto fail;
        }
        next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) goto fail;
        close(fd);
        fd = next;
    }
    free(copy);
    return fd;
fail:
    saved = errno;
    if (fd >= 0) close(fd);
    free(copy);
    errno = saved;
    return -1;
}

static int match_decimal_identity(const struct stat *st, const char *dev, const char *ino)
{
    char actual_dev[32], actual_ino[32];
    snprintf(actual_dev, sizeof(actual_dev), "%" PRIuMAX, (uintmax_t)st->st_dev);
    snprintf(actual_ino, sizeof(actual_ino), "%" PRIuMAX, (uintmax_t)st->st_ino);
    if (strcmp(actual_dev, dev) || strcmp(actual_ino, ino)) {
        errno = ESTALE;
        return -1;
    }
    return 0;
}

static int same_fd_identity(int a, int b)
{
    struct stat left, right;
    struct tree_mount left_mount, right_mount;
    if (fstat(a, &left) < 0 || fstat(b, &right) < 0 ||
        tree_mount_fd(a, &left_mount) < 0 || tree_mount_fd(b, &right_mount) < 0)
        return -1;
    if (!tree_same_identity(&left, &right) || !tree_same_mount(&left_mount, &right_mount)) {
        errno = ESTALE;
        return -1;
    }
    return 0;
}

static int open_verified_directory(const char *path, const char *dev, const char *ino)
{
    struct stat st;
    int fd = open_absolute_directory(path);
    if (fd < 0) return -1;
    if (fstat(fd, &st) < 0 || match_decimal_identity(&st, dev, ino) < 0) {
        int saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    return fd;
}

static int verify_named_directory(int fd, const char *path)
{
    int named = open_absolute_directory(path);
    int result, saved;
    if (named < 0) return -1;
    result = same_fd_identity(fd, named);
    saved = errno;
    close(named);
    errno = saved;
    return result;
}

/* Git's relative gitdir and commondir files may legitimately contain "..".
 * Resolve those using pinned directory descriptors, never symbolic links. */
static int open_reference(int base, const char *path, int directory)
{
    char *copy = NULL, *part, *next, *state = NULL;
    int fd = -1, saved, saw_component = 0;
    if (!path || !*path || !valid_path_bytes(path)) { errno = EINVAL; return -1; }
    if (!directory && path[strlen(path) - 1] == '/') { errno = EINVAL; return -1; }
    copy = strdup(path);
    if (!copy) return -1;
    fd = path[0] == '/' ? open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC) :
                          fcntl(base, F_DUPFD_CLOEXEC, 3);
    if (fd < 0) goto fail;
    part = strtok_r(copy, "/", &state);
    while (part) {
        int opened, flags;
        next = strtok_r(NULL, "/", &state);
        if (!strcmp(part, ".")) {
            if (!directory && !next) { errno = EINVAL; goto fail; }
            part = next;
            continue;
        }
        if (!directory && !next && !strcmp(part, "..")) { errno = EINVAL; goto fail; }
        flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
        if (directory || next) flags |= O_DIRECTORY;
        opened = openat(fd, part, flags);
        if (opened < 0) goto fail;
        close(fd);
        fd = opened;
        saw_component = 1;
        part = next;
    }
    if (!directory && !saw_component) { errno = EINVAL; goto fail; }
    free(copy);
    return fd;
fail:
    saved = errno;
    if (fd >= 0) close(fd);
    free(copy);
    errno = saved;
    return -1;
}

/* A bounded, nofollow read with a stable inode and contents snapshot. */
static int read_regular_at(int directory, const char *name, size_t maximum,
                           char **out, struct stat *identity)
{
    struct stat before, opened, after;
    char *buffer = NULL, extra;
    size_t size, offset = 0;
    int fd = -1, saved;
    ssize_t n;
    *out = NULL;
    if (fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (S_ISREG(before.st_mode) && before.st_nlink != 1) {
        errno = EMLINK;
        return -1;
    }
    if (!S_ISREG(before.st_mode) ||
        before.st_size < 0 || (uintmax_t)before.st_size > maximum) {
        errno = EPERM;
        return -1;
    }
    fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    if (fstat(fd, &opened) < 0) goto fail;
    if (!tree_same_snapshot(&before, &opened)) { errno = ESTALE; goto fail; }
    size = (size_t)before.st_size;
    buffer = malloc(size + 1);
    if (!buffer) goto fail;
    while (offset < size) {
        n = read(fd, buffer + offset, size - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { if (!n) errno = ESTALE; goto fail; }
        offset += (size_t)n;
    }
    do { n = read(fd, &extra, 1); } while (n < 0 && errno == EINTR);
    if (n < 0) goto fail;
    if (n != 0) { errno = ESTALE; goto fail; }
    if (fstat(fd, &after) < 0) goto fail;
    if (!tree_same_snapshot(&before, &after)) { errno = ESTALE; goto fail; }
    if (memchr(buffer, '\0', size)) { errno = EINVAL; goto fail; }
    buffer[size] = '\0';
    if (identity) *identity = before;
    if (close(fd) < 0) { fd = -1; goto fail; }
    *out = buffer;
    return 0;
fail:
    saved = errno;
    if (fd >= 0) close(fd);
    free(buffer);
    errno = saved;
    return -1;
}

static char *single_line(char *text)
{
    size_t length = strlen(text);
    if (length && text[length - 1] == '\n') text[--length] = '\0';
    if (length && text[length - 1] == '\r') text[--length] = '\0';
    if (!length || !valid_path_bytes(text)) { errno = EINVAL; return NULL; }
    return text;
}

/* A linked worktree must be a child of common/worktrees and have Git's
 * reciprocal gitdir file pointing back to the selected root's .git file. */
static int verify_git_relationship(int root, int gitdir, int common,
                                   const struct stat *git_entry)
{
    struct stat current, opened;
    char *gitfile = NULL, *commonfile = NULL, *backfile = NULL, *reference;
    int dot = -1, resolved = -1, worktrees = -1, parent = -1, result = -1, saved;

    if (fstatat(root, ".git", &current, AT_SYMLINK_NOFOLLOW) < 0) goto done;
    if (!tree_same_snapshot(git_entry, &current)) { errno = ESTALE; goto done; }
    if (S_ISDIR(current.st_mode)) {
        dot = openat(root, ".git", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (dot < 0 || same_fd_identity(dot, gitdir) < 0 ||
            same_fd_identity(gitdir, common) < 0) goto done;
        if (fstatat(gitdir, "commondir", &opened, AT_SYMLINK_NOFOLLOW) == 0) {
            errno = EPERM;
            goto done;
        }
        if (errno != ENOENT) goto done;
        result = 0;
        goto done;
    }
    if (!S_ISREG(current.st_mode)) { errno = EPERM; goto done; }
    if (read_regular_at(root, ".git", MAX_METADATA_SIZE, &gitfile, &opened) < 0)
        goto done;
    if (!tree_same_snapshot(git_entry, &opened) ||
        strncmp(gitfile, "gitdir: ", 8) != 0) { errno = ESTALE; goto done; }
    reference = single_line(gitfile + 8);
    if (!reference) goto done;
    resolved = open_reference(root, reference, 1);
    if (resolved < 0 || same_fd_identity(resolved, gitdir) < 0) goto done;
    close(resolved);
    resolved = -1;

    if (read_regular_at(gitdir, "commondir", MAX_METADATA_SIZE, &commonfile, NULL) < 0)
        goto done;
    reference = single_line(commonfile);
    if (!reference) goto done;
    resolved = open_reference(gitdir, reference, 1);
    if (resolved < 0 || same_fd_identity(resolved, common) < 0) goto done;
    close(resolved);
    resolved = -1;

    worktrees = openat(common, "worktrees", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    parent = openat(gitdir, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (worktrees < 0 || parent < 0 || same_fd_identity(worktrees, parent) < 0)
        goto done;
    if (read_regular_at(gitdir, "gitdir", MAX_METADATA_SIZE, &backfile, NULL) < 0)
        goto done;
    reference = single_line(backfile);
    if (!reference) goto done;
    resolved = open_reference(gitdir, reference, 0);
    if (resolved < 0 || fstat(resolved, &opened) < 0) goto done;
    if (!S_ISREG(opened.st_mode) || !tree_same_snapshot(git_entry, &opened)) {
        errno = ESTALE;
        goto done;
    }
    result = 0;
done:
    saved = errno;
    if (dot >= 0) close(dot);
    if (resolved >= 0) close(resolved);
    if (worktrees >= 0) close(worktrees);
    if (parent >= 0) close(parent);
    free(gitfile);
    free(commonfile);
    free(backfile);
    if (result < 0) errno = saved;
    return result;
}

static int ascii_lower(int c)
{
    return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c;
}

static int ascii_equal(const char *a, const char *b)
{
    while (*a && *b && ascii_lower((unsigned char)*a) == ascii_lower((unsigned char)*b)) {
        ++a;
        ++b;
    }
    return *a == '\0' && *b == '\0';
}

static int name_character(int c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || c == '-';
}

static char *trim_space(char *text)
{
    char *end;
    while (*text == ' ' || *text == '\t' || *text == '\r') ++text;
    end = text + strlen(text);
    while (end > text && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r'))
        *--end = '\0';
    return text;
}

/* Deliberately conservative: no config includes, escapes, or ambiguous
 * continuation syntax. A bare repo produced by git init --bare is accepted. */
static int config_is_bare(char *config)
{
    char *line, *cursor = config;
    int in_section = 0, in_core = 0, in_extensions = 0, bare = 0;
    while ((line = strsep(&cursor, "\n")) != NULL) {
        char *p, *end, *value;
        int quoted = 0;
        for (p = line; *p; ++p) {
            unsigned char c = (unsigned char)*p;
            if (c == '\\' || (c < 32 && c != '\t' && c != '\r') || c == 127) {
                errno = EINVAL;
                return -1;
            }
            if (c == '"') quoted = !quoted;
            if (!quoted && (c == '#' || c == ';')) { *p = '\0'; break; }
        }
        if (quoted) { errno = EINVAL; return -1; }
        p = trim_space(line);
        if (!*p) continue;
        if (*p == '[') {
            int subsection = 0;
            char *name, *suffix, *dot;
            end = strrchr(p, ']');
            if (!end || end[1] != '\0') { errno = EINVAL; return -1; }
            *end = '\0';
            name = trim_space(p + 1);
            suffix = name;
            while (name_character((unsigned char)*suffix) || *suffix == '.') ++suffix;
            if (suffix == name) { errno = EINVAL; return -1; }
            if (*suffix) {
                if (*suffix != ' ' && *suffix != '\t') { errno = EINVAL; return -1; }
                *suffix++ = '\0';
                suffix = trim_space(suffix);
                end = suffix + strlen(suffix);
                if (end - suffix < 2 || suffix[0] != '"' || end[-1] != '"') {
                    errno = EINVAL;
                    return -1;
                }
                subsection = 1;
            }
            dot = strchr(name, '.');
            if (dot) { *dot = '\0'; subsection = 1; }
            if (ascii_equal(name, "include") || ascii_equal(name, "includeif")) {
                errno = EPERM;
                return -1;
            }
            in_section = 1;
            in_core = ascii_equal(name, "core") && !subsection;
            in_extensions = ascii_equal(name, "extensions") && !subsection;
            continue;
        }
        if (!in_section || !((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z'))) {
            errno = EINVAL;
            return -1;
        }
        end = p + 1;
        while (name_character((unsigned char)*end)) ++end;
        value = end;
        while (*value == ' ' || *value == '\t') ++value;
        if (*value && *value != '=') { errno = EINVAL; return -1; }
        if (*value == '=') value = trim_space(value + 1);
        else value = NULL;
        *end = '\0';
        if ((in_core && ascii_equal(p, "worktree")) ||
            (in_extensions && ascii_equal(p, "worktreeconfig"))) {
            errno = EPERM;
            return -1;
        }
        if (in_core && ascii_equal(p, "bare")) {
            if (value) {
                size_t length = strlen(value);
                if (length >= 2 && value[0] == '"' && value[length - 1] == '"') {
                    value[length - 1] = '\0';
                    ++value;
                }
            }
            if (!value || ascii_equal(value, "true") || ascii_equal(value, "yes") ||
                ascii_equal(value, "on") || !strcmp(value, "1")) bare = 1;
            else if (!*value || ascii_equal(value, "false") || ascii_equal(value, "no") ||
                     ascii_equal(value, "off") || !strcmp(value, "0")) bare = 0;
            else { errno = EINVAL; return -1; }
        }
    }
    if (!bare) { errno = EPERM; return -1; }
    return 0;
}

/* A bare endpoint must not redirect repository discovery to another worktree. */
static int no_remote_indirections(int remote)
{
    static const char *const names[] = {
        ".git", "commondir", "config.worktree", "gitdir", "worktrees"
    };
    struct stat st;
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        if (fstatat(remote, names[i], &st, AT_SYMLINK_NOFOLLOW) == 0) {
            errno = EPERM;
            return -1;
        }
        if (errno != ENOENT) return -1;
    }
    return 0;
}

static int valid_head_ref(const char *name)
{
    const char *part = name;
    if (strncmp(name, "refs/", 5) || !name[5]) return 0;
    for (const char *p = name;; ++p) {
        unsigned char c = (unsigned char)*p;
        if (!c || c == '/') {
            size_t length = (size_t)(p - part);
            if (!length || *part == '.' ||
                (length >= 5 && !memcmp(p - 5, ".lock", 5)) ||
                (!c && p[-1] == '.'))
                return 0;
            if (!c) return 1;
            part = p + 1;
        } else if (c <= 32 || c == 127 || strchr("~^:?*[\\", c) ||
                   (c == '.' && p[1] == '.') || (c == '@' && p[1] == '{')) {
            return 0;
        }
    }
}

static int verify_bare_remote(int remote)
{
    char *config = NULL, *head = NULL, *line;
    int objects = -1, refs = -1, result = -1, saved;
    if (no_remote_indirections(remote) < 0 ||
        read_regular_at(remote, "config", MAX_METADATA_SIZE, &config, NULL) < 0 ||
        config_is_bare(config) < 0 ||
        read_regular_at(remote, "HEAD", MAX_METADATA_SIZE, &head, NULL) < 0)
        goto done;
    line = single_line(head);
    if (!line) goto done;
    if (strncmp(line, "ref: refs/", 10) != 0) {
        size_t length = strlen(line);
        if (length != 40 && length != 64) { errno = EINVAL; goto done; }
        for (size_t i = 0; i < length; ++i) {
            int c = ascii_lower((unsigned char)line[i]);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
                errno = EINVAL;
                goto done;
            }
        }
    } else if (!valid_head_ref(line + 5)) {
        errno = EINVAL;
        goto done;
    }
    objects = openat(remote, "objects", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    refs = openat(remote, "refs", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (objects < 0 || refs < 0) goto done;
    result = 0;
done:
    saved = errno;
    if (objects >= 0) close(objects);
    if (refs >= 0) close(refs);
    free(config);
    free(head);
    if (result < 0) errno = saved;
    return result;
}

/* The transaction bridge keeps one durable witness link while index.lock is
 * held or has just been installed as index. Both names must be inside the
 * pinned gitdir, so nlink==2 proves there is no outside alias. The bridge
 * additionally checks the journalled inode before adopting or changing it. */
static int transaction_pair_matches(int directory, const char *private_name,
                                    const char *other_name, const struct stat *observed,
                                    const struct tree_mount *mount)
{
    struct stat private_st, other_st;
    int private_fd = -1, other_fd = -1, result = 0;
    if (git_tx_name_kind(private_name) != GIT_TX_PRIVATE_LOCK ||
        fstatat(directory, private_name, &private_st, AT_SYMLINK_NOFOLLOW) < 0 ||
        fstatat(directory, other_name, &other_st, AT_SYMLINK_NOFOLLOW) < 0)
        return 0;
    if (!S_ISREG(private_st.st_mode) || private_st.st_uid != geteuid() ||
        private_st.st_nlink != 2 || !tree_same_snapshot(&private_st, &other_st) ||
        !tree_same_snapshot(&private_st, observed))
        return 0;
    private_fd = openat(directory, private_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (private_fd < 0) goto done;
    other_fd = openat(directory, other_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (other_fd < 0) goto done;
    if (tree_check_mount_fd(private_fd, mount) < 0 ||
        tree_check_mount_fd(other_fd, mount) < 0 ||
        tree_check_source(directory, private_name, private_fd, &private_st, mount) < 0 ||
        tree_check_source(directory, other_name, other_fd, &other_st, mount) < 0)
        goto done;
    result = 1;
done:
    if (private_fd >= 0) close(private_fd);
    if (other_fd >= 0) close(other_fd);
    return result;
}

static int transaction_lock_pair(int directory, const char *name, const struct stat *st,
                                 const struct tree_mount *mount, int gitdir)
{
    DIR *stream;
    struct dirent *entry;
    int fd, result = 0;
    if (gitdir < 0 || !S_ISREG(st->st_mode) || st->st_nlink != 2 ||
        st->st_uid != geteuid() || same_fd_identity(directory, gitdir) < 0)
        return 0;
    if (git_tx_name_kind(name) == GIT_TX_PRIVATE_LOCK)
        return transaction_pair_matches(directory, name, "index.lock", st, mount) ||
               transaction_pair_matches(directory, name, "index", st, mount);
    if (strcmp(name, "index.lock") && strcmp(name, "index")) return 0;
    fd = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return 0;
    stream = fdopendir(fd);
    if (!stream) { close(fd); return 0; }
    while ((entry = readdir(stream)) != NULL) {
        if (git_tx_name_kind(entry->d_name) == GIT_TX_PRIVATE_LOCK &&
            transaction_pair_matches(directory, entry->d_name, name, st, mount)) {
            result = 1;
            break;
        }
    }
    closedir(stream);
    return result;
}

/* There is no per-file deny inside an allowed directory in these sandboxes.
 * Reject hardlinks even in Git's normally immutable object store. */
static int scan_directory(int directory, int metadata, unsigned int depth,
                          const struct tree_mount *mount, const struct stat *forbidden_a,
                          const struct stat *forbidden_b, int gitdir, const char **reason)
{
    struct stat before, after;
    DIR *stream = NULL;
    int fd = -1, result = -1, saved;
    if (depth > MAX_SCAN_DEPTH) {
        *reason = "directory tree is too deep to inspect safely";
        errno = ELOOP;
        return -1;
    }
    if (fstat(directory, &before) < 0) return -1;
    if ((forbidden_a && tree_same_identity(&before, forbidden_a)) ||
        (forbidden_b && tree_same_identity(&before, forbidden_b))) {
        *reason = "approved writable directories overlap or alias";
        errno = EPERM;
        return -1;
    }
    fd = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    stream = fdopendir(fd);
    if (!stream) { saved = errno; close(fd); errno = saved; return -1; }
    for (;;) {
        struct dirent *entry;
        struct stat st, opened;
        int child;
        errno = 0;
        entry = readdir(stream);
        if (!entry) {
            if (errno) goto done;
            break;
        }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        if (fstatat(directory, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) < 0) goto done;
        if (tree_check_mount_entry(directory, entry->d_name, &st, mount) < 0) {
            *reason = "nested or unsupported mount in writable tree";
            goto done;
        }
        if ((S_ISREG(st.st_mode) || S_ISLNK(st.st_mode)) && st.st_nlink != 1 &&
            !transaction_lock_pair(directory, entry->d_name, &st, mount, gitdir)) {
            *reason = "hardlinked file or link in writable tree is unsafe";
            errno = EPERM;
            goto done;
        }
        if (S_ISLNK(st.st_mode)) {
            if (metadata) {
                *reason = "symbolic link in Git metadata is unsafe";
                errno = ELOOP;
                goto done;
            }
            continue;
        }
        if (S_ISREG(st.st_mode)) continue;
        if (!S_ISDIR(st.st_mode)) {
            *reason = "special file in writable tree is unsafe";
            errno = EPERM;
            goto done;
        }
        child = openat(directory, entry->d_name,
                       O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (child < 0) goto done;
        if (fstat(child, &opened) < 0) {
            saved = errno;
            close(child);
            errno = saved;
            goto done;
        }
        if (!tree_same_snapshot(&st, &opened)) {
            close(child);
            errno = ESTALE;
            goto done;
        }
        if (tree_check_mount_fd(child, mount) < 0) {
            saved = errno;
            *reason = "nested or unsupported mount in writable tree";
            close(child);
            errno = saved;
            goto done;
        }
        if (scan_directory(child, metadata || !strcmp(entry->d_name, ".git"),
                           depth + 1, mount, forbidden_a, forbidden_b, gitdir, reason) < 0) {
            saved = errno;
            close(child);
            errno = saved;
            goto done;
        }
        if (close(child) < 0) goto done;
    }
    if (fstat(directory, &after) < 0) goto done;
    if (!tree_same_snapshot(&before, &after)) { errno = ESTALE; goto done; }
    result = 0;
done:
    saved = errno;
    if (closedir(stream) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) errno = saved;
    return result;
}

static int scan_writable_tree(int fd, int metadata, const struct stat *forbidden_a,
                              const struct stat *forbidden_b, int gitdir, const char **reason)
{
    struct tree_mount mount;
    if (tree_mount_fd(fd, &mount) < 0) return -1;
    return scan_directory(fd, metadata, 0, &mount, forbidden_a, forbidden_b, gitdir, reason);
}

/* Mark all inherited descriptors first, then close everything except the
 * newly duplicated directory capabilities before any worker is forked. */
static int protect_inherited(int first, int close_now)
{
#if defined(__linux__)
    long result;
    do { result = syscall(SYS_close_range, (unsigned int)first, ~0U,
                          close_now ? 0U : (1U << 2)); }
    while (result < 0 && errno == EINTR);
    return result < 0 ? -1 : 0;
#elif defined(__APPLE__)
    struct proc_fdinfo *list;
    int needed, capacity, count, saved;
    needed = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
    if (needed <= 0 || needed > INT_MAX - (int)(64 * sizeof(*list))) {
        errno = ENOTSUP;
        return -1;
    }
    capacity = needed + (int)(64 * sizeof(*list));
    list = malloc((size_t)capacity);
    if (!list) return -1;
    count = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, list, capacity);
    if (count <= 0 || count >= capacity || count % (int)sizeof(*list) != 0) {
        free(list);
        errno = ENOTSUP;
        return -1;
    }
    for (int i = 0; i < count / (int)sizeof(*list); ++i) {
        int fd = list[i].proc_fd;
        int rc, flags;
        if (fd < first) continue;
        if (close_now) {
            do { rc = close(fd); } while (rc < 0 && errno == EINTR);
        } else {
            flags = fcntl(fd, F_GETFD);
            rc = flags < 0 ? -1 : fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
        }
        if (rc < 0) {
            saved = errno;
            free(list);
            errno = saved;
            return -1;
        }
    }
    free(list);
    return 0;
#else
    errno = ENOTSUP;
    return -1;
#endif
}

static int publish_directory_fds(int root, int gitdir, int common)
{
    int original[3] = { root, gitdir, common };
    int pinned[3] = { -1, -1, -1 };
    int saved;
    for (int i = 0; i < 3; ++i) {
        if (original[i] < 0) continue;
        pinned[i] = fcntl(original[i], F_DUPFD_CLOEXEC, 6);
        if (pinned[i] < 0) goto fail;
    }
    if (protect_inherited(3, 0) < 0) goto fail;
    for (int i = 0; i < 3; ++i) {
        if (pinned[i] >= 0) {
            if (dup2(pinned[i], i + 3) < 0) goto fail;
        } else if (close(i + 3) < 0 && errno != EBADF) {
            goto fail;
        }
    }
    for (int i = 0; i < 3; ++i) {
        if (pinned[i] >= 0) { close(pinned[i]); pinned[i] = -1; }
    }
    return protect_inherited(6, 1);
fail:
    saved = errno;
    for (int i = 0; i < 3; ++i) if (pinned[i] >= 0) close(pinned[i]);
    errno = saved;
    return -1;
}

static int set_git_environment(const char *root_path, const char *git_path,
                               const char *common_path, int transaction_worker)
{
    const char *work_tree = ".";
    if (!git_path) {
        if (unsetenv("GIT_DIR") < 0 || unsetenv("GIT_COMMON_DIR") < 0 ||
            unsetenv("GIT_WORK_TREE") < 0) return -1;
        return 0;
    }
#if defined(__linux__)
    (void)root_path;
    git_path = "/proc/self/fd/4";
    common_path = "/proc/self/fd/5";
    if (transaction_worker) work_tree = "/proc/self/fd/3";
#else
    if (transaction_worker) {
        git_path = ".";
        work_tree = root_path;
    }
#endif
    if (setenv("GIT_DIR", git_path, 1) < 0 ||
        setenv("GIT_COMMON_DIR", common_path, 1) < 0 ||
        setenv("GIT_WORK_TREE", work_tree, 1) < 0) return -1;
    return 0;
}

#if defined(__linux__)
static int verify_proc_descriptors(int transaction_worker)
{
    const char *paths[3] = { "/proc/self/fd/3", "/proc/self/fd/4", "/proc/self/fd/5" };
    for (int i = transaction_worker ? 0 : 1; i < 3; ++i) {
        int fd = open(paths[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        int saved, match;
        if (fd < 0) return -1;
        match = same_fd_identity(fd, i + 3);
        saved = errno;
        close(fd);
        if (match < 0) { errno = saved; return -1; }
    }
    return 0;
}
#endif

static int platform_probe(void)
{
    const char *os = NULL, *libc = NULL, *arch = NULL;
#if defined(__APPLE__)
    os = "darwin"; libc = "none";
#elif defined(__linux__) && defined(__GLIBC__)
    os = "linux"; libc = "glibc";
#else
    errno = ENOTSUP;
    return failure("unsupported operating system or C library");
#endif
#if defined(__aarch64__) || defined(__arm64__)
    arch = "arm64";
#elif defined(__x86_64__)
    arch = "x64";
#else
    errno = ENOTSUP;
    return failure("unsupported architecture");
#endif
    if (printf("%s\t%s\t%s\n", os, arch, libc) < 0 || fflush(stdout) != 0)
        return failure("cannot write platform probe");
    return 0;
}

/* The bridge runs only for the explicitly requested transaction worker.
 * Its peer is private to that worker and is not inherited by Git children. */
static int run_transaction_worker(int command, char **argv)
{
    int sockets[2], status, bridge_result, bridge_errno, waited;
    pid_t child;
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) < 0)
        return failure("cannot create transaction bridge");
    if (fcntl(sockets[0], F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(sockets[1], F_SETFD, FD_CLOEXEC) < 0) {
        int saved = errno;
        close(sockets[0]);
        close(sockets[1]);
        errno = saved;
        return failure("cannot protect transaction bridge descriptors");
    }
    child = fork();
    if (child < 0) {
        int saved = errno;
        close(sockets[0]);
        close(sockets[1]);
        errno = saved;
        return failure("cannot start transaction worker");
    }
    if (child == 0) {
        int flags;
        close(sockets[0]);
        if (dup2(sockets[1], 6) < 0) {
            failure("cannot connect transaction worker");
            _exit(SETUP_FAILURE);
        }
        if (sockets[1] != 6) close(sockets[1]);
        flags = fcntl(6, F_GETFD);
        if (flags < 0 || fcntl(6, F_SETFD, flags & ~FD_CLOEXEC) < 0) {
            failure("cannot retain transaction bridge descriptor");
            _exit(SETUP_FAILURE);
        }
        execv(argv[command], &argv[command]);
        failure("cannot execute transaction worker");
        _exit(SETUP_FAILURE);
    }
    close(sockets[1]);
    bridge_result = git_transaction_serve(4, sockets[0], 3, git_transaction_state_handler);
    bridge_errno = errno;
    close(sockets[0]);
    do { waited = (int)waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
    if (waited < 0) return failure("cannot wait for transaction worker");
    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);
        if (code == 0 && bridge_result < 0) {
            errno = bridge_errno;
            return failure("transaction bridge failed");
        }
        return code;
    }
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    errno = ECHILD;
    return failure("transaction worker returned an unknown status");
}

int main(int argc, char **argv)
{
    const char *root_path, *git_path = NULL, *common_path = NULL, *remote_path = NULL;
    const char *git_dev = NULL, *git_ino = NULL, *common_dev = NULL, *common_ino = NULL;
    const char *entry_dev = NULL, *entry_ino = NULL, *remote_dev = NULL, *remote_ino = NULL;
    const char *reason = "cannot safely inspect writable directory";
    struct stat entry, root_identity, common_identity, remote_identity;
    char identity[65];
    int root = -1, gitdir = -1, common = -1, remote = -1;
    int argument, command, has_entry, transaction_worker = 0;
#if defined(__APPLE__)
    char *profile;
    char **sandbox_argv;
#endif
    if (argc == 2 && !strcmp(argv[1], "--platform-probe")) return platform_probe();
    if (safe_stream(STDERR_FILENO, 1) < 0) return SETUP_FAILURE;
    if (safe_stream(STDIN_FILENO, 0) < 0 || safe_stream(STDOUT_FILENO, 1) < 0)
        return failure("stdin, stdout and stderr must be pipes or local stream sockets");
#if !(defined(__APPLE__) || (defined(__linux__) && defined(__GLIBC__))) || \
    !(defined(__aarch64__) || defined(__arm64__) || defined(__x86_64__))
    errno = ENOTSUP;
    return failure("unsupported platform");
#endif
    if (argc < 8 || strcmp(argv[1], "--root"))
        return invalid("expected --root ROOT DEV INO TOKEN and a Git command");
    root_path = argv[2];
    argument = 6;
    if (argument < argc && !strcmp(argv[argument], "--git-entry")) {
        if (argument + 10 >= argc || strcmp(argv[argument + 3], "--git-dir") ||
            strcmp(argv[argument + 7], "--common-dir"))
            return invalid("expected --git-entry DEV INO --git-dir PATH DEV INO --common-dir PATH DEV INO");
        entry_dev = argv[argument + 1];
        entry_ino = argv[argument + 2];
        git_path = argv[argument + 4];
        git_dev = argv[argument + 5];
        git_ino = argv[argument + 6];
        common_path = argv[argument + 8];
        common_dev = argv[argument + 9];
        common_ino = argv[argument + 10];
        argument += 11;
    }
    if (argument < argc && !strcmp(argv[argument], "--remote-dir")) {
        if (argument + 3 >= argc) return invalid("expected --remote-dir PATH DEV INO");
        remote_path = argv[argument + 1];
        remote_dev = argv[argument + 2];
        remote_ino = argv[argument + 3];
        argument += 4;
    }
    if (argument < argc && !strcmp(argv[argument], "--transaction-worker")) {
        transaction_worker = 1;
        ++argument;
        if (!git_path) return invalid("transaction worker requires pinned Git metadata");
    }
    if (argument + 1 >= argc || strcmp(argv[argument], "--") ||
        argv[argument + 1][0] != '/')
        return invalid("expected -- ABSOLUTE_EXECUTABLE [ARG...]");
    command = argument + 1;

    root = open_verified_directory(root_path, argv[3], argv[4]);
    if (root < 0) return failure("selected root identity mismatch or unsafe path");
    if (boundary_identity_fd(root, identity) < 0)
        return failure("cannot obtain selected root identity");
    if (strcmp(identity, argv[5])) {
        errno = ESTALE;
        return failure("selected root identity mismatch");
    }

    has_entry = fstatat(root, ".git", &entry, AT_SYMLINK_NOFOLLOW) == 0;
    if (!has_entry && errno != ENOENT) return failure("cannot inspect root Git entry");
    if ((has_entry && !git_path) || (!has_entry && git_path)) {
        errno = ESTALE;
        return failure("Git metadata identity arguments do not match root .git");
    }
    if (has_entry) {
        if ((!S_ISDIR(entry.st_mode) && !S_ISREG(entry.st_mode)) ||
            match_decimal_identity(&entry, entry_dev, entry_ino) < 0) {
            errno = ESTALE;
            return failure("Git entry identity mismatch or unsafe link");
        }
        gitdir = open_verified_directory(git_path, git_dev, git_ino);
        if (gitdir < 0) return failure("Git directory identity mismatch or unsafe path");
        common = open_verified_directory(common_path, common_dev, common_ino);
        if (common < 0) return failure("Git common directory identity mismatch or unsafe path");
        if (verify_git_relationship(root, gitdir, common, &entry) < 0)
            return failure(errno == EMLINK ? "hardlinked file or link in writable tree is unsafe" :
                           "Git metadata relationship is invalid");
    }
    if (remote_path) {
        remote = open_verified_directory(remote_path, remote_dev, remote_ino);
        if (remote < 0) return failure("remote directory identity mismatch or unsafe path");
        if (verify_bare_remote(remote) < 0)
            return failure(errno == EMLINK ? "hardlinked file or link in writable tree is unsafe" :
                           "approved remote is not a safely verified bare Git repository");
    }

    if (fstat(root, &root_identity) < 0 ||
        (common >= 0 && fstat(common, &common_identity) < 0) ||
        (remote >= 0 && fstat(remote, &remote_identity) < 0))
        return failure("cannot inspect approved writable directory identities");
    /* A directory .git is already covered, as metadata, by the root scan. */
    if (scan_writable_tree(root, 0, remote >= 0 ? &remote_identity : NULL, NULL,
                           transaction_worker ? gitdir : -1, &reason) < 0 ||
        (common >= 0 && !S_ISDIR(entry.st_mode) && scan_writable_tree(common, 1, &root_identity,
                                           remote >= 0 ? &remote_identity : NULL,
                                           transaction_worker ? gitdir : -1, &reason) < 0) ||
        (remote >= 0 && scan_writable_tree(remote, 1, &root_identity,
                                           common >= 0 ? &common_identity : NULL, -1, &reason) < 0))
        return failure(reason);
    if (has_entry) {
        if (verify_git_relationship(root, gitdir, common, &entry) < 0)
            return failure(errno == EMLINK ? "hardlinked file or link in writable tree is unsafe" :
                           "Git metadata relationship is invalid");
    } else if (fstatat(root, ".git", &entry, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
        errno = ESTALE;
        return failure("Git entry changed while preparing the boundary");
    }
    if (remote >= 0 && verify_bare_remote(remote) < 0)
        return failure(errno == EMLINK ? "hardlinked file or link in writable tree is unsafe" :
                       "approved remote is not a safely verified bare Git repository");
    if (verify_named_directory(root, root_path) < 0 ||
        (gitdir >= 0 && verify_named_directory(gitdir, git_path) < 0) ||
        (common >= 0 && verify_named_directory(common, common_path) < 0) ||
        (remote >= 0 && verify_named_directory(remote, remote_path) < 0))
        return failure("approved directory path changed while preparing the boundary");
    if (set_git_environment(root_path, git_path, common_path, transaction_worker) < 0)
        return failure("cannot set pinned Git directory environment");

#if defined(__linux__)
    if (skills_apply_write_boundary_with_remote(root, root_path, common, common_path,
                                                remote, remote_path) < 0)
        return failure("cannot install required write boundary");
    if (fchdir(transaction_worker ? gitdir : root) < 0)
        return failure("cannot enter pinned working directory");
    if (publish_directory_fds(root, gitdir, common) < 0)
        return failure("cannot isolate and publish directory descriptors");
    if (has_entry && verify_proc_descriptors(transaction_worker) < 0)
        return failure("pinned Git descriptor paths are unavailable or mismatched");
    if (transaction_worker) return run_transaction_worker(command, argv);
    execv(argv[command], &argv[command]);
    return failure("cannot execute Git");
#elif defined(__APPLE__)
    if (transaction_worker) {
        if (skills_apply_write_boundary_with_remote(root, root_path, common, common_path,
                                                    remote, remote_path) < 0)
            return failure("cannot install required write boundary");
        if (fchdir(gitdir) < 0) return failure("cannot enter pinned Git directory");
        if (skills_boundary_paths_match(root, root_path, common, common_path,
                                        remote, remote_path) < 0)
            return failure("approved directory path changed before transaction");
        if (publish_directory_fds(root, gitdir, common) < 0)
            return failure("cannot isolate and publish directory descriptors");
        return run_transaction_worker(command, argv);
    }
    profile = skills_write_boundary_profile(root_path, common_path, remote_path);
    if (!profile) return failure("cannot construct required write boundary");
    sandbox_argv = calloc((size_t)(argc - command) + 5, sizeof(*sandbox_argv));
    if (!sandbox_argv) return failure("cannot prepare sandbox execution");
    sandbox_argv[0] = "/usr/bin/sandbox-exec";
    sandbox_argv[1] = "-p";
    sandbox_argv[2] = profile;
    sandbox_argv[3] = "--";
    for (int i = command; i < argc; ++i) sandbox_argv[4 + i - command] = argv[i];
    if (fchdir(root) < 0) return failure("cannot enter pinned root");
    if (skills_boundary_paths_match(root, root_path, common, common_path,
                                    remote, remote_path) < 0)
        return failure("approved directory path changed before sandbox execution");
    if (publish_directory_fds(root, gitdir, common) < 0)
        return failure("cannot isolate and publish directory descriptors");
    execv(sandbox_argv[0], sandbox_argv);
    return failure("cannot execute sandbox-exec");
#endif
}