#ifndef SKILLS_BOUNDARY_FINGERPRINT_SKILL_H
#define SKILLS_BOUNDARY_FINGERPRINT_SKILL_H

/* Included after the tree, identity, and boundary helpers in skills-boundary.c. */
static int fingerprint_skill(const char *root, const char *expected_identity,
                             const char *name, const char *location, const char *mode)
{
    int rootfd = -1, disabled = -1, reopened = -1, result = -1, saved;
    int disabled_present, active_present, inactive_present, selected_parent, present;
    int active = !strcmp(location, "active");
    struct stat disabled_dir, opened, current, active_entry, disabled_entry, selected;
    struct tree_mount mount;
    struct tree_walk walk;
    char identity[65], hash[65];

    if (!valid_name(name) || !valid_hash(expected_identity) ||
        (!active && strcmp(location, "disabled")) ||
        (strcmp(mode, "identity") && strcmp(mode, "content"))) {
        errno = EINVAL;
        return fail("Invalid skill name, root identity, reviewed location, or fingerprint mode");
    }
    rootfd = open_root(root);
    if (rootfd < 0) { fail("Cannot open the approved skills directory without following links"); goto done; }
    if (boundary_identity_fd(rootfd, identity) < 0) { fail("Cannot validate approved root identity"); goto done; }
    if (strcmp(identity, expected_identity)) {
        errno = ESTALE; fail("Selected directory changed since approval"); goto done;
    }
    if (tree_mount_fd(rootfd, &mount) < 0) { fail("Cannot establish the selected filesystem mount"); goto done; }

    disabled_present = entry_stat(rootfd, DISABLED, &disabled_dir);
    if (disabled_present < 0) { fail("Cannot inspect disabled directory"); goto done; }
    if (disabled_present) {
        if (!S_ISDIR(disabled_dir.st_mode)) {
            errno = ENOTDIR; fail("Disabled directory is unsafe"); goto done;
        }
        disabled = openat(rootfd, DISABLED, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        if (disabled < 0 || fstat(disabled, &opened) < 0) {
            fail("Cannot open disabled directory without following links"); goto done;
        }
        if (!tree_same_identity(&disabled_dir, &opened)) {
            errno = ESTALE; fail("Disabled directory changed while reviewing skill"); goto done;
        }
        if (tree_check_mount_entry(rootfd, DISABLED, &disabled_dir, &mount) < 0 ||
            tree_check_mount_fd(disabled, &mount) < 0) {
            fail("Disabled directory crosses the selected filesystem mount"); goto done;
        }
    }

    active_present = entry_stat(rootfd, name, &active_entry);
    if (active_present < 0) { fail("Cannot inspect skill locations"); goto done; }
    inactive_present = disabled < 0 ? 0 : entry_stat(disabled, name, &disabled_entry);
    if (inactive_present < 0) { fail("Cannot inspect skill locations"); goto done; }
    if (active_present && inactive_present) {
        errno = EEXIST; fail("Skill exists in both active and disabled locations"); goto done;
    }
    if ((active && !active_present) || (!active && !inactive_present)) {
        errno = ENOENT; fail("Reviewed skill no longer exists"); goto done;
    }
    selected_parent = active ? rootfd : disabled;
    selected = active ? active_entry : disabled_entry;
    if (reject_reserved_identity(rootfd, &selected) < 0) {
        fail("Reserved root metadata cannot be reviewed as a skill"); goto done;
    }
    if (tree_check_mount_entry(selected_parent, name, &selected, &mount) < 0) {
        fail("Skill crosses the selected filesystem mount"); goto done;
    }

    /* tree_fingerprint_at starts its mount boundary at the entry. Seed the same
     * walk with the approved root mount so a swapped entry cannot change it. */
    memset(&walk, 0, sizeof(walk));
    walk.source_mount = mount;
    walk.source_mount_set = 1;
    walk.content_only = !strcmp(mode, "content");
    tree_sha256_init(&walk.hash);
    if (tree_walk_entry(&walk, selected_parent, name, -1, NULL, 0) < 0) {
        fail("Cannot safely fingerprint the reviewed skill"); goto done;
    }
    tree_sha256_hex(&walk.hash, hash);

    present = entry_stat(selected_parent, name, &current);
    if (present < 0) { fail("Cannot recheck reviewed skill"); goto done; }
    if (!present || !tree_same_snapshot(&selected, &current)) {
        errno = ESTALE; fail("Skill changed while being reviewed"); goto done;
    }
    if (reject_reserved_identity(rootfd, &current) < 0) {
        fail("Reserved root metadata cannot be reviewed as a skill"); goto done;
    }
    if (tree_check_mount_entry(selected_parent, name, &current, &mount) < 0) {
        fail("Skill crosses the selected filesystem mount"); goto done;
    }

    present = entry_stat(rootfd, DISABLED, &current);
    if (present < 0) { fail("Cannot recheck disabled directory"); goto done; }
    if (present != disabled_present || (present && !tree_same_identity(&disabled_dir, &current))) {
        errno = ESTALE; fail("Disabled directory changed while reviewing skill"); goto done;
    }
    if (present && (fstat(disabled, &opened) < 0 ||
                    tree_check_mount_fd(disabled, &mount) < 0 ||
                    tree_check_mount_entry(rootfd, DISABLED, &current, &mount) < 0)) {
        fail("Cannot recheck disabled directory mount"); goto done;
    }
    if (present && !tree_same_identity(&disabled_dir, &opened)) {
        errno = ESTALE; fail("Disabled directory changed while reviewing skill"); goto done;
    }
    present = active ? (disabled < 0 ? 0 : entry_stat(disabled, name, &current))
                     : entry_stat(rootfd, name, &current);
    if (present < 0) { fail("Cannot recheck skill locations"); goto done; }
    if (present) { errno = EEXIST; fail("Skill exists in both active and disabled locations"); goto done; }

    reopened = open_root(root);
    if (reopened < 0) {
        if (errno == ENOENT || errno == ENOTDIR || errno == ELOOP) errno = ESTALE;
        fail("Selected directory changed since approval"); goto done;
    }
    if (boundary_identity_fd(reopened, identity) < 0 || tree_check_mount_fd(rootfd, &mount) < 0) {
        fail("Cannot revalidate approved root identity"); goto done;
    }
    if (strcmp(identity, expected_identity)) {
        errno = ESTALE; fail("Selected directory changed since approval"); goto done;
    }
    printf("READY\t%s\n", hash);
    result = 0;
done:
    saved = errno;
    if (reopened >= 0) close(reopened);
    if (disabled >= 0) close(disabled);
    if (rootfd >= 0) close(rootfd);
    errno = saved;
    return result;
}

#endif /* SKILLS_BOUNDARY_FINGERPRINT_SKILL_H */
