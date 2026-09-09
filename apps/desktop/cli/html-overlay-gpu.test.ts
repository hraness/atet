import { runInNewContext } from "node:vm";
import { expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";
import { hardwareEvidenceFixture } from "../html-overlay/execution-profile.testing";
import { inspectHtmlOverlayBrowserGpu, installHtmlOverlayGpuProbe, type HtmlOverlayGpuProbe } from "./html-overlay-gpu";
import { createHtmlOverlayBrowserLaunchArgs } from "./html-overlay-renderer";

test("hardware launch removes explicit software choices and rejects mixed profiles", () => {
  expect(createHtmlOverlayBrowserLaunchArgs(["three"])).toContain("--use-angle=swiftshader");
  const hardware = createHtmlOverlayBrowserLaunchArgs(["three"], "three-webgl2-hardware-v1");
  expect(hardware).toContain("--use-angle=metal");
  expect(hardware).toContain("--disable-software-rasterizer");
  expect(hardware.some(argument => argument.includes("swiftshader"))).toBe(false);
  expect(() => createHtmlOverlayBrowserLaunchArgs(["three", "vgpu"], "three-webgl2-hardware-v1")).toThrow();
});

async function fixture() {
  const expected = hardwareEvidenceFixture().context;
  const state = { lost: false, error: 0, canvases: [] as object[], onLoss: () => {} };
  const values: Record<number, unknown> = {
    0x1f00: expected.vendor, 0x1f01: expected.renderer, 0x1f02: expected.version, 0x8b8c: expected.shadingLanguageVersion,
    0x9245: expected.unmaskedVendor, 0x9246: expected.unmaskedRenderer,
    0x0d33: expected.maxTextureSize, 0x84e8: expected.maxRenderbufferSize, 0x0d3a: new Int32Array(expected.maxViewportDimensions),
  };
  class FakeGl {
    getParameter(key: number) { return values[key]; }
    getExtension(name: string) { return name === "WEBGL_debug_renderer_info" ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 } : {}; }
    isContextLost() { return state.lost; }
    getError() { return state.error; }
    finish() {}
  }
  const gl = new FakeGl();
  class FakeCanvas { getContext() { return gl; } }
  class FakeDocument { querySelectorAll() { return state.canvases; } }
  class FakeTarget { addEventListener(_name: string, listener: () => void) { state.onLoss = listener; } }
  state.canvases = [new FakeCanvas()];
  let controller: HtmlOverlayGpuProbe | undefined;
  const page = { evaluateHandle: async (callback: () => unknown) => {
    controller = runInNewContext(`(${callback.toString()})()`, { HTMLCanvasElement: FakeCanvas, WebGL2RenderingContext: FakeGl, Document: FakeDocument, EventTarget: FakeTarget, document: new FakeDocument() }) as HtmlOverlayGpuProbe;
    return { evaluate: (inspect: (value: HtmlOverlayGpuProbe) => unknown) => inspect(controller!) };
  } } as unknown as Page;
  const probe = await installHtmlOverlayGpuProbe(page);
  return { probe, state, FakeGl, expected };
}

test("host probe retains original context methods and detects loss across capture checks", async () => {
  const f = await fixture();
  f.FakeGl.prototype.getParameter = () => "forged authored value";
  expect(await f.probe.evaluate(value => value.inspect())).toEqual(f.expected);
  f.state.onLoss();
  expect(() => f.probe.evaluate(value => value.inspect())).toThrow("lost");
});

test("host probe rejects replacement canvases and GPU errors", async () => {
  const f = await fixture();
  await f.probe.evaluate(value => value.inspect());
  f.state.error = 0x0502;
  expect(() => f.probe.evaluate(value => value.inspect())).toThrow("GPU work failed");
  f.state.error = 0;
  f.state.canvases = [{ getContext: () => null }];
  expect(() => f.probe.evaluate(value => value.inspect())).toThrow("changed");
});

test("CDP observation strips unrelated machine fields and drains its session on failure", async () => {
  let detached = 0;
  const expected = hardwareEvidenceFixture().browserGpu;
  let gpu: unknown = { devices: expected.devices.map(device => ({ ...device, subSysId: 0, revision: 1 })), auxAttributes: { glVendor: expected.glVendor, glRenderer: expected.glRenderer, glVersion: expected.glVersion, private: "omit" }, featureStatus: { webgl: "enabled", extra: "omit" } };
  const browser = { newBrowserCDPSession: async () => ({ send: async () => ({ gpu, commandLine: "omit", modelName: "omit" }), detach: async () => { detached++; } }) } as unknown as Browser;
  expect(await inspectHtmlOverlayBrowserGpu(browser)).toEqual(expected);
  expect(Object.hasOwn(await inspectHtmlOverlayBrowserGpu(browser), "webgl2")).toBe(false);
  gpu = { devices: [] };
  await expect(inspectHtmlOverlayBrowserGpu(browser)).rejects.toThrow();
  expect(detached).toBe(3);
});
