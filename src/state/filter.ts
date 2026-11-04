import type { Skill } from "./types.js";

export type SkillScope = "all" | "local" | "source" | "unknown";
export type SkillState = "all" | "enabled" | "disabled";

export function filterSkills(skills: Skill[], query: string, scope: SkillScope = "all", state: SkillState = "all"): Skill[] {
  const normalized = query.trim().toLowerCase();
  const scoped = skills.filter((skill) =>
    (scope === "all" || skill.provenance.kind === scope)
    && (state === "all" || (state === "enabled" ? skill.enabled : !skill.enabled))
  );

  if (normalized === "") return scoped;

  return scoped.filter((skill) => {
    const name = skill.name.toLowerCase();
    const description = (skill.frontmatter?.description ?? "").toLowerCase();
    return name.includes(normalized) || description.includes(normalized);
  });
}
