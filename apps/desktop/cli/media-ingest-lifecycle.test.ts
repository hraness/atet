import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import * as nativeFs from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { operationExitValue, type OperationEffectFailure } from "../application/operation-effects";
import type { RunResult } from "./io";
import { ingestProjectMedia, ingestProjectMediaEffect, type IngestProjectMediaOptions } from "./media-ingest";
import { createMediaIngestPlatform, MediaIngestPlatform } from "./media-ingest-platform";
import { ingestProjectMediaProgram } from "./media-ingest-program";

const probe: RunResult = { exitCode: 0, stderr: "", stdout: JSON.stringify({
  format: { duration: "1", format_name: "wav" },
  streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 1, sample_rate: "48000", index: 0 }],
}) };

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "atet-import-owner-")));
  const projectDirectory = join(root, "project");
  const imports = join(projectDirectory, "imports");
  await fs.mkdir(imports, { recursive: true, mode: 0o700 });
  const sourcePath = join(root, "source.wav");
  const bytes = Buffer.alloc(180_001, 71);
  await fs.writeFile(sourcePath, bytes);
  let probes = 0;
  const options: IngestProjectMediaOptions = {
    repositoryRoot: root, projectDirectory, sourcePath, now: new Date("2026-09-07T00:00:00Z"),
    role: "portable-audio", ffprobe: "fixture-probe", runner: { run: () => { probes += 1; return Promise.resolve(probe); } },
  };
  return { root, imports, options, bytes, probes: () => probes };
}

function nativeCauses(cause: Cause.Cause<OperationEffectFailure>): unknown[] {
  return Array.from(Cause.failures(cause)).flatMap(failure => [failure.cause,
    ...(failure.priorCause === undefined ? [] : nativeCauses(failure.priorCause))]);
}

async function rejected<A>(exit: Exit.Exit<A, OperationEffectFailure>): Promise<unknown> {
  return await Promise.resolve().then(() => operationExitValue(exit)).then(
    () => { throw new Error("Expected rejection."); }, (reason: unknown) => reason,
  );
}

async function reached<A, B>(signal: Promise<A>, completion: Promise<B>): Promise<A> {
  return await Promise.race([signal, completion.then(() => { throw new Error("Native seam was not reached."); })]);
}

async function turn(): Promise<void> { await new Promise<void>(resolve => { setImmediate(resolve); }); }

test.each(["source", "temporary"] as const)("late %s acquisition retains its descriptor until cancellation cleanup settles", async kind => {
  const input = await fixture();
  const started = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const nativeOpen = fs.open;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (kind === "source" ? args[0] === input.options.sourcePath : String(args[0]).endsWith(".tmp")) {
      started.resolve(handle.fd); await release.promise;
    }
    return handle;
  });
  const fiber = Effect.runFork(ingestProjectMediaEffect(input.options));
  let settled = false;
  const completion = Effect.runPromise(Fiber.await(fiber)).then(exit => { settled = true; return exit; });
  try {
    const fd = await reached(started.promise, completion);
    await Effect.runPromise(Fiber.interruptFork(fiber)); await turn();
    expect(settled).toBe(false); expect(fstatSync(fd).isFile()).toBe(true);
    release.resolve();
    expect(Exit.isFailure(await completion)).toBe(true);
    expect(() => fstatSync(fd)).toThrow();
    expect(input.probes()).toBe(0);
    expect(await fs.readdir(input.imports)).toEqual([]);
  } finally {
    release.resolve(); await completion; openSpy.mockRestore();
    await fs.rm(input.root, { recursive: true, force: true });
  }
});

