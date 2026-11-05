import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xterm from '@xterm/headless';
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

async function inspectRefreshedSession(workspace) {
  const project = path.join(workspace, 'project');
  const projectManifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  assert.equal(projectManifest.dependencies['skills-manager'], `github:ederheisler/skills-manager#${previousEnv.RELEASE_EXPECTED_COMMIT}`);
  assert.equal(projectManifest.dependencies.skills, 'latest');
  assert.equal(projectManifest.overrides.skills, '$skills');
  const resolveProject = createRequire(path.join(project, 'package.json'));
  const appRoot = path.dirname(await realpath(resolveProject.resolve('skills-manager/package.json')));
  const skillsRoot = path.dirname(await realpath(resolveProject.resolve('skills/package.json')));
  assert.ok(appRoot.startsWith(`${project}${path.sep}`));
  assert.ok(skillsRoot.startsWith(`${project}${path.sep}`));
  assert.notEqual(appRoot, installed);
  const appManifest = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  const skillsManifest = JSON.parse(await readFile(path.join(skillsRoot, 'package.json'), 'utf8'));
  assert.equal(appManifest.name, 'skills-manager');
  assert.equal(skillsManifest.name, 'skills');
  const freshBuild = await import(pathToFileURL(path.join(appRoot, 'dist', 'state', 'appBuild.js')).href);
  const identity = await freshBuild.readBuildIdentity();
  assert.equal(identity.version, appManifest.version);
  assert.equal(identity.commit, previousEnv.RELEASE_EXPECTED_COMMIT, 'Refreshed app must retain the approved commit');
  assert.equal(identity.dirty, false);
  const freshSandbox = await import(pathToFileURL(path.join(appRoot, 'dist', 'actions', 'sandbox.js')).href);
  const runtime = await freshSandbox.inspectSkillsRuntime();
  assert.equal(runtime.packageRoot, skillsRoot, 'Refreshed app must select the fresh project root dependency');
  assert.equal(runtime.version, skillsManifest.version);
  assert.equal(runtime.executable, await realpath(runtime.executable));
  assert.ok(runtime.executable.startsWith(`${skillsRoot}${path.sep}`));
}
const localGitPrompt = 'Review optional local Git initialization? [y/N] (q to cancel): ';
const remoteGitPrompt = 'Review optional remote backup? [y/N] (q to cancel): ';
const startupQuestions = ['Review optional local Git initialization?', 'Review optional remote backup?'];
const startupPromptMarkers = [
  'Choose a skills directory.',
  'Choose [',
  'Skills directory path',
  'Manage this resolved target?',
  ...startupQuestions,
];

function startupPrompts(text) {
  return startupPromptMarkers.flatMap((prompt) => {
    const matches = [];
    for (let index = text.indexOf(prompt); index !== -1; index = text.indexOf(prompt, index + prompt.length)) {
      matches.push({ index, prompt });
    }
    return matches;
  }).sort((a, b) => a.index - b.index).map(({ prompt }) => prompt);
}

