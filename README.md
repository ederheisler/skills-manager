# skills-manager

Browse and manage agent skills in a terminal on macOS and Linux. The app uses `~/.agents/skills` by default and can open another skills directory. Local browsing needs neither Git nor a global `skills` CLI.

AI coding agents wrote most of the code under the maintainer's guidance.

## Requirements

- Node.js 26.13.0 or later in the 26.x release line, with native FFI support.
- npm, Git, and a C compiler to download dependencies and build for the current host.
- A terminal. A Nerd Font is not required.
- macOS or Linux with glibc, on arm64 or x86_64. Windows and Linux with musl are not supported.

Once built, local browsing needs Node, a terminal, and a supported operating system. It does not need Git or a global `skills` CLI. Linux changes also need Landlock ABI 5 or later and mount-aware `statx`. Remote preparation on Linux needs Bubblewrap and the required kernel permissions. Optional in-app Git actions need Git 2.48 or later. See the [security policy](https://github.com/ederheisler/skills-manager/blob/main/SECURITY.md) for details.

## Quick start

Run the latest code on `main`:

```sh
npx --yes --prefer-online github:ederheisler/skills-manager
```

This command downloads the project and runs its build script locally. The `--yes` flag skips npm's installation prompt, not the app's confirmations. To select a directory directly, append `--skills-dir /absolute/path/to/skills`. The path is the skills directory itself, not its parent.

Run the command again to request the latest app code on `main`. It does not guarantee a fresh Vercel `skills` CLI.

Do not run `npx skills-manager`. That unscoped npm name belongs to another project. This project is not published to the npm registry.

## Application and CLI updates

In browse mode, press `x` to open Application updates. The menu offers separate, bounded manual checks for skills-manager and the Vercel `skills` CLI. Manual checks do not enable automatic checks. Both automatic checks default to off and require separate persistent opt-ins for their disclosed hosts. You can disable either one.

The app check contacts `api.github.com`. The CLI check contacts the configured npm registry, `registry.npmjs.org` by default. Each host sees your connection's IP address. After opt-in, automatic attempts occur at most once every 24 hours per component and host while the app runs.

The app check compares the running build's full commit SHA with GitHub `main`. The CLI check compares its resolved version with the registry's `latest` tag. A different commit is not necessarily newer, and `latest` does not guarantee compatibility. An unknown identity or unavailable check is not a match.

Update and restart starts a new app from `main` and refreshes the CLI. A CLI-only refresh keeps a known, clean, reproducible full app commit and selects the latest CLI. A successful CLI check is not required for a refresh. If that commit is unknown, dirty, or not reproducible, use manual recovery or explicitly switch to `main`. A source checkout, tagged install, or unknown channel requires that switch for a combined update.

The helper builds in a private project and cache. Repository and dependency scripts run with your normal permissions. Approve only trusted code. After shutdown, a failed handoff cannot restore the old screen. Rerun the [Quick start](#quick-start) command with the current `--skills-dir` for app recovery. See the [security policy](SECURITY.md#application-and-cli-updates) for workspace, credential, and cleanup details.

## Development

Clone the repository only to work on the code. A clone is not required to run the app.

```sh
git clone https://github.com/ederheisler/skills-manager.git
cd skills-manager
npm ci
node dist/cli.js
```

For development, use `npm run dev`. Rebuild with `npm run build` after changing the source.

Run `npm test` before opening a pull request. Merged version bumps are released automatically after CI passes.

## Using the app safely

Onboarding lets you choose an existing skills directory. Completed setup is saved in `$XDG_CONFIG_HOME/skills-manager/config.json` when `XDG_CONFIG_HOME` is absolute. Otherwise, the path is `~/.config/skills-manager/config.json`. Later launches reuse setup for an unchanged root. A new or changed root requires setup again.

Onboarding does not merge or move skills, create Git state, or rewrite installer locks. Git initialization and backup are optional and default to skip. Review paths and destinations before approving changes. Review dialogs default to cancellation.

Existing Vercel installer records provide source tracking and update checks without skills-manager receipts. Press `?` for help in the current view. Git controls and repository status appear in Git view, not the browse footer. Shortcuts use Option on macOS and Alt on Linux.

Local browsing works without network access. Automatic update checks require the separate opt-ins described above. Search, remote preparation, fetch, pull, and push require explicit actions. Remote preparation runs behind an operating-system boundary, not a general-purpose hostile-code sandbox. Do not edit or move files, or run Git commands, concurrently with an app action.

See the [security policy](https://github.com/ederheisler/skills-manager/blob/main/SECURITY.md) for file operations, remote actions, backup, privacy, recovery, and vulnerability reporting.

## More information

- [Release plan and test evidence](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion)
- [Product decisions](https://github.com/ederheisler/skills-manager/blob/main/docs/decisions/README.md) and the [historical design](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/specs/2026-09-16-skills-manager-design.md)
- [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES)
