import type { ApplicationContext } from "../application/context";
import {
  bindTransmutePortableOperationInputV2,
  transmutePortableOutputPublicationParent,
} from "../application/operations/transmute-portable";
import {
  CreativeBaseV1Schema,
  createCreativeBaseV1,
} from "../application/creative-iteration";
import { ApplicationError } from "../application/errors";
import {
  gatewayPortRequestForOperation,
  gatewayRequestId,
  prepareGatewayOperation,
  reconcileGatewayOperation,
} from "../application/gateway-port";
import type { OperationKind } from "../application/operation";
import {
  openLeasedProjectSnapshot,
  withProjectPublicationLease,
} from "../application/project-publication-lease";
import {
  openProjectSnapshot,
  projectGenerationSha256FromHashes,
  projectMatchesEditBasis,
  ProjectEditBasisSchema,
} from "../application/project-store";
import {
  bindMediaOperationInput,
  bindTransmuteVisualOperationInput,
  bindAnalysisCapabilityInput,
  bindCreateCreativeCandidateInput,
  bindCreateCandidateRevisionInput,
  bindMaterializeVariantSelectionInput,
  bindPromoteVariantSelectionInput,
  bindCandidateRenderOutputInput,
  bindProjectCommitEditsInputV2FromSnapshot,
  bindProjectCommitEditsInputV3FromSnapshot,
  bindProjectAutoZoomInput,
  bindProjectInactivityInput,
  bindProjectRenderPlanInput,
  bindProjectRenderPlanInputV2,
  bindProjectRenderInput,
  bindProjectRenderInputV2,
  bindProjectRenderInputV3,
  bindProjectRenderToolchain,
  parseRecordingOperationOutput,
  projectEditCommitReceipt,
  projectEditTransactionId,
  reconcileVariantSelectionPromotion,
  reconcileProjectRender,
  summarizeGatewayOperation,
  CommitProjectEditsInputSchema,
  CommitProjectEditsInputV2Schema,
  CommitProjectEditsInputV3Schema,
  ProjectSnapshotOutputSchema,
  type CommitProjectEditsInput,
  type CommitProjectEditsInputV2,
  type CommitProjectEditsInputV3,
} from "../application/operations";
import { ProjectEditCommitReceiptSchema } from "../application/receipts";
import {
  LOCAL_VERIFIED_RECEIPT_OPERATION_KINDS,
  hasLocalVerifiedReceiptReconciler,
  reconcileLocalVerifiedReceiptOperation,
} from "../application/verified-receipt-reconciliation";
import {
  PROJECT_STATE_TRANSACTION_PATH,
  ProjectStateTransactionV1Schema,
} from "../cli/project-state-transaction";
import { resolveProjectDirectory } from "../cli/project-service";
import {
  canonicalJson,
  canonicalJsonFingerprint,
  canonicalJsonSha256,
  sha256Hex,
} from "../core/canonical-json";
import {
  createNodeBundleFileSystem,
  loadProjectEditPlan,
  loadVideoProject,
} from "../core/storage";
import {
  JsonValueSchema,
  isOperationGraphNode,
  type JsonValue,
} from "./contracts";
import { assertOperationFileProvenance } from "./file-candidate-provenance";
import type {
  NodeExecutionBinding,
  NodeExecutionPlanningRequest,
  NodePreparationBinding,
  NodePreparationRequest,
  NodeReconciliation,
  NodeReconciliationRequest,
  SchedulerNodePlanner,
} from "./scheduler";

const ANALYSIS_ID_DOMAIN = "studio.workflow.analysis-id/v1";
type RecordingOperationKind = Extract<OperationKind, `recording.${string}`>;
type GatewayOperationKind = Extract<OperationKind, `gateway.${string}`>;

export const APPLICATION_VERIFIED_RECEIPT_RECONCILER_KINDS =
  Object.freeze([
    ...LOCAL_VERIFIED_RECEIPT_OPERATION_KINDS,
    "render.project",
  ] as const satisfies readonly OperationKind[]);

function isRecordingOperationKind(
  kind: OperationKind,
): kind is RecordingOperationKind {
  return kind === "recording.start"
    || kind === "recording.pause"
    || kind === "recording.resume"
    || kind === "recording.stop";
}

function isGatewayOperationKind(
  kind: OperationKind,
): kind is GatewayOperationKind {
  return kind === "gateway.image"
    || kind === "gateway.video"
    || kind === "gateway.speech"
    || kind === "gateway.transcription";
}

function jsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function projectReference(input: JsonValue): string | undefined {
  if (!jsonObject(input)) return undefined;
  const project = input.project;
  if (typeof project === "string") return project;
  for (const key of ["revision", "plan"] as const) {
    const nested = input[key];
    if (nested !== undefined && jsonObject(nested)) {
      const projectId = nested.projectId;
      if (typeof projectId === "string") return projectId;
    }
  }
  return undefined;
}

function deterministicAnalysisInput(
  request: NodeExecutionPlanningRequest,
): JsonValue {
  const input = request.resolvedInput;
  if (
    (
      request.operation.kind !== "analysis.faces"
      && request.operation.kind !== "analysis.music"
      && request.operation.kind !== "analysis.project-inactivity"
    )
    || !jsonObject(input)
    || input.analysisId !== undefined
  ) {
    return input;
  }
  const suffix = sha256Hex(
    `${ANALYSIS_ID_DOMAIN}\0${canonicalJson({
      graphPlanSha256: request.graphPlan.graphPlanSha256,
      nodeKey: request.node.key,
      runId: request.runId,
    })}`,
  ).slice(0, 32);
  return JsonValueSchema.parse({
    ...input,
    analysisId: `analysis_${suffix}`,
  });
}

async function exactOperationInput(
  application: ApplicationContext,
  request: NodeExecutionPlanningRequest,
): Promise<JsonValue> {
  let deterministic = deterministicAnalysisInput(request);
  if (request.operation.kind === "edit.create-candidate-revision") {
    return JsonValueSchema.parse(
      await bindCreateCandidateRevisionInput(application, deterministic),
    );
  }
  if (request.operation.kind === "iteration.create-candidate") {
    return JsonValueSchema.parse(
      await bindCreateCreativeCandidateInput(application, deterministic),
    );
  }
  if (request.operation.kind === "project.promote-selection") {
    return JsonValueSchema.parse(
      bindPromoteVariantSelectionInput(application, deterministic),
    );
  }
  if (request.operation.kind === "render.materialize-selection") {
    return JsonValueSchema.parse(
      bindMaterializeVariantSelectionInput(application, deterministic),
    );
  }
  if (request.operation.kind === "render.bind-candidate-output") {
    return JsonValueSchema.parse(bindCandidateRenderOutputInput(
      deterministic,
      await bindProjectRenderToolchain(application),
    ));
  }
  if (
    request.operation.kind === "project.commit-edits"
    && request.operation.version === 2
  ) {
    const parsed = CommitProjectEditsInputV2Schema.parse(deterministic);
    const snapshot = await openLeasedProjectSnapshot(
      application,
      parsed.project,
    );
    deterministic = JsonValueSchema.parse(
      await bindProjectCommitEditsInputV2FromSnapshot(
        application,
        parsed,
        snapshot,
      ),
    );
  }
  if (
    request.operation.kind === "project.commit-edits"
    && request.operation.version === 3
  ) {
    const parsed = CommitProjectEditsInputV3Schema.parse(deterministic);
    const snapshot = await openLeasedProjectSnapshot(
      application,
      parsed.project,
    );
    deterministic = JsonValueSchema.parse(
      await bindProjectCommitEditsInputV3FromSnapshot(
        application,
        parsed,
        snapshot,
      ),
    );
  }
  if (
    request.operation.kind === "project.commit-edits"
    && jsonObject(deterministic)
    && deterministic.updatedAt === undefined
  ) {
    deterministic = JsonValueSchema.parse({
      ...deterministic,
      updatedAt: application.clock.now().toISOString(),
    });
  }
  if (request.operation.kind === "analysis.project-auto-zooms") {
    return JsonValueSchema.parse(
      await bindProjectAutoZoomInput(application, deterministic),
    );
  }
  if (
    request.operation.kind === "analysis.faces"
    || request.operation.kind === "analysis.music"
    || request.operation.kind === "analysis.scenes"
  ) {
    return JsonValueSchema.parse(
      await bindAnalysisCapabilityInput(
        application,
        request.operation.kind,
        deterministic,
      ),
    );
  }
  if (request.operation.kind === "analysis.project-inactivity") {
    return JsonValueSchema.parse(
      await bindProjectInactivityInput(application, deterministic),
    );
  }
  if (request.operation.kind === "render.project-plan") {
    if (request.operation.version === 1) {
      return JsonValueSchema.parse(
        await bindProjectRenderPlanInput(application, deterministic),
      );
    }
    if (request.operation.version === 2) {
      return JsonValueSchema.parse(
        await bindProjectRenderPlanInputV2(application, deterministic),
      );
    }
    throw new ApplicationError(
      "unsupported-plan",
      `Unsupported render.project-plan binding version: ${String(request.operation.version)}`,
    );
  }
  if (
    request.operation.kind === "media.ingest"
    || request.operation.kind === "media.overlay"
    || request.operation.kind === "media.html-overlay"
    || request.operation.kind === "media.audio-effects"
    || request.operation.kind === "media.color-grade"
  ) {
    return JsonValueSchema.parse(
      await bindMediaOperationInput(
        application,
        request.operation.kind,
        deterministic,
      ),
    );
  }
  if (
    request.operation.version === 1
    && (
      request.operation.kind === "transmute.diagram.check"
      || request.operation.kind === "transmute.diagram.render"
      || request.operation.kind === "transmute.image.vectorize"
    )
  ) {
    return JsonValueSchema.parse(
      await bindTransmuteVisualOperationInput(
        application,
        request.operation.kind,
        deterministic,
      ),
    );
  }
  if (
    request.operation.version === 2
    && (
      request.operation.kind === "transmute.diagram.check"
      || request.operation.kind === "transmute.diagram.render"
      || request.operation.kind === "transmute.image.generate"
      || request.operation.kind === "transmute.image.vectorize"
    )
  ) {
    return JsonValueSchema.parse(
      await bindTransmutePortableOperationInputV2(
        application,
        request.operation.kind,
        deterministic,
      ),
    );
  }
  if (request.operation.kind === "render.project") {
    if (request.operation.version === 1) {
      return JsonValueSchema.parse(
        await bindProjectRenderInput(application, deterministic),
      );
    }
    if (request.operation.version === 2) {
      return JsonValueSchema.parse(
        await bindProjectRenderInputV2(application, deterministic),
      );
    }
    if (request.operation.version === 3) {
      return JsonValueSchema.parse(
        await bindProjectRenderInputV3(application, deterministic),
      );
    }
    throw new ApplicationError(
      "unsupported-plan",
      `Unsupported render.project binding version: ${String(request.operation.version)}`,
    );
  }
  if (isGatewayOperationKind(request.operation.kind)) {
    const prepared = await prepareGatewayOperation(application, {
      request: gatewayPortRequestForOperation(
        request.operation.kind,
        deterministic,
      ),
      signal: new AbortController().signal,
    });
    return JsonValueSchema.parse(prepared.request);
  }
  return deterministic;
}

