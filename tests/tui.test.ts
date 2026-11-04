import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { RGBA, type ClipboardService } from "@opentui/core";
import { createTestRenderer as createOpenTuiTestRenderer, MouseButtons } from "@opentui/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveSkillsRoot, fingerprintContents, type ApprovedSkillsRoot } from "../src/actions/boundary.js";
import { SkillsManagerTui } from "../src/tui.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function createTestRenderer(options: Parameters<typeof createOpenTuiTestRenderer>[0]) {
  const setup = await createOpenTuiTestRenderer(options);
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

async function fixture(): Promise<{ home: string; skillsDir: string }> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "skills-manager-tui-")));
  roots.push(home);
  const skillsDir = path.join(home, "chosen-skills");
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

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SkillsManagerTui", () => {
  it("browses the selected directory without network or adoption writes on startup and reload", async () => {
    const { skillsDir } = await fixture();
    const rootBefore = await lstat(skillsDir);
    const fileBefore = await lstat(path.join(skillsDir, "alpha", "SKILL.md"));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      const app = new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir));
      await app.start();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("[on] [unknown] alpha");
      expect(frame).toContain("Source: unknown");
      expect(frame).toContain("Author: Ada, Grace");
      expect(frame).toContain("Entry: directory");
      expect(frame).toContain(`Directory: "${skillsDir}"`);
      expect(frame).toContain("No Git repository at selected directory.");
      expect(frame).not.toContain("local (mine)");
      expect(frame).toContain("[off] [unknown] beta");
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

  it("escapes terminal controls and distinguishes literal path escapes in captured frames", async () => {
    const { home, skillsDir } = await fixture();
    const newlineRoot = path.join(home, "choice\nname");
    const backslashRoot = path.join(home, "choice\\nname");
    await rename(skillsDir, newlineRoot);
    await writeFile(path.join(newlineRoot, "alpha", "SKILL.md"),
      '---\nname: alpha\nauthor: "Ada\\u001B]0;META\\u0007"\n---\n\nBody \x1b]0;BODY\x07.\n');
    await mkdir(path.join(backslashRoot, "gamma"), { recursive: true });
    await writeFile(path.join(backslashRoot, "gamma", "SKILL.md"), "---\nname: gamma\n---\n\nOther root.\n");
    const setup = await createTestRenderer({ width: 200, height: 40 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(newlineRoot), {
        selectSkillsDir: async () => ({ root: await approveSkillsRoot(backslashRoot), reviewInitialize: false, reviewBackup: false }),
      }).start();
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
      await setup.mockInput.typeText("i");
      await setup.waitFor(() => setup.captureCharFrame().includes("Other root."));
      expect(setup.captureCharFrame()).toContain(`Directory: "${path.join(home, "choice\\\\nname")}"`);
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
      await new SkillsManagerTui(setup.renderer, approved).start();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Git unavailable");
      expect(frame).not.toContain("0 changed skill paths");
      expect(frame).not.toContain("No Git repository at selected directory.");
      expect(frame).toContain("Alpha body");
      await setup.mockInput.typeText("]");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders contiguous highlighted controls in captured frames and supports alternate file navigation", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("scope: all · state: all");
      expect(frame).not.toContain("s cope: all");
      expect(frame).not.toContain("s tate: all");
      expect(frame).toContain("scope · enabled");
      expect(frame).not.toContain("s cope");
      expect(frame).not.toContain("e nabled");
      expect(frame).toContain("space enable/disable");
      expect(frame).toContain("Markdown · toggle rendering");
      expect(frame).not.toContain("t oggle rendering");
      expect(frame).toContain("Files · [ ] navigate");
      const spans = setup.captureSpans().lines;
      const header = spans.find((line) => line.spans.map((span) => span.text).join("").includes("scope · enabled"));
      expect(header?.spans.some((span) => span.text === "s" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      expect(header?.spans.some((span) => span.text === "e" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      const toggle = spans.find((line) => line.spans.map((span) => span.text).join("").includes("Markdown · toggle rendering"));
      expect(toggle?.spans.some((span) => span.text === "t" && span.fg.equals(RGBA.fromHex("#C6A0F6")))).toBe(true);
      await setup.mockInput.typeText("]");
      await setup.waitFor(() => setup.captureCharFrame().includes("Notes from the selected file."));
      await setup.mockInput.typeText("t");
      await setup.waitFor(() => setup.captureCharFrame().includes("Raw · toggle rendering"));
      await setup.mockInput.typeText("[");
      await setup.waitFor(() => setup.captureCharFrame().includes("Alpha body"));
      await setup.mockInput.typeText("/alpha");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("scope: all · state: all · filter: alpha"));
      expect(setup.captureCharFrame()).not.toContain("f ilter: alpha");
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("[off] [unknown] beta"));
      let rows = setup.captureCharFrame().split("\n");
      let row = rows.findIndex((line) => line.includes("[on] [unknown] broken"));
      expect(row).toBeGreaterThanOrEqual(0);
      await setup.mockMouse.click(rows[row]!.indexOf("broken"), row);
      await setup.waitFor(() => setup.captureCharFrame().includes('broken-symlink -> "missing-target"'));
      expect(setup.captureCharFrame()).toContain("Author: unknown");
      expect(setup.captureCharFrame()).toContain("Source: unknown");
      expect(setup.captureCharFrame()).toContain("Warning:");
      rows = setup.captureCharFrame().split("\n");
      row = rows.findIndex((line) => line.includes("[on] [unknown] invalid"));
      await setup.mockMouse.click(rows[row]!.indexOf("invalid"), row);
      await setup.waitFor(() => setup.captureCharFrame().includes("Warning:"));
      expect(setup.captureCharFrame()).toContain("Author: unknown");
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText(" ");
      await setup.waitFor(() => setup.captureCharFrame().includes("Disable skill"));
      expect(confirmationText(setup.captureCharFrame(), "Disable skill")).toContain(`From: "${path.join(skillsDir, "alpha")}"`);
      expect(confirmationText(setup.captureCharFrame(), "Disable skill")).toContain(`To: "${path.join(skillsDir, ".disabled_skills", "alpha")}"`);
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remove skill"));
      expect(confirmationText(setup.captureCharFrame(), "Remove skill")).toContain(`Path: "${path.dirname(file)}"`);
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
      await new SkillsManagerTui(setup.renderer, approved).start();
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
      await new SkillsManagerTui(setup.renderer, approved).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      let rows = setup.captureCharFrame().split("\n");
      let row = rows.findIndex((line) => line.includes("[on] [unknown] linked"));
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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

  it.each(["u", "p", "v"])("reviews saved source and cancels without contact for %s", async (key) => {
    const { skillsDir } = await fixture();
    await savedSourceFixture(skillsDir);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText(key);
      await setup.waitFor(() => setup.captureCharFrame().includes("Review saved sources"));
      const review = confirmationText(setup.captureCharFrame(), "Review saved sources");
      expect(review).toContain('Source: "example/project"');
      expect(review).toContain('URL: "https://github.com/example/project"');
      expect(review).toContain('Ref: "release/v1"');
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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

  it("checks only the source and ref captured before approval even if the receipt changes", async () => {
    const { skillsDir } = await fixture();
    const { file, receipt } = await savedSourceFixture(skillsDir);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sha: "a".repeat(40), tree: [] }), { status: 200 }));
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("v");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review saved sources"));
      await writeFile(file, JSON.stringify({ ...receipt, entry: { ...receipt.entry, source: "other/project", sourceUrl: "https://github.com/other/project", ref: "other" } }));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Update check"));
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]![0]).toBe("https://api.github.com/repos/example/project/git/trees/release%2Fv1?recursive=1");
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText(key);
      await setup.waitFor(() => setup.captureCharFrame().includes("Review saved sources"));
      expect(confirmationText(setup.captureCharFrame(), "Review saved sources")).toContain(`URL: "${url}"`);
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("v");
      await setup.waitFor(() => setup.captureCharFrame().includes("Update check"));
      expect(setup.captureCharFrame()).toContain("some checks were unavailable");
      expect(setup.captureCharFrame()).toContain("alpha: unavailable");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("previews leaf Git initialization and cancels by default", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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

  it("makes requested onboarding init and backup distinct reviews and reports declined initialization", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), {
        initialOnboarding: { reviewInitialize: true, reviewBackup: true },
      }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Initialize Git"));
      expect(confirmationText(setup.captureCharFrame(), "Initialize Git")).toContain(`Selected directory: "${skillsDir}"`);
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Backup unavailable: initialize the selected leaf repository first."));
      expect(setup.captureCharFrame()).not.toContain("Remote name:");
      expect(await exists(path.join(skillsDir, ".git"))).toBe(false);
      expect(await exists(path.join(skillsDir, ".skills-manager"))).toBe(false);
      expect(await readFile(path.join(skillsDir, "alpha", "SKILL.md"), "utf8")).toContain("Alpha body");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("offers reviewed remote setup only after separately approved initialization", async () => {
    const { skillsDir } = await fixture();
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), {
        initialOnboarding: { reviewInitialize: true, reviewBackup: true },
      }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Initialize Git"));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote name:"));
      expect(await exists(path.join(skillsDir, ".git"))).toBe(true);
      await setup.mockInput.typeText("backup");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote URL:"));
      await setup.mockInput.typeText("https://person:secret-token@example.invalid/private/repo.git");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Add backup remote"));
      expect(setup.captureCharFrame()).toContain("example.invalid/private/repo.git");
      expect(setup.captureCharFrame()).not.toContain("secret-token");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Add backup remote"));
      expect(await git(skillsDir, "remote")).toBe("");
      await expect(git(skillsDir, "rev-parse", "--verify", "HEAD")).rejects.toThrow();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("opens an existing backup destination for push review without making a network request", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await git(skillsDir, "remote", "add", "backup", "https://person:secret-token@example.invalid/private/repo.git");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), {
        initialOnboarding: { reviewInitialize: false, reviewBackup: true },
      }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review push"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("example.invalid/private/repo.git");
      expect(frame).toContain("fixture skill commit");
      expect(frame).not.toContain("secret-token");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review push"));
      expect(await git(skillsDir, "remote")).toBe("backup");
      expect(await git(skillsDir, "rev-parse", "HEAD")).toBeTruthy();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("does not choose an arbitrary existing backup remote during onboarding", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await commitFixture(skillsDir);
    await git(skillsDir, "remote", "add", "first", "https://example.invalid/first.git");
    await git(skillsDir, "remote", "add", "second", "https://example.invalid/second.git");
    const before = await git(skillsDir, "rev-parse", "HEAD");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), {
        initialOnboarding: { reviewInitialize: false, reviewBackup: true },
      }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Backup review unavailable:"));
      expect(setup.captureCharFrame()).toContain("Select one configured remote explicitly");
      expect(setup.captureCharFrame()).toContain("configure an unambiguous branch remote or upstream");
      expect(setup.captureCharFrame()).not.toContain("Review push");
      expect(await git(skillsDir, "remote")).toBe("first\nsecond");
      expect(await git(skillsDir, "rev-parse", "HEAD")).toBe(before);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("explains the first-commit prerequisite for an existing backup remote", async () => {
    const { skillsDir } = await fixture();
    await initGit(skillsDir);
    await git(skillsDir, "remote", "add", "backup", "https://example.invalid/private/repo.git");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), {
        initialOnboarding: { reviewInitialize: false, reviewBackup: true },
      }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Backup review unavailable:"));
      expect(setup.captureCharFrame()).toContain("Create a first commit");
      expect(setup.captureCharFrame()).not.toContain("Review push");
      await expect(git(skillsDir, "rev-parse", "--verify", "HEAD")).rejects.toThrow();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps missing-root onboarding intents read-only with a visible prerequisite", async () => {
    const { home } = await fixture();
    const missing = path.join(home, "missing-skills");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, { path: missing, identity: null }, {
        initialOnboarding: { reviewInitialize: true, reviewBackup: true },
      }).start();
      await setup.waitFor(() => setup.captureCharFrame().includes("Git setup and backup are unavailable"));
      expect(setup.captureCharFrame()).toContain("create the selected directory and reselect it first");
      expect(setup.captureCharFrame()).not.toContain("Initialize Git");
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("n");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote name:"));
      await setup.mockInput.typeText("backup");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Remote URL:"));
      await setup.mockInput.typeText("https://person:secret-token@example.invalid/private/repo.git");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Add backup remote"));
      const preview = setup.captureCharFrame();
      expect(preview).toContain("backup");
      expect(preview).toContain("example.invalid/private/repo.git");
      expect(preview).not.toContain("secret-token");
      expect(preview).not.toContain("person:");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Add backup remote"));
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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

  it("reports a containing repository and cannot commit or initialize its tracked child", async () => {
    const { home, skillsDir } = await fixture();
    await initGit(home);
    await writeFile(path.join(home, "sentinel.txt"), "outside selected repository\n");
    await git(home, "add", "--", "sentinel.txt", "chosen-skills/alpha/SKILL.md");
    const staged = await git(home, "diff", "--cached", "--name-only");
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Containing repository:");
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Git actions require"));
      await setup.mockInput.typeText("i");
      await setup.waitFor(() => setup.captureCharFrame().includes("Git initialization blocked"));
      expect(setup.captureCharFrame()).toContain("Parent tracks selected paths: yes");
      setup.mockInput.pressEnter();
      expect(await git(home, "diff", "--cached", "--name-only")).toBe(staged);
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("(unborn)");
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("c");
      await setup.waitFor(() => setup.captureCharFrame().includes("Commit message:"));
      await setup.mockInput.typeText("first reviewed commit");
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
      await setup.mockInput.typeText("first reviewed commit");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes("Review commit"));
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Review commit"));
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir)).start();
      await setup.mockInput.typeText("g");
      await setup.waitFor(() => setup.captureCharFrame().includes("Working tree"));
      await setup.mockInput.typeText("p");
      await setup.waitFor(() => setup.captureCharFrame().includes("Review push"));
      expect(setup.captureCharFrame()).toContain(bare);
      await setup.mockInput.typeText("y");
      await setup.waitFor(() => setup.captureCharFrame().includes("Check provider access"));
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

  it("revisits installation selection without changing the old installation", async () => {
    const { home, skillsDir } = await fixture();
    const other = path.join(home, "other-skills");
    await mkdir(path.join(other, "gamma"), { recursive: true });
    await writeFile(path.join(other, "gamma", "SKILL.md"), "---\nname: gamma\n---\n\nGamma-only content.\n");
    const original = await readFile(path.join(skillsDir, "alpha", "SKILL.md"), "utf8");
    const { promise: pending, resolve: finish } = Promise.withResolvers<ApprovedSkillsRoot | null>();
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), {
        selectSkillsDir: async () => {
          const root = await pending;
          return root ? { root, reviewInitialize: false, reviewBackup: false } : null;
        },
      }).start();
      await setup.mockInput.typeText("i");
      await setup.mockInput.typeText(" ");
      finish(await approveSkillsRoot(other));
      await setup.waitFor(() => setup.captureCharFrame().includes("Gamma-only content."));
      const frame = setup.captureCharFrame();
      expect(frame).toContain(`Directory: "${other}"`);
      expect(frame).not.toContain("[on] [unknown] alpha");
      expect(await readFile(path.join(skillsDir, "alpha", "SKILL.md"), "utf8")).toBe(original);
      expect(await exists(path.join(skillsDir, ".skills-manager"))).toBe(false);
      expect(await exists(path.join(other, ".skills-manager"))).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("honors new setup intent when reselecting the same approved directory", async () => {
    const { skillsDir } = await fixture();
    const root = await approveSkillsRoot(skillsDir);
    const setup = await createTestRenderer({ width: 200, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, root, {
        selectSkillsDir: async () => ({ root, reviewInitialize: true, reviewBackup: false }),
      }).start();
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

  it("discards an old installation's delayed opener result after reselection", async () => {
    const { home, skillsDir } = await fixture();
    const other = path.join(home, "next-skills");
    await mkdir(path.join(other, "gamma"), { recursive: true });
    await writeFile(path.join(other, "gamma", "SKILL.md"), "---\nname: gamma\n---\n\nNext installation only.\n");
    const next = await approveSkillsRoot(other);
    const { promise, resolve } = Promise.withResolvers<void>();
    const opener = vi.fn(async () => promise);
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), {
        fileOpener: opener,
        selectSkillsDir: async () => ({ root: next, reviewInitialize: false, reviewBackup: false }),
      }).start();
      await setup.mockInput.typeText("o");
      expect(opener).toHaveBeenCalledOnce();
      await setup.mockInput.typeText("i");
      await setup.waitFor(() => setup.captureCharFrame().includes("Next installation only."));
      resolve();
      await delay(20);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Opened SKILL.md.");
      expect(setup.captureCharFrame()).toContain(`Directory: "${other}"`);
    } finally {
      resolve();
      setup.renderer.destroy();
    }
  });

  it("keeps a missing root read-only until the same path is created and reselected", async () => {
    const { home } = await fixture();
    const missing = path.join(home, "future-skills");
    const setup = await createTestRenderer({ width: 180, height: 30 });
    try {
      await new SkillsManagerTui(setup.renderer, { path: missing, identity: null }, {
        selectSkillsDir: async () => ({ root: await approveSkillsRoot(missing), reviewInitialize: false, reviewBackup: false }),
      }).start();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("create it and reselect");
      await mkdir(path.join(missing, "new-skill"), { recursive: true });
      await writeFile(path.join(missing, "new-skill", "SKILL.md"), "---\nname: new-skill\n---\n\nNew directory.\n");
      await setup.mockInput.typeText("r");
      await setup.waitFor(() => setup.captureCharFrame().includes("New directory."));
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Directory is not approved"));
      expect(await exists(path.join(missing, ".skills-manager"))).toBe(false);
      await setup.mockInput.typeText("i");
      await setup.waitFor(() => !setup.captureCharFrame().includes("Directory is not approved"));
      await setup.mockInput.typeText("d");
      await setup.waitFor(() => setup.captureCharFrame().includes("Remove skill"));
      expect(confirmationText(setup.captureCharFrame(), "Remove skill")).toContain(`Path: "${path.join(missing, "new-skill")}"`);
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !setup.captureCharFrame().includes("Remove skill"));
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
      await new SkillsManagerTui(setup.renderer, await approveSkillsRoot(skillsDir), { clipboard }).start();
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
