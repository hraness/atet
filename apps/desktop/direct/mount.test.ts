import { afterEach, describe, expect, test } from "bun:test";
import { SCENARIO_QUERY_KEY } from "@hraness/direct";
import type { DirectBrowserBridge } from "@hraness/direct/web";

import {
  mountAtetDirect,
  type AtetPagehideRegistration,
} from "./mount";

const hostFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = hostFetch;
});

function pagehideHarness() {
  let listener: (() => undefined) | null = null;
  let registrations = 0;
  let removals = 0;
  const registerPagehide: AtetPagehideRegistration = (next) => {
    listener = next;
    registrations += 1;
    return (): undefined => {
      if (listener === next) {
        listener = null;
        removals += 1;
      }
      return undefined;
    };
  };
  return {
    fire: () => listener?.(),
    read: () => ({ registrations, removals }),
    registerPagehide,
  };
}

describe("Atet Direct mount", () => {
  test("installs bridge, firewall, and idempotent page lifecycle ownership", async () => {
    const target: Record<string, unknown> = {};
    const pagehide = pagehideHarness();
    const mounted = mountAtetDirect(
      { kind: "scenario", scenario: "idle-ready" },
      { registerPagehide: pagehide.registerPagehide, target },
    );
    if (!mounted.ok) throw new Error(mounted.error.message);

    const bridge = target.__direct as DirectBrowserBridge;
    expect(bridge.manifest).toEqual(mounted.value.session.manifest);
    expect(bridge.manifest.coverage).toEqual(mounted.value.session.coverage);
    expect(globalThis.fetch).not.toBe(hostFetch);
    expect((await fetch("https://example.com/unmapped")).status).toBe(501);
    expect(bridge.snapshot().violations).toMatchObject({ blockedNetworkRequests: 1 });
    expect(pagehide.read()).toEqual({ registrations: 1, removals: 0 });

    pagehide.fire();
    mounted.value.dispose();
    mounted.value.dispose();
    expect(mounted.value.session.isDisposed()).toBeTrue();
    expect(mounted.value.session.disposalErrors()).toEqual([]);
    expect(pagehide.read()).toEqual({ registrations: 1, removals: 1 });
    expect("__direct" in target).toBeFalse();
    expect(globalThis.fetch).toBe(hostFetch);
  });

  test("an invalid query installs no browser or page lifecycle state", () => {
    const target: Record<string, unknown> = {};
    const pagehide = pagehideHarness();
    const mounted = mountAtetDirect({
      kind: "query",
      source: `?${SCENARIO_QUERY_KEY}=missing-recorder-world`,
    }, { registerPagehide: pagehide.registerPagehide, target });

    expect(mounted).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    expect("__direct" in target).toBeFalse();
    expect(globalThis.fetch).toBe(hostFetch);
    expect(pagehide.read()).toEqual({ registrations: 0, removals: 0 });
  });

  test("a forced bridge failure rolls back the firewall and disposes the session", () => {
    const target = new Proxy({}, {
      defineProperty: () => {
        throw new Error("target rejected bridge");
      },
    });
    const pagehide = pagehideHarness();
    const mounted = mountAtetDirect(
      { kind: "scenario", scenario: "idle-ready" },
      { registerPagehide: pagehide.registerPagehide, target },
    );

    expect(mounted).toMatchObject({
      ok: false,
      error: { code: "browser-install-failed", message: "target rejected bridge" },
    });
    expect(globalThis.fetch).toBe(hostFetch);
    expect(pagehide.read()).toEqual({ registrations: 0, removals: 0 });
  });
});
