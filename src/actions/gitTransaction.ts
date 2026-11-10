import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { assertApprovedSkillsRoot, type ApprovedSkillsRoot } from "./boundary.js";
import { selectGitExecutable, validateGitBinding, type ValidatedGitOptions } from "./gitBoundary.js";
import type { CommitPreview, GitBinding, PullPreview } from "./git.js";

export interface TransactionEntry { path: string; mode: string | null; oid: string | null }
interface Proof { identity: string; hash: string; kind: "file" | "link" | "directory"; executable: boolean }
interface Node extends Proof { path: string; slot: string }
interface RefProof { path: string; proof: Proof }
interface Journal {
  version: 2;
  id: string;
  approvedIdentity: string;
  binding: GitBinding;
  mode: "commit" | "pull";
  branch: string | null;
  head: string | null;
  target: string;
  phase: "started" | "prepared" | "committed";
  oldIndex: string | null;
  newIndex: string | null;
  backup: Proof | null;
  prepared: Proof | null;
  lock: Proof | null;
  ref: { pid: number; locks: RefProof[] | null } | null;
  stage: Proof | null;
  removals: Node[];
  additions: Node[];
}
const config = ["--literal-pathspecs", "--no-lazy-fetch", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.sharedRepository=0", "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "-c", "protocol.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const oid = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function validPath(value: unknown): value is string {
  return typeof value === "string" && !!value && !value.includes("\0") && value.split("/").every((part) => part && part !== "." && part !== ".." && ![".git", ".skills-manager"].includes(part.toLowerCase()));
}
function syncDirectory(directory: string): void { const fd = openSync(directory, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function missing(error: unknown): boolean { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }
function proof(file: string): Proof | null {
  let value;
  try { value = lstatSync(file, { bigint: true }); } catch (error) { if (missing(error)) return null; throw error; }
  const kind = value.isFile() ? "file" : value.isSymbolicLink() ? "link" : value.isDirectory() ? "directory" : null;
  if (!kind || (kind === "file" && value.nlink !== 1n)) throw new Error("Git transaction refuses hardlinks and special files");
  const bytes = kind === "file" ? readFileSync(file) : kind === "link" ? readlinkSync(file, { encoding: "buffer" }) : Buffer.alloc(0);
  return { identity: `${value.dev}:${value.ino}`, hash: hash(bytes), kind, executable: kind === "file" && (value.mode & 0o111n) !== 0n };
}
function same(a: Proof | null, b: Proof | null): boolean {
  return a === null || b === null ? a === b : a.identity === b.identity && a.hash === b.hash && a.kind === b.kind && a.executable === b.executable;
}
function requireProof(file: string, expected: Proof): void { if (!same(proof(file), expected)) throw new Error(`Git transaction data changed: ${path.basename(file)}; preserve it for manual recovery`); }
function writeExclusive(file: string, bytes: Buffer): Proof {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(path.dirname(file));
  return proof(file)!;
}
function removeProven(file: string, expected: Proof): void {
  const current = proof(file); if (!current) return;
  requireProof(file, expected);
  if (current.kind === "directory") rmdirSync(file); else unlinkSync(file);
  syncDirectory(path.dirname(file));
}
function normalizedBinding(binding: GitBinding): string { return JSON.stringify(binding); }
function validProof(value: unknown): value is Proof {
  const p = value as Proof | null;
  return !!p && typeof p.identity === "string" && /^\d+:\d+$/.test(p.identity) && typeof p.hash === "string" && /^[a-f0-9]{64}$/.test(p.hash) && ["file", "link", "directory"].includes(p.kind) && typeof p.executable === "boolean";
}

class RefTransaction {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: AsyncIterator<string>;
  private readonly done: Promise<number>;
  private stderr = "";
  private finished = false;
  constructor(context: Transaction) {
    this.child = context.process(["update-ref", "--stdin"]);
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.stdin.on("error", () => undefined);
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    this.done = once(this.child, "close").then(([code]) => typeof code === "number" ? code : 1);
    void this.done.catch(() => undefined);
  }
  async response(expected: string): Promise<void> {
    const line = await this.lines.next();
    if (line.done || line.value !== `${expected}: ok`) throw new Error(this.stderr.trim() || `Git could not ${expected} the reference transaction`);
  }
  async prepare(command: string): Promise<void> {
    this.child.stdin.write(`start\n${command}\nprepare\n`);
    await this.response("start"); await this.response("prepare");
  }
  async commit(): Promise<void> {
    this.child.stdin.end("commit\n"); await this.response("commit");
    if (await this.done !== 0) throw new Error(this.stderr.trim() || "Git reference transaction failed");
    this.finished = true;
  }
  async abort(): Promise<void> {
    if (this.finished) return;
    this.child.stdin.end("abort\n"); await this.done.catch(() => 1); this.finished = true;
  }
}

class Transaction {
  private constructor(readonly approved: ApprovedSkillsRoot, readonly binding: GitBinding, readonly git: string, readonly env: NodeJS.ProcessEnv) {}
  static async open(approved: ApprovedSkillsRoot, binding: GitBinding): Promise<Transaction> {
    await assertApprovedSkillsRoot(approved);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())));
    Object.assign(env, { LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" });
    const options: ValidatedGitOptions = { env, expectedRoot: { ...binding.root, identity: approved.identity }, repositoryRoot: binding.repositoryRoot, expectedRepositoryRoot: binding.repositoryIdentity, gitDir: binding.gitDir, expectedGitDir: binding.gitDirIdentity, expectedGitEntry: binding.gitEntry, commonDir: binding.commonDir, expectedCommonDir: binding.commonDirIdentity };
    await validateGitBinding(approved.path, options);
    if (path.relative(binding.repositoryRoot, approved.path).split(path.sep).join("/") !== binding.prefix) throw new Error("The reviewed Git repository prefix changed");
    const selected = await selectGitExecutable(env, [approved.path, binding.repositoryRoot, binding.gitDir, binding.commonDir]);
    return new Transaction(approved, binding, selected.git, { ...env, PATH: selected.executablePath, GIT_DIR: binding.gitDir, GIT_COMMON_DIR: binding.commonDir, GIT_WORK_TREE: binding.repositoryRoot });
  }
  private filters: string[] = [];
  process(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    return spawn(this.git, [...config, ...this.filters, ...args], { cwd: this.binding.repositoryRoot, env: { ...this.env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
  }
  async run(args: string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    const child = this.process(args, extra); const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => stdout.push(data)); child.stderr.on("data", (data: Buffer) => stderr.push(data));
    child.stdin.on("error", () => undefined);
    const done = once(child, "close"); child.stdin.end(input); const [code] = await done;
    if (code !== 0) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `Git ${args[0]} failed`);
    return Buffer.concat(stdout);
  }
  text(bytes: Buffer): string { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  async support(): Promise<void> {
    const version = this.text(await this.run(["--version"])); const match = /^git version (\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 48)) throw new Error("Safe Git transactions require Git 2.48 or newer");
    if (this.text(await this.run(["rev-parse", "--show-ref-format"])).trim() !== "files") throw new Error("Recoverable Git transactions require the files reference backend");
    // Listing all config also succeeds when no filters are defined.
    const keys = this.text(await this.run(["config", "--null", "--name-only", "--list"])).split("\0");
    for (const key of keys) {
      const match = /^filter\.(.*)\.(?:clean|smudge|process|required)$/.exec(key);
      if (match) for (const suffix of ["clean=", "smudge=", "process=", "required=false"]) this.filters.push("-c", `filter.${match[1]}.${suffix}`);
    }
  }
  get state(): string { return path.join(this.approved.path, ".skills-manager"); }
  get journalPath(): string { return path.join(this.state, "git-transaction.json"); }
  get index(): string { return path.join(this.binding.gitDir, "index"); }
  get lock(): string { return `${this.index}.lock`; }
  privateFile(journal: Journal, suffix: string): string { return path.join(this.binding.gitDir, `.skill-manager-txn-${journal.id}.${suffix}`); }
  stagePath(journal: Journal): string { return path.join(this.state, `git-stage-${journal.id}`); }
  slot(journal: Journal, node: Node): string { return path.join(this.stagePath(journal), node.slot); }
  rootPath(file: string): string {
    if (!validPath(file)) throw new Error("Invalid selected Git path");
    const parts = file.split("/"); let current = this.approved.path;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part); const value = proof(current);
      if (!value) break;
      if (value.kind !== "directory") throw new Error("Git path has a symlink or non-directory ancestor");
    }
    return path.join(this.approved.path, ...parts);
  }
  rootSnapshot(file: string): Proof | null {
    if (!validPath(file)) throw new Error("Invalid selected Git path");
    const parts = file.split("/");
    let current = this.approved.path;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const p = proof(current);
      if (!p || p.kind !== "directory") return null;
    }
    return proof(path.join(this.approved.path, ...parts));
  }
  repoPath(file: string): string { if (!validPath(file)) throw new Error("Invalid Git path"); return this.binding.prefix ? `${this.binding.prefix}/${file}` : file; }
  selectedPath(file: string): string {
    const prefix = this.binding.prefix ? `${this.binding.prefix}/` : "";
    if (!file.startsWith(prefix) || !validPath(file.slice(prefix.length))) throw new Error("Incoming Git change is outside the selected skills directory");
    return file.slice(prefix.length);
  }
  fingerprint(): string | null { const value = proof(this.index); if (!value) return null; if (value.kind !== "file") throw new Error("Unsafe Git index"); return value.hash; }
  save(journal: Journal): void {
    const next = `${this.journalPath}.next`;
    writeExclusive(next, Buffer.from(JSON.stringify(journal)));
    const current = proof(this.journalPath);
    if (current && current.kind !== "file") throw new Error("Unsafe Git journal");
    renameSync(next, this.journalPath); syncDirectory(this.state);
  }
  load(): Journal | null {
    for (const name of ["transaction.journal", "git-transaction-journal", "git-transaction-journal.next", "git-transaction-journal.delete", "git-transaction.json.next"]) {
      if (proof(path.join(this.state, name))) throw new Error("A legacy or incomplete Git transaction journal requires manual recovery; preserve all transaction files");
    }
    const p = proof(this.journalPath); if (!p) return null;
    if (p.kind !== "file") throw new Error("Unsafe Git transaction journal");
    let j: Journal;
    try { j = JSON.parse(readFileSync(this.journalPath, "utf8")) as Journal; } catch { throw new Error("Malformed Git transaction journal; preserve it for manual recovery"); }
    const validNode = (n: Node): boolean => validProof(n) && validPath(n.path) && /^[on][0-9]+$/.test(n.slot);
    if (!j || j.version !== 2 || !/^[a-f0-9]{32}$/.test(j.id) || j.approvedIdentity !== this.approved.identity || normalizedBinding(j.binding) !== normalizedBinding(this.binding) || !["commit", "pull"].includes(j.mode) || !["started", "prepared", "committed"].includes(j.phase) || !(j.branch === null || (typeof j.branch === "string" && !!j.branch && !/[\s\0]/.test(j.branch))) || !(j.head === null || oid(j.head)) || !oid(j.target) || ![j.oldIndex, j.newIndex].every((h) => h === null || (typeof h === "string" && /^[a-f0-9]{64}$/.test(h))) || ![j.backup, j.prepared, j.lock, j.stage].every((p) => p === null || validProof(p)) || !Array.isArray(j.removals) || !Array.isArray(j.additions) || ![...j.removals, ...j.additions].every(validNode) || new Set([...j.removals, ...j.additions].map((n) => n.slot)).size !== j.removals.length + j.additions.length || !(j.ref === null || (j.ref && Number.isSafeInteger(j.ref.pid) && j.ref.pid > 0 && (j.ref.locks === null || (Array.isArray(j.ref.locks) && j.ref.locks.every((r) => typeof r.path === "string" && validProof(r.proof))))))) throw new Error("The pending Git journal is invalid or does not match the approved repository; preserve it for manual recovery");
    if ((j.phase !== "started" && (!j.prepared || j.prepared.kind !== "file" || j.newIndex !== j.prepared.hash || (j.oldIndex !== null && !j.backup))) ||
        (j.backup !== null && (j.backup.kind !== "file" || j.backup.hash !== j.oldIndex)) ||
        (j.lock !== null && j.lock.kind !== "file") || (j.stage !== null && j.stage.kind !== "directory") ||
        (j.mode === "commit" && (j.stage !== null || j.removals.length > 0 || j.additions.length > 0)) ||
        (j.mode === "pull" && (j.head === null || j.branch === null || (j.phase !== "started" && j.stage === null))) ||
        [j.removals, j.additions].some((nodes) => new Set(nodes.map((node) => node.path)).size !== nodes.length)) {
      throw new Error("The pending Git journal has incomplete or conflicting recovery evidence; preserve it");
    }
    const allowed = this.refPaths(j);
    if (j.ref?.locks?.some((r) => !allowed.includes(r.path))) throw new Error("Invalid Git reference lock path in journal");
    return j;
  }
  refPaths(j: Journal): string[] {
    if (j.branch !== null && (!validPath(j.branch) || j.branch.startsWith("-"))) throw new Error("Invalid reviewed Git branch");
    return [path.join(this.binding.gitDir, "HEAD.lock"), ...(j.branch === null ? [] : [path.join(this.binding.commonDir, "refs", "heads", `${j.branch}.lock`)])];
  }
  headMatches(j: Journal): boolean {
    const text = readFileSync(path.join(this.binding.gitDir, "HEAD"), "utf8");
    return j.branch === null ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/.test(text) : text === `ref: refs/heads/${j.branch}\n`;
  }
  async head(j: Journal): Promise<string | null | undefined> {
    if (!this.headMatches(j)) return undefined;
    try { return this.text(await this.run(["rev-parse", "--verify", "HEAD^{commit}"])).trim(); }
    catch { if (j.head === null) return null; throw new Error("Cannot inspect Git transaction HEAD"); }
  }
  async prepare(j: Journal, ref: RefTransaction, command: string): Promise<void> {
    if (!ref.child.pid) throw new Error("Git reference transaction did not start");
    j.ref = { pid: ref.child.pid, locks: null }; this.save(j);
    await ref.prepare(command);
    if (!this.headMatches(j)) throw new Error("The Git branch changed since preview");
    j.ref.locks = this.refPaths(j).flatMap((file) => { const p = proof(file); return p ? [{ path: file, proof: p }] : []; });
    if (!j.ref.locks.length) throw new Error("Cannot establish ownership of Git reference locks");
    this.save(j);
  }
  releaseRef(j: Journal, childExited = false): void {
    if (!j.ref) return;
    if (!childExited) {
      try { process.kill(j.ref.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; childExited = true; }
      if (!childExited) throw new Error("The prior Git reference transaction may still be running; retry recovery after it exits");
    }
    for (const file of this.refPaths(j)) {
      const current = proof(file); if (!current) continue;
      const recorded = j.ref.locks?.find((r) => r.path === file);
      if (!recorded) throw new Error("A Git reference lock has no durable ownership proof; preserve it");
      removeProven(file, recorded.proof);
    }
    j.ref = null; this.save(j);
  }
  acquire(j: Journal): void {
    if (proof(this.lock)) throw new Error("Git index.lock already exists; preserve the foreign lock");
    // O_EXCL never replaces another Git writer's lock. If interrupted before
    // the inode proof is saved, recovery conservatively retains the lock.
    j.lock = writeExclusive(this.lock, Buffer.alloc(0));
    this.save(j);
  }
  checkLock(j: Journal): void {
    if (!j.lock) throw new Error("Git index lock has no ownership proof");
    const current = proof(this.lock);
    if (!same(current, j.lock) || current?.kind !== "file") throw new Error("The Git index lock changed; preserve it for review");
  }
  writeLock(j: Journal, bytes: Buffer): void {
    this.checkLock(j); const fd = openSync(this.lock, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    j.lock = proof(this.lock); this.save(j);
  }
  install(j: Journal): void { this.checkLock(j); renameSync(this.lock, this.index); syncDirectory(this.binding.gitDir); }
  abortLock(j: Journal): void {
    for (const file of [this.lock, this.privateFile(j, "lock")]) {
      const current = proof(file); if (!current) continue;
      if (!j.lock || !same(current, j.lock) || current.kind !== "file") throw new Error("A foreign Git index lock requires manual recovery");
      removeProven(file, current);
    }
  }
  cleanup(j: Journal): void {
    this.abortLock(j);
    for (const [suffix, p] of [["backup", j.backup], ["index", j.prepared]] as const) {
      const file = this.privateFile(j, suffix);
      if (proof(`${file}.lock`)) throw new Error("A private Git index lock requires manual recovery");
      if (p) removeProven(file, p); else if (proof(file)) throw new Error("A private Git index has no durable cleanup proof");
    }
    if (j.stage) {
      requireProof(this.stagePath(j), j.stage);
      for (const node of [...j.removals, ...j.additions]) {
        const file = this.slot(j, node); if (proof(file)) removeProven(file, node);
      }
      removeProven(this.stagePath(j), j.stage);
    } else if (proof(this.stagePath(j))) throw new Error("A pull staging directory has no ownership proof");
    unlinkSync(this.journalPath); syncDirectory(this.state);
  }
  initial(mode: Journal["mode"], branch: string | null, head: string | null, target: string, oldIndex: string | null): Journal {
    return { version: 2, id: randomBytes(16).toString("hex"), approvedIdentity: this.approved.identity, binding: this.binding, mode, branch, head, target, oldIndex, newIndex: null, backup: null, prepared: null, lock: null, ref: null, stage: null, removals: [], additions: [], phase: "started" };
  }
  async prepareIndex(j: Journal, update: (file: string) => Promise<void>): Promise<Buffer> {
    const original = j.oldIndex === null ? null : readFileSync(this.index);
    if (this.fingerprint() !== j.oldIndex) throw new Error("Git index changed since preview");
    if (original) { j.backup = writeExclusive(this.privateFile(j, "backup"), original); this.save(j); }
    const file = this.privateFile(j, "index");
    if (original) { j.prepared = writeExclusive(file, original); this.save(j); }
    else {
      await this.run(["read-tree", "--empty"], undefined, { GIT_INDEX_FILE: file });
      j.prepared = proof(file); this.save(j);
    }
    try { await update(file); }
    finally {
      // Git can replace the private index inode, including before a failed command.
      j.prepared = proof(file); this.save(j);
    }
    j.prepared = proof(file); if (!j.prepared || j.prepared.kind !== "file") throw new Error("Git did not prepare a regular index");
    j.newIndex = j.prepared.hash; this.save(j); return readFileSync(file);
  }
  async recover(): Promise<string | undefined> {
    const j = this.load(); if (!j) return undefined;
    this.releaseRef(j);
    if (j.phase === "started") { this.cleanup(j); return "Interrupted Git preparation was cancelled; review before retrying"; }
    const head = await this.head(j); const index = this.fingerprint();
    if (j.mode === "commit" && index === j.oldIndex && head !== j.target) {
      this.cleanup(j);
      return "Interrupted Git commit cancelled; the current index was left unchanged";
    }
    if (head !== j.head && head !== j.target) throw new Error("The pending Git transaction conflicts with the current branch; preserve it");
    if (index !== j.oldIndex && index !== j.newIndex) throw new Error("The Git index changed after interruption; it was not overwritten");
    if (j.mode === "commit") {
      if (head === j.target) { this.cleanup(j); return "Completed Git commit recovered; current index retained"; }
      if (index === j.newIndex) {
        if (!j.lock || !proof(this.lock)) this.acquire(j);
        if (j.oldIndex === null) { unlinkSync(this.index); syncDirectory(this.binding.gitDir); }
        else { if (!j.backup) throw new Error("Missing saved Git index proof"); requireProof(this.privateFile(j, "backup"), j.backup); this.writeLock(j, readFileSync(this.privateFile(j, "backup"))); this.install(j); }
      }
      this.cleanup(j); return "Interrupted Git commit rolled back; review the recovered index";
    }
    if (j.phase === "committed") { this.cleanup(j); return "Completed Git pull recovered"; }
    if (!j.prepared || !j.newIndex) throw new Error("Missing prepared pull index");
    requireProof(this.privateFile(j, "index"), j.prepared);
    if (!proof(this.lock)) this.acquire(j); else this.checkLock(j);
    const ref = new RefTransaction(this);
    try {
      await this.prepare(j, ref, head === j.target ? `verify HEAD ${j.target}` : `update HEAD ${j.target} ${j.head}`);
      this.applyPull(j); this.writeLock(j, readFileSync(this.privateFile(j, "index")));
      if (head !== j.target) await ref.commit(); else await ref.abort();
      this.releaseRef(j, true); this.install(j); j.phase = "committed"; this.save(j); this.cleanup(j);
      return "Interrupted Git pull completed; review the recovered files";
    } finally { await ref.abort(); }
  }
  async commit(preview: CommitPreview, target: string, entries: TransactionEntry[]): Promise<void> {
    await this.support(); if (this.load()) throw new Error("Recover the pending Git transaction first");
    if (!oid(target) || preview.root !== this.approved.path || normalizedBinding(preview.binding) !== normalizedBinding(this.binding) || entries.length !== preview.paths.length || new Set(entries.map((e) => e.path)).size !== entries.length || entries.some((e) => !preview.paths.includes(e.path) || !validPath(e.path) || (e.mode === null ? e.oid !== null : !["100644", "100755", "120000"].includes(e.mode) || !oid(e.oid)))) throw new Error("Invalid approved Git commit entries");
    const j = this.initial("commit", preview.branch, preview.head, target, preview.indexFingerprint); this.save(j);
    let ref: RefTransaction | undefined;
    try {
      this.acquire(j);
      const bytes = await this.prepareIndex(j, async (file) => {
        const extra = { GIT_INDEX_FILE: file };
        for (const e of entries.filter((e) => e.mode === null)) await this.run(["update-index", "--force-remove", "--", this.repoPath(e.path)], undefined, extra);
        for (const e of entries.filter((e) => e.mode !== null)) await this.run(["update-index", "--add", "--cacheinfo", `${e.mode},${e.oid},${this.repoPath(e.path)}`], undefined, extra);
      });
      j.phase = "prepared"; this.save(j);
      ref = new RefTransaction(this); await this.prepare(j, ref, `update HEAD ${target} ${preview.head ?? "0".repeat(target.length)}`);
      if (this.fingerprint() !== j.oldIndex) throw new Error("Git index changed before installation");
      this.writeLock(j, bytes); this.install(j); await ref.commit(); this.releaseRef(j, true);
      j.phase = "committed"; this.save(j); this.cleanup(j);
    } catch (error) {
      if (ref) { await ref.abort(); this.releaseRef(j, true); }
      try { await this.recover(); } catch (recovery) { throw new AggregateError([error, recovery], "Git transaction failed; preserve pending recovery state"); }
      if (await this.head(j) === j.target) return;
      throw error;
    }
  }
  async tree(revision: string, changed: Set<string>): Promise<Map<string, { mode: string; oid: string }>> {
    const result = new Map<string, { mode: string; oid: string }>();
    for (const record of this.text(await this.run(["ls-tree", "-r", "-z", "--full-tree", revision])).split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t"); const repo = record.slice(tab + 1); if (!changed.has(repo)) continue;
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(record.slice(0, tab));
      if (!match) throw new Error("Incoming Git tree contains an unsupported entry");
      result.set(this.selectedPath(repo), { mode: match[1], oid: match[2] });
    }
    return result;
  }
  async blob(entry: { mode: string; oid: string }, file: string, index: string, revision?: string): Promise<Buffer> {
    return this.run(entry.mode === "120000" ? ["cat-file", "blob", entry.oid] : ["cat-file", "--filters", `--path=${this.repoPath(file)}`, entry.oid], undefined, { GIT_INDEX_FILE: index, ...(revision ? { GIT_ATTR_SOURCE: revision } : {}) });
  }
  applyPull(j: Journal): void {
    if (!j.stage) throw new Error("Pull staging directory has no ownership proof"); requireProof(this.stagePath(j), j.stage);
    // Inspect every destination before moving any data, including recovery attempts.
    for (const node of j.removals) {
      const saved = proof(this.slot(j, node)); const current = this.rootSnapshot(node.path);
      const replacement = j.additions.find((n) => n.path === node.path);
      if (saved ? !same(saved, nodeProof(node)) || (current !== null && (!replacement || !same(current, nodeProof(replacement)))) : !same(current, nodeProof(node))) throw new Error("A pull preimage changed; preserve recovery state");
    }
    for (const node of j.additions) {
      const saved = proof(this.slot(j, node)); const current = this.rootSnapshot(node.path); const old = j.removals.find((n) => n.path === node.path);
      if (saved ? !same(saved, nodeProof(node)) || (current !== null && (!old || !same(current, nodeProof(old)))) : !same(current, nodeProof(node))) throw new Error("A pull destination contains foreign data; preserve it");
    }
    for (const node of j.removals) {
      const destination = this.slot(j, node); if (proof(destination)) continue;
      const source = this.rootPath(node.path); requireProof(source, nodeProof(node));
      if (node.kind === "directory" && readdirSync(source).length) throw new Error("A pull directory contains foreign data");
      renameSync(source, destination); syncDirectory(path.dirname(source)); syncDirectory(this.stagePath(j));
    }
    for (const node of j.additions) {
      const source = this.slot(j, node); if (!proof(source)) continue;
      const destination = this.rootPath(node.path); if (proof(destination)) throw new Error("A pull destination unexpectedly exists");
      renameSync(source, destination); syncDirectory(path.dirname(destination)); syncDirectory(this.stagePath(j));
    }
  }
  async pull(preview: PullPreview): Promise<void> {
    await this.support(); if (this.load()) throw new Error("Recover the pending Git transaction first");
    if (!oid(preview.head) || !oid(preview.target) || preview.root !== this.approved.path || normalizedBinding(preview.binding) !== normalizedBinding(this.binding)) throw new Error("Invalid approved Git pull");
    await this.run(["merge-base", "--is-ancestor", preview.head, preview.target]);
    for (const commit of this.text(await this.run(["rev-list", `${preview.head}..${preview.target}`])).split("\n").filter(Boolean)) {
      for (const file of this.text(await this.run(["diff-tree", "--root", "-m", "-r", "--no-commit-id", "--no-renames", "--no-ext-diff", "--no-textconv", "--name-only", "-z", commit])).split("\0").filter(Boolean)) this.selectedPath(file);
    }
    const changed = new Set(this.text(await this.run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", preview.head, preview.target])).split("\0").filter(Boolean));
    if (JSON.stringify([...changed].map((f) => this.selectedPath(f)).sort()) !== JSON.stringify([...preview.paths].sort())) throw new Error("Incoming pull paths changed since approval");
    if (preview.head === preview.target) return;
    const j = this.initial("pull", preview.branch, preview.head, preview.target, this.fingerprint()); this.save(j);
    let ref: RefTransaction | undefined;
    try {
      this.acquire(j); ref = new RefTransaction(this); await this.prepare(j, ref, `update HEAD ${j.target} ${j.head}`);
      const before = await this.tree(preview.head, changed); const incoming = await this.tree(preview.target, changed);
      const privateIndex = this.privateFile(j, "index");
      const bytes = await this.prepareIndex(j, async (file) => {
        // An index-only two-tree merge refuses conflicting staged changes and
        // preserves unrelated entries without trusting cached worktree stat data.
        await this.run(["read-tree", "-i", "-m", "--no-sparse-checkout", preview.head, preview.target], undefined, { GIT_INDEX_FILE: file });
      });
      mkdirSync(this.stagePath(j), { mode: 0o700 }); syncDirectory(this.state); j.stage = proof(this.stagePath(j)); this.save(j);
      const removed = new Set<string>();
      for (const [file, entry] of before) {
        const current = this.rootSnapshot(file); const content = await this.blob(entry, file, privateIndex);
        if (!current || current.kind !== (entry.mode === "120000" ? "link" : "file") || current.executable !== (entry.mode === "100755") || current.hash !== hash(content)) throw new Error(`Pull would overwrite local changes at ${JSON.stringify(file)}`);
        j.removals.push({ ...current, path: file, slot: `o${j.removals.length}` }); removed.add(file);
      }
      const inspectDirectory = (file: string): void => {
        if (removed.has(file)) return;
        for (const child of readdirSync(this.rootPath(file))) {
          const name = `${file}/${child}`; const current = this.rootSnapshot(name);
          if (current?.kind === "directory") inspectDirectory(name); else if (!removed.has(name)) throw new Error("Pull would overwrite ignored or untracked data");
        }
        const p = this.rootSnapshot(file)!; j.removals.push({ ...p, path: file, slot: `o${j.removals.length}` }); removed.add(file);
      };
      const directories = new Set<string>();
      for (const file of incoming.keys()) {
        const current = this.rootSnapshot(file);
        if (current?.kind === "directory") inspectDirectory(file); else if (current && !removed.has(file)) throw new Error("Pull would overwrite ignored or untracked data");
        const parts = file.split("/");
        for (let count = 1; count < parts.length; count++) {
          const ancestor = parts.slice(0, count).join("/"); const p = this.rootSnapshot(ancestor);
          if (p?.kind === "directory" && !removed.has(ancestor)) continue;
          if (p && !removed.has(ancestor)) throw new Error("A pull destination has an unsafe ancestor");
          directories.add(ancestor);
        }
      }
      j.removals.sort((a, b) => b.path.split("/").length - a.path.split("/").length); this.save(j);
      const add = (file: string, kind: Proof["kind"], content: Buffer, executable = false): void => {
        const slot = `n${j.additions.length}`; const destination = path.join(this.stagePath(j), slot);
        if (kind === "directory") { mkdirSync(destination, { mode: 0o755 }); syncDirectory(this.stagePath(j)); }
        else if (kind === "link") { const target = this.text(content); if (target.includes("\0")) throw new Error("Invalid incoming symlink"); symlinkSync(target, destination); syncDirectory(this.stagePath(j)); }
        else { const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, executable ? 0o755 : 0o644); try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(this.stagePath(j)); }
        j.additions.push({ ...proof(destination)!, path: file, slot }); this.save(j);
      };
      for (const directory of [...directories].sort((a, b) => a.split("/").length - b.split("/").length)) add(directory, "directory", Buffer.alloc(0));
      for (const [file, entry] of incoming) add(file, entry.mode === "120000" ? "link" : "file", await this.blob(entry, file, privateIndex, preview.target), entry.mode === "100755");
      j.phase = "prepared"; this.save(j);
      if (this.fingerprint() !== j.oldIndex) throw new Error("Git index changed during pull");
      this.writeLock(j, bytes); this.applyPull(j); await ref.commit(); this.releaseRef(j, true); this.install(j);
      j.phase = "committed"; this.save(j); this.cleanup(j);
    } catch (error) {
      if (ref) { await ref.abort(); this.releaseRef(j, true); }
      try { await this.recover(); } catch (recovery) { throw new AggregateError([error, recovery], "Pull failed; preserve pending recovery state"); }
      if (await this.head(j) === j.target) return;
      throw error;
    }
  }
}
function nodeProof(node: Node): Proof { return { identity: node.identity, hash: node.hash, kind: node.kind, executable: node.executable }; }

/** Caller holds withSkillsLock for all mutation/recovery entry points. */
export async function indexFingerprint(approved: ApprovedSkillsRoot, binding: GitBinding): Promise<string | null> { return (await Transaction.open(approved, binding)).fingerprint(); }
export async function commitIndexTransaction(approved: ApprovedSkillsRoot, preview: CommitPreview, options: { newOid: string; entries: TransactionEntry[] }): Promise<void> { await (await Transaction.open(approved, preview.binding)).commit(preview, options.newOid, options.entries); }
export async function pullIndexWorktreeTransaction(approved: ApprovedSkillsRoot, preview: PullPreview): Promise<void> { await (await Transaction.open(approved, preview.binding)).pull(preview); }
export async function recoverIndexTransaction(approved: ApprovedSkillsRoot, binding: GitBinding): Promise<string | undefined> { return (await Transaction.open(approved, binding)).recover(); }
