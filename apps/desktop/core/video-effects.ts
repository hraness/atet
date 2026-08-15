import type {
  ColorGradeControls,
  ColorGradeSelection,
} from "../contracts/media-effects";
import {
  VideoLookPresetOptionsSchema,
  VideoLookPresetSchema,
  VideoLookV1Schema,
  type VideoEffect,
  type VideoEffectInput,
  type VideoLookPreset,
  type VideoLookPresetOptionsInput,
  type VideoLookV1,
} from "../contracts/video-effects";
import { canonicalJsonSha256 } from "./canonical-json";

interface ResolvedColorGradeControls {
  readonly brightness: number;
  readonly contrast: number;
  readonly gamma: number;
  readonly hue: number;
  readonly saturation: number;
  readonly temperature: number;
  readonly tint: number;
}

type ColorGradePreset = Extract<
  ColorGradeSelection,
  { readonly kind: "preset" }
>["preset"];

const NEUTRAL_GRADE: ResolvedColorGradeControls = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  hue: 0,
  saturation: 1,
  temperature: 0,
  tint: 0,
};

const COLOR_PRESETS = {
  cinematic: {
    brightness: -0.02,
    contrast: 1.14,
    gamma: 0.96,
    hue: 0,
    saturation: 0.88,
    temperature: 0.12,
    tint: 0.06,
  },
  clean: {
    brightness: 0.02,
    contrast: 1.04,
    gamma: 1,
    hue: 0,
    saturation: 1.02,
    temperature: 0,
    tint: 0,
  },
  cool: {
    brightness: 0,
    contrast: 1.05,
    gamma: 1,
    hue: 0,
    saturation: 0.96,
    temperature: -0.35,
    tint: 0,
  },
  flat: {
    brightness: 0.02,
    contrast: 0.86,
    gamma: 1.04,
    hue: 0,
    saturation: 0.85,
    temperature: 0,
    tint: 0,
  },
  monochrome: {
    brightness: 0,
    contrast: 1.1,
    gamma: 1,
    hue: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
  },
  vivid: {
    brightness: 0.01,
    contrast: 1.12,
    gamma: 1,
    hue: 0,
    saturation: 1.22,
    temperature: 0,
    tint: 0,
  },
  warm: {
    brightness: 0,
    contrast: 1.04,
    gamma: 1,
    hue: 0,
    saturation: 1.08,
    temperature: 0.35,
    tint: 0,
  },
} as const satisfies Readonly<Record<ColorGradePreset, ResolvedColorGradeControls>>;

const MAXIMUM_VIDEO_STREAM_INDEX = 1_024;
const COMPILER_VERSION = 1;

export interface VideoLookFfmpegCompileOptions {
  readonly videoStreamIndex?: number;
}

export interface CompiledVideoLook {
  readonly compiler: "atet.ffmpeg-video-look";
  readonly compilerVersion: typeof COMPILER_VERSION;
  readonly filterGraph: string;
  readonly inputLabel: string;
  readonly look: VideoLookV1;
  readonly lookHash: string;
  readonly outputLabel: string;
  readonly requiredFilters: readonly string[];
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError("FFmpeg video-effect values must be finite.");
  }
  const normalized = Math.abs(value) < 0.000_000_000_1 ? 0 : value;
  return normalized.toFixed(10).replace(/0+$/u, "").replace(/\.$/u, "");
}

