import type { RecordingEventV1 } from "../contracts/recording";
import {
  interactionFixturePublicFieldId,
  interactionFixtureWindowTitle,
  type InteractionFixtureReceipt,
} from "./interaction-fixture";

const EVENT_KINDS = [
  "cursor.sample",
  "mouse.click",
  "key.activity",
  "typing.input",
  "focus.changed",
  "window.snapshot",
  "window.changed",
  "display.topology",
  "lifecycle.marker",
  "diagnostic.dropped-events",
] as const satisfies readonly RecordingEventV1["type"][];

const REQUIRED_BASELINE_KINDS = [
  "cursor.sample",
  "focus.changed",
  "window.snapshot",
  "display.topology",
  "lifecycle.marker",
] as const satisfies readonly RecordingEventV1["type"][];

const PAUSE_RESUME_LIFECYCLE = [
  {
    markers: [
      "segment-opened",
      "recording-started",
      "pause-requested",
      "segment-closed",
      "paused",
    ],
    segmentId: "segment_00000001",
  },
  {
    markers: [
      "segment-opened",
      "resumed",
      "stop-requested",
      "segment-closed",
      "stopped",
    ],
    segmentId: "segment_00000002",
  },
] as const;

export type HardwareMetadataEvidenceErrorCode =
  | "diagnostic-event"
  | "display-topology"
  | "interaction-evidence"
  | "lifecycle-evidence"
  | "metadata-baseline"
  | "metadata-coverage"
  | "privacy-evidence"
  | "window-evidence";

export class HardwareMetadataEvidenceError extends Error {
  readonly code: HardwareMetadataEvidenceErrorCode;

  constructor(
    code: HardwareMetadataEvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HardwareMetadataEvidenceError";
    this.code = code;
  }
}

export interface HardwareMetadataEvidenceExpectation {
  readonly expectedDisplayIds: readonly string[];
  readonly interaction:
    | { readonly kind: "none" }
    | { readonly kind: "operator" }
    | {
      readonly kind: "owned-fixture";
      readonly receipt: InteractionFixtureReceipt;
    };
  readonly typedText:
    | { readonly kind: "disabled" }
    | { readonly kind: "owned-fixture" };
  readonly segmentCoverage?: readonly {
    readonly firstRetainedSampleNativeTimeUs: number;
    readonly lastRetainedSampleNativeTimeUs: number;
    readonly segmentId: string;
  }[];
}

export interface HardwareMetadataEvidenceSummary {
  readonly coveredSegmentCount: number;
  readonly counts: Readonly<Record<RecordingEventV1["type"], number>>;
  readonly expectedDisplayIds: readonly string[];
  readonly interactionKind:
    HardwareMetadataEvidenceExpectation["interaction"]["kind"];
  readonly observedWindowCount: number;
  readonly secureFocusIntervalsVerified: number;
  readonly totalEvents: number;
}

