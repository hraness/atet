import { createHash } from "node:crypto"

export const LEGACY_IDENTITY_CATEGORIES = [
  "artifact-reader",
  "cli-bin-alias",
  "compat-doc",
  "deprecated-ts-api",
  "env-reader",
  "generated",
  "legacy-redirect",
  "serialized-reader",
  "shared-admission-key",
  "source-import-reader",
  "stable-hash-domain",
  "test-fixture",
] as const

export type LegacyIdentityCategory =
  typeof LEGACY_IDENTITY_CATEGORIES[number]

export interface LegacyIdentityInventoryEntry {
  readonly categories: readonly LegacyIdentityCategory[]
  readonly identityLineCount: number
  readonly identityLinesSha256: string
  readonly occurrenceCount: number
  readonly path: string
}

export type LegacyIdentitySnapshot = Omit<
  LegacyIdentityInventoryEntry,
  "categories"
>

export interface LegacyIdentityInventoryUpdate {
  readonly entries: readonly LegacyIdentityInventoryEntry[]
  readonly problems: readonly string[]
}

interface SyntaxToken {
  readonly kind: "identifier" | "punctuator" | "string"
  readonly line: number
  readonly text: string
  readonly value?: string
}

interface DuplicateIssue {
  readonly label: string
  readonly line: number
  readonly value: string
}

const LEGACY_IDENTITY_PATTERN = /transmute|studio|hraness\.graphics/giu
const IDENTITY_LITERAL_PATTERN = /^(?:atet|transmute|studio)(?:[./-][a-z0-9][a-z0-9./-]*)?$/iu
const SYNTAX_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u
const TYPESCRIPT_EXTENSIONS = /\.(?:[cm]?tsx?)$/u

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function matchesLegacyIdentity(value: string): boolean {
  LEGACY_IDENTITY_PATTERN.lastIndex = 0
  return LEGACY_IDENTITY_PATTERN.test(value)
}

export function legacyIdentitySnapshot(
  path: string,
  source: string,
): LegacyIdentitySnapshot | null {
  const normalized = source.replaceAll("\r\n", "\n")
  LEGACY_IDENTITY_PATTERN.lastIndex = 0
  const occurrenceCount = [...normalized.matchAll(LEGACY_IDENTITY_PATTERN)].length
  if (occurrenceCount === 0) return null
  const identityLines = normalized
    .split("\n")
    .filter(matchesLegacyIdentity)
  return {
    identityLineCount: identityLines.length,
    identityLinesSha256: sha256(identityLines.join("\n")),
    occurrenceCount,
    path,
  }
}

function isIdentifierStart(character: string): boolean {
  return /[A-Z_a-z$]/u.test(character)
}

function isIdentifierContinue(character: string): boolean {
  return /[0-9A-Z_a-z$]/u.test(character)
}

function decodeHex(source: string, start: number, length: number): string | null {
  const raw = source.slice(start, start + length)
  if (raw.length !== length || !/^[a-fA-F0-9]+$/u.test(raw)) return null
  const codePoint = Number.parseInt(raw, 16)
  if (codePoint > 0x10ffff) return null
  return String.fromCodePoint(codePoint)
}

