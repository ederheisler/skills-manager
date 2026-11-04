import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// This disposable driver keeps the approved root descriptor and the handler's
// in-process observation alive while the test changes directory entries.
const driverSource = String.raw`
#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/param.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "tree.h"
#include "git-transaction-state.h"

int main(int argc, char **argv) {
    int root, state, lock;
    char *line = NULL;
    size_t capacity = 0;
    ssize_t size;
    if (argc != 2) return 2;
    root = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (root < 0) { perror("open root"); return 2; }
    state = openat(root, ".skills-manager", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (state < 0) { perror("open state"); return 2; }
    lock = openat(state, "lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    close(state);
    if (lock < 0 || flock(lock, LOCK_EX) < 0) { perror("lock state"); return 2; }
    puts("READY");
    fflush(stdout);
    while ((size = getline(&line, &capacity, stdin)) >= 0) {
        unsigned char *output = NULL;
        size_t output_len = 0, i;
        uint32_t op;
        int result, error;
        if (size && line[size - 1] == '\n') --size;
        if (!size) continue;
        if (line[0] == 'Q') break;
        if (line[0] == 'R') op = 13;
        else if (line[0] == 'P') op = 14;
        else if (line[0] == 'D') op = 15;
        else if (line[0] == 'T') op = 18;
        else if (line[0] == 'X') op = 19;
        else if (line[0] == 'Y') op = 20;
        else if (line[0] == 'Z') op = 21;
        else return 2;
        result = git_transaction_state_handler(root, op,
            (const unsigned char *)(line + 1), (size_t)size - 1U, &output, &output_len);
        error = result < 0 ? errno : 0;
        printf("%d ", error);
        for (i = 0; i < output_len; ++i) printf("%02x", output[i]);
        putchar('\n');
        fflush(stdout);
        free(output);
    }
    free(line);
    close(lock);
    close(root);
    return 0;
}
`;

type Command = "R" | "P" | "D" | "T" | "X" | "Y" | "Z";
type Response = { error: number; output: string };

class StateSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly readline: Interface;
  private readonly lines: AsyncIterableIterator<string>;
  private stderr = "";
  private spawnError: Error | undefined;

  constructor(root: string) {
    this.child = spawn(driver, [root], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", (error) => { this.spawnError = error; });
    this.child.stdin.on("error", (error) => { this.spawnError = error; });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.readline = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines = this.readline[Symbol.asyncIterator]();
  }

  async nextLine(): Promise<string> {
    const line = await this.lines.next();
    if (line.done) throw new Error(`State driver exited: ${this.spawnError?.message ?? this.stderr}`);
    return line.value;
  }

  async request(command: Command, payload = ""): Promise<Response> {
    if (payload.includes("\n")) throw new Error("The test driver accepts single-line payloads only");
    const response = this.nextLine();
    this.child.stdin.write(`${command}${payload}\n`);
    const line = await response;
    const match = /^(\d+) ([0-9a-f]*)$/.exec(line);
    if (!match || match[2].length % 2 !== 0) throw new Error(`Invalid state driver response: ${line}`);
    return { error: Number(match[1]), output: Buffer.from(match[2], "hex").toString("utf8") };
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const closed = once(this.child, "close");
      this.child.stdin.end("Q\n");
      await closed;
    }
    this.readline.close();
  }
}

const ownerContents = "skills-manager-owned-state-v1\n";
const first = '{"phase":"prepared"}';
const second = '{"phase":"committed"}';
const empty = "";
const errno = constants.errno;
let fixture = "";
let driver = "";
let sandbox = "";
let root = "";
let state = "";
let journal = "";
let temporary = "";
let deletion = "";
let session: StateSession | undefined;

function envelope(body: string): string {
  const length = Buffer.byteLength(body).toString(16).padStart(16, "0");
  const digest = createHash("sha256").update(body).digest("hex");
  return `skills-manager-git-journal-v1\n${length}\n${digest}\n${body}`;
}

async function privateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function initializeState(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  await privateFile(join(path, "owner"), ownerContents);
  await privateFile(join(path, "lock"), "");
}

