import { z } from "zod";

import {
  AnalysisIdSchema,
  CameraMoveIdSchema,
  EasingSchema,
  EditPlanIdSchema,
  FaceTrackIdSchema,
  ProjectCameraMoveSchema,
  ProjectEditPlanV1Schema,
  ProjectPlacementIdSchema,
  Sha256Schema,
  SourceIntervalSchema,
  VideoProjectIdSchema,
} from "../../../contracts";
import {
  assertProjectCameraMoveBindings,
  canonicalJsonSha256,
  hashProjectEditPlan,
  hashProjectStructure,
  normalizeProjectEditPlan,
} from "../../../core";
import {
  loadVerifiedProjectFaceAnalysis,
} from "../../../cli/face-analysis-service";
import { planProjectFaceCamera } from "../../../cli/project-face-camera";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { openLeasedProjectSnapshot } from "../../project-publication-lease";
import {
  assertProjectGeneration,
  ProjectGenerationHashesSchema,
  type OpenProjectSnapshot,
} from "../../project-store";
import { ProjectEditRevisionAspectSchema } from "../../receipts";
import {
  ProjectReferenceSchema,
  throwIfAborted,
} from "../shared";

export const FaceFollowSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("explicit"),
    trackIds: z.array(FaceTrackIdSchema).min(1).max(64),
  }).superRefine((selection, context) => {
    if (new Set(selection.trackIds).size !== selection.trackIds.length) {
      context.addIssue({
        code: "custom",
        message: "Explicit face-follow track IDs must be unique.",
      });
    }
  }),
  z.strictObject({ kind: z.enum(["all", "largest"]) }),
]);

const FaceFollowRequestOptionFields = {
  easing: EasingSchema.optional(),
  framing: z.enum(["tight", "medium", "wide", "group"]).optional(),
  gapPolicy: z.enum(["hold", "fallback", "fail"]).optional(),
  headroom: z.number().finite().min(0).max(1).optional(),
  maximumZoom: z.number().finite().min(1).max(10).optional(),
  minimumZoom: z.number().finite().min(1).max(10).optional(),
  placementId: ProjectPlacementIdSchema,
  projectRange: SourceIntervalSchema,
  requireAllSelectedFaces: z.boolean().optional(),
  selection: FaceFollowSelectionSchema.optional(),
  smoothingSeconds: z.number().finite().min(0).max(60).optional(),
} as const;

interface FaceFollowConstraintInput {
  readonly maximumZoom?: number | undefined;
  readonly minimumZoom?: number | undefined;
  readonly requireAllSelectedFaces?: boolean | undefined;
  readonly selection?: {
    readonly kind: "all" | "explicit" | "largest";
  } | undefined;
}

function validateFaceFollowConstraints(
  input: FaceFollowConstraintInput,
  context: z.RefinementCtx,
): void {
  const maximumZoom = input.maximumZoom ?? 4;
  const minimumZoom = input.minimumZoom ?? 1;
  if (maximumZoom < minimumZoom) {
    context.addIssue({
      code: "custom",
      message: "maximumZoom cannot be less than minimumZoom.",
      path: ["maximumZoom"],
    });
  }
  if (
    (input.selection?.kind ?? "largest") === "largest"
    && input.requireAllSelectedFaces === true
  ) {
    context.addIssue({
      code: "custom",
      message: "Largest-visible selection cannot require every selected face.",
      path: ["requireAllSelectedFaces"],
    });
  }
}

/**
 * Progressively disclosed, project-independent face-follow controls. Reusable
 * workflows embed this exact schema and add their own project, analysis, and
 * output-aspect bindings so those contracts cannot drift apart.
 */
export const FaceFollowRequestOptionsSchema = z.strictObject({
  ...FaceFollowRequestOptionFields,
}).superRefine(validateFaceFollowConstraints);

export type FaceFollowRequestOptions = z.infer<
  typeof FaceFollowRequestOptionsSchema
>;

