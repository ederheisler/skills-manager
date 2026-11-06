#ifndef SKILLS_BOUNDARY_TREE_H
#define SKILLS_BOUNDARY_TREE_H

/* Descriptor-relative tree operations used only by skills-boundary.c. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#elif defined(__APPLE__)
#include <sys/mount.h>
#else
#error "tree operations require Linux or macOS"
#endif

/* Bound recursion so an untrusted tree cannot exhaust the process stack. */
#define TREE_MAX_DEPTH 512U
#define TREE_STAGED 1
#define TREE_CONTENT_ONLY 2

struct tree_sha256 {
    uint32_t state[8];
    uint64_t bytes;
    unsigned char block[64];
    size_t used;
};

static uint32_t tree_rotr32(uint32_t x, unsigned int n)
{
    return (x >> n) | (x << (32U - n));
}

static void tree_sha256_block(struct tree_sha256 *hash, const unsigned char block[64])
{
    static const uint32_t constants[64] = {
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
        0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
        0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
        0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
        0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
        0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
        0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
        0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
        0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
        0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
        0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
        0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
        0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
        0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
    };
    uint32_t words[64], a, b, c, d, e, f, g, h;
    unsigned int i;

    for (i = 0; i < 16; ++i) {
        words[i] = ((uint32_t)block[i * 4] << 24) |
                   ((uint32_t)block[i * 4 + 1] << 16) |
                   ((uint32_t)block[i * 4 + 2] << 8) |
                   (uint32_t)block[i * 4 + 3];
    }
    for (; i < 64; ++i) {
        uint32_t s0 = tree_rotr32(words[i - 15], 7) ^
                      tree_rotr32(words[i - 15], 18) ^ (words[i - 15] >> 3);
        uint32_t s1 = tree_rotr32(words[i - 2], 17) ^
                      tree_rotr32(words[i - 2], 19) ^ (words[i - 2] >> 10);
        words[i] = words[i - 16] + s0 + words[i - 7] + s1;
    }
    a = hash->state[0]; b = hash->state[1]; c = hash->state[2]; d = hash->state[3];
    e = hash->state[4]; f = hash->state[5]; g = hash->state[6]; h = hash->state[7];
    for (i = 0; i < 64; ++i) {
        uint32_t s1 = tree_rotr32(e, 6) ^ tree_rotr32(e, 11) ^ tree_rotr32(e, 25);
        uint32_t choose = (e & f) ^ (~e & g);
        uint32_t t1 = h + s1 + choose + constants[i] + words[i];
        uint32_t s0 = tree_rotr32(a, 2) ^ tree_rotr32(a, 13) ^ tree_rotr32(a, 22);
        uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = s0 + majority;
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    hash->state[0] += a; hash->state[1] += b;
    hash->state[2] += c; hash->state[3] += d;
    hash->state[4] += e; hash->state[5] += f;
    hash->state[6] += g; hash->state[7] += h;
}

static void tree_sha256_init(struct tree_sha256 *hash)
{
    static const uint32_t initial[8] = {
        0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
        0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U
    };
    memcpy(hash->state, initial, sizeof(initial));
    hash->bytes = 0;
    hash->used = 0;
}

static void tree_sha256_update(struct tree_sha256 *hash, const void *data, size_t length)
{
    const unsigned char *bytes = data;
    hash->bytes += (uint64_t)length;
    while (length != 0) {
        size_t take = sizeof(hash->block) - hash->used;
        if (take > length) take = length;
        memcpy(hash->block + hash->used, bytes, take);
        hash->used += take;
        bytes += take;
        length -= take;
        if (hash->used == sizeof(hash->block)) {
            tree_sha256_block(hash, hash->block);
            hash->used = 0;
        }
    }
}

static void tree_hash_u64(struct tree_sha256 *hash, uint64_t value)
{
    unsigned char encoded[8];
    unsigned int i;
    for (i = 0; i < 8; ++i) encoded[i] = (unsigned char)(value >> (56U - i * 8U));
    tree_sha256_update(hash, encoded, sizeof(encoded));
}

static void tree_sha256_hex(struct tree_sha256 *hash, char out[65])
{
    static const char digits[] = "0123456789abcdef";
    uint64_t bits = hash->bytes * UINT64_C(8);
    unsigned char padding[64] = { 0x80 };
    unsigned char encoded[8];
    size_t padding_length = hash->used < 56 ? 56 - hash->used : 120 - hash->used;
    unsigned int i;

    for (i = 0; i < 8; ++i) encoded[i] = (unsigned char)(bits >> (56U - i * 8U));
    tree_sha256_update(hash, padding, padding_length);
    tree_sha256_update(hash, encoded, sizeof(encoded));
    for (i = 0; i < 32; ++i) {
        unsigned int byte = (hash->state[i / 4] >> (24U - (i % 4) * 8U)) & 0xffU;
        out[i * 2] = digits[byte >> 4];
        out[i * 2 + 1] = digits[byte & 15U];
    }
    out[64] = '\0';
}

static int tree_component(const char *name)
{
    if (name == NULL || name[0] == '\0' || strchr(name, '/') != NULL ||
        strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
        errno = EINVAL;
        return -1;
    }
    return 0;
}

static int tree_same_identity(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
           (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT);
}

/* atime is deliberately excluded: reading a file or directory may update it. */
static int tree_same_snapshot(const struct stat *a, const struct stat *b)
{
#if defined(__APPLE__)
    const struct timespec *am = &a->st_mtimespec, *bm = &b->st_mtimespec;
    const struct timespec *ac = &a->st_ctimespec, *bc = &b->st_ctimespec;
#else
    const struct timespec *am = &a->st_mtim, *bm = &b->st_mtim;
    const struct timespec *ac = &a->st_ctim, *bc = &b->st_ctim;
#endif
    return tree_same_identity(a, b) && a->st_mode == b->st_mode &&
           a->st_nlink == b->st_nlink && a->st_uid == b->st_uid &&
           a->st_gid == b->st_gid && a->st_rdev == b->st_rdev &&
           a->st_size == b->st_size && am->tv_sec == bm->tv_sec &&
           am->tv_nsec == bm->tv_nsec && ac->tv_sec == bc->tv_sec &&
           ac->tv_nsec == bc->tv_nsec;
}

struct tree_mount {
#if defined(__linux__)
    uint64_t id;
#else
    fsid_t id;
    dev_t dev;
#endif
};

#if defined(__linux__)
/* statx mount IDs distinguish bind mounts that have the same st_dev. */
static int tree_linux_mount(int fd, const char *name, int flags,
                            const struct stat *expected, struct tree_mount *mount)
{
#if defined(SYS_statx) && defined(STATX_MNT_ID)
    struct statx info;
    int result;
    memset(&info, 0, sizeof(info));
    do {
        result = (int)syscall(SYS_statx, fd, name, flags,
                              STATX_TYPE | STATX_INO | STATX_MNT_ID, &info);
    } while (result < 0 && errno == EINTR);
    if (result < 0) {
        if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP || errno == EPERM)
            errno = ENOTSUP;
        return -1;
    }
    if ((info.stx_mask & (STATX_TYPE | STATX_INO | STATX_MNT_ID)) !=
        (STATX_TYPE | STATX_INO | STATX_MNT_ID)) {
        errno = ENOTSUP;
        return -1;
    }
    if (expected != NULL &&
        (info.stx_ino != (uint64_t)expected->st_ino ||
         info.stx_dev_major != (uint32_t)major(expected->st_dev) ||
         info.stx_dev_minor != (uint32_t)minor(expected->st_dev) ||
         (info.stx_mode & S_IFMT) != (expected->st_mode & S_IFMT))) {
        errno = ESTALE;
        return -1;
    }
    mount->id = info.stx_mnt_id;
    return 0;
#else
    (void)fd; (void)name; (void)flags; (void)expected; (void)mount;
    errno = ENOTSUP;
    return -1;
#endif
}
#endif

