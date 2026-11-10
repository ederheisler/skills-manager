import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ApprovedSkillsRoot { path: string; identity: string }
export interface CliLockSnapshot { path: string; identity: string; parentIdentity: string; content: string }

const marker = "skills-manager-owned-state-v1\n";
const sessions = new AsyncLocalStorage<{ root: ApprovedSkillsRoot; active: boolean; queue: Promise<unknown> }>();
const queues = new Map<string, Promise<unknown>>();
const cliLockLimit = 1024 * 1024;
const noFollow = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const statePath = (root: ApprovedSkillsRoot): string => path.join(root.path, ".skills-manager");
const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const stale = (message = "Reviewed filesystem state changed"): Error => error("ESTALE", message);
const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const inode = (s: BigIntStats): string => `${s.dev}:${s.ino}`;
const directoryToken = (s: BigIntStats): string => hash(`skills-manager-node-root-v1:${inode(s)}`);
const snapshotToken = (s: BigIntStats): string => [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.rdev, s.size, s.mtimeNs, s.ctimeNs].join(":");
const stableDirectory = (s: BigIntStats): string => [s.dev, s.ino, s.mode, s.uid, s.gid].join(":");

function checkedName(name: string): void {
  if (!name || [".", "..", ".git", ".disabled_skills", ".skills-manager"].includes(name.toLowerCase()) ||
      /[\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255) throw new Error("Invalid or reserved skill name");
}
function checkedFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("A valid reviewed fingerprint is required");
}
function checkedRelative(relative: string, empty = false): string[] {
  if (typeof relative !== "string" || relative.includes("\0") || path.isAbsolute(relative)) {
    throw new Error("A safe normalized relative path is required");
  }
  if (relative === "" && empty) return [];
  const parts = relative.split("/");
  if (parts.some((part) => ["", ".", ".."].includes(part))) {
    throw new Error("A safe normalized relative path is required");
  }
  return parts;
}
async function maybeStat(file: string): Promise<BigIntStats | null> {
  try { return await lstat(file, { bigint: true }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
}
async function directory(file: string): Promise<BigIntStats> {
  const entry = await lstat(file, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw error("ENOTDIR", "Directory path contains a link or non-directory");
  return entry;
}
// Node has no descriptor-relative directory API. Check every ancestor and never
// intentionally traverse a child link; hostile concurrent path swaps are out of scope.
async function ancestors(file: string): Promise<BigIntStats[]> {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const result = [await directory(current)];
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    result.push(await directory(current));
  }
  return result;
}
async function safePath(root: string, relative: string, empty = false): Promise<{ file: string; chain: BigIntStats[] }> {
  const parts = checkedRelative(relative, empty);
  const chain = [await directory(root)];
  let current = root;
  for (const component of parts.slice(0, -1)) {
    current = path.join(current, component);
    const entry = await directory(current);
    if (entry.dev !== chain[0]!.dev) throw error("EXDEV", "Path crosses the selected filesystem");
    chain.push(entry);
  }
  return { file: path.join(root, ...parts), chain };
}
function regular(s: BigIntStats): void {
  if (!s.isFile() || s.nlink !== 1n) throw error("EPERM", "Refusing a hard-linked or special file");
}
function owned(s: BigIntStats, dir = false): void {
  if (dir ? !s.isDirectory() : (!s.isFile() || s.nlink !== 1n)) throw error("EPERM", "Unsafe controlled-state entry");
  if ((s.mode & 0o777n) !== (dir ? 0o700n : 0o600n) || (process.getuid && s.uid !== BigInt(process.getuid()))) {
    throw error("EPERM", "Controlled state is not owned by this application");
  }
}
async function assertSnapshot(file: string, before: BigIntStats): Promise<void> {
  const after = await maybeStat(file);
  if (!after || snapshotToken(after) !== snapshotToken(before)) throw stale();
}
async function fileBytes(file: string, before: BigIntStats, limit = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
  regular(before);
  if (before.size > BigInt(limit)) throw error("EFBIG", "File exceeds the supported byte limit");
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    if (snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(before)) throw stale();
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== before.size || snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(before)) throw stale();
    await assertSnapshot(file, before);
    return bytes;
  } finally { await handle.close(); }
}
async function names(file: string): Promise<string[]> {
  const entries = await readdir(file, { encoding: "buffer" });
  entries.sort(Buffer.compare);
  return entries.map((bytes) => {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(value).equals(bytes)) throw new Error("Invalid UTF-8 filename");
    return value;
  });
}
async function syncDirectory(file: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function createFile(file: string, bytes: string | Buffer, mode = 0o600): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode);
  try { await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
async function exclusiveRename(from: string, to: string): Promise<void> {
  if (await maybeStat(to)) throw error("EEXIST", "Destination already exists");
  await rename(from, to);
  await syncDirectory(path.dirname(from));
  if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(to));
}