function readQuotedString(
  source: string,
  start: number,
  line: number,
): { readonly end: number; readonly line: number; readonly value: string } {
  const quote = source[start]!
  let cursor = start + 1
  let currentLine = line
  let value = ""
  while (cursor < source.length) {
    const character = source[cursor]!
    if (character === quote) {
      return { end: cursor + 1, line: currentLine, value }
    }
    if (character === "\n" || character === "\r") {
      return { end: cursor, line: currentLine, value }
    }
    if (character !== "\\") {
      value += character
      cursor += 1
      continue
    }

    cursor += 1
    if (cursor >= source.length) break
    const escaped = source[cursor]!
    if (escaped === "\n") {
      currentLine += 1
      cursor += 1
      continue
    }
    if (escaped === "\r") {
      currentLine += 1
      cursor += source[cursor + 1] === "\n" ? 2 : 1
      continue
    }
    const simpleEscapes: Readonly<Record<string, string>> = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    }
    const simple = simpleEscapes[escaped]
    if (simple !== undefined) {
      value += simple
      cursor += 1
      continue
    }
    if (escaped === "x") {
      const decoded = decodeHex(source, cursor + 1, 2)
      if (decoded !== null) {
        value += decoded
        cursor += 3
        continue
      }
    }
    if (escaped === "u") {
      if (source[cursor + 1] === "{") {
        const close = source.indexOf("}", cursor + 2)
        const raw = close === -1 ? "" : source.slice(cursor + 2, close)
        const decoded = raw.length > 0 && raw.length <= 6
          ? decodeHex(raw, 0, raw.length)
          : null
        if (decoded !== null) {
          value += decoded
          cursor = close + 1
          continue
        }
      } else {
        const decoded = decodeHex(source, cursor + 1, 4)
        if (decoded !== null) {
          value += decoded
          cursor += 5
          continue
        }
      }
    }
    value += escaped
    cursor += 1
  }
  return { end: cursor, line: currentLine, value }
}

