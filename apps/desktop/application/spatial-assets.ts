import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { z } from "zod";

import { createBoundedJsonSnapshot } from "../../../src/code/json-snapshot";
import { parseDiagramSpec } from "../../../src/parse";
import { renderSvg } from "../../../src/render";
import { builtInIcons } from "../../../src/icons";
import {
  EvaluatedSpatialSceneSchema, type EvaluatedSpatialScene, type SpatialAssetManifest, type SpatialEntity,
} from "../../../src/spatial-scene/contracts";
import { spatialAssetClosureDigests } from "../../../src/spatial-scene/identity";
import { evaluateSpatialGlb, parseSpatialGlb, type SpatialGlbModel } from "../../../src/spatial-scene/gltf";
import { canonicalJsonSha256 } from "../core/canonical-json";
import { SpatialWorldImportManifestSchema, SPATIAL_SPLAT_LIMITS } from "../contracts/spatial-world";
import { inspectSpatialSpz } from "./spatial-spz";
import { WorldLabsProvenanceSchema } from "./world-labs-port";
import {
  PreparedSpatialAssetSchema, SPATIAL_OVERLAY_LIMITS, SpatialOverlayCapabilityError, spatialTextRasterContentSha256,
  spatialGeometryContentSha256, spatialVideoRasterContentSha256,
  type PreparedSpatialAsset,
} from "../html-overlay/spatial";
import type { ApplicationProcessRunner } from "./context";
import type { BoundHtmlOverlayResource } from "./html-overlay-renderer";

export const SPATIAL_ASSET_PREPARATION_LIMITS = Object.freeze({
  sourceBytes: 256 * 1024 * 1024,
  outputBytes: 256 * 1024 * 1024,
  rasterPixels: 33_554_432,
  dimension: 8_192,
  fontBytes: 16 * 1024 * 1024,
  svgBytes: 1_048_576,
  probeBytes: 8 * 1024 * 1024,
  videoFrames: 216_000,
  nativeTimeoutMs: 120_000,
});

export interface SpatialVerifiedAsset {
  readonly manifest: SpatialAssetManifest;
  readonly manifestSha256: string;
  /** Verified immutable in-memory copy. Native decoders receive its private snapshot path. */
  readonly bytes: Uint8Array;
}
export interface SpatialGeometryPreparationRequest {
  readonly asset: SpatialVerifiedAsset;
  readonly dependencies: readonly SpatialVerifiedAsset[];
  readonly entity: Extract<SpatialEntity, { kind: "mesh" }>;
  readonly timeUs: number;
}
export interface SpatialGeometryPreparationResult {
  readonly geometry: Extract<PreparedSpatialAsset, { kind: "geometry" }>;
  /** Exact resource names referenced by geometry textures; bytes are independently decoded below. */
  readonly images: readonly { readonly resourceName: string; readonly bytes: Uint8Array; readonly opaque: boolean }[];
  readonly profile: string;
}
export interface SpatialAssetPreparationPorts {
  readonly runner: ApplicationProcessRunner;
  readonly ffmpegCommand?: string;
  readonly ffprobeCommand?: string;
  readonly prepareGeometry?: (request: SpatialGeometryPreparationRequest, signal: AbortSignal) => Promise<SpatialGeometryPreparationResult>;
}
export interface SpatialAssetPreparationInput {
  readonly snapshots: readonly EvaluatedSpatialScene[];
  readonly exactSceneTimesUs?: readonly { readonly numerator: string; readonly denominator: string }[];
  /** Adapter-owned contained source root and private temporary workspace parent. */
  readonly assetRoot: string;
  readonly workspaceParent: string;
}
export interface PreparedSpatialAssets {
  readonly preparedAssets: readonly PreparedSpatialAsset[];
  readonly resources: readonly BoundHtmlOverlayResource[];
  /** Private verified source copies, valid only while the consumer callback is active. */
  readonly sources: readonly { readonly manifest: SpatialAssetManifest; readonly manifestSha256: string; readonly absolutePath: string }[];
  readonly receipt: Readonly<{
    readonly kind: "atet.spatial-asset-preparation";
    readonly schemaVersion: 1;
    readonly sourceManifests: Readonly<Record<string, string>>;
    readonly preparedSha256: string;
    readonly sourceBytes: number;
    readonly outputBytes: number;
    readonly profiles: readonly string[];
  }>;
}

const inputSchema = z.strictObject({
  snapshots: z.array(EvaluatedSpatialSceneSchema).min(1).max(SPATIAL_OVERLAY_LIMITS.frames),
  exactSceneTimesUs: z.array(z.strictObject({ numerator: z.string().regex(/^(?:0|[1-9]\d{0,23})$/u), denominator: z.string().regex(/^[1-9]\d{0,8}$/u) })).min(1).max(SPATIAL_OVERLAY_LIMITS.frames).optional(),
  assetRoot: z.string().min(1).max(4_096), workspaceParent: z.string().min(1).max(4_096),
});
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function capability(name: string, message: string): never { throw new SpatialOverlayCapabilityError(name, message); }
function aborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Spatial asset preparation was cancelled."); }
function utf8(bytes: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
function xml(text: string): string { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

async function physicalRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new RangeError("Spatial asset roots must be absolute adapter-owned paths.");
  const resolved = await realpath(path);
  if (resolved !== path || !(await lstat(path)).isDirectory()) throw new RangeError("Spatial asset roots must be physical directories without symlinks.");
  return resolved;
}

async function readVerifiedAsset(root: string, manifest: SpatialAssetManifest, signal: AbortSignal): Promise<Uint8Array> {
  const path = join(root, manifest.payload.path);
  if (relative(root, path).startsWith(`..${sep}`) || relative(root, path) === "..") throw new RangeError("Asset escaped its source root.");
  const chain: { path: string; dev: number; ino: number }[] = [];
  let current = root;
  for (const part of ["", ...manifest.payload.path.split("/").slice(0, -1)]) {
    if (part !== "") current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RangeError("Asset parent directories must be physical.");
    chain.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    aborted(signal);
    const before = await handle.stat();
    if (!before.isFile() || before.size !== manifest.payload.bytes) throw new RangeError("Asset payload size or file kind differs from its immutable manifest.");
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      aborted(signal);
      const result = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (result.bytesRead === 0) throw new RangeError("Asset changed during snapshot capture.");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || await realpath(path) !== path || digest(bytes) !== manifest.payload.sha256) throw new RangeError("Asset changed or does not match its immutable payload digest.");
    for (const parent of chain) {
      const stat = await lstat(parent.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parent.dev || stat.ino !== parent.ino) throw new RangeError("Asset directory identity changed during capture.");
    }
    return bytes;
  } finally { await handle.close(); }
}

