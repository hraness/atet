import type { NativeSdkJson } from "@native-sdk/cli";
import type {
  DirectActivityLease,
  DirectActivityScope,
} from "@hraness/direct/testing";

import {
  DesktopEventSchema,
  DesktopRequestSchema,
  DesktopResponseSchema,
  TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
  type CaptureRuntimeSnapshot,
  type DesktopEvent,
  type DesktopRequest,
  type DesktopResponse,
} from "../contracts";
import {
  TRANSMUTE_RUNTIME_DISPATCH_COMMAND,
  TRANSMUTE_RUNTIME_EVENT,
  TRANSMUTE_RUNTIME_SNAPSHOT_COMMAND,
  type NativeRuntimeTransport,
} from "../frontend/src/runtime-bridge";
import { parseTransmuteDirectWorld, type TransmuteDirectWorld } from "./world";

export interface TransmuteDirectInvocation {
  readonly command: string;
  readonly request: DesktopRequest;
}

export interface TransmuteDirectTransportSnapshot {
  readonly activityErrors: number;
  readonly blockedNetworkRequests: number;
  readonly disposed: boolean;
  readonly eventListeners: number;
  readonly invocations: readonly TransmuteDirectInvocation[];
  readonly protocolErrors: number;
  readonly remainingTransitions: number;
  readonly snapshot: CaptureRuntimeSnapshot;
}

export interface TransmuteDirectTransportHarness {
  readonly dispose: () => void;
  readonly getSnapshot: () => TransmuteDirectTransportSnapshot;
  readonly recordBlockedNetworkRequest: () => void;
  readonly transport: NativeRuntimeTransport;
}

export interface TransmuteDirectTransportOptions {
  readonly activity: DirectActivityScope;
  readonly signal: AbortSignal;
}

function successResponse(requestId: string, snapshot: CaptureRuntimeSnapshot): DesktopResponse {
  return DesktopResponseSchema.parse({
    ok: true,
    protocolVersion: TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
    requestId,
    snapshot,
  });
}

function errorResponse(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
): DesktopResponse {
  return DesktopResponseSchema.parse({
    error: { code, message, retryable },
    ok: false,
    protocolVersion: TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
    requestId,
  });
}

class DeterministicTransmuteTransport {
  readonly #activity: DirectActivityScope;
  readonly #signal: AbortSignal;
  readonly #world: TransmuteDirectWorld;
  readonly #listeners = new Set<(detail: unknown) => void>();
  readonly #invocations: TransmuteDirectInvocation[] = [];
  readonly #leases = new Set<DirectActivityLease>();
  readonly #pushTimers = new Map<
    ReturnType<typeof setTimeout>,
    DirectActivityLease
  >();
  #current: CaptureRuntimeSnapshot;
  #pushIndex = 0;
  #transitionIndex = 0;
  #activityErrors = 0;
  #protocolErrors = 0;
  #blockedNetworkRequests = 0;
  #disposed = false;

  constructor(world: TransmuteDirectWorld, options: TransmuteDirectTransportOptions) {
    this.#activity = options.activity;
    this.#signal = options.signal;
    this.#world = parseTransmuteDirectWorld(world);
    this.#current = structuredClone(this.#world.runtime.initial);
  }

