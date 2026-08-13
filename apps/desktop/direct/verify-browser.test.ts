import { describe, expect, test } from "bun:test";

import {
  canAutomaticallyStartServer,
  externalOrFailedRequests,
  normalizeBaseUrl,
  parseArguments,
  parseTransmuteDefinitionCoverage,
  probeTransmuteDirectServer,
  responsiveLayoutFailures,
  scenarioAuditFailures,
  transmuteBrowserScenarioIds,
  visibleTextContains,
  waitForDirectBridge,
} from "./verify-browser";
import { transmuteScenarioCatalog } from "./scenarios";
import { createTransmuteDirectSession } from "./session";

describe("Transmute browser verifier", () => {
  test("parses a safe local base URL and rejects authority/path tricks", () => {
    expect(parseArguments([])).toEqual({ baseUrl: "http://127.0.0.1:5174", kind: "run" });
    expect(parseArguments(["--base-url", "http://localhost:6000"])).toEqual({
      baseUrl: "http://localhost:6000",
      kind: "run",
    });
    expect(() => normalizeBaseUrl("file:///tmp/lab")).toThrow("HTTP or HTTPS");
    expect(() => normalizeBaseUrl("https://user@example.com/")).toThrow("credentials");
    expect(() => normalizeBaseUrl("https://example.com/lab")).toThrow("without a path");
    expect(canAutomaticallyStartServer("http://127.0.0.1:5174")).toBe(true);
    expect(canAutomaticallyStartServer("https://example.com")).toBe(false);
  });

  test("distinguishes Transmute Direct from another reachable local workbench", async () => {
    const transmute = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(
        '<html data-transmute-surface="product"><head><title>Transmute Direct</title></head></html>',
      ),
    });
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(
        '<html data-oprte-surface="product"><head><title>OPRTE · Direct</title></head></html>',
      ),
    });
    try {
      expect(await probeTransmuteDirectServer(`http://127.0.0.1:${String(transmute.port)}`))
        .toBe("transmute");
      expect(await probeTransmuteDirectServer(`http://127.0.0.1:${String(other.port)}`))
        .toBe("other");
    } finally {
      await Promise.all([transmute.stop(true), other.stop(true)]);
    }
  });

  test("rejects external, failed, and mutating browser requests", () => {
    const requests = [
      { method: "GET", status: 200, url: "http://127.0.0.1:5174/main.tsx" },
      { method: "POST", status: 200, url: "http://127.0.0.1:5174/mutate" },
      { method: "GET", status: 503, url: "http://127.0.0.1:5174/fail" },
      { method: "GET", status: 200, url: "https://example.com/tracker" },
    ];
    expect(externalOrFailedRequests(requests, "http://127.0.0.1:5174")).toEqual(requests.slice(1));
  });

  test("detects horizontal overflow and undersized controls", () => {
    expect(responsiveLayoutFailures({
      clientHeight: 720,
      clientWidth: 480,
      controls: [{ bottom: 40, height: 39, label: "Start", left: -2, right: 490, top: 1 }],
      scrollWidth: 520,
    })).toEqual([
      "document is 40px wider than its viewport",
      "Start leaves the horizontal viewport",
      "Start is only 39px tall",
    ]);
  });

  test("matches visible text across CSS text transformations", () => {
    expect(visibleTextContains("AUDIO ALIGNMENT CANDIDATES", "Audio alignment candidates")).toBe(true);
    expect(visibleTextContains("Music structure", "speech filler decisions")).toBe(false);
  });

  test("reports browser startup errors when the Direct bridge never mounts", async () => {
    const commands: string[][] = [];
    const browser = {
      run(arguments_: readonly string[]): Promise<unknown> {
        commands.push([...arguments_]);
        if (arguments_[0] === "wait") {
          return Promise.reject(new Error("Wait timed out after 35000ms"));
        }
        return Promise.resolve({
          errors: [{
            text: "node:crypto was externalized for browser compatibility",
          }],
        });
      },
    };

    const failure = await waitForDirectBridge(browser, "idle-ready").then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected a startup diagnostic.");
    expect(failure.message).toMatch(/idle-ready.*node:crypto was externalized/u);
    expect(commands).toEqual([
      ["wait", "--fn", "typeof window.__direct?.snapshot === 'function'"],
      ["errors"],
    ]);
  });

  test("fails when a catalog or coverage claim lacks browser evidence", () => {
    expect(scenarioAuditFailures(
      ["idle", "recording"],
      ["idle"],
      ["idle"],
      [{ key: "runtime.idle", scenarios: ["idle"] }, { key: "capture.recording", scenarios: ["recording"] }],
    )).toEqual([
      "catalog scenarios missing verifier definitions: recording",
      "coverage scenarios missing browser evidence: recording",
    ]);
  });

  test("defines browser evidence for every authored Transmute scenario", () => {
    const created = createTransmuteDirectSession({
      kind: "scenario",
      scenario: "idle-ready",
    });
    if (!created.ok) throw new Error(created.error.message);
    const session = created.value;

    expect(scenarioAuditFailures(
      transmuteScenarioCatalog.list().map(({ id }) => id),
      transmuteBrowserScenarioIds,
      transmuteBrowserScenarioIds,
      session.coverage.entries,
    )).toEqual([]);
    session.dispose();
  });

  test("rejects valid coverage that drifted from the authored Transmute definition", () => {
    const created = createTransmuteDirectSession({ kind: "scenario", scenario: "idle-ready" });
    if (!created.ok) throw new Error(created.error.message);
    const session = created.value;
    const first = session.coverage.entries[0];
    if (first === undefined) throw new Error("Transmute coverage is empty.");
    const driftedCoverage: readonly unknown[] = [
      {
        ...session.coverage,
        entries: [{ ...first, claim: `${first.claim} Drifted.` }, ...session.coverage.entries.slice(1)],
      },
      {
        ...session.coverage,
        entries: [{ ...first, mode: "direct", scenarios: [] }, ...session.coverage.entries.slice(1)],
      },
      { ...session.coverage, entries: session.coverage.entries.slice(1) },
    ];

    expect(parseTransmuteDefinitionCoverage(session.coverage)).toEqual({
      ok: true,
      value: session.coverage,
    });
    for (const drifted of driftedCoverage) {
      expect(parseTransmuteDefinitionCoverage(drifted)).toMatchObject({
        ok: false,
        error: { code: "coverage-mismatch" },
      });
    }
    session.dispose();
  });
});
