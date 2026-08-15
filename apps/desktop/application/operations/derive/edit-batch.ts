import { z } from "zod";

import {
  CameraMoveIdSchema,
  ClickEffectSchema,
  CursorEffectSchema,
  EasingSchema,
  KeystrokeEffectSchema,
  OverlayIdSchema,
  OverlayOperationSchema,
  ProjectCameraTransformKeyframeSchema,
  ProjectPlacementIdSchema,
  ProjectStreamIdSchema,
  ProjectZoomOperationSchema,
  Sha256Schema,
  SourceIntervalSchema,
  TypedTextEffectSchema,
  ZoomIdSchema,
  ZoomTargetSchema,
} from "../../../contracts";
import { canonicalJsonSha256 } from "../../../core/canonical-json";
import type { OperationDefinition } from "../../operation";
import { throwIfAborted } from "../shared";

export const OrderedProjectEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cut"),
    range: SourceIntervalSchema,
  }),
  z.strictObject({
    kind: z.literal("trim"),
    range: SourceIntervalSchema,
  }),
  z.strictObject({
    kind: z.literal("speed"),
    range: SourceIntervalSchema,
    rate: z.number().finite().positive().max(64),
  }),
  z.strictObject({
    kind: z.literal("add-zooms"),
    zooms: z.array(ProjectZoomOperationSchema).min(1).max(10_000),
  }),
  z.strictObject({
    kind: z.literal("add-overlays"),
    overlays: z.array(OverlayOperationSchema).min(1).max(10_000),
  }),
  z.strictObject({
    kind: z.literal("remove-overlays"),
    overlayIds: z.array(OverlayIdSchema).min(1).max(10_000),
  }),
]).superRefine((edit, context) => {
  if (
    edit.kind === "add-overlays"
    && new Set(edit.overlays.map(overlay => overlay.overlayId)).size
      !== edit.overlays.length
  ) {
    context.addIssue({
      code: "custom",
      message: "One add-overlays edit cannot contain duplicate overlay IDs.",
      path: ["overlays"],
    });
  }
  if (
    edit.kind === "remove-overlays"
    && new Set(edit.overlayIds).size !== edit.overlayIds.length
  ) {
    context.addIssue({
      code: "custom",
      message: "One remove-overlays edit cannot contain duplicate overlay IDs.",
      path: ["overlayIds"],
    });
  }
});

function refineOrderedOverlayTransitions(
  ordered: readonly (
    | {
      readonly kind: "add-overlays";
      readonly overlays: readonly { readonly overlayId: string }[];
    }
    | {
      readonly kind: "remove-overlays";
      readonly overlayIds: readonly string[];
    }
  )[],
  context: z.RefinementCtx,
): void {
  const added = new Set<string>();
  for (const [editIndex, edit] of ordered.entries()) {
    if (edit.kind === "remove-overlays") {
      for (const overlayId of edit.overlayIds) added.delete(overlayId);
      continue;
    }
    if (edit.kind !== "add-overlays") continue;
    for (const [overlayIndex, overlay] of edit.overlays.entries()) {
      if (added.has(overlay.overlayId)) {
        context.addIssue({
          code: "custom",
          message:
            "An ordered edit batch cannot add the same overlay ID twice without removing it between additions.",
          path: ["ordered", editIndex, "overlays", overlayIndex, "overlayId"],
        });
      }
      added.add(overlay.overlayId);
    }
  }
}

