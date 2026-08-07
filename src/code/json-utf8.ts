/**
 * Returns the exact UTF-8 byte length of JSON.stringify(value) without first
 * allocating the serialized string. Undefined means the caller-provided byte
 * ceiling was exceeded.
 */
export function jsonStringUtf8ByteLength(
  value: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return undefined

  let bytes = 2 // Opening and closing quotes.
  if (bytes > maximumBytes) return undefined

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    let additional: number

    if (
      codeUnit === 0x22
      || codeUnit === 0x5c
      || codeUnit === 0x08
      || codeUnit === 0x09
      || codeUnit === 0x0a
      || codeUnit === 0x0c
      || codeUnit === 0x0d
    ) {
      additional = 2
    } else if (codeUnit < 0x20) {
      additional = 6
    } else if (codeUnit < 0x80) {
      additional = 1
    } else if (codeUnit < 0x800) {
      additional = 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        additional = 4
        index += 1
      } else {
        // Well-formed JSON.stringify escapes lone UTF-16 surrogates as \udxxx.
        additional = 6
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      additional = 6
    } else {
      additional = 3
    }

    if (additional > maximumBytes - bytes) return undefined
    bytes += additional
  }

  return bytes
}

/** Exact TextEncoder byte length with an optional allocation-free cutoff. */
export function utf8ByteLength(
  value: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return undefined

  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    let additional: number
    if (codeUnit < 0x80) {
      additional = 1
    } else if (codeUnit < 0x800) {
      additional = 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        additional = 4
        index += 1
      } else {
        // TextEncoder replaces malformed UTF-16 with U+FFFD.
        additional = 3
      }
    } else {
      additional = 3
    }
    if (additional > maximumBytes - bytes) return undefined
    bytes += additional
  }
  return bytes
}
