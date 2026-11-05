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
import { prepareReplacement, prepareUpdate } from "../../src/actions/update.js";
import { scanSkills } from "../../src/state/repo.js";
import type { LockEntry } from "../../src/state/types.js";
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

async function vercelFixture() {
  const selected = await fixture();
  const remote = await gitRemote(selected.base);
  const ref = "release@example";
  const hash = await remote.git(remote.work, "rev-parse", `${ref}^{tree}`);
  const entry: LockEntry = {
    source: "owner/fixture", sourceType: "github", sourceUrl: "https://github.com/owner/fixture.git",
    skillPath: "SKILL.md", skillFolderHash: hash, ref,
    installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  const lockBytes = JSON.stringify({ version: 3, skills: { example: entry } }, null, 2);
  await writeFile(selected.lock, lockBytes);
  const [skill] = await scanSkills(selected.root.path);
  return { ...selected, ...remote, entry, lockBytes, skill };
}

/** Redirect the approved GitHub source to loopback and normalize the staged GitHub record. */
function redirectVercelInstaller(url: string, entry: LockEntry, remoteHash = entry.skillFolderHash) {
  const realInstaller = sandbox.runConfinedSkills;
  return vi.spyOn(sandbox, "runConfinedSkills").mockImplementation(async (workspace, args, localSource) => {
    const approvedSource = `${entry.sourceUrl}#${encodeURIComponent(entry.ref!)}`;
    if (args[0] !== "add" || args[1] !== approvedSource || localSource) {
      throw new Error("Unexpected installer source in Vercel fixture");
    }
    const redirected = [...args];
    redirected[1] = `${url}#${encodeURIComponent(entry.ref!)}`;
    const output = await realInstaller(workspace, redirected);
    const lockPath = path.join(workspace, "state", "skills", ".skill-lock.json");
    const staged = JSON.parse(await readFile(lockPath, "utf8"));
    expect(staged.skills.example.ref).toBe(entry.ref);
    Object.assign(staged.skills.example, {
      source: entry.source, sourceType: entry.sourceType, sourceUrl: entry.sourceUrl, skillPath: entry.skillPath, skillFolderHash: remoteHash,
    });
    await writeFile(lockPath, JSON.stringify(staged));
    const result = JSON.parse(output.stdout);
    for (const skill of result) skill.source = entry.source;
    return { ...output, stdout: JSON.stringify(result) };
  });
}

async function publishVercelUpdate({ work, bare, git, entry }: GitRemoteFixture & { entry: LockEntry }) {
  const remoteSkill = "---\nname: example\ndescription: Updated Vercel fixture\n---\n\nnew upstream content\n";
  const remoteNote = "new upstream file\n";
  await git(work, "checkout", "-q", entry.ref!);
  await writeFile(path.join(work, "SKILL.md"), remoteSkill);
  await writeFile(path.join(work, "upstream-only.txt"), remoteNote);
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "update Vercel fixture");
  await git(work, "push", "-q", bare, entry.ref!);
  const remoteHash = await git(work, "rev-parse", `${entry.ref}^{tree}`);
  return { remoteSkill, remoteNote, remoteHash };
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
    const { root, target } = await fixture();
    const [skill] = await scanSkills(root.path);
    expect(skill.provenance.kind).toBe("unknown");
    const approved = { source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
      skillPath: "SKILL.md", skillFolderHash: "", installedAt: "", updatedAt: "" };
    const installer = vi.spyOn(sandbox, "runConfinedSkills").mockRejectedValue(new Error("Unexpected network"));
    await expect(prepareUpdate(root, skill, approved)).rejects.toThrow(/valid saved remote source association/i);
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

  it.each(["release@example", "release%40example"])("updates the exact reviewed ref %s", async (ref) => {
    const { base, root, target } = await fixture();
    const { url, work, bare, git } = await gitRemote(base);
    const [adopted] = await scanSkills(root.path);
    await applyPreparedChange(await prepareReplacement(root, adopted, `${url}#${encodeURIComponent(ref)}`));
    let [skill] = await scanSkills(root.path);
    expect(skill.lockEntry?.ref).toBe(ref);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain(`initial ${ref}`);

    await git(work, "checkout", "-q", ref);
    await writeFile(path.join(work, "SKILL.md"), `---\nname: example\ndescription: Updated Git fixture\n---\n\nupdated ${ref}\n`);
    await git(work, "commit", "-qam", "update");
    await git(work, "push", "-q", bare, ref);
    const approved = skill.lockEntry;
    if (!approved) throw new Error("Expected a saved remote source.");
    const preview = await prepareUpdate(root, skill, approved);
    expect(preview.changes[0].review).toContain(`updated ${ref}`);
    expect(preview.changes[0].review).not.toContain("wrong release branch");
    await applyPreparedChange(preview);
    [skill] = await scanSkills(root.path);
    expect(skill.lockEntry?.ref).toBe(ref);
    expect((await matchUpstreamReceipt(root.path, target, "example"))?.historicalBaseline).toBe("unknown");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain(`updated ${ref}`);
  }, 120_000);

  it("refuses a different approval or changed saved source before contacting the remote", async () => {
    const { base, root, target } = await fixture();
    const { url, requests } = await gitRemote(base);
    const [adopted] = await scanSkills(root.path);
    await applyPreparedChange(await prepareReplacement(root, adopted, `${url}#release%40example`));
    const [skill] = await scanSkills(root.path);
    if (!skill.lockEntry) throw new Error("Expected a saved remote source.");
    const approved = { ...skill.lockEntry };
    const requestCount = requests.length;
    for (const changed of [
      { ...approved, sourceUrl: `${url}-other` },
      { ...approved, ref: "release" },
      { ...approved, updatedAt: "different" },
    ]) {
      await expect(prepareUpdate(root, skill, changed)).rejects.toThrow(/source.*changed.*approval/i);
      expect(requests).toHaveLength(requestCount);
    }
    const receiptPath = path.join(root.path, ".skills-manager", "metadata", "example.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.entry.ref = "release";
    await writeFile(receiptPath, JSON.stringify(receipt));

    await expect(prepareUpdate(root, skill, approved)).rejects.toThrow(/source.*changed.*approval/i);
    expect(requests).toHaveLength(requestCount);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("initial release@example");
  }, 120_000);

  it("reviews and applies a Vercel v3 source over the complete locally edited disabled skill", async () => {
    const fixture = await vercelFixture();
    const { root, target, lock, lockBytes, entry, skill, requests } = fixture;
    expect(skill.lockEntry).toEqual(entry);
    expect(skill.provenance).toEqual({ kind: "source", source: entry.source, sourceUrl: entry.sourceUrl });
    expect(requests).toHaveLength(0);
    expect(await readFile(lock, "utf8")).toBe(lockBytes);
    await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });

    const { remoteSkill, remoteNote, remoteHash } = await publishVercelUpdate(fixture);
    expect(remoteHash).not.toBe(entry.skillFolderHash);
    const localSkill = "---\nname: example\ndescription: Local edit\n---\n\nedited after source approval\n";
    const localNote = "local-only content requiring review\n";
    await writeFile(path.join(target, "SKILL.md"), localSkill);
    await writeFile(path.join(target, "local-only.txt"), localNote);
    const installer = redirectVercelInstaller(fixture.url, entry, remoteHash);
    const preview = await prepareUpdate(root, skill, structuredClone(entry));
    try {
      expect(installer).toHaveBeenCalledTimes(1);
      expect(requests.length).toBeGreaterThan(0);
      expect(preview.changes).toHaveLength(1);
      expect(preview.changes[0]).toMatchObject({ destination: target, enabled: false, action: "replace" });
      const review = preview.changes[0].review;
      expect(review).toContain(`--- SKILL.md (changed)\nBEFORE:\n${localSkill}\nAFTER:\n${remoteSkill}`);
      expect(review).toContain(`--- local-only.txt (removed)\nBEFORE:\n${localNote}`);
      expect(review).toContain(`--- upstream-only.txt (added)\nAFTER:\n${remoteNote}`);
      expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(localSkill);
      expect(await readFile(lock, "utf8")).toBe(lockBytes);
      await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });

      await applyPreparedChange(preview);
      expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(remoteSkill);
      expect(await readFile(path.join(target, "upstream-only.txt"), "utf8")).toBe(remoteNote);
      await expect(lstat(path.join(target, "local-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(root.path, "example"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(lock, "utf8")).toBe(lockBytes);
      const receipt = await matchUpstreamReceipt(root.path, target, "example");
      expect(receipt?.entry).toMatchObject({ source: entry.source, skillFolderHash: remoteHash });
      const [rescanned] = await scanSkills(root.path);
      expect(rescanned.lockEntry).toEqual(receipt?.entry);
    } finally {
      await discardPreparedChange(preview);
    }
  }, 120_000);

  it("compares the full approved Vercel record before contacting its source", async () => {
    const { root, target, lock, lockBytes, entry, skill, url, requests } = await vercelFixture();
    expect(skill.lockEntry).toEqual(entry);
    const installer = redirectVercelInstaller(url, entry);
    for (const changed of [
      { ...entry, source: "other/fixture" },
      { ...entry, sourceType: "git" },
      { ...entry, sourceUrl: "https://github.com/other/fixture.git" },
      { ...entry, skillPath: "other/SKILL.md" },
      { ...entry, skillFolderHash: "0".repeat(40) },
      { ...entry, installedAt: "different" },
      { ...entry, updatedAt: "different" },
      { ...entry, ref: "release" },
      { ...entry, additionalMetadata: { changed: true } },
    ]) {
      await expect(prepareUpdate(root, skill, changed)).rejects.toThrow(/saved source changed since approval/i);
    }
    expect(installer).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
    expect(await readFile(lock, "utf8")).toBe(lockBytes);
    await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it.each([
    "changed timestamp", "changed hash", "changed ref", "changed source", "added metadata",
    "corrupt JSON", "invalid version", "removed entry", "removed lock",
  ])("refuses a %s after Vercel source approval without contacting it", async (change) => {
    const { root, target, lock, entry, skill, url, requests } = await vercelFixture();
    expect(skill.lockEntry).toEqual(entry);
    const installer = redirectVercelInstaller(url, entry);
    if (change === "removed lock") {
      await rm(lock);
    } else if (change === "corrupt JSON") {
      await writeFile(lock, "{broken");
    } else {
      let changed: object = entry;
      if (change === "changed timestamp") changed = { ...entry, updatedAt: "different" };
      if (change === "changed hash") changed = { ...entry, skillFolderHash: "0".repeat(40) };
      if (change === "changed ref") changed = { ...entry, ref: "release" };
      if (change === "changed source") changed = { ...entry, source: "other/fixture", sourceUrl: "https://github.com/other/fixture.git" };
      if (change === "added metadata") changed = { ...entry, additionalMetadata: { reviewed: false } };
      await writeFile(lock, JSON.stringify({
        version: change === "invalid version" ? 2 : 3,
        skills: change === "removed entry" ? {} : { example: changed },
      }));
    }
    await expect(prepareUpdate(root, skill, entry)).rejects.toThrow(/saved (?:remote )?source|source changed/i);
    expect(installer).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
    await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it.each(["duplicate", "leaf symlink", "disabled symlink", "root replacement", "missing SKILL.md", "SKILL.md symlink"])(
    "refuses a %s introduced after Vercel source approval before contacting it",
    async (change) => {
      const { base, root, target, lock, lockBytes, entry, skill, url, requests } = await vercelFixture();
      expect(skill.lockEntry).toEqual(entry);
      const installer = redirectVercelInstaller(url, entry);
      const originalText = await readFile(path.join(target, "SKILL.md"), "utf8");
      const sentinelText = "unapproved substitute must remain untouched\n";
      let original = path.join(target, "SKILL.md");
      let substitute: string | null = null;
      if (change === "duplicate") {
        const duplicate = path.join(root.path, "example");
        await mkdir(duplicate);
        substitute = path.join(duplicate, "SKILL.md");
      } else if (change === "leaf symlink") {
        const saved = path.join(base, "saved-example");
        const outside = path.join(base, "outside-example");
        await rename(target, saved);
        await mkdir(outside);
        await symlink(outside, target);
        original = path.join(saved, "SKILL.md");
        substitute = path.join(outside, "SKILL.md");
      } else if (change === "disabled symlink") {
        const disabled = path.dirname(target);
        const saved = path.join(base, "saved-disabled");
        const outside = path.join(base, "outside-disabled");
        await rename(disabled, saved);
        await mkdir(path.join(outside, "example"), { recursive: true });
        await symlink(outside, disabled);
        original = path.join(saved, "example", "SKILL.md");
        substitute = path.join(outside, "example", "SKILL.md");
      } else if (change === "root replacement") {
        const saved = path.join(base, "saved-root");
        await rename(root.path, saved);
        await mkdir(target, { recursive: true });
        original = path.join(saved, ".disabled_skills", "example", "SKILL.md");
        substitute = path.join(target, "SKILL.md");
      } else {
        const saved = path.join(base, "saved-SKILL.md");
        await rename(original, saved);
        original = saved;
        if (change === "SKILL.md symlink") {
          substitute = path.join(base, "outside-SKILL.md");
          await symlink(substitute, path.join(target, "SKILL.md"));
        }
      }
      if (substitute) await writeFile(substitute, sentinelText);
      await expect(prepareUpdate(root, skill, entry)).rejects.toThrow();
      expect(installer).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
      expect(await readFile(original, "utf8")).toBe(originalText);
      if (substitute) expect(await readFile(substitute, "utf8")).toBe(sentinelText);
      else await expect(lstat(path.join(target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(lock, "utf8")).toBe(lockBytes);
      await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    }, 120_000,
  );

  it("refuses an active Vercel skill when the empty disabled directory becomes a symlink", async () => {
    const { base, root, target, lock, lockBytes, entry, url, requests } = await vercelFixture();
    const active = path.join(root.path, "example");
    const disabled = path.join(root.path, ".disabled_skills");
    await rename(target, active);
    const [skill] = await scanSkills(root.path);
    expect(skill.lockEntry).toEqual(entry);
    const installer = redirectVercelInstaller(url, entry);
    const originalText = await readFile(path.join(active, "SKILL.md"), "utf8");
    const outside = path.join(base, "outside-empty-disabled");
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "outside untouched");
    await rename(disabled, path.join(base, "saved-empty-disabled"));
    await symlink(outside, disabled);

    await expect(prepareUpdate(root, skill, entry)).rejects.toThrow();
    expect(installer).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(active, "SKILL.md"), "utf8")).toBe(originalText);
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("outside untouched");
    await expect(lstat(path.join(outside, "example"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(lock, "utf8")).toBe(lockBytes);
    await expect(lstat(path.join(root.path, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it.each(["staged content", "destination content"])(
    "refuses Vercel %s changed after review without overwriting the destination",
    async (change) => {
      const fixture = await vercelFixture();
      const { root, target, lock, lockBytes, entry, skill } = fixture;
      const { remoteHash } = await publishVercelUpdate(fixture);
      const installer = redirectVercelInstaller(fixture.url, entry, remoteHash);
      const originalText = await readFile(path.join(target, "SKILL.md"), "utf8");
      const preview = await prepareUpdate(root, skill, entry);
      try {
        expect(installer).toHaveBeenCalledTimes(1);
        expect(fixture.requests.length).toBeGreaterThan(0);
        const edited = "new edit after review\n";
        const file = change === "staged content"
          ? path.join(preview.workspace, "home", ".agents", "skills", "example", "SKILL.md")
          : path.join(target, "SKILL.md");
        await writeFile(file, edited);
        await expect(applyPreparedChange(preview)).rejects.toThrow(/changed after review/i);
        expect(await readFile(path.join(target, "SKILL.md"), "utf8"))
          .toBe(change === "destination content" ? edited : originalText);
        expect(await readFile(lock, "utf8")).toBe(lockBytes);
      } finally {
        await discardPreparedChange(preview);
      }
    }, 120_000,
  );

  it("honors a URL fragment selector after its ref", async () => {
    const { base, root } = await fixture();
    const { url } = await gitRemote(base);
    const [skill] = await scanSkills(root.path);
    const preview = await prepareReplacement(root, skill, `${url}#release@another`);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0].review).toContain("unselected skill");
    await discardPreparedChange(preview);
  }, 120_000);

  it("refuses to import when the real installer resolves a different ref", async () => {
    const { base, root, target } = await fixture();
    const { url } = await gitRemote(base);
    const [skill] = await scanSkills(root.path);
    await expect(prepareSourceChange(root, `${url}#release`, skill, { ref: "release@example" }))
      .rejects.toThrow(/ref/i);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("old locally edited text");
  }, 120_000);
});