export const ProjectEditBatchInputSchema = z.strictObject({
  cutRanges: z.array(SourceIntervalSchema).max(10_000).optional(),
  ordered: z.array(OrderedProjectEditSchema).max(10_000).optional(),
}).superRefine((input, context) => {
  const total = (input.cutRanges?.length ?? 0) + (input.ordered?.reduce(
    (sum, edit) => {
      switch (edit.kind) {
        case "add-zooms":
          return sum + edit.zooms.length;
        case "add-overlays":
          return sum + edit.overlays.length;
        case "remove-overlays":
          return sum + edit.overlayIds.length;
        case "cut":
        case "speed":
        case "trim":
          return sum + 1;
        default: {
          const exhaustive: never = edit;
          return exhaustive;
        }
      }
    },
    0,
  ) ?? 0);
  if (total < 1) {
    context.addIssue({
      code: "custom",
      message: "An edit batch requires at least one explicit edit or derived cut range.",
    });
  }
  if (total > 10_000) {
    context.addIssue({
      code: "custom",
      message: "An edit batch cannot expand beyond 10,000 ordered edits.",
    });
  }
  refineOrderedOverlayTransitions(
    (input.ordered ?? []).filter(edit => (
      edit.kind === "add-overlays" || edit.kind === "remove-overlays"
    )),
    context,
  );
});

const ProjectEditBatchBodySchema = z.strictObject({
  kind: z.union([
    z.literal("atet.project-edit-batch"),
    z.literal("transmute.project-edit-batch"),
    z.literal("studio.project-edit-batch"),
  ]),
  ordered: z.array(OrderedProjectEditSchema).min(1).max(10_000),
  schemaVersion: z.literal(1),
});

export const ProjectEditBatchSchema = ProjectEditBatchBodySchema.extend({
  sha256: Sha256Schema,
}).strict().superRefine((batch, context) => {
  refineOrderedOverlayTransitions(
    batch.ordered.filter(edit => (
      edit.kind === "add-overlays" || edit.kind === "remove-overlays"
    )),
    context,
  );
  const actual = canonicalJsonSha256({
    kind: batch.kind,
    ordered: batch.ordered,
    schemaVersion: batch.schemaVersion,
  });
  if (actual !== batch.sha256) {
    context.addIssue({
      code: "custom",
      message: "Project edit batch hash does not match its ordered edit data.",
      path: ["sha256"],
    });
  }
});

export type OrderedProjectEdit = z.infer<typeof OrderedProjectEditSchema>;
export type ProjectEditBatchInput = z.infer<typeof ProjectEditBatchInputSchema>;
export type ProjectEditBatch = z.infer<typeof ProjectEditBatchSchema>;

export function deriveProjectEditBatch(
  orderedInput: readonly OrderedProjectEdit[],
): ProjectEditBatch {
  const body = ProjectEditBatchBodySchema.parse({
    kind: "atet.project-edit-batch",
    ordered: orderedInput,
    schemaVersion: 1,
  });
  return ProjectEditBatchSchema.parse({
    ...body,
    sha256: canonicalJsonSha256(body),
  });
}

export const deriveEditBatchOperationDefinition = {
  inputSchema: ProjectEditBatchInputSchema,
  inputSchemaId: "atet.operation.derive.edit-batch.input/v1",
  kind: "derive.edit-batch",
  lifecycle: {
    kind: "pure",
    execute: (context, input) => {
      throwIfAborted(context.abortSignal);
      return Promise.resolve(deriveProjectEditBatch([
        ...(input.cutRanges ?? []).map(range => ({ kind: "cut" as const, range })),
        ...(input.ordered ?? []),
      ]));
    },
  },
  outputSchema: ProjectEditBatchSchema,
  outputSchemaId: "atet.operation.derive.edit-batch.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "pure",
    maxDurationMs: 5_000,
    maxFanOut: 0,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      edits: output.ordered.length,
      sha256: output.sha256,
    },
    kind: "derive.edit-batch",
  }),
  version: 1,
} satisfies OperationDefinition<
  "derive.edit-batch",
  ProjectEditBatchInput,
  ProjectEditBatch
>;

