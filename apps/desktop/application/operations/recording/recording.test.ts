import { describe, expect, test } from "bun:test";

import type {
  ApplicationContext,
  ApplicationRecordingController,
} from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationExecutionContext, OperationRequest } from "../../operation";
import { OperationRegistry } from "../../registry";
import { operationApplicationContext } from "../test-support";
import {
  recordingPauseOperationDefinition,
  RecordingPauseInputSchema,
} from "./pause";
import {
  recordingResumeOperationDefinition,
  RecordingResumeInputSchema,
} from "./resume";
import {
  MAX_RECORDING_OPERATION_DISPLAYS,
  parseRecordingOperationOutput,
  RecordingOperationOutputSchema,
  RecordingStartInputSchema,
} from "./shared";
import {
  recordingStartOperationDefinition,
  recordingStartOperationDefinitionV1,
  RecordingStartInputV1Schema,
  RecordingStartOutputV1Schema,
} from "./start";
import {
  recordingStopOperationDefinition,
  RecordingStopInputSchema,
} from "./stop";

type RecordingAction = Parameters<
  ApplicationRecordingController["execute"]
>[0];

interface RecordingControllerCall {
  readonly action: RecordingAction;
  readonly options?: unknown;
}

const AUTHORIZED_PERMISSIONS = {
  accessibility: "authorized",
  camera: "authorized",
  inputMonitoring: "authorized",
  microphone: "authorized",
  screenCapture: "authorized",
  systemAudio: "authorized",
  windowMetadata: "authorized",
} as const;

const EXPLICIT_START_INPUT = RecordingStartInputSchema.parse({
  camera: { deviceId: "camera-external", kind: "device" },
  displays: {
    displayIds: ["display-primary", "display-secondary"],
    kind: "selected",
  },
  microphone: { deviceId: "microphone-usb", kind: "device" },
  strictInputs: true,
  systemAudio: true,
  typedText: true,
});

const LEGACY_START_INPUT = RecordingStartInputV1Schema.parse({
  displaySelection: {
    displayIds: ["display-primary", "display-secondary"],
    kind: "explicit",
  },
  microphone: true,
  strictInputs: true,
  systemAudio: true,
  typedText: true,
  webcam: true,
});

function controllerSnapshot(
  action: RecordingAction,
): Readonly<Record<string, unknown>> {
  const state = action === "pause"
    ? "paused"
    : action === "stop"
      ? "idle"
      : "recording";
  return {
    completedSegmentCount: action === "start" ? 0 : action === "stop" ? 2 : 1,
    effectiveConfig: {
      ...EXPLICIT_START_INPUT,
      metadata: true,
    },
    logicalTimeUs: action === "start" ? 0 : action === "stop" ? 4_000_000 : 2_000_000,
    permissions: AUTHORIZED_PERMISSIONS,
    recordingId: "rec_operation01",
    recordingRoot: "/private/repository/artifacts/transmute/recordings/rec_operation01",
    state,
    updatedAt: `2026-07-23T15:00:0${
      action === "start" ? "0" : action === "pause" ? "1" : action === "resume" ? "2" : "3"
    }.000Z`,
  };
}

class RecordingControllerFixture implements ApplicationRecordingController {
  readonly calls: RecordingControllerCall[] = [];
  readonly #snapshots: Readonly<Record<RecordingAction, unknown>>;
  statusCalls = 0;

  constructor(
    snapshots: Readonly<Record<RecordingAction, unknown>> = {
      pause: controllerSnapshot("pause"),
      resume: controllerSnapshot("resume"),
      start: controllerSnapshot("start"),
      stop: controllerSnapshot("stop"),
    },
  ) {
    this.#snapshots = snapshots;
  }

  execute(action: RecordingAction, options?: unknown): Promise<unknown> {
    this.calls.push(options === undefined ? { action } : { action, options });
    return Promise.resolve(this.#snapshots[action]);
  }

  status(): Promise<unknown> {
    this.statusCalls += 1;
    return Promise.reject(new Error("Recording operations must not probe controller status."));
  }
}

function recordingRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  registry.register(recordingStartOperationDefinitionV1);
  registry.register(recordingStartOperationDefinition);
  registry.register(recordingPauseOperationDefinition);
  registry.register(recordingResumeOperationDefinition);
  registry.register(recordingStopOperationDefinition);
  return registry;
}

