import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectSavedSkillsDirectory, type DirectorySelectionOptions, type OnboardingIO } from "../src/onboarding.js";

let home: string;

function options(extra: DirectorySelectionOptions = {}): DirectorySelectionOptions {
  return { home, cwd: home, ...extra };
}

function configPath(): string {
  return path.join(home, "config", "skills-manager", "config.json");
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

function expectConfigWarning(output: string[]): void {
  const warning = /warn|(?:config|setup|sav|persist).*(?:unsafe|invalid|corrupt|could not|cannot|fail|refus|ignor|not |unavailable|overlap|disabl)|(?:unsafe|invalid|corrupt|could not|cannot|fail|refus|ignor|unavailable|overlap|disabl).*(?:config|setup|sav|persist)/i;
  expect(output.some((message) => warning.test(message))).toBe(true);
}

async function skills(name: string): Promise<string> {
  const selected = path.join(home, name);
  await mkdir(selected, { recursive: true });
  await writeFile(path.join(selected, "sentinel"), `${name} unchanged`);
  return selected;
}

async function saveSelection(selected: string) {
  const session = scripted(["", ""]);
  const result = await selectSavedSkillsDirectory(session.io, options({ explicitSkillsDir: selected }));
  expect(result).toEqual({
    root: { path: selected, identity: expect.any(String) },
    reviewInitialize: false,
    reviewBackup: false,
  });
  return result!;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-startup-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, "config"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("saved startup selection", () => {
  it("saves the chosen root without permissions and reuses it without any prompts or review flags", async () => {
    const selected = await skills("first");
    const configDirectory = path.dirname(configPath());
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    for (const name of ["app.json", "cli.json"]) {
      await writeFile(path.join(configDirectory, name), `sentinel: ${name}\n`, { mode: 0o600 });
    }
    const first = scripted(["6", selected, "yes", "yes"]);
    const chosen = await selectSavedSkillsDirectory(first.io, options());
    expect(chosen).toEqual({
      root: { path: selected, identity: expect.any(String) },
      reviewInitialize: true,
      reviewBackup: true,
    });
    expect(first.prompts).toHaveLength(4);

    const record = JSON.parse(await readFile(configPath(), "utf8"));
    expect(record).toEqual({
      kind: "skills-manager-setup",
      version: 1,
      selectedPath: selected,
      canonicalRoot: selected,
      identity: chosen!.root.identity,
    });

    const repeat = scripted([]);
    await expect(selectSavedSkillsDirectory(repeat.io, options())).resolves.toEqual({
      root: chosen!.root,
      reviewInitialize: false,
      reviewBackup: false,
    });
    expect(repeat.prompts).toEqual([]);
    for (const name of ["app.json", "cli.json"]) {
      expect(await readFile(path.join(configDirectory, name), "utf8")).toBe(`sentinel: ${name}\n`);
    }
    expect(await readdir(selected)).toEqual(["sentinel"]);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("first unchanged");
  });

  it("honors explicit same and different paths before the saved choice", async () => {
    const first = await skills("first");
    const second = await skills("second");
    const original = await saveSelection(first);
    const same = scripted([]);
    await expect(selectSavedSkillsDirectory(same.io, options({ explicitSkillsDir: first }))).resolves.toEqual(original);
    expect(same.prompts).toEqual([]);

    const different = scripted(["yes", ""]);
    const chosen = await selectSavedSkillsDirectory(different.io, options({ explicitSkillsDir: second }));
    expect(chosen).toEqual({
      root: { path: second, identity: expect.any(String) },
      reviewInitialize: true,
      reviewBackup: false,
    });
    expect(different.prompts).toHaveLength(2);
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({
      kind: "skills-manager-setup", version: 1, selectedPath: second,
      canonicalRoot: second, identity: chosen!.root.identity,
    });
    const repeat = scripted([]);
    await expect(selectSavedSkillsDirectory(repeat.io, options())).resolves.toEqual({
      root: chosen!.root, reviewInitialize: false, reviewBackup: false,
    });
    expect(await readFile(path.join(first, "sentinel"), "utf8")).toBe("first unchanged");
    expect(await readFile(path.join(second, "sentinel"), "utf8")).toBe("second unchanged");
  });

  it("reuses explicitly named paths to the same root only while the saved path still points there", async () => {
    const target = await skills("target");
    const alias = path.join(home, "alias");
    await symlink(target, alias);
    const anotherAlias = path.join(home, "another-alias");
    await symlink(target, anotherAlias);
    const first = scripted(["yes", "yes", "yes"]);
    const chosen = await selectSavedSkillsDirectory(first.io, options({ explicitSkillsDir: alias }));
    expect(chosen).toEqual({
      root: { path: target, identity: expect.any(String) }, reviewInitialize: true, reviewBackup: true,
    });
    const originalRecord = await readFile(configPath(), "utf8");
    expect(JSON.parse(originalRecord)).toEqual({
      kind: "skills-manager-setup", version: 1, selectedPath: alias,
      canonicalRoot: target, identity: chosen!.root.identity,
    });
    for (const explicitSkillsDir of [alias, target, anotherAlias]) {
      const repeat = scripted([]);
      await expect(selectSavedSkillsDirectory(repeat.io, options({ explicitSkillsDir }))).resolves.toEqual({
        root: chosen!.root, reviewInitialize: false, reviewBackup: false,
      });
      expect(repeat.prompts).toEqual([]);
    }
    expect(await readFile(configPath(), "utf8")).toBe(originalRecord);
    expect(await readlink(alias)).toBe(target);
    expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("target unchanged");
  });

  it("opens the chooser on revisit, saves a different root, and preserves it on cancel or failure", async () => {
    const first = await skills("first");
    const second = await skills("second");
    await saveSelection(first);
    const revisit = scripted(["6", second, "yes", ""]);
    const changed = await selectSavedSkillsDirectory(revisit.io, options({ currentSkillsDir: first }));
    expect(changed).toEqual({
      root: { path: second, identity: expect.any(String) }, reviewInitialize: true, reviewBackup: false,
    });
    expect(revisit.prompts).toHaveLength(4);
    const saved = await readFile(configPath(), "utf8");
    expect(JSON.parse(saved)).toEqual({
      kind: "skills-manager-setup", version: 1, selectedPath: second,
      canonicalRoot: second, identity: changed!.root.identity,
    });

    const cancelled = scripted(["q"]);
    await expect(selectSavedSkillsDirectory(cancelled.io, options({ currentSkillsDir: second }))).resolves.toBeNull();
    expect(cancelled.prompts).toHaveLength(1);
    expect(await readFile(configPath(), "utf8")).toBe(saved);

    const notDirectory = path.join(home, "not-a-directory");
    await writeFile(notDirectory, "file sentinel");
    const failed = scripted(["6", notDirectory, "q"]);
    await expect(selectSavedSkillsDirectory(failed.io, options({ currentSkillsDir: second }))).resolves.toBeNull();
    expect(await readFile(configPath(), "utf8")).toBe(saved);
    expect(await readFile(notDirectory, "utf8")).toBe("file sentinel");
    const repeat = scripted([]);
    await expect(selectSavedSkillsDirectory(repeat.io, options())).resolves.toEqual({
      root: changed!.root, reviewInitialize: false, reviewBackup: false,
    });
    expect(await readFile(path.join(first, "sentinel"), "utf8")).toBe("first unchanged");
    expect(await readFile(path.join(second, "sentinel"), "utf8")).toBe("second unchanged");
  });

  it("requires fresh selection when an existing root is replaced at the same path", async () => {
    const selected = await skills("selected");
    const initial = await saveSelection(selected);
    const saved = await readFile(configPath(), "utf8");
    const original = path.join(home, "original");
    await rename(selected, original);
    await mkdir(selected);
    await writeFile(path.join(selected, "sentinel"), "replacement unchanged");

    const cancelled = scripted(["q"]);
    await expect(selectSavedSkillsDirectory(cancelled.io, options())).resolves.toBeNull();
    expect(cancelled.prompts).toHaveLength(1);
    expect(await readFile(configPath(), "utf8")).toBe(saved);

    const fresh = scripted(["yes", ""]);
    const chosen = await selectSavedSkillsDirectory(fresh.io, options({ explicitSkillsDir: selected }));
    expect(chosen).toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: true, reviewBackup: false,
    });
    expect(fresh.prompts).toHaveLength(2);
    expect(chosen!.root.identity).not.toBe(initial.root.identity);
    expect(JSON.parse(await readFile(configPath(), "utf8")).identity).toBe(chosen!.root.identity);
    expect(await readFile(path.join(original, "sentinel"), "utf8")).toBe("selected unchanged");
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("replacement unchanged");
  });

  it("does not trust a saved identity that differs from the current root", async () => {
    const selected = await skills("selected");
    const chosen = await saveSelection(selected);
    const record = JSON.parse(await readFile(configPath(), "utf8"));
    record.identity = chosen.root.identity === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    const altered = JSON.stringify(record);
    await writeFile(configPath(), altered);
    const restart = scripted(["q"]);
    await expect(selectSavedSkillsDirectory(restart.io, options())).resolves.toBeNull();
    expect(restart.prompts).toHaveLength(1);
    expect(await readFile(configPath(), "utf8")).toBe(altered);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("selected unchanged");
  });

  it("prompts again for a missing root, without creating it or treating a missing selection as authority", async () => {
    const selected = await skills("selected");
    await saveSelection(selected);
    const saved = await readFile(configPath(), "utf8");
    const moved = path.join(home, "moved");
    await rename(selected, moved);
    const cancelled = scripted(["q"]);
    await expect(selectSavedSkillsDirectory(cancelled.io, options())).resolves.toBeNull();
    expect(cancelled.prompts).toHaveLength(1);
    expect(await readFile(configPath(), "utf8")).toBe(saved);

    const missing = scripted(["", ""]);
    await expect(selectSavedSkillsDirectory(missing.io, options({ explicitSkillsDir: selected }))).resolves.toEqual({
      root: { path: selected, identity: null }, reviewInitialize: false, reviewBackup: false,
    });
    expect(missing.prompts).toHaveLength(2);
    const restart = scripted(["q"]);
    await expect(selectSavedSkillsDirectory(restart.io, options())).resolves.toBeNull();
    expect(restart.prompts).toHaveLength(1);
    await expect(lstat(selected)).rejects.toMatchObject({ code: "ENOENT" });
    const afterMissingSelection = await readFile(configPath(), "utf8");
    await mkdir(selected);
    await writeFile(path.join(selected, "sentinel"), "new directory unchanged");
    const appeared = scripted(["q"]);
    await expect(selectSavedSkillsDirectory(appeared.io, options())).resolves.toBeNull();
    expect(appeared.prompts).toHaveLength(1);
    expect(await readFile(configPath(), "utf8")).toBe(afterMissingSelection);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("new directory unchanged");
    expect(await readFile(path.join(moved, "sentinel"), "utf8")).toBe("selected unchanged");
  });

  it("requires fresh confirmation after a saved symlink is retargeted, even for its former canonical path", async () => {
    const first = await skills("first");
    const second = await skills("second");
    const alias = path.join(home, "alias");
    await symlink(first, alias);
    const setup = scripted(["yes", "", ""]);
    await selectSavedSkillsDirectory(setup.io, options({ explicitSkillsDir: alias }));
    const saved = await readFile(configPath(), "utf8");
    await unlink(alias);
    await symlink(second, alias);

    const oldCanonical = scripted(["q"]);
    await expect(selectSavedSkillsDirectory(oldCanonical.io, options({ explicitSkillsDir: first }))).resolves.toBeNull();
    expect(oldCanonical.prompts.length).toBeGreaterThan(0);
    expect(await readFile(configPath(), "utf8")).toBe(saved);

    const fresh = scripted(["6", alias, "yes", "yes", ""]);
    const chosen = await selectSavedSkillsDirectory(fresh.io, options());
    expect(chosen).toEqual({
      root: { path: second, identity: expect.any(String) }, reviewInitialize: true, reviewBackup: false,
    });
    expect(fresh.prompts).toHaveLength(5);
    expect(fresh.prompts.some((prompt) => /resolved target/i.test(prompt))).toBe(true);
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({
      kind: "skills-manager-setup", version: 1, selectedPath: alias,
      canonicalRoot: second, identity: chosen!.root.identity,
    });
    expect(await readlink(alias)).toBe(second);
    expect(await readFile(path.join(first, "sentinel"), "utf8")).toBe("first unchanged");
    expect(await readFile(path.join(second, "sentinel"), "utf8")).toBe("second unchanged");
  });

  it("does not overwrite the prior choice if a newly chosen symlink is retargeted during approval", async () => {
    const original = await skills("original");
    const firstTarget = await skills("first-target");
    const secondTarget = await skills("second-target");
    const initial = await saveSelection(original);
    const saved = await readFile(configPath(), "utf8");
    const alias = path.join(home, "alias");
    await symlink(firstTarget, alias);
    const selection = scripted(["6", alias, "yes", "", "", "q"]);
    const ask = selection.io.ask;
    let retargeted = false;
    selection.io.ask = async (prompt) => {
      if (!retargeted && /resolved target/i.test(prompt)) {
        await unlink(alias);
        await symlink(secondTarget, alias);
        retargeted = true;
      }
      return ask(prompt);
    };
    await expect(selectSavedSkillsDirectory(selection.io, options({ currentSkillsDir: original }))).resolves.toBeNull();
    expect(retargeted).toBe(true);
    expect(selection.prompts.at(-1)).toMatch(/choos/i);
    expect(await readFile(configPath(), "utf8")).toBe(saved);
    expect(await readlink(alias)).toBe(secondTarget);
    const restart = scripted([]);
    await expect(selectSavedSkillsDirectory(restart.io, options())).resolves.toEqual(initial);
    expect(await readFile(path.join(original, "sentinel"), "utf8")).toBe("original unchanged");
    expect(await readFile(path.join(firstTarget, "sentinel"), "utf8")).toBe("first-target unchanged");
    expect(await readFile(path.join(secondTarget, "sentinel"), "utf8")).toBe("second-target unchanged");
  });
});

