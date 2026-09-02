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
    ["p5", ["p5"]],
    ["two", ["two.js"]],
    ["paper-shaders", ["@paper-design/shaders"]],
    ["three", ["three"]],
    ["vgpu", ["vgpu"]],
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

  test("p5 uses instance-mode P2D with one awaited redraw per Atet frame", () => {
    const html = createHtmlOverlayScaffold("p5");
    expect(html).toContain('import p5 from "p5"');
    expect(html).toContain("p.P2D");
    expect(html).toContain('colorSpace: "srgb"');
    expect(html).toContain("desynchronized: false");
    expect(html).toContain("p.pixelDensity(devicePixelRatio)");
    expect(html).toContain("p.noLoop()");
    expect(html).toContain("AtetOverlay.randomFor");
    expect(html).toContain("p.clear()");
    expect(html).toContain("const redraw = p.redraw.bind(p)");
    expect(html).toContain("await redraw(...args)");
    expect(html).toContain("if (startupDraw)");
    expect(html).toContain("await sketch.redraw()");
    expect(html).toContain("sketch?.remove()");
    expect(html).not.toContain("p.random(");
    expect(html).not.toContain("frameCount");
    expect(html).not.toContain("requestAnimationFrame(");
  });

  test("Two.js uses explicit manual WebGL rendering without an independent loop", () => {
    const html = createHtmlOverlayScaffold("two");
    expect(html).toContain('import Two from "two.js"');
    expect(html).toContain("type: Two.Types.webgl");
    expect(html).toContain("autostart: false");
    expect(html).toContain("alpha: true");
    expect(html).toContain("premultipliedAlpha: true");
    expect(html).toContain("preserveDrawingBuffer: true");
    expect(html).toContain("ratio: devicePixelRatio");
    expect(html).toContain("clearColor(0, 0, 0, 0)");
    expect(html).not.toContain("AtetOverlay.ready(");
    expect(html).not.toContain("Promise.resolve");
    expect(html).toContain("AtetOverlay.randomFor");
    expect(html).toContain("two.render()");
    expect(html).toContain("two.release()");
    expect(html).toContain(
      'canvas.removeEventListener("webglcontextlost", handleContextLoss)',
    );
    expect(html).toContain("Two.Instances.splice(index, 1)");
    expect(html).toContain('getExtension("WEBGL_lose_context")');
    expect(html).toContain("throw contextError");
    expect(html).not.toContain("object.shape.scale");
    expect(html).not.toContain("two.play()");
    expect(html).not.toContain("autostart: true");
    expect(html).not.toContain("requestAnimationFrame(");
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

  test("vgpu submits one prepared WebGPU pass from absolute Atet time", () => {
    const html = createHtmlOverlayScaffold("vgpu");
    expect(html).toContain('from "vgpu"');
    expect(html).toContain("navigator.gpu === undefined");
    expect(html).toContain('alphaMode: "premultiplied"');
    expect(html).toContain("clearColor: [0, 0, 0, 0]");
    expect(html).toContain("const pipelineTarget = target(gpu,");
    expect(html).toContain("format: output.format");
    expect(html).toContain("await shader.compile(pipelineTarget)");
    expect(html).toContain("pipelineTarget.destroy()");
    expect(html).not.toContain("shader.compile(output)");
    expect(html).toContain("time: timeMs * speed / 1000");
    expect(html).toContain("currentFrame.pass(");
    expect(html).toContain("await submitted.done");
    expect(html).toContain("await state.gpu.settled()");
    expect(html).toContain("gpu.dispose()");
    expect(html).not.toContain("frameLoop");
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
