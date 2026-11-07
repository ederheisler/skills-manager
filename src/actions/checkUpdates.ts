import { mkdir, mkdtemp, readdir, realpath, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LockEntry, Skill } from "../state/types.js";
import { validSourceEntry } from "../state/upstreamProvenance.js";
import { approveSkillsRoot, directoryIdentity, gitTreeHash, removeDisposableTree } from "./boundary.js";
import { runConfinedSkills } from "./sandbox.js";
import { discardPreparedChange } from "./skillsCli.js";
import { prepareUpdate } from "./update.js";

export interface UpdateCheckReport {
  updated: string[];
  unavailable: Array<{ id: string; name: string; reason: string; category?: "unknown" | "failed" }>;
}

type CheckRunner = (workspace: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
type CompareInstalled = (skill: Skill, entry: LockEntry) => Promise<boolean>;
class UnknownUpdateStatus extends Error {}

async function matchesStagedContent(skill: Skill, entry: LockEntry): Promise<boolean> {
  const root = skill.enabled ? path.dirname(skill.path) : path.dirname(path.dirname(skill.path));
  const approved = await approveSkillsRoot(root);
  const prepared = await prepareUpdate(approved, skill, entry);
  try {
    const stagedRoot = path.join(prepared.workspace, "home", ".agents", "skills");
    const names = await readdir(stagedRoot);
    if (names.length !== 1) throw new Error("The staged update did not identify exactly one skill.");
    const [installed, staged] = await Promise.all([gitTreeHash(skill.path), gitTreeHash(path.join(stagedRoot, names[0]))]);
    return installed === staged;
  } finally {
    await discardPreparedChange(prepared);
  }
}

async function checkOne(skill: Skill, entry: LockEntry, run: CheckRunner, compare: CompareInstalled): Promise<"updated" | "same"> {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-check-")));
  let identity: string;
  try { identity = await directoryIdentity(workspace); }
  catch (error) {
    try { await rmdir(workspace); } catch (cleanup) { throw new Error(`Cannot identify check workspace; cleanup failed: ${String(cleanup)}`); }
    throw error;
  }
  try {
    await Promise.all(["home", "config", "cache", "data", "state", "tmp"].map((name) => mkdir(path.join(workspace, name))));
    const placeholder = path.join(workspace, "home", ".agents", "skills", "smcheck");
    const state = path.join(workspace, "state", "skills");
    await Promise.all([mkdir(placeholder, { recursive: true }), mkdir(state, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(placeholder, "SKILL.md"), "---\nname: smcheck\ndescription: Temporary update check\n---\n"),
      writeFile(path.join(state, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { smcheck: entry } })),
    ]);
    const result = await run(workspace, ["check", "--global"]);
    const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const failure = output.split(/[\r\n]+/).find((line) => /failed|cannot be checked|appear to have been deleted|multiple current paths|skipping deletion/i.test(line));
    if (failure) throw new Error(`The skills CLI could not check the recorded source reliably: ${failure.trim().slice(0, 500)}`);
    if (/(?:^|\n)\s*✓ All global skills are up to date\s*(?:\n|$)/.test(output)) return "same";
    if (!/(?:^|\n)\s*↑ smcheck has an update\s*(?:\n|$)/.test(output)) {
      throw new UnknownUpdateStatus("The skills CLI did not confirm an update; the upstream status is unknown.");
    }
    return await compare(skill, entry) ? "same" : "updated";
  } finally {
    await removeDisposableTree(workspace, identity);
  }
}

/** A failed or ambiguous check is not an up-to-date result. */
export async function checkForUpdates(
  skills: readonly Skill[],
  run: CheckRunner = runConfinedSkills,
  compare: CompareInstalled = matchesStagedContent,
  onProgress?: (report: UpdateCheckReport) => void,
): Promise<UpdateCheckReport> {
  const results: UpdateCheckReport[] = new Array(skills.length);
  const accumulated = (): UpdateCheckReport => ({
    updated: results.flatMap((report) => report.updated),
    unavailable: results.flatMap((report) => report.unavailable),
  });
  let next = 0;
  let progressFailed = false;
  const worker = async () => {
    while (!progressFailed) {
      const index = next++;
      if (index >= skills.length) return;
      const skill = skills[index];
      const report: UpdateCheckReport = { updated: [], unavailable: [] };
      const unavailable = (reason: string, category: "unknown" | "failed" = "unknown") => report.unavailable.push({ id: skill.id, name: skill.name, reason, category });
      const entry = skill.lockEntry;
      if (!entry || skill.provenance.kind !== "source") {
        unavailable("No matching saved source association; update checks are unavailable.");
      } else if (entry.sourceType !== "github" || !validSourceEntry(entry)) {
        unavailable("Update checks are not supported for this source.");
      } else {
        const parts = entry.skillPath.replace(/\\/g, "/").split("/");
        if (!entry.skillPath || parts.some((part) => !part || part === "." || part === "..") || !/^[a-f0-9]{40}$/i.test(entry.skillFolderHash)) {
          unavailable("No verifiable upstream content baseline is recorded.");
        } else {
          try {
            if (await checkOne(skill, entry, run, compare) === "updated") report.updated.push(skill.id);
          } catch (error) {
            unavailable(error instanceof Error ? error.message : "Upstream check failed.", error instanceof UnknownUpdateStatus ? "unknown" : "failed");
          }
        }
      }
      results[index] = report;
      if (onProgress && !progressFailed) {
        try {
          onProgress(accumulated());
        } catch (error) {
          progressFailed = true;
          throw error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, skills.length) }, () => worker()));
  return accumulated();
}
