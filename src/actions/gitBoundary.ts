import { constants, readFileSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const helper = fileURLToPath(new URL("../../native/skills-git-boundary", import.meta.url));
const platformFile = fileURLToPath(new URL("../../native/skills-git-boundary.platform.json", import.meta.url));

export interface DirectoryIdentity {
  dev: string;
  ino: string;
}

export interface ConfinedGitOptions {
  env: NodeJS.ProcessEnv;
  input?: Buffer;
  expectedRoot: DirectoryIdentity & { identity: string };
  repositoryRoot?: string;
  expectedRepositoryRoot?: DirectoryIdentity;
  gitDir?: string;
  expectedGitDir?: DirectoryIdentity;
  expectedGitEntry?: DirectoryIdentity;
  commonDir?: string;
  expectedCommonDir?: DirectoryIdentity;
  remoteDir?: string;
  expectedRemoteDir?: DirectoryIdentity;
}

export interface ConfinedGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function checkHelperPlatform(): void {
  let platform: { platform?: string; arch?: string; libc?: string | null };
  try {
    platform = JSON.parse(readFileSync(platformFile, "utf8")) as typeof platform;
  } catch (error) {
    throw new Error(`Git write boundary metadata is missing or invalid (${platformFile}): ${error instanceof Error ? error.message : String(error)}`);
  }
  // Node's report typings are opaque; supported runtimes expose this optional header.
  const report = process.platform === "linux"
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    : null;
  const libc = report ? (report.header?.glibcVersionRuntime ? "glibc" : "unsupported") : null;
  if (!platform || !["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch) ||
      platform.platform !== process.platform || platform.arch !== process.arch || platform.libc !== libc || libc === "unsupported") {
    throw new Error(`Git write boundary is incompatible with ${process.platform}/${process.arch}${libc ? `/${libc}` : ""}; rebuild it for this host`);
  }
}

function checkDirectory(value: string, label: string): void {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root || value.includes("\0")) {
    throw new Error(`A canonical absolute ${label} directory is required for the Git write boundary`);
  }
}

function checkIdentity(value: DirectoryIdentity | undefined, label: string): asserts value is DirectoryIdentity {
  if (!value || !/^[0-9]+$/.test(value.dev) || !/^[0-9]+$/.test(value.ino)) {
    throw new Error(`A reviewed ${label} directory identity is required for the Git write boundary`);
  }
}

function isUntrustedPath(value: string, directories: readonly string[]): boolean {
  return directories.some((base) => {
    const relative = path.relative(base, value);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

async function gitExecutable(env: NodeJS.ProcessEnv, untrustedDirectories: string[]): Promise<{ git: string; executablePath: string }> {
  // Neither Git nor the PATH inherited by its helpers may come from an
  // approved repository, including through an absolute directory symlink.
  const trustedDirectories: string[] = [];
  let git: string | undefined;
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    try {
      const resolved = await realpath(directory);
      if (isUntrustedPath(resolved, untrustedDirectories)) continue;
      let executable: string | undefined;
      try {
        executable = await realpath(path.join(resolved, "git"));
      } catch {
        // A directory without Git can still contain a required Git helper.
      }
      if (executable && isUntrustedPath(executable, untrustedDirectories)) continue;
      trustedDirectories.push(resolved);
      if (!git && executable) {
        try {
          if ((await stat(executable)).isFile()) {
            await access(executable, constants.X_OK);
            git = executable;
          }
        } catch {
          // Try the next absolute PATH entry.
        }
      }
    } catch {
      // Ignore missing or otherwise inaccessible PATH directories.
    }
  }
  if (!git) throw new Error("Cannot find an executable Git binary in the absolute PATH entries");
  return { git, executablePath: trustedDirectories.join(path.delimiter) };
}

async function runConfined(root: string, args: readonly string[], options: ConfinedGitOptions, transaction: boolean): Promise<ConfinedGitResult> {
  checkHelperPlatform();
  checkDirectory(root, "skills root");
  checkIdentity(options.expectedRoot, "skills root");
  if (!/^[a-f0-9]{64}$/.test(options.expectedRoot.identity)) throw new Error("An approved skills root identity is required for the Git write boundary");
  if ((!transaction && !args.length) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("A valid Git argument vector is required");

  const metadataPresent = options.gitDir !== undefined || options.expectedGitDir !== undefined ||
    options.expectedGitEntry !== undefined || options.commonDir !== undefined || options.expectedCommonDir !== undefined;
  const repositoryPresent = options.repositoryRoot !== undefined || options.expectedRepositoryRoot !== undefined;
  const nativeArgs = ["--root", root, options.expectedRoot.dev, options.expectedRoot.ino, options.expectedRoot.identity];
  if (metadataPresent || repositoryPresent) {
    if (options.repositoryRoot === undefined) throw new Error("A reviewed repository root is required for the Git write boundary");
    if (options.gitDir === undefined || options.commonDir === undefined) throw new Error("Both reviewed Git directories are required for the Git write boundary");
    checkDirectory(options.repositoryRoot, "repository root");
    checkIdentity(options.expectedRepositoryRoot, "repository root");
    checkDirectory(options.gitDir, "Git metadata");
    checkDirectory(options.commonDir, "Git common");
    checkIdentity(options.expectedGitDir, "Git metadata");
    checkIdentity(options.expectedGitEntry, "Git entry");
    checkIdentity(options.expectedCommonDir, "Git common");
    nativeArgs.push("--repository-root", options.repositoryRoot, options.expectedRepositoryRoot.dev, options.expectedRepositoryRoot.ino,
      "--git-entry", options.expectedGitEntry.dev, options.expectedGitEntry.ino,
      "--git-dir", options.gitDir, options.expectedGitDir.dev, options.expectedGitDir.ino,
      "--common-dir", options.commonDir, options.expectedCommonDir.dev, options.expectedCommonDir.ino);
  }
  if (options.remoteDir !== undefined || options.expectedRemoteDir !== undefined) {
    if (options.remoteDir === undefined) throw new Error("A reviewed local bare remote is required for the Git write boundary");
    checkDirectory(options.remoteDir, "local bare remote");
    checkIdentity(options.expectedRemoteDir, "local bare remote");
    nativeArgs.push("--remote-dir", options.remoteDir, options.expectedRemoteDir.dev, options.expectedRemoteDir.ino);
  }
  if (transaction) nativeArgs.push("--transaction-worker");
  const untrustedDirectories = [root, options.repositoryRoot, options.gitDir, options.commonDir, options.remoteDir]
    .filter((directory): directory is string => directory !== undefined);
  const { git, executablePath } = await gitExecutable(options.env, untrustedDirectories);
  let executable = git;
  let commandArgs = args;
  if (transaction) {
    if (!options.gitDir || !options.commonDir || options.remoteDir) throw new Error("A reviewed Git repository is required for the confined commit transaction");
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = fileURLToPath(new URL(`./gitTransactionWorker.${extension}`, import.meta.url));
    executable = await realpath(process.execPath);
    if (isUntrustedPath(executable, untrustedDirectories)) throw new Error("The transaction worker executable is inside an untrusted repository");
    commandArgs = [worker, git, options.gitDir, options.commonDir];
  }
  let result;
  try {
    result = await execa(helper, [...nativeArgs, "--", executable, ...commandArgs], {
      env: { ...options.env, PATH: executablePath },
      extendEnv: false,
      reject: false,
      stripFinalNewline: false,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  } catch (error) {
    throw new Error(`Git write boundary could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.code === "ENOENT" || result.code === "EACCES" || result.code === "ENOEXEC") {
    throw new Error(`Git write boundary is missing or cannot execute (${helper}): ${result.originalMessage}`);
  }
  if (result.exitCode === 125 && result.stderr.startsWith("skills-git-boundary:")) {
    throw new Error(`Git write boundary unavailable or refused the reviewed directory: ${result.stderr.trim()}`);
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}

/** Run the supplied Git command with the OS write boundary already enforced. */
export function runConfinedGit(root: string, args: readonly string[], options: ConfinedGitOptions): Promise<ConfinedGitResult> {
  return runConfined(root, args, options, false);
}

/** Run only the bundled commit worker inside the same pinned Git boundary. */
export function runConfinedNodeWorker(root: string, options: ConfinedGitOptions): Promise<ConfinedGitResult> {
  return runConfined(root, [], options, true);
}