export const FaceFollowParametersSchema = z.strictObject({
  aspect: ProjectEditRevisionAspectSchema,
  easing: EasingSchema,
  framing: z.enum(["tight", "medium", "wide", "group"]),
  gapPolicy: z.enum(["hold", "fallback", "fail"]),
  headroom: z.number().finite().min(0).max(1),
  maximumZoom: z.number().finite().min(1).max(10),
  minimumZoom: z.number().finite().min(1).max(10),
  placementId: ProjectPlacementIdSchema,
  projectRange: SourceIntervalSchema,
  requireAllSelectedFaces: z.boolean(),
  selection: FaceFollowSelectionSchema,
  smoothingSeconds: z.number().finite().min(0).max(60),
}).superRefine(validateFaceFollowConstraints);

export const FollowFacesInputSchema = z.strictObject({
  analysisId: AnalysisIdSchema,
  aspect: ProjectEditRevisionAspectSchema,
  ...FaceFollowRequestOptionFields,
  project: ProjectReferenceSchema,
}).superRefine(validateFaceFollowConstraints);

export const FaceFollowDerivationProvenanceSchema = z.strictObject({
  analysisId: AnalysisIdSchema,
  analysisSha256: Sha256Schema,
  baseGeneration: ProjectGenerationHashesSchema,
  basePlanId: EditPlanIdSchema,
  parameters: FaceFollowParametersSchema,
  projectId: VideoProjectIdSchema,
  projectStructureSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  subjectIntegritySha256: Sha256Schema,
});

const FaceFollowRevisionDraftBodySchema = z.strictObject({
  cameraMove: ProjectCameraMoveSchema,
  kind: z.union([
    z.literal("atet.face-follow-edit-revision-draft"),
    z.literal("studio.face-follow-edit-revision-draft"),
  ]),
  pixelHeight: z.number().int().safe().positive().max(16_384),
  pixelWidth: z.number().int().safe().positive().max(16_384),
  plan: ProjectEditPlanV1Schema,
  planSha256: Sha256Schema,
  provenance: FaceFollowDerivationProvenanceSchema,
  schemaVersion: z.literal(1),
  selectedTrackIds: z.array(FaceTrackIdSchema).min(1).max(64),
});

export const FaceFollowRevisionDraftSchema =
  FaceFollowRevisionDraftBodySchema.extend({
    derivationSha256: Sha256Schema,
  }).strict().superRefine((draft, context) => {
    const expectedDimensions = faceFollowDimensions(draft.provenance.parameters.aspect);
    if (
      draft.pixelWidth !== expectedDimensions.pixelWidth
      || draft.pixelHeight !== expectedDimensions.pixelHeight
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow output dimensions do not match its aspect-bound revision.",
        path: ["pixelWidth"],
      });
    }
    const actualDerivationSha256 = canonicalJsonSha256(draft.provenance);
    if (actualDerivationSha256 !== draft.derivationSha256) {
      context.addIssue({
        code: "custom",
        message: "Face-follow derivation hash does not match its provenance.",
        path: ["derivationSha256"],
      });
    }
    if (
      draft.planSha256 !== hashProjectEditPlan(draft.plan)
      || draft.planSha256 !== canonicalJsonSha256(draft.plan)
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow plan hash does not match its canonical plan.",
        path: ["planSha256"],
      });
    }
    if (
      draft.plan.projectId !== draft.provenance.projectId
      || draft.plan.projectStructureSha256
        !== draft.provenance.projectStructureSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow plan does not match its project provenance.",
        path: ["plan"],
      });
    }
    if (
      draft.plan.planId
      !== faceFollowPlanId(draft.derivationSha256)
      || draft.cameraMove.cameraMoveId
        !== faceFollowCameraMoveId(draft.derivationSha256)
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow plan and camera IDs are not derived from their provenance.",
        path: ["plan"],
      });
    }
    const matchingMoves = draft.plan.cameraMoves.filter(
      move => move.cameraMoveId === draft.cameraMove.cameraMoveId,
    );
    if (
      matchingMoves.length !== 1
      || canonicalJsonSha256(matchingMoves[0])
        !== canonicalJsonSha256(draft.cameraMove)
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow plan does not contain exactly its derived camera move.",
        path: ["cameraMove"],
      });
    }
    if (
      draft.cameraMove.placementId
        !== draft.provenance.parameters.placementId
      || canonicalJsonSha256(draft.cameraMove.projectRange)
        !== canonicalJsonSha256(draft.provenance.parameters.projectRange)
      || draft.cameraMove.origin.kind !== "face-analysis"
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow camera move does not match its requested subject and range.",
        path: ["cameraMove"],
      });
      return;
    }
    const expectedTrackIds = [...draft.selectedTrackIds].sort();
    if (
      new Set(draft.selectedTrackIds).size !== draft.selectedTrackIds.length
      || draft.selectedTrackIds.some((trackId, index) => trackId !== expectedTrackIds[index])
      || canonicalJsonSha256(draft.cameraMove.origin.trackIds)
        !== canonicalJsonSha256(draft.selectedTrackIds)
      || draft.cameraMove.origin.analysisId !== draft.provenance.analysisId
      || draft.cameraMove.origin.analysisSha256 !== draft.provenance.analysisSha256
      || draft.cameraMove.origin.subjectIntegritySha256
        !== draft.provenance.subjectIntegritySha256
      || draft.cameraMove.origin.outputAspectRatio
        !== draft.pixelWidth / draft.pixelHeight
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow camera move evidence does not match its derivation provenance.",
        path: ["cameraMove", "origin"],
      });
    }
  });

