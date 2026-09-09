import { describe, expect, test } from "bun:test";

import { canonicalJsonSha256 } from "../core/canonical-json";
import { assertProperty, fc } from "../testing/property";
import { DirectingAttemptSchema, DirectingEndpointSchema, DirectingStateSchema, directingPtsTimeUs, directingRequestId, type DirectingAttempt, type DirectingEndpoint, type DirectingRecipe, type DirectingState } from "./directing-contract";
import {
  activeDirectingSelections, attachDirectingEndpoint, buildDirectingTimeline, completeDirectingAttempt,
  createDirectingState, directingRecipeSha256, parseDirectingRecipe, reserveDirectingAttempt,
  resolveDirectingShot, reviewDirectingAttempt, reviseDirectingRecipe, settleDirectingAttempt,
  totalDirectingReservedMicroUsd,
} from "./directing-plan";
import type { GatewayPortRequest, GatewayVideoOperationResult } from "./gateway-port";

const hash = (value: unknown) => canonicalJsonSha256(value);
function recipe(): DirectingRecipe {
  const shot = { prompt: "An original silver sculpture in a sunlit atrium.", model: "minimax/minimax-h3-max", durationSeconds: 5, resolution: "480p", aspectRatio: "16:9", fps: 24 };
  return parseDirectingRecipe({ kind: "atet.directing-recipe", schemaVersion: 1, id: "direct_film", title: "Sculpture study", shots: [
    { ...shot, id: "establish" },
    { ...shot, id: "orbit", firstFrame: { kind: "shot-end", shotId: "establish" } },
    { ...shot, id: "close", firstFrame: { kind: "shot-end", shotId: "orbit" } },
    { ...shot, id: "independent" },
  ] });
}
function reservation(state: DirectingState, shotId: string, slug = shotId, rate = 25_000): DirectingAttempt {
  const resolved = resolveDirectingShot(state, shotId), { shot, shotSha256, dependencies, firstFrame, lastFrame } = resolved;
  const { id: _id, firstFrame: _first, lastFrame: _last, ...settings } = shot;
  const request: GatewayPortRequest = { operation: "video", request: { ...settings, ...(firstFrame === undefined ? {} : { promptImage: firstFrame }), ...(lastFrame === undefined ? {} : { frames: [{ frameType: "last_frame", source: lastFrame }] }) } };
  return DirectingAttemptSchema.parse({
    id: `take_${slug}`, recipeSha256: state.activeRecipeSha256, shotId, shotSha256,
    requestId: directingRequestId({ id: state.id, attemptId: `take_${slug}`, recipeSha256: state.activeRecipeSha256, shotSha256, request }), state: "reserved", dependencies,
    quote: { catalogSha256: hash("live catalog"), validatedAt: "2026-09-09T12:00:00Z", costMicroUsd: rate * shot.durationSeconds, rateMicroUsdPerSecond: rate },
    request,
  });
}
function output(attempt: DirectingAttempt, durationSeconds = 4.96): { result: GatewayVideoOperationResult; endpoint: DirectingEndpoint } {
  const source = { bytes: 1_234, mediaType: "video/mp4", path: `artifacts/atet/generated/${attempt.id}/video.mp4`, sha256: hash(attempt.id), facts: { durationSeconds, width: 848, height: 480 } };
  const result: GatewayVideoOperationResult = { operation: "video", model: attempt.request.request.model, requestId: attempt.requestId, outputs: [{ bytes: source.bytes, path: source.path, mediaType: source.mediaType, sha256: source.sha256 }], receipt: { bytes: 256, path: `artifacts/atet/generated/${attempt.id}/receipt.json`, sha256: hash([attempt.id, "receipt"]) } };
  const endpoint: DirectingEndpoint = { source, image: { bytes: 125, mediaType: "image/png", path: `artifacts/atet/generated/${attempt.id}/last.png`, sha256: hash([attempt.id, "image"]) }, frameIndex: 118, pts: { value: "118", timeBaseNumerator: 1, timeBaseDenominator: 24 }, timeUs: 4_916_667 };
  return { result, endpoint };
}
function accepted(state: DirectingState, shotId: string, slug = shotId): DirectingState {
  const attempt = reservation(state, shotId, slug), { result, endpoint } = output(attempt);
  return reviewDirectingAttempt(completeDirectingAttempt(reserveDirectingAttempt(state, attempt), attempt.id, result, endpoint), attempt.id, "accepted");
}
function acceptedFilm(): DirectingState { return recipe().shots.reduce((state, shot) => accepted(state, shot.id), createDirectingState(recipe(), 5_000_000)); }