function roundAmount(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function scaledAmount(base: number, intensity: number): number {
  return roundAmount(Math.min(1, Math.max(0, base * intensity)));
}

function createPresetEffects(
  preset: VideoLookPreset,
  intensity: number,
  seed: number,
): readonly VideoEffectInput[] {
  if (preset === "blue-16mm") {
    return [
      {
        amount: intensity,
        grade: {
          kind: "preset",
          overrides: {
            brightness: -0.03,
            contrast: 1.18,
            gamma: 0.92,
            saturation: 0.78,
            temperature: -0.55,
            tint: -0.06,
          },
          preset: "cinematic",
        },
        kind: "color-grade",
      },
      {
        amount: scaledAmount(0.72, intensity),
        highlights: "#9edbfa",
        kind: "duotone",
        shadows: "#061018",
      },
      {
        amount: scaledAmount(0.17, intensity),
        blendMode: "screen",
        kind: "diffusion",
        radiusPx: 4.8,
      },
      {
        amount: scaledAmount(0.48, intensity),
        cadence: "frame-varying",
        chroma: 0.08,
        kind: "film-grain",
        seed,
      },
      {
        amount: scaledAmount(0.22, intensity),
        kind: "vignette",
      },
    ];
  }
  if (preset === "warm-super-8") {
    return [
      {
        amount: intensity,
        grade: {
          kind: "preset",
          overrides: {
            brightness: 0.015,
            contrast: 1.1,
            gamma: 0.97,
            saturation: 0.96,
            temperature: 0.48,
            tint: 0.08,
          },
          preset: "warm",
        },
        kind: "color-grade",
      },
      {
        amount: scaledAmount(0.18, intensity),
        highlights: "#f4d6a2",
        kind: "duotone",
        shadows: "#21100e",
      },
      {
        amount: scaledAmount(0.12, intensity),
        blendMode: "screen",
        kind: "diffusion",
        radiusPx: 3.2,
      },
      {
        amount: scaledAmount(0.34, intensity),
        cadence: "frame-varying",
        chroma: 0.18,
        kind: "film-grain",
        seed,
      },
      {
        amount: scaledAmount(0.18, intensity),
        kind: "vignette",
      },
    ];
  }
  if (preset === "photocopy") {
    return [
      {
        amount: intensity,
        grade: { kind: "preset", preset: "monochrome" },
        kind: "color-grade",
      },
      {
        amount: scaledAmount(0.9, intensity),
        highlights: "#f0eee4",
        kind: "duotone",
        shadows: "#080808",
      },
      {
        amount: scaledAmount(0.82, intensity),
        bayerScale: 1,
        colors: 4,
        kind: "ordered-dither",
        matrix: "bayer-8x8",
      },
      {
        amount: scaledAmount(0.12, intensity),
        cadence: "fixed",
        chroma: 0,
        kind: "film-grain",
        seed,
      },
    ];
  }
  if (preset === "soft-vhs") {
    return [
      {
        amount: scaledAmount(0.72, intensity),
        grade: {
          kind: "preset",
          overrides: {
            contrast: 1.08,
            gamma: 0.98,
            saturation: 1.12,
          },
          preset: "cool",
        },
        kind: "color-grade",
      },
      {
        amount: scaledAmount(0.28, intensity),
        cadence: "frame-varying",
        chroma: 0.65,
        kind: "film-grain",
        seed,
      },
      {
        amount: scaledAmount(0.16, intensity),
        kind: "scanlines",
        spacingPx: 4,
        thicknessPx: 1,
      },
      {
        amount: scaledAmount(0.08, intensity),
        blendMode: "soft-light",
        kind: "diffusion",
        radiusPx: 2.4,
      },
      {
        amount: scaledAmount(0.15, intensity),
        kind: "vignette",
      },
    ];
  }
  preset satisfies never;
  throw new Error("Unreachable video-look preset.");
}

/** Expand a stable, inspectable preset into the same graph used by custom code. */
export function createVideoLookPreset(
  presetInput: VideoLookPreset,
  optionsInput: VideoLookPresetOptionsInput = {},
): VideoLookV1 {
  const preset = VideoLookPresetSchema.parse(presetInput);
  const options = VideoLookPresetOptionsSchema.parse(optionsInput);
  return VideoLookV1Schema.parse({
    effects: createPresetEffects(preset, options.intensity, options.seed),
    kind: "atet.video-look",
    processingColorSpace: "bt709-display",
    schemaVersion: 1,
  });
}

/** Normalize a custom graph so code-mode workflows receive defaults immediately. */
export function createVideoLook(effects: readonly VideoEffectInput[]): VideoLookV1 {
  return VideoLookV1Schema.parse({
    effects,
    kind: "atet.video-look",
    processingColorSpace: "bt709-display",
    schemaVersion: 1,
  });
}

export const videoLooks = {
  blue16mm: (options?: VideoLookPresetOptionsInput) =>
    createVideoLookPreset("blue-16mm", options),
  photocopy: (options?: VideoLookPresetOptionsInput) =>
    createVideoLookPreset("photocopy", options),
  softVhs: (options?: VideoLookPresetOptionsInput) =>
    createVideoLookPreset("soft-vhs", options),
  warmSuper8: (options?: VideoLookPresetOptionsInput) =>
    createVideoLookPreset("warm-super-8", options),
} as const;

function applyControls(
  base: ResolvedColorGradeControls,
  overrides: ColorGradeControls | undefined,
): ResolvedColorGradeControls {
  return {
    brightness: overrides?.brightness ?? base.brightness,
    contrast: overrides?.contrast ?? base.contrast,
    gamma: overrides?.gamma ?? base.gamma,
    hue: overrides?.hue ?? base.hue,
    saturation: overrides?.saturation ?? base.saturation,
    temperature: overrides?.temperature ?? base.temperature,
    tint: overrides?.tint ?? base.tint,
  };
}

function resolveColorGrade(grade: ColorGradeSelection): ResolvedColorGradeControls {
  return grade.kind === "custom"
    ? applyControls(NEUTRAL_GRADE, grade.controls)
    : applyControls(COLOR_PRESETS[grade.preset], grade.overrides);
}

function clampBalance(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function balanceBand(
  temperature: number,
  tint: number,
  strength: number,
): { readonly blue: number; readonly green: number; readonly red: number } {
  return {
    blue: clampBalance((-temperature + tint * 0.5) * strength),
    green: clampBalance(-tint * strength),
    red: clampBalance((temperature + tint * 0.5) * strength),
  };
}

function colorGradeTreatment(
  effect: Extract<VideoEffect, { readonly kind: "color-grade" }>,
): { readonly filter: string; readonly names: readonly string[] } {
  const controls = resolveColorGrade(effect.grade);
  const filters = [
    `eq=brightness=${decimal(controls.brightness)}:contrast=${decimal(controls.contrast)}:saturation=${decimal(controls.saturation)}:gamma=${decimal(controls.gamma)}`,
  ];
  const names = ["eq"];
  if (controls.temperature !== 0 || controls.tint !== 0) {
    const shadows = balanceBand(controls.temperature, controls.tint, 0.12);
    const midtones = balanceBand(controls.temperature, controls.tint, 0.2);
    const highlights = balanceBand(controls.temperature, controls.tint, 0.1);
    filters.push([
      `colorbalance=rs=${decimal(shadows.red)}`,
      `gs=${decimal(shadows.green)}`,
      `bs=${decimal(shadows.blue)}`,
      `rm=${decimal(midtones.red)}`,
      `gm=${decimal(midtones.green)}`,
      `bm=${decimal(midtones.blue)}`,
      `rh=${decimal(highlights.red)}`,
      `gh=${decimal(highlights.green)}`,
      `bh=${decimal(highlights.blue)}`,
    ].join(":"));
    names.push("colorbalance");
  }
  if (controls.hue !== 0) {
    filters.push(`hue=h=${decimal(controls.hue)}`);
    names.push("hue");
  }
  return { filter: filters.join(","), names };
}

function parseRgbHex(color: string): readonly [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16) / 255,
    Number.parseInt(color.slice(3, 5), 16) / 255,
    Number.parseInt(color.slice(5, 7), 16) / 255,
  ];
}

