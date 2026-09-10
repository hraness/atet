import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Context, Effect } from "effect";

import type { AudioEffectsTransformV1, ColorGradeTransformV1 } from "../../../contracts";
import {
  LocalMediaEffectsService,
  MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
  type ExpectedLocalMediaInput,
  type LocalMediaTransformResult,
} from "../../../cli/media-effects-service";
import { probeProjectMediaEffect, type ProbedMedia } from "../../../cli/media-ingest";
import type { ApplicationProcessRunner } from "../../context";
import type { OperationExecutionContext } from "../../operation";
import { writeOperationCompletionCheckpoint, type OperationCheckpointDefinitionIdentity } from "../../operation-completion-checkpoint";
import { operationBoundary, operationValidation, type OperationEffectFailure } from "../../operation-effects";
import { throwIfAborted } from "../shared";
import {
  assertMediaCapabilities,
  bindMediaCapabilities,
  mediaCapabilityRunner,
} from "./capabilities";
import {
  AbortBoundApplicationRunner,
  MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
  bindRepositoryMedia,
  createMediaOperationWorkspace,
  publishContentAddressedMedia,
  publishContentAddressedReceipt,
  type BoundRepositoryMedia,
  type MediaArtifactReference,
  type MediaArtifactRequest,
  type MediaOperationWorkspace,
} from "./shared";

type MediaCapabilityBindings = Awaited<ReturnType<typeof bindMediaCapabilities>>;

export interface MediaTransformExecutionOptions<Transform> {
  readonly expectedInput: ExpectedLocalMediaInput;
  readonly ffmpeg: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly runner: ApplicationProcessRunner;
  readonly transform: Transform;
}

export interface MediaTransformPlatformService {
  checkAbort(): Effect.Effect<void, OperationEffectFailure>;
  bindInput(input: MediaArtifactRequest): Effect.Effect<BoundRepositoryMedia, OperationEffectFailure>;
  assertCapabilities(bindings: MediaCapabilityBindings | undefined): Effect.Effect<void, OperationEffectFailure>;
  bindCapabilities(): Effect.Effect<MediaCapabilityBindings, OperationEffectFailure>;
  runner(bindings: MediaCapabilityBindings): Effect.Effect<ApplicationProcessRunner, OperationEffectFailure>;
  probe(ffprobe: string, runner: ApplicationProcessRunner, path: string): Effect.Effect<ProbedMedia, OperationEffectFailure>;
  workspace(): Effect.Effect<MediaOperationWorkspace, OperationEffectFailure>;
  stagedPath(workspace: MediaOperationWorkspace, kind: "audio" | "color", extension: string): Effect.Effect<string, OperationEffectFailure>;
  renderAudio(options: MediaTransformExecutionOptions<AudioEffectsTransformV1>): Effect.Effect<LocalMediaTransformResult<AudioEffectsTransformV1>, OperationEffectFailure>;
  renderColor(options: MediaTransformExecutionOptions<ColorGradeTransformV1>): Effect.Effect<LocalMediaTransformResult<ColorGradeTransformV1>, OperationEffectFailure>;
  publishMedia(stagedPath: string, extension: string): Effect.Effect<{
    readonly artifact: MediaArtifactReference;
    readonly created: boolean;
  }, OperationEffectFailure>;
  publishReceipt(receipt: unknown, workspace: MediaOperationWorkspace): Effect.Effect<MediaArtifactReference, OperationEffectFailure>;
  checkpoint(identity: OperationCheckpointDefinitionIdentity, output: unknown): Effect.Effect<void, OperationEffectFailure>;
  now(): Effect.Effect<string, OperationEffectFailure>;
  dispose(workspace: MediaOperationWorkspace): Effect.Effect<void, OperationEffectFailure>;
}

export class MediaTransformPlatform extends Context.Tag("@slopcamera/local/MediaTransformPlatform")<
  MediaTransformPlatform, MediaTransformPlatformService
>() { }

/** Foreign native operations retain custody until their original Promise settles. */
export function createMediaTransformPlatform(
  context: OperationExecutionContext,
  dependencies: {
    readonly probe?: (ffprobe: string, runner: ApplicationProcessRunner, path: string) => Promise<ProbedMedia>;
    readonly renderAudio?: (options: MediaTransformExecutionOptions<AudioEffectsTransformV1>) => Promise<LocalMediaTransformResult<AudioEffectsTransformV1>>;
    readonly renderColor?: (options: MediaTransformExecutionOptions<ColorGradeTransformV1>) => Promise<LocalMediaTransformResult<ColorGradeTransformV1>>;
  } = {},
): MediaTransformPlatformService {
  const inspect = dependencies.probe;
  const renderAudio = dependencies.renderAudio;
  const renderColor = dependencies.renderColor;
  return {
    checkAbort: () => operationValidation("execution", () => throwIfAborted(context.abortSignal)),
    bindInput: input => Effect.uninterruptible(operationBoundary("media", () => bindRepositoryMedia(
      context.application, input, context.abortSignal, MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
    ))),
    assertCapabilities: bindings => Effect.uninterruptible(operationBoundary("capability", () => assertMediaCapabilities(
      context, context.application, bindings, ["ffmpeg", "ffprobe"],
    ))),
    bindCapabilities: () => Effect.uninterruptible(operationBoundary("capability", () => bindMediaCapabilities(
      context.application, ["ffmpeg", "ffprobe"],
    ))),
    runner: bindings => operationValidation("capability", () => new AbortBoundApplicationRunner(
      mediaCapabilityRunner(context.application, bindings), context.abortSignal,
    )),
    probe: (ffprobe, runner, path) => inspect === undefined
      ? probeProjectMediaEffect(ffprobe, runner, path)
      : Effect.uninterruptible(operationBoundary("media", () => inspect(ffprobe, runner, path))),
    workspace: () => operationBoundary("workspace", () => createMediaOperationWorkspace(context)),
    stagedPath: (workspace, kind, extension) => operationValidation("workspace", () => join(
      workspace.path, `${kind}-${randomUUID()}${extension}`,
    )),
    renderAudio: options => renderAudio === undefined
      ? Effect.flatMap(operationValidation("media", () => new LocalMediaEffectsService(options)), service => service.renderAudioEffect(options))
      : Effect.uninterruptible(operationBoundary("media", () => renderAudio(options))),
    renderColor: options => renderColor === undefined
      ? Effect.flatMap(operationValidation("media", () => new LocalMediaEffectsService(options)), service => service.renderColorEffect(options))
      : Effect.uninterruptible(operationBoundary("media", () => renderColor(options))),
    publishMedia: (stagedPath, extension) => Effect.uninterruptible(operationBoundary("publication", () => publishContentAddressedMedia({
      context, extension, maximumBytes: MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES, stagedPath,
    }))),
    publishReceipt: (receipt, workspace) => Effect.uninterruptible(operationBoundary("publication", () => publishContentAddressedReceipt({ context, receipt, workspace }))),
    checkpoint: (identity, output) => Effect.uninterruptible(operationBoundary("checkpoint", () => writeOperationCompletionCheckpoint(context, identity, output))),
    now: () => operationValidation("output", () => context.application.clock.now().toISOString()),
    dispose: workspace => operationBoundary("cleanup", () => workspace.dispose()),
  };
}
