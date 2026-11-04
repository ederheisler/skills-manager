import { constants as bufferConstants } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { getSystemErrorName } from "node:util";
import type { CommitPreview, GitBinding, PullPreview } from "./git.js";
import type { TransactionEntry } from "./gitTransaction.js";

// This process is started only by skills-git-boundary, after confinement. FD 6
// is its private bridge to descriptor-relative native filesystem operations.
const bridgeFd = 6;
const git = process.argv[2];
const Op = {
  IndexRead: 1,
  LockCreate: 2,
  LockWrite: 3,
  LockCommit: 4,
  LockAbort: 5,
  PrivateRead: 6,
  PrivatePut: 7,
  PrivateDelete: 8,
  LockAdopt: 10,
  LockRemoveIndex: 11,
  HeadRead: 12,
  StateRead: 13,
  StatePut: 14,
  StateDelete: 15,
  LockAcquire: 16,
  PrivateStat: 17,
  StateTempRead: 18,
  StateTempDelete: 19,
  StateDeleteRead: 20,
  StateDeleteFinish: 21,
  RootInfo: 22,
  RootList: 23,
  StageCreate: 24,
  StagePut: 25,
  StageInfo: 26,
  RootToStage: 27,
  StageToRoot: 28,
  StageDelete: 29,
  StageRemove: 30,
  RefLockInspect: 31,
  RefLockRemove: 32,
} as const;
type Op = typeof Op[keyof typeof Op];