/** Shape-only SVG is rebuilt from an explicit vocabulary before native decoding. */
export function inertSpatialSvg(source: string): string {
  if (new TextEncoder().encode(source).length > SPATIAL_ASSET_PREPARATION_LIMITS.svgBytes || /[&\u0000]|<!|<\?/u.test(source)) {
    capability("inert-svg", "SVG must be bounded shape-only markup without entities, declarations, or processing instructions.");
  }
  const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
  const numbers = new Set(["width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "stroke-width", "stroke-miterlimit", "opacity", "fill-opacity", "stroke-opacity"]);
  const stack: string[] = [];
  let index = 0, count = 0, roots = 0;
  const output: string[] = [];
  const tokens = /<[^>]*>/gu;
  for (const match of source.matchAll(tokens)) {
    if (source.slice(index, match.index).trim() !== "") capability("inert-svg", "SVG text content requires a declared-font adapter.");
    index = match.index + match[0].length;
    if (++count > 20_000) throw new RangeError("SVG exceeds the element budget.");
    const token = /^<(\/?)([A-Za-z]+)([\s\S]*?)(\/?)>$/u.exec(match[0]);
    if (token === null || !tags.has(token[2]!)) capability("inert-svg", "SVG contains an unsupported element.");
    const closing = token[1] === "/", name = token[2]!, tail = token[3]!, selfClosing = token[4] === "/";
    if (closing) {
      if (tail.trim() !== "" || selfClosing || stack.pop() !== name) throw new RangeError("SVG has mismatched closing elements.");
      output.push(`</${name}>`); continue;
    }
    if (stack.length === 0 && (name !== "svg" || ++roots > 1)) throw new RangeError("SVG requires exactly one root element.");
    if (stack.length >= 32 || (name === "svg" && stack.length !== 0)) throw new RangeError("Nested SVG or excessive nesting is unsupported.");
    const attributes: string[] = [], seen = new Set<string>();
    let consumed = 0;
    for (const attribute of tail.matchAll(/\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      if (tail.slice(consumed, attribute.index).trim() !== "") throw new RangeError("SVG attributes must be explicitly quoted.");
      consumed = attribute.index + attribute[0].length;
      const key = attribute[1]!, value = attribute[2] ?? attribute[3]!;
      if (seen.has(key) || /[<>]/u.test(value) || value.length > 100_000) throw new RangeError("SVG attributes must be unique and bounded.");
      seen.add(key);
      let allowed = false;
      if (numbers.has(key)) allowed = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u.test(value) && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1e6;
      else if (key === "xmlns") allowed = name === "svg" && value === "http://www.w3.org/2000/svg";
      else if (key === "viewBox") allowed = /^[-+0-9.eE,\s]+$/u.test(value) && value.trim().split(/[\s,]+/u).length === 4 && value.trim().split(/[\s,]+/u).every(part => Number.isFinite(Number(part)) && Math.abs(Number(part)) <= 1e6);
      else if (key === "d") allowed = name === "path" && /^[MmZzLlHhVvCcSsQqTtAa0-9eE+,.\s-]+$/u.test(value);
      else if (key === "points") allowed = /^[0-9eE+,.\s-]+$/u.test(value);
      else if (key === "transform") allowed = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([-+0-9.eE,\s]+\)\s*)+$/u.test(value);
      else if (key === "fill" || key === "stroke") allowed = /^(?:none|#[a-fA-F0-9]{3}|#[a-fA-F0-9]{6}|#[a-fA-F0-9]{8})$/u.test(value);
      else if (key === "fill-rule") allowed = value === "evenodd" || value === "nonzero";
      else if (key === "stroke-linecap") allowed = ["butt", "round", "square"].includes(value);
      else if (key === "stroke-linejoin") allowed = ["miter", "round", "bevel"].includes(value);
      if (allowed && (numbers.has(key) || key === "viewBox" || key === "d" || key === "points" || key === "transform")) {
        for (const numeric of value.matchAll(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/gu)) {
          if (!Number.isFinite(Number(numeric[0])) || Math.abs(Number(numeric[0])) > 1e6) allowed = false;
        }
      }
      if (!allowed) capability("inert-svg", `SVG attribute ${key} is outside the shape-only profile.`);
      attributes.push(`${key}="${value}"`);
    }
    if (tail.slice(consumed).trim() !== "") throw new RangeError("SVG has unparsed attribute content.");
    output.push(`<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}${selfClosing ? "/" : ""}>`);
    if (!selfClosing) stack.push(name);
  }
  if (source.slice(index).trim() !== "" || stack.length !== 0 || roots !== 1) throw new RangeError("SVG is incomplete or has non-element content.");
  return output.join("");
}

function dimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8_192 || height > 8_192 || width * height > SPATIAL_ASSET_PREPARATION_LIMITS.rasterPixels) {
    throw new RangeError("Prepared raster exceeds its dimension or pixel budget.");
  }
}
async function raster(bytes: Uint8Array, opaque = false): Promise<{ bytes: Uint8Array; width: number; height: number; alpha: "opaque" | "straight" }> {
  const image = sharp(bytes, { limitInputPixels: SPATIAL_ASSET_PREPARATION_LIMITS.rasterPixels, failOn: "warning" });
  const metadata = await image.metadata();
  if ((metadata.format !== "png" && metadata.format !== "jpeg") || metadata.pages !== undefined && metadata.pages !== 1
    || metadata.orientation !== undefined && metadata.orientation !== 1 || metadata.depth !== "uchar" || metadata.icc !== undefined) {
    capability("sdr-raster", "Raster inputs require single-frame unrotated 8-bit PNG/JPEG without unqualified ICC profiles.");
  }
  if (metadata.width === undefined || metadata.height === undefined) throw new RangeError("Raster has no dimensions.");
  dimensions(metadata.width, metadata.height);
  const pipeline = image.toColourspace("srgb");
  const result = await (opaque ? pipeline.removeAlpha() : pipeline).png().toBuffer({ resolveWithObject: true });
  return { bytes: result.data, width: result.info.width, height: result.info.height, alpha: opaque || !metadata.hasAlpha ? "opaque" : "straight" };
}

interface FontInfo { readonly family: string; readonly hasGlyph: (codepoint: number) => boolean }
/** Bounded OpenType cmap coverage qualification. No font discovery or fallback. */
export function spatialOpenTypeFont(bytes: Uint8Array, declaredFamily: string): FontInfo {
  if (bytes.length < 12 || bytes.length > SPATIAL_ASSET_PREPARATION_LIMITS.fontBytes) throw new RangeError("OpenType font size is invalid.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => { if (at < 0 || at + 2 > bytes.length) throw new RangeError("Font table is truncated."); return view.getUint16(at); };
  const u32 = (at: number) => { if (at < 0 || at + 4 > bytes.length) throw new RangeError("Font table is truncated."); return view.getUint32(at); };
  if (u32(0) !== 0x4f54544f && u32(0) !== 0x00010000) capability("font-format", "Only standalone OpenType/TrueType sfnt data is qualified; WOFF2 requires a separate decoder.");
  const count = u16(4);
  if (count < 1 || count > 128 || 12 + count * 16 > bytes.length) throw new RangeError("Font table directory is invalid.");
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16, name = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = u32(at + 8), length = u32(at + 12);
    if (offset + length > bytes.length || tables.has(name)) throw new RangeError("Font table extent or identity is invalid.");
    tables.set(name, { offset, length });
  }
  const name = tables.get("name"), cmap = tables.get("cmap"), maxp = tables.get("maxp");
  if (name === undefined || cmap === undefined || maxp === undefined || maxp.length < 6) throw new RangeError("Font requires name, maxp, and Unicode cmap tables.");
  const glyphCount = u16(maxp.offset + 4);
  const nameCount = u16(name.offset + 2), storage = name.offset + u16(name.offset + 4), families = new Set<string>();
  if (nameCount > 1_024 || 6 + nameCount * 12 > name.length) throw new RangeError("Font names exceed their table bounds.");
  for (let i = 0; i < nameCount; i++) {
    const at = name.offset + 6 + i * 12, platform = u16(at), id = u16(at + 6), length = u16(at + 8), start = storage + u16(at + 10);
    if (start + length > name.offset + name.length) throw new RangeError("Font name exceeds its table bounds.");
    if ((id === 1 || id === 16) && (platform === 0 || platform === 3) && length % 2 === 0) {
      let family = "";
      for (let offset = start; offset < start + length; offset += 2) family += String.fromCharCode(u16(offset));
      families.add(family);
    }
  }
  if (!families.has(declaredFamily)) throw new RangeError("Declared font family does not match the exact OpenType family.");
  const cmapCount = u16(cmap.offset + 2), subtables: { at: number; length: number; format: number }[] = [];
  if (cmapCount > 256 || 4 + cmapCount * 8 > cmap.length) throw new RangeError("Font cmap directory exceeds its bounds.");
  for (let i = 0; i < cmapCount; i++) {
    const entry = cmap.offset + 4 + i * 8, platform = u16(entry), encoding = u16(entry + 2), at = cmap.offset + u32(entry + 4);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const format = u16(at);
    if (format !== 4 && format !== 12) continue;
    const length = format === 4 ? u16(at + 2) : u32(at + 4);
    if (at < cmap.offset || at + length > cmap.offset + cmap.length || length < (format === 4 ? 16 : 16)) throw new RangeError("Unicode cmap exceeds its table bounds.");
    if (format === 4 && (u16(at + 6) % 2 !== 0 || 16 + 8 * (u16(at + 6) / 2) > length)) throw new RangeError("cmap format 4 segments exceed their table.");
    if (format === 12 && (u32(at + 12) > 100_000 || 16 + u32(at + 12) * 12 > length)) throw new RangeError("cmap format 12 groups exceed their table.");
    const segments = format === 12 ? u32(at + 12) : u16(at + 6) / 2;
    let previous = -1;
    for (let i = 0; i < segments; i++) {
      const start = format === 12 ? u32(at + 16 + i * 12) : u16(at + 16 + segments * 2 + i * 2);
      const end = format === 12 ? u32(at + 20 + i * 12) : u16(at + 14 + i * 2);
      if (start > end || start <= previous || end > 0x10ffff) throw new RangeError("Unicode cmap ranges must be ordered and disjoint.");
      previous = end;
    }
    subtables.push({ at, length, format });
  }
  if (subtables.length === 0) capability("font-cmap", "Font requires a qualified Unicode cmap format 4 or 12.");
  return Object.freeze({ family: declaredFamily, hasGlyph: (codepoint: number): boolean => {
    if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return false;
    for (const table of subtables) {
      const at = table.at;
      if (table.format === 12) {
        const groups = u32(at + 12);
        let low = 0, high = groups - 1;
        while (low <= high) {
          const i = Math.floor((low + high) / 2);
          const group = at + 16 + i * 12, start = u32(group), end = u32(group + 4);
          if (codepoint < start) high = i - 1;
          else if (codepoint > end) low = i + 1;
          else { const glyph = u32(group + 8) + codepoint - start; if (glyph > 0 && glyph < glyphCount) return true; break; }
        }
      } else if (codepoint <= 0xffff) {
        const segments = u16(at + 6) / 2, ends = at + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, offsets = deltas + segments * 2;
        let low = 0, high = segments - 1;
        while (low <= high) {
          const i = Math.floor((low + high) / 2);
          const start = u16(starts + i * 2), end = u16(ends + i * 2);
          if (codepoint < start) { high = i - 1; continue; }
          if (codepoint > end) { low = i + 1; continue; }
          const delta = u16(deltas + i * 2), offset = u16(offsets + i * 2);
          if (offset === 0) { const glyph = (codepoint + delta) % 65_536; if (glyph > 0 && glyph < glyphCount) return true; }
          else {
            const glyphAt = offsets + i * 2 + offset + (codepoint - start) * 2;
            if (glyphAt + 2 > at + table.length) throw new RangeError("Font glyph lookup escapes cmap table.");
            const glyph = u16(glyphAt);
            if (glyph !== 0 && (glyph + delta) % 65_536 > 0 && (glyph + delta) % 65_536 < glyphCount) return true;
          }
          break;
        }
      }
    }
    return false;
  } });
}

function glyphCoverage(text: string, fonts: readonly FontInfo[]): void {
  for (const character of text) {
    if (character === "\n" || character === "\r" || character === "\t") continue;
    const point = character.codePointAt(0)!;
    if (point < 32 || !fonts.some(font => font.hasGlyph(point))) capability("font-glyph", `Declared fonts do not cover codepoint U+${point.toString(16).toUpperCase()}.`);
  }
}

const probeSchema = z.object({
  streams: z.array(z.object({ width: z.number().int(), height: z.number().int(), pix_fmt: z.string(), avg_frame_rate: z.string(), time_base: z.string().max(40),
    color_transfer: z.string().optional(), color_primaries: z.string().optional(), color_space: z.string().optional() })).length(1),
  frames: z.array(z.object({ best_effort_timestamp: z.number().int().safe().min(0), best_effort_timestamp_time: z.string(), duration: z.number().int().safe().min(1).optional(), pkt_duration: z.number().int().safe().min(1).optional() })).min(1).max(SPATIAL_ASSET_PREPARATION_LIMITS.videoFrames),
});
function decimalUs(value: string): number {
  if (!/^-?\d+(?:\.\d{1,9})?$/u.test(value)) throw new RangeError("Video frame timestamp is not a bounded decimal.");
  const negative = value.startsWith("-"), [whole, fractional = ""] = (negative ? value.slice(1) : value).split(".");
  const nanos = BigInt(whole!) * 1_000_000_000n + BigInt(fractional.padEnd(9, "0"));
  const result = Number((nanos + 500n) / 1_000n) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(result)) throw new RangeError("Video timestamp exceeds the integer clock.");
  return result;
}
export function spatialVideoTimeUs(entity: Extract<SpatialEntity, { kind: "video" }>, sceneTimeUs: number, durationUs: number): number {
  if (!Number.isSafeInteger(sceneTimeUs) || sceneTimeUs < 0 || !Number.isSafeInteger(durationUs) || durationUs < 1) throw new RangeError("Video clocks must be nonnegative integer microseconds.");
  const time = entity.sourceOffsetUs + sceneTimeUs;
  if (entity.playback === "loop") return time % durationUs;
  if (entity.playback === "freeze") return Math.min(time, durationUs - 1);
  if (time >= durationUs) throw new RangeError("Video once playback lies outside its half-open source duration.");
  return time;
}

