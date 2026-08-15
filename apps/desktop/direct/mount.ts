import type { DirectSessionActivation } from "@hraness/direct/testing";
import { installDirectBrowser } from "@hraness/direct/web";

import {
  createAtetDirectSession,
  type AtetDirectSession,
} from "./session";

export type AtetPagehideRegistration = (
  listener: () => undefined,
) => () => undefined;

export interface AtetDirectMountOptions {
  readonly registerPagehide: AtetPagehideRegistration;
  readonly target?: object;
}

export interface MountedAtetDirect {
  readonly dispose: () => undefined;
  readonly session: AtetDirectSession;
}

export type AtetDirectMountErrorCode =
  | "activation-failed"
  | "browser-install-failed"
  | "pagehide-registration-failed";

export type AtetDirectMountResult =
  | Readonly<{ ok: true; value: MountedAtetDirect }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      code: AtetDirectMountErrorCode;
      message: string;
    }>;
  }>;

function failure(
  code: AtetDirectMountErrorCode,
  message: string,
): AtetDirectMountResult {
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
export function mountAtetDirect(
  activation: DirectSessionActivation,
  options: AtetDirectMountOptions,
): AtetDirectMountResult {
  const created = createAtetDirectSession(activation);
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
