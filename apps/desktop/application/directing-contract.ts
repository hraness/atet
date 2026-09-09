import { z } from "zod";

import { createBoundedJsonValueSnapshot } from "../../../src/code/json-snapshot";
import { Sha256Schema } from "../contracts";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import {
  GatewayMediaSourceReferenceSchema,
  GatewayRequestIdSchema,
  GatewayVideoOperationInputSchema,
  GatewayVideoOperationResultSchema,
  type GatewayMediaSourceReference,
  type GatewayPortRequest,
} from "./gateway-port";

export const DIRECTING_LIMITS = Object.freeze({ shots: 64, recipes: 128, attempts: 1024, stateBytes: 32 * 1024 * 1024 });
const SlugSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const RecipeIdSchema = z.string().regex(/^direct_[a-z][a-z0-9_-]{0,63}$/u);
const AttemptIdSchema = z.string().regex(/^take_[a-z][a-z0-9_-]{0,63}$/u);
const MoneySchema = z.number().int().safe().positive();
const TextSchema = z.string().min(1).max(100_000).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value), "Text must be nonempty and contain no disallowed control characters.");
const ImageSchema = GatewayMediaSourceReferenceSchema.refine(source => source.mediaType.startsWith("image/") && source.bytes <= 50 * 1024 * 1024, "A directing frame must be an image of at most 50 MiB.");
const VideoSourceSchema = GatewayMediaSourceReferenceSchema.refine(source => source.mediaType.startsWith("video/") && source.facts?.durationSeconds !== undefined, "Endpoint video sources require a measured duration.");

function capture(input: unknown, name: string, maximumBytes: number): unknown {
  return createBoundedJsonValueSnapshot(input, maximumBytes, name, { maximumDepth: 32, maximumValues: 1_000_000 }).value;
}

export const DirectingShotSchema = z.strictObject({
  id: SlugSchema,
  prompt: TextSchema,
  model: GatewayVideoOperationInputSchema.shape.model,
  durationSeconds: z.number().int().min(1).max(60),
  resolution: GatewayVideoOperationInputSchema.shape.resolution.unwrap(),
  aspectRatio: GatewayVideoOperationInputSchema.shape.aspectRatio.unwrap(),
  fps: GatewayVideoOperationInputSchema.shape.fps,
  seed: GatewayVideoOperationInputSchema.shape.seed,
  firstFrame: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("image"), source: ImageSchema }),
    z.strictObject({ kind: z.literal("shot-end"), shotId: SlugSchema }),
  ]).optional(),
  lastFrame: ImageSchema.optional(),
}).superRefine((shot, context) => {
  if (shot.lastFrame !== undefined && shot.firstFrame === undefined) context.addIssue({ code: "custom", message: "A last frame requires an authored first-frame reference." });
});

export const DirectingRecipeSchema = z.preprocess(input => capture(input, "directing recipe", 8 * 1024 * 1024), z.strictObject({
  kind: z.literal("atet.directing-recipe"),
  schemaVersion: z.literal(1),
  id: RecipeIdSchema,
  title: TextSchema.max(512),
  shots: z.array(DirectingShotSchema).min(1).max(DIRECTING_LIMITS.shots),
}).superRefine((recipe, context) => {
  const seen = new Set<string>();
  for (const [index, shot] of recipe.shots.entries()) {
    if (seen.has(shot.id)) context.addIssue({ code: "custom", path: ["shots", index, "id"], message: "Shot IDs must be unique." });
    if (shot.firstFrame?.kind === "shot-end" && !seen.has(shot.firstFrame.shotId)) context.addIssue({ code: "custom", path: ["shots", index, "firstFrame"], message: "A shot-end reference must name an earlier shot." });
    seen.add(shot.id);
  }
}));

export const DirectingPtsSchema = z.strictObject({
  value: z.string().regex(/^(?:0|-?[1-9][0-9]{0,19})$/u),
  timeBaseNumerator: z.number().int().safe().positive().max(1_000_000_000),
  timeBaseDenominator: z.number().int().safe().positive().max(1_000_000_000),
});

/** Native PTS can precede zero or start beyond the clip's relative duration. */
export function directingPtsTimeUs(input: z.infer<typeof DirectingPtsSchema>): number {
  const pts = DirectingPtsSchema.parse(input);
  const numerator = BigInt(pts.value) * BigInt(pts.timeBaseNumerator) * 1_000_000n;
  const denominator = BigInt(pts.timeBaseDenominator), absolute = numerator < 0n ? -numerator : numerator;
  // Round nearest, with exact half-microsecond ties away from zero.
  const rounded = (2n * absolute + denominator) / (2n * denominator);
  const timeUs = Number(numerator < 0n ? -rounded : rounded);
  if (!Number.isSafeInteger(timeUs)) throw new RangeError("Native endpoint PTS exceeds the safe microsecond clock.");
  return timeUs;
}