async function identity(path: string) {
  const entry = await lstat(path, { bigint: true });
  return { dev: entry.dev, ino: entry.ino, mode: entry.mode, nlink: entry.nlink, mtime: entry.mtimeNs, ctime: entry.ctimeNs };
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function request(command: Command, payload = ""): Promise<Response> {
  if (!session) throw new Error("State driver is not running");
  return session.request(command, payload);
}

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "skills-git-state-driver-"));
  const source = join(fixture, "driver.c");
  driver = join(fixture, "driver");
  await writeFile(source, driverSource);
  const native = fileURLToPath(new URL("../../native/", import.meta.url));
  const compiler = spawnSync(process.env.CC || "cc", [
    "-std=c11", "-O2", "-D_POSIX_C_SOURCE=200809L", "-I", native, source, "-o", driver,
  ], { encoding: "utf8", timeout: 60000 });
  if (compiler.error || compiler.status !== 0) {
    throw new Error(`Cannot compile disposable state driver: ${compiler.error?.message ?? compiler.stderr}`);
  }
}, 60000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "skills-git-state-"));
  root = join(sandbox, "root");
  state = join(root, ".skills-manager");
  journal = join(state, "git-transaction-journal");
  temporary = `${journal}.next`;
  deletion = `${journal}.delete`;
  await mkdir(root, { mode: 0o700 });
  await initializeState(state);
  session = new StateSession(root);
  expect(await session.nextLine()).toBe("READY");
});

