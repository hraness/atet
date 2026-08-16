import { z } from "zod";

import { canonicalJson } from "../core/canonical-json";
import { HtmlOverlayLibrarySelectionSchema } from "./libraries";

export const HTML_OVERLAY_SCHEMA_VERSION = 1 as const;
export const HTML_OVERLAY_MAX_HTML_BYTES = 1024 * 1024;
export const HTML_OVERLAY_MAX_PARAMETER_BYTES = 64 * 1024;
export const HTML_OVERLAY_MAX_PARAMETER_DEPTH = 8;
export const HTML_OVERLAY_MAX_PARAMETER_NODES = 2_048;
export const HTML_OVERLAY_MAX_RESOURCES = 64;
export const HTML_OVERLAY_MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
export const HTML_OVERLAY_MAX_TOTAL_RESOURCE_BYTES = 256 * 1024 * 1024;
export const HTML_OVERLAY_MAX_DURATION_US = 3_600_000_000;
export const HTML_OVERLAY_MAX_FRAMES = 216_000;
export const HTML_OVERLAY_MAX_DEVICE_PIXELS_PER_FRAME = 33_554_432;
export const HTML_OVERLAY_MAX_TOTAL_PIXEL_SAMPLES = 300_000_000_000;

const textEncoder = new TextEncoder();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResourceNameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u);
const ResourceUrlPathSchema = z.string()
  .min(1)
  .max(512)
  .refine((path) => (
    !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\0")
    && !path.includes("?")
    && !path.includes("#")
    && !path.includes("%")
    && path.split("/").every(segment => (
      /^[A-Za-z0-9][A-Za-z0-9._~@+-]{0,127}$/u.test(segment)
      && segment !== "."
      && segment !== ".."
    ))
  ), "Expected an unescaped relative URL path without dot segments, query, or fragment.");
const MediaTypeSchema = z.string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);
const Uint32Schema = z.number().int().safe().min(0).max(0xffff_ffff);

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const HtmlOverlayCanvasSchema = z.strictObject({
  deviceScaleFactor: z.number().finite().min(0.5).max(4),
  height: z.number().int().safe().min(1).max(8_192),
  width: z.number().int().safe().min(1).max(8_192),
}).superRefine((canvas, context) => {
  const pixels = canvas.width * canvas.height * canvas.deviceScaleFactor ** 2;
  if (pixels > HTML_OVERLAY_MAX_DEVICE_PIXELS_PER_FRAME) {
    context.addIssue({
      code: "custom",
      message: `HTML overlay canvas exceeds ${HTML_OVERLAY_MAX_DEVICE_PIXELS_PER_FRAME} device pixels.`,
    });
  }
});
export type HtmlOverlayCanvas = Readonly<z.infer<typeof HtmlOverlayCanvasSchema>>;

export const HtmlOverlayTimingSchema = z.strictObject({
  durationUs: z.number().int().safe().min(1).max(HTML_OVERLAY_MAX_DURATION_US),
  fps: z.number().int().safe().min(1).max(120),
});
export type HtmlOverlayTiming = Readonly<z.infer<typeof HtmlOverlayTimingSchema>>;

export type HtmlOverlayParameterValue =
  | boolean
  | null
  | number
  | string
  | readonly HtmlOverlayParameterValue[]
  | { readonly [key: string]: HtmlOverlayParameterValue };
export type HtmlOverlayParameters = Readonly<Record<string, HtmlOverlayParameterValue>>;

const ParameterKeySchema = z.string()
  .min(1)
  .max(128)
  .refine(key => key !== "__proto__", "The reserved __proto__ parameter key is not allowed.");

function createParameterValueSchema(depth: number): z.ZodType<HtmlOverlayParameterValue> {
  const scalar = z.union([
    z.null(),
    z.boolean(),
    z.number().finite().overwrite(value => Object.is(value, -0) ? 0 : value),
    z.string().max(4_096),
  ]);
  if (depth >= HTML_OVERLAY_MAX_PARAMETER_DEPTH) return scalar;
  const child = createParameterValueSchema(depth + 1);
  const object = z.record(ParameterKeySchema, child).superRefine((value, context) => {
    if (Object.keys(value).length > 64) {
      context.addIssue({ code: "custom", message: "HTML overlay parameter objects may contain at most 64 keys." });
    }
  });
  return z.union([
    scalar,
    z.array(child).max(128),
    object,
  ]);
}

