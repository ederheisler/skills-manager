# Security policy

## Report a vulnerability

Do not report vulnerabilities in public issues or pull requests. Do not include credentials or private skill contents in a report.

Use [GitHub private vulnerability reporting](https://github.com/ederheisler/skills-manager/security/advisories/new). Include the affected version, operating system, reproduction steps, and impact. Use a disposable skills directory and harmless sentinel files for filesystem reports.

See GitHub's [reporting process](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) for details.

## Release status

The [release plan](docs/superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records test results and their limits.

The package preflight is designed to reject unreviewed root `README`, `LICENSE`, `LICENCE`, and `COPYING` variants that npm would otherwise include despite the allowlist. It also rejects TypeScript output and build identity targets with multiple hard links, which can expose another file to a build write.

The app reads skills as untrusted data. It must not execute frontmatter or infer ownership from a missing lock. Git actions can use an existing containing repository under the boundaries below. Remote preparation requires an operating-system boundary. If that boundary is unavailable, the app must refuse the action.

## Threat model

App locks coordinate app instances, not external editors, filesystem moves, or Git commands. Do not run those operations concurrently with an app action. Stale checks are not atomic pathname guards. Processes running as your user can replace the app, alter saved state, or move already-open files; the app does not claim protection against those actions.

Saved source receipts and Vercel installer lock entries are continuity metadata, not publisher authentication or proof of prior approval or unchanged local content. An untrusted restore over the same installation can forge those associations. Review sources before updates and staged content before import.

Ambiguous recovery state is retained for inspection. The app must not delete foreign locks or overwrite foreign files merely to make recovery succeed.

## Selecting and changing skills

Linux mutations require Landlock ABI 5 or later and mount-aware `statx`. If the required boundary is unavailable, the app refuses the mutation rather than allowing unrestricted writes.

The app inspects only the selected installation. Onboarding offers `~/.agents/skills` by default or another directory by explicit selection. A linked directory requires approval of its resolved target. If the directory is missing, onboarding offers read-only mode and does not create it. Completed setup is reused for an unchanged root, but every launch freshly validates its physical identity. A new or changed root requires setup again. Adoption does not copy, merge, move, or relink skills, create Git state, or rewrite an installer's lock.

Manual and tool-installed skills use the same local scan. Invalid metadata and broken links remain visible. Separate installations remain separate, even when skill names match. Active entries live at `<skills-dir>/<name>`. Disabled entries live at `<skills-dir>/.disabled_skills/<name>`. The app does not automatically migrate an existing sibling `.disabled_skills` directory.

Declared authors are metadata, not proof of ownership. Missing authors and unverified origins remain unknown. A recorded source is not an authenticated origin. You can browse unknown skills, but changes require explicit review. The app does not infer that an adopted skill is unmodified or owned by you. Unknown ownership and local changes stay visible in the confirmation.

Review exact paths before approving a change. Enable and disable move only the selected entry. Removing a link never authorizes deleting its target. Link text is preserved, so moving a relative link can change its resolution while disabled. Moving a shared skill can leave harness links dangling until the skill returns.

The app refuses unsafe paths, collisions, stale previews, and operations for which it cannot establish the filesystem boundary. The reserved `.skills-manager` directory holds locks, operation records, and recovery data. An unrelated directory at that location is a collision, not permission to take it over. Do not remove recovery data to clear an error. Follow the displayed recovery state first. A completed deletion is irreversible after recovery cleanup. The app does not present multi-file operations as atomic.

## Git and remote actions

Optional Git actions require Git 2.48 or later. Commits and pulls require Git's `files` ref backend and refuse `reftable` repositories.

Local skills work without Git. Onboarding does not ask about Git. To initialize Git, press `i` in Git view and approve the confirmation. The app never automatically initializes Git, commits, changes a remote, or pushes.

Skill file writes and local commits are limited to the selected skills directory. Commit previews list the exact skill paths. Unrelated staged and unstaged files and transient recovery data stay outside the commit. The app does not add exclusions or untrack files.

Push is an explicit action in Git view. A push sends branch history for the entire repository, including commits outside the selected skills directory. Push does not preserve uncommitted files. Review the actual repository, redacted destination, branch, upstream, and history before approval. Create a remote outside the app and make sure that its provider grants access only to the intended readers. Git cannot determine destination privacy from a URL. The app does not create provider repositories, change their visibility, or overwrite existing remotes.

Push and pull reviews require complete, original history. Shallow repositories and legacy grafts are refused. Resolve those conditions outside the app before retrying. The push review includes all reachable history, not just newly transferred commits. The app never force-pushes. Pull is fast-forward only and is refused if incoming changes reach outside the selected skills directory. A declined or failed remote action leaves local skills available.

## Application and CLI updates

The Application updates menu offers separate checks for skills-manager and the Vercel `skills` CLI. Both automatic checks default to off. Each requires its own persistent opt-in for the disclosed host. You can disable either check independently. Disabling a check cancels its pending requests in the current session.

Explicit opt-in starts a check and permits later daily checks for that component and host. With permission on and no completed result, startup checks even when an older attempt timestamp exists. The menu shows when a check is in progress.

Each intentional opening of Application updates authorizes an immediate check of both components, even when automatic checks are off. Pressing `c` starts another check for the selected component without confirmation. These actions authorize one-shot requests and do not enable startup or background checks. The app check contacts `https://api.github.com/repos/ederheisler/skills-manager/commits/main`. The CLI check contacts the configured npm registry, which defaults to `registry.npmjs.org`. Each host sees the IP address of the connection.

npm can protect a registry URL with embedded credentials in a user or global `.npmrc`. When the app cannot resolve that origin, CLI checks and the update handoff are unavailable, and automatic CLI checks stay off. GitHub app checks remain available. A credentialed `npm_config_registry` environment override is supported. The app does not display or silently discard credentials.

Persistent consent for one host does not authorize automatic checks on the other. Neither check authorizes an update. Ordinary quit does not start an update.

The app stores explicit consent in configuration and completed check results in a private cache, outside the selected skills directory. The cache stores the checked commit or version, or a sanitized error, with its check time. It does not store registry credentials or a saved current-status verdict. Invalid, unreadable, or unwritable consent fails closed. If saving an opt-out fails, automatic checks stop in the current session, but an earlier saved opt-in can apply on a later launch. The app reports the save failure.

The app saves completed directory setup separately in `$XDG_CONFIG_HOME/skills-manager/config.json` when `XDG_CONFIG_HOME` is absolute, or `~/.config/skills-manager/config.json` otherwise. This private configuration records the selected directory and its identity. It does not authorize later writes or Git actions. App and CLI update consent remains separate from background skill update checks described below.

The app compares the running build's full commit with `main`. Different commits do not establish which build is newer. The CLI check compares the resolved CLI version with the registry's `latest` tag. The tag is not a compatibility guarantee or a tested-version gate. An unknown build or CLI version, an offline request, or an invalid response is not a match.

An approved update packs the selected GitHub revision in owned staging, installs the package into the configured npm global prefix, and restarts the installed app. A combined update selects `main`, which can change after a check. A CLI-only refresh keeps a verified, clean running app commit and refreshes the bundled CLI dependency. An update from a source checkout or temporary installation requires explicit approval before global installation. The app does not overwrite the checkout.

npm downloads code and runs repository and dependency lifecycle scripts with the normal permissions of your user. These scripts can access your files, credentials, and network. Approve only trusted code.

The update does not use `sudo` or `--force`, or rewrite npm configuration or `PATH`. It refuses conflicting existing packages or executables. It does not directly change skill documents, user lockfiles, or the global `skills` CLI. Unrestricted scripts can still alter anything available to your account.

The restarted app validates the selected physical skills directory and reuses completed setup for an unchanged root. A new or changed root requires setup again. After a failed update, start the installed app again with `skills-manager --skills-dir '/absolute/path/to/skills'`. Replace the example path with your directory and quote it for your shell.

## Remote actions and privacy

The app uses Vercel's [`skills`](https://www.npmjs.com/package/skills) dependency for skill update checks and explicit remote actions. The dependency requests `latest`, and tests used version 1.7.6. In a source checkout, `npm ci` installs the resolution recorded in the lockfile.

The installed CLI version remains in use until an explicit refresh. Launching the app does not install a newer version. The app validates the installed package's declared executable path before use. It does not require a global `skills` installation.

Installing the app can contact the network before the app starts. Once the app runs, automatic app and CLI checks require the separate opt-ins described above. Skill update checks for known sources run in the background on startup and refresh, contacting the source host; the host can see the connection's IP address. Search, remote installation, fetch, pull, and push require explicit user actions. Disabling network access does not disable local browsing, but checks can be unavailable.

Remote preparation runs in a disposable workspace behind an operating-system boundary. macOS uses `sandbox-exec` and the Apple-signed Git in the standard system location for the active Xcode or Command Line Tools installation. The confined installer does not use a custom Homebrew Git or host credential helpers. Linux requires a working Bubblewrap installation and the required kernel permissions. A missing or unusable boundary makes the remote action unavailable. Environment variables alone are not a sandbox. If workspace cleanup cannot be safely confined, the app reports the temporary path and retains it for manual cleanup.

The boundary confines the upstream process's filesystem access. It is not a general-purpose hostile-code sandbox. Approved remote actions can use the network, including loopback. Skill documents are parsed as data, not executed.

The app reviews staged results before importing them into the selected installation. It never temporarily enables live disabled skills to update them. External installer locks remain read-only. Update actions using saved sources require separate review of the source URL and ref before contact, then staged-content approval before import. Checks use disposable locks and stage CLI-reported updates for comparison without installing them or requiring that review. Unknown sources require explicit selection.

A matching receipt associates a source with the same physical installation. Valid existing Vercel installer lock entries can also provide source tracking without a manager receipt. A saved baseline is not proof of current local content. For a CLI-reported update, the app compares the installed skill with staged upstream content. Matching contents do not warrant an update solely because a baseline is stale. Staging uses a separate remote snapshot and can fail or be ambiguous. Explicit CLI failures and unrecognized results are unavailable; the CLI's up-to-date result is accepted when no failure is reported. Copied or recreated installations can require source re-review. Upstream telemetry is disabled with `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`. Upstream documents that this also disables its security-audit requests. Remote actions still contact their requested services and source hosts. Authentication or network failures are visible, not empty successful results.
