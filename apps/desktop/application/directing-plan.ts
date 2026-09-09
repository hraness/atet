import { canonicalJsonSha256 } from "../core/canonical-json";
import type { GatewayMediaSourceReference, GatewayVideoOperationResult } from "./gateway-port";
import {
  DirectingAttemptSchema, DirectingEndpointSchema, DirectingRecipeSchema, DirectingStateSchema,
  directingBoundShotSha256, equalDirectingValue,
  type CompletedDirectingAttempt, type DirectingAttempt, type DirectingDependency, type DirectingEndpoint,
  type DirectingRecipe, type DirectingShot, type DirectingState,
} from "./directing-contract";

export function parseDirectingRecipe(input: unknown): DirectingRecipe { return DirectingRecipeSchema.parse(input); }
export function parseDirectingState(input: unknown): DirectingState { return DirectingStateSchema.parse(input); }
export function directingRecipeSha256(input: unknown): string { return canonicalJsonSha256(parseDirectingRecipe(input)); }

export function createDirectingState(recipeInput: unknown, budgetMicroUsd: number): DirectingState {
  const recipe = parseDirectingRecipe(recipeInput), sha256 = directingRecipeSha256(recipe);
  return parseDirectingState({ kind: "atet.directing-state", schemaVersion: 1, id: recipe.id, budgetMicroUsd, activeRecipeSha256: sha256, recipes: [{ sha256, recipe }], attempts: [], selections: {} });
}

function currentRecipe(state: DirectingState): DirectingRecipe {
  const recipe = state.recipes.find(item => item.sha256 === state.activeRecipeSha256)?.recipe;
  if (recipe === undefined) throw new RangeError("The active directing recipe is missing.");
  return recipe;
}

export interface ResolvedDirectingShot {
  readonly shot: DirectingShot;
  readonly shotSha256: string;
  readonly dependencies: DirectingDependency[];
  readonly firstFrame?: GatewayMediaSourceReference;
  readonly lastFrame?: GatewayMediaSourceReference;
}

function resolveShot(shot: DirectingShot, accepted: ReadonlyMap<string, CompletedDirectingAttempt>): ResolvedDirectingShot | undefined {
  const dependencies: DirectingDependency[] = [];
  const boundDependencies: (DirectingDependency & { shotSha256: string })[] = [];
  let firstFrame: GatewayMediaSourceReference | undefined;
  if (shot.firstFrame?.kind === "image") firstFrame = shot.firstFrame.source;
  if (shot.firstFrame?.kind === "shot-end") {
    const predecessor = accepted.get(shot.firstFrame.shotId);
    if (predecessor?.endpoint === undefined) return undefined;
    const dependency = { shotId: predecessor.shotId, attemptId: predecessor.id, outputSha256: predecessor.result.outputs[0]!.sha256 };
    dependencies.push(dependency);
    boundDependencies.push({ ...dependency, shotSha256: predecessor.shotSha256 });
    firstFrame = predecessor.endpoint.image;
  }
  return { shot, shotSha256: directingBoundShotSha256(shot, boundDependencies), dependencies, ...(firstFrame === undefined ? {} : { firstFrame }), ...(shot.lastFrame === undefined ? {} : { lastFrame: shot.lastFrame }) };
}

function acceptedSelections(state: DirectingState): Map<string, CompletedDirectingAttempt> {
  const attempts = new Map(state.attempts.map(attempt => [attempt.id, attempt]));
  const accepted = new Map<string, CompletedDirectingAttempt>();
  // Recipes only reference earlier shots, so this pass also checks every ancestor.
  for (const shot of currentRecipe(state).shots) {
    const selectedId = Object.hasOwn(state.selections, shot.id) ? state.selections[shot.id] : undefined;
    const attempt = selectedId === undefined ? undefined : attempts.get(selectedId);
    if (attempt?.state !== "completed" || attempt.review?.decision !== "accepted" || attempt.endpoint === undefined) continue;
    const resolved = resolveShot(shot, accepted);
    if (resolved !== undefined && attempt.shotSha256 === resolved.shotSha256 && equalDirectingValue(attempt.dependencies, resolved.dependencies)) accepted.set(shot.id, attempt);
  }
  return accepted;
}

