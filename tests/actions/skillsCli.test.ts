import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { approveSkillsRoot, listSkillPaths } from "../../src/actions/boundary.js";
import { runConfinedSkills } from "../../src/actions/sandbox.js";
import { applyPreparedChange, discardPreparedChange, prepareAdd } from "../../src/actions/skillsCli.js";

const roots: string[] = [];

async function fixture(): Promise<{ base: string; skills: string; source: string; sentinel: string; lock: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-adapter-test-")));
  roots.push(base);
  const skills = path.join(base, "selected");
  const source = path.join(base, "source");
  const sentinel = path.join(base, "outside.txt");
  const lock = path.join(base, ".skill-lock.json");
  await mkdir(skills);
  await mkdir(path.join(source, "example"), { recursive: true });
  await writeFile(path.join(source, "example", "SKILL.md"), "---\nname: example\ndescription: Example fixture\n---\n\n# Example\n");
  await writeFile(path.join(source, "example", "instructions.txt"), "safe fixture\n");
  await writeFile(sentinel, "unchanged");
  await writeFile(lock, "external lock unchanged");
  return { base, skills, source, sentinel, lock };
}


afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("approved subtree listing", () => {
  it("lists only the selected subtree, with paths relative to it and the requested hidden policy", async () => {
    const { skills, sentinel } = await fixture();
    const selected = path.join(skills, ".disabled_skills", "example");
    const unrelated = path.join(skills, "unrelated");
    await mkdir(path.join(selected, "docs"), { recursive: true });
    await mkdir(path.join(selected, ".hidden"));
    await mkdir(path.join(selected, "__pycache__"));
    await mkdir(unrelated);
    await writeFile(path.join(selected, "SKILL.md"), "selected");
    await writeFile(path.join(selected, "docs", "guide.txt"), "guide");
    await writeFile(path.join(selected, ".hidden", "private.txt"), "hidden");
    await writeFile(path.join(selected, "__pycache__", "cached"), "cache");
    await symlink(sentinel, path.join(selected, "outside-link"));
    execFileSync("mkfifo", [path.join(unrelated, "unsupported")]);
    const root = await approveSkillsRoot(skills);

    const visible = await listSkillPaths(skills, { expectedRoot: root, relativePath: ".disabled_skills/example" });
    expect(visible.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
      "directory:docs", "file:SKILL.md", "file:docs/guide.txt", "symlink:outside-link",
    ].sort());

    const all = await listSkillPaths(skills, { expectedRoot: root, relativePath: ".disabled_skills/example", includeHidden: true });
    expect(all.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
      "directory:.hidden", "directory:__pycache__", "directory:docs",
      "file:.hidden/private.txt", "file:SKILL.md", "file:__pycache__/cached", "file:docs/guide.txt",
      "symlink:outside-link",
    ].sort());

    // A whole-root traversal reaches the unrelated FIFO and must fail.
    await expect(listSkillPaths(skills, { expectedRoot: root })).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  });

  it("preserves whole-root listing when no subtree is specified", async () => {
    const { skills } = await fixture();
    await mkdir(path.join(skills, "example"));
    await writeFile(path.join(skills, "example", "SKILL.md"), "content");
    await writeFile(path.join(skills, ".hidden"), "hidden");
    const root = await approveSkillsRoot(skills);
    const entries = await listSkillPaths(skills, { expectedRoot: root });
    expect(entries.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
      "directory:example", "file:example/SKILL.md",
    ].sort());
    await expect(listSkillPaths(skills, { relativePath: "example" })).resolves.toEqual([
      { path: "SKILL.md", kind: "file" },
    ]);
  });

  it("rejects symlink and non-directory components without entering their targets", async () => {
    const { skills, source, sentinel } = await fixture();
    await mkdir(path.join(skills, "real"));
    await writeFile(path.join(skills, "real", "file"), "not a directory");
    await symlink(source, path.join(skills, "link"), "dir");
    await symlink(source, path.join(skills, "real", "link"), "dir");
    const root = await approveSkillsRoot(skills);

    for (const relativePath of ["link", "link/example", "real/link", "real/link/example", "real/file", "real/file/child"]) {
      await expect(listSkillPaths(skills, { expectedRoot: root, relativePath })).rejects.toThrow();
    }
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(await readFile(path.join(source, "example", "instructions.txt"), "utf8")).toBe("safe fixture\n");
  });

  it("rejects empty, absolute, non-normalized, reserved, and traversing subtree names", async () => {
    const { skills } = await fixture();
    await mkdir(path.join(skills, "example"));
    const root = await approveSkillsRoot(skills);
    for (const relativePath of [
      "", ".", "..", "/example", "../example", "./example", "example/..",
      "example/../example", "example/./child", "example//child", "example/",
      ".skills-manager", "example/\nchild",
    ]) {
      await expect(listSkillPaths(skills, { expectedRoot: root, relativePath })).rejects.toThrow();
    }
    await mkdir(path.join(skills, "-"));
    await expect(listSkillPaths(skills, { expectedRoot: root, relativePath: "-" })).resolves.toEqual([]);
  });

  it("rejects a replaced or mismatched approved root", async () => {
    const { base, skills, source } = await fixture();
    await mkdir(path.join(skills, "example"));
    await writeFile(path.join(skills, "example", "inside"), "original");
    const root = await approveSkillsRoot(skills);
    const other = await approveSkillsRoot(source);
    await expect(listSkillPaths(skills, { expectedRoot: other, relativePath: "example" }))
      .rejects.toThrow();

    await rename(skills, path.join(base, "original-selected"));
    await mkdir(path.join(skills, "example"), { recursive: true });
    await writeFile(path.join(skills, "example", "outside"), "replacement");
    await expect(listSkillPaths(skills, { expectedRoot: root, relativePath: "example" }))
      .rejects.toMatchObject({ code: "ESTALE" });
    expect(await readFile(path.join(base, "original-selected", "example", "inside"), "utf8")).toBe("original");
  });

  it("does not follow an ancestor swapped for a symlink during listing", async () => {
    const { base, skills, source } = await fixture();
    const ancestor = path.join(skills, "folder");
    const parked = path.join(skills, "parked");
    await mkdir(path.join(ancestor, "selected"), { recursive: true });
    await writeFile(path.join(ancestor, "selected", "inside"), "inside");
    await mkdir(path.join(source, "selected"));
    await writeFile(path.join(source, "selected", "outside-secret"), "outside");
    const root = await approveSkillsRoot(skills);
    await expect(listSkillPaths(skills, { expectedRoot: root, relativePath: "folder/selected" }))
      .resolves.toEqual([{ path: "inside", kind: "file" }]);

    let stopped = false;
    let swaps = 0;
    const swapping = (async () => {
      while (!stopped) {
        await rename(ancestor, parked);
        let linked = false;
        try {
          await symlink(source, ancestor, "dir");
          linked = true;
          swaps++;
          await delay(1);
        } finally {
          if (linked) await unlink(ancestor);
          await rename(parked, ancestor);
        }
        await delay(1);
      }
    })();
    try {
      for (let i = 0; i < 30; i++) {
        const entries = await listSkillPaths(skills, { expectedRoot: root, relativePath: "folder/selected" }).catch(() => null);
        if (entries) expect(entries).toEqual([{ path: "inside", kind: "file" }]);
      }
    } finally {
      stopped = true;
      await swapping;
    }
    expect(swaps).toBeGreaterThan(0);
    expect(await readFile(path.join(source, "selected", "outside-secret"), "utf8")).toBe("outside");
    expect(await readFile(path.join(base, "outside.txt"), "utf8")).toBe("unchanged");
  }, 30000);

  it.skipIf(process.platform !== "linux")("rejects both final and intermediate mount crossings", async (context) => {
    const proc = await stat("/proc").catch(() => null);
    const rootStat = await stat("/");
    if (!proc || proc.dev === rootStat.dev) context.skip("No separate proc mount is available");
    const root = await approveSkillsRoot("/");
    for (const relativePath of ["proc", "proc/self"]) {
      await expect(listSkillPaths("/", { expectedRoot: root, relativePath }))
        .rejects.toMatchObject({ code: "EXDEV" });
    }
  });
});


