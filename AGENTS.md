# skills-manager

Terminal UI for managing skills in an explicitly selected directory.
The default is `~/.agents/skills`. Adopt existing installations in place.

For structural, portability, distribution, or skills layout changes, read
`docs/decisions/README.md` first. The original design in
`docs/superpowers/specs/2026-09-16-skills-manager-design.md` is historical.

## Stack

TypeScript, OpenTUI (direct renderables, not Ink), bounded data-only YAML,
and the Vercel `skills` dependency behind an operating-system boundary.

## Rules

- Treat the selected skills directory itself as the optional Git root.
  Keep Git initialization, commit, remote configuration, and push explicit.
  Preserve containing repositories and unrelated staged or unstaged files.
- Move enabled entries between `<skills-dir>/<name>` and
  `<skills-dir>/.disabled_skills/<name>` through the native filesystem boundary.
  Preserve links. A link does not authorize changes to its target.
- Keep upstream locks read-only. Derive declared authors and source evidence
  on each scan. Missing evidence is unknown, not ownership or "mine".
- Keep adoption and local browsing read-only and offline. Remote actions
  require explicit user action and verified process confinement.

## SCB review

- After changing a file in `src/` or `tests/`, run
  `uvx scb-check check <changed-file>` before completion.
- Review every finding in changed project files. Resolve valid findings or
  record why a finding does not apply.
- Do not scan the repository root. Scope broader reviews to `src/` and
  `tests/`; `.agents/` contains vendored skills.

## Dependency audit

- Before completing a project change, run `npm audit --audit-level=moderate`
  alongside the SCB review and any lint checks. Include development dependencies.
- After changing `package.json` or `package-lock.json`, run
  `npm ls vitest @vitest/mocker vite esbuild --all` to inspect the resolved
  versions of the packages involved in the current advisories.

## PR publishing and CI

- After every push to a PR branch, watch its checks until they finish:
  `gh pr checks <number> --watch`. Native portability runs Linux arm64,
  Linux x64, and macOS x64, and catches failures that local macOS arm64 runs miss.
- Do not report a PR as published, ready, or merged while any required check
  is pending or failing. If a check fails, read its log
  (`gh run view <run-id> --log-failed`), fix the root cause, push, and watch again.
- Release happens only after a version bump merges to `main` and Native
  portability passes there. After a merge, also watch the `main` run and the
  Release workflow, and confirm the tag and release exist.
- When a change alters onboarding, prompts, or update output, update
  `scripts/release-smoke.mjs` in the same PR. CI drives the installed CLI
  through that script.

## TUI interaction and rendering
- This is a terminal UI project, not a frontend project. Never load or use the
  `impeccable` skill here. For every TUI change, load the local `opentui` skill
  first; use its terminal-layout and interaction guidance instead.

- Treat shortcut labels as rendered behavior, not decoration. Preserve the user's
  specified spelling, order, and character styling exactly.
- Never overlay individual characters on a native box or scrollbox title to color a
  shortcut. Terminal cell positioning varies and creates split words such as
  `s cope` or `e nabled`. Render the full title once with one `TextRenderable`
  containing contiguous styled chunks.
- When a header gets new state, append it after existing components. The active
  skill filter belongs after `scope` and `state` and reads
  `filter: <query> (Esc to clear)`.
- For every title/header styling change, test the captured character frame for the
  exact contiguous phrase and explicit negative split-word cases. Do not report the
  UI correct based only on source inspection or a passing type check.
- Git view's `t` binding is a full-context diff toggle. The header must present it
  as pink `t` followed immediately by `oggle`; do not insert a space between the
  binding and label.
- Place a shortcut in the header of the pane it controls. Git's `t` toggle
  belongs above the diff content pane, never above the working-tree file list.
  Verify its captured rendered line contains both the selected path and `toggle`.
- Git status filtering uses pink `s` followed immediately by `tatus`, never
  `f status` or a split `s tatus`.
- The commit-message editor is a right-aligned footer block. The center footer
  remains empty for ephemeral status messages; never let the message label
  begin immediately after the left toolbar controls.
