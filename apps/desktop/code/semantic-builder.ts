import type {
  CandidateProjectRenderInput,
  BindCandidateRevisionOutput,
  CommitProjectEditsOutput,
  CreateCandidateRevisionOutput,
  CreateCreativeCandidateOutput,
  CreateVariantMatrixOutput,
  CreateProjectEditRevisionOutput,
  FacesOperationInput,
  FacesOperationOutput,
  FaceFollowRevisionDraft,
  FollowFacesInput,
  FreezeProjectEditRevisionOutput,
  HtmlOverlayInputRequest,
  HtmlOverlayOutput,
  MediaAudioEffectsInput,
  MediaAudioEffectsOutput,
  MediaColorGradeInput,
  MediaColorGradeOutput,
  MediaIngestInput,
  MediaIngestOutput,
  MediaOverlayInputRequest,
  MediaOverlayOutput,
  MaterializeVariantSelectionOutput,
  MusicOperationInput,
  MusicOperationOutput,
  ManualProjectCameraMoveInputV2,
  ManualProjectZoomInputV3,
  OrderedProjectEdit,
  OrderedProjectEditV2,
  OrderedProjectEditV3,
  ProjectEditBatch,
  ProjectEditBatchV2,
  ProjectEditBatchV3,
  ProjectInactivityOperationInput,
  ProjectInactivityOperationOutput,
  ProjectAutoZoomInput,
  ProjectAutoZoomOutput,
  ProjectRenderInput,
  ProjectRenderInputV2,
  ProjectRenderOutput,
  ProjectRenderPlanInput,
  ProjectRenderPlanInputV2,
  ProjectRenderPlanOutput,
  ProjectSnapshotOutput,
  PromoteVariantSelectionOutput,
  RecordingPauseOutput,
  RecordingResumeOutput,
  RecordingStartInput,
  RecordingStartOutput,
  RecordingStopOutput,
  SceneAnalysisOperationInput,
  SceneAnalysisOperationOutput,
  SelectVariantInput,
  SelectVariantOutput,
} from "../application/operations";
import type {
  CandidateProjectEditBatchV3,
} from "../application/creative-iteration";
import type { ProjectEditRevisionRenderInput } from "../application";
import type {
  GatewayImageOperationInput,
  GatewayImageOperationResult,
  GatewaySpeechOperationInput,
  GatewaySpeechOperationResult,
  GatewayTranscriptionOperationInput,
  GatewayTranscriptionOperationResult,
  GatewayVideoOperationInput,
  GatewayVideoOperationResult,
} from "../application/gateway-port";
import type {
  OverlayOperation,
  ProjectRenderSyncPolicy,
  ProjectRenderTarget,
  ProjectZoomOperation,
  SourceInterval,
} from "../contracts";
import { canonicalJsonSha256 } from "../core/canonical-json";
import type {
  AnyTrustedComputeDefinition,
  OperationContract,
  OperationInputValue,
  Ref,
  TrustedComputeDefinition,
  WorkflowIdentity,
  WorkflowOutputValue,
} from "./contracts";
import {
  WorkflowGraphBuilder,
  type OperationDiscoverySource,
  type OperationNodeOptions,
  type UntypedOperationRequest,
} from "./graph-builder";
import {
  addManualCameraMoves as addManualCameraMovesEdit,
  addManualZooms as addManualZoomsEdit,
  removeCameraMoves as removeCameraMovesEdit,
  removeZooms as removeZoomsEdit,
  setMetadataEffects as setMetadataEffectsEdit,
  type ManualZoomInput,
  type MetadataEffectsOptions,
} from "./editing";

export interface WorkflowFragment<Input, Output> {
  readonly build: (builder: WorkflowBuilder, input: Input) => Output;
}

export function defineWorkflowFragment<Input, Output>(
  build: (builder: WorkflowBuilder, input: Input) => Output,
): WorkflowFragment<Input, Output> {
  return Object.freeze({ build });
}

export interface ProjectSnapshotHandle {
  readonly editBasis:
    | ProjectSnapshotOutput["editBasis"]
    | Ref<ProjectSnapshotOutput["editBasis"]>;
  readonly generationSha256: string | Ref<string>;
  readonly projectId: string | Ref<string>;
  readonly snapshot: ProjectSnapshotOutput | Ref<ProjectSnapshotOutput>;
}

export interface ProducedProjectSnapshotHandle extends ProjectSnapshotHandle {
  readonly editBasis: Ref<ProjectSnapshotOutput["editBasis"]>;
  readonly generationSha256: Ref<string>;
  readonly projectId: Ref<string>;
  readonly snapshot: Ref<ProjectSnapshotOutput>;
}

export interface CommittedProjectHandle {
  readonly editBasis: Ref<CommitProjectEditsOutput["editBasis"]>;
  readonly generationSha256: Ref<string>;
  readonly projectId: Ref<string>;
  readonly receipt: Ref<CommitProjectEditsOutput>;
}

export type ProjectHandle = CommittedProjectHandle | ProjectSnapshotHandle;

export interface ProjectEditRevisionHandle {
  readonly projectId: Ref<string>;
  readonly revision: Ref<ProjectEditRevisionRenderInput>;
}

export type CreativeCandidateBatch =
  | CandidateProjectEditBatchV3
  | Ref<CandidateProjectEditBatchV3>;

