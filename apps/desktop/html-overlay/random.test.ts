import { expect, test } from "bun:test";

import { createHtmlOverlayRandom, htmlOverlayRandomFor } from "./random";

test("HTML overlay random v1 retains its golden sequence and keyed value", () => {
  const random = createHtmlOverlayRandom(42);
  expect([random(), random(), random(), random()]).toEqual([
    0.6406357134692371,
    0.10388222453184426,
    0.6597210348118097,
    0.709011324448511,
  ]);
  expect(htmlOverlayRandomFor(42, "particle:7")).toBe(0.43256441270932555);
});
