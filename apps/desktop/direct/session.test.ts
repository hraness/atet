import { describe, expect, test } from "bun:test";

import { createAtetDirectSession } from "./session";

describe("Atet Direct session", () => {
  test("binds activation, coverage, observation, and transport teardown", () => {
    const created = createAtetDirectSession({ kind: "query", source: "" });
    if (!created.ok) throw new Error(created.error.message);
    const session = created.value;

    expect(String(session.activation.scenario)).toBe("idle-ready");
    expect(session.coverage.schema).toBe("direct.coverage/v2");
    expect(session.coverage.entries.some(({ key }) => key === "native.capture.direct")).toBe(true);
    expect(session.probe.snapshot()).toMatchObject({
      ok: true,
      value: {
        isQuiescent: true,
        remainingWork: { disposed: false, eventListeners: 0, transitions: 1 },
        violations: { activityErrors: 0, blockedNetworkRequests: 0, protocolErrors: 0 },
      },
    });

    session.dispose();
    expect(session.harness.getSnapshot().disposed).toBe(true);
    expect(session.isDisposed()).toBe(true);
    expect(session.disposalErrors()).toEqual([]);
  });
});
