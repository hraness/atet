import type { HtmlOverlayExecutionProfile, HtmlOverlayGpuEvidence } from "./execution-profile";

/** Synthetic parser fixture. Never native device qualification evidence. */
export function hardwareEvidenceFixture(executionProfile: HtmlOverlayExecutionProfile = "three-webgl2-hardware-v1"): HtmlOverlayGpuEvidence {
  const renderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)";
  const browserRenderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Version fixture)";
  return {
    kind: "slopcamera.html-overlay-gpu-evidence", schemaVersion: 1, executionProfile, api: "webgl2", backend: "angle-metal",
    platform: "darwin", architecture: "arm64", osRelease: "25.0.0",
    context: { vendor: "WebKit", renderer: "WebKit WebGL", version: "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
      shadingLanguageVersion: "WebGL GLSL ES 3.00", unmaskedVendor: "Google Inc. (Apple)", unmaskedRenderer: renderer,
      maxTextureSize: 16_384, maxRenderbufferSize: 16_384, maxViewportDimensions: [16_384, 16_384], halfFloatColorBuffer: true },
    browserGpu: { devices: [{ vendorId: 0x106b, deviceId: 0, vendorString: "Apple", deviceString: browserRenderer, driverVendor: "Apple", driverVersion: "fixture" }],
      glVendor: "Google Inc. (Apple)", glRenderer: browserRenderer, glVersion: "OpenGL ES 3.0 (ANGLE fixture)", webgl: "enabled" },
  };
}
