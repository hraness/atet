import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import { z } from "zod";

import {
  OverlayOperationSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  SourceIntervalSchema,
  type OverlayOperation,
} from "../../../contracts";
import {
  buildProjectOutputTimeMap,
  canonicalJsonSha256,
  mapProjectIntervalToOutputSlices,
} from "../../../core";
import {
  HtmlOverlayAuthoringInputSchema,
  HtmlOverlayCanvasSchema,
  HtmlOverlayDeclaredResourceSchema,
  HtmlOverlayDeclaredResourcesSchema,
  HtmlOverlayInlineDocumentSchema,
  HtmlOverlayLibraryLocksSchema,
  HtmlOverlayLibrarySelectionSchema,
  HtmlOverlayParametersSchema,
  HtmlOverlayTimingSchema,
  htmlOverlayFrameCount,
  type HtmlOverlayAuthoringInput,
} from "../../../html-overlay";
import { probeVisualMediaSummary } from "../../../cli/analyzer";
import { ingestGeneratedVideoOverlayAsset } from "../../../cli/asset-ingest";
import { resolveAnimatedPlaybackWindow } from "../../../cli/overlay-playback";
import type { ApplicationContext } from "../../context";
import { exactCapabilityByName } from "../../capability-binding";
import { ApplicationError } from "../../errors";
import { GatewayOutputArtifactReferenceSchema } from "../../gateway-port";
import { bindHtmlOverlayBrowserRuntime } from "../../html-overlay-browser-runtime";
import {
  HtmlOverlayExecutionIntegritySchema,
  createHtmlOverlayExecutionBundle,
} from "../../html-overlay-integrity";
import {
  ATET_APPLICATION_TOOL_VERSION,
  type OperationDefinition,
} from "../../operation";
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
  MediaArtifactReferenceSchema,
  MediaArtifactRequestSchema,
  AbortBoundApplicationRunner,
  bindRepositoryMedia,
  createMediaOperationWorkspace,
  loadRepositoryMedia,
  publishContentAddressedReceipt,
} from "./shared";
import {
  MediaOverlayLayoutSchema,
  MediaOverlayOutputSchema,
  type MediaOverlayOutput,
} from "./overlay";

export const MAXIMUM_HTML_OVERLAY_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAXIMUM_HTML_OVERLAY_RESOURCE_BYTES = 128 * 1024 * 1024;
export const MAXIMUM_HTML_OVERLAY_OUTPUT_BYTES = 512 * 1024 * 1024;
const HTML_OVERLAY_CAPABILITIES = [
  "ffmpeg",
  "ffprobe",
  "html-browser",
] as const;

const HtmlOverlayDocumentRequestSchema = z.union([
  HtmlOverlayInlineDocumentSchema,
  z.strictObject({ path: RepositoryRelativePathSchema }),
  MediaArtifactReferenceSchema,
]);

const BoundHtmlOverlayDocumentSchema = z.union([
  HtmlOverlayInlineDocumentSchema,
  MediaArtifactReferenceSchema,
]);

const HtmlOverlayResourceArtifactRequestSchema = z.union([
  MediaArtifactRequestSchema,
  GatewayOutputArtifactReferenceSchema,
]);

const HtmlOverlayResourceRequestSchema = HtmlOverlayDeclaredResourceSchema
  .omit({ bytes: true, sha256: true })
  .extend({ artifact: HtmlOverlayResourceArtifactRequestSchema })
  .strict();

const BoundHtmlOverlayResourceRequestSchema =
  HtmlOverlayDeclaredResourceSchema
    .extend({ artifact: MediaArtifactReferenceSchema })
    .strict();

export const HtmlOverlayInputSchema = z.strictObject({
  canvas: HtmlOverlayCanvasSchema,
  capabilityBindings: MediaCapabilityBindingsSchema.optional(),
  document: HtmlOverlayDocumentRequestSchema,
  identityKey: z.string().min(1).max(128).optional(),
  layout: MediaOverlayLayoutSchema,
  libraries: HtmlOverlayLibrarySelectionSchema.default([]),
  parameters: HtmlOverlayParametersSchema.default({}),
  project: ProjectReferenceSchema,
  range: SourceIntervalSchema,
  resources: z.array(HtmlOverlayResourceRequestSchema).max(64).default([]),
  seed: z.number().int().min(0).max(0xffff_ffff).default(0),
  timing: HtmlOverlayTimingSchema,
});

export const BoundHtmlOverlayInputSchema = HtmlOverlayInputSchema
  .omit({ document: true, resources: true })
  .extend({
    document: BoundHtmlOverlayDocumentSchema,
    resources: z.array(BoundHtmlOverlayResourceRequestSchema).max(64),
  })
  .strict();

export const HtmlOverlayReceiptSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  browserVersion: z.string().min(1).max(512),
  createdAt: z.string().datetime({ offset: true }),
  // Optional only so persisted v1 Atet receipts remain readable after the
  // product rename. Every new Atet render publishes this evidence.
  executionIntegrity: HtmlOverlayExecutionIntegritySchema.optional(),
  exactInputSha256: Sha256Schema,
  ffmpegVersion: z.string().min(1).max(512),
  ffprobeVersion: z.string().min(1).max(512),
  frameCount: z.number().int().safe().positive(),
  kind: z.union([
    z.literal("atet.html-overlay-preparation-receipt"),
    z.literal("studio.html-overlay-preparation-receipt"),
  ]),
  libraryLocks: HtmlOverlayLibraryLocksSchema,
  libraryLocksSha256: Sha256Schema,
  operationSha256: Sha256Schema,
  overlayId: z.string().min(1).max(128),
  projectGenerationSha256: Sha256Schema,
  projectId: ProjectReferenceSchema,
  schemaVersion: z.literal(1),
});

export const HtmlOverlayOutputSchema = MediaOverlayOutputSchema;

export type HtmlOverlayInput = z.infer<typeof HtmlOverlayInputSchema>;
export type HtmlOverlayInputRequest = z.input<typeof HtmlOverlayInputSchema>;
export type BoundHtmlOverlayInput = z.infer<typeof BoundHtmlOverlayInputSchema>;
export type HtmlOverlayOutput = MediaOverlayOutput;

export interface HtmlOverlayOperationDependencies {
  readonly bindBrowserRuntime?: typeof bindHtmlOverlayBrowserRuntime;
  readonly ingest?: typeof ingestGeneratedVideoOverlayAsset;
  readonly probe?: typeof probeVisualMediaSummary;
  readonly toolVersion?: string;
}

function normalizeHtmlOverlayResourceArtifact(
  resource: z.infer<typeof HtmlOverlayResourceRequestSchema>,
): z.infer<typeof MediaArtifactRequestSchema> {
  if (!("mediaType" in resource.artifact)) return resource.artifact;
  if (resource.artifact.mediaType !== resource.mediaType) {
    throw new ApplicationError(
      "invalid-data",
      `HTML overlay resource ${resource.name} declares ${resource.mediaType} but its generated artifact is ${resource.artifact.mediaType}.`,
    );
  }
  return MediaArtifactReferenceSchema.parse({
    bytes: resource.artifact.bytes,
    path: resource.artifact.path,
    sha256: resource.artifact.sha256,
  });
}

async function bindHtmlOverlayDocument(
  application: ApplicationContext,
  document: z.infer<typeof HtmlOverlayDocumentRequestSchema>,
  signal: AbortSignal,
): Promise<z.infer<typeof BoundHtmlOverlayDocumentSchema>> {
  if ("html" in document) return document;
  return (
    await bindRepositoryMedia(
      application,
      document,
      signal,
      MAXIMUM_HTML_OVERLAY_DOCUMENT_BYTES,
    )
  ).artifact;
}

function visibleOutputDurationUs(
  plan: Parameters<typeof buildProjectOutputTimeMap>[0],
  range: z.infer<typeof SourceIntervalSchema>,
): number {
  return mapProjectIntervalToOutputSlices(
    buildProjectOutputTimeMap(plan),
    range,
  ).reduce(
    (total, slice) => total + slice.output.endUs - slice.output.startUs,
    0,
  );
}

