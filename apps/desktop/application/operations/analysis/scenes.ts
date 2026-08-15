import { z } from "zod";

import {
  AnalysisSubjectSchema,
  MicrosecondsSchema,
  SceneIdSchema,
  SceneSampleIdSchema,
  Sha256Schema,
  SourceIntervalSchema,
  VideoProjectIdSchema,
} from "../../../contracts";
import {
  MAXIMUM_SCENE_SAMPLES,
  planProjectScenes,
  type PlanProjectScenesOptions,
  type PlanProjectScenesResult,
} from "../../../cli/scene-analysis-service";
import {
  SCENE_SAMPLING_VERSION,
  canonicalJsonSha256,
} from "../../../core";
import type { OperationDefinition } from "../../operation";
import { openLeasedProjectSnapshot } from "../../project-publication-lease";
import {
  ProjectReferenceSchema,
  requireCapabilities,
  throwIfAborted,
} from "../shared";
import {
  AnalysisCapabilityBindingsSchema,
  AnalysisProjectBindingSchema,
  analysisCapabilityCommand,
  analysisCapabilityRunner,
  assertAnalysisCapabilityBindings,
  assertAnalysisProjectBinding,
} from "./shared";

const SceneSampleReasonSchema = z.enum([
  "boundary",
  "middle",
  "event",
  "maximum-gap",
  "motion",
]);

export const SceneAnalysisOperationConfigSchema = z.strictObject({
  maximumSceneDurationUs: MicrosecondsSchema.min(1_000_000),
  sceneThreshold: z.number().finite().positive().max(1),
});

export const DEFAULT_SCENE_ANALYSIS_CONFIG =
  SceneAnalysisOperationConfigSchema.parse({
    maximumSceneDurationUs: 20_000_000,
    sceneThreshold: 0.35,
  });

export const PlannedSceneEvidenceSchema = z.strictObject({
  boundaryConfidence: z.number().finite().min(0).max(1),
  range: SourceIntervalSchema,
  sampleIds: z.array(SceneSampleIdSchema).min(1).max(12),
  sceneId: SceneIdSchema,
});

export const PlannedSceneSampleEvidenceSchema = z.strictObject({
  reasons: z.array(SceneSampleReasonSchema).min(1).max(5),
  requestedAssetTimeUs: MicrosecondsSchema,
  sampleId: SceneSampleIdSchema,
  sceneId: SceneIdSchema,
});

export const SceneAnalysisOperationInputSchema = z.strictObject({
  capabilityBindings: AnalysisCapabilityBindingsSchema.optional(),
  config: SceneAnalysisOperationConfigSchema.optional(),
  project: ProjectReferenceSchema,
  projectBinding: AnalysisProjectBindingSchema.optional(),
  source: z.string().min(1).max(256),
});

export const SceneAnalysisOperationOutputSchema = z.strictObject({
  planDigest: Sha256Schema,
  projectId: VideoProjectIdSchema,
  samples: z.array(PlannedSceneSampleEvidenceSchema)
    .max(MAXIMUM_SCENE_SAMPLES),
  samplingVersion: z.literal(SCENE_SAMPLING_VERSION),
  scenes: z.array(PlannedSceneEvidenceSchema)
    .max(MAXIMUM_SCENE_SAMPLES),
  source: z.string().min(1).max(256),
  subject: AnalysisSubjectSchema,
}).superRefine((output, context) => {
  if (
    output.planDigest !== canonicalJsonSha256({
      samples: output.samples,
      samplingVersion: output.samplingVersion,
      scenes: output.scenes,
    })
  ) {
    context.addIssue({
      code: "custom",
      message: "Scene evidence does not match its plan digest.",
      path: ["planDigest"],
    });
  }

  const scenesById = new Map(
    output.scenes.map(scene => [scene.sceneId, scene]),
  );
  const samplesById = new Map(
    output.samples.map(sample => [sample.sampleId, sample]),
  );
  if (scenesById.size !== output.scenes.length) {
    context.addIssue({
      code: "custom",
      message: "Planned scene IDs must be unique.",
      path: ["scenes"],
    });
  }
  if (samplesById.size !== output.samples.length) {
    context.addIssue({
      code: "custom",
      message: "Planned scene sample IDs must be unique.",
      path: ["samples"],
    });
  }
  for (const scene of output.scenes) {
    for (const sampleId of scene.sampleIds) {
      const sample = samplesById.get(sampleId);
      if (sample === undefined || sample.sceneId !== scene.sceneId) {
        context.addIssue({
          code: "custom",
          message:
            `Scene ${scene.sceneId} references a missing or differently owned sample.`,
          path: ["scenes"],
        });
      }
    }
  }
  for (const sample of output.samples) {
    const scene = scenesById.get(sample.sceneId);
    if (
      scene === undefined
      || !scene.sampleIds.includes(sample.sampleId)
      || sample.requestedAssetTimeUs < scene.range.startUs
      || sample.requestedAssetTimeUs >= scene.range.endUs
    ) {
      context.addIssue({
        code: "custom",
        message:
          `Sample ${sample.sampleId} is outside its owning scene evidence.`,
        path: ["samples"],
      });
    }
  }
});