export async function approveSkillsRoot(canonicalPath: string): Promise<ApprovedSkillsRoot> {
  const root = path.resolve(canonicalPath);
  await ancestors(root);
  return { path: root, identity: directoryToken(await directory(root)) };
}
export async function assertApprovedSkillsRoot(root: ApprovedSkillsRoot): Promise<void> {
  if (!root || !path.isAbsolute(root.path) || path.normalize(root.path) !== root.path || !/^[a-f0-9]{64}$/.test(root.identity)) {
    throw new Error("An approved skills directory identity is required");
  }
  await ancestors(root.path);
  if (directoryToken(await directory(root.path)) !== root.identity) throw stale("Selected directory changed since approval; approve it again");
}
async function checkedRoot(skillsDir: string, expectedRoot?: ApprovedSkillsRoot): Promise<string> {
  const root = path.resolve(skillsDir);
  if (expectedRoot) {
    if (expectedRoot.path !== root) throw new Error("Read root does not match the approved directory");
    await assertApprovedSkillsRoot(expectedRoot);
  } else await ancestors(root);
  return root;
}
async function state(root: ApprovedSkillsRoot, create: boolean): Promise<string | null> {
  if (!create) return inspectState(root, false);
  return withPathLock(`state:${root.path}`, () => inspectState(root, true));
}
async function inspectState(root: ApprovedSkillsRoot, create: boolean): Promise<string | null> {
  await assertApprovedSkillsRoot(root);
  if ((await names(root.path)).some((name) => name.startsWith(".skills-manager-bootstrap-"))) {
    throw stale("Interrupted controlled-state bootstrap needs manual review; preserving all data");
  }
  const target = statePath(root);
  if (!await maybeStat(target)) {
    if (!create) return null;
    // The unpublished directory is never mistaken for owned state after a crash.
    const staging = path.join(root.path, `.skills-manager-bootstrap-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    await chmod(staging, 0o700);
    await createFile(path.join(staging, "owner"), marker);
    await createFile(path.join(staging, "lock"), "");
    await syncDirectory(staging);
    try { await exclusiveRename(staging, target); }
    catch (cause) {
      if (!["EEXIST", "ENOTEMPTY"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
      await unlink(path.join(staging, "owner")); await unlink(path.join(staging, "lock")); await rmdir(staging);
    }
  }
  const s = await directory(target);
  owned(s, true);
  if (s.dev !== (await directory(root.path)).dev) throw error("EXDEV", "Controlled state crosses filesystems");
  const owner = path.join(target, "owner");
  const ownerStat = await lstat(owner, { bigint: true }); owned(ownerStat);
  if ((await fileBytes(owner, ownerStat, 1024)).toString() !== marker) throw error("EPERM", "Reserved .skills-manager location is not owned by this application");
  owned(await lstat(path.join(target, "lock"), { bigint: true }));
  return target;
}
async function withPathLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const temporaryRoot = await realpath(tmpdir());
  const registry = path.join(temporaryRoot, `skills-manager-locks-${process.getuid?.() ?? "user"}`);
  try { await mkdir(registry, { mode: 0o700 }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  owned(await directory(registry), true);
  const release = await acquireLock(registry, `lock-${hash(key)}`);
  try { return await action(); } finally { await release(); }
}
async function acquireLock(target: string, name = "app-lock"): Promise<() => Promise<void>> {
  const lock = path.join(target, name);
  const claim = path.join(target, `${name}-recovery`);
  const bytes = JSON.stringify({ version: 1, pid: process.pid, host: hostname(), nonce: randomUUID() });
  let pendingPublication: { identity: string; deadline: number } | undefined;
  for (;;) {
    if (await maybeStat(claim)) {
      throw error("EBUSY", "Application lock recovery is already in progress; preserve its state and retry");
    }
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
    const lockStat = await maybeStat(lock);
    if (!lockStat) continue;
    owned(lockStat, true);
    const owner = path.join(lock, "owner");
    const existing = await maybeStat(owner);
    if (!existing) {
      const identity = inode(lockStat);
      if (pendingPublication?.identity !== identity) pendingPublication = { identity, deadline: Date.now() + 2000 };
      if (Date.now() >= pendingPublication.deadline) throw error("EBUSY", "Incomplete application lock; preserve it for manual recovery");
      await delay(25);
      continue;
    }
    owned(existing);
    let captured: { version?: number; pid?: number; host?: string; nonce?: string };
    let capturedBytes: Buffer;
    try {
      capturedBytes = await fileBytes(owner, existing, 4096);
      captured = JSON.parse(capturedBytes.toString()) as typeof captured;
    } catch (cause) {
      const currentLock = await maybeStat(lock);
      const currentOwner = await maybeStat(owner);
      if (!currentLock || inode(currentLock) !== inode(lockStat) || !currentOwner ||
          snapshotToken(currentOwner) !== snapshotToken(existing)) continue;
      throw error("EBUSY", `Unrecognized application lock; preserve it for manual recovery: ${String(cause)}`);
    }
    if (captured.version !== 1 || captured.host !== hostname() || !Number.isSafeInteger(captured.pid) || captured.pid! <= 0 ||
        typeof captured.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(captured.nonce)) {
      throw error("EBUSY", "Foreign application lock; preserve it for manual recovery");
    }
    try { process.kill(captured.pid!, 0); await delay(25); continue; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw error("EBUSY", "Cannot establish that the application lock owner exited");
    }
    // All app instances honor this exclusive recovery claim before acquiring a
    // fresh lock. Unknown locks and interrupted claims are never deleted.
    try { await mkdir(claim, { mode: 0o700 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "EEXIST") { await delay(25); continue; } throw cause; }
    try {
      await createFile(path.join(claim, "owner.next"), bytes);
      await rename(path.join(claim, "owner.next"), path.join(claim, "owner"));
      await syncDirectory(claim);
      const current = await maybeStat(lock);
      if (!current || inode(current) !== inode(lockStat)) continue;
      await assertSnapshot(owner, existing);
      if (!(await fileBytes(owner, existing, 4096)).equals(capturedBytes)) throw stale("Lock ownership changed; preserving it");
      try { process.kill(captured.pid!, 0); continue; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
      const abandoned = path.join(claim, "abandoned");
      await rename(lock, abandoned);
      await syncDirectory(target);
      await unlink(path.join(abandoned, "owner"));
      await rmdir(abandoned);
    } finally {
      // A failed reconciliation leaves an abandoned directory and consequently
      // retains the claim instead of discarding any unknown recovery contents.
      if (!await maybeStat(path.join(claim, "abandoned"))) {
        await unlink(path.join(claim, "owner")); await rmdir(claim); await syncDirectory(target);
      }
    }
  }
  const lockIdentity = inode(await directory(lock));
  try {
    // Publish complete owner bytes atomically. Contenders may observe the
    // directory before this rename, but never partially written owner JSON.
    await createFile(path.join(lock, "owner.next"), bytes);
    await rename(path.join(lock, "owner.next"), path.join(lock, "owner"));
    await syncDirectory(lock);
    await syncDirectory(target);
  }
  catch (cause) { throw new Error(`Cannot publish application lock; state retained: ${String(cause)}`); }
  return async () => {
    if (inode(await directory(lock)) !== lockIdentity) throw stale("Application lock changed; preserving it");
    const owner = path.join(lock, "owner");
    const entry = await lstat(owner, { bigint: true }); owned(entry);
    if ((await fileBytes(owner, entry, 4096)).toString() !== bytes) throw stale("Application lock ownership changed; preserving it");
    await unlink(owner); await rmdir(lock); await syncDirectory(target);
  };
}
async function locked<T>(root: ApprovedSkillsRoot, recover: boolean, action: () => Promise<T>): Promise<T> {
  await assertApprovedSkillsRoot(root);
  const current = sessions.getStore();
  if (current?.active && current.root.path === root.path) {
    if (current.root.identity !== root.identity) throw stale("Conflicting approved directory identity");
    return action();
  }
  const previous = queues.get(root.path) ?? Promise.resolve();
  const { promise: queued, resolve: releaseQueue } = Promise.withResolvers<void>();
  const tail = previous.catch(() => undefined).then(() => queued);
  queues.set(root.path, tail);
  await previous.catch(() => undefined);
  try {
    const target = (await state(root, true))!;
    const release = await acquireLock(target);
    const session = { root, active: true, queue: Promise.resolve<unknown>(undefined) };
    try {
      await assertApprovedSkillsRoot(root);
      if (recover) {
        const recovered = await recoverJournal(root, target);
        if (recovered) throw new Error(`${recovered} Review the recovered state and retry the operation.`);
      }
      return await sessions.run(session, action);
    } finally { session.active = false; await release(); }
  } finally {
    releaseQueue();
    if (queues.get(root.path) === tail) queues.delete(root.path);
  }
}
export function withSkillsLock<T>(root: ApprovedSkillsRoot, action: () => Promise<T>): Promise<T> { return locked(root, true, action); }
export async function recoverSkills(root: ApprovedSkillsRoot): Promise<string | undefined> {
  const target = await state(root, false);
  if (!target) return undefined;
  return locked(root, false, () => recoverJournal(root, target));
}
async function mutation<T>(root: ApprovedSkillsRoot, action: () => Promise<T>): Promise<T> {
  return withSkillsLock(root, async () => {
    const session = sessions.getStore()!;
    const run = async (): Promise<T> => {
      if (await hasIndexTransaction(root)) throw error("EBUSY", "A pending Git transaction must be recovered before changing skills");
      return action();
    };
    const result = session.queue.then(run, run);
    session.queue = result.catch(() => undefined);
    return result;
  });
}

function u64(digest: Hash, value: bigint | number): void {
  const bytes = Buffer.allocUnsafe(8); bytes.writeBigUInt64BE(BigInt(value)); digest.update(bytes);
}
async function treeFingerprint(entryPath: string, contentOnly: boolean, staged = false): Promise<string> {
  await ancestors(path.dirname(entryPath));
  const digest = createHash("sha256");
  const root = await lstat(entryPath, { bigint: true });
  let count = 0;
  const walk = async (file: string, depth: number): Promise<void> => {
    if (depth > 512 || ++count > 100000) throw error("E2BIG", "Tree exceeds supported bounds");
    const entry = await lstat(file, { bigint: true });
    if (entry.dev !== root.dev) throw error("EXDEV", "Tree crosses the selected filesystem");
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) throw error("ENOTSUP", "Tree contains a special file");
    if (staged && (entry.isSymbolicLink() || (entry.isFile() && entry.nlink !== 1n) || (depth === 0 && !entry.isDirectory()))) throw error("EPERM", "Staged tree contains a link or is not a directory");
    digest.update(entry.isDirectory() ? "D" : entry.isFile() ? "F" : "L");
    u64(digest, entry.mode & 0o7777n);
    if (!contentOnly) { u64(digest, entry.dev); u64(digest, entry.ino); }
    if (entry.isDirectory()) {
      const children = await names(file); u64(digest, children.length);
      for (const name of children) { u64(digest, Buffer.byteLength(name)); digest.update(name); await walk(path.join(file, name), depth + 1); }
    } else if (entry.isSymbolicLink()) {
      const bytes = await readlink(file, { encoding: "buffer" }); u64(digest, bytes.length); digest.update(bytes);
    } else {
      // Fingerprints may describe an existing hardlink, but mutations refuse it.
      const handle = await open(file, constants.O_RDONLY | noFollow);
      try {
        if (snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(entry)) throw stale();
        u64(digest, entry.size);
        let total = 0n;
        const buffer = Buffer.allocUnsafe(65536);
        for (;;) { const { bytesRead } = await handle.read(buffer); if (!bytesRead) break; total += BigInt(bytesRead); digest.update(buffer.subarray(0, bytesRead)); }
        if (total !== entry.size || snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(entry)) throw stale();
      } finally { await handle.close(); }
    }
    await assertSnapshot(file, entry);
  };
  await walk(entryPath, 0);
  return digest.digest("hex");
}
export function fingerprintTree(entryPath: string): Promise<string> { return treeFingerprint(path.resolve(entryPath), false); }
export function fingerprintContents(entryPath: string): Promise<string> { return treeFingerprint(path.resolve(entryPath), true); }
function reviewedLocation(root: string, name: string, expectedPath: string): "active" | "disabled" {
  const selected = path.resolve(expectedPath);
  if (selected === path.join(root, name)) return "active";
  if (selected === path.join(root, ".disabled_skills", name)) return "disabled";
  throw new Error("The confirmed path is not this skill in the selected directory");
}
async function skillLocations(root: ApprovedSkillsRoot, name: string): Promise<{ active: string; disabled: string }> {
  await assertApprovedSkillsRoot(root); checkedName(name);
  const disabledDir = path.join(root.path, ".disabled_skills");
  if (await maybeStat(disabledDir)) {
    if ((await directory(disabledDir)).dev !== (await directory(root.path)).dev) throw error("EXDEV", "Disabled directory crosses filesystems");
  }
  const active = path.join(root.path, name), disabled = path.join(disabledDir, name);
  if (await maybeStat(active) && await maybeStat(disabled)) throw error("EEXIST", "Skill exists in both active and disabled locations");
  return { active, disabled };
}
async function fingerprintReviewed(root: ApprovedSkillsRoot, name: string, expectedPath: string, contentOnly: boolean): Promise<string> {
  const location = reviewedLocation(root.path, name, expectedPath);
  const locations = await skillLocations(root, name);
  return treeFingerprint(locations[location], contentOnly);
}
export function fingerprintSkill(root: ApprovedSkillsRoot, name: string, expectedPath: string): Promise<string> { return fingerprintReviewed(root, name, expectedPath, false); }
export function fingerprintSkillContents(root: ApprovedSkillsRoot, name: string, expectedPath: string): Promise<string> { return fingerprintReviewed(root, name, expectedPath, true); }

export async function readSkillPath(skillsDir: string, relativePath: string, options: { maxBytes?: number; expectedRoot?: ApprovedSkillsRoot } = {}): Promise<{
  kind: "file" | "symlink"; mode: number; content: Buffer; identity: string; stableIdentity: string; size: number; truncated: boolean;
}> {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) throw new Error("Invalid read byte limit");
  const root = await checkedRoot(skillsDir, options.expectedRoot);
  const { file, chain } = await safePath(root, relativePath);
  const entry = await lstat(file, { bigint: true });
  if (entry.dev !== chain[0]!.dev) throw error("EXDEV", "Path crosses the selected filesystem");
  if (!entry.isFile() && !entry.isSymbolicLink()) throw error("EINVAL", "Only files and link text can be read");
  const leafHash = createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  let retained = 0;
  const consume = (bytes: Buffer): void => {
    leafHash.update(bytes); size += bytes.length;
    const take = Math.min(bytes.length, limit - retained);
    if (take > 0) { chunks.push(Buffer.from(bytes.subarray(0, take))); retained += take; }
  };
  if (entry.isSymbolicLink()) consume(await readlink(file, { encoding: "buffer" }));
  else {
    regular(entry);
    const handle = await open(file, constants.O_RDONLY | noFollow);
    try {
      if (snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(entry)) throw stale();
      const buffer = Buffer.allocUnsafe(65536);
      for (;;) { const { bytesRead } = await handle.read(buffer); if (!bytesRead) break; consume(buffer.subarray(0, bytesRead)); }
      if (BigInt(size) !== entry.size || snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(entry)) throw stale();
    } finally { await handle.close(); }
  }
  await assertSnapshot(file, entry);
  const after = await safePath(root, relativePath);
  if (chain.map(snapshotToken).join("/") !== after.chain.map(snapshotToken).join("/")) throw stale();
  if (options.expectedRoot) await assertApprovedSkillsRoot(options.expectedRoot);
  const leaf = `${snapshotToken(entry)}:${leafHash.digest("hex")}`;
  return { kind: entry.isFile() ? "file" : "symlink", mode: Number(entry.mode & 0o7777n), content: Buffer.concat(chunks),
    identity: hash(`${chain.map(snapshotToken).join("/")}:${relativePath}:${leaf}`),
    stableIdentity: hash(`${chain.map(stableDirectory).join("/")}:${relativePath}:${leaf}`), size, truncated: retained < size };
}
export async function countSkillPathLines(skillsDir: string, relativePath: string, expectedRoot?: ApprovedSkillsRoot): Promise<number> {
  const root = await checkedRoot(skillsDir, expectedRoot);
  const { file, chain } = await safePath(root, relativePath);
  const entry = await lstat(file, { bigint: true }); regular(entry);
  if (entry.dev !== chain[0]!.dev) throw error("EXDEV", "Path crosses the selected filesystem");
  const handle = await open(file, constants.O_RDONLY | noFollow);
  let lines = 0, total = 0n, last = -1;
  try {
    if (snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(entry)) throw stale();
    const buffer = Buffer.allocUnsafe(65536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer); if (!bytesRead) break;
      total += BigInt(bytesRead);
      for (let i = 0; i < bytesRead; i++) {
        const byte = buffer[i]!;
        if (byte === 13 || (byte === 10 && last !== 13)) lines++;
        last = byte;
      }
    }
    if (total !== entry.size || snapshotToken(await handle.stat({ bigint: true })) !== snapshotToken(entry)) throw stale();
    await assertSnapshot(file, entry);
    const after = await safePath(root, relativePath);
    if (chain.map(snapshotToken).join("/") !== after.chain.map(snapshotToken).join("/")) throw stale();
    return lines + (last !== -1 && last !== 10 && last !== 13 ? 1 : 0);
  } finally { await handle.close(); }
}
export async function listSkillPaths(skillsDir: string, options: { includeHidden?: boolean; expectedRoot?: ApprovedSkillsRoot; relativePath?: string } = {}): Promise<Array<{ path: string; kind: "directory" | "file" | "symlink" }>> {
  const root = await checkedRoot(skillsDir, options.expectedRoot);
  if (options.relativePath !== undefined) {
    const components = checkedRelative(options.relativePath);
    if (components[0] === ".skills-manager") throw new Error("Controlled application state is not a skill subtree");
  }
  const selected = await safePath(root, options.relativePath ?? "", options.relativePath === undefined);
  const base = await directory(selected.file);
  if (base.dev !== selected.chain[0]!.dev) throw error("EXDEV", "Path crosses the selected filesystem");
  const entries: Array<{ path: string; kind: "directory" | "file" | "symlink" }> = [];
  const walk = async (file: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 512) throw error("E2BIG", "Listing depth exceeds supported bounds");
    const before = await directory(file);
    for (const name of await names(file)) {
      if (!options.includeHidden && (name.startsWith(".") || name === "__pycache__")) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const entry = await lstat(path.join(file, name), { bigint: true });
      if (entry.dev !== base.dev) throw error("EXDEV", "Path crosses the selected filesystem");
      if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) throw error("ENOTSUP", "Listing contains a special file");
      if (entries.length >= 100000) throw error("E2BIG", "Listing entry limit exceeded");
      entries.push({ path: relative, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "symlink" });
      if (entry.isDirectory()) await walk(path.join(file, name), relative, depth + 1);
    }
    await assertSnapshot(file, before);
  };
  await walk(selected.file, "", 0);
  if (options.expectedRoot) await assertApprovedSkillsRoot(options.expectedRoot);
  return entries;
}
export async function readSkillFiles(directory: string): Promise<{ files: Array<{ path: string; content: string }>; version: string }> {
  const root = await approveSkillsRoot(path.resolve(directory));
  const before = await treeFingerprint(root.path, false, true);
  const entries = await listSkillPaths(root.path, { includeHidden: true, expectedRoot: root });
  if (entries.length > 10000) throw new Error("Staged skill has too many entries to review");
  const files: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const entry of entries) {
    if (entry.path.split("/").length > 50) throw new Error("Staged skill exceeds the review depth limit");
    if (entry.kind === "symlink") throw new Error("Staged skill contains a symbolic link");
    if (entry.kind !== "file") continue;
    const value = await readSkillPath(root.path, entry.path, { maxBytes: 2 * 1024 * 1024 - bytes, expectedRoot: root });
    if (value.truncated) throw new Error("Staged skill exceeds the review byte limit");
    bytes += value.content.length; files.push({ path: entry.path, content: decoder.decode(value.content) });
  }
  if (await treeFingerprint(root.path, false, true) !== before) throw stale("Staged skill changed during review");
  return { files, version: before };
}
export async function readParentSkillLock(skillsDir: string, expectedRoot?: ApprovedSkillsRoot): Promise<string | null> {
  const root = await checkedRoot(skillsDir, expectedRoot);
  const lock = path.join(path.dirname(root), ".skill-lock.json");
  const entry = await maybeStat(lock);
  return entry ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fileBytes(lock, entry, cliLockLimit)) : null;
}

function checkedCliLockPath(lockPath: string): void {
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath) || path.normalize(lockPath) !== lockPath ||
      path.basename(lockPath) !== ".skill-lock.json" || path.dirname(lockPath) === path.parse(lockPath).root || lockPath.includes("\0")) {
    throw new Error("An absolute, normalized .skill-lock.json path in a safe parent is required");
  }
}
function checkedCliLockContent(content: string): Buffer {
  if (typeof content !== "string" || Buffer.byteLength(content) > cliLockLimit || Buffer.from(content).toString() !== content) throw new Error("CLI lock content must be valid UTF-8 within the byte limit");
  return Buffer.from(content);
}
export async function snapshotCliLock(lockPath: string): Promise<CliLockSnapshot> {
  checkedCliLockPath(lockPath);
  const parent = path.dirname(lockPath);
  let ancestor = parent;
  const missing: string[] = [];
  while (!await maybeStat(ancestor)) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  await ancestors(ancestor);
  const parentIdentity = missing.length ? `missing:${directoryToken(await directory(ancestor))}:${Buffer.from(missing.join("/")).toString("hex")}` : directoryToken(await directory(parent));
  if (missing.length) return { path: lockPath, identity: "missing", parentIdentity, content: "" };
  const entry = await maybeStat(lockPath);
  if (!entry) return { path: lockPath, identity: "missing", parentIdentity, content: "" };
  const bytes = await fileBytes(lockPath, entry, cliLockLimit);
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { path: lockPath, identity: hash(`${snapshotToken(entry)}:${hash(bytes)}`), parentIdentity, content };
}
export async function publishCliLock(snapshot: CliLockSnapshot, content: string): Promise<void> {
  if (!snapshot || typeof snapshot !== "object") throw new Error("A CLI lock snapshot is required");
  checkedCliLockPath(snapshot.path); checkedCliLockContent(snapshot.content);
  const replacement = checkedCliLockContent(content);
  const run = async (): Promise<void> => {
    const current = await snapshotCliLock(snapshot.path);
    if (current.identity !== snapshot.identity || current.parentIdentity !== snapshot.parentIdentity || current.content !== snapshot.content) throw stale("CLI lock or its parent changed since review");
    let parent = path.dirname(snapshot.path);
    const created: Array<{ file: string; identity: string }> = [];
    let temporary: string | undefined;
    try {
      if (snapshot.parentIdentity.startsWith("missing:")) {
        const suffix = snapshot.parentIdentity.slice(73);
        const relative = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(suffix, "hex"));
        const components = checkedRelative(relative);
        for (const unused of components) { void unused; parent = path.dirname(parent); }
        for (const component of components) {
          parent = path.join(parent, component); await mkdir(parent, { mode: 0o700 });
          created.push({ file: parent, identity: inode(await directory(parent)) }); await syncDirectory(path.dirname(parent));
        }
      }
      const original = await maybeStat(snapshot.path);
      const mode = original ? Number(original.mode & 0o777n) : 0o600;
      temporary = path.join(parent, `.skill-lock-${randomUUID()}.tmp`);
      await createFile(temporary, replacement, mode);
      if (original) { regular(original); await assertSnapshot(snapshot.path, original); await rename(temporary, snapshot.path); }
      else await exclusiveRename(temporary, snapshot.path);
      temporary = undefined;
      await syncDirectory(parent);
    } catch (cause) {
      if (temporary && await maybeStat(temporary)) await unlink(temporary);
      for (const entry of created.reverse()) {
        if (inode(await directory(entry.file)) !== entry.identity) throw stale("Created CLI lock parent changed; preserving it");
        try { await rmdir(entry.file); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw cleanup; break; }
      }
      throw cause;
    }
  };
  // The path-keyed publication lock is shared by sibling installation roots
  // and stays stable even when the snapshotted parent chain is still missing.
  const key = `cli:${snapshot.path}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => withPathLock(key, run)); queues.set(key, result);
  try { await result; } finally { if (queues.get(key) === result) queues.delete(key); }
}

/** Git's canonical SHA-1 tree object, without writing a repository or index. */
export async function gitTreeHash(directoryPath: string): Promise<string> {
  const root = path.resolve(directoryPath); await ancestors(root);
  const device = (await directory(root)).dev;
  let count = 0, bytes = 0;
  const snapshots: Array<{ file: string; entry: BigIntStats }> = [];
  const object = (kind: string, data: Buffer): Buffer => createHash("sha1").update(`${kind} ${data.length}\0`).update(data).digest();
  const walk = async (file: string, depth: number): Promise<{ digest: Buffer; included: boolean }> => {
    if (depth > 128) throw error("E2BIG", "Git tree depth limit exceeded (128)");
    const before = await directory(file);
    snapshots.push({ file, entry: before });
    if (before.dev !== device) throw error("EXDEV", "Git tree crosses filesystems");
    const entries: Array<{ name: string; directory: boolean; mode: string; digest: Buffer }> = [];
    for (const name of await names(file)) {
      if (++count > 100000) throw error("E2BIG", "Git tree entry limit exceeded (100000)");
      if (name === ".git") continue;
      const child = path.join(file, name), entry = await lstat(child, { bigint: true });
      snapshots.push({ file: child, entry });
      if (entry.dev !== device) throw error("EXDEV", "Git tree crosses filesystems");
      if (entry.isDirectory()) {
        const result = await walk(child, depth + 1);
        if (result.included) entries.push({ name, directory: true, mode: "40000", digest: result.digest });
      } else {
        regular(entry); bytes += Number(entry.size);
        if (bytes > 64 * 1024 * 1024) throw error("E2BIG", "Git tree input limit exceeded (64 MiB)");
        entries.push({ name, directory: false, mode: entry.mode & 0o100n ? "100755" : "100644", digest: object("blob", await fileBytes(child, entry, 64 * 1024 * 1024)) });
      }
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.directory ? "/" : "\0")), Buffer.from(b.name + (b.directory ? "/" : "\0"))));
    const body = Buffer.concat(entries.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), entry.digest]));
    await assertSnapshot(file, before);
    return { digest: object("tree", body), included: entries.length > 0 };
  };
  const result = (await walk(root, 0)).digest.toString("hex");
  for (const snapshot of snapshots) await assertSnapshot(snapshot.file, snapshot.entry);
  return result;
}
export async function readManagedMetadata(skillsDir: string, name: string, expectedRoot?: ApprovedSkillsRoot): Promise<string | null> {
  checkedName(name);
  const root = await checkedRoot(skillsDir, expectedRoot);
  const selected = expectedRoot ?? await approveSkillsRoot(root);
  const target = await state(selected, false);
  if (!target) return null;
  const metadata = path.join(target, "metadata");
  if (!await maybeStat(metadata)) return null;
  owned(await directory(metadata), true);
  const file = path.join(metadata, `${name}.json`), entry = await maybeStat(file);
  if (!entry) return null;
  owned(entry);
  return (await fileBytes(file, entry, cliLockLimit)).toString("utf8");
}
export async function directoryIdentity(directoryPath: string): Promise<string> {
  const original = path.resolve(directoryPath), canonical = await realpath(original);
  return JSON.stringify({ original, canonical, identity: (await approveSkillsRoot(canonical)).identity });
}
async function safeTree(file: string, device: bigint, staged = false, depth = 0): Promise<void> {
  if (depth > 512) throw error("E2BIG", "Tree depth exceeds supported bounds");
  const entry = await lstat(file, { bigint: true });
  if (entry.dev !== device) throw error("EXDEV", "Tree crosses filesystems");
  if (entry.isSymbolicLink()) { if (staged || entry.nlink !== 1n) throw error("EPERM", "Refusing linked staged input or hardlinked symlink"); return; }
  if (entry.isFile()) { regular(entry); return; }
  if (!entry.isDirectory()) throw error("ENOTSUP", "Refusing special file");
  for (const name of await names(file)) await safeTree(path.join(file, name), device, staged, depth + 1);
}
async function removeTree(file: string): Promise<void> {
  const entry = await lstat(file, { bigint: true });
  await safeTree(file, entry.dev);
  const remove = async (selected: string): Promise<void> => {
    const s = await lstat(selected, { bigint: true });
    if (s.isDirectory()) { for (const name of await names(selected)) await remove(path.join(selected, name)); await rmdir(selected); }
    else await unlink(selected);
  };
  await remove(file);
}
export async function removeDisposableTree(directoryPath: string, token: string): Promise<void> {
  let captured: { original?: unknown; canonical?: unknown; identity?: unknown };
  try { captured = JSON.parse(token) as typeof captured; } catch { throw new Error("Invalid workspace identity"); }
  if (captured.original !== path.resolve(directoryPath) || typeof captured.canonical !== "string" || typeof captured.identity !== "string") throw new Error("Workspace identity does not match the requested path");
  await assertApprovedSkillsRoot({ path: captured.canonical, identity: captured.identity });
  // A replacement of the original alias must not authorize deleting its old target.
  if (await realpath(path.resolve(directoryPath)) !== captured.canonical) throw stale("Workspace path changed");
  await removeTree(captured.canonical); await syncDirectory(path.dirname(captured.canonical));
}

