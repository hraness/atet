import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathExists } from "./fs.ts"
import { installSkill } from "./skill-install.ts"

describe("Slopcamera skill installation", () => {
  it("rejects a sibling legacy skill before installing Slopcamera", async () => {
    const project = await mkdtemp(join(tmpdir(), "slopcamera-skill-legacy-"))
    const legacy = join(project, ".agents", "skills", "diagram")
    const destination = join(project, ".agents", "skills", "slopcamera")
    try {
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, "SKILL.md"), "legacy")
      await expect(
        installSkill({
          target: "agents",
          scope: "project",
          projectDirectory: project,
        }),
      ).rejects.toThrow(
        `Legacy diagram skill found at ${legacy}. Remove or move that directory, then rerun "slopcamera skill install --target agents --scope project". Slopcamera will not install both skills side by side.`,
      )
      expect(await pathExists(destination)).toBe(false)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})
