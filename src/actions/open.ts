import { resolve } from "node:path";
import { execa } from "execa";

type FileOpener = (target: string) => Promise<unknown>;

async function openTarget(target: string, displayTarget: string): Promise<void> {
  const commands: Array<[string, string[]]> = process.platform === "darwin"
    ? [["open", [target]]]
    : process.platform === "linux"
      ? [["xdg-open", [target]], ["gio", ["open", target]]]
      : [];

  for (const [command, args] of commands) {
    try {
      await execa(command, args);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Could not open ${displayTarget}.`);
    }
  }
  throw new Error(`No supported opener available for ${displayTarget}.`);
}

export async function openFile(filePath: string, open?: FileOpener): Promise<void> {
  const target = resolve(filePath);
  if (open) {
    await open(target);
    return;
  }
  await openTarget(target, JSON.stringify(target));
}

export async function openRepository(sourceUrl: string, openUrl?: FileOpener): Promise<void> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("Invalid source URL; expected an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported source URL scheme; expected HTTP(S).");
  }
  if (url.username || url.password) {
    throw new Error("Source URLs containing credentials cannot be opened.");
  }

  const safeUrl = new URL(url);
  safeUrl.username = "";
  safeUrl.password = "";
  safeUrl.search = "";
  safeUrl.hash = "";
  if (openUrl) {
    await openUrl(url.href);
    return;
  }
  await openTarget(url.href, JSON.stringify(safeUrl.href));
}
