import type { DirectSessionActivation } from "@hraness/direct/testing";
import { installDirectBrowser } from "@hraness/direct/web";

import {
  createSlopcameraDirectSession,
  type SlopcameraDirectSession,
} from "./session";

export type SlopcameraPagehideRegistration = (
  listener: () => undefined,
) => () => undefined;

export interface SlopcameraDirectMountOptions {
  readonly registerPagehide: SlopcameraPagehideRegistration;
  readonly target?: object;
}

export interface MountedSlopcameraDirect {
  readonly dispose: () => undefined;
  readonly session: SlopcameraDirectSession;
}

export type SlopcameraDirectMountErrorCode =
  | "activation-failed"
  | "browser-install-failed"
  | "pagehide-registration-failed";

export type SlopcameraDirectMountResult =
  | Readonly<{ ok: true; value: MountedSlopcameraDirect }>
  | Readonly<{
    ok: false;
    error: Readonly<{
      code: SlopcameraDirectMountErrorCode;
      message: string;
    }>;
  }>;

function failure(
  code: SlopcameraDirectMountErrorCode,
  message: string,
): SlopcameraDirectMountResult {
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
export function mountSlopcameraDirect(
  activation: DirectSessionActivation,
  options: SlopcameraDirectMountOptions,
): SlopcameraDirectMountResult {
  const created = createSlopcameraDirectSession(activation);
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