describe("retained directing recipes and lineage", () => {
  test("strict ordered recipes reject impossible references and executable provider fields", () => {
    const original = recipe();
    for (const firstFrame of [{ kind: "shot-end", shotId: "establish" }, { kind: "shot-end", shotId: "missing" }, { kind: "shot-end", shotId: "close" }]) expect(() => parseDirectingRecipe({ ...original, shots: [{ ...original.shots[0], firstFrame }, ...original.shots.slice(1)] })).toThrow("earlier shot");
    expect(() => parseDirectingRecipe({ ...original, shots: [original.shots[0], original.shots[0]] })).toThrow("unique");
    expect(() => parseDirectingRecipe({ ...original, shots: [{ ...original.shots[0], providerOptions: { fal: {} } }] })).toThrow();
    expect(() => parseDirectingRecipe({ ...original, shots: [{ ...original.shots[0], lastFrame: { path: "frame.png", bytes: 1, sha256: hash("frame"), mediaType: "image/png" } }] })).toThrow("requires");
    expect(() => parseDirectingRecipe({ ...original, shots: Array.from({ length: 65 }, (_, index) => ({ ...original.shots[0], id: `shot_${index}` })) })).toThrow();
  });
  test("captures foreign JSON without invoking getters", () => {
    let calls = 0;
    expect(() => parseDirectingRecipe({ ...recipe(), get title() { calls++; return "Getter"; } })).toThrow();
    expect(calls).toBe(0);
    const cyclic: { cyclic?: unknown } = {}; cyclic.cyclic = cyclic;
    expect(() => parseDirectingRecipe(cyclic)).toThrow();
  });
  test("canonical recipe identity ignores object key order but preserves shot order", () => {
    const source = recipe(), reordered = Object.fromEntries(Object.entries(source).reverse());
    expect(directingRecipeSha256(reordered)).toBe(directingRecipeSha256(source));
    expect(directingRecipeSha256({ ...source, shots: [source.shots[3], ...source.shots.slice(0, 3)] })).not.toBe(directingRecipeSha256(source));
  });
  test("an ancestor revision invalidates descendants while preserving independent acceptance and old media", () => {
    const initial = acceptedFilm(), changed = recipe(); changed.shots[0]!.prompt = "A copper sculpture replaces silver.";
    const revised = reviseDirectingRecipe(initial, changed);
    expect(Object.keys(activeDirectingSelections(revised))).toEqual(["independent"]);
    expect(revised.attempts).toEqual(initial.attempts); expect(revised.selections).toEqual(initial.selections);
    expect(() => resolveDirectingShot(revised, "orbit")).toThrow("currently accepted");
    expect(() => reviewDirectingAttempt(revised, "take_establish", "accepted")).toThrow("stale");
    expect(() => buildDirectingTimeline(revised)).toThrow("establish");
    expect(Object.keys(activeDirectingSelections(reviseDirectingRecipe(revised, recipe())))).toEqual(["establish", "orbit", "close", "independent"]);
  });
  test("replacing a parent take invalidates all descendants even when requested settings are identical", () => {
    const initial = acceptedFilm(), replacement = accepted(initial, "establish", "establish_v2");
    expect(Object.keys(activeDirectingSelections(replacement))).toEqual(["establish", "independent"]);
    expect(() => reviewDirectingAttempt(replacement, "take_orbit", "accepted")).toThrow("stale");
    expect(replacement.attempts).toHaveLength(5);
  });
  test("metadata-only recipe revisions retain accepted shots", () => {
    const initial = acceptedFilm();
    expect(Object.keys(activeDirectingSelections(reviseDirectingRecipe(initial, { ...recipe(), title: "A better film title" })))).toHaveLength(4);
  });
  test("explicit rejection clears selection and prevents continuation without removing retained media", () => {
    const state = reviewDirectingAttempt(acceptedFilm(), "take_orbit", "rejected", "The motion jumps.");
    expect(Object.keys(activeDirectingSelections(state))).toEqual(["establish", "independent"]);
    expect(state.attempts).toHaveLength(4);
    expect(() => resolveDirectingShot(state, "close")).toThrow("currently accepted");
  });
  test("assembly uses measured durations and complete accepted recipe order", () => {
    const timeline = buildDirectingTimeline(acceptedFilm());
    expect(timeline.map(shot => [shot.shotId, shot.startUs, shot.endUs])).toEqual([
      ["establish", 0, 4_960_000], ["orbit", 4_960_000, 9_920_000], ["close", 9_920_000, 14_880_000], ["independent", 14_880_000, 19_840_000],
    ]);
  });
  test("reordered recipes can only keep acceptance when dependency order remains valid", () => {
    const initial = acceptedFilm(), authored = recipe();
    const revised = reviseDirectingRecipe(initial, { ...authored, shots: [authored.shots[3], ...authored.shots.slice(0, 3)] });
    expect(buildDirectingTimeline(revised)[0]?.shotId).toBe("independent");
  });
  test("prototype-named shots require their own accepted selection", () => {
    const authored = recipe();
    authored.shots = [{ ...authored.shots[0]!, id: "constructor" }, { ...authored.shots[0]!, id: "prototype" }];
    const initial = createDirectingState(authored, 5_000_000);
    const empty = activeDirectingSelections(initial);
    expect(Object.getPrototypeOf(empty)).toBeNull();
    expect(empty.constructor).toBeUndefined();
    expect(() => buildDirectingTimeline(initial)).toThrow("constructor");
    const selected = accepted(accepted(initial, "constructor"), "prototype");
    expect(Object.keys(activeDirectingSelections(selected))).toEqual(["constructor", "prototype"]);
    expect(buildDirectingTimeline(selected).map(shot => shot.shotId)).toEqual(["constructor", "prototype"]);
    const rejected = reviewDirectingAttempt(selected, "take_constructor", "rejected");
    expect(activeDirectingSelections(rejected).constructor).toBeUndefined();
    expect(Object.hasOwn(rejected.selections, "constructor")).toBe(false);
  });
});

