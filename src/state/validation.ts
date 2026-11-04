import type { LockEntry, SkillFrontmatter, SkillLockFile } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

export function isLockEntry(value: unknown): value is LockEntry {
  return isRecord(value)
    && hasString(value, "source")
    && hasString(value, "sourceType")
    && hasString(value, "sourceUrl")
    && hasString(value, "skillPath")
    && hasString(value, "skillFolderHash")
    && hasString(value, "installedAt")
    && hasString(value, "updatedAt")
    && (value.ref === undefined || typeof value.ref === "string");
}


export function parseSkillLockFile(value: unknown): SkillLockFile | null {
  if (!isRecord(value) || typeof value.version !== "number" || !isRecord(value.skills)) return null;

  const skills: Record<string, LockEntry> = Object.create(null);
  for (const [name, entry] of Object.entries(value.skills)) {
    if (!isLockEntry(entry)) return null;
    skills[name] = entry;
  }
  return { version: value.version, skills };
}

export function isSkillFrontmatter(value: unknown): value is SkillFrontmatter {
  if (!isRecord(value)) return false;
  return (value.name === undefined || typeof value.name === "string")
    && (value.description === undefined || typeof value.description === "string")
    && (value.version === undefined || typeof value.version === "string")
    && (value.license === undefined || typeof value.license === "string")
    && (value.metadata === undefined || isRecord(value.metadata));
}
