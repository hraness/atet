import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";
import { createHostResourceCoordinator } from "@hraness/atet/host-resources";

import { OperationRegistry } from "../application/registry";
import type { OperationDefinition } from "../application/operation";
import { bundleWorkflowSource } from "./source-bundle";
import {
  MAX_CODE_WORKER_POOL_SIZE,
  buildInCodeWorker,
  consumeCodeWorkerDiagnosticBarriers,
  startCodeWorker,
  startCodeWorkerPool,
  waitForCodeWorkerResponseDiagnostics,
  type CodeWorkerBundle,
  type CodeWorkerPool,
  type CodeWorkerSession,
} from "./worker-client";
import {
  CODE_WORKER_PROTOCOL,
  CodeWorkerMessageSchema,
  encodeCodeWorkerDiagnosticBarrier,
} from "./worker-protocol";
import {
  captureWorkerProcessStartIdentity,
  workerProcessStartIdentityStatus,
} from "./worker-process-identity";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atet-code-client-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await Bun.file(path).exists()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}.`);
    }
    await Bun.sleep(10);
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolveExit => child.once("exit", () => resolveExit()));
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object"
      && error !== null
      && "code" in error
      && Reflect.get(error, "code") === "ESRCH"
    );
  }
}

async function waitForExactWorkerRetirement(
  processId: number,
  processStartIdentity: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (
    workerProcessStartIdentityStatus(processId, processStartIdentity)
    !== "different-or-dead"
  ) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for exact worker ${String(processId)} to retire.`,
      );
    }
    await Bun.sleep(10);
  }
}

async function terminateExactWorker(
  processId: number,
  processStartIdentity: string,
): Promise<void> {
  if (
    workerProcessStartIdentityStatus(processId, processStartIdentity)
    === "exact-live-worker"
  ) {
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || Reflect.get(error, "code") !== "ESRCH"
      ) {
        throw error;
      }
    }
  }
  await waitForExactWorkerRetirement(processId, processStartIdentity);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    await rm(directory, { force: true, recursive: true });
  }));
});

function registry(): OperationRegistry {
  const operation = {
    inputSchema: z.strictObject({ project: z.string() }),
    inputSchemaId: "test.snapshot.input/v1",
    kind: "project.snapshot",
    lifecycle: {
      kind: "pure",
      execute: (_context, input) => Promise.resolve({ project: input.project }),
    },
    outputSchema: z.strictObject({ project: z.string() }),
    outputSchemaId: "test.snapshot.output/v1",
    policy: {
      cache: "content-addressed",
      cancellable: true,
      effect: "pure",
      maxDurationMs: 1_000,
      maxFanOut: 0,
      maxInputBytes: 1_024,
      maxOutputBytes: 1_024,
      preparation: [],
      resources: [{ amount: 1, resource: "cpu" }],
      resume: "deterministic",
    },
    summarize: output => ({
      fields: { project: output.project },
      kind: "project.snapshot",
    }),
    version: 1,
  } satisfies OperationDefinition<
    "project.snapshot",
    { project: string },
    { project: string }
  >;
  const result = new OperationRegistry();
  result.register(operation);
  return result;
}