function inputDescriptor(request: NodePreparationRequest): JsonValue {
  const input = JsonValueSchema.parse(request.resolvedInput);
  const fingerprint = canonicalJsonFingerprint(
    input,
    "studio.workflow.input-descriptor/v1\0",
  );
  const project = projectReference(input);
  return JsonValueSchema.parse({
    bytes: fingerprint.bytes,
    inputSha256: fingerprint.sha256,
    ...(project === undefined ? {} : { project }),
  });
}

function publishesProject(request: NodeExecutionPlanningRequest): boolean {
  return request.operation.policy.effect === "project-mutation"
    || request.operation.policy.resources.some(
      claim => claim.resource === "project-publication",
    );
}

function publicationKeys(
  request: NodeExecutionPlanningRequest,
  input: JsonValue,
  project: string | undefined,
): readonly string[] {
  if (request.operation.version === 2 && jsonObject(input)) {
    if (
      request.operation.kind === "transmute.diagram.render"
      || request.operation.kind === "transmute.image.generate"
      || request.operation.kind === "transmute.image.vectorize"
    ) {
      const publicationParent = transmutePortableOutputPublicationParent(
        request.operation.kind,
        input,
      );
      if (publicationParent === undefined) return [];
      return [
        `output:transmute:${sha256Hex(
          `studio.workflow.output-publication/v1\0${publicationParent}`,
        )}`,
      ];
    }
  }
  if (
    request.operation.kind === "render.project"
    && jsonObject(input)
    && project !== undefined
  ) {
    const output = input.output;
    if (
      output === undefined
      || !jsonObject(output)
      || typeof output.path !== "string"
    ) return [];
    return [
      `output:${project}:${sha256Hex(
        `studio.workflow.output-publication/v1\0${output.path}`,
      )}`,
    ];
  }
  if (
    request.operation.kind === "render.materialize-selection"
    && jsonObject(input)
    && project !== undefined
    && typeof input.destinationPath === "string"
  ) {
    return [
      `output:${project}:${sha256Hex(
        `studio.workflow.output-publication/v1\0${input.destinationPath}`,
      )}`,
    ];
  }
  if (!publishesProject(request)) return [];
  return project === undefined
    ? [`operation:${request.operation.kind}`]
    : [`project:${project}`];
}

