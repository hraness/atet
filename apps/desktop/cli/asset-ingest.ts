import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { OverlayKind } from "./args";
import { EMOJI_GENERATION_COMMAND, type ResolvedEmojiAsset } from "./emoji-assets";
import { CliError } from "./errors";
import { ensurePrivateDirectory } from "./paths";

const MAX_OVERLAY_BYTES = 512 * 1024 * 1024;
const MAX_SVG_BYTES = 32 * 1024 * 1024;
const OVERLAY_COPY_CHUNK_BYTES = 1024 * 1024;
const OVERLAY_SIGNATURE_BYTES = 4_096;
const PUBLICATION_SETTLE_ATTEMPTS = 16;

type ImportedMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/svg+xml"
  | "image/webp"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm";

export interface IngestedAsset {
  readonly bytes: number;
  readonly created: boolean;
  readonly mediaType: ImportedMediaType;
  readonly path: string;
  readonly provenance:
    | {
        readonly kind: "imported";
        readonly originalName: string;
        readonly sourceSha256: string;
      }
    | {
        readonly command: readonly string[];
        readonly generator: string;
        readonly generatorVersion: string;
        readonly kind: "generated";
        readonly sourceSha256: string;
      };
  readonly sha256: string;
}

export interface GeneratedVideoOverlayAssetInput {
  readonly command: readonly string[];
  readonly generator: string;
  readonly generatorVersion: string;
  readonly path: string;
  readonly sourceSha256: string;
}

