import type { LockEntry, Skill } from "../state/types.js";
import type { ApprovedSkillsRoot } from "./boundary.js";
import { prepareCliUpdates, prepareSourceChange, type PreparedSkillChange } from "./skillsCli.js";

/** Prepare an explicitly selected source, including for an adopted skill with unknown provenance. */
export function prepareReplacement(root: ApprovedSkillsRoot, skill: Skill, source: string): Promise<PreparedSkillChange> {
  return prepareSourceChange(root, source, skill);
}

/** Let the installed CLI decide and prepare all selected updates together. */
export function prepareUpdates(root: ApprovedSkillsRoot, skills: readonly Skill[]): Promise<PreparedSkillChange> {
  const snapshots = skills.map((skill) => ({ ...skill, lockEntry: skill.lockEntry ? structuredClone(skill.lockEntry) : null }));
  return prepareCliUpdates(root, snapshots);
}

export function prepareUpdate(root: ApprovedSkillsRoot, skill: Skill, approvedEntry: LockEntry): Promise<PreparedSkillChange> {
  return prepareUpdates(root, [{ ...skill, lockEntry: structuredClone(approvedEntry) }]);
}
