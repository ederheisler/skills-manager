import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSkillText, scanSkills } from "../../src/state/repo.js";

let workspace: string;
let skillsDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "skills-frontmatter-"));
  skillsDir = path.join(workspace, "skills");
});

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__skillManagerExecuted;
  await rm(workspace, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<void> {
  const dir = path.join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), content);
}

function document(metadata: string): string {
  return `---\n${metadata}\n---\n# Body`;
}

describe("inert skill frontmatter", () => {
  it("never executes a frontmatter engine or unsupported executable tag on scan or preview", async () => {
    const sentinel = path.join(workspace, "sentinel");
    await writeFile(sentinel, "unchanged");
    const executable = `---js\n(function(){require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'changed');globalThis.__skillManagerExecuted=true;return {name:'bad'}})()\n---\n# Body`;
    const tagged = document("name: !!js/function >\n  function () { globalThis.__skillManagerExecuted = true; }");
    await fixture("engine", executable);
    await fixture("tag", tagged);
    const skills = await scanSkills(skillsDir);
    expect(skills).toEqual([
      expect.objectContaining({ name: "engine", frontmatter: null, warnings: [expect.any(String)] }),
      expect.objectContaining({ name: "tag", frontmatter: null, warnings: [expect.any(String)] }),
    ]);
    expect(await readSkillText(path.join(skillsDir, "engine"))).toBe(executable);
    expect(await readSkillText(path.join(skillsDir, "tag"))).toBe(tagged);
    expect((globalThis as Record<string, unknown>).__skillManagerExecuted).toBeUndefined();
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  });

  it("parses ordinary data-only YAML including names, multiline text, and aliases", async () => {
    await fixture("normal", document("name: normal\nauthors: [Ada, Grace]\ndescription: >-\n  A useful\n  skill.\nmetadata:\n  shared: &base [one, two]\n  same: *base"));
    const [skill] = await scanSkills(skillsDir);
    expect(skill.frontmatter).toMatchObject({ name: "normal", description: "A useful skill.", metadata: { same: ["one", "two"] } });
    expect(skill.authors).toEqual(["Ada", "Grace"]);
    expect(skill.warnings).toEqual([]);
    expect(await readSkillText(path.join(skillsDir, "normal"))).toBe("# Body");
  });

  it("accepts 64 KiB metadata and rejects one extra byte", async () => {
    const atLimit = "description: " + "x".repeat(65_536 - "description: ".length - 1);
    await fixture("at-limit", document(atLimit));
    await fixture("over-limit", document(`${atLimit}x`));
    const [good, bad] = await scanSkills(skillsDir);
    expect(good.frontmatter?.description).toHaveLength(65_536 - "description: ".length - 1);
    expect(good.warnings).toEqual([]);
    expect(bad.frontmatter).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/64\s*KiB/i);
  });

  it("accepts 50 collection levels and rejects deeper input", async () => {
    const nesting = (count: number) => `value: ${"[".repeat(count)}x${"]".repeat(count)}`;
    await fixture("at-limit", document(nesting(49)));
    await fixture("over-limit", document(nesting(50)));
    const [good, bad] = await scanSkills(skillsDir);
    expect(good.frontmatter).not.toBeNull();
    expect(bad.frontmatter).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/depth|nest/i);
  });

  it("rejects extreme nesting before composing or expanding the document", async () => {
    const nested = document(`value: ${"[".repeat(10_000)}x${"]".repeat(10_000)}`);
    await fixture("deep", nested);
    const [skill] = await scanSkills(skillsDir);
    expect(skill.frontmatter).toBeNull();
    expect(skill.warnings.join(" ")).toMatch(/depth|nest/i);
    await expect(readSkillText(path.join(skillsDir, "deep"))).resolves.toBe(nested);
  });

  it("accepts 100 aliases and rejects an additional alias", async () => {
    const aliases = (count: number) => `base: &base value\nitems: [${Array(count).fill("*base").join(", ")}]`;
    await fixture("at-limit", document(aliases(100)));
    await fixture("over-limit", document(aliases(101)));
    const [good, bad] = await scanSkills(skillsDir);
    expect(good.frontmatter?.items).toHaveLength(100);
    expect(bad.frontmatter).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/alias/i);
  });

  it("accepts 1 MiB expanded metadata and rejects a single extra byte", async () => {
    const payload = "x".repeat(10_370);
    const unpadded = JSON.stringify({ payload, items: Array(100).fill(payload), pad: "" });
    const pad = "p".repeat(1_048_576 - Buffer.byteLength(unpadded));
    const metadata = (extra: string) => `payload: &p ${payload}\nitems: [${Array(100).fill("*p").join(", ")}]\npad: ${pad}${extra}`;
    await fixture("at-limit", document(metadata("")));
    await fixture("over-limit", document(metadata("p")));
    const [good, bad] = await scanSkills(skillsDir);
    expect(good.frontmatter?.payload).toBe(payload);
    expect(bad.frontmatter).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/expand|MiB/i);
  });

  it("rejects cyclic aliases without expanding them", async () => {
    await fixture("cycle", document("value: &loop { next: *loop }"));
    const [skill] = await scanSkills(skillsDir);
    expect(skill.frontmatter).toBeNull();
    expect(skill.warnings.join(" ")).toMatch(/cycl/i);
  });
});
