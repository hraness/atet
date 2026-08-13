import { z } from "zod";

import {
  AutomaticZoomPlannerConfigSchema,
  ProjectPlacementIdSchema,
  ProjectZoomOperationSchema,
  RecordingIdSchema,
  RecordingManifestV1Schema,
  Sha256Schema,
  VideoProjectIdSchema,
  type RecordingEventV1,
  type RecordingManifestV1,
} from "../../../contracts";
import {
  canonicalJsonSha256,
  hashPlacementSync,
  mapAssetIntervalToProjectSlices,
  mapAutomaticZoomsToProject,
  planAutomaticZooms,
} from "../../../core";
import {
  loadRecordingEvents,
  openRecording,
  type OpenRecording,
} from "../../../cli/bundle-service";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { openLeasedProjectSnapshot } from "../../project-publication-lease";
import {
  assertProjectEditBasis,
  ProjectEditBasisSchema,
  ProjectGenerationHashesSchema,
  type OpenProjectSnapshot,
} from "../../project-store";
import {
  ProjectReferenceSchema,
  throwIfAborted,
} from "../shared";

export const DEFAULT_PROJECT_AUTO_ZOOM_CONFIG =
  AutomaticZoomPlannerConfigSchema.parse({
    enterDurationUs: 300_000,
    exitDurationUs: 300_000,
    intentMergeGapUs: 750_000,
    maxDurationUs: 8_000_000,
    maxScale: 3,
    minDurationUs: 1_500_000,
    postHandleUs: 1_000_000,
    preHandleUs: 500_000,
    scale: 2,
  });

export const ProjectAutoZoomBindingSchema = z.strictObject({
  projectBinding: ProjectEditBasisSchema,
  recordingId: RecordingIdSchema,
  recordingManifestSha256: Sha256Schema,
  sourcePlacementId: ProjectPlacementIdSchema,
  syncSha256: Sha256Schema,
});

export const ProjectAutoZoomInputSchema = z.strictObject({
  binding: ProjectAutoZoomBindingSchema.optional(),
  config: AutomaticZoomPlannerConfigSchema.optional(),
  project: ProjectReferenceSchema,
  sourcePlacement: ProjectPlacementIdSchema.optional(),
});

export const ProjectAutoZoomOutputSchema = z.strictObject({
  generation: ProjectGenerationHashesSchema,
  operations: z.array(ProjectZoomOperationSchema).max(10_000),
  projectId: VideoProjectIdSchema,
  recordingId: RecordingIdSchema,
  recordingManifestSha256: Sha256Schema,
  sourcePlacementId: ProjectPlacementIdSchema,
  sourceZoomCount: z.number().int().safe().nonnegative().max(10_000),
  syncSha256: Sha256Schema,
  unmappedSourceZoomCount: z.number().int().safe().nonnegative().max(10_000),
});

export type ProjectAutoZoomInput = z.infer<typeof ProjectAutoZoomInputSchema>;
export type ProjectAutoZoomOutput = z.infer<typeof ProjectAutoZoomOutputSchema>;
export type ProjectAutoZoomBinding = z.infer<typeof ProjectAutoZoomBindingSchema>;

interface ProjectAutoZoomSubject {
  readonly binding: ProjectAutoZoomBinding;
  readonly manifest: RecordingManifestV1;
  readonly placement: OpenProjectSnapshot["project"]["placements"][number];
  readonly recording: OpenRecording;
  readonly snapshot: OpenProjectSnapshot;
}

async function resolveSubject(
  application: ApplicationContext,
  input: ProjectAutoZoomInput,
): Promise<ProjectAutoZoomSubject> {
  const snapshot = await openLeasedProjectSnapshot(
    application,
    input.project,
  );
  const placementId = input.sourcePlacement
    ?? snapshot.plan.effects.metadataPlacementId
    ?? snapshot.project.referencePlacementId;
  const placement = snapshot.project.placements.find(
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
      `Project metadata placement is disabled: ${placement.placementId}`,
    );
  }
  if (placement.sync.provenance.kind === "unverified") {
    throw new ApplicationError(
      "conflict",
      `Project metadata placement has unverified synchronization: ${placement.placementId}`,
    );
  }
  const asset = snapshot.project.assets.find(
    candidate => candidate.assetId === placement.assetId,
  );
  if (asset?.source.kind !== "recording") {
    throw new ApplicationError(
      "conflict",
      `Placement ${placement.placementId} is not backed by a Transmute recording.`,
    );
  }
  const recording = await openRecording(
    application.paths.artifactRoot,
    asset.source.recordingId,
  );
  const manifest = RecordingManifestV1Schema.parse(recording.manifest);
  if (manifest.state !== "stopped") {
    throw new ApplicationError(
      "conflict",
      "Project automatic zoom requires an immutable stopped recording.",
    );
  }
  return {
    binding: ProjectAutoZoomBindingSchema.parse({
      projectBinding: snapshot.editBasis,
      recordingId: manifest.recordingId,
      recordingManifestSha256: canonicalJsonSha256(manifest),
      sourcePlacementId: placement.placementId,
      syncSha256: hashPlacementSync(placement),
    }),
    manifest,
    placement,
    recording,
    snapshot,
  };
}