interface Request {
  action: "fingerprint" | "commit" | "pull" | "recover";
  binding: GitBinding;
  approvedIdentity: string;
  preview?: CommitPreview;
  pullPreview?: PullPreview;
  newOid?: string;
  entries?: TransactionEntry[];
}
type NodeKind = 1 | 2 | 3 | 4;
interface WorktreeNode {
  path: string;
  slot: string;
  kind: NodeKind;
  identity: string | null;
  fingerprint: string;
}
interface PullState {
  stage: string | null;
  removals: WorktreeNode[];
  additions: WorktreeNode[];
}
interface PullRefLock {
  pid: number;
  update: boolean;
  proof: string | null;
}
interface Journal {
  version: 1;
  mode?: "pull";
  pull?: PullState;
  refLock?: PullRefLock | null;
  id: string;
  approvedIdentity: string;
  binding: GitBinding;
  branch: string | null;
  head: string | null;
  newOid: string;
  oldIndex: string | null;
  newIndex: string | null;
  backupIdentity: string | null;
  indexIdentity: string | null;
  phase: "started" | "prepared" | "committed";
  lockId: string | null;
  lock: string | null;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
function readAll(fd: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (!count) throw new Error("The Git transaction filesystem bridge closed unexpectedly");
    offset += count;
  }
  return bytes;
}
function rpc(op: Op, name = "", data: Buffer = Buffer.alloc(0)): Buffer {
  const encodedName = Buffer.from(name);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(encodedName.length, 4);
  header.writeBigUInt64LE(BigInt(data.length), 8);
  writeAll(bridgeFd, header);
  writeAll(bridgeFd, encodedName);
  writeAll(bridgeFd, data);
  const reply = readAll(bridgeFd, 16);
  const errno = reply.readUInt32LE(0);
  const size = reply.readBigUInt64LE(8);
  if (size > BigInt(bufferConstants.MAX_LENGTH)) throw new Error("The Git transaction bridge response is too large");
  const body = readAll(bridgeFd, Number(size));
  if (errno) {
    const code = getSystemErrorName(-errno);
    throw Object.assign(new Error(`Git transaction filesystem operation failed: ${code}`), { code });
  }
  return body;
}
function maybeRpc(op: Op, name = ""): Buffer | null {
  try { return rpc(op, name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function digest(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}
function privateName(journal: Journal, suffix: string): string {
  return `.skill-manager-txn-${journal.id}.${suffix}`;
}
function privateIndexPath(name: string): string {
  // Git enters the worktree before resolving a relative GIT_INDEX_FILE.
  // Linux can retain the pinned Git directory via fd 4; macOS cannot
  // traverse /dev/fd, so use the helper's pinned Git-directory cwd.
  const gitDir = process.platform === "linux" ? "/proc/self/fd/4" : process.cwd();
  return `${gitDir}/${name}`;
}
function save(journal: Journal): void {
  rpc(Op.StatePut, "", Buffer.from(JSON.stringify(journal)));
}
function equalBinding(a: GitBinding, b: GitBinding): boolean {
  const same = (x: { dev: string; ino: string }, y: { dev: string; ino: string }) => x?.dev === y?.dev && x?.ino === y?.ino;
  return !!a && !!b && same(a.root, b.root) && same(a.gitEntry, b.gitEntry) &&
    a.gitDir === b.gitDir && same(a.gitDirIdentity, b.gitDirIdentity) &&
    a.commonDir === b.commonDir && same(a.commonDirIdentity, b.commonDirIdentity);
}
function validOid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
function validHash(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}
function validWorktreePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." &&
      part.toLowerCase() !== ".git" && part.toLowerCase() !== ".skills-manager");
}
function refLockContents(bytes: Buffer): (Buffer | null)[] {
  let offset = 0;
  const records: (Buffer | null)[] = [];
  for (let index = 0; index < 2; index++) {
    if (offset >= bytes.length) throw new Error("Invalid Git reference lock proof");
    const present = bytes[offset++];
    if (present === 0) { records.push(null); continue; }
    if (present !== 1 || offset + 24 > bytes.length) throw new Error("Invalid Git reference lock proof");
    offset += 16;
    const size = bytes.readBigUInt64LE(offset);
    offset += 8;
    if (size > BigInt(bytes.length - offset)) throw new Error("Invalid Git reference lock proof");
    const end = offset + Number(size);
    records.push(bytes.subarray(offset, end));
    offset = end;
  }
  if (offset !== bytes.length) throw new Error("Invalid Git reference lock proof");
  return records;
}
function validPullRefLock(value: PullRefLock | null | undefined, target: string, branchName: string | null): boolean {
  if (value === null) return true;
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.update !== "boolean") return false;
  if (value.proof === null) return true;
  if (typeof value.proof !== "string" || !/^(?:[a-f0-9]{2})+$/.test(value.proof)) return false;
  try {
    const [head, branch] = refLockContents(Buffer.from(value.proof, "hex"));
    if (!head) return false;
    const expected = Buffer.from(value.update ? `${target}\n` : "");
    return branchName === null ? branch === null && head.equals(expected)
      : head.length === 0 && !!branch && branch.equals(expected);
  } catch { return false; }
}
function validPullState(journal: Journal): boolean {
  const state = journal.pull;
  if (!state || !(state.stage === null || /^[a-f0-9]{32}$/.test(state.stage)) ||
      !Array.isArray(state.removals) || !Array.isArray(state.additions)) return false;
  const slots = new Set<string>();
  const node = (item: WorktreeNode, addition: boolean): boolean => {
    if (!item || !validWorktreePath(item.path) || typeof item.slot !== "string" ||
        !/^[a-z][a-z0-9]{0,30}$/.test(item.slot) || slots.has(item.slot) ||
        ![1, 2, 3, 4].includes(item.kind) || typeof item.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
        !(typeof item.identity === "string" && /^[a-f0-9]{32}$/.test(item.identity)) &&
          !(addition && journal.phase === "started" && item.identity === null)) return false;
    slots.add(item.slot);
    return true;
  };
  return state.removals.every((item) => node(item, false)) &&
    state.additions.every((item) => node(item, true)) &&
    (journal.phase === "started" || (state.stage !== null &&
      state.additions.every((item) => item.identity !== null))) &&
    journal.branch !== null && validOid(journal.head) && journal.head.length === journal.newOid.length;
}
function loadJournal(request: Request, op: Op = Op.StateRead): Journal | null {
  let bytes: Buffer | null;
  try { bytes = maybeRpc(op); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADMSG") {
      throw new Error("A pending Git transaction journal is malformed; preserve it for manual recovery");
    }
    throw error;
  }
  if (!bytes) return null;
  let journal: Journal;
  try { journal = JSON.parse(bytes.toString("utf8")) as Journal; }
  catch { throw new Error("The pending Git transaction journal is invalid; preserve it for manual recovery"); }
  if (!journal || journal.version !== 1 || !/^[a-f0-9]{32}$/.test(journal.id) ||
      journal.approvedIdentity !== request.approvedIdentity || !equalBinding(journal.binding, request.binding) ||
      !(journal.branch === null || (typeof journal.branch === "string" && journal.branch.length > 0 && !/[\s\0]/.test(journal.branch))) ||
      !(journal.head === null || validOid(journal.head)) || !validOid(journal.newOid) ||
      !validHash(journal.oldIndex) || !validHash(journal.newIndex) ||
      !["started", "prepared", "committed"].includes(journal.phase) ||
      (journal.phase !== "started" && (journal.newIndex === null || journal.indexIdentity === null || (journal.oldIndex !== null && journal.backupIdentity === null))) ||
      !(journal.backupIdentity === null || (typeof journal.backupIdentity === "string" && /^[0-9a-f]{32}$/.test(journal.backupIdentity))) ||
      !(journal.indexIdentity === null || (typeof journal.indexIdentity === "string" && /^[0-9a-f]{32}$/.test(journal.indexIdentity))) ||
      !(journal.lockId === null || (typeof journal.lockId === "string" && /^[0-9a-f]{32}$/.test(journal.lockId))) ||
      !(journal.lock === null || (journal.lockId !== null && typeof journal.lock === "string" && /^[0-9a-f]{32}$/.test(journal.lock))) ||
      !(journal.refLock === undefined || validPullRefLock(journal.refLock, journal.newOid, journal.branch)) ||
      !(journal.mode === undefined ? journal.pull === undefined : journal.mode === "pull" && validPullState(journal))) {
    throw new Error("The pending Git transaction does not match the approved repository; preserve it for manual recovery");
  }
  return journal;
}
function requireAbsentPrivate(name: string): void {
  if (maybeRpc(Op.PrivateStat, name) !== null) {
    throw new Error("A private Git transaction file has no durable cleanup proof; preserve it for manual inspection");
  }
}
function checkCleanupEvidence(journal: Journal): void {
  if (journal.indexIdentity === null) {
    requireAbsentPrivate(privateName(journal, "index"));
    requireAbsentPrivate(privateName(journal, "index.delete"));
  }
  if (journal.backupIdentity === null) {
    requireAbsentPrivate(privateName(journal, "backup"));
    requireAbsentPrivate(privateName(journal, "backup.delete"));
  }
  // Git can leave this lock if its private index rewrite is interrupted.
  requireAbsentPrivate(privateName(journal, "index.lock"));
  requireAbsentPrivate(privateName(journal, "index.lock.delete"));
  if (journal.lockId !== null) {
    requireAbsentPrivate(`.skill-manager-txn-${journal.lockId}.lock`);
    requireAbsentPrivate(`.skill-manager-txn-${journal.lockId}.lock.delete`);
  }
}
function cleanup(journal: Journal): void {
  checkCleanupEvidence(journal);
  // Never remove a private name without the inode proof saved in the journal.
  for (const [suffix, identity] of [["index", journal.indexIdentity], ["backup", journal.backupIdentity]] as const) {
    if (identity === null) continue;
    try { rpc(Op.PrivateDelete, privateName(journal, suffix), Buffer.from(identity, "hex")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  rpc(Op.StateDelete);
}
function headMatches(journal: Journal): boolean {
  const text = rpc(Op.HeadRead).toString("utf8");
  if (journal.branch !== null) return text === `ref: refs/heads/${journal.branch}\n`;
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(text);
}

const gitConfig = [
  "--no-lazy-fetch", "--no-replace-objects",
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.sharedRepository=0",
  "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync",
  "-c", "protocol.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
];
const filterConfig: string[] = [];
function gitProcess(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  // FD 6 is intentionally not inherited by Git; 3-5 keep the reviewed
  // directories alive for the Linux /proc/self/fd Git environment.
  return spawn(git, [...gitConfig, ...filterConfig, ...args], {
    env: { ...process.env, ...extra },
    stdio: ["pipe", "pipe", "pipe", 3, 4, 5],
  }) as ChildProcessWithoutNullStreams;
}
async function runGitBytes(args: string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const child = gitProcess(args, extra);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => undefined);
  const done = once(child, "close").then(([code]) => typeof code === "number" ? code : 1);
  child.stdin.end(input);
  const code = await done;
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8"), code };
}
async function runGit(args: string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await runGitBytes(args, input, extra);
  return { ...result, stdout: result.stdout.toString("utf8") };
}
async function requiredGitBytes(args: string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
  const result = await runGitBytes(args, input, extra);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Git ${args[0]} failed`);
  return result.stdout;
}
async function requiredGit(args: string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await runGit(args, input, extra);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Git ${args[0]} failed`);
  return result.stdout;
}
async function disableFilters(): Promise<void> {
  const result = await runGit(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || "Cannot inspect Git filters");
  const names = new Set(result.stdout.split("\0").filter(Boolean).map((key) => key.slice(7, key.lastIndexOf("."))));
  for (const name of names) {
    for (const key of ["clean", "smudge", "process"]) filterConfig.push("-c", `filter.${name}.${key}=`);
    filterConfig.push("-c", `filter.${name}.required=false`);
  }
}
async function requireTransactionSupport(): Promise<void> {
  const version = await requiredGit(["--version"]);
  const match = /^git version (\d+)\.(\d+)(?:\.|\b)/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 48)) {
    throw new Error("Safe Git commit transactions require Git 2.48 or newer");
  }
}
async function requireFilesRefBackend(): Promise<void> {
  const format = (await requiredGit(["rev-parse", "--show-ref-format"])).trim();
  if (format !== "files") throw new Error("Recoverable Git transactions require the files reference backend");
}

