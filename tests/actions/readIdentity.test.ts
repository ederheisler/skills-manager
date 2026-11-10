import { chmod, link, lstat, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveSkillsRoot, listSkillPaths, readSkillFiles, readSkillPath, withSkillsLock } from "../../src/actions/boundary.js";

const relative = "alpha/docs/read.txt";
let sandbox: string;
let root: string;

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

describe("in-process read refusals", () => {
  it("rejects a stale approved root before reading replacement bytes", async () => {
    const approved = await approveSkillsRoot(root);
    await rename(root, join(sandbox, "original-root"));
    await mkdir(join(root, "alpha", "docs"), { recursive: true });
    await writeFile(join(root, relative), "unapproved replacement");
    await expect(readSkillPath(root, relative, { expectedRoot: approved })).rejects.toMatchObject({ code: "ESTALE" });
    await expect(listSkillPaths(root, { expectedRoot: approved })).rejects.toMatchObject({ code: "ESTALE" });
  });

  it("rejects a linked child ancestor rather than reading the target", async () => {
    const outside = join(sandbox, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "outside bytes");
    await symlink(outside, join(root, "alpha", "outside"), "dir");
    await expect(readSkillPath(root, "alpha/outside/secret")).rejects.toThrow();
    expect(await listSkillPaths(root)).toContainEqual({ path: "alpha/outside", kind: "symlink" });
    expect((await readSkillPath(root, "alpha/outside")).content.toString()).toBe(outside);
  });

  it("refuses a hardlinked reviewed file without modifying either name", async () => {
    const file = join(root, relative);
    const outside = join(sandbox, "alias");
    await link(file, outside);
    const before = await leafSnapshot(file);
    await expect(readSkillPath(root, relative)).rejects.toThrow(/hard-linked/);
    await expect(readSkillFiles(root)).rejects.toThrow();
    expect(await leafSnapshot(file)).toEqual(before);
    expect((await lstat(outside)).nlink).toBe(2);
  });

  it("rejects non-normalized paths and invalid bounds", async () => {
    for (const relativePath of ["../outside", "/absolute", "alpha/../alpha/docs/read.txt", "alpha//docs/read.txt", ""]) {
      await expect(readSkillPath(root, relativePath)).rejects.toThrow();
    }
    await expect(readSkillPath(root, relative, { maxBytes: -1 })).rejects.toThrow();
    await expect(readSkillPath(root, relative, { maxBytes: Number.NaN })).rejects.toThrow();
  });
});
