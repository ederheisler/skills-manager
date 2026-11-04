import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { approveSkillsRoot, type ApprovedSkillsRoot } from "./actions/boundary.js";
import { escapeTerminalSingleLine, quoteTerminalPath } from "./terminalText.js";

export interface OnboardingIO {
  ask(prompt: string): Promise<string | null>;
  write(message: string): void;
}

export interface DirectoryCandidate {
  label: string;
  path: string;
}

export interface DirectorySelectionOptions {
  home?: string;
  cwd?: string;
  explicitSkillsDir?: string;
  currentSkillsDir?: string;
}

export type SkillsRootSelection = ApprovedSkillsRoot | { path: string; identity: null };

export interface SkillsOnboardingResult {
  root: SkillsRootSelection;
  reviewInitialize: boolean;
  reviewBackup: boolean;
}

export interface InspectedSkillsDirectory {
  selectedPath: string;
  skillsDir: string;
  missing: boolean;
  linkTarget: string | null;
}

// Listing candidates is deliberately independent of the filesystem: only the
// user's selected directory is inspected.
export function documentedSkillsDirectories(home = homedir()): DirectoryCandidate[] {
  const prefix = home.replace(/\/+$/, "");
  return [
    { label: "Codex / Cursor / OpenCode (default)", path: `${prefix}/.agents/skills` },
    { label: "Claude Code / OpenCode", path: `${prefix}/.claude/skills` },
    { label: "Cursor", path: `${prefix}/.cursor/skills` },
    { label: "OpenCode", path: `${prefix}/.config/opencode/skills` },
    { label: "Amp / Replit / Universal installer destination", path: `${prefix}/.config/agents/skills` },
  ];
}

