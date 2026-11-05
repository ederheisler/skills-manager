import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildIdentity, type BuildIdentity } from "../state/appBuild.js";
import { hasErrorCode, isRecord } from "../state/validation.js";
import { resolveUpdateRegistry } from "./appUpdateHandoff.js";
import { inspectSkillsRuntime } from "./sandbox.js";

export type UpdateComponent = "app" | "cli";

export interface SoftwareUpdateCheck {
  component: UpdateComponent;
  status: "match" | "different" | "unknown" | "unavailable";
  installed: string | null;
  available: string | null;
  checkedAt: number;
  message: string;
}

export interface SoftwareUpdatePreferences { app: boolean; cli: boolean }

const COMPONENTS: UpdateComponent[] = ["app", "cli"];
const GITHUB_SCOPE = "https://api.github.com";
const GITHUB_URL = `${GITHUB_SCOPE}/repos/ederheisler/skills-manager/commits/main`;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 4096;
const LOCK_STALE_MS = 120_000;
const RETRY_MS = 1000;
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface StoredConsent { kind: "skills-manager-update-consent"; version: 1; enabled: boolean; scope: string }
interface StoredResult {
  kind: "skills-manager-update-result";
  version: 1;
  component: UpdateComponent;
  scope: string;
  checkedAt: number;
  available: string | null;
  error: string | null;
}
interface Flight { controller: AbortController; promise: Promise<void> }
interface PrivateJsonSnapshot<T = unknown> { value: T; mtimeMs: number }

function storageHome(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? path.resolve(value) : path.join(homedir(), fallback);
}

/** Resolve existing ancestors as well as the not-yet-created suffix. */
async function canonicalCandidate(location: string): Promise<string> {
  let current = path.resolve(location);
  const suffix: string[] = [];
  for (;;) {
    try {
      await lstat(current);
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      // A dangling symlink is not an absent, safe directory.
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Dangling symbolic link"); }
      catch (linkError) { if (!hasErrorCode(linkError, "ENOENT")) throw linkError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}

function validatePrivateStat(info: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number; nlink: number }, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0
    || (!directory && info.nlink !== 1)) throw new Error("Unsafe private update storage");
}

/** Open a private, bounded regular file without following a final symlink. */
async function readPrivateJsonState(file: string): Promise<PrivateJsonSnapshot | null> {
  let before;
  try { before = await lstat(file); }
  catch (error) { if (hasErrorCode(error, "ENOENT")) return null; throw error; }
  validatePrivateStat(before, false);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    validatePrivateStat(actual, false);
    if (before.dev !== actual.dev || before.ino !== actual.ino || actual.size > MAX_STATE_BYTES) {
      throw new Error("Update state changed or is too large");
    }
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > MAX_STATE_BYTES) throw new Error("Update state is too large");
    const after = await handle.stat();
    validatePrivateStat(after, false);
    if (actual.dev !== after.dev || actual.ino !== after.ino || actual.size !== after.size
      || actual.mtimeMs !== after.mtimeMs || actual.ctimeMs !== after.ctimeMs) {
      throw new Error("Update state changed while being read");
    }
    const bytes = buffer.subarray(0, bytesRead);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Invalid update state encoding");
    const value: unknown = JSON.parse(text);
    if (value === null) throw new Error("Invalid update state");
    return { value, mtimeMs: actual.mtimeMs };
  } finally { await handle.close(); }
}

async function readPrivateJson(file: string): Promise<unknown | null> {
  return (await readPrivateJsonState(file))?.value ?? null;
}

async function atomicPrivateJson(file: string, value: unknown, stillAllowed: () => boolean, publish?: (temporary: string) => Promise<void>): Promise<void> {
  try { validatePrivateStat(await lstat(file), false); }
  catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
  if (!stillAllowed()) throw new Error("Update storage authorization changed");
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    if (!stillAllowed()) throw new Error("Update storage authorization changed");
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    if (publish) await handle.sync();
    await handle.close();
    if (!stillAllowed()) throw new Error("Update storage authorization changed");
    if (publish) await publish(temporary);
    else await rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function safeRegistry(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.search || url.hash) throw new Error("Invalid registry");
  url.username = "";
  url.password = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function validInstalledVersion(value: string): boolean {
  return value !== "unknown" && value.length > 0 && Buffer.byteLength(value) <= 128
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value);
}

