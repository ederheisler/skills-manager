#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/param.h>
#ifdef __APPLE__
#include <sys/random.h>
#include <sys/stdio.h>
#else
#include <sys/syscall.h>
#include <linux/fs.h>
#endif
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <dirent.h>

#include "tree.h"
#include "identity.h"
#include "containment.h"

/* Identity is shared with the Git boundary. */

#define STATE ".skills-manager"
#define DISABLED ".disabled_skills"
#define MARKER "skills-manager-owned-state-v1\n"
#define JOURNAL_MAGIC "SMJNL01"
#define MAX_COMMAND (2 * 1024 * 1024 + 8192)
#define HASH_LENGTH 64

enum { J_TOGGLE = 1, J_REMOVE = 2, J_IMPORT = 3 };
enum { LOC_ACTIVE = 1, LOC_DISABLED = 2 };
enum { PHASE_INTENT = 1, PHASE_COMMITTED = 2 };

/* The journal is private, versioned state. Every transition is flushed before
 * the next filesystem change. Only one transaction exists under the flock. */
typedef struct {
    char magic[8];
    uint32_t type, location, phase, had_meta, want_meta;
    uint64_t old_dev, old_ino, new_dev, new_ino;
    uint64_t old_meta_dev, old_meta_ino, new_meta_dev, new_meta_ino;
    char name[256];
    char old_hash[65], new_hash[65];
} Journal;

typedef struct { int root, state, lock; struct tree_mount mount; } Context;
static char detail[512];

static int fail(const char *what) {
    int saved = errno;
#ifdef SKILLS_MANAGER_TEST_FAULTS
    const char *injected = getenv("SKILLS_BOUNDARY_FAULT");
    if (saved == EIO && injected && !strcmp(injected, "rename")) {
        snprintf(detail, sizeof(detail), "%s (injected rename): %s", what, strerror(saved));
    } else {
        snprintf(detail, sizeof(detail), "%s: %s", what, strerror(saved));
    }
#else
    snprintf(detail, sizeof(detail), "%s: %s", what, strerror(saved));
#endif
    errno = saved;
    return -1;
}

#ifdef SKILLS_MANAGER_TEST_FAULTS
static void fault(const char *point) {
    const char *requested = getenv("SKILLS_BOUNDARY_FAULT");
    if (requested && strcmp(requested, point) == 0) _exit(86);
}

static int fault_failure(const char *point) {
    const char *requested = getenv("SKILLS_BOUNDARY_FAULT");
    if (requested && !strcmp(requested, point)) { errno = EIO; return -1; }
    return 0;
}
#else
static void fault(const char *point) { (void)point; }
static int fault_failure(const char *point) { (void)point; return 0; }
#endif

static int write_all(int fd, const void *data, size_t length) {
    const unsigned char *p = data;
    while (length) {
        ssize_t n = write(fd, p, length);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) { errno = EIO; return -1; }
        p += (size_t)n;
        length -= (size_t)n;
    }
    return 0;
}

static int sync_dir(int fd) {
    if (fsync(fd) != 0) return fail("Cannot durably sync a directory; this filesystem is unsupported");
    return 0;
}

static int same_inode(const struct stat *s, uint64_t dev, uint64_t ino) {
    return (uint64_t)s->st_dev == dev && (uint64_t)s->st_ino == ino;
}

/* Return 1 for present, 0 for absent, -1 for an inaccessible entry. */
static int entry_stat(int dir, const char *name, struct stat *s) {
    if (fstatat(dir, name, s, AT_SYMLINK_NOFOLLOW) == 0) return 1;
    if (errno == ENOENT) return 0;
    return -1;
}
static int ascii_name_equal(const char *name, size_t length, const char *reserved) {
    size_t i = 0;
    for (; i < length && reserved[i]; ++i) {
        unsigned char c = (unsigned char)name[i];
        if (c >= 'A' && c <= 'Z') c = (unsigned char)(c + ('a' - 'A'));
        if (c != (unsigned char)reserved[i]) return 0;
    }
    return i == length && reserved[i] == '\0';
}

/* Compare no-follow identities as well as spellings: filesystem aliases need
 * not use the spelling or case exposed by readdir. */
static int reject_reserved_identity(int root, const struct stat *candidate) {
    static const char *const names[] = { ".git", DISABLED, STATE };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        struct stat reserved;
        int present = entry_stat(root, names[i], &reserved);
        if (present < 0) return -1;
        if (present && same_inode(&reserved, (uint64_t)candidate->st_dev, (uint64_t)candidate->st_ino)) {
            errno = EPERM;
            return -1;
        }
    }
    return 0;
}

static int reject_reserved_entry(int root, int parent, const char *name) {
    struct stat candidate;
    int present;
    if (parent < 0) return 0;
    present = entry_stat(parent, name, &candidate);
    if (present <= 0) return present;
    return reject_reserved_identity(root, &candidate);
}


static int valid_name(const char *name) {
    size_t len = strlen(name);
    if (!len || len > 255 || !strcmp(name, ".") || !strcmp(name, "..") ||
        ascii_name_equal(name, len, ".git") || ascii_name_equal(name, len, DISABLED) ||
        ascii_name_equal(name, len, STATE)) return 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)name[i];
        if (c == '/' || c < 32 || c == 127) return 0;
    }
    return 1;
}

static int valid_hash(const char *hash) {
    if (strlen(hash) != HASH_LENGTH) return 0;
    for (size_t i = 0; i < HASH_LENGTH; i++) {
        if (!((hash[i] >= '0' && hash[i] <= '9') || (hash[i] >= 'a' && hash[i] <= 'f'))) return 0;
    }
    return 1;
}

static int rename_exclusive(int from, const char *old, int to, const char *newname) {
    if (fault_failure("rename")) return -1;
#ifdef __APPLE__
    return renameatx_np(from, old, to, newname, RENAME_EXCL);
#else
#ifdef SYS_renameat2
    return (int)syscall(SYS_renameat2, from, old, to, newname, RENAME_NOREPLACE);
#else
    (void)from; (void)old; (void)to; (void)newname;
    errno = ENOTSUP;
    return -1;
#endif
#endif
}

/* The approved canonical root is reopened without following any component. */
static int open_root(const char *path) {
    if (path[0] != '/') { errno = EINVAL; return -1; }
    char *copy = strdup(path);
    if (!copy) return -1;
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) { free(copy); return -1; }
    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        if (!strcmp(part, ".") || !strcmp(part, "..")) { close(fd); free(copy); errno = EINVAL; return -1; }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) { int e = errno; close(fd); free(copy); errno = e; return -1; }
        close(fd);
        fd = next;
    }
    free(copy);
    return fd;
}

static int owned_regular_stat(const struct stat *s, mode_t allowed) {
    if (!S_ISREG(s->st_mode) || s->st_uid != geteuid() || s->st_nlink != 1 || (s->st_mode & 07777) != allowed) {
        errno = EPERM;
        return -1;
    }
    return 0;
}

static int owned_regular(int fd, mode_t allowed) {
    struct stat s;
    if (fstat(fd, &s) != 0) return -1;
    return owned_regular_stat(&s, allowed);
}

static int owned_directory(int fd) {
    struct stat s;
    if (fstat(fd, &s) != 0) return -1;
    if (!S_ISDIR(s.st_mode) || s.st_uid != geteuid() || (s.st_mode & 0777) != 0700) {
        errno = EPERM;
        return -1;
    }
    return 0;
}

