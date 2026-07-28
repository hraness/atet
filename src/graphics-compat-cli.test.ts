import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installLegacyVectorizerEnvironment,
  main as runGraphicsCliInProcess,
} from "./graphics-compat-cli.ts"
import { graphicsImageModels } from "./graphics-compat/discovery.ts"

async function runCli(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, "graphics-compat-cli.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("Graphics CLI semantic code mode", () => {
  test("maps v0.4 vectorizer environment names for one invocation", () => {
    const readEnvironment = (name: string): string | undefined => process.env[name]
    const previousGraphics = process.env.GRAPHICS_VTRACER_PATH
    const previousTransmute = process.env.TRANSMUTE_VTRACER_PATH
    try {
      process.env.GRAPHICS_VTRACER_PATH = "/legacy/vtracer"
      delete process.env.TRANSMUTE_VTRACER_PATH
      const restore = installLegacyVectorizerEnvironment()
      expect(readEnvironment("TRANSMUTE_VTRACER_PATH")).toBe("/legacy/vtracer")
      restore()
      expect(readEnvironment("TRANSMUTE_VTRACER_PATH")).toBeUndefined()
    } finally {
      if (previousGraphics === undefined) delete process.env.GRAPHICS_VTRACER_PATH
      else process.env.GRAPHICS_VTRACER_PATH = previousGraphics
      if (previousTransmute === undefined) delete process.env.TRANSMUTE_VTRACER_PATH
      else process.env.TRANSMUTE_VTRACER_PATH = previousTransmute
    }
  })

  test("reports v0.4.0 and documents authenticated/semantic commands", async () => {
    const version = await runCli(["--version"], process.cwd())
    expect(version).toEqual({
      exitCode: 0,
      stdout: "0.4.0\n",
      stderr: "",
    })
    const help = await runCli(["--help"], process.cwd())
    expect(help.exitCode).toBe(0)
    for (const command of [
      "graphics login",
      "graphics logout",
      "graphics auth status",
      "graphics generate",
      "graphics code search",
      "graphics code execute",
      "search_graphics/execute_graphics",
    ]) {
      expect(help.stdout).toContain(command)
    }
  })

  test("searches the canonical registry as bounded JSON", async () => {
    const result = await runCli(
      ["code", "search", "diagram", "--limit", "2"],
      process.cwd(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const parsed = JSON.parse(result.stdout)
    expect(parsed.operations.map(({ code }: { code: string }) => code)).toEqual([
      "graphics.diagram.check",
      "graphics.diagram.render",
    ])
  })

  test("defaults direct generation to the Recraft utility model", async () => {
    const output: string[] = []
    await runGraphicsCliInProcess(
      [
        "generate",
        "one literal illustration",
        "--output",
        "illustration.webp",
        "--json",
      ],
      {
        generate: async (input) => {
          expect(input).toEqual({
            model: graphicsImageModels[1],
            prompt: "one literal illustration",
            outputPath: "illustration.webp",
          })
          return {
            bytes: 128,
            idempotencyKey: "generated-key-0001",
            mediaType: "image/webp",
            model: graphicsImageModels[1],
            outputPath: "/workspace/illustration.webp",
            requestId: "request_default_model",
          }
        },
        log: (line) => output.push(line),
      },
    )
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      model: graphicsImageModels[1],
      mediaType: "image/webp",
    })
  })

  test("executes exact typed JSON without loading workspace code", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-cli-code-"))
    const marker = join(root, "config-executed")
    try {
      await writeFile(
        join(root, "flow.diagram.json"),
        JSON.stringify({
          version: 1,
          name: "flow",
          canvas: { width: 400, height: 200 },
          shapes: [
            {
              id: "one",
              type: "rect",
              x: 40,
              y: 40,
              width: 120,
              height: 80,
            },
          ],
        }),
      )
      await writeFile(
        join(root, "graphics.config.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {}\n`,
      )
      const result = await runCli(
        [
          "code",
          "execute",
          "graphics.diagram.check",
          "--input",
          JSON.stringify({ path: "flow.diagram.json" }),
        ],
        root,
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        operation: "graphics.diagram.check",
        result: { configPath: null },
      })
      expect(await Bun.file(marker).exists()).toBe(false)

      const rejected = await runCli(
        [
          "code",
          "execute",
          "graphics.diagram.check",
          "--input",
          JSON.stringify({
            path: "flow.diagram.json",
            source: `await Bun.write(${JSON.stringify(marker)}, "executed")`,
          }),
        ],
        root,
      )
      expect(rejected.exitCode).toBe(1)
      expect(rejected.stderr).toContain("[INVALID_OPERATION_INPUT]")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
