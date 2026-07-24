import type { ColorMode, DiagramConfig, PartialTheme, ThemeColors, Tone } from "./types.ts"

const tones: readonly Tone[] = [
  "neutral",
  "blue",
  "orange",
  "green",
  "red",
  "purple",
  "yellow",
]

const defaults: Readonly<Record<ColorMode, ThemeColors>> = {
  light: {
    background: "#ffffff",
    foreground: "#18181b",
    muted: "#71717a",
    stroke: "#27272a",
    tones: {
      neutral: { fill: "#f4f4f5", stroke: "#52525b", text: "#18181b" },
      blue: { fill: "#dbeafe", stroke: "#2563eb", text: "#1e3a8a" },
      orange: { fill: "#ffedd5", stroke: "#ea580c", text: "#7c2d12" },
      green: { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d" },
      red: { fill: "#fee2e2", stroke: "#dc2626", text: "#7f1d1d" },
      purple: { fill: "#f3e8ff", stroke: "#9333ea", text: "#581c87" },
      yellow: { fill: "#fef9c3", stroke: "#ca8a04", text: "#713f12" },
    },
  },
  dark: {
    background: "#09090b",
    foreground: "#fafafa",
    muted: "#a1a1aa",
    stroke: "#d4d4d8",
    tones: {
      neutral: { fill: "#27272a", stroke: "#a1a1aa", text: "#fafafa" },
      blue: { fill: "#172554", stroke: "#60a5fa", text: "#dbeafe" },
      orange: { fill: "#431407", stroke: "#fb923c", text: "#ffedd5" },
      green: { fill: "#052e16", stroke: "#4ade80", text: "#dcfce7" },
      red: { fill: "#450a0a", stroke: "#f87171", text: "#fee2e2" },
      purple: { fill: "#3b0764", stroke: "#c084fc", text: "#f3e8ff" },
      yellow: { fill: "#422006", stroke: "#facc15", text: "#fef9c3" },
    },
  },
}

function mergeTheme(base: ThemeColors, override: PartialTheme | undefined): ThemeColors {
  if (override === undefined) return base
  return {
    background: override.background ?? base.background,
    foreground: override.foreground ?? base.foreground,
    muted: override.muted ?? base.muted,
    stroke: override.stroke ?? base.stroke,
    tones: Object.fromEntries(
      tones.map((tone) => [
        tone,
        {
          fill: override.tones?.[tone]?.fill ?? base.tones[tone].fill,
          stroke: override.tones?.[tone]?.stroke ?? base.tones[tone].stroke,
          text: override.tones?.[tone]?.text ?? base.tones[tone].text,
        },
      ]),
    ) as ThemeColors["tones"],
  }
}

export function resolveTheme(mode: ColorMode, config: DiagramConfig): ThemeColors {
  return mergeTheme(defaults[mode], config.theme?.[mode])
}
