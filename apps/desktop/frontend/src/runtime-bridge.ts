import type { NativeSdkJson } from "@native-sdk/cli";

import {
  DesktopEventSchema,
  DesktopRequestSchema,
  DesktopResponseSchema,
  ATET_DESKTOP_PROTOCOL,
  ATET_DESKTOP_PROTOCOL_VERSION,
  type CaptureDomainCommand,
  type CaptureRuntimeSnapshot,
  type DesktopEvent,
} from "../../contracts";

export const ATET_RUNTIME_SNAPSHOT_COMMAND = "atet.runtime.snapshot";
export const ATET_RUNTIME_DISPATCH_COMMAND = "atet.runtime.dispatch";
export const ATET_RUNTIME_EVENT = "atet.runtime.event";

export interface NativeRuntimeTransport {
  invoke(command: string, payload?: NativeSdkJson): Promise<unknown>;
  on(name: string, listener: (detail: unknown) => void): () => void;
}

export interface RuntimeBridgeListener {
  onEvent(event: DesktopEvent): void;
  onMalformedEvent(error: RuntimeBridgeProtocolError): void;
}

export interface RuntimeBridge {
  dispatch(command: CaptureDomainCommand): Promise<CaptureRuntimeSnapshot>;
  snapshot(): Promise<CaptureRuntimeSnapshot>;
  subscribe(listener: RuntimeBridgeListener): () => void;
}

export class RuntimeBridgeProtocolError extends Error {
  readonly boundary: "event" | "request" | "response";
  override readonly cause: unknown;

  constructor(boundary: RuntimeBridgeProtocolError["boundary"], cause: unknown) {
    super(`The native recorder returned an invalid ${boundary}.`, { cause });
    this.name = "RuntimeBridgeProtocolError";
    this.boundary = boundary;
    this.cause = cause;
  }
}

export class RuntimeBridgeCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "RuntimeBridgeCommandError";
    this.code = code;
    this.retryable = retryable;
  }
}

function nativeJson(value: unknown, path = "$payload"): NativeSdkJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => nativeJson(item, `${path}[${index}]`));
  if (typeof value !== "object") throw new TypeError(`${path} cannot cross the native JSON bridge.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} contains a non-plain object.`);
  }
  const output: Record<string, NativeSdkJson> = {};
  for (const [key, item] of Object.entries(value)) output[key] = nativeJson(item, `${path}.${key}`);
  return output;
}

function defaultRequestId(): string {
  return `request_${crypto.randomUUID().replaceAll("-", "")}`;
}

function request(
  requestId: string,
  payload: { readonly kind: "snapshot" } | { readonly command: CaptureDomainCommand; readonly kind: "dispatch" },
) {
  try {
    return DesktopRequestSchema.parse({
      payload,
      protocol: ATET_DESKTOP_PROTOCOL,
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      requestId,
    });
  } catch (error: unknown) {
    throw new RuntimeBridgeProtocolError("request", error);
  }
}

function response(value: unknown, requestId: string): CaptureRuntimeSnapshot {
  let parsed: ReturnType<typeof DesktopResponseSchema.parse>;
  try {
    parsed = DesktopResponseSchema.parse(value);
  } catch (error: unknown) {
    throw new RuntimeBridgeProtocolError("response", error);
  }
  if (parsed.requestId !== requestId) {
    throw new RuntimeBridgeProtocolError("response", new Error("Native response requestId does not match."));
  }
  if (!parsed.ok) {
    throw new RuntimeBridgeCommandError(parsed.error.code, parsed.error.message, parsed.error.retryable);
  }
  return parsed.snapshot;
}

export interface RuntimeBridgeOptions {
  readonly createRequestId?: () => string;
}

export function createRuntimeBridge(
  transport: NativeRuntimeTransport,
  options: RuntimeBridgeOptions = {},
): RuntimeBridge {
  const createRequestId = options.createRequestId ?? defaultRequestId;
  const invoke = async (
    commandName: string,
    payload: Parameters<typeof request>[1],
  ): Promise<CaptureRuntimeSnapshot> => {
    const requestId = createRequestId();
    const envelope = request(requestId, payload);
    return response(await transport.invoke(commandName, nativeJson(envelope)), requestId);
  };
  return Object.freeze({
    dispatch: async (command: CaptureDomainCommand) => await invoke(
      ATET_RUNTIME_DISPATCH_COMMAND,
      { command, kind: "dispatch" },
    ),
    snapshot: async () => await invoke(ATET_RUNTIME_SNAPSHOT_COMMAND, { kind: "snapshot" }),
    subscribe(listener: RuntimeBridgeListener) {
      return transport.on(ATET_RUNTIME_EVENT, (detail) => {
        try {
          listener.onEvent(DesktopEventSchema.parse(detail));
        } catch (error: unknown) {
          listener.onMalformedEvent(new RuntimeBridgeProtocolError("event", error));
        }
      });
    },
  });
}

export function detectRuntimeBridge(): RuntimeBridge | null {
  if (typeof window === "undefined" || !("zero" in window)) return null;
  return createRuntimeBridge(window.zero);
}
