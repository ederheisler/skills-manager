# In-app application update plan

Date: 2026-11-05

Status: Proposed. This feature is not implemented. The mechanics below require review before implementation.

## Current behavior and evidence

The [README](../../../README.md#quick-start) directs users to run `npx --yes --prefer-online github:ederheisler/skills-manager` for latest `main`.
A running app does not notify users of application updates or update itself. Local browsing makes no background network requests.
The [portability decisions](../../decisions/2026-11-03-open-source-portability.md#implementation-choices) require explicit network actions today.
This proposal changes that policy only for users who explicitly enable automatic application checks.

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

## Proposed user flow

1. Add a distinct Application updates menu in browse mode and make it discoverable from `?` help.
   Keep existing skill shortcuts unchanged and label skill actions clearly.
2. Offer Check now, automatic notifications on or off, review update, and a copyable manual command.
   Default automatic notifications to off. Check now permits one bounded request and does not enable future checks.
3. Explain that an automatic check contacts the fixed GitHub host, exposes the user's IP address, and sends no app telemetry.
   Explain the daily cadence and how to turn it off before saving explicit consent.
4. Display a persistent, nonmodal badge for a different build. Do not steal focus, replace a dialog, or install automatically.
   Keep the badge separate from temporary status messages. Do not use desktop notifications.
5. In review, show the running version and short build SHA, the checked main SHA, and the time of the check.
   Say "different build available" for unequal SHAs. Unequal commits do not prove that one is newer.
   An unknown or dirty identity cannot establish that the running build matches main.
6. Offer Update and restart with Cancel selected by default. Explain the isolated new session and its requirements before approval.
   Downloads and build scripts need network access, Node, npm, Git, and a C compiler.
   Explain that trusted repository and npm dependency code runs with normal user permissions.
7. Also offer the canonical manual command with a safely shell-quoted current absolute skills directory and clipboard copy.
   Never execute that display string, or start an update on ordinary quit, Ctrl-C, or renderer destruction.

A source checkout, tagged install, or install with unknown origin defaults to the manual route.
An explicit switch-to-main choice can launch the same new session, but must not imply an in-place channel conversion.
The same commit can arrive through different channels, so a SHA alone cannot identify the installation channel.

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

After identity exists, add an application-specific configuration store and checker separate from skill updates.
Use absolute `XDG_CONFIG_HOME`, or the home configuration fallback, for explicit consent.
Use absolute `XDG_CACHE_HOME`, or the home cache fallback, for authorized check metadata.
Do not create configuration on startup. Persist only explicit consent and authorized check metadata.
Reject unsafe symlinks and overlap with any skills root. Never write to a selected skills directory for this feature.
Missing consent means off. Invalid, unreadable, or unwritable consent fails closed and is reported.

For each authorized check, request only `https://api.github.com/repos/ederheisler/skills-manager/commits/main`.
Bound request time and response size, validate the full returned SHA, and escape untrusted output for the terminal.
Compare full SHAs and show short SHAs only for display. Equality means a match at check time, not a release guarantee.
Treat offline, timeout, cancellation, HTTP errors, rate limits, and invalid responses as unavailable, never up to date.
Do not present an old cached result as a current check.

After valid opt-in, schedule a nonblocking check after startup and at most one attempt per 24 hours.
Record attempt time in the cache and schedule another check during a long-running session once the interval expires.
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
The new app must repeat onboarding and revalidate directory identity. Old approval is not new authorization.

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

Copy a minimal independent helper into a private app-owned temporary workspace outside the current package and cache.
Replace the old process image with that helper before npm starts. The helper uses argument vectors, not a shell.
Run the GitHub main command with a separate private npm cache and neutral working directory.
Preserve normal `HOME` and legitimate user configuration. This launches a new session.
It does not replace a checkout, global install, or normal npm cache.
The helper waits for the new npx process tree to exit before cleaning only its own workspace.
An interruption or hard kill can leave that workspace. Report its exact path for manual cleanup and never delete other active caches.

The unpinned command can obtain a later main commit than the reviewed SHA. Explain this before approval.
The new build displays its actual identity. A child process starting is not proof that the app reached browsing.
After process replacement, report launch or build failures in readable terminal text with the primary manual recovery command.
Do not promise restoration of the old UI, rollback, reproducible builds, pinned transitive dependencies, or a hostile-code sandbox.
Never pull, reset, stash, install, or build in a user checkout. Never alter Vercel skills, user lockfiles, or user symlinks for application updates.

### 4. Update affected interfaces and documentation

Update CLI lifetime callers, TUI construction and teardown callers, help, tests, build metadata generation, and strict package allowlists.
At implementation time, update the README, security policy, CLI help, and decision record for default-off consent and network behavior.
Document the isolated-session limits, manual recovery, and main-versus-tag distinction. Keep the existing release and protected-main policies unchanged.
Do not claim an implementation or policy change before the implementation and its review land.

## Acceptance and runtime verification

Run verification only after the slices are integrated. Record commands, environments, results, and limitations in the implementation change.
Use disposable homes, caches, skills roots, and outside sentinels. Do not use a user's live skills directory as a test fixture.

- Prove the real public unpinned `npx` prepare path embeds the actual full source SHA on two same-version main commits.
  Repeat cold and warm with one npm cache. Move main during preparation and make sure identity remains the fetched source, not live main.
- Exercise archive substitution, a verified checkout, dirty inputs, missing Git, enclosing unrelated repositories, copied packages, and invalid metadata.
  Exercise tagged and source installs without inferring their channel from SHA. Check the packed artifact and strict allowlist.
- Prove no application-check network requests occur on startup, onboarding, browse, help, or quit without valid opt-in.
  Check one-shot authorization, daily cadence including a long session, persisted consent, revocation, malformed and unwritable storage, and unsafe paths.
- Exercise equal, unequal, unknown, and dirty identity. Exercise timeout, offline, 403, 429, server errors, invalid data, cancellation, and stale-result suppression.
  Complete checks during help, confirmations, busy actions, and shutdown without changing focus or replacing a dialog.
- Exercise cancel, busy refusal, unresolved reviews, ordinary quit, signals, and Ctrl-C. None can launch an update without explicit approval.
  Test current switched roots, spaces, quotes, leading hyphens, changed symlinks, and renewed onboarding in the child.
- With fake tools and real terminal fixtures, inspect exact argv, environment, separate cache, neutral cwd, process replacement, and cleanup order.
  Exercise missing tools, download and build errors, aborts, exec failure, child failure, and interrupted workspace cleanup.
  Make sure checkout, skills trees, lockfiles, outside sentinels, and other instances' caches remain unchanged by the app.
- Run the actual approved in-app handoff through renderer-ready browsing in a real terminal. Observe the new build identity and manual recovery on failure.
  Repeat on local macOS arm64 and the existing CI matrix: Linux arm64, Linux x64, and macOS x64.
  Retain existing installed-package browse, help, quit, and confinement checks. Record platform-specific limits instead of claiming untested support.
