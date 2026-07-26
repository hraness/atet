import { describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  graphicsImageModels,
  graphicsProductionContract,
  graphicsRedirectUri,
} from "../discovery.ts"
import {
  GraphicsMcpToolRuntime,
  mcpMaximumEdges,
  mcpMaximumReturnedFindings,
  mcpMaximumShapes,
} from "./tools.ts"
import type { McpToolResult } from "./types.ts"

function expectToolError(result: McpToolResult, code: string): void {
  expect(result).toMatchObject({
    isError: true,
    content: [
      {
        type: "text",
        text: expect.stringContaining(`[${code}]`),
      },
    ],
  })
  expect(result).not.toHaveProperty("structuredContent")
}

function source(options: { readonly width?: number; readonly height?: number } = {}) {
  return JSON.stringify({
    version: 1,
    name: "agent-flow",
    canvas: {
      width: options.width ?? 800,
      height: options.height ?? 300,
    },
    layout: { type: "stack", direction: "horizontal" },
    shapes: [
      {
        id: "source",
        type: "rect",
        width: 160,
        height: 100,
        icon: "document",
      },
      {
        id: "result",
        type: "rect",
        width: 160,
        height: 100,
        icon: "check",
      },
    ],
    edges: [{ id: "source-result", from: "source", to: "result" }],
  })
}

function remoteDiscovery(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "graphics",
    environment: "production",
    apiBaseUrl: graphicsProductionContract.apiBaseUrl,
    operationsUrl: graphicsProductionContract.operationsUrl,
    authorization: {
      type: "oauth2-authorization-code",
      issuer: graphicsProductionContract.issuer,
      authorizationEndpoint: graphicsProductionContract.authorizationEndpoint,
      tokenEndpoint: graphicsProductionContract.tokenEndpoint,
      revocationEndpoint: graphicsProductionContract.revocationEndpoint,
      clientId: graphicsProductionContract.clientId,
      redirectUri: graphicsRedirectUri,
      scopes: ["openid", "offline_access"],
      resource: graphicsProductionContract.resource,
      pkce: "S256",
    },
    endpoints: { generateImage: graphicsProductionContract.generateImage },
    imageGeneration: {
      models: graphicsImageModels,
      maximumPromptBytes: 8_192,
      maximumRawImageBytes: 3_145_728,
      imagesPerRequest: 1,
      responseMediaTypes: ["image/webp"],
      idempotency: {
        header: "Idempotency-Key",
        durable: false,
        scope: "process-local-mvp",
      },
    },
    features: {
      vectorize: {
        access: "authenticated",
        billing: "free",
        execution: "local",
      },
    },
  }
}

