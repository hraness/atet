import { z } from "zod";

import { ApplicationError } from "../application/errors";
import {
  ComputeKeySchema,
  JsonValueSchema,
  NodeKeySchema,
  OperationDiscoverySchema,
} from "./contracts";

export const CODE_WORKER_PROTOCOL = "studio.code-worker/v5";
export const MAX_CODE_WORKER_FRAME_BYTES = 4 * 1024 * 1024;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const CodeWorkerHelloSchema = z.strictObject({
  bunRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  bunVersion: z.string().min(1).max(128),
  bundleSha256: DigestSchema,
  generation: z.number().int().safe().positive(),
  kind: z.literal("hello"),
  protocol: z.literal(CODE_WORKER_PROTOCOL),
  workerEntrySha256: DigestSchema,
});

export const CodeWorkerRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("build"),
    generation: z.number().int().safe().positive(),
    inputMode: z.enum(["raw", "parsed"]),
    kind: z.literal("request"),
    protocol: z.literal(CODE_WORKER_PROTOCOL),
    registry: z.array(OperationDiscoverySchema).max(1_024),
    requestId: IdentifierSchema,
    workflowInput: JsonValueSchema,
  }),
  z.strictObject({
    action: z.literal("compute"),
    computeKey: ComputeKeySchema,
    generation: z.number().int().safe().positive(),
    input: JsonValueSchema,
    kind: z.literal("request"),
    nodeKey: NodeKeySchema,
    protocol: z.literal(CODE_WORKER_PROTOCOL),
    replayAcknowledged: z.boolean(),
    requestId: IdentifierSchema,
  }),
  z.strictObject({
    action: z.literal("cancel"),
    generation: z.number().int().safe().positive(),
    kind: z.literal("request"),
    protocol: z.literal(CODE_WORKER_PROTOCOL),
    requestId: IdentifierSchema,
    targetRequestId: IdentifierSchema,
  }),
  z.strictObject({
    action: z.literal("shutdown"),
    generation: z.number().int().safe().positive(),
    kind: z.literal("request"),
    protocol: z.literal(CODE_WORKER_PROTOCOL),
    requestId: IdentifierSchema,
  }),
]);

const CodeWorkerErrorSchema = z.strictObject({
  code: z.enum(["invalid-request", "invalid-output", "unknown-compute", "execution", "cancelled", "internal"]),
  message: z.string().min(1).max(2_000),
});

export const CodeWorkerResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    diagnosticBarrier: IdentifierSchema,
    generation: z.number().int().safe().positive(),
    kind: z.literal("response"),
    output: JsonValueSchema,
    protocol: z.literal(CODE_WORKER_PROTOCOL),
    requestId: IdentifierSchema,
    status: z.literal("ok"),
  }),
  z.strictObject({
    diagnosticBarrier: IdentifierSchema,
    error: CodeWorkerErrorSchema,
    generation: z.number().int().safe().positive(),
    kind: z.literal("response"),
    protocol: z.literal(CODE_WORKER_PROTOCOL),
    requestId: IdentifierSchema,
    status: z.literal("error"),
  }),
]);

export const CodeWorkerMessageSchema = z.union([
  CodeWorkerHelloSchema,
  CodeWorkerRequestSchema,
  CodeWorkerResponseSchema,
]);

export type CodeWorkerRequest = z.infer<typeof CodeWorkerRequestSchema>;
export type CodeWorkerResponse = z.infer<typeof CodeWorkerResponseSchema>;
export type CodeWorkerMessage = z.infer<typeof CodeWorkerMessageSchema>;

export type CodeWorkerDiagnosticStream = "stderr" | "stdout";

export function encodeCodeWorkerDiagnosticBarrier(
  barrier: string,
  stream: CodeWorkerDiagnosticStream,
): Uint8Array {
  const identifier = IdentifierSchema.parse(barrier);
  return new TextEncoder().encode(
    `\n\u001e${CODE_WORKER_PROTOCOL}:diagnostics:${stream}:${identifier}\u001f\n`,
  );
}

export const MAX_CODE_WORKER_DIAGNOSTIC_BARRIER_BYTES = Math.max(
  encodeCodeWorkerDiagnosticBarrier(`a${"a".repeat(127)}`, "stderr").byteLength,
  encodeCodeWorkerDiagnosticBarrier(`a${"a".repeat(127)}`, "stdout").byteLength,
);

function maximumFrameBytes(input: number | undefined): number {
  const value = input ?? MAX_CODE_WORKER_FRAME_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CODE_WORKER_FRAME_BYTES) {
    throw new ApplicationError(
      "usage",
      `Worker frame limit must be from 1 through ${String(MAX_CODE_WORKER_FRAME_BYTES)} bytes.`,
    );
  }
  return value;
}

export function encodeWorkerFrame(
  input: unknown,
  maximumBytes?: number,
): Uint8Array {
  const message = CodeWorkerMessageSchema.parse(input);
  const body = new TextEncoder().encode(JSON.stringify(message));
  const limit = maximumFrameBytes(maximumBytes);
  if (body.byteLength > limit) {
    throw new ApplicationError("invalid-data", `Worker frame exceeds ${String(limit)} bytes.`);
  }
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

export class WorkerFrameDecoder {
  readonly #bodyDecoder = new TextDecoder("utf-8", { fatal: true });
  readonly #header = new Uint8Array(4);
  readonly #maximumBytes: number;
  #body: Uint8Array | undefined;
  #bodyOffset = 0;
  #headerOffset = 0;

  constructor(maximumBytes?: number) {
    this.#maximumBytes = maximumFrameBytes(maximumBytes);
  }

  push(chunk: Uint8Array): readonly CodeWorkerMessage[] {
    const messages: CodeWorkerMessage[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#body === undefined) {
        const headerRemaining = 4 - this.#headerOffset;
        const copied = Math.min(headerRemaining, chunk.byteLength - offset);
        this.#header.set(chunk.subarray(offset, offset + copied), this.#headerOffset);
        this.#headerOffset += copied;
        offset += copied;
        if (this.#headerOffset < 4) continue;
        const length = new DataView(
          this.#header.buffer,
          this.#header.byteOffset,
          this.#header.byteLength,
        ).getUint32(0, false);
        this.#headerOffset = 0;
        if (length === 0 || length > this.#maximumBytes) {
          throw new ApplicationError(
            "invalid-data",
            `Worker frame declares ${String(length)} bytes; limit is ${String(this.#maximumBytes)}.`,
          );
        }
        this.#body = new Uint8Array(length);
        this.#bodyOffset = 0;
      }
      const body = this.#body;
      const bodyRemaining = body.byteLength - this.#bodyOffset;
      const copied = Math.min(bodyRemaining, chunk.byteLength - offset);
      body.set(chunk.subarray(offset, offset + copied), this.#bodyOffset);
      this.#bodyOffset += copied;
      offset += copied;
      if (this.#bodyOffset !== body.byteLength) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.#bodyDecoder.decode(body));
      } catch (error) {
        this.#body = undefined;
        this.#bodyOffset = 0;
        throw new ApplicationError("invalid-data", `Worker frame is not strict UTF-8 JSON: ${String(error)}`);
      }
      this.#body = undefined;
      this.#bodyOffset = 0;
      messages.push(CodeWorkerMessageSchema.parse(parsed));
    }
    return Object.freeze(messages);
  }

  finish(): void {
    if (this.#headerOffset !== 0 || this.#body !== undefined) {
      throw new ApplicationError("invalid-data", "Worker protocol ended with a truncated frame.");
    }
  }
}
