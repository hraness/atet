import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative } from "node:path";

import type { z } from "zod";

import {
  FaceAnalysisV1Schema,
  MusicAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  ProjectInactivityAnalysisV1Schema,
  type VideoProjectV1,
} from "../contracts";
import {
  DEFAULT_FACE_ANALYSIS_CONFIG,
  buildFaceAnalysisReference,
} from "../cli/face-analysis-service";
import { resolveAudioAnalysisSubject } from "../cli/audio-analysis";
import {
  DEFAULT_MUSIC_ANALYSIS_CONFIG,
  buildMusicAnalysisReference,
} from "../cli/music-analysis-service";
import {
  DEFAULT_PROJECT_INACTIVITY_CONFIG,
  buildProjectInactivityAnalysisReference,
  loadProjectInactivityReferenceEvidence,
} from "../cli/project-inactivity-service";
import {
  openProject,
  projectAnalysisPath,
  type OpenProject,
} from "../cli/project-service";
import { resolveVideoAnalysisSubject } from "../cli/scene-analysis-service";
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
} from "../core/canonical-json";
import { hashProjectStructure } from "../core/project-plan";
import { htmlOverlayFrameCount } from "../html-overlay";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import {
  mergeProjectAnalysisReference,
  openLeasedProjectSnapshot,
} from "./project-publication-lease";
import {
  ProjectEditBasisSchema,
  assertProjectEditBasis,
  type OpenProjectSnapshot,
} from "./project-store";
import {
  readOperationCompletionCheckpoint,
  type OperationCheckpointExecutionIdentity,
} from "./operation-completion-checkpoint";
import type { OperationKind } from "./operation";
import {
  FacesOperationInputSchema,
  FacesOperationOutputSchema,
  MusicOperationInputSchema,
  MusicOperationOutputSchema,
  ProjectInactivityOperationInputSchema,
  ProjectInactivityOperationOutputSchema,
  projectInactivityRecordingBinding,
  BoundMediaAudioEffectsInputSchema,
  MediaAudioEffectsOutputSchema,
  MediaAudioEffectsReceiptSchema,
  BoundMediaColorGradeInputSchema,
  MediaColorGradeOutputSchema,
  MediaColorGradeReceiptSchema,
  BoundHtmlOverlayInputSchema,
  HtmlOverlayOutputSchema,
  HtmlOverlayReceiptSchema,
  MAXIMUM_HTML_OVERLAY_DOCUMENT_BYTES,
  MAXIMUM_HTML_OVERLAY_OUTPUT_BYTES,
  MAXIMUM_HTML_OVERLAY_RESOURCE_BYTES,
  BoundMediaIngestInputSchema,
  MediaIngestOutputSchema,
  MediaIngestReceiptSchema,
  BoundMediaOverlayInputSchema,
  MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES,
  MediaOverlayOutputSchema,
  MediaOverlayReceiptSchema,
  MAXIMUM_DIAGRAM_ARTIFACT_BYTES,
  MAXIMUM_DIAGRAM_SOURCE_BYTES,
  MAXIMUM_VECTOR_ARTIFACT_BYTES,
  BoundTransmuteDiagramRenderInputSchema,
  BoundTransmuteImageVectorizeInputSchema,
  TransmuteDiagramRenderOutputSchema,
  TransmuteDiagramRenderReceiptSchema,
  TransmuteImageVectorizeOutputSchema,
  TransmuteImageVectorizeReceiptSchema,
} from "./operations";
import {
  MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
  MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
  MediaArtifactReferenceSchema,
  bindRepositoryMedia,
  type MediaArtifactReference,
} from "./operations/media/shared";
import {
  MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
} from "../cli/media-effects-service";

export const LOCAL_VERIFIED_RECEIPT_OPERATION_KINDS = Object.freeze([
  "analysis.faces",
  "analysis.music",
  "analysis.project-inactivity",
  "media.audio-effects",
  "media.color-grade",
  "media.html-overlay",
  "media.ingest",
  "media.overlay",
  "transmute.diagram.render",
  "transmute.image.vectorize",
] as const satisfies readonly OperationKind[]);

type LocalVerifiedReceiptOperationKind =
  typeof LOCAL_VERIFIED_RECEIPT_OPERATION_KINDS[number];

export interface VerifiedReceiptReconciliationRequest {
  readonly abortSignal: AbortSignal;
  readonly beforePublication: () => Promise<void>;
  readonly exactInput: unknown;
  readonly expectedProjectGeneration?: string;
  readonly identity: OperationCheckpointExecutionIdentity;
  readonly workspaceDirectory: string;
}

export type VerifiedReceiptReconciliation =
  | {
    readonly kind: "completed";
    readonly output: unknown;
    readonly receiptReference?: string;
    readonly summary: Readonly<Record<
      string,
      boolean | null | number | string
    >>;
  }
  | { readonly kind: "retry" }
  | { readonly kind: "incompatible"; readonly message: string };

type ProjectAnalysisReference = VideoProjectV1["analyses"][number];

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function incompatible(error: unknown): VerifiedReceiptReconciliation {
  const message = error instanceof Error
    ? error.message
    : "Authoritative operation evidence could not be verified.";
  return {
    kind: "incompatible",
    message: `Interrupted operation recovery failed closed: ${message}`,
  };
}

function requireAnalysisId(analysisId: string | undefined): string {
  if (analysisId === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Exact analysis input is missing its deterministic analysis identity.",
    );
  }
  return analysisId;
}

function throwIfReconciliationAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ApplicationError(
      "cancelled",
      "Workflow reconciliation was cancelled.",
    );
  }
}

async function readCanonicalAnalysisAt<Analysis>(
  project: OpenProject,
  path: string,
  schema: z.ZodType<Analysis>,
  expectedSha256?: string,
): Promise<Analysis | undefined> {
  let text: string;
  try {
    text = await project.fileSystem.readText(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (expectedSha256 !== undefined && sha256Hex(text) !== expectedSha256) {
    throw new ApplicationError(
      "incompatible",
      `Authoritative analysis sidecar failed its SHA-256 check: ${path}`,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new ApplicationError(
      "incompatible",
      `Authoritative analysis sidecar is not JSON: ${path}`,
    );
  }
  const analysis = schema.parse(input);
  if (`${canonicalJson(analysis)}\n` !== text) {
    throw new ApplicationError(
      "incompatible",
      `Authoritative analysis sidecar is not canonical JSON: ${path}`,
    );
  }
  return analysis;
}

async function readCanonicalAnalysis<Analysis>(
  project: OpenProject,
  reference: ProjectAnalysisReference,
  schema: z.ZodType<Analysis>,
): Promise<Analysis> {
  const analysis = await readCanonicalAnalysisAt(
    project,
    reference.path,
    schema,
    reference.sha256,
  );
  if (analysis === undefined) {
    throw new ApplicationError(
      "incompatible",
      `Authoritative analysis sidecar is missing: ${reference.path}`,
    );
  }
  return analysis;
}

async function authoritativeAnalysis<Analysis>(options: {
  readonly analysisId: string;
  readonly expectedKind: ProjectAnalysisReference["kind"];
  readonly expectedPath: string;
  readonly project: OpenProject;
  readonly schema: z.ZodType<Analysis>;
}): Promise<
  | { readonly kind: "missing" }
  | {
    readonly analysis: Analysis;
    readonly kind: "orphan";
  }
  | {
    readonly analysis: Analysis;
    readonly kind: "published";
    readonly reference: ProjectAnalysisReference;
  }
> {
  const reference = options.project.project.analyses.find(
    candidate => candidate.analysisId === options.analysisId,
  );
  if (reference === undefined) {
    const analysis = await readCanonicalAnalysisAt(
      options.project,
      options.expectedPath,
      options.schema,
    );
    return analysis === undefined
      ? { kind: "missing" }
      : { analysis, kind: "orphan" };
  }
  if (
    reference.kind !== options.expectedKind
    || reference.path !== options.expectedPath
  ) {
    throw new ApplicationError(
      "incompatible",
      `Project analysis ${options.analysisId} has incompatible authority.`,
    );
  }
  return {
    analysis: await readCanonicalAnalysis(
      options.project,
      reference,
      options.schema,
    ),
    kind: "published",
    reference,
  };
}

async function adoptOrphanAnalysisReference(options: {
  readonly abortSignal: AbortSignal;
  readonly application: ApplicationContext;
  readonly beforePublication: () => Promise<void>;
  readonly operation: Extract<OperationKind, `analysis.${string}`>;
  readonly project: string;
  readonly projectBinding: unknown;
  readonly reference: ProjectAnalysisReference;
  readonly snapshot: OpenProjectSnapshot;
}): Promise<{
  readonly project: VideoProjectV1;
  readonly reference: ProjectAnalysisReference;
}> {
  assertExactAnalysisProjectBinding(
    options.projectBinding,
    options.snapshot,
  );
  return await mergeProjectAnalysisReference({
    application: options.application,
    basis: ProjectEditBasisSchema.parse(options.projectBinding),
    beforePublication: async () => {
      throwIfReconciliationAborted(options.abortSignal);
      await options.beforePublication();
      throwIfReconciliationAborted(options.abortSignal);
    },
    operation: options.operation,
    project: options.project,
    reference: ProjectAnalysisReferenceSchema.parse(options.reference),
  });
}

function assertExactAnalysisProjectBinding(
  projectBinding: unknown,
  snapshot: OpenProjectSnapshot,
): void {
  if (projectBinding === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Interrupted analysis recovery requires its exact project edit basis.",
    );
  }
  assertProjectEditBasis(
    ProjectEditBasisSchema.parse(projectBinding),
    snapshot,
  );
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ApplicationError("incompatible", message);
  }
}

function completedAnalysis(
  output: unknown,
  summary: Readonly<Record<string, boolean | null | number | string>>,
): VerifiedReceiptReconciliation {
  return { kind: "completed", output, summary };
}

async function recoverFaces(
  application: ApplicationContext,
  inputValue: unknown,
  control: Pick<
    VerifiedReceiptReconciliationRequest,
    "abortSignal" | "beforePublication"
  >,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(control.abortSignal);
  const input = FacesOperationInputSchema.parse(inputValue);
  const analysisId = requireAnalysisId(input.analysisId);
  const snapshot = await openLeasedProjectSnapshot(
    application,
    input.project,
  );
  assertExactAnalysisProjectBinding(input.projectBinding, snapshot);
  const authority = await authoritativeAnalysis({
    analysisId,
    expectedKind: "faces",
    expectedPath: projectAnalysisPath("faces", analysisId),
    project: snapshot.openProject,
    schema: FaceAnalysisV1Schema,
  });
  if (authority.kind === "missing") return { kind: "retry" };
  const expectedSubject = resolveVideoAnalysisSubject(
    snapshot.project,
    input.source,
  ).subject;
  assertEqual(
    authority.analysis.subject,
    expectedSubject,
    "Face analysis subject no longer matches its exact operation input.",
  );
  assertEqual(
    authority.analysis.config,
    input.config ?? DEFAULT_FACE_ANALYSIS_CONFIG,
    "Face analysis config no longer matches its exact operation input.",
  );
  const initialReference = authority.kind === "published"
    ? authority.reference
    : buildFaceAnalysisReference(
        authority.analysis,
        projectAnalysisPath("faces", analysisId),
      );
  assertEqual(
    initialReference,
    buildFaceAnalysisReference(
      authority.analysis,
      initialReference.path,
    ),
    "Face analysis reference disagrees with its immutable sidecar.",
  );
  const adopted = authority.kind === "orphan"
    ? await adoptOrphanAnalysisReference({
        abortSignal: control.abortSignal,
        application,
        beforePublication: control.beforePublication,
        operation: "analysis.faces",
        project: input.project,
        projectBinding: input.projectBinding,
        reference: initialReference,
        snapshot,
      })
    : {
        project: snapshot.project,
        reference: initialReference,
      };
  const output = FacesOperationOutputSchema.parse({
    analysisId: authority.analysis.analysisId,
    analyzedFrames: authority.analysis.coverage.analyzedFrames,
    backend: authority.analysis.backend,
    localOnly: true,
    path: adopted.reference.path,
    privacy: authority.analysis.privacy,
    projectId: adopted.project.projectId,
    reference: adopted.reference,
    source: input.source,
    tracks: authority.analysis.tracks.length,
  });
  return completedAnalysis(output, {
    analysisId: output.analysisId,
    analyzedFrames: output.analyzedFrames,
    localOnly: output.localOnly,
    path: output.path,
    projectId: output.projectId,
    tracks: output.tracks,
  });
}

async function recoverMusic(
  application: ApplicationContext,
  inputValue: unknown,
  control: Pick<
    VerifiedReceiptReconciliationRequest,
    "abortSignal" | "beforePublication"
  >,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(control.abortSignal);
  const input = MusicOperationInputSchema.parse(inputValue);
  const analysisId = requireAnalysisId(input.analysisId);
  const snapshot = await openLeasedProjectSnapshot(
    application,
    input.project,
  );
  assertExactAnalysisProjectBinding(input.projectBinding, snapshot);
  const authority = await authoritativeAnalysis({
    analysisId,
    expectedKind: "music",
    expectedPath: projectAnalysisPath("music", analysisId),
    project: snapshot.openProject,
    schema: MusicAnalysisV1Schema,
  });
  if (authority.kind === "missing") return { kind: "retry" };
  const expectedSubject = resolveAudioAnalysisSubject(
    snapshot.project,
    input.source,
  ).subject;
  assertEqual(
    authority.analysis.subject,
    expectedSubject,
    "Music analysis subject no longer matches its exact operation input.",
  );
  assertEqual(
    authority.analysis.config,
    input.config ?? DEFAULT_MUSIC_ANALYSIS_CONFIG,
    "Music analysis config no longer matches its exact operation input.",
  );
  const initialReference = authority.kind === "published"
    ? authority.reference
    : buildMusicAnalysisReference(
        authority.analysis,
        projectAnalysisPath("music", analysisId),
      );
  assertEqual(
    initialReference,
    buildMusicAnalysisReference(
      authority.analysis,
      initialReference.path,
    ),
    "Music analysis reference disagrees with its immutable sidecar.",
  );
  const adopted = authority.kind === "orphan"
    ? await adoptOrphanAnalysisReference({
        abortSignal: control.abortSignal,
        application,
        beforePublication: control.beforePublication,
        operation: "analysis.music",
        project: input.project,
        projectBinding: input.projectBinding,
        reference: initialReference,
        snapshot,
      })
    : {
        project: snapshot.project,
        reference: initialReference,
      };
  const output = MusicOperationOutputSchema.parse({
    analysisId: authority.analysis.analysisId,
    keyChanges: authority.analysis.keyRegions.filter(
      region => region.changeConfidence !== null,
    ).length,
    keyRegions: authority.analysis.keyRegions.length,
    musicRegions: authority.analysis.musicRegions.length,
    path: adopted.reference.path,
    projectId: adopted.project.projectId,
    reference: adopted.reference,
    tempoChanges: authority.analysis.tempoRegions.filter(
      region => region.changeFromPrevious !== null,
    ).length,
    tempoRegions: authority.analysis.tempoRegions.length,
  });
  return completedAnalysis(output, {
    analysisId: output.analysisId,
    keyRegions: output.keyRegions,
    musicRegions: output.musicRegions,
    path: output.path,
    projectId: output.projectId,
    tempoRegions: output.tempoRegions,
  });
}

async function recoverProjectInactivity(
  application: ApplicationContext,
  inputValue: unknown,
  control: Pick<
    VerifiedReceiptReconciliationRequest,
    "abortSignal" | "beforePublication"
  >,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(control.abortSignal);
  const input = ProjectInactivityOperationInputSchema.parse(inputValue);
  const analysisId = requireAnalysisId(input.analysisId);
  const snapshot = await openLeasedProjectSnapshot(
    application,
    input.project,
  );
  assertExactAnalysisProjectBinding(input.projectBinding, snapshot);
  if (input.recordingBinding === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Interrupted inactivity analysis recovery requires exact recording evidence.",
    );
  }
  const config = input.config ?? DEFAULT_PROJECT_INACTIVITY_CONFIG;
  const referenceEvidence = await loadProjectInactivityReferenceEvidence(
    snapshot.project,
    application.paths.artifactRoot,
    config.cursorMovementThresholdPx,
  );
  assertEqual(
    projectInactivityRecordingBinding(referenceEvidence),
    input.recordingBinding,
    "Inactivity recording evidence no longer matches its exact operation input.",
  );
  const authority = await authoritativeAnalysis({
    analysisId,
    expectedKind: "inactivity",
    expectedPath: projectAnalysisPath("inactivity", analysisId),
    project: snapshot.openProject,
    schema: ProjectInactivityAnalysisV1Schema,
  });
  if (authority.kind === "missing") return { kind: "retry" };
  if (
    authority.analysis.projectId !== snapshot.project.projectId
    || authority.analysis.projectStructureSha256
      !== hashProjectStructure(snapshot.project)
  ) {
    throw new ApplicationError(
      "incompatible",
      "Inactivity analysis no longer matches the current project structure.",
    );
  }
  assertEqual(
    authority.analysis.config,
    config,
    "Inactivity analysis config no longer matches its exact operation input.",
  );
  const initialReference = authority.kind === "published"
    ? authority.reference
    : buildProjectInactivityAnalysisReference(
        authority.analysis,
        projectAnalysisPath("inactivity", analysisId),
      );
  assertEqual(
    initialReference,
    buildProjectInactivityAnalysisReference(
      authority.analysis,
      initialReference.path,
    ),
    "Inactivity analysis reference disagrees with its immutable sidecar.",
  );
  const adopted = authority.kind === "orphan"
    ? await adoptOrphanAnalysisReference({
        abortSignal: control.abortSignal,
        application,
        beforePublication: control.beforePublication,
        operation: "analysis.project-inactivity",
        project: input.project,
        projectBinding: input.projectBinding,
        reference: initialReference,
        snapshot,
      })
    : {
        project: snapshot.project,
        reference: initialReference,
      };
  const output = ProjectInactivityOperationOutputSchema.parse({
    analysisId: authority.analysis.analysisId,
    candidateCount: authority.analysis.result.candidateCount,
    cuts: authority.analysis.result.recommendedRanges,
    evidencePath: adopted.reference.path,
    projectId: authority.analysis.projectId,
    protectedInteractionCount:
      authority.analysis.result.protectedInteractionCount,
    reference: adopted.reference,
    referenceRecording:
      authority.analysis.referenceRecording?.recordingId ?? null,
  });
  return completedAnalysis(output, {
    analysisId: output.analysisId,
    candidateCount: output.candidateCount,
    cuts: output.cuts.length,
    evidencePath: output.evidencePath,
    projectId: output.projectId,
  });
}

