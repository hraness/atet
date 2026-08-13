import { z } from "zod";

import {
  AnalysisIdSchema,
  FaceAnalysisBackendSchema,
  FaceAnalysisConfigSchema,
  FaceAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  RepositoryRelativePathSchema,
  VideoProjectIdSchema,
  type FaceAnalysisV1,
} from "../../../contracts";
import {
  DEFAULT_FACE_ANALYSIS_CONFIG,
  analyzeProjectFaces,
  publishProjectFaceAnalysisArtifact,
  type AnalyzeProjectFacesOptions,
  type PublishedProjectFaceAnalysisArtifact,
} from "../../../cli/face-analysis-service";
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
  type AnalysisIdDependencies,
} from "./shared";

interface AnalyzedProjectFaces {
  readonly analysis: Pick<
    FaceAnalysisV1,
    "analysisId" | "backend" | "coverage" | "privacy" | "tracks"
  >;
}

type FaceAnalysisExecutor = (
  options: AnalyzeProjectFacesOptions,
) => Promise<AnalyzedProjectFaces>;

type FaceAnalysisPublisher = (options: {
  readonly analysis: AnalyzedProjectFaces["analysis"];
  readonly project: AnalyzeProjectFacesOptions["project"];
}) => Promise<PublishedProjectFaceAnalysisArtifact>;

export interface FacesOperationDependencies extends AnalysisIdDependencies {
  readonly analyze?: FaceAnalysisExecutor;
  readonly publish?: FaceAnalysisPublisher;
}

const FacePrivacySchema = z.strictObject({
  biometricIdentification: z.literal("not-performed"),
  execution: z.literal("local-only"),
  storedEvidence: z.literal("bounding-boxes-only"),
  tracking: z.literal("geometry-continuity-only"),
});

export const FacesOperationInputSchema = z.strictObject({
  analysisId: AnalysisIdSchema.optional(),
  capabilityBindings: AnalysisCapabilityBindingsSchema.optional(),
  config: FaceAnalysisConfigSchema.optional(),
  project: ProjectReferenceSchema,
  projectBinding: AnalysisProjectBindingSchema.optional(),
  source: z.string().min(1).max(256),
});

export const FacesOperationOutputSchema = z.strictObject({
  analysisId: AnalysisIdSchema,
  analyzedFrames: z.number().int().safe().nonnegative().max(250_000),
  backend: FaceAnalysisBackendSchema,
  localOnly: z.literal(true),
  path: RepositoryRelativePathSchema,
  privacy: FacePrivacySchema,
  projectId: VideoProjectIdSchema,
  reference: ProjectAnalysisReferenceSchema,
  source: z.string().min(1).max(256),
  tracks: z.number().int().safe().nonnegative().max(100_000),
}).superRefine((output, context) => {
  if (output.reference.kind !== "faces") {
    context.addIssue({ code: "custom", message: "Expected a face analysis reference.", path: ["reference"] });
    return;
  }
  if (
    output.reference.analysisId !== output.analysisId
    || output.reference.path !== output.path
    || output.reference.analyzedFrames !== output.analyzedFrames
    || output.reference.trackCount !== output.tracks
  ) {
    context.addIssue({
      code: "custom",
      message: "Face result and authoritative reference disagree.",
      path: ["reference"],
    });
  }
});

export type FacesOperationInput = z.infer<typeof FacesOperationInputSchema>;
export type FacesOperationOutput = z.infer<typeof FacesOperationOutputSchema>;

export function createFacesOperationDefinition(
  dependencies: FacesOperationDependencies,
): OperationDefinition<
  "analysis.faces",
  FacesOperationInput,
  FacesOperationOutput
> {
  const executeAnalysis = dependencies.analyze ?? analyzeProjectFaces;
  const publishAnalysis = dependencies.publish ?? (async options =>
    await publishProjectFaceAnalysisArtifact({
      analysis: FaceAnalysisV1Schema.parse(options.analysis),
      project: options.project,
    }));
  return {
    inputSchema: FacesOperationInputSchema,
    inputSchemaId: "studio.operation.analysis.faces.input/v1",
    kind: "analysis.faces",
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
          ["face-analyzer", "ffprobe"],
        );
        await assertAnalysisCapabilityBindings(
          context,
          input.capabilityBindings,
          context.application,
          ["face-analyzer", "ffprobe"],
        );
        const analyzed = await executeAnalysis({
          analysisId: resolveAnalysisId(input.analysisId, dependencies),
          config: input.config ?? DEFAULT_FACE_ANALYSIS_CONFIG,
          faceAnalyzer: analysisCapabilityCommand(
            input.capabilityBindings,
            capabilities,
            "face-analyzer",
          ),
          ffprobe: analysisCapabilityCommand(
            input.capabilityBindings,
            capabilities,
            "ffprobe",
          ),
          now: context.application.clock.now(),
          project,
          repositoryRoot: context.application.paths.repositoryRoot,
          runner: analysisCapabilityRunner(
            context.application,
            input.capabilityBindings,
          ),
          source: input.source,
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
          operation: "analysis.faces",
          project: input.project,
          reference: published.reference,
        });
        assertPublishedAnalysisReference(merged.project, merged.reference);
        const output = FacesOperationOutputSchema.parse({
          analysisId: analyzed.analysis.analysisId,
          analyzedFrames: analyzed.analysis.coverage.analyzedFrames,
          backend: analyzed.analysis.backend,
          localOnly: true,
          path: published.analysisPath,
          privacy: analyzed.analysis.privacy,
          projectId: merged.project.projectId,
          reference: merged.reference,
          source: input.source,
          tracks: analyzed.analysis.tracks.length,
        });
        await writeOperationCompletionCheckpoint(context, {
          inputSchemaId: "studio.operation.analysis.faces.input/v1",
          kind: "analysis.faces",
          outputSchemaId: "studio.operation.analysis.faces.output/v1",
          version: 1,
        }, output);
        return output;
      },
    },
    outputSchema: FacesOperationOutputSchema,
    outputSchemaId: "studio.operation.analysis.faces.output/v1",
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
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "vision" },
      ],
      resume: "verified-receipt",
    },
    summarize: output => ({
      fields: {
        analysisId: output.analysisId,
        analyzedFrames: output.analyzedFrames,
        localOnly: output.localOnly,
        path: output.path,
        projectId: output.projectId,
        tracks: output.tracks,
      },
      kind: "analysis.faces",
    }),
    version: 1,
  };
}
