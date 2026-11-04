import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { approveSkillsRoot, type ApprovedSkillsRoot } from "../../src/actions/boundary.js";
import { applyPreparedChange, discardPreparedChange, prepareSourceChange } from "../../src/actions/skillsCli.js";
import { prepareReplacement, prepareUpdate } from "../../src/actions/update.js";
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

/** A real smart-HTTP Git remote, confined to a disposable loopback fixture. */
async function gitRemote(base: string): Promise<{ url: string; work: string; bare: string; requests: string[]; git: (cwd: string, ...args: string[]) => Promise<void> }> {
  const work = path.join(base, "git-work");
  const bare = path.join(base, "owner", "fixture.git");
  await mkdir(work);
  await mkdir(path.dirname(bare));
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: base, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file:http" };
  const git = async (cwd: string, ...args: string[]) => { await execa("git", args, { cwd, env, extendEnv: false }); };
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

afterEach(async () => {
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
    await expect(prepareUpdate(root, skill, approved)).rejects.toThrow(/matching local receipt/);
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
