import { describe, expect, test } from "bun:test";

import {
  HTML_OVERLAY_SCAFFOLD_KINDS,
  HTML_OVERLAY_TRANSPARENT_RESET_CSS,
  createHtmlOverlayScaffold,
  createHtmlOverlayScaffoldInput,
  createThreeReferenceScaffoldInput,
} from "./scaffolds";

describe("HTML overlay scaffolds", () => {
  test.each(HTML_OVERLAY_SCAFFOLD_KINDS.map(kind => [kind] as const))(
    "%s is a complete transparent document",
    (kind) => {
      const html = createHtmlOverlayScaffold(kind);
      expect(html).toStartWith("<!doctype html>");
      expect(html).toContain(HTML_OVERLAY_TRANSPARENT_RESET_CSS);
      expect(html).toContain("background: transparent !important");
      expect(html).toContain('<script type="module">');
      expect(html).not.toContain("https://");
    },
  );

  test("plain DOM uses only the absolute frame callback", () => {
    const html = createHtmlOverlayScaffold("plain");
    expect(html).toContain("AtetOverlay.onFrame");
    expect(html).not.toContain('type="importmap"');
  });

  test.each([
    ["plain", []],
    ["motion", ["motion"]],
    ["paper-shaders", ["@paper-design/shaders"]],
    ["three", ["three"]],
  ] as const)("%s returns directly spreadable HTML and exact libraries", (
    kind,
    libraries,
  ) => {
    const input = createHtmlOverlayScaffoldInput(kind);
    expect(input).toEqual({
      document: { html: createHtmlOverlayScaffold(kind) },
      libraries: [...libraries],
    });
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.document)).toBe(true);
    expect(Object.isFrozen(input.libraries)).toBe(true);
  });

  test("Motion uses the locked bare import and tracked controls", () => {
    const html = createHtmlOverlayScaffold("motion");
    expect(html).toContain('from "motion"');
    expect(html).toContain("AtetOverlay.trackAnimation");
    expect(html).toContain("/.atet-overlay/libraries/");
    expect(html).not.toContain("motion/mini");
  });

  test("Paper Shaders is stopped and explicitly advanced in milliseconds", () => {
    const html = createHtmlOverlayScaffold("paper-shaders");
    expect(html).toContain('from "@paper-design/shaders"');
    expect(html).toContain("ShaderMount");
    expect(html).toContain("shader.setFrame(timeMs)");
    expect(html).toContain("premultipliedAlpha: false");
  });

  test("Three.js renders once from absolute time over a clear-alpha canvas", () => {
    const html = createHtmlOverlayScaffold("three");
    expect(html).toContain('from "three"');
    expect(html).toContain("renderer.setClearColor(0x000000, 0)");
    expect(html).toContain("renderer.outputColorSpace = THREE.SRGBColorSpace");
    expect(html).toContain("renderer.toneMapping = THREE.ACESFilmicToneMapping");
    expect(html).toContain('powerPreference: "high-performance"');
    expect(html).toContain("function createSubject()");
    expect(html).toContain("renderer.compileAsync(scene, camera)");
    expect(html).toContain("renderer.render(scene, camera)");
    expect(html).toContain("const horizontalHalfFov = Math.atan(");
    expect(html).toContain("const fitHalfFov = Math.min(");
    expect(html).toContain("sphere.radius / Math.sin(fitHalfFov)");
    expect(html).toContain("renderer.info.render.triangles > MAX_TRIANGLES");
    expect(html).toContain("renderer.forceContextLoss()");
    expect(html).toContain("const phase = progress * Math.PI * 2");
    expect(html).not.toContain("setAnimationLoop");
    expect(html).not.toContain("requestAnimationFrame(");
  });

  test("binds one generated reference to the Three.js scaffold without copying it", () => {
    const artifact = Object.freeze({ ref: "generated-image" });
    const mediaType = Object.freeze({ ref: "generated-media-type" });
    const input = createThreeReferenceScaffoldInput(artifact, mediaType);

    expect(input).toEqual({
      document: { html: createHtmlOverlayScaffold("three") },
      libraries: ["three"],
      resources: [{
        artifact,
        mediaType,
        name: "reference-image",
        urlPath: "assets/reference-image",
      }],
    });
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.resources)).toBe(true);
    expect(Object.isFrozen(input.resources[0])).toBe(true);
  });
});
