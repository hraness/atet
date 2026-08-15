import { z } from "zod";

import {
  ProjectAssetRoleSchema,
  ProjectAssetV1Schema,
  Sha256Schema,
  type ProjectAssetV1,
} from "../../../contracts";
import { canonicalJsonSha256 } from "../../../core/canonical-json";
import {
  ingestProjectMedia,
  type IngestProjectMediaOptions,
  type IngestedProjectMedia,
} from "../../../cli/media-ingest";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
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
    z.literal("transmute.local-media-ingest-receipt"),
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

export function createMediaIngestOperationDefinition(
  dependencies: MediaIngestOperationDependencies = {},
): OperationDefinition<
  "media.ingest",
  MediaIngestInput,
  MediaIngestOutput
> {
  const executeIngest = dependencies.ingest ?? ingestProjectMedia;
  return {
    inputSchema: MediaIngestInputSchema,
    inputSchemaId: "atet.operation.media.ingest.input/v1",
    kind: "media.ingest",
    lifecycle: {
      kind: "local-artifact",
      execute: async (context, input) => {
        throwIfAborted(context.abortSignal);
        const parsedInput = MediaIngestInputSchema.parse(input);
        const boundSource = await bindRepositoryMedia(
          context.application,
          parsedInput.source,
          context.abortSignal,
          MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
        );
        const boundInput = BoundMediaIngestInputSchema.parse({
          ...parsedInput,
          source: boundSource.artifact,
        });
        await assertMediaCapabilities(
          context,
          context.application,
          parsedInput.capabilityBindings,
          ["ffprobe"],
        );
        const capabilityBindings = parsedInput.capabilityBindings
          ?? await bindMediaCapabilities(context.application, ["ffprobe"]);
        const snapshot = await openLeasedProjectSnapshot(
          context.application,
          boundInput.project,
        );
        assertProjectGeneration(
          context.expectedProjectGeneration,
          snapshot.generation,
        );
        const workspace = await createMediaOperationWorkspace(context);
        try {
          // The existing ingest service publishes only a content-addressed,
          // no-replace blob. A stale run can therefore leave at most an
          // unreferenced immutable blob, never mutate project authority.
          await context.workflow?.beforePublication();
          throwIfAborted(context.abortSignal);
          const ingested = await executeIngest({
            ffprobe: mediaCapabilityCommand(
              capabilityBindings,
              "ffprobe",
            ),
            now: context.application.clock.now(),
            projectDirectory: snapshot.openProject.directory.path,
            repositoryRoot: context.application.paths.repositoryRoot,
            role: boundInput.role,
            runner: new AbortBoundApplicationRunner(
              mediaCapabilityRunner(
                context.application,
                capabilityBindings,
              ),
              context.abortSignal,
            ),
            sourcePath: boundSource.absolutePath,
          });
          throwIfAborted(context.abortSignal);
          const claimedArtifact = importedArtifact(ingested.asset);
          const verifiedArtifact = await bindRepositoryMedia(
            context.application,
            claimedArtifact,
            context.abortSignal,
            MAXIMUM_MEDIA_INGEST_INPUT_BYTES,
          );
          const receiptBody = MediaIngestReceiptSchema.parse({
            assetSha256: canonicalJsonSha256(ingested.asset),
            createdAt: context.application.clock.now().toISOString(),
            ffprobeVersion: mediaCapabilityVersion(
              capabilityBindings,
              "ffprobe",
            ),
            input: boundInput.source,
            kind: "atet.local-media-ingest-receipt",
            operation: "media.ingest",
            output: verifiedArtifact.artifact,
            projectGenerationSha256: snapshot.generation.generationSha256,
            role: boundInput.role,
            schemaVersion: 1,
          });
          const receipt = await publishContentAddressedReceipt({
            context,
            receipt: receiptBody,
            workspace,
          });
          const output = MediaIngestOutputSchema.parse({
            artifact: verifiedArtifact.artifact,
            asset: ingested.asset,
            created: ingested.created,
            receipt,
          });
          await writeOperationCompletionCheckpoint(context, {
            inputSchemaId: "atet.operation.media.ingest.input/v1",
            kind: "media.ingest",
            outputSchemaId: "atet.operation.media.ingest.output/v1",
            version: 1,
          }, output);
          return output;
        } finally {
          await workspace.dispose();
        }
      },
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