function eventCounts(
  events: readonly RecordingEventV1[],
): Record<RecordingEventV1["type"], number> {
  const counts = Object.fromEntries(
    EVENT_KINDS.map(kind => [kind, 0]),
  ) as Record<RecordingEventV1["type"], number>;
  for (const event of events) counts[event.type] += 1;
  return counts;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = sortedUnique(left);
  const sortedRight = sortedUnique(right);
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function compareEventOrder(
  left: Pick<RecordingEventV1, "sequence" | "sourceTimeUs">,
  right: Pick<RecordingEventV1, "sequence" | "sourceTimeUs">,
): number {
  return left.sourceTimeUs - right.sourceTimeUs
    || left.sequence - right.sequence;
}

function compareNativeEventOrder(
  left: Pick<RecordingEventV1, "nativeTimeUs" | "sequence">,
  right: Pick<RecordingEventV1, "nativeTimeUs" | "sequence">,
): number {
  return left.nativeTimeUs - right.nativeTimeUs
    || left.sequence - right.sequence;
}

function assertLifecycle(events: readonly RecordingEventV1[]): void {
  for (const expected of PAUSE_RESUME_LIFECYCLE) {
    const markers = events
      .filter(event => (
        event.type === "lifecycle.marker"
        && event.segmentId === expected.segmentId
      ))
      .sort(compareEventOrder)
      .map(event => event.type === "lifecycle.marker" ? event.marker : "");
    if (
      markers.length !== expected.markers.length
      || markers.some((marker, index) => marker !== expected.markers[index])
    ) {
      throw new HardwareMetadataEvidenceError(
        "lifecycle-evidence",
        `Hardware metadata lifecycle for ${expected.segmentId} was ${markers.join(", ") || "empty"}; expected ${expected.markers.join(", ")}.`,
      );
    }
  }
}

function assertSegmentCoverage(
  events: readonly RecordingEventV1[],
  coverage: NonNullable<
    HardwareMetadataEvidenceExpectation["segmentCoverage"]
  >,
): number {
  if (new Set(coverage.map(({ segmentId }) => segmentId)).size !== coverage.length) {
    throw new HardwareMetadataEvidenceError(
      "metadata-coverage",
      "Hardware metadata coverage contains duplicate segment IDs.",
    );
  }
  const openingKinds = [
    "cursor.sample",
    "display.topology",
    "focus.changed",
    "window.snapshot",
  ] as const satisfies readonly RecordingEventV1["type"][];
  for (const expected of coverage) {
    if (
      expected.segmentId === ""
      || !Number.isSafeInteger(expected.firstRetainedSampleNativeTimeUs)
      || !Number.isSafeInteger(expected.lastRetainedSampleNativeTimeUs)
      || expected.firstRetainedSampleNativeTimeUs < 0
      || expected.lastRetainedSampleNativeTimeUs
        < expected.firstRetainedSampleNativeTimeUs
    ) {
      throw new HardwareMetadataEvidenceError(
        "metadata-coverage",
        `Hardware metadata coverage for ${expected.segmentId || "[empty]"} is invalid.`,
      );
    }
    const lifecycle = events
      .filter((event): event is Extract<
        RecordingEventV1,
        { readonly type: "lifecycle.marker" }
      > => (
        event.type === "lifecycle.marker"
        && event.segmentId === expected.segmentId
      ))
      .sort(compareNativeEventOrder);
    const opened = lifecycle.find(({ marker }) => marker === "segment-opened");
    const closed = lifecycle.find(({ marker }) =>
      marker === "paused" || marker === "stopped"
    );
    if (
      opened === undefined
      || closed === undefined
      || opened.nativeTimeUs > expected.firstRetainedSampleNativeTimeUs
      || closed.nativeTimeUs < expected.lastRetainedSampleNativeTimeUs
    ) {
      throw new HardwareMetadataEvidenceError(
        "metadata-coverage",
        `Lifecycle metadata does not bracket retained media for ${expected.segmentId}.`,
      );
    }
    for (const kind of openingKinds) {
      if (!events.some(event => (
        event.type === kind
        && event.nativeTimeUs >= opened.nativeTimeUs
        && event.nativeTimeUs
          <= expected.firstRetainedSampleNativeTimeUs
      ))) {
        throw new HardwareMetadataEvidenceError(
          "metadata-coverage",
          `${kind} does not cover the first retained sample for ${expected.segmentId}.`,
        );
      }
    }
    if (!events.some(event => (
      event.type === "cursor.sample"
      && event.nativeTimeUs >= expected.lastRetainedSampleNativeTimeUs
      && event.nativeTimeUs <= closed.nativeTimeUs
    ))) {
      throw new HardwareMetadataEvidenceError(
        "metadata-coverage",
        `cursor.sample does not cover the last retained sample for ${expected.segmentId}.`,
      );
    }
  }
  return coverage.length;
}

function inputEventsInSecureIntervals(
  events: readonly RecordingEventV1[],
  processId: number | null,
): {
  readonly leaked: readonly RecordingEventV1[];
  readonly secureIntervalCount: number;
} {
  const focus = events
    .filter((event): event is Extract<
      RecordingEventV1,
      { readonly type: "focus.changed" }
    > => event.type === "focus.changed")
    .sort(compareNativeEventOrder);
  const input = events
    .filter(event => (
      event.type === "key.activity"
      || event.type === "typing.input"
    ))
    .sort(compareNativeEventOrder);
  const leaked: RecordingEventV1[] = [];
  let secureIntervalCount = 0;
  for (const [index, start] of focus.entries()) {
    if (
      start.target.kind !== "secure-input"
      || (
        processId !== null
        && start.target.processId !== processId
      )
    ) {
      continue;
    }
    secureIntervalCount += 1;
    const end = focus[index + 1];
    leaked.push(...input.filter(event => (
      compareNativeEventOrder(event, start) >= 0
      && (end === undefined || compareNativeEventOrder(event, end) < 0)
    )));
  }
  return { leaked, secureIntervalCount };
}

function assertInteractionEvidence(
  events: readonly RecordingEventV1[],
): void {
  const clicks = events.filter(event => event.type === "mouse.click");
  const keys = events.filter(event => event.type === "key.activity");
  const publicFocus = events.some(event => (
    event.type === "focus.changed"
    && event.target.kind === "public-input"
  ));
  const focusedWindow = events.some(event => (
    event.type === "window.changed"
    && event.change.kind === "focused"
  ));
  const hasClickPair = clicks.some(event => (
    event.type === "mouse.click" && event.phase === "down"
  )) && clicks.some(event => (
    event.type === "mouse.click" && event.phase === "up"
  ));
  const hasKeyPair = keys.some(event => (
    event.type === "key.activity" && event.activity.phase === "down"
  )) && keys.some(event => (
    event.type === "key.activity" && event.activity.phase === "up"
  ));
  const missing = [
    !hasClickPair && "mouse down/up",
    !hasKeyPair && "key down/up",
    !publicFocus && "public input focus",
    !focusedWindow && "focused window change",
  ].filter((value): value is string => typeof value === "string");
  if (missing.length > 0) {
    throw new HardwareMetadataEvidenceError(
      "interaction-evidence",
      `Interactive hardware exercise omitted: ${missing.join(", ")}.`,
    );
  }
}

type FocusEvent = Extract<
  RecordingEventV1,
  { readonly type: "focus.changed" }
>;
type KeyEvent = Extract<
  RecordingEventV1,
  { readonly type: "key.activity" }
>;
type ClickEvent = Extract<
  RecordingEventV1,
  { readonly type: "mouse.click" }
>;
type TypingEvent = Extract<
  RecordingEventV1,
  { readonly type: "typing.input" }
>;
type FixturePhase = InteractionFixtureReceipt[
  "publicAfter" | "publicBefore" | "secure"
];
type Rect = FixturePhase["bounds"];

const FIXTURE_FOCUS_EARLY_TOLERANCE_US = 300_000;
const FIXTURE_GEOMETRY_TOLERANCE = 3;

function interactionFailure(message: string): never {
  throw new HardwareMetadataEvidenceError(
    "interaction-evidence",
    message,
  );
}

function privacyFailure(message: string): never {
  throw new HardwareMetadataEvidenceError("privacy-evidence", message);
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= FIXTURE_GEOMETRY_TOLERANCE;
}

function rectsMatch(left: Rect, right: Rect): boolean {
  return near(left.x, right.x)
    && near(left.y, right.y)
    && near(left.width, right.width)
    && near(left.height, right.height);
}

function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - FIXTURE_GEOMETRY_TOLERANCE
    && inner.y >= outer.y - FIXTURE_GEOMETRY_TOLERANCE
    && inner.x + inner.width
      <= outer.x + outer.width + FIXTURE_GEOMETRY_TOLERANCE
    && inner.y + inner.height
      <= outer.y + outer.height + FIXTURE_GEOMETRY_TOLERANCE;
}

