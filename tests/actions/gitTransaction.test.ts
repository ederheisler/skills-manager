import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { approveSkillsRoot, withSkillsLock, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { commitSelected, previewCommit, previewPull, pullApproved, recoverSkillsGit, type GitResult, type PullPreview } from "../../src/actions/git.js";
import { commitIndexTransaction, pullIndexWorktreeTransaction } from "../../src/actions/gitTransaction.js";

let sandbox: string;
let root: string;
let outside: string;
let gitEnv: NodeJS.ProcessEnv;
let previousHome: string | undefined;
let previousXdg: string | undefined;
let supportsTransactions: boolean;

const sentinel = Buffer.from("outside the approved repository\0leave me alone\n");

function gitWithEnv(env: NodeJS.ProcessEnv, ...args: string[]): Buffer {
  return execFileSync("git", [
    "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "init.templateDir=", ...args,
  ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
}

function git(...args: string[]): Buffer {
  return gitWithEnv(gitEnv, ...args);
}

function text(...args: string[]): string {
  return git(...args).toString("utf8").trimEnd();
}

function paths(...args: string[]): string[] {
  return git(...args).toString("utf8").split("\0").filter(Boolean).sort();
}

function requireTransactions(context: TestContext): void {
  if (!supportsTransactions) context.skip("Git before 2.48 lacks the required reference transaction commands");
}

async function expectFailure(operation: Promise<GitResult>, reason?: RegExp): Promise<void> {
  const outcome = await operation.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  if ("error" in outcome) {
    expect(outcome.error).toBeInstanceOf(Error);
    if (reason) expect((outcome.error as Error).message).toMatch(reason);
  } else {
    expect(outcome.result.exitCode, outcome.result.stderr).not.toBe(0);
    if (reason) expect(outcome.result.stderr).toMatch(reason);
  }
}

async function put(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

function skillContent(body: string): string {
  return `---\nname: alpha\ndescription: Fixture skill\n---\n${body}\n`;
}

async function baseCommit(): Promise<void> {
  await put("alpha/SKILL.md", skillContent("base"));
  await put("alpha/other.txt", "other base\n");
  await put(".disabled_skills/beta/SKILL.md", "---\nname: beta\ndescription: Fixture skill\n---\nbase\n");
  await put("notes.txt", "notes base\n");
  git("add", "--all");
  git("commit", "-m", "fixture base");
}
async function incomingPull(entries: { path: string; data: string | null; mode?: string }[]): Promise<{
  approved: ApprovedSkillsRoot; preview: PullPreview; oldHead: string; target: string;
}> {
  git("remote", "add", "fixture", "https://example.invalid/skills.git");
  git("config", "branch.trunk.remote", "fixture");
  git("config", "branch.trunk.merge", "refs/heads/trunk");
  const oldHead = text("rev-parse", "HEAD");
  const env = { ...gitEnv, GIT_INDEX_FILE: path.join(root, ".git", "fixture-pull-index") };
  gitWithEnv(env, "read-tree", oldHead);
  const records: Buffer[] = [];
  for (const entry of entries) {
    const oid = entry.data === null ? "0".repeat(oldHead.length) : execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root, env: gitEnv, input: Buffer.from(entry.data), stdio: ["pipe", "pipe", "pipe"],
    }).toString("utf8").trim();
    records.push(Buffer.from(`${entry.data === null ? "0" : entry.mode ?? "100644"} ${oid}\t${entry.path}\0`));
  }
  execFileSync("git", ["update-index", "-z", "--index-info"], {
    cwd: root, env, input: Buffer.concat(records), stdio: ["pipe", "pipe", "pipe"],
  });
  const tree = gitWithEnv(env, "write-tree").toString("utf8").trim();
  const target = gitWithEnv(env, "commit-tree", tree, "-p", oldHead, "-m", "incoming").toString("utf8").trim();
  git("update-ref", "refs/remotes/fixture/trunk", target);
  const approved = await approveSkillsRoot(root);
  return { approved, preview: await previewPull(approved, ["alpha"]), oldHead, target };
}
beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "skills-git-transaction-")));
  root = path.join(sandbox, "skills");
  outside = path.join(sandbox, "outside");
  const home = path.join(sandbox, "home");
  await Promise.all([mkdir(root), mkdir(outside), mkdir(home)]);
  await writeFile(path.join(outside, "sentinel"), sentinel);

  previousHome = process.env.HOME;
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  gitEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  git("init");
  git("symbolic-ref", "HEAD", "refs/heads/trunk");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const version = /^git version (\d+)\.(\d+)/.exec(text("--version"));
  if (!version) throw new Error("Cannot determine the installed Git version");
  supportsTransactions = Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 48);
});