const ParameterValueSchema = createParameterValueSchema(0);

const HtmlOverlayParametersStructureSchema = z
  .record(ParameterKeySchema, ParameterValueSchema)
  .superRefine((parameters, context) => {
    if (Object.keys(parameters).length > 64) {
      context.addIssue({ code: "custom", message: "HTML overlay parameters may contain at most 64 top-level keys." });
    }
    if (textEncoder.encode(canonicalJson(parameters)).byteLength > HTML_OVERLAY_MAX_PARAMETER_BYTES) {
      context.addIssue({
        code: "custom",
        message: `HTML overlay parameters exceed ${HTML_OVERLAY_MAX_PARAMETER_BYTES} UTF-8 bytes.`,
      });
    }
    const stack: HtmlOverlayParameterValue[] = Object.values(parameters);
    let nodes = 0;
    while (stack.length > 0) {
      const value = stack.pop();
      if (value === undefined) continue;
      nodes += 1;
      if (nodes > HTML_OVERLAY_MAX_PARAMETER_NODES) {
        context.addIssue({
          code: "custom",
          message: `HTML overlay parameters exceed ${HTML_OVERLAY_MAX_PARAMETER_NODES} values.`,
        });
        break;
      }
      if (Array.isArray(value)) {
        stack.push(...(value as readonly HtmlOverlayParameterValue[]));
      } else if (value !== null && typeof value === "object") {
        const record = value as Readonly<Record<string, HtmlOverlayParameterValue>>;
        stack.push(...Object.values(record));
      }
    }
  });

const HtmlOverlayParametersPreflightSchema = z.unknown().superRefine((input, context) => {
  try {
    if (
      input === null
      || typeof input !== "object"
      || Array.isArray(input)
      || (
        Object.getPrototypeOf(input) !== Object.prototype
        && Object.getPrototypeOf(input) !== null
      )
    ) {
      context.addIssue({ code: "custom", message: "HTML overlay parameters must be a plain object." });
      return;
    }
    const seen = new WeakSet<object>();
    const stack: Array<{ readonly depth: number; readonly value: unknown }> = [{
      depth: 0,
      value: input,
    }];
    let nodes = 0;
    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) break;
      nodes += 1;
      if (nodes > HTML_OVERLAY_MAX_PARAMETER_NODES) {
        context.addIssue({
          code: "custom",
          message: `HTML overlay parameters exceed ${HTML_OVERLAY_MAX_PARAMETER_NODES} values.`,
        });
        return;
      }
      if (entry.depth > HTML_OVERLAY_MAX_PARAMETER_DEPTH + 1) {
        context.addIssue({
          code: "custom",
          message: `HTML overlay parameters exceed depth ${HTML_OVERLAY_MAX_PARAMETER_DEPTH}.`,
        });
        return;
      }
      if (entry.value === null || typeof entry.value !== "object") continue;
      if (seen.has(entry.value)) {
        context.addIssue({ code: "custom", message: "HTML overlay parameters must not contain cycles or aliases." });
        return;
      }
      seen.add(entry.value);
      const prototype: unknown = Object.getPrototypeOf(entry.value);
      if (Array.isArray(entry.value)) {
        if (
          prototype !== Array.prototype
          || Reflect.ownKeys(entry.value).some(key => (
            typeof key !== "string"
            || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))
          ))
          || Object.keys(entry.value).length !== entry.value.length
        ) {
          context.addIssue({ code: "custom", message: "HTML overlay parameter arrays must be dense plain arrays." });
          return;
        }
        for (const item of entry.value) {
          stack.push({ depth: entry.depth + 1, value: item });
        }
        continue;
      }
      if (prototype !== Object.prototype && prototype !== null) {
        context.addIssue({ code: "custom", message: "HTML overlay parameter values must be plain JSON objects." });
        return;
      }
      if (Object.hasOwn(entry.value, "__proto__")) {
        context.addIssue({ code: "custom", message: "The reserved __proto__ parameter key is not allowed." });
        return;
      }
      const ownKeys = Reflect.ownKeys(entry.value);
      if (ownKeys.some(key => typeof key !== "string")) {
        context.addIssue({ code: "custom", message: "HTML overlay parameter objects must not contain symbol keys." });
        return;
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry.value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!("value" in descriptor)) {
          context.addIssue({ code: "custom", message: "HTML overlay parameters must not contain accessors." });
          return;
        }
        if (key.length === 0 || key.length > 128) {
          context.addIssue({ code: "custom", message: "HTML overlay parameter keys must contain 1–128 characters." });
          return;
        }
        stack.push({ depth: entry.depth + 1, value: descriptor.value });
      }
    }
  } catch {
    context.addIssue({ code: "custom", message: "HTML overlay parameters could not be inspected safely." });
  }
});

