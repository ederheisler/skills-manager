import { lstat, mkdir, mkdtemp, readdir, realpath, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertApprovedSkillsRoot, directoryIdentity, fingerprintContents, fingerprintSkill, fingerprintTree, importSkill, listSkillPaths, publishCliLock, readSkillFiles, readSkillPath, removeDisposableTree, snapshotCliLock, withSkillsLock, type ApprovedSkillsRoot, type CliLockSnapshot } from "./boundary.js";
import { runConfinedSkills } from "./sandbox.js";
import type { LockEntry, Skill } from "../state/types.js";
import { isRecord } from "../state/validation.js";
import { cliLockPath, matchUpstreamReceipt, physicalRootIdentity, readExternalClaim, validSourceEntry } from "../state/upstreamProvenance.js";


export interface PreparedSkillChange {
  kind: "add" | "update";
  skillsDir: string;
  source: string;
  changes: Array<{ name: string; destination: string; enabled: boolean; files: string[]; action: "install" | "replace"; review: string }>;
  failed?: Array<{ id: string; name: string; reason: string }>;
  workspace: string;
}

interface PendingImport {
  name: string;
  staged: string;
  stagedVersion: string;
  destination: string;
  expectedVersion?: string;
  metadata?: string;
}

interface Pending {
  root: ApprovedSkillsRoot;
  workspace: string;
  workspaceIdentity: string;
  imports: PendingImport[];
  cliLock?: { snapshot: CliLockSnapshot; content: string };
  consumed: boolean;
}

const pending = new WeakMap<PreparedSkillChange, Pending>();
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SHORTHAND = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?(?:@[\w.-]+)?$/;
const FRAGMENT = /^(?:[\w.!~*'()\/-]|%[a-fA-F0-9]{2})*(?:@(?:[\w.!~*'()\/-]|%[a-fA-F0-9]{2})+)?$/;

function validName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && name !== ".git" && name !== ".disabled_skills" && name !== ".skills-manager"
    && Buffer.byteLength(name) <= 255 && !name.includes("/") && !name.includes("\\") && !CONTROL.test(name);
}


async function sourceForSandbox(source: string): Promise<{ argument: string; localSource?: string }> {
  if (!source || source.startsWith("-") || CONTROL.test(source)) throw new Error("Invalid source.");
  if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
    const localSource = await realpath(source);
    if (!(await lstat(localSource)).isDirectory()) throw new Error("The selected local source is not a directory.");
    return { argument: process.platform === "linux" ? "/source" : localSource, localSource };
  }
  const hash = source.indexOf("#");
  const repository = hash < 0 ? source : source.slice(0, hash);
  if (SHORTHAND.test(repository) && (hash < 0 || FRAGMENT.test(source.slice(hash + 1)))) return { argument: source };
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Enter a supported repository URL or local source directory."); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search) {
    throw new Error("Source URL must be HTTP(S) without embedded credentials or query parameters.");
  }
  return { argument: source };
}

/** Pass a selector only when the CLI parser will not apply it itself. */
function replacementSkillArgument(source: string, targetName: string, localSource?: string): string | null {
  if (localSource) return targetName;
  const hash = source.indexOf("#");
  const repository = hash < 0 ? source : source.slice(0, hash);
  if (/^[\w.-]+\/[\w.-]+@[\w.-]+$/.test(repository)) return null;
  const separator = hash < 0 ? -1 : source.indexOf("@", hash + 1);
  if (separator < 0 || separator === source.length - 1) return targetName;
  if (SHORTHAND.test(repository)) return null;
  try {
    const segments = new URL(repository).pathname.split("/").filter(Boolean);
    const index = segments.indexOf("_git");
    if (index >= 0 && index < segments.length - 1) return null;
  } catch { return targetName; }
  const encoded = source.slice(separator + 1);
  let selector: string;
  try { selector = decodeURIComponent(encoded); } catch { selector = encoded; }
  if (!validName(selector) || selector.startsWith("-")) throw new Error("Invalid source skill selector.");
  return selector;
}

