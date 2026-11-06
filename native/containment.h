#ifndef SKILLS_CONTAINMENT_H
#define SKILLS_CONTAINMENT_H

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/sysmacros.h>
#endif

/* Git opens the system discard device read/write. Never grant this exception
 * to a regular file, symlink, or a different character device. */
static int skills_boundary_null_device(void)
{
    struct stat st;
    if (lstat("/dev/null", &st) < 0) return -1;
#if defined(__APPLE__)
    const unsigned int expected_major = 3, expected_minor = 2;
#else
    const unsigned int expected_major = 1, expected_minor = 3;
#endif
    if (!S_ISCHR(st.st_mode) || major(st.st_rdev) != expected_major ||
        minor(st.st_rdev) != expected_minor) {
        errno = ENODEV;
        return -1;
    }
    return 0;
}

/* The caller opens and verifies these directory descriptors before entering the
 * boundary. Only the named directories and their descendants may be written. */
static int skills_boundary_directory(int fd, const char *path)
{
    struct stat st;
    if (fd < 0 || !path || path[0] != '/' || path[1] == '\0') {
        errno = EINVAL;
        return -1;
    }
    if (fstat(fd, &st) < 0) return -1;
    if (!S_ISDIR(st.st_mode)) { errno = ENOTDIR; return -1; }
    return 0;
}


#if defined(__linux__)
#include <sys/prctl.h>
#include <sys/syscall.h>

/* These syscall numbers are the same on the supported Linux x86_64 and
 * aarch64 ABIs. Defining the tiny UAPI subset here also permits building with
 * glibc development headers older than the running kernel. */
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif

#define SKILLS_LL_VERSION 1U
#define SKILLS_LL_PATH_BENEATH 1
#define SKILLS_LL_WRITE_FILE (UINT64_C(1) << 1)
#define SKILLS_LL_REMOVE_DIR (UINT64_C(1) << 4)
#define SKILLS_LL_REMOVE_FILE (UINT64_C(1) << 5)
#define SKILLS_LL_MAKE_CHAR (UINT64_C(1) << 6)
#define SKILLS_LL_MAKE_DIR (UINT64_C(1) << 7)
#define SKILLS_LL_MAKE_REG (UINT64_C(1) << 8)
#define SKILLS_LL_MAKE_SOCK (UINT64_C(1) << 9)
#define SKILLS_LL_MAKE_FIFO (UINT64_C(1) << 10)
#define SKILLS_LL_MAKE_BLOCK (UINT64_C(1) << 11)
#define SKILLS_LL_MAKE_SYM (UINT64_C(1) << 12)
#define SKILLS_LL_REFER (UINT64_C(1) << 13)
#define SKILLS_LL_TRUNCATE (UINT64_C(1) << 14)
#define SKILLS_LL_IOCTL_DEV (UINT64_C(1) << 15)

struct skills_landlock_ruleset { uint64_t handled_access_fs; };
struct skills_landlock_path { uint64_t allowed_access; int32_t parent_fd; };

