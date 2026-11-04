export interface LockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
  ref?: string;
}

export interface SkillLockFile {
  version: number;
  skills: Record<string, LockEntry>;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  author?: unknown;
  authors?: unknown;
  version?: string;
  license?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type Provenance =
  | { kind: "source"; source: string; sourceUrl: string }
  | { kind: "local" }
  | { kind: "unknown" };

export interface SkillFile {
  path: string;
  depth: number;
  kind: "directory" | "file";
}

export interface Skill {
  /** Stable across aliases of the same installation; distinct for each relative entry path. */
  id: string;
  name: string;
  enabled: boolean;
  /** True for a controlled import record whose skill entry is missing. */
  orphaned: boolean;
  /** Absolute path to the skill folder. Empty string when orphaned. */
  path: string;
  entryKind: "directory" | "symlink" | "broken-symlink" | "orphaned";
  /** The unmodified link text, not the resolved target. */
  linkTarget: string | null;
  warnings: string[];
  /** Names declared in frontmatter, never a claim of ownership. */
  authors: string[];
  frontmatter: SkillFrontmatter | null;
  lockEntry: LockEntry | null;
  /** Unauthenticated external claim or stale orphan receipt, never proof of origin. */
  recordedSource: LockEntry | null;
  provenance: Provenance;
}
