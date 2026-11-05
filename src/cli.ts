#!/usr/bin/env node
import { helpText, parseCliOptions, runtimeError, type CliOptions } from "./cliOptions.js";
import { escapeTerminalSingleLine, quoteTerminalPath } from "./terminalText.js";
import type { DirectorySelectionOptions, OnboardingIO, SkillsOnboardingResult } from "./onboarding.js";

function errorText(error: unknown): string {
  return escapeTerminalSingleLine(error instanceof Error ? error.message : String(error));
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`skills-manager: ${errorText(error)}\nRun skills-manager --help for usage.\n`);
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

  const [{ createInterface }, { selectSavedSkillsDirectory }] = await Promise.all([
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
      return await selectSavedSkillsDirectory(io, selection);
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
  let rendererDestroyed = renderer.isDestroyed;
  renderer.once("destroy", () => { rendererDestroyed = true; });
  let app: InstanceType<typeof SkillsManagerTui> | undefined;
  try {
    app = new SkillsManagerTui(renderer, onboarding.root, {
      initialOnboarding: { reviewInitialize: onboarding.reviewInitialize },
      selectSkillsDir: (currentSkillsDir) => select({ currentSkillsDir }),
    });
    await app.start();
    const outcome = await app.waitForExit();
    if (outcome === null) {
      await app.shutdown();
      return;
    }

    let handoffFailure: { error: unknown } | undefined;
    try {
      await app.shutdown();
      if (!rendererDestroyed && !renderer.isDestroyed) {
        // Load only after approval so a missing handoff module can report manual recovery.
        const { executeUpdateHandoff } = await import("./actions/appUpdateHandoff.js");
        if (!rendererDestroyed && !renderer.isDestroyed) {
          renderer.destroy();
          executeUpdateHandoff(outcome.prepared);
          throw new Error("Update process replacement returned unexpectedly.");
        }
      }
    } catch (error) {
      handoffFailure = { error };
      try {
        renderer.destroy();
      } catch (destroyError) {
        process.stderr.write(`skills-manager: Renderer cleanup failed: ${errorText(destroyError)}\n`);
      }
    }

    try {
      await outcome.prepared.cleanup();
    } catch (error) {
      process.stderr.write(`skills-manager: Could not clean update workspace ${quoteTerminalPath(outcome.prepared.workspace)}: ${errorText(error)}\n`);
      process.exitCode = 1;
    }
    if (handoffFailure) {
      process.stderr.write(`skills-manager: Application update could not start: ${errorText(handoffFailure.error)}\nTo start the app again, run:\n${escapeTerminalSingleLine(outcome.recoveryCommand)}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    let shutdownFailure: { error: unknown } | undefined;
    if (app) {
      try {
        await app.shutdown();
      } catch (cleanupError) {
        shutdownFailure = { error: cleanupError };
      }
    }
    try {
      renderer.destroy();
    } catch (destroyError) {
      process.stderr.write(`skills-manager: Renderer cleanup failed: ${errorText(destroyError)}\n`);
    }
    if (shutdownFailure && shutdownFailure.error !== error) {
      process.stderr.write(`skills-manager: Application cleanup failed: ${errorText(shutdownFailure.error)}\n`);
    }
    throw error;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`skills-manager: ${errorText(error)}\n`);
  process.exitCode = 1;
}
