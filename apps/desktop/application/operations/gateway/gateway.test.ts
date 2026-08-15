import { describe, expect, test } from "bun:test";

import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import {
  GatewayImageOperationInputSchema,
  GatewayOperationResultSchema,
  GatewayProviderOptionsReferenceSchema,
  GatewayVideoOperationInputSchema,
  gatewayRequestId,
  reconcileGatewayOperation,
  type ApplicationGatewayPort,
  type GatewayOperationName,
  type GatewayOperationResult,
  type GatewayPortDispatch,
  type GatewayPortReconcile,
} from "../../gateway-port";
import type {
  OperationExecutionContext,
  OperationRequest,
} from "../../operation";
import { OperationRegistry } from "../../registry";
import { operationApplicationContext } from "../test-support";
import {
  gatewayImageOperationDefinition,
  gatewaySpeechOperationDefinition,
  gatewayTranscriptionOperationDefinition,
  gatewayVideoOperationDefinition,
} from "./index";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NODE_PLAN_HASH = "d".repeat(64);

const IMAGE_SOURCE = {
  bytes: 1_024,
  facts: { height: 1_080, width: 1_920 },
  mediaType: "image/png",
  path: "artifacts/atet/private/gateway/input.png",
  sha256: HASH_A,
} as const;

const AUDIO_SOURCE = {
  bytes: 2_048,
  facts: { durationSeconds: 2.5 },
  mediaType: "audio/wav",
  path: "artifacts/atet/private/gateway/input.wav",
  sha256: HASH_B,
} as const;

const PROVIDER_OPTIONS = {
  namespaces: ["gateway", "openai"],
  sha256: HASH_C,
} as const;

function mediaTypeFor(operation: GatewayOperationName): string {
  switch (operation) {
    case "image": return "image/png";
    case "video": return "video/mp4";
    case "speech": return "audio/mpeg";
    case "transcription": return "application/json";
  }
}

function gatewayResult(
  dispatch: Pick<GatewayPortDispatch, "request" | "requestId">,
): GatewayOperationResult {
  const operation = dispatch.request.operation;
  return GatewayOperationResultSchema.parse({
    model: dispatch.request.request.model,
    operation,
    outputs: [{
      bytes: 4_096,
      mediaType: mediaTypeFor(operation),
      path: `artifacts/atet/generated/gateway/${operation}/${HASH_A}`,
      sha256: HASH_A,
    }],
    receipt: {
      bytes: 512,
      path: `artifacts/atet/generated/gateway/${operation}/${HASH_B}.json`,
      sha256: HASH_B,
    },
    requestId: dispatch.requestId,
    ...(operation === "transcription"
      ? {
          transcript: {
            characters: 11,
            durationSeconds: 2.5,
            language: "en",
            segments: 2,
            textSha256: HASH_C,
          },
        }
      : {}),
  });
}

class GatewayPortFixture implements ApplicationGatewayPort {
  readonly dispatches: GatewayPortDispatch[] = [];
  readonly preparations: GatewayPortDispatch["request"][] = [];
  readonly reconciliations: GatewayPortReconcile[] = [];
  dispatchHandler: (
    input: GatewayPortDispatch,
  ) => Promise<unknown> = input => Promise.resolve(gatewayResult(input));
  reconcileHandler: (
    input: GatewayPortReconcile,
  ) => Promise<unknown> = input => Promise.resolve({
    operation: input.request.operation,
    requestId: input.requestId,
    status: "not-dispatched",
  });

  dispatch(input: GatewayPortDispatch): Promise<unknown> {
    this.dispatches.push(input);
    return this.dispatchHandler(input);
  }

  prepare(input: {
    readonly request: GatewayPortDispatch["request"];
  }): Promise<unknown> {
    this.preparations.push(input.request);
    return Promise.resolve(input.request);
  }

  reconcile(input: GatewayPortReconcile): Promise<unknown> {
    this.reconciliations.push(input);
    return this.reconcileHandler(input);
  }
}

function registry(): OperationRegistry {
  const result = new OperationRegistry();
  result.register(gatewayImageOperationDefinition);
  result.register(gatewayVideoOperationDefinition);
  result.register(gatewaySpeechOperationDefinition);
  result.register(gatewayTranscriptionOperationDefinition);
  return result;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject.");
}

