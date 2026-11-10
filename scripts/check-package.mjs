import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const beforeBuild = process.argv[2] === '--before-build';
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const listed = new Set(manifest.files.filter((file) => file.startsWith('dist/')));
const expected = new Set();
const generatedAssets = new Set(['dist/state/buildIdentity.json']);
const requiredAssets = new Set([
  'LICENSE',
  'THIRD_PARTY_NOTICES',
]);

for (const file of manifest.files) {
  if (!file.startsWith('dist/') && !requiredAssets.has(file)) {
    throw new Error(`Unexpected file or pattern in the package allowlist: ${file}`);
  }
}
for (const file of requiredAssets) {
  if (!manifest.files.includes(file)) throw new Error(`Required file is missing from the package allowlist: ${file}`);
}

for (const name of await readdir(root)) {
  if (/^(?:readme|license|licence|copying)(?:\..*)?$/i.test(name) &&
      name !== 'README.md' && name !== 'LICENSE') {
    throw new Error(`Unexpected implicitly included package file: ${name}`);
  }
}

const directories = new Set(['src']);
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
    if (beforeBuild && error.code === 'ENOENT' && directory !== 'src') continue;
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

async function requireRegularFile(relative) {
  const stats = await lstat(path.join(root, relative));
  if (!stats.isFile() || stats.size === 0 || stats.nlink !== 1) {
    throw new Error(`Required package file is not a nonempty, singly linked regular file: ${relative}`);
  }
}

async function checkBuildTarget(relative) {
  try {
    const stats = await lstat(path.join(root, relative));
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error(`Build output must not be a link or multiply linked file: ${relative}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await inspectSources(path.join(root, 'src'));
for (const file of generatedAssets) expected.add(file);
for (const file of expected) {
  if (!listed.has(file)) throw new Error(`Compiled module is missing from the package allowlist: ${file}`);
}
for (const file of listed) {
  if (!expected.has(file)) throw new Error(`Unexpected module in the package allowlist: ${file}`);
  if (beforeBuild) await checkBuildTarget(file);
  else await requireRegularFile(file);
}

if (!beforeBuild) {
  let buildIdentity;
  try {
    buildIdentity = JSON.parse(await readFile(path.join(root, 'dist/state/buildIdentity.json'), 'utf8'));
  } catch {
    throw new Error('Build identity metadata is missing or invalid.');
  }
  const knownIdentity = (buildIdentity?.source === 'git' || buildIdentity?.source === 'archive') &&
    typeof buildIdentity.commit === 'string' && /^[0-9a-f]{40}$/.test(buildIdentity.commit) &&
    typeof buildIdentity.dirty === 'boolean';
  const unknownIdentity = buildIdentity?.source === 'unknown' && buildIdentity.commit === null && buildIdentity.dirty === false;
  if (!knownIdentity && !unknownIdentity) throw new Error('Build identity metadata is missing or invalid.');
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
    await requireRegularFile(file);
  }
}