export const ProjectMetadataEffectsInputV2Schema = z.strictObject({
  clicks: ClickEffectSchema,
  cursor: CursorEffectSchema,
  keystrokes: KeystrokeEffectSchema,
  metadataPlacementId: ProjectPlacementIdSchema.nullable(),
  typedText: TypedTextEffectSchema,
}).superRefine((effects, context) => {
  const enabled = effects.clicks.enabled
    || effects.cursor.enabled
    || effects.keystrokes.enabled
    || effects.typedText.enabled;
  if (enabled && effects.metadataPlacementId === null) {
    context.addIssue({
      code: "custom",
      message: "Enabled metadata effects require a non-null metadata placement.",
      path: ["metadataPlacementId"],
    });
  }
});

export const ManualProjectCameraMoveInputV2Schema = z.strictObject({
  cameraMoveId: CameraMoveIdSchema,
  keyframes: z.array(ProjectCameraTransformKeyframeSchema).min(2).max(4_096),
  placementId: ProjectPlacementIdSchema,
  projectRange: SourceIntervalSchema,
  streamId: ProjectStreamIdSchema,
}).superRefine((move, context) => {
  if (
    move.keyframes[0]?.projectTimeUs !== move.projectRange.startUs
    || move.keyframes.at(-1)?.projectTimeUs !== move.projectRange.endUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Camera move keyframes must exactly match both project range endpoints.",
      path: ["keyframes"],
    });
  }
  for (let index = 1; index < move.keyframes.length; index += 1) {
    if (
      move.keyframes[index]!.projectTimeUs
      <= move.keyframes[index - 1]!.projectTimeUs
    ) {
      context.addIssue({
        code: "custom",
        message: "Camera move keyframe project times must increase strictly.",
        path: ["keyframes", index, "projectTimeUs"],
      });
      break;
    }
  }
});

const SetMetadataEffectsEditV2Schema = ProjectMetadataEffectsInputV2Schema
  .extend({
    kind: z.literal("set-metadata-effects"),
  })
  .strict();

const AddManualCameraMovesEditV2Schema = z.strictObject({
  cameraMoves: z.array(ManualProjectCameraMoveInputV2Schema).min(1).max(4_096),
  kind: z.literal("add-manual-camera-moves"),
}).superRefine((edit, context) => {
  if (
    new Set(edit.cameraMoves.map(move => move.cameraMoveId)).size
    !== edit.cameraMoves.length
  ) {
    context.addIssue({
      code: "custom",
      message: "One add-manual-camera-moves edit cannot contain duplicate camera move IDs.",
      path: ["cameraMoves"],
    });
  }
});

const RemoveCameraMovesEditV2Schema = z.strictObject({
  cameraMoveIds: z.array(CameraMoveIdSchema).min(1).max(4_096),
  kind: z.literal("remove-camera-moves"),
}).superRefine((edit, context) => {
  if (new Set(edit.cameraMoveIds).size !== edit.cameraMoveIds.length) {
    context.addIssue({
      code: "custom",
      message: "One remove-camera-moves edit cannot contain duplicate camera move IDs.",
      path: ["cameraMoveIds"],
    });
  }
});