async function readCanonicalReceipt<Receipt>(
  application: ApplicationContext,
  referenceInput: MediaArtifactReference,
  schema: z.ZodType<Receipt>,
  signal: AbortSignal,
): Promise<Receipt> {
  throwIfReconciliationAborted(signal);
  const reference = MediaArtifactReferenceSchema.parse(referenceInput);
  const bound = await bindRepositoryMedia(
    application,
    reference,
    signal,
    1024 * 1024,
  );
  const handle = await open(
    bound.absolutePath,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || createHash("sha256").update(text).digest("hex") !== reference.sha256
    ) {
      throw new ApplicationError(
        "incompatible",
        "Media receipt changed while it was being verified.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      throw new ApplicationError(
        "incompatible",
        "Media receipt is not valid JSON.",
      );
    }
    const receipt = schema.parse(input);
    if (`${canonicalJson(receipt)}\n` !== text) {
      throw new ApplicationError(
        "incompatible",
        "Media receipt is not canonical immutable JSON.",
      );
    }
    return receipt;
  } finally {
    await handle.close();
  }
}

async function verifyMediaArtifact(
  application: ApplicationContext,
  reference: MediaArtifactReference,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<void> {
  await bindRepositoryMedia(
    application,
    reference,
    signal,
    maximumBytes,
  );
}

function ingestArtifactFromAsset(
  output: z.infer<typeof MediaIngestOutputSchema>,
): MediaArtifactReference {
  const segments = output.asset.streams.flatMap(stream => stream.segments);
  const first = segments[0];
  if (
    first === undefined
    || segments.some(segment => (
      segment.bytes !== first.bytes
      || segment.path !== first.path
      || segment.sha256 !== first.sha256
    ))
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered media ingest asset has inconsistent artifact identities.",
    );
  }
  return MediaArtifactReferenceSchema.parse({
    bytes: first.bytes,
    path: first.path,
    sha256: first.sha256,
  });
}

