#!/usr/bin/env bun

import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import {
  artifactSummary,
  checkDiagramFile,
  desktopStatus,
  getLatestDesktopRelease,
  installDesktop,
  openInDesktop,
  renderDiagramFile,
  selectDesktopAsset,
} from "./index.ts"
import { installSkill, type SkillScope, type SkillTarget } from "./skill-install.ts"
import { pathExists } from "./fs.ts"

const version = "0.1.0"

const help = `diagram ${version}

Create concise diagrams from a checked JSON source.

Usage:
  diagram init [file]
  diagram check <file> [--config <file>] [--strict]
  diagram render <file> [--out-dir <directory>] [--config <file>] [--scale <number>]
  diagram open <file.tldr|file.tldraw>
  diagram doctor
  diagram desktop status
  diagram desktop url
  diagram desktop install [--yes] [--download-only]
  diagram skill path
  diagram skill install [--target codex|claude|agents] [--scope user|project] [--force]

Render writes the same five replaceable artifacts on every run:
  <name>.tldr
  <name>.light.svg
  <name>.dark.svg
  <name>.light.png
  <name>.dark.png

The .tldr file is editable tldraw interchange. It imports into tldraw Offline,
which can save the newer app-owned .tldraw bundle. Rendering does not require
tldraw Offline or the tldraw SDK.
`

interface ParsedArguments {
  readonly positionals: readonly string[]
  readonly options: Readonly<Record<string, string>>
  readonly flags: ReadonlySet<string>
}