export const OrderedProjectEditV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cut"),
    range: SourceIntervalSchema,
  }),
  z.strictObject({
    kind: z.literal("trim"),
    range: SourceIntervalSchema,
  }),
  z.strictObject({
    kind: z.literal("speed"),
    range: SourceIntervalSchema,
    rate: z.number().finite().positive().max(64),
  }),
  z.strictObject({
    kind: z.literal("add-zooms"),
    zooms: z.array(ProjectZoomOperationSchema).min(1).max(10_000),
  }),
  z.strictObject({
    kind: z.literal("add-overlays"),
    overlays: z.array(OverlayOperationSchema).min(1).max(10_000),
  }),
  z.strictObject({
    kind: z.literal("remove-overlays"),
    overlayIds: z.array(OverlayIdSchema).min(1).max(10_000),
  }),
  z.strictObject({
    kind: z.literal("remove-zooms"),
    zoomIds: z.array(ZoomIdSchema).min(1).max(10_000),
  }).superRefine((edit, context) => {
    if (new Set(edit.zoomIds).size !== edit.zoomIds.length) {
      context.addIssue({
        code: "custom",
        message: "One remove-zooms edit cannot contain duplicate zoom IDs.",
        path: ["zoomIds"],
      });
    }
  }),
  SetMetadataEffectsEditV2Schema,
  AddManualCameraMovesEditV2Schema,
  RemoveCameraMovesEditV2Schema,
]).superRefine((edit, context) => {
  if (
    edit.kind === "add-overlays"
    && new Set(edit.overlays.map(overlay => overlay.overlayId)).size
      !== edit.overlays.length
  ) {
    context.addIssue({
      code: "custom",
      message: "One add-overlays edit cannot contain duplicate overlay IDs.",
      path: ["overlays"],
    });
  }
  if (
    edit.kind === "remove-overlays"
    && new Set(edit.overlayIds).size !== edit.overlayIds.length
  ) {
    context.addIssue({
      code: "custom",
      message: "One remove-overlays edit cannot contain duplicate overlay IDs.",
      path: ["overlayIds"],
    });
  }
  if (
    edit.kind === "add-zooms"
    && new Set(edit.zooms.map(zoom => zoom.operation.zoomId)).size
      !== edit.zooms.length
  ) {
    context.addIssue({
      code: "custom",
      message: "One add-zooms edit cannot contain duplicate zoom IDs.",
      path: ["zooms"],
    });
  }
});

type OrderedProjectEditV2Input = z.infer<typeof OrderedProjectEditV2Schema>;

function refineOrderedV2Transitions(
  ordered: readonly OrderedProjectEditV2Input[],
  context: z.RefinementCtx,
): void {
  const added = new Set<string>();
  const removed = new Set<string>();
  const addedZooms = new Set<string>();
  const removedZooms = new Set<string>();
  let metadataEffects = 0;
  for (const [editIndex, edit] of ordered.entries()) {
    if (edit.kind === "add-zooms") {
      for (const [zoomIndex, zoom] of edit.zooms.entries()) {
        const zoomId = zoom.operation.zoomId;
        if (addedZooms.has(zoomId)) {
          context.addIssue({
            code: "custom",
            message: "An ordered edit batch cannot add the same zoom ID twice.",
            path: ["ordered", editIndex, "zooms", zoomIndex, "operation", "zoomId"],
          });
        }
        addedZooms.add(zoomId);
      }
      continue;
    }
    if (edit.kind === "remove-zooms") {
      for (const [zoomIndex, zoomId] of edit.zoomIds.entries()) {
        if (removedZooms.has(zoomId)) {
          context.addIssue({
            code: "custom",
            message: "An ordered edit batch cannot remove the same zoom ID twice.",
            path: ["ordered", editIndex, "zoomIds", zoomIndex],
          });
        }
        removedZooms.add(zoomId);
      }
      continue;
    }
    if (edit.kind === "set-metadata-effects") {
      metadataEffects += 1;
      if (metadataEffects > 1) {
        context.addIssue({
          code: "custom",
          message: "An ordered edit batch can replace metadata effects only once.",
          path: ["ordered", editIndex],
        });
      }
      continue;
    }
    if (edit.kind === "add-manual-camera-moves") {
      for (const [moveIndex, move] of edit.cameraMoves.entries()) {
        if (added.has(move.cameraMoveId)) {
          context.addIssue({
            code: "custom",
            message: "An ordered edit batch cannot add the same camera move ID twice.",
            path: ["ordered", editIndex, "cameraMoves", moveIndex, "cameraMoveId"],
          });
        }
        added.add(move.cameraMoveId);
      }
      continue;
    }
    if (edit.kind === "remove-camera-moves") {
      for (const [moveIndex, cameraMoveId] of edit.cameraMoveIds.entries()) {
        if (removed.has(cameraMoveId)) {
          context.addIssue({
            code: "custom",
            message: "An ordered edit batch cannot remove the same camera move ID twice.",
            path: ["ordered", editIndex, "cameraMoveIds", moveIndex],
          });
        }
        removed.add(cameraMoveId);
      }
    }
  }
}

