import { z } from "zod";
import {
  DEFAULT_GRAPH_COMPILER_LIMITS,
  compileWorkflowGraph,
  type ValidatedGraphTopology,
} from "@hraness/transmute/code/advanced";

import { ApplicationError } from "../application/errors";
import type { OperationRegistry } from "../application/registry";
import {
  boundedCanonicalJsonFingerprint,
} from "../core/canonical-json";
import {
  GRAPH_PLAN_VERSION,
  GraphPlanV1Schema,
  JsonValueSchema,
  OperationDiscoverySchema,
  STATIC_BINDINGS_VERSION,
  StaticBindingsSchema,
  UnsignedGraphPlanV1Schema,
  WorkflowBundleIdentitySchema,
  WorkflowRuntimeIdentitySchema,
  type GraphCompilerLimits,
  type GraphPlanV1,
  type StaticBindings,
  type WorkflowRuntimeIdentity,
} from "./contracts";

export { DEFAULT_GRAPH_COMPILER_LIMITS };
export type { ValidatedGraphTopology };

export const GRAPH_PLAN_HASH_DOMAIN = "studio.workflow.graph-plan/v2" as const;
export const REGISTRY_DISCOVERY_HASH_DOMAIN =
  "studio.workflow.registry-discovery/v1" as const;
export const DESKTOP_WORKFLOW_REGISTRY_PROJECTION_ID =
  "transmute.workflow.registry.desktop/v1" as const;

const MAX_GRAPH_PLAN_CANONICAL_BYTES = 256 * 1024 * 1024;
const MAX_GRAPH_PLAN_CANONICAL_DEPTH = 384;
const MAX_GRAPH_PLAN_CANONICAL_VALUES = 2_500_000;
const MAX_REGISTRY_DISCOVERY_CANONICAL_BYTES = 32 * 1024 * 1024;
const MAX_REGISTRY_DISCOVERY_CANONICAL_DEPTH = 16;
const MAX_REGISTRY_DISCOVERY_CANONICAL_VALUES = 1_000_000;

export const EMPTY_STATIC_BINDINGS: StaticBindings = StaticBindingsSchema.parse({
  candidates: [],
  initialSubjects: [],
  version: STATIC_BINDINGS_VERSION,
});

export interface CompileGraphPlanOptions {
  readonly bundle: unknown;
  readonly graph: unknown;
  readonly limits?: unknown;
  readonly registry: Pick<OperationRegistry, "list">;
  readonly runtime: unknown;
  readonly staticBindings?: unknown;
  readonly workflowInput: unknown;
}

function parseBoundary<Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  name: string,
): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApplicationError("invalid-data", `Invalid ${name}.`, {
      issues: result.error.issues.map(issue => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.map(String),
      })),
    });
  }
  return result.data;
}

function uniqueSorted<Value extends string>(
  values: Iterable<Value>,
): readonly Value[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeRuntime(input: unknown): WorkflowRuntimeIdentity {
  const parsed = parseBoundary(
    WorkflowRuntimeIdentitySchema,
    input,
    "workflow runtime identity",
  );
  const modules = uniqueSorted(parsed.externals.modules);
  if (modules.length !== parsed.externals.modules.length) {
    throw new ApplicationError(
      "invalid-data",
      "The runtime externals allowlist contains duplicate modules.",
    );
  }
  if (parsed.externals.kind === "deny-all" && modules.length > 0) {
    throw new ApplicationError(
      "invalid-data",
      "A deny-all externals policy cannot list modules.",
    );
  }
  return WorkflowRuntimeIdentitySchema.parse({
    ...parsed,
    externals: { ...parsed.externals, modules },
  });
}

function compareBinding(
  left: { readonly descriptorSha256: string; readonly id: string; readonly kind: string },
  right: { readonly descriptorSha256: string; readonly id: string; readonly kind: string },
): number {
  return left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id)
    || left.descriptorSha256.localeCompare(right.descriptorSha256);
}

