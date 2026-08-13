import { z } from "zod";

import {
  AnalysisIdSchema,
  ProjectPlacementIdSchema,
  ProjectAnalysisReferenceSchema,
  ProjectInactivityAnalysisV1Schema,
  ProjectInactivityConfigSchema,
  RecordingIdSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  SourceIntervalSchema,
  VideoProjectIdSchema,
  type ProjectInactivityAnalysisV1,
  type VideoProjectV1,
} from "../../../contracts";
import {
  DEFAULT_PROJECT_INACTIVITY_CONFIG,
  analyzeProjectInactivity,
  loadProjectInactivityReferenceEvidence,
  publishProjectInactivityArtifact,
  type AnalyzeProjectInactivityOptions,
  type ProjectInactivityReferenceEvidence,
  type PublishedProjectInactivityArtifact,
} from "../../../cli/project-inactivity-service";
import {
  canonicalJson,
  canonicalJsonSha256,
} from "../../../core";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
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
  requiredCapabilityVersion,
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
  bindAnalysisCapabilityInput,
  resolveAnalysisId,
  resolveToolVersion,
  type VersionedAnalysisDependencies,
} from "./shared";

interface AnalyzedProjectInactivity {
  readonly analysis: Pick<
    ProjectInactivityAnalysisV1,
    "analysisId" | "projectId" | "referenceRecording" | "result"
  >;
}

type ProjectInactivityExecutor = (
  options: AnalyzeProjectInactivityOptions,
) => Promise<AnalyzedProjectInactivity>;

type ProjectInactivityPublisher = (options: {
  readonly analysis: AnalyzedProjectInactivity["analysis"];
  readonly project: AnalyzeProjectInactivityOptions["project"];
}) => Promise<PublishedProjectInactivityArtifact>;

export interface ProjectInactivityOperationDependencies
  extends VersionedAnalysisDependencies {
  readonly analyze?: ProjectInactivityExecutor;
  readonly publish?: ProjectInactivityPublisher;
}

export const ProjectInactivityOperationInputSchema = z.strictObject({
  analysisId: AnalysisIdSchema.optional(),
  capabilityBindings: AnalysisCapabilityBindingsSchema.optional(),
  config: ProjectInactivityConfigSchema.optional(),
  project: ProjectReferenceSchema,
  projectBinding: AnalysisProjectBindingSchema.optional(),
  recordingBinding: z.strictObject({
    eventsSha256: Sha256Schema,
    eventStreamsSha256: Sha256Schema,
    manifestSha256: Sha256Schema,
    placementId: ProjectPlacementIdSchema,
    recordingId: RecordingIdSchema,
    syncMapSha256: Sha256Schema,
  }).nullable().optional(),
});

export const ProjectInactivityOperationOutputSchema = z.strictObject({
  analysisId: AnalysisIdSchema,
  candidateCount: z.number().int().safe().nonnegative(),
  cuts: z.array(SourceIntervalSchema).max(100_000),
  evidencePath: RepositoryRelativePathSchema,
  projectId: VideoProjectIdSchema,
  protectedInteractionCount: z.number().int().safe().nonnegative(),
  reference: ProjectAnalysisReferenceSchema,
  referenceRecording: RecordingIdSchema.nullable(),
}).superRefine((output, context) => {
  if (output.reference.kind !== "inactivity") {
    context.addIssue({ code: "custom", message: "Expected an inactivity analysis reference.", path: ["reference"] });
    return;
  }
  if (
    output.reference.analysisId !== output.analysisId
    || output.reference.path !== output.evidencePath
    || output.reference.recommendedRanges !== output.cuts.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Inactivity result and authoritative reference disagree.",
      path: ["reference"],
    });
  }
});

export type ProjectInactivityOperationInput = z.infer<
  typeof ProjectInactivityOperationInputSchema
>;

export function projectInactivityRecordingBinding(
  evidence: ProjectInactivityReferenceEvidence,
): ProjectInactivityOperationInput["recordingBinding"] {
  if (evidence.manifest === null) {
    if (
      evidence.referenceRecording !== null
      || evidence.events.length !== 0
    ) {
      throw new ApplicationError(
        "internal",
        "Non-recording inactivity evidence unexpectedly contains recording metadata.",
      );
    }
    return null;
  }
  if (evidence.manifest.state !== "stopped") {
    throw new ApplicationError(
      "conflict",
      "Workflow inactivity analysis requires immutable stopped recording metadata.",
    );
  }
  const reference = evidence.referenceRecording;
  if (
    reference === null
    || reference.recordingId !== evidence.manifest.recordingId
  ) {
    throw new ApplicationError(
      "internal",
      "Inactivity recording evidence disagrees with its manifest identity.",
    );
  }
  return {
    eventsSha256: canonicalJsonSha256(evidence.events),
    eventStreamsSha256: canonicalJsonSha256(evidence.input),
    manifestSha256: canonicalJsonSha256(evidence.manifest),
    placementId: reference.placementId,
    recordingId: reference.recordingId,
    syncMapSha256: reference.syncMapSha256,
  };
}

export async function bindProjectInactivityInput(
  application: ApplicationContext,
  inputValue: unknown,
): Promise<ProjectInactivityOperationInput> {
  const input = ProjectInactivityOperationInputSchema.parse(
    await bindAnalysisCapabilityInput(
      application,
      "analysis.project-inactivity",
      inputValue,
    ),
  );
  const snapshot = await openLeasedProjectSnapshot(
    application,
    input.project,
  );
  assertAnalysisProjectBinding(
    { workflow: {} },
    input.projectBinding,
    snapshot,
  );
  const config = input.config ?? DEFAULT_PROJECT_INACTIVITY_CONFIG;
  const evidence = await loadProjectInactivityReferenceEvidence(
    snapshot.project,
    application.paths.artifactRoot,
    config.cursorMovementThresholdPx,
  );
  return ProjectInactivityOperationInputSchema.parse({
    ...input,
    recordingBinding: projectInactivityRecordingBinding(evidence),
  });
}

