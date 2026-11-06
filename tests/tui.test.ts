import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { RGBA, type ClipboardService } from "@opentui/core";
import { createTestRenderer as createOpenTuiTestRenderer, MouseButtons } from "@opentui/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveSkillsRoot, fingerprintContents } from "../src/actions/boundary.js";
import { SoftwareUpdateService } from "../src/actions/softwareUpdates.js";
import * as appUpdateHandoff from "../src/actions/appUpdateHandoff.js";
import * as appBuild from "../src/state/appBuild.js";
import { SkillsManagerTui, type ApplicationUpdateHandoff } from "../src/tui.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const applications: SkillsManagerTui[] = [];
const renderers: Array<Awaited<ReturnType<typeof createOpenTuiTestRenderer>>["renderer"]> = [];

function createTrackedTui(...args: ConstructorParameters<typeof SkillsManagerTui>): SkillsManagerTui {
  const app = new SkillsManagerTui(...args);
  applications.push(app);
  return app;
}

async function createTestRenderer(options: Parameters<typeof createOpenTuiTestRenderer>[0]) {
  const setup = await createOpenTuiTestRenderer(options);
  renderers.push(setup.renderer);
  return {
    ...setup,
    async waitFor(predicate: () => boolean | Promise<boolean>, timeout = 4_000): Promise<void> {
      const deadline = Date.now() + timeout;
      do {
        await setup.renderOnce();
        if (await predicate()) return;
        await delay(10);
      } while (Date.now() < deadline);
      throw new Error(`Timed out waiting for the terminal frame:\n${setup.captureCharFrame()}`);
    },
  };
}

// Read only the visible confirmation body, joining terminal-wrapped rows without
// including the surrounding panes or the scrollbar.
function confirmationText(frame: string, title: string): string {
  const rows = frame.split("\n");
  const top = rows.findIndex((row) => row.includes(`┌─${title}`));
  expect(top).toBeGreaterThanOrEqual(0);
  const left = rows[top]!.indexOf(`┌─${title}`);
  const right = rows[top]!.indexOf("┐", left);
  expect(right).toBeGreaterThan(left);
  const body: string[] = [];
  for (const row of rows.slice(top + 1)) {
    if (row[left] === "└") break;
    body.push(row.slice(left + 2, right - 1).trimEnd());
  }
  return body.join("");
}

