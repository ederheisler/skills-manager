# Portable open-source release plan

The original plan was approved for implementation through Crit session `6d12ddc84e05`. The public repository and its [verification and limits](#release-completion) are recorded below.

The blockers, recommendations, phases, and acceptance criteria describe the reviewed plan. They are not current installation instructions or proof that every original criterion was met. The [portability decision](../../decisions/2026-11-03-open-source-portability.md) records later choices, including the approved [concurrency limits](../../decisions/2026-11-03-open-source-portability.md#concurrency-limits). The original [design](../specs/2026-09-16-skills-manager-design.md) is historical where it conflicts with those decisions.

For current behavior and installation, see the [README](../../../README.md). Pre-implementation code descriptions and line numbers below refer to the old snapshot, not the current source.

<a id="release-blockers"></a>

## Pre-implementation release blockers

The review identified the following blockers before implementation. The first three findings came from disposable probes. The race findings came from source inspection, not a race probe. The phases below record the original requirements, and the [release evidence](#release-completion) records the subsequent checks.

| Blocker and evidence at review | Original requirement |
| --- | --- |
| JavaScript frontmatter executed during a scan and changed a harmless global marker. | Phase 1 required bounded, data-only parsing. Scan and preview fixtures must leave the marker and outside sentinels unchanged. |
| Removing a skill through a linked skills directory deleted a file outside the selected installation in a disposable probe. | Phase 1 required operation-time containment, link-safe deletion, and refusal when a race-safe boundary is unavailable. Linked-path and swap fixtures must preserve outside sentinels. |
| A nested-root Git probe staged and committed an unrelated parent-repository file. | Phase 3 required the selected skills directory to be the actual Git top-level. Parent repositories cannot supply app Git actions, and real-repository fixtures must preserve their index and worktree. |
| Upstream global operations did not pass the selected installation or a working directory. | Phase 2 required a tested, confined adapter. Real CLI tests must record changes and preserve unrelated home, XDG, project, and outside paths. |
| Interruption and concurrent handlers could leave disabled state or metadata inconsistent. This risk was inferred from source inspection. | Phase 5 required serialization, durable recovery, visible failures, and interruption and competing-process fixtures. |
| The dependency audit reported four advisories, two high and two moderate. SCB could not parse `src/tui.ts`. | Phase 7 required a fresh release-candidate audit and source-security review. Resolve valid findings or record an approved release decision. A parse failure is not a clean scan. |

## Accepted decisions

- Keep the name and executable `skills-manager`. Make the project open source for macOS and Linux. Windows is out of scope.
- Use `~/.agents/skills` as the default skills directory. Accept an explicitly selected directory without moving or merging installations.
- Manage skills only. The earlier decision to share global instruction files is superseded. Instruction files, imports, and links between instruction files are out of scope.
- Make the selected skills directory the optional Git repository root. Git is not required for local skill browsing.
- During onboarding, offer an optional push of the skills repository to a remote for backup. This is not an offer to publish the repository.
- Select the MIT license. The owner later confirmed the required rights and copyright, and the distribution includes third-party notices.
- Protect existing files and links. Do not use personal machine paths or personal setup assumptions.

These decisions describe the product choices, not proof of their implementation.

The owner later required changes to reach `main` through pull requests and releases to be created by GitHub Actions, not by hand.

### Approved concurrency contract

The owner subsequently selected [standard filesystem concurrency limits](../../decisions/2026-11-03-open-source-portability.md#concurrency-limits). Keep the full app, serialize cooperating app instances, and retain stale-preview checks, collision refusal, and Git locks. External edits, moves, or Git commands during an action are unsupported. No acceptance criterion below promises atomic pathname binding against those external operations.

This does not relax inert parsing, link-safe operations, outside-target protection, operating-system confinement, literal Git scope, or interrupted-operation recovery. A disposable probe on macOS and Linux arm64 denied fresh `openat`, `renameat`, and `unlinkat` after a parent directory moved outside the boundary, but allowed writes through a regular-file descriptor opened before the move. Descriptor checks alone are therefore not a race-proof pathname guarantee.

## Skills directory and harness paths

The skills directory contains active skill entries. By default, `example` is at `~/.agents/skills/example`. Its disabled entry is at `~/.agents/skills/.disabled_skills/example`. The selected skills directory itself is the optional Git root, not its parent.

At review, the path resolver placed disabled entries at `~/.agents/.disabled_skills`. The implementation now uses the selected directory and its `.disabled_skills` child as described above.

The `--skills-dir` option selects the directory directly and overrides the default. The plan required controlled state and recovery on the same filesystem, exclusion of reserved state from skills and Git commits, and refusal of a reserved-location collision.

| Harness | Documented global skills locations |
| --- | --- |
| Codex | [`~/.agents/skills`](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills). |
| Claude Code | [`~/.claude/skills`](https://code.claude.com/docs/en/skills#choose-where-skills-load). |
| Cursor | [`~/.cursor/skills` and `~/.agents/skills`](https://cursor.com/docs/skills#skill-directories), plus documented compatibility directories. |
| OpenCode | [`~/.config/opencode/skills`, `~/.claude/skills`, and `~/.agents/skills`](https://opencode.ai/docs/skills/). |

The [Vercel installer table](https://github.com/vercel-labs/skills/blob/main/docs/agents.md) lists `~/.agents/skills` for Codex and several other harnesses. It lists `~/.config/agents/skills` for Amp, Replit, and Universal. An installer destination is not necessarily every path that a harness discovers. Do not infer an XDG override from a literal `~/.config` path.

The upstream installer can keep its lock at the parent of its skills directory. That lock is external provenance, not app authority over the parent. A read-only adapter must associate an entry with the selected path before displaying its origin. Do not move the lock into the skills repository, rewrite it, stage it, or claim upstream supports a different lock layout.

## Adoption and Git safety

Adoption inspects an explicitly selected skills directory. It does not depend on `npx`, an installer, or a lock file. The app identifies direct candidate entries with a data-only `SKILL.md`, including manually created skills. It shows malformed candidates as invalid instead of hiding them. It identifies entries by installation and path, so duplicate names in different locations remain separate.

Use `lstat` to show links and broken links. Do not follow a skill link for deletion. If the selected skills directory is a link, preview its resolved target and apply the Phase 1 boundary checks. Inspect nested repositories read-only during adoption. Leave per-harness directories and linked installations where they are. Do not scan the home directory recursively. A project-local directory is included only after explicit selection.

Adoption itself writes nothing. It does not move, copy, merge, relink, initialize Git, or modify lock metadata. Missing or ambiguous provenance means unknown, not locally owned. A manual skill without a verified remote source is browsable but cannot update automatically. Every subsequent mutation requires consent for the exact affected paths.

### Declared author and source

The draft recommended separate author and source fields, not an "authored by you" flag. It recommended displaying declared names from supported metadata and `Author: unknown` when metadata is missing or invalid. A declaration is not proof that the user wrote or owns a skill.

The proposed source values were a verified remote origin, a confirmed local origin, and unknown. In this discussion, verification means an association with the selected path, not publisher authentication. A local path alone is not proof of origin. Missing, invalid, unrelated, or inconsistent lock data means unknown unless independent evidence confirms the origin. Do not infer authorship from a missing lock, an OS username, a Git identity, a path owner, or a repository owner.

| Evidence | Author display | Source display |
| --- | --- | --- |
| No author metadata or lock for a manual skill | Unknown | Unknown unless its local origin is confirmed |
| Declared author `Ada`, no verified origin | Ada | Unknown |
| Verified remote source, no author metadata | Unknown | Verified remote |
| Declared author `Ada` and confirmed local origin | Ada | Confirmed local |
| Missing or inconsistent source evidence, with any author metadata | Declared name or unknown | Unknown |

The draft proposed an `all` source view, plus filters for remote, local, and unknown entries. It also proposed that any author filter use declared names and an unknown category rather than a "mine" label. Source and author classifications never authorize deletion or update.

The owner had not selected a source or author filter design at that review. Do not add identity configuration, an authorship database, or silent ownership flags to guess an author. Ownership and mutation permission remain separate questions.

At review, the classifier treated an incomplete or missing catalog entry as `local` and offered `local` or `source` kinds. Its `local (mine)` helper implied authorship that the classifier did not establish. The detail view displayed the first scalar `author` or `authors` value, dropped arrays, and showed no author line when none was present. Those observations describe the old source, not the current implementation.

The [earlier design](../specs/2026-09-16-skills-manager-design.md#provenance) treated a missing lock and author as "local (mine)". That was a guess, not evidence of authorship, and is superseded.

### Git safety

Git allows a repository inside another repository, but that does not isolate the parent automatically. Git actions are enabled only when the real Git top-level is the selected skills directory. A verified worktree whose top-level is that directory also qualifies. If only a containing repository exists, local skills remain available and app Git actions are disabled. The app must never stage, commit, pull, push, or initialize the containing repository.

Do not initialize a nested repository when the parent index tracks any selected path. The parent continues to track those files even after nested initialization. The app cannot safely untrack them automatically. If the selected directory is untracked, first ask the user to arrange an explicit parent exclusion manually. Do not edit the parent's ignore files or index. After the exclusion is verified, a separate opt-in action can initialize only the selected directory.

For a parent repository, replace the quoted placeholders below with its path and the selected directory's path relative to that repository. The first command locates the parent's local exclusion file. Resolve a relative result from the parent repository. The second command lists tracked entries under the selected directory. If it prints a path or fails, stop. Do not untrack it.

```sh
git -C '<parent-repo>' rev-parse --git-path info/exclude
git -C '<parent-repo>' --literal-pathspecs ls-files -- '<relative-skills-path>'
```

If the listing is empty, the user can add a directory-wide rule such as `/path/to/skills/` to the local exclusion file. A parent `.gitignore` is another user-managed choice. Substitute the actual path and escape Git pattern characters. The app edits neither file. The user can then ask Git which rule excludes the directory:

```sh
git -C '<parent-repo>' check-ignore -v -- '<relative-skills-path>/'
```

A matching rule is required before the separate initialization offer. The app must repeat the parent-index and exclusion checks at the action boundary.

Explain that a parent `git add` can stage an embedded repository as a Git link. A parent exclusion prevents normal discovery, but it is not an automatic submodule and does not prevent a forced add. Existing broader repositories and their staged and unstaged changes remain untouched.

Onboarding offers local Git initialization and a separate remote backup. Both default to skip. Skipping makes no Git changes or network requests. Local skills remain usable without either choice.

For backup, the app can use an existing remote or, if none exists, offer to add one after explicit approval. The user creates a private remote outside the app and supplies its URL. The app does not create a provider repository, change its visibility, overwrite an existing remote, or change global Git configuration.

Before a commit, show the exact leaf repository and proposed literal skill paths. A first commit requires explicit approval. Before a push, show the remote name and effective push URL with credentials redacted, the branch and upstream, and every outgoing commit. Warn that the destination determines who can read the backup. Git cannot infer whether an SSH or HTTPS remote is private, so ask the user to check its access on the provider before the first push. Remote configuration and push each require separate approval. Never force-push. A declined or failed action leaves local skills usable.

<a id="open-release-choices"></a>

## Previously open release choices

The following choices were open in the reviewed draft. The owner's later selections appear in the [decision record](../../decisions/2026-11-03-open-source-portability.md#implementation-choices). The alternatives below are not current installation instructions or outstanding release gates.

### Runtime and distribution

The draft compared a [Bun-compiled executable](https://bun.com/docs/bundler#compile) with a Node package. A Bun executable contains its runtime, but the separate upstream `skills` CLI needs Node unless separately bundled and tested. No standalone release is claimed.

The owner selected Node and repository or tarball distribution. The [README](../../../README.md) documents a GitHub `npx` command for release `v0.1.0` and source installation. The project is not published to npm. The package remains private, which prevents npm publication but not repository or tarball distribution.

The [unscoped `skills-manager` package](https://registry.npmjs.org/skills-manager/latest) belongs to another project. Do not run `npx skills-manager` for this app. Test the exact command and package contents before documenting another distribution.

An uncached `npx` download needs network access. A cached package does not guarantee offline use because npm can make other requests. The documented command uses `--yes` to skip the npm download prompt. The prompt does not review install scripts. npm also assumes consent in non-interactive use. See the [`npx` documentation](https://docs.npmjs.com/cli/v11/commands/npx/) and [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/).

npm also accepts [repository and tarball package specifications](https://docs.npmjs.com/cli/v11/using-npm/package-spec/). A source archive is not automatically a runnable package. Pin a full repository commit or use a verified immutable release tarball when testing those routes.

The owner later chose the latest upstream `skills` dependency without a version-number gate. The package declares `skills` as `latest`, and the current lockfile resolves `1.7.6`. The `npm ci` command uses the locked version. This does not promise the newest upstream version on every launch. The adapter checks package identity and executable containment without rejecting versions by number. Schema, path, source-association, receipt, and operating-system confinement checks remain required.

The tested candidate included `skills@1.7.6` for explicit remote actions. It resolved that dependency without a global install. Local browsing did not require the upstream CLI.

The draft also considered Homebrew and Node single executable applications (SEA). A Homebrew wrapper requires a declared Node dependency, native assets, and tests on both operating systems. For Node SEA, OpenTUI's [standalone guidance](https://raw.githubusercontent.com/anomalyco/opentui/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/web/src/content/docs/reference/standalone-executables.mdx) requires extracting native assets before startup. The [Homebrew Node formula](https://formulae.brew.sh/api/formula/node.json) disables SEA, so that route needs another compatible Node distribution.

At review, `src/cli.ts` had a Bun shebang and the private `package.json` had no release package. In earlier terminal smoke tests, Node 26.13.0 and Bun 1.4.4 each launched the built app in a disposable home, displayed a skill from `~/.agents/skills`, and exited with code 0. A Node launch with `--agent-root` displayed only that custom directory's skill. These were not installed-package or Linux tests, and they did not test the later `--skills-dir` interface.

OpenTUI `0.5.11` requires Node `>=26.4.0`, ESM, and native FFI according to its [runtime guidance](https://raw.githubusercontent.com/anomalyco/opentui/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/web/src/content/docs/getting-started/runtime-support.mdx). Node 26.4 through 26.8 require `--experimental-ffi`. [Node 26.9](https://nodejs.org/en/blog/release/v26.9.0) enabled FFI by default in builds that include it, but FFI remains experimental. The app's current Node requirement is narrower. See the [README](../../../README.md#requirements).

### Platform coverage

The draft recommended macOS arm64 and x86_64 and Linux arm64 and x86_64 with glibc, with real tests before each support claim. The selected matrix covers all four. Linux with musl and Windows are not supported. The [verification record](#publication-verification-and-limits) distinguishes local macOS arm64 tests from the three hosted CI jobs.

### Network and mutation policy

The owner selected user-initiated network access and disabled upstream telemetry. Startup and local browsing make no background requests. Search, add, update checks, updates, fetch, pull, and push require user action. The [upstream telemetry policy](https://github.com/vercel-labs/skills/blob/main/docs/troubleshooting.md#telemetry) says disabling telemetry also disables its security-audit requests.

The owner selected explicitly reviewed changes for adopted skills with an unknown edit baseline. Replacement and removal require an exact path preview and approval. Unknown edit status stays unknown. Recovery applies where the selected policy permits it. Neither provenance nor missing metadata establishes ownership.

<a id="current-evidence-and-limits"></a>

## Pre-implementation evidence and limits

The following observations came from the earlier source inspection and disposable probes. File paths and line numbers identify the inspected snapshot, not the current source. The old repository history was later removed.

- `src/state/repo.ts:63-79,92-100` passed frontmatter to `gray-matter` during scan and preview. JavaScript frontmatter in a disabled skill changed a harmless global marker during the disposable scan.
- `src/actions/skillsCli.ts` invoked global upstream operations without the selected skills directory or a working directory.
- `src/actions/remove.ts:14-35` removed the selected path before rewriting lock metadata. In a disposable probe, `chosen/skills` linked to an outside directory, and removing `example` deleted the outside target.
- `src/actions/git.ts:17-20,53-74` ran Git in the selected root, staged with `add -A`, assumed `origin/main` for divergence and pull, and left the push destination to Git. A nested-root probe showed `commitAll` including an unrelated parent-repository file.
- `src/actions/update.ts:21-45` restored disabled skills before the updater without a `finally` block. `src/tui.ts:592-617` did not show returned re-disable errors, and `src/tui.ts:217-219` dispatched key handlers without awaiting prior handlers. The source suggested races, but no race probe was performed.
- `src/state/repo.ts:24-45,147-194` treated invalid lock data as empty, skipped directory symlinks, and joined metadata by name. `src/state/gitStatus.ts:3-9` displayed failed Git status as zero changes. `src/actions/open.ts:5-10` invoked the macOS `open` command.
- The old `package.json:2-17` marked the package private and declared no license, engine range, or file allowlist. An `npm pack --dry-run` reported 193 entries and about 14 MB, including development settings, vendored material, Graphify output, and backups. That was not a clean release artifact.

The build and 99 tests passed for the earlier directory cutover. SCB checked the changed CLI and repository test file but could not parse `src/tui.ts`. The dependency audit reported two high and two moderate vulnerabilities. Those checks did not establish release safety or test Linux. Earlier mock-based tests did not prove that an installed package or real upstream CLI was safe on a custom root.

## Execution order

The original plan placed the P0 safety phases before public release of mutations. Later phases depended on those boundaries. The plan required tests with disposable roots and outside sentinels. A sentinel is a file or link whose contents and target must remain unchanged.

### Phase 1: P0 inert parsing and filesystem boundaries

Affected files: `src/state/repo.ts`, `src/state/validation.ts`, `src/state/types.ts`, `src/actions/toggle.ts`, `src/actions/remove.ts`, `tests/state/repo.test.ts`, `tests/actions/toggle.test.ts`, and `tests/actions/remove.test.ts`. Add focused tests or a shared boundary module only where the implementation needs them.

Original work:

1. Replace both `gray-matter` entry points with one data-only parser for supported YAML frontmatter. Reject executable language tags rather than invoking their engines. Keep unsupported or malformed content visible as inert text with a clear status.
2. Enforce explicit parser budgets before expansion. Start with at most 64 KiB of frontmatter input, 50 nesting levels, 100 aliases, and 1 MiB of expanded metadata. Reject cyclic aliases and stop work as soon as a budget is exceeded. Record any tested adjustment before release.
3. Define the selected skills directory as the authorized location for each operation. Validate names and relative paths before access. Reject traversal, absolute child paths, invalid names, and ambiguous destinations.
4. Preserve an explicitly selected skills-directory link. Show its resolved target before selection. A link below that directory does not authorize changes to an outside target. An outside installation needs separate, explicit selection.
5. Enforce containment at the operation, not only with a prior string or `realpath` check. Resist a symlink swap between validation and use. If the runtime cannot enforce the boundary for an operation, refuse that operation and explain why.
6. Inspect links without recursively following them for removal. Never replace an existing destination as a side effect of enable, disable, install, or update.

Original acceptance:

- A JavaScript frontmatter fixture cannot change a global marker or an outside sentinel during scan or preview. Normal YAML still displays. Malformed YAML and unsupported tags show a warning without execution.
- Inputs at each documented budget pass where valid. Inputs over the byte, nesting, alias, or expansion budget and cyclic aliases fail visibly without unbounded work.
- Tests cover traversal, absolute names, unapproved linked roots, linked leaves, dangling links, and swapped paths. Unsafe operations must fail without changing outside sentinels or link targets.
- An explicitly selected skills-directory link works only after its target is previewed and the boundary is enforced. The app does not replace the link. A collision leaves source and destination unchanged. Failure is visible in the interface.

### Phase 2: P0 scope upstream CLI operations

Affected files: `src/actions/skillsCli.ts`, `src/actions/update.ts`, `src/state/repo.ts`, `src/tui.ts`, `tests/actions/skillsCli.test.ts`, `tests/actions/update.test.ts`, and `tests/tui.test.ts`.

Original work:

1. Replace unscoped global list, add, and update calls with an adapter tied to an approved skills directory and a tested CLI version.
2. Run remote preparation in a disposable workspace. Give the process an isolated home, working directory, and XDG directories. Enforce a filesystem boundary around the process. Environment variables alone are not a sandbox.
3. Import only reviewed staged results into approved locations through Phase 1 boundaries. Reject outputs that escape through links or collide with existing files. Do not assume an upstream root flag exists.
4. Use local scanning for local browsing. Keep search and remote add or update explicit. Report a missing, unsupported, failed, or unsafe CLI as unavailable rather than as an empty catalog or a successful update.
5. Keep existing local edits until the user reviews a proposed replacement. Preserve disabled state and known source metadata through a successful scoped update.
6. Treat the upstream parent lock as read-only external provenance. Test its versioned adapter against the actual upstream layout and match origin to the selected path. Keep app metadata in controlled app state. Never mutate or stage the parent lock.

Original acceptance:

- Integration tests use the real, explicitly selected upstream CLI version in disposable homes. They exercise list, add, and update with a custom skills directory. Use a controlled local source fixture where the tested CLI supports it. Record every changed path. Unrelated home, XDG, project, parent lock, and outside sentinel files remain unchanged.
- Fixtures cover an upstream parent lock with a matching path, an unrelated path, invalid data, and no lock. Only a verified association supplies provenance. Discovery and updates do not rewrite the external lock.
- A missing or unsupported CLI, an attempted outside write, an unsafe staged link, a collision, and an interrupted command produce a visible failure. They leave original skills, metadata, and sentinels unchanged or in the recoverable state specified in Phase 5.
- The local list and safe local actions work without a network connection or an installed `skills` CLI. A remote action stays unavailable if confinement cannot support it. The original plan blocked publication of that action as an advertised feature until the requirement passed.

### Phase 3: P0 scope Git operations

Affected files: `src/actions/git.ts`, `src/state/gitStatus.ts`, `src/tui.ts`, `tests/actions/git.test.ts`, `tests/state/gitStatus.test.ts`, and `tests/tui.test.ts`.

Original work:

1. Discover the actual Git top-level, selected skills directory, branch, remote, and upstream. Distinguish no repository, no Git executable, unborn or detached branch, and command error from a clean repository.
2. Enable Git actions only when the verified real top-level equals the selected skills directory. Verify a worktree's top-level rather than assuming its `.git` entry is a directory. If only a parent repository is detected, disable Git actions and retain local skills access.
3. Before nested initialization, inspect the parent index without modifying it. If any selected path is tracked, refuse initialization and explain that the parent will continue to track it. Do not untrack files.
4. For an untracked selected directory inside a parent repository, provide manual exclusion instructions. Verify that the parent excludes the selected path before a separate confirmation creates only the leaf repository. Never edit the parent's ignore files or index, create a submodule, or imply that exclusion makes one.
5. Scope status, staging, and commits to explicit literal skill paths inside the leaf repository, including disabled entries. Preview the exact files. Exclude transient state and recovery data. Preserve all unrelated staged and unstaged changes, even when an index already contains unrelated staged files.
6. Keep initialization, remote configuration, commit, fetch, pull, and push as explicit user actions. Never commit, initialize, configure a remote, or push as a side effect of skill management.
7. If the leaf repository has no remote, allow a separately approved `git remote add` with the user-supplied name and URL. Never overwrite an existing remote or change global Git configuration. The user creates a private remote outside the app. The app never creates a provider repository or changes its visibility.
8. Before a push, preview the actual remote, effective push URL, branch, upstream, and complete outgoing commit list. Redact credentials from the preview and logs. Warn that Git cannot determine destination privacy from an SSH or HTTPS URL. Ask the user to check access on the provider before the first push. Require separate approval and never force-push.
9. Treat push and pull as repository-level operations. If their full effects exceed the approved repository, paths, destination, or commits, block them. Explain that Git cannot push only part of a commit. Use fast-forward-only pull after an explicit preview, without overwriting local changes.

Original acceptance:

- With only a containing repository, fixtures show local skills and disable Git actions. An attempted commit cannot touch unrelated staged or unstaged parent files. Cancellation and failure leave the parent index, worktree, and sentinels unchanged.
- Parent-tracked selected files block nested initialization. Untracked files without a verified parent exclusion also block it. After the user arranges an exclusion and separately confirms initialization, only the selected directory gains Git state. The parent index and ignore files remain unchanged.
- An existing leaf repository and a verified leaf worktree enable Git actions. A confirmed leaf commit includes only previewed skill paths, including selected disabled entries. Unrelated staged and unstaged changes and transient recovery data remain untouched.
- Tests cover no repository, no Git executable, a worktree, an unborn branch, a detached branch, a different default branch, a renamed remote, and a missing upstream. None displays an error as clean.
- A local bare remote with a non-default branch receives only the commits shown in the confirmed preview. Unreviewed divergence, ambiguous destinations, unrelated outgoing changes, rejected pushes, and pull conflicts block the action without changing outside sentinels.
- The first commit and first push require separate approvals. Previews show the exact leaf repository, literal commit paths, redacted remote and effective push URL, branch, upstream, outgoing commits, and destination access warning. The user must check provider access before approving the first push.
- With no remote, only an approved `git remote add` changes leaf Git configuration. A declined or failed add leaves it unchanged. Existing remotes and global Git configuration remain unchanged. The app never creates a provider repository or changes its visibility.
- Use a local bare remote for an approved backup and cancellation. Simulate missing authentication and network failure without real credentials or external network access. Failed or cancelled remote configuration and pushes leave local skills usable. No push uses force. Redacted previews and logs contain no test credentials.

### Phase 4: P1 discovery, adoption, and onboarding

Affected files: `src/cli.ts`, `src/state/repo.ts`, `src/state/types.ts`, `src/tui.ts`, `tests/state/repo.test.ts`, and `tests/tui.test.ts`.

Original work:

1. Give an explicit `--skills-dir` priority. Use `~/.agents/skills` as the default directory. Change callers to pass the skills directory itself, not its parent.
2. Present the documented global skills directories and installer destinations as candidates. Inspect a candidate only after selection. Apply environment overrides only where the relevant harness documents them. Accept any explicitly selected directory, including a project-local one.
3. Identify direct skill entries by filesystem inspection. A valid candidate has a data-only `SKILL.md`. Include manual and local skills without an installer or lock. Show malformed candidates as invalid. Inspect nested repositories read-only.
4. Use `lstat` for links. Show broken links and preserve link text. Present independently selected installations separately. Identify paths that resolve to the same installation without merging separate copies.
5. Adopt in place. Discovery and adoption write nothing and do not copy, move, merge, relink, initialize Git, or alter lock metadata. Do not recursively scan the home directory. Exclude `.disabled_skills` and controlled state from active skill candidates, while listing disabled entries separately.
6. Use the tested read-only provenance adapter from Phase 2. Associate lock entries only with a verified selected path. Keep declared author, origin, and mutation permission separate. Unknown origin is not evidence of local ownership. A skill without a verified remote source is browsable but cannot update automatically.
7. Offer local Git initialization under the Phase 3 guards. Show the exact selected directory and any containing repository. Separately suggest a remote push for backup. Both choices default to skip, with no Git writes or network access.
8. For backup, use an existing remote or offer the approved remote-add flow in Phase 3. Show the commit and push previews there. Treat the first commit, remote configuration, and push as separate actions. Do not offer public publishing or change remote visibility.
9. Display the selected skills directory and Git state. Allow the user to revisit the selection without changing files. Continue using local skills after decline, cancellation, a missing Git executable, or a remote failure. Do not promise that remote features never need Git.

Original acceptance:

- A new home selects `~/.agents/skills` by default. An explicit `--skills-dir` selects that directory directly. Active and disabled examples appear at the paths specified above.
- Fixtures include documented per-harness directories, a manually created skill, a skill installed by a tool, invalid or missing frontmatter, a nested repository, duplicate names, a valid link, and a broken link. Project-local paths appear only after explicit selection.
- Fixtures cover a missing, invalid, unrelated, and matching upstream lock. Include enabled and disabled entries with missing or inconsistent catalog data. Origin remains unknown unless its association is verified independently. A manual skill without a verified remote source stays browsable, with automatic updating unavailable.
- Show supported declared author names independently of origin. A missing or invalid author is unknown. With verified remote, confirmed local, missing lock, and inconsistent origin fixtures, show the values in the table above. Never infer the user's authorship.
- If the recommended source filters are selected, keep unknown entries in the all view and out of the local and remote filters. Give unknown origin its own filter. Never label an unknown origin local or remote. If an author filter is selected, match declared names or unknown only. No source or author category grants update or deletion permission.
- Discovery, adoption, decline, and cancellation preserve bytes, link targets, metadata, parent files, and outside sentinels. Independent directories are not merged. No app state, lock, link, or `.git` entry is created by adoption.
- The scanner does not mistake `.git`, `.disabled_skills`, recovery data, or other controlled nested state for active skills. It lists valid disabled entries separately and does not recursively scan the home directory.
- An approved initialization follows every Phase 3 parent-repository rule and creates Git state only at the displayed skills directory. A no-repository selection still lists and manages local skills. An initialization error leaves existing files and outside sentinels unchanged. Show the error and any incomplete new `.git` state.
- Skipping the onboarding offers makes no Git writes or network requests. A backup through a real bare remote receives exactly the reviewed outgoing commits. Cancellation, missing authentication, and network failure leave the skills available and report the failure.

### Phase 5: P1 identity, ownership, and recoverable mutations

Affected files: `src/state/repo.ts`, `src/state/types.ts`, `src/state/provenance.ts`, `src/actions/toggle.ts`, `src/actions/remove.ts`, `src/actions/update.ts`, `src/tui.ts`, and their existing tests under `tests/state/` and `tests/actions/`.

Original work:

1. Identify a skill by installation and path, not by name alone. Represent links and independent copies without merging their state. Associate external lock metadata only through the tested path match.
2. Mark absent, invalid, or ambiguous provenance as unknown. Source provenance and declared author metadata do not establish ownership or authorize a mutation. Do not classify a failed catalog, missing lock, or malformed lock as proof that a skill is local or owned.
3. Show whether a row is a directory, a link, an independent copy, or an orphaned metadata record. Preview every affected path before a destructive operation. Preserve existing links and never delete a link target merely because the link was selected. For an explicit toggle, move only the selected entry between the skills directory and its `.disabled_skills` directory. Preserve link text. Warn that dependent links to a moved directory can dangle until it returns.
4. Treat deletion after the operation's durable completion point as irreversible. This is an operation-state transition, not a Git commit. Show the affected path, ownership, local changes, and the lack of guaranteed undo after recovery cleanup. If a trusted baseline is absent, mark ownership or local changes as unknown. Require explicit confirmation for that path. Never delete an unowned target or overwrite a locally edited skill without a separately reviewed policy and user authorization.
5. Serialize mutations for an installation across key events and concurrent application instances. Reject or queue a competing action. Recover stale locks without discarding user data.
6. Write controlled app metadata through a same-directory temporary file and atomic replacement. Do not rewrite the external upstream lock. Sync the file and parent directory where the runtime supports it. Report any durability limit. Stage originals in a protected recovery area on the same filesystem. Record intent and progress before any irreversible deletion. Define a durable commit point. Do not claim that a multi-file operation is atomic.
7. Restore disabled state in cleanup after failures. On a crash, show the recovery state at startup. If automatic recovery cannot determine a safe result, preserve originals. Surface every cleanup error. The current remote update implementation does not temporarily enable live disabled skills.

Original acceptance:

- Duplicate names in separate installations remain distinguishable. Two selections that resolve to the same installation do not create a second copy. Invalid lock data, duplicate names, and catalog failure show unknown provenance and do not by themselves authorize deletion or update.
- A linked skill, an independent copy, a locally edited managed skill, an orphan, and a destination collision each show an accurate preview. A toggle preserves link text and restores the entry to its original location. Cancel, refusal, or failed confirmation leaves all files, links, and sentinels unchanged.
- Fault injection covers a failed rename, write, atomic replacement, updater exception, process interruption, and restart at each recorded phase. Before the commit point, the original remains recoverable. After a confirmed deletion commits, restart reports completion or safe cleanup rather than promising undo. Outside sentinels remain unchanged.
- Simultaneous toggle, remove, update, and second-process requests cannot interleave on the same installation. A re-disable failure is visible and never reported as a successful clean update.

### Phase 6: P1 platform behavior and offline policy

Affected files: `src/actions/open.ts`, `src/actions/checkUpdates.ts`, `src/actions/skillsCli.ts`, `src/tui.ts`, `tests/actions/open.test.ts`, `tests/actions/checkUpdates.test.ts`, and `tests/tui.test.ts`.

Original work:

1. Open files and supported source URLs with the platform mechanism. Use argument arrays, not a shell command. If no opener is available, show the path or URL. Do not assume every source is GitHub.
2. Handle clipboard availability for both host and terminal. Report failure and keep selection usable. Provide keyboard alternatives that work without macOS Option-key behavior.
3. Provide a readable fallback for unavailable fonts or glyphs. Keep controls identifiable without a Nerd Font.
4. Apply the approved network policy to startup, update checks, search, add, and update. Distinguish offline, disabled, failed, and no-update results. Keep local operations available.
5. Document remote destinations, authentication, and upstream telemetry. Respect `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`. The upstream [telemetry policy](https://github.com/vercel-labs/skills/blob/main/docs/troubleshooting.md#telemetry) states that these also disable its security-audit requests. Do not log credentials or tokens.

Original acceptance:

- macOS and Linux tests cover the proper opener and a missing opener. Clipboard and keyboard tests cover host clipboard failure, terminal fallback, and alternate navigation. Glyph fallback remains legible.
- With network access disabled, startup and local browsing complete without network requests. Remote actions report why they are unavailable. A timeout or failed request does not look like an empty successful result.
- Offline, opener, clipboard, and network failures do not change the selected installation or outside sentinels. Logs and previews contain no test credentials.

### Phase 7: P1 runtime, release artifact, and public documentation

The original scope included `package.json`, `package-lock.json`, `src/cli.ts`, existing tests, `README.md`, and other release documents. The plan called for the selected license after the owner confirmed copyright and for approved security reporting instructions.

Original work:

1. Select and document supported runtime versions and the exact upstream CLI contract. The published [`skills@1.7.6` metadata](https://registry.npmjs.org/skills/1.7.6) declares Node `>=22.20.0`. The published [`@opentui/core@0.5.11` metadata](https://registry.npmjs.org/@opentui%2fcore/0.5.11) declares Bun `>=1.3.0` and Node `>=26.4.0`. These declarations do not prove application compatibility.
2. Test the selected `skills` version and its output formats, installation layout, update behavior, and telemetry policy. Do not infer compatibility from the currently installed version or from the newest published version.
3. Make the installed executable, shebang, runtime declarations, native dependencies, and documented commands agree. If a Node package with `npx` is selected, test its exact version-pinned command. If it includes the upstream CLI, test how the confined adapter resolves that dependency. If the CLI stays external, document and test its separate installation. If selected, test the Homebrew dependency and wrapper, or the standalone executable and upstream CLI strategy. Keep npm publication optional. Do not change `private` merely to support repository distribution.
4. Audit the exact files in the chosen public artifact and repository publication. Exclude private settings, secrets, backups, vendored development material, Graphify output, and unnecessary files from the runnable distribution. Review tracked repository documentation and graph artifacts separately for intentional public inclusion. Review history before making a repository public. Do not rewrite history without authorization.
5. Publish the selected MIT license and required notices after rights and copyright are confirmed. The upstream [`skills` license](https://github.com/vercel-labs/skills/blob/main/LICENSE) requires its notice for copied substantial portions. Inventory all other bundled material separately.
6. Document installation, prerequisites, default and custom skills directories, adoption, optional leaf Git initialization and remote backup, parent repository safety, offline use, supported platforms, privacy, updates, removal risks, and recovery. Explain the approval steps, destination access warning, and harness limitations. Provide a private vulnerability reporting path chosen by the owner.

Original acceptance:

- In clean disposable environments, follow the final public installation instructions and launch the installed `skills-manager` executable in a terminal. Do not substitute a source checkout, mocks, or a successful build for this test.
- If `npx` is selected, launch the exact tested package from a clean environment with compatible Node and no Bun. If the package includes the pinned upstream CLI, exercise it through a controlled fixture without a global CLI install. If the CLI stays external, test its separate installation for remote actions. Inspect the package and native assets. Do not promise a download prompt or offline use.
- If a Bun-compiled file is selected, launch and browse local skills without installed Bun or Node. Test the separately bundled upstream CLI, or document and test its required Node installation for remote actions.
- Run the installed release on macOS and Linux for every advertised runtime, architecture, and libc combination. Exercise onboarding, existing-skill adoption, local actions, CLI integration, Git destination preview, and offline startup. Record versions and results. A missing matrix result blocks the corresponding support claim.
- Inspect the final release artifact and repository contents. No private file, token, backup, development setting, or outside sentinel is included or changed. Required license and notice files are present.
- Run the project tests and build, the scoped source-security review, and the dependency audit on the release candidate. Resolve valid findings or record an approved release decision. A scan parse error is not a clean result.

## Release completion

The acceptance criteria above record the original release gates. The verification and limits below record the observed results and remaining boundaries.

In the normal browse or Git view, `?` opens scrollable keyboard help. `Up` and `Down` scroll a line, and `PgUp` and `PgDn` scroll a page. Press `?` or `Esc` to return to the prior view. Text prompts keep `?` as text. The earlier test results in the table below do not cover this later interface change.

<a id="implementation-verification--2026-11-04"></a>

## Implementation verification, 2026-11-04

The implementation keeps the `skills-manager` name, defaults to `~/.agents/skills`, adopts existing entries in place, and leaves Git optional. The recorded installation checks used Node 26.13.0 and npm. The remote-action checks in this record used `skills@1.7.6`. These results apply to the candidates tested at the time, not to later changes. They do not establish a security guarantee.

| Check | Observed result |
| --- | --- |
| Host build | Both native helpers and TypeScript compiled |
| Full host suite | 24 files passed, with 463 tests passed and 11 skipped |
| Installed macOS arm64 tarball | Actual executable, onboarding, linked/custom roots, cancellation, toggles, filtering, Markdown/raw controls, offline browsing, and exit cleanup passed |
| Installed pinned CLI | Actual local-source prepare, reviewed import, discard, outside-link refusal, and receipt creation passed without a global CLI or Bun |
| macOS remote refs | Controlled smart-HTTP fixtures passed for encoded refs and selectors. Mismatched approvals and changed source associations were refused |
| Linux arm64 | Nonroot source installation, actual PTY browsing, mutations, reviewed imports, and Git initialization/commit/push/fetch/pull passed |
| Linux final deltas | Restored-byte/stale-mtime pull preserved unrelated staged and unstaged data. Reviewed import and identity-approved disposal passed |
| Dependency audit | `npm audit --audit-level=moderate` reported zero vulnerabilities, including development dependencies |

The previously verified macOS tarball had exactly 34 reviewed members, including both platform-tagged native helpers and license/notices files. Its SHA-256 was `3b2eef218223334154373bf8d0e736dfde2a42cfcdc7141a4c58c0e3e3017236`. Its source fingerprint was `382a047b0d449331f5f3cd203cdccbce15b31d7dece57deaa85c71a0dd83966e`. This is the agent's sorted per-file source-hash fingerprint, not a Git commit ID. The previously verified Linux source-export archive hash was `0416b7f73d4987af5fe0345ac1c67846ad27a1404e715e6f73164675935db12e`. These hashes identify earlier artifacts, not a package built after later changes. Disposable exports, installations, and smoke fixtures were removed.

### Latest local verification, 2026-11-04

On macOS arm64, Node 26.13.0 and npm 11.20 built the project and passed the post-build package guard. A real terminal smoke test of an installed 34-file tarball passed, including help open and close, native filesystem actions, and Git sentinels. Captured frames showed contiguous `Keyboard help` and `? help` text and passed the split-text checks.

The first full suite had 464 passed, 3 failed, and 11 skipped across 24 files. All three failures were in the TUI file. Test-only changes removed an incidental footer assertion, checked the wrapped push destination, waited for prompt dismissal, and raised one Git case timeout to 20 seconds. After those changes all 48 TUI tests passed. The other 23 files passed in the earlier run; the full suite was not rerun locally.

A copy of `skills@1.7.6` with a simulated `99.0.0` manifest exercised string and object bin entries with a nonstandard path. Lexical and symlink escapes were refused. This does not test a published `99.0.0` version.

The npm audit reported zero vulnerabilities, including development dependencies. The resolved `vitest` and `@vitest/mocker` versions were 4.1.12, `vite` was 8.3.5, and `esbuild` was 0.28.2.

SCB checked five changed files with no parse errors or security-pattern findings. It reported 36 complexity and four duplication advisories in source; both test-file scans exited zero. The advisories were retained because explicit validation, mode, and cleanup checks cover different states.

A Graphify update reported 33 hub-derived community renames; nine former community names disappeared. A follow-up refresh after the test changes printed no rename count and lost no community names.

### Review findings

Every `src/` and `tests/` file changed in the tested candidate received a scoped SCB check. Remaining advisories concern complexity and duplication. They are not a clean security signoff. Parser budgets, journal schema checks, filesystem identity checks, and recovery transitions remain explicit to keep failure boundaries visible. Repeated checks and fixtures cover different states, including separate crash scenarios. No scanner parse error is counted as success.

The source security review found no additional actionable Git transaction issue within the approved concurrency contract. Runtime probes demonstrated reserved-metadata refusal, nonblocking FIFO-journal refusal, two-process serialization, and preservation of outside targets. Four shared-header unused-function compiler warnings remain. Those functions are used by the other native helper.

The source snapshot retains licensed, repository-local development skills and their relative development symlink. Private settings, machine-local sidecars, and dated backups are untracked while their local copies are retained. Historical personal inventory and workspace-remote details were removed from the design and public graph artifacts.

An offline Gitleaks scan of the prospective public snapshot used full redaction and reported no findings. It covered the 185 selected entries, not private Git history or preserved local backups. This is pattern-scanner evidence, not proof that publication is safe.

Three guarded Graphify AST refreshes reported 32, 35, and 36 hub-derived community renames. They did not re-extract document semantics, so historical document-derived relationships are not necessarily current.

### Publication verification and limits

The recreated repository is public at the same URL, with `main` as its default branch. GitHub private vulnerability reporting, secret scanning, and push protection are enabled.

An active GitHub [ruleset](https://api.github.com/repos/ederheisler/skills-manager/rulesets/26549966) requires pull requests for `main`, resolved review threads, and the `Required checks` status from GitHub Actions (integration ID `15368`) with strict up-to-date enforcement. It blocks branch deletion and force pushes and requires no approving reviews. Local checks do not establish that the status appeared on a pull request.

The `Release` workflow is configured to follow a successful `Native portability` run for a `main` push. It checks the protected branch head and matching semantic versions in the manifest and lockfile. Its API-only job creates the matching tag and GitHub Release. This pre-release evidence does not establish a workflow-created release or a tagged `npx` launch. See [Actions](https://github.com/ederheisler/skills-manager/actions) and [releases](https://github.com/ederheisler/skills-manager/releases) for current status.

An anonymous, credential-free clone of `081ffc7` from the public URL passed with an isolated home and Git configuration. In that clone, `npm ci` built the project and passed the package guard. The audit reported zero vulnerabilities. With Node 26.13.0 and npm 11.20, the `node dist/cli.js` command and `--skills-dir` option launched in a real terminal. Onboarding skipped both Git prompts, displayed the existing skill, and exited successfully. The skill remained unchanged, and no Git or manager metadata was created. This check used no Bun or global upstream CLI. It covered onboarding and browsing, not the full installed-tarball smoke test.

A separate credential-free macOS arm64 test used `npx --yes github:ederheisler/skills-manager#5178c7a13447d05d94aee4d29d88e645cb5295cd` with Node 26.13.0 and npm 11.20. Git preparation built the native helpers and TypeScript. Bun and a global `skills` CLI were not installed.

The command passed both with no arguments and with `--skills-dir` selecting an existing directory. In each real terminal session, onboarding skipped both Git prompts, displayed the existing skill, and exited with code 0. The fixtures and isolated home and XDG contents remained unchanged. npm used a separate disposable cache for downloads and builds. No Git or manager metadata was created. These checks covered installation, onboarding, and browsing, not the full installed-tarball smoke test. The README uses the `v0.1.0` tag instead of the commit tested above.

Production source was unchanged between the host build, full suite, and a subsequent local installed-release smoke test. That smoke test passed on native macOS arm64 with Node 26.13.0. It exercised terminal onboarding with the default Git choice set to no, native boundary mutations, links, stale refusal, and collision preservation. It also exercised the pinned `skills@1.7.6` sandbox prepare, discard, and apply operations. Real Git commit, push, fetch, and pull preserved unrelated staged and worktree changes.

In [Native portability workflow run 41855041774](https://github.com/ederheisler/skills-manager/actions/runs/41855041774), at candidate `28de42a`, the native Linux x64, Linux arm64, and macOS x64 jobs passed. Each successful job installed a tarball and ran the installed-app smoke test in a real terminal. Both Linux jobs also passed sandboxed upstream and loopback Git ref tests. The earlier Bubblewrap `EPERM` limitation did not apply in these CI jobs, which supplied the required kernel permissions.

The macOS arm64 job in that run acquired no runner and had no steps. GitHub canceled it and reported that no job was acquired because of capacity constraints. This was a runner capacity limit, not an application failure. Native macOS arm64 evidence comes from the local installed-release test, not a successful job in that run.

In the later [workflow run 41858374818](https://github.com/ederheisler/skills-manager/actions/runs/41858374818), both Linux jobs passed. Both macOS jobs acquired no runner, had no steps, and were canceled after 15 minutes. GitHub reported capacity constraints and no acquired job for arm64, and no acquired job for x64. Neither cancellation exercised the application.

The owner subsequently chose local native verification for macOS arm64 and removed that duplicate hosted job. CI retains Linux arm64, Linux x86_64, and macOS x86_64. This changes where macOS arm64 is verified, not the supported platform matrix.

An offline Gitleaks scan of all 36 commits in the old history covered 24.18 MB and reported zero findings. The owner authorized replacing that history without an archive or backup. The original repository was deleted and recreated at the same URL with a parentless clean root. Before fresh CI, the recreated repository had zero pull requests, zero Actions runs, only `main`, and no tags. The old five pull request refs and Actions history were gone. Local reflogs and old objects were pruned, and old commit `9d50dfa` was confirmed missing. The new root `28de42a` initially contained only the audited source, totaling 7.5 MB. A prospective-history Gitleaks scan covered two clean new-root refs totaling 15.03 MB and reported zero findings. These scans do not prove that the repository contains no sensitive data.

Linux mutations require Landlock ABI 5 or later and mount-aware `statx`. Remote actions on Linux also require working Bubblewrap and the required kernel permissions. Remote installs on macOS require Apple-signed Git 2.48 or later from the active Xcode or Command Line Tools installation. If a required boundary is unavailable, the app refuses the affected action.

A matching source receipt records continuity for an installation. It does not authenticate a publisher or prove prior approval. Restoring untrusted manager state can falsify source associations.

The macOS offline wrapper verified browsing but cannot nest write confinement. Ordinary, non-nested installed mutations passed separately. The app does not claim a general hostile-code sandbox or protection against concurrent external edits. If confinement prevents safe cleanup, the app retains and reports the temporary path rather than deleting without a boundary.
