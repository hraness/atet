import {
  executeSlopcameraOperation,
  executeSlopcameraOperationWithLease,
  vectorizeImage,
  type HostResourceCoordinator,
  type LintFinding,
  type VectorizeOptions,
  type VectorizeResult,
} from "@hraness/slopcamera";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";

import { RepositoryRelativePathSchema } from "../../contracts";
import { canonicalJsonSha256 } from "../../core/canonical-json";
import type { ApplicationContext } from "../context";
import { ApplicationError } from "../errors";
import type { OperationDefinition, OperationExecutionContext } from "../operation";
import { writeOperationCompletionCheckpoint } from "../operation-completion-checkpoint";
import { throwIfAborted } from "./shared";
import {
  MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
  MediaArtifactReferenceSchema,
  MediaArtifactRequestSchema,
  bindRepositoryMedia,
  createMediaOperationWorkspace,
  loadRepositoryMedia,
  publishContentAddressedMedia,
  publishContentAddressedReceipt,
  type MediaArtifactReference,
} from "./media/shared";

export const MAXIMUM_DIAGRAM_SOURCE_BYTES = 1024 * 1024;
export const MAXIMUM_DIAGRAM_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_VECTOR_ARTIFACT_BYTES = 64 * 1024 * 1024;

const DiagramFindingSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2_048),
  shapeIds: z.array(z.string().min(1).max(128)).max(256),
});

const SlopcameraMediaInputRequestSchema = z.union([
  RepositoryRelativePathSchema,
  MediaArtifactRequestSchema,
]);

export const SlopcameraDiagramCheckInputSchema = z.strictObject({
  path: SlopcameraMediaInputRequestSchema,
});

export const BoundSlopcameraDiagramCheckInputSchema =
  SlopcameraDiagramCheckInputSchema.extend({
    path: MediaArtifactReferenceSchema,
  }).strict();

export const SlopcameraDiagramCheckOutputSchema = z.strictObject({
  findings: z.array(DiagramFindingSchema).max(256),
  source: MediaArtifactReferenceSchema,
});

export const SlopcameraDiagramRenderInputSchema =
  SlopcameraDiagramCheckInputSchema.extend({
    scale: z.number().finite().positive().max(4).optional(),
  }).strict();

export const BoundSlopcameraDiagramRenderInputSchema =
  SlopcameraDiagramRenderInputSchema.extend({
    path: MediaArtifactReferenceSchema,
  }).strict();

export const SlopcameraDiagramArtifactsSchema = z.strictObject({
  darkPng: MediaArtifactReferenceSchema,
  darkSvg: MediaArtifactReferenceSchema,
  lightPng: MediaArtifactReferenceSchema,
  lightSvg: MediaArtifactReferenceSchema,
  tldr: MediaArtifactReferenceSchema,
});

export const SlopcameraDiagramRenderOutputSchema = z.strictObject({
  artifacts: SlopcameraDiagramArtifactsSchema,
  created: z.strictObject({
    darkPng: z.boolean(),
    darkSvg: z.boolean(),
    lightPng: z.boolean(),
    lightSvg: z.boolean(),
    tldr: z.boolean(),
  }),
  findings: z.array(DiagramFindingSchema).max(256),
  receipt: MediaArtifactReferenceSchema,
  source: MediaArtifactReferenceSchema,
});

export const SlopcameraDiagramRenderReceiptSchema = z.strictObject({
  artifacts: SlopcameraDiagramArtifactsSchema,
  createdAt: z.string().datetime({ offset: true }),
  exactInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  findings: z.array(DiagramFindingSchema).max(256),
  kind: z.union([
    z.literal("slopcamera.visual-artifact-receipt"),
  ]),
  operation: z.union([
    z.literal("slopcamera.diagram.render"),
  ]),
  scale: z.number().finite().positive().max(4),
  schemaVersion: z.literal(1),
  source: MediaArtifactReferenceSchema,
});

const HexColorSchema = z.string().regex(/^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$/u);

export const SlopcameraImageVectorizeInputSchema = z.strictObject({
  alphaCutoff: z.number().int().min(1).max(64).optional(),
  duotone: z.tuple([HexColorSchema, HexColorSchema]).optional(),
  inputPath: SlopcameraMediaInputRequestSchema,
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
});

