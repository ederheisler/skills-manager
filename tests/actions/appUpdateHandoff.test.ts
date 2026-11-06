import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
const commit = "0123456789abcdef0123456789abcdef01234567";
const registry = "https://update-user:update-secret@registry.example.invalid/";

type WorkerResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type WorkerFixture = {
  base: string;
  workspace: string;
  skillsDir: string;
  npm: string;
  prefix: string;
  app: string;
  bin: string;
  modules: string;
  packRecord: string;
  installRecord: string;
  launch: string;
  release: string;
  signal: string;
  done: string;
  descendantReady: string;
  descendantSignal: string;
  descendantReaped: string;
  packReady: string;
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
const args = process.argv.slice(2);
const isPack = args[0] === "pack";
if (!isPack && args[0] !== "install") process.exit(2);
const compileCache = env.SM_TEST_ENABLE_COMPILE_CACHE === "1" ? require("node:module").enableCompileCache() : undefined;
const configs = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase().startsWith("npm_config_")));
const cache = env.npm_config_cache;
fs.writeFileSync(isPack ? env.SM_TEST_PACK_RECORD : env.SM_TEST_INSTALL_RECORD, JSON.stringify({
  argv: args, cwd: process.cwd(), configs,
  home: env.HOME, workspaceMode: fs.statSync(".").mode & 0o777,
  cacheMode: fs.statSync(cache).mode & 0o777,
  temporary: env.TMPDIR, tmp: env.TMP, temp: env.TEMP,
  temporaryMode: fs.statSync(env.TMPDIR).mode & 0o777,
  privateEnvExposed: ["SKILLS_MANAGER_UPDATE_REGISTRY", "SKILLS_MANAGER_UPDATE_DEVICE", "SKILLS_MANAGER_UPDATE_INODE",
    "SKILLS_MANAGER_UPDATE_PACKAGE_ID", "SKILLS_MANAGER_UPDATE_BIN_ID"].some((key) => key in env),
  ...(compileCache ? { compileCacheStatus: compileCache.status } : {}),
  hadLockfile: fs.existsSync("package-lock.json"),
}));
process.stdout.write("UNTRUSTED " + env.npm_config_registry + "\\x1b[31m\\n");
process.stderr.write("UNTRUSTED " + env.npm_config_registry + "\\x1b[31m\\n");
if (env.SM_TEST_NPM_MODE === "failure" || (!isPack && env.SM_TEST_NPM_MODE === "install-failure")) process.exit(23);
const pack = () => {
  const destination = args[args.indexOf("--pack-destination") + 1];
  fs.writeFileSync(path.join(destination, "skills-manager-test.tgz"), JSON.stringify({
    spec: args[1], lockDisabled: env.npm_config_package_lock === "false",
  }));
};
if (isPack && env.SM_TEST_NPM_MODE === "hold") {
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
} else if (isPack && env.SM_TEST_NPM_MODE === "pack-hold") {
  const finish = () => {
    if (fs.existsSync(env.SM_TEST_RELEASE)) { pack(); process.exit(0); }
  };
  fs.watch(path.dirname(env.SM_TEST_RELEASE), finish);
  fs.writeFileSync(env.SM_TEST_PACK_READY, "ready");
  finish();
} else if (isPack) {
  pack();
} else {
  const prefix = args[args.indexOf("--prefix") + 1];
  const archive = args[args.indexOf("--prefix") + 2];
  const packed = JSON.parse(fs.readFileSync(archive, "utf8"));
  const app = path.join(prefix, "lib", "node_modules", "skills-manager");
  const bin = path.join(prefix, "bin", "skills-manager");
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.cpSync(path.join(env.SM_TEST_MODULES, "skills-manager"), app, { recursive: true, verbatimSymlinks: true });
  const manifestFile = path.join(app, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.buildRevision = packed.spec.split("#")[1];
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  if (!packed.lockDisabled) {
    const skillsManifest = path.join(app, "node_modules", "skills", "package.json");
    const skills = JSON.parse(fs.readFileSync(skillsManifest, "utf8"));
    skills.version = "0.9.0";
    fs.writeFileSync(skillsManifest, JSON.stringify(skills));
  }
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.rmSync(bin, { force: true });
  const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["skills-manager"];
  if (typeof declared === "string") fs.symlinkSync(path.relative(path.dirname(bin), path.resolve(app, declared)), bin);
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


const fakeApp = `import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { enableCompileCache } from "node:module";
import { inspectSkillsRuntime } from "./actions/sandbox.js";
const compileCache = process.env.SM_TEST_ENABLE_COMPILE_CACHE === "1" ? enableCompileCache() : undefined;
const runtime = await inspectSkillsRuntime();
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
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
writeFileSync(process.env.SM_TEST_LAUNCH + ".tmp", JSON.stringify({
  args: process.argv.slice(2), executable: process.argv[1], pid: process.pid,
  runtime, revision: manifest.buildRevision,
  workspaceExists: existsSync(process.env.SM_TEST_WORKSPACE),
  privateEnvExposed: ["SKILLS_MANAGER_UPDATE_REGISTRY", "SKILLS_MANAGER_UPDATE_DEVICE", "SKILLS_MANAGER_UPDATE_INODE",
    "SKILLS_MANAGER_UPDATE_PACKAGE_ID", "SKILLS_MANAGER_UPDATE_BIN_ID"].some((key) => key in process.env),
  ...(compileCache ? { compileCacheStatus: compileCache.status } : {}),
}));
renameSync(process.env.SM_TEST_LAUNCH + ".tmp", process.env.SM_TEST_LAUNCH);
if (process.env.SM_TEST_APP_MODE !== "hold") process.exit(Number(process.env.SM_TEST_APP_EXIT || 0));
`;

async function updateFixture(skillsName = "skills ' with spaces", workspaceName = "workspace"): Promise<WorkerFixture> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-app-update-test-")));
  updateFixtures.push(base);
  const workspace = path.join(base, workspaceName);
  const skillsDir = path.join(base, skillsName);
  const modules = path.join(base, "staged-modules");
  const prefix = path.join(base, "global prefix");
  const app = path.join(prefix, "lib", "node_modules", "skills-manager");
  const bin = path.join(prefix, "bin", "skills-manager");
  await mkdir(workspace, { mode: 0o700 });
  await Promise.all([mkdir(skillsDir), mkdir(prefix)]);
  await writeFile(path.join(skillsDir, "sentinel"), "unchanged");
  await writeFile(path.join(workspace, "app-update-worker.mjs"), await transpiled("src/actions/appUpdateWorker.ts"));
  const identity = await lstat(workspace, { bigint: true });
  const npm = path.join(base, "fake-npm");
  await writeFile(npm, fakeNpm, { mode: 0o700 });
  await writeFile(path.join(base, "descendant.cjs"), fakeDescendant);
  return {
    base, workspace, skillsDir, npm, prefix, app, bin, modules,
    packRecord: path.join(base, "pack-record.json"),
    installRecord: path.join(base, "install-record.json"),
    launch: path.join(base, "launch.json"),
    release: path.join(base, "release"),
    signal: path.join(base, "signal"),
    done: path.join(base, "done"),
    descendantReady: path.join(base, "descendant-ready"),
    descendantSignal: path.join(base, "descendant-signal"),
    descendantReaped: path.join(base, "descendant-reaped"),
    packReady: path.join(base, "pack-ready"),
    device: identity.dev.toString(), inode: identity.ino.toString(),
  };
}

async function stageRuntime(f: WorkerFixture, options: {
  appName?: string; bin?: unknown; skillsName?: string; escapingSkills?: boolean;
  missingDependency?: boolean; identityCommit?: string;
} = {}): Promise<void> {
  const app = path.join(f.modules, "skills-manager");
  const skills = options.escapingSkills ? path.join(f.base, "outside-skills") : path.join(app, "node_modules", "skills");
  await mkdir(path.join(app, "dist", "actions"), { recursive: true });
  await mkdir(path.join(app, "dist", "state"), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(app, "package.json"), JSON.stringify({
    name: options.appName ?? "skills-manager", type: "module",
    bin: options.bin ?? { "skills-manager": "./dist/cli.js" },
    dependencies: { skills: "latest" },
  }));
  await writeFile(path.join(app, "dist", "cli.js"), fakeApp);
  // Exercise the installed app's real inspector, not a test replacement.
  await writeFile(path.join(app, "dist", "actions", "sandbox.js"), await transpiled("src/actions/sandbox.ts"));
  await writeFile(path.join(app, "dist", "state", "validation.js"), await transpiled("src/state/validation.ts"));
  await writeFile(path.join(app, "dist", "state", "buildIdentity.json"), JSON.stringify({
    version: "0.1.0", commit: options.identityCommit ?? commit, dirty: false, source: "git",
  }));
  await writeFile(path.join(app, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3, packages: { "node_modules/skills": { version: "0.9.0" } },
  }));
  await writeFile(path.join(skills, "package.json"), JSON.stringify({
    name: options.skillsName ?? "skills", version: "1.2.3", type: "module", bin: "./cli.js",
    ...(options.missingDependency ? { dependencies: { "missing-package": "1.0.0" } } : {}),
  }));
  await writeFile(path.join(skills, "cli.js"), "export {};\n");
  if (options.escapingSkills) {
    await mkdir(path.join(app, "node_modules"), { recursive: true });
    await symlink(skills, path.join(app, "node_modules", "skills"), "dir");
  }
}

