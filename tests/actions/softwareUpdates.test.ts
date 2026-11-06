import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SoftwareUpdateService } from "../../src/actions/softwareUpdates.js";

const roots: string[] = [];
const services: SoftwareUpdateService[] = [];

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "software-updates-test-")));
  roots.push(base);
  const skills = path.join(base, "skills");
  const config = path.join(base, "config");
  const cache = path.join(base, "cache");
  await mkdir(skills);
  vi.stubEnv("HOME", base);
  vi.stubEnv("XDG_CONFIG_HOME", config);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  vi.stubEnv("npm_config_registry", "http://127.0.0.1:31415/custom/");
  return { base, skills, config, cache };
}

function service(skills: string, onChange?: () => void): SoftwareUpdateService {
  const value = new SoftwareUpdateService(skills, { onChange });
  services.push(value);
  return value;
}

function registryResponse(version: string): Response {
  return new Response(JSON.stringify({ name: "skills", version }), { status: 200 });
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.dispose()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("software update consent and checks", () => {
  it("does not request or write anything on a fresh start; manual checks are separate and never opt in", async () => {
    const { skills, config, cache } = await fixture();
    const requests: string[] = [];
    let cliVersion = "999.0.0";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(String(input));
      return String(input).startsWith("https://api.github.com/")
        ? new Response("1".repeat(40), { status: 200 })
        : registryResponse(cliVersion);
    }));
    const updates = service(skills);
    await updates.start();
    expect(updates.preferences).toEqual({ app: false, cli: false });
    expect(requests).toEqual([]);
    await expect(lstat(config)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });

    await updates.check("app");
    expect(requests).toEqual(["https://api.github.com/repos/ederheisler/skills-manager/commits/main"]);
    const knownClean = updates.build.commit && !updates.build.dirty && updates.build.source !== "unknown";
    expect(updates.results.app?.status).toBe(knownClean
      ? updates.build.commit === "1".repeat(40) ? "match" : "different"
      : "unknown");
    expect(updates.preferences).toEqual({ app: false, cli: false });
    expect(updates.cliVersion).not.toBeNull();
    cliVersion = updates.cliVersion!;
    await updates.check("cli");
    expect(requests[1]).toBe("http://127.0.0.1:31415/custom/skills/latest");
    expect(updates.results.cli).toMatchObject({ status: "match", installed: cliVersion, available: cliVersion });
    cliVersion = "999.0.0";
    await updates.check("cli");
    expect(updates.results.cli?.status).toBe("different");
    expect(updates.preferences).toEqual({ app: false, cli: false });
    await expect(lstat(config)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(cache)).isDirectory()).toBe(true);
  }, 30_000);

  it("persists independent consent and only permits automatic CLI requests to the approved registry", async () => {
    const { skills } = await fixture();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(String(input));
      return registryResponse("999.0.0");
    }));
    const first = service(skills);
    await first.start();
    await first.setAutomatic("cli", true);
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(first.results.cli?.available).toBe("999.0.0"), { timeout: 10_000 });
    expect(first.preferences).toEqual({ app: false, cli: true });
    await first.dispose();

    let observing = false;
    let checked = false;
    const sameHost = service(skills, () => { if (observing) checked = true; });
    await sameHost.start();
    expect(sameHost.preferences).toEqual({ app: false, cli: true });
    observing = true;
    await vi.waitFor(() => expect(checked).toBe(true), { timeout: 10_000 });
    expect(requests).toHaveLength(1);
    await sameHost.dispose();

    vi.stubEnv("npm_config_registry", "http://127.0.0.1:31416/other/");
    const changedHost = service(skills);
    await changedHost.start();
    expect(changedHost.preferences).toEqual({ app: false, cli: false });
    expect(requests).toHaveLength(1);
    await changedHost.setAutomatic("cli", true);
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 10_000 });
    expect(requests[1]).toBe("http://127.0.0.1:31416/other/skills/latest");
  }, 30_000);

  it("persists revocation without changing the other component's consent", async () => {
    const { skills } = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => registryResponse("999.0.0")));
    const first = service(skills);
    await first.start();
    await first.setAutomatic("app", true);
    await first.setAutomatic("cli", true);
    await first.setAutomatic("app", false);
    expect(first.preferences).toEqual({ app: false, cli: true });
    await first.dispose();
    const restarted = service(skills);
    await restarted.start();
    expect(restarted.preferences).toEqual({ app: false, cli: true });
  }, 30_000);

  it("revalidates a changed registry before a manual request and never persists embedded credentials", async () => {
    const { skills, config } = await fixture();
    vi.stubEnv("npm_config_registry", "http://user:secret@127.0.0.1:31415/private-token/");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(String(input));
      return registryResponse("999.0.0");
    }));
    const updates = service(skills);
    await updates.start();
    expect(updates.registry).toContain("user:secret");
    const reviewedRegistry = updates.registry;
    await updates.setAutomatic("cli", true);
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10_000 });
    expect(requests[0]).toBe("http://127.0.0.1:31415/private-token/skills/latest");
    const consent = await readFile(path.join(config, "skills-manager", "cli.json"), "utf8");
    expect(consent).not.toContain("secret");
    expect(consent).not.toContain("private-token");
    expect(JSON.stringify(updates.results)).not.toContain("secret");
    expect(updates.errors.join(" ")).not.toContain("secret");

    vi.stubEnv("npm_config_registry", "http://127.0.0.1:31416/changed/");
    await updates.check("cli");
    expect(updates.preferences.cli).toBe(false);
    expect(requests).toHaveLength(1);
    expect(updates.registry).toBe("http://127.0.0.1:31416/changed/");
    await updates.check("cli", reviewedRegistry);
    await updates.setAutomatic("cli", true, reviewedRegistry);
    expect(requests).toHaveLength(1);
    expect(updates.preferences.cli).toBe(false);
    await updates.check("cli", updates.registry);
    expect(requests[1]).toBe("http://127.0.0.1:31416/changed/skills/latest");
    vi.stubEnv("npm_config_registry", "http://127.0.0.1:31417/third/");
    await updates.refreshRegistry();
    expect(updates.registry).toBe("http://127.0.0.1:31417/third/");
    expect(requests).toHaveLength(2);
  }, 30_000);

  it("reports an unresolvable private npmrc registry as unknown without contacting another origin", async () => {
    const { base, skills, config, cache } = await fixture();
    const npmrc = path.join(base, "npmrc");
    const contents = "registry=http://user:npmrc-secret@127.0.0.1:31415/private/\n";
    await writeFile(npmrc, contents);
    vi.stubEnv("npm_config_registry", "");
    vi.stubEnv("NPM_CONFIG_REGISTRY", "");
    vi.stubEnv("npm_config_userconfig", npmrc);
    vi.stubEnv("NPM_CONFIG_USERCONFIG", npmrc);
    const fetch = vi.fn(async () => registryResponse("999.0.0"));
    vi.stubGlobal("fetch", fetch);
    const updates = service(skills);
    await updates.start();
    expect(updates.registry).toBe("");
    await updates.check("cli");
    expect(updates.results.cli?.status).toBe("unavailable");
    await updates.setAutomatic("cli", true);
    expect(updates.preferences.cli).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(updates.errors.join(" ")).not.toContain("npmrc-secret");
    expect(await readFile(npmrc, "utf8")).toBe(contents);
    await expect(lstat(config)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("shares the daily automatic attempt between concurrently started instances", async () => {
    const { skills } = await fixture();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(String(input));
      return new Response("2".repeat(40), { status: 200 });
    }));
    const first = service(skills);
    await first.start();
    await first.setAutomatic("app", true);
    await vi.waitFor(() => expect(first.results.app?.available).toBe("2".repeat(40)), { timeout: 10_000 });
    await first.dispose();
    let secondObserving = false;
    let thirdObserving = false;
    let secondChecked = false;
    let thirdChecked = false;
    const second = service(skills, () => { if (secondObserving) secondChecked = true; });
    const third = service(skills, () => { if (thirdObserving) thirdChecked = true; });
    await Promise.all([
      second.start().then(() => { secondObserving = true; }),
      third.start().then(() => { thirdObserving = true; }),
    ]);
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
      expect(secondChecked).toBe(true);
      expect(thirdChecked).toBe(true);
    }, { timeout: 10_000 });
    expect(second.preferences).toEqual({ app: true, cli: false });
    expect(third.preferences).toEqual({ app: true, cli: false });
  }, 30_000);

  it("enforces a rolling 24-hour interval after a completed check across restarts", async () => {
    const { skills } = await fixture();
    const start = Date.parse("2030-01-01T12:00:00Z");
    vi.setSystemTime(start);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(String(input));
      return new Response("6".repeat(40), { status: 200 });
    }));
    const first = service(skills);
    await first.start();
    await first.setAutomatic("app", true);
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(first.results.app?.available).toBe("6".repeat(40)), { timeout: 10_000 });
    await first.dispose();

    vi.setSystemTime(start + 23 * 60 * 60 * 1000);
    let observing = false;
    let checked = false;
    const early = service(skills, () => { if (observing) checked = true; });
    await early.start();
    observing = true;
    await vi.waitFor(() => expect(checked).toBe(true), { timeout: 10_000 });
    expect(requests).toHaveLength(1);
    await early.dispose();

    vi.setSystemTime(start + 24 * 60 * 60 * 1000);
    const due = service(skills);
    await due.start();
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 10_000 });
  }, 30_000);

  it("coordinates automatic attempts across separate app processes", async () => {
    const { skills, base, cache, config } = await fixture();
    await mkdir(path.join(config, "skills-manager"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(config, "skills-manager", "app.json"), JSON.stringify({
      kind: "skills-manager-update-consent", version: 1, enabled: true, scope: "https://api.github.com",
    }), { mode: 0o600 });
    await mkdir(path.join(cache, "skills-manager"), { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update("https://api.github.com").digest("hex");
    await writeFile(path.join(cache, "skills-manager", `attempt-app-${hash}.json`), JSON.stringify({
      kind: "skills-manager-update-attempt", version: 1, at: Date.now() - 41 * 60 * 1000,
    }), { mode: 0o600 });
    const log = path.join(base, "requests");
    const moduleUrl = pathToFileURL(path.resolve("src/actions/softwareUpdates.ts")).href;
    const program = `
      import { appendFile } from "node:fs/promises";
      import { SoftwareUpdateService } from ${JSON.stringify(moduleUrl)};
      globalThis.fetch = async () => {
        await appendFile(process.env.REQUEST_LOG, "request\\n");
        return new Response("5".repeat(40));
      };
      // The headless fixture needs a live handle for the intentionally unref'ed scheduler.
      const keepAlive = setInterval(() => {}, 60_000);
      const done = Promise.withResolvers();
      let started = false;
      const updates = new SoftwareUpdateService(process.env.SKILLS_ROOT, {
        onChange() { if (started && !updates.activity().app.checking) done.resolve(); },
      });
      await updates.start();
      started = true;
      await done.promise;
      await updates.dispose();
      clearInterval(keepAlive);
    `;
    const run = promisify(execFile);
    const options = { cwd: process.cwd(), timeout: 20_000, env: { ...process.env, REQUEST_LOG: log, SKILLS_ROOT: skills } };
    await Promise.all([
      run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], options),
      run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], options),
    ]);
    expect(await readFile(log, "utf8")).toBe("request\n");
  }, 30_000);

  it("does not present HTTP errors, malformed metadata, or oversized responses as current", async () => {
    const { skills } = await fixture();
    let response = new Response("rate limited", { status: 429 });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const updates = service(skills);
    await updates.start();
    await updates.check("cli");
    expect(updates.results.cli).toMatchObject({ status: "unavailable", available: null });
    response = new Response(JSON.stringify({ name: "skills", version: "1.2.3\u001b[31m" }), { status: 200 });
    await updates.check("cli");
    expect(updates.results.cli).toMatchObject({ status: "unavailable", available: null });
    response = new Response("x".repeat(300_000), { status: 200 });
    await updates.check("cli");
    expect(updates.results.cli).toMatchObject({ status: "unavailable", available: null });
  }, 30_000);

  it("accepts a compact app SHA with a trailing newline and rejects malformed and JSON responses", async () => {
    const { skills } = await fixture();
    let body = `${"a".repeat(40)}\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const updates = service(skills);
    await updates.start();
    await updates.check("app");
    expect(updates.results.app?.available).toBe("a".repeat(40));

    for (const invalid of ["a".repeat(39), "g".repeat(40), JSON.stringify({ sha: "a".repeat(40) })]) {
      body = invalid;
      await updates.check("app");
      expect(updates.results.app).toMatchObject({ status: "unavailable", available: null });
    }
  }, 15_000);

  it("cancels rejected response streams without waiting for the remote body", async () => {
    const { skills } = await fixture();
    let cancelled = 0;
    const stream = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    let response = new Response(stream(), { status: 429 });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const updates = service(skills);
    await updates.start();
    await updates.check("app");
    expect(cancelled).toBe(1);
    expect(updates.results.app?.status).toBe("unavailable");

    response = new Response(stream(), { status: 200, headers: { "content-length": "300000" } });
    await updates.check("app");
    expect(cancelled).toBe(2);
    expect(updates.results.app?.status).toBe("unavailable");
  }, 15_000);

  it("finishes an explicit in-flight check when automatic consent is revoked", async () => {
    const { skills } = await fixture();
    const response = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      requested.resolve();
      return response.promise;
    }));
    const updates = service(skills);
    await updates.start();
    const pending = updates.check("cli");
    try {
      await requested.promise;
      await updates.setAutomatic("cli", false);
      expect(signal?.aborted).toBe(false);
      expect(updates.preferences.cli).toBe(false);
    } finally {
      response.resolve(registryResponse("999.0.0"));
      await pending;
    }
    expect(updates.preferences.cli).toBe(false);
    expect(updates.results.cli).toMatchObject({ available: "999.0.0" });
  }, 15_000);

  it("awaits cancellation on disposal without publishing a late result", async () => {
    const { skills } = await fixture();
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn((_input: string | URL, init: RequestInit) => {
      init.signal!.addEventListener("abort", () => response.reject(new DOMException("aborted", "AbortError")), { once: true });
      requested.resolve();
      return response.promise;
    }));
    const updates = service(skills);
    await updates.start();
    const pending = updates.check("app");
    await requested.promise;
    await updates.dispose();
    await pending;
    expect(updates.results.app).toBeUndefined();
  }, 15_000);

  it("does not notify or schedule checks after disposal races startup", async () => {
    const { skills } = await fixture();
    const fetch = vi.fn(async () => registryResponse("999.0.0"));
    vi.stubGlobal("fetch", fetch);
    let notifications = 0;
    const updates = service(skills, () => { notifications++; });
    const starting = updates.start();
    await updates.dispose();
    await starting;
    expect(notifications).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  }, 15_000);

  it("fails closed on invalid consent and refuses storage overlapping a selected skills root", async () => {
    const { skills, config } = await fixture();
    await mkdir(path.join(config, "skills-manager"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(config, "skills-manager", "app.json"), "not JSON", { mode: 0o600 });
    const fetch = vi.fn(async () => registryResponse("999.0.0"));
    vi.stubGlobal("fetch", fetch);
    const invalid = service(skills);
    await invalid.start();
    expect(invalid.preferences.app).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
    await invalid.setAutomatic("app", true);
    expect(invalid.preferences.app).toBe(false);
    expect(await readFile(path.join(config, "skills-manager", "app.json"), "utf8")).toBe("not JSON");
    await invalid.dispose();

    vi.stubEnv("XDG_CONFIG_HOME", skills);
    const overlapping = service(skills);
    await overlapping.start();
    await overlapping.setAutomatic("app", true);
    expect(overlapping.preferences.app).toBe(false);
    expect(overlapping.errors.length).toBeGreaterThan(0);
    await expect(lstat(path.join(skills, "skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("rejects config and cache destinations redirected into a skills root by an ancestor symlink", async () => {
    const { skills, config, base } = await fixture();
    const alias = path.join(base, "alias");
    await symlink(skills, alias);
    vi.stubGlobal("fetch", vi.fn(async () => registryResponse("999.0.0")));
    vi.stubEnv("XDG_CONFIG_HOME", alias);
    const badConfig = service(skills);
    await badConfig.start();
    await badConfig.setAutomatic("app", true);
    expect(badConfig.preferences.app).toBe(false);
    await badConfig.dispose();

    vi.stubEnv("XDG_CONFIG_HOME", config);
    vi.stubEnv("XDG_CACHE_HOME", alias);
    const badCache = service(skills);
    await badCache.start();
    await badCache.setAutomatic("app", true);
    expect(badCache.preferences.app).toBe(false);
    expect(badCache.errors.length).toBeGreaterThan(0);
    await expect(lstat(path.join(skills, "skills-manager"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(config)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("rejects a symlinked app-owned directory and keeps prior consent disabled when persistence fails", async () => {
    const { skills, config, base } = await fixture();
    const fetch = vi.fn(async () => new Response("3".repeat(40), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const updates = service(skills);
    await updates.start();
    await updates.setAutomatic("app", true);
    const appDirectory = path.join(config, "skills-manager");
    const saved = path.join(base, "saved-consent");
    await rename(appDirectory, saved);
    await symlink(saved, appDirectory);
    await updates.setAutomatic("app", false);
    expect(updates.preferences.app).toBe(false);
    expect(updates.errors.join(" ")).toMatch(/future|next|later/i);
    expect(JSON.parse(await readFile(path.join(saved, "app.json"), "utf8")).enabled).toBe(true);
    await unlink(appDirectory);
  }, 15_000);
});
