import releaseData from "../published-release.json"

export interface PublishedRelease {
  readonly version: string
  readonly releaseUrl: string
}

/** Historical Atet publication evidence. These bytes do not install Slopcamera. */
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
    throw new Error("Published release URL must identify its exact historical Atet tag.")
  }
  return Object.freeze({ version, releaseUrl })
}

export const publishedRelease = parsePublishedRelease(releaseData)

export const publishedArchiveUrl = `https://github.com/hraness/atet/releases/download/v${publishedRelease.version}/hraness-atet-${publishedRelease.version}.tgz`

/** The renamed project has no canonical release archive yet. */
export const sourceInstall = Object.freeze({
  repositoryUrl: "https://github.com/hraness/slopcamera",
  guideUrl: "https://github.com/hraness/slopcamera/blob/main/docs/how-to/use-current-source.md",
  checkoutCommand: "git clone --branch main https://github.com/hraness/slopcamera.git slopcamera-source",
  enterCommand: "cd slopcamera-source",
  skillCommand: "bun apps/desktop/dist/cli/main.js skill install --target agents",
  alternateSkillCommand: "bun apps/desktop/dist/cli/main.js skill install --target claude",
})
