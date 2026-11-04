import { describe, expect, it } from "vitest";
import { formatProvenance, formatSkillLine, formatSkillSource, skillsShUrl } from "../../src/state/format.js";
import type { Skill } from "../../src/state/types.js";

function skill(name: string, provenance: Skill["provenance"]): Skill {
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
    frontmatter: null,
    lockEntry: null,
    recordedSource: null,
    provenance,
  };
}

describe("formatProvenance", () => {
  it("does not imply that a local or unknown skill belongs to the user", () => {
    expect(formatProvenance({ kind: "source", source: "cursor/plugins", sourceUrl: "https://github.com/cursor/plugins.git" })).toBe("from cursor/plugins");
    expect(formatProvenance({ kind: "local" })).toBe("local");
    expect(formatProvenance({ kind: "unknown" })).toBe("unknown");
  });
});

describe("formatSkillSource", () => {
  it("labels a catalog skill with its source and repository", () => {
    const formatted = formatSkillSource(skill("quota-axi", {
      kind: "source",
      source: "kunchenguid/quota-axi",
      sourceUrl: "https://github.com/kunchenguid/quota-axi.git",
    }));
    expect(formatted).toBe("Source: https://skills.sh/kunchenguid/quota-axi · https://github.com/kunchenguid/quota-axi");
  });

  it("distinguishes confirmed local source from unknown source", () => {
    expect(formatSkillSource(skill("wago", { kind: "local" }))).toBe("Source: local");
    expect(formatSkillSource(skill("manual", { kind: "unknown" }))).toBe("Source: unknown");
  });
});

describe("skillsShUrl", () => {
  it("uses the catalog source", () => {
    expect(skillsShUrl("kunchenguid/quota-axi")).toBe("https://skills.sh/kunchenguid/quota-axi");
  });
});

describe("formatSkillLine", () => {
  it("includes the enabled badge, name, and CLI source", () => {
    expect(formatSkillLine(skill("quota-axi", {
      kind: "source",
      source: "kunchenguid/quota-axi",
      sourceUrl: "https://github.com/kunchenguid/quota-axi.git",
    }))).toBe("[on]  quota-axi - from kunchenguid/quota-axi");
  });

  it("labels a stale import receipt without claiming source or ownership", () => {
    const orphan: Skill = { ...skill("missing", { kind: "unknown" }), enabled: false, orphaned: true, path: "", entryKind: "orphaned" };
    expect(formatSkillLine(orphan)).toBe("[!!!] missing - unknown (orphaned import record, no folder)");
  });
});