test.each([undefined, null, false])("source close %p after completed staging keeps its rejection and private cleanup failure", async closeFailure => {
  const input = await fixture();
  const started = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const cleanupFailure = new Error("private removal failure");
  const nativeOpen = fs.open;
  const nativeRm = fs.rm;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === input.options.sourcePath) {
      const close = handle.close.bind(handle);
      handle.close = async () => { started.resolve(handle.fd); await release.promise; await close(); throw closeFailure; };
    }
    return handle;
  });
  const removeSpy = spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith(".tmp")) throw cleanupFailure;
    await nativeRm(...args);
  });
  let settled = false;
  const completion = Effect.runPromiseExit(ingestProjectMediaEffect(input.options)).then(exit => { settled = true; return exit; });
  try {
    const fd = await reached(started.promise, completion);
    expect(fstatSync(fd).isFile()).toBe(true); expect(settled).toBe(false);
    expect(await fs.readdir(input.imports)).toHaveLength(1); expect(input.probes()).toBe(0);
    release.resolve();
    const exit = await completion;
    expect(await rejected(exit)).toBe(closeFailure);
    if (Exit.isFailure(exit)) expect(nativeCauses(exit.cause)).toEqual([closeFailure, cleanupFailure]);
    expect(() => fstatSync(fd)).toThrow(); expect(input.probes()).toBe(0);
  } finally {
    release.resolve(); await completion; openSpy.mockRestore(); removeSpy.mockRestore();
    await nativeRm(input.root, { recursive: true, force: true });
  }
});

test("source close failure after staging removes its proven temporary inode", async () => {
  const input = await fixture();
  const failure = new Error("source close");
  const nativeOpen = fs.open;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === input.options.sourcePath) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw failure; };
    }
    return handle;
  });
  try {
    await expect(ingestProjectMedia(input.options)).rejects.toBe(failure);
    expect(await fs.readdir(input.imports)).toEqual([]); expect(input.probes()).toBe(0);
  } finally { openSpy.mockRestore(); await fs.rm(input.root, { recursive: true, force: true }); }
});

test("ordinary failed-stage cleanup preserves temp-close, removal, source-close precedence with falsey failures", async () => {
  const input = await fixture();
  const primary = new Error("fsync failed");
  const nativeOpen = fs.open;
  const nativeRm = fs.rm;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    const close = handle.close.bind(handle);
    if (args[0] === input.options.sourcePath) handle.close = async () => { await close(); throw undefined; };
    else if (String(args[0]).endsWith(".tmp")) handle.close = async () => { await close(); throw false; };
    return handle;
  });
  const removeSpy = spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith(".tmp")) throw null;
    await nativeRm(...args);
  });
  try {
    const exit = await Effect.runPromiseExit(ingestProjectMediaEffect({ ...input.options, durability: {
      syncFile: () => Promise.reject(primary), syncDirectory: () => Promise.resolve(),
    } }));
    expect(await rejected(exit)).toBeUndefined();
    if (Exit.isFailure(exit)) expect(nativeCauses(exit.cause)).toEqual([undefined, null, false, primary]);
    expect(input.probes()).toBe(0);
  } finally { openSpy.mockRestore(); removeSpy.mockRestore(); await nativeRm(input.root, { recursive: true, force: true }); }
});

test("interrupted probe joins its native rejection before removing staging and never links a destination", async () => {
  const input = await fixture();
  const started = Promise.withResolvers<string>();
  const release = Promise.withResolvers<RunResult>();
  const fiber = Effect.runFork(ingestProjectMediaEffect({ ...input.options, runner: { run: argv => {
    started.resolve(argv.at(-1)!); return release.promise;
  } } }));
  let settled = false;
  const completion = Effect.runPromise(Fiber.await(fiber)).then(exit => { settled = true; return exit; });
  try {
    const staged = await reached(started.promise, completion);
    await Effect.runPromise(Fiber.interruptFork(fiber)); await turn();
    expect(settled).toBe(false); expect(await fs.readFile(staged)).toEqual(input.bytes);
    release.reject(false);
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(nativeCauses(exit.cause)).toContain(false);
    expect(await fs.readdir(input.imports)).toEqual([]);
  } finally { release.resolve(probe); await completion; await fs.rm(input.root, { recursive: true, force: true }); }
});