async function recoverMediaIngest(
  application: ApplicationContext,
  exactInput: unknown,
  outputValue: unknown,
  expectedProjectGeneration: string | undefined,
  signal: AbortSignal,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(signal);
  const input = BoundMediaIngestInputSchema.parse(exactInput);
  const output = MediaIngestOutputSchema.parse(outputValue);
  if (expectedProjectGeneration === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Recovered media ingest is missing its exact project generation.",
    );
  }
  await Promise.all([
    verifyMediaArtifact(
      application,
      input.source,
      MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
      signal,
    ),
    verifyMediaArtifact(
      application,
      output.artifact,
      MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
      signal,
    ),
  ]);
  assertEqual(
    ingestArtifactFromAsset(output),
    output.artifact,
    "Recovered media ingest asset disagrees with its published artifact.",
  );
  const receipt = await readCanonicalReceipt(
    application,
    output.receipt,
    MediaIngestReceiptSchema,
    signal,
  );
  if (
    receipt.projectGenerationSha256 !== expectedProjectGeneration
    || receipt.role !== input.role
    || receipt.assetSha256 !== canonicalJsonSha256(output.asset)
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered media ingest receipt disagrees with its exact project-bound operation.",
    );
  }
  assertEqual(
    receipt.input,
    input.source,
    "Recovered media ingest receipt disagrees with its exact source.",
  );
  assertEqual(
    receipt.output,
    output.artifact,
    "Recovered media ingest receipt disagrees with its published artifact.",
  );
  return {
    kind: "completed",
    output,
    receiptReference: output.receipt.path,
    summary: {
      assetId: output.asset.assetId,
      bytes: output.artifact.bytes,
      created: output.created,
      path: output.artifact.path,
      receipt: output.receipt.path,
      sha256: output.artifact.sha256,
    },
  };
}

