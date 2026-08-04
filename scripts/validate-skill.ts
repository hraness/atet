import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

const root = join(process.cwd(), "skills", "transmute")
const skillPath = join(root, "SKILL.md")
const text = await readFile(skillPath, "utf8")
const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
if (match === null) throw new Error("SKILL.md must start with YAML frontmatter")

const frontmatter = Object.fromEntries(
  (match[1] ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const separator = line.indexOf(":")
      if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`)
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
    }),
)
const keys = Object.keys(frontmatter).sort()
if (keys.join(",") !== "description,name") {
  throw new Error(`SKILL.md frontmatter must contain only name and description, received ${keys}`)
}
if (frontmatter.name !== "transmute") throw new Error("Skill name must be transmute")
if ((frontmatter.description?.length ?? 0) < 40) {
  throw new Error("Skill description must explain capability and triggers")
}
if ((frontmatter.description?.length ?? 0) > 1024) {
  throw new Error("Skill description must be at most 1024 characters")
}
for (const relativePath of [
  "agents/openai.yaml",
  "references/customization.md",
  "references/reference-led-3d.md",
  "references/visual-communication.md",
]) {
  try {
    await access(join(root, relativePath))
  } catch {
    throw new Error(`Skill is missing ${relativePath}`)
  }
}
const openai = await readFile(join(root, "agents", "openai.yaml"), "utf8")
for (const required of ["display_name:", "short_description:", "default_prompt:"]) {
  if (!openai.includes(required)) throw new Error(`agents/openai.yaml is missing ${required}`)
}
console.log("transmute skill is valid")
