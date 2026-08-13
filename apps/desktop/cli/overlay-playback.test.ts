import { describe, expect, test } from "bun:test";

import { CliError } from "./errors";
import {
  MAX_ANIMATED_OVERLAY_AUDIO_LOOP_BYTES,
  assertAudioLoopBufferWithinLimit,
  assertVideoLoopBufferWithinLimit,
  resolveAnimatedPlaybackWindow,
  resolveAudibleSourceRange,
} from "./overlay-playback";

describe("resolveAnimatedPlaybackWindow", () => {
  test("defaults source-out to the immutable media end", () => {
    expect(resolveAnimatedPlaybackWindow({
      mediaDurationUs: 10_000_000,
      outputDurationUs: 2_000_000,
      playbackRate: 1.5,
      sourceInUs: 1_000_000,
      sourceOutUs: undefined,
    })).toEqual({ sourceInUs: 1_000_000, sourceOutUs: 10_000_000 });
  });

  test("keeps unused media available for mapped slow-motion output", () => {
    expect(resolveAnimatedPlaybackWindow({
      mediaDurationUs: 30_000_000,
      outputDurationUs: 20_000_000,
      playbackRate: 1,
      sourceInUs: 0,
      sourceOutUs: undefined,
    })).toEqual({ sourceInUs: 0, sourceOutUs: 30_000_000 });
  });

  test("clips a default playback window to short media", () => {
    expect(resolveAnimatedPlaybackWindow({
      mediaDurationUs: 2_000_000,
      outputDurationUs: 10_000_000,
      playbackRate: 1,
      sourceInUs: 500_000,
      sourceOutUs: undefined,
    })).toEqual({ sourceInUs: 500_000, sourceOutUs: 2_000_000 });
  });

  test("rejects explicit windows outside the immutable asset", () => {
    expect(() => resolveAnimatedPlaybackWindow({
      mediaDurationUs: 2_000_000,
      outputDurationUs: 1_000_000,
      playbackRate: 1,
      sourceInUs: 500_000,
      sourceOutUs: 2_000_001,
    })).toThrow(CliError);
    expect(() => resolveAnimatedPlaybackWindow({
      mediaDurationUs: 2_000_000,
      outputDurationUs: 1_000_000,
      playbackRate: 1,
      sourceInUs: 2_000_000,
      sourceOutUs: undefined,
    })).toThrow(CliError);
  });
});

describe("resolveAudibleSourceRange", () => {
  test("intersects a selected non-looping window with delayed audio", () => {
    expect(resolveAudibleSourceRange({
      audioDelayUs: 5_000_000,
      audioEndUs: 7_000_000,
      endBehavior: "hide",
      requestedDurationUs: 10_000_000,
      requestedStartUs: 0,
      sourceWindowUs: 10_000_000,
    })).toEqual({ endUs: 7_000_000, startUs: 5_000_000 });
    expect(resolveAudibleSourceRange({
      audioDelayUs: 1_000_000,
      audioEndUs: 4_000_000,
      endBehavior: "hide",
      requestedDurationUs: 4_000_000,
      requestedStartUs: 0,
      sourceWindowUs: 4_000_000,
    })).toEqual({ endUs: 4_000_000, startUs: 1_000_000 });
    expect(resolveAudibleSourceRange({
      audioDelayUs: 5_000_000,
      audioEndUs: 4_000_000,
      endBehavior: "freeze-end",
      requestedDurationUs: 4_000_000,
      requestedStartUs: 0,
      sourceWindowUs: 4_000_000,
    })).toBeNull();
  });

  test("finds audible bounds without treating loop silence prefixes as audible", () => {
    expect(resolveAudibleSourceRange({
      audioDelayUs: 250_000,
      audioEndUs: 1_000_000,
      endBehavior: "loop",
      requestedDurationUs: 3_000_000,
      requestedStartUs: 0,
      sourceWindowUs: 1_000_000,
    })).toEqual({ endUs: 3_000_000, startUs: 250_000 });
    expect(resolveAudibleSourceRange({
      audioDelayUs: 250_000,
      audioEndUs: 1_000_000,
      endBehavior: "loop",
      requestedDurationUs: 200_000,
      requestedStartUs: 1_000_000,
      sourceWindowUs: 1_000_000,
    })).toBeNull();
    expect(resolveAudibleSourceRange({
      audioDelayUs: 250_000,
      audioEndUs: 750_000,
      endBehavior: "loop",
      requestedDurationUs: 3_000_000,
      requestedStartUs: 0,
      sourceWindowUs: 1_000_000,
    })).toEqual({ endUs: 2_750_000, startUs: 250_000 });
  });
});

describe("decoded animated overlay loop bounds", () => {
  test("accounts for aligned RGBA video frames", () => {
    expect(() => assertVideoLoopBufferWithinLimit({
      frameCount: 30,
      label: "1080p overlay",
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    })).not.toThrow();
    expect(() => assertVideoLoopBufferWithinLimit({
      frameCount: 30,
      label: "4K overlay",
      pixelHeight: 2_160,
      pixelWidth: 3_840,
    })).toThrow(/decoded video loop buffer bound/u);
  });

  test("accounts for packed float stereo audio samples", () => {
    const exactSampleLimit = MAX_ANIMATED_OVERLAY_AUDIO_LOOP_BYTES / 8;
    expect(() => assertAudioLoopBufferWithinLimit({
      label: "bounded audio",
      sampleCount: exactSampleLimit,
    })).not.toThrow();
    expect(() => assertAudioLoopBufferWithinLimit({
      label: "oversized audio",
      sampleCount: exactSampleLimit + 1,
    })).toThrow(/decoded audio loop buffer bound/u);
  });
});
