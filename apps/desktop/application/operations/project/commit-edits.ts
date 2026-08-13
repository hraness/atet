import { z } from "zod";

import {
  IsoTimestampSchema,
  ProjectCameraMoveSchema,
  ProjectPlacementIdSchema,
  ProjectZoomOperationSchema,
  RecordingIdSchema,
  Sha256Schema,
  ZoomIdSchema,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../../../contracts";
import {
  assertProjectCameraMoveBindings,
  assertStaticProjectZoomTargetVisible,
  canonicalJsonSha256,
  cutProjectPlan,
  hashProjectCameraGeometry,
  hashProjectCameraSync,
  hashProjectEditPlan,
  hashPlacementSync,
  hashProjectStructure,
  intersectIntervals,
  normalizeProjectEditPlan,
  projectIntervalHasCompleteSyncCoverage,
  resolveProjectMetadataSourceLayer,
  setProjectSpeed,
  subtractIntervals,
  trimProjectPlan,
  type ResolvedProjectMetadataSourceLayer,
} from "../../../core";
import { openRecording } from "../../../cli/bundle-service";
import { CliError } from "../../../cli/errors";
import {
  commitProjectStateTransaction,
} from "../../../cli/project-state-transaction";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type {
  OperationDefinition,
  OperationExecutionContext,
} from "../../operation";
import {
  assertProjectEditBasis,
  hashProjectGeneration,
  openProjectSnapshot,
  projectEditBasis,
  ProjectEditBasisSchema,
  type OpenProjectSnapshot,
  type ProjectEditBasis,
} from "../../project-store";
import { ProjectEditCommitReceiptSchema } from "../../receipts";
import {
  ProjectEditBatchV2Schema,
  ProjectEditBatchV3Schema,
  ProjectEditBatchSchema,
  projectEditNormalizationPhaseV3,
  type ManualProjectZoomInputV3,
  type OrderedProjectEditV2,
  type OrderedProjectEditV3,
  type OrderedProjectEdit,
  type ProjectEditNormalizationPhaseV3,
} from "../derive/edit-batch";
import {
  ProjectReferenceSchema,
  throwIfAborted,
} from "../shared";

export const CommitProjectEditsInputSchema = z.strictObject({
  batch: ProjectEditBatchSchema,
  basis: ProjectEditBasisSchema,
  project: ProjectReferenceSchema,
  updatedAt: IsoTimestampSchema.optional(),
});

export type CommitProjectEditsInput = z.infer<typeof CommitProjectEditsInputSchema>;
export type CommitProjectEditsOutput = z.infer<typeof ProjectEditCommitReceiptSchema>;

export const ProjectCommitMetadataBindingV2Schema = z.strictObject({
  manifestSha256: Sha256Schema,
  placementId: ProjectPlacementIdSchema,
  recordingId: RecordingIdSchema,
});

export const CommitProjectEditsInputV2Schema = z.strictObject({
  batch: ProjectEditBatchV2Schema,
  basis: ProjectEditBasisSchema,
  metadataBinding: ProjectCommitMetadataBindingV2Schema.optional(),
  project: ProjectReferenceSchema,
  updatedAt: IsoTimestampSchema.optional(),
}).superRefine((input, context) => {
  const requiresBinding = input.batch.ordered.some(edit => (
    edit.kind === "set-metadata-effects" && metadataEffectsAreEnabled(edit)
  ));
  if (!requiresBinding && input.metadataBinding !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Metadata binding is only valid when this batch enables metadata effects.",
      path: ["metadataBinding"],
    });
  }
});

export type ProjectCommitMetadataBindingV2 = z.infer<
  typeof ProjectCommitMetadataBindingV2Schema
>;
export type CommitProjectEditsInputV2 = z.infer<
  typeof CommitProjectEditsInputV2Schema
>;

export const ProjectCommitManualZoomBindingV3Schema = z.strictObject({
  displayId: z.string().min(1).max(256),
  manifestSha256: Sha256Schema,
  placementId: ProjectPlacementIdSchema,
  recordingId: RecordingIdSchema,
  syncSha256: Sha256Schema,
  zoomId: ZoomIdSchema,
});

export const CommitProjectEditsInputV3Schema = z.strictObject({
  batch: ProjectEditBatchV3Schema,
  basis: ProjectEditBasisSchema,
  manualZoomBindings: z.array(
    ProjectCommitManualZoomBindingV3Schema,
  ).max(10_000).optional(),
  metadataBinding: ProjectCommitMetadataBindingV2Schema.optional(),
  project: ProjectReferenceSchema,
  updatedAt: IsoTimestampSchema.optional(),
}).superRefine((input, context) => {
  const requiresMetadataBinding = input.batch.ordered.some(edit => (
    edit.kind === "set-metadata-effects" && metadataEffectsAreEnabled(edit)
  ));
  if (!requiresMetadataBinding && input.metadataBinding !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Metadata binding is only valid when this batch enables metadata effects.",
      path: ["metadataBinding"],
    });
  }
  const manualZoomIds = input.batch.ordered.flatMap(edit => (
    edit.kind === "add-manual-zooms"
      ? edit.zooms.map(zoom => zoom.zoomId)
      : []
  ));
  if (manualZoomIds.length === 0 && input.manualZoomBindings !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Manual zoom bindings are only valid for a batch that adds manual zooms.",
      path: ["manualZoomBindings"],
    });
  }
  if (
    input.manualZoomBindings !== undefined
    && new Set(input.manualZoomBindings.map(binding => binding.zoomId)).size
      !== input.manualZoomBindings.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Manual zoom bindings must have unique zoom IDs.",
      path: ["manualZoomBindings"],
    });
  }
});

export type ProjectCommitManualZoomBindingV3 = z.infer<
  typeof ProjectCommitManualZoomBindingV3Schema
>;
export type CommitProjectEditsInputV3 = z.infer<
  typeof CommitProjectEditsInputV3Schema
>;

