import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  HtmlOverlayDeclaredResourcesSchema,
  createHtmlOverlayRuntimeFrame,
  htmlOverlayFrameCount,
  parseHtmlOverlayRuntimeFrame,
} from "./contracts";
import {
  HTML_OVERLAY_LIBRARY_SPECIFIERS,
  HtmlOverlayLibrarySelectionSchema,
  serializeHtmlOverlayImportMap,
} from "./libraries";
import { createHtmlOverlayRandom, htmlOverlayRandomFor } from "./random";

assertProperty(fc.property(
  fc.shuffledSubarray([...HTML_OVERLAY_LIBRARY_SPECIFIERS]),
  (selection) => {
    const reversed = [...selection].reverse();
    expect(HtmlOverlayLibrarySelectionSchema.parse(selection))
      .toEqual(HtmlOverlayLibrarySelectionSchema.parse(reversed));
    expect(serializeHtmlOverlayImportMap(selection))
      .toBe(serializeHtmlOverlayImportMap(reversed));
  },
));

assertProperty(fc.property(
  fc.uniqueArray(fc.integer({ min: 0, max: 999 }), { maxLength: 32 }),
  (identifiers) => {
    const resources = identifiers.map(identifier => ({
      bytes: identifier,
      mediaType: "application/octet-stream",
      name: `asset-${String(identifier)}`,
      sha256: identifier.toString(16).padStart(64, "0"),
      urlPath: `assets/${String(identifier)}.bin`,
    }));
    expect(HtmlOverlayDeclaredResourcesSchema.parse(resources))
      .toEqual(HtmlOverlayDeclaredResourcesSchema.parse([...resources].reverse()));
  },
));

assertProperty(fc.property(
  fc.integer({ min: 0, max: 0xffff_ffff }),
  fc.string({ maxLength: 128 }).filter(key => key.length > 0),
  (seed, key) => {
    const left = createHtmlOverlayRandom(seed);
    const right = createHtmlOverlayRandom(seed);
    for (let index = 0; index < 16; index += 1) {
      const leftValue = left();
      expect(leftValue).toBe(right());
      expect(leftValue).toBeGreaterThanOrEqual(0);
      expect(leftValue).toBeLessThan(1);
    }
    const keyed = htmlOverlayRandomFor(seed, key);
    expect(keyed).toBe(htmlOverlayRandomFor(seed, key));
    expect(keyed).toBeGreaterThanOrEqual(0);
    expect(keyed).toBeLessThan(1);
  },
));

assertProperty(fc.property(
  fc.integer({ min: 1, max: 10_000_000 }),
  fc.integer({ min: 1, max: 120 }),
  fc.nat(),
  (durationUs, fps, candidate) => {
    const timing = { durationUs, fps };
    const frameCount = htmlOverlayFrameCount(timing);
    const frameIndex = candidate % frameCount;
    const canvas = { deviceScaleFactor: 1, height: 720, width: 1_280 };
    const frame = createHtmlOverlayRuntimeFrame(frameIndex, canvas, timing);
    expect(parseHtmlOverlayRuntimeFrame(frame, canvas, timing)).toEqual(frame);
    expect(Number.isFinite(frame.timeMs)).toBe(true);
    expect(Number.isFinite(frame.progress)).toBe(true);
    expect(frame.progress).toBeGreaterThanOrEqual(0);
    expect(frame.progress).toBeLessThanOrEqual(1);
    if (frameIndex > 0) {
      const previous = createHtmlOverlayRuntimeFrame(frameIndex - 1, canvas, timing);
      expect(frame.timeMs).toBeGreaterThan(previous.timeMs);
      expect(frame.progress).toBeGreaterThanOrEqual(previous.progress);
    }
  },
));
