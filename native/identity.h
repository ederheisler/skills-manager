#ifndef SKILLS_BOUNDARY_IDENTITY_H
#define SKILLS_BOUNDARY_IDENTITY_H

#include <errno.h>
#include <stdint.h>
#include <sys/stat.h>

#include "tree.h"

/* Directory contents and timestamps may change without changing this identity. */
static int boundary_identity_fd(int fd, char hex[65])
{
    static const char domain[] = "skills-manager-directory-identity-v1";
    struct tree_sha256 hash;
    struct tree_mount mount;
    struct stat st;

    if (fstat(fd, &st) < 0) return -1;
    if (!S_ISDIR(st.st_mode)) { errno = ENOTDIR; return -1; }
    if (tree_mount_fd(fd, &mount) < 0) return -1;
    tree_sha256_init(&hash);
    tree_sha256_update(&hash, domain, sizeof(domain) - 1);
    tree_hash_u64(&hash, (uint64_t)st.st_dev);
    tree_hash_u64(&hash, (uint64_t)st.st_ino);
#if defined(__linux__)
    tree_hash_u64(&hash, mount.id);
#else
    tree_sha256_update(&hash, &mount.id, sizeof(mount.id));
#endif
    tree_sha256_hex(&hash, hex);
    return 0;
}

#endif /* SKILLS_BOUNDARY_IDENTITY_H */