export function resolveSkillsDirectory(input: string, home = homedir(), cwd = process.cwd()): string {
  if (input === "~") return home;
  if (path.isAbsolute(input)) return input;
  const usesHome = input.startsWith("~/");
  const base = usesHome ? home : cwd;
  const relative = usesHome ? input.slice(2) : input;
  // Do not normalize ".." before the filesystem resolves any symlinks.
  return `${base.replace(/\/+$/, "")}/${relative}`;
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

// For a missing directory, resolve its existing ancestor without creating any
// part of the path. This also prevents an approved ancestor link from later
// redirecting a mutation merely by being retargeted.
async function resolveMissingDirectory(selectedPath: string): Promise<string> {
  const components: string[] = [];
  let ancestor = selectedPath;
  for (;;) {
    try {
      const entry = await lstat(ancestor);
      const resolved = await realpath(ancestor);
      const resolvedEntry = entry.isSymbolicLink() ? await stat(resolved) : entry;
      if (!resolvedEntry.isDirectory()) throw new Error(`Not a directory: ${quoteTerminalPath(ancestor)}`);
      return path.join(resolved, ...components);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A dangling ancestor symlink is not a missing directory we can adopt.
      try {
        const entry = await lstat(ancestor);
        if (entry.isSymbolicLink()) {
          const target = await readlink(ancestor);
          throw new Error(`Broken or inaccessible link: ${quoteTerminalPath(ancestor)} -> ${quoteTerminalPath(target)}`);
        }
      } catch (entryError) {
        if (!isMissing(entryError)) throw entryError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      components.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function inspectSelectedSkillsDirectory(selectedPath: string): Promise<InspectedSkillsDirectory> {
  const absolutePath = resolveSkillsDirectory(selectedPath);
  let entry;
  try {
    entry = await lstat(absolutePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (absolutePath.split(path.sep).includes("..")) {
      throw new Error(`Cannot select a missing directory containing '..': ${quoteTerminalPath(absolutePath)}`);
    }
    return {
      selectedPath: absolutePath,
      skillsDir: await resolveMissingDirectory(absolutePath),
      missing: true,
      linkTarget: null,
    };
  }

  const linkTarget = entry.isSymbolicLink() ? await readlink(absolutePath) : null;
  let resolved: string;
  try {
    resolved = await realpath(absolutePath);
  } catch (error) {
    if (linkTarget !== null) {
      throw new Error(`Broken or inaccessible link: ${quoteTerminalPath(absolutePath)} -> ${quoteTerminalPath(linkTarget)} (${error instanceof Error ? error.message : String(error)})`);
    }
    throw error;
  }
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Not a directory: ${quoteTerminalPath(absolutePath)}`);
  return { selectedPath: absolutePath, skillsDir: resolved, missing: false, linkTarget };
}

/** Selects a directory without scanning its contents or writing any state. */
export async function selectSkillsDirectory(io: OnboardingIO, options: DirectorySelectionOptions = {}): Promise<SkillsOnboardingResult | null> {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const candidates = documentedSkillsDirectories(home);
  let selected = options.explicitSkillsDir;

  for (;;) {
    if (selected === undefined) {
      io.write("\nChoose a skills directory. Only the selected directory will be inspected.\n");
      if (options.currentSkillsDir !== undefined) io.write(`  0. Keep current: ${quoteTerminalPath(options.currentSkillsDir)}\n`);
      candidates.forEach((candidate, index) => io.write(`  ${index + 1}. ${candidate.label}: ${quoteTerminalPath(candidate.path)}\n`));
      io.write(`  ${candidates.length + 1}. Enter a custom or project-local path\n`);
      const answer = await io.ask(options.currentSkillsDir === undefined ? "Choose [1] (q to cancel): " : "Choose [0] (q to cancel): ");
      if (answer === null) return null;
      const choice = answer.trim().toLowerCase();
      if (choice === "q" || choice === "quit" || (options.currentSkillsDir !== undefined && (choice === "" || choice === "0"))) return null;
      const index = choice === "" ? 0 : Number(choice) - 1;
      if (Number.isInteger(index) && index >= 0 && index < candidates.length) {
        selected = candidates[index].path;
      } else if (choice === String(candidates.length + 1)) {
        const custom = await io.ask("Skills directory path (blank to cancel): ");
        if (custom === null) return null;
        if (custom.length === 0) continue;
        selected = custom;
      } else {
        io.write("Choose one of the listed numbers or q.\n");
        continue;
      }
    }

    const selectedPath = resolveSkillsDirectory(selected, home, cwd);
    selected = undefined;
    let inspection: InspectedSkillsDirectory;
    let approval: ApprovedSkillsRoot | null = null;
    try {
      inspection = await inspectSelectedSkillsDirectory(selectedPath);
      if (!inspection.missing) {
        approval = await approveSkillsRoot(inspection.skillsDir);
        if (approval.path !== inspection.skillsDir) throw new Error("Approved root does not match the selected target");
      }
    } catch (error) {
      io.write(`Cannot use ${quoteTerminalPath(selectedPath)}: ${escapeTerminalSingleLine(error instanceof Error ? error.message : String(error))}\n`);
      continue;
    }

    if (inspection.linkTarget !== null) {
      io.write(`Selected link: ${quoteTerminalPath(inspection.selectedPath)} -> ${quoteTerminalPath(inspection.linkTarget)}\n`);
    }
    if (inspection.linkTarget !== null || path.resolve(inspection.selectedPath) !== inspection.skillsDir) {
      io.write(`Selected path: ${quoteTerminalPath(inspection.selectedPath)}\nResolved target: ${quoteTerminalPath(inspection.skillsDir)}\n`);
      const answer = await io.ask("Manage this resolved target? [y/N]: ");
      if (answer === null) return null;
      if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
        io.write("Selection cancelled; the link was not changed.\n");
        continue;
      }
    }

    io.write(`Selected skills directory: ${quoteTerminalPath(inspection.skillsDir)}\n`);
    if (inspection.missing) io.write("The directory does not exist yet; browsing will not create it. Create it yourself and reselect it before making changes.\n");
    const initialize = await io.ask("Review optional local Git initialization? [y/N] (q to cancel): ");
    if (initialize === null || initialize.trim().toLowerCase() === "q") return null;
    const backup = await io.ask("Review optional remote backup? [y/N] (q to cancel): ");
    if (backup === null || backup.trim().toLowerCase() === "q") return null;
    const reviewInitialize = ["y", "yes"].includes(initialize.trim().toLowerCase());
    const reviewBackup = ["y", "yes"].includes(backup.trim().toLowerCase());
    if (approval !== null) {
      try {
        const current = await approveSkillsRoot(inspection.skillsDir);
        if (current.path !== approval.path || current.identity !== approval.identity) {
          io.write("The selected directory changed during approval. Select it again before making changes.\n");
          continue;
        }
      } catch (error) {
        io.write(`Cannot recheck the selected directory: ${escapeTerminalSingleLine(error instanceof Error ? error.message : String(error))}\n`);
        continue;
      }
      return { root: approval, reviewInitialize, reviewBackup };
    }
    return { root: { path: inspection.skillsDir, identity: null }, reviewInitialize, reviewBackup };
  }
}
