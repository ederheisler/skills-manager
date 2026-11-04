# skills-manager design

Date: 2026-09-16

This document records the original design. For current portability, layout,
and provenance decisions, see [the decisions index](../../decisions/README.md).

## Purpose

A visual (terminal UI) wrapper for managing agent skills stored in the
universal skills repo at `~/.agents`. It wraps the existing `skills` CLI
(vercel-labs `skills`, installed globally) for install/search/update, and
adds one capability that CLI doesn't have: quickly enabling and disabling
individual skills without deleting them.

## Background / confirmed mechanism

- The original design assumes `~/.agents` contains `skills/<name>/SKILL.md`
  folders and `.skill-lock.json` managed by the `skills` CLI.
- A consuming agent can use a skills directory whose entries are symlinks
  into the canonical folder, for example
  `~/.claude/skills/<name>` -> `../../.agents/skills/<name>`.
- Consequence: moving `~/.agents/skills/<name>` elsewhere makes every
  agent's symlink to it dangle, which makes the skill disappear for
  every agent with no per-agent bookkeeping. Moving it back heals every
  symlink automatically.

## Enable / disable mechanism

Disabling a skill = `fs.rename` from `~/.agents/skills/<name>` to
`~/.agents/.disabled_skills/<name>`. Enabling = the reverse. No symlink
bookkeeping is needed per the mechanism above.

## Data model

No new database. On each refresh the app reconciles three sources of
truth in memory, keyed by folder name:

1. `~/.agents/skills/*` and `~/.agents/.disabled_skills/*` — folder scan,
   gives enabled/disabled state and existence.
2. Each folder's `SKILL.md` frontmatter (`name`, `description`, and any
   `license` / `metadata.authors` / `metadata.version` present) — for
   display.
3. `~/.agents/.skill-lock.json` — source repo, install/update timestamps,
   for provenance.

A skill can be inconsistent: present in the lock file but with no
matching folder in either `skills/` or `.disabled_skills/` (an orphaned
install record — the folder was deleted outside the tool). The list
view flags these rather than hiding them. A folder with no lock entry
is NOT inconsistent by itself — that's the normal, expected shape for a
locally authored or manually dropped-in skill; see Provenance below.

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

This is a plain classification function
(`state/provenance.ts`), not a new stored flag: it's recomputed from
the two files above on every scan, never persisted.

## Update flow

Per decision: disabled skills must still receive updates.

`skills update` operates on whatever it finds under `~/.agents/skills`;
it has no notion of `.disabled_skills`. So updating (single skill or
all) does:

1. Snapshot which of the target skill(s) are currently disabled.
2. Move that snapshot set back into `skills/`.
3. Run `skills update [name] -y` (or `-y` alone for "update all").
4. Move the snapshot set back into `.disabled_skills/`, regardless of
   whether step 3 fully succeeded, so nothing is left stuck re-enabled.

Enabled skills are left in place for step 3 and simply keep whatever
`skills update` does to them.

## UI (Ink TUI)

Single binary, `skills-manager`.

- **List** — one line per skill: name, enabled/disabled badge,
  provenance (source repo, author, or "local (mine)"), last-updated
  date, and an inconsistency marker when applicable. Type-to-filter.
  Keys: `space` toggle enable/disable, `u` update selected, `U` update
  all, `a` add a skill (wraps `skills find` / `skills add`), `d` remove
  a skill entirely (wraps `skills remove`, with a confirm step).
- **Detail pane** — full description, full provenance (source URL and
  install/update dates from the lock entry, or author/license/version
  from `SKILL.md` metadata, or the "local (mine)" label), for the
  currently selected skill.
- **Status line** — last shell command run against the `skills` CLI and
  its result (actions are thin wrappers over it); also shows
  `git status --short` line count for `~/.agents` so the user knows
  there's something to commit.
- **Git panel** (`g` to open) — shows `git status --short` and
  `git diff --stat` for `~/.agents`. From the panel: `c` stages
  everything (`git add -A`) and commits with a typed message, `p`
  pushes, `escape` closes. This is the only place the tool touches
  git beyond the read-only status line, and every action requires an
  explicit keypress each time — no automatic or background commits.

## Non-goals

- No *automatic* commit to the `~/.agents` repo, ever — nothing commits
  as a side effect of enable/disable/update/add/remove. Committing (and
  pushing) is available from the Git panel, but only as an explicit,
  user-triggered action each time, never implicit or background.
- No new persistent state/database beyond what's already on disk
  (skills folders + lock file). No settings beyond maybe a remembered
  filter string.
- No per-agent symlink management — disabling relies entirely on the
  dangling-symlink behavior described above.

## Tech stack

TypeScript, Ink (TUI), `execa` (shell out to the `skills` CLI),
`gray-matter` (parse `SKILL.md` frontmatter).

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

None blocking. Possible later additions (not in scope for v1): a
file-watcher to auto-refresh if `~/.agents` changes externally while the
app is open; per-agent symlink repair/creation for agents beyond Claude
Code once they adopt the same layout.
