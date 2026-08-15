import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { createHostResourceCoordinator } from "@hraness/atet/host-resources";

import type { ApplicationContext } from "../application/context";
import { ApplicationError } from "../application/errors";
import type { OperationDefinition } from "../application/operation";
import { OperationRegistry } from "../application/registry";
import {
  CODE_WORKER_ABI,
  GRAPH_ABI,
  GRAPH_COMPILER_ABI,
  GRAPH_SCHEDULER_ABI,
  type WorkflowBundleIdentity,
  type WorkflowRuntimeIdentity,
} from "./contracts";
import { compileGraphPlan } from "./compiler";
import { WorkflowGraphBuilder } from "./graph-builder";
import { RUN_STORE_VERSION } from "./run-contracts";
import { RunStore } from "./run-store";
import {
  DurableWorkflowScheduler,
  type SchedulerAuthorization,
  type SchedulerNodePlanner,
} from "./scheduler";

const BENCHMARK_DELAY_MILLISECONDS = 220;
const BENCHMARK_REPORT_VERSION =
  "atet-code-concurrency-benchmark-report/v1" as const;
const BRANCH_ELAPSED_RATIO_CEILING = 0.65;
export const CONCURRENCY_BENCHMARK_HOST_RESOURCE_PROFILE = Object.freeze({
  capacities: Object.freeze([
    Object.freeze({ limit: 4, resource: "cpu" }),
  ]),
  id: "atet.concurrency-benchmark/v1",
});
const PAIR_OVERLAP_DELAY_FRACTION_FLOOR = 0.65;
const SHA256_ZERO = "0".repeat(64);

export const CONCURRENCY_BENCHMARK_FIXTURE = Object.freeze({
  branches: Object.freeze([
    Object.freeze({ id: "branch-a", value: 1 }),
    Object.freeze({ id: "branch-b", value: 2 }),
    Object.freeze({ id: "branch-c", value: 3 }),
    Object.freeze({ id: "branch-d", value: 4 }),
  ]),
  delayMilliseconds: BENCHMARK_DELAY_MILLISECONDS,
  joinBaseValue: 3,
});

const BenchmarkInputSchema = z.strictObject({
  delayMilliseconds: z.number().int().nonnegative().max(1_000),
  dependencies: z.array(z.strictObject({
    id: z.string(),
    value: z.number(),
  })).optional(),
  id: z.string(),
  value: z.number(),
});

const BenchmarkOutputSchema = z.strictObject({
  id: z.string(),
  value: z.number(),
});

type BenchmarkInput = z.infer<typeof BenchmarkInputSchema>;
type BenchmarkOutput = z.infer<typeof BenchmarkOutputSchema>;

export interface ConcurrencyBenchmarkSpan {
  readonly durationMilliseconds: number;
  readonly endedAtMilliseconds: number;
  readonly nodeKey: string;
  readonly startedAtMilliseconds: number;
}

export interface ConcurrencyBenchmarkRun {
  readonly branchElapsedMilliseconds: number;
  readonly elapsedMilliseconds: number;
  readonly graphPlanSha256: string;
  readonly join: BenchmarkOutput;
  readonly jobs: 1 | 4;
  readonly spans: readonly ConcurrencyBenchmarkSpan[];
  readonly status: "completed";
}

export interface ConcurrencyBenchmarkResult {
  readonly branchElapsedRatio: number;
  readonly branchSpeedup: number;
  readonly elapsedRatio: number;
  readonly fixture: typeof CONCURRENCY_BENCHMARK_FIXTURE;
  readonly graphPlanSha256: string;
  readonly parallel: ConcurrencyBenchmarkRun;
  readonly rootPairOverlapMilliseconds: number;
  readonly sequential: ConcurrencyBenchmarkRun;
  readonly speedup: number;
}

