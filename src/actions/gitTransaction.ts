import path from "node:path";
import type { ApprovedSkillsRoot } from "./boundary.js";
import { runConfinedNodeWorker } from "./gitBoundary.js";
import type { CommitPreview, GitBinding, PullPreview } from "./git.js";

/** Paths are relative to the selected skills directory, not the Git repository. */
export interface TransactionEntry {
  path: string;
  mode: string | null;
  oid: string | null;
}

interface WorkerRequest {
  action: "fingerprint" | "commit" | "pull" | "recover";
  binding: GitBinding;
  root: string;
  approvedIdentity: string;
  preview?: CommitPreview;
  pullPreview?: PullPreview;
  newOid?: string;
  entries?: TransactionEntry[];
}

type Operation = Omit<WorkerRequest, "binding" | "approvedIdentity" | "root">;
async function worker(
  approved: ApprovedSkillsRoot,
  binding: GitBinding,
  request: Operation,
): Promise<unknown> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const name = key.toUpperCase();
    return !name.startsWith("GIT_") && name !== "NODE_OPTIONS" && name !== "NODE_PATH";
  }));
  const executablePath = (env.PATH ?? "").split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry) && path.resolve(entry) !== approved.path && !path.resolve(entry).startsWith(`${approved.path}${path.sep}`))
    .join(path.delimiter) || "/dev/null";
  const result = await runConfinedNodeWorker(approved.path, {
    env: { ...env, PATH: executablePath, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    input: Buffer.from(JSON.stringify({ ...request, root: approved.path, binding, approvedIdentity: approved.identity })),
    expectedRoot: { ...binding.root, identity: approved.identity },
    repositoryRoot: binding.repositoryRoot,
    expectedRepositoryRoot: binding.repositoryIdentity,
    gitDir: binding.gitDir,
    expectedGitDir: binding.gitDirIdentity,
    expectedGitEntry: binding.gitEntry,
    commonDir: binding.commonDir,
    expectedCommonDir: binding.commonDirIdentity,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "The confined Git transaction failed");
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("The confined Git transaction returned an invalid response");
  }
}

/** SHA-256 of the complete live index, or null when the index does not exist. */
export async function indexFingerprint(approved: ApprovedSkillsRoot, binding: GitBinding): Promise<string | null> {
  const value = await worker(approved, binding, { action: "fingerprint" });
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("The confined Git transaction returned an invalid index fingerprint");
  }
  return value;
}

/** Caller must hold withSkillsLock for the complete action. */
export async function commitIndexTransaction(
  approved: ApprovedSkillsRoot,
  preview: CommitPreview,
  options: { newOid: string; entries: TransactionEntry[] },
): Promise<void> {
  await worker(approved, preview.binding, { action: "commit", preview, ...options });
}
/** Caller must hold withSkillsLock for the complete action. */
export async function pullIndexWorktreeTransaction(approved: ApprovedSkillsRoot, preview: PullPreview): Promise<void> {
  await worker(approved, preview.binding, { action: "pull", pullPreview: preview });
}


/** Caller must hold withSkillsLock; a message means review is required before retrying. */
export async function recoverIndexTransaction(approved: ApprovedSkillsRoot, binding: GitBinding): Promise<string | undefined> {
  const value = await worker(approved, binding, { action: "recover" });
  if (value !== null && typeof value !== "string") {
    throw new Error("The confined Git transaction returned an invalid recovery response");
  }
  return value ?? undefined;
}