function canStartRegularExpression(previous: SyntaxToken | undefined): boolean {
  if (previous === undefined) return true
  if (previous.kind === "punctuator") {
    return /^(?:[({[,:;=!?&|+*%~^<>-])$/u.test(previous.text)
  }
  return previous.kind === "identifier" && [
    "case",
    "delete",
    "else",
    "in",
    "instanceof",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ].includes(previous.text)
}

function tokenize(source: string): readonly SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  let cursor = 0
  let line = 1

  function advanceLineEnding(): void {
    line += 1
    cursor += source[cursor] === "\r" && source[cursor + 1] === "\n" ? 2 : 1
  }

  function scanTemplate(): void {
    const templateLine = line
    cursor += 1
    while (cursor < source.length) {
      const character = source[cursor]!
      if (character === "\\") {
        cursor += 1
        if (source[cursor] === "\n" || source[cursor] === "\r") {
          advanceLineEnding()
        } else if (cursor < source.length) {
          cursor += 1
        }
        continue
      }
      if (character === "`") {
        cursor += 1
        tokens.push({ kind: "identifier", line: templateLine, text: "__template__" })
        return
      }
      if (character === "$" && source[cursor + 1] === "{") {
        const interpolationLine = line
        cursor += 2
        tokens.push({ kind: "punctuator", line: interpolationLine, text: "(" })
        scan(true)
        tokens.push({ kind: "punctuator", line, text: ")" })
        continue
      }
      if (character === "\n" || character === "\r") {
        advanceLineEnding()
      } else {
        cursor += 1
      }
    }
    tokens.push({ kind: "identifier", line: templateLine, text: "__template__" })
  }

  function scan(stopAtInterpolationEnd = false): void {
    const expressionTokenStart = tokens.length
    let braceDepth = 0
    while (cursor < source.length) {
      const character = source[cursor]!
      if (stopAtInterpolationEnd && character === "}" && braceDepth === 0) {
        cursor += 1
        return
      }
      if (character === "\n" || character === "\r") {
        advanceLineEnding()
        continue
      }
      if (/\s/u.test(character)) {
        cursor += 1
        continue
      }
      if (character === "/" && source[cursor + 1] === "/") {
        cursor += 2
        while (cursor < source.length && !/[\r\n]/u.test(source[cursor]!)) cursor += 1
        continue
      }
      if (character === "/" && source[cursor + 1] === "*") {
        cursor += 2
        while (cursor < source.length) {
          if (source[cursor] === "*" && source[cursor + 1] === "/") {
            cursor += 2
            break
          }
          if (source[cursor] === "\n" || source[cursor] === "\r") {
            advanceLineEnding()
          } else {
            cursor += 1
          }
        }
        continue
      }
      if (character === "'" || character === '"') {
        const startLine = line
        const string = readQuotedString(source, cursor, line)
        tokens.push({
          kind: "string",
          line: startLine,
          text: source.slice(cursor, string.end),
          value: string.value,
        })
        cursor = string.end
        line = string.line
        continue
      }
      if (character === "`") {
        scanTemplate()
        continue
      }
      const priorExpressionToken = tokens.length === expressionTokenStart
        ? undefined
        : tokens.at(-1)
      if (
        character === "/"
        && source[cursor + 1] !== "="
        && canStartRegularExpression(priorExpressionToken)
      ) {
        cursor += 1
        let characterClass = false
        while (cursor < source.length) {
          const current = source[cursor]!
          if (current === "\\") {
            cursor += Math.min(2, source.length - cursor)
            continue
          }
          if (current === "[") characterClass = true
          else if (current === "]") characterClass = false
          else if (current === "/" && !characterClass) {
            cursor += 1
            while (cursor < source.length && /[A-Za-z]/u.test(source[cursor]!)) cursor += 1
            break
          } else if (current === "\n" || current === "\r") {
            break
          }
          cursor += 1
        }
        continue
      }
      if (isIdentifierStart(character)) {
        const start = cursor
        cursor += 1
        while (cursor < source.length && isIdentifierContinue(source[cursor]!)) cursor += 1
        tokens.push({
          kind: "identifier",
          line,
          text: source.slice(start, cursor),
        })
        continue
      }
      if (/[0-9]/u.test(character)) {
        cursor += 1
        while (cursor < source.length && /[0-9A-F_a-f.nxob]/u.test(source[cursor]!)) cursor += 1
        continue
      }
      if (stopAtInterpolationEnd) {
        if (character === "{") braceDepth += 1
        else if (character === "}") braceDepth -= 1
      }
      tokens.push({ kind: "punctuator", line, text: character })
      cursor += 1
    }
  }

  scan()
  return tokens
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (!IDENTITY_LITERAL_PATTERN.test(value)) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort()
}

function matchingDelimiter(
  tokens: readonly SyntaxToken[],
  start: number,
): number | null {
  const pairs: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" }
  const first = tokens[start]
  if (first === undefined || !(first.text in pairs)) return null
  const stack: string[] = [pairs[first.text]!]
  for (let index = start + 1; index < tokens.length; index += 1) {
    const text = tokens[index]!.text
    if (text in pairs) stack.push(pairs[text]!)
    else if (text === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return index
    }
  }
  return null
}

function splitArrayItems(
  tokens: readonly SyntaxToken[],
  start: number,
  end: number,
): readonly (readonly SyntaxToken[])[] {
  const items: SyntaxToken[][] = []
  let item: SyntaxToken[] = []
  const stack: string[] = []
  const pairs: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" }
  for (let index = start; index < end; index += 1) {
    const token = tokens[index]!
    if (token.text in pairs) stack.push(pairs[token.text]!)
    else if (token.text === stack.at(-1)) stack.pop()
    if (token.text === "," && stack.length === 0) {
      if (item.length > 0) items.push(item)
      item = []
    } else {
      item.push(token)
    }
  }
  if (item.length > 0) items.push(item)
  return items
}

function directSchemaLiteral(
  item: readonly SyntaxToken[],
  schemaMethod: "enum" | "union",
  zodBinding: string,
): string | null {
  if (schemaMethod === "enum") {
    return item.length === 1 && item[0]?.kind === "string"
      ? item[0].value ?? null
      : null
  }
  return item.length === 6
    && item[0]?.kind === "identifier"
    && item[0].text === zodBinding
    && item[1]?.text === "."
    && item[2]?.kind === "identifier"
    && item[2].text === "literal"
    && item[3]?.text === "("
    && item[4]?.kind === "string"
    && item[5]?.text === ")"
    ? item[4].value ?? null
    : null
}

function zodBindings(tokens: readonly SyntaxToken[]): ReadonlySet<string> {
  const bindings = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index]?.kind !== "identifier"
      || tokens[index]?.text !== "import"
      || tokens[index + 1]?.text === "type"
    ) continue
    let from = index + 1
    while (
      from < tokens.length
      && !(tokens[from]?.kind === "identifier" && tokens[from]?.text === "from")
      && tokens[from]?.text !== ";"
    ) from += 1
    const moduleSpecifier = tokens[from + 1]
    if (
      tokens[from]?.text !== "from"
      || moduleSpecifier?.kind !== "string"
      || !/^zod(?:\/|$)/u.test(moduleSpecifier.value ?? "")
    ) continue

    const clause = tokens.slice(index + 1, from)
    const defaultBinding = clause[0]
    if (defaultBinding?.kind === "identifier") {
      bindings.add(defaultBinding.text)
    }
    for (let clauseIndex = 0; clauseIndex < clause.length; clauseIndex += 1) {
      if (clause[clauseIndex]?.text === "*" && clause[clauseIndex + 1]?.text === "as") {
        const binding = clause[clauseIndex + 2]
        if (binding?.kind === "identifier") bindings.add(binding.text)
        continue
      }
      if (clause[clauseIndex]?.kind !== "identifier" || clause[clauseIndex]?.text !== "z") {
        continue
      }
      if (clause[clauseIndex - 1]?.text === "type") continue
      const alias = clause[clauseIndex + 1]?.text === "as"
        ? clause[clauseIndex + 2]
        : clause[clauseIndex]
      if (alias?.kind === "identifier") bindings.add(alias.text)
    }
    index = from + 1
  }
  return bindings
}

