import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const beforeBuild = process.argv[2] === '--before-build';
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const listed = new Set(manifest.files.filter((file) => file.startsWith('dist/')));
const expected = new Set();
const requiredAssets = new Set([
  'LICENSE',
  'THIRD_PARTY_NOTICES',
  'native/skills-boundary',
  'native/skills-boundary.platform.json',
  'native/skills-git-boundary',
  'native/skills-git-boundary.platform.json',
]);

for (const file of manifest.files) {
  if (!file.startsWith('dist/') && !requiredAssets.has(file)) {
    throw new Error(`Unexpected file or pattern in the package allowlist: ${file}`);
  }
}
for (const file of requiredAssets) {
  if (!manifest.files.includes(file)) throw new Error(`Required file is missing from the package allowlist: ${file}`);
}

const directories = new Set(['src', 'native']);
for (const file of listed) {
  for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) {
    directories.add(directory);
  }
}
for (const directory of directories) {
  let stats;
  try {
    stats = await lstat(path.join(root, directory));
  } catch (error) {
    if (beforeBuild && error.code === 'ENOENT' && directory !== 'src' && directory !== 'native') continue;
    throw error;
  }
  if (!stats.isDirectory()) throw new Error(`Package directory must not be a link: ${directory}`);
}

async function inspectSources(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Source links are not accepted when preparing a package: src/${name}`);
    }
    if (entry.isDirectory()) {
      await inspectSources(absolute, name);
    } else if (/\.(?:mts|cts)$/.test(name)) {
      throw new Error(`Add the emitted module for src/${name} to the release check and package allowlist.`);
    } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      expected.add(`dist/${name.replace(/\.tsx?$/, '.js')}`);
    }
  }
}

async function requireRegularFile(relative, executable = false) {
  const stats = await lstat(path.join(root, relative));
  if (!stats.isFile() || stats.size === 0 || (executable && (stats.mode & 0o111) === 0)) {
    throw new Error(`Required package file is not a nonempty${executable ? ' executable' : ''} regular file: ${relative}`);
  }
}

async function checkBuildTarget(relative) {
  try {
    if (!(await lstat(path.join(root, relative))).isFile()) {
      throw new Error(`Build output must not be a link or special file: ${relative}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await inspectSources(path.join(root, 'src'));
for (const file of expected) {
  if (!listed.has(file)) throw new Error(`Compiled module is missing from the package allowlist: ${file}`);
}
for (const file of listed) {
  if (!expected.has(file)) throw new Error(`Unexpected module in the package allowlist: ${file}`);
  if (beforeBuild) await checkBuildTarget(file);
  else await requireRegularFile(file);
}

if (!beforeBuild) {
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
    await requireRegularFile(file);
  }
  for (const helper of ['skills-boundary', 'skills-git-boundary']) {
    await requireRegularFile(`native/${helper}`, true);
    await requireRegularFile(`native/${helper}.platform.json`);
    const nativePlatform = JSON.parse(await readFile(path.join(root, `native/${helper}.platform.json`), 'utf8'));
    const libc = process.platform === 'linux' && process.report.getReport().header.glibcVersionRuntime ? 'glibc' : null;
    if (nativePlatform.platform !== process.platform || nativePlatform.arch !== process.arch || nativePlatform.libc !== libc ||
        (process.platform === 'linux' && libc !== 'glibc')) {
      throw new Error(`The ${helper} native helper does not match the current operating system, architecture, and supported libc.`);
    }
  }
}
