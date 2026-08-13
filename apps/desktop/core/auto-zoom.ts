import {
  AutomaticZoomPlannerConfigSchema,
  AutomaticZoomSchema,
  type AutomaticZoom,
  type AutomaticZoomPlannerConfig,
  type ZoomTarget,
} from "../contracts/edit";
import type { RecordingEventV1 } from "../contracts/recording";
import { findWindowAtTime } from "./events";

type Intent = Readonly<{
  atUs: number;
  confidence: number;
  displayId: string;
  priority: number;
  reason: AutomaticZoom["reason"];
  target: ZoomTarget;
}>;

type IntentGroup = Readonly<{
  firstUs: number;
  intents: readonly Intent[];
  lastUs: number;
}>;

function intentsFromEvents(events: readonly RecordingEventV1[]): readonly Intent[] {
  return events.flatMap((event): readonly Intent[] => {
    if (event.type === "mouse.click" && event.phase === "down") {
      return [{
        atUs: event.sourceTimeUs,
        confidence: 0.9,
        displayId: event.displayId,
        priority: 2,
        reason: "click",
        target: { kind: "point", point: event.position },
      }];
    }
    if (event.type === "typing.input") {
      const displayId = findWindowAtTime(
        events,
        { kind: "window-id", windowId: event.input.windowId },
        event.sourceTimeUs,
      )?.displayId;
      if (displayId === undefined) return [];
      return [{
        atUs: event.sourceTimeUs,
        confidence: 1,
        displayId,
        priority: 4,
        reason: "typing",
        target: { kind: "rect", rect: {
          height: event.input.bounds.height + 48,
          width: event.input.bounds.width + 48,
          x: event.input.bounds.x - 24,
          y: event.input.bounds.y - 24,
        } },
      }];
    }
    if (event.type === "focus.changed" && event.target.kind !== "none") {
      const displayId = findWindowAtTime(
        events,
        { kind: "window-id", windowId: event.target.windowId },
        event.sourceTimeUs,
      )?.displayId;
      if (displayId === undefined) return [];
      return [{
        atUs: event.sourceTimeUs,
        confidence: 0.95,
        displayId,
        priority: 3,
        reason: "focus",
        target: { kind: "rect", rect: {
          height: event.target.bounds.height + 48,
          width: event.target.bounds.width + 48,
          x: event.target.bounds.x - 24,
          y: event.target.bounds.y - 24,
        } },
      }];
    }
    if (event.type === "window.changed" && event.change.kind === "focused") {
      return [{
        atUs: event.sourceTimeUs,
        confidence: 0.8,
        displayId: event.change.window.displayId,
        priority: 1,
        reason: "window-change",
        target: { kind: "rect", rect: {
          height: event.change.window.bounds.height + 32,
          width: event.change.window.bounds.width + 32,
          x: event.change.window.bounds.x - 16,
          y: event.change.window.bounds.y - 16,
        } },
      }];
    }
    return [];
  }).sort((left, right) => left.atUs - right.atUs || right.priority - left.priority);
}

function groupIntents(intents: readonly Intent[], config: AutomaticZoomPlannerConfig): readonly IntentGroup[] {
  const groupsByDisplay = new Map<string, IntentGroup[]>();
  for (const intent of intents) {
    const groups = groupsByDisplay.get(intent.displayId) ?? [];
    const prior = groups.at(-1);
    if (
      prior === undefined
      || prior.intents[0]?.displayId !== intent.displayId
      || intent.atUs - prior.lastUs > config.intentMergeGapUs
      || intent.atUs - prior.firstUs > config.maxDurationUs
    ) {
      groups.push({ firstUs: intent.atUs, intents: [intent], lastUs: intent.atUs });
    } else {
      groups[groups.length - 1] = {
        firstUs: prior.firstUs,
        intents: [...prior.intents, intent],
        lastUs: intent.atUs,
      };
    }
    groupsByDisplay.set(intent.displayId, groups);
  }
  return [...groupsByDisplay.values()].flat()
    .sort((left, right) => (
      left.firstUs - right.firstUs
      || (left.intents[0]?.displayId ?? "").localeCompare(right.intents[0]?.displayId ?? "")
    ));
}

