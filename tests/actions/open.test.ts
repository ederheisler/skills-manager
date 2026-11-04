import { describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openFile, openRepository } from "../../src/actions/open.js";

async function withOpeners(
  platform: "darwin" | "linux",
  scripts: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "skills-open-"));
  const previousPath = process.env.PATH;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const [name, script] of Object.entries(scripts)) {
      await writeFile(join(directory, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    }
    process.env.PATH = directory;
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    await run(directory);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

describe("platform opener", () => {
  it.each(["darwin", "linux"] as const)("opens a file safely on %s", async (platform) => {
    const command = platform === "darwin" ? "open" : "xdg-open";
    await withOpeners(platform, {
      [command]: '[ "$#" -eq 1 ] && [ "$1" = "$EXPECTED_TARGET" ] && : > "$OPEN_MARKER"',
    }, async (directory) => {
      const target = join(directory, "skill with spaces; touch injected.md");
      const marker = join(directory, "opened");
      process.env.EXPECTED_TARGET = target;
      process.env.OPEN_MARKER = marker;
      try {
        await openFile(target);
        await expect(access(marker)).resolves.toBeUndefined();
        await expect(access(join(directory, "injected.md"))).rejects.toThrow();
      } finally {
        delete process.env.EXPECTED_TARGET;
        delete process.env.OPEN_MARKER;
      }
    });
  });

  it("uses gio when xdg-open is absent and opens a non-GitHub source URL", async () => {
    await withOpeners("linux", {
      gio: '[ "$#" -eq 2 ] && [ "$1" = open ] && [ "$2" = "$EXPECTED_TARGET" ] && : > "$OPEN_MARKER"',
    }, async (directory) => {
      const marker = join(directory, "opened");
      process.env.EXPECTED_TARGET = "https://gitlab.example/team/project";
      process.env.OPEN_MARKER = marker;
      try {
        await openRepository(process.env.EXPECTED_TARGET);
        await expect(access(marker)).resolves.toBeUndefined();
      } finally {
        delete process.env.EXPECTED_TARGET;
        delete process.env.OPEN_MARKER;
      }
    });
  });

  it("reports an opener failure rather than falling back after a nonzero exit", async () => {
    await withOpeners("linux", {
      "xdg-open": "exit 7",
      gio: ': > "$OPEN_MARKER"',
    }, async (directory) => {
      const marker = join(directory, "fallback");
      process.env.OPEN_MARKER = marker;
      try {
        await expect(openFile(join(directory, "skill.md"))).rejects.toThrow(/could not open/i);
        await expect(access(marker)).rejects.toThrow();
      } finally {
        delete process.env.OPEN_MARKER;
      }
    });
  });

  it("rejects source URLs containing credentials without revealing them", async () => {
    const error: unknown = await openRepository("https://user:secret@gitlab.example/team/project")
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected credentials to be rejected");
    expect(error.message).toMatch(/credentials/i);
    expect(error.message).not.toContain("secret");
  });

  it("reports a missing file opener with the usable path", async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), "skills-open-"));
    const previousPath = process.env.PATH;
    process.env.PATH = emptyPath;
    const file = join(emptyPath, "skill with spaces; not a command.md");
    try {
      await expect(openFile(file)).rejects.toThrow(resolve(file));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(emptyPath, { recursive: true, force: true });
    }
  });

  it("reports a missing source opener without exposing the URL query", async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), "skills-open-"));
    const previousPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      const error: unknown = await openRepository("https://gitlab.example/team/project?token=secret")
        .then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected the opener to fail");
      expect(error.message).toContain("https://gitlab.example/team/project");
      expect(error.message).not.toContain("secret");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(emptyPath, { recursive: true, force: true });
    }
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "ssh://git@example.com/repo", "owner/repository"])(
    "rejects a non-web source %s without opening it",
    async (source) => {
      await expect(openRepository(source)).rejects.toThrow(/unsupported|invalid/i);
    },
  );
});