/** Match the CLI's normalized JSON source against its full-URL lock source. */
function matchesStagedSource(entry: LockEntry, reported: string, requested: string): boolean {
  if (entry.source === reported || entry.sourceUrl === reported) return true;
  try {
    const source = new URL(requested);
    const staged = new URL(entry.sourceUrl);
    source.hash = "";
    return source.href === staged.href && staged.pathname.slice(1).replace(/\.git$/, "") === reported;
  } catch { return false; }
}
function stagedLockEntry(value: unknown, name: string): LockEntry | null {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.skills)) return null;
  const entry = value.skills[name];
  if (!isRecord(entry) || typeof entry.source !== "string" || typeof entry.sourceType !== "string"
    || typeof entry.sourceUrl !== "string" || typeof entry.installedAt !== "string" || typeof entry.updatedAt !== "string"
    || (entry.skillPath !== undefined && typeof entry.skillPath !== "string")
    || (entry.skillFolderHash !== undefined && typeof entry.skillFolderHash !== "string")
    || (entry.ref !== undefined && typeof entry.ref !== "string")) return null;
  return {
    source: entry.source, sourceType: entry.sourceType, sourceUrl: entry.sourceUrl,
    skillPath: typeof entry.skillPath === "string" ? entry.skillPath : "",
    skillFolderHash: typeof entry.skillFolderHash === "string" ? entry.skillFolderHash : "",
    installedAt: entry.installedAt, updatedAt: entry.updatedAt,
    ...(typeof entry.ref === "string" ? { ref: entry.ref } : {}),
  };
}

function explicitSourceEntry(source: string, localSource?: string): LockEntry {
  const now = new Date().toISOString();
  const hash = source.indexOf("#");
  const shorthand = SHORTHAND.test(hash < 0 ? source : source.slice(0, hash));
  const sourceUrl = localSource ?? (shorthand ? `https://github.com/${source.replace(/@[\w.-]+(?=#|$)/, "")}` : source);
  return {
    source: localSource ?? sourceUrl, sourceType: localSource ? "local" : "git", sourceUrl,
    skillPath: "", skillFolderHash: "", installedAt: now, updatedAt: now,
  };
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function addReviewFile(files: Map<string, string>, filename: string, content: string, bytes: number): number {
  if (CONTROL.test(filename) || filename.includes("\ufffd")
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    throw new Error(`Skill contains an unreviewable name or control sequence: ${filename}`);
  }
  bytes += Buffer.byteLength(content);
  if (bytes > MAX_REVIEW_BYTES || files.size >= 10_000 || files.has(filename)) throw new Error("Skill is too large or ambiguous to review safely.");
  files.set(filename, content);
  return bytes;
}

async function textFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let bytes = 0;
  for (const file of (await readSkillFiles(directory)).files) bytes = addReviewFile(files, file.path, file.content, bytes);
  return files;
}

/** Read only the selected subtree, checking its fingerprint before and after review. */
async function approvedTextFiles(approved: ApprovedSkillsRoot, name: string, destination: string): Promise<{ files: Map<string, string>; version: string }> {
  const version = await fingerprintSkill(approved, name, destination);
  const relativePath = path.relative(approved.path, destination);
  const entries = await listSkillPaths(approved.path, { relativePath, expectedRoot: approved, includeHidden: true });
  if (entries.length > 10_000) throw new Error("Skill has too many entries to review safely.");
  const files = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  for (const entry of entries) {
    if (path.isAbsolute(entry.path) || entry.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe path in skill listing.");
    if (entry.path.split("/").length > 50) throw new Error("Skill exceeds the review depth limit.");
    if (entry.kind === "symlink") throw new Error("Skill contains a symbolic link and cannot be reviewed safely.");
    if (entry.kind !== "file") continue;
    const value = await readSkillPath(approved.path, path.join(relativePath, entry.path), { expectedRoot: approved, maxBytes: MAX_REVIEW_BYTES - bytes });
    if (value.kind !== "file" || value.truncated) throw new Error("Skill exceeds the review byte limit or changed while reading.");
    bytes = addReviewFile(files, entry.path, decoder.decode(value.content), bytes);
  }
  if (await fingerprintSkill(approved, name, destination) !== version) throw new Error("Skill changed while preparing its review; retry.");
  return { files, version };
}

function reviewFiles(before: Map<string, string>, after: Map<string, string>): string {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const parts: string[] = [];
  for (const name of names) {
    const oldText = before.get(name);
    const newText = after.get(name);
    if (oldText === newText) continue;
    parts.push(`--- ${name} (${oldText === undefined ? "added" : newText === undefined ? "removed" : "changed"})`);
    if (oldText !== undefined) parts.push(`BEFORE:\n${oldText}`);
    if (newText !== undefined) parts.push(`AFTER:\n${newText}`);
  }
  const review = parts.join("\n");
  if (Buffer.byteLength(review) > MAX_REVIEW_BYTES) throw new Error("Complete change is too large to review safely.");
  return review || "No file content changes.";
}

async function cleanupWorkspace(item: Pending): Promise<void> {
  await removeDisposableTree(item.workspace, item.workspaceIdentity);
}

interface CliLock { version: number; skills: Record<string, unknown>; [key: string]: unknown }

function hasUnsafeLinkDiagnostic(stderr: string): boolean {
  return stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]+/)
    .some((line) => /^Skipping (?:broken symlink:|symlink that )/.test(line.trim()));
}

