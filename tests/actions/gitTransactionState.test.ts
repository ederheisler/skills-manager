import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveSkillsRoot, withSkillsLock, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { previewCommit, recoverSkillsGit, type CommitPreview } from "../../src/actions/git.js";

let sandbox: string;
let root: string;
let approved: ApprovedSkillsRoot;
let preview: CommitPreview;
let env: NodeJS.ProcessEnv;
interface FileProof { identity: string; hash: string; kind: string; executable: boolean }
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function git(...args: string[]): string { return execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd(); }
async function proof(file: string) {
  const value = await lstat(file, { bigint: true });
  return { identity: `${value.dev}:${value.ino}`, hash: digest(value.isDirectory() ? Buffer.alloc(0) : await readFile(file)), kind: value.isDirectory() ? "directory" : "file", executable: value.isFile() && (value.mode & 0o111n) !== 0n };
}
async function interrupted(mode: "commit" | "pull" = "commit") {
  const id = "a".repeat(32); const dir = path.join(root, ".git"); const original = await readFile(path.join(dir, "index"));
  const backupPath = path.join(dir, `.skill-manager-txn-${id}.backup`); const preparedPath = path.join(dir, `.skill-manager-txn-${id}.index`);
  await writeFile(backupPath, original, { mode: 0o600 }); await writeFile(preparedPath, original, { mode: 0o600 });
  const privateEnv = { ...env, GIT_INDEX_FILE: preparedPath };
  execFileSync("git", ["add", "alpha/SKILL.md"], { cwd: root, env: privateEnv });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, env: privateEnv, encoding: "utf8" }).trim();
  const target = git("commit-tree", tree, "-p", preview.head!, "-m", "prepared commit");
  const journal = { version: 2, id, approvedIdentity: approved.identity, binding: preview.binding, mode, branch: preview.branch, head: preview.head, target, phase: "prepared", oldIndex: digest(original), newIndex: digest(await readFile(preparedPath)), backup: await proof(backupPath), prepared: await proof(preparedPath), lock: null, ref: null, stage: null as FileProof | null, removals: [] as object[], additions: [] as object[] };
  return { journal, original, preparedPath, target };
}
async function save(value: unknown): Promise<void> {
  await withSkillsLock(approved, () => writeFile(path.join(root, ".skills-manager", "git-transaction.json"), JSON.stringify(value), { mode: 0o600 }));
}
beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "skills-git-state-"))); root = path.join(sandbox, "skills");
  await mkdir(path.join(root, "alpha"), { recursive: true }); await mkdir(path.join(sandbox, "home"));
  env = { ...process.env, HOME: path.join(sandbox, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  git("-c", "init.templateDir=", "init", "-b", "trunk"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(root, "alpha", "SKILL.md"), "---\nname: alpha\n---\nbase\n"); git("add", "alpha/SKILL.md"); git("-c", "commit.gpgsign=false", "commit", "-m", "base");
  await writeFile(path.join(root, "alpha", "SKILL.md"), "---\nname: alpha\n---\nreviewed\n"); approved = await approveSkillsRoot(root); preview = await previewCommit(approved, ["alpha/SKILL.md"]);
});
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