export const BoundSlopcameraImageVectorizeInputSchema =
  SlopcameraImageVectorizeInputSchema.extend({
    inputPath: MediaArtifactReferenceSchema,
  }).strict();

const VectorizeQualityReceiptSchema = z.strictObject({
  alphaRmse: z.number().finite().nonnegative(),
  colorRmse: z.number().finite().nonnegative(),
  outsideAlphaRatio: z.number().finite().min(0).max(1),
  sampleHeight: z.number().int().positive(),
  sampleWidth: z.number().int().positive(),
  supportRecall: z.number().finite().min(0).max(1),
});

const VectorizeReceiptSchema = z.strictObject({
  alphaCutoff: z.number().int().min(1).max(64),
  bytes: z.number().int().positive(),
  candidatesEvaluated: z.number().int().positive(),
  format: z.string().min(1).max(64),
  height: z.number().int().positive(),
  inputBytes: z.number().int().positive(),
  outputMode: z.enum(["color", "duotone"]),
  pathCount: z.number().int().nonnegative(),
  profile: z.enum(["balanced", "detailed", "photo"]),
  provenance: z.strictObject({
    arch: z.string().min(1).max(64),
    platform: z.string().min(1).max(64),
    sharp: z.string().min(1).max(128),
    sharpVersions: z.record(
      z.string().min(1).max(128),
      z.string().min(1).max(128),
    ).superRefine((versions, context) => {
      if (Object.keys(versions).length > 64) {
        context.addIssue({ code: "custom", message: "Sharp provenance is too large." });
      }
    }),
    vips: z.string().min(1).max(128),
    vtracerSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    vtracerSource: z.enum(["official-release", "override"]),
    vtracerVersion: z.string().min(1).max(64),
  }),
  quality: VectorizeQualityReceiptSchema,
  receiptVersion: z.literal(1),
  representation: z.enum(["color-paths", "alpha-mask"]),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  svgSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.number().int().positive(),
});

export const SlopcameraImageVectorizeOutputSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  created: z.boolean(),
  receipt: MediaArtifactReferenceSchema,
  source: MediaArtifactReferenceSchema,
  vectorizer: VectorizeReceiptSchema,
});

export const SlopcameraImageVectorizeReceiptSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  createdAt: z.string().datetime({ offset: true }),
  exactInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.union([
    z.literal("slopcamera.visual-artifact-receipt"),
  ]),
  operation: z.union([
    z.literal("slopcamera.image.vectorize"),
  ]),
  schemaVersion: z.literal(1),
  source: MediaArtifactReferenceSchema,
  vectorizer: VectorizeReceiptSchema,
});

export type SlopcameraDiagramCheckInput = z.infer<typeof SlopcameraDiagramCheckInputSchema>;
export type BoundSlopcameraDiagramCheckInput = z.infer<typeof BoundSlopcameraDiagramCheckInputSchema>;
export type SlopcameraDiagramCheckOutput = z.infer<typeof SlopcameraDiagramCheckOutputSchema>;
export type SlopcameraDiagramRenderInput = z.infer<typeof SlopcameraDiagramRenderInputSchema>;
export type BoundSlopcameraDiagramRenderInput = z.infer<typeof BoundSlopcameraDiagramRenderInputSchema>;
export type SlopcameraDiagramRenderOutput = z.infer<typeof SlopcameraDiagramRenderOutputSchema>;
export type SlopcameraImageVectorizeInput = z.infer<typeof SlopcameraImageVectorizeInputSchema>;
export type BoundSlopcameraImageVectorizeInput = z.infer<typeof BoundSlopcameraImageVectorizeInputSchema>;
export type SlopcameraImageVectorizeOutput = z.infer<typeof SlopcameraImageVectorizeOutputSchema>;

export const SLOPCAMERA_VISUAL_FILE_OPERATION_KINDS = [
  "slopcamera.diagram.check",
  "slopcamera.diagram.render",
  "slopcamera.image.vectorize",
] as const;

export type SlopcameraVisualFileOperationKind =
  typeof SLOPCAMERA_VISUAL_FILE_OPERATION_KINDS[number];

