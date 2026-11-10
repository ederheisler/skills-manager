import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { assertApprovedSkillsRoot } from "./boundary.js";

export interface DirectoryIdentity { dev: string; ino: string }
export interface ValidatedGitOptions {
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
export interface ValidatedGitResult { stdout: string; stderr: string; exitCode: number }

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


export async function selectGitExecutable(env: NodeJS.ProcessEnv, directories: string[]): Promise<{ git: string; executablePath: string }> {
  return gitExecutable(env, directories);
}

async function reviewedDirectory(directory: string | undefined, expected: DirectoryIdentity | undefined): Promise<void> {
  if (!directory || !expected || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === path.parse(directory).root || directory.includes("\0")) throw new Error("A canonical reviewed Git directory is required");
  const value = await lstat(directory, { bigint: true });
  if (!value.isDirectory() || await realpath(directory) !== directory || value.dev.toString() !== expected.dev || value.ino.toString() !== expected.ino) throw new Error("The reviewed Git directory identity changed");
}

/** Reject pre-existing metadata aliases and special files; this is not an OS sandbox. */
async function inspectMetadata(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const value = await lstat(file);
    if (value.isSymbolicLink() || (!value.isDirectory() && !value.isFile()) || (value.isFile() && value.nlink !== 1)) throw new Error("Git metadata contains a symlink, hardlink, or special file; inspect it manually");
    if (value.isDirectory()) await inspectMetadata(file);
  }
}

export async function validateGitBinding(root: string, options: ValidatedGitOptions): Promise<void> {
  await assertApprovedSkillsRoot({ path: root, identity: options.expectedRoot.identity });
  await reviewedDirectory(root, options.expectedRoot);
  if (options.repositoryRoot !== undefined || options.expectedRepositoryRoot !== undefined || options.gitDir !== undefined || options.expectedGitDir !== undefined || options.expectedGitEntry !== undefined || options.commonDir !== undefined || options.expectedCommonDir !== undefined) {
    await reviewedDirectory(options.repositoryRoot, options.expectedRepositoryRoot);
    await reviewedDirectory(options.gitDir, options.expectedGitDir);
    await reviewedDirectory(options.commonDir, options.expectedCommonDir);
    const repository = options.repositoryRoot!;
    const relative = path.relative(repository, root);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("The selected root escaped the reviewed repository");
    let ancestor = repository;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, component);
      const directory = await lstat(ancestor);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("The selected repository path contains an unsafe directory");
      try {
        await lstat(path.join(ancestor, ".git"));
        throw new Error("A nested Git boundary was inserted in the selected repository");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const entry = path.join(repository, ".git");
    const value = await lstat(entry, { bigint: true });
    if (value.isSymbolicLink() || (!value.isDirectory() && !value.isFile()) || (value.isFile() && value.nlink !== 1n) || value.dev.toString() !== options.expectedGitEntry?.dev || value.ino.toString() !== options.expectedGitEntry?.ino) throw new Error("The reviewed Git entry changed or is unsafe");
    if (value.isDirectory()) {
      if (entry !== options.gitDir || options.commonDir !== options.gitDir) throw new Error("Git metadata no longer matches the reviewed repository");
    } else {
      const text = await readFile(entry, "utf8");
      const match = /^gitdir: ([^\0\r\n]+)\n?$/.exec(text);
      if (!match || path.resolve(repository, match[1]) !== options.gitDir) throw new Error("The reviewed worktree Git reference changed");
      const common = await readFile(path.join(options.gitDir!, "commondir"), "utf8");
      if (path.resolve(options.gitDir!, common.trimEnd()) !== options.commonDir) throw new Error("The reviewed common Git directory changed");
    }
    await inspectMetadata(options.commonDir!);
    if (options.gitDir !== options.commonDir) await inspectMetadata(options.gitDir!);
  }
  if (options.remoteDir || options.expectedRemoteDir) {
    await reviewedDirectory(options.remoteDir, options.expectedRemoteDir);
    await inspectMetadata(options.remoteDir!);
  }
}

/** Execute ordinary Git after in-app identity checks, without claiming process confinement. */
export async function runValidatedGit(root: string, args: readonly string[], options: ValidatedGitOptions): Promise<ValidatedGitResult> {
  if (!args.length || args.some((arg) => arg.includes("\0"))) throw new Error("A valid Git argument vector is required");
  await validateGitBinding(root, options);
  const directories = [root, options.repositoryRoot, options.gitDir, options.commonDir, options.remoteDir].filter((value): value is string => !!value);
  const selected = await gitExecutable(options.env, directories);
  const repositoryEnv = options.gitDir ? { GIT_DIR: options.gitDir, GIT_COMMON_DIR: options.commonDir, GIT_WORK_TREE: options.repositoryRoot } : {};
  const result = await execa(selected.git, [...args], { cwd: root, env: { ...options.env, ...repositoryEnv, PATH: selected.executablePath }, extendEnv: false, reject: false, stripFinalNewline: false, encoding: "buffer", ...(options.input === undefined ? {} : { input: options.input }) });
  const stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
  return { stdout, stderr: new TextDecoder().decode(result.stderr), exitCode: result.exitCode ?? 1 };
}
