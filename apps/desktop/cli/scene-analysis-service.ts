import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { z } from "zod";
import {
  SCENE_AI_SDK_VERSION,
  SCENE_PROMPT_SHA256,
  SCENE_PROMPT_VERSION,
  SCENE_UPLOAD_POLICY,
  SceneProviderError,
  type SceneDescriptionProvider,
  type SceneProviderResult,
} from "@hraness/atet/scene";

import {
  AnalysisSubjectSchema,
  RepositoryRelativePathSchema,
  SceneBatchSchema,
  SceneDescriptionSchema,
  SceneIdSchema,
  SceneAnalysisV1Schema,
  Sha256Schema,
  type AnalysisSubject,
  type ProjectAssetV1,
  type SceneAnalysisV1,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  createNodeBundleFileSystem,
  deduplicateFrameFingerprints,
  differenceHash64,
  planSceneBatches,
  planSceneSampling,
  reusableSceneBatchCacheEntry,
  sceneBatchCacheKey,
  transitionSceneBatch,
  type PlannedSceneSample,
  type SceneBoundaryCandidate,
  type SceneSamplingPlan,
} from "../core";
import { CliError } from "./errors";
import { mapBounded } from "./bounded-map";
import type { ProcessRunner } from "./io";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";

type VideoStream = Extract<ProjectAssetV1["streams"][number], { readonly kind: "video" }>;
type VideoSegment = VideoStream["segments"][number];

export const MAXIMUM_SCENE_SAMPLES = 20_000;
const MAXIMUM_FRAME_BYTES = 2_000_000;
const MAXIMUM_DETECTION_OUTPUT_BYTES = 8_000_000;
const MAXIMUM_SCENE_CACHE_BYTES = 256_000;
const INITIAL_FRAME_LOOKBACK_US = 250_000;
const MAXIMUM_FRAME_DISCOVERY_ATTEMPTS = 64;
export const SCENE_EXTRACTION_CONCURRENCY = 4;

const CachedSceneProviderResultSchema = z.strictObject({
  descriptions: z.array(z.strictObject({
    description: SceneDescriptionSchema,
    sceneId: SceneIdSchema,
  })).min(1).max(4),
  resolvedModel: z.string().min(1).max(256).nullable(),
});

const SceneBatchCacheFileSchema = z.strictObject({
  entry: z.strictObject({
    batchKey: Sha256Schema,
    payloadSha256: Sha256Schema,
    schemaVersion: z.literal(1),
    state: z.literal("complete"),
  }),
  result: CachedSceneProviderResultSchema,
});

type CachedSceneProviderResult = Pick<SceneProviderResult, "descriptions" | "resolvedModel">;

export interface ResolvedVideoAnalysisSubject {
  readonly asset: ProjectAssetV1;
  readonly stream: VideoStream;
  readonly subject: AnalysisSubject;
}

function parseSubjectReference(reference: string): { readonly assetId: string; readonly streamId: string } {
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1 || reference.indexOf(":", separator + 1) !== -1) {
    throw new CliError("usage", `Media stream must use <asset-id>:<stream-id>: ${reference}`);
  }
  return { assetId: reference.slice(0, separator), streamId: reference.slice(separator + 1) };
}

