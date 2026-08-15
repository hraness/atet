import {
  lstat,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

import { z } from "zod";

import {
  ProjectAssetIdSchema,
  ProjectCaptionRequestSchema,
  ProjectPlacementIdSchema,
  ProjectStreamIdSchema,
  RecordingIdSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  SpeechAnalysisV1Schema,
  type ProjectCaptionRequest,
  type ProjectRenderPlanV1,
  type SpeechAnalysisV1,
  type VideoProjectV1,
} from "../../../contracts";
import {
  assertProjectRenderPlanComposition,
  canonicalJson,
  canonicalJsonSha256,
  compileProjectCaptionCues,
  compileProjectRenderPlan,
  createNodeBundleFileSystem,
  hashPlacementSync,
  hashProjectStructure,
  sha256Hex,
  type BundleFileSystem,
  type ProjectMetadataContext,
  type ProjectRenderSettings,
} from "../../../core";
import {
  loadRecordingEvents,
  openRecording,
} from "../../../cli/bundle-service";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import {
  ProjectEditRevisionDocumentSchema,
  ProjectEditRevisionRenderInputSchema,
  ProjectRenderPlanDocumentSchema,
  ProjectRenderPlanReferenceSchema,
  RenderableProjectEditRevisionReferenceSchema,
  type ProjectEditRevisionDocument,
  type ProjectEditRevisionRenderInput,
  type ProjectRenderPlanDocument,
  type ProjectRenderPlanReference,
  type RenderableProjectEditRevisionReference,
} from "../../receipts";
import { throwIfAborted } from "../shared";
import {
  prepareProjectCaptionPlan,
  type PreparedProjectCaptionArtifact,
  type PreparedProjectCaptionPlan,
} from "./project-caption-plan";

const MAXIMUM_PROJECT_RENDER_PLAN_BYTES = 256 * 1024 * 1024;

export const ProjectRenderSettingsSchema = z.strictObject({
  background: z.string().regex(/^#[0-9a-fA-F]{8}$/u).optional(),
  frameRate: z.number().finite().positive().max(240).optional(),
});

export const ProjectRenderSettingsV2Schema = ProjectRenderSettingsSchema.extend({
  captions: ProjectCaptionRequestSchema,
}).strict();

export const ProjectCaptionBindingSchema = z.strictObject({
  analysisId: ProjectCaptionRequestSchema.shape.analysisId,
  analysisPath: RepositoryRelativePathSchema,
  analysisSha256: Sha256Schema,
  assetId: ProjectAssetIdSchema,
  placementId: ProjectPlacementIdSchema,
  placementSyncSha256: Sha256Schema,
  streamId: ProjectStreamIdSchema,
  subjectIntegritySha256: Sha256Schema,
  wordCount: z.number().int().safe().positive().max(1_000_000),
});

export const ProjectRenderMetadataBindingSchema = z.strictObject({
  eventsSha256: Sha256Schema,
  manifestSha256: Sha256Schema,
  placementId: ProjectPlacementIdSchema,
  recordingId: RecordingIdSchema,
});

export const ProjectRenderPlanInputSchema = z.strictObject({
  metadataBindings: z.array(ProjectRenderMetadataBindingSchema).max(256).optional(),
  revision: ProjectEditRevisionRenderInputSchema,
  settings: ProjectRenderSettingsSchema.optional(),
}).superRefine((input, context) => {
  if (input.metadataBindings === undefined) return;
  for (let index = 0; index < input.metadataBindings.length; index += 1) {
    const current = input.metadataBindings[index]!;
    const previous = input.metadataBindings[index - 1];
    if (
      previous !== undefined
      && previous.placementId.localeCompare(current.placementId) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Render metadata bindings must have unique sorted placement IDs.",
        path: ["metadataBindings", index, "placementId"],
      });
    }
  }
});

