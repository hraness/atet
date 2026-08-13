import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { release } from "node:os";
import type {
  CaptureEvent,
  CaptureInterruption,
  CaptureOptions,
  SegmentCompletion,
} from "../capture/protocol";
import {
  deriveCaptureSyncDurationDriftPpm,
  deriveCaptureSyncPlacement,
  deriveCaptureSyncSpanToleranceUs,
  deriveCaptureSyncTolerances,
  EventStreamReferenceSchema,
  LogicalTrackSchema,
  MediaSegmentSchema,
  RecordingManifestV3Schema,
  TrackIdSchema,
  type RecordingManifestV3,
} from "../contracts";
import {
  createNodeBundleFileSystem,
  saveRecordingManifest,
  type BundleFileSystem,
} from "../core";
import { CliError } from "./errors";
import { BunProcessRunner, type ProcessRunner } from "./io";
import { ensurePrivateDirectory, resolveSafePath } from "./paths";

interface ProbeStream {
  readonly codec: string;
  readonly endPtsUs: number;
  readonly firstPtsUs: number;
  readonly id: string | undefined;
  readonly index: number;
  readonly tickUs: number;
  readonly type: "audio" | "video" | "unknown";
}

interface VerifiedStream {
  readonly codec: string;
  readonly containerTrackIdentity:
    | { readonly containerTrackId: string; readonly kind: "verified" }
    | { readonly diagnosticCode: string; readonly expectedRole: "camera-video" | "display-video" | "microphone-audio" | "system-audio"; readonly kind: "provisional" };
  readonly filePresentation: {
    readonly endPtsUs: number;
    readonly firstPtsUs: number;
    readonly spanToleranceUs: number;
    readonly tickUs: number;
  };
  readonly streamIndex: number;
  readonly timing: NonNullable<SegmentCompletion["displays"][number]["streams"][number]["timing"]>;
}

interface FinalizationDiagnostic {
  readonly code: string;
  readonly level: "warning" | "error";
  readonly message: string;
}

interface CaptureSyncPublicationViolation {
  readonly captureSegmentIndex: number;
  readonly durationDriftUs: number;
  readonly durationDriftToleranceUs: number;
  readonly endUs: number;
  readonly kind: RecordingManifestV3["tracks"][number]["kind"];
  readonly onsetSkewUs: number;
  readonly onsetSkewToleranceUs: number;
  readonly path: string;
  readonly segmentId: string;
  readonly trackId: string;
}

export const CAPTURE_INTEGRITY_CHUNK_BYTES = 1024 * 1024;
export const CAPTURE_MEDIA_PROBE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_SYNC_PUBLICATION_VIOLATIONS = 16;

interface CaptureIntegrityReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

function opaque(prefix: "event" | "segment" | "track", value: string): string {
  const schemaPrefix = prefix === "event" ? "events" : prefix;
  return `${schemaPrefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export async function hashCaptureOutputChunks(
  reader: CaptureIntegrityReader,
  expectedBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new CliError("invalid-data", "Capture output has an invalid byte length.");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(CAPTURE_INTEGRITY_CHUNK_BYTES, expectedBytes));
  let position = 0;
  while (position < expectedBytes) {
    const requested = Math.min(buffer.byteLength, expectedBytes - position);
    const result = await reader.read(buffer, 0, requested, position);
    if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > requested) {
      throw new CliError("invalid-data", "Capture output ended or changed while its integrity was being recorded.");
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return hash.digest("hex");
}

function sameCaptureFile(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function integrity(path: string): Promise<{ readonly bytes: number; readonly sha256: string; readonly state: "verified" }> {
  const lexical = await lstat(path);
  if (
    lexical.isSymbolicLink()
    || !lexical.isFile()
    || !Number.isSafeInteger(lexical.size)
    || lexical.size <= 0
  ) {
    throw new CliError("invalid-data", `Capture output is not a stable physical regular file: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameCaptureFile(lexical, before)) {
      throw new CliError("conflict", `Capture output changed before its integrity could be recorded: ${path}`);
    }
    const sha256 = await hashCaptureOutputChunks(handle, before.size);
    const after = await handle.stat();
    if (!sameCaptureFile(before, after)) {
      throw new CliError("conflict", `Capture output changed while its integrity was being recorded: ${path}`);
    }
    return {
      bytes: before.size,
      sha256,
      state: "verified",
    };
  } finally {
    await handle.close();
  }
}