describe("in-process durable Git recovery", () => {
  it.each(["git-transaction-journal", "git-transaction-journal.next", "git-transaction-journal.delete", "transaction.journal", "git-transaction.json.next"])("retains legacy or ambiguous state: %s", async (name) => {
    const bytes = Buffer.from("legacy or incomplete journal\0preserve\n");
    await withSkillsLock(approved, () => writeFile(path.join(root, ".skills-manager", name), bytes, { mode: 0o600 }));
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/legacy|incomplete|journal|recovery/i);
    expect(await readFile(path.join(root, ".skills-manager", name))).toEqual(bytes);
  });
  it.each(["garbage", '{"version":1}', '{"version":2,"binding":{}}'])("retains an invalid journal: %s", async (bytes) => {
    await withSkillsLock(approved, () => writeFile(path.join(root, ".skills-manager", "git-transaction.json"), bytes, { mode: 0o600 }));
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/journal|recovery/i);
    expect(await readFile(path.join(root, ".skills-manager", "git-transaction.json"), "utf8")).toBe(bytes);
  });
  it("rolls back a prepared installed index when HEAD has not advanced", async () => {
    const { journal, original, preparedPath } = await interrupted(); await save(journal);
    await writeFile(path.join(root, ".git", "index"), await readFile(preparedPath));
    expect(await recoverSkillsGit(approved)).toMatch(/rolled back/i);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(original); expect(git("rev-parse", "HEAD")).toBe(preview.head);
    await expect(lstat(path.join(root, ".skills-manager", "git-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains an independently changed index and its recovery journal", async () => {
    const { journal } = await interrupted(); await save(journal);
    await writeFile(path.join(root, "notes"), "foreign staged bytes\n"); git("add", "notes"); const changed = await readFile(path.join(root, ".git", "index"));
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/index changed/i);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(changed); expect(JSON.parse(await readFile(path.join(root, ".skills-manager", "git-transaction.json"), "utf8"))).toMatchObject({ id: journal.id });
  });
  it("retains recovery from a different root binding", async () => {
    const { journal } = await interrupted(); journal.binding = { ...journal.binding, prefix: "different" }; await save(journal);
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/journal|repository/i);
    expect(git("rev-parse", "HEAD")).toBe(preview.head);
  });
  it("does not remove a foreign Git index lock", async () => {
    const { journal } = await interrupted(); await save(journal); const lock = path.join(root, ".git", "index.lock"); await writeFile(lock, "foreign lock\n");
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/foreign|lock/i); expect(await readFile(lock, "utf8")).toBe("foreign lock\n");
  });
  it("recognizes an already completed commit without overwriting its live index", async () => {
    const { journal, target, preparedPath } = await interrupted(); await save(journal); await writeFile(path.join(root, ".git", "index"), await readFile(preparedPath)); git("update-ref", "HEAD", target, preview.head!);
    const installed = await readFile(path.join(root, ".git", "index")); expect(await recoverSkillsGit(approved)).toMatch(/completed/i); expect(await readFile(path.join(root, ".git", "index"))).toEqual(installed);
  });
  it.each([false, true])("completes a partially applied pull with advanced HEAD=%s", async (advanced) => {
    const { journal, target } = await interrupted("pull"); const current = path.join(root, "alpha", "SKILL.md"); const incoming = await readFile(current);
    await writeFile(current, git("show", "HEAD:alpha/SKILL.md") + "\n");
    const stage = path.join(root, ".skills-manager", `git-stage-${journal.id}`);
    await withSkillsLock(approved, async () => {
      await mkdir(stage, { mode: 0o700 }); journal.stage = await proof(stage);
      const old = await proof(current); await rename(current, path.join(stage, "o0")); await writeFile(path.join(stage, "n0"), incoming, { mode: 0o644 });
      journal.removals = [{ ...old, path: "alpha/SKILL.md", slot: "o0" }]; journal.additions = [{ ...await proof(path.join(stage, "n0")), path: "alpha/SKILL.md", slot: "n0" }];
    });
    await save(journal); if (advanced) git("update-ref", "HEAD", target, preview.head!);
    expect(await recoverSkillsGit(approved)).toMatch(/pull completed/i); expect(git("rev-parse", "HEAD")).toBe(target); expect(await readFile(current)).toEqual(incoming);
    expect(await recoverSkillsGit(approved)).toBeUndefined();
  });
  it.each(["symlink", "hardlink"])("never follows or removes a %s journal", async (kind) => {
    const outside = path.join(sandbox, "outside"); await writeFile(outside, "foreign bytes\n");
    await withSkillsLock(approved, async () => { const file = path.join(root, ".skills-manager", "git-transaction.json"); if (kind === "symlink") await symlink(outside, file); else await link(outside, file); });
    await expect(recoverSkillsGit(approved)).rejects.toThrow(); expect(await readFile(outside, "utf8")).toBe("foreign bytes\n");
  });
});
