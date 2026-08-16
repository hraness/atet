import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import {
  EmojiSelectorSchema,
  OverlayAnchorSchema,
  OverlayAnimationSchema,
  OverlayCropSchema,
  OverlayMaskSchema,
  OverlayMotionSchema,
  OverlayOperationSchema,
  OverlaySizeSchema,
  OverlaySourceSchema,
  PointSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  SourceIntervalSchema,
  VideoAudioPolicySchema,
  type OverlayOperation,
} from "../../../contracts";
import { canonicalJson, canonicalJsonSha256 } from "../../../core/canonical-json";
import {
  buildProjectOutputTimeMap,
  mapProjectIntervalToOutputSlices,
} from "../../../core/project-time";
import { probeVisualMediaSummary } from "../../../cli/analyzer";
import {
  ingestEmojiAsset,
  ingestOverlayAsset,
  inspectPngIntrinsicSize,
  inspectSvgIntrinsicSize,
} from "../../../cli/asset-ingest";
import {
  resolveEmojiAsset,
  type EmojiAssetProvider,
  type EmojiVariant,
} from "../../../cli/emoji-assets";
import { resolveAnimatedPlaybackWindow } from "../../../cli/overlay-playback";
import { GatewayOutputArtifactReferenceSchema } from "../../gateway-port";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { writeOperationCompletionCheckpoint } from "../../operation-completion-checkpoint";
import { openLeasedProjectSnapshot } from "../../project-publication-lease";
import { assertProjectGeneration } from "../../project-store";
import { ProjectReferenceSchema, throwIfAborted } from "../shared";
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
  MediaArtifactReferenceSchema,
  bindRepositoryMedia,
  createMediaOperationWorkspace,
  publishContentAddressedReceipt,
  type MediaArtifactReference,
} from "./shared";

const OverlayArtifactPathRequestSchema = z.strictObject({
  path: RepositoryRelativePathSchema,
});

export const MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES = 512 * 1024 * 1024;

/**
 * Gateway outputs deliberately retain mediaType at the graph boundary. Host
 * binding strips it to the common byte identity before node-plan hashing.
 */
export const MediaOverlayArtifactRequestSchema = z.union([
  OverlayArtifactPathRequestSchema,
  GatewayOutputArtifactReferenceSchema,
  MediaArtifactReferenceSchema,
]);

const AnimatedOverlayPlaybackRequestSchema = z.strictObject({
  endBehavior: z.enum(["hide", "loop", "freeze-end"]).default("hide"),
  playbackRate: z.number().finite().positive().max(64).default(1),
  sourceInUs: z.number().int().safe().nonnegative().default(0),
  sourceOutUs: z.number().int().safe().positive().optional(),
}).prefault({});

export const MediaOverlayResolvedEmojiSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  id: z.string().min(1).max(256),
  provider: z.enum(["apple-emoji-pack", "brand-catalog"]),
  selector: EmojiSelectorSchema,
  variant: z.enum(["color", "duotone"]),
});

const MediaOverlaySourceRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    artifact: MediaOverlayArtifactRequestSchema,
    kind: z.literal("image"),
  }),
  z.strictObject({
    artifact: MediaOverlayArtifactRequestSchema,
    kind: z.literal("svg"),
  }),
  z.strictObject({
    artifact: MediaOverlayArtifactRequestSchema,
    kind: z.literal("gif"),
    playback: AnimatedOverlayPlaybackRequestSchema,
  }),
  z.strictObject({
    artifact: MediaOverlayArtifactRequestSchema,
    audioPolicy: VideoAudioPolicySchema.default({ kind: "mute" }),
    kind: z.literal("video"),
    playback: AnimatedOverlayPlaybackRequestSchema,
  }),
  z.strictObject({
    kind: z.literal("emoji"),
    provider: z.enum(["apple-emoji-pack", "brand-catalog", "auto"]).default("auto"),
    query: z.string().min(1).max(256),
    resolved: MediaOverlayResolvedEmojiSchema.optional(),
    variant: z.enum(["color", "duotone"]).optional(),
  }),
]);

const BoundMediaOverlaySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ artifact: MediaArtifactReferenceSchema, kind: z.literal("image") }),
  z.strictObject({ artifact: MediaArtifactReferenceSchema, kind: z.literal("svg") }),
  z.strictObject({
    artifact: MediaArtifactReferenceSchema,
    kind: z.literal("gif"),
    playback: AnimatedOverlayPlaybackRequestSchema,
  }),
  z.strictObject({
    artifact: MediaArtifactReferenceSchema,
    audioPolicy: VideoAudioPolicySchema,
    kind: z.literal("video"),
    playback: AnimatedOverlayPlaybackRequestSchema,
  }),
  z.strictObject({
    kind: z.literal("emoji"),
    provider: z.enum(["apple-emoji-pack", "brand-catalog", "auto"]),
    query: z.string().min(1).max(256),
    resolved: MediaOverlayResolvedEmojiSchema,
    variant: z.enum(["color", "duotone"]).optional(),
  }),
]);

export const MediaOverlayLayoutSchema = z.strictObject({
  anchor: OverlayAnchorSchema.default("center"),
  blendMode: z.enum([
    "normal",
    "addition",
    "darken",
    "lighten",
    "multiply",
    "overlay",
    "screen",
  ]).default("normal"),
  crop: OverlayCropSchema.default({ kind: "none" }),
  entrance: OverlayAnimationSchema.default({ kind: "none" }),
  exit: OverlayAnimationSchema.default({ kind: "none" }),
  fit: z.enum(["contain", "cover", "fill"]).default("fill"),
  mask: OverlayMaskSchema.default({ kind: "none" }),
  motion: OverlayMotionSchema.default({ kind: "none" }),
  opacity: z.number().finite().min(0).max(1).default(1),
  position: PointSchema.default({ x: 0, y: 0 }),
  rotationDegrees: z.number().finite().min(-3_600).max(3_600).default(0),
  scale: z.number().finite().positive().max(128).default(1),
  size: OverlaySizeSchema.default({ kind: "intrinsic" }),
  zIndex: z.number().int().safe().default(0),
}).prefault({});

export const MediaOverlayInputSchema = z.strictObject({
  capabilityBindings: MediaCapabilityBindingsSchema.optional(),
  identityKey: z.string().min(1).max(128).optional(),
  layout: MediaOverlayLayoutSchema,
  project: ProjectReferenceSchema,
  range: SourceIntervalSchema,
  source: MediaOverlaySourceRequestSchema,
});

export const BoundMediaOverlayInputSchema = MediaOverlayInputSchema.extend({
  source: BoundMediaOverlaySourceSchema,
}).strict();

export const MediaOverlayOutputSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  created: z.boolean(),
  operation: OverlayOperationSchema,
  receipt: MediaArtifactReferenceSchema,
});

export const MediaOverlayReceiptSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  createdAt: z.string().datetime({ offset: true }),
  exactInputSha256: Sha256Schema,
  ffprobeVersion: z.string().min(1).max(256).nullable(),
  kind: z.union([
    z.literal("atet.local-overlay-preparation-receipt"),
    z.literal("studio.local-overlay-preparation-receipt"),
  ]),
  operationSha256: Sha256Schema,
  overlayId: z.string().min(1).max(128),
  projectGenerationSha256: Sha256Schema,
  projectId: ProjectReferenceSchema,
  schemaVersion: z.literal(1),
});

export type MediaOverlayInput = z.infer<typeof MediaOverlayInputSchema>;
export type MediaOverlayInputRequest = z.input<typeof MediaOverlayInputSchema>;
export type BoundMediaOverlayInput = z.infer<typeof BoundMediaOverlayInputSchema>;
export type MediaOverlayOutput = z.infer<typeof MediaOverlayOutputSchema>;

type FileOverlayKind = "gif" | "image" | "svg" | "video";
type OverlayProbe = typeof probeVisualMediaSummary;