export function activeDirectingSelections(input: DirectingState): Record<string, CompletedDirectingAttempt> {
  const selections: Record<string, CompletedDirectingAttempt> = Object.create(null) as Record<string, CompletedDirectingAttempt>;
  for (const [shotId, attempt] of acceptedSelections(parseDirectingState(input))) selections[shotId] = attempt;
  return selections;
}

export function resolveDirectingShot(input: DirectingState, shotId: string): ResolvedDirectingShot {
  const state = parseDirectingState(input);
  const shot = currentRecipe(state).shots.find(candidate => candidate.id === shotId);
  if (shot === undefined) throw new RangeError(`Unknown directing shot: ${shotId}.`);
  const resolved = resolveShot(shot, acceptedSelections(state));
  if (resolved === undefined) throw new RangeError("A continuation requires a currently accepted predecessor with its retained endpoint.");
  return resolved;
}

export function reviseDirectingRecipe(input: DirectingState, recipeInput: unknown): DirectingState {
  const state = parseDirectingState(input), recipe = parseDirectingRecipe(recipeInput), sha256 = directingRecipeSha256(recipe);
  if (recipe.id !== state.id) throw new RangeError("A directing revision cannot change project identity.");
  return parseDirectingState({ ...state, activeRecipeSha256: sha256, recipes: state.recipes.some(item => item.sha256 === sha256) ? state.recipes : [...state.recipes, { sha256, recipe }] });
}

/** Ambiguous, failed-after-dispatch and interrupted calls retain their reservation. */
export function totalDirectingReservedMicroUsd(input: DirectingState): number {
  const state = parseDirectingState(input);
  return Number(state.attempts.reduce((sum, attempt) => sum + (attempt.state === "not-dispatched" ? 0n : BigInt(attempt.quote.costMicroUsd)), 0n));
}

export function reserveDirectingAttempt(input: DirectingState, attemptInput: unknown): DirectingState {
  const state = parseDirectingState(input), attempt = DirectingAttemptSchema.parse(attemptInput);
  if (attempt.state !== "reserved") throw new RangeError("A new directing take must be reserved before dispatch.");
  const existing = state.attempts.find(candidate => candidate.id === attempt.id);
  if (existing !== undefined) {
    if (equalDirectingValue(existing, attempt)) return state;
    throw new RangeError("A retained take identity cannot be reused for another attempt.");
  }
  const resolved = resolveDirectingShot(state, attempt.shotId);
  if (attempt.recipeSha256 !== state.activeRecipeSha256 || attempt.shotSha256 !== resolved.shotSha256 || !equalDirectingValue(attempt.dependencies, resolved.dependencies)) throw new RangeError("The directing reservation is stale against the active recipe or accepted dependencies.");
  return parseDirectingState({ ...state, attempts: [...state.attempts, attempt] });
}

function replaceAttempt(state: DirectingState, attempt: DirectingAttempt): DirectingState {
  return parseDirectingState({ ...state, attempts: state.attempts.map(candidate => candidate.id === attempt.id ? attempt : candidate) });
}
function findAttempt(state: DirectingState, attemptId: string): DirectingAttempt {
  const attempt = state.attempts.find(candidate => candidate.id === attemptId);
  if (attempt === undefined) throw new RangeError(`Unknown directing take: ${attemptId}.`);
  return attempt;
}

export function completeDirectingAttempt(input: DirectingState, attemptId: string, result: GatewayVideoOperationResult, endpoint?: DirectingEndpoint): DirectingState {
  const state = parseDirectingState(input), attempt = findAttempt(state, attemptId);
  if (attempt.state === "completed") {
    if (!equalDirectingValue(attempt.result, result)) throw new RangeError("A completed take's result is immutable.");
    return endpoint === undefined ? state : attachDirectingEndpoint(state, attemptId, endpoint);
  }
  if (attempt.state === "not-dispatched") throw new RangeError("A proven undispatched take cannot become completed.");
  const { state: _state, ...base } = attempt;
  const { failure: _failure, ...fields } = "failure" in base ? base : { ...base, failure: undefined };
  return replaceAttempt(state, DirectingAttemptSchema.parse({ ...fields, state: "completed", result, ...(endpoint === undefined ? {} : { endpoint }) }));
}