function application(
  gatewayPort?: ApplicationGatewayPort,
): ApplicationContext {
  return {
    ...operationApplicationContext("/private/repository"),
    ...(gatewayPort === undefined ? {} : { gatewayPort }),
  };
}

function executionContext(
  port: ApplicationGatewayPort | undefined,
  nodeKey: string,
  options: Readonly<{
    abortSignal?: AbortSignal;
    beforePublication?: () => Promise<void>;
    workflow?: boolean;
  }> = {},
): OperationExecutionContext {
  return {
    abortSignal: options.abortSignal ?? new AbortController().signal,
    application: application(port),
    ...(options.workflow === false
      ? {}
      : {
          workflow: {
            beforePublication:
              options.beforePublication ?? (() => Promise.resolve()),
            nodeKey,
            nodePlanSha256: NODE_PLAN_HASH,
            runId: "run_gateway01",
            workspaceDirectory:
              `/private/repository/artifacts/atet/private/runs/${nodeKey}`,
          },
        }),
  };
}

const REQUESTS = [
  {
    input: {
      images: [IMAGE_SOURCE],
      model: "openai/image-fixture",
      prompt: "Create a launch-card image.",
      providerOptions: PROVIDER_OPTIONS,
    },
    kind: "gateway.image",
    operation: "image",
    version: 1,
  },
  {
    input: {
      frames: [{ frameType: "first_frame", source: IMAGE_SOURCE }],
      model: "google/video-fixture",
      prompt: "Pan slowly across the scene.",
      providerOptions: PROVIDER_OPTIONS,
    },
    kind: "gateway.video",
    operation: "video",
    version: 1,
  },
  {
    input: {
      model: "openai/speech-fixture",
      providerOptions: PROVIDER_OPTIONS,
      text: "Ship the launch.",
      voice: "alloy",
    },
    kind: "gateway.speech",
    operation: "speech",
    version: 1,
  },
  {
    input: {
      audio: AUDIO_SOURCE,
      model: "openai/transcription-fixture",
      providerOptions: PROVIDER_OPTIONS,
    },
    kind: "gateway.transcription",
    operation: "transcription",
    version: 1,
  },
] as const satisfies readonly (
  OperationRequest & { readonly operation: GatewayOperationName }
)[];

