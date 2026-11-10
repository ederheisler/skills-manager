import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const project = fileURLToPath(new URL("../../", import.meta.url));
const version = "12.3.4";
const payload = "tracked fixture contents\n";
const unknown = { version, commit: null, dirty: false, source: "unknown" };
const roots: string[] = [];

async function sandbox(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "skills-app-build-")));
  roots.push(root);
  return root;
}

function environment(home: string, withoutGit = false): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: withoutGit ? path.join(home, "no-git") : process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
}

async function sourceFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src", "state"), { recursive: true });
  for (const name of ["build-identity.mjs", "build-identity.template"]) {
    await cp(path.join(project, "scripts", name), path.join(root, "scripts", name));
  }
  // A fresh fixture needs placeholders even when this test runs from a Git archive.
  await writeFile(path.join(root, "scripts", "build-identity.template"), "$Format:%H$\n$Format:%T$\n");
  await cp(path.join(project, ".gitattributes"), path.join(root, ".gitattributes"));
  await cp(path.join(project, "src", "state", "appBuild.ts"), path.join(root, "src", "state", "appBuild.ts"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "identity-fixture", version, type: "module" }));
  await writeFile(path.join(root, ".gitignore"), "/dist/\n/node_modules\n");
  await writeFile(path.join(root, "src", "payload.txt"), payload);
}

async function productionBuildFixture(root: string): Promise<void> {
  await sourceFixture(root);
  for (const name of ["build.mjs", "check-package.mjs"]) {
    await cp(path.join(project, "scripts", name), path.join(root, "scripts", name));
  }
  for (const name of ["tsconfig.json", "LICENSE", "THIRD_PARTY_NOTICES"]) {
    await cp(path.join(project, name), path.join(root, name));
  }
  await symlink(path.join(project, "node_modules"), path.join(root, "node_modules"), "dir");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "identity-fixture",
    version,
    type: "module",
    files: [
      "dist/state/appBuild.js",
      "dist/state/buildIdentity.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES",
    ],
    scripts: { build: "node scripts/build.mjs" },
  }));
}

async function git(root: string, home: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, env: environment(home) });
  return stdout.trim();
}