describe("installed skills runtime", () => {
  it("inspects the canonical installed package and executable against its manifest", async () => {
    // Exercise the dynamic import boundary used by installed app updates.
    const { inspectSkillsRuntime } = await import("../../src/actions/sandbox.js");
    const manifestPath = await realpath(fileURLToPath(import.meta.resolve("skills/package.json")));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string;
      version: string;
      bin: string | { skills: string };
    };
    const root = path.dirname(manifestPath);
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.skills;

    expect(manifest.name).toBe("skills");
    expect(await inspectSkillsRuntime()).toEqual({
      version: manifest.version,
      packageRoot: root,
      executable: await realpath(path.resolve(root, bin)),
    });
  });

  it("rejects a package bin pointing to a directory and accepts a readable non-executable script", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-runtime-test-")));
    roots.push(base);
    const actions = path.join(base, "actions");
    const state = path.join(base, "state");
    const packageRoot = path.join(base, "node_modules", "skills");
    const executable = path.join(packageRoot, "nested", "cli");
    await Promise.all([
      mkdir(actions, { recursive: true }),
      mkdir(state, { recursive: true }),
      mkdir(executable, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(base, "package.json"), JSON.stringify({ type: "module" })),
      writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "skills", version: "1.2.3", bin: { skills: "nested/cli" } })),
      ...(["actions/sandbox", "state/validation"] as const).map(async (module) => {
        const source = await readFile(new URL(`../../src/${module}.ts`, import.meta.url), "utf8");
        await writeFile(path.join(base, `${module}.js`), stripTypeScriptTypes(source));
      }),
    ]);
    // Load the copied module in Node so import.meta.resolve uses the fixture package.
    const inspect = () => JSON.parse(execFileSync(process.execPath, [
      "--input-type=module", "-e",
      `try {
        const { inspectSkillsRuntime } = await import(process.argv[1]);
        console.log(JSON.stringify({ runtime: await inspectSkillsRuntime() }));
      } catch (error) {
        console.log(JSON.stringify({ error: error.message }));
      }`,
      pathToFileURL(path.join(actions, "sandbox.js")).href,
    ], { encoding: "utf8" })) as { error?: string; runtime?: unknown };

    expect(inspect()).toEqual({ error: "The installed skills package has an invalid executable entry." });

    await rm(executable, { recursive: true });
    await writeFile(executable, "#!/usr/bin/env node\n");
    await chmod(executable, 0o644);
    expect((await stat(executable)).mode & 0o111).toBe(0);
    expect(inspect()).toEqual({
      runtime: { version: "1.2.3", packageRoot, executable },
    });
  });
});

