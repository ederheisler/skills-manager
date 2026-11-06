import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareUpdateHandoff, resolveGlobalUpdate, resolveUpdateRegistry, type PreparedUpdateHandoff } from "../../src/actions/appUpdateHandoff.js";
import type { BuildIdentity } from "../../src/state/appBuild.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const cleanBuild: BuildIdentity = { version: "0.1.0", commit, dirty: false, source: "git" };
const originalEnv = { ...process.env };
let base: string;
let skills: string;
let marker: string;
let prefix: string;
let installation: { prefix: string; mode: "install" | "update" };
const prepared: PreparedUpdateHandoff[] = [];

async function existingGlobalApp(): Promise<{ app: string; bin: string }> {
  const app = path.join(prefix, "lib", "node_modules", "skills-manager");
  const bin = path.join(prefix, "bin", "skills-manager");
  await mkdir(path.join(app, "dist", "actions"), { recursive: true });
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(path.join(app, "package.json"), JSON.stringify({
    name: "skills-manager", type: "module", bin: { "skills-manager": "./dist/cli.js" },
  }));
  await writeFile(path.join(app, "dist", "cli.js"), "// installed app\n");
  await symlink("../lib/node_modules/skills-manager/dist/cli.js", bin);
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  for (const [source, destination] of [
    ["src/actions/appUpdateHandoff.ts", "dist/actions/appUpdateHandoff.js"],
    ["src/actions/appUpdateWorker.ts", "dist/actions/appUpdateWorker.js"],
    ["src/terminalText.ts", "dist/terminalText.js"],
  ]) {
    const output = ts.transpileModule(await readFile(path.join(repository, source), "utf8"), {
      fileName: source, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await writeFile(path.join(app, destination), output);
  }
  return { app, bin };
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-update-preparation-")));
  skills = path.join(base, "skills with ' spaces");
  const bin = path.join(base, "bin");
  const cache = path.join(base, "existing-npm-cache");
  marker = path.join(base, "unexpected-install");
  prefix = path.join(base, "global-prefix");
  installation = { prefix, mode: "install" };
  await Promise.all([mkdir(skills), mkdir(bin), mkdir(cache), mkdir(prefix)]);
  const npm = path.join(bin, "npm");
  await writeFile(npm, `#!/bin/sh
if [ "$TEST_UPDATE_HANG" = 1 ]; then /bin/sleep 60; fi
case "$1:$2:$3" in
  config:get:registry) printf '%s\\n' "$TEST_UPDATE_REGISTRY" ;;
  config:get:prefix)
    [ "$4" = "--cache" ] && [ "$5" = "/dev/null" ] && [ "$6" = "--logs-dir" ] \
      && [ "$7" = "/dev/null" ] && [ "$8" = "--global" ] || exit 1
    printf '%s\\n' "$TEST_UPDATE_PREFIX" ;;
  config:list:--long) printf '%s\\n' '; "env" config from environment' "; cache = $TEST_UPDATE_CACHE_JSON ; overridden by cli" ;;
  *) printf 'unexpected install\\n' > "$TEST_UPDATE_MARKER"; exit 1 ;;
esac
`);
  await chmod(npm, 0o700);
  for (const name of Object.keys(process.env)) {
    if (/^npm_config_(?:registry|prefix)$/i.test(name)) delete process.env[name];
  }
  process.env.PATH = `${bin}${path.delimiter}${originalEnv.PATH ?? ""}`;
  process.env.TEST_UPDATE_REGISTRY = "https://user:secret@registry.example.invalid/custom/";
  process.env.TEST_UPDATE_CACHE_JSON = JSON.stringify(cache);
  process.env.TEST_UPDATE_MARKER = marker;
  process.env.TEST_UPDATE_PREFIX = prefix;
  process.env.npm_config_prefix = prefix;
});

afterEach(async () => {
  for (const item of prepared.splice(0)) await item.cleanup().catch(() => {});
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await rm(base, { recursive: true, force: true });
});

describe("software update handoff preparation", () => {
  it("resolves the configured global prefix without installing and canonicalizes an alias", async () => {
    const alias = path.join(base, "prefix-link");
    await symlink(prefix, alias, "dir");
    process.env.TEST_UPDATE_PREFIX = alias;
    await expect(resolveGlobalUpdate()).resolves.toEqual({ prefix, mode: "install" });
    expect(await readdir(prefix)).toEqual([]);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the npm entry name for a multicall executable during queries and handoff", async () => {
    const npm = path.join(base, "bin", "npm");
    const multicall = path.join(base, "bin", "multicall");
    const source = await readFile(npm, "utf8");
    await rename(npm, multicall);
    await writeFile(multicall, source.replace("#!/bin/sh\n", '#!/bin/sh\ncase "$0" in */npm) ;; *) exit 1 ;; esac\n'));
    await symlink("multicall", npm);
    const reviewed = await resolveGlobalUpdate();
    expect(reviewed).toEqual({ prefix, mode: "install" });
    expect(await resolveUpdateRegistry()).toBe(process.env.TEST_UPDATE_REGISTRY);
    const item = await prepareUpdateHandoff({
      target: "all", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation: reviewed,
    });
    prepared.push(item);
    expect(item.args[1]).toBe(npm);
    expect(item.args[1]).not.toBe(await realpath(npm));
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes an existing global app and records package and bin identities", async () => {
    const { app, bin } = await existingGlobalApp();
    // Import the module from this installed package so its import.meta.url identifies the running app.
    const updater = await import(pathToFileURL(path.join(app, "dist", "actions", "appUpdateHandoff.js")).href) as {
      resolveGlobalUpdate: typeof resolveGlobalUpdate; prepareUpdateHandoff: typeof prepareUpdateHandoff;
    };
    const reviewed = await updater.resolveGlobalUpdate();
    expect(reviewed).toEqual({ prefix, mode: "update" });
    const item = await updater.prepareUpdateHandoff({
      target: "cli", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation: reviewed,
    });
    prepared.push(item);
    const appIdentity = await lstat(app, { bigint: true });
    const binIdentity = await lstat(bin, { bigint: true });
    expect(item.args).toEqual([item.workspace, await realpath(path.join(base, "bin", "npm")), "cli", commit, skills, prefix, "update"]);
    expect(item.env.SKILLS_MANAGER_UPDATE_PACKAGE_ID).toBe(`${appIdentity.dev}:${appIdentity.ino}`);
    expect(item.env.SKILLS_MANAGER_UPDATE_BIN_ID).toBe(`${binIdentity.dev}:${binIdentity.ino}`);
    expect(item.env.SKILLS_MANAGER_UPDATE_EXECUTABLE).toBe(path.join(app, "dist", "cli.js"));
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a different global app when launched from a checkout", async () => {
    const { app, bin } = await existingGlobalApp();
    await expect(resolveGlobalUpdate()).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(app, "package.json"), "utf8")).name).toBe("skills-manager");
    expect((await lstat(bin)).isSymbolicLink()).toBe(true);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a changed npm prefix after review without creating a workspace", async () => {
    const reviewed = await resolveGlobalUpdate();
    const otherPrefix = path.join(base, "other-prefix");
    const temp = path.join(base, "reviewed-temp");
    await Promise.all([mkdir(otherPrefix), mkdir(temp)]);
    process.env.TMPDIR = temp;
    process.env.TEST_UPDATE_PREFIX = otherPrefix;
    await expect(prepareUpdateHandoff({
      target: "all", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation: reviewed,
    })).rejects.toThrow();
    expect(await readdir(temp)).toEqual([]);
    expect(await readdir(prefix)).toEqual([]);
    expect(await readdir(otherPrefix)).toEqual([]);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unrelated bin that appears after approval without changing it", async () => {
    const reviewed = await resolveGlobalUpdate();
    const temp = path.join(base, "reviewed-temp");
    const bin = path.join(prefix, "bin", "skills-manager");
    await Promise.all([mkdir(temp), mkdir(path.dirname(bin), { recursive: true })]);
    await writeFile(bin, "unrelated bin");
    process.env.TMPDIR = temp;
    await expect(prepareUpdateHandoff({
      target: "all", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation: reviewed,
    })).rejects.toThrow();
    expect(await readFile(bin, "utf8")).toBe("unrelated bin");
    expect(await readdir(temp)).toEqual([]);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["package", "bin"] as const)("refuses a preexisting unrelated global %s without writing to it", async (entry) => {
    const target = entry === "package"
      ? path.join(prefix, "lib", "node_modules", "skills-manager")
      : path.join(prefix, "bin", "skills-manager");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "unrelated data");
    await expect(resolveGlobalUpdate()).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("unrelated data");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["package", "bin"] as const)("refuses a global %s symlink into a checkout without modifying its target", async (entry) => {
    const checkout = path.join(base, "checkout");
    const target = entry === "package"
      ? path.join(prefix, "lib", "node_modules", "skills-manager")
      : path.join(prefix, "bin", "skills-manager");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    await writeFile(path.join(checkout, "sentinel"), "checkout unchanged");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(entry === "package" ? checkout : path.join(checkout, "sentinel"), target);
    await expect(resolveGlobalUpdate()).rejects.toThrow();
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(checkout, "sentinel"), "utf8")).toBe("checkout unchanged");
    expect(await readdir(checkout)).toEqual([".git", "sentinel"]);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves the real configured registry without discarding credentials needed by npm", async () => {
    await expect(resolveUpdateRegistry()).resolves.toBe("https://user:secret@registry.example.invalid/custom/");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves protected registry environment overrides using npm's precedence", async () => {
    process.env.PATH = originalEnv.PATH ?? "/usr/bin:/bin";
    process.env.NPM_CONFIG_REGISTRY = "https://first:first-secret@first.example.invalid/";
    process.env.npm_config_registry = "https://second:second-secret@second.example.invalid/private/";
    await expect(resolveUpdateRegistry()).resolves.toBe("https://second:second-secret@second.example.invalid/private/");
    process.env.npm_config_registry = "";
    await expect(resolveUpdateRegistry()).resolves.toBe("https://first:first-secret@first.example.invalid/");
    process.env.npm_config_registry = "https://plain.example.invalid/";
    await expect(resolveUpdateRegistry()).resolves.toBe("https://plain.example.invalid/");
  }, 15000);

  it("fails closed without exposing protected credentials from npmrc", async () => {
    const userConfig = path.join(base, "protected.npmrc");
    await writeFile(userConfig, "registry=https://config-user:config-secret@registry.example.invalid/private/\n");
    process.env.PATH = originalEnv.PATH ?? "/usr/bin:/bin";
    process.env.npm_config_userconfig = userConfig;
    process.env.npm_config_globalconfig = path.join(base, "no-global-npmrc");
    const error = await resolveUpdateRegistry().then(() => "", (failure: Error) => failure.message);
    expect(error).toMatch(/could not determine the npm registry/i);
    expect(error).not.toMatch(/config-user|config-secret|private/);
  }, 15000);

  it("queries actual npm without creating home, XDG, shared-cache, or leftover temp state", async () => {
    const home = path.join(base, "empty-home");
    const temp = path.join(base, "query-temp");
    const xdg = path.join(base, "xdg-cache");
    const sharedCache = path.join(base, "shared-cache");
    await Promise.all([mkdir(home), mkdir(temp)]);
    for (const name of Object.keys(process.env)) {
      if (/^npm_config_(?:registry|cache|logs_dir|userconfig|globalconfig)$/i.test(name)) delete process.env[name];
    }
    process.env.PATH = originalEnv.PATH ?? "/usr/bin:/bin";
    process.env.HOME = home;
    process.env.TMPDIR = temp;
    process.env.XDG_CACHE_HOME = xdg;
    process.env.NODE_COMPILE_CACHE = path.join(skills, "node-compile-cache");
    process.env.NODE_DISABLE_COMPILE_CACHE = "0";
    process.env.npm_config_registry = "https://registry.example.invalid/private/";
    process.env.npm_config_cache = sharedCache;
    process.env.npm_config_userconfig = path.join(base, "no-user-npmrc");
    process.env.npm_config_globalconfig = path.join(base, "no-global-npmrc");
    await expect(resolveUpdateRegistry()).resolves.toBe("https://registry.example.invalid/private/");
    await expect(resolveGlobalUpdate()).resolves.toEqual({ prefix, mode: "install" });
    expect(await readdir(home)).toEqual([]);
    expect(await readdir(temp)).toEqual([]);
    expect(await readdir(skills)).toEqual([]);
    await expect(lstat(xdg)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(sharedCache)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);

  it("honors a user npmrc cache when TMPDIR points inside that cache", async () => {
    const home = path.join(base, "home-with-npmrc");
    const cache = path.join(base, "npmrc-cache");
    await Promise.all([mkdir(home), mkdir(cache)]);
    const userConfig = path.join(home, ".npmrc");
    const contents = `registry=https://registry.example.invalid/private/\ncache=${JSON.stringify(cache)}\n`;
    await writeFile(userConfig, contents);
    for (const name of Object.keys(process.env)) {
      if (/^npm_config_/i.test(name)) delete process.env[name];
    }
    process.env.PATH = originalEnv.PATH ?? "/usr/bin:/bin";
    process.env.HOME = home;
    process.env.TMPDIR = cache;
    process.env.NODE_COMPILE_CACHE = path.join(skills, "node-compile-cache");
    process.env.NODE_DISABLE_COMPILE_CACHE = "0";
    process.env.npm_config_userconfig = userConfig;
    process.env.npm_config_globalconfig = path.join(base, "no-global-npmrc");
    process.env.npm_config_prefix = prefix;
    const item = await prepareUpdateHandoff({
      target: "all", skillsDir: skills, build: cleanBuild, registry: "https://registry.example.invalid/private/", installation,
    });
    prepared.push(item);
    expect(path.relative(cache, item.workspace)).toMatch(/^\.\./);
    expect(await readdir(cache)).toEqual([]);
    expect(await readdir(skills)).toEqual([]);
    expect(item.env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(await readFile(userConfig, "utf8")).toBe(contents);
    expect(await readdir(home)).toEqual([".npmrc"]);
  }, 15000);

  it("terminates a stalled npm query without writing temporary state", async () => {
    const temp = path.join(base, "query-temp");
    await mkdir(temp);
    process.env.TMPDIR = temp;
    process.env.TEST_UPDATE_HANG = "1";
    await expect(resolveUpdateRegistry()).rejects.toThrow(/could not determine the npm registry/i);
    expect(await readdir(temp)).toEqual([]);
  }, 15000);

  it("rejects ambiguous registry URLs without exposing their credentials", async () => {
    process.env.TEST_UPDATE_REGISTRY = "https://user:secret@registry.example.invalid/path/?token=private";
    const error = await resolveUpdateRegistry().then(() => "", (failure: Error) => failure.message);
    expect(error).toMatch(/registry/i);
    expect(error).not.toMatch(/secret|private|token/);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a changed registry scope before creating an update workspace", async () => {
    const reviewed = process.env.TEST_UPDATE_REGISTRY!;
    const temp = path.join(base, "reviewed-temp");
    await mkdir(temp);
    process.env.TMPDIR = temp;
    process.env.TEST_UPDATE_REGISTRY = "https://other.example.invalid/custom/";
    await expect(prepareUpdateHandoff({ target: "all", skillsDir: skills, build: cleanBuild, registry: reviewed, installation }))
      .rejects.toThrow(/registry changed since approval/i);
    expect(await readdir(temp)).toEqual([]);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the same registry scope when only credentials and a trailing slash differ", async () => {
    const reviewed = process.env.TEST_UPDATE_REGISTRY!;
    process.env.TEST_UPDATE_REGISTRY = "https://new-user:new-secret@registry.example.invalid/custom";
    const item = await prepareUpdateHandoff({ target: "all", skillsDir: skills, build: cleanBuild, registry: reviewed, installation });
    prepared.push(item);
    expect(item.env.SKILLS_MANAGER_UPDATE_REGISTRY).toBe(reviewed);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies an independent private helper without starting an install and preserves a clean app commit", async () => {
    process.env.NODE_COMPILE_CACHE = path.join(skills, "node-compile-cache");
    process.env.NODE_DISABLE_COMPILE_CACHE = "0";
    const item = await prepareUpdateHandoff({ target: "cli", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation });
    prepared.push(item);
    expect(item.args).toEqual([item.workspace, await realpath(path.join(base, "bin", "npm")), "cli", commit, skills, prefix, "install"]);
    expect(path.dirname(item.helperPath)).toBe(item.workspace);
    expect((await lstat(item.workspace)).mode & 0o777).toBe(0o700);
    expect((await lstat(item.helperPath)).isFile()).toBe(true);
    expect(path.relative(skills, item.workspace)).toMatch(/^\.\./);
    expect(item.env.SKILLS_MANAGER_UPDATE_REGISTRY).toBe(process.env.TEST_UPDATE_REGISTRY);
    expect(item.env.SKILLS_MANAGER_UPDATE_PACKAGE_ID).toBe("absent");
    expect(item.env.SKILLS_MANAGER_UPDATE_BIN_ID).toBe("absent");
    expect(item.env.SKILLS_MANAGER_UPDATE_EXECUTABLE).toBe("");
    expect(item.env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(item.env.NODE_COMPILE_CACHE).toBe(process.env.NODE_COMPILE_CACHE);
    expect(await readdir(skills)).toEqual([]);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await item.cleanup();
    await item.cleanup();
    await expect(lstat(item.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes the resolved selected root even if its original symlink changes", async () => {
    const link = path.join(base, "selected-link");
    const other = path.join(base, "other");
    await mkdir(other);
    await symlink(skills, link, "dir");
    const item = await prepareUpdateHandoff({ target: "all", skillsDir: link, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation });
    prepared.push(item);
    await unlink(link);
    await symlink(other, link, "dir");
    expect(item.args[4]).toBe(skills);
    expect(item.args[4]).not.toBe(await realpath(link));
  });

  it("requires explicit consent to switch a dirty or unknown CLI-only build to main", async () => {
    for (const build of [
      { ...cleanBuild, dirty: true },
      { ...cleanBuild, source: "unknown" as const, commit: null },
    ]) {
      await expect(prepareUpdateHandoff({ target: "cli", skillsDir: skills, build, registry: process.env.TEST_UPDATE_REGISTRY!, installation }))
        .rejects.toThrow(/explicitly choose switch to main/i);
      const item = await prepareUpdateHandoff({ target: "cli", skillsDir: skills, build, registry: process.env.TEST_UPDATE_REGISTRY!, installation, allowSwitchToMain: true });
      prepared.push(item);
      expect(item.args[3]).toBe("main");
    }
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create the helper inside the selected skills tree, even when it is TMPDIR", async () => {
    process.env.TMPDIR = skills;
    const item = await prepareUpdateHandoff({ target: "all", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation });
    prepared.push(item);
    expect(item.args[3]).toBe("main");
    expect(path.relative(skills, item.workspace)).toMatch(/^\.\./);
    expect(await readdir(skills)).toEqual([]);
  });

  it("also avoids skills roots selected earlier in the session", async () => {
    const previous = path.join(base, "previous skills");
    await mkdir(previous);
    process.env.TMPDIR = previous;
    const item = await prepareUpdateHandoff({
      target: "all", skillsDir: skills, build: cleanBuild,
      registry: process.env.TEST_UPDATE_REGISTRY!, excludedRoots: [previous], installation,
    });
    prepared.push(item);
    expect(path.relative(previous, item.workspace)).toMatch(/^\.\./);
    expect(await readdir(previous)).toEqual([]);
  });

  it("avoids a different checkout when TMPDIR points inside it", async () => {
    const checkout = path.join(base, "other-checkout");
    const temp = path.join(checkout, "temp");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    await mkdir(temp);
    process.env.TMPDIR = temp;
    const item = await prepareUpdateHandoff({ target: "all", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation });
    prepared.push(item);
    expect(path.relative(checkout, item.workspace)).toMatch(/^\.\./);
    expect(await readdir(temp)).toEqual([]);
  });

  it("refuses to remove a replaced workspace and leaves the replacement untouched", async () => {
    const item = await prepareUpdateHandoff({ target: "all", skillsDir: skills, build: cleanBuild, registry: process.env.TEST_UPDATE_REGISTRY!, installation });
    prepared.push(item);
    const saved = `${item.workspace}-saved`;
    await rename(item.workspace, saved);
    try {
      await mkdir(item.workspace);
      await writeFile(path.join(item.workspace, "sentinel"), "unrelated data");
      await expect(item.cleanup()).rejects.toThrow(/identity changed/i);
      expect(await readFile(path.join(item.workspace, "sentinel"), "utf8")).toBe("unrelated data");
    } finally {
      await rm(item.workspace, { recursive: true, force: true });
      await rename(saved, item.workspace);
    }
    await item.cleanup();
  });
});
