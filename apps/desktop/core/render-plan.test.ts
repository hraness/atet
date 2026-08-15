import { expect, test } from "bun:test";

import type { OverlayOperation } from "../contracts/edit";
import { RecordingEventV1Schema, TrackIdSchema } from "../contracts/recording";
import { compileRenderPlan } from "./render-plan";
import { normalizeEditPlan } from "./plan";
import { testManifest, testPlan } from "./test-support";

test("rejects render outputs beyond bounded pixel geometry", () => {
  expect(() => compileRenderPlan(testManifest(), testPlan(), [], {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 16_384,
    pixelWidth: 16_384,
  })).toThrow(/dimensions/u);
});

test("selects one display composition and retains shared-container stream identity", () => {
  const manifest = testManifest();
  const plan = testPlan();
  const render = compileRenderPlan(manifest, plan, [], {
    audioTrackIds: [TrackIdSchema.parse("track_system001")],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 1080,
    pixelWidth: 1920,
  });
  expect(render.kind).toBe("atet.render-plan");
  expect(render.composition.baseDisplay.displayId).toBe("display-primary");
  expect(render.sourceSegments.map(({ trackId }) => String(trackId))).toEqual([
    "track_display01",
    "track_system001",
  ]);
  expect(new Set(render.sourceSegments.map(({ path }) => path))).toEqual(new Set(["media/segment-1.mp4"]));
  expect(render.sourceSegments.map(({ streamIndex }) => streamIndex)).toEqual([0, 1]);
});

test("keeps one continuous overlay clock across cuts and speed boundaries", () => {
  const overlay: OverlayOperation = {
    anchor: "center",
    coordinateSpace: "output-pixels",
    entrance: { durationUs: 200_000, easing: { kind: "linear" }, kind: "fade" },
    exit: { durationUs: 200_000, easing: { kind: "linear" }, kind: "fade" },
    intrinsicSize: { height: 64, width: 64 },
    opacity: 1,
    overlayId: "overlay_timeline01",
    position: { x: 0, y: 0 },
    range: { endUs: 6_000_000, startUs: 500_000 },
    rotationDegrees: 0,
    scale: 1,
    size: { kind: "intrinsic" },
    source: {
      asset: {
        bytes: 8,
        mediaType: "image/png",
        path: "assets/timeline.png",
        provenance: { kind: "imported", originalName: "timeline.png", sourceSha256: "1".repeat(64) },
        sha256: "1".repeat(64),
      },
      kind: "image",
    },
    zIndex: 0,
  };
  const plan = normalizeEditPlan({
    ...testPlan(),
    keep: [{ endUs: 2_000_000, startUs: 0 }, { endUs: 8_000_000, startUs: 3_000_000 }],
    overlays: [overlay],
    speed: [{ range: { endUs: 5_000_000, startUs: 1_000_000 }, rate: 0.5 }],
  });
  const render = compileRenderPlan(testManifest(), plan, [], {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 1080,
    pixelWidth: 1920,
  });

  expect(render.overlays).toHaveLength(1);
  expect(String(render.overlays[0]?.operation.overlayId)).toBe("overlay_timeline01");
  expect(render.overlays[0]?.output).toEqual({ endUs: 8_000_000, startUs: 500_000 });
});

test("maps negative-X secondary-display cues locally and ignores primary-owned zooms", () => {
  const manifest = testManifest();
  const plan = normalizeEditPlan({
    ...testPlan(),
    effects: {
      ...testPlan().effects,
      clicks: { color: "#ffffff", durationUs: 200_000, enabled: true, radiusPx: 20, style: "ring" },
    },
    zooms: [{
      displayId: "display-primary",
      easing: { kind: "ease-in-out" },
      enterDurationUs: 100_000,
      exitDurationUs: 100_000,
      kind: "manual",
      range: { endUs: 2_000_000, startUs: 1_000_000 },
      scale: 2,
      target: { kind: "point", point: { x: 100, y: 100 } },
      zoomId: "zoom_primary01",
    }],
  });
  const click = RecordingEventV1Schema.parse({
    button: "left",
    clickCount: 1,
    displayId: "display-left",
    nativeTimeUs: 1_000_000,
    phase: "down",
    position: { x: -1200, y: 156 },
    sequence: 1,
    sourceTimeUs: 1_000_000,
    type: "mouse.click",
  });
  const render = compileRenderPlan(manifest, plan, [click], {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display02"),
    frameRate: 60,
    pixelHeight: 1024,
    pixelWidth: 1280,
  });
  expect(render.cameraKeyframes).toEqual([]);
  expect(render.effects.clickCues[0]?.position).toEqual({ x: 80, y: 100 });
  expect(render.sourceSegments.map(({ trackId }) => String(trackId))).toEqual(["track_display02"]);
});

