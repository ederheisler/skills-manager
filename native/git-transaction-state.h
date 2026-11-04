#ifndef SKILLS_GIT_TRANSACTION_STATE_H
#define SKILLS_GIT_TRANSACTION_STATE_H

/* The caller pins the approved root and holds the manager's installation lock.
 * Only the three reserved journal names in the already-owned state are touched. */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#elif defined(__APPLE__)
#include <sys/stdio.h>
#else
#error Unsupported operating system
#endif

#define GIT_STATE_JOURNAL "git-transaction-journal"
#define GIT_STATE_TEMP "git-transaction-journal.next"
#define GIT_STATE_DELETE_STAGE "git-transaction-journal.delete"
#define GIT_STATE_OWNER "skills-manager-owned-state-v1\n"
#define GIT_STATE_MAGIC "skills-manager-git-journal-v1\n"
#define GIT_STATE_MAX_BODY (1024U * 1024U)
#define GIT_STATE_HEADER_SIZE ((sizeof(GIT_STATE_MAGIC) - 1U) + 16U + 1U + 64U + 1U)

enum {
    GIT_STATE_READ = 13, GIT_STATE_PUT = 14, GIT_STATE_DELETE = 15,
    GIT_STATE_TEMP_READ = 18, GIT_STATE_TEMP_DELETE = 19,
    GIT_STATE_DELETE_READ = 20, GIT_STATE_DELETE_FINISH = 21
};

struct git_state_directory {
    int root;
    int state;
    struct stat root_stat;
    struct stat state_stat;
    struct tree_mount mount;
};

struct git_state_value {
    struct stat stat;
    unsigned char *body;
    size_t size;
    char digest[65];
};

/* One bridge process serves one worker while the outer installation lock is held. */
static struct {
    int valid;
    int present;
    struct stat root_stat;
    struct stat state_stat;
    struct stat value_stat;
    char digest[65];
} git_state_observed;

struct git_state_stage_snapshot {
    int valid;
    struct stat root_stat;
    struct stat state_stat;
    struct stat value_stat;
    char digest[65];
};
static struct git_state_stage_snapshot git_state_temp_observed, git_state_delete_observed;

static int git_state_owned_stat(const struct stat *st)
{
    if (!S_ISREG(st->st_mode) || st->st_uid != geteuid() || st->st_nlink != 1 ||
        (st->st_mode & 0777) != 0600) {
        errno = EPERM;
        return -1;
    }
    return 0;
}

static int git_state_write_all(int fd, const void *data, size_t size)
{
    const unsigned char *p = data;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) { errno = EIO; return -1; }
        p += (size_t)n;
        size -= (size_t)n;
    }
    return 0;
}

static int git_state_read_all(int fd, void *data, size_t size)
{
    unsigned char *p = data;
    while (size) {
        ssize_t n = read(fd, p, size);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) { errno = ESTALE; return -1; }
        p += (size_t)n;
        size -= (size_t)n;
    }
    return 0;
}

static int git_state_named_identity(struct git_state_directory *dir,
                                    const char *name, const struct stat *expected)
{
    struct stat current;
    if (fstatat(dir->state, name, &current, AT_SYMLINK_NOFOLLOW) < 0 ||
        git_state_owned_stat(&current) < 0 ||
        tree_check_mount_entry(dir->state, name, &current, &dir->mount) < 0) return -1;
    if (!tree_same_identity(expected, &current)) { errno = ESTALE; return -1; }
    return 0;
}

