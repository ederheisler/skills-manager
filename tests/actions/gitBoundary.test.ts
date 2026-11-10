import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveSkillsRoot } from "../../src/actions/boundary.js";
import { runValidatedGit, type DirectoryIdentity, type ValidatedGitOptions } from "../../src/actions/gitBoundary.js";

let sandbox: string;
let root: string;
let env: NodeJS.ProcessEnv;
async function identity(file: string): Promise<DirectoryIdentity> {
  const value = await lstat(file, { bigint: true }); return { dev: value.dev.toString(), ino: value.ino.toString() };
}
async function binding(selected = root): Promise<ValidatedGitOptions> {
  const gitDir = path.join(root, ".git");
  return { env, expectedRoot: { ...await identity(selected), identity: (await approveSkillsRoot(selected)).identity }, repositoryRoot: root, expectedRepositoryRoot: await identity(root), gitDir, expectedGitDir: await identity(gitDir), expectedGitEntry: await identity(gitDir), commonDir: gitDir, expectedCommonDir: await identity(gitDir) };
}
beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "skills-validated-git-")));
  root = path.join(sandbox, "root"); await mkdir(root);
  env = { PATH: process.env.PATH, HOME: sandbox, XDG_CONFIG_HOME: path.join(sandbox, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main"], { cwd: root, env, stdio: "ignore" });
});
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

describe("in-app validated Git execution", () => {
  it("runs existing Git directly without native files or helper metadata", async () => {
    const result = await runValidatedGit(root, ["config", "fixture.value", "written"], await binding());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(path.join(root, ".git", "config"), "utf8")).toContain("value = written");
  });
  it("refuses stale roots before executing Git", async () => {
    const options = await binding(); await rename(root, `${root}-old`); await mkdir(root);
    await expect(runValidatedGit(root, ["config", "--file", path.join(root, "output"), "fixture.value", "bad"], options)).rejects.toThrow(/identity|changed|approved/i);
    await expect(lstat(path.join(root, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses mismatched containing repository and incomplete metadata identities", async () => {
    const selected = path.join(root, "project", "skills"); await mkdir(selected, { recursive: true }); const options = await binding(selected);
    for (const key of ["repositoryRoot", "expectedRepositoryRoot", "gitDir", "expectedGitDir", "expectedGitEntry", "commonDir", "expectedCommonDir"] as const) {
      await expect(runValidatedGit(selected, ["status", "--porcelain"], { ...options, [key]: undefined })).rejects.toThrow();
    }
    const alias = path.join(sandbox, "alias"); await symlink(root, alias);
    await expect(runValidatedGit(selected, ["status", "--porcelain"], { ...options, repositoryRoot: alias })).rejects.toThrow(/directory|identity|changed/i);
  });
  it.each(["symlink", "hardlink", "directory-symlink"])("refuses unsafe metadata: %s", async (kind) => {
    const options = await binding(); const outside = path.join(sandbox, "outside"); await writeFile(outside, "do not modify\n");
    const entry = path.join(root, ".git", "unsafe");
    if (kind === "hardlink") await link(outside, entry);
    else if (kind === "directory-symlink") await symlink(sandbox, entry);
    else await symlink(outside, entry);
    await expect(runValidatedGit(root, ["config", "fixture.value", "bad"], options)).rejects.toThrow(/symlink|hardlink|special/i);
    expect(await readFile(outside, "utf8")).toBe("do not modify\n");
  });
  it("does not select Git from the repository or an outside symlink alias", async () => {
    const options = await binding(); const bin = path.join(root, "bin"); const alias = path.join(sandbox, "bin"); await mkdir(bin); await mkdir(alias);
    const marker = path.join(root, "fake-ran"); await writeFile(path.join(bin, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
    await symlink(path.join(bin, "git"), path.join(alias, "git"));
    for (const directory of [bin, alias]) {
      const result = await runValidatedGit(root, ["--version"], { ...options, env: { ...env, PATH: [directory, env.PATH].join(path.delimiter) } });
      expect(result.stdout).toMatch(/^git version /); await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("refuses a hardlinked index before a write can replace it", async () => {
    await writeFile(path.join(root, "tracked"), "base\n"); execFileSync("git", ["add", "tracked"], { cwd: root, env });
    const options = await binding(); const index = path.join(root, ".git", "index"); const outside = path.join(sandbox, "outside-index");
    await link(index, outside); const bytes = await readFile(outside); expect((await stat(outside)).nlink).toBe(2);
    await expect(runValidatedGit(root, ["add", "tracked"], options)).rejects.toThrow(/hardlink/i);
    expect(await readFile(index)).toEqual(bytes); expect(await readFile(outside)).toEqual(bytes);
  });
});
