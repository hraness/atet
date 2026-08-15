import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  AudioEffectsTransformV1Schema,
  type AudioEffectsTransformV1,
} from "../../../contracts";
import {
  LocalMediaEffectsService,
  MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
  type ExpectedLocalMediaInput,
  type LocalMediaTransformResult,
} from "../../../cli/media-effects-service";
import {
  probeProjectMedia,
  type ProbedMedia,
} from "../../../cli/media-ingest";
import type {
  ApplicationContext,
  ApplicationProcessRunner,
} from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { writeOperationCompletionCheckpoint } from "../../operation-completion-checkpoint";
import {
  throwIfAborted,
} from "../shared";
import {
  MediaCapabilityBindingsSchema,
  assertMediaCapabilities,
  bindExpectedMediaCapabilities,
  bindMediaCapabilities,
  mediaCapabilityCommand,
  mediaCapabilityRunner,
  mediaCapabilityVersion,
} from "./capabilities";
import {
  AbortBoundApplicationRunner,
  MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
  MediaArtifactReferenceSchema,
  MediaArtifactRequestSchema,
  bindRepositoryMedia,
  createMediaOperationWorkspace,
  publishContentAddressedMedia,
  publishContentAddressedReceipt,
} from "./shared";

const MAXIMUM_EFFECT_DURATION_US = 24 * 60 * 60 * 1_000_000;

export const MediaAudioEffectsReceiptSchema = z.strictObject({
  createdAt: z.string().datetime({ offset: true }),
  ffmpegVersion: z.string().min(1).max(256),
  ffprobeVersion: z.string().min(1).max(256),
  filterGraph: z.string().min(1).max(256 * 1024),
  input: MediaArtifactReferenceSchema,
  kind: z.union([
    z.literal("atet.local-media-transform-receipt"),
    z.literal("transmute.local-media-transform-receipt"),
    z.literal("studio.local-media-transform-receipt"),
  ]),
  operation: z.literal("audio-effects"),
  output: MediaArtifactReferenceSchema.extend({
    durationUs: z.number().int().safe().positive(),
  }).strict(),
  schemaVersion: z.literal(1),
  sourceDurationUs: z.number().int().safe().positive(),
  transform: AudioEffectsTransformV1Schema,
});

export const MediaAudioEffectsInputSchema = z.strictObject({
  capabilityBindings: MediaCapabilityBindingsSchema.optional(),
  input: MediaArtifactRequestSchema,
  transform: AudioEffectsTransformV1Schema,
});

export const BoundMediaAudioEffectsInputSchema =
  MediaAudioEffectsInputSchema.extend({
    input: MediaArtifactReferenceSchema,
  }).strict();

export const MediaAudioEffectsOutputSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  created: z.boolean(),
  durationUs: z.number().int().safe().positive(),
  filterGraph: z.string().min(1).max(256 * 1024),
  receipt: MediaArtifactReferenceSchema,
  transform: AudioEffectsTransformV1Schema,
});

export type MediaAudioEffectsInput = z.infer<typeof MediaAudioEffectsInputSchema>;
export type BoundMediaAudioEffectsInput =
  z.infer<typeof BoundMediaAudioEffectsInputSchema>;
export type MediaAudioEffectsOutput =
  z.infer<typeof MediaAudioEffectsOutputSchema>;

export interface AudioEffectsExecutionOptions {
  readonly expectedInput: ExpectedLocalMediaInput;
  readonly ffmpeg: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly runner: ApplicationProcessRunner;
  readonly transform: AudioEffectsTransformV1;
}

type AudioEffectsExecutor = (
  options: AudioEffectsExecutionOptions,
) => Promise<LocalMediaTransformResult<AudioEffectsTransformV1>>;

type MediaProbeExecutor = (
  ffprobe: string,
  runner: ApplicationProcessRunner,
  path: string,
) => Promise<ProbedMedia>;

export interface MediaAudioEffectsOperationDependencies {
  readonly probe?: MediaProbeExecutor;
  readonly render?: AudioEffectsExecutor;
}