function assertProjectProvenance(
  request: NodeExecutionPlanningRequest,
  project: string | undefined,
): void {
  if (project === undefined) return;
  const authorized = request.graphPlan.staticBindings.initialSubjects.some(subject => (
    subject.kind === "project" && subject.id === project
  ));
  if (!authorized) {
    throw new ApplicationError(
      "authorization-required",
      `Node ${request.node.key} received a project identity that was not structurally bound during planning.`,
      {
        operation: request.operation.kind,
        project,
      },
    );
  }
}

function staticProjectGeneration(
  request: NodeExecutionPlanningRequest,
  project: string,
): string {
  const subject = request.graphPlan.staticBindings.initialSubjects.find(
    candidate => candidate.kind === "project" && candidate.id === project,
  );
  if (subject === undefined || subject.kind !== "project") {
    throw new ApplicationError(
      "authorization-required",
      `Node ${request.node.key} has no plan-time project generation binding.`,
      { operation: request.operation.kind, project },
    );
  }
  return projectGenerationSha256FromHashes({
    currentPlanSha256: subject.planSha256,
    projectSha256: subject.projectSha256,
  });
}

function nestedGenerationSha256(
  input: JsonValue,
): string | undefined {
  if (!jsonObject(input)) return undefined;
  const binding = input.binding;
  if (binding !== undefined && jsonObject(binding)) {
    const projectGenerationSha256 = binding.projectGenerationSha256;
    if (typeof projectGenerationSha256 === "string") {
      return projectGenerationSha256;
    }
  }
  for (const key of ["draft", "revision"] as const) {
    const nested = input[key];
    if (nested === undefined || !jsonObject(nested)) continue;
    const baseGeneration = nested.baseGeneration;
    if (baseGeneration === undefined || !jsonObject(baseGeneration)) continue;
    const generationSha256 = baseGeneration.generationSha256;
    if (typeof generationSha256 === "string") return generationSha256;
  }
  return undefined;
}

function dependencyProjectGeneration(
  request: NodeExecutionPlanningRequest,
  project: string,
): string | undefined {
  const candidates = new Set<string>();
  const nodes = new Map(
    request.graphPlan.graph.nodes.map(node => [node.key, node]),
  );
  for (const [nodeKey, output] of Object.entries(request.dependencyOutputs)) {
    const node = nodes.get(nodeKey);
    if (node === undefined || !isOperationGraphNode(node)) continue;
    if (node.executor.operation.kind === "project.snapshot") {
      const parsed = ProjectSnapshotOutputSchema.safeParse(output.value);
      if (
        parsed.success
        && parsed.data.project.projectId === project
      ) {
        candidates.add(parsed.data.generation.generationSha256);
      }
      continue;
    }
    if (node.executor.operation.kind === "project.commit-edits") {
      const parsed = ProjectEditCommitReceiptSchema.safeParse(output.value);
      if (
        parsed.success
        && parsed.data.projectId === project
      ) {
        candidates.add(parsed.data.generation.generationSha256);
      }
    }
  }
  if (candidates.size > 1) {
    throw new ApplicationError(
      "conflict",
      `Node ${request.node.key} depends on incompatible project generations.`,
      { operation: request.operation.kind, project },
    );
  }
  return [...candidates][0];
}

function assertProjectEditBasisProvenance(
  request: NodeExecutionPlanningRequest,
  input: JsonValue,
  project: string,
): void {
  if (
    request.operation.kind !== "project.commit-edits"
    && request.operation.kind !== "edit.freeze-revision"
  ) return;
  if (!jsonObject(input)) {
    throw new ApplicationError(
      "authorization-required",
      `Node ${request.node.key} has no typed project edit basis.`,
    );
  }
  const exactBasis = ProjectEditBasisSchema.parse(input.basis);
  const candidates = new Map<string, typeof exactBasis>();
  const nodes = new Map(
    request.graphPlan.graph.nodes.map(node => [node.key, node]),
  );
  for (const [nodeKey, output] of Object.entries(request.dependencyOutputs)) {
    const node = nodes.get(nodeKey);
    if (node === undefined || !isOperationGraphNode(node)) continue;
    if (node.executor.operation.kind === "project.snapshot") {
      const parsed = ProjectSnapshotOutputSchema.safeParse(output.value);
      if (parsed.success && parsed.data.project.projectId === project) {
        candidates.set(canonicalJson(parsed.data.editBasis), parsed.data.editBasis);
      }
      continue;
    }
    if (node.executor.operation.kind === "project.commit-edits") {
      const parsed = ProjectEditCommitReceiptSchema.safeParse(output.value);
      if (parsed.success && parsed.data.projectId === project) {
        candidates.set(canonicalJson(parsed.data.editBasis), parsed.data.editBasis);
      }
    }
  }
  if (
    candidates.size !== 1
    || !candidates.has(canonicalJson(exactBasis))
  ) {
    throw new ApplicationError(
      "authorization-required",
      `Node ${request.node.key} must carry its edit basis directly from one host-owned project snapshot or commit.`,
      { operation: request.operation.kind, project },
    );
  }
}

