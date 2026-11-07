import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkForUpdates, type UpdateCheckReport } from "../../src/actions/checkUpdates.js";
import type { LockEntry, Skill } from "../../src/state/types.js";

function skill(name: string, entry: Partial<LockEntry> = {}): Skill {
  return {
    id: JSON.stringify(["/selected", name]), name, enabled: true, orphaned: false, path: `/selected/${name}`,
    entryKind: "directory", linkTarget: null, warnings: [], authors: [], frontmatter: null, recordedSource: null,
    lockEntry: {
      source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
      skillPath: `skills/${name}/SKILL.md`, skillFolderHash: "a".repeat(40),
      installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...entry,
    },
    provenance: { kind: "source", source: "owner/repository", sourceUrl: "https://github.com/owner/repository.git" },
  };
}

const changed = { stdout: "Checking for skill updates…\n↑ smcheck has an update\n1 skill(s) can be updated\n", stderr: "" };

describe("explicit update checks", () => {
  it("uses an isolated lock and reports a confirmed content change for the selected identity", async () => {
    const target = skill("example", { ref: "release" });
    let workspace = "";
    const report = await checkForUpdates([target], async (root, args) => {
      workspace = root;
      expect(args).toEqual(["check", "--global"]);
      const lock = JSON.parse(await readFile(path.join(root, "state", "skills", ".skill-lock.json"), "utf8"));
      expect(lock.skills.smcheck).toEqual(target.lockEntry);
      expect(await readFile(path.join(root, "home", ".agents", "skills", "smcheck", "SKILL.md"), "utf8")).toContain("name: smcheck");
      return changed;
    }, async (selected, entry) => {
      expect(selected).toBe(target);
      expect(entry).toBe(target.lockEntry);
      return false;
    });
    expect(report).toEqual({ updated: [target.id], unavailable: [] });
    await expect(readFile(path.join(workspace, "state", "skills", ".skill-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("suppresses a stale recorded baseline when staged content matches installed content", async () => {
    expect(await checkForUpdates([skill("same")], async () => changed, async () => true)).toEqual({ updated: [], unavailable: [] });
  });

  it("treats a normal up-to-date result as current", async () => {
    const report = await checkForUpdates([skill("current")], async () => ({ stdout: "✓ All global skills are up to date\n", stderr: "" }), async () => { throw new Error("must not stage"); });
    expect(report).toEqual({ updated: [], unavailable: [] });
  });

  it("does not accept an up-to-date summary after a CLI failure", async () => {
    const report = await checkForUpdates([skill("failed")], async () => ({ stdout: "✗ Failed to check skills from owner/repository\n✓ All global skills are up to date\n", stderr: "" }));
    expect(report.unavailable[0].reason).toMatch(/could not check/);
  });

  it("does not accept an update marker alongside a CLI failure", async () => {
    const report = await checkForUpdates([skill("failed")], async () => ({ stdout: `${changed.stdout}✗ Failed to check skills from owner/repository`, stderr: "" }), async () => false);
    expect(report.updated).toEqual([]);
    expect(report.unavailable[0].reason).toMatch(/could not check/);
  });

  it("reports sandbox and staging errors instead of claiming current", async () => {
    const first = await checkForUpdates([skill("sandbox")], async () => { throw new Error("sandbox unavailable"); });
    const second = await checkForUpdates([skill("staging")], async () => changed, async () => { throw new Error("staging failed"); });
    expect(first.unavailable[0].reason).toBe("sandbox unavailable");
    expect(second.unavailable[0].reason).toBe("staging failed");
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
      return changed;
    }, async () => false);
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
    const pending = checkForUpdates([first, second], async () => changed, async (selected) => {
      if (selected === first) await gate;
      return false;
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
    const unsupported = skill("unsupported", { sourceType: "git" });
    const unchanged = skill("unchanged");
    const failed = skill("failed");
    const snapshots: UpdateCheckReport[] = [];
    const report = await checkForUpdates([unsupported, unchanged, failed], async (workspace) => {
      const lock = JSON.parse(await readFile(path.join(workspace, "state", "skills", ".skill-lock.json"), "utf8"));
      if (lock.skills.smcheck.skillPath.includes("failed")) throw new Error("check failed");
      return changed;
    }, async () => true, (snapshot) => snapshots.push(snapshot));

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].unavailable).toEqual([{ id: unsupported.id, name: unsupported.name, reason: "Update checks are not supported for this source.", category: "unknown" }]);
    expect(report).toEqual({
      updated: [],
      unavailable: [
        { id: unsupported.id, name: unsupported.name, reason: "Update checks are not supported for this source.", category: "unknown" },
        { id: failed.id, name: failed.name, reason: "check failed", category: "failed" },
      ],
    });
    expect(snapshots[2]).toEqual(report);
  });

  it("propagates progress callback failures without treating them as check failures", async () => {
    const error = new Error("progress failed");
    await expect(checkForUpdates([skill("unsupported", { sourceType: "git" })], undefined, undefined, () => {
      throw error;
    })).rejects.toBe(error);
  });

  it("does not report progress for an empty skill list", async () => {
    let calls = 0;
    expect(await checkForUpdates([], undefined, undefined, () => { calls++; })).toEqual({ updated: [], unavailable: [] });
    expect(calls).toBe(0);
  });

  it("does not invoke the CLI for unsupported or unassociated entries", async () => {
    const unknown = { ...skill("unknown"), lockEntry: null, provenance: { kind: "unknown" } as const };
    const report = await checkForUpdates([unknown, skill("missing", { skillFolderHash: "" }), skill("other", { sourceType: "git" })], async () => { throw new Error("must not run"); });
    expect(report.updated).toEqual([]);
    expect(report.unavailable.map((item) => item.name)).toEqual(["unknown", "missing", "other"]);
  });
});
