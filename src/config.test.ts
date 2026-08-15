import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadDiagramConfig } from "./config.ts"

describe("Atet config discovery", () => {
  it("rejects a legacy-only config with exact rename guidance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-config-legacy-"))
    const legacy = join(directory, "diagram.config.json")
    const replacement = join(directory, "atet.config.json")
    try {
      await writeFile(legacy, JSON.stringify({ font: { family: "Legacy" } }))
      await expect(
        loadDiagramConfig({ searchDirectory: directory }),
      ).rejects.toThrow(
        `Legacy Atet config found at ${legacy}. Rename it to ${replacement}; Atet does not auto-load diagram.config.*.`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("prefers a new config when a legacy sibling also exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-config-precedence-"))
    const current = join(directory, "atet.config.json")
    try {
      await Promise.all([
        writeFile(current, JSON.stringify({ font: { family: "Atet" } })),
        writeFile(
          join(directory, "diagram.config.json"),
          JSON.stringify({ font: { family: "Legacy" } }),
        ),
      ])
      const loaded = await loadDiagramConfig({ searchDirectory: directory })
      expect(loaded.filePath).toBe(current)
      expect(loaded.value.font?.family).toBe("Atet")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("loads a predecessor config and fails closed on divergent siblings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-config-transmute-"))
    const predecessor = join(directory, "transmute.config.json")
    const current = join(directory, "atet.config.json")
    try {
      await writeFile(predecessor, JSON.stringify({ font: { family: "Existing" } }))
      expect((await loadDiagramConfig({ searchDirectory: directory })).filePath)
        .toBe(predecessor)
      await writeFile(current, JSON.stringify({ font: { family: "Different" } }))
      await expect(loadDiagramConfig({ searchDirectory: directory }))
        .rejects.toThrow("Conflicting Atet configs")
      await writeFile(current, await Bun.file(predecessor).text())
      expect((await loadDiagramConfig({ searchDirectory: directory })).filePath)
        .toBe(current)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