function assertCreativeBaseProvenance(
  request: NodeExecutionPlanningRequest,
  input: JsonValue,
): void {
  if (
    request.operation.kind !== "edit.create-candidate-revision"
    && request.operation.kind !== "iteration.create-candidate"
  ) return;
  if (!jsonObject(input)) {
    throw new ApplicationError(
      "authorization-required",
      `Node ${request.node.key} has no exact creative base.`,
    );
  }
  const exactBase = CreativeBaseV1Schema.parse(input.base);
  const candidates = new Set<string>();
  const nodes = new Map(
    request.graphPlan.graph.nodes.map(node => [node.key, node]),
  );
  for (const [nodeKey, output] of Object.entries(request.dependencyOutputs)) {
    const node = nodes.get(nodeKey);
    if (
      node === undefined
      || !isOperationGraphNode(node)
      || node.executor.operation.kind !== "project.snapshot"
    ) continue;
    const snapshot = ProjectSnapshotOutputSchema.safeParse(output.value);
    if (!snapshot.success || snapshot.data.project.projectId !== exactBase.projectId) {
      continue;
    }
    candidates.add(canonicalJson(createCreativeBaseV1({
      currentPlan: snapshot.data.currentPlan,
      project: snapshot.data.project,
    })));
  }
  const authoredInput = request.node.input;
  if (
    typeof authoredInput === "object"
    && authoredInput !== null
    && !Array.isArray(authoredInput)
    && "snapshot" in authoredInput
  ) {
    const persisted = ProjectSnapshotOutputSchema.safeParse(
      authoredInput.snapshot,
    );
    if (persisted.success) {
      candidates.add(canonicalJson(createCreativeBaseV1({
        currentPlan: persisted.data.currentPlan,
        project: persisted.data.project,
      })));
    }
  }
  if (
    candidates.size !== 1
    || !candidates.has(canonicalJson(exactBase))
  ) {
    throw new ApplicationError(
      "authorization-required",
      `Node ${request.node.key} must carry its exact creative base from one host-owned or persisted project snapshot.`,
      {
        operation: request.operation.kind,
        project: exactBase.projectId,
      },
    );
  }
}

function resolveExpectedProjectGeneration(
  request: NodeExecutionPlanningRequest,
  input: JsonValue,
  project: string,
): string | undefined {
  if (request.operation.kind === "project.snapshot") {
    return staticProjectGeneration(request, project);
  }
  if (
    request.operation.kind === "project.commit-edits"
    || request.operation.kind === "edit.freeze-revision"
    || request.operation.kind === "edit.create-candidate-revision"
    || request.operation.kind === "iteration.create-candidate"
    || request.operation.kind === "iteration.create-matrix"
    || request.operation.kind === "iteration.select"
    || request.operation.kind === "project.promote-selection"
    || request.operation.kind === "render.materialize-selection"
    || request.operation.kind === "render.bind-candidate-output"
  ) {
    return undefined;
  }
  if (
    request.operation.kind === "analysis.faces"
    || request.operation.kind === "analysis.music"
    || request.operation.kind === "analysis.project-inactivity"
    || request.operation.kind === "analysis.project-auto-zooms"
    || request.operation.kind === "analysis.scenes"
  ) {
    // Parallel analyses bind a host-owned ProjectEditBasis in their exact
    // input. That basis tolerates only append-only sibling analysis
    // publication; a full generation hash would make a legitimate sibling
    // completion poison deterministic resume.
    return undefined;
  }
  const explicit = nestedGenerationSha256(input);
  const dependency = dependencyProjectGeneration(request, project);
  if (
    explicit !== undefined
    && dependency !== undefined
    && explicit !== dependency
  ) {
    throw new ApplicationError(
      "conflict",
      `Node ${request.node.key} carries incompatible explicit and dependency project generations.`,
      { operation: request.operation.kind, project },
    );
  }
  const resolved = explicit ?? dependency;
  if (
    resolved === undefined
    && request.operation.policy.preparation.includes("project-state")
  ) {
    throw new ApplicationError(
      "authorization-required",
      `Node ${request.node.key} must carry a typed project snapshot or commit dependency.`,
      { operation: request.operation.kind, project },
    );
  }
  return resolved;
}