function pointMatches(
  left: Readonly<{ readonly x: number; readonly y: number }>,
  right: Readonly<{ readonly x: number; readonly y: number }>,
): boolean {
  return near(left.x, right.x) && near(left.y, right.y);
}

function pointInside(
  point: Readonly<{ readonly x: number; readonly y: number }>,
  bounds: Rect,
): boolean {
  return point.x >= bounds.x - FIXTURE_GEOMETRY_TOLERANCE
    && point.x <= bounds.x + bounds.width + FIXTURE_GEOMETRY_TOLERANCE
    && point.y >= bounds.y - FIXTURE_GEOMETRY_TOLERANCE
    && point.y <= bounds.y + bounds.height + FIXTURE_GEOMETRY_TOLERANCE;
}

function duringFixtureInput(
  event: Pick<RecordingEventV1, "nativeTimeUs">,
  phase: FixturePhase,
): boolean {
  return event.nativeTimeUs >= phase.inputStartedNativeTimeUs
    && event.nativeTimeUs <= phase.completedNativeTimeUs;
}

function matchingFixtureFocus(
  focus: readonly FocusEvent[],
  receipt: InteractionFixtureReceipt,
  phase: FixturePhase,
  kind: "public-input" | "secure-input",
  afterNativeTimeUs: number,
): FocusEvent | undefined {
  return focus.find((event) => (
    event.nativeTimeUs > afterNativeTimeUs
    && event.nativeTimeUs
      >= phase.focusConfirmedNativeTimeUs
        - FIXTURE_FOCUS_EARLY_TOLERANCE_US
    && event.nativeTimeUs <= phase.inputStartedNativeTimeUs
    && event.target.kind === kind
    && event.target.processId === receipt.publicFocusIdentity.processId
    && event.target.windowId === receipt.publicFocusIdentity.windowId
    && (
      kind === "secure-input"
      || (
        event.target.kind === "public-input"
        && event.target.fieldId === receipt.publicFocusIdentity.fieldId
      )
    )
    && rectsMatch(event.target.bounds, phase.bounds)
  ));
}

