import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDirectory = join(appDirectory, "src")
const outputDirectory = join(appDirectory, "dist")

const copiedFiles = [
  "apple-touch-icon.png",
  "icon.svg",
  "og.png",
  "robots.txt",
  "sitemap.xml",
] as const

function assetPath(name: string, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12)
  const extensionIndex = name.lastIndexOf(".")
  const stem = name.slice(0, extensionIndex)
  const extension = name.slice(extensionIndex)
  return `/assets/${stem}-${digest}${extension}`
}

function renderDocument(template: string, assets: Readonly<Record<string, string>>): string {
  let rendered = template
  for (const [placeholder, value] of Object.entries(assets)) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`Static document is missing ${placeholder}`)
    }
    rendered = rendered.replaceAll(placeholder, value)
  }
  if (/\{\{[A-Z0-9_]+\}\}/u.test(rendered)) {
    throw new Error("Static document contains an unresolved placeholder")
  }
  return rendered
}

export async function buildWebsite(): Promise<Readonly<{
  stylesPath: string
  themePath: string
}>> {
  const [indexTemplate, docsTemplate, notFoundTemplate, styles, theme] = await Promise.all([
    readFile(join(sourceDirectory, "index.html"), "utf8"),
    readFile(join(sourceDirectory, "docs.html"), "utf8"),
    readFile(join(sourceDirectory, "404.html"), "utf8"),
    readFile(join(sourceDirectory, "styles.css")),
    readFile(join(sourceDirectory, "theme.js")),
  ])

  const stylesPath = assetPath("styles.css", styles)
  const themePath = assetPath("theme.js", theme)
  const assets = {
    "{{CSS_ASSET}}": stylesPath,
    "{{THEME_ASSET}}": themePath,
  } as const

  await rm(outputDirectory, { force: true, recursive: true })
  await mkdir(join(outputDirectory, "assets"), { recursive: true })
  await mkdir(join(outputDirectory, "docs"), { recursive: true })

  await Promise.all([
    writeFile(join(outputDirectory, "index.html"), renderDocument(indexTemplate, assets)),
    writeFile(join(outputDirectory, "docs/index.html"), renderDocument(docsTemplate, assets)),
    writeFile(join(outputDirectory, "404.html"), renderDocument(notFoundTemplate, assets)),
    writeFile(join(outputDirectory, stylesPath.slice(1)), styles),
    writeFile(join(outputDirectory, themePath.slice(1)), theme),
  ])

  for (const file of copiedFiles) {
    const source = join(sourceDirectory, file)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile()) {
      throw new Error(`Static source is not a regular file: ${basename(source)}`)
    }
    await cp(source, join(outputDirectory, file), {
      dereference: true,
      errorOnExist: true,
    })
  }

  return { stylesPath, themePath }
}

if (import.meta.main) {
  await buildWebsite()
  console.log(`Built ${copiedFiles.length + 5} static files in ${outputDirectory}`)
}
