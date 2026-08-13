import {
  CursorSampleEventSchema,
  RecordingEventV1Schema,
  type CursorSampleEvent,
  type Point,
  type RecordingEventV1,
  type Rect,
  type WindowRecord,
} from "../contracts/recording";
import type { WindowSelector } from "../contracts/edit";

export interface EventQueryOptions {
  readonly endUs?: number;
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly startUs?: number;
  readonly types?: readonly RecordingEventV1["type"][];
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LINES = 250_000;
const DEFAULT_LIMIT = 10_000;
const ABSOLUTE_MAX_BYTES = 256 * 1024 * 1024;
const ABSOLUTE_MAX_LINES = 2_000_000;
const ABSOLUTE_MAX_RESULTS = 100_000;

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

export function queryEventJsonl(jsonl: string, options: EventQueryOptions = {}): readonly RecordingEventV1[] {
  const maxBytes = boundedInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES, "maxBytes");
  const maxLines = boundedInteger(options.maxLines ?? DEFAULT_MAX_LINES, ABSOLUTE_MAX_LINES, "maxLines");
  const limit = boundedInteger(options.limit ?? DEFAULT_LIMIT, ABSOLUTE_MAX_RESULTS, "limit");
  if (new TextEncoder().encode(jsonl).byteLength > maxBytes) {
    throw new RangeError(`Event stream exceeds maxBytes (${maxBytes}).`);
  }
  const lines = jsonl.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > maxLines) throw new RangeError(`Event stream exceeds maxLines (${maxLines}).`);
  const acceptedTypes = options.types === undefined ? null : new Set(options.types);
  const startUs = options.startUs ?? 0;
  const endUs = options.endUs ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || startUs < 0 || endUs < startUs) {
    throw new RangeError("Event query source-time bounds are invalid.");
  }

  const result: RecordingEventV1[] = [];
  let priorSequence = -1;
  let priorSourceTimeUs = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(`Invalid event JSON on line ${index + 1}: ${String(error)}`);
    }
    const event = RecordingEventV1Schema.parse(input);
    if (event.sequence <= priorSequence) {
      throw new Error(`Event sequence must increase at line ${index + 1}.`);
    }
    if (event.sourceTimeUs < priorSourceTimeUs) {
      throw new Error(`Event sourceTimeUs must not move backward at line ${index + 1}.`);
    }
    priorSequence = event.sequence;
    priorSourceTimeUs = event.sourceTimeUs;
    if (event.sourceTimeUs < startUs || event.sourceTimeUs >= endUs) continue;
    if (acceptedTypes !== null && !acceptedTypes.has(event.type)) continue;
    result.push(event);
    if (result.length >= limit) break;
  }
  return result;
}

export type TypingSpan = Readonly<{
  bounds: Rect;
  endUs: number;
  fieldId: string;
  secure: boolean;
  startUs: number;
  text: string;
  updates: readonly TypingUpdate[];
  windowId: string;
}>;

export type TypingUpdate = Readonly<{
  bounds: Rect;
  sourceTimeUs: number;
  text: string;
}>;

function deleteLastCodePoint(value: string): string {
  return [...value].slice(0, -1).join("");
}

