import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  ColorGradeTransformV1Schema,
  type ColorGradeTransformV1,
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

export const MediaColorGradeReceiptSchema = z.strictObject({
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
  operation: z.literal("color-grade"),
  output: MediaArtifactReferenceSchema.extend({
    durationUs: z.number().int().safe().positive(),
  }).strict(),
  schemaVersion: z.literal(1),
  sourceDurationUs: z.number().int().safe().positive(),
  transform: ColorGradeTransformV1Schema,
});

export const MediaColorGradeInputSchema = z.strictObject({
  capabilityBindings: MediaCapabilityBindingsSchema.optional(),
  input: MediaArtifactRequestSchema,
  transform: ColorGradeTransformV1Schema,
});

export const BoundMediaColorGradeInputSchema =
  MediaColorGradeInputSchema.extend({
    input: MediaArtifactReferenceSchema,
  }).strict();

export const MediaColorGradeOutputSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  created: z.boolean(),
  durationUs: z.number().int().safe().positive(),
  filterGraph: z.string().min(1).max(256 * 1024),
  receipt: MediaArtifactReferenceSchema,
  transform: ColorGradeTransformV1Schema,
});

export type MediaColorGradeInput = z.infer<typeof MediaColorGradeInputSchema>;
export type BoundMediaColorGradeInput =
  z.infer<typeof BoundMediaColorGradeInputSchema>;
export type MediaColorGradeOutput =
  z.infer<typeof MediaColorGradeOutputSchema>;

export interface ColorGradeExecutionOptions {
  readonly expectedInput: ExpectedLocalMediaInput;
  readonly ffmpeg: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly runner: ApplicationProcessRunner;
  readonly transform: ColorGradeTransformV1;
}

type ColorGradeExecutor = (
  options: ColorGradeExecutionOptions,
) => Promise<LocalMediaTransformResult<ColorGradeTransformV1>>;

type MediaProbeExecutor = (
  ffprobe: string,
  runner: ApplicationProcessRunner,
  path: string,
) => Promise<ProbedMedia>;

export interface MediaColorGradeOperationDependencies {
  readonly probe?: MediaProbeExecutor;
  readonly render?: ColorGradeExecutor;
}

export async function bindMediaColorGradeInput(
  application: ApplicationContext,
  input: unknown,
  signal: AbortSignal,
): Promise<BoundMediaColorGradeInput> {
  const parsed = MediaColorGradeInputSchema.parse(input);
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
  return BoundMediaColorGradeInputSchema.parse({
    ...parsed,
    capabilityBindings,
    input: bound.artifact,
  });
}

function colorOutputExtension(transform: ColorGradeTransformV1): string {
  switch (transform.outputProfile) {
    case "h264-mp4": return ".mp4";
    case "prores-mov": return ".mov";
    case "vp9-webm": return ".webm";
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

function selectedVideoDuration(
  probe: ProbedMedia,
  transform: ColorGradeTransformV1,
): number {
  assertProbeEnvelope(probe);
  const videoStreams = probe.streams.filter(
    stream => stream.codec_type === "video",
  );
  const selected = transform.inputStreamIndex === undefined
    ? videoStreams[transform.videoStreamIndex]
    : videoStreams.find(stream => stream.index === transform.inputStreamIndex);
  if (selected === undefined) {
    throw new ApplicationError(
      "usage",
      "The selected color-grade video stream is out of range.",
    );
  }
  return selected.assetRange.endUs - selected.assetRange.startUs;
}

function verifiedVideoDuration(
  probe: ProbedMedia,
  sourceDurationUs: number,
): number {
  assertProbeEnvelope(probe);
  const video = probe.streams.find(stream => stream.codec_type === "video");
  if (video === undefined) {
    throw new ApplicationError(
      "invalid-data",
      "Color-graded media contains no video stream.",
    );
  }
  const durationUs = video.assetRange.endUs - video.assetRange.startUs;
  if (
    durationUs + 250_000 < sourceDurationUs
    || durationUs > sourceDurationUs + 250_000
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Color-graded coverage differs from the selected source stream.",
    );
  }
  return durationUs;
}

export function createMediaColorGradeOperationDefinition(
  dependencies: MediaColorGradeOperationDependencies = {},
): OperationDefinition<
  "media.color-grade",
  MediaColorGradeInput,
  MediaColorGradeOutput
> {
  const inspectMedia = dependencies.probe ?? probeProjectMedia;
  const render = dependencies.render ?? (async options =>
    await new LocalMediaEffectsService({
      ffmpeg: options.ffmpeg,
      runner: options.runner,
    }).renderColor(options));
  return {
    inputSchema: MediaColorGradeInputSchema,
    inputSchemaId: "studio.operation.media.color-grade.input/v1",
    kind: "media.color-grade",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const parsed = MediaColorGradeInputSchema.parse(input);
        const boundMedia = await bindRepositoryMedia(
          context.application,
          parsed.input,
          context.abortSignal,
          MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
        );
        const boundInput = BoundMediaColorGradeInputSchema.parse({
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
        const sourceDurationUs = selectedVideoDuration(
          await inspectMedia(ffprobe, runner, boundMedia.absolutePath),
          boundInput.transform,
        );
        const workspace = await createMediaOperationWorkspace(context);
        const stagedPath = join(
          workspace.path,
          `color-${randomUUID()}${colorOutputExtension(boundInput.transform)}`,
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
          const durationUs = verifiedVideoDuration(
            await inspectMedia(ffprobe, runner, stagedPath),
            sourceDurationUs,
          );
          const published = await publishContentAddressedMedia({
            context,
            extension: colorOutputExtension(boundInput.transform),
            maximumBytes: MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
            stagedPath,
          });
          if (
            published.artifact.bytes !== rendered.bytes
            || published.artifact.sha256 !== rendered.sha256
          ) {
            throw new ApplicationError(
              "conflict",
              "Color-grade service result disagrees with the published bytes.",
            );
          }
          const receiptBody = MediaColorGradeReceiptSchema.parse({
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
            operation: "color-grade",
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
          const output = MediaColorGradeOutputSchema.parse({
            artifact: published.artifact,
            created: published.created,
            durationUs,
            filterGraph: rendered.filterGraph,
            receipt,
            transform: rendered.transform,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId:
              "studio.operation.media.color-grade.input/v1",
            kind: "media.color-grade",
            outputSchemaId:
              "studio.operation.media.color-grade.output/v1",
            version: 1,
          }, output);
          return output;
        } finally {
          await workspace.dispose();
        }
      },
    },
    outputSchema: MediaColorGradeOutputSchema,
    outputSchemaId: "studio.operation.media.color-grade.output/v1",
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
        path: output.artifact.path,
        profile: output.transform.outputProfile,
        receipt: output.receipt.path,
        sha256: output.artifact.sha256,
      },
      kind: "media.color-grade",
    }),
    version: 1,
  };
}

export const mediaColorGradeOperationDefinition =
  createMediaColorGradeOperationDefinition();