describe("Graphics MCP tools", () => {
  test("uses built-ins without discovering or executing workspace config", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-config-"))
    const marker = join(root, "config-executed")
    try {
      await writeFile(join(root, "agent-flow.diagram.json"), source())
      await writeFile(
        join(root, "graphics.config.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {}\n`,
      )
      const runtime = await GraphicsMcpToolRuntime.create(root)
      const result = await runtime.call("check_diagram", {
        path: "agent-flow.diagram.json",
      })
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toMatchObject({
        ok: true,
        source: "agent-flow.diagram.json",
      })
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("renders and safely replaces all five root-relative artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-render-"))
    try {
      await writeFile(join(root, "agent-flow.diagram.json"), source())
      const runtime = await GraphicsMcpToolRuntime.create(root)
      const first = await runtime.call("render_diagram", {
        path: "agent-flow.diagram.json",
        out_dir: "out",
        scale: 1,
      })
      expect(first.isError).toBeUndefined()
      expect(first.structuredContent).toMatchObject({
        ok: true,
        source: "agent-flow.diagram.json",
        artifacts: {
          tldr: "out/agent-flow.tldr",
          lightSvg: "out/agent-flow.light.svg",
          darkSvg: "out/agent-flow.dark.svg",
          lightPng: "out/agent-flow.light.png",
          darkPng: "out/agent-flow.dark.png",
        },
      })
      await writeFile(join(root, "out", "agent-flow.light.svg"), "stale")
      const second = await runtime.call("render_diagram", {
        path: "agent-flow.diagram.json",
        out_dir: "out",
        scale: 1,
      })
      expect(second.isError).toBeUndefined()
      expect(await readFile(join(root, "out", "agent-flow.light.svg"), "utf8"))
        .toStartWith("<svg")
      for (const suffix of [
        ".tldr",
        ".light.svg",
        ".dark.svg",
        ".light.png",
        ".dark.png",
      ]) {
        expect(await Bun.file(join(root, "out", `agent-flow${suffix}`)).exists())
          .toBe(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects traversal, symlink escapes, unsupported suffixes, and render limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-boundary-"))
    const outside = await mkdtemp(join(tmpdir(), "graphics-mcp-outside-"))
    try {
      await writeFile(join(root, "large.diagram.json"), source({
        width: 5_000,
        height: 5_000,
      }))
      await writeFile(join(outside, "escape.diagram.json"), source())
      await symlink(
        join(outside, "escape.diagram.json"),
        join(root, "escape.diagram.json"),
      )
      await mkdir(join(outside, "writes"))
      await symlink(join(outside, "writes"), join(root, "outside-output"))
      const runtime = await GraphicsMcpToolRuntime.create(root)

      const traversal = await runtime.call("check_diagram", {
        path: "../escape.diagram.json",
      })
      expectToolError(traversal, "INVALID_PATH")
      const sourceEscape = await runtime.call("check_diagram", {
        path: "escape.diagram.json",
      })
      expectToolError(sourceEscape, "PATH_OUTSIDE_ROOT")
      const suffix = await runtime.call("check_diagram", { path: "file.json" })
      expectToolError(suffix, "INVALID_ARGUMENTS")
      const outputEscape = await runtime.call("render_diagram", {
        path: "large.diagram.json",
        out_dir: "outside-output",
        scale: 0.1,
      })
      expectToolError(outputEscape, "PATH_OUTSIDE_ROOT")
      const pixelLimit = await runtime.call("render_diagram", {
        path: "large.diagram.json",
        scale: 1,
      })
      expectToolError(pixelLimit, "RENDER_LIMIT")
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ])
    }
  })

  test("rejects sources above one MiB before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-source-cap-"))
    try {
      await writeFile(
        join(root, "oversized.diagram.json"),
        `{"padding":"${"x".repeat(1024 * 1024)}"}`,
      )
      const runtime = await GraphicsMcpToolRuntime.create(root)
      const result = await runtime.call("check_diagram", {
        path: "oversized.diagram.json",
      })
      expectToolError(result, "SOURCE_TOO_LARGE")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects diagrams above the MCP shape and edge complexity caps", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-complexity-"))
    try {
      await writeFile(
        join(root, "too-many-shapes.diagram.json"),
        JSON.stringify({
          version: 1,
          name: "too-many-shapes",
          canvas: { width: 1_000, height: 1_000 },
          shapes: Array.from(
            { length: mcpMaximumShapes + 1 },
            (_, index) => ({
              id: `shape-${index}`,
              type: "rect",
              x: 10,
              y: 10,
              width: 120,
              height: 64,
            }),
          ),
        }),
      )
      await writeFile(
        join(root, "too-many-edges.diagram.json"),
        JSON.stringify({
          version: 1,
          name: "too-many-edges",
          canvas: { width: 800, height: 300 },
          shapes: [
            {
              id: "one",
              type: "rect",
              x: 40,
              y: 80,
              width: 160,
              height: 100,
            },
            {
              id: "two",
              type: "rect",
              x: 600,
              y: 80,
              width: 160,
              height: 100,
            },
          ],
          edges: Array.from(
            { length: mcpMaximumEdges + 1 },
            (_, index) => ({
              id: `edge-${index}`,
              from: "one",
              to: "two",
            }),
          ),
        }),
      )
      const runtime = await GraphicsMcpToolRuntime.create(root)
      const [tooManyShapes, tooManyEdges] = await Promise.all([
        runtime.call("check_diagram", {
          path: "too-many-shapes.diagram.json",
        }),
        runtime.call("check_diagram", {
          path: "too-many-edges.diagram.json",
        }),
      ])
      expectToolError(tooManyShapes, "COMPLEXITY_LIMIT")
      expectToolError(tooManyEdges, "COMPLEXITY_LIMIT")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects oversized raw arrays before semantic parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-raw-complexity-"))
    try {
      await writeFile(
        join(root, "malformed-dense.diagram.json"),
        JSON.stringify({
          shapes: Array.from({ length: 20_000 }, () => ({})),
          edges: Array.from({ length: 20_000 }, () => ({})),
        }),
      )
      const runtime = await GraphicsMcpToolRuntime.create(root)
      const result = await runtime.call("check_diagram", {
        path: "malformed-dense.diagram.json",
      })
      expectToolError(result, "COMPLEXITY_LIMIT")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("bounds returned findings without duplicating them into prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-findings-"))
    try {
      await writeFile(
        join(root, "dense.diagram.json"),
        JSON.stringify({
          version: 1,
          name: "dense",
          canvas: { width: 100, height: 100 },
          shapes: Array.from(
            { length: mcpMaximumShapes },
            (_, index) => ({
              id: `shape-${index}`,
              type: "rect",
              x: -1,
              y: 0,
              width: 10,
              height: 10,
              label: "a deliberately long label for a finding",
            }),
          ),
        }),
      )
      const runtime = await GraphicsMcpToolRuntime.create(root)
      const result = await runtime.call("check_diagram", {
        path: "dense.diagram.json",
      })
      expect(result.isError).toBeUndefined()
      const structured = result.structuredContent as {
        readonly findings: readonly {
          readonly code: string
          readonly message: string
          readonly shapeIds: readonly string[]
        }[]
        readonly summary: {
          readonly shapeCount: number
          readonly edgeCount: number
          readonly findingCount: number
          readonly returnedFindingCount: number
          readonly findingsTruncated: boolean
        }
      }
      expect(structured.findings).toHaveLength(mcpMaximumReturnedFindings)
      expect(structured.summary).toEqual({
        shapeCount: mcpMaximumShapes,
        edgeCount: 0,
        findingCount: mcpMaximumShapes * 3 + 1,
        returnedFindingCount: mcpMaximumReturnedFindings,
        findingsTruncated: true,
      })
      expect(
        structured.findings.every(
          (finding) =>
            finding.code.length <= 64 &&
            finding.message.length <= 240 &&
            finding.shapeIds.length <= 12 &&
            finding.shapeIds.every((shapeId) => shapeId.length <= 120),
        ),
      ).toBe(true)
      expect(result.content[0]?.text).toContain("truncated")
      expect(result.content[0]?.text).not.toContain("outside-canvas")
      expect(JSON.stringify(result).length).toBeLessThan(20_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("searches the fixed registry and rejects source text in semantic execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-semantic-"))
    const marker = join(root, "executed")
    try {
      await writeFile(join(root, "flow.diagram.json"), source())
      const runtime = await GraphicsMcpToolRuntime.create(root)
      const search = await runtime.call("search_graphics", {
        query: "diagram",
      })
      expect(search.structuredContent).toMatchObject({
        ok: true,
        operations: [
          { code: "graphics.diagram.check" },
          { code: "graphics.diagram.render" },
        ],
      })
      const execute = await runtime.call("execute_graphics", {
        operation: "graphics.diagram.check",
        input: {
          path: "flow.diagram.json",
          source: `await Bun.write(${JSON.stringify(marker)}, "executed")`,
        },
      })
      expectToolError(execute, "INVALID_OPERATION_INPUT")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("executes authenticated hosted generation to a confined file with metadata-only output", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-mcp-generate-"))
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58,
    ])
    let calls = 0
    try {
      const runtime = await GraphicsMcpToolRuntime.create(root, {
        secrets: {
          get: async () =>
            JSON.stringify({
              schemaVersion: 1,
              issuer: graphicsProductionContract.issuer,
              clientId: graphicsProductionContract.clientId,
              resource: graphicsProductionContract.resource,
              accessToken: "mcp-access-token",
              refreshToken: "mcp-refresh-token",
              expiresAt: Date.now() + 60 * 60_000,
            }),
          set: async () => undefined,
          delete: async () => false,
        },
        fetch: async (input, init) => {
          calls += 1
          if (
            String(input) ===
            "https://hraness.graphics/.well-known/graphics-cli.json"
          ) {
            return Response.json(remoteDiscovery())
          }
          expect(String(input)).toBe(
            graphicsProductionContract.generateImage,
          )
          expect(init?.redirect).toBe("error")
          return Response.json({
            apiVersion: "v1",
            image: {
              base64: Buffer.from(webp).toString("base64"),
              mediaType: "image/webp",
            },
            model: graphicsImageModels[0],
            requestId: "mcp_request",
          })
        },
      })
      const result = await runtime.call("execute_graphics", {
        operation: "graphics.image.generate",
        input: {
          model: graphicsImageModels[0],
          prompt: "one bounded image",
          outputPath: "generated/image.webp",
          idempotencyKey: "mcp-request-key-01",
        },
      })
      expect(calls).toBe(2)
      expect(result.isError).toBeUndefined()
      expect(result.content).toHaveLength(1)
      expect(result.structuredContent).toMatchObject({
        ok: true,
        operation: "graphics.image.generate",
        result: {
          mediaType: "image/webp",
          model: graphicsImageModels[0],
          outputPath: "generated/image.webp",
          requestId: "mcp_request",
        },
      })
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        Buffer.from(webp).toString("base64"),
      )
      expect(await readFile(join(root, "generated", "image.webp"))).toEqual(
        Buffer.from(webp),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