function assertClickPair(
  clicks: readonly ClickEvent[],
  phase: FixturePhase,
  displayId: string,
  label: string,
): readonly ClickEvent[] {
  const matching = clicks
    .filter(event => duringFixtureInput(event, phase))
    .sort(compareNativeEventOrder);
  if (
    matching.length !== 2
    || matching[0]?.button !== "left"
    || matching[0].phase !== "down"
    || matching[1]?.button !== "left"
    || matching[1].phase !== "up"
    || !matching.every(event => (
      event.clickCount === 1
      && event.displayId === displayId
    ))
    || !matching.every(event => (
      pointInside(event.position, phase.bounds)
      && pointMatches(event.position, phase.clickPoint)
    ))
  ) {
    interactionFailure(
      `Owned fixture ${label} did not produce its exact in-bounds click pair.`,
    );
  }
  return matching;
}

function assertPrintableKeyPair(
  keys: readonly KeyEvent[],
  phase: FixturePhase,
  label: string,
): readonly KeyEvent[] {
  const matching = keys
    .filter(event => duringFixtureInput(event, phase))
    .sort(compareNativeEventOrder);
  if (
    matching.length !== 2
    || matching[0]?.activity.kind !== "printable"
    || matching[0].activity.phase !== "down"
    || matching[0].activity.repeat
    || matching[0].activity.modifiers.length !== 0
    || matching[1]?.activity.kind !== "printable"
    || matching[1].activity.phase !== "up"
    || matching[1].activity.repeat
    || matching[1].activity.modifiers.length !== 0
  ) {
    interactionFailure(
      `Owned fixture ${label} did not produce its exact printable key pair.`,
    );
  }
  return matching;
}

function assertPublicPhaseSequence(
  clicks: readonly ClickEvent[],
  keys: readonly KeyEvent[],
  label: string,
): void {
  const sequence = [...clicks, ...keys]
    .sort(compareNativeEventOrder)
    .map(event => (
      event.type === "mouse.click"
        ? `click-${event.phase}`
        : `key-${event.activity.phase}`
    ));
  const expected = [
    "click-down",
    "click-up",
    "key-down",
    "key-up",
  ];
  if (
    sequence.length !== expected.length
    || sequence.some((item, index) => item !== expected[index])
  ) {
    interactionFailure(
      `Owned fixture ${label} events were not click-down, click-up, key-down, key-up.`,
    );
  }
}

function assertFixtureTyping(
  typing: readonly TypingEvent[],
  receipt: InteractionFixtureReceipt,
  phase: FixturePhase,
  expectedText: "a" | "b",
  label: string,
): void {
  const matching = typing.filter(event => duringFixtureInput(event, phase));
  const event = matching[0];
  if (
    matching.length !== 1
    || event === undefined
    || event.input.action !== "insert"
    || event.input.text !== expectedText
    || event.input.fieldId !== receipt.publicFocusIdentity.fieldId
    || event.input.windowId !== receipt.publicFocusIdentity.windowId
    || event.input.secure
    || !rectsMatch(event.input.bounds, phase.bounds)
  ) {
    privacyFailure(
      `Owned fixture ${label} did not produce its exact public typed-text event.`,
    );
  }
}