test("maps click, keystroke, and progressive typing cues while skipping another display", () => {
  const manifest = testManifest();
  const plan = normalizeEditPlan({
    ...testPlan(),
    effects: {
      clicks: { color: "#ffffff", durationUs: 200_000, enabled: true, radiusPx: 20, style: "ring" },
      cursor: { enabled: false },
      keystrokes: {
        enabled: true,
        holdUs: 500_000,
        maxKeys: 8,
        position: "bottom-center",
        secureText: "hide",
      },
      typedText: {
        enabled: true,
        idleTimeoutUs: 1_000_000,
        maxCharacters: 100,
        placement: "input",
        secureText: "hide",
      },
    },
  });
  const primaryWindow = {
    applicationBundleId: "com.primary",
    applicationName: "Primary",
    bounds: { height: 400, width: 600, x: 100, y: 100 },
    displayId: "display-primary",
    isFocused: true,
    layer: 1,
    title: { state: "available", value: "Primary" },
    windowId: "window-primary",
  } as const;
  const leftWindow = {
    ...primaryWindow,
    applicationBundleId: "com.left",
    applicationName: "Left",
    bounds: { height: 400, width: 600, x: -1200, y: 100 },
    displayId: "display-left",
    title: { state: "available", value: "Left" },
    windowId: "window-left",
  } as const;
  const inputs = [
    {
      nativeTimeUs: 0,
      sequence: 0,
      sourceTimeUs: 0,
      type: "window.snapshot",
      windows: [primaryWindow, leftWindow],
    },
    {
      button: "left",
      clickCount: 1,
      displayId: "display-primary",
      nativeTimeUs: 1_000_000,
      phase: "down",
      position: { x: 120, y: 140 },
      sequence: 1,
      sourceTimeUs: 1_000_000,
      type: "mouse.click",
    },
    {
      activity: { kind: "printable", modifiers: [], phase: "down", repeat: false, token: "[PRINTABLE]" },
      nativeTimeUs: 1_100_000,
      sequence: 2,
      sourceTimeUs: 1_100_000,
      type: "key.activity",
    },
    {
      input: {
        action: "insert",
        bounds: { height: 30, width: 300, x: 200, y: 300 },
        fieldId: "field-primary",
        secure: false,
        text: "h",
        windowId: "window-primary",
      },
      nativeTimeUs: 1_200_000,
      sequence: 3,
      sourceTimeUs: 1_200_000,
      type: "typing.input",
    },
    {
      input: {
        action: "insert",
        bounds: { height: 30, width: 300, x: 200, y: 300 },
        fieldId: "field-primary",
        secure: false,
        text: "i",
        windowId: "window-primary",
      },
      nativeTimeUs: 1_300_000,
      sequence: 4,
      sourceTimeUs: 1_300_000,
      type: "typing.input",
    },
    {
      nativeTimeUs: 1_500_000,
      sequence: 5,
      sourceTimeUs: 1_500_000,
      target: { kind: "none" },
      type: "focus.changed",
    },
    {
      input: {
        action: "insert",
        bounds: { height: 30, width: 300, x: -1100, y: 300 },
        fieldId: "field-left",
        secure: false,
        text: "x",
        windowId: "window-left",
      },
      nativeTimeUs: 2_000_000,
      sequence: 6,
      sourceTimeUs: 2_000_000,
      type: "typing.input",
    },
  ] as const;
  const events = inputs.map((input) => RecordingEventV1Schema.parse(input));
  const render = compileRenderPlan(manifest, plan, events, {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 1080,
    pixelWidth: 1920,
  });
  expect(render.effects.clickCues).toHaveLength(1);
  expect(render.effects.clickCues[0]?.position).toEqual({ x: 120, y: 140 });
  expect(render.effects.keystrokeCues[0]?.activity).toEqual({ kind: "printable", token: "[PRINTABLE]" });
  expect(render.effects.typingSpans).toHaveLength(1);
  const typingSpan = render.effects.typingSpans[0];
  expect(typingSpan?.secure).toBe(false);
  if (typingSpan?.secure === false) {
    expect(typingSpan.updates.map(({ text }) => text)).toEqual(["h", "hi"]);
    expect(typingSpan.endSourceUs).toBe(1_500_000);
    expect(typingSpan.endOutputUs).toBe(1_500_000);
  }
});