afterEach(async () => {
  try {
    expect(await readdir(outside)).toEqual(["sentinel"]);
    expect(await readFile(path.join(outside, "sentinel"))).toEqual(sentinel);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
    await rm(sandbox, { recursive: true, force: true });
  }
});

describe("real Git commit transactions", () => {
  it("rejects a switch to a different branch even when both branches have the previewed commit", async () => {
    await baseCommit();
    git("branch", "alternate");
    await put("alpha/SKILL.md", skillContent("reviewed"));
    await put("notes.txt", "staged and unrelated\n");
    git("add", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const original = text("rev-parse", "HEAD");
    expect(preview).toMatchObject({ branch: "trunk", head: original });

    git("checkout", "--quiet", "alternate");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    await expectFailure(commitSelected(approved, preview, "must not commit"), /preview.*changed|changed.*preview/i);
    expect(text("symbolic-ref", "HEAD")).toBe("refs/heads/alternate");
    expect(text("rev-parse", "refs/heads/trunk")).toBe(original);
    expect(text("rev-parse", "refs/heads/alternate")).toBe(original);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("reviewed"));
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("staged and unrelated\n");
  }, 30_000);

  it("commits exactly the reviewed skills paths and preserves staged and unstaged unrelated entries", async (context) => {
    requireTransactions(context);
    await baseCommit();
    const parent = text("rev-parse", "HEAD");
    await put("alpha/SKILL.md", skillContent("older staged content"));
    git("add", "alpha/SKILL.md");
    await put("alpha/SKILL.md", skillContent("reviewed worktree content"));
    await put(".disabled_skills/beta/SKILL.md", "reviewed disabled skill\n");
    await put("alpha/other.txt", "staged other content\n");
    await put("notes.txt", "staged notes\n");
    git("add", "alpha/other.txt", "notes.txt");
    await put("alpha/other.txt", "unstaged other content\n");
    const unrelatedIndex = git("ls-files", "--stage", "-z", "--", "alpha/other.txt", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const selected = [".disabled_skills/beta/SKILL.md", "alpha/SKILL.md"];
    const preview = await previewCommit(approved, selected);
    expect(preview.paths).toEqual(selected);

    const result = await commitSelected(approved, preview, "reviewed skills only");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD^")).toBe(parent);
    expect(paths("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD")).toEqual(selected);
    expect(git("show", "HEAD:alpha/SKILL.md")).toEqual(Buffer.from(skillContent("reviewed worktree content")));
    expect(git("show", ":alpha/SKILL.md")).toEqual(Buffer.from(skillContent("reviewed worktree content")));
    expect(git("show", "HEAD:.disabled_skills/beta/SKILL.md")).toEqual(Buffer.from("reviewed disabled skill\n"));
    expect(git("show", "HEAD:alpha/other.txt")).toEqual(Buffer.from("other base\n"));
    expect(git("show", "HEAD:notes.txt")).toEqual(Buffer.from("notes base\n"));
    expect(git("ls-files", "--stage", "-z", "--", "alpha/other.txt", "notes.txt")).toEqual(unrelatedIndex);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["alpha/other.txt", "notes.txt"]);
    expect(await readFile(path.join(root, "alpha/other.txt"), "utf8")).toBe("unstaged other content\n");
    expect((await readdir(root)).filter((name) => name.startsWith(".skill-manager-txn-"))).toEqual([]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("staged notes\n");
  }, 30_000);

  it("updates the linked worktree index without changing the main worktree index", async (context) => {
    requireTransactions(context);
    await baseCommit();
    const mainIndex = path.join(root, ".git", "index");
    const linked = path.join(sandbox, "linked skills");
    git("worktree", "add", "-b", "linked-transaction", linked);
    const mainIndexBefore = await readFile(mainIndex);
    root = linked;
    const parent = text("rev-parse", "HEAD");
    await put("alpha/SKILL.md", skillContent("older staged content"));
    git("add", "alpha/SKILL.md");
    await put("alpha/SKILL.md", skillContent("reviewed linked content"));
    await put("notes.txt", "linked unrelated staging\n");
    git("add", "notes.txt");
    const unrelatedIndex = git("ls-files", "--stage", "-z", "--", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);

    const result = await commitSelected(approved, preview, "linked worktree skills");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD^")).toBe(parent);
    expect(git("show", "HEAD:alpha/SKILL.md")).toEqual(Buffer.from(skillContent("reviewed linked content")));
    expect(git("show", ":alpha/SKILL.md")).toEqual(Buffer.from(skillContent("reviewed linked content")));
    expect(git("ls-files", "--stage", "-z", "--", "notes.txt")).toEqual(unrelatedIndex);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
    expect(await readFile(mainIndex)).toEqual(mainIndexBefore);
    expect((await readdir(root)).filter((name) => name.startsWith(".skill-manager-txn-"))).toEqual([]);
  }, 30_000);

  it("creates an unborn branch's first commit with binary bytes and a literal newline filename", async (context) => {
    requireTransactions(context);
    const odd = "alpha/:(glob)* [x]\nbytes.bin";
    const bytes = Buffer.from([0, 255, 10, 13, 128, 65, 0, 254]);
    await put("alpha/SKILL.md", skillContent("first"));
    await put(odd, bytes);
    await put("alpha/not-selected.txt", "staged but not selected\n");
    await put("notes.txt", "staged outside skills\n");
    git("add", "alpha/not-selected.txt", "notes.txt");
    const unrelatedIndex = git("ls-files", "--stage", "-z", "--", "alpha/not-selected.txt", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const selected = [odd, "alpha/SKILL.md"].sort();
    const preview = await previewCommit(approved, selected);
    expect(preview).toMatchObject({ branch: "trunk", head: null, paths: selected });

    const result = await commitSelected(approved, preview, "first skills commit");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("symbolic-ref", "HEAD")).toBe("refs/heads/trunk");
    expect(text("rev-list", "--parents", "-n", "1", "HEAD")).toMatch(/^[a-f0-9]{40,64}$/);
    expect(paths("ls-tree", "-r", "--name-only", "-z", "HEAD")).toEqual(selected);
    expect(git("show", `HEAD:${odd}`)).toEqual(bytes);
    expect(git("show", `:${odd}`)).toEqual(bytes);
    expect(git("ls-files", "--stage", "-z", "--", "alpha/not-selected.txt", "notes.txt")).toEqual(unrelatedIndex);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["alpha/not-selected.txt", "notes.txt"]);
    expect(await readFile(path.join(root, odd))).toEqual(bytes);
  }, 30_000);

  it("rolls back the index when a concurrent ref update makes the real Git compare-and-swap fail", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("alpha/SKILL.md", skillContent("reviewed"));
    await put("notes.txt", "staged independently\n");
    git("add", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const parent = text("rev-parse", "HEAD");
    expect(preview.head).toBe(parent);

    // Build genuine candidate and competing commit objects without moving a ref
    // or staging the selected file in the live index.
    const blob = text("hash-object", "-w", "--", "alpha/SKILL.md");
    const temporaryIndex = { ...gitEnv, GIT_INDEX_FILE: path.join(root, ".git", "fixture-index") };
    gitWithEnv(temporaryIndex, "read-tree", parent);
    gitWithEnv(temporaryIndex, "update-index", "--add", "--cacheinfo", `100644,${blob},alpha/SKILL.md`);
    const tree = gitWithEnv(temporaryIndex, "write-tree").toString("utf8").trimEnd();
    const candidate = text("commit-tree", tree, "-p", parent, "-m", "candidate");
    const competing = text("commit-tree", text("rev-parse", `${parent}^{tree}`), "-p", parent, "-m", "concurrent writer");
    git("update-ref", "refs/heads/trunk", competing, parent);
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const stagedBefore = git("ls-files", "--stage", "-z");

    await expect(withSkillsLock(approved, () => commitIndexTransaction(approved, preview, {
      newOid: candidate, entries: [{ path: "alpha/SKILL.md", mode: "100644", oid: blob }],
    }))).rejects.toThrow(/ref|transaction|expected|changed|stale|lock/i);
    expect(text("symbolic-ref", "HEAD")).toBe("refs/heads/trunk");
    expect(text("rev-parse", "HEAD")).toBe(competing);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
    expect(git("ls-files", "--stage", "-z")).toEqual(stagedBefore);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("reviewed"));
    await expectFailure(commitSelected(approved, preview, "stale public request"), /preview.*changed|changed.*preview/i);
    expect(text("rev-parse", "HEAD")).toBe(competing);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
  }, 30_000);

  it("preserves an invalid journal staging envelope and refuses recovery and commit", async () => {
    await baseCommit();
    await put("alpha/SKILL.md", skillContent("reviewed"));
    await put("notes.txt", "independently staged\n");
    git("add", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const head = text("rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));
    const next = path.join(root, ".skills-manager", "git-transaction-journal.next");
    const malformed = Buffer.from("not a valid Git transaction envelope\n");
    await withSkillsLock(approved, () => writeFile(next, malformed, { flag: "wx", mode: 0o600 }));

    await expect(recoverSkillsGit(approved)).rejects.toThrow();
    await expectFailure(commitSelected(approved, preview, "must not commit"));
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(next)).toEqual(malformed);
    await expect(readFile(path.join(root, ".skills-manager", "git-transaction-journal"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("reviewed"));
  }, 30_000);

  it("refuses a selected file that would replace an unrelated staged directory entry", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("alpha/asset/child.txt", "unrelated staged child\n");
    git("add", "alpha/asset/child.txt");
    const stagedChild = git("ls-files", "--stage", "-z", "--", "alpha/asset/child.txt");
    expect(stagedChild.length).toBeGreaterThan(0);
    await rm(path.join(root, "alpha", "asset"), { recursive: true });
    await put("alpha/asset", "reviewed replacement file\n");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/asset"]);
    expect(preview.paths).toEqual(["alpha/asset"]);
    const head = text("rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));

    await expectFailure(commitSelected(approved, preview, "must not replace staged child"), /index|staged|conflict|unrelated|replace/i);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z", "--", "alpha/asset/child.txt")).toEqual(stagedChild);
    expect(git("show", ":alpha/asset/child.txt")).toEqual(Buffer.from("unrelated staged child\n"));
    expect((await readdir(root)).filter((name) => name.startsWith(".skill-manager-txn-"))).toEqual([]);
    expect((await readdir(path.join(root, ".git"))).filter((name) => name.startsWith(".skill-manager-txn-"))).toEqual([]);
    await expect(lstat(path.join(root, ".skills-manager", "git-transaction-journal"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "alpha", "asset"), "utf8")).toBe("reviewed replacement file\n");
  }, 30_000);

  it("cleans a failed index rewrite after a preceding selected deletion", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("alpha/asset/child.txt", "unrelated staged child\n");
    git("add", "alpha/asset/child.txt");
    await rm(path.join(root, "alpha", "asset"), { recursive: true });
    await put("alpha/asset", "reviewed replacement file\n");
    await rm(path.join(root, "alpha", "other.txt"));
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/asset", "alpha/other.txt"]);
    expect(preview.paths).toEqual(["alpha/asset", "alpha/other.txt"]);
    const head = text("rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));

    await expectFailure(commitSelected(approved, preview, "must preserve staged child"), /index|staged|conflict|unrelated|replace/i);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("show", ":alpha/other.txt")).toEqual(Buffer.from("other base\n"));
    expect(git("show", ":alpha/asset/child.txt")).toEqual(Buffer.from("unrelated staged child\n"));
    expect((await readdir(root)).filter((name) => name.startsWith(".skill-manager-txn-"))).toEqual([]);
    expect((await readdir(path.join(root, ".git"))).filter((name) => name.startsWith(".skill-manager-txn-"))).toEqual([]);
    await expect(lstat(path.join(root, ".skills-manager", "git-transaction-journal"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "alpha", "other.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("refuses unrelated hardlinked Git metadata without changing the ref, index, or outside file", async () => {
    await baseCommit();
    await put("alpha/SKILL.md", skillContent("reviewed"));
    await put("notes.txt", "independently staged\n");
    git("add", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const head = text("rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));
    const metadata = path.join(root, ".git", "unrelated-hardlink");
    await link(path.join(outside, "sentinel"), metadata);
    expect((await stat(metadata, { bigint: true })).nlink).toBe(2n);

    await expectFailure(commitSelected(approved, preview, "must not commit"), /hard.?link|unsafe|boundar|refus/i);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(metadata)).toEqual(sentinel);
    expect(await readFile(path.join(outside, "sentinel"))).toEqual(sentinel);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("reviewed"));
  }, 30_000);

  it("fails closed when the real index is locked by another process", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("alpha/SKILL.md", skillContent("reviewed"));
    await put("notes.txt", "independently staged\n");
    git("add", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const beforeHead = text("rev-parse", "HEAD");
    const beforeIndex = await readFile(path.join(root, ".git", "index"));
    const lock = path.join(root, ".git", "index.lock");
    await writeFile(lock, "another owner's lock\n", { flag: "wx" });

    await expectFailure(commitSelected(approved, preview, "must not commit"), /index|lock|transaction/i);
    expect(text("rev-parse", "HEAD")).toBe(beforeHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(beforeIndex);
    expect(await readFile(lock, "utf8")).toBe("another owner's lock\n");
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("reviewed"));
  }, 30_000);

  it("requires a real Git with the transaction capability before changing the index or ref", async () => {
    await baseCommit();
    await put("alpha/SKILL.md", skillContent("reviewed"));
    await put("notes.txt", "staged independently\n");
    git("add", "notes.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const beforeHead = text("rev-parse", "HEAD");
    const beforeIndex = await readFile(path.join(root, ".git", "index"));
    if (!supportsTransactions) {
      await expectFailure(commitSelected(approved, preview, "must not commit"), /git.*2\.48|2\.48.*git/i);
      expect(text("rev-parse", "HEAD")).toBe(beforeHead);
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(beforeIndex);
      expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("reviewed"));
      return;
    }
    const result = await commitSelected(approved, preview, "supported transaction");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD^")).toBe(beforeHead);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
  }, 30_000);
});
describe("real Git pull transactions", () => {
  it("leaves an already up-to-date repository unchanged", async (context) => {
    requireTransactions(context);
    await baseCommit();
    const { approved, oldHead } = await incomingPull([
      { path: "alpha/SKILL.md", data: skillContent("not incoming anymore") },
    ]);
    git("update-ref", "refs/remotes/fixture/trunk", oldHead);
    const preview = await previewPull(approved, ["alpha"]);
    const index = await readFile(path.join(root, ".git", "index"));
    const result = await pullApproved(approved, preview);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("base"));
    expect(await recoverSkillsGit(approved)).toBeUndefined();
  }, 30_000);

  it("refuses an intervening checkout to another branch at the same commit before touching the worktree", async (context) => {
    requireTransactions(context);
    await baseCommit();
    git("branch", "alternate");
    const { approved, preview, oldHead, target } = await incomingPull([
      { path: "alpha/SKILL.md", data: skillContent("incoming") },
    ]);
    git("switch", "--quiet", "alternate");
    const index = await readFile(path.join(root, ".git", "index"));
    await expect(withSkillsLock(approved, () => pullIndexWorktreeTransaction(approved, preview))).rejects.toThrow();
    expect(text("symbolic-ref", "HEAD")).toBe("refs/heads/alternate");
    expect(text("rev-parse", "refs/heads/trunk")).toBe(oldHead);
    expect(text("rev-parse", "refs/heads/alternate")).toBe(oldHead);
    expect(text("rev-parse", "refs/remotes/fixture/trunk")).toBe(target);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("base"));
  }, 30_000);

  it("fast-forwards despite squash configuration and preserves unrelated staged and unstaged data", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("notes.txt", "staged unrelated\n");
    git("add", "notes.txt");
    await put("alpha/other.txt", "unstaged unrelated\n");
    const { approved, preview, target } = await incomingPull([
      { path: "alpha/SKILL.md", data: skillContent("incoming") },
    ]);
    git("config", "branch.trunk.mergeOptions", "--squash");
    const staged = git("ls-files", "--stage", "-z", "--", "notes.txt");
    const result = await pullApproved(approved, preview);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD")).toBe(target);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("incoming"));
    expect(git("ls-files", "--stage", "-z", "--", "notes.txt")).toEqual(staged);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
    expect((await readdir(root)).filter((name) => name.startsWith(".skill-manager-txn-"))).toEqual([]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("staged unrelated\n");
    expect(await readFile(path.join(root, "alpha/other.txt"), "utf8")).toBe("unstaged unrelated\n");
  }, 30_000);

  it("pulls a restored worktree file with stale index stat data and preserves unrelated changes", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("notes.txt", "staged unrelated\n");
    git("add", "notes.txt");
    await put("alpha/other.txt", "unstaged unrelated\n");
    const { approved, target } = await incomingPull([
      { path: "alpha/SKILL.md", data: skillContent("incoming") },
    ]);
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const unrelatedIndex = git("ls-files", "--stage", "-z", "--", "notes.txt");
    await put("alpha/SKILL.md", "temporary local edit\n");
    await put("alpha/SKILL.md", skillContent("base"));
    await utimes(path.join(root, "alpha/SKILL.md"), 1, 1);
    const preview = await previewPull(approved, ["alpha"]);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);

    const result = await pullApproved(approved, preview);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD")).toBe(target);
    expect(git("show", ":alpha/SKILL.md")).toEqual(Buffer.from(skillContent("incoming")));
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("incoming"));
    expect(git("ls-files", "--stage", "-z", "--", "notes.txt")).toEqual(unrelatedIndex);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("staged unrelated\n");
    expect(await readFile(path.join(root, "alpha/other.txt"), "utf8")).toBe("unstaged unrelated\n");
  }, 30_000);

  it("refuses a conflicting staged entry during an index-only pull merge", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("notes.txt", "staged unrelated\n");
    git("add", "notes.txt");
    const { approved, preview, oldHead } = await incomingPull([
      { path: "alpha/SKILL.md", data: skillContent("incoming") },
    ]);
    const conflicting = text("rev-parse", "HEAD:alpha/other.txt");
    git("update-index", "--add", "--cacheinfo", `100644,${conflicting},alpha/SKILL.md`);
    const index = await readFile(path.join(root, ".git", "index"));

    await expect(withSkillsLock(approved, () => pullIndexWorktreeTransaction(approved, preview)))
      .rejects.toThrow(/overwritten|merge|index/i);
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("show", ":alpha/SKILL.md")).toEqual(Buffer.from("other base\n"));
    expect(git("show", ":notes.txt")).toEqual(Buffer.from("staged unrelated\n"));
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("base"));
    await expect(lstat(path.join(root, ".skills-manager", "git-transaction-journal"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("refuses an ignored incoming-path collision without changing the index or any worktree file", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put(".git/info/exclude", "alpha/ignored.txt\n");
    await put("alpha/ignored.txt", "ignored user data\n");
    const { approved, preview, oldHead } = await incomingPull([
      { path: "alpha/SKILL.md", data: skillContent("incoming") },
      { path: "alpha/ignored.txt", data: "incoming ignored-path content\n" },
    ]);
    const index = await readFile(path.join(root, ".git", "index"));
    await expect(pullApproved(approved, preview)).rejects.toThrow();
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(root, "alpha/ignored.txt"), "utf8")).toBe("ignored user data\n");
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("base"));
  }, 30_000);

  it("preserves ignored descendants when an incoming file would replace their directory", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("alpha/tree/tracked.txt", "tracked before pull\n");
    git("add", "alpha/tree/tracked.txt");
    git("commit", "-m", "base directory");
    await put(".git/info/exclude", "alpha/tree/ignored.txt\n");
    await put("alpha/tree/ignored.txt", "ignored user data\n");
    const { approved, preview, oldHead } = await incomingPull([
      { path: "alpha/tree/tracked.txt", data: null },
      { path: "alpha/tree", data: "incoming file\n" },
    ]);
    const index = await readFile(path.join(root, ".git", "index"));
    await expect(pullApproved(approved, preview)).rejects.toThrow();
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(root, "alpha/tree/tracked.txt"), "utf8")).toBe("tracked before pull\n");
    expect(await readFile(path.join(root, "alpha/tree/ignored.txt"), "utf8")).toBe("ignored user data\n");
  }, 30_000);

  it("safely applies file-directory and symlink transitions", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("alpha/asset", "ordinary file\n");
    await symlink("other.txt", path.join(root, "alpha/link"));
    await put("alpha/tree/leaf.txt", "ordinary nested file\n");
    git("add", "alpha/asset", "alpha/link", "alpha/tree/leaf.txt");
    git("commit", "-m", "transition base");
    const { approved, preview, target } = await incomingPull([
      { path: "alpha/asset", data: null },
      { path: "alpha/asset/child.txt", data: "incoming child\n" },
      { path: "alpha/link", data: "replaced link\n" },
      { path: "alpha/tree/leaf.txt", data: null },
      { path: "alpha/tree", data: "directory became a file\n" },
      { path: "alpha/other.txt", data: "asset/child.txt", mode: "120000" },
    ]);
    const result = await pullApproved(approved, preview);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD")).toBe(target);
    expect(await readFile(path.join(root, "alpha/asset/child.txt"), "utf8")).toBe("incoming child\n");
    expect((await lstat(path.join(root, "alpha/link"))).isFile()).toBe(true);
    expect(await readFile(path.join(root, "alpha/link"), "utf8")).toBe("replaced link\n");
    expect(await readFile(path.join(root, "alpha/tree"), "utf8")).toBe("directory became a file\n");
    expect((await lstat(path.join(root, "alpha/other.txt"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(root, "alpha/other.txt"))).toBe("asset/child.txt");
  }, 30_000);

  it("respects the user's umask for new files and directories", async (context) => {
    requireTransactions(context);
    await baseCommit();
    const { approved, preview } = await incomingPull([
      { path: "alpha/private/secret.txt", data: "private incoming data\n" },
    ]);
    const previous = process.umask(0o077);
    try {
      const result = await pullApproved(approved, preview);
      expect(result.exitCode, result.stderr).toBe(0);
    } finally {
      process.umask(previous);
    }
    expect((await lstat(path.join(root, "alpha/private"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(root, "alpha/private/secret.txt"))).mode & 0o777).toBe(0o600);
  }, 30_000);

  it("uses incoming attributes when materializing incoming files", async (context) => {
    requireTransactions(context);
    await baseCommit();
    await put("alpha/.gitattributes", "*.txt text eol=lf\n");
    await put("alpha/other.txt", "old\n");
    git("add", "alpha/.gitattributes", "alpha/other.txt");
    git("commit", "-m", "base attributes");
    const { approved, preview, target } = await incomingPull([
      { path: "alpha/.gitattributes", data: "*.txt text eol=crlf\n" },
      { path: "alpha/other.txt", data: "incoming\n" },
    ]);
    const result = await pullApproved(approved, preview);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD")).toBe(target);
    expect(await readFile(path.join(root, "alpha/other.txt"))).toEqual(Buffer.from("incoming\r\n"));
    expect(paths("diff", "--name-only", "-z")).toEqual([]);
  }, 30_000);

 });
