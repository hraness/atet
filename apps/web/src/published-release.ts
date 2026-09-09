import releaseData from "../published-release.json"

export interface PublishedRelease {
  readonly version: string
  readonly releaseUrl: string
}

/** Publication evidence is maintained separately from an unpublished source candidate. */
export function parsePublishedRelease(value: unknown): PublishedRelease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Published release must be an object.")
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes("version") || !keys.includes("releaseUrl")) {
    throw new Error("Published release must contain exactly version and releaseUrl.")
  }
  const version: unknown = Reflect.get(value, "version")
  if (typeof version !== "string" || version.length > 50
    || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)
    || !version.split(".").every(part => Number.isSafeInteger(Number(part)) && String(Number(part)) === part)) {
    throw new Error("Published release version must be canonical stable SemVer with safe integer components.")
  }
  const releaseUrl: unknown = Reflect.get(value, "releaseUrl")
  if (typeof releaseUrl !== "string" || releaseUrl !== `https://github.com/hraness/atet/releases/tag/v${version}`) {
    throw new Error("Published release URL must identify its exact immutable Atet tag.")
  }
  return Object.freeze({ version, releaseUrl })
}

export const publishedRelease = parsePublishedRelease(releaseData)

export const publishedArchiveUrl = `https://github.com/hraness/atet/releases/download/v${publishedRelease.version}/hraness-atet-${publishedRelease.version}.tgz`
