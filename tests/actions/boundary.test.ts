import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { approveSkillsRoot, countSkillPathLines, directoryIdentity, fingerprintContents, fingerprintSkill, fingerprintSkillContents, fingerprintTree, hasIndexTransaction, importSkill, listSkillPaths, readManagedMetadata, readSkillPath, recoverSkills, removeDisposableTree, withSkillsLock, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { commitSelected, previewCommit } from "../../src/actions/git.js";
import { removeManagedSkill } from "../../src/actions/remove.js";
import { disableSkill, enableSkill } from "../../src/actions/toggle.js";

let sandbox: string;
let skillsDir: string;
let root: ApprovedSkillsRoot;
let outside: string;
let faultProject = "";
const skillContents = "---\nname: foo\n---\noriginal\n";
const lockContents = '{"version":3,"skills":{"foo":{"source":"owner/repo"}}}\n';

beforeAll(async () => {
  faultProject = await realpath(await mkdtemp(join(tmpdir(), "skills-fault-helper-")));
  const actionsDir = join(faultProject, "src", "actions");
  const nativeDir = join(faultProject, "native");
  await mkdir(actionsDir, { recursive: true });
  await mkdir(nativeDir);
  const sourceActions = new URL("../../src/actions/", import.meta.url);
  await Promise.all(["boundary.ts", "toggle.ts", "remove.ts"].map((name) =>
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
  if (code !== 0 || signal) throw new Error(`Cannot build disposable fault helper (${signal ?? code}): ${stderr}`);
}, 60000);

afterAll(async () => {
  if (faultProject) await rm(faultProject, { recursive: true, force: true });
});

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "skills-boundary-")));
  skillsDir = join(sandbox, "selected-skills");
  outside = join(sandbox, "outside");
  await mkdir(join(skillsDir, "foo"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(skillsDir, "foo", "SKILL.md"), skillContents);
  await writeFile(join(outside, "sentinel"), "outside stays unchanged");
  await writeFile(join(sandbox, ".skill-lock.json"), lockContents);
  root = await approveSkillsRoot(skillsDir);
  skillsDir = root.path;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function entrySnapshot(path: string): Promise<number[]> {
  const entry = await lstat(path);
  return [entry.dev, entry.ino, entry.mode, entry.nlink, entry.size, entry.mtimeMs, entry.ctimeMs];
}

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return execFileSync("git", args, {
    cwd: skillsDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

async function expectOutsideUnchanged(): Promise<void> {
  await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside stays unchanged");
  expect(await readdir(outside)).toEqual(["sentinel"]);
  await expect(readFile(join(sandbox, ".skill-lock.json"), "utf8")).resolves.toBe(lockContents);
}

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stderr: string };
type Operation = "disable" | "remove" | "import" | "index-check" | "recover";
type Fault = "after-intent" | "after-move" | "after-commit" | "rename" | "journal-write" | "journal-replace";

// Each caller is a separate Node process; each wrapper in turn invokes the real native helper.
async function runOperation(operation: Operation, args: string[], fault?: Fault, instrumented = fault !== undefined): Promise<ChildResult> {
  const source = operation === "disable" ? "toggle" : operation === "remove" ? "remove" : "boundary";
  const moduleUrl = instrumented
    ? pathToFileURL(join(faultProject, "src", "actions", `${source}.ts`)).href
    : new URL(`../../src/actions/${source}.ts`, import.meta.url).href;
  const symbol = operation === "disable"
    ? "disableSkill"
    : operation === "remove"
      ? "removeManagedSkill"
      : operation === "import" ? "importSkill" : operation === "recover" ? "recoverSkills" : "withSkillsLock, hasIndexTransaction";
  const call = operation === "disable"
    ? "await disableSkill(root, process.argv[2], process.argv[3]);"
    : operation === "remove"
      ? "await removeManagedSkill(root, process.argv[2], process.argv[3], process.argv[4]);"
      : operation === "import"
        ? "await importSkill(root, process.argv[2], process.argv[3], { replace: true, expectedPath: process.argv[4], expectedVersion: process.argv[5], expectedStagedVersion: process.argv[6] });"
        : operation === "recover"
          ? "await recoverSkills(root);"
          : "if (!(await withSkillsLock(root, () => hasIndexTransaction(root)))) throw new Error('Pending index transaction not detected');";
  const program = `import { ${symbol} } from ${JSON.stringify(moduleUrl)}; const root = JSON.parse(process.argv[1]); ${call}`;
  const env = { ...process.env };
  delete env.SKILLS_BOUNDARY_FAULT;
  if (fault !== undefined) env.SKILLS_BOUNDARY_FAULT = fault;

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program, JSON.stringify(root), ...args], {
    env,
    detached: operation === "recover",
    timeout: operation === "index-check" ? 10000 : undefined,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  // A real deadline is needed to terminate a blocked native helper and its caller.
  const timer = operation === "recover" ? setTimeout(() => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }, 5000) : undefined;
  try {
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    return { code, signal, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("disposable workspaces", () => {
  it("cleans the identified workspace when an unrelated sibling appears", async () => {
    const workspace = join(sandbox, "workspace");
    const sibling = join(sandbox, ".skills-manager-test-sibling");
    await mkdir(workspace);
    await writeFile(join(workspace, "staged.txt"), "temporary content");
    const token = JSON.parse(await directoryIdentity(workspace)) as { identity: string };
    const child = spawn(join(faultProject, "native", "skills-boundary"), ["dispose", workspace, token.identity], {
      env: { ...process.env, SKILLS_BOUNDARY_FAULT: "dispose-parent-sibling" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    expect({ code, signal, stdout, stderr }).toEqual({ code: 0, signal: null, stdout: "READY\n", stderr: "" });
    await expectMissing(workspace);
    expect(await readdir(sibling)).toEqual([]);
    await expectOutsideUnchanged();
  });

  it("refuses to dispose a replacement workspace", async () => {
    const workspace = join(sandbox, "workspace");
    const original = join(sandbox, "original-workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "staged.txt"), "original workspace");
    const token = await directoryIdentity(workspace);
    await rename(workspace, original);
    await mkdir(workspace);
    await writeFile(join(workspace, "sentinel"), "replacement remains");

    await expect(removeDisposableTree(workspace, token)).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(join(workspace, "sentinel"), "utf8")).resolves.toBe("replacement remains");
    await expect(readFile(join(original, "staged.txt"), "utf8")).resolves.toBe("original workspace");
    await expectOutsideUnchanged();
  });
});

describe("cross-process mutation and recovery", () => {
  it("does not create manager state merely by recovering an untouched directory", async () => {
    await recoverSkills(root);
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
  });

  it.each(["journal", "owner"] as const)("promptly refuses a FIFO %s without changing controlled state", async (name) => {
    await withSkillsLock(root, async () => {});
    await expect(recoverSkills(root)).resolves.toBeUndefined();
    const manager = join(skillsDir, ".skills-manager");
    const owner = join(manager, "owner");
    const lock = join(manager, "lock");
    const fifo = join(manager, name);
    if (name === "owner") await unlink(owner);
    execFileSync("mkfifo", [fifo]);
    await chmod(fifo, 0o600);
    expect((await lstat(fifo)).isFIFO()).toBe(true);

    const paths = [skillsDir, manager, owner, lock, fifo, join(skillsDir, "foo"), join(skillsDir, "foo", "SKILL.md")];
    const before = await Promise.all(paths.map(entrySnapshot));
    const rootEntries = (await readdir(skillsDir)).sort();
    const stateEntries = (await readdir(manager)).sort();
    const ownerBytes = name === "journal" ? await readFile(owner) : null;
    const lockBytes = await readFile(lock);

    const result = await runOperation("recover", []);

    expect(result.signal, result.stderr).toBeNull();
    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(name === "journal" ? /journal/i : /controlled.state|owned|marker/i);
    expect((await lstat(fifo)).isFIFO()).toBe(true);
    expect(await Promise.all(paths.map(entrySnapshot))).toEqual(before);
    expect((await readdir(skillsDir)).sort()).toEqual(rootEntries);
    expect((await readdir(manager)).sort()).toEqual(stateEntries);
    if (ownerBytes !== null) expect(await readFile(owner)).toEqual(ownerBytes);
    expect(await readFile(lock)).toEqual(lockBytes);
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  }, 15000);

  it("serializes simultaneous callers from separate processes without losing any move", async () => {
    const names = ["foo", "one", "two", "three", "four", "five"];
    for (const name of names.slice(1)) {
      await mkdir(join(skillsDir, name));
      await writeFile(join(skillsDir, name, "SKILL.md"), `contents for ${name}`);
    }
    const versions = await Promise.all(names.map((name) => fingerprintTree(join(skillsDir, name))));

    const results = await Promise.all(names.map((name, index) =>
      runOperation("disable", [name, versions[index]]),
    ));

    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    for (const name of names) {
      await expectMissing(join(skillsDir, name));
      await expect(readFile(join(skillsDir, ".disabled_skills", name, "SKILL.md"), "utf8"))
        .resolves.toBe(name === "foo" ? skillContents : `contents for ${name}`);
    }
    await recoverSkills(root);
    await expectOutsideUnchanged();
  }, 30000);

  it("allows exactly one of several processes to move the same reviewed entry", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const version = await fingerprintTree(enabled);

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      runOperation("disable", ["foo", version]),
    ));

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code !== 0 && result.signal === null)).toHaveLength(3);
    await expectMissing(enabled);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await recoverSkills(root);
    await expectOutsideUnchanged();
  }, 30000);

  it.each(["after-intent", "after-move", "after-commit", "rename", "journal-write", "journal-replace"] as const)(
    "does not activate %s injection in the normal helper",
    async (fault) => {
      const enabled = join(skillsDir, "foo");
      const disabled = join(skillsDir, ".disabled_skills", "foo");
      const version = await fingerprintTree(enabled);

      const result = await runOperation("disable", ["foo", version], fault, false);

      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      await expectMissing(enabled);
      await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
      await expectOutsideUnchanged();
    },
    30000,
  );

  it.each(["rename", "journal-write", "journal-replace"] as const)(
    "reports %s failure, preserves the old state, and can recover for the next operation",
    async (fault) => {
      const enabled = join(skillsDir, "foo");
      const disabled = join(skillsDir, ".disabled_skills", "foo");
      await symlink(outside, join(enabled, "outside-link"), "dir");
      const version = await fingerprintTree(enabled);

      const result = await runOperation("disable", ["foo", version], fault);
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain(fault);
      await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
      expect(await readlink(join(enabled, "outside-link"))).toBe(outside);
      await expectMissing(disabled);
      await expectOutsideUnchanged();

      const recovery = await recoverSkills(root);
      if (fault === "journal-replace") expect(recovery).toMatch(/recover/i);
      await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
      await expectMissing(disabled);
      await expectOutsideUnchanged();

      await disableSkill(root, "foo", version);
      await expectMissing(enabled);
      await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
      expect(await readlink(join(disabled, "outside-link"))).toBe(outside);
      await expectOutsideUnchanged();
    },
    30000,
  );

  it.each([
    ["after-intent", false],
    ["after-move", false],
    ["after-commit", true],
  ] as const)("recovers a failed disable at %s (committed: %s)", async (fault, committed) => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    await symlink(outside, join(enabled, "outside-link"), "dir");
    const version = await fingerprintTree(enabled);

    const result = await runOperation("disable", ["foo", version], fault);
    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toMatch(/\b86\b/);
    await recoverSkills(root);
    await recoverSkills(root);

    const remaining = committed ? disabled : enabled;
    const absent = committed ? enabled : disabled;
    await expectMissing(absent);
    await expect(readFile(join(remaining, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    expect(await readlink(join(remaining, "outside-link"))).toBe(outside);
    await expectOutsideUnchanged();
  }, 30000);

  it("reports an ambiguous recovery rather than overwriting a newly created entry", async () => {
    const enabled = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    const version = await fingerprintTree(enabled);
    const result = await runOperation("disable", ["foo", version], "after-move");
    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toMatch(/\b86\b/);
    await mkdir(enabled);
    await writeFile(join(enabled, "SKILL.md"), "new entry created after the crash");

    await expect(recoverSkills(root)).rejects.toThrow();
    await expect(recoverSkills(root)).rejects.toThrow();

    await expect(readFile(join(enabled, "SKILL.md"), "utf8")).resolves.toBe("new entry created after the crash");
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  }, 30000);

  it.each([
    ["after-intent", false],
    ["after-move", false],
    ["after-commit", true],
  ] as const)("recovers a failed removal at %s (committed: %s)", async (fault, committed) => {
    const skill = join(skillsDir, "foo");
    await symlink(outside, join(skill, "outside-link"), "dir");
    const version = await fingerprintTree(skill);

    const result = await runOperation("remove", ["foo", skill, version], fault);
    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toMatch(/\b86\b/);
    await recoverSkills(root);
    await recoverSkills(root);

    if (committed) {
      await expectMissing(skill);
    } else {
      await expect(readFile(join(skill, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
      expect(await readlink(join(skill, "outside-link"))).toBe(outside);
    }
    await expectOutsideUnchanged();
  }, 30000);
});

describe("pending Git index transactions", () => {
  it("reports no transaction in a fresh root without creating any entries", async () => {
    const before = (await readdir(skillsDir)).sort();

    await expect(hasIndexTransaction(root)).resolves.toBe(false);

    expect((await readdir(skillsDir)).sort()).toEqual(before);
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });

  it.each(["git-transaction-journal", "git-transaction-journal.next", "git-transaction-journal.delete"])("blocks mutations while %s is pending", async (journalName) => {
    const enabledFoo = join(skillsDir, "foo");
    const disabledFoo = join(skillsDir, ".disabled_skills", "foo");
    await disableSkill(root, "foo", await fingerprintTree(enabledFoo));
    const enabledBar = join(skillsDir, "bar");
    const disabledBar = join(skillsDir, ".disabled_skills", "bar");
    await mkdir(enabledBar);
    await writeFile(join(enabledBar, "SKILL.md"), "bar content");
    const fooVersion = await fingerprintTree(disabledFoo);
    const barVersion = await fingerprintTree(enabledBar);
    const journal = join(skillsDir, ".skills-manager", journalName);
    await writeFile(journal, "pending transaction", { flag: "wx", mode: 0o600 });
    await chmod(journal, 0o600);
    const journalBefore = await lstat(journal);

    await expect(hasIndexTransaction(root)).resolves.toBe(true);
    const nested = await runOperation("index-check", []);
    expect(nested, nested.stderr).toMatchObject({ code: 0, signal: null });
    await expect(enableSkill(root, "foo", fooVersion)).rejects.toMatchObject({ code: "EBUSY" });
    await expect(disableSkill(root, "bar", barVersion)).rejects.toMatchObject({ code: "EBUSY" });
    await expect(removeManagedSkill(root, "bar", enabledBar, barVersion)).rejects.toMatchObject({ code: "EBUSY" });

    await expectMissing(enabledFoo);
    await expectMissing(disabledBar);
    await expect(readFile(join(disabledFoo, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expect(readFile(join(enabledBar, "SKILL.md"), "utf8")).resolves.toBe("bar content");
    await expect(readFile(journal, "utf8")).resolves.toBe("pending transaction");
    const journalAfter = await lstat(journal);
    expect([journalAfter.ino, journalAfter.mode, journalAfter.mtimeMs]).toEqual([
      journalBefore.ino, journalBefore.mode, journalBefore.mtimeMs,
    ]);
    await expectOutsideUnchanged();

    await unlink(journal);
    await expect(hasIndexTransaction(root)).resolves.toBe(false);
    await enableSkill(root, "foo", fooVersion);
    await disableSkill(root, "bar", barVersion);
    await removeManagedSkill(root, "foo", enabledFoo, await fingerprintTree(enabledFoo));
    await expectMissing(enabledFoo);
    await expectMissing(disabledFoo);
    await expectMissing(enabledBar);
    await expect(readFile(join(disabledBar, "SKILL.md"), "utf8")).resolves.toBe("bar content");
    await expectOutsideUnchanged();
  }, 30000);

  it.each(["manager-symlink", "foreign-directory", "foreign-file", "journal-symlink"] as const)(
    "rejects an unsafe %s without touching external or unowned data",
    async (kind) => {
      const manager = join(skillsDir, ".skills-manager");
      const journal = join(manager, "git-transaction-journal");
      if (kind === "manager-symlink") await symlink(outside, manager, "dir");
      if (kind === "foreign-directory") {
        await mkdir(manager);
        await writeFile(join(manager, "sentinel"), "foreign manager data");
      }
      if (kind === "foreign-file") await writeFile(manager, "foreign manager file");
      if (kind === "journal-symlink") {
        const skill = join(skillsDir, "foo");
        await disableSkill(root, "foo", await fingerprintTree(skill));
        await symlink(join(outside, "sentinel"), journal);
      }

      await expect(hasIndexTransaction(root)).rejects.toThrow();

      if (kind === "manager-symlink") expect(await readlink(manager)).toBe(outside);
      if (kind === "foreign-directory") {
        await expect(readFile(join(manager, "sentinel"), "utf8")).resolves.toBe("foreign manager data");
      }
      if (kind === "foreign-file") await expect(readFile(manager, "utf8")).resolves.toBe("foreign manager file");
      if (kind === "journal-symlink") expect(await readlink(journal)).toBe(join(outside, "sentinel"));
      await expectOutsideUnchanged();
    },
  );
});

describe("reserved root metadata", () => {
  it.for([
    [".git", ".GIT", "disable"],
    [".git", ".GIT", "remove"],
    [".git", ".GIT", "replace"],
    [".disabled_skills", ".DISABLED_SKILLS", "remove"],
    [".skills-manager", ".SKILLS-MANAGER", "disable"],
  ] as const)("refuses mutations of %s through physical alias %s (%s)", { timeout: 30000 }, async ([reserved, alias, action], context) => {
    await withSkillsLock(root, async () => {});
    const manager = join(skillsDir, ".skills-manager");
    const disabled = join(skillsDir, ".disabled_skills");
    const original = join(skillsDir, reserved);
    const selected = join(skillsDir, alias);
    await mkdir(disabled);
    if (reserved === ".git") git("init", "-q");
    const sentinel = join(original, reserved === ".git" ? "SKILL.md" : "sentinel");
    await writeFile(sentinel, "reserved metadata");
    const originalStat = await lstat(original);
    const aliasStat = await lstat(selected).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!aliasStat || aliasStat.dev !== originalStat.dev || aliasStat.ino !== originalStat.ino) {
      context.skip("This filesystem does not resolve the alternate spelling to the reserved entry");
      return;
    }

    const staged = join(sandbox, "staged");
    await mkdir(staged);
    await writeFile(join(staged, "SKILL.md"), "replacement");
    const version = await fingerprintTree(selected);
    const stagedVersion = await fingerprintTree(staged);
    const paths = [
      skillsDir, manager, join(manager, "owner"), join(manager, "lock"), disabled,
      original, sentinel, join(skillsDir, "foo", "SKILL.md"),
      ...(reserved === ".git" ? [join(original, "HEAD")] : []),
    ];
    const before = await Promise.all(paths.map(entrySnapshot));
    const rootEntries = (await readdir(skillsDir)).sort();
    const disabledEntries = (await readdir(disabled)).sort();
    const stateEntries = (await readdir(manager)).sort();
    const headBytes = reserved === ".git" ? await readFile(join(original, "HEAD")) : null;

    const operation = action === "disable"
      ? disableSkill(root, alias, version)
      : action === "remove"
        ? removeManagedSkill(root, alias, selected, version)
        : importSkill(root, alias, staged, {
          replace: true, expectedPath: selected, expectedVersion: version, expectedStagedVersion: stagedVersion,
        });
    await expect(operation).rejects.toThrow();

    expect(await Promise.all(paths.map(entrySnapshot))).toEqual(before);
    expect((await readdir(skillsDir)).sort()).toEqual(rootEntries);
    expect((await readdir(disabled)).sort()).toEqual(disabledEntries);
    expect((await readdir(manager)).sort()).toEqual(stateEntries);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("reserved metadata");
    if (headBytes !== null) expect(await readFile(join(original, "HEAD"))).toEqual(headBytes);
    await expect(readFile(join(staged, "SKILL.md"), "utf8")).resolves.toBe("replacement");
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });

  it.for([
    ["active", "disable"],
    ["active", "remove"],
    ["active", "replace"],
    ["disabled", "enable"],
    ["disabled", "remove"],
    ["disabled", "replace"],
  ] as const)("refuses mutation of an %s hardlinked .git symlink (%s)", { timeout: 30000 }, async ([location, action], context) => {
    await withSkillsLock(root, async () => {});
    const manager = join(skillsDir, ".skills-manager");
    const disabled = join(skillsDir, ".disabled_skills");
    const git = join(skillsDir, ".git");
    const name = "ordinary-alias";
    const selected = join(location === "active" ? skillsDir : disabled, name);
    await mkdir(disabled);
    await symlink(outside, git);
    try {
      await link(git, selected);
    } catch (error) {
      if (["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("This filesystem does not support hardlinks to symbolic links");
        return;
      }
      throw error;
    }
    const originalStat = await lstat(git);
    const aliasStat = await lstat(selected);
    if (!aliasStat.isSymbolicLink() || aliasStat.dev !== originalStat.dev || aliasStat.ino !== originalStat.ino) {
      context.skip("Hardlinking a symbolic link did not preserve its physical identity");
      return;
    }

    const staged = join(sandbox, "staged");
    await mkdir(staged);
    await writeFile(join(staged, "SKILL.md"), "replacement");
    const version = await fingerprintTree(selected);
    const stagedVersion = await fingerprintTree(staged);
    const paths = [
      skillsDir, manager, join(manager, "owner"), join(manager, "lock"), disabled,
      git, selected, join(skillsDir, "foo", "SKILL.md"),
    ];
    const before = await Promise.all(paths.map(entrySnapshot));
    const rootEntries = (await readdir(skillsDir)).sort();
    const disabledEntries = (await readdir(disabled)).sort();
    const stateEntries = (await readdir(manager)).sort();

    const operation = action === "disable"
      ? disableSkill(root, name, version)
      : action === "enable"
        ? enableSkill(root, name, version)
        : action === "remove"
          ? removeManagedSkill(root, name, selected, version)
          : importSkill(root, name, staged, {
            replace: true, expectedPath: selected, expectedVersion: version, expectedStagedVersion: stagedVersion,
          });
    await expect(operation).rejects.toThrow();

    expect(await Promise.all(paths.map(entrySnapshot))).toEqual(before);
    expect((await readdir(skillsDir)).sort()).toEqual(rootEntries);
    expect((await readdir(disabled)).sort()).toEqual(disabledEntries);
    expect((await readdir(manager)).sort()).toEqual(stateEntries);
    await expect(readlink(git)).resolves.toBe(outside);
    await expect(readlink(selected)).resolves.toBe(outside);
    await expect(readFile(join(staged, "SKILL.md"), "utf8")).resolves.toBe("replacement");
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });
});

describe("approved skill fingerprints", () => {
  it.each(["active", "disabled"] as const)("fingerprints the selected %s tree without creating state", async (location) => {
    const active = join(skillsDir, "foo");
    const selected = location === "active" ? active : join(skillsDir, ".disabled_skills", "foo");
    if (location === "disabled") {
      await mkdir(join(skillsDir, ".disabled_skills"));
      await rename(active, selected);
    }
    const before = (await readdir(skillsDir)).sort();

    const version = await fingerprintSkill(root, "foo", selected);
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    expect(version).toBe(await fingerprintTree(selected));
    expect((await readdir(skillsDir)).sort()).toEqual(before);
    await expectMissing(join(skillsDir, ".skills-manager"));

    await writeFile(join(selected, "SKILL.md"), "changed content");
    const changed = await fingerprintSkill(root, "foo", selected);
    expect(changed).not.toBe(version);
    await rename(selected, join(sandbox, "original-foo"));
    await mkdir(selected);
    await writeFile(join(selected, "SKILL.md"), "changed content");
    expect(await fingerprintSkill(root, "foo", selected)).not.toBe(changed);
    await expectOutsideUnchanged();
  });

  it.each(["active", "disabled"] as const)("fingerprints %s content independently of inode identity", async (location) => {
    const active = join(skillsDir, "foo");
    const selected = location === "active" ? active : join(skillsDir, ".disabled_skills", "foo");
    if (location === "disabled") {
      await mkdir(join(skillsDir, ".disabled_skills"));
      await rename(active, selected);
    }
    const contents = await fingerprintSkillContents(root, "foo", selected);
    const version = await fingerprintSkill(root, "foo", selected);
    expect(contents).toBe(await fingerprintContents(selected));

    await rename(selected, join(sandbox, "original-content-tree"));
    await mkdir(selected);
    await writeFile(join(selected, "SKILL.md"), skillContents);
    expect(await fingerprintSkillContents(root, "foo", selected)).toBe(contents);
    expect(await fingerprintSkill(root, "foo", selected)).not.toBe(version);
    await writeFile(join(selected, "SKILL.md"), "changed content");
    expect(await fingerprintSkillContents(root, "foo", selected)).not.toBe(contents);
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectOutsideUnchanged();
  });

  it("fingerprints a regular file without creating state", async () => {
    const selected = join(skillsDir, "plain-file");
    await writeFile(selected, "a regular file");
    expect(await fingerprintSkill(root, "plain-file", selected)).toBe(await fingerprintTree(selected));
    await expectMissing(join(skillsDir, ".skills-manager"));
  });

  it.each(["active", "disabled"] as const)("fingerprints %s links and dangling links without reading their targets", async (location) => {
    const disabled = join(skillsDir, ".disabled_skills");
    if (location === "disabled") await mkdir(disabled);
    const selected = join(location === "active" ? skillsDir : disabled, "shortcut");
    const target = join(outside, "target");
    await writeFile(target, "outside one");
    await symlink(target, selected);
    const version = await fingerprintSkill(root, "shortcut", selected);
    expect(version).toBe(await fingerprintTree(selected));
    await writeFile(target, "outside two");
    expect(await fingerprintSkill(root, "shortcut", selected)).toBe(version);
    await unlink(target);
    expect(await fingerprintSkill(root, "shortcut", selected)).toBe(version);
    await expect(readlink(selected)).resolves.toBe(target);
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectOutsideUnchanged();
  });

  it("rejects a replaced approved root even when the replacement contains the same path", async () => {
    await rename(skillsDir, join(sandbox, "original-skills"));
    await mkdir(join(skillsDir, "foo"), { recursive: true });
    await writeFile(join(skillsDir, "foo", "SKILL.md"), "replacement");

    await expect(fingerprintSkill(root, "foo", join(skillsDir, "foo"))).rejects.toMatchObject({
      code: "ESTALE",
      message: expect.stringContaining("Selected directory changed since approval"),
    });
    await expect(fingerprintSkillContents(root, "foo", join(skillsDir, "foo"))).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe("replacement");
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectOutsideUnchanged();
  });

  it("rejects an approved root replaced with a symlink", async () => {
    await rename(skillsDir, join(sandbox, "original-skills"));
    await symlink(outside, skillsDir, "dir");
    await expect(fingerprintSkill(root, "foo", join(skillsDir, "foo"))).rejects.toThrow();
    await expectOutsideUnchanged();
  });

  it("rejects active and disabled collisions including dangling links", async () => {
    const active = join(skillsDir, "foo");
    const disabledDir = join(skillsDir, ".disabled_skills");
    const disabled = join(disabledDir, "foo");
    await mkdir(disabledDir);
    await symlink(join(sandbox, "missing-target"), disabled);
    await expect(fingerprintSkill(root, "foo", active)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fingerprintSkill(root, "foo", disabled)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fingerprintSkillContents(root, "foo", active)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fingerprintSkillContents(root, "foo", disabled)).rejects.toMatchObject({ code: "EEXIST" });

    await unlink(disabled);
    await rename(active, join(sandbox, "saved-foo"));
    await symlink(join(sandbox, "missing-target"), active);
    await writeFile(disabled, "disabled file");
    await expect(fingerprintSkill(root, "foo", active)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fingerprintSkill(root, "foo", disabled)).rejects.toMatchObject({ code: "EEXIST" });
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectOutsideUnchanged();
  });

  it.each(["existing", "dangling"])("rejects a %s disabled-directory symlink during active preview", async (targetKind) => {
    const target = targetKind === "existing" ? outside : join(sandbox, "missing-target");
    await symlink(target, join(skillsDir, ".disabled_skills"), "dir");
    await expect(fingerprintSkill(root, "foo", join(skillsDir, "foo"))).rejects.toThrow();
    await expectOutsideUnchanged();
  });

  it("does not substitute the other location for a missing reviewed skill", async () => {
    const active = join(skillsDir, "foo");
    const disabled = join(skillsDir, ".disabled_skills", "foo");
    await expect(fingerprintSkill(root, "foo", disabled)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(skillsDir, ".disabled_skills"));
    await rename(active, disabled);
    await expect(fingerprintSkill(root, "foo", active)).rejects.toMatchObject({ code: "ENOENT" });
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectOutsideUnchanged();
  });

  it("rejects invalid names and paths outside the exact active or disabled locations", async () => {
    await expect(fingerprintSkill(root, "../foo", join(skillsDir, "foo"))).rejects.toThrow("Invalid or reserved skill name");
    await expect(fingerprintSkill(root, ".disabled_skills", join(skillsDir, ".disabled_skills"))).rejects.toThrow("Invalid or reserved skill name");
    await expect(fingerprintSkill(root, "foo", join(outside, "foo"))).rejects.toThrow("The confirmed path is not this skill");
    await expect(fingerprintSkill(root, "foo", join(skillsDir, ".disabled_skills", "other"))).rejects.toThrow("The confirmed path is not this skill");
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectOutsideUnchanged();
  });
});

describe("nested paths with newlines", () => {
  it("lists, reads, and commits a literal newline in both a directory and a filename", async () => {
    const directory = "foo/docs\narchive";
    const file = `${directory}/guide\n2026.txt`;
    const contents = "first line\nsecond line\n";
    await mkdir(join(skillsDir, directory));
    await writeFile(join(skillsDir, file), contents);
    await symlink(outside, join(skillsDir, directory, "outside-link"), "dir");

    const entries = await listSkillPaths(skillsDir, { expectedRoot: root });
    expect(entries).toContainEqual({ path: directory, kind: "directory" });
    expect(entries).toContainEqual({ path: file, kind: "file" });
    await expect(listSkillPaths(skillsDir, { expectedRoot: root, relativePath: directory }))
      .resolves.toContainEqual({ path: "guide\n2026.txt", kind: "file" });
    const entry = await readSkillPath(skillsDir, file, { expectedRoot: root });
    expect(entry).toMatchObject({ kind: "file", truncated: false });
    expect(entry.content.toString("utf8")).toBe(contents);
    await expect(countSkillPathLines(skillsDir, file, root)).resolves.toBe(2);
    await expect(readSkillPath(skillsDir, `${directory}/outside-link/sentinel`, { expectedRoot: root })).rejects.toThrow();

    git("init", "-q");
    git("config", "user.name", "Fixture Author");
    git("config", "user.email", "fixture@example.invalid");
    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.HOME = sandbox;
      process.env.XDG_CONFIG_HOME = join(sandbox, "config");
      const preview = await previewCommit(root, [file]);
      expect(preview.paths).toEqual([file]);
      expect((await commitSelected(root, preview, "Commit newline path")).exitCode).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
    }
    expect(git("show", `HEAD:${file}`)).toBe(contents);
    expect(git("ls-tree", "-r", "--name-only", "-z", "HEAD")).toBe(`${file}\0`);
    await expectOutsideUnchanged();
  }, 30000);
});

describe("safe concurrent reads", () => {
  it("never reads or lists outside entries while an intermediate directory is swapped for a symlink", async () => {
    const skill = join(skillsDir, "foo");
    const directory = join(skill, "docs");
    const parked = join(skill, ".parked-docs");
    const inside = "inside document";
    const outsideBytes = "OUTSIDE-SENTINEL-CONTENT";
    const outsideName = "outside-only-secret-name";
    await mkdir(directory);
    await writeFile(join(directory, "visible.txt"), inside);
    await writeFile(join(outside, "visible.txt"), outsideBytes);
    await writeFile(join(outside, outsideName), outsideBytes);

    const baseline = await readSkillPath(skill, "docs/visible.txt");
    expect(baseline.kind).toBe("file");
    expect(baseline.content.toString("utf8")).toBe(inside);
    expect(await listSkillPaths(skill)).toContainEqual({ path: "docs/visible.txt", kind: "file" });

    const assertSafeObservation = async (): Promise<void> => {
      const [entry, entries] = await Promise.all([
        readSkillPath(skill, "docs/visible.txt").catch(() => null),
        listSkillPaths(skill).catch(() => null),
      ]);
      if (entry) {
        const content = entry.content.toString("utf8");
        expect(content).not.toContain(outsideBytes);
        if (entry.kind === "file") expect(content).toBe(inside);
      }
      if (entries) {
        expect(entries.some((item) => item.path.includes(outsideName))).toBe(false);
      }
    };

    await rename(directory, parked);
    await symlink(outside, directory, "dir");
    try {
      await assertSafeObservation();
    } finally {
      await unlink(directory);
      await rename(parked, directory);
    }

    let stopped = false;
    let swaps = 0;
    let swapFailure: unknown;
    const swapping = (async () => {
      while (!stopped) {
        await rename(directory, parked);
        await symlink(outside, directory, "dir");
        swaps++;
        await delay(2);
        await unlink(directory);
        await rename(parked, directory);
        await delay(2);
      }
    })().catch((error: unknown) => {
      swapFailure = error;
      stopped = true;
    });

    try {
      for (let attempt = 0; attempt < 30; attempt++) await assertSafeObservation();
    } finally {
      stopped = true;
      await swapping;
    }
    if (swapFailure) throw swapFailure;
    expect(swaps).toBeGreaterThan(1);
    await expect(readFile(join(directory, "visible.txt"), "utf8")).resolves.toBe(inside);
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside stays unchanged");
    await expect(readFile(join(outside, "visible.txt"), "utf8")).resolves.toBe(outsideBytes);
    await expect(readFile(join(outside, outsideName), "utf8")).resolves.toBe(outsideBytes);
    expect((await readdir(outside)).sort()).toEqual(["sentinel", "visible.txt", outsideName].sort());
  }, 30000);
});

describe("reviewed imports", () => {
  async function stagedSkill(contents: string): Promise<string> {
    const staged = join(sandbox, "staged");
    await mkdir(staged);
    await writeFile(join(staged, "SKILL.md"), contents);
    return staged;
  }

  it("reads receipts only from the approved root and does not initialize fresh state", async () => {
    await expect(readManagedMetadata(skillsDir, "imported", root)).resolves.toBeNull();
    await expectMissing(join(skillsDir, ".skills-manager"));
    const staged = await stagedSkill("receipt source");
    const metadata = JSON.stringify({ source: "approved source", version: 1 });
    await importSkill(root, "imported", staged, {
      replace: false,
      expectedStagedVersion: await fingerprintTree(staged),
      metadata,
    });
    await expect(readManagedMetadata(skillsDir, "imported", root)).resolves.toBe(metadata);

    await rename(skillsDir, join(sandbox, "original-selected-skills"));
    await mkdir(skillsDir);
    await expect(readManagedMetadata(skillsDir, "imported", root)).rejects.toMatchObject({ code: "ESTALE" });
    await expectMissing(join(skillsDir, ".skills-manager"));
    await expectOutsideUnchanged();
  });

  it("installs a fingerprinted staged tree without changing existing skills", async () => {
    const staged = await stagedSkill("new import");
    await importSkill(root, "imported", staged, {
      replace: false,
      expectedStagedVersion: await fingerprintTree(staged),
    });

    await expect(readFile(join(skillsDir, "imported", "SKILL.md"), "utf8")).resolves.toBe("new import");
    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectOutsideUnchanged();
  });

  it.each(["enabled", "disabled"])("rejects an unreviewed collision with an %s skill", async (location) => {
    const staged = await stagedSkill("incoming content");
    const existing = location === "enabled"
      ? join(skillsDir, "conflict")
      : join(skillsDir, ".disabled_skills", "conflict");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "SKILL.md"), "existing content");

    await expect(importSkill(root, "conflict", staged, {
      replace: false,
      expectedStagedVersion: await fingerprintTree(staged),
    })).rejects.toThrow();

    await expect(readFile(join(existing, "SKILL.md"), "utf8")).resolves.toBe("existing content");
    await expect(readFile(join(staged, "SKILL.md"), "utf8")).resolves.toBe("incoming content");
    await expectOutsideUnchanged();
  });

  it("replaces only the exact reviewed entry with the reviewed staged tree", async () => {
    const existing = join(skillsDir, "foo");
    const staged = await stagedSkill("reviewed replacement");
    const expectedVersion = await fingerprintTree(existing);
    const expectedStagedVersion = await fingerprintTree(staged);

    await importSkill(root, "foo", staged, {
      replace: true,
      expectedPath: existing,
      expectedVersion,
      expectedStagedVersion,
    });

    await expect(readFile(join(existing, "SKILL.md"), "utf8")).resolves.toBe("reviewed replacement");
    await expectOutsideUnchanged();
  });

  it("replaces a reviewed disabled skill without enabling it", async () => {
    const enabled = join(skillsDir, "foo");
    const disabledDir = join(skillsDir, ".disabled_skills");
    const disabled = join(disabledDir, "foo");
    await mkdir(disabledDir);
    await rename(enabled, disabled);
    const staged = await stagedSkill("updated while disabled");

    await importSkill(root, "foo", staged, {
      replace: true,
      expectedPath: disabled,
      expectedVersion: await fingerprintTree(disabled),
      expectedStagedVersion: await fingerprintTree(staged),
    });

    await expectMissing(enabled);
    await expect(readFile(join(disabled, "SKILL.md"), "utf8")).resolves.toBe("updated while disabled");
    await expectOutsideUnchanged();
  });

  it.each([
    ["after-intent", false],
    ["after-move", false],
    ["after-commit", true],
  ] as const)("recovers a failed replacement at %s (committed: %s)", async (fault, committed) => {
    const existing = join(skillsDir, "foo");
    const staged = await stagedSkill("reviewed replacement");
    await symlink(outside, join(existing, "outside-link"), "dir");
    const expectedVersion = await fingerprintTree(existing);
    const expectedStagedVersion = await fingerprintTree(staged);

    const result = await runOperation(
      "import",
      ["foo", staged, existing, expectedVersion, expectedStagedVersion],
      fault,
    );
    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toMatch(/\b86\b/);
    await recoverSkills(root);
    await recoverSkills(root);

    await expect(readFile(join(existing, "SKILL.md"), "utf8"))
      .resolves.toBe(committed ? "reviewed replacement" : skillContents);
    if (committed) await expectMissing(join(existing, "outside-link"));
    else expect(await readlink(join(existing, "outside-link"))).toBe(outside);
    await expectOutsideUnchanged();
  }, 30000);

  it("rejects a replacement when the installed tree changed after review", async () => {
    const existing = join(skillsDir, "foo");
    const staged = await stagedSkill("incoming content");
    const expectedVersion = await fingerprintTree(existing);
    const expectedStagedVersion = await fingerprintTree(staged);
    await writeFile(join(existing, "SKILL.md"), "user's newer edits");

    await expect(importSkill(root, "foo", staged, {
      replace: true,
      expectedPath: existing,
      expectedVersion,
      expectedStagedVersion,
    })).rejects.toThrow();

    await expect(readFile(join(existing, "SKILL.md"), "utf8")).resolves.toBe("user's newer edits");
    await expect(readFile(join(staged, "SKILL.md"), "utf8")).resolves.toBe("incoming content");
    await expectOutsideUnchanged();
  });

  it("rejects a replacement when its staged tree changed after review", async () => {
    const existing = join(skillsDir, "foo");
    const staged = await stagedSkill("incoming content");
    const expectedVersion = await fingerprintTree(existing);
    const expectedStagedVersion = await fingerprintTree(staged);
    await writeFile(join(staged, "SKILL.md"), "different staged content");

    await expect(importSkill(root, "foo", staged, {
      replace: true,
      expectedPath: existing,
      expectedVersion,
      expectedStagedVersion,
    })).rejects.toThrow();

    await expect(readFile(join(existing, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expect(readFile(join(staged, "SKILL.md"), "utf8")).resolves.toBe("different staged content");
    await expectOutsideUnchanged();
  });

  it("rejects replacement using a different existing reviewed path", async () => {
    const staged = await stagedSkill("incoming content");
    const other = join(skillsDir, "other");
    await mkdir(other);
    await writeFile(join(other, "SKILL.md"), "other skill");

    await expect(importSkill(root, "foo", staged, {
      replace: true,
      expectedPath: other,
      expectedVersion: await fingerprintTree(other),
      expectedStagedVersion: await fingerprintTree(staged),
    })).rejects.toThrow();

    await expect(readFile(join(skillsDir, "foo", "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expect(readFile(join(other, "SKILL.md"), "utf8")).resolves.toBe("other skill");
    await expect(readFile(join(staged, "SKILL.md"), "utf8")).resolves.toBe("incoming content");
    await expectOutsideUnchanged();
  });

  it("rejects staged links rather than importing references outside the staged tree", async () => {
    const staged = await stagedSkill("incoming content");
    await symlink(outside, join(staged, "outside-link"), "dir");

    await expect(importSkill(root, "imported", staged, {
      replace: false,
      expectedStagedVersion: await fingerprintTree(staged),
    })).rejects.toThrow();

    await expectMissing(join(skillsDir, "imported"));
    await expect(readFile(join(staged, "SKILL.md"), "utf8")).resolves.toBe("incoming content");
    await expectOutsideUnchanged();
  });

  it("rejects staged hard links to outside files without changing the linked file", async () => {
    const staged = await stagedSkill("incoming content");
    const sentinel = join(outside, "sentinel");
    await link(sentinel, join(staged, "outside-hardlink"));
    const before = await lstat(sentinel);

    await expect(importSkill(root, "imported", staged, {
      replace: false,
      expectedStagedVersion: await fingerprintTree(staged),
    })).rejects.toThrow();

    await expectMissing(join(skillsDir, "imported"));
    const after = await lstat(sentinel);
    expect([after.ino, after.nlink, after.mtimeMs]).toEqual([before.ino, before.nlink, before.mtimeMs]);
    await expect(readFile(join(staged, "outside-hardlink"), "utf8")).resolves.toBe("outside stays unchanged");
    await expectOutsideUnchanged();
  });
});