export function applyOrderedProjectEdit(
  project: Awaited<ReturnType<typeof openProjectSnapshot>>["project"],
  plan: Awaited<ReturnType<typeof openProjectSnapshot>>["plan"],
  edit: OrderedProjectEdit,
  updatedAt: string,
  normalize = true,
) {
  switch (edit.kind) {
    case "cut":
      return normalize
        ? cutProjectPlan(project, plan, edit.range, updatedAt)
        : {
            ...plan,
            keep: subtractIntervals(plan.keep, [edit.range]),
            updatedAt,
          };
    case "trim":
      return normalize
        ? trimProjectPlan(project, plan, edit.range, updatedAt)
        : {
            ...plan,
            keep: intersectIntervals(plan.keep, [edit.range]),
            updatedAt,
          };
    case "speed":
      return normalize
        ? setProjectSpeed(project, plan, edit.range, edit.rate, updatedAt)
        : {
            ...plan,
            speed: [
              ...plan.speed,
              { range: edit.range, rate: edit.rate },
            ],
            updatedAt,
          };
    case "add-zooms":
      return finalizeProjectEditDraft({
        ...plan,
        updatedAt,
        zooms: [...plan.zooms, ...edit.zooms],
      }, normalize);
    case "add-overlays": {
      const existing = new Set(plan.overlays.map(overlay => overlay.overlayId));
      const conflicts = edit.overlays
        .map(overlay => overlay.overlayId)
        .filter(overlayId => existing.has(overlayId))
        .sort();
      if (conflicts.length > 0) {
        throw new ApplicationError(
          "conflict",
          `Overlay ID${conflicts.length === 1 ? "" : "s"} already exist${conflicts.length === 1 ? "s" : ""}: ${conflicts.join(", ")}`,
        );
      }
      return finalizeProjectEditDraft({
        ...plan,
        overlays: [...plan.overlays, ...edit.overlays],
        updatedAt,
      }, normalize);
    }
    case "remove-overlays": {
      const requested = new Set(edit.overlayIds);
      const overlays = plan.overlays.filter(
        overlay => !requested.has(overlay.overlayId),
      );
      if (overlays.length !== plan.overlays.length - requested.size) {
        const existing = new Set(plan.overlays.map(overlay => overlay.overlayId));
        const missing = [...requested].filter(id => !existing.has(id)).sort();
        throw new ApplicationError(
          "not-found",
          `Unknown overlay${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
        );
      }
      return finalizeProjectEditDraft({
        ...plan,
        overlays,
        updatedAt,
      }, normalize);
    }
  }
}

function finalizeProjectEditDraft(
  plan: ProjectEditPlanV1,
  normalize: boolean,
): ProjectEditPlanV1 {
  return normalize ? normalizeProjectEditPlan(plan) : plan;
}

export function projectEditCommitReceipt(
  input: {
    readonly batch: {
      readonly ordered: readonly { readonly kind: string }[];
    };
  },
  project: Awaited<ReturnType<typeof openProjectSnapshot>>["project"],
  plan: Awaited<ReturnType<typeof openProjectSnapshot>>["plan"],
): CommitProjectEditsOutput {
  const onlyEdit = input.batch.ordered.length === 1
    ? input.batch.ordered[0]
    : undefined;
  return ProjectEditCommitReceiptSchema.parse({
    editBasis: projectEditBasis(project, plan),
    generation: hashProjectGeneration(project, plan),
    operation:
      onlyEdit?.kind === "cut"
      || onlyEdit?.kind === "speed"
      || onlyEdit?.kind === "trim"
        ? onlyEdit.kind
        : "batch",
    planHash: hashProjectEditPlan(plan),
    planId: plan.planId,
    projectId: project.projectId,
  });
}

export function projectEditTransactionId(nodePlanSha256: string): string {
  return `transaction_${nodePlanSha256.slice(0, 32)}`;
}

function metadataEffectsAreEnabled(
  effects: Extract<
    OrderedProjectEditV2,
    { readonly kind: "set-metadata-effects" }
  >,
): boolean {
  return effects.clicks.enabled
    || effects.cursor.enabled
    || effects.keystrokes.enabled
    || effects.typedText.enabled;
}

function recordingMetadataLoadError(
  error: unknown,
  placementId: string,
): ApplicationError {
  const message = `Recording metadata for placement ${placementId} could not be loaded.`;
  if (!(error instanceof CliError)) {
    return new ApplicationError("invalid-data", message);
  }
  switch (error.code) {
    case "not-found":
      return new ApplicationError("not-found", message);
    case "unavailable":
      return new ApplicationError("unavailable", message);
    case "conflict":
    case "invalid-data":
    case "unsafe-path":
    case "usage":
      return new ApplicationError("invalid-data", message);
    case "ambiguous":
    case "authorization-required":
    case "cancelled":
    case "incompatible":
    case "internal":
    case "subprocess":
    case "unsupported-plan":
      return new ApplicationError("unavailable", message);
    default: {
      const exhaustive: never = error.code;
      return exhaustive;
    }
  }
}

async function assertMetadataEffectsAvailable(
  application: ApplicationContext,
  project: VideoProjectV1,
  edit: Extract<
    OrderedProjectEditV2,
    { readonly kind: "set-metadata-effects" }
  >,
  expectedBinding?: ProjectCommitMetadataBindingV2,
): Promise<ProjectCommitMetadataBindingV2 | undefined> {
  if (!metadataEffectsAreEnabled(edit)) return undefined;
  const placementId = edit.metadataPlacementId;
  if (placementId === null) {
    throw new ApplicationError(
      "invalid-data",
      "Enabled metadata effects require a non-null metadata placement.",
    );
  }
  const placement = project.placements.find(
    candidate => candidate.placementId === placementId,
  );
  if (placement === undefined) {
    throw new ApplicationError(
      "not-found",
      `Unknown project metadata placement: ${placementId}`,
    );
  }
  if (!placement.enabled) {
    throw new ApplicationError(
      "conflict",
      `Project metadata placement is disabled: ${placementId}`,
    );
  }
  if (placement.sync.provenance.kind === "unverified") {
    throw new ApplicationError(
      "conflict",
      `Project metadata placement has unverified synchronization: ${placementId}`,
    );
  }
  const asset = project.assets.find(
    candidate => candidate.assetId === placement.assetId,
  );
  if (asset?.source.kind !== "recording") {
    throw new ApplicationError(
      "conflict",
      `Metadata placement ${placementId} is not backed by a Transmute recording.`,
    );
  }
  let manifest: Awaited<ReturnType<typeof openRecording>>["manifest"];
  try {
    manifest = (
      await openRecording(
        application.paths.artifactRoot,
        asset.source.recordingId,
      )
    ).manifest;
  } catch (error) {
    throw recordingMetadataLoadError(error, placementId);
  }
  if (manifest.state !== "stopped") {
    throw new ApplicationError(
      "conflict",
      `Metadata effects require an immutable stopped recording for placement ${placementId}.`,
    );
  }
  if (manifest.capture.cursor !== "metadata") {
    throw new ApplicationError(
      "conflict",
      `Interaction metadata capture was disabled for placement ${placementId}.`,
    );
  }
  if (
    (edit.clicks.enabled || edit.keystrokes.enabled || edit.typedText.enabled)
    && manifest.permissions.inputMonitoring !== "authorized"
  ) {
    throw new ApplicationError(
      "conflict",
      `Input monitoring was not authorized for placement ${placementId}.`,
    );
  }
  if (
    edit.typedText.enabled
    && manifest.capture.typedText !== "enabled"
  ) {
    throw new ApplicationError(
      "conflict",
      `Typed-text capture was disabled for placement ${placementId}.`,
    );
  }
  if (
    edit.typedText.enabled
    && manifest.permissions.accessibility !== "authorized"
  ) {
    throw new ApplicationError(
      "conflict",
      `Accessibility metadata was not authorized for placement ${placementId}.`,
    );
  }
  const actual = ProjectCommitMetadataBindingV2Schema.parse({
    manifestSha256: canonicalJsonSha256(manifest),
    placementId,
    recordingId: asset.source.recordingId,
  });
  if (
    expectedBinding !== undefined
    && (
      expectedBinding.manifestSha256 !== actual.manifestSha256
      || expectedBinding.placementId !== actual.placementId
      || expectedBinding.recordingId !== actual.recordingId
    )
  ) {
    throw new ApplicationError(
      "conflict",
      "Recording metadata changed after the project edit batch was prepared.",
      {
        actualManifestSha256: actual.manifestSha256,
        expectedManifestSha256: expectedBinding.manifestSha256,
        placementId,
      },
    );
  }
  return actual;
}

export async function bindProjectCommitEditsInputV2(
  application: ApplicationContext,
  input: unknown,
): Promise<CommitProjectEditsInputV2> {
  const parsed = CommitProjectEditsInputV2Schema.parse(input);
  const edit = parsed.batch.ordered.find(
    (
      candidate,
    ): candidate is Extract<
      OrderedProjectEditV2,
      { readonly kind: "set-metadata-effects" }
    > => candidate.kind === "set-metadata-effects",
  );
  if (edit === undefined || !metadataEffectsAreEnabled(edit)) return parsed;
  const snapshot = await openProjectSnapshot(
    application.paths.projectRoot,
    parsed.project,
  );
  return await bindProjectCommitEditsInputV2FromSnapshot(
    application,
    parsed,
    snapshot,
  );
}

/**
 * Host-binding path for callers that acquired a coherent project snapshot
 * before entering this potentially long recording-evidence resolution.
 */
export async function bindProjectCommitEditsInputV2FromSnapshot(
  application: ApplicationContext,
  input: unknown,
  snapshot: OpenProjectSnapshot,
): Promise<CommitProjectEditsInputV2> {
  const parsed = CommitProjectEditsInputV2Schema.parse(input);
  const edit = parsed.batch.ordered.find(
    (
      candidate,
    ): candidate is Extract<
      OrderedProjectEditV2,
      { readonly kind: "set-metadata-effects" }
    > => candidate.kind === "set-metadata-effects",
  );
  if (edit === undefined || !metadataEffectsAreEnabled(edit)) return parsed;
  assertProjectEditBasis(parsed.basis, snapshot);
  const metadataBinding = await assertMetadataEffectsAvailable(
    application,
    snapshot.project,
    edit,
  );
  if (metadataBinding === undefined) {
    throw new ApplicationError(
      "internal",
      "Enabled metadata effects did not produce a recording metadata binding.",
    );
  }
  return CommitProjectEditsInputV2Schema.parse({
    ...parsed,
    metadataBinding,
  });
}

function manualZoomInputs(
  ordered: readonly OrderedProjectEditV3[],
): readonly ManualProjectZoomInputV3[] {
  return ordered.flatMap(edit => (
    edit.kind === "add-manual-zooms" ? edit.zooms : []
  ));
}

type ProjectAsset = VideoProjectV1["assets"][number];
type ProjectPlacement = VideoProjectV1["placements"][number];
interface ManualZoomRecordingEvidence {
  readonly manifest: Awaited<
    ReturnType<typeof openRecording>
  >["manifest"];
  readonly manifestSha256: string;
}

interface ManualZoomResolutionContext {
  readonly assets: ReadonlyMap<string, ProjectAsset>;
  readonly layers: Map<
    string,
    ResolvedProjectMetadataSourceLayer | null
  >;
  readonly placements: ReadonlyMap<string, ProjectPlacement>;
  readonly recordings: Map<string, Promise<ManualZoomRecordingEvidence>>;
  readonly syncSha256: Map<string, string>;
  readonly onResolutionCacheMiss:
    BindProjectCommitEditsInputV3Options["onResolutionCacheMiss"];
}

export type ManualZoomResolutionCacheKind =
  | "display-layer"
  | "recording"
  | "synchronization";

export interface BindProjectCommitEditsInputV3Options {
  /**
   * Test/diagnostic hook. It fires only when host evidence is actually
   * resolved, never for a cache hit.
   */
  readonly onResolutionCacheMiss?: (
    kind: ManualZoomResolutionCacheKind,
    key: string,
  ) => void;
}

function manualZoomResolutionContext(
  project: VideoProjectV1,
  options: BindProjectCommitEditsInputV3Options = {},
): ManualZoomResolutionContext {
  return {
    assets: new Map(project.assets.map(asset => [asset.assetId, asset])),
    layers: new Map(),
    placements: new Map(project.placements.map(
      placement => [placement.placementId, placement],
    )),
    recordings: new Map(),
    syncSha256: new Map(),
    onResolutionCacheMiss: options.onResolutionCacheMiss,
  };
}

function indexManualZoomBindings(
  bindings: readonly ProjectCommitManualZoomBindingV3[],
): ReadonlyMap<string, ProjectCommitManualZoomBindingV3> {
  const indexed = new Map<string, ProjectCommitManualZoomBindingV3>();
  for (const binding of bindings) {
    if (indexed.has(binding.zoomId)) {
      throw new ApplicationError(
        "incompatible",
        `Manual zoom binding is duplicated: ${binding.zoomId}`,
      );
    }
    indexed.set(binding.zoomId, binding);
  }
  return indexed;
}

function manualZoomBindingFor(
  bindings: ReadonlyMap<string, ProjectCommitManualZoomBindingV3>,
  zoomId: string,
): ProjectCommitManualZoomBindingV3 {
  const binding = bindings.get(zoomId);
  if (binding === undefined) {
    throw new ApplicationError(
      "incompatible",
      `Manual zoom ${zoomId} requires a host-owned recording binding.`,
    );
  }
  return binding;
}

async function resolveManualZoomBinding(
  application: ApplicationContext,
  project: VideoProjectV1,
  resolution: ManualZoomResolutionContext,
  input: ManualProjectZoomInputV3,
  defaultPlacementId: VideoProjectV1["referencePlacementId"],
  expectedBinding?: ProjectCommitManualZoomBindingV3,
): Promise<ProjectCommitManualZoomBindingV3> {
  const placementId = input.placementId
    ?? expectedBinding?.placementId
    ?? defaultPlacementId;
  const placement = resolution.placements.get(placementId);
  if (placement === undefined) {
    throw new ApplicationError(
      "not-found",
      `Unknown project zoom placement: ${placementId}`,
    );
  }
  if (!placement.enabled) {
    throw new ApplicationError(
      "conflict",
      `Project zoom placement is disabled: ${placementId}`,
    );
  }
  if (placement.sync.provenance.kind === "unverified") {
    throw new ApplicationError(
      "conflict",
      `Project zoom placement has unverified synchronization: ${placementId}`,
    );
  }
  if (input.range.endUs > project.timeline.durationUs) {
    throw new ApplicationError(
      "invalid-data",
      `Manual zoom ${input.zoomId} exceeds the project timeline.`,
    );
  }
  if (!projectIntervalHasCompleteSyncCoverage(
    placement.sync,
    input.range,
  )) {
    throw new ApplicationError(
      "conflict",
      `Manual zoom ${input.zoomId} is not fully covered by placement ${placementId}.`,
    );
  }
  const asset = resolution.assets.get(placement.assetId);
  if (asset?.source.kind !== "recording") {
    throw new ApplicationError(
      "conflict",
      `Zoom placement ${placementId} is not backed by a Transmute recording.`,
    );
  }
  let recording: ManualZoomRecordingEvidence;
  try {
    let pending = resolution.recordings.get(asset.source.recordingId);
    if (pending === undefined) {
      resolution.onResolutionCacheMiss?.(
        "recording",
        asset.source.recordingId,
      );
      pending = openRecording(
        application.paths.artifactRoot,
        asset.source.recordingId,
      ).then(opened => ({
        manifest: opened.manifest,
        manifestSha256: canonicalJsonSha256(opened.manifest),
      }));
      resolution.recordings.set(asset.source.recordingId, pending);
    }
    recording = await pending;
  } catch (error) {
    throw recordingMetadataLoadError(error, placementId);
  }
  const { manifest } = recording;
  if (manifest.state !== "stopped") {
    throw new ApplicationError(
      "conflict",
      `Manual zooms require an immutable stopped recording for placement ${placementId}.`,
    );
  }
  const displayId = input.displayId
    ?? expectedBinding?.displayId
    ?? manifest.sources.displays.find(display => display.isPrimary)?.displayId;
  if (displayId === undefined) {
    throw new ApplicationError(
      "not-found",
      `Manual zoom ${input.zoomId} requires a selected or primary display.`,
    );
  }
  const layerKey = `${placementId}\0${displayId}`;
  let layer = resolution.layers.get(layerKey);
  if (layer === undefined) {
    resolution.onResolutionCacheMiss?.("display-layer", layerKey);
    try {
      layer = resolveProjectMetadataSourceLayer(
        manifest,
        asset,
        placement,
        displayId,
      );
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ApplicationError("conflict", error.message);
    }
    resolution.layers.set(layerKey, layer);
  }
  if (layer === null) {
    throw new ApplicationError(
      "conflict",
      `Display ${displayId} is not an enabled video layer on placement ${placementId}.`,
    );
  }
  if (input.target.kind === "point" || input.target.kind === "rect") {
    try {
      assertStaticProjectZoomTargetVisible(input.target, {
        display: layer.display,
        presentation: layer.presentation,
        stream: layer.stream,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ApplicationError(
        "invalid-data",
        `Manual zoom ${input.zoomId} has a target outside the visible display layer: ${error.message}`,
      );
    }
  }
  if (
    input.target.kind === "cursor"
    && manifest.capture.cursor !== "metadata"
  ) {
    throw new ApplicationError(
      "conflict",
      `Cursor metadata capture was disabled for placement ${placementId}.`,
    );
  }
  if (
    input.target.kind === "window"
    && (
      manifest.capture.windowMetadata === "disabled"
      || manifest.permissions.windowMetadata !== "authorized"
    )
  ) {
    throw new ApplicationError(
      "conflict",
      `Window metadata was unavailable for placement ${placementId}.`,
    );
  }
  if (
    input.target.kind === "focused-input"
    && manifest.permissions.accessibility !== "authorized"
  ) {
    throw new ApplicationError(
      "conflict",
      `Accessibility metadata was unavailable for placement ${placementId}.`,
    );
  }
  let syncSha256 = resolution.syncSha256.get(placementId);
  if (syncSha256 === undefined) {
    resolution.onResolutionCacheMiss?.("synchronization", placementId);
    syncSha256 = hashPlacementSync(placement);
    resolution.syncSha256.set(placementId, syncSha256);
  }
  const actual = ProjectCommitManualZoomBindingV3Schema.parse({
    displayId,
    manifestSha256: recording.manifestSha256,
    placementId,
    recordingId: asset.source.recordingId,
    syncSha256,
    zoomId: input.zoomId,
  });
  if (
    expectedBinding !== undefined
    && canonicalJsonSha256(actual) !== canonicalJsonSha256(expectedBinding)
  ) {
    throw new ApplicationError(
      "conflict",
      `Manual zoom ${input.zoomId} bindings changed after the edit batch was prepared.`,
      {
        actualManifestSha256: actual.manifestSha256,
        expectedManifestSha256: expectedBinding.manifestSha256,
        placementId,
      },
    );
  }
  return actual;
}

export async function bindProjectCommitEditsInputV3(
  application: ApplicationContext,
  input: unknown,
  options: BindProjectCommitEditsInputV3Options = {},
): Promise<CommitProjectEditsInputV3> {
  const parsed = CommitProjectEditsInputV3Schema.parse(input);
  const metadataEdit = parsed.batch.ordered.find(
    (
      candidate,
    ): candidate is Extract<
      OrderedProjectEditV3,
      { readonly kind: "set-metadata-effects" }
    > => candidate.kind === "set-metadata-effects",
  );
  const zooms = manualZoomInputs(parsed.batch.ordered);
  const requiresMetadataBinding = metadataEdit !== undefined
    && metadataEffectsAreEnabled(metadataEdit);
  if (!requiresMetadataBinding && zooms.length === 0) return parsed;
  const snapshot = await openProjectSnapshot(
    application.paths.projectRoot,
    parsed.project,
  );
  return await bindProjectCommitEditsInputV3FromSnapshot(
    application,
    parsed,
    snapshot,
    options,
  );
}

/**
 * Host-binding path for callers that acquired a coherent project snapshot
 * before resolving recording and display evidence.
 */
export async function bindProjectCommitEditsInputV3FromSnapshot(
  application: ApplicationContext,
  input: unknown,
  snapshot: OpenProjectSnapshot,
  options: BindProjectCommitEditsInputV3Options = {},
): Promise<CommitProjectEditsInputV3> {
  const parsed = CommitProjectEditsInputV3Schema.parse(input);
  const metadataEdit = parsed.batch.ordered.find(
    (
      candidate,
    ): candidate is Extract<
      OrderedProjectEditV3,
      { readonly kind: "set-metadata-effects" }
    > => candidate.kind === "set-metadata-effects",
  );
  const zooms = manualZoomInputs(parsed.batch.ordered);
  const requiresMetadataBinding = metadataEdit !== undefined
    && metadataEffectsAreEnabled(metadataEdit);
  if (!requiresMetadataBinding && zooms.length === 0) return parsed;
  assertProjectEditBasis(parsed.basis, snapshot);
  const metadataBinding = requiresMetadataBinding
    ? await assertMetadataEffectsAvailable(
        application,
        snapshot.project,
        metadataEdit,
      )
    : undefined;
  const defaultPlacementId = snapshot.plan.effects.metadataPlacementId
    ?? snapshot.project.referencePlacementId;
  const resolution = manualZoomResolutionContext(
    snapshot.project,
    options,
  );
  const manualZoomBindings: ProjectCommitManualZoomBindingV3[] = [];
  for (const zoom of zooms) {
    manualZoomBindings.push(await resolveManualZoomBinding(
      application,
      snapshot.project,
      resolution,
      zoom,
      defaultPlacementId,
    ));
  }
  return CommitProjectEditsInputV3Schema.parse({
    ...parsed,
    ...(manualZoomBindings.length === 0 ? {} : { manualZoomBindings }),
    ...(metadataBinding === undefined ? {} : { metadataBinding }),
  });
}

function manualCameraMove(
  project: VideoProjectV1,
  input: Extract<
    OrderedProjectEditV2,
    { readonly kind: "add-manual-camera-moves" }
  >["cameraMoves"][number],
) {
  const placement = project.placements.find(
    candidate => candidate.placementId === input.placementId,
  );
  if (placement === undefined) {
    throw new ApplicationError(
      "not-found",
      `Unknown camera placement: ${input.placementId}`,
    );
  }
  const asset = project.assets.find(
    candidate => candidate.assetId === placement.assetId,
  );
  const stream = asset?.streams.find(
    candidate => candidate.streamId === input.streamId,
  );
  if (stream?.kind !== "video") {
    throw new ApplicationError(
      "not-found",
      `Unknown camera video stream: ${input.placementId}:${input.streamId}`,
    );
  }
  const configured = placement.video.find(
    candidate => candidate.streamId === input.streamId,
  );
  if (configured === undefined) {
    throw new ApplicationError(
      "conflict",
      `Camera video stream is not configured on placement ${input.placementId}.`,
    );
  }
  if (!placement.enabled || !configured.presentation.enabled) {
    throw new ApplicationError(
      "conflict",
      `Camera move ${input.cameraMoveId} targets a disabled video layer.`,
    );
  }
  try {
    const move = ProjectCameraMoveSchema.parse({
      ...input,
      binding: {
        geometrySha256: hashProjectCameraGeometry(
          project,
          input.placementId,
          input.streamId,
        ),
        syncSha256: hashProjectCameraSync(placement),
      },
      origin: { kind: "manual" },
    });
    assertProjectCameraMoveBindings(project, move);
    return move;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "invalid-data",
      `Manual camera move ${input.cameraMoveId} is invalid for the current project.`,
    );
  }
}

async function applyOrderedProjectEditV2(
  application: ApplicationContext,
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  edit: OrderedProjectEditV2,
  metadataBinding: ProjectCommitMetadataBindingV2 | undefined,
  updatedAt: string,
  normalize = true,
): Promise<ProjectEditPlanV1> {
  switch (edit.kind) {
    case "cut":
    case "trim":
    case "speed":
    case "add-overlays":
    case "remove-overlays":
      return applyOrderedProjectEdit(
        project,
        plan,
        edit,
        updatedAt,
        normalize,
      );
    case "add-zooms": {
      const existing = new Set(
        plan.zooms.map(zoom => zoom.operation.zoomId),
      );
      const conflicts = edit.zooms
        .map(zoom => zoom.operation.zoomId)
        .filter(zoomId => existing.has(zoomId))
        .sort();
      if (conflicts.length > 0) {
        throw new ApplicationError(
          "conflict",
          `Zoom ID${conflicts.length === 1 ? "" : "s"} already exist${conflicts.length === 1 ? "s" : ""}: ${conflicts.join(", ")}`,
        );
      }
      try {
        return finalizeProjectEditDraft({
          ...plan,
          updatedAt,
          zooms: [...plan.zooms, ...edit.zooms],
        }, normalize);
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "conflict",
          "Zooms are incompatible with the current project edit plan.",
        );
      }
    }
    case "remove-zooms": {
      const requested = new Set(edit.zoomIds);
      const existing = new Set(
        plan.zooms.map(zoom => zoom.operation.zoomId),
      );
      const missing = [...requested]
        .filter(zoomId => !existing.has(zoomId))
        .sort();
      if (missing.length > 0) {
        throw new ApplicationError(
          "not-found",
          `Unknown zoom${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
        );
      }
      return finalizeProjectEditDraft({
        ...plan,
        updatedAt,
        zooms: plan.zooms.filter(
          zoom => !requested.has(zoom.operation.zoomId),
        ),
      }, normalize);
    }
    case "set-metadata-effects":
      await assertMetadataEffectsAvailable(
        application,
        project,
        edit,
        metadataBinding,
      );
      return finalizeProjectEditDraft({
        ...plan,
        effects: {
          clicks: edit.clicks,
          cursor: edit.cursor,
          keystrokes: edit.keystrokes,
          metadataPlacementId: edit.metadataPlacementId,
          typedText: edit.typedText,
        },
        updatedAt,
      }, normalize);
    case "add-manual-camera-moves": {
      const existing = new Set(
        plan.cameraMoves.map(move => move.cameraMoveId),
      );
      const conflicts = edit.cameraMoves
        .map(move => move.cameraMoveId)
        .filter(cameraMoveId => existing.has(cameraMoveId))
        .sort();
      if (conflicts.length > 0) {
        throw new ApplicationError(
          "conflict",
          `Camera move ID${conflicts.length === 1 ? "" : "s"} already exist${conflicts.length === 1 ? "s" : ""}: ${conflicts.join(", ")}`,
        );
      }
      const additions = edit.cameraMoves.map(
        move => manualCameraMove(project, move),
      );
      try {
        return finalizeProjectEditDraft({
          ...plan,
          cameraMoves: [...plan.cameraMoves, ...additions],
          updatedAt,
        }, normalize);
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "conflict",
          "Manual camera moves are incompatible with the current project edit plan.",
        );
      }
    }
    case "remove-camera-moves": {
      const requested = new Set(edit.cameraMoveIds);
      const existing = new Set(
        plan.cameraMoves.map(move => move.cameraMoveId),
      );
      const missing = [...requested]
        .filter(cameraMoveId => !existing.has(cameraMoveId))
        .sort();
      if (missing.length > 0) {
        throw new ApplicationError(
          "not-found",
          `Unknown camera move${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
        );
      }
      return finalizeProjectEditDraft({
        ...plan,
        cameraMoves: plan.cameraMoves.filter(
          move => !requested.has(move.cameraMoveId),
        ),
        updatedAt,
      }, normalize);
    }
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

function manualProjectZoom(
  input: ManualProjectZoomInputV3,
  binding: ProjectCommitManualZoomBindingV3,
) {
  if (
    (input.placementId !== undefined && input.placementId !== binding.placementId)
    || (input.displayId !== undefined && input.displayId !== binding.displayId)
    || input.zoomId !== binding.zoomId
  ) {
    throw new ApplicationError(
      "conflict",
      `Manual zoom ${input.zoomId} does not match its host-owned binding.`,
    );
  }
  try {
    return ProjectZoomOperationSchema.parse({
      operation: {
        displayId: binding.displayId,
        easing: input.easing,
        enterDurationUs: input.enterDurationUs,
        exitDurationUs: input.exitDurationUs,
        kind: "manual",
        range: input.range,
        scale: input.scale,
        target: input.target,
        zoomId: input.zoomId,
      },
      placementId: binding.placementId,
    });
  } catch {
    throw new ApplicationError(
      "invalid-data",
      `Manual zoom ${input.zoomId} is invalid for the current project.`,
    );
  }
}

function removeKnownProjectEditIds<Id extends string>(
  available: Set<Id>,
  ids: readonly Id[],
  label: string,
): void {
  const requested = new Set(ids);
  const missing = [...requested]
    .filter(id => !available.has(id))
    .sort();
  if (missing.length > 0) {
    throw new ApplicationError(
      "not-found",
      `Unknown ${label}${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
  for (const id of requested) available.delete(id);
}

async function applyOrderedProjectEditV3(
  application: ApplicationContext,
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  edit: OrderedProjectEditV3,
  metadataBinding: ProjectCommitMetadataBindingV2 | undefined,
  manualZoomBindings: ReadonlyMap<
    string,
    ProjectCommitManualZoomBindingV3
  >,
  updatedAt: string,
  normalize = true,
): Promise<ProjectEditPlanV1> {
  if (edit.kind !== "add-manual-zooms") {
    return await applyOrderedProjectEditV2(
      application,
      project,
      plan,
      edit,
      metadataBinding,
      updatedAt,
      normalize,
    );
  }
  const existing = new Set(
    plan.zooms.map(zoom => zoom.operation.zoomId),
  );
  const conflicts = edit.zooms
    .map(zoom => zoom.zoomId)
    .filter(zoomId => existing.has(zoomId))
    .sort();
  if (conflicts.length > 0) {
    throw new ApplicationError(
      "conflict",
      `Zoom ID${conflicts.length === 1 ? "" : "s"} already exist${conflicts.length === 1 ? "s" : ""}: ${conflicts.join(", ")}`,
    );
  }
  const additions = edit.zooms.map(zoom => manualProjectZoom(
    zoom,
    manualZoomBindingFor(manualZoomBindings, zoom.zoomId),
  ));
  try {
    return finalizeProjectEditDraft({
      ...plan,
      updatedAt,
      zooms: [...plan.zooms, ...additions],
    }, normalize);
  } catch {
    throw new ApplicationError(
      "conflict",
      "Manual zooms are incompatible with the current project edit plan.",
    );
  }
}

async function applyOrderedProjectEditPhaseV3(
  application: ApplicationContext,
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  edits: readonly OrderedProjectEditV3[],
  metadataBinding: ProjectCommitMetadataBindingV2 | undefined,
  manualZoomBindings: ReadonlyMap<
    string,
    ProjectCommitManualZoomBindingV3
  >,
  updatedAt: string,
  abortSignal: AbortSignal,
): Promise<ProjectEditPlanV1> {
  const first = edits[0];
  if (first === undefined) return plan;
  const phase: ProjectEditNormalizationPhaseV3 =
    projectEditNormalizationPhaseV3(first);
  if (edits.some(edit => projectEditNormalizationPhaseV3(edit) !== phase)) {
    throw new ApplicationError(
      "internal",
      "A project edit normalization phase contained incompatible edits.",
    );
  }

  switch (phase) {
    case "structural": {
      const cuts: Extract<
        OrderedProjectEditV3,
        { readonly kind: "cut" }
      >["range"][] = [];
      const speed: ProjectEditPlanV1["speed"][number][] = [];
      let trimStartUs = 0;
      let trimEndUs = project.timeline.durationUs;
      let hasTrim = false;
      for (const edit of edits) {
        throwIfAborted(abortSignal);
        switch (edit.kind) {
          case "cut":
            cuts.push(edit.range);
            break;
          case "speed":
            speed.push({ range: edit.range, rate: edit.rate });
            break;
          case "trim":
            hasTrim = true;
            trimStartUs = Math.max(trimStartUs, edit.range.startUs);
            trimEndUs = Math.min(trimEndUs, edit.range.endUs);
            break;
          case "add-manual-camera-moves":
          case "add-manual-zooms":
          case "add-overlays":
          case "add-zooms":
          case "remove-camera-moves":
          case "remove-overlays":
          case "remove-zooms":
          case "set-metadata-effects":
            throw new ApplicationError(
              "internal",
              "A structural project edit phase contained a non-structural edit.",
            );
        }
      }
      const trimmedKeep = !hasTrim
        ? plan.keep
        : trimStartUs >= trimEndUs
          ? []
          : intersectIntervals(plan.keep, [{
              endUs: trimEndUs,
              startUs: trimStartUs,
            }]);
      return {
        ...plan,
        keep: subtractIntervals(trimmedKeep, cuts),
        speed: [...plan.speed, ...speed],
        updatedAt,
      };
    }
    case "add": {
      const cameraMoveIds = new Set(
        plan.cameraMoves.map(move => move.cameraMoveId),
      );
      const overlayIds = new Set(
        plan.overlays.map(overlay => overlay.overlayId),
      );
      const zoomIds = new Set(
        plan.zooms.map(zoom => zoom.operation.zoomId),
      );
      const cameraMoves: ProjectEditPlanV1["cameraMoves"][number][] = [];
      const overlays: ProjectEditPlanV1["overlays"][number][] = [];
      const zooms: ProjectEditPlanV1["zooms"][number][] = [];
      for (const edit of edits) {
        throwIfAborted(abortSignal);
        switch (edit.kind) {
          case "add-manual-camera-moves":
            for (const input of edit.cameraMoves) {
              if (cameraMoveIds.has(input.cameraMoveId)) {
                throw new ApplicationError(
                  "conflict",
                  `Camera move ID already exists: ${input.cameraMoveId}`,
                );
              }
              cameraMoveIds.add(input.cameraMoveId);
              cameraMoves.push(manualCameraMove(project, input));
            }
            break;
          case "add-manual-zooms":
            for (const input of edit.zooms) {
              if (zoomIds.has(input.zoomId)) {
                throw new ApplicationError(
                  "conflict",
                  `Zoom ID already exists: ${input.zoomId}`,
                );
              }
              zoomIds.add(input.zoomId);
              zooms.push(manualProjectZoom(
                input,
                manualZoomBindingFor(manualZoomBindings, input.zoomId),
              ));
            }
            break;
          case "add-overlays":
            for (const overlay of edit.overlays) {
              if (overlayIds.has(overlay.overlayId)) {
                throw new ApplicationError(
                  "conflict",
                  `Overlay ID already exists: ${overlay.overlayId}`,
                );
              }
              overlayIds.add(overlay.overlayId);
              overlays.push(overlay);
            }
            break;
          case "add-zooms":
            for (const zoom of edit.zooms) {
              if (zoomIds.has(zoom.operation.zoomId)) {
                throw new ApplicationError(
                  "conflict",
                  `Zoom ID already exists: ${zoom.operation.zoomId}`,
                );
              }
              zoomIds.add(zoom.operation.zoomId);
              zooms.push(zoom);
            }
            break;
          case "cut":
          case "remove-camera-moves":
          case "remove-overlays":
          case "remove-zooms":
          case "set-metadata-effects":
          case "speed":
          case "trim":
            throw new ApplicationError(
              "internal",
              "An additive project edit phase contained a non-additive edit.",
            );
        }
      }
      return {
        ...plan,
        cameraMoves: [...plan.cameraMoves, ...cameraMoves],
        overlays: [...plan.overlays, ...overlays],
        updatedAt,
        zooms: [...plan.zooms, ...zooms],
      };
    }
    case "remove": {
      const cameraMoveIds = new Set(
        plan.cameraMoves.map(move => move.cameraMoveId),
      );
      const overlayIds = new Set(
        plan.overlays.map(overlay => overlay.overlayId),
      );
      const zoomIds = new Set(
        plan.zooms.map(zoom => zoom.operation.zoomId),
      );
      for (const edit of edits) {
        throwIfAborted(abortSignal);
        switch (edit.kind) {
          case "remove-camera-moves":
            removeKnownProjectEditIds(
              cameraMoveIds,
              edit.cameraMoveIds,
              "camera move",
            );
            break;
          case "remove-overlays":
            removeKnownProjectEditIds(
              overlayIds,
              edit.overlayIds,
              "overlay",
            );
            break;
          case "remove-zooms":
            removeKnownProjectEditIds(
              zoomIds,
              edit.zoomIds,
              "zoom",
            );
            break;
          case "add-manual-camera-moves":
          case "add-manual-zooms":
          case "add-overlays":
          case "add-zooms":
          case "cut":
          case "set-metadata-effects":
          case "speed":
          case "trim":
            throw new ApplicationError(
              "internal",
              "A removal project edit phase contained a non-removal edit.",
            );
        }
      }
      return {
        ...plan,
        cameraMoves: plan.cameraMoves.filter(
          move => cameraMoveIds.has(move.cameraMoveId),
        ),
        overlays: plan.overlays.filter(
          overlay => overlayIds.has(overlay.overlayId),
        ),
        updatedAt,
        zooms: plan.zooms.filter(
          zoom => zoomIds.has(zoom.operation.zoomId),
        ),
      };
    }
    case "metadata": {
      const edit = first.kind === "set-metadata-effects"
        ? first
        : undefined;
      if (edit === undefined || edits.length !== 1) {
        throw new ApplicationError(
          "internal",
          "A metadata project edit phase must contain exactly one metadata edit.",
        );
      }
      return await applyOrderedProjectEditV2(
        application,
        project,
        plan,
        edit,
        metadataBinding,
        updatedAt,
        false,
      );
    }
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

interface ProjectEditsTransactionInput<Edit> {
  readonly batch: {
    readonly ordered: readonly Edit[];
  };
  readonly basis: ProjectEditBasis;
  readonly project: string;
  readonly updatedAt?: string | undefined;
}

interface CompleteProjectEditBindingsV3 {
  readonly manualZoomBindings: ReadonlyMap<
    string,
    ProjectCommitManualZoomBindingV3
  >;
  readonly metadataBinding: ProjectCommitMetadataBindingV2 | undefined;
  readonly metadataEdit: Extract<
    OrderedProjectEditV3,
    { readonly kind: "set-metadata-effects" }
  > | undefined;
  readonly requiresExternalRevalidation: boolean;
  readonly zooms: readonly ManualProjectZoomInputV3[];
}

function completeProjectEditBindingsV3(input: {
  readonly batch: CommitProjectEditsInputV3["batch"];
  readonly manualZoomBindings?: readonly ProjectCommitManualZoomBindingV3[];
  readonly metadataBinding?: ProjectCommitMetadataBindingV2;
}): CompleteProjectEditBindingsV3 {
  const metadataEdit = input.batch.ordered.find(
    (
      candidate,
    ): candidate is Extract<
      OrderedProjectEditV3,
      { readonly kind: "set-metadata-effects" }
    > => candidate.kind === "set-metadata-effects",
  );
  const requiresMetadataBinding = metadataEdit !== undefined
    && metadataEffectsAreEnabled(metadataEdit);
  if (requiresMetadataBinding && input.metadataBinding === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Enabled metadata effects require a host-bound recording manifest.",
    );
  }
  if (!requiresMetadataBinding && input.metadataBinding !== undefined) {
    throw new ApplicationError(
      "incompatible",
      "A metadata binding is valid only for enabled metadata effects.",
    );
  }
  const zooms = manualZoomInputs(input.batch.ordered);
  const manualZoomBindings = indexManualZoomBindings(
    input.manualZoomBindings ?? [],
  );
  const expectedZoomIds = new Set(zooms.map(zoom => zoom.zoomId));
  const actualZoomIds = new Set(manualZoomBindings.keys());
  if (
    expectedZoomIds.size !== actualZoomIds.size
    || [...expectedZoomIds].some(zoomId => !actualZoomIds.has(zoomId))
  ) {
    throw new ApplicationError(
      "incompatible",
      "Manual zooms require exact host-owned recording bindings.",
    );
  }
  return {
    manualZoomBindings,
    metadataBinding: input.metadataBinding,
    metadataEdit,
    requiresExternalRevalidation: requiresMetadataBinding || zooms.length > 0,
    zooms,
  };
}

async function deriveProjectEdits<Edit extends { readonly kind: string }>(
  input: {
    readonly abortSignal: AbortSignal;
    readonly edits: readonly Edit[];
    readonly plan: ProjectEditPlanV1;
    readonly project: VideoProjectV1;
    readonly updatedAt: string;
  },
  apply: (
    project: VideoProjectV1,
    plan: ProjectEditPlanV1,
    edit: Edit,
    updatedAt: string,
  ) => ProjectEditPlanV1 | Promise<ProjectEditPlanV1>,
  normalizationPhase?: (edit: Edit) => string,
  applyPhase?: (
    project: VideoProjectV1,
    plan: ProjectEditPlanV1,
    edits: readonly Edit[],
    updatedAt: string,
    abortSignal: AbortSignal,
  ) => ProjectEditPlanV1 | Promise<ProjectEditPlanV1>,
): Promise<ProjectEditPlanV1> {
  let next = input.plan;
  if (normalizationPhase !== undefined && applyPhase !== undefined) {
    let index = 0;
    while (index < input.edits.length) {
      throwIfAborted(input.abortSignal);
      const phase = normalizationPhase(input.edits[index]!);
      let endIndex = index + 1;
      while (
        endIndex < input.edits.length
        && normalizationPhase(input.edits[endIndex]!) === phase
      ) {
        endIndex += 1;
      }
      next = await applyPhase(
        input.project,
        next,
        input.edits.slice(index, endIndex),
        input.updatedAt,
        input.abortSignal,
      );
      next = normalizeCompleteEditDraft(next);
      throwIfAborted(input.abortSignal);
      index = endIndex;
    }
    return next;
  }
  for (const edit of input.edits) {
    throwIfAborted(input.abortSignal);
    next = await apply(input.project, next, edit, input.updatedAt);
  }
  return next;
}

/**
 * Derive a complete V3 edit batch from exact frozen documents and complete
 * host bindings without publishing the mutable current-plan pointer.
 */
export async function deriveProjectEditPlanV3(input: {
  readonly abortSignal: AbortSignal;
  readonly application: ApplicationContext;
  readonly batch: CommitProjectEditsInputV3["batch"];
  readonly manualZoomBindings?: readonly ProjectCommitManualZoomBindingV3[];
  readonly metadataBinding?: ProjectCommitMetadataBindingV2;
  readonly plan: ProjectEditPlanV1;
  readonly project: VideoProjectV1;
  readonly updatedAt: string;
}): Promise<ProjectEditPlanV1> {
  const bindings = completeProjectEditBindingsV3(input);
  return await deriveProjectEdits(
    {
      abortSignal: input.abortSignal,
      edits: input.batch.ordered,
      plan: input.plan,
      project: input.project,
      updatedAt: input.updatedAt,
    },
    async (project, plan, edit, updatedAt) => (
      await applyOrderedProjectEditV3(
        input.application,
        project,
        plan,
        edit,
        bindings.metadataBinding,
        bindings.manualZoomBindings,
        updatedAt,
        false,
      )
    ),
    projectEditNormalizationPhaseV3,
    async (project, plan, edits, updatedAt, abortSignal) => (
      await applyOrderedProjectEditPhaseV3(
        input.application,
        project,
        plan,
        edits,
        bindings.metadataBinding,
        bindings.manualZoomBindings,
        updatedAt,
        abortSignal,
      )
    ),
  );
}

/** Reverify every external recording fact bound into a complete V3 batch. */
export async function revalidateProjectEditBindingsV3(input: {
  readonly abortSignal: AbortSignal;
  readonly application: ApplicationContext;
  readonly batch: CommitProjectEditsInputV3["batch"];
  readonly manualZoomBindings?: readonly ProjectCommitManualZoomBindingV3[];
  readonly metadataBinding?: ProjectCommitMetadataBindingV2;
  readonly project: VideoProjectV1;
}): Promise<void> {
  const bindings = completeProjectEditBindingsV3(input);
  if (bindings.metadataEdit !== undefined && bindings.metadataBinding !== undefined) {
    await assertMetadataEffectsAvailable(
      input.application,
      input.project,
      bindings.metadataEdit,
      bindings.metadataBinding,
    );
  }
  const resolution = manualZoomResolutionContext(input.project);
  for (const zoom of bindings.zooms) {
    throwIfAborted(input.abortSignal);
    const expected = manualZoomBindingFor(
      bindings.manualZoomBindings,
      zoom.zoomId,
    );
    await resolveManualZoomBinding(
      input.application,
      input.project,
      resolution,
      zoom,
      expected.placementId,
      expected,
    );
  }
}

async function executeProjectEditsTransaction<
  Edit extends { readonly kind: string },
>(
  context: OperationExecutionContext,
  input: ProjectEditsTransactionInput<Edit>,
  apply: (
    project: VideoProjectV1,
    plan: ProjectEditPlanV1,
    edit: Edit,
    updatedAt: string,
  ) => ProjectEditPlanV1 | Promise<ProjectEditPlanV1>,
  revalidateBeforePublication?: (
    project: VideoProjectV1,
  ) => Promise<void>,
  normalizationPhase?: (edit: Edit) => string,
  applyPhase?: (
    project: VideoProjectV1,
    plan: ProjectEditPlanV1,
    edits: readonly Edit[],
    updatedAt: string,
    abortSignal: AbortSignal,
  ) => ProjectEditPlanV1 | Promise<ProjectEditPlanV1>,
): Promise<CommitProjectEditsOutput> {
  throwIfAborted(context.abortSignal);
  const snapshot = await openProjectSnapshot(
    context.application.paths.projectRoot,
    input.project,
  );
  assertProjectEditBasis(input.basis, snapshot);
  if (
    snapshot.plan.projectStructureSha256
    !== hashProjectStructure(snapshot.project)
  ) {
    throw new ApplicationError(
      "conflict",
      "The current edit plan belongs to an earlier project structure.",
    );
  }
  const updatedAt = input.updatedAt ?? IsoTimestampSchema.parse(
    context.application.clock.now().toISOString(),
  );
  const next = await deriveProjectEdits({
    abortSignal: context.abortSignal,
    edits: input.batch.ordered,
    plan: snapshot.plan,
    project: snapshot.project,
    updatedAt,
  }, apply, normalizationPhase, applyPhase);
  throwIfAborted(context.abortSignal);

  // The scheduler owns the outer physical project lease. The transaction
  // marker makes process loss before/after the atomic current-plan
  // replacement explicitly recoverable on resume.
  // Reject already-stale external evidence before the workflow marks
  // publication as potentially authoritative. This avoids turning an
  // ordinary stale input into a reconciliation loop.
  await revalidateBeforePublication?.(snapshot.project);
  throwIfAborted(context.abortSignal);
  await context.workflow?.beforePublication();
  throwIfAborted(context.abortSignal);
  // External recording evidence can change while the scheduler fence is
  // checked. Reopen it after that awaited gate, then reassert the durable
  // workflow fence so cancellation/fence ownership is the final external
  // check before the project transaction publishes. Stopped recording
  // evidence is immutable by contract; the exact hash check still rejects
  // observable drift injected during the first gate.
  if (revalidateBeforePublication !== undefined) {
    await revalidateBeforePublication(snapshot.project);
    throwIfAborted(context.abortSignal);
    await context.workflow?.beforePublication();
    throwIfAborted(context.abortSignal);
  }
  const nodePlanSha256 = context.workflow?.nodePlanSha256
    ?? canonicalJsonSha256({
      generation: snapshot.generation,
      input,
      nextPlanSha256: hashProjectEditPlan(next),
    });
  await commitProjectStateTransaction({
    after: { plan: next, project: snapshot.project },
    before: { plan: snapshot.plan, project: snapshot.project },
    fileSystem: snapshot.openProject.fileSystem,
    transactionId: projectEditTransactionId(nodePlanSha256),
  });
  return projectEditCommitReceipt(input, snapshot.project, next);
}

function normalizeCompleteEditDraft(
  plan: ProjectEditPlanV1,
): ProjectEditPlanV1 {
  try {
    return normalizeProjectEditPlan(plan);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "conflict",
      "Complete edits are incompatible with the current project edit plan.",
    );
  }
}

export const commitProjectEditsOperationDefinition = {
  inputSchema: CommitProjectEditsInputSchema,
  inputSchemaId: "studio.operation.project.commit-edits.input/v1",
  kind: "project.commit-edits",
  lifecycle: {
    kind: "project-transaction",
    execute: async (context, input) => await executeProjectEditsTransaction(
      context,
      input,
      applyOrderedProjectEdit,
    ),
  },
  outputSchema: ProjectEditCommitReceiptSchema,
  outputSchemaId: "studio.operation.project.commit-edits.output/v1",
  policy: {
    cache: "none",
    cancellable: true,
    effect: "project-mutation",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputBytes: 4_096,
    preparation: ["project-state"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "project-publication" },
    ],
    resume: "recoverable-transaction",
  },
  summarize: output => ({
    fields: {
      generationSha256: output.generation.generationSha256,
      operation: output.operation,
      planHash: output.planHash,
      planId: output.planId,
      projectId: output.projectId,
    },
    kind: "project.commit-edits",
  }),
  version: 1,
} satisfies OperationDefinition<
  "project.commit-edits",
  CommitProjectEditsInput,
  CommitProjectEditsOutput
>;

export const commitProjectEditsOperationDefinitionV2 = {
  inputSchema: CommitProjectEditsInputV2Schema,
  inputSchemaId: "studio.operation.project.commit-edits.input/v2",
  kind: "project.commit-edits",
  lifecycle: {
    kind: "project-transaction",
    execute: async (context, input) => {
      const metadataEdit = input.batch.ordered.find(
        (
          candidate,
        ): candidate is Extract<
          OrderedProjectEditV2,
          { readonly kind: "set-metadata-effects" }
        > => candidate.kind === "set-metadata-effects",
      );
      const requiresMetadataBinding = metadataEdit !== undefined
        && metadataEffectsAreEnabled(metadataEdit);
      if (requiresMetadataBinding && input.metadataBinding === undefined) {
        throw new ApplicationError(
          "incompatible",
          "Enabled metadata effects require a host-bound recording manifest.",
        );
      }
      return await executeProjectEditsTransaction(
        context,
        input,
        async (project, plan, edit, updatedAt) => (
          await applyOrderedProjectEditV2(
            context.application,
            project,
            plan,
            edit,
            input.metadataBinding,
            updatedAt,
          )
        ),
        requiresMetadataBinding
          ? async (project) => {
              await assertMetadataEffectsAvailable(
                context.application,
                project,
                metadataEdit,
                input.metadataBinding,
              );
            }
          : undefined,
      );
    },
  },
  outputSchema: ProjectEditCommitReceiptSchema,
  outputSchemaId: "studio.operation.project.commit-edits.output/v2",
  policy: {
    cache: "none",
    cancellable: true,
    effect: "project-mutation",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputBytes: 4_096,
    preparation: ["project-state", "recording-metadata"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "project-publication" },
    ],
    resume: "recoverable-transaction",
  },
  summarize: output => ({
    fields: {
      generationSha256: output.generation.generationSha256,
      operation: output.operation,
      planHash: output.planHash,
      planId: output.planId,
      projectId: output.projectId,
    },
    kind: "project.commit-edits",
  }),
  version: 2,
} satisfies OperationDefinition<
  "project.commit-edits",
  CommitProjectEditsInputV2,
  CommitProjectEditsOutput
>;

export const commitProjectEditsOperationDefinitionV3 = {
  inputSchema: CommitProjectEditsInputV3Schema,
  inputSchemaId: "studio.operation.project.commit-edits.input/v3",
  kind: "project.commit-edits",
  lifecycle: {
    kind: "project-transaction",
    execute: async (context, input) => {
      const metadataEdit = input.batch.ordered.find(
        (
          candidate,
        ): candidate is Extract<
          OrderedProjectEditV3,
          { readonly kind: "set-metadata-effects" }
        > => candidate.kind === "set-metadata-effects",
      );
      const requiresMetadataBinding = metadataEdit !== undefined
        && metadataEffectsAreEnabled(metadataEdit);
      if (requiresMetadataBinding && input.metadataBinding === undefined) {
        throw new ApplicationError(
          "incompatible",
          "Enabled metadata effects require a host-bound recording manifest.",
        );
      }
      const zooms = manualZoomInputs(input.batch.ordered);
      const manualZoomBindings = indexManualZoomBindings(
        input.manualZoomBindings ?? [],
      );
      const expectedZoomIds = new Set(zooms.map(zoom => zoom.zoomId));
      const actualZoomIds = new Set(manualZoomBindings.keys());
      if (
        expectedZoomIds.size !== actualZoomIds.size
        || [...expectedZoomIds].some(zoomId => !actualZoomIds.has(zoomId))
      ) {
        throw new ApplicationError(
          "incompatible",
          "Manual zooms require exact host-owned recording bindings.",
        );
      }
      return await executeProjectEditsTransaction(
        context,
        input,
        async (project, plan, edit, updatedAt) => (
          await applyOrderedProjectEditV3(
            context.application,
            project,
            plan,
            edit,
            input.metadataBinding,
            manualZoomBindings,
            updatedAt,
            false,
          )
        ),
        requiresMetadataBinding || zooms.length > 0
          ? async (project) => {
              if (requiresMetadataBinding) {
                await assertMetadataEffectsAvailable(
                  context.application,
                  project,
                  metadataEdit,
                  input.metadataBinding,
                );
              }
              const resolution = manualZoomResolutionContext(project);
              for (const zoom of zooms) {
                throwIfAborted(context.abortSignal);
                const expected = manualZoomBindingFor(
                  manualZoomBindings,
                  zoom.zoomId,
                );
                await resolveManualZoomBinding(
                  context.application,
                  project,
                  resolution,
                  zoom,
                  expected.placementId,
                  expected,
                );
              }
            }
          : undefined,
        projectEditNormalizationPhaseV3,
        async (
          project,
          plan,
          edits,
          updatedAt,
          abortSignal,
        ) => await applyOrderedProjectEditPhaseV3(
          context.application,
          project,
          plan,
          edits,
          input.metadataBinding,
          manualZoomBindings,
          updatedAt,
          abortSignal,
        ),
      );
    },
  },
  outputSchema: ProjectEditCommitReceiptSchema,
  outputSchemaId: "studio.operation.project.commit-edits.output/v3",
  policy: {
    cache: "none",
    cancellable: true,
    effect: "project-mutation",
    maxDurationMs: 90_000,
    maxFanOut: 0,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputBytes: 4_096,
    preparation: ["project-state", "recording-metadata"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "project-publication" },
    ],
    resume: "recoverable-transaction",
  },
  summarize: output => ({
    fields: {
      generationSha256: output.generation.generationSha256,
      operation: output.operation,
      planHash: output.planHash,
      planId: output.planId,
      projectId: output.projectId,
    },
    kind: "project.commit-edits",
  }),
  version: 3,
} satisfies OperationDefinition<
  "project.commit-edits",
  CommitProjectEditsInputV3,
  CommitProjectEditsOutput
>;
