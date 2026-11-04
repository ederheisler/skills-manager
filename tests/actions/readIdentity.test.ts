import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveSkillsRoot, listSkillPaths, readSkillFiles, readSkillPath, withSkillsLock } from "../../src/actions/boundary.js";

const relative = "alpha/docs/read.txt";
let sandbox: string;
let root: string;
let raceDirectory: string;
let raceHelper: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "skills-read-identity-")));
  root = join(sandbox, "skills");
  await mkdir(join(root, "alpha", "docs"), { recursive: true });
  await writeFile(join(root, relative), "reviewed content\n");
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function leafSnapshot(file: string): Promise<bigint[]> {
  const entry = await lstat(file, { bigint: true });
  return [entry.dev, entry.ino, entry.mode, entry.nlink, entry.uid, entry.gid,
    entry.rdev, entry.size, entry.mtimeNs, entry.ctimeNs];
}

describe("listed path encoding", () => {
  it("lists and reads valid UTF-8 names without changing file bytes", async () => {
    const path = "alpha/docs/\u2603-\uFFFD-\n.txt";
    const content = Buffer.from([0xff, 0x00, 0x61]);
    await writeFile(join(root, path), content);

    expect(await listSkillPaths(root)).toContainEqual({ path, kind: "file" });
    expect((await readSkillPath(root, path)).content).toEqual(content);
  });

  it.runIf(process.platform === "linux")("does not review an invalid byte filename as a distinct replacement-character filename", async () => {
    const path = "alpha/docs/\uFFFD.txt";
    await writeFile(join(root, path), "legitimate");
    expect((await readSkillFiles(root)).files).toContainEqual({ path, content: "legitimate" });

    const invalidPath = Buffer.concat([Buffer.from(join(root, "alpha", "docs") + "/"), Buffer.from([0xff]), Buffer.from(".txt")]);
    await writeFile(invalidPath, "invalid filename");
    await expect(readSkillFiles(root)).rejects.toThrow();
  });
});

