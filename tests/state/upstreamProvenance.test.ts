import { cp, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { approveSkillsRoot, fingerprintContents } from "../../src/actions/boundary.js";
import { applyPreparedChange, prepareAdd } from "../../src/actions/skillsCli.js";
import { prepareUpdate } from "../../src/actions/update.js";
import { scanSkills } from "../../src/state/repo.js";
import { listOrphanedReceipts, matchUpstreamReceipt, readExternalClaim } from "../../src/state/upstreamProvenance.js";
import type { LockEntry } from "../../src/state/types.js";

const roots: string[] = [];

async function fixture(): Promise<{ base: string; skills: string; staged: string; hash: string; entry: LockEntry }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-provenance-")));
  roots.push(base);
  const repository = path.join(base, "source-repository");
  const skills = path.join(base, "selected");
  const staged = path.join(repository, "example");
  await mkdir(staged, { recursive: true });
  await mkdir(skills);
  await writeFile(path.join(staged, "SKILL.md"), "---\nname: example\ndescription: Real Git fixture\n---\ncontent\n");
  await mkdir(path.join(staged, "nested"));
  await writeFile(path.join(staged, "nested", "file.txt"), "fixture data\n");
  const env = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  await execa("git", ["init", "-q"], { cwd: repository, env, extendEnv: false });
  await execa("git", ["add", "--", "example"], { cwd: repository, env, extendEnv: false });
  const tree = (await execa("git", ["write-tree"], { cwd: repository, env, extendEnv: false })).stdout;
  const hash = (await execa("git", ["rev-parse", `${tree}:example`], { cwd: repository, env, extendEnv: false })).stdout;
  const entry: LockEntry = {
    source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
    skillPath: "skills/example/SKILL.md", skillFolderHash: hash,
    installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  return { base, skills, staged, hash, entry };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external upstream lock claims", () => {
  it("records a matching Git tree only as an unverified source, without modifying the parent lock", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    await cp(staged, target, { recursive: true });
    const lock = path.join(base, ".skill-lock.json");
    const bytes = JSON.stringify({ version: 3, skills: { example: entry } });
    await writeFile(lock, bytes);
    expect(await readExternalClaim(skills, target, "example")).toEqual(entry);
    const [scanned] = await scanSkills(skills);
    expect(scanned.recordedSource).toEqual(entry);
    expect(scanned.lockEntry).toBeNull();
    expect(scanned.provenance.kind).toBe("unknown");
    expect(await readFile(lock, "utf8")).toBe(bytes);
  });

  it("rejects changed bytes, wrong versions, mismatched URLs and unrelated selected paths", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    const lock = path.join(base, ".skill-lock.json");
    await cp(staged, target, { recursive: true });
    await writeFile(lock, JSON.stringify({ version: 2, skills: { example: entry } }));
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    await writeFile(lock, JSON.stringify({ version: 3, skills: { example: { ...entry, sourceUrl: "https://github.com/other/repo.git" } } }));
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    await writeFile(lock, " ".repeat(1024 * 1024 + 1));
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    await writeFile(lock, JSON.stringify({ version: 3, skills: { example: entry } }));
    expect(await readExternalClaim(skills, staged, "example")).toBeNull();
    await writeFile(path.join(target, "nested", "file.txt"), "locally edited\n");
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
  });

  it("does not follow a linked leaf or associate a root alias in another parent", async () => {
    const { base, skills, staged, entry } = await fixture();
    await writeFile(path.join(base, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: entry } }));
    const target = path.join(skills, "example");
    await symlink(staged, target);
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    await rm(target);
    await cp(staged, target, { recursive: true });
    const aliasParent = path.join(base, "alias-parent");
    await mkdir(aliasParent);
    const alias = path.join(aliasParent, "selected-link");
    await symlink(skills, alias);
    expect(await readExternalClaim(alias, path.join(alias, "example"), "example")).toBeNull();
  });
});