async function recoverMediaOverlay(
  application: ApplicationContext,
  exactInput: unknown,
  outputValue: unknown,
  expectedProjectGeneration: string | undefined,
  signal: AbortSignal,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(signal);
  const input = BoundMediaOverlayInputSchema.parse(exactInput);
  const output = MediaOverlayOutputSchema.parse(outputValue);
  if (expectedProjectGeneration === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Recovered overlay preparation is missing its exact project generation.",
    );
  }
  const inputArtifact = input.source.kind === "emoji"
    ? input.source.resolved.artifact
    : input.source.artifact;
  await Promise.all([
    verifyMediaArtifact(
      application,
      inputArtifact,
      MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES,
      signal,
    ),
    verifyMediaArtifact(
      application,
      output.artifact,
      MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES,
      signal,
    ),
  ]);
  const project = await openProject(
    application.paths.projectRoot,
    input.project,
  );
  const expectedArtifactPath = relative(
    application.paths.repositoryRoot,
    join(project.directory.path, output.operation.source.asset.path),
  );
  if (
    expectedArtifactPath !== output.artifact.path
    || output.operation.source.asset.bytes !== output.artifact.bytes
    || output.operation.source.asset.sha256 !== output.artifact.sha256
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered overlay operation disagrees with its project-relative asset.",
    );
  }
  const receipt = await readCanonicalReceipt(
    application,
    output.receipt,
    MediaOverlayReceiptSchema,
    signal,
  );
  if (
    receipt.projectGenerationSha256 !== expectedProjectGeneration
    || receipt.projectId !== input.project
    || receipt.exactInputSha256 !== canonicalJsonSha256(input)
    || receipt.operationSha256 !== canonicalJsonSha256(output.operation)
    || receipt.overlayId !== output.operation.overlayId
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered overlay receipt disagrees with its exact project-bound operation.",
    );
  }
  assertEqual(
    receipt.artifact,
    output.artifact,
    "Recovered overlay receipt disagrees with its published asset.",
  );
  return {
    kind: "completed",
    output,
    receiptReference: output.receipt.path,
    summary: {
      bytes: output.artifact.bytes,
      created: output.created,
      kind: output.operation.source.kind,
      overlayId: output.operation.overlayId,
      receipt: output.receipt.path,
      sha256: output.artifact.sha256,
    },
  };
}

