#ifndef SKILLS_GIT_TRANSACTION_H
#define SKILLS_GIT_TRANSACTION_H

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sys/random.h>
#endif

#include "tree.h"
#include "git-transaction-state.h"

/* The state handler is supplied by the separately scoped root-state helper.
 * It returns an allocated output buffer, or NULL for an empty response. */
typedef int (*git_transaction_state_callback)(int, uint32_t,
                                               const unsigned char *, size_t,
                                               unsigned char **, size_t *);

#define GIT_TX_PREFIX ".skill-manager-txn-"
#define GIT_TX_ID_LENGTH 32U
#define GIT_TX_NAME_MAX 255U
#define GIT_TX_STATE_MAX (1024U * 1024U)
#define GIT_TX_HEAD_MAX 8192U
#define GIT_TX_CHUNK 65536U
#define GIT_TX_PATH_MAX (1024U * 1024U)
#define GIT_TX_LINK_MAX (1024U * 1024U)
#define GIT_TX_SNAPSHOT_HEADER 85U

enum git_tx_op {
    GIT_TX_INDEX_READ = 1,
    GIT_TX_LOCK_CREATE = 2,
    GIT_TX_LOCK_WRITE = 3,
    GIT_TX_LOCK_COMMIT = 4,
    GIT_TX_LOCK_ABORT = 5,
    GIT_TX_PRIVATE_READ = 6,
    GIT_TX_PRIVATE_PUT = 7,
    GIT_TX_PRIVATE_DELETE = 8,
    GIT_TX_PRIVATE_LIST = 9,
    GIT_TX_LOCK_ADOPT = 10,
    GIT_TX_LOCK_REMOVE_INDEX = 11,
    GIT_TX_HEAD_READ = 12,
    GIT_TX_STATE_READ = 13,
    GIT_TX_STATE_PUT = 14,
    GIT_TX_STATE_DELETE = 15,
    GIT_TX_LOCK_ACQUIRE = 16,
    GIT_TX_PRIVATE_STAT = 17,
    GIT_TX_STATE_TEMP_READ = 18,
    GIT_TX_STATE_TEMP_DELETE = 19,
    GIT_TX_STATE_DELETE_READ = 20,
    GIT_TX_STATE_DELETE_FINISH = 21,
    GIT_TX_ROOT_INFO = 22,
    GIT_TX_ROOT_LIST = 23,
    GIT_TX_STAGE_CREATE = 24,
    GIT_TX_STAGE_PUT = 25,
    GIT_TX_STAGE_INFO = 26,
    GIT_TX_ROOT_TO_STAGE = 27,
    GIT_TX_STAGE_TO_ROOT = 28,
    GIT_TX_STAGE_DELETE = 29,
    GIT_TX_STAGE_REMOVE = 30,
    GIT_TX_REF_LOCK_INSPECT = 31,
    GIT_TX_REF_LOCK_REMOVE = 32
};

enum git_tx_name_kind {
    GIT_TX_INVALID_NAME = 0,
    GIT_TX_PRIVATE_FILE,
    GIT_TX_PRIVATE_LOCK,
    GIT_TX_PRIVATE_INDEX_LOCK,
    GIT_TX_PRIVATE_QUARANTINE
};

struct git_tx_request {
    int fd;
    uint64_t remaining;
    int failed;
};

struct git_tx_server {
    int dirfd;
    int lockfd;
    char lockname[GIT_TX_NAME_MAX + 1];
    struct stat lock_identity;
    int index_seen;
    int index_absent;
    struct stat index_snapshot;
    int lock_written;
};

static int git_tx_private_delete(struct git_tx_server *server, const char *name,
                                 const unsigned char identity[16]);

static uint32_t git_tx_get32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t git_tx_get64(const unsigned char *p)
{
    return (uint64_t)git_tx_get32(p) | ((uint64_t)git_tx_get32(p + 4) << 32);
}

static void git_tx_put32(unsigned char *p, uint32_t value)
{
    p[0] = (unsigned char)value;
    p[1] = (unsigned char)(value >> 8);
    p[2] = (unsigned char)(value >> 16);
    p[3] = (unsigned char)(value >> 24);
}

static void git_tx_put64(unsigned char *p, uint64_t value)
{
    git_tx_put32(p, (uint32_t)value);
    git_tx_put32(p + 4, (uint32_t)(value >> 32));
}

/* Return 0 only for EOF before a new request; truncated frames are errors. */
static int git_tx_recv_exact(int fd, void *buffer, size_t length, int eof_ok)
{
    unsigned char *p = buffer;
    size_t done = 0;
    while (done < length) {
        ssize_t n = read(fd, p + done, length - done);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) {
            if (done == 0 && eof_ok) return 0;
            errno = EPIPE;
            return -1;
        }
        done += (size_t)n;
    }
    return 1;
}

static int git_tx_send_all(int fd, const void *buffer, size_t length)
{
    const unsigned char *p = buffer;
    while (length != 0) {
        ssize_t n;
#if defined(MSG_NOSIGNAL)
        n = send(fd, p, length, MSG_NOSIGNAL);
#else
        n = send(fd, p, length, 0);
#endif
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) { errno = EPIPE; return -1; }
        p += (size_t)n;
        length -= (size_t)n;
    }
    return 0;
}

static int git_tx_body_read(struct git_tx_request *request, void *buffer, size_t length)
{
    if ((uint64_t)length > request->remaining) {
        errno = EPROTO;
        request->failed = 1;
        return -1;
    }
    if (git_tx_recv_exact(request->fd, buffer, length, 0) < 0) {
        request->failed = 1;
        return -1;
    }
    request->remaining -= length;
    return 0;
}

static int git_tx_body_drain(struct git_tx_request *request)
{
    unsigned char buffer[GIT_TX_CHUNK];
    while (request->remaining != 0) {
        size_t n = request->remaining < sizeof(buffer) ?
                   (size_t)request->remaining : sizeof(buffer);
        if (git_tx_body_read(request, buffer, n) < 0) return -1;
    }
    return 0;
}

