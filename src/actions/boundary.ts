import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// This path works both from src/actions and from the packaged dist/actions.
const helper = fileURLToPath(new URL("../../native/skills-boundary", import.meta.url));
const platformFile = fileURLToPath(new URL("../../native/skills-boundary.platform.json", import.meta.url));
export interface ApprovedSkillsRoot {
  path: string;
  identity: string;
}

const sessions = new AsyncLocalStorage<{ root: ApprovedSkillsRoot; process: BoundaryProcess }>();

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function checkedName(name: string): void {
  if (!name || name === "." || name === ".." || name === ".git" ||
      name === ".disabled_skills" || name === ".skills-manager" ||
      /[\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255) {
    throw new Error("Invalid or reserved skill name");
  }
}

function checkedFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("A valid reviewed fingerprint is required");
}

function reviewedLocation(root: string, selectedRoot: string, name: string, expectedPath: string): "active" | "disabled" {
  const selected = path.resolve(expectedPath);
  for (const base of [root, path.resolve(selectedRoot)]) {
    if (selected === path.join(base, name)) return "active";
    if (selected === path.join(base, ".disabled_skills", name)) return "disabled";
  }
  throw new Error("The confirmed path is not this skill in the selected directory");
}

let hostLibc: "glibc" | "unsupported" | undefined;

function checkHelperPlatform(): void {
  let platform: { platform?: string; arch?: string; libc?: string | null };
  try {
    platform = JSON.parse(readFileSync(platformFile, "utf8")) as typeof platform;
  } catch (error) {
    throw new Error(`Skills filesystem helper platform metadata is missing or invalid (${platformFile}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (process.platform === "linux" && hostLibc === undefined) {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    hostLibc = report.header?.glibcVersionRuntime ? "glibc" : "unsupported";
  }
  const libc = process.platform === "linux" ? hostLibc : null;
  if (!platform || platform.platform !== process.platform || platform.arch !== process.arch || platform.libc !== libc) {
    throw new Error(`Skills filesystem helper is incompatible with ${process.platform}/${process.arch}${libc ? `/${libc}` : ""}; rebuild it for this host`);
  }
}

function helperError(response: string): Error {
  const [, code, ...message] = response.split("\t");
  return Object.assign(new Error(message.join("\t") || "Filesystem boundary failed"), { code });
}

class BoundaryProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: AsyncIterator<string>;
  private readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private stderr = "";
  private spawnError: Error | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(args: string[]) {
    checkHelperPlatform();
    this.child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", (error) => { this.spawnError = error; });
    this.child.stdin.on("error", () => { /* The closed process is reported by readLine. */ });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (data: string) => { this.stderr += data.slice(0, 8192); });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    this.closed = new Promise((resolve) => this.child.on("close", (code, signal) => resolve({ code, signal })));
  }

  private async readLine(): Promise<string> {
    const next = await this.lines.next();
    if (!next.done) return next.value;
    const { code, signal } = await this.closed;
    if (this.spawnError) {
      throw new Error(`Skills filesystem helper is missing or incompatible (${helper}): ${this.spawnError.message}`);
    }
    const detail = this.stderr.trim();
    throw new Error(`Skills filesystem helper exited ${signal ? `on ${signal}` : `with status ${code}`} before completing${detail ? `: ${detail}` : ""}`);
  }

  async start(): Promise<string | undefined> {
    const response = await this.readLine();
    if (response.startsWith("ERR\t")) throw helperError(response);
    if (response === "READY") return undefined;
    if (response.startsWith("READY\t")) return response.slice(6);
    throw new Error(`Unexpected filesystem helper response: ${response}`);
  }

  command(parts: string[]): Promise<string | undefined> {
    const run = async (): Promise<string | undefined> => {
      this.child.stdin.write(`${parts.join("\t")}\n`);
      const response = await this.readLine();
      if (response === "OK") return undefined;
      if (response.startsWith("OK\t")) return response.slice(3);
      if (response.startsWith("ERR\t")) throw helperError(response);
      throw new Error(`Unexpected filesystem helper response: ${response}`);
    };
    const result = this.queue.then(run, run);
    this.queue = result;
    return result;
  }

  async finish(): Promise<void> {
    this.child.stdin.end();
    const { code, signal } = await this.closed;
    if (this.spawnError) throw new Error(`Skills filesystem helper is missing or incompatible (${helper}): ${this.spawnError.message}`);
    if (code !== 0 || signal) {
      throw new Error(`Skills filesystem helper exited ${signal ? `on ${signal}` : `with status ${code}`}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`);
    }
  }
}

async function runSingle(args: string[]): Promise<string | undefined> {
  const process = new BoundaryProcess(args);
  let result: string | undefined;
  try {
    result = await process.start();
  } catch (error) {
    await process.finish().catch(() => undefined);
    throw error;
  }
  await process.finish();
  return result;
}

/** Capture a canonical root's pinned identity before the user approves it. */
export async function approveSkillsRoot(canonicalPath: string): Promise<ApprovedSkillsRoot> {
  const root = path.resolve(canonicalPath);
  const identity = await runSingle(["identity", root]);
  if (!identity || !/^[a-f0-9]{64}$/.test(identity)) throw new Error("Cannot capture selected directory identity");
  return { path: root, identity };
}

/** Read-only check for previews; the mutation helper checks it again after opening. */
export async function assertApprovedSkillsRoot(root: ApprovedSkillsRoot): Promise<void> {
  if (!root || !path.isAbsolute(root.path) || !/^[a-f0-9]{64}$/.test(root.identity)) {
    throw new Error("An approved skills directory identity is required");
  }
  const current = await runSingle(["identity", root.path]);
  if (current !== root.identity) throw Object.assign(new Error("Selected skills directory changed since approval"), { code: "ESTALE" });
}

/** Obtain the same cross-process lock used by all local skill mutations. */
export async function withSkillsLock<T>(root: ApprovedSkillsRoot, action: () => Promise<T>): Promise<T> {
  if (!root || !path.isAbsolute(root.path) || !/^[a-f0-9]{64}$/.test(root.identity)) {
    throw new Error("An approved skills directory identity is required");
  }
  const current = sessions.getStore();
  if (current?.root.path === root.path) {
    if (current.root.identity !== root.identity) throw Object.assign(new Error("Conflicting approved directory identity"), { code: "ESTALE" });
    return action();
  }

  const process = new BoundaryProcess(["session", root.path, root.identity]);
  let started = false;
  let actionError: unknown;
  try {
    const recovered = await process.start();
    started = true;
    if (recovered) throw new Error(`${recovered} Review the recovered state and retry the operation.`);
    return await sessions.run({ root, process }, action);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    try {
      await process.finish();
    } catch (error) {
      if (actionError && started) {
        throw new AggregateError([actionError, error], `Action failed and the filesystem helper also reported cleanup failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!actionError) throw error;
    }
  }
}