function inertBundle(): CodeWorkerBundle {
  const bytes = new TextEncoder().encode("export default {};\n");
  return {
    bytes,
    externalImports: [],
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function writeRuntimeMismatchWorker(
  root: string,
  mismatch: "bunRevision" | "bunVersion",
): Promise<string> {
  const workerEntryPath = join(root, `runtime-mismatch-${mismatch}.ts`);
  await writeFile(workerEntryPath, `
    import { createHash } from "node:crypto";
    import { once } from "node:events";
    import { readFileSync } from "node:fs";
    import { createConnection } from "node:net";
    import { fileURLToPath } from "node:url";

    function argument(name) {
      const index = process.argv.indexOf(name);
      const value = index === -1 ? undefined : process.argv[index + 1];
      if (value === undefined) throw new Error("Missing " + name);
      return value;
    }

    const socket = createConnection({ path: argument("--socket") });
    await once(socket, "connect");
    const workerEntrySha256 = createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex");
    const body = Buffer.from(JSON.stringify({
      bunRevision: ${
        mismatch === "bunRevision"
          ? JSON.stringify("0".repeat(40))
          : "Bun.revision"
      },
      bunVersion: ${
        mismatch === "bunVersion"
          ? JSON.stringify("0.0.0-attestation-mismatch")
          : "Bun.version"
      },
      bundleSha256: argument("--sha256"),
      generation: 1,
      kind: "hello",
      protocol: "atet.code-worker/v5",
      workerEntrySha256,
    }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.byteLength);
    socket.write(Buffer.concat([header, body]));
    await once(socket, "close");
  `);
  return workerEntryPath;
}

describe("trusted code worker client", () => {
  test("holds a response until its diagnostic barrier is observed", async () => {
    const requestId = "build_response_before_diagnostics";
    let resolveDiagnostics: () => void = () => undefined;
    let resolveResponse: (
      response: ReturnType<typeof CodeWorkerMessageSchema.parse>,
    ) => void = () => undefined;
    const diagnostics = new Promise<void>(resolve => {
      resolveDiagnostics = resolve;
    });
    const response = new Promise<ReturnType<typeof CodeWorkerMessageSchema.parse>>(
      resolve => {
        resolveResponse = resolve;
      },
    );
    const responseMessage = CodeWorkerMessageSchema.parse({
      diagnosticBarrier: requestId,
      generation: 1,
      kind: "response",
      output: { built: true },
      protocol: CODE_WORKER_PROTOCOL,
      requestId,
      status: "ok",
    });
    const guarded = waitForCodeWorkerResponseDiagnostics(
      response,
      diagnostics,
      requestId,
    );
    let settled = false;
    void guarded.then(() => {
      settled = true;
    });

    resolveResponse(responseMessage);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(settled).toBe(false);
    resolveDiagnostics();
    expect((await guarded).requestId).toBe(requestId);
    expect(settled).toBe(true);
  });

  test("recognizes an exact diagnostic marker across every byte split", () => {
    const barrier = "build_fragmented_diagnostics";
    const marker = Buffer.from(encodeCodeWorkerDiagnosticBarrier(
      barrier,
      "stderr",
    ));
    const prefix = Buffer.from([0xff, 0x00, 0x61]);
    const suffix = Buffer.from([0xfe, 0x62]);
    const complete = Buffer.concat([prefix, marker, suffix]);

    for (let split = 0; split <= marker.byteLength; split += 1) {
      const first = Buffer.concat([prefix, marker.subarray(0, split)]);
      const before = consumeCodeWorkerDiagnosticBarriers(
        first,
        "stderr",
        [barrier],
      );
      const after = consumeCodeWorkerDiagnosticBarriers(
        Buffer.concat([before.diagnostics, marker.subarray(split), suffix]),
        "stderr",
        [barrier],
      );
      expect(before.observed).toEqual(split === marker.byteLength ? [barrier] : []);
      expect(after.observed).toEqual(split === marker.byteLength ? [] : [barrier]);
      expect(after.diagnostics).toEqual(Buffer.concat([prefix, suffix]));
    }

    expect(consumeCodeWorkerDiagnosticBarriers(
      complete,
      "stdout",
      [barrier],
    )).toEqual({ diagnostics: complete, observed: [] });
  });

  test("waits for both diagnostic streams before returning a private-socket build", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineWorkflow } from "@hraness/atet/local/code";
      console.log("trusted top-level diagnostic");
      export default defineWorkflow({
        id: "worker-fixture",
        version: 1,
        inputSchemaId: "test.workflow.input/v1",
        inputSchema: z.strictObject({ project: z.string() }),
        build(w, input) {
          console.error("trusted build diagnostic");
          return {
            snapshot: w.operationByKind("snapshot", {
              input: { project: input.project },
              kind: "project.snapshot",
              version: 1,
            }),
          };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const built = await buildInCodeWorker({
      bundle,
      registry: registry(),
      temporaryRoot: root,
      workflowInput: { project: "project_test" },
    });

    expect(built.graph.nodes).toHaveLength(1);
    expect(built.graph.nodes[0]).toMatchObject({
      input: { project: "project_test" },
      key: "snapshot",
      executor: {
        kind: "operation",
        operation: { kind: "project.snapshot", version: 1 },
      },
    });
    expect(built.diagnostics.stdout).toContain("trusted top-level diagnostic");
    expect(built.diagnostics.stderr).toContain("trusted build diagnostic");
    expect(built.diagnostics.stdout).not.toContain("atet.code-worker/v5:diagnostics");
    expect(built.diagnostics.stderr).not.toContain("atet.code-worker/v5:diagnostics");
  });

  for (const mismatch of ["bunVersion", "bunRevision"] as const) {
    test(`rejects a child ${mismatch} mismatch during runtime attestation`, async () => {
      const root = await temporaryDirectory();
      const workerEntryPath = await writeRuntimeMismatchWorker(root, mismatch);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(startCodeWorker({
        bunExecutable: process.execPath,
        bundle: inertBundle(),
        temporaryRoot: root,
        workerEntryPath,
      })).rejects.toThrow("runtime attestation mismatch");
      expect((await readdir(root)).filter(name => (
        name.startsWith("atet-code-worker-")
      ))).toEqual([]);
    });
  }

  test("rejects an entry wrapper that does not match the executing worker bytes", async () => {
    const root = await temporaryDirectory();
    const workerEntryPath = join(root, "worker-wrapper.ts");
    await writeFile(
      workerEntryPath,
      `await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "worker-entry.ts")).href)});\n`,
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(startCodeWorker({
      bundle: inertBundle(),
      temporaryRoot: root,
      workerEntryPath,
    })).rejects.toThrow("entry-byte attestation mismatch");
    expect((await readdir(root)).filter(name => (
      name.startsWith("atet-code-worker-")
    ))).toEqual([]);
  });

  test("rebuilds persisted normalized input without applying schema transforms twice", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineWorkflow } from "@hraness/atet/local/code";
      export default defineWorkflow({
        id: "worker-transformed-input",
        version: 1,
        inputSchemaId: "test.workflow.transformed-input/v1",
        inputSchema: z.strictObject({ project: z.string() }).transform(input => ({
          project: input.project + "!",
        })),
        build(w, input) {
          return {
            snapshot: w.operationByKind("snapshot", {
              input: { project: input.project },
              kind: "project.snapshot",
              version: 1,
            }),
          };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const build = async (
      input: unknown,
      inputMode: "parsed" | "raw",
    ) => {
      const session = await startCodeWorker({
        bunExecutable: process.execPath,
        bundle,
        temporaryRoot: root,
      });
      try {
        return await session.build(registry(), input, inputMode);
      } finally {
        await session.close();
      }
    };
    const firstSession = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    const planned = await firstSession.build(
      registry(),
      { project: "project_test" },
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(firstSession.build(
      registry(),
      planned.input,
      "parsed",
    )).rejects.toThrow("already consumed");
    await firstSession.close();
    expect(planned.input).toEqual({ project: "project_test!" });
    const replayed = await build(planned.input, "parsed");
    expect(replayed.input).toEqual(planned.input);
    expect(replayed.graph).toEqual(planned.graph);
    const incorrectlyReparsed = await build(planned.input, "raw");
    expect(incorrectlyReparsed.input).toEqual({ project: "project_test!!" });
  }, 15_000);

  test("fails closed when diagnostics exceed their independent bound", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineWorkflow } from "@hraness/atet/local/code";
      console.log("x".repeat(2048));
      export default defineWorkflow({
        id: "worker-noisy",
        version: 1,
        inputSchemaId: "test.workflow.input/v1",
        inputSchema: z.strictObject({}),
        build() { throw new Error("unreachable"); },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(buildInCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      maximumDiagnosticBytes: 128,
      registry: registry(),
      temporaryRoot: root,
      workflowInput: {},
    })).rejects.toThrow("diagnostic bound");
  });

  test("executes only a built schema-bound compute callback", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

      const decorate = defineCompute({
        key: "fixture.decorate",
        inputSchemaId: "test.compute.decorate-input/v1",
        outputSchemaId: "test.compute.decorate-output/v1",
        inputSchema: z.strictObject({ value: z.string() }),
        outputSchema: z.strictObject({ decorated: z.string() }),
        run(input, context) {
          console.log("compute " + context.nodeKey);
          return { decorated: input.value + "!" };
        },
      });

      export default defineWorkflow({
        id: "worker-compute",
        version: 1,
        inputSchemaId: "test.workflow.compute-input/v1",
        inputSchema: z.strictObject({ value: z.string() }),
        build(w, input) {
          return { output: w.compute("decorate", decorate, input) };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const session = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    try {
      const built = await session.build(registry(), { value: "hello" });
      expect(built.graph.nodes[0]).toMatchObject({
        executor: {
          compute: { key: "fixture.decorate", version: 1 },
          kind: "compute",
        },
        key: "decorate",
      });
      expect(await session.compute({
        computeKey: "fixture.decorate",
        input: { value: "hello" },
        nodeKey: "decorate",
        replayAcknowledged: false,
      })).toEqual({ decorated: "hello!" });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(session.compute({
        computeKey: "fixture.missing",
        input: { value: "hello" },
        nodeKey: "decorate",
        replayAcknowledged: false,
      })).rejects.toThrow("Unknown compute callback");
      expect(session.diagnostics().stdout).toContain("compute decorate");
    } finally {
      await session.close();
    }
  });

  test("rejects a compute result that exceeds the graph-declared byte bound", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

      const oversized = defineCompute({
        key: "fixture.oversized",
        inputSchemaId: "test.compute.oversized-input/v1",
        outputSchemaId: "test.compute.oversized-output/v1",
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ value: z.string() }),
        maxOutputBytes: 64,
        run() {
          return { value: "x".repeat(1_024) };
        },
      });

      export default defineWorkflow({
        id: "worker-oversized",
        version: 1,
        inputSchemaId: "test.workflow.oversized-input/v1",
        inputSchema: z.strictObject({}),
        build(w) {
          return { output: w.compute("oversized", oversized, {}) };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const session = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    try {
      await session.build(registry(), {});
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(session.compute({
        computeKey: "fixture.oversized",
        input: {},
        nodeKey: "oversized",
        replayAcknowledged: false,
      })).rejects.toThrow("exceeds its bound");
    } finally {
      await session.close();
    }
  });

  test("rejects an outstanding compute when its worker exits cleanly", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

      const cleanExit = defineCompute({
        key: "fixture.clean-exit",
        inputSchemaId: "test.compute.clean-exit-input/v1",
        outputSchemaId: "test.compute.clean-exit-output/v1",
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ unreachable: z.boolean() }),
        run() {
          process.exit(0);
        },
      });

      export default defineWorkflow({
        id: "worker-clean-exit",
        version: 1,
        inputSchemaId: "test.workflow.clean-exit-input/v1",
        inputSchema: z.strictObject({}),
        build(w) {
          return { output: w.compute("clean-exit", cleanExit, {}) };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const session = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    try {
      await session.build(registry(), {});
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(session.compute({
        computeKey: "fixture.clean-exit",
        input: {},
        nodeKey: "clean-exit",
        replayAcknowledged: false,
        timeoutMs: 5_000,
      })).rejects.toThrow("exited before completing (code 0, signal null)");
    } finally {
      await session.close();
    }
  }, 10_000);

  test("cooperatively aborts an in-flight compute through its exact signal", async () => {
    const root = await temporaryDirectory();
    const cancellationMarker = join(root, "compute-cancelled.json");
    const readyMarker = join(root, "compute-ready.json");
    await writeFile(join(root, "workflow.ts"), `
      import { writeFileSync } from "node:fs";
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

      const blocked = defineCompute({
        key: "fixture.blocked",
        inputSchemaId: "test.compute.blocked-input/v1",
        outputSchemaId: "test.compute.blocked-output/v1",
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ stopped: z.boolean() }),
        async run(_input, context) {
          await new Promise((_resolve, reject) => {
            context.abortSignal.addEventListener("abort", () => {
              writeFileSync(
                ${JSON.stringify(cancellationMarker)},
                JSON.stringify({ aborted: context.abortSignal.aborted }),
              );
              reject(context.abortSignal.reason);
            }, { once: true });
            writeFileSync(${JSON.stringify(readyMarker)}, "ready");
          });
          return { stopped: false };
        },
      });

      export default defineWorkflow({
        id: "worker-cancelled",
        version: 1,
        inputSchemaId: "test.workflow.cancelled-input/v1",
        inputSchema: z.strictObject({}),
        build(w) {
          return { output: w.compute("blocked", blocked, {}) };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const session = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    try {
      await session.build(registry(), {});
      const controller = new AbortController();
      const computation = session.compute({
        abortSignal: controller.signal,
        computeKey: "fixture.blocked",
        input: {},
        nodeKey: "blocked",
        replayAcknowledged: false,
      });
      await waitForFile(readyMarker);
      controller.abort();
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(computation).rejects.toThrow("was cancelled");
      expect(JSON.parse(await readFile(cancellationMarker, "utf8"))).toEqual({
        aborted: true,
      });
    } finally {
      await session.close();
    }
  }, 15_000);

  test("cancels queued compute without killing the active callback or poisoning the worker", async () => {
    const root = await temporaryDirectory();
    const activeMarker = join(root, "queued-cancel-active");
    await writeFile(join(root, "workflow.ts"), `
      import { writeFileSync } from "node:fs";
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

      const sequenced = defineCompute({
        key: "fixture.queued-cancel",
        inputSchemaId: "test.compute.queued-cancel-input/v1",
        outputSchemaId: "test.compute.queued-cancel-output/v1",
        inputSchema: z.strictObject({ id: z.string(), wait: z.boolean() }),
        outputSchema: z.strictObject({ id: z.string(), pid: z.number().int() }),
        async run(input) {
          if (input.wait) {
            writeFileSync(${JSON.stringify(activeMarker)}, "active");
            const until = Date.now() + 400;
            while (Date.now() < until) { /* finite synchronous authored work */ }
          }
          return { id: input.id, pid: process.pid };
        },
      });

      export default defineWorkflow({
        id: "worker-queued-cancel",
        version: 1,
        inputSchemaId: "test.workflow.queued-cancel-input/v1",
        inputSchema: z.strictObject({}),
        build(w) {
          return {
            active: w.compute("active", sequenced, { id: "active", wait: true }),
            queued: w.compute("queued", sequenced, { id: "queued", wait: false }),
          };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const session = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    try {
      await session.build(registry(), {});
      const active = session.compute({
        computeKey: "fixture.queued-cancel",
        input: { id: "active", wait: true },
        nodeKey: "active",
        replayAcknowledged: false,
      });
      await waitForFile(activeMarker);
      const controller = new AbortController();
      const queued = session.compute({
        abortSignal: controller.signal,
        computeKey: "fixture.queued-cancel",
        input: { id: "queued", wait: false },
        nodeKey: "queued",
        replayAcknowledged: false,
        timeoutMs: 1_000,
      });
      controller.abort();
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(queued).rejects.toThrow("was cancelled");
      await Bun.sleep(300);
      expect(processExists(session.processId)).toBe(true);

      expect(await active).toEqual({ id: "active", pid: session.processId });
      expect(await session.compute({
        computeKey: "fixture.queued-cancel",
        input: { id: "reused", wait: false },
        nodeKey: "queued",
        replayAcknowledged: false,
      })).toEqual({ id: "reused", pid: session.processId });
    } finally {
      await session.close();
    }
  }, 15_000);

  test("publishes session closure before its shutdown handshake", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";
      const identity = defineCompute({
        key: "fixture.close-race",
        inputSchemaId: "test.compute.close-race-input/v1",
        outputSchemaId: "test.compute.close-race-output/v1",
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ value: z.number() }),
        run() { return { value: 1 }; },
      });
      export default defineWorkflow({
        id: "worker-close-race",
        version: 1,
        inputSchemaId: "test.workflow.close-race-input/v1",
        inputSchema: z.strictObject({}),
        build(w) { return { value: w.compute("value", identity, {}) }; },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const session = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    await session.build(registry(), {});
    const closing = session.close();
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(session.compute({
      computeKey: "fixture.close-race",
      input: {},
      nodeKey: "value",
      replayAcknowledged: false,
    })).rejects.toThrow("already closed");
    await closing;
  });

  test("bounds source evaluation and overlaps callbacks only up to the pool size", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "pool-events.jsonl");
    const nodeIds = ["a", "b", "c", "d", "e", "f"] as const;
    await writeFile(join(root, "workflow.ts"), `
      import { appendFileSync } from "node:fs";
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

      const marker = ${JSON.stringify(marker)};
      appendFileSync(marker, JSON.stringify({ kind: "load", pid: process.pid }) + "\\n");
      const delayed = defineCompute({
        key: "fixture.pool-delayed",
        inputSchemaId: "test.compute.pool-delayed-input/v1",
        outputSchemaId: "test.compute.pool-delayed-output/v1",
        inputSchema: z.strictObject({ id: z.string() }),
        outputSchema: z.strictObject({ id: z.string(), pid: z.number().int() }),
        async run(input) {
          appendFileSync(marker, JSON.stringify({
            id: input.id,
            kind: "start",
            pid: process.pid,
          }) + "\\n");
          await Bun.sleep(100);
          appendFileSync(marker, JSON.stringify({
            id: input.id,
            kind: "end",
            pid: process.pid,
          }) + "\\n");
          return { id: input.id, pid: process.pid };
        },
      });

      export default defineWorkflow({
        id: "worker-pool-overlap",
        version: 1,
        inputSchemaId: "test.workflow.pool-overlap-input/v1",
        inputSchema: z.strictObject({}),
        build(w) {
          appendFileSync(marker, JSON.stringify({ kind: "build", pid: process.pid }) + "\\n");
          return {
            a: w.compute("a", delayed, { id: "a" }),
            b: w.compute("b", delayed, { id: "b" }),
            c: w.compute("c", delayed, { id: "c" }),
            d: w.compute("d", delayed, { id: "d" }),
            e: w.compute("e", delayed, { id: "e" }),
            f: w.compute("f", delayed, { id: "f" }),
          };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const initial = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    let owner: CodeWorkerPool | CodeWorkerSession = initial;
    try {
      const built = await initial.build(registry(), {});
      const pool = await startCodeWorkerPool({
        bunExecutable: process.execPath,
        bundle,
        expectedBuild: built,
        initialWorker: { build: built, session: initial },
        maximumWorkers: 64,
        registry: registry(),
        temporaryRoot: root,
        workflowInput: {},
      });
      owner = pool;
      expect(pool.size).toBe(MAX_CODE_WORKER_POOL_SIZE);
      const outputs = await Promise.all(nodeIds.map(async id => (
        await pool.execute({
          computeKey: "fixture.pool-delayed",
          input: { id },
          nodeKey: id,
          replayAcknowledged: false,
        })
      )));
      expect(outputs).toHaveLength(nodeIds.length);
    } finally {
      await owner.close();
    }

    const events = (await readFile(marker, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { readonly kind: string });
    expect(events.filter(event => event.kind === "load")).toHaveLength(
      MAX_CODE_WORKER_POOL_SIZE,
    );
    expect(events.filter(event => event.kind === "build")).toHaveLength(
      MAX_CODE_WORKER_POOL_SIZE,
    );
    let active = 0;
    let maximumActive = 0;
    for (const event of events) {
      if (event.kind === "start") {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
      } else if (event.kind === "end") {
        active -= 1;
      }
      expect(active).toBeLessThanOrEqual(MAX_CODE_WORKER_POOL_SIZE);
    }
    expect(active).toBe(0);
    expect(maximumActive).toBe(MAX_CODE_WORKER_POOL_SIZE);
    expect((await readdir(root)).filter(name => (
      name.startsWith("atet-code-worker-")
    ))).toEqual([]);
  }, 15_000);

  test("rejects and cleans a worker whose rebuilt graph differs from the pool baseline", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineWorkflow } from "@hraness/atet/local/code";

      const loadedPid = process.pid;
      export default defineWorkflow({
        id: "worker-pool-nondeterministic",
        version: 1,
        inputSchemaId: "test.workflow.pool-nondeterministic-input/v1",
        inputSchema: z.strictObject({}),
        build(w) {
          return {
            snapshot: w.operationByKind("snapshot", {
              input: { project: String(loadedPid) },
              kind: "project.snapshot",
              version: 1,
            }),
          };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const initial = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    const built = await initial.build(registry(), {});
    let failure: unknown;
    let unexpectedPool: CodeWorkerPool | undefined;
    try {
      unexpectedPool = await startCodeWorkerPool({
        bunExecutable: process.execPath,
        bundle,
        expectedBuild: built,
        initialWorker: { build: built, session: initial },
        maximumWorkers: 2,
        registry: registry(),
        temporaryRoot: root,
        workflowInput: {},
      });
    } catch (error) {
      failure = error;
    } finally {
      await unexpectedPool?.close().catch(() => undefined);
      await initial.close().catch(() => undefined);
    }
    expect(failure).toHaveProperty(
      "message",
      expect.stringContaining("different workflow graph"),
    );
    expect((await readdir(root)).filter(name => (
      name.startsWith("atet-code-worker-")
    ))).toEqual([]);
  }, 15_000);

  test("pool close joins a worker retirement that already left the live set", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";
      const identity = defineCompute({
        key: "fixture.retirement-join",
        inputSchemaId: "test.compute.retirement-join-input/v1",
        outputSchemaId: "test.compute.retirement-join-output/v1",
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ value: z.number() }),
        run() { return { value: 1 }; },
      });
      export default defineWorkflow({
        id: "worker-retirement-join",
        version: 1,
        inputSchemaId: "test.workflow.retirement-join-input/v1",
        inputSchema: z.strictObject({}),
        build(w) { return { value: w.compute("value", identity, {}) }; },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const baselineWorker = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    const built = await baselineWorker.build(registry(), {});
    await baselineWorker.close();

    let finishRetirement: () => void = () => undefined;
    let markRetirementStarted: () => void = () => undefined;
    const retirementStarted = new Promise<void>(resolveStarted => {
      markRetirementStarted = resolveStarted;
    });
    const retirement = new Promise<void>(resolveRetirement => {
      finishRetirement = resolveRetirement;
    });
    let closeCalls = 0;
    const failingWorker: CodeWorkerSession = {
      build: () => Promise.resolve(built),
      bundleSha256: bundle.sha256,
      close: () => {
        closeCalls += 1;
        markRetirementStarted();
        return retirement;
      },
      compute: () => Promise.reject(new Error("forced worker failure")),
      diagnostics: () => ({ stderr: "", stdout: "" }),
      generation: 1,
      processId: process.pid,
      processStartIdentity: captureWorkerProcessStartIdentity(process.pid),
    };
    const pool = await startCodeWorkerPool({
      bunExecutable: process.execPath,
      bundle,
      expectedBuild: built,
      initialWorker: { build: built, session: failingWorker },
      maximumWorkers: 1,
      registry: registry(),
      temporaryRoot: root,
      workflowInput: {},
    });
    const execution = pool.execute({
      computeKey: "fixture.retirement-join",
      input: {},
      nodeKey: "value",
      replayAcknowledged: false,
    });
    await retirementStarted;
    let closeSettled = false;
    const closing = pool.close().then(() => { closeSettled = true; });
    await Bun.sleep(20);
    expect(closeSettled).toBe(false);
    expect(closeCalls).toBe(1);
    finishRetirement();
    const [executionResult, closeResult] = await Promise.allSettled([
      execution,
      closing,
    ]);
    expect(executionResult.status).toBe("rejected");
    expect(closeResult.status).toBe("fulfilled");
    expect(closeCalls).toBe(1);
  });

  test.skipIf(process.platform === "win32")(
    "releases preparation admission after build while the worker stays alive",
    async () => {
      const root = await temporaryDirectory();
      await writeFile(join(root, "preparation-release.ts"), `
        import { z } from "zod";
        import { defineWorkflow } from "@hraness/atet/local/code";
        export default defineWorkflow({
          id: "preparation-release",
          version: 1,
          inputSchemaId: "test.workflow.preparation-release-input/v1",
          inputSchema: z.strictObject({ project: z.string() }),
          build(w, input) {
            return {
              snapshot: w.operationByKind("snapshot", {
                input: { project: input.project },
                kind: "project.snapshot",
                version: 1,
              }),
            };
          },
        });
      `);
      const bundle = await bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "preparation-release.ts",
      });
      const coordinator = createHostResourceCoordinator({
        profile: {
          capacities: [{ limit: 1, resource: "cpu" }],
          id: "code-worker-preparation-release",
        },
        stateRoot: join(root, "host-resources-preparation-release"),
      });
      let session: CodeWorkerSession | undefined;
      try {
        await coordinator.withLease(
          [{ amount: 1, resource: "cpu" }],
          async lease => {
            session = await startCodeWorker({
              bunExecutable: process.execPath,
              bundle,
              inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
              temporaryRoot: root,
            });
            await session.build(registry(), { project: "project_prep_release" });
          },
          { waitTimeoutMilliseconds: 5_000 },
        );
        let aliveAtReadmission = false;
        await coordinator.withLease(
          [{ amount: 1, resource: "cpu" }],
          () => {
            aliveAtReadmission = processExists(session!.processId);
          },
          { waitTimeoutMilliseconds: 5_000 },
        );
        expect(aliveAtReadmission).toBe(true);
      } finally {
        await session?.close().catch(() => undefined);
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "preserves an untouched worker when cancellation arrives during guardian startup",
    async () => {
      const root = await temporaryDirectory();
      await writeFile(join(root, "guardian-startup-cancel.ts"), `
        import { z } from "zod";
        import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";
        const identity = defineCompute({
          key: "fixture.guardian-startup-cancel",
          inputSchemaId: "test.compute.guardian-startup-cancel-input/v1",
          outputSchemaId: "test.compute.guardian-startup-cancel-output/v1",
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({ pid: z.number().int() }),
          run() { return { pid: process.pid }; },
        });
        export default defineWorkflow({
          id: "guardian-startup-cancel",
          version: 1,
          inputSchemaId: "test.workflow.guardian-startup-cancel-input/v1",
          inputSchema: z.strictObject({}),
          build(w) { return { value: w.compute("value", identity, {}) }; },
        });
      `);
      const bundle = await bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "guardian-startup-cancel.ts",
      });
      const initial = await startCodeWorker({
        bunExecutable: process.execPath,
        bundle,
        temporaryRoot: root,
      });
      let owner: CodeWorkerPool | CodeWorkerSession = initial;
      try {
        const built = await initial.build(registry(), {});
        const pool = await startCodeWorkerPool({
          bunExecutable: process.execPath,
          bundle,
          expectedBuild: built,
          initialWorker: { build: built, session: initial },
          maximumWorkers: 1,
          registry: registry(),
          temporaryRoot: root,
          workflowInput: {},
        });
        owner = pool;
        const coordinator = createHostResourceCoordinator({
          profile: {
            capacities: [{ limit: 1, resource: "cpu" }],
            id: "code-worker-guardian-startup-cancel",
          },
          stateRoot: join(root, "host-resources-guardian-startup-cancel"),
        });
        const controller = new AbortController();
        await coordinator.withLease(
          [{ amount: 1, resource: "cpu" }],
          async lease => {
            const cancelled = pool.execute({
              abortSignal: controller.signal,
              computeKey: "fixture.guardian-startup-cancel",
              inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
              input: {},
              nodeKey: "value",
              replayAcknowledged: false,
            });
            controller.abort();
            // eslint-disable-next-line @typescript-eslint/await-thenable
            await expect(cancelled).rejects.toThrow("was cancelled");
          },
          { waitTimeoutMilliseconds: 5_000 },
        );
        expect(await pool.execute({
          computeKey: "fixture.guardian-startup-cancel",
          input: {},
          nodeKey: "value",
          replayAcknowledged: false,
        })).toEqual({ pid: initial.processId });
      } finally {
        await owner.close();
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "never evaluates authored source when its preparation guardian cannot start",
    async () => {
      const root = await temporaryDirectory();
      const evaluatedMarker = join(root, "unguarded-source-evaluated");
      const wrapperPath = join(root, "guardian-failure-bun");
      await writeFile(wrapperPath, `#!/bin/sh
case "$2" in
  *worker-lease-guardian.ts)
    /bin/sleep 0.3
    exit 37
    ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`);
      await chmod(wrapperPath, 0o700);
      await writeFile(join(root, "guardian-failure.ts"), `
        import { writeFileSync } from "node:fs";
        import { z } from "zod";
        import { defineWorkflow } from "@hraness/atet/local/code";
        writeFileSync(${JSON.stringify(evaluatedMarker)}, "evaluated");
        export default defineWorkflow({
          id: "guardian-failure",
          version: 1,
          inputSchemaId: "test.workflow.guardian-failure-input/v1",
          inputSchema: z.strictObject({}),
          build() { return {}; },
        });
      `);
      const bundle = await bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "guardian-failure.ts",
      });
      const coordinator = createHostResourceCoordinator({
        profile: {
          capacities: [{ limit: 1, resource: "cpu" }],
          id: "code-worker-guardian-failure",
        },
        stateRoot: join(root, "host-resources-guardian-failure"),
      });
      await coordinator.withLease(
        [{ amount: 1, resource: "cpu" }],
        async lease => {
          // eslint-disable-next-line @typescript-eslint/await-thenable
          await expect(startCodeWorker({
            bunExecutable: wrapperPath,
            bundle,
            inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
            temporaryRoot: root,
          })).rejects.toThrow("guardian exited during handshake");
        },
        { waitTimeoutMilliseconds: 5_000 },
      );
      expect(await Bun.file(evaluatedMarker).exists()).toBe(false);
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "guards the preparation lease before spinning authored top-level code can run",
    async () => {
      const root = await temporaryDirectory();
      const hostStateRoot = join(root, "host-resources-preparation-crash");
      const startedPath = join(root, "source-evaluation-started");
      const workflowPath = join(root, "preparation-crash.ts");
      const helperPath = join(root, "preparation-crash-parent.ts");
      const bundlePath = join(root, "preparation-crash.bundle.js");
      const bundleManifestPath = join(root, "preparation-crash.bundle.json");
      const profile = {
        capacities: [{ limit: 1, resource: "cpu" }],
        id: "code-worker-preparation-crash-regression",
      } as const;
      await writeFile(workflowPath, `
        import { writeFileSync } from "node:fs";
        import { z } from "zod";
        import { defineWorkflow } from "@hraness/atet/local/code";

        writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));
        while (true) { /* synchronous authored module evaluation */ }

        export default defineWorkflow({
          id: "preparation-crash",
          version: 1,
          inputSchemaId: "test.workflow.preparation-crash-input/v1",
          inputSchema: z.strictObject({}),
          build() { throw new Error("unreachable"); },
        });
      `);
      const preparedBundle = await bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "preparation-crash.ts",
      });
      await writeFile(bundlePath, preparedBundle.bytes);
      await writeFile(bundleManifestPath, JSON.stringify({
        externalImports: preparedBundle.externalImports,
        sha256: preparedBundle.sha256,
      }));
      const workerClientUrl = pathToFileURL(
        join(import.meta.dir, "worker-client.ts"),
      ).href;
      const registryUrl = pathToFileURL(
        join(import.meta.dir, "../application/registry.ts"),
      ).href;
      const hostResourcesUrl = pathToFileURL(
        join(import.meta.dir, "../../../src/host-resources.ts"),
      ).href;
      await writeFile(helperPath, `
        import { createHostResourceCoordinator } from ${JSON.stringify(hostResourcesUrl)};
        import { OperationRegistry } from ${JSON.stringify(registryUrl)};
        import { startCodeWorker } from ${JSON.stringify(workerClientUrl)};

        const manifest = await Bun.file(${JSON.stringify(bundleManifestPath)}).json();
        const bundle = {
          bytes: new Uint8Array(await Bun.file(${JSON.stringify(bundlePath)}).arrayBuffer()),
          externalImports: manifest.externalImports,
          sha256: manifest.sha256,
        };
        const coordinator = createHostResourceCoordinator({
          profile: ${JSON.stringify(profile)},
          stateRoot: ${JSON.stringify(hostStateRoot)},
        });
        await coordinator.withLease([{ amount: 1, resource: "cpu" }], async lease => {
          const worker = await startCodeWorker({
            bunExecutable: process.execPath,
            bundle,
            inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
            temporaryRoot: ${JSON.stringify(root)},
          });
          await worker.build(new OperationRegistry(), {});
        });
      `);

      const helper = spawn(process.execPath, ["run", helperPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let helperStderr = "";
      helper.stderr?.on("data", (chunk: Uint8Array) => {
        helperStderr += new TextDecoder().decode(chunk);
      });
      let workerProcessId: number | undefined;
      let workerProcessStartIdentity: string | undefined;
      try {
        await Promise.race([
          waitForFile(startedPath),
          waitForChildExit(helper).then(() => {
            throw new Error(`Preparation parent exited before source evaluation: ${helperStderr}`);
          }),
        ]);
        workerProcessId = Number((await readFile(startedPath, "utf8")).trim());
        workerProcessStartIdentity = captureWorkerProcessStartIdentity(
          workerProcessId,
        );
        expect(
          workerProcessStartIdentityStatus(
            workerProcessId,
            workerProcessStartIdentity,
          ),
        ).toBe("exact-live-worker");
        const competitor = createHostResourceCoordinator({
          profile,
          stateRoot: hostStateRoot,
        });
        let workerStatusAtAdmission: ReturnType<
          typeof workerProcessStartIdentityStatus
        > | undefined;
        const admitted = competitor.withLease(
          [{ amount: 1, resource: "cpu" }],
          () => {
            workerStatusAtAdmission = workerProcessStartIdentityStatus(
              workerProcessId!,
              workerProcessStartIdentity!,
            );
          },
          { waitTimeoutMilliseconds: 10_000 },
        );
        await Bun.sleep(50);
        expect(workerStatusAtAdmission).toBeUndefined();
        helper.kill("SIGKILL");
        await waitForChildExit(helper);
        await admitted;
        expect(workerStatusAtAdmission).toBe("different-or-dead");
        await waitForExactWorkerRetirement(
          workerProcessId,
          workerProcessStartIdentity,
        );
      } finally {
        if (helper.exitCode === null && helper.signalCode === null) {
          helper.kill("SIGKILL");
          await waitForChildExit(helper);
        }
        if (
          workerProcessId !== undefined
          && workerProcessStartIdentity !== undefined
        ) {
          await terminateExactWorker(
            workerProcessId,
            workerProcessStartIdentity,
          );
        }
      }
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "retains machine CPU admission until a synchronous worker dies after its scheduler crashes",
    async () => {
      const root = await temporaryDirectory();
      const hostStateRoot = join(root, "host-resources");
      const startedPath = join(root, "compute-started");
      const workflowPath = join(root, "workflow.ts");
      const helperPath = join(root, "crashing-scheduler.ts");
      const bundlePath = join(root, "workflow.bundle.js");
      const bundleManifestPath = join(root, "workflow.bundle.json");
      const profile = {
        capacities: [{ limit: 1, resource: "cpu" }],
        id: "code-worker-crash-regression",
      } as const;
      await writeFile(workflowPath, `
        import { z } from "zod";
        import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

        const spin = defineCompute({
          key: "fixture.guardian-spin",
          inputSchemaId: "test.compute.guardian-spin-input/v1",
          outputSchemaId: "test.compute.guardian-spin-output/v1",
          inputSchema: z.strictObject({ startedPath: z.string() }),
          outputSchema: z.strictObject({ value: z.number() }),
          async run(input) {
            await Bun.write(input.startedPath, String(process.pid));
            while (true) { /* synchronous trusted code */ }
          },
        });

        export default defineWorkflow({
          id: "worker-lease-guardian-crash",
          version: 1,
          inputSchemaId: "test.workflow.guardian-crash-input/v1",
          inputSchema: z.strictObject({}),
          build(w) {
            return { spin: w.compute("spin", spin, { startedPath: ${JSON.stringify(startedPath)} }) };
          },
        });
      `);
      const preparedBundle = await bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "workflow.ts",
      });
      await writeFile(bundlePath, preparedBundle.bytes);
      await writeFile(bundleManifestPath, JSON.stringify({
        externalImports: preparedBundle.externalImports,
        sha256: preparedBundle.sha256,
      }));
      const workerClientUrl = pathToFileURL(
        join(import.meta.dir, "worker-client.ts"),
      ).href;
      const registryUrl = pathToFileURL(
        join(import.meta.dir, "../application/registry.ts"),
      ).href;
      const hostResourcesUrl = pathToFileURL(
        join(import.meta.dir, "../../../src/host-resources.ts"),
      ).href;
      await writeFile(helperPath, `
        import { createHostResourceCoordinator } from ${JSON.stringify(hostResourcesUrl)};
        import { OperationRegistry } from ${JSON.stringify(registryUrl)};
        import { startCodeWorker, startCodeWorkerPool } from ${JSON.stringify(workerClientUrl)};

        const root = ${JSON.stringify(root)};
        const manifest = await Bun.file(${JSON.stringify(bundleManifestPath)}).json();
        const bundle = {
          bytes: new Uint8Array(await Bun.file(${JSON.stringify(bundlePath)}).arrayBuffer()),
          externalImports: manifest.externalImports,
          sha256: manifest.sha256,
        };
        const registry = new OperationRegistry();
        const initial = await startCodeWorker({
          bunExecutable: process.execPath,
          bundle,
          temporaryRoot: root,
        });
        const built = await initial.build(registry, {});
        const pool = await startCodeWorkerPool({
          bunExecutable: process.execPath,
          bundle,
          expectedBuild: built,
          initialWorker: { build: built, session: initial },
          maximumWorkers: 1,
          registry,
          temporaryRoot: root,
          workflowInput: {},
        });
        const coordinator = createHostResourceCoordinator({
          profile: ${JSON.stringify(profile)},
          stateRoot: ${JSON.stringify(hostStateRoot)},
        });
        await coordinator.withLease([{ amount: 1, resource: "cpu" }], async lease => {
          await pool.execute({
            computeKey: "fixture.guardian-spin",
            inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
            input: { startedPath: ${JSON.stringify(startedPath)} },
            nodeKey: "spin",
            replayAcknowledged: false,
          });
        });
      `);

      const helper = spawn(process.execPath, ["run", helperPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let helperStderr = "";
      helper.stderr?.on("data", (chunk: Uint8Array) => {
        helperStderr += new TextDecoder().decode(chunk);
      });
      let workerProcessId: number | undefined;
      let workerProcessStartIdentity: string | undefined;
      try {
        await Promise.race([
          waitForFile(startedPath),
          waitForChildExit(helper).then(() => {
            throw new Error(`Crashing scheduler exited before compute: ${helperStderr}`);
          }),
        ]);
        workerProcessId = Number((await readFile(startedPath, "utf8")).trim());
        workerProcessStartIdentity = captureWorkerProcessStartIdentity(
          workerProcessId,
        );
        expect(
          workerProcessStartIdentityStatus(
            workerProcessId,
            workerProcessStartIdentity,
          ),
        ).toBe("exact-live-worker");
        const competitor = createHostResourceCoordinator({
          profile,
          stateRoot: hostStateRoot,
        });
        let workerStatusAtAdmission: ReturnType<
          typeof workerProcessStartIdentityStatus
        > | undefined;
        const admitted = competitor.withLease(
          [{ amount: 1, resource: "cpu" }],
          () => {
            workerStatusAtAdmission = workerProcessStartIdentityStatus(
              workerProcessId!,
              workerProcessStartIdentity!,
            );
          },
          { waitTimeoutMilliseconds: 10_000 },
        );
        await Bun.sleep(50);
        expect(workerStatusAtAdmission).toBeUndefined();

        helper.kill("SIGKILL");
        await waitForChildExit(helper);
        await admitted;

        expect(workerStatusAtAdmission).toBe("different-or-dead");
        await waitForExactWorkerRetirement(
          workerProcessId,
          workerProcessStartIdentity,
        );
      } finally {
        if (helper.exitCode === null && helper.signalCode === null) {
          helper.kill("SIGKILL");
          await waitForChildExit(helper);
        }
        if (
          workerProcessId !== undefined
          && workerProcessStartIdentity !== undefined
        ) {
          await terminateExactWorker(
            workerProcessId,
            workerProcessStartIdentity,
          );
        }
      }
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "keeps the lease guardian alive until a failed worker's retirement is confirmed",
    async () => {
      const root = await temporaryDirectory();
      const hostStateRoot = join(root, "host-resources-failed-worker");
      const retirementStartedPath = join(root, "retirement-started");
      const workerPidPath = join(root, "failed-worker-pid");
      const helperPath = join(root, "failed-worker-scheduler.ts");
      const bundlePath = join(root, "failed-worker.bundle.js");
      const buildPath = join(root, "failed-worker-build.json");
      const workflowPath = join(root, "failed-worker.ts");
      const profile = {
        capacities: [{ limit: 1, resource: "cpu" }],
        id: "code-worker-failed-retirement-regression",
      } as const;
      await writeFile(workflowPath, `
        import { z } from "zod";
        import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";
        const identity = defineCompute({
          key: "fixture.failed-retirement",
          inputSchemaId: "test.compute.failed-retirement-input/v1",
          outputSchemaId: "test.compute.failed-retirement-output/v1",
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({ value: z.number() }),
          run() { return { value: 1 }; },
        });
        export default defineWorkflow({
          id: "failed-retirement",
          version: 1,
          inputSchemaId: "test.workflow.failed-retirement-input/v1",
          inputSchema: z.strictObject({}),
          build(w) { return { value: w.compute("value", identity, {}) }; },
        });
      `);
      const bundle = await bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "failed-worker.ts",
      });
      const initial = await startCodeWorker({
        bunExecutable: process.execPath,
        bundle,
        temporaryRoot: root,
      });
      const built = await initial.build(registry(), {});
      await initial.close();
      await writeFile(bundlePath, bundle.bytes);
      await writeFile(buildPath, JSON.stringify({
        built,
        externalImports: bundle.externalImports,
        sha256: bundle.sha256,
      }));
      const workerClientUrl = pathToFileURL(join(import.meta.dir, "worker-client.ts")).href;
      const workerProcessIdentityUrl = pathToFileURL(
        join(import.meta.dir, "worker-process-identity.ts"),
      ).href;
      const registryUrl = pathToFileURL(
        join(import.meta.dir, "../application/registry.ts"),
      ).href;
      const hostResourcesUrl = pathToFileURL(
        join(import.meta.dir, "../../../src/host-resources.ts"),
      ).href;
      await writeFile(helperPath, `
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        import { createHostResourceCoordinator } from ${JSON.stringify(hostResourcesUrl)};
        import { OperationRegistry } from ${JSON.stringify(registryUrl)};
        import { startCodeWorkerPool } from ${JSON.stringify(workerClientUrl)};
        import { captureWorkerProcessStartIdentity } from ${JSON.stringify(workerProcessIdentityUrl)};

        const manifest = await Bun.file(${JSON.stringify(buildPath)}).json();
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
          import { establishCurrentWorkerProcessGroup } from ${JSON.stringify(workerProcessIdentityUrl)};
          establishCurrentWorkerProcessGroup();
          setInterval(() => {}, 1000);
        `)}], {
          stdio: "ignore",
        });
        await once(child, "spawn");
        await Bun.write(${JSON.stringify(workerPidPath)}, String(child.pid));
        let closePromise;
        const worker = {
          bundleSha256: manifest.sha256,
          generation: 1,
          processId: child.pid,
          processStartIdentity: captureWorkerProcessStartIdentity(child.pid),
          build: () => Promise.resolve(manifest.built),
          compute: () => Promise.reject(new Error("forced compute failure")),
          diagnostics: () => ({ stderr: "", stdout: "" }),
          close: () => {
            closePromise ??= (async () => {
              await Bun.write(${JSON.stringify(retirementStartedPath)}, "started");
              await new Promise(() => undefined);
            })();
            return closePromise;
          },
        };
        const bundle = {
          bytes: new Uint8Array(await Bun.file(${JSON.stringify(bundlePath)}).arrayBuffer()),
          externalImports: manifest.externalImports,
          sha256: manifest.sha256,
        };
        const pool = await startCodeWorkerPool({
          bunExecutable: process.execPath,
          bundle,
          expectedBuild: manifest.built,
          initialWorker: { build: manifest.built, session: worker },
          maximumWorkers: 1,
          registry: new OperationRegistry(),
          temporaryRoot: ${JSON.stringify(root)},
          workflowInput: {},
        });
        const coordinator = createHostResourceCoordinator({
          profile: ${JSON.stringify(profile)},
          stateRoot: ${JSON.stringify(hostStateRoot)},
        });
        await coordinator.withLease([{ amount: 1, resource: "cpu" }], async lease => {
          await pool.execute({
            computeKey: "fixture.failed-retirement",
            inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
            input: {},
            nodeKey: "value",
            replayAcknowledged: false,
          });
        });
      `);
      const helper = spawn(process.execPath, ["run", helperPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let helperStderr = "";
      helper.stderr?.on("data", (chunk: Uint8Array) => {
        helperStderr += new TextDecoder().decode(chunk);
      });
      let workerProcessId: number | undefined;
      let workerProcessStartIdentity: string | undefined;
      try {
        await Promise.race([
          Promise.all([
            waitForFile(workerPidPath),
            waitForFile(retirementStartedPath),
          ]),
          waitForChildExit(helper).then(() => {
            throw new Error(`Failed-worker helper exited early: ${helperStderr}`);
          }),
        ]);
        workerProcessId = Number((await readFile(workerPidPath, "utf8")).trim());
        workerProcessStartIdentity = captureWorkerProcessStartIdentity(
          workerProcessId,
        );
        expect(
          workerProcessStartIdentityStatus(
            workerProcessId,
            workerProcessStartIdentity,
          ),
        ).toBe("exact-live-worker");
        const competitor = createHostResourceCoordinator({
          profile,
          stateRoot: hostStateRoot,
        });
        let workerStatusAtAdmission: ReturnType<
          typeof workerProcessStartIdentityStatus
        > | undefined;
        const admitted = competitor.withLease(
          [{ amount: 1, resource: "cpu" }],
          () => {
            workerStatusAtAdmission = workerProcessStartIdentityStatus(
              workerProcessId!,
              workerProcessStartIdentity!,
            );
          },
          { waitTimeoutMilliseconds: 10_000 },
        );
        await Bun.sleep(50);
        expect(workerStatusAtAdmission).toBeUndefined();
        helper.kill("SIGKILL");
        await waitForChildExit(helper);
        await admitted;
        expect(workerStatusAtAdmission).toBe("different-or-dead");
        await waitForExactWorkerRetirement(
          workerProcessId,
          workerProcessStartIdentity,
        );
      } finally {
        if (helper.exitCode === null && helper.signalCode === null) {
          helper.kill("SIGKILL");
          await waitForChildExit(helper);
        }
        if (
          workerProcessId !== undefined
          && workerProcessStartIdentity !== undefined
        ) {
          await terminateExactWorker(
            workerProcessId,
            workerProcessStartIdentity,
          );
        }
      }
    },
    30_000,
  );

  test("retires a crashed worker without poisoning a healthy sibling", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "workflow.ts"), `
      import { z } from "zod";
      import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

      const isolated = defineCompute({
        key: "fixture.pool-isolated",
        inputSchemaId: "test.compute.pool-isolated-input/v1",
        outputSchemaId: "test.compute.pool-isolated-output/v1",
        inputSchema: z.strictObject({
          mode: z.enum(["crash", "delay", "success"]),
        }),
        outputSchema: z.strictObject({ pid: z.number().int() }),
        async run(input) {
          if (input.mode === "crash") process.exit(47);
          if (input.mode === "delay") await Bun.sleep(150);
          return { pid: process.pid };
        },
      });

      export default defineWorkflow({
        id: "worker-pool-crash-isolation",
        version: 1,
        inputSchemaId: "test.workflow.pool-crash-isolation-input/v1",
        inputSchema: z.strictObject({}),
        build(w) {
          return {
            crash: w.compute("crash", isolated, { mode: "crash" }),
            healthy: w.compute("healthy", isolated, { mode: "success" }),
          };
        },
      });
    `);
    const bundle = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    const initial = await startCodeWorker({
      bunExecutable: process.execPath,
      bundle,
      temporaryRoot: root,
    });
    let owner: CodeWorkerPool | CodeWorkerSession = initial;
    try {
      const built = await initial.build(registry(), {});
      const pool = await startCodeWorkerPool({
        bunExecutable: process.execPath,
        bundle,
        expectedBuild: built,
        initialWorker: { build: built, session: initial },
        maximumWorkers: 2,
        registry: registry(),
        temporaryRoot: root,
        workflowInput: {},
      });
      owner = pool;
      const crash = pool.execute({
        computeKey: "fixture.pool-isolated",
        input: { mode: "crash" },
        nodeKey: "crash",
        replayAcknowledged: false,
      });
      const healthy = pool.execute({
        computeKey: "fixture.pool-isolated",
        input: { mode: "delay" },
        nodeKey: "healthy",
        replayAcknowledged: false,
      });
      const queued = pool.execute({
        computeKey: "fixture.pool-isolated",
        input: { mode: "success" },
        nodeKey: "healthy",
        replayAcknowledged: false,
      });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(crash).rejects.toThrow("exited before completing");
      const firstHealthy = await healthy as { readonly pid: number };
      const secondHealthy = await queued as { readonly pid: number };
      expect(secondHealthy.pid).toBe(firstHealthy.pid);
    } finally {
      await owner.close();
    }
  }, 15_000);
});
