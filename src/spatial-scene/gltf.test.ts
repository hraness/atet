import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { deflateSync } from "node:zlib"
import { createHash } from "node:crypto"
import { evaluateSpatialGlb, parseSpatialGlb, SPATIAL_GLB_PROFILE, type SpatialGlbEvaluateOptions } from "./gltf.js"
import { applySpatialScenePatch } from "./patch.js"
import { spatialSceneSha256 } from "./identity.js"
import { inspectSpatialScene } from "./inspect.js"
import { fixtureScene } from "./test-fixture.js"

/** Original programmatic fixture, with no downloaded or third-party geometry. */
function triangleFixture() {
  const binary = new Uint8Array(128), data = new DataView(binary.buffer)
  const floats = [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]
  floats.forEach((value, index) => data.setFloat32(index * 4, value, true))
  ;[0, 0, 1, 0, 0, 1].forEach((value, index) => data.setFloat32(72 + index * 4, value, true))
  ;[0, 1, 2].forEach((value, index) => data.setUint16(96 + index * 2, value, true))
  return {
    binary: binary.slice(0, 104),
    document: {
      asset: { version: "2.0", generator: "ATET original GLB parser fixture" },
      buffers: [{ byteLength: 104 }], bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
        { buffer: 0, byteOffset: 72, byteLength: 24 }, { buffer: 0, byteOffset: 96, byteLength: 6 },
      ], accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [2, 3, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
        { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: "triangle" }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.8, 0.6], metallicFactor: 0.3, roughnessFactor: 0.7 }, alphaMode: "BLEND", doubleSided: true }],
    },
  }
}
type Document = Record<string, unknown>
function envelope(document: unknown, binary: Uint8Array): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(document))
  const json = new Uint8Array(Math.ceil(raw.length / 4) * 4).fill(32); json.set(raw)
  const bin = new Uint8Array(Math.ceil(binary.length / 4) * 4); bin.set(binary)
  const bytes = new Uint8Array(28 + json.length + bin.length), view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true)
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20)
  view.setUint32(20 + json.length, bin.length, true); view.setUint32(24 + json.length, 0x004e4942, true); bytes.set(bin, 28 + json.length)
  return bytes
}
const options: SpatialGlbEvaluateOptions = { metersPerUnit: 1, sourceUp: "y", timeUs: 0 }
function fixtureGeometry(document?: unknown, binary?: Uint8Array) {
  const fixture = triangleFixture()
  return evaluateSpatialGlb(parseSpatialGlb(envelope(document ?? fixture.document, binary ?? fixture.binary)), options)
}

function animationFixture() {
  const fixture = triangleFixture()
  const binary = new Uint8Array(216); binary.set(fixture.binary)
  const view = new DataView(binary.buffer)
  ;[0, 1].forEach((value, index) => view.setFloat32(104 + index * 4, value, true))
  ;[0, 0, 0, 10, 20, 30].forEach((value, index) => view.setFloat32(112 + index * 4, value, true))
  ;[0, 0, 0, 1, 0, 1, 0, 0].forEach((value, index) => view.setFloat32(136 + index * 4, value, true))
  ;[1, 1, 1, 2, 3, 4].forEach((value, index) => view.setFloat32(168 + index * 4, value, true))
  const document = {
    ...fixture.document, buffers: [{ byteLength: binary.length }],
    bufferViews: [...fixture.document.bufferViews, { buffer: 0, byteOffset: 104, byteLength: 8 }, { buffer: 0, byteOffset: 112, byteLength: 24 }, { buffer: 0, byteOffset: 136, byteLength: 32 }, { buffer: 0, byteOffset: 168, byteLength: 24 }],
    accessors: [...fixture.document.accessors, { bufferView: 4, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] }, { bufferView: 5, componentType: 5126, count: 2, type: "VEC3" }, { bufferView: 6, componentType: 5126, count: 2, type: "VEC4" }, { bufferView: 7, componentType: 5126, count: 2, type: "VEC3" }],
    animations: [{ samplers: [{ input: 4, output: 5 }, { input: 4, output: 6 }, { input: 4, output: 7 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }, { sampler: 1, target: { node: 0, path: "rotation" } }, { sampler: 2, target: { node: 0, path: "scale" } }] }],
  }
  return { binary, document }
}