export const ProjectRenderPlanInputV2Schema = z.strictObject({
  captionBinding: ProjectCaptionBindingSchema.optional(),
  metadataBindings: z.array(ProjectRenderMetadataBindingSchema).max(256).optional(),
  revision: ProjectEditRevisionRenderInputSchema,
  settings: ProjectRenderSettingsV2Schema,
}).superRefine((input, context) => {
  if (input.metadataBindings === undefined) return;
  for (let index = 0; index < input.metadataBindings.length; index += 1) {
    const current = input.metadataBindings[index]!;
    const previous = input.metadataBindings[index - 1];
    if (
      previous !== undefined
      && previous.placementId.localeCompare(current.placementId) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Render metadata bindings must have unique sorted placement IDs.",
        path: ["metadataBindings", index, "placementId"],
      });
    }
  }
});

export const ProjectRenderPlanOutputSchema = ProjectRenderPlanReferenceSchema;

export type ProjectRenderPlanInput = z.infer<
  typeof ProjectRenderPlanInputSchema
>;
export type ProjectRenderPlanInputV2 = z.infer<
  typeof ProjectRenderPlanInputV2Schema
>;
export type ProjectRenderPlanOutput = ProjectRenderPlanReference;

export function hashProjectCaptionSource(input: {
  readonly binding: z.infer<typeof ProjectCaptionBindingSchema>;
  readonly output: ProjectRenderPlanV1["output"];
  readonly projectEditPlanSha256: string;
  readonly revisionSha256: string;
  readonly style: ProjectCaptionRequest["style"];
}): string {
  return canonicalJsonSha256({
    ...input,
    domain: "transmute.social-caption-source/v1",
  });
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

export async function exactProjectDirectory(
  application: ApplicationContext,
  projectId: string,
): Promise<string> {
  let root: string;
  try {
    root = await realpath(application.paths.projectRoot);
  } catch {
    throw new ApplicationError(
      "not-found",
      "The project root does not exist.",
    );
  }
  const requested = join(root, projectId);
  let details;
  try {
    details = await lstat(requested);
  } catch {
    throw new ApplicationError("not-found", `Project does not exist: ${projectId}`);
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new ApplicationError(
      "unsafe-path",
      `Project must be a physical directory: ${projectId}`,
    );
  }
  const directory = await realpath(requested);
  if (!isWithin(root, directory) || directory === root) {
    throw new ApplicationError(
      "unsafe-path",
      `Project directory escapes the configured project root: ${projectId}`,
    );
  }
  return directory;
}

export function renderableProjectEditRevisionReference(
  input: ProjectEditRevisionRenderInput,
): RenderableProjectEditRevisionReference {
  return RenderableProjectEditRevisionReferenceSchema.parse({
    artifact: input.artifact,
    baseGeneration: input.baseGeneration,
    kind: input.kind,
    outputGeometrySha256: input.outputGeometrySha256,
    pixelHeight: input.pixelHeight,
    pixelWidth: input.pixelWidth,
    planId: input.planId,
    projectEditPlanSha256: input.projectEditPlanSha256,
    projectId: input.projectId,
    projectSha256: input.projectSha256,
    projectStructureSha256: input.projectStructureSha256,
    revisionSha256: input.revisionSha256,
    schemaVersion: input.schemaVersion,
  });
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApplicationError("invalid-data", `${label} is not valid JSON.`);
  }
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export async function loadExactProjectEditRevision(
  application: ApplicationContext,
  input: ProjectEditRevisionRenderInput,
): Promise<{
  readonly directory: string;
  readonly document: ProjectEditRevisionDocument;
  readonly fileSystem: BundleFileSystem;
  readonly reference: RenderableProjectEditRevisionReference;
}> {
  const reference = renderableProjectEditRevisionReference(input);
  const directory = await exactProjectDirectory(
    application,
    reference.projectId,
  );
  const fileSystem = createNodeBundleFileSystem(directory);
  const text = await fileSystem.readText(reference.artifact.path);
  if (
    utf8Bytes(text) !== reference.artifact.bytes
    || sha256Hex(text) !== reference.artifact.sha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Immutable project edit revision artifact failed its byte and SHA-256 identity.",
    );
  }
  const document = ProjectEditRevisionDocumentSchema.parse(
    parseJson(text, "Project edit revision artifact"),
  );
  if (text !== `${canonicalJson(document)}\n`) {
    throw new ApplicationError(
      "conflict",
      "Immutable project edit revision artifact is not its canonical document.",
    );
  }
  if (
    document.project.projectId !== reference.projectId
    || document.projectEditPlan.planId !== reference.planId
    || document.projectSha256 !== reference.projectSha256
    || document.projectEditPlanSha256 !== reference.projectEditPlanSha256
    || document.revisionSha256 !== reference.revisionSha256
    || hashProjectStructure(document.project)
      !== reference.projectStructureSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Immutable project edit revision reference does not match its frozen documents.",
    );
  }
  return { directory, document, fileSystem, reference };
}

