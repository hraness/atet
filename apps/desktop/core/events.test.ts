import { describe, expect, test } from "bun:test";

import { RecordingEventV1Schema, type RecordingEventV1 } from "../contracts/recording";
import {
  MAX_CURSOR_INTERPOLATION_GAP_US,
  deriveTypingSpans,
  findCursorAtTime,
  findFocusedInputAtTime,
  queryEventJsonl,
  smoothAndDownsampleCursor,
} from "./events";

const bounds = { height: 30, width: 200, x: 10, y: 20 };

function typing(sequence: number, sourceTimeUs: number, text: string, action = "insert"): RecordingEventV1 {
  return RecordingEventV1Schema.parse({
    input: { action, bounds, fieldId: "field-1", secure: false, text, windowId: "window-1" },
    nativeTimeUs: sourceTimeUs + 100,
    sequence,
    sourceTimeUs,
    type: "typing.input",
  });
}

describe("event streams", () => {
  test("queries bounded JSONL and rejects non-monotonic append order", () => {
    const events = [typing(1, 100, "h"), typing(2, 200, "i")];
    const jsonl = events.map((event) => JSON.stringify(event)).join("\n");
    expect(queryEventJsonl(jsonl, { startUs: 150, limit: 10 })).toEqual(events.slice(1));
    expect(() => queryEventJsonl(jsonl, { maxBytes: 1 })).toThrow(/maxBytes/u);
    expect(() => queryEventJsonl([...events].reverse().map((event) => JSON.stringify(event)).join("\n"))).toThrow(/sequence/u);
  });

  test("derives progressive text updates and expires after idle", () => {
    const spans = deriveTypingSpans([
      typing(1, 100, "h"),
      typing(2, 200, "i"),
      typing(3, 300, "", "delete-backward"),
    ], 1_000);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.updates.map(({ text }) => text)).toEqual(["h", "hi", "h"]);
    expect(spans[0]?.endUs).toBe(1_300);
  });

  test("ends a typed callout at explicit focus, window, and lifecycle boundaries", () => {
    const boundaries = [
      RecordingEventV1Schema.parse({
        nativeTimeUs: 200,
        sequence: 2,
        sourceTimeUs: 200,
        target: { kind: "none" },
        type: "focus.changed",
      }),
      RecordingEventV1Schema.parse({
        change: { kind: "destroyed", windowId: "window-1" },
        nativeTimeUs: 200,
        sequence: 2,
        sourceTimeUs: 200,
        type: "window.changed",
      }),
      RecordingEventV1Schema.parse({
        marker: "segment-closed",
        nativeTimeUs: 200,
        segmentId: "segment_example01",
        sequence: 2,
        sourceTimeUs: 200,
        type: "lifecycle.marker",
      }),
    ];
    for (const boundary of boundaries) {
      const spans = deriveTypingSpans([
        typing(1, 100, "h"),
        boundary,
      ], 1_000);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.endUs).toBe(200);
    }
  });

  test("keeps a callout on compatible focus and hides it on forward-delete", () => {
    const compatibleFocus = RecordingEventV1Schema.parse({
      nativeTimeUs: 150,
      sequence: 2,
      sourceTimeUs: 150,
      target: {
        bounds,
        fieldId: "field-1",
        kind: "public-input",
        role: "text-field",
        windowId: "window-1",
      },
      type: "focus.changed",
    });
    const spans = deriveTypingSpans([
      typing(1, 100, "a"),
      compatibleFocus,
      typing(3, 200, "b"),
      typing(4, 300, "", "delete-forward"),
      typing(5, 400, "c"),
    ], 1_000);
    expect(spans.map(({ endUs, updates }) => ({
      endUs,
      text: updates.map(update => update.text),
    }))).toEqual([
      { endUs: 300, text: ["a", "ab"] },
      { endUs: 1_400, text: ["c"] },
    ]);
  });

  test("cursor smoothing downsamples stationary samples but preserves the last sample", () => {
    const events = [0, 10, 20].map((sourceTimeUs, index) => RecordingEventV1Schema.parse({
      displayId: "display-primary",
      nativeTimeUs: sourceTimeUs,
      position: { x: index, y: index },
      sequence: index,
      sourceTimeUs,
      type: "cursor.sample",
      visible: true,
    }));
    const samples = smoothAndDownsampleCursor(events, { minDistancePx: 100, minIntervalUs: 100, strength: 0 });
    expect(samples.map(({ sourceTimeUs }) => sourceTimeUs)).toEqual([0, 20]);
  });

  test("maximum cursor smoothing remains responsive", () => {
    const events = [0, 100].map((x, index) => RecordingEventV1Schema.parse({
      displayId: "display-primary",
      nativeTimeUs: index,
      position: { x, y: 0 },
      sequence: index,
      sourceTimeUs: index,
      type: "cursor.sample",
      visible: true,
    }));
    const samples = smoothAndDownsampleCursor(events, { minDistancePx: 0, minIntervalUs: 1, strength: 1 });
    expect(samples[1]?.position.x).toBeGreaterThan(0);
    expect(samples[1]?.position.x).toBeLessThan(100);
  });

  test("cursor sampling distinguishes nearest from bounded interpolation", () => {
    const events = [
      { sequence: 0, sourceTimeUs: 0, x: 0 },
      { sequence: 1, sourceTimeUs: 100_000, x: 100 },
    ].map(({ sequence, sourceTimeUs, x }) => RecordingEventV1Schema.parse({
      displayId: "display-primary",
      nativeTimeUs: sourceTimeUs,
      position: { x, y: 0 },
      sequence,
      sourceTimeUs,
      type: "cursor.sample",
      visible: true,
    }));
    expect(findCursorAtTime(events, 50_000, "nearest")?.position.x).toBe(0);
    expect(findCursorAtTime(events, 50_000, "interpolated")?.position.x).toBe(50);

    const distant = events.map((event, index) => index === 1
      ? RecordingEventV1Schema.parse({
          ...event,
          nativeTimeUs: MAX_CURSOR_INTERPOLATION_GAP_US + 1,
          sourceTimeUs: MAX_CURSOR_INTERPOLATION_GAP_US + 1,
        })
      : event);
    expect(findCursorAtTime(distant, 1, "interpolated")?.position.x).toBe(0);
  });

  test("an explicit focus-none marker never revives stale typing", () => {
    const input = typing(0, 10, "a");
    const blur = RecordingEventV1Schema.parse({
      nativeTimeUs: 20,
      sequence: 1,
      sourceTimeUs: 20,
      target: { kind: "none" },
      type: "focus.changed",
    });
    expect(findFocusedInputAtTime([input, blur], 30)).toBeNull();
  });
});
