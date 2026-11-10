import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isRecord } from "../state/validation.js";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);

interface RuntimePackage { name: string; root: string }
interface PackageLocation {
  version: string;
  packageRoot: string;
  executable: string;
  relativeExecutable: string;
  packages: RuntimePackage[];
}
interface MacGit {
  executable: string;
  resolvedExecutable: string;
  runtimeDirectories: string[];
}

async function packageRoot(name: string, requester: string): Promise<string> {
  let entry: string;
  try { entry = createRequire(requester).resolve(name); }
  catch { throw new Error(`The skills runtime dependency ${name} is unavailable.`); }
  let current = path.dirname(await realpath(entry));
  for (;;) {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(current, "package.json"), "utf8"));
      if (isRecord(value) && value.name === name) return current;
    } catch { /* Continue from a nested package entry point. */ }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot locate the skills runtime dependency ${name}.`);
    current = parent;
  }
}

async function locatePackage(): Promise<PackageLocation> {
  let manifest: string;
  try { manifest = await realpath(fileURLToPath(import.meta.resolve("skills/package.json"))); }
  catch { throw new Error("The required skills package is unavailable."); }
  let value: unknown;
  try { value = JSON.parse(await readFile(manifest, "utf8")); }
  catch { throw new Error("The required skills package has an unreadable manifest."); }
  if (!isRecord(value) || value.name !== "skills") {
    throw new Error("The installed skills package has an invalid identity.");
  }
  const bin = typeof value.bin === "string" ? value.bin : isRecord(value.bin) ? value.bin.skills : undefined;
  if (typeof bin !== "string" || !bin || path.isAbsolute(bin)) {
    throw new Error("The installed skills package has an invalid executable entry.");
  }
  const root = path.dirname(manifest);
  const candidate = path.resolve(root, bin);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error("The skills executable escapes its package.");
  const executable = await realpath(candidate);
  if (!executable.startsWith(`${root}${path.sep}`)) throw new Error("The skills executable escapes its package.");
  if (!(await stat(executable)).isFile()) throw new Error("The installed skills package has an invalid executable entry.");
  await access(executable, constants.R_OK);
  const packages = new Map<string, string>([["skills", root]]);
  const queue: RuntimePackage[] = [{ name: "skills", root }];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const packageManifest = path.join(current.root, "package.json");
    let data: unknown;
    try { data = JSON.parse(await readFile(packageManifest, "utf8")); }
    catch { throw new Error(`Cannot read runtime dependency ${current.name}.`); }
    if (!isRecord(data) || (data.dependencies !== undefined && !isRecord(data.dependencies))) {
      throw new Error(`Invalid runtime dependencies for ${current.name}.`);
    }
    for (const name of Object.keys(data.dependencies ?? {})) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error("Invalid runtime package name.");
      const dependencyRoot = await packageRoot(name, packageManifest);
      const existing = packages.get(name);
      if (existing && existing !== dependencyRoot) throw new Error(`Cannot safely isolate conflicting versions of runtime dependency ${name}.`);
      if (!existing) { packages.set(name, dependencyRoot); queue.push({ name, root: dependencyRoot }); }
    }
  }
  const version = typeof value.version === "string" && value.version.length <= 256
    && value.version.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value.version)
    ? value.version : "unknown";
  return { version, packageRoot: root, executable, relativeExecutable: path.relative(root, executable), packages: queue };
}

export async function inspectSkillsRuntime(): Promise<{ version: string; packageRoot: string; executable: string }> {
  const { version, packageRoot, executable } = await locatePackage();
  return { version, packageRoot, executable };
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}

function macProfile(workspace: string, packages: RuntimePackage[], node: string, libraries: string[], source?: string, git?: MacGit): string {
  const readable = ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share", "/System/Library",
    "/Library/Apple", "/Library/Developer/CommandLineTools/usr", "/bin", "/sbin",
    "/private/etc/resolv.conf", "/private/etc/hosts", "/private/etc/nsswitch.conf", "/private/etc/ssl/cert.pem",
    "/private/etc/ssl/certs", "/private/var/run/mDNSResponder", "/dev/null", "/dev/random", "/dev/urandom", "/dev/fd",
    workspace, node, ...libraries, ...packages.map((entry) => entry.root)];
  if (source) readable.push(source);
  if (git) readable.push(...git.runtimeDirectories);
  const readableFiles = git ? ["/private/etc/ssl/openssl.cnf", git.executable, git.resolvedExecutable] : [];
  const ancestors = new Set<string>();
  for (const entry of [...readable, ...readableFiles]) {
    let parent = path.dirname(entry);
    while (parent !== "/") { ancestors.add(parent); parent = path.dirname(parent); }
  }
  return [
    "(version 1)", "(deny default)",
    "(allow process*)", "(allow sysctl-read)",
    // Recent macOS dyld opens the filesystem root during startup. Grant access
    // to that directory alone, not the tree below it.
    '(allow file-read-data (literal "/"))',
    // Resolver and TLS paths pass through these system symlinks.
    '(allow file-read-metadata (literal "/var") (literal "/etc"))',
    ...[...ancestors].map((entry) => `(allow file-read-metadata (literal ${seatbeltString(entry)}))`),
    ...readable.map((entry) => `(allow file-read* (subpath ${seatbeltString(entry)}))`),
    ...readableFiles.map((entry) => `(allow file-read* (literal ${seatbeltString(entry)}))`),
    `(allow file-write* (subpath ${seatbeltString(workspace)}))`,
    '(allow file-write* (literal "/dev/null"))',
    "(allow network-outbound)",
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.mDNSResponder") (global-name "com.apple.trustd.agent"))',
  ].join("\n");
}

function linuxArguments(workspace: string, location: PackageLocation, node: string, source?: string): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-user", "--disable-userns", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--proc", "/proc", "--dev", "/dev", "--dir", "/app", "--dir", "/app/node_modules", "--dir", "/workspace", "--dir", "/etc",
    "--dir", "/usr", "--dir", "/usr/share", "--ro-bind-try", "/usr/bin", "/usr/bin",
    "--ro-bind-try", "/usr/sbin", "/usr/sbin", "--ro-bind-try", "/usr/lib", "/usr/lib", "--ro-bind-try", "/usr/lib64", "/usr/lib64",
    "--ro-bind-try", "/usr/share/git-core", "/usr/share/git-core", "--ro-bind-try", "/usr/share/ca-certificates", "/usr/share/ca-certificates",
    "--ro-bind-try", "/bin", "/bin", "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/pki", "/etc/pki",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf", "--ro-bind-try", "/etc/hosts", "/etc/hosts",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf", "--ro-bind", node, "/app/node", "--bind", workspace, "/workspace"];
  const scopes = new Set(location.packages.filter((entry) => entry.name.startsWith("@")).map((entry) => entry.name.split("/")[0]));
  for (const scope of scopes) args.push("--dir", `/app/node_modules/${scope}`);
  for (const entry of location.packages) args.push("--ro-bind", entry.root, `/app/node_modules/${entry.name}`);
  if (source) args.push("--ro-bind", source, "/source");
  args.push("--remount-ro", "/");
  return args;
}

function cleanEnvironment(workspace: string): NodeJS.ProcessEnv {
  return {
    HOME: `${workspace}/home`, XDG_CONFIG_HOME: `${workspace}/config`, XDG_CACHE_HOME: `${workspace}/cache`,
    XDG_DATA_HOME: `${workspace}/data`, XDG_STATE_HOME: `${workspace}/state`, TMPDIR: `${workspace}/tmp`,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0",
    DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", NODE_DISABLE_COMPILE_CACHE: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ALLOW_PROTOCOL: "https:http:file", LANG: "C.UTF-8",
  };
}

async function selectedMacGit(workspace: string, env: NodeJS.ProcessEnv): Promise<MacGit> {
  const options = { cwd: workspace, env, encoding: "utf8" as const, timeout: 10_000 };
  const selected = await execFileAsync("/usr/bin/xcode-select", ["--print-path"], options);
  const developer = await realpath(selected.stdout.trim());
  if (developer.includes(":") || !(developer.startsWith("/Library/Developer/")
    || /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(developer))) {
    throw new Error("The selected developer tools are not in a trusted system location.");
  }
  const usr = path.join(developer, "usr");
  const executable = path.join(usr, "bin", "git");
  const [resolvedExecutable, ...runtimeDirectories] = await Promise.all([
    realpath(executable), realpath(path.join(usr, "libexec", "git-core")), realpath(path.join(usr, "share", "git-core")),
  ]);
  if ([resolvedExecutable, ...runtimeDirectories].some((entry) => !entry.startsWith(`${usr}${path.sep}`))) {
    throw new Error("The selected developer Git runtime escapes its trusted system location.");
  }
  await execFileAsync("/usr/bin/codesign", [
    "--verify", "--strict", "--requirement", '=anchor apple and identifier "com.apple.git"', resolvedExecutable,
  ], options);
  return { executable, resolvedExecutable, runtimeDirectories };
}

async function invoke(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, allowCheckExit = false): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: string | undefined;
    let settled = false;
    const killGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* It has already exited. */ }
      }
    };
    const timeout = setTimeout(() => { failure = "Upstream command timed out."; killGroup(); }, TIMEOUT_MS);
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) { failure = "Upstream command exceeded its output limit."; killGroup(); }
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("The required operating-system sandbox could not be launched."));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killGroup();
      if (failure) return reject(new Error(failure));
      if (code !== 0 && !(allowCheckExit && code === 1 && !signal)) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
        return reject(new Error(`Confined upstream command failed${signal ? ` (${signal})` : ` (exit ${code})`}${diagnostic ? `: ${diagnostic}` : "."}`));
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

/**
 * Execute the installed CLI with direct filesystem access confined to the listed
 * paths. Network access, including loopback, is available for explicit remote
 * operations; this is not an arbitrary-code or network-isolation boundary.
 */
export async function runConfinedSkills(workspace: string, args: string[], localSource?: string): Promise<{ stdout: string; stderr: string }> {
  const location = await locatePackage();
  if (process.versions.bun) throw new Error("Remote actions require the Node runtime used by this package.");
  const node = await realpath(process.execPath);
  const root = await realpath(workspace);
  if (process.platform === "darwin") {
    const report = process.report.getReport() as { sharedObjects?: unknown };
    const shared = Array.isArray(report.sharedObjects)
      ? report.sharedObjects.filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry))
      : [];
    const libraries = await Promise.all(shared.map((entry) => realpath(entry).catch(() => entry)));
    const env = cleanEnvironment(root);
    const source = args[0] === "add" ? args[1] : undefined;
    const remote = args[0] === "check" || args[0] === "update" || (source && !localSource && !path.isAbsolute(source) && !source.startsWith("./") && !source.startsWith("../"));
    const git = remote ? await selectedMacGit(root, env) : undefined;
    if (git) env.PATH = `${path.dirname(git.executable)}:${env.PATH}`;
    return invoke("/usr/bin/sandbox-exec", ["-p", macProfile(root, location.packages, node, libraries, localSource, git), node, location.executable, ...args], root, env, args[0] === "check" || args[0] === "update");
  }
  if (process.platform === "linux") {
    // No host home, runtime sockets, or credentials are mounted in this namespace.
    const sandboxArgs = linuxArguments(root, location, node, localSource);
    sandboxArgs.push("--chdir", "/workspace", "--", "/app/node", path.join("/app/node_modules/skills", location.relativeExecutable), ...args);
    return invoke("bwrap", sandboxArgs, root, cleanEnvironment("/workspace"), args[0] === "check" || args[0] === "update");
  }
  throw new Error("Remote actions require macOS sandbox-exec or Linux bubblewrap; this platform is unsupported.");
}