export const DirectingEndpointSchema = z.strictObject({
  image: ImageSchema,
  source: VideoSourceSchema,
  frameIndex: z.number().int().safe().nonnegative(),
  pts: DirectingPtsSchema,
  timeUs: z.number().int().safe(),
}).superRefine((endpoint, context) => {
  try {
    if (endpoint.timeUs !== directingPtsTimeUs(endpoint.pts)) context.addIssue({ code: "custom", message: "Endpoint microseconds must match the rounded native rational PTS." });
  } catch {
    context.addIssue({ code: "custom", message: "Native endpoint PTS exceeds the safe microsecond clock." });
  }
});

export const DirectingQuoteSchema = z.strictObject({
  catalogSha256: Sha256Schema,
  validatedAt: z.iso.datetime({ offset: true }),
  costMicroUsd: MoneySchema,
  rateMicroUsdPerSecond: MoneySchema,
});
export const DirectingDependencySchema = z.strictObject({ shotId: SlugSchema, attemptId: AttemptIdSchema, outputSha256: Sha256Schema });
const ReviewSchema = z.strictObject({ decision: z.enum(["accepted", "rejected"]), note: TextSchema.max(4096).optional() });
const FailureSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const VideoRequestSchema = z.strictObject({ operation: z.literal("video"), request: GatewayVideoOperationInputSchema }).superRefine((input, context) => {
  const request = input.request;
  if (request.providerOptions !== undefined || request.references !== undefined || request.generateAudio !== undefined || (request.n ?? 1) !== 1 || (request.maxVideosPerCall ?? 1) !== 1) context.addIssue({ code: "custom", message: "Directing uses exactly one video with authored frame conditioning and no provider options." });
});
const AttemptBase = {
  id: AttemptIdSchema,
  recipeSha256: Sha256Schema,
  shotId: SlugSchema,
  shotSha256: Sha256Schema,
  requestId: GatewayRequestIdSchema,
  request: VideoRequestSchema,
  quote: DirectingQuoteSchema,
  dependencies: z.array(DirectingDependencySchema).max(1),
};
export const DirectingAttemptSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...AttemptBase, state: z.literal("reserved") }),
  z.strictObject({ ...AttemptBase, state: z.literal("completed"), result: GatewayVideoOperationResultSchema, endpoint: DirectingEndpointSchema.optional(), review: ReviewSchema.optional() }),
  z.strictObject({ ...AttemptBase, state: z.literal("not-dispatched"), failure: FailureSchema.optional() }),
  z.strictObject({ ...AttemptBase, state: z.literal("ambiguous"), failure: FailureSchema.optional() }),
]);

export type DirectingShot = z.infer<typeof DirectingShotSchema>;
export type DirectingRecipe = z.infer<typeof DirectingRecipeSchema>;
export type DirectingEndpoint = z.infer<typeof DirectingEndpointSchema>;
export type DirectingQuote = z.infer<typeof DirectingQuoteSchema>;
export type DirectingDependency = z.infer<typeof DirectingDependencySchema>;
export type DirectingAttempt = z.infer<typeof DirectingAttemptSchema>;
export type CompletedDirectingAttempt = Extract<DirectingAttempt, { state: "completed" }>;

/** Facts are remeasured by the media port; immutable source identity is not. */
export function sameDirectingSource(left: GatewayMediaSourceReference, right: GatewayMediaSourceReference): boolean {
  return left.path === right.path && left.sha256 === right.sha256 && left.bytes === right.bytes && left.mediaType === right.mediaType;
}

export function directingBoundShotSha256(shot: DirectingShot, dependencies: readonly (DirectingDependency & { readonly shotSha256: string })[]): string {
  return canonicalJsonSha256({ domain: "atet.directing-shot/v1", shot, dependencies });
}

/** Bind local reconciliation to the exact prepared request and retained take. */
export function directingRequestId(input: {
  readonly id: string;
  readonly attemptId: string;
  readonly recipeSha256: string;
  readonly shotSha256: string;
  readonly request: GatewayPortRequest;
}): string {
  const { id, attemptId, recipeSha256, shotSha256, request } = input;
  return `gateway_${canonicalJsonSha256({ domain: "atet.directing-request/v1", id, attemptId, recipeSha256, shotSha256, request })}`;
}

/** Verify the submitted request against the authored recipe and retained frames. */
export function directingRequestMatchesShot(attempt: DirectingAttempt, shot: DirectingShot, firstFrame: GatewayMediaSourceReference | undefined): boolean {
  const request = attempt.request.request;
  for (const key of ["prompt", "model", "durationSeconds", "resolution", "aspectRatio", "fps", "seed"] as const) if (request[key] !== shot[key]) return false;
  const frames = request.frames ?? [];
  const actualFirst = request.promptImage ?? frames.find(frame => frame.frameType === "first_frame")?.source;
  const actualLast = frames.find(frame => frame.frameType === "last_frame")?.source;
  const equal = (left: GatewayMediaSourceReference | undefined, right: GatewayMediaSourceReference | undefined) => left === undefined || right === undefined ? left === right : sameDirectingSource(left, right);
  return equal(firstFrame, actualFirst) && equal(shot.lastFrame, actualLast);
}

