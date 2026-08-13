import { CliError } from "./errors";

export const MAX_ANIMATED_OVERLAY_VIDEO_LOOP_BYTES = 512 * 1024 * 1024;
export const MAX_ANIMATED_OVERLAY_AUDIO_LOOP_BYTES = 64 * 1024 * 1024;
const RGBA_BYTES_PER_PIXEL = 4;
const FLOAT32_STEREO_BYTES_PER_SAMPLE = 8;
const VIDEO_ROW_ALIGNMENT_BYTES = 64;

export interface AudibleSourceRangeOptions {
  readonly audioDelayUs: number;
  readonly audioEndUs: number;
  readonly endBehavior: "freeze-end" | "hide" | "loop";
  readonly requestedDurationUs: number;
  readonly requestedStartUs: number;
  readonly sourceWindowUs: number;
}

export interface AudibleSourceRange {
  readonly endUs: number;
  readonly startUs: number;
}

export function resolveAudibleSourceRange(options: AudibleSourceRangeOptions): AudibleSourceRange | null {
  const {
    audioDelayUs,
    audioEndUs,
    endBehavior,
    requestedDurationUs,
    requestedStartUs,
    sourceWindowUs,
  } = options;
  const requestedEndUs = requestedStartUs + requestedDurationUs;
  if (
    !Number.isSafeInteger(audioDelayUs)
    || !Number.isSafeInteger(audioEndUs)
    || !Number.isSafeInteger(requestedDurationUs)
    || !Number.isSafeInteger(requestedStartUs)
    || !Number.isSafeInteger(requestedEndUs)
    || !Number.isSafeInteger(sourceWindowUs)
    || audioDelayUs < 0
    || audioEndUs < 0
    || requestedDurationUs <= 0
    || requestedStartUs < 0
    || sourceWindowUs <= 0
    || audioEndUs > sourceWindowUs
  ) {
    throw new CliError("unsupported-plan", "Animated overlay audio has an unsupported playback window.");
  }

  if (audioEndUs <= audioDelayUs) return null;
  if (endBehavior !== "loop") {
    const startUs = Math.max(requestedStartUs, audioDelayUs);
    const endUs = Math.min(requestedEndUs, audioEndUs);
    return endUs > startUs ? { endUs, startUs } : null;
  }

  const positionInFirstCycleUs = requestedStartUs % sourceWindowUs;
  const firstAudibleUs = positionInFirstCycleUs < audioDelayUs
    ? requestedStartUs + audioDelayUs - positionInFirstCycleUs
    : positionInFirstCycleUs < audioEndUs
      ? requestedStartUs
      : requestedStartUs + sourceWindowUs - positionInFirstCycleUs + audioDelayUs;
  const endPositionUs = requestedEndUs % sourceWindowUs;
  const lastAudibleUs = endPositionUs === 0
    ? requestedEndUs - sourceWindowUs + audioEndUs
    : endPositionUs <= audioDelayUs
      ? requestedEndUs - endPositionUs - sourceWindowUs + audioEndUs
      : endPositionUs <= audioEndUs
        ? requestedEndUs
        : requestedEndUs - endPositionUs + audioEndUs;
  return lastAudibleUs > firstAudibleUs
    ? { endUs: lastAudibleUs, startUs: firstAudibleUs }
    : null;
}

export function assertVideoLoopBufferWithinLimit(options: {
  readonly frameCount: number;
  readonly label: string;
  readonly pixelHeight: number;
  readonly pixelWidth: number;
}): void {
  const { frameCount, label, pixelHeight, pixelWidth } = options;
  const rowBytes = Math.ceil(pixelWidth * RGBA_BYTES_PER_PIXEL / VIDEO_ROW_ALIGNMENT_BYTES)
    * VIDEO_ROW_ALIGNMENT_BYTES;
  const frameBytes = rowBytes * pixelHeight;
  if (
    !Number.isSafeInteger(frameCount)
    || frameCount <= 0
    || !Number.isSafeInteger(pixelHeight)
    || pixelHeight <= 0
    || !Number.isSafeInteger(pixelWidth)
    || pixelWidth <= 0
    || !Number.isSafeInteger(frameBytes)
    || frameBytes <= 0
    || frameCount > Math.floor(MAX_ANIMATED_OVERLAY_VIDEO_LOOP_BYTES / frameBytes)
  ) {
    throw new CliError(
      "unsupported-plan",
      `${label} exceeds the ${MAX_ANIMATED_OVERLAY_VIDEO_LOOP_BYTES}-byte decoded video loop buffer bound.`,
    );
  }
}

export function assertAudioLoopBufferWithinLimit(options: {
  readonly label: string;
  readonly sampleCount: number;
}): void {
  const { label, sampleCount } = options;
  if (
    !Number.isSafeInteger(sampleCount)
    || sampleCount <= 0
    || sampleCount > Math.floor(
      MAX_ANIMATED_OVERLAY_AUDIO_LOOP_BYTES / FLOAT32_STEREO_BYTES_PER_SAMPLE,
    )
  ) {
    throw new CliError(
      "unsupported-plan",
      `${label} exceeds the ${MAX_ANIMATED_OVERLAY_AUDIO_LOOP_BYTES}-byte decoded audio loop buffer bound.`,
    );
  }
}

export interface AnimatedPlaybackWindowOptions {
  readonly mediaDurationUs: number;
  readonly outputDurationUs: number;
  readonly playbackRate: number;
  readonly sourceInUs: number;
  readonly sourceOutUs: number | undefined;
}

export interface AnimatedPlaybackWindow {
  readonly sourceInUs: number;
  readonly sourceOutUs: number;
}

export function resolveAnimatedPlaybackWindow(
  options: AnimatedPlaybackWindowOptions,
): AnimatedPlaybackWindow {
  const {
    mediaDurationUs,
    outputDurationUs,
    playbackRate,
    sourceInUs,
    sourceOutUs: explicitSourceOutUs,
  } = options;
  if (!Number.isSafeInteger(mediaDurationUs) || mediaDurationUs <= 0) {
    throw new CliError("invalid-data", "Animated overlay media has no positive, safe duration.");
  }
  if (!Number.isSafeInteger(sourceInUs) || sourceInUs < 0 || sourceInUs >= mediaDurationUs) {
    throw new CliError(
      "usage",
      `Animated overlay --source-in must be before the media duration (${mediaDurationUs}us).`,
    );
  }
  if (!Number.isSafeInteger(outputDurationUs) || outputDurationUs <= 0) {
    throw new CliError("usage", "Animated overlay output duration must be positive.");
  }
  if (!Number.isFinite(playbackRate) || playbackRate <= 0 || playbackRate > 64) {
    throw new CliError("usage", "Animated overlay --playback-rate must be greater than 0 and at most 64.");
  }

  // An omitted source-out means "through the immutable asset", not "for the
  // edit's current mapped duration". The renderer still trims to the output
  // range, while a later speed edit can reveal more source media without
  // silently turning a hide into an early hide/loop/freeze.
  const sourceOutUs = explicitSourceOutUs ?? mediaDurationUs;
  if (!Number.isSafeInteger(sourceOutUs) || sourceOutUs <= sourceInUs) {
    throw new CliError("usage", "Animated overlay --source-out must be after --source-in.");
  }
  if (sourceOutUs > mediaDurationUs) {
    throw new CliError(
      "usage",
      `Animated overlay --source-out exceeds the media duration (${mediaDurationUs}us).`,
    );
  }
  return { sourceInUs, sourceOutUs };
}