static int tree_mount_fd(int fd, struct tree_mount *mount)
{
#if defined(__linux__)
    return tree_linux_mount(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, NULL, mount);
#else
    struct statfs filesystem;
    struct stat st;
    if (fstatfs(fd, &filesystem) < 0 || fstat(fd, &st) < 0) return -1;
    mount->id = filesystem.f_fsid;
    mount->dev = st.st_dev;
    return 0;
#endif
}

static int tree_same_mount(const struct tree_mount *a, const struct tree_mount *b)
{
#if defined(__linux__)
    return a->id == b->id;
#else
    return memcmp(&a->id, &b->id, sizeof(a->id)) == 0;
#endif
}

static int tree_check_mount_fd(int fd, const struct tree_mount *boundary)
{
    struct tree_mount current;
    if (tree_mount_fd(fd, &current) < 0) return -1;
    if (!tree_same_mount(boundary, &current)) {
        errno = EXDEV;
        return -1;
    }
    return 0;
}

/* Check entries without opening them; in particular, never open a link target. */
static int tree_check_mount_entry(int parentfd, const char *name,
                                  const struct stat *st,
                                  const struct tree_mount *boundary)
{
#if defined(__linux__)
    struct tree_mount current;
    if (tree_linux_mount(parentfd, name, AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT,
                         st, &current) < 0) return -1;
    if (boundary != NULL && !tree_same_mount(boundary, &current)) {
        errno = EXDEV;
        return -1;
    }
#else
    (void)parentfd; (void)name;
    if (boundary != NULL && st->st_dev != boundary->dev) {
        errno = EXDEV;
        return -1;
    }
#endif
    return 0;
}

