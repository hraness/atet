import { z } from "zod";

import {
  AnalysisIdSchema,
  MicrosecondsSchema,
  MusicAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  RepositoryRelativePathSchema,
  VideoProjectIdSchema,
  type MusicAnalysisV1,
} from "../../../contracts";
import {
  DEFAULT_MUSIC_ANALYSIS_CONFIG,
  analyzeProjectMusic,
  publishProjectMusicAnalysisArtifact,
  type AnalyzeProjectMusicOptions,
  type PublishedProjectMusicAnalysisArtifact,
} from "../../../cli/music-analysis-service";
import type { OperationDefinition } from "../../operation";
import { writeOperationCompletionCheckpoint } from "../../operation-completion-checkpoint";
import {
  mergeProjectAnalysisReference,
  openLeasedProjectSnapshot,
  projectAnalysisPublicationBasis,
} from "../../project-publication-lease";
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
  assertPublishedAnalysisReference,
  resolveAnalysisId,
  resolveToolVersion,
  type VersionedAnalysisDependencies,
} from "./shared";

interface AnalyzedProjectMusic {
  readonly analysis: Pick<
    MusicAnalysisV1,
    "analysisId" | "keyRegions" | "musicRegions" | "tempoRegions"
  >;
}

type MusicAnalysisExecutor = (
  options: AnalyzeProjectMusicOptions,
) => Promise<AnalyzedProjectMusic>;

type MusicAnalysisPublisher = (options: {
  readonly analysis: AnalyzedProjectMusic["analysis"];
  readonly project: AnalyzeProjectMusicOptions["project"];
}) => Promise<PublishedProjectMusicAnalysisArtifact>;

export interface MusicOperationDependencies
  extends VersionedAnalysisDependencies {
  readonly analyze?: MusicAnalysisExecutor;
  readonly publish?: MusicAnalysisPublisher;
}

export const MusicAnalysisConfigSchema = z.strictObject({
  hopSize: z.number().int().safe().positive(),
  minimumMusicUs: MicrosecondsSchema,
  sampleRateHz: z.number().int().safe().min(8_000).max(192_000),
  tempoWindowUs: MicrosecondsSchema,
  windowSize: z.number().int().safe().positive(),
});

export const MusicOperationInputSchema = z.strictObject({
  analysisId: AnalysisIdSchema.optional(),
  capabilityBindings: AnalysisCapabilityBindingsSchema.optional(),
  config: MusicAnalysisConfigSchema.optional(),
  project: ProjectReferenceSchema,
  projectBinding: AnalysisProjectBindingSchema.optional(),
  source: z.string().min(1).max(256),
});

export const MusicOperationOutputSchema = z.strictObject({
  analysisId: AnalysisIdSchema,
  keyChanges: z.number().int().safe().nonnegative(),
  keyRegions: z.number().int().safe().nonnegative(),
  musicRegions: z.number().int().safe().nonnegative(),
  path: RepositoryRelativePathSchema,
  projectId: VideoProjectIdSchema,
  reference: ProjectAnalysisReferenceSchema,
  tempoChanges: z.number().int().safe().nonnegative(),
  tempoRegions: z.number().int().safe().nonnegative(),
}).superRefine((output, context) => {
  if (output.reference.kind !== "music") {
    context.addIssue({ code: "custom", message: "Expected a music analysis reference.", path: ["reference"] });
    return;
  }
  if (
    output.reference.analysisId !== output.analysisId
    || output.reference.path !== output.path
    || output.reference.keyRegions !== output.keyRegions
    || output.reference.musicRegions !== output.musicRegions
    || output.reference.tempoRegions !== output.tempoRegions
  ) {
    context.addIssue({
      code: "custom",
      message: "Music result and authoritative reference disagree.",
      path: ["reference"],
    });
  }
});

export type MusicOperationInput = z.infer<typeof MusicOperationInputSchema>;
export type MusicOperationOutput = z.infer<typeof MusicOperationOutputSchema>;