async function installExisting(f: WorkerFixture): Promise<{ packageId: string; binId: string }> {
  await mkdir(path.dirname(f.app), { recursive: true });
  await mkdir(path.dirname(f.bin), { recursive: true });
  await cp(path.join(f.modules, "skills-manager"), f.app, { recursive: true });
  const oldSkills = path.join(f.app, "node_modules", "skills", "package.json");
  const manifest = JSON.parse(await readFile(oldSkills, "utf8"));
  await writeFile(oldSkills, JSON.stringify({ ...manifest, version: "0.9.0" }));
  await symlink("../lib/node_modules/skills-manager/dist/cli.js", f.bin);
  const appIdentity = await lstat(f.app, { bigint: true });
  const binIdentity = await lstat(f.bin, { bigint: true });
  return { packageId: `${appIdentity.dev}:${appIdentity.ino}`, binId: `${binIdentity.dev}:${binIdentity.ino}` };
}

async function resetWorkspace(f: WorkerFixture): Promise<void> {
  await mkdir(f.workspace, { mode: 0o700 });
  await writeFile(path.join(f.workspace, "app-update-worker.mjs"), await transpiled("src/actions/appUpdateWorker.ts"));
  const identity = await lstat(f.workspace, { bigint: true });
  f.device = identity.dev.toString();
  f.inode = identity.ino.toString();
}

