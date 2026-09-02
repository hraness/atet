import { z } from "zod";

import {
  HtmlOverlayLibrarySelectionSchema,
  type HtmlOverlayLibrarySelection,
} from "./libraries";

export const HTML_OVERLAY_SCAFFOLD_KINDS = Object.freeze([
  "plain",
  "motion",
  "p5",
  "two",
  "paper-shaders",
  "three",
  "vgpu",
] as const);

export const HtmlOverlayScaffoldKindSchema = z.enum(HTML_OVERLAY_SCAFFOLD_KINDS);
export type HtmlOverlayScaffoldKind = typeof HTML_OVERLAY_SCAFFOLD_KINDS[number];

export const HTML_OVERLAY_SCAFFOLD_PRIMARY_JOBS = Object.freeze([
  "dom-layout",
  "dom-motion",
  "immediate-2d",
  "retained-2d",
  "shader-texture",
  "scene-3d",
  "gpu-pipeline",
] as const);
export const HtmlOverlayScaffoldPrimaryJobSchema = z.enum(
  HTML_OVERLAY_SCAFFOLD_PRIMARY_JOBS,
);
export type HtmlOverlayScaffoldPrimaryJob =
  typeof HTML_OVERLAY_SCAFFOLD_PRIMARY_JOBS[number];

export const HTML_OVERLAY_SCAFFOLD_SUBSTRATES = Object.freeze([
  "dom",
  "canvas-2d",
  "webgl",
  "webgl-2",
  "webgpu",
] as const);
export const HtmlOverlayScaffoldSubstrateSchema = z.enum(
  HTML_OVERLAY_SCAFFOLD_SUBSTRATES,
);
export type HtmlOverlayScaffoldSubstrate =
  typeof HTML_OVERLAY_SCAFFOLD_SUBSTRATES[number];

export const HTML_OVERLAY_SCAFFOLD_CLOCK_INTEGRATIONS = Object.freeze([
  "absolute-frame",
  "seeked-animation",
] as const);
export const HtmlOverlayScaffoldClockIntegrationSchema = z.enum(
  HTML_OVERLAY_SCAFFOLD_CLOCK_INTEGRATIONS,
);
export type HtmlOverlayScaffoldClockIntegration =
  typeof HTML_OVERLAY_SCAFFOLD_CLOCK_INTEGRATIONS[number];

export const HtmlOverlayScaffoldProfileSchema = z.strictObject({
  bestFor: z.string().min(1).max(240),
  clockIntegration: HtmlOverlayScaffoldClockIntegrationSchema,
  kind: HtmlOverlayScaffoldKindSchema,
  libraries: HtmlOverlayLibrarySelectionSchema,
  primaryJob: HtmlOverlayScaffoldPrimaryJobSchema,
  substrate: HtmlOverlayScaffoldSubstrateSchema,
  summary: z.string().min(1).max(160),
});

type ParsedHtmlOverlayScaffoldProfile = z.infer<
  typeof HtmlOverlayScaffoldProfileSchema
>;
export type HtmlOverlayScaffoldProfile = Readonly<
  Omit<ParsedHtmlOverlayScaffoldProfile, "libraries">
  & { readonly libraries: HtmlOverlayLibrarySelection }
>;

function frozenProfile(
  input: z.input<typeof HtmlOverlayScaffoldProfileSchema>,
): HtmlOverlayScaffoldProfile {
  const parsed = HtmlOverlayScaffoldProfileSchema.parse(input);
  return Object.freeze({
    ...parsed,
    libraries: Object.freeze([...parsed.libraries]),
  });
}

/**
 * Supported authoring profiles in stable recommendation order. This registry is
 * advisory metadata, not persisted render state; exact executable provenance
 * remains owned by the library-lock registry.
 */
const HTML_OVERLAY_SCAFFOLD_PROFILE_BY_KIND = Object.freeze({
  plain: frozenProfile({
    bestFor: "Semantic layout, typography, SVG, and lightweight native Canvas work.",
    clockIntegration: "absolute-frame",
    kind: "plain",
    libraries: [],
    primaryJob: "dom-layout",
    substrate: "dom",
    summary: "Native document composition without a browser-library dependency.",
  }),
  motion: frozenProfile({
    bestFor: "Titles, cards, lower thirds, and interface-like choreography.",
    clockIntegration: "seeked-animation",
    kind: "motion",
    libraries: ["motion"],
    primaryJob: "dom-motion",
    substrate: "dom",
    summary: "Seekable DOM and SVG choreography with Motion.",
  }),
  p5: frozenProfile({
    bestFor: "Generative drawing, procedural illustration, and sketch-led art.",
    clockIntegration: "absolute-frame",
    kind: "p5",
    libraries: ["p5"],
    primaryJob: "immediate-2d",
    substrate: "canvas-2d",
    summary: "Immediate-mode Canvas 2D sketches with manual redraw.",
  }),
  two: frozenProfile({
    bestFor: "Retained vector shapes, particles, and many-object 2D compositions.",
    clockIntegration: "absolute-frame",
    kind: "two",
    libraries: ["two.js"],
    primaryJob: "retained-2d",
    substrate: "webgl",
    summary: "Retained vector 2D scenes rendered through Two.js WebGL.",
  }),
  "paper-shaders": frozenProfile({
    bestFor: "Mesh gradients, grain, distortion, and polished shader treatments.",
    clockIntegration: "absolute-frame",
    kind: "paper-shaders",
    libraries: ["@paper-design/shaders"],
    primaryJob: "shader-texture",
    substrate: "webgl",
    summary: "Declarative transparent shader textures and gradients.",
  }),
  three: frozenProfile({
    bestFor: "Lit 3D subjects, spatial scenes, materials, and camera work.",
    clockIntegration: "absolute-frame",
    kind: "three",
    libraries: ["three"],
    primaryJob: "scene-3d",
    substrate: "webgl-2",
    summary: "Retained 3D scenes, materials, cameras, and custom shaders.",
  }),
  vgpu: frozenProfile({
    bestFor: "Reviewed fullscreen WGSL effects and bounded multipass GPU work.",
    clockIntegration: "absolute-frame",
    kind: "vgpu",
    libraries: ["vgpu"],
    primaryJob: "gpu-pipeline",
    substrate: "webgpu",
    summary: "Explicit WGSL and WebGPU effects with pass-level control.",
  }),
} satisfies Readonly<
  Record<HtmlOverlayScaffoldKind, HtmlOverlayScaffoldProfile>
>);

export const HTML_OVERLAY_SCAFFOLD_PROFILES = Object.freeze(
  HTML_OVERLAY_SCAFFOLD_KINDS.map(
    kind => HTML_OVERLAY_SCAFFOLD_PROFILE_BY_KIND[kind],
  ),
);

export function getHtmlOverlayScaffoldProfile(
  kind: HtmlOverlayScaffoldKind,
): HtmlOverlayScaffoldProfile {
  const parsed = HtmlOverlayScaffoldKindSchema.parse(kind);
  return HTML_OVERLAY_SCAFFOLD_PROFILE_BY_KIND[parsed];
}
