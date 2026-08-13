import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { formatTimeLiteral, parseTimeLiteral } from "./time";

describe("time literals", () => {
  test("parses unit suffixes without prefix ambiguity", () => {
    expect(parseTimeLiteral("250ms")).toBe(250_000);
    expect(parseTimeLiteral("1m2.5s")).toBe(62_500_000);
  });

  assertProperty(fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (timeUs) => {
    expect(parseTimeLiteral(formatTimeLiteral(timeUs))).toBe(timeUs);
  }));

  assertProperty(fc.property(fc.string(), (suffix) => {
    expect(() => parseTimeLiteral(`-${suffix}`)).toThrow();
  }));
});
