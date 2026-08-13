import {
  executeTransmuteOperation,
  executeTransmuteOperationWithLease,
  vectorizeImage,
  type HostResourceCoordinator,
  type LintFinding,
  type VectorizeOptions,
  type VectorizeResult,
} from "@hraness/transmute";
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

const TransmuteMediaInputRequestSchema = z.union([
  RepositoryRelativePathSchema,
  MediaArtifactRequestSchema,
]);

export const TransmuteDiagramCheckInputSchema = z.strictObject({
  path: TransmuteMediaInputRequestSchema,
});

export const BoundTransmuteDiagramCheckInputSchema =
  TransmuteDiagramCheckInputSchema.extend({
    path: MediaArtifactReferenceSchema,
  }).strict();

export const TransmuteDiagramCheckOutputSchema = z.strictObject({
  findings: z.array(DiagramFindingSchema).max(256),
  source: MediaArtifactReferenceSchema,
});

export const TransmuteDiagramRenderInputSchema =
  TransmuteDiagramCheckInputSchema.extend({
    scale: z.number().finite().positive().max(4).optional(),
  }).strict();

export const BoundTransmuteDiagramRenderInputSchema =
  TransmuteDiagramRenderInputSchema.extend({
    path: MediaArtifactReferenceSchema,
  }).strict();

export const TransmuteDiagramArtifactsSchema = z.strictObject({
  darkPng: MediaArtifactReferenceSchema,
  darkSvg: MediaArtifactReferenceSchema,
  lightPng: MediaArtifactReferenceSchema,
  lightSvg: MediaArtifactReferenceSchema,
  tldr: MediaArtifactReferenceSchema,
});

export const TransmuteDiagramRenderOutputSchema = z.strictObject({
  artifacts: TransmuteDiagramArtifactsSchema,
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

export const TransmuteDiagramRenderReceiptSchema = z.strictObject({
  artifacts: TransmuteDiagramArtifactsSchema,
  createdAt: z.string().datetime({ offset: true }),
  exactInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  findings: z.array(DiagramFindingSchema).max(256),
  kind: z.literal("transmute.visual-artifact-receipt"),
  operation: z.literal("transmute.diagram.render"),
  scale: z.number().finite().positive().max(4),
  schemaVersion: z.literal(1),
  source: MediaArtifactReferenceSchema,
});

const HexColorSchema = z.string().regex(/^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$/u);

export const TransmuteImageVectorizeInputSchema = z.strictObject({
  alphaCutoff: z.number().int().min(1).max(64).optional(),
  duotone: z.tuple([HexColorSchema, HexColorSchema]).optional(),
  inputPath: TransmuteMediaInputRequestSchema,
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
});

export const BoundTransmuteImageVectorizeInputSchema =
  TransmuteImageVectorizeInputSchema.extend({
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

export const TransmuteImageVectorizeOutputSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  created: z.boolean(),
  receipt: MediaArtifactReferenceSchema,
  source: MediaArtifactReferenceSchema,
  vectorizer: VectorizeReceiptSchema,
});

export const TransmuteImageVectorizeReceiptSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  createdAt: z.string().datetime({ offset: true }),
  exactInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.literal("transmute.visual-artifact-receipt"),
  operation: z.literal("transmute.image.vectorize"),
  schemaVersion: z.literal(1),
  source: MediaArtifactReferenceSchema,
  vectorizer: VectorizeReceiptSchema,
});

export type TransmuteDiagramCheckInput = z.infer<typeof TransmuteDiagramCheckInputSchema>;
export type BoundTransmuteDiagramCheckInput = z.infer<typeof BoundTransmuteDiagramCheckInputSchema>;
export type TransmuteDiagramCheckOutput = z.infer<typeof TransmuteDiagramCheckOutputSchema>;
export type TransmuteDiagramRenderInput = z.infer<typeof TransmuteDiagramRenderInputSchema>;
export type BoundTransmuteDiagramRenderInput = z.infer<typeof BoundTransmuteDiagramRenderInputSchema>;
export type TransmuteDiagramRenderOutput = z.infer<typeof TransmuteDiagramRenderOutputSchema>;
export type TransmuteImageVectorizeInput = z.infer<typeof TransmuteImageVectorizeInputSchema>;
export type BoundTransmuteImageVectorizeInput = z.infer<typeof BoundTransmuteImageVectorizeInputSchema>;
export type TransmuteImageVectorizeOutput = z.infer<typeof TransmuteImageVectorizeOutputSchema>;