export interface CreativeCandidateRevisionHandle {
  readonly batch: CreativeCandidateBatch;
  readonly project: ProjectSnapshotHandle;
  readonly projectId: Ref<string>;
  readonly reference: Ref<CreateCandidateRevisionOutput>;
  readonly variantKey: string;
}

export interface BoundCreativeCandidateRevisionHandle
  extends ProjectEditRevisionHandle {
  readonly candidateRevision: CreativeCandidateRevisionHandle;
}

export interface CandidateRenderBindingHandle {
  readonly input: Ref<CandidateProjectRenderInput>;
}

export interface CreativeCandidateHandle {
  readonly projectId: string | Ref<string>;
  readonly reference:
    | CreateCreativeCandidateOutput
    | Ref<CreateCreativeCandidateOutput>;
}

export interface ProducedCreativeCandidateHandle extends CreativeCandidateHandle {
  readonly projectId: Ref<string>;
  readonly reference: Ref<CreateCreativeCandidateOutput>;
}

export interface VariantMatrixHandle {
  readonly projectId: string | Ref<string>;
  readonly reference: CreateVariantMatrixOutput | Ref<CreateVariantMatrixOutput>;
}

export interface ProducedVariantMatrixHandle extends VariantMatrixHandle {
  readonly projectId: Ref<string>;
  readonly reference: Ref<CreateVariantMatrixOutput>;
}

export interface VariantSelectionHandle {
  readonly projectId: string | Ref<string>;
  readonly reference: SelectVariantOutput | Ref<SelectVariantOutput>;
}

export interface ProducedVariantSelectionHandle extends VariantSelectionHandle {
  readonly projectId: Ref<string>;
  readonly reference: Ref<SelectVariantOutput>;
}

export interface MaterializedVariantSelectionHandle {
  readonly output: Ref<MaterializeVariantSelectionOutput["output"]>;
  readonly receipt: Ref<MaterializeVariantSelectionOutput["receipt"]>;
  readonly result: Ref<MaterializeVariantSelectionOutput>;
}

export interface PreparedOverlayHandle {
  readonly artifact: Ref<MediaOverlayOutput["artifact"]>;
  readonly operation: Ref<MediaOverlayOutput["operation"]>;
  readonly output: Ref<MediaOverlayOutput>;
  readonly receipt: Ref<MediaOverlayOutput["receipt"]>;
}

export interface FaceFollowRevisionDraftVariants {
  readonly landscape: Ref<FaceFollowRevisionDraft>;
  readonly portrait: Ref<FaceFollowRevisionDraft>;
  readonly square: Ref<FaceFollowRevisionDraft>;
}

export interface ProjectEditRevisionVariants {
  readonly landscape: ProjectEditRevisionHandle;
  readonly portrait: ProjectEditRevisionHandle;
  readonly square: ProjectEditRevisionHandle;
}

export interface EditBatchOptions {
  readonly cutRanges?: Ref<readonly SourceInterval[]> | readonly SourceInterval[];
  readonly ordered?: readonly OperationInputValue<OrderedProjectEdit>[];
}

export interface CompleteEditBatchOptions {
  readonly cutRanges?: Ref<readonly SourceInterval[]> | readonly SourceInterval[];
  readonly ordered?: readonly OperationInputValue<OrderedProjectEditV3>[];
}

interface CompleteEditBatchV2Options {
  readonly cutRanges?: Ref<readonly SourceInterval[]> | readonly SourceInterval[];
  readonly ordered?: readonly OperationInputValue<OrderedProjectEditV2>[];
}

type OverlayId = OverlayOperation["overlayId"];

type DistributedOperationInputValue<Value> =
  Value extends unknown ? OperationInputValue<Value> : never;

type RefFriendlyFields<Value extends object> = {
  readonly [Key in keyof Value]: DistributedOperationInputValue<Value[Key]>;
};

type RefFriendlyObjectUnion<Value> =
  Value extends object
    ? Value | Ref<Value> | RefFriendlyFields<Value>
    : never;

export type MediaIngestOptions =
  & Omit<RefFriendlyFields<MediaIngestInput>, "project">
  & {
    readonly project:
      | OperationInputValue<MediaIngestInput["project"]>
      | ProjectHandle;
  };

export type MediaHtmlOverlayOptions =
  & Omit<RefFriendlyFields<HtmlOverlayInputRequest>, "project">
  & {
    readonly project:
      | OperationInputValue<HtmlOverlayInputRequest["project"]>
      | ProjectHandle;
  };

export type MediaOverlayOptions =
  & Omit<RefFriendlyFields<MediaOverlayInputRequest>, "project" | "source">
  & {
    readonly project:
      | OperationInputValue<MediaOverlayInputRequest["project"]>
      | ProjectHandle;
    readonly source: RefFriendlyObjectUnion<
      MediaOverlayInputRequest["source"]
    >;
  };

export type GatewayImageOptions =
  OperationInputValue<GatewayImageOperationInput>;
export type GatewaySpeechOptions =
  OperationInputValue<GatewaySpeechOperationInput>;
export type GatewayTranscriptionOptions =
  OperationInputValue<GatewayTranscriptionOperationInput>;
export type GatewayVideoOptions =
  OperationInputValue<GatewayVideoOperationInput>;
export type MediaAudioEffectsOptions =
  OperationInputValue<MediaAudioEffectsInput>;