export const DirectingStateSchema = z.preprocess(input => capture(input, "directing state", DIRECTING_LIMITS.stateBytes), z.strictObject({
  kind: z.literal("atet.directing-state"),
  schemaVersion: z.literal(1),
  id: RecipeIdSchema,
  budgetMicroUsd: MoneySchema,
  activeRecipeSha256: Sha256Schema,
  recipes: z.array(z.strictObject({ sha256: Sha256Schema, recipe: DirectingRecipeSchema })).min(1).max(DIRECTING_LIMITS.recipes),
  attempts: z.array(DirectingAttemptSchema).max(DIRECTING_LIMITS.attempts),
  selections: z.record(SlugSchema, AttemptIdSchema),
}).superRefine((state, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  const recipes = new Map<string, DirectingRecipe>();
  for (const item of state.recipes) {
    if (item.recipe.id !== state.id || item.sha256 !== canonicalJsonSha256(item.recipe) || recipes.has(item.sha256)) fail("Retained recipe identities must be unique and bind their exact recipe and directing project.");
    recipes.set(item.sha256, item.recipe);
  }
  if (!recipes.has(state.activeRecipeSha256)) fail("The active recipe must be retained.");
  const attempts = new Map<string, DirectingAttempt>();
  const requestIds = new Set<string>();
  let reserved = 0n;
  for (const attempt of state.attempts) {
    if (attempts.has(attempt.id) || requestIds.has(attempt.requestId)) fail("Attempt and paid request identities must be unique.");
    if (attempt.requestId !== directingRequestId({ id: state.id, attemptId: attempt.id, recipeSha256: attempt.recipeSha256, shotSha256: attempt.shotSha256, request: attempt.request })) fail("A paid request identity must bind the exact directing project, take, recipe, shot, and request.");
    const shot = recipes.get(attempt.recipeSha256)?.shots.find(candidate => candidate.id === attempt.shotId);
    if (shot === undefined) { fail("Each attempt must bind a retained authored shot."); continue; }
    const dependency = attempt.dependencies[0];
    const predecessor = dependency === undefined ? undefined : attempts.get(dependency.attemptId);
    if (shot.firstFrame?.kind === "shot-end") {
      if (dependency === undefined || dependency.shotId !== shot.firstFrame.shotId || predecessor?.shotId !== dependency.shotId || predecessor.state !== "completed" || predecessor.endpoint === undefined || predecessor.result.outputs[0]?.sha256 !== dependency.outputSha256) fail("A continuation must bind an earlier completed take and its exact retained endpoint.");
    } else if (dependency !== undefined) fail("A shot without continuation cannot claim dependencies.");
    const boundDependencies = dependency !== undefined && predecessor !== undefined ? [{ ...dependency, shotSha256: predecessor.shotSha256 }] : [];
    if (attempt.shotSha256 !== directingBoundShotSha256(shot, boundDependencies)) fail("A take must bind its exact authored shot and recursive dependency identity.");
    const firstFrame = shot.firstFrame?.kind === "image" ? shot.firstFrame.source : predecessor?.state === "completed" ? predecessor.endpoint?.image : undefined;
    if (!directingRequestMatchesShot(attempt, shot, firstFrame)) fail("A take's paid request differs from its authored shot or retained conditioning.");
    if (BigInt(attempt.quote.costMicroUsd) !== BigInt(attempt.quote.rateMicroUsdPerSecond) * BigInt(shot.durationSeconds)) fail("A quote must reserve the exact duration at its retained per-second rate.");
    if (attempt.state !== "not-dispatched") reserved += BigInt(attempt.quote.costMicroUsd);
    if (attempt.state === "completed") {
      const output = attempt.result.outputs[0];
      if (attempt.result.requestId !== attempt.requestId || attempt.result.model !== shot.model || attempt.result.outputs.length !== 1 || output === undefined || !output.mediaType.startsWith("video/")) fail("A completed take must retain its exact one-video Gateway result.");
      if (attempt.endpoint !== undefined && (output === undefined || !sameDirectingSource(attempt.endpoint.source, output))) fail("An endpoint must bind the completed video's immutable bytes.");
      if (attempt.review?.decision === "accepted" && attempt.endpoint === undefined) fail("Accepting a take requires its verified endpoint and measured video duration.");
    }
    attempts.set(attempt.id, attempt);
    requestIds.add(attempt.requestId);
  }
  if (reserved > BigInt(state.budgetMicroUsd)) fail("Reserved and potentially spent credits exceed the directing budget.");
  if (Object.keys(state.selections).length > DIRECTING_LIMITS.attempts) fail("Too many retained selections.");
  for (const [shotId, attemptId] of Object.entries(state.selections)) {
    const attempt = attempts.get(attemptId);
    if (attempt?.shotId !== shotId || attempt.state !== "completed" || attempt.review?.decision !== "accepted") fail("Selections must identify accepted completed takes for their own shot.");
  }
}));
export type DirectingState = z.infer<typeof DirectingStateSchema>;

/** Stable equality is used only after the owned schemas capture foreign JSON. */
export function equalDirectingValue(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