export async function bindProjectAutoZoomInput(
  application: ApplicationContext,
  inputValue: unknown,
): Promise<ProjectAutoZoomInput> {
  const input = ProjectAutoZoomInputSchema.parse(inputValue);
  const subject = await resolveSubject(application, input);
  return ProjectAutoZoomInputSchema.parse({
    ...input,
    binding: subject.binding,
    sourcePlacement: subject.placement.placementId,
  });
}

export interface ProjectAutoZoomOperationDependencies {
  readonly loadEvents?: (
    recording: OpenRecording,
  ) => Promise<readonly RecordingEventV1[]>;
}

export function createProjectAutoZoomOperationDefinition(
  dependencies: ProjectAutoZoomOperationDependencies = {},
): OperationDefinition<
  "analysis.project-auto-zooms",
  ProjectAutoZoomInput,
  ProjectAutoZoomOutput
> {
  const loadEvents = dependencies.loadEvents ?? loadRecordingEvents;
  return {
    inputSchema: ProjectAutoZoomInputSchema,
    inputSchemaId: "studio.operation.analysis.project-auto-zooms.input/v1",
    kind: "analysis.project-auto-zooms",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        if (input.binding === undefined) {
          throw new ApplicationError(
            "unsupported-plan",
            "Project automatic zoom execution requires a host-bound exact input.",
          );
        }
        const subject = await resolveSubject(context.application, input);
        const {
          projectBinding: currentProjectBinding,
          ...currentRecordingBinding
        } = subject.binding;
        assertProjectEditBasis(
          currentProjectBinding,
          subject.snapshot,
        );
        const {
          projectBinding: plannedProjectBinding,
          ...plannedRecordingBinding
        } = input.binding;
        if (
          canonicalJsonSha256(currentRecordingBinding)
          !== canonicalJsonSha256(plannedRecordingBinding)
        ) {
          throw new ApplicationError(
            "conflict",
            "Project automatic zoom bindings changed after node planning.",
          );
        }
        assertProjectEditBasis(
          plannedProjectBinding,
          subject.snapshot,
        );
        const events = await loadEvents(subject.recording);
        throwIfAborted(context.abortSignal);
        const sourceZooms = planAutomaticZooms(
          events,
          subject.manifest.timeline.durationUs,
          input.config ?? DEFAULT_PROJECT_AUTO_ZOOM_CONFIG,
        );
        const operations = mapAutomaticZoomsToProject(
          subject.placement,
          sourceZooms,
        );
        const unmappedSourceZoomCount = sourceZooms.filter(zoom => (
          mapAssetIntervalToProjectSlices(
            subject.placement,
            zoom.range,
          ).length === 0
        )).length;
        const finalSnapshot = await openLeasedProjectSnapshot(
          context.application,
          subject.snapshot.project.projectId,
        );
        assertProjectEditBasis(
          subject.snapshot.editBasis,
          finalSnapshot,
        );
        return {
          generation: subject.snapshot.generation,
          operations: [...operations],
          projectId: subject.snapshot.project.projectId,
          recordingId: subject.binding.recordingId,
          recordingManifestSha256: subject.binding.recordingManifestSha256,
          sourcePlacementId: subject.placement.placementId,
          sourceZoomCount: sourceZooms.length,
          syncSha256: subject.binding.syncSha256,
          unmappedSourceZoomCount,
        };
      },
    },
    outputSchema: ProjectAutoZoomOutputSchema,
    outputSchemaId: "studio.operation.analysis.project-auto-zooms.output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "local-read",
      maxDurationMs: 2 * 60_000,
      maxFanOut: 1,
      maxInputBytes: 32_768,
      maxOutputBytes: 16 * 1024 * 1024,
      preparation: [
        "project-state",
        "recording-metadata",
        "typed-text",
        "window-metadata",
      ],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "deterministic",
    },
    summarize: output => ({
      fields: {
        operations: output.operations.length,
        projectId: output.projectId,
        recordingId: output.recordingId,
        sourcePlacementId: output.sourcePlacementId,
        sourceZooms: output.sourceZoomCount,
      },
      kind: "analysis.project-auto-zooms",
    }),
    version: 1,
  };
}

export const projectAutoZoomOperationDefinition =
  createProjectAutoZoomOperationDefinition();
