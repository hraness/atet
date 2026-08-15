import type { SourceInterval } from "../contracts/edit";
import { canonicalJsonSha256 } from "./canonical-json";

export const SCENE_SAMPLING_VERSION = "atet-scene-sampling-v1";

export const SCENE_BATCH_LIMITS = {
  imageBytes: 6_000_000,
  imageCount: 12,
  sceneCount: 4,
} as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PERCEPTUAL_HASH_PATTERN = /^[a-f0-9]{16}$/u;
const REASON_ORDER = ["boundary", "middle", "event", "maximum-gap", "motion"] as const;

export type SceneSampleReason = typeof REASON_ORDER[number];
export type SceneBoundaryKind = "event" | "motion" | "visual";

export interface SceneBoundaryCandidate {
  readonly confidence: number;
  readonly kind: SceneBoundaryKind;
  readonly timeUs: number;
}

export interface SceneSamplingInput {
  readonly boundaries: readonly SceneBoundaryCandidate[];
  readonly inputDigest: string;
  readonly maximumSceneDurationUs: number;
  readonly ranges: readonly SourceInterval[];
}

export interface PlannedSceneSample {
  readonly reasons: readonly SceneSampleReason[];
  readonly requestedAssetTimeUs: number;
  readonly sampleId: string;
  readonly sceneId: string;
}

export interface PlannedScene {
  readonly boundaryConfidence: number;
  readonly range: SourceInterval;
  readonly sampleIds: readonly string[];
  readonly sceneId: string;
}

export interface SceneSamplingPlan {
  readonly planDigest: string;
  readonly samples: readonly PlannedSceneSample[];
  readonly samplingVersion: typeof SCENE_SAMPLING_VERSION;
  readonly scenes: readonly PlannedScene[];
}

interface BoundaryPoint {
  readonly confidence: number;
  readonly reasons: readonly SceneSampleReason[];
  readonly timeUs: number;
}

