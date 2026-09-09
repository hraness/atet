import { z } from "zod";

import { canonicalJsonSha256 } from "../core/canonical-json";
import { RepositoryRelativePathSchema, Sha256Schema } from "../contracts/recording";

/** Pinned text generation: 1,500 world credits plus 80 panorama credits. */
export const WORLD_LABS_TEXT_CREDITS = 1_580;
export const WORLD_LABS_MODEL = "marble-1.1";
export const WorldLabsIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value =>
  value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));

export const WorldLabsGenerationInputSchema = z.strictObject({
  attemptId: WorldLabsIdSchema,
  displayName: text(64),
  prompt: text(8_000),
  quality: z.enum(["100k", "500k"]),
});
export type WorldLabsGenerationInput = z.infer<typeof WorldLabsGenerationInputSchema>;

export const WorldLabsProviderRequestSchema = z.strictObject({
  display_name: text(64), model: z.literal(WORLD_LABS_MODEL),
  permission: z.strictObject({ public: z.literal(false) }),
  world_prompt: z.strictObject({ text_prompt: text(8_000), type: z.literal("text") }),
});

export const WorldLabsBudgetSchema = z.strictObject({
  budgetId: WorldLabsIdSchema,
  maximumCredits: z.number().int().safe().min(WORLD_LABS_TEXT_CREDITS).max(1_000_000),
});

/** Adapter authority is deliberately separate from serializable generation input. */
export interface WorldLabsPaidGrant {
  readonly allowPaidGeneration: true;
  readonly budgetId: string;
  readonly maximumCredits: number;
}

export function planWorldLabsGeneration(value: unknown) {
  const input = WorldLabsGenerationInputSchema.parse(value);
  const request = {
    display_name: input.displayName,
    model: WORLD_LABS_MODEL,
    permission: { public: false },
    world_prompt: { text_prompt: input.prompt, type: "text" },
  } as const;
  return {
    input,
    model: WORLD_LABS_MODEL,
    request,
    requestSha256: canonicalJsonSha256(request),
    reservedCredits: WORLD_LABS_TEXT_CREDITS,
    priceBasis: "https://docs.worldlabs.ai/api/pricing",
    reproducibility: "retained-assets-only",
  } as const;
}

export const WorldLabsArtifactSchema = z.strictObject({
  path: RepositoryRelativePathSchema,
  bytes: z.number().int().safe().positive().max(128 * 1024 * 1024),
  sha256: Sha256Schema,
});
export const WorldLabsWorldMetadataSchema = z.strictObject({
  worldId: WorldLabsIdSchema,
  model: z.literal(WORLD_LABS_MODEL),
  displayName: text(256),
  semanticsMetadata: z.strictObject({
    groundPlaneOffset: z.number().finite().min(-1_000_000).max(1_000_000).nullable(),
    metricScaleFactor: z.number().finite().positive().max(1_000_000).nullable(),
  }),
});
export const WorldLabsRetainedSchema = z.strictObject({
  splat: WorldLabsArtifactSchema,
  collider: WorldLabsArtifactSchema,
  provenance: WorldLabsArtifactSchema,
  world: WorldLabsWorldMetadataSchema,
});
export const WorldLabsProvenanceSchema = z.strictObject({
  kind: z.literal("atet.world-labs-provenance"), schemaVersion: z.literal(1),
  attemptId: WorldLabsIdSchema, operationId: WorldLabsIdSchema,
  operationBinding: z.enum(["dispatch", "operator-recovery"]),
  request: WorldLabsProviderRequestSchema, requestSha256: Sha256Schema, responseSha256: Sha256Schema,
  /** A nullable operation snapshot may require a separate authenticated World read. */
  worldResponseSha256: Sha256Schema.optional(),
  reservedCredits: z.literal(WORLD_LABS_TEXT_CREDITS),
  settledCredits: z.number().int().safe().nonnegative().nullable(),
  world: WorldLabsWorldMetadataSchema, quality: z.enum(["100k", "500k"]),
  assets: z.strictObject({
    splat: WorldLabsArtifactSchema.extend({ sourceUrlSha256: Sha256Schema }),
    collider: WorldLabsArtifactSchema.extend({ sourceUrlSha256: Sha256Schema }),
  }),
  reproducibility: z.literal("retained-assets-only"), normalization: z.literal("caller-must-declare-and-verify"),
  assetValidation: z.literal("retained-bytes-unvalidated"), clientGenerationAttempts: z.literal(1),
  capabilityLosses: z.tuple([z.literal("static-radiance-field"), z.literal("no-object-semantics"), z.literal("no-material-editability"), z.literal("collider-is-approximate")]),
}).refine(value => canonicalJsonSha256(value.request) === value.requestSha256, "World Labs request digest does not match the retained request.");
export type WorldLabsProvenance = z.infer<typeof WorldLabsProvenanceSchema>;
export const WorldLabsAttemptSummarySchema = z.strictObject({
  kind: z.literal("atet.world-labs-attempt"),
  schemaVersion: z.literal(1),
  attemptId: WorldLabsIdSchema,
  requestSha256: Sha256Schema,
  model: z.literal(WORLD_LABS_MODEL),
  quality: z.enum(["100k", "500k"]),
  status: z.enum(["prepared", "ambiguous", "pending", "failed", "retained"]),
  /** Null is unconfirmed: a pre-binding crash may already have consumed a slot. */
  reservedCredits: z.literal(WORLD_LABS_TEXT_CREDITS).nullable(),
  operationId: WorldLabsIdSchema.optional(),
  settledCredits: z.number().int().safe().nonnegative().optional(),
  budgetQuarantined: z.literal(true).optional(),
  retained: WorldLabsRetainedSchema.optional(),
});
export type WorldLabsAttemptSummary = z.infer<typeof WorldLabsAttemptSummarySchema>;

export interface WorldLabsService {
  plan(input: unknown): ReturnType<typeof planWorldLabsGeneration>;
  generate(input: unknown, adapter: Readonly<{ grant: WorldLabsPaidGrant; signal?: AbortSignal }>): Promise<WorldLabsAttemptSummary>;
  resume(input: Readonly<{ attemptId: string }>, adapter: Readonly<{ allowProviderRead: true; signal?: AbortSignal }>): Promise<WorldLabsAttemptSummary>;
  inspect(input: Readonly<{ attemptId: string }>): Promise<WorldLabsAttemptSummary>;
  /** Explicit operator reconciliation after a lost POST response; this never generates. */
  recover(input: Readonly<{ attemptId: string; operationId: string }>, adapter: Readonly<{ allowOperationRecovery: true; signal?: AbortSignal }>): Promise<WorldLabsAttemptSummary>;
}
