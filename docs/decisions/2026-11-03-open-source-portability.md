# Open-source portability

Date: 2026-11-03  
Status: Accepted intent, not a statement of implemented behavior.

## Context

The original [design](../superpowers/specs/2026-09-16-skills-manager-design.md) describes a personal skills repository and its links. The project will become an open-source skills manager for other users and machines.

## Decision

- Keep the name and executable `skills-manager`. Make the project open source.
- Support macOS and Linux. Windows is out of scope.
- Use `~/.agents/skills` as the default skills directory. Adopt an explicitly selected directory in place without forced relocation or merging.
- Keep disabled entries in `.disabled_skills` inside the selected skills directory. Make that directory itself the optional Git repository root.
- Offer Git initialization as an explicit action. Support local skills without a Git repository. Do not use a containing repository as the app's storage repository.
- Suggest an optional remote push for backup during onboarding. Local Git setup and remote backup are separate choices, both skipped by default. A backup is not public publishing.
- Manage skills only. The previous decision to offer shared global instructions is superseded. Instruction files and their sharing are out of scope.
- Select the MIT license for the project. Publication requires confirmation of the owner's rights and copyright, plus applicable third-party notices.
- Protect existing files and links. Do not use personal machine paths or personal setup assumptions.

These decisions supersede the personal-layout constraints in the original design and the earlier instruction-sharing decision. They describe future behavior unless an implementation record says otherwise.

The implementation choices below replace the corresponding open choices in the reviewed plan. The source and author filter design remains open. A missing lock or author declaration is not evidence that the user authored or owns a skill.

## Why

The project is intended for other users and machines. Existing skills, files, and links must remain usable. A Git repository for skill storage must not be a prerequisite.

The selected skills directory is the repository boundary because the app manages skills rather than the surrounding harness. A containing repository remains under its owner's control. The [release plan](../superpowers/plans/2026-11-03-portable-open-source-release.md) defines the nested-repository and consent boundaries.

MIT is the selected simple permissive license. That choice does not replace an assessment of ownership or third-party notice obligations. The user favored repository distribution and asked whether registry publication is necessary.

## Implementation choices

After approving the plan, the owner selected:

- Node as the runtime, with repository or tarball distribution and an optional version-pinned `npx` command. npm publication is not required.
- Manual network access only, with upstream telemetry disabled. Startup and local browsing make no network requests.
- Explicitly reviewed changes for adopted skills with an unknown owner or edit baseline. Unknown status remains visible and does not imply ownership.
- macOS and Linux on arm64 and x86_64 as the intended platform matrix. Linux uses glibc. Each combination needs a real test before a support claim.
- Confirmation of the rights needed to apply MIT, with `Eder Heisler` as the copyright name.
- GitHub private vulnerability reporting as the security contact. Verify its availability before public release.
- Untrack local-only development settings and machine-local Graphify files, while preserving their local copies.
- Keep the repository, but reset its commit history before public release. The owner subsequently rejected preserving an archive or backup of the old history. No history rewrite occurs as a side effect of application implementation. Keeping the existing hosted repository is superseded by [Hosted history replacement](#hosted-history-replacement); the no-archive requirement remains.

The reason for these implementation choices was not stated. Runtime compatibility, confinement, recovery, artifact inspection, and platform tests remain release gates.

## Concurrency limits

Context: The reviewed plan overreached by implying race-proof pathname checks while external processes rename directories.

Decision: Keep the full app with serialized app instances, stale-preview checks, collision refusal, and Git locks. External edits, moves, and Git commands during an action are unsupported. This supersedes stronger concurrent-rename guarantees in the reviewed plan, not its untrusted-data, link, containment, or recovery requirements.

Why: The owner explicitly selected standard filesystem concurrency limits rather than pausing for redesign. No further rationale was stated.


## Hosted history replacement

Date: 2026-11-04

Context: Resetting `main` left five GitHub-managed pull-request refs and the old Actions history. Those PR refs cannot be removed by a force-push.

Decision: Delete and recreate `ederheisler/skills-manager` at the same URL, discard the old PRs and Actions history, and retain only the clean source snapshot. Do not create an archive or backup. This supersedes the earlier choice to keep the existing hosted repository.

Why: The owner explicitly selected this option after the retained-history consequences were disclosed. No further rationale was stated.