const gitJournals = ["git-transaction.json", "git-transaction.json.next", "git-transaction-journal", "git-transaction-journal.next", "git-transaction-journal.delete", "transaction.journal"];
export async function hasIndexTransaction(root: ApprovedSkillsRoot): Promise<boolean> {
  const target = await state(root, false);
  if (!target) return false;
  let pending = false;
  for (const name of gitJournals) { const entry = await maybeStat(path.join(target, name)); if (entry) { owned(entry); pending = true; } }
  return pending;
}
function checkedIndex(name: string): void {
  if (!/^git-index-[A-Za-z0-9_-]+(?:\.lock)?$/.test(name) || Buffer.byteLength(name) > 128) throw new Error("Invalid temporary Git index name");
}
function safeIndex(entry: BigIntStats): void {
  regular(entry);
  if ((entry.mode & 0o022n) !== 0n || (process.getuid && entry.uid !== BigInt(process.getuid()))) {
    throw error("EPERM", "Temporary Git index has unsafe ownership or write permissions");
  }
}
export async function inspectGitIndex(root: ApprovedSkillsRoot, name: string): Promise<string | null> {
  checkedIndex(name);
  return withSkillsLock(root, async () => {
    const entry = await maybeStat(path.join(statePath(root), name));
    if (!entry) return null;
    safeIndex(entry); return inode(entry);
  });
}
export async function cleanupGitIndex(root: ApprovedSkillsRoot, name: string, identity: string): Promise<void> {
  checkedIndex(name);
  if (!/^\d+:\d+$/.test(identity)) throw new Error("Invalid temporary Git index identity");
  await withSkillsLock(root, async () => {
    const file = path.join(statePath(root), name), entry = await maybeStat(file);
    if (!entry) return;
    safeIndex(entry); if (inode(entry) !== identity) throw stale("Temporary Git index changed; preserving it");
    await unlink(file); await syncDirectory(statePath(root));
  });
}