function renderSettings(
  input: z.infer<typeof ProjectRenderSettingsSchema> | undefined,
  reference: RenderableProjectEditRevisionReference,
  metadata: readonly ProjectMetadataContext[],
): ProjectRenderSettings {
  return {
    ...(input?.background === undefined ? {} : { background: input.background }),
    ...(input?.frameRate === undefined ? {} : { frameRate: input.frameRate }),
    metadata,
    pixelHeight: reference.pixelHeight,
    pixelWidth: reference.pixelWidth,
  };
}

async function projectMetadata(
  artifactRoot: string,
  project: VideoProjectV1,
  plan: ProjectEditRevisionDocument["projectEditPlan"],
): Promise<{
  readonly bindings: readonly z.infer<typeof ProjectRenderMetadataBindingSchema>[];
  readonly contexts: readonly ProjectMetadataContext[];
}> {
  const placementIds = new Set<string>(
    plan.zooms.map(zoom => zoom.placementId),
  );
  if (
    (
      plan.effects.clicks.enabled
      || plan.effects.cursor.enabled
      || plan.effects.keystrokes.enabled
      || plan.effects.typedText.enabled
    )
    && plan.effects.metadataPlacementId !== null
  ) {
    placementIds.add(plan.effects.metadataPlacementId);
  }
  const loaded = await Promise.all([...placementIds].sort().map(async placementId => {
    const placement = project.placements.find(
      candidate => candidate.placementId === placementId,
    );
    if (placement === undefined) {
      throw new ApplicationError(
        "not-found",
        `Unknown project metadata placement: ${placementId}`,
      );
    }
    const asset = project.assets.find(
      candidate => candidate.assetId === placement.assetId,
    );
    if (asset?.source.kind !== "recording") {
      throw new ApplicationError(
        "conflict",
        `Placement ${placement.placementId} is not backed by a Atet recording with window and input metadata.`,
      );
    }
    const recording = await openRecording(artifactRoot, asset.source.recordingId);
    const events = await loadRecordingEvents(recording);
    return {
      binding: ProjectRenderMetadataBindingSchema.parse({
        eventsSha256: canonicalJsonSha256(events),
        manifestSha256: canonicalJsonSha256(recording.manifest),
        placementId: placement.placementId,
        recordingId: asset.source.recordingId,
      }),
      context: {
        events,
        manifest: recording.manifest,
        placementId: placement.placementId,
      },
    };
  }));
  return {
    bindings: loaded.map(item => item.binding),
    contexts: loaded.map(item => item.context),
  };
}

interface LoadedProjectCaptions {
  readonly analysis: SpeechAnalysisV1;
  readonly binding: z.infer<typeof ProjectCaptionBindingSchema>;
}

