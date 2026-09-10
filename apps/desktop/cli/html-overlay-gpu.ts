import { release } from "node:os";
import type { Browser, JSHandle, Page } from "playwright-core";
import { z } from "zod";
import {
  HtmlOverlayBrowserGpuEvidenceSchema, HtmlOverlayWebGlContextEvidenceSchema,
  parseHtmlOverlayGpuEvidence, type HtmlOverlayExecutionProfile, type HtmlOverlayGpuEvidence,
} from "../html-overlay/execution-profile";

type WebGlContextEvidence = z.infer<typeof HtmlOverlayWebGlContextEvidenceSchema>;
export interface HtmlOverlayGpuProbe { inspect(): WebGlContextEvidence }

/** Install before authored code. Keep native methods and the active context outside its globals. */
export async function installHtmlOverlayGpuProbe(page: Page): Promise<JSHandle<HtmlOverlayGpuProbe>> {
  return await page.evaluateHandle(() => {
    const apply = Reflect.apply;
    const queryAll = Document.prototype.querySelectorAll;
    const getContext = HTMLCanvasElement.prototype.getContext;
    const glPrototype = WebGL2RenderingContext.prototype;
    const getParameter = glPrototype.getParameter;
    const getExtension = glPrototype.getExtension;
    const isContextLost = glPrototype.isContextLost;
    const getError = glPrototype.getError;
    const finish = glPrototype.finish;
    const addEventListener = EventTarget.prototype.addEventListener;
    let observedCanvas: HTMLCanvasElement | undefined;
    let observedContext: WebGL2RenderingContext | undefined;
    let lost = false;
    return {
      inspect() {
        const canvases = apply(queryAll, document, ["canvas"]) as NodeListOf<HTMLCanvasElement>;
        if (canvases.length !== 1) throw new Error("Hardware scene capture requires exactly one visible render canvas.");
        const canvas = canvases[0]!;
        const gl = apply(getContext, canvas, ["webgl2"]) as WebGL2RenderingContext | null;
        if (gl === null || (observedContext !== undefined && (gl !== observedContext || canvas !== observedCanvas))) throw new Error("Hardware scene changed or lacks its actual WebGL2 context.");
        if (observedContext === undefined) {
          observedCanvas = canvas; observedContext = gl;
          apply(addEventListener, canvas, ["webglcontextlost", () => { lost = true; }]);
        }
        if (lost || apply(isContextLost, gl, [])) throw new Error("Hardware scene WebGL2 context was lost.");
        apply(finish, gl, []);
        if (lost || apply(isContextLost, gl, []) || apply(getError, gl, []) !== 0) throw new Error("Hardware scene GPU work failed before capture completed.");
        const debug = apply(getExtension, gl, ["WEBGL_debug_renderer_info"]) as WEBGL_debug_renderer_info | null;
        if (debug === null) throw new Error("Hardware scene requires observable active GPU identity.");
        const parameter = (key: number): unknown => apply(getParameter, gl, [key]);
        const viewport = parameter(0x0d3a) as Int32Array;
        return {
          vendor: parameter(0x1f00) as string, renderer: parameter(0x1f01) as string,
          version: parameter(0x1f02) as string, shadingLanguageVersion: parameter(0x8b8c) as string,
          unmaskedVendor: parameter(0x9245) as string,
          unmaskedRenderer: parameter(0x9246) as string,
          maxTextureSize: parameter(0x0d33) as number, maxRenderbufferSize: parameter(0x84e8) as number,
          maxViewportDimensions: [viewport[0]!, viewport[1]!] as [number, number],
          halfFloatColorBuffer: (apply(getExtension, gl, ["EXT_color_buffer_float"]) !== null) as true,
        };
      },
    };
  });
}

/** Retain only graphics fields; never raw CDP machine, command-line or process information. */
export async function inspectHtmlOverlayBrowserGpu(browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = z.object({ gpu: z.object({
      devices: z.array(z.object({
        vendorId: z.number().int().min(0).max(0xffff_ffff).default(0), deviceId: z.number().int().min(0).max(0xffff_ffff).default(0),
        vendorString: z.string().max(1_024).default(""), deviceString: z.string().max(1_024).default(""),
        driverVendor: z.string().max(1_024).default(""), driverVersion: z.string().max(1_024).default(""),
      })).min(1).max(8),
      auxAttributes: z.object({ glVendor: z.string(), glRenderer: z.string(), glVersion: z.string() }),
      featureStatus: z.object({ webgl: z.literal("enabled"), webgl2: z.literal("enabled").optional() }),
    }) }).parse(await session.send("SystemInfo.getInfo"));
    const gpu = result.gpu;
    return HtmlOverlayBrowserGpuEvidenceSchema.parse({
      devices: gpu.devices.map(device => ({
        vendorId: device.vendorId, deviceId: device.deviceId, vendorString: device.vendorString,
        deviceString: device.deviceString, driverVendor: device.driverVendor, driverVersion: device.driverVersion,
      })),
      glVendor: gpu.auxAttributes?.glVendor, glRenderer: gpu.auxAttributes?.glRenderer,
      glVersion: gpu.auxAttributes?.glVersion,
      webgl: gpu.featureStatus.webgl,
      ...(gpu.featureStatus.webgl2 === undefined ? {} : { webgl2: gpu.featureStatus.webgl2 }),
    });
  } finally { await session.detach(); }
}

export function createHtmlOverlayGpuEvidence(
  executionProfile: HtmlOverlayExecutionProfile,
  context: unknown,
  browserGpu: unknown,
): HtmlOverlayGpuEvidence {
  return parseHtmlOverlayGpuEvidence({
    kind: "slopcamera.html-overlay-gpu-evidence", schemaVersion: 1, executionProfile,
    api: "webgl2", backend: "angle-metal", platform: process.platform,
    architecture: process.arch, osRelease: release(), context, browserGpu,
  });
}