static int skills_apply_write_boundary_with_remote(int root_fd, const char *root_path,
                                                   int common_fd, const char *common_path,
                                                   int remote_fd, const char *remote_path)
{
    const uint64_t permitted = SKILLS_LL_WRITE_FILE | SKILLS_LL_REMOVE_DIR |
        SKILLS_LL_REMOVE_FILE | SKILLS_LL_MAKE_DIR | SKILLS_LL_MAKE_REG |
        SKILLS_LL_MAKE_SYM | SKILLS_LL_REFER | SKILLS_LL_TRUNCATE;
    const struct skills_landlock_ruleset attr = { permitted | SKILLS_LL_MAKE_CHAR |
        SKILLS_LL_MAKE_SOCK | SKILLS_LL_MAKE_FIFO | SKILLS_LL_MAKE_BLOCK | SKILLS_LL_IOCTL_DEV };
    int paths[3] = { root_fd, common_fd, remote_fd };
    if (skills_boundary_directory(root_fd, root_path) < 0 ||
        (common_fd >= 0 && skills_boundary_directory(common_fd, common_path) < 0) ||
        (remote_fd >= 0 && skills_boundary_directory(remote_fd, remote_path) < 0) ||
        ((common_fd < 0) != (common_path == NULL)) ||
        ((remote_fd < 0) != (remote_path == NULL))) {
        if ((common_fd < 0) != (common_path == NULL) || (remote_fd < 0) != (remote_path == NULL)) errno = EINVAL;
        return -1;
    }
    if (skills_boundary_null_device() < 0) return -1;
    int null_fd = open("/dev/null", O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (null_fd < 0) return -1;
    struct stat null_st;
    if (fstat(null_fd, &null_st) < 0) {
        int saved = errno; close(null_fd); errno = saved; return -1;
    }
    if (!S_ISCHR(null_st.st_mode) || major(null_st.st_rdev) != 1 || minor(null_st.st_rdev) != 3) {
        close(null_fd); errno = ENODEV; return -1;
    }


    long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, SKILLS_LL_VERSION);
    /* ABI 3 adds truncate, and ABI 5 closes the device-ioctl gap. */
    if (abi < 5) { close(null_fd); errno = ENOTSUP; return -1; }
    int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (ruleset < 0) { int saved = errno; close(null_fd); errno = saved; return -1; }
    const struct skills_landlock_path null_rule = { SKILLS_LL_WRITE_FILE, null_fd };
    if (syscall(SYS_landlock_add_rule, ruleset, SKILLS_LL_PATH_BENEATH, &null_rule, 0) < 0) {
        int saved = errno; close(null_fd); close(ruleset); errno = saved; return -1;
    }
    close(null_fd);
    for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); ++i) {
        if (paths[i] < 0) continue;
        const struct skills_landlock_path rule = { permitted, paths[i] };
        if (syscall(SYS_landlock_add_rule, ruleset, SKILLS_LL_PATH_BENEATH, &rule, 0) < 0) {
            int saved = errno; close(ruleset); errno = saved; return -1;
        }
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
        syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) {
        int saved = errno; close(ruleset); errno = saved; return -1;
    }
    close(ruleset);
    return 0;
}

#elif defined(__APPLE__)
#include <sandbox.h>

/* A path-based Seatbelt rule must refer to the object the caller pinned, not
 * a replacement installed between opening the root and compiling the rule. */
static int skills_boundary_path_matches(int approved, const char *path)
{
    char *copy = strdup(path);
    if (!copy) return -1;
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) { free(copy); return -1; }
    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        if (!strcmp(part, ".") || !strcmp(part, "..")) {
            close(fd); free(copy); errno = EINVAL; return -1;
        }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) { int saved = errno; close(fd); free(copy); errno = saved; return -1; }
        close(fd);
        fd = next;
    }
    struct stat expected, current;
    int result = fstat(approved, &expected) || fstat(fd, &current);
    if (!result && (expected.st_dev != current.st_dev || expected.st_ino != current.st_ino)) {
        errno = ESTALE;
        result = -1;
    }
    int saved = errno;
    close(fd);
    free(copy);
    errno = saved;
    return result ? -1 : 0;
}

static int skills_boundary_paths_match(int root_fd, const char *root_path,
                                       int common_fd, const char *common_path,
                                       int remote_fd, const char *remote_path)
{
    return skills_boundary_path_matches(root_fd, root_path) ||
        (common_fd >= 0 && skills_boundary_path_matches(common_fd, common_path)) ||
        (remote_fd >= 0 && skills_boundary_path_matches(remote_fd, remote_path)) ? -1 : 0;
}

/* SBPL strings cannot contain unescaped quotes or backslashes. Reject ASCII
 * controls outright rather than relying on undocumented profile escape forms. */