function startWorker(f: WorkerFixture, options: {
  target?: "all" | "cli"; revision?: string; npm?: string; device?: string; inode?: string;
  mode?: "install" | "update"; packageId?: string; binId?: string;
  npmMode?: "failure" | "install-failure" | "hold" | "pack-hold"; appMode?: "hold"; appExit?: number; compileCache?: boolean;
  cwd?: string;
} = {}): { child: ChildProcess; result: Promise<WorkerResult> } {
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: f.base,
    TMPDIR: f.skillsDir, TMP: f.skillsDir, TEMP: f.skillsDir,
    SKILLS_MANAGER_UPDATE_REGISTRY: registry,
    SKILLS_MANAGER_UPDATE_DEVICE: options.device ?? f.device,
    SKILLS_MANAGER_UPDATE_INODE: options.inode ?? f.inode,
    SKILLS_MANAGER_UPDATE_PACKAGE_ID: options.packageId ?? "absent",
    SKILLS_MANAGER_UPDATE_BIN_ID: options.binId ?? "absent",
    npm_config_userconfig: path.join(f.base, "user.npmrc"),
    NPM_CONFIG_REGISTRY: "https://wrong.example.invalid/",
    NPM_CONFIG_CACHE: path.join(f.base, "wrong-cache"),
    NPM_CONFIG_GLOBAL: "true",
    NPM_CONFIG_LOCATION: "global",
    NPM_CONFIG_LOGS_DIR: f.skillsDir,
    NPM_CONFIG_TIMING: "true",
    NPM_CONFIG_PACKAGE_LOCK: "true",
    SM_TEST_PACK_RECORD: f.packRecord, SM_TEST_INSTALL_RECORD: f.installRecord,
    SM_TEST_MODULES: f.modules, SM_TEST_LAUNCH: f.launch, SM_TEST_PACK_READY: f.packReady,
    SM_TEST_WORKSPACE: f.workspace, SM_TEST_RELEASE: f.release,
    SM_TEST_SIGNAL: f.signal, SM_TEST_DONE: f.done,
    SM_TEST_DESCENDANT: path.join(f.base, "descendant.cjs"),
    SM_TEST_DESC_READY: f.descendantReady, SM_TEST_DESC_SIGNAL: f.descendantSignal,
    SM_TEST_DESC_REAPED: f.descendantReaped,
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
    options.target ?? "all", options.revision ?? "main", f.skillsDir, f.prefix, options.mode ?? "install",
  ], { env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  await Promise.all(updateFixtures.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

describe("persistent global application update worker", () => {
  it.each([
    { target: "all" as const, revision: "main", update: false },
    { target: "cli" as const, revision: commit, update: true },
    { target: "cli" as const, revision: "main", update: false },
  ])("installs the approved $target revision $revision and restarts the global app", async ({ target, revision, update }) => {
    const f = await updateFixture();
    await stageRuntime(f);
    const previous = update ? await installExisting(f) : {};
    const worker = startWorker(f, { target, revision, mode: update ? "update" : "install", ...previous });
    const result = await worker.result;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    const pack = JSON.parse(await readFile(f.packRecord, "utf8"));
    const install = JSON.parse(await readFile(f.installRecord, "utf8"));
    expect(pack.argv).toEqual([
      "pack", `github:ederheisler/skills-manager#${revision}`,
      "--pack-destination", path.join(f.workspace, "pack"), "--no-audit", "--no-fund",
    ]);
    expect(install.argv).toEqual([
      "install", "--global", "--prefix", f.prefix, path.join(f.workspace, "pack", "skills-manager-test.tgz"),
      "--no-audit", "--no-fund",
    ]);
    for (const command of [pack, install]) {
      expect(command.cwd).toBe(f.workspace);
      expect(command.hadLockfile).toBe(false);
      expect(command.workspaceMode).toBe(0o700);
      expect(command.cacheMode).toBe(0o700);
      expect(path.dirname(command.configs.npm_config_cache)).toBe(f.workspace);
      expect(path.dirname(command.temporary)).toBe(f.workspace);
      expect(command.tmp).toBe(command.temporary);
      expect(command.temp).toBe(command.temporary);
      expect(command.temporaryMode).toBe(0o700);
      expect(command.configs.npm_config_registry).toBe(registry);
      expect(command.configs.npm_config_global).toBe("false");
      expect(command.configs.npm_config_location).toBe("project");
      expect(command.configs.npm_config_package_lock).toBe("false");
      expect(command.configs.npm_config_force).toBe("false");
      expect(command.configs.npm_config_loglevel).toBe("silent");
      expect(command.configs.npm_config_logs_max).toBe("0");
      expect(command.configs.npm_config_logs_dir).toBe(path.join(command.configs.npm_config_cache, "_logs"));
      expect(command.configs.npm_config_timing).toBe("false");
      expect(command.configs.npm_config_update_notifier).toBe("false");
      expect(command.privateEnvExposed).toBe(false);
      for (const key of ["REGISTRY", "CACHE", "GLOBAL", "LOCATION", "LOGS_DIR", "TIMING", "PACKAGE_LOCK"]) {
        expect(command.configs[`NPM_CONFIG_${key}`]).toBeUndefined();
      }
      expect(command.home).toBe(f.base);
      expect(command.configs.npm_config_userconfig).toBe(path.join(f.base, "user.npmrc"));
    }
    const launched = JSON.parse(await readFile(f.launch, "utf8"));
    expect(launched).toMatchObject({
      args: ["--skills-dir", f.skillsDir], executable: path.join(f.app, "dist", "cli.js"),
      pid: worker.child.pid, revision, workspaceExists: false, privateEnvExposed: false,
      runtime: { version: "1.2.3", packageRoot: path.join(f.app, "node_modules", "skills") },
    });
    expect(await realpath(f.bin)).toBe(path.join(f.app, "dist", "cli.js"));
    expect(JSON.parse(await readFile(path.join(f.app, "dist", "state", "buildIdentity.json"), "utf8")).commit).toBe(commit);
    expect(result.stderr).toBe([
      "Updating skills-manager…",
      `Downloading and building from GitHub (${revision})…`,
      `Installing to ${JSON.stringify(f.prefix)}…`,
      "Refreshing Vercel skills CLI…",
      "Done. Restarting skills-manager…",
      "",
    ].join("\n"));
    expect(result.stdout).toBe("");
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
    const pack = JSON.parse(await readFile(f.packRecord, "utf8"));
    const install = JSON.parse(await readFile(f.installRecord, "utf8"));
    const app = JSON.parse(await readFile(f.launch, "utf8"));
    expect(pack.compileCacheStatus).toBe(moduleConstants.compileCacheStatus.DISABLED);
    expect(install.compileCacheStatus).toBe(moduleConstants.compileCacheStatus.DISABLED);
    expect(app.compileCacheStatus).toBe(moduleConstants.compileCacheStatus.DISABLED);
    expect(app.args).toEqual(["--skills-dir", f.skillsDir]);
    await expectMissing(path.join(f.skillsDir, "node-compile-cache"));
    expect(await readdir(f.skillsDir)).toEqual(["sentinel"]);
    expect(await readFile(path.join(f.skillsDir, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("leaves the existing installation usable after npm fails and can retry", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const previous = await installExisting(f);
    const result = await startWorker(f, { mode: "update", ...previous, npmMode: "install-failure" }).result;
    expect(result.code).toBe(23);
    expect(result.stderr).toContain("Installing skills-manager failed: npm exited with code 23");
    expect(result.stderr).not.toContain("UNTRUSTED");
    expect(result.stderr).toContain(`/skills '"'"' with spaces'`);
    expect(result.stderr).not.toContain("update-secret");
    expect(result.stdout + result.stderr).not.toContain("\x1b");
    expect(JSON.parse(await readFile(path.join(f.app, "node_modules", "skills", "package.json"), "utf8")).version).toBe("0.9.0");
    expect(await realpath(f.bin)).toBe(path.join(f.app, "dist", "cli.js"));
    await expectMissing(f.workspace);
    await expectMissing(f.launch);
    await resetWorkspace(f);
    expect((await startWorker(f, { mode: "update", ...previous }).result).code).toBe(0);
    expect(JSON.parse(await readFile(f.launch, "utf8")).runtime.version).toBe("1.2.3");
    await expectMissing(f.workspace);
  });

  it("reports a download failure and the npm exit code without npm output", async () => {
    const f = await updateFixture();
    const result = await startWorker(f, { npmMode: "failure" }).result;
    expect(result.code).toBe(23);
    expect(result.stderr).toContain("Downloading and building failed: npm exited with code 23");
    expect(result.stderr).not.toContain("UNTRUSTED");
    expect(result.stderr).not.toContain("Installing to ");
    expect(result.stderr).toContain("To reinstall and start the app again, run:");
    await expectMissing(f.installRecord);
  });

  it("escapes control and Unicode format characters in paths and manual recovery", async () => {
    const f = await updateFixture("skills\x1b[31m\u202e\ntrail\n", "workspace\u202e");
    const result = await startWorker(f, { npmMode: "failure" }).result;
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("\x1b");
    expect(result.stdout + result.stderr).not.toContain("\u202e");
    expect(result.stderr).toContain("printf '%b.'");
    expect(result.stderr).toContain('"$SM_SKILLS_DIR"');
    expect(result.stderr).toContain("\\0033\\0133\\0063\\0061\\0155\\0342\\0200\\0256\\0012");
    await expectMissing(f.workspace);
    const retained = await updateFixture("skills", "workspace\u202e");
    const unsafe = await startWorker(retained, { inode: (BigInt(retained.inode) + 1n).toString() }).result;
    expect(unsafe.stderr).not.toContain("\u202e");
    expect(unsafe.stderr).toContain("\\u{202e}");
    expect((await lstat(retained.workspace)).isDirectory()).toBe(true);
  });

  it("cleans up and gives manual recovery when npm cannot be launched", async () => {
    const f = await updateFixture();
    const result = await startWorker(f, { npm: path.join(f.base, "absent-npm") }).result;
    expect(result.code).not.toBe(0);
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
    { name: "CLI runtime outside the app", options: { escapingSkills: true } },
    { name: "incomplete CLI dependency closure", options: { missingDependency: true } },
  ])("refuses $name before launching", async ({ options }) => {
    const f = await updateFixture();
    await stageRuntime(f, options);
    const result = await startWorker(f).result;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Validating the installation failed:");
    await expectMissing(f.launch);
    await expectMissing(f.workspace);
  });

  it("refuses to restart a CLI-only update whose installed app has a different SHA", async () => {
    const f = await updateFixture();
    await stageRuntime(f, { identityCommit: "1111111111111111111111111111111111111111" });
    const result = await startWorker(f, { target: "cli", revision: commit }).result;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Validating the installation failed:");
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

  it("leaves the checkout untouched when updating from outside the global installation", async () => {
    const f = await updateFixture();
    const checkout = path.join(f.base, "checkout");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    await writeFile(path.join(checkout, "sentinel"), "unchanged checkout");
    await stageRuntime(f);
    const result = await startWorker(f, { cwd: checkout }).result;
    expect(result.code).toBe(0);
    expect(await readdir(checkout)).toEqual([".git", "sentinel"]);
    expect(await readFile(path.join(checkout, "sentinel"), "utf8")).toBe("unchanged checkout");
    expect(await realpath(f.bin)).toBe(path.join(f.app, "dist", "cli.js"));
    await expectMissing(f.workspace);
  });

  it("leaves the global installation available after the restarted app fails", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const result = await startWorker(f, { appExit: 19 }).result;
    expect(result.code).toBe(19);
    expect(await realpath(f.bin)).toBe(path.join(f.app, "dist", "cli.js"));
    expect(JSON.parse(await readFile(f.launch, "utf8")).workspaceExists).toBe(false);
    await expectMissing(f.workspace);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("delivers %s to the persistent app after staging is removed", async (signal) => {
    const f = await updateFixture();
    await stageRuntime(f);
    const worker = startWorker(f, { appMode: "hold" });
    await waitForFile(f.launch);
    expect(JSON.parse(await readFile(f.launch, "utf8")).pid).toBe(worker.child.pid);
    await expectMissing(f.workspace);
    expect(worker.child.kill(signal)).toBe(true);
    await waitForFile(f.signal);
    expect(await readFile(f.signal, "utf8")).toBe(signal);
    await writeFile(f.release, "quit");
    expect((await worker.result).code).toBe(0);
    expect(await readFile(f.done, "utf8")).toBe("done");
    expect(await realpath(f.bin)).toBe(path.join(f.app, "dist", "cli.js"));
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
    await expectMissing(f.packRecord);
  });

  it.each(["package", "bin"] as const)("refuses a hostile global %s appearing before npm", async (entry) => {
    const f = await updateFixture();
    const checkout = path.join(f.base, "checkout");
    const target = entry === "package" ? f.app : f.bin;
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    await writeFile(path.join(checkout, "sentinel"), "untouched");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(entry === "package" ? checkout : path.join(checkout, "sentinel"), target);
    const result = await startWorker(f).result;
    expect(result.code).not.toBe(0);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(checkout, "sentinel"), "utf8")).toBe("untouched");
    await expectMissing(f.packRecord);
    await expectMissing(f.installRecord);
    await expectMissing(f.workspace);
  });

  it.each(["package", "bin"] as const)("rechecks the global %s after packing and before installing", async (entry) => {
    const f = await updateFixture();
    const target = entry === "package" ? f.app : f.bin;
    const outside = path.join(f.base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "untouched");
    const worker = startWorker(f, { npmMode: "pack-hold" });
    await waitForFile(f.packReady);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(entry === "package" ? outside : path.join(outside, "sentinel"), target);
    await writeFile(f.release, "continue");
    expect((await worker.result).code).not.toBe(0);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("untouched");
    await expectMissing(f.installRecord);
    await expectMissing(f.workspace);
  });

  it("rejects a replaced global command during an approved update", async () => {
    const f = await updateFixture();
    await stageRuntime(f);
    const previous = await installExisting(f);
    const worker = startWorker(f, { mode: "update", ...previous, npmMode: "pack-hold" });
    await waitForFile(f.packReady);
    await unlink(f.bin);
    await writeFile(f.bin, "unrelated command");
    await writeFile(f.release, "continue");
    expect((await worker.result).code).not.toBe(0);
    expect(await readFile(f.bin, "utf8")).toBe("unrelated command");
    await expectMissing(f.installRecord);
    await expectMissing(f.workspace);
  });

  it("does not delete a replacement workspace while npm is running", async () => {
    const f = await updateFixture();
    const worker = startWorker(f, { npmMode: "pack-hold" });
    await waitForFile(f.packReady);
    await rename(f.workspace, path.join(f.base, "original-workspace"));
    await mkdir(f.workspace);
    await writeFile(path.join(f.workspace, "sentinel"), "replacement");
    await writeFile(f.release, "quit");
    const ended = await worker.result;
    expect(ended.code).not.toBe(0);
    expect(ended.stderr).toContain(f.workspace);
    expect(await readFile(path.join(f.workspace, "sentinel"), "utf8")).toBe("replacement");
    expect((await lstat(path.join(f.base, "original-workspace"))).isDirectory()).toBe(true);
  });
});