export function deriveTypingSpans(
  events: readonly RecordingEventV1[],
  idleTimeoutUs: number,
): readonly TypingSpan[] {
  if (!Number.isSafeInteger(idleTimeoutUs) || idleTimeoutUs <= 0) {
    throw new RangeError("idleTimeoutUs must be a positive safe integer.");
  }
  const ordered = [...events]
    .sort((left, right) => left.sourceTimeUs - right.sourceTimeUs || left.sequence - right.sequence);
  const spans: TypingSpan[] = [];
  let active: TypingSpan | null = null;
  const closeActive = (boundaryUs: number): void => {
    if (active === null) return;
    const endUs = Math.min(
      active.endUs,
      Math.max(active.startUs, boundaryUs),
    );
    if (endUs > active.startUs && active.updates.length > 0) {
      spans.push({ ...active, endUs });
    }
    active = null;
  };

  for (const event of ordered) {
    if (active !== null && event.sourceTimeUs > active.endUs) {
      closeActive(active.endUs);
    }
    if (event.type === "focus.changed") {
      const target = event.target;
      if (
        active !== null
        && (
          target.kind !== "public-input"
          || target.windowId !== active.windowId
          || target.fieldId !== active.fieldId
        )
      ) {
        closeActive(event.sourceTimeUs);
      }
      continue;
    }
    if (event.type === "window.snapshot") {
      if (
        active !== null
        && !event.windows.some(window => (
          window.windowId === active?.windowId
          && window.isFocused
        ))
      ) {
        closeActive(event.sourceTimeUs);
      }
      continue;
    }
    if (event.type === "window.changed") {
      if (
        active !== null
        && (
          (event.change.kind === "destroyed"
            && event.change.windowId === active.windowId)
          || (event.change.kind === "focused"
            && event.change.window.windowId !== active.windowId)
        )
      ) {
        closeActive(event.sourceTimeUs);
      }
      continue;
    }
    if (
      event.type === "lifecycle.marker"
      && [
        "failed",
        "pause-requested",
        "paused",
        "segment-closed",
        "stop-requested",
        "stopped",
      ].includes(event.marker)
    ) {
      closeActive(event.sourceTimeUs);
      continue;
    }
    if (
      event.type === "diagnostic.dropped-events"
      && ["lifecycle", "typing", "window"].includes(event.category)
    ) {
      closeActive(event.sourceTimeUs);
      continue;
    }
    if (event.type !== "typing.input") continue;

    const input = event.input;
    // Forward-delete depends on a cursor selection that capture deliberately
    // does not retain. Hide the callout instead of presenting stale text.
    if (input.action === "delete-forward") {
      closeActive(event.sourceTimeUs);
      continue;
    }
    const sameTarget = active !== null
      && active.windowId === input.windowId
      && active.fieldId === input.fieldId
      && active.secure === input.secure
      && event.sourceTimeUs <= active.endUs;
    if (!sameTarget) {
      closeActive(event.sourceTimeUs);
      active = {
        bounds: input.bounds,
        endUs: event.sourceTimeUs + idleTimeoutUs,
        fieldId: input.fieldId,
        secure: input.secure,
        startUs: event.sourceTimeUs,
        text: input.secure ? "[REDACTED]" : "",
        updates: [],
        windowId: input.windowId,
      };
    }
    if (active === null) continue;
    let text: string = active.text;
    if (!input.secure) {
      if (input.action === "insert") text += input.text;
      else if (input.action === "replace") text = input.text;
      else if (input.action === "delete-backward") text = deleteLastCodePoint(text);
    }
    active = {
      ...active,
      bounds: input.bounds,
      endUs: event.sourceTimeUs + idleTimeoutUs,
      text,
      updates: input.secure && active.updates.length > 0
        ? active.updates
          : [...active.updates, {
            bounds: input.bounds,
            sourceTimeUs: event.sourceTimeUs,
            text: input.secure ? "[REDACTED]" : text,
          }],
    };
  }
  if (active !== null) closeActive(active.endUs);
  return spans;
}

export type SmoothedCursorSample = Readonly<{
  displayId: string;
  nativeTimeUs: number;
  position: Point;
  sourceTimeUs: number;
  visible: boolean;
}>;

export interface CursorSmoothingOptions {
  readonly minDistancePx: number;
  readonly minIntervalUs: number;
  readonly strength: number;
}

export type CursorSampling = "interpolated" | "nearest";

export const MAX_CURSOR_INTERPOLATION_GAP_US = 250_000;

function pointDistance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function smoothAndDownsampleCursor(
  events: readonly RecordingEventV1[],
  options: CursorSmoothingOptions,
): readonly SmoothedCursorSample[] {
  if (
    !Number.isFinite(options.strength)
    || options.strength < 0
    || options.strength > 1
    || !Number.isSafeInteger(options.minIntervalUs)
    || options.minIntervalUs < 0
    || !Number.isFinite(options.minDistancePx)
    || options.minDistancePx < 0
  ) {
    throw new RangeError("Invalid cursor smoothing options.");
  }
  const cursors = events.filter((event): event is CursorSampleEvent => event.type === "cursor.sample")
    .sort((left, right) => left.sourceTimeUs - right.sourceTimeUs || left.sequence - right.sequence);
  const smoothedByDisplay = new Map<string, Point>();
  const lastKeptByDisplay = new Map<string, SmoothedCursorSample>();
  const lastSeenByDisplay = new Map<string, SmoothedCursorSample>();
  const result: SmoothedCursorSample[] = [];
  const smoothingGain = 1 - options.strength * 0.95;
  for (const event of cursors) {
    const prior = smoothedByDisplay.get(event.displayId);
    const position = prior === undefined || options.strength === 0
      ? event.position
      : {
          x: prior.x + (event.position.x - prior.x) * smoothingGain,
          y: prior.y + (event.position.y - prior.y) * smoothingGain,
        };
    smoothedByDisplay.set(event.displayId, position);
    const sample: SmoothedCursorSample = {
      displayId: event.displayId,
      nativeTimeUs: event.nativeTimeUs,
      position,
      sourceTimeUs: event.sourceTimeUs,
      visible: event.visible,
    };
    lastSeenByDisplay.set(event.displayId, sample);
    const lastKept = lastKeptByDisplay.get(event.displayId);
    if (
      lastKept === undefined
      || sample.visible !== lastKept.visible
      || sample.sourceTimeUs - lastKept.sourceTimeUs >= options.minIntervalUs
      || pointDistance(sample.position, lastKept.position) >= options.minDistancePx
    ) {
      result.push(sample);
      lastKeptByDisplay.set(event.displayId, sample);
    }
  }
  for (const [displayId, sample] of lastSeenByDisplay) {
    if (lastKeptByDisplay.get(displayId)?.sourceTimeUs !== sample.sourceTimeUs) result.push(sample);
  }
  return result.sort((left, right) => left.sourceTimeUs - right.sourceTimeUs || left.displayId.localeCompare(right.displayId));
}

