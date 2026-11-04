# skills-manager

Browse and manage agent skills in a terminal on macOS and Linux. The app uses `~/.agents/skills` by default and can open another skills directory. Local browsing needs neither Git nor a global `skills` CLI.

AI coding agents wrote most of the code under the maintainer's guidance.

## Requirements

- Node.js 26.13.0 or later in the 26.x release line, with native FFI support.
- npm, Git, and a C compiler to download dependencies and build for the current host.
- A terminal. A Nerd Font is not required.
- macOS or Linux with glibc, on arm64 or x86_64. Windows and Linux with musl are not supported.

## Quick start

Run the released version:

```sh
npx --yes github:ederheisler/skills-manager#v0.1.0
```

This command downloads and builds the project. To select a directory directly, append `--skills-dir /absolute/path/to/skills`. The path is the skills directory itself, not its parent.

Do not run `npx skills-manager`. That unscoped npm name belongs to another project. This project is not published to the npm registry.

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

Onboarding lets you choose an existing skills directory. It does not merge or move skills, create Git state, or rewrite installer locks. Git initialization and backup are optional and default to skip. Review paths and destinations before approving changes. Press `?` in the browse or Git view to open keyboard help. Review dialogs default to cancellation.

Local browsing makes no background network requests. Remote actions require your approval and an operating-system boundary. The boundary is not a general-purpose hostile-code sandbox. Do not edit or move files, or run Git commands, concurrently with an app action.

See the [security policy](https://github.com/ederheisler/skills-manager/blob/main/SECURITY.md) for file operations, remote actions, backup, privacy, recovery, and vulnerability reporting.

## More information

- [Release plan and test evidence](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/plans/2026-11-03-portable-open-source-release.md)
- [Product decisions](https://github.com/ederheisler/skills-manager/blob/main/docs/decisions/README.md) and the [historical design](https://github.com/ederheisler/skills-manager/blob/main/docs/superpowers/specs/2026-09-16-skills-manager-design.md)
- [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES)