describe("controlled import receipts", () => {
  it("binds a real imported fixture to its contents, disassociates duplicates, and shows orphan receipts", async () => {
    const { skills, staged } = await fixture();
    const root = await approveSkillsRoot(skills);
    await applyPreparedChange(await prepareAdd(root, staged));
    const entry = (await matchUpstreamReceipt(skills, path.join(skills, "example"), "example"))?.entry;
    expect(entry).toMatchObject({ source: staged, sourceType: "local", sourceUrl: staged });
    const installed = path.join(skills, "example");
    expect(await matchUpstreamReceipt(skills, installed, "example")).toEqual({ entry, historicalBaseline: "none" });
    expect(await matchUpstreamReceipt(skills, installed, "example", root)).toEqual({ entry, historicalBaseline: "none" });
    expect((await scanSkills(skills))[0].provenance.kind).toBe("local");
    const stat = await lstat(skills, { bigint: true });
    const receipt = JSON.parse(await readFile(path.join(skills, ".skills-manager", "metadata", "example.json"), "utf8"));
    expect(receipt.rootIdentity).toEqual({ device: stat.dev.toString(), inode: stat.ino.toString() });

    const disabled = path.join(skills, ".disabled_skills", "example");
    await mkdir(path.dirname(disabled), { recursive: true });
    await cp(installed, disabled, { recursive: true });
    const duplicates = await scanSkills(skills);
    expect(duplicates).toHaveLength(2);
    for (const row of duplicates) {
      expect(row.provenance.kind).toBe("unknown");
      expect(row.lockEntry).toBeNull();
      expect(row.recordedSource).toBeNull();
      expect(row.warnings.join(" ")).toContain("ambiguous");
    }

    await rm(installed, { recursive: true });
    await rm(disabled, { recursive: true });
    expect(await listOrphanedReceipts(skills)).toEqual([{ name: "example", entry }]);
    const [orphan] = await scanSkills(skills);
    expect(orphan).toMatchObject({ name: "example", orphaned: true, entryKind: "orphaned", lockEntry: null, recordedSource: entry, provenance: { kind: "unknown" } });
  });

  it("does not trust a copied receipt at the same path on a different physical root", async () => {
    const { skills, staged, entry } = await fixture();
    const originalRoot = await approveSkillsRoot(skills);
    await applyPreparedChange(await prepareAdd(originalRoot, staged));
    const original = `${skills}-original`;
    await rename(skills, original);
    expect(await matchUpstreamReceipt(original, path.join(original, "example"), "example")).toBeNull();
    await cp(original, skills, { recursive: true });

    const copiedRoot = await approveSkillsRoot(skills);
    const installed = path.join(skills, "example");
    expect(await matchUpstreamReceipt(skills, installed, "example")).toBeNull();
    expect(await matchUpstreamReceipt(skills, installed, "example", copiedRoot)).toBeNull();
    const [skill] = await scanSkills(skills);
    expect(skill.provenance.kind).toBe("unknown");
    expect(skill.lockEntry).toBeNull();
    await expect(prepareUpdate(copiedRoot, skill, entry)).rejects.toThrow(/matching local receipt/);
    await rm(installed, { recursive: true });
    expect(await listOrphanedReceipts(skills)).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("rejects invalid UTF-8 orphan receipt names instead of aliasing another filename", async () => {
    const { skills, staged } = await fixture();
    const root = await approveSkillsRoot(skills);
    await applyPreparedChange(await prepareAdd(root, staged));
    await rm(path.join(skills, "example"), { recursive: true });
    const metadata = path.join(skills, ".skills-manager", "metadata");
    const invalid = Buffer.concat([Buffer.from(`${metadata}/`), Buffer.from([0xff]), Buffer.from(".json")]);
    await writeFile(invalid, "{}", { mode: 0o600 });
    await expect(listOrphanedReceipts(skills)).rejects.toThrow(/not valid UTF-8/);
    await expect(scanSkills(skills)).rejects.toThrow(/not valid UTF-8/);
  });

  it("does not promote legacy or precomputed adopted receipt data", async () => {
    const { skills, staged, entry } = await fixture();
    const installed = path.join(skills, "example");
    await cp(staged, installed, { recursive: true });
    const metadata = path.join(skills, ".skills-manager", "metadata");
    await mkdir(metadata, { recursive: true, mode: 0o700 });
    await writeFile(path.join(skills, ".skills-manager", "owner"), "skills-manager-owned-state-v1\n", { mode: 0o600 });
    await writeFile(path.join(skills, ".skills-manager", "lock"), "", { mode: 0o600 });
    const fingerprint = await fingerprintContents(installed);
    const stat = await lstat(skills, { bigint: true });
    const common = { root: skills, name: "example", fingerprint, historicalBaseline: "reviewed", entry };
    for (const receipt of [
      { version: 1, ...common },
      { version: 2, ...common, rootIdentity: { device: stat.dev.toString(), inode: (stat.ino + 1n).toString() } },
    ]) {
      await writeFile(path.join(metadata, "example.json"), JSON.stringify(receipt), { mode: 0o600 });
      const [skill] = await scanSkills(skills);
      expect(skill.provenance.kind).toBe("unknown");
      expect(skill.lockEntry).toBeNull();
      await expect(prepareUpdate(await approveSkillsRoot(skills), skill, entry)).rejects.toThrow(/matching local receipt/);
    }
  });
});
