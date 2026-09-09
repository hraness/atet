import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot";
import { spatialOutputDuration } from "../../../src/spatial-scene/time";
import { SPATIAL_COMPOSITOR_LIMITS, SpatialCompositorTimingVerificationV1Schema, SpatialCompositorVideoProfileSchema, type SpatialCompositorVideoProfile } from "../contracts/spatial-compositor";
import { assertSpatialCompositorCadence } from "../core/spatial-compositor";
import type { ProcessRunner } from "./io";

const unsigned = z.string().regex(/^(?:0|[1-9][0-9]{0,24})$/u);
const fraction = z.string().regex(/^[1-9][0-9]{0,12}\/[1-9][0-9]{0,12}$/u);
const StreamSchema = z.object({
  codec_type: z.enum(["video", "audio"]), codec_name: z.string().max(80),
  time_base: fraction, start_pts: z.number().int().safe(), duration_ts: z.number().int().safe().positive(),
  avg_frame_rate: z.string().max(40).optional(), r_frame_rate: z.string().max(40).optional(),
  nb_frames: unsigned.optional(), nb_read_frames: unsigned.optional(), sample_rate: unsigned.optional(),
  width: z.number().int().positive().max(16_384).optional(), height: z.number().int().positive().max(16_384).optional(),
  pix_fmt: z.string().max(80).optional(),
});
const ProbeSchema = z.object({
  streams: z.array(StreamSchema).length(1),
  frames: z.array(z.object({ best_effort_timestamp: z.number().int().safe().min(0) })).max(SPATIAL_COMPOSITOR_LIMITS.frames).optional(),
});
function ratio(value: string): readonly [bigint, bigint] {
  if (!fraction.safeParse(value).success) throw new Error("Native stream contains an invalid positive rational.");
  const parts = value.split("/");
  return [BigInt(parts[0]!), BigInt(parts[1]!)];
}
function equalRatio(value: string | undefined, n: bigint, d: bigint): boolean {
  if (value === undefined) return false;
  const [pn, pd] = ratio(value);
  return pn * d === n * pd;
}

function videoProfile(input: unknown): SpatialCompositorVideoProfile {
  return SpatialCompositorVideoProfileSchema.parse(createBoundedJsonValueSnapshot(input, 4096, "expected compositor video profile", { maximumDepth: 4, maximumValues: 20 }).value);
}
function probeValue(input: unknown, maximumBytes: number) {
  return createBoundedJsonValueSnapshot(input, maximumBytes, "compositor probe", { maximumDepth: 8, maximumValues: SPATIAL_COMPOSITOR_LIMITS.frames * 2 + 100 }).value;
}

/** Exact output geometry and integer timing oracle; decimal display timestamps are never authoritative. */
export function verifySpatialCompositorProbe(input: { readonly cadence: unknown; readonly expectedVideo: SpatialCompositorVideoProfile; readonly video: unknown; readonly audio: unknown }) {
  const binding = assertSpatialCompositorCadence(input.cadence);
  const expectedVideo = videoProfile(input.expectedVideo);
  const video = ProbeSchema.parse(probeValue(input.video, SPATIAL_COMPOSITOR_LIMITS.probeBytes)), audio = ProbeSchema.parse(probeValue(input.audio, 64 * 1024));
  const stream = video.streams[0]!, sound = audio.streams[0]!;
  if (stream.width !== expectedVideo.pixelWidth || stream.height !== expectedVideo.pixelHeight || stream.pix_fmt !== expectedVideo.pixelFormat) {
    throw new Error("Encoded compositor video dimensions or pixel format differ from the exact output profile.");
  }
  const measuredVideo = SpatialCompositorVideoProfileSchema.parse({ pixelWidth: stream.width, pixelHeight: stream.height, pixelFormat: stream.pix_fmt });
  const rate = binding.cadence.frameRate, n = BigInt(rate.numerator), d = BigInt(rate.denominator);
  const count = BigInt(binding.cadence.frameCount);
  const [tn, td] = ratio(stream.time_base);
  const stepNumerator = d * td, stepDenominator = n * tn;
  if (stream.codec_type !== "video" || stream.codec_name !== "h264"
    || stream.start_pts !== 0 || !equalRatio(stream.avg_frame_rate, n, d) || !equalRatio(stream.r_frame_rate, n, d)
    || stream.nb_frames === undefined || BigInt(stream.nb_frames) !== count
    || stream.nb_read_frames === undefined || BigInt(stream.nb_read_frames) !== count
    || stepNumerator % stepDenominator !== 0n
    || video.frames === undefined || video.frames.length !== binding.cadence.frameCount) throw new Error("Encoded compositor video does not match the exact rational cadence and frame count.");
  const step = stepNumerator / stepDenominator;
  for (let index = 0; index < video.frames.length; index++) {
    if (BigInt(video.frames[index]!.best_effort_timestamp) !== BigInt(index) * step) throw new Error(`Encoded compositor video has an incorrect presentation timestamp at frame ${index}.`);
  }
  if (BigInt(stream.duration_ts) !== count * step) throw new Error("Encoded compositor duration does not match the half-open sample count.");
  // AAC padding is represented by the MP4 edit list: its stream duration must
  // retain the complete authored audio timeline to within one 48-kHz sample.
  const audioDelta = BigInt(sound.duration_ts) * 1_000_000n - BigInt(binding.cadence.durationUs) * 48_000n;
  if (sound.codec_type !== "audio" || sound.codec_name !== "aac" || sound.sample_rate !== "48000"
    || sound.time_base !== "1/48000" || sound.start_pts !== 0 || audioDelta < -1_000_000n || audioDelta > 1_000_000n) throw new Error("Encoded compositor audio was truncated or changed from the authored duration.");
  return deepFreezeJson(SpatialCompositorTimingVerificationV1Schema.parse({
    kind: "atet.spatial-compositor-timing-verification", schemaVersion: 1, cadenceSha256: binding.cadenceSha256,
    profile: "mp4-h264-cfr-integer-pts-v1", video: measuredVideo, frameRate: rate, frameCount: binding.cadence.frameCount,
    timeBase: { numerator: String(tn), denominator: String(td) }, firstPts: "0", lastPts: String((count - 1n) * step),
    stepPts: String(step), durationTs: String(stream.duration_ts), authoredDurationUs: binding.cadence.durationUs,
    encodedVideoDurationUs: spatialOutputDuration(binding.cadence.durationUs, rate),
    audio: { sampleRate: 48_000, timeBase: "1/48000", durationTs: String(sound.duration_ts), durationToleranceSamples: 1 },
  }));
}

