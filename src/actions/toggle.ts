import { moveReviewedSkill, type ApprovedSkillsRoot } from "./boundary.js";

/** Move the exact reviewed entry into the selected directory's disabled area. */
export async function disableSkill(root: ApprovedSkillsRoot, name: string, expectedVersion: string): Promise<void> {
  await moveReviewedSkill(root, name, expectedVersion, "disable");
}

/** Restore the exact reviewed disabled entry without replacing an active entry. */
export async function enableSkill(root: ApprovedSkillsRoot, name: string, expectedVersion: string): Promise<void> {
  await moveReviewedSkill(root, name, expectedVersion, "enable");
}
