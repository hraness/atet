import { describe, expect, test } from "bun:test";

import {
  transmuteCoverageCatalog,
  transmuteScenarioCatalog,
  transmuteScenarioMetadata,
} from "./scenarios";

const expectedScenarios = [
  "agent-analysis-ledger",
  "all-input-recording",
  "code-mode-workflow",
  "failed-recovery",
  "idle-ready",
  "multi-asset-project",
  "multiple-displays",
  "overlay-compositor",
  "partial-source-failure",
  "pause-resume",
  "permission-denied",
  "permission-prompt",
  "stop-finalized",
] as const;

describe("Transmute Direct catalogs", () => {
  test("keeps the required recorder lifecycle scenarios exact", () => {
    const ids = transmuteScenarioCatalog.list().map(({ id }) => String(id)).toSorted();
    expect(ids).toEqual([...expectedScenarios]);
    expect(Object.keys(transmuteScenarioMetadata).toSorted()).toEqual(ids);
    expect(new Set(transmuteScenarioCatalog.list().map(({ route }) => route))).toEqual(new Set(["/"]));
  });

  test("keeps fixture claims distinct from direct native proof", () => {
    const entries = transmuteCoverageCatalog.list();
    expect(entries.some(({ key }) => key === "overlays.all-kinds")).toBe(true);
    expect(entries.some(({ key }) => key === "alignment.candidates-accepted")).toBe(true);
    expect(entries.some(({ key }) => key === "analysis.scene-local-boundary")).toBe(true);
    expect(entries.some(({ key }) => key === "camera.manual-pan-zoom")).toBe(true);
    expect(entries.some(({ key }) => key === "camera.face-follow-provenance")).toBe(true);
    expect(entries.some(({ key }) => key === "camera.face-local-privacy")).toBe(true);
    expect(entries.some(({ key }) => key === "overlays.full-controls")).toBe(true);
    expect(entries.some(({ key }) => key === "workflow.production-graph")).toBe(true);
    expect(entries.some(({ key }) => key === "workflow.parallel-waves")).toBe(true);
    expect(entries.some(({ key }) => key === "workflow.explicit-recovery")).toBe(true);
    expect(entries.some(({ key }) => key === "workflow.bound-outputs")).toBe(true);
    expect(entries.some(({ key }) => key === "native.capture.direct")).toBe(true);
    for (const entry of entries) {
      if (entry.mode === "direct") expect(entry.scenarios).toEqual([]);
      else expect(entry.scenarios.length).toBeGreaterThan(0);
    }
  });

  test("fails closed for unknown activation", () => {
    const result = transmuteScenarioCatalog.resolve("missing-recorder-world");
    expect(result).toMatchObject({ ok: false, error: { code: "unknown-scenario" } });
  });
});