export interface ConcurrencyBenchmarkReport {
  readonly correctness: {
    readonly graphPlanSha256: string;
    readonly join: BenchmarkOutput;
    readonly sameImmutableGraphPlan: true;
  };
  readonly measurements: {
    readonly branch: {
      readonly parallelMilliseconds: number;
      readonly ratio: number;
      readonly sequentialMilliseconds: number;
      readonly speedup: number;
    };
    readonly schedulerLifecycleDiagnostic: {
      readonly parallelMilliseconds: number;
      readonly ratio: number;
      readonly sequentialMilliseconds: number;
      readonly speedup: number;
    };
    readonly maximumPairOverlapMilliseconds: number;
    readonly operationDurationsMilliseconds: {
      readonly parallel: readonly number[];
      readonly sequential: readonly number[];
    };
  };
  readonly method: {
    readonly branchCount: number;
    readonly branchStart: "rendezvous-after-scheduler-admission";
    readonly operationDelayMilliseconds: number;
    readonly parallelJobs: 4;
    readonly primaryMeasurement: "independent-branch-wall-clock";
    readonly scheduler: "DurableWorkflowScheduler";
    readonly sequentialJobs: 1;
  };
  readonly version: typeof BENCHMARK_REPORT_VERSION;
  readonly verdict: {
    readonly materialParallelism: boolean;
    readonly thresholds: {
      readonly maximumBranchElapsedRatio: number;
      readonly minimumPairOverlapMilliseconds: number;
    };
  };
}

interface MutableBenchmarkSpan {
  endedAtMilliseconds: number | undefined;
  readonly nodeKey: string;
  readonly startedAtMilliseconds: number;
}

interface BenchmarkRendezvous {
  arrived: number;
  readonly ready: Promise<void>;
  readonly release: () => void;
  readonly target: 1 | 4;
}

const authorization: SchedulerAuthorization = {
  authorizeEffect: () => Promise.resolve(true),
  authorizePreparation: () => Promise.resolve(true),
  grantedBy: "concurrency-benchmark",
};

const nodePlanner: SchedulerNodePlanner = {
  plan: request => Promise.resolve({
    exactInput: request.resolvedInput,
    publicationKeys: [],
  }),
  prepare: request => Promise.resolve({
    inputDescriptors: request.resolvedInput,
  }),
};

function benchmarkRuntime(): WorkflowRuntimeIdentity {
  return {
    applicationBuild: "concurrency-benchmark",
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    bundlerConfigurationSha256: "2".repeat(64),
    bundlerName: "bun",
    bundlerRevision: Bun.revision,
    bundlerVersion: Bun.version,
    codeWorkerAbi: CODE_WORKER_ABI,
    compilerAbi: GRAPH_COMPILER_ABI,
    externals: {
      kind: "deny-all",
      modules: [],
      policySha256: "3".repeat(64),
    },
    graphAbi: GRAPH_ABI,
    schedulerAbi: GRAPH_SCHEDULER_ABI,
  };
}

function applicationContext(root: string): ApplicationContext {
  return {
    capabilities: () => Promise.resolve([]),
    capability: name => Promise.resolve({ available: false, name }),
    clock: {
      now: () => new Date(),
      timestampMilliseconds: () => Date.now(),
    },
    paths: {
      artifactRoot: root,
      desktopRoot: root,
      privateRoot: root,
      projectRoot: root,
      repositoryRoot: root,
    },
    runner: {
      run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    },
  };
}

