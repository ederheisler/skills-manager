import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants as moduleConstants } from "node:module";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const updateFixtures: string[] = [];
const updateProcesses = new Set<ChildProcess>();
const updateWatchers = new Set<FSWatcher>();
const updateSurvivors = new Set<string>();
const registry = "https://update-user:update-secret@registry.example.invalid/";

type WorkerResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type WorkerFixture = {
  base: string;
  workspace: string;
  skillsDir: string;
  npm: string;
  modules: string;
  record: string;
  launch: string;
  release: string;
  signal: string;
  done: string;
  descendantReady: string;
  descendantSignal: string;
  descendantReaped: string;
  survivorReady: string;
  survivorDone: string;
  device: string;
  inode: string;
};

async function transpiled(relative: string): Promise<string> {
  const source = await readFile(path.join(repository, relative), "utf8");
  return ts.transpileModule(source, {
    fileName: relative,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const fakeNpm = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const env = process.env;
const compileCache = env.SM_TEST_ENABLE_COMPILE_CACHE === "1" ? require("node:module").enableCompileCache() : undefined;
const configs = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase().startsWith("npm_config_")));
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const cache = env.npm_config_cache;
fs.writeFileSync(env.SM_TEST_RECORD, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), manifest, configs,
  home: env.HOME, projectMode: fs.statSync(".").mode & 0o777,
  cacheMode: fs.statSync(cache).mode & 0o777,
  temporary: env.TMPDIR, tmp: env.TMP, temp: env.TEMP,
  temporaryMode: fs.statSync(env.TMPDIR).mode & 0o777,
  privateEnvExposed: ["SKILLS_MANAGER_UPDATE_REGISTRY", "SKILLS_MANAGER_UPDATE_DEVICE", "SKILLS_MANAGER_UPDATE_INODE"].some((key) => key in env),
  ...(compileCache ? { compileCacheStatus: compileCache.status } : {}),
  hadLockfile: fs.existsSync("package-lock.json"),
}));
process.stdout.write("UNTRUSTED " + env.npm_config_registry + "\\x1b[31m\\n");
process.stderr.write("UNTRUSTED " + env.npm_config_registry + "\\x1b[31m\\n");
if (env.SM_TEST_NPM_MODE === "failure") process.exit(23);
if (env.SM_TEST_NPM_MODE === "hold") {
  let interrupted = false;
  const finish = () => {
    if (interrupted && fs.existsSync(env.SM_TEST_RELEASE)) {
      fs.writeFileSync(env.SM_TEST_DONE, "done");
      process.exit(0);
    }
  };
  fs.watch(path.dirname(env.SM_TEST_RELEASE), finish);
  process.on("SIGTERM", () => {
    interrupted = true;
    fs.writeFileSync(env.SM_TEST_SIGNAL + ".tmp", "SIGTERM");
    fs.renameSync(env.SM_TEST_SIGNAL + ".tmp", env.SM_TEST_SIGNAL);
    finish();
  });
  const descendant = spawn(process.execPath, [env.SM_TEST_DESCENDANT], { stdio: "ignore" });
  descendant.once("exit", () => {
    fs.writeFileSync(env.SM_TEST_DESC_REAPED + ".tmp", "reaped");
    fs.renameSync(env.SM_TEST_DESC_REAPED + ".tmp", env.SM_TEST_DESC_REAPED);
  });
} else {
  fs.cpSync(env.SM_TEST_MODULES, path.join(process.cwd(), "node_modules"), { recursive: true });
}
`;

const fakeDescendant = `const fs = require("node:fs");
const path = require("node:path");
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.SM_TEST_DESC_SIGNAL + ".tmp", "SIGTERM");
  fs.renameSync(process.env.SM_TEST_DESC_SIGNAL + ".tmp", process.env.SM_TEST_DESC_SIGNAL);
  process.exit(0);
});
fs.watch(path.dirname(process.env.SM_TEST_DESC_READY), () => {});
fs.writeFileSync(process.env.SM_TEST_DESC_READY, "ready");
`;

const fakeSurvivor = `const fs = require("node:fs");
const path = require("node:path");
const env = process.env;
const finish = () => {
  if (!fs.existsSync(env.SM_TEST_RELEASE)) return;
  let result = "done";
  try { fs.writeFileSync(path.join(env.SM_TEST_WORKSPACE, "survivor-finished"), "finished"); }
  catch { result = "workspace unavailable"; }
  fs.writeFileSync(env.SM_TEST_SURVIVOR_DONE + ".tmp", result);
  fs.renameSync(env.SM_TEST_SURVIVOR_DONE + ".tmp", env.SM_TEST_SURVIVOR_DONE);
  process.exit(0);
};
fs.watch(path.dirname(env.SM_TEST_RELEASE), finish);
fs.writeFileSync(path.join(env.SM_TEST_WORKSPACE, "survivor-active"), "active");
fs.writeFileSync(env.SM_TEST_SURVIVOR_READY + ".tmp", "ready");
fs.renameSync(env.SM_TEST_SURVIVOR_READY + ".tmp", env.SM_TEST_SURVIVOR_READY);
finish();
`;

const fakeApp = `import { existsSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { enableCompileCache } from "node:module";
const compileCache = process.env.SM_TEST_ENABLE_COMPILE_CACHE === "1" ? enableCompileCache() : undefined;
let interrupted = false;
if (process.env.SM_TEST_APP_MODE === "hold") {
  const finish = () => {
    if (existsSync(process.env.SM_TEST_RELEASE)) {
      if (interrupted) writeFileSync(process.env.SM_TEST_DONE, "done");
      process.exit(0);
    }
  };
  watch(path.dirname(process.env.SM_TEST_RELEASE), finish);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
    interrupted = true;
    writeFileSync(process.env.SM_TEST_SIGNAL + ".tmp", signal);
    renameSync(process.env.SM_TEST_SIGNAL + ".tmp", process.env.SM_TEST_SIGNAL);
    finish();
  });
}
if (process.env.SM_TEST_APP_MODE === "descendant") {
  const child = spawn(process.execPath, [process.env.SM_TEST_SURVIVOR], { stdio: "ignore" });
  child.unref();
  const finish = () => { if (existsSync(process.env.SM_TEST_SURVIVOR_READY)) process.exit(19); };
  watch(path.dirname(process.env.SM_TEST_SURVIVOR_READY), finish);
  finish();
}
writeFileSync(process.env.SM_TEST_LAUNCH + ".tmp", JSON.stringify({
  args: process.argv.slice(2), workspaceExists: existsSync(process.env.SM_TEST_WORKSPACE),
  privateEnvExposed: ["SKILLS_MANAGER_UPDATE_REGISTRY", "SKILLS_MANAGER_UPDATE_DEVICE", "SKILLS_MANAGER_UPDATE_INODE"].some((key) => key in process.env),
  ...(compileCache ? { compileCacheStatus: compileCache.status } : {}),
}));
renameSync(process.env.SM_TEST_LAUNCH + ".tmp", process.env.SM_TEST_LAUNCH);
if (process.env.SM_TEST_APP_MODE !== "hold" && process.env.SM_TEST_APP_MODE !== "descendant") {
  process.exit(Number(process.env.SM_TEST_APP_EXIT || 0));
}
`;

async function updateFixture(skillsName = "skills ' with spaces", workspaceName = "workspace"): Promise<WorkerFixture> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-app-update-test-")));
  updateFixtures.push(base);
  const workspace = path.join(base, workspaceName);
  const skillsDir = path.join(base, skillsName);
  const modules = path.join(base, "staged-modules");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(skillsDir);
  await writeFile(path.join(skillsDir, "sentinel"), "unchanged");
  await writeFile(path.join(workspace, "app-update-worker.mjs"), await transpiled("src/actions/appUpdateWorker.ts"));
  const identity = await lstat(workspace, { bigint: true });
  const npm = path.join(base, "fake-npm");
  await writeFile(npm, fakeNpm, { mode: 0o700 });
  await writeFile(path.join(base, "descendant.cjs"), fakeDescendant);
  await writeFile(path.join(base, "survivor.cjs"), fakeSurvivor);
  return {
    base, workspace, skillsDir, npm, modules,
    record: path.join(base, "npm-record.json"),
    launch: path.join(base, "launch.json"),
    release: path.join(base, "release"),
    signal: path.join(base, "signal"),
    done: path.join(base, "done"),
    descendantReady: path.join(base, "descendant-ready"),
    descendantSignal: path.join(base, "descendant-signal"),
    descendantReaped: path.join(base, "descendant-reaped"),
    survivorReady: path.join(base, "survivor-ready"),
    survivorDone: path.join(base, "survivor-done"),
    device: identity.dev.toString(), inode: identity.ino.toString(),
  };
}

async function stageRuntime(f: WorkerFixture, options: {
  appName?: string; bin?: unknown; skillsName?: string; nestedSkills?: boolean; missingDependency?: boolean;
} = {}): Promise<void> {
  const app = path.join(f.modules, "skills-manager");
  const skills = path.join(f.modules, "skills");
  await mkdir(path.join(app, "dist", "actions"), { recursive: true });
  await mkdir(path.join(app, "dist", "state"), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(app, "package.json"), JSON.stringify({
    name: options.appName ?? "skills-manager", type: "module",
    bin: options.bin ?? { "skills-manager": "./dist/cli.js" },
  }));
  await writeFile(path.join(app, "dist", "cli.js"), fakeApp);
  // Exercise the installed app's real inspector, not a test replacement.
  await writeFile(path.join(app, "dist", "actions", "sandbox.js"), await transpiled("src/actions/sandbox.ts"));
  await writeFile(path.join(app, "dist", "state", "validation.js"), await transpiled("src/state/validation.ts"));
  await writeFile(path.join(skills, "package.json"), JSON.stringify({
    name: options.skillsName ?? "skills", version: "1.2.3", type: "module", bin: "./cli.js",
    ...(options.missingDependency ? { dependencies: { "missing-package": "1.0.0" } } : {}),
  }));
  await writeFile(path.join(skills, "cli.js"), "export {};\n");
  if (options.nestedSkills) {
    await mkdir(path.join(app, "node_modules"), { recursive: true });
    await cp(skills, path.join(app, "node_modules", "skills"), { recursive: true });
  }
}

function startWorker(f: WorkerFixture, options: {
  target?: "all" | "cli"; revision?: string; npm?: string; device?: string; inode?: string;
  npmMode?: "failure" | "hold"; appMode?: "hold" | "descendant"; appExit?: number; compileCache?: boolean;
} = {}): { child: ChildProcess; result: Promise<WorkerResult> } {
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: f.base,
    TMPDIR: f.skillsDir, TMP: f.skillsDir, TEMP: f.skillsDir,
    SKILLS_MANAGER_UPDATE_REGISTRY: registry,
    SKILLS_MANAGER_UPDATE_DEVICE: options.device ?? f.device,
    SKILLS_MANAGER_UPDATE_INODE: options.inode ?? f.inode,
    npm_config_userconfig: path.join(f.base, "user.npmrc"),
    NPM_CONFIG_REGISTRY: "https://wrong.example.invalid/",
    NPM_CONFIG_CACHE: path.join(f.base, "wrong-cache"),
    NPM_CONFIG_GLOBAL: "true",
    NPM_CONFIG_LOCATION: "global",
    NPM_CONFIG_LOGS_DIR: f.skillsDir,
    NPM_CONFIG_TIMING: "true",
    SM_TEST_RECORD: f.record, SM_TEST_MODULES: f.modules, SM_TEST_LAUNCH: f.launch,
    SM_TEST_WORKSPACE: f.workspace, SM_TEST_RELEASE: f.release,
    SM_TEST_SIGNAL: f.signal, SM_TEST_DONE: f.done,
    SM_TEST_DESCENDANT: path.join(f.base, "descendant.cjs"),
    SM_TEST_DESC_READY: f.descendantReady, SM_TEST_DESC_SIGNAL: f.descendantSignal,
    SM_TEST_DESC_REAPED: f.descendantReaped,
    SM_TEST_SURVIVOR: path.join(f.base, "survivor.cjs"),
    SM_TEST_SURVIVOR_READY: f.survivorReady, SM_TEST_SURVIVOR_DONE: f.survivorDone,
    SM_TEST_NPM_MODE: options.npmMode ?? "success", SM_TEST_APP_MODE: options.appMode ?? "normal",
    SM_TEST_APP_EXIT: String(options.appExit ?? 0),
    ...(options.compileCache ? {
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_COMPILE_CACHE: path.join(f.skillsDir, "node-compile-cache"),
      SM_TEST_ENABLE_COMPILE_CACHE: "1",
    } : {}),
  };
  const child = spawn(process.execPath, [
    path.join(f.workspace, "app-update-worker.mjs"), f.workspace, options.npm ?? f.npm,
    options.target ?? "all", options.revision ?? "main", f.skillsDir,
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  updateProcesses.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const { promise: result, resolve, reject } = Promise.withResolvers<WorkerResult>();
  child.once("error", reject);
  child.once("close", (code, signal) => {
    updateProcesses.delete(child);
    resolve({ code, signal, stdout, stderr });
  });
  return { child, result };
}

async function waitForFile(file: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const watcher = watch(path.dirname(file), () => { void inspect(); });
  updateWatchers.add(watcher);
  const finish = () => { watcher.close(); updateWatchers.delete(watcher); };
  const inspect = async () => {
    try { await lstat(file); finish(); resolve(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { finish(); reject(error); }
    }
  };
  watcher.once("error", (error) => { finish(); reject(error); });
  void inspect();
  return promise;
}

async function expectMissing(file: string): Promise<void> {
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  for (const watcher of updateWatchers) watcher.close();
  updateWatchers.clear();
  await Promise.all(updateFixtures.map((base) => writeFile(path.join(base, "release"), "teardown")));
  const stopping = [...updateProcesses].map((child) => {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    return closed;
  });
  await Promise.all(stopping);
  await Promise.all([...updateSurvivors].map(waitForFile));
  updateSurvivors.clear();
  await Promise.all(updateFixtures.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

describe("isolated application update worker", () => {
  it.each([
    { target: "all" as const, revision: "main" },
    { target: "cli" as const, revision: "0123456789abcdef0123456789abcdef01234567" },
    { target: "cli" as const, revision: "main" },
  ])("installs and launches the approved $target revision $revision in a private project", async ({ target, revision }) => {
    const f = await updateFixture();
    await stageRuntime(f);
    const result = await startWorker(f, { target, revision }).result;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    const install = JSON.parse(await readFile(f.record, "utf8"));
    expect(install.argv).toEqual(["install", "--prefer-online", "--no-audit", "--no-fund"]);
    expect(path.dirname(install.cwd)).toBe(f.workspace);
    expect(install.manifest).toMatchObject({
      private: true,
      dependencies: { "skills-manager": `github:ederheisler/skills-manager#${revision}`, skills: "latest" },
      overrides: { skills: "$skills" },
    });
    expect(install.manifest.scripts).toBeUndefined();
    expect(install.hadLockfile).toBe(false);
    expect(install.projectMode).toBe(0o700);
    expect(install.cacheMode).toBe(0o700);
    expect(path.dirname(install.configs.npm_config_cache)).toBe(f.workspace);
    expect(path.dirname(install.temporary)).toBe(f.workspace);
    expect(install.tmp).toBe(install.temporary);
    expect(install.temp).toBe(install.temporary);
    expect(install.temporaryMode).toBe(0o700);
    expect(install.configs.npm_config_registry).toBe(registry);
    expect(install.configs.npm_config_global).toBe("false");
    expect(install.configs.npm_config_location).toBe("project");
    expect(install.configs.npm_config_loglevel).toBe("silent");
    expect(install.configs.npm_config_logs_max).toBe("0");
    expect(install.configs.npm_config_logs_dir).toBe(path.join(install.configs.npm_config_cache, "_logs"));
    expect(install.configs.npm_config_timing).toBe("false");
    expect(install.configs.npm_config_update_notifier).toBe("false");
    expect(install.privateEnvExposed).toBe(false);
    expect(install.configs.NPM_CONFIG_REGISTRY).toBeUndefined();
    expect(install.configs.NPM_CONFIG_CACHE).toBeUndefined();
    expect(install.configs.NPM_CONFIG_GLOBAL).toBeUndefined();
    expect(install.configs.NPM_CONFIG_LOCATION).toBeUndefined();
    expect(install.configs.NPM_CONFIG_LOGS_DIR).toBeUndefined();
    expect(install.configs.NPM_CONFIG_TIMING).toBeUndefined();
    expect(install.home).toBe(f.base);
    expect(install.configs.npm_config_userconfig).toBe(path.join(f.base, "user.npmrc"));
    expect(JSON.parse(await readFile(f.launch, "utf8"))).toEqual({
      args: ["--skills-dir", f.skillsDir], workspaceExists: true, privateEnvExposed: false,
    });
    expect(result.stdout + result.stderr).not.toContain("update-secret");
    expect(result.stdout + result.stderr).not.toContain("\x1b");
    await expectMissing(f.workspace);
    expect(await readFile(path.join(f.skillsDir, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("prevents npm and the relaunched app from writing Node compile caches into the selected skills directory", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const result = await startWorker(f, { compileCache: true }).result;
    expect(result.code).toBe(0);
    const install = JSON.parse(await readFile(f.record, "utf8"));
    const app = JSON.parse(await readFile(f.launch, "utf8"));
    expect(install.compileCacheStatus).toBe(moduleConstants.compileCacheStatus.DISABLED);
    expect(app.compileCacheStatus).toBe(moduleConstants.compileCacheStatus.DISABLED);
    expect(app.args).toEqual(["--skills-dir", f.skillsDir]);
    await expectMissing(path.join(f.skillsDir, "node-compile-cache"));
    expect(await readdir(f.skillsDir)).toEqual(["sentinel"]);
    expect(await readFile(path.join(f.skillsDir, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("reports a quoted recovery command and removes the workspace after npm fails", async () => {
    const f = await updateFixture();
    const result = await startWorker(f, { npmMode: "failure" }).result;
    expect(result.code).toBe(23);
    expect(result.stderr).toContain("while installing the update");
    expect(result.stderr).toContain(f.workspace);
    expect(result.stderr).toContain("npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir '");
    expect(result.stderr).toContain(`/skills '"'"' with spaces'`);
    expect(result.stderr).not.toContain("update-secret");
    expect(result.stdout + result.stderr).not.toContain("\x1b");
    await expectMissing(f.workspace);
    await expectMissing(f.launch);
  });

  it("escapes control and Unicode format characters in paths and manual recovery", async () => {
    const f = await updateFixture("skills\x1b[31m\u202e\ntrail\n", "workspace\u202e");
    const result = await startWorker(f, { npmMode: "failure" }).result;
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("\x1b");
    expect(result.stdout + result.stderr).not.toContain("\u202e");
    expect(result.stderr).toContain("\\u{202e}");
    expect(result.stderr).toContain("printf '%b.'");
    expect(result.stderr).toContain("npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir");
    expect(result.stderr).toContain('"${SKILLS_DIR%.}"');
    expect(result.stderr).toContain("\\0033\\0133\\0063\\0061\\0155\\0342\\0200\\0256\\0012");
    await expectMissing(f.workspace);
  });

  it("cleans up and gives manual recovery when npm cannot be launched", async () => {
    const f = await updateFixture();
    const result = await startWorker(f, { npm: path.join(f.base, "absent-npm") }).result;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir");
    await expectMissing(f.workspace);
    await expectMissing(f.launch);
  });

  it.each([
    { name: "wrong app identity", options: { appName: "another-app" } },
    { name: "escaping app bin", options: { bin: "../../outside.js" } },
    { name: "absolute app bin", options: { bin: "/outside.js" } },
    { name: "missing app bin", options: { bin: { "skills-manager": "./missing.js" } } },
    { name: "bin without the declared command", options: { bin: { another: "./dist/cli.js" } } },
    { name: "directory in place of the app bin", options: { bin: "./dist/actions" } },
    { name: "wrong direct CLI identity", options: { skillsName: "another-cli" } },
    { name: "different CLI selected by the app", options: { nestedSkills: true } },
    { name: "incomplete CLI dependency closure", options: { missingDependency: true } },
  ])("refuses $name before launching", async ({ options }) => {
    const f = await updateFixture();
    await stageRuntime(f, options);
    const result = await startWorker(f).result;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("while validating the staged update");
    expect(result.stderr).toContain("npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir");
    await expectMissing(f.launch);
    await expectMissing(f.workspace);
  });

  it("refuses a bin symlink whose canonical target escapes the app package", async () => {
    const f = await updateFixture();
    await stageRuntime(f, { bin: "./dist/escape.js" });
    await writeFile(path.join(f.base, "outside.js"), "outside sentinel");
    await symlink(path.join(f.base, "outside.js"), path.join(f.modules, "skills-manager", "dist", "escape.js"));
    const result = await startWorker(f).result;
    expect(result.code).not.toBe(0);
    expect(await readFile(path.join(f.base, "outside.js"), "utf8")).toBe("outside sentinel");
    await expectMissing(f.launch);
    await expectMissing(f.workspace);
  });

  it("keeps the private project alive until the new application exits", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const { result } = startWorker(f, { appMode: "hold" });
    await waitForFile(f.launch);
    expect((await lstat(f.workspace)).isDirectory()).toBe(true);
    await writeFile(f.release, "quit");
    expect((await result).code).toBe(0);
    await expectMissing(f.workspace);
  });

  it("propagates an application failure and preserves its workspace", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const result = await startWorker(f, { appExit: 19 }).result;
    expect(result.code).toBe(19);
    expect(result.stderr).toContain("while starting or running the new application");
    expect(result.stderr).toContain("npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir");
    expect((await lstat(f.workspace)).isDirectory()).toBe(true);
    expect(result.stderr).toContain(f.workspace);
  });

  it("keeps a failed app's workspace while its surviving child still uses it", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const worker = startWorker(f, { appMode: "descendant" });
    await waitForFile(f.survivorReady);
    updateSurvivors.add(f.survivorDone);
    const result = await worker.result;
    expect(result.code).toBe(19);
    expect((await lstat(f.workspace)).isDirectory()).toBe(true);
    expect(await readFile(path.join(f.workspace, "survivor-active"), "utf8")).toBe("active");
    expect(result.stderr).toContain(f.workspace);
    expect(result.stderr).toContain("wait for any remaining processes");
    expect(result.stderr).toContain("npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir");
    await writeFile(f.release, "quit");
    await waitForFile(f.survivorDone);
    expect(await readFile(f.survivorDone, "utf8")).toBe("done");
    expect(await readFile(path.join(f.workspace, "survivor-finished"), "utf8")).toBe("finished");
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("forwards %s, waits for the app, and preserves its workspace", async (signal) => {
    const f = await updateFixture();
    await stageRuntime(f);
    const worker = startWorker(f, { appMode: "hold" });
    await waitForFile(f.launch);
    worker.child.kill(signal);
    await waitForFile(f.signal);
    expect(await readFile(f.signal, "utf8")).toBe(signal);
    expect((await lstat(f.workspace)).isDirectory()).toBe(true);
    await writeFile(f.release, "quit");
    const result = await worker.result;
    expect(result.signal === signal || result.code === 128 + constants.signals[signal]).toBe(true);
    expect(await readFile(f.done, "utf8")).toBe("done");
    expect((await lstat(f.workspace)).isDirectory()).toBe(true);
    expect(result.stderr).toContain(f.workspace);
    expect(result.stderr).toContain("npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir");
  });

  it("signals the npm process group and waits for its lifecycle descendants", async () => {
    const f = await updateFixture();
    const worker = startWorker(f, { npmMode: "hold" });
    await waitForFile(f.descendantReady);
    expect(worker.child.kill("SIGTERM")).toBe(true);
    await waitForFile(f.signal);
    await waitForFile(f.descendantSignal);
    // A signal marker precedes exit: npm must reap its child before it is
    // released, otherwise the worker correctly keeps an unconfirmed workspace.
    await waitForFile(f.descendantReaped);
    expect(await readFile(f.descendantReaped, "utf8")).toBe("reaped");
    expect((await lstat(f.workspace)).isDirectory()).toBe(true);
    await writeFile(f.release, "quit");
    const result = await worker.result;
    expect(result.signal === "SIGTERM" || result.code === 128 + constants.signals.SIGTERM).toBe(true);
    expect(await readFile(f.done, "utf8")).toBe("done");
    await expectMissing(f.workspace);
  });

  it("does not install or delete a workspace with a mismatched inode", async () => {
    const f = await updateFixture();
    const result = await startWorker(f, { inode: (BigInt(f.inode) + 1n).toString() }).result;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(f.workspace);
    expect((await lstat(f.workspace)).isDirectory()).toBe(true);
    await expectMissing(f.record);
  });

  it("does not delete a replacement workspace after the app exits", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const { result } = startWorker(f, { appMode: "hold" });
    await waitForFile(f.launch);
    await rename(f.workspace, path.join(f.base, "original-workspace"));
    await mkdir(f.workspace);
    await writeFile(path.join(f.workspace, "sentinel"), "replacement");
    await writeFile(f.release, "quit");
    const ended = await result;
    expect(ended.code).not.toBe(0);
    expect(ended.stderr).toContain(f.workspace);
    expect(await readFile(path.join(f.workspace, "sentinel"), "utf8")).toBe("replacement");
    expect((await lstat(path.join(f.base, "original-workspace"))).isDirectory()).toBe(true);
  });
});