export const TRANSMUTE_VISUAL_FILE_OPERATION_KINDS = [
  "transmute.diagram.check",
  "transmute.diagram.render",
  "transmute.image.vectorize",
] as const;

export type TransmuteVisualFileOperationKind =
  typeof TRANSMUTE_VISUAL_FILE_OPERATION_KINDS[number];

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

export interface TransmuteVisualOperationDependencies {
  readonly checkDiagram?: DiagramCheck;
  readonly hostResourceCoordinator?: HostResourceCoordinator;
  readonly renderDiagram?: DiagramRender;
  readonly vectorize?: ImageVectorize;
}

function mediaRequest(
  input: z.infer<typeof TransmuteMediaInputRequestSchema>,
): z.infer<typeof MediaArtifactRequestSchema> {
  return typeof input === "string" ? { path: input } : input;
}

export async function bindTransmuteVisualOperationInput(
  application: ApplicationContext,
  kind: TransmuteVisualFileOperationKind,
  inputValue: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<
  | BoundTransmuteDiagramCheckInput
  | BoundTransmuteDiagramRenderInput
  | BoundTransmuteImageVectorizeInput
> {
  switch (kind) {
    case "transmute.diagram.check": {
      const input = TransmuteDiagramCheckInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.path),
        signal,
        MAXIMUM_DIAGRAM_SOURCE_BYTES,
      );
      return BoundTransmuteDiagramCheckInputSchema.parse({
        ...input,
        path: source.artifact,
      });
    }
    case "transmute.diagram.render": {
      const input = TransmuteDiagramRenderInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.path),
        signal,
        MAXIMUM_DIAGRAM_SOURCE_BYTES,
      );
      return BoundTransmuteDiagramRenderInputSchema.parse({
        ...input,
        path: source.artifact,
      });
    }
    case "transmute.image.vectorize": {
      const input = TransmuteImageVectorizeInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.inputPath),
        signal,
        MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
      );
      return BoundTransmuteImageVectorizeInputSchema.parse({
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
  artifacts: z.infer<typeof TransmuteDiagramArtifactsSchema>;
  created: z.infer<typeof TransmuteDiagramRenderOutputSchema>["created"];
}>> {
  const published: Partial<Record<keyof z.infer<typeof TransmuteDiagramArtifactsSchema>, MediaArtifactReference>> = {};
  const created: Partial<Record<keyof z.infer<typeof TransmuteDiagramArtifactsSchema>, boolean>> = {};
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
    artifacts: TransmuteDiagramArtifactsSchema.parse(published),
    created: TransmuteDiagramRenderOutputSchema.shape.created.parse(created),
  };
}