function duotoneTreatment(
  effect: Extract<VideoEffect, { readonly kind: "duotone" }>,
): string {
  const shadows = parseRgbHex(effect.shadows);
  const highlights = parseRgbHex(effect.highlights);
  const curve = (shadow: number, highlight: number) =>
    `'0/${decimal(shadow)} 1/${decimal(highlight)}'`;
  return [
    "hue=s=0",
    `curves=interp=pchip:r=${curve(shadows[0], highlights[0])}:g=${curve(shadows[1], highlights[1])}:b=${curve(shadows[2], highlights[2])}`,
  ].join(",");
}

function effectOutputLabel(index: number): string {
  return `video_look_${index}`;
}

function addRequired(required: Set<string>, names: readonly string[]): void {
  for (const name of names) required.add(name);
}

function appendMixedTreatment(
  graph: string[],
  required: Set<string>,
  currentLabel: string,
  outputLabel: string,
  treatment: string,
  treatmentFilters: readonly string[],
  amount: number,
): string {
  addRequired(required, treatmentFilters);
  if (amount === 1) {
    graph.push(`[${currentLabel}]${treatment}[${outputLabel}]`);
    return outputLabel;
  }
  const base = `${outputLabel}_base`;
  const treatedInput = `${outputLabel}_treated_input`;
  const treated = `${outputLabel}_treated`;
  graph.push(`[${currentLabel}]split=2[${base}][${treatedInput}]`);
  graph.push(`[${treatedInput}]${treatment}[${treated}]`);
  graph.push(
    `[${base}][${treated}]blend=all_mode=normal:all_opacity=${decimal(amount)}[${outputLabel}]`,
  );
  required.add("split");
  required.add("blend");
  return outputLabel;
}

