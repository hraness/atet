import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { SpatialSpzFactsSchema, SPATIAL_SPLAT_LIMITS, spatialSpzAllocationBounds, type SpatialSpzFacts } from "../contracts/spatial-world";

/** Inspect the complete gzip stream without allocating its advertised output. No decoder/browser runs before admission. */
export async function inspectSpatialSpz(input: Uint8Array, signal: AbortSignal): Promise<SpatialSpzFacts> {
  if (!(input instanceof Uint8Array) || input.byteLength < 18 || input.byteLength > SPATIAL_SPLAT_LIMITS.sourceBytes || input[0] !== 0x1f || input[1] !== 0x8b) throw new RangeError("The qualified splat profile requires bounded gzip SPZ v2/v3 bytes.");
  signal.throwIfAborted();
  const gunzip = createGunzip({ chunkSize: 16 * 1024 });
  const source = Readable.from([input]);
  const abort = () => gunzip.destroy(signal.reason instanceof Error ? signal.reason : new Error("SPZ admission cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  source.pipe(gunzip);
  const header = new Uint8Array(16);
  let count = 0, facts: SpatialSpzFacts | undefined;
  try {
    for await (const chunkInput of gunzip) {
      signal.throwIfAborted();
      const chunk = chunkInput as Buffer;
      if (count < 16) header.set(chunk.subarray(0, Math.min(16 - count, chunk.byteLength)), count);
      count += chunk.byteLength;
      if (count > SPATIAL_SPLAT_LIMITS.decompressedBytes) throw new RangeError("SPZ decompression exceeds its byte budget.");
      if (facts === undefined && count >= 16) {
        const view = new DataView(header.buffer);
        const version = view.getUint32(4, true), splats = view.getUint32(8, true), shDegree = header[12]!, fractionalBits = header[13]!, flags = header[14]!;
        if (view.getUint32(0, true) !== 0x5053474e || (version !== 2 && version !== 3) || flags > 1 || header[15] !== 0) throw new RangeError("SPZ requires v2/v3 without LoD, extensions, or reserved flags.");
        if (flags === 1) throw new RangeError("Antialiased-training SPZ is not supported by the initial qualified Spark profile.");
        const decompressedBytes = 16 + splats * (9 + 1 + 3 + 3 + (version === 3 ? 4 : 3) + 3 * ((shDegree + 1) ** 2 - 1));
        facts = SpatialSpzFactsSchema.parse({ kind: "atet.spz-admission", schemaVersion: 1, version, splats, shDegree, fractionalBits, antialiased: flags === 1, decompressedBytes, ...spatialSpzAllocationBounds(splats, input.byteLength, decompressedBytes) });
      }
      if (facts !== undefined && count > facts.decompressedBytes) throw new RangeError("SPZ body exceeds the exact admitted attribute layout.");
    }
    if (facts === undefined || count !== facts.decompressedBytes) throw new RangeError("SPZ attribute body is truncated or does not match its header.");
    signal.throwIfAborted();
    return Object.freeze(facts);
  } finally {
    signal.removeEventListener("abort", abort);
    const settled = [finished(source, { cleanup: true }), finished(gunzip, { cleanup: true })];
    source.destroy(); gunzip.destroy();
    await Promise.allSettled(settled);
  }
}
