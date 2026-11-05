/// <reference lib="es2024.promise" />
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

type HandledSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
type ChildResult = { code: number | null; signal: NodeJS.Signals | null };
type ActiveChild = { child: ChildProcess; group: boolean; force?: NodeJS.Timeout };

const [workspace = "", npmExecutable = "", target = "", revision = "", skillsDir = ""] = process.argv.slice(2);
const registry = process.env.SKILLS_MANAGER_UPDATE_REGISTRY;
const device = process.env.SKILLS_MANAGER_UPDATE_DEVICE;
const inode = process.env.SKILLS_MANAGER_UPDATE_INODE;
delete process.env.SKILLS_MANAGER_UPDATE_REGISTRY;
delete process.env.SKILLS_MANAGER_UPDATE_DEVICE;
delete process.env.SKILLS_MANAGER_UPDATE_INODE;

const workerDirectory = path.dirname(fileURLToPath(import.meta.url));
const signals: HandledSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
let interrupted: HandledSignal | undefined;
let activeChild: ActiveChild | undefined;
let applicationStarted = false;
let cleanupSafe = true;

function sendSignal(active: ActiveChild, signal: NodeJS.Signals): void {
  const pid = active.child.pid;
  if (!pid) return;
  try { process.kill(active.group ? -pid : pid, signal); } catch { /* The child may already have exited. */ }
}

const signalHandlers = new Map<HandledSignal, () => void>();
for (const signal of signals) {
  const handler = () => {
    interrupted ??= signal;
    if (applicationStarted) cleanupSafe = false;
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

function recoveryCommand(value: string): string {
  const command = "npx --yes --prefer-online github:ederheisler/skills-manager --skills-dir";
  if (/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(value)) {
    const encoded = [...Buffer.from(value)].map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
    return `SKILLS_DIR=$(printf '%b.' '${encoded}'); ${command} "\${SKILLS_DIR%.}"`;
  }
  return `${command} '${value.replace(/'/g, `'"'"'`)}'`;
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

async function runChild(
  executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; group: boolean },
): Promise<ChildResult> {
  checkInterrupted();
  const child = spawn(executable, args, {
    cwd: options.cwd, env: options.env, detached: options.group,
    stdio: options.group ? "ignore" : "inherit",
  });
  if (!options.group && child.pid) applicationStarted = true;
  const active: ActiveChild = { child, group: options.group };
  activeChild = active;
  const { promise, resolve } = Promise.withResolvers<ChildResult>();
  let launchFailed = false;
  child.once("error", () => { launchFailed = true; });
  child.once("close", (code, signal) => resolve({ code, signal }));
  const result = await promise;
  clearTimeout(active.force);
  if (activeChild === active) activeChild = undefined;
  if (options.group && child.pid && !await stopNpmDescendants(child.pid)) {
    cleanupSafe = false;
    throw new Error("The install process group is still running");
  }
  if (!options.group && child.pid && (launchFailed || result.code !== 0 || result.signal || interrupted)) {
    // The foreground app can have children that outlive it; we cannot safely drain that group.
    cleanupSafe = false;
  }
  if (launchFailed) throw new Error("Unable to start child process");
  return result;
}

async function packageFromProject(
  project: string, resolver: NodeRequire, name: "skills-manager" | "skills",
): Promise<{ root: string; bin: unknown }> {
  const manifestFile = await realpath(resolver.resolve(`${name}/package.json`));
  const root = path.dirname(manifestFile);
  if (!contained(project, root) || !contained(project, manifestFile) || !(await stat(manifestFile)).isFile()) {
    throw new Error("Package is outside the private project");
  }
  const manifest: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || !("name" in manifest) || manifest.name !== name) throw new Error("Invalid package identity");
  return { root, bin: "bin" in manifest ? manifest.bin : undefined };
}

async function executableWithin(root: string, relative: unknown): Promise<string> {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) throw new Error("Invalid executable");
  const candidate = path.resolve(root, relative);
  if (!contained(root, candidate)) throw new Error("Executable escapes its package");
  const canonical = await realpath(candidate);
  if (!contained(root, canonical) || !(await stat(canonical)).isFile()) throw new Error("Invalid executable");
  return canonical;
}