function parseProbeStreams(stdout: string): readonly ProbeStream[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new CliError("invalid-data", "FFprobe stream output is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("invalid-data", "FFprobe stream output must be an object.");
  }
  const streams = (value as Readonly<Record<string, unknown>>).streams;
  if (!Array.isArray(streams)) throw new CliError("invalid-data", "FFprobe stream output omits streams.");
  const parsed = streams.flatMap((raw): readonly ProbeStream[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new CliError("invalid-data", "FFprobe stream entry must be an object.");
    }
    const stream = raw as Readonly<Record<string, unknown>>;
    if (typeof stream.index !== "number" || !Number.isSafeInteger(stream.index) || stream.index < 0) {
      throw new CliError("invalid-data", "FFprobe stream index is invalid.");
    }
    const codec = typeof stream.codec_name === "string" && stream.codec_name !== ""
      ? stream.codec_name
      : "unknown";
    const type = stream.codec_type === "video" ? "video" : stream.codec_type === "audio" ? "audio" : "unknown";
    if (type === "unknown") return [];
    const id = typeof stream.id === "string" || typeof stream.id === "number" ? String(stream.id) : undefined;
    const firstPtsUs = timestampTicksToMicroseconds(stream.start_pts, stream.time_base)
      ?? decimalSecondsToMicroseconds(stream.start_time);
    const tickUs = timebaseTickUs(stream.time_base);
    const durationUs = durationTicksToMicroseconds(stream.duration_ts, stream.time_base)
      ?? decimalSecondsToMicroseconds(stream.duration);
    if (firstPtsUs === null || durationUs === null || durationUs <= 0 || tickUs === null) {
      throw new CliError("invalid-data", `FFprobe stream ${stream.index} omits finite first/end PTS evidence.`);
    }
    const endPtsUs = firstPtsUs + durationUs;
    if (!Number.isSafeInteger(endPtsUs)) {
      throw new CliError("invalid-data", `FFprobe stream ${stream.index} PTS exceeds the supported range.`);
    }
    return [{ codec, endPtsUs, firstPtsUs, id, index: stream.index, tickUs, type }];
  });
  if (new Set(parsed.map(({ index }) => index)).size !== parsed.length) {
    throw new CliError("invalid-data", "FFprobe audio/video stream indices must be unique.");
  }
  return parsed;
}

function durationTicksToMicroseconds(ticksValue: unknown, timebaseValue: unknown): number | null {
  const microseconds = timestampTicksToMicroseconds(ticksValue, timebaseValue);
  return microseconds !== null && microseconds > 0 ? microseconds : null;
}

function timestampTicksToMicroseconds(ticksValue: unknown, timebaseValue: unknown): number | null {
  if (
    (typeof ticksValue !== "string" && typeof ticksValue !== "number")
    || typeof timebaseValue !== "string"
  ) return null;
  const ticks = Number(ticksValue);
  const match = /^(?<numerator>[1-9][0-9]*)\/(?<denominator>[1-9][0-9]*)$/u.exec(timebaseValue);
  if (match?.groups === undefined) return null;
  const microseconds = Math.round(
    ticks * Number(match.groups.numerator) * 1_000_000 / Number(match.groups.denominator),
  );
  return Number.isSafeInteger(ticks) && Number.isSafeInteger(microseconds) ? microseconds : null;
}

function decimalSecondsToMicroseconds(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const seconds = Number(value);
  const microseconds = Math.round(seconds * 1_000_000);
  return Number.isFinite(seconds) && Number.isSafeInteger(microseconds) ? microseconds : null;
}

function timebaseTickUs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(?<numerator>[1-9][0-9]*)\/(?<denominator>[1-9][0-9]*)$/u.exec(value);
  if (match?.groups === undefined) return null;
  const seconds = Number(match.groups.numerator) / Number(match.groups.denominator);
  const tickUs = Math.ceil(Math.abs(seconds) * 1_000_000);
  return Number.isFinite(seconds) && Number.isSafeInteger(tickUs) && tickUs > 0 ? tickUs : null;
}

function numericTrackId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export interface CaptureMediaVerifierOptions {
  readonly ffprobe?: string;
  readonly runner?: ProcessRunner;
}

export class CaptureMediaVerifier {
  readonly #ffprobe: string;
  readonly #runner: ProcessRunner;

  constructor(options: CaptureMediaVerifierOptions = {}) {
    this.#ffprobe = options.ffprobe ?? "ffprobe";
    this.#runner = options.runner ?? new BunProcessRunner();
  }

