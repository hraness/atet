import { describe, expect, test } from "bun:test";

import {
  HTML_OVERLAY_MAX_HTML_BYTES,
  HTML_OVERLAY_MAX_PARAMETER_DEPTH,
  HtmlOverlayAuthoringInputSchema,
  HtmlOverlayDeclaredResourcesSchema,
  HtmlOverlayInlineDocumentSchema,
  HtmlOverlayParametersSchema,
  createHtmlOverlayRuntimeFrame,
  htmlOverlayFrameCount,
  parseHtmlOverlayRuntimeFrame,
} from "./contracts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function authoringInput() {
  return {
    canvas: { deviceScaleFactor: 1, height: 720, width: 1_280 },
    html: "<!doctype html><div>Overlay</div>",
    kind: "transmute.html-overlay",
    libraries: ["three", "motion"],
    parameters: { accent: "#765cff", count: 3 },
    resources: [
      {
        bytes: 20,
        mediaType: "image/png",
        name: "zebra",
        sha256: SHA_B,
        urlPath: "images/zebra.png",
      },
      {
        bytes: 10,
        mediaType: "image/png",
        name: "alpha",
        sha256: SHA_A,
        urlPath: "images/alpha.png",
      },
    ],
    schemaVersion: 1,
    seed: 42,
    timing: { durationUs: 2_000_000, fps: 30 },
  } as const;
}

describe("HTML overlay authoring contracts", () => {
  test("accepts only strict bounded inline documents", () => {
    const document = { html: "<!doctype html><div>Inline overlay</div>" };
    expect(HtmlOverlayInlineDocumentSchema.parse(document)).toEqual(document);
    expect(HtmlOverlayInlineDocumentSchema.safeParse({
      ...document,
      path: "overlay.html",
    }).success).toBe(false);
    expect(HtmlOverlayInlineDocumentSchema.safeParse({ html: "\0" }).success)
      .toBe(false);
    expect(HtmlOverlayInlineDocumentSchema.safeParse({
      html: "😀".repeat(Math.floor(HTML_OVERLAY_MAX_HTML_BYTES / 4) + 1),
    }).success).toBe(false);
  });

  test("parses strict input, fills empty collections, and normalizes unordered fields", () => {
    const parsed = HtmlOverlayAuthoringInputSchema.parse(authoringInput());
    expect(parsed.libraries).toEqual(["motion", "three"]);
    expect(parsed.resources.map(resource => resource.name)).toEqual(["alpha", "zebra"]);
    expect(HtmlOverlayAuthoringInputSchema.parse({
      ...authoringInput(),
      kind: "studio.html-overlay",
    }).kind).toBe("transmute.html-overlay");

    const input = authoringInput();
    const minimal = {
      canvas: input.canvas,
      html: input.html,
      kind: input.kind,
      schemaVersion: input.schemaVersion,
      seed: input.seed,
      timing: input.timing,
    };
    expect(HtmlOverlayAuthoringInputSchema.parse(minimal)).toMatchObject({
      libraries: [],
      parameters: {},
      resources: [],
    });
    expect(HtmlOverlayAuthoringInputSchema.safeParse({ ...authoringInput(), shell: true }).success)
      .toBe(false);
  });

  test("rejects excessive canvas, frame-count, and aggregate pixel work", () => {
    expect(HtmlOverlayAuthoringInputSchema.safeParse({
      ...authoringInput(),
      canvas: { deviceScaleFactor: 1, height: 8_192, width: 8_192 },
    }).success).toBe(false);
    expect(HtmlOverlayAuthoringInputSchema.safeParse({
      ...authoringInput(),
      timing: { durationUs: 3_600_000_000, fps: 120 },
    }).success).toBe(false);
    expect(HtmlOverlayAuthoringInputSchema.safeParse({
      ...authoringInput(),
      canvas: { deviceScaleFactor: 2, height: 2_160, width: 3_840 },
      timing: { durationUs: 600_000_000, fps: 60 },
    }).success).toBe(false);
  });

  test("bounds parameters without throwing on cycles or excessive depth", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => HtmlOverlayParametersSchema.safeParse(cyclic)).not.toThrow();
    expect(HtmlOverlayParametersSchema.safeParse(cyclic).success).toBe(false);

    let nested: unknown = "leaf";
    for (let depth = 0; depth <= HTML_OVERLAY_MAX_PARAMETER_DEPTH; depth += 1) {
      nested = { child: nested };
    }
    expect(HtmlOverlayParametersSchema.safeParse({ nested }).success).toBe(false);
    expect(HtmlOverlayParametersSchema.safeParse({
      huge: Array.from({ length: 129 }, () => true),
    }).success).toBe(false);
    expect(HtmlOverlayParametersSchema.safeParse(
      JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
    ).success).toBe(false);
    expect(HtmlOverlayParametersSchema.safeParse({ invalid: Number.NaN }).success).toBe(false);
  });

  test("accepts only unique, bounded, unambiguous declared resource paths", () => {
    const resources = authoringInput().resources;
    expect(HtmlOverlayDeclaredResourcesSchema.parse(resources).map(resource => resource.name))
      .toEqual(["alpha", "zebra"]);
    for (const urlPath of [
      "/logo.png",
      "../logo.png",
      "images/../logo.png",
      "images\\logo.png",
      "images/logo.png?mutable=1",
      "images/logo.png#fragment",
      "images/%2e%2e/logo.png",
    ]) {
      expect(HtmlOverlayDeclaredResourcesSchema.safeParse([
        { ...resources[0], urlPath },
      ]).success).toBe(false);
    }
    expect(HtmlOverlayDeclaredResourcesSchema.safeParse([
      resources[0],
      { ...resources[1], name: resources[0].name },
    ]).success).toBe(false);
  });
});

describe("HTML overlay absolute frames", () => {
  test("derives and validates the exact Transmute-owned frame clock", () => {
    const canvas = { deviceScaleFactor: 1, height: 720, width: 1_280 };
    const timing = { durationUs: 1_000_000, fps: 30 };
    expect(htmlOverlayFrameCount(timing)).toBe(30);
    const frame = createHtmlOverlayRuntimeFrame(29, canvas, timing);
    expect(frame).toEqual({
      deltaMs: 1_000 / 30,
      frame: 29,
      height: 720,
      progress: (29 * 1_000 / 30) / 1_000,
      timeMs: 29 * 1_000 / 30,
      width: 1_280,
    });
    expect(parseHtmlOverlayRuntimeFrame(frame, canvas, timing)).toEqual(frame);
    expect(() => parseHtmlOverlayRuntimeFrame({ ...frame, progress: 1 }, canvas, timing))
      .toThrow("progress");
    expect(() => createHtmlOverlayRuntimeFrame(30, canvas, timing)).toThrow("outside");
  });

  test("always renders at least frame zero for a positive duration", () => {
    expect(htmlOverlayFrameCount({ durationUs: 1, fps: 1 })).toBe(1);
    expect(createHtmlOverlayRuntimeFrame(
      0,
      { deviceScaleFactor: 1, height: 1, width: 1 },
      { durationUs: 1, fps: 1 },
    )).toMatchObject({ deltaMs: 0, frame: 0, progress: 0, timeMs: 0 });
  });
});
