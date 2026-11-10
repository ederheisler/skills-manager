import { cp, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveSkillsRoot, fingerprintContents } from "../../src/actions/boundary.js";
import { applyPreparedChange, discardPreparedChange, prepareAdd } from "../../src/actions/skillsCli.js";
import { prepareUpdate } from "../../src/actions/update.js";
import { scanSkills } from "../../src/state/repo.js";
import { listOrphanedReceipts, matchUpstreamReceipt, readExternalClaim, readInstalledSource } from "../../src/state/upstreamProvenance.js";
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
  const entry: LockEntry & { pluginName: string } = {
    source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
    skillPath: "skills/example/SKILL.md", skillFolderHash: hash, ref: "main",
    installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pluginName: "fixture-plugin",
  };
  return { base, skills, staged, hash, entry };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("external upstream lock claims", () => {
  it("tracks the saved source for original and locally edited contents without writing a receipt or the parent lock", async () => {
    const { base, skills, staged, hash, entry } = await fixture();
    const target = path.join(skills, "example");
    await cp(staged, target, { recursive: true });
    const root = await approveSkillsRoot(skills);
    const lock = path.join(base, ".skill-lock.json");
    const bytes = `${JSON.stringify({ version: 3, skills: { example: entry }, dismissed: { welcome: true } }, null, 2)}\n`;
    await writeFile(lock, bytes);

    for (const edited of [false, true]) {
      if (edited) await writeFile(path.join(target, "nested", "file.txt"), "locally edited\n");
      expect(await matchUpstreamReceipt(skills, target, "example")).toBeNull();
      expect(await readExternalClaim(skills, target, "example")).toEqual(entry);
      expect(await readInstalledSource(skills, target, "example")).toEqual(entry);
      expect(await readInstalledSource(skills, target, "example", root)).toEqual(entry);
      const [scanned] = await scanSkills(skills);
      expect(scanned).toMatchObject({
        name: "example",
        authors: [],
        lockEntry: entry,
        recordedSource: entry,
        provenance: { kind: "source", source: entry.source, sourceUrl: entry.sourceUrl },
      });
      expect(scanned.lockEntry?.skillFolderHash).toBe(hash);
      expect(await readFile(lock, "utf8")).toBe(bytes);
      await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path.join(target, "nested", "file.txt"), "utf8")).toBe("locally edited\n");
  });

  it("accepts a repository-root SKILL.md and preserves the recorded hash spelling", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    await cp(staged, target, { recursive: true });
    const rootEntry = { ...entry, skillPath: "SKILL.md", skillFolderHash: entry.skillFolderHash.toUpperCase() };
    await writeFile(path.join(base, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: rootEntry } }));
    expect(await readExternalClaim(skills, target, "example")).toEqual(rootEntry);
    expect(await readInstalledSource(skills, target, "example")).toEqual(rootEntry);
    expect((await scanSkills(skills))[0].lockEntry).toEqual(rootEntry);
  });

  it("preserves CLI-only fields and leaves missing version information for the CLI to interpret", async () => {
    const { base, skills, staged } = await fixture();
    const target = path.join(skills, "example");
    await cp(staged, target, { recursive: true });
    const entry = {
      source: "https://example.com", sourceType: "well-known", sourceUrl: "https://example.com/.well-known/skills/example",
      sourceBaseUrl: "https://example.com", wellKnownDigest: "digest", installMode: "copy",
      installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    const lock = path.join(base, ".skill-lock.json");
    await writeFile(lock, JSON.stringify({ version: 3, skills: { example: entry } }));
    expect(await readExternalClaim(skills, target, "example")).toEqual({ ...entry, skillPath: "", skillFolderHash: "" });
    await writeFile(lock, JSON.stringify({ version: 3, skills: { example: { ...entry, sourceBaseUrl: "https://user:secret@example.com" } } }));
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
  });

  it("reads the XDG CLI global lock instead of an obsolete home lock for the default root", async () => {
    const { base, staged, entry } = await fixture();
    const home = path.join(base, "home");
    const skills = path.join(home, ".agents", "skills");
    const state = path.join(base, "xdg-state", "skills");
    await mkdir(skills, { recursive: true });
    await mkdir(state, { recursive: true });
    await cp(staged, path.join(skills, "example"), { recursive: true });
    const stale = { ...entry, skillFolderHash: "stale" };
    await writeFile(path.join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: stale } }));
    await writeFile(path.join(state, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: entry } }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_STATE_HOME", path.join(base, "xdg-state"));
    expect(await readExternalClaim(skills, path.join(skills, "example"), "example")).toEqual(entry);
    expect((await scanSkills(skills))[0].lockEntry).toEqual(entry);
  });

  it("rejects malformed, incompatible, oversized and structurally invalid parent locks", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    const lock = path.join(base, ".skill-lock.json");
    await cp(staged, target, { recursive: true });
    const invalidLocks: Array<[string, string]> = [
      ["invalid JSON", "{broken"],
      ["old version", JSON.stringify({ version: 2, skills: { example: entry } })],
      ["future version", JSON.stringify({ version: 4, skills: { example: entry } })],
      ["string version", JSON.stringify({ version: "3", skills: { example: entry } })],
      ["missing entries", JSON.stringify({ version: 3 })],
      ["entries array", JSON.stringify({ version: 3, skills: [entry] })],
      ["missing fields", JSON.stringify({ version: 3, skills: { example: { source: entry.source } } })],
      ["wrong field type", JSON.stringify({ version: 3, skills: { example: { ...entry, ref: 42 } } })],
      ["oversized lock", " ".repeat(1024 * 1024 + 1)],
    ];
    for (const [label, bytes] of invalidLocks) {
      await writeFile(lock, bytes);
      expect(await readExternalClaim(skills, target, "example"), label).toBeNull();
      expect(await readInstalledSource(skills, target, "example"), label).toBeNull();
      expect(await readFile(lock, "utf8")).toBe(bytes);
    }
  });

  it("rejects invalid GitHub sources, URLs and unsafe source paths", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    const lock = path.join(base, ".skill-lock.json");
    await cp(staged, target, { recursive: true });
    const invalidEntries: Array<[string, Partial<LockEntry>]> = [
      ["invalid source", { source: "../repository" }],
      ["mismatched repository URL", { sourceUrl: "https://github.com/other/repo.git" }],
      ["untrusted host", { sourceUrl: "https://example.com/owner/repository.git" }],
      ["URL credentials", { sourceUrl: "https://user:password@github.com/owner/repository.git" }],
      ["URL query", { sourceUrl: "https://github.com/owner/repository.git?token=secret" }],
      ["malformed URL", { sourceUrl: "github.com/owner/repository.git" }],
      ["absolute source path", { skillPath: "/outside/SKILL.md" }],
      ["traversing source path", { skillPath: "../outside/SKILL.md" }],
      ["embedded traversal", { skillPath: "skills/../outside/SKILL.md" }],
      ["control character in source path", { skillPath: "skills/example/\nSKILL.md" }],
    ];
    for (const [label, changes] of invalidEntries) {
      const bytes = JSON.stringify({ version: 3, skills: { example: { ...entry, ...changes } } });
      await writeFile(lock, bytes);
      expect(await readExternalClaim(skills, target, "example"), label).toBeNull();
      expect(await readInstalledSource(skills, target, "example"), label).toBeNull();
      expect(await readFile(lock, "utf8")).toBe(bytes);
    }
  });

  it("requires a unique direct installed directory and does not promote an orphaned parent entry", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    const disabled = path.join(skills, ".disabled_skills", "example");
    const lock = path.join(base, ".skill-lock.json");
    const bytes = JSON.stringify({ version: 3, skills: { example: entry } });
    await writeFile(lock, bytes);
    await cp(staged, target, { recursive: true });
    expect(await readExternalClaim(skills, staged, "example")).toBeNull();
    expect(await readInstalledSource(skills, staged, "example")).toBeNull();
    await mkdir(path.dirname(disabled), { recursive: true });
    await cp(staged, disabled, { recursive: true });
    for (const selected of [target, disabled]) {
      expect(await readExternalClaim(skills, selected, "example")).toBeNull();
      expect(await readInstalledSource(skills, selected, "example")).toBeNull();
    }
    const duplicates = await scanSkills(skills);
    expect(duplicates).toHaveLength(2);
    for (const skill of duplicates) {
      expect(skill).toMatchObject({ lockEntry: null, recordedSource: null, provenance: { kind: "unknown" } });
      expect(skill.warnings.join(" ")).toMatch(/ambiguous/i);
    }
    await rm(target, { recursive: true });
    await rm(disabled, { recursive: true });
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    expect(await readInstalledSource(skills, target, "example")).toBeNull();
    expect(await scanSkills(skills)).toEqual([]);
    expect(await readFile(lock, "utf8")).toBe(bytes);
    await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing", "linked"])("refuses a stale selection when SKILL.md is %s", async (state) => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    const document = path.join(target, "SKILL.md");
    const lock = path.join(base, ".skill-lock.json");
    const bytes = JSON.stringify({ version: 3, skills: { example: entry } });
    await cp(staged, target, { recursive: true });
    await writeFile(lock, bytes);
    const root = await approveSkillsRoot(skills);
    expect(await readInstalledSource(skills, target, "example", root)).toEqual(entry);

    await rm(document);
    if (state === "linked") await symlink(path.join(staged, "SKILL.md"), document);
    // A stale selection may fail closed by returning null or by rejecting the read.
    expect(await readInstalledSource(skills, target, "example").catch(() => null)).toBeNull();
    expect(await readInstalledSource(skills, target, "example", root).catch(() => null)).toBeNull();
    const scanned = await scanSkills(skills);
    if (state === "missing") expect(scanned).toEqual([]);
    else {
      expect(scanned).toHaveLength(1);
      expect(scanned[0]).toMatchObject({ lockEntry: null, provenance: { kind: "unknown" } });
      expect((await lstat(document)).isSymbolicLink()).toBe(true);
    }
    expect(await readFile(lock, "utf8")).toBe(bytes);
    await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow a linked leaf or associate a root alias in another parent", async () => {
    const { base, skills, staged, entry } = await fixture();
    await writeFile(path.join(base, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: entry } }));
    const target = path.join(skills, "example");
    await symlink(staged, target);
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    expect(await readInstalledSource(skills, target, "example")).toBeNull();
    expect((await scanSkills(skills))[0]).toMatchObject({
      entryKind: "symlink", lockEntry: null, recordedSource: null, provenance: { kind: "unknown" },
    });
    await rm(target);
    await cp(staged, target, { recursive: true });
    const sameParentAlias = path.join(base, "selected-link");
    await symlink(skills, sameParentAlias);
    expect(await readExternalClaim(sameParentAlias, path.join(sameParentAlias, "example"), "example")).toEqual(entry);
    expect(await readInstalledSource(sameParentAlias, path.join(sameParentAlias, "example"), "example")).toEqual(entry);
    const aliasParent = path.join(base, "alias-parent");
    await mkdir(aliasParent);
    const alias = path.join(aliasParent, "selected-link");
    await symlink(skills, alias);
    await writeFile(path.join(aliasParent, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: entry } }));
    expect(await readExternalClaim(alias, path.join(alias, "example"), "example")).toBeNull();
    expect(await readInstalledSource(alias, path.join(alias, "example"), "example")).toBeNull();
    expect((await scanSkills(alias))[0]).toMatchObject({
      lockEntry: null, recordedSource: null, provenance: { kind: "unknown" },
    });
  });

  it("does not follow a linked disabled-skills parent", async () => {
    const { base, skills, staged, entry } = await fixture();
    const outside = path.join(base, "outside-disabled");
    const linked = path.join(skills, ".disabled_skills");
    await mkdir(outside);
    await cp(staged, path.join(outside, "example"), { recursive: true });
    await symlink(outside, linked);
    await writeFile(path.join(base, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: entry } }));
    const target = path.join(linked, "example");
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    expect(await readInstalledSource(skills, target, "example")).toBeNull();
    await expect(scanSkills(skills)).rejects.toThrow(/disabled skills path/i);
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(outside, "example", "nested", "file.txt"), "utf8")).toBe("fixture data\n");
  });

  it("does not associate an active skill when the disabled directory is a symlink, even without a duplicate", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    const outside = path.join(base, "outside-disabled");
    const linked = path.join(skills, ".disabled_skills");
    await cp(staged, target, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "untouched\n");
    await symlink(outside, linked);
    await writeFile(path.join(base, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { example: entry } }));
    await expect(lstat(path.join(outside, "example"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readExternalClaim(skills, target, "example")).toBeNull();
    expect(await readInstalledSource(skills, target, "example")).toBeNull();
    await expect(scanSkills(skills)).rejects.toThrow(/disabled skills path/i);
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("untouched\n");
  });

  it("does not treat a linked parent lock as source evidence", async () => {
    const { base, skills, staged, entry } = await fixture();
    await cp(staged, path.join(skills, "example"), { recursive: true });
    const outside = path.join(base, "external-lock.json");
    const lock = path.join(base, ".skill-lock.json");
    const bytes = JSON.stringify({ version: 3, skills: { example: entry } });
    await writeFile(outside, bytes);
    await symlink(outside, lock);
    expect((await scanSkills(skills))[0]).toMatchObject({
      lockEntry: null, recordedSource: null, provenance: { kind: "unknown" },
    });
    expect((await lstat(lock)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe(bytes);
    await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates an approved root before using a parent record", async () => {
    const { base, skills, staged, entry } = await fixture();
    const target = path.join(skills, "example");
    await cp(staged, target, { recursive: true });
    const root = await approveSkillsRoot(skills);
    const lock = path.join(base, ".skill-lock.json");
    const bytes = JSON.stringify({ version: 3, skills: { example: entry } });
    await writeFile(lock, bytes);
    expect(await readInstalledSource(skills, target, "example", root)).toEqual(entry);
    await writeFile(path.join(target, "nested", "file.txt"), "edited after approval\n");
    expect(await readInstalledSource(skills, target, "example", root)).toEqual(entry);

    const other = path.join(base, "other");
    await mkdir(other);
    const otherRoot = await approveSkillsRoot(other);
    await expect(readInstalledSource(skills, target, "example", otherRoot)).rejects.toThrow(/root|approved/i);

    const original = `${skills}-original`;
    await rename(skills, original);
    await cp(original, skills, { recursive: true });
    await expect(readInstalledSource(skills, target, "example", root)).rejects.toMatchObject({ code: "ESTALE" });
    expect(await readFile(path.join(target, "nested", "file.txt"), "utf8")).toBe("edited after approval\n");
    expect(await readFile(lock, "utf8")).toBe(bytes);
    await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("prefers the actual CLI lock over an otherwise matching managed receipt", async () => {
    const { base, skills, staged, entry: external } = await fixture();
    const root = await approveSkillsRoot(skills);
    await applyPreparedChange(await prepareAdd(root, staged));
    const installed = path.join(skills, "example");
    const lock = path.join(base, ".skill-lock.json");
    const bytes = JSON.stringify({ version: 3, skills: { example: external } });
    await writeFile(lock, bytes);
    const receiptPath = path.join(skills, ".skills-manager", "metadata", "example.json");
    const receiptBytes = await readFile(receiptPath, "utf8");
    const managed = await matchUpstreamReceipt(skills, installed, "example", root);
    expect(managed?.entry).toMatchObject({ source: staged, sourceType: "local", sourceUrl: staged });
    expect(await readExternalClaim(skills, installed, "example")).toEqual(external);
    expect(await readInstalledSource(skills, installed, "example")).toEqual(external);
    expect(await readInstalledSource(skills, installed, "example", root)).toEqual(external);
    expect((await scanSkills(skills))[0]).toMatchObject({
      lockEntry: external, recordedSource: external, provenance: { kind: "source", source: external.source, sourceUrl: external.sourceUrl },
    });

    await writeFile(path.join(installed, "nested", "file.txt"), "edited installed content\n");
    expect(await matchUpstreamReceipt(skills, installed, "example")).toBeNull();
    expect(await matchUpstreamReceipt(skills, installed, "example", root)).toBeNull();
    expect(await readInstalledSource(skills, installed, "example")).toEqual(external);
    expect(await readInstalledSource(skills, installed, "example", root)).toEqual(external);
    expect((await scanSkills(skills))[0]).toMatchObject({
      lockEntry: external,
      recordedSource: external,
      provenance: { kind: "source", source: external.source, sourceUrl: external.sourceUrl },
    });
    expect(await readFile(lock, "utf8")).toBe(bytes);
    expect(await readFile(receiptPath, "utf8")).toBe(receiptBytes);

    await rm(lock);
    expect(await readInstalledSource(skills, installed, "example")).toBeNull();
    expect((await scanSkills(skills))[0]).toMatchObject({
      lockEntry: null, recordedSource: null, provenance: { kind: "unknown" },
    });
    expect(await readFile(receiptPath, "utf8")).toBe(receiptBytes);
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
    const prepared = await prepareUpdate(copiedRoot, skill, entry);
    expect(prepared.changes).toEqual([]);
    expect(prepared.failed?.[0].reason).toMatch(/does not track/i);
    await discardPreparedChange(prepared);
    await rm(installed, { recursive: true });
    expect(await listOrphanedReceipts(skills)).toEqual([]);
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
      const prepared = await prepareUpdate(await approveSkillsRoot(skills), skill, entry);
      expect(prepared.changes).toEqual([]);
      expect(prepared.failed?.[0].reason).toMatch(/does not track/i);
      await discardPreparedChange(prepared);
    }
  });
});
