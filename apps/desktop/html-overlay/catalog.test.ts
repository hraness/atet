import { describe, expect, test } from "bun:test";

import {
  HTML_OVERLAY_SCAFFOLD_CLOCK_INTEGRATIONS,
  HTML_OVERLAY_SCAFFOLD_KINDS,
  HTML_OVERLAY_SCAFFOLD_PRIMARY_JOBS,
  HTML_OVERLAY_SCAFFOLD_PROFILES,
  HTML_OVERLAY_SCAFFOLD_SUBSTRATES,
  HtmlOverlayScaffoldProfileSchema,
  getHtmlOverlayScaffoldProfile,
} from "./catalog";

describe("HTML overlay scaffold catalog", () => {
  test("assigns every supported kind one stable and mutually exclusive job", () => {
    expect(HTML_OVERLAY_SCAFFOLD_PROFILES.map(profile => profile.kind)).toEqual([
      "plain",
      "motion",
      "p5",
      "two",
      "paper-shaders",
      "three",
      "vgpu",
    ]);
    expect(HTML_OVERLAY_SCAFFOLD_PROFILES.map(profile => profile.kind))
      .toEqual([...HTML_OVERLAY_SCAFFOLD_KINDS]);
    expect(new Set(
      HTML_OVERLAY_SCAFFOLD_PROFILES.map(profile => profile.primaryJob),
    ).size).toBe(HTML_OVERLAY_SCAFFOLD_PROFILES.length);
  });

  test("owns the exact scaffold-to-library selection", () => {
    expect(HTML_OVERLAY_SCAFFOLD_PROFILES.map(({ kind, libraries }) => ({
      kind,
      libraries: [...libraries],
    }))).toEqual([
      { kind: "plain", libraries: [] },
      { kind: "motion", libraries: ["motion"] },
      { kind: "p5", libraries: ["p5"] },
      { kind: "two", libraries: ["two.js"] },
      { kind: "paper-shaders", libraries: ["@paper-design/shaders"] },
      { kind: "three", libraries: ["three"] },
      { kind: "vgpu", libraries: ["vgpu"] },
    ]);
  });

  test("is deeply frozen and returns the canonical entry", () => {
    expect(Object.isFrozen(HTML_OVERLAY_SCAFFOLD_KINDS)).toBe(true);
    expect(Object.isFrozen(HTML_OVERLAY_SCAFFOLD_PRIMARY_JOBS)).toBe(true);
    expect(Object.isFrozen(HTML_OVERLAY_SCAFFOLD_SUBSTRATES)).toBe(true);
    expect(Object.isFrozen(HTML_OVERLAY_SCAFFOLD_CLOCK_INTEGRATIONS)).toBe(true);
    expect(Object.isFrozen(HTML_OVERLAY_SCAFFOLD_PROFILES)).toBe(true);
    for (const profile of HTML_OVERLAY_SCAFFOLD_PROFILES) {
      expect(HtmlOverlayScaffoldProfileSchema.parse(profile)).toEqual({
        ...profile,
        libraries: [...profile.libraries],
      });
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.libraries)).toBe(true);
      expect(getHtmlOverlayScaffoldProfile(profile.kind)).toBe(profile);
    }
    expect(() => getHtmlOverlayScaffoldProfile("unknown" as "plain")).toThrow();
  });

  test("rejects unknown profile metadata", () => {
    const plain = getHtmlOverlayScaffoldProfile("plain");
    expect(HtmlOverlayScaffoldProfileSchema.safeParse({
      ...plain,
      shell: true,
    }).success).toBe(false);
  });
});