class RefTransaction {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: AsyncIterator<string>;
  private readonly done: Promise<number>;
  private stderr = "";
  private finished = false;

  constructor() {
    this.child = gitProcess(["update-ref", "--stdin"]);
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.stdin.on("error", () => undefined);
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    this.done = once(this.child, "close").then(([code]) => typeof code === "number" ? code : 1);
    void this.done.catch(() => undefined);
  }
  get pid(): number {
    if (this.child.pid === undefined) throw new Error("Git reference transaction did not start");
    return this.child.pid;
  }
  private async response(expected: string): Promise<void> {
    const line = await this.lines.next();
    if (line.done || line.value !== `${expected}: ok`) {
      await this.done.catch(() => 1);
      throw new Error(this.stderr.trim() || `Git could not ${expected} the reference transaction`);
    }
  }
  async prepare(command: string): Promise<void> {
    this.child.stdin.write(`start\n${command}\nprepare\n`);
    await this.response("start");
    await this.response("prepare");
  }
  async commit(): Promise<void> {
    this.child.stdin.end("commit\n");
    await this.response("commit");
    const code = await this.done;
    this.finished = true;
    if (code !== 0) throw new Error(this.stderr.trim() || "Git could not commit the reference transaction");
  }
  async abort(): Promise<void> {
    if (this.finished) return;
    this.child.stdin.end("abort\n");
    await this.done.catch(() => 1);
    this.finished = true;
  }
}
async function prepareBoundRef(journal: Journal, ref: RefTransaction, command: string, update: boolean): Promise<void> {
  journal.refLock = { pid: ref.pid, update, proof: null };
  save(journal);
  await ref.prepare(command);
  if (!headMatches(journal)) throw new Error("The Git branch changed since the approved preview");
  const captured: PullRefLock = {
    pid: ref.pid, update, proof: rpc(Op.RefLockInspect, journal.branch ?? "").toString("hex"),
  };
  if (!validPullRefLock(captured, journal.newOid, journal.branch)) {
    throw new Error("Cannot establish ownership of the prepared Git reference locks");
  }
  journal.refLock = captured;
  save(journal);
}
async function releaseRecordedRefLocks(journal: Journal): Promise<void> {
  const lock = journal.refLock;
  if (!lock) return;
  await requireFilesRefBackend();
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new Error("The prior Git reference transaction may still be running");
    }
    if (lock.proof === null) {
      if (!headMatches(journal) || refLockContents(rpc(Op.RefLockInspect, journal.branch ?? "")).some((record) => record !== null)) {
        throw new Error("A Git reference lock has no durable ownership proof; preserve it for manual inspection");
      }
    } else {
      rpc(Op.RefLockRemove, journal.branch ?? "", Buffer.from(lock.proof, "hex"));
    }
    journal.refLock = null;
    save(journal);
    return;
  }
  throw new Error("The prior Git reference transaction is still running; retry recovery after it exits");
}

