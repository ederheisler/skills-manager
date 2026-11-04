# Security policy

## Report a vulnerability

Do not report vulnerabilities in public issues or pull requests. Do not include credentials or private skill contents in a report.

Use [GitHub private vulnerability reporting](https://github.com/ederheisler/skills-manager/security/advisories/new). Include the affected version, operating system, reproduction steps, and impact. Use a disposable skills directory and harmless sentinel files for filesystem reports.

Private vulnerability reporting is enabled for the public repository. GitHub documents the [reporting process](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Release status

The [release plan](docs/superpowers/plans/2026-11-03-portable-open-source-release.md) records verification evidence and its limits. A build, unit test, or security scan does not establish release safety.

The app reads skills as untrusted data. It must not execute frontmatter, infer ownership from a missing lock, or use a containing repository for Git actions. Remote preparation requires an operating-system boundary. If that boundary is unavailable, the app must refuse the action.

## Threat model

App locks coordinate app instances, not external editors, filesystem moves, or Git commands. Do not run those operations concurrently with an app action. Stale checks are not atomic pathname guards. Processes running as your user can replace the app, alter saved state, or move already-open files; the app does not claim protection against those actions.

Saved source receipts are continuity metadata, not publisher authentication or proof that a user previously approved a source. An untrusted restore over the same installation can forge those associations. Review the source destination before each remote check or update, and review staged content separately before import.

Ambiguous recovery state is retained for inspection. The app must not delete foreign locks or overwrite foreign files merely to make recovery succeed.
