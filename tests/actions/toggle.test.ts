import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveSkillsRoot, fingerprintTree, recoverSkills, withSkillsLock, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { disableSkill, enableSkill } from "../../src/actions/toggle.js";

let sandbox: string;
let skillsDir: string;
let root: ApprovedSkillsRoot;
let outside: string;
let lockFile: string;
const originalSkill = "---\nname: foo\n---\noriginal\n";
const lockContents = '{"version":3,"skills":{"foo":{"source":"owner/repo"}}}\n';

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "skills-toggle-")));
  skillsDir = join(sandbox, "selected-skills");
  outside = join(sandbox, "outside");
  lockFile = join(sandbox, ".skill-lock.json");
  await mkdir(join(skillsDir, "foo"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(skillsDir, "foo", "SKILL.md"), originalSkill);
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

describe("skill toggles at the selected directory", () => {
  it("moves the reviewed skill into the selected root's disabled directory and back", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const lockBefore = await lstat(lockFile);

    await disableSkill(root, "foo", await fingerprintTree(enabled));
    await expectMissing(enabled);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);

    await enableSkill(root, "foo", await fingerprintTree(disabled));
    await expectMissing(disabled);
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectOutsideUnchanged();
    const lockAfter = await lstat(lockFile);
    expect([lockAfter.ino, lockAfter.mode, lockAfter.mtimeMs]).toEqual([
      lockBefore.ino, lockBefore.mode, lockBefore.mtimeMs,
    ]);
  });

  it("keeps using the approved target when a selected root link is retargeted", async () => {
    const selectedLink = join(sandbox, "chosen-link");
    await symlink(skillsDir, selectedLink, "dir");
    const approvedRoot = await approveSkillsRoot(await realpath(selectedLink));
    const selectedEntry = join(approvedRoot.path, "foo");
    const version = await fingerprintTree(selectedEntry);
    await unlink(selectedLink);
    await symlink(outside, selectedLink, "dir");

    await disableSkill(approvedRoot, "foo", version);

    await expectMissing(join(skillsDir, "foo"));
    await expect(readFile(join(skillsDir, ".disabled_skills", "foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    expect(await readlink(selectedLink)).toBe(outside);
    await expectOutsideUnchanged();
  });

  it("rejects a replacement directory at the approved root path before writing manager state", async () => {
    const originalRoot = join(sandbox, "original-selected-skills");
    await rename(skillsDir, originalRoot);
    await mkdir(join(skillsDir, "foo"), { recursive: true });
    await writeFile(join(skillsDir, "foo", "SKILL.md"), "replacement root content");
    const replacementVersion = await fingerprintTree(join(skillsDir, "foo"));

    await expect(disableSkill(root, "foo", replacementVersion)).rejects.toThrow();

    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe("replacement root content");
    await expect(readFile(join(originalRoot, "foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectMissing(join(skillsDir, ".disabled_skills"));
    await expectOutsideUnchanged();
  });

  it("preserves nested and dangling links without changing their targets", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const missingTarget = join(sandbox, "missing-target");
    await symlink(outside, join(enabled, "outside-link"), "dir");
    await symlink(missingTarget, join(enabled, "dangling-link"));

    await disableSkill(root, "foo", await fingerprintTree(enabled));
    expect(await readlink(join(disabled, "outside-link"))).toBe(outside);
    expect(await readlink(join(disabled, "dangling-link"))).toBe(missingTarget);
    await expectOutsideUnchanged();

    await enableSkill(root, "foo", await fingerprintTree(disabled));
    expect(await readlink(join(enabled, "outside-link"))).toBe(outside);
    expect(await readlink(join(enabled, "dangling-link"))).toBe(missingTarget);
    await expectMissing(missingTarget);
    await expectOutsideUnchanged();
  });

  it.each(["outside", "dangling"])("moves a %s leaf link itself, never its target", async (kind) => {
    const target = kind === "outside" ? outside : join(sandbox, "missing-target");
    const enabled = join(skillsDir, "linked");
    const disabled = join(skillsDir, ".disabled_skills", "linked");
    await symlink(target, enabled, "dir");

    await disableSkill(root, "linked", await fingerprintTree(enabled));
    await expectMissing(enabled);
    expect(await readlink(disabled)).toBe(target);
    await enableSkill(root, "linked", await fingerprintTree(disabled));
    await expectMissing(disabled);
    expect(await readlink(enabled)).toBe(target);
    await expectOutsideUnchanged();
    if (kind === "dangling") await expectMissing(target);
  });

  it("rejects a skill whose contents changed after review", async () => {
    const enabled = join(skillsDir, "foo");
    const version = await fingerprintTree(enabled);
    await writeFile(join(enabled, "SKILL.md"), "changed after review");

    await expect(disableSkill(root, "foo", version)).rejects.toThrow();
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe("changed after review");
    await expectMissing(join(skillsDir, ".disabled_skills", "foo"));
    await expectOutsideUnchanged();
  });

  it("rejects a replacement entry even when its contents match the reviewed entry", async () => {
    const enabled = join(skillsDir, "foo");
    const version = await fingerprintTree(enabled);
    await rename(enabled, join(skillsDir, "original-foo"));
    await mkdir(enabled);
    await writeFile(join(enabled, "SKILL.md"), originalSkill);

    await expect(disableSkill(root, "foo", version)).rejects.toThrow();
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expect(readFile(join(skillsDir, "original-foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectMissing(join(skillsDir, ".disabled_skills", "foo"));
  });

  it("rejects enabling a disabled skill changed after review", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    await disableSkill(root, "foo", await fingerprintTree(enabled));
    const version = await fingerprintTree(disabled);
    await writeFile(join(disabled, "SKILL.md"), "edited while disabled");

    await expect(enableSkill(root, "foo", version)).rejects.toThrow();
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe("edited while disabled");
    await expectMissing(enabled);
  });

  it.each(["file", "directory", "symlink", "dangling"])(
    "does not overwrite a %s at the disabled destination",
    async (kind) => {
      const enabled = join(skillsDir, "foo");
      const disabledDir = join(skillsDir, ".disabled_skills");
      const destination = join(disabledDir, "foo");
      await mkdir(disabledDir);
      if (kind === "file") await writeFile(destination, "destination file");
      if (kind === "directory") {
        await mkdir(destination);
        await writeFile(join(destination, "sentinel"), "destination directory");
      }
      if (kind === "symlink") await symlink(outside, destination, "dir");
      if (kind === "dangling") await symlink(join(sandbox, "missing-target"), destination);
      const before = await lstat(destination);

      await expect(disableSkill(root, "foo", await fingerprintTree(enabled))).rejects.toThrow();
      const after = await lstat(destination);
      expect([after.ino, after.mode]).toEqual([before.ino, before.mode]);
      if (kind === "file") await expect(readFile(destination, "utf8")).resolves.toBe("destination file");
      if (kind === "directory") await expect(readFile(join(destination, "sentinel"), "utf8")).resolves.toBe("destination directory");
      if (kind === "symlink") expect(await readlink(destination)).toBe(outside);
      if (kind === "dangling") expect(await readlink(destination)).toBe(join(sandbox, "missing-target"));
      await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
      await expectOutsideUnchanged();
    },
  );

  it("does not overwrite an existing enabled destination", async () => {
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    await mkdir(disabled, { recursive: true });
    await writeFile(join(disabled, "SKILL.md"), "disabled copy");

    await expect(enableSkill(root, "foo", await fingerprintTree(disabled))).rejects.toThrow();
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe("disabled copy");
    await expectOutsideUnchanged();
  });

  it("rejects a symlink in place of the disabled directory", async () => {
    await symlink(outside, join(skillsDir, ".disabled_skills"), "dir");
    const enabled = join(skillsDir, "foo");

    await expect(disableSkill(root, "foo", await fingerprintTree(enabled))).rejects.toThrow();
    expect(await readlink(join(skillsDir, ".disabled_skills"))).toBe(outside);
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectMissing(join(outside, "foo"));
    await expectOutsideUnchanged();
  });

  it("rejects enabling through a symlinked disabled directory", async () => {
    const disabledDir = join(skillsDir, ".disabled_skills");
    const reviewedSkill = join(disabledDir, "linked");
    const outsideSkill = join(outside, "linked");
    await mkdir(reviewedSkill, { recursive: true });
    await writeFile(join(reviewedSkill, "SKILL.md"), "reviewed content");
    const version = await fingerprintTree(reviewedSkill);
    await rename(reviewedSkill, outsideSkill);
    await rm(disabledDir, { recursive: true });
    await symlink(outside, disabledDir, "dir");

    await expect(enableSkill(root, "linked", version)).rejects.toThrow();
    await expect(readFile(join(outsideSkill, "SKILL.md"), "utf8")).resolves.toBe("reviewed content");
    await expectMissing(join(skillsDir, "linked"));
    await expectOutsideUnchanged(["linked"]);
  });

  it("does not adopt or change an unowned manager directory", async () => {
    const manager = join(skillsDir, ".skills-manager");
    await mkdir(manager);
    await writeFile(join(manager, "sentinel"), "not manager-owned");
    const enabled = join(skillsDir, "foo");

    await expect(disableSkill(root, "foo", await fingerprintTree(enabled))).rejects.toThrow();
    await expect(readFile(join(manager, "sentinel"), "utf8")).resolves.toBe("not manager-owned");
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectOutsideUnchanged();
  });

  it("rejects a manager-directory symlink without writing to its target", async () => {
    const manager = join(skillsDir, ".skills-manager");
    const enabled = join(skillsDir, "foo");
    await symlink(outside, manager, "dir");

    await expect(disableSkill(root, "foo", await fingerprintTree(enabled))).rejects.toThrow();
    expect(await readlink(manager)).toBe(outside);
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectOutsideUnchanged();
  });

  it("rejects a traversal source even when its fingerprint matches", async () => {
    const outsideVersion = await fingerprintTree(outside);
    await expect(disableSkill(root, "../outside", outsideVersion)).rejects.toThrow();
    await expect(disableSkill(root, outside, outsideVersion)).rejects.toThrow();
    await expectOutsideUnchanged();

    const source = join(skillsDir, "wander");
    await mkdir(join(skillsDir, ".disabled_skills"), { recursive: true });
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "must remain inside");
    await expect(enableSkill(root, "../wander", await fingerprintTree(source))).rejects.toThrow();
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe("must remain inside");
    await expectMissing(join(sandbox, "wander"));
  });

  it.each(["", ".", "..", "../outside", "foo/../outside", ".git", ".disabled_skills", ".skills-manager"])(
    "rejects traversal or reserved name %j",
    async (name) => {
      const version = await fingerprintTree(join(skillsDir, "foo"));
      await expect(disableSkill(root, name, version)).rejects.toThrow();
      await expect(enableSkill(root, name, version)).rejects.toThrow();
      await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
      await expectOutsideUnchanged();
    },
  );

  it("rejects missing source entries in both directions", async () => {
    const version = await fingerprintTree(join(skillsDir, "foo"));
    await expect(disableSkill(root, "missing", version)).rejects.toThrow();
    await expect(enableSkill(root, "missing", version)).rejects.toThrow();
    await expectOutsideUnchanged();
  });
});

describe("manager state and recovery", () => {
  it("does not create manager state when there is nothing to recover", async () => {
    const before = (await readdir(skillsDir)).sort();

    await recoverSkills(root);

    expect((await readdir(skillsDir)).sort()).toEqual(before);
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectOutsideUnchanged();
  });

  it.each(["directory", "file", "symlink"] as const)(
    "does not disturb a foreign manager %s during mutation or recovery",
    async (kind) => {
      const enabled = join(skillsDir, "foo");
      const manager = join(skillsDir, ".skills-manager");
      const version = await fingerprintTree(enabled);
      if (kind === "directory") {
        await mkdir(manager);
        await writeFile(join(manager, "sentinel"), "foreign manager data");
      }
      if (kind === "file") await writeFile(manager, "foreign manager file");
      if (kind === "symlink") await symlink(outside, manager, "dir");
      const before = await lstat(manager);
      const rootEntries = (await readdir(skillsDir)).sort();

      await expect(disableSkill(root, "foo", version)).rejects.toThrow();
      await expect(recoverSkills(root)).rejects.toThrow();

      expect((await readdir(skillsDir)).sort()).toEqual(rootEntries);
      expect((await lstat(manager)).ino).toBe(before.ino);
      if (kind === "directory") {
        await expect(readFile(join(manager, "sentinel"), "utf8")).resolves.toBe("foreign manager data");
      }
      if (kind === "file") await expect(readFile(manager, "utf8")).resolves.toBe("foreign manager file");
      if (kind === "symlink") expect(await readlink(manager)).toBe(outside);
      await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
      await expectMissing(join(skillsDir, ".disabled_skills", "foo"));
      await expectOutsideUnchanged();
    },
  );

  it("preserves the source when a file blocks creation of the disabled directory", async () => {
    const enabled = join(skillsDir, "foo");
    const disabledDir = join(skillsDir, ".disabled_skills");
    const version = await fingerprintTree(enabled);
    const before = await lstat(enabled);
    await writeFile(disabledDir, "user-owned obstruction");
    const obstruction = await lstat(disabledDir);

    await expect(disableSkill(root, "foo", version)).rejects.toThrow();
    await recoverSkills(root);

    expect((await lstat(enabled)).ino).toBe(before.ino);
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    expect((await lstat(disabledDir)).ino).toBe(obstruction.ino);
    await expect(readFile(disabledDir, "utf8")).resolves.toBe("user-owned obstruction");
    await expectOutsideUnchanged();

    await unlink(disabledDir);
    await disableSkill(root, "foo", version);
    await expectMissing(enabled);
    await expect(readFile(join(disabledDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await recoverSkills(root);
    await recoverSkills(root);
    await expectOutsideUnchanged();
  });

  it("allows a toggle inside the selected root's existing lock", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");

    await withSkillsLock(root, async () => {
      await disableSkill(root, "foo", await fingerprintTree(enabled));
      await enableSkill(root, "foo", await fingerprintTree(disabled));
    });

    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectMissing(disabled);
    await expectOutsideUnchanged();
  });

  it("serializes independent callers using the same approved root", async () => {
    const order: string[] = [];
    const { promise: firstEntered, resolve: entered } = Promise.withResolvers<void>();
    const { promise: firstReleased, resolve: release } = Promise.withResolvers<void>();
    const first = withSkillsLock(root, async () => {
      order.push("first entered");
      entered();
      await firstReleased;
      order.push("first finished");
    });
    await firstEntered;
    const second = withSkillsLock(root, async () => {
      order.push("second entered");
      await disableSkill(root, "foo", await fingerprintTree(join(skillsDir, "foo")));
    });
    release();

    await Promise.all([first, second]);

    expect(order).toEqual(["first entered", "first finished", "second entered"]);
    await expectMissing(join(skillsDir, "foo"));
    await expect(readFile(join(skillsDir, ".disabled_skills", "foo", "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectOutsideUnchanged();
  });

  it("leaves ambiguous bootstrap state intact and refuses to start a mutation", async () => {
    const enabled = join(skillsDir, "foo");
    const version = await fingerprintTree(enabled);
    const orphan = join(skillsDir, ".skills-manager-bootstrap-00000000000000000000000000000000");
    await mkdir(orphan);
    await writeFile(join(orphan, "user-sentinel"), "preserve orphan data");
    const before = await lstat(orphan);
    const entries = (await readdir(skillsDir)).sort();

    await expect(recoverSkills(root)).rejects.toThrow();
    await expect(disableSkill(root, "foo", version)).rejects.toThrow();

    expect((await readdir(skillsDir)).sort()).toEqual(entries);
    expect((await lstat(orphan)).ino).toBe(before.ino);
    expect(await readdir(orphan)).toEqual(["user-sentinel"]);
    await expect(readFile(join(orphan, "user-sentinel"), "utf8")).resolves.toBe("preserve orphan data");
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectMissing(join(skillsDir, ".disabled_skills", "foo"));
    await expectOutsideUnchanged();
  });

  it("refuses an ambiguous legacy journal without discarding it or moving the skill", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const version = await fingerprintTree(enabled);
    await withSkillsLock(root, async () => {});
    const manager = join(skillsDir, ".skills-manager");
    const journal = join(manager, "journal");
    const legacyBytes = Buffer.from([0x53, 0x4d, 0x00, 0xff, 0x01, 0x00]);
    await writeFile(journal, legacyBytes, { flag: "wx", mode: 0o600 });
    const before = await lstat(journal);
    const entries = (await readdir(manager)).sort();

    await expect(recoverSkills(root)).rejects.toThrow();
    await expect(disableSkill(root, "foo", version)).rejects.toThrow();

    expect((await readdir(manager)).sort()).toEqual(entries);
    const after = await lstat(journal);
    expect([after.ino, after.mode, after.mtimeMs]).toEqual([before.ino, before.mode, before.mtimeMs]);
    await expect(readFile(journal)).resolves.toEqual(legacyBytes);
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectMissing(disabled);
    await expectOutsideUnchanged();

    await unlink(journal);
    await recoverSkills(root);
    await disableSkill(root, "foo", version);
    await expectMissing(enabled);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectOutsideUnchanged();
  });

  it("releases the selected root's lock after a rejected toggle", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const version = await fingerprintTree(enabled);
    await writeFile(join(enabled, "SKILL.md"), "changed after review");

    await expect(disableSkill(root, "foo", version)).rejects.toThrow();
    await disableSkill(root, "foo", await fingerprintTree(enabled));

    await expectMissing(enabled);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe("changed after review");
    await expectOutsideUnchanged();
  });
});

