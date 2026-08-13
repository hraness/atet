function startsWith(
  bytes: Uint8Array,
  ...signature: readonly number[]
): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiWindow(bytes: Uint8Array, maximumBytes = 4_096): string {
  return new TextDecoder("latin1").decode(
    bytes.subarray(0, Math.min(bytes.byteLength, maximumBytes)),
  );
}

function hasIsoBaseMediaHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const maximumOffset = Math.min(bytes.byteLength - 8, 64);
  for (let offset = 4; offset <= maximumOffset; offset += 4) {
    if (
      bytes[offset] === 0x66
      && bytes[offset + 1] === 0x74
      && bytes[offset + 2] === 0x79
      && bytes[offset + 3] === 0x70
    ) {
      return true;
    }
  }
  return false;
}

function hasMpegAudioFrame(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2
    && bytes[0] === 0xff
    && (bytes[1]! & 0xe0) === 0xe0
    && (bytes[1]! & 0x18) !== 0x08;
}

function hasAdtsFrame(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2
    && bytes[0] === 0xff
    && (bytes[1]! & 0xf6) === 0xf0;
}

function hasEbmlHeader(bytes: Uint8Array): boolean {
  return startsWith(bytes, 0x1a, 0x45, 0xdf, 0xa3);
}

/**
 * Performs a bounded container/signature check before bytes cross the Gateway
 * boundary or are persisted as generated media. SVG is deliberately rejected
 * here: local SVG overlays use the stricter overlay asset pipeline, while
 * untrusted generated SVG is active content rather than an inert media blob.
 */
export function gatewayMediaBytesMatchType(
  bytes: Uint8Array,
  mediaTypeInput: string,
): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) return false;
  const mediaType = mediaTypeInput.toLocaleLowerCase("en-US");
  const ascii = asciiWindow(bytes);
  switch (mediaType) {
    case "image/png":
      return startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return startsWith(bytes, 0xff, 0xd8, 0xff);
    case "image/gif":
      return ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a");
    case "image/webp":
      return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
    case "image/avif":
      return hasIsoBaseMediaHeader(bytes)
        && /(?:avif|avis)/u.test(ascii.slice(8, 64));
    case "image/bmp":
      return ascii.startsWith("BM");
    case "image/tiff":
      return startsWith(bytes, 0x49, 0x49, 0x2a, 0x00)
        || startsWith(bytes, 0x4d, 0x4d, 0x00, 0x2a);
    case "image/svg+xml":
      return false;
    case "audio/wav":
    case "audio/x-wav":
      return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE";
    case "audio/aiff":
      return ascii.startsWith("FORM")
        && (ascii.slice(8, 12) === "AIFF" || ascii.slice(8, 12) === "AIFC");
    case "audio/flac":
      return ascii.startsWith("fLaC");
    case "audio/mpeg":
      return ascii.startsWith("ID3") || hasMpegAudioFrame(bytes);
    case "audio/aac":
      return ascii.startsWith("ADIF") || hasAdtsFrame(bytes);
    case "audio/ogg":
      return ascii.startsWith("OggS");
    case "audio/opus":
      return ascii.startsWith("OggS") && ascii.includes("OpusHead");
    case "audio/mp4":
    case "audio/m4a":
      return hasIsoBaseMediaHeader(bytes);
    case "audio/webm":
      return hasEbmlHeader(bytes) && ascii.toLocaleLowerCase("en-US").includes("webm");
    case "audio/l16":
    case "audio/pcm":
      return bytes.byteLength % 2 === 0;
    case "audio/alaw":
    case "audio/basic":
    case "audio/mulaw":
      return true;
    case "video/mp4":
    case "video/quicktime":
      return hasIsoBaseMediaHeader(bytes);
    case "video/webm":
      return hasEbmlHeader(bytes) && ascii.toLocaleLowerCase("en-US").includes("webm");
    case "video/x-matroska":
      return hasEbmlHeader(bytes);
    case "video/x-msvideo":
      return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "AVI ";
    case "video/mpeg":
      return startsWith(bytes, 0x00, 0x00, 0x01, 0xba)
        || startsWith(bytes, 0x00, 0x00, 0x01, 0xb3);
    default:
      return false;
  }
}