export async function bindMediaAudioEffectsInput(
  application: ApplicationContext,
  input: unknown,
  signal: AbortSignal,
): Promise<BoundMediaAudioEffectsInput> {
  const parsed = MediaAudioEffectsInputSchema.parse(input);
  const [bound, capabilityBindings] = await Promise.all([
    bindRepositoryMedia(
      application,
      parsed.input,
      signal,
      MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
    ),
    bindExpectedMediaCapabilities(
      application,
      ["ffmpeg", "ffprobe"],
      parsed.capabilityBindings,
    ),
  ]);
  return BoundMediaAudioEffectsInputSchema.parse({
    ...parsed,
    capabilityBindings,
    input: bound.artifact,
  });
}

function audioOutputExtension(transform: AudioEffectsTransformV1): string {
  if (transform.output.kind === "preserve-video") {
    return transform.output.profile === "aac" ? ".mp4" : ".mkv";
  }
  switch (transform.output.profile) {
    case "wav-pcm-s16le": return ".wav";
    case "flac": return ".flac";
    case "mp3": return ".mp3";
    case "aac": return ".m4a";
    case "opus": return ".opus";
  }
}

function assertProbeEnvelope(probe: ProbedMedia): void {
  if (
    probe.durationUs <= 0
    || probe.durationUs > MAXIMUM_EFFECT_DURATION_US
    || probe.streams.length > 64
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Media exceeds the local-effects duration or stream-count limit.",
    );
  }
}

function selectedAudioDuration(
  probe: ProbedMedia,
  transform: AudioEffectsTransformV1,
): number {
  assertProbeEnvelope(probe);
  const audioStreams = probe.streams.filter(
    stream => stream.codec_type === "audio",
  );
  const selected = audioStreams[transform.audioStreamIndex];
  if (selected === undefined) {
    throw new ApplicationError(
      "usage",
      `Audio stream ${String(transform.audioStreamIndex)} is out of range.`,
    );
  }
  if (transform.output.kind === "preserve-video") {
    const preserveVideo = transform.output;
    const videoStreams = probe.streams.filter(
      stream => stream.codec_type === "video",
    );
    const selectedVideo = preserveVideo.inputVideoStreamIndex === undefined
      ? videoStreams[preserveVideo.videoStreamIndex]
      : videoStreams.find(
          stream => stream.index === preserveVideo.inputVideoStreamIndex,
        );
    if (selectedVideo === undefined) {
      throw new ApplicationError(
        "usage",
        "The selected preserve-video stream is out of range.",
      );
    }
  }
  return selected.assetRange.endUs - selected.assetRange.startUs;
}

function verifiedAudioDuration(
  probe: ProbedMedia,
  sourceDurationUs: number,
  preserveVideo: boolean,
): number {
  assertProbeEnvelope(probe);
  const audio = probe.streams.find(stream => stream.codec_type === "audio");
  if (audio === undefined) {
    throw new ApplicationError(
      "invalid-data",
      "Derived audio-effects media contains no audio stream.",
    );
  }
  if (
    preserveVideo
    && !probe.streams.some(stream => stream.codec_type === "video")
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Derived preserve-video media contains no video stream.",
    );
  }
  const durationUs = audio.assetRange.endUs - audio.assetRange.startUs;
  if (durationUs + 250_000 < sourceDurationUs) {
    throw new ApplicationError(
      "invalid-data",
      "Derived audio coverage is shorter than the selected source stream.",
    );
  }
  if (durationUs > sourceDurationUs + 31_000_000) {
    throw new ApplicationError(
      "invalid-data",
      "Derived audio exceeds the bounded delay/reverb tail.",
    );
  }
  return durationUs;
}

export function createMediaAudioEffectsOperationDefinition(
  dependencies: MediaAudioEffectsOperationDependencies = {},
): OperationDefinition<
  "media.audio-effects",
  MediaAudioEffectsInput,
  MediaAudioEffectsOutput
