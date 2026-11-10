import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { checkForUpdates, type UpdateCheckReport } from "../../src/actions/checkUpdates.js";
import { runConfinedSkills } from "../../src/actions/sandbox.js";
import type { LockEntry, Skill } from "../../src/state/types.js";

function skill(name: string, entry: Partial<LockEntry> = {}): Skill {
  const lockEntry: LockEntry = {
    source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
    skillPath: `skills/${name}/SKILL.md`, skillFolderHash: "a".repeat(40),
    installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...entry,
  };
  return {
    id: JSON.stringify(["/selected", name]), name, enabled: true, orphaned: false, path: `/selected/${name}`,
    entryKind: "directory", linkTarget: null, warnings: [], authors: [], frontmatter: null,
    lockEntry, recordedSource: lockEntry,
    provenance: lockEntry.sourceType === "local"
      ? { kind: "local" }
      : { kind: "source", source: lockEntry.source, sourceUrl: lockEntry.sourceUrl },
  };
}

const changed = (name: string) => ({ stdout: `Checking for skill updates…\n↑ ${name} has an update\n1 skill(s) can be updated\n`, stderr: "" });
const current = { stdout: "✓ All global skills are up to date\n", stderr: "" };

async function workspaceSkillName(workspace: string): Promise<string> {
  const lock = JSON.parse(await readFile(path.join(workspace, "state", "skills", ".skill-lock.json"), "utf8"));
  return Object.keys(lock.skills)[0];
}

