import { access, readFile, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

const root = join(process.cwd(), "skills", "atet")
const skillPath = join(root, "SKILL.md")
const text = await readFile(skillPath, "utf8")

const publicSkills = (await readdir(join(process.cwd(), "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
if (publicSkills.length !== 1 || publicSkills[0] !== "atet") {
  throw new Error(`Package must expose only skills/atet; found ${publicSkills.join(", ")}`)
}

async function collectMarkdownFiles(directory: string): Promise<readonly string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await collectMarkdownFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path)
  }
  return paths
}

async function validateLocalMarkdownLinks(): Promise<void> {
  for (const markdownPath of await collectMarkdownFiles(root)) {
    const markdown = await readFile(markdownPath, "utf8")
    for (const link of markdown.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
      const targetText = link[1]
      if (targetText === undefined || /^[a-z][a-z0-9+.-]*:/iu.test(targetText)) continue
      const target = resolve(dirname(markdownPath), targetText)
      const skillRelative = relative(root, target)
      if (skillRelative.startsWith("..") || isAbsolute(skillRelative)) {
        throw new Error(`Skill link escapes its bundle: ${targetText}`)
      }
      try {
        await access(target)
      } catch {
        throw new Error(`Skill link target is missing: ${targetText}`)
      }
    }
  }
}
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
if (frontmatter.name !== "atet") throw new Error("Skill name must be atet")
if ((frontmatter.description?.length ?? 0) < 40) {
  throw new Error("Skill description must explain capability and triggers")
}
if ((frontmatter.description?.length ?? 0) > 1024) {
  throw new Error("Skill description must be at most 1024 characters")
}
const linkedReferences = new Set(
  [...text.matchAll(/\]\((references\/[^)#]+)(?:#[^)]+)?\)/g)]
    .map((reference) => reference[1])
    .filter((path): path is string => path !== undefined),
)
for (const relativePath of [
  "references/customization.md",
  "references/gateway-media.md",
  "references/install.md",
  "references/reference-led-3d.md",
  "references/rubber-stamp-field-notes.md",
  "references/video-projects.md",
  "references/visual-communication.md",
]) {
  if (!linkedReferences.has(relativePath)) {
    throw new Error(`SKILL.md must route to ${relativePath}`)
  }
  try {
    await access(join(root, relativePath))
  } catch {
    throw new Error(`Skill is missing ${relativePath}`)
  }
}
for (const relativePath of [
  "references/rubber-stamp-examples/poster-example-1.jpg",
  "references/rubber-stamp-examples/poster-example-2.jpg",
  "references/rubber-stamp-examples/stamp-style-1.png",
  "references/rubber-stamp-examples/stamp-style-2.png",
  "scripts/compose-rubber-stamp-field-note.ts",
]) {
  try {
    await access(join(root, relativePath))
  } catch {
    throw new Error(`Skill is missing ${relativePath}`)
  }
}
const rubberStampReference = await readFile(
  join(root, "references", "rubber-stamp-field-notes.md"),
  "utf8",
)
for (const requiredPath of [
  "references/rubber-stamp-examples/stamp-style-1.png",
  "references/rubber-stamp-examples/stamp-style-2.png",
  '$skill_root/scripts/compose-rubber-stamp-field-note.ts',
]) {
  if (!rubberStampReference.includes(requiredPath)) {
    throw new Error(`Rubber-stamp workflow must route to ${requiredPath}`)
  }
}
if (rubberStampReference.includes("skills/atet/")) {
  throw new Error("Rubber-stamp workflow must not assume an Atet source checkout")
}
if ([...rubberStampReference.matchAll(/skill_root="\$\(atet skill path\)"/gu)].length !== 2) {
  throw new Error("Each rubber-stamp executable step must resolve its packaged skill root")
}
for (const executableBlock of [
  /```sh\nskill_root="\$\(atet skill path\)"\nvercel env run -- atet ai image generate[\s\S]*?--image "\$skill_root\/references\/rubber-stamp-examples\/stamp-style-1\.png"[\s\S]*?```/u,
  /```sh\nskill_root="\$\(atet skill path\)"\nbun "\$skill_root\/scripts\/compose-rubber-stamp-field-note\.ts"[\s\S]*?```/u,
]) {
  if (!executableBlock.test(rubberStampReference)) {
    throw new Error("Rubber-stamp executable blocks must be self-contained")
  }
}
try {
  await access(join(root, "agents", "openai.yaml"))
} catch {
  throw new Error("Skill is missing agents/openai.yaml")
}
const openai = await readFile(join(root, "agents", "openai.yaml"), "utf8")
for (const required of ["display_name:", "short_description:", "default_prompt:"]) {
  if (!openai.includes(required)) throw new Error(`agents/openai.yaml is missing ${required}`)
}
if (!openai.includes("$atet")) throw new Error("agents/openai.yaml default prompt must invoke $atet")
const install = await readFile(join(root, "references", "install.md"), "utf8")
const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
  readonly version?: unknown
}
if (typeof manifest.version !== "string") throw new Error("package version is missing")
if (!install.includes(`@hraness/atet@${manifest.version}`)) {
  throw new Error("Skill npm install pin must match the package version")
}
await validateLocalMarkdownLinks()
console.log("atet skill is valid")
