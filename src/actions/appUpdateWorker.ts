/// <reference lib="es2024.promise" />
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

type HandledSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
type ChildResult = { code: number | null; signal: NodeJS.Signals | null };
type ActiveChild = { child: ChildProcess; force?: NodeJS.Timeout };

const [workspace = "", npmExecutable = "", target = "", revision = "", skillsDir = "", prefix = "", mode = ""] = process.argv.slice(2);
const registry = process.env.SKILLS_MANAGER_UPDATE_REGISTRY;
const device = process.env.SKILLS_MANAGER_UPDATE_DEVICE;
const inode = process.env.SKILLS_MANAGER_UPDATE_INODE;
const packageId = process.env.SKILLS_MANAGER_UPDATE_PACKAGE_ID;
const binId = process.env.SKILLS_MANAGER_UPDATE_BIN_ID;
delete process.env.SKILLS_MANAGER_UPDATE_REGISTRY;
delete process.env.SKILLS_MANAGER_UPDATE_DEVICE;
delete process.env.SKILLS_MANAGER_UPDATE_INODE;
delete process.env.SKILLS_MANAGER_UPDATE_PACKAGE_ID;
delete process.env.SKILLS_MANAGER_UPDATE_BIN_ID;

const workerDirectory = path.dirname(fileURLToPath(import.meta.url));
const signals: HandledSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
let interrupted: HandledSignal | undefined;
let activeChild: ActiveChild | undefined;
let cleanupSafe = true;

function sendSignal(active: ActiveChild, signal: NodeJS.Signals): void {
  const pid = active.child.pid;
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* The child may already have exited. */ }
}

