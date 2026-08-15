import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main as runAtetCliInProcess } from "./cli.ts"
import { atetImageModels } from "./generate.ts"
import type {
  HostResourceClaim,
  HostResourceCoordinator,
} from "./host-resources.ts"

function recordingCoordinator(record: {
  assertions: number
  claims: HostResourceClaim[][]
}, inheritedFileDescriptor = 83): HostResourceCoordinator {
  const profile = {
    id: "atet.cli-test-host/v1",
    capacities: [],
  } as const
  return {
    profile,
    scope: "process",
    async withLease(claims, callback) {
      record.claims.push([...claims])
      return await callback({
        claims,
        inheritedFileDescriptor,
        profile,
        ticket: String(record.claims.length),
        assertOwned: () => {
          record.assertions += 1
          return Promise.resolve()
        },
      })
    },
  }
}

async function runCli(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], {
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

describe("Atet CLI", () => {
  test("reports v2.0.0 and documents namespaced media surfaces", async () => {
    const version = await runCli(["--version"], process.cwd())
    expect(version).toEqual({
      exitCode: 0,
      stdout: "2.0.0\n",
      stderr: "",
    })
    const help = await runCli(["--help"], process.cwd())
    expect(help.exitCode).toBe(0)
    for (const command of [
      "atet diagram init",
      "atet diagram check",
      "atet diagram render",
      "atet image vectorize",
      "atet image generate",
      "atet canvas open",
      "atet code search",
      "atet code execute",
      "search_atet/execute_atet",
    ]) {
      expect(help.stdout).toContain(command)
    }
    expect(help.stdout).not.toContain("atet auth")
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
      "atet.diagram.check",
      "atet.diagram.render",
    ])

    const predecessor = await runCli(
      ["code", "search", "transmute.diagram.check"],
      process.cwd(),
    )
    expect(predecessor.exitCode).toBe(0)
    expect(predecessor.stderr).toBe("")
    expect(JSON.parse(predecessor.stdout).operations).toEqual([
      expect.objectContaining({ code: "atet.diagram.check" }),
    ])
  })

  test("defaults direct generation to the Recraft utility model", async () => {
    const output: string[] = []
    const admission = { assertions: 0, claims: [] as HostResourceClaim[][] }
    await runAtetCliInProcess(
      [
        "image",
        "generate",
        "one literal illustration",
        "--output",
        "illustration.webp",
        "--json",
      ],
      {
        generate: async (input) => {
          expect(input).toEqual({
            model: atetImageModels[1],
            prompt: "one literal illustration",
            outputPath: "illustration.webp",
          })
          return {
            bytes: 128,
            mediaType: "image/webp",
            model: atetImageModels[1],
            outputPath: "/workspace/illustration.webp",
            provider: "vercel-ai-gateway",
            requestId: "request_default_model",
            sha256: "a".repeat(64),
            warnings: [],
          }
        },
        hostResourceCoordinator: recordingCoordinator(admission),
        log: (line) => output.push(line),
      },
    )
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      model: atetImageModels[1],
      mediaType: "image/webp",
    })
    expect(admission.claims).toEqual([[
      { resource: "local-io", amount: 1 },
      { resource: "network", amount: 1 },
      { resource: "paid-call", amount: 1 },
    ]])
  })

  test("keeps canonical vectorization local and rejects the old flat grammar", async () => {
    const output: string[] = []
    let calls = 0
    const admission = { assertions: 0, claims: [] as HostResourceClaim[][] }
    await runAtetCliInProcess(
      ["image", "vectorize", "source.png", "--output", "source.svg", "--json"],
      {
        hostResourceCoordinator: recordingCoordinator(admission, 89),
        log: (line) => output.push(line),
        vectorize: async (input, options) => {
          calls += 1
          expect(input).toBe("source.png")
          expect(options?.outputPath).toBe("source.svg")
          expect(options?.inheritedFileDescriptors).toEqual([89])
          return {
            outputPath: "/workspace/source.svg",
            svg: "<svg/>",
            receipt: {
              alphaCutoff: 8,
              bytes: 6,
              candidatesEvaluated: 1,
              format: "png",
              height: 16,
              inputBytes: 32,
              outputMode: "color",
              pathCount: 1,
              profile: "balanced",
              provenance: {
                arch: process.arch,
                platform: process.platform,
                sharp: "test",
                sharpVersions: {},
                vips: "test",
                vtracerSha256: "0".repeat(64),
                vtracerSource: "override",
                vtracerVersion: "test",
              },
              quality: {
                alphaRmse: 0,
                colorRmse: 0,
                outsideAlphaRatio: 0,
                sampleHeight: 16,
                sampleWidth: 16,
                supportRecall: 1,
              },
              receiptVersion: 1,
              representation: "color-paths",
              sourceSha256: "1".repeat(64),
              svgSha256: "2".repeat(64),
              width: 16,
            },
          }
        },
      },
    )
    expect(calls).toBe(1)
    expect(admission.claims).toEqual([[
      { resource: "cpu", amount: 1 },
      { resource: "local-io", amount: 1 },
    ]])
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      outputPath: "/workspace/source.svg",
      width: 16,
    })
    await expect(
      runAtetCliInProcess(["vectorize", "source.png", "--output", "source.svg"]),
    ).rejects.toThrow("flat `vectorize` command moved")
  })

  test("executes exact typed JSON without loading workspace code", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-cli-code-"))
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
        join(root, "atet.config.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {}\n`,
      )
      const result = await runCli(
        [
          "code",
          "execute",
          "atet.diagram.check",
          "--input",
          JSON.stringify({ path: "flow.diagram.json" }),
        ],
        root,
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        operation: "atet.diagram.check",
        result: { configPath: null },
      })
      expect(await Bun.file(marker).exists()).toBe(false)

      const predecessor = await runCli(
        [
          "code",
          "execute",
          "transmute.diagram.check",
          "--input",
          JSON.stringify({ path: "flow.diagram.json" }),
        ],
        root,
      )
      expect(predecessor.exitCode).toBe(0)
      expect(predecessor.stderr).toBe("")
      expect(JSON.parse(predecessor.stdout)).toMatchObject({
        operation: "atet.diagram.check",
        result: { configPath: null },
      })

      const rejected = await runCli(
        [
          "code",
          "execute",
          "atet.diagram.check",
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

  test("admits in-process code execution through the operation registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-cli-admission-"))
    try {
      const path = join(root, "flow.diagram.json")
      await writeFile(path, JSON.stringify({
        version: 1,
        name: "flow",
        canvas: { width: 400, height: 200 },
        shapes: [],
      }))
      const output: string[] = []
      const admission = { assertions: 0, claims: [] as HostResourceClaim[][] }
      await runAtetCliInProcess([
        "code",
        "execute",
        "atet.diagram.check",
        "--input",
        JSON.stringify({ path }),
      ], {
        hostResourceCoordinator: recordingCoordinator(admission),
        log: line => output.push(line),
      })
      expect(JSON.parse(output.join("\n"))).toMatchObject({
        operation: "atet.diagram.check",
        result: { configPath: null },
      })
      expect(admission.claims).toEqual([[
        { resource: "cpu", amount: 1 },
        { resource: "local-io", amount: 1 },
      ]])
      expect(admission.assertions).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
