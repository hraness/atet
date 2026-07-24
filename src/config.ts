import { readFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { pathExists } from "./fs.ts"
import { builtInIcons, sanitizeIcon } from "./icons.ts"
import type {
  DiagramConfig,
  FontConfig,
  IconDefinition,
  LoadedConfig,
  PartialTheme,
} from "./types.ts"

const configNames = [
  { current: "graphics.config.ts", legacy: "diagram.config.ts" },
  { current: "graphics.config.mjs", legacy: "diagram.config.mjs" },
  { current: "graphics.config.js", legacy: "diagram.config.js" },
  { current: "graphics.config.json", legacy: "diagram.config.json" },
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseFont(value: unknown, at: string): FontConfig {
  if (!isRecord(value) || typeof value.family !== "string" || value.family.trim() === "") {
    throw new Error(`${at} must have a non-empty family`)
  }
  if (value.files !== undefined && !Array.isArray(value.files)) {
    throw new Error(`${at}.files must be an array`)
  }
  const files = (value.files ?? []).map((file, index) => {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.trim() === "") {
      throw new Error(`${at}.files[${index}].path must be a non-empty string`)
    }
    if (file.weight !== undefined && (typeof file.weight !== "number" || !Number.isFinite(file.weight))) {
      throw new Error(`${at}.files[${index}].weight must be a finite number`)
    }
    if (file.style !== undefined && file.style !== "normal" && file.style !== "italic") {
      throw new Error(`${at}.files[${index}].style must be normal or italic`)
    }
    if (file.embed !== undefined && typeof file.embed !== "boolean") {
      throw new Error(`${at}.files[${index}].embed must be a boolean`)
    }
    const style = file.style as "normal" | "italic" | undefined
    return {
      path: file.path,
      ...(file.weight === undefined ? {} : { weight: file.weight }),
      ...(style === undefined ? {} : { style }),
      ...(file.embed === undefined ? {} : { embed: file.embed }),
    }
  })
  return { family: value.family, ...(files.length === 0 ? {} : { files }) }
}

function parseIcons(value: unknown, at: string): Readonly<Record<string, IconDefinition>> {
  if (!isRecord(value)) throw new Error(`${at} must be an object`)
  return Object.fromEntries(
    Object.entries(value).map(([name, icon]) => {
      if (!isRecord(icon) || typeof icon.viewBox !== "string" || typeof icon.body !== "string") {
        throw new Error(`${at}.${name} must have string viewBox and body fields`)
      }
      return [name, sanitizeIcon({ viewBox: icon.viewBox, body: icon.body })]
    }),
  )
}

function parseTheme(value: unknown, at: string): PartialTheme {
  if (!isRecord(value)) throw new Error(`${at} must be an object`)
  const scalarKeys = ["background", "foreground", "muted", "stroke"] as const
  for (const key of scalarKeys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${at}.${key} must be a CSS color string`)
    }
  }
  if (value.tones !== undefined && !isRecord(value.tones)) {
    throw new Error(`${at}.tones must be an object`)
  }
  return value as PartialTheme
}

function parseConfig(value: unknown): DiagramConfig {
  if (!isRecord(value)) throw new Error("Graphics config must export an object")
  const font = value.font === undefined ? undefined : parseFont(value.font, "font")
  const icons = value.icons === undefined ? undefined : parseIcons(value.icons, "icons")
  let theme: DiagramConfig["theme"]
  if (value.theme !== undefined) {
    if (!isRecord(value.theme)) throw new Error("theme must be an object")
    theme = {
      ...(value.theme.light === undefined ? {} : { light: parseTheme(value.theme.light, "theme.light") }),
      ...(value.theme.dark === undefined ? {} : { dark: parseTheme(value.theme.dark, "theme.dark") }),
    }
  }
  return {
    ...(font === undefined ? {} : { font }),
    ...(icons === undefined ? {} : { icons: { ...builtInIcons, ...icons } }),
    ...(theme === undefined ? {} : { theme }),
  }
}

async function discoverConfig(directory: string): Promise<string | null> {
  for (const names of configNames) {
    const candidate = resolve(directory, names.current)
    if (await pathExists(candidate)) return candidate
  }
  for (const names of configNames) {
    const candidate = resolve(directory, names.legacy)
    if (await pathExists(candidate)) {
      const replacement = resolve(directory, names.current)
      throw new Error(
        `Legacy Graphics config found at ${candidate}. Rename it to ${replacement}; Graphics 0.2 does not auto-load diagram.config.*.`,
      )
    }
  }
  return null
}

export async function loadDiagramConfig(options: {
  readonly explicitPath?: string
  readonly searchDirectory: string
}): Promise<LoadedConfig> {
  const filePath =
    options.explicitPath === undefined
      ? await discoverConfig(options.searchDirectory)
      : resolve(options.explicitPath)
  if (filePath === null) {
    return {
      filePath: null,
      baseDirectory: options.searchDirectory,
      value: { icons: builtInIcons },
    }
  }
  if (!(await pathExists(filePath))) throw new Error(`Config does not exist: ${filePath}`)

  const raw: unknown =
    extname(filePath) === ".json"
      ? JSON.parse(await readFile(filePath, "utf8"))
      : ((await import(`${pathToFileURL(filePath).href}?v=${Date.now()}`)) as { default?: unknown })
          .default
  const value = parseConfig(raw)
  const baseDirectory = dirname(filePath)
  const font =
    value.font === undefined
      ? undefined
      : {
          ...value.font,
          ...(value.font.files === undefined
            ? {}
            : {
                files: value.font.files.map((file) => ({
                  ...file,
                  path: isAbsolute(file.path) ? file.path : resolve(baseDirectory, file.path),
                })),
              }),
        }
  return {
    filePath,
    baseDirectory,
    value: {
      ...value,
      icons: { ...builtInIcons, ...value.icons },
      ...(font === undefined ? {} : { font }),
    },
  }
}