/** Recover an existing journal without creating state for a newly adopted directory. */
export async function recoverSkills(root: ApprovedSkillsRoot): Promise<string | undefined> {
  if (!root || !path.isAbsolute(root.path) || !/^[a-f0-9]{64}$/.test(root.identity)) throw new Error("An approved skills directory identity is required");
  return runSingle(["recover", root.path, root.identity]);
}

async function fingerprintReviewedSkill(
  root: ApprovedSkillsRoot,
  name: string,
  expectedPath: string,
  mode: "identity" | "content",
): Promise<string> {
  if (!root || !path.isAbsolute(root.path) || !/^[a-f0-9]{64}$/.test(root.identity)) {
    throw new Error("An approved skills directory identity is required");
  }
  checkedName(name);
  const location = reviewedLocation(root.path, root.path, name, expectedPath);
  const value = await runSingle(["fingerprint-skill", root.path, root.identity, name, location, mode]);
  if (!value) throw new Error("Filesystem helper returned no fingerprint");
  checkedFingerprint(value);
  return value;
}

/** Fingerprint the exact reviewed skill under the approved root without following links. */
export function fingerprintSkill(root: ApprovedSkillsRoot, name: string, expectedPath: string): Promise<string> {
  return fingerprintReviewedSkill(root, name, expectedPath, "identity");
}

/** Fingerprint reviewed skill contents without including inode identity. */
export function fingerprintSkillContents(root: ApprovedSkillsRoot, name: string, expectedPath: string): Promise<string> {
  return fingerprintReviewedSkill(root, name, expectedPath, "content");
}

/** Fingerprint bytes and inode identities without following a skill or nested link. */
export function fingerprintTree(entryPath: string): Promise<string> {
  return runSingle(["fingerprint", path.resolve(entryPath), "identity"]).then((value) => {
    if (!value) throw new Error("Filesystem helper returned no fingerprint");
    checkedFingerprint(value);
    return value;
  });
}

