import { expect, test } from "bun:test";

import { RecordingEventV1Schema } from "../contracts/recording";
import { planAutomaticZooms } from "./auto-zoom";
import { compileRenderPlan } from "./render-plan";
import { normalizeEditPlan } from "./plan";
import { testManifest, testPlan } from "./test-support";
import { TrackIdSchema } from "../contracts/recording";

const config = {
  enterDurationUs: 200_000,
  exitDurationUs: 200_000,
  intentMergeGapUs: 500_000,
  maxDurationUs: 3_000_000,
  maxScale: 3,
  minDurationUs: 1_000_000,
  postHandleUs: 600_000,
  preHandleUs: 400_000,
  scale: 4,
} as const;

const window = {
  applicationBundleId: "com.example",
  applicationName: "Example",
  bounds: { height: 500, width: 700, x: 100, y: 100 },
  displayId: "display-primary",
  isFocused: true,
  layer: 1,
  title: { state: "available", value: "Example" },
  windowId: "window-1",
} as const;

test("merges a typing burst into one stable rect zoom", () => {
  const snapshot = RecordingEventV1Schema.parse({
    nativeTimeUs: 0,
    sequence: 0,
    sourceTimeUs: 0,
    type: "window.snapshot",
    windows: [window],
  });
  const typing = [1_000_000, 1_200_000, 1_400_000].map((sourceTimeUs, index) => RecordingEventV1Schema.parse({
    input: {
      action: "insert",
      bounds: { height: 30, width: 300, x: 200, y: 300 },
      fieldId: "field-1",
      secure: false,
      text: "x",
      windowId: "window-1",
    },
    nativeTimeUs: sourceTimeUs,
    sequence: index + 1,
    sourceTimeUs,
    type: "typing.input",
  }));
  const zooms = planAutomaticZooms([snapshot, ...typing], 10_000_000, config);
  expect(zooms).toHaveLength(1);
  expect(zooms[0]).toMatchObject({ displayId: "display-primary", reason: "typing", scale: 3, target: { kind: "rect" } });
});

test("compiles an automatic zoom pre-handle before the originating focus sample", () => {
  const snapshot = RecordingEventV1Schema.parse({
    nativeTimeUs: 0,
    sequence: 0,
    sourceTimeUs: 0,
    type: "window.snapshot",
    windows: [window],
  });
  const focus = RecordingEventV1Schema.parse({
    nativeTimeUs: 1_000_000,
    sequence: 1,
    sourceTimeUs: 1_000_000,
    target: {
      bounds: { height: 30, width: 300, x: 200, y: 300 },
      fieldId: "field-1",
      kind: "public-input",
      role: "text-field",
      windowId: "window-1",
    },
    type: "focus.changed",
  });
  const zooms = planAutomaticZooms([snapshot, focus], 10_000_000, config);
  expect(zooms[0]?.range.startUs).toBe(600_000);
  const plan = normalizeEditPlan({ ...testPlan(), zooms });
  expect(() => compileRenderPlan(testManifest(), plan, [snapshot, focus], {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 1080,
    pixelWidth: 1920,
  })).not.toThrow();
});

test("turns a focused window change into a window-framing zoom", () => {
  const focused = RecordingEventV1Schema.parse({
    change: {
      kind: "focused",
      window,
    },
    nativeTimeUs: 1_000_000,
    sequence: 0,
    sourceTimeUs: 1_000_000,
    type: "window.changed",
  });
  const zooms = planAutomaticZooms([focused], 10_000_000, config);
  expect(zooms).toHaveLength(1);
  expect(zooms[0]).toMatchObject({
    displayId: "display-primary",
    reason: "window-change",
    target: {
      kind: "rect",
      rect: {
        height: 532,
        width: 732,
        x: 84,
        y: 84,
      },
    },
  });
});

test("keeps separated clicks as bounded zooms with display ownership", () => {
  const clicks = [1_000_000, 5_000_000].map((sourceTimeUs, index) => RecordingEventV1Schema.parse({
    button: "left",
    clickCount: 1,
    displayId: "display-primary",
    nativeTimeUs: sourceTimeUs,
    phase: "down",
    position: { x: 100, y: 100 },
    sequence: index,
    sourceTimeUs,
    type: "mouse.click",
  }));
  const zooms = planAutomaticZooms(clicks, 10_000_000, config);
  expect(zooms).toHaveLength(2);
  expect(zooms.every(({ displayId, range }) => displayId === "display-primary" && range.endUs - range.startUs <= config.maxDurationUs)).toBe(true);
});

test("merges same-display intents even when another display interleaves", () => {
  const clicks = [
    { displayId: "display-primary", sourceTimeUs: 1_000_000 },
    { displayId: "display-left", sourceTimeUs: 1_100_000 },
    { displayId: "display-primary", sourceTimeUs: 1_200_000 },
  ].map(({ displayId, sourceTimeUs }, index) => RecordingEventV1Schema.parse({
    button: "left",
    clickCount: 1,
    displayId,
    nativeTimeUs: sourceTimeUs,
    phase: "down",
    position: { x: 100, y: 100 },
    sequence: index,
    sourceTimeUs,
    type: "mouse.click",
  }));
  const zooms = planAutomaticZooms(clicks, 10_000_000, config);
  expect(zooms.filter(({ displayId }) => displayId === "display-primary")).toHaveLength(1);
  expect(zooms.filter(({ displayId }) => displayId === "display-left")).toHaveLength(1);
});
