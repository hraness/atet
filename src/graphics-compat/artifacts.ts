import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { loadDiagramConfig } from "./config.js"
import { lintDiagram } from "../lint.js"
import { parseDiagramSpec } from "../parse.js"
import { renderPng, renderSvg } from "../render.js"
import { serializeTldr } from "../tldr.js"
import type { LintFinding, RenderArtifacts } from "../types.js"

async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    await writeFile(temporary, data)
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function readDiagramFile(filePath: string) {
  const absolutePath = resolve(filePath)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"))
  } catch (error) {
    throw new Error(`Could not read diagram JSON at ${absolutePath}`, { cause: error })
  }
  return { absolutePath, spec: parseDiagramSpec(parsed) }
}

export async function checkDiagramFile(options: {
  readonly filePath: string
  readonly configPath?: string
}): Promise<{ readonly findings: readonly LintFinding[]; readonly configPath: string | null }> {
  const { absolutePath, spec } = await readDiagramFile(options.filePath)
  const config = await loadDiagramConfig({
    ...(options.configPath === undefined ? {} : { explicitPath: options.configPath }),
    searchDirectory: dirname(absolutePath),
  })
  for (const shape of spec.shapes) {
    if (
      (shape.type === "rect" || shape.type === "ellipse") &&
      shape.icon !== undefined &&
      config.value.icons?.[shape.icon] === undefined
    ) {
      throw new Error(`Unknown icon "${shape.icon}" on shape ${shape.id}`)
    }
  }
  return { findings: lintDiagram(spec), configPath: config.filePath }
}

export async function renderDiagramFile(options: {
  readonly filePath: string
  readonly outDirectory?: string
  readonly configPath?: string
  readonly scale?: number
}): Promise<{
  readonly artifacts: RenderArtifacts
  readonly findings: readonly LintFinding[]
  readonly configPath: string | null
}> {
  const { absolutePath, spec } = await readDiagramFile(options.filePath)
  const outDirectory = resolve(options.outDirectory ?? dirname(absolutePath))
  const config = await loadDiagramConfig({
    ...(options.configPath === undefined ? {} : { explicitPath: options.configPath }),
    searchDirectory: dirname(absolutePath),
  })
  const scale = options.scale ?? 2
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new Error("PNG scale must be greater than zero and no more than 8")
  }
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", config.value),
    renderSvg(spec, "dark", config.value),
  ])
  const [lightPng, darkPng] = [renderPng(light, config.value, scale), renderPng(dark, config.value, scale)]
  const artifacts = {
    spec: absolutePath,
    tldr: join(outDirectory, `${spec.name}.tldr`),
    lightSvg: join(outDirectory, `${spec.name}.light.svg`),
    darkSvg: join(outDirectory, `${spec.name}.dark.svg`),
    lightPng: join(outDirectory, `${spec.name}.light.png`),
    darkPng: join(outDirectory, `${spec.name}.dark.png`),
  } satisfies RenderArtifacts
  await mkdir(outDirectory, { recursive: true })
  await Promise.all([
    atomicWrite(artifacts.tldr, serializeTldr(spec, config.value)),
    atomicWrite(artifacts.lightSvg, light.svg),
    atomicWrite(artifacts.darkSvg, dark.svg),
    atomicWrite(artifacts.lightPng, lightPng),
    atomicWrite(artifacts.darkPng, darkPng),
  ])
  return { artifacts, findings: lintDiagram(spec), configPath: config.filePath }
}

export function artifactSummary(artifacts: RenderArtifacts): string {
  return [
    `Rendered ${basename(artifacts.spec)}`,
    `  ${artifacts.tldr}`,
    `  ${artifacts.lightSvg}`,
    `  ${artifacts.darkSvg}`,
    `  ${artifacts.lightPng}`,
    `  ${artifacts.darkPng}`,
  ].join("\n")
}
