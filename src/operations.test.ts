import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { transmuteImageModels } from "./discovery.ts"
import {
  executeTransmuteOperation,
  transmuteOperationCodes,
  transmuteOperationRegistry,
  parseTransmuteOperationInput,
  searchTransmuteOperations,
} from "./operations.ts"

describe("canonical Transmute operations", () => {
  test("publishes four exact semantic codes in stable order", () => {
    expect(transmuteOperationRegistry.map(({ code }) => code)).toEqual(
      [...transmuteOperationCodes],
    )
    expect(
      transmuteOperationRegistry.find(
        ({ code }) => code === "transmute.image.generate",
      ),
    ).toMatchObject({
      execution: "hosted",
      authentication: "required",
      destructive: true,
      idempotent: false,
      transport: {
        method: "POST",
        endpointFromDiscovery: "endpoints.generateImage",
        authorization: "bearer",
        idempotencyHeader: "Idempotency-Key",
        retry: "never",
      },
    })
    expect(
      transmuteOperationRegistry.find(
        ({ code }) => code === "transmute.image.vectorize",
      ),
    ).toMatchObject({
      execution: "local",
      authentication: "none",
    })
  })

  test("searches bounded semantic metadata without fuzzy execution", () => {
    expect(searchTransmuteOperations("diagram").map(({ code }) => code)).toEqual([
      "transmute.diagram.check",
      "transmute.diagram.render",
    ])
    expect(searchTransmuteOperations("hosted image", 1).map(({ code }) => code))
      .toEqual(["transmute.image.generate"])
    expect(() => searchTransmuteOperations("\0")).toThrow("[INVALID_SEARCH]")
  })

  test("rejects unknown fields and source text instead of evaluating it", () => {
    expect(() =>
      parseTransmuteOperationInput("transmute.diagram.check", {
        path: "flow.diagram.json",
        source: "await Bun.write('/tmp/executed', 'yes')",
      }),
    ).toThrow("[INVALID_OPERATION_INPUT]")
    expect(() =>
      parseTransmuteOperationInput("transmute.image.generate", {
        model: "other/provider-model",
        prompt: "anything",
      }),
    ).toThrow("[INVALID_OPERATION_INPUT]")
    expect(() =>
      parseTransmuteOperationInput("transmute.image.generate", {
        model: transmuteImageModels[0],
        prompt: "anything",
      }),
    ).toThrow("outputPath")
    expect(() =>
      parseTransmuteOperationInput("transmute.image.vectorize", {
        inputPath: "input.png",
        outputPath: "output.png",
      }),
    ).toThrow("must end in .svg")
  })

  test("executes a fixed local diagram adapter by exact code", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-operation-check-"))
    try {
      const path = join(root, "flow.diagram.json")
      const marker = join(root, "config-executed")
      await writeFile(
        path,
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
        join(root, "transmute.config.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {}\n`,
      )
      const result = await executeTransmuteOperation(
        "transmute.diagram.check",
        { path },
      )
      expect(result).toMatchObject({
        configPath: null,
        findings: expect.any(Array),
      })
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not contact discovery or auth before local vectorization", async () => {
    const networkInputs: string[] = []
    await expect(
      executeTransmuteOperation(
        "transmute.image.vectorize",
        {
          inputPath: "/private/caller-owned.png",
          outputPath: "/private/caller-owned.svg",
        },
        {
          fetch: async (input) => {
            networkInputs.push(String(input))
            return new Response(null, { status: 500 })
          },
          secrets: {
            get: async () => null,
            set: async () => undefined,
            delete: async () => false,
          },
        },
      ),
    ).rejects.toThrow()
    expect(networkInputs).toEqual([])
  })
})