async function installedApp(project: string): Promise<string> {
  const projectEntry = await lstat(project);
  if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink() || await realpath(project) !== project) {
    throw new Error("Invalid private project");
  }
  const resolver = createRequire(path.join(project, "package.json"));
  const app = await packageFromProject(project, resolver, "skills-manager");
  const selectedSkills = await packageFromProject(project, resolver, "skills");
  const declaredBin = app.bin;
  const bin = typeof declaredBin === "string" ? declaredBin
    : typeof declaredBin === "object" && declaredBin !== null && !Array.isArray(declaredBin)
      && "skills-manager" in declaredBin ? declaredBin["skills-manager"] : undefined;
  const executable = await executableWithin(app.root, bin);
  const inspectorFile = await executableWithin(app.root, "dist/actions/sandbox.js");
  // This must load the newly installed app's own runtime-selected inspector.
  const inspector: unknown = await import(pathToFileURL(inspectorFile).href);
  if (typeof inspector !== "object" || inspector === null || !("inspectSkillsRuntime" in inspector)
    || typeof inspector.inspectSkillsRuntime !== "function") throw new Error("Missing runtime inspector");
  const pending: unknown = inspector.inspectSkillsRuntime();
  if (!(pending instanceof Promise)) throw new Error("Invalid runtime inspector");
  const inspection: unknown = await pending;
  if (typeof inspection !== "object" || inspection === null || Array.isArray(inspection)
    || !("packageRoot" in inspection) || typeof inspection.packageRoot !== "string"
    || !path.isAbsolute(inspection.packageRoot) || await realpath(inspection.packageRoot) !== selectedSkills.root) {
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
  let failure = true;
  let phase = "preparing the private workspace";
  let childSignal: NodeJS.Signals | null = null;
  await report(`Update workspace (manual cleanup if interrupted): ${displayPath(workspace)}\n`);
  try {
    if (!await ownsWorkspace() || !path.isAbsolute(npmExecutable) || !path.isAbsolute(skillsDir)
      || (target !== "all" && target !== "cli") || (revision !== "main" && !/^[0-9a-f]{40}$/i.test(revision))
      || !registry || !["http:", "https:"].includes(new URL(registry).protocol)) {
      throw new Error("Invalid approved update");
    }
    checkInterrupted();
    const project = path.join(workspace, "project");
    const cache = path.join(workspace, "cache");
    const temporary = path.join(workspace, "tmp");
    await mkdir(project, { mode: 0o700 });
    await chmod(project, 0o700);
    await mkdir(cache, { mode: 0o700 });
    await chmod(cache, 0o700);
    await mkdir(temporary, { mode: 0o700 });
    await chmod(temporary, 0o700);
    await writeFile(path.join(project, "package.json"), JSON.stringify({
      private: true,
      dependencies: { "skills-manager": `github:ederheisler/skills-manager#${revision}`, skills: "latest" },
      overrides: { skills: "$skills" },
    }), { flag: "wx", mode: 0o600 });
    phase = "installing the update";
    await report("Installing the approved update in a private session.\n");
    const installation = await runChild(npmExecutable, ["install", "--prefer-online", "--no-audit", "--no-fund"], {
      cwd: project, env: npmEnvironment(cache, temporary), group: true,
    });
    if (installation.code !== 0 || installation.signal || interrupted) {
      code = resultCode(installation);
      childSignal = installation.signal;
      throw new Error("Installation failed");
    }
    phase = "validating the staged update";
    if (!await ownsWorkspace()) throw new Error("Workspace changed");
    checkInterrupted();
    const executable = await installedApp(project);
    if (!await ownsWorkspace()) throw new Error("Workspace changed");
    checkInterrupted();
    phase = "starting or running the new application";
    await report("Starting the new application.\n");
    const application = await runChild(process.execPath, [executable, "--skills-dir", skillsDir], { group: false });
    if (application.code !== 0 || application.signal || interrupted) {
      code = resultCode(application);
      childSignal = application.signal;
      throw new Error("Application failed");
    }
    code = 0;
    failure = false;
  } catch {
    failure = true;
  } finally {
    if (!failure) phase = "cleaning up the workspace";
    const owned = cleanupSafe && await ownsWorkspace();
    if (owned && cleanupSafe) {
      try { await rm(workspace, { recursive: true }); } catch { cleanupSafe = false; }
    } else {
      cleanupSafe = false;
    }
    if (!cleanupSafe) {
      failure = true;
      if (code === 0) code = 1;
      await report(`Update workspace may remain at ${displayPath(workspace)}; wait for any remaining processes before manual cleanup.\n`);
    }
    if (failure || interrupted) {
      if (code === 0) code = 1;
      await report(`The update could not be completed while ${phase}.\nTo start the app again, run:\n${recoveryCommand(skillsDir)}\n`);
    }
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
