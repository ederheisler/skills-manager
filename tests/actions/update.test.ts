import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveSkillsRoot, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import * as sandbox from "../../src/actions/sandbox.js";
import { applyPreparedChange, discardPreparedChange, prepareSourceChange } from "../../src/actions/skillsCli.js";
import { prepareReplacement, prepareUpdate, prepareUpdates } from "../../src/actions/update.js";
import { checkForUpdates } from "../../src/actions/checkUpdates.js";
import { scanSkills } from "../../src/state/repo.js";
import { matchUpstreamReceipt } from "../../src/state/upstreamProvenance.js";

const roots: string[] = [];
const servers: Server[] = [];

async function fixture(): Promise<{ base: string; root: ApprovedSkillsRoot; source: string; target: string; lock: string; sentinel: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-reviewed-update-")));
  roots.push(base);
  const skills = path.join(base, "selected");
  const source = path.join(base, "source");
  const target = path.join(skills, ".disabled_skills", "example");
  const lock = path.join(base, ".skill-lock.json");
  const sentinel = path.join(base, "sentinel");
  await mkdir(target, { recursive: true });
  await mkdir(path.join(source, "example"), { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "---\nname: example\ndescription: Old\n---\n\nold locally edited text\n");
  await writeFile(path.join(source, "example", "SKILL.md"), "---\nname: example\ndescription: New\n---\n\nnew reviewed text\n");
  await writeFile(lock, "external lock");
  await writeFile(sentinel, "untouched");
  return { base, root: await approveSkillsRoot(skills), source, target, lock, sentinel };
}

interface GitRemoteFixture {
  url: string;
  work: string;
  bare: string;
  requests: string[];
  git: (cwd: string, ...args: string[]) => Promise<string>;
}

/** A real smart-HTTP Git remote, confined to a disposable loopback fixture. */
async function gitRemote(base: string): Promise<GitRemoteFixture> {
  const work = path.join(base, "git-work");
  const bare = path.join(base, "owner", "fixture.git");
  await mkdir(work);
  await mkdir(path.dirname(bare));
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: base, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file:http" };
  const git = async (cwd: string, ...args: string[]) => (await execa("git", args, { cwd, env, extendEnv: false })).stdout;
  const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Local Git fixture\n---\n\n${body}\n`;
  await git(work, "init", "-q", "-b", "release");
  await git(work, "config", "user.name", "Fixture");
  await git(work, "config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(work, "SKILL.md"), skill("example", "wrong release branch"));
  await mkdir(path.join(work, "another"));
  await writeFile(path.join(work, "another", "SKILL.md"), skill("another", "unselected skill"));
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "release");
  for (const ref of ["release@example", "release%40example"]) {
    await git(work, "checkout", "-q", "-b", ref, "release");
    await writeFile(path.join(work, "SKILL.md"), skill("example", `initial ${ref}`));
    await git(work, "commit", "-qam", ref);
  }
  await git(base, "clone", "-q", "--bare", work, bare);
  const requests: string[] = [];

  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const child = spawn("git", ["http-backend"], {
      env: { ...env, GIT_PROJECT_ROOT: base, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: request.headers["content-length"] ?? "" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    request.pipe(child.stdin);
    let headers = Buffer.alloc(0);
    let sent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (sent) { response.write(chunk); return; }
      headers = Buffer.concat([headers, chunk]);
      const end = headers.indexOf("\r\n\r\n");
      if (end < 0) return;
      let status = 200;
      for (const line of headers.subarray(0, end).toString().split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else response.setHeader(key, value);
      }
      response.writeHead(status);
      response.write(headers.subarray(end + 4));
      sent = true;
    });
    child.on("error", () => { if (!response.headersSent) response.writeHead(500); response.end(); });
    child.on("close", () => response.end());
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local Git fixture address");
  return { url: `http://127.0.0.1:${address.port}/owner/fixture.git`, work, bare, requests, git };
}

async function trackedFixture() {
  const selected = await fixture();
  const remote = await gitRemote(selected.base);
  const ref = "release";
  const entry = {
    source: remote.url, sourceType: "git", sourceUrl: remote.url,
    skillPath: "SKILL.md", skillFolderHash: "0".repeat(64), ref, installMode: "copy",
    installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  const unrelated = { ...entry, source: "https://elsewhere.invalid/repo.git", sourceUrl: "https://elsewhere.invalid/repo.git" };
  const lockBytes = JSON.stringify({ version: 3, skills: { example: entry, unrelated }, dismissed: { welcome: true } }, null, 2);
  await writeFile(selected.lock, lockBytes);
  await remote.git(remote.work, "checkout", "-q", ref);
  const remoteSkill = "---\nname: example\ndescription: Updated Git fixture\n---\n\nnew upstream content\n";
  await writeFile(path.join(remote.work, "SKILL.md"), remoteSkill);
  await writeFile(path.join(remote.work, "upstream-only.bin"), Buffer.from([0, 1, 2, 255]));
  await remote.git(remote.work, "add", ".");
  await remote.git(remote.work, "commit", "-q", "-m", "update fixture");
  await remote.git(remote.work, "push", "-q", remote.bare, ref);
  const [skill] = await scanSkills(selected.root.path);
  return { ...selected, ...remote, entry, unrelated, lockBytes, skill, remoteSkill };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => error ? reject(error) : resolve());
    return promise;
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("reviewed skill replacement", () => {
  it("requires a source for an adopted unknown-baseline skill", async () => {
    const { root, target, lock } = await fixture();
    const [skill] = await scanSkills(root.path);
    await writeFile(lock, JSON.stringify({ version: 3, skills: {} }));
    expect(skill.provenance.kind).toBe("unknown");
    const approved = { source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
      skillPath: "SKILL.md", skillFolderHash: "", installedAt: "", updatedAt: "" };
    const installer = vi.spyOn(sandbox, "runConfinedSkills").mockRejectedValue(new Error("Unexpected network"));
    const prepared = await prepareUpdate(root, skill, approved);
    expect(prepared.changes).toEqual([]);
    expect(prepared.failed).toEqual([expect.objectContaining({ id: skill.id, reason: expect.stringMatching(/does not track/i) })]);
    await discardPreparedChange(prepared);
    expect(installer).not.toHaveBeenCalled();
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
  });

  it("previews full before and after content and never enables a disabled skill", async () => {
    const { root, source, target, lock, sentinel } = await fixture();
    const [skill] = await scanSkills(root.path);
    const preview = await prepareReplacement(root, skill, source);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]).toMatchObject({ destination: target, enabled: false, action: "replace" });
    expect(preview.changes[0].review).toContain("old locally edited text");
    expect(preview.changes[0].review).toContain("new reviewed text");
    await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root.path, "example", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
    await applyPreparedChange(preview);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("new reviewed text");
    await expect(readFile(path.join(root.path, "example", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    let [replaced] = await scanSkills(root.path);
    expect(replaced.warnings.join(" ")).toContain("Prior installed content and ownership were unknown");
    expect((await matchUpstreamReceipt(root.path, target, "example"))?.historicalBaseline).toBe("unknown");
    await writeFile(path.join(source, "example", "SKILL.md"), "---\nname: example\ndescription: Newer\n---\n\nlater reviewed text\n");
    await applyPreparedChange(await prepareReplacement(root, replaced, source));
    [replaced] = await scanSkills(root.path);
    expect(replaced.warnings.join(" ")).toContain("Prior installed content and ownership were unknown");
    expect((await matchUpstreamReceipt(root.path, target, "example"))?.historicalBaseline).toBe("unknown");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("later reviewed text");
    expect(await readFile(lock, "utf8")).toBe("external lock");
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  });

  it("refuses a replaced approved root without reading or altering its substitute", async () => {
    const { root, source, target } = await fixture();
    const [skill] = await scanSkills(root.path);
    const moved = `${root.path}-original`;
    await rename(root.path, moved);
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "unapproved root sentinel");
    await expect(prepareReplacement(root, skill, source)).rejects.toThrow(/changed/i);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("unapproved root sentinel");
    await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(moved, ".disabled_skills", "example", "SKILL.md"), "utf8")).toContain("old locally edited text");
  });

  it("refuses a substituted disabled-directory symlink", async () => {
    const { base, root, source, target } = await fixture();
    const [skill] = await scanSkills(root.path);
    const disabled = path.join(root.path, ".disabled_skills");
    const moved = path.join(base, "original-disabled");
    const outside = path.join(base, "outside-disabled");
    await rename(disabled, moved);
    await mkdir(path.join(outside, "example"), { recursive: true });
    await writeFile(path.join(outside, "example", "SKILL.md"), "outside sentinel");
    await symlink(outside, disabled);
    await expect(prepareReplacement(root, skill, source)).rejects.toThrow();
    expect(await readFile(path.join(outside, "example", "SKILL.md"), "utf8")).toBe("outside sentinel");
    expect(await readFile(path.join(moved, "example", "SKILL.md"), "utf8")).toContain("old locally edited text");
    expect(target).toBe(path.join(disabled, "example"));
  });

  it("reviews only the selected subtree and leaves unrelated linked entries untouched", async () => {
    const { base, root, source, sentinel } = await fixture();
    const [skill] = await scanSkills(root.path);
    const unrelated = path.join(root.path, "unrelated");
    await symlink(base, unrelated);
    const preview = await prepareReplacement(root, skill, source);
    expect(preview.changes[0].review).toContain("old locally edited text");
    expect(preview.changes[0].review).toContain("new reviewed text");
    await discardPreparedChange(preview);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a changed original after preview without overwriting the new edit", async () => {
    const { root, source, target, sentinel } = await fixture();
    const [skill] = await scanSkills(root.path);
    const preview = await prepareReplacement(root, skill, source);
    await writeFile(path.join(target, "SKILL.md"), "later edit");
    await expect(applyPreparedChange(preview)).rejects.toThrow(/changed after review/);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("later edit");
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  });


  it("refuses a remote replacement whose CLI lock name differs from its destination", async () => {
    const { base, root, lock, target } = await fixture();
    await writeFile(lock, JSON.stringify({ version: 3, skills: {} }));
    const { url } = await gitRemote(base);
    const [skill] = await scanSkills(root.path);
    await expect(prepareReplacement(root, skill, `${url}#release@another`)).rejects.toThrow(/tracks this skill as "another".*normal name/i);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
  }, 120_000);

  it("refuses to import when the real installer resolves a different ref", async () => {
    const { base, root, target, lock } = await fixture();
    await writeFile(lock, JSON.stringify({ version: 3, skills: {} }));
    const { url } = await gitRemote(base);
    const [skill] = await scanSkills(root.path);
    await expect(prepareSourceChange(root, `${url}#release`, skill, { ref: "release@example" }))
      .rejects.toThrow(/ref/i);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
  }, 120_000);
});

