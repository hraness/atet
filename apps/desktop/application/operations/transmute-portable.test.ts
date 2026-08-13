import { describe, expect, test } from "bun:test";
import { PORTABLE_TRANSMUTE_OPERATION_CONTRACTS } from "@hraness/transmute/code/advanced";
import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApplicationContext,
  ApplicationHostResourceLease,
} from "../context";
import { ApplicationError } from "../errors";
import type { OperationExecutionContext } from "../operation";
import { OperationRegistry } from "../registry";
import { operationApplicationContext } from "./test-support";
import { createTransmutePortableOperationDefinitions } from "./transmute-portable";

const diagramCheckContract =
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.diagram.check"];

function application(
  hostResourceLease?: ApplicationHostResourceLease,
): ApplicationContext {
  return {
    capabilities: () => Promise.resolve([]),
    capability: name => Promise.resolve({ available: false, name }),
    clock: { now: () => new Date(0), timestampMilliseconds: () => 0 },
    ...(hostResourceLease === undefined ? {} : { hostResourceLease }),
    paths: {
      artifactRoot: "/artifacts",
      desktopRoot: "/desktop",
      privateRoot: "/private",
      projectRoot: "/project",
      repositoryRoot: "/repo",
    },
    runner: {
      run: () => Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
    },
  };
}

function executionContext(
  applicationContext: ApplicationContext,
): OperationExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    application: applicationContext,
  };
}