test("rect zooms honor scale and output aspect while clamping at display edges", () => {
  const plan = normalizeEditPlan({
    ...testPlan(),
    zooms: [{
      displayId: "display-primary",
      easing: { kind: "linear" },
      enterDurationUs: 0,
      exitDurationUs: 0,
      kind: "manual",
      range: { endUs: 2_000_000, startUs: 1_000_000 },
      scale: 4,
      target: { kind: "rect", rect: { height: 50, width: 100, x: 1_800, y: 1_000 } },
      zoomId: "zoom_edge0001",
    }],
  });
  const render = compileRenderPlan(testManifest(), plan, [], {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 1080,
    pixelWidth: 1920,
  });
  const keyframe = render.cameraKeyframes[0];
  expect(keyframe?.scale).toBe(4);
  expect(keyframe?.viewport).toEqual({ height: 270, width: 480, x: 1440, y: 810 });
});

test("window and focused-input zoom targets use the same scale-aware viewport geometry", () => {
  const window = {
    applicationBundleId: "com.example",
    applicationName: "Example",
    bounds: { height: 400, width: 600, x: 100, y: 100 },
    displayId: "display-primary",
    isFocused: true,
    layer: 0,
    title: { state: "available", value: "Example" },
    windowId: "window-1",
  } as const;
  const events = [
    RecordingEventV1Schema.parse({
      nativeTimeUs: 0,
      sequence: 0,
      sourceTimeUs: 0,
      type: "window.snapshot",
      windows: [window],
    }),
    RecordingEventV1Schema.parse({
      nativeTimeUs: 0,
      sequence: 1,
      sourceTimeUs: 0,
      target: {
        bounds: { height: 30, width: 300, x: 200, y: 300 },
        fieldId: "field-1",
        kind: "public-input",
        role: "text-field",
        windowId: "window-1",
      },
      type: "focus.changed",
    }),
  ];
  const plan = normalizeEditPlan({
    ...testPlan(),
    zooms: [
      {
        displayId: "display-primary",
        easing: { kind: "linear" },
        enterDurationUs: 0,
        exitDurationUs: 0,
        kind: "manual",
        range: { endUs: 2_000_000, startUs: 1_000_000 },
        scale: 2,
        target: { kind: "window", paddingPx: 10, selector: { kind: "window-id", windowId: "window-1" } },
        zoomId: "zoom_window001",
      },
      {
        displayId: "display-primary",
        easing: { kind: "linear" },
        enterDurationUs: 0,
        exitDurationUs: 0,
        kind: "manual",
        range: { endUs: 3_000_000, startUs: 2_000_000 },
        scale: 3,
        target: { kind: "focused-input", paddingPx: 10 },
        zoomId: "zoom_input0001",
      },
    ],
  });
  const render = compileRenderPlan(testManifest(), plan, events, {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 1080,
    pixelWidth: 1920,
  });
  const firstByZoom = new Map<string, (typeof render.cameraKeyframes)[number]>(
    render.cameraKeyframes.map((keyframe) => [String(keyframe.zoomId), keyframe]),
  );
  expect(firstByZoom.get("zoom_window001")?.scale).toBe(2);
  expect(firstByZoom.get("zoom_input0001")?.scale).toBe(3);
  for (const keyframe of firstByZoom.values()) {
    expect(keyframe.viewport.width / keyframe.viewport.height).toBeCloseTo(16 / 9, 10);
  }
});

test("cursor render samples satisfy the strict render contract", () => {
  const basePlan = testPlan();
  const plan = normalizeEditPlan({
    ...basePlan,
    effects: {
      ...basePlan.effects,
      cursor: {
        enabled: true,
        scale: 1,
        smoothing: { algorithm: "exponential", strength: 0.5 },
        style: "captured",
      },
    },
  });
  const cursor = RecordingEventV1Schema.parse({
    displayId: "display-primary",
    nativeTimeUs: 1_000_100,
    position: { x: 120, y: 140 },
    sequence: 1,
    sourceTimeUs: 1_000_000,
    type: "cursor.sample",
    visible: true,
  });
  const render = compileRenderPlan(testManifest(), plan, [cursor], {
    audioTrackIds: [],
    camera: { kind: "none" },
    displayTrackId: TrackIdSchema.parse("track_display01"),
    frameRate: 60,
    pixelHeight: 1080,
    pixelWidth: 1920,
  });

  expect(render.effects.cursorSamples).toEqual([{
    coordinateSpace: "output-pixels",
    displayId: "display-primary",
    outputTimeUs: 1_000_000,
    position: { x: 120, y: 140 },
    sourceTimeUs: 1_000_000,
    visible: true,
  }]);
  expect("nativeTimeUs" in (render.effects.cursorSamples[0] ?? {})).toBe(false);
});
