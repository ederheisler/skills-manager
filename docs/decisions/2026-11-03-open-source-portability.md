# Open-source portability

Date: 2026-11-03  
Status: Accepted decisions. These records do not by themselves establish implementation or GitHub settings. The [release plan](../superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records implementation evidence. See the [README](../../README.md) for current behavior.

## Context

The original [design](../superpowers/specs/2026-09-16-skills-manager-design.md) describes a personal skills repository and its links. The project now targets users and machines beyond that personal setup.

## Decision

- Keep the name and executable `skills-manager`. Make the project open source.
- Support macOS and Linux. Windows is out of scope.
- Use `~/.agents/skills` as the default skills directory. Adopt an explicitly selected directory in place without forced relocation or merging.
- Keep disabled entries in `.disabled_skills` inside the selected skills directory. Make that directory itself the optional Git repository root.
- Offer Git initialization as an explicit action. Support local skills without a Git repository. Do not use a containing repository as the app's storage repository.
- Suggest an optional remote push for backup during onboarding. Local Git setup and remote backup are separate choices, both skipped by default. A backup is not public publishing.
- Manage skills only. The previous decision to offer shared global instructions is superseded. Instruction files and their sharing are out of scope.
- Use the MIT license. The required rights and copyright were confirmed, and the distribution includes third-party notices.
- Protect existing files and links. Do not use personal machine paths or personal setup assumptions.

These decisions supersede the personal-layout constraints in the original design and the earlier instruction-sharing decision.

The choices below replace the corresponding open choices in the reviewed plan. The source and author filter design remained open at that review. A missing lock or author declaration is not evidence that the user authored or owns a skill.

## Why

The project must work for other users and machines without disrupting existing skills, files, or links. A Git repository for skill storage must not be a prerequisite.

The selected skills directory is the repository boundary because the app manages skills, not the surrounding harness. A containing repository remains under its owner's control. The [release plan](../superpowers/plans/2026-11-03-portable-open-source-release.md#git-safety) explains the nested-repository and consent boundaries.

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

The primary installation route is the unpinned GitHub `npx` command in the [README](../../README.md). It requests the latest code on `main` without a manual clone. This supersedes the [tagged primary route](#implementation-choices) because a fixed tag prevents users from receiving new fixes when they run the command again. The existing `v0.1.0` tag remains part of the release history.

## Concurrency limits

The reviewed plan implied race-proof pathname checks while external processes rename directories. The app instead serializes app instances and uses stale-preview checks, collision refusal, and Git locks.

External edits, moves, and Git commands during an action are unsupported. This supersedes stronger concurrent-rename guarantees in the reviewed plan. It does not relax the untrusted-data, link, containment, or recovery requirements.

## Hosted history replacement

Date: 2026-11-04

The hosted repository was replaced at the same URL before public release because resetting `main` did not remove GitHub-managed pull-request refs or Actions history. The replacement retained the clean source snapshot and discarded the old hosted history. Do not archive, back up, or restore the old history.

## macOS arm64 verification

The installed app passed native macOS arm64 tests locally, while the corresponding GitHub jobs could not acquire a runner. Local native verification was considered sufficient, so hosted CI retains Linux arm64, Linux x86_64, and macOS x86_64.

## Upstream skills versions

Date: 2026-11-04

The reviewed release plan required a tested upstream CLI version and the implementation used `skills@1.7.6`. The project now specifies `latest` for the upstream `skills` dependency. It does not reject newer versions solely because they are not on a tested-version list.

The project expects upstream compatibility and will address a break if one occurs rather than block newer versions in advance. The [release evidence](../superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records tested versions. An installed package or lockfile can retain an earlier resolution until refreshed. The operating-system sandbox, schema, path, and source-receipt checks remain in place.

## In-app keyboard help

Date: 2026-11-04

Keyboard help is available in the app with the `?` key. The README does not maintain a keyboard shortcut catalog.

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
The implementation is under verification. Approval does not establish runtime proof or completion of the supported-platform checks.
The latest-main installation, automated releases, and main-branch protection decisions remain unchanged.

## Vercel skills CLI updates

Date: 2026-11-05

The user also requested that the Vercel `skills` CLI stay up to date through the application update plan.
This request covers the CLI package, not installed skill documents. It does not require a global CLI installation.
The [upstream version decision](#upstream-skills-versions) remains in force. Tested versions are not an allowlist.
The user later explicitly approved the [CLI refresh mechanism](../superpowers/plans/2026-11-05-in-app-updates.md#4-refresh-the-vercel-skills-cli).
Its implementation is under verification. The canonical `npx` app recovery command does not guarantee a fresh CLI.