function schemaDuplicateIssues(tokens: readonly SyntaxToken[]): readonly DuplicateIssue[] {
  const issues: DuplicateIssue[] = []
  const bindings = zodBindings(tokens)
  for (let index = 0; index < tokens.length - 5; index += 1) {
    const method = tokens[index + 2]
    const schemaMethod = method?.text === "enum" || method?.text === "union"
      ? method.text
      : null
    if (
      tokens[index]?.kind !== "identifier"
      || !bindings.has(tokens[index]!.text)
      || tokens[index + 1]?.text !== "."
      || method?.kind !== "identifier"
      || schemaMethod === null
      || tokens[index + 3]?.text !== "("
      || tokens[index + 4]?.text !== "["
    ) continue
    const arrayEnd = matchingDelimiter(tokens, index + 4)
    if (arrayEnd === null) continue
    const zodBinding = tokens[index]!.text
    const values = splitArrayItems(tokens, index + 5, arrayEnd)
      .map(item => directSchemaLiteral(item, schemaMethod, zodBinding))
      .filter((value): value is string => value !== null)
    for (const value of duplicateValues(values)) {
      issues.push({
        label: `z.${schemaMethod}`,
        line: tokens[index]!.line,
        value,
      })
    }
    index = arrayEnd
  }
  return issues
}

function hasTypeContext(tokens: readonly SyntaxToken[], start: number): boolean {
  let examined = 0
  for (let index = start - 1; index >= 0 && examined < 160; index -= 1) {
    const token = tokens[index]!
    examined += 1
    if (token.text === ";") return false
    if (token.kind === "identifier" && ["as", "extends", "satisfies"].includes(token.text)) {
      return true
    }
    if (token.text === ":") return true
    if (token.kind === "identifier" && token.text === "type") return true
    if (
      token.kind === "identifier"
      && ["const", "let", "return", "throw", "var"].includes(token.text)
    ) return false
  }
  return false
}

interface UnionAlternative {
  readonly end: number
  readonly separator: boolean
  readonly value: string | null
}

function readUnionAlternative(
  tokens: readonly SyntaxToken[],
  start: number,
): UnionAlternative {
  const segment: SyntaxToken[] = []
  const stack: string[] = []
  const pairs: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" }
  let index = start
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (stack.length === 0) {
      if (token.text === "|") break
      if ([",", ";", "=", ":", "?", ">", ")", "]", "}"].includes(token.text)) break
      if (
        segment.length > 0
        && segment[0]?.kind === "string"
        && token.line > segment[0].line
      ) break
    }
    if (token.text in pairs) stack.push(pairs[token.text]!)
    else if (token.text === stack.at(-1)) stack.pop()
    segment.push(token)
  }
  return {
    end: index,
    separator: tokens[index]?.text === "|",
    value: segment.length === 1 && segment[0]?.kind === "string"
      ? segment[0].value ?? null
      : null,
  }
}

