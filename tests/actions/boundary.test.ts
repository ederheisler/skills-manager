import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { approveSkillsRoot, countSkillPathLines, directoryIdentity, fingerprintContents, fingerprintSkill, fingerprintSkillContents, fingerprintTree, hasIndexTransaction, importSkill, listSkillPaths, publishCliLock, readManagedMetadata, readSkillPath, recoverSkills, removeDisposableTree, snapshotCliLock, withSkillsLock, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { commitSelected, previewCommit } from "../../src/actions/git.js";
import { removeManagedSkill } from "../../src/actions/remove.js";
import { disableSkill, enableSkill } from "../../src/actions/toggle.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let sandbox: string;
let skillsDir: string;
let root: ApprovedSkillsRoot;
let outside: string;
const skillContents = "---\nname: foo\n---\noriginal\n";
const lockContents = '{"version":3,"skills":{"foo":{"source":"owner/repo"}}}\n';


beforeEach(async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  vi.mocked(rename).mockImplementation(actual.rename);
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

// A second app instance runs the same in-process implementation.
async function runOperation(operation: Operation, args: string[]): Promise<ChildResult> {
  const moduleUrl = new URL("../../src/actions/boundary.ts", import.meta.url).href;
  const program = `import { moveReviewedSkill, deleteReviewedSkill, importSkill, recoverSkills, withSkillsLock, hasIndexTransaction } from ${JSON.stringify(moduleUrl)};
    const root = JSON.parse(process.argv[1]), args = process.argv.slice(2);
    ${operation === "disable" ? 'await moveReviewedSkill(root, args[0], args[1], "disable");' :
      operation === "remove" ? "await deleteReviewedSkill(root, args[0], args[1], args[2]);" :
      operation === "import" ? "await importSkill(root, args[0], args[1], { replace:true, expectedPath:args[2], expectedVersion:args[3], expectedStagedVersion:args[4] });" :
      operation === "recover" ? "await recoverSkills(root);" :
      "if (!await withSkillsLock(root, () => hasIndexTransaction(root))) throw new Error('Pending index transaction not detected');"}`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program, JSON.stringify(root), ...args], {
    stdio: ["ignore", "ignore", "pipe"], timeout: 10000,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  return { code, signal, stderr };
}

describe("CLI lock publication", () => {
  it("serializes shared tracking publication across sibling app roots and refuses the stale loser", async () => {
    const sibling = join(sandbox, "sibling-skills");
    await mkdir(sibling);
    const siblingRoot = await approveSkillsRoot(sibling);
    await withSkillsLock(root, async () => {});
    await withSkillsLock(siblingRoot, async () => {});
    const lock = join(sandbox, ".skill-lock.json");
    const snapshot = await snapshotCliLock(lock);
    const winner = '{"skills":{"foo":{"hash":"winner"},"unrelated":{"keep":true}}}\n';
    const loser = '{"skills":{"foo":{"hash":"stale-loser"}}}\n';
    const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
    const paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to !== lock) return actual.rename(from, to);
      vi.mocked(rename).mockImplementation(actual.rename);
      paused.resolve();
      await resume.promise;
      return actual.rename(from, to);
    });
    const publication = withSkillsLock(root, () => publishCliLock(snapshot, winner));
    await paused.promise;
    const moduleUrl = new URL("../../src/actions/boundary.ts", import.meta.url).href;
    const program = `import { withSkillsLock, publishCliLock } from ${JSON.stringify(moduleUrl)};
      const [root, snapshot, content] = JSON.parse(process.argv[1]);
      await withSkillsLock(root, async () => {
        process.send("publishing");
        try { await publishCliLock(snapshot, content); process.send("published"); }
        catch (error) { process.send(error.code); }
      });`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program, JSON.stringify([siblingRoot, snapshot, loser])], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 10000,
    });
    const messages: unknown[] = [];
    let stderr = "", finished = false;
    child.on("message", (message: unknown) => { messages.push(message); });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const closing = once(child, "close").then((result) => { finished = true; return result; });
    try {
      await once(child, "message");
      await delay(100);
      expect(finished).toBe(false);
    } finally { resume.resolve(); }
    await publication;
    const [code, signal] = await closing;
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
    expect(messages).toEqual(["publishing", "ESTALE"]);
    await expect(readFile(lock, "utf8")).resolves.toBe(winner);
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside stays unchanged");
  }, 15000);

  it("publishes the exact dependency-generated bytes without changing unrelated entries", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const original = '{\n  "version": 3,\n  "skills": { "other": { "note": "untouched" }, "foo": { "hash": "old" } }\n}\n';
    const updated = '{\n  "version": 3,\n  "skills": { "other": { "note": "untouched" }, "foo": { "hash": "new" } },\n  "generated": "é"\n}\n';
    await writeFile(lock, original);
    await chmod(lock, 0o640);

    const snapshot = await snapshotCliLock(lock);
    expect(snapshot.path).toBe(lock);
    expect(snapshot.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.parentIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.content).toBe(original);
    await publishCliLock(snapshot, updated);

    expect(await readFile(lock)).toEqual(Buffer.from(updated));
    expect((await lstat(lock)).mode & 0o777).toBe(0o640);
    expect((await readdir(sandbox)).sort()).toEqual([".skill-lock.json", "outside", "selected-skills"]);
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside stays unchanged");
  });

  it("creates an absent lock only in the snapshotted parent", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    await unlink(lock);
    const snapshot = await snapshotCliLock(lock);
    expect(snapshot).toMatchObject({ path: lock, identity: "missing", content: "" });
    expect(snapshot.parentIdentity).toMatch(/^[a-f0-9]{64}$/);

    const generated = '{ "skills": { "foo": { "hash": "new" } } }\n';
    await publishCliLock(snapshot, generated);
    expect(await readFile(lock)).toEqual(Buffer.from(generated));
    expect((await readdir(sandbox)).sort()).toEqual([".skill-lock.json", "outside", "selected-skills"]);
  });

  it("refuses to replace a lock that appeared after an absent snapshot", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    await unlink(lock);
    const snapshot = await snapshotCliLock(lock);
    await writeFile(lock, "new foreign lock");

    await expect(publishCliLock(snapshot, "generated")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(lock, "utf8")).resolves.toBe("new foreign lock");
  });

  it("refuses a same-inode content change", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const snapshot = await snapshotCliLock(lock);
    await writeFile(lock, "changed after review");

    await expect(publishCliLock(snapshot, "generated")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(lock, "utf8")).resolves.toBe("changed after review");
    expect((await readdir(sandbox)).sort()).toEqual([".skill-lock.json", "outside", "selected-skills"]);
  });

  it("compares the original bytes as well as the captured identities", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const snapshot = await snapshotCliLock(lock);
    await expect(publishCliLock({ ...snapshot, content: "different original" }, "generated"))
      .rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(lock, "utf8")).resolves.toBe(lockContents);
  });

  it("transports both maximum-size locks and empty content without truncation", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const original = "a".repeat(1024 * 1024);
    const updated = "b".repeat(1024 * 1024);
    await writeFile(lock, original);
    const snapshot = await snapshotCliLock(lock);
    expect(snapshot.content).toBe(original);
    await publishCliLock(snapshot, updated);
    await expect(readFile(lock, "utf8")).resolves.toBe(updated);

    const next = await snapshotCliLock(lock);
    await publishCliLock(next, "");
    expect(await readFile(lock)).toEqual(Buffer.alloc(0));
    const empty = await snapshotCliLock(lock);
    expect(empty.content).toBe("");
    await publishCliLock(empty, "after-empty");
    await expect(readFile(lock, "utf8")).resolves.toBe("after-empty");
  });

  it("refuses an inode replacement even when its content is unchanged", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const original = join(sandbox, "original-lock");
    const snapshot = await snapshotCliLock(lock);
    await rename(lock, original);
    await writeFile(lock, lockContents);

    await expect(publishCliLock(snapshot, "generated")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(lock, "utf8")).resolves.toBe(lockContents);
    await expect(readFile(original, "utf8")).resolves.toBe(lockContents);
  });

  it("refuses a replaced parent even when its lock contains the original bytes", async () => {
    const parent = join(sandbox, "lock-parent");
    const parked = join(sandbox, "original-parent");
    const lock = join(parent, ".skill-lock.json");
    await mkdir(parent);
    await writeFile(lock, lockContents);
    const snapshot = await snapshotCliLock(lock);
    await rename(parent, parked);
    await mkdir(parent);
    await writeFile(lock, lockContents);

    await expect(publishCliLock(snapshot, "generated")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(lock, "utf8")).resolves.toBe(lockContents);
    await expect(readFile(join(parked, ".skill-lock.json"), "utf8")).resolves.toBe(lockContents);
  });

  it("refuses symlinked lock files, including replacements after snapshot", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const target = join(outside, "sentinel");
    const snapshot = await snapshotCliLock(lock);
    await unlink(lock);
    await symlink(target, lock);

    await expect(snapshotCliLock(lock)).rejects.toThrow();
    await expect(publishCliLock(snapshot, "generated")).rejects.toThrow();
    await expect(readFile(target, "utf8")).resolves.toBe("outside stays unchanged");
    expect(await readlink(lock)).toBe(target);
  });

  it("refuses hard-linked lock files at snapshot and publication", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const alias = join(outside, "lock-alias");
    const snapshot = await snapshotCliLock(lock);
    await link(lock, alias);

    await expect(snapshotCliLock(lock)).rejects.toThrow();
    await expect(publishCliLock(snapshot, "generated")).rejects.toThrow();
    await expect(readFile(lock, "utf8")).resolves.toBe(lockContents);
    await expect(readFile(alias, "utf8")).resolves.toBe(lockContents);
  });

  it("refuses a symlink in the parent path", async () => {
    const parent = join(sandbox, "lock-parent");
    const alias = join(sandbox, "lock-alias");
    const lock = join(parent, ".skill-lock.json");
    await mkdir(parent);
    await writeFile(lock, lockContents);
    await symlink(parent, alias, "dir");
    await expect(snapshotCliLock(join(alias, ".skill-lock.json"))).rejects.toThrow();

    const snapshot = await snapshotCliLock(lock);
    await rename(parent, join(sandbox, "original-parent"));
    await symlink(outside, parent, "dir");
    await expect(publishCliLock(snapshot, "generated")).rejects.toThrow();
    await expect(readFile(join(sandbox, "original-parent", ".skill-lock.json"), "utf8")).resolves.toBe(lockContents);
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside stays unchanged");
  });

  it("preserves a UTF-8 BOM and rejects invalid or oversized lock bytes", async () => {
    const lock = join(sandbox, ".skill-lock.json");
    const bom = "\uFEFF{\"skills\":{}}\n";
    await writeFile(lock, bom);
    const snapshot = await snapshotCliLock(lock);
    expect(snapshot.content).toBe(bom);
    await expect(publishCliLock(snapshot, "x".repeat(1024 * 1024 + 1))).rejects.toThrow();
    await expect(readFile(lock, "utf8")).resolves.toBe(bom);
    await writeFile(lock, Buffer.from([0xff]));
    await expect(snapshotCliLock(lock)).rejects.toThrow();
    await writeFile(lock, "x".repeat(1024 * 1024 + 1));
    await expect(snapshotCliLock(lock)).rejects.toMatchObject({ code: "EFBIG" });
  });

  it("rejects other file names without changing the lock", async () => {
    await expect(snapshotCliLock(join(sandbox, "other.json"))).rejects.toThrow();
    await expect(readFile(join(sandbox, ".skill-lock.json"), "utf8")).resolves.toBe(lockContents);
  });

  it("captures a missing parent without creating it and creates the exact chain on publication", async () => {
    const first = join(sandbox, "xdg");
    const lock = join(first, "state", "skills", ".skill-lock.json");
    const snapshot = await snapshotCliLock(lock);
    expect(snapshot.identity).toBe("missing");
    expect(snapshot.content).toBe("");
    await expectMissing(first);

    const generated = '{"skills":{"new":{"source":"owner/repo"}}}\n';
    await publishCliLock(snapshot, generated);
    await expect(readFile(lock, "utf8")).resolves.toBe(generated);
    expect(await readdir(join(first, "state", "skills"))).toEqual([".skill-lock.json"]);
    await expectOutsideUnchanged();
  });

  it("refuses a parent chain that appeared after the missing-parent snapshot", async () => {
    const first = join(sandbox, "xdg");
    const lock = join(first, "state", ".skill-lock.json");
    const snapshot = await snapshotCliLock(lock);
    await mkdir(first);
    await writeFile(join(first, "foreign"), "leave intact");

    await expect(publishCliLock(snapshot, "generated")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(join(first, "foreign"), "utf8")).resolves.toBe("leave intact");
    await expectMissing(join(first, "state"));
    await expectOutsideUnchanged();
  });

  it("refuses a symlink inserted into a missing parent chain", async () => {
    const first = join(sandbox, "xdg");
    const lock = join(first, "state", ".skill-lock.json");
    const snapshot = await snapshotCliLock(lock);
    await symlink(outside, first, "dir");
    await expect(publishCliLock(snapshot, "generated")).rejects.toThrow();
    expect(await readlink(first)).toBe(outside);
    await expectOutsideUnchanged();
  });

});

