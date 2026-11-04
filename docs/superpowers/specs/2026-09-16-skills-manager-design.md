# skills-manager design

Date: 2026-09-16

This is the original design, not a description of the current implementation.
It assumed a globally installed `skills` CLI, a different disabled-skills
layout, and Git operations over `~/.agents`. Those assumptions were superseded.
For current setup, behavior, and safety limits, see the [README](../../../README.md)
and the [decisions index](../../decisions/README.md).

## Purpose

The proposed terminal UI would manage agent skills stored in `~/.agents`.
It would wrap the globally installed vercel-labs `skills` CLI for install,
search, and update, and add a way to enable or disable individual skills
without deleting them.

## Background / confirmed mechanism

- The original design assumes `~/.agents` contains `skills/<name>/SKILL.md`
  folders and `.skill-lock.json` managed by the `skills` CLI.
- A consuming agent can use a skills directory whose entries are symlinks
  into the canonical folder, for example
  `~/.claude/skills/<name>` -> `../../.agents/skills/<name>`.
- Moving `~/.agents/skills/<name>` elsewhere makes each agent symlink to
  it dangle. The skill disappears for each agent without per-agent
  bookkeeping. Moving it back restores the links.

## Enable / disable mechanism

Disabling a skill = `fs.rename` from `~/.agents/skills/<name>` to
`~/.agents/.disabled_skills/<name>`. Enabling = the reverse. No symlink
bookkeeping is needed per the mechanism above.

## Data model

No new database. On each refresh the app reconciles three sources of
truth in memory, keyed by folder name:

1. A folder scan of `~/.agents/skills/*` and
   `~/.agents/.disabled_skills/*` gives enabled or disabled state and
   existence.
2. Each folder's `SKILL.md` frontmatter supplies `name`, `description`,
   and any `license`, `metadata.authors`, or `metadata.version` for display.
3. `~/.agents/.skill-lock.json` supplies the source repository and
   install and update timestamps for provenance.

An orphaned install record is a lock entry with no matching folder in
either location, for example after an external deletion. The proposed
list would flag it. A folder without a lock entry is normal for a
locally authored or manually added skill. See Provenance below.

### Provenance

Skills can have lock entries, metadata in `SKILL.md`, or neither.
The original design derives provenance per skill in this order:

1. **Lock entry present** → "from `<source>`" (e.g.
   `cursor/plugins` via `sourceUrl`), plus installed/updated dates.
2. **No lock entry, but `SKILL.md` has `license` or
   `metadata.authors`/`metadata.version`** → show that author/license/
   version info directly.
3. **Neither** → labelled **"local (mine)"**. The original design uses
   this label as a heuristic, not proof of authorship.

The proposed `state/provenance.ts` would recompute this classification
on every scan instead of storing it.

## Update flow

The design required updates for disabled skills. It assumed that
`skills update` only found skills under `~/.agents/skills` and did not
recognize `.disabled_skills`. The proposed update flow was:

1. Record which target skills are disabled.
2. Move them back into `skills/`.
3. Run `skills update [name] -y` (or `-y` alone for all skills).
4. Move the recorded skills back into `.disabled_skills/`, even if the
   update fails, so they do not remain enabled.

Enabled skills would remain in place for the update.

## UI (Ink TUI)

The proposed executable was `skills-manager`.

- **List**: One line per skill with name, enabled or disabled badge,
  provenance, last-updated date, and an inconsistency marker where
  applicable. Type to filter. Keys: `space` toggles enable or disable,
  `u` updates the selected skill, `U` updates all, `a` adds a skill via
  `skills find` or `skills add`, and `d` removes a skill via
  `skills remove` after confirmation.
- **Detail pane**: Description and provenance for the selected skill,
  including source URL and dates, author metadata, or "local (mine)".
- **Status line**: The last `skills` CLI command and its result, plus
  the `git status --short` line count for `~/.agents`.
- **Git panel**: `g` opens status and diff statistics for `~/.agents`.
  `c` stages everything (`git add -A`) and commits with a typed message,
  `p` pushes, and `escape` closes the panel. Each Git mutation requires
  an explicit keypress. No commit runs automatically or in the background.

## Non-goals

- No automatic commits to `~/.agents` as a side effect of skill actions.
  The Git panel offers commit and push only as explicit user actions.
- No persistent database beyond the skill folders and lock file. A
  remembered filter string was the only contemplated setting.
- No per-agent symlink management. Disabling relies on the dangling
  symlinks described above.

## Tech stack

The proposed stack was TypeScript, Ink for the terminal UI, `execa` to
run the `skills` CLI, and `gray-matter` to parse frontmatter.

```
src/
  cli.tsx               entry point
  state/repo.ts         scans skills/, .disabled_skills/, lock file; reconciles into one list
  state/provenance.ts   classifies each skill: lock source / SKILL.md author / "local (mine)"
  actions/toggle.ts     enable/disable via fs.rename
  actions/update.ts     restore -> `skills update` -> re-disable dance
  actions/skillsCli.ts  execa wrapper around the `skills` binary (add/remove/find/update)
  actions/git.ts        execa wrapper around git (status/diff --stat/add -A + commit/push), scoped to agentRoot
  ui/App.tsx
  ui/List.tsx
  ui/Detail.tsx
  ui/GitPanel.tsx
```

## Open questions / future work

The original design listed no blocking questions. Possible later work
included a file watcher for external changes and symlink repair or
creation for additional agents.
