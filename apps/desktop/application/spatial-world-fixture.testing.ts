import { gzipSync } from "node:zlib";

/** Original generated attribute bytes, with no downloaded world or licensed geometry. */
export function originalSpz(version: 2 | 3 = 3, splats = 2, shDegree = 0) {
  const raw = new Uint8Array(16 + splats * (19 + (version === 3 ? 1 : 0) + 3 * ((shDegree + 1) ** 2 - 1)));
  const view = new DataView(raw.buffer);
  view.setUint32(0, 0x5053474e, true); view.setUint32(4, version, true); view.setUint32(8, splats, true); raw[12] = shDegree; raw[13] = 12;
  raw.fill(255, 16 + splats * 9, 16 + splats * 10);
  raw.fill(128, 16 + splats * 10, 16 + splats * 16);
  return { raw, compressed: gzipSync(raw) };
}
export function originalWorldCollider(): Uint8Array {
  const binary = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }] };
  const encoded = new TextEncoder().encode(JSON.stringify(document)), json = new Uint8Array(Math.ceil(encoded.length / 4) * 4).fill(32); json.set(encoded);
  const result = new Uint8Array(28 + json.length + binary.length), view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.length, true);
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); result.set(json, 20);
  view.setUint32(20 + json.length, binary.length, true); view.setUint32(24 + json.length, 0x004e4942, true); result.set(binary, 28 + json.length);
  return result;
}
