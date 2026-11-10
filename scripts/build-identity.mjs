import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const template = 'scripts/build-identity.template';
const originalTemplate = '$Format:%H$\n$Format:%T$\n';
const fullSha = /^[0-9a-f]{40}$/;
const generated = new Set([
  '.git',
  'node_modules',
  'dist',
  '.claude/settings.json',
  '.claude/scheduled_tasks.lock',
  '.claude/skills/opentui',
  'graphify-out/cache',
  'graphify-out/manifest.json',
]);
export const unknownBuildIdentity = { commit: null, dirty: false, source: 'unknown' };
const exec = promisify(execFile);

function ignoredNonBuild(relative, stats) {
  return generated.has(relative) || (stats.isFile() && relative.split('/').at(-1) === '.DS_Store') ||
    /^graphify-out\/(?:.*\/)?cost\.json$/.test(relative) ||
    /^graphify-out\/\.graphify_[^/]+$/.test(relative) ||
    (stats.isDirectory() && /^graphify-out\/\d{4}-\d{2}-\d{2}$/.test(relative));
}

// Git's archive substitution changes only this file. Restore its tracked bytes
// while hashing so a modified extraction cannot be reported as a clean source.
async function treeHash(directory, relative = '', fromArchive = false) {
  const entries = [];
  for (const name of await readdir(directory)) {
    const child = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, name);
    const stats = await lstat(absolute);
    if (ignoredNonBuild(child, stats)) continue;
    let mode;
    let hash;
    if (stats.isDirectory()) {
      hash = await treeHash(absolute, child, fromArchive);
      if (hash === null) continue; // Git does not record empty directories.
      mode = '40000';
    } else if (stats.isSymbolicLink()) {
      mode = '120000';
      hash = objectHash('blob', Buffer.from(await readlink(absolute)));
    } else if (stats.isFile()) {
      mode = stats.mode & 0o111 ? '100755' : '100644';
      const bytes = fromArchive && child === template ? Buffer.from(originalTemplate) : await readFile(absolute);
      hash = objectHash('blob', bytes);
    } else {
      throw new Error(`Cannot identify special source file: ${child}`);
    }
    entries.push({ name, mode, hash });
  }
  if (entries.length === 0 && relative) return null;
  entries.sort((a, b) => Buffer.compare(
    Buffer.from(`${a.name}${a.mode === '40000' ? '/' : '\0'}`),
    Buffer.from(`${b.name}${b.mode === '40000' ? '/' : '\0'}`),
  ));
  return objectHash('tree', Buffer.concat(entries.flatMap(({ name, mode, hash }) => [
    Buffer.from(`${mode} ${name}\0`), hash,
  ])));
}

function objectHash(kind, bytes) {
  return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest();
}

async function checkoutIdentity() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
  const git = async (...args) => (await exec('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: root, env, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    if (await realpath(await git('rev-parse', '--show-toplevel')) !== root) return null;
    const commit = await git('rev-parse', '--verify', 'HEAD^{commit}');
    if (!fullSha.test(commit)) return null;
    const tree = await git('rev-parse', '--verify', `${commit}^{tree}`);
    if (!fullSha.test(tree)) return null;
    let dirty = true;
    let sourceTree = null;
    try {
      sourceTree = (await treeHash(root)).toString('hex');
      dirty = sourceTree !== tree;
      if (!dirty) await git('diff-index', '--cached', '--quiet', commit, '--');
    } catch {
      dirty = true;
    }
    return { identity: { commit, dirty, source: 'git' }, tree: sourceTree };
  } catch {
    return null;
  }
}

async function archiveIdentity() {
  try {
    const text = await readFile(path.join(root, template), 'utf8');
    const match = /^([0-9a-f]{40})\n([0-9a-f]{40})\n$/.exec(text);
    if (!match) return null;
    let dirty = true;
    let sourceTree = null;
    try {
      sourceTree = (await treeHash(root, '', true)).toString('hex');
      dirty = sourceTree !== match[2];
    } catch { /* Unreadable source is not clean. */ }
    return { identity: { commit: match[1], dirty, source: 'archive' }, tree: sourceTree };
  } catch {
    return null;
  }
}

export async function captureBuildIdentity() {
  return await checkoutIdentity() ?? await archiveIdentity() ?? { identity: unknownBuildIdentity, tree: null };
}

export async function writeBuildIdentity(identity) {
  const target = path.join(root, 'dist/state/buildIdentity.json');
  try {
    const stats = await lstat(target);
    if (!stats.isFile() || stats.nlink !== 1) throw new Error(`Refusing unsafe build identity output: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(target), `.build-identity-${randomUUID()}.tmp`);
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    try {
      await output.writeFile(`${JSON.stringify(identity)}\n`);
    } finally {
      await output.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
