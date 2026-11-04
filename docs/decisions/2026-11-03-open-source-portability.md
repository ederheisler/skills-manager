# Open-source portability

Date: 2026-11-03  
Status: Accepted decisions. These records do not by themselves establish implementation or GitHub settings. The [release plan](../superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records implementation evidence. See the [README](../../README.md) for current behavior.

## Context

The original [design](../superpowers/specs/2026-09-16-skills-manager-design.md) describes a personal skills repository and its links. The owner chose to make the project an open-source skills manager for other users and machines.

## Decision

- Keep the name and executable `skills-manager`. Make the project open source.
- Support macOS and Linux. Windows is out of scope.
- Use `~/.agents/skills` as the default skills directory. Adopt an explicitly selected directory in place without forced relocation or merging.
- Keep disabled entries in `.disabled_skills` inside the selected skills directory. Make that directory itself the optional Git repository root.
- Offer Git initialization as an explicit action. Support local skills without a Git repository. Do not use a containing repository as the app's storage repository.
- Suggest an optional remote push for backup during onboarding. Local Git setup and remote backup are separate choices, both skipped by default. A backup is not public publishing.
- Manage skills only. The previous decision to offer shared global instructions is superseded. Instruction files and their sharing are out of scope.
- Select the MIT license for the project. Publication requires confirmation of the owner's rights and copyright and applicable third-party notices.
- Protect existing files and links. Do not use personal machine paths or personal setup assumptions.

These decisions supersede the personal-layout constraints in the original design and the earlier instruction-sharing decision.

The choices below replace the corresponding open choices in the reviewed plan. The source and author filter design remained open at that review. A missing lock or author declaration is not evidence that the user authored or owns a skill.

## Why

The project must work for other users and machines without disrupting existing skills, files, or links. A Git repository for skill storage must not be a prerequisite.

The selected skills directory is the repository boundary because the app manages skills, not the surrounding harness. A containing repository remains under its owner's control. The [release plan](../superpowers/plans/2026-11-03-portable-open-source-release.md#git-safety) explains the nested-repository and consent boundaries.

MIT is a permissive license. That choice does not replace an assessment of ownership or third-party notice obligations. The user favored repository distribution and asked whether registry publication was necessary.

## Implementation choices

After approving the plan, the owner selected:

- Use Node, with repository or tarball distribution and an optional version-pinned `npx` command for this project. npm publication is not required. The current project is not published to npm.
- Allow network access only after a user action and disable upstream telemetry. Startup and local browsing make no network requests.
- Allow explicitly reviewed changes for adopted skills with an unknown owner or edit baseline. Unknown status remains visible and does not imply ownership.
- Target macOS and Linux on arm64 and x86_64, with glibc on Linux. Test each combination before claiming support.
- Confirm the rights needed to apply MIT, with `Eder Heisler` as the copyright name.
- Use GitHub private vulnerability reporting as the security contact. It is enabled on the recreated public repository.
- Untrack local-only development settings and machine-local Graphify files, while preserving their local copies.
- Keep the repository but reset its commit history before public release. The owner later rejected an archive or backup of the old history. No history rewrite occurs as a side effect of app implementation. [Hosted history replacement](#hosted-history-replacement) supersedes keeping the existing hosted repository. The no-archive requirement remains.

The owner did not state a reason for these choices. The [release evidence](../superpowers/plans/2026-11-03-portable-open-source-release.md#release-completion) records runtime, confinement, recovery, artifact, and platform checks and their limits.

## Concurrency limits

Context: The reviewed plan implied race-proof pathname checks while external processes rename directories.

Decision: Keep the full app with serialized app instances, stale-preview checks, collision refusal, and Git locks. External edits, moves, and Git commands during an action are unsupported. This supersedes stronger concurrent-rename guarantees in the reviewed plan. It does not relax the untrusted-data, link, containment, or recovery requirements.

Why: The owner selected standard filesystem concurrency limits rather than pausing for redesign. No further rationale was stated.

## Hosted history replacement

Date: 2026-11-04

Context: Resetting `main` left five GitHub-managed pull-request refs and the old Actions history. A force-push cannot remove those PR refs.

Decision: Delete and recreate `ederheisler/skills-manager` at the same URL, discard the old PRs and Actions history, and retain only the clean source snapshot. Do not create an archive or backup. This supersedes the earlier choice to keep the existing hosted repository.

Why: The owner selected this option after the retained-history consequences were disclosed. No further rationale was stated.

## macOS arm64 verification

Context: The installed app passed native macOS arm64 tests on the owner's machine. The corresponding GitHub jobs could not acquire a runner.

Decision: Remove macOS arm64 from hosted CI and retain local native verification. Keep Linux arm64, Linux x86_64, and macOS x86_64 CI.

Why: The owner considered the completed local macOS test sufficient and requested removing the duplicate hosted test.

## Upstream skills versions

Date: 2026-11-04

Context: The reviewed release plan required a tested upstream CLI version and the implementation used `skills@1.7.6`.

Decision: Use `latest` as the upstream `skills` dependency specification instead of an exact version pin. Do not reject a newer version solely because it is not on a tested-version list. Document the versions actually tested. An installed package or lockfile can retain an earlier resolution until refreshed. Keep the operating-system sandbox, schema, path, and source-receipt checks. This supersedes the plan's version-based gate.

Why: The owner requested the latest upstream version rather than a version-based gate. No further rationale was stated.

## In-app keyboard help

Date: 2026-11-04

Context: Users need keyboard controls while using the terminal app.

Decision: Provide keyboard help in the app with the `?` key. Do not maintain a keyboard shortcut catalog in the README.

Why: The owner requested help in the app rather than a catalog in the README. No further rationale was stated.

## Automated releases

Date: 2026-11-04

Context: Releases need to follow approved changes to the project version.

Decision: After a version change reaches `main` through a pull request, use GitHub Actions to create the release for the new manifest version. Do not create releases manually.

Why: The owner chose a release workflow after merge instead of manual publication. No further rationale was stated.

## Main branch protection

Date: 2026-11-04

Context: The owner is currently the only repository collaborator.

Decision: Require pull requests for every change to `main`, including changes by the owner. Do not push directly or force-push to `main`, delete `main`, or bypass the protections. Require the selected stable status checks to pass. External contributors submit pull requests from forks. Only the owner has merge permission.

Why: The owner requested pull-request-only changes. No further rationale was stated.

On 2026-11-04, GitHub reported ruleset `26549966` active on `main`. It required pull requests, zero approvals, resolved review threads, and the `Required checks` status from GitHub Actions (integration ID `15368`). It required branches to be up to date, allowed no bypass, and blocked deletion and force-pushes. Zero approvals was an implementation choice for a sole-owner repository, not a review count selected by the owner.