  readonly transport: NativeRuntimeTransport = {
    invoke: (command, payload) => {
      try {
        this.#assertActive();
        const started = this.#activity.begin("desktop-invoke");
        if (!started.ok) throw new Error(started.error.message, { cause: started.error });
        const lease = started.value;
        this.#leases.add(lease);
        return Promise.resolve()
          .then(() => {
            this.#assertActive();
            return this.#invoke(command, payload);
          })
          .finally(() => {
            const settlementError = this.#releaseLease(lease);
            if (settlementError !== null) throw settlementError;
          });
      } catch (reason) {
        return Promise.reject(
          reason instanceof Error
            ? reason
            : new Error("Transmute Direct transport invocation failed.", { cause: reason }),
        );
      }
    },
    on: (name, listener) => {
      this.#assertActive();
      if (name !== TRANSMUTE_RUNTIME_EVENT) {
        throw new Error(`Direct received an unknown native event subscription: ${name}`);
      }
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
  };

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    for (const [timer, lease] of this.#pushTimers) {
      clearTimeout(timer);
      this.#pushTimers.delete(timer);
      this.#releaseLease(lease);
    }
    for (const lease of [...this.#leases]) this.#releaseLease(lease);
  }

  getSnapshot(): TransmuteDirectTransportSnapshot {
    return Object.freeze({
      activityErrors: this.#activityErrors,
      blockedNetworkRequests: this.#blockedNetworkRequests,
      disposed: this.#disposed,
      eventListeners: this.#listeners.size,
      invocations: Object.freeze(structuredClone(this.#invocations)),
      protocolErrors: this.#protocolErrors,
      remainingTransitions:
        this.#world.runtime.transitions.length - this.#transitionIndex
        + this.#world.runtime.pushes.length - this.#pushIndex,
      snapshot: structuredClone(this.#current),
    });
  }

  recordBlockedNetworkRequest(): void {
    if (!this.#disposed) this.#blockedNetworkRequests += 1;
  }

  #invoke(command: string, payload: NativeSdkJson | undefined): unknown {
    this.#assertActive();
    const parsed = DesktopRequestSchema.safeParse(payload);
    if (!parsed.success) {
      this.#protocolErrors += 1;
      throw new Error(`Direct rejected an invalid desktop request: ${parsed.error.message}`);
    }
    const request = parsed.data;
    this.#invocations.push({ command, request: structuredClone(request) });

    if (command === TRANSMUTE_RUNTIME_SNAPSHOT_COMMAND && request.payload.kind === "snapshot") {
      this.#schedulePushesAfterInitialSnapshot();
      return successResponse(request.requestId, this.#current);
    }
    if (command === TRANSMUTE_RUNTIME_DISPATCH_COMMAND && request.payload.kind === "dispatch") {
      return this.#dispatch(request);
    }
    this.#protocolErrors += 1;
    return errorResponse(
      request.requestId,
      "protocol_mismatch",
      `Command ${command} does not match request kind ${request.payload.kind}.`,
      false,
    );
  }

  #dispatch(request: DesktopRequest): DesktopResponse {
    if (request.payload.kind !== "dispatch") {
      throw new Error("Direct dispatch received a non-dispatch request.");
    }
    const transition = this.#world.runtime.transitions[this.#transitionIndex];
    const command = request.payload.command;
    if (transition === undefined || transition.command !== command.kind) {
      return errorResponse(
        request.requestId,
        "unexpected_command",
        `Scenario does not map ${command.kind} from its current state.`,
        false,
      );
    }
    this.#transitionIndex += 1;
    this.#current = structuredClone(transition.outcome.snapshot);
    this.#emit({
      kind: "snapshot-changed",
      protocolVersion: TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
      snapshot: this.#current,
    });
    this.#emit({
      commandId: command.commandId,
      kind: "command-settled",
      protocolVersion: TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
      status: transition.outcome.kind === "success" ? "succeeded" : "failed",
    });
    return transition.outcome.kind === "success"
      ? successResponse(request.requestId, this.#current)
      : errorResponse(
          request.requestId,
          transition.outcome.code,
          transition.outcome.message,
          transition.outcome.retryable,
        );
  }

  #emit(input: DesktopEvent): void {
    const event = DesktopEventSchema.parse(input);
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  #schedulePushesAfterInitialSnapshot(): void {
    while (this.#pushIndex < this.#world.runtime.pushes.length) {
      const push = this.#world.runtime.pushes[this.#pushIndex];
      this.#pushIndex += 1;
      if (push === undefined || push.after !== "initial-snapshot") {
        this.#protocolErrors += 1;
        continue;
      }
      const started = this.#activity.begin("desktop-runtime-push");
      if (!started.ok) {
        this.#activityErrors += 1;
        continue;
      }
      const lease = started.value;
      this.#leases.add(lease);
      const timer = setTimeout(() => {
        this.#pushTimers.delete(timer);
        try {
          this.#assertActive();
          this.#current = structuredClone(push.snapshot);
          this.#emit({
            kind: "snapshot-changed",
            protocolVersion: TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
            snapshot: this.#current,
          });
        } catch {
          this.#activityErrors += 1;
        } finally {
          this.#releaseLease(lease);
        }
      }, 0);
      this.#pushTimers.set(timer, lease);
    }
  }

  #releaseLease(lease: DirectActivityLease): Error | null {
    this.#leases.delete(lease);
    if (lease.isReleased()) return null;
    const released = lease.release();
    if (released.ok) return null;
    this.#activityErrors += 1;
    return new Error(released.error.message, { cause: released.error });
  }

  #assertActive(): void {
    if (this.#disposed || this.#signal.aborted) {
      throw new Error("The Transmute Direct transport has been disposed.");
    }
  }
}

export function createTransmuteDirectTransport(
  world: TransmuteDirectWorld,
  options: TransmuteDirectTransportOptions,
): TransmuteDirectTransportHarness {
  const implementation = new DeterministicTransmuteTransport(world, options);
  return Object.freeze({
    dispose: () => implementation.dispose(),
    getSnapshot: () => implementation.getSnapshot(),
    recordBlockedNetworkRequest: () => implementation.recordBlockedNetworkRequest(),
    transport: implementation.transport,
  });
}