const SNAPSHOT_FIELDS = ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks", "mtimeNs", "ctimeNs", "birthtimeNs"] as const;
function changedFields(expected: BigIntStats, actual: BigIntStats): readonly string[] {
  return SNAPSHOT_FIELDS.filter(field => expected[field] !== actual[field]);
}
function assertSnapshot(expected: BigIntStats, actual: BigIntStats, phase: string, allowCtime: boolean): boolean {
  const changes = changedFields(expected, actual);
  if (!actual.isFile() || actual.isSymbolicLink() || changes.some(field => !allowCtime || field !== "ctimeNs")) {
    throw new Error(`Compositor output changed ${phase} (fields: ${changes.join(", ") || "file type"}).`);
  }
  return changes.length > 0;
}
function aggregateFailure(label: string, failures: readonly unknown[]): AggregateError {
  const reasons = failures.map(reason => {
    try { return (reason instanceof Error ? reason.message : String(reason)).slice(0, 1800); }
    catch { return "Unreadable native rejection."; }
  });
  return new AggregateError(failures, `${label}: ${reasons.join("; ").slice(0, 3800)}`);
}
async function withPinnedFile<T>(path: string, work: (descriptor: FileHandle) => Promise<T>): Promise<T> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const result = await Promise.resolve().then(async () => await work(descriptor)).then(
    value => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  try { await descriptor.close(); }
  catch (cause) {
    if (result.status === "rejected") throw aggregateFailure("Compositor verification and descriptor cleanup failed", [result.reason, cause]);
    throw cause;
  }
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

/** Pinned byte identity and at most one conditional, read-only probe revalidation. */
export async function verifySpatialCompositorOutput(input: {
  readonly cadence: unknown;
  readonly expectedVideo: SpatialCompositorVideoProfile;
  readonly outputPath: string;
  readonly maximumBytes: number;
  readonly ffprobe: string;
  readonly runner: ProcessRunner;
  readonly signal: AbortSignal;
}) {
  const cadence = assertSpatialCompositorCadence(input.cadence);
  const expectedVideo = videoProfile(input.expectedVideo);
  if (!isAbsolute(input.outputPath) || !isAbsolute(input.ffprobe)
    || !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0 || input.maximumBytes > SPATIAL_COMPOSITOR_LIMITS.outputBytes) throw new Error("Compositor verification requires bounded host-owned absolute paths.");
  const deadline = Date.now() + SPATIAL_COMPOSITOR_LIMITS.timeoutMs;
  const checkControl = () => {
    input.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Compositor timing verification exceeded its bounded deadline.");
  };
  checkControl();
  const expected = await lstat(input.outputPath, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size <= 0n || expected.size > BigInt(input.maximumBytes)) throw new Error("Compositor output is not a bounded physical file.");
  return await withPinnedFile(input.outputPath, async identityDescriptor => {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const hashIdentity = async (snapshot: BigIntStats, allowCtime: boolean) => {
      checkControl();
      const before = await identityDescriptor.stat({ bigint: true });
      let metadataChanged = assertSnapshot(snapshot, before, "before byte verification", allowCtime);
      const hash = createHash("sha256");
      let bytes = 0;
      const expectedBytes = Number(expected.size);
      while (true) {
        checkControl();
        const read = await identityDescriptor.read(buffer, 0, Math.min(buffer.byteLength, expectedBytes - bytes + 1), bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > expectedBytes) throw new Error("Compositor output changed during byte verification (fields: size).");
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await identityDescriptor.stat({ bigint: true });
      const retained = await lstat(input.outputPath, { bigint: true });
      metadataChanged = assertSnapshot(before, after, "during byte verification", allowCtime) || metadataChanged;
      metadataChanged = assertSnapshot(after, retained, "at byte-verification path readback", allowCtime) || metadataChanged;
      if (bytes !== expectedBytes) throw new Error("Compositor output changed during byte verification (fields: size).");
      checkControl();
      return { metadataChanged, sha256: hash.digest("hex"), snapshot: retained };
    };
    let baseline = await hashIdentity(expected, true);
    const originalDigest = baseline.sha256;
    if (baseline.metadataChanged) {
      baseline = await hashIdentity(baseline.snapshot, false);
      if (baseline.sha256 !== originalDigest) throw new Error("Compositor output bytes changed while establishing timing-verification identity.");
    }
    const probe = async (kind: "video" | "audio", snapshot: BigIntStats, allowCtime: boolean) => await withPinnedFile(input.outputPath, async descriptor => {
      checkControl();
      const before = await descriptor.stat({ bigint: true });
      let metadataChanged = assertSnapshot(snapshot, before, `before ${kind} timing verification`, allowCtime);
      const entries = kind === "video"
        ? "stream=codec_type,codec_name,width,height,pix_fmt,time_base,start_pts,duration_ts,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames:frame=best_effort_timestamp:frame_side_data="
        : "stream=codec_type,codec_name,time_base,start_pts,duration_ts,sample_rate";
      const result = await input.runner.run([input.ffprobe,
        "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov",
        "-enable_drefs", "0", "-use_absolute_path", "0", "-select_streams", kind === "video" ? "v:0" : "a:0",
        ...(kind === "video" ? ["-count_frames", "-show_frames"] : []),
        "-show_streams", "-show_entries", entries, "-of", "json", "/dev/fd/3",
      ], { inheritedFileDescriptors: [descriptor.fd], abortSignal: input.signal, timeoutMs: Math.max(1, deadline - Date.now()),
        maxOutputBytes: kind === "video" ? SPATIAL_COMPOSITOR_LIMITS.probeBytes : 64 * 1024, stdin: "ignore" });
      if (result.exitCode !== 0) throw new Error(`Compositor ${kind} timing verification failed: ${result.stderr.slice(-4096)}`);
      checkControl();
      const after = await descriptor.stat({ bigint: true });
      metadataChanged = assertSnapshot(before, after, `during ${kind} timing verification`, allowCtime) || metadataChanged;
      if (Buffer.byteLength(result.stdout) >= (kind === "video" ? SPATIAL_COMPOSITOR_LIMITS.probeBytes : 64 * 1024)) throw new Error("Compositor timing probe exceeded the bounded response limit.");
      return { metadataChanged, value: JSON.parse(result.stdout) as unknown };
    });
    for (const attempt of [1, 2] as const) {
      // A failed sibling must settle before descriptors or the workspace close.
      const results = await Promise.allSettled([probe("video", baseline.snapshot, attempt === 1), probe("audio", baseline.snapshot, attempt === 1)]);
      const failed = results.filter(result => result.status === "rejected");
      if (failed.length > 0) throw aggregateFailure("Compositor native verification failed", failed.map(result => result.reason));
      const video = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof probe>>>).value;
      const audio = (results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof probe>>>).value;
      // Native, schema, or semantic failures never authorize another probe.
      const verified = verifySpatialCompositorProbe({ cadence, expectedVideo, video: video.value, audio: audio.value });
      const after = await hashIdentity(baseline.snapshot, attempt === 1);
      if (after.sha256 !== originalDigest) throw new Error("Compositor output bytes changed during timing verification.");
      if (!video.metadataChanged && !audio.metadataChanged && !after.metadataChanged) return verified;
      // Equal endpoint hashes do not prove what a probe saw during a mutable
      // interval. Discard those results and certify one fresh pair only after
      // an identical digest has been re-established in a stable snapshot.
      baseline = await hashIdentity(after.snapshot, false);
      if (baseline.sha256 !== originalDigest) throw new Error("Compositor output bytes changed before conditional timing revalidation.");
    }
    throw new Error("Compositor output did not remain stable during timing revalidation.");
  });
}
