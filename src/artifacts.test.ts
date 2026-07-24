import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderDiagramFile } from "./artifacts.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("renderDiagramFile", () => {
  test("writes the consistent five-file artifact family", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diagram-artifacts-"))
    temporaryDirectories.push(directory)
    const source = join(directory, "simple.diagram.json")
    await writeFile(
      source,
      JSON.stringify({
        version: 1,
        name: "simple",
        canvas: { width: 640, height: 360 },
        shapes: [
          { id: "one", type: "rect", x: 80, y: 90, width: 200, height: 120, label: "One" },
          { id: "two", type: "rect", x: 360, y: 90, width: 200, height: 120, label: "Two" },
        ],
        edges: [{ id: "one-two", from: "one", to: "two" }],
      }),
    )
    const result = await renderDiagramFile({ filePath: source, scale: 1 })
    expect(Object.values(result.artifacts)).toHaveLength(6)
    expect(await readFile(result.artifacts.tldr, "utf8")).toContain('"tldrawFileFormatVersion": 1')
    expect((await readFile(result.artifacts.lightPng)).subarray(1, 4).toString()).toBe("PNG")
  })
})