function requireSafeMicroseconds(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${label} must be a ${allowZero ? "nonnegative" : "positive"} safe integer.`);
  }
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
}

function orderedReasons(values: Iterable<SceneSampleReason>): readonly SceneSampleReason[] {
  const selected = new Set(values);
  return REASON_ORDER.filter(reason => selected.has(reason));
}

function normalizeRanges(ranges: readonly SourceInterval[]): readonly SourceInterval[] {
  const ordered = ranges.map((range) => {
    requireSafeMicroseconds(range.startUs, "Scene range startUs", true);
    requireSafeMicroseconds(range.endUs, "Scene range endUs", false);
    if (range.endUs <= range.startUs) throw new TypeError("Scene ranges must be nonempty.");
    return { endUs: range.endUs, startUs: range.startUs };
  }).sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);

  const normalized: SourceInterval[] = [];
  for (const current of ordered) {
    const prior = normalized.at(-1);
    if (prior === undefined || current.startUs > prior.endUs) {
      normalized.push(current);
      continue;
    }
    if (current.startUs < prior.endUs) {
      throw new TypeError("Scene ranges must not overlap.");
    }
    normalized[normalized.length - 1] = { endUs: current.endUs, startUs: prior.startUs };
  }
  return normalized;
}

function candidateReason(kind: SceneBoundaryKind): SceneSampleReason {
  if (kind === "event") return "event";
  if (kind === "motion") return "motion";
  return "boundary";
}

function normalizeBoundaryCandidates(
  boundaries: readonly SceneBoundaryCandidate[],
  range: SourceInterval,
): ReadonlyMap<number, BoundaryPoint> {
  const grouped = new Map<number, { confidence: number; reasons: Set<SceneSampleReason> }>();
  for (const boundary of boundaries) {
    requireSafeMicroseconds(boundary.timeUs, "Scene boundary timeUs", true);
    if (!Number.isFinite(boundary.confidence) || boundary.confidence < 0 || boundary.confidence > 1) {
      throw new TypeError("Scene boundary confidence must be between zero and one.");
    }
    if (boundary.timeUs <= range.startUs || boundary.timeUs >= range.endUs) continue;
    const existing = grouped.get(boundary.timeUs) ?? { confidence: 0, reasons: new Set() };
    existing.confidence = Math.max(existing.confidence, boundary.confidence);
    existing.reasons.add("boundary");
    existing.reasons.add(candidateReason(boundary.kind));
    grouped.set(boundary.timeUs, existing);
  }
  return new Map([...grouped.entries()].sort(([left], [right]) => left - right).map(([timeUs, value]) => [
    timeUs,
    { confidence: value.confidence, reasons: orderedReasons(value.reasons), timeUs },
  ]));
}

function boundaryPoints(
  range: SourceInterval,
  candidates: ReadonlyMap<number, BoundaryPoint>,
  maximumSceneDurationUs: number,
): readonly BoundaryPoint[] {
  const points = new Map<number, BoundaryPoint>();
  points.set(range.startUs, { confidence: 1, reasons: ["boundary"], timeUs: range.startUs });
  points.set(range.endUs, { confidence: 1, reasons: ["boundary"], timeUs: range.endUs });
  for (const point of candidates.values()) points.set(point.timeUs, point);

  const anchors = [...points.keys()].sort((left, right) => left - right);
  for (let index = 1; index < anchors.length; index += 1) {
    const prior = anchors[index - 1]!;
    const next = anchors[index]!;
    for (let timeUs = prior + maximumSceneDurationUs; timeUs < next; timeUs += maximumSceneDurationUs) {
      points.set(timeUs, {
        confidence: 0,
        reasons: ["boundary", "maximum-gap"],
        timeUs,
      });
    }
  }
  return [...points.values()].sort((left, right) => left.timeUs - right.timeUs);
}

function sceneId(inputDigest: string, range: SourceInterval): string {
  return `scene_${canonicalJsonSha256({ inputDigest, range, version: SCENE_SAMPLING_VERSION }).slice(0, 24)}`;
}

function sampleId(
  inputDigest: string,
  ownerSceneId: string,
  requestedAssetTimeUs: number,
  reasons: readonly SceneSampleReason[],
): string {
  return `sample_${canonicalJsonSha256({
    inputDigest,
    ownerSceneId,
    reasons,
    requestedAssetTimeUs,
    version: SCENE_SAMPLING_VERSION,
  }).slice(0, 24)}`;
}

function samplesForScene(
  inputDigest: string,
  range: SourceInterval,
  ownerSceneId: string,
  startPoint: BoundaryPoint,
  endPoint: BoundaryPoint,
): readonly PlannedSceneSample[] {
  const byTime = new Map<number, Set<SceneSampleReason>>();
  const add = (timeUs: number, reasons: readonly SceneSampleReason[]) => {
    const selected = byTime.get(timeUs) ?? new Set<SceneSampleReason>();
    for (const reason of reasons) selected.add(reason);
    byTime.set(timeUs, selected);
  };

  add(range.startUs, startPoint.reasons);
  add(Math.floor(range.startUs + (range.endUs - range.startUs - 1) / 2), ["middle"]);
  add(range.endUs - 1, endPoint.reasons);

  return [...byTime.entries()].sort(([left], [right]) => left - right).map(([requestedAssetTimeUs, reasons]) => {
    const normalizedReasons = orderedReasons(reasons);
    return {
      reasons: normalizedReasons,
      requestedAssetTimeUs,
      sampleId: sampleId(inputDigest, ownerSceneId, requestedAssetTimeUs, normalizedReasons),
      sceneId: ownerSceneId,
    };
  });
}

export function planSceneSampling(input: SceneSamplingInput): SceneSamplingPlan {
  requireSha256(input.inputDigest, "Scene inputDigest");
  requireSafeMicroseconds(input.maximumSceneDurationUs, "maximumSceneDurationUs", false);
  const ranges = normalizeRanges(input.ranges);
  const scenes: PlannedScene[] = [];
  const samples: PlannedSceneSample[] = [];

  for (const range of ranges) {
    const candidates = normalizeBoundaryCandidates(input.boundaries, range);
    const points = boundaryPoints(range, candidates, input.maximumSceneDurationUs);
    for (let index = 1; index < points.length; index += 1) {
      const startPoint = points[index - 1]!;
      const endPoint = points[index]!;
      const sceneRange = { endUs: endPoint.timeUs, startUs: startPoint.timeUs };
      const id = sceneId(input.inputDigest, sceneRange);
      const sceneSamples = samplesForScene(input.inputDigest, sceneRange, id, startPoint, endPoint);
      scenes.push({
        boundaryConfidence: startPoint.confidence,
        range: sceneRange,
        sampleIds: sceneSamples.map(sample => sample.sampleId),
        sceneId: id,
      });
      samples.push(...sceneSamples);
    }
  }

  const planValue = {
    samples,
    samplingVersion: SCENE_SAMPLING_VERSION as typeof SCENE_SAMPLING_VERSION,
    scenes,
  };
  return { ...planValue, planDigest: canonicalJsonSha256(planValue) };
}

function parsePerceptualHash(value: string): bigint {
  if (!PERCEPTUAL_HASH_PATTERN.test(value)) {
    throw new TypeError("Perceptual hashes must be sixteen lowercase hexadecimal characters.");
  }
  return BigInt(`0x${value}`);
}

export function differenceHash64(grayscale: Uint8Array): string {
  if (grayscale.length !== 9 * 8) {
    throw new TypeError("A 64-bit difference hash requires an eight-row, nine-column grayscale image.");
  }
  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      hash <<= 1n;
      const left = grayscale[row * 9 + column]!;
      const right = grayscale[row * 9 + column + 1]!;
      if (left > right) hash |= 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export function perceptualHashDistance(left: string, right: string): number {
  let difference = parsePerceptualHash(left) ^ parsePerceptualHash(right);
  let distance = 0;
  while (difference !== 0n) {
    difference &= difference - 1n;
    distance += 1;
  }
  return distance;
}

export interface FrameFingerprint {
  readonly perceptualHash: string;
  readonly sampleId: string;
  readonly sha256: string;
}

export interface FrameDeduplication {
  readonly canonicalSampleId: string;
  readonly exactContent: boolean;
  readonly perceptualDistance: number;
  readonly sampleId: string;
}

export function deduplicateFrameFingerprints(
  fingerprints: readonly FrameFingerprint[],
  maximumPerceptualDistance = 0,
): readonly FrameDeduplication[] {
  if (!Number.isSafeInteger(maximumPerceptualDistance) || maximumPerceptualDistance < 0 || maximumPerceptualDistance > 64) {
    throw new TypeError("maximumPerceptualDistance must be an integer between zero and 64.");
  }
  const ordered = [...fingerprints].sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  if (new Set(ordered.map(frame => frame.sampleId)).size !== ordered.length) {
    throw new TypeError("Frame fingerprint sample IDs must be unique.");
  }
  for (const frame of ordered) {
    requireSha256(frame.sha256, "Frame sha256");
    parsePerceptualHash(frame.perceptualHash);
  }

  const prior: FrameFingerprint[] = [];
  const canonicalBySampleId = new Map<string, string>();
  return ordered.map((frame) => {
    const exactMatch = prior.find(candidate => frame.sha256 === candidate.sha256);
    const perceptualMatch = exactMatch === undefined
      ? prior.find(candidate =>
        perceptualHashDistance(frame.perceptualHash, candidate.perceptualHash) <= maximumPerceptualDistance)
      : undefined;
    const match = exactMatch ?? perceptualMatch;
    if (match === undefined) {
      prior.push(frame);
      canonicalBySampleId.set(frame.sampleId, frame.sampleId);
      return {
        canonicalSampleId: frame.sampleId,
        exactContent: true,
        perceptualDistance: 0,
        sampleId: frame.sampleId,
      };
    }
    const distance = perceptualHashDistance(frame.perceptualHash, match.perceptualHash);
    const canonicalSampleId = canonicalBySampleId.get(match.sampleId);
    if (canonicalSampleId === undefined) throw new TypeError("Frame deduplication state is inconsistent.");
    prior.push(frame);
    canonicalBySampleId.set(frame.sampleId, canonicalSampleId);
    return {
      canonicalSampleId,
      exactContent: exactMatch !== undefined,
      perceptualDistance: distance,
      sampleId: frame.sampleId,
    };
  });
}

export interface BatchableSceneFrame {
  readonly actualAssetTimeUs: number;
  readonly bytes: number;
  readonly sampleId: string;
  readonly sha256: string;
}

export interface BatchableScene {
  readonly frames: readonly BatchableSceneFrame[];
  readonly rangeStartUs: number;
  readonly sceneId: string;
}

export interface PlannedSceneBatch {
  readonly batch: {
    readonly batchKey: string;
    readonly errorCode: null;
    readonly imageBytes: number;
    readonly imageCount: number;
    readonly sceneIds: readonly string[];
    readonly state: "planned";
  };
  readonly frames: readonly (BatchableSceneFrame & { readonly sceneId: string })[];
}

function validateBatchableScene(scene: BatchableScene): void {
  requireSafeMicroseconds(scene.rangeStartUs, "Scene rangeStartUs", true);
  if (!/^scene_[a-z0-9][a-z0-9_-]{7,63}$/u.test(scene.sceneId)) {
    throw new TypeError("Batch scene IDs must be opaque scene identifiers.");
  }
  if (scene.frames.length < 1 || scene.frames.length > SCENE_BATCH_LIMITS.imageCount) {
    throw new TypeError("Each batchable scene must have between one and twelve frames.");
  }
  let bytes = 0;
  const sampleIds = new Set<string>();
  for (const frame of scene.frames) {
    if (!/^sample_[a-z0-9][a-z0-9_-]{7,63}$/u.test(frame.sampleId)) {
      throw new TypeError("Batch sample IDs must be opaque sample identifiers.");
    }
    if (sampleIds.has(frame.sampleId)) throw new TypeError("Batch sample IDs must be unique within a scene.");
    sampleIds.add(frame.sampleId);
    requireSha256(frame.sha256, "Batch frame sha256");
    requireSafeMicroseconds(frame.actualAssetTimeUs, "Batch frame actualAssetTimeUs", true);
    requireSafeMicroseconds(frame.bytes, "Batch frame bytes", false);
    bytes += frame.bytes;
  }
  if (bytes > SCENE_BATCH_LIMITS.imageBytes) {
    throw new TypeError("A scene exceeds the six-megabyte gateway batch limit.");
  }
}

function makeBatch(
  contextDigest: string,
  scenes: readonly BatchableScene[],
): PlannedSceneBatch {
  const frames = scenes.flatMap(scene => [...scene.frames]
    .sort((left, right) =>
      left.actualAssetTimeUs - right.actualAssetTimeUs || left.sampleId.localeCompare(right.sampleId))
    .map(frame => ({ ...frame, sceneId: scene.sceneId })));
  const sceneIds = scenes.map(scene => scene.sceneId);
  const imageBytes = frames.reduce((total, frame) => total + frame.bytes, 0);
  return {
    batch: {
      batchKey: canonicalJsonSha256({
        contextDigest,
        frames: frames.map(frame => ({
          actualAssetTimeUs: frame.actualAssetTimeUs,
          bytes: frame.bytes,
          sampleId: frame.sampleId,
          sceneId: frame.sceneId,
          sha256: frame.sha256,
        })),
        sceneIds,
        version: 1,
      }),
      errorCode: null,
      imageBytes,
      imageCount: frames.length,
      sceneIds,
      state: "planned",
    },
    frames,
  };
}

export function planSceneBatches(
  contextDigest: string,
  inputScenes: readonly BatchableScene[],
): readonly PlannedSceneBatch[] {
  requireSha256(contextDigest, "Batch contextDigest");
  const scenes = [...inputScenes].sort((left, right) =>
    left.rangeStartUs - right.rangeStartUs || left.sceneId.localeCompare(right.sceneId));
  if (new Set(scenes.map(scene => scene.sceneId)).size !== scenes.length) {
    throw new TypeError("Batch scene IDs must be unique.");
  }
  for (const scene of scenes) validateBatchableScene(scene);

  const batches: PlannedSceneBatch[] = [];
  let pending: BatchableScene[] = [];
  let pendingBytes = 0;
  let pendingImages = 0;
  const flush = () => {
    if (pending.length > 0) batches.push(makeBatch(contextDigest, pending));
    pending = [];
    pendingBytes = 0;
    pendingImages = 0;
  };

  for (const scene of scenes) {
    const sceneBytes = scene.frames.reduce((total, frame) => total + frame.bytes, 0);
    const wouldOverflow = pending.length >= SCENE_BATCH_LIMITS.sceneCount
      || pendingImages + scene.frames.length > SCENE_BATCH_LIMITS.imageCount
      || pendingBytes + sceneBytes > SCENE_BATCH_LIMITS.imageBytes;
    if (wouldOverflow) flush();
    pending.push(scene);
    pendingBytes += sceneBytes;
    pendingImages += scene.frames.length;
  }
  flush();
  return batches;
}