describe("paid-attempt accounting and immutable recovery", () => {
  test("reserves before dispatch, prevents duplicate identities, and releases only proven undispatched calls", () => {
    const initial = createDirectingState(recipe(), 125_000), take = reservation(initial, "establish");
    const reserved = reserveDirectingAttempt(initial, take);
    expect(reserveDirectingAttempt(reserved, take)).toEqual(reserved);
    expect(totalDirectingReservedMicroUsd(reserved)).toBe(125_000);
    expect(() => reserveDirectingAttempt(reserved, reservation(reserved, "independent"))).toThrow("budget");
    const ambiguous = settleDirectingAttempt(reserved, take.id, "ambiguous", "interrupted");
    expect(totalDirectingReservedMicroUsd(ambiguous)).toBe(125_000);
    expect(() => settleDirectingAttempt(ambiguous, take.id, "not-dispatched", "missing-journal")).toThrow("ambiguous take cannot release");
    expect(totalDirectingReservedMicroUsd(ambiguous)).toBe(125_000);
    const undispatched = settleDirectingAttempt(reserved, take.id, "not-dispatched", "pre-dispatch-failure");
    expect(totalDirectingReservedMicroUsd(undispatched)).toBe(0);
    expect(() => reserveDirectingAttempt(undispatched, take)).toThrow("cannot be reused");
    expect(totalDirectingReservedMicroUsd(reserveDirectingAttempt(undispatched, reservation(undispatched, "establish", "new")))).toBe(125_000);
  });
  test("an ambiguous request ID cannot be redirected to an unused journal identity", () => {
    const initial = createDirectingState(recipe(), 125_000), take = reservation(initial, "establish");
    const ambiguous = settleDirectingAttempt(reserveDirectingAttempt(initial, take), take.id, "ambiguous", "interrupted");
    const altered = structuredClone(ambiguous);
    altered.attempts[0]!.requestId = `gateway_${hash("unused-journal")}`;
    expect(() => DirectingStateSchema.parse(altered)).toThrow("paid request identity must bind");
    expect(() => settleDirectingAttempt(altered, take.id, "not-dispatched", "missing-journal")).toThrow("paid request identity must bind");
    expect(totalDirectingReservedMicroUsd(ambiguous)).toBe(125_000);
  });
  test("request identity retains its canonical domain and binds every dispatch input", () => {
    const state = createDirectingState(recipe(), 5_000_000), take = reservation(state, "establish");
    const identity = { id: state.id, attemptId: take.id, recipeSha256: take.recipeSha256, shotSha256: take.shotSha256, request: take.request };
    expect(directingRequestId(identity)).toBe(`gateway_${hash({ domain: "atet.directing-request/v1", ...identity })}`);
    expect(directingRequestId({ ...identity, request: { operation: "video", request: Object.fromEntries(Object.entries(take.request.request).reverse()) as typeof take.request.request } })).toBe(take.requestId);
    for (const changed of [
      { ...identity, id: "direct_different" }, { ...identity, attemptId: "take_different" },
      { ...identity, recipeSha256: hash("another-recipe") }, { ...identity, shotSha256: hash("another-shot") },
      { ...identity, request: { operation: "video" as const, request: { ...take.request.request, timeoutMs: 60_000 } } },
    ]) expect(directingRequestId(changed)).not.toBe(take.requestId);
  });
  test("rejected and completed takes remain charged; completed results cannot be replaced or released", () => {
    const state = accepted(createDirectingState(recipe(), 5_000_000), "establish");
    expect(totalDirectingReservedMicroUsd(reviewDirectingAttempt(state, "take_establish", "rejected"))).toBe(125_000);
    expect(() => settleDirectingAttempt(state, "take_establish", "not-dispatched")).toThrow("completed");
    const take = state.attempts[0]!;
    expect(() => completeDirectingAttempt(state, take.id, { ...output(take).result, requestId: `gateway_${hash("different")}` })).toThrow("immutable");
  });
  test("completed output survives endpoint failure and resumes extraction without another paid request", () => {
    const initial = createDirectingState(recipe(), 5_000_000), take = reservation(initial, "establish"), evidence = output(take);
    const completed = completeDirectingAttempt(reserveDirectingAttempt(initial, take), take.id, evidence.result);
    expect(() => reviewDirectingAttempt(completed, take.id, "accepted")).toThrow("endpoint");
    const recovered = attachDirectingEndpoint(completed, take.id, evidence.endpoint);
    expect(reviewDirectingAttempt(recovered, take.id, "accepted").attempts).toHaveLength(1);
    expect(totalDirectingReservedMicroUsd(recovered)).toBe(125_000);
    expect(attachDirectingEndpoint(recovered, take.id, evidence.endpoint)).toEqual(recovered);
    expect(() => attachDirectingEndpoint(recovered, take.id, { ...evidence.endpoint, frameIndex: 117 })).toThrow("immutable");
  });
  test("endpoint timestamps preserve signed native origins and use exact rational rounding", () => {
    const state = createDirectingState(recipe(), 5_000_000), endpoint = output(reservation(state, "establish")).endpoint;
    for (const [value, denominator, expected] of [["-1", 24, -41_667], ["240", 24, 10_000_000], ["-1", 2_000_000, -1], ["1", 2_000_000, 1], ["-1", 3_000_000, 0], ["0", 24, 0]] as const) {
      const pts = { value, timeBaseNumerator: 1, timeBaseDenominator: denominator };
      expect(directingPtsTimeUs(pts)).toBe(expected);
      expect(DirectingEndpointSchema.parse({ ...endpoint, pts, timeUs: expected }).timeUs).toBe(expected);
      expect(() => DirectingEndpointSchema.parse({ ...endpoint, pts, timeUs: expected + 1 })).toThrow("rational PTS");
    }
    expect(DirectingEndpointSchema.safeParse({ ...endpoint, pts: { value: "99999999999999999999", timeBaseNumerator: 1_000_000_000, timeBaseDenominator: 1 }, timeUs: 0 }).success).toBe(false);
  });
  test("reconciles ambiguous completion but never revives a proven undispatched request", () => {
    const initial = createDirectingState(recipe(), 5_000_000), take = reservation(initial, "establish"), { result } = output(take);
    const reserved = reserveDirectingAttempt(initial, take);
    expect(completeDirectingAttempt(settleDirectingAttempt(reserved, take.id, "ambiguous", "timeout"), take.id, result).attempts[0]?.state).toBe("completed");
    expect(() => completeDirectingAttempt(settleDirectingAttempt(reserved, take.id, "not-dispatched"), take.id, result)).toThrow("undispatched");
  });
  test("retained state rejects forged recipe, request, dependency, quote, endpoint, and selection authority", () => {
    const state = acceptedFilm();
    const cases = [
      (value: DirectingState) => { value.recipes[0]!.recipe.title = "changed"; },
      (value: DirectingState) => { value.attempts[0]!.request.request.prompt = "changed"; },
      (value: DirectingState) => { value.attempts[1]!.dependencies[0]!.outputSha256 = hash("changed"); },
      (value: DirectingState) => { value.attempts[0]!.quote.costMicroUsd = 1; },
      (value: DirectingState) => { const attempt = value.attempts[0]!; if (attempt.state === "completed") attempt.endpoint!.source.sha256 = hash("changed"); },
      (value: DirectingState) => { value.selections.establish = "take_orbit"; },
      (value: DirectingState) => { value.attempts[0]!.shotSha256 = hash("changed"); },
      (value: DirectingState) => { value.attempts[1]!.requestId = value.attempts[0]!.requestId; },
    ];
    for (const change of cases) { const altered = structuredClone(state); change(altered); expect(() => DirectingStateSchema.parse(altered)).toThrow(); }
    const missingVideo = structuredClone(state), completed = missingVideo.attempts[0]!;
    if (completed.state !== "completed") throw new Error("Expected completed fixture.");
    completed.result.outputs = [];
    expect(DirectingStateSchema.safeParse(missingVideo).success).toBe(false);
  });
  test("a stale prepared reservation cannot enter a revised recipe", () => {
    const initial = acceptedFilm(), take = reservation(initial, "orbit", "pending"), changed = recipe(); changed.shots[0]!.prompt = "Changed.";
    expect(() => reserveDirectingAttempt(reviseDirectingRecipe(initial, changed), take)).toThrow();
  });
  test("malformed raw provider errors cannot enter retained failure fields", () => {
    const initial = createDirectingState(recipe(), 5_000_000), take = reservation(initial, "establish");
    expect(() => settleDirectingAttempt(reserveDirectingAttempt(initial, take), take.id, "ambiguous", "HTTP 500: key=secret")).toThrow();
  });
});