function countV2Edits(input: {
  readonly cutRanges?: readonly unknown[] | undefined;
  readonly ordered?: readonly OrderedProjectEditV2Input[] | undefined;
}): number {
  return (input.cutRanges?.length ?? 0) + (input.ordered?.reduce(
    (sum, edit) => {
      switch (edit.kind) {
        case "add-zooms":
          return sum + edit.zooms.length;
        case "add-overlays":
          return sum + edit.overlays.length;
        case "remove-overlays":
          return sum + edit.overlayIds.length;
        case "remove-zooms":
          return sum + edit.zoomIds.length;
        case "add-manual-camera-moves":
          return sum + edit.cameraMoves.length;
        case "remove-camera-moves":
          return sum + edit.cameraMoveIds.length;
        case "cut":
        case "set-metadata-effects":
        case "speed":
        case "trim":
          return sum + 1;
        default: {
          const exhaustive: never = edit;
          return exhaustive;
        }
      }
    },
    0,
  ) ?? 0);
}

export const ProjectEditBatchInputV2Schema = z.strictObject({
  cutRanges: z.array(SourceIntervalSchema).max(10_000).optional(),
  ordered: z.array(OrderedProjectEditV2Schema).max(10_000).optional(),
}).superRefine((input, context) => {
  const total = countV2Edits(input);
  if (total < 1) {
    context.addIssue({
      code: "custom",
      message: "An edit batch requires at least one explicit edit or derived cut range.",
    });
  }
  if (total > 10_000) {
    context.addIssue({
      code: "custom",
      message: "An edit batch cannot expand beyond 10,000 ordered edits.",
    });
  }
  refineOrderedOverlayTransitions(
    (input.ordered ?? []).filter(edit => (
      edit.kind === "add-overlays" || edit.kind === "remove-overlays"
    )),
    context,
  );
  refineOrderedV2Transitions(input.ordered ?? [], context);
});

const ProjectEditBatchBodyV2Schema = z.strictObject({
  kind: z.union([
    z.literal("atet.project-edit-batch"),
    z.literal("transmute.project-edit-batch"),
    z.literal("studio.project-edit-batch"),
  ]),
  ordered: z.array(OrderedProjectEditV2Schema).min(1).max(10_000),
  schemaVersion: z.literal(2),
});

export const ProjectEditBatchV2Schema = ProjectEditBatchBodyV2Schema.extend({
  sha256: Sha256Schema,
}).strict().superRefine((batch, context) => {
  refineOrderedOverlayTransitions(
    batch.ordered.filter(edit => (
      edit.kind === "add-overlays" || edit.kind === "remove-overlays"
    )),
    context,
  );
  refineOrderedV2Transitions(batch.ordered, context);
  const actual = canonicalJsonSha256({
    kind: batch.kind,
    ordered: batch.ordered,
    schemaVersion: batch.schemaVersion,
  });
  if (actual !== batch.sha256) {
    context.addIssue({
      code: "custom",
      message: "Project edit batch hash does not match its ordered edit data.",
      path: ["sha256"],
    });
  }
});

export type ProjectMetadataEffectsInputV2 = z.infer<
  typeof ProjectMetadataEffectsInputV2Schema
>;
export type ManualProjectCameraMoveInputV2 = z.infer<
  typeof ManualProjectCameraMoveInputV2Schema
>;
export type OrderedProjectEditV2 = z.infer<typeof OrderedProjectEditV2Schema>;
export type ProjectEditBatchInputV2 = z.infer<
  typeof ProjectEditBatchInputV2Schema