static int tree_check_source(int parentfd, const char *name, int fd,
                             const struct stat *before,
                             const struct tree_mount *boundary)
{
    struct stat opened, entry;
    if (fstat(fd, &opened) < 0 ||
        fstatat(parentfd, name, &entry, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (!tree_same_snapshot(before, &opened) || !tree_same_snapshot(before, &entry)) {
        errno = ESTALE;
        return -1;
    }
    return tree_check_mount_entry(parentfd, name, &entry, boundary);
}

static int tree_check_created(int parentfd, const char *name, int fd,
                              const struct stat *created,
                              const struct tree_mount *boundary)
{
    struct stat opened, entry;
    if (fstat(fd, &opened) < 0 ||
        fstatat(parentfd, name, &entry, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (!tree_same_identity(created, &opened) || !tree_same_identity(created, &entry) ||
        (S_ISREG(opened.st_mode) && opened.st_nlink != 1)) {
        errno = ESTALE;
        return -1;
    }
    return tree_check_mount_entry(parentfd, name, &entry, boundary);
}

struct tree_names {
    char **items;
    size_t count;
    size_t capacity;
};

static void tree_names_free(struct tree_names *names)
{
    size_t i;
    for (i = 0; i < names->count; ++i) free(names->items[i]);
    free(names->items);
    names->items = NULL;
    names->count = names->capacity = 0;
}

static int tree_name_compare(const void *a, const void *b)
{
    const char *const *left = a, *const *right = b;
    return strcmp(*left, *right);
}

/* The optional snapshot checks every readdir, not just the initial listing. */
static int tree_names_read(int fd, int parentfd, const char *name,
                           const struct stat *snapshot, const struct tree_mount *boundary,
                           struct tree_names *names)
{
    DIR *dir;
    int duplicate, result = -1, saved = 0;
    memset(names, 0, sizeof(*names));
    duplicate = dup(fd);
    if (duplicate < 0) return -1;
    dir = fdopendir(duplicate);
    if (dir == NULL) {
        saved = errno;
        close(duplicate);
        errno = saved;
        return -1;
    }
    /* dup shares the directory state: refresh a view opened before its
       children were created (for example on Linux overlayfs). */
    rewinddir(dir);
    for (;;) {
        struct dirent *entry;
        int read_error;
        char *copy;
        size_t length;
        if (snapshot != NULL && tree_check_source(parentfd, name, fd, snapshot, boundary) < 0)
            goto done;
        errno = 0;
        entry = readdir(dir);
        read_error = errno;
        if (snapshot != NULL && tree_check_source(parentfd, name, fd, snapshot, boundary) < 0)
            goto done;
        if (entry == NULL) {
            if (read_error != 0) { errno = read_error; goto done; }
            break;
        }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
            continue;
        if (tree_component(entry->d_name) < 0) goto done;
        if (names->count == names->capacity) {
            size_t capacity = names->capacity == 0 ? 16 : names->capacity * 2;
            char **items;
            if (capacity < names->capacity || capacity > SIZE_MAX / sizeof(*items)) {
                errno = ENOMEM;
                goto done;
            }
            items = realloc(names->items, capacity * sizeof(*items));
            if (items == NULL) goto done;
            names->items = items;
            names->capacity = capacity;
        }
        length = strlen(entry->d_name);
        copy = malloc(length + 1);
        if (copy == NULL) goto done;
        memcpy(copy, entry->d_name, length + 1);
        names->items[names->count++] = copy;
    }
    if (names->count > 1) qsort(names->items, names->count, sizeof(*names->items), tree_name_compare);
    result = 0;
done:
    saved = errno;
    if (closedir(dir) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) {
        tree_names_free(names);
        errno = saved;
    }
    return result;
}

static void tree_hash_object(struct tree_sha256 *hash, unsigned char type,
                             const struct stat *st, int content_only)
{
    tree_sha256_update(hash, &type, 1);
    tree_hash_u64(hash, (uint64_t)(st->st_mode & 07777));
    if (!content_only) {
        tree_hash_u64(hash, (uint64_t)st->st_dev);
        tree_hash_u64(hash, (uint64_t)st->st_ino);
    }
}

struct tree_walk {
    struct tree_sha256 hash;
    struct tree_mount source_mount;
    struct tree_mount destination_mount;
    struct stat destination_root;
    int source_mount_set;
    int destination_root_set;
    int staged;
    int content_only;
    int copying;
};

static int tree_source_mount(struct tree_walk *walk, int fd)
{
    if (!walk->source_mount_set) {
        if (tree_mount_fd(fd, &walk->source_mount) < 0) return -1;
        walk->source_mount_set = 1;
        return 0;
    }
    return tree_check_mount_fd(fd, &walk->source_mount);
}

static int tree_write_all(int fd, const unsigned char *data, size_t length)
{
    while (length != 0) {
        ssize_t count = write(fd, data, length);
        if (count < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (count == 0) { errno = EIO; return -1; }
        data += (size_t)count;
        length -= (size_t)count;
    }
    return 0;
}

static int tree_read_file(struct tree_walk *walk, int parentfd, const char *name,
                          int fd, const struct stat *st, int destination)
{
    unsigned char buffer[65536];
    uint64_t total = 0;
    if (st->st_size < 0) { errno = EIO; return -1; }
    tree_hash_object(&walk->hash, 'F', st, walk->content_only);
    tree_hash_u64(&walk->hash, (uint64_t)st->st_size);
    for (;;) {
        ssize_t count;
        if (tree_check_source(parentfd, name, fd, st, &walk->source_mount) < 0) return -1;
        count = read(fd, buffer, sizeof(buffer));
        if (count < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (tree_check_source(parentfd, name, fd, st, &walk->source_mount) < 0) return -1;
        if (count == 0) break;
        if ((uint64_t)count > (uint64_t)st->st_size - total) { errno = ESTALE; return -1; }
        total += (uint64_t)count;
        tree_sha256_update(&walk->hash, buffer, (size_t)count);
        if (destination >= 0 && tree_write_all(destination, buffer, (size_t)count) < 0) return -1;
    }
    if (total != (uint64_t)st->st_size) { errno = ESTALE; return -1; }
    return 0;
}

static int tree_hash_link(struct tree_walk *walk, int parentfd, const char *name,
                          const struct stat *before)
{
    size_t capacity = 256;
    char *target = NULL;
    int result = -1, saved;
    if (before->st_size > 0 && (uintmax_t)before->st_size < (uintmax_t)(SIZE_MAX - 1))
        capacity = (size_t)before->st_size + 1;
    for (;;) {
        struct stat after;
        ssize_t length;
        char *larger = realloc(target, capacity);
        if (larger == NULL) goto done;
        target = larger;
        length = readlinkat(parentfd, name, target, capacity);
        if (length < 0) goto done;
        if (fstatat(parentfd, name, &after, AT_SYMLINK_NOFOLLOW) < 0) goto done;
        if (!tree_same_snapshot(before, &after)) { errno = ESTALE; goto done; }
        if (tree_check_mount_entry(parentfd, name, &after,
                                   walk->source_mount_set ? &walk->source_mount : NULL) < 0)
            goto done;
        if ((size_t)length < capacity) {
            tree_hash_object(&walk->hash, 'L', before, walk->content_only);
            tree_hash_u64(&walk->hash, (uint64_t)length);
            tree_sha256_update(&walk->hash, target, (size_t)length);
            result = 0;
            break;
        }
        if (capacity > SIZE_MAX / 2) { errno = ENOMEM; goto done; }
        capacity *= 2;
    }
done:
    saved = errno;
    free(target);
    if (result < 0) errno = saved;
    return result;
}

static int tree_walk_entry(struct tree_walk *walk, int parentfd, const char *name,
                           int destination_parent, const char *destination_name,
                           unsigned int depth)
{
    struct stat before, opened, destination_stat;
    struct tree_names names = { 0 }, destination_names = { 0 };
    int fd = -1, destination = -1, result = -1, saved;
    size_t i;
    int is_root = depth == 0;

    if (depth > TREE_MAX_DEPTH) { errno = ELOOP; return -1; }
    if (fstatat(parentfd, name, &before, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (is_root && walk->staged && !S_ISDIR(before.st_mode)) { errno = ENOTDIR; return -1; }
    if (S_ISLNK(before.st_mode)) {
        if (walk->staged) { errno = ELOOP; return -1; }
        if (tree_check_mount_entry(parentfd, name, &before,
                                   walk->source_mount_set ? &walk->source_mount : NULL) < 0)
            return -1;
        return tree_hash_link(walk, parentfd, name, &before);
    }
    if (!S_ISDIR(before.st_mode) && !S_ISREG(before.st_mode)) { errno = ENOTSUP; return -1; }
    if (walk->staged && S_ISREG(before.st_mode) && before.st_nlink != 1) {
        errno = EPERM;
        return -1;
    }
    /* O_NONBLOCK prevents a swapped-in FIFO from blocking before fstat. */
    fd = openat(parentfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK |
                (S_ISDIR(before.st_mode) ? O_DIRECTORY : 0));
    if (fd < 0) return -1;
    if (fstat(fd, &opened) < 0) goto done;
    if (!tree_same_snapshot(&before, &opened)) { errno = ESTALE; goto done; }
    if (tree_source_mount(walk, fd) < 0 ||
        tree_check_source(parentfd, name, fd, &before, &walk->source_mount) < 0) goto done;
    if (walk->copying && walk->destination_root_set && S_ISDIR(before.st_mode) &&
        tree_same_identity(&before, &walk->destination_root)) {
        errno = EINVAL;
        goto done;
    }

    if (S_ISREG(before.st_mode)) {
        if (walk->copying) {
            destination = openat(destination_parent, destination_name,
                                 O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
            if (destination < 0) goto done;
            if (fstat(destination, &destination_stat) < 0) goto done;
            if (!S_ISREG(destination_stat.st_mode) || destination_stat.st_nlink != 1) {
                errno = ESTALE;
                goto done;
            }
            if (tree_check_mount_fd(destination, &walk->destination_mount) < 0 ||
                tree_check_created(destination_parent, destination_name, destination,
                                   &destination_stat, &walk->destination_mount) < 0) goto done;
        }
        if (tree_read_file(walk, parentfd, name, fd, &before, destination) < 0) goto done;
        if (destination >= 0) {
            if (tree_check_created(destination_parent, destination_name, destination,
                                   &destination_stat, &walk->destination_mount) < 0 ||
                fchmod(destination, before.st_mode & 07777) < 0 || fsync(destination) < 0 ||
                fstat(destination, &opened) < 0) goto done;
            if ((opened.st_mode & 07777) != (before.st_mode & 07777)) { errno = EPERM; goto done; }
            if (tree_check_created(destination_parent, destination_name, destination,
                                   &destination_stat, &walk->destination_mount) < 0) goto done;
        }
        if (tree_check_source(parentfd, name, fd, &before, &walk->source_mount) < 0) goto done;
        result = 0;
        goto done;
    }

    if (tree_names_read(fd, parentfd, name, &before, &walk->source_mount, &names) < 0) goto done;
    tree_hash_object(&walk->hash, 'D', &before, walk->content_only);
    tree_hash_u64(&walk->hash, (uint64_t)names.count);
    if (walk->copying) {
        if (mkdirat(destination_parent, destination_name, 0700) < 0) goto done;
        if (fstatat(destination_parent, destination_name, &destination_stat,
                    AT_SYMLINK_NOFOLLOW) < 0) goto done;
        if (!S_ISDIR(destination_stat.st_mode) || destination_stat.st_uid != geteuid() ||
            (destination_stat.st_mode & 077) != 0) { errno = ESTALE; goto done; }
        destination = openat(destination_parent, destination_name,
                             O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (destination < 0) goto done;
        if (tree_check_mount_fd(destination, &walk->destination_mount) < 0 ||
            tree_check_created(destination_parent, destination_name, destination,
                               &destination_stat, &walk->destination_mount) < 0) goto done;
        /* Remove inherited setgid and compensate for restrictive umasks when possible. */
        if (fchmod(destination, 0700) < 0) goto done;
        if (is_root) {
            walk->destination_root = destination_stat;
            walk->destination_root_set = 1;
        }
    }
    for (i = 0; i < names.count; ++i) {
        size_t length = strlen(names.items[i]);
        tree_hash_u64(&walk->hash, (uint64_t)length);
        tree_sha256_update(&walk->hash, names.items[i], length);
        if (tree_walk_entry(walk, fd, names.items[i], destination, names.items[i], depth + 1) < 0)
            goto done;
    }
    if (tree_check_source(parentfd, name, fd, &before, &walk->source_mount) < 0) goto done;
    if (destination >= 0) {
        if (tree_check_created(destination_parent, destination_name, destination,
                               &destination_stat, &walk->destination_mount) < 0 ||
            fsync(destination) < 0 || fchmod(destination, before.st_mode & 07777) < 0 ||
            fsync(destination) < 0 ||
            fstat(destination, &opened) < 0) goto done;
        if ((opened.st_mode & 07777) != (before.st_mode & 07777)) { errno = EPERM; goto done; }
        if (tree_names_read(destination, destination_parent, destination_name, &opened,
                            &walk->destination_mount, &destination_names) < 0) goto done;
        if (names.count != destination_names.count) { errno = ESTALE; goto done; }
        for (i = 0; i < names.count; ++i) {
            if (strcmp(names.items[i], destination_names.items[i]) != 0) {
                errno = ESTALE;
                goto done;
            }
        }
        if (tree_check_created(destination_parent, destination_name, destination,
                               &destination_stat, &walk->destination_mount) < 0 ||
            tree_check_source(parentfd, name, fd, &before, &walk->source_mount) < 0) goto done;
    }
    result = 0;
done:
    saved = errno;
    tree_names_free(&destination_names);
    tree_names_free(&names);
    if (destination >= 0 && close(destination) < 0 && result == 0) { saved = errno; result = -1; }
    if (fd >= 0 && close(fd) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) errno = saved;
    return result;
}

/* Mode bit 1 enforces staged input; bit 2 omits inode identity for provenance. */
static int tree_fingerprint_at(int parentfd, const char *name, int staged, char out[65])
{
    struct tree_walk walk;
    if (out == NULL || (staged & ~(TREE_STAGED | TREE_CONTENT_ONLY)) != 0 ||
        tree_component(name) < 0) {
        errno = EINVAL;
        return -1;
    }
    memset(&walk, 0, sizeof(walk));
    walk.staged = (staged & TREE_STAGED) != 0;
    walk.content_only = (staged & TREE_CONTENT_ONLY) != 0;
    tree_sha256_init(&walk.hash);
    if (tree_walk_entry(&walk, parentfd, name, -1, NULL, 0) < 0) return -1;
    tree_sha256_hex(&walk.hash, out);
    return 0;
}

static inline int tree_copy_at(int srcparent, const char *srcname, int dstparent,
                        const char *dstname, char source_fingerprint[65])
{
    struct tree_walk walk;
    if (source_fingerprint == NULL || srcname == NULL ||
        (strcmp(srcname, ".") != 0 && tree_component(srcname) < 0) ||
        tree_component(dstname) < 0) {
        errno = EINVAL;
        return -1;
    }
    memset(&walk, 0, sizeof(walk));
    walk.staged = 1;
    walk.copying = 1;
    tree_sha256_init(&walk.hash);
    if (tree_mount_fd(dstparent, &walk.destination_mount) < 0) return -1;
    if (tree_walk_entry(&walk, srcparent, srcname, dstparent, dstname, 0) < 0) return -1;
    if (fsync(dstparent) < 0) return -1;
    tree_sha256_hex(&walk.hash, source_fingerprint);
    return 0;
}

static int tree_remove_entry(int parentfd, const char *name,
                             const struct tree_mount *boundary, unsigned int depth,
                             const struct stat *expected)
{
    struct stat before, opened, entry;
    struct tree_mount root_mount;
    struct tree_names names = { 0 };
    int fd = -1, result = -1, saved;
    size_t i;

    if (depth > TREE_MAX_DEPTH) { errno = ELOOP; return -1; }
    if (fstatat(parentfd, name, &before, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (expected != NULL && !tree_same_identity(expected, &before)) {
        errno = ESTALE;
        return -1;
    }
    if (!S_ISDIR(before.st_mode)) {
        if (!S_ISREG(before.st_mode) && !S_ISLNK(before.st_mode)) { errno = ENOTSUP; return -1; }
        if (tree_check_mount_entry(parentfd, name, &before, boundary) < 0 ||
            fstatat(parentfd, name, &entry, AT_SYMLINK_NOFOLLOW) < 0) return -1;
        if (!tree_same_identity(&before, &entry)) { errno = ESTALE; return -1; }
        return unlinkat(parentfd, name, 0);
    }
    fd = openat(parentfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return -1;
    if (fstat(fd, &opened) < 0) goto done;
    if (!tree_same_identity(&before, &opened) ||
        (expected != NULL && !tree_same_identity(expected, &opened))) {
        errno = ESTALE;
        goto done;
    }
    if (boundary == NULL) {
        if (tree_mount_fd(fd, &root_mount) < 0) goto done;
        boundary = &root_mount;
    } else if (tree_check_mount_fd(fd, boundary) < 0) goto done;
    if (tree_check_mount_entry(parentfd, name, &opened, boundary) < 0) goto done;
    /* A read-only quarantined directory may still be removable by its owner. */
    if ((opened.st_mode & 0700) != 0700 &&
        (opened.st_uid == geteuid() || geteuid() == 0) &&
        fchmod(fd, (opened.st_mode & 07777) | 0700) < 0) goto done;
    if (tree_names_read(fd, -1, NULL, NULL, NULL, &names) < 0) goto done;
    for (i = 0; i < names.count; ++i) {
        if (tree_remove_entry(fd, names.items[i], boundary, depth + 1, NULL) < 0) goto done;
    }
    if (fstatat(parentfd, name, &entry, AT_SYMLINK_NOFOLLOW) < 0) goto done;
    if (!tree_same_identity(&opened, &entry)) { errno = ESTALE; goto done; }
    if (tree_check_mount_entry(parentfd, name, &entry, boundary) < 0) goto done;
    if (unlinkat(parentfd, name, AT_REMOVEDIR) < 0) goto done;
    result = 0;
done:
    saved = errno;
    tree_names_free(&names);
    if (close(fd) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) errno = saved;
    return result;
}

/* Require both the previously verified object and its mount. */
static inline int tree_remove_known_at(int parentfd, const char *name, const struct stat *expected,
                                const struct tree_mount *boundary)
{
    if (expected == NULL || boundary == NULL) { errno = EINVAL; return -1; }
    if (tree_component(name) < 0) return -1;
    return tree_remove_entry(parentfd, name, boundary, 0, expected);
}

static inline int tree_remove_at(int parentfd, const char *name)
{
    if (tree_component(name) < 0) return -1;
    return tree_remove_entry(parentfd, name, NULL, 0, NULL);
}

#endif
