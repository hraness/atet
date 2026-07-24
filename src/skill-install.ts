import { cp, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { pathExists } from "./fs.ts"

export type SkillTarget = "codex" | "claude" | "agents"
export type SkillScope = "user" | "project"

export function bundledSkillPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../skills/diagram")
}

function targetRoot(target: SkillTarget, scope: SkillScope, projectDirectory: string): string {
  const directory =
    target === "codex" ? ".codex" : target === "claude" ? ".claude" : ".agents"
  return scope === "user" ? join(homedir(), directory, "skills") : join(projectDirectory, directory, "skills")
}

export async function installSkill(options: {
  readonly target: SkillTarget
  readonly scope: SkillScope
  readonly projectDirectory?: string
  readonly force?: boolean
}): Promise<string> {
  const source = bundledSkillPath()
  if (!(await pathExists(source))) throw new Error(`Bundled skill is missing: ${source}`)
  const destination = join(
    targetRoot(options.target, options.scope, resolve(options.projectDirectory ?? process.cwd())),
    "diagram",
  )
  if (await pathExists(destination)) {
    if (!options.force) {
      throw new Error(`Skill already exists at ${destination}; pass --force to replace it`)
    }
    await rm(destination, { recursive: true, force: true })
  }
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, errorOnExist: true })
  return destination
}