function originalPng(): Uint8Array {
  const chunk = (type: string, payload: Uint8Array) => {
    const bytes = new Uint8Array(12 + payload.length), data = new DataView(bytes.buffer)
    data.setUint32(0, payload.length); bytes.set(new TextEncoder().encode(type), 4); bytes.set(payload, 8)
    let crc = 0xffffffff
    for (const byte of bytes.subarray(4, bytes.length - 4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    data.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0)
    return bytes
  }
  const ihdr = new Uint8Array(13), header = new DataView(ihdr.buffer)
  header.setUint32(0, 1); header.setUint32(4, 1); ihdr[8] = 8; ihdr[9] = 6
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(new Uint8Array([0, 20, 40, 80, 128]))), chunk("IEND", new Uint8Array())]
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}

function textureFixture(image = originalPng(), mimeType = "image/png") {
  const fixture = triangleFixture(), binary = new Uint8Array(fixture.binary.length + image.length)
  binary.set(fixture.binary); binary.set(image, fixture.binary.length)
  const document = {
    ...fixture.document, buffers: [{ byteLength: binary.length }], bufferViews: [...fixture.document.bufferViews, { buffer: 0, byteOffset: fixture.binary.length, byteLength: image.length }],
    images: [{ bufferView: 4, mimeType }], textures: [{ source: 0, sampler: 0 }], samplers: [{ wrapS: 33648, wrapT: 10497, magFilter: 9728, minFilter: 9987 }],
    materials: [{ ...fixture.document.materials[0], pbrMetallicRoughness: { ...fixture.document.materials[0]!.pbrMetallicRoughness, baseColorTexture: { index: 0 } } }],
  }
  return { document, binary }
}

