import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import fc from "fast-check";

import { inspectSpatialSpz } from "./spatial-spz";
import { originalSpz } from "./spatial-world-fixture.testing";

describe("bounded SPZ admission", () => {
  test("admits exact supported attribute layouts across counts and SH degrees", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(2 as const, 3 as const), fc.integer({ min: 1, max: 32 }), fc.integer({ min: 0, max: 3 }), async (version, count, sh) => {
      const input = originalSpz(version, count, sh), facts = await inspectSpatialSpz(input.compressed, new AbortController().signal);
      expect(facts).toMatchObject({ version, splats: count, shDegree: sh, decompressedBytes: input.raw.length });
      expect(facts.gpuBytesBound).toBeGreaterThan(count * 204);
    }), { numRuns: 32 });
  });
  test("rejects unknown format, advertised count, extensions, and unsafe quantization before full inflate", async () => {
    for (const mutate of [(v: DataView) => v.setUint32(4, 4, true), (v: DataView) => v.setUint32(8, 500_001, true), (v: DataView) => v.setUint8(12, 4), (v: DataView) => v.setUint8(13, 25), (v: DataView) => v.setUint8(14, 128), (v: DataView) => v.setUint8(15, 1)]) {
      const fixture = originalSpz(); mutate(new DataView(fixture.raw.buffer));
      await expect(inspectSpatialSpz(gzipSync(fixture.raw), new AbortController().signal)).rejects.toThrow();
    }
  });
  test("rejects truncated, extended, CRC-corrupt and concatenated bodies", async () => {
    const { raw, compressed } = originalSpz(); const corrupt = compressed.slice(); corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 1;
    for (const bytes of [gzipSync(raw.slice(0, -1)), gzipSync(new Uint8Array([...raw, 0])), corrupt, Buffer.concat([compressed, compressed])]) await expect(inspectSpatialSpz(bytes, new AbortController().signal)).rejects.toThrow();
  });
  test("rejects antialiased training until its appearance kernel is qualified", async () => {
    const fixture = originalSpz(); fixture.raw[14] = 1;
    await expect(inspectSpatialSpz(gzipSync(fixture.raw), new AbortController().signal)).rejects.toThrow("Antialiased-training SPZ");
  });
  test("cancelled admission rejects without leaving its decompressor running", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(inspectSpatialSpz(originalSpz().compressed, controller.signal)).rejects.toThrow("cancelled");
    const live = new AbortController(); const pending = inspectSpatialSpz(originalSpz(3, 100_000, 3).compressed, live.signal); live.abort(new Error("mid-stream cancellation"));
    await expect(pending).rejects.toThrow("mid-stream cancellation");
  });
});