export async function bindHtmlOverlayInput(
  application: ApplicationContext,
  input: unknown,
  signal: AbortSignal,
): Promise<BoundHtmlOverlayInput> {
  const parsed = HtmlOverlayInputSchema.parse(input);
  const [document, resources, capabilityBindings] = await Promise.all([
    bindHtmlOverlayDocument(
      application,
      parsed.document,
      signal,
    ),
    Promise.all(parsed.resources.map(async resource => ({
      ...resource,
      artifact: (
        await bindRepositoryMedia(
          application,
          normalizeHtmlOverlayResourceArtifact(resource),
          signal,
          MAXIMUM_HTML_OVERLAY_RESOURCE_BYTES,
        )
      ).artifact,
    }))),
    bindExpectedMediaCapabilities(
      application,
      HTML_OVERLAY_CAPABILITIES,
      parsed.capabilityBindings,
    ),
  ]);
  const exactResources = HtmlOverlayDeclaredResourcesSchema.parse(
    resources.map(({ artifact, ...resource }) => ({
      ...resource,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
  );
  const artifactByResourceName = new Map(
    resources.map(resource => [resource.name, resource.artifact] as const),
  );
  return BoundHtmlOverlayInputSchema.parse({
    ...parsed,
    capabilityBindings,
    document,
    resources: exactResources.map(resource => ({
      ...resource,
      artifact: artifactByResourceName.get(resource.name),
    })),
  });
}

function decodeHtml(bytes: Uint8Array): string {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApplicationError(
      "invalid-data",
      "The HTML overlay document must be valid UTF-8.",
    );
  }
  if (html.trim() === "") {
    throw new ApplicationError("invalid-data", "The HTML overlay document is empty.");
  }
  return html;
}

async function sha256PhysicalFile(
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0) {
      throw new ApplicationError("invalid-data", "Rendered HTML overlay is empty.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      throwIfAborted(signal);
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        "Rendered HTML overlay changed while it was being verified.",
      );
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

const AlphaVideoProbeSchema = z.object({
  streams: z.array(z.object({
    codec_name: z.string(),
    height: z.number().int().positive(),
    pix_fmt: z.string(),
    width: z.number().int().positive(),
  })).min(1),
});

async function assertAlphaVideo(
  application: ApplicationContext,
  bindings: NonNullable<BoundHtmlOverlayInput["capabilityBindings"]>,
  path: string,
  canvas: BoundHtmlOverlayInput["canvas"],
  signal: AbortSignal,
): Promise<void> {
  const result = await new AbortBoundApplicationRunner(
    mediaCapabilityRunner(application, bindings),
    signal,
  ).run([
    mediaCapabilityCommand(bindings, "ffprobe"),
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt,width,height",
    "-of",
    "json",
    path,
  ], {
    maxOutputBytes: 64 * 1024,
    stdin: "ignore",
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new ApplicationError(
      "invalid-data",
      "Rendered HTML overlay could not be inspected as an alpha video.",
    );
  }
  let unknown: unknown;
  try {
    unknown = JSON.parse(result.stdout);
  } catch {
    throw new ApplicationError(
      "invalid-data",
      "Rendered HTML overlay inspection returned invalid JSON.",
    );
  }
  const stream = AlphaVideoProbeSchema.parse(unknown).streams[0]!;
  if (
    stream.codec_name !== "qtrle"
    || stream.pix_fmt !== "argb"
    || stream.width !== canvas.width
    || stream.height !== canvas.height
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Rendered HTML overlay must be a canvas-sized qtrle/argb alpha video.",
      { stream },
    );
  }
}

function overlayOperationId(
  input: BoundHtmlOverlayInput,
  authoring: HtmlOverlayAuthoringInput,
  assetSha256: string,
): string {
  return `overlay_${canonicalJsonSha256({
    assetSha256,
    authoring,
    domain: "studio.media-html-overlay-operation/v1",
    identityKey: input.identityKey ?? null,
    layout: input.layout,
    project: input.project,
    range: input.range,
  }).slice(0, 32)}`;
}

export function createHtmlOverlayOperationDefinition(
  dependencies: HtmlOverlayOperationDependencies = {},
): OperationDefinition<"media.html-overlay", HtmlOverlayInput, HtmlOverlayOutput> {
  const ingest = dependencies.ingest ?? ingestGeneratedVideoOverlayAsset;
  const probe = dependencies.probe ?? probeVisualMediaSummary;
  const bindBrowserRuntime = dependencies.bindBrowserRuntime
    ?? bindHtmlOverlayBrowserRuntime;
  const toolVersion = dependencies.toolVersion ?? ATET_APPLICATION_TOOL_VERSION;
  return {
    inputSchema: HtmlOverlayInputSchema,
    inputSchemaId: "atet.operation.media.html-overlay.input/v1",
    kind: "media.html-overlay",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const boundInput = await bindHtmlOverlayInput(
          context.application,
          input,
          context.abortSignal,
        );
        await assertMediaCapabilities(
          context,
          context.application,
          boundInput.capabilityBindings,
          HTML_OVERLAY_CAPABILITIES,
        );
        const bindings = boundInput.capabilityBindings
          ?? await bindMediaCapabilities(
            context.application,
            HTML_OVERLAY_CAPABILITIES,
          );
        const renderer = context.application.htmlOverlayRenderer;
        if (renderer === undefined) {
          throw new ApplicationError(
            "unavailable",
            "This Atet host does not provide an HTML-overlay browser renderer.",
          );
        }
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
            "HTML overlay range exceeds the project timeline.",
          );
        }
        const outputDurationUs = visibleOutputDurationUs(
          snapshot.plan,
          boundInput.range,
        );
        if (outputDurationUs <= 0) {
          throw new ApplicationError(
            "conflict",
            "HTML overlay range has no visible kept output time.",
          );
        }
        if (boundInput.timing.durationUs !== outputDurationUs) {
          throw new ApplicationError(
            "conflict",
            "HTML overlay timing duration must equal the range's visible output duration.",
            {
              actualDurationUs: boundInput.timing.durationUs,
              expectedDurationUs: outputDurationUs,
            },
          );
        }
        const [html, resources] = await Promise.all([
          "html" in boundInput.document
            ? Promise.resolve(boundInput.document.html)
            : loadRepositoryMedia(
                context.application,
                boundInput.document,
                context.abortSignal,
                MAXIMUM_HTML_OVERLAY_DOCUMENT_BYTES,
              ).then(document => decodeHtml(document.data)),
          Promise.all(boundInput.resources.map(async resource => ({
            ...resource,
            absolutePath: (
              await bindRepositoryMedia(
                context.application,
                resource.artifact,
                context.abortSignal,
                MAXIMUM_HTML_OVERLAY_RESOURCE_BYTES,
              )
            ).absolutePath,
          }))),
        ]);
        const authoring = HtmlOverlayAuthoringInputSchema.parse({
          canvas: boundInput.canvas,
          html,
          kind: "atet.html-overlay",
          libraries: boundInput.libraries,
          parameters: boundInput.parameters,
          resources: resources.map(resource => ({
            bytes: resource.bytes,
            mediaType: resource.mediaType,
            name: resource.name,
            sha256: resource.sha256,
            urlPath: resource.urlPath,
          })),
          schemaVersion: 1,
          seed: boundInput.seed,
          timing: boundInput.timing,
        });
        const workspace = await createMediaOperationWorkspace(context);
        const renderDirectory = await mkdtemp(join(workspace.path, "html-overlay-"));
        try {
          const browserRuntime = await bindBrowserRuntime(
            exactCapabilityByName(bindings, "html-browser"),
            context.abortSignal,
          );
          const expectedExecutionIntegrity = createHtmlOverlayExecutionBundle(
            authoring,
            browserRuntime,
          ).integrity;
          const rendered = await renderer.renderFrames({
            authoring,
            browserRuntime,
            outputDirectory: renderDirectory,
            resources,
          }, context.abortSignal);
          const executionIntegrity = HtmlOverlayExecutionIntegritySchema.parse(
            rendered.executionIntegrity,
          );
          if (
            canonicalJsonSha256(executionIntegrity)
            !== canonicalJsonSha256(expectedExecutionIntegrity)
          ) {
            throw new ApplicationError(
              "conflict",
              "HTML-overlay renderer returned integrity evidence that does not match the planned browser execution.",
            );
          }
          const libraryLocks = HtmlOverlayLibraryLocksSchema.parse(
            rendered.libraryLocks,
          );
          if (
            libraryLocks.length !== authoring.libraries.length
            || libraryLocks.some((
              lock,
              index,
            ) => lock.specifier !== authoring.libraries[index])
          ) {
            throw new ApplicationError(
              "conflict",
              "HTML-overlay renderer returned library locks that do not exactly match the authoring selection.",
            );
          }
          const expectedFrames = htmlOverlayFrameCount(authoring.timing);
          if (rendered.frameCount !== expectedFrames) {
            throw new ApplicationError(
              "conflict",
              "HTML-overlay renderer returned an unexpected frame count.",
            );
          }
          const outputPath = join(renderDirectory, "overlay.mov");
          const ffmpegCommand = [
            mediaCapabilityCommand(bindings, "ffmpeg"),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-n",
            "-framerate",
            String(authoring.timing.fps),
            "-start_number",
            "0",
            "-i",
            rendered.framePattern,
            "-frames:v",
            String(rendered.frameCount),
            "-an",
            "-c:v",
            "qtrle",
            "-pix_fmt",
            "argb",
            "-movflags",
            "+faststart",
            outputPath,
          ] as const;
          const encode = await new AbortBoundApplicationRunner(
            mediaCapabilityRunner(context.application, bindings),
            context.abortSignal,
          ).run(ffmpegCommand, {
            cwd: renderDirectory,
            maxOutputBytes: 1024 * 1024,
            stdin: "ignore",
            timeoutMs: 60 * 60_000,
          });
          if (encode.exitCode !== 0) {
            throw new ApplicationError(
              "invalid-data",
              `FFmpeg could not encode the HTML overlay: ${encode.stderr.slice(0, 2_000)}`,
            );
          }
          await assertAlphaVideo(
            context.application,
            bindings,
            outputPath,
            authoring.canvas,
            context.abortSignal,
          );
          const sourceSha256 = await sha256PhysicalFile(
            outputPath,
            context.abortSignal,
          );
          await context.workflow?.beforePublication();
          throwIfAborted(context.abortSignal);
          const ingested = await ingest(
            snapshot.openProject.directory.path,
            {
              command: ffmpegCommand,
              generator: "atet-html-overlay",
              generatorVersion: toolVersion,
              path: outputPath,
              sourceSha256,
            },
          );
          const assetPath = join(
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
              MAXIMUM_HTML_OVERLAY_OUTPUT_BYTES,
            )
          ).artifact;
          const visual = await probe(
            mediaCapabilityCommand(bindings, "ffprobe"),
            new AbortBoundApplicationRunner(
              mediaCapabilityRunner(context.application, bindings),
              context.abortSignal,
            ),
            assetPath,
          );
          if (
            visual.durationUs === null
            || visual.durationUs <= 0
            || visual.hasAudio
            || visual.pixelWidth !== authoring.canvas.width
            || visual.pixelHeight !== authoring.canvas.height
          ) {
            throw new ApplicationError(
              "invalid-data",
              "Generated HTML overlay has invalid duration, dimensions, or audio streams.",
            );
          }
          const playbackWindow = resolveAnimatedPlaybackWindow({
            mediaDurationUs: visual.durationUs,
            outputDurationUs,
            playbackRate: 1,
            sourceInUs: 0,
            sourceOutUs: undefined,
          });
          const source = {
            asset: {
              bytes: ingested.bytes,
              mediaType: ingested.mediaType,
              path: ingested.path,
              provenance: ingested.provenance,
              sha256: ingested.sha256,
            },
            audioPolicy: { kind: "mute" as const },
            kind: "video" as const,
            playback: {
              audioEndUs: null,
              audioStartUs: 0,
              audioStreamIndex: null,
              endBehavior: "hide" as const,
              playbackRate: 1,
              streamStartUs: visual.videoStartUs,
              videoStreamIndex: visual.videoStreamIndex,
              ...playbackWindow,
            },
          };
          const operation = OverlayOperationSchema.parse({
            ...boundInput.layout,
            coordinateSpace: "output-pixels",
            intrinsicSize: {
              height: authoring.canvas.height,
              width: authoring.canvas.width,
            },
            overlayId: overlayOperationId(
              boundInput,
              authoring,
              artifact.sha256,
            ),
            range: boundInput.range,
            source,
          }) satisfies OverlayOperation;
          const receiptBody = HtmlOverlayReceiptSchema.parse({
            artifact,
            browserVersion: mediaCapabilityVersion(bindings, "html-browser"),
            createdAt: context.application.clock.now().toISOString(),
            executionIntegrity,
            exactInputSha256: canonicalJsonSha256(boundInput),
            ffmpegVersion: mediaCapabilityVersion(bindings, "ffmpeg"),
            ffprobeVersion: mediaCapabilityVersion(bindings, "ffprobe"),
            frameCount: rendered.frameCount,
            kind: "atet.html-overlay-preparation-receipt",
            libraryLocks,
            libraryLocksSha256: canonicalJsonSha256(libraryLocks),
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
            inputSchemaId: "atet.operation.media.html-overlay.input/v1",
            kind: "media.html-overlay",
            outputSchemaId: "atet.operation.media.html-overlay.output/v1",
            version: 1,
          }, output);
          return output;
        } finally {
          await rm(renderDirectory, { force: true, recursive: true });
          await workspace.dispose();
        }
      },
    },
    outputSchema: MediaOverlayOutputSchema,
    outputSchemaId: "atet.operation.media.html-overlay.output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 60 * 60_000,
      maxFanOut: 0,
      maxInputBytes: 3 * 1024 * 1024,
      maxOutputBytes: 2 * 1024 * 1024,
      preparation: ["project-state", "local-media"],
      resources: [
        { amount: 1, resource: "browser" },
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "network" },
        { amount: 1, resource: "output-publication" },
      ],
      resume: "verified-receipt",
    },
    receiptReference: output => output.receipt.path,
    summarize: output => ({
      fields: {
        bytes: output.artifact.bytes,
        created: output.created,
        kind: "html",
        overlayId: output.operation.overlayId,
        receipt: output.receipt.path,
        sha256: output.artifact.sha256,
      },
      kind: "media.html-overlay",
    }),
    version: 1,
  };
}

export const htmlOverlayOperationDefinition =
  createHtmlOverlayOperationDefinition();