function parseCliLock(content: string): CliLock {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("The skills CLI lock is corrupt; it cannot safely be updated."); }
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.skills)) {
    throw new Error("The skills CLI lock has an unsupported format.");
  }
  return value as CliLock;
}

function parseCliSnapshot(snapshot: CliLockSnapshot): CliLock {
  return snapshot.identity === "missing" ? { version: 3, skills: {} } : parseCliLock(snapshot.content);
}

function assertOnlySelectedLockEntriesChanged(before: CliLock, after: CliLock, names: Set<string>, originalMissing: boolean): void {
  const { skills: beforeSkills, ...beforeRest } = before;
  const { skills: afterSkills, ...afterRest } = after;

  if (!originalMissing && !isDeepStrictEqual(beforeRest, afterRest)) throw new Error("The skills CLI changed unrelated lock data.");
  for (const key of new Set([...Object.keys(beforeSkills), ...Object.keys(afterSkills)])) {
    if (!names.has(key) && !isDeepStrictEqual(beforeSkills[key], afterSkills[key])) {
      throw new Error(`The skills CLI changed an unrelated lock entry: ${key}`);
    }
  }
}

export async function prepareSourceChange(approved: ApprovedSkillsRoot, source: string, target?: Skill, expected?: { ref?: string }): Promise<PreparedSkillChange> {
  await assertApprovedSkillsRoot(approved);
  const root = approved.path;
  const selected = target;
  if (selected) {
    const expectedPath = selected.enabled ? path.join(root, selected.name) : path.join(root, ".disabled_skills", selected.name);
    if (!validName(selected.name) || selected.orphaned || selected.entryKind !== "directory" || selected.path !== expectedPath
      || selected.id !== JSON.stringify([root, path.relative(root, expectedPath)])) {
      throw new Error("The selected skill no longer identifies a replaceable directory.");
    }
    await fingerprintSkill(approved, selected.name, expectedPath);
  }
  const resolvedSource = await sourceForSandbox(source);
  const lockSnapshot = resolvedSource.localSource ? undefined : await snapshotCliLock(await cliLockPath(root));
  const originalLock = lockSnapshot ? parseCliSnapshot(lockSnapshot) : undefined;
  // Fail before creating a workspace if the native safety boundary is unavailable.
  await assertApprovedSkillsRoot(approved);
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-upstream-")));
  let workspaceIdentity: string;
  try { workspaceIdentity = await directoryIdentity(workspace); }
  catch (error) {
    try { await rmdir(workspace); }
    catch (cleanup) { throw new Error(`Cannot identify temporary workspace; cleanup failed: ${String(cleanup)}`); }
    throw error;
  }
  const internal: Pending = { root: { ...approved }, workspace, workspaceIdentity, imports: [], consumed: false };
  try {
    await Promise.all(["home", "config", "cache", "data", "state", "tmp"].map((name) => mkdir(path.join(workspace, name))));
    if (lockSnapshot?.content) {
      await mkdir(path.join(workspace, "state", "skills"));
      await writeFile(path.join(workspace, "state", "skills", ".skill-lock.json"), lockSnapshot.content);
    }
    const args = ["add", resolvedSource.argument, "-g", "-y", "--agent", "codex", "--copy", "--json", "--full-depth"];
    const selector = selected ? replacementSkillArgument(source, selected.name, resolvedSource.localSource) : null;
    if (selector !== null) args.push("--skill", selector);
    const output = await runConfinedSkills(workspace, args, resolvedSource.localSource);
    if (hasUnsafeLinkDiagnostic(output.stderr)) {
      throw new Error("The confined installer skipped an unsafe source link.");
    }
    let result: unknown;
    try { result = JSON.parse(output.stdout); } catch { throw new Error("The installer returned invalid JSON."); }
    if (!Array.isArray(result) || result.length === 0 || result.some((item) => !isRecord(item) || item.status !== "installed" || typeof item.name !== "string" || typeof item.path !== "string" || typeof item.source !== "string")) {
      throw new Error("The installer did not produce a complete successful installation.");
    }
    if (selected && result.length !== 1) throw new Error("A replacement must produce exactly one staged skill.");
    const stagedRoot = path.join(workspace, "home", ".agents", "skills");
    const stagedFiles = await textFiles(stagedRoot);
    const stagedNames = new Set<string>();
    for (const filename of stagedFiles.keys()) {
      const separator = filename.indexOf("/");
      if (separator <= 0) throw new Error("Installer placed a file outside a staged skill.");
      stagedNames.add(filename.slice(0, separator));
    }
    if (stagedNames.size !== result.length) throw new Error("Installer results do not match the staged skills.");
    const stagedLockSnapshot = await snapshotCliLock(path.join(workspace, "state", "skills", ".skill-lock.json"));
    const lockText = stagedLockSnapshot.identity === "missing" ? undefined : stagedLockSnapshot.content;
    const stageLock = lockText === undefined ? null : parseCliLock(lockText);
    const changes: PreparedSkillChange["changes"] = [];
    const seen = new Set<string>();
    for (const item of result) {
      if (!isRecord(item) || typeof item.name !== "string" || typeof item.path !== "string" || typeof item.source !== "string") throw new Error("Invalid installer result.");
      const reported = item.path.replaceAll("\\", "/");
      const stagedName = path.posix.basename(reported);
      if (!validName(stagedName) || seen.has(stagedName) || !stagedNames.has(stagedName)) {
        throw new Error("Installer returned an unsafe or duplicate staged skill.");
      }
      seen.add(stagedName);
      const expectedReportedRoot = process.platform === "linux" ? "/workspace/home/.agents/skills" : stagedRoot;
      if (reported !== `${expectedReportedRoot}/${stagedName}`) throw new Error("Installer output escaped the staging directory.");
      const staged = path.join(stagedRoot, stagedName);
      const name = selected?.name ?? stagedName;
      if (lockSnapshot && item.name !== name) {
        throw new Error(`The CLI tracks this skill as "${item.name}", not "${name}". Add it under its normal name instead of replacing a differently named skill.`);
      }
      const destination = selected && !selected.enabled ? path.join(root, ".disabled_skills", name) : path.join(root, name);
      if (!selected && (await exists(path.join(root, name)) || await exists(path.join(root, ".disabled_skills", name)))) {
        throw new Error(`Destination already exists: ${destination}`);
      }
      const stagedVersion = await fingerprintTree(staged);
      const stagedContent = await fingerprintContents(staged);
      const after = await textFiles(staged);
      if (!after.has("SKILL.md")) throw new Error(`Staged skill has no SKILL.md: ${name}`);
      const original = selected ? await approvedTextFiles(approved, name, destination) : undefined;
      const expectedVersion = original?.version;
      const before = original?.files ?? new Map<string, string>();
      const priorReceipt = selected ? await matchUpstreamReceipt(root, destination, name, approved) : null;
      const review = reviewFiles(before, after);
      if (await fingerprintTree(staged) !== stagedVersion || (selected && await fingerprintSkill(approved, name, destination) !== expectedVersion)) {
        throw new Error("Skill changed while preparing its review; retry.");
      }
      let entry = stagedLockEntry(stageLock, item.name);
      const validStagedEntry = entry && validSourceEntry(entry) && matchesStagedSource(entry, item.source, source);
      if (expected && (!validStagedEntry || entry?.ref !== expected.ref)) {
        throw new Error("The staged source ref does not match the recorded ref.");
      }
      if (resolvedSource.localSource) {
        entry = { ...explicitSourceEntry(source, resolvedSource.localSource), skillPath: entry?.skillPath ?? "" };
      } else if (!validStagedEntry) {
        throw new Error("The skills CLI did not record the installed source in its lock.");
      }
      if (!entry || !validSourceEntry(entry)) throw new Error("The installer reported unsupported or unsafe source metadata.");
      if (priorReceipt?.entry.sourceUrl === entry.sourceUrl) entry.installedAt = priorReceipt.entry.installedAt;
      const historicalBaseline = selected ? priorReceipt?.historicalBaseline ?? "unknown" : "none";
      const rootIdentity = await physicalRootIdentity(approved);
      const metadata = JSON.stringify({ version: 2, root, rootIdentity, name, fingerprint: stagedContent, historicalBaseline, entry });
      internal.imports.push({ name, staged, stagedVersion, destination, expectedVersion, metadata });
      changes.push({ name, destination, enabled: selected?.enabled ?? true, files: [...after.keys()], action: selected ? "replace" : "install", review });
    }
    if (lockSnapshot && originalLock) {
      if (lockText === undefined || !stageLock) throw new Error("The skills CLI did not write its installation lock.");
      const updatedLock = parseCliLock(lockText);
      assertOnlySelectedLockEntriesChanged(originalLock, updatedLock, seen, lockSnapshot.identity === "missing");
      internal.cliLock = { snapshot: lockSnapshot, content: lockText };
    }
    const prepared: PreparedSkillChange = { kind: selected ? "update" : "add", skillsDir: root, source, changes, workspace };
    for (const change of changes) { Object.freeze(change.files); Object.freeze(change); }
    Object.freeze(changes);
    Object.freeze(prepared);
    pending.set(prepared, internal);
    return prepared;
  } catch (error) {
    try { await cleanupWorkspace(internal); }
    catch (cleanup) { throw new Error(`${error instanceof Error ? error.message : String(error)} Cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`); }
    throw error;
  }
}

