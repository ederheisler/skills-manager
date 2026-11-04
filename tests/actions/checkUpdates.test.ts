import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkForUpdates } from "../../src/actions/checkUpdates.js";
import type { LockEntry, Skill } from "../../src/state/types.js";

const installed = "a".repeat(40);
const upstream = "b".repeat(40);
const servers: Server[] = [];

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
    const report = await checkForUpdates([unknown, missing], async () => (await fetch(endpoint.url)).json());
    expect(report.updated).toEqual([]);
    expect(report.unavailable.map((entry) => entry.name)).toEqual(["unknown", "missing"]);
    expect(report.unavailable[1].reason).toContain("baseline");
    expect(endpoint.requests()).toBe(0);
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
