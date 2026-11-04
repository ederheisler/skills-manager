# skills-manager

A terminal UI for browsing and managing agent skills on macOS and Linux.

The default skills directory is `~/.agents/skills`, with plural `agents`. Existing skills stay where they are. A Git repository and the Vercel `skills` CLI are not required for local browsing.

This project is preparing its first portable release. See the [release plan](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/plans/2026-11-03-portable-open-source-release.md) for acceptance criteria and verification limits. Do not treat the intended platform matrix as a tested release claim.

## Requirements

- Node.js 26.13.0 or later in the 26.x release line, with native FFI support.
- npm to install dependencies and build the project.
- A C compiler for a source installation. The build compiles the filesystem boundary for the current host.
- A terminal. A Nerd Font is not required.

The intended matrix is macOS and Linux on arm64 and x86_64. Linux uses glibc. Windows and Linux with musl are out of scope. Each advertised combination needs an installed-app test.

Linux mutations require Landlock ABI 5 or later and mount-aware `statx`. If the required boundary is unavailable, the app refuses the mutation; it does not fall back to unrestricted writes. Optional Git actions require Git 2.48 or later.

Commits and pulls currently require Git's `files` ref backend; those actions refuse `reftable` repositories.

On macOS, remote skill installs also require the Apple-signed Git from the active Xcode or Command Line Tools installation in its standard system location. The confined installer does not use a custom Homebrew Git or host credential helpers.

## Install from the repository

Registry publication is optional. You can build the repository directly:

```sh
git clone https://github.com/ederheisler/skills-manager.git
cd skills-manager
npm ci
node dist/cli.js
```

`npm ci` builds the project for the current host. After changing the source, rebuild with `npm run build`. npm installs dependencies here; publishing this project to the npm registry is not required.

For development, use `npm run dev`. The app name and executable remain `skills-manager`.

A packed artifact contains a native helper for its build host. Do not transfer that helper between operating systems or architectures. Build from source on the destination host instead.

Do not run `npx skills-manager`. That unscoped npm name belongs to another project. A future registry command must use this project's controlled scope and an exact tested version. No registry release is claimed here.

## Select and adopt existing skills

Start with the default directory, choose a documented harness directory, or enter a custom directory. The app inspects only the selected installation. Project-local directories require explicit selection.

You can select a directory directly:

```sh
node dist/cli.js --skills-dir /absolute/path/to/skills
```

The argument is the skills directory itself, not its parent. The obsolete `--agent-root` interface is not supported.

Onboarding previews a linked directory's resolved target before adoption. Adoption does not copy, merge, move, relink, create Git state, or rewrite an installer's lock. A missing directory does not authorize creating it automatically.

Manual skills and tool-installed skills use the same local scan. Invalid metadata and broken links remain visible. Separate installations remain separate, even when skill names match.

Active entries live at `<skills-dir>/<name>`. Disabled entries live at `<skills-dir>/.disabled_skills/<name>`. The app does not migrate an existing sibling `.disabled_skills` directory automatically.

Declared authors are metadata, not proof of ownership. Missing authors and unverified origins remain unknown. A recorded source is not an authenticated origin. Unknown skills remain browsable and permit only explicitly reviewed changes.

## Protect existing files

Review the exact paths before approving a change. Enable and disable move only the selected entry. Removing a link never authorizes deleting its target. Link text is preserved, so moving a relative link can change its resolution while disabled. Moving a shared skill can leave harness links dangling until the skill returns.

The app uses a native boundary for filesystem mutations. It refuses unsafe paths, collisions, stale previews, and operations for which it cannot establish the boundary. The reserved `.skills-manager` directory holds locks, operation records, and recovery data. An unrelated directory at that location is a collision, not permission to take it over.

Do not remove recovery data to clear an error. Follow the displayed recovery state first. A completed deletion is irreversible after recovery cleanup. No multi-file operation is presented as atomic.

The lock coordinates app instances, not external editors or Git commands. External edits, moves, or Git commands during an action are unsupported. Stale checks are not atomic pathname guards. The boundary is not a defense against arbitrary malicious processes running as your user, debugger attachment, or replacement of the installed program. Interrupted bootstrap or ambiguous recovery data is preserved for inspection, not guessed away.

The app does not infer that an adopted skill is unmodified or owned by you. Unknown ownership and local changes stay visible in the confirmation.

