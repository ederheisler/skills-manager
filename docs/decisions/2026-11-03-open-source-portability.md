# Open-source portability

Date: 2026-11-03  
Status: Accepted decisions. These records do not by themselves establish implementation or GitHub settings. The [release plan](../superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records implementation evidence. See the [README](../../README.md) for current behavior.

## Context

The original [design](../superpowers/specs/2026-09-16-skills-manager-design.md) describes a personal skills repository and its links. The project now targets users and machines beyond that personal setup.

## Decision

- Keep the name and executable `skills-manager`. Make the project open source.
- Support macOS and Linux. Windows is out of scope.
- Use `~/.agents/skills` as the default skills directory. Adopt an explicitly selected directory in place without forced relocation or merging.
- Keep disabled entries in `.disabled_skills` inside the selected skills directory.
- Support local skills without Git. Onboarding does not ask about Git. Git initialization requires explicit confirmation in Git view.
- Push only through an explicit action in Git view. Push sends whole-branch history, not uncommitted files. See the [existing repository choice](#existing-repository-choice).
- Manage skills only. The previous decision to offer shared global instructions is superseded. Instruction files and their sharing are out of scope.
- Use the MIT license. The required rights and copyright were confirmed, and the distribution includes third-party notices.
- Protect existing files and links. Do not use personal machine paths or personal setup assumptions.

These decisions supersede the personal-layout constraints in the original design and the earlier instruction-sharing decision.

The choices below replace the corresponding open choices in the reviewed plan. The source and author filter design remained open at that review. A missing lock or author declaration is not evidence that the user authored or owns a skill.

## Why

The project must work for other users and machines without disrupting existing skills, files, or links. A Git repository for skill storage must not be a prerequisite.

The original decision made the selected skills directory the repository boundary because the app manages skills, not the surrounding harness. A containing repository remained under its owner's control. [Existing repository choice](#existing-repository-choice) supersedes the leaf-only boundary while retaining scoped writes.

MIT is a permissive license. The copyright name is `Eder Heisler`.

## Implementation choices

The project uses Node. The original primary installation route was a tagged GitHub `npx` command. It required neither a manual clone nor npm registry publication. Repository and tarball distribution remain supported. [Latest main installation](#latest-main-installation) supersedes the tagged primary route.

Other choices:
- The original network policy required a user action and kept startup and local browsing offline. [Application update approval](#application-update-planning) later introduced an exception for opted-in checks. Upstream telemetry remains disabled.
- Allow explicitly reviewed changes for adopted skills with an unknown owner or edit baseline. Unknown status remains visible and does not imply ownership.
- Target macOS and Linux on arm64 and x86_64, with glibc on Linux. Test each combination before claiming support.
- Use GitHub private vulnerability reporting as the security contact. It is enabled on the public repository.
- Keep local-only development settings and machine-local Graphify files untracked, while preserving their local copies.
- Reset the commit history before public release. [Hosted history replacement](#hosted-history-replacement) supersedes the original choice to keep the hosted repository.

The [release evidence](../superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records runtime, confinement, recovery, artifact, and platform checks and their limits.

## Latest main installation

Date: 2026-11-04

The primary installation route was the unpinned GitHub `npx` command. It requested the latest code on `main` without a manual clone. This superseded the [tagged primary route](#implementation-choices) because a fixed tag prevented users from receiving fixes on later runs. The existing `v0.1.0` tag remains part of the release history. [Persistent installation](#persistent-installation) supersedes repeated `npx` launches.

## Persistent installation

Date: 2026-11-05

The user explicitly chose to install once and run `skills-manager` on later launches. The implementation starts with a one-time GitHub `npx` launch. The user then approves persistent installation through the existing Application updates confirmation. Approved in-app updates must refresh the persistent installation, not only a temporary session.

## Concurrency limits

The reviewed plan implied race-proof pathname checks while external processes rename directories. The app instead serializes app instances and uses stale-preview checks, collision refusal, and Git locks.

External edits, moves, and Git commands during an action are unsupported. This supersedes stronger concurrent-rename guarantees in the reviewed plan. It does not relax the untrusted-data, link, containment, or recovery requirements.

## Hosted history replacement

Date: 2026-11-04

The hosted repository was replaced at the same URL before public release because resetting `main` did not remove GitHub-managed pull-request refs or Actions history. The replacement retained the clean source snapshot and discarded the old hosted history. Do not archive, back up, or restore the old history.

## macOS arm64 verification

The installed app passed native macOS arm64 tests locally, while the corresponding GitHub jobs could not acquire a runner. Local native verification was considered sufficient, so hosted CI retains Linux arm64, Linux x86_64, and macOS x86_64.

On 2026-11-06, the user removed the hosted macOS x86_64 and Linux arm64 jobs. Hosted CI now runs Linux x86_64 only, including the Linux upstream-ref and update tests that previously ran on arm64. macOS is verified locally on the maintainer's arm64 machine.

## Upstream skills versions

Date: 2026-11-04

The reviewed release plan required a tested upstream CLI version and the implementation used `skills@1.7.6`. The project now specifies `latest` for the upstream `skills` dependency. It does not reject newer versions solely because they are not on a tested-version list.

The project expects upstream compatibility and will address a break if one occurs rather than block newer versions in advance. The [release evidence](../superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records tested versions. An installed package or lockfile can retain an earlier resolution until refreshed. The operating-system sandbox, schema, path, and source-receipt checks remain in place.

## In-app keyboard help

Date: 2026-11-04

Keyboard help is available in the app with the `?` key. The README does not maintain a keyboard shortcut catalog.

Help stays compact and follows the current view. Git controls and repository status appear only in Git view, including information about a containing repository. The browse footer does not show that information. Shortcut labels use Option on macOS and Alt on Linux.

## Persisted setup and existing installer tracking

Date: 2026-11-05

The user chose to persist completed setup. The implementation saves it in `$XDG_CONFIG_HOME/skills-manager/config.json` when `XDG_CONFIG_HOME` is absolute. Otherwise, the path is `~/.config/skills-manager/config.json`. Later launches reuse completed setup for an unchanged root, including launches by an update child. Each launch must still validate the physical root. A new or changed root requires setup again. An explicit `--skills-dir` takes precedence.

The user requested removal of the in-app `i` directory switch because it had no value. Startup directory selection, saved setup, adoption, and `--skills-dir` remain available.

This supersedes the [update plan's original repeat-onboarding requirement](../superpowers/plans/2026-11-05-in-app-updates.md#3-add-review-and-guarded-handoff).

Saved setup does not grant approval for later writes, Git initialization, push, or other actions. It does not change the separate app and CLI update consent in `app.json` and `cli.json`, or the startup network policy.

Valid existing Vercel installer lock entries can provide source tracking and version checks without skills-manager receipts. The recorded baseline is not proof of ownership, prior review, or unchanged local files. Version checks compare upstream with that baseline, not with current local content. Browsing and checking do not rewrite installer locks or create receipts. Replacement still requires review and the existing path and source safeguards.

The user chose an immediate, read-only version check for a known GitHub source without a separate source review. Skill updates still require approval.

## Existing repository choice

Date: 2026-11-05

The user explicitly chose to use an existing repository that contains the selected skills directory. This supersedes the original leaf-only Git restriction and onboarding push suggestion. Existing repositories at the selected directory or above it need no Git setup during onboarding. Ordinary startup opens the browse view.

Skill file writes and local commits remain scoped to the selected skills directory. Unrelated staged and unstaged files must remain intact. The app must not automatically initialize Git, commit, change a remote, push, add exclusions, or untrack files.

Push is explicit in Git view. The review must show the actual repository, destination, and history scope. A push sends whole-branch history, including commits outside the selected skills directory. It does not preserve uncommitted files. Pull must refuse incoming changes outside the selected directory.

Date: 2026-11-06

The user requested simpler onboarding. Onboarding no longer asks about Git. Git initialization moved to Git view, where `i` opens its confirmation.

## Browse category labels

Date: 2026-11-05

The user reported confusion about unknown, local, and source labels. In response, the app uses All, From a repo, and Local for browse categories. Local groups skills without a recorded remote association, including internally unknown and local origins. It does not assert authorship. Authorship remains separate and can be unknown. This presentation does not change provenance, scanning, or permission rules.

## Automated releases

Date: 2026-11-04

After a version change reaches `main` through a pull request, GitHub Actions creates the release for the new manifest version. Releases are not created manually.

## Main branch protection

Date: 2026-11-04

The maintainer is currently the only repository collaborator. Every change to `main`, including the maintainer's changes, requires a pull request and the selected stable status checks. Direct pushes, force-pushes, deletion, and bypassing protections are prohibited. External contributors submit pull requests from forks. Only the maintainer has merge permission.

On 2026-11-04, GitHub reported ruleset `26549966` active on `main`. It required pull requests, zero approvals, resolved review threads, and the `Required checks` status from GitHub Actions (integration ID `15368`). It required branches to be up to date, allowed no bypass, and blocked deletion and force-pushes. Zero approvals was an implementation choice for a sole-maintainer repository, not a separately selected review count.

## Application update planning

Date: 2026-11-05

The user first requested a plan for in-app application update notifications and an update process. No separate rationale was stated.
At that point, the [application update plan](../superpowers/plans/2026-11-05-in-app-updates.md) was a proposal, not an approval.
The user later explicitly approved implementation of the plan.
That approval replaces the original no-background-network rule only for separately opted-in app and CLI checks.
Both automatic checks default to off. Each grants ongoing consent for its disclosed host scope and can be disabled separately.
The [update plan](../superpowers/plans/2026-11-05-in-app-updates.md#verification) records verification of the prior implementation. That evidence does not establish verification of later changes.
The latest-main installation, automated releases, and main-branch protection decisions remain unchanged.

## Update controls and check results

Date: 2026-11-05

Update controls use colored shortcuts consistent with the main view. Enter controls automatic checks, not `a`. If automatic checks are off, Enter opens a separate consent prompt. Only `y` or an intentional click enables checks. If checks are on, Enter disables them. App and CLI update actions remain available without an available version or a prior check. The screen must not use fake `unknown` or `latest` placeholders.

The user explicitly chose immediate checks for both components whenever the updates screen opens, even with automatic checks off. Opening the screen authorizes those one-shot requests. Pressing `c` directly authorizes another check for the selected component. Foreground checks do not wait for a daily interval or enable automatic checks. Progress, results, and errors appear inline.

The user rejected `n` as a redundant cancel control in all confirmations. Escape is the sole visible cancel action, and `n` does not cancel. Confirmation labels identify the specific action instead of using a generic label.

The CLI refresh and application update confirmations remain separate. The CLI refresh confirmation stays short and discloses network access and trust in executed code. It explains that a known, clean, reproducible app commit and the selected root are kept across restart. An unknown, dirty, or nonreproducible build requires an explicit switch to `main`. The [security policy](../../SECURITY.md#application-and-cli-updates) retains the details, including normal permissions for scripts.

The normal updates menu does not offer a recovery command action. If an update fails or is unavailable, the app can show instructions to start it again.

Automatic checks remain off by default, with separate permission for each host scope. The user requested a check when permission is valid but no completed result exists, even if an old attempt was recorded. Completed results persist. The implementation stores these results in a private, host-scoped cache. A new approval starts a check and permits later daily checks.

## Vercel skills CLI updates

Date: 2026-11-05

The user also requested that the Vercel `skills` CLI stay up to date through the application update plan.
This request covers the CLI package, not installed skill documents. It does not require a global CLI installation.
The [upstream version decision](#upstream-skills-versions) remains in force. Tested versions are not an allowlist.
The user later explicitly approved the [CLI refresh mechanism](../superpowers/plans/2026-11-05-in-app-updates.md#4-refresh-the-vercel-skills-cli).
The [update plan](../superpowers/plans/2026-11-05-in-app-updates.md#verification) records runtime and platform evidence for the prior CLI refresh. The later [persistent installation](#persistent-installation) decision changes its installation target.
