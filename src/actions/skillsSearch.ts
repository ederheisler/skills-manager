import { mkdir, mkdtemp, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { directoryIdentity, removeDisposableTree } from "./boundary.js";
import { runConfinedSkills } from "./sandbox.js";

export interface SkillSearchResult {
  identifier: string;
  repository: string;
  skill: string;
  installs: string;
  url: string | null;
}

type SearchRunner = (workspace: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

// skills 1.7.6 prints a header, followed by identifier/count and URL line pairs.
function parseSearchOutput(stdout: string, stderr: string, query: string): SkillSearchResult[] {
  const [output, errors] = [stdout, stderr].map((text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
  if (errors.trim()) throw new Error("The skills CLI returned unexpected search output.");
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  const logo = [
    "███████╗██╗  ██╗██╗██╗     ██╗     ███████╗",
    "██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝",
    "███████╗█████╔╝ ██║██║     ██║     ███████╗",
    "╚════██║██╔═██╗ ██║██║     ██║     ╚════██║",
    "███████║██║  ██╗██║███████╗███████╗███████║",
    "╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝",
  ];
  if (logo.every((line, index) => lines[index] === line)) lines.splice(0, logo.length);
  if (lines.length === 1 && lines[0] === `No skills found for "${query}"`) return [];
  if (lines[0] !== "Install with npx skills add <owner/repo@skill>" || lines.length < 3 || lines.length % 2 !== 1) {
    throw new Error("The skills CLI returned unexpected search output.");
  }
  const results: SkillSearchResult[] = [];
  for (let index = 1; index < lines.length; index += 2) {
    const row = /^([\w.-]+(?:\/[\w.-]+)*)@([\w.-]+)(?: (\d+(?:\.\d)?[KM]?) (?:installs|install))?$/.exec(lines[index]);
    const link = /^└ https:\/\/skills\.sh\/([\w./-]+)$/.exec(lines[index + 1]);
    if (!row || !link || [...row[1].split("/"), row[2], ...link[1].split("/")].some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === ".." || part === ".git")) {
      throw new Error("The skills CLI returned an invalid search result.");
    }
    const repository = row[1];
    results.push({ identifier: `${repository}@${row[2]}`, repository, skill: row[2], installs: row[3] ?? "0", url: `https://skills.sh/${link[1]}` });
  }
  return results;
}

export async function findSkills(query: string, run: SearchRunner = runConfinedSkills): Promise<SkillSearchResult[]> {
  if (!query.trim() || query.startsWith("-") || /[\p{Cc}\p{Cf}]/u.test(query)) {
    throw new Error("Enter a search query without control characters or a leading hyphen.");
  }
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-search-")));
  let identity: string;
  try { identity = await directoryIdentity(workspace); }
  catch (error) {
    try { await rmdir(workspace); } catch (cleanup) { throw new Error(`Cannot identify search workspace; cleanup failed: ${String(cleanup)}`); }
    throw error;
  }
  try {
    await Promise.all(["home", "config", "cache", "data", "state", "tmp"].map((name) => mkdir(path.join(workspace, name))));
    const { stdout, stderr } = await run(workspace, ["find", query]);
    return parseSearchOutput(stdout, stderr, query);
  } finally {
    await removeDisposableTree(workspace, identity);
  }
}