async function projectCaptions(
  revision: Awaited<ReturnType<typeof loadExactProjectEditRevision>>,
  requestInput: ProjectCaptionRequest,
): Promise<LoadedProjectCaptions> {
  const request = ProjectCaptionRequestSchema.parse(requestInput);
  const project = revision.document.project;
  const reference = project.analyses.find(candidate => (
    candidate.kind === "speech"
    && candidate.analysisId === request.analysisId
  ));
  if (reference === undefined || reference.kind !== "speech") {
    throw new ApplicationError(
      "not-found",
      `Unknown project speech analysis: ${request.analysisId}`,
    );
  }
  const placement = project.placements.find(candidate => (
    candidate.placementId === request.placementId
  ));
  if (placement === undefined) {
    throw new ApplicationError(
      "not-found",
      `Unknown caption placement: ${request.placementId}`,
    );
  }
  if (!placement.enabled || placement.assetId !== reference.assetId) {
    throw new ApplicationError(
      "conflict",
      "Caption placement must be enabled and contain the analyzed audio asset.",
    );
  }
  const configuredAudio = placement.audio.find(candidate => (
    candidate.streamId === reference.streamId
  ));
  if (configuredAudio?.presentation.enabled !== true) {
    throw new ApplicationError(
      "conflict",
      "Caption source audio must be enabled and audible on the selected placement.",
    );
  }
  const asset = project.assets.find(candidate => (
    candidate.assetId === reference.assetId
  ));
  const stream = asset?.streams.find(candidate => (
    candidate.streamId === reference.streamId
  ));
  if (asset === undefined || stream?.kind !== "audio") {
    throw new ApplicationError(
      "conflict",
      "Caption speech analysis no longer identifies a project audio stream.",
    );
  }

  let text: string;
  let analysis: SpeechAnalysisV1;
  try {
    text = await revision.fileSystem.readText(reference.path);
    analysis = SpeechAnalysisV1Schema.parse(
      parseJson(text, "Speech analysis artifact"),
    );
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "invalid-data",
      `Speech analysis ${reference.analysisId} is unreadable or invalid.`,
    );
  }
  if (
    text !== `${canonicalJson(analysis)}\n`
    || sha256Hex(text) !== reference.sha256
    || analysis.analysisId !== reference.analysisId
    || analysis.subject.assetId !== reference.assetId
    || analysis.subject.streamId !== reference.streamId
    || analysis.durationUs !== asset.durationUs
  ) {
    throw new ApplicationError(
      "conflict",
      `Speech analysis ${reference.analysisId} is stale or failed its exact identity check.`,
    );
  }
  const subjectIntegritySha256 = canonicalJsonSha256({
    assetDurationUs: asset.durationUs,
    stream,
  });
  if (analysis.subject.integritySha256 !== subjectIntegritySha256) {
    throw new ApplicationError(
      "conflict",
      `Speech analysis ${reference.analysisId} no longer matches its audio stream.`,
    );
  }
  if (
    analysis.result.status !== "transcribed"
    || analysis.result.words.length === 0
  ) {
    throw new ApplicationError(
      "unsupported-plan",
      "Caption export requires a speech analysis with timed words.",
    );
  }
  if (
    reference.wordCount !== analysis.result.words.length
    || reference.fillerCount !== analysis.result.fillers.length
  ) {
    throw new ApplicationError(
      "invalid-data",
      `Speech analysis reference ${reference.analysisId} disagrees with its artifact counts.`,
    );
  }
  return {
    analysis,
    binding: ProjectCaptionBindingSchema.parse({
      analysisId: reference.analysisId,
      analysisPath: reference.path,
      analysisSha256: reference.sha256,
      assetId: reference.assetId,
      placementId: placement.placementId,
      placementSyncSha256: hashPlacementSync(placement),
      streamId: reference.streamId,
      subjectIntegritySha256,
      wordCount: analysis.result.words.length,
    }),
  };
}

export async function bindProjectRenderPlanInput(
  application: ApplicationContext,
  input: unknown,
): Promise<ProjectRenderPlanInput> {
  const parsed = ProjectRenderPlanInputSchema.parse(input);
  const revision = await loadExactProjectEditRevision(
    application,
    parsed.revision,
  );
  const metadata = await projectMetadata(
    application.paths.artifactRoot,
    revision.document.project,
    revision.document.projectEditPlan,
  );
  return ProjectRenderPlanInputSchema.parse({
    ...parsed,
    metadataBindings: metadata.bindings,
  });
}