test("commit interruption joins the admitted link durability before staged disposal and retains the published blob", async () => {
  const input = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let directorySyncs = 0;
  const fiber = Effect.runFork(ingestProjectMediaEffect({ ...input.options, durability: {
    syncFile: handle => handle.sync(),
    async syncDirectory(path) {
      directorySyncs += 1;
      if (directorySyncs === 1) { started.resolve(); await release.promise; }
      const handle = await fs.open(path, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    },
  } }));
  let settled = false;
  const completion = Effect.runPromise(Fiber.await(fiber)).then(exit => { settled = true; return exit; });
  try {
    await reached(started.promise, completion);
    await Effect.runPromise(Fiber.interruptFork(fiber)); await turn();
    expect(settled).toBe(false); expect(directorySyncs).toBe(1);
    expect(await fs.readdir(input.imports)).toHaveLength(2);
    release.resolve(); expect(Exit.isFailure(await completion)).toBe(true);
    expect(directorySyncs).toBe(2);
    const entries = await fs.readdir(input.imports);
    expect(entries).toEqual([`${createHash("sha256").update(input.bytes).digest("hex")}.media`]);
    expect(await fs.readFile(join(input.imports, entries[0]!))).toEqual(input.bytes);
  } finally { release.resolve(); await completion; await fs.rm(input.root, { recursive: true, force: true }); }
});

test("orphan repair retains a substituted entry and keeps source-close rejection public", async () => {
  const input = await fixture();
  const failure = new Error("source close failed");
  const nativeOpen = fs.open;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === input.options.sourcePath) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        const [staged] = await fs.readdir(input.imports);
        if (staged === undefined) throw new Error("Missing staged entry.");
        await fs.rename(join(input.imports, staged), join(input.imports, "retained-owned-inode"));
        await fs.writeFile(join(input.imports, staged), "unowned replacement");
        await close(); throw failure;
      };
    }
    return handle;
  });
  try {
    const exit = await Effect.runPromiseExit(ingestProjectMediaEffect(input.options));
    expect(await rejected(exit)).toBe(failure);
    const entries = await fs.readdir(input.imports);
    expect(entries).toHaveLength(2);
    expect(await fs.readFile(join(input.imports, entries.find(name => name.endsWith(".tmp"))!), "utf8")).toBe("unowned replacement");
    expect((await fs.readFile(join(input.imports, "retained-owned-inode"))).equals(input.bytes)).toBe(true);
    if (Exit.isFailure(exit)) expect(nativeCauses(exit.cause)[1]).toMatchObject({ code: "conflict" });
  } finally { openSpy.mockRestore(); await fs.rm(input.root, { recursive: true, force: true }); }
});

test("exclusive-open refusal does not authorize deleting the pre-existing staged name", async () => {
  const input = await fixture();
  const name = ".import-collision.tmp";
  await fs.writeFile(join(input.imports, name), "existing entry");
  const live = createMediaIngestPlatform();
  try {
    const exit = await Effect.runPromiseExit(ingestProjectMediaProgram(input.options).pipe(Effect.provide(Layer.succeed(MediaIngestPlatform, {
      ...live, uniqueName: () => Effect.succeed(name),
    }))));
    expect(await rejected(exit)).toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(join(input.imports, name), "utf8")).toBe("existing entry");
    expect(input.probes()).toBe(0);
  } finally { await fs.rm(input.root, { recursive: true, force: true }); }
});

/** Native overloads stay intact; the tested production call uses positional bytes. */
function holdPartialWrites(handle: fs.FileHandle, start: () => void, release: Promise<void>, observed: { active: number; maximum: number; calls: number }): void {
  const original = handle.write.bind(handle);
  function write<T extends NodeJS.ArrayBufferView>(buffer: T, offset?: number | null, length?: number | null, position?: number | null): Promise<{ bytesWritten: number; buffer: T }>;
  function write<T extends Uint8Array>(buffer: T, options?: { offset?: number; length?: number; position?: number }): Promise<{ bytesWritten: number; buffer: T }>;
  function write(data: string, position?: number | null, encoding?: BufferEncoding | null): Promise<{ bytesWritten: number; buffer: string }>;
  async function write(data: string | NodeJS.ArrayBufferView, offset?: number | null | { offset?: number; length?: number; position?: number }, length?: number | BufferEncoding | null, position?: number | null) {
    if (typeof data === "string") return await original(data, typeof offset === "number" ? offset : null, typeof length === "string" ? length : undefined);
    if (typeof offset === "object" && offset !== null) {
      return await original(data, offset.offset, offset.length, offset.position);
    }
    observed.active += 1; observed.calls += 1; observed.maximum = Math.max(observed.maximum, observed.active);
    try {
      start(); await release;
      return await original(data, offset, Math.min(typeof length === "number" ? length : data.byteLength, 997), position);
    } finally { observed.active -= 1; }
  }
  handle.write = write;
}

