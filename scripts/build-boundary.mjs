import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
  console.error(`Cannot build skills-boundary on ${process.platform}/${process.arch}; supported platforms are darwin and linux on arm64 or x64.`);
  process.exit(1);
}
if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) {
  console.error('Cannot build skills-boundary on Linux without glibc; use a glibc-based Linux system.');
  process.exit(1);
}

const compiler = process.env.CC || 'cc';
const nativeDir = fileURLToPath(new URL('../native/', import.meta.url));
const helpers = ['skills-boundary', 'skills-git-boundary'];
const flags = ['-std=c11', '-O2', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Wpedantic'];

function requireRegularOutput(path) {
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error(`Refusing to replace non-regular output ${path}; remove it or choose a clean checkout.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

try {
  for (const helper of helpers) {
    requireRegularOutput(join(nativeDir, helper));
    requireRegularOutput(join(nativeDir, `${helper}.platform.json`));
  }
  const tempDir = mkdtempSync(join(nativeDir, '.skills-boundary-build-'));
  try {
    const expected = `${process.platform}\t${process.arch}\t${process.platform === 'linux' ? 'glibc' : 'none'}`;
    for (const helper of helpers) {
      const source = join(nativeDir, `${helper}.c`);
      const tempOutput = join(tempDir, helper);
      const result = spawnSync(compiler, [...flags, source, '-o', tempOutput], { stdio: 'inherit' });
      if (result.error) {
        throw new Error(`Could not run C compiler ${JSON.stringify(compiler)}: ${result.error.message}. Install a host C compiler or set CC to its executable path.`);
      }
      if (result.status !== 0) {
        throw new Error(`Failed to compile ${helper} with ${JSON.stringify(compiler)}${result.signal ? ` (signal ${result.signal})` : ` (exit ${result.status})`}. Check the compiler output above.`);
      }

      const probe = spawnSync(tempOutput, ['--platform-probe'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0 || probe.stdout.trim() !== expected) {
        throw new Error(`Compiled ${helper} does not match this host (${process.platform}/${process.arch}). Use a host C compiler via CC.${probe.error ? ` ${probe.error.message}` : ''}`);
      }
    }
    const metadata = JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      libc: process.platform === 'linux' ? 'glibc' : null,
    }) + '\n';
    for (const helper of helpers) {
      writeFileSync(join(tempDir, `${helper}.platform.json`), metadata, { flag: 'wx' });
      requireRegularOutput(join(nativeDir, helper));
      requireRegularOutput(join(nativeDir, `${helper}.platform.json`));
    }
    for (const helper of helpers) renameSync(join(tempDir, helper), join(nativeDir, helper));
    for (const helper of helpers) {
      renameSync(join(tempDir, `${helper}.platform.json`), join(nativeDir, `${helper}.platform.json`));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`Cannot build skills-boundary: ${error.message}`);
  process.exitCode = 1;
}