export async function bindProjectRenderPlanInputV2(
  application: ApplicationContext,
  input: unknown,
): Promise<ProjectRenderPlanInputV2> {
  const parsed = ProjectRenderPlanInputV2Schema.parse(input);
  const revision = await loadExactProjectEditRevision(
    application,
    parsed.revision,
  );
  const [metadata, captions] = await Promise.all([
    projectMetadata(
      application.paths.artifactRoot,
      revision.document.project,
      revision.document.projectEditPlan,
    ),
    projectCaptions(revision, parsed.settings.captions),
  ]);
  return ProjectRenderPlanInputV2Schema.parse({
    ...parsed,
    captionBinding: captions.binding,
    metadataBindings: metadata.bindings,
  });
}

function projectRenderPlanDocument(
  plan: ProjectRenderPlanV1,
  revision: ProjectEditRevisionDocument,
  reference: RenderableProjectEditRevisionReference,
): ProjectRenderPlanDocument {
  return ProjectRenderPlanDocumentSchema.parse({
    kind: "atet.project-render-plan-document",
    outputGeometrySha256: reference.outputGeometrySha256,
    plan: assertProjectRenderPlanComposition(plan),
    projectEditPlanSha256: revision.projectEditPlanSha256,
    projectSha256: revision.projectSha256,
    renderPlanSha256: canonicalJsonSha256(plan),
    revisionSha256: revision.revisionSha256,
    schemaVersion: 1,
  });
}

export async function loadExactProjectRenderPlan(
  application: ApplicationContext,
  referenceInput: ProjectRenderPlanReference,
): Promise<{
  readonly directory: string;
  readonly document: ProjectRenderPlanDocument;
  readonly fileSystem: BundleFileSystem;
  readonly reference: ProjectRenderPlanReference;
}> {
  const reference = ProjectRenderPlanReferenceSchema.parse(referenceInput);
  const directory = await exactProjectDirectory(
    application,
    reference.projectId,
  );
  const fileSystem = createNodeBundleFileSystem(directory);
  const text = await fileSystem.readText(reference.artifact.path);
  if (
    utf8Bytes(text) !== reference.artifact.bytes
    || sha256Hex(text) !== reference.artifact.sha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Immutable project render plan artifact failed its byte and SHA-256 identity.",
    );
  }
  const document = ProjectRenderPlanDocumentSchema.parse(
    parseJson(text, "Project render plan artifact"),
  );
  if (
    text !== `${canonicalJson(document)}\n`
    || document.plan.projectId !== reference.projectId
    || document.plan.planSha256 !== reference.planSha256
    || document.outputGeometrySha256 !== reference.outputGeometrySha256
    || document.projectEditPlanSha256 !== reference.projectEditPlanSha256
    || document.projectSha256 !== reference.projectSha256
    || document.renderPlanSha256 !== reference.renderPlanSha256
    || document.revisionSha256 !== reference.revisionSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Immutable project render plan reference does not match its exact document.",
    );
  }
  assertProjectRenderPlanComposition(document.plan);
  return { directory, document, fileSystem, reference };
}

async function publishProjectRenderPlan(
  application: ApplicationContext,
  beforePublication: (() => Promise<void>) | undefined,
  revision: Awaited<ReturnType<typeof loadExactProjectEditRevision>>,
  plan: ProjectRenderPlanV1,
): Promise<ProjectRenderPlanReference> {
  const document = projectRenderPlanDocument(
    plan,
    revision.document,
    revision.reference,
  );
  const contents = `${canonicalJson(document)}\n`;
  const artifact = {
    bytes: utf8Bytes(contents),
    path: "",
    sha256: sha256Hex(contents),
  };
  if (artifact.bytes > MAXIMUM_PROJECT_RENDER_PLAN_BYTES) {
    throw new ApplicationError(
      "unsupported-plan",
      "Project render plan exceeds the 256 MiB structured-artifact limit.",
      { artifactBytes: artifact.bytes },
    );
  }
  const reference = ProjectRenderPlanReferenceSchema.parse({
    artifact: {
      ...artifact,
      path: `renders/plans/${artifact.sha256}.json`,
    },
    kind: "atet.project-render-plan-reference",
    outputGeometrySha256: revision.reference.outputGeometrySha256,
    planSha256: plan.planSha256,
    projectEditPlanSha256: revision.document.projectEditPlanSha256,
    projectId: revision.document.project.projectId,
    projectSha256: revision.document.projectSha256,
    renderPlanSha256: document.renderPlanSha256,
    revisionSha256: revision.document.revisionSha256,
    schemaVersion: 1,
  });
  if (revision.fileSystem.writeTextNoReplace === undefined) {
    throw new ApplicationError(
      "internal",
      "Project storage does not support immutable render-plan publication.",
    );
  }
  await beforePublication?.();
  await revision.fileSystem.writeTextNoReplace(
    reference.artifact.path,
    contents,
  );
  const published = await loadExactProjectRenderPlan(
    application,
    reference,
  );
  if (canonicalJson(published.document) !== canonicalJson(document)) {
    throw new ApplicationError(
      "conflict",
      "Published project render plan contains different bytes.",
    );
  }
  return reference;
}

