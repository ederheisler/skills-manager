#ifndef SKILLS_BOUNDARY_GIT_TREE_HASH_H
#define SKILLS_BOUNDARY_GIT_TREE_HASH_H

/* Git SHA-1 identifies recorded data objects only; it is not an authority to
 * mutate a tree and must not be used for signatures or security decisions. */
#include <dirent.h>
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

#define GIT_TREE_MAX_ENTRIES 100000U
#define GIT_TREE_MAX_BYTES UINT64_C(67108864)
#define GIT_TREE_MAX_DEPTH 128U

struct git_tree_sha1 {
    uint32_t state[5];
    uint64_t bytes;
    unsigned char block[64];
    size_t used;
};

static uint32_t git_tree_rotate_left(uint32_t value, unsigned int count)
{
    return (value << count) | (value >> (32U - count));
}

static void git_tree_sha1_block(struct git_tree_sha1 *hash,
                                const unsigned char block[64])
{
    uint32_t words[80], a, b, c, d, e;
    unsigned int i;

    for (i = 0; i < 16; ++i) {
        words[i] = ((uint32_t)block[i * 4] << 24) |
                   ((uint32_t)block[i * 4 + 1] << 16) |
                   ((uint32_t)block[i * 4 + 2] << 8) |
                   (uint32_t)block[i * 4 + 3];
    }
    for (; i < 80; ++i)
        words[i] = git_tree_rotate_left(words[i - 3] ^ words[i - 8] ^
                                        words[i - 14] ^ words[i - 16], 1);

    a = hash->state[0]; b = hash->state[1]; c = hash->state[2];
    d = hash->state[3]; e = hash->state[4];
    for (i = 0; i < 80; ++i) {
        uint32_t f, constant, temporary;
        if (i < 20) {
            f = (b & c) | (~b & d);
            constant = 0x5a827999U;
        } else if (i < 40) {
            f = b ^ c ^ d;
            constant = 0x6ed9eba1U;
        } else if (i < 60) {
            f = (b & c) | (b & d) | (c & d);
            constant = 0x8f1bbcdcU;
        } else {
            f = b ^ c ^ d;
            constant = 0xca62c1d6U;
        }
        temporary = git_tree_rotate_left(a, 5) + f + e + constant + words[i];
        e = d; d = c; c = git_tree_rotate_left(b, 30); b = a; a = temporary;
    }
    hash->state[0] += a; hash->state[1] += b; hash->state[2] += c;
    hash->state[3] += d; hash->state[4] += e;
}

static void git_tree_sha1_init(struct git_tree_sha1 *hash)
{
    static const uint32_t initial[5] = {
        0x67452301U, 0xefcdab89U, 0x98badcfeU, 0x10325476U, 0xc3d2e1f0U
    };
    memcpy(hash->state, initial, sizeof(initial));
    hash->bytes = 0;
    hash->used = 0;
}

static void git_tree_sha1_update(struct git_tree_sha1 *hash,
                                 const void *data, size_t length)
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
            git_tree_sha1_block(hash, hash->block);
            hash->used = 0;
        }
    }
}

static void git_tree_sha1_final(struct git_tree_sha1 *hash, unsigned char out[20])
{
    uint64_t bits = hash->bytes * UINT64_C(8);
    unsigned char padding[64] = { 0x80 }, encoded[8];
    size_t padding_length = hash->used < 56 ? 56 - hash->used : 120 - hash->used;
    unsigned int i;

    for (i = 0; i < 8; ++i) encoded[i] = (unsigned char)(bits >> (56U - i * 8U));
    git_tree_sha1_update(hash, padding, padding_length);
    git_tree_sha1_update(hash, encoded, sizeof(encoded));
    for (i = 0; i < 20; ++i)
        out[i] = (unsigned char)(hash->state[i / 4] >> (24U - (i % 4) * 8U));
}