function windowStateAt(events: readonly RecordingEventV1[], sourceTimeUs: number): Map<string, WindowRecord> {
  const windows = new Map<string, WindowRecord>();
  const ordered = [...events].sort((left, right) => left.sourceTimeUs - right.sourceTimeUs || left.sequence - right.sequence);
  for (const event of ordered) {
    if (event.sourceTimeUs > sourceTimeUs) break;
    if (event.type === "window.snapshot") {
      windows.clear();
      for (const window of event.windows) windows.set(window.windowId, window);
    } else if (event.type === "window.changed") {
      if (event.change.kind === "destroyed") windows.delete(event.change.windowId);
      else windows.set(event.change.window.windowId, event.change.window);
    }
  }
  return windows;
}

export function findWindowAtTime(
  events: readonly RecordingEventV1[],
  selector: WindowSelector,
  sourceTimeUs: number,
): WindowRecord | null {
  const windows = [...windowStateAt(events, sourceTimeUs).values()];
  if (selector.kind === "window-id") return windows.find(({ windowId }) => windowId === selector.windowId) ?? null;
  const candidates = selector.kind === "application"
    ? windows.filter(({ applicationBundleId }) => applicationBundleId === selector.applicationBundleId)
    : windows;
  return candidates.sort((left, right) => Number(right.isFocused) - Number(left.isFocused) || right.layer - left.layer)[0] ?? null;
}

export function findFocusedInputAtTime(
  events: readonly RecordingEventV1[],
  sourceTimeUs: number,
): { readonly bounds: Rect; readonly windowId: string } | null {
  const focus = [...events]
    .filter((event) => event.type === "focus.changed" && event.sourceTimeUs <= sourceTimeUs)
    .sort((left, right) => right.sourceTimeUs - left.sourceTimeUs || right.sequence - left.sequence)[0];
  if (focus !== undefined && focus.type === "focus.changed") {
    return focus.target.kind === "none"
      ? null
      : { bounds: focus.target.bounds, windowId: focus.target.windowId };
  }
  const typing = [...events]
    .filter((event) => event.type === "typing.input" && event.sourceTimeUs <= sourceTimeUs)
    .sort((left, right) => right.sourceTimeUs - left.sourceTimeUs || right.sequence - left.sequence)[0];
  if (typing === undefined || typing.type !== "typing.input") return null;
  return { bounds: typing.input.bounds, windowId: typing.input.windowId };
}

export function findCursorAtTime(
  events: readonly RecordingEventV1[],
  sourceTimeUs: number,
  sampling: CursorSampling = "nearest",
): CursorSampleEvent | null {
  const cursors = [...events]
    .filter((event): event is CursorSampleEvent => event.type === "cursor.sample")
    .sort((left, right) => left.sourceTimeUs - right.sourceTimeUs || left.sequence - right.sequence);
  const nearest = [...cursors].sort((left, right) => (
    Math.abs(left.sourceTimeUs - sourceTimeUs) - Math.abs(right.sourceTimeUs - sourceTimeUs)
    || Number(left.sourceTimeUs > sourceTimeUs) - Number(right.sourceTimeUs > sourceTimeUs)
    || left.sequence - right.sequence
  ))[0] ?? null;
  if (sampling === "nearest" || nearest === null) return nearest;

  const before = [...cursors].reverse().find(({ sourceTimeUs: timeUs }) => timeUs <= sourceTimeUs);
  const after = cursors.find(({ sourceTimeUs: timeUs }) => timeUs >= sourceTimeUs);
  if (
    before === undefined
    || after === undefined
    || before.sourceTimeUs === after.sourceTimeUs
    || before.displayId !== after.displayId
    || !before.visible
    || !after.visible
    || after.sourceTimeUs - before.sourceTimeUs > MAX_CURSOR_INTERPOLATION_GAP_US
  ) {
    return nearest;
  }
  const progress = (sourceTimeUs - before.sourceTimeUs) / (after.sourceTimeUs - before.sourceTimeUs);
  return CursorSampleEventSchema.parse({
    displayId: before.displayId,
    nativeTimeUs: Math.round(before.nativeTimeUs + (after.nativeTimeUs - before.nativeTimeUs) * progress),
    position: {
      x: before.position.x + (after.position.x - before.position.x) * progress,
      y: before.position.y + (after.position.y - before.position.y) * progress,
    },
    sequence: nearest.sequence,
    sourceTimeUs,
    type: "cursor.sample",
    visible: true,
  });
}