const signalHandlers = new Map<HandledSignal, () => void>();
for (const signal of signals) {
  const handler = () => {
    interrupted ??= signal;
    if (!activeChild) return;
    const active = activeChild;
    sendSignal(active, signal);
    if (!active.force) active.force = setTimeout(() => sendSignal(active, "SIGKILL"), 5000);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

function checkInterrupted(): void {
  if (interrupted) throw new Error("Interrupted");
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function displayPath(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]|\p{Cf}/gu, (character) =>
    /\p{Cf}/u.test(character)
      ? `\\u{${character.codePointAt(0)!.toString(16)}}`
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function recoveryCommand(): string {
  const assignments: string[] = [];
  const argument = (value: string, variable: string): string => {
    if (/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(value)) {
      const encoded = [...Buffer.from(value)].map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
      assignments.push(`${variable}=$(printf '%b.' '${encoded}'); ${variable}=\${${variable}%.}`);
      return `"$${variable}"`;
    }
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  };
  const binArg = argument(path.join(prefix, "bin", "skills-manager"), "SM_BIN");
  const skillsArg = argument(skillsDir, "SM_SKILLS_DIR");
  const appRevision = revision === "main" || /^[0-9a-f]{40}$/i.test(revision) ? revision : "main";
  const command = `npx --yes github:ederheisler/skills-manager#${appRevision} --skills-dir ${skillsArg}\nAfter installation, start the app with:\n${binArg} --skills-dir ${skillsArg}`;
  return assignments.length ? `${assignments.join("; ")}; ${command}` : command;
}

async function report(message: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  process.stderr.write(message, () => resolve());
  await promise;
}

async function ownsWorkspace(): Promise<boolean> {
  if (!path.isAbsolute(workspace) || path.resolve(workspace) !== workspace || workerDirectory !== workspace
    || !device || !inode || !/^\d+$/.test(device) || !/^\d+$/.test(inode)) return false;
  try {
    const entry = await lstat(workspace, { bigint: true });
    return entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === BigInt(device) && entry.ino === BigInt(inode)
      && await realpath(workspace) === workspace;
  } catch {
    return false;
  }
}

function npmEnvironment(cache: string, temporary: string): NodeJS.ProcessEnv {
  const overrides: Record<string, string> = {
    registry: registry ?? "", cache, global: "false", location: "project", offline: "false",
    package_lock: "false", force: "false",
    audit: "false", fund: "false", loglevel: "silent", logs_max: "0", logs_dir: path.join(cache, "_logs"),
    timing: "false", update_notifier: "false", progress: "false", color: "false",
  };
  const env = { ...process.env };
  env.TMPDIR = temporary;
  env.TMP = temporary;
  env.TEMP = temporary;
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase().replace(/-/g, "_");
    if (normalized.startsWith("npm_config_") && normalized.slice("npm_config_".length) in overrides) delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) env[`npm_config_${key}`] = value;
  return env;
}

async function stopNpmDescendants(pid: number): Promise<boolean> {
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  // npm may have exited before a lifecycle descendant. Do not remove its cwd
  // until the whole private process group has actually disappeared.
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(-pid, 0); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    await delay(25);
  }
  return false;
}

async function runChild(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildResult> {
  checkInterrupted();
  const child = spawn(executable, args, { cwd: workspace, env, detached: true, stdio: "ignore" });
  const active: ActiveChild = { child };
  activeChild = active;
  const { promise, resolve } = Promise.withResolvers<ChildResult>();
  let launchFailed = false;
  child.once("error", () => { launchFailed = true; });
  child.once("close", (code, signal) => resolve({ code, signal }));
  const result = await promise;
  clearTimeout(active.force);
  if (activeChild === active) activeChild = undefined;
  if (child.pid && !await stopNpmDescendants(child.pid)) {
    cleanupSafe = false;
    throw new Error("The npm process group is still running");
  }
  if (launchFailed) throw new Error("Unable to start npm");
  return result;
}

async function canonicalPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function inCheckout(candidate: string): Promise<boolean> {
  let current = candidate;
  for (;;) {
    try { await lstat(path.join(current, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function identity(file: string): Promise<string> {
  try {
    const entry = await lstat(file, { bigint: true });
    return `${entry.dev}:${entry.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

async function assertDestination(): Promise<void> {
  const app = path.join(prefix, "lib", "node_modules", "skills-manager");
  const bin = path.join(prefix, "bin", "skills-manager");
  const appParent = path.dirname(app);
  const binParent = path.dirname(bin);
  if (await canonicalPath(prefix) !== prefix || await canonicalPath(appParent) !== appParent
    || await canonicalPath(binParent) !== binParent || !contained(prefix, appParent)
    || !contained(prefix, binParent) || await inCheckout(appParent) || await inCheckout(binParent)
    || contained(skillsDir, app) || contained(app, skillsDir) || contained(skillsDir, bin)
    || app === skillsDir || bin === skillsDir
    || await identity(app) !== packageId || await identity(bin) !== binId
    || (mode === "install" && (packageId !== "absent" || binId !== "absent"))
    || (mode === "update" && packageId === "absent")) {
    throw new Error("The approved global destination changed");
  }
}

async function packageFromApp(app: string, resolver: NodeRequire): Promise<string> {
  const manifestFile = await realpath(resolver.resolve("skills/package.json"));
  const root = path.dirname(manifestFile);
  if (!contained(app, root) || !contained(root, manifestFile) || !(await stat(manifestFile)).isFile()) {
    throw new Error("CLI package is outside the installed app");
  }
  const manifest: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || !("name" in manifest) || manifest.name !== "skills") throw new Error("Invalid CLI package identity");
  return root;
}

async function executableWithin(root: string, relative: unknown): Promise<string> {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) throw new Error("Invalid executable");
  const candidate = path.resolve(root, relative);
  if (!contained(root, candidate)) throw new Error("Executable escapes its package");
  const canonical = await realpath(candidate);
  if (!contained(root, canonical) || !(await stat(canonical)).isFile()) throw new Error("Invalid executable");
  return canonical;
}

async function installedApp(): Promise<string> {
  const root = path.join(prefix, "lib", "node_modules", "skills-manager");
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Invalid global app package");
  }
  const manifestPath = path.join(root, "package.json");
  const manifestEntry = await lstat(manifestPath);
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw new Error("Invalid app manifest");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || !("name" in manifest) || manifest.name !== "skills-manager" || !("bin" in manifest)) {
    throw new Error("Invalid app package identity");
  }
  if (revision !== "main") {
    const identityPath = await executableWithin(root, "dist/state/buildIdentity.json");
    const build: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (typeof build !== "object" || build === null || Array.isArray(build)
      || !("commit" in build) || build.commit !== revision || !("dirty" in build) || build.dirty !== false
      || !("source" in build) || (build.source !== "git" && build.source !== "archive")) {
      throw new Error("The installed app does not match the approved commit");
    }
  }
  const resolver = createRequire(manifestPath);
  const selectedSkills = await packageFromApp(root, resolver);
  const declaredBin = manifest.bin;
  const bin = typeof declaredBin === "string" ? declaredBin
    : typeof declaredBin === "object" && declaredBin !== null && !Array.isArray(declaredBin)
      && "skills-manager" in declaredBin ? declaredBin["skills-manager"] : undefined;
  const executable = await executableWithin(root, bin);
  const command = path.join(prefix, "bin", "skills-manager");
  if (!(await lstat(command)).isSymbolicLink() || await realpath(command) !== executable) {
    throw new Error("The global command points to a different executable");
  }
  const inspectorFile = await executableWithin(root, "dist/actions/sandbox.js");
  // This must load the newly installed app's own runtime-selected inspector.
  const inspector: unknown = await import(pathToFileURL(inspectorFile).href);
  if (typeof inspector !== "object" || inspector === null || !("inspectSkillsRuntime" in inspector)
    || typeof inspector.inspectSkillsRuntime !== "function") throw new Error("Missing runtime inspector");
  const pending: unknown = inspector.inspectSkillsRuntime();
  if (!(pending instanceof Promise)) throw new Error("Invalid runtime inspector");
  const inspection: unknown = await pending;
  if (typeof inspection !== "object" || inspection === null || Array.isArray(inspection)
    || !("packageRoot" in inspection) || typeof inspection.packageRoot !== "string"
    || !path.isAbsolute(inspection.packageRoot) || await realpath(inspection.packageRoot) !== selectedSkills) {
    throw new Error("The app selected a different CLI runtime");
  }
  return executable;
}

function resultCode(result: ChildResult): number {
  if (result.signal) return 128 + (constants.signals[result.signal] ?? 1);
  return result.code ?? 1;
}

async function main(): Promise<void> {
  let code = 1;
  let phase = "preparing the update";
  let childSignal: NodeJS.Signals | null = null;
  let cleaned = false;
  try {
    if (!await ownsWorkspace() || !path.isAbsolute(npmExecutable) || !path.isAbsolute(skillsDir)
      || !path.isAbsolute(prefix) || path.resolve(prefix) !== prefix
      || (mode !== "install" && mode !== "update") || !packageId || !binId
      || !/^(?:absent|\d+:\d+)$/.test(packageId) || !/^(?:absent|\d+:\d+)$/.test(binId)
      || (target !== "all" && target !== "cli") || (revision !== "main" && !/^[0-9a-f]{40}$/i.test(revision))
      || (target === "all" && revision !== "main")
      || !registry || !["http:", "https:"].includes(new URL(registry).protocol)) {
      throw new Error("Invalid approved update");
    }
    checkInterrupted();
    await assertDestination();
    const pack = path.join(workspace, "pack");
    const cache = path.join(workspace, "cache");
    const temporary = path.join(workspace, "tmp");
    for (const directory of [pack, cache, temporary]) {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const env = npmEnvironment(cache, temporary);
    phase = "preparing the update";
    await report("Updating…\n");
    // Pack before global installation: npm's Git prepare must run in the
    // source staging directory, not inherit the global install mode.
    const packed = await runChild(npmExecutable, [
      "pack", `github:ederheisler/skills-manager#${revision}`,
      "--pack-destination", pack, "--no-audit", "--no-fund",
    ], env);
    if (packed.code !== 0 || packed.signal || interrupted) {
      code = resultCode(packed);
      childSignal = packed.signal;
      throw new Error("Package preparation failed");
    }
    if (!await ownsWorkspace()) throw new Error("Workspace changed");
    checkInterrupted();
    const archives = await readdir(pack);
    if (archives.length !== 1 || !archives[0].endsWith(".tgz")) throw new Error("Invalid prepared package");
    const archive = path.join(pack, archives[0]);
    const archiveEntry = await lstat(archive);
    if (!archiveEntry.isFile() || archiveEntry.isSymbolicLink() || await realpath(archive) !== archive) {
      throw new Error("Invalid prepared package");
    }
    await assertDestination();
    phase = "installing the global update";
    const installation = await runChild(npmExecutable, [
      "install", "--global", "--prefix", prefix, archive, "--no-audit", "--no-fund",
    ], env);
    if (installation.code !== 0 || installation.signal || interrupted) {
      code = resultCode(installation);
      childSignal = installation.signal;
      throw new Error("Global installation failed");
    }
    phase = "validating the global installation";
    if (!await ownsWorkspace()) throw new Error("Workspace changed");
    checkInterrupted();
    const executable = await installedApp();
    checkInterrupted();
    phase = "cleaning up the update";
    if (!await ownsWorkspace()) throw new Error("Workspace changed");
    await rm(workspace, { recursive: true });
    cleaned = true;
    checkInterrupted();
    phase = "starting the global installation";
    await report("Starting…\n");
    if (typeof process.execve !== "function") throw new Error("Process replacement is unavailable");
    process.execve(process.execPath, [process.execPath, executable, "--skills-dir", skillsDir], process.env);
    throw new Error("Process replacement returned unexpectedly");
  } catch {
    // Do not print npm or package output: it can contain credentials or terminal controls.
  } finally {
    if (!cleaned && cleanupSafe && await ownsWorkspace()) {
      try { await rm(workspace, { recursive: true }); cleaned = true; } catch { /* Report below. */ }
    }
    if (!cleaned) {
      await report(`Update staging may remain at ${displayPath(workspace)}; wait for any remaining processes before manual cleanup.\n`);
    }
    if (code === 0) code = 1;
    await report(`The update could not be completed while ${phase}.\nTo reinstall and start the app again, run:\n${recoveryCommand()}\n`);
  }
  const finalSignal = interrupted ?? signals.find((signal) => signal === childSignal);
  if (finalSignal) {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    process.exitCode = 128 + (constants.signals[finalSignal] ?? 1);
    process.kill(process.pid, finalSignal);
  } else {
    process.exitCode = code;
  }
}

await main();