static int git_tree_sha1_object(struct git_tree_sha1 *hash,
                                const char *type, uintmax_t length)
{
    char header[64];
    int size = snprintf(header, sizeof(header), "%s %ju", type, length);
    if (size < 0 || (size_t)size >= sizeof(header)) {
        errno = EOVERFLOW;
        return -1;
    }
    git_tree_sha1_init(hash);
    git_tree_sha1_update(hash, header, (size_t)size + 1);
    return 0;
}

struct git_tree_directory;

struct git_tree_entry {
    char *name;
    size_t length;
    struct stat snapshot;
    struct git_tree_directory *directory;
    unsigned char object[20];
    int included;
};

struct git_tree_directory {
    struct git_tree_entry *entries;
    size_t count, capacity, included;
};

struct git_tree_walk {
    struct tree_mount mount;
    size_t entries;
    uint64_t bytes;
    const char *failure;
};

static void git_tree_free(struct git_tree_directory *directory)
{
    size_t i;
    for (i = 0; i < directory->count; ++i) {
        struct git_tree_entry *entry = &directory->entries[i];
        if (entry->directory != NULL) {
            git_tree_free(entry->directory);
            free(entry->directory);
        }
        free(entry->name);
    }
    free(directory->entries);
}

/* Git compares a directory as though its name had a trailing slash. */
static int git_tree_entry_compare(const void *left, const void *right)
{
    const struct git_tree_entry *a = left, *b = right;
    size_t common = a->length < b->length ? a->length : b->length;
    int comparison = memcmp(a->name, b->name, common);
    unsigned int ac, bc;
    if (comparison != 0) return comparison;
    ac = a->length == common ? (S_ISDIR(a->snapshot.st_mode) ? '/' : 0) :
                               (unsigned char)a->name[common];
    bc = b->length == common ? (S_ISDIR(b->snapshot.st_mode) ? '/' : 0) :
                               (unsigned char)b->name[common];
    return (int)ac - (int)bc;
}

static int git_tree_check_directory(struct git_tree_walk *walk, int parentfd,
                                    const char *name, int fd,
                                    const struct stat *snapshot)
{
    struct stat current;
    if (parentfd >= 0) {
        if (tree_check_source(parentfd, name, fd, snapshot, &walk->mount) < 0)
            return -1;
    } else {
        if (fstat(fd, &current) < 0) return -1;
        if (!tree_same_snapshot(snapshot, &current)) { errno = ESTALE; return -1; }
    }
    return tree_check_mount_fd(fd, &walk->mount);
}

