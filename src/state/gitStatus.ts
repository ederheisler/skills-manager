import { getStatus } from "../actions/git.js";

/** Git failures are errors, not a clean working tree. */
export async function countGitStatusLines(skillsDir: string): Promise<number> {
  return (await getStatus(skillsDir)).length;
}
