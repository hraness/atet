import { z } from "zod"
import { boundedCanonicalJsonSha256, compareUtf16Strings } from "../code/canonical-json.js"
import { SlopcameraCodeError } from "../code/errors.js"
import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../code/json-snapshot.js"

export const STUDIO_LIMITS = Object.freeze({
  documentBytes: 32 * 1024 * 1024, documentDepth: 32, documentValues: 500_000,
  sourceFiles: 512, sourceBytes: 4 * 1024 ** 3, outputSpecifications: 32,
  outputFiles: 25_000, outputBytes: 64 * 1024 ** 3, timeoutSeconds: 6 * 60 * 60,
  frames: 25_000, frameIndexExclusive: 1_000_000, dimension: 8192, pixels: 33_554_432,
  parameterBytes: 256 * 1024, parameterDepth: 16, parameterValues: 20_000,
})
export type StudioReadonly<T> = T extends object ? { readonly [Key in keyof T]: StudioReadonly<T[Key]> } : T
export function studioDocument<Schema extends z.ZodType>(schema: Schema, name: string) {
  return z.preprocess(value => value === undefined ? undefined : createBoundedJsonValueSnapshot(value, STUDIO_LIMITS.documentBytes, name,
    { maximumDepth: STUDIO_LIMITS.documentDepth, maximumValues: STUDIO_LIMITS.documentValues }).value, schema)
}
export function parseStudioValue<Schema extends z.ZodType>(schema: Schema, input: unknown): StudioReadonly<z.infer<Schema>> {
  try { return deepFreezeJson(schema.parse(input)) as StudioReadonly<z.infer<Schema>> }
  catch (error) {
    if (error instanceof SlopcameraCodeError) throw error
    throw new SlopcameraCodeError("invalid-data", error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid studio document." : "Invalid studio document.")
  }
}
export function studioHash(domain: string, value: unknown): string {
  return boundedCanonicalJsonSha256({ domain, value }, { maximumBytes: STUDIO_LIMITS.documentBytes, maximumDepth: STUDIO_LIMITS.documentDepth + 2, maximumValues: STUDIO_LIMITS.documentValues + 4 })
}
export const studioCompare = compareUtf16Strings
export function studioRequire(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SlopcameraCodeError("invalid-data", message)
}
export function pathKey(path: string): string { return path.toLowerCase() }
export function assertDistinctPaths(paths: readonly string[]): void {
  const names = new Set(paths.map(pathKey))
  studioRequire(names.size === paths.length, "Studio paths collide.")
  for (const name of names) {
    for (let offset = name.indexOf("/"); offset !== -1; offset = name.indexOf("/", offset + 1)) {
      studioRequire(!names.has(name.slice(0, offset)), "Studio paths use a file as an ancestor.")
    }
  }
}