function appendDiffusion(
  graph: string[],
  required: Set<string>,
  currentLabel: string,
  outputLabel: string,
  effect: Extract<VideoEffect, { readonly kind: "diffusion" }>,
): string {
  const base = `${outputLabel}_base`;
  const blurInput = `${outputLabel}_blur_input`;
  const blurred = `${outputLabel}_blurred`;
  const blendMode = effect.blendMode === "soft-light" ? "softlight" : "screen";
  graph.push(`[${currentLabel}]split=2[${base}][${blurInput}]`);
  graph.push(`[${blurInput}]gblur=sigma=${decimal(effect.radiusPx)}:steps=2[${blurred}]`);
  graph.push(
    `[${base}][${blurred}]blend=all_mode=${blendMode}:all_opacity=${decimal(effect.amount)}[${outputLabel}]`,
  );
  addRequired(required, ["split", "gblur", "blend"]);
  return outputLabel;
}

function grainTreatment(
  effect: Extract<VideoEffect, { readonly kind: "film-grain" }>,
): string {
  const lumaStrength = Math.max(1, Math.round(effect.amount * 64));
  const chromaStrength = Math.round(lumaStrength * effect.chroma);
  const flags = effect.cadence === "frame-varying" ? "t+u" : "u";
  const seed1 = effect.seed === 2_147_483_647 ? 0 : effect.seed + 1;
  const seed2 = seed1 === 2_147_483_647 ? 0 : seed1 + 1;
  return [
    "format=yuv444p",
    [
      `noise=c0s=${lumaStrength}`,
      `c1s=${chromaStrength}`,
      `c2s=${chromaStrength}`,
      `c0_seed=${effect.seed}`,
      `c1_seed=${seed1}`,
      `c2_seed=${seed2}`,
      `c0f=${flags}`,
      `c1f=${flags}`,
      `c2f=${flags}`,
    ].join(":"),
  ].join(",");
}

function appendPaletteDither(
  graph: string[],
  required: Set<string>,
  currentLabel: string,
  outputLabel: string,
  colors: number,
  amount: number,
  paletteUse: string,
): string {
  const base = `${outputLabel}_base`;
  const pixels = `${outputLabel}_pixels`;
  const paletteInput = `${outputLabel}_palette_input`;
  const palette = `${outputLabel}_palette`;
  const dithered = `${outputLabel}_dithered`;
  graph.push(
    `[${currentLabel}]split=3[${base}][${pixels}][${paletteInput}]`,
  );
  graph.push(
    `[${paletteInput}]palettegen=max_colors=${colors}:reserve_transparent=0:stats_mode=full[${palette}]`,
  );
  graph.push(`[${pixels}][${palette}]${paletteUse}[${dithered}]`);
  graph.push(
    `[${base}][${dithered}]blend=all_mode=normal:all_opacity=${decimal(amount)}[${outputLabel}]`,
  );
  addRequired(required, ["split", "palettegen", "paletteuse", "blend"]);
  return outputLabel;
}