async function recoverHtmlOverlay(
  application: ApplicationContext,
  exactInput: unknown,
  outputValue: unknown,
  expectedProjectGeneration: string | undefined,
  signal: AbortSignal,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(signal);
  const input = BoundHtmlOverlayInputSchema.parse(exactInput);
  const output = HtmlOverlayOutputSchema.parse(outputValue);
  if (expectedProjectGeneration === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Recovered HTML-overlay preparation is missing its exact project generation.",
    );
  }
  if (input.capabilityBindings === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Recovered HTML-overlay preparation is missing its exact capability bindings.",
    );
  }
  for (const resource of input.resources) {
    assertEqual(
      {
        bytes: resource.bytes,
        sha256: resource.sha256,
      },
      {
        bytes: resource.artifact.bytes,
        sha256: resource.artifact.sha256,
      },
      `Recovered HTML-overlay resource ${resource.name} disagrees with its bound artifact.`,
    );
  }
  await Promise.all([
    ...("html" in input.document
      ? []
      : [verifyMediaArtifact(
          application,
          input.document,
          MAXIMUM_HTML_OVERLAY_DOCUMENT_BYTES,
          signal,
        )]),
    ...input.resources.map(async resource =>
      await verifyMediaArtifact(
        application,
        resource.artifact,
        MAXIMUM_HTML_OVERLAY_RESOURCE_BYTES,
        signal,
      )),
    verifyMediaArtifact(
      application,
      output.artifact,
      MAXIMUM_HTML_OVERLAY_OUTPUT_BYTES,
      signal,
    ),
  ]);
  const project = await openProject(
    application.paths.projectRoot,
    input.project,
  );
  const source = output.operation.source;
  if (
    source.kind !== "video"
    || source.audioPolicy.kind !== "mute"
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered HTML-overlay operation is not a muted video overlay.",
    );
  }
  const expectedArtifactPath = relative(
    application.paths.repositoryRoot,
    join(project.directory.path, source.asset.path),
  );
  if (
    expectedArtifactPath !== output.artifact.path
    || source.asset.bytes !== output.artifact.bytes
    || source.asset.sha256 !== output.artifact.sha256
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered HTML-overlay operation disagrees with its project-relative asset.",
    );
  }
  const {
    coordinateSpace,
    intrinsicSize,
    range,
  } = output.operation;
  const layout = {
    anchor: output.operation.anchor,
    blendMode: output.operation.blendMode,
    crop: output.operation.crop,
    entrance: output.operation.entrance,
    exit: output.operation.exit,
    fit: output.operation.fit,
    mask: output.operation.mask,
    motion: output.operation.motion,
    opacity: output.operation.opacity,
    position: output.operation.position,
    rotationDegrees: output.operation.rotationDegrees,
    scale: output.operation.scale,
    size: output.operation.size,
    zIndex: output.operation.zIndex,
  };
  if (coordinateSpace !== "output-pixels") {
    throw new ApplicationError(
      "incompatible",
      "Recovered HTML-overlay operation uses an incompatible coordinate space.",
    );
  }
  assertEqual(
    intrinsicSize,
    {
      height: input.canvas.height,
      width: input.canvas.width,
    },
    "Recovered HTML-overlay operation disagrees with its exact canvas.",
  );
  assertEqual(
    range,
    input.range,
    "Recovered HTML-overlay operation disagrees with its exact project range.",
  );
  assertEqual(
    layout,
    input.layout,
    "Recovered HTML-overlay operation disagrees with its exact layout.",
  );
  const receipt = await readCanonicalReceipt(
    application,
    output.receipt,
    HtmlOverlayReceiptSchema,
    signal,
  );
  const capabilityVersions = new Map(
    input.capabilityBindings.map(binding => [
      binding.name,
      binding.version,
    ] as const),
  );
  if (
    receipt.projectGenerationSha256 !== expectedProjectGeneration
    || receipt.projectId !== input.project
    || receipt.exactInputSha256 !== canonicalJsonSha256(input)
    || receipt.operationSha256 !== canonicalJsonSha256(output.operation)
    || receipt.overlayId !== output.operation.overlayId
    || receipt.frameCount !== htmlOverlayFrameCount(input.timing)
    || receipt.libraryLocksSha256
      !== canonicalJsonSha256(receipt.libraryLocks)
    || receipt.browserVersion !== capabilityVersions.get("html-browser")
    || receipt.ffmpegVersion !== capabilityVersions.get("ffmpeg")
    || receipt.ffprobeVersion !== capabilityVersions.get("ffprobe")
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered HTML-overlay receipt disagrees with its exact project-bound operation.",
    );
  }
  assertEqual(
    receipt.libraryLocks.map(lock => lock.specifier),
    input.libraries,
    "Recovered HTML-overlay receipt disagrees with its exact library selection.",
  );
  assertEqual(
    receipt.artifact,
    output.artifact,
    "Recovered HTML-overlay receipt disagrees with its published asset.",
  );
  return {
    kind: "completed",
    output,
    receiptReference: output.receipt.path,
    summary: {
      bytes: output.artifact.bytes,
      created: output.created,
      kind: "html",
      overlayId: output.operation.overlayId,
      receipt: output.receipt.path,
      sha256: output.artifact.sha256,
    },
  };
}

async function recoverMediaAudioEffects(
  application: ApplicationContext,
  exactInput: unknown,
  outputValue: unknown,
  signal: AbortSignal,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(signal);
  const input = BoundMediaAudioEffectsInputSchema.parse(exactInput);
  const output = MediaAudioEffectsOutputSchema.parse(outputValue);
  await Promise.all([
    verifyMediaArtifact(
      application,
      input.input,
      MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
      signal,
    ),
    verifyMediaArtifact(
      application,
      output.artifact,
      MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
      signal,
    ),
  ]);
  const receipt = await readCanonicalReceipt(
    application,
    output.receipt,
    MediaAudioEffectsReceiptSchema,
    signal,
  );
  assertEqual(
    receipt.input,
    input.input,
    "Recovered audio-effects receipt disagrees with its exact input.",
  );
  assertEqual(
    receipt.transform,
    input.transform,
    "Recovered audio-effects receipt disagrees with its exact transform.",
  );
  assertEqual(
    output.transform,
    input.transform,
    "Recovered audio-effects output disagrees with its exact transform.",
  );
  assertEqual(
    receipt.output,
    { ...output.artifact, durationUs: output.durationUs },
    "Recovered audio-effects receipt disagrees with its published output.",
  );
  if (receipt.filterGraph !== output.filterGraph) {
    throw new ApplicationError(
      "incompatible",
      "Recovered audio-effects filter graph disagrees with its receipt.",
    );
  }
  return {
    kind: "completed",
    output,
    receiptReference: output.receipt.path,
    summary: {
      bytes: output.artifact.bytes,
      created: output.created,
      durationUs: output.durationUs,
      effects: output.transform.effects.length,
      path: output.artifact.path,
      receipt: output.receipt.path,
      sha256: output.artifact.sha256,
    },
  };
}