export function resolveVideoAnalysisSubject(
  project: VideoProjectV1,
  reference: string,
): ResolvedVideoAnalysisSubject {
  const selected = parseSubjectReference(reference);
  const asset = project.assets.find(candidate => candidate.assetId === selected.assetId);
  if (asset === undefined) throw new CliError("not-found", `Unknown project asset: ${selected.assetId}`);
  const stream = asset.streams.find(candidate => candidate.streamId === selected.streamId);
  if (stream?.kind !== "video") {
    throw new CliError("not-found", `Unknown video stream on ${selected.assetId}: ${selected.streamId}`);
  }
  const subject = AnalysisSubjectSchema.parse({
    assetId: asset.assetId,
    integritySha256: canonicalJsonSha256({
      assetDurationUs: asset.durationUs,
      stream,
      version: "atet-video-analysis-subject-v1",
    }),
    streamId: stream.streamId,
  });
  return { asset, stream, subject };
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function segmentIntegrityKey(segment: VideoSegment): string {
  return `${segment.path}:${segment.bytes}:${segment.sha256}`;
}

async function verifiedSegmentPath(
  repositoryRoot: string,
  segment: VideoSegment,
  verifiedMedia: ReadonlyMap<string, string> | undefined,
): Promise<string> {
  const cached = verifiedMedia?.get(segmentIntegrityKey(segment));
  if (cached !== undefined) return cached;
  return await resolveVerifiedProjectMedia({
    expected: { bytes: segment.bytes, sha256: segment.sha256 },
    label: `Scene segment ${segment.path}:${segment.streamIndex}`,
    path: segment.path,
    repositoryRoot,
  });
}

function seconds(microseconds: number): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

/** Parses the first decoded frame timestamp emitted by this service's showinfo filter. */
export function parseExtractedFramePtsTimeUs(output: string): number | null {
  let hasMicrosecondTimeBase = false;
  let selectedPts: bigint | null = null;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes("Parsed_showinfo_")) continue;
    if (/\bconfig in time_base:\s*1\/1000000\b/u.test(line)) hasMicrosecondTimeBase = true;
    if (!/\bn:\s*0\b/u.test(line)) continue;
    const match = /\bpts:\s*(?<pts>-?[0-9]+)\b/u.exec(line);
    if (match?.groups?.pts !== undefined) selectedPts = BigInt(match.groups.pts);
  }
  if (
    !hasMicrosecondTimeBase
    || selectedPts === null
    || selectedPts < BigInt(Number.MIN_SAFE_INTEGER)
    || selectedPts > BigInt(Number.MAX_SAFE_INTEGER)
  ) return null;
  return Number(selectedPts);
}

function parseFrameCrcPtsTimesUs(output: string): readonly number[] {
  const timestamps: number[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*[0-9]+,\s*-?[0-9]+,\s*(?<pts>-?[0-9]+),/u.exec(line);
    if (match?.groups?.pts === undefined) continue;
    const pts = BigInt(match.groups.pts);
    if (
      pts < BigInt(Number.MIN_SAFE_INTEGER)
      || pts > BigInt(Number.MAX_SAFE_INTEGER)
    ) continue;
    timestamps.push(Number(pts));
  }
  return timestamps;
}

function frameSeekTimes(segmentStartUs: number, requestedTimeUs: number): readonly number[] {
  const distanceUs = requestedTimeUs - segmentStartUs;
  const seekTimes = [requestedTimeUs];
  if (distanceUs === 0) return seekTimes;

  let lookbackUs = Math.min(INITIAL_FRAME_LOOKBACK_US, distanceUs);
  while (seekTimes.length < MAXIMUM_FRAME_DISCOVERY_ATTEMPTS) {
    const seekTimeUs = requestedTimeUs - lookbackUs;
    seekTimes.push(seekTimeUs);
    if (seekTimeUs === segmentStartUs) return seekTimes;
    lookbackUs += Math.min(lookbackUs, distanceUs - lookbackUs);
  }
  throw new CliError("internal", "Scene frame discovery could not reach the segment start within its attempt bound.");
}

