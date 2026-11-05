import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { scanSkills } from "../state/repo.js";
import { assertApprovedSkillsRoot, cleanupGitIndex, hasIndexTransaction, inspectGitIndex, readSkillPath, withSkillsLock, type ApprovedSkillsRoot } from "./boundary.js";
import { runConfinedGit } from "./gitBoundary.js";
import { commitIndexTransaction, indexFingerprint as readIndexFingerprint, pullIndexWorktreeTransaction, recoverIndexTransaction } from "./gitTransaction.js";

export interface GitResult { command: string; stdout: string; stderr: string; exitCode: number }
export interface GitDiscovery {
  kind: "leaf" | "parent" | "none" | "unavailable" | "error";
  selectedDir: string;
  topLevel: string | null;
  gitDir: string | null;
  commonDir: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  remotes: string[];
  error: string | null;
  parentTracked?: boolean;
  parentExcluded?: boolean;
  exclusionFile?: string;
}
export interface GitStatusEntry { path: string; status: string }
export interface GitFileIdentity { dev: string; ino: string }
export interface GitBinding {
  root: GitFileIdentity;
  repositoryRoot: string;
  repositoryIdentity: GitFileIdentity;
  prefix: string;
  gitEntry: GitFileIdentity;
  gitDir: string;
  gitDirIdentity: GitFileIdentity;
  commonDir: string;
  commonDirIdentity: GitFileIdentity;
}
export interface InitializePreview { root: string; parent: string | null; parentTracked: boolean; parentExcluded: boolean; exclusionFile: string | null; rootIdentity: GitFileIdentity; fingerprint: string }
export interface RemotePreview { root: string; name: string; url: string; gitDir: string; commonDir: string; binding: GitBinding; fingerprint: string }
export interface CommitPreview { root: string; paths: string[]; blockingPaths: string[]; head: string | null; branch: string | null; binding: GitBinding; indexFingerprint: string | null; fingerprint: string }
export interface GitCommit { id: string; subject: string; paths: string[] }
export interface FetchPreview { root: string; remote: string; fetchUrl: string; branch: string; destination: string; binding: GitBinding; fingerprint: string }
export interface PushPreview {
  root: string; remote: string; pushUrl: string; branch: string; upstream: string | null;
  destination: string; head: string; outgoing: GitCommit[]; approvedPaths: string[];
  warning: string; binding: GitBinding; localRemote: { path: string; identity: GitFileIdentity } | null; fingerprint: string;
}
export interface PullPreview {
  root: string; remote: string; fetchUrl: string; branch: string; upstream: string;
  destination: string; head: string; target: string; commits: GitCommit[]; paths: string[];
  approvedPaths: string[]; binding: GitBinding; fingerprint: string;
}

interface CommandResult extends GitResult { missing?: boolean }
interface FileSnapshot { path: string; mode: string | null; data: Buffer | null; identity: string; blocked?: boolean }
interface MutationBoundary {
  approved: ApprovedSkillsRoot;
  rootIdentity: GitFileIdentity;
  binding?: GitBinding;
  remote?: { path: string; identity: GitFileIdentity } | null;
}

function mutation(approved: ApprovedSkillsRoot, binding: GitBinding, remote?: MutationBoundary["remote"]): MutationBoundary {
  return { approved, rootIdentity: binding.root, binding, remote };
}

const config = [
  "--no-lazy-fetch", "--no-replace-objects", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.sharedRepository=0",
  "-c", "core.pager=cat", "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
  "-c", "log.showSignature=false", "-c", "merge.verifySignatures=false", "-c", "submodule.recurse=false", "-c", "credential.helper=", "-c", "protocol.allow=never",
  "-c", "protocol.file.allow=always", "-c", "protocol.ssh.allow=always",
  "-c", "protocol.http.allow=always", "-c", "protocol.https.allow=always", "-c", "protocol.git.allow=always",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "merge.autoStash=false", "-c", "push.pushOption=",
  "-c", "core.sshCommand=/dev/null",
];

export function redactGitUrl(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b[^\s/@:]+@([^\s/:]+):/g, "[redacted]@$1:")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[redacted]");
}

function validateRemoteTransport(url: string): void {
  if (!url || url.startsWith("-") || /[\r\n\0]/.test(url) || /^[a-z][a-z0-9+.-]*::/i.test(url)) {
    throw new Error("Unsupported Git remote transport");
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1].toLowerCase();
  if (scheme && !["file", "ssh", "http", "https", "git"].includes(scheme)) {
    throw new Error(`Unsupported Git remote transport: ${scheme}`);
  }
}

function readGitReference(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 65536) throw new Error("Invalid Git metadata reference");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Incomplete Git metadata reference");
      offset += count;
    }
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, "");
    if (!value || /[\r\n\0]/.test(value)) throw new Error("Invalid Git metadata reference");
    return value;
  } finally {
    closeSync(fd);
  }
}