export function createMusicOperationDefinition(
  dependencies: MusicOperationDependencies,
): OperationDefinition<
  "analysis.music",
  MusicOperationInput,
  MusicOperationOutput
> {
  const executeAnalysis = dependencies.analyze ?? analyzeProjectMusic;
  const publishAnalysis = dependencies.publish ?? (async options =>
    await publishProjectMusicAnalysisArtifact({
      analysis: MusicAnalysisV1Schema.parse(options.analysis),
      project: options.project,
    }));
  const toolVersion = resolveToolVersion(dependencies);
  return {
    inputSchema: MusicOperationInputSchema,
    inputSchemaId: "atet.operation.analysis.music.input/v1",
    kind: "analysis.music",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const snapshot = await openLeasedProjectSnapshot(
          context.application,
          input.project,
        );
        assertAnalysisProjectBinding(context, input.projectBinding, snapshot);
        const publicationBasis = projectAnalysisPublicationBasis(snapshot);
        const project = snapshot.openProject;
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
        const analyzed = await executeAnalysis({
          analysisId: resolveAnalysisId(input.analysisId, dependencies),
          config: input.config ?? DEFAULT_MUSIC_ANALYSIS_CONFIG,
          ffmpeg: analysisCapabilityCommand(
            input.capabilityBindings,
            capabilities,
            "ffmpeg",
          ),
          now: context.application.clock.now(),
          project,
          repositoryRoot: context.application.paths.repositoryRoot,
          runner: analysisCapabilityRunner(
            context.application,
            input.capabilityBindings,
          ),
          source: input.source,
          toolVersion,
        });
        throwIfAborted(context.abortSignal);
        await context.workflow?.beforePublication();
        const published = await publishAnalysis({
          analysis: analyzed.analysis,
          project,
        });
        throwIfAborted(context.abortSignal);
        const merged = await mergeProjectAnalysisReference({
          application: context.application,
          basis: publicationBasis,
          beforePublication: async () => {
            await context.workflow?.beforePublication();
          },
          operation: "analysis.music",
          project: input.project,
          reference: published.reference,
        });
        assertPublishedAnalysisReference(merged.project, merged.reference);
        const tempoChanges = analyzed.analysis.tempoRegions.filter(
          region => region.changeFromPrevious !== null,
        ).length;
        const keyChanges = analyzed.analysis.keyRegions.filter(
          region => region.changeConfidence !== null,
        ).length;
        const output = MusicOperationOutputSchema.parse({
          analysisId: analyzed.analysis.analysisId,
          keyChanges,
          keyRegions: analyzed.analysis.keyRegions.length,
          musicRegions: analyzed.analysis.musicRegions.length,
          path: published.analysisPath,
          projectId: merged.project.projectId,
          reference: merged.reference,
          tempoChanges,
          tempoRegions: analyzed.analysis.tempoRegions.length,
        });
        await writeOperationCompletionCheckpoint(context, {
          inputSchemaId: "atet.operation.analysis.music.input/v1",
          kind: "analysis.music",
          outputSchemaId: "atet.operation.analysis.music.output/v1",
          version: 1,
        }, output);
        return output;
      },
    },
    outputSchema: MusicOperationOutputSchema,
    outputSchemaId: "atet.operation.analysis.music.output/v1",
    policy: {
      cache: "none",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 2 * 60 * 60_000,
      maxFanOut: 1,
      maxInputBytes: 16_384,
      maxOutputBytes: 64 * 1024,
      preparation: ["project-state", "local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "verified-receipt",
    },
    summarize: output => ({
      fields: {
        analysisId: output.analysisId,
        keyRegions: output.keyRegions,
        musicRegions: output.musicRegions,
        path: output.path,
        projectId: output.projectId,
        tempoRegions: output.tempoRegions,
      },
      kind: "analysis.music",
    }),
    version: 1,
  };
}
