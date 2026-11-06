# In-app application update plan

Date: 2026-11-05

Status: Implemented. Runtime results and supported-platform checks are recorded below.

This plan and its results describe the earlier temporary-session updater. The user later chose [persistent installation](../../decisions/2026-11-03-open-source-portability.md#persistent-installation), which supersedes that installation target and repeated `npx` launches. The current route uses one `npx` launch, followed by approval in Application updates. Earlier checks do not verify the persistent updater or that complete installation route. The current [security policy](../../../SECURITY.md#application-and-cli-updates) describes its boundaries.

## Behavior and evidence when proposed

The [README](../../../README.md#quick-start) directed users to run `npx --yes --prefer-online github:ederheisler/skills-manager` for latest `main`.
Before implementation, a running app did not notify users of application updates or update itself. Local browsing made no background network requests.
The earlier [portability decisions](../../decisions/2026-11-03-open-source-portability.md#implementation-choices) required explicit network actions.
The later approval changed that policy only for users who explicitly enable automatic checks for the relevant hosts.

A prior cold and warm run used this same command and the same npm cache on macOS arm64 with Node 26.13.0 and npm 11.20.0.
The runs used main commits `289af86f428ec8554802434c3be483c3b1faffcd` and `68fe67310dee87d3fa653816151d02029c8791b6`.
Both builds reported package version `0.1.0` and built native components.
Each real terminal run adopted existing skills, declined Git and backup, opened help, and quit with exit code 0.
The observed home, XDG, skills, outside sentinel, and working-directory state remained unchanged.
The runs demonstrate the distribution route, not an in-app updater. Package version alone cannot identify a main commit.

The manifest lists shipped files explicitly and runs a build during `prepare` ([package.json](../../../package.json)).
The [package check](../../../scripts/check-package.mjs) enforces the source-to-distribution allowlist.
The [release workflow](../../../.github/workflows/release.yml) manages version tags, not every main commit.
GitHub's [commits API](https://docs.github.com/en/rest/commits/commits#get-a-commit), not its latest release, is the comparison authority.
A main commit is not necessarily a successful post-merge build or release.

The CLI creates the renderer after onboarding and `app.start()` completes startup, not the app lifetime ([CLI](../../../src/cli.ts)).
The TUI destroy handler starts asynchronous cleanup without awaiting it ([TUI](../../../src/tui.ts)).
Existing `u`, `p`, and `v` actions concern skills. Application updates need separate state and controls.
The app resolves the bundled Vercel `skills` CLI relative to its own sandbox module, not through `PATH` or a global installation.
The dependency specifies `latest`, but an existing lockfile or installed package can retain an older version.
A fresh `npx` cache alone does not guarantee that the CLI resolves to the current registry tag.
The CLI is separate from the user's installed skill documents and the skill actions above.

## Approved user flow

1. Add an Application updates menu in browse mode and make it discoverable from `?` help.
   Show separate rows for skills-manager and the Vercel `skills` CLI. Keep existing skill shortcuts unchanged.
2. Offer separate Check now actions and automatic notification controls for the app and CLI.
   Default both automatic controls to off. A one-shot check grants one bounded request for the disclosed host scope.
3. Explain the GitHub host for app checks and the npm registry host for CLI checks.
   Explain IP address exposure, the daily cadence, and how to disable checks before saving consent.
   Automatic CLI checks require registry consent. GitHub consent alone does not authorize them.
4. Show the running app version and build SHA, the checked main SHA, and the check time.
   Show the CLI package version actually resolved by the running app and the registry's latest tag version.
   The latest tag is informational, not a compatibility guarantee or a tested-version gate.
   Unknown identity, offline checks, and invalid responses never mean that either component is current.
5. Display a persistent, nonmodal badge for available or different builds without stealing focus.
   Keep the badge separate from temporary status messages. Do not use desktop notifications.
6. Offer review and an explicit CLI-only refresh even when the app SHA matches main or the CLI check failed.
   A user can approve a fresh CLI refresh without a successful prior check.
   Offer Update and restart to refresh both the app and CLI. Select Cancel by default.
7. Explain the isolated session, registry and GitHub access, and required Node, npm, Git, and C compiler.
   Explain that repository and dependency scripts run with normal user permissions. Do not install automatically.
8. Offer the canonical manual app command with a safely shell-quoted current absolute skills directory and clipboard copy.
   This command does not guarantee a fresh CLI. Offer CLI refresh through the controlled helper or documented manual instructions.
   Never execute the display string or start an update on ordinary quit, Ctrl-C, or renderer destruction.

A source checkout, tagged install, or install with unknown origin defaults to the manual route.
An explicit switch-to-main choice can launch the same new session, but must not imply an in-place channel conversion.
The same commit can arrive through different channels, so a SHA alone cannot identify the installation channel.
For CLI-only refresh, retain a known, reproducible full running app SHA and rebuild that same SHA.
For unknown, dirty, or otherwise nonreproducible identity, offer a manual route or an explicit switch to main.
Never copy or overwrite a user checkout. An unchanged app SHA does not disable CLI checks or refresh.

Amendment, 2026-11-05: The update screen uses the main view's colored letter controls. Enter does not enable automatic checks or approve actions. Automatic-check consent requires an explicit `y`. Both app and CLI update actions remain offered without a successful check or an available version. Do not show raw `latest` or `unknown` placeholders in place of useful status.

New approval starts a check immediately and permits later daily checks for that component and host. Each permission remains off by default and separate. With permission on and no completed result, startup checks even when an old attempt timestamp exists. Save completed successes and failures in the private, host-scoped cache and show checking while a request is in progress. Recompare restored results with the current build or CLI identity. A recorded attempt alone is not a completed check.

## Implementation slices and dependencies

### 1. Prove and package build identity

First prove the actual public GitHub `npx` prepare path on real source snapshots. This is a release gate, not an assumed npm behavior.
Investigate a tracked `export-subst` template with a full commit SHA and a build-time Git fallback only for an exactly verified source root.
Git documents [export substitution](https://git-scm.com/docs/gitattributes) and [archive behavior](https://git-scm.com/docs/git-archive).
Neither document proves that npm preserves substitution on this route.

Embed the full SHA, known/dirty/unknown state, and source kind in the built package. Preserve unknown when evidence is absent or invalid.
Reject placeholders and malformed IDs. Mark modified or otherwise uncertain source honestly. A clean identity is not a build attestation.
Do not use runtime cwd, the selected skills repository, an npm cache path, or a live-main query to label the running build.
Make the generated artifact part of `package.json` shipping rules and `scripts/check-package.mjs` validation.
Update build inputs, copied-source fixtures, package tests, and artifact tests together. Stop the feature release if actual source identity cannot be proved.

### 2. Add consent, scheduling, and comparison

After identity exists, add configuration and checkers for the two components, separate from skill updates.
Use absolute `XDG_CONFIG_HOME`, or the home configuration fallback, for explicit consent.
Use absolute `XDG_CACHE_HOME`, or the home cache fallback, for authorized check metadata.
Do not create update-consent configuration on startup. For this feature, persist only explicit consent and authorized check metadata.
Reject unsafe symlinks and overlap with any skills root. Never write to a selected skills directory for this feature.
Missing consent means off. Invalid, unreadable, or unwritable consent fails closed and is reported.

For an authorized app check, request only `https://api.github.com/repos/ederheisler/skills-manager/commits/main`.
For an authorized CLI check, request latest-tag metadata from the disclosed npm registry.
Use the public npm registry by default. A custom registry must use matching check and install origins.
If the install origin cannot be established or differs, report it as unknown or disclose the actual origin before approval.
Never log registry tokens or credentials.
Bound request time and response size, validate responses, and escape untrusted output for the terminal.
Compare full app SHAs and show short SHAs only for display. Equality means a match at check time, not a release guarantee.
Unequal app SHAs mean different builds, not necessarily newer builds.
Treat offline, timeout, cancellation, HTTP errors, rate limits, and invalid responses as unavailable, never up to date.
Do not present an old cached result as a current check.

After valid opt-in for each component and host scope, schedule a nonblocking check after startup and at most one attempt per 24 hours.
Record attempt times per component and requested hosts. Schedule another check during a long-running session once the interval expires.
Serialize attempt claims across app instances and write cache metadata atomically. Keep this coordination separate from skills locks.
On disable or exit, abort pending requests and invalidate their results.
Disabling takes effect in the current session even if saving fails. Report that failure and the risk of retaining old consent on future launches.
Avoid duplicate in-flight checks and preserve UI responsiveness during help, confirmation, and other work.

### 3. Add review and guarded handoff

The TUI owns menu state, the badge, and review. Reuse its exclusive-action and cancel-by-default confirmation patterns.
Block handoff while an action is busy or a prepared review, Git operation, editor, or prompt remains unresolved.
Do not discard changes or finish a review on the user's behalf.
Capture the current resolved absolute skills directory at approval, not the original command-line argument.
Pass it as a separate `--skills-dir` argument without a shell or unknown forwarded arguments.
The original approval required the new app to repeat onboarding and revalidate directory identity. This prevented an old approval from becoming new authorization.

Amendment, 2026-11-05: The user superseded repeated onboarding with persisted completed setup. Every launch, including the update child, must freshly validate the physical root. Reuse completed setup for an unchanged root. Prompt for a new or changed root. Saved setup does not authorize future writes or Git actions. Update-host consent remains independent in `app.json` and `cli.json`, and startup network rules do not change. See [persisted setup](../../decisions/2026-11-03-open-source-portability.md#persisted-setup-and-existing-installer-tracking).

Before implementing handoff, prove [Node 26 `process.execve`](https://nodejs.org/docs/latest-v26.x/api/process.html#processexecvefile-args-env) in real macOS and Linux terminals.
It is experimental, replaces the process image, skips exit and cleanup handlers, and throws on failure.
Prove same PID and standard streams, terminal restoration, signal behavior, and failure handling with a real pseudo-terminal.
Do not assume that `await app.start()` waits for quit. An equivalent replacement requires the same demonstrated properties.

A local macOS arm64 probe with Node 26.13.0 demonstrated process replacement, preserved terminal streams, cleanup ordering, and readable failure handling.
The probe used fake tools, not OpenTUI or real npm. Basic terminal flags recovered, but the complete terminal state did not match.
Linux, signals, full terminal restoration, and actual app integration remain required implementation gates.

Give the CLI an explicit app-lifetime result and awaited shutdown path for approved handoff only.
Abort checkers, await app-owned pending cancellation, clipboard and markdown cleanup, and release app locks.
Destroy the renderer and restore the terminal before replacing the process. Resolve required executables before handoff.
Before shutdown starts, a failure leaves the old app usable. After terminal teardown, an exec failure must show an error and manual recovery command.

Copy a minimal independent helper into a private app-owned temporary workspace outside the current package, caches, checkout, and skills roots.
Replace the old process image with that helper before npm starts. The helper uses argument vectors, not a shell.
Preserve normal `HOME` and legitimate user configuration. The helper starts a new session and does not replace the current installation.
Keep the workspace for the new app's lifetime. If the new app exits with status zero, attempt identity-checked cleanup of only that workspace.
If the new app exits abnormally or is interrupted, retain and report the workspace because descendant processes can still run.
A hard kill or crash can also leave the workspace without reporting its path. Report the path when cleanup fails or is unsafe.

The combined update can obtain a later main commit than the reviewed SHA. Explain this before approval.
The new build displays its actual identity. A child process starting is not proof that the app reached browsing.
After process replacement, report launch or build failures in readable terminal text with the primary manual recovery command.
Do not promise restoration of the old UI, rollback, reproducible builds, pinned transitive dependencies, or a hostile-code sandbox.
Never pull, reset, stash, install, or build in a user checkout.
Do not alter installed skill documents, the global CLI, user lockfiles, or user symlinks. A staged private CLI package is in scope.

### 4. Refresh the Vercel skills CLI

This slice depends on the consent, identity, and guarded handoff slices. Its implementation is under verification and the supported-platform proof remains required.
After approved shutdown and process replacement, the helper creates a new private npm project with no existing lockfile.
The project is outside the running app, shared npm caches, checkout, and skills roots. Give it a separate private npm cache.
Declare root dependencies on `skills-manager` from GitHub and `skills` at `latest`.
Use main for the combined update and the full running app SHA for a CLI-only refresh.
Use the root override `{"skills":"$skills"}` to refer to the root `latest` dependency and select it for nested dependencies.
Run `npm install --prefer-online` with argument vectors, the private project as the actual working directory, its private cache, and the approved registry.
The private project has no prepare script of its own. The root override applies only to this disposable project, not the source manifest or lockfile.
Do not run npm install inside the installed app package. Its prepare script can require build scripts that are not shipped.
An explicit install is required. A new cache or a plain `npx` launch is not evidence of a fresh CLI.

Before launch, use the new app's actual module-relative resolver to identify `skills/package.json`.
Make sure its canonical package root is the one selected by the explicit refresh. Refuse a different package visibly.
Apply the existing package identity, bin containment, and dependency-closure checks before starting the new app.
Keep the operating-system sandbox, schema, and provenance checks unchanged. Report the resolved version as metadata, not an allowlist gate.
Launch the new app through its declared bin without guessing from `PATH` or npm cache internals.
The override approach does not require external path injection if the implementation gates prove it.

A local feasibility probe used a synthetic Git app and controlled registry on macOS arm64 with Node 26.13 and npm 11.20.
The Git app lock selected `skills` 1.0.0 during prepare. The root dependency and override selected 2.0.0 from the app module.
After the registry tag advanced, a new session selected 3.0.0 while the first session retained 2.0.0. Both selected bins ran.
The probe used canonical paths for containment. It did not use the real app, Vercel CLI, complete dependency closure, or sandbox.
Also prove the public GitHub app and current `skills` latest tag with the stale source lockfile, cold and warm caches, and actual confined CLI execution.
Test all supported platform combinations before claiming support. Until then, do not present the mechanism as proven or claim supported-platform completion.
Manual CLI refresh instructions must preserve these boundaries and must not use global npm installation or `skills update`.
The existing canonical `npx` command remains an app recovery route, not a complete CLI refresh.

### 5. Update affected interfaces and documentation

Update CLI lifetime callers, TUI construction and teardown callers, configuration and help callers, tests, build metadata generation, and strict package allowlists.
At implementation time, update the README, security policy, CLI help, and decision record for default-off consent and network behavior.
Document the isolated-session limits, manual recovery, and main-versus-tag distinction. Keep existing release and protected-main policies unchanged.
Describe the approved implementation and policy accurately. Do not claim runtime proof before the acceptance results are recorded.

## Acceptance and runtime verification

Run verification only after the slices are integrated. Record commands, environments, results, and limitations in the implementation change.
Use disposable homes, caches, skills roots, and outside sentinels. Do not use a user's live skills directory as a test fixture.

- Prove the real public unpinned `npx` prepare path embeds the actual full source SHA on two same-version main commits.
  Repeat cold and warm with one npm cache. Move main during preparation and make sure identity remains the fetched source, not live main.
- Exercise archive substitution, a verified checkout, dirty inputs, missing Git, enclosing unrelated repositories, copied packages, and invalid metadata.
  Exercise tagged and source installs without inferring their channel from SHA. Check the packed artifact and strict allowlist.
- Prove no app or CLI check requests occur without valid consent for that component and host.
  Check separate one-shot scopes, registry and GitHub consent, daily per-component cadence, revocation, invalid storage, and unsafe paths.
  Check public and custom registry origins, mismatches, disclosure, and that credentials never enter logs.
- Exercise equal, unequal, unknown, and dirty identity. Exercise timeout, offline, 403, 429, server errors, invalid data, cancellation, and stale-result suppression.
  Complete checks during help, confirmations, busy actions, and shutdown without changing focus or replacing a dialog.
- Exercise cancel, busy refusal, unresolved reviews, ordinary quit, signals, and Ctrl-C. None can launch an update without explicit approval.
  Test current switched roots, spaces, quotes, leading hyphens, changed symlinks, physical-root validation, and persisted setup reuse in the child. A new or changed root must prompt.
- With fake tools and real terminal fixtures, inspect exact argv, environment, private project cwd and cache, process replacement, and cleanup order.
  Exercise missing tools, download and build errors, lifecycle script policy, aborts, exec failure, child failure, and interrupted workspace cleanup.
  Make sure checkout, active installation, skills trees, lockfiles, outside sentinels, and other instances' caches remain unchanged.
  Failure must not claim a successful refresh or mutate those installations.
  Exercise a fixed app SHA as the registry tag advances beyond the locked version, including offline and failed checks.
  Approve CLI refresh without a prior successful check. Exercise unknown and dirty identities and explicit switch to main.
  Test cold and warm caches, the stale source lockfile, nested package resolution, wrong package identity, and malformed or escaping bins.
  Run the selected CLI through the same adapter and macOS or Linux sandbox. Preserve schema and provenance checks.
- Run the actual approved in-app handoff through renderer-ready browsing in a real terminal. Observe the new build identity and manual recovery on failure.
  Repeat on local macOS arm64 and the existing CI matrix: Linux arm64, Linux x64, and macOS x64.
  Retain existing installed-package browse, help, quit, and confinement checks. Record platform-specific limits instead of claiming untested support.

### Verification

On macOS arm64 with Node.js 26.13 and npm 11.20, `npm run build` passed.
`npm test` passed 546 tests in 28 files and skipped 11 platform-specific tests.
`npm audit` found no vulnerabilities, including development dependencies.
The resolved test tools were Vitest and `@vitest/mocker` 4.1.12, Vite 8.3.5, and esbuild 0.28.2.

An installed tarball passed the real-terminal baseline with `skills` 1.7.6.
Live service checks covered independent persistent consent, revocation, request cancellation, registry host changes, and daily suppression. Startup made no metadata request.
The terminal smoke reconstructs the character screen with the development-only `@xterm/headless` 6.0.0 dependency.

A real CLI-only refresh rebuilt `51223afa3602a461339d3904752cc396a90c66af`, selected `skills` 1.7.6 from its private root `latest` dependency, repeated onboarding, and reached browse, help, and quit.
A separately approved refresh against a closed local registry produced a real npm `ECONNREFUSED` and exit 1, printed manual recovery, and restored the terminal exactly. It did not restart the app.
The failed update's workspace was absent and its npm process group was gone after exit; this probe did not independently observe their removal order.

The canonical, unversioned `npx` command fetched public main `4f798cdba8fbd613ab3c52f3fbc61d902bb196f3`, ran prepare and the native compiler, and launched an app reporting that exact clean archive SHA at version 0.1.0.
A real combined main-and-CLI update fetched the same main commit and selected the registry's latest `skills` 1.7.6 from the fresh installation.
The helper replaced the old process, then launched the new app in the same foreground terminal. Onboarding, browse, help, and quit completed.
Before that update, the session switched through a symlink to a root containing spaces, both quote types, and U+0001. The approval, new process arguments, onboarding, and browse all used the switched root.
During the combined handoff, the original and selected skills, outside sentinels, original npm and XDG caches, and working directory stayed unchanged. Successful update workspaces were removed.

[PR #8 checks](https://github.com/ederheisler/skills-manager/actions/runs/42055646923) passed on Linux x64, Linux arm64, and macOS x64, including installed-package refresh and restart.
The merged commit also passed [main checks](https://github.com/ederheisler/skills-manager/actions/runs/42056669413) and the [automatic release workflow](https://github.com/ederheisler/skills-manager/actions/runs/42057537658).
The real-TUI suite allows 30 seconds for each complete workflow, retaining 4-second frame deadlines, explicit phase waits, and the 60-second long-preview exception.

The public verification record is attached to [implementation PR #8](https://github.com/ederheisler/skills-manager/pull/8).

### Local startup and UI checks

`npm run build` passed. The 28 non-TUI test files passed. After correcting an obsolete browse-view Git expectation, all 60 TUI tests passed. The total was 610 passed and 11 skipped across 29 files. `npm audit` reported zero vulnerabilities.

On macOS, a native Node terminal fixture persisted the first setup. A second ordinary launch asked no setup questions and left the configuration bytes unchanged. Both CLI runs exited with status zero. An existing Vercel source association was recognized despite different local content. After explicit source approval, a real GitHub check reported `No updates found`.

Browse help showed Option+↑/↓ without Git operations. Git help showed commit, fetch, pull, and push. Containing-repository information appeared only in Git view. The fixture skills, installer lock, outside sentinel, cache, and working directory stayed unchanged.

A read-only scan of the installed skills found 40 entries, including 20 tracked entries and the `crit-cli` source. The installer lock, `crit-cli` document, and root entries stayed unchanged. The scan created no manager state.

SCB reviewed 17 changed files. It flagged complexity and similar guard shapes. The guards cover different validation and lifecycle operations, so they were kept. This local run did not independently measure startup traffic or test Linux.

### Local update controls and checks

Before the final immutable cache change, the build and full suite passed with 646 tests passed and 11 skipped across 30 files. After that change, the build and 65 focused service and lifecycle tests passed. `npm audit` reported zero vulnerabilities, including development dependencies.

Four native Node terminal sessions on macOS exited with status zero and empty stderr. Fresh default-off startup made no fetch. Tab and Enter did not enable checks. Explicit `y` approval for each component made one request to `api.github.com` or `registry.npmjs.org`, showed checking, and displayed the completed result. The next launch restored both results without a fetch during two seconds of observation.

With existing permissions, recent legacy attempts, and no completed results, startup made one request per host and showed checking and completed results. The next launch restored those results without a fetch during two seconds of observation. The `c`, `a`, `r`, `f`, and `m` controls appeared bold in `#C6A0F6`. Both update actions appeared before results. The consent view fit six rows in a 40-row terminal.

Setup configuration, permission files, and skill hashes stayed unchanged across each pair of sessions. The isolated fixtures were cleaned up. The actual user's skills and cache were untouched. A scoped SCB review of five changed source and test files found no correctness blocker. It retained complexity and duplicate-guard warnings because the guarded operations differ.

CI run [42083344358](https://github.com/ederheisler/skills-manager/actions/runs/42083344358) failed on all three platforms because the release smoke test expected obsolete footer text. The corrected harness passed locally on macOS arm64 with Node 26.13 against installed GitHub commit `42e2a8485ce247aade006f72bf1138aee807979b`. It exercised the real CLI refresh, same-commit restart, and sentinel assertions. The script complexity review found no additional blocker.

### Graph maintenance

The Graphify AST refresh reported 54 hub renames and 20 disappeared names:

- `.close`, `.write`, `Audio capture and recording`, `Drawing inventory`, `Field compiler callbacks`
- `Intercept callbacks`, `Key binding pipeline callbacks`, `Public registration APIs`, `React and Solid handoff`, `SSH`
- `Services and registrations`, `Solid plugin slots`, `StateSession`, `Stream and recorder members`, `checkUpdates.ts`
- `interruptedFixture`, `list-boundary.h`, `skillsCli.ts`, `tree_check_mount_entry`, `tree_walk_entry`

The graph includes the final handoff test. Its manifest and file modification times both matched `1793889714.8341844`.

The corrective test-harness commit needed a second, separately guarded AST refresh. It reported 48 hub renames and 15 disappeared names:

- `.command`, `.registry`, `React plugin slots`, `Select`, `appUpdateHandoff.test.ts`
- `getStatus`, `git.test.ts`, `gitBoundary.ts`, `gitTransaction.test.ts`, `release-smoke-pty.py`
- `repo.ts`, `tree_check_mount_fd`, `tree_same_snapshot`, `types.ts`, `withSkillsLock`

The next test-only AST refresh reported 4 hub renames. No community names disappeared.

The startup and UI fixes required one guarded AST refresh. It reported 42 hub renames. These names disappeared:

- `API reference`, `Engine methods`, `Execution order`, `Implementation slices and dependencies`, `Setup`, `checkUpdates.ts`
- `git-tree-hash.h`, `git.ts`, `ref_node_fs`, `skills-manager`, `tree.h`
