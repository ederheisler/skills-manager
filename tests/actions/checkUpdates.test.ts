import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkForUpdates } from "../../src/actions/checkUpdates.js";
import { scanSkills } from "../../src/state/repo.js";
import type { LockEntry, Skill } from "../../src/state/types.js";

const installed = "a".repeat(40);
const upstream = "b".repeat(40);
const servers: Server[] = [];
const roots: string[] = [];

function skill(name: string, entry: Partial<LockEntry> = {}): Skill {
  return {
    id: `["/selected","${name}"]`, name, enabled: true, orphaned: false, path: `/selected/${name}`,
    entryKind: "directory", linkTarget: null, warnings: [], authors: [], frontmatter: null, recordedSource: null,
    lockEntry: {
      source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
      skillPath: `skills/${name}/SKILL.md`, skillFolderHash: installed,
      installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...entry,
    },
    provenance: { kind: "source", source: "owner/repository", sourceUrl: "https://github.com/owner/repository.git" },
  };
}

async function serve(body: unknown): Promise<{ url: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return { url: `http://127.0.0.1:${address.port}/tree`, requests: () => requests };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explicit update checks", () => {
  it("compares a real HTTP tree response once per source and returns identity-bound changes", async () => {
    const endpoint = await serve({ tree: [
      { type: "tree", path: "skills/current", sha: installed },
      { type: "tree", path: "skills/stale", sha: upstream },
    ] });
    const fetchTree = async () => (await fetch(endpoint.url)).json();
    const current = skill("current");
    const stale = skill("stale");
    expect(await checkForUpdates([current, stale], fetchTree)).toEqual({ updated: [stale.id], unavailable: [] });
    expect(endpoint.requests()).toBe(1);
  });

  it("reports unknown source and missing baseline rather than treating them as current", async () => {
    const endpoint = await serve({ tree: [] });
    const unknown = { ...skill("unknown"), lockEntry: null, provenance: { kind: "unknown" } as const };
    const missing = skill("missing", { skillFolderHash: "" });
    const unsupported = skill("unsupported", { sourceType: "git" });
    const report = await checkForUpdates([unknown, missing, unsupported], async () => (await fetch(endpoint.url)).json());
    expect(report.updated).toEqual([]);
    expect(report.unavailable.map((entry) => entry.name)).toEqual(["unknown", "missing", "unsupported"]);
    expect(report.unavailable[0].reason).toMatch(/saved source/i);
    expect(report.unavailable[1].reason).toContain("baseline");
    expect(report.unavailable[2].reason).toMatch(/not supported/i);
    for (const unavailable of report.unavailable) expect(unavailable.reason).not.toMatch(/automatic/i);
    expect(endpoint.requests()).toBe(0);
  });

  it("checks a Vercel v3 recorded tree despite local edits and rejects duplicate paths without writing metadata", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-vercel-check-")));
    roots.push(base);
    const repository = path.join(base, "repository");
    const upstreamSkill = path.join(repository, "skills", "example");
    const skills = path.join(base, "selected");
    const target = path.join(skills, "example");
    const lock = path.join(base, ".skill-lock.json");
    await mkdir(upstreamSkill, { recursive: true });
    await mkdir(target, { recursive: true });
    const baseline = "---\nname: example\ndescription: Vercel fixture\n---\n\noriginal upstream content\n";
    const edited = "---\nname: example\ndescription: Vercel fixture\n---\n\nlocally edited content\n";
    await writeFile(path.join(upstreamSkill, "SKILL.md"), baseline);
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: base, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    const git = async (...args: string[]) => (await execa("git", args, { cwd: repository, env, extendEnv: false })).stdout;
    await git("init", "-q");
    await git("add", "--", "skills/example");
    const baselineTree = await git("write-tree");
    const baselineHash = await git("rev-parse", `${baselineTree}:skills/example`);
    await writeFile(path.join(upstreamSkill, "SKILL.md"), edited);
    await git("add", "--", "skills/example");
    const editedTree = await git("write-tree");
    const editedHash = await git("rev-parse", `${editedTree}:skills/example`);
    expect(editedHash).not.toBe(baselineHash);
    await writeFile(path.join(target, "SKILL.md"), edited);

    const entry: LockEntry = {
      source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
      skillPath: "skills/example/SKILL.md", skillFolderHash: baselineHash,
      installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    const lockBytes = JSON.stringify({ version: 3, skills: { example: entry } }, null, 2);
    await writeFile(lock, lockBytes);
    const [scanned] = await scanSkills(skills);
    expect(scanned.lockEntry).toEqual(entry);
    expect(scanned.provenance).toEqual({ kind: "source", source: entry.source, sourceUrl: entry.sourceUrl });
    expect(await readFile(lock, "utf8")).toBe(lockBytes);
    await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });

    const unchanged = await serve({ tree: [{ type: "tree", path: "skills/example", sha: baselineHash }] });
    const changedToLocal = await serve({ tree: [{ type: "tree", path: "skills/example", sha: editedHash }] });
    for (const [endpoint, updated] of [[unchanged, []], [changedToLocal, [scanned.id]]] as const) {
      const report = await checkForUpdates([scanned], async (repository, ref) => {
        expect([repository, ref]).toEqual(["owner/repository", "HEAD"]);
        return (await fetch(endpoint.url)).json();
      });
      expect(report).toEqual({ updated, unavailable: [] });
    }
    expect(unchanged.requests()).toBe(1);
    expect(changedToLocal.requests()).toBe(1);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(edited);
    const duplicate = path.join(skills, ".disabled_skills", "example");
    await mkdir(duplicate, { recursive: true });
    await writeFile(path.join(duplicate, "SKILL.md"), edited);
    const duplicates = await scanSkills(skills);
    expect(duplicates).toHaveLength(2);
    for (const row of duplicates) {
      expect(row.lockEntry).toBeNull();
      expect(row.provenance.kind).toBe("unknown");
    }
    const ambiguous = await checkForUpdates(duplicates, async () => (await fetch(unchanged.url)).json());
    expect(ambiguous.updated).toEqual([]);
    expect(ambiguous.unavailable).toHaveLength(2);
    for (const unavailable of ambiguous.unavailable) {
      expect(unavailable.reason).toMatch(/saved source/i);
      expect(unavailable.reason).not.toMatch(/automatic/i);
    }
    expect(unchanged.requests()).toBe(1);
    expect(await readFile(lock, "utf8")).toBe(lockBytes);
    await expect(lstat(path.join(skills, ".skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finds four updates from GitHub entries alongside a well-known sibling in a v3 lock", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "skills-mixed-check-")));
    roots.push(base);
    const skills = path.join(base, "selected");
    const names = ["alpha", "beta", "gamma", "delta"];
    const entries: Record<string, LockEntry> = {};
    for (const [index, name] of names.entries()) {
      const target = path.join(skills, name);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\n`);
      entries[name] = {
        source: "owner/repository", sourceType: "github", sourceUrl: "https://github.com/owner/repository.git",
        skillPath: `skills/${name}/SKILL.md`, skillFolderHash: String(index + 1).repeat(40),
        ref: index < 2 ? "main" : "release",
        installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      };
    }
    await writeFile(path.join(base, ".skill-lock.json"), JSON.stringify({
      version: 3,
      skills: {
        ...entries,
        website: {
          source: "https://example.com", sourceType: "well-known", sourceUrl: "https://example.com",
          skillFolderHash: "", sourceBaseUrl: "https://example.com", wellKnownDigest: "digest",
          installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    }));

    const scanned = await scanSkills(skills);
    expect(scanned).toHaveLength(4);
    for (const row of scanned) expect(row.lockEntry).toEqual(entries[row.name]);
    const trees: Record<string, unknown> = {
      main: { truncated: false, tree: [
        { type: "tree", path: "skills/alpha", sha: "a".repeat(40) },
        { type: "tree", path: "skills/beta", sha: "b".repeat(40) },
      ] },
      release: { truncated: false, tree: [
        { type: "tree", path: "skills/gamma", sha: "c".repeat(40) },
        { type: "tree", path: "skills/delta", sha: "d".repeat(40) },
      ] },
    };
    const report = await checkForUpdates(scanned, async (_repository, ref) => trees[ref]);
    expect(report.unavailable).toEqual([]);
    expect(report.updated.sort()).toEqual(scanned.map((row) => row.id).sort());
  });

  it("reports incomplete and malformed trees as unavailable", async () => {
    const truncated = await serve({ truncated: true, tree: [{ type: "tree", path: "skills/example", sha: upstream }] });
    const malformed = await serve({ unexpected: true });
    const target = skill("example");
    const first = await checkForUpdates([target], async () => (await fetch(truncated.url)).json());
    const second = await checkForUpdates([target], async () => (await fetch(malformed.url)).json());
    expect(first.updated).toEqual([]);
    expect(first.unavailable[0].reason).toContain("incomplete");
    expect(second.unavailable[0].reason).toContain("invalid tree");
  });

  it("reports network errors and a missing upstream folder separately from no updates", async () => {
    const endpoint = await serve({ tree: [] });
    const target = skill("example");
    const missing = await checkForUpdates([target], async () => (await fetch(endpoint.url)).json());
    expect(missing.unavailable[0].reason).toContain("not found");
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const offline = await checkForUpdates([target], async () => (await fetch(endpoint.url)).json());
    expect(offline.updated).toEqual([]);
    expect(offline.unavailable).toHaveLength(1);
  });
});