function typeUnionDuplicateIssues(tokens: readonly SyntaxToken[]): readonly DuplicateIssue[] {
  const issues: DuplicateIssue[] = []
  const consumed = new Set<number>()
  for (let start = 0; start < tokens.length; start += 1) {
    if (
      consumed.has(start)
      || tokens[start]?.kind !== "string"
      || !hasTypeContext(tokens, start)
    ) continue
    const values: string[] = []
    let cursor = start
    let alternatives = 0
    while (cursor < tokens.length) {
      const alternative = readUnionAlternative(tokens, cursor)
      if (alternative.value !== null) values.push(alternative.value)
      alternatives += 1
      for (let index = cursor; index < alternative.end; index += 1) consumed.add(index)
      if (!alternative.separator) break
      cursor = alternative.end + 1
    }
    if (alternatives < 2) continue
    for (const value of duplicateValues(values)) {
      issues.push({
        label: "a type union",
        line: tokens[start]!.line,
        value,
      })
    }
  }
  return issues
}

export function duplicateIdentityAlternatives(
  path: string,
  source: string,
): readonly string[] {
  if (!SYNTAX_EXTENSIONS.test(path)) return []
  const tokens = tokenize(source)
  const issues = [
    ...schemaDuplicateIssues(tokens),
    ...(TYPESCRIPT_EXTENSIONS.test(path) ? typeUnionDuplicateIssues(tokens) : []),
  ]
  issues.sort((left, right) =>
    left.line - right.line
    || left.label.localeCompare(right.label)
    || left.value.localeCompare(right.value)
  )
  return issues.map(issue =>
    `${path}:${issue.line} repeats ${issue.value} in ${issue.label}`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function validateInventoryEntries(entries: unknown): readonly string[] {
  if (!Array.isArray(entries)) return ["legacy identity inventory must be an array"]
  const problems: string[] = []
  const paths = new Set<string>()
  const knownCategories = new Set<string>(LEGACY_IDENTITY_CATEGORIES)
  let precedingPath: string | null = null
  for (const [index, value] of entries.entries()) {
    if (!isRecord(value)) {
      problems.push(`inventory entry ${index} must be an object`)
      continue
    }
    const path = typeof value.path === "string" ? value.path : `<entry ${index}>`
    if (typeof value.path !== "string" || value.path.length === 0) {
      problems.push(`inventory entry ${index} has an invalid path`)
    } else {
      if (
        value.path.startsWith("/")
        || value.path.includes("\\")
        || value.path.split("/").includes("..")
      ) problems.push(`${value.path} is not a normalized repository-relative path`)
      if (paths.has(value.path)) problems.push(`duplicate inventory path ${value.path}`)
      paths.add(value.path)
      if (precedingPath !== null && precedingPath.localeCompare(value.path) >= 0) {
        problems.push(`${value.path} is not in strictly sorted path order`)
      }
      precedingPath = value.path
    }

    const categories = value.categories
    if (!Array.isArray(categories)) {
      problems.push(`${path} compatibility categories must be an array`)
    } else {
      if (categories.length === 0) problems.push(`${path} has no compatibility category`)
      if (new Set(categories).size !== categories.length) {
        problems.push(`${path} repeats a compatibility category`)
      }
      if (
        categories.some(category => typeof category !== "string")
        || categories.join("\0") !== [...categories].sort().join("\0")
      ) problems.push(`${path} compatibility categories are not sorted strings`)
      for (const category of categories) {
        if (typeof category === "string" && !knownCategories.has(category)) {
          problems.push(`${path} has unknown compatibility category ${category}`)
        }
      }
      const generatedPath = isGeneratedLegacyIdentityPath(path)
      const generatedCategory = categories.includes("generated")
      if (generatedPath && (categories.length !== 1 || !generatedCategory)) {
        problems.push(`${path} must use only the generated compatibility category`)
      } else if (!generatedPath && generatedCategory) {
        problems.push(`${path} cannot use the generated compatibility category`)
      }
    }
    if (!Number.isSafeInteger(value.identityLineCount) || Number(value.identityLineCount) < 1) {
      problems.push(`${path} has an invalid identity line count`)
    }
    if (!Number.isSafeInteger(value.occurrenceCount) || Number(value.occurrenceCount) < 1) {
      problems.push(`${path} has an invalid identity occurrence count`)
    }
    if (
      Number.isSafeInteger(value.identityLineCount)
      && Number.isSafeInteger(value.occurrenceCount)
      && Number(value.identityLineCount) > Number(value.occurrenceCount)
    ) problems.push(`${path} has more identity lines than occurrences`)
    if (
      typeof value.identityLinesSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.identityLinesSha256)
    ) problems.push(`${path} has an invalid identity line hash`)
  }
  return problems
}

export function isGeneratedLegacyIdentityPath(path: string): boolean {
  return path.startsWith("dist/") || path.startsWith("apps/desktop/dist/")
}

export function planLegacyIdentityInventoryUpdate(
  expected: readonly LegacyIdentityInventoryEntry[],
  actual: readonly LegacyIdentitySnapshot[],
): LegacyIdentityInventoryUpdate {
  const problems: string[] = []
  const entries: LegacyIdentityInventoryEntry[] = []
  const expectedByPath = new Map(expected.map(entry => [entry.path, entry]))
  const actualPaths = new Set(actual.map(entry => entry.path))
  for (const snapshot of actual) {
    const existing = expectedByPath.get(snapshot.path)
    if (isGeneratedLegacyIdentityPath(snapshot.path)) {
      entries.push({
        ...snapshot,
        categories: ["generated"],
      })
      continue
    }
    if (existing === undefined) {
      problems.push(
        `${snapshot.path} needs an explicit reviewed inventory row`,
      )
      continue
    }
    if (
      existing.identityLineCount !== snapshot.identityLineCount
      || existing.identityLinesSha256 !== snapshot.identityLinesSha256
      || existing.occurrenceCount !== snapshot.occurrenceCount
    ) {
      problems.push(
        `${snapshot.path} changed; review and edit its source inventory row explicitly`,
      )
    }
    entries.push(existing)
  }
  for (const entry of expected) {
    if (
      !actualPaths.has(entry.path)
      && !isGeneratedLegacyIdentityPath(entry.path)
    ) {
      problems.push(
        `${entry.path} disappeared; remove its reviewed inventory row explicitly`,
      )
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return {
    entries,
    problems: problems.sort(),
  }
}

export function compareLegacyIdentityInventory(
  expected: readonly LegacyIdentityInventoryEntry[],
  actual: readonly LegacyIdentitySnapshot[],
): readonly string[] {
  const problems: string[] = []
  const expectedByPath = new Map(expected.map(entry => [entry.path, entry]))
  const actualByPath = new Map(actual.map(entry => [entry.path, entry]))
  for (const snapshot of actual) {
    const entry = expectedByPath.get(snapshot.path)
    if (entry === undefined) {
      problems.push(`legacy identity inventory is missing ${snapshot.path}`)
      continue
    }
    if (entry.identityLineCount !== snapshot.identityLineCount) {
      problems.push(
        `${snapshot.path} identity line count changed: expected ${entry.identityLineCount}, received ${snapshot.identityLineCount}`,
      )
    }
    if (entry.occurrenceCount !== snapshot.occurrenceCount) {
      problems.push(
        `${snapshot.path} identity occurrence count changed: expected ${entry.occurrenceCount}, received ${snapshot.occurrenceCount}`,
      )
    }
    if (entry.identityLinesSha256 !== snapshot.identityLinesSha256) {
      problems.push(`${snapshot.path} identity-bearing lines changed`)
    }
  }
  for (const entry of expected) {
    if (!actualByPath.has(entry.path)) {
      problems.push(`legacy identity inventory has surplus ${entry.path}`)
    }
  }
  return problems.sort()
}
