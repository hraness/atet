import type { OperationRegistry } from "../application/registry";
import {
  CODE_WORKER_ABI,
  GRAPH_ABI,
  GRAPH_COMPILER_ABI,
  GRAPH_SCHEDULER_ABI,
  type GraphCompilerLimits,
  type GraphPlanV1,
  type StaticBindings,
  type WorkflowBundleIdentity,
  type WorkflowOutputValue,
  type WorkflowRuntimeIdentity,
} from "./contracts";
import {
  DEFAULT_GRAPH_COMPILER_LIMITS,
  EMPTY_STATIC_BINDINGS,
  compileGraphPlan,
} from "./compiler";
import {
  buildWorkflow,
  type WorkflowDefinition,
} from "./define-workflow";

const TEST_HASH = "0".repeat(64);

export const TESTING_WORKFLOW_BUNDLE = Object.freeze({
  bundleSha256: TEST_HASH,
  bytes: 0,
  dependencyGraphSha256: TEST_HASH,
  entrypoint: "testing/workflow.ts",
  sourceSha256: TEST_HASH,
}) satisfies WorkflowBundleIdentity;

export const TESTING_WORKFLOW_RUNTIME = Object.freeze({
  applicationBuild: "atet-testing",
  bunRevision: "testing-revision",
  bunVersion: "1.3.14",
  bundlerConfigurationSha256: TEST_HASH,
  bundlerName: "bun",
  bundlerRevision: "testing-revision",
  bundlerVersion: "1.3.14",
  compilerAbi: GRAPH_COMPILER_ABI,
  codeWorkerAbi: CODE_WORKER_ABI,
  externals: {
    kind: "deny-all" as const,
    modules: [],
    policySha256: TEST_HASH,
  },
  graphAbi: GRAPH_ABI,
  schedulerAbi: GRAPH_SCHEDULER_ABI,
}) satisfies WorkflowRuntimeIdentity;

export interface CompileTestingWorkflowOptions<Input, Output extends WorkflowOutputValue> {
  readonly bundle?: WorkflowBundleIdentity;
  readonly definition: WorkflowDefinition<Input, Output>;
  readonly input: unknown;
  readonly limits?: Partial<GraphCompilerLimits>;
  readonly registry: Pick<OperationRegistry, "list">;
  readonly runtime?: WorkflowRuntimeIdentity;
  readonly staticBindings?: StaticBindings;
}

export function compileTestingWorkflow<Input, Output extends WorkflowOutputValue>(
  options: CompileTestingWorkflowOptions<Input, Output>,
): GraphPlanV1 {
  const built = buildWorkflow(options.definition, options.registry, options.input);
  return compileGraphPlan({
    bundle: options.bundle ?? TESTING_WORKFLOW_BUNDLE,
    graph: built.graph,
    limits: {
      ...DEFAULT_GRAPH_COMPILER_LIMITS,
      ...options.limits,
    },
    registry: options.registry,
    runtime: options.runtime ?? TESTING_WORKFLOW_RUNTIME,
    staticBindings: options.staticBindings ?? EMPTY_STATIC_BINDINGS,
    workflowInput: built.input,
  });
}