async function browseInTerminal(skillsDir, { saved = false, refresh = false, explicit = !saved } = {}) {
  const relay = fileURLToPath(new URL('./release-smoke-pty.py', import.meta.url));
  let transcript = '';
  let stderr = '';
  let step = 0;
  let stageStart = 0;
  let failure;
  let updateWorkspace;
  const terminal = new xterm.Terminal({ cols: 140, rows: 40, allowProposedApi: true });
  let pending = Promise.resolve();
  const child = spawn('python3', [relay, cli, ...(explicit ? ['--skills-dir', skillsDir] : [])], {
    cwd: work, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.on('error', () => {});
  terminal.onData((data) => child.stdin.write(data));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.on('error', (error) => { failure = error; });
  const timer = setTimeout(() => {
    failure = new Error('Timed out waiting for the installed CLI help, application updates menu, and quit');
    child.kill('SIGTERM');
  }, refresh ? 900_000 : 90_000);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const processOutput = (chunk) => {
    transcript += chunk;
    if (transcript.length > 4 * 1024 * 1024) {
      failure = new Error('Terminal output exceeded the smoke limit');
      child.kill('SIGTERM');
      return;
    }
    const text = stripVTControlCharacters(transcript.slice(stageStart));
    const buffer = terminal.buffer.active;
    const screen = Array.from({ length: terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n');
    const browse = screen.includes('x app updates') && !screen.includes('Keyboard help')
      && !screen.includes('Application updates');
    if (step <= 2) {
      const prompts = startupPrompts(text);
      const expected = saved ? [] : startupQuestions;
      assert.deepEqual(prompts, expected.slice(0, prompts.length), 'Unexpected startup prompt or prompt order');
      assert.ok(prompts.length <= (saved ? 0 : Math.min(step + 1, expected.length)), 'A startup question appeared before the previous answer');
    }
    if (!saved && step === 0 && text.includes(localGitPrompt)) {
      step = 1;
      child.stdin.write('\n');
    } else if (!saved && step === 1 && text.includes(remoteGitPrompt)) {
      step = 2;
      child.stdin.write('\n');
    } else if (((saved && step === 0) || (!saved && step === 2)) && /Skills\s+1\s+shown/.test(screen) && browse) {
      assert.deepEqual(startupPrompts(text), saved ? [] : startupQuestions, 'Incorrect startup questions before browsing');
      if (!saved) assert.ok(text.includes('Selected skills directory:'), 'The first launch must show its selected directory');
      step = 3;
      stageStart = transcript.length;
      child.stdin.write('?');
    } else if (step === 3 && screen.includes('Keyboard help') && /x\s+Application updates/.test(screen)) {
      step = 4;
      stageStart = transcript.length;
      child.stdin.write('?');
    } else if (step === 4 && browse) {
      step = 5;
      stageStart = transcript.length;
      child.stdin.write('x');
    } else if (step === 5 && screen.includes('Application updates')
      && /skills-manager \(app\)\s*·\s*automatic:\s*off/.test(screen)
      && /Vercel skills CLI\s*·\s*automatic:\s*off/.test(screen)) {
      step = 6;
      stageStart = transcript.length;
      child.stdin.write(refresh ? 'f' : '\x1b');
    } else if (step === 6 && !refresh && browse) {
      step = 7;
      child.stdin.write('q');
    } else if (step === 6 && refresh && screen.includes('Refresh Vercel skills CLI')
      && screen.includes(`Rebuild the same app commit ${previousEnv.RELEASE_EXPECTED_COMMIT}`)
      && screen.includes('[y] Approve')) {
      step = 8;
      stageStart = transcript.length;
      child.stdin.write('y');
    } else if (step === 8) {
      assert.deepEqual(startupPrompts(text), [], 'The refreshed child must not show startup prompts for the unchanged root');
      const marker = 'Starting the new application.';
      const started = text.indexOf(marker);
      const childOutput = started === -1 ? '' : text.slice(started + marker.length);
      if (childOutput.trim() && /Skills\s+1\s+shown/.test(screen) && browse) {
        assert.ok(text.includes('Installing the approved update in a private session.'));
        const match = /Update workspace \(manual cleanup if interrupted\): ("[^\r\n]*")/.exec(text);
        assert.ok(match, 'The update helper must print its workspace before starting the new application');
        updateWorkspace = JSON.parse(match[1]);
        assert.ok(path.isAbsolute(updateWorkspace));
        assert.equal(path.dirname(updateWorkspace), temporary);
        assert.ok(path.basename(updateWorkspace).startsWith('skills-manager-update-'));
        step = 12;
        void inspectRefreshedSession(updateWorkspace).then(() => {
          step = 13;
          stageStart = transcript.length;
          child.stdin.write('?');
        }).catch((error) => {
          failure = error;
          child.kill('SIGTERM');
        });
      }
    } else if (step === 13 && screen.includes('Keyboard help') && /x\s+Application updates/.test(screen)) {
      step = 14;
      stageStart = transcript.length;
      child.stdin.write('?');
    } else if (step === 14 && browse) {
      step = 15;
      stageStart = transcript.length;
      child.stdin.write('x');
    } else if (step === 15 && screen.includes('Application updates')
      && /skills-manager \(app\)\s*·\s*automatic:\s*off/.test(screen)
      && /Vercel skills CLI\s*·\s*automatic:\s*off/.test(screen)) {
      step = 16;
      stageStart = transcript.length;
      child.stdin.write('\x1b');
    } else if (step === 16 && browse) {
      step = 17;
      child.stdin.write('q');
    }
  };
  child.stdout.on('data', (chunk) => {
    pending = pending.then(() => new Promise((resolve) => {
      terminal.write(chunk, () => {
        try { processOutput(chunk); }
        catch (error) { failure = error; child.kill('SIGTERM'); }
        resolve();
      });
    }));
  });
  const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  await pending;
  const finalBuffer = terminal.buffer.active;
  const finalScreen = Array.from({ length: terminal.rows }, (_, row) =>
    finalBuffer.getLine(finalBuffer.viewportY + row)?.translateToString(true) ?? '').join('\n');
  terminal.dispose();
  clearTimeout(timer);
  const evidence = stripVTControlCharacters(transcript).slice(-12000);
  const diagnostic = `PTY step=${step} exit=${result.code} signal=${result.signal}\nstderr:\n${stderr}\nscreen:\n${finalScreen}\nterminal transcript:\n${evidence}`;
  if (failure) throw new Error(`${failure.message}\n${diagnostic}`);
  assert.equal(result.signal, null, diagnostic);
  assert.equal(result.code, 0, `${diagnostic}\nThe approved commit ${previousEnv.RELEASE_EXPECTED_COMMIT ?? '(not applicable)'} must be fetchable from the canonical GitHub repository for the real refresh.`);
  assert.equal(step, refresh ? 17 : 7, `Did not complete the installed PTY ${refresh ? 'refresh and restart' : 'browse'} flow.\n${diagnostic}`);
  if (refresh) await missing(updateWorkspace);
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
  const { readBuildIdentity } = await load('state/appBuild.js');
  const { inspectSkillsRuntime } = await load('actions/sandbox.js');
  const identity = await readBuildIdentity();
  assert.equal(identity.version, manifest.version, 'Installed build identity must use the packaged version');
  if (previousEnv.RELEASE_EXPECTED_COMMIT !== undefined) {
    assert.match(previousEnv.RELEASE_EXPECTED_COMMIT, /^[0-9a-f]{40}$/, 'Expected commit must be a full SHA');
    assert.equal(identity.commit, previousEnv.RELEASE_EXPECTED_COMMIT, 'Installed build identity must match the archived commit');
    assert.equal(identity.source, 'archive', 'CI build identity must come from the archived source');
    assert.equal(identity.dirty, false, 'Archived build identity must be clean');
  }
  const runtime = await inspectSkillsRuntime();
  const resolveInstalled = createRequire(path.join(installed, 'dist', 'actions', 'sandbox.js'));
  const runtimeManifestPath = await realpath(resolveInstalled.resolve('skills/package.json'));
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
  assert.equal(runtimeManifest.name, 'skills');
  assert.equal(runtime.packageRoot, path.dirname(runtimeManifestPath));
  assert.equal(runtime.version, runtimeManifest.version);
  assert.equal(runtime.executable, await realpath(runtime.executable));
  assert.ok(runtime.executable.startsWith(`${runtime.packageRoot}${path.sep}`), 'Skills executable must be inside its package');

  // Adoption is read-only apart from the separate, isolated startup configuration.
  const browseRoot = path.join(work, 'browse');
  const browseText = '---\nname: browse\ndescription: Existing skill\n---\n\n# Existing\n';
  await put(path.join(browseRoot, 'browse', 'SKILL.md'), browseText);
  const browseBefore = await snapshot(browseRoot);
  const configDirectory = path.join(work, 'config');
  const configFile = path.join(configDirectory, 'skills-manager', 'config.json');
  await missing(configFile);
  await browseInTerminal(browseRoot);
  const configBytes = await readFile(configFile);
  const canonicalBrowseRoot = await realpath(browseRoot);
  const configRelative = path.relative(canonicalBrowseRoot, await realpath(configFile));
  assert.ok(configRelative === '..' || configRelative.startsWith(`..${path.sep}`) || path.isAbsolute(configRelative),
    'Saved startup configuration must be outside the selected skills root');
  assert.deepEqual(JSON.parse(configBytes.toString('utf8')), {
    kind: 'skills-manager-setup',
    version: 1,
    selectedPath: browseRoot,
    canonicalRoot: canonicalBrowseRoot,
    identity: (await boundary.approveSkillsRoot(canonicalBrowseRoot)).identity,
  });
  const expectedConfig = [
    ['skills-manager', 'directory'],
    ['skills-manager/config.json', 'file', configBytes.toString('hex')],
  ];
  async function assertBrowseSafety() {
    assert.deepEqual(await snapshot(browseRoot), browseBefore);
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual(await snapshot(configDirectory), expectedConfig);
    for (const name of ['cache', 'data', 'state']) assert.deepEqual(await readdir(path.join(work, name)), []);
    await missing(path.join(browseRoot, '.git'));
    await missing(path.join(browseRoot, '.skills-manager'));
    assert.deepEqual(await snapshot(outside), outsideBefore);
    assert.deepEqual(await readFile(externalLock), lockBefore);
  }
  await assertBrowseSafety();

  // A normal launch without --skills-dir restores the saved root without questions.
  await browseInTerminal(browseRoot, { saved: true });
  await assertBrowseSafety();

  if (previousEnv.RELEASE_EXPECTED_COMMIT !== undefined) {
    // The refresh and its child also reuse the unchanged configuration, even with an explicit root.
    await browseInTerminal(browseRoot, { saved: true, refresh: true, explicit: true });
    await assertBrowseSafety();
  }

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

  // Each preview runs the installed skills CLI inside the real OS sandbox.
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