interface JournalMove { from: string; to: string; fingerprint: string }
interface Journal { version: 2; rootIdentity: string; phase: "intent" | "committed" | "rolled-back"; moves: JournalMove[]; rollbackCleanup: Array<{ path: string; fingerprint: string }>; commitCleanup: Array<{ path: string; fingerprint: string }> }
function journalPath(root: ApprovedSkillsRoot, relative: string): string {
  checkedRelative(relative);
  const parts = relative.split("/");
  if (parts[0] === ".skills-manager") {
    if (parts.length === 2 && ["quarantine", "incoming", "oldmeta", "newmeta"].includes(parts[1]!)) return path.join(root.path, relative);
    if (parts.length === 3 && parts[1] === "metadata" && parts[2]!.endsWith(".json")) { checkedName(parts[2]!.slice(0, -5)); return path.join(root.path, relative); }
  } else if (parts.length === 1 || (parts.length === 2 && parts[0] === ".disabled_skills")) { checkedName(parts.at(-1)!); return path.join(root.path, relative); }
  throw new Error("Unrecognized journal path; preserving state");
}
async function saveJournal(target: string, journal: Journal): Promise<void> {
  const next = path.join(target, "journal.next");
  await createFile(next, JSON.stringify(journal));
  await rename(next, path.join(target, "journal")); await syncDirectory(target);
}
async function expectedObject(file: string, fingerprint: string): Promise<boolean> {
  if (!await maybeStat(file)) return false;
  if (await fingerprintTree(file) !== fingerprint) throw stale("Recovery object changed; preserving all data");
  return true;
}
async function recoverJournal(root: ApprovedSkillsRoot, target: string): Promise<string | undefined> {
  const journalFile = path.join(target, "journal");
  let entry = await maybeStat(journalFile);
  if (!entry) {
    for (const name of ["quarantine", "incoming", "oldmeta", "newmeta", "journal.next"]) {
      if (await maybeStat(path.join(target, name))) throw stale("Unjournaled recovery data needs manual review; preserving all data");
    }
    return undefined;
  }
  owned(entry);
  let journal: Journal;
  try {
    journal = JSON.parse((await fileBytes(journalFile, entry, cliLockLimit)).toString()) as Journal;
    if (journal.version !== 2 || journal.rootIdentity !== root.identity || !["intent", "committed", "rolled-back"].includes(journal.phase) ||
        !Array.isArray(journal.moves) || !Array.isArray(journal.rollbackCleanup) || !Array.isArray(journal.commitCleanup) || journal.moves.length > 4) throw new Error("invalid format");
    for (const move of journal.moves) { journalPath(root, move.from); journalPath(root, move.to); checkedFingerprint(move.fingerprint); }
    for (const item of [...journal.rollbackCleanup, ...journal.commitCleanup]) { journalPath(root, item.path); checkedFingerprint(item.fingerprint); }
  } catch { throw stale("Recovery journal is legacy, invalid, or ambiguous; preserving all data for manual review"); }
  const disabled = path.join(root.path, ".disabled_skills");
  if (await maybeStat(disabled)) await directory(disabled);
  const meta = path.join(target, "metadata");
  if (await maybeStat(meta)) owned(await directory(meta), true);
  if (await maybeStat(path.join(target, "journal.next"))) throw stale("Interrupted journal publication needs manual review; preserving all data");
  if (journal.phase === "intent") {
    for (const move of [...journal.moves].reverse()) {
      const from = journalPath(root, move.from), to = journalPath(root, move.to);
      const source = await maybeStat(from), destination = await maybeStat(to);
      // An unapplied later move may still have the preceding move's original
      // occupying its destination. Only its own exact source authorizes skipping.
      if (source && await fingerprintTree(from) === move.fingerprint) continue;
      if (source || !destination || !await expectedObject(to, move.fingerprint)) throw stale("Recovery is ambiguous; preserving all data");
      await exclusiveRename(to, from);
    }
    journal.phase = "rolled-back";
    await saveJournal(target, journal);
    entry = await lstat(journalFile, { bigint: true });
  } else if (journal.phase === "committed") {
    for (const move of journal.moves) {
      // A moved destination may subsequently have been consumed by another move.
      if (journal.moves.some((later) => later.from === move.to)) continue;
      if (journal.commitCleanup.some((item) => item.path === move.to) && !await maybeStat(journalPath(root, move.to))) continue;
      if (!await expectedObject(journalPath(root, move.to), move.fingerprint)) throw stale("Committed recovery object is missing; preserving state");
    }
  }
  const cleanup = journal.phase === "committed" ? journal.commitCleanup : journal.rollbackCleanup;
  for (const item of cleanup) {
    const file = journalPath(root, item.path);
    if (await expectedObject(file, item.fingerprint)) { await removeTree(file); await syncDirectory(path.dirname(file)); }
  }
  await assertSnapshot(journalFile, entry); await unlink(journalFile); await syncDirectory(target);
  return journal.phase === "committed" ? "Completed interrupted skill transaction." : "Rolled back interrupted skill transaction.";
}
async function runTransaction(root: ApprovedSkillsRoot, moves: JournalMove[], rollbackCleanup: Journal["rollbackCleanup"], commitCleanup: Journal["commitCleanup"]): Promise<void> {
  const target = statePath(root);
  const journal: Journal = { version: 2, rootIdentity: root.identity, phase: "intent", moves, rollbackCleanup, commitCleanup };
  await saveJournal(target, journal);
  for (const move of moves) {
    const from = journalPath(root, move.from), to = journalPath(root, move.to);
    if (!await expectedObject(from, move.fingerprint)) throw stale("Transaction source disappeared; journal retained");
    await exclusiveRename(from, to);
  }
  journal.phase = "committed"; await saveJournal(target, journal);
  await recoverJournal(root, target);
}
async function reviewedMutation(root: ApprovedSkillsRoot, name: string, file: string, expectedVersion: string): Promise<void> {
  checkedFingerprint(expectedVersion);
  const entry = await lstat(file, { bigint: true });
  for (const reserved of [".git", ".disabled_skills", ".skills-manager"]) {
    const other = await maybeStat(path.join(root.path, reserved));
    if (other && inode(other) === inode(entry)) throw error("EPERM", "Reserved root metadata cannot be changed as a skill");
  }
  await safeTree(file, (await directory(root.path)).dev);
  if (await fingerprintTree(file) !== expectedVersion) throw stale("Reviewed skill changed since confirmation");
  checkedName(name);
}
async function metadataMoves(root: ApprovedSkillsRoot, name: string, metadata?: string): Promise<{ moves: JournalMove[]; rollback: Journal["rollbackCleanup"]; commit: Journal["commitCleanup"] }> {
  const target = statePath(root), meta = path.join(target, "metadata");
  if (await maybeStat(meta)) owned(await directory(meta), true);
  else if (metadata !== undefined) { await mkdir(meta, { mode: 0o700 }); await chmod(meta, 0o700); await syncDirectory(target); }
  const moves: JournalMove[] = [], rollback: Journal["rollbackCleanup"] = [], commit: Journal["commitCleanup"] = [];
  const receipt = `.skills-manager/metadata/${name}.json`;
  const old = await maybeStat(path.join(root.path, receipt));
  if (old) {
    owned(old); const fingerprint = await fingerprintTree(path.join(root.path, receipt));
    moves.push({ from: receipt, to: ".skills-manager/oldmeta", fingerprint }); commit.push({ path: ".skills-manager/oldmeta", fingerprint });
  }
  if (metadata !== undefined) {
    await createFile(path.join(target, "newmeta"), metadata);
    const fingerprint = await fingerprintTree(path.join(target, "newmeta"));
    moves.push({ from: ".skills-manager/newmeta", to: receipt, fingerprint }); rollback.push({ path: ".skills-manager/newmeta", fingerprint });
  }
  return { moves, rollback, commit };
}
export async function moveReviewedSkill(root: ApprovedSkillsRoot, name: string, expectedVersion: string, direction: "disable" | "enable"): Promise<void> {
  checkedName(name); checkedFingerprint(expectedVersion);
  if (direction !== "disable" && direction !== "enable") throw new Error("Invalid skill move direction");
  await mutation(root, async () => {
    const locations = await skillLocations(root, name);
    const from = direction === "disable" ? locations.active : locations.disabled;
    const to = direction === "disable" ? locations.disabled : locations.active;
    await reviewedMutation(root, name, from, expectedVersion);
    if (await maybeStat(to)) throw error("EEXIST", "Skill destination already exists");
    if (direction === "disable" && !await maybeStat(path.dirname(to))) { await mkdir(path.dirname(to), { mode: 0o700 }); await syncDirectory(root.path); }
    await runTransaction(root, [{ from: path.relative(root.path, from), to: path.relative(root.path, to), fingerprint: expectedVersion }], [], []);
  });
}
export async function deleteReviewedSkill(root: ApprovedSkillsRoot, name: string, expectedPath: string, expectedVersion: string): Promise<void> {
  checkedName(name); checkedFingerprint(expectedVersion);
  const location = reviewedLocation(root.path, name, expectedPath);
  await mutation(root, async () => {
    const locations = await skillLocations(root, name), file = locations[location];
    await reviewedMutation(root, name, file, expectedVersion);
    const meta = await metadataMoves(root, name);
    await runTransaction(root, [{ from: path.relative(root.path, file), to: ".skills-manager/quarantine", fingerprint: expectedVersion }, ...meta.moves], meta.rollback, [{ path: ".skills-manager/quarantine", fingerprint: expectedVersion }, ...meta.commit]);
  });
}
export interface ImportOptions {
  expectedPath?: string;
  expectedVersion?: string;
  expectedStagedVersion: string;
  replace: boolean;
  metadata?: string;
}
async function copyStaged(source: string, destination: string): Promise<void> {
  const entry = await lstat(source, { bigint: true });
  if (entry.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of await names(source)) await copyStaged(path.join(source, name), path.join(destination, name));
    await chmod(destination, Number(entry.mode & 0o7777n)); await syncDirectory(destination);
  } else {
    regular(entry); await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, Number(entry.mode & 0o7777n));
    const handle = await open(destination, constants.O_RDONLY | noFollow); try { await handle.sync(); } finally { await handle.close(); }
  }
}
export async function importSkill(root: ApprovedSkillsRoot, name: string, stagedPath: string, options: ImportOptions): Promise<void> {
  checkedName(name); checkedFingerprint(options.expectedStagedVersion);
  let location: "active" | "disabled" = "active";
  if (options.replace) {
    if (!options.expectedPath || !options.expectedVersion) throw new Error("Replacement requires the exact reviewed path and fingerprint");
    location = reviewedLocation(root.path, name, options.expectedPath); checkedFingerprint(options.expectedVersion);
  } else if (options.expectedPath || options.expectedVersion) throw new Error("A new installation cannot specify a replacement path or fingerprint");
  if (options.metadata !== undefined && (typeof options.metadata !== "string" || Buffer.byteLength(options.metadata) > cliLockLimit)) throw new Error("Provenance metadata exceeds the supported size");
  const staged = path.resolve(stagedPath);
  await mutation(root, async () => {
    const locations = await skillLocations(root, name), destination = locations[location];
    if (options.replace) await reviewedMutation(root, name, destination, options.expectedVersion!);
    else if (await maybeStat(locations.active) || await maybeStat(locations.disabled)) throw error("EEXIST", "Skill already exists");
    if (staged === root.path || staged.startsWith(root.path + path.sep) || root.path.startsWith(staged + path.sep)) throw new Error("Staged input must be separate from the selected directory");
    if (await treeFingerprint(staged, false, true) !== options.expectedStagedVersion) throw stale("Staged skill changed since review");
    await safeTree(staged, (await directory(staged)).dev, true);
    const incoming = path.join(statePath(root), "incoming");
    await copyStaged(staged, incoming); await syncDirectory(statePath(root));
    if (await treeFingerprint(staged, false, true) !== options.expectedStagedVersion || await fingerprintContents(incoming) !== await fingerprintContents(staged)) throw stale("Staged skill changed while copying; staging retained");
    const fingerprint = await fingerprintTree(incoming);
    const meta = await metadataMoves(root, name, options.metadata);
    const moves: JournalMove[] = [];
    const cleanup = [...meta.commit];
    if (options.replace) { moves.push({ from: path.relative(root.path, destination), to: ".skills-manager/quarantine", fingerprint: options.expectedVersion! }); cleanup.unshift({ path: ".skills-manager/quarantine", fingerprint: options.expectedVersion! }); }
    moves.push({ from: ".skills-manager/incoming", to: path.relative(root.path, destination), fingerprint }, ...meta.moves);
    await runTransaction(root, moves, [{ path: ".skills-manager/incoming", fingerprint }, ...meta.rollback], cleanup);
  });
}
