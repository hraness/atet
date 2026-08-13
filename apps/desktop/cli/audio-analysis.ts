import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  AnalysisSubjectSchema,
  type AudioAlignmentAnalysisV1,
  type AnalysisSubject,
  type ProjectAssetV1,
  type ProjectPlacementV1,
  type VideoProjectV1,
} from "../contracts";
import { canonicalJsonSha256, hashPlacementSync, type EnvelopeSeries } from "../core";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import { ensurePrivateDirectory } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";

const ALIGNMENT_SAMPLE_RATE_HZ = 8_000;
const ALIGNMENT_HOP_SAMPLES = 400;
const MAXIMUM_PCM_BYTES = 32 * 1024 * 1024 * 1024;

function parseSubjectReference(reference: string): { readonly assetId: string; readonly streamId: string } {
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1 || reference.indexOf(":", separator + 1) !== -1) {
    throw new CliError("usage", `Media stream must use <asset-id>:<stream-id>: ${reference}`);
  }
  return { assetId: reference.slice(0, separator), streamId: reference.slice(separator + 1) };
}

export function resolveAudioAnalysisSubject(
  project: VideoProjectV1,
  reference: string,
): { readonly asset: ProjectAssetV1; readonly stream: Extract<ProjectAssetV1["streams"][number], { readonly kind: "audio" }>; readonly subject: AnalysisSubject } {
  const selected = parseSubjectReference(reference);
  const asset = project.assets.find(candidate => candidate.assetId === selected.assetId);
  if (asset === undefined) throw new CliError("not-found", `Unknown project asset: ${selected.assetId}`);
  const stream = asset.streams.find(candidate => candidate.streamId === selected.streamId);
  if (stream?.kind !== "audio") throw new CliError("not-found", `Unknown audio stream on ${selected.assetId}: ${selected.streamId}`);
  const subject = AnalysisSubjectSchema.parse({
    assetId: asset.assetId,
    integritySha256: canonicalJsonSha256({ assetDurationUs: asset.durationUs, stream }),
    streamId: stream.streamId,
  });
  return { asset, stream, subject };
}

export function alignmentInputDigest(input: {
  readonly config: AudioAlignmentAnalysisV1["config"];
  readonly reference: AnalysisSubject;
  readonly referencePlacement: ProjectPlacementV1;
  readonly target: AnalysisSubject;
  readonly targetPlacement: ProjectPlacementV1;
}): string {
  return canonicalJsonSha256({
    config: input.config,
    reference: input.reference,
    referencePlacement: {
      assetId: input.referencePlacement.assetId,
      assetRange: input.referencePlacement.assetRange,
      placementId: input.referencePlacement.placementId,
      syncMapSha256: hashPlacementSync(input.referencePlacement),
    },
    target: input.target,
    targetPlacement: {
      assetId: input.targetPlacement.assetId,
      assetRange: input.targetPlacement.assetRange,
      placementId: input.targetPlacement.placementId,
    },
  });
}

function seconds(microseconds: number): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

export async function decodeAlignmentPcm(
  projectDirectory: string,
  repositoryRoot: string,
  ffmpeg: string,
  runner: ProcessRunner,
  stream: Extract<ProjectAssetV1["streams"][number], { readonly kind: "audio" }>,
  maximumOutputBytes = MAXIMUM_PCM_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < Float32Array.BYTES_PER_ELEMENT) {
    throw new CliError("usage", "Decoded alignment PCM byte limit must be a positive safe integer.");
  }
  const assetDurationUs = stream.segments.at(-1)?.assetRange.endUs ?? 0;
  const expectedSamples = Math.round(assetDurationUs * ALIGNMENT_SAMPLE_RATE_HZ / 1_000_000);
  const expectedBytes = expectedSamples * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumOutputBytes) {
    throw new CliError(
      "invalid-data",
      `Decoded alignment PCM would exceed its ${maximumOutputBytes}-byte resource bound.`,
      { expectedBytes, maximumOutputBytes },
    );
  }
  const cacheRoot = join(projectDirectory, "analysis", "cache");
  await ensurePrivateDirectory(join(projectDirectory, "analysis"));
  await ensurePrivateDirectory(cacheRoot);
  const output = join(cacheRoot, `.alignment-${randomUUID()}.f32le`);
  const inputArguments: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  let priorEndUs = 0;
  for (const [index, segment] of stream.segments.entries()) {
    if (segment.assetRange.startUs > priorEndUs) {
      const gap = `gap_${index}`;
      filters.push(`anullsrc=r=${ALIGNMENT_SAMPLE_RATE_HZ}:cl=mono:d=${seconds(segment.assetRange.startUs - priorEndUs)}[${gap}]`);
      labels.push(gap);
    }
    inputArguments.push("-i", await resolveVerifiedProjectMedia({
      expected: { bytes: segment.bytes, sha256: segment.sha256 },
      label: `Audio segment ${segment.path}:${segment.streamIndex}`,
      path: segment.path,
      repositoryRoot,
    }));
    const label = `audio_${index}`;
    filters.push(
      `[${index}:${segment.streamIndex}]atrim=start=${seconds(segment.fileRange.startUs)}:end=${seconds(segment.fileRange.endUs)},asetpts=PTS-STARTPTS,aresample=${ALIGNMENT_SAMPLE_RATE_HZ},aformat=sample_fmts=flt:channel_layouts=mono[${label}]`,
    );
    labels.push(label);
    priorEndUs = segment.assetRange.endUs;
  }
  if (labels.length === 0) throw new CliError("invalid-data", `Audio stream ${stream.streamId} has no media segments.`);
  filters.push(`${labels.map(label => `[${label}]`).join("")}concat=n=${labels.length}:v=0:a=1[decoded]`);
  const result = await runner.run([
    ffmpeg,
    "-hide_banner", "-nostdin", "-y",
    ...inputArguments,
    "-filter_complex", filters.join(";"),
    "-map", "[decoded]",
    "-f", "f32le",
    "-ac", "1",
    "-ar", String(ALIGNMENT_SAMPLE_RATE_HZ),
    "-t", seconds(assetDurationUs),
    "-fs", String(maximumOutputBytes),
    output,
  ], { maxOutputBytes: 1_000_000 });
  if (result.exitCode !== 0) {
    await rm(output, { force: true });
    throw new CliError("subprocess", `FFmpeg audio decode failed: ${result.stderr.trim().slice(-4_000) || `exit ${result.exitCode}`}`);
  }
  const details = await lstat(output);
  const actualSamples = details.size / Float32Array.BYTES_PER_ELEMENT;
  const sampleTolerance = Math.max(2, stream.segments.length * 2);
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || details.size <= 0
    || details.size > maximumOutputBytes
    || details.size % Float32Array.BYTES_PER_ELEMENT !== 0
    || Math.abs(actualSamples - expectedSamples) > sampleTolerance
  ) {
    await rm(output, { force: true });
    throw new CliError(
      "invalid-data",
      "FFmpeg alignment decode produced unsafe, oversized, or incomplete PCM timeline coverage.",
      { actualSamples, expectedSamples, sampleTolerance },
    );
  }
  return output;
}