test("property: editing a chain member invalidates exactly its dependent suffix", () => {
  const initial = acceptedFilm();
  assertProperty(fc.property(fc.integer({ min: 0, max: 2 }), fc.string({ minLength: 1, maxLength: 100 }).filter(value => !/[\u0000-\u001f]/u.test(value) && value.trim().length > 0), (index, prompt) => {
    const changed = recipe(); changed.shots[index]!.prompt = `New direction: ${prompt}`;
    const revised = reviseDirectingRecipe(initial, changed);
    expect(Object.keys(activeDirectingSelections(revised))).toEqual([...recipe().shots.slice(0, index).map(shot => shot.id), "independent"]);
    expect(initial.attempts).toEqual(revised.attempts);
  }));
});

test("property: bounded reservations cannot exceed the approved budget or overflow integer arithmetic", () => {
  assertProperty(fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), fc.integer({ min: 1, max: 16 }), (rate, count) => {
    const budget = rate * 5 * count;
    let state = createDirectingState(recipe(), budget);
    for (let index = 0; index < count; index++) state = reserveDirectingAttempt(state, reservation(state, "establish", `iteration_${index}`, rate));
    expect(totalDirectingReservedMicroUsd(state)).toBe(budget);
    expect(() => reserveDirectingAttempt(state, reservation(state, "establish", "over_budget", rate))).toThrow("budget");
  }), { numRuns: 60 });
  const nearLimit = createDirectingState(recipe(), Number.MAX_SAFE_INTEGER);
  expect(() => reserveDirectingAttempt(nearLimit, reservation(nearLimit, "establish", "overflow", Number.MAX_SAFE_INTEGER))).toThrow();
});

test("property: signed native PTS rounds symmetrically without mixing source and relative clocks", () => {
  assertProperty(fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 1_000_000 }), (value, numerator, denominator) => {
    const positive = directingPtsTimeUs({ value: String(value), timeBaseNumerator: numerator, timeBaseDenominator: denominator });
    const negative = directingPtsTimeUs({ value: String(-value), timeBaseNumerator: numerator, timeBaseDenominator: denominator });
    expect(positive).toBe(Math.round(value * numerator * 1_000_000 / denominator));
    expect(negative === -positive).toBe(true);
  }));
});