async function commitFixture(root: string, home: string): Promise<{ commit: string; tree: string }> {
  await git(root, home, "init", "-q");
  await git(root, home, "add", "--all");
  await git(root, home, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return {
    commit: await git(root, home, "rev-parse", "HEAD"),
    tree: await git(root, home, "rev-parse", "HEAD^{tree}"),
  };
}

async function extractArchive(source: string, destination: string, home: string): Promise<void> {
  const archive = path.join(home, "fixture.tar");
  await git(source, home, "archive", "--format=tar", `--output=${archive}`, "HEAD");
  await mkdir(destination, { recursive: true });
  await run("tar", ["-xf", archive, "-C", destination], { env: environment(home) });
}

async function prepareRuntime(root: string): Promise<void> {
  await mkdir(path.join(root, "dist", "state"), { recursive: true });
  await cp(path.join(root, "src", "state", "appBuild.ts"), path.join(root, "dist", "state", "appBuild.ts"));
}

async function generate(root: string, home: string, withoutGit = false, cwd = home): Promise<void> {
  const module = pathToFileURL(path.join(root, "scripts", "build-identity.mjs")).href;
  // The fixture generator is selected at runtime, independently of the caller's cwd.
  const generator = "const { captureBuildIdentity, writeBuildIdentity } = await import(process.argv[1]); const { identity } = await captureBuildIdentity(); await writeBuildIdentity(identity);";
  await run(process.execPath, ["--input-type=module", "-e", generator, module], { cwd, env: environment(home, withoutGit) });
}

async function readIdentity(root: string, home: string, cwd = home): Promise<unknown> {
  const module = pathToFileURL(path.join(root, "dist", "state", "appBuild.ts")).href;
  // The fixture module is selected at runtime and must be loaded in a fresh Node process.
  const consumer = "const { readBuildIdentity } = await import(process.argv[1]); process.stdout.write(JSON.stringify(await readBuildIdentity()));";
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", consumer, module], { cwd, env: environment(home, true) });
  return JSON.parse(stdout);
}

async function readCompiledBuild(root: string, home: string): Promise<unknown> {
  const module = pathToFileURL(path.join(root, "dist", "state", "appBuild.js")).href;
  // The compiled fixture is selected at runtime and loaded in a fresh Node process.
  const consumer = "const { buildMarker, readBuildIdentity } = await import(process.argv[1]); process.stdout.write(JSON.stringify({ marker: buildMarker, identity: await readBuildIdentity() }));";
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", consumer, module], { cwd: home, env: environment(home, true) });
  return JSON.parse(stdout);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("application build identity", () => {
  it("records the exact checkout commit and tracked, staged, and untracked changes independently of cwd", async () => {
    const home = await sandbox();
    const root = path.join(home, "checkout");
    await sourceFixture(root);
    const { commit } = await commitFixture(root, home);
    await prepareRuntime(root);

    const other = path.join(home, "other-cwd");
    await mkdir(path.join(other, "dist", "state"), { recursive: true });
    await writeFile(path.join(other, "package.json"), JSON.stringify({ version: "99.9.9", type: "module" }));
    const decoy = JSON.stringify({ commit: "b".repeat(40), dirty: true, source: "git" });
    await writeFile(path.join(other, "buildIdentity.json"), decoy);
    await writeFile(path.join(other, "dist", "state", "buildIdentity.json"), decoy);

    await generate(root, home, false, other);
    expect(await readIdentity(root, home, other)).toEqual({ version, commit, dirty: false, source: "git" });

    await writeFile(path.join(root, "src", "payload.txt"), "modified tracked content\n");
    await generate(root, home);
    expect(await readIdentity(root, home)).toEqual({ version, commit, dirty: true, source: "git" });

    await git(root, home, "add", "src/payload.txt");
    await generate(root, home);
    expect(await readIdentity(root, home)).toEqual({ version, commit, dirty: true, source: "git" });

    await writeFile(path.join(root, "src", "payload.txt"), payload);
    await generate(root, home);
    expect(await readIdentity(root, home)).toEqual({ version, commit, dirty: true, source: "git" });

    await git(root, home, "add", "src/payload.txt");
    await generate(root, home);
    expect(await readIdentity(root, home)).toEqual({ version, commit, dirty: false, source: "git" });

    await writeFile(path.join(root, "untracked.txt"), "new file\n");
    await generate(root, home);
    expect(await readIdentity(root, home)).toEqual({ version, commit, dirty: true, source: "git" });
  }, 30_000);

  it("ignores local tool artifacts but still marks untracked build inputs dirty", async () => {
    const home = await sandbox();
    const checkout = path.join(home, "checkout");
    const archive = path.join(home, "archive");
    await sourceFixture(checkout);
    const { commit } = await commitFixture(checkout, home);
    await extractArchive(checkout, archive, home);

    for (const fixture of [
      { root: checkout, source: "git", withoutGit: false },
      { root: archive, source: "archive", withoutGit: true },
    ]) {
      await prepareRuntime(fixture.root);
      for (const name of [
        ".DS_Store",
        "src/state/.DS_Store",
        ".claude/settings.json",
        ".claude/scheduled_tasks.lock",
        "graphify-out/cache/entry.json",
        "graphify-out/manifest.json",
        "graphify-out/.graphify_detect.json",
        "graphify-out/nested/cost.json",
        "graphify-out/2026-11-05/snapshot.json",
      ]) {
        const file = path.join(fixture.root, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "local tool artifact\n");
      }
      const skills = path.join(fixture.root, ".claude", "skills");
      await mkdir(skills, { recursive: true });
      await symlink(path.join(home, "external-opentui"), path.join(skills, "opentui"), "dir");

      await generate(fixture.root, home, fixture.withoutGit);
      expect(await readIdentity(fixture.root, home)).toEqual({
        version, commit, dirty: false, source: fixture.source,
      });
      await writeFile(path.join(fixture.root, "src", "untracked-input.ts"), "export const input = 1;\n");
      await generate(fixture.root, home, fixture.withoutGit);
      expect(await readIdentity(fixture.root, home)).toEqual({
        version, commit, dirty: true, source: fixture.source,
      });
    }
  }, 45_000);

  it("invalidates clean metadata on a failed rebuild or a source change during compilation", async () => {
    const home = await sandbox();
    const root = path.join(home, "checkout");
    await productionBuildFixture(root);
    const source = path.join(root, "src", "state", "appBuild.ts");
    const original = await readFile(source, "utf8");
    await writeFile(source, `${original}\nexport const buildMarker = "A";\n`);
    const { commit: commitA } = await commitFixture(root, home);

    await writeFile(source, `${original}\nexport const buildMarker = "B";\n`);
    await git(root, home, "add", "src/state/appBuild.ts");
    await git(root, home, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture B");
    const commitB = await git(root, home, "rev-parse", "HEAD");
    expect(commitB).not.toBe(commitA);
    await git(root, home, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", commitA);

    const buildEnv = {
      ...environment(home),
      PATH: [path.join(project, "node_modules", ".bin"), process.env.PATH ?? ""].join(path.delimiter),
    };
    const build = (env: NodeJS.ProcessEnv) => run(process.execPath, [path.join(root, "scripts", "build.mjs")], {
      cwd: root, env, timeout: 90_000, maxBuffer: 10 * 1024 * 1024,
    });
    await build(buildEnv);
    expect(await readCompiledBuild(root, home)).toEqual({
      marker: "A", identity: { version, commit: commitA, dirty: false, source: "git" },
    });

    const output = path.join(root, "dist", "state", "appBuild.js");
    const compiledA = await readFile(output, "utf8");
    await writeFile(source, `${original}\nexport const buildMarker = "failed";\nconst invalid: number = "not a number";\n`);
    await expect(build(buildEnv)).rejects.toThrow();
    expect(await readFile(output, "utf8")).not.toBe(compiledA);
    expect(await readCompiledBuild(root, home)).toEqual({ marker: "failed", identity: unknown });
    await writeFile(source, `${original}\nexport const buildMarker = "A";\n`);

    const bin = path.join(home, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "tsc"), [
      "#!/bin/sh",
      '"$FIXTURE_NODE" "$FIXTURE_TSC" "$@" || exit $?',
      'git -C "$FIXTURE_REPOSITORY" -c core.hooksPath=/dev/null checkout --quiet --detach "$FIXTURE_COMMIT_B"',
      "",
    ].join("\n"), { mode: 0o755 });
    await build({
      ...buildEnv,
      PATH: [bin, buildEnv.PATH].join(path.delimiter),
      FIXTURE_NODE: process.execPath,
      FIXTURE_TSC: path.join(project, "node_modules", "typescript", "bin", "tsc"),
      FIXTURE_REPOSITORY: root,
      FIXTURE_COMMIT_B: commitB,
    });
    expect(await git(root, home, "rev-parse", "HEAD")).toBe(commitB);
    expect(await readFile(source, "utf8")).toBe(`${original}\nexport const buildMarker = "B";\n`);
    expect(await readCompiledBuild(root, home)).toEqual({ marker: "A", identity: unknown });
  }, 300_000);

  it("uses a real Git archive's substituted commit and tree, detects tampering, and needs no Git executable", async () => {
    const home = await sandbox();
    const checkout = path.join(home, "checkout");
    const archive = path.join(home, "archive");
    await sourceFixture(checkout);
    const { commit, tree } = await commitFixture(checkout, home);
    await extractArchive(checkout, archive, home);
    expect((await readFile(path.join(archive, "scripts", "build-identity.template"), "utf8")).trim().split("\n"))
      .toEqual([commit, tree]);
    await prepareRuntime(archive);

    await mkdir(path.join(archive, ".git"));
    await writeFile(path.join(archive, ".git", "generated"), "generated\n");
    await mkdir(path.join(archive, "node_modules", "generated"), { recursive: true });
    await writeFile(path.join(archive, "node_modules", "generated", "index.js"), "generated\n");
    await writeFile(path.join(archive, "dist", "generated.js"), "generated\n");
    await generate(archive, home, true);
    expect(await readIdentity(archive, home)).toEqual({ version, commit, dirty: false, source: "archive" });

    await writeFile(path.join(archive, "src", "payload.txt"), "tampered content\n");
    await generate(archive, home, true);
    expect(await readIdentity(archive, home)).toEqual({ version, commit, dirty: true, source: "archive" });

    await rm(path.join(archive, "src", "payload.txt"));
    await generate(archive, home, true);
    expect(await readIdentity(archive, home)).toEqual({ version, commit, dirty: true, source: "archive" });

    await writeFile(path.join(archive, "src", "payload.txt"), payload);
    await writeFile(path.join(archive, "extra.txt"), "untracked archive content\n");
    await generate(archive, home, true);
    expect(await readIdentity(archive, home)).toEqual({ version, commit, dirty: true, source: "archive" });

    await rm(path.join(archive, "extra.txt"));
    await mkdir(path.join(archive, "src", "node_modules"), { recursive: true });
    await writeFile(path.join(archive, "src", "node_modules", "extra.js"), "nested source content\n");
    await generate(archive, home, true);
    expect(await readIdentity(archive, home)).toEqual({ version, commit, dirty: true, source: "archive" });
  }, 45_000);

  it("marks an archive dirty when a tracked symlink is omitted during extraction", async () => {
    const home = await sandbox();
    const checkout = path.join(home, "checkout");
    const archive = path.join(home, "archive");
    await sourceFixture(checkout);
    await symlink("payload.txt", path.join(checkout, "src", "unrelated-link"));
    const { commit } = await commitFixture(checkout, home);
    await extractArchive(checkout, archive, home);
    await prepareRuntime(archive);

    const extractedLink = path.join(archive, "src", "unrelated-link");
    expect((await lstat(extractedLink)).isSymbolicLink()).toBe(true);
    await generate(archive, home, true);
    expect(await readIdentity(archive, home)).toEqual({ version, commit, dirty: false, source: "archive" });

    // Model an extractor dropping a link; this does not run npm.
    await rm(extractedLink);
    await generate(archive, home, true);
    expect(await readIdentity(archive, home)).toEqual({ version, commit, dirty: true, source: "archive" });
  }, 30_000);

  it("does not attribute a copied source or archive to an enclosing unrelated repository", async () => {
    const home = await sandbox();
    const outer = path.join(home, "unrelated");
    await mkdir(outer);
    await writeFile(path.join(outer, "unrelated.txt"), "outer repository\n");
    const unrelated = await commitFixture(outer, home);

    const copied = path.join(outer, "copied-source");
    await sourceFixture(copied);
    await prepareRuntime(copied);
    await generate(copied, home, false, outer);
    expect(await readIdentity(copied, home, outer)).toEqual(unknown);

    const checkout = path.join(home, "checkout");
    await sourceFixture(checkout);
    const { commit, tree } = await commitFixture(checkout, home);
    expect(commit).not.toBe(unrelated.commit);
    const archived = path.join(outer, "archived-source");
    await extractArchive(checkout, archived, home);
    expect((await readFile(path.join(archived, "scripts", "build-identity.template"), "utf8")).trim().split("\n"))
      .toEqual([commit, tree]);
    await prepareRuntime(archived);
    await generate(archived, home, false, outer);
    expect(await readIdentity(archived, home, outer)).toEqual({ version, commit, dirty: false, source: "archive" });
  }, 30_000);

  it("reports unknown when Git is unavailable for a checkout with unsubstituted metadata", async () => {
    const home = await sandbox();
    const root = path.join(home, "checkout");
    await sourceFixture(root);
    await commitFixture(root, home);
    await prepareRuntime(root);
    await generate(root, home, true);
    expect(await readIdentity(root, home)).toEqual(unknown);
  }, 30_000);

  it("reports unknown for missing, unsubstituted, or malformed archive templates", async () => {
    const home = await sandbox();
    const root = path.join(home, "source");
    await sourceFixture(root);
    await prepareRuntime(root);
    const template = path.join(root, "scripts", "build-identity.template");
    for (const content of [
      "$Format:%H$\n$Format:%T$\n",
      "not-a-commit\nnot-a-tree\n",
      `${"a".repeat(40)}\n$Format:%T$\n`,
      `${"a".repeat(40)}\n${"b".repeat(39)}\n`,
    ]) {
      await writeFile(template, content);
      await generate(root, home, true);
      expect(await readIdentity(root, home)).toEqual(unknown);
    }
    await rm(template);
    await generate(root, home, true);
    expect(await readIdentity(root, home)).toEqual(unknown);
  }, 30_000);

  it("returns unknown for missing, malformed, or inconsistent runtime metadata", async () => {
    const home = await sandbox();
    const root = path.join(home, "source");
    await sourceFixture(root);
    await prepareRuntime(root);
    const asset = path.join(root, "dist", "state", "buildIdentity.json");
    expect(await readIdentity(root, home)).toEqual(unknown);
    await writeFile(asset, "{invalid JSON");
    expect(await readIdentity(root, home)).toEqual(unknown);

    const sha = "a".repeat(40);
    for (const value of [
      null,
      [],
      {},
      { commit: sha, source: "git" },
      { dirty: false, source: "git" },
      { commit: sha, dirty: false },
      { commit: "$Format:%H$", dirty: false, source: "git" },
      { commit: "a".repeat(39), dirty: false, source: "git" },
      { commit: "g".repeat(40), dirty: false, source: "git" },
      { commit: "A".repeat(40), dirty: false, source: "git" },
      { commit: null, dirty: false, source: "git" },
      { commit: sha, dirty: "false", source: "git" },
      { commit: sha, dirty: false, source: "other" },
      { commit: sha, dirty: false, source: "unknown" },
      { commit: null, dirty: true, source: "unknown" },
      { commit: null, dirty: false, source: "archive" },
    ]) {
      await writeFile(asset, JSON.stringify(value));
      expect(await readIdentity(root, home)).toEqual(unknown);
    }
  }, 30_000);

  it("refuses to follow an existing metadata output symlink", async () => {
    const home = await sandbox();
    const root = path.join(home, "source");
    await sourceFixture(root);
    await prepareRuntime(root);
    const outside = path.join(home, "outside-sentinel");
    const asset = path.join(root, "dist", "state", "buildIdentity.json");
    await writeFile(outside, "outside unchanged\n");
    await symlink(outside, asset);
    await expect(generate(root, home, true)).rejects.toThrow();
    expect((await lstat(asset)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside unchanged\n");
  }, 30_000);
});
