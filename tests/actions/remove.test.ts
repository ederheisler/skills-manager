import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveSkillsRoot, fingerprintTree, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { removeManagedSkill } from "../../src/actions/remove.js";
import { disableSkill } from "../../src/actions/toggle.js";

let sandbox: string;
let skillsDir: string;
let root: ApprovedSkillsRoot;
let outside: string;
let lockFile: string;
const skillContents = "---\nname: foo\n---\nreviewed skill\n";
const lockContents = '{"version":3,"skills":{"foo":{"source":"owner/repo"},"orphan":{"source":"other/repo"}}}\n';

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "skills-remove-")));
  skillsDir = join(sandbox, "selected-skills");
  outside = join(sandbox, "outside");
  lockFile = join(sandbox, ".skill-lock.json");
  await mkdir(join(skillsDir, "foo"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(skillsDir, "foo", "SKILL.md"), skillContents);
  await writeFile(join(outside, "sentinel"), "outside stays unchanged");
  await writeFile(lockFile, lockContents);
  root = await approveSkillsRoot(skillsDir);
  skillsDir = root.path;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectOutsideUnchanged(extra: string[] = []): Promise<void> {
  await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside stays unchanged");
  expect((await readdir(outside)).sort()).toEqual(["sentinel", ...extra].sort());
  await expect(readFile(lockFile, "utf8")).resolves.toBe(lockContents);
}

describe("removeManagedSkill", () => {
  it("removes exactly the reviewed skill without changing the external lock or unrelated skills", async () => {
    const skill = join(skillsDir, "foo");
    const unrelated = join(skillsDir, "other");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "SKILL.md"), "other skill");
    const lockBefore = await lstat(lockFile);

    await removeManagedSkill(root, "foo", skill, await fingerprintTree(skill));

    await expectMissing(skill);
    await expect(readFile(join(unrelated, "SKILL.md"), "utf8")).resolves.toBe("other skill");
    await expectOutsideUnchanged();
    const lockAfter = await lstat(lockFile);
    expect([lockAfter.ino, lockAfter.mode, lockAfter.mtimeMs]).toEqual([
      lockBefore.ino, lockBefore.mode, lockBefore.mtimeMs,
    ]);
  });

  it("removes a reviewed disabled entry without altering its sibling lock", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    await disableSkill(root, "foo", await fingerprintTree(enabled));

    await removeManagedSkill(root, "foo", disabled, await fingerprintTree(disabled));

    await expectMissing(enabled);
    await expectMissing(disabled);
    await expectOutsideUnchanged();
  });

  it("removes the exact reviewed entry in the approved target of a selected root link", async () => {
    const selectedLink = join(sandbox, "selected-link");
    await symlink(skillsDir, selectedLink, "dir");
    const approvedRoot = await approveSkillsRoot(await realpath(selectedLink));
    const reviewedPath = join(approvedRoot.path, "foo");

    await removeManagedSkill(approvedRoot, "foo", reviewedPath, await fingerprintTree(reviewedPath));

    await expectMissing(join(skillsDir, "foo"));
    expect(await readlink(selectedLink)).toBe(skillsDir);
    await expectOutsideUnchanged();
  });

  it("unlinks nested directory, file, and dangling symlinks without following them", async () => {
    const skill = join(skillsDir, "foo");
    const missingTarget = join(sandbox, "missing-target");
    await symlink(outside, join(skill, "outside-directory"), "dir");
    await symlink(join(outside, "sentinel"), join(skill, "outside-file"));
    await symlink(missingTarget, join(skill, "dangling"));
    await mkdir(join(skill, "nested"));
    await symlink(outside, join(skill, "nested", "outside-directory"), "dir");

    await removeManagedSkill(root, "foo", skill, await fingerprintTree(skill));

    await expectMissing(skill);
    await expectMissing(missingTarget);
    await expectOutsideUnchanged();
  });

  it.each(["outside", "dangling"])("unlinks a %s leaf link rather than removing its target", async (kind) => {
    const target = kind === "outside" ? outside : join(sandbox, "missing-target");
    const skill = join(skillsDir, "linked");
    await symlink(target, skill, "dir");

    await removeManagedSkill(root, "linked", skill, await fingerprintTree(skill));

    await expectMissing(skill);
    if (kind === "dangling") await expectMissing(target);
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });

  it("rejects an edited skill after review", async () => {
    const skill = join(skillsDir, "foo");
    const version = await fingerprintTree(skill);
    await writeFile(join(skill, "SKILL.md"), "edited after confirmation");

    await expect(removeManagedSkill(root, "foo", skill, version)).rejects.toThrow();
    await expect(readFile(join(skill, "SKILL.md"), "utf8")).resolves.toBe("edited after confirmation");
    await expectOutsideUnchanged();
  });

  it("rejects a byte-identical replacement for the reviewed entry", async () => {
    const skill = join(skillsDir, "foo");
    const version = await fingerprintTree(skill);
    await rename(skill, join(skillsDir, "original-foo"));
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), skillContents);

    await expect(removeManagedSkill(root, "foo", skill, version)).rejects.toThrow();
    await expect(readFile(join(skill, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expect(readFile(join(skillsDir, "original-foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });

  it("rejects a leaf link retargeted after review", async () => {
    const skill = join(skillsDir, "linked");
    const replacement = join(sandbox, "missing-target");
    await symlink(outside, skill, "dir");
    const version = await fingerprintTree(skill);
    await unlink(skill);
    await symlink(replacement, skill, "dir");

    await expect(removeManagedSkill(root, "linked", skill, version)).rejects.toThrow();
    expect(await readlink(skill)).toBe(replacement);
    await expectOutsideUnchanged();
  });

  it("rejects a path other than the exact entry reviewed for this name", async () => {
    const skill = join(skillsDir, "foo");
    const unrelated = join(skillsDir, "other");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "SKILL.md"), "other skill");

    await expect(removeManagedSkill(root, "foo", unrelated, await fingerprintTree(unrelated))).rejects.toThrow();
    await expect(removeManagedSkill(root, "foo", "", await fingerprintTree(skill))).rejects.toThrow();
    await expect(readFile(join(skill, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expect(readFile(join(unrelated, "SKILL.md"), "utf8")).resolves.toBe("other skill");
    await expectOutsideUnchanged();
  });

  it("cannot use a traversal name and confirmed outside path to remove a sibling", async () => {
    const version = await fingerprintTree(outside);

    await expect(removeManagedSkill(root, "../outside", outside, version)).rejects.toThrow();

    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });

  it.each(["", ".", "..", "foo/../outside", ".git", ".disabled_skills", ".skills-manager"])(
    "rejects reserved or non-leaf removal name %j",
    async (name) => {
      const skill = join(skillsDir, "foo");
      await expect(removeManagedSkill(root, name, skill, await fingerprintTree(skill))).rejects.toThrow();
      await expect(readFile(join(skill, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
      await expectOutsideUnchanged();
    },
  );

  it("rejects removal through a symlinked disabled directory", async () => {
    const disabledDir = join(skillsDir, ".disabled_skills");
    const reviewedSkill = join(disabledDir, "linked");
    const outsideSkill = join(outside, "linked");
    await mkdir(reviewedSkill, { recursive: true });
    await writeFile(join(reviewedSkill, "SKILL.md"), "reviewed content");
    const version = await fingerprintTree(reviewedSkill);
    await rename(reviewedSkill, outsideSkill);
    await rm(disabledDir, { recursive: true });
    await symlink(outside, disabledDir, "dir");

    await expect(removeManagedSkill(root, "linked", reviewedSkill, version)).rejects.toThrow();
    await expect(readFile(join(outsideSkill, "SKILL.md"), "utf8")).resolves.toBe("reviewed content");
    expect(await readlink(disabledDir)).toBe(outside);
    await expectOutsideUnchanged(["linked"]);
  });

  it("rejects an unowned manager-directory collision without changing it", async () => {
    const manager = join(skillsDir, ".skills-manager");
    const skill = join(skillsDir, "foo");
    await mkdir(manager);
    await writeFile(join(manager, "sentinel"), "not manager-owned");

    await expect(removeManagedSkill(root, "foo", skill, await fingerprintTree(skill))).rejects.toThrow();
    await expect(readFile(join(manager, "sentinel"), "utf8")).resolves.toBe("not manager-owned");
    await expect(readFile(join(skill, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });

  it("leaves a symlinked external lock and its target untouched", async () => {
    const skill = join(skillsDir, "foo");
    await unlink(lockFile);
    await symlink(join(outside, "sentinel"), lockFile);

    await removeManagedSkill(root, "foo", skill, await fingerprintTree(skill));

    await expectMissing(skill);
    expect(await readlink(lockFile)).toBe(join(outside, "sentinel"));
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside stays unchanged");
  });
});
