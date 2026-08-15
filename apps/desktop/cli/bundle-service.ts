import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  parseRecordingEventV1,
  type EditPlanV1,
  type RecordingEventV1,
  type RecordingManifestV1,
} from "../contracts";
import {
  createNodeBundleFileSystem,
  hashEditPlan,
  loadEditPlan,
  loadRecordingManifest,
  type BundleFileSystem,
} from "../core";
import { CliError } from "./errors";
import { resolveSafePath } from "./paths";
import { MAX_EVENT_QUERY_LIMIT } from "./query-limits";
import { resolveRecordingDirectory, type RecordingDirectory } from "./recording-ref";

export const CURRENT_EDIT_PLAN_PATH = "edits/current.json";

export interface OpenRecording {
  readonly directory: RecordingDirectory;
  readonly fileSystem: BundleFileSystem;
  readonly manifest: RecordingManifestV1;
}

function compareEventOrder(left: RecordingEventV1, right: RecordingEventV1): number {
  return left.sourceTimeUs - right.sourceTimeUs || left.sequence - right.sequence;
}

/** Retain the earliest N events with the latest retained event at heap[0]. */
function retainEarliestEvent(
  heap: RecordingEventV1[],
  event: RecordingEventV1,
  limit: number,
): void {
  if (heap.length < limit) {
    heap.push(event);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareEventOrder(heap[parent]!, heap[index]!) >= 0) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
    return;
  }
  if (compareEventOrder(event, heap[0]!) >= 0) return;
  heap[0] = event;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let latest = left;
    if (right < heap.length && compareEventOrder(heap[right]!, heap[left]!) > 0) latest = right;
    if (compareEventOrder(heap[index]!, heap[latest]!) >= 0) return;
    [heap[index], heap[latest]] = [heap[latest]!, heap[index]!];
    index = latest;
  }
}

export async function openRecording(artifactRoot: string, reference: string): Promise<OpenRecording> {
  const directory = await resolveRecordingDirectory(artifactRoot, reference);
  const fileSystem = createNodeBundleFileSystem(directory.path);
  try {
    const manifest = await loadRecordingManifest(fileSystem);
    if (manifest.recordingId !== directory.id) {
      throw new CliError(
        "invalid-data",
        `Bundle directory ${directory.id} contains manifest for ${manifest.recordingId}.`,
      );
    }
    return { directory, fileSystem, manifest };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("invalid-data", `Could not load ${directory.id}/manifest.json: ${String(error)}`);
  }
}

export async function loadCurrentPlan(recording: OpenRecording): Promise<EditPlanV1> {
  try {
    return await loadEditPlan(recording.fileSystem, CURRENT_EDIT_PLAN_PATH);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(
        "not-found",
        `Recording ${recording.manifest.recordingId} has no edit plan. Run: atet edit ${recording.manifest.recordingId} init`,
      );
    }
    throw error;
  }
}

