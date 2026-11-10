import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { approveSkillsRoot } from "../../src/actions/boundary.js";
import {
  addRemoteApproved, commitSelected, discoverGit, fetchApproved, getFileDiff, getStatus,
  initializeSkillsRepo, previewAddRemote, previewCommit, previewFetch, previewInitialize, previewPull, previewPush, pullApproved, recoverSkillsGit,
  pushApproved, redactGitUrl,
} from "../../src/actions/git.js";

let sandbox: string;
let home: string;
let priorHome: string | undefined;
let priorXdg: string | undefined;
let priorNoProxy: string | undefined;
let priorNoProxyLower: string | undefined;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trimEnd();
}
async function repository(dir: string, branch = "trunk"): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-b", branch);
  git(dir, "config", "user.name", "Fixture Author");
  git(dir, "config", "user.email", "fixture@example.invalid");
}
async function skill(root: string, name: string, content = "initial\n"): Promise<void> {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name.split("/").at(-1)}\n---\n${content}`);
}
async function initialCommit(root: string): Promise<void> {
  git(root, "add", "--all");
  git(root, "commit", "-m", "initial skill");
}

async function parentRepository(): Promise<{ root: string; selected: string }> {
  const root = path.join(sandbox, "parent");
  const selected = path.join(root, "project", "skills");
  await repository(root);
  await skill(selected, "alpha");
  await skill(selected, ".disabled_skills/beta");
  await skill(path.join(root, "neighbor"), "outside");
  await writeFile(path.join(root, "staged.txt"), "staged base\n");
  await writeFile(path.join(root, "unstaged.txt"), "unstaged base\n");
  await initialCommit(root);
  return { root, selected };
}

function parentPeer(root: string): string {
  const peer = path.join(sandbox, "peer");
  git(sandbox, "clone", "--no-hardlinks", "--branch", "trunk", root, peer);
  git(peer, "config", "user.name", "Peer");
  git(peer, "config", "user.email", "peer@example.invalid");
  git(root, "remote", "add", "vault", peer);
  git(root, "config", "branch.trunk.remote", "vault");
  git(root, "config", "branch.trunk.merge", "refs/heads/trunk");
  return peer;
}

async function identity(file: string, link = false): Promise<{ dev: string; ino: string }> {
  const info = link ? await lstat(file, { bigint: true }) : await stat(file, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

async function expectParentConfigurationUnchanged(root: string, selected: string, config: Buffer, exclude: Buffer): Promise<void> {
  expect(await readFile(path.join(root, ".git", "config"))).toEqual(config);
  expect(await readFile(path.join(root, ".git", "info", "exclude"))).toEqual(exclude);
  await expect(lstat(path.join(selected, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(selected, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(home, ".gitconfig"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(home, ".config", "git", "config"))).rejects.toMatchObject({ code: "ENOENT" });
}

function addFakeSignature(root: string): void {
  const commit = git(root, "cat-file", "commit", "HEAD").replace(
    "\n\n", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n",
  );
  const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd: root, input: `${commit}\n`, encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  git(root, "update-ref", "HEAD", oid);
}

async function watchPromisorFetch(root: string): Promise<string> {
  const marker = path.join(sandbox, "upload-pack-ran");
  const uploadPack = path.join(sandbox, "upload-pack");
  await writeFile(uploadPack, `#!/bin/sh\ntouch '${marker}'\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
  git(root, "config", "remote.vault.uploadpack", uploadPack);
  git(root, "fetch", "vault", "trunk");
  await rm(marker);
  return marker;
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "skills-git-")));
  home = path.join(sandbox, "home");
  await mkdir(home);
  priorHome = process.env.HOME;
  priorXdg = process.env.XDG_CONFIG_HOME;
  priorNoProxy = process.env.NO_PROXY;
  priorNoProxyLower = process.env.no_proxy;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.no_proxy = "127.0.0.1,localhost";
});
afterEach(async () => {
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
  if (priorNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = priorNoProxy;
  if (priorNoProxyLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = priorNoProxyLower;
  await rm(sandbox, { recursive: true, force: true });
});

describe("Git repository boundary", () => {
  it("uses a tracked containing repository without exposing or committing unrelated changes", async () => {
    const { root, selected } = await parentRepository();
    await writeFile(path.join(selected, "alpha", "SKILL.md"), "selected change\n");
    await writeFile(path.join(selected, ".disabled_skills", "beta", "SKILL.md"), "unselected skill change\n");
    await writeFile(path.join(root, "staged.txt"), "staged change\n");
    git(root, "add", "staged.txt");
    await writeFile(path.join(root, "unstaged.txt"), "unstaged change\n");
    await writeFile(path.join(root, "neighbor", "outside", "SKILL.md"), "outside skill change\n");
    const stagedIndex = git(root, "ls-files", "--stage", "--", "staged.txt");
    const stagedDiff = git(root, "diff", "--cached", "--", "staged.txt");
    const config = await readFile(path.join(root, ".git", "config"));
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"));
    const head = git(root, "rev-parse", "HEAD");

    expect(await discoverGit(selected)).toMatchObject({
      kind: "parent", selectedDir: selected, topLevel: root, gitDir: path.join(root, ".git"),
      commonDir: path.join(root, ".git"), branch: "trunk", head, parentTracked: true,
    });
    expect((await getStatus(selected)).map((entry) => entry.path).sort()).toEqual([
      ".disabled_skills/beta/SKILL.md", "alpha/SKILL.md",
    ]);
    const diff = await getFileDiff(selected, "alpha/SKILL.md", false);
    expect(diff.stdout).toContain("-initial");
    expect(diff.stdout).toContain("+selected change");
    expect(diff.stdout).toContain("/alpha/SKILL.md");
    expect(diff.stdout).not.toContain("project/skills/alpha");
    await expect(getFileDiff(selected, "../staged.txt", false)).rejects.toThrow(/invalid|reserved/i);

    const approved = await approveSkillsRoot(selected);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    expect(preview).toMatchObject({
      root: selected, paths: ["alpha/SKILL.md"],
      binding: {
        root: await identity(selected),
        repositoryRoot: root, repositoryIdentity: await identity(root), prefix: "project/skills",
        gitEntry: await identity(path.join(root, ".git"), true),
        gitDir: path.join(root, ".git"), gitDirIdentity: await identity(path.join(root, ".git")),
        commonDir: path.join(root, ".git"), commonDirIdentity: await identity(path.join(root, ".git")),
      },
    });
    const result = await commitSelected(approved, preview, "selected skill");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(git(root, "rev-parse", "HEAD^")).toBe(head);
    expect(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))
      .toBe("project/skills/alpha/SKILL.md");
    expect(git(root, "show", "HEAD:project/skills/alpha/SKILL.md")).toBe("selected change");
    expect(git(root, "show", "HEAD:staged.txt")).toBe("staged base");
    expect(git(root, "show", ":staged.txt")).toBe("staged change");
    expect(git(root, "ls-files", "--stage", "--", "staged.txt")).toBe(stagedIndex);
    expect(git(root, "diff", "--cached", "--", "staged.txt")).toBe(stagedDiff);
    expect(await readFile(path.join(root, "unstaged.txt"), "utf8")).toBe("unstaged change\n");
    expect(await readFile(path.join(root, "neighbor", "outside", "SKILL.md"), "utf8")).toBe("outside skill change\n");
    expect(await readFile(path.join(selected, ".disabled_skills", "beta", "SKILL.md"), "utf8")).toBe("unselected skill change\n");
    expect((await getStatus(selected)).map((entry) => entry.path)).toEqual([".disabled_skills/beta/SKILL.md"]);
    await expectParentConfigurationUnchanged(root, selected, config, exclude);
  });

  it("commits selected skills from a linked parent worktree using its own Git entry and shared metadata", async () => {
    const { root } = await parentRepository();
    const linked = path.join(sandbox, "linked");
    git(root, "worktree", "add", "-b", "linked", linked);
    const selected = path.join(linked, "project", "skills");
    const gitDir = await realpath(git(linked, "rev-parse", "--absolute-git-dir"));
    const commonDir = await realpath(path.resolve(linked, git(linked, "rev-parse", "--git-common-dir")));
    const head = git(root, "rev-parse", "HEAD");
    const config = await readFile(path.join(commonDir, "config"));
    const exclude = await readFile(path.join(commonDir, "info", "exclude"));
    await writeFile(path.join(selected, "alpha", "SKILL.md"), "linked selected change\n");
    await writeFile(path.join(linked, "staged.txt"), "linked staged change\n");
    git(linked, "add", "staged.txt");
    const staged = git(linked, "ls-files", "--stage", "--", "staged.txt");
    const approved = await approveSkillsRoot(selected);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    expect(preview).toMatchObject({
      root: selected, paths: ["alpha/SKILL.md"],
      binding: {
        root: await identity(selected), repositoryRoot: linked, repositoryIdentity: await identity(linked),
        prefix: "project/skills", gitEntry: await identity(path.join(linked, ".git"), true),
        gitDir, gitDirIdentity: await identity(gitDir), commonDir, commonDirIdentity: await identity(commonDir),
      },
    });
    const result = await commitSelected(approved, preview, "linked selected skill");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(git(linked, "show", "HEAD:project/skills/alpha/SKILL.md")).toBe("linked selected change");
    expect(git(linked, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))
      .toBe("project/skills/alpha/SKILL.md");
    expect(git(linked, "ls-files", "--stage", "--", "staged.txt")).toBe(staged);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(commonDir, "config"))).toEqual(config);
    expect(await readFile(path.join(commonDir, "info", "exclude"))).toEqual(exclude);
    await expect(lstat(path.join(selected, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a deeply nested pathspec-like repository prefix literally in status, diff, and commit", async () => {
    const root = path.join(sandbox, "parent");
    const selected = path.join(root, "level[1]", ":(exclude)skills");
    const similar = path.join(root, "level1", ":(exclude)skills");
    await repository(root);
    await skill(selected, "alpha");
    await skill(similar, "alpha");
    await initialCommit(root);
    await writeFile(path.join(selected, "alpha", "SKILL.md"), "selected literal prefix\n");
    await writeFile(path.join(similar, "alpha", "SKILL.md"), "similar outside prefix\n");
    const sibling = git(root, "ls-files", "--stage", "--", "level1/:(exclude)skills/alpha/SKILL.md");
    const approved = await approveSkillsRoot(selected);
    expect(await discoverGit(selected)).toMatchObject({ kind: "parent", topLevel: root, parentTracked: true });
    expect((await getStatus(selected)).map((entry) => entry.path)).toEqual(["alpha/SKILL.md"]);
    expect((await getFileDiff(selected, "alpha/SKILL.md", false)).stdout).toContain("+selected literal prefix");
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    expect(preview.binding.prefix).toBe("level[1]/:(exclude)skills");
    expect(preview.paths).toEqual(["alpha/SKILL.md"]);
    const result = await commitSelected(approved, preview, "literal selected prefix");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(git(root, "show", "HEAD:level[1]/:(exclude)skills/alpha/SKILL.md")).toBe("selected literal prefix");
    expect(git(root, "show", "HEAD:level1/:(exclude)skills/alpha/SKILL.md")).toContain("initial");
    expect(git(root, "ls-files", "--stage", "--", "level1/:(exclude)skills/alpha/SKILL.md")).toBe(sibling);
    expect(await readFile(path.join(similar, "alpha", "SKILL.md"), "utf8")).toBe("similar outside prefix\n");
  });

  it("does not execute Git from the containing worktree or its PATH aliases during parent discovery and actions", async () => {
    const { root, selected } = await parentRepository();
    const bin = path.join(root, "bin");
    const alias = path.join(sandbox, "bin-alias");
    const marker = path.join(selected, "fake-git-ran");
    await mkdir(bin);
    await mkdir(alias);
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`, { mode: 0o755 });
    await symlink(path.join(bin, "git"), path.join(alias, "git"));
    await writeFile(path.join(selected, "alpha", "SKILL.md"), "reviewed change\n");
    const approved = await approveSkillsRoot(selected);
    const oldPath = process.env.PATH;
    try {
      for (const directory of [bin, alias]) {
        process.env.PATH = `${directory}${path.delimiter}${oldPath ?? ""}`;
        expect(await discoverGit(selected)).toMatchObject({ kind: "parent", topLevel: root });
        expect((await getStatus(selected)).map((entry) => entry.path)).toEqual(["alpha/SKILL.md"]);
        expect((await previewCommit(approved, ["alpha/SKILL.md"])).root).toBe(selected);
        await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });

  it("does not execute Git from external linked-worktree metadata or its PATH alias during discovery", async () => {
    const { root } = await parentRepository();
    const linked = path.join(sandbox, "linked");
    git(root, "worktree", "add", "-b", "linked", linked);
    const selected = path.join(linked, "project", "skills");
    const gitDir = await realpath(git(linked, "rev-parse", "--absolute-git-dir"));
    const bin = path.join(gitDir, "bin");
    const alias = path.join(sandbox, "linked-bin-alias");
    const marker = path.join(selected, "fake-git-ran");
    await mkdir(bin);
    await mkdir(alias);
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`, { mode: 0o755 });
    await symlink(path.join(bin, "git"), path.join(alias, "git"));
    await writeFile(path.join(selected, "alpha", "SKILL.md"), "linked review\n");
    const oldPath = process.env.PATH;
    try {
      for (const directory of [bin, alias]) {
        process.env.PATH = `${directory}${path.delimiter}${oldPath ?? ""}`;
        expect(await discoverGit(selected)).toMatchObject({ kind: "parent", topLevel: linked, gitDir });
        expect((await getStatus(selected)).map((entry) => entry.path)).toEqual(["alpha/SKILL.md"]);
        const preview = await previewCommit(await approveSkillsRoot(selected), ["alpha/SKILL.md"]);
        expect(preview.binding).toMatchObject({ repositoryRoot: linked, gitDir, prefix: "project/skills" });
        await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });

  it("still refuses initialization inside an unexcluded parent without changing its staged data", async () => {
    const root = path.join(sandbox, "parent");
    const selected = path.join(root, "skills");
    await repository(root);
    await skill(selected, "one");
    await writeFile(path.join(root, "staged"), "base\n");
    git(root, "add", "staged");
    git(root, "commit", "-m", "parent base");
    await writeFile(path.join(root, "staged"), "staged change\n");
    git(root, "add", "staged");
    const index = await readFile(path.join(root, ".git", "index"));
    const config = await readFile(path.join(root, ".git", "config"));
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"));
    expect(await discoverGit(selected)).toMatchObject({
      kind: "parent", topLevel: root, parentTracked: false, parentExcluded: false,
    });
    await expect(previewInitialize(await approveSkillsRoot(selected))).rejects.toThrow(/already|parent|repository/i);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(root, "staged"), "utf8")).toBe("staged change\n");
    await expectParentConfigurationUnchanged(root, selected, config, exclude);
  });

  it("refuses initialization for tracked or manually excluded directories inside a parent repository", async () => {
    const root = path.join(sandbox, "parent");
    const selected = path.join(root, "skills");
    await repository(root);
    await skill(selected, "one");
    git(root, "add", "skills/one/SKILL.md");
    const before = git(root, "ls-files", "--stage");
    const index = await readFile(path.join(root, ".git", "index"));
    const config = await readFile(path.join(root, ".git", "config"));
    expect(await discoverGit(selected)).toMatchObject({ kind: "parent", parentTracked: true });
    await expect(previewInitialize(await approveSkillsRoot(selected))).rejects.toThrow(/already|parent|repository/i);
    expect(git(root, "ls-files", "--stage")).toBe(before);
    await expect(lstat(path.join(selected, ".git"))).rejects.toMatchObject({ code: "ENOENT" });

    const other = path.join(root, "other-skills");
    await skill(other, "two");
    const exclude = path.join(root, ".git", "info", "exclude");
    await writeFile(exclude, "/other-skills/\n");
    const exclusionBefore = await readFile(exclude);
    expect(await discoverGit(other)).toMatchObject({ kind: "parent", parentExcluded: true, parentTracked: false });
    await expect(previewInitialize(await approveSkillsRoot(other))).rejects.toThrow(/already|parent|repository/i);
    expect(await discoverGit(other)).toMatchObject({ kind: "parent", parentExcluded: true, parentTracked: false });
    expect(await readFile(exclude)).toEqual(exclusionBefore);
    expect(await readFile(path.join(root, ".git", "config"))).toEqual(config);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git(root, "ls-files", "--stage")).toBe(before);
    await expect(lstat(path.join(other, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a pathspec-like selected directory as a literal when checking the parent index", async () => {
    const root = path.join(sandbox, "parent");
    const selected = path.join(root, ":(exclude)skills");
    await repository(root);
    await skill(selected, "one");
    git(root, "add", "--", ":(literal):(exclude)skills/one/SKILL.md");
    expect(await discoverGit(selected)).toMatchObject({ kind: "parent", parentTracked: true });
    await expect(previewInitialize(await approveSkillsRoot(selected))).rejects.toThrow(/already|parent|repository/i);
  });

  it("checks parent exclusions for pathspec-like directory names exactly", async () => {
    const root = path.join(sandbox, "parent");
    const selected = path.join(root, "skill*");
    await repository(root);
    await skill(selected, "one");
    await skill(path.join(root, "skill-other"), "two");
    await writeFile(path.join(root, ".gitignore"), "/skill-other/\n");
    expect(await discoverGit(selected)).toMatchObject({ kind: "parent", parentTracked: false, parentExcluded: false });
    await writeFile(path.join(root, ".gitignore"), "/skill[*]/\n");
    expect(await discoverGit(selected)).toMatchObject({ kind: "parent", parentTracked: false, parentExcluded: true });
  });

  it("distinguishes absent Git, no repository, unborn, detached, and leaf worktrees", async () => {
    const plain = path.join(sandbox, "plain");
    await mkdir(plain);
    expect(await discoverGit(plain)).toMatchObject({ kind: "none" });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = path.join(sandbox, "missing-bin");
      expect(await discoverGit(plain)).toMatchObject({ kind: "unavailable" });
      const nonDirectory = path.join(sandbox, "not-a-directory");
      await writeFile(nonDirectory, "not a PATH directory");
      process.env.PATH = nonDirectory;
      expect(await discoverGit(plain)).toMatchObject({ kind: "unavailable" });
    } finally { process.env.PATH = previousPath; }

    const root = path.join(sandbox, "repo");
    await repository(root, "unusual-branch");
    expect(await discoverGit(root)).toMatchObject({ kind: "leaf", branch: "unusual-branch", head: null, upstream: null });
    await skill(root, "one");
    await initialCommit(root);
    const worktree = path.join(sandbox, "worktree");
    git(root, "worktree", "add", "-b", "another", worktree);
    expect(await discoverGit(worktree)).toMatchObject({ kind: "leaf", topLevel: worktree, branch: "another" });
    git(worktree, "checkout", "--detach");
    expect(await discoverGit(worktree)).toMatchObject({ kind: "leaf", branch: null });
    const approved = await approveSkillsRoot(worktree);
    await expect(previewPush(approved)).rejects.toThrow(/attached branch/);
    const originalHead = git(root, "rev-parse", "HEAD");
    await writeFile(path.join(worktree, "one", "SKILL.md"), "worktree only\n");
    const reviewed = await previewCommit(approved, ["one/SKILL.md"]);
    expect((await commitSelected(approved, reviewed, "detached worktree commit")).exitCode).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    expect(git(worktree, "show", "HEAD:one/SKILL.md")).toBe("worktree only");
  });

  it("treats malicious Git environment redirection as untrusted", async () => {
    const one = path.join(sandbox, "one");
    const other = path.join(sandbox, "other");
    await repository(one);
    await repository(other);
    await skill(one, "alpha");
    const changes: NodeJS.ProcessEnv = {
      GIT_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: path.join(other, ".git", "index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: other,
    };
    const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, changes);
      expect(await discoverGit(one)).toMatchObject({ kind: "leaf", selectedDir: one, topLevel: one });
      expect((await getStatus(one)).map((entry) => entry.path)).toEqual(["alpha/SKILL.md"]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("does not execute a repository-local Git binary through relative or symlinked PATH entries", async () => {
    const root = path.join(sandbox, "skills");
    const sentinel = path.join(sandbox, "executed");
    await repository(root);
    await writeFile(path.join(root, "git"), `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`, { mode: 0o755 });
    const pathAlias = path.join(sandbox, "git-path-alias");
    await symlink(root, pathAlias, "dir");
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `.:${oldPath ?? ""}`;
      expect(await discoverGit(root)).toMatchObject({ kind: "leaf", topLevel: root });
      process.env.PATH = `${pathAlias}:${oldPath ?? ""}`;
      expect(await discoverGit(root)).toMatchObject({ kind: "leaf", topLevel: root });
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });

  it("rejects a selected root replaced after approval without touching either repository", async () => {
    const root = path.join(sandbox, "skills");
    const original = path.join(sandbox, "original");
    const decoy = path.join(sandbox, "decoy");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    await writeFile(path.join(root, "alpha/SKILL.md"), "reviewed\n");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const before = git(root, "rev-parse", "HEAD");
    await repository(decoy);
    await skill(decoy, "other");
    await initialCommit(decoy);
    const decoyBefore = git(decoy, "rev-parse", "HEAD");
    await rename(root, original);
    await symlink(decoy, root, "dir");
    await expect(commitSelected(approved, preview, "must not write")).rejects.toThrow();
    expect(git(original, "rev-parse", "HEAD")).toBe(before);
    expect(git(decoy, "rev-parse", "HEAD")).toBe(decoyBefore);
  });

  it("initializes Git without modifying an unrelated hardlinked file", async () => {
    const root = path.join(sandbox, "skills");
    const outside = path.join(sandbox, "outside");
    await mkdir(root);
    await writeFile(outside, "untouched\n");
    await link(outside, path.join(root, "linked"));
    const approved = await approveSkillsRoot(root);
    const result = await initializeSkillsRepo(approved, await previewInitialize(approved));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(path.join(root, "linked"), "utf8")).toBe("untouched\n");
    expect(await readFile(outside, "utf8")).toBe("untouched\n");
    expect(await readFile(path.join(root, ".git", "HEAD"), "utf8")).toMatch(/^ref: refs\/heads\//);
  });

  it("does not create state or require Git when no transaction needs recovery", async () => {
    const root = path.join(sandbox, "skills");
    await mkdir(root);
    const approved = await approveSkillsRoot(root);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = path.join(sandbox, "no-git");
      expect(await recoverSkillsGit(approved)).toBeUndefined();
      await expect(readFile(path.join(root, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });
});

describe("reviewed commits", () => {
  it("commits only exact reviewed active and disabled files while preserving unrelated staged and unstaged changes", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await skill(root, ".disabled_skills/beta");
    await writeFile(path.join(root, "outside.txt"), "base\n");
    await writeFile(path.join(root, "unstaged.txt"), "base\n");
    await initialCommit(root);
    await writeFile(path.join(root, "alpha", "SKILL.md"), "selected new\n");
    await writeFile(path.join(root, ".disabled_skills", "beta", "SKILL.md"), "disabled new\n");
    await writeFile(path.join(root, "outside.txt"), "already staged\n");
    git(root, "add", "outside.txt");
    await writeFile(path.join(root, "unstaged.txt"), "not staged\n");
    const beforeStaged = git(root, "diff", "--cached", "--", "outside.txt");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md", ".disabled_skills/beta/SKILL.md"]);
    expect(preview.binding).toMatchObject({
      root: await identity(root), repositoryRoot: root, repositoryIdentity: await identity(root), prefix: "",
    });
    await expect(readFile(path.join(root, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(preview.paths).toEqual([".disabled_skills/beta/SKILL.md", "alpha/SKILL.md"]);
    const result = await commitSelected(approved, preview, "reviewed skills");
    expect(result.exitCode).toBe(0);
    expect(git(root, "show", "--pretty=format:", "--name-only", "HEAD").split("\n").filter(Boolean).sort()).toEqual(preview.paths);
    expect(git(root, "diff", "--cached", "--", "outside.txt")).toBe(beforeStaged);
    expect(git(root, "diff", "--cached", "--", ...preview.paths)).toBe("");
    expect(git(root, "status", "--porcelain=v1", "--", ...preview.paths)).toBe("");
    expect(await readFile(path.join(root, "unstaged.txt"), "utf8")).toBe("not staged\n");
    expect(git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".skills-manager");
    await expect(previewCommit(approved, [".skills-manager/recovery"])).rejects.toThrow(/reserved/);
  });

  it("refuses a selected file that would replace an unrelated staged directory entry", async () => {
    const root = path.join(sandbox, "skills");
    const outside = path.join(sandbox, "outside");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    await mkdir(path.join(root, "alpha", "item"));
    await writeFile(path.join(root, "alpha", "item", "child"), "already staged\n");
    git(root, "add", "alpha/item/child");
    await rm(path.join(root, "alpha", "item"), { recursive: true });
    await writeFile(path.join(root, "alpha", "item"), "selected file\n");
    await writeFile(outside, "untouched\n");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/item"]);
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const headBefore = git(root, "rev-parse", "HEAD");
    await expect(commitSelected(approved, preview, "must not replace staged child")).rejects.toThrow();
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await readFile(path.join(root, "alpha", "item"), "utf8")).toBe("selected file\n");
    expect(await readFile(outside, "utf8")).toBe("untouched\n");
  });

  it("commits an explicitly reviewed directory-to-file transition", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await mkdir(path.join(root, "alpha", "item"));
    await writeFile(path.join(root, "alpha", "item", "child"), "old child\n");
    await initialCommit(root);
    await rm(path.join(root, "alpha", "item"), { recursive: true });
    await writeFile(path.join(root, "alpha", "item"), "replacement file\n");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/item", "alpha/item/child"]);
    expect((await commitSelected(approved, preview, "reviewed type transition")).exitCode).toBe(0);
    expect(git(root, "show", "HEAD:alpha/item")).toBe("replacement file");
    expect(git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("alpha/item/child");
  });

  it("revalidates an unselected blocking ancestor before committing a reviewed deletion", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await mkdir(path.join(root, "alpha", "item"));
    await writeFile(path.join(root, "alpha", "item", "child"), "old child\n");
    await initialCommit(root);
    await rm(path.join(root, "alpha", "item"), { recursive: true });
    await writeFile(path.join(root, "alpha", "item"), "unselected blocker\n");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/item/child"]);
    expect(preview.blockingPaths).toEqual(["alpha/item"]);
    const originalHead = git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "alpha", "item"), "changed blocker\n");
    await expect(commitSelected(approved, preview, "stale deletion")).rejects.toThrow(/preview changed/);
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    const current = await previewCommit(approved, ["alpha/item/child"]);
    expect((await commitSelected(approved, current, "reviewed deletion")).exitCode).toBe(0);
    expect(await readFile(path.join(root, "alpha", "item"), "utf8")).toBe("changed blocker\n");
    expect(git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("alpha/item/child");
  });

  it("handles literal pathspec characters, filenames with newlines, and an unborn branch", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    const odd = "alpha/:(glob)* [x],\nnotes.md";
    await writeFile(path.join(root, odd), "literal file\n");
    const status = await getStatus(root);
    expect(status.map((entry) => entry.path).sort()).toEqual([odd, "alpha/SKILL.md"].sort());
    expect((await getFileDiff(root, odd, true)).stdout).toContain("literal file");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, [odd, "alpha/SKILL.md"]);
    expect((await commitSelected(approved, preview, "first commit")).exitCode).toBe(0);
    expect(git(root, "show", `HEAD:${odd}`)).toBe("literal file");
  });

  it("records reviewed deletions and symlink targets without following the link", async () => {
    const root = path.join(sandbox, "skills");
    const outside = path.join(sandbox, "outside");
    await repository(root);
    await skill(root, "alpha");
    await writeFile(path.join(root, "alpha", "old"), "remove me\n");
    await writeFile(outside, "outside content\n");
    await initialCommit(root);
    await rm(path.join(root, "alpha", "old"));
    await symlink(outside, path.join(root, "alpha", "link"));
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/link", "alpha/old"]);
    expect((await commitSelected(approved, preview, "review deletion and link")).exitCode).toBe(0);
    expect(git(root, "show", "HEAD:alpha/link")).toBe(outside);
    expect(git(root, "ls-tree", "HEAD", "alpha/link")).toMatch(/^120000 blob /);
    expect(git(root, "ls-tree", "HEAD", "alpha/old")).toBe("");
    expect(await readFile(outside, "utf8")).toBe("outside content\n");
  });

  it("refuses stale worktree, index and HEAD previews without committing", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    await writeFile(path.join(root, "alpha/SKILL.md"), "review me\n");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    const originalHead = git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "alpha/SKILL.md"), "changed after preview\n");
    await expect(commitSelected(approved, preview, "must not commit")).rejects.toThrow(/preview changed/);
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    const second = await previewCommit(approved, ["alpha/SKILL.md"]);
    git(root, "add", "alpha/SKILL.md");
    await expect(commitSelected(approved, second, "must not commit")).rejects.toThrow(/preview changed/);
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    const third = await previewCommit(approved, ["alpha/SKILL.md"]);
    await rename(path.join(root, "alpha/SKILL.md"), path.join(sandbox, "old-skill"));
    await writeFile(path.join(root, "alpha/SKILL.md"), "changed after preview\n");
    await expect(commitSelected(approved, third, "must not commit")).rejects.toThrow(/preview changed/);
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
  });

  it.each(["repository", "skills"] as const)(
    "rejects reviewed commit and push when the parent %s directory identity is replaced",
    async (replaced) => {
      const { root, selected } = await parentRepository();
      const remote = path.join(sandbox, "backup.git");
      await mkdir(remote);
      git(remote, "init", "--bare");
      git(root, "remote", "add", "vault", remote);
      await writeFile(path.join(selected, "alpha", "SKILL.md"), "reviewed update\n");
      await writeFile(path.join(root, "staged.txt"), "staged parent change\n");
      git(root, "add", "staged.txt");
      const approved = await approveSkillsRoot(selected);
      const commit = await previewCommit(approved, ["alpha/SKILL.md"]);
      const push = await previewPush(approved);
      const head = git(root, "rev-parse", "HEAD");
      const index = await readFile(path.join(root, ".git", "index"));
      const gitEntry = await identity(path.join(root, ".git"), true);

      if (replaced === "repository") {
        const old = `${root}-old`;
        await rename(root, old);
        await mkdir(root);
        for (const name of [".git", "project", "neighbor", "staged.txt", "unstaged.txt"]) {
          await rename(path.join(old, name), path.join(root, name));
        }
        expect(await identity(selected)).toEqual(commit.binding.root);
        expect(await identity(root)).not.toEqual(commit.binding.repositoryIdentity);
      } else {
        const copy = `${selected}-copy`;
        await cp(selected, copy, { recursive: true });
        await rename(selected, `${selected}-old`);
        await rename(copy, selected);
        expect(await identity(root)).toEqual(commit.binding.repositoryIdentity);
        expect(await identity(selected)).not.toEqual(commit.binding.root);
      }
      expect(await identity(path.join(root, ".git"), true)).toEqual(gitEntry);

      await expect(commitSelected(approved, commit, "must not commit")).rejects.toThrow();
      await expect(pushApproved(approved, push)).rejects.toThrow();
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
      expect(git(remote, "branch", "--list")).toBe("");
      expect(await readFile(path.join(selected, "alpha", "SKILL.md"), "utf8")).toBe("reviewed update\n");
      expect(await readFile(path.join(root, "staged.txt"), "utf8")).toBe("staged parent change\n");
    },
  );

  it("does not execute repository hooks or configured clean filters", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    const sentinel = path.join(sandbox, "executed");
    git(root, "config", "filter.evil.clean", `touch '${sentinel}'; cat`);
    await writeFile(path.join(root, ".gitattributes"), "alpha/** filter=evil\n");
    await writeFile(path.join(root, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    await writeFile(path.join(root, "alpha", "SKILL.md"), "safe\n");
    const approved = await approveSkillsRoot(root);
    const preview = await previewCommit(approved, ["alpha/SKILL.md"]);
    expect((await commitSelected(approved, preview, "safe commit")).exitCode).toBe(0);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("manual synchronization", () => {
  it("warns that a parent push publishes whole-branch history and pushes only after approval", async () => {
    const { root, selected } = await parentRepository();
    const remote = path.join(sandbox, "backup.git");
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "vault", remote);
    await writeFile(path.join(selected, "alpha", "SKILL.md"), "reviewed update\n");
    const approved = await approveSkillsRoot(selected);
    const commit = await previewCommit(approved, ["alpha/SKILL.md"]);
    expect((await commitSelected(approved, commit, "selected update")).exitCode).toBe(0);
    await writeFile(path.join(root, "staged.txt"), "staged parent change\n");
    git(root, "add", "staged.txt");
    await writeFile(path.join(root, "unstaged.txt"), "unstaged parent change\n");
    const staged = git(root, "ls-files", "--stage", "--", "staged.txt");
    const config = await readFile(path.join(root, ".git", "config"));
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"));

    const preview = await previewPush(approved);
    expect(preview).toMatchObject({
      root: selected, remote: "vault", branch: "trunk", destination: "refs/heads/trunk",
      binding: { repositoryRoot: root, repositoryIdentity: await identity(root), prefix: "project/skills" },
      localRemote: { path: remote },
    });
    expect(preview.warning).toMatch(/whole|all|entire|reachable/i);
    expect(preview.warning).toMatch(/outside|unrelated|other/i);
    expect(preview.outgoing.map((item) => item.subject)).toEqual(["initial skill", "selected update"]);
    expect(preview.outgoing[0].paths).toContain("staged.txt");
    expect(preview.outgoing[0].paths).toContain("neighbor/outside/SKILL.md");
    expect(preview.outgoing[1].paths).toEqual(["project/skills/alpha/SKILL.md"]);
    expect(git(remote, "branch", "--list")).toBe("");

    const result = await pushApproved(approved, preview);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(git(remote, "rev-parse", "refs/heads/trunk")).toBe(preview.head);
    expect(git(remote, "show", "refs/heads/trunk:staged.txt")).toBe("staged base");
    expect(git(remote, "show", "refs/heads/trunk:project/skills/alpha/SKILL.md")).toBe("reviewed update");
    expect(git(root, "ls-files", "--stage", "--", "staged.txt")).toBe(staged);
    expect(await readFile(path.join(root, "staged.txt"), "utf8")).toBe("staged parent change\n");
    expect(await readFile(path.join(root, "unstaged.txt"), "utf8")).toBe("unstaged parent change\n");
    await expectParentConfigurationUnchanged(root, selected, config, exclude);
  });

  it("resolves a relative local remote from the containing repository for explicit push and fetch", async () => {
    const { root, selected } = await parentRepository();
    const remote = path.join(sandbox, "backup.git");
    const peer = path.join(sandbox, "peer");
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "vault", "../backup.git");
    const config = await readFile(path.join(root, ".git", "config"));
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"));
    const approved = await approveSkillsRoot(selected);
    const push = await previewPush(approved);
    expect(push.localRemote?.path).toBe(remote);
    expect(git(remote, "branch", "--list")).toBe("");
    const pushed = await pushApproved(approved, push);
    expect(pushed.exitCode, pushed.stderr).toBe(0);
    expect(git(remote, "rev-parse", "refs/heads/trunk")).toBe(push.head);

    git(sandbox, "clone", "--no-hardlinks", "--branch", "trunk", remote, peer);
    git(peer, "config", "user.name", "Peer");
    git(peer, "config", "user.email", "peer@example.invalid");
    await writeFile(path.join(peer, "project", "skills", "alpha", "SKILL.md"), "fetched change\n");
    git(peer, "add", "project/skills/alpha/SKILL.md");
    git(peer, "commit", "-m", "fetched selected change");
    git(peer, "push", "origin", "trunk");
    const remoteHead = git(peer, "rev-parse", "HEAD");
    const fetch = await previewFetch(approved, "vault", "trunk");
    const fetched = await fetchApproved(approved, fetch);
    expect(fetched.exitCode, fetched.stderr).toBe(0);
    expect(git(root, "rev-parse", "refs/remotes/vault/trunk")).toBe(remoteHead);
    expect(git(root, "rev-parse", "HEAD")).toBe(push.head);
    expect(await readFile(path.join(selected, "alpha", "SKILL.md"), "utf8")).toContain("initial");
    await expectParentConfigurationUnchanged(root, selected, config, exclude);
  });

  it("refuses SSH helpers from the containing worktree and their PATH aliases before network access", async () => {
    const { root, selected } = await parentRepository();
    git(root, "remote", "add", "vault", "ssh://127.0.0.1:1/repo.git");
    const approved = await approveSkillsRoot(selected);
    const preview = await previewPush(approved);
    const bin = path.join(root, "bin");
    const alias = path.join(sandbox, "ssh-alias");
    const trusted = path.join(sandbox, "trusted-git");
    const marker = path.join(selected, "fake-ssh-ran");
    await mkdir(bin);
    await mkdir(alias);
    await mkdir(trusted);
    await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`, { mode: 0o755 });
    await symlink(path.join(bin, "ssh"), path.join(alias, "ssh"));
    const oldPath = process.env.PATH;
    let executable: string | undefined;
    for (const directory of (oldPath ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      try {
        const candidate = await realpath(path.join(directory, "git"));
        const info = await stat(candidate);
        if (info.isFile() && (info.mode & 0o111)) { executable = candidate; break; }
      } catch {
        // Try the next original PATH entry.
      }
    }
    if (!executable) throw new Error("The fixture requires an executable Git outside its repository");
    await symlink(executable, path.join(trusted, "git"));
    try {
      process.env.PATH = [bin, alias, trusted].join(path.delimiter);
      await expect(pushApproved(approved, preview)).rejects.toThrow(/SSH client/i);
      await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });

  it("fast-forwards selected skills in a parent repository without changing unrelated worktree or index entries", async () => {
    const { root, selected } = await parentRepository();
    const peer = parentPeer(root);
    await writeFile(path.join(peer, "project", "skills", "alpha", "SKILL.md"), "incoming skill\n");
    git(peer, "add", "project/skills/alpha/SKILL.md");
    git(peer, "commit", "-m", "incoming selected skill");
    git(root, "fetch", "--no-tags", peer, "HEAD:refs/remotes/vault/trunk");
    await writeFile(path.join(root, "staged.txt"), "staged parent change\n");
    git(root, "add", "staged.txt");
    await writeFile(path.join(root, "unstaged.txt"), "unstaged parent change\n");
    const staged = git(root, "ls-files", "--stage", "--", "staged.txt");
    const config = await readFile(path.join(root, ".git", "config"));
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"));
    const approved = await approveSkillsRoot(selected);
    const preview = await previewPull(approved, ["alpha"]);
    expect(preview).toMatchObject({
      root: selected, paths: ["alpha/SKILL.md"], approvedPaths: ["alpha"],
      binding: { repositoryRoot: root, repositoryIdentity: await identity(root), prefix: "project/skills" },
    });
    expect(preview.commits.map((item) => item.subject)).toEqual(["incoming selected skill"]);
    expect(preview.commits[0].paths).toEqual(["alpha/SKILL.md"]);

    const result = await pullApproved(approved, preview);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(preview.target);
    expect(git(root, "show", ":project/skills/alpha/SKILL.md")).toBe("incoming skill");
    expect(await readFile(path.join(selected, "alpha", "SKILL.md"), "utf8")).toBe("incoming skill\n");
    expect(git(root, "ls-files", "--stage", "--", "staged.txt")).toBe(staged);
    expect(git(root, "show", ":staged.txt")).toBe("staged parent change");
    expect(await readFile(path.join(root, "unstaged.txt"), "utf8")).toBe("unstaged parent change\n");
    await expectParentConfigurationUnchanged(root, selected, config, exclude);
  });

  it("rejects a reviewed parent pull after the containing repository identity changes", async () => {
    const { root, selected } = await parentRepository();
    const peer = parentPeer(root);
    await writeFile(path.join(peer, "project", "skills", "alpha", "SKILL.md"), "incoming skill\n");
    git(peer, "add", "project/skills/alpha/SKILL.md");
    git(peer, "commit", "-m", "incoming selected skill");
    git(root, "fetch", "--no-tags", peer, "HEAD:refs/remotes/vault/trunk");
    const approved = await approveSkillsRoot(selected);
    const preview = await previewPull(approved, ["alpha"]);
    const head = git(root, "rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));
    const old = `${root}-old`;
    await rename(root, old);
    await mkdir(root);
    for (const name of [".git", "project", "neighbor", "staged.txt", "unstaged.txt"]) {
      await rename(path.join(old, name), path.join(root, name));
    }
    expect(await identity(selected)).toEqual(preview.binding.root);
    expect(await identity(root)).not.toEqual(preview.binding.repositoryIdentity);
    await expect(pullApproved(approved, preview)).rejects.toThrow();
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(selected, "alpha", "SKILL.md"), "utf8")).toContain("initial");
    expect(await readFile(path.join(root, "unstaged.txt"), "utf8")).toBe("unstaged base\n");
  });

  it("rejects parent pull history touching an outside path even when a later commit reverts it", async () => {
    const { root, selected } = await parentRepository();
    const peer = parentPeer(root);
    await writeFile(path.join(peer, "project", "skills", "alpha", "SKILL.md"), "incoming skill\n");
    await writeFile(path.join(peer, "unstaged.txt"), "incoming outside change\n");
    git(peer, "add", "project/skills/alpha/SKILL.md", "unstaged.txt");
    git(peer, "commit", "-m", "mixed incoming changes");
    await writeFile(path.join(peer, "unstaged.txt"), "unstaged base\n");
    git(peer, "add", "unstaged.txt");
    git(peer, "commit", "-m", "revert outside change");
    git(root, "fetch", "--no-tags", peer, "HEAD:refs/remotes/vault/trunk");
    const head = git(root, "rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));
    const config = await readFile(path.join(root, ".git", "config"));
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"));
    const approved = await approveSkillsRoot(selected);

    await expect(previewPull(approved, ["alpha"])).rejects.toThrow(/outside|unrelated|unapproved|selected/i);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(selected, "alpha", "SKILL.md"), "utf8")).toContain("initial");
    expect(await readFile(path.join(root, "unstaged.txt"), "utf8")).toBe("unstaged base\n");
    await expectParentConfigurationUnchanged(root, selected, config, exclude);
  });

  it.each(["similar-prefix sibling", "selected-root replacement"] as const)(
    "refuses incoming %s without changing the selected directory",
    async (kind) => {
      const { root, selected } = await parentRepository();
      const peer = parentPeer(root);
      if (kind === "similar-prefix sibling") {
        await mkdir(path.join(peer, "project", "skills-backup"));
        await writeFile(path.join(peer, "project", "skills-backup", "private.txt"), "outside selected skills\n");
        git(peer, "add", "project/skills-backup/private.txt");
      } else {
        git(peer, "rm", "-r", "project/skills");
        await rm(path.join(peer, "project", "skills"), { recursive: true, force: true });
        await mkdir(path.join(peer, "project"), { recursive: true });
        await writeFile(path.join(peer, "project", "skills"), "not a skills directory\n");
        git(peer, "add", "project/skills");
      }
      git(peer, "commit", "-m", "outside selected scope");
      git(root, "fetch", "--no-tags", peer, "HEAD:refs/remotes/vault/trunk");
      const head = git(root, "rev-parse", "HEAD");
      const index = await readFile(path.join(root, ".git", "index"));
      await expect(previewPull(await approveSkillsRoot(selected), ["alpha"]))
        .rejects.toThrow(/outside|unrelated|unapproved|selected|scope|invalid/i);
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
      expect((await lstat(selected)).isDirectory()).toBe(true);
      expect(await readFile(path.join(selected, "alpha", "SKILL.md"), "utf8")).toContain("initial");
    },
  );

  it("refuses an incoming outside gitlink change despite ignore-submodules configuration", async () => {
    const { root, selected } = await parentRepository();
    const first = git(root, "rev-parse", "HEAD");
    git(root, "update-index", "--add", "--cacheinfo", `160000,${first},vendor/dependency`);
    git(root, "commit", "-m", "track outside gitlink");
    git(root, "config", "diff.ignoreSubmodules", "all");
    const peer = parentPeer(root);
    const second = git(peer, "rev-parse", "HEAD");
    git(peer, "update-index", "--cacheinfo", `160000,${second},vendor/dependency`);
    git(peer, "commit", "-m", "change outside gitlink");
    git(root, "fetch", "--no-tags", peer, "HEAD:refs/remotes/vault/trunk");
    const head = git(root, "rev-parse", "HEAD");
    const index = await readFile(path.join(root, ".git", "index"));
    await expect(previewPull(await approveSkillsRoot(selected)))
      .rejects.toThrow(/outside|unrelated|unapproved|selected|scope/i);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(git(root, "rev-parse", ":vendor/dependency")).toBe(first);
    expect(await readFile(path.join(selected, "alpha", "SKILL.md"), "utf8")).toContain("initial");
  });

  it("pushes only reviewed history to a renamed local remote and refuses stale destinations", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(root, "trunk");
    await mkdir(remote);
    git(remote, "init", "--bare");
    await skill(root, "alpha");
    await initialCommit(root);
    const approved = await approveSkillsRoot(root);
    expect((await addRemoteApproved(approved, await previewAddRemote(approved, "vault", remote), remote)).exitCode).toBe(0);
    await expect(previewAddRemote(approved, "other", remote)).rejects.toThrow(/existing remotes|no remote/);
    const preview = await previewPush(approved, []);
    expect(preview).toMatchObject({ remote: "vault", branch: "trunk", upstream: null, destination: "refs/heads/trunk" });
    expect(preview.outgoing).toHaveLength(1);
    expect(preview.outgoing[0].paths).toEqual(["alpha/SKILL.md"]);
    expect(preview.warning).toMatch(/provider|privacy/i);
    // Cancellation means no approved call and the bare remote remains empty.
    expect(git(remote, "branch", "--list")).toBe("");
    expect((await pushApproved(approved, preview)).exitCode).toBe(0);
    expect(git(remote, "rev-parse", "refs/heads/trunk")).toBe(preview.head);
    const old = await previewPush(approved, []);
    const other = path.join(sandbox, "other.git");
    await mkdir(other);
    git(other, "init", "--bare");
    git(root, "remote", "set-url", "--push", "vault", other);
    await expect(pushApproved(approved, old)).rejects.toThrow(/preview changed/);
  });

  it("freezes the reviewed canonical destination of a symlinked local remote", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    const alias = path.join(sandbox, "remote-link");
    await repository(root);
    await mkdir(remote);
    git(remote, "init", "--bare");
    await symlink(remote, alias, "dir");
    await skill(root, "alpha");
    await initialCommit(root);
    git(root, "remote", "add", "vault", alias);
    const approved = await approveSkillsRoot(root);
    const preview = await previewPush(approved);
    expect(preview.pushUrl).toBe(alias);
    expect(preview.localRemote?.path).toBe(remote);
    expect((await pushApproved(approved, preview)).exitCode).toBe(0);
    expect(git(remote, "rev-parse", "refs/heads/trunk")).toBe(preview.head);
  });

  it("does not let pushInsteadOf redirect a reviewed destination", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "reviewed.git");
    const other = path.join(sandbox, "redirect.git");
    await repository(root);
    await mkdir(remote);
    await mkdir(other);
    git(remote, "init", "--bare");
    git(other, "init", "--bare");
    await skill(root, "alpha");
    await initialCommit(root);
    git(root, "remote", "add", "vault", remote);
    git(root, "config", `url.file://${other}/.pushInsteadOf`, "skills-manager-");
    const approved = await approveSkillsRoot(root);
    const preview = await previewPush(approved);
    expect((await pushApproved(approved, preview)).exitCode).toBe(0);
    expect(git(remote, "rev-parse", "refs/heads/trunk")).toBe(preview.head);
    expect(git(other, "branch", "--list")).toBe("");
  });

  it("blocks unrelated outgoing files, including files subsequently reverted", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(root);
    await mkdir(remote);
    git(remote, "init", "--bare");
    await skill(root, "alpha");
    await writeFile(path.join(root, "unrelated.txt"), "not a skill\n");
    await initialCommit(root);
    git(root, "rm", "unrelated.txt");
    git(root, "commit", "-m", "remove unrelated");
    git(root, "remote", "add", "vault", remote);
    await expect(previewPush(await approveSkillsRoot(root), [])).rejects.toThrow(/unrelated/);
  });

  it("does not execute configured signature verifiers in push or pull previews", async () => {
    const root = path.join(sandbox, "skills");
    const peer = path.join(sandbox, "peer");
    const remote = path.join(sandbox, "backup.git");
    const marker = path.join(sandbox, "verifier-ran");
    const verifier = path.join(sandbox, "verifier");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    addFakeSignature(root);
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "vault", remote);
    git(root, "config", "branch.trunk.remote", "vault");
    git(root, "config", "branch.trunk.merge", "refs/heads/trunk");
    git(sandbox, "clone", "--branch", "trunk", root, peer);
    git(peer, "config", "user.name", "Peer");
    git(peer, "config", "user.email", "peer@example.invalid");
    await writeFile(path.join(peer, "alpha/SKILL.md"), "incoming\n");
    git(peer, "add", "alpha/SKILL.md");
    git(peer, "commit", "-m", "signed incoming");
    addFakeSignature(peer);
    git(root, "fetch", peer, "HEAD:refs/remotes/vault/trunk");
    await writeFile(verifier, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(root, "config", "gpg.program", verifier);
    git(root, "config", "log.showSignature", "true");
    git(root, "config", "merge.verifySignatures", "true");
    const approved = await approveSkillsRoot(root);
    expect((await previewPush(approved)).outgoing.map((item) => item.subject)).toEqual(["initial skill"]);
    expect((await previewPull(approved)).commits.map((item) => item.subject)).toEqual(["signed incoming"]);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates original outgoing history rather than replacement refs", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    const safeTree = git(root, "rev-parse", "HEAD^{tree}");
    await writeFile(path.join(root, "unrelated.txt"), "private history\n");
    git(root, "add", "unrelated.txt");
    git(root, "commit", "-m", "private history");
    const replacement = git(root, "commit-tree", safeTree, "-m", "safe replacement");
    git(root, "replace", "HEAD", replacement);
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "vault", remote);
    await expect(previewPush(await approveSkillsRoot(root))).rejects.toThrow(/unrelated/);
    expect(git(remote, "branch", "--list")).toBe("");
  });

  it.each(["graft", "shallow"] as const)("refuses %s history that can hide outgoing ancestors", async (kind) => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(root);
    await skill(root, "alpha");
    await writeFile(path.join(root, "private.txt"), "private history\n");
    await initialCommit(root);
    git(root, "rm", "private.txt");
    git(root, "commit", "-m", "remove private file");
    const head = git(root, "rev-parse", "HEAD");
    const metadata = kind === "graft" ? path.join(root, ".git", "info", "grafts") : path.join(root, ".git", "shallow");
    await writeFile(metadata, `${head}\n`);
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "vault", remote);
    await expect(previewPush(await approveSkillsRoot(root))).rejects.toThrow();
    expect(git(remote, "branch", "--list")).toBe("");
  });

  it("does not fetch missing promisor objects while preparing a push preview", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    const missingTree = git(root, "rev-parse", "HEAD^{tree}");
    await writeFile(path.join(root, "alpha/SKILL.md"), "second version\n");
    git(root, "add", "alpha/SKILL.md");
    git(root, "commit", "-m", "second version");
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "vault", remote);
    git(root, "push", "vault", "trunk");
    const marker = await watchPromisorFetch(root);
    git(root, "config", "remote.vault.promisor", "true");
    git(root, "config", "remote.vault.partialclonefilter", "blob:none");
    await rm(path.join(root, ".git", "objects", missingTree.slice(0, 2), missingTree.slice(2)));
    expect(() => git(root, "--no-lazy-fetch", "cat-file", "-e", missingTree)).toThrow();
    await expect(previewPush(await approveSkillsRoot(root))).rejects.toThrow();
    expect(() => git(root, "--no-lazy-fetch", "cat-file", "-e", missingTree)).toThrow();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not fetch a missing promisor blob while reading a file diff", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    const missingBlob = git(root, "rev-parse", "HEAD:alpha/SKILL.md");
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "vault", remote);
    git(root, "push", "vault", "trunk");
    const marker = await watchPromisorFetch(root);
    git(root, "config", "remote.vault.promisor", "true");
    git(root, "config", "remote.vault.partialclonefilter", "blob:none");
    await rm(path.join(root, ".git", "objects", missingBlob.slice(0, 2), missingBlob.slice(2)));
    await writeFile(path.join(root, "alpha/SKILL.md"), "local change\n");
    await expect(getFileDiff(root, "alpha/SKILL.md", false)).rejects.toThrow();
    expect(() => git(root, "--no-lazy-fetch", "cat-file", "-e", missingBlob)).toThrow();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fetches only after confirmation, then fast-forwards approved incoming files", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    const peer = path.join(sandbox, "peer");
    await repository(root, "trunk");
    await mkdir(remote);
    git(remote, "init", "--bare");
    await skill(root, "alpha");
    await initialCommit(root);
    git(root, "remote", "add", "vault", remote);
    const approved = await approveSkillsRoot(root);
    expect((await pushApproved(approved, await previewPush(approved, []))).exitCode).toBe(0);
    git(root, "config", "branch.trunk.remote", "vault");
    git(root, "config", "branch.trunk.merge", "refs/heads/trunk");
    git(sandbox, "clone", "--no-hardlinks", "--branch", "trunk", remote, peer);
    git(peer, "config", "user.name", "Peer");
    git(peer, "config", "user.email", "peer@example.invalid");
    await writeFile(path.join(peer, "alpha/SKILL.md"), "incoming\n");
    git(peer, "add", "alpha/SKILL.md");
    git(peer, "commit", "-m", "incoming skill");
    git(peer, "push", "origin", "trunk");
    const fetch = await previewFetch(approved);
    expect(fetch).toMatchObject({ remote: "vault", branch: "trunk", fetchUrl: remote });
    expect((await fetchApproved(approved, fetch)).exitCode).toBe(0);
    const pull = await previewPull(approved, ["alpha"]);
    expect(pull.paths).toEqual(["alpha/SKILL.md"]);
    expect(pull.commits.map((item) => item.subject)).toEqual(["incoming skill"]);
    await writeFile(path.join(root, "alpha/SKILL.md"), "local edit\n");
    await expect(pullApproved(approved, pull)).rejects.toThrow(/overwrite local changes/);
    await writeFile(path.join(root, "alpha/SKILL.md"), "---\nname: alpha\n---\ninitial\n");
    const reviewedPull = await previewPull(approved, ["alpha"]);
    expect((await pullApproved(approved, reviewedPull)).exitCode).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(reviewedPull.target);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toBe("incoming\n");
  });

  it("can fetch into an unborn repository and explicitly from detached HEAD", async () => {
    const source = path.join(sandbox, "source");
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(source, "trunk");
    await skill(source, "alpha");
    await initialCommit(source);
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(source, "push", remote, "trunk");
    await repository(root, "trunk");
    git(root, "remote", "add", "vault", remote);
    const approved = await approveSkillsRoot(root);
    const unborn = await previewFetch(approved, "vault");
    expect(unborn).toMatchObject({ remote: "vault", branch: "trunk" });
    expect((await fetchApproved(approved, unborn)).exitCode).toBe(0);
    expect(git(root, "rev-parse", "refs/remotes/vault/trunk")).toBe(git(source, "rev-parse", "HEAD"));
    git(root, "commit", "--allow-empty", "-m", "local seed");
    git(root, "checkout", "--detach");
    await expect(previewFetch(approved, "vault")).rejects.toThrow(/branch explicitly/i);
    const detached = await previewFetch(approved, "vault", "trunk");
    expect((await fetchApproved(approved, detached)).exitCode).toBe(0);
    expect(git(root, "rev-parse", "refs/remotes/vault/trunk")).toBe(git(source, "rev-parse", "HEAD"));
  });

  it("refuses a non-fast-forward push without altering either branch", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    const peer = path.join(sandbox, "peer");
    await repository(root, "trunk");
    await mkdir(remote);
    git(remote, "init", "--bare");
    await skill(root, "alpha");
    await initialCommit(root);
    git(root, "remote", "add", "vault", remote);
    const approved = await approveSkillsRoot(root);
    expect((await pushApproved(approved, await previewPush(approved))).exitCode).toBe(0);
    git(sandbox, "clone", "--no-hardlinks", "--branch", "trunk", remote, peer);
    git(peer, "config", "user.name", "Peer");
    git(peer, "config", "user.email", "peer@example.invalid");
    await writeFile(path.join(peer, "alpha/SKILL.md"), "peer change\n");
    git(peer, "add", "alpha/SKILL.md");
    git(peer, "commit", "-m", "peer change");
    git(peer, "push", "origin", "trunk");
    const remoteHead = git(remote, "rev-parse", "refs/heads/trunk");
    await writeFile(path.join(root, "alpha/SKILL.md"), "local change\n");
    git(root, "add", "alpha/SKILL.md");
    git(root, "commit", "-m", "local change");
    const localHead = git(root, "rev-parse", "HEAD");
    const result = await pushApproved(approved, await previewPush(approved));
    expect(result.exitCode).not.toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(remote, "rev-parse", "refs/heads/trunk")).toBe(remoteHead);
  });

  it("does not run local bare-remote hooks or change outside sentinels", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    const sentinel = path.join(sandbox, "outside");
    await repository(root, "trunk");
    await mkdir(remote);
    git(remote, "init", "--bare");
    await writeFile(path.join(remote, "hooks", "pre-receive"), `#!/bin/sh\nprintf compromised > '${sentinel}'\n`, { mode: 0o755 });
    await writeFile(sentinel, "untouched");
    await skill(root, "alpha");
    await initialCommit(root);
    git(root, "remote", "add", "vault", remote);
    const approved = await approveSkillsRoot(root);
    const preview = await previewPush(approved);
    expect((await pushApproved(approved, preview)).exitCode).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(preview.head);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    expect(git(remote, "rev-parse", "refs/heads/trunk")).toBe(preview.head);
  });

  it("rejects a local bare destination replaced after review", async () => {
    const root = path.join(sandbox, "skills");
    const remote = path.join(sandbox, "backup.git");
    await repository(root);
    await mkdir(remote);
    git(remote, "init", "--bare");
    await skill(root, "alpha");
    await initialCommit(root);
    git(root, "remote", "add", "vault", remote);
    const approved = await approveSkillsRoot(root);
    const preview = await previewPush(approved);
    await rename(remote, `${remote}.old`);
    await mkdir(remote);
    git(remote, "init", "--bare");
    await expect(pushApproved(approved, preview)).rejects.toThrow(/preview changed/);
    expect(git(remote, "branch", "--list")).toBe("");
    expect(git(`${remote}.old`, "branch", "--list")).toBe("");
  });

  it("rejects custom transport helpers rather than executing them", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    const approved = await approveSkillsRoot(root);
    await expect(previewAddRemote(approved, "custom", "evil::anything")).rejects.toThrow(/unsupported/i);
    await expect(previewAddRemote(approved, "custom", "evil://example.invalid/repo")).rejects.toThrow(/unsupported/i);
  });

  it("refuses configured git protocol proxy commands before network access", async () => {
    const root = path.join(sandbox, "skills");
    const sentinel = path.join(sandbox, "proxy-executed");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    git(root, "config", "core.gitProxy", `touch '${sentinel}'`);
    git(root, "remote", "add", "vault", "git://127.0.0.1/example.git");
    await expect(previewPush(await approveSkillsRoot(root))).rejects.toThrow(/proxy commands/i);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not execute an SSH helper symlinked into the selected repository", async () => {
    const root = path.join(sandbox, "skills");
    const bin = path.join(sandbox, "path-bin");
    const sentinel = path.join(sandbox, "ssh-executed");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    await mkdir(bin);
    await writeFile(path.join(root, "ssh"), `#!/bin/sh\ntouch '${sentinel}'\nexit 0\n`, { mode: 0o755 });
    await symlink(path.join(root, "ssh"), path.join(bin, "ssh"));
    git(root, "remote", "add", "vault", "ssh://127.0.0.1:1/repo.git");
    const approved = await approveSkillsRoot(root);
    const preview = await previewPush(approved);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      try {
        const result = await pushApproved(approved, preview);
        expect(result.exitCode).not.toBe(0);
      } catch (error) {
        expect(String(error)).toMatch(/Cannot find an executable SSH client/);
      }
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });

  it("reports a real HTTP authentication rejection without leaking credentials", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    const server = createServer((_request, response) => {
      response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' });
      response.end("Authentication required");
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback TCP listener");
      const url = `http://fixture-user:fixture-secret@127.0.0.1:${address.port}/repo.git`;
      git(root, "remote", "add", "vault", url);
      const approved = await approveSkillsRoot(root);
      const preview = await previewPush(approved);
      const result = await pushApproved(approved, preview);
      expect(result.exitCode).not.toBe(0);
      expect(JSON.stringify({ preview, result })).not.toMatch(/fixture-user|fixture-secret/);
      expect(git(root, "rev-parse", "HEAD")).toBe(preview.head);
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
  });

  it("redacts credentials from previews and failed remote operations", async () => {
    const root = path.join(sandbox, "skills");
    await repository(root);
    await skill(root, "alpha");
    await initialCommit(root);
    const url = "https://example-user:example-secret@127.0.0.1:1/repo.git?token=example-token";
    git(root, "remote", "add", "vault", url);
    const approved = await approveSkillsRoot(root);
    const preview = await previewPush(approved, []);
    expect(preview.pushUrl).not.toMatch(/example-user|example-secret|example-token/);
    expect(redactGitUrl("ssh://user:password@example.invalid/repo")).not.toMatch(/user|password/);
    const result = await pushApproved(approved, preview);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/example-user|example-secret|example-token/);
    expect(await readFile(path.join(root, "alpha/SKILL.md"), "utf8")).toContain("initial");
  });
});
