# skills-manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a terminal UI (`skills-manager`) that lists every skill under `~/.agents`, shows its provenance (source repo / author / "local (mine)"), and lets the user enable/disable, update, add, and remove skills without leaving the terminal.

**Architecture:** A single Node/TypeScript package. Pure state/logic modules (`state/*`, `actions/*`) that never import React, each independently unit-tested against a temp-directory fixture standing in for `~/.agents`. Thin Ink components (`ui/*`) render that state and forward key presses back into the action modules. No database — every fact is re-derived from the filesystem and `.skill-lock.json` on each scan.

**Tech Stack:** TypeScript (ESM, NodeNext), Ink 5 + React 18 (TUI), execa (shell out to the `skills` CLI), gray-matter (parse `SKILL.md` frontmatter), vitest + ink-testing-library (tests).

**Spec:** `docs/superpowers/specs/2026-09-16-skills-manager-design.md`

## Global Constraints

- No *automatic* git mutation of `~/.agents`, ever — nothing calls `add`/`commit`/`push` as a side effect of enable/disable/update/add/remove. The only place this tool stages, commits, or pushes is the Git panel (Task 10), and only in direct response to a keypress in that panel. A read-only `git status --short` for the status line is required and fine anywhere.
- Enable/disable is exactly one `fs.rename` between `~/.agents/skills/<name>` and `~/.agents/.disabled_skills/<name>`. No symlink creation/repair code.
- Provenance is computed fresh on every scan from `.skill-lock.json` + `SKILL.md` frontmatter. Never cache it to disk.
- A folder with no lock entry is normal (local/author-tagged), not an error. Only an orphaned lock entry (lock entry with no matching folder in either location) counts as "inconsistent."
- All filesystem/CLI logic takes an explicit `agentRoot: string` parameter — nothing hardcodes `~/.agents`, so every module is testable against a temp directory.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test` (vitest) and `npm run build` (tsc) for every later task to build on.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "skills-manager",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "skills-manager": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.tsx",
    "test": "vitest run"
  },
  "dependencies": {
    "ink": "^5.0.1",
    "react": "^18.3.1",
    "execa": "^9.3.0",
    "gray-matter": "^4.0.3"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "tsx": "^4.16.2",
    "vitest": "^2.0.5",
    "ink-testing-library": "^3.0.0",
    "@types/react": "^18.3.3",
    "@types/node": "^22.5.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 5: Install dependencies**

```bash
npm install
```

- [ ] **Step 6: Write a smoke test**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: Run the test suite**

Run: `npm test`
Expected: 1 test file, 1 test, PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore tests/smoke.test.ts
git commit -m "Scaffold skills-manager project (Ink + TypeScript + vitest)"
```

---

### Task 2: Types and provenance classification

**Files:**
- Create: `src/state/types.ts`
- Create: `src/state/provenance.ts`
- Test: `tests/state/provenance.test.ts`

**Interfaces:**
- Produces:
  - `interface LockEntry { source: string; sourceType: string; sourceUrl: string; skillPath: string; skillFolderHash: string; installedAt: string; updatedAt: string }`
  - `interface SkillLockFile { version: number; skills: Record<string, LockEntry> }`
  - `interface SkillFrontmatter { name?: string; description?: string; license?: string; metadata?: { authors?: string; version?: string; [key: string]: unknown } }`
  - `type Provenance = { kind: "source"; source: string; sourceUrl: string; installedAt: string; updatedAt: string } | { kind: "author"; authors?: string; license?: string; version?: string } | { kind: "local" }`
  - `interface Skill { name: string; enabled: boolean; orphaned: boolean; path: string; frontmatter: SkillFrontmatter | null; lockEntry: LockEntry | null; provenance: Provenance }`
  - `classifyProvenance(lockEntry: LockEntry | null, frontmatter: SkillFrontmatter | null): Provenance`

- [ ] **Step 1: Write `src/state/types.ts`**

```ts
export interface LockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

export interface SkillLockFile {
  version: number;
  skills: Record<string, LockEntry>;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  metadata?: {
    authors?: string;
    version?: string;
    [key: string]: unknown;
  };
}

export type Provenance =
  | { kind: "source"; source: string; sourceUrl: string; installedAt: string; updatedAt: string }
  | { kind: "author"; authors?: string; license?: string; version?: string }
  | { kind: "local" };

export interface Skill {
  name: string;
  enabled: boolean;
  /** True when this row comes from an orphaned lock entry with no matching folder. */
  orphaned: boolean;
  /** Absolute path to the skill folder. Empty string when orphaned. */
  path: string;
  frontmatter: SkillFrontmatter | null;
  lockEntry: LockEntry | null;
  provenance: Provenance;
}
```

- [ ] **Step 2: Write the failing test for provenance**

```ts
// tests/state/provenance.test.ts
import { describe, it, expect } from "vitest";
import { classifyProvenance } from "../../src/state/provenance.js";
import type { LockEntry, SkillFrontmatter } from "../../src/state/types.js";

const lockEntry: LockEntry = {
  source: "cursor/plugins",
  sourceType: "github",
  sourceUrl: "https://github.com/cursor/plugins.git",
  skillPath: "pstack/skills/architect/SKILL.md",
  skillFolderHash: "abc123",
  installedAt: "2026-09-10T13:09:37.400Z",
  updatedAt: "2026-09-10T13:09:37.400Z",
};

describe("classifyProvenance", () => {
  it("returns source provenance when a lock entry exists", () => {
    expect(classifyProvenance(lockEntry, null)).toEqual({
      kind: "source",
      source: "cursor/plugins",
      sourceUrl: "https://github.com/cursor/plugins.git",
      installedAt: "2026-09-10T13:09:37.400Z",
      updatedAt: "2026-09-10T13:09:37.400Z",
    });
  });

  it("returns author provenance from frontmatter when there is no lock entry", () => {
    const frontmatter: SkillFrontmatter = {
      name: "astro",
      description: "Skill for Astro",
      license: "MIT",
      metadata: { authors: "Astro Team", version: "0.0.1" },
    };
    expect(classifyProvenance(null, frontmatter)).toEqual({
      kind: "author",
      authors: "Astro Team",
      license: "MIT",
      version: "0.0.1",
    });
  });

  it("returns local provenance when there is no lock entry and no author metadata", () => {
    const frontmatter: SkillFrontmatter = { name: "research", description: "Investigate a question" };
    expect(classifyProvenance(null, frontmatter)).toEqual({ kind: "local" });
  });

  it("returns local provenance when there is no lock entry and no frontmatter at all", () => {
    expect(classifyProvenance(null, null)).toEqual({ kind: "local" });
  });

  it("prefers the lock entry over frontmatter metadata when both are present", () => {
    const frontmatter: SkillFrontmatter = { license: "MIT", metadata: { authors: "Someone" } };
    const result = classifyProvenance(lockEntry, frontmatter);
    expect(result.kind).toBe("source");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/state/provenance.test.ts`
Expected: FAIL with "Cannot find module '../../src/state/provenance.js'" (or similar).

- [ ] **Step 4: Write `src/state/provenance.ts`**

```ts
import type { LockEntry, SkillFrontmatter, Provenance } from "./types.js";

export function classifyProvenance(
  lockEntry: LockEntry | null,
  frontmatter: SkillFrontmatter | null
): Provenance {
  if (lockEntry) {
    return {
      kind: "source",
      source: lockEntry.source,
      sourceUrl: lockEntry.sourceUrl,
      installedAt: lockEntry.installedAt,
      updatedAt: lockEntry.updatedAt,
    };
  }

  const authors = frontmatter?.metadata?.authors;
  const version = frontmatter?.metadata?.version;
  const license = frontmatter?.license;

  if (authors || version || license) {
    return { kind: "author", authors, license, version };
  }

  return { kind: "local" };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/state/provenance.test.ts`
