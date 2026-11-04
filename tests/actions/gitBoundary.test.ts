import { execFileSync, spawnSync, type StdioOptions } from "node:child_process";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveSkillsRoot } from "../../src/actions/boundary.js";
import { runConfinedGit, type ConfinedGitResult, type DirectoryIdentity } from "../../src/actions/gitBoundary.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const nativeHelper = path.join(project, "native", "skills-git-boundary");
const nativeMetadata = `${nativeHelper}.platform.json`;
const permissionDenied = /permission denied|operation not permitted|access denied/i;

// The module URL is chosen at runtime to exercise both the installed and isolated layouts.
const wrapperLaunch = `
  const { runConfinedGit } = await import(process.argv[1]);
  const [root, dev, ino, identity, target] = process.argv.slice(2);
  const result = await runConfinedGit(root, ["config", "--file", target, "inside.key", "control"], {
    env: process.env, expectedRoot: { dev, ino, identity },
  });
  if (result.exitCode !== 0) {
    console.error(result.stderr);
    process.exitCode = 1;
  }
`;

type ReviewedRoot = DirectoryIdentity & { identity: string };

let sandbox: string;
let root: string;
let outside: string;
let env: NodeJS.ProcessEnv;

async function identity(directory: string): Promise<DirectoryIdentity> {
  const entry = await stat(directory, { bigint: true });
  return { dev: entry.dev.toString(), ino: entry.ino.toString() };
}

async function rootIdentity(directory: string): Promise<ReviewedRoot> {
  return { ...await identity(directory), identity: (await approveSkillsRoot(directory)).identity };
}

async function entryIdentity(entryPath: string): Promise<DirectoryIdentity> {
  const entry = await lstat(entryPath, { bigint: true });
  return { dev: entry.dev.toString(), ino: entry.ino.toString() };
}

async function expectRefused(attempt: Promise<ConfinedGitResult>, reason: RegExp): Promise<void> {
  const outcome = await attempt.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  if ("error" in outcome) {
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toMatch(reason);
  } else {
    expect(outcome.result.exitCode, outcome.result.stderr).not.toBe(0);
    expect(outcome.result.stderr).toMatch(reason);
  }
}