function validateCommit(request: Request): asserts request is Request & { preview: CommitPreview; newOid: string; entries: TransactionEntry[] } {
  const { preview, entries, newOid } = request;
  if (!preview || !equalBinding(preview.binding, request.binding) || !validOid(newOid) || !Array.isArray(entries) ||
      !(preview.head === null || (validOid(preview.head) && preview.head.length === newOid.length)) ||
      !(preview.branch === null || (typeof preview.branch === "string" && preview.branch.length > 0 && !/[\s\0]/.test(preview.branch))) ||
      !validHash(preview.indexFingerprint) || !Array.isArray(preview.paths) || preview.paths.length !== entries.length) {
    throw new Error("Invalid approved Git commit transaction");
  }
  const selected = new Set(preview.paths);
  if (selected.size !== preview.paths.length || entries.some((entry) => !entry || !selected.delete(entry.path) ||
    typeof entry.path !== "string" || !entry.path || entry.path.startsWith("/") || entry.path.includes("\0") ||
    entry.path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".skills-manager") ||
    (entry.mode === null ? entry.oid !== null : !["100644", "100755", "120000"].includes(entry.mode) || !validOid(entry.oid) || entry.oid.length !== newOid.length))) {
    throw new Error("The transaction entries do not match the approved skill paths");
  }
}
async function updatePrivateIndex(journal: Journal, entries: TransactionEntry[], oidLength: number, indexName: string): Promise<void> {
  const deletions = entries.filter((entry) => entry.mode === null);
  try {
    if (deletions.length) {
      const input = Buffer.concat(deletions.map((entry) => Buffer.from(`0 ${"0".repeat(oidLength)}\t${entry.path}\0`)));
      await rewritePrivateIndex(journal, indexName, ["update-index", "-z", "--index-info"], input);
    }
    // --index-info implicitly enables --replace, which can discard an
    // unrelated staged D/F entry. --cacheinfo without --replace refuses it.
    let args = ["update-index", "--add"];
    let bytes = 0;
    for (const entry of entries) {
      if (entry.mode === null) continue;
      const value = `${entry.mode},${entry.oid},${entry.path}`;
      const size = Buffer.byteLength(value) + 13;
      if (bytes && bytes + size > 65536) {
        await rewritePrivateIndex(journal, indexName, args);
        args = ["update-index", "--add"];
        bytes = 0;
      }
      args.push("--cacheinfo", value);
      bytes += size;
    }
    if (bytes) await rewritePrivateIndex(journal, indexName, args);
  } catch (error) {
    throw new Error(`Cannot update the selected index entries without changing unrelated staged entries: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function identityHex(bytes: Buffer): string {
  if (bytes.length !== 16) throw new Error("Invalid Git transaction file identity");
  return bytes.toString("hex");
}
async function rewritePrivateIndex(journal: Journal, indexName: string, args: string[], input?: Buffer): Promise<void> {
  if (journal.indexIdentity === null) throw new Error("The private Git index has no recorded identity");
  // Each Git command may replace the index inode. Never retain its old proof
  // across an interruption; record the resulting inode after Git has exited.
  journal.indexIdentity = null;
  save(journal);
  try {
    await requiredGit(args, input, { GIT_INDEX_FILE: privateIndexPath(indexName) });
  } catch (error) {
    const remaining = maybeRpc(Op.PrivateStat, indexName);
    if (remaining !== null) {
      journal.indexIdentity = identityHex(remaining);
      save(journal);
    }
    throw error;
  }
  journal.indexIdentity = identityHex(rpc(Op.PrivateStat, indexName));
  save(journal);
}
function emptyIndex(oidLength: number): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(2, 4);
  const checksum = createHash(oidLength === 40 ? "sha1" : "sha256").update(header).digest();
  return Buffer.concat([header, checksum]);
}
interface WorktreeSnapshot {
  kind: NodeKind;
  mode: number;
  identity: string;
  fingerprint: string;
  content: Buffer;
}
interface TreeEntry { mode: string; oid: string }

function decodeUtf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("A Git path is not valid UTF-8"); }
}
function snapshotReply(bytes: Buffer): WorktreeSnapshot {
  if (bytes.length < 85 || ![1, 2, 3, 4].includes(bytes[0])) throw new Error("Invalid worktree transaction snapshot");
  const fingerprint = bytes.subarray(21, 85).toString("ascii");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid worktree transaction fingerprint");
  return {
    kind: bytes[0] as NodeKind, mode: bytes.readUInt32LE(1),
    identity: identityHex(bytes.subarray(5, 21)), fingerprint, content: bytes.subarray(85),
  };
}
function sameNode(snapshot: WorktreeSnapshot | null, node: WorktreeNode): boolean {
  return !!snapshot && snapshot.kind === node.kind && snapshot.identity === node.identity &&
    snapshot.fingerprint === node.fingerprint;
}
function rootSnapshot(file: string): WorktreeSnapshot | null {
  try { return snapshotReply(rpc(Op.RootInfo, file)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
function stageSnapshot(journal: Journal, node: WorktreeNode): WorktreeSnapshot | null {
  if (!journal.pull?.stage) throw new Error("The pull staging directory has no ownership proof");
  try {
    return snapshotReply(rpc(Op.StageInfo, `${journal.id}/${node.slot}`, Buffer.from(journal.pull.stage, "hex")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function nodeRequest(journal: Journal, node: WorktreeNode): Buffer {
  if (!journal.pull?.stage || node.identity === null) throw new Error("The pull object has no ownership proof");
  const slot = Buffer.from(node.slot, "ascii");
  return Buffer.concat([
    Buffer.from(journal.id, "ascii"), Buffer.from(journal.pull.stage, "hex"),
    Buffer.from([slot.length]), slot, Buffer.from(node.identity, "hex"),
    Buffer.from(node.fingerprint, "ascii"), Buffer.from([node.kind]),
  ]);
}
function stageDelete(journal: Journal, node: WorktreeNode): void {
  if (!journal.pull?.stage || node.identity === null) throw new Error("The pull object has no ownership proof");
  rpc(Op.StageDelete, `${journal.id}/${node.slot}`, Buffer.concat([
    Buffer.from(journal.pull.stage, "hex"), Buffer.from(node.identity, "hex"),
    Buffer.from(node.fingerprint, "ascii"), Buffer.from([node.kind]),
  ]));
}
function rootChildren(file: string): string[] {
  const output = rpc(Op.RootList, file);
  const names = decodeUtf8(output).split("\0");
  if (names.pop() !== "") throw new Error("Invalid worktree directory listing");
  if (names.some((name) => !name || name.includes("/") || name === "." || name === "..")) {
    throw new Error("Invalid worktree directory entry");
  }
  return names;
}
async function treeEntries(commit: string, changed: Set<string>): Promise<Map<string, TreeEntry>> {
  const output = decodeUtf8(await requiredGitBytes(["ls-tree", "-r", "-z", "--full-tree", commit]));
  const records = output.split("\0");
  if (records.pop() !== "") throw new Error("Invalid Git tree listing");
  const result = new Map<string, TreeEntry>();
  for (const record of records) {
    const tab = record.indexOf("\t");
    const file = record.slice(tab + 1);
    if (!changed.has(file)) continue;
    const match = /^([0-7]{6}) blob ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(record.slice(0, tab));
    if (tab < 0 || !match || !validWorktreePath(file) ||
        !["100644", "100755", "120000"].includes(match[1]) || result.has(file)) {
      throw new Error("The Git tree contains an unsupported path or entry");
    }
    result.set(file, { mode: match[1], oid: match[2] });
  }
  return result;
}
async function blobContent(entry: TreeEntry, file: string, indexName: string, attrSource?: string): Promise<Buffer> {
  const args = entry.mode === "120000"
    ? ["cat-file", "blob", entry.oid]
    : ["cat-file", "--filters", `--path=${file}`, entry.oid];
  return requiredGitBytes(args, undefined, {
    GIT_INDEX_FILE: privateIndexPath(indexName), ...(attrSource ? { GIT_ATTR_SOURCE: attrSource } : {}),
  });
}
function kindForMode(mode: string): NodeKind {
  return mode === "120000" ? 3 : mode === "100755" ? 2 : 1;
}
function nodeFromSnapshot(file: string, slot: string, snapshot: WorktreeSnapshot): WorktreeNode {
  return { path: file, slot, kind: snapshot.kind, identity: snapshot.identity, fingerprint: snapshot.fingerprint };
}
interface PullPlan {
  removals: WorktreeNode[];
  directories: string[];
  incoming: Map<string, TreeEntry>;
}
async function planPull(preview: PullPreview, indexName: string): Promise<PullPlan> {
  if (!Array.isArray(preview.paths) || preview.paths.some((file) => !validWorktreePath(file)) ||
      new Set(preview.paths).size !== preview.paths.length) throw new Error("Invalid approved pull paths");
  const output = decodeUtf8(await requiredGitBytes([
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", preview.head, preview.target,
  ]));
  const paths = output.split("\0");
  if (paths.pop() !== "") throw new Error("Invalid Git pull path listing");
  if (JSON.stringify([...paths].sort()) !== JSON.stringify([...preview.paths].sort())) {
    throw new Error("The incoming paths changed since the pull preview");
  }
  const changed = new Set(paths);
  const before = await treeEntries(preview.head, changed);
  const incoming = await treeEntries(preview.target, changed);
  if (paths.some((file) => !before.has(file) && !incoming.has(file))) {
    throw new Error("The incoming Git tree does not match the approved paths");
  }
  const removals: WorktreeNode[] = [];
  const oldFiles = new Map<string, WorktreeNode>();
  for (const [file, entry] of before) {
    const snapshot = rootSnapshot(file);
    if (!snapshot || snapshot.kind !== kindForMode(entry.mode) ||
        !snapshot.content.equals(await blobContent(entry, file, indexName))) {
      throw new Error(`Pull would overwrite local changes at ${JSON.stringify(file)}`);
    }
    const node = nodeFromSnapshot(file, `o${removals.length.toString(36)}`, snapshot);
    removals.push(node);
    oldFiles.set(file, node);
  }

  // A directory replaced by an incoming file may contain ignored files. Git's
  // read-tree does not protect those, so inventory every descendant first.
  const removedDirectories = new Set<string>();
  const inspectDirectory = (directory: string): void => {
    if (removedDirectories.has(directory)) return;
    if (![...oldFiles.keys()].some((file) => file.startsWith(`${directory}/`))) {
      throw new Error(`Pull would replace an unrelated directory at ${JSON.stringify(directory)}`);
    }
    for (const child of rootChildren(directory)) {
      const file = `${directory}/${child}`;
      const snapshot = rootSnapshot(file);
      if (!snapshot) throw new Error(`A pull destination changed at ${JSON.stringify(file)}`);
      if (snapshot.kind === 4) inspectDirectory(file);
      else if (!oldFiles.has(file) || !sameNode(snapshot, oldFiles.get(file)!)) {
        throw new Error(`Pull would overwrite untracked or ignored data at ${JSON.stringify(file)}`);
      }
    }
    const snapshot = rootSnapshot(directory);
    if (!snapshot || snapshot.kind !== 4) throw new Error("A pull directory changed during inspection");
    const node = nodeFromSnapshot(directory, `o${removals.length.toString(36)}`, snapshot);
    removals.push(node);
    removedDirectories.add(directory);
  };
  for (const file of incoming.keys()) {
    const snapshot = rootSnapshot(file);
    if (!snapshot) continue;
    if (snapshot.kind === 4) inspectDirectory(file);
    else if (!oldFiles.has(file) || !sameNode(snapshot, oldFiles.get(file)!)) {
      throw new Error(`Pull would overwrite untracked or ignored data at ${JSON.stringify(file)}`);
    }
  }
  const directories = new Set<string>();
  for (const file of incoming.keys()) {
    const parts = file.split("/");
    for (let count = 1; count < parts.length; count++) {
      const ancestor = parts.slice(0, count).join("/");
      const snapshot = rootSnapshot(ancestor);
      if (snapshot?.kind === 4 && !removedDirectories.has(ancestor)) continue;
      if (snapshot && (!oldFiles.has(ancestor) || !sameNode(snapshot, oldFiles.get(ancestor)!))) {
        throw new Error(`A pull destination is blocked by ${JSON.stringify(ancestor)}`);
      }
      directories.add(ancestor);
    }
  }
  const depth = (file: string): number => file.split("/").length;
  removals.sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path));
  return { removals, directories: [...directories].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)), incoming };
}

async function currentHead(journal: Journal): Promise<string | null | undefined> {
  if (!headMatches(journal)) return undefined;
  const result = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (result.code === 1) return null;
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Cannot inspect the Git transaction reference");
  const value = result.stdout.trim();
  if (!validOid(value)) throw new Error("The Git transaction reference is invalid");
  return value;
}
function tryAdopt(journal: Journal): 0 | 1 | 2 | null {
  if (journal.lock === null || journal.lockId === null) return null;
  try {
    const status = rpc(Op.LockAdopt, `.skill-manager-txn-${journal.lockId}.lock`, Buffer.from(journal.lock, "hex"));
    if (status.length !== 1 || status[0] > 2) throw new Error("Invalid Git index lock recovery status");
    return status[0] as 0 | 1 | 2;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function acquire(journal: Journal): void {
  // Persist the fresh private name before creating it. A crash before its
  // inode is recorded cannot leave an index.lock: linking happens only after
  // both name and inode have been durably journalled.
  journal.lockId = randomBytes(16).toString("hex");
  journal.lock = null;
  save(journal);
  journal.lock = identityHex(rpc(Op.LockCreate, `.skill-manager-txn-${journal.lockId}.lock`));
  try { save(journal); }
  catch (error) {
    try { rpc(Op.LockAbort); } catch { /* Preserve the journal for recovery. */ }
    throw error;
  }
  rpc(Op.LockAcquire);
}
function checkPullTransition(journal: Journal): void {
  const state = journal.pull!;
  const removals = new Map(state.removals.map((node) => [node.path, node]));
  const additions = new Map(state.additions.map((node) => [node.path, node]));
  for (const node of state.removals) {
    const staged = stageSnapshot(journal, node);
    const current = rootSnapshot(node.path);
    if (sameNode(staged, node)) {
      const replacement = additions.get(node.path);
      if (current && (!replacement || !sameNode(current, replacement))) {
        throw new Error(`A pull path changed after interruption: ${JSON.stringify(node.path)}`);
      }
    } else if (staged || !sameNode(current, node)) {
      throw new Error(`A pull preimage changed after interruption: ${JSON.stringify(node.path)}`);
    }
    if (node.kind === 4 && sameNode(current, node)) {
      for (const child of rootChildren(node.path)) {
        const file = `${node.path}/${child}`;
        const known = removals.get(file) ?? additions.get(file);
        if (!known || !sameNode(rootSnapshot(file), known)) {
          throw new Error(`A pull directory contains foreign data: ${JSON.stringify(file)}`);
        }
      }
    }
  }
  for (const node of state.additions) {
    const staged = stageSnapshot(journal, node);
    const current = rootSnapshot(node.path);
    if (sameNode(current, node)) {
      if (staged) throw new Error(`A pull object has conflicting locations: ${JSON.stringify(node.path)}`);
    } else if (sameNode(staged, node)) {
      const prior = removals.get(node.path);
      if (current && (!prior || !sameNode(current, prior))) {
        throw new Error(`A pull destination contains foreign data: ${JSON.stringify(node.path)}`);
      }
    } else {
      throw new Error(`A staged pull object changed: ${JSON.stringify(node.path)}`);
    }
  }
}
function applyPullWorktree(journal: Journal): void {
  checkPullTransition(journal);
  for (const node of journal.pull!.removals) {
    if (sameNode(stageSnapshot(journal, node), node)) continue;
    rpc(Op.RootToStage, node.path, nodeRequest(journal, node));
  }
  for (const node of journal.pull!.additions) {
    if (sameNode(rootSnapshot(node.path), node)) continue;
    rpc(Op.StageToRoot, node.path, nodeRequest(journal, node));
  }
}
function cleanupPull(journal: Journal): void {
  checkCleanupEvidence(journal);
  const state = journal.pull!;
  if (state.stage === null) {
    // If creation completed before its identity was journalled, EEXIST is not
    // ownership proof. Leave that directory and the journal for inspection.
    state.stage = identityHex(rpc(Op.StageCreate, journal.id));
    save(journal);
  }
  for (const node of state.additions) {
    const staged = stageSnapshot(journal, node);
    if (!staged) continue;
    if (journal.phase !== "started" || node.identity === null || !sameNode(staged, node)) {
      throw new Error("A pull staging object cannot be safely cleaned up; preserve it for review");
    }
    stageDelete(journal, node);
  }
  for (const node of state.removals) {
    const staged = stageSnapshot(journal, node);
    if (!staged) continue;
    if (journal.phase !== "committed" || !sameNode(staged, node)) {
      throw new Error("A saved pull preimage cannot be safely cleaned up; preserve it for review");
    }
    stageDelete(journal, node);
  }
  try { rpc(Op.StageRemove, journal.id, Buffer.from(state.stage, "hex")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  cleanup(journal);
}
async function recoverPull(journal: Journal): Promise<{ message: string; committed: boolean }> {
  if (journal.phase === "started") {
    const lock = tryAdopt(journal);
    if (lock === 2) throw new Error("An unexpected installed pull index requires manual recovery");
    if (lock !== null) rpc(Op.LockAbort);
    cleanupPull(journal);
    return { message: "An interrupted pull was cancelled before changing the worktree.", committed: false };
  }
  if (journal.phase === "committed") {
    const lock = tryAdopt(journal);
    if (lock !== null) rpc(Op.LockAbort);
    cleanupPull(journal);
    return { message: "A completed pull transaction was recovered.", committed: true };
  }

  await requireTransactionSupport();
  await requireFilesRefBackend();
  let lock = tryAdopt(journal);
  if (lock === 2) {
    rpc(Op.LockAbort);
    lock = null;
  }
  if (lock === null) acquire(journal);
  else if (lock === 0) rpc(Op.LockAcquire);
  const head = await currentHead(journal);
  if (head !== journal.head && head !== journal.newOid) {
    throw new Error("The interrupted pull conflicts with the current branch; preserve the journal and review it");
  }
  const ref = new RefTransaction();
  try {
    await prepareBoundRef(journal, ref, head === journal.head
      ? `update HEAD ${journal.newOid} ${journal.head}`
      : `verify HEAD ${journal.newOid}`, head === journal.head);
    const currentIndex = digest(maybeRpc(Op.IndexRead));
    if (currentIndex !== journal.oldIndex && currentIndex !== journal.newIndex) {
      throw new Error("The Git index changed after the interrupted pull; it was not overwritten");
    }
    if (head === journal.head && currentIndex !== journal.oldIndex) {
      throw new Error("The index changed before the pull reference advanced; review it manually");
    }
    if (journal.indexIdentity === null || journal.newIndex === null) throw new Error("The saved pull index is incomplete");
    const refreshed = rpc(Op.PrivateRead, privateName(journal, "index"), Buffer.from(journal.indexIdentity, "hex"));
    if (digest(refreshed) !== journal.newIndex) throw new Error("The saved pull index does not match its journal");
    applyPullWorktree(journal);
    if (currentIndex === journal.oldIndex) {
      rpc(Op.LockWrite, "", refreshed);
      if (digest(maybeRpc(Op.IndexRead)) !== journal.oldIndex) throw new Error("The Git index changed during pull recovery");
    }
    if (head === journal.head) await ref.commit();
    if (currentIndex === journal.oldIndex) rpc(Op.LockCommit);
    else rpc(Op.LockAbort);
    // The lock proof remains durable until the child has exited.
  } finally {
    await ref.abort();
  }
  await releaseRecordedRefLocks(journal);
  journal.phase = "committed";
  save(journal);
  cleanupPull(journal);
  return { message: "An interrupted pull was safely completed; review the recovered repository.", committed: true };
}
async function recover(request: Request): Promise<{ message: string | null; committed: boolean }> {
  const journal = loadJournal(request);
  const staged = loadJournal(request, Op.StateTempRead);
  const deleting = loadJournal(request, Op.StateDeleteRead);
  if (deleting) {
    if (journal || staged) throw new Error("Conflicting Git transaction journals require manual recovery");
    // The deletion quarantine is created only after index/ref cleanup.
    rpc(Op.StateDeleteFinish);
    return { message: "Interrupted Git journal deletion was safely recovered.", committed: deleting.phase === "committed" };
  }
  if (staged) {
    if (journal && (staged.id !== journal.id || staged.mode !== journal.mode || staged.branch !== journal.branch || staged.head !== journal.head ||
        staged.newOid !== journal.newOid || staged.oldIndex !== journal.oldIndex)) {
      throw new Error("Conflicting Git transaction journals require manual recovery");
    }
    if (!journal && (staged.phase !== "started" || staged.newIndex !== null || staged.lockId !== null ||
        staged.lock !== null || staged.backupIdentity !== null || staged.indexIdentity !== null ||
        (staged.mode === "pull" && (!staged.pull || staged.pull.stage !== null || staged.pull.removals.length !== 0 || staged.pull.additions.length !== 0)))) {
      throw new Error("An incomplete Git transaction journal requires manual recovery");
    }
    rpc(Op.StateTempDelete);
    if (!journal) return { message: "Interrupted Git journal staging was safely recovered.", committed: false };
  }
  if (!journal) return { message: null, committed: false };
  await releaseRecordedRefLocks(journal);
  if (journal.mode === "pull") return recoverPull(journal);
  if (journal.phase === "committed" || journal.phase === "started") {
    if (tryAdopt(journal) !== null) rpc(Op.LockAbort);
    cleanup(journal);
    return journal.phase === "committed"
      ? { message: "A completed Git transaction was recovered.", committed: true }
      : { message: "An interrupted Git transaction was cancelled before the index was installed.", committed: false };
  }

  const head = await currentHead(journal);
  let lock = tryAdopt(journal);
  if (lock === 2) {
    // The rename completed, but the private hardlink survived the crash.
    // Remove only the alias before reading the now singly-linked index.
    rpc(Op.LockAbort);
    lock = null;
  }
  if (head === journal.newOid) {
    if (lock !== null) rpc(Op.LockAbort);
    cleanup(journal);
    return { message: "A completed Git transaction was recovered; the current index was left unchanged.", committed: true };
  }
  // No restoration is necessary when the live index still equals the
  // pre-transaction index, even if another process advanced the branch.
  if (digest(maybeRpc(Op.IndexRead)) === journal.oldIndex) {
    if (lock !== null) rpc(Op.LockAbort);
    cleanup(journal);
    return { message: "An interrupted Git transaction was cancelled; the current index was left unchanged.", committed: false };
  }
  if (head !== journal.head) {
    if (lock !== null) rpc(Op.LockAbort);
    throw new Error("The interrupted Git transaction conflicts with the current branch; preserve the journal and review the repository");
  }
  if (lock === null) acquire(journal);
  else if (lock === 0) rpc(Op.LockAcquire);
  await requireFilesRefBackend();

  const transaction = new RefTransaction();
  try {
    await prepareBoundRef(journal, transaction, `verify HEAD ${journal.head ?? "0".repeat(journal.newOid.length)}`, false);
    const fingerprint = digest(maybeRpc(Op.IndexRead));
    if (fingerprint === journal.oldIndex) {
      rpc(Op.LockAbort);
    } else if (fingerprint === journal.newIndex) {
      if (journal.oldIndex === null) {
        rpc(Op.LockRemoveIndex);
        rpc(Op.LockAbort);
      } else {
        if (journal.backupIdentity === null) throw new Error("The saved Git index has no recorded identity");
        const backup = rpc(Op.PrivateRead, privateName(journal, "backup"), Buffer.from(journal.backupIdentity, "hex"));
        if (digest(backup) !== journal.oldIndex) throw new Error("The saved Git index does not match its journal; manual recovery is required");
        rpc(Op.LockWrite, "", backup);
        // The bridge compares this snapshot again before rename.
        if (digest(maybeRpc(Op.IndexRead)) !== fingerprint) throw new Error("The Git index changed during recovery");
        rpc(Op.LockCommit);
      }
    } else {
      throw new Error("The Git index changed after the interruption; it was not overwritten");
    }
  } catch (error) {
    try { rpc(Op.LockAbort); } catch { /* Preserve the journal and report the original failure. */ }
    throw error;
  } finally {
    await transaction.abort();
  }
  await releaseRecordedRefLocks(journal);
  cleanup(journal);
  return { message: "An interrupted Git transaction was rolled back; review the recovered index before retrying.", committed: false };
}

async function commit(request: Request): Promise<null> {
  validateCommit(request);
  await requireTransactionSupport();
  await requireFilesRefBackend();
  if (loadJournal(request) || loadJournal(request, Op.StateTempRead) || loadJournal(request, Op.StateDeleteRead)) {
    throw new Error("Recover the pending Git transaction before committing");
  }
  const { preview, entries, newOid } = request;
  const journal: Journal = {
    version: 1, id: randomBytes(16).toString("hex"), approvedIdentity: request.approvedIdentity,
    binding: request.binding, branch: preview.branch, head: preview.head, newOid,
    oldIndex: preview.indexFingerprint, newIndex: null, backupIdentity: null, indexIdentity: null,
    phase: "started", lockId: null, lock: null, refLock: null,
  };
  save(journal);
  let ref: RefTransaction | undefined;
  let committed = false;
  try {
    acquire(journal);
    const original = maybeRpc(Op.IndexRead);
    if (digest(original) !== journal.oldIndex) throw new Error("The Git index changed since preview; review it again");
    if (original !== null) {
      journal.backupIdentity = identityHex(rpc(Op.PrivatePut, privateName(journal, "backup"), original));
      save(journal);
    }
    const indexName = privateName(journal, "index");
    journal.indexIdentity = identityHex(rpc(Op.PrivatePut, indexName, original ?? emptyIndex(newOid.length)));
    save(journal);
    await updatePrivateIndex(journal, entries, newOid.length, indexName);
    if (journal.indexIdentity === null) throw new Error("The private Git index has no recorded identity");
    const refreshed = rpc(Op.PrivateRead, indexName, Buffer.from(journal.indexIdentity, "hex"));
    journal.newIndex = digest(refreshed);
    journal.phase = "prepared";
    save(journal);
    ref = new RefTransaction();
    // Git's files backend rejects a simultaneous explicit symref-verify HEAD
    // and branch update because it synthesizes a HEAD reflog update. A single
    // dereferencing HEAD update locks both refs during prepare; inspecting HEAD
    // while those locks are held verifies the exact approved branch instead.
    await prepareBoundRef(journal, ref, `update HEAD ${newOid} ${preview.head ?? "0".repeat(newOid.length)}`, true);
    if (digest(maybeRpc(Op.IndexRead)) !== journal.oldIndex) throw new Error("The Git index changed since preview; review it again");
    rpc(Op.LockWrite, "", refreshed);
    if (digest(maybeRpc(Op.IndexRead)) !== journal.oldIndex) throw new Error("The Git index changed before installation");
    rpc(Op.LockCommit);
    await ref.commit();
    committed = true;
    await releaseRecordedRefLocks(journal);
    journal.phase = "committed";
    save(journal);
    cleanup(journal);
    return null;
  } catch (error) {
    if (ref) await ref.abort();
    if (committed) throw new Error(`Git committed, but transaction cleanup requires recovery: ${error instanceof Error ? error.message : String(error)}`);
    try { if ((await recover(request)).committed) return null; }
    catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `Git transaction failed and requires recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
    throw error;
  }
}
async function pull(request: Request): Promise<null> {
  const preview = request.pullPreview;
  if (!preview || !equalBinding(preview.binding, request.binding) ||
      typeof preview.branch !== "string" || !preview.branch || /[\s\0]/.test(preview.branch) ||
      !validOid(preview.head) || !validOid(preview.target) || preview.head.length !== preview.target.length) {
    throw new Error("Invalid approved Git pull transaction");
  }
  await requireTransactionSupport();
  await requireFilesRefBackend();
  await disableFilters();
  if (loadJournal(request) || loadJournal(request, Op.StateTempRead) || loadJournal(request, Op.StateDeleteRead)) {
    throw new Error("Recover the pending Git transaction before pulling");
  }
  const journal: Journal = {
    version: 1, mode: "pull", id: randomBytes(16).toString("hex"), approvedIdentity: request.approvedIdentity,
    binding: request.binding, branch: preview.branch, head: preview.head, newOid: preview.target,
    oldIndex: digest(maybeRpc(Op.IndexRead)), newIndex: null, backupIdentity: null, indexIdentity: null,
    phase: "started", lockId: null, lock: null, refLock: null, pull: { stage: null, removals: [], additions: [] },
  };
  save(journal);
  let ref: RefTransaction | undefined;
  try {
    acquire(journal);
    const original = maybeRpc(Op.IndexRead);
    if (digest(original) !== journal.oldIndex) throw new Error("The Git index changed during pull preparation");
    ref = new RefTransaction();
    await prepareBoundRef(journal, ref, preview.head === preview.target
      ? `verify HEAD ${preview.head}`
      : `update HEAD ${preview.target} ${preview.head}`, preview.head !== preview.target);
    if (preview.head === preview.target) {
      await ref.abort();
      await releaseRecordedRefLocks(journal);
      rpc(Op.LockAbort);
      cleanup(journal);
      return null;
    }
    const ancestor = await runGit(["merge-base", "--is-ancestor", preview.head, preview.target]);
    if (ancestor.code !== 0) throw new Error(ancestor.stderr.trim() || "Pull is not a fast-forward");
    if (original !== null) {
      journal.backupIdentity = identityHex(rpc(Op.PrivatePut, privateName(journal, "backup"), original));
      save(journal);
    }
    const indexName = privateName(journal, "index");
    journal.indexIdentity = identityHex(rpc(Op.PrivatePut, indexName, original ?? emptyIndex(preview.target.length)));
    save(journal);
    const plan = await planPull(preview, indexName);
    journal.pull!.removals = plan.removals;
    save(journal);
    // planPull checks the worktree and the bridge rechecks it before moves.
    // Merge the private index without Git's potentially stale worktree stat check.
    await rewritePrivateIndex(journal, indexName, ["read-tree", "-i", "-m", "--no-sparse-checkout", preview.head, preview.target]);
    if (journal.indexIdentity === null) throw new Error("The private Git index has no recorded identity");
    const refreshed = rpc(Op.PrivateRead, indexName, Buffer.from(journal.indexIdentity, "hex"));
    journal.newIndex = digest(refreshed);
    save(journal);

    journal.pull!.stage = identityHex(rpc(Op.StageCreate, journal.id));
    save(journal);
    const add = (file: string, kind: NodeKind, content: Buffer): void => {
      const node: WorktreeNode = {
        path: file, slot: `n${journal.pull!.additions.length.toString(36)}`,
        kind, identity: null, fingerprint: "0".repeat(64),
      };
      journal.pull!.additions.push(node);
      save(journal);
      const staged = snapshotReply(rpc(Op.StagePut, `${journal.id}/${node.slot}`, Buffer.concat([
        Buffer.from(journal.pull!.stage!, "hex"), Buffer.from([kind]), content,
      ])));
      if (staged.kind !== kind || !staged.content.equals(content)) {
        throw new Error(`A staged pull object does not match ${JSON.stringify(file)}`);
      }
      node.identity = staged.identity;
      node.fingerprint = staged.fingerprint;
      save(journal);
    };
    for (const directory of plan.directories) add(directory, 4, Buffer.alloc(0));
    for (const [file, entry] of plan.incoming) {
      add(file, kindForMode(entry.mode), await blobContent(entry, file, indexName, preview.target));
    }
    journal.phase = "prepared";
    save(journal);
    if (digest(maybeRpc(Op.IndexRead)) !== journal.oldIndex) throw new Error("The Git index changed during pull preparation");
    rpc(Op.LockWrite, "", refreshed);
    applyPullWorktree(journal);
    if (digest(maybeRpc(Op.IndexRead)) !== journal.oldIndex) throw new Error("The Git index changed before the pull completed");
    // Keep the real index lock until after HEAD is advanced. If interrupted
    // between these operations, recovery finishes the proven staged index.
    await ref.commit();
    await releaseRecordedRefLocks(journal);
    rpc(Op.LockCommit);
    journal.phase = "committed";
    save(journal);
    cleanupPull(journal);
    return null;
  } catch (error) {
    if (ref) await ref.abort();
    try { if ((await recover(request)).committed) return null; }
    catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `Pull transaction failed and requires recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  if (!git || !git.startsWith("/")) throw new Error("A trusted absolute Git executable is required");
  const request = JSON.parse(readFileSync(0, "utf8")) as Request;
  let result: unknown;
  switch (request.action) {
    case "fingerprint": result = digest(maybeRpc(Op.IndexRead)); break;
    case "recover": result = (await recover(request)).message; break;
    case "commit": result = await commit(request); break;
    case "pull": result = await pull(request); break;
    default: throw new Error("Invalid Git transaction operation");
  }
  process.stdout.write(JSON.stringify(result));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
