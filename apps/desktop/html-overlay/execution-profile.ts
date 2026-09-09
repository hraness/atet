import { z } from "zod";

/** Absence selects the historical software contract without changing its bytes. */
export const HtmlOverlayExecutionProfileSchema = z.enum([
  "three-webgl2-hardware-v1",
  "three-spark-webgl2-hardware-v1",
]);
export type HtmlOverlayExecutionProfile = z.infer<typeof HtmlOverlayExecutionProfileSchema>;

const description = z.string().min(1).max(1_024);
const optionalDescription = z.string().max(1_024);
const dimension = z.number().int().positive().max(1_048_576);
export const HtmlOverlayWebGlContextEvidenceSchema = z.strictObject({
  vendor: description, renderer: description, version: description.regex(/^WebGL 2\.0(?:\s|$)/u), shadingLanguageVersion: description,
  unmaskedVendor: description, unmaskedRenderer: description,
  maxTextureSize: dimension, maxRenderbufferSize: dimension,
  maxViewportDimensions: z.tuple([dimension, dimension]),
  halfFloatColorBuffer: z.literal(true),
});
export const HtmlOverlayBrowserGpuEvidenceSchema = z.strictObject({
  devices: z.array(z.strictObject({
    vendorId: z.number().int().min(0).max(0xffff_ffff), deviceId: z.number().int().min(0).max(0xffff_ffff),
    vendorString: optionalDescription, deviceString: description,
    driverVendor: optionalDescription, driverVersion: optionalDescription,
  })).min(1).max(8),
  glVendor: description, glRenderer: description, glVersion: description,
  webgl: z.literal("enabled"), webgl2: z.literal("enabled").optional(),
});
const softwareRenderer = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|lavapipe/iu;
const metalRenderer = /^ANGLE \(([^,()]+), ANGLE Metal Renderer: ([^,()]+), .+\)$/u;
function metalDeviceIdentity(renderer: string): string | undefined {
  const match = metalRenderer.exec(renderer);
  if (match === null || match[1]!.trim().length === 0 || match[2]!.trim().length === 0) return undefined;
  // WebGL intentionally redacts the version suffix that CDP exposes. Preserve
  // both raw observations; match the exact vendor/model with a Metal backend.
  return JSON.stringify([match[1]!.trim(), match[2]!.trim()]);
}

/** Host observations, not authored assertions or a promise of cross-driver pixel identity. */
export const HtmlOverlayGpuEvidenceSchema = z.strictObject({
  kind: z.literal("atet.html-overlay-gpu-evidence"), schemaVersion: z.literal(1),
  executionProfile: HtmlOverlayExecutionProfileSchema,
  api: z.literal("webgl2"), backend: z.literal("angle-metal"),
  platform: z.literal("darwin"), architecture: z.enum(["arm64", "x64"]), osRelease: description,
  context: HtmlOverlayWebGlContextEvidenceSchema,
  browserGpu: HtmlOverlayBrowserGpuEvidenceSchema,
}).superRefine((evidence, context) => {
  const active = evidence.context.unmaskedRenderer;
  const metal = metalDeviceIdentity(active);
  const descriptions = [active, evidence.context.unmaskedVendor, evidence.browserGpu.glRenderer,
    ...evidence.browserGpu.devices.flatMap(device => [device.deviceString, device.vendorString])];
  if (metal === undefined
    || softwareRenderer.test(descriptions.join("\n"))
    || metalDeviceIdentity(evidence.browserGpu.glRenderer) !== metal
    || !evidence.browserGpu.devices.some(device => metalDeviceIdentity(device.deviceString) === metal)) {
    context.addIssue({ code: "custom", message: "Hardware rendering requires matching active WebGL2 and browser ANGLE Metal device evidence; software or unknown fallback is unsupported." });
  }
});
export type HtmlOverlayGpuEvidence = z.infer<typeof HtmlOverlayGpuEvidenceSchema>;

export function parseHtmlOverlayGpuEvidence(input: unknown): HtmlOverlayGpuEvidence {
  return HtmlOverlayGpuEvidenceSchema.parse(input);
}

/** Shared by production, projection verification and recovery without starting a GPU. */
export function assertHtmlOverlayGpuEvidenceProfile(
  profile: HtmlOverlayExecutionProfile | undefined,
  input: unknown,
): HtmlOverlayGpuEvidence | undefined {
  if (profile === undefined) {
    if (input !== undefined) throw new Error("Legacy software rendering must not claim hardware evidence.");
    return undefined;
  }
  const evidence = parseHtmlOverlayGpuEvidence(input);
  if (evidence.executionProfile !== profile) throw new Error("GPU evidence differs from the requested execution profile.");
  return evidence;
}
