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

Start the app once from GitHub:

```sh
npx --yes github:ederheisler/skills-manager
```

In browse mode, press `x` to open Application updates. Press `r` and approve the persistent installation. The app uses the configured npm global prefix and restarts after installation.

For later launches, run:

```sh
skills-manager
```

Installation downloads the project and builds it locally. To select a directory directly, run `skills-manager --skills-dir /absolute/path/to/skills`. The path is the skills directory itself, not its parent. Do not install the unscoped npm package `skills-manager`. It belongs to another project.

## Application and CLI updates

In browse mode, press `x` to open Application updates. Each opening requests an immediate check of both components, even when automatic checks are off. Press `c` to check the selected component again. These actions do not enable automatic checks. Background checks default to off and require separate persistent opt-ins for their disclosed hosts. Enter opens the opt-in prompt, and `y` approves it. You can disable either check.

The app check contacts `api.github.com`. The CLI check contacts the configured npm registry, `registry.npmjs.org` by default. Each host sees your connection's IP address. An opt-in starts a check, then permits daily checks for that component and host while the app runs. Completed results are saved and the menu shows when a check is in progress.

The app check compares the running build's full commit SHA with GitHub `main`. The CLI check compares its resolved version with the registry's `latest` tag. A different commit is not necessarily newer, and `latest` does not guarantee compatibility. An unknown identity or unavailable check is not a match.

Update and restart installs the app from `main` and refreshes the CLI. A CLI-only refresh keeps a verified, clean app commit and selects the latest CLI. Both actions update the persistent npm-global installation and restart the app. An update from a checkout or temporary installation requires explicit approval before global installation. The app does not overwrite the checkout.

After approval, the terminal shows download, build, installation, and restart progress. If a step fails, it shows the reason and a recovery command.

npm runs repository and dependency scripts with your normal permissions. Approve only trusted code. The update does not use `sudo`. After a failed update of an existing persistent installation, start the app again with `skills-manager --skills-dir /absolute/path/to/skills`. See the [security policy](SECURITY.md#application-and-cli-updates) for details.

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

Onboarding offers `~/.agents/skills` as the default or lets you choose another directory. Press Enter to select the default. If the directory is missing, onboarding offers read-only mode and does not create it. A linked directory requires approval of its resolved target. Completed setup is saved in `$XDG_CONFIG_HOME/skills-manager/config.json` when `XDG_CONFIG_HOME` is absolute. Otherwise, the path is `~/.config/skills-manager/config.json`. Later launches reuse setup for an unchanged root. A new or changed root requires setup again.

Onboarding does not merge or move skills, create Git state, rewrite installer locks, or ask about Git. To initialize Git, press `i` in Git view and approve the confirmation. File changes and local commits remain scoped to the selected skills directory. The app never initializes Git, commits, changes a remote, or pushes automatically. Review dialogs default to cancellation.

Push is an explicit action in Git view. It sends branch history for the whole repository, including commits outside the selected skills directory. Review the repository, destination, and history before approving a push. Push does not include uncommitted changes.

Existing Vercel installer records provide source tracking and update checks without skills-manager receipts. Press `?` for help in the current view. Git controls and repository status appear in Git view, not the browse footer. Shortcuts use Option on macOS and Alt on Linux.

The browse filter offers All, From a repo, and Local. Local includes skills without a recorded remote association. It does not mean that you authored them.

In the skill list, ◉ means enabled, ○ means disabled, and ! means missing. ⎇ marks a repository source. No source marker means local. No special font is required.

Local browsing works without network access. Automatic update checks require the separate opt-ins described above. Search, remote preparation, fetch, pull, and push require explicit actions. Remote preparation runs behind an operating-system boundary, not a general-purpose hostile-code sandbox. Do not edit or move files, or run Git commands, concurrently with an app action.

See the [security policy](https://github.com/ederheisler/skills-manager/blob/main/SECURITY.md) for file operations, remote actions, privacy, recovery, and vulnerability reporting.

## More information

- [Release plan and test evidence](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion)
- [Product decisions](https://github.com/ederheisler/skills-manager/blob/main/docs/decisions/README.md) and the [historical design](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/specs/2026-09-16-skills-manager-design.md)
- [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES)