export const HtmlOverlayParametersSchema: z.ZodType<HtmlOverlayParameters> =
  HtmlOverlayParametersPreflightSchema.pipe(HtmlOverlayParametersStructureSchema);

export const HtmlOverlayDeclaredResourceSchema = z.strictObject({
  bytes: z.number().int().safe().min(0).max(HTML_OVERLAY_MAX_RESOURCE_BYTES),
  mediaType: MediaTypeSchema,
  name: ResourceNameSchema,
  sha256: Sha256Schema,
  urlPath: ResourceUrlPathSchema,
});
export type HtmlOverlayDeclaredResource = Readonly<z.infer<typeof HtmlOverlayDeclaredResourceSchema>>;

export const HtmlOverlayDeclaredResourcesSchema = z.array(HtmlOverlayDeclaredResourceSchema)
  .max(HTML_OVERLAY_MAX_RESOURCES)
  .superRefine((resources, context) => {
    if (new Set(resources.map(resource => resource.name)).size !== resources.length) {
      context.addIssue({ code: "custom", message: "HTML overlay resource names must be unique." });
    }
    if (new Set(resources.map(resource => resource.urlPath)).size !== resources.length) {
      context.addIssue({ code: "custom", message: "HTML overlay resource URL paths must be unique." });
    }
    const totalBytes = resources.reduce((total, resource) => total + resource.bytes, 0);
    if (totalBytes > HTML_OVERLAY_MAX_TOTAL_RESOURCE_BYTES) {
      context.addIssue({
        code: "custom",
        message: `HTML overlay resources exceed ${HTML_OVERLAY_MAX_TOTAL_RESOURCE_BYTES} total bytes.`,
      });
    }
  })
  .overwrite(resources => [...resources].sort((left, right) => compareAscii(left.name, right.name)));
export type HtmlOverlayDeclaredResources = Readonly<z.infer<typeof HtmlOverlayDeclaredResourcesSchema>>;

const HtmlDocumentSchema = z.string()
  .min(1)
  .max(HTML_OVERLAY_MAX_HTML_BYTES)
  .refine(html => !html.includes("\0"), "HTML overlay documents must not contain NUL.")
  .refine(
    html => textEncoder.encode(html).byteLength <= HTML_OVERLAY_MAX_HTML_BYTES,
    `HTML overlay documents may not exceed ${HTML_OVERLAY_MAX_HTML_BYTES} UTF-8 bytes.`,
  );

export const HtmlOverlayInlineDocumentSchema = z.strictObject({
  html: HtmlDocumentSchema,
});
export type HtmlOverlayInlineDocument = Readonly<
  z.infer<typeof HtmlOverlayInlineDocumentSchema>
>;

export function htmlOverlayFrameCount(timing: HtmlOverlayTiming): number {
  const parsed = HtmlOverlayTimingSchema.parse(timing);
  return Math.ceil((parsed.durationUs * parsed.fps) / 1_000_000);
}