export type MediaColorGradeOptions =
  OperationInputValue<MediaColorGradeInput>;
export type RecordingStartOptions =
  OperationInputValue<RecordingStartInput>;

export type FaceFollowOptions = {
  readonly [Key in keyof Omit<FollowFacesInput, "project">]:
    OperationInputValue<Omit<FollowFacesInput, "project">[Key]>;
};

export type FaceFollowVariantOptions = {
  readonly [Key in keyof Omit<FollowFacesInput, "aspect" | "project">]:
    OperationInputValue<Omit<FollowFacesInput, "aspect" | "project">[Key]>;
};

export interface CreateCreativeCandidateRevisionOptions {
  readonly batch: CreativeCandidateBatch;
  readonly project: ProjectSnapshotHandle;
  readonly variantKey: string;
}

export interface BindCreativeCandidateRevisionOptions {
  readonly pixelHeight: number;
  readonly pixelWidth: number;
  readonly revision: CreativeCandidateRevisionHandle;
}

export interface BindCreativeCandidateRenderOptions {
  readonly maximumBytes: number;
  readonly plan: Ref<ProjectRenderPlanOutput>;
  readonly revision: BoundCreativeCandidateRevisionHandle;
  readonly syncPolicy: ProjectRenderSyncPolicy;
  readonly target: ProjectRenderTarget;
}

export interface CreativeCandidateRenderHandle {
  readonly name: string;
  readonly render: Ref<ProjectRenderOutput>;
}

export interface CreateCreativeCandidateOptions {
  readonly renders?: readonly CreativeCandidateRenderHandle[];
  readonly revision: CreativeCandidateRevisionHandle;
}

export interface SelectCreativeVariantOptions {
  readonly evidence?: NonNullable<SelectVariantInput["evidence"]>;
  readonly matrix: VariantMatrixHandle;
  readonly variantKey: string;
}

export interface MaterializeCreativeSelectionOptions {
  readonly deliveryKey?: string;
  readonly destinationPath?: string;
  readonly renderName: string;
  readonly selection: VariantSelectionHandle;
}

function snapshotHandle(
  snapshot: Ref<ProjectSnapshotOutput>,
): ProducedProjectSnapshotHandle {
  return Object.freeze({
    editBasis: snapshot.select("editBasis"),
    generationSha256: snapshot.select("generation").select("generationSha256"),
    projectId: snapshot.select("project").select("projectId"),
    snapshot,
  });
}

/**
 * Workflow inputs are parsed before their build callback runs. Persisted
 * handle adapters therefore remain typed projections instead of importing
 * host-owned operation schemas into the portable graph-authoring runtime.
 */
function persistedSnapshotHandle(
  snapshot: ProjectSnapshotOutput,
): ProjectSnapshotHandle {
  return Object.freeze({
    editBasis: snapshot.editBasis,
    generationSha256: snapshot.generation.generationSha256,
    projectId: snapshot.project.projectId,
    snapshot,
  });
}

function committedHandle(receipt: Ref<CommitProjectEditsOutput>): CommittedProjectHandle {
  return Object.freeze({
    editBasis: receipt.select("editBasis"),
    generationSha256: receipt.select("generation").select("generationSha256"),
    projectId: receipt.select("projectId"),
    receipt,
  });
}

function preparedOverlayHandle(
  output: Ref<MediaOverlayOutput>,
): PreparedOverlayHandle {
  return Object.freeze({
    artifact: output.select("artifact"),
    operation: output.select("operation"),
    output,
    receipt: output.select("receipt"),
  });
}

function revisionHandle(
  revision: Ref<
    CreateProjectEditRevisionOutput | FreezeProjectEditRevisionOutput
  >,
): ProjectEditRevisionHandle {
  return Object.freeze({
    projectId: revision.select("projectId"),
    revision,
  });
}

function creativeCandidateRevisionHandle(
  reference: Ref<CreateCandidateRevisionOutput>,
  input: {
    readonly batch: CreativeCandidateBatch;
    readonly project: ProjectSnapshotHandle;
    readonly variantKey: string;
  },
): CreativeCandidateRevisionHandle {
  return Object.freeze({
    batch: input.batch,
    project: input.project,
    projectId: reference.select("projectId"),
    reference,
    variantKey: input.variantKey,
  });
}

function boundCreativeCandidateRevisionHandle(
  output: Ref<BindCandidateRevisionOutput>,
  candidateRevision: CreativeCandidateRevisionHandle,
): BoundCreativeCandidateRevisionHandle {
  return Object.freeze({
    candidateRevision,
    projectId: output.select("revision").select("projectId"),
    revision: output.select("revision"),
  });
}

function candidateRenderBindingHandle(
  input: Ref<CandidateProjectRenderInput>,
): CandidateRenderBindingHandle {
  return Object.freeze({ input });
}

function creativeCandidateHandle(
  reference: Ref<CreateCreativeCandidateOutput>,
): ProducedCreativeCandidateHandle {
  return Object.freeze({
    projectId: reference.select("base").select("projectId"),
    reference,
  });
}

function persistedCreativeCandidateHandle(
  reference: CreateCreativeCandidateOutput,
): CreativeCandidateHandle {
  return Object.freeze({
    projectId: reference.base.projectId,
    reference,
  });
}

function variantMatrixHandle(
  reference: Ref<CreateVariantMatrixOutput>,
): ProducedVariantMatrixHandle {
  return Object.freeze({
    projectId: reference.select("base").select("projectId"),
    reference,
  });
}