describe("skills CLI updates", () => {
  it("publishes the real CLI update and lock while keeping a disabled skill disabled", async () => {
    const { root, target, lock, sentinel, entry, unrelated, skill, remoteSkill, requests } = await trackedFixture();
    await symlink(sentinel, path.join(target, "outside-link"));
    const prepared = await prepareUpdates(root, [skill]);
    expect(prepared.failed).toEqual([]);
    expect(prepared.changes.map((change) => change.name)).toEqual(["example"]);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
    await applyPreparedChange(prepared);
    expect(requests.length).toBeGreaterThan(0);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(remoteSkill);
    expect(await readFile(path.join(target, "upstream-only.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    await expect(lstat(path.join(root.path, "example"))).rejects.toMatchObject({ code: "ENOENT" });
    const updatedLock = JSON.parse(await readFile(lock, "utf8"));
    expect(updatedLock.skills.example.skillFolderHash).not.toBe(entry.skillFolderHash);
    expect(updatedLock.skills.example.installMode).toBe("copy");
    expect(updatedLock.skills.unrelated).toEqual(unrelated);
    expect(updatedLock.dismissed).toEqual({ welcome: true });
    const [rescanned] = await scanSkills(root.path);
    expect(rescanned.lockEntry).toEqual(updatedLock.skills.example);
    const check = await checkForUpdates([rescanned]);
    expect(check.updated).toEqual([]);
    expect(check.unavailable).toEqual([]);
    const current = await prepareUpdates(root, [rescanned]);
    expect(current.changes).toEqual([]);
    expect(current.failed).toEqual([]);
    await discardPreparedChange(current);
  }, 120_000);

  it("reports a current skill correctly when the same CLI batch updates another skill", async () => {
    const { root, target, lock, url } = await trackedFixture();
    const currentPath = path.join(root.path, "another", "SKILL.md");
    await mkdir(path.dirname(currentPath));
    await writeFile(currentPath, "---\nname: another\ndescription: Existing fixture\n---\n");
    const currentSkill = (await scanSkills(root.path)).find((skill) => skill.name === "another")!;
    const add = await prepareReplacement(root, currentSkill, `${url}#release@another`);
    await applyPreparedChange(add);
    const currentContents = await readFile(currentPath, "utf8");
    const currentEntry = JSON.parse(await readFile(lock, "utf8")).skills.another;
    const selected = await scanSkills(root.path);
    expect(selected.map((skill) => skill.name).sort()).toEqual(["another", "example"]);
    const prepared = await prepareUpdates(root, selected);
    expect(prepared.changes.map((change) => change.name)).toEqual(["example"]);
    expect(prepared.failed).toEqual([]);
    await applyPreparedChange(prepared);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("new upstream content");
    expect(await readFile(currentPath, "utf8")).toBe(currentContents);
    expect(JSON.parse(await readFile(lock, "utf8")).skills.another).toEqual(currentEntry);
  }, 120_000);

  it("keeps successful CLI updates when another selected source fails", async () => {
    const { root, lock, target, entry, skill } = await trackedFixture();
    const brokenPath = path.join(root.path, "broken");
    await mkdir(brokenPath);
    await writeFile(path.join(brokenPath, "SKILL.md"), "---\nname: broken\ndescription: unavailable\n---\n");
    const broken = { ...entry, source: entry.source.replace("fixture.git", "missing.git"),
      sourceUrl: entry.sourceUrl.replace("fixture.git", "missing.git") };
    const original = JSON.parse(await readFile(lock, "utf8"));
    original.skills.broken = broken;
    await writeFile(lock, JSON.stringify(original));
    const rescanned = await scanSkills(root.path);
    const failedSkill = rescanned.find((item) => item.name === "broken")!;
    const prepared = await prepareUpdates(root, [skill, failedSkill]);
    expect(prepared.changes.map((change) => change.name)).toEqual(["example"]);
    expect(prepared.failed).toEqual([expect.objectContaining({ id: failedSkill.id, name: "broken" })]);
    await applyPreparedChange(prepared);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("new upstream content");
    expect(await readFile(path.join(brokenPath, "SKILL.md"), "utf8")).toContain("unavailable");
    const updated = JSON.parse(await readFile(lock, "utf8"));
    expect(updated.skills.broken).toEqual(broken);
    expect(updated.skills.example.skillFolderHash).not.toBe(entry.skillFolderHash);
  }, 120_000);

  it.each(["source", "lock", "destination"])("refuses a changed %s without publishing an unsafe update", async (changed) => {
    const { root, target, lock, entry, skill, lockBytes, requests } = await trackedFixture();
    if (changed === "source") {
      const replacement = { ...entry, sourceUrl: entry.sourceUrl.replace("fixture.git", "missing.git") };
      await writeFile(lock, JSON.stringify({ version: 3, skills: { example: replacement } }));
      const prepared = await prepareUpdate(root, skill, entry);
      expect(prepared.changes).toEqual([]);
      expect(prepared.failed?.[0].reason).toMatch(/changed/i);
      expect(requests).toEqual([]);
      await discardPreparedChange(prepared);
      return;
    }
    const prepared = await prepareUpdate(root, skill, entry);
    expect(prepared.changes).toHaveLength(1);
    if (changed === "lock") await writeFile(lock, `${lockBytes}\n`);
    else await writeFile(path.join(target, "SKILL.md"), "later local edit");
    await expect(applyPreparedChange(prepared)).rejects.toThrow(/changed/i);
    expect(await readFile(lock, "utf8")).toBe(changed === "lock" ? `${lockBytes}\n` : lockBytes);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8"))
      .toBe(changed === "destination" ? "later local edit" : "---\nname: example\ndescription: Old\n---\n\nold locally edited text\n");
  }, 120_000);

  it("creates the shared CLI lock for a real remote replacement", async () => {
    const { base, root, target, lock } = await fixture();
    await rm(lock);
    const { url } = await gitRemote(base);
    const [skill] = await scanSkills(root.path);
    const prepared = await prepareReplacement(root, skill, `${url}#release`);
    await applyPreparedChange(prepared);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("wrong release branch");
    const cliLock = JSON.parse(await readFile(lock, "utf8"));
    expect(cliLock.skills.example).toMatchObject({ sourceType: "git", sourceUrl: url, ref: "release" });
    expect((await scanSkills(root.path))[0].lockEntry).toEqual(cliLock.skills.example);
  }, 120_000);

  it.each(["", "{broken"])("refuses a corrupt existing CLI lock before contacting a remote", async (corrupt) => {
    const { base, root, target, lock } = await fixture();
    await writeFile(lock, corrupt);
    const { url, requests } = await gitRemote(base);
    const [skill] = await scanSkills(root.path);
    await expect(prepareReplacement(root, skill, `${url}#release`)).rejects.toThrow(/lock is corrupt/i);
    expect(requests).toEqual([]);
    expect(await readFile(lock, "utf8")).toBe(corrupt);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
  }, 120_000);

  it.each([
    ["update", "symlink"],
    ["add", "oversized"],
  ] as const)("rejects a %s CLI-generated %s lock before publishing", async (action, artifact) => {
    const { root, target, lock, lockBytes, sentinel, skill, entry, url } = await trackedFixture();
    const originalRunner = sandbox.runConfinedSkills;
    let workspace = "";
    vi.spyOn(sandbox, "runConfinedSkills").mockImplementation(async (dir, args, localSource) => {
      const result = await originalRunner(dir, args, localSource);
      workspace = dir;
      const generatedLock = path.join(dir, "state", "skills", ".skill-lock.json");
      if (artifact === "symlink") {
        await rm(generatedLock);
        await symlink(sentinel, generatedLock);
      } else {
        await writeFile(generatedLock, "x".repeat(1024 * 1024 + 1));
      }
      return result;
    });
    const preparation = action === "update"
      ? prepareUpdate(root, skill, entry)
      : prepareReplacement(root, skill, `${url}#release`);
    await expect(preparation).rejects.toThrow();
    expect(workspace).not.toBe("");
    await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target + "/SKILL.md", "utf8")).toContain("old locally edited text");
    expect(await readFile(lock, "utf8")).toBe(lockBytes);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  }, 120_000);
});