/** Owns every temporary/native input until the consumer and all native calls settle. */
export async function withPreparedSpatialAssets<Result>(
  input: unknown, ports: SpatialAssetPreparationPorts, signal: AbortSignal,
  consume: (prepared: PreparedSpatialAssets) => Promise<Result>,
): Promise<Result> {
  const request = inputSchema.parse(createBoundedJsonSnapshot(input, SPATIAL_OVERLAY_LIMITS.requestBytes, "Spatial asset preparation request", { maximumDepth: 48, maximumValues: SPATIAL_OVERLAY_LIMITS.requestValues }).value);
  if (request.exactSceneTimesUs !== undefined && request.exactSceneTimesUs.length !== request.snapshots.length) throw new RangeError("Exact scene times must correspond one-to-one to snapshots.");
  const exactTimes = request.snapshots.map((snapshot, index) => {
    const exact = request.exactSceneTimesUs?.[index] ?? { numerator: String(snapshot.timeUs), denominator: "1" };
    const n = BigInt(exact.numerator), d = BigInt(exact.denominator);
    if (Number((2n * n + d) / (2n * d)) !== snapshot.timeUs) throw new RangeError("Exact scene time must round to its snapshot clock.");
    let a = n, b = d;
    while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
    return { n: n / a, d: d / a };
  });
  aborted(signal);
  const assetRoot = await physicalRoot(request.assetRoot), parent = await physicalRoot(request.workspaceParent);
  const workspace = await mkdtemp(join(parent, ".atet-spatial-assets-"));
  const verified = new Map<string, SpatialVerifiedAsset>(), paths = new Map<string, string>(), resources = new Map<string, BoundHtmlOverlayResource>();
  const preparedAssets = new Map<string, PreparedSpatialAsset>(), profiles = new Set<string>();
  let sourceBytes = 0, outputBytes = 0;
  const publishRaster = async (image: Awaited<ReturnType<typeof raster>>, preferredName?: string) => {
    const sha256 = digest(image.bytes), name = preferredName ?? `image-${sha256.slice(0, 40)}`;
    const existing = resources.get(name);
    if (existing !== undefined) {
      if (existing.sha256 !== sha256) throw new RangeError("Prepared resource name is bound to different bytes.");
      return { resource: { name, sha256, bytes: existing.bytes, mediaType: "image/png", urlPath: existing.urlPath }, width: image.width, height: image.height, alpha: image.alpha };
    }
    if (resources.size >= 64 || outputBytes + image.bytes.length > SPATIAL_ASSET_PREPARATION_LIMITS.outputBytes) throw new RangeError("Prepared resources exceed the output budget.");
    outputBytes += image.bytes.length;
    const filename = `${sha256}.png`, path = join(workspace, filename);
    await writeFile(path, image.bytes, { flag: "wx", mode: 0o600 }).catch(async error => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || digest(await readFile(path)) !== sha256) throw error;
    });
    const resource = { name, sha256, bytes: image.bytes.length, mediaType: "image/png", urlPath: `${name}.png` };
    resources.set(name, { ...resource, absolutePath: path });
    return { resource, width: image.width, height: image.height, alpha: image.alpha };
  };
  const native = async (argv: readonly [string, ...string[]], maxOutputBytes = 16_384) => {
    aborted(signal);
    const result = await ports.runner.run(argv, { abortSignal: signal, timeoutMs: SPATIAL_ASSET_PREPARATION_LIMITS.nativeTimeoutMs, maxOutputBytes, stdin: "ignore" });
    aborted(signal);
    if (result.exitCode !== 0) throw new Error("Spatial native media preparation failed; no output was published.");
    return result.stdout;
  };
  const videoProbes = new Map<string, { times: readonly number[]; timestamps: readonly string[]; pts: readonly number[]; timeBase: { numerator: string; denominator: string }; colorFilter: string }>(), decodedVideos = new Map<string, Awaited<ReturnType<typeof publishRaster>>>();
  const glbModels = new Map<string, SpatialGlbModel>();
  let failure: { error: unknown } | undefined;
  let completed: { value: Result } | undefined;
  try {
    await mkdir(join(workspace, "source"), { mode: 0o700 });
    for (const snapshot of request.snapshots) {
      const closures = spatialAssetClosureDigests(snapshot.assets);
      for (const manifest of snapshot.assets) {
        const existing = verified.get(manifest.assetId);
        if (existing !== undefined) {
          if (existing.manifestSha256 !== closures[manifest.assetId]) throw new RangeError("One asset ID cannot have multiple interpretations within a batch.");
          continue;
        }
        sourceBytes += manifest.payload.bytes;
        if (sourceBytes > SPATIAL_ASSET_PREPARATION_LIMITS.sourceBytes) throw new RangeError("Spatial source assets exceed the aggregate byte budget.");
        const bytes = await readVerifiedAsset(assetRoot, manifest, signal);
        if (manifest.interpretation.kind === "metadata") {
          if (bytes.byteLength > SPATIAL_SPLAT_LIMITS.metadataBytes) throw new RangeError("Retained metadata exceeds its byte bound.");
          const captured = createBoundedJsonSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), SPATIAL_SPLAT_LIMITS.metadataBytes, "Retained world metadata", { maximumDepth: 24, maximumValues: 32_768 });
          const metadata = captured.value as Record<string, unknown>;
          if (metadata.kind !== manifest.interpretation.schema || metadata.schemaVersion !== 1) throw new RangeError("Retained metadata does not match its declared schema.");
          if (manifest.interpretation.schema === "atet.spatial-world-import") SpatialWorldImportManifestSchema.parse(metadata);
          else WorldLabsProvenanceSchema.parse(metadata);
        }
        const record = { manifest, manifestSha256: closures[manifest.assetId]!, bytes };
        verified.set(manifest.assetId, record);
        const path = join(workspace, "source", manifest.assetId);
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); paths.set(manifest.assetId, path);
      }
    }
    const quantizedKeys = new Map<string, string>();
    for (let snapshotIndex = 0; snapshotIndex < request.snapshots.length; snapshotIndex++) for (const entry of request.snapshots[snapshotIndex]!.entities) {
      const snapshot = request.snapshots[snapshotIndex]!, exactTime = exactTimes[snapshotIndex]!;
      aborted(signal);
      const entity = entry.entity;
      if (entity.kind === "group" || entity.kind === "light" || entity.kind === "mesh" && entity.geometry.kind !== "asset") continue;
      const assetId = entity.kind === "text" ? entity.fontAssetId : entity.kind === "mesh" && entity.geometry.kind === "asset" ? entity.geometry.assetId : "assetId" in entity ? entity.assetId : "";
      const asset = verified.get(assetId);
      if (asset === undefined) throw new RangeError(`Missing manifest for spatial asset ${assetId}.`);
      const interpretation = asset.manifest.interpretation;
      if (entity.kind === "splat") {
        if (interpretation.kind !== "splat" || interpretation.format !== "spz") capability("splat-format", "The qualified world profile accepts gzip SPZ v2/v3 only.");
        const key = `${assetId}:${entity.entityId}:splat`;
        if (preparedAssets.has(key)) continue;
        const facts = await inspectSpatialSpz(asset.bytes, signal);
        const name = `splat-${asset.manifestSha256.slice(0, 40)}`;
        const resource = { name, sha256: asset.manifest.payload.sha256, bytes: asset.bytes.byteLength, mediaType: "application/octet-stream", urlPath: `${name}.spz` };
        if (!resources.has(name)) {
          if (resources.size >= 64 || outputBytes + asset.bytes.byteLength > SPATIAL_ASSET_PREPARATION_LIMITS.outputBytes) throw new RangeError("Prepared splat resources exceed their byte budget.");
          resources.set(name, { ...resource, absolutePath: paths.get(assetId)! }); outputBytes += asset.bytes.byteLength;
        }
        preparedAssets.set(key, PreparedSpatialAssetSchema.parse({ kind: "splat", assetId, entityId: entity.entityId, assetManifestSha256: asset.manifestSha256, resource, facts }));
        profiles.add("atet.spz-v2-v3-spark-2.1.0-full-resolution-v1");
        continue;
      }
      if (entity.kind === "mesh") {
        if (entity.geometry.kind !== "asset") throw new RangeError("Expected asset mesh.");
        if (interpretation.kind !== "gltf" || interpretation.format !== "glb") capability("gltf", "Asset meshes require the qualified self-contained GLB profile.");
        const key = `${assetId}:${entity.entityId}:${entity.geometry.nodeIndex ?? "all"}:${entity.geometry.clip === undefined ? "static" : snapshot.timeUs}`;
        if (preparedAssets.has(key)) continue;
        if (ports.prepareGeometry !== undefined) {
          const result = await ports.prepareGeometry({ asset, dependencies: asset.manifest.dependencies.map(id => verified.get(id)!), entity, timeUs: snapshot.timeUs }, signal);
          aborted(signal);
          const geometry = PreparedSpatialAssetSchema.parse(result.geometry);
          if (geometry.kind !== "geometry" || geometry.assetId !== assetId || geometry.entityId !== entity.entityId || geometry.entityGeometrySha256 !== spatialGeometryContentSha256(entity) || geometry.assetManifestSha256 !== asset.manifestSha256 || geometry.nodeIndex !== entity.geometry.nodeIndex
            || geometry.timeUs !== (entity.geometry.clip === undefined ? null : snapshot.timeUs)) throw new RangeError("Geometry preparer returned an unrelated representation.");
          const images = new Map<string, Awaited<ReturnType<typeof publishRaster>>>();
          for (const image of result.images) {
            if (images.has(image.resourceName)) throw new RangeError("Geometry image resource names must be unique.");
            images.set(image.resourceName, await publishRaster(await raster(image.bytes, image.opaque), image.resourceName));
          }
          const used = new Set<string>();
          const primitives = geometry.primitives.map(primitive => {
            if (primitive.texture === undefined) return primitive;
            const image = images.get(primitive.texture.resource.name);
            if (image === undefined) throw new RangeError("Geometry texture has no exact prepared image bytes.");
            used.add(primitive.texture.resource.name);
            return { ...primitive, texture: { ...primitive.texture, ...image } };
          });
          if (used.size !== images.size) throw new RangeError("Geometry preparer returned unused image bytes.");
          preparedAssets.set(key, PreparedSpatialAssetSchema.parse({ ...geometry, primitives })); profiles.add(result.profile);
        } else {
          if (asset.manifest.dependencies.length !== 0) capability("glb-dependencies", "The built-in GLB profile accepts only self-contained payloads.");
          let model = glbModels.get(assetId);
          if (model === undefined) { model = parseSpatialGlb(asset.bytes); glbModels.set(assetId, model); }
          const geometry = evaluateSpatialGlb(model, { metersPerUnit: interpretation.metersPerUnit, sourceUp: interpretation.sourceUp, timeUs: snapshot.timeUs,
            ...(entity.geometry.nodeIndex === undefined ? {} : { nodeIndex: entity.geometry.nodeIndex }),
            ...(entity.geometry.materialMode === undefined ? {} : { materialMode: entity.geometry.materialMode }),
            ...(entity.geometry.clip === undefined ? {} : { clip: entity.geometry.clip }),
          });
          const primitives: unknown[] = [];
          for (const primitive of geometry.primitives) {
            const { bounds: _bounds, material: sourceMaterial, ...base } = primitive;
            let texture: unknown;
            if (sourceMaterial?.baseColorTexture !== undefined) {
              const source = sourceMaterial.baseColorTexture, image = geometry.images.find(image => image.imageIndex === source.imageIndex);
              if (image === undefined) throw new RangeError("GLB texture image is missing.");
              texture = { ...await publishRaster(await raster(image.bytes, sourceMaterial.alphaMode === "OPAQUE")), flipY: false, sampler: source.sampler };
            }
            primitives.push({ ...base,
              ...(sourceMaterial === undefined ? {} : { material: { kind: "standard", color: "#ffffff", opacity: sourceMaterial.alphaMode === "OPAQUE" ? 1 : sourceMaterial.baseColorLinear[3], metalness: sourceMaterial.metalness, roughness: sourceMaterial.roughness },
                linearColor: sourceMaterial.baseColorLinear.slice(0, 3), doubleSided: sourceMaterial.doubleSided, alphaMode: sourceMaterial.alphaMode,
                ...(sourceMaterial.alphaMode === "MASK" ? { alphaCutoff: sourceMaterial.alphaCutoff } : {}) }),
              ...(texture === undefined ? {} : { texture }),
            });
          }
          preparedAssets.set(key, PreparedSpatialAssetSchema.parse({ kind: "geometry", assetId, entityId: entity.entityId,
            entityGeometrySha256: spatialGeometryContentSha256(entity),
            assetManifestSha256: asset.manifestSha256, timeUs: entity.geometry.clip === undefined ? null : snapshot.timeUs,
            ...(entity.geometry.nodeIndex === undefined ? {} : { nodeIndex: entity.geometry.nodeIndex }), primitives }));
          profiles.add(geometry.profile);
        }
        continue;
      }
      const staticKey = `${assetId}:${entity.entityId}:static`, key = entity.kind === "video" ? `${assetId}:${entity.entityId}:${snapshot.timeUs}` : staticKey;
      if (entity.kind === "video") {
        const exactKey = `${exactTime.n}/${exactTime.d}`;
        if (quantizedKeys.has(key) && quantizedKeys.get(key) !== exactKey) throw new RangeError("Different exact media samples collide on one quantized snapshot time.");
        quantizedKeys.set(key, exactKey);
      }
      if (preparedAssets.has(key)) continue;
      let output: Awaited<ReturnType<typeof publishRaster>>, sourceTimeUs: number | undefined;
      let videoEvidence: { sourceFrameIndex: number; sourcePresentationTimeUs: number; sourceTimestamp: string; sourcePts: number; sourceTimeBase: { numerator: string; denominator: string }; sourceExactTimeUs: { numerator: string; denominator: string } } | undefined;
      if (entity.kind === "image") {
        if (interpretation.kind !== "image") throw new RangeError("Image entity requires an image asset interpretation.");
        let bytes = asset.bytes;
        if (interpretation.mimeType === "image/png" && (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71)
          || interpretation.mimeType === "image/jpeg" && (bytes[0] !== 255 || bytes[1] !== 216)) throw new RangeError("Image payload format differs from its declared MIME type.");
        if (interpretation.mimeType === "image/svg+xml") {
          const svg = inertSpatialSvg(utf8(bytes));
          const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
          dimensions(resvg.width, resvg.height);
          bytes = resvg.render().asPng(); profiles.add("shape-only-svg-resvg-2.6.2");
        }
        const decoded = await raster(bytes, interpretation.alpha === "opaque");
        if (decoded.width !== interpretation.width || decoded.height !== interpretation.height) throw new RangeError("Image dimensions differ from its interpretation.");
        output = await publishRaster(decoded); profiles.add("sdr-png-jpeg-sharp-0.35.3");
      } else if (entity.kind === "video") {
        if (interpretation.kind !== "video") throw new RangeError("Video entity requires a video asset interpretation.");
        if (ports.ffmpegCommand === undefined || ports.ffprobeCommand === undefined) capability("video-decoder", "Video surfaces require bound FFmpeg and FFprobe capabilities.");
        if (asset.bytes.length < 12 || String.fromCharCode(...asset.bytes.subarray(4, 8)) !== "ftyp") capability("video-container", "Only self-contained ISO-BMFF MP4/QuickTime video is qualified.");
        let sourceN = exactTime.n + BigInt(entity.sourceOffsetUs) * exactTime.d;
        const endN = BigInt(interpretation.durationUs) * exactTime.d;
        if (entity.playback === "loop") sourceN %= endN;
        else if (entity.playback === "freeze") sourceN = sourceN >= endN ? endN - exactTime.d : sourceN;
        else if (sourceN >= endN) throw new RangeError("Video once playback lies outside its exact half-open source duration.");
        sourceTimeUs = Number((2n * sourceN + exactTime.d) / (2n * exactTime.d));
        let timeline = videoProbes.get(assetId);
        if (timeline === undefined) {
          const raw = await native([ports.ffprobeCommand, "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-select_streams", "v:0", "-show_streams", "-show_frames", "-show_entries", "stream=width,height,pix_fmt,avg_frame_rate,time_base,color_transfer,color_primaries,color_space:frame=best_effort_timestamp,best_effort_timestamp_time,duration,pkt_duration", "-of", "json", paths.get(assetId)!], SPATIAL_ASSET_PREPARATION_LIMITS.probeBytes);
          const probe = probeSchema.parse(JSON.parse(raw) as unknown), stream = probe.streams[0]!;
          if (stream.width !== interpretation.width || stream.height !== interpretation.height || !["yuv420p", "yuv422p", "yuv444p", "rgba", "bgra", "rgb24", "bgr24", "argb"].includes(stream.pix_fmt)
            || stream.color_transfer !== undefined && !["bt709", "iec61966-2-1", "unknown"].includes(stream.color_transfer)
            || stream.color_primaries !== undefined && !["bt709", "unknown"].includes(stream.color_primaries)
            || stream.color_space !== undefined && !["bt709", "gbr", "unknown"].includes(stream.color_space)) capability("video-sdr", "Video requires matching dimensions and qualified 8-bit SDR metadata.");
          const rate = /^(\d+)\/(\d+)$/u.exec(stream.avg_frame_rate);
          if (rate === null || BigInt(rate[1]!) * BigInt(interpretation.frameRate.denominator) !== BigInt(rate[2]!) * BigInt(interpretation.frameRate.numerator) || BigInt(rate[2]!) === 0n) throw new RangeError("Video frame rate differs from its immutable interpretation.");
          let colorFilter = "format=rgba";
          if (stream.pix_fmt.startsWith("yuv")) {
            if (stream.color_transfer !== "bt709" || stream.color_primaries !== "bt709" || stream.color_space !== "bt709") capability("video-color", "YUV video requires explicit BT.709 primaries, transfer, and matrix before conversion to sRGB.");
            colorFilter = "colorspace=space=bt709:trc=iec61966-2-1:primaries=bt709:range=pc:format=yuv444p,format=rgba";
          } else if (stream.color_transfer !== undefined && stream.color_transfer !== "unknown" && stream.color_transfer !== "iec61966-2-1") capability("video-color", "RGB video must declare sRGB transfer or use the source manifest's untagged-sRGB interpretation.");
          dimensions(stream.width, stream.height);
          const timestamps = probe.frames.map(frame => frame.best_effort_timestamp_time), times = timestamps.map(decimalUs);
          const base = /^([1-9]\d{0,15})\/([1-9]\d{0,15})$/u.exec(stream.time_base);
          if (base === null) throw new RangeError("Video requires an exact positive stream time base.");
          const timeBase = { numerator: base[1]!, denominator: base[2]! }, pts = probe.frames.map(frame => frame.best_effort_timestamp);
          if (pts[0] !== 0 || pts.some((time, index) => index > 0 && time <= pts[index - 1]!)) throw new RangeError("Video requires strictly increasing presentation timestamps starting at zero.");
          const final = probe.frames.at(-1)!, finalDuration = final.duration ?? final.pkt_duration;
          if (finalDuration === undefined) throw new RangeError("Video final frame has no presentation duration.");
          const end = BigInt(pts.at(-1)! + finalDuration) * BigInt(timeBase.numerator) * 1_000_000n, d = BigInt(timeBase.denominator);
          if (Math.abs(Number((2n * end + d) / (2n * d)) - interpretation.durationUs) > 1) throw new RangeError("Video duration differs from complete presentation timestamp coverage.");
          timeline = { times, timestamps, pts, timeBase, colorFilter }; videoProbes.set(assetId, timeline);
        }
        let frameIndex = 0;
        while (frameIndex + 1 < timeline.times.length && BigInt(timeline.pts[frameIndex + 1]!) * BigInt(timeline.timeBase.numerator) * 1_000_000n * exactTime.d <= sourceN * BigInt(timeline.timeBase.denominator)) frameIndex++;
        videoEvidence = { sourceFrameIndex: frameIndex, sourcePresentationTimeUs: timeline.times[frameIndex]!, sourceTimestamp: timeline.timestamps[frameIndex]!, sourcePts: timeline.pts[frameIndex]!, sourceTimeBase: timeline.timeBase, sourceExactTimeUs: { numerator: String(sourceN), denominator: String(exactTime.d) } };
        const frameKey = `${assetId}:${frameIndex}`;
        const previous = decodedVideos.get(frameKey);
        if (previous !== undefined) output = previous;
        else {
          const path = join(workspace, `decode-${assetId}-${frameIndex}.png`);
          await native([ports.ffmpegCommand, "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", paths.get(assetId)!, "-map", "0:v:0", "-vf", `select=eq(n\\,${frameIndex}),${timeline.colorFilter}`, "-fps_mode", "passthrough", "-frames:v", "1", "-an", "-sn", "-dn", "-f", "image2", "-n", path]);
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024 * 1024) throw new RangeError("Decoded video frame is not bounded physical image data.");
          const decoded = await raster(await readFile(path), interpretation.alpha === "opaque");
          if (decoded.width !== interpretation.width || decoded.height !== interpretation.height) throw new RangeError("Decoded video frame changed dimensions.");
          output = await publishRaster(decoded); decodedVideos.set(frameKey, output); await rm(path);
        }
        profiles.add("iso-bmff-absolute-presentation-frame-sdr-v1");
      } else {
        const fontAssets = entity.kind === "text" ? [asset] : asset.manifest.dependencies.map(id => verified.get(id)!).filter(value => value.manifest.interpretation.kind === "font");
        if (entity.kind === "text" && interpretation.kind !== "font" || entity.kind === "diagram" && interpretation.kind !== "diagram") throw new RangeError("Text/diagram entity has an incompatible asset interpretation.");
        if (fontAssets.length === 0) capability("declared-font", "Text and diagrams require exact declared font assets; system fallback is disabled.");
        const fonts = fontAssets.map(font => {
          const info = font.manifest.interpretation;
          if (info.kind !== "font" || info.format !== "otf") capability("font-format", "Only declared OTF fonts are qualified for text rasterization.");
          return spatialOpenTypeFont(font.bytes, info.family);
        });
        const family = fonts[0]!.family, fontFiles = fontAssets.map(font => paths.get(font.manifest.assetId)!);
        let svg: string;
        if (entity.kind === "text") {
          glyphCoverage(entity.text, fonts);
          const scaleX = entity.placement.kind === "world" ? 256 : entity.placement.units === "normalized" ? snapshot.camera.projection.width : 1;
          const scaleY = entity.placement.kind === "world" ? 256 : entity.placement.units === "normalized" ? snapshot.camera.projection.height : 1;
          const width = Math.ceil(entity.width * scaleX), size = entity.fontSize * scaleY, lines = entity.text.split(/\r?\n/u);
          const height = Math.max(1, Math.ceil(size * 1.5 * lines.length)); dimensions(width, height);
          const measuredSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + size * 2}" height="${height + size * 2}">${lines.map((line, index) => `<text x="${size}" y="${size * (2.1 + 1.5 * index)}" font-family="${xml(family)}" font-size="${size}" fill="#ffffff">${xml(line)}</text>`).join("")}</svg>`;
          const measured = new Resvg(measuredSvg, { font: { loadSystemFonts: false, fontFiles, defaultFontFamily: family } }).getBBox();
          if (measured !== undefined && measured.width > width + 0.01) capability("text-layout", "Text exceeds its explicit width; add authored line breaks or adjust size/width.");
          const x = entity.align === "left" ? 0 : entity.align === "center" ? width / 2 : width;
          const anchor = entity.align === "left" ? "start" : entity.align === "center" ? "middle" : "end";
          svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines.map((line, index) => `<text x="${x}" y="${size * (1.1 + 1.5 * index)}" font-family="${xml(family)}" font-size="${size}" fill="#ffffff" text-anchor="${anchor}">${xml(line)}</text>`).join("")}</svg>`;
        } else {
          if (interpretation.kind !== "diagram") throw new RangeError("Expected diagram interpretation.");
          const spec = parseDiagramSpec(JSON.parse(utf8(asset.bytes)) as unknown);
          for (const shape of spec.shapes) if ("icon" in shape && shape.icon !== undefined && builtInIcons[shape.icon] === undefined) capability("diagram-icon", "Diagram references an icon outside the closed built-in vocabulary.");
          dimensions(spec.canvas.width, spec.canvas.height);
          const sourceText: string[] = [];
          const collect = (value: unknown): void => {
            if (Array.isArray(value)) { for (const item of value) collect(item); }
            else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) {
              if ((key === "text" || key === "label") && typeof child === "string") sourceText.push(child); else collect(child);
            }
          };
          collect(spec); glyphCoverage(sourceText.join("\n"), fonts);
          svg = (await renderSvg(spec, interpretation.theme, { icons: builtInIcons, font: { family, monoFamily: family, files: fontFiles.map(path => ({ path, embed: false })) } })).svg;
        }
        const resvg = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles, defaultFontFamily: family, monospaceFamily: family, sansSerifFamily: family, serifFamily: family } });
        dimensions(resvg.width, resvg.height);
        if (resvg.imagesToResolve().length !== 0) throw new RangeError("Text/diagram raster attempted an undeclared external image.");
        if (entity.kind === "text") {
          const bounds = resvg.innerBBox();
          if (bounds !== undefined && (bounds.x < -0.01 || bounds.y < -0.01 || bounds.x + bounds.width > resvg.width + 0.01 || bounds.y + bounds.height > resvg.height + 0.01)) capability("text-layout", "Text exceeds its explicit width; add authored line breaks or adjust size/width.");
        }
        output = await publishRaster(await raster(resvg.render().asPng())); profiles.add("declared-otf-no-system-font-resvg-2.6.2");
      }
      preparedAssets.set(key, PreparedSpatialAssetSchema.parse({ kind: "raster", assetId, assetManifestSha256: asset.manifestSha256, entityId: entity.entityId,
        timeUs: entity.kind === "video" ? snapshot.timeUs : null, ...output,
        ...(sourceTimeUs === undefined ? {} : { sourceTimeUs }),
        ...(videoEvidence === undefined ? {} : videoEvidence),
        ...(entity.kind === "text" ? { entityContentSha256: spatialTextRasterContentSha256(entity) } : {}),
        ...(entity.kind === "video" ? { entityContentSha256: spatialVideoRasterContentSha256(entity) } : {}),
      }));
    }
    aborted(signal);
    const prepared = [...preparedAssets.values()];
    completed = { value: await consume(Object.freeze({ preparedAssets: prepared, resources: [...resources.values()],
      sources: [...verified].map(([id, asset]) => ({ manifest: asset.manifest, manifestSha256: asset.manifestSha256, absolutePath: paths.get(id)! })),
      receipt: Object.freeze({
      kind: "atet.spatial-asset-preparation", schemaVersion: 1, sourceManifests: Object.fromEntries([...verified].map(([id, asset]) => [id, asset.manifestSha256])),
      preparedSha256: canonicalJsonSha256(prepared), sourceBytes, outputBytes, profiles: [...profiles].sort(),
    }) })) };
  } catch (error) { failure = { error }; }
  finally {
    try { await rm(workspace, { recursive: true, force: true }); }
    catch (cleanupError) { failure = { error: failure === undefined ? cleanupError : new AggregateError([failure.error, cleanupError], "Spatial preparation and workspace cleanup both failed.") }; }
  }
  if (failure !== undefined) throw failure.error;
  if (completed === undefined) throw new Error("Spatial asset consumer did not settle with a result.");
  return completed.value;
}