## Optional Git and backup

Local skills work without Git. Onboarding offers Git initialization and remote backup separately. Both default to skip.

App Git actions require the selected skills directory to be the actual repository root. A containing repository does not qualify. The app does not change a parent's index, ignore files, or Git configuration.

If the parent tracks selected files, initialization is blocked. For an untracked directory inside a parent repository, arrange a parent exclusion manually before approving leaf initialization. See the [parent repository procedure](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/plans/2026-11-03-portable-open-source-release.md#git-safety).

A commit preview lists the exact skill paths. Unrelated staged files and transient recovery data are not part of the commit. Initialization, first commit, remote configuration, and push require separate approvals.

Create a private remote outside the app. The app does not create provider repositories or change their visibility. Before a backup, review the redacted destination, branch, upstream, and all outgoing commits. Make sure that the provider grants access only to the intended readers. Git cannot determine destination privacy from a URL.

Push and pull reviews require complete, original history. Shallow repositories and legacy grafts are refused; resolve those conditions outside the app before retrying. The push review conservatively includes all reachable history, not just newly transferred commits.

The app never force-pushes. Declining Git setup or a failed remote action leaves local skills available.

## Remote skills and privacy

The app includes the pinned [`skills@1.7.6`](https://www.npmjs.com/package/skills/v/1.7.6) dependency from Vercel for explicit remote actions. It does not require a global `skills` installation or invoke an unpinned `latest`.

Startup, refresh, and local browsing make no background network requests. Search, remote preparation, update checks, fetch, pull, and push require explicit user actions. Disabling network access does not disable local browsing.

Remote preparation runs in a disposable workspace behind an operating-system boundary. macOS uses `sandbox-exec`. Linux requires a working Bubblewrap installation and the required kernel permissions. A missing or unusable boundary makes the remote action unavailable. Environment variables alone are not a sandbox. If workspace cleanup cannot be safely confined, the app reports the temporary path and retains it for manual cleanup.

This confines the upstream process's filesystem access; it is not a general-purpose hostile-code sandbox. Approved remote actions can use the network, including loopback. Skill documents are parsed as data, not executed.

The app reviews staged results before importing them into the selected installation. It never temporarily enables live disabled skills to update them. External installer locks remain read-only. Updates and checks using saved sources require a separate source-URL and ref review before contact, then updates require staged-content approval before import. Unknown sources require explicit selection.

A matching receipt associates current contents with the same physical installation; it does not authenticate a publisher or prove prior review. Copied or recreated installations can require source re-review. Replacing saved manager state from an untrusted backup can falsify its claims, including when restored over the same directory.

Upstream telemetry is disabled with `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`. Upstream documents that this also disables its security-audit requests. Remote actions still contact their requested services and source hosts. Authentication or network failures are visible, not empty successful results.

## Keyboard controls

The header shows the controls for the current pane. Review dialogs default to cancellation.

- `up`/`k` and `down`/`j` move the selection.
- `/` filters local skills. `escape` clears the filter.
- `i` revisits installation selection. `r` reloads local files without a network request.
- `[`/`]` or `Ctrl+P`/`Ctrl+N` navigate the selected skill's files.
- `,`/`.` scroll the metadata pane. `t` switches Markdown between syntax-rendered and raw text; links in skill documents are not clickable. Parser caches use a private temporary directory, removed on normal exit.
- `space` reviews enable or disable. `d` reviews removal.
- `a` starts an explicit remote search or add. `u` prepares a selected update or source replacement.
- `p` reviews saved sources before preparing bulk updates. `v` reviews sources before checking for updates.
- `g` opens Git. Its `i`, `n`, and `c` controls review initialization, remote addition, and a commit.
- In Git, `f`, `l`, and `p` review fetch, pull, and push. `r` refreshes local status.
- In Git, `s` filters status and `t` toggles full diff context.
- `escape` cancels or closes the current action. `q` quits from the main view.

## Security and licensing

Use [private vulnerability reporting](https://github.com/ederheisler/skills-manager/blob/main/SECURITY.md), not public issues, for security findings. The project uses the [MIT license](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES) for bundled material.

Accepted product choices are in the [decision index](https://github.com/ederheisler/skills-manager/blob/main/docs/decisions/README.md). The original [design](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/specs/2026-09-16-skills-manager-design.md) is historical where those choices supersede it.
