import {
  ManualProjectCameraMoveInputV2Schema,
  ManualProjectZoomInputV3Schema,
  type ManualProjectCameraMoveInputV2,
  type ManualProjectZoomInputV3,
  type OrderedProjectEditV2,
  type OrderedProjectEditV3,
} from "../application/operations/derive/edit-batch";
import {
  CameraPoseSchema,
  type CameraPose,
  type Easing,
  type ProjectEditPlanV1,
  type ProjectPlacementId,
  type SourceInterval,
  type ZoomOperation,
  type ZoomTarget,
} from "../contracts";
import type { OperationInputValue } from "./contracts";

type MetadataEffects = ProjectEditPlanV1["effects"];

/** Binding-free manual move accepted by a checked v2 project commit. */
export type ManualCameraMoveInput = ManualProjectCameraMoveInputV2;

/** Binding-free manual zoom accepted by a checked v3 project commit. */
export type ManualZoomInput = Omit<
  ManualProjectZoomInputV3,
  "displayId" | "placementId"
> & {
  readonly displayId?: string;
  readonly placementId?: NonNullable<
    ManualProjectZoomInputV3["placementId"]
  >;
};

export type SetMetadataEffectsEdit = Extract<
  OrderedProjectEditV2,
  { readonly kind: "set-metadata-effects" }
>;

export type AddManualCameraMovesEdit = Extract<
  OrderedProjectEditV2,
  { readonly kind: "add-manual-camera-moves" }
>;

export type RemoveCameraMovesEdit = Extract<
  OrderedProjectEditV2,
  { readonly kind: "remove-camera-moves" }
>;

export type RemoveZoomsEdit = Extract<
  OrderedProjectEditV2,
  { readonly kind: "remove-zooms" }
>;

export type AddManualZoomsEdit = Extract<
  OrderedProjectEditV3,
  { readonly kind: "add-manual-zooms" }
>;

export interface MetadataEffectsOptions {
  readonly clicks: OperationInputValue<MetadataEffects["clicks"]>;
  readonly cursor: OperationInputValue<MetadataEffects["cursor"]>;
  readonly keystrokes: OperationInputValue<MetadataEffects["keystrokes"]>;
  readonly metadataPlacementId: OperationInputValue<ProjectPlacementId | null>;
  readonly typedText: OperationInputValue<MetadataEffects["typedText"]>;
}

/**
 * Replace the complete interaction-effect configuration in one explicit edit.
 * Requiring every field prevents an agent from depending on hidden prior state.
 */
export function setMetadataEffects(
  input: MetadataEffectsOptions,
): OperationInputValue<SetMetadataEffectsEdit> {
  return {
    clicks: input.clicks,
    cursor: input.cursor,
    keystrokes: input.keystrokes,
    kind: "set-metadata-effects",
    metadataPlacementId: input.metadataPlacementId,
    typedText: input.typedText,
  };
}

/**
 * Conservative screen-demo polish. Typed text stays off because capture is
 * opt-in and secure-field suppression must never be weakened by a workflow.
 */
export function polishedInteractionEffects(
  metadataPlacementId: OperationInputValue<ProjectPlacementId>,
): OperationInputValue<SetMetadataEffectsEdit> {
  return setMetadataEffects({
    clicks: {
      color: "#5B8CFF",
      durationUs: 450_000,
      enabled: true,
      radiusPx: 28,
      style: "ring",
    },
    cursor: {
      enabled: true,
      scale: 1.15,
      smoothing: {
        algorithm: "exponential",
        strength: 0.42,
      },
      style: "captured",
    },
    keystrokes: {
      enabled: true,
      holdUs: 900_000,
      maxKeys: 6,
      position: "bottom-center",
      secureText: "hide",
    },
    metadataPlacementId,
    typedText: { enabled: false },
  });
}

export function addManualCameraMoves(
  cameraMoves: readonly OperationInputValue<ManualProjectCameraMoveInputV2>[],
): OperationInputValue<AddManualCameraMovesEdit> {
  return {
    cameraMoves,
    kind: "add-manual-camera-moves",
  };
}

export function addManualZooms(
  zooms: readonly (
    | ManualZoomInput
    | OperationInputValue<ManualProjectZoomInputV3>
  )[],
): OperationInputValue<AddManualZoomsEdit> {
  return {
    kind: "add-manual-zooms",
    zooms,
  };
}

