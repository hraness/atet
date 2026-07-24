import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadDiagramConfig } from "./config.ts"

describe("Graphics config discovery", () => {
  it("rejects a legacy-only config with exact rename guidance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graphics-config-legacy-"))
    const legacy = join(directory, "diagram.config.json")
    const replacement = join(directory, "graphics.config.json")
    try {
      await writeFile(legacy, JSON.stringify({ font: { family: "Legacy" } }))
      await expect(
        loadDiagramConfig({ searchDirectory: directory }),
      ).rejects.toThrow(
        `Legacy Graphics config found at ${legacy}. Rename it to ${replacement}; Graphics 0.2 does not auto-load diagram.config.*.`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("prefers a new config when a legacy sibling also exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graphics-config-precedence-"))
    const current = join(directory, "graphics.config.json")
    try {
      await Promise.all([
        writeFile(current, JSON.stringify({ font: { family: "Graphics" } })),
        writeFile(
          join(directory, "diagram.config.json"),
          JSON.stringify({ font: { family: "Legacy" } }),
        ),
      ])
      const loaded = await loadDiagramConfig({ searchDirectory: directory })
      expect(loaded.filePath).toBe(current)
      expect(loaded.value.font?.family).toBe("Graphics")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
