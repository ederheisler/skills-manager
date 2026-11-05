import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readInstalledSource, validSourceEntry } from "../state/upstreamProvenance.js";
import type { LockEntry, Skill } from "../state/types.js";
import { assertApprovedSkillsRoot, type ApprovedSkillsRoot } from "./boundary.js";
import { prepareSourceChange, type PreparedSkillChange } from "./skillsCli.js";

/** Prepare an explicitly selected source, including for an adopted skill with unknown provenance. */
export function prepareReplacement(root: ApprovedSkillsRoot, skill: Skill, source: string): Promise<PreparedSkillChange> {
  return prepareSourceChange(root, source, skill);
}

/** Contact only the exact saved source entry the user has just approved. */
export async function prepareUpdate(root: ApprovedSkillsRoot, skill: Skill, approvedEntry: LockEntry): Promise<PreparedSkillChange> {
  const approval = structuredClone(approvedEntry);
  await assertApprovedSkillsRoot(root);
  const entry = await readInstalledSource(root.path, skill.path, skill.name, root);
  if (!entry || entry.sourceType === "local" || !validSourceEntry(entry)) {
    throw new Error("Update requires a valid saved remote source association. Select a source to review a replacement instead.");
  }
  if (!isDeepStrictEqual(entry, approval)) {
    throw new Error("The saved source changed since approval. Review it again before updating.");
  }
  let source = entry.sourceUrl;
  if (entry.sourceType === "github" && entry.skillPath) {
    if (path.win32.isAbsolute(entry.skillPath) || entry.skillPath.includes("\\")
      || entry.skillPath.split("/").some((part) => !part || part === ".." || part === ".")) {
      throw new Error("The saved source has an unsafe skill path. Select a source to review a replacement instead.");
    }
    const folder = entry.skillPath.replace(/\/?SKILL\.md$/i, "").replace(/\/$/, "");
    if (folder) source = `${entry.source}/${folder}`;
  }
  if (entry.ref) source += `#${encodeURIComponent(entry.ref)}`;
  return prepareSourceChange(root, source, skill, { ref: entry.ref });
}