async function recoverMediaColorGrade(
  application: ApplicationContext,
  exactInput: unknown,
  outputValue: unknown,
  signal: AbortSignal,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(signal);
  const input = BoundMediaColorGradeInputSchema.parse(exactInput);
  const output = MediaColorGradeOutputSchema.parse(outputValue);
  await Promise.all([
    verifyMediaArtifact(
      application,
      input.input,
      MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
      signal,
    ),
    verifyMediaArtifact(
      application,
      output.artifact,
      MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
      signal,
    ),
  ]);
  const receipt = await readCanonicalReceipt(
    application,
    output.receipt,
    MediaColorGradeReceiptSchema,
    signal,
  );
  assertEqual(
    receipt.input,
    input.input,
    "Recovered color-grade receipt disagrees with its exact input.",
  );
  assertEqual(
    receipt.transform,
    input.transform,
    "Recovered color-grade receipt disagrees with its exact transform.",
  );
  assertEqual(
    output.transform,
    input.transform,
    "Recovered color-grade output disagrees with its exact transform.",
  );
  assertEqual(
    receipt.output,
    { ...output.artifact, durationUs: output.durationUs },
    "Recovered color-grade receipt disagrees with its published output.",
  );
  if (receipt.filterGraph !== output.filterGraph) {
    throw new ApplicationError(
      "incompatible",
      "Recovered color-grade filter graph disagrees with its receipt.",
    );
  }
  return {
    kind: "completed",
    output,
    receiptReference: output.receipt.path,
    summary: {
      bytes: output.artifact.bytes,
      created: output.created,
      durationUs: output.durationUs,
      path: output.artifact.path,
      profile: output.transform.outputProfile,
      receipt: output.receipt.path,
      sha256: output.artifact.sha256,
    },
  };
}

async function recoverTransmuteDiagramRender(
  application: ApplicationContext,
  exactInput: unknown,
  outputValue: unknown,
  signal: AbortSignal,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(signal);
  const input = BoundTransmuteDiagramRenderInputSchema.parse(exactInput);
  const output = TransmuteDiagramRenderOutputSchema.parse(outputValue);
  const source = await bindRepositoryMedia(
    application,
    input.path,
    signal,
    MAXIMUM_DIAGRAM_SOURCE_BYTES,
  );
  assertEqual(
    output.source,
    source.artifact,
    "Recovered diagram render disagrees with its exact source.",
  );
  await Promise.all(Object.values(output.artifacts).map(async artifact =>
    await verifyMediaArtifact(
      application,
      artifact,
      MAXIMUM_DIAGRAM_ARTIFACT_BYTES,
      signal,
    )));
  const receipt = await readCanonicalReceipt(
    application,
    output.receipt,
    TransmuteDiagramRenderReceiptSchema,
    signal,
  );
  if (
    receipt.exactInputSha256 !== canonicalJsonSha256(input)
    || receipt.scale !== (input.scale ?? 2)
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered diagram receipt disagrees with its exact operation input.",
    );
  }
  assertEqual(
    receipt.source,
    output.source,
    "Recovered diagram receipt disagrees with its exact source.",
  );
  assertEqual(
    receipt.artifacts,
    output.artifacts,
    "Recovered diagram receipt disagrees with its published artifacts.",
  );
  assertEqual(
    receipt.findings,
    output.findings,
    "Recovered diagram receipt disagrees with its lint findings.",
  );
  return {
    kind: "completed",
    output,
    receiptReference: output.receipt.path,
    summary: {
      darkPng: output.artifacts.darkPng.path,
      findings: output.findings.length,
      lightPng: output.artifacts.lightPng.path,
      receipt: output.receipt.path,
      sourceSha256: output.source.sha256,
    },
  };
}

async function recoverTransmuteImageVectorize(
  application: ApplicationContext,
  exactInput: unknown,
  outputValue: unknown,
  signal: AbortSignal,
): Promise<VerifiedReceiptReconciliation> {
  throwIfReconciliationAborted(signal);
  const input = BoundTransmuteImageVectorizeInputSchema.parse(exactInput);
  const output = TransmuteImageVectorizeOutputSchema.parse(outputValue);
  const source = await bindRepositoryMedia(
    application,
    input.inputPath,
    signal,
    MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
  );
  assertEqual(
    output.source,
    source.artifact,
    "Recovered vectorization disagrees with its exact raster source.",
  );
  await verifyMediaArtifact(
    application,
    output.artifact,
    MAXIMUM_VECTOR_ARTIFACT_BYTES,
    signal,
  );
  if (
    output.vectorizer.sourceSha256 !== output.source.sha256
    || output.vectorizer.inputBytes !== output.source.bytes
    || output.vectorizer.svgSha256 !== output.artifact.sha256
    || output.vectorizer.bytes !== output.artifact.bytes
    || output.vectorizer.outputMode !== (
      input.duotone === undefined ? "color" : "duotone"
    )
  ) {
    throw new ApplicationError(
      "incompatible",
      "Recovered vectorizer evidence disagrees with its source or published SVG.",
    );
  }
  const receipt = await readCanonicalReceipt(
    application,
    output.receipt,
    TransmuteImageVectorizeReceiptSchema,
    signal,
  );
  if (receipt.exactInputSha256 !== canonicalJsonSha256(input)) {
    throw new ApplicationError(
      "incompatible",
      "Recovered vectorization receipt disagrees with its exact operation input.",
    );
  }
  assertEqual(
    receipt.source,
    output.source,
    "Recovered vectorization receipt disagrees with its exact raster source.",
  );
  assertEqual(
    receipt.artifact,
    output.artifact,
    "Recovered vectorization receipt disagrees with its published SVG.",
  );
  assertEqual(
    receipt.vectorizer,
    output.vectorizer,
    "Recovered vectorization receipt disagrees with its vectorizer evidence.",
  );
  return {
    kind: "completed",
    output,
    receiptReference: output.receipt.path,
    summary: {
      bytes: output.artifact.bytes,
      created: output.created,
      paths: output.vectorizer.pathCount,
      receipt: output.receipt.path,
      sha256: output.artifact.sha256,
      sourceSha256: output.source.sha256,
    },
  };
}