async function expectMissing(file: string): Promise<void> {
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

function fixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

async function reviewedBareRemote() {
  fixtureGit(root, "init", "-b", "main");
  await writeFile(path.join(root, "tracked"), "initial\n");
  fixtureGit(root, "add", "tracked");
  fixtureGit(root, "-c", "user.name=Boundary Test", "-c", "user.email=boundary@example.invalid", "commit", "--no-gpg-sign", "-m", "initial");
  const gitDir = await realpath(path.join(root, ".git"));
  const remoteDir = path.join(sandbox, "remote.git");
  fixtureGit(sandbox, "init", "--bare", remoteDir);
  return {
    env,
    expectedRoot: await rootIdentity(root),
    gitDir,
    expectedGitDir: await identity(gitDir),
    expectedGitEntry: await entryIdentity(path.join(root, ".git")),
    commonDir: gitDir,
    expectedCommonDir: await identity(gitDir),
    remoteDir,
    expectedRemoteDir: await identity(remoteDir),
  };
}

function wrapperArguments(moduleUrl: string, rootPath: string, expectedRoot: ReviewedRoot, file: string): string[] {
  return ["--import", "tsx", "--input-type=module", "-e", wrapperLaunch, moduleUrl, rootPath, expectedRoot.dev, expectedRoot.ino, expectedRoot.identity, file];
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "skills-git-boundary-")));
  root = path.join(sandbox, "root");
  outside = path.join(sandbox, "outside");
  await mkdir(root);
  await mkdir(outside);
  env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("confined Git process", () => {
  it("allows writes in the selected root but denies creating or changing files outside it", async () => {
    const expectedRoot = await rootIdentity(root);
    const insideFile = path.join(root, "inside.config");
    const existing = path.join(outside, "existing.config");
    const missing = path.join(outside, "new.config");
    const original = "[inside]\n\tkey = original\n";
    await writeFile(existing, original);

    const allowed = await runConfinedGit(root, ["config", "--file", insideFile, "inside.key", "allowed"], { env, expectedRoot });
    expect(allowed.exitCode, `Confinement unavailable or approved write failed: ${allowed.stderr}`).toBe(0);
    expect(await readFile(insideFile, "utf8")).toContain("key = allowed");

    for (const file of [existing, missing]) {
      await expectRefused(runConfinedGit(root, ["config", "--file", file, "inside.key", "changed"], { env, expectedRoot }), permissionDenied);
      await expectMissing(`${file}.lock`);
    }
    const outsideLink = path.join(root, "outside-link");
    await symlink(outside, outsideLink, "dir");
    await expectRefused(
      runConfinedGit(root, ["config", "--file", path.join(outsideLink, "existing.config"), "inside.key", "changed"], { env, expectedRoot }),
      permissionDenied,
    );
    expect(await readFile(existing, "utf8")).toBe(original);
    await expectMissing(missing);
  });

  it("refuses a replacement root after its identity was reviewed", async () => {
    const expectedRoot = await rootIdentity(root);
    const control = await runConfinedGit(root, ["config", "--file", path.join(root, "control.config"), "inside.key", "control"], { env, expectedRoot });
    expect(control.exitCode, `Confinement unavailable or approved write failed: ${control.stderr}`).toBe(0);

    const originalRoot = path.join(sandbox, "reviewed-root");
    await rename(root, originalRoot);
    await mkdir(root);
    const replacementFile = path.join(root, "replacement.config");
    const original = "[inside]\n\tkey = untouched\n";
    await writeFile(replacementFile, original);
    expect(await identity(root)).not.toEqual({ dev: expectedRoot.dev, ino: expectedRoot.ino });
    const beforeRoot = await stat(root, { bigint: true });
    const beforeFile = await stat(replacementFile, { bigint: true });

    await expectRefused(
      runConfinedGit(root, ["config", "--file", replacementFile, "inside.key", "changed"], { env, expectedRoot }),
      /root identity mismatch/i,
    );
    expect(await readFile(replacementFile, "utf8")).toBe(original);
    expect(await readdir(root)).toEqual(["replacement.config"]);
    const afterRoot = await stat(root, { bigint: true });
    const afterFile = await stat(replacementFile, { bigint: true });
    expect([afterRoot.mtimeNs, afterRoot.ctimeNs]).toEqual([beforeRoot.mtimeNs, beforeRoot.ctimeNs]);
    expect([afterFile.mtimeNs, afterFile.ctimeNs, afterFile.mode]).toEqual([beforeFile.mtimeNs, beforeFile.ctimeNs, beforeFile.mode]);
    await expectMissing(`${replacementFile}.lock`);
    expect(await readFile(path.join(originalRoot, "control.config"), "utf8")).toContain("key = control");
  });

  it("requires the reviewed root device, inode, and mount-aware identity", async () => {
    const expectedRoot = await rootIdentity(root);
    const control = await runConfinedGit(root, ["config", "--file", path.join(root, "control.config"), "inside.key", "control"], { env, expectedRoot });
    expect(control.exitCode, `Confinement unavailable or approved write failed: ${control.stderr}`).toBe(0);

    const invalidIdentities = [
      { name: "missing-token", value: { ...expectedRoot, identity: "" } },
      { name: "wrong-token", value: { ...expectedRoot, identity: "0".repeat(64) } },
      { name: "wrong-device", value: { ...expectedRoot, dev: (BigInt(expectedRoot.dev) + 1n).toString() } },
      { name: "wrong-inode", value: { ...expectedRoot, ino: (BigInt(expectedRoot.ino) + 1n).toString() } },
    ];
    for (const { name, value } of invalidIdentities) {
      const file = path.join(root, `${name}.config`);
      await expectRefused(
        runConfinedGit(root, ["config", "--file", file, "inside.key", "changed"], { env, expectedRoot: value }),
        /skills root identity is required|root identity mismatch/i,
      );
      await expectMissing(file);
      await expectMissing(`${file}.lock`);
    }
  });

  it("refuses a root path with a symlinked component", async () => {
    const expectedRoot = await rootIdentity(root);
    const control = await runConfinedGit(root, ["config", "--file", path.join(root, "control.config"), "inside.key", "control"], { env, expectedRoot });
    expect(control.exitCode, `Confinement unavailable or approved write failed: ${control.stderr}`).toBe(0);

    const alias = path.join(sandbox, "root-alias");
    await symlink(root, alias, "dir");
    const file = path.join(root, "via-alias.config");
    await expectRefused(
      runConfinedGit(alias, ["config", "--file", path.join(alias, "via-alias.config"), "inside.key", "changed"], { env, expectedRoot }),
      /root|symbolic|loop|not a directory/i,
    );
    await expectMissing(file);
    await expectMissing(`${file}.lock`);
  });

  it("skips repository and remote Git executables, including outside symlink aliases", async () => {
    const options = await reviewedBareRemote();
    const sentinel = path.join(root, "fake-git-executed");
    const fakeGit = '#!/bin/sh\nprintf "executed\\n" > "$HOME/fake-git-executed"\nexit 0\n';
    const directories = [path.join(root, "bin"), path.join(options.remoteDir, "bin")];
    for (const directory of directories) {
      await mkdir(directory);
      await writeFile(path.join(directory, "git"), fakeGit, { mode: 0o755 });
    }
    const aliases = [path.join(outside, "root-alias"), path.join(outside, "remote-alias")];
    for (const [index, alias] of aliases.entries()) {
      await mkdir(alias);
      await symlink(path.join(directories[index], "git"), path.join(alias, "git"));
    }

    for (const [index, directory] of [...directories, ...aliases].entries()) {
      const controlFile = path.join(root, `path-control-${index}.config`);
      const control = await runConfinedGit(root, ["config", "--file", controlFile, "inside.key", "control"], {
        ...options,
        env: { ...env, PATH: [directory, env.PATH].join(path.delimiter) },
      });
      expect(control.exitCode, `Confinement unavailable or genuine Git failed: ${control.stderr}`).toBe(0);
      expect(await readFile(controlFile, "utf8")).toContain("key = control");
      await expectMissing(sentinel);
    }
  }, 30_000);

  it("confines writes to the reviewed bare remote and refuses its replacement", async () => {
    const options = await reviewedBareRemote();
    const pushed = await runConfinedGit(root, ["push", options.remoteDir, "HEAD:refs/heads/main"], options);
    expect(pushed.exitCode, `Confinement unavailable or approved remote push failed: ${pushed.stderr}`).toBe(0);
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(fixtureGit(sandbox, "--git-dir", options.remoteDir, "rev-parse", "refs/heads/main"));

    const remoteFile = path.join(options.remoteDir, "boundary-test.config");
    const allowed = await runConfinedGit(root, ["config", "--file", remoteFile, "inside.key", "allowed"], options);
    expect(allowed.exitCode, `Confinement unavailable or approved remote write failed: ${allowed.stderr}`).toBe(0);
    expect(await readFile(remoteFile, "utf8")).toContain("key = allowed");

    const original = "[inside]\n\tkey = unchanged\n";
    const sibling = path.join(sandbox, "sibling.config");
    const outsideFile = path.join(outside, "outside.config");
    for (const file of [sibling, outsideFile]) {
      await writeFile(file, original);
      await expectRefused(runConfinedGit(root, ["config", "--file", file, "inside.key", "changed"], options), permissionDenied);
      expect(await readFile(file, "utf8")).toBe(original);
      await expectMissing(`${file}.lock`);
    }

    const reviewed = path.join(sandbox, "reviewed-remote.git");
    await rename(options.remoteDir, reviewed);
    fixtureGit(sandbox, "init", "--bare", options.remoteDir);
    expect(await identity(options.remoteDir)).not.toEqual(options.expectedRemoteDir);
    const replacementFile = path.join(options.remoteDir, "replacement.config");
    await writeFile(replacementFile, original);
    await expectRefused(
      runConfinedGit(root, ["config", "--file", replacementFile, "inside.key", "changed"], options),
      /remote|identity|mismatch|changed|stale/i,
    );
    expect(await readFile(replacementFile, "utf8")).toBe(original);
    await expectMissing(`${replacementFile}.lock`);
    expect(await readFile(path.join(reviewed, "boundary-test.config"), "utf8")).toContain("key = allowed");
    expect(await readFile(sibling, "utf8")).toBe(original);
    expect(await readFile(outsideFile, "utf8")).toBe(original);
  }, 30_000);

  it.each(["core.worktree", "config.worktree", "commondir"])(
    "refuses bare remote %s indirection without changing sentinels",
    async (indirection) => {
      const options = await reviewedBareRemote();
      const remoteFile = path.join(options.remoteDir, "boundary-test.config");
      const original = "[inside]\n\tkey = unchanged\n";
      await writeFile(remoteFile, original);
      const sentinel = path.join(outside, "sentinel.config");
      await writeFile(sentinel, original);
      const control = await runConfinedGit(root, ["config", "--file", remoteFile, "inside.key", "control"], options);
      expect(control.exitCode, `Confinement unavailable or approved remote write failed: ${control.stderr}`).toBe(0);
      const approvedContent = await readFile(remoteFile, "utf8");
      expect(approvedContent).toContain("key = control");

      if (indirection === "core.worktree") {
        fixtureGit(sandbox, "config", "--file", path.join(options.remoteDir, "config"), "core.worktree", outside);
      } else if (indirection === "config.worktree") {
        await writeFile(path.join(options.remoteDir, "config.worktree"), `[core]\n\tworktree = ${outside}\n`);
      } else {
        await writeFile(path.join(options.remoteDir, "commondir"), `${outside}\n`);
      }
      await expectRefused(
        runConfinedGit(root, ["config", "--file", remoteFile, "inside.key", "changed"], options),
        /remote|bare|worktree|commondir/i,
      );
      expect(await readFile(remoteFile, "utf8")).toBe(approvedContent);
      expect(await readFile(sentinel, "utf8")).toBe(original);
      await expectMissing(`${remoteFile}.lock`);
      await expectMissing(`${sentinel}.lock`);
    },
    30_000,
  );

  it("refuses a reviewed non-bare remote without changing sentinels", async () => {
    const options = await reviewedBareRemote();
    const remoteFile = path.join(options.remoteDir, "boundary-test.config");
    const control = await runConfinedGit(root, ["config", "--file", remoteFile, "inside.key", "control"], options);
    expect(control.exitCode, `Confinement unavailable or approved remote write failed: ${control.stderr}`).toBe(0);

    const nonBare = path.join(sandbox, "non-bare");
    await mkdir(nonBare);
    fixtureGit(nonBare, "init", "-b", "main");
    const sentinel = path.join(nonBare, "sentinel.config");
    const outsideFile = path.join(outside, "sentinel.config");
    const original = "[inside]\n\tkey = unchanged\n";
    await writeFile(sentinel, original);
    await writeFile(outsideFile, original);
    await expectRefused(
      runConfinedGit(root, ["config", "--file", sentinel, "inside.key", "changed"], {
        ...options,
        remoteDir: nonBare,
        expectedRemoteDir: await identity(nonBare),
      }),
      /remote|bare/i,
    );
    expect(await readFile(sentinel, "utf8")).toBe(original);
    expect(await readFile(outsideFile, "utf8")).toBe(original);
    await expectMissing(`${sentinel}.lock`);
    expect(await readFile(remoteFile, "utf8")).toContain("key = control");
  }, 30_000);

  it("allows the pinned common directory of a linked worktree, but not an unrelated directory", async () => {
    const main = path.join(sandbox, "main");
    const linked = path.join(sandbox, "linked");
    await mkdir(main);
    fixtureGit(main, "init", "-b", "main");
    await writeFile(path.join(main, "tracked"), "initial\n");
    fixtureGit(main, "add", "tracked");
    fixtureGit(main, "-c", "user.name=Boundary Test", "-c", "user.email=boundary@example.invalid", "commit", "--no-gpg-sign", "-m", "initial");
    fixtureGit(main, "worktree", "add", "-b", "boundary-linked", linked);

    const gitDir = await realpath(fixtureGit(linked, "rev-parse", "--absolute-git-dir"));
    const commonDir = await realpath(path.resolve(linked, fixtureGit(linked, "rev-parse", "--git-common-dir")));
    const options = {
      env,
      expectedRoot: await rootIdentity(linked),
      gitDir,
      expectedGitDir: await identity(gitDir),
      expectedGitEntry: await entryIdentity(path.join(linked, ".git")),
      commonDir,
      expectedCommonDir: await identity(commonDir),
    };
    expect(commonDir.startsWith(`${linked}${path.sep}`)).toBe(false);
    const approvedFile = path.join(commonDir, "boundary-test.config");
    const allowed = await runConfinedGit(linked, ["config", "--file", approvedFile, "inside.key", "allowed"], options);
    expect(allowed.exitCode, `Confinement unavailable or approved common-directory write failed: ${allowed.stderr}`).toBe(0);
    expect(await readFile(approvedFile, "utf8")).toContain("key = allowed");

    const unapprovedFile = path.join(outside, "unapproved.config");
    const original = "[inside]\n\tkey = unchanged\n";
    await writeFile(unapprovedFile, original);
    await expectRefused(runConfinedGit(linked, ["config", "--file", unapprovedFile, "inside.key", "changed"], options), permissionDenied);
    expect(await readFile(unapprovedFile, "utf8")).toBe(original);
    await expectMissing(`${unapprovedFile}.lock`);

    const launderedFile = path.join(outside, "laundered.config");
    await expectRefused(
      runConfinedGit(linked, ["config", "--file", launderedFile, "inside.key", "changed"], {
        ...options,
        commonDir: outside,
        expectedCommonDir: await identity(outside),
      }),
      /Git metadata relationship is invalid/i,
    );
    await expectMissing(launderedFile);
    await expectMissing(`${launderedFile}.lock`);

    const gitEntry = path.join(linked, ".git");
    const gitEntryContent = await readFile(gitEntry);
    await rename(gitEntry, path.join(linked, ".git-reviewed"));
    await writeFile(gitEntry, gitEntryContent);
    const afterReplacement = path.join(commonDir, "after-git-entry-replacement.config");
    await expectRefused(runConfinedGit(linked, ["config", "--file", afterReplacement, "inside.key", "changed"], options), /git|entry|identity|mismatch|changed|stale/i);
    await expectMissing(afterReplacement);
    expect(await readFile(gitEntry)).toEqual(gitEntryContent);
    expect(await readFile(approvedFile, "utf8")).toContain("key = allowed");
  }, 30_000);

  it("refuses an outside hardlink to mutable Git metadata before Git can run", async () => {
    fixtureGit(root, "init", "-b", "main");
    const tracked = path.join(root, "tracked");
    await writeFile(tracked, "before\n");
    fixtureGit(root, "add", "tracked");
    const gitDir = await realpath(path.join(root, ".git"));
    const options = {
      env,
      expectedRoot: await rootIdentity(root),
      gitDir,
      expectedGitDir: await identity(gitDir),
      expectedGitEntry: await entryIdentity(path.join(root, ".git")),
      commonDir: gitDir,
      expectedCommonDir: await identity(gitDir),
    };
    const control = await runConfinedGit(root, ["add", "--all"], options);
    expect(control.exitCode, `Confinement unavailable or approved write failed: ${control.stderr}`).toBe(0);

    const index = path.join(gitDir, "index");
    const sentinel = path.join(outside, "linked-index");
    await link(index, sentinel);
    const before = await readFile(sentinel);
    expect((await stat(index, { bigint: true })).nlink).toBe(2n);
    await writeFile(tracked, "after\n");
    await expectRefused(runConfinedGit(root, ["add", "--all"], options), /hardlinked file or link in writable tree is unsafe/i);
    expect(await readFile(sentinel)).toEqual(before);
    expect(await readFile(index)).toEqual(before);
    await expectMissing(`${index}.lock`);
  });

  it("refuses a root file hardlinked to an outside sentinel", async () => {
    const expectedRoot = await rootIdentity(root);
    const control = await runConfinedGit(root, ["config", "--file", path.join(root, "control.config"), "inside.key", "control"], { env, expectedRoot });
    expect(control.exitCode, `Confinement unavailable or approved write failed: ${control.stderr}`).toBe(0);

    const sentinel = path.join(outside, "hardlinked.config");
    const insideLink = path.join(root, "hardlinked.config");
    const original = "[inside]\n\tkey = unchanged\n";
    await writeFile(sentinel, original);
    await link(sentinel, insideLink);
    expect((await stat(insideLink, { bigint: true })).nlink).toBe(2n);
    await expectRefused(
      runConfinedGit(root, ["config", "--file", insideLink, "inside.key", "changed"], { env, expectedRoot }),
      /hardlinked file or link in writable tree is unsafe/i,
    );
    expect(await readFile(sentinel, "utf8")).toBe(original);
    expect(await readFile(insideLink, "utf8")).toBe(original);
    await expectMissing(`${insideLink}.lock`);
  });

  it("permits discard-device I/O without allowing other devices or outside writes", async () => {
    const expectedRoot = await rootIdentity(root);
    const sentinel = path.join(outside, "device-policy-sentinel");
    await writeFile(sentinel, "unchanged\n");
    const node = await realpath(process.execPath);
    const script = `
      const fs = require("node:fs");
      const fd = fs.openSync("/dev/null", "r+");
      fs.writeSync(fd, "discard");
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error("not a discard device");
      fs.closeSync(fd);
      for (const file of ["/dev/zero", ${JSON.stringify(sentinel)}]) {
        try {
          const denied = fs.openSync(file, "r+");
          fs.closeSync(denied);
          throw new Error("unexpected writable access to " + file);
        } catch (error) {
          if (!["EACCES", "EPERM"].includes(error.code)) throw error;
        }
      }
    `;
    const child = spawnSync(nativeHelper, ["--root", root, expectedRoot.dev, expectedRoot.ino, expectedRoot.identity, "--", node, "-e", script], {
      env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
    });
    expect(child.error, child.error?.message).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
  }, 30_000);

  it("closes inherited writable descriptors and rejects file-backed standard output", async () => {
    const expectedRoot = await rootIdentity(root);
    const control = await runConfinedGit(root, ["config", "--file", path.join(root, "control.config"), "inside.key", "control"], { env, expectedRoot });
    expect(control.exitCode, `Confinement unavailable or approved write failed: ${control.stderr}`).toBe(0);

    const sentinel = path.join(outside, "descriptor-sentinel");
    const original = "outside remains unchanged\n";
    await writeFile(sentinel, original);
    const handle = await open(sentinel, "r+");
    try {
      const node = await realpath(process.execPath);
      const fd = 73;
      const stdio: StdioOptions = ["pipe", "pipe", "pipe", ...Array<"ignore">(fd - 3).fill("ignore"), handle.fd];
      const attack = `
        const fs = require("node:fs");
        try {
          fs.writeSync(${fd}, "descriptor escaped\\n");
          process.stdout.write("leaked");
        } catch (error) {
          if (error.code !== "EBADF") throw error;
          process.stdout.write("closed");
        }
      `;
      const child = spawnSync(nativeHelper, ["--root", root, expectedRoot.dev, expectedRoot.ino, expectedRoot.identity, "--", node, "-e", attack], {
        env, encoding: "utf8", stdio, timeout: 30_000,
      });
      expect(child.error, child.error?.message).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe("closed");
      expect(await readFile(sentinel, "utf8")).toBe(original);

      const redirected = spawnSync(nativeHelper, ["--root", root, expectedRoot.dev, expectedRoot.ino, expectedRoot.identity, "--", node, "-e", 'process.stdout.write("escaped stdout\\n")'], {
        env, encoding: "utf8", stdio: ["pipe", handle.fd, "pipe"], timeout: 30_000,
      });
      expect(redirected.error, redirected.error?.message).toBeUndefined();
      expect(redirected.status, redirected.stderr).toBe(125);
      expect(redirected.stderr).toMatch(/stdin, stdout and stderr must be pipes or local stream sockets/i);
      expect(await readFile(sentinel, "utf8")).toBe(original);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("fails closed when the operating system cannot establish the write boundary", async () => {
    const expectedRoot = await rootIdentity(root);
    await symlink(path.join(project, "node_modules"), path.join(sandbox, "node_modules"), "dir");
    const wrapper = pathToFileURL(path.join(project, "src", "actions", "gitBoundary.ts")).href;
    const controlFile = path.join(root, "os-boundary-control.config");
    const control = spawnSync(process.execPath, wrapperArguments(wrapper, root, expectedRoot, controlFile), {
      cwd: sandbox, env, encoding: "utf8", timeout: 30_000,
    });
    expect(control.error, control.error?.message).toBeUndefined();
    expect(control.status, `Confinement unavailable or approved write failed: ${control.stderr}`).toBe(0);
    expect(await readFile(controlFile, "utf8")).toContain("key = control");

    let launcher: string;
    let prefix: string[];
    let reason: RegExp;
    if (process.platform === "darwin") {
      launcher = "/usr/bin/sandbox-exec";
      prefix = ["-p", '(version 1)\n(allow default)\n(deny process-exec (literal "/usr/bin/sandbox-exec"))\n', "--"];
      reason = /Git write boundary unavailable.*cannot execute sandbox-exec/i;
    } else if (process.platform === "linux") {
      const source = path.join(sandbox, "deny-landlock.c");
      launcher = path.join(sandbox, "deny-landlock");
      prefix = [];
      reason = /Git write boundary unavailable.*cannot install required write boundary/i;
      await writeFile(source, `
        #include <errno.h>
        #include <stddef.h>
        #include <stdio.h>
        #include <linux/filter.h>
        #include <linux/seccomp.h>
        #include <sys/prctl.h>
        #include <sys/syscall.h>
        #include <unistd.h>
        #ifndef SYS_landlock_create_ruleset
        #define SYS_landlock_create_ruleset 444
        #endif
        int main(int argc, char **argv) {
          struct sock_filter filter[] = {
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_landlock_create_ruleset, 0, 1),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
          };
          struct sock_fprog program = { sizeof(filter) / sizeof(filter[0]), filter };
          if (argc < 2) return 124;
          if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
              prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) < 0) {
            perror("cannot install seccomp test fixture");
            return 124;
          }
          execv(argv[1], &argv[1]);
          perror("cannot execute seccomp test fixture");
          return 124;
        }
      `);
      const compiler = spawnSync(process.env.CC || "cc", ["-std=c11", source, "-o", launcher], {
        cwd: sandbox, env, encoding: "utf8", timeout: 30_000,
      });
      expect(compiler.error, `Linux seccomp test compiler unavailable: ${compiler.error?.message}`).toBeUndefined();
      expect(compiler.status, `Cannot compile Linux seccomp test fixture: ${compiler.stderr}`).toBe(0);
    } else {
      throw new Error(`Cannot exercise the required OS write boundary on ${process.platform}`);
    }

    const blockedFile = path.join(root, "os-boundary-unavailable.config");
    const blocked = spawnSync(launcher, [...prefix, process.execPath, ...wrapperArguments(wrapper, root, expectedRoot, blockedFile)], {
      cwd: sandbox, env, encoding: "utf8", timeout: 30_000,
    });
    expect(blocked.error, blocked.error?.message).toBeUndefined();
    expect(blocked.status, blocked.stderr).not.toBe(0);
    expect(blocked.stderr).toMatch(reason);
    await expectMissing(blockedFile);
    await expectMissing(`${blockedFile}.lock`);
    expect(await readFile(controlFile, "utf8")).toContain("key = control");
  }, 60_000);

  it("fails explicitly for missing or incompatible helper metadata and for a missing helper", async () => {
    const expectedRoot = await rootIdentity(root);
    const isolated = path.join(sandbox, "isolated");
    const actions = path.join(isolated, "src", "actions");
    const native = path.join(isolated, "native");
    await mkdir(actions, { recursive: true });
    await mkdir(native);
    await writeFile(path.join(isolated, "package.json"), '{"type":"module"}\n');
    await symlink(path.join(project, "node_modules"), path.join(isolated, "node_modules"), "dir");
    await copyFile(path.join(project, "src", "actions", "gitBoundary.ts"), path.join(actions, "gitBoundary.ts"));
    await copyFile(nativeHelper, path.join(native, "skills-git-boundary"));
    const metadataPath = path.join(native, "skills-git-boundary.platform.json");
    const metadataText = await readFile(nativeMetadata, "utf8");
    await writeFile(metadataPath, metadataText);
    const metadata = JSON.parse(metadataText) as { platform: string; arch: string; libc: string | null };
    const moduleUrl = pathToFileURL(path.join(actions, "gitBoundary.ts")).href;
    // The copied module URL makes its helper lookup use the isolated layout.
    function launchCopy(file: string) {
      const child = spawnSync(process.execPath, wrapperArguments(moduleUrl, root, expectedRoot, file), {
        cwd: isolated, env, encoding: "utf8", timeout: 30_000,
      });
      expect(child.error, child.error?.message).toBeUndefined();
      return child;
    }

    const controlFile = path.join(root, "isolated-control.config");
    const control = launchCopy("isolated-control.config");
    expect(control.status, `Copied runner must execute the real helper: ${control.stderr}`).toBe(0);
    expect(await readFile(controlFile, "utf8")).toContain("key = control");
    await expectMissing(path.join(isolated, "isolated-control.config"));

    await rm(metadataPath);
    const missingFile = path.join(root, "missing-metadata.config");
    const missing = launchCopy(missingFile);
    expect(missing.status, missing.stderr).not.toBe(0);
    expect(missing.stderr).toMatch(/metadata.*(missing|invalid)|(?:missing|invalid).*metadata/i);
    await expectMissing(missingFile);

    await writeFile(metadataPath, "{invalid json");
    const invalidFile = path.join(root, "invalid-metadata.config");
    const invalid = launchCopy(invalidFile);
    expect(invalid.status, invalid.stderr).not.toBe(0);
    expect(invalid.stderr).toMatch(/metadata.*(missing|invalid)|(?:missing|invalid).*metadata/i);
    await expectMissing(invalidFile);

    const mismatches = [
      { ...metadata, platform: process.platform === "darwin" ? "linux" : "darwin" },
      { ...metadata, arch: process.arch === "arm64" ? "x64" : "arm64" },
      { ...metadata, libc: process.platform === "linux" ? "musl" : "glibc" },
    ];
    for (const [index, mismatch] of mismatches.entries()) {
      await writeFile(metadataPath, JSON.stringify(mismatch));
      const file = path.join(root, `incompatible-${index}.config`);
      const child = launchCopy(file);
      expect(child.status, child.stderr).not.toBe(0);
      expect(child.stderr).toMatch(/incompatible|not compatible|unsupported/i);
      await expectMissing(file);
    }

    await writeFile(metadataPath, metadataText);
    await rm(path.join(native, "skills-git-boundary"));
    const noHelperFile = path.join(root, "missing-helper.config");
    const noHelper = launchCopy(noHelperFile);
    expect(noHelper.status, noHelper.stderr).not.toBe(0);
    expect(noHelper.stderr).toMatch(/(?:helper|skills-git-boundary|git write boundary).*(?:missing|cannot execute|incompatible|unavailable|enoent)|enoent.*(?:helper|skills-git-boundary)/i);
    await expectMissing(noHelperFile);
    expect(await readFile(controlFile, "utf8")).toContain("key = control");
  }, 60_000);
});
