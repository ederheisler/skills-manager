import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, utimes, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { approveSkillsRoot, withSkillsLock, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { commitSelected, previewCommit, previewPull, pullApproved, recoverSkillsGit, type CommitPreview, type GitResult, type PullPreview } from "../../src/actions/git.js";
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

interface InterruptedJournal {
  id: string;
  lockId: string;
  head: string;
  oldIndex: string;
  newIndex: string;
}

async function crashPreparedCommit(approved: ApprovedSkillsRoot, preview: CommitPreview, signal: AbortSignal): Promise<InterruptedJournal> {
  const project = fileURLToPath(new URL("../../", import.meta.url));
  const module = new URL("../../src/actions/git.ts", import.meta.url).href;
  const script = `
    import { commitSelected } from ${JSON.stringify(module)};
    const [approved, preview] = JSON.parse(process.argv[1]);
    const result = await commitSelected(approved, preview, "interrupted fixture");
    if (result.exitCode !== 0) throw new Error(result.stderr);
  `;
  const headLock = path.join(preview.binding.gitDir, "HEAD.lock");
  const stateDir = path.join(approved.path, ".skills-manager");
  const journalFile = path.join(stateDir, "git-transaction-journal");
  const watcherAbort = new AbortController();
  const changes = await withSkillsLock(approved, async () =>
    watch(stateDir, { signal: AbortSignal.any([signal, watcherAbort.signal]) }));
  await writeFile(headLock, "fixture-owned lock\n", { flag: "wx", mode: 0o600 });
  const nextChange = () => changes.next().catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ABORT_ERR") return { done: true as const, value: undefined };
    throw error;
  });
  let changed = nextChange();
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([approved, preview]),
  ], { cwd: project, env: gitEnv, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
  });
  let killed = false;
  try {
    if (!child.pid) throw new Error("Cannot start the disposable commit process");
    let journal: InterruptedJournal | undefined;
    while (!journal) {
      const event = await Promise.race([
        changed.then((value) => ({ kind: "change" as const, value })),
        closed.then((value) => ({ kind: "exit" as const, value })),
      ]);
      if (event.kind === "exit") {
        throw new Error(`Commit exited before preparing its journal: ${spawnError?.message ?? stderr}`);
      }
      if (event.value.done) throw new Error("Waiting for the prepared transaction was cancelled");
      changed = nextChange();
      try {
        // The durable marker has a native binary envelope around its JSON.
        const marker = (await readFile(journalFile)).toString("latin1");
        if (marker.includes('\"phase\":\"prepared\"')) {
          const field = (name: string): string => {
            const value = new RegExp(`\"${name}\":\"([a-f0-9]+)\"`).exec(marker)?.[1];
            if (!value) throw new Error(`Prepared transaction journal has no ${name}`);
            return value;
          };
          journal = {
            id: field("id"), lockId: field("lockId"), head: field("head"),
            oldIndex: field("oldIndex"), newIndex: field("newIndex"),
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    expect(journal.id).toMatch(/^[a-f0-9]{32}$/);
    expect(journal.lockId).toMatch(/^[a-f0-9]{32}$/);
    expect(journal.head).toBe(preview.head);
    expect(journal.oldIndex).toBe(preview.indexFingerprint);
    expect(journal.newIndex).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(headLock, "utf8")).toBe("fixture-owned lock\n");
    process.kill(-child.pid, "SIGKILL");
    killed = true;
    expect((await closed).signal).toBe("SIGKILL");
    return journal;
  } finally {
    if (!killed && child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    watcherAbort.abort();
    try {
      await changed;
      await changes.return?.();
    } finally {
      await closed;
      await rm(headLock, { force: true });
    }
  }
}

async function interruptedFixture(signal: AbortSignal): Promise<{
  approved: ApprovedSkillsRoot; head: string; index: Buffer;
  staged: Buffer; journal: InterruptedJournal;
}> {
  await baseCommit();
  git("config", "core.filesRefLockTimeout", "30000");
  await put("alpha/SKILL.md", skillContent("reviewed before interruption"));
  await put("notes.txt", "independently staged\n");
  git("add", "notes.txt");
  const approved = await approveSkillsRoot(root);
  const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
  const head = text("rev-parse", "HEAD");
  const index = await readFile(path.join(root, ".git", "index"));
  const staged = git("ls-files", "--stage", "-z");
  const journal = await crashPreparedCommit(approved, preview, signal);
  expect(text("rev-parse", "HEAD")).toBe(head);
  expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
  expect(git("ls-files", "--stage", "-z")).toEqual(staged);
  return { approved, head, index, staged, journal };
}

async function installInterruptedIndex(journal: InterruptedJournal): Promise<Buffer> {
  const gitDir = path.join(root, ".git");
  const index = await readFile(path.join(gitDir, `.skill-manager-txn-${journal.id}.index`));
  expect(createHash("sha256").update(index).digest("hex")).toBe(journal.newIndex);
  const lock = path.join(gitDir, "index.lock");
  await writeFile(lock, index);
  await rename(lock, path.join(gitDir, "index"));
  expect(await readFile(path.join(gitDir, `.skill-manager-txn-${journal.lockId}.lock`))).toEqual(index);
  return index;
}

const journalMagic = "skills-manager-git-journal-v1\n";
function journalEnvelope(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const length = body.length.toString(16).padStart(16, "0");
  const digest = createHash("sha256").update(body).digest("hex");
  return Buffer.concat([Buffer.from(`${journalMagic}${length}\n${digest}\n`), body]);
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

  it("recovers a transaction killed before index installation and permits a freshly reviewed commit", async (context) => {
    requireTransactions(context);
    const { approved, head, index, staged } = await interruptedFixture(context.signal);
    const message = await recoverSkillsGit(approved);
    expect(message).toMatch(/interrupt|roll.*back/i);
    expect(text("symbolic-ref", "HEAD")).toBe("refs/heads/trunk");
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z")).toEqual(staged);
    await expect(readFile(path.join(root, ".skills-manager", "git-transaction-journal"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverSkillsGit(approved)).toBeUndefined();

    const fresh = await previewCommit(approved, ["alpha/SKILL.md"]);
    const result = await commitSelected(approved, fresh, "reviewed after recovery");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD^")).toBe(head);
    expect(paths("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD")).toEqual(["alpha/SKILL.md"]);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("independently staged\n");
  }, 60_000);

  it("binds interrupted parent-repository recovery to both roots and the selected prefix", async (context) => {
    requireTransactions(context);
    const selected = path.join(root, "project", "skills");
    await put("project/skills/alpha/SKILL.md", skillContent("base"));
    await put("notes.txt", "parent base\n");
    git("add", "--all");
    git("commit", "-m", "parent fixture base");
    git("config", "core.filesRefLockTimeout", "30000");
    await put("project/skills/alpha/SKILL.md", skillContent("reviewed before interruption"));
    await put("notes.txt", "independently staged parent content\n");
    git("add", "notes.txt");
    const approved = await approveSkillsRoot(selected);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const head = text("rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));
    const staged = git("ls-files", "--stage", "-z", "--", "notes.txt");
    await crashPreparedCommit(approved, preview, context.signal);

    const journal = path.join(selected, ".skills-manager", "git-transaction-journal");
    const envelope = await readFile(journal);
    const bodyOffset = Buffer.byteLength(journalMagic) + 16 + 1 + 64 + 1;
    const captured = JSON.parse(envelope.subarray(bodyOffset).toString("utf8")) as {
      phase: string;
      binding: {
        repositoryRoot: string;
        repositoryIdentity: { dev: string; ino: string };
        prefix: string;
      };
    };
    expect(captured.phase).toBe("prepared");
    expect(captured.binding).toMatchObject({
      repositoryRoot: root, repositoryIdentity: preview.binding.repositoryIdentity, prefix: "project/skills",
    });
    await rm(`${journal}.next`, { force: true });
    const mismatches = [
      { ...captured, binding: { ...captured.binding, prefix: "../notes.txt" } },
      { ...captured, binding: { ...captured.binding, prefix: "project/other-skills" } },
      { ...captured, binding: { ...captured.binding, repositoryRoot: outside } },
      {
        ...captured,
        binding: {
          ...captured.binding,
          repositoryIdentity: {
            ...captured.binding.repositoryIdentity,
            ino: (BigInt(captured.binding.repositoryIdentity.ino) + 1n).toString(),
          },
        },
      },
    ];
    for (const mismatch of mismatches) {
      const invalid = journalEnvelope(mismatch);
      await writeFile(journal, invalid, { mode: 0o600 });
      await expect(recoverSkillsGit(approved)).rejects.toThrow();
      expect(await readFile(journal)).toEqual(invalid);
      expect(text("rev-parse", "HEAD")).toBe(head);
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
      expect(git("ls-files", "--stage", "-z", "--", "notes.txt")).toEqual(staged);
      expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("independently staged parent content\n");
      expect(await readFile(path.join(selected, "alpha/SKILL.md"), "utf8"))
        .toBe(skillContent("reviewed before interruption"));
    }

    const legacyBinding: Partial<typeof captured.binding> = { ...captured.binding };
    delete legacyBinding.repositoryRoot;
    delete legacyBinding.repositoryIdentity;
    delete legacyBinding.prefix;
    const legacy = journalEnvelope({ ...captured, binding: legacyBinding });
    await writeFile(journal, legacy, { mode: 0o600 });
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/manual|inspect/i);
    await expect(commitSelected(approved, preview, "must not commit over legacy recovery")).rejects.toThrow(/manual|inspect/i);
    expect(await readFile(journal)).toEqual(legacy);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z", "--", "notes.txt")).toEqual(staged);
    await expect(lstat(`${journal}.next`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${journal}.delete`)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(journal, envelope, { mode: 0o600 });
    expect(await recoverSkillsGit(approved)).toMatch(/interrupt|roll.*back/i);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z", "--", "notes.txt")).toEqual(staged);
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverSkillsGit(approved)).toBeUndefined();
  }, 60_000);

  it("preserves a legacy leaf recovery journal and requires manual inspection", async (context) => {
    requireTransactions(context);
    const { approved, head, index, staged } = await interruptedFixture(context.signal);
    const journal = path.join(root, ".skills-manager", "git-transaction-journal");
    const envelope = await readFile(journal);
    const offset = Buffer.byteLength(journalMagic) + 16 + 1 + 64 + 1;
    const captured = JSON.parse(envelope.subarray(offset).toString("utf8")) as { binding: Record<string, unknown> };
    delete captured.binding.repositoryRoot;
    delete captured.binding.repositoryIdentity;
    delete captured.binding.prefix;
    const legacy = journalEnvelope(captured);
    await rm(`${journal}.next`, { force: true });
    await writeFile(journal, legacy, { mode: 0o600 });
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/manual|inspect/i);
    expect(await readFile(journal)).toEqual(legacy);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z")).toEqual(staged);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8"))
      .toBe(skillContent("reviewed before interruption"));
    await expect(lstat(`${journal}.next`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${journal}.delete`)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(journal, envelope, { mode: 0o600 });
    expect(await recoverSkillsGit(approved)).toMatch(/interrupt|roll.*back/i);
  }, 60_000);

  it("rolls back an installed index when a crash precedes the ref update", async (context) => {
    requireTransactions(context);
    const { approved, head, index, staged, journal } = await interruptedFixture(context.signal);
    const installed = await installInterruptedIndex(journal);
    expect(installed).not.toEqual(index);
    expect(git("show", ":alpha/SKILL.md")).toEqual(Buffer.from(skillContent("reviewed before interruption")));
    expect(text("rev-parse", "HEAD")).toBe(head);

    const message = await recoverSkillsGit(approved);
    expect(message).toMatch(/interrupt|roll.*back/i);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z")).toEqual(staged);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe(skillContent("reviewed before interruption"));
    await expect(readFile(path.join(root, ".skills-manager", "git-transaction-journal"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, ".git", `.skill-manager-txn-${journal.lockId}.lock`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverSkillsGit(approved)).toBeUndefined();
  }, 60_000);

  it("does not overwrite an independently changed index during restart recovery", async (context) => {
    requireTransactions(context);
    const { approved, head, index, journal } = await interruptedFixture(context.signal);
    const installed = await installInterruptedIndex(journal);
    await put("notes.txt", "staged after the interrupted transaction\n");
    git("add", "notes.txt");
    const newerIndex = await readFile(path.join(root, ".git", "index"));
    expect(newerIndex).not.toEqual(index);
    expect(newerIndex).not.toEqual(installed);

    await expect(recoverSkillsGit(approved)).rejects.toThrow(/index|changed|conflict|lock|ESTALE/i);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(newerIndex);
    expect(git("show", ":notes.txt")).toEqual(Buffer.from("staged after the interrupted transaction\n"));
    expect(git("show", ":alpha/SKILL.md")).toEqual(Buffer.from(skillContent("reviewed before interruption")));
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("staged after the interrupted transaction\n");
    expect((await readFile(path.join(root, ".skills-manager", "git-transaction-journal"))).length).toBeGreaterThan(0);
  }, 60_000);

  it("recovers safe staged and deleted journals and preserves conflicting envelopes", async (context) => {
    requireTransactions(context);
    const { approved, head, index, staged } = await interruptedFixture(context.signal);
    const journal = path.join(root, ".skills-manager", "git-transaction-journal");
    const next = `${journal}.next`;
    const deleting = `${journal}.delete`;
    const envelope = await readFile(journal);
    expect(envelope.subarray(0, Buffer.byteLength(journalMagic)).toString("utf8")).toBe(journalMagic);
    const bodyOffset = Buffer.byteLength(journalMagic) + 16 + 1 + 64 + 1;
    const captured = JSON.parse(envelope.subarray(bodyOffset).toString("utf8")) as {
      id: string; phase: string; binding: { root: { dev: string; ino: string } };
    };
    expect(captured.phase).toBe("prepared");
    // The killed writer may have left its own displaced staging file.
    await rm(next, { force: true });
    const mismatches = [
      { ...captured, id: captured.id === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32) },
      { ...captured, binding: { ...captured.binding, root: { ...captured.binding.root, ino: (BigInt(captured.binding.root.ino) + 1n).toString() } } },
    ];
    for (const mismatch of mismatches) {
      const collision = journalEnvelope(mismatch);
      await writeFile(next, collision, { flag: "wx", mode: 0o600 });
      await expect(recoverSkillsGit(approved)).rejects.toThrow(/journal|staging|ambiguous|match|invalid|conflict|EBADMSG|EBUSY/i);
      expect(await readFile(journal)).toEqual(envelope);
      expect(await readFile(next)).toEqual(collision);
      expect(text("rev-parse", "HEAD")).toBe(head);
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
      await rm(next);
    }
    await writeFile(deleting, envelope, { flag: "wx", mode: 0o600 });
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/conflict|journal/i);
    expect(await readFile(journal)).toEqual(envelope);
    expect(await readFile(deleting)).toEqual(envelope);
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    await rm(deleting);

    expect(await recoverSkillsGit(approved)).toMatch(/interrupt|roll.*back/i);
    await expect(readFile(journal)).rejects.toMatchObject({ code: "ENOENT" });
    await withSkillsLock(approved, () => writeFile(deleting, envelope, { flag: "wx", mode: 0o600 }));
    expect(await recoverSkillsGit(approved)).toMatch(/interrupt.*journal.*deletion|journal.*deletion.*recover/i);
    await expect(readFile(deleting)).rejects.toMatchObject({ code: "ENOENT" });
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z")).toEqual(staged);
    await withSkillsLock(approved, () => writeFile(next, envelope, { flag: "wx", mode: 0o600 }));
    await expect(recoverSkillsGit(approved)).rejects.toThrow(/journal|staging|ambiguous|invalid|conflict|EBADMSG|EBUSY/i);
    expect(await readFile(next)).toEqual(envelope);
    await rm(next);
    const initial = journalEnvelope({
      ...captured, phase: "started", newIndex: null, lockId: null, lock: null,
      backupIdentity: null, indexIdentity: null,
    });
    await withSkillsLock(approved, () => writeFile(next, initial, { flag: "wx", mode: 0o600 }));

    expect(await recoverSkillsGit(approved)).toMatch(/interrupt.*journal.*staging|journal.*staging.*recover/i);
    await expect(readFile(next)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(journal)).rejects.toMatchObject({ code: "ENOENT" });
    expect(text("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git("ls-files", "--stage", "-z")).toEqual(staged);
    expect(await recoverSkillsGit(approved)).toBeUndefined();

    const fresh = await previewCommit(approved, ["alpha/SKILL.md"]);
    const result = await commitSelected(approved, fresh, "reviewed after staging recovery");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(text("rev-parse", "HEAD^")).toBe(head);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
  }, 60_000);

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
async function interruptedPullFixture(signal: AbortSignal, workerOnly = false): Promise<{
  approved: ApprovedSkillsRoot; oldHead: string; target: string; index: Buffer; files: string[];
}> {
  await baseCommit();
  const files = Array.from({ length: 32 }, (_, index) => `alpha/part-${String(index).padStart(2, "0")}.txt`);
  await Promise.all(files.map((file) => put(file, `old ${file}\n`)));
  git("add", "--", ...files);
  git("commit", "-m", "base pull assets");
  await put("notes.txt", "staged independently\n");
  git("add", "notes.txt");
  const { approved, preview, oldHead, target } = await incomingPull(
    files.map((file) => ({ path: file, data: `incoming ${file}\n` })),
  );
  const index = await readFile(path.join(root, ".git", "index"));
  const project = fileURLToPath(new URL("../../", import.meta.url));
  const module = new URL("../../src/actions/git.ts", import.meta.url).href;
  // A watch event reports a move but does not stop the transaction. Pause the
  // disposable worker on its bridge response after the first real preimage
  // move, before it can send Git the ref-commit command.
  const preload = path.join(sandbox, "pause-pull-worker.cjs");
  const executable = path.join(sandbox, "node-pull-worker");
  await writeFile(preload, `
    const fs = require("node:fs");
    const { syncBuiltinESMExports } = require("node:module");
    const read = fs.readSync;
    let stopped = false;
    fs.readSync = function(fd, ...args) {
      const count = read.call(this, fd, ...args);
      if (fd === 6 && count > 0 && !stopped && !fs.existsSync(${JSON.stringify(path.join(root, files[0]))})) {
        stopped = true;
        process.kill(process.pid, "SIGSTOP");
      }
      return count;
    };
    syncBuiltinESMExports();
  `);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preload)} "$@"\n`, { mode: 0o700 });
  const script = `
    process.execPath = ${JSON.stringify(executable)};
    import { pullApproved } from ${JSON.stringify(module)};
    const [approved, preview] = JSON.parse(process.argv[1]);
    const result = await pullApproved(approved, preview);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  `;
  const watcherAbort = new AbortController();
  const changes = await withSkillsLock(approved, async () =>
    watch(path.join(root, "alpha"), { signal: AbortSignal.any([signal, watcherAbort.signal]) }));
  const nextChange = () => changes.next().catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ABORT_ERR") return { done: true as const, value: undefined };
    throw error;
  });
  let changed = nextChange();
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([approved, preview]),
  ], { cwd: project, env: gitEnv, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closedResult = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("close", (code, childSignal) => closedResult.resolve({ code, signal: childSignal }));
  const closed = closedResult.promise;
  let completed = false;
  try {
    if (!child.pid) throw new Error("Cannot start the disposable pull process");
    const event = await Promise.race([
      changed.then((value) => ({ kind: "change" as const, value })),
      closed.then((value) => ({ kind: "exit" as const, value })),
    ]);
    if (event.kind === "exit") throw new Error(`Pull exited before a worktree move: ${stderr}`);
    if (event.value.done) throw new Error("Waiting for the interrupted pull was cancelled");
    changed = nextChange();
    const envelope = await readFile(path.join(root, ".skills-manager", "git-transaction-journal"));
    const offset = Buffer.byteLength(journalMagic) + 16 + 1 + 64 + 1;
    const journal = JSON.parse(envelope.subarray(offset).toString("utf8")) as {
      phase: string; refLock: { pid: number; proof: string | null };
    };
    expect(journal.phase).toBe("prepared");
    expect(journal.refLock.proof).toMatch(/^[a-f0-9]+$/);
    const workerPid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(journal.refLock.pid)], {
      encoding: "utf8",
    }).trim());
    if (!Number.isSafeInteger(workerPid) || workerPid <= 1 || workerPid === child.pid) {
      throw new Error("Cannot identify the transaction worker process");
    }
    while (true) {
      const state = execFileSync("ps", ["-o", "state=", "-p", String(workerPid)], { encoding: "utf8" }).trim();
      if (state.startsWith("T")) break;
      await delay(20, undefined, { signal });
    }
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect((await lstat(path.join(root, ".git", "HEAD.lock"))).isFile()).toBe(true);
    expect((await lstat(path.join(root, ".git", "refs/heads/trunk.lock"))).isFile()).toBe(true);
    await expect(lstat(path.join(root, files[0]))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, files[files.length - 1]), "utf8"))
      .toBe(`old ${files[files.length - 1]}\n`);
    if (workerOnly) {
      process.kill(workerPid, "SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const abortClose = () => aborted.reject(new Error("Waiting for the killed pull process was cancelled"));
    signal.addEventListener("abort", abortClose, { once: true });
    let outcome: { code: number | null; signal: NodeJS.Signals | null };
    try { outcome = await Promise.race([closed, aborted.promise]); }
    finally { signal.removeEventListener("abort", abortClose); }
    if (workerOnly) expect(outcome.code).not.toBe(0);
    else expect(outcome.signal).toBe("SIGKILL");
    for (let attempts = 0; ; attempts++) {
      try { process.kill(journal.refLock.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (attempts >= 200) throw new Error("The killed Git reference process was not reaped");
      // OS process reaping is an external event and cannot use fake timers.
      await delay(20);
    }
    completed = true;
    return { approved, oldHead, target, index, files };
  } finally {
    if (!completed && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    watcherAbort.abort();
    await changed;
    await changes.return?.();
    await closed;
  }
}


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

  it("recovers partially applied files and ref locks after the whole transaction is killed", async (context) => {
    requireTransactions(context);
    const { approved, oldHead, target, index, files } = await interruptedPullFixture(context.signal);
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    const message = await recoverSkillsGit(approved);
    expect(message).toBeTruthy();
    expect(text("rev-parse", "HEAD")).toBe(target);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("staged independently\n");
    for (const file of files) {
      expect(await readFile(path.join(root, file), "utf8")).toBe(`incoming ${file}\n`);
    }
    await expect(lstat(path.join(root, ".git", "HEAD.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, ".git", "refs/heads/trunk.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverSkillsGit(approved)).toBeUndefined();
  }, 120_000);

  it("releases the prepared ref transaction when only the worker is killed", async (context) => {
    requireTransactions(context);
    const { approved, oldHead, target, index, files } = await interruptedPullFixture(context.signal, true);
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    await expect(lstat(path.join(root, ".git", "HEAD.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, ".git", "refs/heads/trunk.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverSkillsGit(approved)).toBeTruthy();
    expect(text("rev-parse", "HEAD")).toBe(target);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("staged independently\n");
    for (const file of files) {
      expect(await readFile(path.join(root, file), "utf8")).toBe(`incoming ${file}\n`);
    }
    expect(await recoverSkillsGit(approved)).toBeUndefined();
  }, 120_000);

  it("finishes an interrupted pull when its reference has already advanced", async (context) => {
    requireTransactions(context);
    const { approved, oldHead, target, index, files } = await interruptedPullFixture(context.signal);
    // Advance with real Git after releasing only the killed fixture's locks,
    // reproducing the durable post-ref/pre-index state.
    await rm(path.join(root, ".git", "HEAD.lock"));
    await rm(path.join(root, ".git", "refs/heads/trunk.lock"));
    git("update-ref", "HEAD", target, oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await recoverSkillsGit(approved)).toBeTruthy();
    expect(text("rev-parse", "HEAD")).toBe(target);
    expect(paths("diff", "--cached", "--name-only", "-z")).toEqual(["notes.txt"]);
    for (const file of files) {
      expect(await readFile(path.join(root, file), "utf8")).toBe(`incoming ${file}\n`);
    }
    expect(await recoverSkillsGit(approved)).toBeUndefined();
  }, 120_000);

  it("preserves a foreign edit and its journal after an interrupted pull", async (context) => {
    requireTransactions(context);
    const { approved, oldHead, index, files } = await interruptedPullFixture(context.signal);
    const file = files[files.length - 1];
    await put(file, "changed independently after interruption\n");
    await expect(recoverSkillsGit(approved)).rejects.toThrow();
    expect(text("rev-parse", "HEAD")).toBe(oldHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(root, file), "utf8")).toBe("changed independently after interruption\n");
    expect((await readFile(path.join(root, ".skills-manager", "git-transaction-journal"))).length).toBeGreaterThan(0);
  }, 120_000);

});
