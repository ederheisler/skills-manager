import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstat, mkdtemp, mkdir, writeFile, readFile, readlink, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { countSkillFileLines, listSkillFiles, readSkillFile, readSkillSource, readSkillText, resolvePaths, scanSkills } from "../../src/state/repo.js";

const execFile = promisify(execFileCallback);

let workspace: string;
let agentRoot: string;

async function writeSkill(dir: string, name: string, frontmatter: string) {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), frontmatter, "utf8");
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "skills-manager-repo-"));
  agentRoot = path.join(workspace, "skills");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});


describe("listSkillFiles", () => {
  it("omits empty directories while retaining directories with visible files", async () => {
    const skillPath = path.join(agentRoot, "skill");
    await mkdir(path.join(skillPath, "empty", "nested"), { recursive: true });
    await mkdir(path.join(skillPath, "references"), { recursive: true });
    await writeFile(path.join(skillPath, "references", "notes.txt"), "Notes", "utf8");

    await expect(listSkillFiles(skillPath)).resolves.toEqual([
      { path: "references", depth: 0, kind: "directory" },
      { path: path.join("references", "notes.txt"), depth: 1, kind: "file" },
    ]);
  });

  it.skipIf(process.platform !== "linux")("refuses non-UTF-8 nested filenames instead of aliasing a valid name", async () => {
    const skillPath = path.join(agentRoot, "skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(path.join(skillPath, "file-\uFFFD"), "valid");
    const invalid = Buffer.concat([Buffer.from(`${skillPath}/file-`), Buffer.from([0xff])]);
    await writeFile(invalid, "invalid");

    await expect(listSkillFiles(skillPath)).rejects.toThrow(/utf-?8/i);
    expect(await readFile(invalid, "utf8")).toBe("invalid");
    expect(await readFile(path.join(skillPath, "file-\uFFFD"), "utf8")).toBe("valid");
  });
});

describe("scanSkills", () => {
  it("returns no skills for a missing installation without creating it", async () => {
    await expect(scanSkills(agentRoot)).resolves.toEqual([]);
    await expect(lstat(agentRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an empty selected directory instead of treating the working directory as an installation", async () => {
    expect(() => resolvePaths("")).toThrow();
    await expect(scanSkills("")).rejects.toThrow();
  });

  it("reports a broken selected-directory link instead of treating it as an empty new installation", async () => {
    await symlink("absent", agentRoot);
    await expect(scanSkills(agentRoot)).rejects.toThrow(/symbolic link/i);
    expect(await readlink(agentRoot)).toBe("absent");
  });

  it.each(["active", "disabled"])("refuses non-UTF-8 names in the %s root without aliasing a valid skill", async (location) => {
    if (process.platform !== "linux") return;
    const directory = location === "active" ? agentRoot : path.join(agentRoot, ".disabled_skills");
    await writeSkill(directory, "skill-\uFFFD", "# Valid");
    const invalid = Buffer.concat([Buffer.from(`${directory}/skill-`), Buffer.from([0xff])]);
    await mkdir(invalid);

    await expect(scanSkills(agentRoot)).rejects.toThrow(/utf-?8/i);
    expect((await lstat(invalid)).isDirectory()).toBe(true);
    expect(await readFile(path.join(directory, "skill-\uFFFD", "SKILL.md"), "utf8")).toBe("# Valid");
  });

  it("excludes reserved metadata spelling aliases without hiding ordinary links", async () => {
    await writeSkill(agentRoot, ".GIT", "# Reserved");
    await writeSkill(workspace, "external", "# External");
    await symlink("../external", path.join(agentRoot, "linked"));

    const skills = await scanSkills(agentRoot);
    expect(skills.map((skill) => skill.name)).toEqual(["linked"]);
    expect(skills[0].entryKind).toBe("symlink");
    expect(await readFile(path.join(agentRoot, ".GIT", "SKILL.md"), "utf8")).toBe("# Reserved");
  });

  it("adopts direct skills, malformed and missing frontmatter, and disabled entries without moving them", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(paths.skillsDir, "valid", "---\nname: valid\nauthor: Ada\n---\n# Valid");
    await writeSkill(paths.skillsDir, "malformed", "---\nname: [\n---\n# Malformed");
    await writeSkill(paths.skillsDir, "manual", "# Manual skill with no metadata");
    await writeSkill(paths.disabledDir, "off", "---\nname: off\nauthors: [Ada, Grace]\n---\n# Off");
    await mkdir(path.join(paths.skillsDir, "notes", "nested"), { recursive: true });
    await writeFile(path.join(paths.skillsDir, "notes", "nested", "SKILL.md"), "nested only");
    await writeSkill(path.join(paths.skillsDir, ".git"), "not-a-skill", "---\nname: no\n---\n");
    const before = await readFile(path.join(paths.skillsDir, "manual", "SKILL.md"), "utf8");

    const skills = await scanSkills(agentRoot);
    expect(skills.map(({ name, enabled }) => [name, enabled])).toEqual([
      ["malformed", true], ["manual", true], ["off", false], ["valid", true],
    ]);
    expect(skills.find((s) => s.name === "valid")).toMatchObject({
      authors: ["Ada"], entryKind: "directory", linkTarget: null, warnings: [], provenance: { kind: "unknown" },
    });
    expect(skills.find((s) => s.name === "off")?.authors).toEqual(["Ada", "Grace"]);
    expect(skills.find((s) => s.name === "malformed")).toMatchObject({ frontmatter: null, warnings: [expect.any(String)] });
    expect(skills.find((s) => s.name === "manual")).toMatchObject({ frontmatter: null, warnings: [expect.any(String)] });
    expect(await readFile(path.join(paths.skillsDir, "manual", "SKILL.md"), "utf8")).toBe(before);
  });

  it("treats invalid author declarations as unknown without losing valid skill metadata", async () => {
    await writeSkill(agentRoot, "invalid-author", "---\nname: invalid-author\nauthor: 42\ndescription: A valid description\n---\n");
    const [skill] = await scanSkills(agentRoot);
    expect(skill.frontmatter?.description).toBe("A valid description");
    expect(skill.authors).toEqual([]);
    expect(skill.provenance).toEqual({ kind: "unknown" });
  });

  it("retains link text and exposes valid and broken links without changing targets", async () => {
    const target = path.join(workspace, "outside");
    await writeSkill(workspace, "outside", "---\nname: external\nauthor: Ada\n---\n# External");
    await mkdir(agentRoot, { recursive: true });
    await symlink("../outside", path.join(agentRoot, "linked"));
    await symlink("../absent", path.join(agentRoot, "broken"));
    const sentinel = await readFile(path.join(target, "SKILL.md"), "utf8");

    const skills = await scanSkills(agentRoot);
    expect(skills).toEqual([
      expect.objectContaining({ name: "broken", entryKind: "broken-symlink", linkTarget: "../absent", warnings: [expect.any(String)], provenance: { kind: "unknown" } }),
      expect.objectContaining({ name: "linked", entryKind: "symlink", linkTarget: "../outside", authors: ["Ada"], provenance: { kind: "unknown" } }),
    ]);
    await expect(readSkillText(path.join(agentRoot, "linked"))).resolves.toBe("# External");
    expect(await readlink(path.join(agentRoot, "linked"))).toBe("../outside");
    expect(await readlink(path.join(agentRoot, "broken"))).toBe("../absent");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(sentinel);
  });

  it("reports an SKILL.md child link without reading the link target", async () => {
    const outside = path.join(workspace, "outside.md");
    const content = "---\nname: outside\nauthor: Hidden\n---\n# Outside";
    await writeFile(outside, content);
    const dir = path.join(agentRoot, "linked-file");
    await mkdir(dir, { recursive: true });
    await symlink("../../outside.md", path.join(dir, "SKILL.md"));
    const [skill] = await scanSkills(agentRoot);
    expect(skill.frontmatter).toBeNull();
    expect(skill.authors).toEqual([]);
    expect(skill.warnings.join(" ")).toMatch(/symbolic link/i);
    expect(await readSkillText(dir)).toContain("../../outside.md");
    expect(await readFile(outside, "utf8")).toBe(content);
  });

  it("does not traverse a linked reserved disabled directory", async () => {
    const outside = path.join(workspace, "outside");
    await writeSkill(outside, "sentinel", "---\nname: sentinel\n---\n");
    await mkdir(agentRoot, { recursive: true });
    await symlink("../outside", path.join(agentRoot, ".disabled_skills"));
    const before = await readFile(path.join(outside, "sentinel", "SKILL.md"), "utf8");
    await expect(scanSkills(agentRoot)).rejects.toThrow(/disabled skills path/i);
    expect(await readlink(path.join(agentRoot, ".disabled_skills"))).toBe("../outside");
    expect(await readFile(path.join(outside, "sentinel", "SKILL.md"), "utf8")).toBe(before);
  });

  it("keeps local skills visible but warns about a reserved-state collision", async () => {
    await writeSkill(agentRoot, "visible", "---\nname: visible\n---\n");
    await writeSkill(path.join(agentRoot, ".skills-manager"), "recovery", "---\nname: not-a-skill\n---\n");
    const stateFile = path.join(agentRoot, ".skills-manager", "recovery", "SKILL.md");
    const before = await readFile(stateFile, "utf8");
    const skills = await scanSkills(agentRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("visible");
    expect(skills[0].warnings.join(" ")).toMatch(/controlled|state|metadata/i);
    expect(await readFile(stateFile, "utf8")).toBe(before);
  });

  it("keeps duplicate paths distinct but recognizes two selections of the same installation", async () => {
    await writeSkill(agentRoot, "duplicate", "---\nname: duplicate\n---\n");
    await writeSkill(path.join(agentRoot, ".disabled_skills"), "duplicate", "---\nname: duplicate\n---\n");
    const alias = path.join(workspace, "alias");
    await symlink("skills", alias);
    const originals = await scanSkills(agentRoot);
    const aliased = await scanSkills(alias);
    expect(originals).toHaveLength(2);
    expect(new Set(originals.map((skill) => skill.id)).size).toBe(2);
    expect(new Set(aliased.map((skill) => skill.id))).toEqual(new Set(originals.map((skill) => skill.id)));
    expect(originals.every((skill) => skill.provenance.kind === "unknown" && skill.lockEntry === null)).toBe(true);
    expect(originals.every((skill) => skill.warnings.some((warning) => /multiple entries|ambiguous/i.test(warning)))).toBe(true);

    const other = path.join(workspace, "other");
    await writeSkill(other, "duplicate", "---\nname: duplicate\n---\n");
    expect((await scanSkills(other))[0].id).not.toBe(originals[0].id);
  });

  it("inspects a nested Git repository without changing its worktree or index", async () => {
    await writeSkill(agentRoot, "nested-repo", "---\nname: nested-repo\n---\n# Skill");
    const skillPath = path.join(agentRoot, "nested-repo");
    await execFile("git", ["init", "-q", skillPath]);
    const before = (await execFile("git", ["-C", skillPath, "status", "--porcelain=v1"])).stdout;
    const skills = await scanSkills(agentRoot);
    expect(skills).toEqual([expect.objectContaining({ name: "nested-repo", entryKind: "directory" })]);
    expect((await execFile("git", ["-C", skillPath, "status", "--porcelain=v1"])).stdout).toBe(before);
  });

  it("refuses absolute and traversing previews and shows child-link text without following it", async () => {
    await writeSkill(agentRoot, "safe", "---\nname: safe\n---\n");
    const skillPath = path.join(agentRoot, "safe");
    const outside = path.join(workspace, "sentinel");
    await writeFile(outside, "private sentinel");
    await symlink("../../sentinel", path.join(skillPath, "link"));
    expect(await listSkillFiles(skillPath)).toContainEqual({ path: "link", depth: 0, kind: "file" });
    await expect(readSkillFile(skillPath, outside)).rejects.toThrow(/relative|path/i);
    await expect(readSkillFile(skillPath, "../../sentinel")).rejects.toThrow(/relative|path/i);
    await expect(readSkillFile(skillPath, "link")).resolves.toContain("../../sentinel");
    await expect(readSkillFile(skillPath, "SKILL.md")).resolves.toContain("name: safe");
    expect(await readFile(outside, "utf8")).toBe("private sentinel");
  });

  it("keeps missing, invalid, and unassociated lock entries unknown without editing them", async () => {
    const paths = resolvePaths(agentRoot);
    await writeSkill(agentRoot, "manual", "---\nname: manual\n---\n");
    await expect(scanSkills(agentRoot)).resolves.toEqual([
      expect.objectContaining({ name: "manual", lockEntry: null, provenance: { kind: "unknown" } }),
    ]);
    for (const lock of [
      "{broken",
      JSON.stringify({ version: 3 }),
      JSON.stringify({ version: 3, skills: { manual: { source: "owner/repo" } } }),
      JSON.stringify({ version: 3, skills: { manual: {
        source: "owner/repo", sourceType: "github", sourceUrl: "https://github.com/owner/repo",
        skillPath: "skills/manual/SKILL.md", skillFolderHash: "f".repeat(40),
        installedAt: "2026-01-01", updatedAt: "2026-01-01",
      } } }),
    ]) {
      await writeFile(paths.lockFile, lock);
      const skills = await scanSkills(agentRoot);
      expect(skills).toEqual([expect.objectContaining({ name: "manual", lockEntry: null, provenance: { kind: "unknown" } })]);
      expect(await readFile(paths.lockFile, "utf8")).toBe(lock);
    }
  });

  it("bounds large previews and reports the truncation without changing the source", async () => {
    const raw = "---\nname: large\n---\n" + "x".repeat(1_100_000);
    await writeSkill(agentRoot, "large", raw);
    const skillPath = path.join(agentRoot, "large");
    const [skill] = await scanSkills(agentRoot);
    expect(skill.warnings.join(" ")).toMatch(/preview.*truncat/i);
    for (const preview of [await readSkillText(skillPath), await readSkillSource(skillPath), await readSkillFile(skillPath, "SKILL.md")]) {
      expect(Buffer.byteLength(preview)).toBeLessThan(1_050_000);
      expect(preview).toContain("[Preview truncated after 1 MiB.]");
    }
    expect(await readFile(path.join(skillPath, "SKILL.md"), "utf8")).toBe(raw);
    expect(await countSkillFileLines(skillPath, "SKILL.md")).toBe(4);
  });

  it("counts complete files with mixed line endings without following links", async () => {
    await writeSkill(agentRoot, "lines", "---\nname: lines\n---\n");
    const skillPath = path.join(agentRoot, "lines");
    for (const [text, count] of [
      ["", 0], ["one", 1], ["one\n", 1], ["\n", 1],
      ["a\rb\nc\r\nd", 4], ["a\r\n\r\n", 2],
      ["x".repeat(65_535) + "\r\nlast", 2],
    ] as const) {
      await writeFile(path.join(skillPath, "mixed.txt"), text);
      expect(await countSkillFileLines(skillPath, "mixed.txt")).toBe(count);
    }
    const sentinel = path.join(workspace, "sentinel");
    await writeFile(sentinel, "private");
    await symlink("../../sentinel", path.join(skillPath, "link"));
    await expect(countSkillFileLines(skillPath, "link")).rejects.toThrow();
    await expect(countSkillFileLines(skillPath, "../../sentinel")).rejects.toThrow();
    await expect(countSkillFileLines(skillPath, sentinel)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("private");
  });

  it("loads normal body text without hiding malformed or unsupported documents", async () => {
    await writeSkill(agentRoot, "good", "---\nname: good\n---\n# Good\nBody.");
    await writeSkill(agentRoot, "bad", "---\nname: [\n---\n# Bad");
    await expect(readSkillText(path.join(agentRoot, "good"))).resolves.toBe("# Good\nBody.");
    await expect(readSkillText(path.join(agentRoot, "bad"))).resolves.toBe("---\nname: [\n---\n# Bad");
  });
});
