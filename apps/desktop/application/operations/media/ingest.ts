import { Context, Effect, Exit, Layer, Ref } from "effect";
import { z } from "zod";

import {
  ProjectAssetRoleSchema,
  ProjectAssetV1Schema,
  Sha256Schema,
  type ProjectAssetV1,
} from "../../../contracts";
import { canonicalJsonSha256 } from "../../../core/canonical-json";
import {
  ingestProjectMediaEffect,
  type IngestProjectMediaOptions,
  type IngestedProjectMedia,
} from "../../../cli/media-ingest";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition, OperationExecutionContext } from "../../operation";
import { operationBoundary, operationValidation, runStandaloneOperation, type OperationEffectFailure } from "../../operation-effects";
import { writeOperationCompletionCheckpoint } from "../../operation-completion-checkpoint";
import { openLeasedProjectSnapshot } from "../../project-publication-lease";
import {
  assertProjectGeneration,
} from "../../project-store";
import {
  ProjectReferenceSchema,
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
  MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
  MediaArtifactReferenceSchema,
  MediaArtifactRequestSchema,
  bindRepositoryMedia,
  createMediaOperationWorkspace,
  publishContentAddressedReceipt,
  type MediaArtifactReference,
} from "./shared";

export const MediaIngestReceiptSchema = z.strictObject({
  assetSha256: Sha256Schema,
  createdAt: z.string().datetime({ offset: true }),
  ffprobeVersion: z.string().min(1).max(256),
  input: MediaArtifactReferenceSchema,
  kind: z.union([
    z.literal("atet.local-media-ingest-receipt"),
    z.literal("studio.local-media-ingest-receipt"),
  ]),
  operation: z.literal("media.ingest"),
  output: MediaArtifactReferenceSchema,
  projectGenerationSha256: Sha256Schema,
  role: ProjectAssetRoleSchema,
  schemaVersion: z.literal(1),
});

export const MediaIngestInputSchema = z.strictObject({
  capabilityBindings: MediaCapabilityBindingsSchema.optional(),
  project: ProjectReferenceSchema,
  role: ProjectAssetRoleSchema,
  source: MediaArtifactRequestSchema,
});

export const BoundMediaIngestInputSchema = MediaIngestInputSchema.extend({
  source: MediaArtifactReferenceSchema,
}).strict();

export const MediaIngestOutputSchema = z.strictObject({
  artifact: MediaArtifactReferenceSchema,
  asset: ProjectAssetV1Schema,
  created: z.boolean(),
  receipt: MediaArtifactReferenceSchema,
});

export type MediaIngestInput = z.infer<typeof MediaIngestInputSchema>;
export type BoundMediaIngestInput = z.infer<typeof BoundMediaIngestInputSchema>;
export type MediaIngestOutput = z.infer<typeof MediaIngestOutputSchema>;

type IngestExecutor = (
  options: IngestProjectMediaOptions,
) => Promise<IngestedProjectMedia>;

export interface MediaIngestOperationDependencies {
  readonly ingest?: IngestExecutor;
}

export async function bindMediaIngestInput(
  application: ApplicationContext,
  input: unknown,
  signal: AbortSignal,
): Promise<BoundMediaIngestInput> {
  const parsed = MediaIngestInputSchema.parse(input);
  const [source, capabilityBindings] = await Promise.all([
    bindRepositoryMedia(
      application,
      parsed.source,
      signal,
      MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
    ),
    bindExpectedMediaCapabilities(
      application,
      ["ffprobe"],
      parsed.capabilityBindings,
    ),
  ]);
  return BoundMediaIngestInputSchema.parse({
    ...parsed,
    capabilityBindings,
    source: source.artifact,
  });
}

function importedArtifact(asset: ProjectAssetV1): MediaArtifactReference {
  const segments = asset.streams.flatMap(stream => stream.segments);
  const first = segments[0];
  if (first === undefined) {
    throw new ApplicationError(
      "invalid-data",
      "Imported media returned no addressable stream segments.",
    );
  }
  if (segments.some(segment => (
    segment.path !== first.path
    || segment.bytes !== first.bytes
    || segment.sha256 !== first.sha256
  ))) {
    throw new ApplicationError(
      "invalid-data",
      "A single media ingest returned inconsistent content identities.",
    );
  }
  return MediaArtifactReferenceSchema.parse({
    bytes: first.bytes,
    path: first.path,
    sha256: first.sha256,
  });
}

class MediaIngestServices extends Context.Tag("@atet/local/MediaIngestServices")<
  MediaIngestServices,
  Readonly<{ context: OperationExecutionContext; ingest: (options: IngestProjectMediaOptions) => Effect.Effect<IngestedProjectMedia, OperationEffectFailure> }>
>() { }

/** Native transaction; the caller owns execution and the foreign runner owns physical custody. */
function ingestProgram(input: MediaIngestInput): Effect.Effect<
  MediaIngestOutput, OperationEffectFailure, MediaIngestServices