/** Content-only fingerprint for provenance, stable across a safe staged copy. */
export function fingerprintContents(entryPath: string): Promise<string> {
  return runSingle(["fingerprint", path.resolve(entryPath), "content"]).then((value) => {
    if (!value) throw new Error("Filesystem helper returned no fingerprint");
    checkedFingerprint(value);
    return value;
  });
}

/** Read without following child links; stableIdentity includes the full leaf even if content is truncated. */
export async function readSkillPath(
  skillsDir: string,
  relativePath: string,
  options: { maxBytes?: number; expectedRoot?: ApprovedSkillsRoot } = {},
): Promise<{ kind: "file" | "symlink"; mode: number; content: Buffer; identity: string; stableIdentity: string; size: number; truncated: boolean }> {
  const limit = options.maxBytes;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid read byte limit");
  const root = path.resolve(skillsDir);
  if (options.expectedRoot && (options.expectedRoot.path !== root || !/^[a-f0-9]{64}$/.test(options.expectedRoot.identity))) {
    throw new Error("Read root does not match the approved directory");
  }
  const reply = await runSingle(["read", root, relativePath, limit === undefined ? "18446744073709551615" : String(limit), options.expectedRoot?.identity ?? "-"]);
  if (reply === undefined) throw new Error("Filesystem helper returned no file data");
  const [kind, mode, identity, stableIdentity, size, truncated, data] = reply.split("\t");
  const sizeNumber = Number(size);
  if ((kind !== "file" && kind !== "symlink") || !/^[0-7]+$/.test(mode) ||
      !/^[a-f0-9]{64}$/.test(identity) || !/^[a-f0-9]{64}$/.test(stableIdentity) ||
      !Number.isSafeInteger(sizeNumber) || sizeNumber < 0 ||
      (truncated !== "0" && truncated !== "1") || data === undefined || !/^(?:[a-f0-9]{2})*$/.test(data)) {
    throw new Error("Filesystem helper returned invalid file data");
  }
  return { kind, mode: parseInt(mode, 8), identity, stableIdentity, size: sizeNumber, truncated: truncated === "1", content: Buffer.from(data, "hex") };
}

/** Count text lines in bounded chunks without following links. */
export async function countSkillPathLines(skillsDir: string, relativePath: string, expectedRoot?: ApprovedSkillsRoot): Promise<number> {
  const root = path.resolve(skillsDir);
  if (expectedRoot && (expectedRoot.path !== root || !/^[a-f0-9]{64}$/.test(expectedRoot.identity))) {
    throw new Error("Read root does not match the approved directory");
  }
  const reply = await runSingle(["count-lines", root, relativePath, expectedRoot?.identity ?? "-"]);
  if (reply === undefined || !/^\d+$/.test(reply)) throw new Error("Filesystem helper returned an invalid line count");
  const count = Number(reply);
  if (!Number.isSafeInteger(count)) throw new Error("File line count exceeds the supported range");
  return count;
}

/** List descendants of the root or selected subtree without following links or crossing mounts. */
export async function listSkillPaths(
  skillsDir: string,
  options: { includeHidden?: boolean; expectedRoot?: ApprovedSkillsRoot; relativePath?: string } = {},
): Promise<Array<{ path: string; kind: "directory" | "file" | "symlink" }>> {
  const root = path.resolve(skillsDir);
  if (options.expectedRoot && (options.expectedRoot.path !== root || !/^[a-f0-9]{64}$/.test(options.expectedRoot.identity))) {
    throw new Error("Listing root does not match the approved directory");
  }
  const args = ["list", root, options.includeHidden ? "all" : "visible", options.expectedRoot?.identity ?? "-"];
  if (options.relativePath !== undefined) args.push(options.relativePath);
  const reply = await runSingle(args);
  if (!reply || !/^(?:[a-f0-9]{2})+$/.test(reply)) throw new Error("Filesystem helper returned invalid listing data");
  const bytes = Buffer.from(reply, "hex");
  const json = bytes.toString("utf8");
  if (!Buffer.from(json, "utf8").equals(bytes)) throw new Error("Filesystem helper returned invalid UTF-8 listing data");
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((entry: unknown) =>
    typeof entry === "object" && entry !== null && "path" in entry && typeof entry.path === "string" &&
    "kind" in entry && (entry.kind === "directory" || entry.kind === "file" || entry.kind === "symlink"))) {
    throw new Error("Filesystem helper returned an invalid listing");
  }
  return value as Array<{ path: string; kind: "directory" | "file" | "symlink" }>;
}

