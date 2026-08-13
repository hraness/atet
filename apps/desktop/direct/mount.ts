import type { DirectSessionActivation } from "@hraness/direct/testing";
import { installDirectBrowser } from "@hraness/direct/web";

import {
  createTransmuteDirectSession,
  type TransmuteDirectSession,
} from "./session";

export type TransmutePagehideRegistration = (
  listener: () => undefined,
) => () => undefined;

export interface TransmuteDirectMountOptions {
  readonly registerPagehide: TransmutePagehideRegistration;
  readonly target?: object;
}

export interface MountedTransmuteDirect {
  readonly dispose: () => undefined;
  readonly session: TransmuteDirectSession;
}

export type TransmuteDirectMountErrorCode =
  | "activation-failed"
  | "browser-install-failed"
  | "pagehide-registration-failed";

export type TransmuteDirectMountResult =
  | Readonly<{ ok: true; value: MountedTransmuteDirect }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      code: TransmuteDirectMountErrorCode;
      message: string;
    }>;
  }>;

function failure(
  code: TransmuteDirectMountErrorCode,
  message: string,
): TransmuteDirectMountResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

function renderReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? "Unknown Direct mount failure";
  } catch {
    return "Unknown Direct mount failure";
  }
}

/** Install containment and page lifecycle ownership before React can run product effects. */
export function mountTransmuteDirect(
  activation: DirectSessionActivation,
  options: TransmuteDirectMountOptions,
): TransmuteDirectMountResult {
  const created = createTransmuteDirectSession(activation);
  if (!created.ok) return failure("activation-failed", created.error.message);
  const session = created.value;

  const browser = installDirectBrowser({
    session,
    reset: (): undefined => {
      globalThis.location?.reload();
      return undefined;
    },
    firewall: { onBlocked: session.harness.recordBlockedNetworkRequest },
    ...(options.target === undefined ? {} : { target: options.target }),
  });
  if (!browser.ok) {
    session.dispose();
    return failure("browser-install-failed", browser.error.message);
  }

  let unregisterPagehide: (() => undefined) | null = null;
  try {
    unregisterPagehide = options.registerPagehide(session.dispose);
    const registered = session.onDispose(unregisterPagehide);
    if (!registered.ok) throw new Error(registered.error.message, { cause: registered.error });
  } catch (reason) {
    let unregisterFailure: unknown = null;
    try {
      unregisterPagehide?.();
    } catch (cleanupReason) {
      unregisterFailure = cleanupReason;
    } finally {
      session.dispose();
    }
    const reasonMessage = renderReason(reason);
    const message = unregisterFailure === null
      ? reasonMessage
      : `${reasonMessage}; pagehide cleanup failed: ${renderReason(unregisterFailure)}`;
    return failure("pagehide-registration-failed", message);
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({ dispose: session.dispose, session }),
  });
}
