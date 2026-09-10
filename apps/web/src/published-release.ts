import releaseData from "../published-release.json"

export interface PublishedRelease {
  readonly version: string
  readonly releaseUrl: string
}

/** Canonical Slopcamera publication datum: the verified immutable GitHub Release. */
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
  if (typeof releaseUrl !== "string" || releaseUrl !== `https://github.com/hraness/slopcamera/releases/tag/v${version}`) {
    throw new Error("Published release URL must identify its exact Slopcamera tag.")
  }
  return Object.freeze({ version, releaseUrl })
}

export const publishedRelease = parsePublishedRelease(releaseData)

export const publishedArchiveUrl = `https://github.com/hraness/slopcamera/releases/download/v${publishedRelease.version}/hraness-slopcamera-${publishedRelease.version}.tgz`

/** Standard installation from the exact verified canonical archive. */
export const archiveInstall = Object.freeze({
  command: `bun add --global ${publishedArchiveUrl}`,
  checkCommand: "slopcamera doctor --json",
  skillCommand: "slopcamera skill install --target agents",
  alternateSkillCommand: "slopcamera skill install --target claude",
})

/** Contributor path: build the CLI from a source checkout. */
export const sourceInstall = Object.freeze({
  repositoryUrl: "https://github.com/hraness/slopcamera",
  guideUrl: "https://github.com/hraness/slopcamera/blob/main/docs/how-to/use-current-source.md",
  checkoutCommand: "git clone --branch main https://github.com/hraness/slopcamera.git slopcamera-source",
  enterCommand: "cd slopcamera-source",
  skillCommand: "bun apps/desktop/dist/cli/main.js skill install --target agents",
  alternateSkillCommand: "bun apps/desktop/dist/cli/main.js skill install --target claude",
})
