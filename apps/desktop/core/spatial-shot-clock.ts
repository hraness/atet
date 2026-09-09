import { z } from "zod";

import { deepFreezeJson } from "../../../src/code/json-snapshot";
import { SPATIAL_SCENE_LIMITS, SpatialTimeUsSchema } from "../../../src/spatial-scene/contracts";
import { parseSpatialValue, SpatialSceneError } from "../../../src/spatial-scene/identity";

export const SpatialShotRenderClockSchema = z.strictObject({
  kind: z.literal("shot"), sceneStartUs: SpatialTimeUsSchema,
  playback: z.enum(["once", "loop", "freeze"]),
});
export type SpatialShotRenderClock = Readonly<z.infer<typeof SpatialShotRenderClockSchema>>;
const RequestSchema = z.strictObject({
  clock: SpatialShotRenderClockSchema,
  relativeTimeUs: z.strictObject({ numerator: z.string().regex(/^(?:0|[1-9][0-9]{0,23})$/u), denominator: z.string().regex(/^[1-9][0-9]{0,12}$/u) }),
  sceneDurationUs: SpatialTimeUsSchema.refine(value => value > 0),
});

/** Exact shot-local → scene clock mapping occurs before the sole author-time quantization. */
export function spatialShotSceneTime(input: unknown) {
  const request = parseSpatialValue(RequestSchema, input, "spatial shot clock");
  const d = BigInt(request.relativeTimeUs.denominator), relative = BigInt(request.relativeTimeUs.numerator);
  const end = BigInt(request.sceneDurationUs) * d;
  if (request.clock.sceneStartUs >= request.sceneDurationUs || relative > BigInt(SPATIAL_SCENE_LIMITS.durationUs) * d) throw new SpatialSceneError("invalid-data", "Shot clock start or relative sample exceeds its bounded duration.");
  let n = BigInt(request.clock.sceneStartUs) * d + relative;
  if (request.clock.playback === "loop") n %= end;
  else if (request.clock.playback === "freeze") n = n > end ? end : n;
  else if (n >= end) throw new SpatialSceneError("invalid-data", "Once shot sample lies outside the exact half-open scene duration.");
  let a = n, b = d;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return deepFreezeJson({ exactTimeUs: { numerator: String(n / a), denominator: String(d / a) },
    timeUs: Number((2n * n + d) / (2n * d)) });
}
