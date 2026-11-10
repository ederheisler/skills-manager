import { mkdir, mkdtemp, realpath, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LockEntry, Skill } from "../state/types.js";
import { validSourceEntry } from "../state/upstreamProvenance.js";
import { directoryIdentity, removeDisposableTree } from "./boundary.js";
import { runConfinedSkills } from "./sandbox.js";

export interface UpdateCheckReport {
  updated: string[];
  unavailable: Array<{ id: string; name: string; reason: string; category?: "unknown" | "failed" }>;
}

type CheckRunner = (workspace: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
class UnknownUpdateStatus extends Error {}

function validCheckName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && name !== ".git"
    && name !== ".disabled_skills" && name !== ".skills-manager" && name === name.trim()
    && Buffer.byteLength(name) <= 255 && !/[\/\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name);
}

async function checkOne(skill: Skill, entry: LockEntry, run: CheckRunner): Promise<"updated" | "same"> {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-check-")));
  let identity: string;
  try { identity = await directoryIdentity(workspace); }
  catch (error) {
    try { await rmdir(workspace); } catch (cleanup) { throw new Error(`Cannot identify check workspace; cleanup failed: ${String(cleanup)}`); }
    throw error;
  }
  try {
    await Promise.all(["home", "config", "cache", "data", "state", "tmp"].map((name) => mkdir(path.join(workspace, name))));
    const placeholder = path.join(workspace, "home", ".agents", "skills", skill.name);
    const state = path.join(workspace, "state", "skills");
    await Promise.all([mkdir(placeholder, { recursive: true }), mkdir(state, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(placeholder, "SKILL.md"), `---\nname: ${JSON.stringify(skill.name)}\ndescription: Temporary update check\n---\n`),
      writeFile(path.join(state, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { [skill.name]: entry } })),
    ]);
    const result = await run(workspace, ["check", "--global"]);
    const lines = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .split(/[\r\n]+/).map((line) => line.trim());
    const failure = lines.find((line) =>
      /^✗ Failed to check (?:for deleted )?skills from /.test(line)
      || /^Warning: The following skills from .* appear to have been deleted upstream:$/.test(line)
      || /^Warning: Multiple current paths match these skills from .*; skipping them rather than deleting or migrating the wrong skill:$/.test(line)
      || /^\d+ skill\(s\) cannot be checked automatically:$/.test(line)
      || line === "Skipping deletion in non-interactive mode.");
    if (failure) throw new Error(`The skills CLI could not check the recorded source reliably: ${failure.slice(0, 500)}`);
    const marker = `↑ ${skill.name} has an update`;
    const updated = lines.includes(marker);
    const current = lines.includes("✓ All global skills are up to date");
    const unexpectedUpdate = lines.some((line) => line.startsWith("↑ ") && line.endsWith(" has an update") && line !== marker);
    if (updated === current || unexpectedUpdate) {
      throw new UnknownUpdateStatus("The skills CLI did not confirm an unambiguous update status; the upstream status is unknown.");
    }
    return updated ? "updated" : "same";
  } finally {
    await removeDisposableTree(workspace, identity);
  }
}

/** A failed or ambiguous check is not an up-to-date result. */
export async function checkForUpdates(
  skills: readonly Skill[],
  run: CheckRunner = runConfinedSkills,
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
      const entry = skill.recordedSource;
      if (!skill.lockEntry || skill.provenance.kind !== "source") {
        unavailable("No matching saved source association; update checks are unavailable.");
      } else if (!entry) {
        unavailable("The skills CLI does not track this skill.");
      } else if (entry.sourceType === "local" || !validSourceEntry(entry)) {
        unavailable("Update checks are not supported for this source.");
      } else if (!validCheckName(skill.name)) {
        unavailable("The skill name cannot be safely matched by the skills CLI.");
      } else if (entry.skillPath && (path.win32.isAbsolute(entry.skillPath) || entry.skillPath.includes("\\")
        || entry.skillPath.split("/").some((part) => !part || part === "." || part === ".."))) {
        unavailable("The saved source has an unsafe skill path.");
      } else {
        try {
          if (await checkOne(skill, entry, run) === "updated") report.updated.push(skill.id);
        } catch (error) {
          unavailable(error instanceof Error ? error.message : "Upstream check failed.", error instanceof UnknownUpdateStatus ? "unknown" : "failed");
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