function defaultCheckDiagram(
  path: string,
  application: ApplicationContext,
  hostResourceCoordinator?: HostResourceCoordinator,
): ReturnType<DiagramCheck> {
  const lease = application.hostResourceLease;
  return lease === undefined
    ? executeTransmuteOperation("transmute.diagram.check", { path }, {
        ...(hostResourceCoordinator === undefined
          ? {}
          : { hostResourceCoordinator }),
      })
    : executeTransmuteOperationWithLease(
        "transmute.diagram.check",
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
    ? executeTransmuteOperation("transmute.diagram.render", input, {
        ...(hostResourceCoordinator === undefined
          ? {}
          : { hostResourceCoordinator }),
      })
    : executeTransmuteOperationWithLease(
        "transmute.diagram.render",
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

export function createTransmuteDiagramCheckOperationDefinition(
  dependencies: TransmuteVisualOperationDependencies = {},
): OperationDefinition<
  "transmute.diagram.check",
  TransmuteDiagramCheckInput,
  TransmuteDiagramCheckOutput
> {
  const check = dependencies.checkDiagram;
  return {
    inputSchema: TransmuteDiagramCheckInputSchema,
    inputSchemaId: "transmute.operation.diagram.check.input/v1",
    kind: "transmute.diagram.check",
    lifecycle: {
      kind: "pure",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const parsedInput = TransmuteDiagramCheckInputSchema.parse(input);
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
          return TransmuteDiagramCheckOutputSchema.parse({
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
    outputSchema: TransmuteDiagramCheckOutputSchema,
    outputSchemaId: "transmute.operation.diagram.check.output/v1",
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
      kind: "transmute.diagram.check",
    }),
    version: 1,
  };
}

export function createTransmuteDiagramRenderOperationDefinition(
  dependencies: TransmuteVisualOperationDependencies = {},
): OperationDefinition<
  "transmute.diagram.render",
  TransmuteDiagramRenderInput,
  TransmuteDiagramRenderOutput
> {
  const render = dependencies.renderDiagram;
  return {
    inputSchema: TransmuteDiagramRenderInputSchema,
    inputSchemaId: "transmute.operation.diagram.render.input/v1",
    kind: "transmute.diagram.render",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        const parsedInput = TransmuteDiagramRenderInputSchema.parse(input);
        const source = await loadRepositoryMedia(
          context.application,
          mediaRequest(parsedInput.path),
          context.abortSignal,
          MAXIMUM_DIAGRAM_SOURCE_BYTES,
        );
        const boundInput = BoundTransmuteDiagramRenderInputSchema.parse({
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
          const receiptBody = TransmuteDiagramRenderReceiptSchema.parse({
            artifacts: published.artifacts,
            createdAt: context.application.clock.now().toISOString(),
            exactInputSha256: canonicalJsonSha256(boundInput),
            findings: rendered.findings,
            kind: "transmute.visual-artifact-receipt",
            operation: "transmute.diagram.render",
            scale: boundInput.scale ?? 2,
            schemaVersion: 1,
            source: source.artifact,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = TransmuteDiagramRenderOutputSchema.parse({
            ...published,
            findings: rendered.findings,
            receipt,
            source: source.artifact,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "transmute.operation.diagram.render.input/v1",
            kind: "transmute.diagram.render",
            outputSchemaId: "transmute.operation.diagram.render.output/v1",
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
    outputSchema: TransmuteDiagramRenderOutputSchema,
    outputSchemaId: "transmute.operation.diagram.render.output/v1",
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
      kind: "transmute.diagram.render",
    }),
    version: 1,
  };
}

export function createTransmuteImageVectorizeOperationDefinition(
  dependencies: TransmuteVisualOperationDependencies = {},
): OperationDefinition<
  "transmute.image.vectorize",
  TransmuteImageVectorizeInput,
  TransmuteImageVectorizeOutput
> {
  const vectorize = dependencies.vectorize ?? vectorizeImage;
  return {
    inputSchema: TransmuteImageVectorizeInputSchema,
    inputSchemaId: "transmute.operation.image.vectorize.input/v1",
    kind: "transmute.image.vectorize",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        const parsedInput = TransmuteImageVectorizeInputSchema.parse(input);
        const source = await bindRepositoryMedia(
          context.application,
          mediaRequest(parsedInput.inputPath),
          context.abortSignal,
          MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
        );
        const boundInput = BoundTransmuteImageVectorizeInputSchema.parse({
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
          const receiptBody = TransmuteImageVectorizeReceiptSchema.parse({
            artifact: published.artifact,
            createdAt: context.application.clock.now().toISOString(),
            exactInputSha256: canonicalJsonSha256(boundInput),
            kind: "transmute.visual-artifact-receipt",
            operation: "transmute.image.vectorize",
            schemaVersion: 1,
            source: source.artifact,
            vectorizer,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = TransmuteImageVectorizeOutputSchema.parse({
            artifact: published.artifact,
            created: published.created,
            receipt,
            source: source.artifact,
            vectorizer,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "transmute.operation.image.vectorize.input/v1",
            kind: "transmute.image.vectorize",
            outputSchemaId: "transmute.operation.image.vectorize.output/v1",
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
    outputSchema: TransmuteImageVectorizeOutputSchema,
    outputSchemaId: "transmute.operation.image.vectorize.output/v1",
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
      kind: "transmute.image.vectorize",
    }),
    version: 1,
  };
}

export const transmuteDiagramCheckOperationDefinition =
  createTransmuteDiagramCheckOperationDefinition();
export const transmuteDiagramRenderOperationDefinition =
  createTransmuteDiagramRenderOperationDefinition();
export const transmuteImageVectorizeOperationDefinition =
  createTransmuteImageVectorizeOperationDefinition();
