import { expect, test } from "bun:test";
import { assertHtmlOverlayGpuEvidenceProfile, HtmlOverlayGpuEvidenceSchema, HtmlOverlayExecutionProfileSchema } from "./execution-profile";
import { hardwareEvidenceFixture } from "./execution-profile.testing";

test("hardware admission requires matching actual Metal context and browser evidence", () => {
  const hardware = hardwareEvidenceFixture();
  expect(assertHtmlOverlayGpuEvidenceProfile(hardware.executionProfile, hardware)).toEqual(hardware);
  const variants = [
    { ...hardware, context: { ...hardware.context, unmaskedRenderer: "ANGLE (Google, SwiftShader Device (Subzero), Vulkan 1.3)" } },
    { ...hardware, context: { ...hardware.context, unmaskedRenderer: "WebKit WebGL" } },
    { ...hardware, context: { ...hardware.context, unmaskedVendor: "" } },
    { ...hardware, context: { ...hardware.context, version: "WebGL 1.0 (OpenGL ES 2.0 Chromium)" } },
    { ...hardware, context: { ...hardware.context, halfFloatColorBuffer: false } },
    { ...hardware, browserGpu: { ...hardware.browserGpu, glRenderer: hardware.browserGpu.glRenderer.replace("M3", "M4") } },
    { ...hardware, browserGpu: { ...hardware.browserGpu, glRenderer: hardware.browserGpu.glRenderer.replace("ANGLE (Apple,", "ANGLE (Unknown,") } },
    { ...hardware, browserGpu: { ...hardware.browserGpu, glRenderer: hardware.browserGpu.glRenderer.replace("Metal", "Vulkan") } },
    { ...hardware, browserGpu: { ...hardware.browserGpu, devices: [{ ...hardware.browserGpu.devices[0]!, deviceString: "Unknown GPU" }] } },
    { ...hardware, browserGpu: { ...hardware.browserGpu, devices: [{ ...hardware.browserGpu.devices[0]!, deviceString: hardware.browserGpu.devices[0]!.deviceString.replace("M3 Pro", "M3 Pro Max") }] } },
    { ...hardware, browserGpu: { ...hardware.browserGpu, webgl2: "enabled_readback" } },
    { ...hardware, architecture: "unknown" },
    { ...hardware, platform: "linux" },
    { ...hardware, browserGpu: { ...hardware.browserGpu, commandLine: "must not be retained" } },
  ];
  for (const variant of variants) expect(HtmlOverlayGpuEvidenceSchema.safeParse(variant).success).toBe(false);
});

test("observed M4 Max context and CDP suffix differences retain their raw identities", () => {
  // The two strings and omitted CDP webgl2 field are from the native Chromium
  // 152.0.7977.83 probe; remaining fixture fields are not qualification evidence.
  const contextRenderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)";
  const browserRenderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Version 26.5.2 (Build 25F84))";
  const fixture = hardwareEvidenceFixture();
  const observed = { ...fixture, context: { ...fixture.context, unmaskedRenderer: contextRenderer },
    browserGpu: { ...fixture.browserGpu, glRenderer: browserRenderer,
      devices: [{ ...fixture.browserGpu.devices[0]!, deviceString: browserRenderer, driverVersion: "26.5.2" }] } };
  const retained = HtmlOverlayGpuEvidenceSchema.parse(observed);
  expect(retained).toEqual(observed);
  expect(Object.hasOwn(retained.browserGpu, "webgl2")).toBe(false);
  expect(retained.context.unmaskedRenderer).not.toBe(retained.browserGpu.glRenderer);
});

test("legacy and explicit profiles cannot substitute or fabricate GPU evidence", () => {
  expect(assertHtmlOverlayGpuEvidenceProfile(undefined, undefined)).toBeUndefined();
  expect(() => assertHtmlOverlayGpuEvidenceProfile(undefined, hardwareEvidenceFixture())).toThrow();
  expect(() => assertHtmlOverlayGpuEvidenceProfile("three-webgl2-hardware-v1", undefined)).toThrow();
  expect(() => assertHtmlOverlayGpuEvidenceProfile("three-spark-webgl2-hardware-v1", hardwareEvidenceFixture())).toThrow();
  for (const profile of ["auto", "webgpu", "swiftshader", "--use-angle=metal"]) expect(HtmlOverlayExecutionProfileSchema.safeParse(profile).success).toBe(false);
});
