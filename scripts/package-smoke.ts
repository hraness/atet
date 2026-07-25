import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises"
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
const work = await mkdtemp(join(tmpdir(), "graphics-package-smoke-"))
try {
  const archive = join(work, "graphics.tgz")
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
  const packageRoot = join(
    consumer,
    "node_modules",
    "@hraness",
    "graphics",
  )
  const packedManifest = await Bun.file(join(packageRoot, "package.json")).json()
  if (
    packedManifest.types !== "./dist/index.d.ts" ||
    packedManifest.exports?.["."]?.types !== "./dist/index.d.ts"
  ) {
    throw new Error("Packed package does not expose declarations from dist.")
  }
  const declarations = new Bun.Glob("dist/**/*.d.ts")
  let declarationCount = 0
  for await (const declarationPath of declarations.scan({
    cwd: packageRoot,
    onlyFiles: true,
  })) {
    declarationCount += 1
    const declaration = await Bun.file(
      join(packageRoot, declarationPath),
    ).text()
    if (/["']\.\.?\/[^"'\r\n]+\.ts["']/u.test(declaration)) {
      throw new Error(
        `Packed declaration exposes a relative .ts specifier: ${declarationPath}`,
      )
    }
  }
  if (declarationCount === 0) throw new Error("Packed package omitted declarations.")
  if (await Bun.file(join(packageRoot, "src", "index.ts")).exists()) {
    throw new Error("Packed package should not ship its TypeScript source tree.")
  }
  if (
    !(await Bun.file(
      join(packageRoot, "dist", "vectorize-worker.js"),
    ).exists())
  ) {
    throw new Error("Packed package omitted the isolated vectorization worker.")
  }
  const binary = join(consumer, "node_modules", ".bin", "graphics")
  await run([binary, "--help"], consumer)
  await run([binary, "init", "smoke.diagram.json"], consumer)
  const packedConfig = join(
    packageRoot,
    "examples",
    "graphics.config.ts",
  )
  await run(
    [binary, "check", "smoke.diagram.json", "--config", packedConfig],
    consumer,
  )
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
      'const api = await import("@hraness/graphics"); if (typeof api.renderSvg !== "function" || typeof api.vectorizeImage !== "function" || typeof api.parseDiagramSource !== "function" || typeof api.resolveDiagramSource !== "function" || typeof api.runMcpServer !== "function") process.exit(1)',
    ],
    consumer,
  )
  const skill = join(consumer, "node_modules", "@hraness", "graphics", "skills", "graphics", "SKILL.md")
  if (!(await Bun.file(skill).exists())) throw new Error("Packed package omitted skills/graphics")
  const installedSkill = join(consumer, ".agents", "skills", "graphics", "SKILL.md")
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
      'import { parseDiagramSource, parseDiagramSpec, resolveDiagramSource, runMcpServer, vectorizeImage, type DiagramConfig, type VectorizeReceipt } from "@hraness/graphics"',
      "const config = {} satisfies DiagramConfig",
      "const receipt = {} as VectorizeReceipt",
      "void config",
      "void receipt",
      "void runMcpServer",
      "void vectorizeImage",
      "void resolveDiagramSource(parseDiagramSource({ version: 1, name: \"stacked\", canvas: { width: 500, height: 200 }, layout: { type: \"stack\", direction: \"horizontal\" }, shapes: [{ id: \"one\", type: \"rect\", width: 100, height: 80 }] }))",
      "void parseDiagramSpec({ version: 1, name: \"typed\", canvas: { width: 1, height: 1 }, shapes: [] })",
      "",
    ].join("\n"),
  )
  await copyFile(packedConfig, join(consumer, "graphics.config.ts"))
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        target: "ES2024",
        types: ["bun"],
      },
      include: ["index.ts", "graphics.config.ts"],
    }),
  )
  await run([process.execPath, "x", "tsc", "--project", "tsconfig.json"], consumer)
} finally {
  await rm(work, { recursive: true, force: true })
}