type DiagramCheck = (path: string) => Promise<{ readonly findings: readonly LintFinding[] }>;
type DiagramRender = (input: Readonly<{
  outDirectory: string;
  path: string;
  scale?: number;
}>) => Promise<Readonly<{
  artifacts: Readonly<{
    darkPng: string;
    darkSvg: string;
    lightPng: string;
    lightSvg: string;
    spec: string;
    tldr: string;
  }>;
  findings: readonly LintFinding[];
}>>;
type ImageVectorize = (
  path: string,
  options: VectorizeOptions,
) => Promise<VectorizeResult>;

export interface SlopcameraVisualOperationDependencies {
  readonly checkDiagram?: DiagramCheck;
  readonly hostResourceCoordinator?: HostResourceCoordinator;
  readonly renderDiagram?: DiagramRender;
  readonly vectorize?: ImageVectorize;
}

function mediaRequest(
  input: z.infer<typeof SlopcameraMediaInputRequestSchema>,
): z.infer<typeof MediaArtifactRequestSchema> {
  return typeof input === "string" ? { path: input } : input;
}

export async function bindSlopcameraVisualOperationInput(
  application: ApplicationContext,
  kind: SlopcameraVisualFileOperationKind,
  inputValue: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<
  | BoundSlopcameraDiagramCheckInput
  | BoundSlopcameraDiagramRenderInput
  | BoundSlopcameraImageVectorizeInput
> {
  switch (kind) {
    case "slopcamera.diagram.check": {
      const input = SlopcameraDiagramCheckInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.path),
        signal,
        MAXIMUM_DIAGRAM_SOURCE_BYTES,
      );
      return BoundSlopcameraDiagramCheckInputSchema.parse({
        ...input,
        path: source.artifact,
      });
    }
    case "slopcamera.diagram.render": {
      const input = SlopcameraDiagramRenderInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.path),
        signal,
        MAXIMUM_DIAGRAM_SOURCE_BYTES,
      );
      return BoundSlopcameraDiagramRenderInputSchema.parse({
        ...input,
        path: source.artifact,
      });
    }
    case "slopcamera.image.vectorize": {
      const input = SlopcameraImageVectorizeInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.inputPath),
        signal,
        MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
      );
      return BoundSlopcameraImageVectorizeInputSchema.parse({
        ...input,
        inputPath: source.artifact,
      });
    }
  }
}

function operationFailure(label: string, error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  const detail = error instanceof Error ? error.message : String(error);
  throw new ApplicationError(
    "invalid-data",
    `${label}: ${detail.slice(0, 1_024)}`,
  );
}

async function publishDiagramArtifacts(
  context: OperationExecutionContext,
  artifacts: Awaited<ReturnType<DiagramRender>>["artifacts"],
): Promise<Readonly<{
  artifacts: z.infer<typeof SlopcameraDiagramArtifactsSchema>;
  created: z.infer<typeof SlopcameraDiagramRenderOutputSchema>["created"];
}>> {
  const published: Partial<Record<keyof z.infer<typeof SlopcameraDiagramArtifactsSchema>, MediaArtifactReference>> = {};
  const created: Partial<Record<keyof z.infer<typeof SlopcameraDiagramArtifactsSchema>, boolean>> = {};
  const entries = [
    ["darkPng", artifacts.darkPng, ".png"],
    ["darkSvg", artifacts.darkSvg, ".svg"],
    ["lightPng", artifacts.lightPng, ".png"],
    ["lightSvg", artifacts.lightSvg, ".svg"],
    ["tldr", artifacts.tldr, ".tldr"],
  ] as const;
  for (const [key, stagedPath, extension] of entries) {
    const result = await publishContentAddressedMedia({
      context,
      extension,
      maximumBytes: MAXIMUM_DIAGRAM_ARTIFACT_BYTES,
      stagedPath,
    });
    published[key] = result.artifact;
    created[key] = result.created;
  }
  return {
    artifacts: SlopcameraDiagramArtifactsSchema.parse(published),
    created: SlopcameraDiagramRenderOutputSchema.shape.created.parse(created),
  };
}

function defaultCheckDiagram(
  path: string,
  application: ApplicationContext,
  hostResourceCoordinator?: HostResourceCoordinator,
): ReturnType<DiagramCheck> {
  const lease = application.hostResourceLease;
  return lease === undefined
    ? executeSlopcameraOperation("slopcamera.diagram.check", { path }, {
        ...(hostResourceCoordinator === undefined
          ? {}
          : { hostResourceCoordinator }),
      })
    : executeSlopcameraOperationWithLease(
        "slopcamera.diagram.check",
        { path },
        lease,
      );
}

