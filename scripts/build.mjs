import { spawnSync } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { captureBuildIdentity, root, unknownBuildIdentity, writeBuildIdentity } from './build-identity.mjs';

// Invalidate the old stamp before any build step can replace part of an output.
for (const relative of ['dist', 'dist/state']) {
  const directory = path.join(root, relative);
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Build directory must not be a link: ${relative}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory);
  }
}
await writeBuildIdentity(unknownBuildIdentity);
const before = await captureBuildIdentity();

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ['scripts/check-package.mjs', '--before-build']);
run('tsc', ['-p', 'tsconfig.json']);

const after = await captureBuildIdentity();
if (before.identity.source === after.identity.source && before.identity.commit === after.identity.commit &&
    before.identity.dirty === after.identity.dirty && before.tree === after.tree) {
  await writeBuildIdentity(after.identity);
}