export async function tryLoadCurrentPlan(recording: OpenRecording): Promise<EditPlanV1 | null> {
  try {
    return await loadEditPlan(recording.fileSystem, CURRENT_EDIT_PLAN_PATH);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadRecordingEvents(
  recording: OpenRecording,
  options: {
    readonly endUs?: number;
    readonly limit?: number;
    readonly startUs?: number;
    readonly types?: readonly RecordingEventV1["type"][];
  } = {},
): Promise<readonly RecordingEventV1[]> {
  if (
    options.limit !== undefined
    && (!Number.isSafeInteger(options.limit) || options.limit <= 0 || options.limit > MAX_EVENT_QUERY_LIMIT)
  ) {
    throw new CliError(
      "usage",
      `Event query limit must be a positive integer no greater than ${MAX_EVENT_QUERY_LIMIT}.`,
    );
  }
  const startUs = options.startUs ?? 0;
  const endUs = options.endUs ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || startUs < 0 || endUs < startUs) {
    throw new CliError("usage", "Event query source-time bounds are invalid.");
  }
  const acceptedTypes = options.types === undefined ? null : new Set(options.types);
  const events: RecordingEventV1[] = [];
  const streams = recording.manifest.eventStreams.filter((stream) =>
    options.types === undefined || stream.eventKinds.some((kind) => options.types!.includes(kind))
  );
  for (const stream of streams) {
    const path = await resolveSafePath(recording.directory.path, stream.path);
    const input = createReadStream(path);
    const hash = createHash("sha256");
    let bytes = 0;
    input.on("data", (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += data.length;
      hash.update(data);
    });
    const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input });
    let lineNumber = 0;
    let parsedCount = 0;
    let priorSequence = -1;
    let priorSourceTimeUs = -1;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (line.trim() === "") continue;
        if (Buffer.byteLength(line) > 1_048_576) {
          throw new CliError("invalid-data", `${stream.path}:${lineNumber} exceeds the 1 MiB event-line bound.`);
        }
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch (error) {
          throw new CliError("invalid-data", `${stream.path}:${lineNumber} is not valid JSON: ${String(error)}`);
        }
        let event: RecordingEventV1;
        try {
          event = parseRecordingEventV1(value);
        } catch (error) {
          throw new CliError("invalid-data", `${stream.path}:${lineNumber} is not a recording event: ${String(error)}`);
        }
        parsedCount += 1;
        if (event.sequence <= priorSequence) {
          throw new CliError("invalid-data", `${stream.path}:${lineNumber} does not increase event sequence.`);
        }
        if (event.sourceTimeUs < priorSourceTimeUs) {
          throw new CliError("invalid-data", `${stream.path}:${lineNumber} moves source time backward.`);
        }
        if (event.sourceTimeUs < stream.startUs || event.sourceTimeUs > stream.endUs) {
          throw new CliError("invalid-data", `${stream.path}:${lineNumber} lies outside its manifest interval.`);
        }
        priorSequence = event.sequence;
        priorSourceTimeUs = event.sourceTimeUs;
        if (event.sourceTimeUs < startUs || event.sourceTimeUs >= endUs) continue;
        if (acceptedTypes !== null && !acceptedTypes.has(event.type)) continue;
        if (options.limit === undefined) events.push(event);
        else retainEarliestEvent(events, event, options.limit);
      }
    } catch (error) {
      input.destroy();
      if (error instanceof CliError) throw error;
      throw new CliError("invalid-data", `Could not read event stream ${stream.path}: ${String(error)}`);
    }
    if (parsedCount !== stream.recordCount) {
      throw new CliError(
        "invalid-data",
        `${stream.path} contains ${parsedCount} event(s), but its manifest declares ${stream.recordCount}.`,
      );
    }
    if (stream.integrity.state === "verified") {
      const sha256 = hash.digest("hex");
      if (bytes !== stream.integrity.bytes || sha256 !== stream.integrity.sha256) {
        throw new CliError("invalid-data", `Event stream integrity check failed for ${stream.path}.`);
      }
    }
  }
  return events.sort(compareEventOrder);
}

export function recordingSummary(
  recording: OpenRecording,
  plan: EditPlanV1 | null,
): Readonly<Record<string, unknown>> {
  const manifest = recording.manifest;
  return {
    createdAt: manifest.createdAt,
    diagnostics: manifest.diagnostics,
    durationUs: manifest.timeline.durationUs,
    edit: plan === null
      ? null
      : {
          cuts: Math.max(0, plan.keep.length - 1),
          hash: hashEditPlan(plan),
          overlays: plan.overlays.length,
          planId: plan.planId,
          speedRanges: plan.speed.length,
          zooms: plan.zooms.length,
        },
    eventStreams: manifest.eventStreams.map((stream) => ({
      eventKinds: stream.eventKinds,
      eventStreamId: stream.eventStreamId,
      path: stream.path,
      recordCount: stream.recordCount,
    })),
    path: recording.directory.path,
    recordingId: manifest.recordingId,
    state: manifest.state,
    tracks: manifest.tracks.map((track) => ({
      enabled: track.enabled,
      kind: track.kind,
      label: track.label,
      segmentCount: track.segments.length,
      trackId: track.trackId,
    })),
    updatedAt: manifest.updatedAt,
  };
}

export function bundleRelativePath(recording: OpenRecording, absolutePath: string): string {
  const prefix = `${recording.directory.path}/`;
  if (!absolutePath.startsWith(prefix)) {
    throw new CliError("unsafe-path", `Path is outside ${recording.manifest.recordingId}: ${absolutePath}`);
  }
  return absolutePath.slice(prefix.length);
}

export function defaultPlanId(manifest: RecordingManifestV1): string {
  return `plan_${manifest.recordingId.slice(4)}`;
}
