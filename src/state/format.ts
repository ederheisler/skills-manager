import type { Provenance, Skill } from "./types.js";

export function formatProvenance(provenance: Provenance): string {
  return provenance.kind === "source" ? `from repo ${provenance.source}` : provenance.kind === "local" ? "local path" : "repository not recorded";
}

export function skillsShUrl(source: string): string {
  return `https://skills.sh/${source}`;
}


export function formatSkillSource(skill: Skill): string {
  if (skill.provenance.kind === "unknown") return "Repository: not recorded";
  if (skill.provenance.kind === "local") return "Repository: local path";
  const { source, sourceUrl } = skill.provenance;
  return `Repository: ${source} · ${sourceUrl.replace(/\.git$/, "")}`;
}

export function formatSkillLine(skill: Skill): string {
  if (skill.orphaned) {
    return `[!!!] ${skill.name} - ${formatProvenance(skill.provenance)} (orphaned import record, no folder)`;
  }
  const badge = skill.enabled ? "[on] " : "[off]";
  return `${badge} ${skill.name} - ${formatProvenance(skill.provenance)}`;
}
