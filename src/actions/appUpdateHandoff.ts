/// <reference lib="es2024.promise" />
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quoteTerminalPath } from "../terminalText.js";
import type { BuildIdentity } from "../state/appBuild.js";

export type UpdateTarget = "all" | "cli";

export interface PreparedUpdateHandoff {
  workspace: string;
  helperPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

const CONFIG_TIMEOUT_MS = 5_000;
const CONFIG_OUTPUT_LIMIT = 512 * 1024;
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

async function npmExecutable(): Promise<string> {
  for (const entry of (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    const candidate = path.resolve(entry || ".", "npm");
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      await access(resolved, constants.X_OK);
      return resolved;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("npm is required to start an update session.");
}

function readNpmConfig(npm: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(npm, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [];
  let size = 0;
  let failed = false;
  let settled = false;
  const killGroup = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => { failed = true; killGroup(); }, CONFIG_TIMEOUT_MS);
  const collect = (chunk: Buffer, keep: boolean) => {
    size += chunk.length;
    if (size > CONFIG_OUTPUT_LIMIT) { failed = true; killGroup(); }
    else if (keep) output.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  child.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error("npm configuration query failed."));
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    killGroup();
    if (failed || code !== 0) reject(new Error("npm configuration query failed."));
    else resolve(Buffer.concat(output).toString("utf8"));
  });
  return promise;
}

// npm deliberately refuses `config get registry` for URLs containing
// credentials. An environment override has the highest applicable config
// precedence for our empty project, and npm uses the last nonempty matching
// environment entry. Leave interpolated values to npm instead of guessing.
function protectedEnvironmentRegistry(env: NodeJS.ProcessEnv): string | undefined {
  let value: string | undefined;
  for (const [name, entry] of Object.entries(env)) {
    if (name.toLowerCase() === "npm_config_registry" && entry !== undefined && entry !== "") value = entry.trim();
  }
  if (!value || value.includes("${")) return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

async function npmConfig(npm: string, key: "registry" | "cache"): Promise<string> {
  const env = { ...process.env };
  // npm and the upstream CLI enable Node's compile cache on startup. Keep
  // even user-configured cache locations untouched during this read-only query.
  env.NODE_DISABLE_COMPILE_CACHE = "1";
  for (const name of Object.keys(env)) {
    if (/^npm_config_(?:loglevel|logs_max|timing|update_notifier)$/i.test(name)) delete env[name];
  }
  env.npm_config_loglevel = "silent";
  env.npm_config_logs_max = "0";
  env.npm_config_update_notifier = "false";
  env.npm_config_timing = "false";
  try {
    if (key === "registry") {
      const protectedRegistry = protectedEnvironmentRegistry(env);
      if (protectedRegistry !== undefined) return validateRegistry(protectedRegistry);
    }
    // npm creates its configured cache even for `config get`. An existing
    // character device cannot become a cache directory, so this query makes
    // no filesystem writes. Global mode skips project .npmrc while still
    // reading the user and global configuration used by our empty project.
    if (!(await stat("/dev/null")).isCharacterDevice()) throw new Error("Missing null device.");
    const command = key === "registry" ? ["config", "get", "registry"] : ["config", "list", "--long"];
    const stdout = await readNpmConfig(npm, [
      ...command, "--cache", "/dev/null", "--logs-dir", "/dev/null", "--global",
    ], path.parse(process.execPath).root, env);
    const result = key === "registry" ? stdout.trim() : configuredCache(stdout);
    if (!result || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("Invalid npm configuration.");
    return result;
  } catch {
    // npm output may contain credentials. Never surface it in an error.
    throw new Error(`Could not determine the npm ${key} configuration.`);
  }
}

// npm's long listing retains the normalized values from every config layer,
// including entries overridden by our temporary --cache. Read the first
// original effective layer; never display the listing, which may contain
// unrelated private configuration.
function configuredCache(output: string): string {
  const values = new Map<string, string>();
  let layer = "";
  for (const line of output.split(/\r?\n/)) {
    const header = /^; "([^"]+)" config from /.exec(line);
    if (header) { layer = header[1]; continue; }
    const entry = /^(?:; )?cache = (.+?)(?: ; overridden by [^;]+)?$/.exec(line);
    if (!entry || !layer || layer === "cli") continue;
    const value: unknown = JSON.parse(entry[1]);
    if (typeof value === "string") values.set(layer, value);
  }
  for (const name of ["env", "project", "user", "global", "builtin", "default"]) {
    const value = values.get(name);
    if (value) return value;
  }
  throw new Error("Missing cache configuration.");
}

function validateRegistry(value: string): string {
  try {
    if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error("Invalid registry.");
    const registry = new URL(value);
    if ((registry.protocol !== "https:" && registry.protocol !== "http:")
      || !registry.hostname || registry.search || registry.hash) throw new Error("Invalid registry.");
    return registry.href;
  } catch {
    throw new Error("The configured npm registry is unavailable or invalid.");
  }
}

function registryScope(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

/** Resolve the same user-configured registry that the private npm project will use. */
export async function resolveUpdateRegistry(): Promise<string> {
  return validateRegistry(await npmConfig(await npmExecutable(), "registry"));
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Canonicalize existing ancestors too, so a not-yet-created cache behind a link
// cannot accidentally be treated as a different location.
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

async function checkoutRoot(packageRoot: string): Promise<string | undefined> {
  let current = packageRoot;
  for (;;) {
    try {
      await lstat(path.join(current, ".git"));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function removeOwnedWorkspace(workspace: string, device: bigint, inode: bigint): Promise<void> {
  let current;
  try { current = await lstat(workspace, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== device || current.ino !== inode) {
    throw new Error("Update workspace identity changed; it was not removed.");
  }
  await rm(workspace, { recursive: true, force: true });
}

async function privateWorkspace(prefix: string, excludedRoots: readonly string[]): Promise<{
  workspace: string; device: bigint; inode: bigint; cleanup(): Promise<void>;
}> {
  if (excludedRoots.some((root) => !path.isAbsolute(root) || root.includes("\0"))) {
    throw new Error("Known skills directories must be absolute paths.");
  }
  const packageRoot = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  const checkout = await checkoutRoot(packageRoot);
  const home = homedir();
  const environmentCaches = Object.entries(process.env)
    .filter(([name, value]) => /^npm_config_(?:cache|logs_dir)$/i.test(name) && value && path.isAbsolute(value))
    .map(([, value]) => value!);
  const protectedPaths = await Promise.all([
    ...excludedRoots,
    packageRoot,
    ...(checkout ? [checkout] : []),
    path.join(home, ".npm"),
    process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME)
      ? process.env.XDG_CACHE_HOME : path.join(home, ".cache"),
    ...(process.platform === "darwin" ? [path.join(home, "Library", "Caches")] : []),
    ...environmentCaches,
  ].map(canonicalPath));
  let workspace: string | undefined;
  for (const candidate of [tmpdir(), "/tmp", "/var/tmp"]) {
    try {
      const parent = await realpath(candidate);
      if (protectedPaths.some((root) => isWithin(parent, root)) || await checkoutRoot(parent)) continue;
      workspace = await mkdtemp(path.join(parent, prefix));
      break;
    } catch { /* Try another existing temporary directory. */ }
  }
  if (!workspace) throw new Error("No private temporary location outside the app, cache, checkout, and skills directory is available.");
  let identity;
  try { identity = await lstat(workspace, { bigint: true }); }
  catch {
    throw new Error(`Cannot identify the private workspace; inspect it manually: ${quoteTerminalPath(workspace)}`);
  }
  const cleanup = () => removeOwnedWorkspace(workspace!, identity.dev, identity.ino);
  try { await chmod(workspace, 0o700); }
  catch {
    try { await cleanup(); }
    catch { throw new Error(`Could not clean the private workspace: ${quoteTerminalPath(workspace)}`); }
    throw new Error("Could not secure the private temporary workspace.");
  }
  return { workspace, device: identity.dev, inode: identity.ino, cleanup };
}

/** Prepare an independent helper without downloading, installing, or shutting down the app. */
export async function prepareUpdateHandoff(options: {
  target: UpdateTarget;
  skillsDir: string;
  build: BuildIdentity;
  registry: string;
  allowSwitchToMain?: boolean;
  excludedRoots?: readonly string[];
}): Promise<PreparedUpdateHandoff> {
  if (typeof process.execve !== "function") throw new Error("This Node runtime cannot replace the app process.");
  if (options.target !== "all" && options.target !== "cli") throw new Error("Invalid update target.");
  if (!path.isAbsolute(options.skillsDir) || options.skillsDir.includes("\0")) {
    throw new Error("The selected skills directory must be an absolute path.");
  }
  if (options.excludedRoots?.some((root) => !path.isAbsolute(root) || root.includes("\0"))) {
    throw new Error("Known skills directories must be absolute paths.");
  }
  let skillsDir: string;
  try {
    skillsDir = await realpath(options.skillsDir);
    if (!(await stat(skillsDir)).isDirectory()) throw new Error("Not a directory.");
  } catch {
    throw new Error("The selected skills directory is unavailable.");
  }
  const registry = validateRegistry(options.registry);
  const reproducible = options.build.source !== "unknown" && !options.build.dirty
    && typeof options.build.commit === "string" && FULL_COMMIT.test(options.build.commit);
  if (options.target === "cli" && !reproducible && !options.allowSwitchToMain) {
    throw new Error("This build cannot be reproduced; explicitly choose switch to main or use the manual route.");
  }
  const revision = options.target === "cli" && reproducible ? options.build.commit! : "main";
  const npm = await npmExecutable();
  const currentRegistry = validateRegistry(await npmConfig(npm, "registry"));
  if (registryScope(currentRegistry) !== registryScope(registry)) {
    throw new Error("The npm registry changed since approval; review the update again.");
  }
  const cache = await npmConfig(npm, "cache");
  if (!path.isAbsolute(cache)) throw new Error("The npm cache location is unavailable or invalid.");
  const packageRoot = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  const worker = path.join(packageRoot, "dist", "actions", "appUpdateWorker.js");
  try {
    if (!(await stat(worker)).isFile()) throw new Error("Not a file.");
    await access(worker, constants.R_OK);
  } catch {
    throw new Error("The built update helper is unavailable; build the app or use the manual route.");
  }
  const { workspace, device, inode, cleanup } = await privateWorkspace(
    "skills-manager-update-", [skillsDir, ...(options.excludedRoots ?? []), cache],
  );
  try {
    const helperPath = path.join(workspace, "app-update-worker.mjs");
    await copyFile(worker, helperPath, constants.COPYFILE_EXCL);
    await chmod(helperPath, 0o600);
    return {
      workspace,
      helperPath,
      args: [workspace, npm, options.target, revision, skillsDir],
      env: {
        ...process.env,
        // This must be set before execve: the helper, npm, and the relaunched
        // application all inherit it and must not write an external Node cache.
        NODE_DISABLE_COMPILE_CACHE: "1",
        SKILLS_MANAGER_UPDATE_REGISTRY: registry,
        SKILLS_MANAGER_UPDATE_DEVICE: device.toString(),
        SKILLS_MANAGER_UPDATE_INODE: inode.toString(),
      },
      cleanup,
    };
  } catch {
    try { await cleanup(); }
    catch { throw new Error(`Could not clean the private update workspace; inspect it manually: ${quoteTerminalPath(workspace)}`); }
    throw new Error("Could not prepare the private update helper.");
  }
}

/** Call only after the application's awaited shutdown and terminal restoration. */
export function executeUpdateHandoff(prepared: PreparedUpdateHandoff): never {
  if (typeof process.execve !== "function") throw new Error("This Node runtime cannot replace the app process.");
  return process.execve(process.execPath, [process.execPath, prepared.helperPath, ...prepared.args], prepared.env);
}