export type FaceFollowParameters = z.infer<typeof FaceFollowParametersSchema>;
export type FollowFacesInput = z.infer<typeof FollowFacesInputSchema>;
export type FaceFollowRevisionDraft = z.infer<typeof FaceFollowRevisionDraftSchema>;

export function faceFollowDimensions(
  aspect: z.infer<typeof ProjectEditRevisionAspectSchema>,
): Readonly<{ readonly pixelHeight: number; readonly pixelWidth: number }> {
  if (aspect === "16:9") return { pixelHeight: 1_080, pixelWidth: 1_920 };
  if (aspect === "1:1") return { pixelHeight: 1_080, pixelWidth: 1_080 };
  return { pixelHeight: 1_920, pixelWidth: 1_080 };
}

function faceFollowPlanId(derivationSha256: string) {
  return EditPlanIdSchema.parse(`plan_face_${derivationSha256.slice(0, 24)}`);
}

function faceFollowCameraMoveId(derivationSha256: string) {
  return CameraMoveIdSchema.parse(
    `camera_face_${derivationSha256.slice(0, 24)}`,
  );
}

function normalizeParameters(input: FollowFacesInput): FaceFollowParameters {
  return FaceFollowParametersSchema.parse({
    aspect: input.aspect,
    easing: input.easing ?? { kind: "ease-in-out" },
    framing: input.framing ?? "medium",
    gapPolicy: input.gapPolicy ?? "hold",
    headroom: input.headroom ?? 0.08,
    maximumZoom: input.maximumZoom ?? 4,
    minimumZoom: input.minimumZoom ?? 1,
    placementId: input.placementId,
    projectRange: input.projectRange,
    requireAllSelectedFaces: input.requireAllSelectedFaces ?? false,
    selection: input.selection ?? { kind: "largest" },
    smoothingSeconds: input.smoothingSeconds ?? 0.25,
  });
}

export interface FollowFacesOperationDependencies {
  readonly loadFaceAnalysis?: (
    snapshot: OpenProjectSnapshot,
    analysisId: string,
  ) => Promise<Pick<
    Awaited<ReturnType<typeof loadVerifiedProjectFaceAnalysis>>,
    "analysis" | "reference"
  >>;
}

export function createFollowFacesOperationDefinition(
  dependencies: FollowFacesOperationDependencies = {},
): OperationDefinition<
  "derive.follow-faces",
  FollowFacesInput,
  FaceFollowRevisionDraft
