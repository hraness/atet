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

function parseQuality(value: string | undefined): number {
  if (value === undefined) {
    return 1
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 1
  }
  return Math.max(0, Math.min(1, parsed))
}

function specificityFor(type: string): number {
  if (type === "*/*") {
    return 0
  }
  return type.endsWith("/*") ? 1 : 2
}

export function parseAccept(header: string): readonly AcceptEntry[] {
  return header.split(",").flatMap((raw, position) => {
    const parts = raw.trim().split(";").map(part => part.trim()).filter(part => part.length > 0)
    const type = parts[0]?.toLowerCase()
    if (type === undefined || type.length === 0) {
      return []
    }

    let q = 1
    for (const parameter of parts.slice(1)) {
      const separator = parameter.indexOf("=")
      const name = (separator === -1 ? parameter : parameter.slice(0, separator)).trim().toLowerCase()
      if (name !== "q") {
        continue
      }
      q = parseQuality(separator === -1 ? undefined : parameter.slice(separator + 1).trim())
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

export function preferredRepresentation(header: string | null): ProducedMediaType | null {
  if (header === null || header.trim() === "") {
    return htmlMediaType
  }

  const entries = parseAccept(header)
  if (entries.length === 0) {
    return htmlMediaType
  }

  let bestType: ProducedMediaType | null = null
  let bestQ = -1
  let bestPosition = Number.POSITIVE_INFINITY

  for (const candidate of producedMediaTypes) {
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

export const notAcceptableBody = "Not Acceptable\n\nAvailable: text/html, text/markdown\n"