>;
export type ProjectEditBatchV2 = z.infer<typeof ProjectEditBatchV2Schema>;

export function deriveProjectEditBatchV2(
  orderedInput: readonly OrderedProjectEditV2[],
): ProjectEditBatchV2 {
  const body = ProjectEditBatchBodyV2Schema.parse({
    kind: "atet.project-edit-batch",
    ordered: orderedInput,
    schemaVersion: 2,
  });
  return ProjectEditBatchV2Schema.parse({
    ...body,
    sha256: canonicalJsonSha256(body),
  });
}

export const deriveEditBatchOperationDefinitionV2 = {
  inputSchema: ProjectEditBatchInputV2Schema,
  inputSchemaId: "atet.operation.derive.edit-batch.input/v2",
  kind: "derive.edit-batch",
  lifecycle: {
    kind: "pure",
    execute: (context, input) => {
      throwIfAborted(context.abortSignal);
      return Promise.resolve(deriveProjectEditBatchV2([
        ...(input.cutRanges ?? []).map(range => ({
          kind: "cut" as const,
          range,
        })),
        ...(input.ordered ?? []),
      ]));
    },
  },
  outputSchema: ProjectEditBatchV2Schema,
  outputSchemaId: "atet.operation.derive.edit-batch.output/v2",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "pure",
    maxDurationMs: 5_000,
    maxFanOut: 0,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      edits: output.ordered.length,
      sha256: output.sha256,
    },
    kind: "derive.edit-batch",
  }),
  version: 2,
} satisfies OperationDefinition<
  "derive.edit-batch",
  ProjectEditBatchInputV2,
  ProjectEditBatchV2
>;

/**
 * Editorial intent for one manual project zoom. Placement, display, recording
 * manifest, and synchronization identities are deliberately absent here (or
 * optional selectors): the project transaction binds them from current
 * host-owned state before execution.
 */
export const ManualProjectZoomInputV3Schema = z.strictObject({
  displayId: z.string().min(1).max(256).optional(),
  easing: EasingSchema,
  enterDurationUs: z.number().int().safe().nonnegative(),
  exitDurationUs: z.number().int().safe().nonnegative(),
  placementId: ProjectPlacementIdSchema.optional(),
  range: SourceIntervalSchema,
  scale: z.number().finite().min(1).max(10),
  target: ZoomTargetSchema,
  zoomId: ZoomIdSchema,
}).superRefine((zoom, context) => {
  if (
    zoom.enterDurationUs + zoom.exitDurationUs
    > zoom.range.endUs - zoom.range.startUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Zoom enter and exit durations cannot exceed the zoom range.",
      path: ["enterDurationUs"],
    });
  }
});

const AddManualZoomsEditV3Schema = z.strictObject({
  kind: z.literal("add-manual-zooms"),
  zooms: z.array(ManualProjectZoomInputV3Schema).min(1).max(10_000),
}).superRefine((edit, context) => {
  if (
    new Set(edit.zooms.map(zoom => zoom.zoomId)).size
    !== edit.zooms.length
  ) {
    context.addIssue({
      code: "custom",
      message: "One add-manual-zooms edit cannot contain duplicate zoom IDs.",
      path: ["zooms"],
    });
  }
});

export const OrderedProjectEditV3Schema = z.union([
  OrderedProjectEditV2Schema,
  AddManualZoomsEditV3Schema,
]);

type OrderedProjectEditV3Input = z.infer<typeof OrderedProjectEditV3Schema>;

export type ProjectEditNormalizationPhaseV3 =
  | "add"
  | "metadata"
  | "remove"
  | "structural";