function defaultRenderDiagram(
  input: Parameters<DiagramRender>[0],
  application: ApplicationContext,
  hostResourceCoordinator?: HostResourceCoordinator,
): ReturnType<DiagramRender> {
  const lease = application.hostResourceLease;
  return lease === undefined
    ? executeSlopcameraOperation("slopcamera.diagram.render", input, {
        ...(hostResourceCoordinator === undefined
          ? {}
          : { hostResourceCoordinator }),
      })
    : executeSlopcameraOperationWithLease(
        "slopcamera.diagram.render",
        input,
        lease,
      );
}

async function writeDiagramInputSnapshot(
  directory: string,
  source: Uint8Array,
): Promise<string> {
  const path = join(
    directory,
    `.diagram-source-${randomUUID()}.json`,
  );
  const handle = await open(
    path,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    return path;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createSlopcameraDiagramCheckOperationDefinition(
  dependencies: SlopcameraVisualOperationDependencies = {},
): OperationDefinition<
  "slopcamera.diagram.check",
  SlopcameraDiagramCheckInput,
  SlopcameraDiagramCheckOutput
> {
  const check = dependencies.checkDiagram;
  return {
    inputSchema: SlopcameraDiagramCheckInputSchema,
    inputSchemaId: "slopcamera.operation.diagram.check.input/v1",
    kind: "slopcamera.diagram.check",
    lifecycle: {
      kind: "pure",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const parsedInput = SlopcameraDiagramCheckInputSchema.parse(input);
        const source = await loadRepositoryMedia(
          context.application,
          mediaRequest(parsedInput.path),
          context.abortSignal,
          MAXIMUM_DIAGRAM_SOURCE_BYTES,
        );
        const workspace = await createMediaOperationWorkspace(context);
        let snapshotPath: string | undefined;
        try {
          snapshotPath = await writeDiagramInputSnapshot(
            workspace.path,
            source.data,
          );
          throwIfAborted(context.abortSignal);
          const checked = await (check === undefined
            ? defaultCheckDiagram(
                snapshotPath,
                context.application,
                dependencies.hostResourceCoordinator,
              )
            : check(snapshotPath));
          throwIfAborted(context.abortSignal);
          await bindRepositoryMedia(
            context.application,
            source.artifact,
            context.abortSignal,
            MAXIMUM_DIAGRAM_SOURCE_BYTES,
          );
          return SlopcameraDiagramCheckOutputSchema.parse({
            findings: checked.findings,
            source: source.artifact,
          });
        } catch (error) {
          return operationFailure("Diagram check failed", error);
        } finally {
          if (snapshotPath !== undefined) {
            await rm(snapshotPath, { force: true }).catch(() => undefined);
          }
          await workspace.dispose();
        }
      },
    },
    outputSchema: SlopcameraDiagramCheckOutputSchema,
    outputSchemaId: "slopcamera.operation.diagram.check.output/v1",
    policy: {
      cache: "content-addressed",
      cancellable: false,
      effect: "local-read",
      maxDurationMs: 30_000,
      maxFanOut: 0,
      maxInputBytes: 4_096,
      maxOutputBytes: 256 * 1024,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "deterministic",
    },
    summarize: output => ({
      fields: {
        findings: output.findings.length,
        source: output.source.path,
        sourceSha256: output.source.sha256,
      },
      kind: "slopcamera.diagram.check",
    }),
    version: 1,
  };
}

export function createSlopcameraDiagramRenderOperationDefinition(
  dependencies: SlopcameraVisualOperationDependencies = {},
): OperationDefinition<
  "slopcamera.diagram.render",
  SlopcameraDiagramRenderInput,
  SlopcameraDiagramRenderOutput
> {
  const render = dependencies.renderDiagram;
  return {
    inputSchema: SlopcameraDiagramRenderInputSchema,
    inputSchemaId: "slopcamera.operation.diagram.render.input/v1",
    kind: "slopcamera.diagram.render",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        const parsedInput = SlopcameraDiagramRenderInputSchema.parse(input);
        const source = await loadRepositoryMedia(
          context.application,
          mediaRequest(parsedInput.path),
          context.abortSignal,
          MAXIMUM_DIAGRAM_SOURCE_BYTES,
        );
        const boundInput = BoundSlopcameraDiagramRenderInputSchema.parse({
          ...parsedInput,
          path: source.artifact,
        });
        const workspace = await createMediaOperationWorkspace(context);
        let snapshotPath: string | undefined;
        try {
          snapshotPath = await writeDiagramInputSnapshot(
            workspace.path,
            source.data,
          );
          throwIfAborted(context.abortSignal);
          const renderInput = {
            outDirectory: join(workspace.path, "diagram"),
            path: snapshotPath,
            ...(boundInput.scale === undefined ? {} : { scale: boundInput.scale }),
          };
          const rendered = await (render === undefined
            ? defaultRenderDiagram(
                renderInput,
                context.application,
                dependencies.hostResourceCoordinator,
              )
            : render(renderInput));
          throwIfAborted(context.abortSignal);
          await bindRepositoryMedia(
            context.application,
            source.artifact,
            context.abortSignal,
            MAXIMUM_DIAGRAM_SOURCE_BYTES,
          );
          const published = await publishDiagramArtifacts(context, rendered.artifacts);
          const receiptBody = SlopcameraDiagramRenderReceiptSchema.parse({
            artifacts: published.artifacts,
            createdAt: context.application.clock.now().toISOString(),
            exactInputSha256: canonicalJsonSha256(boundInput),
            findings: rendered.findings,
            kind: "slopcamera.visual-artifact-receipt",
            operation: "slopcamera.diagram.render",
            scale: boundInput.scale ?? 2,
            schemaVersion: 1,
            source: source.artifact,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = SlopcameraDiagramRenderOutputSchema.parse({
            ...published,
            findings: rendered.findings,
            receipt,
            source: source.artifact,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "slopcamera.operation.diagram.render.input/v1",
            kind: "slopcamera.diagram.render",
            outputSchemaId: "slopcamera.operation.diagram.render.output/v1",
            version: 1,
          }, output);
          return output;
        } catch (error) {
          return operationFailure("Diagram render failed", error);
        } finally {
          if (snapshotPath !== undefined) {
            await rm(snapshotPath, { force: true }).catch(() => undefined);
          }
          await workspace.dispose();
        }
      },
    },
    outputSchema: SlopcameraDiagramRenderOutputSchema,
    outputSchemaId: "slopcamera.operation.diagram.render.output/v1",
    policy: {
      cache: "content-addressed",
      cancellable: false,
      effect: "local-derived-write",
      maxDurationMs: 120_000,
      maxFanOut: 5,
      maxInputBytes: 4_096,
      maxOutputBytes: 5 * MAXIMUM_DIAGRAM_ARTIFACT_BYTES,
      preparation: ["local-media"],
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
        darkPng: output.artifacts.darkPng.path,
        findings: output.findings.length,
        lightPng: output.artifacts.lightPng.path,
        receipt: output.receipt.path,
        sourceSha256: output.source.sha256,
      },
      kind: "slopcamera.diagram.render",
    }),
    version: 1,
  };
}

