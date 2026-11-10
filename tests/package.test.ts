import { execFile } from "node:child_process";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

describe("Node release artifact", () => {
  it("packs only reviewed files and refuses an unlisted compiled module", async () => {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "skills-package-")));
    const source = path.join(temporary, "source");
    await mkdir(source);
    const env = {
      ...process.env,
      HOME: temporary,
      npm_config_userconfig: path.join(temporary, "empty-npmrc"),
      npm_config_cache: path.join(temporary, "npm-cache"),
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      CC: path.join(temporary, "compiler-must-not-run"),
    };

    try {
      for (const name of ["src", "scripts", "package.json", "tsconfig.json", "LICENSE", "THIRD_PARTY_NOTICES", "README.md"]) {
        await cp(path.join(project, name), path.join(source, name), { recursive: true });
      }
      const template = path.join(source, "scripts", "build-identity.template");
      expect((await lstat(template)).isFile()).toBe(true);
      // This copied fixture is unsourced, even when the test itself runs from an archive.
      await writeFile(template, "$Format:%H$\n$Format:%T$\n");
      await symlink(path.join(project, "node_modules"), path.join(source, "node_modules"), "dir");
      await mkdir(path.join(source, "dist", "actions"), { recursive: true });
      await mkdir(path.join(source, ".claude"));
      await writeFile(path.join(source, ".claude", "settings.json"), "private settings\n");
      await writeFile(path.join(source, "private-backup.txt"), "private backup\n");
      await writeFile(path.join(source, "dist", "actions", "personal.js"), "private generated file\n");

      for (const name of ["README.private", "readme.private", "LICENSE.private", "LICENCE.private", "COPYING.private", "COPYING"]) {
        const privateFile = path.join(source, name);
        await writeFile(privateFile, "private root document\n");
        await expect(run("npm", ["pack", "--foreground-scripts"], { cwd: source, env, maxBuffer: 10 * 1024 * 1024 }))
          .rejects.toThrow(/unexpected implicitly included package file/i);
        expect((await readdir(source)).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
        expect(await readFile(privateFile, "utf8")).toBe("private root document\n");
        await rm(privateFile);
      }

      await run("npm", ["pack", "--json"], { cwd: source, env, maxBuffer: 10 * 1024 * 1024 });
      const archives = (await readdir(source)).filter((name) => name.endsWith(".tgz"));
      expect(archives).toHaveLength(1);
      const archive = path.join(source, archives[0]);
      const { stdout } = await run("tar", ["-tzf", archive], { env });
      const files = stdout.trim().split("\n");
      expect(files).toContain("package/package.json");
      expect(files).toContain("package/README.md");
      expect(files).toContain("package/LICENSE");
      expect(files).toContain("package/THIRD_PARTY_NOTICES");
      expect(files).toContain("package/dist/cli.js");
      expect(files).toContain("package/dist/terminalText.js");
      expect(files).toContain("package/dist/state/config.js");
      expect(files).toContain("package/dist/actions/gitTransaction.js");
      expect(files).not.toContain("package/dist/actions/gitTransactionWorker.js");
      expect(files.some((file) => file.startsWith("package/native/"))).toBe(false);
      expect(files).not.toContain("package/dist/actions/personal.js");
      expect(files).not.toContain("package/private-backup.txt");
      expect(files.some((file) => /(?:\.claude|node_modules|scripts\/|\.c$|\.h$)/.test(file))).toBe(false);

      expect(await readFile(path.join(source, "dist", "actions", "personal.js"), "utf8")).toBe("private generated file\n");

      const extracted = path.join(temporary, "extracted");
      const skills = path.join(temporary, "selected-skills");
      const outside = path.join(temporary, "outside-sentinel");
      await mkdir(extracted);
      await mkdir(skills);
      await writeFile(path.join(skills, "sentinel"), "selected unchanged\n");
      await writeFile(outside, "outside unchanged\n");
      await run("tar", ["-xzf", archive, "-C", extracted], { env });
      const installed = path.join(extracted, "package");
      const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
      const appBuild = pathToFileURL(path.join(installed, "dist", "state", "appBuild.js")).href;
      // Import the module from the freshly extracted archive.
      const readIdentity = "const { readBuildIdentity } = await import(process.argv[1]); console.log(JSON.stringify(await readBuildIdentity()));";
      const { stdout: identity } = await run(process.execPath, ["--input-type=module", "-e", readIdentity, appBuild], { cwd: temporary, env });
      expect(JSON.parse(identity)).toEqual({ version: manifest.version, commit: null, dirty: false, source: "unknown" });
      const boundary = pathToFileURL(path.join(installed, "dist", "actions", "boundary.js")).href;
      // The module is selected from this test's freshly extracted archive.
      const approve = "const { approveSkillsRoot } = await import(process.argv[1]); console.log(JSON.stringify(await approveSkillsRoot(process.argv[2])));";
      const { stdout: approvedRoot } = await run(process.execPath, ["--input-type=module", "-e", approve, boundary, skills], { env });
      const launch = "import { writeFile } from 'node:fs/promises'; const { withSkillsLock } = await import(process.argv[1]); const root = JSON.parse(process.argv[2]); await withSkillsLock(root, () => writeFile(root.path + '/sentinel', 'approved change\\n'));";
      await run(process.execPath, ["--input-type=module", "-e", launch, boundary, approvedRoot], { env });
      expect(await readFile(path.join(skills, "sentinel"), "utf8")).toBe("approved change\n");
      await writeFile(path.join(skills, "sentinel"), "selected unchanged\n");
      const staleRoot = JSON.stringify({ ...JSON.parse(approvedRoot), identity: "0".repeat(64) });
      await expect(run(process.execPath, ["--input-type=module", "-e", launch, boundary, staleRoot], { env }))
        .rejects.toThrow(/changed|stale|identity|approval/i);
      expect(await readFile(path.join(skills, "sentinel"), "utf8")).toBe("selected unchanged\n");
      expect(await readFile(outside, "utf8")).toBe("outside unchanged\n");

      const builtGit = path.join(source, "dist", "actions", "git.js");
      await rm(builtGit);
      await symlink(outside, builtGit);
      await expect(run("npm", ["pack", "--foreground-scripts"], { cwd: source, env, maxBuffer: 10 * 1024 * 1024 }))
        .rejects.toThrow(/build output must not be a link/i);
      expect(await readFile(outside, "utf8")).toBe("outside unchanged\n");
      await rm(builtGit);
      await cp(path.join(installed, "dist", "actions", "git.js"), builtGit);

      const outputs = [
        "dist/actions/git.js",
        "dist/state/buildIdentity.json",
      ];
      for (const [index, relative] of outputs.entries()) {
        const target = path.join(source, relative);
        const backup = path.join(temporary, `output-${index}`);
        await cp(target, backup);
        await rm(target);
        await link(outside, target);
        await expect(run("npm", ["run", "build"], {
          cwd: source,
          env,
          maxBuffer: 10 * 1024 * 1024,
        })).rejects.toThrow(relative === "dist/state/buildIdentity.json"
          ? /refusing unsafe build identity output/i
          : /build output must not be a link or multiply linked file/i);
        expect(await readFile(outside, "utf8")).toBe("outside unchanged\n");
        await rm(target);
        await cp(backup, target);
      }

      await writeFile(path.join(source, "src", "state", "private-unreviewed.ts"), "export const privateData = 'sentinel';\n");
      await expect(run("npm", ["pack", "--foreground-scripts"], { cwd: source, env, maxBuffer: 10 * 1024 * 1024 }))
        .rejects.toThrow(/missing from the package allowlist/i);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
