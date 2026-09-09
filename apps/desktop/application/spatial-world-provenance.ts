import { z } from "zod";

import { canonicalJsonSha256 } from "../core/canonical-json";
import { RepositoryRelativePathSchema, Sha256Schema } from "../contracts/recording";

// Frozen receipt compatibility for locally retained worlds. These literals
// describe historical receipts; they do not authorize requests or quote prices.
const worldLabsId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value =>
  value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const request = z.strictObject({
  display_name: text(64), model: z.literal("marble-1.1"),
  permission: z.strictObject({ public: z.literal(false) }),
  world_prompt: z.strictObject({ text_prompt: text(8_000), type: z.literal("text") }),
});
const artifact = z.strictObject({
  path: RepositoryRelativePathSchema,
  bytes: z.number().int().safe().positive().max(128 * 1024 * 1024),
  sha256: Sha256Schema,
});
const world = z.strictObject({
  worldId: worldLabsId, model: z.literal("marble-1.1"), displayName: text(256),
  semanticsMetadata: z.strictObject({
    groundPlaneOffset: z.number().finite().min(-1_000_000).max(1_000_000).nullable(),
    metricScaleFactor: z.number().finite().positive().max(1_000_000).nullable(),
  }),
});

/** Validate retained evidence without a provider client, credential, or request. */
export const WorldLabsProvenanceSchema = z.strictObject({
  kind: z.literal("atet.world-labs-provenance"), schemaVersion: z.literal(1),
  attemptId: worldLabsId, operationId: worldLabsId,
  operationBinding: z.enum(["dispatch", "operator-recovery"]),
  request, requestSha256: Sha256Schema, responseSha256: Sha256Schema,
  worldResponseSha256: Sha256Schema.optional(),
  reservedCredits: z.literal(1_580),
  settledCredits: z.number().int().safe().nonnegative().nullable(),
  world, quality: z.enum(["100k", "500k"]),
  assets: z.strictObject({
    splat: artifact.extend({ sourceUrlSha256: Sha256Schema }),
    collider: artifact.extend({ sourceUrlSha256: Sha256Schema }),
  }),
  reproducibility: z.literal("retained-assets-only"), normalization: z.literal("caller-must-declare-and-verify"),
  assetValidation: z.literal("retained-bytes-unvalidated"), clientGenerationAttempts: z.literal(1),
  capabilityLosses: z.tuple([z.literal("static-radiance-field"), z.literal("no-object-semantics"), z.literal("no-material-editability"), z.literal("collider-is-approximate")]),
}).refine(value => canonicalJsonSha256(value.request) === value.requestSha256, "World Labs request digest does not match the retained request.");