async function abortableDelay(
  delayMilliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (delayMilliseconds === 0) return;
  if (signal.aborted) {
    throw new ApplicationError("cancelled", "Concurrency benchmark was cancelled.");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMilliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new ApplicationError("cancelled", "Concurrency benchmark was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function createRegistry(
  spansByRun: Map<string, MutableBenchmarkSpan[]>,
  rendezvousByRun: Map<string, BenchmarkRendezvous>,
): OperationRegistry {
  const registry = new OperationRegistry();
  const definition = {
    inputSchema: BenchmarkInputSchema,
    inputSchemaId: "atet.concurrency-benchmark-input/v1",
    kind: "derive.edit-batch",
    lifecycle: {
      execute: async (context, input) => {
        const runId = context.workflow?.runId;
        if (runId === undefined) {
          throw new ApplicationError(
            "internal",
            "The concurrency benchmark requires durable workflow context.",
          );
        }
        if (input.id.startsWith("branch-")) {
          const rendezvous = rendezvousByRun.get(runId);
          if (rendezvous === undefined) {
            throw new ApplicationError(
              "internal",
              "The concurrency benchmark has no branch-start rendezvous.",
            );
          }
          if (rendezvous.target === 4) {
            rendezvous.arrived += 1;
            if (rendezvous.arrived > rendezvous.target) {
              throw new ApplicationError(
                "internal",
                "The concurrency benchmark admitted too many root branches.",
              );
            }
            if (rendezvous.arrived === rendezvous.target) rendezvous.release();
            await rendezvous.ready;
          }
        }
        const span: MutableBenchmarkSpan = {
          endedAtMilliseconds: undefined,
          nodeKey: input.id,
          startedAtMilliseconds: performance.now(),
        };
        const spans = spansByRun.get(runId) ?? [];
        spans.push(span);
        spansByRun.set(runId, spans);
        await abortableDelay(input.delayMilliseconds, context.abortSignal);
        span.endedAtMilliseconds = performance.now();
        return {
          id: input.id,
          value: input.value + (input.dependencies ?? [])
            .reduce((sum, dependency) => sum + dependency.value, 0),
        };
      },
      kind: "pure",
    },
    outputSchema: BenchmarkOutputSchema,
    outputSchemaId: "atet.concurrency-benchmark-output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "pure",
      maxDurationMs: 2_000,
      maxFanOut: 2,
      maxInputBytes: 16 * 1_024,
      maxOutputBytes: 16 * 1_024,
      preparation: [],
      resources: [{ amount: 1, resource: "cpu" }],
      resume: "deterministic",
    },
    summarize: output => ({
      fields: { id: output.id, value: output.value },
      kind: "derive.edit-batch",
    }),
    version: 1,
  } satisfies OperationDefinition<
    "derive.edit-batch",
    BenchmarkInput,
    BenchmarkOutput
  >;
  registry.register(definition);
  return registry;
}

function createGraphPlan(registry: OperationRegistry) {
  const builder = WorkflowGraphBuilder.create(registry);
  const branches = CONCURRENCY_BENCHMARK_FIXTURE.branches.map(branch => (
    builder.operationByKind<BenchmarkOutput>(branch.id, {
      input: {
        delayMilliseconds: CONCURRENCY_BENCHMARK_FIXTURE.delayMilliseconds,
        id: branch.id,
        value: branch.value,
      },
      kind: "derive.edit-batch",
      version: 1,
    })
  ));
  const joinNode = builder.operationByKind<BenchmarkOutput>("join", {
    input: {
      delayMilliseconds: 0,
      dependencies: branches,
      id: "join",
      value: CONCURRENCY_BENCHMARK_FIXTURE.joinBaseValue,
    },
    kind: "derive.edit-batch",
    version: 1,
  });
  const graph = builder.build({
    id: "concurrency-benchmark",
    inputSchemaId: "atet.concurrency-benchmark-workflow-input/v1",
    version: 1,
  }, { join: joinNode });
  const bundleBytes = new TextEncoder().encode(
    "export default { id: \"concurrency-benchmark\" };\n",
  );
  const bundle: WorkflowBundleIdentity = {
    bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
    bytes: bundleBytes.byteLength,
    dependencyGraphSha256: SHA256_ZERO,
    entrypoint: "concurrency-benchmark.ts",
    sourceSha256: "1".repeat(64),
  };
  const runtime = benchmarkRuntime();
  return {
    bundle,
    bundleBytes,
    graph,
    graphPlan: compileGraphPlan({
      bundle,
      graph,
      registry,
      runtime,
      workflowInput: CONCURRENCY_BENCHMARK_FIXTURE,
    }),
    runtime,
  };
}

function immutableSpans(
  spans: readonly MutableBenchmarkSpan[],
): readonly ConcurrencyBenchmarkSpan[] {
  return Object.freeze(spans.map((span) => {
    if (span.endedAtMilliseconds === undefined) {
      throw new ApplicationError(
        "internal",
        `Concurrency benchmark span ${span.nodeKey} did not finish.`,
      );
    }
    return Object.freeze({
      durationMilliseconds: span.endedAtMilliseconds - span.startedAtMilliseconds,
      endedAtMilliseconds: span.endedAtMilliseconds,
      nodeKey: span.nodeKey,
      startedAtMilliseconds: span.startedAtMilliseconds,
    });
  }));
}

function branchElapsedMilliseconds(
  spans: readonly ConcurrencyBenchmarkSpan[],
): number {
  const branches = spans.filter(span => span.nodeKey.startsWith("branch-"));
  if (branches.length !== CONCURRENCY_BENCHMARK_FIXTURE.branches.length) {
    throw new ApplicationError(
      "internal",
      `Concurrency benchmark expected ${String(CONCURRENCY_BENCHMARK_FIXTURE.branches.length)} branch spans.`,
    );
  }
  return Math.max(...branches.map(span => span.endedAtMilliseconds))
    - Math.min(...branches.map(span => span.startedAtMilliseconds));
}

async function executeBenchmarkRun(options: {
  readonly fixture: ReturnType<typeof createGraphPlan>;
  readonly jobs: 1 | 4;
  readonly root: string;
  readonly rendezvousByRun: Map<string, BenchmarkRendezvous>;
  readonly runId: string;
  readonly spansByRun: Map<string, MutableBenchmarkSpan[]>;
  readonly registry: OperationRegistry;
}): Promise<ConcurrencyBenchmarkRun> {
  const storeRoot = join(options.root, options.runId);
  await mkdir(storeRoot, { mode: 0o700, recursive: true });
  const store = new RunStore({ root: storeRoot });
  await store.create({
    bundleBytes: options.fixture.bundleBytes,
    graphPlan: options.fixture.graphPlan,
    runId: options.runId,
    runtime: {
      computes: [],
      operations: [{ kind: "derive.edit-batch", version: 1 }],
      runtime: options.fixture.runtime,
      version: RUN_STORE_VERSION,
    },
    sourceLocator: "concurrency-benchmark.ts",
    workflow: {
      bundle: options.fixture.bundle,
      sourceLocator: "concurrency-benchmark.ts",
      workflow: options.fixture.graph.workflow,
    },
  });
  const scheduler = new DurableWorkflowScheduler({
    application: applicationContext(storeRoot),
    authorization,
    cancellationPollMs: 5,
    currentApplicationBuild: "concurrency-benchmark",
    hostResourceCoordinator: createHostResourceCoordinator({
      profile: CONCURRENCY_BENCHMARK_HOST_RESOURCE_PROFILE,
      stateRoot: join(storeRoot, "host-resources"),
    }),
    hostLimits: {
      maxJobs: 4,
      resources: { cpu: 4 },
    },
    jobs: options.jobs,
    nodePlanner,
    owner: `concurrency-benchmark-${String(options.jobs)}`,
    registry: options.registry,
    store,
  });
  let releaseRendezvous: () => void = () => undefined;
  const rendezvous: BenchmarkRendezvous = {
    arrived: 0,
    ready: new Promise<void>((resolve) => {
      releaseRendezvous = resolve;
    }),
    release: () => releaseRendezvous(),
    target: options.jobs,
  };
  if (rendezvous.target === 1) rendezvous.release();
  options.rendezvousByRun.set(options.runId, rendezvous);
  const startedAt = performance.now();
  const result = await scheduler.run(options.runId).finally(() => {
    options.rendezvousByRun.delete(options.runId);
  });
  const elapsedMilliseconds = performance.now() - startedAt;
  if (result.summary.status !== "completed") {
    throw new ApplicationError(
      "internal",
      `Concurrency benchmark run ended ${result.summary.status}.`,
    );
  }
  const joinOutput = BenchmarkOutputSchema.parse(
    (await store.node(options.runId, "join")).output?.value,
  );
  const spans = immutableSpans(options.spansByRun.get(options.runId) ?? []);
  return Object.freeze({
    branchElapsedMilliseconds: branchElapsedMilliseconds(spans),
    elapsedMilliseconds,
    graphPlanSha256: options.fixture.graphPlan.graphPlanSha256,
    join: Object.freeze(joinOutput),
    jobs: options.jobs,
    spans,
    status: "completed",
  });
}

function maximumRootPairOverlap(
  spans: readonly ConcurrencyBenchmarkSpan[],
): number {
  const branches = spans.filter(span => span.nodeKey.startsWith("branch-"));
  if (branches.length !== CONCURRENCY_BENCHMARK_FIXTURE.branches.length) {
    throw new ApplicationError(
      "internal",
      `Concurrency benchmark expected ${String(CONCURRENCY_BENCHMARK_FIXTURE.branches.length)} branch spans.`,
    );
  }
  let maximumOverlap = 0;
  for (const [index, first] of branches.entries()) {
    if (first === undefined) continue;
    for (const second of branches.slice(index + 1)) {
      maximumOverlap = Math.max(
        maximumOverlap,
        Math.min(first.endedAtMilliseconds, second.endedAtMilliseconds)
          - Math.max(first.startedAtMilliseconds, second.startedAtMilliseconds),
      );
    }
  }
  return Math.max(0, maximumOverlap);
}

export async function runConcurrencyBenchmark(): Promise<ConcurrencyBenchmarkResult> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "atet-concurrency-benchmark-"),
  );
  const spansByRun = new Map<string, MutableBenchmarkSpan[]>();
  const rendezvousByRun = new Map<string, BenchmarkRendezvous>();
  const registry = createRegistry(spansByRun, rendezvousByRun);
  const fixture = createGraphPlan(registry);
  try {
    const sequential = await executeBenchmarkRun({
      fixture,
      jobs: 1,
      registry,
      rendezvousByRun,
      root,
      runId: "run_concurrency_sequential",
      spansByRun,
    });
    const parallel = await executeBenchmarkRun({
      fixture,
      jobs: 4,
      registry,
      rendezvousByRun,
      root,
      runId: "run_concurrency_parallel",
      spansByRun,
    });
    return Object.freeze({
      branchElapsedRatio: parallel.branchElapsedMilliseconds
        / sequential.branchElapsedMilliseconds,
      branchSpeedup: sequential.branchElapsedMilliseconds
        / parallel.branchElapsedMilliseconds,
      elapsedRatio: parallel.elapsedMilliseconds / sequential.elapsedMilliseconds,
      fixture: CONCURRENCY_BENCHMARK_FIXTURE,
      graphPlanSha256: fixture.graphPlan.graphPlanSha256,
      parallel,
      rootPairOverlapMilliseconds: maximumRootPairOverlap(parallel.spans),
      sequential,
      speedup: sequential.elapsedMilliseconds / parallel.elapsedMilliseconds,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function roundedMilliseconds(value: number): number {
  return Number(value.toFixed(1));
}

function roundedRatio(value: number): number {
  return Number(value.toFixed(3));
}

export function createConcurrencyBenchmarkReport(
  result: ConcurrencyBenchmarkResult,
): ConcurrencyBenchmarkReport {
  const minimumPairOverlapMilliseconds =
    CONCURRENCY_BENCHMARK_FIXTURE.delayMilliseconds
    * PAIR_OVERLAP_DELAY_FRACTION_FLOOR;
  const durations = (run: ConcurrencyBenchmarkRun): readonly number[] => (
    run.spans
      .filter(span => span.nodeKey.startsWith("branch-"))
      .map(span => roundedMilliseconds(span.durationMilliseconds))
  );
  return Object.freeze({
    correctness: Object.freeze({
      graphPlanSha256: result.graphPlanSha256,
      join: result.parallel.join,
      sameImmutableGraphPlan: true,
    }),
    measurements: Object.freeze({
      branch: Object.freeze({
        parallelMilliseconds: roundedMilliseconds(
          result.parallel.branchElapsedMilliseconds,
        ),
        ratio: roundedRatio(result.branchElapsedRatio),
        sequentialMilliseconds: roundedMilliseconds(
          result.sequential.branchElapsedMilliseconds,
        ),
        speedup: roundedRatio(result.branchSpeedup),
      }),
      schedulerLifecycleDiagnostic: Object.freeze({
        parallelMilliseconds: roundedMilliseconds(
          result.parallel.elapsedMilliseconds,
        ),
        ratio: roundedRatio(result.elapsedRatio),
        sequentialMilliseconds: roundedMilliseconds(
          result.sequential.elapsedMilliseconds,
        ),
        speedup: roundedRatio(result.speedup),
      }),
      maximumPairOverlapMilliseconds: roundedMilliseconds(
        result.rootPairOverlapMilliseconds,
      ),
      operationDurationsMilliseconds: Object.freeze({
        parallel: Object.freeze(durations(result.parallel)),
        sequential: Object.freeze(durations(result.sequential)),
      }),
    }),
    method: Object.freeze({
      branchCount: CONCURRENCY_BENCHMARK_FIXTURE.branches.length,
      branchStart: "rendezvous-after-scheduler-admission",
      operationDelayMilliseconds:
        CONCURRENCY_BENCHMARK_FIXTURE.delayMilliseconds,
      parallelJobs: 4,
      primaryMeasurement: "independent-branch-wall-clock",
      scheduler: "DurableWorkflowScheduler",
      sequentialJobs: 1,
    }),
    version: BENCHMARK_REPORT_VERSION,
    verdict: Object.freeze({
      materialParallelism:
        result.branchElapsedRatio < BRANCH_ELAPSED_RATIO_CEILING
        && result.rootPairOverlapMilliseconds > minimumPairOverlapMilliseconds,
      thresholds: Object.freeze({
        maximumBranchElapsedRatio: BRANCH_ELAPSED_RATIO_CEILING,
        minimumPairOverlapMilliseconds: roundedMilliseconds(
          minimumPairOverlapMilliseconds,
        ),
      }),
    }),
  });
}

function benchmarkUsage(): string {
  return [
    "Usage: bun run benchmark:code-concurrency [--compact]",
    "",
    "Runs one immutable four-branch workflow through the production compiler,",
    "run store, operation registry, and durable scheduler with jobs=1 and jobs=4.",
    "Writes a versioned JSON report to stdout; --compact emits one line.",
    "",
    "From the repository root: bun run benchmark:atet:code-concurrency",
  ].join("\n");
}

async function runBenchmarkCommand(arguments_: readonly string[]): Promise<number> {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    process.stdout.write(`${benchmarkUsage()}\n`);
    return 0;
  }
  const unknownArguments = arguments_.filter(argument => argument !== "--compact");
  if (unknownArguments.length > 0) {
    process.stderr.write(
      `Unknown benchmark option: ${unknownArguments.join(", ")}\n${benchmarkUsage()}\n`,
    );
    return 2;
  }
  const result = await runConcurrencyBenchmark();
  const report = createConcurrencyBenchmarkReport(result);
  const spacing = arguments_.includes("--compact") ? undefined : 2;
  process.stdout.write(`${JSON.stringify(report, undefined, spacing)}\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runBenchmarkCommand(Bun.argv.slice(2));
}