export function removeCameraMoves(
  cameraMoveIds: readonly OperationInputValue<
    ManualProjectCameraMoveInputV2["cameraMoveId"]
  >[],
): OperationInputValue<RemoveCameraMovesEdit> {
  return {
    cameraMoveIds,
    kind: "remove-camera-moves",
  };
}

export function removeZooms(
  zoomIds: readonly OperationInputValue<ZoomOperation["zoomId"]>[],
): OperationInputValue<RemoveZoomsEdit> {
  return {
    kind: "remove-zooms",
    zoomIds,
  };
}

export interface ManualZoomOptions {
  readonly displayId?: string;
  readonly easing?: Easing;
  readonly enterDurationUs?: number;
  readonly exitDurationUs?: number;
  readonly placementId?: string;
  readonly range: SourceInterval;
  readonly scale: number;
  readonly target: ZoomTarget;
  readonly zoomId: string;
}

/**
 * Construct binding-free manual zoom intent. The host selects omitted
 * placement/display identities and binds the exact recording manifest and
 * placement synchronization during v3 commit planning.
 */
export function manualZoom(
  input: ManualZoomOptions,
): ManualZoomInput {
  const durationUs = input.range.endUs - input.range.startUs;
  const defaultTransitionUs = Math.min(
    300_000,
    Math.max(0, Math.floor(durationUs / 2)),
  );
  const parsed = ManualProjectZoomInputV3Schema.parse({
    ...input,
    easing: input.easing ?? { kind: "ease-in-out" },
    enterDurationUs: input.enterDurationUs ?? defaultTransitionUs,
    exitDurationUs: input.exitDurationUs ?? defaultTransitionUs,
  });
  return {
    easing: parsed.easing,
    enterDurationUs: parsed.enterDurationUs,
    exitDurationUs: parsed.exitDurationUs,
    range: parsed.range,
    scale: parsed.scale,
    target: parsed.target,
    zoomId: parsed.zoomId,
    ...(parsed.displayId === undefined
      ? {}
      : { displayId: parsed.displayId }),
    ...(parsed.placementId === undefined
      ? {}
      : { placementId: parsed.placementId }),
  };
}

export interface PreparedCameraPoseInput {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

export function preparedCameraPose(
  input: PreparedCameraPoseInput,
): CameraPose {
  return CameraPoseSchema.parse({
    ...input,
    space: "prepared-video-layer-normalized-v1",
  });
}

export interface CameraReframeOptions extends Omit<
  ManualProjectCameraMoveInputV2,
  "cameraMoveId" | "keyframes" | "placementId" | "streamId"
> {
  readonly cameraMoveId: string;
  readonly easing?: Easing;
  readonly from: PreparedCameraPoseInput;
  readonly placementId: string;
  readonly streamId: string;
  readonly to: PreparedCameraPoseInput;
}

/**
 * Construct a binding-free manual camera move with exact endpoint keyframes.
 * The checked commit binds it to the current placement synchronization and
 * prepared-layer geometry.
 */
export function cameraReframe(
  input: CameraReframeOptions,
): ManualProjectCameraMoveInputV2 {
  const easing = input.easing ?? { kind: "ease-in-out" };
  return ManualProjectCameraMoveInputV2Schema.parse({
    cameraMoveId: input.cameraMoveId,
    keyframes: [
      {
        outgoingEasing: easing,
        pose: preparedCameraPose(input.from),
        projectTimeUs: input.projectRange.startUs,
      },
      {
        outgoingEasing: { kind: "linear" },
        pose: preparedCameraPose(input.to),
        projectTimeUs: input.projectRange.endUs,
      },
    ],
    placementId: input.placementId,
    projectRange: input.projectRange,
    streamId: input.streamId,
  });
}

export interface CameraPushOptions extends Omit<CameraReframeOptions, "from"> {
  readonly from?: PreparedCameraPoseInput;
}

/**
 * Construct the common two-keyframe push-in move. Use cameraReframe when the
 * endpoint may zoom out or only pan.
 */
export function cameraPush(
  input: CameraPushOptions,
): ManualProjectCameraMoveInputV2 {
  const from = input.from ?? { centerX: 0.5, centerY: 0.5, zoom: 1 };
  if (input.to.zoom <= from.zoom) {
    throw new RangeError("A camera push must increase zoom from its first pose.");
  }
  return cameraReframe({ ...input, from });
}
