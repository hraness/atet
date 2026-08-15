import { describe, expect, test } from "bun:test";

import {
  CODE_WORKER_PROTOCOL,
  CodeWorkerMessageSchema,
  WorkerFrameDecoder,
  encodeCodeWorkerDiagnosticBarrier,
  encodeWorkerFrame,
} from "./worker-protocol";

const request = CodeWorkerMessageSchema.parse({
  action: "compute",
  computeKey: "editorial.decisions",
  generation: 2,
  input: { ranges: [1, 2, 3] },
  kind: "request",
  nodeKey: "editorial-decisions",
  protocol: CODE_WORKER_PROTOCOL,
  replayAcknowledged: false,
  requestId: "request_1",
});

describe("code worker framed protocol", () => {
  test("decodes every byte split and coalesced frames", () => {
    const frame = encodeWorkerFrame(request);
    for (let split = 0; split <= frame.byteLength; split += 1) {
      const decoder = new WorkerFrameDecoder();
      const messages = [
        ...decoder.push(frame.subarray(0, split)),
        ...decoder.push(frame.subarray(split)),
      ];
      decoder.finish();
      expect(messages).toEqual([request]);
    }

    const combined = new Uint8Array(frame.byteLength * 2);
    combined.set(frame);
    combined.set(frame, frame.byteLength);
    const decoder = new WorkerFrameDecoder();
    expect(decoder.push(combined)).toEqual([request, request]);
    decoder.finish();
  });

  test("rejects oversize before allocating a body and rejects invalid UTF-8", () => {
    const oversize = new Uint8Array(4);
    new DataView(oversize.buffer).setUint32(0, 129, false);
    expect(() => new WorkerFrameDecoder(128).push(oversize)).toThrow("declares 129 bytes");

    const invalid = new Uint8Array([0, 0, 0, 1, 0xff]);
    expect(() => new WorkerFrameDecoder().push(invalid)).toThrow("UTF-8 JSON");
  });

  test("rejects truncated, wrong-version, and unknown-field messages", () => {
    const frame = encodeWorkerFrame(request);
    expect(request.protocol).toBe("atet.code-worker/v5");
    const decoder = new WorkerFrameDecoder();
    decoder.push(frame.subarray(0, frame.byteLength - 1));
    expect(() => decoder.finish()).toThrow("truncated");

    expect(() => encodeWorkerFrame({
      ...request,
      protocol: "atet.code-worker/v999",
    })).toThrow();
    expect(() => encodeWorkerFrame({ ...request, secret: "no" })).toThrow();
  });

  test("requires an exact target request for compute cancellation", () => {
    const cancellation = CodeWorkerMessageSchema.parse({
      action: "cancel",
      generation: 2,
      kind: "request",
      protocol: CODE_WORKER_PROTOCOL,
      requestId: "cancel_1",
      targetRequestId: "request_1",
    });
    const decoder = new WorkerFrameDecoder();
    expect(decoder.push(encodeWorkerFrame(cancellation))).toEqual([cancellation]);
    decoder.finish();

    expect(() => encodeWorkerFrame({
      action: "cancel",
      generation: 2,
      kind: "request",
      protocol: CODE_WORKER_PROTOCOL,
      requestId: "cancel_1",
    })).toThrow();
  });

  test("requires a response-bound marker for both diagnostic streams", () => {
    const response = CodeWorkerMessageSchema.parse({
      diagnosticBarrier: "build_0123456789abcdef",
      generation: 2,
      kind: "response",
      output: { built: true },
      protocol: CODE_WORKER_PROTOCOL,
      requestId: "build_0123456789abcdef",
      status: "ok",
    });
    expect(response).toMatchObject({
      diagnosticBarrier: "build_0123456789abcdef",
      requestId: "build_0123456789abcdef",
    });
    expect(encodeCodeWorkerDiagnosticBarrier(
      "build_0123456789abcdef",
      "stdout",
    )).not.toEqual(encodeCodeWorkerDiagnosticBarrier(
      "build_0123456789abcdef",
      "stderr",
    ));
    expect(() => CodeWorkerMessageSchema.parse({
      generation: 2,
      kind: "response",
      output: { built: true },
      protocol: CODE_WORKER_PROTOCOL,
      requestId: "build_0123456789abcdef",
      status: "ok",
    })).toThrow();
  });
});