export type SceneAnalysisOperationInput = z.infer<
  typeof SceneAnalysisOperationInputSchema
>;
export type SceneAnalysisOperationOutput = z.infer<
  typeof SceneAnalysisOperationOutputSchema
>;

type ScenePlanningExecutor = (
  options: PlanProjectScenesOptions,
) => Promise<PlanProjectScenesResult>;

export interface SceneAnalysisOperationDependencies {
  readonly plan?: ScenePlanningExecutor;
}

export function createSceneAnalysisOperationDefinition(
  dependencies: SceneAnalysisOperationDependencies = {},
): OperationDefinition<
  "analysis.scenes",
  SceneAnalysisOperationInput,
  SceneAnalysisOperationOutput
> {
  const planScenes = dependencies.plan ?? planProjectScenes;
  return {
    inputSchema: SceneAnalysisOperationInputSchema,
    inputSchemaId: "atet.operation.analysis.scenes.input/v1",
    kind: "analysis.scenes",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const snapshot = await openLeasedProjectSnapshot(
          context.application,
          input.project,
        );
        assertAnalysisProjectBinding(context, input.projectBinding, snapshot);
        const capabilities = await requireCapabilities(
          context.application,
          ["ffmpeg"],
        );
        await assertAnalysisCapabilityBindings(
          context,
          input.capabilityBindings,
          context.application,
          ["ffmpeg"],
        );
        const config = input.config ?? DEFAULT_SCENE_ANALYSIS_CONFIG;
        const result = await planScenes({
          ffmpeg: analysisCapabilityCommand(
            input.capabilityBindings,
            capabilities,
            "ffmpeg",
          ),
          maximumSceneDurationUs: config.maximumSceneDurationUs,
          project: snapshot.project,
          repositoryRoot: context.application.paths.repositoryRoot,
          runner: analysisCapabilityRunner(
            context.application,
            input.capabilityBindings,
          ),
          sceneThreshold: config.sceneThreshold,
          source: input.source,
        });
        throwIfAborted(context.abortSignal);
        const finalSnapshot = await openLeasedProjectSnapshot(
          context.application,
          snapshot.project.projectId,
        );
        assertAnalysisProjectBinding(
          { workflow: {} },
          snapshot.editBasis,
          finalSnapshot,
        );
        return SceneAnalysisOperationOutputSchema.parse({
          planDigest: result.plan.planDigest,
          projectId: snapshot.project.projectId,
          samples: result.plan.samples,
          samplingVersion: result.plan.samplingVersion,
          scenes: result.plan.scenes,
          source: input.source,
          subject: result.subject,
        });
      },
    },
    outputSchema: SceneAnalysisOperationOutputSchema,
    outputSchemaId: "atet.operation.analysis.scenes.output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "local-read",
      maxDurationMs: 2 * 60 * 60_000,
      maxFanOut: 1,
      maxInputBytes: 16_384,
      maxOutputBytes: 16 * 1024 * 1024,
      preparation: ["project-state", "local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "deterministic",
    },
    summarize: output => ({
      fields: {
        planDigest: output.planDigest,
        projectId: output.projectId,
        samples: output.samples.length,
        scenes: output.scenes.length,
        source: output.source,
      },
      kind: "analysis.scenes",
    }),
    version: 1,
  };
}

export const sceneAnalysisOperationDefinition =
  createSceneAnalysisOperationDefinition();