describe("confined staged installation", () => {
  it("previews real installer output before importing into only the selected root", async () => {
    const { skills, source, sentinel, lock } = await fixture();
    const preview = await prepareAdd(await approveSkillsRoot(skills), source);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0].destination).toBe(path.join(skills, "example"));
    expect(preview.changes[0].review).toContain("safe fixture");
    await expect(readFile(path.join(skills, "example", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await applyPreparedChange(preview);
    expect(await readFile(path.join(skills, "example", "instructions.txt"), "utf8")).toBe("safe fixture\n");
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(await readFile(lock, "utf8")).toBe("external lock unchanged");
    await expect(readFile(path.join(preview.workspace, "home", ".agents", "skills", "example", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a real source and skill whose names contain failed", async () => {
    const { base, skills, source } = await fixture();
    const failedSource = path.join(base, "failed-source");
    await rename(source, failedSource);
    await rename(path.join(failedSource, "example"), path.join(failedSource, "failed"));
    await writeFile(path.join(failedSource, "failed", "SKILL.md"), "---\nname: failed\ndescription: Fixture\n---\n");
    const preview = await prepareAdd(await approveSkillsRoot(skills), failedSource);
    expect(preview.changes.map((change) => change.name)).toEqual(["failed"]);
    await discardPreparedChange(preview);
  });

  it("does not install a declined preview or overwrite a collision", async () => {
    const { skills, source, sentinel, lock } = await fixture();
    const root = await approveSkillsRoot(skills);
    const preview = await prepareAdd(root, source);
    await discardPreparedChange(preview);
    await expect(readFile(path.join(skills, "example", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path.join(skills, ".disabled_skills", "example"), { recursive: true });
    await writeFile(path.join(skills, ".disabled_skills", "example", "SKILL.md"), "original");
    await expect(prepareAdd(root, source)).rejects.toThrow(/already exists/);
    expect(await readFile(path.join(skills, ".disabled_skills", "example", "SKILL.md"), "utf8")).toBe("original");
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(await readFile(lock, "utf8")).toBe("external lock unchanged");
  });

  it("refuses unsafe staged links and leaves the outside target untouched", async () => {
    const { skills, source, sentinel } = await fixture();
    await symlink(sentinel, path.join(source, "example", "outside-link"));
    await expect(prepareAdd(await approveSkillsRoot(skills), source)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    await expect(readFile(path.join(skills, "example", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps ambient home, XDG, temporary paths and Node options out of the real installer", async () => {
    const { base, source, sentinel, lock } = await fixture();
    const workspace = path.join(base, "isolated-workspace");
    const ambient = path.join(base, "ambient");
    for (const parent of [workspace, ambient]) {
      for (const name of ["home", "config", "cache", "data", "state", "tmp"]) {
        await mkdir(path.join(parent, name), { recursive: true });
      }
    }
    const ambientSkill = path.join(ambient, "home", ".agents", "skills", "example");
    await mkdir(ambientSkill, { recursive: true });
    await writeFile(path.join(ambientSkill, "SKILL.md"), "ambient skill unchanged");
    const environment: Record<string, string> = {
      HOME: path.join(ambient, "home"),
      XDG_CONFIG_HOME: path.join(ambient, "config"),
      XDG_CACHE_HOME: path.join(ambient, "cache"),
      XDG_DATA_HOME: path.join(ambient, "data"),
      XDG_STATE_HOME: path.join(ambient, "state"),
      TMPDIR: path.join(ambient, "tmp"),
      NODE_OPTIONS: `--require=${path.join(ambient, "missing.cjs")}`,
    };
    const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
    let output: { stdout: string; stderr: string };
    try {
      Object.assign(process.env, environment);
      const sourceArgument = process.platform === "linux" ? "/source" : source;
      output = await runConfinedSkills(workspace,
        ["add", sourceArgument, "-g", "-y", "--agent", "codex", "--copy", "--json", "--full-depth"], source);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(JSON.parse(output.stdout)).toMatchObject([{ name: "example", status: "installed" }]);
    expect(await readFile(path.join(workspace, "home", ".agents", "skills", "example", "instructions.txt"), "utf8")).toBe("safe fixture\n");
    expect(await readFile(path.join(ambientSkill, "SKILL.md"), "utf8")).toBe("ambient skill unchanged");
    for (const name of ["config", "cache", "data", "state", "tmp"]) {
      expect(await readdir(path.join(ambient, name))).toEqual([]);
    }
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(await readFile(lock, "utf8")).toBe("external lock unchanged");
  });

  it("denies real CLI reads and writes outside its private workspace", async () => {
    const { base } = await fixture();
    const workspace = path.join(base, "isolated-workspace");
    const outside = path.join(base, "unapproved-source");
    await mkdir(workspace);
    for (const name of ["home", "config", "cache", "data", "state", "tmp"]) await mkdir(path.join(workspace, name));
    await mkdir(outside);
    await writeFile(path.join(outside, "SKILL.md"), "---\nname: restricted-skill-marker\ndescription: private\n---\n");

    let output = "";
    try {
      const result = await runConfinedSkills(workspace, ["add", outside, "--list"]);
      output = result.stdout + result.stderr;
    } catch (error) {
      output = String(error);
    }
    expect(output).not.toContain("restricted-skill-marker");
    const source = path.join(workspace, "source");
    const inside = path.join(workspace, "inside-destination");
    const destination = path.join(workspace, "home", ".agents", "skills");
    await mkdir(source);
    await mkdir(inside);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: boundary-control\ndescription: control\n---\n\ncontrol content\n");
    await symlink("../../inside-destination", destination, "dir");
    const args = ["add", "./source", "-g", "-y", "--agent", "codex", "--copy", "--json", "--full-depth"];
    const control = await runConfinedSkills(workspace, args);
    expect(JSON.parse(control.stdout)).toMatchObject([{ name: "boundary-control", status: "installed" }]);
    expect(await readFile(path.join(inside, "boundary-control", "SKILL.md"), "utf8")).toContain("control content");

    await unlink(destination);
    await symlink("../../../unapproved-source", destination, "dir");
    await expect(runConfinedSkills(workspace, args)).rejects.toThrow();
    await expect(readFile(path.join(outside, "boundary-control", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outside)).toEqual(["SKILL.md"]);
    expect(await readFile(path.join(outside, "SKILL.md"), "utf8")).toBe("---\nname: restricted-skill-marker\ndescription: private\n---\n");
  });
});
