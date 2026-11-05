import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
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
interface Flight { controller: AbortController; promise: Promise<void> }

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
async function readPrivateJson(file: string): Promise<unknown | null> {
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
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (value === null) throw new Error("Invalid update state");
    return value;
  } finally { await handle.close(); }
}

async function atomicPrivateJson(file: string, value: unknown, stillAllowed: () => boolean): Promise<void> {
  try { validatePrivateStat(await lstat(file), false); }
  catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
  if (!stillAllowed()) throw new Error("Update storage authorization changed");
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    if (!stillAllowed()) throw new Error("Update storage authorization changed");
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.close();
    if (!stillAllowed()) throw new Error("Update storage authorization changed");
    await rename(temporary, file);
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

async function responseJson(response: Response): Promise<unknown> {
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
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
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
  readonly #timers = new Map<UpdateComponent, ReturnType<typeof setTimeout>>();
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

  async refreshRegistry(): Promise<void> {
    if (!this.#disposed) await this.#refreshRegistry();
  }

  #notify(): void {
    if (this.#disposed) return;
    try { this.#onChange?.(); } catch { /* UI callbacks must not break update state. */ }
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
    if (this.#disposed) return;
    this.#notify();
    for (const component of COMPONENTS) if (this.#preferences[component]) this.#schedule(component, 0);
  }

  #invalidate(component: UpdateComponent): void {
    this.#generation[component]++;
    this.#flights.get(component)?.controller.abort();
    this.#flights.delete(component);
    const timer = this.#timers.get(component);
    clearTimeout(timer);
    this.#timers.delete(component);
    delete this.#results[component];
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
      this.#invalidate(component);
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
        this.#preferences[component] = enabled;
        this.#notify();
        if (enabled && !this.#disposed) this.#schedule(component, 0);
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
    const generation = this.#generation[component];
    const disclosedRegistry = this.#registryScope;
    if (component === "cli") await this.#refreshRegistry();
    if (this.#disposed || generation !== this.#generation[component]
      || (component === "cli" && disclosedRegistry !== this.#registryScope)) return;
    const existing = this.#flights.get(component);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const flight: Flight = { controller, promise: Promise.resolve() };
    flight.promise = this.#performCheck(component, controller, generation).finally(() => {
      if (this.#flights.get(component) === flight) this.#flights.delete(component);
    });
    this.#flights.set(component, flight);
    return flight.promise;
  }

  async #performCheck(component: UpdateComponent, controller: AbortController, generation: number): Promise<void> {
    const installed = component === "app" ? this.#build.commit : this.#cliVersion;
    let status: SoftwareUpdateCheck["status"] = "unavailable";
    let available: string | null = null;
    let message = "Update check unavailable.";
    try {
      if (component === "cli" && !this.#registryScope) throw new Error("Registry unknown");
      const url = component === "app" ? GITHUB_URL : new URL("skills/latest", this.#registryScope).href;
      const response = await fetch(url, {
        method: "GET", redirect: "error", credentials: "omit",
        headers: { Accept: "application/json", "User-Agent": "skills-manager" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        message = `Update check unavailable (HTTP ${response.status}).`;
        await response.body?.cancel().catch(() => {});
      } else {
        const data = await responseJson(response);
        if (component === "app") {
          if (!isRecord(data) || typeof data.sha !== "string" || !SHA.test(data.sha)) throw new Error("Invalid app response");
          available = data.sha;
          if (!installed || this.#build.dirty || this.#build.source === "unknown" || !SHA.test(installed)) {
            status = "unknown";
            message = "The running app build cannot be compared reliably with main.";
          } else if (installed === available) {
            status = "match"; message = "The running app matches main at check time.";
          } else {
            status = "different"; message = "The running app and main are different builds.";
          }
        } else {
          if (!isRecord(data) || data.name !== "skills" || typeof data.version !== "string"
            || data.version.length > 128 || !VERSION.test(data.version)) throw new Error("Invalid CLI response");
          available = data.version;
          if (!installed) { status = "unknown"; message = "The running skills CLI version is unknown."; }
          else if (installed === available) { status = "match"; message = "The running skills CLI matches the registry latest tag."; }
          else { status = "different"; message = "The running skills CLI differs from the registry latest tag."; }
        }
      }
    } catch { /* Never expose network errors, URLs, credentials, or untrusted response text. */ }
    if (controller.signal.aborted || generation !== this.#generation[component] || this.#disposed) return;
    this.#results[component] = { component, status, installed, available, checkedAt: Date.now(), message };
    this.#notify();
  }

  #schedule(component: UpdateComponent, delay: number): void {
    if (this.#disposed || !this.#preferences[component]) return;
    const previous = this.#timers.get(component);
    clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#timers.delete(component);
      const operation = this.#automaticCheck(component);
      this.#background.add(operation);
      void operation.finally(() => { this.#background.delete(operation); this.#notify(); });
    }, Math.max(0, delay));
    timer.unref();
    this.#timers.set(component, timer);
  }

  async #automaticCheck(component: UpdateComponent): Promise<void> {
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
      const claim = await this.#claim(component, allowed);
      if (!allowed()) return;
      if (claim.claimed) await this.check(component);
      if (allowed()) this.#schedule(component, Math.max(0, claim.next - Date.now()));
    } catch {
      if (allowed()) {
        this.#error("Automatic update checks could not safely record their daily attempt; checks are paused until storage is available.");
        this.#schedule(component, 60_000);
      }
    }
  }

  async #claim(component: UpdateComponent, allowed: () => boolean): Promise<{ claimed: boolean; next: number }> {
    if (!allowed()) return { claimed: false, next: Date.now() + RETRY_MS };
    await this.#directory(this.#cache, true, allowed);
    if (!allowed()) return { claimed: false, next: Date.now() + RETRY_MS };
    const hash = createHash("sha256").update(this.#scope(component)).digest("hex");
    const file = path.join(this.#cache, `attempt-${component}-${hash}.json`);
    const lock = `${file}.lock`;
    // This ownership token is read as text and never followed as a filesystem path.
    const token = `skills-manager-update-lock:${process.pid}:${randomBytes(12).toString("hex")}`;
    try { await symlink(token, lock); }
    catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (allowed()) await this.#recoverAbandonedLock(lock, allowed);
      return { claimed: false, next: Date.now() + RETRY_MS };
    }
    const identity = await lstat(lock);
    if (!identity.isSymbolicLink() || (process.getuid && identity.uid !== process.getuid())
      || await readlink(lock) !== token) throw new Error("Update coordination lock changed");
    try {
      if (!allowed()) return { claimed: false, next: Date.now() + RETRY_MS };
      const value = await readPrivateJson(file);
      const now = Date.now();
      if (value !== null && (!isRecord(value) || value.kind !== "skills-manager-update-attempt"
        || value.version !== 1 || typeof value.at !== "number"
        || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > now + DAY_MS)) throw new Error("Invalid attempt cache");
      const previous = isRecord(value) && typeof value.at === "number" ? value.at : null;
      if (previous !== null && now < previous + DAY_MS) return { claimed: false, next: previous + DAY_MS };
      if (!allowed()) return { claimed: false, next: now + RETRY_MS };
      await atomicPrivateJson(file, { kind: "skills-manager-update-attempt", version: 1, at: now }, allowed);
      // A stale-lock recovery can displace this holder. Its recorded timestamp
      // remains conservative, but it must not start a request without the lock.
      try {
        const current = await lstat(lock);
        if (current.dev !== identity.dev || current.ino !== identity.ino) return { claimed: false, next: now + RETRY_MS };
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return { claimed: false, next: now + RETRY_MS };
        throw error;
      }
      return { claimed: true, next: now + DAY_MS };
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