describe("Gateway application operations", () => {
  test("dispatches every modality once through the host port with an exact stable request identity", async () => {
    const port = new GatewayPortFixture();
    const operations = registry();
    for (const request of REQUESTS) {
      const result = await operations.execute(
        executionContext(port, request.operation),
        request,
      );
      const expectedRequestId = gatewayRequestId({
        nodeKey: request.operation,
        nodePlanSha256: NODE_PLAN_HASH,
        operation: request.operation,
        runId: "run_gateway01",
      });
      expect(result.receiptReference).toBe(
        `artifacts/atet/generated/gateway/${request.operation}/${HASH_B}.json`,
      );
      expect(result.output).toMatchObject({
        model: request.input.model,
        operation: request.operation,
        requestId: expectedRequestId,
      });
      expect(result.summary.fields).toMatchObject({
        bytes: 4_096,
        model: request.input.model,
        outputs: 1,
        requestId: expectedRequestId,
      });
    }

    expect(port.dispatches).toHaveLength(4);
    expect(port.dispatches.map(dispatch => dispatch.request.operation)).toEqual([
      "image",
      "video",
      "speech",
      "transcription",
    ]);
    expect(port.dispatches.every(dispatch => (
      dispatch.request.request.providerOptions?.sha256 === HASH_C
      && !JSON.stringify(dispatch.request).includes("apiKey")
    ))).toBe(true);
    expect(
      gatewayRequestId({
        nodeKey: "image",
        nodePlanSha256: NODE_PLAN_HASH,
        operation: "image",
        runId: "run_gateway01",
      }),
    ).not.toBe(
      gatewayRequestId({
        nodeKey: "image",
        nodePlanSha256: NODE_PLAN_HASH,
        operation: "video",
        runId: "run_gateway01",
      }),
    );
  });

  test("publishes honest paid-dispatch discovery and requires provider preparation", () => {
    const discovery = new Map(
      registry().list().map(item => [item.kind, item]),
    );
    for (const kind of [
      "gateway.image",
      "gateway.video",
      "gateway.speech",
      "gateway.transcription",
    ] as const) {
      const operation = discovery.get(kind)!;
      expect(operation.lifecycle).toBe("paid-dispatch");
      expect(operation.policy).toMatchObject({
        cache: "exact-run",
        cancellable: true,
        effect: "paid-cloud",
        resume: "ambiguous-after-dispatch",
      });
      expect(operation.policy.preparation).toContain("provider-options");
      expect(operation.policy.resources).toEqual([
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
        { amount: 1, resource: "output-publication" },
      ]);
    }
    expect(discovery.get("gateway.speech")!.policy.preparation)
      .not.toContain("local-media");
    for (const kind of [
      "gateway.image",
      "gateway.video",
      "gateway.transcription",
    ] as const) {
      expect(discovery.get(kind)!.policy.preparation).toContain("local-media");
    }
  });

  test("keeps authorization and raw provider options out of serialized requests", async () => {
    const port = new GatewayPortFixture();
    const operations = registry();
    expect(await rejection(operations.execute(
      executionContext(port, "image", { workflow: false }),
      REQUESTS[0],
    ))).toMatchObject({ code: "authorization-required" });
    expect(port.dispatches).toHaveLength(0);

    expect(await rejection(operations.execute(
      executionContext(undefined, "image"),
      REQUESTS[0],
    ))).toMatchObject({ code: "unavailable" });

    expect(GatewayProviderOptionsReferenceSchema.safeParse({
      openai: { apiKey: "must-not-cross-the-operation-boundary" },
    }).success).toBe(false);
    expect(GatewayProviderOptionsReferenceSchema.safeParse({
      namespaces: ["openai", "gateway"],
      sha256: HASH_C,
    }).success).toBe(false);
    expect(GatewayImageOperationInputSchema.safeParse({
      apiKey: "must-not-cross-the-operation-boundary",
      images: [],
      model: "openai/image-fixture",
      prompt: "test",
    }).success).toBe(false);
  });

  test("fails closed on paid-media shapes the host service cannot execute exactly", () => {
    expect(GatewayImageOperationInputSchema.safeParse({
      mask: IMAGE_SOURCE,
      model: "openai/image-fixture",
      prompt: "test",
    }).success).toBe(false);
    expect(GatewayImageOperationInputSchema.safeParse({
      aspectRatio: "16:9",
      maxImagesPerCall: 1,
      model: "openai/image-fixture",
      n: 2,
      prompt: "test",
      size: "1920x1080",
    }).success).toBe(false);
    expect(GatewayVideoOperationInputSchema.safeParse({
      frames: [{ frameType: "last_frame", source: IMAGE_SOURCE }],
      model: "google/video-fixture",
      prompt: "",
    }).success).toBe(false);
    expect(GatewayVideoOperationInputSchema.safeParse({
      frames: [{ frameType: "first_frame", source: IMAGE_SOURCE }],
      model: "google/video-fixture",
      prompt: "",
      references: [AUDIO_SOURCE],
    }).success).toBe(false);
    expect(GatewayOperationResultSchema.safeParse({
      model: "openai/image-fixture",
      operation: "image",
      outputs: [{
        bytes: 4_096,
        mediaType: "video/mp4",
        path: `artifacts/atet/generated/gateway/image/${HASH_A}`,
        sha256: HASH_A,
      }],
      receipt: {
        bytes: 512,
        path: `artifacts/atet/generated/gateway/image/${HASH_B}.json`,
        sha256: HASH_B,
      },
      requestId: gatewayRequestId({
        nodeKey: "image",
        nodePlanSha256: NODE_PLAN_HASH,
        operation: "image",
        runId: "run_gateway01",
      }),
    }).success).toBe(false);
  });

  test("checks the run fence immediately before dispatch and propagates the exact abort signal", async () => {
    const events: string[] = [];
    const port = new GatewayPortFixture();
    const abortController = new AbortController();
    port.dispatchHandler = input => new Promise((_resolve, reject) => {
      events.push("dispatch");
      expect(input.signal).toBe(abortController.signal);
      input.signal.addEventListener("abort", () => {
        reject(new ApplicationError("cancelled", "fixture cancelled"));
      }, { once: true });
    });
    const pending = registry().execute(
      executionContext(port, "image", {
        abortSignal: abortController.signal,
        beforePublication: () => {
          events.push("fence");
          return Promise.resolve();
        },
      }),
      REQUESTS[0],
    );
    await Promise.resolve();
    abortController.abort();
    expect(await rejection(pending)).toMatchObject({ code: "cancelled" });
    expect(events).toEqual(["fence", "dispatch"]);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(await rejection(registry().execute(
      executionContext(port, "video", {
        abortSignal: alreadyAborted.signal,
        beforePublication: () => {
          events.push("unexpected-fence");
          return Promise.resolve();
        },
      }),
      REQUESTS[1],
    ))).toMatchObject({ code: "cancelled" });
    expect(events).toEqual(["fence", "dispatch"]);
  });

  test("rejects mismatched and non-content-addressed port results", async () => {
    const port = new GatewayPortFixture();
    port.dispatchHandler = input => Promise.resolve({
      ...gatewayResult(input),
      requestId: gatewayRequestId({
        nodeKey: "different-node",
        nodePlanSha256: NODE_PLAN_HASH,
        operation: input.request.operation,
        runId: "run_gateway01",
      }),
    });
    expect(await rejection(registry().execute(
      executionContext(port, "image"),
      REQUESTS[0],
    ))).toMatchObject({ code: "conflict" });

    port.dispatchHandler = input => Promise.resolve({
      ...gatewayResult(input),
      outputs: [{
        bytes: 4_096,
        mediaType: "image/png",
        path: "/tmp/authority-bearing-output.png",
        sha256: HASH_A,
      }],
    });
    expect(await rejection(registry().execute(
      executionContext(port, "image"),
      REQUESTS[0],
    ))).toBeInstanceOf(Error);
  });

  test("reconciles only the exact request and preserves paid-dispatch ambiguity states", async () => {
    const port = new GatewayPortFixture();
    const requestId = gatewayRequestId({
      nodeKey: "speech",
      nodePlanSha256: NODE_PLAN_HASH,
      operation: "speech",
      runId: "run_gateway01",
    });
    port.reconcileHandler = input => Promise.resolve({
      operation: input.request.operation,
      requestId: input.requestId,
      result: gatewayResult({
        request: {
          operation: "speech",
          request: {
            model: "openai/speech-fixture",
            text: "Ship the launch.",
          },
        },
        requestId: input.requestId,
      }),
      status: "completed",
    });
    const completed = await reconcileGatewayOperation(application(port), {
      request: {
        operation: "speech",
        request: {
          model: "openai/speech-fixture",
          text: "Ship the launch.",
        },
      },
      requestId,
      signal: new AbortController().signal,
    });
    expect(completed.status).toBe("completed");
    expect(port.reconciliations).toHaveLength(1);

    port.reconcileHandler = input => Promise.resolve({
      operation: input.request.operation,
      requestId: input.requestId,
      result: {
        ...gatewayResult({
          request: input.request,
          requestId: input.requestId,
        }),
        model: "openai/different-speech-model",
      },
      status: "completed",
    });
    expect(await rejection(reconcileGatewayOperation(application(port), {
      request: {
        operation: "speech",
        request: {
          model: "openai/speech-fixture",
          text: "Ship the launch.",
        },
      },
      requestId,
      signal: new AbortController().signal,
    }))).toMatchObject({ code: "conflict" });

    port.reconcileHandler = input => Promise.resolve({
      operation: "video",
      requestId: input.requestId,
      status: "dispatched",
    });
    expect(await rejection(reconcileGatewayOperation(application(port), {
      request: {
        operation: "speech",
        request: {
          model: "openai/speech-fixture",
          text: "Ship the launch.",
        },
      },
      requestId,
      signal: new AbortController().signal,
    }))).toMatchObject({ code: "conflict" });
  });
});