export async function readAlignmentEnvelope(path: string): Promise<EnvelopeSeries> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const values: number[] = [];
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let carry = Buffer.alloc(0);
  let samplesInHop = 0;
  let squareSum = 0;
  let differenceSum = 0;
  let priorSample = 0;
  let totalBytes = 0;
  try {
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      totalBytes += read.bytesRead;
      if (totalBytes > MAXIMUM_PCM_BYTES) throw new CliError("invalid-data", "Decoded alignment PCM exceeds its 32 GiB bound.");
      const bytes = carry.length === 0
        ? buffer.subarray(0, read.bytesRead)
        : Buffer.concat([carry, buffer.subarray(0, read.bytesRead)]);
      const usable = bytes.length - bytes.length % 4;
      for (let offset = 0; offset < usable; offset += 4) {
        const sample = bytes.readFloatLE(offset);
        if (!Number.isFinite(sample)) throw new CliError("invalid-data", "Decoded alignment PCM contains a non-finite sample.");
        squareSum += sample * sample;
        differenceSum += Math.abs(sample - priorSample);
        priorSample = sample;
        samplesInHop += 1;
        if (samplesInHop === ALIGNMENT_HOP_SAMPLES) {
          const rms = Math.sqrt(squareSum / samplesInHop);
          values.push(rms + differenceSum / samplesInHop);
          samplesInHop = 0;
          squareSum = 0;
          differenceSum = 0;
        }
      }
      carry = Buffer.from(bytes.subarray(usable));
    }
    if (carry.length !== 0) throw new CliError("invalid-data", "Decoded alignment PCM has a partial float sample.");
    if (samplesInHop > 0) values.push(Math.sqrt(squareSum / samplesInHop) + differenceSum / samplesInHop);
  } finally {
    await handle.close();
  }
  return {
    hopUs: Math.round(ALIGNMENT_HOP_SAMPLES * 1_000_000 / ALIGNMENT_SAMPLE_RATE_HZ),
    startUs: 0,
    values,
  };
}

export async function withAlignmentEnvelopes<T>(
  options: {
    readonly ffmpeg: string;
    readonly projectDirectory: string;
    readonly reference: Extract<ProjectAssetV1["streams"][number], { readonly kind: "audio" }>;
    readonly repositoryRoot: string;
    readonly runner: ProcessRunner;
    readonly target: Extract<ProjectAssetV1["streams"][number], { readonly kind: "audio" }>;
  },
  callback: (reference: EnvelopeSeries, target: EnvelopeSeries) => Promise<T> | T,
): Promise<T> {
  const paths: string[] = [];
  try {
    const referencePath = await decodeAlignmentPcm(
      options.projectDirectory,
      options.repositoryRoot,
      options.ffmpeg,
      options.runner,
      options.reference,
    );
    paths.push(referencePath);
    const targetPath = await decodeAlignmentPcm(
      options.projectDirectory,
      options.repositoryRoot,
      options.ffmpeg,
      options.runner,
      options.target,
    );
    paths.push(targetPath);
    const [reference, target] = await Promise.all([
      readAlignmentEnvelope(referencePath),
      readAlignmentEnvelope(targetPath),
    ]);
    return await callback(reference, target);
  } finally {
    await Promise.all(paths.map(async path => await rm(path, { force: true })));
  }
}