describe("closed GLB triangle profile", () => {
  test("proxy replacement preserves authored identity and reordered imports require explicit local addresses", () => {
    const source = fixtureScene(), fixture = triangleFixture()
    const first = envelope(fixture.document, fixture.binary)
    const second = envelope({ ...fixture.document, scenes: [{ nodes: [1] }], nodes: [{ name: "Unrelated new node" }, fixture.document.nodes[0]!] }, fixture.binary)
    const manifest = (bytes: Uint8Array) => {
      const digest = createHash("sha256").update(bytes).digest("hex")
      return { assetId: "asset_product", payload: { path: `assets/${digest}.glb`, sha256: digest, bytes: bytes.length },
        interpretation: { kind: "gltf", format: "glb", metersPerUnit: 1, sourceUp: "y" }, dependencies: [], provenance: { source: "authored", description: "Original programmatic triangle" } }
    }
    const apply = (scene: unknown, operations: unknown[]) => applySpatialScenePatch(scene, { kind: "atet.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: spatialSceneSha256(scene), operations })
    const imported = apply(source, [{ kind: "add-asset", asset: manifest(first) }, { kind: "set-mesh-geometry", entityId: "entity_box", geometry: { kind: "asset", assetId: "asset_product", nodeIndex: 0 } }])
    const replace = { kind: "replace-asset", asset: manifest(second) }
    expect(() => apply(imported.scene, [replace])).toThrow("internal correspondence is not inferred")
    const rebound = apply(imported.scene, [replace, { kind: "set-mesh-geometry", entityId: "entity_box", geometry: { kind: "asset", assetId: "asset_product", nodeIndex: 1 } }])
    const original = source.entities[0]!, current = rebound.scene.entities[0]!
    expect({ entityId: current.entityId, name: current.name, transform: current.transform, placement: current.placement, origin: current.origin }).toEqual({ entityId: original.entityId, name: original.name, transform: original.transform, placement: original.placement, origin: original.origin })
    expect(rebound.scene.cameras).toEqual(source.cameras)
    const a = evaluateSpatialGlb(parseSpatialGlb(first), { ...options, nodeIndex: 0 })
    const b = evaluateSpatialGlb(parseSpatialGlb(second), { ...options, nodeIndex: 1 })
    expect(b.bounds).toEqual(a.bounds)
    expect(b.primitives[0]!.positions).toEqual(a.primitives[0]!.positions)
    expect(b.primitives[0]!.sourceNodeIndex).toBe(1)
    expect(rebound.diff.some(entry => entry.collection === "assets" && entry.properties.includes("payload"))).toBe(true)
    const sourceMaterial = { kind: "set-mesh-geometry", entityId: "entity_box", geometry: { kind: "asset", assetId: "asset_product", nodeIndex: 1, materialMode: "source" } }
    const materialChanged = apply(rebound.scene, [sourceMaterial])
    expect(inspectSpatialScene(materialChanged.scene).entities[0]!.editableControls).not.toContain("color")
    const overridden = apply(rebound.scene, [{ kind: "set-override", override: { entityId: "entity_box", property: "color", value: "#ffffff" } }])
    expect(() => apply(overridden.scene, [sourceMaterial])).toThrow()
    expect(source.entities[0]).toEqual(original)
  })

  test("decodes indexed positions, normals, UVs and exact source linear PBR factors", () => {
    const fixture = triangleFixture(), model = parseSpatialGlb(envelope(fixture.document, fixture.binary))
    const geometry = evaluateSpatialGlb(model, { ...options, materialMode: "source" })
    expect(geometry.profile).toBe(SPATIAL_GLB_PROFILE)
    expect(model.nodeCount).toBe(1)
    expect(geometry.bounds).toEqual({ min: [0, 0, 0], max: [2, 3, 0] })
    expect(geometry.primitives[0]).toMatchObject({ positions: [0, 0, 0, 2, 0, 0, 0, 3, 0], indices: [0, 1, 2], sourceNodeIndex: 0, sourcePrimitiveIndex: 0,
      material: { baseColorLinear: [0.2, 0.4, 0.8, 0.6], metalness: 0.3, roughness: 0.7, alphaMode: "BLEND", doubleSided: true } })
    expect(fixtureGeometry().primitives[0]!.material).toBeUndefined()
    expect(Object.isFrozen(geometry.primitives[0]!.positions)).toBe(true)
  })

  test("preserves hierarchy and node indices, selected subtree retains ancestor transforms", () => {
    const fixture = triangleFixture()
    const document = { ...fixture.document, nodes: [{ translation: [10, 20, 30], children: [1, 2] }, { mesh: 0, translation: [1, 2, 3] }, { mesh: 0, translation: [-1, -2, -3] }] }
    const model = parseSpatialGlb(envelope(document, fixture.binary))
    expect(evaluateSpatialGlb(model, { ...options, nodeIndex: 1 }).bounds).toEqual({ min: [11, 22, 33], max: [13, 25, 33] })
    expect(evaluateSpatialGlb(model, options).primitives.map(primitive => primitive.sourceNodeIndex)).toEqual([1, 2])
    expect(() => evaluateSpatialGlb(model, { ...options, nodeIndex: 3 })).toThrow()
    const multipleScenes = { ...document, scenes: [{ nodes: [0] }, { nodes: [3] }], nodes: [...document.nodes, { mesh: 0 }] }
    expect(() => evaluateSpatialGlb(parseSpatialGlb(envelope(multipleScenes, fixture.binary)), { ...options, nodeIndex: 3 })).toThrow()
  })

  test("source axes and meters map by explicit right-handed rotations", () => {
    const fixture = triangleFixture(), model = parseSpatialGlb(envelope(fixture.document, fixture.binary))
    const x = evaluateSpatialGlb(model, { ...options, metersPerUnit: 2, sourceUp: "x" })
    expect(x.bounds.min[0]).toBeCloseTo(-6, 10); expect(x.bounds.max[1]).toBeCloseTo(4, 10)
    const z = evaluateSpatialGlb(model, { ...options, metersPerUnit: 0.5, sourceUp: "z" })
    expect(z.bounds.max[0]).toBeCloseTo(1, 10); expect(z.bounds.min[2]).toBeCloseTo(-1.5, 10)
  })

  test("affine bounds derive from drawn vertices rather than transformed local AABB corners", () => {
    const fixture = triangleFixture()
    const angle = Math.PI / 4
    const document = { ...fixture.document, nodes: [{ mesh: 0, rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] }] }
    const geometry = fixtureGeometry(document)
    expect(geometry.bounds.max[1]).toBeCloseTo(3 * Math.SQRT1_2, 10)
    expect(geometry.bounds.max[1]).not.toBeCloseTo(5 * Math.SQRT1_2, 10)
  })

  test("native clockwise wheel quaternion admits negative components and preserves its rotation", () => {
    const fixture = triangleFixture()
    const geometry = fixtureGeometry({ ...fixture.document, nodes: [{ mesh: 0, rotation: [0, 0, -0.70710683, 0.70710683] }] })
    expect(geometry.bounds.min[0]).toBeCloseTo(0, 6)
    expect(geometry.bounds.min[1]).toBeCloseTo(-2, 6)
    expect(geometry.bounds.max[0]).toBeCloseTo(3, 6)
    expect(geometry.bounds.max[1]).toBeCloseTo(0, 6)
    for (const rotation of [[0, 0, -1.001, 0], [0, 0, 1.001, 0], [0, 0, 0, 0]]) {
      expect(() => fixtureGeometry({ ...fixture.document, nodes: [{ mesh: 0, rotation }] })).toThrow()
    }
  })

  test("all signed unit quaternions and their negations admit the same rigid rotation", () => {
    fc.assert(fc.property(fc.tuple(...Array.from({ length: 4 }, () => fc.integer({ min: -1000, max: 1000 }))).filter(values => values.some(value => value !== 0)), values => {
      const norm = Math.hypot(...values), rotation = values.map(value => value / norm), fixture = triangleFixture()
      const geometry = (value: number[]) => fixtureGeometry({ ...fixture.document, nodes: [{ mesh: 0, rotation: value }] })
      const original = geometry(rotation), negated = geometry(rotation.map(value => -value))
      expect(negated.bounds).toEqual(original.bounds)
      const matrix = original.primitives[0]!.matrix
      for (let column = 0; column < 3; column++) {
        expect(Math.hypot(matrix[column * 4]!, matrix[column * 4 + 1]!, matrix[column * 4 + 2]!)).toBeCloseTo(1, 10)
      }
      expect(matrix[0]! * matrix[4]! + matrix[1]! * matrix[5]! + matrix[2]! * matrix[6]!).toBeCloseTo(0, 10)
    }), { seed: 709707, numRuns: 100 })
  })

  test("source matrix TRS and reflections remain supported; shear and singular transforms reject", () => {
    const fixture = triangleFixture()
    const matrix = [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1]
    expect(fixtureGeometry({ ...fixture.document, nodes: [{ mesh: 0, matrix }] }).bounds).toEqual({ min: [6, 20, 30], max: [10, 29, 30] })
    for (const node of [{ mesh: 0, matrix, translation: [0, 0, 0] }, { mesh: 0, matrix: matrix.map((value, i) => i === 4 ? 0.1 : value) }, { mesh: 0, scale: [0, 1, 1] }, { mesh: 0, rotation: [0, 0, 0, 0] }]) expect(() => fixtureGeometry({ ...fixture.document, nodes: [node] })).toThrow()
  })

  test("rejects unsupported resource, geometry, material and animation features explicitly", () => {
    const fixture = triangleFixture()
    const variants: Document[] = [
      { ...fixture.document, extensionsUsed: ["KHR_draco_mesh_compression"] },
      { ...fixture.document, extensionsRequired: ["KHR_materials_unlit"] },
      { ...fixture.document, skins: [] },
      { ...fixture.document, buffers: [{ byteLength: 104, uri: "https://example.com/private.bin" }] },
      { ...fixture.document, images: [{ uri: "data:image/png;base64,AA==" }] },
      { ...fixture.document, nodes: [{ mesh: 0, skin: 0 }] },
      { ...fixture.document, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] }] },
      { ...fixture.document, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [] }] }] },
      { ...fixture.document, meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }] },
      { ...fixture.document, materials: [{ normalTexture: { index: 0 } }] },
      { ...fixture.document, materials: [{ emissiveFactor: [1, 0, 0] }] },
      { ...fixture.document, accessors: [{ ...fixture.document.accessors[0], sparse: { count: 1 } }, ...fixture.document.accessors.slice(1)] },
    ]
    for (const document of variants) expect(() => fixtureGeometry(document)).toThrow(SPATIAL_GLB_PROFILE)
    const animation = animationFixture()
    const clip = animation.document.animations[0]!
    expect(() => fixtureGeometry({ ...animation.document, animations: [{ ...clip, samplers: [{ input: 4, output: 5, interpolation: "CUBICSPLINE" }] }] }, animation.binary)).toThrow()
  })

  test("malformed chunk lengths, padding, UTF-8 and binary envelopes reject without reads beyond bounds", () => {
    const fixture = triangleFixture(), valid = envelope(fixture.document, fixture.binary)
    for (const offset of [0, 4, 8, 12, 16]) {
      const corrupt = valid.slice(); new DataView(corrupt.buffer).setUint32(offset, 0xffffffff, true)
      expect(() => parseSpatialGlb(corrupt)).toThrow()
    }
    for (const size of [0, 1, 11, 27, valid.length - 1]) expect(() => parseSpatialGlb(valid.slice(0, size))).toThrow()
    const invalidUtf8 = valid.slice(); invalidUtf8[20] = 0xff
    expect(() => parseSpatialGlb(invalidUtf8)).toThrow()
    const tooLong = new Uint8Array(valid.length + 4); tooLong.set(valid); new DataView(tooLong.buffer).setUint32(8, tooLong.length, true)
    expect(() => parseSpatialGlb(tooLong)).toThrow()
    expect(() => parseSpatialGlb(new Uint8Array(new SharedArrayBuffer(32)))).toThrow()
    const padded = triangleFixture(); padded.document.buffers[0]!.byteLength = 103; padded.binary[103] = 255
    expect(() => parseSpatialGlb(envelope(padded.document, padded.binary))).toThrow()
  })

  test("bounds, indices, alignment, strides, finite values and normal magnitudes are validated", () => {
    const fixture = triangleFixture()
    for (const accessor of [
      { ...fixture.document.accessors[0], byteOffset: 1 }, { ...fixture.document.accessors[0], count: 65537 },
      { ...fixture.document.accessors[0], min: [-1, 0, 0] }, { ...fixture.document.accessors[0], normalized: true },
    ]) expect(() => fixtureGeometry({ ...fixture.document, accessors: [accessor, ...fixture.document.accessors.slice(1)] })).toThrow()
    for (const patch of [{ byteOffset: 1000 }, { byteLength: 1 }, { byteStride: 8 }, { byteStride: 14 }, { target: 34963 }]) expect(() => fixtureGeometry({ ...fixture.document, bufferViews: [{ ...fixture.document.bufferViews[0], ...patch }, ...fixture.document.bufferViews.slice(1)] })).toThrow()
    for (const [offset, value] of [[0, NaN], [0, Infinity], [36, 1], [44, 0]] as const) {
      const binary = fixture.binary.slice(); new DataView(binary.buffer).setFloat32(offset, value, true)
      expect(() => fixtureGeometry(fixture.document, binary)).toThrow()
    }
    const outside = fixture.binary.slice(); new DataView(outside.buffer).setUint16(96, 3, true)
    expect(() => fixtureGeometry(fixture.document, outside)).toThrow()
    const incomplete = { ...fixture.document, accessors: [...fixture.document.accessors.slice(0, 3), { ...fixture.document.accessors[3], count: 2 }] }
    expect(() => fixtureGeometry(incomplete)).toThrow()
  })

  test("hierarchy cycles, multiple parents, duplicate roots and missing references reject", () => {
    const fixture = triangleFixture()
    for (const nodes of [[{ mesh: 0, children: [0] }], [{ children: [1] }, { mesh: 0, children: [0] }], [{ children: [1, 1] }, { mesh: 0 }], [{ children: [2] }, { children: [2] }, { mesh: 0 }], [{ mesh: 4 }], [{ children: [100] }]]) expect(() => fixtureGeometry({ ...fixture.document, nodes })).toThrow()
    expect(() => fixtureGeometry({ ...fixture.document, scenes: [{ nodes: [0, 0] }] })).toThrow()
    expect(() => fixtureGeometry({ ...fixture.document, nodes: [{ children: [1] }, { mesh: 0 }], scenes: [{ nodes: [1] }] })).toThrow()
  })

  test("GLB snapshots detach source bytes and repeated evaluation has no mutable shared state", () => {
    const fixture = triangleFixture(), bytes = envelope(fixture.document, fixture.binary), model = parseSpatialGlb(bytes)
    const before = evaluateSpatialGlb(model, options); bytes.fill(0)
    expect(evaluateSpatialGlb(model, options)).toEqual(before)
    expect(Object.isFrozen(model)).toBe(true)
  })

  test("embedded PNG bytes, source texture sampler and image dimensions remain exact and detached", () => {
    const fixture = textureFixture(), model = parseSpatialGlb(envelope(fixture.document, fixture.binary))
    const result = evaluateSpatialGlb(model, { ...options, materialMode: "source" })
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({ imageIndex: 0, width: 1, height: 1, mimeType: "image/png" })
    expect(result.images[0]!.bytes).toEqual(originalPng())
    expect(result.primitives[0]!.material!.baseColorTexture).toEqual({ imageIndex: 0, sampler: { wrapS: 33648, wrapT: 10497, magFilter: 9728, minFilter: 9987 } })
    result.images[0]!.bytes.fill(0)
    expect(evaluateSpatialGlb(model, { ...options, materialMode: "source" }).images[0]!.bytes).toEqual(originalPng())
    expect(evaluateSpatialGlb(model, options).images).toEqual([])
  })

  test("original JPEG fixture validates MIME and dimensions without decoding or contacting a loader", async () => {
    const sharp = (await import("sharp")).default
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: { r: 20, g: 40, b: 80 } } }).jpeg().toBuffer()
    const fixture = textureFixture(image, "image/jpeg")
    const result = evaluateSpatialGlb(parseSpatialGlb(envelope(fixture.document, fixture.binary)), { ...options, materialMode: "source" })
    expect(result.images[0]).toMatchObject({ width: 2, height: 3, mimeType: "image/jpeg" })
    expect(result.images[0]!.bytes).toEqual(new Uint8Array(image))
  })

  test("texture indirection, UVs, MIME signatures and oversized image headers fail closed", () => {
    const fixture = textureFixture()
    for (const patch of [
      { textures: [{ source: 8 }] }, { textures: [{ source: 0, sampler: 4 }] },
      { images: [{ bufferView: 4, mimeType: "image/jpeg" }] },
      { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 3, material: 0 }] }] },
      { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } } }] },
      { images: [{ bufferView: 0, mimeType: "image/png" }] },
      { bufferViews: [...fixture.document.bufferViews.slice(0, 4), { ...fixture.document.bufferViews[4], byteStride: 4 }] },
    ]) expect(() => parseSpatialGlb(envelope({ ...fixture.document, ...patch }, fixture.binary))).toThrow()
    const image = originalPng(); new DataView(image.buffer).setUint32(16, 8193)
    const huge = textureFixture(image)
    expect(() => parseSpatialGlb(envelope(huge.document, huge.binary))).toThrow()
    const truncated = textureFixture(originalPng().slice(0, -1))
    expect(() => parseSpatialGlb(envelope(truncated.document, truncated.binary))).toThrow()
  })

  test("interleaved vertex data and normalized unsigned UVs obey explicit stride and component rules", () => {
    const fixture = triangleFixture(), binary = new Uint8Array(100), data = new DataView(binary.buffer)
    const positions = [[0, 0, 0], [2, 0, 0], [0, 3, 0]], uv = [[0, 0], [255, 0], [0, 255]]
    for (let i = 0; i < 3; i++) {
      positions[i]!.forEach((value, axis) => data.setFloat32(i * 32 + axis * 4, value, true))
      data.setFloat32(i * 32 + 20, 1, true); binary[i * 32 + 24] = uv[i]![0]!; binary[i * 32 + 25] = uv[i]![1]!
    }
    const document = { ...fixture.document, buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96, byteStride: 32, target: 34962 }],
      accessors: [{ ...fixture.document.accessors[0], byteOffset: 0 }, { ...fixture.document.accessors[1], bufferView: 0, byteOffset: 12 }, { ...fixture.document.accessors[2], bufferView: 0, byteOffset: 24, componentType: 5121, normalized: true }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }] }
    const result = fixtureGeometry(document, binary)
    expect(result.primitives[0]!.uvs).toEqual([0, 0, 1, 0, 0, 1])
    expect(result.primitives[0]!.normals).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
    expect(() => fixtureGeometry({ ...document, bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }] }, binary)).toThrow()
  })

  test("property mutations outside accessor bounds are rejected reproducibly", () => {
    fc.assert(fc.property(fc.integer({ min: 105, max: 100_000 }), byteOffset => {
      const fixture = triangleFixture()
      const document = { ...fixture.document, accessors: [{ ...fixture.document.accessors[0], byteOffset }, ...fixture.document.accessors.slice(1)] }
      expect(() => parseSpatialGlb(envelope(document, fixture.binary))).toThrow()
    }), { seed: 4252, numRuns: 100 })
  })
})