  async verify(
    absolutePath: string,
    streams: readonly SegmentCompletion["displays"][number]["streams"][number][],
  ): Promise<{
    readonly diagnostics: readonly FinalizationDiagnostic[];
    readonly fileOriginPtsUs: number;
    readonly streams: readonly (VerifiedStream | null)[];
  }> {
    const result = await this.#runner.run([
      this.#ffprobe,
      "-v", "error",
      "-show_entries", "stream=index,id,codec_name,codec_type,start_time,start_pts,duration,duration_ts,time_base",
      "-of", "json",
      absolutePath,
    ], {
      maxOutputBytes: 1_000_000,
      timeoutMs: CAPTURE_MEDIA_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new CliError(
        "subprocess",
        `Could not verify finalized capture timing for ${absolutePath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    const probed = parseProbeStreams(result.stdout);
    if (probed.length === 0) {
      throw new CliError("invalid-data", `FFprobe found no timed audio/video stream in ${absolutePath}.`);
    }
    const fileOriginPtsUs = Math.min(...probed.map(({ firstPtsUs }) => firstPtsUs));
    const used = new Set(streams.flatMap(stream => {
      if (stream.role !== "unclassified-audio") return [];
      const reserved = probed.find(candidate => (
        candidate.type === "audio"
        && (
          candidate.index === stream.streamIndex
          || (
            stream.trackId !== undefined
            && numericTrackId(candidate.id) === stream.trackId
          )
        )
      ));
      return reserved === undefined ? [] : [reserved.index];
    }));
    const diagnostics: FinalizationDiagnostic[] = [];
    const verified = streams.map((stream): VerifiedStream | null => {
      if (stream.role === "unclassified-audio") {
        diagnostics.push({
          code: "unclassified-audio-stream",
          level: "warning",
          message: `Ignored unclassified audio stream ${stream.streamIndex} in ${absolutePath}.`,
        });
        return null;
      }
      const expectedType = stream.role.endsWith("video") ? "video" : "audio";
      const exact = stream.trackId === undefined
        ? undefined
        : probed.find((candidate) =>
            numericTrackId(candidate.id) === stream.trackId
            && candidate.type === expectedType
            && !used.has(candidate.index)
          );
      const indexed = probed.find((candidate) =>
        candidate.index === stream.streamIndex && candidate.type === expectedType && !used.has(candidate.index)
      );
      const roleMatch = probed.find((candidate) => candidate.type === expectedType && !used.has(candidate.index));
      const match = exact ?? indexed ?? roleMatch;
      if (match === undefined) {
        throw new CliError(
          "invalid-data",
          `FFprobe found no ${expectedType} timing evidence for ${stream.role} in ${absolutePath}.`,
          {
            diagnosticCode: "timing-evidence-mismatch",
            emittedStreamIndex: stream.streamIndex,
            role: stream.role,
          },
        );
      }
      used.add(match.index);
      const timingToleranceUs = deriveCaptureSyncSpanToleranceUs(
        match.tickUs,
        stream.timing.presentation.maximumSampleDurationUs,
      );
      if (timingToleranceUs === null) {
        throw new CliError(
          "invalid-data",
          `Finalized PTS tolerance for ${stream.role} in ${absolutePath} is outside the supported range.`,
        );
      }
      const emittedSpanUs = stream.timing.presentation.endPtsUs - stream.timing.presentation.firstPtsUs;
      const probedSpanUs = match.endPtsUs - match.firstPtsUs;
      if (Math.abs(probedSpanUs - emittedSpanUs) > timingToleranceUs) {
        throw new CliError(
          "invalid-data",
          `Finalized PTS span for ${stream.role} in ${absolutePath} disagrees with the capture helper.`,
          {
            diagnosticCode: "timing-evidence-mismatch",
            emittedSpanUs,
            probedSpanUs,
            streamIndex: match.index,
            toleranceUs: timingToleranceUs,
          },
        );
      }
      const exactIdentity = stream.trackId !== undefined && numericTrackId(match.id) === stream.trackId;
      if (!exactIdentity) {
        diagnostics.push({
          code: "ffprobe-track-id-mismatch",
          level: stream.mapping === "exact" ? "error" : "warning",
          message: `Corrected ${stream.role} from emitted index ${stream.streamIndex} to FFmpeg stream ${match.index} in ${absolutePath}.`,
        });
      }
      return {
        codec: match.codec === "unknown" ? stream.codec : match.codec,
        containerTrackIdentity: exactIdentity && match.id !== undefined
          ? { containerTrackId: match.id, kind: "verified" }
          : {
              diagnosticCode: "ffprobe-track-id-mismatch",
              expectedRole: stream.role,
              kind: "provisional",
            },
        filePresentation: {
          endPtsUs: match.endPtsUs,
          firstPtsUs: match.firstPtsUs,
          spanToleranceUs: timingToleranceUs,
          tickUs: match.tickUs,
        },
        streamIndex: match.index,
        timing: stream.timing,
      };
    });
    return { diagnostics, fileOriginPtsUs, streams: verified };
  }
}

interface CaptureBundleWriterOptions {
  readonly bundleRoot: string;
  readonly captureOptions: CaptureOptions;
  readonly configured: Extract<CaptureEvent, { readonly event: "configured" }>;
  readonly helperVersion: string;
  readonly now: () => Date;
  readonly recordingId: string;
  readonly toolVersion: string;
  readonly verifier?: CaptureMediaVerifier;
}

function initialManifest(options: CaptureBundleWriterOptions): RecordingManifestV3 {
  const timestamp = options.now().toISOString();
  return RecordingManifestV3Schema.parse({
    capture: {
      cursor: options.captureOptions.metadata ? "metadata" : "disabled",
      typedText: options.captureOptions.typedText ? "enabled" : "disabled",
      windowMetadata: options.captureOptions.metadata ? "titles-and-bounds" : "disabled",
    },
    coordinateSpace: { kind: "global-display-points", origin: "top-left", xAxis: "right", yAxis: "down" },
    createdAt: timestamp,
    diagnostics: [],
    eventStreams: [],
    interruptions: [],
    kind: "transmute.recording-bundle",
    permissions: options.configured.permissions,
    platform: {
      architecture: process.arch,
      os: process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : "unknown",
      osVersion: release(),
    },
    recordingId: options.recordingId,
    schemaVersion: 3,
    sources: options.configured.sources,
    state: "preparing",
    timeline: {
      durationUs: 0,
      nativeClock: { kind: "mach-continuous-microseconds", segments: [] },
      timebase: "microseconds",
    },
    tool: { captureVersion: options.helperVersion, name: "transmute", version: options.toolVersion },
    tracks: [],
    updatedAt: timestamp,
  });
}

function appendDiagnostic(
  manifest: RecordingManifestV3,
  diagnostic: FinalizationDiagnostic,
  sourceTimeUs: number,
): RecordingManifestV3["diagnostics"] {
  const prior = manifest.diagnostics.find(({ code, message, level }) =>
    code === diagnostic.code && message === diagnostic.message && level === diagnostic.level
  );
  if (prior === undefined) {
    return [...manifest.diagnostics, {
      code: diagnostic.code,
      count: 1,
      firstSourceTimeUs: sourceTimeUs,
      lastSourceTimeUs: sourceTimeUs,
      level: diagnostic.level,
      message: diagnostic.message.slice(0, 4_096),
    }];
  }
  return manifest.diagnostics.map((item) => item === prior
    ? { ...item, count: item.count + 1, lastSourceTimeUs: sourceTimeUs }
    : item);
}

function mergeSources(
  current: RecordingManifestV3["sources"],
  incoming: RecordingManifestV3["sources"],
): RecordingManifestV3["sources"] {
  const unique = <Item>(items: readonly Item[], key: (item: Item) => string): readonly Item[] => [
    ...new Map(items.map((item) => [key(item), item] as const)).values(),
  ];
  const displays = unique([...current.displays, ...incoming.displays], ({ displayId }) => displayId);
  const primaryDisplayId = current.displays.find(({ isPrimary }) => isPrimary)?.displayId
    ?? incoming.displays.find(({ isPrimary }) => isPrimary)?.displayId
    ?? displays[0]?.displayId;
  return {
    audio: unique([...current.audio, ...incoming.audio], ({ audioSourceId }) => audioSourceId),
    cameras: unique([...current.cameras, ...incoming.cameras], ({ cameraId }) => cameraId),
    displays: displays.map((display) => ({
      ...display,
      isPrimary: display.displayId === primaryDisplayId,
    })),
  };
}

function captureSyncPublicationViolations(
  manifest: RecordingManifestV3,
): readonly CaptureSyncPublicationViolation[] {
  return manifest.tracks.flatMap(track => track.segments.flatMap(segment => {
    if (segment.timing.kind !== "measured" || segment.timing.status !== "out-of-tolerance") return [];
    return [{
      captureSegmentIndex: segment.timing.captureSegmentIndex,
      durationDriftUs: segment.timing.durationDriftUs,
      durationDriftToleranceUs: segment.timing.tolerance.durationDriftUs,
      endUs: segment.endUs,
      kind: track.kind,
      onsetSkewUs: segment.timing.onsetSkewUs,
      onsetSkewToleranceUs: segment.timing.tolerance.onsetSkewUs,
      path: segment.path,
      segmentId: segment.segmentId,
      trackId: track.trackId,
    }];
  }));
}

function captureInterruptionDiagnostic(
  interruption: CaptureInterruption,
): FinalizationDiagnostic {
  return {
    code: `capture-interruption-${interruption.code}`.slice(0, 128),
    level: interruption.recoverable ? "warning" : "error",
    message: [
      `${interruption.source} capture interruption ${interruption.code}`,
      `closed segment ${interruption.segmentIndex} at source time`,
      `${interruption.sourceTimeUs} microseconds.`,
    ].join(" ").slice(0, 4_096),
  };
}

function sameCaptureInterruption(
  left: CaptureInterruption,
  right: CaptureInterruption,
): boolean {
  return left.code === right.code
    && left.nativeTimeUs === right.nativeTimeUs
    && left.recoverable === right.recoverable
    && left.segmentIndex === right.segmentIndex
    && left.source === right.source
    && left.sourceId === right.sourceId
    && left.sourceTimeUs === right.sourceTimeUs;
}

function failedSegmentPublicationDiagnostic(
  segment: SegmentCompletion,
  failure: unknown,
): FinalizationDiagnostic {
  const failureKind = failure instanceof CliError ? failure.code : "internal";
  return {
    code: "capture-segment-publication-failed",
    level: "error",
    message: [
      `Capture segment ${segment.index} completed at source time`,
      `${segment.clock.end.sourceTimeUs} microseconds, but its outputs were not admitted`,
      `because ${failureKind} finalization verification failed.`,
    ].join(" "),
  };
}

function sameCaptureClockSegment(
  left: RecordingManifestV3["timeline"]["nativeClock"]["segments"][number],
  right: RecordingManifestV3["timeline"]["nativeClock"]["segments"][number],
): boolean {
  return left.index === right.index
    && left.nativeRange.endUs === right.nativeRange.endUs
    && left.nativeRange.startUs === right.nativeRange.startUs
    && left.sourceRange.endUs === right.sourceRange.endUs
    && left.sourceRange.startUs === right.sourceRange.startUs;
}

export class CaptureBundleWriter {
  readonly #bundleRoot: string;
  readonly #fileSystem: BundleFileSystem;
  readonly #now: () => Date;
  readonly #verifier: CaptureMediaVerifier;
  #manifest: RecordingManifestV3;

  constructor(options: CaptureBundleWriterOptions) {
    this.#bundleRoot = options.bundleRoot;
    this.#fileSystem = createNodeBundleFileSystem(options.bundleRoot);
    this.#now = options.now;
    this.#verifier = options.verifier ?? new CaptureMediaVerifier();
    this.#manifest = initialManifest(options);
  }

  get manifest(): RecordingManifestV3 {
    return this.#manifest;
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#bundleRoot);
    await saveRecordingManifest(this.#fileSystem, this.#manifest);
  }

  async setCaptureEnvironment(
    permissions: RecordingManifestV3["permissions"],
    sources: RecordingManifestV3["sources"],
  ): Promise<void> {
    const nextSources = this.#manifest.timeline.nativeClock.segments.length === 0
      ? sources
      : mergeSources(this.#manifest.sources, sources);
    this.#manifest = RecordingManifestV3Schema.parse({
      ...this.#manifest,
      permissions,
      sources: nextSources,
      updatedAt: this.#now().toISOString(),
    });
    await saveRecordingManifest(this.#fileSystem, this.#manifest);
  }

  async setState(state: RecordingManifestV3["state"], durationUs?: number): Promise<void> {
    const nextDurationUs = durationUs ?? this.#manifest.timeline.durationUs;
    if (state === "stopped") {
      const violations = captureSyncPublicationViolations(this.#manifest);
      if (violations.length > 0) {
        const first = violations[0]!;
        const message = [
          `Recording publication rejected because ${violations.length} stream segment(s) exceeded capture synchronization tolerance.`,
          `First: ${first.kind} ${first.segmentId} (onset ${first.onsetSkewUs}/${first.onsetSkewToleranceUs} us,`,
          `duration drift ${first.durationDriftUs}/${first.durationDriftToleranceUs} us).`,
        ].join(" ");
        const diagnostics = appendDiagnostic(this.#manifest, {
          code: "capture-sync-publication-rejected",
          level: "error",
          message,
        }, violations.reduce((latest, violation) => Math.max(latest, violation.endUs), 0));
        this.#manifest = RecordingManifestV3Schema.parse({
          ...this.#manifest,
          diagnostics,
          state: "failed",
          timeline: {
            ...this.#manifest.timeline,
            durationUs: nextDurationUs,
          },
          updatedAt: this.#now().toISOString(),
        });
        await saveRecordingManifest(this.#fileSystem, this.#manifest);
        throw new CliError("invalid-data", message, {
          diagnosticCode: "capture-sync-publication-rejected",
          violationCount: violations.length,
          violations: violations.slice(0, MAX_CAPTURE_SYNC_PUBLICATION_VIOLATIONS),
        });
      }
    }
    this.#manifest = RecordingManifestV3Schema.parse({
      ...this.#manifest,
      state,
      timeline: {
        ...this.#manifest.timeline,
        durationUs: nextDurationUs,
      },
      updatedAt: this.#now().toISOString(),
    });
    await saveRecordingManifest(this.#fileSystem, this.#manifest);
  }

  async appendSegment(
    segment: SegmentCompletion,
    interruption: CaptureInterruption | null,
  ): Promise<void> {
    let diagnostics = this.#manifest.diagnostics;
    const tracks = [...this.#manifest.tracks];
    const eventStreams = [...this.#manifest.eventStreams];
    const seenAudio = new Set<"microphone-audio" | "system-audio">();
    const segmentStartUs = segment.clock.start.sourceTimeUs;
    const segmentEndUs = segment.clock.end.sourceTimeUs;
    const primaryDisplay = segment.displays.find(({ display }) => display.isPrimary);
    const referenceStream = primaryDisplay?.streams.find(({ role }) => role === "display-video");
    const referenceTiming = referenceStream?.timing;
    if (primaryDisplay === undefined || referenceStream === undefined || referenceTiming === undefined) {
      throw new CliError("invalid-data", `Capture segment ${segment.index} has no primary display timing reference.`);
    }
    const referenceTrackId = TrackIdSchema.parse(opaque(
      "track",
      `display-video:${JSON.stringify({ displayId: primaryDisplay.display.displayId })}`,
    ));

    const addMedia = async (
      path: string,
      container: string,
      streams: readonly SegmentCompletion["displays"][number]["streams"][number][],
      source: { readonly displayId: string } | { readonly cameraId: string } | null,
      label: string,
      containerDurationUs: number,
      origin: "camera" | "display" | "microphone",
    ): Promise<void> => {
      const absolute = await resolveSafePath(this.#bundleRoot, path);
      const [fileIntegrity, verification] = await Promise.all([
        integrity(absolute),
        this.#verifier.verify(absolute, streams),
      ]);
      for (const diagnostic of verification.diagnostics) {
        diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, diagnostic, segmentEndUs);
      }
      if (verification.streams.every(stream => stream === null)) {
        throw new CliError("invalid-data", `Capture output ${path} has no verified media stream timing.`);
      }
      const fileOriginPtsUs = verification.fileOriginPtsUs;
      for (let index = 0; index < streams.length; index += 1) {
        const emitted = streams[index]!;
        const verified = verification.streams[index];
        if (verified === undefined || verified === null || emitted.role === "unclassified-audio") continue;
        const roleMatchesOrigin = origin === "display"
          ? emitted.role === "display-video" || emitted.role === "system-audio"
          : origin === "camera"
            ? emitted.role === "camera-video"
            : emitted.role === "microphone-audio";
        if (!roleMatchesOrigin) {
          diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
            code: "capture-role-origin-mismatch",
            level: "error",
            message: `Ignored ${emitted.role} from ${origin} output ${path}.`,
          }, segmentEndUs);
          continue;
        }
        if ((emitted.role === "system-audio" || emitted.role === "microphone-audio") && seenAudio.has(emitted.role)) continue;
        if (emitted.role === "system-audio" || emitted.role === "microphone-audio") seenAudio.add(emitted.role);
        const trackSource = emitted.role === "display-video"
          ? source !== null && "displayId" in source
            ? source
            : (() => { throw new CliError("internal", `Display output ${path} has no display source.`); })()
          : emitted.role === "camera-video"
            ? source !== null && "cameraId" in source
              ? source
              : (() => { throw new CliError("internal", `Camera output ${path} has no camera source.`); })()
            : {
                audioSourceId: this.#manifest.sources.audio.find(({ kind }) =>
                  kind === (emitted.role === "system-audio" ? "system" : "microphone")
                )?.audioSourceId
                  ?? segment.sources.audio.find(({ kind }) =>
                    kind === (emitted.role === "system-audio" ? "system" : "microphone")
                  )?.audioSourceId
                  ?? `missing-${emitted.role}`,
              };
        const key = `${emitted.role}:${JSON.stringify(trackSource)}`;
        const trackId = TrackIdSchema.parse(opaque("track", key));
        const helperNativeStartUs = verified.timing.clockAnchors.first.nativeTimeUs;
        const helperNativeEndUs = verified.timing.clockAnchors.end.nativeTimeUs;
        const referenceNativeDurationUs = referenceTiming.clockAnchors.end.nativeTimeUs
          - referenceTiming.clockAnchors.first.nativeTimeUs;
        const placement = deriveCaptureSyncPlacement({
          clockNativeStartUs: segment.clock.start.nativeTimeUs,
          clockSourceEndUs: segmentEndUs,
          clockSourceStartUs: segmentStartUs,
          fileContainerOriginPtsUs: fileOriginPtsUs,
          fileEndPtsUs: verified.filePresentation.endPtsUs,
          fileFirstPtsUs: verified.filePresentation.firstPtsUs,
          helperNativeStartUs,
        });
        if (placement === null) {
          throw new CliError(
            "invalid-data",
            `Capture timing for ${emitted.role} in ${path} does not overlap segment ${segment.index}.`,
          );
        }
        const {
          endUs,
          fileRangeEndUs,
          fileRangeStartUs,
          rawEndUs,
          rawStartUs,
          startUs,
        } = placement;
        const onsetSkewUs = helperNativeStartUs
          - referenceTiming.clockAnchors.first.nativeTimeUs;
        const endSkewUs = helperNativeEndUs - referenceTiming.clockAnchors.end.nativeTimeUs;
        const durationDriftUs = endSkewUs - onsetSkewUs;
        const durationDriftPpm = deriveCaptureSyncDurationDriftPpm(
          durationDriftUs,
          referenceNativeDurationUs,
        );
        const tolerances = deriveCaptureSyncTolerances({
          referenceDurationUs: referenceNativeDurationUs,
          referenceEndUncertaintyUs: referenceTiming.clockAnchors.end.uncertaintyUs,
          referenceFirstUncertaintyUs: referenceTiming.clockAnchors.first.uncertaintyUs,
          referenceMaximumSampleDurationUs: referenceTiming.presentation.maximumSampleDurationUs,
          subjectEndUncertaintyUs: verified.timing.clockAnchors.end.uncertaintyUs,
          subjectFirstUncertaintyUs: verified.timing.clockAnchors.first.uncertaintyUs,
          subjectMaximumSampleDurationUs: verified.timing.presentation.maximumSampleDurationUs,
        });
        if (durationDriftPpm === null || tolerances === null) {
          throw new CliError(
            "invalid-data",
            `Capture synchronization policy for ${emitted.role} in ${path} exceeds the supported range.`,
          );
        }
        const {
          durationDriftUs: durationDriftToleranceUs,
          onsetSkewUs: onsetToleranceUs,
        } = tolerances;
        const status = Math.abs(onsetSkewUs) > onsetToleranceUs
          || Math.abs(durationDriftUs) > durationDriftToleranceUs
          ? "out-of-tolerance"
          : "within-tolerance";
        if (startUs !== rawStartUs || endUs !== rawEndUs) {
          diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
            code: "capture-track-trimmed-to-segment",
            level: "warning",
            message: `Trimmed ${emitted.role} in ${path} to segment ${segment.index}'s native-clock range.`,
          }, startUs);
        }
        if (Math.abs(onsetSkewUs) > onsetToleranceUs) {
          diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
            code: "capture-track-onset-skew",
            level: "warning",
            message: `${emitted.role} in ${path} starts ${onsetSkewUs} microseconds from the primary-display reference.`,
          }, startUs);
        }
        if (Math.abs(durationDriftUs) > durationDriftToleranceUs) {
          diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
            code: "capture-track-duration-drift",
            level: "warning",
            message: `${emitted.role} in ${path} drifted ${durationDriftUs} microseconds against the native capture clock.`,
          }, endUs);
        }
        const mediaSegment = MediaSegmentSchema.parse({
          codec: verified.codec,
          container,
          containerTrackIdentity: verified.containerTrackIdentity,
          endUs,
          fileRange: {
            endUs: fileRangeEndUs,
            startUs: fileRangeStartUs,
          },
          integrity: fileIntegrity,
          path,
          segmentId: opaque("segment", `${trackId}:${segment.index}:${path}:${verified.streamIndex}`),
          startUs,
          streamIndex: verified.streamIndex,
          timing: {
            captureSegmentIndex: segment.index,
            durationDriftPpm,
            durationDriftUs,
            evidence: {
              file: {
                containerOriginPtsUs: fileOriginPtsUs,
                endPtsUs: verified.filePresentation.endPtsUs,
                firstPtsUs: verified.filePresentation.firstPtsUs,
                spanToleranceUs: verified.filePresentation.spanToleranceUs,
                tickUs: verified.filePresentation.tickUs,
              },
              helper: {
                ...verified.timing,
                containerDurationUs,
              },
            },
            kind: "measured",
            nativeRange: {
              endUs: helperNativeEndUs,
              startUs: helperNativeStartUs,
            },
            onsetSkewUs,
            policy: "capture-sync-v1",
            presentation: {
              endPtsUs: verified.timing.presentation.endPtsUs,
              firstPtsUs: verified.timing.presentation.firstPtsUs,
              lastPtsUs: verified.timing.presentation.lastPtsUs,
            },
            referenceTrackId,
            status,
            tolerance: {
              durationDriftUs: durationDriftToleranceUs,
              onsetSkewUs: onsetToleranceUs,
            },
          },
        });
        const priorIndex = tracks.findIndex(({ trackId: candidate }) => candidate === trackId);
        if (priorIndex === -1) {
          tracks.push(LogicalTrackSchema.parse({
            enabled: true,
            kind: emitted.role,
            label: emitted.role === "display-video" || emitted.role === "camera-video" ? label : emitted.role,
            segments: [mediaSegment],
            source: trackSource,
            trackId,
          }));
        } else {
          const prior = tracks[priorIndex]!;
          tracks[priorIndex] = { ...prior, segments: [...prior.segments, mediaSegment] };
        }
      }
    };

    const sources = mergeSources(this.#manifest.sources, segment.sources);
    for (const display of [...segment.displays].sort((left, right) => Number(right.display.isPrimary) - Number(left.display.isPrimary))) {
      const inventory = sources.displays.find(({ displayId }) => displayId === display.display.displayId);
      await addMedia(
        display.path,
        display.container,
        display.streams,
        { displayId: display.display.displayId },
        inventory?.label ?? display.display.displayId,
        display.containerDurationUs,
        "display",
      );
    }
    if (segment.camera.availability === "recorded") {
      const cameraRecording = segment.camera;
      const camera = sources.cameras.find(({ cameraId }) => cameraId === cameraRecording.deviceId);
      await addMedia(
        cameraRecording.path,
        cameraRecording.container,
        cameraRecording.streams,
        { cameraId: cameraRecording.deviceId },
        camera?.label ?? cameraRecording.label,
        cameraRecording.containerDurationUs,
        "camera",
      );
    } else if (segment.camera.reason !== "disabled") {
      diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
        code: `camera-${segment.camera.reason}`,
        level: segment.camera.reason.endsWith("failed") ? "error" : "warning",
        message: `Camera was unavailable for segment ${segment.index}: ${segment.camera.reason}.`,
      }, segmentEndUs);
    }
    if (segment.microphone.availability === "recorded") {
      const microphoneRecording = segment.microphone;
      const microphone = sources.audio.find(({ kind }) => kind === "microphone");
      await addMedia(
        microphoneRecording.path,
        microphoneRecording.container,
        microphoneRecording.streams,
        null,
        microphone?.label ?? microphoneRecording.label,
        microphoneRecording.containerDurationUs,
        "microphone",
      );
    } else if (segment.microphone.reason !== "disabled") {
      diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
        code: `microphone-${segment.microphone.reason}`,
        level: segment.microphone.reason.endsWith("failed") ? "error" : "warning",
        message: `Microphone was unavailable for segment ${segment.index}: ${segment.microphone.reason}.`,
      }, segmentEndUs);
    }
    for (const metadata of segment.metadata) {
      const absolute = await resolveSafePath(this.#bundleRoot, metadata.path);
      eventStreams.push(EventStreamReferenceSchema.parse({
        endUs: segmentEndUs,
        eventKinds: metadata.eventKinds,
        eventStreamId: opaque("event", `${segment.index}:${metadata.path}`),
        integrity: await integrity(absolute),
        path: metadata.path,
        recordCount: metadata.recordCount,
        startUs: segmentStartUs,
      }));
      if (metadata.droppedEvents > 0) {
        diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
          code: "metadata-dropped-events",
          level: "warning",
          message: `${metadata.droppedEvents} metadata event(s) were dropped in ${metadata.path}.`,
        }, segmentEndUs);
      }
    }
    for (const diagnostic of segment.diagnostics) {
      diagnostics = appendDiagnostic({ ...this.#manifest, diagnostics }, {
        code: diagnostic.code,
        level: diagnostic.recoverable ? "warning" : "error",
        message: `${diagnostic.source}: ${diagnostic.message}`,
      }, segmentEndUs);
    }
    if (interruption !== null) {
      diagnostics = appendDiagnostic(
        { ...this.#manifest, diagnostics },
        captureInterruptionDiagnostic(interruption),
        interruption.sourceTimeUs,
      );
    }
    const nextManifest = RecordingManifestV3Schema.parse({
      ...this.#manifest,
      diagnostics,
      eventStreams,
      interruptions: interruption === null
        ? this.#manifest.interruptions
        : [...this.#manifest.interruptions, interruption],
      sources,
      timeline: {
        durationUs: Math.max(this.#manifest.timeline.durationUs, segmentEndUs),
        nativeClock: {
          kind: "mach-continuous-microseconds",
          segments: [
            ...this.#manifest.timeline.nativeClock.segments,
            {
              index: segment.index,
              nativeRange: {
                endUs: segment.clock.end.nativeTimeUs,
                startUs: segment.clock.start.nativeTimeUs,
              },
              sourceRange: {
                endUs: segmentEndUs,
                startUs: segmentStartUs,
              },
            },
          ],
        },
        timebase: "microseconds",
      },
      tracks,
      updatedAt: this.#now().toISOString(),
    });
    await saveRecordingManifest(this.#fileSystem, nextManifest);
    this.#manifest = nextManifest;
  }

  async recordFailedSegmentCompletion(
    segment: SegmentCompletion,
    interruption: CaptureInterruption | null,
    failure: unknown,
  ): Promise<void> {
    const clockSegment = {
      index: segment.index,
      nativeRange: {
        endUs: segment.clock.end.nativeTimeUs,
        startUs: segment.clock.start.nativeTimeUs,
      },
      sourceRange: {
        endUs: segment.clock.end.sourceTimeUs,
        startUs: segment.clock.start.sourceTimeUs,
      },
    } as const;
    const existingClock = this.#manifest.timeline.nativeClock.segments.find(
      candidate => candidate.index === segment.index,
    );
    if (
      existingClock !== undefined
      && !sameCaptureClockSegment(existingClock, clockSegment)
    ) {
      throw new CliError(
        "invalid-data",
        `Capture segment ${segment.index} emitted conflicting completion-clock evidence.`,
      );
    }

    const existingInterruption = interruption === null
      ? undefined
      : this.#manifest.interruptions.find(
          candidate => candidate.segmentIndex === interruption.segmentIndex,
        );
    if (
      interruption !== null
      && existingInterruption !== undefined
      && !sameCaptureInterruption(existingInterruption, interruption)
    ) {
      throw new CliError(
        "invalid-data",
        `Capture segment ${interruption.segmentIndex} emitted conflicting interruption evidence.`,
      );
    }

    let diagnostics = this.#manifest.diagnostics;
    if (interruption !== null && existingInterruption === undefined) {
      diagnostics = appendDiagnostic(
        { ...this.#manifest, diagnostics },
        captureInterruptionDiagnostic(interruption),
        interruption.sourceTimeUs,
      );
    }
    const publicationFailure = failedSegmentPublicationDiagnostic(segment, failure);
    const publicationFailureExists = diagnostics.some(({ code, level, message }) =>
      code === publicationFailure.code
      && level === publicationFailure.level
      && message === publicationFailure.message
    );
    if (!publicationFailureExists) {
      diagnostics = appendDiagnostic(
        { ...this.#manifest, diagnostics },
        publicationFailure,
        segment.clock.end.sourceTimeUs,
      );
    }

    const nextManifest = RecordingManifestV3Schema.parse({
      ...this.#manifest,
      diagnostics,
      interruptions: interruption !== null && existingInterruption === undefined
        ? [...this.#manifest.interruptions, interruption]
        : this.#manifest.interruptions,
      sources: mergeSources(this.#manifest.sources, segment.sources),
      state: "failed",
      timeline: {
        ...this.#manifest.timeline,
        durationUs: Math.max(
          this.#manifest.timeline.durationUs,
          segment.clock.end.sourceTimeUs,
        ),
        nativeClock: {
          ...this.#manifest.timeline.nativeClock,
          segments: existingClock === undefined
            ? [...this.#manifest.timeline.nativeClock.segments, clockSegment]
            : this.#manifest.timeline.nativeClock.segments,
        },
      },
      updatedAt: this.#now().toISOString(),
    });
    await saveRecordingManifest(this.#fileSystem, nextManifest);
    this.#manifest = nextManifest;
  }

  async recordFailureInterruption(
    interruption: CaptureInterruption,
  ): Promise<void> {
    const existing = this.#manifest.interruptions.find(
      candidate => candidate.segmentIndex === interruption.segmentIndex,
    );
    if (
      existing !== undefined
      && !sameCaptureInterruption(existing, interruption)
    ) {
      throw new CliError(
        "invalid-data",
        `Capture segment ${interruption.segmentIndex} emitted conflicting interruption evidence.`,
      );
    }
    const diagnostics = existing === undefined
      ? appendDiagnostic(
          this.#manifest,
          captureInterruptionDiagnostic(interruption),
          interruption.sourceTimeUs,
        )
      : this.#manifest.diagnostics;
    this.#manifest = RecordingManifestV3Schema.parse({
      ...this.#manifest,
      diagnostics,
      interruptions: existing === undefined
        ? [...this.#manifest.interruptions, interruption]
        : this.#manifest.interruptions,
      state: "failed",
      updatedAt: this.#now().toISOString(),
    });
    await saveRecordingManifest(this.#fileSystem, this.#manifest);
  }
}