function registryWith(
  dependencies: Parameters<
    typeof createTransmutePortableOperationDefinitions
  >[0],
): OperationRegistry {
  const registry = new OperationRegistry();
  for (const definition of createTransmutePortableOperationDefinitions(
    dependencies,
  )) {
    registry.register(definition);
  }
  return registry;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("portable Transmute application operations", () => {
  test("parses paths and delegates exactly once beneath an inherited host lease", async () => {
    let directExecutions = 0;
    let leasedExecutions = 0;
    let parseCalls = 0;
    let delegatedInput: unknown;
    let delegatedLease: ApplicationHostResourceLease | undefined;
    let inheritedFileDescriptors: readonly number[] | undefined;
    const lease: ApplicationHostResourceLease = {
      assertOwned: () => Promise.resolve(),
      claims: diagramCheckContract.policy.resources,
      inheritedFileDescriptor: 73,
      inheritedFileDescriptors: [71, 73],
      profile: { capacities: [], id: "transmute.test-portable/v1" },
      ticket: "1",
    };
    const registry = registryWith({
      execute: () => {
        directExecutions += 1;
        return Promise.resolve({ configPath: null, findings: [] });
      },
      executeWithLease: (_kind, input, receivedLease, dependencies) => {
        leasedExecutions += 1;
        delegatedInput = input;
        delegatedLease = receivedLease;
        inheritedFileDescriptors = dependencies?.inheritedFileDescriptors;
        return Promise.resolve({ configPath: null, findings: [] });
      },
      parseInput: (_kind, input) => {
        parseCalls += 1;
        return input;
      },
    });

    const result = await registry.execute(executionContext(application(lease)), {
      input: { path: "diagrams/flow.diagram.json" },
      kind: "transmute.diagram.check",
      version: 2,
    });

    expect(result.output).toEqual({ configPath: null, findings: [] });
    expect(result.summary).toEqual({
      fields: {},
      kind: "transmute.diagram.check",
    });
    expect(parseCalls).toBe(1);
    expect(directExecutions).toBe(0);
    expect(leasedExecutions).toBe(1);
    expect(delegatedInput).toEqual({
      path: "/repo/diagrams/flow.diagram.json",
    });
    expect(delegatedLease).toBe(lease);
    expect(inheritedFileDescriptors).toEqual([71, 73]);
  });

  test("parses adapter outputs and rejects invalid input before execution", async () => {
    let executions = 0;
    const registry = registryWith({
      execute: () => {
        executions += 1;
        return Promise.resolve({ findings: [] });
      },
      parseInput: (_kind, input) => input,
    });

    expect(await rejection(registry.execute(executionContext(application()), {
      input: { path: "flow.diagram.json" },
      kind: "transmute.diagram.check",
      version: 2,
    }))).toBeInstanceOf(Error);
    expect(executions).toBe(1);

    expect(await rejection(registry.execute(executionContext(application()), {
      input: { path: 42 },
      kind: "transmute.diagram.check",
      version: 2,
    }))).toBeInstanceOf(Error);
    expect(executions).toBe(1);
  });

  test("confines relative paths, rejects nonlocal paths, and preserves absolute caller paths", async () => {
    const delegated: unknown[] = [];
    const registry = registryWith({
      execute: (_kind, input) => {
        delegated.push(input);
        return Promise.resolve({ configPath: null, findings: [] });
      },
      parseInput: (_kind, input) => input,
    });
    const context = executionContext(application());

    for (const path of ["../outside.diagram.json", "https://example.com/a.json"]) {
      expect(await rejection(registry.execute(context, {
        input: { path },
        kind: "transmute.diagram.check",
        version: 2,
      }))).toBeInstanceOf(ApplicationError);
    }
    expect(await rejection(registry.execute(context, {
      input: { path: "bad\0.diagram.json" },
      kind: "transmute.diagram.check",
      version: 2,
    }))).toBeInstanceOf(Error);
    expect(delegated).toEqual([]);

    await registry.execute(context, {
      input: { path: "/caller/flow.diagram.json" },
      kind: "transmute.diagram.check",
      version: 2,
    });
    expect(delegated).toEqual([{ path: "/caller/flow.diagram.json" }]);
  });

  test("does not fall back across operation versions", async () => {
    let executions = 0;
    const registry = registryWith({
      execute: () => {
        executions += 1;
        return Promise.resolve({ configPath: null, findings: [] });
      },
    });
    expect(await rejection(registry.execute(executionContext(application()), {
      input: { path: "flow.diagram.json" },
      kind: "transmute.diagram.check",
      version: 1,
    }))).toBeInstanceOf(ApplicationError);
    expect(executions).toBe(0);
  });

  test("serializes portable writers across the shared machine-state mutation lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-portable-output-lease-"));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>(resolve => { markFirstEntered = resolve; });
    let executions = 0;
    try {
      const registry = registryWith({
        execute: async () => {
          executions += 1;
          if (executions === 1) {
            markFirstEntered();
            await firstGate;
          }
          return {
            artifacts: {
              darkPng: join(root, "flow.dark.png"),
              darkSvg: join(root, "flow.dark.svg"),
              lightPng: join(root, "flow.light.png"),
              lightSvg: join(root, "flow.light.svg"),
              spec: join(root, "flow.diagram.json"),
              tldr: join(root, "flow.tldr"),
            },
            configPath: null,
            findings: [],
          };
        },
        parseInput: (_kind, input) => input,
      });
      const machineStateRoot = join(root, "machine-state");
      const context = executionContext({
        ...operationApplicationContext(root),
        machineStateRoot,
      });
      const physicalRoot = await realpath(root);
      const request = {
        input: {
          outDirectory: physicalRoot,
          path: join(physicalRoot, "flow.diagram.json"),
        },
        kind: "transmute.diagram.render" as const,
        version: 2,
      };
      const first = registry.execute(context, request);
      await firstEntered;
      const leaseRoots = await readdir(join(
        machineStateRoot,
        "portable-output-publication-leases",
      ));
      expect(leaseRoots).toHaveLength(1);
      const leaseRoot = leaseRoots[0];
      if (leaseRoot === undefined) throw new Error("Missing portable output lease.");
      expect((await lstat(join(
        machineStateRoot,
        "portable-output-publication-leases",
        leaseRoot,
        ".transmute-mutation.lock",
      ))).isFile()).toBe(true);

      const childMarker = join(root, "child-executed");
      const childSource = `
        import { join } from "node:path";
        import { createTransmutePortableOperationDefinitions } from ${JSON.stringify(
          new URL("./transmute-portable.ts", import.meta.url).href,
        )};
        import { OperationRegistry } from ${JSON.stringify(
          new URL("../registry.ts", import.meta.url).href,
        )};
        const root = process.env.PORTABLE_LEASE_ROOT;
        const outputRoot = process.env.PORTABLE_OUTPUT_ROOT;
        const marker = process.env.PORTABLE_CHILD_MARKER;
        const machineStateRoot = process.env.PORTABLE_MACHINE_STATE_ROOT;
        if (!root || !outputRoot || !marker || !machineStateRoot) {
          throw new Error("Missing child fixture paths.");
        }
        const application = {
          capabilities: () => Promise.resolve([]),
          capability: name => Promise.resolve({ available: false, name }),
          clock: {
            now: () => new Date("2026-07-23T00:00:00.000Z"),
            timestampMilliseconds: () => 0,
          },
          machineStateRoot,
          paths: {
            artifactRoot: join(root, "artifacts", "transmute", "recordings"),
            desktopRoot: join(root, "projects", "transmute", "apps", "desktop"),
            privateRoot: join(root, "other-worktree-private"),
            projectRoot: join(root, "artifacts", "transmute", "projects"),
            repositoryRoot: root,
          },
          runner: { run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }) },
        };
        const registry = new OperationRegistry();
        for (const definition of createTransmutePortableOperationDefinitions({
          execute: async () => {
            await Bun.write(marker, "executed");
            return {
              artifacts: {
                darkPng: join(outputRoot, "flow.dark.png"),
                darkSvg: join(outputRoot, "flow.dark.svg"),
                lightPng: join(outputRoot, "flow.light.png"),
                lightSvg: join(outputRoot, "flow.light.svg"),
                spec: join(outputRoot, "flow.diagram.json"),
                tldr: join(outputRoot, "flow.tldr"),
              },
              configPath: null,
              findings: [],
            };
          },
          parseInput: (_kind, input) => input,
        })) registry.register(definition);
        try {
          await registry.execute({
            abortSignal: new AbortController().signal,
            application,
          }, {
            input: {
              outDirectory: outputRoot,
              path: join(outputRoot, "flow.diagram.json"),
            },
            kind: "transmute.diagram.render",
            version: 2,
          });
          console.log(JSON.stringify({ code: "executed" }));
        } catch (error) {
          console.log(JSON.stringify({ code: error?.code ?? "unknown" }));
        }
      `;
      const child = Bun.spawn([process.execPath, "--eval", childSource], {
        env: {
          ...process.env,
          PORTABLE_CHILD_MARKER: childMarker,
          PORTABLE_LEASE_ROOT: root,
          PORTABLE_MACHINE_STATE_ROOT: machineStateRoot,
          PORTABLE_OUTPUT_ROOT: physicalRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [childExit, childStdout, childStderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(childExit).toBe(0);
      expect(childStderr).toBe("");
      expect(JSON.parse(childStdout.trim())).toEqual({ code: "conflict" });
      expect(lstat(childMarker)).rejects.toMatchObject({ code: "ENOENT" });

      const second = registry.execute(context, request);
      for (let turn = 0; turn < 16; turn += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(executions).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(executions).toBe(2);
    } finally {
      releaseFirst();
      await rm(root, { force: true, recursive: true });
    }
  });
});