async function fixture(directoryName = "chosen-skills"): Promise<{ home: string; skillsDir: string }> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-tui-")));
  roots.push(home);
  const skillsDir = path.join(home, directoryName);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, "config"));
  vi.stubEnv("XDG_CACHE_HOME", path.join(home, "cache"));
  await mkdir(path.join(home, "npm-global"));
  for (const [name, value] of Object.entries({
    registry: "https://registry.npmjs.org/",
    prefix: path.join(home, "npm-global"),
    cache: path.join(home, "npm-cache"),
    userconfig: path.join(home, "user.npmrc"),
    globalconfig: path.join(home, "global.npmrc"),
  })) {
    vi.stubEnv(`npm_config_${name}`, value);
    vi.stubEnv(`NPM_CONFIG_${name.toUpperCase()}`, value);
  }
  await mkdir(path.join(skillsDir, "alpha"), { recursive: true });
  await mkdir(path.join(skillsDir, ".disabled_skills", "beta"), { recursive: true });
  await writeFile(path.join(skillsDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha description\nauthors: [Ada, Grace]\n---\n\n# Alpha body\n\nLocal content for selection.\n");
  await writeFile(path.join(skillsDir, "alpha", "notes.txt"), "Notes from the selected file.\n");
  await writeFile(path.join(skillsDir, ".disabled_skills", "beta", "SKILL.md"), "---\nname: beta\n---\n\n# Beta body\n");
  return { home, skillsDir };
}

async function savedSourceFixture(skillsDir: string) {
  const skill = path.join(skillsDir, "alpha");
  const metadata = path.join(skillsDir, ".skills-manager", "metadata");
  await mkdir(metadata, { recursive: true, mode: 0o700 });
  await writeFile(path.join(skillsDir, ".skills-manager", "owner"), "skills-manager-owned-state-v1\n", { mode: 0o600 });
  await writeFile(path.join(skillsDir, ".skills-manager", "lock"), "", { mode: 0o600 });
  const stat = await lstat(skillsDir, { bigint: true });
  const entry = {
    source: "example/project", sourceType: "github", sourceUrl: "https://github.com/example/project",
    skillPath: "skills/alpha/SKILL.md", skillFolderHash: "a".repeat(40),
    installedAt: "2026-01-01", updatedAt: "2026-01-01", ref: "release/v1",
  };
  const receipt = {
    version: 2, root: skillsDir, name: "alpha", fingerprint: await fingerprintContents(skill),
    historicalBaseline: "unknown", rootIdentity: { device: stat.dev.toString(), inode: stat.ino.toString() }, entry,
  };
  const file = path.join(metadata, "alpha.json");
  await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
  return { file, receipt };
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", dir, "-c", "user.name=Fixture User", "-c", "user.email=fixture@example.invalid", ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

async function initGit(dir: string): Promise<void> {
  await git(dir, "init", "-b", "fixture-main");
  await git(dir, "config", "user.name", "Fixture User");
  await git(dir, "config", "user.email", "fixture@example.invalid");
}

async function commitFixture(dir: string): Promise<void> {
  await git(dir, "add", "--", "alpha/SKILL.md", "alpha/notes.txt");
  await git(dir, "commit", "-m", "fixture skill commit");
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function cliRefreshTitle(frame: string): string | null {
  for (const title of ["Update Vercel skills CLI · switch to main", "Update Vercel skills CLI"]) {
    if (frame.includes(title)) return title;
  }
  return null;
}

afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    if (!renderer.isDestroyed) renderer.destroy();
  }
  // Renderer destruction starts shutdown asynchronously; drain it before the
  // fixture environment and directories can be reused by the next test.
  const shutdowns = await Promise.allSettled(applications.splice(0).map((app) => app.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  const failures = shutdowns.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "TUI shutdown failed");
});

// These real-renderer workflows include npm and Git subprocesses. On macOS x64
// CI, valid Git cases took 6–13 s and the long commit preview took 31 s; the
// default 5 s unit-test budget is too short for an entire workflow.
describe("SkillsManagerTui", { timeout: 30_000 }, () => {
  it("browses the selected directory without network or adoption writes on startup and reload", async () => {
    const { skillsDir } = await fixture();
    const rootBefore = await lstat(skillsDir);
    const fileBefore = await lstat(path.join(skillsDir, "alpha", "SKILL.md"));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
      await app.start();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("◉   alpha");
      expect(frame).toContain("Repository: not recorded");
      expect(frame).toContain("Author: Ada, Grace");
      expect(frame).toContain("Entry: directory");
      expect(frame).toContain(`Directory: "${skillsDir}"`);
      expect(frame).not.toContain("local (mine)");
      expect(frame).toContain("○   beta");
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("Alpha body"));
      expect(fetch).not.toHaveBeenCalled();
      expect(await exists(path.join(skillsDir, ".skills-manager"))).toBe(false);
      const rootAfter = await lstat(skillsDir);
      const fileAfter = await lstat(path.join(skillsDir, "alpha", "SKILL.md"));
      expect([rootAfter.mode, rootAfter.mtimeMs, rootAfter.ctimeMs]).toEqual([rootBefore.mode, rootBefore.mtimeMs, rootBefore.ctimeMs]);
      expect([fileAfter.mode, fileAfter.mtimeMs, fileAfter.ctimeMs]).toEqual([fileBefore.mode, fileBefore.mtimeMs, fileBefore.ctimeMs]);
      expect(await exists(path.join(skillsDir, ".git"))).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it.each([[100, 30], [80, 24]])("keeps Skills and Files panes equally wide at %ix%i", async (width, height) => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width, height });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Files · [ ] navigate"));
      const header = setup.captureCharFrame().split("\n").find((row) => row.includes("┌─Skills") && row.includes("┌─Files"))!;
      const skills = header.indexOf("┌─Skills");
      const files = header.indexOf("┌─Files");
      const detail = header.indexOf("┌", files + 1);
      expect(skills).toBeGreaterThanOrEqual(0);
      expect(detail).toBeGreaterThan(files);
      expect(files - skills).toBe(detail - files);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("shows literal file names without added quotes and escapes control characters", async () => {
    const { skillsDir } = await fixture();
    const skill = path.join(skillsDir, "alpha");
    await mkdir(path.join(skill, 'a"folder'));
    await writeFile(path.join(skill, 'a"folder', "nested.txt"), "nested\n");
    await writeFile(path.join(skill, 'a"file.txt'), "quoted name\n");
    await writeFile(path.join(skill, "a\n\r\x07\x1b"), "control name\n");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("a\\n\\r\\x07\\x1b"));
      let frame = setup.captureCharFrame();
      expect(frame).toContain('a"folder/');
      expect(frame).toContain('a"file.txt');
      expect(frame).not.toContain('"SKILL.md"');
      expect(frame).not.toContain('"notes.txt"');
      expect(frame.split("\n").filter((row) => row.includes("a\\n\\r\\x07\\x1b"))).toHaveLength(1);
      expect(frame).not.toContain("\x1b");
      for (const title of ['a"folder/nested.txt', "a\\n\\r\\x07\\x1b", 'a"file.txt', "notes.txt"]) {
        await setup.mockInput.typeText("]");
        await setup.waitFor(() => setup.captureCharFrame().includes(`┌─${title}`));
      }
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      frame = setup.captureCharFrame();
      expect(frame).toContain("┌─notes.txt");
      expect(frame).not.toContain('┌─"notes.txt"');
    } finally {
      setup.renderer.destroy();
    }
  });

  it("cycles repo and local categories without treating local as authorship", async () => {
    const { skillsDir } = await fixture();
    await savedSourceFixture(skillsDir);
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("◉ ⎇ alpha"));
      let frame = setup.captureCharFrame();
      expect(frame).toContain("○   beta");
      expect(frame).toContain("scope: All");
      expect(frame).toContain("Repository: example/project");
      expect(frame).toContain("Author: Ada, Grace");
      await setup.mockInput.typeText("s");
      await setup.waitFor(() => setup.captureCharFrame().includes("scope: From a repo"));
      frame = setup.captureCharFrame();
      expect(frame).toContain("◉ ⎇ alpha");
      expect(frame).not.toContain("○   beta");
      expect(frame).not.toContain("s cope: From a repo");
      await setup.mockInput.typeText("s");
      await setup.waitFor(() => setup.captureCharFrame().includes("scope: Local"));
      frame = setup.captureCharFrame();
      expect(frame).toContain("○   beta");
      expect(frame).not.toContain("◉ ⎇ alpha");
      expect(frame).toContain("Repository: not recorded");
      expect(frame).toContain("Author not listed");
      expect(frame).not.toContain("local (mine)");
      await setup.mockInput.typeText("s");
      await setup.waitFor(() => setup.captureCharFrame().includes("scope: All"));
      expect(setup.captureCharFrame()).toContain("◉ ⎇ alpha");
      expect(setup.captureCharFrame()).toContain("○   beta");
    } finally {
      setup.renderer.destroy();
    }
  });

  it.each([[100, 30], [80, 24]])("opens a compact updates menu and checks both hosts on each entry at %ix%i", async (width, height) => {
    const { home, skillsDir } = await fixture();
    const appResponse = Promise.withResolvers<Response>();
    const cliResponse = Promise.withResolvers<Response>();
    let appCalls = 0;
    let cliCalls = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).startsWith("https://api.github.com/")) {
        appCalls++;
        return appCalls === 1 ? appResponse.promise : Promise.resolve(new Response("a".repeat(40), { status: 200 }));
      }
      cliCalls++;
      return cliCalls === 1 ? cliResponse.promise : Promise.resolve(new Response(JSON.stringify({ name: "skills", version: "9999.0.0" }), { status: 200 }));
    });
    const setup = await createTestRenderer({ width, height });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      expect(fetch).not.toHaveBeenCalled();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => appCalls === 1 && cliCalls === 1 && setup.captureCharFrame().includes("Checking..."));
      const appRequest = fetch.mock.calls.find(([url]) => String(url).startsWith("https://api.github.com/"));
      const cliRequest = fetch.mock.calls.find(([url]) => String(url).startsWith("https://registry.npmjs.org/"));
      expect(appRequest).toBeDefined();
      expect(cliRequest).toBeDefined();
      expect(new Headers(appRequest![1]?.headers).get("accept")).toBe("application/vnd.github.sha");
      expect(new Headers(cliRequest![1]?.headers).get("accept")).toBe("application/json");
      let frame = setup.captureCharFrame();
      let body = confirmationText(frame, "Application updates");
      expect(body).toMatch(/skills-manager \(app\).*?(installed|version unavailable)/);
      expect(body).toMatch(/Vercel skills CLI.*?(installed|version unavailable)/);
      expect(body.match(/Checking\.\.\./g)).toHaveLength(2);
      expect(body.match(/Automatic checks: off/g)).toHaveLength(2);
      expect(body).toContain("Enter automatic checks");
      expect(body).toContain("c check now");
      expect(body).toContain("r update app + CLI");
      expect(body).toContain("f update CLI");
      expect(body).not.toMatch(/No saved result|Last attempt|Next check|registry latest|recovery|PgUp\/PgDn|m manual/i);
      const rows = frame.split("\n");
      const top = rows.findIndex((row) => row.includes("┌─Application updates"));
      const left = rows[top]!.indexOf("┌─Application updates");
      const bottom = rows.findIndex((row, index) => index > top && row[left] === "└");
      expect(bottom - top + 1).toBeGreaterThanOrEqual(11);
      const footer = rows.findIndex((row, index) => index > top && row.includes("Up/down select"));
      const lastDetail = rows.findIndex((row, index) => index > top && row.includes("Automatic checks: off") && rows.slice(top, index).some((previous) => previous.includes("Vercel skills CLI")));
      expect(lastDetail).toBeGreaterThan(top);
      expect(footer).toBe(lastDetail + 2);
      expect(rows[lastDetail + 1]!.slice(left + 1, rows[top]!.indexOf("┐", left)).trim()).toBe("");
      expect(rows[footer + 1]).toContain("r update app + CLI");
      expect(bottom - top + 1).toBeLessThanOrEqual(14);
      const spans = setup.captureSpans().lines;
      const checkControls = spans.find((line) => line.spans.map((span) => span.text).join("").includes("Enter automatic checks"));
      const updateControls = spans.find((line) => line.spans.map((span) => span.text).join("").includes("r update app + CLI"));
      for (const [line, keys] of [[checkControls, ["Enter", "c"]], [updateControls, ["r", "f", "Esc"]]] as const) {
        for (const key of keys) {
          expect(line?.spans.some((span) => span.text === key && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
        }
      }
      setup.resize(width === 100 ? 80 : 100, width === 100 ? 24 : 30);
      await setup.renderOnce();
      const resized = confirmationText(setup.captureCharFrame(), "Application updates");
      expect(resized).toContain("skills-manager (app)");
      expect(resized).toContain("Vercel skills CLI");
      expect(resized).not.toContain("PgUp/PgDn");
      setup.resize(80, 10);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("PgUp/PgDn scroll");
      setup.resize(width, height);
      await setup.renderOnce();
      await setup.mockInput.typeText("cam");
      await setup.renderOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(confirmationText(setup.captureCharFrame(), "Application updates")).toContain("Automatic checks: off");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Enable automatic skills-manager checks"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Enable automatic skills-manager checks"));
      expect(fetch).toHaveBeenCalledTimes(2);
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("Update app and CLI"));
      body = confirmationText(setup.captureCharFrame(), "Update app and CLI");
      expect(body).toContain("GitHub main");
      expect(body).toContain("npm install scripts run with your user permissions.");
      expect(body).toContain("https://registry.npmjs.org");
      expect(body).toContain("Skills directory:");
      expect(body).toContain("restarts");
      expect(body).toMatch(/y (install|update)/);
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Update app and CLI"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => setup.captureCharFrame().includes("Application updates"));
      expect(fetch).toHaveBeenCalledTimes(2);
      appResponse.resolve(new Response("a".repeat(40), { status: 200 }));
      cliResponse.resolve(new Response(JSON.stringify({ name: "skills", version: "9999.0.0" }), { status: 200 }));
      await setup.waitFor(() => !confirmationText(setup.captureCharFrame(), "Application updates").includes("Checking..."));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => appCalls === 2 && cliCalls === 2);
      frame = setup.captureCharFrame();
      expect(confirmationText(frame, "Application updates").match(/Automatic checks: off/g)).toHaveLength(2);
      expect(await exists(path.join(home, "config"))).toBe(false);
    } finally {
      appResponse.resolve(new Response(null, { status: 503 }));
      cliResponse.resolve(new Response(null, { status: 503 }));
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("keeps update consent and CLI trust disclosures visible for a wrapped wide-cell path at 80x24", async () => {
    const { skillsDir } = await fixture("directory with many ordinary words forcing a wrap before wide 技 and another wide 界 ending");
    const registry = "https://registry.example.invalid/team/";
    vi.stubEnv("npm_config_registry", registry);
    vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => fetch.mock.calls.length === 2 && setup.captureCharFrame().includes("Application updates")
        && !setup.captureCharFrame().includes("Checking..."));
      setup.mockInput.pressEnter();
      const appTitle = "Enable automatic skills-manager checks";
      await setup.waitFor(() => setup.captureCharFrame().includes(appTitle));
      const appConsent = confirmationText(setup.captureCharFrame(), appTitle);
      expect(appConsent).toContain("https://api.github.com");
      expect(appConsent).toMatch(/IP\s*address/);
      expect(appConsent).toContain("Esc cancel");
      expect(appConsent).toContain("y enable");
      expect(appConsent).not.toContain("PgUp/PgDn scroll");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes(appTitle));

      await setup.mockInput.typeText("2");
      setup.mockInput.pressEnter();
      const cliTitle = "Enable automatic Vercel skills CLI checks";
      await setup.waitFor(() => setup.captureCharFrame().includes(cliTitle));
      const cliConsent = confirmationText(setup.captureCharFrame(), cliTitle);
      expect(cliConsent).toContain("https://registry.example.invalid");
      expect(cliConsent).toMatch(/IP\s*address/);
      expect(cliConsent).toContain("Esc cancel");
      expect(cliConsent).toContain("y enable");
      expect(cliConsent).not.toContain("PgUp/PgDn scroll");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes(cliTitle));

      await setup.mockInput.typeText("f");
      await setup.waitFor(() => cliRefreshTitle(setup.captureCharFrame()) !== null);
      const frame = setup.captureCharFrame();
      const review = confirmationText(frame, cliRefreshTitle(frame)!);
      expect(review).toContain("Skills directory:");
      expect(review).toContain("技");
      expect(review).toContain("界");
      expect(review).toContain("ending");
      expect(review).toContain("GitHub");
      expect(review).toContain("https://registry.example.invalid");
      expect(review).toContain("npm install scripts run with your user permissions.");
      expect(review).toContain("restarts");
      expect(review).toContain("Esc cancel");
      expect(review).toMatch(/y (install|update)/);
      expect(review).not.toContain("PgUp/PgDn scroll");
      const rows = frame.split("\n");
      const pathRow = rows.findIndex((row) => row.includes("Skills directory:"));
      expect(pathRow).toBeGreaterThanOrEqual(0);
      expect(rows.findIndex((row, index) => index > pathRow && row.includes("技"))).toBeGreaterThan(pathRow);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("renders and scrolls Markdown tables and toggles the complete raw source", async () => {
    const { skillsDir } = await fixture();
    await writeFile(path.join(skillsDir, "alpha", "SKILL.md"), [
      "---", "name: alpha", "description: Table fixture", "---", "",
      "# Table preview", "",
      "| Item | State | Notes |", "| --- | --- | --- |",
      "| alpha | ready | a deliberately long cell with several words that must wrap inside the table |",
      "", "Control \x1b]0;DANGER\x07.", "",
      ...Array.from({ length: 35 }, (_, index) => `Paragraph ${index + 1}.\n`),
      "", "Final preview marker.",
    ].join("\n"));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Item") && setup.captureCharFrame().includes("ready") && setup.captureCharFrame().includes("Control \\x1b]0;DANGER\\x07."));
      let frame = setup.captureCharFrame();
      expect(frame).toMatch(/│\s*Item\s*│\s*State\s*│\s*Notes\s*│/);
      expect(frame).toMatch(/┌─+┬─+┬─+┐/);
      expect(frame).toMatch(/└─+┴─+┴─+┘/);
      expect(frame).not.toContain("| --- | --- | --- |");
      expect(frame).toContain("Control \\x1b]0;DANGER\\x07.");
      expect(frame).not.toContain("\x1b]0;DANGER\x07");

      setup.resize(100, 30);
      await setup.waitFor(() => setup.captureCharFrame().includes("ready"));
      frame = setup.captureCharFrame();
      expect(frame).toMatch(/│\s*Item\s*│\s*State\s*│\s*Notes\s*│/);
      expect(frame).toMatch(/┌─+┬─+┬─+┐/);
      expect(frame).toMatch(/└─+┴─+┴─+┘/);
      expect(frame).toContain("deliberately");
      expect(frame.split("\n").filter((row) => row.includes("│") && /long cell|several words|must wrap|inside the table/.test(row)).length).toBeGreaterThan(0);
      for (let page = 0; page < 8; page++) setup.mockInput.pressKey("\u001b[6~");
      await setup.waitFor(() => setup.captureCharFrame().includes("Final preview marker."));

      setup.resize(180, 30);
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("| --- | --- | --- |"));
      frame = setup.captureCharFrame();
      expect(frame).toContain("name: alpha");
      expect(frame).toContain("| Item | State | Notes |");
      expect(frame).toContain("Control \\x1b]0;DANGER\\x07.");
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("ready") && setup.captureCharFrame().includes("Markdown · toggle rendering"));
      frame = setup.captureCharFrame();
      expect(frame).toMatch(/│\s*Item\s*│\s*State\s*│\s*Notes\s*│/);
      expect(frame).not.toContain("| --- | --- | --- |");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("escapes terminal controls in captured frames", async () => {
    const { home, skillsDir } = await fixture();
    const newlineRoot = path.join(home, "choice\nname");
    await rename(skillsDir, newlineRoot);
    await writeFile(path.join(newlineRoot, "alpha", "SKILL.md"),
      '---\nname: alpha\nauthor: "Ada\\u001B]0;META\\u0007"\n---\n\nBody \x1b]0;BODY\x07.\n');
    const setup = await createTestRenderer({ width: 200, height: 40 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(newlineRoot)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("BODY\\x07"));
      let frame = setup.captureCharFrame();
      expect(frame).toContain("Author: Ada\\x1b]0;META\\x07");
      expect(frame).toContain("Body \\x1b]0;BODY\\x07.");
      expect(frame).toContain(`Directory: "${path.join(home, "choice\\nname")}"`);
      expect(frame).not.toContain("\x1b]0;META\x07");
      expect(frame).not.toContain("\x1b]0;BODY\x07");
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("Raw"));
      frame = setup.captureCharFrame();
      expect(frame).toContain("Body \\x1b]0;BODY\\x07.");
      expect(await readFile(path.join(newlineRoot, "alpha", "SKILL.md"), "utf8")).toContain("\x1b]0;BODY\x07");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("shows unavailable Git without reporting a clean repository and keeps browsing usable", async () => {
    const { skillsDir } = await fixture();
    const approved = await approveSkillsRoot(skillsDir);
    vi.stubEnv("PATH", path.join(skillsDir, "missing-executables"));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, approved).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Alpha body"));
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Git unavailable");
      expect(frame).not.toContain("0 changed skill paths");
      expect(frame).not.toContain("No Git repository at selected directory.");
      expect(frame).toContain("Alpha body");
      expect(frame).not.toContain("Initialize Git");
      expect(frame).not.toContain("Backup unavailable");
      await setup.mockInput.typeText("]");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Git unavailable"));
      const gitFrame = setup.captureCharFrame();
      expect(gitFrame).toContain("Working tree");
      expect(gitFrame).not.toContain("0 changed skill paths");
      expect(gitFrame).not.toContain("No Git repository at selected directory.");
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help") && setup.captureCharFrame().includes("Git unavailable"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      expect(setup.captureCharFrame()).not.toContain("Git unavailable");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders contiguous highlighted controls in captured frames and supports alternate file navigation", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("x app updates · open");
      expect(frame).not.toContain("o pen");
      expect(frame).toContain("scope: All · enabled: all");
      expect(frame).not.toContain("s cope: All");
      expect(frame).toContain("scope · enabled");
      expect(frame).not.toContain("s cope");
      expect(frame).not.toContain("e nabled");
      expect(frame).toContain("space enable/disable");
      expect(frame).toContain("Markdown · toggle rendering");
      expect(frame).not.toContain("t oggle rendering");
      expect(frame).toContain("Files · [ ] navigate");
      const spans = setup.captureSpans().lines;
      const applicationUpdates = spans.find((line) => line.spans.map((span) => span.text).join("").includes("x app updates"));
      expect(applicationUpdates?.spans.some((span) => span.text === "x" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      const header = spans.find((line) => line.spans.map((span) => span.text).join("").includes("scope · enabled"));
      expect(header?.spans.some((span) => span.text === "s" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      expect(header?.spans.some((span) => span.text === "e" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      const headerCells = header!.spans.flatMap((span) => Array.from(span.text, (character) => ({ character, fg: span.fg })));
      const headerString = headerCells.map((cell) => cell.character).join("");
      const shortcutStart = headerString.indexOf("scope · enabled", headerString.indexOf("enabled: all") + "enabled: all".length);
      expect(shortcutStart).toBeGreaterThan(0);
      const accent = RGBA.fromHex("#C6A0F6");
      const scopeKey = headerString.indexOf("scope: All");
      const stateKey = headerString.indexOf("enabled: all");
      expect(scopeKey).toBeGreaterThanOrEqual(0);
      expect(stateKey).toBeGreaterThanOrEqual(0);
      expect(headerCells.slice(0, shortcutStart)
        .every((cell, index) => cell.fg.equals(accent) === (index === scopeKey || index === stateKey))).toBe(true);
      expect(headerCells.slice(shortcutStart, shortcutStart + "scope · enabled".length)
        .every((cell, index) => cell.fg.equals(accent) === (index === 0 || index === "scope · ".length))).toBe(true);
      const toggle = spans.find((line) => line.spans.map((span) => span.text).join("").includes("Markdown · toggle rendering"));
      expect(toggle?.spans.some((span) => span.text === "t" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      setup.resize(100, 30);
      await setup.renderOnce();
      const compactHeader = setup.captureCharFrame().split("\n")[0]!;
      expect(compactHeader).toMatch(/enabled: all\s+(?:.*\s)?scope · enabled/);
      const compactHeaderSpans = setup.captureSpans().lines.find((line) =>
        line.spans.map((span) => span.text).join("").includes("scope · enabled"));
      expect(compactHeaderSpans?.spans.some((span) => span.text === "s" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      expect(compactHeaderSpans?.spans.some((span) => span.text === "e" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      setup.resize(180, 30);
      await setup.renderOnce();
      await setup.mockInput.typeText("]");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("Raw · toggle rendering"));
      await setup.mockInput.typeText("[");
      await setup.waitFor(() => setup.captureCharFrame().includes("Alpha body"));
      await setup.mockInput.typeText("/alpha");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("scope: All · enabled: all · filter: alpha"));
      expect(setup.captureCharFrame()).not.toContain("f ilter: alpha");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("rechecks the selected component directly and defers results during help and review", async () => {
    const { skillsDir } = await fixture();
    const response = Promise.withResolvers<Response>();
    const another = Promise.withResolvers<Response>();
    let cliCalls = 0;
    const checks = vi.spyOn(SoftwareUpdateService.prototype, "check");
    const waitForCliCheck = async () => {
      const index = checks.mock.calls.findLastIndex(([component]) => component === "cli");
      expect(index).toBeGreaterThanOrEqual(0);
      await checks.mock.results[index]!.value;
      // Let the TUI's continuation clear its in-flight token before reopening.
      await nextTurn();
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).startsWith("https://api.github.com/")) {
        return Promise.resolve(new Response("a".repeat(40), { status: 200 }));
      }
      cliCalls++;
      if (cliCalls === 1) return response.promise;
      if (cliCalls === 3) return another.promise;
      return Promise.resolve(new Response(JSON.stringify({ name: "skills", version: cliCalls === 2 ? "9999.0.0" : "9999.0.1" }), { status: 200 }));
    });
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => cliCalls === 1 && fetch.mock.calls.length === 2);
      await setup.mockInput.typeText("2c");
      await setup.renderOnce();
      expect(cliCalls).toBe(1);
      expect(fetch.mock.calls.some(([url]) => String(url) === "https://registry.npmjs.org/skills/latest")).toBe(true);
      expect(setup.captureCharFrame()).not.toContain("Check Vercel skills CLI now");
      expect(setup.captureCharFrame().match(/Automatic checks: off/g)).toHaveLength(2);
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      response.resolve(new Response(JSON.stringify({ name: "skills", version: "9999.0.0" }), { status: 200 }));
      await waitForCliCheck();
      expect(setup.captureCharFrame()).toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => setup.captureCharFrame().includes("Different Vercel skills CLI · x review"));
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => cliCalls === 2 && setup.captureCharFrame().includes("Latest: 9999.0.0"));
      await waitForCliCheck();
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => cliCalls === 3 && setup.captureCharFrame().includes("Checking..."));
      expect(setup.captureCharFrame()).not.toContain("Check Vercel skills CLI now");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remove skill"));
      another.resolve(new Response(JSON.stringify({ name: "skills", version: "9999.0.1" }), { status: 200 }));
      await waitForCliCheck();
      expect(setup.captureCharFrame()).toContain("Remove skill");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Remove skill"));
      expect(await exists(path.join(skillsDir, "alpha", "SKILL.md"))).toBe(true);
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => cliCalls === 4 && setup.captureCharFrame().includes("Latest: 9999.0.1"));
      expect(setup.captureCharFrame().match(/Automatic checks: off/g)).toHaveLength(2);
    } finally {
      response.resolve(new Response(null, { status: 503 }));
      another.resolve(new Response(null, { status: 503 }));
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("shows a failed CLI check after returning from help without automatic checks", async () => {
    const { skillsDir } = await fixture();
    const response = Promise.withResolvers<Response>();
    const checks = vi.spyOn(SoftwareUpdateService.prototype, "check");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).startsWith("https://api.github.com/")
        ? Promise.resolve(new Response("a".repeat(40), { status: 200 }))
        : response.promise);
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      expect(fetch).not.toHaveBeenCalled();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => fetch.mock.calls.length === 2);
      expect(setup.captureCharFrame().match(/Automatic checks: off/g)).toHaveLength(2);
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      response.resolve(new Response(null, { status: 503 }));
      const cliCheck = checks.mock.calls.findIndex(([component]) => component === "cli");
      expect(cliCheck).toBeGreaterThanOrEqual(0);
      await checks.mock.results[cliCheck]!.value;
      await nextTurn();
      expect(setup.captureCharFrame()).toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => setup.captureCharFrame().includes("Vercel skills CLI update check failed · x review"));
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      response.resolve(new Response(null, { status: 503 }));
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("shows check failures inline and rechecks only the selected current host", async () => {
    const { home, skillsDir } = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).startsWith("https://api.github.com/")
        ? Promise.resolve(new Response(null, { status: 503 }))
        : Promise.reject(new Error("private network failure")));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      expect(fetch).not.toHaveBeenCalled();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => fetch.mock.calls.length === 2 && setup.captureCharFrame().includes("┌─Application updates")
        && (confirmationText(setup.captureCharFrame(), "Application updates").match(/Check failed/g)?.length ?? 0) === 2);
      let body = confirmationText(setup.captureCharFrame(), "Application updates");
      expect(body).toContain("HTTP 503");
      expect(body).not.toContain("private network failure");
      expect(body.match(/Automatic checks: off/g)).toHaveLength(2);
      const registry = "https://registry.example.invalid/team/";
      vi.stubEnv("npm_config_registry", registry);
      vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
      await setup.mockInput.typeText("2c");
      await setup.waitFor(() => fetch.mock.calls.some(([url]) => String(url) === `${registry}skills/latest`));
      expect(fetch).toHaveBeenCalledTimes(3);
      await setup.waitFor(() => !setup.captureCharFrame().includes("Checking..."));
      body = confirmationText(setup.captureCharFrame(), "Application updates");
      expect(body).toContain("Check failed");
      expect(body.match(/Automatic checks: off/g)).toHaveLength(2);
      expect(body).not.toMatch(/Check Vercel skills CLI now|private network failure/);
      await setup.mockInput.typeText("1c");
      await setup.waitFor(() => fetch.mock.calls.length === 4);
      expect(String(fetch.mock.calls[3]![0])).toMatch(/^https:\/\/api\.github\.com\//);
      expect(await exists(path.join(home, "config"))).toBe(false);
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("keeps an explicit in-flight check when automatic CLI checks are switched off", async () => {
    const { skillsDir } = await fixture();
    const held = Promise.withResolvers<Response>();
    let cliCalls = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).startsWith("https://api.github.com/")) {
        return Promise.resolve(new Response("a".repeat(40), { status: 200 }));
      }
      cliCalls++;
      if (cliCalls === 3) return held.promise;
      return Promise.resolve(new Response(JSON.stringify({ name: "skills", version: "9999.0.0" }), { status: 200 }));
    });
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => cliCalls === 1 && !setup.captureCharFrame().includes("Checking..."));
      await setup.mockInput.typeText("2");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Enable automatic Vercel skills CLI checks"));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => cliCalls === 2 && !setup.captureCharFrame().includes("Checking..."));
      expect(setup.captureCharFrame().split("Vercel skills CLI")[1]).toContain("Automatic checks: on");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => cliCalls === 3 && setup.captureCharFrame().includes("Checking..."));
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().match(/Automatic checks: off/g)?.length === 2);
      expect(setup.captureCharFrame()).toContain("Checking...");
      const callsBeforeResult = fetch.mock.calls.length;
      held.resolve(new Response(JSON.stringify({ name: "skills", version: "9999.0.1" }), { status: 200 }));
      await setup.waitFor(() => setup.captureCharFrame().includes("Latest: 9999.0.1"));
      expect(fetch).toHaveBeenCalledTimes(callsBeforeResult);
      expect(setup.captureCharFrame().match(/Automatic checks: off/g)).toHaveLength(2);
    } finally {
      held.resolve(new Response(null, { status: 503 }));
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("requires explicit app-host consent and remembers the setting across sessions", async () => {
    const { home, skillsDir } = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => Promise.resolve(new Response(
      String(input).startsWith("https://api.github.com/")
        ? "a".repeat(40)
        : JSON.stringify({ name: "skills", version: "9999.0.0" }), { status: 200 },
    )));
    const first = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(first.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      expect(fetch).not.toHaveBeenCalled();
      await first.mockInput.typeText("x");
      await first.waitFor(() => fetch.mock.calls.length === 2 && !first.captureCharFrame().includes("Checking..."));
      expect(first.captureCharFrame().match(/Automatic checks: off/g)).toHaveLength(2);
      await first.mockInput.typeText("a");
      await first.renderOnce();
      expect(first.captureCharFrame()).not.toContain("Enable automatic");
      first.mockInput.pressEnter();
      await first.waitFor(() => first.captureCharFrame().includes("Enable automatic skills-manager checks"));
      const title = "Enable automatic skills-manager checks";
      const consent = confirmationText(first.captureCharFrame(), title);
      expect(consent).toContain("https://api.github.com");
      expect(consent).not.toContain("registry.npmjs.org");
      expect(consent).toMatch(/IP\s*address/);
      expect(consent).toContain("Esc cancel");
      expect(consent).toContain("y enable");
      expect(consent).not.toMatch(/Enter|n\s+cancel|n\/Esc/i);
      const consentFrame = first.captureCharFrame().split("\n");
      const consentTop = consentFrame.findIndex((row) => row.includes(`┌─${title}`));
      const consentLeft = consentFrame[consentTop]!.indexOf(`┌─${title}`);
      const consentBottom = consentFrame.findIndex((row, index) => index > consentTop && row[consentLeft] === "└");
      expect(consentBottom - consentTop + 1).toBeLessThanOrEqual(8);
      const controls = first.captureSpans().lines.find((line) =>
        line.spans.map((span) => span.text).join("").includes("y enable"));
      for (const key of ["Esc", "y"]) {
        expect(controls?.spans.some((span) => span.text === key && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      }
      first.mockInput.pressEnter();
      first.mockInput.pressArrow("right");
      first.mockInput.pressEnter();
      await first.mockInput.typeText("n");
      await first.renderOnce();
      expect(first.captureCharFrame()).toContain(title);
      expect(await exists(path.join(home, "config"))).toBe(false);
      first.mockInput.pressEscape();
      await first.waitFor(() => !first.captureCharFrame().includes(title));
      expect(first.captureCharFrame().match(/Automatic checks: off/g)).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(2);

      first.mockInput.pressEnter();
      await first.waitFor(() => first.captureCharFrame().includes(title));
      await first.mockInput.typeText("y");
      await first.waitFor(() => first.captureCharFrame().split("Vercel skills CLI")[0]!.includes("Automatic checks: on"));
      expect(first.captureCharFrame().split("Vercel skills CLI")[1]).toContain("Automatic checks: off");
    } finally {
      first.renderer.destroy();
      await app.shutdown();
    }
    const second = await createTestRenderer({ width: 180, height: 30 });
    const restarted = createTrackedTui(second.renderer, await approveSkillsRoot(skillsDir));
    try {
      await restarted.start();
      await second.mockInput.typeText("x");
      await second.waitFor(() => second.captureCharFrame().split("Vercel skills CLI")[0]!.includes("Automatic checks: on"));
      expect(second.captureCharFrame().split("Vercel skills CLI")[1]).toContain("Automatic checks: off");
      second.mockInput.pressEnter();
      await second.waitFor(() => second.captureCharFrame().match(/Automatic checks: off/g)?.length === 2);
      expect(second.captureCharFrame()).not.toContain("Enable automatic");
    } finally {
      second.renderer.destroy();
      await restarted.shutdown();
    }
  });

  it("discloses the selected CLI registry and enables only that component with explicit consent", async () => {
    const { skillsDir } = await fixture();
    const registry = "https://registry.example.invalid/team/";
    vi.stubEnv("npm_config_registry", registry);
    vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      expect(fetch).not.toHaveBeenCalled();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => fetch.mock.calls.length === 2 && !setup.captureCharFrame().includes("Checking..."));
      expect(fetch.mock.calls.some(([url]) => String(url) === `${registry}skills/latest`)).toBe(true);
      await setup.mockInput.typeText("2");
      setup.mockInput.pressEnter();
      const title = "Enable automatic Vercel skills CLI checks";
      await setup.waitFor(() => setup.captureCharFrame().includes(title));
      const consent = confirmationText(setup.captureCharFrame(), title);
      expect(consent).toContain("https://registry.example.invalid");
      expect(consent).not.toContain("api.github.com");
      expect(consent).toMatch(/IP\s*address/);
      expect(consent).toContain("Esc cancel");
      expect(consent).toContain("y enable");
      expect(consent).not.toMatch(/Enter|n\s+cancel|n\/Esc/i);
      setup.mockInput.pressEnter();
      await setup.mockInput.typeText("n");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain(title);
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().split("Vercel skills CLI")[1]?.includes("Automatic checks: on") === true);
      expect(setup.captureCharFrame().split("Vercel skills CLI")[0]).toContain("Automatic checks: off");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().match(/Automatic checks: off/g)?.length === 2);
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("enables automatic checks by clicking the consent action", async () => {
    const { skillsDir } = await fixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => setup.captureCharFrame().includes("Application updates"));
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Enable automatic skills-manager checks"));
      const rows = setup.captureCharFrame().split("\n");
      const row = rows.findIndex((line) => line.includes("y enable"));
      expect(row).toBeGreaterThanOrEqual(0);
      await setup.mockMouse.click(rows[row]!.indexOf("y enable"), row);
      await setup.waitFor(() => setup.captureCharFrame().split("Vercel skills CLI")[0]!.includes("Automatic checks: on"));
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it.each([
    { label: "clean", source: "archive" as const, dirty: false, commit: "a".repeat(40), switches: false },
    { label: "dirty", source: "git" as const, dirty: true, commit: "b".repeat(40), switches: true },
    { label: "unknown", source: "unknown" as const, dirty: false, commit: null, switches: true },
  ])("reviews the CLI update against a $label app build", async ({ source, dirty, commit, switches }) => {
    const { skillsDir } = await fixture();
    vi.spyOn(appBuild, "readBuildIdentity").mockResolvedValue({ version: "1.2.3", source, dirty, commit });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => fetch.mock.calls.length === 2 && !setup.captureCharFrame().includes("Checking..."));
      await setup.mockInput.typeText("f");
      await setup.waitFor(() => cliRefreshTitle(setup.captureCharFrame()) !== null);
      const title = cliRefreshTitle(setup.captureCharFrame())!;
      const review = confirmationText(setup.captureCharFrame(), title);
      expect(title.includes("switch to main")).toBe(switches);
      expect(review).toContain(switches ? "Switches the app to GitHub main" : `Keeps the current app version (${commit!.slice(0, 7)})`);
      expect(review).toContain(`Skills directory: "${skillsDir}"`);
      expect(review).toContain("https://registry.npmjs.org");
      expect(review).toContain("npm install scripts run with your user permissions.");
      expect(review).toContain("restarts");
      expect(review).toContain("Esc cancel");
      expect(review).toMatch(/y (install|update)/);
      setup.mockInput.pressEscape();
      await setup.waitFor(() => cliRefreshTitle(setup.captureCharFrame()) === null);
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("Update app and CLI"));
      const both = confirmationText(setup.captureCharFrame(), "Update app and CLI");
      expect(both).toContain("GitHub main");
      expect(both).toContain("Vercel skills CLI");
      expect(both).toContain(`Skills directory: "${skillsDir}"`);
      expect(both).toContain("https://registry.npmjs.org");
      expect(both).toContain("npm install scripts run with your user permissions.");
      expect(both).toContain("restarts");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Update app and CLI"));
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });
  it.each(["install", "update"] as const)("reviews and passes the resolved global %s destination", async (mode) => {
    const { home, skillsDir } = await fixture();
    const installation = { prefix: path.join(home, "global prefix"), mode };
    vi.spyOn(appUpdateHandoff, "resolveGlobalUpdate").mockResolvedValue(installation);
    const prepare = vi.spyOn(appUpdateHandoff, "prepareUpdateHandoff").mockResolvedValue({
      workspace: home, helperPath: path.join(home, "helper"), args: [], env: {}, cleanup: async () => {},
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("Update app and CLI"));
      const review = confirmationText(setup.captureCharFrame(), "Update app and CLI");
      expect(review).toContain(mode === "install" ? "Install globally" : "Update global installation");
      expect(review).toContain(`"${installation.prefix}"`);
      expect(review).toContain(mode === "install" ? "y install" : "y update");
      expect(prepare).not.toHaveBeenCalled();
      await setup.mockInput.typeText("y");
      const handoff = await app.waitForExit();
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]![0].installation).toEqual(installation);
      expect(handoff?.recoveryCommand).toContain(`'${installation.prefix}/bin/skills-manager'`);
      expect(handoff?.recoveryCommand).toContain(`--prefix '${installation.prefix}'`);
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it("does not offer an update when the global destination cannot be resolved", async () => {
    const { skillsDir } = await fixture();
    vi.spyOn(appUpdateHandoff, "resolveGlobalUpdate").mockRejectedValue(new Error("Global prefix unavailable."));
    const prepare = vi.spyOn(appUpdateHandoff, "prepareUpdateHandoff");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("Global prefix unavailable."));
      expect(prepare).not.toHaveBeenCalled();
      expect(setup.captureCharFrame()).not.toContain("Update app and CLI");
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });


  it("omits manual recovery and preserves the current directory on cancel or quit", async () => {
    const { home, skillsDir } = await fixture("new 'skills'\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    try {
      await app.start();
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("m");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Application updates");
      expect(setup.captureCharFrame()).not.toMatch(/manual app recovery|m manual/i);
      await setup.mockInput.typeText("f");
      await setup.waitFor(() => cliRefreshTitle(setup.captureCharFrame()) !== null);
      const title = cliRefreshTitle(setup.captureCharFrame())!;
      const review = confirmationText(setup.captureCharFrame(), title);
      expect(review).toContain("Skills directory:");
      expect(review).toContain(path.basename(home));
      expect(review).toContain("new");
      expect(review).toContain("'skills'\\n\"");
      let exited = false;
      void app.waitForExit().then(() => { exited = true; });
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes(title));
      expect(exited).toBe(false);
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Application updates"));
      expect(exited).toBe(false);
      await setup.mockInput.typeText("q");
      expect(await app.waitForExit()).toBeNull();
    } finally {
      setup.renderer.destroy();
      await app.shutdown();
    }
  });

  it.each(["renderer destruction", "quit"] as const)("drains an update prepared after %s instead of handing it off", async (stop) => {
    const { home, skillsDir } = await fixture();
    await lstat(path.resolve("dist/actions/appUpdateWorker.js"));
    const temporary = path.join(home, "tmp");
    const bin = path.join(home, "bin");
    const started = path.join(home, "npm-started");
    const release = path.join(home, "npm-release");
    await mkdir(temporary);
    await mkdir(bin);
    const npm = path.join(bin, "npm");
    await writeFile(npm, [
      "#!/bin/sh",
      'if [ "$1" = config ] && [ "$2" = list ] && [ "$3" = --long ]; then',
      '  : > "$SM_UPDATE_STARTED"',
      '  while [ ! -e "$SM_UPDATE_RELEASE" ]; do /bin/sleep 0.02; done',
      '  printf \'; "env" config from environment\\n; cache = "%s" ; overridden by cli\\n\' "$SM_UPDATE_CACHE"',
      'elif [ "$1" = config ] && [ "$2" = get ] && [ "$3" = prefix ]; then',
      '  printf "%s\\n" "$npm_config_prefix"',
      "else",
      '  printf "%s\\n" "https://registry.npmjs.org/"',
      "fi",
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(npm, 0o700);
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    const events: string[] = [];
    const watcher = watch(temporary, (_event, filename) => { if (filename) events.push(filename.toString()); });
    try {
      await app.start();
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("TMPDIR", temporary);
      vi.stubEnv("SM_UPDATE_STARTED", started);
      vi.stubEnv("SM_UPDATE_RELEASE", release);
      vi.stubEnv("SM_UPDATE_CACHE", path.join(home, "npm-cache"));
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => setup.captureCharFrame().includes("Application updates"));
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("Update app and CLI"));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => exists(started));
      expect(setup.captureCharFrame()).toContain("Preparing update; q quits without starting it.");
      if (stop === "quit") await setup.mockInput.typeText("q");
      else setup.renderer.destroy();
      expect(await app.waitForExit()).toBeNull();
      let drained = false;
      const shutdown = app.shutdown().then(() => { drained = true; });
      await delay(30);
      expect(drained).toBe(false);
      await writeFile(release, "");
      await shutdown;
      await delay(30);
      expect(events.some((entry) => entry.startsWith("skills-manager-update-"))).toBe(true);
      expect(await readdir(temporary)).toEqual([]);
    } finally {
      await writeFile(release, "");
      setup.renderer.destroy();
      await app.shutdown();
      watcher.close();
    }
  });

  it("prepares a CLI refresh for the current directory and registry without waiting for checks", async () => {
    const { home, skillsDir } = await fixture("second installation");
    await lstat(path.resolve("dist/actions/appUpdateWorker.js"));
    const temporary = path.join(home, "tmp");
    const registry = "https://registry.example.invalid/team/";
    await mkdir(temporary);
    const pending = Promise.withResolvers<Response>();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    const setup = await createTestRenderer({ width: 180, height: 30 });
    const app = createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir));
    let prepared: ApplicationUpdateHandoff | null = null;
    try {
      await app.start();
      vi.stubEnv("TMPDIR", temporary);
      vi.stubEnv("npm_config_registry", registry);
      vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
      await setup.mockInput.typeText("x");
      await setup.waitFor(() => fetch.mock.calls.length === 2 && setup.captureCharFrame().includes("Checking..."));
      expect(fetch.mock.calls.some(([url]) => String(url) === `${registry}skills/latest`)).toBe(true);
      await setup.mockInput.typeText("f");
      await setup.waitFor(() => cliRefreshTitle(setup.captureCharFrame()) !== null);
      const review = setup.captureCharFrame();
      const switchesToMain = review.includes("Update Vercel skills CLI · switch to main");
      expect(review).toContain(switchesToMain ? "Switches the app to GitHub main" : "Keeps the current app version");
      expect(review).toContain("https://registry.example.invalid");
      expect(review).toContain("GitHub");
      const reviewBody = confirmationText(review, cliRefreshTitle(review)!);
      expect(reviewBody).toContain("Skills directory:");
      expect(reviewBody).toContain(path.basename(home));
      expect(reviewBody).toContain("second");
      expect(reviewBody).toContain("installation\"");
      expect(review).toContain("npm install scripts run with your user permissions.");
      expect(review).toContain("restarts");
      expect(review).toContain("Esc cancel");
      expect(review).toMatch(/y (install|update)/);
      expect(review).not.toMatch(/n\s+cancel|n\/Esc/i);
      await setup.mockInput.typeText("n");
      await setup.renderOnce();
      expect(cliRefreshTitle(setup.captureCharFrame())).not.toBeNull();
      await setup.mockInput.typeText("y");
      let resolved = false;
      void app.waitForExit().then(() => { resolved = true; });
      await setup.waitFor(() => resolved, 10_000);
      prepared = await app.waitForExit();
      expect(prepared).not.toBeNull();
      if (!prepared) throw new Error("An explicitly approved refresh did not prepare a handoff.");
      expect(prepared.prepared.args).toContain("cli");
      expect(prepared.prepared.args.some((arg) => switchesToMain ? arg === "main" : /^[0-9a-f]{40}$/i.test(arg))).toBe(true);
      expect(prepared.prepared.args).toContain(skillsDir);
      expect(prepared.prepared.env.SKILLS_MANAGER_UPDATE_REGISTRY).toBe(registry);
      expect(prepared.recoveryCommand).toContain(skillsDir);
      expect(fetch).toHaveBeenCalledTimes(2);
      pending.resolve(new Response(null, { status: 503 }));
      await app.shutdown();
      setup.renderer.destroy();
      await prepared.prepared.cleanup();
      prepared = null;
    } finally {
      pending.resolve(new Response(null, { status: 503 }));
      setup.renderer.destroy();
      await app.shutdown();
      if (prepared) await prepared.prepared.cleanup();
    }
  });

  it("opens help from browsing and returns to the same filter and selected file with either close key", async () => {
    const { skillsDir } = await fixture();
    const notes = ["Notes from the selected file.", ...Array.from({ length: 70 }, (_, index) => `Notes line ${index + 1}`)];
    await writeFile(path.join(skillsDir, "alpha", "notes.txt"), `${notes.join("\n")}\n`);
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("quit · ? help");
      const controls = setup.captureSpans().lines.find((line) =>
        line.spans.map((span) => span.text).join("").includes("? help"));
      expect(controls?.spans.some((span) => span.text === "?" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      setup.resize(80, 30);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("? help");
      setup.resize(180, 30);
      await setup.renderOnce();

      await setup.mockInput.typeText("/alpha");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("filter: alpha"));
      await setup.mockInput.typeText("]");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      setup.mockInput.pressKey("\u001b[6~");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes line 30"));

      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      let frame = setup.captureCharFrame();
      const help = confirmationText(frame, "Keyboard help · Skills");
      expect(help).toContain("Browse files");
      expect(help).toContain("Filter list");
      expect(help).toContain("Manage skills");
      expect(help).toContain("Application");
      expect(help).toContain("g                 Open Git");
      expect(help).toContain("x                 Application updates");
      expect(help).toContain("Enabled / disabled / missing");
      expect(help).not.toContain("Initialize repository");
      expect(help).not.toContain("Commit changes");
      expect(frame).toContain("?/Esc close");
      expect(help).not.toContain("Up/down scroll");
      expect(help).not.toContain("PgUp/PgDn page");
      const wideRows = frame.split("\n");
      const groups = wideRows.find((row) => row.includes("Browse files") && row.includes("Manage skills"));
      expect(groups).toBeDefined();
      expect(groups!.indexOf("Manage skills")).toBeGreaterThan(groups!.indexOf("Browse files"));
      const shortcut = setup.captureSpans().lines.find((line) =>
        line.spans.map((span) => span.text).join("").includes("Open Git"));
      expect(shortcut?.spans.some((span) => span.text === "g" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      const helpSpans = setup.captureSpans().lines.flatMap((line) => line.spans);
      for (const text of ["Browse files", "Manage skills", "List symbols", "◉ / ○ / !"]) {
        expect(helpSpans.some((span) => span.text.includes(text) && !span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      }
      setup.resize(100, 30);
      await setup.renderOnce();
      const wrappedLegend = confirmationText(setup.captureCharFrame(), "Keyboard help · Skills");
      expect(wrappedLegend).toContain("⎇                 From a repository");
      expect(wrappedLegend).toContain("(none)            Local");
      setup.resize(96, 30);
      await setup.renderOnce();
      expect(setup.captureCharFrame().split("\n").some((row) => row.includes("Browse files") && row.includes("Manage skills"))).toBe(true);
      setup.resize(95, 30);
      await setup.renderOnce();
      expect(setup.captureCharFrame().split("\n").some((row) => row.includes("Browse files") && row.includes("Manage skills"))).toBe(false);
      setup.resize(80, 30);
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Skills")).toContain("PgUp/PgDn page");
      const narrowRows = setup.captureCharFrame().split("\n");
      const browseRow = narrowRows.findIndex((row) => row.includes("Browse files"));
      const filterRow = narrowRows.findIndex((row) => row.includes("Filter list"));
      const manageRow = narrowRows.findIndex((row) => row.includes("Manage skills"));
      expect(browseRow).toBeGreaterThanOrEqual(0);
      expect(filterRow).toBeGreaterThan(browseRow);
      expect(manageRow).toBeGreaterThan(filterRow);
      expect(narrowRows[browseRow]!.indexOf("Browse files")).toBe(narrowRows[manageRow]!.indexOf("Manage skills"));
      setup.mockInput.pressKey("\u001b[6~");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Skills")).toContain("Application");
      setup.resize(180, 30);
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Skills")).not.toContain("PgUp/PgDn page");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
      frame = setup.captureCharFrame();
      expect(frame).toContain("filter: alpha");
      expect(frame).toContain("Notes line 30");

      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
      expect(setup.captureCharFrame()).toContain("filter: alpha");
      expect(setup.captureCharFrame()).toContain("Notes line 30");
    } finally {
      setup.renderer.destroy();
    }
  });
  it("labels the file navigation modifier for macOS and Linux", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      for (const [host, label, other] of [
        ["darwin", "Option+↑/↓", "Alt+↑/↓"],
        ["linux", "Alt+↑/↓", "Option+↑/↓"],
      ]) {
        Object.defineProperty(process, "platform", { ...platform, value: host });
        await setup.mockInput.typeText("?");
        await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
        const help = confirmationText(setup.captureCharFrame(), "Keyboard help");
        expect(help).toContain(`[ ], ${label}`);
        expect(help).not.toContain("[/]");
        expect(help).not.toContain(other);
        setup.mockInput.pressEscape();
        await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      setup.renderer.destroy();
    }
  });


  it("blocks destructive keys and background mouse actions while help is open", async () => {
    const { home, skillsDir } = await fixture();
    const outside = path.join(home, "outside.txt");
    await writeFile(outside, "outside remains unchanged\n");
    const alpha = path.join(skillsDir, "alpha", "SKILL.md");
    const beta = path.join(skillsDir, ".disabled_skills", "beta", "SKILL.md");
    const alphaBefore = await readFile(alpha, "utf8");
    const betaBefore = await readFile(beta, "utf8");
    const setup = await createTestRenderer({ width: 140, height: 24 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      const rows = setup.captureCharFrame().split("\n");
      const betaRow = rows.findIndex((row) => row.includes("○   beta"));
      expect(betaRow).toBeGreaterThanOrEqual(0);
      const betaX = rows[betaRow]!.indexOf("○");

      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      await setup.mockInput.typeText("qd goy");
      setup.mockInput.pressEnter();
      await setup.mockMouse.click(betaX, betaRow);
      await setup.mockMouse.click(betaX, betaRow, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
      expect(setup.captureCharFrame()).toContain("Alpha body");
      expect(setup.captureCharFrame()).not.toContain("Remove skill");
      expect(setup.captureCharFrame()).not.toContain("Disable skill");
      expect(await readFile(alpha, "utf8")).toBe(alphaBefore);
      expect(await readFile(beta, "utf8")).toBe(betaBefore);
      expect(await readFile(outside, "utf8")).toBe("outside remains unchanged\n");
      expect(await exists(path.join(skillsDir, ".skills-manager"))).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("scrolls keyboard help in a short viewport without losing its position", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 60, height: 10 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      const topContent = confirmationText(setup.captureCharFrame(), "Keyboard help");
      expect(topContent).toContain("Select skill");
      expect(topContent).toContain("Up/down scroll");
      expect(topContent).toContain("PgUp/PgDn page");
      const helpRows = setup.captureCharFrame().split("\n");
      const helpTop = helpRows.findIndex((row) => row.includes("┌─Keyboard help"));
      expect(helpTop).toBeGreaterThanOrEqual(0);
      const helpLeft = helpRows[helpTop]!.indexOf("┌─Keyboard help");
      await setup.mockMouse.scroll(helpLeft + 4, helpTop + 2, "down");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).not.toBe(topContent);
      setup.mockInput.pressKey("\u001b[5~");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).toBe(topContent);

      setup.mockInput.pressArrow("down");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).not.toBe(topContent);
      setup.mockInput.pressArrow("up");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).toBe(topContent);

      setup.mockInput.pressKey("\u001b[6~");
      await setup.renderOnce();
      const scrolled = confirmationText(setup.captureCharFrame(), "Keyboard help");
      expect(scrolled).not.toBe(topContent);
      await setup.mockInput.typeText("d");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).toBe(scrolled);
      setup.resize(48, 8);
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).not.toContain("Select skill");
      setup.resize(60, 10);
      await setup.renderOnce();
      setup.mockInput.pressKey("\u001b[5~");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).toBe(topContent);
      for (let index = 0; index < 20; index++) {
        setup.mockInput.pressKey("\u001b[6~");
        await setup.renderOnce();
      }
      const endContent = confirmationText(setup.captureCharFrame(), "Keyboard help · Skills");
      setup.mockInput.pressKey("\u001b[6~");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Skills")).toBe(endContent);
      setup.mockInput.pressKey("\u001b[5~");
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Skills")).not.toBe(endContent);
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
    } finally {
      setup.renderer.destroy();
    }
  });

  it("returns to the selected Git diff and keeps question marks literal in prompts", async () => {
    const { home, skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await writeFile(path.join(skillsDir, "alpha", "SKILL.md"), "---\nname: alpha\n---\n\nFirst Git change.\n");
    await writeFile(path.join(skillsDir, "alpha", "notes.txt"), "Second Git change.\n");
    const outside = path.join(home, "git-outside.txt");
    await writeFile(outside, "outside Git fixture\n");
    const statusBefore = await git(skillsDir, "status", "--porcelain");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      expect(setup.captureCharFrame()).toContain("? help");
      const gitControls = setup.captureSpans().lines.find((line) =>
        line.spans.map((span) => span.text).join("").includes("? help"));
      expect(gitControls?.spans.some((span) => span.text === "?" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      expect(gitControls?.spans.some((span) => span.text === "c" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      await setup.mockInput.typeText("s");
      await setup.waitFor(() => setup.captureCharFrame().includes("status: ??"));
      await setup.mockInput.typeText("s");
      await setup.waitFor(() => setup.captureCharFrame().includes("status: M"));
      await setup.mockInput.typeText("j");
      await setup.waitFor(() => setup.captureCharFrame().includes("Second Git change."));
      const gitRows = setup.captureCharFrame().split("\n");
      const firstFileRow = gitRows.findIndex((row) => row.includes('"alpha/SKILL.md"'));
      const toolbarRow = gitRows.findIndex((row) => row.includes("c commit"));
      expect(firstFileRow).toBeGreaterThanOrEqual(0);
      expect(toolbarRow).toBeGreaterThanOrEqual(0);

      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      expect(setup.captureCharFrame()).toContain("Git · leaf");
      const gitHelp = confirmationText(setup.captureCharFrame(), "Keyboard help · Git");
      expect(gitHelp).toContain("Inspect changes");
      expect(gitHelp).toContain("Commit");
      expect(gitHelp).toContain("Remotes");
      expect(gitHelp).not.toContain("Initialize repository");
      expect(gitHelp).toContain("Commit changes");
      expect(gitHelp).toContain("Fetch");
      expect(gitHelp).not.toContain("Browse files");
      expect(gitHelp).not.toContain("Remove skill");
      expect(gitHelp).not.toContain("PgUp/PgDn page");
      const gitGroupRow = setup.captureCharFrame().split("\n").find((row) => row.includes("Inspect changes") && row.includes("Commit"));
      expect(gitGroupRow).toBeDefined();
      expect(gitGroupRow!.indexOf("Commit")).toBeGreaterThan(gitGroupRow!.indexOf("Inspect changes"));
      const commitShortcut = setup.captureSpans().lines.find((line) =>
        line.spans.map((span) => span.text).join("").includes("Commit changes"));
      expect(commitShortcut?.spans.some((span) => span.text === "c" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      setup.resize(80, 24);
      await setup.renderOnce();
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Git")).not.toContain("PgUp/PgDn page");
      const narrowGit = setup.captureCharFrame().split("\n");
      const inspectRow = narrowGit.findIndex((row) => row.includes("Inspect changes"));
      const commitRow = narrowGit.findIndex((row) => row.includes("Commit"));
      const remoteRow = narrowGit.findIndex((row) => row.includes("Remotes"));
      expect(inspectRow).toBeGreaterThanOrEqual(0);
      expect(commitRow).toBeGreaterThan(inspectRow);
      expect(remoteRow).toBeGreaterThan(commitRow);
      expect(narrowGit[inspectRow]!.indexOf("Inspect changes")).toBe(narrowGit[commitRow]!.indexOf("Commit"));
      setup.resize(60, 10);
      await setup.renderOnce();
      const gitTop = confirmationText(setup.captureCharFrame(), "Keyboard help · Git");
      expect(gitTop).toContain("Inspect changes");
      expect(gitTop).toContain("Up/down scroll");
      expect(gitTop).toContain("PgUp/PgDn page");
      for (let index = 0; index < 10; index++) {
        setup.mockInput.pressKey("\u001b[6~");
        await setup.renderOnce();
      }
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Git")).toContain("Add remote");
      for (let index = 0; index < 10; index++) {
        setup.mockInput.pressKey("\u001b[5~");
        await setup.renderOnce();
      }
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help · Git")).toBe(gitTop);
      setup.resize(180, 30);
      await setup.renderOnce();
      await setup.mockInput.typeText("cst");
      await setup.mockMouse.click(gitRows[firstFileRow]!.indexOf("alpha/SKILL.md"), firstFileRow);
      await setup.mockMouse.click(gitRows[toolbarRow]!.indexOf("c commit"), toolbarRow);
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
      expect(setup.captureCharFrame()).toContain("Working tree");
      expect(setup.captureCharFrame()).toContain("status: M");
      expect(setup.captureCharFrame()).toContain("Second Git change.");
      expect(setup.captureCharFrame()).not.toContain("Commit message:");
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
      expect(setup.captureCharFrame()).toContain("Working tree");
      expect(setup.captureCharFrame()).toContain("status: M");
      expect(setup.captureCharFrame()).toContain("Second Git change.");
      expect(await git(skillsDir, "status", "--porcelain")).toBe(statusBefore);
      expect(await readFile(path.join(skillsDir, "alpha", "SKILL.md"), "utf8")).toContain("First Git change.");
      expect(await readFile(path.join(skillsDir, "alpha", "notes.txt"), "utf8")).toBe("Second Git change.\n");
      expect(await readFile(outside, "utf8")).toBe("outside Git fixture\n");

      await setup.mockInput.typeText("n");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote name:"));
      await setup.mockInput.typeText("backup?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote name: backup?"));
      expect(setup.captureCharFrame()).not.toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Remote name:") && setup.captureCharFrame().includes("Working tree"));

      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Commit message:"));
      await setup.mockInput.typeText("message?");
      await setup.waitFor(() => setup.captureCharFrame().includes("message?"));
      expect(setup.captureCharFrame()).not.toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Commit message:") && setup.captureCharFrame().includes("Working tree"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => setup.captureCharFrame().includes("scope: All"));
      await setup.mockInput.typeText("/question?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Search: question?"));
      expect(setup.captureCharFrame()).not.toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Search: question?"));
      await setup.mockInput.typeText("aquery?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Search skills: query?"));
      expect(setup.captureCharFrame()).not.toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Search skills: query?"));
      await setup.mockInput.typeText(" ");
      await setup.waitFor(() => setup.captureCharFrame().includes("Disable skill"));
      await setup.mockInput.typeText("?");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Disable skill");
      expect(setup.captureCharFrame()).not.toContain("Keyboard help");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Disable skill"));
      const rows = setup.captureCharFrame().split("\n");
      const alphaRow = rows.findIndex((row) => row.includes("◉   alpha"));
      expect(alphaRow).toBeGreaterThanOrEqual(0);
      await setup.mockMouse.click(rows[alphaRow]!.indexOf("alpha"), alphaRow, MouseButtons.RIGHT);
      await setup.waitFor(() => setup.captureCharFrame().includes("Delete"));
      await setup.mockInput.typeText("?");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Delete");
      expect(setup.captureCharFrame()).not.toContain("Keyboard help");
      setup.mockInput.pressEscape();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("retains the selected file's total line count across rendering modes, scrolling and file changes", async () => {
    const { skillsDir } = await fixture();
    const body = Array.from({ length: 45 }, (_, index) => `body line ${index + 1}`).join("\n");
    await writeFile(path.join(skillsDir, "alpha", "SKILL.md"), `---\nname: alpha\n---\n${body}\n`);
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("48 lines"));
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("Raw · toggle rendering"));
      expect(setup.captureCharFrame()).toContain("48 lines");
      setup.mockInput.pressKey("\u001b[6~");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("48 lines");
      await setup.mockInput.typeText("]");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      expect(setup.captureCharFrame()).toContain("1 line");
      await setup.mockInput.typeText("[");
      await setup.waitFor(() => setup.captureCharFrame().includes("48 lines"));
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("Markdown · toggle rendering"));
      expect(setup.captureCharFrame()).toContain("48 lines");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("scrolls long metadata and warnings using ordinary keyboard keys", async () => {
    const { skillsDir } = await fixture();
    const metadata = Array.from({ length: 45 }, (_, index) => `  key${index}: value-${index}`).join("\n");
    await writeFile(path.join(skillsDir, "alpha", "SKILL.md"), `---\nname: alpha\nmetadata:\n${metadata}\n---\n\nBody.\n`);
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Skill details · ,/. scroll"));
      await setup.mockInput.typeText(".".repeat(50));
      await setup.waitFor(() => setup.captureCharFrame().includes("Key44: value-44"));
    } finally {
      setup.renderer.destroy();
    }
  });

  it("shows disabled skills, unknown authors, links and parse warnings independently of source", async () => {
    const { skillsDir } = await fixture();
    await symlink("missing-target", path.join(skillsDir, "broken"));
    await mkdir(path.join(skillsDir, "invalid"));
    await writeFile(path.join(skillsDir, "invalid", "SKILL.md"), "---js\nthrow new Error('not data')\n---\n");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("○   beta"));
      let rows = setup.captureCharFrame().split("\n");
      let row = rows.findIndex((line) => line.includes("◉   broken"));
      expect(row).toBeGreaterThanOrEqual(0);
      await setup.mockMouse.click(rows[row]!.indexOf("broken"), row);
      await setup.waitFor(() => setup.captureCharFrame().includes('broken-symlink -> "missing-target"'));
      expect(setup.captureCharFrame()).toContain("Author not listed");
      expect(setup.captureCharFrame()).toContain("Repository: not recorded");
      expect(setup.captureCharFrame()).toContain("Warning:");
      rows = setup.captureCharFrame().split("\n");
      row = rows.findIndex((line) => line.includes("◉   invalid"));
      await setup.mockMouse.click(rows[row]!.indexOf("invalid"), row);
      await setup.waitFor(() => setup.captureCharFrame().includes("Warning:"));
      expect(setup.captureCharFrame()).toContain("Author not listed");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("requires exact-path approval before toggling and defaults to cancel", async () => {
    const { skillsDir } = await fixture();
    const original = path.join(skillsDir, "alpha", "SKILL.md");
    const disabled = path.join(skillsDir, ".disabled_skills", "alpha", "SKILL.md");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText(" ");
      await setup.waitFor(() => setup.captureCharFrame().includes("Disable skill"));
      expect(confirmationText(setup.captureCharFrame(), "Disable skill")).toContain(`From: "${path.join(skillsDir, "alpha")}"`);
      expect(confirmationText(setup.captureCharFrame(), "Disable skill")).toContain(`To: "${path.join(skillsDir, ".disabled_skills", "alpha")}"`);
      expect(setup.captureCharFrame()).not.toMatch(/n\s+cancel|n\/Esc/i);
      await setup.mockInput.typeText("n");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Disable skill");
      expect(await exists(original)).toBe(true);
      expect(await exists(disabled)).toBe(false);
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Disable skill"));
      expect(await exists(original)).toBe(true);
      expect(await exists(disabled)).toBe(false);
      await setup.mockInput.typeText(" ");
      await setup.waitFor(() => setup.captureCharFrame().includes("Disable skill"));
      await setup.mockInput.typeText("yy");
      await setup.waitFor(() => setup.captureCharFrame().includes("Disabled alpha."));
      expect(await exists(original)).toBe(false);
      expect(await readFile(disabled, "utf8")).toContain("Alpha body");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("rejects a removal if the reviewed skill changes before confirmation", async () => {
    const { skillsDir } = await fixture();
    const file = path.join(skillsDir, "alpha", "SKILL.md");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remove skill"));
      expect(confirmationText(setup.captureCharFrame(), "Remove skill")).toContain(`Path: "${path.dirname(file)}"`);
      expect(setup.captureCharFrame()).toContain("Esc cancel");
      expect(setup.captureCharFrame()).toContain("y remove");
      expect(setup.captureCharFrame()).not.toContain("n/Esc");
      expect(setup.captureCharFrame()).toContain("Ownership: unknown");
      expect(setup.captureCharFrame()).toContain("irreversible after recovery cleanup");
      await writeFile(file, "changed after preview\n");
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Remove skill"));
      expect(await readFile(file, "utf8")).toBe("changed after preview\n");
      expect(setup.captureCharFrame()).not.toContain("Removed alpha.");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("refuses a replacement of the approved root even when the same path still exists", async () => {
    const { home, skillsDir } = await fixture();
    const approved = await approveSkillsRoot(skillsDir);
    const displaced = path.join(home, "original-skills");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, approved).start();
      await rename(skillsDir, displaced);
      await mkdir(path.join(skillsDir, "alpha"), { recursive: true });
      const replacement = path.join(skillsDir, "alpha", "SKILL.md");
      await writeFile(replacement, "---\nname: alpha\n---\n\nReplacement directory sentinel.\n");
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Selected skills directory changed since approval"));
      expect(setup.captureCharFrame()).not.toContain("Remove skill");
      expect(setup.captureCharFrame()).not.toContain("Removed alpha.");
      expect(await readFile(replacement, "utf8")).toContain("Replacement directory sentinel.");
      expect(await readFile(path.join(displaced, "alpha", "SKILL.md"), "utf8")).toContain("Alpha body");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("rejects a root replaced after the removal preview", async () => {
    const { home, skillsDir } = await fixture();
    const approved = await approveSkillsRoot(skillsDir);
    const displaced = path.join(home, "approved-skills");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, approved).start();
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remove skill"));
      await rename(skillsDir, displaced);
      await mkdir(path.join(skillsDir, "alpha"), { recursive: true });
      const replacement = path.join(skillsDir, "alpha", "SKILL.md");
      await writeFile(replacement, "---\nname: alpha\n---\n\nReplacement after review.\n");
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Remove skill"));
      expect(setup.captureCharFrame()).not.toContain("Removed alpha.");
      expect(await readFile(replacement, "utf8")).toContain("Replacement after review.");
      expect(await readFile(path.join(displaced, "alpha", "SKILL.md"), "utf8")).toContain("Alpha body");
      expect(await exists(path.join(skillsDir, ".skills-manager"))).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("previews a selected link and deletes only the link after approval", async () => {
    const { home, skillsDir } = await fixture();
    const outside = path.join(home, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "SKILL.md"), "---\nname: linked\n---\n\nOutside sentinel.\n");
    await symlink(outside, path.join(skillsDir, "linked"));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      let rows = setup.captureCharFrame().split("\n");
      let row = rows.findIndex((line) => line.includes("◉   linked"));
      expect(row).toBeGreaterThanOrEqual(0);
      await setup.mockMouse.click(rows[row]!.indexOf("linked"), row, MouseButtons.RIGHT);
      await setup.waitFor(() => setup.captureCharFrame().includes("Delete"));
      rows = setup.captureCharFrame().split("\n");
      row = rows.findIndex((line) => line.includes("Delete"));
      await setup.mockMouse.click(rows[row]!.indexOf("Delete"), row);
      await setup.waitFor(() => setup.captureCharFrame().includes("Remove skill"));
      expect(confirmationText(setup.captureCharFrame(), "Remove skill")).toContain(`symlink -> "${outside}"`);
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Removed linked."));
      expect(await exists(path.join(skillsDir, "linked"))).toBe(false);
      expect(await readFile(path.join(outside, "SKILL.md"), "utf8")).toContain("Outside sentinel.");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("lets an adopted unknown-source skill choose an explicit replacement source", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("u");
      await setup.waitFor(() => setup.captureCharFrame().includes("Replacement source for alpha:"));
      await setup.mockInput.typeText("owner/repository@alpha");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("owner/repository@alpha");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Replacement source for alpha:"));
      expect(await readFile(path.join(skillsDir, "alpha", "SKILL.md"), "utf8")).toContain("Alpha body");
      expect(await exists(path.join(skillsDir, ".skills-manager"))).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("groups update sources while retaining skills, refs and paths", async () => {
    const { home, skillsDir } = await fixture();
    for (const name of ["gamma", "delta"]) {
      await mkdir(path.join(skillsDir, name));
      await writeFile(path.join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const base = {
      source: "example/project", sourceType: "github", sourceUrl: "https://github.com/example/project",
      skillFolderHash: "a".repeat(40), installedAt: "2026-01-01", updatedAt: "2026-01-01",
    };
    await writeFile(path.join(home, ".skill-lock.json"), JSON.stringify({ version: 3, skills: {
      alpha: { ...base, skillPath: "skills/alpha/SKILL.md", ref: "release/v1" },
      beta: { ...base, skillPath: "skills/beta/SKILL.md" },
      gamma: { ...base, source: "other/project", sourceUrl: "https://github.com/other/project", skillPath: "tools/gamma/SKILL.md" },
      delta: { ...base, source: "https://git.example.org/team/repo", sourceUrl: "https://git.example.org/team/repo", sourceType: "git", skillPath: "delta/SKILL.md" },
    } }));
    const { receipt } = await savedSourceFixture(skillsDir);
    await writeFile(path.join(skillsDir, ".skills-manager", "metadata", "delta.json"), JSON.stringify({
      ...receipt,
      name: "delta",
      fingerprint: await fingerprintContents(path.join(skillsDir, "delta")),
      entry: { ...base, source: "https://git.example.org/team/repo", sourceUrl: "https://git.example.org/team/repo", sourceType: "git", skillPath: "delta/SKILL.md" },
    }), { mode: 0o600 });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("p");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review saved sources"));
      const review = confirmationText(setup.captureCharFrame(), "Review saved sources");
      expect(review.match(/https:\/\/github\.com\/example\/project/g)).toHaveLength(1);
      expect(review).toContain("https://github.com/other/project");
      expect(review).toContain("skills/alpha/SKILL.md");
      expect(review).toContain("release/v1");
      expect(review).toContain("skills/beta/SKILL.md");
      expect(review).toContain("tools/gamma/SKILL.md");
      expect(review).toContain("delta");
      expect(review).toContain("https://git.example.org/team/repo");
      expect(review.match(new RegExp(skillsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review saved sources"));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setup.renderer.destroy();
    }
  });

  it.each(["u", "p"])("reviews saved source and cancels without contact for %s", async (key) => {
    const { skillsDir } = await fixture();
    await savedSourceFixture(skillsDir);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText(key);
      await setup.waitFor(() => setup.captureCharFrame().includes("Review saved sources"));
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review saved sources"));
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(path.join(skillsDir, "alpha", "SKILL.md"), "utf8")).toContain("Alpha body");
    } finally {
      setup.renderer.destroy();
    }
  });

  it.each(["u", "p"])("refuses changed saved source before preparing update for %s", async (key) => {
    const { skillsDir } = await fixture();
    const { file, receipt } = await savedSourceFixture(skillsDir);
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText(key);
      await setup.waitFor(() => setup.captureCharFrame().includes("Review saved sources"));
      await writeFile(file, JSON.stringify({ ...receipt, entry: { ...receipt.entry, ref: "changed-ref" } }));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("The saved source changed since approval."));
      expect(setup.captureCharFrame()).not.toContain("Review prepared skill changes");
      expect(await readFile(path.join(skillsDir, "alpha", "SKILL.md"), "utf8")).toContain("Alpha body");
    } finally {
      setup.renderer.destroy();
    }
  });

  it.each([false, true])("checks only an unchanged saved source without confirmation (changed: %s)", async (changed) => {
    const { skillsDir } = await fixture();
    const { file, receipt } = await savedSourceFixture(skillsDir);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sha: "a".repeat(40), tree: [] }), { status: 200 }));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      expect(fetch).not.toHaveBeenCalled();
      if (changed) {
        await writeFile(file, JSON.stringify({ ...receipt, entry: { ...receipt.entry, source: "other/project", sourceUrl: "https://github.com/other/project", ref: "other" } }));
      }
      await setup.mockInput.typeText("v");
      if (changed) {
        await setup.waitFor(() => setup.captureCharFrame().includes("The saved source changed since approval."));
        expect(fetch).not.toHaveBeenCalled();
      } else {
        await setup.waitFor(() => setup.captureCharFrame().includes("Update check"));
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0]![0]).toBe("https://api.github.com/repos/example/project/git/trees/release%2Fv1?recursive=1");
      }
    } finally {
      setup.renderer.destroy();
    }
  });
  it.each([false, true])("checks an unchanged Vercel lock source without confirmation (changed: %s)", async (changed) => {
    const { home, skillsDir } = await fixture();
    const entry = {
      source: "example/project", sourceType: "github", sourceUrl: "https://github.com/example/project",
      skillPath: "skills/alpha/SKILL.md", skillFolderHash: "a".repeat(40),
      installedAt: "2026-01-01", updatedAt: "2026-01-01", ref: "release/v1",
    };
    const lock = path.join(home, ".skill-lock.json");
    await writeFile(lock, JSON.stringify({ version: 3, skills: { alpha: entry } }));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sha: "a".repeat(40), tree: [] }), { status: 200 }));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("https://github.com/example/project"));
      expect(setup.captureCharFrame()).toContain("◉ ⎇ alpha");
      expect(setup.captureCharFrame().split("\n").filter((row) => row.includes("example/project"))).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
      if (changed) await writeFile(lock, JSON.stringify({ version: 3, skills: { alpha: { ...entry, ref: "changed" } } }));
      await setup.mockInput.typeText("v");
      if (changed) {
        await setup.waitFor(() => setup.captureCharFrame().includes("The saved source changed since approval."));
        expect(fetch).not.toHaveBeenCalled();
      } else {
        await setup.waitFor(() => setup.captureCharFrame().includes("Update check"));
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0]![0]).toBe("https://api.github.com/repos/example/project/git/trees/release%2Fv1?recursive=1");
        expect(setup.captureCharFrame()).toContain("not your local edits");
      }
    } finally {
      setup.renderer.destroy();
    }
  });
  it("shows a conflicting external source separately from the installed source", async () => {
    const { home, skillsDir } = await fixture();
    const { receipt } = await savedSourceFixture(skillsDir);
    const claim = { ...receipt.entry, source: "other/project", sourceUrl: "https://github.com/other/project" };
    await writeFile(path.join(home, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { alpha: claim } }));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("other/project"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("https://github.com/example/project");
      expect(frame).toContain("Recorded source (unverified): other/project");
    } finally {
      setup.renderer.destroy();
    }
  });



  it.each(["u", "p"])("does not contact a saved update endpoint when cancelling %s", async (key) => {
    const { skillsDir } = await fixture();
    const { file, receipt } = await savedSourceFixture(skillsDir);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(404).end();
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const url = `http://127.0.0.1:${address.port}/repository`;
    await writeFile(file, JSON.stringify({ ...receipt, entry: { ...receipt.entry, source: url, sourceUrl: url, sourceType: "git" } }));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText(key);
      await setup.waitFor(() => setup.captureCharFrame().includes("Review saved sources"));
      expect(confirmationText(setup.captureCharFrame(), "Review saved sources")).toContain(`"${url}"`);
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review saved sources"));
      expect(requests).toBe(0);
    } finally {
      setup.renderer.destroy();
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
  });

  it("reports unavailable manual update checks instead of claiming unknown sources are current", async () => {
    const { skillsDir } = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("v");
      await setup.waitFor(() => setup.captureCharFrame().includes("Update check"));
      expect(setup.captureCharFrame()).toContain("not your local edits");
      expect(setup.captureCharFrame()).toContain("some checks were unavailable");
      expect(setup.captureCharFrame()).toContain("alpha: unavailable");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("shows the actual Git root once and a clean working-tree message", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await git(skillsDir, "add", "--all");
    await git(skillsDir, "commit", "-m", "clean skills");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("No changed skill paths."));
      const frame = setup.captureCharFrame();
      expect(frame.match(/Git: leaf · root /g)).toHaveLength(1);
      expect(frame).toContain(`Git: leaf · root "${skillsDir}"`);
      expect(frame).toContain("0 changed skill paths");
      await setup.mockInput.typeText("n");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote name:"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Remote name:"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => setup.captureCharFrame().includes(`Directory: "${skillsDir}"`));
    } finally {
      setup.renderer.destroy();
    }
  });

  it("previews leaf Git initialization and cancels by default", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("i");
      await setup.waitFor(() => setup.captureCharFrame().includes("Initialize Git"));
      expect(confirmationText(setup.captureCharFrame(), "Initialize Git")).toContain(`Selected directory: "${skillsDir}"`);
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Initialize Git"));
      expect(await exists(path.join(skillsDir, ".git"))).toBe(false);
      expect(await exists(path.join(skillsDir, ".skills-manager"))).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });


  it.each([
    ["chosen-skills", "chosen-skills"],
    ["literal\\n-skills", "literal\\\\n-skills"],
  ])("initializes only after review without opening remote setup in %s", async (directoryName, quotedDirectoryName) => {
    const { home, skillsDir } = await fixture(directoryName);
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("i");
      await setup.waitFor(() => setup.captureCharFrame().includes("Initialize Git"));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Initialized empty Git repository in "));
      const frame = setup.captureCharFrame();
      const notice = frame.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Initialized empty Git repository in "));
      expect(notice).toBe(`Initialized empty Git repository in ${skillsDir}/.git/`);
      expect(frame).toContain(`Git: leaf · root "${path.join(home, quotedDirectoryName)}"`);
      expect(frame).not.toContain("Remote name:");
      expect(frame).not.toContain("Backup unavailable");
      expect(await exists(path.join(skillsDir, ".git"))).toBe(true);
      expect(await git(skillsDir, "remote")).toBe("");
      await expect(git(skillsDir, "rev-parse", "--verify", "HEAD")).rejects.toThrow();
    } finally {
      setup.renderer.destroy();
    }
  });

  it.each(["leaf", "parent"] as const)("does not initialize an existing %s repository and keeps browsing", async (kind) => {
    const { home, skillsDir } = await fixture();
    const repository = kind === "leaf" ? skillsDir : home;
    await initGit(repository);
    const skillPath = kind === "leaf" ? "alpha/SKILL.md" : "chosen-skills/alpha/SKILL.md";
    await git(repository, "add", "--", skillPath);
    await git(repository, "commit", "-m", "existing tracked skills");
    await writeFile(path.join(home, "outside.txt"), "unrelated work\n");
    if (kind === "parent") await git(repository, "add", "--", "outside.txt");
    await writeFile(path.join(skillsDir, "alpha", "SKILL.md"), "---\nname: alpha\n---\n\nExisting repository skill.\n");
    const before = {
      head: await git(repository, "rev-parse", "HEAD"),
      status: await git(repository, "status", "--porcelain=v1"),
      index: await readFile(path.join(repository, ".git", "index")),
      config: await readFile(path.join(repository, ".git", "config")),
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Existing repository skill."));
      let frame = setup.captureCharFrame();
      expect(frame).toContain("scope: All");
      expect(frame).not.toContain("Initialize Git");
      expect(frame).not.toContain("Backup unavailable");
      expect(frame).not.toContain("Remote name:");
      expect(frame).not.toContain("Git status failed");
      await setup.mockInput.typeText("]");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes(`Git: ${kind}`));
      frame = setup.captureCharFrame();
      expect(frame).toContain(`root "${repository}"`);
      expect(frame).toContain("alpha/SKILL.md");
      expect(frame).not.toContain("i initialize");
      expect(frame).not.toContain("Git actions require");
      await setup.mockInput.typeText("i");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Initialize Git");
      await setup.mockInput.typeText("?");
      await setup.waitFor(() => setup.captureCharFrame().includes("Keyboard help"));
      expect(confirmationText(setup.captureCharFrame(), "Keyboard help")).not.toContain("Initialize repository");
      setup.mockInput.pressEscape();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Keyboard help"));
      setup.mockInput.pressEscape();
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      expect(await git(repository, "rev-parse", "HEAD")).toBe(before.head);
      expect(await git(repository, "status", "--porcelain=v1")).toBe(before.status);
      expect(await readFile(path.join(repository, ".git", "index"))).toEqual(before.index);
      expect(await readFile(path.join(repository, ".git", "config"))).toEqual(before.config);
      expect(await git(repository, "remote")).toBe("");
      if (kind === "parent") expect(await exists(path.join(skillsDir, ".git"))).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps a missing root read-only and browsing available", async () => {
    const { home } = await fixture();
    const missing = path.join(home, "missing-skills");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, { path: missing, identity: null }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes(`Directory: "${missing}"`));
      expect(setup.captureCharFrame()).not.toContain("Initialize Git");
      expect(setup.captureCharFrame()).not.toContain("Backup unavailable");
      expect(await exists(missing)).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("redacts a remote setup preview and leaves configuration unchanged on cancel", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("n");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote name:"));
      await setup.mockInput.typeText("backup");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote URL:"));
      await setup.mockInput.typeText("https://person:secret-token@example.invalid/private/repo.git");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Add remote"));
      const preview = setup.captureCharFrame();
      expect(preview).toContain("backup");
      expect(preview).toContain("example.invalid/private/repo.git");
      expect(preview).not.toContain("secret-token");
      expect(preview).not.toContain("person:");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Add remote"));
      expect(await git(skillsDir, "remote")).toBe("");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("previews fetch and pull destinations without contacting or changing them on cancel", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await git(skillsDir, "remote", "add", "backup", "https://person:secret-token@example.invalid/private/repo.git");
    await git(skillsDir, "config", "branch.fixture-main.remote", "backup");
    await git(skillsDir, "config", "branch.fixture-main.merge", "refs/heads/fixture-main");
    await git(skillsDir, "update-ref", "refs/remotes/backup/fixture-main", "HEAD");
    const before = await git(skillsDir, "rev-parse", "HEAD");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("f");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review fetch"));
      let preview = setup.captureCharFrame();
      expect(preview).toContain("example.invalid/private/repo.git");
      expect(preview).toContain("refs/remotes/backup/fixture-main");
      expect(preview).not.toContain("secret-token");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review fetch"));
      await setup.mockInput.typeText("l");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review pull"));
      preview = setup.captureCharFrame();
      expect(preview).toContain("example.invalid/private/repo.git");
      expect(preview).not.toContain("secret-token");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review pull"));
      expect(await git(skillsDir, "rev-parse", "HEAD")).toBe(before);
      expect(await git(skillsDir, "rev-parse", "refs/remotes/backup/fixture-main")).toBe(before);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("previews an explicitly selected remote and branch while HEAD is detached", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await git(skillsDir, "checkout", "--detach", "HEAD");
    await git(skillsDir, "remote", "add", "primary", "https://example.invalid/primary.git");
    await git(skillsDir, "remote", "add", "backup", "https://example.invalid/backup.git");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("f");
      await setup.waitFor(() => setup.captureCharFrame().includes("Fetch remote"));
      expect(setup.captureCharFrame()).toContain("backup");
      expect(setup.captureCharFrame()).toContain("primary");
      await setup.mockInput.typeText("backup");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Fetch branch:"));
      await setup.mockInput.typeText("fixture-main");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review fetch"));
      expect(setup.captureCharFrame()).toContain("Remote: backup");
      expect(setup.captureCharFrame()).toContain("example.invalid/backup.git");
      expect(setup.captureCharFrame()).toContain("Branch: fixture-main");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review fetch"));
      await expect(git(skillsDir, "rev-parse", "--verify", "refs/remotes/backup/fixture-main")).rejects.toThrow();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("reviews a containing-repository commit with skills-relative paths and preserves unrelated staged work", async () => {
    const { home, skillsDir } = await fixture();
    await initGit(home);
    await writeFile(path.join(home, "sentinel.txt"), "outside selected repository\n");
    await git(home, "add", "--", "sentinel.txt", "chosen-skills/alpha/SKILL.md");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain(`Directory: "${skillsDir}"`);
      expect(setup.captureCharFrame()).not.toContain("Git: parent");
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes(`Git: parent · root "${home}"`));
      expect(setup.captureCharFrame()).toContain('"alpha/SKILL.md"');
      expect(setup.captureCharFrame()).not.toContain('"chosen-skills/alpha/SKILL.md"');
      expect(setup.captureCharFrame()).not.toContain("sentinel.txt");
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Commit message:"));
      await setup.mockInput.typeText("review skills only");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review commit"));
      const preview = confirmationText(setup.captureCharFrame(), "Review commit");
      expect(preview).toContain(`Repository: "${home}"`);
      expect(preview).toContain(`Skills directory: "${skillsDir}"`);
      expect(preview).toContain('"alpha/SKILL.md"');
      expect(preview).not.toContain("sentinel.txt");
      await setup.mockInput.typeText("y");
      await setup.waitFor(async () => {
        try { await git(home, "rev-parse", "--verify", "HEAD"); return true; } catch { return false; }
      }, 15_000);
      expect(await git(home, "show", "--format=", "--name-only", "HEAD")).toContain("chosen-skills/alpha/SKILL.md");
      expect(await git(home, "show", "--format=", "--name-only", "HEAD")).not.toContain("sentinel.txt");
      expect(await git(home, "diff", "--cached", "--name-only")).toBe("sentinel.txt");
      expect(await exists(path.join(skillsDir, ".git"))).toBe(false);
      expect(await readFile(path.join(home, "sentinel.txt"), "utf8")).toBe("outside selected repository\n");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("reviews an unborn leaf commit and preserves an unrelated staged file", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await writeFile(path.join(skillsDir, "unrelated.txt"), "preserve staged data\n");
    await git(skillsDir, "add", "--", "unrelated.txt");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("(unborn)");
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      expect(setup.captureCharFrame()).toContain("(unborn)");
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Commit message:"));
      await setup.mockInput.typeText("first reviewed commit");
      await setup.waitFor(() => setup.captureCharFrame().includes("first reviewed commit"));
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review commit"));
      const preview = setup.captureCharFrame();
      expect(preview).toContain("first commit");
      expect(preview).toContain("alpha/SKILL.md");
      expect(preview).toContain(".disabled_skills/beta/SKILL.md");
      expect(preview).not.toContain("unrelated.txt");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review commit"));
      await expect(git(skillsDir, "rev-parse", "--verify", "HEAD")).rejects.toThrow();
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Commit message:"));
      await setup.mockInput.typeText("first reviewed commit");
      await setup.waitFor(() => setup.captureCharFrame().includes("first reviewed commit"));
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review commit"));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review commit"), 15_000);
      await setup.waitFor(async () => {
        try { await git(skillsDir, "rev-parse", "--verify", "HEAD"); return true; } catch { return false; }
      });
      const committed = await git(skillsDir, "show", "--format=", "--name-only", "HEAD");
      expect(committed).toContain("alpha/SKILL.md");
      expect(committed).toContain(".disabled_skills/beta/SKILL.md");
      expect(committed).not.toContain("unrelated.txt");
      expect(await git(skillsDir, "diff", "--cached", "--name-only")).toContain("unrelated.txt");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("identifies blocker paths separately in a directory-to-file commit preview", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await rm(path.join(skillsDir, "alpha"), { recursive: true });
    await writeFile(path.join(skillsDir, "alpha"), "Blocking replacement file.\n");
    const before = await git(skillsDir, "rev-parse", "HEAD");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Commit message:"));
      await setup.mockInput.typeText("review replacement");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review commit"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Literal skill paths:");
      expect(frame).toContain('"alpha/SKILL.md"');
      expect(frame).toContain("Blocking ancestor paths reviewed for identity");
      expect(frame).toContain("only the literal paths above are committed");
      expect(frame).toContain('"alpha"');
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review commit"));
      expect(await git(skillsDir, "rev-parse", "HEAD")).toBe(before);
      expect(await readFile(path.join(skillsDir, "alpha"), "utf8")).toContain("Blocking replacement file.");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("scrolls through every path in a long commit preview before cancellation", async () => {
    const { skillsDir } = await fixture();
    for (let index = 0; index < 25; index++) {
      const directory = path.join(skillsDir, `skill-${String(index).padStart(2, "0")}`);
      await mkdir(directory);
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: skill-${index}\n---\n\nReview fixture.\n`);
    }
    await initGit(skillsDir);
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"), 30_000);
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Commit message:"));
      await setup.mockInput.typeText("review many files");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review commit"), 30_000);
      for (let index = 0; index < 40; index++) setup.mockInput.pressArrow("down");
      await setup.waitFor(() => setup.captureCharFrame().includes("skill-24/SKILL.md"));
      setup.mockInput.pressArrow("right");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("skill-24/SKILL.md");
      setup.mockInput.pressArrow("left");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review commit"));
      await expect(git(skillsDir, "rev-parse", "--verify", "HEAD")).rejects.toThrow();
    } finally {
      setup.renderer.destroy();
    }
  }, 60_000);

  it("renders contiguous styled Git status and diff controls with real changes", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await writeFile(path.join(skillsDir, "alpha", "SKILL.md"), "---\nname: alpha\n---\n\nChanged diff body.\n");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree · all · status") && setup.captureCharFrame().includes("alpha/SKILL.md"));
      const rows = setup.captureCharFrame().split("\n");
      const row = rows.findIndex((line) => line.includes("alpha/SKILL.md"));
      expect(row).toBeGreaterThan(0);
      await setup.mockMouse.click(rows[row]!.indexOf("alpha/SKILL.md"), row);
      await setup.waitFor(() => setup.captureCharFrame().includes("Changed diff body."));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("alpha/SKILL.md");
      expect(frame).not.toContain("alpha/SKILL .md");
      expect(frame).toContain("Working tree · all · status");
      expect(frame).not.toContain("s tatus");
      expect(frame).toContain("toggle · diff only");
      expect(frame).not.toContain("t oggle · diff only");
      const spans = setup.captureSpans().lines;
      const status = spans.find((line) => line.spans.map((span) => span.text).join("").includes("Working tree · all · status"));
      expect(status?.spans.some((span) => span.text === "s" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      const toggle = spans.find((line) => line.spans.map((span) => span.text).join("").includes("toggle · diff only"));
      expect(toggle?.spans.some((span) => span.text === "t" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("toggle · full file"));
    } finally {
      setup.renderer.destroy();
    }
  });

  it("redacts the actual push URL and asks for separate provider-access approval", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await git(skillsDir, "remote", "add", "backup", "https://person:secret-token@example.invalid/private/repo.git");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("p");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review push"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("backup");
      expect(frame).toContain("example.invalid/private/repo.git");
      expect(frame).toContain("fixture skill commit");
      expect(frame).toContain("alpha/SKILL.md");
      expect(frame).not.toContain("secret-token");
      expect(frame).not.toContain("person:");
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Check provider access"));
      expect(setup.captureCharFrame()).toContain("checked on the provider");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Check provider access"));
    } finally {
      setup.renderer.destroy();
    }
  });

  it("discloses containing-repository push history and rejects a stale reviewed push", async () => {
    const { home, skillsDir } = await fixture();
    const bare = path.join(home, "receiver.git");
    await mkdir(bare);
    await git(bare, "init", "--bare");
    await initGit(home);
    await writeFile(path.join(home, "outside.txt"), "outside branch history\n");
    await git(home, "add", "--", "outside.txt", "chosen-skills/alpha/SKILL.md");
    await git(home, "commit", "-m", "repository history");
    await git(home, "remote", "add", "origin", bare);
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes(`Git: parent · root "${home}"`));
      await setup.mockInput.typeText("n");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Remote name:");
      await setup.mockInput.typeText("p");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review push"));
      const review = confirmationText(setup.captureCharFrame(), "Review push");
      expect(review).toContain(`Repository: "${home}"`);
      expect(review).toContain(`Skills directory: "${skillsDir}"`);
      expect(review).toContain(bare);
      expect(review).toContain("Remote: origin");
      expect(review).toContain("Destination: refs/heads/fixture-main");
      expect(review).toContain("whole branch history");
      expect(review).toContain("outside the selected skills directory");
      setup.mockInput.pressKey("\u001b[6~");
      await setup.waitFor(() => confirmationText(setup.captureCharFrame(), "Review push").includes("repository-relative"));
      const history = confirmationText(setup.captureCharFrame(), "Review push");
      expect(history).toContain("outside.txt");
      expect(history).toContain("chosen-skills/alpha/SKILL.md");
      expect(await git(bare, "for-each-ref", "--format=%(objectname)", "refs/heads/fixture-main")).toBe("");
      await git(home, "commit", "--allow-empty", "-m", "change after review");
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Check provider access"));
      expect(confirmationText(setup.captureCharFrame(), "Check provider access")).toContain("whole branch history");
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Push preview changed"), 15_000);
      expect(await git(bare, "for-each-ref", "--format=%(objectname)", "refs/heads/fixture-main")).toBe("");
      expect(await exists(path.join(skillsDir, ".git"))).toBe(false);
      expect(await readFile(path.join(home, "outside.txt"), "utf8")).toBe("outside branch history\n");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("pushes only after the preview and a separate provider check to a disposable bare remote", async () => {
    const { home, skillsDir } = await fixture();
    const bare = path.join(home, "backup.git");
    await mkdir(bare);
    await git(bare, "init", "--bare");
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await git(skillsDir, "remote", "add", "backup", bare);
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("p");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review push"));
      expect(confirmationText(setup.captureCharFrame(), "Review push")).toContain(bare);
      expect(await git(bare, "for-each-ref", "--format=%(objectname)", "refs/heads/fixture-main")).toBe("");
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Check provider access"));
      expect(await git(bare, "for-each-ref", "--format=%(objectname)", "refs/heads/fixture-main")).toBe("");
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Check provider access"));
      await setup.waitFor(async () => {
        try { await git(bare, "rev-parse", "refs/heads/fixture-main"); return true; } catch { return false; }
      });
      expect(await git(bare, "rev-parse", "refs/heads/fixture-main")).toBe(await git(skillsDir, "rev-parse", "HEAD"));
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps a missing root read-only after the directory is created", async () => {
    const { home } = await fixture();
    const missing = path.join(home, "future-skills");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, { path: missing, identity: null }).start();
      await setup.renderOnce();
      await mkdir(path.join(missing, "new-skill"), { recursive: true });
      await writeFile(path.join(missing, "new-skill", "SKILL.md"), "---\nname: new-skill\n---\n\nNew directory.\n");
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("New directory."));
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Directory is not approved"));
      expect(await exists(path.join(missing, ".skills-manager"))).toBe(false);
      expect(await exists(path.join(missing, "new-skill", "SKILL.md"))).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("reports host and terminal clipboard failures without losing local browsing", async () => {
    const { skillsDir } = await fixture();
    const clipboard = {
      writeText: async () => ({ host: { status: "failed" }, terminal: { status: "local-failure", capability: "unsupported" } }),
      dispose: async () => {},
    } as unknown as ClipboardService;
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await createTrackedTui(setup.renderer, await approveSkillsRoot(skillsDir), { clipboard }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Local content for selection."));
      const rows = setup.captureCharFrame().split("\n");
      const row = rows.findIndex((line) => line.includes("Local content for selection."));
      const x = rows[row]!.indexOf("Local content");
      await setup.mockMouse.drag(x, row, x + 12, row);
      await setup.waitFor(() => setup.captureCharFrame().includes("Clipboard unavailable"));
      expect(setup.captureCharFrame()).toContain("terminal: local-failure");
      expect(setup.captureCharFrame()).toContain("Selection remains available");
      expect(setup.renderer.getSelection()?.getSelectedText()).toBeTruthy();
      expect(setup.captureCharFrame()).toContain("Local content for selection.");
    } finally {
      setup.renderer.destroy();
    }
  });
});