function persistedVariantMatrixHandle(
  reference: CreateVariantMatrixOutput,
): VariantMatrixHandle {
  return Object.freeze({
    projectId: reference.base.projectId,
    reference,
  });
}

function variantSelectionHandle(
  reference: Ref<SelectVariantOutput>,
): ProducedVariantSelectionHandle {
  return Object.freeze({
    projectId: reference.select("base").select("projectId"),
    reference,
  });
}

function persistedVariantSelectionHandle(
  reference: SelectVariantOutput,
): VariantSelectionHandle {
  return Object.freeze({
    projectId: reference.base.projectId,
    reference,
  });
}

function materializedVariantSelectionHandle(
  result: Ref<MaterializeVariantSelectionOutput>,
): MaterializedVariantSelectionHandle {
  return Object.freeze({
    output: result.select("output"),
    receipt: result.select("receipt"),
    result,
  });
}

function mediaIngestProject(
  project: MediaIngestOptions["project"],
): OperationInputValue<MediaIngestInput["project"]> {
  if (
    typeof project === "object"
    && project !== null
    && "projectId" in project
  ) {
    return project.projectId;
  }
  return project;
}

function mediaOverlayProject(
  project: MediaOverlayOptions["project"],
): OperationInputValue<MediaOverlayInputRequest["project"]> {
  if (
    typeof project === "object"
    && project !== null
    && "projectId" in project
  ) {
    return project.projectId;
  }
  return project;
}

function mediaHtmlOverlayProject(
  project: MediaHtmlOverlayOptions["project"],
): OperationInputValue<HtmlOverlayInputRequest["project"]> {
  if (
    typeof project === "object"
    && project !== null
    && "projectId" in project
  ) {
    return project.projectId;
  }
  return project;
}

function overlayOperationInput(
  overlay: OperationInputValue<OverlayOperation> | PreparedOverlayHandle,
): OperationInputValue<OverlayOperation> {
  return (
    typeof overlay === "object"
    && overlay !== null
    && "operation" in overlay
    && "output" in overlay
  )
    ? overlay.operation
    : overlay;
}

export class WorkflowBuilder {
  readonly #graph: WorkflowGraphBuilder;