export function projectEditNormalizationPhaseV3(
  edit: OrderedProjectEditV3Input,
): ProjectEditNormalizationPhaseV3 {
  switch (edit.kind) {
    case "cut":
    case "speed":
    case "trim":
      return "structural";
    case "add-manual-camera-moves":
    case "add-manual-zooms":
    case "add-overlays":
    case "add-zooms":
      return "add";
    case "remove-camera-moves":
    case "remove-overlays":
    case "remove-zooms":
      return "remove";
    case "set-metadata-effects":
      return "metadata";
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

const MAX_V3_NORMALIZATION_PHASES = 64;

function countV3NormalizationPhases(input: {
  readonly cutRanges?: readonly unknown[] | undefined;
  readonly ordered?: readonly OrderedProjectEditV3Input[] | undefined;
}): number {
  let count = input.cutRanges?.length === 0 || input.cutRanges === undefined
    ? 0
    : 1;
  let prior: ProjectEditNormalizationPhaseV3 | undefined = count === 0
    ? undefined
    : "structural";
  for (const edit of input.ordered ?? []) {
    const phase = projectEditNormalizationPhaseV3(edit);
    if (phase !== prior) {
      count += 1;
      prior = phase;
    }
  }
  return count;
}

function refineOrderedV3Transitions(
  ordered: readonly OrderedProjectEditV3Input[],
  context: z.RefinementCtx,
): void {
  refineOrderedV2Transitions(
    ordered.filter(
      (edit): edit is OrderedProjectEditV2Input => (
        edit.kind !== "add-manual-zooms"
      ),
    ),
    context,
  );
  const addedZooms = new Set<string>();
  for (const [editIndex, edit] of ordered.entries()) {
    const zooms = edit.kind === "add-zooms"
      ? edit.zooms.map(zoom => ({
          path: ["operation", "zoomId"] as const,
          zoomId: zoom.operation.zoomId,
        }))
      : edit.kind === "add-manual-zooms"
        ? edit.zooms.map(zoom => ({
            path: ["zoomId"] as const,
            zoomId: zoom.zoomId,
          }))
        : [];
    for (const [zoomIndex, zoom] of zooms.entries()) {
      if (addedZooms.has(zoom.zoomId)) {
        context.addIssue({
          code: "custom",
          message: "An ordered edit batch cannot add the same zoom ID twice.",
          path: [
            "ordered",
            editIndex,
            "zooms",
            zoomIndex,
            ...zoom.path,
          ],
        });
      }
      addedZooms.add(zoom.zoomId);
    }
  }
}

function countV3Edits(input: {
  readonly cutRanges?: readonly unknown[] | undefined;
  readonly ordered?: readonly OrderedProjectEditV3Input[] | undefined;
}): number {
  return (input.cutRanges?.length ?? 0) + (input.ordered?.reduce(
    (sum, edit) => edit.kind === "add-manual-zooms"
      ? sum + edit.zooms.length
      : sum + countV2Edits({ ordered: [edit] }),
    0,
  ) ?? 0);
}

export const ProjectEditBatchInputV3Schema = z.strictObject({
  cutRanges: z.array(SourceIntervalSchema).max(10_000).optional(),
  ordered: z.array(OrderedProjectEditV3Schema).max(10_000).optional(),
}).superRefine((input, context) => {
  const total = countV3Edits(input);
  if (total < 1) {
    context.addIssue({
      code: "custom",
      message: "An edit batch requires at least one explicit edit or derived cut range.",
    });
  }
  if (total > 10_000) {
    context.addIssue({
      code: "custom",
      message: "An edit batch cannot expand beyond 10,000 ordered edits.",
    });
  }
  if (
    countV3NormalizationPhases(input)
    > MAX_V3_NORMALIZATION_PHASES
  ) {
    context.addIssue({
      code: "custom",
      message:
        `An edit batch cannot contain more than ${String(MAX_V3_NORMALIZATION_PHASES)} ordered normalization phases.`,
      path: ["ordered"],
    });
  }
  refineOrderedOverlayTransitions(
    (input.ordered ?? []).filter(edit => (
      edit.kind === "add-overlays" || edit.kind === "remove-overlays"
    )),
    context,
  );
  refineOrderedV3Transitions(input.ordered ?? [], context);
});

const ProjectEditBatchBodyV3Schema = z.strictObject({
  kind: z.union([
    z.literal("atet.project-edit-batch"),
    z.literal("transmute.project-edit-batch"),
    z.literal("studio.project-edit-batch"),
  ]),
  ordered: z.array(OrderedProjectEditV3Schema).min(1).max(10_000),
  schemaVersion: z.literal(3),
});

export const ProjectEditBatchV3Schema = ProjectEditBatchBodyV3Schema.extend({
  sha256: Sha256Schema,
}).strict().superRefine((batch, context) => {
  if (countV3Edits({ ordered: batch.ordered }) > 10_000) {
    context.addIssue({
      code: "custom",
      message: "An edit batch cannot expand beyond 10,000 ordered edits.",
      path: ["ordered"],
    });
  }
  if (
    countV3NormalizationPhases({ ordered: batch.ordered })
    > MAX_V3_NORMALIZATION_PHASES
  ) {
    context.addIssue({
      code: "custom",
      message:
        `An edit batch cannot contain more than ${String(MAX_V3_NORMALIZATION_PHASES)} ordered normalization phases.`,
      path: ["ordered"],
    });
  }
  refineOrderedOverlayTransitions(
    batch.ordered.filter(edit => (
      edit.kind === "add-overlays" || edit.kind === "remove-overlays"
    )),
    context,
  );
  refineOrderedV3Transitions(batch.ordered, context);
  const actual = canonicalJsonSha256({
    kind: batch.kind,
    ordered: batch.ordered,
    schemaVersion: batch.schemaVersion,
  });
  if (actual !== batch.sha256) {
    context.addIssue({
      code: "custom",
      message: "Project edit batch hash does not match its ordered edit data.",
      path: ["sha256"],
    });
  }
});

export type ManualProjectZoomInputV3 = z.infer<
  typeof ManualProjectZoomInputV3Schema
>;
export type OrderedProjectEditV3 = z.infer<typeof OrderedProjectEditV3Schema>;
export type ProjectEditBatchInputV3 = z.infer<
  typeof ProjectEditBatchInputV3Schema
>;
export type ProjectEditBatchV3 = z.infer<typeof ProjectEditBatchV3Schema>;

export function deriveProjectEditBatchV3(
  orderedInput: readonly OrderedProjectEditV3[],
): ProjectEditBatchV3 {
  const body = ProjectEditBatchBodyV3Schema.parse({
    kind: "atet.project-edit-batch",
    ordered: orderedInput,
    schemaVersion: 3,
  });
  return ProjectEditBatchV3Schema.parse({
    ...body,
    sha256: canonicalJsonSha256(body),
  });
}

export const deriveEditBatchOperationDefinitionV3 = {
  inputSchema: ProjectEditBatchInputV3Schema,
  inputSchemaId: "atet.operation.derive.edit-batch.input/v3",
  kind: "derive.edit-batch",
  lifecycle: {
    kind: "pure",
    execute: (context, input) => {
      throwIfAborted(context.abortSignal);
      return Promise.resolve(deriveProjectEditBatchV3([
        ...(input.cutRanges ?? []).map(range => ({
          kind: "cut" as const,
          range,
        })),
        ...(input.ordered ?? []),
      ]));
    },
  },
  outputSchema: ProjectEditBatchV3Schema,
  outputSchemaId: "atet.operation.derive.edit-batch.output/v3",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "pure",
    maxDurationMs: 5_000,
    maxFanOut: 0,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      edits: output.ordered.length,
      sha256: output.sha256,
    },
    kind: "derive.edit-batch",
  }),
  version: 3,
} satisfies OperationDefinition<
  "derive.edit-batch",
  ProjectEditBatchInputV3,
  ProjectEditBatchV3
>;