static int create_owned_file(int dir, const char *name, const void *bytes, size_t size) {
    int fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    int result = 0;
    if (fchmod(fd, 0600) || write_all(fd, bytes, size) || fsync(fd)) result = -1;
    int e = errno;
    if (close(fd) && !result) { e = errno; result = -1; }
    errno = e;
    return result;
}

/* Inspect before opening special files; then pin and revalidate the exact
 * regular entry and mount before reading any control-file bytes. */
static int open_owned_read(int dir, const char *name, off_t size,
                           const struct tree_mount *mount, struct stat *st) {
    struct stat named;
    if (fstatat(dir, name, &named, AT_SYMLINK_NOFOLLOW) ||
        owned_regular_stat(&named, 0600)) return -1;
    if (named.st_size != size) { errno = EINVAL; return -1; }
    if (tree_check_mount_entry(dir, name, &named, mount)) {
        if (errno == ENOENT) errno = ESTALE;
        return -1;
    }
    int fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { if (errno == ENOENT) errno = ESTALE; return -1; }
    if (fstat(fd, st)) goto invalid;
    if (!tree_same_snapshot(&named, st)) { errno = ESTALE; goto invalid; }
    if (tree_check_mount_fd(fd, mount) || tree_check_source(dir, name, fd, st, mount)) goto invalid;
    return fd;
invalid:
    { int e = errno == ENOENT ? ESTALE : errno; close(fd); errno = e; }
    return -1;
}

static int check_marker(int dir, const struct tree_mount *mount) {
    struct stat st;
    int fd = open_owned_read(dir, "owner", (off_t)(sizeof(MARKER) - 1), mount, &st);
    if (fd < 0) return -1;
    char buf[sizeof(MARKER)];
    ssize_t n;
    do { n = read(fd, buf, sizeof(buf)); } while (n < 0 && errno == EINTR);
    int ok = n == (ssize_t)(sizeof(MARKER) - 1) &&
             memcmp(buf, MARKER, sizeof(MARKER) - 1) == 0;
    int e = n < 0 ? errno : EPERM;
    if (ok && tree_check_source(dir, "owner", fd, &st, mount)) { ok = 0; e = errno; }
    close(fd);
    if (!ok) { errno = e; return -1; }
    return 0;
}

static void close_context(Context *ctx) {
    if (ctx->lock >= 0) close(ctx->lock);
    if (ctx->state >= 0) close(ctx->state);
    if (ctx->root >= 0) close(ctx->root);
    ctx->lock = ctx->state = ctx->root = -1;
}

/* These descriptors identify the exact files this initializer created, even
 * if a name is subsequently replaced. Never remove unknown staging entries. */
static int bootstrap_file_matches(int dir, const char *name, int fd,
                                  const struct tree_mount *mount) {
    struct stat opened, entry;
    if (fstat(fd, &opened) || fstatat(dir, name, &entry, AT_SYMLINK_NOFOLLOW)) return -1;
    if (!S_ISREG(opened.st_mode) || opened.st_nlink != 1 || !tree_same_identity(&opened, &entry)) {
        errno = ESTALE;
        return -1;
    }
    if (tree_check_mount_fd(fd, mount) || tree_check_mount_entry(dir, name, &entry, mount)) return -1;
    return 0;
}

static int bootstrap_file(int dir, const char *name, const void *bytes, size_t size, int *fd) {
    *fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (*fd < 0) return -1;
    if (fchmod(*fd, 0600) || write_all(*fd, bytes, size) || fsync(*fd)) return -1;
    return 0;
}

static int cleanup_bootstrap(int root, const char *name, int dir, const struct stat *created,
                             const struct tree_mount *mount, int owner, int lock) {
    if (tree_check_mount_fd(dir, mount) || tree_check_created(root, name, dir, created, mount)) return -1;
    if (owner >= 0 && (bootstrap_file_matches(dir, "owner", owner, mount) ||
                       unlinkat(dir, "owner", 0))) return -1;
    if (lock >= 0 && (bootstrap_file_matches(dir, "lock", lock, mount) ||
                      unlinkat(dir, "lock", 0))) return -1;
    if (tree_check_created(root, name, dir, created, mount) ||
        unlinkat(root, name, AT_REMOVEDIR)) return -1;
    return sync_dir(root);
}

/* A crash before publication can leave an orphan. Its name or marker alone
 * cannot prove its inode was ours after restart, so recovery never removes it. */
static int bootstrap_state(int root) {
    static const char hex[] = "0123456789abcdef";
    char name[] = ".skills-manager-bootstrap-00000000000000000000000000000000";
    char *suffix = name + sizeof(".skills-manager-bootstrap-") - 1;
    struct tree_mount mount;
    struct stat created;
    int dir = -1, owner = -1, lock = -1, known = 0, published = 0;
    int result = -1, diagnostic = 0, saved = 0;
    unsigned int attempt;

    if (tree_mount_fd(root, &mount)) return fail("Cannot inspect approved filesystem mount");
    for (attempt = 0; attempt < 128; ++attempt) {
        unsigned char random[16];
        if (getentropy(random, sizeof(random))) return fail("Cannot generate a private staging name");
        for (size_t i = 0; i < sizeof(random); ++i) {
            suffix[2 * i] = hex[random[i] >> 4];
            suffix[2 * i + 1] = hex[random[i] & 15];
        }
        /* The helper is single-threaded. Ensure even a restrictive inherited
         * umask leaves a directory we can open, then immediately restore it. */
        mode_t mask = umask(0);
        int made = mkdirat(root, name, 0700);
        int e = errno;
        umask(mask);
        errno = e;
        if (!made) break;
        if (errno != EEXIST) return fail("Cannot create private controlled-state staging");
    }
    if (attempt == 128) { errno = EEXIST; return fail("Private controlled-state staging names are occupied"); }
    fault("bootstrap-after-mkdir");
    if (fstatat(root, name, &created, AT_SYMLINK_NOFOLLOW)) goto done;
    if (!S_ISDIR(created.st_mode) || created.st_uid != geteuid()) { errno = ESTALE; goto done; }
    if (tree_check_mount_entry(root, name, &created, &mount)) goto done;
    dir = openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dir < 0 || tree_check_mount_fd(dir, &mount) ||
        tree_check_created(root, name, dir, &created, &mount)) goto done;
    known = 1;
    if (fchmod(dir, 0700) || owned_directory(dir) ||
        bootstrap_file(dir, "owner", MARKER, sizeof(MARKER) - 1, &owner)) goto done;
    fault("bootstrap-after-owner");
    if (bootstrap_file(dir, "lock", "", 0, &lock)) goto done;
    fault("bootstrap-after-lock");
    if (owned_regular(owner, 0600) || owned_regular(lock, 0600) || check_marker(dir, &mount) ||
        bootstrap_file_matches(dir, "owner", owner, &mount) ||
        bootstrap_file_matches(dir, "lock", lock, &mount) ||
        sync_dir(dir) || tree_check_created(root, name, dir, &created, &mount)) goto done;
    fault("bootstrap-before-publish");
    if (rename_exclusive(root, name, root, STATE)) {
        if (errno == EEXIST || errno == ENOTEMPTY) result = 0;
        goto done;
    }
    published = 1;
    fault("bootstrap-after-publish");
    if (tree_check_created(root, STATE, dir, &created, &mount) || sync_dir(root)) goto done;
    result = 0;