function assertRecordingBinding(
  context: { readonly workflow?: unknown },
  expected: ProjectInactivityOperationInput["recordingBinding"],
  evidence: ProjectInactivityReferenceEvidence,
): void {
  if (context.workflow !== undefined && expected === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Workflow inactivity analysis requires exact recording metadata bindings.",
    );
  }
  if (
    expected !== undefined
    && canonicalJson(expected)
      !== canonicalJson(projectInactivityRecordingBinding(evidence))
  ) {
    throw new ApplicationError(
      "conflict",
      "Reference recording metadata changed after inactivity analysis planning.",
    );
  }
}
export interface ProjectInactivityOperationOutput {
  readonly analysisId: ProjectInactivityAnalysisV1["analysisId"];
  readonly candidateCount: number;
  readonly cuts: ProjectInactivityAnalysisV1["result"]["recommendedRanges"];
  readonly evidencePath: string;
  readonly projectId: ProjectInactivityAnalysisV1["projectId"];
  readonly protectedInteractionCount: number;
  readonly reference: VideoProjectV1["analyses"][number];
  readonly referenceRecording: ProjectInactivityAnalysisV1["referenceRecording"] extends null
    ? never
    : NonNullable<ProjectInactivityAnalysisV1["referenceRecording"]>["recordingId"] | null;
}

export function createProjectInactivityOperationDefinition(
  dependencies: ProjectInactivityOperationDependencies,
): OperationDefinition<
  "analysis.project-inactivity",
  ProjectInactivityOperationInput,
  ProjectInactivityOperationOutput
> {
  const executeAnalysis = dependencies.analyze ?? analyzeProjectInactivity;
  const publishAnalysis = dependencies.publish ?? (async options =>
    await publishProjectInactivityArtifact({
      analysis: ProjectInactivityAnalysisV1Schema.parse(options.analysis),
      project: options.project,
    }));
  const toolVersion = resolveToolVersion(dependencies);
  return {
    inputSchema: ProjectInactivityOperationInputSchema,
    inputSchemaId: "studio.operation.analysis.project-inactivity.input/v1",
    kind: "analysis.project-inactivity",
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
          ["ffmpeg", "ffprobe"],
        );
        await assertAnalysisCapabilityBindings(
          context,
          input.capabilityBindings,
          context.application,
          ["ffmpeg", "ffprobe"],
        );
        const config = input.config ?? DEFAULT_PROJECT_INACTIVITY_CONFIG;
        const referenceEvidence =
          await loadProjectInactivityReferenceEvidence(
            snapshot.project,
            context.application.paths.artifactRoot,
            config.cursorMovementThresholdPx,
          );
        assertRecordingBinding(
          context,
          input.recordingBinding,
          referenceEvidence,
        );
        const analyzed = await executeAnalysis({
          analysisId: resolveAnalysisId(input.analysisId, dependencies),
          artifactRoot: context.application.paths.artifactRoot,
          config,
          ffmpeg: analysisCapabilityCommand(
            input.capabilityBindings,
            capabilities,
            "ffmpeg",
          ),
          ffmpegVersion: requiredCapabilityVersion(capabilities, "ffmpeg"),
          ffprobe: analysisCapabilityCommand(
            input.capabilityBindings,
            capabilities,
            "ffprobe",
          ),
          now: context.application.clock.now(),
          project,
          referenceEvidence,
          repositoryRoot: context.application.paths.repositoryRoot,
          runner: analysisCapabilityRunner(
            context.application,
            input.capabilityBindings,
          ),
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
          operation: "analysis.project-inactivity",
          project: input.project,
          reference: published.reference,
        });
        assertPublishedAnalysisReference(merged.project, merged.reference);
        const output = ProjectInactivityOperationOutputSchema.parse({
          analysisId: analyzed.analysis.analysisId,
          candidateCount: analyzed.analysis.result.candidateCount,
          cuts: analyzed.analysis.result.recommendedRanges,
          evidencePath: published.analysisPath,
          projectId: analyzed.analysis.projectId,
          protectedInteractionCount: analyzed.analysis.result.protectedInteractionCount,
          reference: merged.reference,
          referenceRecording: analyzed.analysis.referenceRecording?.recordingId ?? null,
        });
        await writeOperationCompletionCheckpoint(context, {
          inputSchemaId:
            "studio.operation.analysis.project-inactivity.input/v1",
          kind: "analysis.project-inactivity",
          outputSchemaId:
            "studio.operation.analysis.project-inactivity.output/v1",
          version: 1,
        }, output);
        return output;
      },
    },
    outputSchema: ProjectInactivityOperationOutputSchema,
    outputSchemaId: "studio.operation.analysis.project-inactivity.output/v1",
    policy: {
      cache: "none",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 2 * 60 * 60_000,
      maxFanOut: 1,
      maxInputBytes: 16_384,
      maxOutputBytes: 8 * 1024 * 1024,
      preparation: ["project-state", "recording-metadata", "local-media"],
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
        candidateCount: output.candidateCount,
        cuts: output.cuts.length,
        evidencePath: output.evidencePath,
        projectId: output.projectId,
      },
      kind: "analysis.project-inactivity",
    }),
    version: 1,
  };
}