export function createApplicationNodePlanner(
  application: ApplicationContext,
): SchedulerNodePlanner {
  return {
    prepare: (request): Promise<NodePreparationBinding> => {
      const descriptors = inputDescriptor(request);
      const authoredBytes = jsonObject(descriptors)
        && typeof descriptors.bytes === "number"
        ? descriptors.bytes
        : undefined;
      const upperInputBytes = request.operation.policy.maxInputBytes;
      if (
        authoredBytes === undefined
        || !Number.isSafeInteger(authoredBytes)
        || authoredBytes < 0
        || !Number.isSafeInteger(upperInputBytes)
        || upperInputBytes < 0
      ) {
        throw new ApplicationError(
          "internal",
          `Could not derive an input byte bound for node ${request.node.key}.`,
        );
      }
      if (authoredBytes > upperInputBytes) {
        throw new ApplicationError(
          "invalid-data",
          `Authored input for node ${request.node.key} exceeds the operation's registered input limit.`,
        );
      }
      return Promise.resolve({
        inputDescriptors: descriptors,
        // Host binding may append timestamps, immutable media identities,
        // capability evidence, or provider-normalized fields. Retain the
        // authored byte count in the descriptors while authorizing no more
        // than the operation's registered hard input ceiling.
        upperInputBytes,
      });
    },
    plan: async (request): Promise<NodeExecutionBinding> => {
      // Reject compute-minted paths before any host code opens, hashes, probes,
      // uploads, or prices the referenced file.
      assertOperationFileProvenance(request);
      assertProjectProvenance(
        request,
        projectReference(request.resolvedInput),
      );
      const exactInput = await exactOperationInput(application, request);
      assertCreativeBaseProvenance(request, exactInput);
      const project = projectReference(exactInput);
      assertProjectProvenance(request, project);
      if (project !== undefined) {
        assertProjectEditBasisProvenance(request, exactInput, project);
      }
      const keys = publicationKeys(request, exactInput, project);
      let expectedProjectGeneration: string | undefined;
      if (
        project !== undefined
        && request.operation.policy.preparation.includes("project-state")
      ) {
        expectedProjectGeneration = resolveExpectedProjectGeneration(
          request,
          exactInput,
          project,
        );
      }
      return {
        exactInput,
        ...(expectedProjectGeneration === undefined
          ? {}
          : { expectedProjectGeneration }),
        publicationKeys: keys,
      };
    },
    reconcile: async (request): Promise<NodeReconciliation> => (
      await reconcileApplicationNode(request.application, request)
    ),
  };
}

function exactReconciliationInput(
  request: NodeReconciliationRequest,
): JsonValue {
  return request.executionPlan?.exactInput ?? request.resolvedInput;
}

async function reconcileRenderNode(
  application: ApplicationContext,
  request: NodeReconciliationRequest,
): Promise<NodeReconciliation> {
  const executionPlan = request.executionPlan;
  if (executionPlan === undefined) {
    return {
      kind: "incompatible",
      message: "Interrupted render is missing its exact execution plan.",
    };
  }
  const result = await reconcileProjectRender(
    application,
    executionPlan.exactInput,
    {
      nodeKey: request.node.key,
      nodePlanSha256: executionPlan.nodePlanSha256,
      runId: request.runId,
    },
    {
      abortSignal: request.abortSignal,
      beforePublication: request.beforePublication,
    },
  );
  if (result.kind === "retry") return result;
  if (result.kind === "conflict") {
    return { kind: "incompatible", message: result.message };
  }
  const output = JsonValueSchema.parse(result.output);
  return {
    kind: "completed",
    output,
    receiptReference: result.output.receipt.path,
    summary: {
      bytes: result.output.output.bytes,
      outputPath: result.output.output.path,
      outputSha256: result.output.output.sha256,
      projectId: result.output.output.projectId,
      receiptPath: result.output.receipt.path,
      revisionSha256: result.output.output.revisionSha256,
    },
  };
}

async function reconcileRecordingNode(
  application: ApplicationContext,
  operationKind: RecordingOperationKind,
): Promise<NodeReconciliation> {
  const controller = application.recordingController;
  if (controller === undefined) {
    return {
      kind: "ambiguous",
      message: "Recording controller is unavailable for live-state reconciliation.",
    };
  }
  let output;
  try {
    output = parseRecordingOperationOutput(await controller.status());
  } catch (error) {
    return {
      kind: "ambiguous",
      message: error instanceof Error
        ? `Recording state could not be reconciled: ${error.message}`
        : "Recording state could not be reconciled.",
    };
  }
  return {
    kind: "ambiguous",
    message: `Current controller state ${output.state} for ${
      output.recordingId ?? "no active recording"
    } is not an exact receipt proving ${operationKind} completed; issue a new explicit action.`,
  };
}