/* Check both the name and the pinned descriptor, before any contents are read. */
static int git_tree_open_entry(struct git_tree_walk *walk, int parentfd,
                               const struct git_tree_entry *entry)
{
    struct stat current;
    int fd, saved;
    if (fstatat(parentfd, entry->name, &current, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (!tree_same_snapshot(&entry->snapshot, &current)) { errno = ESTALE; return -1; }
    if (tree_check_mount_entry(parentfd, entry->name, &current, &walk->mount) < 0)
        return -1;
    fd = openat(parentfd, entry->name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC |
                (S_ISDIR(current.st_mode) ? O_DIRECTORY : 0));
    if (fd < 0) return -1;
    if (tree_check_source(parentfd, entry->name, fd, &entry->snapshot, &walk->mount) < 0 ||
        tree_check_mount_fd(fd, &walk->mount) < 0) {
        saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    return fd;
}

static int git_tree_close(int fd, int result)
{
    int saved = errno;
    if (close(fd) < 0 && result == 0) return -1;
    if (result < 0) errno = saved;
    return result;
}

static int git_tree_add_entry(struct git_tree_directory *directory,
                              const char *name, size_t length,
                              const struct stat *snapshot)
{
    struct git_tree_entry *entry;
    char *copy;
    if (directory->count == directory->capacity) {
        size_t capacity = directory->capacity == 0 ? 16 : directory->capacity * 2;
        struct git_tree_entry *entries;
        if (capacity > GIT_TREE_MAX_ENTRIES) capacity = GIT_TREE_MAX_ENTRIES;
        if (capacity <= directory->capacity || capacity > SIZE_MAX / sizeof(*entries)) {
            errno = EOVERFLOW;
            return -1;
        }
        entries = realloc(directory->entries, capacity * sizeof(*entries));
        if (entries == NULL) return -1;
        directory->entries = entries;
        directory->capacity = capacity;
    }
    if (length == SIZE_MAX) { errno = EOVERFLOW; return -1; }
    copy = malloc(length + 1);
    if (copy == NULL) return -1;
    memcpy(copy, name, length + 1);
    entry = &directory->entries[directory->count++];
    memset(entry, 0, sizeof(*entry));
    entry->name = copy;
    entry->length = length;
    entry->snapshot = *snapshot;
    return 0;
}

static int git_tree_scan_directory(struct git_tree_walk *walk, int fd,
                                   unsigned int depth,
                                   struct git_tree_directory *directory)
{
    DIR *stream;
    int duplicate, result = -1, saved;
    duplicate = dup(fd);
    if (duplicate < 0) return -1;
    stream = fdopendir(duplicate);
    if (stream == NULL) {
        saved = errno;
        close(duplicate);
        errno = saved;
        return -1;
    }
    for (;;) {
        struct dirent *item;
        struct stat snapshot;
        size_t length;
        errno = 0;
        item = readdir(stream);
        if (item == NULL) {
            if (errno != 0) goto done;
            break;
        }
        if (strcmp(item->d_name, ".") == 0 || strcmp(item->d_name, "..") == 0)
            continue;
        if (walk->entries >= GIT_TREE_MAX_ENTRIES) {
            walk->failure = "Git tree entry limit exceeded (100000)";
            errno = E2BIG;
            goto done;
        }
        ++walk->entries;
        if (strcmp(item->d_name, ".git") == 0) continue;
        if (depth >= GIT_TREE_MAX_DEPTH) {
            walk->failure = "Git tree depth limit exceeded (128)";
            errno = E2BIG;
            goto done;
        }
        if (tree_component(item->d_name) < 0) goto done;
        length = strlen(item->d_name);
        if (fstatat(fd, item->d_name, &snapshot, AT_SYMLINK_NOFOLLOW) < 0) goto done;
        if (S_ISLNK(snapshot.st_mode)) {
            walk->failure = "Git tree contains a symbolic link";
            errno = ELOOP;
            goto done;
        }
        if (!S_ISREG(snapshot.st_mode) && !S_ISDIR(snapshot.st_mode)) {
            walk->failure = "Git tree contains a special file";
            errno = ENOTSUP;
            goto done;
        }
        if (S_ISREG(snapshot.st_mode)) {
            if (snapshot.st_nlink != 1) {
                walk->failure = "Git tree contains a hard-linked regular file";
                errno = EMLINK;
                goto done;
            }
            if (snapshot.st_size < 0) { errno = EIO; goto done; }
            if ((uintmax_t)snapshot.st_size > (uintmax_t)(GIT_TREE_MAX_BYTES - walk->bytes)) {
                walk->failure = "Git tree input limit exceeded (64 MiB)";
                errno = E2BIG;
                goto done;
            }
            walk->bytes += (uint64_t)snapshot.st_size;
        }
        if (tree_check_mount_entry(fd, item->d_name, &snapshot, &walk->mount) < 0 ||
            git_tree_add_entry(directory, item->d_name, length, &snapshot) < 0)
            goto done;
    }
    result = 0;
done:
    saved = errno;
    if (closedir(stream) < 0 && result == 0) { saved = errno; result = -1; }
    if (result < 0) errno = saved;
    return result;
}

static int git_tree_hash_blob(struct git_tree_walk *walk, int parentfd,
                              const struct git_tree_entry *entry, int fd,
                              unsigned char out[20])
{
    struct git_tree_sha1 hash;
    unsigned char buffer[65536];
    uint64_t total = 0, expected = (uint64_t)entry->snapshot.st_size;
    if (git_tree_sha1_object(&hash, "blob", (uintmax_t)expected) < 0) return -1;
    for (;;) {
        ssize_t count;
        if (tree_check_source(parentfd, entry->name, fd, &entry->snapshot, &walk->mount) < 0 ||
            tree_check_mount_fd(fd, &walk->mount) < 0) return -1;
        count = read(fd, buffer, sizeof(buffer));
        if (count < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (tree_check_source(parentfd, entry->name, fd, &entry->snapshot, &walk->mount) < 0 ||
            tree_check_mount_fd(fd, &walk->mount) < 0) return -1;
        if (count == 0) break;
        if ((uint64_t)count > expected - total) { errno = ESTALE; return -1; }
        total += (uint64_t)count;
        git_tree_sha1_update(&hash, buffer, (size_t)count);
    }
    if (total != expected) { errno = ESTALE; return -1; }
    git_tree_sha1_final(&hash, out);
    return 0;
}

static int git_tree_hash_directory(struct git_tree_walk *walk, int parentfd,
                                   const char *name, int fd,
                                   const struct stat *snapshot, unsigned int depth,
                                   struct git_tree_directory *directory,
                                   unsigned char out[20])
{
    struct git_tree_sha1 hash;
    size_t i, object_size = 0;
    if (git_tree_check_directory(walk, parentfd, name, fd, snapshot) < 0 ||
        git_tree_scan_directory(walk, fd, depth, directory) < 0 ||
        git_tree_check_directory(walk, parentfd, name, fd, snapshot) < 0)
        return -1;
    if (directory->count > 1)
        qsort(directory->entries, directory->count, sizeof(*directory->entries),
              git_tree_entry_compare);
    for (i = 0; i < directory->count; ++i) {
        struct git_tree_entry *entry = &directory->entries[i];
        int child, result;
        if (i != 0 && strcmp(directory->entries[i - 1].name, entry->name) == 0) {
            errno = ESTALE;
            return -1;
        }
        if (git_tree_check_directory(walk, parentfd, name, fd, snapshot) < 0) return -1;
        child = git_tree_open_entry(walk, fd, entry);
        if (child < 0) return -1;
        if (S_ISDIR(entry->snapshot.st_mode)) {
            entry->directory = calloc(1, sizeof(*entry->directory));
            if (entry->directory == NULL) result = -1;
            else {
                result = git_tree_hash_directory(walk, fd, entry->name, child,
                                                 &entry->snapshot, depth + 1,
                                                 entry->directory, entry->object);
                entry->included = entry->directory->included != 0;
            }
        } else {
            result = git_tree_hash_blob(walk, fd, entry, child, entry->object);
            entry->included = 1;
        }
        if (git_tree_close(child, result) < 0) return -1;
        if (git_tree_check_directory(walk, parentfd, name, fd, snapshot) < 0) return -1;
        if (entry->included) {
            size_t mode_length = S_ISDIR(entry->snapshot.st_mode) ? 6 : 7;
            size_t entry_size;
            if (entry->length > SIZE_MAX - mode_length - 21) { errno = EOVERFLOW; return -1; }
            entry_size = mode_length + entry->length + 1 + 20;
            if (object_size > SIZE_MAX - entry_size) { errno = EOVERFLOW; return -1; }
            object_size += entry_size;
            ++directory->included;
        }
    }
    if (git_tree_sha1_object(&hash, "tree", (uintmax_t)object_size) < 0) return -1;
    for (i = 0; i < directory->count; ++i) {
        const struct git_tree_entry *entry = &directory->entries[i];
        const char *mode;
        size_t mode_length;
        if (!entry->included) continue;
        if (S_ISDIR(entry->snapshot.st_mode)) {
            mode = "40000 ";
            mode_length = 6;
        } else {
            /* Git's index normalizes the owner's execute bit to 0644 or 0755. */
            mode = (entry->snapshot.st_mode & S_IXUSR) ? "100755 " : "100644 ";
            mode_length = 7;
        }
        git_tree_sha1_update(&hash, mode, mode_length);
        git_tree_sha1_update(&hash, entry->name, entry->length + 1);
        git_tree_sha1_update(&hash, entry->object, sizeof(entry->object));
    }
    git_tree_sha1_final(&hash, out);
    return git_tree_check_directory(walk, parentfd, name, fd, snapshot);
}

/* Revisit all snapshots after hashing, so an early file changed while a later
 * subtree was read cannot silently become part of a mixed-time association. */
static int git_tree_verify_directory(struct git_tree_walk *walk, int parentfd,
                                     const char *name, int fd,
                                     const struct stat *snapshot,
                                     const struct git_tree_directory *directory)
{
    size_t i;
    if (git_tree_check_directory(walk, parentfd, name, fd, snapshot) < 0) return -1;
    for (i = 0; i < directory->count; ++i) {
        const struct git_tree_entry *entry = &directory->entries[i];
        int child, result = 0;
        if (git_tree_check_directory(walk, parentfd, name, fd, snapshot) < 0) return -1;
        child = git_tree_open_entry(walk, fd, entry);
        if (child < 0) return -1;
        if (entry->directory != NULL)
            result = git_tree_verify_directory(walk, fd, entry->name, child,
                                                &entry->snapshot, entry->directory);
        if (git_tree_close(child, result) < 0) return -1;
    }
    return git_tree_check_directory(walk, parentfd, name, fd, snapshot);
}

static int boundary_git_tree_hash(const char *canonical_dir)
{
    static const char digits[] = "0123456789abcdef";
    struct git_tree_walk walk = { 0 };
    struct git_tree_directory directory = { 0 };
    struct stat snapshot, current;
    unsigned char object[20];
    char hex[41];
    int root = -1, reopened = -1, result = -1, saved;
    unsigned int i;

    walk.failure = "Cannot safely compute Git tree hash";
    if (canonical_dir == NULL) { errno = EINVAL; goto done; }
    root = open_root(canonical_dir);
    if (root < 0 || fstat(root, &snapshot) < 0) goto done;
    if (!S_ISDIR(snapshot.st_mode)) { errno = ENOTDIR; goto done; }
    if (tree_mount_fd(root, &walk.mount) < 0 ||
        git_tree_hash_directory(&walk, -1, NULL, root, &snapshot, 0, &directory, object) < 0 ||
        git_tree_verify_directory(&walk, -1, NULL, root, &snapshot, &directory) < 0)
        goto done;

    /* A pinned descriptor alone does not prove the original path still names it. */
    reopened = open_root(canonical_dir);
    if (reopened < 0 || fstat(reopened, &current) < 0) goto done;
    if (!tree_same_snapshot(&snapshot, &current)) { errno = ESTALE; goto done; }
    if (tree_check_mount_fd(reopened, &walk.mount) < 0 ||
        git_tree_check_directory(&walk, -1, NULL, root, &snapshot) < 0) goto done;
    result = 0;
done:
    saved = errno;
    if (reopened >= 0 && close(reopened) < 0 && result == 0) { saved = errno; result = -1; }
    if (root >= 0 && close(root) < 0 && result == 0) { saved = errno; result = -1; }
    git_tree_free(&directory);
    if (result < 0) {
        errno = saved;
        return fail(walk.failure);
    }
    for (i = 0; i < 20; ++i) {
        hex[i * 2] = digits[object[i] >> 4];
        hex[i * 2 + 1] = digits[object[i] & 15U];
    }
    hex[40] = '\0';
    if (printf("READY\t%s\n", hex) < 0 || fflush(stdout) == EOF)
        return fail("Cannot report Git tree hash");
    return 0;
}

#endif
