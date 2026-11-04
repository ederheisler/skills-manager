import { describe, it, expect } from "vitest";
import { filterSkills } from "../../src/state/filter.js";
import type { Skill } from "../../src/state/types.js";

function skill(name: string, description: string): Skill {
  return {
    id: `/agent/skills/${name}`,
    name,
    enabled: true,
    orphaned: false,
    path: `/agent/skills/${name}`,
    entryKind: "directory",
    linkTarget: null,
    warnings: [],
    authors: [],
    frontmatter: { name, description },
    lockEntry: null,
    recordedSource: null,
    provenance: { kind: "local" },
  };
}

function catalogSkill(name: string, description: string): Skill {
  return { ...skill(name, description), provenance: { kind: "source", source: "owner/repository", sourceUrl: "https://github.com/owner/repository.git" } };
}

describe("filterSkills", () => {
  const skills = [skill("astro", "Build Astro sites"), skill("research", "Investigate a question")];

  it("returns everything for an empty query", () => {
    expect(filterSkills(skills, "")).toEqual(skills);
  });

  it("matches on name, case-insensitively", () => {
    expect(filterSkills(skills, "ASTRO")).toEqual([skills[0]]);
  });

  it("matches on description", () => {
    expect(filterSkills(skills, "question")).toEqual([skills[1]]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSkills(skills, "nonexistent")).toEqual([]);
  });
});

describe("source scope", () => {
  const skills = [skill("local", "A local skill"), catalogSkill("catalog", "A catalog skill")];

  it("keeps unknown, local and remote provenance separate", () => {
    const unknown = { ...skill("unknown", "Unknown origin"), provenance: { kind: "unknown" as const } };
    const all = [...skills, unknown];
    expect(filterSkills(all, "", "all")).toEqual(all);
    expect(filterSkills(all, "", "local")).toEqual([skills[0]]);
    expect(filterSkills(all, "", "source")).toEqual([skills[1]]);
    expect(filterSkills(all, "", "unknown")).toEqual([unknown]);
  });
});

describe("enabled state", () => {
  const skills = [skill("enabled", "An enabled skill"), { ...skill("disabled", "A disabled skill"), enabled: false }];

  it("filters enabled and disabled skills separately", () => {
    expect(filterSkills(skills, "", "all", "enabled")).toEqual([skills[0]]);
    expect(filterSkills(skills, "", "all", "disabled")).toEqual([skills[1]]);
  });
});