async function reconcileGatewayNode(
  application: ApplicationContext,
  request: NodeReconciliationRequest,
  operationKind: GatewayOperationKind,
): Promise<NodeReconciliation> {
  const executionPlan = request.executionPlan;
  if (executionPlan === undefined) {
    return {
      kind: "incompatible",
      message: "Interrupted Gateway dispatch is missing its exact execution plan.",
    };
  }
  const gatewayRequest = gatewayPortRequestForOperation(
    operationKind,
    executionPlan.exactInput,
  );
  const requestId = gatewayRequestId({
    nodeKey: request.node.key,
    nodePlanSha256: executionPlan.nodePlanSha256,
    operation: gatewayRequest.operation,
    runId: request.runId,
  });
  const reconciliation = await reconcileGatewayOperation(application, {
    request: gatewayRequest,
    requestId,
    signal: request.abortSignal,
  });
  switch (reconciliation.status) {
    case "completed": {
      const summary = summarizeGatewayOperation(
        operationKind,
        reconciliation.result,
      );
      return {
        kind: "completed",
        output: JsonValueSchema.parse(reconciliation.result),
        receiptReference: reconciliation.result.receipt.path,
        summary: summary.fields,
      };
    }
    case "not-dispatched":
      return {
        kind: "ambiguous",
        message:
          "The durable Gateway journal proves no paid call crossed dispatch, but ambiguous paid nodes require a fresh exact approval instead of automatic replay.",
      };
    case "dispatched":
      return {
        kind: "ambiguous",
        message:
          "The durable Gateway journal records paid dispatch without a completed authoritative receipt; Transmute will not resubmit it.",
      };
    case "failed":
      return {
        kind: "incompatible",
        message:
          `The Gateway request has an authoritative failure receipt at ${reconciliation.failureReceipt.path}.`,
      };
    case "conflict":
      return {
        kind: "incompatible",
        message:
          "The Gateway journal conflicts with this exact workflow request identity.",
      };
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readProjectTransaction(
  application: ApplicationContext,
  project: string,
) {
  const directory = await resolveProjectDirectory(
    application.paths.projectRoot,
    project,
  );
  const fileSystem = createNodeBundleFileSystem(directory.path);
  try {
    const text = await fileSystem.readText(PROJECT_STATE_TRANSACTION_PATH);
    return ProjectStateTransactionV1Schema.parse(
      JSON.parse(text) as unknown,
    );
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function reconcileProjectCommit(
  application: ApplicationContext,
  request: NodeReconciliationRequest,
): Promise<NodeReconciliation> {
  const executionPlan = request.executionPlan;
  const input = exactReconciliationInput(request);
  const project = projectReference(input);
  if (
    executionPlan === undefined
    || project === undefined
    || !jsonObject(input)
  ) {
    return {
      kind: "incompatible",
      message: "Interrupted project commit is missing its exact project-bound plan.",
    };
  }
  return await withProjectPublicationLease(
    application,
    "project.commit-edits",
    { project },
    async () => {
      await request.beforePublication();
      const [transaction, snapshot] = await Promise.all([
        readProjectTransaction(application, project),
        openProjectSnapshot(application.paths.projectRoot, project),
      ]);
      let parsedInput:
        | CommitProjectEditsInput
        | CommitProjectEditsInputV2
        | CommitProjectEditsInputV3;
      if (request.operation.version === 1) {
        parsedInput = CommitProjectEditsInputSchema.parse(input);
      } else if (request.operation.version === 2) {
        parsedInput = CommitProjectEditsInputV2Schema.parse(input);
      } else if (request.operation.version === 3) {
        parsedInput = CommitProjectEditsInputV3Schema.parse(input);
      } else {
        return {
          kind: "incompatible",
          message:
            `Interrupted project commit uses unsupported operation version ${request.operation.version}.`,
        };
      }
      if (projectMatchesEditBasis(parsedInput.basis, snapshot)) {
        return { kind: "retry" };
      }
      const transactionId = projectEditTransactionId(
        executionPlan.nodePlanSha256,
      );
      if (
        transaction?.transactionId !== transactionId
        || transaction.phase !== "settled"
        || transaction.active !== "after"
      ) {
        return {
          kind: "incompatible",
          message: "Project state changed without this node's settled transaction receipt.",
        };
      }
      const directory = await resolveProjectDirectory(
        application.paths.projectRoot,
        project,
      );
      const fileSystem = createNodeBundleFileSystem(directory.path);
      const [transactionProject, transactionPlan] = await Promise.all([
        loadVideoProject(fileSystem, transaction.after.project.path),
        loadProjectEditPlan(fileSystem, transaction.after.plan.path),
      ]);
      const output = projectEditCommitReceipt(
        parsedInput,
        transactionProject,
        transactionPlan,
      );
      if (
        transaction.after.plan.sha256 !== output.planHash
        || transaction.after.project.sha256
          !== output.generation.projectSha256
        || transaction.after.project.sha256
          !== canonicalJsonSha256(transactionProject)
        || transaction.after.plan.sha256
          !== canonicalJsonSha256(transactionPlan)
        || !projectMatchesEditBasis(output.editBasis, snapshot)
      ) {
        return {
          kind: "incompatible",
          message: "Settled project transaction does not match the current generation.",
        };
      }
      return {
        kind: "completed",
        output: JsonValueSchema.parse(output),
        summary: {
          generationSha256: output.generation.generationSha256,
          operation: output.operation,
          planHash: output.planHash,
          planId: output.planId,
          projectId: output.projectId,
        },
      };
    },
    request.beforePublication,
  );
}

async function reconcileVariantPromotionNode(
  application: ApplicationContext,
  request: NodeReconciliationRequest,
): Promise<NodeReconciliation> {
  const executionPlan = request.executionPlan;
  if (executionPlan === undefined) {
    return {
      kind: "incompatible",
      message: "Interrupted editorial promotion is missing its exact project-bound plan.",
    };
  }
  const project = projectReference(executionPlan.exactInput);
  if (project === undefined) {
    return {
      kind: "incompatible",
      message: "Interrupted editorial promotion has no exact project identity.",
    };
  }
  return await withProjectPublicationLease(
    application,
    "project.promote-selection",
    { project },
    async () => {
      await request.beforePublication();
      const reconciliation = await reconcileVariantSelectionPromotion(
        application,
        executionPlan.exactInput,
      );
      if (reconciliation.kind === "retry") return reconciliation;
      if (reconciliation.kind === "conflict") {
        return { kind: "incompatible", message: reconciliation.message };
      }
      const output = reconciliation.output;
      return {
        kind: "completed",
        output: JsonValueSchema.parse(output),
        receiptReference: output.artifact.path,
        summary: {
          projectId: output.projectId,
          promotedPlanSha256: output.promotedPlanSha256,
          promotionSha256: output.promotionSha256,
          selectionSha256: output.selectionSha256,
        },
      };
    },
    request.beforePublication,
  );
}

async function reconcileApplicationNode(
  application: ApplicationContext,
  request: NodeReconciliationRequest,
): Promise<NodeReconciliation> {
  if (request.operation.kind === "render.project") {
    return await reconcileRenderNode(application, request);
  }
  if (isGatewayOperationKind(request.operation.kind)) {
    return await reconcileGatewayNode(
      application,
      request,
      request.operation.kind,
    );
  }
  if (isRecordingOperationKind(request.operation.kind)) {
    return await reconcileRecordingNode(
      application,
      request.operation.kind,
    );
  }
  if (request.operation.kind === "project.commit-edits") {
    return await reconcileProjectCommit(application, request);
  }
  if (request.operation.kind === "project.promote-selection") {
    return await reconcileVariantPromotionNode(application, request);
  }
  if (hasLocalVerifiedReceiptReconciler(request.operation.kind)) {
    const executionPlan = request.executionPlan;
    const workspaceDirectory = request.workspaceDirectory;
    if (
      executionPlan === undefined
      || workspaceDirectory === undefined
    ) {
      return {
        kind: "incompatible",
        message:
          "Interrupted verified-receipt operation is missing its exact private recovery workspace.",
      };
    }
    const reconciliation = await reconcileLocalVerifiedReceiptOperation(
      application,
      {
        abortSignal: request.abortSignal,
        beforePublication: request.beforePublication,
        exactInput: executionPlan.exactInput,
        ...(executionPlan.expectedProjectGeneration === undefined
          ? {}
          : {
            expectedProjectGeneration:
              executionPlan.expectedProjectGeneration,
          }),
        identity: {
          inputSchemaId: request.operation.inputSchemaId,
          kind: request.operation.kind,
          nodeKey: request.node.key,
          nodePlanSha256: executionPlan.nodePlanSha256,
          outputSchemaId: request.operation.outputSchemaId,
          runId: request.runId,
          version: request.operation.version,
        },
        workspaceDirectory,
      },
    );
    if (reconciliation.kind !== "completed") return reconciliation;
    return {
      ...reconciliation,
      output: JsonValueSchema.parse(reconciliation.output),
    };
  }
  if (request.resumeClass === "deterministic") {
    return { kind: "retry" };
  }
  return {
    kind: "ambiguous",
    message: `Operation ${request.operation.kind} has no application reconciliation boundary.`,
  };
}
