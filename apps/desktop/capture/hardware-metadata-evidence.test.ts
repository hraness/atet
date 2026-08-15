import { describe, expect, test } from "bun:test";

import {
  RecordingEventV1Schema,
  type RecordingEventV1,
} from "../contracts/recording";
import {
  HardwareMetadataEvidenceError,
  type HardwareMetadataEvidenceExpectation,
  verifyHardwareMetadataEvidence,
} from "./hardware-metadata-evidence";
import {
  INTERACTION_FIXTURE_PROTOCOL_VERSION,
  interactionFixturePublicFieldId,
  interactionFixtureWindowTitle,
  parseInteractionFixtureReceipt,
} from "./interaction-fixture";

const display = {
  bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
  displayId: "display-1",
  isPrimary: true,
  label: "Primary display",
  pixelSize: { height: 1_080, width: 1_920 },
  refreshRateHz: 60,
  scaleFactor: 1,
} as const;

const window = {
  applicationBundleId: "com.example.fixture",
  applicationName: "Metadata Fixture",
  bounds: { height: 600, width: 800, x: 100, y: 100 },
  displayId: display.displayId,
  isFocused: false,
  layer: 0,
  title: { state: "available", value: "Metadata Fixture" },
  windowId: "window-1",
} as const;

const fixtureId = "01234567-89ab-4cde-8fab-0123456789ab";
const fixturePublicFieldId = interactionFixturePublicFieldId(fixtureId);
const fixtureWindow = {
  applicationBundleId: "com.hraness.atet.capture",
  applicationName: "Atet Capture",
  bounds: { height: 300, width: 520, x: 80, y: 80 },
  displayId: display.displayId,
  isFocused: true,
  layer: 0,
  title: {
    state: "available",
    value: interactionFixtureWindowTitle(fixtureId),
  },
  windowId: "42",
} as const;
const publicBounds = {
  height: 30,
  width: 240,
  x: 140,
  y: 140,
} as const;
const secureBounds = {
  height: 30,
  width: 240,
  x: 140,
  y: 200,
} as const;

const segmentCoverage = [
  {
    firstRetainedSampleNativeTimeUs: 10_010,
    lastRetainedSampleNativeTimeUs: 10_018,
    segmentId: "segment_00000001",
  },
  {
    firstRetainedSampleNativeTimeUs: 10_032,
    lastRetainedSampleNativeTimeUs: 10_038,
    segmentId: "segment_00000002",
  },
] as const satisfies NonNullable<
  HardwareMetadataEvidenceExpectation["segmentCoverage"]
>;

type FixtureBounds = Readonly<{
  height: number;
  width: number;
  x: number;
  y: number;
}>;

function fixturePhase(
  focusConfirmedNativeTimeUs: number,
  inputStartedNativeTimeUs: number,
  completedNativeTimeUs: number,
  bounds: FixtureBounds,
) {
  return {
    attemptedKeyPairs: 1,
    bounds,
    clickPoint: {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    },
    completedNativeTimeUs,
    focusConfirmedNativeTimeUs,
    inputStartedNativeTimeUs,
    valueMatches: true,
  } as const;
}

function fixtureReceipt() {
  return parseInteractionFixtureReceipt({
    completedNativeTimeUs: 10_019,
    event: "completed",
    fixtureId,
    fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
    neutralFocusConfirmedNativeTimeUs: 10_018,
    publicAfter: fixturePhase(10_014, 10_015, 10_017, publicBounds),
    publicBefore: fixturePhase(10_006, 10_007, 10_009, publicBounds),
    publicFocusIdentity: {
      fieldId: fixturePublicFieldId,
      processId: 42,
      windowId: fixtureWindow.windowId,
      windowTitle: interactionFixtureWindowTitle(fixtureId),
    },
    requestId: "exercise",
    secure: fixturePhase(10_010, 10_011, 10_013, secureBounds),
  });
}

