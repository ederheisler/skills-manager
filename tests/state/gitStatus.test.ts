import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { countGitStatusLines } from "../../src/state/gitStatus.js";
import { getStatus } from "../../src/actions/git.js";

let sandbox: string;
let home: string | undefined;
let xdg: string | undefined;
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trimEnd();
}
beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "skills-status-")));
  const fixtureHome = path.join(sandbox, "fixture-home");
  await mkdir(fixtureHome);
  home = process.env.HOME;
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = fixtureHome;
  process.env.XDG_CONFIG_HOME = path.join(fixtureHome, ".config");
});
afterEach(async () => {
  if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = xdg;
  await rm(sandbox, { recursive: true, force: true });
});

describe("skill Git status", () => {
  it("counts individual active and disabled skill files, excluding unrelated and reserved paths", async () => {
    git(sandbox, "init", "-b", "trunk");
    await mkdir(path.join(sandbox, "alpha"));
    await mkdir(path.join(sandbox, ".disabled_skills", "beta"), { recursive: true });
    await mkdir(path.join(sandbox, ".skills-manager", "recovery"), { recursive: true });
    await writeFile(path.join(sandbox, "alpha", "SKILL.md"), "---\nname: alpha\n---\nA\n");
    await writeFile(path.join(sandbox, "alpha", "a\nfile.txt"), "one\n");
    await writeFile(path.join(sandbox, ".disabled_skills", "beta", "SKILL.md"), "---\nname: beta\n---\nB\n");
    await writeFile(path.join(sandbox, ".skills-manager", "recovery", "data"), "recovery\n");
    await writeFile(path.join(sandbox, "unrelated"), "leave alone\n");
    expect(await countGitStatusLines(sandbox)).toBe(3);
    expect((await getStatus(sandbox)).map((entry) => entry.path).sort()).toEqual([
      ".disabled_skills/beta/SKILL.md", "alpha/SKILL.md", "alpha/a\nfile.txt",
    ].sort());
  });

  it("reports a missing repository as an error rather than zero changes", async () => {
    const selected = path.join(sandbox, "selected");
    await mkdir(selected);
    await expect(countGitStatusLines(selected)).rejects.toThrow(/repository/i);
  });

  it("counts changed selected skills, not unrelated changes in a containing repository", async () => {
    const selected = path.join(sandbox, "selected");
    const skill = path.join(selected, "alpha", "SKILL.md");
    await mkdir(path.dirname(skill), { recursive: true });
    git(sandbox, "init", "-b", "trunk");
    git(sandbox, "config", "user.name", "Fixture");
    git(sandbox, "config", "user.email", "fixture@example.invalid");
    await writeFile(skill, "---\nname: alpha\n---\nbase\n");
    await writeFile(path.join(sandbox, "outside"), "base\n");
    git(sandbox, "add", "selected/alpha/SKILL.md", "outside");
    git(sandbox, "commit", "-m", "base");
    expect(await countGitStatusLines(selected)).toBe(0);
    await writeFile(skill, "---\nname: alpha\n---\nchanged\n");
    await writeFile(path.join(sandbox, "outside"), "unrelated change\n");
    expect(await countGitStatusLines(selected)).toBe(1);
    expect((await getStatus(selected)).map((entry) => entry.path)).toEqual(["alpha/SKILL.md"]);
  });

  it("keeps deleted files of previously tracked skills visible", async () => {
    git(sandbox, "init", "-b", "trunk");
    git(sandbox, "config", "user.name", "Fixture");
    git(sandbox, "config", "user.email", "fixture@example.invalid");
    await mkdir(path.join(sandbox, "alpha"));
    await writeFile(path.join(sandbox, "alpha", "SKILL.md"), "---\nname: alpha\n---\nA\n");
    await writeFile(path.join(sandbox, "alpha", "notes"), "notes\n");
    git(sandbox, "add", "alpha");
    git(sandbox, "commit", "-m", "base");
    await rm(path.join(sandbox, "alpha"), { recursive: true });
    expect((await getStatus(sandbox)).map((entry) => entry.path).sort()).toEqual(["alpha/SKILL.md", "alpha/notes"]);
  });
});