describe("explicit update checks", () => {
  it("uses the real skill name in the disposable lock and placeholder and reports the CLI update", async () => {
    const target = skill('name "quoted" [.*]', { ref: "release", skillPath: "skills/example/SKILL.md" });
    let workspace = "";
    const report = await checkForUpdates([target], async (root, args) => {
      workspace = root;
      expect(args).toEqual(["check", "--global"]);
      const lock = JSON.parse(await readFile(path.join(root, "state", "skills", ".skill-lock.json"), "utf8"));
      expect(Object.keys(lock.skills)).toEqual([target.name]);
      expect(lock.skills[target.name]).toEqual(target.lockEntry);
      const document = await readFile(path.join(root, "home", ".agents", "skills", target.name, "SKILL.md"), "utf8");
      expect(parseYaml(document.split("---")[1])).toMatchObject({ name: target.name });
      return changed(target.name);
    });
    expect(report).toEqual({ updated: [target.id], unavailable: [] });
    await expect(readFile(path.join(workspace, "state", "skills", ".skill-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a relocated Git skill using the installed CLI and the real name", async () => {
    const target = skill("relocated-skill", {
      source: "https://gitlab.com/example/skills.git", sourceType: "git",
      sourceUrl: "https://gitlab.com/example/skills.git", skillFolderHash: "a".repeat(64),
      skillPath: "skills/old-location/SKILL.md",
    });
    const report = await checkForUpdates([target], async (workspace, args) => {
      const upstream = path.join(workspace, "upstream");
      const relocated = path.join(upstream, "skills", "new-location");
      await mkdir(relocated, { recursive: true });
      await writeFile(path.join(relocated, "SKILL.md"), "---\nname: relocated-skill\ndescription: Relocated fixture\n---\n");
      const env = {
        PATH: process.env.PATH, HOME: path.join(workspace, "home"), GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      };
      const git = (...command: string[]) => execFileSync("git", ["-C", upstream, "-c", "core.hooksPath=/dev/null", ...command], { env, stdio: "ignore" });
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "-m", "fixture");

      // Redirect only the disposable CLI invocation to the local Git fixture.
      const lockPath = path.join(workspace, "state", "skills", ".skill-lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      expect(lock.skills[target.name]).toEqual(target.lockEntry);
      lock.skills[target.name].sourceUrl = pathToFileURL(process.platform === "linux" ? "/workspace/upstream" : upstream).href;
      await writeFile(lockPath, JSON.stringify(lock));
      return runConfinedSkills(workspace, args);
    });
    expect(report).toEqual({ updated: [target.id], unavailable: [] });
  }, 30_000);

  it("treats a normal up-to-date result as current", async () => {
    const report = await checkForUpdates([skill("current")], async () => current);
    expect(report).toEqual({ updated: [], unavailable: [] });
  });

  it("does not mistake failed in a source or skill name for a CLI diagnostic", async () => {
    const target = skill("failed-skill", { source: "owner/failed-repository", sourceUrl: "https://github.com/owner/failed-repository.git" });
    const report = await checkForUpdates([target], async () => ({
      stdout: `Checking skills from source: owner/failed-repository\n\u001b[38;5;145m↑ failed-skill has an update\u001b[0m\n`, stderr: "",
    }));
    expect(report).toEqual({ updated: [target.id], unavailable: [] });
  });

  it("lets the CLI report a missing baseline as unavailable", async () => {
    const target = skill("missing", { skillFolderHash: "", skillPath: "" });
    const report = await checkForUpdates([target], async () => ({
      stdout: "1 skill(s) cannot be checked automatically:\n  • missing (Private or deleted repo)\n",
      stderr: "",
    }));
    expect(report.updated).toEqual([]);
    expect(report.unavailable[0]).toMatchObject({ id: target.id, reason: expect.stringMatching(/cannot be checked automatically/) });
  });

  it.each([
    "✗ Failed to check skills from owner/repository",
    "Warning: The following skills from owner/repository appear to have been deleted upstream:",
    "Warning: Multiple current paths match these skills from owner/repository; skipping them rather than deleting or migrating the wrong skill:",
    "1 skill(s) cannot be checked automatically:",
  ])("does not accept a current summary after a CLI diagnostic: %s", async (diagnostic) => {
    const report = await checkForUpdates([skill("example")], async () => ({ stdout: `${diagnostic}\n${current.stdout}`, stderr: "" }));
    expect(report.updated).toEqual([]);
    expect(report.unavailable[0]).toMatchObject({ category: "failed", reason: expect.stringMatching(/could not check/) });
  });

  it("does not accept an update marker alongside a CLI failure on stderr", async () => {
    const report = await checkForUpdates([skill("example")], async () => ({ ...changed("example"), stderr: "✗ Failed to check skills from owner/repository\n" }));
    expect(report.updated).toEqual([]);
    expect(report.unavailable[0]).toMatchObject({ category: "failed", reason: expect.stringMatching(/could not check/) });
  });

  it("requires an exact update marker instead of treating the skill name as a pattern", async () => {
    const report = await checkForUpdates([skill("one.*")], async () => changed("one-other"));
    expect(report.updated).toEqual([]);
    expect(report.unavailable[0]).toMatchObject({ category: "unknown", reason: expect.stringMatching(/unknown/) });
  });

  it("treats contradictory current and update markers as unknown", async () => {
    const report = await checkForUpdates([skill("example")], async () => ({ stdout: `${changed("example").stdout}${current.stdout}`, stderr: "" }));
    expect(report.updated).toEqual([]);
    expect(report.unavailable[0]).toMatchObject({ category: "unknown" });
  });

  it("reports sandbox errors instead of claiming current", async () => {
    const report = await checkForUpdates([skill("sandbox")], async () => { throw new Error("sandbox unavailable"); });
    expect(report.unavailable[0]).toMatchObject({ reason: "sandbox unavailable", category: "failed" });
  });

  it("bounds concurrent isolated checks and returns updates in input order", async () => {
    const targets = Array.from({ length: 7 }, (_, index) => skill(`skill-${index}`));
    const workspaces = new Set<string>();
    let active = 0;
    let maximum = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const report = await checkForUpdates(targets, async (workspace) => {
      workspaces.add(workspace);
      active++;
      maximum = Math.max(maximum, active);
      if (workspaces.size === 4) release();
      await gate;
      active--;
      return changed(await workspaceSkillName(workspace));
    });
    expect(maximum).toBe(4);
    expect(workspaces.size).toBe(7);
    expect(report.updated).toEqual(targets.map((target) => target.id));
    expect(report.unavailable).toEqual([]);
  });

  it("reports accumulated results as checks settle while preserving input order", async () => {
    const first = skill("first");
    const second = skill("second");
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: progress, resolve: sawProgress } = Promise.withResolvers<void>();
    const snapshots: UpdateCheckReport[] = [];
    const pending = checkForUpdates([first, second], async (workspace) => {
      const name = await workspaceSkillName(workspace);
      if (name === first.name) await gate;
      return changed(name);
    }, (report) => {
      snapshots.push(report);
      sawProgress();
    });

    await progress;
    expect(snapshots).toEqual([{ updated: [second.id], unavailable: [] }]);
    release();
    expect(await pending).toEqual({ updated: [first.id, second.id], unavailable: [] });
    expect(snapshots).toEqual([
      { updated: [second.id], unavailable: [] },
      { updated: [first.id, second.id], unavailable: [] },
    ]);
  });

  it("reports unavailable and unchanged skills as settled progress", async () => {
    const unsupported = { ...skill("unsupported"), recordedSource: null };
    const unchanged = skill("unchanged");
    const failed = skill("failed");
    const snapshots: UpdateCheckReport[] = [];
    const report = await checkForUpdates([unsupported, unchanged, failed], async (workspace) => {
      if (await workspaceSkillName(workspace) === failed.name) throw new Error("check failed");
      return current;
    }, (snapshot) => snapshots.push(snapshot));

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].unavailable).toEqual([{ id: unsupported.id, name: unsupported.name, reason: "The skills CLI does not track this skill.", category: "unknown" }]);
    expect(report).toEqual({
      updated: [],
      unavailable: [
        { id: unsupported.id, name: unsupported.name, reason: "The skills CLI does not track this skill.", category: "unknown" },
        { id: failed.id, name: failed.name, reason: "check failed", category: "failed" },
      ],
    });
    expect(snapshots[2]).toEqual(report);
  });

  it("propagates progress callback failures without treating them as check failures", async () => {
    const error = new Error("progress failed");
    await expect(checkForUpdates([{ ...skill("unsupported"), recordedSource: null }], undefined, () => {
      throw error;
    })).rejects.toBe(error);
  });

  it("does not report progress for an empty skill list", async () => {
    let calls = 0;
    expect(await checkForUpdates([], undefined, () => { calls++; })).toEqual({ updated: [], unavailable: [] });
    expect(calls).toBe(0);
  });

  it("does not report an update for a receipt-only skill the CLI does not track", async () => {
    const target = { ...skill("receipt-only"), recordedSource: null };
    const report = await checkForUpdates([target], async () => changed(target.name));
    expect(report).toEqual({
      updated: [],
      unavailable: [{ id: target.id, name: target.name, reason: "The skills CLI does not track this skill.", category: "unknown" }],
    });
  });

  it("does not invoke the CLI for local, unsafe, or unassociated entries", async () => {
    const unknown = { ...skill("unknown"), lockEntry: null, recordedSource: null, provenance: { kind: "unknown" } as const };
    const local = skill("local", { sourceType: "local", source: "/fixture", sourceUrl: "/fixture" });
    const unsafeSource = skill("unsafe-source", { sourceType: "git", sourceUrl: "file:///fixture" });
    const unsafePath = skill("unsafe-path", { skillPath: "skills/../outside/SKILL.md" });
    const report = await checkForUpdates([unknown, local, unsafeSource, unsafePath], async () => { throw new Error("must not run"); });
    expect(report.updated).toEqual([]);
    expect(report.unavailable.map((item) => item.name)).toEqual(["unknown", "local", "unsafe-source", "unsafe-path"]);
  });

  it.each(["../escape", "bad\nname", ".disabled_skills", " name ", "name\u0085"])("rejects an unsafe or CLI-ambiguous name without invoking the CLI: %s", async (name) => {
    const target = skill(name, { skillPath: "skills/example/SKILL.md" });
    const report = await checkForUpdates([target], async () => { throw new Error("must not run"); });
    expect(report.updated).toEqual([]);
    expect(report.unavailable[0]).toMatchObject({ category: "unknown", reason: expect.stringMatching(/name/i) });
  });
});
