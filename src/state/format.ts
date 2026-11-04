import type { Provenance, Skill } from "./types.js";

export function formatProvenance(provenance: Provenance): string {
  return provenance.kind === "source" ? `from ${provenance.source}` : provenance.kind;
}

export function skillsShUrl(source: string): string {
  return `https://skills.sh/${source}`;
}


export function formatSkillSource(skill: Skill): string {
  if (skill.provenance.kind === "unknown") return "Source: unknown";
  if (skill.provenance.kind === "local") return "Source: local";
  const { source, sourceUrl } = skill.provenance;
  return `Source: ${skillsShUrl(source)} · ${sourceUrl.replace(/\.git$/, "")}`;
}

export function formatSkillLine(skill: Skill): string {
  if (skill.orphaned) {
    return `[!!!] ${skill.name} - ${formatProvenance(skill.provenance)} (orphaned import record, no folder)`;
  }
  const badge = skill.enabled ? "[on] " : "[off]";
  return `${badge} ${skill.name} - ${formatProvenance(skill.provenance)}`;
}