export interface MediaOverlayOperationDependencies {
  readonly ingestEmoji?: typeof ingestEmojiAsset;
  readonly ingestFile?: typeof ingestOverlayAsset;
  readonly inspectPng?: typeof inspectPngIntrinsicSize;
  readonly inspectSvg?: typeof inspectSvgIntrinsicSize;
  readonly probe?: OverlayProbe;
  readonly resolveEmoji?: typeof resolveEmojiAsset;
}

function emojiSelector(query: string): z.infer<typeof EmojiSelectorSchema> {
  const normalized = query.trim().toLocaleLowerCase()
    .replaceAll("u+", "")
    .replaceAll(/[_\s]+/gu, "-");
  if (/^[a-f0-9]+(?:-[a-f0-9]+)*$/u.test(normalized)) {
    return { kind: "id", value: normalized };
  }
  if ([...query].length <= 16 && /[^\p{L}\p{N}\p{P}\p{Z}]/u.test(query)) {
    return { kind: "unicode", value: query };
  }
  return { kind: "name", value: query };
}

function normalizedArtifact(
  input: z.infer<typeof MediaOverlayArtifactRequestSchema>,
): z.infer<typeof OverlayArtifactPathRequestSchema> | MediaArtifactReference {
  if (!("bytes" in input)) return input;
  return MediaArtifactReferenceSchema.parse({
    bytes: input.bytes,
    path: input.path,
    sha256: input.sha256,
  });
}

function capabilityNames(
  source: z.infer<typeof MediaOverlaySourceRequestSchema>,
): readonly ["ffprobe"] | readonly [] {
  return source.kind === "image"
    || source.kind === "gif"
    || source.kind === "video"
    ? ["ffprobe"]
    : [];
}

function defaultEmojiVariant(
  provider: EmojiAssetProvider | "auto",
  variant: EmojiVariant | undefined,
): EmojiVariant {
  return variant ?? (provider === "brand-catalog" ? "duotone" : "color");
}

async function bindEmojiSource(
  application: ApplicationContext,
  source: Extract<
    z.infer<typeof MediaOverlaySourceRequestSchema>,
    { readonly kind: "emoji" }
  >,
  signal: AbortSignal,
  resolveEmoji: typeof resolveEmojiAsset,
): Promise<z.infer<typeof BoundMediaOverlaySourceSchema>> {
  const resolved = await resolveEmoji(
    application.paths.repositoryRoot,
    source.query,
    defaultEmojiVariant(source.provider, source.variant),
    source.provider,
  );
  const path = relative(application.paths.repositoryRoot, resolved.path);
  const bound = await bindRepositoryMedia(
    application,
    { path },
    signal,
    MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES,
  );
  if (bound.artifact.sha256 !== resolved.sha256) {
    throw new ApplicationError(
      "conflict",
      "Resolved emoji bytes disagree with the checked emoji catalog.",
    );
  }
  const exact = MediaOverlayResolvedEmojiSchema.parse({
    artifact: bound.artifact,
    id: resolved.id,
    provider: resolved.provider,
    selector: emojiSelector(source.query),
    variant: resolved.variant,
  });
  if (
    source.resolved !== undefined
    && canonicalJson(source.resolved) !== canonicalJson(exact)
  ) {
    throw new ApplicationError(
      "conflict",
      "The checked emoji asset changed after exact node planning.",
    );
  }
  return BoundMediaOverlaySourceSchema.parse({ ...source, resolved: exact });
}

export async function bindMediaOverlayInput(
  application: ApplicationContext,
  input: unknown,
  signal: AbortSignal,
  dependencies: Pick<MediaOverlayOperationDependencies, "resolveEmoji"> = {},
): Promise<BoundMediaOverlayInput> {
  const parsed = MediaOverlayInputSchema.parse(input);
  const names = capabilityNames(parsed.source);
  const sourcePromise = parsed.source.kind === "emoji"
    ? bindEmojiSource(
        application,
        parsed.source,
        signal,
        dependencies.resolveEmoji ?? resolveEmojiAsset,
      )
    : bindRepositoryMedia(
        application,
        normalizedArtifact(parsed.source.artifact),
        signal,
        MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES,
      ).then(bound => ({ ...parsed.source, artifact: bound.artifact }));
  const [source, capabilityBindings] = await Promise.all([
    sourcePromise,
    bindExpectedMediaCapabilities(
      application,
      names,
      parsed.capabilityBindings,
    ),
  ]);
  return BoundMediaOverlayInputSchema.parse({
    ...parsed,
    capabilityBindings,
    source,
  });
}

