import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';

const exec = promisify(execFile);
const args = process.argv.slice(2);
assert.equal(args.length, 1, 'Usage: node scripts/release-smoke.mjs <absolute-installed-package-root>');
assert.ok(path.isAbsolute(args[0]), 'Installed package root must be absolute');
const installed = await realpath(args[0]);
const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'skills-manager');
assert.equal(typeof manifest.bin?.['skills-manager'], 'string');
const cli = await realpath(path.resolve(installed, manifest.bin['skills-manager']));
assert.ok(cli.startsWith(`${installed}${path.sep}`), 'Installed CLI must be inside the package');

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const work = await realpath(await mkdtemp(path.join(tmpdir(), 'skills-release-smoke-')));
const workIdentity = await lstat(work, { bigint: true });
const home = path.join(work, 'home');
const temporary = path.join(work, 'tmp');
const outside = path.join(work, 'outside');
const externalLock = path.join(work, '.skill-lock.json');

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function missing(file) {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
}

async function snapshot(directory) {
  const result = [];
  async function visit(base, relative = '') {
    for (const name of (await readdir(base)).sort()) {
      const file = path.join(base, name);
      const item = relative ? `${relative}/${name}` : name;
      const info = await lstat(file);
      if (info.isSymbolicLink()) result.push([item, 'link', await readlink(file)]);
      else if (info.isDirectory()) {
        result.push([item, 'directory']);
        await visit(file, item);
      } else if (info.isFile()) result.push([item, 'file', (await readFile(file)).toString('hex')]);
      else throw new Error(`Unexpected fixture entry: ${file}`);
    }
  }
  await visit(directory);
  return result;
}