afterEach(async () => {
  if (session) await session.close();
  session = undefined;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe("native Git transaction root state", () => {
  it("round-trips and atomically replaces a journal, then deletes it", async () => {
    expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
    expect(await request("P", first)).toEqual({ error: 0, output: empty });
    expect(await readFile(journal, "utf8")).toBe(envelope(first));
    expect(Number((await lstat(journal)).mode & 0o777)).toBe(0o600);
    await expectMissing(temporary);
    expect(await request("R")).toEqual({ error: 0, output: first });

    expect(await request("P", second)).toEqual({ error: 0, output: empty });
    expect(await readFile(journal, "utf8")).toBe(envelope(second));
    await expectMissing(temporary);
    expect(await request("R")).toEqual({ error: 0, output: second });
    expect(await request("D")).toEqual({ error: 0, output: empty });
    await expectMissing(journal);
    await expectMissing(temporary);
    expect(await request("D")).toEqual({ error: errno.ENOENT, output: empty });
    expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
  });

  it("does not adopt or overwrite an existing foreign journal", async () => {
    const foreign = "not a manager journal\n";
    await privateFile(journal, foreign);
    const before = await identity(journal);
    expect(await request("R")).toEqual({ error: errno.EBADMSG, output: empty });
    expect(await request("P", first)).toEqual({ error: errno.ESTALE, output: empty });
    expect(await request("D")).toEqual({ error: errno.ESTALE, output: empty });
    expect(await readFile(journal, "utf8")).toBe(foreign);
    expect(await identity(journal)).toEqual(before);
    await expectMissing(temporary);
  });

  it.each(["P", "D"] as const)("refuses %s when a valid journal appears after an absent read", async (operation) => {
    expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
    await privateFile(journal, envelope(second));
    const before = await identity(journal);
    expect(await request(operation, operation === "P" ? first : "")).toEqual({ error: errno.ESTALE, output: empty });
    expect(await readFile(journal, "utf8")).toBe(envelope(second));
    expect(await identity(journal)).toEqual(before);
    await expectMissing(temporary);
  });

  it.each(["P", "D"] as const)("preserves a malformed foreign journal appearing before %s", async (operation) => {
    expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
    await privateFile(journal, "foreign journal");
    const before = await identity(journal);
    expect(await request(operation, operation === "P" ? first : "")).toEqual({ error: errno.EBADMSG, output: empty });
    expect(await readFile(journal, "utf8")).toBe("foreign journal");
    expect(await identity(journal)).toEqual(before);
    await expectMissing(temporary);
  });

  it.each([
    ["P", first], ["P", second], ["D", first], ["D", second],
  ] as const)("refuses %s after the read journal is replaced, even with the same bytes", async (operation, replacement) => {
    await privateFile(journal, envelope(first));
    expect(await request("R")).toEqual({ error: 0, output: first });
    const displaced = join(state, "displaced-journal");
    await rename(journal, displaced);
    await privateFile(journal, envelope(replacement));
    const before = await identity(journal);
    expect(await request(operation, operation === "P" ? second : "")).toEqual({ error: errno.ESTALE, output: empty });
    expect(await readFile(journal, "utf8")).toBe(envelope(replacement));
    expect(await identity(journal)).toEqual(before);
    expect(await readFile(displaced, "utf8")).toBe(envelope(first));
    await expectMissing(temporary);
  });

  it.each(["P", "D"] as const)("refuses %s after the same journal inode is modified", async (operation) => {
    await privateFile(journal, envelope(first));
    expect(await request("R")).toEqual({ error: 0, output: first });
    const oldIdentity = await identity(journal);
    await writeFile(journal, envelope(second));
    const before = await identity(journal);
    expect([before.dev, before.ino]).toEqual([oldIdentity.dev, oldIdentity.ino]);
    expect(await request(operation, operation === "P" ? first : "")).toEqual({ error: errno.ESTALE, output: empty });
    expect(await readFile(journal, "utf8")).toBe(envelope(second));
    expect(await identity(journal)).toEqual(before);
    await expectMissing(temporary);
  });

  it.each(["P", "D"] as const)("refuses %s after the owned state directory is replaced", async (operation) => {
    await privateFile(journal, envelope(first));
    expect(await request("R")).toEqual({ error: 0, output: first });
    const originalState = join(root, "old-state");
    await rename(state, originalState);
    await initializeState(state);
    await privateFile(journal, envelope(second));
    const beforeDirectory = await identity(state);
    const beforeJournal = await identity(journal);
    expect(await request(operation, operation === "P" ? first : "")).toEqual({ error: errno.ESTALE, output: empty });
    expect(await identity(state)).toEqual(beforeDirectory);
    expect(await identity(journal)).toEqual(beforeJournal);
    expect(await readFile(journal, "utf8")).toBe(envelope(second));
    expect(await readFile(join(originalState, "git-transaction-journal"), "utf8")).toBe(envelope(first));
    await expectMissing(temporary);
  });

  it.each([
    ["journal", "symlink"], ["journal", "hardlink"],
    ["temporary", "symlink"], ["temporary", "hardlink"],
    ["deletion", "symlink"], ["deletion", "hardlink"],
  ] as const)("does not read a %s that is a %s", async (which, kind) => {
    const path = which === "journal" ? journal : which === "temporary" ? temporary : deletion;
    const target = join(sandbox, "outside-file");
    await privateFile(target, "outside is unchanged");
    if (kind === "symlink") await symlink(target, path);
    else await link(target, path);
    const before = await identity(path);
    const beforeTarget = await identity(target);
    expect(await request(which === "journal" ? "R" : which === "temporary" ? "T" : "Y"))
      .toEqual({ error: errno.EPERM, output: empty });
    expect(await readFile(target, "utf8")).toBe("outside is unchanged");
    expect(await identity(path)).toEqual(before);
    expect(await identity(target)).toEqual(beforeTarget);
    if (kind === "symlink") expect(await readlink(path)).toBe(target);
  });

  it.each([
    ["P", "temporary", "regular"], ["P", "temporary", "symlink"], ["P", "temporary", "hardlink"],
    ["D", "temporary", "regular"], ["D", "temporary", "symlink"], ["D", "temporary", "hardlink"],
    ["P", "deletion", "regular"], ["P", "deletion", "symlink"], ["P", "deletion", "hardlink"],
    ["D", "deletion", "regular"], ["D", "deletion", "symlink"], ["D", "deletion", "hardlink"],
  ] as const)("does not clobber a %s %s-stage collision that is %s", async (operation, stage, kind) => {
    await privateFile(journal, envelope(first));
    expect(await request("R")).toEqual({ error: 0, output: first });
    const beforeJournal = await identity(journal);
    const target = join(sandbox, "outside-file");
    await privateFile(target, "outside is unchanged");
    const collision = stage === "temporary" ? temporary : deletion;
    if (kind === "regular") await privateFile(collision, "foreign staging file");
    else if (kind === "symlink") await symlink(target, collision);
    else await link(target, collision);
    const beforeCollision = await identity(collision);
    const beforeTarget = await identity(target);
    const error = (operation === "P") === (stage === "temporary") ? errno.EEXIST : errno.EBUSY;
    expect(await request(operation, operation === "P" ? second : "")).toEqual({ error, output: empty });
    expect(await identity(journal)).toEqual(beforeJournal);
    expect(await readFile(journal, "utf8")).toBe(envelope(first));
    expect(await identity(collision)).toEqual(beforeCollision);
    expect(await identity(target)).toEqual(beforeTarget);
    expect(await readFile(target, "utf8")).toBe("outside is unchanged");
    if (kind === "regular") expect(await readFile(collision, "utf8")).toBe("foreign staging file");
    if (kind === "symlink") expect(await readlink(collision)).toBe(target);
  });

  it("never follows a symlink substituted for the owned state directory", async () => {
    const outside = join(sandbox, "outside-state");
    await initializeState(outside);
    const outsideJournal = join(outside, "git-transaction-journal");
    await privateFile(outsideJournal, envelope(second));
    const before = await identity(outsideJournal);
    await rename(state, join(sandbox, "original-state"));
    await symlink(outside, state, "dir");
    const result = await request("R");
    expect([errno.ELOOP, errno.ENOTDIR]).toContain(result.error);
    expect(result.output).toBe(empty);
    expect(await readlink(state)).toBe(outside);
    expect(await readFile(outsideJournal, "utf8")).toBe(envelope(second));
    expect(await identity(outsideJournal)).toEqual(before);
  });

  it("continues using the pinned root descriptor if its path is replaced by a symlink", async () => {
    await privateFile(journal, envelope(first));
    expect(await request("R")).toEqual({ error: 0, output: first });
    const moved = join(sandbox, "pinned-root");
    const outside = join(sandbox, "outside-root");
    await mkdir(outside);
    await initializeState(join(outside, ".skills-manager"));
    const outsideJournal = join(outside, ".skills-manager", "git-transaction-journal");
    await privateFile(outsideJournal, envelope(second));
    const before = await identity(outsideJournal);
    await rename(root, moved);
    await symlink(outside, root, "dir");
    expect(await request("P", second)).toEqual({ error: 0, output: empty });
    expect(await readFile(join(moved, ".skills-manager", "git-transaction-journal"), "utf8")).toBe(envelope(second));
    expect(await readlink(root)).toBe(outside);
    expect(await readFile(outsideJournal, "utf8")).toBe(envelope(second));
    expect(await identity(outsideJournal)).toEqual(before);
  });

  it.each(["state", "owner", "lock"] as const)("rejects insecure %s permissions", async (which) => {
    const path = which === "state" ? state : join(state, which);
    await chmod(path, which === "state" ? 0o755 : 0o644);
    const before = await identity(path);
    expect(await request("R")).toEqual({ error: errno.EPERM, output: empty });
    expect(await identity(path)).toEqual(before);
    await expectMissing(journal);
    await expectMissing(temporary);
  });

  it("rejects an untrusted ownership marker without altering it", async () => {
    const marker = join(state, "owner");
    await writeFile(marker, "foreign ownership marker\n");
    const before = await identity(marker);
    expect(await request("R")).toEqual({ error: errno.EPERM, output: empty });
    expect(await readFile(marker, "utf8")).toBe("foreign ownership marker\n");
    expect(await identity(marker)).toEqual(before);
    await expectMissing(journal);
    await expectMissing(temporary);
  });

  it.each([
    ["owner", "symlink"], ["owner", "hardlink"], ["lock", "symlink"], ["lock", "hardlink"],
  ] as const)("rejects a %s control file that is a %s", async (which, kind) => {
    const control = join(state, which);
    const target = join(sandbox, "outside-control");
    const contents = which === "owner" ? ownerContents : "lock sentinel";
    await privateFile(target, contents);
    await unlink(control);
    if (kind === "symlink") await symlink(target, control);
    else await link(target, control);
    const beforeControl = await identity(control);
    const beforeTarget = await identity(target);
    expect(await request("R")).toEqual({ error: errno.EPERM, output: empty });
    expect(await identity(control)).toEqual(beforeControl);
    expect(await identity(target)).toEqual(beforeTarget);
    expect(await readFile(target, "utf8")).toBe(contents);
    if (kind === "symlink") expect(await readlink(control)).toBe(target);
    await expectMissing(journal);
    await expectMissing(temporary);
  });
});

describe("native Git transaction interrupted-stage handling", () => {
  // These are on-disk snapshots of interrupted steps, not injected process crashes.
  it.each([
    ["initial write staged", null, first, "write"],
    ["replacement staged", first, second, "write"],
    ["replacement exchanged", second, first, "write"],
    ["delete quarantined", null, first, "delete"],
  ] as const)("preserves and explicitly finishes %s after inspection", async (_phase, main, staged, kind) => {
    const path = kind === "write" ? temporary : deletion;
    const readStage: Command = kind === "write" ? "T" : "Y";
    const finishStage: Command = kind === "write" ? "X" : "Z";
    if (main !== null) await privateFile(journal, envelope(main));
    await privateFile(path, envelope(staged));
    const before = await identity(path);

    expect(await request("R")).toEqual(main === null
      ? { error: errno.ENOENT, output: empty }
      : { error: 0, output: main });
    expect(await identity(path)).toEqual(before);
    expect(await request(readStage)).toEqual({ error: 0, output: staged });
    expect(await identity(path)).toEqual(before);
    expect(await request(finishStage)).toEqual({ error: 0, output: empty });
    await expectMissing(path);
    expect(await request(finishStage)).toEqual({ error: errno.ESTALE, output: empty });
    expect(await request(readStage)).toEqual({ error: errno.ENOENT, output: empty });
    expect(await request("R")).toEqual(main === null
      ? { error: errno.ENOENT, output: empty }
      : { error: 0, output: main });
    if (main !== null) expect(await readFile(journal, "utf8")).toBe(envelope(main));
    else await expectMissing(journal);
  });

  for (const stage of [
    { name: "write", read: "T", finish: "X" },
    { name: "delete", read: "Y", finish: "Z" },
  ] as const) {
    describe(`${stage.name} stage`, () => {
      const path = () => stage.name === "write" ? temporary : deletion;

      it("requires both a main observation and a successful stage observation before removal", async () => {
        await privateFile(path(), envelope(first));
        const before = await identity(path());
        expect(await request(stage.finish)).toEqual({ error: errno.ESTALE, output: empty });
        expect(await request(stage.read)).toEqual({ error: 0, output: first });
        expect(await request(stage.finish)).toEqual({ error: errno.ESTALE, output: empty });
        expect(await readFile(path(), "utf8")).toBe(envelope(first));
        expect(await identity(path())).toEqual(before);
        expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
        expect(await request(stage.finish)).toEqual({ error: 0, output: empty });
        await expectMissing(path());
      });

      it.each([
        ["empty", ""],
        ["incomplete header", "skills-manager-git-journal-v1\n000000000000"],
        ["incomplete body", envelope(first).slice(0, -1)],
        ["wrong digest", envelope(first).replace(createHash("sha256").update(first).digest("hex"), "0".repeat(64))],
        ["invalid length digit", `skills-manager-git-journal-v1\n000000000000000g\n${"0".repeat(64)}\n${first}`],
        ["extra trailing byte", `${envelope(first)}x`],
      ] as const)("leaves an %s envelope untouched and reports EBADMSG", async (_kind, contents) => {
        await privateFile(journal, envelope(second));
        await privateFile(path(), contents);
        const beforeMain = await identity(journal);
        const beforeStage = await identity(path());
        expect(await request("R")).toEqual({ error: 0, output: second });
        expect(await request(stage.read)).toEqual({ error: errno.EBADMSG, output: empty });
        expect(await request(stage.read)).toEqual({ error: errno.EBADMSG, output: empty });
        expect(await request(stage.finish)).toEqual({ error: errno.ESTALE, output: empty });
        expect(await readFile(path(), "utf8")).toBe(contents);
        expect(await readFile(journal, "utf8")).toBe(envelope(second));
        expect(await identity(path())).toEqual(beforeStage);
        expect(await identity(journal)).toEqual(beforeMain);
      });

      it.each([first, second])("refuses a replacement after stage read, including identical bytes", async (replacement) => {
        await privateFile(path(), envelope(first));
        expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
        expect(await request(stage.read)).toEqual({ error: 0, output: first });
        const displaced = `${path()}.saved`;
        await rename(path(), displaced);
        await privateFile(path(), envelope(replacement));
        const before = await identity(path());
        expect(await request(stage.finish)).toEqual({ error: errno.ESTALE, output: empty });
        expect(await identity(path())).toEqual(before);
        expect(await readFile(path(), "utf8")).toBe(envelope(replacement));
        expect(await readFile(displaced, "utf8")).toBe(envelope(first));
      });

      it("refuses changed content even when the stage inode is unchanged", async () => {
        await privateFile(path(), envelope(first));
        expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
        expect(await request(stage.read)).toEqual({ error: 0, output: first });
        const original = await identity(path());
        await writeFile(path(), envelope(second));
        const before = await identity(path());
        expect([before.dev, before.ino]).toEqual([original.dev, original.ino]);
        expect(await request(stage.finish)).toEqual({ error: errno.ESTALE, output: empty });
        expect(await identity(path())).toEqual(before);
        expect(await readFile(path(), "utf8")).toBe(envelope(second));
      });

      it("refuses to finish when the observed stage has disappeared", async () => {
        await privateFile(path(), envelope(first));
        expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
        expect(await request(stage.read)).toEqual({ error: 0, output: first });
        await unlink(path());
        expect(await request(stage.finish)).toEqual({ error: errno.ESTALE, output: empty });
        await expectMissing(path());
      });

      it.each(["symlink", "hardlink"] as const)("refuses an unsafe %s replacement after stage read", async (kind) => {
        await privateFile(path(), envelope(first));
        expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
        expect(await request(stage.read)).toEqual({ error: 0, output: first });
        await rename(path(), `${path()}.saved`);
        const outside = join(sandbox, "outside-stage");
        await privateFile(outside, envelope(second));
        if (kind === "symlink") await symlink(outside, path());
        else await link(outside, path());
        const beforeStage = await identity(path());
        const beforeOutside = await identity(outside);
        expect(await request(stage.finish)).toEqual({ error: errno.EPERM, output: empty });
        expect(await identity(path())).toEqual(beforeStage);
        expect(await identity(outside)).toEqual(beforeOutside);
        expect(await readFile(outside, "utf8")).toBe(envelope(second));
        expect(await readFile(`${path()}.saved`, "utf8")).toBe(envelope(first));
        if (kind === "symlink") expect(await readlink(path())).toBe(outside);
      });

      it("refuses cleanup when the observed main journal is replaced", async () => {
        await privateFile(journal, envelope(first));
        await privateFile(path(), envelope(second));
        expect(await request("R")).toEqual({ error: 0, output: first });
        expect(await request(stage.read)).toEqual({ error: 0, output: second });
        await rename(journal, join(state, "previous-journal"));
        await privateFile(journal, envelope(first));
        const beforeMain = await identity(journal);
        const beforeStage = await identity(path());
        expect(await request(stage.finish)).toEqual({ error: errno.ESTALE, output: empty });
        expect(await identity(journal)).toEqual(beforeMain);
        expect(await identity(path())).toEqual(beforeStage);
        expect(await readFile(journal, "utf8")).toBe(envelope(first));
        expect(await readFile(path(), "utf8")).toBe(envelope(second));
      });
    });
  }

  it("preserves both stages if interrupted writes and deletes collide", async () => {
    await privateFile(temporary, envelope(first));
    await privateFile(deletion, envelope(second));
    const beforeTemporary = await identity(temporary);
    const beforeDeletion = await identity(deletion);
    expect(await request("R")).toEqual({ error: errno.ENOENT, output: empty });
    expect(await request("T")).toEqual({ error: 0, output: first });
    expect(await request("Y")).toEqual({ error: 0, output: second });
    expect(await request("X")).toEqual({ error: errno.EBUSY, output: empty });
    expect(await request("Z")).toEqual({ error: errno.EBUSY, output: empty });
    expect(await identity(temporary)).toEqual(beforeTemporary);
    expect(await identity(deletion)).toEqual(beforeDeletion);
    expect(await readFile(temporary, "utf8")).toBe(envelope(first));
    expect(await readFile(deletion, "utf8")).toBe(envelope(second));
  });

  it("refuses finishing a deletion while a main journal still exists", async () => {
    await privateFile(journal, envelope(first));
    await privateFile(deletion, envelope(second));
    const beforeMain = await identity(journal);
    const beforeDeletion = await identity(deletion);
    expect(await request("R")).toEqual({ error: 0, output: first });
    expect(await request("Y")).toEqual({ error: 0, output: second });
    expect(await request("Z")).toEqual({ error: errno.EBUSY, output: empty });
    expect(await identity(journal)).toEqual(beforeMain);
    expect(await identity(deletion)).toEqual(beforeDeletion);
    expect(await readFile(journal, "utf8")).toBe(envelope(first));
    expect(await readFile(deletion, "utf8")).toBe(envelope(second));
  });

  it("rejects payloads on reads and deletes without changing state", async () => {
    for (const command of ["R", "D", "T", "X", "Y", "Z"] as const) {
      expect(await request(command, "unexpected")).toEqual({ error: errno.EINVAL, output: empty });
    }
    expect(await request("P")).toEqual({ error: errno.EINVAL, output: empty });
    await expectMissing(journal);
    await expectMissing(temporary);
    await expectMissing(deletion);
  });
});