function assertProjectRelativeAssetPath(
  projectDirectory: string,
  path: string,
): string {
  const absolute = resolve(projectDirectory, path);
  const fromProject = relative(resolve(projectDirectory), absolute);
  if (
    fromProject === ""
    || fromProject.startsWith("..")
    || isAbsolute(fromProject)
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Prepared overlay asset escaped its project bundle.",
    );
  }
  return absolute;
}

function operationId(
  input: BoundMediaOverlayInput,
  source: unknown,
  intrinsicSize: OverlayOperation["intrinsicSize"],
): string {
  const parsedSource = OverlaySourceSchema.parse(source);
  const asset = {
    bytes: parsedSource.asset.bytes,
    mediaType: parsedSource.asset.mediaType,
    sha256: parsedSource.asset.sha256,
  };
  const sourceIdentity =
    parsedSource.kind === "image" || parsedSource.kind === "svg"
      ? { asset, kind: parsedSource.kind }
      : parsedSource.kind === "emoji"
        ? {
            asset,
            kind: parsedSource.kind,
            provider: parsedSource.provider,
            selector: parsedSource.selector,
          }
        : {
            asset,
            audioPolicy: parsedSource.audioPolicy,
            kind: parsedSource.kind,
            playback: parsedSource.playback,
          };
  return `overlay_${canonicalJsonSha256({
    domain: "studio.media-overlay-operation/v1",
    identityKey: input.identityKey ?? null,
    intrinsicSize,
    layout: input.layout,
    project: input.project,
    range: input.range,
    source: sourceIdentity,
  }).slice(0, 32)}`;
}

