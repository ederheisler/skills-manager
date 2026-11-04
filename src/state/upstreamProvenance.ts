import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { approveSkillsRoot, assertApprovedSkillsRoot, fingerprintContents, fingerprintSkillContents, gitTreeHash, readManagedMetadata, readParentSkillLock, type ApprovedSkillsRoot } from "../actions/boundary.js";
import type { LockEntry } from "./types.js";
import { isLockEntry, isRecord, parseSkillLockFile } from "./validation.js";

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_METADATA_BYTES = 1024 * 1024;

function validName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && name !== ".git" && name !== ".disabled_skills"
    && name !== ".skills-manager" && Buffer.byteLength(name) <= 255 && !name.includes("/") && !name.includes("\\") && !CONTROL.test(name);
}

/** Source records are data, not authorization to execute an arbitrary command. */
export function validSourceEntry(entry: LockEntry): boolean {
  if (!entry.source || !entry.sourceType || !entry.sourceUrl
    || [entry.source, entry.sourceType, entry.sourceUrl, entry.skillPath, entry.ref ?? ""].some((s) => CONTROL.test(s))) return false;
  if (entry.sourceType === "local") return path.isAbsolute(entry.sourceUrl);
  let url: URL;
  try { url = new URL(entry.sourceUrl); } catch { return false; }
  if ((url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:")
    || url.username || url.password || url.search || !url.hostname) return false;
  if (entry.source.includes("://")) {
    try {
      const sourceUrl = new URL(entry.source);
      if (sourceUrl.username || sourceUrl.password || sourceUrl.search) return false;
    } catch { return false; }
  }
  if (entry.sourceType !== "github") return true;
  const repository = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(entry.source);
  if (!repository || url.hostname.toLowerCase() !== "github.com") return false;
  const urlPath = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
  return urlPath.toLowerCase() === `/${repository[1]}/${repository[2]}`.toLowerCase();
}


async function directSkill(skillsDir: string, skillPath: string, name: string): Promise<{ root: string; target: string } | null> {
  if (!validName(name)) return null;
  const root = await realpath(skillsDir);
  const active = path.join(root, name);
  const disabledDir = path.join(root, ".disabled_skills");
  const disabled = path.join(disabledDir, name);
  const target = path.resolve(skillPath);
  const spelledActive = path.resolve(skillsDir, name);
  const spelledDisabled = path.resolve(skillsDir, ".disabled_skills", name);
  if (target !== active && target !== disabled && target !== spelledActive && target !== spelledDisabled) return null;
  const isDisabled = target === disabled || target === spelledDisabled;
  if (isDisabled) {
    const parent = await lstat(disabledDir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) return null;
  }
  const actual = isDisabled ? disabled : active;
  const stat = await lstat(actual);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(actual) !== actual) return null;
  try {
    await lstat(isDisabled ? active : disabled);
    return null; // A name-only record cannot distinguish two installed paths.
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return { root, target: actual };
}

async function selectedSkill(skillsDir: string, skillPath: string, name: string): Promise<{ root: string; target: string } | null> {
  try { return await directSkill(skillsDir, skillPath, name); }
  catch (error) {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")) return null;
    throw error;
  }
}

export type HistoricalBaseline = "unknown" | "reviewed" | "none";
/** Locally consistent receipt data, not independently authenticated origin or review. */
export interface SourceAssociation {
  entry: LockEntry;
  /** The receipt's historical claim, not independent proof of review. */
  historicalBaseline: HistoricalBaseline;
}

/** Physical continuity only; an in-place restore can retain this identity with forged metadata. */
export async function physicalRootIdentity(approved: ApprovedSkillsRoot): Promise<{ device: string; inode: string }> {
  await assertApprovedSkillsRoot(approved);
  const canonical = await realpath(approved.path);
  const stat = await lstat(approved.path, { bigint: true });
  if (canonical !== approved.path || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error("Selected skills directory changed since approval"), { code: "ESTALE" });
  }
  await assertApprovedSkillsRoot(approved);
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

async function readReceipt(root: string, name: string, approved: ApprovedSkillsRoot): Promise<(SourceAssociation & { fingerprint: string }) | null> {
  if (!validName(name)) return null;
  let text: string | null;
  try { text = await readManagedMetadata(root, name, approved); }
  catch (error) {
    if (isRecord(error) && error.code === "EFBIG") return null;
    throw error;
  }
  if (text === null || Buffer.byteLength(text) > MAX_METADATA_BYTES) return null;
  let receipt: unknown;
  try { receipt = JSON.parse(text); } catch { return null; }
  if (!isRecord(receipt) || receipt.version !== 2 || receipt.root !== root || receipt.name !== name
    || !isRecord(receipt.rootIdentity)
    || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
    || (receipt.historicalBaseline !== "unknown" && receipt.historicalBaseline !== "reviewed" && receipt.historicalBaseline !== "none")
    || !isLockEntry(receipt.entry) || !validSourceEntry(receipt.entry)) return null;
  const rootIdentity = await physicalRootIdentity(approved);
  if (receipt.rootIdentity.device !== rootIdentity.device || receipt.rootIdentity.inode !== rootIdentity.inode) return null;
  return { entry: receipt.entry, fingerprint: receipt.fingerprint, historicalBaseline: receipt.historicalBaseline };
}

/**
 * Match a local receipt to the selected root and current contents.
 * This does not authenticate the source or prove prior review: an in-place
 * restore can retain the root identity while replacing its receipt and skill.
 */
export async function matchUpstreamReceipt(skillsDir: string, skillPath: string, name: string, approved?: ApprovedSkillsRoot): Promise<SourceAssociation | null> {
  if (approved) {
    if (path.resolve(skillsDir) !== approved.path) throw new Error("Source association root does not match the approved directory.");
    const fingerprint = await fingerprintSkillContents(approved, name, skillPath);
    const receipt = await readReceipt(approved.path, name, approved);
    return receipt && fingerprint === receipt.fingerprint
      ? { entry: receipt.entry, historicalBaseline: receipt.historicalBaseline }
      : null;
  }
  const selected = await selectedSkill(skillsDir, skillPath, name);
  if (!selected) return null;
  const selectedRoot = await approveSkillsRoot(selected.root);
  const receipt = await readReceipt(selected.root, name, selectedRoot);
  if (!receipt) return null;
  const fingerprint = await fingerprintSkillContents(selectedRoot, name, selected.target);
  return fingerprint === receipt.fingerprint
    ? { entry: receipt.entry, historicalBaseline: receipt.historicalBaseline }
    : null;
}

/** Stale receipts remain visible but cannot establish the source of a missing skill. */
export async function listOrphanedReceipts(skillsDir: string): Promise<Array<{ name: string; entry: LockEntry }>> {
  const root = await realpath(skillsDir);
  const approved = await approveSkillsRoot(root);
  const metadata = path.join(root, ".skills-manager", "metadata");
  try {
    const state = await lstat(path.dirname(metadata));
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Reserved metadata location is unsafe.");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  // Validate ownership even when the metadata directory itself is absent.
  await readManagedMetadata(root, ".receipt-probe", approved);
  try {
    const info = await lstat(metadata);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Reserved metadata location is unsafe.");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const disabled = path.join(root, ".disabled_skills");
  try {
    const info = await lstat(disabled);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Disabled skills location is unsafe.");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const names = await readdir(metadata, { encoding: "buffer" });
  const orphans: Array<{ name: string; entry: LockEntry }> = [];
  for (const rawName of names) {
    const filename = rawName.toString("utf8");
    if (!Buffer.from(filename, "utf8").equals(rawName)) {
      throw new Error(`Cannot inspect controlled metadata: a filename is not valid UTF-8 (bytes: ${rawName.toString("hex")}).`);
    }
    if (!filename.endsWith(".json")) continue;
    const name = filename.slice(0, -5);
    if (!validName(name)) continue;
    let present = false;
    for (const candidate of [path.join(root, name), path.join(disabled, name)]) {
      try { await lstat(candidate); present = true; break; }
      catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
    }
    if (present) continue;
    const receipt = await readReceipt(root, name, approved);
    if (receipt) orphans.push({ name, entry: receipt.entry });
  }
  return orphans;
}

/** External v3 lock data is an unverified source claim, even if its tree matches. */
export async function readExternalClaim(skillsDir: string, skillPath: string, name: string): Promise<LockEntry | null> {
  const selected = await selectedSkill(skillsDir, skillPath, name);
  if (!selected || await realpath(path.dirname(path.resolve(skillsDir))) !== path.dirname(selected.root)) return null;
  let text: string | null;
  try { text = await readParentSkillLock(selected.root); }
  catch (error) {
    if (isRecord(error) && error.code === "EFBIG") return null;
    throw error;
  }
  if (text === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const lock = parseSkillLockFile(raw);
  const entry = lock?.version === 3 ? lock.skills[name] : undefined;
  if (!entry || entry.sourceType !== "github" || !validSourceEntry(entry) || !/^[a-f0-9]{40}$/i.test(entry.skillFolderHash)) return null;
  const before = await fingerprintContents(selected.target);
  const hash = await gitTreeHash(selected.target);
  const after = await fingerprintContents(selected.target);
  return before === after && hash.toLowerCase() === entry.skillFolderHash.toLowerCase() ? entry : null;
}