> {
  const loadFaceAnalysis = dependencies.loadFaceAnalysis
    ?? ((snapshot, analysisId) => loadVerifiedProjectFaceAnalysis({
      analysisId,
      project: snapshot.openProject,
    }));
  return {
    inputSchema: FollowFacesInputSchema,
    inputSchemaId: "atet.operation.derive.follow-faces.input/v1",
    kind: "derive.follow-faces",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const snapshot = await openLeasedProjectSnapshot(
          context.application,
          input.project,
        );
        assertProjectGeneration(
          context.expectedProjectGeneration,
          snapshot.generation,
        );
        const projectStructureSha256 = hashProjectStructure(snapshot.project);
        if (
          snapshot.plan.projectId !== snapshot.project.projectId
          || snapshot.plan.projectStructureSha256 !== projectStructureSha256
        ) {
          throw new ApplicationError(
            "conflict",
            "Current edit plan is not bound to the current project structure.",
          );
        }
        const loaded = await loadFaceAnalysis(snapshot, input.analysisId);
        const parameters = normalizeParameters(input);
        const provenance = FaceFollowDerivationProvenanceSchema.parse({
          analysisId: loaded.analysis.analysisId,
          analysisSha256: loaded.reference.sha256,
          baseGeneration: snapshot.generation,
          basePlanId: snapshot.plan.planId,
          parameters,
          projectId: snapshot.project.projectId,
          projectStructureSha256,
          schemaVersion: 1,
          subjectIntegritySha256: loaded.analysis.subject.integritySha256,
        });
        const derivationSha256 = canonicalJsonSha256(provenance);
        const dimensions = faceFollowDimensions(parameters.aspect);
        const planned = planProjectFaceCamera({
          analysis: loaded.analysis,
          cameraMoveId: faceFollowCameraMoveId(derivationSha256),
          easing: parameters.easing,
          framing: parameters.framing,
          gapPolicy: parameters.gapPolicy,
          headroom: parameters.headroom,
          maximumZoom: parameters.maximumZoom,
          minimumZoom: parameters.minimumZoom,
          outputHeight: dimensions.pixelHeight,
          outputWidth: dimensions.pixelWidth,
          placementId: parameters.placementId,
          plan: snapshot.plan,
          project: snapshot.project,
          projectRange: parameters.projectRange,
          reference: loaded.reference,
          requireAllSelectedFaces: parameters.requireAllSelectedFaces,
          selection: parameters.selection,
          smoothingSeconds: parameters.smoothingSeconds,
        });
        assertProjectCameraMoveBindings(snapshot.project, planned.move);
        const plan = normalizeProjectEditPlan({
          ...snapshot.plan,
          cameraMoves: [...snapshot.plan.cameraMoves, planned.move],
          planId: faceFollowPlanId(derivationSha256),
        });
        throwIfAborted(context.abortSignal);
        const finalSnapshot = await openLeasedProjectSnapshot(
          context.application,
          snapshot.project.projectId,
        );
        assertProjectGeneration(
          snapshot.generation.generationSha256,
          finalSnapshot.generation,
        );
        return FaceFollowRevisionDraftSchema.parse({
          cameraMove: planned.move,
          derivationSha256,
          kind: "atet.face-follow-edit-revision-draft",
          ...dimensions,
          plan,
          planSha256: hashProjectEditPlan(plan),
          provenance,
          schemaVersion: 1,
          selectedTrackIds: planned.selectedTrackIds,
        });
      },
    },
    outputSchema: FaceFollowRevisionDraftSchema,
    outputSchemaId: "atet.operation.derive.follow-faces.output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "local-read",
      maxDurationMs: 2 * 60_000,
      maxFanOut: 3,
      maxInputBytes: 64 * 1024,
      maxOutputBytes: 32 * 1024 * 1024,
      preparation: ["project-state", "local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "deterministic",
    },
    summarize: output => ({
      fields: {
        aspect: output.provenance.parameters.aspect,
        cameraMoveId: output.cameraMove.cameraMoveId,
        keyframes: output.cameraMove.keyframes.length,
        planSha256: output.planSha256,
        projectId: output.provenance.projectId,
        selectedFaces: output.selectedTrackIds.length,
      },
      kind: "derive.follow-faces",
    }),
    version: 1,
  };
}

export const followFacesOperationDefinition =
  createFollowFacesOperationDefinition();
