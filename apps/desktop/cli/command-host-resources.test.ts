import { describe, expect, test } from "bun:test";

import {
  createProcessLocalHostResourceCoordinator,
  defaultTransmuteHostResourceProfile,
} from "@hraness/transmute/host-resources";

import type { CliCommand } from "./args";
import {
  codePreparationHostResourceClaims,
  combineHostResourceClaims,
  commandHostResourceClaims,
  computeWorkerPoolSize,
  hostResourceClaimsCover,
  missingHostResourceClaims,
  replayComputeWorkerPoolSize,
} from "./command-host-resources";

function command(value: Readonly<Record<string, unknown>>): CliCommand {
  return value as unknown as CliCommand;
}

const coordinator = createProcessLocalHostResourceCoordinator({
  profile: defaultTransmuteHostResourceProfile(8),
});

describe("CLI command host-resource policy", () => {
  test("expands every FFmpeg command to the complete physical pools", () => {
    for (const value of [
      { kind: "align-analyze" },
      { kind: "analyze-inactivity" },
      { kind: "analyze-music" },
      { execute: false, kind: "analyze-scenes" },
      { kind: "media-audio" },
      { kind: "media-color" },
    ]) {
      expect(commandHostResourceClaims(command(value), coordinator))
        .toEqual([
          { amount: 6, resource: "cpu" },
          { amount: 2, resource: "ffmpeg" },
          { amount: 1, resource: "local-io" },
        ]);
    }
  });

  test("keeps inspection and static overlay preparation outside the encoder pool", () => {
    for (const value of [
      { kind: "project-add" },
      { kind: "project-overlay-edit" },
      { edit: { operation: "overlay-add" }, kind: "edit" },
    ]) {
      expect(commandHostResourceClaims(command(value), coordinator))
        .toEqual([
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ]);
    }
  });

  test("serializes video renders and reserves specialized analysis pools", () => {
    expect(commandHostResourceClaims(command({
      kind: "media-compose",
    }), coordinator)).toEqual([
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "video-encode" },
    ]);
    expect(commandHostResourceClaims(command({
      action: "run",
      kind: "project-render",
    }), coordinator)).toEqual([
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "video-encode" },
    ]);
    expect(commandHostResourceClaims(command({
      kind: "analyze-speech",
    }), coordinator)).toEqual([
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "whisper" },
    ]);
    expect(commandHostResourceClaims(command({
      kind: "analyze-faces",
    }), coordinator)).toEqual([
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "vision" },
    ]);
  });

  test("keeps scheduler-owned workflow execution out of outer admission", () => {
    for (const kind of ["code-run", "runs-resume", "workflows-run"]) {
      expect(commandHostResourceClaims(command({ kind }), coordinator))
        .toEqual([]);
    }
  });

  test("exclusively admits unbudgeted code preparation without wrapping execution", () => {
    const expected = [
      { amount: 6, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ];
    expect(codePreparationHostResourceClaims(coordinator)).toEqual(expected);
    for (const kind of ["code-check", "code-plan", "workflows-plan"]) {
      expect(commandHostResourceClaims(command({ kind }), coordinator))
        .toEqual(expected);
    }
    for (const kind of ["code-run", "runs-resume"]) {
      expect(commandHostResourceClaims(command({ kind }), coordinator))
        .toEqual([]);
    }
  });

  test("does not start trusted-code workers that the CPU profile cannot admit", () => {
    const singleCpu = createProcessLocalHostResourceCoordinator({
      profile: {
        capacities: [{ limit: 1, resource: "cpu" }],
        id: "transmute.cli-test/single-cpu/v1",
      },
    });
    expect(computeWorkerPoolSize(8, 4, singleCpu)).toBe(1);
    expect(computeWorkerPoolSize(2, 4, coordinator)).toBe(2);
    expect(computeWorkerPoolSize(8, 1, coordinator)).toBe(1);
    expect(() => computeWorkerPoolSize(0, 1, coordinator)).toThrow(
      "positive safe integers",
    );
  });

  test("caps persisted replay workers by unique nodes and physical CPU", () => {
    const replayCoordinator = createProcessLocalHostResourceCoordinator({
      profile: {
        capacities: [{ limit: 2, resource: "cpu" }],
        id: "transmute.cli-test/replay-two-cpu/v1",
      },
    });
    expect(replayComputeWorkerPoolSize(
      64,
      ["recover/a", "recover/b", "recover/a", "recover/c"],
      replayCoordinator,
    )).toBe(2);
  });

  test("keeps paid network waits outside local media capacity", () => {
    for (const kind of [
      "ai-image-generate",
      "ai-speech-generate",
      "ai-transcribe",
      "ai-video-generate",
    ]) {
      expect(commandHostResourceClaims(command({ kind }), coordinator))
        .toEqual([
          { amount: 1, resource: "network" },
          { amount: 1, resource: "paid-call" },
        ]);
    }
    expect(commandHostResourceClaims(command({
      kind: "image-vectorize",
    }), coordinator)).toEqual([
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ]);
  });

  test("requires the active lease to cover every nested media claim", () => {
    expect(hostResourceClaimsCover([
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "paid-call" },
    ], [
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
    ])).toBe(true);
    expect(hostResourceClaimsCover([
      { amount: 1, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "paid-call" },
    ], [
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
    ])).toBe(false);
    expect(missingHostResourceClaims([
      { amount: 1, resource: "network" },
      { amount: 1, resource: "paid-call" },
    ], [
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
    ])).toEqual([
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
    ]);
    const partialLease = [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "network" },
    ] as const;
    const localPhase = [
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
    ] as const;
    const missingPartial = missingHostResourceClaims(partialLease, localPhase);
    expect(missingPartial).toEqual([
      { amount: 5, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
    ]);
    expect(combineHostResourceClaims(partialLease, missingPartial)).toEqual([
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "network" },
    ]);
    expect(combineHostResourceClaims([
      { amount: 1, resource: "network" },
      { amount: 1, resource: "paid-call" },
    ], [
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
    ])).toEqual([
      { amount: 6, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "network" },
      { amount: 1, resource: "paid-call" },
    ]);
  });
});
