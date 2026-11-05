import type { LockEntry, Skill } from "../state/types.js";
import { isRecord } from "../state/validation.js";
import { validSourceEntry } from "../state/upstreamProvenance.js";

interface GitHubTreeEntry {
  path: string;
  type: string;
  sha: string;
}

interface GitHubTree {
  sha?: string;
  tree: GitHubTreeEntry[];
  truncated?: boolean;
}

export interface UpdateCheckReport {
  updated: string[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
}

type TreeFetcher = (repository: string, ref: string) => Promise<unknown>;

function isGitHubTree(value: unknown): value is GitHubTree {
  return isRecord(value) && Array.isArray(value.tree)
    && value.tree.every((item: unknown) => isRecord(item) && typeof item.path === "string"
      && typeof item.type === "string" && typeof item.sha === "string")
    && (value.sha === undefined || typeof value.sha === "string")
    && (value.truncated === undefined || typeof value.truncated === "boolean");
}

function githubRepository(entry: LockEntry): string | null {
  return entry.sourceType === "github" && validSourceEntry(entry) ? entry.source : null;
}

function skillDirectory(entry: LockEntry): string | null {
  const value = entry.skillPath.replace(/\\/g, "/");
  if (value.startsWith("/") || value.split("/").some((part) => part === ".." || part === ".")) return null;
  return value.replace(/\/?SKILL\.md$/i, "").replace(/\/$/, "");
}

async function fetchGitHubTree(repository: string, ref: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "skills-manager" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Upstream check timed out.");
    }
    throw new Error("Upstream check failed; network or remote service unavailable.");
  }
  if (!response.ok) throw new Error(`Upstream check failed (HTTP ${response.status}).`);
  try { return await response.json(); } catch { throw new Error("Upstream returned invalid JSON."); }
}

/** Network checks are explicit; a failed or unsupported check is not an up-to-date result. */
export async function checkForUpdates(skills: readonly Skill[], fetchTree: TreeFetcher = fetchGitHubTree): Promise<UpdateCheckReport> {
  const report: UpdateCheckReport = { updated: [], unavailable: [] };
  const groups = new Map<string, Array<{ skill: Skill; entry: LockEntry; directory: string }>>();
  for (const skill of skills) {
    const unavailable = (reason: string) => report.unavailable.push({ id: skill.id, name: skill.name, reason });
    if (!skill.lockEntry || skill.provenance.kind !== "source") {
      unavailable("No matching saved source association; update checks are unavailable.");
      continue;
    }
    const entry = skill.lockEntry;
    const repository = githubRepository(entry);
    if (!repository) {
      unavailable("Update checks are not supported for this source.");
      continue;
    }
    const directory = skillDirectory(entry);
    if (directory === null || !entry.skillPath || !/^[a-f0-9]{40}$/i.test(entry.skillFolderHash)) {
      unavailable("No verifiable upstream content baseline is recorded.");
      continue;
    }
    const key = `${repository}\u0000${entry.ref ?? "HEAD"}`;
    const group = groups.get(key) ?? [];
    group.push({ skill, entry, directory });
    groups.set(key, group);
  }

  await Promise.all(Array.from(groups, async ([key, group]) => {
    const [repository, ref] = key.split("\u0000");
    let tree: GitHubTree;
    try {
      const value = await fetchTree(repository, ref);
      if (!isGitHubTree(value)) throw new Error("Upstream returned an invalid tree.");
      if (value.truncated) throw new Error("Upstream tree is incomplete; update status is unknown.");
      tree = value;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Upstream check failed.";
      for (const { skill } of group) report.unavailable.push({ id: skill.id, name: skill.name, reason });
      return;
    }
    for (const { skill, entry, directory } of group) {
      const hash = directory === "" ? tree.sha : tree.tree.find((item) => item.type === "tree" && item.path === directory)?.sha;
      if (!hash) report.unavailable.push({ id: skill.id, name: skill.name, reason: "Skill folder was not found in the upstream tree." });
      else if (hash.toLowerCase() !== entry.skillFolderHash.toLowerCase()) report.updated.push(skill.id);
    }
  }));
  return report;
}