async function discoverFramePtsTimeUs(options: {
  readonly ffmpeg: string;
  readonly requestedFileTimeUs: number;
  readonly runner: ProcessRunner;
  readonly selectionFileEndUs: number;
  readonly selectionFileStartUs: number;
  readonly source: string;
  readonly streamIndex: number;
}): Promise<number> {
  const searchEndUs = Math.min(
    options.selectionFileEndUs,
    options.requestedFileTimeUs + 1,
  );
  for (
    const seekTimeUs of frameSeekTimes(
      options.selectionFileStartUs,
      options.requestedFileTimeUs,
    )
  ) {
    const discovery = await options.runner.run([
      options.ffmpeg,
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-copyts", "-start_at_zero", "-seek_timestamp", "1",
      "-ss", seconds(seekTimeUs),
      "-t", seconds(searchEndUs - seekTimeUs),
      "-i", options.source,
      "-map", `0:${options.streamIndex}`,
      "-vf", [
        `trim=start=${seconds(seekTimeUs)}:end=${seconds(searchEndUs)},`,
        "settb=expr=1/1000000,",
        "scale=2:2:flags=neighbor,format=gray",
      ].join(""),
      "-an",
      "-fps_mode", "passthrough",
      "-enc_time_base", "1:1000000",
      "-f", "framecrc", "-",
    ], { maxOutputBytes: 1_000_000 });
    if (discovery.exitCode !== 0) {
      throw new CliError(
        "subprocess",
        `FFmpeg frame timestamp discovery failed: ${
          discovery.stderr.trim().slice(-4_000) || `exit ${discovery.exitCode}`
        }`,
      );
    }
    const closestPredecessor = parseFrameCrcPtsTimesUs(discovery.stdout)
      .filter(timestamp =>
        timestamp >= options.selectionFileStartUs
        && timestamp <= options.requestedFileTimeUs
        && timestamp < options.selectionFileEndUs)
      .reduce<number | null>(
        (closest, timestamp) => closest === null || timestamp > closest ? timestamp : closest,
        null,
      );
    if (closestPredecessor !== null) return closestPredecessor;
  }

  // A scene can begin between two frames. Only when it has no in-range
  // predecessor may its first following frame satisfy the sample.
  const successor = await options.runner.run([
    options.ffmpeg,
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-copyts", "-start_at_zero", "-seek_timestamp", "1",
    "-ss", seconds(options.requestedFileTimeUs),
    "-t", seconds(options.selectionFileEndUs - options.requestedFileTimeUs),
    "-i", options.source,
    "-map", `0:${options.streamIndex}`,
    "-vf", [
      `trim=start=${seconds(options.requestedFileTimeUs)}:end=${
        seconds(options.selectionFileEndUs)
      },`,
      "settb=expr=1/1000000,",
      "scale=2:2:flags=neighbor,format=gray",
    ].join(""),
    "-frames:v", "1",
    "-an",
    "-fps_mode", "passthrough",
    "-enc_time_base", "1:1000000",
    "-f", "framecrc", "-",
  ], { maxOutputBytes: 1_000_000 });
  if (successor.exitCode !== 0) {
    throw new CliError(
      "subprocess",
      `FFmpeg frame timestamp discovery failed: ${
        successor.stderr.trim().slice(-4_000) || `exit ${successor.exitCode}`
      }`,
    );
  }
  const firstSuccessor = parseFrameCrcPtsTimesUs(successor.stdout)
    .find(timestamp =>
      timestamp >= options.requestedFileTimeUs
      && timestamp < options.selectionFileEndUs);
  if (firstSuccessor !== undefined) return firstSuccessor;
  throw new CliError(
    "invalid-data",
    `No decodable video frame exists in the selected scene interval.`,
  );
}

