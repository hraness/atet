export const htmlMediaType = "text/html"
export const markdownMediaType = "text/markdown"
export const producedMediaTypes = [htmlMediaType, markdownMediaType] as const

export type ProducedMediaType = (typeof producedMediaTypes)[number]

type AcceptEntry = Readonly<{
  position: number
  q: number
  specificity: number
  type: string
}>

const mediaToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const qualityValue = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u

function parseQuality(value: string): number | null {
  return qualityValue.test(value) ? Number(value) : null
}

function isMediaRange(value: string): boolean {
  if (value === "*/*") {
    return true
  }
  const segments = value.split("/")
  if (segments.length !== 2) {
    return false
  }
  const [type, subtype] = segments
  return type !== undefined
    && subtype !== undefined
    && type !== "*"
    && mediaToken.test(type)
    && (subtype === "*" || mediaToken.test(subtype))
}

function specificityFor(type: string): number {
  if (type === "*/*") {
    return 0
  }
  return type.endsWith("/*") ? 1 : 2
}

export function parseAccept(header: string): readonly AcceptEntry[] {
  return header.split(",").flatMap((raw, position) => {
    const parts = raw.trim().split(";").map(part => part.trim())
    const type = parts[0]?.toLowerCase()
    if (type === undefined || !isMediaRange(type)) {
      return []
    }

    let q = 1
    let sawQuality = false
    for (const parameter of parts.slice(1)) {
      const separator = parameter.indexOf("=")
      if (separator <= 0) {
        return []
      }
      const name = parameter.slice(0, separator).trim().toLowerCase()
      if (name !== "q" || sawQuality) {
        return []
      }
      const parsedQuality = parseQuality(parameter.slice(separator + 1).trim())
      if (parsedQuality === null) {
        return []
      }
      q = parsedQuality
      sawQuality = true
    }

    return [{
      position,
      q,
      specificity: specificityFor(type),
      type,
    }]
  })
}

function matches(entry: AcceptEntry, candidate: string): boolean {
  if (entry.type === "*/*") {
    return true
  }
  if (entry.type.endsWith("/*")) {
    return candidate.startsWith(entry.type.slice(0, -1))
  }
  return entry.type === candidate
}

function matchingEntry(
  entries: readonly AcceptEntry[],
  candidate: string,
): AcceptEntry | null {
  let matched: AcceptEntry | null = null
  for (const entry of entries) {
    if (!matches(entry, candidate)) {
      continue
    }
    if (
      matched === null
      || entry.specificity > matched.specificity
      || (entry.specificity === matched.specificity && entry.position < matched.position)
    ) {
      matched = entry
    }
  }
  return matched
}

export function preferredRepresentationFrom(
  header: string | null,
  candidates: readonly ProducedMediaType[],
): ProducedMediaType | null {
  const defaultType = candidates[0] ?? null
  if (header === null || header.trim() === "") {
    return defaultType
  }

  const entries = parseAccept(header)
  if (entries.length === 0) {
    return null
  }

  let bestType: ProducedMediaType | null = null
  let bestQ = -1
  let bestPosition = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const matched = matchingEntry(entries, candidate)
    if (matched === null || matched.q <= 0) {
      continue
    }
    if (matched.q > bestQ || (matched.q === bestQ && matched.position < bestPosition)) {
      bestQ = matched.q
      bestPosition = matched.position
      bestType = candidate
    }
  }

  return bestType
}

export function preferredRepresentation(header: string | null): ProducedMediaType | null {
  return preferredRepresentationFrom(header, producedMediaTypes)
}

export const notAcceptableBody = "Not Acceptable\n\nAvailable: text/html, text/markdown\n"
