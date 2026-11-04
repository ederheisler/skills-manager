import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { approveSkillsRoot, fingerprintSkill, fingerprintTree, recoverSkills, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
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

describe("atomic manager state bootstrap", () => {
  const faults = [
    "bootstrap-after-mkdir",
    "bootstrap-after-owner",
    "bootstrap-after-lock",
    "bootstrap-before-publish",
    "bootstrap-after-publish",
  ] as const;
  type BootstrapFault = typeof faults[number];
  let faultProject = "";

  beforeAll(async () => {
    faultProject = await realpath(await mkdtemp(join(tmpdir(), "skills-bootstrap-helper-")));
    const actionsDir = join(faultProject, "src", "actions");
    const nativeDir = join(faultProject, "native");
    await mkdir(actionsDir, { recursive: true });
    await mkdir(nativeDir);
    const sourceActions = new URL("../../src/actions/", import.meta.url);
    await Promise.all(["boundary.ts", "toggle.ts"].map((name) =>
      copyFile(new URL(name, sourceActions), join(actionsDir, name)),
    ));
    await writeFile(join(faultProject, "package.json"), '{"type":"module"}\n');
    await writeFile(join(nativeDir, "skills-boundary.platform.json"), JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      libc: process.platform === "linux" ? "glibc" : null,
    }) + "\n");

    const source = fileURLToPath(new URL("../../native/skills-boundary.c", import.meta.url));
    const compiler = spawn(process.env.CC || "cc", [
      "-std=c11", "-O2", "-D_POSIX_C_SOURCE=200809L", "-Wall", "-Wextra", "-Wpedantic",
      "-DSKILLS_MANAGER_TEST_FAULTS=1", source, "-o", join(nativeDir, "skills-boundary"),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    compiler.stderr.setEncoding("utf8");
    compiler.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const [code, signal] = await once(compiler, "close") as [number | null, NodeJS.Signals | null];
    if (code !== 0 || signal) throw new Error(`Cannot build disposable bootstrap helper (${signal ?? code}): ${stderr}`);
  }, 60000);

  afterAll(async () => {
    if (faultProject) await rm(faultProject, { recursive: true, force: true });
  });

  async function runBootstrap(fault: BootstrapFault, version: string, instrumented = true) {
    const moduleUrl = instrumented
      ? pathToFileURL(join(faultProject, "src", "actions", "toggle.ts")).href
      : new URL("../../src/actions/toggle.ts", import.meta.url).href;
    const program = `import { disableSkill } from ${JSON.stringify(moduleUrl)}; await disableSkill(JSON.parse(process.argv[1]), "foo", process.argv[2]);`;
    const child = spawn("node", ["--import", "tsx", "--input-type=module", "--eval", program, JSON.stringify(root), version], {
      env: { ...process.env, SKILLS_BOUNDARY_FAULT: fault },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    return { code, signal, stderr };
  }

  it.each(faults)("recovers safely after a crash at %s", async (fault) => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const manager = join(skillsDir, ".skills-manager");
    const version = await fingerprintSkill(root, "foo", enabled);
    const original = await lstat(enabled);

    const result = await runBootstrap(fault, version);

    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toMatch(/\bstatus 86\b/);
    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    expect((await lstat(enabled)).ino).toBe(original.ino);
    await expectMissing(disabled);
    await expectOutsideUnchanged();

    const published = fault === "bootstrap-after-publish";
    const extraEntries = (await readdir(skillsDir)).filter((name) => name !== "foo" && name !== ".skills-manager");
    let orphan: string | undefined;
    let orphanInode: number | undefined;
    let orphanEntries: string[] = [];
    let managerInode: number | undefined;
    if (published) {
      expect(extraEntries).toEqual([]);
      const state = await lstat(manager);
      expect(state.isDirectory()).toBe(true);
      managerInode = state.ino;
    } else {
      await expectMissing(manager);
      expect(extraEntries).toHaveLength(1);
      orphan = join(skillsDir, extraEntries[0]);
      const state = await lstat(orphan);
      expect(state.isDirectory()).toBe(true);
      orphanInode = state.ino;
      await writeFile(join(orphan, "user-sentinel"), "preserve orphan data");
      orphanEntries = (await readdir(orphan)).sort();
    }

    await recoverSkills(root);
    if (orphan) {
      expect((await lstat(orphan)).ino).toBe(orphanInode);
      expect((await readdir(orphan)).sort()).toEqual(orphanEntries);
      await expect(readFile(join(orphan, "user-sentinel"), "utf8")).resolves.toBe("preserve orphan data");
    }
    await disableSkill(root, "foo", version);

    await expectMissing(enabled);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    if (orphan) {
      expect((await lstat(orphan)).ino).toBe(orphanInode);
      expect((await readdir(orphan)).sort()).toEqual(orphanEntries);
      await expect(readFile(join(orphan, "user-sentinel"), "utf8")).resolves.toBe("preserve orphan data");
    }
    if (published) expect((await lstat(manager)).ino).toBe(managerInode);
    await expectOutsideUnchanged();
  }, 30000);

  it.each(faults)("does not activate %s injection in the normal helper", async (fault) => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const version = await fingerprintSkill(root, "foo", enabled);

    const result = await runBootstrap(fault, version, false);

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    await expectMissing(enabled);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expectOutsideUnchanged();
  }, 30000);

  it.each(["directory", "file", "symlink"] as const)(
    "does not disturb a foreign manager %s while bootstrap faults are enabled",
    async (kind) => {
      const enabled = join(skillsDir, "foo");
      const manager = join(skillsDir, ".skills-manager");
      const version = await fingerprintSkill(root, "foo", enabled);
      if (kind === "directory") {
        await mkdir(manager);
        await writeFile(join(manager, "sentinel"), "foreign manager data");
      }
      if (kind === "file") await writeFile(manager, "foreign manager file");
      if (kind === "symlink") await symlink(outside, manager, "dir");
      const before = await lstat(manager);
      const rootEntries = (await readdir(skillsDir)).sort();

      const result = await runBootstrap("bootstrap-after-mkdir", version);

      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).not.toMatch(/\bstatus 86\b/);
      expect(result.stderr).toMatch(/reserved|\.skills-manager/i);
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
    30000,
  );
});