static int git_state_directory_current(struct git_state_directory *dir)
{
    struct stat root, held, named;
    if (fstat(dir->root, &root) < 0 || fstat(dir->state, &held) < 0 ||
        fstatat(dir->root, ".skills-manager", &named, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_fd(dir->state, &dir->mount) < 0 ||
        tree_check_mount_entry(dir->root, ".skills-manager", &named, &dir->mount) < 0) return -1;
    if (!tree_same_identity(&dir->root_stat, &root) ||
        !tree_same_identity(&dir->state_stat, &held) || !tree_same_identity(&held, &named) ||
        held.st_uid != geteuid() || (held.st_mode & 0777) != 0700) {
        errno = ESTALE;
        return -1;
    }
    return 0;
}

static int git_state_check_control_file(struct git_state_directory *dir,
                                        const char *name, int marker)
{
    struct stat before, opened, after;
    int fd = -1, saved, result = -1;
    char bytes[sizeof(GIT_STATE_OWNER) - 1U];
    if (fstatat(dir->state, name, &before, AT_SYMLINK_NOFOLLOW) < 0 ||
        git_state_owned_stat(&before) < 0 ||
        tree_check_mount_entry(dir->state, name, &before, &dir->mount) < 0) return -1;
    fd = openat(dir->state, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    if (fstat(fd, &opened) < 0 || tree_check_mount_fd(fd, &dir->mount) < 0) goto done;
    if (!tree_same_snapshot(&before, &opened)) { errno = ESTALE; goto done; }
    if (marker) {
        if (opened.st_size != (off_t)sizeof(bytes) || git_state_read_all(fd, bytes, sizeof(bytes)) < 0 ||
            memcmp(bytes, GIT_STATE_OWNER, sizeof(bytes)) != 0) { errno = EPERM; goto done; }
    }
    if (fstat(fd, &after) < 0 || git_state_named_identity(dir, name, &opened) < 0) goto done;
    if (!tree_same_snapshot(&opened, &after)) { errno = ESTALE; goto done; }
    result = 0;
done:
    saved = errno;
    close(fd);
    if (result < 0) errno = saved;
    return result;
}

static int git_state_open(int root_fd, struct git_state_directory *dir)
{
    int saved;
    memset(dir, 0, sizeof(*dir));
    dir->root = root_fd;
    dir->state = -1;
    if (fstat(root_fd, &dir->root_stat) < 0) return -1;
    if (!S_ISDIR(dir->root_stat.st_mode)) { errno = ENOTDIR; return -1; }
    if (tree_mount_fd(root_fd, &dir->mount) < 0) return -1;
    dir->state = openat(root_fd, ".skills-manager", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dir->state < 0) { if (errno == ENOENT) errno = ESTALE; return -1; }
    if (fstat(dir->state, &dir->state_stat) < 0) goto invalid;
    if (!S_ISDIR(dir->state_stat.st_mode) || dir->state_stat.st_uid != geteuid() ||
        (dir->state_stat.st_mode & 0777) != 0700) { errno = EPERM; goto invalid; }
    if (tree_check_mount_fd(dir->state, &dir->mount) < 0 ||
        git_state_directory_current(dir) < 0 ||
        git_state_check_control_file(dir, "owner", 1) < 0 ||
        git_state_check_control_file(dir, "lock", 0) < 0) {
invalid:
        saved = errno == ENOENT ? ESTALE : errno;
        close(dir->state);
        dir->state = -1;
        errno = saved;
        return -1;
    }
    return 0;
}

static void git_state_digest(const unsigned char *bytes, size_t size, char out[65])
{
    struct tree_sha256 hash;
    tree_sha256_init(&hash);
    tree_sha256_update(&hash, bytes, size);
    tree_sha256_hex(&hash, out);
}

/* Journal bytes on disk have a fixed marker, length and digest. This lets
 * recovery distinguish a complete manager staging file from an unknown
 * collision, including the old journal displaced by an atomic exchange. */
static int git_state_unpack(struct git_state_value *value, size_t total)
{
    const size_t magic = sizeof(GIT_STATE_MAGIC) - 1U;
    uint64_t body_size = 0;
    char actual[65];
    size_t i;
    if (total < GIT_STATE_HEADER_SIZE || memcmp(value->body, GIT_STATE_MAGIC, magic) != 0 ||
        value->body[magic + 16U] != '\n' || value->body[magic + 16U + 1U + 64U] != '\n') {
        errno = EBADMSG;
        return -1;
    }
    for (i = 0; i < 16U; ++i) {
        unsigned char c = value->body[magic + i];
        unsigned int digit;
        if (c >= '0' && c <= '9') digit = (unsigned int)(c - '0');
        else if (c >= 'a' && c <= 'f') digit = (unsigned int)(c - 'a' + 10);
        else { errno = EBADMSG; return -1; }
        body_size = (body_size << 4) | digit;
    }
    if (!body_size || body_size > GIT_STATE_MAX_BODY ||
        body_size != total - GIT_STATE_HEADER_SIZE) { errno = EBADMSG; return -1; }
    for (i = 0; i < 64U; ++i) {
        unsigned char c = value->body[magic + 17U + i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) { errno = EBADMSG; return -1; }
    }
    git_state_digest(value->body + GIT_STATE_HEADER_SIZE, (size_t)body_size, actual);
    if (memcmp(actual, value->body + magic + 17U, 64U) != 0) { errno = EBADMSG; return -1; }
    memmove(value->body, value->body + GIT_STATE_HEADER_SIZE, (size_t)body_size);
    value->size = (size_t)body_size;
    memcpy(value->digest, actual, sizeof(value->digest));
    return 0;
}

static int git_state_read_value(struct git_state_directory *dir, const char *name,
                                struct git_state_value *value)
{
    struct stat before, opened, after, named;
    int fd = -1, result = -1, saved;
    size_t size;
    memset(value, 0, sizeof(*value));
    if (fstatat(dir->state, name, &before, AT_SYMLINK_NOFOLLOW) < 0 ||
        git_state_owned_stat(&before) < 0 ||
        tree_check_mount_entry(dir->state, name, &before, &dir->mount) < 0) return -1;
    if (before.st_size < 0 || (uintmax_t)before.st_size > GIT_STATE_MAX_BODY + GIT_STATE_HEADER_SIZE) {
        errno = EFBIG;
        return -1;
    }
    fd = openat(dir->state, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { if (errno == ENOENT) errno = ESTALE; return -1; }
    if (fstat(fd, &opened) < 0 || tree_check_mount_fd(fd, &dir->mount) < 0) goto done;
    if (!tree_same_snapshot(&before, &opened)) { errno = ESTALE; goto done; }
    size = (size_t)before.st_size;
    value->body = malloc(size ? size : 1U);
    if (!value->body || git_state_read_all(fd, value->body, size) < 0) goto done;
    if (fstat(fd, &after) < 0 || fstatat(dir->state, name, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_entry(dir->state, name, &named, &dir->mount) < 0) {
        if (errno == ENOENT) errno = ESTALE;
        goto done;
    }
    if (!tree_same_snapshot(&before, &after) || !tree_same_snapshot(&after, &named)) {
        errno = ESTALE;
        goto done;
    }
    value->stat = after;
    if (git_state_unpack(value, size) < 0) goto done;
    result = 0;
done:
    saved = errno;
    if (fd >= 0) close(fd);
    if (result < 0) { free(value->body); value->body = NULL; errno = saved; }
    return result;
}

static void git_state_remember(struct git_state_directory *dir,
                               const struct git_state_value *value)
{
    git_state_observed.valid = 1;
    git_state_observed.present = value != NULL;
    git_state_observed.root_stat = dir->root_stat;
    git_state_observed.state_stat = dir->state_stat;
    if (value) {
        git_state_observed.value_stat = value->stat;
        memcpy(git_state_observed.digest, value->digest, sizeof(value->digest));
    }
}

static int git_state_check_baseline(struct git_state_directory *dir)
{
    struct git_state_value current;
    int result, saved;
    if (!git_state_observed.valid ||
        !tree_same_identity(&git_state_observed.root_stat, &dir->root_stat) ||
        !tree_same_identity(&git_state_observed.state_stat, &dir->state_stat) ||
        git_state_directory_current(dir) < 0) { errno = ESTALE; return -1; }
    result = git_state_read_value(dir, GIT_STATE_JOURNAL, &current);
    saved = errno;
    if (result < 0) {
        if (saved == ENOENT && !git_state_observed.present) return 0;
        errno = saved == ENOENT ? ESTALE : saved;
        return -1;
    }
    result = git_state_observed.present &&
        tree_same_snapshot(&git_state_observed.value_stat, &current.stat) &&
        strcmp(git_state_observed.digest, current.digest) == 0 ? 0 : -1;
    free(current.body);
    if (result < 0) errno = ESTALE;
    return result;
}

static int git_state_rename(int from, const char *old_name, int to,
                            const char *new_name, int exchange)
{
#if defined(__APPLE__)
    int result = renameatx_np(from, old_name, to, new_name, exchange ? RENAME_SWAP : RENAME_EXCL);
#elif defined(SYS_renameat2)
    int result = (int)syscall(SYS_renameat2, from, old_name, to, new_name,
                              exchange ? RENAME_EXCHANGE : RENAME_NOREPLACE);
#else
    (void)from; (void)old_name; (void)to; (void)new_name; (void)exchange;
    errno = ENOTSUP;
    return -1;
#endif
#if defined(__APPLE__) || defined(SYS_renameat2)
    if (result < 0 && (errno == ENOSYS || errno == EOPNOTSUPP || errno == EINVAL)) errno = ENOTSUP;
    return result;
#endif
}

static int git_state_discard_known(struct git_state_directory *dir, const char *name,
                                   const struct stat *expected, int check_snapshot)
{
    struct stat current;
    if (git_state_directory_current(dir) < 0 || git_state_named_identity(dir, name, expected) < 0 ||
        fstatat(dir->state, name, &current, AT_SYMLINK_NOFOLLOW) < 0 ||
        tree_check_mount_entry(dir->state, name, &current, &dir->mount) < 0) return -1;
    if (!tree_same_identity(expected, &current) ||
        (check_snapshot && !tree_same_snapshot(expected, &current))) { errno = ESTALE; return -1; }
    if (unlinkat(dir->state, name, 0) < 0 || fsync(dir->state) < 0) return -1;
    return 0;
}

static int git_state_moved_matches(const struct git_state_value *value,
                                   const struct stat *expected, const char *digest)
{
    return tree_same_identity(&value->stat, expected) &&
        value->stat.st_mode == expected->st_mode && value->stat.st_uid == expected->st_uid &&
        value->stat.st_gid == expected->st_gid && value->stat.st_nlink == expected->st_nlink &&
        value->stat.st_size == expected->st_size && strcmp(value->digest, digest) == 0;
}

static int git_state_read_request(struct git_state_directory *dir,
                                  unsigned char **output, size_t *output_len)
{
    struct git_state_value journal;
    int has_journal = 0, saved;
    git_state_observed.valid = 0;
    if (git_state_read_value(dir, GIT_STATE_JOURNAL, &journal) == 0) has_journal = 1;
    else if (errno != ENOENT) return -1;
    if (git_state_directory_current(dir) < 0) {
        saved = errno;
        if (has_journal) free(journal.body);
        errno = saved;
        return -1;
    }
    git_state_remember(dir, has_journal ? &journal : NULL);
    if (!has_journal) { errno = ENOENT; return -1; }
    *output = journal.body;
    *output_len = journal.size;
    return 0;
}

/* The worker validates the returned staging JSON and repository binding before
 * asking to remove it. A marker alone is never permission to delete it. */
static int git_state_stage_read_request(struct git_state_directory *dir, const char *name,
                                        struct git_state_stage_snapshot *observed,
                                        unsigned char **output, size_t *output_len)
{
    struct git_state_value temporary;
    int saved;
    observed->valid = 0;
    if (git_state_read_value(dir, name, &temporary) < 0) return -1;
    if (git_state_directory_current(dir) < 0) {
        saved = errno;
        free(temporary.body);
        errno = saved;
        return -1;
    }
    observed->valid = 1;
    observed->root_stat = dir->root_stat;
    observed->state_stat = dir->state_stat;
    observed->value_stat = temporary.stat;
    memcpy(observed->digest, temporary.digest, sizeof(temporary.digest));
    *output = temporary.body;
    *output_len = temporary.size;
    return 0;
}

static int git_state_require_absent(struct git_state_directory *dir, const char *name)
{
    struct stat st;
    if (fstatat(dir->state, name, &st, AT_SYMLINK_NOFOLLOW) == 0) { errno = EBUSY; return -1; }
    return errno == ENOENT ? 0 : -1;
}

static int git_state_stage_delete_request(struct git_state_directory *dir, const char *name,
                                          const char *other_name,
                                          struct git_state_stage_snapshot *observed)
{
    struct git_state_value temporary;
    int matches, saved;
    if (!observed->valid ||
        !tree_same_identity(&observed->root_stat, &dir->root_stat) ||
        !tree_same_identity(&observed->state_stat, &dir->state_stat)) {
        errno = ESTALE;
        return -1;
    }
    if (git_state_check_baseline(dir) < 0 || git_state_require_absent(dir, other_name) < 0) return -1;
    if (!strcmp(name, GIT_STATE_DELETE_STAGE) && git_state_observed.present) {
        errno = EBUSY;
        return -1;
    }
    if (git_state_read_value(dir, name, &temporary) < 0) {
        if (errno == ENOENT) errno = ESTALE;
        return -1;
    }
    matches = tree_same_snapshot(&observed->value_stat, &temporary.stat) &&
        strcmp(observed->digest, temporary.digest) == 0;
    if (!matches) { free(temporary.body); errno = ESTALE; return -1; }
    int result = git_state_discard_known(dir, name, &temporary.stat, 1);
    saved = errno;
    free(temporary.body);
    observed->valid = 0;
    errno = saved;
    return result;
}

static int git_state_write_request(struct git_state_directory *dir,
                                   const unsigned char *input, size_t input_len)
{
    struct git_state_value displaced, installed;
    struct stat created, displaced_stat;
    struct tree_sha256 hash;
    char digest[65], header[GIT_STATE_HEADER_SIZE + 1U];
    int fd = -1, saved, result = -1, published = 0, staged_known = 0;
    if (!input || !input_len || input_len > GIT_STATE_MAX_BODY || memchr(input, 0, input_len)) {
        errno = EINVAL;
        return -1;
    }
    if (git_state_check_baseline(dir) < 0 || git_state_require_absent(dir, GIT_STATE_DELETE_STAGE) < 0) return -1;
    tree_sha256_init(&hash);
    tree_sha256_update(&hash, input, input_len);
    tree_sha256_hex(&hash, digest);
    if (snprintf(header, sizeof(header), "%s%016" PRIx64 "\n%s\n",
                 GIT_STATE_MAGIC, (uint64_t)input_len, digest) != (int)GIT_STATE_HEADER_SIZE) {
        errno = EINVAL;
        return -1;
    }
    fd = openat(dir->state, GIT_STATE_TEMP, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    if (fstat(fd, &created) < 0) goto done;
    staged_known = 1;
    if (fchmod(fd, 0600) < 0 || git_state_write_all(fd, header, GIT_STATE_HEADER_SIZE) < 0 ||
        git_state_write_all(fd, input, input_len) < 0 || fsync(fd) < 0 ||
        fstat(fd, &created) < 0 || git_state_owned_stat(&created) < 0 ||
        tree_check_mount_fd(fd, &dir->mount) < 0 ||
        git_state_named_identity(dir, GIT_STATE_TEMP, &created) < 0 ||
        git_state_directory_current(dir) < 0 || git_state_check_baseline(dir) < 0) goto done;
    if (git_state_rename(dir->state, GIT_STATE_TEMP, dir->state, GIT_STATE_JOURNAL,
                         git_state_observed.present) < 0) goto done;
    published = 1;
    if (git_state_observed.present) {
        if (git_state_read_value(dir, GIT_STATE_TEMP, &displaced) < 0) goto rollback;
        int matches = git_state_moved_matches(&displaced, &git_state_observed.value_stat,
                                              git_state_observed.digest);
        displaced_stat = displaced.stat;
        free(displaced.body);
        if (!matches) { errno = ESTALE; goto rollback; }
    }
    if (git_state_read_value(dir, GIT_STATE_JOURNAL, &installed) < 0) goto rollback;
    if (!git_state_moved_matches(&installed, &created, digest)) {
        free(installed.body);
        errno = ESTALE;
        goto rollback;
    }
    if (git_state_directory_current(dir) < 0 || fsync(dir->state) < 0) {
        saved = errno; free(installed.body); errno = saved; goto done;
    }
    if (git_state_observed.present &&
        git_state_discard_known(dir, GIT_STATE_TEMP, &displaced_stat, 1) < 0) {
        saved = errno; free(installed.body); errno = saved; goto done;
    }
    git_state_remember(dir, &installed);
    free(installed.body);
    result = 0;
    goto done;
rollback:
    saved = errno;
    if (git_state_named_identity(dir, GIT_STATE_JOURNAL, &created) == 0) {
        if (git_state_observed.present) {
            if (git_state_rename(dir->state, GIT_STATE_TEMP, dir->state, GIT_STATE_JOURNAL, 1) == 0 &&
                fsync(dir->state) == 0) published = 0;
        } else if (git_state_rename(dir->state, GIT_STATE_JOURNAL, dir->state, GIT_STATE_TEMP, 0) == 0 &&
                   fsync(dir->state) == 0) published = 0;
    }
    errno = saved;
done:
    saved = errno;
    if (fd >= 0) close(fd);
    if (result < 0 && staged_known && !published &&
        git_state_discard_known(dir, GIT_STATE_TEMP, &created, 0) < 0 && errno != ENOENT) {
        git_state_observed.valid = 0;
        return -1;
    }
    if (result < 0) { git_state_observed.valid = 0; errno = saved; }
    return result;
}

static int git_state_delete_request(struct git_state_directory *dir)
{
    struct git_state_value displaced;
    int saved;
    if (git_state_check_baseline(dir) < 0) return -1;
    if (!git_state_observed.present) { errno = ENOENT; return -1; }
    if (git_state_require_absent(dir, GIT_STATE_TEMP) < 0 || git_state_directory_current(dir) < 0 ||
        git_state_rename(dir->state, GIT_STATE_JOURNAL, dir->state, GIT_STATE_DELETE_STAGE, 0) < 0) return -1;
    if (git_state_read_value(dir, GIT_STATE_DELETE_STAGE, &displaced) < 0) goto rollback;
    int matches = git_state_moved_matches(&displaced, &git_state_observed.value_stat,
                                          git_state_observed.digest);
    free(displaced.body);
    if (!matches) { errno = ESTALE; goto rollback; }
    if (git_state_directory_current(dir) < 0 || fsync(dir->state) < 0 ||
        git_state_discard_known(dir, GIT_STATE_DELETE_STAGE, &displaced.stat, 1) < 0) {
        git_state_observed.valid = 0;
        return -1;
    }
    git_state_remember(dir, NULL);
    return 0;
rollback:
    saved = errno;
    if (git_state_rename(dir->state, GIT_STATE_DELETE_STAGE, dir->state, GIT_STATE_JOURNAL, 0) == 0)
        (void)fsync(dir->state);
    git_state_observed.valid = 0;
    errno = saved;
    return -1;
}

static int git_transaction_state_handler(int root_fd, uint32_t op,
                                         const unsigned char *input, size_t input_len,
                                         unsigned char **output, size_t *output_len)
{
    struct git_state_directory dir;
    int result, saved;
    if (!output || !output_len) { errno = EINVAL; return -1; }
    *output = NULL;
    *output_len = 0;
    if (op != GIT_STATE_PUT && input_len != 0) {
        errno = EINVAL;
        return -1;
    }
    if (op != GIT_STATE_READ && op != GIT_STATE_PUT && op != GIT_STATE_DELETE &&
        op != GIT_STATE_TEMP_READ && op != GIT_STATE_TEMP_DELETE &&
        op != GIT_STATE_DELETE_READ && op != GIT_STATE_DELETE_FINISH) {
        errno = EINVAL;
        return -1;
    }
    if (git_state_open(root_fd, &dir) < 0) return -1;
    if (op == GIT_STATE_READ) result = git_state_read_request(&dir, output, output_len);
    else if (op == GIT_STATE_PUT) result = git_state_write_request(&dir, input, input_len);
    else if (op == GIT_STATE_DELETE) result = git_state_delete_request(&dir);
    else if (op == GIT_STATE_TEMP_READ)
        result = git_state_stage_read_request(&dir, GIT_STATE_TEMP, &git_state_temp_observed, output, output_len);
    else if (op == GIT_STATE_TEMP_DELETE)
        result = git_state_stage_delete_request(&dir, GIT_STATE_TEMP, GIT_STATE_DELETE_STAGE, &git_state_temp_observed);
    else if (op == GIT_STATE_DELETE_READ)
        result = git_state_stage_read_request(&dir, GIT_STATE_DELETE_STAGE, &git_state_delete_observed, output, output_len);
    else result = git_state_stage_delete_request(&dir, GIT_STATE_DELETE_STAGE, GIT_STATE_TEMP, &git_state_delete_observed);
    saved = errno;
    close(dir.state);
    errno = saved;
    return result;
}
#endif