function compileEffect(
  graph: string[],
  required: Set<string>,
  currentLabel: string,
  effect: VideoEffect,
  index: number,
): string {
  if (effect.amount === 0) return currentLabel;
  const outputLabel = effectOutputLabel(index);
  if (effect.kind === "color-grade") {
    const treatment = colorGradeTreatment(effect);
    return appendMixedTreatment(
      graph,
      required,
      currentLabel,
      outputLabel,
      treatment.filter,
      treatment.names,
      effect.amount,
    );
  }
  if (effect.kind === "duotone") {
    return appendMixedTreatment(
      graph,
      required,
      currentLabel,
      outputLabel,
      duotoneTreatment(effect),
      ["hue", "curves"],
      effect.amount,
    );
  }
  if (effect.kind === "diffusion") {
    return appendDiffusion(graph, required, currentLabel, outputLabel, effect);
  }
  if (effect.kind === "film-grain") {
    graph.push(`[${currentLabel}]${grainTreatment(effect)}[${outputLabel}]`);
    addRequired(required, ["format", "noise"]);
    return outputLabel;
  }
  if (effect.kind === "vignette") {
    const angle = effect.amount * Math.PI * 0.35;
    graph.push(
      `[${currentLabel}]vignette=angle=${decimal(angle)}:x0=w*${decimal(effect.center.xUnit)}:y0=h*${decimal(effect.center.yUnit)}:dither=0[${outputLabel}]`,
    );
    required.add("vignette");
    return outputLabel;
  }
  if (effect.kind === "scanlines") {
    graph.push(
      `[${currentLabel}]drawgrid=w=iw:h=${effect.spacingPx}:t=${effect.thicknessPx}:c=black@${decimal(effect.amount)}[${outputLabel}]`,
    );
    required.add("drawgrid");
    return outputLabel;
  }
  if (effect.kind === "ordered-dither") {
    return appendPaletteDither(
      graph,
      required,
      currentLabel,
      outputLabel,
      effect.colors,
      effect.amount,
      `paletteuse=dither=bayer:bayer_scale=${effect.bayerScale}`,
    );
  }
  if (effect.kind === "error-diffusion-dither") {
    const algorithm = effect.algorithm === "floyd-steinberg"
      ? "floyd_steinberg"
      : "atkinson";
    return appendPaletteDither(
      graph,
      required,
      currentLabel,
      outputLabel,
      effect.colors,
      effect.amount,
      `paletteuse=dither=${algorithm}`,
    );
  }
  effect satisfies never;
  throw new Error("Unreachable video effect.");
}

/**
 * Compile a validated display-referred look into a numeric-only filter graph.
 * Input labels, filter names, and expressions are all owned by Atet.
 */
export function compileVideoLookToFfmpeg(
  lookInput: unknown,
  options: VideoLookFfmpegCompileOptions = {},
): CompiledVideoLook {
  const look = VideoLookV1Schema.parse(lookInput);
  const videoStreamIndex = options.videoStreamIndex ?? 0;
  if (
    !Number.isSafeInteger(videoStreamIndex)
    || videoStreamIndex < 0
    || videoStreamIndex > MAXIMUM_VIDEO_STREAM_INDEX
  ) {
    throw new RangeError(
      `videoStreamIndex must be a safe integer from 0 through ${MAXIMUM_VIDEO_STREAM_INDEX}.`,
    );
  }

  const inputLabel = `0:v:${videoStreamIndex}`;
  const graph: string[] = [];
  const required = new Set<string>();
  let currentLabel = inputLabel;
  for (const [index, effect] of look.effects.entries()) {
    currentLabel = compileEffect(graph, required, currentLabel, effect, index);
  }
  return {
    compiler: "atet.ffmpeg-video-look",
    compilerVersion: COMPILER_VERSION,
    filterGraph: graph.join(";"),
    inputLabel,
    look,
    lookHash: canonicalJsonSha256(look),
    outputLabel: currentLabel,
    requiredFilters: [...required],
  };
}