static int git_tx_same_inode(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static int git_tx_check_mount_entry(int dirfd, const char *name, const struct stat *st)
{
    struct tree_mount mount;
    if (tree_mount_fd(dirfd, &mount) < 0) return -1;
    return tree_check_mount_entry(dirfd, name, st, &mount);
}

static int git_tx_check_mount_fd(int dirfd, int fd)
{
    struct tree_mount mount;
    if (tree_mount_fd(dirfd, &mount) < 0) return -1;
    return tree_check_mount_fd(fd, &mount);
}

static int git_tx_same_snapshot(const struct stat *a, const struct stat *b)
{
    if (!git_tx_same_inode(a, b) || a->st_mode != b->st_mode ||
        a->st_uid != b->st_uid || a->st_gid != b->st_gid ||
        a->st_nlink != b->st_nlink || a->st_size != b->st_size)
        return 0;
#if defined(__APPLE__)
    return a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
           a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
           a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
           a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#else
    return a->st_mtim.tv_sec == b->st_mtim.tv_sec &&
           a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
           a->st_ctim.tv_sec == b->st_ctim.tv_sec &&
           a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#endif
}

static enum git_tx_name_kind git_tx_name_kind(const char *name)
{
    const size_t prefix = sizeof(GIT_TX_PREFIX) - 1;
    const char *suffix;
    size_t i;
    if (strlen(name) < prefix + GIT_TX_ID_LENGTH + 4 ||
        strncmp(name, GIT_TX_PREFIX, prefix) != 0)
        return GIT_TX_INVALID_NAME;
    for (i = 0; i < GIT_TX_ID_LENGTH; ++i) {
        unsigned char c = (unsigned char)name[prefix + i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
            return GIT_TX_INVALID_NAME;
    }
    suffix = name + prefix + GIT_TX_ID_LENGTH;
    if (!strcmp(suffix, ".lock")) return GIT_TX_PRIVATE_LOCK;
    if (!strcmp(suffix, ".index.lock")) return GIT_TX_PRIVATE_INDEX_LOCK;
    if (!strcmp(suffix, ".index") || !strcmp(suffix, ".backup") ||
        !strcmp(suffix, ".journal") || !strcmp(suffix, ".tmp"))
        return GIT_TX_PRIVATE_FILE;
    if (!strcmp(suffix, ".lock.delete") || !strcmp(suffix, ".index.lock.delete") ||
        !strcmp(suffix, ".index.delete") || !strcmp(suffix, ".backup.delete") ||
        !strcmp(suffix, ".journal.delete") || !strcmp(suffix, ".tmp.delete"))
        return GIT_TX_PRIVATE_QUARANTINE;
    return GIT_TX_INVALID_NAME;
}

static int git_tx_regular(const struct stat *st, int private_file)
{
    if (S_ISLNK(st->st_mode)) { errno = ELOOP; return -1; }
    if (!S_ISREG(st->st_mode)) { errno = EINVAL; return -1; }
    if (private_file && st->st_uid != geteuid()) { errno = EPERM; return -1; }
    return 0;
}

/* A two-link exception is allowed only for our private lock and its other
 * name in this same pinned directory. No other hardlinks are accepted. */
static int git_tx_private_stat(int dirfd, const char *name, struct stat *st)
{
    struct stat other;
    enum git_tx_name_kind kind = git_tx_name_kind(name);
    if (kind == GIT_TX_INVALID_NAME) { errno = EINVAL; return -1; }
    if (fstatat(dirfd, name, st, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (git_tx_check_mount_entry(dirfd, name, st) < 0) return -1;
    if (git_tx_regular(st, 1) < 0) return -1;
    if (st->st_nlink == 1) return 0;
    if (kind != GIT_TX_PRIVATE_LOCK || st->st_nlink != 2) {
        errno = EMLINK;
        return -1;
    }
    if (fstatat(dirfd, "index.lock", &other, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(other.st_mode) && git_tx_same_inode(st, &other) &&
        other.st_nlink == 2) return git_tx_check_mount_entry(dirfd, "index.lock", &other);
    if (fstatat(dirfd, "index", &other, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(other.st_mode) && git_tx_same_inode(st, &other) &&
        other.st_nlink == 2) return git_tx_check_mount_entry(dirfd, "index", &other);
    errno = EMLINK;
    return -1;
}

static int git_tx_index_stat(int dirfd, const char *name, struct stat *st)
{
    if (fstatat(dirfd, name, st, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (git_tx_check_mount_entry(dirfd, name, st) < 0) return -1;
    if (git_tx_regular(st, 0) < 0) return -1;
    if (st->st_nlink != 1) { errno = EMLINK; return -1; }
    return 0;
}

static int git_tx_open_checked(int dirfd, const char *name, int private_file,
                               struct stat *opened)
{
    struct stat before, after;
    int fd, saved;
    if (private_file) {
        if (git_tx_private_stat(dirfd, name, &before) < 0) return -1;
    } else if (git_tx_index_stat(dirfd, name, &before) < 0) {
        return -1;
    }
    fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    if (fstat(fd, &after) < 0) goto fail;
    if (git_tx_check_mount_fd(dirfd, fd) < 0) goto fail;
    if (!git_tx_same_snapshot(&before, &after)) { errno = ESTALE; goto fail; }
    *opened = after;
    return fd;
fail:
    saved = errno;
    close(fd);
    errno = saved;
    return -1;
}

/* Read into one response buffer so a concurrent replacement or in-place edit
 * can be rejected before any bytes are sent to the worker. */
static int git_tx_read_file(struct git_tx_server *server, const char *name,
                            int private_file, size_t max_size,
                            const unsigned char *expected,
                            unsigned char **output, size_t *output_len)
{
    struct stat before, after, named;
    unsigned char *buffer = NULL;
    size_t length, done = 0;
    int fd, saved;

    if (!private_file && !strcmp(name, "index") && server->lockfd >= 0)
        server->index_seen = 0;
    fd = git_tx_open_checked(server->dirfd, name, private_file, &before);
    if (fd < 0) {
        if (errno == ENOENT && !private_file && !strcmp(name, "index") &&
            server->lockfd >= 0) {
            server->index_seen = 1;
            server->index_absent = 1;
        }
        return -1;
    }
    if (expected &&
        ((uint64_t)before.st_dev != git_tx_get64(expected) ||
         (uint64_t)before.st_ino != git_tx_get64(expected + 8))) {
        errno = ESTALE;
        goto fail;
    }
    if (before.st_size < 0 || (uintmax_t)before.st_size > (uintmax_t)SIZE_MAX ||
        (max_size != 0 && (uintmax_t)before.st_size > max_size)) {
        errno = EFBIG;
        goto fail;
    }
    length = (size_t)before.st_size;
    if (length != 0) {
        buffer = malloc(length);
        if (!buffer) goto fail;
    }
    while (done < length) {
        size_t want = length - done;
        ssize_t n;
        if (want > GIT_TX_CHUNK) want = GIT_TX_CHUNK;
        n = read(fd, buffer + done, want);
        if (n < 0) {
            if (errno == EINTR) continue;
            goto fail;
        }
        if (n == 0) { errno = ESTALE; goto fail; }
        done += (size_t)n;
    }
    if (fstat(fd, &after) < 0) goto fail;
    if (private_file) {
        if (git_tx_private_stat(server->dirfd, name, &named) < 0) goto fail;
    } else if (git_tx_index_stat(server->dirfd, name, &named) < 0) {
        goto fail;
    }
    if (!git_tx_same_snapshot(&before, &after) ||
        !git_tx_same_snapshot(&before, &named)) {
        errno = ESTALE;
        goto fail;
    }
    close(fd);
    if (!private_file && !strcmp(name, "index") && server->lockfd >= 0) {
        server->index_seen = 1;
        server->index_absent = 0;
        server->index_snapshot = named;
    }
    *output = buffer;
    *output_len = length;
    return 0;
fail:
    saved = errno;
    free(buffer);
    close(fd);
    errno = saved;
    return -1;
}

static int git_tx_recheck_index(struct git_tx_server *server)
{
    struct stat current;
    if (!server->index_seen) { errno = ESTALE; return -1; }
    if (git_tx_index_stat(server->dirfd, "index", &current) < 0) {
        if (errno == ENOENT && server->index_absent) return 0;
        if (errno == ENOENT) errno = ESTALE;
        return -1;
    }
    if (server->index_absent ||
        !git_tx_same_snapshot(&server->index_snapshot, &current)) {
        errno = ESTALE;
        return -1;
    }
    return 0;
}

/* 0: private inode only, 1: linked to index.lock, 2: installed as index.
 * The persistent private name prevents inode reuse and proves ownership even
 * if the process crashes after linking or after the rename. */
static int git_tx_lock_status(struct git_tx_server *server)
{
    struct stat opened, named, other;
    if (server->lockfd < 0) { errno = EBADF; return -1; }
    if (fstat(server->lockfd, &opened) < 0 ||
        git_tx_check_mount_fd(server->dirfd, server->lockfd) < 0 ||
        git_tx_private_stat(server->dirfd, server->lockname, &named) < 0)
        return -1;
    if (git_tx_regular(&opened, 1) < 0 ||
        !git_tx_same_inode(&server->lock_identity, &opened) ||
        !git_tx_same_inode(&opened, &named) || opened.st_nlink != named.st_nlink) {
        errno = ESTALE;
        return -1;
    }
    if (opened.st_nlink == 1) return 0;
    if (opened.st_nlink != 2) { errno = EMLINK; return -1; }
    if (fstatat(server->dirfd, "index.lock", &other, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(other.st_mode) && other.st_nlink == 2 &&
        git_tx_same_inode(&opened, &other)) {
        if (git_tx_check_mount_entry(server->dirfd, "index.lock", &other) < 0) return -1;
        return 1;
    }
    if (fstatat(server->dirfd, "index", &other, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(other.st_mode) && other.st_nlink == 2 &&
        git_tx_same_inode(&opened, &other)) {
        if (git_tx_check_mount_entry(server->dirfd, "index", &other) < 0) return -1;
        return 2;
    }
    errno = ESTALE;
    return -1;
}

static void git_tx_forget_lock(struct git_tx_server *server)
{
    if (server->lockfd >= 0) close(server->lockfd);
    server->lockfd = -1;
    server->lockname[0] = '\0';
    server->index_seen = 0;
    server->lock_written = 0;
}

static int git_tx_lock_create(struct git_tx_server *server, const char *name,
                              unsigned char reply[16])
{
    struct stat st, named;
    int fd, saved;
    if (server->lockfd >= 0) { errno = EBUSY; return -1; }
    if (git_tx_name_kind(name) != GIT_TX_PRIVATE_LOCK) { errno = EINVAL; return -1; }
    fd = openat(server->dirfd, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW |
                O_CLOEXEC, 0666);
    if (fd < 0) return -1;
    if (fstat(fd, &st) < 0) { saved = errno; close(fd); errno = saved; return -1; }
    if (git_tx_regular(&st, 1) < 0 || st.st_nlink != 1) {
        if (st.st_nlink != 1) errno = EMLINK;
        goto fail;
    }
    if (fsync(fd) < 0 || fsync(server->dirfd) < 0) goto fail;
    if (git_tx_private_stat(server->dirfd, name, &named) < 0) goto fail;
    if (!git_tx_same_inode(&st, &named) || named.st_nlink != 1) {
        errno = ESTALE;
        goto fail;
    }
    server->lockfd = fd;
    server->lock_identity = st;
    memcpy(server->lockname, name, strlen(name) + 1);
    server->index_seen = 0;
    server->lock_written = 0;
    git_tx_put64(reply, (uint64_t)st.st_dev);
    git_tx_put64(reply + 8, (uint64_t)st.st_ino);
    return 0;
fail:
    saved = errno;
    {
        unsigned char proof[16];
        git_tx_put64(proof, (uint64_t)st.st_dev);
        git_tx_put64(proof + 8, (uint64_t)st.st_ino);
        (void)git_tx_private_delete(server, name, proof);
    }
    close(fd);
    errno = saved;
    return -1;
}

static int git_tx_lock_adopt(struct git_tx_server *server, const char *name,
                             const unsigned char identity[16], unsigned char *status)
{
    struct stat before, opened, named;
    int fd, state, saved;
    if (server->lockfd >= 0) {
        if (strcmp(server->lockname, name) != 0 ||
            (uint64_t)server->lock_identity.st_dev != git_tx_get64(identity) ||
            (uint64_t)server->lock_identity.st_ino != git_tx_get64(identity + 8)) {
            errno = EBUSY;
            return -1;
        }
        state = git_tx_lock_status(server);
        if (state < 0) return -1;
        *status = (unsigned char)state;
        return 0;
    }
    if (git_tx_name_kind(name) != GIT_TX_PRIVATE_LOCK) { errno = EINVAL; return -1; }
    if (git_tx_private_stat(server->dirfd, name, &before) < 0) {
        if (errno != ENOENT) return -1;
        if (fsync(server->dirfd) < 0) return -1;
        errno = ENOENT;
        return -1;
    }
    if ((uint64_t)before.st_dev != git_tx_get64(identity) ||
        (uint64_t)before.st_ino != git_tx_get64(identity + 8)) {
        errno = ESTALE;
        return -1;
    }
    fd = openat(server->dirfd, name, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    if (fstat(fd, &opened) < 0 ||
        git_tx_private_stat(server->dirfd, name, &named) < 0) goto fail;
    if (!git_tx_same_inode(&before, &opened) ||
        !git_tx_same_inode(&opened, &named) || opened.st_nlink != named.st_nlink) {
        errno = ESTALE;
        goto fail;
    }
    server->lockfd = fd;
    server->lock_identity = opened;
    memcpy(server->lockname, name, strlen(name) + 1);
    server->index_seen = 0;
    server->lock_written = 0;
    state = git_tx_lock_status(server);
    if (state < 0) {
        saved = errno;
        git_tx_forget_lock(server);
        errno = saved;
        return -1;
    }
    *status = (unsigned char)state;
    return 0;
fail:
    saved = errno;
    close(fd);
    errno = saved;
    return -1;
}

static int git_tx_lock_acquire(struct git_tx_server *server)
{
    int status = git_tx_lock_status(server);
    if (status < 0) return -1;
    if (status != 0) { errno = EBUSY; return -1; }
    /* linkat is exclusive at the destination: an upstream index.lock is never
     * opened, truncated, renamed, or removed. The journal records this private
     * inode before this call, so every subsequent crash is recoverable. */
    if (linkat(server->dirfd, server->lockname, server->dirfd, "index.lock", 0) < 0)
        return -1;
    status = git_tx_lock_status(server);
    if (status != 1) { if (status >= 0) errno = ESTALE; return -1; }
    if (fsync(server->dirfd) < 0) return -1;
    server->index_seen = 0;
    return 0;
}

static int git_tx_write_all(int fd, const unsigned char *buffer, size_t length)
{
    while (length != 0) {
        ssize_t n = write(fd, buffer, length);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) { errno = EIO; return -1; }
        buffer += (size_t)n;
        length -= (size_t)n;
    }
    return 0;
}

/* Keep draining a request after a file error so the next frame stays aligned. */
static int git_tx_copy_body(struct git_tx_request *request, int fd)
{
    unsigned char buffer[GIT_TX_CHUNK];
    int saved = 0;
    while (request->remaining != 0) {
        size_t n = request->remaining < sizeof(buffer) ?
                   (size_t)request->remaining : sizeof(buffer);
        if (git_tx_body_read(request, buffer, n) < 0) return -1;
        if (!saved && git_tx_write_all(fd, buffer, n) < 0) saved = errno;
    }
    if (saved) { errno = saved; return -1; }
    return 0;
}

static int git_tx_lock_write(struct git_tx_server *server,
                             struct git_tx_request *request, uint64_t length)
{
    int status;
    server->lock_written = 0;
    status = git_tx_lock_status(server);
    if (status < 0) return -1;
    if (status != 1 || !server->index_seen) { errno = ESTALE; return -1; }
    if (git_tx_recheck_index(server) < 0) return -1;
    if (lseek(server->lockfd, 0, SEEK_SET) < 0) return -1;
    if (git_tx_copy_body(request, server->lockfd) < 0) return -1;
    if (ftruncate(server->lockfd, (off_t)length) < 0) return -1;
    if (!server->index_absent &&
        fchmod(server->lockfd, server->index_snapshot.st_mode & 0777) < 0) return -1;
    if (fsync(server->lockfd) < 0) return -1;
    status = git_tx_lock_status(server);
    if (status != 1) { if (status >= 0) errno = ESTALE; return -1; }
    server->lock_written = 1;
    return 0;
}

static int git_tx_lock_commit(struct git_tx_server *server)
{
    int status, saved;
    status = git_tx_lock_status(server);
    if (status < 0) return -1;
    if (status != 1 || !server->lock_written) { errno = ESTALE; return -1; }
    if (git_tx_recheck_index(server) < 0) return -1;
    if (renameat(server->dirfd, "index.lock", server->dirfd, "index") < 0)
        return -1;
    status = git_tx_lock_status(server);
    if (status != 2) { if (status >= 0) errno = ESTALE; return -1; }
    if (unlinkat(server->dirfd, server->lockname, 0) < 0) return -1;
    saved = fsync(server->dirfd) < 0 ? errno : 0;
    git_tx_forget_lock(server);
    if (saved) { errno = saved; return -1; }
    return 0;
}

static int git_tx_lock_abort(struct git_tx_server *server)
{
    int status, saved;
    status = git_tx_lock_status(server);
    if (status < 0) return -1;
    if (status == 1 && unlinkat(server->dirfd, "index.lock", 0) < 0) return -1;
    /* If already installed, only the private link is removed, never index. */
    if (unlinkat(server->dirfd, server->lockname, 0) < 0) return -1;
    saved = fsync(server->dirfd) < 0 ? errno : 0;
    git_tx_forget_lock(server);
    if (saved) { errno = saved; return -1; }
    return 0;
}

static int git_tx_lock_remove_index(struct git_tx_server *server)
{
    int status = git_tx_lock_status(server);
    if (status < 0) return -1;
    if (status != 1) { errno = ESTALE; return -1; }
    if (git_tx_recheck_index(server) < 0) return -1;
    if (!server->index_absent) {
        if (unlinkat(server->dirfd, "index", 0) < 0) return -1;
        server->index_absent = 1;
    }
    return fsync(server->dirfd);
}

static int git_tx_random_temp(int dirfd, char *name, struct stat *identity)
{
    static const char hex[] = "0123456789abcdef";
    unsigned char random[16];
    const size_t prefix = sizeof(GIT_TX_PREFIX) - 1;
    unsigned int attempt;
    for (attempt = 0; attempt < 32; ++attempt) {
        int fd;
        size_t i;
        while (getentropy(random, sizeof(random)) < 0) {
            if (errno != EINTR) return -1;
        }
        memcpy(name, GIT_TX_PREFIX, prefix);
        for (i = 0; i < sizeof(random); ++i) {
            name[prefix + i * 2] = hex[random[i] >> 4];
            name[prefix + i * 2 + 1] = hex[random[i] & 15];
        }
        memcpy(name + prefix + GIT_TX_ID_LENGTH, ".tmp", sizeof(".tmp"));
        fd = openat(dirfd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW |
                    O_CLOEXEC, 0600);
        if (fd < 0) {
            if (errno == EEXIST) continue;
            return -1;
        }
        if (fstat(fd, identity) < 0) {
            int saved = errno;
            close(fd);
            errno = saved;
            return -1;
        }
        if (git_tx_regular(identity, 1) < 0 || identity->st_nlink != 1) {
            int saved = errno ? errno : EMLINK;
            close(fd);
            errno = saved;
            return -1;
        }
        return fd;
    }
    errno = EEXIST;
    return -1;
}


static int git_tx_private_put(struct git_tx_server *server, const char *name,
                              struct git_tx_request *request, unsigned char reply[16])
{
    char temp[GIT_TX_NAME_MAX + 1];
    struct stat identity, named, opened, target;
    int fd, saved;
    if (git_tx_name_kind(name) != GIT_TX_PRIVATE_FILE) { errno = EINVAL; return -1; }
    if (git_tx_private_stat(server->dirfd, name, &target) == 0) {
        errno = EEXIST;
        return -1;
    }
    if (errno != ENOENT) return -1;
    fd = git_tx_random_temp(server->dirfd, temp, &identity);
    if (fd < 0) return -1;
    if (git_tx_copy_body(request, fd) < 0 || fsync(fd) < 0) goto fail;
    if (fstat(fd, &opened) < 0 ||
        git_tx_private_stat(server->dirfd, temp, &named) < 0) goto fail;
    if (!git_tx_same_inode(&identity, &opened) ||
        !git_tx_same_snapshot(&opened, &named) || named.st_nlink != 1) {
        errno = ESTALE;
        goto fail;
    }
    /* Unlike renameat, this cannot replace a colliding private filename. */
    if (git_state_rename(server->dirfd, temp, server->dirfd, name, 0) < 0)
        goto fail;
    if (git_tx_private_stat(server->dirfd, name, &named) < 0) {
        saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    if (!git_tx_same_inode(&identity, &named) || named.st_nlink != 1) {
        close(fd);
        errno = ESTALE;
        return -1;
    }
    saved = fsync(server->dirfd) < 0 ? errno : 0;
    close(fd);
    if (saved) { errno = saved; return -1; }
    git_tx_put64(reply, (uint64_t)named.st_dev);
    git_tx_put64(reply + 8, (uint64_t)named.st_ino);
    return 0;
fail:
    saved = errno;
    {
        unsigned char proof[16];
        git_tx_put64(proof, (uint64_t)identity.st_dev);
        git_tx_put64(proof + 8, (uint64_t)identity.st_ino);
        (void)git_tx_private_delete(server, temp, proof);
    }
    close(fd);
    errno = saved;
    return -1;
}

static int git_tx_private_identity(struct git_tx_server *server, const char *name,
                                   unsigned char reply[16])
{
    struct stat opened, named;
    int fd, saved;
    fd = git_tx_open_checked(server->dirfd, name, 1, &opened);
    if (fd < 0) return -1;
    if (opened.st_nlink != 1) { errno = EMLINK; goto fail; }
    if (git_tx_private_stat(server->dirfd, name, &named) < 0) goto fail;
    if (!git_tx_same_snapshot(&opened, &named)) { errno = ESTALE; goto fail; }
    close(fd);
    git_tx_put64(reply, (uint64_t)opened.st_dev);
    git_tx_put64(reply + 8, (uint64_t)opened.st_ino);
    return 0;
fail:
    saved = errno;
    close(fd);
    errno = saved;
    return -1;
}

static int git_tx_private_delete(struct git_tx_server *server, const char *name,
                                 const unsigned char identity[16])
{
    char quarantine[GIT_TX_NAME_MAX + 1];
    struct stat st;
    enum git_tx_name_kind kind = git_tx_name_kind(name);
    size_t length = strlen(name);
    if (kind == GIT_TX_INVALID_NAME || kind == GIT_TX_PRIVATE_QUARANTINE ||
        length + sizeof(".delete") > sizeof(quarantine)) {
        errno = EINVAL;
        return -1;
    }
    if (server->lockfd >= 0 && !strcmp(server->lockname, name)) {
        errno = EBUSY;
        return -1;
    }
    memcpy(quarantine, name, length);
    memcpy(quarantine + length, ".delete", sizeof(".delete"));
    /* A retry after a crash can finish an already-quarantined deletion. */
    if (git_tx_private_stat(server->dirfd, quarantine, &st) == 0) {
        if (st.st_nlink != 1 || (uint64_t)st.st_dev != git_tx_get64(identity) ||
            (uint64_t)st.st_ino != git_tx_get64(identity + 8)) {
            errno = ESTALE;
            return -1;
        }
        if (unlinkat(server->dirfd, quarantine, 0) < 0) return -1;
        return fsync(server->dirfd);
    }
    if (errno != ENOENT) return -1;
    if (git_tx_private_stat(server->dirfd, name, &st) < 0) {
        if (errno != ENOENT) return -1;
        if (fsync(server->dirfd) < 0) return -1;
        errno = ENOENT;
        return -1;
    }
    if (st.st_nlink != 1 || (uint64_t)st.st_dev != git_tx_get64(identity) ||
        (uint64_t)st.st_ino != git_tx_get64(identity + 8)) {
        errno = ESTALE;
        return -1;
    }
    /* Move without replacement before checking again: a swapped file is
     * preserved, and restoration never overwrites a new occupant. */
    if (git_state_rename(server->dirfd, name, server->dirfd, quarantine, 0) < 0)
        return -1;
    if (git_tx_private_stat(server->dirfd, quarantine, &st) < 0 ||
        st.st_nlink != 1 || (uint64_t)st.st_dev != git_tx_get64(identity) ||
        (uint64_t)st.st_ino != git_tx_get64(identity + 8)) {
        (void)git_state_rename(server->dirfd, quarantine, server->dirfd, name, 0);
        (void)fsync(server->dirfd);
        errno = ESTALE;
        return -1;
    }
    if (unlinkat(server->dirfd, quarantine, 0) < 0) return -1;
    return fsync(server->dirfd);
}

static int git_tx_private_list(struct git_tx_server *server,
                               unsigned char **output, size_t *output_len)
{
    unsigned char *buffer = NULL;
    size_t used = 0, capacity = 0;
    struct dirent *entry;
    DIR *dir;
    int fd, saved;
    fd = openat(server->dirfd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    dir = fdopendir(fd);
    if (!dir) { saved = errno; close(fd); errno = saved; return -1; }
    for (;;) {
        struct stat st;
        size_t length, needed;
        unsigned char *grown;
        errno = 0;
        entry = readdir(dir);
        if (!entry) {
            if (errno != 0) goto fail;
            break;
        }
        if (git_tx_name_kind(entry->d_name) == GIT_TX_INVALID_NAME) continue;
        if (git_tx_private_stat(server->dirfd, entry->d_name, &st) < 0) goto fail;
        length = strlen(entry->d_name) + 1;
        if (length > SIZE_MAX - used) { errno = EOVERFLOW; goto fail; }
        needed = used + length;
        if (needed > capacity) {
            size_t next = capacity ? capacity : 256;
            while (next < needed) {
                if (next > SIZE_MAX / 2) { next = needed; break; }
                next *= 2;
            }
            grown = realloc(buffer, next);
            if (!grown) goto fail;
            buffer = grown;
            capacity = next;
        }
        memcpy(buffer + used, entry->d_name, length);
        used = needed;
    }
    if (closedir(dir) < 0) { free(buffer); return -1; }
    *output = buffer;
    *output_len = used;
    return 0;
fail:
    saved = errno;
    free(buffer);
    closedir(dir);
    errno = saved;
    return -1;
}

/* Hold every ancestor, and revalidate each name from the pinned root.
 * Merely holding the final parent is insufficient if a checkout renames it. */
struct git_tx_root_path {
    int *fds;
    char **names;
    struct stat *identities;
    char *text;
    char *leaf;
    size_t count;
    struct tree_mount mount;
};

static int git_tx_utf8(const char *text)
{
    const unsigned char *p = (const unsigned char *)text;
    while (*p) {
        uint32_t code;
        unsigned int n, i;
        if (*p < 0x80) { ++p; continue; }
        if (*p >= 0xc2 && *p <= 0xdf) { code = *p & 0x1f; n = 1; }
        else if (*p >= 0xe0 && *p <= 0xef) { code = *p & 0x0f; n = 2; }
        else if (*p >= 0xf0 && *p <= 0xf4) { code = *p & 0x07; n = 3; }
        else { errno = EILSEQ; return -1; }
        ++p;
        for (i = 0; i < n; ++i) {
            if ((p[i] & 0xc0) != 0x80) { errno = EILSEQ; return -1; }
            code = (code << 6) | (p[i] & 0x3f);
        }
        if ((n == 2 && code < 0x800) || (n == 3 && code < 0x10000) ||
            (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
            errno = EILSEQ;
            return -1;
        }
        p += n;
    }
    return 0;
}

static int git_tx_reserved_component(const char *name)
{
    static const char *const reserved[] = { ".git", ".skills-manager" };
    size_t i;
    for (i = 0; i < sizeof(reserved) / sizeof(reserved[0]); ++i) {
        const unsigned char *a = (const unsigned char *)name;
        const unsigned char *b = (const unsigned char *)reserved[i];
        while (*a && *b) {
            unsigned char c = *a;
            if (c >= 'A' && c <= 'Z') c = (unsigned char)(c + ('a' - 'A'));
            if (c != *b) break;
            ++a;
            ++b;
        }
        if (!*a && !*b) return 1;
    }
    return 0;
}

static void git_tx_root_path_close(struct git_tx_root_path *path)
{
    size_t i;
    for (i = 0; i < path->count; ++i) close(path->fds[i]);
    free(path->fds);
    free(path->names);
    free(path->identities);
    free(path->text);
    memset(path, 0, sizeof(*path));
}

static int git_tx_root_path_current(const struct git_tx_root_path *path)
{
    struct stat opened, named;
    size_t i;
    if (fstat(path->fds[0], &opened) < 0 ||
        tree_check_mount_fd(path->fds[0], &path->mount) < 0) return -1;
    if (!tree_same_identity(&path->identities[0], &opened) || !S_ISDIR(opened.st_mode)) {
        errno = ESTALE;
        return -1;
    }
    for (i = 1; i < path->count; ++i) {
        if (fstat(path->fds[i], &opened) < 0 ||
            fstatat(path->fds[i - 1], path->names[i], &named, AT_SYMLINK_NOFOLLOW) < 0 ||
            tree_check_mount_fd(path->fds[i], &path->mount) < 0 ||
            tree_check_mount_entry(path->fds[i - 1], path->names[i], &named, &path->mount) < 0) {
            if (errno == ENOENT) errno = ESTALE;
            return -1;
        }
        if (!S_ISDIR(named.st_mode) ||
            !tree_same_identity(&path->identities[i], &opened) ||
            !tree_same_identity(&opened, &named)) {
            errno = ESTALE;
            return -1;
        }
    }
    return 0;
}

/* all=0 opens the parent and keeps the leaf; all=1 opens the directory itself. */
static int git_tx_root_path_open(int root_fd, const char *name, int all,
                                 struct git_tx_root_path *path)
{
    size_t pieces = 0, i, depth;
    char *p, *start;
    int saved;
    memset(path, 0, sizeof(*path));
    if (strlen(name) > GIT_TX_PATH_MAX || git_tx_utf8(name) < 0) {
        if (strlen(name) > GIT_TX_PATH_MAX) errno = ENAMETOOLONG;
        return -1;
    }
    path->text = strdup(name);
    if (!path->text) return -1;
    if (*name) {
        pieces = 1;
        for (p = path->text; *p; ++p) if (*p == '/') ++pieces;
    }
    if (pieces > TREE_MAX_DEPTH) { errno = ENAMETOOLONG; goto fail; }
    path->fds = calloc(pieces + 1, sizeof(*path->fds));
    path->names = calloc(pieces + 1, sizeof(*path->names));
    path->identities = calloc(pieces + 1, sizeof(*path->identities));
    if (!path->fds || !path->names || !path->identities) goto fail;
    p = path->text;
    for (i = 1; i <= pieces; ++i) {
        start = p;
        while (*p && *p != '/') ++p;
        if (*p) *p++ = '\0';
        if (tree_component(start) < 0 || strlen(start) > GIT_TX_NAME_MAX ||
            git_tx_reserved_component(start)) {
            errno = EINVAL;
            goto fail;
        }
        path->names[i] = start;
    }
    path->leaf = pieces && !all ? path->names[pieces] : NULL;
    depth = all ? pieces : (pieces ? pieces - 1 : 0);
    path->fds[0] = dup(root_fd);
    if (path->fds[0] < 0) goto fail;
    path->count = 1;
    if (fstat(path->fds[0], &path->identities[0]) < 0 ||
        tree_mount_fd(path->fds[0], &path->mount) < 0) goto fail;
    if (!S_ISDIR(path->identities[0].st_mode)) { errno = ENOTDIR; goto fail; }
    for (i = 1; i <= depth; ++i) {
        struct stat named, opened;
        int fd;
        if (fstatat(path->fds[i - 1], path->names[i], &named, AT_SYMLINK_NOFOLLOW) < 0 ||
            tree_check_mount_entry(path->fds[i - 1], path->names[i], &named, &path->mount) < 0)
            goto fail;
        if (!S_ISDIR(named.st_mode)) { errno = ENOTDIR; goto fail; }
        fd = openat(path->fds[i - 1], path->names[i],
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0) goto fail;
        path->fds[i] = fd;
        ++path->count;
        if (fstat(fd, &opened) < 0 || tree_check_mount_fd(fd, &path->mount) < 0) goto fail;
        if (!tree_same_identity(&named, &opened)) { errno = ESTALE; goto fail; }
        path->identities[i] = opened;
    }
    if (git_tx_root_path_current(path) < 0) goto fail;
    return 0;
fail:
    saved = errno;
    git_tx_root_path_close(path);
    errno = saved;
    return -1;
}

static int git_tx_node_stat(int parent, const char *name, const struct tree_mount *mount,
                            struct stat *st, unsigned char *kind)
{
    if (fstatat(parent, name, st, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_entry(parent, name, st, mount) < 0) return -1;
    if (S_ISREG(st->st_mode)) {
        if (st->st_nlink != 1) { errno = EMLINK; return -1; }
        *kind = (st->st_mode & 0111) ? 2 : 1;
    } else if (S_ISLNK(st->st_mode)) {
        *kind = 3;
    } else if (S_ISDIR(st->st_mode)) {
        *kind = 4;
    } else {
        errno = ENOTSUP;
        return -1;
    }
    return 0;
}

static int git_tx_identity_matches(const struct stat *st, const unsigned char *identity)
{
    return (uint64_t)st->st_dev == git_tx_get64(identity) &&
           (uint64_t)st->st_ino == git_tx_get64(identity + 8);
}

static void git_tx_identity_write(unsigned char *output, const struct stat *st)
{
    git_tx_put64(output, (uint64_t)st->st_dev);
    git_tx_put64(output + 8, (uint64_t)st->st_ino);
}

static void git_tx_snapshot_header(unsigned char *out, unsigned char kind,
                                   const struct stat *st, const char *fingerprint)
{
    out[0] = kind;
    git_tx_put32(out + 1, (uint32_t)st->st_mode);
    git_tx_identity_write(out + 5, st);
    memcpy(out + 21, fingerprint, 64);
}

static int git_tx_empty_directory(int fd)
{
    struct stat before, after;
    DIR *dir;
    int copy, result = -1, saved;
    if (fstat(fd, &before) < 0) return -1;
    if (!S_ISDIR(before.st_mode)) { errno = ENOTDIR; return -1; }
    copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (copy < 0) return -1;
    dir = fdopendir(copy);
    if (!dir) { saved = errno; close(copy); errno = saved; return -1; }
    for (;;) {
        struct dirent *entry;
        errno = 0;
        entry = readdir(dir);
        if (!entry) {
            if (errno) goto done;
            break;
        }
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
            errno = ENOTEMPTY;
            goto done;
        }
    }
    if (fstat(fd, &after) < 0) goto done;
    if (!tree_same_snapshot(&before, &after)) { errno = ESTALE; goto done; }
    result = 0;
done:
    saved = errno;
    if (closedir(dir) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) errno = saved;
    return result;
}

static int git_tx_empty_at(int parent, const char *name, const struct tree_mount *mount,
                            const struct stat *before)
{
    int fd, result = -1, saved;
    struct stat opened;
    fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    if (fstat(fd, &opened) < 0 || tree_check_mount_fd(fd, mount) < 0) goto done;
    if (!tree_same_snapshot(before, &opened)) { errno = ESTALE; goto done; }
    if (git_tx_empty_directory(fd) < 0 ||
        tree_check_source(parent, name, fd, before, mount) < 0) goto done;
    result = 0;
done:
    saved = errno;
    if (close(fd) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) errno = saved;
    return result;
}

/* A proof never trusts the fingerprint alone: identity, kind, link count,
 * mount and the complete pre/post snapshot must also agree. */
static int git_tx_node_proof(int parent, const char *name, const struct tree_mount *mount,
                             const unsigned char *identity, const unsigned char *fingerprint,
                             unsigned char expected_kind, int require_empty,
                             struct stat *proven)
{
    struct stat before, after;
    unsigned char kind, after_kind;
    char digest[65];
    if (expected_kind < 1 || expected_kind > 4) { errno = EINVAL; return -1; }
    if (git_tx_node_stat(parent, name, mount, &before, &kind) < 0) return -1;
    if (kind != expected_kind || !git_tx_identity_matches(&before, identity)) {
        errno = ESTALE;
        return -1;
    }
    if (kind == 4) {
        memset(digest, '0', 64);
        digest[64] = '\0';
        if (require_empty && git_tx_empty_at(parent, name, mount, &before) < 0) return -1;
    } else if (tree_fingerprint_at(parent, name, TREE_CONTENT_ONLY, digest) < 0) {
        return -1;
    }
    if (git_tx_node_stat(parent, name, mount, &after, &after_kind) < 0) return -1;
    if (after_kind != kind || !tree_same_snapshot(&before, &after) ||
        memcmp(digest, fingerprint, 64) != 0) {
        errno = ESTALE;
        return -1;
    }
    if (proven) *proven = after;
    return 0;
}

/* Buffer the exact bytes before replying, so an ordinary concurrent edit
 * cannot produce a response whose fingerprint describes different contents. */
static int git_tx_node_snapshot(int parent, const char *name, const struct tree_mount *mount,
                                unsigned char **output, size_t *output_len)
{
    struct stat before, after;
    unsigned char kind, after_kind, *buffer = NULL;
    char digest[65];
    size_t length = 0, capacity = 0, done = 0;
    int fd = -1, result = -1, saved;
    if (git_tx_node_stat(parent, name, mount, &before, &kind) < 0) return -1;
    if (kind == 4) {
        memset(digest, '0', 64);
        digest[64] = '\0';
    } else if (tree_fingerprint_at(parent, name, TREE_CONTENT_ONLY, digest) < 0) {
        return -1;
    }
    if (kind == 1 || kind == 2) {
        if (before.st_size < 0 ||
            (uintmax_t)before.st_size > (uintmax_t)(SIZE_MAX - GIT_TX_SNAPSHOT_HEADER)) {
            errno = EFBIG;
            goto done;
        }
        length = (size_t)before.st_size;
        buffer = malloc(GIT_TX_SNAPSHOT_HEADER + length);
        if (!buffer) goto done;
        fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0 || tree_check_mount_fd(fd, mount) < 0 ||
            tree_check_source(parent, name, fd, &before, mount) < 0) goto done;
        while (done < length) {
            size_t count = length - done;
            ssize_t n;
            if (count > GIT_TX_CHUNK) count = GIT_TX_CHUNK;
            n = read(fd, buffer + GIT_TX_SNAPSHOT_HEADER + done, count);
            if (n < 0) { if (errno == EINTR) continue; goto done; }
            if (n == 0) { errno = ESTALE; goto done; }
            done += (size_t)n;
        }
        if (tree_check_source(parent, name, fd, &before, mount) < 0) goto done;
    } else if (kind == 3) {
        if (before.st_size < 0 || (uintmax_t)before.st_size >= GIT_TX_LINK_MAX) {
            errno = EFBIG;
            goto done;
        }
        capacity = before.st_size > 0 ? (size_t)before.st_size + 1 : 256;
        for (;;) {
            unsigned char *grown;
            ssize_t n;
            if (capacity > GIT_TX_LINK_MAX) { errno = EFBIG; goto done; }
            grown = realloc(buffer, GIT_TX_SNAPSHOT_HEADER + capacity);
            if (!grown) goto done;
            buffer = grown;
            n = readlinkat(parent, name, (char *)buffer + GIT_TX_SNAPSHOT_HEADER, capacity);
            if (n < 0) goto done;
            if ((size_t)n < capacity) { length = (size_t)n; break; }
            if (capacity > GIT_TX_LINK_MAX / 2) { errno = EFBIG; goto done; }
            capacity *= 2;
        }
    } else {
        buffer = malloc(GIT_TX_SNAPSHOT_HEADER);
        if (!buffer) goto done;
    }
    if (git_tx_node_stat(parent, name, mount, &after, &after_kind) < 0) goto done;
    if (kind != after_kind || !tree_same_snapshot(&before, &after)) {
        errno = ESTALE;
        goto done;
    }
    git_tx_snapshot_header(buffer, kind, &before, digest);
    result = 0;
done:
    saved = errno;
    if (fd >= 0 && close(fd) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) {
        free(buffer);
        errno = saved;
        return -1;
    }
    *output = buffer;
    *output_len = GIT_TX_SNAPSHOT_HEADER + length;
    return 0;
}

static int git_tx_root_info(int root_fd, const char *name,
                            unsigned char **output, size_t *output_len)
{
    struct git_tx_root_path path;
    int parent, result = -1, saved;
    if (git_tx_root_path_open(root_fd, name, 0, &path) < 0) return -1;
    parent = path.fds[path.count - 1];
    if (path.leaf) {
        if (git_tx_node_snapshot(parent, path.leaf, &path.mount, output, output_len) < 0)
            goto done;
    } else {
        struct stat st;
        char zeros[64];
        if (fstat(parent, &st) < 0) goto done;
        *output = malloc(GIT_TX_SNAPSHOT_HEADER);
        if (!*output) goto done;
        memset(zeros, '0', sizeof(zeros));
        git_tx_snapshot_header(*output, 4, &st, zeros);
        *output_len = GIT_TX_SNAPSHOT_HEADER;
    }
    if (git_tx_root_path_current(&path) < 0) {
        free(*output);
        *output = NULL;
        *output_len = 0;
        goto done;
    }
    result = 0;
done:
    saved = errno;
    git_tx_root_path_close(&path);
    if (result < 0) errno = saved;
    return result;
}

static int git_tx_root_list(int root_fd, const char *name,
                            unsigned char **output, size_t *output_len)
{
    struct git_tx_root_path path;
    struct stat before, after;
    unsigned char *buffer = NULL;
    size_t used = 0, capacity = 0;
    int fd, copy, result = -1, saved;
    DIR *dir = NULL;
    if (git_tx_root_path_open(root_fd, name, 1, &path) < 0) return -1;
    fd = path.fds[path.count - 1];
    if (fstat(fd, &before) < 0) goto done;
    copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (copy < 0) goto done;
    dir = fdopendir(copy);
    if (!dir) { saved = errno; close(copy); errno = saved; goto done; }
    for (;;) {
        struct dirent *entry;
        size_t length, needed;
        errno = 0;
        entry = readdir(dir);
        if (!entry) {
            if (errno) goto done;
            break;
        }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        if (tree_component(entry->d_name) < 0 || git_tx_utf8(entry->d_name) < 0) goto done;
        length = strlen(entry->d_name) + 1;
        if (length > SIZE_MAX - used) { errno = EOVERFLOW; goto done; }
        needed = used + length;
        if (needed > capacity) {
            unsigned char *grown;
            size_t next = capacity ? capacity : 256;
            while (next < needed) {
                if (next > SIZE_MAX / 2) { next = needed; break; }
                next *= 2;
            }
            grown = realloc(buffer, next);
            if (!grown) goto done;
            buffer = grown;
            capacity = next;
        }
        memcpy(buffer + used, entry->d_name, length);
        used = needed;
    }
    if (fstat(fd, &after) < 0 || git_tx_root_path_current(&path) < 0) goto done;
    if (!tree_same_snapshot(&before, &after)) { errno = ESTALE; goto done; }
    result = 0;
done:
    saved = errno;
    if (dir && closedir(dir) < 0 && result == 0) { saved = errno; result = -1; }
    git_tx_root_path_close(&path);
    if (result < 0) {
        free(buffer);
        errno = saved;
        return -1;
    }
    *output = buffer;
    *output_len = used;
    return 0;
}

struct git_tx_stage {
    struct git_state_directory state;
    int fd;
    char name[sizeof("git-pull-") + GIT_TX_ID_LENGTH];
    struct stat identity;
};

static int git_tx_valid_id(const char *id)
{
    size_t i;
    if (strlen(id) != GIT_TX_ID_LENGTH) { errno = EINVAL; return -1; }
    for (i = 0; i < GIT_TX_ID_LENGTH; ++i) {
        unsigned char c = (unsigned char)id[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            errno = EINVAL;
            return -1;
        }
    }
    return 0;
}

static int git_tx_valid_slot(const char *slot)
{
    size_t i, length = strlen(slot);
    if (length == 0 || length > 31 || slot[0] < 'a' || slot[0] > 'z') {
        errno = EINVAL;
        return -1;
    }
    for (i = 1; i < length; ++i) {
        unsigned char c = (unsigned char)slot[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) {
            errno = EINVAL;
            return -1;
        }
    }
    return 0;
}

static int git_tx_split_slot(const char *name, char id[GIT_TX_ID_LENGTH + 1],
                             char slot[32])
{
    size_t length = strlen(name);
    if (length < GIT_TX_ID_LENGTH + 2 || length > GIT_TX_ID_LENGTH + 32 ||
        name[GIT_TX_ID_LENGTH] != '/') { errno = EINVAL; return -1; }
    memcpy(id, name, GIT_TX_ID_LENGTH);
    id[GIT_TX_ID_LENGTH] = '\0';
    memcpy(slot, name + GIT_TX_ID_LENGTH + 1, length - GIT_TX_ID_LENGTH);
    if (git_tx_valid_id(id) < 0 || git_tx_valid_slot(slot) < 0) return -1;
    return 0;
}

static void git_tx_stage_name(struct git_tx_stage *stage, const char *id)
{
    memcpy(stage->name, "git-pull-", sizeof("git-pull-") - 1);
    memcpy(stage->name + sizeof("git-pull-") - 1, id, GIT_TX_ID_LENGTH + 1);
}

static void git_tx_stage_close(struct git_tx_stage *stage)
{
    if (stage->fd >= 0) close(stage->fd);
    if (stage->state.state >= 0) close(stage->state.state);
}

static int git_tx_stage_current(struct git_tx_stage *stage)
{
    struct stat opened, named;
    if (git_state_directory_current(&stage->state) < 0 ||
        fstat(stage->fd, &opened) < 0 ||
        fstatat(stage->state.state, stage->name, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_fd(stage->fd, &stage->state.mount) < 0 ||
        tree_check_mount_entry(stage->state.state, stage->name, &named,
                               &stage->state.mount) < 0) {
        if (errno == ENOENT) errno = ESTALE;
        return -1;
    }
    if (!S_ISDIR(opened.st_mode) || opened.st_uid != geteuid() ||
        (opened.st_mode & 07777) != 0700 ||
        !tree_same_identity(&stage->identity, &opened) ||
        !tree_same_identity(&opened, &named)) {
        errno = ESTALE;
        return -1;
    }
    return 0;
}

static int git_tx_stage_open(int root_fd, const char *id, const unsigned char *identity,
                             struct git_tx_stage *stage)
{
    struct stat named;
    int saved;
    memset(stage, 0, sizeof(*stage));
    stage->fd = -1;
    stage->state.state = -1;
    if (git_tx_valid_id(id) < 0) return -1;
    git_tx_stage_name(stage, id);
    if (git_state_open(root_fd, &stage->state) < 0) return -1;
    if (fstatat(stage->state.state, stage->name, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_entry(stage->state.state, stage->name, &named,
                               &stage->state.mount) < 0) goto fail;
    if (!S_ISDIR(named.st_mode)) { errno = ENOTDIR; goto fail; }
    stage->fd = openat(stage->state.state, stage->name,
                       O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (stage->fd < 0 || fstat(stage->fd, &stage->identity) < 0) goto fail;
    if (!tree_same_identity(&named, &stage->identity) ||
        !git_tx_identity_matches(&stage->identity, identity)) { errno = ESTALE; goto fail; }
    if (git_tx_stage_current(stage) < 0) goto fail;
    return 0;
fail:
    saved = errno;
    git_tx_stage_close(stage);
    errno = saved;
    return -1;
}

static int git_tx_stage_create(int root_fd, const char *id, unsigned char reply[16])
{
    struct git_tx_stage stage;
    struct stat named;
    int result = -1, saved;
    memset(&stage, 0, sizeof(stage));
    stage.fd = -1;
    stage.state.state = -1;
    if (git_tx_valid_id(id) < 0) return -1;
    git_tx_stage_name(&stage, id);
    if (git_state_open(root_fd, &stage.state) < 0) return -1;
    if (git_state_directory_current(&stage.state) < 0 ||
        mkdirat(stage.state.state, stage.name, 0700) < 0) goto done;
    if (fstatat(stage.state.state, stage.name, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_entry(stage.state.state, stage.name, &named, &stage.state.mount) < 0)
        goto done;
    if (!S_ISDIR(named.st_mode) || named.st_uid != geteuid()) { errno = ESTALE; goto done; }
    stage.fd = openat(stage.state.state, stage.name,
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (stage.fd < 0 || fstat(stage.fd, &stage.identity) < 0 ||
        tree_check_mount_fd(stage.fd, &stage.state.mount) < 0) goto done;
    if (!tree_same_identity(&named, &stage.identity)) { errno = ESTALE; goto done; }
    if (fchmod(stage.fd, 0700) < 0 || git_tx_stage_current(&stage) < 0 ||
        fsync(stage.fd) < 0 || fsync(stage.state.state) < 0 ||
        git_tx_stage_current(&stage) < 0) goto done;
    git_tx_identity_write(reply, &stage.identity);
    result = 0;
done:
    saved = errno;
    git_tx_stage_close(&stage);
    if (result < 0) errno = saved;
    return result;
}

/* Once created, the file descriptor stays writable even if its directory is
 * renamed. Recheck reachability around every chunk and still drain on error. */
static int git_tx_stage_copy_body(struct git_tx_stage *stage,
                                  struct git_tx_request *request, int fd)
{
    unsigned char buffer[GIT_TX_CHUNK];
    int saved = 0;
    while (request->remaining != 0) {
        size_t count = request->remaining < sizeof(buffer) ?
                       (size_t)request->remaining : sizeof(buffer);
        if (git_tx_body_read(request, buffer, count) < 0) return -1;
        if (!saved && (git_tx_stage_current(stage) < 0 ||
                       git_tx_write_all(fd, buffer, count) < 0 ||
                       git_tx_stage_current(stage) < 0))
            saved = errno;
    }
    if (saved) { errno = saved; return -1; }
    return 0;
}

static int git_tx_stage_put(int root_fd, const char *name, struct git_tx_request *request,
                            unsigned char **output, size_t *output_len)
{
    char id[GIT_TX_ID_LENGTH + 1], slot[32];
    unsigned char input[17], *target = NULL;
    struct git_tx_stage stage;
    struct stat created;
    int fd = -1, result = -1, saved, created_ok = 0;
    if (git_tx_split_slot(name, id, slot) < 0 ||
        git_tx_body_read(request, input, sizeof(input)) < 0) return -1;
    if (input[16] < 1 || input[16] > 4 ||
        (input[16] == 4 && request->remaining != 0)) { errno = EINVAL; return -1; }
    if (input[16] == 3) {
        size_t length;
        if (request->remaining >= GIT_TX_LINK_MAX) { errno = EFBIG; return -1; }
        length = (size_t)request->remaining;
        target = malloc(length + 1);
        if (!target) return -1;
        if (git_tx_body_read(request, target, length) < 0) goto early;
        if (memchr(target, '\0', length)) { errno = EINVAL; goto early; }
        target[length] = '\0';
    }
    if (git_tx_stage_open(root_fd, id, input, &stage) < 0) goto early;
    if (git_tx_stage_current(&stage) < 0) goto done;
    if (input[16] == 1 || input[16] == 2) {
        fd = openat(stage.fd, slot, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                    input[16] == 2 ? 0777 : 0666);
        if (fd < 0 || fstat(fd, &created) < 0) goto done;
        created_ok = 1;
        if (!S_ISREG(created.st_mode) || created.st_uid != geteuid() || created.st_nlink != 1) {
            errno = ESTALE;
            goto done;
        }
        if (tree_check_mount_fd(fd, &stage.state.mount) < 0 ||
            tree_check_created(stage.fd, slot, fd, &created, &stage.state.mount) < 0 ||
            git_tx_stage_copy_body(&stage, request, fd) < 0 || fsync(fd) < 0) goto done;
    } else if (input[16] == 3) {
        if (symlinkat((const char *)target, stage.fd, slot) < 0 ||
            fstatat(stage.fd, slot, &created, AT_SYMLINK_NOFOLLOW) < 0) goto done;
        created_ok = 1;
    } else {
        if (mkdirat(stage.fd, slot, 0777) < 0 ||
            fstatat(stage.fd, slot, &created, AT_SYMLINK_NOFOLLOW) < 0) goto done;
        created_ok = 1;
        fd = openat(stage.fd, slot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0 || tree_check_created(stage.fd, slot, fd, &created, &stage.state.mount) < 0 ||
            tree_check_mount_fd(fd, &stage.state.mount) < 0 || fsync(fd) < 0) goto done;
    }
    if (git_tx_stage_current(&stage) < 0 ||
        git_tx_node_snapshot(stage.fd, slot, &stage.state.mount, output, output_len) < 0)
        goto done;
    if (!created_ok || !git_tx_identity_matches(&created, *output + 5) ||
        (*output)[0] != input[16]) {
        free(*output);
        *output = NULL;
        *output_len = 0;
        errno = ESTALE;
        goto done;
    }
    if (fsync(stage.fd) < 0 || git_tx_stage_current(&stage) < 0) {
        free(*output);
        *output = NULL;
        *output_len = 0;
        goto done;
    }
    result = 0;
done:
    saved = errno;
    if (fd >= 0 && close(fd) < 0 && result == 0) { saved = errno; result = -1; }
    git_tx_stage_close(&stage);
    free(target);
    if (result < 0) {
        free(*output);
        *output = NULL;
        *output_len = 0;
        errno = saved;
    }
    return result;
early:
    saved = errno;
    free(target);
    errno = saved;
    return -1;
}

static int git_tx_stage_info(int root_fd, const char *name, const unsigned char *identity,
                             unsigned char **output, size_t *output_len)
{
    char id[GIT_TX_ID_LENGTH + 1], slot[32];
    struct git_tx_stage stage;
    int result = -1, saved;
    if (git_tx_split_slot(name, id, slot) < 0 ||
        git_tx_stage_open(root_fd, id, identity, &stage) < 0) return -1;
    if (git_tx_node_snapshot(stage.fd, slot, &stage.state.mount, output, output_len) < 0)
        goto done;
    if (git_tx_stage_current(&stage) < 0) {
        free(*output);
        *output = NULL;
        *output_len = 0;
        goto done;
    }
    result = 0;
done:
    saved = errno;
    git_tx_stage_close(&stage);
    if (result < 0) errno = saved;
    return result;
}

static int git_tx_stage_delete(int root_fd, const char *name, const unsigned char input[97])
{
    char id[GIT_TX_ID_LENGTH + 1], slot[32];
    struct git_tx_stage stage;
    struct stat proven, named;
    unsigned char kind;
    int result = -1, saved;
    if (git_tx_split_slot(name, id, slot) < 0 ||
        git_tx_stage_open(root_fd, id, input, &stage) < 0) return -1;
    if (git_tx_node_proof(stage.fd, slot, &stage.state.mount, input + 16, input + 32,
                          input[96], 1, &proven) < 0) goto done;
    if (!S_ISDIR(proven.st_mode) && proven.st_nlink != 1) { errno = EMLINK; goto done; }
    if (git_tx_stage_current(&stage) < 0 ||
        git_tx_node_stat(stage.fd, slot, &stage.state.mount, &named, &kind) < 0) goto done;
    if (kind != input[96] || !tree_same_snapshot(&proven, &named)) {
        errno = ESTALE;
        goto done;
    }
    if (unlinkat(stage.fd, slot, kind == 4 ? AT_REMOVEDIR : 0) < 0 ||
        fsync(stage.fd) < 0 || git_tx_stage_current(&stage) < 0) goto done;
    result = 0;
done:
    saved = errno;
    git_tx_stage_close(&stage);
    if (result < 0) errno = saved;
    return result;
}

static int git_tx_stage_remove(int root_fd, const char *id, const unsigned char *identity)
{
    struct git_tx_stage stage;
    int result = -1, saved;
    if (git_tx_stage_open(root_fd, id, identity, &stage) < 0) return -1;
    if (git_tx_empty_directory(stage.fd) < 0 || git_tx_stage_current(&stage) < 0 ||
        unlinkat(stage.state.state, stage.name, AT_REMOVEDIR) < 0 ||
        fsync(stage.state.state) < 0 || git_state_directory_current(&stage.state) < 0) goto done;
    result = 0;
done:
    saved = errno;
    git_tx_stage_close(&stage);
    if (result < 0) errno = saved;
    return result;
}

static int git_tx_absent(int parent, const char *name)
{
    struct stat st;
    if (fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
        errno = EEXIST;
        return -1;
    }
    return errno == ENOENT ? 0 : -1;
}

static int git_tx_sync_pair(int first, int second)
{
    int saved = 0;
    if (fsync(first) < 0) saved = errno;
    if (fsync(second) < 0 && !saved) saved = errno;
    if (saved) { errno = saved; return -1; }
    return 0;
}

static int git_tx_move(int root_fd, const char *name, struct git_tx_request *request,
                       int root_to_stage)
{
    unsigned char data[32 + 16 + 1 + 31 + 16 + 64 + 1];
    char id[GIT_TX_ID_LENGTH + 1], slot[32];
    const unsigned char *node_identity, *fingerprint;
    struct git_tx_root_path path;
    struct git_tx_stage stage;
    uint64_t length = request->remaining;
    size_t slot_length;
    int root_parent, source, destination, result = -1, saved;
    const char *source_name, *destination_name;
    unsigned char kind;
    if (length < 131 || length > sizeof(data)) { errno = EINVAL; return -1; }
    if (git_tx_body_read(request, data, (size_t)length) < 0) return -1;
    slot_length = data[48];
    if (slot_length == 0 || slot_length > 31 || length != 130 + slot_length) {
        errno = EINVAL;
        return -1;
    }
    memcpy(id, data, GIT_TX_ID_LENGTH);
    id[GIT_TX_ID_LENGTH] = '\0';
    memcpy(slot, data + 49, slot_length);
    slot[slot_length] = '\0';
    if (strlen(id) != GIT_TX_ID_LENGTH || strlen(slot) != slot_length ||
        git_tx_valid_id(id) < 0 || git_tx_valid_slot(slot) < 0) {
        errno = EINVAL;
        return -1;
    }
    node_identity = data + 49 + slot_length;
    fingerprint = node_identity + 16;
    kind = fingerprint[64];
    if (kind < 1 || kind > 4) { errno = EINVAL; return -1; }
    if (git_tx_root_path_open(root_fd, name, 0, &path) < 0) return -1;
    if (!path.leaf) { errno = EINVAL; goto path_done; }
    if (git_tx_stage_open(root_fd, id, data + 32, &stage) < 0) goto path_done;
    root_parent = path.fds[path.count - 1];
    if (!tree_same_mount(&path.mount, &stage.state.mount)) { errno = EXDEV; goto done; }
    source = root_to_stage ? root_parent : stage.fd;
    source_name = root_to_stage ? path.leaf : slot;
    destination = root_to_stage ? stage.fd : root_parent;
    destination_name = root_to_stage ? slot : path.leaf;
    if (git_tx_node_proof(source, source_name, &path.mount, node_identity,
                          fingerprint, kind, 1, NULL) < 0 ||
        git_tx_absent(destination, destination_name) < 0 ||
        git_tx_root_path_current(&path) < 0 || git_tx_stage_current(&stage) < 0)
        goto done;
    if (git_state_rename(source, source_name, destination, destination_name, 0) < 0)
        goto done;
    if (git_tx_node_proof(destination, destination_name, &path.mount, node_identity,
                          fingerprint, kind, 1, NULL) < 0 ||
        git_tx_absent(source, source_name) < 0 ||
        git_tx_root_path_current(&path) < 0 || git_tx_stage_current(&stage) < 0)
        goto mismatch;
    /* A failed sync is ambiguous: leave the move for journal recovery. */
    if (git_tx_sync_pair(source, destination) < 0) goto done;
    if (git_tx_root_path_current(&path) < 0 || git_tx_stage_current(&stage) < 0)
        goto done;
    result = 0;
    goto done;
mismatch:
    saved = errno ? errno : ESTALE;
    /* Only a stage slot is protected from ordinary checkout activity. An
     * entry moved into the worktree cannot safely be selected for rollback
     * by name if another checkout may replace it. Never overwrite either end. */
    if (root_to_stage && git_tx_root_path_current(&path) == 0 &&
        git_tx_stage_current(&stage) == 0 && git_tx_absent(root_parent, path.leaf) == 0)
        (void)git_state_rename(stage.fd, slot, root_parent, path.leaf, 0);
    (void)git_tx_sync_pair(source, destination);
    errno = saved;
done:
    saved = errno;
    git_tx_stage_close(&stage);
    errno = saved;
path_done:
    saved = errno;
    git_tx_root_path_close(&path);
    if (result < 0) errno = saved;
    return result;
}


/* The worker separately verifies Git's ref backend and the recorded child PID.
 * The bridge only handles files-backend locks and their exact inode proofs. */
struct git_tx_ref_lock {
    int root_fd;
    const char *name;
    int missing_parent;
    int disabled;
    struct git_tx_root_path path;
    char quarantine[sizeof(".skill-manager-ref-") + 64];
};

struct git_tx_ref_value {
    int location; /* 0 absent, 1 normal lock, 2 quarantine */
    unsigned char *snapshot;
    size_t length;
};

struct git_tx_ref_proof {
    int present;
    const unsigned char *identity;
    const unsigned char *bytes;
    size_t length;
};

static int git_tx_valid_branch(const char *branch)
{
    const char *p, *part = branch;
    if (!*branch || strlen(branch) > GIT_TX_PATH_MAX || git_tx_utf8(branch) < 0) {
        errno = EINVAL;
        return -1;
    }
    for (p = branch;; ++p) {
        unsigned char c = (unsigned char)*p;
        if (!c || c == '/') {
            size_t length = (size_t)(p - part);
            if (!length || *part == '.' ||
                (length >= 5 && !memcmp(p - 5, ".lock", 5)) ||
                (!c && p[-1] == '.')) {
                errno = EINVAL;
                return -1;
            }
            if (!c) return 0;
            part = p + 1;
        } else if (c <= 32 || c == 127 || strchr("~^:?*[\\", c) ||
                   (c == '.' && p[1] == '.') || (c == '@' && p[1] == '{')) {
            errno = EINVAL;
            return -1;
        }
    }
}

static int git_tx_ref_backend(int common_fd)
{
    struct stat st;
    if (fstat(common_fd, &st) < 0) return -1;
    if (!S_ISDIR(st.st_mode)) { errno = ENOTDIR; return -1; }
    if (fstatat(common_fd, "reftable", &st, AT_SYMLINK_NOFOLLOW) == 0) {
        errno = ENOTSUP;
        return -1;
    }
    return errno == ENOENT ? 0 : -1;
}

static int git_tx_ref_lock_open(struct git_tx_ref_lock *lock, int root_fd, const char *name)
{
    struct tree_sha256 hash;
    char digest[65];
    memset(lock, 0, sizeof(*lock));
    lock->root_fd = root_fd;
    lock->name = name;
    tree_sha256_init(&hash);
    tree_sha256_update(&hash, name, strlen(name));
    tree_sha256_hex(&hash, digest);
    memcpy(lock->quarantine, ".skill-manager-ref-", sizeof(".skill-manager-ref-") - 1);
    memcpy(lock->quarantine + sizeof(".skill-manager-ref-") - 1, digest, sizeof(digest));
    if (git_tx_root_path_open(root_fd, name, 0, &lock->path) < 0) {
        if (errno != ENOENT) return -1;
        lock->missing_parent = 1;
    }
    return 0;
}

static void git_tx_ref_lock_close(struct git_tx_ref_lock *lock)
{
    if (!lock->disabled && !lock->missing_parent) git_tx_root_path_close(&lock->path);
}

static void git_tx_ref_value_clear(struct git_tx_ref_value *value)
{
    free(value->snapshot);
    memset(value, 0, sizeof(*value));
}

/* A quarantine is deliberately treated like its original lock. If both
 * names exist neither is touched, even if one happens to have matching bytes. */
static int git_tx_ref_slot_read(struct git_tx_ref_lock *lock, const char *name,
                                unsigned char **snapshot, size_t *length)
{
    struct stat before, after;
    unsigned char kind, after_kind;
    int checked, parent = lock->path.fds[lock->path.count - 1];
    if (git_tx_node_stat(parent, name, &lock->path.mount, &before, &kind) < 0) {
        if (errno == ENOENT) return 0;
        return -1;
    }
    if ((kind != 1 && kind != 2) || before.st_uid != geteuid()) { errno = EPERM; return -1; }
    if (before.st_size < 0 || (uintmax_t)before.st_size > GIT_TX_HEAD_MAX) {
        errno = EFBIG;
        return -1;
    }
    if (git_tx_node_snapshot(parent, name, &lock->path.mount, snapshot, length) < 0)
        return -1;
    checked = git_tx_node_stat(parent, name, &lock->path.mount, &after, &after_kind);
    if (checked == 0) checked = git_tx_root_path_current(&lock->path);
    if (checked < 0 || kind != after_kind || !tree_same_snapshot(&before, &after)) {
        int saved = checked < 0 ? errno : ESTALE;
        free(*snapshot);
        *snapshot = NULL;
        *length = 0;
        errno = saved;
        return -1;
    }
    return 1;
}

static int git_tx_ref_value_read(struct git_tx_ref_lock *lock, struct git_tx_ref_value *value)
{
    unsigned char *normal = NULL, *quarantine = NULL;
    size_t normal_length = 0, quarantine_length = 0;
    int a, b, saved;
    memset(value, 0, sizeof(*value));
    if (lock->disabled) return 0;
    if (lock->missing_parent) {
        if (git_tx_root_path_open(lock->root_fd, lock->name, 0, &lock->path) < 0) {
            if (errno == ENOENT) return 0;
            return -1;
        }
        lock->missing_parent = 0;
    }
    if (git_tx_root_path_current(&lock->path) < 0) return -1;
    a = git_tx_ref_slot_read(lock, lock->path.leaf, &normal, &normal_length);
    if (a < 0) return -1;
    b = git_tx_ref_slot_read(lock, lock->quarantine, &quarantine, &quarantine_length);
    if (b < 0) { saved = errno; free(normal); errno = saved; return -1; }
    if (a && b) {
        free(normal);
        free(quarantine);
        errno = EEXIST;
        return -1;
    }
    if (git_tx_root_path_current(&lock->path) < 0) {
        saved = errno;
        free(normal);
        free(quarantine);
        errno = saved;
        return -1;
    }
    value->location = a ? 1 : b ? 2 : 0;
    value->snapshot = a ? normal : quarantine;
    value->length = a ? normal_length : quarantine_length;
    return 0;
}

static int git_tx_ref_value_matches(const struct git_tx_ref_value *value,
                                    const struct git_tx_ref_proof *proof)
{
    size_t length;
    if (!value->location) return 1; /* A previously proven lock may already be gone. */
    if (!proof->present) return 0;
    length = value->length - GIT_TX_SNAPSHOT_HEADER;
    return length == proof->length && !memcmp(value->snapshot + 5, proof->identity, 16) &&
           !memcmp(value->snapshot + GIT_TX_SNAPSHOT_HEADER, proof->bytes, length);
}

static int git_tx_ref_setup(int git_fd, int common_fd, const char *branch,
                            struct git_tx_ref_lock locks[2], char **refname)
{
    size_t length;
    char *path;
    int saved;
    *refname = NULL;
    if (git_tx_ref_backend(common_fd) < 0) return -1;
    if (!*branch) {
        if (git_tx_ref_lock_open(&locks[0], git_fd, "HEAD.lock") < 0) return -1;
        memset(&locks[1], 0, sizeof(locks[1]));
        locks[1].disabled = 1;
        return 0;
    }
    if (git_tx_valid_branch(branch) < 0) return -1;
    length = strlen(branch);
    if (length > SIZE_MAX - sizeof("refs/heads/") - sizeof(".lock")) {
        errno = EOVERFLOW;
        return -1;
    }
    path = malloc(sizeof("refs/heads/") - 1 + length + sizeof(".lock"));
    if (!path) return -1;
    memcpy(path, "refs/heads/", sizeof("refs/heads/") - 1);
    memcpy(path + sizeof("refs/heads/") - 1, branch, length);
    memcpy(path + sizeof("refs/heads/") - 1 + length, ".lock", sizeof(".lock"));
    if (git_tx_ref_lock_open(&locks[0], git_fd, "HEAD.lock") < 0) {
        saved = errno;
        free(path);
        errno = saved;
        return -1;
    }
    if (git_tx_ref_lock_open(&locks[1], common_fd, path) < 0) {
        saved = errno;
        git_tx_ref_lock_close(&locks[0]);
        free(path);
        errno = saved;
        return -1;
    }
    *refname = path;
    return 0;
}

static void git_tx_ref_cleanup(struct git_tx_ref_lock locks[2], char *refname)
{
    git_tx_ref_lock_close(&locks[1]);
    git_tx_ref_lock_close(&locks[0]);
    free(refname);
}

/* Each record is 0 for absent, otherwise 1 + identity[16] + u64 length + bytes. */
static int git_tx_ref_inspect(int git_fd, int common_fd, const char *branch,
                              unsigned char **output, size_t *output_len)
{
    struct git_tx_ref_lock locks[2];
    struct git_tx_ref_value values[2] = { { 0 }, { 0 } };
    unsigned char *buffer = NULL;
    char *refname;
    size_t size = 2, offset = 0, i;
    int result = -1, saved;
    if (git_tx_ref_setup(git_fd, common_fd, branch, locks, &refname) < 0) return -1;
    for (i = 0; i < 2; ++i) {
        if (git_tx_ref_value_read(&locks[i], &values[i]) < 0) goto done;
        if (values[i].location)
            size += 24 + values[i].length - GIT_TX_SNAPSHOT_HEADER;
    }
    buffer = malloc(size);
    if (!buffer) goto done;
    for (i = 0; i < 2; ++i) {
        size_t length;
        buffer[offset++] = values[i].location ? 1 : 0;
        if (!values[i].location) continue;
        length = values[i].length - GIT_TX_SNAPSHOT_HEADER;
        memcpy(buffer + offset, values[i].snapshot + 5, 16);
        offset += 16;
        git_tx_put64(buffer + offset, (uint64_t)length);
        offset += 8;
        memcpy(buffer + offset, values[i].snapshot + GIT_TX_SNAPSHOT_HEADER, length);
        offset += length;
    }
    *output = buffer;
    *output_len = offset;
    buffer = NULL;
    result = 0;
done:
    saved = errno;
    free(buffer);
    git_tx_ref_value_clear(&values[0]);
    git_tx_ref_value_clear(&values[1]);
    git_tx_ref_cleanup(locks, refname);
    if (result < 0) errno = saved;
    return result;
}

static int git_tx_ref_parse_proofs(const unsigned char *input, size_t length,
                                  struct git_tx_ref_proof proofs[2])
{
    size_t offset = 0, i;
    memset(proofs, 0, 2 * sizeof(*proofs));
    for (i = 0; i < 2; ++i) {
        uint64_t size;
        if (offset >= length) { errno = EINVAL; return -1; }
        proofs[i].present = input[offset++];
        if (!proofs[i].present) continue;
        if (proofs[i].present != 1 || length - offset < 24) { errno = EINVAL; return -1; }
        proofs[i].identity = input + offset;
        offset += 16;
        size = git_tx_get64(input + offset);
        offset += 8;
        if (size > GIT_TX_HEAD_MAX || size > length - offset) { errno = EINVAL; return -1; }
        proofs[i].length = (size_t)size;
        proofs[i].bytes = input + offset;
        offset += (size_t)size;
    }
    if (offset != length) { errno = EINVAL; return -1; }
    return 0;
}

static int git_tx_ref_oid_bytes(const struct git_tx_ref_proof *proof)
{
    size_t i;
    if ((proof->length != 41 && proof->length != 65) ||
        proof->bytes[proof->length - 1] != '\n') return 0;
    for (i = 0; i + 1 < proof->length; ++i) {
        unsigned char c = proof->bytes[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    }
    return 1;
}

static int git_tx_ref_delete_one(struct git_tx_ref_lock *lock,
                                const struct git_tx_ref_proof *proof)
{
    struct git_tx_ref_value value = { 0 };
    int parent, saved, checked;
    if (git_tx_ref_value_read(lock, &value) < 0) return -1;
    if (!git_tx_ref_value_matches(&value, proof)) {
        git_tx_ref_value_clear(&value);
        errno = ESTALE;
        return -1;
    }
    if (!value.location) return 0;
    parent = lock->path.fds[lock->path.count - 1];
    if (value.location == 1) {
        git_tx_ref_value_clear(&value);
        if (git_tx_root_path_current(&lock->path) < 0 ||
            git_state_rename(parent, lock->path.leaf, parent, lock->quarantine, 0) < 0)
            return -1;
        checked = git_tx_ref_value_read(lock, &value);
        if (checked < 0 || value.location != 2 || !git_tx_ref_value_matches(&value, proof)) {
            saved = checked < 0 ? errno : ESTALE;
            git_tx_ref_value_clear(&value);
            if (git_tx_root_path_current(&lock->path) == 0 &&
                git_tx_absent(parent, lock->path.leaf) == 0)
                (void)git_state_rename(parent, lock->quarantine, parent, lock->path.leaf, 0);
            (void)fsync(parent);
            errno = saved;
            return -1;
        }
        git_tx_ref_value_clear(&value);
        /* Recovery can now find the same proven inode at its quarantine name. */
        if (fsync(parent) < 0) return -1;
    } else {
        git_tx_ref_value_clear(&value);
    }
    if (git_tx_ref_value_read(lock, &value) < 0) return -1;
    if (value.location != 2 || !git_tx_ref_value_matches(&value, proof)) {
        git_tx_ref_value_clear(&value);
        errno = ESTALE;
        return -1;
    }
    git_tx_ref_value_clear(&value);
    if (git_tx_root_path_current(&lock->path) < 0 ||
        unlinkat(parent, lock->quarantine, 0) < 0 ||
        fsync(parent) < 0 || git_tx_root_path_current(&lock->path) < 0) return -1;
    return 0;
}

static int git_tx_ref_remove(int git_fd, int common_fd, const char *branch,
                             struct git_tx_request *request)
{
    unsigned char input[2 * (25 + GIT_TX_HEAD_MAX)];
    struct git_tx_ref_proof proofs[2];
    struct git_tx_ref_lock locks[2];
    struct git_tx_ref_value values[2] = { { 0 }, { 0 } };
    char *refname;
    size_t i;
    int result = -1, saved;
    if (request->remaining < 2 || request->remaining > sizeof(input)) {
        errno = EINVAL;
        return -1;
    }
    i = (size_t)request->remaining;
    if (git_tx_body_read(request, input, i) < 0 ||
        git_tx_ref_parse_proofs(input, i, proofs) < 0) return -1;
    if ((*branch && proofs[0].present && proofs[0].length != 0) ||
        (!*branch && proofs[0].present && proofs[0].length != 0 &&
         !git_tx_ref_oid_bytes(&proofs[0])) ||
        (!*branch && proofs[1].present) ||
        (proofs[1].present && proofs[1].length != 0 && !git_tx_ref_oid_bytes(&proofs[1]))) {
        errno = EINVAL;
        return -1;
    }
    if (git_tx_ref_setup(git_fd, common_fd, branch, locks, &refname) < 0) return -1;
    for (i = 0; i < 2; ++i) {
        if (git_tx_ref_value_read(&locks[i], &values[i]) < 0) goto done;
        if (!git_tx_ref_value_matches(&values[i], &proofs[i])) { errno = ESTALE; goto done; }
    }
    git_tx_ref_value_clear(&values[0]);
    git_tx_ref_value_clear(&values[1]);
    for (i = 0; i < 2; ++i) {
        if (git_tx_ref_backend(common_fd) < 0 ||
            git_tx_ref_delete_one(&locks[i], &proofs[i]) < 0) goto done;
    }
    result = 0;
done:
    saved = errno;
    git_tx_ref_value_clear(&values[0]);
    git_tx_ref_value_clear(&values[1]);
    git_tx_ref_cleanup(locks, refname);
    if (result < 0) errno = saved;
    return result;
}
/* A request is {u32 op, u32 name length, u64 data length}, little-endian,
 * followed by name bytes and data. A reply is {u32 native errno, u32 zero,
 * u64 data length}, followed by data. The worker uses a blocking socket. */
static int git_transaction_serve(int git_dir_fd, int rpc_fd, int root_fd,
                                 git_transaction_state_callback state_handler)
{
    struct git_tx_server server;
    struct stat directory;
    int result = -1, saved = 0;
#if defined(SO_NOSIGPIPE)
    int no_sigpipe = 1;
    if (setsockopt(rpc_fd, SOL_SOCKET, SO_NOSIGPIPE,
                   &no_sigpipe, sizeof(no_sigpipe)) < 0) return -1;
#endif
    if (fstat(git_dir_fd, &directory) < 0) return -1;
    if (!S_ISDIR(directory.st_mode)) { errno = ENOTDIR; return -1; }
    memset(&server, 0, sizeof(server));
    server.dirfd = git_dir_fd;
    server.lockfd = -1;
    for (;;) {
        unsigned char header[16], reply_header[16] = { 0 }, small_reply[16];
        unsigned char *response = NULL;
        size_t response_len = 0;
        char short_name[GIT_TX_NAME_MAX + 1], *name = short_name;
        uint32_t op, name_len;
        uint64_t data_len;
        struct git_tx_request request;
        int received, operation = -1, operation_errno = 0, small = 0;
        int worktree, frame_error = 0;

        received = git_tx_recv_exact(rpc_fd, header, sizeof(header), 1);
        if (received == 0) { result = 0; break; }
        if (received < 0) break;
        op = git_tx_get32(header);
        name_len = git_tx_get32(header + 4);
        data_len = git_tx_get64(header + 8);
        worktree = op >= GIT_TX_ROOT_INFO && op <= GIT_TX_REF_LOCK_REMOVE;
        if (!worktree && (name_len > GIT_TX_NAME_MAX || data_len > (uint64_t)INT64_MAX)) {
            errno = EPROTO;
            break;
        }
        if (worktree && data_len > (uint64_t)INT64_MAX) frame_error = EFBIG;
        if (name_len > ((op == GIT_TX_ROOT_INFO || op == GIT_TX_ROOT_LIST ||
                         op == GIT_TX_ROOT_TO_STAGE || op == GIT_TX_STAGE_TO_ROOT ||
                         op == GIT_TX_REF_LOCK_INSPECT || op == GIT_TX_REF_LOCK_REMOVE) ?
                        GIT_TX_PATH_MAX : GIT_TX_NAME_MAX))
            frame_error = ENAMETOOLONG;
        if (!frame_error && name_len > GIT_TX_NAME_MAX) {
            name = malloc((size_t)name_len + 1);
            if (!name) frame_error = ENOMEM;
        }
        if (frame_error) {
            request.fd = rpc_fd;
            request.failed = 0;
            request.remaining = name_len;
            if (git_tx_body_drain(&request) < 0) break;
            request.remaining = data_len;
            if (git_tx_body_drain(&request) < 0) break;
            git_tx_put32(reply_header, (uint32_t)frame_error);
            if (git_tx_send_all(rpc_fd, reply_header, sizeof(reply_header)) < 0) break;
            continue;
        }
        if (name_len && git_tx_recv_exact(rpc_fd, name, name_len, 0) < 0) {
            if (name != short_name) free(name);
            break;
        }
        name[name_len] = '\0';
        request.fd = rpc_fd;
        request.remaining = data_len;
        request.failed = 0;
        errno = 0;
        if (strlen(name) != name_len) {
            errno = EINVAL;
        } else if (op == GIT_TX_INDEX_READ && name_len == 0 && data_len == 0) {
            operation = git_tx_read_file(&server, "index", 0, 0, NULL, &response, &response_len);
        } else if (op == GIT_TX_HEAD_READ && name_len == 0 && data_len == 0) {
            operation = git_tx_read_file(&server, "HEAD", 0, GIT_TX_HEAD_MAX,
                                         NULL, &response, &response_len);
        } else if (op == GIT_TX_LOCK_CREATE && name_len != 0 && data_len == 0) {
            operation = git_tx_lock_create(&server, name, small_reply);
            if (operation == 0) { response = small_reply; response_len = 16; small = 1; }
        } else if (op == GIT_TX_LOCK_ADOPT && name_len != 0 && data_len == 16) {
            unsigned char identity[16];
            if (git_tx_body_read(&request, identity, sizeof(identity)) == 0) {
                operation = git_tx_lock_adopt(&server, name, identity, small_reply);
                if (operation == 0) { response = small_reply; response_len = 1; small = 1; }
            }
        } else if (op == GIT_TX_LOCK_ACQUIRE && name_len == 0 && data_len == 0) {
            operation = git_tx_lock_acquire(&server);
        } else if (op == GIT_TX_LOCK_WRITE && name_len == 0) {
            operation = git_tx_lock_write(&server, &request, data_len);
        } else if (op == GIT_TX_LOCK_COMMIT && name_len == 0 && data_len == 0) {
            operation = git_tx_lock_commit(&server);
        } else if (op == GIT_TX_LOCK_ABORT && name_len == 0 && data_len == 0) {
            operation = git_tx_lock_abort(&server);
        } else if (op == GIT_TX_LOCK_REMOVE_INDEX && name_len == 0 && data_len == 0) {
            operation = git_tx_lock_remove_index(&server);
        } else if (op == GIT_TX_PRIVATE_READ && name_len != 0 &&
                   (data_len == 0 || data_len == 16)) {
            unsigned char identity[16];
            if (data_len == 0 || git_tx_body_read(&request, identity, sizeof(identity)) == 0)
                operation = git_tx_read_file(&server, name, 1, 0,
                                             data_len ? identity : NULL,
                                             &response, &response_len);
        } else if (op == GIT_TX_PRIVATE_PUT && name_len != 0) {
            operation = git_tx_private_put(&server, name, &request, small_reply);
            if (operation == 0) { response = small_reply; response_len = 16; small = 1; }
        } else if (op == GIT_TX_PRIVATE_STAT && name_len != 0 && data_len == 0) {
            operation = git_tx_private_identity(&server, name, small_reply);
            if (operation == 0) { response = small_reply; response_len = 16; small = 1; }
        } else if (op == GIT_TX_PRIVATE_DELETE && name_len != 0 && data_len == 16) {
            unsigned char identity[16];
            if (git_tx_body_read(&request, identity, sizeof(identity)) == 0)
                operation = git_tx_private_delete(&server, name, identity);
        } else if (op == GIT_TX_PRIVATE_LIST && name_len == 0 && data_len == 0) {
            operation = git_tx_private_list(&server, &response, &response_len);
        } else if (op == GIT_TX_ROOT_INFO && data_len == 0) {
            operation = git_tx_root_info(root_fd, name, &response, &response_len);
        } else if (op == GIT_TX_ROOT_LIST && data_len == 0) {
            operation = git_tx_root_list(root_fd, name, &response, &response_len);
        } else if (op == GIT_TX_STAGE_CREATE && name_len != 0 && data_len == 0) {
            operation = git_tx_stage_create(root_fd, name, small_reply);
            if (operation == 0) { response = small_reply; response_len = 16; small = 1; }
        } else if (op == GIT_TX_STAGE_PUT && name_len != 0 && data_len >= 17) {
            operation = git_tx_stage_put(root_fd, name, &request, &response, &response_len);
        } else if ((op == GIT_TX_STAGE_INFO || op == GIT_TX_STAGE_REMOVE) &&
                   name_len != 0 && data_len == 16) {
            unsigned char identity[16];
            if (git_tx_body_read(&request, identity, sizeof(identity)) == 0) {
                if (op == GIT_TX_STAGE_INFO)
                    operation = git_tx_stage_info(root_fd, name, identity, &response, &response_len);
                else
                    operation = git_tx_stage_remove(root_fd, name, identity);
            }
        } else if ((op == GIT_TX_ROOT_TO_STAGE || op == GIT_TX_STAGE_TO_ROOT) &&
                   name_len != 0) {
            operation = git_tx_move(root_fd, name, &request, op == GIT_TX_ROOT_TO_STAGE);
        } else if (op == GIT_TX_STAGE_DELETE && name_len != 0 && data_len == 97) {
            unsigned char input[97];
            if (git_tx_body_read(&request, input, sizeof(input)) == 0)
                operation = git_tx_stage_delete(root_fd, name, input);
        } else if (op == GIT_TX_REF_LOCK_INSPECT && data_len == 0) {
            operation = git_tx_ref_inspect(git_dir_fd, 5, name, &response, &response_len);
        } else if (op == GIT_TX_REF_LOCK_REMOVE) {
            operation = git_tx_ref_remove(git_dir_fd, 5, name, &request);
        } else if (((op >= GIT_TX_STATE_READ && op <= GIT_TX_STATE_DELETE) ||
                    (op >= GIT_TX_STATE_TEMP_READ && op <= GIT_TX_STATE_DELETE_FINISH)) &&
                   name_len == 0 && state_handler &&
                   ((op == GIT_TX_STATE_PUT && data_len <= GIT_TX_STATE_MAX) ||
                    (op != GIT_TX_STATE_PUT && data_len == 0))) {
            unsigned char *input = NULL;
            if (data_len != 0) input = malloc((size_t)data_len);
            if (data_len != 0 && !input) {
                operation = -1;
            } else if (git_tx_body_read(&request, input, (size_t)data_len) == 0) {
                operation = state_handler(root_fd, op, input, (size_t)data_len,
                                          &response, &response_len);
            }
            saved = errno;
            free(input);
            errno = saved;
        } else {
            errno = EINVAL;
        }
        saved = errno;
        if (name != short_name) free(name);
        errno = saved;
        if (operation < 0) operation_errno = errno ? errno : EIO;
        if (request.failed || git_tx_body_drain(&request) < 0) {
            if (!small) free(response);
            break;
        }
        if (operation_errno) {
            if (!small) free(response);
            response = NULL;
            response_len = 0;
        }
        git_tx_put32(reply_header, (uint32_t)operation_errno);
        git_tx_put64(reply_header + 8, (uint64_t)response_len);
        if (git_tx_send_all(rpc_fd, reply_header, sizeof(reply_header)) < 0 ||
            (response_len && git_tx_send_all(rpc_fd, response, response_len) < 0)) {
            if (!small) free(response);
            break;
        }
        if (!small) free(response);
    }
    saved = errno;
    /* A crash or disconnect must leave a linked lock and its proof for the
     * journal-driven recovery path, not silently undo a ref transaction. */
    git_tx_forget_lock(&server);
    errno = saved;
    return result;
}

#endif
