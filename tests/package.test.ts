import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    };

    try {
      for (const name of ["src", "scripts", "package.json", "tsconfig.json", "LICENSE", "THIRD_PARTY_NOTICES", "README.md"]) {
        await cp(path.join(project, name), path.join(source, name), { recursive: true });
      }
      await mkdir(path.join(source, "native"));
      for (const name of await readdir(path.join(project, "native"))) {
        if (name.endsWith(".c") || name.endsWith(".h")) {
          await cp(path.join(project, "native", name), path.join(source, "native", name));
        }
      }
      await symlink(path.join(project, "node_modules"), path.join(source, "node_modules"), "dir");
      await mkdir(path.join(source, "dist", "actions"), { recursive: true });
      await mkdir(path.join(source, ".claude"));
      await writeFile(path.join(source, ".claude", "settings.json"), "private settings\n");
      await writeFile(path.join(source, "private-backup.txt"), "private backup\n");
      await writeFile(path.join(source, "dist", "actions", "personal.js"), "private generated file\n");

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
      expect(files).toContain("package/dist/actions/gitTransaction.js");
      expect(files).toContain("package/dist/actions/gitTransactionWorker.js");
      expect(files).toContain("package/native/skills-boundary");
      expect(files).toContain("package/native/skills-boundary.platform.json");
      expect(files).toContain("package/native/skills-git-boundary");
      expect(files).toContain("package/native/skills-git-boundary.platform.json");
      expect(files).not.toContain("package/dist/actions/personal.js");
      expect(files).not.toContain("package/private-backup.txt");
      expect(files.some((file) => /(?:\.claude|node_modules|scripts\/|\.c$|\.h$)/.test(file))).toBe(false);

      const { stdout: metadataText } = await run("tar", ["-xOf", archive, "package/native/skills-boundary.platform.json"], { env });
      const metadata = JSON.parse(metadataText);
      expect(metadata).toEqual({
        platform: process.platform,
        arch: process.arch,
        libc: process.platform === "linux" ? "glibc" : null,
      });
      const { stdout: gitMetadataText } = await run("tar", ["-xOf", archive, "package/native/skills-git-boundary.platform.json"], { env });
      expect(JSON.parse(gitMetadataText)).toEqual(metadata);
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
      const metadataFile = path.join(installed, "native", "skills-boundary.platform.json");
      const boundary = pathToFileURL(path.join(installed, "dist", "actions", "boundary.js")).href;
      // The module is selected from this test's freshly extracted archive.
      const approve = "const { approveSkillsRoot } = await import(process.argv[1]); console.log(JSON.stringify(await approveSkillsRoot(process.argv[2])));";
      const { stdout: approvedRoot } = await run(process.execPath, ["--input-type=module", "-e", approve, boundary, skills], { env });
      const launch = "const { withSkillsLock } = await import(process.argv[1]); const { writeFile } = await import('node:fs/promises'); const root = JSON.parse(process.argv[2]); await withSkillsLock(root, () => writeFile(root.path + '/unexpected-write', 'changed'));";
      for (const mismatch of [
        { ...metadata, platform: process.platform === "darwin" ? "linux" : "darwin" },
        { ...metadata, arch: "other-architecture" },
        { ...metadata, libc: process.platform === "linux" ? "musl" : "glibc" },
      ]) {
        await writeFile(metadataFile, JSON.stringify(mismatch));
        await expect(run(process.execPath, ["--input-type=module", "-e", launch, boundary, approvedRoot], { env }))
          .rejects.toThrow(/helper is incompatible/i);
      }
      await rm(metadataFile);
      await expect(run(process.execPath, ["--input-type=module", "-e", launch, boundary, approvedRoot], { env }))
        .rejects.toThrow(/platform metadata is missing or invalid/i);
      await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(skills)).toEqual(["sentinel"]);
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

      await writeFile(path.join(source, "src", "state", "private-unreviewed.ts"), "export const privateData = 'sentinel';\n");
      await expect(run("npm", ["pack", "--foreground-scripts"], { cwd: source, env, maxBuffer: 10 * 1024 * 1024 }))
        .rejects.toThrow(/missing from the package allowlist/i);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