/** Parses only FFmpeg showinfo timestamps and never treats log text as structured commands. */
export function parseSceneDetectionLog(
  output: string,
  segment: VideoSegment,
  confidence: number,
): readonly SceneBoundaryCandidate[] {
  const boundaries = new Map<number, SceneBoundaryCandidate>();
  for (const match of output.matchAll(/\bpts_time:(?<seconds>[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)/giu)) {
    const secondsValue = Number(match.groups?.seconds);
    const fileTimeUs = Math.round(secondsValue * 1_000_000);
    if (!Number.isSafeInteger(fileTimeUs)) continue;
    if (fileTimeUs <= segment.fileRange.startUs || fileTimeUs >= segment.fileRange.endUs) continue;
    const assetTimeUs = segment.assetRange.startUs + fileTimeUs - segment.fileRange.startUs;
    if (assetTimeUs <= segment.assetRange.startUs || assetTimeUs >= segment.assetRange.endUs) continue;
    boundaries.set(assetTimeUs, { confidence, kind: "visual", timeUs: assetTimeUs });
  }
  return [...boundaries.values()].sort((left, right) => left.timeUs - right.timeUs);
}

export async function detectVisualSceneBoundaries(options: {
  readonly ffmpeg: string;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly stream: VideoStream;
  readonly threshold: number;
  readonly verifiedMedia?: ReadonlyMap<string, string>;
}): Promise<readonly SceneBoundaryCandidate[]> {
  if (!Number.isFinite(options.threshold) || options.threshold <= 0 || options.threshold > 1) {
    throw new CliError("usage", "Scene threshold must be greater than zero and at most one.");
  }
  const boundaries: SceneBoundaryCandidate[] = [];
  for (const segment of options.stream.segments) {
    const source = await verifiedSegmentPath(options.repositoryRoot, segment, options.verifiedMedia);
    const result = await options.runner.run([
      options.ffmpeg,
      "-hide_banner", "-nostdin",
      "-copyts", "-start_at_zero",
      "-i", source,
      "-map", `0:${segment.streamIndex}`,
      "-vf", `settb=expr=1/1000000,select='gt(scene,${options.threshold})',showinfo`,
      "-an", "-vsync", "0", "-f", "null", "-",
    ], { maxOutputBytes: MAXIMUM_DETECTION_OUTPUT_BYTES });
    if (result.exitCode !== 0) {
      throw new CliError(
        "subprocess",
        `FFmpeg scene detection failed: ${result.stderr.trim().slice(-4_000) || `exit ${result.exitCode}`}`,
      );
    }
    boundaries.push(...parseSceneDetectionLog(result.stderr, segment, options.threshold));
  }
  return [...new Map(boundaries.map(boundary => [boundary.timeUs, boundary])).values()]
    .sort((left, right) => left.timeUs - right.timeUs);
}

function segmentAt(stream: VideoStream, assetTimeUs: number): VideoSegment {
  const segment = stream.segments.find(candidate =>
    assetTimeUs >= candidate.assetRange.startUs && assetTimeUs < candidate.assetRange.endUs);
  if (segment === undefined) {
    throw new CliError("invalid-data", `No video media exists at requested asset time ${assetTimeUs}.`);
  }
  return segment;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function checkedRead(path: string, maximumBytes: number, expectedBytes?: number): Promise<Uint8Array> {
  const details = await lstat(path);
  if (
    details.isSymbolicLink()
    || !details.isFile()
    || details.nlink !== 1
    || details.size < 1
    || details.size > maximumBytes
  ) {
    throw new CliError("invalid-data", `Derived scene frame has an invalid byte size: ${details.size}.`);
  }
  if (expectedBytes !== undefined && details.size !== expectedBytes) {
    throw new CliError("invalid-data", `Derived frame fingerprint must contain ${expectedBytes} bytes.`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== details.dev
      || before.ino !== details.ino
      || before.nlink !== 1
      || before.size !== details.size
    ) {
      throw new CliError("conflict", "Derived scene frame changed before validation.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== 1
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new CliError("conflict", "Derived scene frame changed during validation.");
    }
    return new Uint8Array(bytes);
  } finally {
    await handle.close();
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function awaitSingleLink(path: string): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if ((await lstat(path)).nlink === 1) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function cacheRelativePath(batchKey: string): string {
  return RepositoryRelativePathSchema.parse(`analysis/scene-cache/${Sha256Schema.parse(batchKey)}.json`);
}

async function ensureSceneCacheDirectory(projectDirectory: string): Promise<void> {
  await ensurePhysicalPrivateDirectoryWithin(projectDirectory, "analysis/scene-cache");
}

async function loadCachedSceneBatch(
  projectDirectory: string,
  batchKey: string,
  expectedSceneIds: readonly string[],
): Promise<CachedSceneProviderResult | null> {
  await ensureSceneCacheDirectory(projectDirectory);
  const relativePath = cacheRelativePath(batchKey);
  const absolutePath = join(projectDirectory, relativePath);
  try {
    const details = await lstat(absolutePath);
    if (
      details.isSymbolicLink()
      || !details.isFile()
      || details.size < 1
      || details.size > MAXIMUM_SCENE_CACHE_BYTES
    ) return null;
    const input: unknown = JSON.parse(await createNodeBundleFileSystem(projectDirectory).readText(relativePath));
    const parsed = SceneBatchCacheFileSchema.safeParse(input);
    if (!parsed.success) return null;
    if (reusableSceneBatchCacheEntry(batchKey, parsed.data.entry) === null) return null;
    if (canonicalJsonSha256(parsed.data.result) !== parsed.data.entry.payloadSha256) return null;
    if (
      parsed.data.result.descriptions.length !== expectedSceneIds.length
      || parsed.data.result.descriptions.some((description, index) => description.sceneId !== expectedSceneIds[index])
    ) return null;
    return parsed.data.result;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function saveCachedSceneBatch(
  projectDirectory: string,
  batchKey: string,
  result: CachedSceneProviderResult,
): Promise<void> {
  await ensureSceneCacheDirectory(projectDirectory);
  const parsedResult = CachedSceneProviderResultSchema.parse(result);
  const cache = SceneBatchCacheFileSchema.parse({
    entry: {
      batchKey,
      payloadSha256: canonicalJsonSha256(parsedResult),
      schemaVersion: 1,
      state: "complete",
    },
    result: parsedResult,
  });
  await createNodeBundleFileSystem(projectDirectory).writeTextAtomic(
    cacheRelativePath(batchKey),
    `${canonicalJson(cache)}\n`,
  );
}

interface MaterializedFrame {
  readonly bytes: Uint8Array;
  readonly record: SceneAnalysisV1["samples"][number];
}

async function extractFrame(options: {
  readonly ffmpeg: string;
  readonly frameDirectory: string;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly sample: PlannedSceneSample;
  readonly sceneRange: VideoSegment["assetRange"];
  readonly stream: VideoStream;
  readonly verifiedMedia: ReadonlyMap<string, string>;
}): Promise<MaterializedFrame> {
  const segment = segmentAt(options.stream, options.sample.requestedAssetTimeUs);
  const source = await verifiedSegmentPath(options.repositoryRoot, segment, options.verifiedMedia);
  const selectionAssetStartUs = Math.max(segment.assetRange.startUs, options.sceneRange.startUs);
  const selectionAssetEndUs = Math.min(segment.assetRange.endUs, options.sceneRange.endUs);
  const selectionFileStartUs = segment.fileRange.startUs
    + selectionAssetStartUs
    - segment.assetRange.startUs;
  const selectionFileEndUs = segment.fileRange.startUs
    + selectionAssetEndUs
    - segment.assetRange.startUs;
  const requestedFileTimeUs = segment.fileRange.startUs
    + options.sample.requestedAssetTimeUs
    - segment.assetRange.startUs;
  const temporaryStem = join(options.frameDirectory, `.extract-${randomUUID()}`);
  const temporaryJpeg = `${temporaryStem}.jpg`;
  const temporaryGray = `${temporaryStem}.gray`;
  try {
    const selectedFileTimeUs = await discoverFramePtsTimeUs({
      ffmpeg: options.ffmpeg,
      requestedFileTimeUs,
      runner: options.runner,
      selectionFileEndUs,
      selectionFileStartUs,
      source,
      streamIndex: segment.streamIndex,
    });
    const extraction = await options.runner.run([
      options.ffmpeg,
      "-hide_banner", "-loglevel", "info", "-nostdin", "-n",
      "-copyts", "-start_at_zero", "-seek_timestamp", "1",
      "-ss", seconds(selectedFileTimeUs),
      "-t", seconds(selectionFileEndUs - selectedFileTimeUs),
      "-i", source,
      "-filter_complex", [
        `[0:${segment.streamIndex}]`,
        `trim=start=${seconds(selectedFileTimeUs)}:end=${seconds(selectionFileEndUs)},`,
        "settb=expr=1/1000000,showinfo,split=2[atet_scene_jpeg_source][atet_scene_gray_source];",
        "[atet_scene_jpeg_source]",
        "scale=w='min(960,iw)':h=-2:force_original_aspect_ratio=decrease,",
        "format=yuvj420p[atet_scene_jpeg];",
        "[atet_scene_gray_source]",
        "scale=9:8:flags=area,format=gray[atet_scene_gray]",
      ].join(""),
      "-map", "[atet_scene_jpeg]",
      "-frames:v", "1",
      "-pix_fmt", "yuvj420p",
      "-q:v", "6", "-f", "image2", temporaryJpeg,
      "-map", "[atet_scene_gray]",
      "-frames:v", "1",
      "-pix_fmt", "gray", "-f", "rawvideo", temporaryGray,
    ], { maxOutputBytes: 1_000_000 });
    if (extraction.exitCode !== 0) {
      throw new CliError(
        "subprocess",
        `FFmpeg frame extraction failed: ${
          extraction.stderr.trim().slice(-4_000) || `exit ${extraction.exitCode}`
        }`,
      );
    }
    const decodedFileTimeUs = parseExtractedFramePtsTimeUs(extraction.stderr);
    if (decodedFileTimeUs !== selectedFileTimeUs) {
      throw new CliError(
        "invalid-data",
        "FFmpeg did not extract the exact discovered scene-frame timestamp.",
      );
    }
    const [bytes, grayscale] = await Promise.all([
      checkedRead(temporaryJpeg, MAXIMUM_FRAME_BYTES),
      checkedRead(temporaryGray, 72, 72),
    ]);
    const sha256 = sha256Bytes(bytes);
    const finalPath = join(options.frameDirectory, `${sha256}.jpg`);
    try {
      await link(temporaryJpeg, finalPath);
      await rm(temporaryJpeg);
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
      await awaitSingleLink(finalPath);
    }
    const committed = await checkedRead(finalPath, MAXIMUM_FRAME_BYTES, bytes.byteLength);
    if (sha256Bytes(committed) !== sha256) {
      throw new CliError("conflict", `Content-addressed scene frame does not match ${sha256}.`);
    }
    const physicalRepositoryRoot = await realpath(options.repositoryRoot);
    const repositoryPath = relative(physicalRepositoryRoot, finalPath);
    if (!isWithin(physicalRepositoryRoot, finalPath) || isAbsolute(repositoryPath)) {
      throw new CliError("unsafe-path", "Derived scene frame escaped the repository.");
    }
    return {
      bytes,
      record: {
        actualAssetTimeUs: segment.assetRange.startUs
          + selectedFileTimeUs
          - segment.fileRange.startUs,
        bytes: bytes.byteLength,
        path: RepositoryRelativePathSchema.parse(repositoryPath),
        perceptualHash: differenceHash64(grayscale),
        reasons: options.sample.reasons,
        requestedAssetTimeUs: options.sample.requestedAssetTimeUs,
        sampleId: options.sample.sampleId as SceneAnalysisV1["samples"][number]["sampleId"],
        sha256,
      },
    };
  } finally {
    await Promise.all([
      rm(temporaryJpeg, { force: true }),
      rm(temporaryGray, { force: true }),
    ]);
  }
}

export interface AnalyzeProjectScenesOptions {
  readonly acknowledgedAt: string;
  readonly analysisId: string;
  readonly createdAt: string;
  readonly execute: boolean;
  readonly ffmpeg: string;
  readonly maximumSceneDurationUs: number;
  readonly model: string;
  readonly project: VideoProjectV1;
  readonly projectDirectory: string;
  readonly provider?: SceneDescriptionProvider;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly sceneThreshold: number;
  readonly source: string;
}

export interface PlanProjectScenesOptions {
  readonly ffmpeg: string;
  readonly maximumSceneDurationUs: number;
  readonly project: VideoProjectV1;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly sceneThreshold: number;
  readonly source: string;
}

export interface PlanProjectScenesResult {
  readonly plan: SceneSamplingPlan;
  readonly subject: AnalysisSubject;
}

interface PreparedProjectScenePlan extends PlanProjectScenesResult {
  readonly resolved: ResolvedVideoAnalysisSubject;
  readonly verifiedMedia: ReadonlyMap<string, string>;
}

async function prepareProjectScenePlan(
  options: PlanProjectScenesOptions,
): Promise<PreparedProjectScenePlan> {
  const resolved = resolveVideoAnalysisSubject(options.project, options.source);
  const uniqueSegments = [...new Map(
    resolved.stream.segments.map(segment => [segmentIntegrityKey(segment), segment]),
  ).entries()];
  const verifiedMedia = new Map(await Promise.all(uniqueSegments.map(async ([key, segment]) => [
    key,
    await verifiedSegmentPath(options.repositoryRoot, segment, undefined),
  ] as const)));
  const boundaries = await detectVisualSceneBoundaries({
    ffmpeg: options.ffmpeg,
    repositoryRoot: options.repositoryRoot,
    runner: options.runner,
    stream: resolved.stream,
    threshold: options.sceneThreshold,
    verifiedMedia,
  });
  const plan = planSceneSampling({
    boundaries,
    inputDigest: resolved.subject.integritySha256,
    maximumSceneDurationUs: options.maximumSceneDurationUs,
    ranges: resolved.stream.segments.map(segment => segment.assetRange),
  });
  if (plan.samples.length > MAXIMUM_SCENE_SAMPLES) {
    throw new CliError("invalid-data", `Scene sampling exceeds its ${MAXIMUM_SCENE_SAMPLES}-frame bound.`);
  }
  return {
    plan,
    resolved,
    subject: resolved.subject,
    verifiedMedia,
  };
}

export async function planProjectScenes(
  options: PlanProjectScenesOptions,
): Promise<PlanProjectScenesResult> {
  const prepared = await prepareProjectScenePlan(options);
  return {
    plan: prepared.plan,
    subject: prepared.subject,
  };
}

export type AnalyzeProjectScenesResult =
  | {
      readonly analysis: SceneAnalysisV1;
      readonly kind: "complete";
      readonly plan: SceneSamplingPlan;
    }
  | {
      readonly kind: "planned";
      readonly plan: SceneSamplingPlan;
      readonly subject: AnalysisSubject;
    };

export async function analyzeProjectScenes(
  options: AnalyzeProjectScenesOptions,
): Promise<AnalyzeProjectScenesResult> {
  if (!/^google\/gemini-[a-z0-9][a-z0-9._-]{0,239}$/u.test(options.model)) {
    throw new CliError("usage", "Scene model must be a bounded google/gemini-* AI Gateway model ID.");
  }
  const {
    plan,
    resolved,
    verifiedMedia,
  } = await prepareProjectScenePlan(options);
  if (!options.execute) return { kind: "planned", plan, subject: resolved.subject };
  if (options.provider === undefined) throw new CliError("internal", "Scene execution requires a configured description provider.");

  const frameDirectory = await ensurePhysicalPrivateDirectoryWithin(
    options.projectDirectory,
    `analysis/scene-frames/${plan.planDigest}`,
  );
  const sceneById = new Map(plan.scenes.map(scene => [scene.sceneId, scene]));
  const materialized = await mapBounded(
    plan.samples,
    SCENE_EXTRACTION_CONCURRENCY,
    async (sample) => {
      const ownerScene = sceneById.get(sample.sceneId);
      if (ownerScene === undefined) throw new CliError("internal", `Missing owner scene: ${sample.sceneId}`);
      return await extractFrame({
        ffmpeg: options.ffmpeg,
        frameDirectory,
        repositoryRoot: options.repositoryRoot,
        runner: options.runner,
        sample,
        sceneRange: ownerScene.range,
        stream: resolved.stream,
        verifiedMedia,
      });
    },
  );
  const frameById = new Map(materialized.map(frame => [frame.record.sampleId, frame]));
  const batchPlans = planSceneBatches(plan.planDigest, plan.scenes.map(scene => ({
    frames: deduplicateFrameFingerprints(scene.sampleIds.map((sampleId) => {
      const frame = frameById.get(sampleId as SceneAnalysisV1["samples"][number]["sampleId"]);
      if (frame === undefined) throw new CliError("internal", `Missing extracted sample: ${sampleId}`);
      return {
        actualAssetTimeUs: frame.record.actualAssetTimeUs,
        bytes: frame.record.bytes,
        perceptualHash: frame.record.perceptualHash,
        sampleId,
        sha256: frame.record.sha256,
      };
    })).filter(item => item.canonicalSampleId === item.sampleId).map((item) => {
      const frame = frameById.get(item.sampleId as SceneAnalysisV1["samples"][number]["sampleId"]);
      if (frame === undefined) throw new CliError("internal", `Missing deduplicated sample: ${item.sampleId}`);
      return {
        actualAssetTimeUs: frame.record.actualAssetTimeUs,
        bytes: frame.record.bytes,
        sampleId: frame.record.sampleId,
        sha256: frame.record.sha256,
      };
    }),
    rangeStartUs: scene.range.startUs,
    sceneId: scene.sceneId,
  })));

  const batches: SceneAnalysisV1["batches"][number][] = [];
  const descriptionBySceneId = new Map<string, SceneAnalysisV1["scenes"][number]["description"]>();
  const resolvedModels = new Set<string>();
  const usage = { inputTokens: 0, outputTokens: 0, uploadedBytes: 0, uploadedImages: 0 };
  for (const batchPlan of batchPlans) {
    const batchKey = sceneBatchCacheKey({
      inputDigest: resolved.subject.integritySha256,
      model: {
        aiSdkVersion: SCENE_AI_SDK_VERSION,
        gateway: "vercel-ai-gateway",
        promptSha256: SCENE_PROMPT_SHA256,
        promptVersion: SCENE_PROMPT_VERSION,
        requestedModel: options.model,
        samplingVersion: plan.samplingVersion,
      },
      samples: batchPlan.frames.map(frame => ({
        actualAssetTimeUs: frame.actualAssetTimeUs,
        sampleId: frame.sampleId,
        sha256: frame.sha256,
      })),
      sceneIds: batchPlan.batch.sceneIds,
    });
    let batch = transitionSceneBatch({ ...batchPlan.batch, batchKey }, { kind: "dispatch" });
    try {
      const cached = await loadCachedSceneBatch(options.projectDirectory, batch.batchKey, batch.sceneIds);
      let result: CachedSceneProviderResult;
      if (cached !== null) {
        result = cached;
      } else {
        const live = await options.provider.describe({
          batchKey: batch.batchKey,
          cloudUpload: { acknowledgedAt: options.acknowledgedAt, policy: SCENE_UPLOAD_POLICY },
          model: options.model,
          prompt: { sha256: SCENE_PROMPT_SHA256, version: SCENE_PROMPT_VERSION },
          scenes: batch.sceneIds.map(sceneId => ({
            frames: batchPlan.frames.filter(frame => frame.sceneId === sceneId).map((frame) => {
              const materializedFrame = frameById.get(frame.sampleId as SceneAnalysisV1["samples"][number]["sampleId"]);
              if (materializedFrame === undefined) throw new CliError("internal", `Missing batch sample: ${frame.sampleId}`);
              return {
                actualAssetTimeUs: frame.actualAssetTimeUs,
                bytes: materializedFrame.bytes,
                mediaType: "image/jpeg" as const,
                sampleId: frame.sampleId,
              };
            }),
            sceneId,
          })),
        });
        result = CachedSceneProviderResultSchema.parse({
          descriptions: live.descriptions,
          resolvedModel: live.resolvedModel,
        });
        usage.inputTokens += live.usage.inputTokens;
        usage.outputTokens += live.usage.outputTokens;
        usage.uploadedBytes += live.usage.uploadedBytes;
        usage.uploadedImages += live.usage.uploadedImages;
        try {
          await saveCachedSceneBatch(options.projectDirectory, batch.batchKey, result);
        } catch {
          // Persisting a successful response is best-effort. The in-memory
          // descriptions and provider usage remain authoritative for this run.
        }
      }
      batch = transitionSceneBatch(batch, { kind: "complete" });
      for (const described of result.descriptions) descriptionBySceneId.set(described.sceneId, described.description);
      if (result.resolvedModel !== null) resolvedModels.add(result.resolvedModel);
    } catch (error) {
      const failure = error instanceof SceneProviderError
        ? error
        : new SceneProviderError("gateway-unavailable");
      batch = transitionSceneBatch(batch, {
        errorCode: failure.code,
        kind: "fail",
        outcome: failure.outcome,
      });
    }
    batches.push(SceneBatchSchema.parse(batch));
  }

  const scenes = plan.scenes.flatMap((scene) => {
    const description = descriptionBySceneId.get(scene.sceneId);
    return description === undefined ? [] : [{
      boundaryConfidence: scene.boundaryConfidence,
      description,
      range: scene.range,
      sampleIds: scene.sampleIds,
      sceneId: scene.sceneId,
    }];
  });
  const resolvedModel = resolvedModels.size === 1 ? [...resolvedModels][0]! : null;
  const analysis = SceneAnalysisV1Schema.parse({
    analysisId: options.analysisId,
    batches,
    cloudUpload: { acknowledgedAt: options.acknowledgedAt, policy: SCENE_UPLOAD_POLICY },
    createdAt: options.createdAt,
    durationUs: resolved.asset.durationUs,
    inputDigest: resolved.subject.integritySha256,
    kind: "atet.scene-analysis",
    model: {
      aiSdkVersion: SCENE_AI_SDK_VERSION,
      gateway: "vercel-ai-gateway",
      promptSha256: SCENE_PROMPT_SHA256,
      promptVersion: SCENE_PROMPT_VERSION,
      requestedModel: options.model,
      resolvedModel,
      samplingVersion: plan.samplingVersion,
    },
    samples: materialized.map(frame => frame.record),
    scenes,
    schemaVersion: 1,
    subjects: [resolved.subject],
    usage,
  });
  return { analysis, kind: "complete", plan };
}
