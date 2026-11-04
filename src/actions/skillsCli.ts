import { lstat, mkdir, mkdtemp, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertApprovedSkillsRoot, directoryIdentity, fingerprintContents, fingerprintSkill, fingerprintTree, importSkill, listSkillPaths, readSkillFiles, readSkillPath, removeDisposableTree, withSkillsLock, type ApprovedSkillsRoot } from "./boundary.js";
import { runConfinedSkills } from "./sandbox.js";
import type { LockEntry, Skill } from "../state/types.js";
import { isRecord } from "../state/validation.js";
import { matchUpstreamReceipt, physicalRootIdentity, validSourceEntry } from "../state/upstreamProvenance.js";

export interface SkillSearchResult {
  identifier: string;
  repository: string;
  skill: string;
  installs: string;
  url: string | null;
}

export interface PreparedSkillChange {
  kind: "add" | "update";
  skillsDir: string;
  source: string;
  changes: Array<{ name: string; destination: string; enabled: boolean; files: string[]; action: "install" | "replace"; review: string }>;
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

function installations(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

/** Uses the CLI's documented search endpoint directly: the CLI itself hides network failures. */
export async function findSkills(query: string, endpoint = "https://skills.sh/api/search"): Promise<SkillSearchResult[]> {
  if (!query.trim() || CONTROL.test(query)) throw new Error("Enter a search query without control characters.");
  const url = new URL(endpoint);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("Invalid search endpoint.");
  url.searchParams.set("q", query);
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }); }
  catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("Skill search timed out.");
    throw new Error("Skill search failed; network or remote service unavailable.");
  }
  if (!response.ok) throw new Error(`Skill search failed (HTTP ${response.status}).`);
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("Skill search returned invalid JSON."); }
  if (!isRecord(value) || !Array.isArray(value.skills)) throw new Error("Skill search returned an invalid result.");
  return value.skills.map((item: unknown) => {
    if (!isRecord(item) || typeof item.source !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(item.source)
      || typeof item.name !== "string" || !validName(item.name) || typeof item.id !== "string"
      || !/^[\w./-]+$/.test(item.id) || typeof item.installs !== "number" || !Number.isSafeInteger(item.installs) || item.installs < 0) {
      throw new Error("Skill search returned an invalid result.");
    }
    return { identifier: `${item.source}@${item.name}`, repository: item.source, skill: item.name,
      installs: installations(item.installs), url: `https://skills.sh/${item.id}` };
  });
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
    const args = ["add", resolvedSource.argument, "-g", "-y", "--agent", "codex", "--copy", "--json", "--full-depth"];
    const selector = selected ? replacementSkillArgument(source, selected.name, resolvedSource.localSource) : null;
    if (selector !== null) args.push("--skill", selector);
    const output = await runConfinedSkills(workspace, args, resolvedSource.localSource);
    if (/\b(?:failed|skipping (?:broken )?symlink)\b/i.test(output.stderr)) {
      throw new Error("The confined installer reported a failure or skipped an unsafe source link.");
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
    const stateFiles = await textFiles(path.join(workspace, "state"));
    const lockText = stateFiles.get("skills/.skill-lock.json");
    let stageLock: unknown = null;
    if (lockText !== undefined) {
      try { stageLock = JSON.parse(lockText); }
      catch { throw new Error("The installer wrote invalid source metadata."); }
      if (!isRecord(stageLock) || stageLock.version !== 3 || !isRecord(stageLock.skills)) {
        throw new Error("The installer wrote unsupported source metadata.");
      }
    }
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
        entry = explicitSourceEntry(source);
      }
      if (!entry || !validSourceEntry(entry)) throw new Error("The installer reported unsupported or unsafe source metadata.");
      if (priorReceipt?.entry.sourceUrl === entry.sourceUrl) entry.installedAt = priorReceipt.entry.installedAt;
      const historicalBaseline = selected ? priorReceipt?.historicalBaseline ?? "unknown" : "none";
      const rootIdentity = await physicalRootIdentity(approved);
      const metadata = JSON.stringify({ version: 2, root, rootIdentity, name, fingerprint: stagedContent, historicalBaseline, entry });
      internal.imports.push({ name, staged, stagedVersion, destination, expectedVersion, metadata });
      changes.push({ name, destination, enabled: selected?.enabled ?? true, files: [...after.keys()], action: selected ? "replace" : "install", review });
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


/** Applies only the prepared and explicitly approved content, with a recoverable per-skill journal. */
export async function applyPreparedChange(change: PreparedSkillChange): Promise<void> {
  const item = pending.get(change);
  if (!item || item.consumed) throw new Error("Prepared change is unavailable or has already been consumed.");
  item.consumed = true;
  let failure: unknown;
  const applied: string[] = [];
  try {
    await withSkillsLock(item.root, async () => {
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