function assertOwnedFixtureEvidence(
  events: readonly RecordingEventV1[],
  receipt: InteractionFixtureReceipt,
  expectedDisplayIds: readonly string[],
  typedText: HardwareMetadataEvidenceExpectation["typedText"],
): void {
  if (
    receipt.publicFocusIdentity.windowTitle
      !== interactionFixtureWindowTitle(receipt.fixtureId)
    || receipt.publicFocusIdentity.fieldId
      !== interactionFixturePublicFieldId(receipt.fixtureId)
  ) {
    interactionFailure("Owned fixture receipt identity is inconsistent.");
  }

  const focusedWindows = events.filter((event): event is Extract<
    RecordingEventV1,
    { readonly type: "window.changed" }
  > => (
    event.type === "window.changed"
    && event.change.kind === "focused"
  )).filter(event => {
    if (event.change.kind !== "focused") return false;
    const candidate = event.change.window;
    return candidate.windowId === receipt.publicFocusIdentity.windowId
      && candidate.isFocused
      && expectedDisplayIds.includes(candidate.displayId)
      && candidate.title.state === "available"
      && candidate.title.value === receipt.publicFocusIdentity.windowTitle;
  });
  const focusedWindow = focusedWindows[0];
  if (focusedWindows.length !== 1 || focusedWindow === undefined) {
    interactionFailure(
      "Owned fixture did not produce one exact focused-window transition.",
    );
  }
  if (
    focusedWindow.change.kind !== "focused"
    || !rectContains(
      focusedWindow.change.window.bounds,
      receipt.publicBefore.bounds,
    )
    || !rectContains(
      focusedWindow.change.window.bounds,
      receipt.secure.bounds,
    )
    || !rectContains(
      focusedWindow.change.window.bounds,
      receipt.publicAfter.bounds,
    )
  ) {
    interactionFailure(
      "Owned fixture input bounds were not contained by its captured window.",
    );
  }

  const focus = events
    .filter((event): event is FocusEvent => event.type === "focus.changed")
    .sort(compareNativeEventOrder);
  const publicBefore = matchingFixtureFocus(
    focus,
    receipt,
    receipt.publicBefore,
    "public-input",
    -1,
  );
  const secure = matchingFixtureFocus(
    focus,
    receipt,
    receipt.secure,
    "secure-input",
    publicBefore?.nativeTimeUs ?? Number.MAX_SAFE_INTEGER,
  );
  const publicAfter = matchingFixtureFocus(
    focus,
    receipt,
    receipt.publicAfter,
    "public-input",
    secure?.nativeTimeUs ?? Number.MAX_SAFE_INTEGER,
  );
  if (
    publicBefore === undefined
    || secure === undefined
    || publicAfter === undefined
  ) {
    interactionFailure(
      "Owned fixture did not record the exact public-secure-public focus sequence.",
    );
  }
  if (
    secure.nativeTimeUs > receipt.secure.inputStartedNativeTimeUs
    || publicAfter.nativeTimeUs <= receipt.secure.completedNativeTimeUs
  ) {
    privacyFailure(
      "Owned fixture secure injection was not enclosed by a recorded secure focus interval.",
    );
  }

  const keys = events
    .filter((event): event is KeyEvent => event.type === "key.activity")
    .sort(compareNativeEventOrder);
  const clicks = events
    .filter((event): event is ClickEvent => event.type === "mouse.click")
    .sort(compareNativeEventOrder);
  if (keys.length !== 4 || clicks.length !== 6) {
    interactionFailure(
      "Owned fixture evidence contains missing or unrelated key/click events.",
    );
  }
  const publicBeforeKeys = assertPrintableKeyPair(
    keys,
    receipt.publicBefore,
    "public-before",
  );
  const publicAfterKeys = assertPrintableKeyPair(
    keys,
    receipt.publicAfter,
    "public-after",
  );
  if (keys.some(event => duringFixtureInput(event, receipt.secure))) {
    privacyFailure(
      "Owned fixture secure injection emitted key-activity metadata.",
    );
  }
  const displayId = focusedWindow.change.window.displayId;
  const publicBeforeClicks = assertClickPair(
    clicks,
    receipt.publicBefore,
    displayId,
    "public-before",
  );
  assertClickPair(clicks, receipt.secure, displayId, "secure");
  const publicAfterClicks = assertClickPair(
    clicks,
    receipt.publicAfter,
    displayId,
    "public-after",
  );
  assertPublicPhaseSequence(
    publicBeforeClicks,
    publicBeforeKeys,
    "public-before",
  );
  assertPublicPhaseSequence(
    publicAfterClicks,
    publicAfterKeys,
    "public-after",
  );

  const typing = events
    .filter((event): event is TypingEvent => event.type === "typing.input")
    .sort(compareNativeEventOrder);
  if (typedText.kind === "disabled") {
    if (typing.length !== 0) {
      privacyFailure("Typed-text opt-out emitted typing.input metadata.");
    }
  } else {
    if (typing.length !== 2) {
      privacyFailure(
        "Owned fixture typed-text mode emitted missing or unrelated typing events.",
      );
    }
    assertFixtureTyping(
      typing,
      receipt,
      receipt.publicBefore,
      "a",
      "public-before",
    );
    assertFixtureTyping(
      typing,
      receipt,
      receipt.publicAfter,
      "b",
      "public-after",
    );
  }
}