Expected: 5 tests, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state/types.ts src/state/provenance.ts tests/state/provenance.test.ts
git commit -m "Add Skill types and provenance classification"
```

---

### Task 3: Repo scanner

**Files:**
- Create: `src/state/repo.ts`
- Test: `tests/state/repo.test.ts`

**Interfaces:**
- Consumes: `classifyProvenance` from Task 2; `Skill`, `SkillLockFile`, `SkillFrontmatter` types from Task 2.
- Produces:
  - `interface AgentRepoPaths { root: string; skillsDir: string; disabledDir: string; lockFile: string }`
  - `resolvePaths(agentRoot: string): AgentRepoPaths`
  - `scanSkills(agentRoot: string): Promise<Skill[]>` — sorted by `name`, includes orphaned rows (`orphaned: true, path: "", enabled: false`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/state/repo.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePaths, scanSkills } from "../../src/state/repo.js";

let agentRoot: string;

async function writeSkill(dir: string, name: string, frontmatter: string) {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), frontmatter, "utf8");
}

beforeEach(async () => {
  agentRoot = await mkdtemp(path.join(tmpdir(), "skills-manager-repo-"));
});

afterEach(async () => {
  await rm(agentRoot, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  it("derives the four canonical paths from the agent root", () => {
    expect(resolvePaths("/x/.agents")).toEqual({
      root: "/x/.agents",
      skillsDir: "/x/.agents/skills",
      disabledDir: "/x/.agents/.disabled_skills",
      lockFile: "/x/.agents/.skill-lock.json",
    });
  });
});

describe("scanSkills", () => {
  it("returns an empty list for a fresh agent root with no lock file", async () => {
    const skills = await scanSkills(agentRoot);
    expect(skills).toEqual([]);
  });

  it("marks skills in skills/ as enabled and in .disabled_skills/ as disabled", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(paths.skillsDir, "foo", "---\nname: foo\ndescription: Foo skill\n---\n# Foo");
    await writeSkill(paths.disabledDir, "bar", "---\nname: bar\ndescription: Bar skill\n---\n# Bar");

    const skills = await scanSkills(agentRoot);

    expect(skills.map((s) => [s.name, s.enabled, s.orphaned])).toEqual([
      ["bar", false, false],
      ["foo", true, false],
    ]);
    expect(skills[1].frontmatter).toEqual({ name: "foo", description: "Foo skill" });
    expect(skills[1].provenance).toEqual({ kind: "local" });
  });

  it("attaches lock entries to matching folders and classifies provenance from them", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(paths.skillsDir, "astro", "---\nname: astro\n---\n# Astro");
    await writeFile(
      paths.lockFile,
      JSON.stringify({
        version: 3,
        skills: {
          astro: {
            source: "cursor/plugins",
            sourceType: "github",
            sourceUrl: "https://github.com/cursor/plugins.git",
            skillPath: "pstack/skills/astro/SKILL.md",
            skillFolderHash: "hash1",
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
      "utf8"
    );

    const skills = await scanSkills(agentRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0].lockEntry?.source).toBe("cursor/plugins");
    expect(skills[0].provenance).toEqual({
      kind: "source",
      source: "cursor/plugins",
      sourceUrl: "https://github.com/cursor/plugins.git",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("surfaces a lock entry with no matching folder as an orphaned row", async () => {
    const paths = resolvePaths(agentRoot);
    await mkdir(paths.skillsDir, { recursive: true });
    await writeFile(
      paths.lockFile,
      JSON.stringify({
        version: 3,
        skills: {
          ghost: {
            source: "some/repo",
            sourceType: "github",
            sourceUrl: "https://github.com/some/repo.git",
            skillPath: "skills/ghost/SKILL.md",
            skillFolderHash: "hash2",
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8"
    );

    const skills = await scanSkills(agentRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "ghost", orphaned: true, enabled: false, path: "" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/state/repo.test.ts`
Expected: FAIL with "Cannot find module '../../src/state/repo.js'".

- [ ] **Step 3: Write `src/state/repo.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { classifyProvenance } from "./provenance.js";
import type { Skill, SkillFrontmatter, SkillLockFile } from "./types.js";

export interface AgentRepoPaths {
  root: string;
  skillsDir: string;
  disabledDir: string;
  lockFile: string;
}

export function resolvePaths(agentRoot: string): AgentRepoPaths {
  return {
    root: agentRoot,
    skillsDir: path.join(agentRoot, "skills"),
    disabledDir: path.join(agentRoot, ".disabled_skills"),
    lockFile: path.join(agentRoot, ".skill-lock.json"),
  };
}

async function readLockFile(lockFilePath: string): Promise<SkillLockFile> {
  try {
    const raw = await readFile(lockFilePath, "utf8");
    return JSON.parse(raw) as SkillLockFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 3, skills: {} };
    }
    throw err;
  }
}

async function listSkillFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function readFrontmatter(skillDir: string): Promise<SkillFrontmatter | null> {
  try {
    const raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    return matter(raw).data as SkillFrontmatter;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function scanSkills(agentRoot: string): Promise<Skill[]> {
  const paths = resolvePaths(agentRoot);
  const lock = await readLockFile(paths.lockFile);
  const [enabledNames, disabledNames] = await Promise.all([
    listSkillFolders(paths.skillsDir),
    listSkillFolders(paths.disabledDir),
  ]);

  const skills: Skill[] = [];
  const seen = new Set<string>();

  const groups: Array<[string[], boolean, string]> = [
    [enabledNames, true, paths.skillsDir],
    [disabledNames, false, paths.disabledDir],
  ];

  for (const [names, enabled, baseDir] of groups) {
    for (const name of names) {
      seen.add(name);
      const skillDir = path.join(baseDir, name);
      const frontmatter = await readFrontmatter(skillDir);
      const lockEntry = lock.skills[name] ?? null;
      skills.push({
        name,
        enabled,
        orphaned: false,
        path: skillDir,
        frontmatter,
        lockEntry,
        provenance: classifyProvenance(lockEntry, frontmatter),
      });
    }
  }

  for (const [name, lockEntry] of Object.entries(lock.skills)) {
    if (seen.has(name)) continue;
    skills.push({
      name,
      enabled: false,
      orphaned: true,
      path: "",
      frontmatter: null,
      lockEntry,
      provenance: classifyProvenance(lockEntry, null),
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/state/repo.test.ts`
Expected: 5 tests, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/repo.ts tests/state/repo.test.ts
git commit -m "Add repo scanner reconciling skills/, .disabled_skills/, and the lock file"
```

---

### Task 4: Enable/disable toggle

**Files:**
- Create: `src/actions/toggle.ts`
- Test: `tests/actions/toggle.test.ts`

**Interfaces:**
- Consumes: `resolvePaths` from Task 3.
- Produces: `disableSkill(agentRoot: string, name: string): Promise<void>`, `enableSkill(agentRoot: string, name: string): Promise<void>`. Both throw (do not swallow) if the source folder does not exist.

- [ ] **Step 1: Write the failing test**

```ts
// tests/actions/toggle.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePaths } from "../../src/state/repo.js";
import { disableSkill, enableSkill } from "../../src/actions/toggle.js";

let agentRoot: string;

beforeEach(async () => {
  agentRoot = await mkdtemp(path.join(tmpdir(), "skills-manager-toggle-"));
  const paths = resolvePaths(agentRoot);
  await mkdir(path.join(paths.skillsDir, "foo"), { recursive: true });
  await writeFile(path.join(paths.skillsDir, "foo", "SKILL.md"), "---\nname: foo\n---\n", "utf8");
});