describe("absolute-time embedded glTF clips", () => {
  test("LINEAR TRS and shortest-arc rotations sample independently and retain clip provenance", () => {
    const fixture = animationFixture(), model = parseSpatialGlb(envelope(fixture.document, fixture.binary))
    const clip = { index: 0, offsetUs: 0, playback: "once" as const }
    const mid = evaluateSpatialGlb(model, { ...options, clip, timeUs: 500_000 })
    expect(model.clipDurationsSeconds).toEqual([1])
    expect(mid.sourceTimeSeconds).toBe(0.5)
    expect(mid.primitives[0]!.matrix.slice(12, 15)).toEqual([5, 10, 15])
    expect(mid.primitives[0]!.matrix[0]).toBeCloseTo(0, 10)
    expect(mid.primitives[0]!.matrix[2]).toBeCloseTo(-1.5, 10)
    expect(evaluateSpatialGlb(model, { ...options, clip, timeUs: 1_000_000 }).primitives[0]!.matrix.slice(12, 15)).toEqual([10, 20, 30])
    expect(evaluateSpatialGlb(model, { ...options, clip, timeUs: 500_000 })).toEqual(mid)
    expect(evaluateSpatialGlb(model, options).sourceTimeSeconds).toBeNull()
  })

  test("STEP keys, once, loop, freeze and offset boundaries are explicit", () => {
    const fixture = animationFixture(), clip = fixture.document.animations[0]!
    const document = { ...fixture.document, animations: [{ ...clip, samplers: clip.samplers.map(sampler => ({ ...sampler, interpolation: "STEP" })) }] }
    const model = parseSpatialGlb(envelope(document, fixture.binary))
    const base = { ...options, clip: { index: 0, offsetUs: 0, playback: "once" as const } }
    expect(evaluateSpatialGlb(model, { ...base, timeUs: 999_999 }).primitives[0]!.matrix.slice(12, 15)).toEqual([0, 0, 0])
    expect(evaluateSpatialGlb(model, { ...base, timeUs: 1_000_000 }).primitives[0]!.matrix.slice(12, 15)).toEqual([10, 20, 30])
    expect(() => evaluateSpatialGlb(model, { ...base, timeUs: 1_000_001 })).toThrow()
    expect(evaluateSpatialGlb(model, { ...base, timeUs: 1_000_000, clip: { ...base.clip, playback: "loop" } }).sourceTimeSeconds).toBe(0)
    expect(evaluateSpatialGlb(model, { ...base, timeUs: 2_000_000, clip: { ...base.clip, playback: "freeze" } }).sourceTimeSeconds).toBe(1)
    expect(evaluateSpatialGlb(model, { ...base, timeUs: 500_000, clip: { ...base.clip, offsetUs: 500_000 } }).sourceTimeSeconds).toBe(1)
    expect(() => evaluateSpatialGlb(model, { ...base, clip: { ...base.clip, offsetUs: 1_000_001 } })).toThrow()
  })

  test("clip references, duplicate writers, matrix targets, negative times and scale crossings reject", () => {
    const fixture = animationFixture(), clip = fixture.document.animations[0]!
    for (const channels of [[...clip.channels, clip.channels[0]], [{ sampler: 99, target: { node: 0, path: "translation" } }], [{ sampler: 0, target: { node: 99, path: "translation" } }], [{ sampler: 0, target: { node: 0, path: "rotation" } }]]) expect(() => fixtureGeometry({ ...fixture.document, animations: [{ ...clip, channels }] }, fixture.binary)).toThrow()
    const time = fixture.binary.slice(); new DataView(time.buffer).setFloat32(104, -1, true)
    expect(() => fixtureGeometry(fixture.document, time)).toThrow()
    const scale = fixture.binary.slice(); new DataView(scale.buffer).setFloat32(180, -2, true)
    expect(() => fixtureGeometry(fixture.document, scale)).toThrow()
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    expect(() => fixtureGeometry({ ...fixture.document, nodes: [{ mesh: 0, matrix }] }, fixture.binary)).toThrow()
  })

  test("random reverse-order clip samples obey translation and immutable replay laws", () => {
    const fixture = animationFixture(), model = parseSpatialGlb(envelope(fixture.document, fixture.binary)), clip = { index: 0, offsetUs: 0, playback: "once" as const }
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), timeUs => {
      const a = evaluateSpatialGlb(model, { ...options, clip, timeUs })
      evaluateSpatialGlb(model, { ...options, clip, timeUs: 1_000_000 - timeUs })
      expect(evaluateSpatialGlb(model, { ...options, clip, timeUs })).toEqual(a)
      expect(a.primitives[0]!.matrix[12]).toBeCloseTo(timeUs / 100_000, 10)
    }), { seed: 4251, numRuns: 100 })
  })
})