test("the actual native stream waits for partial-write settlement and preserves backpressure and exact content", async () => {
  const input = await fixture();
  const started = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const observed = { active: 0, maximum: 0, calls: 0 };
  const nativeOpen = fs.open;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]).endsWith(".tmp")) holdPartialWrites(handle, () => started.resolve(handle.fd), release.promise, observed);
    return handle;
  });
  let settled = false;
  const completion = ingestProjectMedia(input.options).then(value => { settled = true; return value; });
  try {
    const fd = await reached(started.promise, completion); await turn();
    expect(settled).toBe(false); expect(input.probes()).toBe(0); expect(observed.calls).toBe(1);
    expect(fstatSync(fd).size).toBe(0);
    release.resolve(); const result = await completion;
    expect(observed.maximum).toBe(1); expect(observed.calls).toBeGreaterThan(180);
    expect(() => fstatSync(fd)).toThrow();
    expect(await fs.readFile(result.absolutePath)).toEqual(input.bytes);
    expect(result.asset.source).toMatchObject({ sourceSha256: createHash("sha256").update(input.bytes).digest("hex") });
  } finally { release.resolve(); await completion; openSpy.mockRestore(); await fs.rm(input.root, { recursive: true, force: true }); }
});

test.each([undefined, null, false])("native writer rejection %p is a failure, never successful empty publication", async reason => {
  const input = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed = { active: 0, maximum: 0, calls: 0 };
  const nativeOpen = fs.open;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]).endsWith(".tmp")) holdPartialWrites(handle, () => started.resolve(), release.promise, observed);
    return handle;
  });
  const completion = Effect.runPromiseExit(ingestProjectMediaEffect(input.options));
  try {
    await reached(started.promise, completion); release.reject(reason);
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await rejected(exit)).toBe(reason);
    expect(input.probes()).toBe(0); expect(await fs.readdir(input.imports)).toEqual([]);
  } finally { release.resolve(); await completion; openSpy.mockRestore(); await fs.rm(input.root, { recursive: true, force: true }); }
});

test("source pipeline failure joins an already admitted write and retains its late failure privately", async () => {
  const input = await fixture();
  await fs.writeFile(input.options.sourcePath, Buffer.alloc(2 * 1024 * 1024, 31));
  const primary = new Error("native source stream failed");
  const lateWriterCause = false;
  const started = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const observed = { active: 0, maximum: 0, calls: 0 };
  const nativeOpen = fs.open;
  let sourceStream: ReturnType<fs.FileHandle["createReadStream"]> | undefined;
  const nativeCreateReadStream = nativeFs.createReadStream;
  const streamSpy = spyOn(nativeFs, "createReadStream").mockImplementation((...args) => {
    sourceStream = nativeCreateReadStream(...args); return sourceStream;
  });
  let sourceCloses = 0;
  let stagedCloses = 0;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    const close = handle.close.bind(handle);
    if (args[0] === input.options.sourcePath) {
      handle.close = async () => { sourceCloses += 1; await close(); };
    } else if (String(args[0]).endsWith(".tmp")) {
      holdPartialWrites(handle, () => started.resolve(handle.fd), release.promise, observed);
      handle.close = async () => { stagedCloses += 1; await close(); };
    }
    return handle;
  });
  let settled = false;
  const completion = Effect.runPromiseExit(ingestProjectMediaEffect(input.options)).then(exit => { settled = true; return exit; });
  try {
    const fd = await reached(started.promise, completion);
    if (sourceStream === undefined) throw new Error("Production source stream was not created.");
    sourceStream.destroy(primary);
    await turn(); await turn();
    expect(settled).toBe(false);
    expect(sourceCloses).toBe(0); expect(stagedCloses).toBe(0);
    expect(fstatSync(fd).isFile()).toBe(true);
    expect(await fs.readdir(input.imports)).toHaveLength(1);
    release.reject(lateWriterCause);
    const exit = await completion;
    expect(await rejected(exit)).toBe(primary);
    if (Exit.isFailure(exit)) expect(nativeCauses(exit.cause)).toEqual([primary, lateWriterCause]);
    expect(sourceCloses).toBe(1); expect(stagedCloses).toBe(1); expect(observed.active).toBe(0);
    expect(input.probes()).toBe(0); expect(await fs.readdir(input.imports)).toEqual([]);
    expect(Object.keys(primary)).toEqual([]);
  } finally { release.resolve(); await completion; openSpy.mockRestore(); streamSpy.mockRestore(); await fs.rm(input.root, { recursive: true, force: true }); }
});

