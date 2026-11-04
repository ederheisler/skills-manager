import { deleteReviewedSkill, type ApprovedSkillsRoot } from "./boundary.js";

/** Remove only the path and version explicitly confirmed by the caller. */
export async function removeManagedSkill(root: ApprovedSkillsRoot, name: string, expectedPath: string, expectedVersion: string): Promise<void> {
  await deleteReviewedSkill(root, name, expectedPath, expectedVersion);
}