async function publishProjectCaptionArtifacts(
  revision: Awaited<ReturnType<typeof loadExactProjectEditRevision>>,
  artifacts: readonly PreparedProjectCaptionArtifact[],
  signal: AbortSignal,
): Promise<void> {
  if (revision.fileSystem.writeTextNoReplace === undefined) {
    throw new ApplicationError(
      "internal",
      "Project storage does not support immutable caption-asset publication.",
    );
  }
  for (const artifact of artifacts) {
    throwIfAborted(signal);
    const disposition = await revision.fileSystem.writeTextNoReplace(
      artifact.path,
      artifact.contents,
    );
    const installed = await revision.fileSystem.readText(artifact.path);
    if (
      installed !== artifact.contents
      || sha256Hex(installed) !== artifact.sha256
    ) {
      throw new ApplicationError(
        "conflict",
        disposition === "exists"
          ? `Caption asset path already contains different bytes: ${artifact.path}`
          : `Published caption asset failed read-back verification: ${artifact.path}`,
      );
    }
  }
}

export const projectRenderPlanOperationDefinition = {
  inputSchema: ProjectRenderPlanInputSchema,
  inputSchemaId: "studio.operation.render.project-plan.input/v1",
  kind: "render.project-plan",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      if (
        context.workflow !== undefined
        && input.metadataBindings === undefined
      ) {
        throw new ApplicationError(
          "incompatible",
          "Workflow render planning requires exact recording-metadata bindings.",
        );
      }
      const revision = await loadExactProjectEditRevision(
        context.application,
        input.revision,
      );
      const metadata = await projectMetadata(
        context.application.paths.artifactRoot,
        revision.document.project,
        revision.document.projectEditPlan,
      );
      if (
        input.metadataBindings !== undefined
        && canonicalJson(input.metadataBindings) !== canonicalJson(metadata.bindings)
      ) {
        throw new ApplicationError(
          "conflict",
          "Recording metadata changed after the render-plan node was bound.",
        );
      }
      let plan;
      try {
        plan = compileProjectRenderPlan(
          revision.document.project,
          revision.document.projectEditPlan,
          renderSettings(input.settings, revision.reference, metadata.contexts),
        );
      } catch (error) {
        if (error instanceof TypeError) {
          throw new ApplicationError("conflict", error.message);
        }
        throw error;
      }
      throwIfAborted(context.abortSignal);
      const workflow = context.workflow;
      return await publishProjectRenderPlan(
        context.application,
        workflow === undefined
          ? undefined
          : () => workflow.beforePublication(),
        revision,
        plan,
      );
    },
  },
  outputSchema: ProjectRenderPlanOutputSchema,
  outputSchemaId: "studio.operation.render.project-plan.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 2 * 60_000,
    maxFanOut: 0,
    maxInputBytes: 256 * 1_024,
    maxOutputBytes: 8_192,
    preparation: ["recording-metadata"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ],
    resume: "deterministic",
  },
  receiptReference: output => output.artifact.path,
  summarize: output => ({
    fields: {
      planArtifactSha256: output.artifact.sha256,
      planSha256: output.planSha256,
      projectId: output.projectId,
      revisionSha256: output.revisionSha256,
    },
    kind: "render.project-plan",
  }),
  version: 1,
} satisfies OperationDefinition<
  "render.project-plan",
  ProjectRenderPlanInput,
  ProjectRenderPlanOutput