/** Capture reviewed text files from a safe staged tree, with an identity version. */
export async function readSkillFiles(directory: string): Promise<{ files: Array<{ path: string; content: string }>; version: string }> {
  const rootPath = path.resolve(directory);
  const root = await approveSkillsRoot(rootPath);
  const before = await runSingle(["fingerprint", rootPath, "staged"]);
  if (!before) throw new Error("Cannot fingerprint staged skill");
  checkedFingerprint(before);
  const entries = await listSkillPaths(rootPath, { includeHidden: true, expectedRoot: root });
  if (entries.length > 10000) throw new Error("Staged skill has too many entries to review");
  const files: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const entry of entries) {
    if (entry.path.split("/").length > 50) throw new Error("Staged skill exceeds the review depth limit");
    if (entry.kind === "symlink") throw new Error("Staged skill contains a symbolic link");
    if (entry.kind !== "file") continue;
    const value = await readSkillPath(rootPath, entry.path, { maxBytes: 2 * 1024 * 1024 - bytes, expectedRoot: root });
    if (value.kind !== "file" || value.truncated) throw new Error("Staged skill exceeds the review byte limit or changed while reading");
    bytes += value.content.byteLength;
    files.push({ path: entry.path, content: decoder.decode(value.content) });
  }
  const after = await runSingle(["fingerprint", rootPath, "staged"]);
  if (after !== before) throw Object.assign(new Error("Staged skill changed during review"), { code: "ESTALE" });
  return { files, version: before };
}

/** Read an external installer lock relative to the pinned selected root. */
export async function readParentSkillLock(skillsDir: string, expectedRoot?: ApprovedSkillsRoot): Promise<string | null> {
  const root = path.resolve(skillsDir);
  if (expectedRoot && (expectedRoot.path !== root || !/^[a-f0-9]{64}$/.test(expectedRoot.identity))) throw new Error("Lock root does not match the approved directory");
  const reply = await runSingle(["parent-lock", root, expectedRoot?.identity ?? "-"]);
  if (reply === undefined) return null;
  if (!/^(?:[a-f0-9]{2})*$/.test(reply)) throw new Error("Filesystem helper returned invalid external lock");
  return Buffer.from(reply, "hex").toString("utf8");
}

/** Compute Git's tree object ID for an external recorded-source claim. */
export async function gitTreeHash(directory: string): Promise<string> {
  const reply = await runSingle(["git-tree", path.resolve(directory)]);
  if (!reply || !/^[a-f0-9]{40}$/.test(reply)) throw new Error("Filesystem helper returned an invalid Git tree hash");
  return reply;
}

/** Read a manager-owned receipt without creating state or replaying a journal. */
export async function readManagedMetadata(skillsDir: string, name: string, expectedRoot?: ApprovedSkillsRoot): Promise<string | null> {
  checkedName(name);
  const root = path.resolve(skillsDir);
  if (expectedRoot && (expectedRoot.path !== root || !/^[a-f0-9]{64}$/.test(expectedRoot.identity))) {
    throw new Error("Receipt root does not match the approved directory");
  }
  const current = sessions.getStore();
  if (current?.root.path === root && expectedRoot && current.root.identity !== expectedRoot.identity) {
    throw Object.assign(new Error("Conflicting approved directory identity"), { code: "ESTALE" });
  }
  const reply = current?.root.path === root
    ? await current.process.command(["metadata", encode(name)])
    : await runSingle(["metadata", root, name, expectedRoot?.identity ?? "-"]);
  if (reply === undefined) return null;
  if (!/^(?:[a-f0-9]{2})*$/.test(reply)) throw new Error("Filesystem helper returned invalid provenance");
  return Buffer.from(reply, "hex").toString("utf8");
}

/** Capture the identity of a workspace created by this application. */
export async function directoryIdentity(directory: string): Promise<string> {
  const original = path.resolve(directory);
  const canonical = await realpath(original);
  const identity = await runSingle(["identity", canonical]);
  if (!identity || !/^[a-f0-9]{64}$/.test(identity)) throw new Error("Cannot capture workspace identity");
  return JSON.stringify({ original, canonical, identity });
}

/** Remove only the app-created disposable directory whose identity was captured. */
export async function removeDisposableTree(directory: string, token: string): Promise<void> {
  let captured: { original?: unknown; canonical?: unknown; identity?: unknown };
  try { captured = JSON.parse(token) as typeof captured; } catch { throw new Error("Invalid workspace identity"); }
  if (captured.original !== path.resolve(directory) || typeof captured.canonical !== "string" ||
      !path.isAbsolute(captured.canonical) || typeof captured.identity !== "string" || !/^[a-f0-9]{64}$/.test(captured.identity)) {
    throw new Error("Workspace identity does not match the requested path");
  }
  await runSingle(["dispose", captured.canonical, captured.identity]);
}

