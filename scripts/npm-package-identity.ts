import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const tarBlockBytes = 512;
const packagePrefix = "package/";
const maximumArchiveBytes = 3_750_000;
const maximumTarBytes = 12_000_000;

interface NpmPackFile {
  readonly mode: number;
  readonly path: string;
  readonly size: number;
}

interface NpmPackResult {
  readonly bundled: readonly never[];
  readonly entryCount: number;
  readonly files: readonly NpmPackFile[];
  readonly filename: string;
  readonly integrity: string;
  readonly name: string;
  readonly shasum: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly version: string;
}

interface CanonicalTarEntry {
  readonly mode: number;
  readonly path: string;
  readonly sha256?: string;
  readonly sha512?: string;
  readonly size: number;
  readonly type: "directory" | "file";
}

interface VerifiedArchive {
  readonly entries: readonly CanonicalTarEntry[];
  readonly metadata: NpmPackResult;
}

export interface NpmPackageIdentityInput {
  readonly expectedFilename: string;
  readonly expectedName: string;
  readonly expectedVersion: string;
  readonly registryArchive: string;
  readonly registryMetadata: string;
  readonly registryView: string;
  readonly sourceArchive: string;
  readonly sourceMetadata: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
  return Number(value);
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function parsePackMetadata(value: unknown, label: string): NpmPackResult {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${label} must contain exactly one npm pack result.`);
  }
  const result = record(value[0], `${label} result`);
  const entryCount = nonnegativeInteger(result.entryCount, `${label} entryCount`);
  const size = nonnegativeInteger(result.size, `${label} size`);
  const unpackedSize = nonnegativeInteger(result.unpackedSize, `${label} unpackedSize`);
  const filename = nonemptyString(result.filename, `${label} filename`);
  const integrity = nonemptyString(result.integrity, `${label} integrity`);
  const name = nonemptyString(result.name, `${label} name`);
  const shasum = nonemptyString(result.shasum, `${label} shasum`);
  const version = nonemptyString(result.version, `${label} version`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    throw new Error(`${label} integrity must be a SHA-512 SRI value.`);
  }
  if (!/^[a-f0-9]{40}$/u.test(shasum)) {
    throw new Error(`${label} shasum must be a lowercase SHA-1 digest.`);
  }
  if (!Array.isArray(result.files) || result.files.length !== entryCount) {
    throw new Error(`${label} files must match entryCount.`);
  }
  if (!Array.isArray(result.bundled) || result.bundled.length !== 0) {
    throw new Error(`${label} bundled dependencies must be an empty array.`);
  }
  const files: NpmPackFile[] = [];
  const seen = new Set<string>();
  for (const [index, value] of result.files.entries()) {
    const file = record(value, `${label} file ${String(index + 1)}`);
    const path = safeRelativePath(
      nonemptyString(file.path, `${label} file ${String(index + 1)} path`),
      `${label} file ${String(index + 1)} path`,
    );
    if (seen.has(path)) throw new Error(`${label} contains duplicate path ${path}.`);
    seen.add(path);
    files.push({
      mode: nonnegativeInteger(file.mode, `${label} file ${path} mode`),
      path,
      size: nonnegativeInteger(file.size, `${label} file ${path} size`),
    });
  }
  return {
    bundled: [],
    entryCount,
    filename,
    files: files.toSorted(comparePaths),
    integrity,
    name,
    shasum,
    size,
    unpackedSize,
    version,
  };
}

function safeRelativePath(path: string, label: string): string {
  if (
    path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split("/").some(part => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`${label} is unsafe: ${path}`);
  }
  return path;
}

function readTarString(
  block: Buffer,
  start: number,
  length: number,
  label: string,
): string {
  const end = block.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      block.subarray(start, boundedEnd),
    );
  } catch {
    throw new Error(`npm package tar ${label} is not valid UTF-8.`);
  }
}

function readTarOctal(
  block: Buffer,
  start: number,
  length: number,
  label: string,
): number {
  const value = readTarString(block, start, length, label).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`npm package tar ${label} is not an octal integer.`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`npm package tar ${label} is outside the safe integer range.`);
  }
  return parsed;
}

function verifyTarHeaderChecksum(block: Buffer, offset: number): void {
  const expected = readTarOctal(
    block,
    148,
    8,
    `header checksum at byte ${String(offset)}`,
  );
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : block[index] ?? 0;
  }
  if (actual !== expected) {
    throw new Error(
      `npm package tar header checksum at byte ${String(offset)} is ${String(actual)}, expected ${String(expected)}.`,
    );
  }
}

function comparePaths(
  left: Readonly<{ readonly path: string }>,
  right: Readonly<{ readonly path: string }>,
): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function canonicalPackagePath(path: string, directory: boolean): string {
  if (!path.startsWith(packagePrefix) || path.includes("\\")) {
    throw new Error(`npm package tar entry is outside ${packagePrefix}: ${path}`);
  }
  const withoutTrailingSlash = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  const relative = safeRelativePath(
    withoutTrailingSlash.slice(packagePrefix.length),
    "npm package tar path",
  );
  const canonical = `${packagePrefix}${relative}${directory ? "/" : ""}`;
  if (canonical !== path) {
    throw new Error(`npm package tar path is not canonical: ${path}`);
  }
  return canonical;
}

function canonicalTarEntries(compressed: Buffer, label: string): readonly CanonicalTarEntry[] {
  if (compressed.length === 0 || compressed.length > maximumArchiveBytes) {
    throw new Error(
      `${label} archive size ${String(compressed.length)} is outside 1-${String(maximumArchiveBytes)} bytes.`,
    );
  }
  const tar = gunzipSync(compressed, { maxOutputLength: maximumTarBytes });
  if (tar.length === 0 || tar.length % tarBlockBytes !== 0) {
    throw new Error(`${label} decompressed tar has an invalid block length.`);
  }

  const entries: CanonicalTarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let terminated = false;
  while (offset + tarBlockBytes <= tar.length) {
    const header = tar.subarray(offset, offset + tarBlockBytes);
    if (header.every(byte => byte === 0)) {
      if (
        offset + 2 * tarBlockBytes > tar.length
        || !tar.subarray(offset + tarBlockBytes, offset + 2 * tarBlockBytes)
          .every(byte => byte === 0)
      ) {
        throw new Error(`${label} tar must end with at least two zero blocks.`);
      }
      if (!tar.subarray(offset).every(byte => byte === 0)) {
        throw new Error(`${label} tar contains data after its zero terminator.`);
      }
      terminated = true;
      break;
    }
    verifyTarHeaderChecksum(header, offset);

    const name = readTarString(header, 0, 100, `name at byte ${String(offset)}`);
    const prefix = readTarString(header, 345, 155, `prefix at byte ${String(offset)}`);
    const rawPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const typeByte = header[156] ?? 0;
    const type = String.fromCharCode(typeByte);
    const directory = type === "5";
    if (!(typeByte === 0 || type === "0" || directory)) {
      const kind = type === "1" ? "hard link" : type === "2" ? "symbolic link" : JSON.stringify(type);
      throw new Error(`${label} tar contains unsupported ${kind} entry ${rawPath}.`);
    }
    const path = canonicalPackagePath(rawPath, directory);
    const collisionKey = directory ? path.slice(0, -1) : path;
    if (seen.has(collisionKey)) {
      throw new Error(`${label} tar contains a duplicate file-directory path ${path}.`);
    }
    seen.add(collisionKey);
    const mode = readTarOctal(header, 100, 8, `mode for ${path}`) & 0o7777;
    if (directory ? mode !== 0o755 : mode !== 0o644 && mode !== 0o755) {
      throw new Error(`${label} tar entry ${path} has unsupported mode ${mode.toString(8)}.`);
    }
    const size = readTarOctal(header, 124, 12, `size for ${path}`);
    if (directory && size !== 0) {
      throw new Error(`${label} tar directory ${path} has a nonzero body.`);
    }
    const bodyStart = offset + tarBlockBytes;
    const nextOffset = bodyStart + Math.ceil(size / tarBlockBytes) * tarBlockBytes;
    if (nextOffset > tar.length) {
      throw new Error(`${label} tar entry ${path} exceeds the archive.`);
    }
    if (directory) {
      entries.push({ mode, path, size, type: "directory" });
    } else {
      const body = tar.subarray(bodyStart, bodyStart + size);
      entries.push({
        mode,
        path,
        sha256: createHash("sha256").update(body).digest("hex"),
        sha512: createHash("sha512").update(body).digest("hex"),
        size,
        type: "file",
      });
    }
    offset = nextOffset;
  }
  if (!terminated) throw new Error(`${label} tar has no zero terminator.`);
  return entries.toSorted(comparePaths);
}

function canonicalMetadataFiles(entries: readonly CanonicalTarEntry[]): readonly NpmPackFile[] {
  return entries
    .filter((entry): entry is CanonicalTarEntry & { readonly type: "file" } => entry.type === "file")
    .map(entry => ({
      mode: entry.mode,
      path: entry.path.slice(packagePrefix.length),
      size: entry.size,
    }))
    .toSorted(comparePaths);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function verifyArchive(
  archivePath: string,
  metadataPath: string,
  label: string,
  expectedName: string,
  expectedVersion: string,
  expectedFilename: string,
): Promise<VerifiedArchive> {
  const [archive, metadataValue] = await Promise.all([
    readFile(archivePath),
    readFile(metadataPath, "utf8").then(text => JSON.parse(text) as unknown),
  ]);
  const metadata = parsePackMetadata(metadataValue, `${label} npm pack metadata`);
  if (
    metadata.name !== expectedName
    || metadata.version !== expectedVersion
    || metadata.filename !== expectedFilename
    || basename(archivePath) !== expectedFilename
  ) {
    throw new Error(`${label} npm package identity differs from ${expectedName}@${expectedVersion}.`);
  }
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const shasum = createHash("sha1").update(archive).digest("hex");
  if (
    metadata.size !== archive.length
    || metadata.integrity !== integrity
    || metadata.shasum !== shasum
  ) {
    throw new Error(`${label} npm metadata does not identify its exact archive bytes.`);
  }
  const entries = canonicalTarEntries(archive, label);
  const files = canonicalMetadataFiles(entries);
  const unpackedSize = files.reduce((total, file) => total + file.size, 0);
  if (
    metadata.entryCount !== files.length
    || metadata.unpackedSize !== unpackedSize
    || json(metadata.files) !== json(files)
  ) {
    throw new Error(`${label} npm metadata differs from its canonical tar inventory.`);
  }
  return { entries, metadata };
}

function firstEntryDifference(
  source: readonly CanonicalTarEntry[],
  registry: readonly CanonicalTarEntry[],
): string | undefined {
  const maximum = Math.max(source.length, registry.length);
  for (let index = 0; index < maximum; index += 1) {
    if (json(source[index]) !== json(registry[index])) {
      return source[index]?.path ?? registry[index]?.path ?? `entry ${String(index + 1)}`;
    }
  }
  return undefined;
}

async function verifyRegistryView(
  registryViewPath: string,
  archive: VerifiedArchive,
  expectedName: string,
  expectedVersion: string,
): Promise<void> {
  const view = record(
    JSON.parse(await readFile(registryViewPath, "utf8")) as unknown,
    "canonical npm registry view",
  );
  const dist = record(view.dist, "canonical npm registry dist");
  const leafName = expectedName.slice(expectedName.lastIndexOf("/") + 1);
  const expectedTarball = `https://registry.npmjs.org/${expectedName}/-/${leafName}-${expectedVersion}.tgz`;
  if (view.name !== expectedName || view.version !== expectedVersion) {
    throw new Error(`Canonical npm registry identity differs from ${expectedName}@${expectedVersion}.`);
  }
  if (
    dist.integrity !== archive.metadata.integrity
    || dist.shasum !== archive.metadata.shasum
    || dist.tarball !== expectedTarball
    || dist.fileCount !== archive.metadata.entryCount
    || dist.unpackedSize !== archive.metadata.unpackedSize
  ) {
    throw new Error("Canonical npm registry dist metadata differs from the downloaded registry archive.");
  }
}

export async function verifyNpmPackageIdentity(
  input: NpmPackageIdentityInput,
): Promise<void> {
  const [source, registry] = await Promise.all([
    verifyArchive(
      input.sourceArchive,
      input.sourceMetadata,
      "source",
      input.expectedName,
      input.expectedVersion,
      input.expectedFilename,
    ),
    verifyArchive(
      input.registryArchive,
      input.registryMetadata,
      "registry",
      input.expectedName,
      input.expectedVersion,
      input.expectedFilename,
    ),
  ]);
  for (const field of ["entryCount", "filename", "name", "unpackedSize", "version"] as const) {
    if (source.metadata[field] !== registry.metadata[field]) {
      throw new Error(`Published npm ${field} differs from the checked source package.`);
    }
  }
  if (json(source.metadata.files) !== json(registry.metadata.files)) {
    throw new Error("Published npm metadata inventory differs from the checked source package.");
  }
  const difference = firstEntryDifference(source.entries, registry.entries);
  if (difference !== undefined) {
    throw new Error(`Published npm package contents differ at ${difference}.`);
  }
  await verifyRegistryView(
    input.registryView,
    registry,
    input.expectedName,
    input.expectedVersion,
  );
  console.log(
    `Verified canonical npm package identity across ${String(source.metadata.entryCount)} files and ${String(source.metadata.unpackedSize)} unpacked bytes.`,
  );
}

if (import.meta.main) {
  const [
    sourceMetadata,
    sourceArchive,
    registryMetadata,
    registryArchive,
    registryView,
    expectedName,
    expectedVersion,
    expectedFilename,
    ...extra
  ] = process.argv.slice(2);
  if (
    extra.length > 0
    || sourceMetadata === undefined
    || sourceArchive === undefined
    || registryMetadata === undefined
    || registryArchive === undefined
    || registryView === undefined
    || expectedName === undefined
    || expectedVersion === undefined
    || expectedFilename === undefined
  ) {
    throw new Error(
      "Usage: bun scripts/npm-package-identity.ts <source-pack.json> <source.tgz> <registry-pack.json> <registry.tgz> <registry-view.json> <name> <version> <filename>",
    );
  }
  await verifyNpmPackageIdentity({
    expectedFilename,
    expectedName,
    expectedVersion,
    registryArchive,
    registryMetadata,
    registryView,
    sourceArchive,
    sourceMetadata,
  });
}
