import {
  executeAtetOperation,
  executeAtetOperationWithLease,
  vectorizeImage,
  type HostResourceCoordinator,
  type LintFinding,
  type VectorizeOptions,
  type VectorizeResult,
} from "@hraness/atet";
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

const AtetMediaInputRequestSchema = z.union([
  RepositoryRelativePathSchema,
  MediaArtifactRequestSchema,
]);

export const AtetDiagramCheckInputSchema = z.strictObject({
  path: AtetMediaInputRequestSchema,
});

export const BoundAtetDiagramCheckInputSchema =
  AtetDiagramCheckInputSchema.extend({
    path: MediaArtifactReferenceSchema,
  }).strict();

export const AtetDiagramCheckOutputSchema = z.strictObject({
  findings: z.array(DiagramFindingSchema).max(256),
  source: MediaArtifactReferenceSchema,
});

export const AtetDiagramRenderInputSchema =
  AtetDiagramCheckInputSchema.extend({
    scale: z.number().finite().positive().max(4).optional(),
  }).strict();

export const BoundAtetDiagramRenderInputSchema =
  AtetDiagramRenderInputSchema.extend({
    path: MediaArtifactReferenceSchema,
  }).strict();

export const AtetDiagramArtifactsSchema = z.strictObject({
  darkPng: MediaArtifactReferenceSchema,
  darkSvg: MediaArtifactReferenceSchema,
  lightPng: MediaArtifactReferenceSchema,
  lightSvg: MediaArtifactReferenceSchema,
  tldr: MediaArtifactReferenceSchema,
});

export const AtetDiagramRenderOutputSchema = z.strictObject({
  artifacts: AtetDiagramArtifactsSchema,
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

export const AtetDiagramRenderReceiptSchema = z.strictObject({
  artifacts: AtetDiagramArtifactsSchema,
  createdAt: z.string().datetime({ offset: true }),
  exactInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  findings: z.array(DiagramFindingSchema).max(256),
  kind: z.union([
    z.literal("atet.visual-artifact-receipt"),
  ]),
  operation: z.union([
    z.literal("atet.diagram.render"),
  ]),
  scale: z.number().finite().positive().max(4),
  schemaVersion: z.literal(1),
  source: MediaArtifactReferenceSchema,
});

const HexColorSchema = z.string().regex(/^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$/u);

export const AtetImageVectorizeInputSchema = z.strictObject({
  alphaCutoff: z.number().int().min(1).max(64).optional(),
  duotone: z.tuple([HexColorSchema, HexColorSchema]).optional(),
  inputPath: AtetMediaInputRequestSchema,
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
});

export const BoundAtetImageVectorizeInputSchema =
  AtetImageVectorizeInputSchema.extend({
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

export const AtetImageVectorizeOutputSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  created: z.boolean(),
  receipt: MediaArtifactReferenceSchema,
  source: MediaArtifactReferenceSchema,
  vectorizer: VectorizeReceiptSchema,
});

export const AtetImageVectorizeReceiptSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  createdAt: z.string().datetime({ offset: true }),
  exactInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.union([
    z.literal("atet.visual-artifact-receipt"),
  ]),
  operation: z.union([
    z.literal("atet.image.vectorize"),
  ]),
  schemaVersion: z.literal(1),
  source: MediaArtifactReferenceSchema,
  vectorizer: VectorizeReceiptSchema,
});

export type AtetDiagramCheckInput = z.infer<typeof AtetDiagramCheckInputSchema>;
export type BoundAtetDiagramCheckInput = z.infer<typeof BoundAtetDiagramCheckInputSchema>;
export type AtetDiagramCheckOutput = z.infer<typeof AtetDiagramCheckOutputSchema>;
export type AtetDiagramRenderInput = z.infer<typeof AtetDiagramRenderInputSchema>;
export type BoundAtetDiagramRenderInput = z.infer<typeof BoundAtetDiagramRenderInputSchema>;
export type AtetDiagramRenderOutput = z.infer<typeof AtetDiagramRenderOutputSchema>;
export type AtetImageVectorizeInput = z.infer<typeof AtetImageVectorizeInputSchema>;
export type BoundAtetImageVectorizeInput = z.infer<typeof BoundAtetImageVectorizeInputSchema>;
export type AtetImageVectorizeOutput = z.infer<typeof AtetImageVectorizeOutputSchema>;