function holdNativeRead(handle: fs.FileHandle, started: () => void, release: Promise<void>): void {
  const original = handle.read.bind(handle);
  function read<T extends NodeJS.ArrayBufferView>(buffer: T, offset?: number | null, length?: number | null, position?: nativeFs.ReadPosition | null): Promise<fs.FileReadResult<T>>;
  function read<T extends NodeJS.ArrayBufferView>(buffer: T, options?: nativeFs.ReadOptions): Promise<fs.FileReadResult<T>>;
  function read<T extends NodeJS.ArrayBufferView = Buffer>(options?: nativeFs.ReadOptionsWithBuffer<T>): Promise<fs.FileReadResult<T>>;
  async function read(bufferOrOptions: NodeJS.ArrayBufferView | nativeFs.ReadOptionsWithBuffer<NodeJS.ArrayBufferView> = {}, offset?: number | null | nativeFs.ReadOptions, length?: number | null, position?: nativeFs.ReadPosition | null) {
    const result = ArrayBuffer.isView(bufferOrOptions)
      ? typeof offset === "object" && offset !== null
        ? await original(bufferOrOptions, offset)
        : await original(bufferOrOptions, offset, length, position)
      : await original(bufferOrOptions);
    started(); await release;
    return result;
  }
  handle.read = read;
}

test.each([undefined, null, false])("native read rejection %p remains a failure instead of a successful EOF", async reason => {
  const input = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeOpen = fs.open;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === input.options.sourcePath) holdNativeRead(handle, () => started.resolve(), release.promise);
    return handle;
  });
  const completion = Effect.runPromiseExit(ingestProjectMediaEffect(input.options));
  try {
    await reached(started.promise, completion); release.reject(reason);
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true); expect(await rejected(exit)).toBe(reason);
    expect(input.probes()).toBe(0); expect(await fs.readdir(input.imports)).toEqual([]);
  } finally { release.resolve(); await completion; openSpy.mockRestore(); await fs.rm(input.root, { recursive: true, force: true }); }
});

test("stream destruction joins a held native read before source close and retains its late rejection", async () => {
  const input = await fixture();
  const started = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const primary = new Error("independent stream destruction");
  const nativeOpen = fs.open;
  const nativeCreateReadStream = nativeFs.createReadStream;
  let stream: nativeFs.ReadStream | undefined;
  let closes = 0;
  const streamSpy = spyOn(nativeFs, "createReadStream").mockImplementation((...args) => {
    stream = nativeCreateReadStream(...args); return stream;
  });
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === input.options.sourcePath) {
      holdNativeRead(handle, () => started.resolve(handle.fd), release.promise);
      const close = handle.close.bind(handle);
      handle.close = async () => { closes += 1; await close(); };
    }
    return handle;
  });
  let settled = false;
  const completion = Effect.runPromiseExit(ingestProjectMediaEffect(input.options)).then(exit => { settled = true; return exit; });
  try {
    const fd = await reached(started.promise, completion);
    if (stream === undefined) throw new Error("The production stream was not created.");
    stream.destroy(primary); await turn(); await turn();
    expect(settled).toBe(false); expect(closes).toBe(0);
    expect(fstatSync(fd).isFile()).toBe(true); expect(await fs.readdir(input.imports)).toHaveLength(1);
    release.reject(null);
    const exit = await completion;
    expect(await rejected(exit)).toBe(primary);
    if (Exit.isFailure(exit)) expect(nativeCauses(exit.cause)).toEqual([primary, null]);
    expect(closes).toBe(1); expect(() => fstatSync(fd)).toThrow();
    expect(input.probes()).toBe(0); expect(await fs.readdir(input.imports)).toEqual([]);
  } finally { release.resolve(); await completion; openSpy.mockRestore(); streamSpy.mockRestore(); await fs.rm(input.root, { recursive: true, force: true }); }
});
