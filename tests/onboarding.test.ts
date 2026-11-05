import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverGit } from "../src/actions/git.js";
import { documentedSkillsDirectories, selectSkillsDirectory, type OnboardingIO } from "../src/onboarding.js";

let home: string;

function git(dir: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return execFileSync("git", ["-c", "init.templateDir=", ...args], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trimEnd();
}

function scripted(answers: (string | null)[]): { io: OnboardingIO; output: string[]; prompts: string[] } {
  const output: string[] = [];
  const prompts: string[] = [];
  const queue = [...answers];
  return {
    output,
    prompts,
    io: {
      async ask(prompt) {
        prompts.push(prompt);
        if (queue.length === 0) throw new Error(`Unexpected prompt: ${prompt}`);
        return queue.shift() ?? null;
      },
      write(message) { output.push(message); },
    },
  };
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-onboarding-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("read-only directory selection", () => {
  it("lists documented global locations without implicitly including a project", () => {
    expect(documentedSkillsDirectories(home).map((candidate) => candidate.path)).toEqual([
      path.join(home, ".agents/skills"),
      path.join(home, ".claude/skills"),
      path.join(home, ".cursor/skills"),
      path.join(home, ".config/opencode/skills"),
      path.join(home, ".config/agents/skills"),
    ]);
    expect(documentedSkillsDirectories(`${home}/a/link/..`)[0].path).toBe(`${home}/a/link/../.agents/skills`);
  });

  it("chooses a fresh home's default without creating any directory or state", async () => {
    const session = scripted([""]);
    await expect(selectSkillsDirectory(session.io, { home })).resolves.toEqual({
      root: { path: path.join(home, ".agents/skills"), identity: null }, reviewInitialize: false,
    });
    expect(await readdir(home)).toEqual([]);
    expect(session.output.join("")).toContain("browsing will not create it");
    expect(session.prompts).toEqual(["Choose [1] (q to cancel): "]);
  });

  it("selects a project-local directory only when the user enters it", async () => {
    await mkdir(path.join(home, "project", "skills"), { recursive: true });
    const session = scripted(["6", "./project/skills", ""]);
    await expect(selectSkillsDirectory(session.io, { home, cwd: home })).resolves.toEqual({
      root: { path: path.join(home, "project/skills"), identity: expect.any(String) }, reviewInitialize: false,
    });
    expect(await readdir(path.join(home, "project", "skills"))).toEqual([]);
  });

  it("gives an explicit directory priority over the menu", async () => {
    const selected = path.join(home, "custom");
    await mkdir(selected);
    const session = scripted([""]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false,
    });
    expect(session.prompts).toEqual([
      "Review optional local Git initialization? [y/N] (q to cancel): ",
    ]);
    expect(await readdir(selected)).toEqual([]);
  });

  it("offers only optional local initialization without changing files", async () => {
    const selected = path.join(home, "skills");
    await mkdir(selected);
    await writeFile(path.join(selected, "sentinel"), "unchanged");
    for (const [answer, reviewInitialize] of [["y", true], ["yes", true], ["", false], ["n", false]] as const) {
      const session = scripted([answer]);
      await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toEqual({
        root: { path: selected, identity: expect.any(String) }, reviewInitialize,
      });
      expect(session.prompts).toEqual(["Review optional local Git initialization? [y/N] (q to cancel): "]);
    }
    expect(await readdir(selected)).toEqual(["sentinel"]);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("unchanged");
    expect(await readdir(home)).toEqual(["skills"]);
  });

  it.each(["leaf", "parent"] as const)("adopts an existing %s repository without a remote or setup prompts", async (kind) => {
    const repository = path.join(home, "repository");
    const selected = kind === "leaf" ? repository : path.join(repository, "skills");
    await mkdir(selected, { recursive: true });
    git(repository, "init");
    await mkdir(path.join(repository, ".git", "info"), { recursive: true });
    await writeFile(path.join(repository, ".git", "info", "exclude"), "# fixture exclusion\n");
    const sentinel = path.join(selected, "sentinel");
    const sibling = path.join(repository, "sibling");
    await writeFile(sentinel, "staged skill");
    await writeFile(sibling, "staged sibling");
    git(repository, "add", "--", path.relative(repository, sentinel), "sibling");
    await writeFile(sentinel, "unstaged skill");
    await writeFile(sibling, "unstaged sibling");
    const index = await readFile(path.join(repository, ".git", "index"));
    const config = await readFile(path.join(repository, ".git", "config"));
    const head = await readFile(path.join(repository, ".git", "HEAD"));
    const exclude = await readFile(path.join(repository, ".git", "info", "exclude"));
    expect(git(repository, "remote")).toBe("");
    expect(await discoverGit(selected)).toMatchObject({ kind, selectedDir: selected, topLevel: repository });

    const session = scripted([]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false,
    });
    expect(session.prompts).toEqual([]);
    expect(await readFile(path.join(repository, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(repository, ".git", "config"))).toEqual(config);
    expect(await readFile(path.join(repository, ".git", "HEAD"))).toEqual(head);
    expect(await readFile(path.join(repository, ".git", "info", "exclude"))).toEqual(exclude);
    expect(await readFile(sentinel, "utf8")).toBe("unstaged skill");
    expect(await readFile(sibling, "utf8")).toBe("unstaged sibling");
    expect(await readdir(selected)).toEqual(kind === "leaf" ? [".git", "sentinel", "sibling"] : ["sentinel"]);
  });

  it("allows browsing without setup prompts when Git is unavailable", async () => {
    const selected = path.join(home, "skills");
    await mkdir(selected);
    await writeFile(path.join(selected, "sentinel"), "unchanged");
    vi.stubEnv("PATH", path.join(home, "missing-bin"));
    expect(await discoverGit(selected)).toMatchObject({ kind: "unavailable" });
    const session = scripted([]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false,
    });
    expect(session.prompts).toEqual([]);
    expect(await readdir(selected)).toEqual(["sentinel"]);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("allows browsing without setup prompts when Git discovery fails", async () => {
    const selected = path.join(home, "skills");
    await mkdir(selected);
    git(selected, "init");
    const config = path.join(selected, ".git", "config");
    await writeFile(config, "[invalid\n");
    await writeFile(path.join(selected, "sentinel"), "unchanged");
    expect(await discoverGit(selected)).toMatchObject({ kind: "error" });
    const session = scripted([]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false,
    });
    expect(session.prompts).toEqual([]);
    expect(await readFile(config, "utf8")).toBe("[invalid\n");
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("unchanged");
  });

  it.each(["leaf", "parent"] as const)("does not contact a configured remote while adopting a %s repository", async (kind) => {
    const repository = path.join(home, "repository");
    const selected = kind === "leaf" ? repository : path.join(repository, "skills");
    await mkdir(selected, { recursive: true });
    git(repository, "init");
    await writeFile(path.join(selected, "sentinel"), "unchanged");
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    let connections = 0;
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    server.on("connection", () => { connections += 1; });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback TCP listener");
      git(repository, "remote", "add", "origin", `http://127.0.0.1:${address.port}/repo.git`);
      const config = await readFile(path.join(repository, ".git", "config"));
      const head = await readFile(path.join(repository, ".git", "HEAD"));
      const entries = await readdir(path.join(repository, ".git"));
      const session = scripted([]);
      await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toEqual({
        root: { path: selected, identity: expect.any(String) }, reviewInitialize: false,
      });
      expect(session.prompts).toEqual([]);
      expect(connections).toBe(0);
      expect(await readFile(path.join(repository, ".git", "config"))).toEqual(config);
      expect(await readFile(path.join(repository, ".git", "HEAD"))).toEqual(head);
      expect(await readdir(path.join(repository, ".git"))).toEqual(entries);
      expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("unchanged");
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
  });

  it.each(["q", null])("cancels an initialization review on %s without Git changes", async (answer) => {
    const selected = path.join(home, "skills");
    await mkdir(selected);
    const session = scripted([answer]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toBeNull();
    expect(await readdir(selected)).toEqual([]);
  });

  it("quotes selected paths and link targets without emitting terminal controls", async () => {
    const leaf = "target-\x1b]52;c;cHdu\x07\nline\t\u202e\\\"quote";
    const target = path.join(home, leaf);
    const alias = path.join(home, "alias");
    await mkdir(target);
    await symlink(leaf, alias);
    const session = scripted(["y", ""]);

    const selected = await selectSkillsDirectory(session.io, { home, explicitSkillsDir: alias });
    expect(selected).toEqual({ root: { path: target, identity: expect.any(String) }, reviewInitialize: false });
    const output = session.output.join("");
    expect(output).toContain(`Selected link: "${alias}" -> "`);
    expect(output).toContain(String.raw`target-\x1b]52;c;cHdu\x07\nline\t\u202e\\\"quote`);
    expect(output).not.toMatch(/[\x1b\x07\t\u202e]/);
    expect(await readlink(alias)).toBe(leaf);
    expect(await readdir(target)).toEqual([]);
  });

  it("escapes untrusted candidate paths and current paths in the selection menu", async () => {
    const session = scripted(["q"]);
    const unusualHome = `${home}/home-\x1b]0;title\x07`;
    const current = `${home}/current\n\u009b31m`;
    await expect(selectSkillsDirectory(session.io, { home: unusualHome, currentSkillsDir: current })).resolves.toBeNull();
    const output = session.output.join("");
    expect(output).toContain(String.raw`home-\x1b]0;title\x07/.agents/skills`);
    expect(output).toContain(String.raw`current\n\x9b31m`);
    expect(output).not.toMatch(/[\x1b\x07\u009b]/);
  });

  it("escapes terminal controls in broken-link diagnostics", async () => {
    const alias = path.join(home, "broken-\x1b]0;title\x07");
    const linkTarget = "missing-\x1b]52;c;cHdu\x07\nline";
    await symlink(linkTarget, alias);
    const session = scripted(["q"]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: alias })).resolves.toBeNull();
    const output = session.output.join("");
    expect(output).toContain(String.raw`broken-\x1b]0;title\x07`);
    expect(output).toContain(String.raw`missing-\x1b]52;c;cHdu\x07\nline`);
    expect(output).not.toMatch(/[\x1b\x07]/);
    expect(await readlink(alias)).toBe(linkTarget);
  });

  it("previews and requires approval of the actual link target", async () => {
    const target = path.join(home, "target");
    const alias = path.join(home, "alias");
    await mkdir(target);
    await writeFile(path.join(target, "sentinel"), "unchanged");
    await symlink("target", alias);

    const declined = scripted(["n", "q"]);
    await expect(selectSkillsDirectory(declined.io, { home, explicitSkillsDir: alias })).resolves.toBeNull();
    expect(declined.output.join("")).toContain(`Resolved target: "${target}"`);
    expect(await readlink(alias)).toBe("target");
    expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("unchanged");

    const approved = scripted(["yes", ""]);
    const selected = await selectSkillsDirectory(approved.io, { home, explicitSkillsDir: alias });
    expect(selected).toEqual({ root: { path: target, identity: expect.any(String) }, reviewInitialize: false });
    expect(await readlink(alias)).toBe("target");
    await unlink(alias);
    await mkdir(path.join(home, "other"));
    await symlink("other", alias);
    expect(selected).toEqual({ root: { path: target, identity: expect.any(String) }, reviewInitialize: false });
    expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("uses the actual target when a link is followed by ..", async () => {
    await mkdir(path.join(home, "a", "skills"), { recursive: true });
    await mkdir(path.join(home, "other", "inner"), { recursive: true });
    await mkdir(path.join(home, "other", "skills"), { recursive: true });
    await writeFile(path.join(home, "a", "skills", "sentinel"), "lexical installation");
    await writeFile(path.join(home, "other", "skills", "sentinel"), "actual installation");
    await symlink("../other/inner", path.join(home, "a", "link"));
    const supplied = `${home}/a/link/../skills`;
    const session = scripted(["y", ""]);

    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: supplied })).resolves.toEqual({
      root: { path: path.join(home, "other", "skills"), identity: expect.any(String) }, reviewInitialize: false,
    });
    expect(session.output.join("")).toContain(`Selected path: "${supplied}"`);
    expect(session.output.join("")).toContain(`Resolved target: "${path.join(home, "other", "skills")}"`);
    expect(await readFile(path.join(home, "a", "skills", "sentinel"), "utf8")).toBe("lexical installation");
    expect(await readFile(path.join(home, "other", "skills", "sentinel"), "utf8")).toBe("actual installation");
  });

  it("refuses an ambiguous missing path with .. without creating anything", async () => {
    const session = scripted(["q"]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: `${home}/missing/../skills` })).resolves.toBeNull();
    expect(session.output.join("")).toContain("missing directory containing '..'");
    expect(await readdir(home)).toEqual([]);
  });

  it("previews an existing linked ancestor of a missing root without creating it", async () => {
    await mkdir(path.join(home, "target"));
    await symlink("target", path.join(home, "alias"));
    const session = scripted(["y"]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: path.join(home, "alias", "new") }))
      .resolves.toEqual({ root: { path: path.join(home, "target", "new"), identity: null }, reviewInitialize: false });
    expect(await readdir(path.join(home, "target"))).toEqual([]);
    expect(await readlink(path.join(home, "alias"))).toBe("target");
  });

  it("shows a broken selected link and leaves it unchanged", async () => {
    const alias = path.join(home, "broken");
    await symlink("missing", alias);
    const session = scripted(["q"]);
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: alias })).resolves.toBeNull();
    expect(session.output.join("")).toContain(`Broken or inaccessible link: "${alias}" -> "missing"`);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readlink(alias)).toBe("missing");
  });

  it("rejects an ordinary directory replaced while the user is approving it", async () => {
    const selected = path.join(home, "selected");
    const original = path.join(home, "original");
    const replacement = path.join(home, "replacement");
    await mkdir(selected);
    await mkdir(replacement);
    await writeFile(path.join(selected, "sentinel"), "original");
    await writeFile(path.join(replacement, "sentinel"), "replacement");
    const session = scripted(["", "q"]);
    const ask = session.io.ask;
    session.io.ask = async (prompt) => {
      if (prompt.startsWith("Review optional local Git")) {
        await rename(selected, original);
        await rename(replacement, selected);
      }
      return ask(prompt);
    };

    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toBeNull();
    expect(session.output.join("")).toContain("selected directory changed during approval");
    expect(await readFile(path.join(original, "sentinel"), "utf8")).toBe("original");
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("replacement");
  });

  it("rechecks repository identity even when no setup question is asked", async () => {
    const selected = path.join(home, "selected");
    const original = path.join(home, "original");
    const replacement = path.join(home, "replacement");
    await mkdir(selected);
    await mkdir(replacement);
    git(selected, "init");
    git(replacement, "init");
    await writeFile(path.join(selected, "sentinel"), "original");
    await writeFile(path.join(replacement, "sentinel"), "replacement");
    const session = scripted(["q"]);
    const write = session.io.write;
    session.io.write = (message) => {
      write(message);
      if (message.startsWith("Selected skills directory:")) {
        renameSync(selected, original);
        renameSync(replacement, selected);
      }
    };

    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected })).resolves.toBeNull();
    expect(session.prompts).toEqual(["Choose [1] (q to cancel): "]);
    expect(session.output.join("")).toContain("selected directory changed during approval");
    expect(await readFile(path.join(original, "sentinel"), "utf8")).toBe("original");
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("replacement");
  });

  it("requires reselection if a missing directory is created during onboarding", async () => {
    const selected = path.join(home, "new");
    const session = scripted([]);
    const write = session.io.write;
    session.io.write = (message) => {
      write(message);
      if (message.includes("does not exist yet")) mkdirSync(selected);
    };
    await expect(selectSkillsDirectory(session.io, { home, explicitSkillsDir: selected }))
      .resolves.toEqual({ root: { path: selected, identity: null }, reviewInitialize: false });
    expect(session.prompts).toEqual([]);
    const reselection = scripted([""]);
    await expect(selectSkillsDirectory(reselection.io, { home, explicitSkillsDir: selected }))
      .resolves.toEqual({ root: { path: selected, identity: expect.any(String) }, reviewInitialize: false });
    expect(await readdir(selected)).toEqual([]);
  });

  it("keeps the current directory when revisiting selection is cancelled", async () => {
    const session = scripted([""]);
    await expect(selectSkillsDirectory(session.io, { home, currentSkillsDir: path.join(home, "current") })).resolves.toBeNull();
    expect(await readdir(home)).toEqual([]);
  });
});