  /**
   * Exact historical authoring contracts for immutable built-ins and graph
   * migrations. Ordinary workflow code should use the stable semantic
   * namespaces below, which advance to the newest resource-bounded vocabulary.
   */
  readonly advanced = Object.freeze({
    edits: Object.freeze({
      completeBatchV2: (
        key: string,
        input: CompleteEditBatchV2Options,
        options?: OperationNodeOptions,
      ): Ref<ProjectEditBatchV2> => this.#graph.operationByKind(key, {
        input,
        kind: "derive.edit-batch",
        version: 2,
      }, options),
    }),
    project: Object.freeze({
      commitCompleteEditsV2: (
        key: string,
        input: {
          readonly batch: Ref<ProjectEditBatchV2>;
          readonly project: ProjectHandle;
        },
        options?: OperationNodeOptions,
      ): CommittedProjectHandle => committedHandle(
        this.#graph.operationByKind(key, {
          input: {
            batch: input.batch,
            basis: input.project.editBasis,
            project: input.project.projectId,
          },
          kind: "project.commit-edits",
          version: 2,
        }, options),
      ),
    }),
  });

  readonly analysis = Object.freeze({
    projectAutoZooms: (
      key: string,
      input: Omit<ProjectAutoZoomInput, "binding" | "project"> & {
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): Ref<ProjectAutoZoomOutput> => this.#graph.operationByKind(key, {
      input: { ...input, project: input.project.projectId },
      kind: "analysis.project-auto-zooms",
      version: 1,
    }, options),
    faces: (
      key: string,
      input: Omit<FacesOperationInput, "project"> & { readonly project: ProjectHandle },
      options?: OperationNodeOptions,
    ): Ref<FacesOperationOutput> => this.#graph.operationByKind(key, {
      input: { ...input, project: input.project.projectId },
      kind: "analysis.faces",
      version: 1,
    }, options),
    inactivity: (
      key: string,
      input: Omit<ProjectInactivityOperationInput, "project"> & {
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): Ref<ProjectInactivityOperationOutput> => this.#graph.operationByKind(key, {
      input: { ...input, project: input.project.projectId },
      kind: "analysis.project-inactivity",
      version: 1,
    }, options),
    music: (
      key: string,
      input: Omit<MusicOperationInput, "project"> & { readonly project: ProjectHandle },
      options?: OperationNodeOptions,
    ): Ref<MusicOperationOutput> => this.#graph.operationByKind(key, {
      input: { ...input, project: input.project.projectId },
      kind: "analysis.music",
      version: 1,
    }, options),
    scenes: (
      key: string,
      input: Omit<SceneAnalysisOperationInput, "project"> & {
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): Ref<SceneAnalysisOperationOutput> => this.#graph.operationByKind(key, {
      input: { ...input, project: input.project.projectId },
      kind: "analysis.scenes",
      version: 1,
    }, options),
  });

  readonly edits = Object.freeze({
    /**
     * Join independently prepared overlays into one immutable batch. Overlay
     * preparation nodes stay parallel; this node is their explicit join.
     */
    addOverlays: (
      key: string,
      overlays: readonly (
        | OperationInputValue<OverlayOperation>
        | PreparedOverlayHandle
      )[],
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatch> => this.#graph.operationByKind(key, {
      input: {
        ordered: [{
          kind: "add-overlays",
          overlays: overlays.map(overlayOperationInput),
        }],
      },
      kind: "derive.edit-batch",
      version: 1,
    }, options),
    batch: (
      key: string,
      input: EditBatchOptions,
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatch> => this.#graph.operationByKind(key, {
      input,
      kind: "derive.edit-batch",
      version: 1,
    }, options),
    /**
     * Join the complete edit vocabulary into one checked transaction input.
     * Select this explicitly when metadata effects or manual camera moves are
     * needed; ordinary cuts and overlays stay on the narrower v1 path.
     */
    completeBatch: (
      key: string,
      input: CompleteEditBatchOptions,
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatchV3> => this.#graph.operationByKind(key, {
      input,
      kind: "derive.edit-batch",
      version: 3,
    }, options),
    followFaces: (
      key: string,
      input: FaceFollowOptions & {
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): Ref<FaceFollowRevisionDraft> => this.#graph.operationByKind(key, {
      input: { ...input, project: input.project.projectId },
      kind: "derive.follow-faces",
      version: 1,
    }, options),
    /**
     * Expand one reviewed face-follow request into three independent,
     * aspect-bound derivations that the scheduler may execute in parallel.
     */
    followFacesVariants: (
      key: string,
      input: FaceFollowVariantOptions & {
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): FaceFollowRevisionDraftVariants => {
      const variants = this.namespace(key);
      return Object.freeze({
        landscape: variants.edits.followFaces(
          "landscape",
          { ...input, aspect: "16:9" },
          options,
        ),
        portrait: variants.edits.followFaces(
          "portrait",
          { ...input, aspect: "9:16" },
          options,
        ),
        square: variants.edits.followFaces(
          "square",
          { ...input, aspect: "1:1" },
          options,
        ),
      });
    },
    removeOverlays: (
      key: string,
      overlayIds: readonly OperationInputValue<OverlayId>[],
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatch> => this.#graph.operationByKind(key, {
      input: {
        ordered: [{ kind: "remove-overlays", overlayIds }],
      },
      kind: "derive.edit-batch",
      version: 1,
    }, options),
    setMetadataEffects: (
      key: string,
      input: MetadataEffectsOptions,
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatchV3> => this.#graph.operationByKind(key, {
      input: {
        ordered: [setMetadataEffectsEdit(input)],
      },
      kind: "derive.edit-batch",
      version: 3,
    }, options),
    addManualCameraMoves: (
      key: string,
      cameraMoves: readonly OperationInputValue<
        ManualProjectCameraMoveInputV2
      >[],
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatchV3> => this.#graph.operationByKind(key, {
      input: {
        ordered: [addManualCameraMovesEdit(cameraMoves)],
      },
      kind: "derive.edit-batch",
      version: 3,
    }, options),
    addManualZooms: (
      key: string,
      zooms: readonly (
        | ManualZoomInput
        | OperationInputValue<ManualProjectZoomInputV3>
      )[],
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatchV3> => this.#graph.operationByKind(key, {
      input: {
        ordered: [addManualZoomsEdit(zooms)],
      },
      kind: "derive.edit-batch",
      version: 3,
    }, options),
    removeCameraMoves: (
      key: string,
      cameraMoveIds: readonly OperationInputValue<
        ManualProjectCameraMoveInputV2["cameraMoveId"]
      >[],
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatchV3> => this.#graph.operationByKind(key, {
      input: {
        ordered: [removeCameraMovesEdit(cameraMoveIds)],
      },
      kind: "derive.edit-batch",
      version: 3,
    }, options),
    removeZooms: (
      key: string,
      zoomIds: readonly OperationInputValue<
        ProjectZoomOperation["operation"]["zoomId"]
      >[],
      options?: OperationNodeOptions,
    ): Ref<ProjectEditBatchV3> => this.#graph.operationByKind(key, {
      input: {
        ordered: [removeZoomsEdit(zoomIds)],
      },
      kind: "derive.edit-batch",
      version: 3,
    }, options),
  });

  readonly gateway = Object.freeze({
    image: (
      key: string,
      input: GatewayImageOptions,
      options?: OperationNodeOptions,
    ): Ref<GatewayImageOperationResult> => this.#graph.operationByKind(key, {
      input,
      kind: "gateway.image",
      version: 1,
    }, options),
    speech: (
      key: string,
      input: GatewaySpeechOptions,
      options?: OperationNodeOptions,
    ): Ref<GatewaySpeechOperationResult> => this.#graph.operationByKind(key, {
      input,
      kind: "gateway.speech",
      version: 1,
    }, options),
    transcription: (
      key: string,
      input: GatewayTranscriptionOptions,
      options?: OperationNodeOptions,
    ): Ref<GatewayTranscriptionOperationResult> =>
      this.#graph.operationByKind(key, {
        input,
        kind: "gateway.transcription",
        version: 1,
      }, options),
    video: (
      key: string,
      input: GatewayVideoOptions,
      options?: OperationNodeOptions,
    ): Ref<GatewayVideoOperationResult> => this.#graph.operationByKind(key, {
      input,
      kind: "gateway.video",
      version: 1,
    }, options),
  });

  /**
   * Build immutable creative candidates from one frozen project state, close
   * them into a matrix, and keep selection, editorial promotion, and delivery
   * materialization as explicit effects.
   */
  readonly iteration = Object.freeze({
    base: (
      key: string,
      project: string,
      options?: OperationNodeOptions,
    ): ProducedProjectSnapshotHandle => snapshotHandle(this.#graph.operationByKind(key, {
      input: { project },
      kind: "project.snapshot",
      version: 1,
    }, options)),
    baseFromSnapshot: (
      snapshot: ProjectSnapshotOutput,
    ): ProjectSnapshotHandle => persistedSnapshotHandle(snapshot),
    baseline: (): CandidateProjectEditBatchV3 => {
      const body = {
        kind: "atet.project-edit-batch" as const,
        ordered: [],
        schemaVersion: 3 as const,
      };
      return {
        ...body,
        sha256: canonicalJsonSha256(body),
      };
    },
    candidateFromReference: (
      reference: CreateCreativeCandidateOutput,
    ): CreativeCandidateHandle => persistedCreativeCandidateHandle(reference),
    createRevision: (
      key: string,
      input: CreateCreativeCandidateRevisionOptions,
      options?: OperationNodeOptions,
    ): CreativeCandidateRevisionHandle => creativeCandidateRevisionHandle(
      this.#graph.operationByKind<CreateCandidateRevisionOutput>(key, {
        input: {
          batch: input.batch,
          project: input.project.projectId,
          snapshot: input.project.snapshot,
          variantKey: input.variantKey,
        },
        kind: "edit.create-candidate-revision",
        version: 1,
      }, options),
      input,
    ),
    bindRevision: (
      key: string,
      input: BindCreativeCandidateRevisionOptions,
      options?: OperationNodeOptions,
    ): BoundCreativeCandidateRevisionHandle => (
      boundCreativeCandidateRevisionHandle(
        this.#graph.operationByKind<BindCandidateRevisionOutput>(key, {
          input: {
            pixelHeight: input.pixelHeight,
            pixelWidth: input.pixelWidth,
            revision: input.revision.reference,
          },
          kind: "edit.bind-candidate-revision",
          version: 1,
        }, options),
        input.revision,
      )
    ),
    candidate: (
      key: string,
      input: CreateCreativeCandidateOptions,
      options?: OperationNodeOptions,
    ): ProducedCreativeCandidateHandle => creativeCandidateHandle(
      this.#graph.operationByKind<CreateCreativeCandidateOutput>(key, {
        input: {
          batch: input.revision.batch,
          project: input.revision.projectId,
          renders: (input.renders ?? []).map(render => ({
            name: render.name,
            output: render.render.select("output"),
            receipt: render.render.select("receipt"),
          })),
          revision: input.revision.reference,
          snapshot: input.revision.project.snapshot,
          variantKey: input.revision.variantKey,
        },
        kind: "iteration.create-candidate",
        version: 1,
      }, options),
    ),
    matrix: (
      key: string,
      input: {
        readonly candidates: readonly CreativeCandidateHandle[];
        readonly project: ProjectSnapshotHandle | string;
      },
      options?: OperationNodeOptions,
    ): ProducedVariantMatrixHandle => variantMatrixHandle(
      this.#graph.operationByKind<CreateVariantMatrixOutput>(key, {
        input: {
          candidates: input.candidates.map(candidate => candidate.reference),
          project: typeof input.project === "string"
            ? input.project
            : input.project.projectId,
        },
        kind: "iteration.create-matrix",
        version: 1,
      }, options),
    ),
    matrixFromReference: (
      reference: CreateVariantMatrixOutput,
    ): VariantMatrixHandle => persistedVariantMatrixHandle(reference),
    select: (
      key: string,
      input: SelectCreativeVariantOptions,
      options?: OperationNodeOptions,
    ): ProducedVariantSelectionHandle => variantSelectionHandle(
      this.#graph.operationByKind<SelectVariantOutput>(key, {
        input: {
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
          matrix: input.matrix.reference,
          project: input.matrix.projectId,
          variantKey: input.variantKey,
        },
        kind: "iteration.select",
        version: 1,
      }, options),
    ),
    selectionFromReference: (
      reference: SelectVariantOutput,
    ): VariantSelectionHandle => persistedVariantSelectionHandle(reference),
    promote: (
      key: string,
      selection: VariantSelectionHandle,
      options?: OperationNodeOptions,
    ): Ref<PromoteVariantSelectionOutput> => this.#graph.operationByKind(key, {
      input: {
        project: selection.projectId,
        selection: selection.reference,
      },
      kind: "project.promote-selection",
      version: 1,
    }, options),
    materialize: (
      key: string,
      input: MaterializeCreativeSelectionOptions,
      options?: OperationNodeOptions,
    ): MaterializedVariantSelectionHandle => materializedVariantSelectionHandle(
      this.#graph.operationByKind<MaterializeVariantSelectionOutput>(key, {
        input: {
          ...(input.deliveryKey === undefined
            ? {}
            : { deliveryKey: input.deliveryKey }),
          ...(input.destinationPath === undefined
            ? {}
            : { destinationPath: input.destinationPath }),
          project: input.selection.projectId,
          renderName: input.renderName,
          selection: input.selection.reference,
        },
        kind: "render.materialize-selection",
        version: 1,
      }, options),
    ),
  });

  readonly media = Object.freeze({
    audioEffects: (
      key: string,
      input: MediaAudioEffectsOptions,
      options?: OperationNodeOptions,
    ): Ref<MediaAudioEffectsOutput> => this.#graph.operationByKind(key, {
      input,
      kind: "media.audio-effects",
      version: 1,
    }, options),
    colorGrade: (
      key: string,
      input: MediaColorGradeOptions,
      options?: OperationNodeOptions,
    ): Ref<MediaColorGradeOutput> => this.#graph.operationByKind(key, {
      input,
      kind: "media.color-grade",
      version: 1,
    }, options),
    ingest: (
      key: string,
      input: MediaIngestOptions,
      options?: OperationNodeOptions,
    ): Ref<MediaIngestOutput> => this.#graph.operationByKind(key, {
      input: {
        ...input,
        project: mediaIngestProject(input.project),
      },
      kind: "media.ingest",
      version: 1,
    }, options),
    htmlOverlay: (
      key: string,
      input: MediaHtmlOverlayOptions,
      options?: OperationNodeOptions,
    ): PreparedOverlayHandle => preparedOverlayHandle(
      this.#graph.operationByKind<HtmlOverlayOutput>(key, {
        input: {
          ...input,
          project: mediaHtmlOverlayProject(input.project),
        },
        kind: "media.html-overlay",
        version: 1,
      }, options),
    ),
    overlay: (
      key: string,
      input: MediaOverlayOptions,
      options?: OperationNodeOptions,
    ): PreparedOverlayHandle => preparedOverlayHandle(
      this.#graph.operationByKind(key, {
        input: {
          ...input,
          project: mediaOverlayProject(input.project),
        },
        kind: "media.overlay",
        version: 1,
      }, options),
    ),
  });

  readonly project = Object.freeze({
    commitCompleteEdits: (
      key: string,
      input: {
        readonly batch: Ref<ProjectEditBatchV3>;
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): CommittedProjectHandle => committedHandle(this.#graph.operationByKind(key, {
      input: {
        batch: input.batch,
        basis: input.project.editBasis,
        project: input.project.projectId,
      },
      kind: "project.commit-edits",
      version: 3,
    }, options)),
    commitEdits: (
      key: string,
      input: {
        readonly batch: Ref<ProjectEditBatch>;
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): CommittedProjectHandle => committedHandle(this.#graph.operationByKind(key, {
      input: {
        batch: input.batch,
        basis: input.project.editBasis,
        project: input.project.projectId,
      },
      kind: "project.commit-edits",
      version: 1,
    }, options)),
    createRevision: (
      key: string,
      input: {
        readonly draft: Ref<FaceFollowRevisionDraft>;
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): ProjectEditRevisionHandle => revisionHandle(
      this.#graph.operationByKind(key, {
        input: {
          draft: input.draft,
          project: input.project.projectId,
        },
        kind: "edit.create-revision",
        version: 1,
      }, options),
    ),
    /**
     * Publish common aspect drafts as separate immutable references. This does
     * not advance the project's mutable current-plan pointer.
     */
    createRevisionVariants: (
      key: string,
      input: {
        readonly drafts: FaceFollowRevisionDraftVariants;
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): ProjectEditRevisionVariants => {
      const variants = this.namespace(key);
      return Object.freeze({
        landscape: variants.project.createRevision("landscape", {
          draft: input.drafts.landscape,
          project: input.project,
        }, options),
        portrait: variants.project.createRevision("portrait", {
          draft: input.drafts.portrait,
          project: input.project,
        }, options),
        square: variants.project.createRevision("square", {
          draft: input.drafts.square,
          project: input.project,
        }, options),
      });
    },
    /**
     * Freeze the current complete project/edit documents into an immutable,
     * geometry-bound revision without moving the mutable current pointer.
     */
    freezeRevision: (
      key: string,
      input: {
        readonly pixelHeight: number;
        readonly pixelWidth: number;
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): ProjectEditRevisionHandle => revisionHandle(
      this.#graph.operationByKind(key, {
        input: {
          basis: input.project.editBasis,
          pixelHeight: input.pixelHeight,
          pixelWidth: input.pixelWidth,
          project: input.project.projectId,
        },
        kind: "edit.freeze-revision",
        version: 1,
      }, options),
    ),
    /**
     * Create common landscape, square, and portrait geometry bindings as
     * independent nodes so their downstream plans/renders may overlap.
     */
    freezeRevisionVariants: (
      key: string,
      input: {
        readonly project: ProjectHandle;
      },
      options?: OperationNodeOptions,
    ): ProjectEditRevisionVariants => {
      const variants = this.namespace(key);
      return Object.freeze({
        landscape: variants.project.freezeRevision("landscape", {
          pixelHeight: 1_080,
          pixelWidth: 1_920,
          project: input.project,
        }, options),
        portrait: variants.project.freezeRevision("portrait", {
          pixelHeight: 1_920,
          pixelWidth: 1_080,
          project: input.project,
        }, options),
        square: variants.project.freezeRevision("square", {
          pixelHeight: 1_080,
          pixelWidth: 1_080,
          project: input.project,
        }, options),
      });
    },
    snapshot: (
      key: string,
      project: string,
      options?: OperationNodeOptions,
    ): ProducedProjectSnapshotHandle => snapshotHandle(this.#graph.operationByKind(key, {
      input: { project },
      kind: "project.snapshot",
      version: 1,
    }, options)),
  });

  readonly render = Object.freeze({
    bindCandidateOutput: (
      key: string,
      input: BindCreativeCandidateRenderOptions,
      options?: OperationNodeOptions,
    ): CandidateRenderBindingHandle => candidateRenderBindingHandle(
      this.#graph.operationByKind<CandidateProjectRenderInput>(key, {
        input: {
          candidateRevision: input.revision.candidateRevision.reference,
          maximumBytes: input.maximumBytes,
          plan: input.plan,
          revision: input.revision.revision,
          syncPolicy: input.syncPolicy,
          target: input.target,
        },
        kind: "render.bind-candidate-output",
        version: 1,
      }, options),
    ),
    plan: (
      key: string,
      input: Omit<ProjectRenderPlanInput, "revision"> & {
        readonly revision: ProjectEditRevisionHandle;
      },
      options?: OperationNodeOptions,
    ): Ref<ProjectRenderPlanOutput> => this.#graph.operationByKind(key, {
      input: { ...input, revision: input.revision.revision },
      kind: "render.project-plan",
      version: 1,
    }, options),
    captionedPlan: (
      key: string,
      input: Omit<
        ProjectRenderPlanInputV2,
        "captionBinding" | "metadataBindings" | "revision"
      > & {
        readonly revision: ProjectEditRevisionHandle;
      },
      options?: OperationNodeOptions,
    ): Ref<ProjectRenderPlanOutput> => this.#graph.operationByKind(key, {
      input: { ...input, revision: input.revision.revision },
      kind: "render.project-plan",
      version: 2,
    }, options),
    project: (
      key: string,
      input: (
        | Omit<RefFriendlyFields<ProjectRenderInput>, "binding" | "plan">
        | Omit<RefFriendlyFields<ProjectRenderInputV2>, "binding" | "plan">
      ) & { readonly plan: Ref<ProjectRenderPlanOutput> },
      options?: OperationNodeOptions,
    ): Ref<ProjectRenderOutput> => this.#graph.operationByKind(key, {
      input,
      kind: "render.project",
      version: "target" in input ? 2 : 1,
    }, options),
    candidateProject: (
      key: string,
      binding: CandidateRenderBindingHandle,
      options?: OperationNodeOptions,
    ): Ref<ProjectRenderOutput> => this.#graph.operationByKind(key, {
      input: {
        binding: binding.input.select("binding"),
        derivation: binding.input.select("derivation"),
        output: binding.input.select("output"),
        plan: binding.input.select("plan"),
        syncPolicy: binding.input.select("syncPolicy"),
        target: binding.input.select("target"),
      },
      kind: "render.project",
      version: 3,
    }, options),
  });

  readonly recording = Object.freeze({
    pause: (
      key: string,
      options?: OperationNodeOptions,
    ): Ref<RecordingPauseOutput> => this.#graph.operationByKind(key, {
      input: {},
      kind: "recording.pause",
      version: 1,
    }, options),
    resume: (
      key: string,
      options?: OperationNodeOptions,
    ): Ref<RecordingResumeOutput> => this.#graph.operationByKind(key, {
      input: {},
      kind: "recording.resume",
      version: 1,
    }, options),
    start: (
      key: string,
      input: RecordingStartOptions,
      options?: OperationNodeOptions,
    ): Ref<RecordingStartOutput> => this.#graph.operationByKind(key, {
      input,
      kind: "recording.start",
      version: 2,
    }, options),
    stop: (
      key: string,
      options?: OperationNodeOptions,
    ): Ref<RecordingStopOutput> => this.#graph.operationByKind(key, {
      input: {},
      kind: "recording.stop",
      version: 1,
    }, options),
  });

  private constructor(graph: WorkflowGraphBuilder) {
    this.#graph = graph;
  }

  static create(registry: OperationDiscoverySource): WorkflowBuilder {
    return new WorkflowBuilder(WorkflowGraphBuilder.create(registry));
  }

  namespace(segment: string): WorkflowBuilder {
    return new WorkflowBuilder(this.#graph.namespace(segment));
  }

  fragment<Input, Output>(
    namespace: string,
    fragment: WorkflowFragment<Input, Output>,
    input: Input,
  ): Output {
    return fragment.build(this.namespace(namespace), input);
  }

  operation<Input, Output>(
    key: string,
    contract: OperationContract<Input, Output>,
    input: OperationInputValue<Input>,
    options?: OperationNodeOptions,
  ): Ref<Output> {
    return this.#graph.operation(key, contract, input, options);
  }

  operationByKind(
    key: string,
    request: UntypedOperationRequest,
    options?: OperationNodeOptions,
  ): Ref<unknown> {
    return this.#graph.operationByKind<unknown>(key, request, options);
  }

  compute<Input, Output>(
    key: string,
    definition: TrustedComputeDefinition<Input, Output>,
    input: OperationInputValue<Input>,
    options?: OperationNodeOptions,
  ): Ref<Output> {
    return this.#graph.compute(key, definition, input, options);
  }

  computeDefinitions(): readonly AnyTrustedComputeDefinition[] {
    return this.#graph.computeDefinitions();
  }

  build(identity: WorkflowIdentity, outputs: WorkflowOutputValue) {
    return this.#graph.build(identity, outputs);
  }
}
