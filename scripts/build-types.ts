import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const declarationRoot = join(import.meta.dir, "..", "dist")
const relativeTypeScriptSpecifier =
  /(["'])(\.\.?\/[^"'\r\n]+)\.ts\1/gu
const leakedTypeScriptSpecifier =
  /(["'])(\.\.?\/[^"'\r\n]+)\.ts\1/u

async function declarationFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return declarationFiles(path)
      return entry.isFile() && entry.name.endsWith(".d.ts") ? [path] : []
    }),
  )
  return nested.flat()
}

const files = await declarationFiles(declarationRoot)
if (files.length === 0) {
  throw new Error("TypeScript emitted no declarations into dist.")
}

for (const file of files) {
  const declaration = await readFile(file, "utf8")
  const rewritten = declaration.replace(
    relativeTypeScriptSpecifier,
    (_match, quote: string, specifier: string) =>
      `${quote}${specifier}.js${quote}`,
  )
  if (leakedTypeScriptSpecifier.test(rewritten)) {
    throw new Error(`Declaration still exposes a .ts module specifier: ${file}`)
  }
  if (rewritten !== declaration) await writeFile(file, rewritten)
}
