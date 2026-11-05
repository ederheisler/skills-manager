import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasErrorCode, isRecord } from "./validation.js";

/** Recognition hints only; they never authorize a filesystem or network action. */
export interface SavedSetup {
  kind: "skills-manager-setup";
  version: 1;
  selectedPath: string;
  canonicalRoot: string;
  identity: string | null;
}

const MAX_STATE_BYTES = 16 * 1024;
const INSTALL_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function configDirectory(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? path.resolve(xdg) : path.join(home, ".config"), "skills-manager");
}

function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}

// Resolve existing ancestors without creating the not-yet-existing suffix.
async function canonicalCandidate(location: string): Promise<string> {
  let current = location;
  const suffix: string[] = [];
  for (;;) {
    try {
      await lstat(current);
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw Object.assign(new Error("Dangling symbolic link in setup storage"), { code: "EDANGLING" });
        }
      } catch (linkError) {
        if (!hasErrorCode(linkError, "ENOENT")) throw linkError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function validatePrivateStat(info: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number; nlink: number }, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0
    || (!directory && info.nlink !== 1)) {
    throw new Error("Unsafe private setup storage");
  }
}

async function assertSafeStorage(directory: string, roots: readonly string[]): Promise<boolean> {
  const locations = [path.resolve(directory), await canonicalCandidate(directory)];
  const protectedRoots = [INSTALL_ROOT, ...roots];
  for (const root of protectedRoots) {
    const candidates = [path.resolve(root)];
    try {
      candidates.push(await canonicalCandidate(root));
    } catch (error) {
      // A formerly selected path may no longer name a directory. Its lexical
      // path and separately stored canonical root still count; permission
      // errors, however, must not be treated as a safe physical resolution.
      if (root === INSTALL_ROOT || !["EDANGLING", "ENOENT", "ENOTDIR", "ELOOP"].some((code) => hasErrorCode(error, code))) throw error;
    }
    if (locations.some((location) => candidates.some((candidate) => overlaps(location, candidate)))) {
      throw new Error("Setup storage overlaps a skills directory or the application installation");
    }
  }
  try {
    validatePrivateStat(await lstat(directory), true);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function parseSavedSetup(value: unknown): SavedSetup {
  if (!isRecord(value) || Object.keys(value).length !== 5
    || value.kind !== "skills-manager-setup" || value.version !== 1
    || typeof value.selectedPath !== "string" || !path.isAbsolute(value.selectedPath) || value.selectedPath.includes("\0")
    || typeof value.canonicalRoot !== "string" || !path.isAbsolute(value.canonicalRoot)
    || value.canonicalRoot.includes("\0") || path.resolve(value.canonicalRoot) !== value.canonicalRoot
    || !(value.identity === null || (typeof value.identity === "string" && /^[a-f0-9]{64}$/.test(value.identity)))) {
    throw new Error("Invalid or unrelated saved setup");
  }
  return {
    kind: "skills-manager-setup", version: 1, selectedPath: value.selectedPath,
    canonicalRoot: value.canonicalRoot, identity: value.identity,
  };
}

interface StateFile {
  setup: SavedSetup;
  text: string;
  dev: number;
  ino: number;
}

async function readState(directory: string, roots: readonly string[]): Promise<StateFile | null> {
  if (!(await assertSafeStorage(directory, roots))) return null;
  const file = path.join(directory, "config.json");
  let before;
  try { before = await lstat(file); }
  catch (error) { if (hasErrorCode(error, "ENOENT")) return null; throw error; }
  validatePrivateStat(before, false);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    validatePrivateStat(actual, false);
    if (before.dev !== actual.dev || before.ino !== actual.ino || actual.size > MAX_STATE_BYTES) {
      throw new Error("Saved setup changed or is too large");
    }
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > MAX_STATE_BYTES) throw new Error("Saved setup is too large");
    const after = await handle.stat();
    validatePrivateStat(after, false);
    if (actual.dev !== after.dev || actual.ino !== after.ino || actual.size !== after.size
      || actual.mtimeMs !== after.mtimeMs || actual.ctimeMs !== after.ctimeMs) {
      throw new Error("Saved setup changed while being read");
    }
    const bytes = buffer.subarray(0, bytesRead);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Saved setup is not valid UTF-8");
    const setup = parseSavedSetup(JSON.parse(text) as unknown);
    await assertSafeStorage(directory, [...roots, setup.selectedPath, setup.canonicalRoot]);
    return { setup, text, dev: actual.dev, ino: actual.ino };
  } finally {
    await handle.close();
  }
}

export async function readSavedSetup(home: string, roots: readonly string[]): Promise<SavedSetup | null> {
  return (await readState(configDirectory(home), roots))?.setup ?? null;
}

export async function writeSavedSetup(home: string, setup: SavedSetup, roots: readonly string[], revalidate: () => Promise<void>): Promise<void> {
  const directory = configDirectory(home);
  const checked = parseSavedSetup(setup);
  const protectedRoots = [...roots, checked.selectedPath, checked.canonicalRoot];
  if (!(await assertSafeStorage(directory, protectedRoots))) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await assertSafeStorage(directory, protectedRoots))) throw new Error("Cannot create private setup storage");
  }
  // Never replace an unrelated, corrupt, or unsafe file, including one that
  // appears or changes while this selection is being saved.
  const previous = await readState(directory, protectedRoots);
  const file = path.join(directory, "config.json");
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  try {
    const text = `${JSON.stringify(checked, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("Selected path is too large to save");
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    closed = true;
    await revalidate();
    const current = await readState(directory, protectedRoots);
    if ((previous === null) !== (current === null)
      || (previous !== null && current !== null
        && (previous.dev !== current.dev || previous.ino !== current.ino || previous.text !== current.text))) {
      throw new Error("Saved setup changed while saving");
    }
    if (previous === null) {
      // Creating a previously absent destination must not replace a file that
      // appeared after the last check.
      await link(temporary, file);
      await unlink(temporary);
    } else {
      await rename(temporary, file);
    }
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