export const ATET_VISUAL_FILE_OPERATION_KINDS = [
  "atet.diagram.check",
  "atet.diagram.render",
  "atet.image.vectorize",
] as const;

export type AtetVisualFileOperationKind =
  typeof ATET_VISUAL_FILE_OPERATION_KINDS[number];

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

export interface AtetVisualOperationDependencies {
  readonly checkDiagram?: DiagramCheck;
  readonly hostResourceCoordinator?: HostResourceCoordinator;
  readonly renderDiagram?: DiagramRender;
  readonly vectorize?: ImageVectorize;
}

function mediaRequest(
  input: z.infer<typeof AtetMediaInputRequestSchema>,
): z.infer<typeof MediaArtifactRequestSchema> {
  return typeof input === "string" ? { path: input } : input;
}

export async function bindAtetVisualOperationInput(
  application: ApplicationContext,
  kind: AtetVisualFileOperationKind,
  inputValue: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<
  | BoundAtetDiagramCheckInput
  | BoundAtetDiagramRenderInput
  | BoundAtetImageVectorizeInput
> {
  switch (kind) {
    case "atet.diagram.check": {
      const input = AtetDiagramCheckInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.path),
        signal,
        MAXIMUM_DIAGRAM_SOURCE_BYTES,
      );
      return BoundAtetDiagramCheckInputSchema.parse({
        ...input,
        path: source.artifact,
      });
    }
    case "atet.diagram.render": {
      const input = AtetDiagramRenderInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.path),
        signal,
        MAXIMUM_DIAGRAM_SOURCE_BYTES,
      );
      return BoundAtetDiagramRenderInputSchema.parse({
        ...input,
        path: source.artifact,
      });
    }
    case "atet.image.vectorize": {
      const input = AtetImageVectorizeInputSchema.parse(inputValue);
      const source = await bindRepositoryMedia(
        application,
        mediaRequest(input.inputPath),
        signal,
        MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
      );
      return BoundAtetImageVectorizeInputSchema.parse({
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
  artifacts: z.infer<typeof AtetDiagramArtifactsSchema>;
  created: z.infer<typeof AtetDiagramRenderOutputSchema>["created"];
}>> {
  const published: Partial<Record<keyof z.infer<typeof AtetDiagramArtifactsSchema>, MediaArtifactReference>> = {};
  const created: Partial<Record<keyof z.infer<typeof AtetDiagramArtifactsSchema>, boolean>> = {};
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
    artifacts: AtetDiagramArtifactsSchema.parse(published),
    created: AtetDiagramRenderOutputSchema.shape.created.parse(created),
  };
}

function defaultCheckDiagram(
  path: string,
  application: ApplicationContext,
  hostResourceCoordinator?: HostResourceCoordinator,
): ReturnType<DiagramCheck> {
  const lease = application.hostResourceLease;
  return lease === undefined
    ? executeAtetOperation("atet.diagram.check", { path }, {
        ...(hostResourceCoordinator === undefined
          ? {}
          : { hostResourceCoordinator }),
      })
    : executeAtetOperationWithLease(
        "atet.diagram.check",
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
    ? executeAtetOperation("atet.diagram.render", input, {
        ...(hostResourceCoordinator === undefined
          ? {}
          : { hostResourceCoordinator }),
      })
    : executeAtetOperationWithLease(
        "atet.diagram.render",
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

export function createAtetDiagramCheckOperationDefinition(
  dependencies: AtetVisualOperationDependencies = {},
): OperationDefinition<
  "atet.diagram.check",
  AtetDiagramCheckInput,
  AtetDiagramCheckOutput
> {
  const check = dependencies.checkDiagram;
  return {
    inputSchema: AtetDiagramCheckInputSchema,
    inputSchemaId: "atet.operation.diagram.check.input/v1",
    kind: "atet.diagram.check",
    lifecycle: {
      kind: "pure",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const parsedInput = AtetDiagramCheckInputSchema.parse(input);
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
          return AtetDiagramCheckOutputSchema.parse({
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
    outputSchema: AtetDiagramCheckOutputSchema,
    outputSchemaId: "atet.operation.diagram.check.output/v1",
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
      kind: "atet.diagram.check",
    }),
    version: 1,
  };
}

export function createAtetDiagramRenderOperationDefinition(
  dependencies: AtetVisualOperationDependencies = {},
): OperationDefinition<
  "atet.diagram.render",
  AtetDiagramRenderInput,
  AtetDiagramRenderOutput
> {
  const render = dependencies.renderDiagram;
  return {
    inputSchema: AtetDiagramRenderInputSchema,
    inputSchemaId: "atet.operation.diagram.render.input/v1",
    kind: "atet.diagram.render",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        const parsedInput = AtetDiagramRenderInputSchema.parse(input);
        const source = await loadRepositoryMedia(
          context.application,
          mediaRequest(parsedInput.path),
          context.abortSignal,
          MAXIMUM_DIAGRAM_SOURCE_BYTES,
        );
        const boundInput = BoundAtetDiagramRenderInputSchema.parse({
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
          const receiptBody = AtetDiagramRenderReceiptSchema.parse({
            artifacts: published.artifacts,
            createdAt: context.application.clock.now().toISOString(),
            exactInputSha256: canonicalJsonSha256(boundInput),
            findings: rendered.findings,
            kind: "atet.visual-artifact-receipt",
            operation: "atet.diagram.render",
            scale: boundInput.scale ?? 2,
            schemaVersion: 1,
            source: source.artifact,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = AtetDiagramRenderOutputSchema.parse({
            ...published,
            findings: rendered.findings,
            receipt,
            source: source.artifact,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "atet.operation.diagram.render.input/v1",
            kind: "atet.diagram.render",
            outputSchemaId: "atet.operation.diagram.render.output/v1",
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
    outputSchema: AtetDiagramRenderOutputSchema,
    outputSchemaId: "atet.operation.diagram.render.output/v1",
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
      kind: "atet.diagram.render",
    }),
    version: 1,
  };
}

export function createAtetImageVectorizeOperationDefinition(
  dependencies: AtetVisualOperationDependencies = {},
): OperationDefinition<
  "atet.image.vectorize",
  AtetImageVectorizeInput,
  AtetImageVectorizeOutput
> {
  const vectorize = dependencies.vectorize ?? vectorizeImage;
  return {
    inputSchema: AtetImageVectorizeInputSchema,
    inputSchemaId: "atet.operation.image.vectorize.input/v1",
    kind: "atet.image.vectorize",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        const parsedInput = AtetImageVectorizeInputSchema.parse(input);
        const source = await bindRepositoryMedia(
          context.application,
          mediaRequest(parsedInput.inputPath),
          context.abortSignal,
          MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
        );
        const boundInput = BoundAtetImageVectorizeInputSchema.parse({
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
          const receiptBody = AtetImageVectorizeReceiptSchema.parse({
            artifact: published.artifact,
            createdAt: context.application.clock.now().toISOString(),
            exactInputSha256: canonicalJsonSha256(boundInput),
            kind: "atet.visual-artifact-receipt",
            operation: "atet.image.vectorize",
            schemaVersion: 1,
            source: source.artifact,
            vectorizer,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = AtetImageVectorizeOutputSchema.parse({
            artifact: published.artifact,
            created: published.created,
            receipt,
            source: source.artifact,
            vectorizer,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "atet.operation.image.vectorize.input/v1",
            kind: "atet.image.vectorize",
            outputSchemaId: "atet.operation.image.vectorize.output/v1",
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
    outputSchema: AtetImageVectorizeOutputSchema,
    outputSchemaId: "atet.operation.image.vectorize.output/v1",
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
      kind: "atet.image.vectorize",
    }),
    version: 1,
  };
}

export const atetDiagramCheckOperationDefinition =
  createAtetDiagramCheckOperationDefinition();
export const atetDiagramRenderOperationDefinition =
  createAtetDiagramRenderOperationDefinition();
export const atetImageVectorizeOperationDefinition =
  createAtetImageVectorizeOperationDefinition();