async function git(cwd, ...gitArgs) {
  const result = await exec('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'init.templateDir=', ...gitArgs,
  ], { cwd, env: process.env, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  return result.stdout;
}

function successful(result) {
  assert.equal(result.exitCode, 0, `${result.command}: ${result.stderr}`);
}

async function browseInTerminal(skillsDir) {
  const relay = fileURLToPath(new URL('./release-smoke-pty.py', import.meta.url));
  let transcript = '';
  let stderr = '';
  let step = 0;
  let failure;
  let retryQuit;
  const child = spawn('python3', [relay, cli, '--skills-dir', skillsDir], {
    cwd: work, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.on('error', (error) => { failure = error; });
  const timer = setTimeout(() => {
    failure = new Error('Timed out waiting for the installed CLI to browse and quit');
    child.kill('SIGTERM');
  }, 90_000);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    transcript += chunk;
    if (transcript.length > 4 * 1024 * 1024) {
      failure = new Error('Terminal output exceeded the smoke limit');
      child.kill('SIGTERM');
      return;
    }
    const text = stripVTControlCharacters(transcript);
    if (step === 0 && text.includes('Review optional local Git initialization? [y/N]')) {
      step = 1;
      child.stdin.write('\n');
    }
    if (step === 1 && text.includes('Review optional remote backup? [y/N]')) {
      step = 2;
      child.stdin.write('\n');
    }
    if (step === 2 && /Skills\s+1\s+shown/.test(text)) {
      step = 3;
      child.stdin.write('q');
      // The first rendered frame can precede completion of asynchronous startup.
      retryQuit = setInterval(() => child.stdin.write('q'), 250);
    }
  });
  const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  clearInterval(retryQuit);
  const evidence = stripVTControlCharacters(transcript).slice(-12000);
  const diagnostic = `PTY exit=${result.code} signal=${result.signal}\nstderr:\n${stderr}\nterminal:\n${evidence}`;
  if (failure) throw new Error(`${failure.message}\n${diagnostic}`);
  assert.equal(result.signal, null, diagnostic);
  assert.equal(result.code, 0, diagnostic);
  assert.equal(step, 3, `Did not reach both Git prompts and the populated browse screen.\n${diagnostic}`);
}

async function run() {
  await Promise.all([home, temporary, outside, ...['config', 'cache', 'data', 'state'].map((name) => path.join(work, name))]
    .map((directory) => mkdir(directory)));
  await put(path.join(outside, 'sentinel.bin'), Buffer.from('outside sentinel\0keep these bytes\n'));
  await put(path.join(outside, 'external', 'SKILL.md'), 'external skill must remain unchanged\n');
  await writeFile(externalLock, 'outside lock must remain unchanged\n');
  const outsideBefore = await snapshot(outside);
  const lockBefore = await readFile(externalLock);

  // Do not inherit the invoking user's home, credentials, sockets, or Git/Node configuration.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${previousEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}`,
    HOME: home, TMPDIR: temporary, TERM: 'xterm-256color', LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(work, 'config'), XDG_CACHE_HOME: path.join(work, 'cache'),
    XDG_DATA_HOME: path.join(work, 'data'), XDG_STATE_HOME: path.join(work, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', NODE_DISABLE_COMPILE_CACHE: '1', PYTHONDONTWRITEBYTECODE: '1',
  });
  process.chdir(work);

  const load = (name) => import(pathToFileURL(path.join(installed, 'dist', name)).href);
  const boundary = await load('actions/boundary.js');
  const toggle = await load('actions/toggle.js');
  const installer = await load('actions/skillsCli.js');
  const repo = await load('state/repo.js');
  const gitApi = await load('actions/git.js');

  // Adoption is read-only, including when both optional Git questions default to no.
  const browseRoot = path.join(work, 'browse');
  const browseText = '---\nname: browse\ndescription: Existing skill\n---\n\n# Existing\n';
  await put(path.join(browseRoot, 'browse', 'SKILL.md'), browseText);
  const browseBefore = await snapshot(browseRoot);
  await browseInTerminal(browseRoot);
  assert.deepEqual(await snapshot(browseRoot), browseBefore);
  assert.deepEqual(await readdir(home), []);
  for (const name of ['config', 'cache', 'data', 'state']) assert.deepEqual(await readdir(path.join(work, name)), []);
  await missing(path.join(browseRoot, '.git'));
  await missing(path.join(browseRoot, '.skills-manager'));
  assert.deepEqual(await snapshot(outside), outsideBefore);
  assert.deepEqual(await readFile(externalLock), lockBefore);

  // Exercise the installed native boundary with independently reviewed source bytes.
  const localRoot = path.join(work, 'local');
  const adoptedText = '---\nname: adopted\ndescription: Existing skill\n---\n\nkeep adopted\n';
  await put(path.join(localRoot, 'adopted', 'SKILL.md'), adoptedText);
  const approved = await boundary.approveSkillsRoot(localRoot);
  const scanned = await repo.scanSkills(localRoot);
  assert.deepEqual(scanned.map(({ name, enabled }) => [name, enabled]), [['adopted', true]]);
  await missing(path.join(localRoot, '.skills-manager'));
  const staged = path.join(work, 'reviewed-source');
  const importedText = '---\nname: imported\ndescription: Reviewed skill\n---\n\nreviewed bytes\n';
  await put(path.join(staged, 'SKILL.md'), importedText);
  await put(path.join(staged, 'instructions.txt'), 'reviewed instructions\n');
  const stagedBefore = await snapshot(staged);
  const stagedVersion = await boundary.fingerprintTree(staged);
  const reviewed = await boundary.readSkillFiles(staged);
  assert.deepEqual(reviewed.files.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'instructions.txt', content: 'reviewed instructions\n' },
    { path: 'SKILL.md', content: importedText },
  ].sort((a, b) => a.path.localeCompare(b.path)));
  assert.equal(await boundary.fingerprintTree(staged), stagedVersion);
  await boundary.importSkill(approved, 'imported', staged, {
    replace: false, expectedStagedVersion: stagedVersion,
  });
  const active = path.join(localRoot, 'imported');
  const disabled = path.join(localRoot, '.disabled_skills', 'imported');
  assert.deepEqual(await snapshot(active), stagedBefore);
  assert.deepEqual(await snapshot(staged), stagedBefore);
  assert.equal(await readFile(path.join(localRoot, 'adopted', 'SKILL.md'), 'utf8'), adoptedText);
  const outsideLink = path.join(outside, 'external');
  const danglingLink = path.join(outside, 'missing');
  await symlink(outsideLink, path.join(active, 'outside-link'));
  await symlink(danglingLink, path.join(active, 'dangling-link'));
  const activeBefore = await snapshot(active);
  await toggle.disableSkill(approved, 'imported', await boundary.fingerprintSkill(approved, 'imported', active));
  await missing(active);
  assert.deepEqual(await snapshot(disabled), activeBefore);
  await toggle.enableSkill(approved, 'imported', await boundary.fingerprintSkill(approved, 'imported', disabled));
  await missing(disabled);
  assert.deepEqual(await snapshot(active), activeBefore);
  const staleVersion = await boundary.fingerprintSkill(approved, 'imported', active);
  const changedText = `${importedText}changed after review\n`;
  await writeFile(path.join(active, 'SKILL.md'), changedText);
  await assert.rejects(toggle.disableSkill(approved, 'imported', staleVersion));
  assert.equal(await readFile(path.join(active, 'SKILL.md'), 'utf8'), changedText);
  await missing(disabled);
  const collisionVersion = await boundary.fingerprintSkill(approved, 'imported', active);
  await put(path.join(disabled, 'SKILL.md'), 'collision must survive\n');
  const beforeCollision = await snapshot(active);
  const disabledBeforeCollision = await snapshot(disabled);
  await assert.rejects(async () => {
    const version = await boundary.fingerprintSkill(approved, 'imported', active);
    await toggle.disableSkill(approved, 'imported', version);
  });
  await assert.rejects(toggle.disableSkill(approved, 'imported', collisionVersion));
  assert.deepEqual(await snapshot(active), beforeCollision);
  assert.deepEqual(await snapshot(disabled), disabledBeforeCollision);
  assert.equal(await readFile(path.join(disabled, 'SKILL.md'), 'utf8'), 'collision must survive\n');
  assert.deepEqual(await readdir(disabled), ['SKILL.md']);
  assert.deepEqual(await snapshot(outside), outsideBefore);
  assert.deepEqual(await readFile(externalLock), lockBefore);

  // Each preview runs the pinned installed skills CLI inside the real OS sandbox.
  const upstreamRoot = path.join(work, 'upstream-destination');
  const upstreamSource = path.join(work, 'upstream-source');
  const upstreamText = '---\nname: example\ndescription: Example fixture\n---\n\n# Example\n';
  const instructions = 'safe fixture\n';
  await mkdir(upstreamRoot);
  await put(path.join(upstreamSource, 'example', 'SKILL.md'), upstreamText);
  await put(path.join(upstreamSource, 'example', 'instructions.txt'), instructions);
  const sourceBefore = await snapshot(upstreamSource);
  const upstreamApproved = await boundary.approveSkillsRoot(upstreamRoot);
  async function prepare(root = upstreamApproved) {
    const before = await snapshot(root.path);
    const change = await installer.prepareAdd(root, upstreamSource);
    assert.equal(change.kind, 'add');
    assert.equal(change.source, upstreamSource);
    assert.equal(change.skillsDir, root.path);
    assert.equal(change.changes.length, 1);
    const item = change.changes[0];
    assert.equal(item.name, 'example');
    assert.equal(item.destination, path.join(root.path, 'example'));
    assert.equal(item.action, 'install');
    assert.equal(item.enabled, true);
    assert.deepEqual([...item.files].sort(), ['SKILL.md', 'instructions.txt']);
    assert.ok(item.review.includes(upstreamText), 'Review must contain the complete staged SKILL.md bytes');
    assert.ok(item.review.includes(instructions), 'Review must contain the complete staged instructions.txt bytes');
    assert.deepEqual(await snapshot(root.path), before);
    return change;
  }
  const declined = await prepare();
  await installer.discardPreparedChange(declined);
  await missing(declined.workspace);
  assert.deepEqual(await readdir(upstreamRoot), []);
  const stale = await prepare();
  await writeFile(path.join(stale.workspace, 'home', '.agents', 'skills', 'example', 'SKILL.md'), 'changed after review\n');
  await assert.rejects(installer.applyPreparedChange(stale), /changed after review/i);
  await missing(stale.workspace);
  await missing(path.join(upstreamRoot, 'example'));
  const collisionRoot = path.join(work, 'upstream-collision');
  await mkdir(collisionRoot);
  const collision = await prepare(await boundary.approveSkillsRoot(collisionRoot));
  await put(path.join(collisionRoot, 'example', 'SKILL.md'), 'new destination must survive\n');
  await assert.rejects(installer.applyPreparedChange(collision), /already exists/i);
  await missing(collision.workspace);
  assert.deepEqual(await readdir(path.join(collisionRoot, 'example')), ['SKILL.md']);
  assert.equal(await readFile(path.join(collisionRoot, 'example', 'SKILL.md'), 'utf8'), 'new destination must survive\n');
  const accepted = await prepare();
  await installer.applyPreparedChange(accepted);
  await missing(accepted.workspace);
  assert.deepEqual(await snapshot(path.join(upstreamRoot, 'example')), await snapshot(path.join(upstreamSource, 'example')));
  const receipt = JSON.parse(await boundary.readManagedMetadata(upstreamRoot, 'example', upstreamApproved));
  assert.equal(receipt.version, 2);
  assert.equal(receipt.root, upstreamRoot);
  assert.equal(receipt.name, 'example');
  assert.equal(receipt.entry.source, upstreamSource);
  assert.equal(receipt.entry.sourceType, 'local');
  assert.equal(receipt.entry.sourceUrl, upstreamSource);
  assert.deepEqual(await snapshot(upstreamSource), sourceBefore);
  assert.deepEqual(await snapshot(outside), outsideBefore);
  assert.deepEqual(await readFile(externalLock), lockBefore);

  // Real Git transactions, including a local bare push/fetch/pull, must retain
  // unrelated index entries and worktree bytes while advancing only reviewed paths.
  const gitRoot = path.join(work, 'git-skills');
  const remote = path.join(work, 'remote.git');
  const peer = path.join(work, 'peer');
  const skill = (name, body) => `---\nname: ${name}\ndescription: Git fixture\n---\n${body}\n`;
  const alphaBase = skill('alpha', 'base');
  const alphaStaged = skill('alpha', 'older staged content');
  const alphaSelected = skill('alpha', 'selected commit');
  const alphaIncoming = skill('alpha', 'incoming pull');
  const betaBase = skill('beta', 'base');
  const betaStaged = skill('beta', 'staged unrelated');
  const betaUnstaged = skill('beta', 'unstaged unrelated');
  await mkdir(gitRoot);
  await git(gitRoot, 'init');
  await git(gitRoot, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(gitRoot, 'config', 'user.name', 'Release Smoke');
  await git(gitRoot, 'config', 'user.email', 'release-smoke@example.invalid');
  await put(path.join(gitRoot, 'alpha', 'SKILL.md'), alphaBase);
  await put(path.join(gitRoot, 'beta', 'SKILL.md'), betaBase);
  await git(gitRoot, 'add', '--all');
  await git(gitRoot, 'commit', '-m', 'fixture base');
  await mkdir(remote);
  await git(remote, 'init', '--bare');
  const gitApproved = await boundary.approveSkillsRoot(gitRoot);
  const remotePreview = await gitApi.previewAddRemote(gitApproved, 'origin', remote);
  successful(await gitApi.addRemoteApproved(gitApproved, remotePreview, remote));
  await git(gitRoot, 'config', 'branch.main.remote', 'origin');
  await git(gitRoot, 'config', 'branch.main.merge', 'refs/heads/main');
  await writeFile(path.join(gitRoot, 'alpha', 'SKILL.md'), alphaStaged);
  await git(gitRoot, 'add', '--', 'alpha/SKILL.md');
  await writeFile(path.join(gitRoot, 'alpha', 'SKILL.md'), alphaSelected);
  await writeFile(path.join(gitRoot, 'beta', 'SKILL.md'), betaStaged);
  await git(gitRoot, 'add', '--', 'beta/SKILL.md');
  await writeFile(path.join(gitRoot, 'beta', 'SKILL.md'), betaUnstaged);
  const betaIndex = await git(gitRoot, 'ls-files', '--stage', '-z', '--', 'beta/SKILL.md');
  const commitPreview = await gitApi.previewCommit(gitApproved, ['alpha/SKILL.md']);
  assert.deepEqual(commitPreview.paths, ['alpha/SKILL.md']);
  successful(await gitApi.commitSelected(gitApproved, commitPreview, 'reviewed alpha'));
  const selectedHead = (await git(gitRoot, 'rev-parse', 'HEAD')).trim();
  assert.equal(await git(gitRoot, 'show', 'HEAD:alpha/SKILL.md'), alphaSelected);
  assert.equal(await git(gitRoot, 'show', ':alpha/SKILL.md'), alphaSelected);
  assert.equal(await git(gitRoot, 'show', 'HEAD:beta/SKILL.md'), betaBase);
  assert.equal(await git(gitRoot, 'show', ':beta/SKILL.md'), betaStaged);
  assert.equal(await git(gitRoot, 'ls-files', '--stage', '-z', '--', 'beta/SKILL.md'), betaIndex);
  assert.equal(await readFile(path.join(gitRoot, 'beta', 'SKILL.md'), 'utf8'), betaUnstaged);
  assert.equal(await git(gitRoot, 'diff', '--cached', '--name-only', '-z'), 'beta/SKILL.md\0');
  assert.equal(await git(gitRoot, 'diff', '--name-only', '-z'), 'beta/SKILL.md\0');
  const push = await gitApi.previewPush(gitApproved, [], 'origin');
  assert.equal(push.head, selectedHead);
  assert.equal(push.destination, 'refs/heads/main');
  assert.equal(push.localRemote.path, remote);
  successful(await gitApi.pushApproved(gitApproved, push));
  assert.equal((await git(remote, 'rev-parse', 'refs/heads/main')).trim(), selectedHead);
  assert.equal(await git(remote, 'show', 'refs/heads/main:alpha/SKILL.md'), alphaSelected);
  assert.equal(await git(remote, 'show', 'refs/heads/main:beta/SKILL.md'), betaBase);
  await git(work, 'clone', '--no-hardlinks', '--branch', 'main', '--single-branch', remote, peer);
  await git(peer, 'config', 'user.name', 'Release Smoke');
  await git(peer, 'config', 'user.email', 'release-smoke@example.invalid');
  await writeFile(path.join(peer, 'alpha', 'SKILL.md'), alphaIncoming);
  await git(peer, 'add', '--', 'alpha/SKILL.md');
  await git(peer, 'commit', '-m', 'incoming alpha');
  const incomingHead = (await git(peer, 'rev-parse', 'HEAD')).trim();
  await git(peer, '-c', 'protocol.file.allow=always', 'push', 'origin', 'HEAD:refs/heads/main');
  const fetch = await gitApi.previewFetch(gitApproved, 'origin', 'main');
  assert.equal(fetch.destination, 'refs/remotes/origin/main');
  successful(await gitApi.fetchApproved(gitApproved, fetch));
  assert.equal((await git(gitRoot, 'rev-parse', 'refs/remotes/origin/main')).trim(), incomingHead);
  const alphaPath = path.join(gitRoot, 'alpha', 'SKILL.md');
  await writeFile(alphaPath, 'temporary edit restored before pull\n');
  await writeFile(alphaPath, alphaSelected);
  await utimes(alphaPath, 1, 1);
  assert.equal(Math.trunc((await stat(alphaPath)).mtimeMs), 1000);
  const indexBeforePull = await readFile(path.join(gitRoot, '.git', 'index'));
  const pull = await gitApi.previewPull(gitApproved, ['alpha']);
  assert.equal(pull.head, selectedHead);
  assert.equal(pull.target, incomingHead);
  assert.deepEqual(pull.paths, ['alpha/SKILL.md']);
  assert.deepEqual(await readFile(path.join(gitRoot, '.git', 'index')), indexBeforePull);
  successful(await gitApi.pullApproved(gitApproved, pull));
  assert.equal((await git(gitRoot, 'rev-parse', 'HEAD')).trim(), incomingHead);
  assert.equal(await git(gitRoot, 'show', ':alpha/SKILL.md'), alphaIncoming);
  assert.equal(await readFile(alphaPath, 'utf8'), alphaIncoming);
  assert.equal(await git(gitRoot, 'show', ':beta/SKILL.md'), betaStaged);
  assert.equal(await git(gitRoot, 'ls-files', '--stage', '-z', '--', 'beta/SKILL.md'), betaIndex);
  assert.equal(await readFile(path.join(gitRoot, 'beta', 'SKILL.md'), 'utf8'), betaUnstaged);
  assert.equal(await git(gitRoot, 'diff', '--cached', '--name-only', '-z'), 'beta/SKILL.md\0');
  assert.equal(await git(gitRoot, 'diff', '--name-only', '-z'), 'beta/SKILL.md\0');
  assert.deepEqual((await readdir(gitRoot)).filter((name) => name.startsWith('.skill-manager-txn-')), []);
  assert.deepEqual(await snapshot(outside), outsideBefore);
  assert.deepEqual(await readFile(externalLock), lockBefore);
  console.log(`Installed release smoke passed on ${process.platform}/${process.arch} (Node ${process.versions.node}).`);
}

try {
  await run();
} finally {
  process.chdir(previousCwd);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  // Never recursively remove a path if the fixture directory was replaced.
  const current = await lstat(work, { bigint: true });
  if (!current.isDirectory() || current.dev !== workIdentity.dev || current.ino !== workIdentity.ino) {
    throw new Error(`Refusing to remove replaced smoke workspace: ${work}`);
  }
  await rm(work, { recursive: true });
}