function executionContext(
  recordingController?: ApplicationRecordingController,
  abortSignal: AbortSignal = new AbortController().signal,
): OperationExecutionContext {
  const base = operationApplicationContext("/private/repository");
  const application: ApplicationContext = {
    ...base,
    ...(recordingController === undefined ? {} : { recordingController }),
  };
  return {
    abortSignal,
    application,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject.");
}

const TRANSITION_REQUESTS = [
  { input: {}, kind: "recording.pause", version: 1 },
  { input: {}, kind: "recording.resume", version: 1 },
  { input: {}, kind: "recording.stop", version: 1 },
] as const satisfies readonly OperationRequest[];

describe("recording application operations", () => {
  test("delegates every action exactly once and leaves the state machine in the controller", async () => {
    const controller = new RecordingControllerFixture();
    const registry = recordingRegistry();
    const start = await registry.execute(executionContext(controller), {
      input: EXPLICIT_START_INPUT,
      kind: "recording.start",
      version: 2,
    });
    const transitions = [];
    for (const request of TRANSITION_REQUESTS) {
      transitions.push(await registry.execute(executionContext(controller), request));
    }

    expect(controller.calls).toEqual([
      { action: "start", options: EXPLICIT_START_INPUT },
      { action: "pause" },
      { action: "resume" },
      { action: "stop" },
    ]);
    expect(controller.statusCalls).toBe(0);

    const outputs = [start, ...transitions].map(result => (
      RecordingOperationOutputSchema.parse(result.output)
    ));
    expect(outputs.map(output => output.state)).toEqual([
      "recording",
      "paused",
      "recording",
      "idle",
    ]);
    expect(outputs.map(output => output.completedSegmentCount)).toEqual([
      0,
      1,
      1,
      2,
    ]);
    for (const [index, result] of [start, ...transitions].entries()) {
      expect(result.output).not.toHaveProperty("recordingRoot");
      expect(result.summary).toEqual({
        fields: {
          completedSegmentCount: outputs[index]!.completedSegmentCount,
          logicalTimeUs: outputs[index]!.logicalTimeUs,
          recordingId: "rec_operation01",
          state: outputs[index]!.state,
          updatedAt: outputs[index]!.updatedAt,
        },
        kind: result.kind,
      });
      expect(JSON.stringify(result)).not.toContain("/private/repository");
    }
  });

  test("accepts default and exact bounded source selections", () => {
    expect(RecordingStartInputSchema.parse({
      camera: { kind: "disabled" },
      displays: { kind: "all" },
      microphone: { kind: "default" },
      strictInputs: false,
      systemAudio: false,
      typedText: false,
    })).toEqual({
      camera: { kind: "disabled" },
      displays: { kind: "all" },
      microphone: { kind: "default" },
      strictInputs: false,
      systemAudio: false,
      typedText: false,
    });
    expect(EXPLICIT_START_INPUT.displays).toEqual({
      displayIds: ["display-primary", "display-secondary"],
      kind: "selected",
    });
    expect(EXPLICIT_START_INPUT.camera).toEqual({
      deviceId: "camera-external",
      kind: "device",
    });
  });

  test("keeps authored recording.start@1 graphs executable through an exact compatibility adapter", async () => {
    const controller = new RecordingControllerFixture();
    const result = await recordingRegistry().execute(
      executionContext(controller),
      {
        input: LEGACY_START_INPUT,
        kind: "recording.start",
        version: 1,
      },
    );

    expect(controller.calls).toEqual([{
      action: "start",
      options: {
        camera: { kind: "default" },
        displays: {
          displayIds: ["display-primary", "display-secondary"],
          kind: "selected",
        },
        microphone: { kind: "default" },
        strictInputs: true,
        systemAudio: true,
        typedText: true,
      },
    }]);
    expect(RecordingStartOutputV1Schema.parse(result.output).effectiveConfig)
      .toEqual({
        displaySelection: {
          displayIds: ["display-primary", "display-secondary"],
          kind: "explicit",
        },
        metadata: true,
        microphone: true,
        strictInputs: true,
        systemAudio: true,
        typedText: true,
        webcam: true,
      });
    expect(result.version).toBe(1);
  });

  test("rejects unbounded, duplicate, incomplete, and non-strict inputs", () => {
    const input = {
      ...EXPLICIT_START_INPUT,
      displays: {
        displayIds: Array.from(
          { length: MAX_RECORDING_OPERATION_DISPLAYS + 1 },
          (_, index) => `display-${String(index)}`,
        ),
        kind: "selected",
      },
    };
    expect(() => RecordingStartInputSchema.parse(input)).toThrow();
    expect(() => RecordingStartInputSchema.parse({
      ...EXPLICIT_START_INPUT,
      displays: {
        displayIds: ["display-primary", "display-primary"],
        kind: "selected",
      },
    })).toThrow();
    expect(() => RecordingStartInputSchema.parse({
      ...EXPLICIT_START_INPUT,
      displays: {
        displayIds: ["x".repeat(257)],
        kind: "selected",
      },
    })).toThrow();
    expect(() => RecordingStartInputSchema.parse({
      camera: { kind: "disabled" },
      displays: { kind: "all" },
      strictInputs: false,
      systemAudio: false,
      typedText: false,
    })).toThrow();
    expect(() => RecordingStartInputSchema.parse({
      ...EXPLICIT_START_INPUT,
      extra: true,
    })).toThrow();
    expect(() => RecordingPauseInputSchema.parse({ extra: true })).toThrow();
    expect(() => RecordingResumeInputSchema.parse({ extra: true })).toThrow();
    expect(() => RecordingStopInputSchema.parse({ extra: true })).toThrow();
  });

  test("rejects an unavailable controller for every action", async () => {
    const registry = recordingRegistry();
    const requests: readonly OperationRequest[] = [{
      input: EXPLICIT_START_INPUT,
      kind: "recording.start",
      version: 2,
    }, ...TRANSITION_REQUESTS];
    for (const request of requests) {
      expect(await rejection(
        registry.execute(executionContext(), request),
      )).toMatchObject({
        code: "unavailable",
        message: "Recording controller is unavailable.",
      });
    }
  });

  test("rejects invalid controller snapshots without exposing their recording root", async () => {
    const invalid = {
      ...controllerSnapshot("pause"),
      unexpected: "/private/secret",
    };
    expect(() => parseRecordingOperationOutput(invalid)).toThrow(
      "Recording controller returned an invalid bounded snapshot.",
    );
    const controller = new RecordingControllerFixture({
      pause: invalid,
      resume: controllerSnapshot("resume"),
      start: controllerSnapshot("start"),
      stop: controllerSnapshot("stop"),
    });
    expect(await rejection(recordingRegistry().execute(executionContext(controller), {
      input: {},
      kind: "recording.pause",
      version: 1,
    }))).toMatchObject({
      code: "invalid-data",
      message: "Recording controller returned an invalid bounded snapshot.",
    });
  });

  test("does not dispatch a live action when execution is already cancelled", async () => {
    const controller = new RecordingControllerFixture();
    const abort = new AbortController();
    abort.abort();
    expect(await rejection(recordingRegistry().execute(
      executionContext(controller, abort.signal),
      {
        input: EXPLICIT_START_INPUT,
        kind: "recording.start",
        version: 2,
      },
    ))).toMatchObject({ code: "cancelled" });
    expect(controller.calls).toEqual([]);
    expect(controller.statusCalls).toBe(0);
  });

  test("revalidates the workflow fence immediately before a live action", async () => {
    const controller = new RecordingControllerFixture();
    const context: OperationExecutionContext = {
      ...executionContext(controller),
      workflow: {
        beforePublication: () => Promise.reject(new ApplicationError(
          "cancelled",
          "The durable workflow fence is no longer current.",
        )),
        nodeKey: "recording-start",
        nodePlanSha256: "a".repeat(64),
        runId: "run_recording01",
        workspaceDirectory: "/private/repository/artifacts/transmute/private/workflow-runs/test",
      },
    };
    expect(await rejection(recordingRegistry().execute(context, {
      input: EXPLICIT_START_INPUT,
      kind: "recording.start",
      version: 2,
    }))).toMatchObject({ code: "cancelled" });
    expect(controller.calls).toEqual([]);
  });

  test("claims exclusive bounded non-resumable live-control policy", () => {
    const definitions = [
      recordingStartOperationDefinitionV1,
      recordingStartOperationDefinition,
      recordingPauseOperationDefinition,
      recordingResumeOperationDefinition,
      recordingStopOperationDefinition,
    ];
    for (const definition of definitions) {
      expect(definition.lifecycle.kind).toBe("live-control");
      expect(definition.policy).toMatchObject({
        cache: "none",
        cancellable: false,
        effect: "live-control",
        maxFanOut: 0,
        resources: [{ amount: 1, resource: "capture-device" }],
        resume: "non-resumable-live",
      });
      expect(definition.policy.maxDurationMs).toBeGreaterThan(0);
      expect(definition.policy.maxInputBytes).toBeGreaterThan(0);
      expect(definition.policy.maxOutputBytes).toBeGreaterThan(0);
    }
    expect(recordingStartOperationDefinition.policy.preparation).toEqual([
      "recording-metadata",
      "screen-capture",
      "camera",
      "microphone",
      "system-audio",
      "typed-text",
      "window-metadata",
    ]);
    for (const definition of [
      recordingPauseOperationDefinition,
      recordingResumeOperationDefinition,
      recordingStopOperationDefinition,
    ]) {
      expect(definition.policy.preparation).toEqual([]);
    }
  });
});