> {
  const inspectMedia = dependencies.probe ?? probeProjectMedia;
  const render = dependencies.render ?? (async options =>
    await new LocalMediaEffectsService({
      ffmpeg: options.ffmpeg,
      runner: options.runner,
    }).renderAudio(options));
  return {
    inputSchema: MediaAudioEffectsInputSchema,
    inputSchemaId: "studio.operation.media.audio-effects.input/v1",
    kind: "media.audio-effects",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const parsed = MediaAudioEffectsInputSchema.parse(input);
        const boundMedia = await bindRepositoryMedia(
          context.application,
          parsed.input,
          context.abortSignal,
          MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
        );
        const boundInput = BoundMediaAudioEffectsInputSchema.parse({
          ...parsed,
          input: boundMedia.artifact,
        });
        await assertMediaCapabilities(
          context,
          context.application,
          parsed.capabilityBindings,
          ["ffmpeg", "ffprobe"],
        );
        const capabilityBindings = parsed.capabilityBindings
          ?? await bindMediaCapabilities(
            context.application,
            ["ffmpeg", "ffprobe"],
          );
        const ffmpeg = mediaCapabilityCommand(
          capabilityBindings,
          "ffmpeg",
        );
        const ffprobe = mediaCapabilityCommand(
          capabilityBindings,
          "ffprobe",
        );
        const runner = new AbortBoundApplicationRunner(
          mediaCapabilityRunner(
            context.application,
            capabilityBindings,
          ),
          context.abortSignal,
        );
        const sourceDurationUs = selectedAudioDuration(
          await inspectMedia(ffprobe, runner, boundMedia.absolutePath),
          boundInput.transform,
        );
        const workspace = await createMediaOperationWorkspace(context);
        const stagedPath = join(
          workspace.path,
          `audio-${randomUUID()}${audioOutputExtension(boundInput.transform)}`,
        );
        try {
          const rendered = await render({
            expectedInput: boundMedia.expectedInput,
            ffmpeg,
            inputPath: boundMedia.absolutePath,
            outputPath: stagedPath,
            runner,
            transform: boundInput.transform,
          });
          throwIfAborted(context.abortSignal);
          const durationUs = verifiedAudioDuration(
            await inspectMedia(ffprobe, runner, stagedPath),
            sourceDurationUs,
            boundInput.transform.output.kind === "preserve-video",
          );
          const published = await publishContentAddressedMedia({
            context,
            extension: audioOutputExtension(boundInput.transform),
            maximumBytes: MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
            stagedPath,
          });
          if (
            published.artifact.bytes !== rendered.bytes
            || published.artifact.sha256 !== rendered.sha256
          ) {
            throw new ApplicationError(
              "conflict",
              "Audio-effects service result disagrees with the published bytes.",
            );
          }
          const receiptBody = MediaAudioEffectsReceiptSchema.parse({
            createdAt: context.application.clock.now().toISOString(),
            ffmpegVersion: mediaCapabilityVersion(
              capabilityBindings,
              "ffmpeg",
            ),
            ffprobeVersion: mediaCapabilityVersion(
              capabilityBindings,
              "ffprobe",
            ),
            filterGraph: rendered.filterGraph,
            input: boundInput.input,
            kind: "atet.local-media-transform-receipt",
            operation: "audio-effects",
            output: {
              ...published.artifact,
              durationUs,
            },
            schemaVersion: 1,
            sourceDurationUs,
            transform: rendered.transform,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = MediaAudioEffectsOutputSchema.parse({
            artifact: published.artifact,
            created: published.created,
            durationUs,
            filterGraph: rendered.filterGraph,
            receipt,
            transform: rendered.transform,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId:
              "studio.operation.media.audio-effects.input/v1",
            kind: "media.audio-effects",
            outputSchemaId:
              "studio.operation.media.audio-effects.output/v1",
            version: 1,
          }, output);
          return output;
        } finally {
          await workspace.dispose();
        }
      },
    },
    outputSchema: MediaAudioEffectsOutputSchema,
    outputSchemaId: "studio.operation.media.audio-effects.output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 12 * 60 * 60_000,
      maxFanOut: 0,
      maxInputBytes: 512 * 1024,
      maxOutputBytes: 512 * 1024,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "output-publication" },
      ],
      resume: "verified-receipt",
    },
    receiptReference: output => output.receipt.path,
    summarize: output => ({
      fields: {
        bytes: output.artifact.bytes,
        created: output.created,
        durationUs: output.durationUs,
        effects: output.transform.effects.length,
        path: output.artifact.path,
        receipt: output.receipt.path,
        sha256: output.artifact.sha256,
      },
      kind: "media.audio-effects",
    }),
    version: 1,
  };
}

export const mediaAudioEffectsOperationDefinition =
  createMediaAudioEffectsOperationDefinition();
