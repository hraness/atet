import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function run(command: readonly string[], cwd: string): Promise<void> {
  const subprocess = Bun.spawn([...command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`)
  }
}

const repository = process.cwd()
const work = await mkdtemp(join(tmpdir(), "diagram-package-smoke-"))
try {
  const archive = join(work, "diagram.tgz")
  const consumer = join(work, "consumer")
  await mkdir(consumer)
  await run(
    [
      process.execPath,
      "pm",
      "pack",
      "--filename",
      archive,
      "--ignore-scripts",
      "--quiet",
    ],
    repository,
  )
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  await run([process.execPath, "add", archive, "--ignore-scripts"], consumer)
  const binary = join(consumer, "node_modules", ".bin", "diagram")
  await run([binary, "--help"], consumer)
  await run([binary, "init", "smoke.diagram.json"], consumer)
  await run([binary, "render", "smoke.diagram.json"], consumer)
  await run(
    [binary, "skill", "install", "--target", "agents", "--scope", "project"],
    consumer,
  )
  await run(
    [
      "node",
      "--input-type=module",
      "-e",
      'const api = await import("@cclrte/diagram"); if (typeof api.renderSvg !== "function") process.exit(1)',
    ],
    consumer,
  )
  const skill = join(consumer, "node_modules", "@cclrte", "diagram", "skills", "diagram", "SKILL.md")
  if (!(await Bun.file(skill).exists())) throw new Error("Packed package omitted skills/diagram")
  const installedSkill = join(consumer, ".agents", "skills", "diagram", "SKILL.md")
  if (!(await Bun.file(installedSkill).exists())) {
    throw new Error("Packaged CLI could not install its bundled skill")
  }
  await run(
    [process.execPath, "add", "--dev", "@types/bun@1.3.14", "typescript@6.0.3"],
    consumer,
  )
  await writeFile(
    join(consumer, "index.ts"),
    [
      'import { parseDiagramSpec, type DiagramConfig } from "@cclrte/diagram"',
      "const config = {} satisfies DiagramConfig",
      "void config",
      "void parseDiagramSpec({ version: 1, name: \"typed\", canvas: { width: 1, height: 1 }, shapes: [] })",
      "",
    ].join("\n"),
  )
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2024",
        types: ["bun"],
      },
      include: ["index.ts"],
    }),
  )
  await run([process.execPath, "x", "tsc", "--project", "tsconfig.json"], consumer)
} finally {
  await rm(work, { recursive: true, force: true })
}