> {
  return Effect.gen(function*() {
    const { context, ingest } = yield* MediaIngestServices;
    const parsedInput = yield* operationValidation("input", () => {
      throwIfAborted(context.abortSignal);
      return MediaIngestInputSchema.parse(input);
    });
    const boundSource = yield* operationBoundary("media", () => bindRepositoryMedia(
      context.application, parsedInput.source, context.abortSignal,
      MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
    ));
    const boundInput = yield* operationValidation("input", () => BoundMediaIngestInputSchema.parse({
      ...parsedInput, source: boundSource.artifact,
    }));
    yield* operationBoundary("capability", () => assertMediaCapabilities(
      context, context.application, parsedInput.capabilityBindings, ["ffprobe"],
    ));
    const capabilityBindings = parsedInput.capabilityBindings
      ?? (yield* operationBoundary("capability", () => bindMediaCapabilities(context.application, ["ffprobe"])));
    const snapshot = yield* operationBoundary("project", () => openLeasedProjectSnapshot(
      context.application, boundInput.project,
    ));
    yield* operationValidation("project", () => assertProjectGeneration(
      context.expectedProjectGeneration, snapshot.generation,
    ));
    const cleanup = yield* Ref.make<Exit.Exit<void, OperationEffectFailure>>(Exit.void);
    const result = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
      const workspace = yield* Effect.acquireRelease(
        operationBoundary("workspace", () => createMediaOperationWorkspace(context)),
        workspace => Effect.flatMap(
          Effect.exit(operationBoundary("cleanup", () => workspace.dispose())),
          exit => Ref.set(cleanup, exit),
        ),
      );
      // Immutable no-replace blob publication may leave an unreferenced blob;
      // the durable fence still guards receipt and checkpoint authority.
      yield* operationBoundary("publication", () => context.workflow?.beforePublication());
      const options = yield* operationValidation("media", () => {
        throwIfAborted(context.abortSignal);
        return {
          ffprobe: mediaCapabilityCommand(capabilityBindings, "ffprobe"),
          now: context.application.clock.now(),
          projectDirectory: snapshot.openProject.directory.path,
          repositoryRoot: context.application.paths.repositoryRoot,
          role: boundInput.role,
          runner: new AbortBoundApplicationRunner(
            mediaCapabilityRunner(context.application, capabilityBindings), context.abortSignal,
          ),
          sourcePath: boundSource.absolutePath,
        };
      });
      const ingested = yield* ingest(options);
      const claimedArtifact = yield* operationValidation("output", () => {
        throwIfAborted(context.abortSignal);
        return importedArtifact(ingested.asset);
      });
      const verifiedArtifact = yield* operationBoundary("media", () => bindRepositoryMedia(
        context.application, claimedArtifact, context.abortSignal,
        MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
      ));
      const receiptBody = yield* operationValidation("output", () => MediaIngestReceiptSchema.parse({
        assetSha256: canonicalJsonSha256(ingested.asset),
        createdAt: context.application.clock.now().toISOString(),
        ffprobeVersion: mediaCapabilityVersion(capabilityBindings, "ffprobe"),
        input: boundInput.source,
        kind: "atet.local-media-ingest-receipt",
        operation: "media.ingest",
        output: verifiedArtifact.artifact,
        projectGenerationSha256: snapshot.generation.generationSha256,
        role: boundInput.role,
        schemaVersion: 1,
      }));
      const receipt = yield* operationBoundary("publication", () => publishContentAddressedReceipt({
        context, receipt: receiptBody, workspace,
      }));
      const output = yield* operationValidation("output", () => MediaIngestOutputSchema.parse({
        artifact: verifiedArtifact.artifact, asset: ingested.asset, created: ingested.created, receipt,
      }));
      yield* operationBoundary("checkpoint", () => writeOperationCompletionCheckpoint(context, {
        inputSchemaId: "atet.operation.media.ingest.input/v1",
        kind: "media.ingest",
        outputSchemaId: "atet.operation.media.ingest.output/v1",
        version: 1,
      }, output));
      return output;
    })));
    // Finalizers must not discard a cleanup failure or replace the execution failure.
    return yield* Exit.zipLeft(result, yield* Ref.get(cleanup));
  });
}

export function createMediaIngestOperationDefinition(
  dependencies: MediaIngestOperationDependencies = {},
): OperationDefinition<
  "media.ingest",
  MediaIngestInput,
  MediaIngestOutput
> {
  const foreignIngest = dependencies.ingest;
  const executeIngest = foreignIngest === undefined ? ingestProjectMediaEffect
    : (options: IngestProjectMediaOptions) => Effect.uninterruptible(operationBoundary("media", () => foreignIngest(options)));
  const executeEffect = (context: OperationExecutionContext, input: MediaIngestInput) =>
    ingestProgram(input).pipe(Effect.provide(Layer.succeed(MediaIngestServices, {
      context, ingest: executeIngest,
    })));
  return {
    inputSchema: MediaIngestInputSchema,
    inputSchemaId: "atet.operation.media.ingest.input/v1",
    kind: "media.ingest",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => await runStandaloneOperation(executeEffect(context, input)),
      executeEffect,
    },
    outputSchema: MediaIngestOutputSchema,
    outputSchemaId: "atet.operation.media.ingest.output/v1",
    policy: {
      cache: "exact-run",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 12 * 60 * 60_000,
      maxFanOut: 0,
      maxInputBytes: 8 * 1024,
      maxOutputBytes: 64 * 1024 * 1024,
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
        assetId: output.asset.assetId,
        bytes: output.artifact.bytes,
        created: output.created,
        path: output.artifact.path,
        receipt: output.receipt.path,
        sha256: output.artifact.sha256,
      },
      kind: "media.ingest",
    }),
    version: 1,
  };
}

export const mediaIngestOperationDefinition = createMediaIngestOperationDefinition();