function strongestIntent(group: IntentGroup): Intent {
  const intent = [...group.intents].sort((left, right) => right.priority - left.priority || right.atUs - left.atUs)[0];
  if (intent === undefined) throw new Error("Automatic zoom group cannot be empty.");
  return intent;
}

export function planAutomaticZooms(
  events: readonly RecordingEventV1[],
  sourceDurationUs: number,
  configInput: AutomaticZoomPlannerConfig,
): readonly AutomaticZoom[] {
  const config = AutomaticZoomPlannerConfigSchema.parse(configInput);
  if (!Number.isSafeInteger(sourceDurationUs) || sourceDurationUs < 0) {
    throw new RangeError("sourceDurationUs must be a non-negative safe integer.");
  }
  const groups = groupIntents(intentsFromEvents(events), config);
  const ranges = groups.map((group) => {
    let startUs = Math.max(0, group.firstUs - config.preHandleUs);
    let endUs = Math.min(sourceDurationUs, group.lastUs + config.postHandleUs);
    if (endUs - startUs < config.minDurationUs) {
      const missingUs = config.minDurationUs - (endUs - startUs);
      const beforeUs = Math.min(startUs, Math.floor(missingUs / 2));
      startUs -= beforeUs;
      endUs = Math.min(sourceDurationUs, endUs + missingUs - beforeUs);
      startUs = Math.max(0, endUs - config.minDurationUs);
    }
    if (endUs - startUs > config.maxDurationUs) endUs = startUs + config.maxDurationUs;
    return { endUs, group, startUs };
  }).filter(({ endUs, startUs }) => endUs > startUs);

  const suppressedByDisplay = new Map<string, typeof ranges>();
  for (const range of ranges) {
    const displayId = strongestIntent(range.group).displayId;
    const suppressed = suppressedByDisplay.get(displayId) ?? [];
    const prior = suppressed.at(-1);
    if (prior === undefined || range.startUs >= prior.endUs) {
      suppressed.push(range);
      suppressedByDisplay.set(displayId, suppressed);
      continue;
    }
    const combinedGroup: IntentGroup = {
      firstUs: prior.group.firstUs,
      intents: [...prior.group.intents, ...range.group.intents],
      lastUs: range.group.lastUs,
    };
    const mergedEndUs = Math.min(
      sourceDurationUs,
      prior.startUs + config.maxDurationUs,
      Math.max(prior.endUs, range.endUs, prior.startUs + config.minDurationUs),
    );
    suppressed[suppressed.length - 1] = { endUs: mergedEndUs, group: combinedGroup, startUs: prior.startUs };
    if (range.endUs > mergedEndUs) {
      suppressed.push({ ...range, startUs: mergedEndUs });
    }
    suppressedByDisplay.set(displayId, suppressed);
  }

  const suppressed = [...suppressedByDisplay.values()].flat()
    .filter(({ endUs, startUs }) => endUs > startUs)
    .sort((left, right) => (
      left.startUs - right.startUs
      || strongestIntent(left.group).displayId.localeCompare(strongestIntent(right.group).displayId)
    ));
  return suppressed.map(({ startUs, endUs, group }, index) => {
    const intent = strongestIntent(group);
    const durationUs = endUs - startUs;
    const enterDurationUs = Math.min(config.enterDurationUs, Math.floor(durationUs / 2));
    const exitDurationUs = Math.min(config.exitDurationUs, durationUs - enterDurationUs);
    return AutomaticZoomSchema.parse({
      confidence: intent.confidence,
      displayId: intent.displayId,
      easing: { kind: "ease-in-out" },
      enterDurationUs,
      exitDurationUs,
      kind: "automatic",
      range: { startUs, endUs },
      reason: intent.reason,
      scale: Math.min(config.scale, config.maxScale),
      target: intent.target,
      zoomId: `zoom_auto${String(index + 1).padStart(4, "0")}`,
    });
  });
}
