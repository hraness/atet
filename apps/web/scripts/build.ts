import { cp, mkdir, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDirectory = join(appDirectory, "src")
const outputDirectory = join(appDirectory, "dist")

const publicFiles = [
  "404.html",
  "icon.svg",
  "index.html",
  "robots.txt",
  "sitemap.xml",
  "styles.css",
  "theme.js",
] as const

await rm(outputDirectory, { force: true, recursive: true })
await mkdir(outputDirectory, { recursive: true })

for (const file of publicFiles) {
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

console.log(`Built ${publicFiles.length} static files in ${outputDirectory}`)