function ownedFixtureEvents(
  typedText: boolean,
): readonly RecordingEventV1[] {
  const event = (
    nativeTimeUs: number,
    sequence: number,
    value: Readonly<Record<string, unknown>>,
  ) => ({
    nativeTimeUs,
    sequence,
    sourceTimeUs: nativeTimeUs - 10_000,
    ...value,
  });
  const key = (
    nativeTimeUs: number,
    phase: "down" | "up",
    sequence: number,
  ) => event(nativeTimeUs, sequence, {
    activity: {
      kind: "printable",
      modifiers: [],
      phase,
      repeat: false,
      token: "[PRINTABLE]",
    },
    type: "key.activity",
  });
  const click = (
    nativeTimeUs: number,
    phase: "down" | "up",
    sequence: number,
    bounds: FixtureBounds,
  ) => event(nativeTimeUs, sequence, {
    button: "left",
    clickCount: 1,
    displayId: display.displayId,
    phase,
    position: {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    },
    type: "mouse.click",
  });
  const typing = (
    nativeTimeUs: number,
    sequence: number,
    text: "a" | "b",
  ) => event(nativeTimeUs, sequence, {
    input: {
      action: "insert",
      bounds: publicBounds,
      fieldId: fixturePublicFieldId,
      secure: false,
      text,
      windowId: fixtureWindow.windowId,
    },
    type: "typing.input",
  });

  return RecordingEventV1Schema.array().parse([
    ...hardwareEvents(),
    event(10_005, 100, {
      change: { kind: "focused", window: fixtureWindow },
      type: "window.changed",
    }),
    event(10_006, 101, {
      target: {
        bounds: publicBounds,
        fieldId: fixturePublicFieldId,
        kind: "public-input",
        processId: 42,
        role: "AXTextField",
        windowId: fixtureWindow.windowId,
      },
      type: "focus.changed",
    }),
    click(10_007, "down", 102, publicBounds),
    click(10_008, "up", 103, publicBounds),
    key(10_008, "down", 104),
    ...(typedText ? [typing(10_008, 105, "a")] : []),
    key(10_009, "up", 106),
    event(10_010, 107, {
      target: {
        bounds: secureBounds,
        fieldId: "[REDACTED]",
        kind: "secure-input",
        processId: 42,
        redacted: true,
        role: "secure-text-field",
        windowId: fixtureWindow.windowId,
      },
      type: "focus.changed",
    }),
    click(10_011, "down", 108, secureBounds),
    click(10_012, "up", 109, secureBounds),
    event(10_014, 110, {
      target: {
        bounds: publicBounds,
        fieldId: fixturePublicFieldId,
        kind: "public-input",
        processId: 42,
        role: "AXTextField",
        windowId: fixtureWindow.windowId,
      },
      type: "focus.changed",
    }),
    click(10_015, "down", 111, publicBounds),
    click(10_016, "up", 112, publicBounds),
    key(10_016, "down", 113),
    ...(typedText ? [typing(10_016, 114, "b")] : []),
    key(10_017, "up", 115),
    event(10_018, 116, {
      target: { kind: "none" },
      type: "focus.changed",
    }),
  ]);
}

function hardwareEvents(): readonly RecordingEventV1[] {
  let sequence = 0;
  const event = <Value extends Readonly<Record<string, unknown>>>(
    sourceTimeUs: number,
    value: Value,
  ) => ({
    nativeTimeUs: 10_000 + sourceTimeUs,
    sequence: sequence++,
    sourceTimeUs,
    ...value,
  });
  return RecordingEventV1Schema.array().parse([
    event(0, {
      marker: "segment-opened",
      segmentId: "segment_00000001",
      type: "lifecycle.marker",
    }),
    event(1, {
      marker: "recording-started",
      segmentId: "segment_00000001",
      type: "lifecycle.marker",
    }),
    event(2, {
      displays: [display],
      type: "display.topology",
    }),
    event(3, {
      target: { kind: "none" },
      type: "focus.changed",
    }),
    event(4, {
      type: "window.snapshot",
      windows: [window],
    }),
    event(5, {
      displayId: display.displayId,
      position: { x: 200, y: 250 },
      type: "cursor.sample",
      visible: true,
    }),
    event(19, {
      displayId: display.displayId,
      position: { x: 205, y: 255 },
      type: "cursor.sample",
      visible: true,
    }),
    event(20, {
      marker: "pause-requested",
      segmentId: "segment_00000001",
      type: "lifecycle.marker",
    }),
    event(21, {
      marker: "segment-closed",
      segmentId: "segment_00000001",
      type: "lifecycle.marker",
    }),
    event(22, {
      marker: "paused",
      segmentId: "segment_00000001",
      type: "lifecycle.marker",
    }),
    event(22, {
      marker: "segment-opened",
      segmentId: "segment_00000002",
      type: "lifecycle.marker",
    }),
    event(23, {
      marker: "resumed",
      segmentId: "segment_00000002",
      type: "lifecycle.marker",
    }),
    event(24, {
      displays: [display],
      type: "display.topology",
    }),
    event(25, {
      target: { kind: "none" },
      type: "focus.changed",
    }),
    event(26, {
      type: "window.snapshot",
      windows: [window],
    }),
    event(27, {
      displayId: display.displayId,
      position: { x: 210, y: 260 },
      type: "cursor.sample",
      visible: true,
    }),
    event(39, {
      displayId: display.displayId,
      position: { x: 215, y: 265 },
      type: "cursor.sample",
      visible: true,
    }),
    event(40, {
      marker: "stop-requested",
      segmentId: "segment_00000002",
      type: "lifecycle.marker",
    }),
    event(41, {
      marker: "segment-closed",
      segmentId: "segment_00000002",
      type: "lifecycle.marker",
    }),
    event(42, {
      marker: "stopped",
      segmentId: "segment_00000002",
      type: "lifecycle.marker",
    }),
  ]);
}