async function recoverAnalysis(
  application: ApplicationContext,
  kind: Extract<LocalVerifiedReceiptOperationKind, `analysis.${string}`>,
  input: unknown,
  control: Pick<
    VerifiedReceiptReconciliationRequest,
    "abortSignal" | "beforePublication"
  >,
): Promise<VerifiedReceiptReconciliation> {
  switch (kind) {
    case "analysis.faces":
      return await recoverFaces(application, input, control);
    case "analysis.music":
      return await recoverMusic(application, input, control);
    case "analysis.project-inactivity":
      return await recoverProjectInactivity(application, input, control);
  }
}

async function recoverCheckpointMedia(
  application: ApplicationContext,
  request: VerifiedReceiptReconciliationRequest,
  kind: Extract<LocalVerifiedReceiptOperationKind, `media.${string}`>,
  output: unknown,
): Promise<VerifiedReceiptReconciliation> {
  switch (kind) {
    case "media.ingest":
      return await recoverMediaIngest(
        application,
        request.exactInput,
        output,
        request.expectedProjectGeneration,
        request.abortSignal,
      );
    case "media.overlay":
      return await recoverMediaOverlay(
        application,
        request.exactInput,
        output,
        request.expectedProjectGeneration,
        request.abortSignal,
      );
    case "media.html-overlay":
      return await recoverHtmlOverlay(
        application,
        request.exactInput,
        output,
        request.expectedProjectGeneration,
        request.abortSignal,
      );
    case "media.audio-effects":
      return await recoverMediaAudioEffects(
        application,
        request.exactInput,
        output,
        request.abortSignal,
      );
    case "media.color-grade":
      return await recoverMediaColorGrade(
        application,
        request.exactInput,
        output,
        request.abortSignal,
      );
  }
}

async function recoverCheckpointTransmuteVisual(
  application: ApplicationContext,
  request: VerifiedReceiptReconciliationRequest,
  kind: Extract<LocalVerifiedReceiptOperationKind, `transmute.${string}`>,
  output: unknown,
): Promise<VerifiedReceiptReconciliation> {
  switch (kind) {
    case "transmute.diagram.render":
      return await recoverTransmuteDiagramRender(
        application,
        request.exactInput,
        output,
        request.abortSignal,
      );
    case "transmute.image.vectorize":
      return await recoverTransmuteImageVectorize(
        application,
        request.exactInput,
        output,
        request.abortSignal,
      );
  }
}

export function hasLocalVerifiedReceiptReconciler(
  kind: OperationKind,
): kind is LocalVerifiedReceiptOperationKind {
  return (LOCAL_VERIFIED_RECEIPT_OPERATION_KINDS as readonly OperationKind[])
    .includes(kind);
}

function isLocalAnalysisKind(
  kind: LocalVerifiedReceiptOperationKind,
): kind is Extract<LocalVerifiedReceiptOperationKind, `analysis.${string}`> {
  return kind === "analysis.faces"
    || kind === "analysis.music"
    || kind === "analysis.project-inactivity";
}

function isLocalTransmuteVisualKind(
  kind: LocalVerifiedReceiptOperationKind,
): kind is Extract<LocalVerifiedReceiptOperationKind, `transmute.${string}`> {
  return kind === "transmute.diagram.render"
    || kind === "transmute.image.vectorize";
}

export async function reconcileLocalVerifiedReceiptOperation(
  application: ApplicationContext,
  request: VerifiedReceiptReconciliationRequest,
): Promise<VerifiedReceiptReconciliation> {
  const kind = request.identity.kind;
  if (!hasLocalVerifiedReceiptReconciler(kind)) {
    return {
      kind: "incompatible",
      message: `Operation ${kind} has no local verified-receipt reconciler.`,
    };
  }
  try {
    throwIfReconciliationAborted(request.abortSignal);
    const checkpoint = await readOperationCompletionCheckpoint({
      expected: request.identity,
      privateRoot: application.paths.privateRoot,
      workspaceDirectory: request.workspaceDirectory,
    });
    if (isLocalAnalysisKind(kind)) {
      const recovered = await recoverAnalysis(
        application,
        kind,
        request.exactInput,
        request,
      );
      if (checkpoint === null) return recovered;
      if (recovered.kind !== "completed") {
        throw new ApplicationError(
          "incompatible",
          "Analysis checkpoint exists without matching authoritative project evidence.",
        );
      }
      assertEqual(
        checkpoint.output,
        recovered.output,
        "Analysis checkpoint output disagrees with authoritative project evidence.",
      );
      return recovered;
    }
    if (checkpoint === null) {
      // These operations publish only immutable content-addressed bytes before
      // the private completion point. Orphans are safe to leave and retry.
      return { kind: "retry" };
    }
    if (isLocalTransmuteVisualKind(kind)) {
      return await recoverCheckpointTransmuteVisual(
        application,
        request,
        kind,
        checkpoint.output,
      );
    }
    return await recoverCheckpointMedia(
      application,
      request,
      kind,
      checkpoint.output,
    );
  } catch (error) {
    return incompatible(error);
  }
}