static char *skills_boundary_escape(const char *path)
{
    if (!path || path[0] != '/' || path[1] == '\0') { errno = EINVAL; return NULL; }
    size_t length = strlen(path), size = 1;
    for (size_t i = 0; i < length; ++i) {
        unsigned char c = (unsigned char)path[i];
        if (c < 32 || c == 127) { errno = EINVAL; return NULL; }
        if (size > SIZE_MAX - 2) { errno = EOVERFLOW; return NULL; }
        size += (c == '"' || c == '\\') ? 2 : 1;
    }
    char *out = malloc(size);
    if (!out) return NULL;
    char *p = out;
    for (size_t i = 0; i < length; ++i) {
        if (path[i] == '"' || path[i] == '\\') *p++ = '\\';
        *p++ = path[i];
    }
    *p = '\0';
    return out;
}

static char *skills_write_boundary_profile(const char *root_path, const char *common_path,
                                            const char *remote_path)
{
    if (skills_boundary_null_device() < 0) return NULL;
    const char *paths[3] = { root_path, common_path, remote_path };
    char *escaped[3] = { NULL, NULL, NULL };
    const char prefix[] = "(version 1)\n(allow default)\n(deny file-write*)\n"
                          "(allow file-write-data (literal \"/dev/null\"))\n";
    const char before[] = "(allow file-write* (subpath \"";
    const char after[] = "\"))\n";
    size_t size = sizeof(prefix);
    for (size_t i = 0; i < 3; ++i) {
        if (!paths[i]) {
            if (i == 0) { errno = EINVAL; goto fail; }
            continue;
        }
        escaped[i] = skills_boundary_escape(paths[i]);
        if (!escaped[i]) goto fail;
        size_t extra = sizeof(before) - 1 + strlen(escaped[i]) + sizeof(after) - 1;
        if (size > SIZE_MAX - extra) { errno = EOVERFLOW; goto fail; }
        size += extra;
    }
    char *profile = malloc(size);
    if (!profile) goto fail;
    strcpy(profile, prefix);
    for (size_t i = 0; i < 3; ++i) if (escaped[i]) {
        strcat(profile, before);
        strcat(profile, escaped[i]);
        strcat(profile, after);
    }
    for (size_t i = 0; i < 3; ++i) free(escaped[i]);
    return profile;
fail:
    { int saved = errno; for (size_t i = 0; i < 3; ++i) free(escaped[i]); errno = saved; }
    return NULL;
}

static int skills_apply_write_boundary_with_remote(int root_fd, const char *root_path,
                                                   int common_fd, const char *common_path,
                                                   int remote_fd, const char *remote_path)
{
    if (skills_boundary_directory(root_fd, root_path) < 0 ||
        (common_fd >= 0 && skills_boundary_directory(common_fd, common_path) < 0) ||
        (remote_fd >= 0 && skills_boundary_directory(remote_fd, remote_path) < 0) ||
        ((common_fd < 0) != (common_path == NULL)) ||
        ((remote_fd < 0) != (remote_path == NULL))) {
        if ((common_fd < 0) != (common_path == NULL) || (remote_fd < 0) != (remote_path == NULL)) errno = EINVAL;
        return -1;
    }
    if (skills_boundary_paths_match(root_fd, root_path, common_fd, common_path, remote_fd, remote_path) < 0) return -1;
    char *profile = skills_write_boundary_profile(root_path, common_path, remote_path);
    if (!profile) return -1;
    char *error = NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    int result = sandbox_init(profile, 0, &error);
    if (error) sandbox_free_error(error);
#pragma clang diagnostic pop
    free(profile);
    if (result < 0) { errno = ENOTSUP; return -1; }
    if (skills_boundary_null_device() < 0) return -1;
    if (skills_boundary_paths_match(root_fd, root_path, common_fd, common_path, remote_fd, remote_path) < 0) return -1;
    return 0;
}
#else
#error "Write confinement is supported only on Linux and macOS"
#endif

static inline int skills_apply_write_boundary(int root_fd, const char *root_path,
                                       int common_fd, const char *common_path)
{
    return skills_apply_write_boundary_with_remote(root_fd, root_path, common_fd, common_path, -1, NULL);
}

#endif