export function attachDirectingEndpoint(input: DirectingState, attemptId: string, endpointInput: unknown): DirectingState {
  const state = parseDirectingState(input), attempt = findAttempt(state, attemptId), endpoint = DirectingEndpointSchema.parse(endpointInput);
  if (attempt.state !== "completed") throw new RangeError("Endpoint extraction requires a completed take.");
  if (attempt.endpoint !== undefined && !equalDirectingValue(attempt.endpoint, endpoint)) throw new RangeError("A retained endpoint is immutable.");
  return replaceAttempt(state, { ...attempt, endpoint });
}

/** The adapter must supply durable evidence before choosing not-dispatched. */
export function settleDirectingAttempt(input: DirectingState, attemptId: string, status: "not-dispatched" | "ambiguous", failure?: string): DirectingState {
  const state = parseDirectingState(input), attempt = findAttempt(state, attemptId);
  if (attempt.state === "completed") throw new RangeError("A completed take cannot release or replace its paid reservation.");
  if (attempt.state === "ambiguous" && status === "not-dispatched") throw new RangeError("An ambiguous take cannot release its reservation; missing local evidence does not prove the paid call was undispatched.");
  if (attempt.state === "not-dispatched" && status !== "not-dispatched") throw new RangeError("A proven undispatched take cannot be dispatched or revived.");
  const { state: _state, ...base } = attempt;
  return replaceAttempt(state, DirectingAttemptSchema.parse({ ...base, state: status, ...(failure === undefined ? {} : { failure }) }));
}

export function reviewDirectingAttempt(input: DirectingState, attemptId: string, decision: "accepted" | "rejected", note?: string): DirectingState {
  const state = parseDirectingState(input), attempt = findAttempt(state, attemptId);
  if (attempt.state !== "completed") throw new RangeError("Only completed takes can be reviewed.");
  if (decision === "accepted") {
    if (attempt.endpoint === undefined) throw new RangeError("Accepting a take requires its retained endpoint and measured duration.");
    const resolved = resolveDirectingShot(state, attempt.shotId);
    if (attempt.shotSha256 !== resolved.shotSha256 || !equalDirectingValue(attempt.dependencies, resolved.dependencies)) throw new RangeError("This take is stale against the active shot or its accepted dependencies.");
  }
  const selections = { ...state.selections };
  if (decision === "accepted") selections[attempt.shotId] = attempt.id;
  else if (Object.hasOwn(selections, attempt.shotId) && selections[attempt.shotId] === attempt.id) delete selections[attempt.shotId];
  const reviewed = DirectingAttemptSchema.parse({ ...attempt, review: { decision, ...(note === undefined ? {} : { note }) } });
  return parseDirectingState({ ...state, selections, attempts: state.attempts.map(candidate => candidate.id === attempt.id ? reviewed : candidate) });
}

export interface DirectingTimelineShot {
  readonly shotId: string;
  readonly attemptId: string;
  readonly source: GatewayMediaSourceReference;
  readonly startUs: number;
  readonly endUs: number;
  readonly durationUs: number;
}

export function buildDirectingTimeline(input: DirectingState): DirectingTimelineShot[] {
  const state = parseDirectingState(input), accepted = acceptedSelections(state);
  let timeUs = 0;
  return currentRecipe(state).shots.map(shot => {
    const attempt = accepted.get(shot.id);
    if (attempt?.endpoint === undefined) throw new RangeError(`Shot ${shot.id} requires a currently accepted take before assembly.`);
    const source = attempt.endpoint.source;
    const durationUs = Math.round(source.facts!.durationSeconds! * 1_000_000);
    if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || !Number.isSafeInteger(timeUs + durationUs)) throw new RangeError("Measured clip durations exceed the safe directing timeline.");
    const result = { shotId: shot.id, attemptId: attempt.id, source, startUs: timeUs, endUs: timeUs + durationUs, durationUs };
    timeUs = result.endUs;
    return result;
  });
}
