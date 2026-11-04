import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { countSkillPathLines, listSkillPaths, readSkillPath } from "../actions/boundary.js";
import { parseSkillDocument } from "./frontmatter.js";
import { declaredAuthors } from "./provenance.js";
import { listOrphanedReceipts, matchUpstreamReceipt, readExternalClaim } from "./upstreamProvenance.js";
import { hasErrorCode } from "./validation.js";
import type { ParsedSkillDocument } from "./frontmatter.js";
import type { LockEntry, Skill, SkillFile } from "./types.js";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const PREVIEW_TRUNCATED = "\n\n[Preview truncated after 1 MiB.]";

export interface SkillsRepoPaths {
  root: string;
  skillsDir: string;
  disabledDir: string;
  lockFile: string;
}

export function resolvePaths(skillsDir: string): SkillsRepoPaths {
  if (skillsDir === "" || skillsDir.includes("\0")) throw new Error("A valid skills directory is required.");
  const root = path.resolve(skillsDir);
  return {
    root,
    skillsDir: root,
    disabledDir: path.join(root, ".disabled_skills"),
    lockFile: path.join(path.dirname(root), ".skill-lock.json"),
  };
}

async function readFrontmatter(skillDir: string): Promise<ParsedSkillDocument> {
  try {
    const file = await readSkillPath(await realpath(skillDir), "SKILL.md", { maxBytes: 64 * 1024 + 4096 });
    if (file.kind === "symlink") {
      return { frontmatter: null, text: "", warnings: [`SKILL.md is a symbolic link: ${file.content.toString("utf8")}`] };
    }
    const parsed = parseSkillDocument(file.content.toString("utf8"));
    if (file.size > MAX_PREVIEW_BYTES) parsed.warnings.push("Preview will be truncated after 1 MiB.");
    return parsed;
  } catch (error) {
    return { frontmatter: null, text: "", warnings: [`Cannot read SKILL.md: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function previewText(file: { kind: "file" | "symlink"; content: Buffer; truncated: boolean }): string {
  const text = file.content.toString("utf8");
  if (file.kind === "symlink") return `[Symbolic link: ${text}]`;
  return file.truncated ? text + PREVIEW_TRUNCATED : text;
}

export async function readSkillSource(skillPath: string): Promise<string> {
  if (skillPath === "") return "";

  const file = await readSkillPath(await realpath(skillPath), "SKILL.md", { maxBytes: MAX_PREVIEW_BYTES });
  return previewText(file);
}

export async function readSkillText(skillPath: string): Promise<string> {
  if (skillPath === "") return "";

  const file = await readSkillPath(await realpath(skillPath), "SKILL.md", { maxBytes: MAX_PREVIEW_BYTES });
  if (file.kind === "symlink") return previewText(file);
  const text = parseSkillDocument(file.content.toString("utf8")).text;
  return file.truncated ? text + PREVIEW_TRUNCATED : text;
}

export async function listSkillFiles(skillPath: string): Promise<SkillFile[]> {
  if (skillPath === "") return [];

  const entries = (await listSkillPaths(await realpath(skillPath))).filter((entry) =>
    entry.path.split(path.sep).every((part) => !part.startsWith(".") && part !== "__pycache__")
  );
  const nonemptyDirectories = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "directory") continue;
    let parent = path.dirname(entry.path);
    while (parent !== ".") {
      nonemptyDirectories.add(parent);
      parent = path.dirname(parent);
    }
  }
  const files: SkillFile[] = entries
    .filter((entry) => entry.kind !== "directory" || nonemptyDirectories.has(entry.path))
    .map((entry): SkillFile => ({
      path: entry.path,
      depth: entry.path.split(path.sep).length - 1,
      kind: entry.kind === "directory" ? "directory" : "file",
    }));
  files.sort((left, right) => {
    const a = left.path.split(path.sep);
    const b = right.path.split(path.sep);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      const aDirectory = i < a.length - 1 || left.kind === "directory";
      const bDirectory = i < b.length - 1 || right.kind === "directory";
      if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
      return a[i].localeCompare(b[i]);
    }
    return a.length - b.length;
  });
  return files;
}

function requireRelativeFilePath(filePath: string): void {
  if (filePath === "" || path.isAbsolute(filePath) || filePath.includes("\0")
    || filePath.split(path.sep).some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("A valid relative skill file path is required.");
  }
}

export async function readSkillFile(skillPath: string, filePath: string): Promise<string> {
  if (skillPath === "") return "";
  requireRelativeFilePath(filePath);
  const file = await readSkillPath(await realpath(skillPath), filePath, { maxBytes: MAX_PREVIEW_BYTES });
  return previewText(file);
}

/** Count the entire selected file without allocating its contents. */
export async function countSkillFileLines(skillPath: string, filePath: string): Promise<number> {
  if (skillPath === "") throw new Error("A skill directory is required.");
  requireRelativeFilePath(filePath);
  return countSkillPathLines(await realpath(skillPath), filePath);
}

export async function scanSkills(skillsDir: string): Promise<Skill[]> {
  const paths = resolvePaths(skillsDir);
  let installation: string;
  try {
    installation = await realpath(paths.root);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      try {
        if ((await lstat(paths.root)).isSymbolicLink()) throw new Error(`Selected skills directory is a broken symbolic link: ${paths.root}`);
      } catch (rootError) {
        if (hasErrorCode(rootError, "ENOENT")) return [];
        throw rootError;
      }
    }
    throw error;
  }

  const skills: Skill[] = [];
  const unknownHistory = new Set<string>();
  const reservedNames = [".git", ".disabled_skills", ".skills-manager"];
  const reservedIdentities: Array<{ dev: bigint; ino: bigint }> = [];
  for (const name of reservedNames) {
    try {
      reservedIdentities.push(await lstat(path.join(paths.root, name), { bigint: true }));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }
  const scanDirectory = async (directory: string, enabled: boolean): Promise<void> => {
    let entries;
    try {
      if (!enabled) {
        const info = await lstat(directory);
        if (!info.isDirectory()) throw new Error(`Disabled skills path is not a directory: ${directory}`);
      }
      entries = await readdir(directory, { encoding: "buffer" });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }
    for (const rawName of entries) {
      const name = rawName.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(rawName)) {
        throw new Error(`Cannot scan ${directory}: a filename is not valid UTF-8 (bytes: ${rawName.toString("hex")}). Rename it using a valid UTF-8 name before scanning.`);
      }
      if (reservedNames.includes(name.toLowerCase())) continue;
      const skillPath = path.join(directory, name);
      let info;
      try {
        info = await lstat(skillPath, { bigint: true });
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      if (reservedIdentities.some((reserved) => reserved.dev === info.dev && reserved.ino === info.ino)) continue;
      if (!info.isDirectory() && !info.isSymbolicLink()) continue;

      let entryKind: Skill["entryKind"] = "directory";
      let linkTarget: string | null = null;
      let entryWarning: string | null = null;
      if (info.isSymbolicLink()) {
        entryKind = "symlink";
        try {
          linkTarget = await readlink(skillPath);
          await stat(skillPath);
        } catch (error) {
          if (linkTarget !== null && (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR") || hasErrorCode(error, "ELOOP"))) {
            entryKind = "broken-symlink";
          } else {
            entryWarning = `Cannot inspect symbolic link: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      } else {
        try {
          await lstat(path.join(skillPath, "SKILL.md"));
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) continue;
          entryWarning = `Cannot inspect SKILL.md: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      const parsed = entryWarning
        ? { frontmatter: null, text: "", warnings: [entryWarning] }
        : entryKind === "broken-symlink"
          ? { frontmatter: null, text: "", warnings: ["Broken symbolic link."] }
          : await readFrontmatter(skillPath);
      let lockEntry: LockEntry | null = null;
      let recordedSource: LockEntry | null = null;
      if (entryKind === "directory") {
        try {
          const [receipt, claim] = await Promise.all([
            matchUpstreamReceipt(paths.root, skillPath, name),
            readExternalClaim(paths.root, skillPath, name),
          ]);
          lockEntry = receipt?.entry ?? null;
          recordedSource = claim;
          if (receipt?.historicalBaseline === "unknown") unknownHistory.add(skillPath);
        } catch {
          parsed.warnings.push("Source metadata could not be inspected.");
        }
      }
      skills.push({
        id: JSON.stringify([installation, path.relative(paths.root, skillPath)]),
        name,
        enabled,
        orphaned: false,
        path: skillPath,
        entryKind,
        linkTarget,
        warnings: parsed.warnings,
        authors: declaredAuthors(parsed.frontmatter),
        frontmatter: parsed.frontmatter,
        lockEntry,
        recordedSource,
        provenance: lockEntry
          ? lockEntry.sourceType === "local"
            ? { kind: "local" }
            : { kind: "source", source: lockEntry.source, sourceUrl: lockEntry.sourceUrl }
          : { kind: "unknown" },
      });
    }
  };

  await scanDirectory(paths.skillsDir, true);
  await scanDirectory(paths.disabledDir, false);
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  for (const skill of skills) {
    if (counts.get(skill.name) === 1) {
      if (unknownHistory.has(skill.path)) {
        skill.warnings.push("Prior installed content and ownership were unknown before the reviewed replacement.");
      }
      continue;
    }
    skill.lockEntry = null;
    skill.recordedSource = null;
    skill.provenance = { kind: "unknown" };
    skill.warnings.push("Multiple entries share this name; source association is ambiguous.");
  }
  try {
    for (const receipt of await listOrphanedReceipts(paths.root)) {
      skills.push({
        id: JSON.stringify([installation, receipt.name]),
        name: receipt.name,
        enabled: false,
        orphaned: true,
        path: "",
        entryKind: "orphaned",
        linkTarget: null,
        warnings: ["Recorded import has no installed skill; its source and current ownership are unknown."],
        authors: [],
        frontmatter: null,
        lockEntry: null,
        recordedSource: receipt.entry,
        provenance: { kind: "unknown" },
      });
    }
  } catch (error) {
    if (skills.length === 0) throw error;
    const warning = `Controlled state could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
    for (const skill of skills) skill.warnings.push(warning);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || Number(b.enabled) - Number(a.enabled));
  return skills;
}