export const HtmlOverlayAuthoringInputSchema = z.strictObject({
  canvas: HtmlOverlayCanvasSchema,
  html: HtmlDocumentSchema,
  // Studio v1 authoring inputs remain readable, but every parsed/new value is
  // normalized to the canonical Atet identity before hashing or render.
  kind: z.union([
    z.literal("atet.html-overlay"),
    z.literal("studio.html-overlay"),
  ]).overwrite(() => "atet.html-overlay" as const),
  libraries: HtmlOverlayLibrarySelectionSchema.default([]),
  parameters: HtmlOverlayParametersSchema.default({}),
  resources: HtmlOverlayDeclaredResourcesSchema.default([]),
  schemaVersion: z.literal(HTML_OVERLAY_SCHEMA_VERSION),
  seed: Uint32Schema,
  timing: HtmlOverlayTimingSchema,
}).superRefine((input, context) => {
  const frames = htmlOverlayFrameCount(input.timing);
  if (frames > HTML_OVERLAY_MAX_FRAMES) {
    context.addIssue({
      code: "custom",
      message: `HTML overlay render exceeds ${HTML_OVERLAY_MAX_FRAMES} frames.`,
    });
  }
  const pixels = input.canvas.width
    * input.canvas.height
    * input.canvas.deviceScaleFactor ** 2
    * frames;
  if (pixels > HTML_OVERLAY_MAX_TOTAL_PIXEL_SAMPLES) {
    context.addIssue({
      code: "custom",
      message: `HTML overlay render exceeds ${HTML_OVERLAY_MAX_TOTAL_PIXEL_SAMPLES} total pixel samples.`,
    });
  }
});
export type HtmlOverlayAuthoringInput = Readonly<z.infer<typeof HtmlOverlayAuthoringInputSchema>>;

export const HtmlOverlayRuntimeFrameSchema = z.strictObject({
  deltaMs: z.number().finite().nonnegative(),
  frame: z.number().int().safe().nonnegative(),
  height: z.number().int().safe().positive(),
  progress: z.number().finite().min(0).max(1),
  timeMs: z.number().finite().nonnegative(),
  width: z.number().int().safe().positive(),
});
export type HtmlOverlayRuntimeFrame = Readonly<z.infer<typeof HtmlOverlayRuntimeFrameSchema>>;

export function createHtmlOverlayRuntimeFrame(
  frame: number,
  canvas: HtmlOverlayCanvas,
  timing: HtmlOverlayTiming,
): HtmlOverlayRuntimeFrame {
  const parsedCanvas = HtmlOverlayCanvasSchema.parse(canvas);
  const parsedTiming = HtmlOverlayTimingSchema.parse(timing);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= htmlOverlayFrameCount(parsedTiming)) {
    throw new RangeError(`HTML overlay frame ${String(frame)} is outside the render range.`);
  }
  const timeMs = (frame * 1_000) / parsedTiming.fps;
  const durationMs = parsedTiming.durationUs / 1_000;
  return Object.freeze({
    deltaMs: frame === 0 ? 0 : 1_000 / parsedTiming.fps,
    frame,
    height: parsedCanvas.height,
    progress: Math.min(1, timeMs / durationMs),
    timeMs,
    width: parsedCanvas.width,
  });
}

export function parseHtmlOverlayRuntimeFrame(
  value: unknown,
  canvas: HtmlOverlayCanvas,
  timing: HtmlOverlayTiming,
): HtmlOverlayRuntimeFrame {
  const parsed = HtmlOverlayRuntimeFrameSchema.parse(value);
  const expected = createHtmlOverlayRuntimeFrame(parsed.frame, canvas, timing);
  for (const key of ["deltaMs", "frame", "height", "progress", "timeMs", "width"] as const) {
    if (!Object.is(parsed[key], expected[key])) {
      throw new RangeError(`HTML overlay frame field ${key} does not match the absolute render clock.`);
    }
  }
  return expected;
}