describe("stable path identity", () => {
  it("survives controlled-state bootstrap and unrelated root and ancestor siblings", async () => {
    const approved = await approveSkillsRoot(root);
    const before = await readSkillPath(root, relative, { expectedRoot: approved });
    expect(before.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(before.stableIdentity).toMatch(/^[a-f0-9]{64}$/);

    await withSkillsLock(approved, async () => {});
    expect((await stat(join(root, ".skills-manager"))).isDirectory()).toBe(true);
    const bootstrapped = await readSkillPath(root, relative, { expectedRoot: approved });
    expect(bootstrapped.stableIdentity).toBe(before.stableIdentity);

    await mkdir(join(root, "unrelated"));
    await mkdir(join(root, "alpha", "other"));
    await mkdir(join(root, "alpha", "docs", "sibling"));
    const after = await readSkillPath(root, relative, { expectedRoot: approved });
    expect(after.stableIdentity).toBe(before.stableIdentity);
    expect(after.content).toEqual(before.content);
  });

  it("changes when the leaf is replaced with a different inode, even with identical bytes", async () => {
    const file = join(root, relative);
    const before = await readSkillPath(root, relative);
    await writeFile(join(sandbox, "replacement"), before.content);
    await rename(file, join(sandbox, "original"));
    await rename(join(sandbox, "replacement"), file);
    const after = await readSkillPath(root, relative);
    expect(after.content).toEqual(before.content);
    expect(after.identity).not.toBe(before.identity);
    expect(after.stableIdentity).not.toBe(before.stableIdentity);
  });

  it("changes when an ancestor inode is replaced while the leaf snapshot is unchanged", async () => {
    const file = join(root, relative);
    const before = await readSkillPath(root, relative);
    const beforeLeaf = await leafSnapshot(file);
    await mkdir(join(sandbox, "replacement-alpha"));
    await rename(join(root, "alpha"), join(sandbox, "original-alpha"));
    await rename(join(sandbox, "original-alpha", "docs"), join(sandbox, "replacement-alpha", "docs"));
    await rename(join(sandbox, "replacement-alpha"), join(root, "alpha"));
    expect(await leafSnapshot(file)).toEqual(beforeLeaf);
    const after = await readSkillPath(root, relative);
    expect(after.identity).not.toBe(before.identity);
    expect(after.stableIdentity).not.toBe(before.stableIdentity);
  });

  it("changes when the root inode is replaced while the leaf snapshot is unchanged", async () => {
    const file = join(root, relative);
    const before = await readSkillPath(root, relative);
    const beforeLeaf = await leafSnapshot(file);
    await rename(root, join(sandbox, "original-root"));
    await mkdir(root);
    await rename(join(sandbox, "original-root", "alpha"), join(root, "alpha"));
    expect(await leafSnapshot(file)).toEqual(beforeLeaf);
    const after = await readSkillPath(root, relative);
    expect(after.identity).not.toBe(before.identity);
    expect(after.stableIdentity).not.toBe(before.stableIdentity);
  });

  it("binds root and ancestor permissions", async () => {
    const before = await readSkillPath(root, relative);
    const rootMode = (await stat(root)).mode & 0o7777;
    await chmod(root, rootMode ^ 0o040);
    const rootChanged = await readSkillPath(root, relative);
    expect(rootChanged.stableIdentity).not.toBe(before.stableIdentity);
    const ancestor = join(root, "alpha");
    const ancestorMode = (await stat(ancestor)).mode & 0o7777;
    await chmod(ancestor, ancestorMode ^ 0o040);
    const ancestorChanged = await readSkillPath(root, relative);
    expect(ancestorChanged.stableIdentity).not.toBe(rootChanged.stableIdentity);
  });

  it("hashes complete file bytes even when the returned content is truncated", async () => {
    const file = join(root, relative);
    await writeFile(file, "a".repeat(70000) + "end");
    const full = await readSkillPath(root, relative);
    const truncated = await readSkillPath(root, relative, { maxBytes: 3 });
    const empty = await readSkillPath(root, relative, { maxBytes: 0 });
    expect(truncated.content.toString()).toBe("aaa");
    expect(truncated.truncated).toBe(true);
    expect(empty.content.byteLength).toBe(0);
    expect(truncated.stableIdentity).toBe(full.stableIdentity);
    expect(empty.stableIdentity).toBe(full.stableIdentity);
    await writeFile(file, "a".repeat(70000) + "new");
    expect((await readSkillPath(root, relative, { maxBytes: 0 })).stableIdentity).not.toBe(empty.stableIdentity);
  });

  it("hashes the complete link target without following links", async () => {
    const link = join(root, "alpha", "link");
    await symlink("first-target", link);
    const full = await readSkillPath(root, "alpha/link");
    const truncated = await readSkillPath(root, "alpha/link", { maxBytes: 0 });
    const prefix = await readSkillPath(root, "alpha/link", { maxBytes: 5 });
    expect(full.kind).toBe("symlink");
    expect(full.content.toString()).toBe("first-target");
    expect(truncated.content.byteLength).toBe(0);
    expect(prefix.content.toString()).toBe("first");
    expect(prefix.stableIdentity).toBe(full.stableIdentity);
    expect(truncated.stableIdentity).toBe(full.stableIdentity);
    await unlink(link);
    await symlink("other-target", link);
    expect((await readSkillPath(root, "alpha/link", { maxBytes: 0 })).stableIdentity).not.toBe(full.stableIdentity);
    await symlink(join(sandbox, "outside"), join(root, "alpha", "alias"), "dir");
    await expect(readSkillPath(root, "alpha/alias/secret")).rejects.toThrow();
  });
});

describe("strict in-read snapshots", () => {
  beforeAll(async () => {
    raceDirectory = await realpath(await mkdtemp(join(tmpdir(), "skills-read-race-helper-")));
    raceHelper = join(raceDirectory, "skills-boundary");
    const source = fileURLToPath(new URL("../../native/skills-boundary.c", import.meta.url));
    // Intercept only the real file read, changing the filesystem after its pinned
    // snapshot and before the native command performs its final chain check.
    const instrumented = `
#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
static ssize_t racing_read(int fd, void *buffer, size_t size);
#define read racing_read
#define main boundary_original_main
#include ${JSON.stringify(source)}
#undef main
#undef read
static ssize_t racing_read(int fd, void *buffer, size_t size) {
    static int changed;
    ssize_t result = read(fd, buffer, size);
    struct stat opened, named;
    const char *file = getenv("READ_RACE_FILE");
    const char *kind = getenv("READ_RACE_KIND");
    if (!changed && result > 0 && file && kind && fstat(fd, &opened) == 0 &&
        lstat(file, &named) == 0 && opened.st_dev == named.st_dev && opened.st_ino == named.st_ino) {
        changed = 1;
        if (!strcmp(kind, "leaf")) {
            int output = open(file, O_WRONLY | O_NOFOLLOW);
            if (output < 0 || pwrite(output, "X", 1, 0) != 1 ||
                fchmod(output, (named.st_mode & 07777) ^ 0100) < 0 || close(output) < 0) _exit(97);
        } else if (!strcmp(kind, "sibling")) {
            if (mkdir(getenv("READ_RACE_PATH"), 0700) < 0) _exit(97);
        } else if (!strcmp(kind, "replace")) {
            if (rename(getenv("READ_RACE_PATH"), getenv("READ_RACE_PARKED")) < 0 ||
                rename(getenv("READ_RACE_REPLACEMENT"), getenv("READ_RACE_PATH")) < 0) _exit(97);
        } else _exit(97);
    }
    return result;
}
int main(int argc, char **argv) { return boundary_original_main(argc, argv); }
`;
    const compiler = spawnSync(process.env.CC || "cc", [
      "-std=c11", "-O2", "-D_POSIX_C_SOURCE=200809L", "-Wall", "-Wextra", "-Wpedantic",
      "-x", "c", "-", "-o", raceHelper,
    ], { input: instrumented, encoding: "utf8" });
    expect(compiler.status, compiler.stderr).toBe(0);
  }, 60000);

  afterAll(async () => {
    if (raceDirectory) await rm(raceDirectory, { recursive: true, force: true });
  });

  it.each(["leaf", "root-sibling", "ancestor-sibling", "ancestor-replacement"] as const)(
    "rejects a %s change after the leaf is read", async (scenario) => {
      const env = { ...process.env, READ_RACE_FILE: join(root, relative), READ_RACE_KIND: "leaf" };
      if (scenario === "root-sibling" || scenario === "ancestor-sibling") {
        env.READ_RACE_KIND = "sibling";
        Object.assign(env, { READ_RACE_PATH: scenario === "root-sibling" ? join(root, ".skills-manager") : join(root, "alpha", "docs", "sibling") });
      } else if (scenario === "ancestor-replacement") {
        const replacement = join(sandbox, "replacement-alpha");
        await mkdir(replacement);
        env.READ_RACE_KIND = "replace";
        Object.assign(env, { READ_RACE_PATH: join(root, "alpha"), READ_RACE_PARKED: join(sandbox, "original-alpha"), READ_RACE_REPLACEMENT: replacement });
      }
      const result = spawnSync(raceHelper, ["read", root, relative, "18446744073709551615", "-"], { env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toMatch(/^ERR\tESTALE\t/);
    },
  );
});