function evidenceError(
  events: readonly RecordingEventV1[],
  options: {
    readonly interaction?:
      HardwareMetadataEvidenceExpectation["interaction"];
    readonly segmentCoverage?:
      HardwareMetadataEvidenceExpectation["segmentCoverage"];
    readonly typedText?:
      HardwareMetadataEvidenceExpectation["typedText"];
  } = {},
): HardwareMetadataEvidenceError {
  try {
    verifyHardwareMetadataEvidence(events, {
      expectedDisplayIds: [display.displayId],
      interaction: options.interaction ?? { kind: "none" },
      ...(options.segmentCoverage === undefined
        ? {}
        : { segmentCoverage: options.segmentCoverage }),
      typedText: options.typedText ?? { kind: "disabled" },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(HardwareMetadataEvidenceError);
    return error as HardwareMetadataEvidenceError;
  }
  throw new Error("Expected hardware metadata evidence verification to fail.");
}

describe("hardware metadata evidence", () => {
  test("requires parsed baseline metadata and the exact pause/resume lifecycle", () => {
    const evidence = verifyHardwareMetadataEvidence(hardwareEvents(), {
      expectedDisplayIds: [display.displayId],
      interaction: { kind: "none" },
      segmentCoverage,
      typedText: { kind: "disabled" },
    });
    expect(evidence).toMatchObject({
      coveredSegmentCount: 2,
      expectedDisplayIds: [display.displayId],
      interactionKind: "none",
      observedWindowCount: 1,
      secureFocusIntervalsVerified: 0,
      totalEvents: 20,
    });
    expect(evidence.counts).toMatchObject({
      "cursor.sample": 4,
      "display.topology": 2,
      "focus.changed": 2,
      "typing.input": 0,
      "window.snapshot": 2,
    });
  });

  test("requires opening snapshots and a closing cursor sample around retained media", () => {
    expect(evidenceError(
      hardwareEvents().filter(event => !(
        event.type === "window.snapshot"
        && event.nativeTimeUs === 10_004
      )),
      { segmentCoverage },
    ).code).toBe("metadata-coverage");
    expect(evidenceError(
      hardwareEvents().filter(event => !(
        event.type === "cursor.sample"
        && event.nativeTimeUs === 10_039
      )),
      { segmentCoverage },
    ).code).toBe("metadata-coverage");
  });

  test("rejects a native event-tap diagnostic even when completion counters are clean", () => {
    const events = [
      ...hardwareEvents(),
      RecordingEventV1Schema.parse({
        category: "keyboard",
        droppedCount: 1,
        firstDroppedNativeTimeUs: 10_010,
        lastDroppedNativeTimeUs: 10_010,
        nativeTimeUs: 10_010,
        reason: "listen-only event tap unavailable",
        sequence: 100,
        sourceTimeUs: 10,
        type: "diagnostic.dropped-events",
      }),
    ];
    expect(evidenceError(events).code).toBe("diagnostic-event");
  });

  test("requires a matching display topology and a positioned captured window", () => {
    expect(evidenceError(hardwareEvents().filter(event => (
      event.type !== "display.topology"
    ))).code).toBe("metadata-baseline");
    expect(evidenceError(hardwareEvents().map(event => (
      event.type === "window.snapshot"
        ? { ...event, windows: [] }
        : event
    ))).code).toBe("window-evidence");
  });

  test("proves typed-text opt-out and rejects key cadence inside secure focus", () => {
    const typed = RecordingEventV1Schema.parse({
      input: {
        action: "insert",
        bounds: { height: 30, width: 240, x: 120, y: 140 },
        fieldId: "public-input",
        secure: false,
        text: "a",
        windowId: window.windowId,
      },
      nativeTimeUs: 10_030,
      sequence: 100,
      sourceTimeUs: 30,
      type: "typing.input",
    });
    expect(evidenceError([...hardwareEvents(), typed]).code)
      .toBe("privacy-evidence");

    const secureFocus = RecordingEventV1Schema.parse({
      nativeTimeUs: 10_028,
      sequence: 98,
      sourceTimeUs: 28,
      target: {
        bounds: { height: 30, width: 240, x: 120, y: 180 },
        fieldId: "[REDACTED]",
        kind: "secure-input",
        redacted: true,
        role: "secure-text-field",
        windowId: window.windowId,
      },
      type: "focus.changed",
    });
    const key = RecordingEventV1Schema.parse({
      activity: {
        kind: "printable",
        modifiers: [],
        phase: "down",
        repeat: false,
        token: "[PRINTABLE]",
      },
      nativeTimeUs: 10_029,
      sequence: 99,
      sourceTimeUs: 29,
      type: "key.activity",
    });
    expect(evidenceError([
      ...hardwareEvents(),
      secureFocus,
      key,
    ]).code).toBe("privacy-evidence");
  });

  test("optionally requires complete click, key, input-focus, and window-focus evidence", () => {
    expect(evidenceError(hardwareEvents(), {
      interaction: { kind: "operator" },
    }).code).toBe("interaction-evidence");
    const interactions = RecordingEventV1Schema.array().parse([
      {
        change: {
          kind: "focused",
          window: { ...window, isFocused: true },
        },
        nativeTimeUs: 10_028,
        sequence: 100,
        sourceTimeUs: 28,
        type: "window.changed",
      },
      {
        nativeTimeUs: 10_029,
        sequence: 101,
        sourceTimeUs: 29,
        target: {
          bounds: { height: 30, width: 240, x: 120, y: 140 },
          fieldId: "public-input",
          kind: "public-input",
          role: "AXTextField",
          windowId: window.windowId,
        },
        type: "focus.changed",
      },
      ...(["down", "up"] as const).map((phase, index) => ({
        button: "left",
        clickCount: 1,
        displayId: display.displayId,
        nativeTimeUs: 10_030 + index,
        phase,
        position: { x: 150, y: 150 },
        sequence: 102 + index,
        sourceTimeUs: 30 + index,
        type: "mouse.click" as const,
      })),
      ...(["down", "up"] as const).map((phase, index) => ({
        activity: {
          kind: "printable" as const,
          modifiers: [],
          phase,
          repeat: false,
          token: "[PRINTABLE]" as const,
        },
        nativeTimeUs: 10_032 + index,
        sequence: 104 + index,
        sourceTimeUs: 32 + index,
        type: "key.activity" as const,
      })),
    ]);
    const evidence = verifyHardwareMetadataEvidence([
      ...hardwareEvents(),
      ...interactions,
    ], {
      expectedDisplayIds: [display.displayId],
      interaction: { kind: "operator" },
      typedText: { kind: "disabled" },
    });
    expect(evidence.counts).toMatchObject({
      "key.activity": 2,
      "mouse.click": 2,
      "window.changed": 1,
    });
  });

  test("binds exact public-secure-public suppression to the owned fixture receipt", () => {
    const receipt = fixtureReceipt();
    const evidence = verifyHardwareMetadataEvidence(
      ownedFixtureEvents(false),
      {
        expectedDisplayIds: [display.displayId],
        interaction: { kind: "owned-fixture", receipt },
        typedText: { kind: "disabled" },
      },
    );
    expect(evidence).toMatchObject({
      interactionKind: "owned-fixture",
      secureFocusIntervalsVerified: 1,
    });
    expect(evidence.counts).toMatchObject({
      "key.activity": 4,
      "mouse.click": 6,
      "typing.input": 0,
      "window.changed": 1,
    });
  });

  test("proves public typed-text canaries without admitting secure metadata", () => {
    const receipt = fixtureReceipt();
    const evidence = verifyHardwareMetadataEvidence(
      ownedFixtureEvents(true),
      {
        expectedDisplayIds: [display.displayId],
        interaction: { kind: "owned-fixture", receipt },
        typedText: { kind: "owned-fixture" },
      },
    );
    expect(evidence.counts["typing.input"]).toBe(2);
    expect(evidence.secureFocusIntervalsVerified).toBe(1);
  });

  test("does not count another process's secure focus as PID-scoped evidence", () => {
    const receipt = fixtureReceipt();
    const externalSecure = RecordingEventV1Schema.parse({
      nativeTimeUs: 10_020,
      sequence: 200,
      sourceTimeUs: 20,
      target: {
        bounds: secureBounds,
        fieldId: "[REDACTED]",
        kind: "secure-input",
        processId: 99,
        redacted: true,
        role: "secure-text-field",
        windowId: "external-window",
      },
      type: "focus.changed",
    });
    const externalBlur = RecordingEventV1Schema.parse({
      nativeTimeUs: 10_021,
      sequence: 201,
      sourceTimeUs: 21,
      target: { kind: "none" },
      type: "focus.changed",
    });
    const evidence = verifyHardwareMetadataEvidence(
      [...ownedFixtureEvents(false), externalSecure, externalBlur],
      {
        expectedDisplayIds: [display.displayId],
        interaction: { kind: "owned-fixture", receipt },
        typedText: { kind: "disabled" },
      },
    );

    expect(evidence.secureFocusIntervalsVerified).toBe(1);
  });

  test("rejects fixture identity drift, missing liveness flanks, and secure key leakage", () => {
    const receipt = fixtureReceipt();
    const expectation = {
      expectedDisplayIds: [display.displayId],
      interaction: { kind: "owned-fixture", receipt },
      typedText: { kind: "disabled" },
    } as const satisfies HardwareMetadataEvidenceExpectation;
    expect(evidenceError(
      ownedFixtureEvents(false).filter(event => !(
        event.type === "window.changed"
        && event.change.kind === "focused"
        && event.change.window.windowId
          === receipt.publicFocusIdentity.windowId
      )),
      expectation,
    ).code).toBe("interaction-evidence");
    const wrongProcess = RecordingEventV1Schema.array().parse(
      ownedFixtureEvents(false).map(event => (
        event.type === "focus.changed"
          && event.target.kind !== "none"
          ? {
            ...event,
            target: { ...event.target, processId: 99 },
          }
          : event
      )),
    );
    expect(evidenceError(wrongProcess, expectation).code)
      .toBe("interaction-evidence");
    expect(evidenceError(
      ownedFixtureEvents(false).filter(event => !(
        event.type === "key.activity"
        && event.nativeTimeUs === receipt.publicAfter.completedNativeTimeUs
      )),
      expectation,
    ).code).toBe("interaction-evidence");
    const secureKey = RecordingEventV1Schema.parse({
      activity: {
        kind: "printable",
        modifiers: [],
        phase: "down",
        repeat: false,
        token: "[PRINTABLE]",
      },
      nativeTimeUs: receipt.secure.inputStartedNativeTimeUs,
      sequence: 999,
      sourceTimeUs: receipt.secure.inputStartedNativeTimeUs - 10_000,
      type: "key.activity",
    });
    expect(evidenceError(
      [...ownedFixtureEvents(false), secureKey],
      expectation,
    ).code).toBe("privacy-evidence");
    const reordered = RecordingEventV1Schema.array().parse(
      ownedFixtureEvents(false).map(event => (
        event.type === "key.activity"
          && event.nativeTimeUs === receipt.publicBefore.inputStartedNativeTimeUs + 1
          && event.activity.phase === "down"
          ? {
            ...event,
            nativeTimeUs: receipt.publicBefore.inputStartedNativeTimeUs,
            sequence: 1,
            sourceTimeUs:
              receipt.publicBefore.inputStartedNativeTimeUs - 10_000,
          }
          : event
      )),
    );
    expect(evidenceError(reordered, expectation).code)
      .toBe("interaction-evidence");
    const wrongClick = RecordingEventV1Schema.array().parse(
      ownedFixtureEvents(false).map(event => (
        event.type === "mouse.click"
          && event.nativeTimeUs === receipt.publicBefore.inputStartedNativeTimeUs
          ? { ...event, clickCount: 2, displayId: "other-display" }
          : event
      )),
    );
    expect(evidenceError(wrongClick, expectation).code)
      .toBe("interaction-evidence");
  });

  test("requires the fixture whenever owned typed-text evidence is requested", () => {
    expect(evidenceError(hardwareEvents(), {
      typedText: { kind: "owned-fixture" },
    }).code).toBe("privacy-evidence");
  });
});