done:
    saved = errno;
    if (!published) {
        if (known) {
            if (cleanup_bootstrap(root, name, dir, &created, &mount, owner, lock)) {
                saved = errno;
                snprintf(detail, sizeof(detail), "Cannot safely clean controlled-state staging %s: %s",
                         name, strerror(saved));
                result = -1;
                diagnostic = 1;
            }
        } else {
            snprintf(detail, sizeof(detail), "Cannot identify controlled-state staging %s; left untouched: %s",
                     name, strerror(saved));
            result = -1;
            diagnostic = 1;
        }
    }
    if (owner >= 0 && close(owner) && !result) { saved = errno; result = -1; }
    if (lock >= 0 && close(lock) && !result) { saved = errno; result = -1; }
    if (dir >= 0 && close(dir) && !result) { saved = errno; result = -1; }
    errno = saved;
    if (result < 0 && !diagnostic) return fail("Cannot initialize durable controlled state");
    return result;
}

/* create=0 is strictly read-only if the reserved directory is absent. */
static int open_context(Context *ctx, const char *root, int create, const char *expected_identity, int constrain) {
    ctx->root = ctx->state = ctx->lock = -1;
    ctx->root = open_root(root);
    if (ctx->root < 0) return fail("Cannot open the approved skills directory without following links");
    if (expected_identity) {
        char actual[65];
        if (!valid_hash(expected_identity) || boundary_identity_fd(ctx->root, actual)) return fail("Cannot validate approved root identity");
        if (strcmp(actual, expected_identity)) { errno = ESTALE; return fail("Selected directory changed since approval"); }
    }
    if (constrain && create && skills_apply_write_boundary(ctx->root, root, -1, NULL))
        return fail("Operating-system write confinement is unavailable");
    if (create && sync_dir(ctx->root)) return -1;
    ctx->state = openat(ctx->root, STATE, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (ctx->state < 0 && errno == ENOENT && create) {
        if (bootstrap_state(ctx->root)) return -1;
        ctx->state = openat(ctx->root, STATE, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (ctx->state < 0) {
        if (errno == ENOENT && !create) return 0;
        return fail("Reserved .skills-manager location is inaccessible or is a link");
    }
    if (constrain && !create && skills_apply_write_boundary(ctx->root, root, -1, NULL))
        return fail("Operating-system write confinement is unavailable");
    if (tree_mount_fd(ctx->root, &ctx->mount) || tree_check_mount_fd(ctx->state, &ctx->mount))
        return fail("Controlled state must remain on the selected filesystem mount");
    if (owned_directory(ctx->state) || check_marker(ctx->state, &ctx->mount)) {
        errno = EPERM;
        return fail("Reserved .skills-manager location is not owned by this application");
    }
    ctx->lock = openat(ctx->state, "lock", O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (ctx->lock < 0 || owned_regular(ctx->lock, 0600) || tree_check_mount_fd(ctx->lock, &ctx->mount))
        return fail("Invalid controlled-state lock");
    while (flock(ctx->lock, LOCK_EX) != 0) {
        if (errno != EINTR) return fail("Cannot lock controlled state");
    }
    struct stat pinned, current;
    if (fstat(ctx->state, &pinned) || fstatat(ctx->root, STATE, &current, AT_SYMLINK_NOFOLLOW) ||
        pinned.st_dev != current.st_dev || pinned.st_ino != current.st_ino ||
        fstat(ctx->lock, &pinned) || fstatat(ctx->state, "lock", &current, AT_SYMLINK_NOFOLLOW) ||
        pinned.st_dev != current.st_dev || pinned.st_ino != current.st_ino) {
        errno = ESTALE;
        return fail("Controlled state changed while acquiring its lock");
    }
    if (create && sync_dir(ctx->root)) return -1;
    return 1;
}

static int open_disabled(Context *ctx, int create) {
    int fd = openat(ctx->root, DISABLED, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 && errno == ENOENT && create) {
        if (mkdirat(ctx->root, DISABLED, 0700) && errno != EEXIST) return -1;
        if (sync_dir(ctx->root)) return -1;
        fd = openat(ctx->root, DISABLED, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (fd >= 0 && tree_check_mount_fd(fd, &ctx->mount)) { int e = errno; close(fd); errno = e; return -1; }
    return fd;
}

/* Metadata is private to the owned state; foreign or linked directories fail. */
static int open_metadata(Context *ctx, int create) {
    int fd = openat(ctx->state, "metadata", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 && errno == ENOENT && create) {
        if (mkdirat(ctx->state, "metadata", 0700) && errno != EEXIST) return -1;
        if (sync_dir(ctx->state)) return -1;
        fd = openat(ctx->state, "metadata", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (fd >= 0 && (owned_directory(fd) || tree_check_mount_fd(fd, &ctx->mount))) { int e = errno; close(fd); errno = e; return -1; }
    return fd;
}

static int metadata_name(const char *name, char out[256]) {
    if (strlen(name) + 5 > 255) { errno = ENAMETOOLONG; return -1; }
    snprintf(out, 256, "%s.json", name);
    return 0;
}

static int check_owned_entry(int dir, const char *name, struct stat *st) {
    int present = entry_stat(dir, name, st);
    if (present <= 0) return present;
    if (owned_regular_stat(st, 0600)) return -1;
    return 1;
}

static int save_journal(Context *ctx, Journal *j) {
    /* A stale temporary file can only be an interrupted manager write. */
    struct stat s;
    int tmp = entry_stat(ctx->state, "journal.next", &s);
    if (tmp < 0) return fail("Cannot inspect temporary journal");
    if (tmp && (check_owned_entry(ctx->state, "journal.next", &s) < 0 || unlinkat(ctx->state, "journal.next", 0)))
        return fail("Cannot clear temporary journal");
    if (fault_failure("journal-write")) return fail("Injected journal-write failure");
    if (create_owned_file(ctx->state, "journal.next", j, sizeof(*j))) return fail("Cannot write durable journal");
    if (fault_failure("journal-replace")) return fail("Injected journal-replace failure");
    if (renameat(ctx->state, "journal.next", ctx->state, "journal")) return fail("Cannot replace durable journal");
    return sync_dir(ctx->state);
}

static int load_journal(Context *ctx, Journal *j) {
    struct stat st;
    int fd = open_owned_read(ctx->state, "journal", (off_t)sizeof(*j), &ctx->mount, &st);
    if (fd < 0) return errno == ENOENT ? 0 : fail("Recovery journal is invalid or inaccessible; preserving all data");
    ssize_t n;
    do { n = read(fd, j, sizeof(*j)); } while (n < 0 && errno == EINTR);
    int valid = 0, e = EINVAL;
    if (n < 0) e = errno;
    else if (n != (ssize_t)sizeof(*j)) e = ESTALE;
    else if (tree_check_source(ctx->state, "journal", fd, &st, &ctx->mount)) e = errno;
    else valid = !memcmp(j->magic, JOURNAL_MAGIC, 8) &&
        j->type >= J_TOGGLE && j->type <= J_IMPORT &&
        (j->location == LOC_ACTIVE || j->location == LOC_DISABLED) &&
        (j->phase == PHASE_INTENT || j->phase == PHASE_COMMITTED) &&
        j->had_meta <= 1 && j->want_meta <= 1 &&
        memchr(j->name, 0, sizeof(j->name)) && valid_name(j->name) &&
        memchr(j->old_hash, 0, sizeof(j->old_hash)) && memchr(j->new_hash, 0, sizeof(j->new_hash));
    close(fd);
    if (!valid) { errno = e; return fail("Recovery journal is invalid; preserving all data"); }
    return 1;
}

static int expect_inode(int dir, const char *name, uint64_t dev, uint64_t ino) {
    struct stat st;
    int present = entry_stat(dir, name, &st);
    if (present <= 0) return present;
    if (!same_inode(&st, dev, ino)) { errno = ESTALE; return -1; }
    return 1;
}

static int remove_known_file(int dir, const char *name, uint64_t dev, uint64_t ino) {
    int present = expect_inode(dir, name, dev, ino);
    if (present <= 0) return present;
    if (unlinkat(dir, name, 0)) return -1;
    return 0;
}

static int clear_journal(Context *ctx) {
    if (unlinkat(ctx->state, "journal", 0)) return fail("Cannot clear recovery journal");
    return sync_dir(ctx->state);
}

/* Restore old metadata, or discard committed backups. No path is overwritten. */
static int recover_metadata(Context *ctx, const Journal *j, int committed) {
    if (!j->had_meta && !j->want_meta) return 0;
    int meta = open_metadata(ctx, 0);
    if (meta < 0) return fail("Cannot open metadata during recovery");
    char filename[256];
    if (metadata_name(j->name, filename)) { close(meta); return fail("Invalid metadata name in journal"); }
    int result = -1;
    int old = expect_inode(ctx->state, "oldmeta", j->old_meta_dev, j->old_meta_ino);
    int staged = expect_inode(ctx->state, "newmeta", j->new_meta_dev, j->new_meta_ino);
    struct stat now;
    int current = entry_stat(meta, filename, &now);
    if (old < 0 || staged < 0 || current < 0) goto out;
    if (committed) {
        if (j->want_meta && (current != 1 || !same_inode(&now, j->new_meta_dev, j->new_meta_ino))) { errno = ESTALE; goto out; }
        if (!j->want_meta && current) { errno = ESTALE; goto out; }
        if (old && remove_known_file(ctx->state, "oldmeta", j->old_meta_dev, j->old_meta_ino)) goto out;
        if (staged) { errno = ESTALE; goto out; }
    } else {
        if (current && j->want_meta && same_inode(&now, j->new_meta_dev, j->new_meta_ino)) {
            if (staged || rename_exclusive(meta, filename, ctx->state, "newmeta")) goto out;
            staged = 1;
            current = 0;
        }
        if (j->had_meta) {
            if (old) {
                if (current || rename_exclusive(ctx->state, "oldmeta", meta, filename)) goto out;
                current = 1;
            } else if (!current || !same_inode(&now, j->old_meta_dev, j->old_meta_ino)) {
                errno = ESTALE; goto out;
            }
        } else if (current) { errno = ESTALE; goto out; }
        if (staged && remove_known_file(ctx->state, "newmeta", j->new_meta_dev, j->new_meta_ino)) goto out;
    }
    if (sync_dir(meta) || sync_dir(ctx->state)) goto out;
    result = 0;
out:
    { int e = errno; close(meta); errno = e; }
    if (result) return fail("Metadata recovery is ambiguous; preserving existing data");
    return 0;
}

static int recover_journal(Context *ctx, int *did_recover) {
    Journal j;
    int loaded = load_journal(ctx, &j);
    if (loaded < 0) return -1;
    if (!loaded) {
        struct stat s;
        int unknown = entry_stat(ctx->state, "quarantine", &s);
        if (unknown < 0) return fail("Cannot inspect recovery area");
        if (unknown || entry_stat(ctx->state, "oldmeta", &s) != 0) { errno = ESTALE; return fail("Unjournaled recovery data needs manual review"); }
        int incoming = entry_stat(ctx->state, "incoming", &s);
        if (incoming < 0) return fail("Cannot inspect interrupted staging");
        if (incoming && tree_remove_at(ctx->state, "incoming")) return fail("Cannot clean interrupted staging");
        int temp = check_owned_entry(ctx->state, "newmeta", &s);
        if (temp < 0 || (temp && unlinkat(ctx->state, "newmeta", 0))) return fail("Cannot clean interrupted metadata staging");
        int removed_metadata = temp;
        temp = check_owned_entry(ctx->state, "journal.next", &s);
        if (temp < 0 || (temp && unlinkat(ctx->state, "journal.next", 0))) return fail("Cannot clean interrupted journal staging");
        if (incoming || temp || removed_metadata) { if (sync_dir(ctx->state)) return -1; *did_recover = 1; }
        return 0;
    }
    int disabled = open_disabled(ctx, 0);
    if (disabled < 0 && errno != ENOENT) return fail("Disabled directory is unsafe during recovery");
    int original = j.location == LOC_ACTIVE ? ctx->root : disabled;
    int alternate = j.location == LOC_ACTIVE ? disabled : ctx->root;
    if (original < 0 || (j.type == J_TOGGLE && alternate < 0)) {
        if (disabled >= 0) close(disabled);
        errno = ESTALE;
        return fail("A journaled skills directory is missing");
    }
    int result = -1;
    int committed = j.phase == PHASE_COMMITTED;
    if (reject_reserved_entry(ctx->root, original, j.name) ||
        reject_reserved_entry(ctx->root, alternate, j.name) ||
        reject_reserved_entry(ctx->root, ctx->state, "quarantine")) goto out;
    if (j.type == J_TOGGLE && !committed) {
        int source = expect_inode(original, j.name, j.old_dev, j.old_ino);
        int dest = expect_inode(alternate, j.name, j.old_dev, j.old_ino);
        if (source < 0 || dest < 0 || (source && dest) || (!source && !dest)) { errno = ESTALE; goto out; }
        if (dest && rename_exclusive(alternate, j.name, original, j.name)) goto out;
        if (sync_dir(original) || sync_dir(alternate)) goto out;
    } else if (j.type == J_REMOVE || j.type == J_IMPORT) {
        int backup = expect_inode(ctx->state, "quarantine", j.old_dev, j.old_ino);
        struct stat now;
        int present = entry_stat(original, j.name, &now);
        if (backup < 0 || present < 0) goto out;
        if (committed) {
            if (backup) {
                struct stat saved;
                if (entry_stat(ctx->state, "quarantine", &saved) != 1 ||
                    !same_inode(&saved, j.old_dev, j.old_ino) ||
                    tree_remove_known_at(ctx->state, "quarantine", &saved, &ctx->mount)) goto out;
            }
        } else if (j.type == J_REMOVE) {
            if (backup) {
                if (present || rename_exclusive(ctx->state, "quarantine", original, j.name)) goto out;
            } else if (!present || !same_inode(&now, j.old_dev, j.old_ino)) { errno = ESTALE; goto out; }
        } else {
            int staged = expect_inode(ctx->state, "incoming", j.new_dev, j.new_ino);
            if (staged < 0) goto out;
            if (present && same_inode(&now, j.new_dev, j.new_ino)) {
                char hash[65];
                if (staged || tree_fingerprint_at(original, j.name, 0, hash) || strcmp(hash, j.new_hash)) { errno = ESTALE; goto out; }
                if (rename_exclusive(original, j.name, ctx->state, "incoming")) goto out;
                staged = 1; present = 0;
            }
            if (j.old_ino) {
                if (backup) {
                    if (present || rename_exclusive(ctx->state, "quarantine", original, j.name)) goto out;
                } else if (!present || !same_inode(&now, j.old_dev, j.old_ino)) { errno = ESTALE; goto out; }
            } else if (present || backup) { errno = ESTALE; goto out; }
            if (staged) {
                struct stat saved;
                if (entry_stat(ctx->state, "incoming", &saved) != 1 ||
                    !same_inode(&saved, j.new_dev, j.new_ino) ||
                    tree_remove_known_at(ctx->state, "incoming", &saved, &ctx->mount)) goto out;
            }
        }
        if (sync_dir(original) || sync_dir(ctx->state) || recover_metadata(ctx, &j, committed)) goto out;
    }
    if (clear_journal(ctx)) goto out;
    *did_recover = 1;
    result = 0;
out:
    { int e = errno; if (disabled >= 0) close(disabled); errno = e; }
    if (result) return fail("Recovery could not safely reconcile the journal; originals were preserved");
    return 0;
}

static void init_journal(Journal *j, int type, int location, const char *name) {
    memset(j, 0, sizeof(*j));
    memcpy(j->magic, JOURNAL_MAGIC, 8);
    j->type = (uint32_t)type;
    j->location = (uint32_t)location;
    j->phase = PHASE_INTENT;
    snprintf(j->name, sizeof(j->name), "%s", name);
}

static int checked_fingerprint(Context *ctx, int dir, const char *name, const char *expected, struct stat *st) {
    int present = entry_stat(dir, name, st);
    if (present <= 0) { if (!present) errno = ENOENT; return fail("Reviewed skill no longer exists"); }
    if (reject_reserved_identity(ctx->root, st)) return fail("Reserved root metadata cannot be changed as a skill");
    if (tree_check_mount_entry(dir, name, st, &ctx->mount)) return fail("Skill crosses the selected filesystem mount");
    if (!S_ISDIR(st->st_mode) && !S_ISLNK(st->st_mode)) { errno = EINVAL; return fail("Skill must be a directory or link"); }
    char actual[65];
    if (tree_fingerprint_at(dir, name, 0, actual)) return fail("Cannot safely fingerprint the reviewed skill");
    if (strcmp(actual, expected)) { errno = ESTALE; return fail("Skill changed since its path was reviewed"); }
    struct stat after;
    if (entry_stat(dir, name, &after) != 1 || after.st_dev != st->st_dev || after.st_ino != st->st_ino) {
        errno = ESTALE; return fail("Skill identity changed since review");
    }
    if (reject_reserved_identity(ctx->root, &after)) return fail("Reserved root metadata cannot be changed as a skill");
    return 0;
}
/* Recheck the reviewed no-follow identity and reserved entries immediately
 * before a source rename, after journal and staging work. */
static int recheck_reviewed(Context *ctx, int parent, const char *name, uint64_t dev, uint64_t ino) {
    struct stat st;
    int present = entry_stat(parent, name, &st);
    if (present < 0) return fail("Cannot recheck reviewed skill");
    if (!present || !same_inode(&st, dev, ino)) {
        errno = ESTALE;
        return fail("Reviewed skill changed before the operation");
    }
    if (reject_reserved_identity(ctx->root, &st)) return fail("Reserved root metadata cannot be changed as a skill");
    if (tree_check_mount_entry(parent, name, &st, &ctx->mount)) return fail("Skill crosses the selected filesystem mount");
    return 0;
}


static int no_entry(int dir, const char *name) {
    struct stat s;
    int present = entry_stat(dir, name, &s);
    if (present < 0) return -1;
    if (present) { errno = EEXIST; return -1; }
    return 0;
}

static int inspect_old_metadata(Context *ctx, Journal *j, int *meta_out, char filename[256]) {
    *meta_out = -1;
    if (metadata_name(j->name, filename)) {
        if (errno == ENAMETOOLONG) return 0;
        return -1;
    }
    int meta = open_metadata(ctx, 0);
    if (meta < 0 && errno == ENOENT) return 0;
    if (meta < 0) return fail("Cannot inspect controlled provenance");
    struct stat s;
    int old = check_owned_entry(meta, filename, &s);
    if (old < 0) { close(meta); return fail("Invalid controlled provenance record"); }
    if (old) {
        j->had_meta = 1;
        j->old_meta_dev = (uint64_t)s.st_dev;
        j->old_meta_ino = (uint64_t)s.st_ino;
    }
    *meta_out = meta;
    return 0;
}

static int rollback_after_error(Context *ctx) {
    char original[sizeof(detail)];
    snprintf(original, sizeof(original), "%s", detail[0] ? detail : strerror(errno));
    int recovered = 0;
    if (recover_journal(ctx, &recovered)) {
        char recovery[sizeof(detail)];
        snprintf(recovery, sizeof(recovery), "%s", detail);
        snprintf(detail, sizeof(detail), "%.220s; recovery needs attention: %.220s", original, recovery);
    } else {
        snprintf(detail, sizeof(detail), "%s", original);
    }
    return -1;
}

static int toggle_skill(Context *ctx, const char *name, const char *expected, int enable) {
    if (!valid_name(name) || !valid_hash(expected)) { errno = EINVAL; return fail("Invalid skill name or reviewed fingerprint"); }
    int disabled = open_disabled(ctx, !enable);
    if (disabled < 0) return fail("Disabled directory is missing or unsafe");
    int source = enable ? disabled : ctx->root;
    int dest = enable ? ctx->root : disabled;
    int result = -1;
    struct stat st;
    if (checked_fingerprint(ctx, source, name, expected, &st)) goto out;
    if (no_entry(dest, name)) { fail("Toggle destination already exists or is inaccessible"); goto out; }
    Journal j;
    init_journal(&j, J_TOGGLE, enable ? LOC_DISABLED : LOC_ACTIVE, name);
    j.old_dev = (uint64_t)st.st_dev; j.old_ino = (uint64_t)st.st_ino;
    memcpy(j.old_hash, expected, 65);
    if (save_journal(ctx, &j)) goto out;
    fault("after-intent");
    if (recheck_reviewed(ctx, source, name, j.old_dev, j.old_ino)) goto rollback;
    if (rename_exclusive(source, name, dest, name)) { fail("Cannot move skill without replacing another entry"); goto rollback; }
    fault("after-move");
    if (checked_fingerprint(ctx, dest, name, expected, &st) || sync_dir(source) || sync_dir(dest)) goto rollback;
    j.phase = PHASE_COMMITTED;
    if (save_journal(ctx, &j)) goto rollback;
    fault("after-commit");
    if (clear_journal(ctx)) goto out;
    result = 0;
    goto out;
rollback:
    rollback_after_error(ctx);
out:
    { int e = errno; close(disabled); errno = e; }
    return result;
}

static int remove_skill(Context *ctx, const char *name, int location, const char *expected) {
    if (!valid_name(name) || !valid_hash(expected)) { errno = EINVAL; return fail("Invalid skill name or reviewed fingerprint"); }
    int disabled = open_disabled(ctx, 0);
    if (disabled < 0 && errno != ENOENT) return fail("Disabled directory is unsafe");
    int source = location == LOC_ACTIVE ? ctx->root : disabled;
    if (source < 0) { if (disabled >= 0) close(disabled); errno = ENOENT; return fail("Reviewed disabled skill no longer exists"); }
    int result = -1, meta = -1;
    char filename[256];
    struct stat st;
    Journal j;
    init_journal(&j, J_REMOVE, location, name);
    if (checked_fingerprint(ctx, source, name, expected, &st)) goto out;
    j.old_dev = (uint64_t)st.st_dev; j.old_ino = (uint64_t)st.st_ino;
    memcpy(j.old_hash, expected, 65);
    if (inspect_old_metadata(ctx, &j, &meta, filename)) goto out;
    if (no_entry(ctx->state, "quarantine") || no_entry(ctx->state, "oldmeta")) { fail("Recovery area is occupied"); goto out; }
    if (save_journal(ctx, &j)) goto out;
    fault("after-intent");
    if (recheck_reviewed(ctx, source, name, j.old_dev, j.old_ino)) goto rollback;
    if (j.had_meta && rename_exclusive(meta, filename, ctx->state, "oldmeta")) { fail("Cannot protect existing provenance"); goto rollback; }
    if (rename_exclusive(source, name, ctx->state, "quarantine")) { fail("Cannot move reviewed skill to quarantine"); goto rollback; }
    fault("after-move");
    if (checked_fingerprint(ctx, ctx->state, "quarantine", expected, &st) || sync_dir(source) || sync_dir(ctx->state) || (meta >= 0 && sync_dir(meta))) goto rollback;
    j.phase = PHASE_COMMITTED;
    if (save_journal(ctx, &j)) goto rollback;
    fault("after-commit");
    { int recovered = 0; if (recover_journal(ctx, &recovered)) goto out; }
    result = 0;
    goto out;
rollback:
    rollback_after_error(ctx);
out:
    { int e = errno; if (meta >= 0) close(meta); if (disabled >= 0) close(disabled); errno = e; }
    return result;
}

static int split_parent(const char *path, int *parent, char **name, char **storage) {
    *storage = strdup(path);
    if (!*storage) return -1;
    char *slash = strrchr(*storage, '/');
    if (!slash || !slash[1]) { free(*storage); errno = EINVAL; return -1; }
    *name = slash + 1;
    if (slash == *storage) *parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    else {
        *slash = '\0';
        *parent = open(*storage, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    }
    if (*parent < 0) { int e = errno; free(*storage); errno = e; return -1; }
    return 0;
}

static unsigned char *decode_hex(const char *hex, size_t *size) {
    size_t len = strlen(hex);
    if ((len & 1) || len > MAX_COMMAND) { errno = EINVAL; return NULL; }
    unsigned char *out = malloc(len / 2 + 1);
    if (!out) return NULL;
    for (size_t i = 0; i < len; i += 2) {
        char a = hex[i], b = hex[i + 1];
        int x = a >= '0' && a <= '9' ? a - '0' : a >= 'a' && a <= 'f' ? a - 'a' + 10 : -1;
        int y = b >= '0' && b <= '9' ? b - '0' : b >= 'a' && b <= 'f' ? b - 'a' + 10 : -1;
        if (x < 0 || y < 0) { free(out); errno = EINVAL; return NULL; }
        out[i / 2] = (unsigned char)((x << 4) | y);
    }
    *size = len / 2;
    out[*size] = 0;
    return out;
}

static int import_skill(Context *ctx, const char *name, const char *stage, int location,
                        const char *stage_hash, const char *expected, const unsigned char *metadata, size_t metadata_size) {
    if (!valid_name(name) || !valid_hash(stage_hash) || (location && !valid_hash(expected))) {
        errno = EINVAL; return fail("Invalid import name or reviewed fingerprint");
    }
    char filename[256];
    if (metadata_name(name, filename)) return fail("Skill name is too long for controlled provenance");
    int disabled = open_disabled(ctx, 0);
    if (disabled < 0 && errno != ENOENT) return fail("Disabled directory is unsafe");
    int dest = location == LOC_DISABLED ? disabled : ctx->root;
    int stage_parent = -1, meta = -1, result = -1;
    char *leaf = NULL, *storage = NULL;
    if (dest < 0) { errno = ENOENT; fail("Reviewed disabled location no longer exists"); goto out; }
    if (!location && (no_entry(ctx->root, name) || (disabled >= 0 && no_entry(disabled, name)))) { fail("Install destination collides with an existing entry"); goto out; }
    Journal j;
    init_journal(&j, J_IMPORT, location == LOC_DISABLED ? LOC_DISABLED : LOC_ACTIVE, name);
    struct stat st;
    if (location) {
        if (checked_fingerprint(ctx, dest, name, expected, &st)) goto out;
        j.old_dev = (uint64_t)st.st_dev; j.old_ino = (uint64_t)st.st_ino;
        memcpy(j.old_hash, expected, 65);
    }
    if (inspect_old_metadata(ctx, &j, &meta, filename)) goto out;
    if (metadata && meta < 0) {
        meta = open_metadata(ctx, 1);
        if (meta < 0) { fail("Cannot create controlled provenance directory"); goto out; }
    }
    if (no_entry(ctx->state, "incoming") || no_entry(ctx->state, "quarantine") ||
        no_entry(ctx->state, "oldmeta") || no_entry(ctx->state, "newmeta")) { fail("Recovery area is occupied"); goto out; }
    if (split_parent(stage, &stage_parent, &leaf, &storage)) { fail("Cannot open staged skill"); goto out; }
    char actual[65];
    if (tree_fingerprint_at(stage_parent, leaf, 1, actual)) { fail("Staged skill contains an unsafe entry"); goto out; }
    if (strcmp(actual, stage_hash)) { errno = ESTALE; fail("Staged skill changed since review"); goto out; }
    if (tree_copy_at(stage_parent, leaf, ctx->state, "incoming", actual)) { fail("Cannot safely copy staged skill"); goto cleanup_stage; }
    if (strcmp(actual, stage_hash)) { errno = ESTALE; fail("Staged skill changed during copying"); goto cleanup_stage; }
    if (tree_fingerprint_at(ctx->state, "incoming", 0, j.new_hash) || entry_stat(ctx->state, "incoming", &st) != 1) {
        fail("Cannot verify protected staged skill"); goto cleanup_stage;
    }
    j.new_dev = (uint64_t)st.st_dev; j.new_ino = (uint64_t)st.st_ino;
    if (metadata) {
        if (create_owned_file(ctx->state, "newmeta", metadata, metadata_size) || entry_stat(ctx->state, "newmeta", &st) != 1) {
            fail("Cannot stage provenance"); goto cleanup_stage;
        }
        j.want_meta = 1;
        j.new_meta_dev = (uint64_t)st.st_dev; j.new_meta_ino = (uint64_t)st.st_ino;
    }
    if (sync_dir(ctx->state) || save_journal(ctx, &j)) goto cleanup_stage;
    fault("after-intent");
    if (location && recheck_reviewed(ctx, dest, name, j.old_dev, j.old_ino)) goto rollback;
    if (j.had_meta && rename_exclusive(meta, filename, ctx->state, "oldmeta")) { fail("Cannot protect old provenance"); goto rollback; }
    if (location && rename_exclusive(dest, name, ctx->state, "quarantine")) { fail("Cannot protect old skill"); goto rollback; }
    if (location && checked_fingerprint(ctx, ctx->state, "quarantine", expected, &st)) goto rollback;
    if (rename_exclusive(ctx->state, "incoming", dest, name)) { fail("Cannot install without replacing another entry"); goto rollback; }
    if (j.want_meta && rename_exclusive(ctx->state, "newmeta", meta, filename)) { fail("Cannot install provenance without replacing another record"); goto rollback; }
    fault("after-move");
    if (checked_fingerprint(ctx, dest, name, j.new_hash, &st) || sync_dir(dest) || sync_dir(ctx->state) || (meta >= 0 && sync_dir(meta))) goto rollback;
    j.phase = PHASE_COMMITTED;
    if (save_journal(ctx, &j)) goto rollback;
    fault("after-commit");
    { int recovered = 0; if (recover_journal(ctx, &recovered)) goto out; }
    result = 0;
    goto out;
rollback:
    rollback_after_error(ctx);
    goto out;
cleanup_stage:
    { int saved = errno; char message[sizeof(detail)]; snprintf(message, sizeof(message), "%s", detail);
      int did = 0; if (recover_journal(ctx, &did)) {
          char recovery[sizeof(detail)]; snprintf(recovery, sizeof(recovery), "%s", detail);
          snprintf(detail, sizeof(detail), "%.220s; cleanup needs attention: %.220s", message, recovery);
      } else snprintf(detail, sizeof(detail), "%s", message);
      errno = saved; }
out:
    { int e = errno; if (stage_parent >= 0) close(stage_parent); free(storage); if (meta >= 0) close(meta); if (disabled >= 0) close(disabled); errno = e; }
    return result;
}

/* Receipt reads do not initialize state or replay recovery. */
static int read_metadata(Context *ctx, const char *name, char **result) {
    *result = NULL;
    if (!valid_name(name)) { errno = EINVAL; return fail("Invalid provenance name"); }
    Journal journal;
    int pending = load_journal(ctx, &journal);
    if (pending < 0) return -1;
    if (pending) { errno = EBUSY; return fail("Recovery is required before reading provenance"); }
    int meta = open_metadata(ctx, 0);
    if (meta < 0 && errno == ENOENT) return 0;
    if (meta < 0) return fail("Cannot open controlled provenance");
    char filename[256];
    struct stat before, after;
    if (metadata_name(name, filename)) { close(meta); return fail("Invalid provenance filename"); }
    int present = check_owned_entry(meta, filename, &before);
    if (!present) { close(meta); return 0; }
    if (present < 0 || before.st_size < 0 || before.st_size > 1024 * 1024 ||
        tree_check_mount_entry(meta, filename, &before, &ctx->mount)) {
        int e = errno ? errno : EFBIG; close(meta); errno = e; return fail("Unsafe provenance record");
    }
    int fd = openat(meta, filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { int e = errno; close(meta); errno = e; return fail("Cannot open provenance record"); }
    size_t size = (size_t)before.st_size;
    unsigned char *bytes = malloc(size + 1);
    char *hex = malloc(size * 2 + 1);
    int ok = bytes && hex && !fstat(fd, &after) &&
        !owned_regular_stat(&after, 0600) && !tree_check_mount_fd(fd, &ctx->mount);
    if (ok && !tree_same_snapshot(&before, &after)) { errno = ESTALE; ok = 0; }
    size_t offset = 0;
    while (ok && offset < size) {
        ssize_t n = read(fd, bytes + offset, size - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ok = 0; break; }
        offset += (size_t)n;
    }
    if (ok && tree_check_source(meta, filename, fd, &before, &ctx->mount)) ok = 0;
    if (ok) {
        static const char digits[] = "0123456789abcdef";
        for (size_t i = 0; i < size; i++) { hex[2*i] = digits[bytes[i] >> 4]; hex[2*i+1] = digits[bytes[i] & 15]; }
        hex[size * 2] = 0;
        *result = hex;
    } else free(hex);
    free(bytes);
    { int e = errno; close(fd); close(meta); errno = e; }
    if (!ok) { if (!errno) errno = ESTALE; return fail("Provenance changed while being read"); }
    return 0;
}

static int git_index_name(const char *name) {
    size_t n = strlen(name);
    if (n <= 10 || n > 128 || strncmp(name, "git-index-", 10)) return 0;
    const char *suffix = strstr(name + 10, ".");
    size_t end = suffix ? (size_t)(suffix - name) : n;
    if (suffix && strcmp(suffix, ".lock")) return 0;
    if (end == 10) return 0;
    for (size_t i = 10; i < end; i++) {
        unsigned char c = (unsigned char)name[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_')) return 0;
    }
    return 1;
}

static int git_index_operation(Context *ctx, const char *name, const char *expected, char **response) {
    if (!git_index_name(name)) { errno = EINVAL; return fail("Invalid temporary Git index name"); }
    struct stat st;
    int present = entry_stat(ctx->state, name, &st);
    if (present < 0) return fail("Cannot inspect temporary Git index");
    if (!present) {
        if (expected) { errno = ENOENT; return fail("Temporary Git index no longer exists"); }
        return 0;
    }
    if (!S_ISREG(st.st_mode) || st.st_uid != geteuid() || st.st_nlink != 1 ||
        tree_check_mount_entry(ctx->state, name, &st, &ctx->mount)) {
        errno = EPERM; return fail("Unsafe temporary Git index");
    }
    char identity[64];
    snprintf(identity, sizeof(identity), "%" PRIuMAX ":%" PRIuMAX, (uintmax_t)st.st_dev, (uintmax_t)st.st_ino);
    if (!expected) {
        *response = strdup(identity);
        if (!*response) return fail("Cannot report temporary Git index identity");
        return 0;
    }
    if (strcmp(identity, expected)) { errno = ESTALE; return fail("Temporary Git index changed before cleanup"); }
    if (unlinkat(ctx->state, name, 0) || sync_dir(ctx->state)) return fail("Cannot safely clean temporary Git index");
    return 0;
}

/* Other mutations must wait for the separate Git index/ref transaction. */
static int git_journal_present(Context *ctx) {
    static const char *names[] = { "git-transaction-journal", "git-transaction-journal.next", "git-transaction-journal.delete" };
    int found = 0;
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        struct stat st;
        int present = check_owned_entry(ctx->state, names[i], &st);
        if (present < 0) return fail("Unsafe pending Git transaction journal");
        if (present && tree_check_mount_entry(ctx->state, names[i], &st, &ctx->mount))
            return fail("Git transaction journal crosses a filesystem mount");
        found |= present;
    }
    return found;
}

static const char *error_code(int e) {
    switch (e) {
        case ENOENT: return "ENOENT";
        case EEXIST: return "EEXIST";
        case EACCES: return "EACCES";
        case EPERM: return "EPERM";
        case ENOTDIR: return "ENOTDIR";
        case ELOOP: return "ELOOP";
        case EXDEV: return "EXDEV";
        case ESTALE: return "ESTALE";
        case EBUSY: return "EBUSY";
        case EINVAL: return "EINVAL";
        case EFBIG: return "EFBIG";
        case E2BIG: return "E2BIG";
        default: return "EIO";
    }
}

static void reply_error(void) {
    printf("ERR\t%s\t%s\n", error_code(errno), detail[0] ? detail : strerror(errno));
    fflush(stdout);
}

static int do_command(Context *ctx, char *line, char **response) {
    char *fields[8] = {0}, *save = NULL;
    size_t count = 0;
    for (char *p = strtok_r(line, "\t\r\n", &save); p && count < 8; p = strtok_r(NULL, "\t\r\n", &save)) fields[count++] = p;
    if (!count) { errno = EINVAL; return fail("Empty command"); }
    if (count == 1 && !strcmp(fields[0], "git-journal")) {
        int present = git_journal_present(ctx);
        if (present < 0) return -1;
        *response = strdup(present ? "1" : "0");
        return *response ? 0 : fail("Cannot report pending Git transaction");
    }
    if (count < 2) { errno = EINVAL; return fail("Incomplete command"); }
    size_t name_size;
    unsigned char *name = decode_hex(fields[1], &name_size);
    if (!name || strlen((char *)name) != name_size || !valid_name((char *)name)) { free(name); errno = EINVAL; return fail("Invalid skill name"); }
    if (!strcmp(fields[0], "enable") || !strcmp(fields[0], "disable") ||
        !strcmp(fields[0], "remove") || !strcmp(fields[0], "import")) {
        int pending = git_journal_present(ctx);
        if (pending != 0) {
            free(name);
            if (pending > 0) { errno = EBUSY; return fail("Pending Git transaction must be recovered before changing skills"); }
            return -1;
        }
    }
    int result = -1;
    if (!strcmp(fields[0], "index-id") && count == 2) {
        result = git_index_operation(ctx, (char *)name, NULL, response);
    } else if (!strcmp(fields[0], "index-clean") && count == 3) {
        result = git_index_operation(ctx, (char *)name, fields[2], response);
    } else if (!strcmp(fields[0], "metadata") && count == 2) {
        result = read_metadata(ctx, (char *)name, response);
    } else if ((!strcmp(fields[0], "enable") || !strcmp(fields[0], "disable")) && count == 3) {
        result = toggle_skill(ctx, (char *)name, fields[2], !strcmp(fields[0], "enable"));
    } else if (!strcmp(fields[0], "remove") && count == 4) {
        int loc = !strcmp(fields[2], "active") ? LOC_ACTIVE : !strcmp(fields[2], "disabled") ? LOC_DISABLED : 0;
        if (!loc) { errno = EINVAL; fail("Invalid removal location"); }
        else result = remove_skill(ctx, (char *)name, loc, fields[3]);
    } else if (!strcmp(fields[0], "import") && count == 7) {
        size_t stage_size, metadata_size = 0;
        unsigned char *stage = decode_hex(fields[2], &stage_size);
        int loc = !strcmp(fields[3], "new") ? 0 : !strcmp(fields[3], "active") ? LOC_ACTIVE : !strcmp(fields[3], "disabled") ? LOC_DISABLED : -1;
        unsigned char *metadata = strcmp(fields[6], "-") ? decode_hex(fields[6], &metadata_size) : NULL;
        if (!stage || strlen((char *)stage) != stage_size || loc < 0 || (strcmp(fields[6], "-") && !metadata)) { errno = EINVAL; fail("Invalid import command"); }
        else result = import_skill(ctx, (char *)name, (char *)stage, loc, fields[4], fields[5], metadata, metadata_size);
        free(stage); free(metadata);
    } else { errno = EINVAL; fail("Unknown or malformed boundary operation"); }
    free(name);
    return result;
}

static int fingerprint_path(const char *path, int mode) {
    int parent = -1;
    char *name = NULL, *storage = NULL, hash[65];
    if (split_parent(path, &parent, &name, &storage)) return fail("Cannot open fingerprint parent");
    int result = tree_fingerprint_at(parent, name, mode, hash);
    int e = errno;
    close(parent); free(storage); errno = e;
    if (result) return fail("Cannot safely fingerprint path");
    printf("READY\t%s\n", hash);
    return 0;
}

#include "fingerprint-skill.h"
#include "read-boundary.h"
#include "list-boundary.h"
#include "git-tree-hash.h"


int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--platform-probe")) {
#if defined(__APPLE__)
        const char *os = "darwin", *libc = "none";
#elif defined(__linux__) && defined(__GLIBC__)
        const char *os = "linux", *libc = "glibc";
#else
#error Unsupported operating system or Linux C library
#endif
#if defined(__aarch64__) || defined(__arm64__)
        const char *arch = "arm64";
#elif defined(__x86_64__)
        const char *arch = "x64";
#else
#error Unsupported architecture
#endif
        printf("%s\t%s\t%s\n", os, arch, libc);
        return 0;
    }
    if (argc == 4 && !strcmp(argv[1], "fingerprint")) {
        if (strcmp(argv[3], "identity") && strcmp(argv[3], "content") && strcmp(argv[3], "staged")) { errno = EINVAL; fail("Invalid fingerprint mode"); reply_error(); return 1; }
        int mode = !strcmp(argv[3], "content") ? 2 : !strcmp(argv[3], "staged") ? 1 : 0;
        if (fingerprint_path(argv[2], mode)) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 7 && !strcmp(argv[1], "fingerprint-skill")) {
        if (fingerprint_skill(argv[2], argv[3], argv[4], argv[5], argv[6])) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 3 && !strcmp(argv[1], "identity")) {
        if (boundary_directory_identity(argv[2])) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 6 && !strcmp(argv[1], "read")) {
        char *end;
        errno = 0;
        unsigned long long limit = strtoull(argv[4], &end, 10);
        if (errno || !*argv[4] || *end) { errno = EINVAL; fail("Invalid read limit"); reply_error(); return 1; }
        if (boundary_read(argv[2], argv[3], (uint64_t)limit, strcmp(argv[5], "-") ? argv[5] : NULL)) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 5 && !strcmp(argv[1], "count-lines")) {
        if (boundary_count_lines(argv[2], argv[3], strcmp(argv[4], "-") ? argv[4] : NULL)) { reply_error(); return 1; }
        return 0;
    }
    if ((argc == 5 || argc == 6) && !strcmp(argv[1], "list")) {
        if (strcmp(argv[3], "all") && strcmp(argv[3], "visible")) { errno = EINVAL; fail("Invalid listing mode"); reply_error(); return 1; }
        if (boundary_list(argv[2], !strcmp(argv[3], "all"), strcmp(argv[4], "-") ? argv[4] : NULL,
                          argc == 6 ? argv[5] : NULL)) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 3 && !strcmp(argv[1], "git-tree")) {
        if (boundary_git_tree_hash(argv[2])) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 4 && !strcmp(argv[1], "parent-lock")) {
        if (boundary_read_parent_lock(argv[2], strcmp(argv[3], "-") ? argv[3] : NULL)) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 4 && !strcmp(argv[1], "dispose")) {
        if (boundary_remove_disposable(argv[2], argv[3])) { reply_error(); return 1; }
        return 0;
    }
    if (argc == 4 && !strcmp(argv[1], "git-journal")) {
        Context ctx;
        int opened = open_context(&ctx, argv[2], 0, argv[3], 0);
        if (opened < 0) { reply_error(); close_context(&ctx); return 1; }
        int present = opened ? git_journal_present(&ctx) : 0;
        if (present < 0) { reply_error(); close_context(&ctx); return 1; }
        printf("READY\t%d\n", present);
        close_context(&ctx);
        return 0;
    }
    if (argc == 5 && !strcmp(argv[1], "metadata")) {
        Context ctx;
        int opened = open_context(&ctx, argv[2], 0, strcmp(argv[4], "-") ? argv[4] : NULL, 0);
        if (opened < 0) { reply_error(); close_context(&ctx); return 1; }
        if (!opened) { puts("READY"); close_context(&ctx); return 0; }
        char *response = NULL;
        if (read_metadata(&ctx, argv[3], &response)) { reply_error(); close_context(&ctx); return 1; }
        if (response) { printf("READY\t%s\n", response); free(response); }
        else puts("READY");
        close_context(&ctx);
        return 0;
    }
    if (argc != 4 || (strcmp(argv[1], "session") && strcmp(argv[1], "recover"))) {
        errno = EINVAL; fail("Invalid filesystem helper arguments"); reply_error(); return 1;
    }
    int session = !strcmp(argv[1], "session");
    Context ctx;
    int opened = open_context(&ctx, argv[2], session, argv[3], 1);
    if (opened < 0) { reply_error(); close_context(&ctx); return 1; }
    if (!opened) { puts("READY"); close_context(&ctx); return 0; }
    int recovered = 0;
    if (recover_journal(&ctx, &recovered)) { reply_error(); close_context(&ctx); return 1; }
    if (recovered) puts("READY\tAn interrupted skills operation was safely recovered.");
    else puts("READY");
    fflush(stdout);
    if (session) {
        char *line = NULL;
        size_t capacity = 0;
        ssize_t n;
        while ((n = getline(&line, &capacity, stdin)) >= 0) {
            detail[0] = 0;
            if ((size_t)n > MAX_COMMAND) { errno = E2BIG; fail("Boundary command is too large"); reply_error(); break; }
            char *response = NULL;
            if (do_command(&ctx, line, &response)) reply_error();
            else { if (response) printf("OK\t%s\n", response); else puts("OK"); fflush(stdout); }
            free(response);
        }
        free(line);
    }
    close_context(&ctx);
    return 0;
}