function parseArguments(args: readonly string[], valueOptions: ReadonlySet<string>): ParsedArguments {
  const positionals: string[] = []
  const options: Record<string, string> = {}
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (!argument.startsWith("--")) {
      positionals.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (!valueOptions.has(name)) {
      flags.add(name)
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`)
    }
    options[name] = value
    index += 1
  }
  return { positionals, options, flags }
}

function requiredPositional(parsed: ParsedArguments, index: number, label: string): string {
  const value = parsed.positionals[index]
  if (value === undefined) throw new Error(`Missing ${label}`)
  return value
}

function printFindings(findings: Awaited<ReturnType<typeof checkDiagramFile>>["findings"]): void {
  if (findings.length === 0) {
    console.log("No diagram lint findings.")
    return
  }
  console.warn(`${findings.length} diagram lint finding${findings.length === 1 ? "" : "s"}:`)
  for (const finding of findings) {
    console.warn(`  [${finding.code}] ${finding.message}`)
  }
}

const starter = {
  $schema: "https://raw.githubusercontent.com/hraness/diagram/main/schema/diagram.schema.json",
  version: 1,
  name: "example-flow",
  canvas: { width: 960, height: 540, padding: 64 },
  shapes: [
    {
      id: "source",
      type: "rect",
      x: 100,
      y: 170,
      width: 240,
      height: 160,
      label: "Source",
      icon: "document",
      tone: "blue",
    },
    {
      id: "result",
      type: "rect",
      x: 620,
      y: 170,
      width: 240,
      height: 160,
      label: "Result",
      icon: "check",
      tone: "green",
    },
  ],
  edges: [{ id: "source-result", from: "source", to: "result" }],
}

async function confirmInstall(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("Pass --yes to download the 100–230 MB official tldraw Offline installer")
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      "Download, verify, and launch the official tldraw Offline installer? [y/N] ",
    )
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes"
  } finally {
    prompt.close()
  }
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(help)
    return
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(version)
    return
  }

  if (command === "init") {
    const parsed = parseArguments(rest, new Set())
    const filePath = resolve(parsed.positionals[0] ?? "diagram.diagram.json")
    if (await pathExists(filePath)) throw new Error(`Refusing to overwrite existing file: ${filePath}`)
    await writeFile(filePath, `${JSON.stringify(starter, null, 2)}\n`)
    console.log(`Created ${filePath}`)
    return
  }

  if (command === "check") {
    const parsed = parseArguments(rest, new Set(["config"]))
    const result = await checkDiagramFile({
      filePath: requiredPositional(parsed, 0, "diagram file"),
      ...(parsed.options.config === undefined ? {} : { configPath: parsed.options.config }),
    })
    console.log(`Valid diagram${result.configPath === null ? "" : ` with ${result.configPath}`}.`)
    printFindings(result.findings)
    if (parsed.flags.has("strict") && result.findings.length > 0) process.exitCode = 2
    return
  }

  if (command === "render") {
    const parsed = parseArguments(rest, new Set(["out-dir", "config", "scale"]))
    const scale =
      parsed.options.scale === undefined ? undefined : Number.parseFloat(parsed.options.scale)
    const result = await renderDiagramFile({
      filePath: requiredPositional(parsed, 0, "diagram file"),
      ...(parsed.options["out-dir"] === undefined
        ? {}
        : { outDirectory: parsed.options["out-dir"] }),
      ...(parsed.options.config === undefined ? {} : { configPath: parsed.options.config }),
      ...(scale === undefined ? {} : { scale }),
    })
    console.log(artifactSummary(result.artifacts))
    printFindings(result.findings)
    return
  }

  if (command === "open") {
    const parsed = parseArguments(rest, new Set())
    await openInDesktop(requiredPositional(parsed, 0, "tldraw file"))
    console.log("Opened in tldraw Offline.")
    return
  }

  if (command === "doctor") {
    const status = await desktopStatus()
    console.log(`diagram ${version}`)
    console.log(`Bun ${process.versions.bun ?? "not detected"}`)
    console.log("Headless SVG/PNG renderer ready")
    console.log(
      status.installedPath === null
        ? "tldraw Offline not installed (optional)"
        : `tldraw Offline: ${status.installedPath}`,
    )
    console.log(
      status.server === null
        ? "tldraw Offline agent server not running (optional)"
        : `tldraw Offline agent server: localhost:${status.server.port}`,
    )
    return
  }

  if (command === "desktop") {
    const [subcommand, ...subcommandArgs] = rest
    if (subcommand === "status") {
      const status = await desktopStatus()
      console.log(JSON.stringify(status, null, 2))
      return
    }
    if (subcommand === "url") {
      const release = await getLatestDesktopRelease()
      const asset = selectDesktopAsset(release)
      console.log(
        JSON.stringify(
          {
            release: release.tag_name,
            releaseUrl: release.html_url,
            asset: asset.name,
            url: asset.browser_download_url,
            bytes: asset.size,
            sha256: asset.digest,
          },
          null,
          2,
        ),
      )
      return
    }
    if (subcommand === "install") {
      const parsed = parseArguments(subcommandArgs, new Set())
      if (!parsed.flags.has("yes") && !(await confirmInstall())) {
        console.log("Cancelled.")
        return
      }
      const result = await installDesktop({ downloadOnly: parsed.flags.has("download-only") })
      console.log(
        `${parsed.flags.has("download-only") ? "Downloaded" : "Prepared"} tldraw Offline ${result.release}: ${result.filePath}`,
      )
      return
    }
    throw new Error("Use diagram desktop status, url, or install")
  }

  if (command === "skill") {
    const [subcommand, ...subcommandArgs] = rest
    if (subcommand === "path") {
      const { bundledSkillPath } = await import("./skill-install.ts")
      console.log(bundledSkillPath())
      return
    }
    if (subcommand === "install") {
      const parsed = parseArguments(subcommandArgs, new Set(["target", "scope", "project"]))
      const target = (parsed.options.target ?? "codex") as SkillTarget
      const scope = (parsed.options.scope ?? "user") as SkillScope
      if (!["codex", "claude", "agents"].includes(target)) {
        throw new Error("--target must be codex, claude, or agents")
      }
      if (!["user", "project"].includes(scope)) {
        throw new Error("--scope must be user or project")
      }
      const destination = await installSkill({
        target,
        scope,
        ...(parsed.options.project === undefined
          ? {}
          : { projectDirectory: parsed.options.project }),
        force: parsed.flags.has("force"),
      })
      console.log(`Installed diagram skill at ${destination}`)
      return
    }
    throw new Error("Use diagram skill path or install")
  }

  throw new Error(`Unknown command: ${command}\n\n${help}`)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
