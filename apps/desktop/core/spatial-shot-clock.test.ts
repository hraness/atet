import { expect, test } from "bun:test";
import { spatialShotSceneTime } from "./spatial-shot-clock";

const at = (n: string, d: string, playback: "once" | "loop" | "freeze", start = 0, duration = 1_000_000) => spatialShotSceneTime({
  clock: { kind: "shot", sceneStartUs: start, playback }, relativeTimeUs: { numerator: n, denominator: d }, sceneDurationUs: duration,
});
test("shot loop and freeze map exact rational boundaries before rounding", () => {
  expect(at("9999996", "10", "loop")).toEqual({ timeUs: 1_000_000, exactTimeUs: { numerator: "4999998", denominator: "5" } });
  expect(at("10000000", "10", "loop")).toEqual({ timeUs: 0, exactTimeUs: { numerator: "0", denominator: "1" } });
  expect(at("1000000", "3", "loop", 0, 333333)).toEqual({ timeUs: 0, exactTimeUs: { numerator: "1", denominator: "3" } });
  expect(at("2500000", "1", "freeze", 125000)).toEqual({ timeUs: 1_000_000, exactTimeUs: { numerator: "1000000", denominator: "1" } });
  expect(at("1000000", "1", "freeze")).toEqual({ timeUs: 1_000_000, exactTimeUs: { numerator: "1000000", denominator: "1" } });
  expect(() => at("1000000", "1", "once")).toThrow("half-open");
  expect(at("9999996", "10", "once").timeUs).toBe(1_000_000);
});
test("exact shot mappings are independent of forward, reverse or repeated request order", () => {
  const times = Array.from({ length: 120 }, (_, index) => String(index * 1_001_000));
  for (const playback of ["loop", "freeze"] as const) {
    const forward = times.map(time => at(time, "30", playback, 150_000));
    expect([...times].reverse().map(time => at(time, "30", playback, 150_000)).reverse()).toEqual(forward);
    for (let index = 0; index < times.length; index++) {
      const raw = 150_000n * 30n + BigInt(times[index]!);
      const expected = playback === "loop" ? raw % 30_000_000n : raw > 30_000_000n ? 30_000_000n : raw;
      const sample = forward[index]!;
      expect(BigInt(sample.exactTimeUs.numerator) * 30n).toBe(expected * BigInt(sample.exactTimeUs.denominator));
      expect(sample.timeUs).toBe(Number((2n * expected + 30n) / 60n));
    }
  }
});
test("shot clock rejects unbounded, malformed or effectful requests", () => {
  expect(() => at("1", "0", "loop")).toThrow();
  expect(() => at("1", "1", "loop", 1_000_000)).toThrow("start");
  expect(() => at("3600000001", "1", "loop")).toThrow("bounded");
  let reads = 0;
  expect(() => spatialShotSceneTime({ get clock() { reads++; return {}; } })).toThrow();
  expect(reads).toBe(0);
});