afterEach(async () => {
  await rm(agentRoot, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("disableSkill", () => {
  it("moves the skill folder from skills/ to .disabled_skills/", async () => {
    const paths = resolvePaths(agentRoot);
    await disableSkill(agentRoot, "foo");

    expect(await exists(path.join(paths.skillsDir, "foo"))).toBe(false);
    expect(await exists(path.join(paths.disabledDir, "foo", "SKILL.md"))).toBe(true);
  });

  it("throws when the skill is not currently enabled", async () => {
    await expect(disableSkill(agentRoot, "does-not-exist")).rejects.toThrow();
  });
});

describe("enableSkill", () => {
  it("moves the skill folder from .disabled_skills/ back to skills/", async () => {
    const paths = resolvePaths(agentRoot);
    await disableSkill(agentRoot, "foo");
    await enableSkill(agentRoot, "foo");

    expect(await exists(path.join(paths.disabledDir, "foo"))).toBe(false);
    expect(await exists(path.join(paths.skillsDir, "foo", "SKILL.md"))).toBe(true);
  });

  it("throws when the skill is not currently disabled", async () => {
    await expect(enableSkill(agentRoot, "does-not-exist")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/actions/toggle.test.ts`
Expected: FAIL with "Cannot find module '../../src/actions/toggle.js'".

- [ ] **Step 3: Write `src/actions/toggle.ts`**

```ts
import { rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolvePaths } from "../state/repo.js";

export async function disableSkill(agentRoot: string, name: string): Promise<void> {
  const paths = resolvePaths(agentRoot);
  await mkdir(paths.disabledDir, { recursive: true });
  await rename(path.join(paths.skillsDir, name), path.join(paths.disabledDir, name));
}

export async function enableSkill(agentRoot: string, name: string): Promise<void> {
  const paths = resolvePaths(agentRoot);
  await mkdir(paths.skillsDir, { recursive: true });
  await rename(path.join(paths.disabledDir, name), path.join(paths.skillsDir, name));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/actions/toggle.test.ts`
Expected: 4 tests, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/actions/toggle.ts tests/actions/toggle.test.ts
git commit -m "Add enable/disable toggle via fs.rename"
```

---

### Task 5: `skills` CLI wrapper

**Files:**
- Create: `src/actions/skillsCli.ts`
- Test: `tests/actions/skillsCli.test.ts`

**Interfaces:**
- Produces:
  - `interface SkillsCliResult { command: string; stdout: string; stderr: string; exitCode: number }`
  - `updateSkills(names?: string[]): Promise<SkillsCliResult>`
  - `removeSkill(name: string): Promise<SkillsCliResult>`
  - `findSkills(query: string): Promise<SkillsCliResult>`
  - `addSkill(packageName: string): Promise<SkillsCliResult>`
  - All of them never throw — CLI failures come back as `exitCode !== 0` with `stderr` populated.

- [ ] **Step 1: Write the failing test**

```ts
// tests/actions/skillsCli.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { updateSkills, removeSkill, findSkills, addSkill } = await import("../../src/actions/skillsCli.js");

beforeEach(() => {
  execaMock.mockReset();
});

describe("updateSkills", () => {
  it("runs `skills update -y` with no names", async () => {
    execaMock.mockResolvedValue({ stdout: "updated", stderr: "", exitCode: 0 });
    const result = await updateSkills();
    expect(execaMock).toHaveBeenCalledWith("skills", ["update", "-y"]);
    expect(result).toEqual({ command: "skills update -y", stdout: "updated", stderr: "", exitCode: 0 });
  });

  it("runs `skills update <name> -y` with a name", async () => {
    execaMock.mockResolvedValue({ stdout: "updated foo", stderr: "", exitCode: 0 });
    await updateSkills(["foo"]);
    expect(execaMock).toHaveBeenCalledWith("skills", ["update", "foo", "-y"]);
  });

  it("returns a non-zero exit code instead of throwing when the CLI fails", async () => {
    const error = Object.assign(new Error("boom"), { stdout: "", stderr: "network error", exitCode: 1 });
    execaMock.mockRejectedValue(error);
    const result = await updateSkills();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("network error");
  });
});

describe("removeSkill", () => {
  it("runs `skills remove <name> -y`", async () => {
    execaMock.mockResolvedValue({ stdout: "removed", stderr: "", exitCode: 0 });
    await removeSkill("foo");
    expect(execaMock).toHaveBeenCalledWith("skills", ["remove", "foo", "-y"]);
  });
});

describe("findSkills", () => {
  it("runs `skills find <query>`", async () => {
    execaMock.mockResolvedValue({ stdout: "results", stderr: "", exitCode: 0 });
    await findSkills("typescript");
    expect(execaMock).toHaveBeenCalledWith("skills", ["find", "typescript"]);
  });
});

describe("addSkill", () => {
  it("runs `skills add <package> -y`", async () => {
    execaMock.mockResolvedValue({ stdout: "added", stderr: "", exitCode: 0 });
    await addSkill("vercel-labs/agent-skills");
    expect(execaMock).toHaveBeenCalledWith("skills", ["add", "vercel-labs/agent-skills", "-y"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/actions/skillsCli.test.ts`
Expected: FAIL with "Cannot find module '../../src/actions/skillsCli.js'".

- [ ] **Step 3: Write `src/actions/skillsCli.ts`**

```ts
import { execa } from "execa";

export interface SkillsCliResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runSkillsCommand(args: string[]): Promise<SkillsCliResult> {
  const command = `skills ${args.join(" ")}`;
  try {
    const result = await execa("skills", args);
    return {
      command,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; exitCode?: number; message?: string };
    return {
      command,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? error),
      exitCode: typeof err.exitCode === "number" ? err.exitCode : 1,
    };
  }
}

export function updateSkills(names: string[] = []): Promise<SkillsCliResult> {
  return runSkillsCommand(names.length > 0 ? ["update", ...names, "-y"] : ["update", "-y"]);
}

export function removeSkill(name: string): Promise<SkillsCliResult> {
  return runSkillsCommand(["remove", name, "-y"]);
}

export function findSkills(query: string): Promise<SkillsCliResult> {
  return runSkillsCommand(["find", query]);
}

export function addSkill(packageName: string): Promise<SkillsCliResult> {
  return runSkillsCommand(["add", packageName, "-y"]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/actions/skillsCli.test.ts`
Expected: 6 tests, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/actions/skillsCli.ts tests/actions/skillsCli.test.ts
git commit -m "Add execa wrapper around the skills CLI"
```

---

### Task 6: Update flow (restore → update → re-disable)

**Files:**
- Create: `src/actions/update.ts`
- Test: `tests/actions/update.test.ts`

**Interfaces:**
- Consumes: `scanSkills` (Task 3), `enableSkill`/`disableSkill` (Task 4), `updateSkills` and `SkillsCliResult` (Task 5).
- Produces:
  - `interface UpdateReport { result: SkillsCliResult; restored: string[]; reDisabled: string[]; reDisableErrors: Array<{ name: string; error: string }> }`
  - `updateAll(agentRoot: string): Promise<UpdateReport>`
  - `updateOne(agentRoot: string, name: string): Promise<UpdateReport>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/actions/update.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePaths } from "../../src/state/repo.js";

const updateSkillsMock = vi.fn();
vi.mock("../../src/actions/skillsCli.js", () => ({ updateSkills: updateSkillsMock }));

const { updateAll, updateOne } = await import("../../src/actions/update.js");

let agentRoot: string;

async function writeSkill(dir: string, name: string) {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: " + name + "\n---\n", "utf8");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  agentRoot = await mkdtemp(path.join(tmpdir(), "skills-manager-update-"));
  updateSkillsMock.mockReset();
});

afterEach(async () => {
  await rm(agentRoot, { recursive: true, force: true });
});

describe("updateAll", () => {
  it("restores every disabled skill before updating, then re-disables them", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(paths.skillsDir, "enabled-one");
    await writeSkill(paths.disabledDir, "disabled-one");

    let sawDisabledOneRestored = false;
    updateSkillsMock.mockImplementation(async () => {
      sawDisabledOneRestored = await exists(path.join(paths.skillsDir, "disabled-one"));
      return { command: "skills update -y", stdout: "ok", stderr: "", exitCode: 0 };
    });

    const report = await updateAll(agentRoot);

    expect(sawDisabledOneRestored).toBe(true);
    expect(report.restored).toEqual(["disabled-one"]);
    expect(report.reDisabled).toEqual(["disabled-one"]);
    expect(report.result.exitCode).toBe(0);
    expect(await exists(path.join(paths.disabledDir, "disabled-one"))).toBe(true);
    expect(await exists(path.join(paths.skillsDir, "disabled-one"))).toBe(false);
    expect(await exists(path.join(paths.skillsDir, "enabled-one"))).toBe(true);
  });

  it("re-disables the restored skills even when the CLI call fails", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(paths.disabledDir, "disabled-one");
    updateSkillsMock.mockResolvedValue({ command: "skills update -y", stdout: "", stderr: "network error", exitCode: 1 });

    const report = await updateAll(agentRoot);

    expect(report.result.exitCode).toBe(1);
    expect(report.reDisabled).toEqual(["disabled-one"]);
    expect(await exists(path.join(paths.disabledDir, "disabled-one"))).toBe(true);
  });
});

describe("updateOne", () => {
  it("does not touch other skills when updating a single enabled skill", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(paths.skillsDir, "target");
    await writeSkill(paths.disabledDir, "untouched");
    updateSkillsMock.mockResolvedValue({ command: "skills update target -y", stdout: "ok", stderr: "", exitCode: 0 });

    const report = await updateOne(agentRoot, "target");

    expect(updateSkillsMock).toHaveBeenCalledWith(["target"]);
    expect(report.restored).toEqual([]);
    expect(await exists(path.join(paths.disabledDir, "untouched"))).toBe(true);
  });

  it("restores and re-disables a single disabled skill", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(paths.disabledDir, "target");
    updateSkillsMock.mockResolvedValue({ command: "skills update target -y", stdout: "ok", stderr: "", exitCode: 0 });

    const report = await updateOne(agentRoot, "target");

    expect(report.restored).toEqual(["target"]);
    expect(report.reDisabled).toEqual(["target"]);
    expect(await exists(path.join(paths.disabledDir, "target"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/actions/update.test.ts`
Expected: FAIL with "Cannot find module '../../src/actions/update.js'".

- [ ] **Step 3: Write `src/actions/update.ts`**

```ts
import { scanSkills } from "../state/repo.js";
import { disableSkill, enableSkill } from "./toggle.js";
import { updateSkills, type SkillsCliResult } from "./skillsCli.js";

export interface UpdateReport {
  result: SkillsCliResult;
  restored: string[];
  reDisabled: string[];
  reDisableErrors: Array<{ name: string; error: string }>;
}

async function runUpdateDance(
  agentRoot: string,
  disabledNames: string[],
  runUpdate: () => Promise<SkillsCliResult>
): Promise<UpdateReport> {
  const restored: string[] = [];
  for (const name of disabledNames) {
    await enableSkill(agentRoot, name);
    restored.push(name);
  }

  const result = await runUpdate();

  const reDisabled: string[] = [];
  const reDisableErrors: Array<{ name: string; error: string }> = [];
  for (const name of restored) {
    try {
      await disableSkill(agentRoot, name);
      reDisabled.push(name);
    } catch (error) {
      reDisableErrors.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { result, restored, reDisabled, reDisableErrors };
}

export async function updateAll(agentRoot: string): Promise<UpdateReport> {
  const skills = await scanSkills(agentRoot);
  const disabledNames = skills.filter((s) => !s.enabled && !s.orphaned).map((s) => s.name);
  return runUpdateDance(agentRoot, disabledNames, () => updateSkills());
}

export async function updateOne(agentRoot: string, name: string): Promise<UpdateReport> {
  const skills = await scanSkills(agentRoot);
  const target = skills.find((s) => s.name === name);
  const disabledNames = target && !target.enabled && !target.orphaned ? [name] : [];
  return runUpdateDance(agentRoot, disabledNames, () => updateSkills([name]));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/actions/update.test.ts`
Expected: 4 tests, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/actions/update.ts tests/actions/update.test.ts
git commit -m "Add restore-update-re-disable dance so disabled skills stay current"
```

---

### Task 7: Display formatting

**Files:**
- Create: `src/state/format.ts`
- Create: `src/state/filter.ts`
- Test: `tests/state/format.test.ts`
- Test: `tests/state/filter.test.ts`

**Interfaces:**
- Consumes: `Skill`, `Provenance` types from Task 2.
- Produces:
  - `formatProvenance(provenance: Provenance): string`
  - `formatSkillLine(skill: Skill): string` (single-line summary: badge + name + provenance, no ANSI — Ink applies color separately)
  - `filterSkills(skills: Skill[], query: string): Skill[]` (case-insensitive substring match against `name` and `frontmatter.description`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/state/format.test.ts
import { describe, it, expect } from "vitest";
import { formatProvenance, formatSkillLine } from "../../src/state/format.js";
import type { Skill } from "../../src/state/types.js";

describe("formatProvenance", () => {
  it("formats source provenance with the source name", () => {
    expect(
      formatProvenance({
        kind: "source",
        source: "cursor/plugins",
        sourceUrl: "https://github.com/cursor/plugins.git",
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      })
    ).toBe("from cursor/plugins");
  });

  it("formats author provenance with the author name", () => {
    expect(formatProvenance({ kind: "author", authors: "Astro Team" })).toBe("by Astro Team");
  });

  it("falls back to a generic label when author provenance has no authors field", () => {
    expect(formatProvenance({ kind: "author", license: "MIT" })).toBe("MIT license");
  });

  it("formats local provenance", () => {
    expect(formatProvenance({ kind: "local" })).toBe("local (mine)");
  });
});

describe("formatSkillLine", () => {
  it("includes the badge, name, and provenance", () => {
    const skill: Skill = {
      name: "research",
      enabled: true,
      orphaned: false,
      path: "/agent/skills/research",
      frontmatter: { name: "research", description: "Investigate a question" },
      lockEntry: null,
      provenance: { kind: "local" },
    };
    expect(formatSkillLine(skill)).toBe("[on]  research - local (mine)");
  });

  it("marks disabled skills", () => {
    const skill: Skill = {
      name: "research",
      enabled: false,
      orphaned: false,
      path: "/agent/.disabled_skills/research",
      frontmatter: null,
      lockEntry: null,
      provenance: { kind: "local" },
    };
    expect(formatSkillLine(skill)).toBe("[off] research - local (mine)");
  });

  it("marks orphaned rows", () => {
    const skill: Skill = {
      name: "ghost",
      enabled: false,
      orphaned: true,
      path: "",
      frontmatter: null,
      lockEntry: {
        source: "some/repo",
        sourceType: "github",
        sourceUrl: "https://github.com/some/repo.git",
        skillPath: "skills/ghost/SKILL.md",
        skillFolderHash: "h",
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      provenance: { kind: "source", source: "some/repo", sourceUrl: "https://github.com/some/repo.git", installedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    };
    expect(formatSkillLine(skill)).toBe("[!!!] ghost - from some/repo (orphaned lock entry, no folder)");
  });
});
```

```ts
// tests/state/filter.test.ts
import { describe, it, expect } from "vitest";
import { filterSkills } from "../../src/state/filter.js";
import type { Skill } from "../../src/state/types.js";

function skill(name: string, description: string): Skill {
  return {
    name,
    enabled: true,
    orphaned: false,
    path: `/agent/skills/${name}`,
    frontmatter: { name, description },
    lockEntry: null,
    provenance: { kind: "local" },
  };
}

describe("filterSkills", () => {
  const skills = [skill("astro", "Build Astro sites"), skill("research", "Investigate a question")];

  it("returns everything for an empty query", () => {
    expect(filterSkills(skills, "")).toEqual(skills);
  });

  it("matches on name, case-insensitively", () => {
    expect(filterSkills(skills, "ASTRO")).toEqual([skills[0]]);
  });

  it("matches on description", () => {
    expect(filterSkills(skills, "question")).toEqual([skills[1]]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSkills(skills, "nonexistent")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/state/format.test.ts tests/state/filter.test.ts`
Expected: FAIL, both modules missing.

- [ ] **Step 3: Write `src/state/format.ts`**

```ts
import type { Provenance, Skill } from "./types.js";

export function formatProvenance(provenance: Provenance): string {
  switch (provenance.kind) {
    case "source":
      return `from ${provenance.source}`;
    case "author":
      if (provenance.authors) return `by ${provenance.authors}`;
      if (provenance.license) return `${provenance.license} license`;
      if (provenance.version) return `v${provenance.version}`;
      return "author metadata present";
    case "local":
      return "local (mine)";
  }
}

export function formatSkillLine(skill: Skill): string {
  if (skill.orphaned) {
    return `[!!!] ${skill.name} - ${formatProvenance(skill.provenance)} (orphaned lock entry, no folder)`;
  }
  const badge = skill.enabled ? "[on] " : "[off]";
  return `${badge} ${skill.name} - ${formatProvenance(skill.provenance)}`;
}
```

- [ ] **Step 4: Write `src/state/filter.ts`**

```ts
import type { Skill } from "./types.js";

export function filterSkills(skills: Skill[], query: string): Skill[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return skills;

  return skills.filter((skill) => {
    const name = skill.name.toLowerCase();
    const description = (skill.frontmatter?.description ?? "").toLowerCase();
    return name.includes(normalized) || description.includes(normalized);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/state/format.test.ts tests/state/filter.test.ts`
Expected: 11 tests total, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state/format.ts src/state/filter.ts tests/state/format.test.ts tests/state/filter.test.ts
git commit -m "Add skill line formatting and name/description filtering"
```

---

### Task 8: List and Detail UI components

**Files:**
- Create: `src/ui/List.tsx`
- Create: `src/ui/Detail.tsx`
- Test: `tests/ui/List.test.tsx`
- Test: `tests/ui/Detail.test.tsx`

**Interfaces:**
- Consumes: `Skill` type (Task 2), `formatSkillLine`/`formatProvenance` (Task 7).
- Produces:
  - `<List skills={Skill[]} selectedIndex={number} />` — pure presentational, one line per skill, `>` prefix on the selected row.
  - `<Detail skill={Skill | null} />` — pure presentational, full description + provenance, or a placeholder when nothing is selected.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/ui/List.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { List } from "../../src/ui/List.js";
import type { Skill } from "../../src/state/types.js";

function skill(name: string): Skill {
  return {
    name,
    enabled: true,
    orphaned: false,
    path: `/agent/skills/${name}`,
    frontmatter: { name, description: `${name} description` },
    lockEntry: null,
    provenance: { kind: "local" },
  };
}

describe("List", () => {
  it("renders one line per skill", () => {
    const { lastFrame } = render(<List skills={[skill("astro"), skill("research")]} selectedIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("astro");
    expect(frame).toContain("research");
  });

  it("marks the selected row", () => {
    const { lastFrame } = render(<List skills={[skill("astro"), skill("research")]} selectedIndex={1} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const researchLine = lines.find((line) => line.includes("research"));
    const astroLine = lines.find((line) => line.includes("astro"));
    expect(researchLine?.startsWith(">")).toBe(true);
    expect(astroLine?.startsWith(">")).toBe(false);
  });

  it("renders a placeholder when there are no skills", () => {
    const { lastFrame } = render(<List skills={[]} selectedIndex={0} />);
    expect(lastFrame()).toContain("No skills match");
  });
});
```

```tsx
// tests/ui/Detail.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Detail } from "../../src/ui/Detail.js";
import type { Skill } from "../../src/state/types.js";

describe("Detail", () => {
  it("shows a placeholder when nothing is selected", () => {
    const { lastFrame } = render(<Detail skill={null} />);
    expect(lastFrame()).toContain("No skill selected");
  });

  it("shows the name, description, and provenance of the selected skill", () => {
    const skill: Skill = {
      name: "astro",
      enabled: true,
      orphaned: false,
      path: "/agent/skills/astro",
      frontmatter: { name: "astro", description: "Build Astro sites", license: "MIT", metadata: { authors: "Astro Team" } },
      lockEntry: null,
      provenance: { kind: "author", authors: "Astro Team", license: "MIT" },
    };
    const { lastFrame } = render(<Detail skill={skill} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("astro");
    expect(frame).toContain("Build Astro sites");
    expect(frame).toContain("by Astro Team");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/ui/List.test.tsx tests/ui/Detail.test.tsx`
Expected: FAIL, both components missing.

- [ ] **Step 3: Write `src/ui/List.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Skill } from "../state/types.js";
import { formatSkillLine } from "../state/format.js";

export interface ListProps {
  skills: Skill[];
  selectedIndex: number;
}

export function List({ skills, selectedIndex }: ListProps) {
  if (skills.length === 0) {
    return (
      <Box>
        <Text dimColor>No skills match the current filter.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {skills.map((skill, index) => {
        const isSelected = index === selectedIndex;
        const prefix = isSelected ? "> " : "  ";
        return (
          <Text key={skill.name} color={skill.orphaned ? "red" : undefined} inverse={isSelected}>
            {prefix}
            {formatSkillLine(skill)}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: Write `src/ui/Detail.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Skill } from "../state/types.js";
import { formatProvenance } from "../state/format.js";

export interface DetailProps {
  skill: Skill | null;
}

export function Detail({ skill }: DetailProps) {
  if (!skill) {
    return (
      <Box>
        <Text dimColor>No skill selected.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>{skill.name}</Text>
      <Text>{skill.frontmatter?.description ?? "(no description)"}</Text>
      <Text dimColor>{formatProvenance(skill.provenance)}</Text>
      {skill.lockEntry && (
        <Text dimColor>
          installed {skill.lockEntry.installedAt}, updated {skill.lockEntry.updatedAt}
        </Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/ui/List.test.tsx tests/ui/Detail.test.tsx`
Expected: 5 tests total, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/List.tsx src/ui/Detail.tsx tests/ui/List.test.tsx tests/ui/Detail.test.tsx
git commit -m "Add List and Detail presentational components"
```

---

### Task 9: Git status indicator, then App wiring (navigation, filter, actions)

**Files:**
- Create: `src/state/gitStatus.ts`
- Test: `tests/state/gitStatus.test.ts`
- Create: `src/ui/App.tsx`
- Test: `tests/ui/App.test.tsx`

**Interfaces:**
- Consumes (gitStatus): nothing new — shells out with `execa` directly, same pattern as Task 5.
- Produces (gitStatus): `countGitStatusLines(agentRoot: string): Promise<number>` — runs `git status --short` read-only in `agentRoot`, returns the number of non-empty output lines, and returns `0` (never throws) when the command fails for any reason (not a git repo, git not installed, etc.) — the status line degrades silently rather than crashing the TUI.
- Consumes (App): `scanSkills` (Task 3), `disableSkill`/`enableSkill` (Task 4), `updateAll`/`updateOne` (Task 6), `filterSkills` (Task 7), `List`/`Detail` (Task 8), `countGitStatusLines` (this task).
- Produces (App): `<App agentRoot={string} />` — the only component that touches the filesystem or the `skills` CLI. Keybindings:
  - `up`/`k`, `down`/`j`: move selection
  - `/`: enter search mode; typing filters; `enter`/`escape` exits search mode
  - `space`: toggle enable/disable on the selected skill (no-op on orphaned rows)
  - `u`: update the selected skill
  - `U`: update all
  - `a`: enter add mode; type a package identifier (e.g. `owner/repo`); `enter` runs `skills add <package> -y` then reloads; `escape` cancels
  - `d`: enter confirm-remove mode on the selected skill (no-op on orphaned rows); `y` runs `skills remove <name> -y` then reloads; any other key cancels
  - `q`: exit

- [ ] **Step 1: Write the failing test for `gitStatus`**

```ts
// tests/state/gitStatus.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { countGitStatusLines } = await import("../../src/state/gitStatus.js");

beforeEach(() => {
  execaMock.mockReset();
});

describe("countGitStatusLines", () => {
  it("returns 0 for a clean tree", async () => {
    execaMock.mockResolvedValue({ stdout: "" });
    expect(await countGitStatusLines("/agent")).toBe(0);
    expect(execaMock).toHaveBeenCalledWith("git", ["status", "--short"], { cwd: "/agent" });
  });

  it("counts non-empty output lines", async () => {
    execaMock.mockResolvedValue({ stdout: " M skills/foo/SKILL.md\n?? skills/bar/\n" });
    expect(await countGitStatusLines("/agent")).toBe(2);
  });

  it("returns 0 instead of throwing when git fails or is not a repo", async () => {
    execaMock.mockRejectedValue(new Error("not a git repository"));
    expect(await countGitStatusLines("/agent")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/state/gitStatus.test.ts`
Expected: FAIL with "Cannot find module '../../src/state/gitStatus.js'".

- [ ] **Step 3: Write `src/state/gitStatus.ts`**

```ts
import { execa } from "execa";

export async function countGitStatusLines(agentRoot: string): Promise<number> {
  try {
    const result = await execa("git", ["status", "--short"], { cwd: agentRoot });
    return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/state/gitStatus.test.ts`
Expected: 3 tests, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/gitStatus.ts tests/state/gitStatus.test.ts
git commit -m "Add read-only git status line counter for the status bar"
```

- [ ] **Step 6: Write the failing test for `App`**

```tsx
// tests/ui/App.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePaths } from "../../src/state/repo.js";

const updateSkillsMock = vi.fn().mockResolvedValue({ command: "skills update -y", stdout: "ok", stderr: "", exitCode: 0 });
const addSkillMock = vi.fn().mockResolvedValue({ command: "skills add owner/repo -y", stdout: "added", stderr: "", exitCode: 0 });
const removeSkillMock = vi.fn().mockResolvedValue({ command: "skills remove astro -y", stdout: "removed", stderr: "", exitCode: 0 });
vi.mock("../../src/actions/skillsCli.js", () => ({
  updateSkills: updateSkillsMock,
  removeSkill: removeSkillMock,
  findSkills: vi.fn(),
  addSkill: addSkillMock,
}));

const countGitStatusLinesMock = vi.fn().mockResolvedValue(0);
vi.mock("../../src/state/gitStatus.js", () => ({ countGitStatusLines: countGitStatusLinesMock }));

const { App } = await import("../../src/ui/App.js");

let agentRoot: string;

async function writeSkill(dir: string, name: string, description: string) {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  agentRoot = await mkdtemp(path.join(tmpdir(), "skills-manager-app-"));
  const paths = resolvePaths(agentRoot);
  await writeSkill(paths.skillsDir, "astro", "Build Astro sites");
  await writeSkill(paths.skillsDir, "research", "Investigate a question");
  updateSkillsMock.mockClear();
});

afterEach(async () => {
  await rm(agentRoot, { recursive: true, force: true });
});

describe("App", () => {
  it("loads and lists skills from the agent root on mount", async () => {
    const { lastFrame } = render(<App agentRoot={agentRoot} />);
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("astro");
    expect(frame).toContain("research");
  });

  it("toggles the selected skill off and back on with space", async () => {
    const { stdin, lastFrame } = render(<App agentRoot={agentRoot} />);
    await flush();
    const paths = resolvePaths(agentRoot);

    stdin.write(" ");
    await flush();
    expect(await exists(path.join(paths.disabledDir, "astro"))).toBe(true);
    expect((lastFrame() ?? "")).toContain("[off]");

    stdin.write(" ");
    await flush();
    expect(await exists(path.join(paths.skillsDir, "astro"))).toBe(true);
  });

  it("filters the list when in search mode", async () => {
    const { stdin, lastFrame } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("/");
    stdin.write("research");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("research");
    expect(frame).not.toContain("astro");
  });

  it("runs update-all with U", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("U");
    await flush();

    expect(updateSkillsMock).toHaveBeenCalledWith([]);
  });

  it("shows the git status line count in the status bar", async () => {
    countGitStatusLinesMock.mockResolvedValue(3);
    const { lastFrame } = render(<App agentRoot={agentRoot} />);
    await flush();
    expect(lastFrame() ?? "").toContain("3 uncommitted change");
  });

  it("adds a package with a, typing the name, and enter", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("a");
    stdin.write("owner/repo");
    stdin.write("\r");
    await flush();

    expect(addSkillMock).toHaveBeenCalledWith("owner/repo");
  });

  it("cancels add mode on escape without calling addSkill", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("a");
    stdin.write("owner/repo");
    stdin.write("");
    await flush();

    expect(addSkillMock).not.toHaveBeenCalled();
  });

  it("removes the selected skill with d then y", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("d");
    stdin.write("y");
    await flush();

    expect(removeSkillMock).toHaveBeenCalledWith("astro");
  });

  it("cancels remove on d then any non-y key", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("d");
    stdin.write("n");
    await flush();

    expect(removeSkillMock).not.toHaveBeenCalled();
  });

  it("does not enter confirm-remove for an orphaned row", async () => {
    // Write the orphaned lock entry BEFORE mounting: App only rescans on an
    // explicit action (toggle/update/add/remove), never on plain navigation,
    // so a change made after mount would never be picked up by this test.
    const paths = resolvePaths(agentRoot);
    await writeFile(
      paths.lockFile,
      JSON.stringify({
        version: 3,
        skills: {
          ghost: {
            source: "some/repo",
            sourceType: "github",
            sourceUrl: "https://github.com/some/repo.git",
            skillPath: "skills/ghost/SKILL.md",
            skillFolderHash: "h",
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8"
    );
    const { stdin, lastFrame } = render(<App agentRoot={agentRoot} />);
    await flush();

    // Scan order is alphabetical: astro, ghost, research. Navigate to ghost.
    stdin.write("j");
    await flush();
    stdin.write("d");
    await flush();

    expect(lastFrame() ?? "").not.toContain("Remove ghost?");
    expect(removeSkillMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- tests/ui/App.test.tsx`
Expected: FAIL with "Cannot find module '../../src/ui/App.js'".

- [ ] **Step 8: Write `src/ui/App.tsx`**

```tsx
import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { scanSkills } from "../state/repo.js";
import { disableSkill, enableSkill } from "../actions/toggle.js";
import { updateAll, updateOne } from "../actions/update.js";
import { addSkill, removeSkill } from "../actions/skillsCli.js";
import { filterSkills } from "../state/filter.js";
import { countGitStatusLines } from "../state/gitStatus.js";
import type { Skill } from "../state/types.js";
import { List } from "./List.js";
import { Detail } from "./Detail.js";

export interface AppProps {
  agentRoot: string;
}

type Mode = "browse" | "search" | "add" | "confirm-remove";

export function App({ agentRoot }: AppProps) {
  const { exit } = useApp();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("browse");
  const [query, setQuery] = useState("");
  const [addInput, setAddInput] = useState("");
  const [status, setStatus] = useState("");
  const [gitStatusLines, setGitStatusLines] = useState(0);

  const reload = useCallback(async () => {
    const [next, lines] = await Promise.all([scanSkills(agentRoot), countGitStatusLines(agentRoot)]);
    setSkills(next);
    setGitStatusLines(lines);
  }, [agentRoot]);

  useEffect(() => {
    reload();
  }, [reload]);

  const visible = filterSkills(skills, query);
  const clampedIndex = visible.length === 0 ? 0 : Math.min(selectedIndex, visible.length - 1);
  const selected = visible[clampedIndex] ?? null;

  useInput((input, key) => {
    if (mode === "search") {
      if (key.return || key.escape) {
        setMode("browse");
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input) {
        setQuery((q) => q + input);
      }
      return;
    }

    if (mode === "add") {
      if (key.escape) {
        setAddInput("");
        setMode("browse");
        return;
      }
      if (key.return) {
        const packageName = addInput.trim();
        setMode("browse");
        setAddInput("");
        if (packageName === "") return;
        setStatus(`adding ${packageName}...`);
        addSkill(packageName).then((result) => {
          setStatus(result.command);
          reload();
        });
        return;
      }
      if (key.backspace || key.delete) {
        setAddInput((v) => v.slice(0, -1));
        return;
      }
      if (input) {
        setAddInput((v) => v + input);
      }
      return;
    }

    if (mode === "confirm-remove") {
      if (input === "y" && selected) {
        const name = selected.name;
        setMode("browse");
        setStatus(`removing ${name}...`);
        removeSkill(name).then((result) => {
          setStatus(result.command);
          reload();
        });
        return;
      }
      setMode("browse");
      return;
    }

    if (input === "q") {
      exit();
      return;
    }
    if (input === "/") {
      setMode("search");
      return;
    }
    if (input === "a") {
      setMode("add");
      return;
    }
    if (input === "d") {
      if (!selected || selected.orphaned) return;
      setMode("confirm-remove");
      return;
    }
    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(visible.length - 1, i + 1));
      return;
    }
    if (input === " ") {
      if (!selected || selected.orphaned) return;
      const action = selected.enabled ? disableSkill : enableSkill;
      action(agentRoot, selected.name).then(reload);
      return;
    }
    if (input === "u") {
      if (!selected || selected.orphaned) return;
      setStatus(`updating ${selected.name}...`);
      updateOne(agentRoot, selected.name).then((report) => {
        setStatus(report.result.command);
        reload();
      });
      return;
    }
    if (input === "U") {
      setStatus("updating all...");
      updateAll(agentRoot).then((report) => {
        setStatus(report.result.command);
        reload();
      });
      return;
    }
  });

  return (
    <Box flexDirection="column">
      {mode === "search" && (
        <Box>
          <Text>/{query}</Text>
        </Box>
      )}
      {mode === "add" && (
        <Box>
          <Text>Add package (owner/repo): {addInput}</Text>
        </Box>
      )}
      {mode === "confirm-remove" && selected && (
        <Box>
          <Text>Remove {selected.name}? (y/n)</Text>
        </Box>
      )}
      <Box>
        <Box width="60%">
          <List skills={visible} selectedIndex={clampedIndex} />
        </Box>
        <Box width="40%">
          <Detail skill={selected} />
        </Box>
      </Box>
      <Box>
        <Text dimColor>
          {status}
          {status ? " | " : ""}
          {gitStatusLines > 0
            ? `${gitStatusLines} uncommitted change${gitStatusLines === 1 ? "" : "s"} in ~/.agents`
            : "~/.agents clean"}
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- tests/ui/App.test.tsx`
Expected: 10 tests, PASS.

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all test files across every task, PASS.

- [ ] **Step 11: Commit**

```bash
git add src/ui/App.tsx tests/ui/App.test.tsx
git commit -m "Wire App: navigation, search mode, toggle, update actions, and git status bar"
```

---

### Task 10: Git panel (diff, commit, push)

**Files:**
- Create: `src/actions/git.ts`
- Test: `tests/actions/git.test.ts`
- Create: `src/ui/GitPanel.tsx`
- Test: `tests/ui/GitPanel.test.tsx`
- Modify: `src/ui/App.tsx` (adds the `g` key and git-panel state)
- Modify: `tests/ui/App.test.tsx` (adds tests for the new key)

**Interfaces:**
- Produces (`git.ts`):
  - `interface GitResult { command: string; stdout: string; stderr: string; exitCode: number }`
  - `getStatus(agentRoot: string): Promise<GitResult>` — `git status --short`
  - `getDiffStat(agentRoot: string): Promise<GitResult>` — `git diff --stat`
  - `commitAll(agentRoot: string, message: string): Promise<GitResult>` — `git add -A` then `git commit -m <message>`; if `add` fails, returns that failure without attempting the commit
  - `push(agentRoot: string): Promise<GitResult>` — `git push`
  - None of these ever throw — CLI/git failures come back as `exitCode !== 0`.
- Consumes (`GitPanel.tsx`): nothing beyond props — pure presentational, like `List`/`Detail`.
- Produces (`GitPanel.tsx`): `<GitPanel status={string} diffStat={string} gitMode={"view"|"commit-message"|"confirm-push"} commitMessage={string} lastResult={string} />`
- Consumes (`App.tsx` changes): `getStatus`, `getDiffStat`, `commitAll`, `push` (this task), `GitPanel` (this task).
- Produces (`App.tsx` changes): a new top-level mode `"git"` reachable via `g` from browse mode, with its own sub-mode (`view` / `commit-message` / `confirm-push`) as described in the spec's Git panel section: `c` stages+commits (prompts for a message), `p` pushes (prompts y/n), `escape` closes the panel back to browse mode.

- [ ] **Step 1: Write the failing test for `git.ts`**

```ts
// tests/actions/git.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { getStatus, getDiffStat, commitAll, push } = await import("../../src/actions/git.js");

beforeEach(() => {
  execaMock.mockReset();
});

describe("getStatus", () => {
  it("runs `git status --short` in agentRoot", async () => {
    execaMock.mockResolvedValue({ stdout: " M skills/foo/SKILL.md\n", stderr: "", exitCode: 0 });
    const result = await getStatus("/agent");
    expect(execaMock).toHaveBeenCalledWith("git", ["status", "--short"], { cwd: "/agent" });
    expect(result).toEqual({ command: "git status --short", stdout: " M skills/foo/SKILL.md\n", stderr: "", exitCode: 0 });
  });
});

describe("getDiffStat", () => {
  it("runs `git diff --stat` in agentRoot", async () => {
    execaMock.mockResolvedValue({ stdout: " 1 file changed", stderr: "", exitCode: 0 });
    await getDiffStat("/agent");
    expect(execaMock).toHaveBeenCalledWith("git", ["diff", "--stat"], { cwd: "/agent" });
  });
});

describe("commitAll", () => {
  it("stages everything then commits with the given message", async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // git add -A
      .mockResolvedValueOnce({ stdout: "[main abc123] msg", stderr: "", exitCode: 0 }); // git commit

    const result = await commitAll("/agent", "Enable astro");

    expect(execaMock).toHaveBeenNthCalledWith(1, "git", ["add", "-A"], { cwd: "/agent" });
    expect(execaMock).toHaveBeenNthCalledWith(2, "git", ["commit", "-m", "Enable astro"], { cwd: "/agent" });
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("git commit -m Enable astro");
  });

  it("does not attempt to commit when staging fails", async () => {
    execaMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { stdout: "", stderr: "add failed", exitCode: 1 }));

    const result = await commitAll("/agent", "Enable astro");

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.command).toBe("git add -A");
  });
});

describe("push", () => {
  it("runs `git push` in agentRoot", async () => {
    execaMock.mockResolvedValue({ stdout: "Everything up-to-date", stderr: "", exitCode: 0 });
    await push("/agent");
    expect(execaMock).toHaveBeenCalledWith("git", ["push"], { cwd: "/agent" });
  });

  it("returns a non-zero exit code instead of throwing when push fails", async () => {
    execaMock.mockRejectedValue(Object.assign(new Error("boom"), { stdout: "", stderr: "rejected", exitCode: 1 }));
    const result = await push("/agent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("rejected");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/actions/git.test.ts`
Expected: FAIL with "Cannot find module '../../src/actions/git.js'".

- [ ] **Step 3: Write `src/actions/git.ts`**

```ts
import { execa } from "execa";

export interface GitResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runGitCommand(agentRoot: string, args: string[]): Promise<GitResult> {
  const command = `git ${args.join(" ")}`;
  try {
    const result = await execa("git", args, { cwd: agentRoot });
    return {
      command,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; exitCode?: number; message?: string };
    return {
      command,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? error),
      exitCode: typeof err.exitCode === "number" ? err.exitCode : 1,
    };
  }
}

export function getStatus(agentRoot: string): Promise<GitResult> {
  return runGitCommand(agentRoot, ["status", "--short"]);
}

export function getDiffStat(agentRoot: string): Promise<GitResult> {
  return runGitCommand(agentRoot, ["diff", "--stat"]);
}

export async function commitAll(agentRoot: string, message: string): Promise<GitResult> {
  const add = await runGitCommand(agentRoot, ["add", "-A"]);
  if (add.exitCode !== 0) return add;
  return runGitCommand(agentRoot, ["commit", "-m", message]);
}

export function push(agentRoot: string): Promise<GitResult> {
  return runGitCommand(agentRoot, ["push"]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/actions/git.test.ts`
Expected: 6 tests, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/actions/git.ts tests/actions/git.test.ts
git commit -m "Add git wrapper: status, diff --stat, commit-all, push"
```

- [ ] **Step 6: Write the failing test for `GitPanel`**

```tsx
// tests/ui/GitPanel.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { GitPanel } from "../../src/ui/GitPanel.js";

describe("GitPanel", () => {
  it("shows a clean message when status is empty", () => {
    const { lastFrame } = render(
      <GitPanel status="" diffStat="" gitMode="view" commitMessage="" lastResult="" />
    );
    expect(lastFrame() ?? "").toContain("Clean, nothing to commit");
  });

  it("shows the status and diff stat when there are changes", () => {
    const { lastFrame } = render(
      <GitPanel status=" M skills/foo/SKILL.md" diffStat="1 file changed" gitMode="view" commitMessage="" lastResult="" />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("skills/foo/SKILL.md");
    expect(frame).toContain("1 file changed");
  });

  it("shows the commit message being typed in commit-message mode", () => {
    const { lastFrame } = render(
      <GitPanel status="" diffStat="" gitMode="commit-message" commitMessage="Enable astro" lastResult="" />
    );
    expect(lastFrame() ?? "").toContain("Enable astro");
  });

  it("shows a push confirmation prompt in confirm-push mode", () => {
    const { lastFrame } = render(
      <GitPanel status="" diffStat="" gitMode="confirm-push" commitMessage="" lastResult="" />
    );
    expect(lastFrame() ?? "").toContain("Push to remote?");
  });

  it("shows the last result when present", () => {
    const { lastFrame } = render(
      <GitPanel status="" diffStat="" gitMode="view" commitMessage="" lastResult="git push" />
    );
    expect(lastFrame() ?? "").toContain("git push");
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- tests/ui/GitPanel.test.tsx`
Expected: FAIL with "Cannot find module '../../src/ui/GitPanel.js'".

- [ ] **Step 8: Write `src/ui/GitPanel.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";

export interface GitPanelProps {
  status: string;
  diffStat: string;
  gitMode: "view" | "commit-message" | "confirm-push";
  commitMessage: string;
  lastResult: string;
}

export function GitPanel({ status, diffStat, gitMode, commitMessage, lastResult }: GitPanelProps) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Git — ~/.agents</Text>
      <Text>{status.trim() === "" ? "Clean, nothing to commit." : status}</Text>
      {diffStat.trim() !== "" && <Text dimColor>{diffStat}</Text>}
      {gitMode === "commit-message" && <Text>Commit message: {commitMessage}</Text>}
      {gitMode === "confirm-push" && <Text>Push to remote? (y/n)</Text>}
      {lastResult !== "" && <Text dimColor>{lastResult}</Text>}
      <Text dimColor>c commit · p push · esc close</Text>
    </Box>
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- tests/ui/GitPanel.test.tsx`
Expected: 5 tests, PASS.

- [ ] **Step 10: Commit**

```bash
git add src/ui/GitPanel.tsx tests/ui/GitPanel.test.tsx
git commit -m "Add GitPanel presentational component"
```

- [ ] **Step 11: Write the failing tests for the `App.tsx` git-panel wiring**

Append to `tests/ui/App.test.tsx` (same file as Task 9; add these `describe`/`it` blocks and extend the mock setup):

```tsx
// Add to the top of tests/ui/App.test.tsx, alongside the other action mocks:
const getStatusMock = vi.fn().mockResolvedValue({ command: "git status --short", stdout: "", stderr: "", exitCode: 0 });
const getDiffStatMock = vi.fn().mockResolvedValue({ command: "git diff --stat", stdout: "", stderr: "", exitCode: 0 });
const commitAllMock = vi.fn().mockResolvedValue({ command: "git commit -m msg", stdout: "ok", stderr: "", exitCode: 0 });
const pushMock = vi.fn().mockResolvedValue({ command: "git push", stdout: "ok", stderr: "", exitCode: 0 });
vi.mock("../../src/actions/git.js", () => ({
  getStatus: getStatusMock,
  getDiffStat: getDiffStatMock,
  commitAll: commitAllMock,
  push: pushMock,
}));
```

```tsx
// Add as a new describe block at the end of tests/ui/App.test.tsx:
describe("App git panel", () => {
  it("opens the git panel with g and shows status/diff", async () => {
    getStatusMock.mockResolvedValue({ command: "git status --short", stdout: " M skills/astro/SKILL.md", stderr: "", exitCode: 0 });
    getDiffStatMock.mockResolvedValue({ command: "git diff --stat", stdout: "1 file changed", stderr: "", exitCode: 0 });
    const { stdin, lastFrame } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("g");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("skills/astro/SKILL.md");
    expect(frame).toContain("1 file changed");
  });

  it("closes the git panel on escape", async () => {
    const { stdin, lastFrame } = render(<App agentRoot={agentRoot} />);
    await flush();
    stdin.write("g");
    await flush();
    stdin.write("");
    await flush();
    expect(lastFrame() ?? "").not.toContain("Git —");
  });

  it("commits with c, typing a message, and enter", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("g");
    await flush();
    stdin.write("c");
    stdin.write("Enable astro");
    stdin.write("\r");
    await flush();

    expect(commitAllMock).toHaveBeenCalledWith(agentRoot, "Enable astro");
  });

  it("does not commit an empty message", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("g");
    await flush();
    stdin.write("c");
    stdin.write("\r");
    await flush();

    expect(commitAllMock).not.toHaveBeenCalled();
  });

  it("pushes with p then y", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("g");
    await flush();
    stdin.write("p");
    stdin.write("y");
    await flush();

    expect(pushMock).toHaveBeenCalledWith(agentRoot);
  });

  it("cancels push on p then any non-y key", async () => {
    const { stdin } = render(<App agentRoot={agentRoot} />);
    await flush();

    stdin.write("g");
    await flush();
    stdin.write("p");
    stdin.write("n");
    await flush();

    expect(pushMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `npm test -- tests/ui/App.test.tsx`
Expected: FAIL — `App.tsx` doesn't yet import `git.js` or handle `g`/`c`/`p` in git mode; the new `describe("App git panel", ...)` tests fail.

- [ ] **Step 13: Modify `src/ui/App.tsx`**

Add the import:

```tsx
import { getStatus, getDiffStat, commitAll, push as gitPush } from "../actions/git.js";
import { GitPanel } from "./GitPanel.js";
```

Extend the `Mode` type and add git-panel state (near the other `useState` calls):

```tsx
type Mode = "browse" | "search" | "add" | "confirm-remove" | "git";
type GitMode = "view" | "commit-message" | "confirm-push";
```

```tsx
  const [gitMode, setGitMode] = useState<GitMode>("view");
  const [gitStatusText, setGitStatusText] = useState("");
  const [gitDiffStatText, setGitDiffStatText] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [gitLastResult, setGitLastResult] = useState("");

  const refreshGitPanel = useCallback(async () => {
    const [status, diffStat] = await Promise.all([getStatus(agentRoot), getDiffStat(agentRoot)]);
    setGitStatusText(status.stdout);
    setGitDiffStatText(diffStat.stdout);
  }, [agentRoot]);
```

Add a branch inside `useInput`, alongside the existing `if (mode === "confirm-remove") { ... }` block:

```tsx
    if (mode === "git") {
      if (gitMode === "view") {
        if (key.escape) {
          setMode("browse");
          return;
        }
        if (input === "c") {
          setGitCommitMessage("");
          setGitMode("commit-message");
          return;
        }
        if (input === "p") {
          setGitMode("confirm-push");
          return;
        }
        return;
      }
      if (gitMode === "commit-message") {
        if (key.escape) {
          setGitMode("view");
          return;
        }
        if (key.return) {
          const message = gitCommitMessage.trim();
          setGitMode("view");
          if (message === "") return;
          commitAll(agentRoot, message).then((result) => {
            setGitLastResult(result.command);
            refreshGitPanel();
            reload();
          });
          return;
        }
        if (key.backspace || key.delete) {
          setGitCommitMessage((v) => v.slice(0, -1));
          return;
        }
        if (input) {
          setGitCommitMessage((v) => v + input);
        }
        return;
      }
      if (gitMode === "confirm-push") {
        if (input === "y") {
          setGitMode("view");
          gitPush(agentRoot).then((result) => {
            setGitLastResult(result.command);
            refreshGitPanel();
          });
          return;
        }
        setGitMode("view");
        return;
      }
      return;
    }
```

Add the `g` key to the top-level browse-mode dispatch, next to the `a`/`d` handlers:

```tsx
    if (input === "g") {
      setMode("git");
      setGitMode("view");
      setGitLastResult("");
      refreshGitPanel();
      return;
    }
```

Render the panel below the list/detail row, alongside the other conditional panels:

```tsx
      {mode === "git" && (
        <GitPanel
          status={gitStatusText}
          diffStat={gitDiffStatText}
          gitMode={gitMode}
          commitMessage={gitCommitMessage}
          lastResult={gitLastResult}
        />
      )}
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `npm test -- tests/ui/App.test.tsx`
Expected: 16 tests (10 from Task 9 + 6 new), PASS.

- [ ] **Step 15: Run the full test suite**

Run: `npm test`
Expected: all test files across every task, PASS.

- [ ] **Step 16: Commit**

```bash
git add src/ui/App.tsx tests/ui/App.test.tsx
git commit -m "Wire Git panel into App: g to open, c to commit, p to push"
```

---

### Task 11: CLI entry point and manual smoke test

**Files:**
- Create: `src/cli.tsx`
- Modify: `package.json` (already has `bin`/`build`/`dev` from Task 1 — no changes needed, this task just uses them)
- Create: `README.md`

**Interfaces:**
- Consumes: `App` from Task 9 (as extended by Task 10's Git panel).
- Produces: the `skills-manager` executable. Reads `agentRoot` from `--agent-root <path>` or defaults to `path.join(os.homedir(), ".agents")`.

- [ ] **Step 1: Write `src/cli.tsx`**

```tsx
#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { homedir } from "node:os";
import path from "node:path";
import { App } from "./ui/App.js";

function resolveAgentRoot(argv: string[]): string {
  const flagIndex = argv.indexOf("--agent-root");
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1];
  }
  return path.join(homedir(), ".agents");
}

const agentRoot = resolveAgentRoot(process.argv.slice(2));
render(<App agentRoot={agentRoot} />);
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `dist/cli.js` and the rest of `dist/` produced with no TypeScript errors.

- [ ] **Step 3: Make the built entry point executable**

```bash
chmod +x dist/cli.js
```

- [ ] **Step 4: Manual smoke test against a disposable fixture (not your real `~/.agents`)**

```bash
mkdir -p /tmp/skills-manager-smoke/skills/demo-skill
cat > /tmp/skills-manager-smoke/skills/demo-skill/SKILL.md <<'EOF'
---
name: demo-skill
description: A fixture skill for manual smoke testing
---
# Demo skill
EOF
node dist/cli.js --agent-root /tmp/skills-manager-smoke
```

In the running TUI: confirm `demo-skill` is listed as `[on]` with "local (mine)"; press `space` and confirm the status area doesn't error and the row now reads `[off]`; press `space` again to re-enable; press `/` then type `demo` and confirm the row stays visible, type `xyz` and confirm the list goes empty with the "No skills match" placeholder; press `escape` to leave search mode; press `d` then `n` and confirm nothing is removed; press `a` then `escape` and confirm nothing is added and the tool doesn't hang waiting on network; press `g` and confirm the Git panel opens without crashing even though `/tmp/skills-manager-smoke` is not a git repo (status/diff should just come back empty, not throw), then `escape` to close it; press `q` to quit. Then clean up:

```bash
rm -rf /tmp/skills-manager-smoke
```

This is a manual step — there is no automated harness for actually watching the rendered terminal, so this confirms the built binary behaves correctly end-to-end before calling the feature done.

- [ ] **Step 5: Manual smoke test of commit against a disposable git fixture**

The commit/push logic is unit-tested with a mocked `execa` in Task 10, but exercise it once against a real (throwaway) git repo so a real `git` invocation is proven to work, not just the mock:

```bash
mkdir -p /tmp/skills-manager-git-smoke/skills/demo-skill
cd /tmp/skills-manager-git-smoke && git init -q && git config user.email "test@example.com" && git config user.name "Test"
cat > skills/demo-skill/SKILL.md <<'EOF'
---
name: demo-skill
---
# Demo skill
EOF
git add -A && git commit -q -m "initial fixture"
cd -
node dist/cli.js --agent-root /tmp/skills-manager-git-smoke
```

Edit `/tmp/skills-manager-git-smoke/skills/demo-skill/SKILL.md` in another terminal to create a real diff, then in the TUI: press `g`, confirm the panel shows that file as changed; press `c`, type a message, `enter`, and confirm the status area clears (nothing left to commit) and `git log` in the fixture shows the new commit. Skip testing `p` (push) here — there's no remote on this throwaway repo; push is covered by the unit test's mocked `execa` call in Task 10. Clean up:

```bash
rm -rf /tmp/skills-manager-git-smoke
```

- [ ] **Step 6: Write `README.md`**

```markdown
# skills-manager

Terminal UI for managing agent skills stored in `~/.agents`.

## Usage

    npm install
    npm run build
    node dist/cli.js

Or point it at a different agent root (useful for testing):

    node dist/cli.js --agent-root /path/to/fixture

## Keybindings

- `up`/`k`, `down`/`j` — move selection
- `/` — search by name/description; `enter`/`escape` to leave search mode
- `space` — enable/disable the selected skill
- `u` — update the selected skill (stays disabled afterward if it was disabled)
- `U` — update all skills (disabled ones are restored, updated, then re-disabled)
- `a` — add a skill by package identifier (`owner/repo`), `enter` to confirm, `escape` to cancel
- `d` — remove the selected skill, `y` to confirm, any other key to cancel
- `g` — open the Git panel for `~/.agents` (status + diff --stat); `c` to stage everything and commit with a typed message, `p` then `y` to push, `escape` to close. Nothing here ever runs automatically — every action needs its own keypress.
- `q` — quit

See `docs/superpowers/specs/2026-09-16-skills-manager-design.md` for the design rationale.
```

- [ ] **Step 7: Commit**

```bash
git add src/cli.tsx README.md
git commit -m "Add CLI entry point and README"
```

---

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.
