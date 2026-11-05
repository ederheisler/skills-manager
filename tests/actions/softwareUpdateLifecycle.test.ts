import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as updateHandoff from "../../src/actions/appUpdateHandoff.js";
import * as sandbox from "../../src/actions/sandbox.js";
import { SoftwareUpdateService, type UpdateComponent } from "../../src/actions/softwareUpdates.js";
import * as appBuild from "../../src/state/appBuild.js";

const resultWriteGate = vi.hoisted(() => ({
  target: "",
  temporary: "",
  reached: null as (() => void) | null,
  release: null as Promise<void> | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const file = args[0];
      if (typeof file === "string" && resultWriteGate.target
        && file.startsWith(resultWriteGate.target) && file.endsWith(".tmp")) {
        resultWriteGate.temporary = file;
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          await write(...writeArgs);
          resultWriteGate.reached?.();
          await resultWriteGate.release;
        };
      }
      return handle;
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2030-01-01T12:00:00Z");
const HOST_A = "https://registry-a.invalid/custom/";
const HOST_B = "https://registry-b.invalid/other/";
const APP_SCOPE = "https://api.github.com";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const roots: string[] = [];
const services: SoftwareUpdateService[] = [];
const releasePending: Array<() => void> = [];

interface Activity {
  checking: boolean;
  nextCheckAt: number | null;
  lastAttemptAt: number | null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scope(component: UpdateComponent, registry = HOST_A): string {
  if (component === "app") return APP_SCOPE;
  const url = new URL(registry);
  url.username = "";
  url.password = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return digest(url.href);
}

function cacheFile(cache: string, component: UpdateComponent, kind: "attempt" | "result", registry = HOST_A): string {
  return path.join(cache, "skills-manager", `${kind}-${component}-${digest(scope(component, registry))}.json`);
}

function resultPrefix(cache: string, component: UpdateComponent, registry = HOST_A): string {
  return `${cacheFile(cache, component, "result", registry).slice(0, -5)}-`;
}

function snapshotFixtureFile(cache: string, component: UpdateComponent, at: number): string {
  return `${resultPrefix(cache, component)}${at}-00000000-0000-4000-8000-000000000001.json`;
}

async function snapshotFiles(cache: string, component: UpdateComponent, registry = HOST_A): Promise<string[]> {
  const prefix = resultPrefix(cache, component, registry);
  const directory = path.dirname(prefix);
  try {
    return (await readdir(directory))
      .filter((name) => name.startsWith(path.basename(prefix)) && name.endsWith(".json"))
      .map((name) => path.join(directory, name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function privateFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
}

async function seedConsent(config: string, component: UpdateComponent, registry = HOST_A): Promise<void> {
  await privateFile(path.join(config, "skills-manager", `${component}.json`), JSON.stringify({
    kind: "skills-manager-update-consent", version: 1, enabled: true, scope: scope(component, registry),
  }));
}

async function seedAttempt(cache: string, component: UpdateComponent, at: number): Promise<void> {
  await privateFile(cacheFile(cache, component, "attempt"), JSON.stringify({
    kind: "skills-manager-update-attempt", version: 1, at,
  }));
}

function deferred<T>(fallback: T) {
  const pending = Promise.withResolvers<T>();
  releasePending.push(() => pending.resolve(fallback));
  return pending;
}

function appResponse(sha = COMMIT_A): Response {
  return new Response(JSON.stringify({ sha }), { status: 200 });
}

function cliResponse(version = "1.2.3"): Response {
  return new Response(JSON.stringify({ name: "skills", version }), { status: 200 });
}

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "software-update-lifecycle-")));
  roots.push(base);
  const skills = path.join(base, "skills");
  const config = path.join(base, "config");
  const cache = path.join(base, "cache");
  await mkdir(skills);
  vi.stubEnv("HOME", base);
  vi.stubEnv("XDG_CONFIG_HOME", config);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  vi.stubEnv("npm_config_userconfig", path.join(base, "npmrc"));
  vi.stubEnv("npm_config_globalconfig", path.join(base, "global-npmrc"));

  let registry = HOST_A;
  let resolveRegistry = async () => registry;
  let build: appBuild.BuildIdentity = { version: "1.0.0", commit: COMMIT_A, dirty: false, source: "git" };
  let cliVersion = "1.2.3";
  vi.spyOn(updateHandoff, "resolveUpdateRegistry").mockImplementation(() => resolveRegistry());
  vi.spyOn(appBuild, "readBuildIdentity").mockImplementation(async () => ({ ...build }));
  vi.spyOn(sandbox, "inspectSkillsRuntime").mockImplementation(async () => ({
    version: cliVersion, packageRoot: base, executable: path.join(base, "skills-cli"),
  }));
  const fetch = vi.fn(async (_input: string | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error("Unexpected update request");
  });
  vi.stubGlobal("fetch", fetch);
  return {
    base, skills, config, cache, fetch,
    setRegistry(value: string) { registry = value; },
    setRegistryResolver(value: () => Promise<string>) { resolveRegistry = value; },
    setBuild(value: appBuild.BuildIdentity) { build = value; },
    setCliVersion(value: string) { cliVersion = value; },
  };
}

function service(skills: string, onChange?: () => void): SoftwareUpdateService {
  const updates = new SoftwareUpdateService(skills, { onChange });
  services.push(updates);
  return updates;
}

afterEach(async () => {
  for (const release of releasePending.splice(0)) release();
  await Promise.all(services.splice(0).map((updates) => updates.dispose()));
  resultWriteGate.target = "";
  resultWriteGate.temporary = "";
  resultWriteGate.reached = null;
  resultWriteGate.release = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("software update lifecycle and result cache", () => {
  it("starts default-off without requests, update state, or activity", async () => {
    const f = await fixture();
    const updates = service(f.skills);
    await updates.start();

    expect(updates.preferences).toEqual({ app: false, cli: false });
    expect(updates.results).toEqual({});
    expect(updates.activity()).toEqual({
      app: { checking: false, lastAttemptAt: null, nextCheckAt: null },
      cli: { checking: false, lastAttemptAt: null, nextCheckAt: null },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(lstat(f.config)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(f.cache)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("notifies checking start and end around the first approved automatic check", async () => {
    vi.setSystemTime(NOW);
    const f = await fixture();
    const response = deferred(appResponse());
    f.fetch.mockImplementation(async () => response.promise);
    const events: Activity[] = [];
    let updates: SoftwareUpdateService;
    updates = service(f.skills, () => events.push(updates.activity().app));
    await updates.start();
    events.length = 0;

    await updates.setAutomatic("app", true);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(updates.preferences.app).toBe(true);
    expect(updates.results.app).toBeUndefined();
    expect(updates.activity().app).toEqual({ checking: true, lastAttemptAt: NOW, nextCheckAt: null });
    expect(events.some((event) => event.checking)).toBe(true);
    expect(JSON.parse(await readFile(path.join(f.config, "skills-manager", "app.json"), "utf8"))).toMatchObject({
      kind: "skills-manager-update-consent", version: 1, enabled: true, scope: APP_SCOPE,
    });
    expect(JSON.parse(await readFile(cacheFile(f.cache, "app", "attempt"), "utf8"))).toMatchObject({
      kind: "skills-manager-update-attempt", version: 1, at: NOW,
    });

    response.resolve(appResponse());
    await vi.waitFor(() => {
      expect(updates.results.app).toMatchObject({ status: "match", available: COMMIT_A, checkedAt: NOW });
      expect(updates.activity().app).toEqual({ checking: false, lastAttemptAt: NOW, nextCheckAt: NOW + DAY_MS });
    }, { timeout: 10_000 });
    expect((await lstat(path.join(f.cache, "skills-manager"))).mode & 0o077).toBe(0);
    const snapshots = await snapshotFiles(f.cache, "app");
    expect(snapshots).toHaveLength(1);
    expect((await lstat(snapshots[0])).mode & 0o077).toBe(0);
    const firstChecking = events.findIndex((event) => event.checking);
    expect(events.slice(firstChecking + 1).some((event) => !event.checking)).toBe(true);

    const manualResponse = deferred(appResponse(COMMIT_B));
    f.fetch.mockImplementation(async () => manualResponse.promise);
    const manual = updates.check("app");
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(updates.activity().app).toEqual({ checking: true, lastAttemptAt: NOW, nextCheckAt: NOW + DAY_MS });
    manualResponse.resolve(appResponse(COMMIT_B));
    await manual;
    expect(updates.activity().app.nextCheckAt).toBe(NOW + DAY_MS);
    await updates.dispose();
    expect(updates.activity().app.nextCheckAt).toBeNull();
  }, 15_000);

  it("restores completed manual results offline and compares both with the new installed identities", async () => {
    vi.setSystemTime(NOW);
    const f = await fixture();
    f.fetch.mockImplementation(async (input) => String(input).startsWith(APP_SCOPE) ? appResponse() : cliResponse());
    const first = service(f.skills);
    await first.start();
    await first.check("app");
    await first.check("cli");
    expect(first.results.app).toMatchObject({ status: "match", installed: COMMIT_A, available: COMMIT_A, checkedAt: NOW });
    expect(first.results.cli).toMatchObject({ status: "match", installed: "1.2.3", available: "1.2.3", checkedAt: NOW });
    expect(first.activity().app.lastAttemptAt).toBeNull();
    expect(first.activity().cli.lastAttemptAt).toBeNull();
    await first.dispose();

    vi.setSystemTime(NOW + 60_000);
    f.setBuild({ version: "2.0.0", commit: COMMIT_B, dirty: false, source: "git" });
    f.setCliVersion("2.0.0");
    const restarted = service(f.skills);
    await restarted.start();
    expect(restarted.preferences).toEqual({ app: false, cli: false });
    expect(restarted.results.app).toMatchObject({ status: "different", installed: COMMIT_B, available: COMMIT_A, checkedAt: NOW });
    expect(restarted.results.cli).toMatchObject({ status: "different", installed: "2.0.0", available: "1.2.3", checkedAt: NOW });
    expect(restarted.activity().app).toEqual({ checking: false, lastAttemptAt: null, nextCheckAt: null });
    expect(restarted.activity().cli).toEqual({ checking: false, lastAttemptAt: null, nextCheckAt: null });
    await restarted.dispose();

    f.setBuild({ version: "1.0.0", commit: COMMIT_A, dirty: true, source: "git" });
    f.setCliVersion("unknown");
    const unreliable = service(f.skills);
    await unreliable.start();
    expect(unreliable.results.app).toMatchObject({ status: "unknown", installed: COMMIT_A, available: COMMIT_A, checkedAt: NOW });
    expect(unreliable.results.cli).toMatchObject({ status: "unknown", installed: null, available: "1.2.3", checkedAt: NOW });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("restores an unavailable result as an error and treats it as a completed daily check", async () => {
    vi.setSystemTime(NOW);
    const f = await fixture();
    f.fetch.mockImplementation(async () => new Response("private registry response", { status: 503 }));
    const first = service(f.skills);
    await first.start();
    await first.check("cli");
    const observed = first.results.cli;
    expect(observed).toMatchObject({ status: "unavailable", available: null, checkedAt: NOW });
    expect(observed?.message).not.toContain("private registry response");
    await first.dispose();

    await seedConsent(f.config, "cli");
    await seedAttempt(f.cache, "cli", NOW);
    f.setCliVersion("unknown");
    const restarted = service(f.skills);
    await restarted.start();
    await vi.waitFor(() => {
      expect(restarted.activity().cli).toEqual({ checking: false, lastAttemptAt: NOW, nextCheckAt: NOW + DAY_MS });
      expect(restarted.results.cli).toMatchObject({
        status: "unavailable", installed: null, available: null, checkedAt: NOW, message: observed?.message,
      });
    }, { timeout: 10_000 });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("checks immediately on startup when a recent legacy attempt has no completed result", async () => {
    vi.setSystemTime(NOW);
    const f = await fixture();
    await seedConsent(f.config, "app");
    await seedAttempt(f.cache, "app", NOW - 60 * 60 * 1000);
    const response = deferred(appResponse());
    f.fetch.mockImplementation(async () => response.promise);
    const updates = service(f.skills);
    await updates.start();
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(updates.results.app).toBeUndefined();
    expect(updates.activity().app).toEqual({ checking: true, lastAttemptAt: NOW, nextCheckAt: null });
    expect(JSON.parse(await readFile(cacheFile(f.cache, "app", "attempt"), "utf8")).at).toBe(NOW);

    response.resolve(appResponse());
    await vi.waitFor(() => {
      expect(updates.results.app).toMatchObject({ checkedAt: NOW, available: COMMIT_A });
      expect(updates.activity().app).toEqual({ checking: false, lastAttemptAt: NOW, nextCheckAt: NOW + DAY_MS });
    }, { timeout: 10_000 });
  }, 15_000);

  it.each(["disable", "dispose"] as const)("reports the queued retry and clears it on %s", async (reason) => {
    vi.setSystemTime(NOW);
    const f = await fixture();
    await seedConsent(f.config, "app");
    await privateFile(cacheFile(f.cache, "app", "attempt"), "foreign attempt cache");
    const events: Activity[] = [];
    let updates: SoftwareUpdateService;
    updates = service(f.skills, () => events.push(updates.activity().app));
    await updates.start();
    await vi.waitFor(() => {
      expect(updates.errors.length).toBeGreaterThan(0);
      expect(updates.activity().app).toEqual({ checking: false, lastAttemptAt: null, nextCheckAt: NOW + 60_000 });
    }, { timeout: 10_000 });
    expect(events.some((event) => event.nextCheckAt === NOW + 60_000)).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();

    if (reason === "disable") await updates.setAutomatic("app", false);
    else await updates.dispose();
    expect(updates.activity().app.nextCheckAt).toBeNull();
  }, 15_000);

  it("keeps result and attempt times separate and checks now after fresh approval", async () => {
    vi.setSystemTime(NOW - 2 * 60 * 60 * 1000);
    const f = await fixture();
    f.fetch.mockImplementation(async () => appResponse());
    const first = service(f.skills);
    await first.start();
    await first.check("app");
    await first.dispose();
    const previous = NOW - 60 * 60 * 1000;
    await seedConsent(f.config, "app");
    await seedAttempt(f.cache, "app", previous);
    vi.setSystemTime(NOW);

    const response = deferred(appResponse(COMMIT_B));
    f.fetch.mockImplementation(async () => response.promise);
    const updates = service(f.skills);
    await updates.start();
    await vi.waitFor(() => {
      expect(updates.activity().app).toEqual({ checking: false, lastAttemptAt: previous, nextCheckAt: NOW - 2 * 60 * 60 * 1000 + DAY_MS });
      expect(updates.results.app).toMatchObject({ checkedAt: NOW - 2 * 60 * 60 * 1000, available: COMMIT_A });
    }, { timeout: 10_000 });
    expect(f.fetch).toHaveBeenCalledTimes(1);

    await updates.setAutomatic("app", true);
    expect(updates.activity().app).toEqual({ checking: false, lastAttemptAt: previous, nextCheckAt: NOW - 2 * 60 * 60 * 1000 + DAY_MS });
    expect(f.fetch).toHaveBeenCalledTimes(1);

    await updates.setAutomatic("app", false);
    expect(updates.activity().app.nextCheckAt).toBeNull();
    await updates.setAutomatic("app", true);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(updates.activity().app).toMatchObject({ checking: true, lastAttemptAt: NOW, nextCheckAt: null });
    response.resolve(appResponse(COMMIT_B));
    await vi.waitFor(() => {
      expect(updates.results.app).toMatchObject({ checkedAt: NOW, available: COMMIT_B });
      expect(updates.activity().app).toEqual({ checking: false, lastAttemptAt: NOW, nextCheckAt: NOW + DAY_MS });
    }, { timeout: 10_000 });
    expect(JSON.parse(await readFile(cacheFile(f.cache, "app", "attempt"), "utf8")).at).toBe(NOW);

    await updates.dispose();
    const restarted = service(f.skills);
    await restarted.start();
    await vi.waitFor(() => {
      expect(restarted.activity().app).toEqual({ checking: false, lastAttemptAt: NOW, nextCheckAt: NOW + DAY_MS });
      expect(restarted.results.app).toMatchObject({ checkedAt: NOW, available: COMMIT_B });
    }, { timeout: 10_000 });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("reports manual checking while registry revalidation and the HTTP request are pending", async () => {
    const f = await fixture();
    const registry = deferred(HOST_A);
    const response = deferred(cliResponse());
    f.fetch.mockImplementation(async () => response.promise);
    const events: Activity[] = [];
    let updates: SoftwareUpdateService;
    updates = service(f.skills, () => events.push(updates.activity().cli));
    await updates.start();
    let resolving = false;
    f.setRegistryResolver(() => { resolving = true; return registry.promise; });
    events.length = 0;

    const checking = updates.check("cli");
    await vi.waitFor(() => expect(resolving).toBe(true), { timeout: 10_000 });
    expect(updates.activity().cli.checking).toBe(true);
    expect(events.some((event) => event.checking)).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
    registry.resolve(HOST_A);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(updates.activity().cli.checking).toBe(true);
    response.resolve(cliResponse());
    await checking;
    expect(updates.activity().cli).toEqual({ checking: false, lastAttemptAt: null, nextCheckAt: null });
    expect(events.at(-1)?.checking).toBe(false);
    expect(updates.results.cli).toMatchObject({ status: "match", available: "1.2.3" });
  }, 15_000);

  it("reports automatic checking while registry revalidation and the HTTP request are pending", async () => {
    const f = await fixture();
    await seedConsent(f.config, "cli");
    const registry = deferred(HOST_A);
    const response = deferred(cliResponse());
    f.fetch.mockImplementation(async () => response.promise);
    const events: Activity[] = [];
    let updates: SoftwareUpdateService;
    updates = service(f.skills, () => events.push(updates.activity().cli));
    await updates.start();
    let resolving = false;
    f.setRegistryResolver(() => { resolving = true; return registry.promise; });

    await vi.waitFor(() => expect(resolving).toBe(true), { timeout: 10_000 });
    expect(updates.activity().cli.checking).toBe(true);
    expect(events.some((event) => event.checking)).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
    registry.resolve(HOST_A);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(updates.activity().cli.checking).toBe(true);
    response.resolve(cliResponse());
    await vi.waitFor(() => {
      expect(updates.results.cli).toMatchObject({ status: "match", available: "1.2.3" });
      expect(updates.activity().cli.checking).toBe(false);
    }, { timeout: 10_000 });
    expect(events.at(-1)?.checking).toBe(false);
  }, 15_000);

  it.each(["disable", "host switch", "shutdown"] as const)(
    "does not publish or cache a late response after %s",
    async (reason) => {
      const f = await fixture();
      const response = deferred(cliResponse());
      let signal: AbortSignal | undefined;
      f.fetch.mockImplementation(async (_input, init) => {
        signal = init?.signal ?? undefined;
        return response.promise;
      });
      const published: string[] = [];
      let updates: SoftwareUpdateService;
      updates = service(f.skills, () => {
        const available = updates.results.cli?.available;
        if (available) published.push(available);
      });
      await updates.start();
      const checking = updates.check("cli");
      await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(updates.activity().cli.checking).toBe(true);
      let closing: Promise<void> | undefined;
      if (reason === "disable") await updates.setAutomatic("cli", false);
      else if (reason === "host switch") {
        f.setRegistry(HOST_B);
        await updates.refreshRegistry();
      } else closing = updates.dispose();
      expect(signal?.aborted).toBe(true);
      response.resolve(cliResponse("9.9.9"));
      await checking;
      await closing;
      expect(updates.results.cli).toBeUndefined();
      expect(published).toEqual([]);
      await expect(lstat(cacheFile(f.cache, "cli", "result", HOST_A))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(cacheFile(f.cache, "cli", "result", HOST_B))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await snapshotFiles(f.cache, "cli", HOST_A)).toEqual([]);
      expect(await snapshotFiles(f.cache, "cli", HOST_B)).toEqual([]);
    }, 15_000,
  );

  it("keeps immutable snapshots, restores the newest, and does not repeat a completed automatic check", async () => {
    vi.setSystemTime(NOW - 120_000);
    const f = await fixture();
    const legacy = cacheFile(f.cache, "cli", "result");
    const legacyBytes = JSON.stringify({
      kind: "skills-manager-update-result", version: 1, component: "cli", scope: digest(scope("cli")),
      checkedAt: NOW - 180_000, available: "0.1.0", error: null,
    });
    await privateFile(legacy, legacyBytes);
    let latest = "1.2.3";
    f.fetch.mockImplementation(async () => cliResponse(latest));
    const first = service(f.skills);
    await first.start();
    expect(first.results.cli).toMatchObject({ available: "0.1.0", checkedAt: NOW - 180_000 });
    await first.check("cli");
    const firstSnapshots = await snapshotFiles(f.cache, "cli");
    expect(firstSnapshots).toHaveLength(1);
    expect(path.basename(firstSnapshots[0])).toMatch(new RegExp(
      `^result-cli-${digest(scope("cli"))}-${NOW - 120_000}-[0-9a-f-]{36}[.]json$`,
    ));
    const firstBytes = await readFile(firstSnapshots[0], "utf8");
    expect(JSON.parse(firstBytes)).toMatchObject({ checkedAt: NOW - 120_000, available: "1.2.3" });

    vi.setSystemTime(NOW - 60_000);
    latest = "9.9.9";
    await first.check("cli");
    const both = await snapshotFiles(f.cache, "cli");
    expect(both).toHaveLength(2);
    expect(both).toContain(firstSnapshots[0]);
    expect(await readFile(firstSnapshots[0], "utf8")).toBe(firstBytes);
    expect(await readFile(legacy, "utf8")).toBe(legacyBytes);
    const newer = both.find((file) => file !== firstSnapshots[0])!;
    const newerBytes = await readFile(newer, "utf8");
    expect(JSON.parse(newerBytes)).toMatchObject({ checkedAt: NOW - 60_000, available: "9.9.9" });
    expect((await lstat(newer)).mode & 0o077).toBe(0);
    await first.dispose();

    vi.setSystemTime(NOW);
    await seedConsent(f.config, "cli");
    await seedAttempt(f.cache, "cli", NOW - 30_000);
    const restarted = service(f.skills);
    await restarted.start();
    await vi.waitFor(() => {
      expect(restarted.results.cli).toMatchObject({ status: "different", available: "9.9.9", checkedAt: NOW - 60_000 });
      expect(restarted.activity().cli).toEqual({
        checking: false, lastAttemptAt: NOW - 30_000, nextCheckAt: NOW - 60_000 + DAY_MS,
      });
    }, { timeout: 10_000 });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(await snapshotFiles(f.cache, "cli")).toEqual(both);
    expect(await readFile(firstSnapshots[0], "utf8")).toBe(firstBytes);
    expect(await readFile(newer, "utf8")).toBe(newerBytes);
    expect(await readFile(legacy, "utf8")).toBe(legacyBytes);
  }, 15_000);

  it("restores only the result for the current credential-free registry scope", async () => {
    vi.setSystemTime(NOW);
    const f = await fixture();
    const credentialedA = "https://test-user:test-secret@registry-a.invalid/custom/";
    f.setRegistry(credentialedA);
    f.fetch.mockImplementation(async (input) => {
      if (String(input) === `${HOST_A}skills/latest`) return cliResponse("1.2.3");
      if (String(input) === `${HOST_B}skills/latest`) return cliResponse("9.9.9");
      throw new Error("Unexpected registry");
    });
    const first = service(f.skills);
    await first.start();
    await first.check("cli");
    expect(first.results.cli).toMatchObject({ available: "1.2.3", checkedAt: NOW });
    await first.dispose();
    const snapshots = await snapshotFiles(f.cache, "cli", HOST_A);
    expect(snapshots).toHaveLength(1);
    const stored = await readFile(snapshots[0], "utf8");
    expect(stored).not.toContain("test-user");
    expect(stored).not.toContain("test-secret");
    expect(stored).not.toContain("registry-a.invalid");

    vi.setSystemTime(NOW + 60_000);
    f.setRegistry(HOST_B);
    const second = service(f.skills);
    await second.start();
    expect(second.results.cli).toBeUndefined();
    await second.check("cli");
    expect(second.results.cli).toMatchObject({ available: "9.9.9", checkedAt: NOW + 60_000 });
    await second.dispose();

    f.setRegistry(HOST_A);
    const againA = service(f.skills);
    await againA.start();
    expect(againA.results.cli).toMatchObject({ available: "1.2.3", checkedAt: NOW });
    await againA.dispose();
    f.setRegistry(HOST_B);
    const againB = service(f.skills);
    await againB.start();
    expect(againB.results.cli).toMatchObject({ available: "9.9.9", checkedAt: NOW + 60_000 });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["already exists", "appears", "is replaced"] as const)(
    "preserves a foreign legacy result that %s while a snapshot is published",
    async (change) => {
      const f = await fixture();
      const file = cacheFile(f.cache, "cli", "result");
      const original = JSON.stringify({ kind: "original-foreign-state", note: "must remain untouched" });
      if (change !== "appears") await privateFile(file, original);
      f.fetch.mockImplementation(async () => cliResponse("9.9.9"));
      const updates = service(f.skills);
      await updates.start();
      const release = deferred<void>(undefined);
      let writing = false;
      resultWriteGate.target = resultPrefix(f.cache, "cli");
      resultWriteGate.reached = () => { writing = true; };
      resultWriteGate.release = release.promise;

      const checking = updates.check("cli");
      await vi.waitFor(() => expect(writing).toBe(true), { timeout: 10_000 });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(updates.results.cli).toBeUndefined();
      const foreign = change === "already exists" ? original : JSON.stringify({ kind: "foreign-user-state", note: "must remain untouched" });
      if (change === "is replaced") {
        const replacement = path.join(f.base, "foreign-replacement");
        await privateFile(replacement, foreign);
        await rename(replacement, file);
      } else if (change === "appears") await privateFile(file, foreign);
      release.resolve();
      await checking;
      expect(await readFile(file, "utf8")).toBe(foreign);
      expect(updates.results.cli).toMatchObject({
        status: "different", installed: "1.2.3", available: "9.9.9",
      });
      const snapshots = await snapshotFiles(f.cache, "cli");
      expect(snapshots).toHaveLength(1);
      expect(JSON.parse(await readFile(snapshots[0], "utf8"))).toMatchObject({
        kind: "skills-manager-update-result", component: "cli", available: "9.9.9", error: null,
      });

      await updates.dispose();
      const restarted = service(f.skills);
      await restarted.start();
      expect(restarted.results.cli).toMatchObject({ status: "different", available: "9.9.9" });
      expect(restarted.errors.length).toBeGreaterThan(0);
      expect(restarted.errors.join(" ")).not.toContain("must remain untouched");
      expect(await readFile(file, "utf8")).toBe(foreign);
      expect(await snapshotFiles(f.cache, "cli")).toEqual(snapshots);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }, 15_000,
  );

  it("does not clobber a foreign file racing the exact snapshot destination", async () => {
    const f = await fixture();
    f.fetch.mockImplementation(async () => cliResponse("9.9.9"));
    const updates = service(f.skills);
    await updates.start();
    const release = deferred<void>(undefined);
    let writing = false;
    resultWriteGate.target = resultPrefix(f.cache, "cli");
    resultWriteGate.reached = () => { writing = true; };
    resultWriteGate.release = release.promise;

    const checking = updates.check("cli");
    await vi.waitFor(() => expect(writing).toBe(true), { timeout: 10_000 });
    expect(resultWriteGate.temporary).toMatch(/\.[a-f0-9]{24}\.tmp$/);
    const destination = resultWriteGate.temporary.replace(/\.[a-f0-9]{24}\.tmp$/, "");
    const foreign = JSON.stringify({ kind: "foreign-user-state", note: "must not be replaced" });
    await privateFile(destination, foreign);
    release.resolve();
    await checking;

    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(destination, "utf8")).toBe(foreign);
    expect(await snapshotFiles(f.cache, "cli")).toEqual([destination]);
    expect(updates.results.cli).toMatchObject({ status: "different", installed: "1.2.3", available: "9.9.9" });
    expect(updates.errors.join(" ")).toMatch(/result|cache|sav/i);
    expect(updates.errors.join(" ")).not.toContain("must not be replaced");
    await updates.dispose();
    const restarted = service(f.skills);
    await restarted.start();
    expect(restarted.results.cli).toBeUndefined();
    expect(await readFile(destination, "utf8")).toBe(foreign);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  }, 15_000);

  describe.each(["legacy", "snapshot"] as const)("%s result cache", (storage) => {
    it.each([
      "not JSON", "foreign marker", "foreign scope", "foreign component", "invalid timestamp", "oversize",
    ] as const)("skips and preserves a %s file while saving a new result", async (kind) => {
      vi.setSystemTime(NOW);
      const f = await fixture();
      const file = storage === "legacy" ? cacheFile(f.cache, "cli", "result") : snapshotFixtureFile(f.cache, "cli", NOW);
      const record = {
        kind: kind === "foreign marker" ? "someone-elses-state" : "skills-manager-update-result",
        version: 1,
        component: kind === "foreign component" ? "app" : "cli",
        scope: kind === "foreign scope" ? digest("another scope") : digest(scope("cli")),
        checkedAt: kind === "invalid timestamp" ? "not a timestamp" : NOW,
        available: "1.2.3",
        error: null,
        ...(kind === "oversize" ? { padding: "x".repeat(5000) } : {}),
      };
      const contents = kind === "not JSON" ? "not JSON" : JSON.stringify(record);
      await privateFile(file, contents);
      f.fetch.mockImplementation(async () => cliResponse("9.9.9"));
      const updates = service(f.skills);
      await updates.start();
      expect(updates.results.cli).toBeUndefined();
      expect(updates.errors.length).toBeGreaterThan(0);
      await updates.check("cli");
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(updates.results.cli).toMatchObject({ status: "different", available: "9.9.9" });
      expect(await readFile(file, "utf8")).toBe(contents);
      await updates.dispose();
      const restarted = service(f.skills);
      await restarted.start();
      expect(restarted.results.cli).toMatchObject({ status: "different", available: "9.9.9", checkedAt: NOW });
      expect(await readFile(file, "utf8")).toBe(contents);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }, 15_000);

    it.each(["world-readable file", "symlink"] as const)("skips and preserves an unsafe %s", async (kind) => {
      vi.setSystemTime(NOW);
      const f = await fixture();
      const file = storage === "legacy" ? cacheFile(f.cache, "cli", "result") : snapshotFixtureFile(f.cache, "cli", NOW);
      const contents = JSON.stringify({
        kind: "skills-manager-update-result", version: 1, component: "cli", scope: digest(scope("cli")),
        checkedAt: NOW, available: "1.2.3", error: null,
      });
      let target = file;
      if (kind === "symlink") {
        target = path.join(f.base, "foreign-result");
        await privateFile(target, contents);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await symlink(target, file);
      } else {
        await privateFile(file, contents);
        await chmod(file, 0o644);
      }
      f.fetch.mockImplementation(async () => cliResponse("9.9.9"));
      const updates = service(f.skills);
      await updates.start();
      expect(updates.results.cli).toBeUndefined();
      expect(updates.errors.length).toBeGreaterThan(0);
      await updates.check("cli");
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(updates.results.cli).toMatchObject({ status: "different", available: "9.9.9" });
      expect(await readFile(target, "utf8")).toBe(contents);
      if (kind === "symlink") expect((await lstat(file)).isSymbolicLink()).toBe(true);
      else expect((await lstat(file)).mode & 0o777).toBe(0o644);
      await updates.dispose();
      const restarted = service(f.skills);
      await restarted.start();
      expect(restarted.results.cli).toMatchObject({ status: "different", available: "9.9.9" });
      expect(await readFile(target, "utf8")).toBe(contents);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }, 15_000);
  });

  it.each([
    ["legacy", "not JSON"], ["legacy", "foreign marker"], ["legacy", "oversize"],
    ["snapshot", "not JSON"], ["snapshot", "foreign marker"], ["snapshot", "oversize"],
  ] as const)(
    "checks once despite a %s %s result, preserves it, and shares the completed snapshot",
    async (storage, kind) => {
      const now = Date.now();
      vi.setSystemTime(now);
      const f = await fixture();
      await seedConsent(f.config, "app");
      await seedAttempt(f.cache, "app", now - 60 * 60 * 1000);
      const file = storage === "legacy" ? cacheFile(f.cache, "app", "result") : snapshotFixtureFile(f.cache, "app", now);
      const contents = kind === "not JSON" ? "not JSON" : JSON.stringify({
        kind: kind === "foreign marker" ? "someone-elses-state" : "skills-manager-update-result",
        version: 1, component: "app", scope: digest(scope("app")), checkedAt: now,
        available: COMMIT_A, error: null, ...(kind === "oversize" ? { padding: "x".repeat(5000) } : {}),
      });
      await privateFile(file, contents);
      const response = deferred(appResponse());
      f.fetch.mockImplementation(async () => response.promise);
      const firstEvents: Activity[] = [];
      const secondEvents: Activity[] = [];
      let first: SoftwareUpdateService;
      let second: SoftwareUpdateService;
      first = service(f.skills, () => firstEvents.push(first.activity().app));
      second = service(f.skills, () => secondEvents.push(second.activity().app));
      await Promise.all([first.start(), second.start()]);
      await vi.waitFor(() => {
        expect(first.errors.length).toBeGreaterThan(0);
        expect(second.errors.length).toBeGreaterThan(0);
        expect(f.fetch).toHaveBeenCalledTimes(1);
        expect(firstEvents.some((event) => event.checking)).toBe(true);
        expect(secondEvents.some((event) => event.checking)).toBe(true);
        expect([first.activity().app.checking, second.activity().app.checking].filter(Boolean)).toHaveLength(1);
      }, { timeout: 10_000 });
      expect(await readFile(file, "utf8")).toBe(contents);
      response.resolve(appResponse());
      await vi.waitFor(() => {
        expect(first.activity().app).toEqual({ checking: false, lastAttemptAt: now, nextCheckAt: now + DAY_MS });
        expect(second.activity().app).toEqual({ checking: false, lastAttemptAt: now, nextCheckAt: now + DAY_MS });
        expect(first.results.app).toMatchObject({ available: COMMIT_A, checkedAt: now });
        expect(second.results.app).toMatchObject({ available: COMMIT_A, checkedAt: now });
      }, { timeout: 10_000 });
      const snapshots = await snapshotFiles(f.cache, "app");
      expect(snapshots).toHaveLength(storage === "snapshot" ? 2 : 1);
      expect(await readFile(file, "utf8")).toBe(contents);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await Promise.all([first.dispose(), second.dispose()]);
      const restarted = service(f.skills);
      await restarted.start();
      await vi.waitFor(() => {
        expect(restarted.results.app).toMatchObject({ available: COMMIT_A, checkedAt: now });
        expect(restarted.activity().app).toEqual({ checking: false, lastAttemptAt: now, nextCheckAt: now + DAY_MS });
      }, { timeout: 10_000 });
      expect(await readFile(file, "utf8")).toBe(contents);
      expect(await snapshotFiles(f.cache, "app")).toEqual(snapshots);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }, 20_000,
  );

  it.each(["not JSON", "foreign marker", "oversize"] as const)(
    "does not claim or overwrite a %s automatic-attempt cache",
    async (kind) => {
      vi.setSystemTime(NOW);
      const f = await fixture();
      await seedConsent(f.config, "app");
      const file = cacheFile(f.cache, "app", "attempt");
      const contents = kind === "not JSON" ? "not JSON" : JSON.stringify({
        kind: kind === "foreign marker" ? "someone-elses-state" : "skills-manager-update-attempt",
        version: 1, at: NOW - DAY_MS, ...(kind === "oversize" ? { padding: "x".repeat(5000) } : {}),
      });
      await privateFile(file, contents);
      const events: Activity[] = [];
      let updates: SoftwareUpdateService;
      updates = service(f.skills, () => events.push(updates.activity().app));
      await updates.start();
      await vi.waitFor(() => {
        expect(updates.errors.length).toBeGreaterThan(0);
        expect(events.some((event) => event.checking)).toBe(true);
        expect(updates.activity().app.checking).toBe(false);
      }, { timeout: 10_000 });
      expect(updates.results.app).toBeUndefined();
      expect(updates.activity().app.lastAttemptAt).toBeNull();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(contents);
    }, 15_000,
  );

  it.each([
    "not a registry", "file:///private/registry/", "https://user:secret@registry-a.invalid/custom/?token=private",
  ])("fails closed for the malformed registry %s", async (registry) => {
    const f = await fixture();
    f.setRegistry(registry);
    const updates = service(f.skills);
    await updates.start();
    await updates.check("cli");
    await updates.setAutomatic("cli", true);
    expect(updates.preferences.cli).toBe(false);
    expect(updates.results.cli?.status).not.toBe("match");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify({ results: updates.results, errors: updates.errors })).not.toMatch(/secret|token=private/);
  });

  it("shares one recovery request across instances with a recent orphaned attempt", async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const f = await fixture();
    await seedConsent(f.config, "app");
    await seedAttempt(f.cache, "app", now - 60 * 60 * 1000);
    const response = deferred(appResponse());
    f.fetch.mockImplementation(async () => response.promise);
    const firstEvents: Activity[] = [];
    const secondEvents: Activity[] = [];
    let first: SoftwareUpdateService;
    let second: SoftwareUpdateService;
    first = service(f.skills, () => firstEvents.push(first.activity().app));
    second = service(f.skills, () => secondEvents.push(second.activity().app));
    await Promise.all([first.start(), second.start()]);
    await vi.waitFor(() => {
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(firstEvents.some((event) => event.checking)).toBe(true);
      expect(secondEvents.some((event) => event.checking)).toBe(true);
      const activity = [first.activity().app, second.activity().app];
      expect(activity.filter((item) => item.checking)).toHaveLength(1);
      expect(activity.find((item) => item.checking)?.nextCheckAt).toBeNull();
      expect(activity.find((item) => !item.checking)?.nextCheckAt).toBe(now + 1000);
    }, { timeout: 10_000 });
    expect(JSON.parse(await readFile(cacheFile(f.cache, "app", "attempt"), "utf8")).at).toBe(now);
    response.resolve(appResponse());
    await vi.waitFor(() => {
      expect(first.activity().app).toEqual({ checking: false, lastAttemptAt: now, nextCheckAt: now + DAY_MS });
      expect(second.activity().app).toEqual({ checking: false, lastAttemptAt: now, nextCheckAt: now + DAY_MS });
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }, { timeout: 10_000 });
  }, 20_000);
});
