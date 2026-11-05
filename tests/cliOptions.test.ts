import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { helpText, parseCliOptions, runtimeError } from "../src/cliOptions.js";

describe("CLI options", () => {
  it("leaves selection to startup unless --skills-dir selects a path directly", () => {
    expect(parseCliOptions([])).toEqual({ help: false });
    expect(parseCliOptions(["--skills-dir", "./project/skills"])).toEqual({ help: false, skillsDir: "./project/skills" });
    expect(parseCliOptions(["--skills-dir=-unusual"])).toEqual({ help: false, skillsDir: "-unusual" });
    expect(helpText).toContain("Reuse saved setup for an unchanged directory; otherwise choose a directory.");
    expect(helpText).not.toContain("--agent-root");
  });

  it("recognizes help without requiring a skills directory", () => {
    expect(parseCliOptions(["--help"])).toEqual({ help: true });
    expect(parseCliOptions(["-h"])).toEqual({ help: true });
  });

  it("prints help and argument errors before opening the terminal", () => {
    const env = { ...process.env, OPENTUI_LIBC: "invalid", OTUI_ASSET_ROOT: "/nonexistent-skills-manager-assets" };
    const help = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], { encoding: "utf8", env });
    expect(help.error).toBeUndefined();
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: skills-manager");
    expect(help.stderr).not.toContain("OPENTUI_LIBC");
    expect(help.stdout).toContain("Application and skills CLI updates have separate manual checks.");
    expect(help.stdout).toContain("Background checks are separately opt-in and off by default.");
    expect(help.stdout).not.toContain("Network actions are manual");
    expect(help.stderr).not.toContain("Missing OpenTUI asset");

    const missing = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--skills-dir"], { encoding: "utf8", env });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("--skills-dir requires a path");
    const oldOption = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--agent-root", "/tmp/root"], { encoding: "utf8", env });
    expect(oldOption.status).toBe(2);
    expect(oldOption.stderr).toContain("Unknown option: --agent-root");
  });

  it("escapes control characters in displayed invalid arguments", () => {
    const payload = "\x1b]52;c;cHdu\x07\n\u009b31m\u202e";
    for (const [argument, prefix] of [[`--${payload}`, "Unknown option: --"], [`value${payload}`, "Unexpected argument: value"]]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", argument], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${prefix}${String.raw`\x1b]52;c;cHdu\x07\n\x9b31m\u202e`}`);
      expect(result.stderr).not.toMatch(/[\x1b\x07\u009b\u202e]/);
    }
  });

  it("reports malformed and obsolete arguments", () => {
    expect(() => parseCliOptions(["--skills-dir"])).toThrow("--skills-dir requires a path");
    expect(() => parseCliOptions(["--skills-dir", "--help"])).toThrow("--skills-dir requires a path");
    expect(() => parseCliOptions(["--skills-dir="])).toThrow("--skills-dir requires a path");
    expect(() => parseCliOptions(["--skills-dir=a", "--skills-dir=b"])).toThrow("may only be specified once");
    expect(() => parseCliOptions(["--agent-root", "/tmp/root"])).toThrow("Unknown option: --agent-root");
    expect(() => parseCliOptions(["unexpected"])).toThrow("Unexpected argument: unexpected");
  });

  it("gives clear supported-platform and Node runtime requirements", () => {
    expect(runtimeError("darwin", "arm64", "26.13.0")).toBeUndefined();
    expect(runtimeError("linux", "x64", "26.14.0", "2.39")).toBeUndefined();
    expect(runtimeError("win32", "x64", "26.13.0")).toContain("Windows");
    expect(runtimeError("linux", "riscv64", "26.13.0")).toContain("Unsupported architecture");
    expect(runtimeError("linux", "arm64", "26.12.0")).toContain("Node.js >=26.13.0 <27");
    expect(runtimeError("linux", "arm64", "27.0.0")).toContain("Node.js >=26.13.0 <27");
    expect(runtimeError("linux", "arm64", "26.13.0")).toContain("requires glibc");
  });
});
