#!/usr/bin/env node
import { helpText, parseCliOptions, runtimeError, type CliOptions } from "./cliOptions.js";
import { escapeTerminalSingleLine } from "./terminalText.js";
import type { DirectorySelectionOptions, OnboardingIO, SkillsOnboardingResult } from "./onboarding.js";

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`skills-manager: ${escapeTerminalSingleLine(error instanceof Error ? error.message : String(error))}\nRun skills-manager --help for usage.\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(helpText);
    return;
  }

  let glibcVersion: string | undefined;
  if (process.platform === "linux" && process.report) {
    // Older Node type declarations omit the supported excludeNetwork option.
    const report = process.report as typeof process.report & { excludeNetwork?: boolean };
    const previousNetwork = report.excludeNetwork;
    const previousEnv = report.excludeEnv;
    try {
      report.excludeNetwork = true;
      report.excludeEnv = true;
      const diagnostic = report.getReport();
      if ("header" in diagnostic && diagnostic.header !== null && typeof diagnostic.header === "object"
        && "glibcVersionRuntime" in diagnostic.header && typeof diagnostic.header.glibcVersionRuntime === "string") {
        glibcVersion = diagnostic.header.glibcVersionRuntime;
      }
    } finally {
      report.excludeNetwork = previousNetwork;
      report.excludeEnv = previousEnv;
    }
  }
  const unsupported = runtimeError(process.platform, process.arch, process.versions.node, glibcVersion);
  if (unsupported !== undefined) {
    process.stderr.write(`skills-manager: ${escapeTerminalSingleLine(unsupported)}\n`);
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("skills-manager: an interactive terminal is required. Run skills-manager --help for usage.\n");
    process.exitCode = 1;
    return;
  }

  const [{ createInterface }, { selectSkillsDirectory }] = await Promise.all([
    import("node:readline/promises"),
    import("./onboarding.js"),
  ]);

  const select = async (selection: DirectorySelectionOptions): Promise<SkillsOnboardingResult | null> => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    reader.on("SIGINT", () => controller.abort());
    reader.on("close", () => controller.abort());
    const io: OnboardingIO = {
      async ask(prompt) {
        try {
          return await reader.question(prompt, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) return null;
          throw error;
        }
      },
      write(message) {
        process.stdout.write(message);
      },
    };
    try {
      return await selectSkillsDirectory(io, selection);
    } finally {
      reader.close();
    }
  };

  const onboarding = await select({ explicitSkillsDir: options.skillsDir });
  if (onboarding === null) return;

  const [{ createCliRenderer }, { SkillsManagerTui }] = await Promise.all([
    import("@opentui/core"),
    import("./tui.js"),
  ]);
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  try {
    const app = new SkillsManagerTui(renderer, onboarding.root, {
      initialOnboarding: { reviewInitialize: onboarding.reviewInitialize, reviewBackup: onboarding.reviewBackup },
      selectSkillsDir: (currentSkillsDir) => select({ currentSkillsDir }),
    });
    await app.start();
  } catch (error) {
    renderer.destroy();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`skills-manager: ${escapeTerminalSingleLine(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}