function attemptTimestamp(value: unknown, now: number): number | null {
  if (value === null) return null;
  if (!isRecord(value) || value.kind !== "skills-manager-update-attempt" || value.version !== 1
    || typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > now + DAY_MS) {
    throw new Error("Invalid attempt cache");
  }
  return value.at;
}

async function responseText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
      throw new Error("Response too large");
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** Separate, default-off consent and check state for the app and its bundled CLI. */
export class SoftwareUpdateService {
  readonly #onChange?: () => void;
  readonly #config = path.join(storageHome("XDG_CONFIG_HOME", ".config"), "skills-manager");
  readonly #cache = path.join(storageHome("XDG_CACHE_HOME", ".cache"), "skills-manager");
  readonly #knownRoots = new Set<string>();
  readonly #knownPhysicalRoots = new Set<string>();
  readonly #preferences: SoftwareUpdatePreferences = { app: false, cli: false };
  readonly #results: Partial<Record<UpdateComponent, SoftwareUpdateCheck>> = {};
  readonly #errors: string[] = [];
  readonly #generation: Record<UpdateComponent, number> = { app: 0, cli: 0 };
  readonly #preferenceRevision: Record<UpdateComponent, number> = { app: 0, cli: 0 };
  readonly #preferenceWrites = new Map<UpdateComponent, Promise<void>>();
  readonly #flights = new Map<UpdateComponent, Flight>();
  readonly #foreground: Record<UpdateComponent, number> = { app: 0, cli: 0 };
  readonly #checking: Record<UpdateComponent, Set<symbol>> = { app: new Set(), cli: new Set() };
  readonly #attempts: Record<UpdateComponent, number | null> = { app: null, cli: null };
  readonly #timers = new Map<UpdateComponent, { handle: ReturnType<typeof setTimeout>; at: number }>();
  readonly #background = new Set<Promise<void>>();
  #build: BuildIdentity = { version: "unknown", commit: null, dirty: false, source: "unknown" };
  #cliVersion: string | null = null;
  #registry = "";
  #registryScope = "";
  #startPromise?: Promise<void>;
  #registryRefresh?: Promise<void>;
  #disposed = false;
  #storageRevision = 0;

  constructor(skillsDir: string, options?: { onChange?: () => void }) {
    if (!skillsDir || !path.isAbsolute(skillsDir) || skillsDir.includes("\0")) throw new Error("An absolute skills directory is required.");
    this.#knownRoots.add(path.resolve(skillsDir));
    this.#onChange = options?.onChange;
  }