interface AssetFormat {
  readonly extension: string;
  readonly mediaType: ImportedMediaType;
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, AssetFormat>> = {
  ".gif": { extension: "gif", mediaType: "image/gif" },
  ".jpeg": { extension: "jpg", mediaType: "image/jpeg" },
  ".jpg": { extension: "jpg", mediaType: "image/jpeg" },
  ".mov": { extension: "mov", mediaType: "video/quicktime" },
  ".mp4": { extension: "mp4", mediaType: "video/mp4" },
  ".png": { extension: "png", mediaType: "image/png" },
  ".svg": { extension: "svg", mediaType: "image/svg+xml" },
  ".webm": { extension: "webm", mediaType: "video/webm" },
  ".webp": { extension: "webp", mediaType: "image/webp" },
};

const KIND_MEDIA_TYPES: Readonly<Record<Exclude<OverlayKind, "emoji">, readonly ImportedMediaType[]>> = {
  gif: ["image/gif"],
  image: ["image/jpeg", "image/png", "image/webp"],
  svg: ["image/svg+xml"],
  video: ["video/mp4", "video/quicktime", "video/webm"],
};

const GENERATED_MOV_FORMAT = {
  extension: "mov",
  mediaType: "video/quicktime",
} as const satisfies AssetFormat;

function isWithin(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

function validateSvg(bytes: Uint8Array): boolean {
  if (bytes.length > MAX_SVG_BYTES) return false;
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const start = contents.trimStart();
  if (!/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(start)) return false;
  if (
    /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<\s*(?:script|foreignObject|iframe|object|embed)\b/iu.test(contents)
    || /\s+on[a-z][a-z0-9_-]*\s*=/iu.test(contents)
    || /\bjavascript\s*:/iu.test(contents)
    || /@import\b|expression\s*\(/iu.test(contents)
  ) {
    return false;
  }
  for (const match of contents.matchAll(/\b(?:href|xlink:href|src)\s*=\s*(["'])(.*?)\1/giu)) {
    const target = match[2]?.trim() ?? "";
    if (!target.startsWith("#")) return false;
  }
  for (const match of contents.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/giu)) {
    const target = match[2]?.trim() ?? "";
    if (!target.startsWith("#")) return false;
  }
  return true;
}

export interface OverlayIntrinsicSize {
  readonly height: number;
  readonly width: number;
}

export interface OverlayChunkReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

export interface OverlayChunkWriter {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesWritten: number }>;
}

export interface CopiedOverlaySource {
  readonly bytes: number;
  readonly signature: Buffer;
  readonly sha256: string;
}

export async function copyOverlaySourceChunks(
  reader: OverlayChunkReader,
  writer: OverlayChunkWriter,
  expectedBytes: number,
): Promise<CopiedOverlaySource> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_OVERLAY_BYTES) {
    throw new CliError("invalid-data", `Overlay source must contain 1 through ${MAX_OVERLAY_BYTES} bytes.`);
  }
  const buffer = Buffer.allocUnsafe(Math.min(OVERLAY_COPY_CHUNK_BYTES, expectedBytes));
  const signature = Buffer.allocUnsafe(Math.min(OVERLAY_SIGNATURE_BYTES, expectedBytes));
  const hash = createHash("sha256");
  let position = 0;
  let signatureBytes = 0;
  while (position < expectedBytes) {
    const requested = Math.min(buffer.byteLength, expectedBytes - position);
    const result = await reader.read(buffer, 0, requested, position);
    if (
      !Number.isSafeInteger(result.bytesRead)
      || result.bytesRead <= 0
      || result.bytesRead > requested
    ) {
      throw new CliError("conflict", "Overlay source ended or changed while it was being staged.");
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    if (signatureBytes < signature.byteLength) {
      const copied = Math.min(result.bytesRead, signature.byteLength - signatureBytes);
      buffer.copy(signature, signatureBytes, 0, copied);
      signatureBytes += copied;
    }
    let written = 0;
    while (written < result.bytesRead) {
      const write = await writer.write(
        buffer,
        written,
        result.bytesRead - written,
        position + written,
      );
      if (
        !Number.isSafeInteger(write.bytesWritten)
        || write.bytesWritten <= 0
        || write.bytesWritten > result.bytesRead - written
      ) {
        throw new CliError("invalid-data", "Overlay source could not be staged completely.");
      }
      written += write.bytesWritten;
    }
    position += result.bytesRead;
  }
  return {
    bytes: position,
    signature: signature.subarray(0, signatureBytes),
    sha256: hash.digest("hex"),
  };
}

function svgAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(["'])(?<value>.*?)\1`, "iu").exec(attributes);
  return match?.groups?.value?.trim();
}

function svgLength(value: string | undefined): number | null {
  if (value === undefined || !/^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?(?:px)?$/iu.test(value)) {
    return null;
  }
  const number = Number(value.replace(/px$/iu, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function parseSvgIntrinsicSize(bytes: Uint8Array): OverlayIntrinsicSize {
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError("invalid-data", "SVG overlay is not valid UTF-8.");
  }
  if (!validateSvg(bytes)) throw new CliError("invalid-data", "SVG overlay failed the safe SVG profile.");
  const root = /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b(?<attributes>[^>]*)>/iu.exec(contents.trimStart());
  if (root?.groups?.attributes === undefined) {
    throw new CliError("invalid-data", "SVG overlay omits its root element.");
  }
  const width = svgLength(svgAttribute(root.groups.attributes, "width"));
  const height = svgLength(svgAttribute(root.groups.attributes, "height"));
  const viewBox = svgAttribute(root.groups.attributes, "viewBox")
    ?.split(/[\s,]+/u)
    .filter(Boolean)
    .map(Number);
  const viewBoxWidth = viewBox?.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0
    ? viewBox[2]!
    : null;
  const viewBoxHeight = viewBox?.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3]! > 0
    ? viewBox[3]!
    : null;
  const resolvedWidth = Math.ceil(
    width
    ?? (height !== null && viewBoxWidth !== null && viewBoxHeight !== null
      ? height * viewBoxWidth / viewBoxHeight
      : viewBoxWidth ?? 0),
  );
  const resolvedHeight = Math.ceil(
    height
    ?? (width !== null && viewBoxWidth !== null && viewBoxHeight !== null
      ? width * viewBoxHeight / viewBoxWidth
      : viewBoxHeight ?? 0),
  );
  if (
    resolvedWidth <= 0
    || resolvedHeight <= 0
    || resolvedWidth > 16_384
    || resolvedHeight > 16_384
    || resolvedWidth * resolvedHeight > 134_217_728
  ) {
    throw new CliError(
      "invalid-data",
      "SVG intrinsic dimensions must be declared and remain within 16384 pixels and 128 megapixels.",
    );
  }
  return { height: resolvedHeight, width: resolvedWidth };
}

export async function inspectSvgIntrinsicSize(path: string): Promise<OverlayIntrinsicSize> {
  const { bytes } = await readSourceFully(path, MAX_SVG_BYTES);
  return parseSvgIntrinsicSize(bytes);
}

export async function inspectPngIntrinsicSize(path: string): Promise<OverlayIntrinsicSize> {
  const { bytes } = await readSourcePrefix(path, 24, MAX_OVERLAY_BYTES);
  if (
    bytes.byteLength < 24
    || ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value)
  ) {
    throw new CliError("invalid-data", "SVG derivative is not a complete PNG image.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (
    width <= 0
    || height <= 0
    || width > 16_384
    || height > 16_384
    || width * height > 134_217_728
  ) {
    throw new CliError("invalid-data", "SVG derivative dimensions exceed the render safety limit.");
  }
  return { height, width };
}

function validateSignature(bytes: Uint8Array, mediaType: ImportedMediaType): void {
  const startsWith = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value);
  const ascii = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 4_096))).trimStart();
  const valid = mediaType === "image/png"
    ? startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    : mediaType === "image/jpeg"
      ? startsWith(0xff, 0xd8, 0xff)
      : mediaType === "image/gif"
        ? ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")
        : mediaType === "image/webp"
          ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
          : mediaType === "image/svg+xml"
            ? validateSvg(bytes)
            : mediaType === "video/webm"
              ? startsWith(0x1a, 0x45, 0xdf, 0xa3)
              : mediaType === "video/mp4" || mediaType === "video/quicktime"
                ? ascii.slice(4, 8) === "ftyp"
                : false;
  if (!valid) throw new CliError("invalid-data", `Overlay file bytes do not match ${mediaType}.`);
  if (mediaType === "image/svg+xml") parseSvgIntrinsicSize(bytes);
}

async function safeAssetDirectory(bundleRoot: string): Promise<string> {
  await ensurePrivateDirectory(bundleRoot);
  const realBundleRoot = await realpath(bundleRoot);
  const directory = join(realBundleRoot, "assets");
  let created = false;
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink()) {
      throw new CliError("unsafe-path", `Bundle asset directory is a symlink: ${directory}`);
    }
    if (!details.isDirectory()) {
      throw new CliError("unsafe-path", `Bundle asset directory is not a physical directory: ${directory}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try {
      await mkdir(directory, { mode: 0o700, recursive: false });
      created = true;
    } catch (createError) {
      if (
        !(
          createError instanceof Error
          && "code" in createError
          && createError.code === "EEXIST"
        )
      ) {
        throw createError;
      }
      const raced = await lstat(directory);
      if (raced.isSymbolicLink() || !raced.isDirectory()) {
        throw new CliError(
          "unsafe-path",
          `Bundle asset directory is not a physical directory: ${directory}`,
        );
      }
    }
  }
  const realDirectory = await realpath(directory);
  if (!isWithin(realBundleRoot, realDirectory)) {
    throw new CliError("unsafe-path", "Bundle asset directory resolves outside the recording bundle.");
  }
  if (created) await syncDirectory(realBundleRoot);
  return realDirectory;
}

function samePhysicalFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function physicalFileSnapshot(
  path: string,
  maximumBytes: number,
  label = "Overlay source",
  requireSingleLink = false,
): Promise<{ readonly details: Stats; readonly realPath: string }> {
  const lexicalPath = resolve(path);
  let details;
  try {
    details = await lstat(lexicalPath);
  } catch {
    throw new CliError("not-found", `${label} does not exist: ${path}`);
  }
  if (details.isSymbolicLink()) {
    throw new CliError("unsafe-path", `${label} may not be a symlink: ${path}`);
  }
  if (!details.isFile() || (requireSingleLink && details.nlink !== 1)) {
    throw new CliError("invalid-data", `${label} is not a private physical regular file: ${path}`);
  }
  if (details.size <= 0 || details.size > maximumBytes) {
    throw new CliError("invalid-data", `${label} must contain 1 through ${maximumBytes} bytes.`);
  }
  return { details, realPath: lexicalPath };
}

async function readSourceFully(
  path: string,
  maximumBytes: number,
): Promise<{ readonly bytes: Buffer; readonly realPath: string }> {
  const { details, realPath } = await physicalFileSnapshot(path, maximumBytes);
  const handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !samePhysicalFile(details, before)) {
      throw new CliError("conflict", "Overlay source changed before it was read.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || !samePhysicalFile(before, after)) {
      throw new CliError("conflict", "Overlay source changed while it was being read.");
    }
    return { bytes, realPath };
  } finally {
    await handle.close();
  }
}

async function readSourcePrefix(
  path: string,
  requestedBytes: number,
  maximumBytes: number,
): Promise<{ readonly bytes: Buffer; readonly realPath: string }> {
  const { details, realPath } = await physicalFileSnapshot(path, maximumBytes);
  const handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !samePhysicalFile(details, before)) {
      throw new CliError("conflict", "Overlay source changed before it was inspected.");
    }
    const length = Math.min(requestedBytes, before.size);
    const bytes = Buffer.allocUnsafe(length);
    let position = 0;
    while (position < length) {
      const result = await handle.read(bytes, position, length - position, position);
      if (result.bytesRead <= 0 || result.bytesRead > length - position) {
        throw new CliError("conflict", "Overlay source ended while its signature was being inspected.");
      }
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (!samePhysicalFile(before, after)) {
      throw new CliError("conflict", "Overlay source changed while it was being inspected.");
    }
    return { bytes, realPath };
  } finally {
    await handle.close();
  }
}

async function fingerprintPhysicalFile(
  path: string,
  maximumBytes: number,
  label: string,
  requireSingleLink = false,
): Promise<CopiedOverlaySource> {
  const { details, realPath } = await physicalFileSnapshot(path, maximumBytes, label, requireSingleLink);
  const handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || (requireSingleLink && before.nlink !== 1)
      || !samePhysicalFile(details, before)
    ) {
      throw new CliError("conflict", `${label} changed before it was verified.`);
    }
    const fingerprint = await copyOverlaySourceChunks(handle, {
      write: (_buffer, _offset, length) => Promise.resolve({ bytesWritten: length }),
    }, before.size);
    const after = await handle.stat();
    if ((requireSingleLink && after.nlink !== 1) || !samePhysicalFile(before, after)) {
      throw new CliError("conflict", `${label} changed while it was verified.`);
    }
    return fingerprint;
  } finally {
    await handle.close();
  }
}

async function awaitSingleLink(path: string): Promise<void> {
  for (let attempt = 0; attempt < PUBLICATION_SETTLE_ATTEMPTS; attempt += 1) {
    if ((await lstat(path)).nlink === 1) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 0));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new CliError("unsafe-path", `Asset durability path is not a physical directory: ${path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishStagedAsset(
  directory: string,
  temporary: string,
  extension: string,
  fingerprint: Pick<CopiedOverlaySource, "bytes" | "sha256">,
): Promise<{ readonly created: boolean; readonly path: string }> {
  const relativePath = `assets/${fingerprint.sha256}.${extension}`;
  const destination = join(directory, `${fingerprint.sha256}.${extension}`);
  if (!isWithin(directory, destination)) throw new CliError("unsafe-path", "Asset destination escaped its directory.");
  let created = false;
  try {
    await link(temporary, destination);
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    await awaitSingleLink(destination);
    const existing = await fingerprintPhysicalFile(
      destination,
      MAX_OVERLAY_BYTES,
      "Content-addressed overlay",
      true,
    );
    if (existing.sha256 !== fingerprint.sha256 || existing.bytes !== fingerprint.bytes) {
      throw new CliError("conflict", `Content-addressed overlay collision at ${relativePath}.`);
    }
  }
  await rm(temporary);
  await syncDirectory(directory);
  return { created, path: relativePath };
}

async function materializeBytes(
  bundleRoot: string,
  bytes: Uint8Array,
  extension: string,
  sha256: string,
): Promise<{ readonly created: boolean; readonly path: string }> {
  const directory = await safeAssetDirectory(bundleRoot);
  const temporary = join(directory, `.asset-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    return await publishStagedAsset(directory, temporary, extension, { bytes: bytes.byteLength, sha256 });
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

async function materializeStreamedSource(
  bundleRoot: string,
  sourcePath: string,
  format: AssetFormat,
  expected?: {
    readonly mismatchMessage: string;
    readonly sha256: string;
  },
): Promise<CopiedOverlaySource & { readonly created: boolean; readonly path: string; readonly realPath: string }> {
  const { details, realPath } = await physicalFileSnapshot(sourcePath, MAX_OVERLAY_BYTES);
  const directory = await safeAssetDirectory(bundleRoot);
  const temporary = join(directory, `.asset-${randomUUID()}.tmp`);
  const source = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const staged = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  ).catch(async (error: unknown) => {
    await source.close();
    throw error;
  });
  try {
    const opened = await source.stat();
    if (!opened.isFile() || !samePhysicalFile(details, opened)) {
      throw new CliError("conflict", "Overlay source changed before it was staged.");
    }
    const copied = await copyOverlaySourceChunks(source, staged, opened.size);
    const after = await source.stat();
    if (copied.bytes !== opened.size || !samePhysicalFile(opened, after)) {
      throw new CliError("conflict", "Overlay source changed while it was being staged.");
    }
    validateSignature(copied.signature, format.mediaType);
    if (expected !== undefined && copied.sha256 !== expected.sha256) {
      throw new CliError("invalid-data", expected.mismatchMessage);
    }
    const stagedDetails = await staged.stat();
    if (!stagedDetails.isFile() || stagedDetails.size !== copied.bytes || stagedDetails.nlink !== 1) {
      throw new CliError("conflict", "Staged overlay output changed before publication.");
    }
    await staged.sync();
    const materialized = await publishStagedAsset(
      directory,
      temporary,
      format.extension,
      copied,
    );
    return { ...copied, ...materialized, realPath };
  } finally {
    await Promise.all([source.close(), staged.close()]);
    await rm(temporary, { force: true });
  }
}

export async function ingestOverlayAsset(
  bundleRoot: string,
  sourcePath: string,
  kind: Exclude<OverlayKind, "emoji">,
): Promise<IngestedAsset> {
  const realPath = resolve(sourcePath);
  const format = FORMAT_BY_EXTENSION[extname(realPath).toLocaleLowerCase()];
  if (format === undefined || !KIND_MEDIA_TYPES[kind].includes(format.mediaType)) {
    throw new CliError("invalid-data", `A ${kind} overlay does not accept ${extname(realPath) || "an extensionless file"}.`);
  }
  if (format.mediaType !== "image/svg+xml") {
    const materialized = await materializeStreamedSource(bundleRoot, sourcePath, format);
    return {
      bytes: materialized.bytes,
      created: materialized.created,
      mediaType: format.mediaType,
      path: materialized.path,
      provenance: {
        kind: "imported",
        originalName: basename(materialized.realPath),
        sourceSha256: materialized.sha256,
      },
      sha256: materialized.sha256,
    };
  }
  const { bytes } = await readSourceFully(sourcePath, MAX_SVG_BYTES);
  validateSignature(bytes, format.mediaType);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const materialized = await materializeBytes(bundleRoot, bytes, format.extension, sha256);
  return {
    bytes: bytes.length,
    created: materialized.created,
    mediaType: format.mediaType,
    path: materialized.path,
    provenance: {
      kind: "imported",
      originalName: basename(realPath),
      sourceSha256: sha256,
    },
    sha256,
  };
}

function validateGeneratedVideoOverlayInput(input: GeneratedVideoOverlayAssetInput): void {
  if (input.generator.length === 0 || input.generator.length > 256) {
    throw new CliError("invalid-data", "Generated overlay generator must contain 1 through 256 characters.");
  }
  if (input.generatorVersion.length === 0 || input.generatorVersion.length > 128) {
    throw new CliError(
      "invalid-data",
      "Generated overlay generator version must contain 1 through 128 characters.",
    );
  }
  if (input.command.length === 0 || input.command.some(part => part.length === 0)) {
    throw new CliError("invalid-data", "Generated overlay command must contain at least one non-empty argument.");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.sourceSha256)) {
    throw new CliError("invalid-data", "Generated overlay source SHA-256 must be 64 lowercase hexadecimal characters.");
  }
}

export async function ingestGeneratedVideoOverlayAsset(
  bundleRoot: string,
  input: GeneratedVideoOverlayAssetInput,
): Promise<IngestedAsset> {
  validateGeneratedVideoOverlayInput(input);
  const sourcePath = input.path;
  if (extname(resolve(sourcePath)).toLowerCase() !== ".mov") {
    throw new CliError("invalid-data", "A generated video overlay must be a .mov file.");
  }
  const provenance = {
    command: [...input.command],
    generator: input.generator,
    generatorVersion: input.generatorVersion,
    kind: "generated" as const,
    sourceSha256: input.sourceSha256,
  };
  const materialized = await materializeStreamedSource(
    bundleRoot,
    sourcePath,
    GENERATED_MOV_FORMAT,
    {
      mismatchMessage: "Generated overlay source SHA-256 does not match the rendered MOV bytes.",
      sha256: input.sourceSha256,
    },
  );
  return {
    bytes: materialized.bytes,
    created: materialized.created,
    mediaType: GENERATED_MOV_FORMAT.mediaType,
    path: materialized.path,
    provenance,
    sha256: materialized.sha256,
  };
}

export async function ingestEmojiAsset(
  bundleRoot: string,
  resolved: ResolvedEmojiAsset,
): Promise<IngestedAsset> {
  const mediaType = extname(resolved.path).toLocaleLowerCase() === ".png"
    ? "image/png" as const
    : "image/svg+xml" as const;
  const extension = mediaType === "image/png" ? "png" : "svg";
  const streamed = mediaType === "image/png"
    ? await materializeStreamedSource(bundleRoot, resolved.path, { extension, mediaType }, {
        mismatchMessage: `Resolved emoji asset ${resolved.id} changed before ingestion.`,
        sha256: resolved.sha256,
      })
    : null;
  const svg = streamed === null
    ? await readSourceFully(resolved.path, MAX_SVG_BYTES)
    : null;
  if (svg !== null) validateSignature(svg.bytes, mediaType);
  const actualSha256 = streamed?.sha256 ?? createHash("sha256").update(svg!.bytes).digest("hex");
  if (actualSha256 !== resolved.sha256) {
    throw new CliError("invalid-data", `Resolved emoji asset ${resolved.id} changed before ingestion.`);
  }
  const materialized = streamed ?? await materializeBytes(bundleRoot, svg!.bytes, extension, actualSha256);
  return {
    bytes: streamed?.bytes ?? svg!.bytes.length,
    created: materialized.created,
    mediaType,
    path: materialized.path,
    provenance: {
      command: resolved.provider === "apple-emoji-pack"
        ? EMOJI_GENERATION_COMMAND.split(" ")
        : ["bun", "run", "brand-icons:generate"],
      generator: resolved.provider,
      generatorVersion: "1",
      kind: "generated",
      sourceSha256: actualSha256,
    },
    sha256: actualSha256,
  };
}