function normalizeStaticBindings(input: unknown): StaticBindings {
  const parsed = parseBoundary(
    StaticBindingsSchema,
    input,
    "static workflow bindings",
  );
  const initialSubjects = [...parsed.initialSubjects].sort(compareBinding);
  const candidates = [...parsed.candidates].sort(compareBinding);
  const subjectKeys = new Set<string>();
  for (const subject of initialSubjects) {
    const key = `${subject.kind}:${subject.id}`;
    if (subjectKeys.has(key)) {
      throw new ApplicationError(
        "invalid-data",
        `Duplicate initial subject binding: ${key}`,
      );
    }
    subjectKeys.add(key);
  }
  const candidateKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.id}`;
    if (candidateKeys.has(key)) {
      throw new ApplicationError(
        "invalid-data",
        `Duplicate candidate descriptor: ${key}`,
      );
    }
    candidateKeys.add(key);
  }
  return StaticBindingsSchema.parse({
    candidates,
    initialSubjects,
    version: STATIC_BINDINGS_VERSION,
  });
}

export function createGraphPlanHash(planInput: unknown): string {
  const plan = parseBoundary(
    UnsignedGraphPlanV1Schema,
    planInput,
    "unsigned graph plan",
  );
  return boundedCanonicalJsonFingerprint(plan, {
    maximumBytes: MAX_GRAPH_PLAN_CANONICAL_BYTES,
    maximumDepth: MAX_GRAPH_PLAN_CANONICAL_DEPTH,
    maximumValues: MAX_GRAPH_PLAN_CANONICAL_VALUES,
    name: "unsigned graph plan",
  }, `${GRAPH_PLAN_HASH_DOMAIN}\0`).sha256;
}

export function createRegistryDiscoveryHash(discoveryInput: unknown): string {
  const discovery = parseBoundary(
    z.array(OperationDiscoverySchema),
    discoveryInput,
    "operation registry discovery",
  );
  return boundedCanonicalJsonFingerprint(
    discovery,
    {
      maximumBytes: MAX_REGISTRY_DISCOVERY_CANONICAL_BYTES,
      maximumDepth: MAX_REGISTRY_DISCOVERY_CANONICAL_DEPTH,
      maximumValues: MAX_REGISTRY_DISCOVERY_CANONICAL_VALUES,
      name: "operation registry discovery",
    },
    `${REGISTRY_DISCOVERY_HASH_DOMAIN}\0`,
  ).sha256;
}

export function compileGraphPlan(options: CompileGraphPlanOptions): GraphPlanV1 {
  const compiled = compileWorkflowGraph({
    graph: options.graph,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    projectionId: DESKTOP_WORKFLOW_REGISTRY_PROJECTION_ID,
    registry: options.registry,
    trustedCompute: true,
  });
  const bundle = parseBoundary(
    WorkflowBundleIdentitySchema,
    options.bundle,
    "workflow bundle identity",
  );
  const runtime = normalizeRuntime(options.runtime);
  const staticBindings = normalizeStaticBindings(
    options.staticBindings ?? EMPTY_STATIC_BINDINGS,
  );
  const workflowInput = parseBoundary(
    JsonValueSchema,
    options.workflowInput,
    "workflow input",
  );
  const unsigned = UnsignedGraphPlanV1Schema.parse({
    bundle,
    envelope: compiled.envelope,
    graph: compiled.graph,
    limits: compiled.limits satisfies GraphCompilerLimits,
    registry: { discovery: compiled.projection.discovery },
    runtime,
    staticBindings,
    topologicalWaves: compiled.topologicalWaves,
    version: GRAPH_PLAN_VERSION,
    workflowInput,
  });
  return GraphPlanV1Schema.parse({
    ...unsigned,
    graphPlanSha256: createGraphPlanHash(unsigned),
  });
}

export function parseGraphPlan(input: unknown): GraphPlanV1 {
  const parsed = parseBoundary(GraphPlanV1Schema, input, "graph plan");
  const { graphPlanSha256, ...unsignedInput } = parsed;
  const unsigned = UnsignedGraphPlanV1Schema.parse(unsignedInput);
  const expected = createGraphPlanHash(unsigned);
  if (graphPlanSha256 !== expected) {
    throw new ApplicationError(
      "invalid-data",
      "Graph plan hash does not match its contents.",
    );
  }
  const recompiled = compileGraphPlan({
    bundle: parsed.bundle,
    graph: parsed.graph,
    limits: parsed.limits,
    registry: { list: () => parsed.registry.discovery },
    runtime: parsed.runtime,
    staticBindings: parsed.staticBindings,
    workflowInput: parsed.workflowInput,
  });
  if (recompiled.graphPlanSha256 !== parsed.graphPlanSha256) {
    throw new ApplicationError(
      "invalid-data",
      "Graph plan topology, requirements, registry, or bindings do not match the embedded graph.",
    );
  }
  return recompiled;
}