describe("unsafe or overlapping startup configuration", () => {
  it.each([
    ["malformed", "{not JSON\n"],
    ["unrelated", '{"kind":"another-application","sentinel":"preserve"}\n'],
    ["unsupported version", '{"kind":"skills-manager-setup","version":99,"sentinel":"preserve"}\n'],
    ["invalid setup", '{"kind":"skills-manager-setup","version":1,"selectedPath":17,"canonicalRoot":null,"identity":false}\n'],
  ])("warns, allows browsing, and does not overwrite %s configuration", async (_label, contents) => {
    const selected = await skills("selected");
    const file = configPath();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, contents, { mode: 0o600 });
    const before = await lstat(file);
    const session = scripted(["6", selected, "", ""]);
    await expect(selectSavedSkillsDirectory(session.io, options())).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false, reviewBackup: false,
    });
    expect(session.prompts).toHaveLength(4);
    expectConfigWarning(session.output);
    expect(await readFile(file, "utf8")).toBe(contents);
    expect((await lstat(file)).ino).toBe(before.ino);
    expect(await readdir(selected)).toEqual(["sentinel"]);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("selected unchanged");
  });

  it.each(["invalid UTF-8", "oversized"])("preserves %s configuration byte for byte", async (kind) => {
    const first = await skills("first");
    const second = await skills("second");
    await saveSelection(first);
    const file = configPath();
    const stored = await readFile(file);
    let contents: Buffer;
    if (kind === "invalid UTF-8") {
      const record = JSON.parse(stored.toString("utf8"));
      record.selectedPath = `${home}/missing-\uFFFD`;
      const encoded = Buffer.from(JSON.stringify(record));
      const marker = Buffer.from("\uFFFD");
      const offset = encoded.indexOf(marker);
      expect(offset).toBeGreaterThanOrEqual(0);
      contents = Buffer.concat([encoded.subarray(0, offset), Buffer.from([0xff]), encoded.subarray(offset + marker.length)]);
    } else {
      contents = Buffer.concat([stored, Buffer.alloc(8 * 1024 * 1024, 0x20)]);
    }
    await writeFile(file, contents);
    const before = await lstat(file);
    const session = scripted(["6", second, "", ""]);
    await expect(selectSavedSkillsDirectory(session.io, options())).resolves.toEqual({
      root: { path: second, identity: expect.any(String) }, reviewInitialize: false, reviewBackup: false,
    });
    expect(session.prompts).toHaveLength(4);
    expectConfigWarning(session.output);
    expect((await readFile(file)).equals(contents)).toBe(true);
    expect((await lstat(file)).ino).toBe(before.ino);
    expect(await readFile(path.join(first, "sentinel"), "utf8")).toBe("first unchanged");
    expect(await readFile(path.join(second, "sentinel"), "utf8")).toBe("second unchanged");
  });

  it.each([
    "symlinked file",
    "hard-linked file",
    "world-writable file",
    "symlinked application directory",
    "world-writable application directory",
  ])("does not reuse or replace an otherwise valid %s", async (kind) => {
    const first = await skills("first");
    const second = await skills("second");
    await saveSelection(first);
    const file = configPath();
    const directory = path.dirname(file);
    const stored = await readFile(file, "utf8");
    const target = path.join(home, "config-target");
    if (kind === "symlinked file") {
      await rename(file, target);
      await symlink(target, file);
    } else if (kind === "hard-linked file") {
      await link(file, target);
    } else if (kind === "world-writable file") {
      await chmod(file, 0o666);
    } else if (kind === "symlinked application directory") {
      await rename(directory, target);
      await symlink(target, directory);
    } else {
      await chmod(directory, 0o777);
    }
    const beforeFile = await lstat(file);
    const beforeDirectory = await lstat(directory);
    const session = scripted(["6", second, "", ""]);
    await expect(selectSavedSkillsDirectory(session.io, options())).resolves.toEqual({
      root: { path: second, identity: expect.any(String) }, reviewInitialize: false, reviewBackup: false,
    });
    expect(session.prompts).toHaveLength(4);
    expectConfigWarning(session.output);
    expect(await readFile(file, "utf8")).toBe(stored);
    const afterFile = await lstat(file);
    const afterDirectory = await lstat(directory);
    expect([afterFile.dev, afterFile.ino, afterFile.mode, afterFile.nlink]).toEqual([
      beforeFile.dev, beforeFile.ino, beforeFile.mode, beforeFile.nlink,
    ]);
    expect([afterDirectory.dev, afterDirectory.ino, afterDirectory.mode]).toEqual([
      beforeDirectory.dev, beforeDirectory.ino, beforeDirectory.mode,
    ]);
    if (kind === "symlinked file") {
      expect(await readlink(file)).toBe(target);
      expect(await readFile(target, "utf8")).toBe(stored);
    } else if (kind === "hard-linked file") {
      expect(beforeFile.nlink).toBe(2);
      expect(await readFile(target, "utf8")).toBe(stored);
    } else if (kind === "symlinked application directory") {
      expect(await readlink(directory)).toBe(target);
      expect(await readFile(path.join(target, "config.json"), "utf8")).toBe(stored);
    }
    expect(await readdir(directory)).toEqual(["config.json"]);
    expect(await readFile(path.join(first, "sentinel"), "utf8")).toBe("first unchanged");
    expect(await readFile(path.join(second, "sentinel"), "utf8")).toBe("second unchanged");
  });

  it("does not create configuration lexically inside the selected root", async () => {
    const selected = await skills("selected");
    vi.stubEnv("XDG_CONFIG_HOME", selected);
    const session = scripted(["", ""]);
    await expect(selectSavedSkillsDirectory(session.io, options({ explicitSkillsDir: selected }))).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false, reviewBackup: false,
    });
    expectConfigWarning(session.output);
    await expect(lstat(path.join(selected, "skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(selected)).toEqual(["sentinel"]);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("selected unchanged");
  });

  it("does not reuse or overwrite existing configuration inside the selected root", async () => {
    const selected = await skills("selected");
    await saveSelection(selected);
    const contents = await readFile(configPath(), "utf8");
    const directory = path.join(selected, "skills-manager");
    const inside = path.join(directory, "config.json");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(inside, contents, { mode: 0o600 });
    const before = await lstat(inside);
    vi.stubEnv("XDG_CONFIG_HOME", selected);
    const session = scripted(["6", selected, "", ""]);
    await expect(selectSavedSkillsDirectory(session.io, options())).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false, reviewBackup: false,
    });
    expect(session.prompts).toHaveLength(4);
    expectConfigWarning(session.output);
    expect(await readFile(inside, "utf8")).toBe(contents);
    expect((await lstat(inside)).ino).toBe(before.ino);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("selected unchanged");
  });

  it("does not create configuration physically inside the root through an XDG symlink", async () => {
    const selected = await skills("selected");
    const alias = path.join(home, "config-alias");
    await symlink(selected, alias);
    vi.stubEnv("XDG_CONFIG_HOME", alias);
    const session = scripted(["", ""]);
    await expect(selectSavedSkillsDirectory(session.io, options({ explicitSkillsDir: selected }))).resolves.toEqual({
      root: { path: selected, identity: expect.any(String) }, reviewInitialize: false, reviewBackup: false,
    });
    expectConfigWarning(session.output);
    expect(await readlink(alias)).toBe(selected);
    await expect(lstat(path.join(selected, "skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(selected)).toEqual(["sentinel"]);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("selected unchanged");
  });

  it("allows an outside configuration directory sharing a lexical prefix with the root", async () => {
    const selected = await skills("selected");
    const outside = path.join(home, "selected-config");
    vi.stubEnv("XDG_CONFIG_HOME", outside);
    const session = scripted(["", ""]);
    const result = await selectSavedSkillsDirectory(session.io, options({ explicitSkillsDir: selected }));
    expect(result!.root.path).toBe(selected);
    const record = JSON.parse(await readFile(path.join(outside, "skills-manager", "config.json"), "utf8"));
    expect(record.selectedPath).toBe(selected);
    expect(record.canonicalRoot).toBe(selected);
    expect(record.identity).toBe(result!.root.identity);
    expect(await readdir(selected)).toEqual(["sentinel"]);
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("selected unchanged");
  });
});

describe("startup configuration location", () => {
  it.each([undefined, ""])("uses the supplied home when XDG_CONFIG_HOME is %s", async (value) => {
    vi.stubEnv("XDG_CONFIG_HOME", value);
    const workspace = path.join(home, "workspace");
    const selected = await skills("workspace/skills");
    const session = scripted(["", ""]);
    const result = await selectSavedSkillsDirectory(session.io, options({ cwd: workspace, explicitSkillsDir: "skills" }));
    expect(result!.root.path).toBe(selected);
    expect(JSON.parse(await readFile(path.join(home, ".config", "skills-manager", "config.json"), "utf8"))).toEqual({
      kind: "skills-manager-setup", version: 1, selectedPath: selected,
      canonicalRoot: selected, identity: result!.root.identity,
    });
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("workspace/skills unchanged");
  });

  it("ignores a relative XDG_CONFIG_HOME instead of saving there", async () => {
    // If incorrectly interpreted relative to cwd, the XDG destination is
    // still inside the isolated fixture, but outside the app installation.
    const relativeXdg = path.relative(process.cwd(), home);
    expect(path.isAbsolute(relativeXdg)).toBe(false);
    vi.stubEnv("XDG_CONFIG_HOME", relativeXdg);
    const selected = await skills("workspace/skills");
    const session = scripted(["", ""]);
    const result = await selectSavedSkillsDirectory(session.io, options({
      cwd: path.join(home, "workspace"), explicitSkillsDir: "skills",
    }));
    expect(result!.root.path).toBe(selected);
    expect(JSON.parse(await readFile(path.join(home, ".config", "skills-manager", "config.json"), "utf8"))).toEqual({
      kind: "skills-manager-setup", version: 1, selectedPath: selected,
      canonicalRoot: selected, identity: result!.root.identity,
    });
    await expect(lstat(path.join(home, "skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(selected, "sentinel"), "utf8")).toBe("workspace/skills unchanged");
  });
});