  get preferences(): SoftwareUpdatePreferences { return { ...this.#preferences }; }
  get results(): Readonly<Partial<Record<UpdateComponent, SoftwareUpdateCheck>>> { return { ...this.#results }; }
  get errors(): readonly string[] { return [...this.#errors]; }
  get build(): BuildIdentity { return { ...this.#build }; }
  get cliVersion(): string | null { return this.#cliVersion; }
  /** May contain npm registry credentials; pass only to the private handoff, never display or persist it. */
  get registry(): string { return this.#registry; }
  get knownSkillsRoots(): readonly string[] { return [...new Set([...this.#knownRoots, ...this.#knownPhysicalRoots])]; }

  activity(): Record<UpdateComponent, { checking: boolean; nextCheckAt: number | null; lastAttemptAt: number | null }> {
    const component = (name: UpdateComponent) => ({
      checking: this.#checking[name].size > 0,
      nextCheckAt: this.#timers.get(name)?.at ?? null,
      lastAttemptAt: this.#attempts[name],
    });
    return { app: component("app"), cli: component("cli") };
  }

  async refreshRegistry(): Promise<void> {
    if (!this.#disposed) await this.#refreshRegistry();
  }

  #notify(): void {
    if (this.#disposed) return;
    try { this.#onChange?.(); } catch { /* UI callbacks must not break update state. */ }
  }
  #beginChecking(component: UpdateComponent): symbol {
    const token = Symbol();
    this.#checking[component].add(token);
    this.#notify();
    return token;
  }
  #endChecking(component: UpdateComponent, token: symbol): void {
    if (this.#checking[component].delete(token)) this.#notify();
  }
  #error(message: string): void {
    if (!this.#errors.includes(message)) {
      this.#errors.push(message);
      if (this.#errors.length > 20) this.#errors.shift();
      this.#notify();
    }
  }

  async #assertSafePaths(): Promise<void> {
    const roots = [...this.#knownPhysicalRoots];
    for (const root of this.#knownRoots) roots.push(await canonicalCandidate(root));
    roots.push(await canonicalCandidate(fileURLToPath(new URL("../../", import.meta.url))));
    const locations = await Promise.all([canonicalCandidate(this.#config), canonicalCandidate(this.#cache)]);
    if (locations.some((location) => roots.some((root) => overlaps(location, root)))) {
      throw new Error("Update storage overlaps a skills directory");
    }
    for (const directory of [this.#config, this.#cache]) {
      try { validatePrivateStat(await lstat(directory), true); }
      catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
    }
  }

  async #directory(location: string, create: boolean, stillAllowed?: () => boolean): Promise<boolean> {
    await this.#assertSafePaths();
    try { validatePrivateStat(await lstat(location), true); return true; }
    catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
    if (!create) return false;
    if (stillAllowed && !stillAllowed()) throw new Error("Update storage authorization changed");
    await mkdir(location, { recursive: true, mode: 0o700 });
    await this.#assertSafePaths();
    validatePrivateStat(await lstat(location), true);
    return true;
  }

  #scope(component: UpdateComponent): string {
    if (component === "app") return GITHUB_SCOPE;
    return this.#registryScope ? createHash("sha256").update(this.#registryScope).digest("hex") : "";
  }
  #consentFile(component: UpdateComponent): string { return path.join(this.#config, `${component}.json`); }
  #cacheKey(component: UpdateComponent): string {
    const scope = this.#scope(component);
    return scope ? createHash("sha256").update(scope).digest("hex") : "";
  }
  #cacheFile(component: UpdateComponent, kind: "attempt" | "result", key: string): string {
    return path.join(this.#cache, `${kind}-${component}-${key}.json`);
  }

  async #readResultState(file: string, component: UpdateComponent, key: string): Promise<PrivateJsonSnapshot<StoredResult> | null> {
    const state = await readPrivateJsonState(file);
    if (state === null) return null;
    const value = state.value;
    if (!isRecord(value) || Object.keys(value).length !== 7 || value.kind !== "skills-manager-update-result" || value.version !== 1
      || value.component !== component || value.scope !== key
      || typeof value.checkedAt !== "number" || !Number.isSafeInteger(value.checkedAt)
      || value.checkedAt < 0 || value.checkedAt > Date.now() + DAY_MS
      || (value.available !== null && typeof value.available !== "string")
      || (value.error !== null && (typeof value.error !== "string"
        || !/^Update check unavailable(?: \(HTTP [1-5]\d{2}\))?\.$/.test(value.error)))) {
      throw new Error("Invalid result cache");
    }
    if (value.error === null) {
      if (typeof value.available !== "string" || (component === "app"
        ? !SHA.test(value.available) : value.available.length > 128 || !VERSION.test(value.available))) {
        throw new Error("Invalid result cache");
      }
    } else if (value.available !== null) {
      throw new Error("Invalid result cache");
    }
    return {
      ...state,
      value: {
        kind: "skills-manager-update-result", version: 1, component, scope: key,
        checkedAt: value.checkedAt, available: value.available as string | null, error: value.error as string | null,
      },
    };
  }

  async #readResult(component: UpdateComponent, key: string): Promise<StoredResult | null> {
    const generation = this.#generation[component];
    const allowed = () => !this.#disposed && generation === this.#generation[component] && key === this.#cacheKey(component);
    const canonical = this.#cacheFile(component, "result", key);
    let latest: PrivateJsonSnapshot<StoredResult> | null = null;
    let latestName = path.basename(canonical);
    try { latest = await this.#readResultState(canonical, component, key); }
    catch { if (allowed()) this.#error("A saved update check result is invalid, unreadable, or unsafe."); }
    if (!allowed()) return null;
    const prefix = `result-${component}-${key}-`;
    const directory = await opendir(this.#cache);
    for await (const entry of directory) {
      if (!allowed()) break;
      if (!entry.name.startsWith(prefix)) continue;
      const match = /^(0|[1-9]\d{0,15})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/.exec(entry.name.slice(prefix.length));
      if (!match) continue;
      const checkedAt = Number(match[1]);
      if (!Number.isSafeInteger(checkedAt) || checkedAt > Date.now() + DAY_MS
        || (latest && checkedAt < latest.value.checkedAt)) continue;
      try {
        const candidate = await this.#readResultState(path.join(this.#cache, entry.name), component, key);
        if (!candidate) continue;
        if (candidate.value.checkedAt !== checkedAt) throw new Error("Invalid result cache timestamp");
        if (!latest || checkedAt > latest.value.checkedAt
          || (checkedAt === latest.value.checkedAt && (candidate.mtimeMs > latest.mtimeMs
            || (candidate.mtimeMs === latest.mtimeMs && entry.name > latestName)))) {
          latest = candidate;
          latestName = entry.name;
        }
      } catch {
        if (allowed()) this.#error("A saved update check result is invalid, unreadable, or unsafe.");
      }
    }
    return allowed() ? latest?.value ?? null : null;
  }

  #compareResult(result: StoredResult): SoftwareUpdateCheck {
    const { component, available, checkedAt, error } = result;
    const installed = component === "app" ? this.#build.commit : this.#cliVersion;
    let status: SoftwareUpdateCheck["status"];
    let message: string;
    if (error !== null) {
      status = "unavailable"; message = error;
    } else if (component === "app") {
      if (!installed || this.#build.dirty || this.#build.source === "unknown" || !SHA.test(installed)) {
        status = "unknown"; message = "The running app build cannot be compared reliably with main.";
      } else if (installed === available) {
        status = "match"; message = "The running app matches main at check time.";
      } else {
        status = "different"; message = "The running app and main are different builds.";
      }
    } else if (!installed) {
      status = "unknown"; message = "The running skills CLI version is unknown.";
    } else if (installed === available) {
      status = "match"; message = "The running skills CLI matches the registry latest tag.";
    } else {
      status = "different"; message = "The running skills CLI differs from the registry latest tag.";
    }
    return { component, status, installed, available, checkedAt, message };
  }

  async #loadCache(component: UpdateComponent): Promise<void> {
    const key = this.#cacheKey(component);
    if (!key) return;
    const generation = this.#generation[component];
    const allowed = () => !this.#disposed && generation === this.#generation[component] && key === this.#cacheKey(component);
    try {
      if (!(await this.#directory(this.#cache, false)) || !allowed()) return;
    } catch {
      if (allowed()) this.#error("Update history is unavailable because its private storage is unsafe or unreadable.");
      return;
    }
    try {
      const attempt = attemptTimestamp(await readPrivateJson(this.#cacheFile(component, "attempt", key)), Date.now());
      if (allowed()) this.#attempts[component] = attempt;
    } catch {
      if (allowed()) this.#error("A saved update check record is invalid, unreadable, or unsafe.");
    }
    try {
      const result = await this.#readResult(component, key);
      if (allowed() && result) this.#results[component] = this.#compareResult(result);
    } catch {
      if (allowed()) this.#error("A saved update check result is invalid, unreadable, or unsafe.");
    }
  }

  async #storeResult(result: StoredResult, allowed: () => boolean): Promise<void> {
    if (!result.scope || !allowed()) return;
    try {
      await this.#directory(this.#cache, true, allowed);
      const file = path.join(this.#cache, `result-${result.component}-${result.scope}-${result.checkedAt}-${randomUUID()}.json`);
      await atomicPrivateJson(file, result, allowed, async (temporary) => {
        if (!(await this.#directory(this.#cache, false))) throw new Error("Update storage disappeared");
        if (!allowed()) throw new Error("Update storage authorization changed");
        // The destination is immutable; link fails rather than replacing any file.
        await link(temporary, file);
        await unlink(temporary);
      });
    } catch {
      if (allowed()) this.#error("The completed update check could not be saved safely.");
    }
  }

  async #readConsent(component: UpdateComponent): Promise<StoredConsent | null> {
    if (!(await this.#directory(this.#config, false))) return null;
    const value = await readPrivateJson(this.#consentFile(component));
    if (value === null) return null;
    if (!isRecord(value) || value.kind !== "skills-manager-update-consent" || value.version !== 1
      || typeof value.enabled !== "boolean" || typeof value.scope !== "string" || value.scope.length > 2048) {
      throw new Error("Invalid update consent");
    }
    return { kind: "skills-manager-update-consent", version: 1, enabled: value.enabled, scope: value.scope };
  }

  async #loadConsent(component: UpdateComponent): Promise<void> {
    const value = await this.#readConsent(component);
    if (!value) return;
    const scope = this.#scope(component);
    if (value.enabled && (!scope || value.scope !== scope)) {
      this.#error(component === "cli"
        ? "Automatic CLI checks are off because the npm registry changed or is unavailable. Approve the current registry to enable them."
        : "Automatic app checks are off because their host scope changed.");
      return;
    }
    this.#preferences[component] = value.enabled;
  }

  async #refreshRegistry(): Promise<void> {
    if (this.#registryRefresh) return this.#registryRefresh;
    const operation = (async () => {
      const previous = this.#registryScope;
      let next = "";
      let registry = "";
      try {
        registry = await resolveUpdateRegistry();
        next = safeRegistry(registry);
      } catch {
        this.#error("The npm registry for updates could not be determined safely.");
      }
      this.#registry = registry && next ? registry : "";
      this.#registryScope = next;
      if (previous && previous !== next) {
        this.#preferences.cli = false;
        this.#preferenceRevision.cli++;
        this.#attempts.cli = null;
        this.#invalidate("cli");
        this.#error("The npm registry changed or became unavailable; automatic CLI checks are off until the current registry is approved.");
      }
      if (previous !== next) this.#notify();
    })();
    this.#registryRefresh = operation;
    try { await operation; }
    finally { if (this.#registryRefresh === operation) this.#registryRefresh = undefined; }
  }

  async start(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#startPromise) this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    try {
      for (const root of this.#knownRoots) this.#knownPhysicalRoots.add(await canonicalCandidate(root));
    } catch { this.#error("Cannot validate the selected skills directory for update storage."); }
    if (this.#disposed) return;
    const [identity, runtime] = await Promise.allSettled([
      readBuildIdentity(), inspectSkillsRuntime(), this.#refreshRegistry(),
    ]);
    if (identity.status === "fulfilled") this.#build = identity.value;
    else this.#error("The running app build identity is unavailable.");
    if (runtime.status === "fulfilled" && validInstalledVersion(runtime.value.version)) this.#cliVersion = runtime.value.version;
    else this.#error("The running skills CLI version is unavailable.");
    // Registry resolution is handled by #refreshRegistry, which never reports its raw URL.
    if (this.#disposed) return;
    for (const component of COMPONENTS) {
      try { await this.#loadConsent(component); }
      catch { this.#preferences[component] = false; this.#error(`Automatic ${component === "app" ? "app" : "CLI"} update consent is invalid, unreadable, or unsafe; checks are off.`); }
    }
    for (const component of COMPONENTS) await this.#loadCache(component);
    if (this.#disposed) return;
    this.#notify();
    for (const component of COMPONENTS) if (this.#preferences[component]) this.#schedule(component, 0);
  }

  #invalidate(component: UpdateComponent): void {
    this.#generation[component]++;
    this.#flights.get(component)?.controller.abort();
    this.#flights.delete(component);
    const wasChecking = this.#checking[component].size > 0;
    this.#checking[component].clear();
    const timer = this.#timers.get(component);
    clearTimeout(timer?.handle);
    this.#timers.delete(component);
    delete this.#results[component];
    if (wasChecking || timer) this.#notify();
  }

  async setAutomatic(component: UpdateComponent, enabled: boolean, expectedRegistry?: string): Promise<void> {
    if (this.#disposed) return;
    let approvedRegistry = this.#registryScope;
    if (enabled && component === "cli" && expectedRegistry !== undefined) {
      try { approvedRegistry = safeRegistry(expectedRegistry); }
      catch { approvedRegistry = ""; }
    }
    const revision = ++this.#preferenceRevision[component];
    const storageRevision = this.#storageRevision;
    const reportInterruptedRevocation = () => {
      if (!enabled && revision === this.#preferenceRevision[component] && storageRevision !== this.#storageRevision) {
        this.#error("Automatic checks are off in this session, but saving that choice was interrupted; a future launch may retain the old consent.");
      }
    };
    if (!enabled) {
      this.#preferences[component] = false;
      if (this.#foreground[component] === 0) this.#invalidate(component);
      else {
        const timer = this.#timers.get(component);
        clearTimeout(timer?.handle);
        this.#timers.delete(component);
      }
      this.#notify();
    }
    const previous = this.#preferenceWrites.get(component) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (enabled && component === "cli") {
        if (!approvedRegistry || approvedRegistry !== this.#registryScope) {
          this.#error("The npm registry changed; review it before enabling automatic CLI checks.");
          return;
        }
        await this.#refreshRegistry();
        if (approvedRegistry !== this.#registryScope) {
          this.#error("Review the current npm registry before enabling automatic CLI checks.");
          return;
        }
      }
      if (revision !== this.#preferenceRevision[component] || storageRevision !== this.#storageRevision) {
        reportInterruptedRevocation();
        return;
      }
      const scope = this.#scope(component);
      if (enabled && !scope) {
        this.#error("Automatic CLI checks cannot be enabled until the npm registry is known.");
        return;
      }
      try {
        const stillAllowed = () => revision === this.#preferenceRevision[component] && storageRevision === this.#storageRevision;
        await this.#directory(this.#config, true, stillAllowed);
        // Never adopt or overwrite an unrelated or malformed existing file.
        await this.#readConsent(component);
        const consent: StoredConsent = { kind: "skills-manager-update-consent", version: 1, enabled, scope };
        await atomicPrivateJson(this.#consentFile(component), consent, stillAllowed);
        if (revision !== this.#preferenceRevision[component] || storageRevision !== this.#storageRevision) {
          reportInterruptedRevocation();
          return;
        }
        const newlyEnabled = enabled && !this.#preferences[component];
        this.#preferences[component] = enabled;
        this.#notify();
        if (newlyEnabled && !this.#disposed) this.#launchAutomatic(component, true);
      } catch {
        if (revision !== this.#preferenceRevision[component] || storageRevision !== this.#storageRevision) {
          reportInterruptedRevocation();
          return;
        }
        if (enabled) {
          this.#preferences[component] = false;
          this.#invalidate(component);
        }
        this.#error(enabled
          ? "Could not safely save automatic update consent; checks remain off."
          : "Automatic checks are off in this session, but saving that choice failed; a future launch may retain the old consent.");
        this.#notify();
      }
    });
    this.#preferenceWrites.set(component, operation);
    try { await operation; }
    finally { if (this.#preferenceWrites.get(component) === operation) this.#preferenceWrites.delete(component); }
  }

  async setSkillsDirectory(skillsDir: string): Promise<void> {
    if (this.#disposed) return;
    if (!skillsDir || !path.isAbsolute(skillsDir) || skillsDir.includes("\0")) throw new Error("An absolute skills directory is required.");
    this.#storageRevision++;
    this.#knownRoots.add(path.resolve(skillsDir));
    const flights = [...this.#flights.values()].map((flight) => flight.promise);
    for (const component of COMPONENTS) this.#invalidate(component);
    await Promise.allSettled([...flights, ...this.#background, ...this.#preferenceWrites.values(),
      ...(this.#registryRefresh ? [this.#registryRefresh] : [])]);
    if (this.#disposed) return;
    try {
      this.#knownPhysicalRoots.add(await canonicalCandidate(skillsDir));
      await this.#assertSafePaths();
      for (const component of COMPONENTS) if (this.#preferences[component]) this.#schedule(component, 0);
    } catch {
      for (const component of COMPONENTS) {
        this.#preferences[component] = false;
        this.#preferenceRevision[component]++;
        this.#invalidate(component);
      }
      this.#error("Automatic update checks are off because update storage cannot be kept outside all selected skills directories.");
    }
    this.#notify();
  }

  async check(component: UpdateComponent, expectedRegistry?: string): Promise<void> {
    if (this.#disposed) return;
    if (component === "cli" && expectedRegistry !== undefined) {
      let approvedRegistry = "";
      try { approvedRegistry = safeRegistry(expectedRegistry); } catch { /* Invalid approval cannot authorize a host. */ }
      if (!approvedRegistry || approvedRegistry !== this.#registryScope) {
        this.#error("The npm registry changed; review it before checking the CLI.");
        return;
      }
    }
    this.#foreground[component]++;
    try { await this.#check(component, false); }
    finally { this.#foreground[component]--; }
  }

  async #check(component: UpdateComponent, automatic: boolean): Promise<void> {
    if (this.#disposed) return;
    const token = this.#beginChecking(component);
    try {
      const generation = this.#generation[component];
      const disclosedRegistry = this.#registryScope;
      if (component === "cli") await this.#refreshRegistry();
      if (this.#disposed || (automatic && !this.#preferences[component]) || generation !== this.#generation[component]
        || (component === "cli" && disclosedRegistry !== this.#registryScope)) return;
      const existing = this.#flights.get(component);
      if (existing) return await existing.promise;
      const controller = new AbortController();
      const flight: Flight = { controller, promise: Promise.resolve() };
      flight.promise = this.#performCheck(component, controller, generation).finally(() => {
        if (this.#flights.get(component) === flight) this.#flights.delete(component);
      });
      this.#flights.set(component, flight);
      await flight.promise;
    } finally {
      this.#endChecking(component, token);
    }
  }

  async #performCheck(component: UpdateComponent, controller: AbortController, generation: number): Promise<void> {
    const scope = this.#cacheKey(component);
    const allowed = () => !controller.signal.aborted && generation === this.#generation[component]
      && !this.#disposed && scope === this.#cacheKey(component);
    let available: string | null = null;
    let error: string | null = "Update check unavailable.";
    try {
      if (component === "cli" && !this.#registryScope) throw new Error("Registry unknown");
      const url = component === "app" ? GITHUB_URL : new URL("skills/latest", this.#registryScope).href;
      const response = await fetch(url, {
        method: "GET", redirect: "error", credentials: "omit",
        headers: { Accept: component === "app" ? "application/vnd.github.sha" : "application/json", "User-Agent": "skills-manager" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        if (response.status >= 100 && response.status <= 599) error = `Update check unavailable (HTTP ${response.status}).`;
        await response.body?.cancel().catch(() => {});
      } else {
        const text = await responseText(response);
        if (component === "app") {
          const sha = text.trim();
          if (!SHA.test(sha)) throw new Error("Invalid app response");
          available = sha;
        } else {
          const data: unknown = JSON.parse(text);
          if (!isRecord(data) || data.name !== "skills" || typeof data.version !== "string"
            || data.version.length > 128 || !VERSION.test(data.version)) throw new Error("Invalid CLI response");
          available = data.version;
        }
        error = null;
      }
    } catch { /* Never expose network errors, URLs, credentials, or untrusted response text. */ }
    if (!allowed()) return;
    const result: StoredResult = {
      kind: "skills-manager-update-result", version: 1, component, scope,
      checkedAt: Date.now(), available, error,
    };
    await this.#storeResult(result, allowed);
    if (!allowed()) return;
    this.#results[component] = this.#compareResult(result);
    this.#notify();
  }

  #schedule(component: UpdateComponent, delay: number, approvedCheck = false): void {
    if (this.#disposed || !this.#preferences[component]) return;
    const previous = this.#timers.get(component);
    clearTimeout(previous?.handle);
    const wait = Math.max(0, delay);
    const at = Date.now() + wait;
    const timer = setTimeout(() => {
      if (this.#timers.get(component)?.handle !== timer) return;
      this.#timers.delete(component);
      this.#launchAutomatic(component, approvedCheck);
    }, wait);
    timer.unref();
    this.#timers.set(component, { handle: timer, at });
    this.#notify();
  }

  #launchAutomatic(component: UpdateComponent, approvedCheck: boolean): void {
    const operation = this.#automaticCheck(component, approvedCheck);
    this.#background.add(operation);
    void operation.finally(() => { this.#background.delete(operation); });
  }

  async #automaticCheck(component: UpdateComponent, approvedCheck: boolean): Promise<void> {
    const token = this.#beginChecking(component);
    const generation = this.#generation[component];
    const allowed = () => !this.#disposed && this.#preferences[component] && generation === this.#generation[component];
    try {
      if (component === "cli") await this.#refreshRegistry();
      if (!allowed()) return;
      let consent: StoredConsent | null;
      try { consent = await this.#readConsent(component); }
      catch {
        if (allowed()) {
          this.#preferences[component] = false;
          this.#invalidate(component);
          this.#error("Automatic update checks are off because their saved consent is invalid, unreadable, or unsafe.");
        }
        return;
      }
      if (!allowed()) return;
      if (!consent?.enabled || consent.scope !== this.#scope(component)) {
        this.#preferences[component] = false;
        this.#invalidate(component);
        this.#error("Automatic update checks are off because their saved consent is no longer valid.");
        return;
      }
      const claim = await this.#claim(component, allowed, approvedCheck);
      if (!allowed()) return;
      if (claim.at !== undefined) {
        this.#attempts[component] = claim.at;
        this.#notify();
      }
      // The claim retains the cross-process lock until the check and its result are saved.
      if (allowed()) this.#schedule(component, Math.max(0, claim.next - Date.now()), approvedCheck && claim.retry);
    } catch {
      if (allowed()) {
        this.#error("Automatic update checks could not safely record their daily attempt; checks are paused until storage is available.");
        this.#schedule(component, 60_000);
      }
    } finally {
      this.#endChecking(component, token);
    }
  }

  async #claim(component: UpdateComponent, allowed: () => boolean, approvedCheck: boolean): Promise<{ next: number; retry: boolean; at?: number }> {
    if (!allowed()) return { next: Date.now() + RETRY_MS, retry: false };
    await this.#directory(this.#cache, true, allowed);
    if (!allowed()) return { next: Date.now() + RETRY_MS, retry: false };
    const key = this.#cacheKey(component);
    const file = this.#cacheFile(component, "attempt", key);
    const lock = `${file}.lock`;
    // This ownership token is read as text and never followed as a filesystem path.
    const token = `skills-manager-update-lock:${process.pid}:${randomBytes(12).toString("hex")}`;
    try { await symlink(token, lock); }
    catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (allowed()) await this.#recoverAbandonedLock(lock, allowed);
      return { next: Date.now() + RETRY_MS, retry: true };
    }
    const identity = await lstat(lock);
    if (!identity.isSymbolicLink() || (process.getuid && identity.uid !== process.getuid())
      || await readlink(lock) !== token) throw new Error("Update coordination lock changed");
    try {
      if (!allowed()) return { next: Date.now() + RETRY_MS, retry: false };
      const value = await readPrivateJson(file);
      const now = Date.now();
      const previous = attemptTimestamp(value, now);
      let result: StoredResult | null;
      try { result = await this.#readResult(component, key); }
      catch {
        if (allowed()) this.#error("Automatic checks are paused because the saved check result is invalid or unsafe; manual checks remain available.");
        return { next: Date.now() + 60_000, retry: false };
      }
      if (!allowed()) return { next: now + RETRY_MS, retry: false };
      if (result && (!this.#results[component] || this.#results[component]!.checkedAt < result.checkedAt)) {
        this.#results[component] = this.#compareResult(result);
        this.#notify();
      }
      if (!approvedCheck && result && now < result.checkedAt + DAY_MS) {
        return { next: result.checkedAt + DAY_MS, ...(previous === null ? {} : { at: previous }), retry: false };
      }
      await atomicPrivateJson(file, { kind: "skills-manager-update-attempt", version: 1, at: now }, allowed);
      // A stale-lock recovery can displace this holder. Its recorded timestamp
      // remains conservative, but it must not start a request without the lock.
      try {
        const current = await lstat(lock);
        if (current.dev !== identity.dev || current.ino !== identity.ino) return { next: now + RETRY_MS, at: now, retry: true };
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return { next: now + RETRY_MS, at: now, retry: true };
        throw error;
      }
      if (allowed()) {
        this.#attempts[component] = now;
        this.#notify();
        await this.#check(component, true);
      }
      const completed = this.#results[component];
      return { next: completed ? completed.checkedAt + DAY_MS : now + DAY_MS, at: now, retry: false };
    } finally {
      // Only remove this instance's token; never follow it.
      try {
        const current = await lstat(lock);
        if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lock);
      } catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
    }
  }

  async #recoverAbandonedLock(lock: string, allowed: () => boolean): Promise<void> {
    let info;
    try { info = await lstat(lock); }
    catch (error) { if (hasErrorCode(error, "ENOENT")) return; throw error; }
    if (!info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("Unsafe update coordination lock");
    }
    const token = await readlink(lock);
    const match = /^skills-manager-update-lock:([1-9]\d*):[a-f0-9]{24}$/.exec(token);
    if (!match) throw new Error("Unrecognized update coordination lock");
    const age = Date.now() - info.mtimeMs;
    if (age < LOCK_STALE_MS) return;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) throw new Error("Invalid update coordination lock");
    if (age < DAY_MS) {
      try { process.kill(pid, 0); return; }
      catch (error) { if (!hasErrorCode(error, "ESRCH")) return; }
    }
    try {
      const current = await lstat(lock);
      if (allowed() && current.dev === info.dev && current.ino === info.ino) await unlink(lock);
    } catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const flights = [...this.#flights.values()].map((flight) => flight.promise);
    for (const component of COMPONENTS) this.#invalidate(component);
    await Promise.allSettled([...flights, ...this.#background, ...this.#preferenceWrites.values(),
      ...(this.#startPromise ? [this.#startPromise] : []), ...(this.#registryRefresh ? [this.#registryRefresh] : [])]);
  }
}