>;

export const projectRenderPlanOperationDefinitionV2 = {
  inputSchema: ProjectRenderPlanInputV2Schema,
  inputSchemaId: "studio.operation.render.project-plan.input/v2",
  kind: "render.project-plan",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      if (
        context.workflow !== undefined
        && (
          input.captionBinding === undefined
          || input.metadataBindings === undefined
        )
      ) {
        throw new ApplicationError(
          "incompatible",
          "Workflow captioned render planning requires exact caption and recording-metadata bindings.",
        );
      }
      const revision = await loadExactProjectEditRevision(
        context.application,
        input.revision,
      );
      const [metadata, captions] = await Promise.all([
        projectMetadata(
          context.application.paths.artifactRoot,
          revision.document.project,
          revision.document.projectEditPlan,
        ),
        projectCaptions(revision, input.settings.captions),
      ]);
      if (
        input.metadataBindings !== undefined
        && canonicalJson(input.metadataBindings) !== canonicalJson(metadata.bindings)
      ) {
        throw new ApplicationError(
          "conflict",
          "Recording metadata changed after the render-plan node was bound.",
        );
      }
      if (
        input.captionBinding !== undefined
        && canonicalJson(input.captionBinding) !== canonicalJson(captions.binding)
      ) {
        throw new ApplicationError(
          "conflict",
          "Caption source changed after the render-plan node was bound.",
        );
      }

      let basePlan: ProjectRenderPlanV1;
      try {
        basePlan = compileProjectRenderPlan(
          revision.document.project,
          revision.document.projectEditPlan,
          renderSettings(input.settings, revision.reference, metadata.contexts),
        );
      } catch (error) {
        if (error instanceof TypeError) {
          throw new ApplicationError("conflict", error.message);
        }
        throw error;
      }

      let prepared: PreparedProjectCaptionPlan;
      try {
        const cues = compileProjectCaptionCues({
          analysis: captions.analysis,
          output: basePlan.output,
          placementId: input.settings.captions.placementId,
          plan: revision.document.projectEditPlan,
          project: revision.document.project,
        });
        prepared = prepareProjectCaptionPlan({
          cues,
          plan: basePlan,
          sourceSha256: hashProjectCaptionSource({
            binding: captions.binding,
            output: basePlan.output,
            projectEditPlanSha256: revision.document.projectEditPlanSha256,
            revisionSha256: revision.document.revisionSha256,
            style: input.settings.captions.style,
          }),
          style: input.settings.captions.style,
        });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          throw new ApplicationError("unsupported-plan", error.message);
        }
        throw error;
      }
      const plan = prepared.plan;

      throwIfAborted(context.abortSignal);
      await context.workflow?.beforePublication();
      throwIfAborted(context.abortSignal);
      await publishProjectCaptionArtifacts(
        revision,
        prepared.artifacts,
        context.abortSignal,
      );
      return await publishProjectRenderPlan(
        context.application,
        undefined,
        revision,
        plan,
      );
    },
  },
  outputSchema: ProjectRenderPlanOutputSchema,
  outputSchemaId: "studio.operation.render.project-plan.output/v2",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 2 * 60_000,
    maxFanOut: 0,
    maxInputBytes: 256 * 1_024,
    maxOutputBytes: 8_192,
    preparation: ["recording-metadata"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ],
    resume: "deterministic",
  },
  receiptReference: output => output.artifact.path,
  summarize: output => ({
    fields: {
      planArtifactSha256: output.artifact.sha256,
      planSha256: output.planSha256,
      projectId: output.projectId,
      revisionSha256: output.revisionSha256,
    },
    kind: "render.project-plan",
  }),
  version: 2,
} satisfies OperationDefinition<
  "render.project-plan",
  ProjectRenderPlanInputV2,
  ProjectRenderPlanOutput
>;
