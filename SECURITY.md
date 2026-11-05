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

Saved source receipts and Vercel installer lock entries are continuity metadata, not publisher authentication or proof of prior approval or unchanged local content. An untrusted restore over the same installation can forge those associations. Review the source destination before each remote check or update, and review staged content separately before import.

Ambiguous recovery state is retained for inspection. The app must not delete foreign locks or overwrite foreign files merely to make recovery succeed.

## Selecting and changing skills

Linux mutations require Landlock ABI 5 or later and mount-aware `statx`. If the required boundary is unavailable, the app refuses the mutation rather than allowing unrestricted writes.

The app inspects only the selected installation. Project-local directories require explicit selection. Onboarding previews a linked directory's resolved target. Completed setup is reused for an unchanged root, but every launch freshly validates its physical identity. A new or changed root requires setup again. Adoption does not copy, merge, move, or relink skills, create Git state, or rewrite an installer's lock. A missing directory does not authorize creating it automatically.

Manual and tool-installed skills use the same local scan. Invalid metadata and broken links remain visible. Separate installations remain separate, even when skill names match. Active entries live at `<skills-dir>/<name>`. Disabled entries live at `<skills-dir>/.disabled_skills/<name>`. The app does not automatically migrate an existing sibling `.disabled_skills` directory.

Declared authors are metadata, not proof of ownership. Missing authors and unverified origins remain unknown. A recorded source is not an authenticated origin. You can browse unknown skills, but changes require explicit review. The app does not infer that an adopted skill is unmodified or owned by you. Unknown ownership and local changes stay visible in the confirmation.

Review exact paths before approving a change. Enable and disable move only the selected entry. Removing a link never authorizes deleting its target. Link text is preserved, so moving a relative link can change its resolution while disabled. Moving a shared skill can leave harness links dangling until the skill returns.

The app refuses unsafe paths, collisions, stale previews, and operations for which it cannot establish the filesystem boundary. The reserved `.skills-manager` directory holds locks, operation records, and recovery data. An unrelated directory at that location is a collision, not permission to take it over. Do not remove recovery data to clear an error. Follow the displayed recovery state first. A completed deletion is irreversible after recovery cleanup. The app does not present multi-file operations as atomic.

## Git and remote actions

Optional Git actions require Git 2.48 or later. Commits and pulls require Git's `files` ref backend and refuse `reftable` repositories.

Local skills work without Git. An existing repository at or above the selected directory needs no Git setup during onboarding. Startup opens the browse view. The app never automatically initializes Git, commits, changes a remote, or pushes.

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

The app saves completed directory setup separately in `$XDG_CONFIG_HOME/skills-manager/config.json` when `XDG_CONFIG_HOME` is absolute, or `~/.config/skills-manager/config.json` otherwise. This private configuration records the selected directory and its identity. It does not authorize later writes, Git actions, or network requests. App and CLI update consent remains separate.

The app compares the running build's full commit with `main`. Different commits do not establish which build is newer. The CLI check compares the resolved CLI version with the registry's `latest` tag. The tag is not a compatibility guarantee or a tested-version gate. An unknown build or CLI version, an offline request, or an invalid response is not a match.

An approved update shuts down the app and replaces its process with a helper in a private temporary workspace. The helper uses a separate private npm project and cache outside the running package, shared caches, checkout, and skills roots. It selects the CLI from the approved registry through the root npm override `{"skills":"$skills"}`.

The combined update fetches `main`, which can change after the check. A CLI-only refresh rebuilds a known, clean, reproducible full app commit. An unknown, dirty, or nonreproducible build requires manual recovery or an explicit switch to `main`. A source checkout, tagged install, or unknown channel also requires that explicit switch for an in-app app update.

The workspace is not a sandbox. npm runs repository and dependency lifecycle scripts with the normal permissions of your user. The helper preserves normal `HOME` and user configuration. Scripts can access your files, credentials, and network, and can contact hosts beyond those used for checks.

The helper does not directly install into your checkout, running package, shared npm cache, or skills roots. It does not directly overwrite installed skill documents, user lockfiles, or the global `skills` CLI. Unrestricted scripts can still alter anything available to your account.

The helper prints the workspace path before installation and keeps the workspace while the new app runs. If the new app exits with status zero, the helper attempts identity-checked cleanup. If the new app exits abnormally or is interrupted, the helper keeps and reports the workspace because descendant processes can still run. A hard kill or crash can also leave the workspace behind. Before removing a leftover workspace, make sure that no process still uses it.

The new app freshly validates the selected physical skills directory and reuses completed setup for an unchanged root. A new or changed root requires setup again. The selected directory is passed as a separate `--skills-dir` argument, not through a shell.

After shutdown, a failed handoff cannot restore the old app screen. The app reports the failure and a manual recovery command. You can also run this command with your current absolute skills directory:

```sh
npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir '/absolute/path/to/skills'
```

Replace the example path with your directory and quote it for your shell. The command recovers the app from `main`, but it does not guarantee a fresh CLI.

## Remote actions and privacy

The app uses Vercel's [`skills`](https://www.npmjs.com/package/skills) dependency for explicit remote actions. The dependency requests `latest`, and tests used version 1.7.6. In a source checkout, `npm ci` installs the resolution recorded in the lockfile. The recommended GitHub `npx` command requests the app from `main`, but npm's dependency resolution and cache can retain an earlier `skills` version. A newer `skills` version is not necessarily installed on every launch. The app validates the installed package's declared executable path before use. It does not require a global `skills` installation.

Running the GitHub `npx` command can contact the network before the app starts. Once the app runs, automatic app and CLI checks require the separate opt-ins described above. Search, remote preparation, skill update checks, fetch, pull, and push require explicit user actions. Disabling network access does not disable local browsing.

Remote preparation runs in a disposable workspace behind an operating-system boundary. macOS uses `sandbox-exec` and the Apple-signed Git in the standard system location for the active Xcode or Command Line Tools installation. The confined installer does not use a custom Homebrew Git or host credential helpers. Linux requires a working Bubblewrap installation and the required kernel permissions. A missing or unusable boundary makes the remote action unavailable. Environment variables alone are not a sandbox. If workspace cleanup cannot be safely confined, the app reports the temporary path and retains it for manual cleanup.

The boundary confines the upstream process's filesystem access. It is not a general-purpose hostile-code sandbox. Approved remote actions can use the network, including loopback. Skill documents are parsed as data, not executed.

The app reviews staged results before importing them into the selected installation. It never temporarily enables live disabled skills to update them. External installer locks remain read-only. Updates and checks using saved sources require a separate review of the source URL and ref before contact. Updates also require staged-content approval before import. Unknown sources require explicit selection.

A matching receipt associates a source with the same physical installation. Valid existing Vercel installer lock entries can also provide source tracking without a manager receipt. A saved baseline is not proof of current local content. Version checks compare upstream with the recorded baseline. Copied or recreated installations can require source re-review. Upstream telemetry is disabled with `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`. Upstream documents that this also disables its security-audit requests. Remote actions still contact their requested services and source hosts. Authentication or network failures are visible, not empty successful results.