function untrustedGitDirectories(root: string): string[] {
  const blocked = [root];
  // Discovery itself must not execute a Git binary supplied by a containing
  // repository or its linked metadata before Git has reported the top level.
  for (let directory = root; ; directory = path.dirname(directory)) {
    const entry = path.join(directory, ".git");
    try {
      lstatSync(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (path.dirname(directory) === directory) break;
        continue;
      }
      throw error;
    }
    blocked.push(directory);
    const resolved = realpathSync(entry);
    const info = statSync(resolved);
    let gitDir: string;
    if (info.isDirectory()) gitDir = resolved;
    else {
      const reference = readGitReference(resolved);
      if (!reference.startsWith("gitdir: ")) throw new Error("Invalid Git directory reference");
      gitDir = realpathSync(path.resolve(directory, reference.slice(8)));
    }
    blocked.push(gitDir);
    let common: string | null = null;
    try { common = readGitReference(path.join(gitDir, "commondir")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (common !== null) blocked.push(realpathSync(path.resolve(gitDir, common)));
    if (path.dirname(directory) === directory) break;
  }
  return blocked;
}

function environment(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const blocked = untrustedGitDirectories(root);
  const executablePath = (env.PATH ?? "").split(path.delimiter)
    .filter((entry) => {
      if (!entry || !path.isAbsolute(entry)) return false;
      try {
        const directory = realpathSync(entry);
        if (blocked.some((base) => inside(directory, base))) return false;
        try {
          const executable = realpathSync(path.join(directory, "git"));
          return !blocked.some((base) => inside(executable, base));
        }
        catch { return true; } // The directory can still provide SSH or Git helpers.
      } catch { return false; }
    }).join(path.delimiter) || "/dev/null";
  return { ...env, PATH: executablePath, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "", ...extra, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
}

function decodeGitOutput(output: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output); }
  catch { throw new Error("Git returned non-UTF-8 output; the affected filename or value cannot be safely represented"); }
}

async function run(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer; filters?: boolean; label?: string; redact?: boolean; boundary?: MutationBoundary } = {}): Promise<CommandResult> {
  const overrides: string[] = [];
  if (options.filters) {
    const found = await run(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
    if (found.exitCode !== 0 && found.exitCode !== 1) throw new Error(found.stderr || "Cannot inspect Git filters");
    const names = new Set(found.stdout.split("\0").filter(Boolean).map((key) => key.slice(7, key.lastIndexOf("."))));
    for (const name of names) {
      for (const key of ["clean", "smudge", "process"]) overrides.push("-c", `filter.${name}.${key}=`);
      overrides.push("-c", `filter.${name}.required=false`);
    }
  }
  // Do not put arguments in diagnostics: remote URLs and commit messages can contain secrets.
  const command = `git ${options.label ?? args[0] ?? "command"}`;
  try {
    if (options.boundary) {
      const { approved, rootIdentity, binding, remote } = options.boundary;
      const result = await runConfinedGit(root, [...config, ...overrides, ...args], {
        env: environment(binding?.repositoryRoot ?? root, options.env), input: options.input,
        expectedRoot: { ...rootIdentity, identity: approved.identity },
        ...(binding ? {
          repositoryRoot: binding.repositoryRoot, expectedRepositoryRoot: binding.repositoryIdentity,
          gitDir: binding.gitDir, expectedGitDir: binding.gitDirIdentity, expectedGitEntry: binding.gitEntry,
          commonDir: binding.commonDir, expectedCommonDir: binding.commonDirIdentity,
        } : {}),
        ...(remote ? { remoteDir: remote.path, expectedRemoteDir: remote.identity } : {}),
      });
      return {
        command, stdout: options.redact ? redactGitUrl(result.stdout) : result.stdout,
        stderr: redactGitUrl(result.stderr), exitCode: result.exitCode,
      };
    }
    const result = await execa("git", [...config, ...overrides, ...args], {
      cwd: root, env: environment(root, options.env), extendEnv: false, reject: false,
      encoding: "buffer", stripFinalNewline: false, ...(options.input ? { input: options.input } : {}),
    });
    const stdout = decodeGitOutput(result.stdout ?? new Uint8Array());
    const stderr = new TextDecoder().decode(result.stderr);
    return {
      command,
      stdout: options.redact ? redactGitUrl(stdout) : stdout,
      stderr: redactGitUrl(stderr || result.originalMessage || ""),
      exitCode: result.exitCode ?? 1,
      missing: result.code === "ENOENT" || result.code === "ENOTDIR",
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return { command, stdout: "", stderr: redactGitUrl(err.message || String(error)), exitCode: 1, missing: err.code === "ENOENT" || err.code === "ENOTDIR" };
  }
}

// Commands that need the raw URL must never return it through public diagnostics.
async function rawRemoteUrl(root: string, remote: string, push: boolean): Promise<string> {
  const args = ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "--", remote];
  try {
    const result = await execa("git", [...config, ...args], { cwd: root, env: environment(root), extendEnv: false, reject: false, encoding: "buffer", stripFinalNewline: false });
    if (result.exitCode !== 0) throw new Error(redactGitUrl(new TextDecoder().decode(result.stderr)) || "Cannot resolve Git remote URL");
    const urls = decodeGitOutput(result.stdout).replace(/\n$/, "").split("\n");
    if (urls.length !== 1 || !urls[0] || /[\r\n\0]/.test(urls[0])) throw new Error("Remote must have exactly one effective URL");
    validateRemoteTransport(urls[0]);
    if (/^git:\/\//i.test(urls[0])) {
      // A git:// proxy is an arbitrary shell command. Do not execute one from
      // ambient or repository configuration during an approved network action.
      const proxy = await run(root, ["config", "--null", "--get-all", "core.gitProxy"]);
      if (proxy.exitCode !== 0 && proxy.exitCode !== 1) throw new Error(proxy.stderr || "Cannot inspect Git proxy configuration");
      if (nul(proxy.stdout).some((value) => !/^\s*none(?:\s+for\s+\S+)?\s*$/i.test(value))) {
        throw new Error("Git protocol proxy commands are not supported; remove the proxy or use an approved SSH or HTTPS remote");
      }
    }
    return urls[0];
  } catch (error) {
    throw new Error(redactGitUrl(error instanceof Error ? error.message : String(error)));
  }
}

async function required(root: string, args: string[], options: Parameters<typeof run>[2] = {}): Promise<string> {
  const result = await run(root, args, options);
  if (result.exitCode !== 0) throw new Error(result.stderr || `${result.command} failed`);
  return result.stdout;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function nul(value: string): string[] { return value.split("\0").filter(Boolean); }
function line(value: string): string { return value.replace(/\n$/, ""); }
function validatePath(file: string): string {
  if (!file || path.isAbsolute(file) || file.includes("\0") || file.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".skills-manager")) {
    throw new Error(`Invalid or reserved skill path: ${JSON.stringify(file)}`);
  }
  return file;
}
function inside(file: string, root: string): boolean { return file === root || file.startsWith(`${root}/`); }
function intersects(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }

async function maybe(root: string, args: string[]): Promise<string | null> {
  const result = await run(root, args);
  if (result.exitCode === 0) return line(result.stdout);
  if (result.exitCode === 1) return null;
  throw new Error(result.stderr || `${result.command} failed`);
}

export async function discoverGit(skillsDir: string): Promise<GitDiscovery> {
  const empty: GitDiscovery = { kind: "error", selectedDir: path.resolve(skillsDir), topLevel: null, gitDir: null, commonDir: null, branch: null, head: null, upstream: null, remotes: [], error: null };
  try {
    let root: string;
    try { root = await realpath(skillsDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...empty, error: "Selected skills directory does not exist; create it before initializing Git." };
      }
      throw error;
    }
    if (!(await stat(root)).isDirectory()) throw new Error("Selected skills path is not a directory");
    empty.selectedDir = root;
    const top = await run(root, ["rev-parse", "--show-toplevel"]);
    if (top.missing) return { ...empty, kind: "unavailable", error: "Git executable is unavailable" };
    if (top.exitCode !== 0) {
      if (/not a git repository/i.test(top.stderr)) return { ...empty, kind: "none" };
      throw new Error(top.stderr || "Git repository discovery failed");
    }
    const topLevel = await realpath(line(top.stdout));
    let parentDetails: Pick<GitDiscovery, "parentTracked" | "parentExcluded" | "exclusionFile"> = {};
    if (topLevel !== root) {
      const relative = path.relative(topLevel, root).split(path.sep).join("/");
      if (!relative || relative === ".." || relative.startsWith("../")) throw new Error("Git top-level does not contain selected directory");
      const tracked = await required(topLevel, ["ls-files", "-z", "--", relative]);
      // check-ignore rejects literal pathspec magic, so use a relative prefix
      // to prevent leading colon syntax without enabling magic for other commands.
      const ignored = await run(topLevel, ["--no-literal-pathspecs", "check-ignore", "--no-index", "-q", "--", `./${relative}/`]);
      if (ignored.exitCode !== 0 && ignored.exitCode !== 1) throw new Error(ignored.stderr || "Cannot inspect parent exclusion");
      const exclude = line(await required(topLevel, ["rev-parse", "--git-path", "info/exclude"]));
      parentDetails = { parentTracked: tracked.length > 0, parentExcluded: ignored.exitCode === 0, exclusionFile: path.resolve(topLevel, exclude) };
    }
    const branch = await maybe(topLevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const head = await maybe(topLevel, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const upstream = head && branch
      ? line(await required(topLevel, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`])) || null
      : null;
    const remotes = (await required(topLevel, ["remote"])).split("\n").filter(Boolean);
    const gitDir = await realpath(line(await required(topLevel, ["rev-parse", "--absolute-git-dir"])));
    const commonDir = await realpath(path.resolve(topLevel, line(await required(topLevel, ["rev-parse", "--git-common-dir"]))));
    return { ...empty, ...parentDetails, kind: topLevel === root ? "leaf" : "parent", topLevel, gitDir, commonDir, branch, head, upstream, remotes };
  } catch (error) {
    return { ...empty, error: redactGitUrl(error instanceof Error ? error.message : String(error)) };
  }
}

async function repository(skillsDir: string): Promise<GitDiscovery> {
  const state = await discoverGit(skillsDir);
  if (state.kind !== "leaf" && state.kind !== "parent") throw new Error(state.error || "The selected skills directory is not in a Git repository");
  return state;
}

async function fileIdentity(file: string, link = false): Promise<GitFileIdentity> {
  const info = link ? await lstat(file, { bigint: true }) : await stat(file, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

function repositoryRoot(state: GitDiscovery): string {
  if (!state.topLevel) throw new Error("Git repository root is unavailable");
  return state.topLevel;
}

function repositoryPrefix(state: GitDiscovery): string {
  const relative = path.relative(repositoryRoot(state), state.selectedDir).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Git repository root does not contain the selected skills directory");
  return relative;
}

function repositoryPath(prefix: string, file: string): string {
  validatePath(file);
  return prefix ? `${prefix}/${file}` : file;
}

function skillPath(prefix: string, file: string): string | null {
  if (!prefix) return file;
  return file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : null;
}

async function gitBinding(state: GitDiscovery): Promise<GitBinding> {
  if (!state.gitDir || !state.commonDir) throw new Error("Git metadata location is unavailable");
  const repo = repositoryRoot(state);
  return {
    root: await fileIdentity(state.selectedDir),
    repositoryRoot: repo,
    repositoryIdentity: await fileIdentity(repo),
    prefix: repositoryPrefix(state),
    gitEntry: await fileIdentity(path.join(repo, ".git"), true),
    gitDir: state.gitDir,
    gitDirIdentity: await fileIdentity(state.gitDir),
    commonDir: state.commonDir,
    commonDirIdentity: await fileIdentity(state.commonDir),
  };
}

async function requireNoPendingRecovery(approved: ApprovedSkillsRoot, binding: GitBinding): Promise<void> {
  const message = await recoverIndexTransaction(approved, binding);
  if (message) throw new Error(`Git recovery completed: ${message}. Inspect the repository and approve the action again.`);
}

export async function recoverSkillsGit(approved: ApprovedSkillsRoot): Promise<string | undefined> {
  await assertApprovedSkillsRoot(approved);
  if (!(await hasIndexTransaction(approved))) return undefined;
  const state = await discoverGit(approved.path);
  if (state.kind !== "leaf" && state.kind !== "parent") throw new Error(state.error || "Cannot inspect Git recovery state");
  const binding = await gitBinding(state);
  return withSkillsLock(approved, () => recoverIndexTransaction(approved, binding));
}

async function initializationGuard(skillsDir: string): Promise<GitDiscovery> {
  const state = await discoverGit(skillsDir);
  if (state.kind === "parent") throw new Error("Selected directory is already in a Git repository");
  if (state.kind !== "none") {
    throw new Error(state.error || (state.kind === "leaf" ? "Selected directory is already a Git repository" : "Cannot safely inspect selected directory"));
  }
  try { await lstat(path.join(state.selectedDir, ".git")); throw new Error("A .git entry already exists; inspect it manually before initialization"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return state;
}

export async function previewInitialize(approved: ApprovedSkillsRoot): Promise<InitializePreview> {
  await assertApprovedSkillsRoot(approved);
  const state = await initializationGuard(approved.path);
  const result = {
    root: state.selectedDir, parent: state.topLevel, parentTracked: state.parentTracked ?? false,
    parentExcluded: state.parentExcluded ?? false, exclusionFile: state.exclusionFile ?? null,
    rootIdentity: await fileIdentity(state.selectedDir),
  };
  return { ...result, fingerprint: digest({ ...result, approved }) };
}

export async function initializeSkillsRepo(approved: ApprovedSkillsRoot, preview: InitializePreview): Promise<GitResult> {
  const before = await previewInitialize(approved);
  if (JSON.stringify(before) !== JSON.stringify(preview)) throw new Error("Initialization preview changed; inspect and approve it again");
  return withSkillsLock(approved, async () => {
    if (await hasIndexTransaction(approved)) throw new Error("An earlier Git transaction needs recovery before initialization");
    const state = await previewInitialize(approved);
    if (JSON.stringify(state) !== JSON.stringify(preview)) throw new Error("Initialization preview changed; inspect and approve it again");
    return run(state.root, ["-c", "init.templateDir=", "init", "--", "."], { label: "init", boundary: { approved, rootIdentity: state.rootIdentity } });
  });
}

export async function previewAddRemote(approved: ApprovedSkillsRoot, name: string, url: string): Promise<RemotePreview> {
  await assertApprovedSkillsRoot(approved);
  if (!name || name.startsWith("-") || /[\s\0]/.test(name)) throw new Error("Invalid remote name");
  validateRemoteTransport(url);
  const state = await repository(approved.path);
  if (state.remotes.length !== 0) throw new Error("Remote configuration is offered only when no remote exists; existing remotes are never overwritten");
  const binding = await gitBinding(state);
  const result = { root: state.selectedDir, name, url: redactGitUrl(url), gitDir: binding.gitDir, commonDir: binding.commonDir, binding };
  return { ...result, fingerprint: digest({ ...result, raw: url, approved }) };
}

export async function addRemoteApproved(approved: ApprovedSkillsRoot, preview: RemotePreview, url: string): Promise<GitResult> {
  const before = await previewAddRemote(approved, preview.name, url);
  if (JSON.stringify(before) !== JSON.stringify(preview)) throw new Error("Remote preview changed; inspect and approve it again");
  return withSkillsLock(approved, async () => {
    await requireNoPendingRecovery(approved, preview.binding);
    const state = await previewAddRemote(approved, preview.name, url);
    if (JSON.stringify(state) !== JSON.stringify(preview)) throw new Error("Remote preview changed; inspect and approve it again");
    return run(state.root, ["remote", "add", "--", state.name, url], { label: "remote add", boundary: mutation(approved, state.binding) });
  });
}

async function rootsInTree(state: GitDiscovery, revision: string | null): Promise<Set<string>> {
  const roots = new Set<string>();
  if (!revision) return roots;
  const prefix = repositoryPrefix(state);
  const entries = nul(await required(repositoryRoot(state), ["ls-tree", "-r", "-z", "--full-tree", revision, ...(prefix ? ["--", prefix] : [])]));
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Invalid Git tree output");
    const meta = entry.slice(0, tab);
    const file = skillPath(prefix, entry.slice(tab + 1));
    if (file === null) throw new Error("Git tree returned a path outside the selected skills directory");
    const parts = file.split("/");
    if (parts[0] === ".disabled_skills" && parts.length === 3 && parts[2] === "SKILL.md") roots.add(parts.slice(0, 2).join("/"));
    else if (parts.length === 2 && parts[1] === "SKILL.md" && !parts[0].startsWith(".git") && parts[0] !== ".skills-manager") roots.add(parts[0]);
    else if (meta.startsWith("120000 ") && ((parts.length === 1 && !parts[0].startsWith(".")) || (parts[0] === ".disabled_skills" && parts.length === 2))) roots.add(file);
  }
  return roots;
}

async function currentRoots(state: GitDiscovery): Promise<Set<string>> {
  const roots = await rootsInTree(state, state.head);
  for (const skill of await scanSkills(state.selectedDir)) {
    if (!skill.path) continue;
    const relative = path.relative(state.selectedDir, skill.path).split(path.sep).join("/");
    if (relative && !relative.startsWith("../")) roots.add(validatePath(relative));
  }
  return roots;
}

function allowed(file: string, roots: Set<string>): boolean {
  try { validatePath(file); } catch { return false; }
  return [...roots].some((root) => inside(file, root));
}
async function allStatus(state: GitDiscovery, paths: string[] = []): Promise<GitStatusEntry[]> {
  const prefix = repositoryPrefix(state);
  const scope = paths.length ? paths.map((file) => repositoryPath(prefix, file)) : prefix ? [prefix] : [];
  const output = await required(repositoryRoot(state), ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none", ...(scope.length ? ["--", ...scope] : [])], { filters: true });
  return nul(output).map((record) => {
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status output");
    const file = skillPath(prefix, record.slice(3));
    if (file === null) throw new Error("Git status returned a path outside the selected skills directory");
    return { status: record.slice(0, 2), path: file };
  });
}
export async function getStatus(skillsDir: string): Promise<GitStatusEntry[]> {
  const state = await repository(skillsDir);
  const roots = await currentRoots(state);
  const entries = await allStatus(state, [...roots]);
  return entries.filter((entry) => allowed(entry.path, roots));
}

export async function getFileDiff(skillsDir: string, file: string, _untracked: boolean, fullContext = false): Promise<GitResult> {
  validatePath(file);
  const state = await repository(skillsDir);
  if (!(await getStatus(skillsDir)).some((entry) => entry.path === file)) throw new Error("File is not a changed skill path");
  const current = await snapshot(state.selectedDir, file);
  let previous: Uint8Array | null = null;
  if (state.head) {
    const record = nul(await required(repositoryRoot(state), ["ls-tree", "-z", "--full-tree", state.head, "--", repositoryPath(repositoryPrefix(state), file)]))[0];
    if (record) {
      const match = /^([0-7]+) blob ([0-9a-f]+)\t/.exec(record);
      if (!match) throw new Error("Cannot diff a Git submodule or non-file entry");
      const blob = await execa("git", [...config, "cat-file", "blob", match[2]], {
        cwd: repositoryRoot(state), env: environment(repositoryRoot(state)), extendEnv: false, reject: false,
        encoding: "buffer", stripFinalNewline: false,
      });
      if (blob.exitCode !== 0) throw new Error(redactGitUrl(Buffer.from(blob.stderr).toString("utf8")) || "Cannot read Git blob");
      previous = blob.stdout;
    }
  }
  const dir = await mkdtemp(path.join(tmpdir(), "skills-git-diff-"));
  const oldPath = path.join(dir, "old");
  const newPath = path.join(dir, "new");
  try {
    if (previous !== null) await writeFile(oldPath, previous, { mode: 0o600 });
    if (current.data !== null) await writeFile(newPath, current.data, { mode: 0o600 });
    const context = fullContext ? ["--unified=999999"] : [];
    const result = await run(repositoryRoot(state), [
      "diff", "--no-index", "--no-ext-diff", "--no-textconv", ...context, "--",
      previous === null ? "/dev/null" : oldPath, current.data === null ? "/dev/null" : newPath,
    ], { filters: true });
    result.stdout = result.stdout.replaceAll(oldPath, `/${file}`).replaceAll(newPath, `/${file}`);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function snapshot(root: string, file: string, approved?: ApprovedSkillsRoot): Promise<FileSnapshot> {
  validatePath(file);
  try {
    const entry = await readSkillPath(root, file, approved ? { expectedRoot: approved } : {});
    if (entry.truncated) throw new Error(`Cannot review truncated file: ${JSON.stringify(file)}`);
    const mode = entry.kind === "symlink" ? "120000" : entry.mode & 0o111 ? "100755" : "100644";
    return { path: file, mode, data: entry.content, identity: entry.stableIdentity };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path: file, mode: null, data: null, identity: "deleted" };
    if (code === "ENOTDIR") return { path: file, mode: null, data: null, identity: "blocked", blocked: true };
    throw error;
  }
}

async function blockingAncestor(root: string, file: string, approved: ApprovedSkillsRoot): Promise<{ path: string; identity: string }> {
  const parts = file.split("/");
  for (let count = parts.length - 1; count > 0; count--) {
    const candidate = parts.slice(0, count).join("/");
    try {
      const entry = await readSkillPath(root, candidate, { expectedRoot: approved, maxBytes: 0 });
      return { path: candidate, identity: entry.stableIdentity };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR" || code === "ENOTSUP") continue;
      throw error;
    }
  }
  throw new Error(`Cannot safely identify the path blocking ${JSON.stringify(file)}; inspect it and retry`);
}

async function commitDetails(approved: ApprovedSkillsRoot, paths: string[]): Promise<{ preview: CommitPreview; snapshots: FileSnapshot[] }> {
  await assertApprovedSkillsRoot(approved);
  const state = await repository(approved.path);
  const selected = [...new Set(paths.map(validatePath))].sort();
  if (!selected.length) throw new Error("Select at least one changed skill file");
  const entries = await getStatus(approved.path);
  const selectedStatus = selected.map((file) => {
    const entry = entries.find((item) => item.path === file);
    if (!entry) throw new Error(`Not a changed skill file: ${JSON.stringify(file)}`);
    if (entry.status.includes("U") || entry.status === "AA" || entry.status === "DD") throw new Error("Resolve Git conflicts before committing");
    return entry;
  });
  const snapshots = await Promise.all(selected.map((file) => snapshot(state.selectedDir, file, approved)));
  const blockingPaths = new Set<string>();
  for (const item of snapshots) {
    if (!item.blocked) continue;
    const blocker = await blockingAncestor(state.selectedDir, item.path, approved);
    blockingPaths.add(blocker.path);
    item.identity = digest({ blocker: blocker.path, identity: blocker.identity });
  }
  const index = await required(repositoryRoot(state), ["ls-files", "--stage", "-z", "--", ...selected.map((file) => repositoryPath(repositoryPrefix(state), file))]);
  const binding = await gitBinding(state);
  const indexFingerprint = await readIndexFingerprint(approved, binding);
  const sortedBlockingPaths = [...blockingPaths].sort();
  const fingerprint = digest({ root: state.selectedDir, approved, head: state.head, branch: state.branch, binding, indexFingerprint, blockingPaths: sortedBlockingPaths, entries: selectedStatus, index, snapshots: snapshots.map(({ path, mode, identity }) => ({ path, mode, identity })) });
  return { preview: { root: state.selectedDir, paths: selected, blockingPaths: sortedBlockingPaths, head: state.head, branch: state.branch, binding, indexFingerprint, fingerprint }, snapshots };
}

export async function previewCommit(approved: ApprovedSkillsRoot, paths: string[]): Promise<CommitPreview> {
  return (await commitDetails(approved, paths)).preview;
}

export async function commitSelected(approved: ApprovedSkillsRoot, preview: CommitPreview, message: string): Promise<GitResult> {
  if (!message.trim()) throw new Error("A commit message is required");
  await repository(approved.path);
  return withSkillsLock(approved, async () => {
    await requireNoPendingRecovery(approved, preview.binding);
    const { preview: current, snapshots } = await commitDetails(approved, preview.paths);
    if (JSON.stringify(current) !== JSON.stringify(preview)) throw new Error("Commit preview changed; inspect and approve it again");
    const basename = `git-index-${randomBytes(16).toString("hex")}`;
    if (await inspectGitIndex(approved, basename) !== null) throw new Error("Temporary Git index already exists");
    const env = { GIT_INDEX_FILE: path.join(current.root, ".skills-manager", basename) };
    const boundary = mutation(approved, current.binding);
    const entries: { path: string; mode: string | null; oid: string | null }[] = [];
    try {
      await required(current.root, current.head ? ["read-tree", current.head] : ["read-tree", "--empty"], { env, boundary });
      // Remove selected old entries first so reviewed file/directory
      // transitions do not discard any unselected index entry.
      for (const item of snapshots) {
        if (item.data === null || item.mode === null) {
          await required(current.root, ["-C", current.binding.repositoryRoot, "update-index", "--force-remove", "--", repositoryPath(current.binding.prefix, item.path)], { env, boundary });
          entries.push({ path: item.path, mode: null, oid: null });
        }
      }
      for (const item of snapshots) {
        if (item.data !== null && item.mode !== null) {
          const oid = line(await required(current.root, ["hash-object", "-w", "--stdin"], { env, boundary, input: item.data }));
          await required(current.root, ["-C", current.binding.repositoryRoot, "update-index", "--add", "--cacheinfo", `${item.mode},${oid},${repositoryPath(current.binding.prefix, item.path)}`], { env, boundary });
          entries.push({ path: item.path, mode: item.mode, oid });
        }
      }
      const tree = line(await required(current.root, ["write-tree"], { env, boundary }));
      if (current.head && tree === line(await required(current.root, ["rev-parse", "--verify", `${current.head}^{tree}`]))) {
        throw new Error("The selected worktree files do not change the committed tree");
      }
      const commitArgs = ["commit-tree", tree, ...(current.head ? ["-p", current.head] : []), "-m", message];
      const newOid = line(await required(current.root, commitArgs, { env, boundary, label: "commit-tree" }));
      const checked = await previewCommit(approved, preview.paths);
      if (JSON.stringify(checked) !== JSON.stringify(preview)) throw new Error("Commit preview changed; inspect and approve it again");
      await commitIndexTransaction(approved, current, { newOid, entries });
      return { command: "git commit-tree/update-ref", stdout: `Committed ${newOid}\n`, stderr: "", exitCode: 0 };
    } finally {
      for (const name of [basename, `${basename}.lock`]) {
        const identity = await inspectGitIndex(approved, name);
        if (identity !== null) await cleanupGitIndex(approved, name, identity);
      }
    }
  });
}

async function selectedRemote(state: GitDiscovery, requested?: string): Promise<{ remote: string; remoteBranch: string | null }> {
  const configuredRemote = state.branch ? await maybe(repositoryRoot(state), ["config", "--get", `branch.${state.branch}.remote`]) : null;
  const merge = state.branch ? await maybe(repositoryRoot(state), ["config", "--get", `branch.${state.branch}.merge`]) : null;
  const remote = requested ?? (configuredRemote && configuredRemote !== "." ? configuredRemote : state.remotes.length === 1 ? state.remotes[0] : "");
  if (!remote || !state.remotes.includes(remote)) throw new Error("Select one configured remote explicitly");
  const remoteBranch = remote === configuredRemote && merge?.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : state.branch;
  return { remote, remoteBranch };
}
async function branchRemote(state: GitDiscovery, requested?: string): Promise<{ remote: string; branch: string; remoteBranch: string }> {
  if (!state.branch || !state.head) throw new Error("A committed, attached branch is required for push or pull");
  const selected = await selectedRemote(state, requested);
  if (!selected.remoteBranch) throw new Error("Cannot determine the remote branch");
  return { remote: selected.remote, branch: state.branch, remoteBranch: selected.remoteBranch };
}
async function checkRef(root: string, ref: string): Promise<void> {
  if ((await run(root, ["check-ref-format", ref])).exitCode !== 0) throw new Error("Invalid Git branch or remote name");
}

async function fetchDetails(approved: ApprovedSkillsRoot, requestedRemote?: string, requestedBranch?: string): Promise<{ preview: FetchPreview; raw: string }> {
  await assertApprovedSkillsRoot(approved);
  const state = await repository(approved.path);
  const selected = await selectedRemote(state, requestedRemote);
  const branch = requestedBranch ?? selected.remoteBranch;
  if (!branch) throw new Error("Select a remote branch explicitly when HEAD is detached");
  await checkRef(repositoryRoot(state), `refs/heads/${branch}`);
  const destination = `refs/remotes/${selected.remote}/${branch}`;
  await checkRef(repositoryRoot(state), destination);
  const raw = await rawRemoteUrl(repositoryRoot(state), selected.remote, false);
  const fetchUrl = redactGitUrl(raw);
  const binding = await gitBinding(state);
  const preview = { root: state.selectedDir, remote: selected.remote, fetchUrl, branch, destination, binding, fingerprint: digest({ root: state.selectedDir, approved, remote: selected.remote, raw, branch, destination, binding }) };
  return { preview, raw };
}
export async function previewFetch(approved: ApprovedSkillsRoot, requestedRemote?: string, requestedBranch?: string): Promise<FetchPreview> {
  return (await fetchDetails(approved, requestedRemote, requestedBranch)).preview;
}

// Bind the effective URL captured during revalidation, rather than looking up
// a mutable remote name again inside the network process. Git performs one
// URL rewrite; the exact random alias must also win over pushInsteadOf rules.
function frozenRemote(raw: string): { alias: string; env: NodeJS.ProcessEnv } {
  const alias = `skills-manager-${randomBytes(16).toString("hex")}://`;
  return { alias, env: {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${raw}.insteadOf`, GIT_CONFIG_VALUE_0: alias,
    GIT_CONFIG_KEY_1: `url.${raw}.pushInsteadOf`, GIT_CONFIG_VALUE_1: alias,
  } };
}

function networkEnvironment(raw: string, binding: GitBinding, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const networkEnv = { ...env, GIT_ALLOW_PROTOCOL: "file:ssh:http:https:git" };
  const ssh = /^ssh:\/\//i.test(raw) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && /^[^/]+:/.test(raw));
  if (!ssh) return networkEnv;
  const blocked = [binding.repositoryRoot, binding.gitDir, binding.commonDir];
  for (const directory of (environment(binding.repositoryRoot).PATH ?? "").split(path.delimiter)) {
    try {
      const executable = realpathSync(path.join(directory, "ssh"));
      if (blocked.some((item) => inside(executable, item)) || !statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      const quoted = `'${executable.replaceAll("'", "'\\''")}'`;
      return { ...networkEnv, GIT_SSH_COMMAND: `${quoted} -F /dev/null -oBatchMode=yes -oClearAllForwardings=yes`, GIT_SSH_VARIANT: "ssh" };
    } catch {
      // Search the next absolute PATH entry.
    }
  }
  throw new Error("Cannot find an executable SSH client outside the repository and its Git metadata");
}
export async function fetchApproved(approved: ApprovedSkillsRoot, preview: FetchPreview): Promise<GitResult> {
  await repository(approved.path);
  return withSkillsLock(approved, async () => {
    await requireNoPendingRecovery(approved, preview.binding);
    const { preview: now, raw } = await fetchDetails(approved, preview.remote, preview.branch);
    if (JSON.stringify(now) !== JSON.stringify(preview)) throw new Error("Fetch destination changed; inspect and approve it again");
    // Relative local URLs are interpreted from the repository root even when
    // the selected skills directory is a nested worktree path.
    const destination = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^[^/]+:/.test(raw)
      ? path.resolve(now.binding.repositoryRoot, raw) : raw;
    const remote = frozenRemote(destination);
    return run(now.root, ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--", remote.alias, `refs/heads/${now.branch}:${now.destination}`], { label: "fetch", redact: true, env: networkEnvironment(raw, now.binding, remote.env), boundary: mutation(approved, now.binding) });
  });
}

async function commitHistory(root: string, range: string): Promise<GitCommit[]> {
  const shallow = line(await required(root, ["rev-parse", "--is-shallow-repository"]));
  if (shallow !== "false") throw new Error("Cannot review complete history in a shallow Git repository");
  const grafts = line(await required(root, ["rev-parse", "--git-path", "info/grafts"]));
  try {
    await lstat(path.resolve(root, grafts));
    throw new Error("Cannot review complete history while legacy Git grafts are present");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ids = (await required(root, ["rev-list", "--reverse", "--topo-order", range])).split("\n").filter(Boolean);
  const commits: GitCommit[] = [];
  for (const id of ids) {
    const subject = line(await required(root, ["show", "-s", "--no-show-signature", "--format=%s", id]));
    const files = nul(await required(root, ["diff-tree", "--root", "-m", "-r", "--no-commit-id", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-only", "-z", id]));
    commits.push({ id, subject: redactGitUrl(subject), paths: [...new Set(files)].sort() });
  }
  return commits;
}
async function validateHistory(state: GitDiscovery, commits: GitCommit[], approvedPaths: string[], refs: string[]): Promise<void> {
  const roots = new Set<string>();
  for (const revision of [...refs, ...commits.map((commit) => commit.id)]) {
    for (const item of await rootsInTree(state, revision)) roots.add(item);
  }
  for (const file of commits.flatMap((commit) => commit.paths)) {
    if (!allowed(file, roots) || (approvedPaths.length && !approvedPaths.some((item) => inside(file, item)))) {
      throw new Error(`Git operation contains an unrelated or unapproved path: ${JSON.stringify(file)}`);
    }
  }
}
function selectedPaths(paths: string[]): string[] { return [...new Set(paths.map(validatePath))].sort(); }

async function localBareRemote(root: string, raw: string): Promise<PushPreview["localRemote"]> {
  let local: string;
  if (/^file:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.search || url.hash || url.username || url.password) throw new Error("Invalid local Git remote URL");
    local = fileURLToPath(url);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[^/]+:/.test(raw)) {
    return null;
  } else {
    local = path.resolve(root, raw);
  }
  const remote = await realpath(local);
  const bare = line(await required(root, [`--git-dir=${remote}`, "rev-parse", "--is-bare-repository"]));
  if (bare !== "true") throw new Error("A local push destination must be an existing bare Git repository");
  return { path: remote, identity: await fileIdentity(remote) };
}

async function pushDetails(approved: ApprovedSkillsRoot, paths: string[] = [], requestedRemote?: string): Promise<{ preview: PushPreview; raw: string }> {
  await assertApprovedSkillsRoot(approved);
  const state = await repository(approved.path);
  const selected = await branchRemote(state, requestedRemote);
  const destination = `refs/heads/${selected.remoteBranch}`;
  const repo = repositoryRoot(state);
  await checkRef(repo, destination);
  const raw = await rawRemoteUrl(repo, selected.remote, true);
  const localRemote = await localBareRemote(repo, raw);
  const approvedPaths = selectedPaths(paths);
  // Conservatively show all reachable commits: a remote can be rewound after a fetch.
  const outgoing = await commitHistory(repo, state.head!);
  if (state.kind === "leaf") await validateHistory(state, outgoing, approvedPaths, [state.head!]);
  const warning = state.kind === "parent"
    ? "Push sends the whole branch history, including files outside the selected skills directory; selecting paths does not limit a push. Check destination access with the provider; Git cannot determine privacy. All reachable commits are shown because the remote can change; some may already be present."
    : "Check destination access with the provider; Git cannot determine privacy. All reachable commits are shown because the remote can change; some may already be present.";
  const binding = await gitBinding(state);
  const result = { root: state.selectedDir, remote: selected.remote, pushUrl: redactGitUrl(raw), branch: selected.branch, upstream: state.upstream, destination, head: state.head!, outgoing, approvedPaths, warning, binding, localRemote };
  return { preview: { ...result, fingerprint: digest({ ...result, raw, approved }) }, raw };
}
export async function previewPush(approved: ApprovedSkillsRoot, paths: string[] = [], requestedRemote?: string): Promise<PushPreview> {
  return (await pushDetails(approved, paths, requestedRemote)).preview;
}
export async function pushApproved(approved: ApprovedSkillsRoot, preview: PushPreview): Promise<GitResult> {
  await repository(approved.path);
  return withSkillsLock(approved, async () => {
    await requireNoPendingRecovery(approved, preview.binding);
    const { preview: now, raw } = await pushDetails(approved, preview.approvedPaths, preview.remote);
    if (JSON.stringify(now) !== JSON.stringify(preview)) throw new Error("Push preview changed; inspect and approve it again");
    const remote = frozenRemote(now.localRemote?.path ?? raw);
    const receivePack = now.localRemote ? ["--receive-pack=git -c core.hooksPath=/dev/null receive-pack"] : [];
    return run(now.root, ["push", "--no-follow-tags", "--recurse-submodules=no", "--no-signed", ...receivePack, "--", remote.alias, `${now.head}:${now.destination}`], { label: "push", redact: true, env: networkEnvironment(raw, now.binding, remote.env), boundary: mutation(approved, now.binding, now.localRemote) });
  });
}

export async function previewPull(approved: ApprovedSkillsRoot, paths: string[] = []): Promise<PullPreview> {
  await assertApprovedSkillsRoot(approved);
  const state = await repository(approved.path);
  const selected = await branchRemote(state);
  if (!state.upstream) throw new Error("The current branch has no upstream; configure one and explicitly fetch before pulling");
  const destination = `refs/remotes/${selected.remote}/${selected.remoteBranch}`;
  const repo = repositoryRoot(state);
  const prefix = repositoryPrefix(state);
  await checkRef(repo, destination);
  const target = await maybe(repo, ["rev-parse", "--verify", "--quiet", `${destination}^{commit}`]);
  if (!target) throw new Error("Upstream tracking branch is missing; fetch it explicitly first");
  const fastForward = await run(repo, ["merge-base", "--is-ancestor", state.head!, target]);
  if (fastForward.exitCode !== 0) throw new Error("Pull is not a fast-forward; resolve divergence manually");
  const raw = await rawRemoteUrl(repo, selected.remote, false);
  const approvedPaths = selectedPaths(paths);
  const selectedFile = (file: string): string => {
    const relative = skillPath(prefix, file);
    if (relative === null) throw new Error(`Pull contains a path outside the selected skills directory: ${JSON.stringify(file)}`);
    return relative;
  };
  const commits = (await commitHistory(repo, `${state.head}..${target}`))
    .map((commit) => ({ ...commit, paths: commit.paths.map(selectedFile) }));
  await validateHistory(state, commits, approvedPaths, [state.head!, target]);
  const changed = nul(await required(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--name-only", "-z", state.head!, target], { filters: true })).map(selectedFile).sort();
  const local = (await allStatus(state)).filter((entry) => !inside(entry.path, ".skills-manager"));
  for (const file of changed) {
    if (local.some((entry) => intersects(entry.path, file))) throw new Error(`Pull would overwrite local changes at ${JSON.stringify(file)}`);
  }
  const binding = await gitBinding(state);
  const result = { root: state.selectedDir, remote: selected.remote, fetchUrl: redactGitUrl(raw), branch: selected.branch, upstream: state.upstream, destination, head: state.head!, target, commits, paths: changed, approvedPaths, binding };
  const index = await required(repo, ["ls-files", "--stage", "-z", "--", ...changed.map((file) => repositoryPath(prefix, file))]);
  return { ...result, fingerprint: digest({ ...result, raw, approved, index, local }) };
}
export async function pullApproved(approved: ApprovedSkillsRoot, preview: PullPreview): Promise<GitResult> {
  await repository(approved.path);
  return withSkillsLock(approved, async () => {
    await requireNoPendingRecovery(approved, preview.binding);
    const now = await previewPull(approved, preview.approvedPaths);
    if (JSON.stringify(now) !== JSON.stringify(preview)) throw new Error("Pull preview changed; inspect and approve it again");
    await pullIndexWorktreeTransaction(approved, now);
    return { command: "Git fast-forward transaction", stdout: now.head === now.target ? "Already up to date.\n" : `Fast-forwarded to ${now.target}\n`, stderr: "", exitCode: 0 };
  });
}