export function createMediaOverlayOperationDefinition(
  dependencies: MediaOverlayOperationDependencies = {},
): OperationDefinition<"media.overlay", MediaOverlayInput, MediaOverlayOutput> {
  const ingestFile = dependencies.ingestFile ?? ingestOverlayAsset;
  const ingestEmoji = dependencies.ingestEmoji ?? ingestEmojiAsset;
  const inspectPng = dependencies.inspectPng ?? inspectPngIntrinsicSize;
  const inspectSvg = dependencies.inspectSvg ?? inspectSvgIntrinsicSize;
  const probe = dependencies.probe ?? probeVisualMediaSummary;
  const resolveEmoji = dependencies.resolveEmoji ?? resolveEmojiAsset;
  return {
    inputSchema: MediaOverlayInputSchema,
    inputSchemaId: "atet.operation.media.overlay.input/v1",
    kind: "media.overlay",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const boundInput = await bindMediaOverlayInput(
          context.application,
          input,
          context.abortSignal,
          { resolveEmoji },
        );
        const names = capabilityNames(boundInput.source);
        await assertMediaCapabilities(
          context,
          context.application,
          boundInput.capabilityBindings,
          names,
        );
        const bindings = boundInput.capabilityBindings
          ?? await bindMediaCapabilities(context.application, names);
        const snapshot = await openLeasedProjectSnapshot(
          context.application,
          boundInput.project,
        );
        assertProjectGeneration(
          context.expectedProjectGeneration,
          snapshot.generation,
        );
        if (boundInput.range.endUs > snapshot.plan.timelineDurationUs) {
          throw new ApplicationError(
            "usage",
            "Overlay range exceeds the project timeline.",
          );
        }
        const outputDurationUs = mapProjectIntervalToOutputSlices(
          buildProjectOutputTimeMap(snapshot.plan),
          boundInput.range,
        ).reduce(
          (total, slice) =>
            total + slice.output.endUs - slice.output.startUs,
          0,
        );
        if (outputDurationUs <= 0) {
          throw new ApplicationError(
            "conflict",
            "Overlay range has no visible kept output time.",
          );
        }
        const fileSource = boundInput.source.kind === "emoji"
          ? undefined
          : await bindRepositoryMedia(
              context.application,
              boundInput.source.artifact,
              context.abortSignal,
              MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES,
            );
        const emojiSource = boundInput.source.kind === "emoji"
          ? boundInput.source
          : undefined;
        const resolvedEmoji = emojiSource === undefined
          ? undefined
          : await resolveEmoji(
              context.application.paths.repositoryRoot,
              emojiSource.query,
              defaultEmojiVariant(
                emojiSource.provider,
                emojiSource.variant,
              ),
              emojiSource.provider,
            );
        if (
          resolvedEmoji !== undefined
          && emojiSource !== undefined
          && (
            resolvedEmoji.id !== emojiSource.resolved.id
            || resolvedEmoji.provider !== emojiSource.resolved.provider
            || resolvedEmoji.variant !== emojiSource.resolved.variant
            || resolvedEmoji.sha256 !== emojiSource.resolved.artifact.sha256
          )
        ) {
          throw new ApplicationError(
            "conflict",
            "Resolved emoji changed immediately before preparation.",
          );
        }
        const workspace = await createMediaOperationWorkspace(context);
        try {
          await context.workflow?.beforePublication();
          throwIfAborted(context.abortSignal);
          const ingested = resolvedEmoji === undefined
            ? await ingestFile(
                snapshot.openProject.directory.path,
                fileSource!.absolutePath,
                boundInput.source.kind as FileOverlayKind,
              )
            : await ingestEmoji(
                snapshot.openProject.directory.path,
                resolvedEmoji,
              );
          const exactSourceArtifact = fileSource?.artifact
            ?? emojiSource!.resolved.artifact;
          if (
            ingested.bytes !== exactSourceArtifact.bytes
            || ingested.sha256 !== exactSourceArtifact.sha256
            || ingested.provenance.sourceSha256 !== exactSourceArtifact.sha256
          ) {
            throw new ApplicationError(
              "conflict",
              "Prepared overlay bytes disagree with the exact bound source.",
            );
          }
          const assetPath = assertProjectRelativeAssetPath(
            snapshot.openProject.directory.path,
            ingested.path,
          );
          const artifact = (
            await bindRepositoryMedia(
              context.application,
              {
                path: relative(
                  context.application.paths.repositoryRoot,
                  assetPath,
                ),
              },
              context.abortSignal,
              MAXIMUM_MEDIA_OVERLAY_INPUT_BYTES,
            )
          ).artifact;
          if (
            artifact.bytes !== ingested.bytes
            || artifact.sha256 !== ingested.sha256
          ) {
            throw new ApplicationError(
              "conflict",
              "Prepared project asset disagrees with its published bytes.",
            );
          }
          const visual = ingested.mediaType === "image/svg+xml"
            ? {
                ...await inspectSvg(assetPath),
                audioEndUs: null,
                audioStartUs: 0,
                audioStreamIndex: null,
                durationUs: null,
                hasAudio: false,
                videoStartUs: 0,
                videoStreamIndex: null,
              }
            : boundInput.source.kind === "emoji"
              ? {
                  ...await inspectPng(assetPath),
                  audioEndUs: null,
                  audioStartUs: 0,
                  audioStreamIndex: null,
                  durationUs: null,
                  hasAudio: false,
                  videoStartUs: 0,
                  videoStreamIndex: null,
                }
              : await probe(
                  mediaCapabilityCommand(bindings, "ffprobe"),
                  new AbortBoundApplicationRunner(
                    mediaCapabilityRunner(context.application, bindings),
                    context.abortSignal,
                  ),
                  assetPath,
                );
          const intrinsicSize = {
            height: "pixelHeight" in visual ? visual.pixelHeight : visual.height,
            width: "pixelWidth" in visual ? visual.pixelWidth : visual.width,
          };
          const asset = {
            bytes: ingested.bytes,
            mediaType: ingested.mediaType,
            path: ingested.path,
            provenance: ingested.provenance,
            sha256: ingested.sha256,
          };
          let source: unknown;
          if (
            boundInput.source.kind === "image"
            || boundInput.source.kind === "svg"
          ) {
            source = {
              asset,
              kind: boundInput.source.kind,
            };
          } else if (boundInput.source.kind === "emoji") {
            source = {
              asset,
              kind: "emoji",
              provider: boundInput.source.resolved.provider,
              selector: boundInput.source.resolved.selector,
            };
          } else {
            if (visual.durationUs === null || visual.durationUs <= 0) {
              throw new ApplicationError(
                "invalid-data",
                "Animated overlay media must report a positive duration.",
              );
            }
            const playbackWindow = resolveAnimatedPlaybackWindow({
              mediaDurationUs: visual.durationUs,
              outputDurationUs,
              playbackRate: boundInput.source.playback.playbackRate,
              sourceInUs: boundInput.source.playback.sourceInUs,
              sourceOutUs: boundInput.source.playback.sourceOutUs,
            });
            const playback = {
              audioEndUs: visual.audioEndUs,
              audioStartUs: visual.audioStartUs,
              audioStreamIndex: visual.audioStreamIndex,
              endBehavior: boundInput.source.playback.endBehavior,
              playbackRate: boundInput.source.playback.playbackRate,
              streamStartUs: visual.videoStartUs,
              videoStreamIndex: visual.videoStreamIndex,
              ...playbackWindow,
            };
            if (boundInput.source.kind === "gif") {
              source = {
                asset,
                audioPolicy: { kind: "mute" },
                kind: "gif",
                playback,
              };
            } else {
              if (
                boundInput.source.audioPolicy.kind !== "mute"
                && !visual.hasAudio
              ) {
                throw new ApplicationError(
                  "conflict",
                  "The selected video overlay audio policy requires an audio stream.",
                );
              }
              source = {
                asset,
                audioPolicy: boundInput.source.audioPolicy,
                kind: "video",
                playback,
              };
            }
          }
          const operation = OverlayOperationSchema.parse({
            ...boundInput.layout,
            coordinateSpace: "output-pixels",
            intrinsicSize,
            overlayId: operationId(boundInput, source, intrinsicSize),
            range: boundInput.range,
            source,
          });
          const receiptBody = MediaOverlayReceiptSchema.parse({
            artifact,
            createdAt: context.application.clock.now().toISOString(),
            exactInputSha256: canonicalJsonSha256(boundInput),
            ffprobeVersion: names.length === 0
              ? null
              : mediaCapabilityVersion(bindings, "ffprobe"),
            kind: "atet.local-overlay-preparation-receipt",
            operationSha256: canonicalJsonSha256(operation),
            overlayId: operation.overlayId,
            projectGenerationSha256: snapshot.generation.generationSha256,
            projectId: snapshot.project.projectId,
            schemaVersion: 1,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = MediaOverlayOutputSchema.parse({
            artifact,
            created: ingested.created,
            operation,
            receipt,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "atet.operation.media.overlay.input/v1",
            kind: "media.overlay",
            outputSchemaId: "atet.operation.media.overlay.output/v1",
            version: 1,
          }, output);
          return output;
        } finally {
          await workspace.dispose();
        }
      },
    },
    outputSchema: MediaOverlayOutputSchema,
    outputSchemaId: "atet.operation.media.overlay.output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 60 * 60_000,
      maxFanOut: 0,
      maxInputBytes: 256 * 1024,
      maxOutputBytes: 2 * 1024 * 1024,
      preparation: ["project-state", "local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
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
        kind: output.operation.source.kind,
        overlayId: output.operation.overlayId,
        receipt: output.receipt.path,
        sha256: output.artifact.sha256,
      },
      kind: "media.overlay",
    }),
    version: 1,
  };
}

export const mediaOverlayOperationDefinition =
  createMediaOverlayOperationDefinition();