export async function moveReviewedSkill(root: ApprovedSkillsRoot, name: string, expectedVersion: string, direction: "disable" | "enable"): Promise<void> {
  checkedName(name);
  checkedFingerprint(expectedVersion);
  await withSkillsLock(root, async () => {
    await sessions.getStore()!.process.command([direction, encode(name), expectedVersion]);
  });
}

export async function deleteReviewedSkill(root: ApprovedSkillsRoot, name: string, expectedPath: string, expectedVersion: string): Promise<void> {
  checkedName(name);
  checkedFingerprint(expectedVersion);
  const location = reviewedLocation(root.path, root.path, name, expectedPath);
  await withSkillsLock(root, async () => {
    await sessions.getStore()!.process.command(["remove", encode(name), location, expectedVersion]);
  });
}

/** Detect a pending Git transaction without creating state or replaying it. */
export async function hasIndexTransaction(root: ApprovedSkillsRoot): Promise<boolean> {
  if (!root || !path.isAbsolute(root.path) || !/^[a-f0-9]{64}$/.test(root.identity)) {
    throw new Error("An approved skills directory identity is required");
  }
  const current = sessions.getStore();
  if (current?.root.path === root.path && current.root.identity !== root.identity) {
    throw Object.assign(new Error("Conflicting approved directory identity"), { code: "ESTALE" });
  }
  const reply = current?.root.path === root.path
    ? await current.process.command(["git-journal"])
    : await runSingle(["git-journal", root.path, root.identity]);
  if (reply !== "0" && reply !== "1") throw new Error("Filesystem helper returned an invalid Git transaction state");
  return reply === "1";
}

/** Inspect an app-created Git index while holding the installation lock. */
export async function inspectGitIndex(root: ApprovedSkillsRoot, name: string): Promise<string | null> {
  if (!/^git-index-[A-Za-z0-9_-]+(?:\.lock)?$/.test(name) || Buffer.byteLength(name) > 128) throw new Error("Invalid temporary Git index name");
  return withSkillsLock(root, async () => {
    const identity = await sessions.getStore()!.process.command(["index-id", encode(name)]);
    return identity ?? null;
  });
}

/** Remove an app-created Git index only if it is still the inspected inode. */
export async function cleanupGitIndex(root: ApprovedSkillsRoot, name: string, identity: string): Promise<void> {
  if (!/^git-index-[A-Za-z0-9_-]+(?:\.lock)?$/.test(name) || Buffer.byteLength(name) > 128 || !/^\d+:\d+$/.test(identity)) {
    throw new Error("Invalid temporary Git index or identity");
  }
  await withSkillsLock(root, async () => {
    await sessions.getStore()!.process.command(["index-clean", encode(name), identity]);
  });
}

export interface ImportOptions {
  expectedPath?: string;
  expectedVersion?: string;
  expectedStagedVersion: string;
  replace: boolean;
  /** A verified provenance record; absent metadata invalidates any old record. */
  metadata?: string;
}

/** Import only a reviewed staged tree, keeping the old tree until durable commit. */
export async function importSkill(root: ApprovedSkillsRoot, name: string, stagedPath: string, options: ImportOptions): Promise<void> {
  checkedName(name);
  checkedFingerprint(options.expectedStagedVersion);
  let location: "new" | "active" | "disabled" = "new";
  if (options.replace) {
    if (!options.expectedPath || !options.expectedVersion) throw new Error("Replacement requires the exact reviewed path and fingerprint");
    location = reviewedLocation(root.path, root.path, name, options.expectedPath);
    checkedFingerprint(options.expectedVersion);
  } else if (options.expectedPath || options.expectedVersion) {
    throw new Error("A new installation cannot specify a replacement path or fingerprint");
  }
  if (options.metadata !== undefined && Buffer.byteLength(options.metadata) > 1024 * 1024) {
    throw new Error("Provenance metadata exceeds the supported size");
  }
  await withSkillsLock(root, async () => {
    await sessions.getStore()!.process.command([
      "import", encode(name), encode(path.resolve(stagedPath)), location,
      options.expectedStagedVersion, options.expectedVersion ?? "-",
      options.metadata === undefined ? "-" : encode(options.metadata),
    ]);
  });
}
