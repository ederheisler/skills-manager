# Security policy

## Report a vulnerability

Do not report vulnerabilities in public issues or pull requests. Do not include credentials or private skill contents in a report.

Use [GitHub private vulnerability reporting](https://github.com/ederheisler/skills-manager/security/advisories/new). Include the affected version, operating system, reproduction steps, and impact. Use a disposable skills directory and harmless sentinel files for filesystem reports.

See GitHub's [reporting process](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) for details.

## Release status

The [release plan](docs/superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records test results and their limits.

The app reads skills as untrusted data. It must not execute frontmatter, infer ownership from a missing lock, or use a containing repository for Git actions. Remote preparation requires an operating-system boundary. If that boundary is unavailable, the app must refuse the action.

## Threat model

App locks coordinate app instances, not external editors, filesystem moves, or Git commands. Do not run those operations concurrently with an app action. Stale checks are not atomic pathname guards. Processes running as your user can replace the app, alter saved state, or move already-open files; the app does not claim protection against those actions.

Saved source receipts are continuity metadata, not publisher authentication or proof that a user previously approved a source. An untrusted restore over the same installation can forge those associations. Review the source destination before each remote check or update, and review staged content separately before import.

Ambiguous recovery state is retained for inspection. The app must not delete foreign locks or overwrite foreign files merely to make recovery succeed.

## Selecting and changing skills

Linux mutations require Landlock ABI 5 or later and mount-aware `statx`. If the required boundary is unavailable, the app refuses the mutation rather than allowing unrestricted writes.

The app inspects only the selected installation. Project-local directories require explicit selection. Onboarding previews a linked directory's resolved target. Adoption does not copy, merge, move, or relink skills, create Git state, or rewrite an installer's lock. A missing directory does not authorize creating it automatically.

Manual and tool-installed skills use the same local scan. Invalid metadata and broken links remain visible. Separate installations remain separate, even when skill names match. Active entries live at `<skills-dir>/<name>`. Disabled entries live at `<skills-dir>/.disabled_skills/<name>`. The app does not automatically migrate an existing sibling `.disabled_skills` directory.

Declared authors are metadata, not proof of ownership. Missing authors and unverified origins remain unknown. A recorded source is not an authenticated origin. You can browse unknown skills, but changes require explicit review. The app does not infer that an adopted skill is unmodified or owned by you. Unknown ownership and local changes stay visible in the confirmation.

Review exact paths before approving a change. Enable and disable move only the selected entry. Removing a link never authorizes deleting its target. Link text is preserved, so moving a relative link can change its resolution while disabled. Moving a shared skill can leave harness links dangling until the skill returns.

The app refuses unsafe paths, collisions, stale previews, and operations for which it cannot establish the filesystem boundary. The reserved `.skills-manager` directory holds locks, operation records, and recovery data. An unrelated directory at that location is a collision, not permission to take it over. Do not remove recovery data to clear an error. Follow the displayed recovery state first. A completed deletion is irreversible after recovery cleanup. The app does not present multi-file operations as atomic.

## Git and backup

Optional Git actions require Git 2.48 or later. Commits and pulls require Git's `files` ref backend and refuse `reftable` repositories.

Local skills work without Git. Onboarding offers Git initialization and remote backup separately. Both default to skip. App Git actions require the selected skills directory to be the actual repository root. A containing repository does not qualify. The app does not change a parent's index, ignore files, or Git configuration.

If the parent tracks selected files, initialization is blocked. For an untracked directory inside a parent repository, arrange a parent exclusion manually before approving leaf initialization. See the [parent repository procedure](docs/superpowers/plans/2026-11-03-portable-open-source-release.md#git-safety).

A commit preview lists the exact skill paths. Unrelated staged files and transient recovery data are not part of the commit. Initialization, first commit, remote configuration, and push require separate approvals.

Create a private remote outside the app. The app does not create provider repositories or change their visibility. Before a backup, review the redacted destination, branch, upstream, and all outgoing commits. Make sure that the provider grants access only to the intended readers. Git cannot determine destination privacy from a URL.

Push and pull reviews require complete, original history. Shallow repositories and legacy grafts are refused. Resolve those conditions outside the app before retrying. The push review includes all reachable history, not just newly transferred commits. The app never force-pushes. Declining Git setup or a failed remote action leaves local skills available.

## Remote actions and privacy

The app uses Vercel's [`skills`](https://www.npmjs.com/package/skills) dependency for explicit remote actions. The dependency requests `latest`, and tests used version 1.7.6. In a source checkout, `npm ci` installs the resolution recorded in the lockfile. The recommended GitHub `npx` installation is subject to npm's dependency resolution and cache behavior. The app's tag does not pin `skills` to the tested version, and a newer version is not necessarily installed on every launch. The app validates the installed package's declared executable path before use. It does not require a global `skills` installation.

Startup, refresh, and local browsing make no background network requests. Search, remote preparation, update checks, fetch, pull, and push require explicit user actions. Disabling network access does not disable local browsing.

Remote preparation runs in a disposable workspace behind an operating-system boundary. macOS uses `sandbox-exec` and the Apple-signed Git in the standard system location for the active Xcode or Command Line Tools installation. The confined installer does not use a custom Homebrew Git or host credential helpers. Linux requires a working Bubblewrap installation and the required kernel permissions. A missing or unusable boundary makes the remote action unavailable. Environment variables alone are not a sandbox. If workspace cleanup cannot be safely confined, the app reports the temporary path and retains it for manual cleanup.

The boundary confines the upstream process's filesystem access. It is not a general-purpose hostile-code sandbox. Approved remote actions can use the network, including loopback. Skill documents are parsed as data, not executed.

The app reviews staged results before importing them into the selected installation. It never temporarily enables live disabled skills to update them. External installer locks remain read-only. Updates and checks using saved sources require a separate review of the source URL and ref before contact. Updates also require staged-content approval before import. Unknown sources require explicit selection.

A matching receipt associates current contents with the same physical installation. Copied or recreated installations can require source re-review. Upstream telemetry is disabled with `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`. Upstream documents that this also disables its security-audit requests. Remote actions still contact their requested services and source hosts. Authentication or network failures are visible, not empty successful results.