export function verifyHardwareMetadataEvidence(
  events: readonly RecordingEventV1[],
  expectation: HardwareMetadataEvidenceExpectation,
): HardwareMetadataEvidenceSummary {
  const expectedDisplayIds = sortedUnique(expectation.expectedDisplayIds);
  if (expectedDisplayIds.length === 0) {
    throw new HardwareMetadataEvidenceError(
      "display-topology",
      "Hardware metadata evidence requires at least one expected display.",
    );
  }
  const counts = eventCounts(events);
  const missingBaseline = REQUIRED_BASELINE_KINDS.filter(
    kind => counts[kind] === 0,
  );
  if (missingBaseline.length > 0) {
    throw new HardwareMetadataEvidenceError(
      "metadata-baseline",
      `Hardware metadata omitted baseline event kinds: ${missingBaseline.join(", ")}.`,
    );
  }
  if (counts["diagnostic.dropped-events"] > 0) {
    throw new HardwareMetadataEvidenceError(
      "diagnostic-event",
      `Hardware metadata contains ${String(counts["diagnostic.dropped-events"])} dropped-event diagnostic(s).`,
    );
  }

  const topologyMatches = events.some(event => (
    event.type === "display.topology"
    && sameStrings(
      event.displays.map(display => display.displayId),
      expectedDisplayIds,
    )
  ));
  if (!topologyMatches) {
    throw new HardwareMetadataEvidenceError(
      "display-topology",
      `No display.topology event exactly matched: ${expectedDisplayIds.join(", ")}.`,
    );
  }
  if (!events.some(event => (
    event.type === "cursor.sample"
    && expectedDisplayIds.includes(event.displayId)
  ))) {
    throw new HardwareMetadataEvidenceError(
      "display-topology",
      "No cursor sample resolved to a captured display.",
    );
  }

  const observedWindows = events.flatMap(event => {
    if (event.type === "window.snapshot") return event.windows;
    if (
      event.type === "window.changed"
      && event.change.kind !== "destroyed"
    ) {
      return [event.change.window];
    }
    return [];
  }).filter(window => expectedDisplayIds.includes(window.displayId));
  if (observedWindows.length === 0) {
    throw new HardwareMetadataEvidenceError(
      "window-evidence",
      "Hardware metadata did not observe a positioned window on a captured display.",
    );
  }

  assertLifecycle(events);
  const coveredSegmentCount = expectation.segmentCoverage === undefined
    ? 0
    : assertSegmentCoverage(events, expectation.segmentCoverage);

  if (
    expectation.typedText.kind === "disabled"
    && counts["typing.input"] > 0
  ) {
    throw new HardwareMetadataEvidenceError(
      "privacy-evidence",
      "Typed-text opt-out emitted typing.input metadata.",
    );
  }
  const secure = inputEventsInSecureIntervals(
    events,
    expectation.interaction.kind === "owned-fixture"
      ? expectation.interaction.receipt.publicFocusIdentity.processId
      : null,
  );
  if (secure.leaked.length > 0) {
    throw new HardwareMetadataEvidenceError(
      "privacy-evidence",
      `Secure focus interval emitted ${String(secure.leaked.length)} key or typing event(s).`,
    );
  }
  if (expectation.interaction.kind === "operator") {
    assertInteractionEvidence(events);
  } else if (expectation.interaction.kind === "owned-fixture") {
    assertOwnedFixtureEvidence(
      events,
      expectation.interaction.receipt,
      expectedDisplayIds,
      expectation.typedText,
    );
  } else if (expectation.typedText.kind !== "disabled") {
    throw new HardwareMetadataEvidenceError(
      "privacy-evidence",
      "Owned-fixture typed-text evidence requires the owned interaction fixture.",
    );
  }

  return {
    coveredSegmentCount,
    counts,
    expectedDisplayIds,
    interactionKind: expectation.interaction.kind,
    observedWindowCount: new Set(
      observedWindows.map(window => window.windowId),
    ).size,
    secureFocusIntervalsVerified: secure.secureIntervalCount,
    totalEvents: events.length,
  };
}
