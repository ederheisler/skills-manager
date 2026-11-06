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
  it("groups unknown provenance with local without changing its metadata", () => {
    const local = skill("local", "A local skill");
    const remote = catalogSkill("catalog", "A catalog skill");
    const unknown: Skill = { ...skill("unknown", "Unknown origin"), authors: ["Recorded author"], provenance: { kind: "unknown" } };
    const orphan: Skill = { ...skill("orphan", "Missing folder"), provenance: { kind: "unknown" }, orphaned: true, path: "", entryKind: "orphaned", warnings: ["Missing folder"] };
    const all = [local, remote, unknown, orphan];
    const before = structuredClone(all);

    expect(filterSkills(all, "", "all")).toEqual(all);
    expect(filterSkills(all, "", "local")).toEqual([local, unknown, orphan]);
    expect(filterSkills(all, "", "source")).toEqual([remote]);
    expect(all).toEqual(before);
    expect(unknown.provenance.kind).toBe("unknown");
    expect(unknown.authors).toEqual(["Recorded author"]);
    expect(orphan.orphaned).toBe(true);
    expect(orphan.warnings).toEqual(["Missing folder"]);
  });

  it("intersects category, disabled state, and query", () => {
    const local = { ...skill("local", "Shared description"), enabled: false };
    const unknown: Skill = { ...skill("unknown", "Shared description"), enabled: false, provenance: { kind: "unknown" } };
    const remote = { ...catalogSkill("remote", "Shared description"), enabled: false };
    const enabled = skill("enabled", "Shared description");
    const all = [local, unknown, remote, enabled];

    expect(filterSkills(all, "shared", "local", "disabled")).toEqual([local, unknown]);
    expect(filterSkills(all, "shared", "source", "disabled")).toEqual([remote]);
    expect(filterSkills(all, "unknown", "local", "disabled")).toEqual([unknown]);
  });
});

describe("enabled state", () => {
  const skills = [skill("enabled", "An enabled skill"), { ...skill("disabled", "A disabled skill"), enabled: false }];

  it("filters enabled and disabled skills separately", () => {
    expect(filterSkills(skills, "", "all", "enabled")).toEqual([skills[0]]);
    expect(filterSkills(skills, "", "all", "disabled")).toEqual([skills[1]]);
  });
});