describe("disposable workspaces", () => {
  it("cleans only the identified workspace and preserves unrelated siblings", async () => {
    const workspace = join(sandbox, "workspace");
    const sibling = join(sandbox, "unrelated");
    await mkdir(workspace);
    await writeFile(join(workspace, "staged.txt"), "temporary content");
    const token = await directoryIdentity(workspace);
    await mkdir(sibling);
    await removeDisposableTree(workspace, token);
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
  it("cleans only its own staging after an ENOTEMPTY bootstrap collision and validates the winner", async () => {
    const manager = join(skillsDir, ".skills-manager");
    const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to !== manager) return actual.rename(from, to);
      vi.mocked(rename).mockImplementation(actual.rename);
      await mkdir(manager, { mode: 0o700 });
      await writeFile(join(manager, "owner"), "skills-manager-owned-state-v1\n", { mode: 0o600 });
      await writeFile(join(manager, "lock"), "", { mode: 0o600 });
      throw Object.assign(new Error("Concurrent bootstrap winner"), { code: "ENOTEMPTY" });
    });
    await withSkillsLock(root, async () => {});
    expect((await readdir(skillsDir)).some((name) => name.startsWith(".skills-manager-bootstrap-"))).toBe(false);
    expect((await readdir(manager)).sort()).toEqual(["lock", "owner"]);
    await expect(readFile(join(manager, "owner"), "utf8")).resolves.toBe("skills-manager-owned-state-v1\n");
    await expectOutsideUnchanged();
  });

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

    // Creating/releasing the Node lock may update the manager directory's
    // timestamps; every controlled file and skill keeps its exact snapshot.
    const paths = [skillsDir, owner, lock, fifo, join(skillsDir, "foo"), join(skillsDir, "foo", "SKILL.md")];
    const managerBefore = await lstat(manager);
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
    const managerAfter = await lstat(manager);
    expect([managerAfter.dev, managerAfter.ino, managerAfter.mode, managerAfter.nlink, managerAfter.uid, managerAfter.gid])
      .toEqual([managerBefore.dev, managerBefore.ino, managerBefore.mode, managerBefore.nlink, managerBefore.uid, managerBefore.gid]);
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
    await withSkillsLock(root, async () => {});

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

  it.each(["intent", "committed"] as const)("recovers a %s toggle journal idempotently", async (phase) => {
    await withSkillsLock(root, async () => {});
    const active = join(skillsDir, "foo"), disabled = join(skillsDir, ".disabled_skills", "foo");
    await mkdir(join(skillsDir, ".disabled_skills"));
    const fingerprint = await fingerprintTree(active);
    await writeFile(join(skillsDir, ".skills-manager", "journal"), JSON.stringify({
      version: 2, rootIdentity: root.identity, phase,
      moves: [{ from: "foo", to: ".disabled_skills/foo", fingerprint }],
      rollbackCleanup: [], commitCleanup: [],
    }), { mode: 0o600 });
    await rename(active, disabled);
    await recoverSkills(root);
    await expect(recoverSkills(root)).resolves.toBeUndefined();
    await expect(readFile(join(phase === "committed" ? disabled : active, "SKILL.md"), "utf8")).resolves.toBe(skillContents);
    await expectMissing(phase === "committed" ? active : disabled);
    await expectOutsideUnchanged();
  });

  it.each(["intent", "committed"] as const)("recovers %s quarantined removal without following links", async (phase) => {
    await withSkillsLock(root, async () => {});
    const active = join(skillsDir, "foo"), manager = join(skillsDir, ".skills-manager");
    await symlink(outside, join(active, "outside-link"));
    const fingerprint = await fingerprintTree(active);
    await writeFile(join(manager, "journal"), JSON.stringify({
      version: 2, rootIdentity: root.identity, phase,
      moves: [{ from: "foo", to: ".skills-manager/quarantine", fingerprint }],
      rollbackCleanup: [], commitCleanup: [{ path: ".skills-manager/quarantine", fingerprint }],
    }), { mode: 0o600 });
    await rename(active, join(manager, "quarantine"));
    await recoverSkills(root); await recoverSkills(root);
    if (phase === "committed") await expectMissing(active);
    else expect(await readlink(join(active, "outside-link"))).toBe(outside);
    await expectOutsideUnchanged();
  });

  it("preserves ambiguous and legacy journals rather than overwriting new entries", async () => {
    await withSkillsLock(root, async () => {});
    const active = join(skillsDir, "foo"), manager = join(skillsDir, ".skills-manager");
    await mkdir(join(skillsDir, ".disabled_skills"));
    const fingerprint = await fingerprintTree(active);
    const bytes = JSON.stringify({
      version: 2, rootIdentity: root.identity, phase: "intent",
      moves: [{ from: "foo", to: ".disabled_skills/foo", fingerprint }], rollbackCleanup: [], commitCleanup: [],
    });
    await writeFile(join(manager, "journal"), bytes, { mode: 0o600 });
    await rename(active, join(skillsDir, ".disabled_skills", "foo"));
    await mkdir(active); await writeFile(join(active, "SKILL.md"), "new user data");
    await expect(recoverSkills(root)).rejects.toMatchObject({ code: "ESTALE" });
    await expect(readFile(join(manager, "journal"), "utf8")).resolves.toBe(bytes);
    await expect(readFile(join(active, "SKILL.md"), "utf8")).resolves.toBe("new user data");
    await writeFile(join(manager, "journal"), Buffer.from("SMJNL01\\0legacy binary journal"));
    await expect(recoverSkills(root)).rejects.toThrow(/legacy|ambiguous/);
    expect((await readFile(join(manager, "journal"))).subarray(0, 7).toString()).toBe("SMJNL01");
    await expectOutsideUnchanged();
  });

  it("recovers a known dead same-host lock and preserves a foreign lock", async () => {
    await withSkillsLock(root, async () => {});
    const child = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    const pid = child.pid!;
    await once(child, "close");
    const lock = join(skillsDir, ".skills-manager", "app-lock");
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), JSON.stringify({ version: 1, pid, host: hostname(), nonce: randomUUID() }), { mode: 0o600 });
    await expect(recoverSkills(root)).resolves.toBeUndefined();
    await expectMissing(lock);
    await mkdir(lock, { mode: 0o700 });
    const foreign = JSON.stringify({ version: 1, pid, host: "foreign-host", nonce: randomUUID() });
    await writeFile(join(lock, "owner"), foreign, { mode: 0o600 });
    await expect(recoverSkills(root)).rejects.toMatchObject({ code: "EBUSY" });
    await expect(readFile(join(lock, "owner"), "utf8")).resolves.toBe(foreign);
  });
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

  it.each(["git-transaction.json", "git-transaction.json.next", "git-transaction-journal", "git-transaction-journal.next", "git-transaction-journal.delete", "transaction.journal"])("blocks mutations while %s is pending", async (journalName) => {
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

describe("child link reads", () => {
  it("rejects traversal through a linked ancestor and lists only link text", async () => {
    const docs = join(skillsDir, "foo", "docs");
    await symlink(outside, docs, "dir");
    await expect(readSkillPath(skillsDir, "foo/docs/sentinel")).rejects.toThrow();
    const entries = await listSkillPaths(skillsDir);
    expect(entries).toContainEqual({ path: "foo/docs", kind: "symlink" });
    expect(entries.some((entry) => entry.path.startsWith("foo/docs/"))).toBe(false);
    expect((await readSkillPath(skillsDir, "foo/docs")).content.toString()).toBe(outside);
    await expectOutsideUnchanged();
  });
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

  it.each(["intent", "committed"] as const)("recovers a %s replacement from its exact journaled trees", async (phase) => {
    await withSkillsLock(root, async () => {});
    const existing = join(skillsDir, "foo"), manager = join(skillsDir, ".skills-manager");
    const incoming = join(manager, "incoming");
    await mkdir(incoming); await writeFile(join(incoming, "SKILL.md"), "replacement");
    const old = await fingerprintTree(existing), replacement = await fingerprintTree(incoming);
    await writeFile(join(manager, "journal"), JSON.stringify({
      version: 2, rootIdentity: root.identity, phase,
      moves: [
        { from: "foo", to: ".skills-manager/quarantine", fingerprint: old },
        { from: ".skills-manager/incoming", to: "foo", fingerprint: replacement },
      ],
      rollbackCleanup: [{ path: ".skills-manager/incoming", fingerprint: replacement }],
      commitCleanup: [{ path: ".skills-manager/quarantine", fingerprint: old }],
    }), { mode: 0o600 });
    await rename(existing, join(manager, "quarantine")); await rename(incoming, existing);
    await recoverSkills(root); await recoverSkills(root);
    await expect(readFile(join(existing, "SKILL.md"), "utf8")).resolves.toBe(phase === "committed" ? "replacement" : skillContents);
    await expectMissing(incoming); await expectMissing(join(manager, "quarantine"));
    await expectOutsideUnchanged();
  });

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