export function createSlopcameraImageVectorizeOperationDefinition(
  dependencies: SlopcameraVisualOperationDependencies = {},
): OperationDefinition<
  "slopcamera.image.vectorize",
  SlopcameraImageVectorizeInput,
  SlopcameraImageVectorizeOutput
> {
  const vectorize = dependencies.vectorize ?? vectorizeImage;
  return {
    inputSchema: SlopcameraImageVectorizeInputSchema,
    inputSchemaId: "slopcamera.operation.image.vectorize.input/v1",
    kind: "slopcamera.image.vectorize",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        const parsedInput = SlopcameraImageVectorizeInputSchema.parse(input);
        const source = await bindRepositoryMedia(
          context.application,
          mediaRequest(parsedInput.inputPath),
          context.abortSignal,
          MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
        );
        const boundInput = BoundSlopcameraImageVectorizeInputSchema.parse({
          ...parsedInput,
          inputPath: source.artifact,
        });
        const workspace = await createMediaOperationWorkspace(context);
        const stagedPath = join(workspace.path, "vectorized.svg");
        try {
          await context.application.hostResourceLease?.assertOwned();
          const result = await vectorize(source.absolutePath, {
            cacheDirectory: join(context.application.paths.privateRoot, "vectorize-tool-cache-v1"),
            ...(context.application.hostResourceLease === undefined
              ? {}
              : {
                  inheritedFileDescriptors:
                    context.application.hostResourceLease.inheritedFileDescriptors,
                }),
            outputPath: stagedPath,
            ...(boundInput.alphaCutoff === undefined
              ? {}
              : { alphaCutoff: boundInput.alphaCutoff }),
            ...(boundInput.duotone === undefined
              ? {}
              : { duotone: boundInput.duotone }),
            ...(boundInput.timeoutMs === undefined
              ? {}
              : { limits: { maxDurationMs: boundInput.timeoutMs } }),
          });
          if (result.outputPath !== stagedPath) {
            throw new ApplicationError(
              "invalid-data",
              "Vectorization did not publish its exact staged output.",
            );
          }
          const vectorizer = VectorizeReceiptSchema.parse(result.receipt);
          if (
            vectorizer.sourceSha256 !== source.artifact.sha256
            || vectorizer.inputBytes !== source.artifact.bytes
          ) {
            throw new ApplicationError(
              "conflict",
              "Vectorizer receipt source hash or byte length does not match the bound raster input.",
            );
          }
          const expectedOutputMode = boundInput.duotone === undefined
            ? "color"
            : "duotone";
          if (vectorizer.outputMode !== expectedOutputMode) {
            throw new ApplicationError(
              "conflict",
              "Vectorizer receipt output mode does not match the exact color request.",
            );
          }
          const published = await publishContentAddressedMedia({
            context,
            extension: ".svg",
            maximumBytes: MAXIMUM_VECTOR_ARTIFACT_BYTES,
            stagedPath,
          });
          if (
            vectorizer.svgSha256 !== published.artifact.sha256
            || vectorizer.bytes !== published.artifact.bytes
          ) {
            throw new ApplicationError(
              "conflict",
              "Vectorizer receipt SVG hash or byte length does not match the staged output.",
            );
          }
          const receiptBody = SlopcameraImageVectorizeReceiptSchema.parse({
            artifact: published.artifact,
            createdAt: context.application.clock.now().toISOString(),
            exactInputSha256: canonicalJsonSha256(boundInput),
            kind: "slopcamera.visual-artifact-receipt",
            operation: "slopcamera.image.vectorize",
            schemaVersion: 1,
            source: source.artifact,
            vectorizer,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = SlopcameraImageVectorizeOutputSchema.parse({
            artifact: published.artifact,
            created: published.created,
            receipt,
            source: source.artifact,
            vectorizer,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "slopcamera.operation.image.vectorize.input/v1",
            kind: "slopcamera.image.vectorize",
            outputSchemaId: "slopcamera.operation.image.vectorize.output/v1",
            version: 1,
          }, output);
          return output;
        } catch (error) {
          return operationFailure("Image vectorization failed", error);
        } finally {
          await workspace.dispose();
        }
      },
    },
    outputSchema: SlopcameraImageVectorizeOutputSchema,
    outputSchemaId: "slopcamera.operation.image.vectorize.output/v1",
    policy: {
      cache: "content-addressed",
      cancellable: false,
      effect: "local-derived-write",
      maxDurationMs: 300_000,
      maxFanOut: 1,
      maxInputBytes: 8_192,
      maxOutputBytes: MAXIMUM_VECTOR_ARTIFACT_BYTES,
      preparation: ["local-media"],
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
        paths: output.vectorizer.pathCount,
        receipt: output.receipt.path,
        sha256: output.artifact.sha256,
        sourceSha256: output.source.sha256,
      },
      kind: "slopcamera.image.vectorize",
    }),
    version: 1,
  };
}

export const slopcameraDiagramCheckOperationDefinition =
  createSlopcameraDiagramCheckOperationDefinition();
export const slopcameraDiagramRenderOperationDefinition =
  createSlopcameraDiagramRenderOperationDefinition();
export const slopcameraImageVectorizeOperationDefinition =
  createSlopcameraImageVectorizeOperationDefinition();