export async function prepareAdd(root: ApprovedSkillsRoot, source: string): Promise<PreparedSkillChange> {
  return prepareSourceChange(root, source);
}

/** The CLI determines updates in a disposable workspace; only its artifacts are published. */
export async function prepareCliUpdates(approved: ApprovedSkillsRoot, skills: readonly Skill[]): Promise<PreparedSkillChange> {
  await assertApprovedSkillsRoot(approved);
  const snapshot = await snapshotCliLock(await cliLockPath(approved.path));
  const originalLock = parseCliSnapshot(snapshot);
  const failed: NonNullable<PreparedSkillChange["failed"]> = [];
  const selected: Array<{ skill: Skill; version: string; document: Buffer }> = [];
  const names = new Set<string>();
  for (const skill of skills) {
    try {
      const expectedPath = skill.enabled ? path.join(approved.path, skill.name) : path.join(approved.path, ".disabled_skills", skill.name);
      if (!validName(skill.name) || skill.name.startsWith("-") || skill.name.trim() !== skill.name
        || /[\u0080-\u009f]/.test(skill.name) || skill.orphaned || skill.entryKind !== "directory"
        || skill.path !== expectedPath || skill.id !== JSON.stringify([approved.path, path.relative(approved.path, expectedPath)])) {
        throw new Error("The selected skill no longer identifies a safe directory.");
      }
      if (names.has(skill.name.toLowerCase())) throw new Error("Multiple selected skill names are ambiguous to the CLI.");
      names.add(skill.name.toLowerCase());
      const entry = originalLock.skills[skill.name];
      const claim = await readExternalClaim(approved.path, skill.path, skill.name, approved);
      if (!isRecord(entry) || !claim || claim.sourceType === "local") {
        throw new Error("The skills CLI does not track this remote skill. Review a replacement to associate it.");
      }
      const comparable = { ...entry, skillPath: entry.skillPath === undefined ? "" : entry.skillPath,
        skillFolderHash: entry.skillFolderHash === undefined ? "" : entry.skillFolderHash };
      if (!skill.lockEntry || !isDeepStrictEqual(claim, skill.lockEntry) || !isDeepStrictEqual(comparable, claim)) {
        throw new Error("The saved source changed since selection. Refresh before updating.");
      }
      if (entry.installMode === "link") {
        throw new Error("The CLI link install mode cannot safely publish a temporary checkout.");
      }
      const version = await fingerprintSkill(approved, skill.name, skill.path);
      const document = await readSkillPath(approved.path, path.join(path.relative(approved.path, skill.path), "SKILL.md"),
        { expectedRoot: approved });
      if (document.kind !== "file" || document.truncated || await fingerprintSkill(approved, skill.name, skill.path) !== version) {
        throw new Error("The skill changed while preparing the CLI update.");
      }
      selected.push({ skill, version, document: document.content });
    } catch (error) {
      failed.push({ id: skill.id, name: skill.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  await assertApprovedSkillsRoot(approved);
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-update-")));
  let workspaceIdentity: string;
  try { workspaceIdentity = await directoryIdentity(workspace); }
  catch (error) {
    try { await rmdir(workspace); }
    catch (cleanup) { throw new Error(`Cannot identify temporary workspace; cleanup failed: ${String(cleanup)}`); }
    throw error;
  }
  const internal: Pending = { root: { ...approved }, workspace, workspaceIdentity, imports: [], consumed: false };
  try {
    await Promise.all(["home", "config", "cache", "data", "state", "tmp"].map((name) => mkdir(path.join(workspace, name))));
    const stagedRoot = path.join(workspace, "home", ".agents", "skills");
    await mkdir(stagedRoot, { recursive: true });
    await mkdir(path.join(workspace, "home", ".codex"));
    await mkdir(path.join(workspace, "state", "skills"));
    if (snapshot.content) await writeFile(path.join(workspace, "state", "skills", ".skill-lock.json"), snapshot.content);
    for (const { skill, document } of selected) {
      const staged = path.join(stagedRoot, skill.name);
      await mkdir(staged);
      await writeFile(path.join(staged, "SKILL.md"), document);
    }
    const confirmed = new Set<string>();
    if (selected.length) {
      const result = await runConfinedSkills(workspace, ["update", "-g", "-y", ...selected.map(({ skill }) => skill.name)]);
      const output = result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
      const errors = new Map<string, string>();
      const checkedSources = new Set<string>();
      let current: string | undefined;
      for (const line of output.split("\n").map((value) => value.trim())) {
        if (line.startsWith("Checking skills from source: ")) checkedSources.add(line.slice("Checking skills from source: ".length));
        if (line.startsWith("• ")) {
          const label = line.slice(2).split(" (", 1)[0];
          for (const { skill } of selected) {
            if (label === skill.name || label.split(", ").includes(skill.name)) errors.set(skill.name, line);
          }
        }
        const starting = selected.find(({ skill }) => line === `Updating ${skill.name}…`);
        if (starting) current = starting.skill.name;
        const cannotUpdate = selected.find(({ skill }) => line.startsWith(`✗ Cannot update ${skill.name}:`));
        if (cannotUpdate) {
          errors.set(cannotUpdate.skill.name, line.replace(/^✗\s*/, ""));
        } else if (line.startsWith("✗ Failed to check skills from ")) {
          const source = line.slice("✗ Failed to check skills from ".length);
          for (const { skill } of selected) {
            const entry = skill.lockEntry;
            if (entry?.source === source || (isRecord(entry) && entry.sourceBaseUrl === source)) errors.set(skill.name, line);
          }
        } else if (current && /^✗\s/.test(line)) {
          errors.set(current, line.replace(/^✗\s*/, ""));
        }
        for (const { skill } of selected) if (line === `✓ Updated ${skill.name}`) confirmed.add(skill.name);
      }
      if (hasUnsafeLinkDiagnostic(result.stderr)) {
        for (const { skill } of selected) errors.set(skill.name, "The CLI skipped an unsafe source link.");
      }
      const batchFinished = output.includes("All global skills are up to date")
        || /^✓ Updated [1-9]\d* skill\(s\)\s*$/m.test(output);
      for (const { skill } of selected) {
        const reason = errors.get(skill.name);
        const entry = skill.lockEntry;
        const checked = !!entry && (checkedSources.has(entry.source)
          || (isRecord(entry) && typeof entry.sourceBaseUrl === "string" && checkedSources.has(entry.sourceBaseUrl)));
        if (reason || (!confirmed.has(skill.name) && !(batchFinished && checked))) {
          confirmed.delete(skill.name);
          failed.push({ id: skill.id, name: skill.name, reason: reason ?? "The skills CLI did not confirm whether this skill was updated or current." });
        }
      }
    }
    for (const item of await readdir(stagedRoot)) {
      if (!selected.some(({ skill }) => skill.name === item)) throw new Error(`The skills CLI wrote an unselected destination: ${item}`);
    }
    const changes: PreparedSkillChange["changes"] = [];
    if (confirmed.size) {
      const generatedSnapshot = await snapshotCliLock(path.join(workspace, "state", "skills", ".skill-lock.json"));
      if (generatedSnapshot.identity === "missing") throw new Error("The skills CLI did not write its update lock.");
      const lockText = generatedSnapshot.content;
      const generated = parseCliLock(lockText);
      assertOnlySelectedLockEntriesChanged(originalLock, generated, confirmed, snapshot.identity === "missing");
      for (const { skill, version } of selected) {
        if (!confirmed.has(skill.name)) continue;
        if (!isRecord(generated.skills[skill.name])) throw new Error(`The CLI did not track the updated skill: ${skill.name}`);
        const staged = path.join(stagedRoot, skill.name);
        const stagedVersion = await fingerprintTree(staged);
        const entries = await listSkillPaths(staged, { includeHidden: true });
        if (!entries.some((entry) => entry.path === "SKILL.md" && entry.kind === "file")
          || entries.some((entry) => entry.kind === "symlink")) throw new Error(`The CLI produced an unsafe skill: ${skill.name}`);
        if (await fingerprintTree(staged) !== stagedVersion || await fingerprintSkill(approved, skill.name, skill.path) !== version) {
          throw new Error("The skill changed while preparing the CLI update.");
        }
        internal.imports.push({ name: skill.name, staged, stagedVersion, destination: skill.path, expectedVersion: version });
        changes.push({ name: skill.name, destination: skill.path, enabled: skill.enabled,
          files: entries.filter((entry) => entry.kind === "file").map((entry) => entry.path), action: "replace", review: "" });
      }
      internal.cliLock = { snapshot, content: lockText };
    }
    const source = selected.length === 1 ? selected[0].skill.lockEntry!.sourceUrl : "multiple sources";
    const prepared: PreparedSkillChange = { kind: "update", skillsDir: approved.path, source, changes, failed, workspace };
    for (const change of changes) { Object.freeze(change.files); Object.freeze(change); }
    for (const failure of failed) Object.freeze(failure);
    Object.freeze(changes);
    Object.freeze(failed);
    Object.freeze(prepared);
    pending.set(prepared, internal);
    return prepared;
  } catch (error) {
    try { await cleanupWorkspace(internal); }
    catch (cleanup) { throw new Error(`${error instanceof Error ? `${error.message} ` : String(error)}Cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`); }
    throw error;
  }
}


/** Applies only the prepared and explicitly approved content, with a recoverable per-skill journal. */
export async function applyPreparedChange(change: PreparedSkillChange): Promise<void> {
  const item = pending.get(change);
  if (!item || item.consumed) throw new Error("Prepared change is unavailable or has already been consumed.");
  item.consumed = true;
  let failure: unknown;
  const applied: string[] = [];
  try {
    await withSkillsLock(item.root, async () => {
      if (item.cliLock) {
        const current = await snapshotCliLock(item.cliLock.snapshot.path);
        if (!isDeepStrictEqual(current, item.cliLock.snapshot)) throw new Error("The skills CLI lock changed since preparation.");
      }
      for (const entry of item.imports) {
        if (await fingerprintTree(entry.staged) !== entry.stagedVersion) throw new Error(`Staged skill changed after review: ${entry.name}`);
        if (entry.expectedVersion !== undefined) {
          if (await fingerprintSkill(item.root, entry.name, entry.destination) !== entry.expectedVersion) throw new Error(`Existing skill changed after review: ${entry.destination}`);
        } else if (await exists(path.join(item.root.path, entry.name)) || await exists(path.join(item.root.path, ".disabled_skills", entry.name))) {
          throw new Error(`Destination already exists: ${entry.destination}`);
        }
      }
      for (const entry of item.imports) {
        await importSkill(item.root, entry.name, entry.staged, {
          replace: entry.expectedVersion !== undefined, expectedPath: entry.expectedVersion === undefined ? undefined : entry.destination,
          expectedVersion: entry.expectedVersion, expectedStagedVersion: entry.stagedVersion, metadata: entry.metadata,
        });
        applied.push(entry.destination);
      }
      if (item.cliLock) await publishCliLock(item.cliLock.snapshot, item.cliLock.content);
    });
  } catch (error) { failure = error; }
  try {
    await cleanupWorkspace(item);
    pending.delete(change);
  } catch (error) {
    failure = new Error(`${failure instanceof Error ? `${failure.message} ` : ""}Temporary workspace cleanup failed at ${item.workspace}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failure) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}${applied.length ? ` Already applied: ${applied.join(", ")}` : ""}`);
}

export async function discardPreparedChange(change: PreparedSkillChange): Promise<void> {
  const item = pending.get(change);
  if (!item) return;
  await cleanupWorkspace(item);
  pending.delete(change);
}
