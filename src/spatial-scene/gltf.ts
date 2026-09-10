import { z } from "zod"
import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../code/json-snapshot.js"
import { SpatialSceneError } from "./identity.js"
import { composeTransform, invertTransform, multiplyTransforms, normalizeQuaternion, slerpQuaternion, transformPoint, type Bounds, type Mat4, type Quaternion, type Vec3 } from "./math.js"

/** Deliberately closed GLB 2.0 profile. It is not a general glTF loader. */
export const SPATIAL_GLB_PROFILE = "slopcamera.glb-triangles-trs-pbr-basecolor-v1"
export const SPATIAL_GLB_LIMITS = Object.freeze({
  bytes: 134_217_728, jsonBytes: 2_097_152, jsonValues: 200_000, jsonDepth: 32,
  nodes: 4096, meshes: 256, primitives: 256, verticesPerPrimitive: 65_536,
  triangles: 100_000, decodedAccessorValues: 2_000_000,
  accessors: 4096, bufferViews: 4096, materials: 256, images: 128,
  imageBytes: 16_777_216, imageTotalBytes: 33_554_432, imagePixels: 67_108_864,
  clips: 256, channels: 4096, animationKeys: 4096, durationSeconds: 3600,
})

const finite = z.number().finite().min(-1e6).max(1e6)
const index = z.number().int().min(0).max(65_535)
const unit = z.number().finite().min(0).max(1)
const vec3 = z.tuple([finite, finite, finite])
const signedUnit = z.number().finite().min(-1).max(1)
const quaternion = z.tuple([signedUnit, signedUnit, signedUnit, signedUnit])
const metadata = { name: z.string().max(1024).optional(), extras: z.unknown().optional(), extensions: z.never().optional() }
const byteOffset = z.number().int().min(0).max(SPATIAL_GLB_LIMITS.bytes)
const textureInfo = z.strictObject({ ...metadata, index, texCoord: z.literal(0).optional() })
const samplerSchema = z.strictObject({
  ...metadata, magFilter: z.union([z.literal(9728), z.literal(9729)]).optional(),
  minFilter: z.union([z.literal(9728), z.literal(9729), z.literal(9984), z.literal(9985), z.literal(9986), z.literal(9987)]).optional(),
  wrapS: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]).default(10497),
  wrapT: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]).default(10497),
})
const nodeSchema = z.strictObject({
  ...metadata, children: z.array(index).max(SPATIAL_GLB_LIMITS.nodes).default([]), mesh: index.optional(),
  translation: vec3.optional(), rotation: quaternion.optional(), scale: vec3.optional(),
  matrix: z.array(finite).length(16).optional(),
})
const accessorSchema = z.strictObject({
  ...metadata, bufferView: index, byteOffset: byteOffset.default(0),
  componentType: z.union([z.literal(5121), z.literal(5123), z.literal(5125), z.literal(5126)]),
  normalized: z.boolean().default(false), count: z.number().int().min(1).max(SPATIAL_GLB_LIMITS.triangles * 3),
  type: z.enum(["SCALAR", "VEC2", "VEC3", "VEC4"]), min: z.array(finite).min(1).max(4).optional(), max: z.array(finite).min(1).max(4).optional(),
})
const gltfSchema = z.strictObject({
  ...metadata,
  asset: z.strictObject({ version: z.literal("2.0"), minVersion: z.literal("2.0").optional(), generator: z.string().max(1024).optional(), copyright: z.string().max(4096).optional(), extras: z.unknown().optional(), extensions: z.never().optional() }),
  extensionsUsed: z.array(z.never()).optional(), extensionsRequired: z.array(z.never()).optional(),
  buffers: z.array(z.strictObject({ ...metadata, byteLength: z.number().int().min(1).max(SPATIAL_GLB_LIMITS.bytes) })).length(1),
  bufferViews: z.array(z.strictObject({ ...metadata, buffer: z.literal(0), byteOffset: byteOffset.default(0), byteLength: z.number().int().min(1).max(SPATIAL_GLB_LIMITS.bytes), byteStride: z.number().int().min(4).max(252).optional(), target: z.union([z.literal(34962), z.literal(34963)]).optional() })).max(SPATIAL_GLB_LIMITS.bufferViews),
  accessors: z.array(accessorSchema).max(SPATIAL_GLB_LIMITS.accessors),
  scene: index.optional(), scenes: z.array(z.strictObject({ ...metadata, nodes: z.array(index).min(1).max(SPATIAL_GLB_LIMITS.nodes) })).min(1).max(128),
  nodes: z.array(nodeSchema).min(1).max(SPATIAL_GLB_LIMITS.nodes),
  meshes: z.array(z.strictObject({ ...metadata, primitives: z.array(z.strictObject({
    ...metadata, attributes: z.strictObject({ POSITION: index, NORMAL: index.optional(), TEXCOORD_0: index.optional() }),
    indices: index.optional(), material: index.optional(), mode: z.literal(4).default(4),
  })).min(1).max(SPATIAL_GLB_LIMITS.primitives) })).min(1).max(SPATIAL_GLB_LIMITS.meshes),
  materials: z.array(z.strictObject({
    ...metadata, pbrMetallicRoughness: z.strictObject({ ...metadata, baseColorFactor: z.tuple([unit, unit, unit, unit]).default([1, 1, 1, 1]), metallicFactor: unit.default(1), roughnessFactor: unit.default(1), baseColorTexture: textureInfo.optional() }).optional(),
    alphaMode: z.enum(["OPAQUE", "MASK", "BLEND"]).default("OPAQUE"), alphaCutoff: unit.default(0.5), doubleSided: z.boolean().default(false),
    emissiveFactor: z.tuple([z.literal(0), z.literal(0), z.literal(0)]).optional(),
  })).max(SPATIAL_GLB_LIMITS.materials).default([]),
  images: z.array(z.strictObject({ ...metadata, bufferView: index, mimeType: z.enum(["image/png", "image/jpeg"]) })).max(SPATIAL_GLB_LIMITS.images).default([]),
  textures: z.array(z.strictObject({ ...metadata, source: index, sampler: index.optional() })).max(SPATIAL_GLB_LIMITS.images).default([]),
  samplers: z.array(samplerSchema).max(SPATIAL_GLB_LIMITS.images).default([]),
  animations: z.array(z.strictObject({ ...metadata,
    samplers: z.array(z.strictObject({ ...metadata, input: index, output: index, interpolation: z.enum(["STEP", "LINEAR"]).default("LINEAR") })).min(1).max(SPATIAL_GLB_LIMITS.channels),
    channels: z.array(z.strictObject({ ...metadata, sampler: index, target: z.strictObject({ ...metadata, node: index, path: z.enum(["translation", "rotation", "scale"]) }) })).min(1).max(SPATIAL_GLB_LIMITS.channels),
  })).max(SPATIAL_GLB_LIMITS.clips).default([]),
})
type Gltf = z.infer<typeof gltfSchema>
type Accessor = z.infer<typeof accessorSchema>
type Sampler = z.infer<typeof samplerSchema>

export interface SpatialGlbSampler {
  readonly wrapS: 33071 | 33648 | 10497
  readonly wrapT: 33071 | 33648 | 10497
  readonly magFilter?: 9728 | 9729
  readonly minFilter?: 9728 | 9729 | 9984 | 9985 | 9986 | 9987
}
export interface SpatialGlbMaterial {
  readonly baseColorLinear: readonly [number, number, number, number]
  readonly metalness: number
  readonly roughness: number
  readonly alphaMode: "OPAQUE" | "MASK" | "BLEND"
  readonly alphaCutoff: number
  readonly doubleSided: boolean
  readonly baseColorTexture?: { readonly imageIndex: number; readonly sampler: SpatialGlbSampler }
}
export interface SpatialGlbPrimitive {
  readonly positions: readonly number[]
  readonly normals?: readonly number[]
  readonly uvs?: readonly number[]
  readonly indices?: readonly number[]
  readonly matrix: Mat4
  readonly sourceNodeIndex: number
  readonly sourcePrimitiveIndex: number
  readonly bounds: Bounds
  readonly material?: SpatialGlbMaterial
}
export interface SpatialGlbImage {
  readonly imageIndex: number
  readonly mimeType: "image/png" | "image/jpeg"
  readonly width: number
  readonly height: number
  /** A fresh detached copy on each evaluation; the host must fully decode before admission. */
  readonly bytes: Uint8Array
}
export interface SpatialGlbGeometry {
  readonly profile: typeof SPATIAL_GLB_PROFILE
  readonly primitives: readonly SpatialGlbPrimitive[]
  readonly images: readonly SpatialGlbImage[]
  readonly bounds: Bounds
  readonly sourceTimeSeconds: number | null
}
export interface SpatialGlbEvaluateOptions {
  readonly metersPerUnit: number
  readonly sourceUp: "x" | "y" | "z"
  readonly nodeIndex?: number
  readonly materialMode?: "source" | "entity"
  readonly timeUs: number
  readonly clip?: { readonly index: number; readonly offsetUs: number; readonly playback: "once" | "loop" | "freeze" }
}
const optionsSchema = z.strictObject({
  metersPerUnit: z.number().finite().min(0.000001).max(1e6), sourceUp: z.enum(["x", "y", "z"]), nodeIndex: index.optional(), materialMode: z.enum(["source", "entity"]).default("entity"),
  timeUs: z.number().int().min(0).max(3_600_000_000),
  clip: z.strictObject({ index, offsetUs: z.number().int().min(0).max(3_600_000_000), playback: z.enum(["once", "loop", "freeze"]) }).optional(),
})

function fail(message: string, path = "glb"): never { throw new SpatialSceneError("invalid-data", `${SPATIAL_GLB_PROFILE}: ${message}`, path) }
function at<T>(array: readonly T[], index: number, path: string): T {
  return array[index] ?? fail(`Missing index ${index}.`, path)
}
function schemaValue<S extends z.ZodType>(schema: S, input: unknown, name: string): z.infer<S> {
  const captured = createBoundedJsonValueSnapshot(input, SPATIAL_GLB_LIMITS.jsonBytes, name, { maximumDepth: SPATIAL_GLB_LIMITS.jsonDepth, maximumValues: SPATIAL_GLB_LIMITS.jsonValues })
  const result = schema.safeParse(captured.value)
  if (!result.success) {
    const issue = result.error.issues[0]
    return fail(`Unsupported or invalid field: ${issue?.message ?? "invalid data"}.`, `${name}.${issue?.path.join(".") ?? ""}`)
  }
  return result.data
}
function normalizedRotation(value: readonly number[], path: string): Quaternion {
  if (value.length !== 4 || Math.abs(Math.hypot(...value) - 1) > 1e-5) fail("Rotation must be a unit XYZW quaternion.", path)
  return normalizeQuaternion(value as Quaternion)
}
function safeMatrix(value: Mat4, path: string): Mat4 {
  try { invertTransform(value) } catch { fail("Node transform must be an invertible affine matrix.", path) }
  return value
}
function nodeTransform(node: { readonly translation?: Vec3 | undefined; readonly rotation?: Quaternion | undefined; readonly scale?: Vec3 | undefined; readonly matrix?: readonly number[] | undefined }, path: string): Mat4 {
  if (node.matrix) {
    if (node.translation || node.rotation || node.scale) fail("Node matrix and TRS cannot be combined.", path)
    const matrix = safeMatrix(Object.freeze([...node.matrix]) as Mat4, path)
    // glTF node matrices must decompose into TRS. Reject shear instead of changing it.
    const axes = [[matrix[0], matrix[1], matrix[2]], [matrix[4], matrix[5], matrix[6]], [matrix[8], matrix[9], matrix[10]]]
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const left = axes[a]!, right = axes[b]!
      const dot = left.reduce((sum, value, i) => sum + value * right[i]!, 0)
      if (Math.abs(dot) > Math.hypot(...left) * Math.hypot(...right) * 1e-6) fail("Node matrix contains unsupported shear.", path)
    }
    return matrix
  }
  const rotation = normalizedRotation(node.rotation ?? [0, 0, 0, 1], path)
  return safeMatrix(composeTransform({ position: node.translation ?? [0, 0, 0], rotation, scale: node.scale ?? [1, 1, 1] }), path)
}

function imageHeader(bytes: Uint8Array, mimeType: SpatialGlbImage["mimeType"]): { width: number; height: number } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0
  if (mimeType === "image/png") {
    if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, i) => bytes[i] !== value)) fail("Embedded image MIME does not match a PNG signature.")
    let cursor = 8, chunks = 0, hasData = false, ended = false
    while (cursor < bytes.length) {
      if (++chunks > 65_536 || cursor + 12 > bytes.length) fail("Malformed PNG chunk envelope.")
      const length = data.getUint32(cursor), type = data.getUint32(cursor + 4)
      if (length > bytes.length - cursor - 12) fail("PNG chunk exceeds its image view.")
      if (cursor === 8) {
        if (type !== 0x49484452 || length !== 13) fail("PNG must begin with IHDR.")
        width = data.getUint32(cursor + 8); height = data.getUint32(cursor + 12)
      } else if (type === 0x49484452) fail("Duplicate PNG IHDR.")
      if (type === 0x6163544c) fail("Animated PNG textures are unsupported.")
      if (type === 0x49444154) hasData = true
      cursor += 12 + length
      if (type === 0x49454e44) {
        if (length !== 0 || cursor !== bytes.length) fail("PNG IEND must end its image view.")
        ended = true; break
      }
    }
    if (!hasData || !ended) fail("PNG requires IDAT and IEND chunks.")
  } else {
    if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail("Embedded image MIME does not match a complete JPEG envelope.")
    let cursor = 2, segments = 0
    while (cursor + 4 <= bytes.length) {
      if (++segments > 65_536 || bytes[cursor++] !== 0xff) fail("Malformed JPEG marker.")
      while (bytes[cursor] === 0xff) cursor++
      const marker = bytes[cursor++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) fail("Unexpected JPEG standalone marker.")
      if (cursor + 2 > bytes.length) fail("Truncated JPEG segment.")
      const length = data.getUint16(cursor)
      if (length < 2 || cursor + length > bytes.length) fail("JPEG segment exceeds its image view.")
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (width !== 0 || length < 8 || bytes[cursor + 2] !== 8 || ![1, 3].includes(bytes[cursor + 7]!)) fail("JPEG requires one 8-bit grayscale or RGB frame.")
        height = data.getUint16(cursor + 3); width = data.getUint16(cursor + 5)
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) fail("JPEG frame encoding is unsupported.")
      cursor += length
    }
  }
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > SPATIAL_GLB_LIMITS.imagePixels) fail("Embedded image dimensions exceed the decoded pixel profile.")
  return { width, height }
}

interface DecodedAccessor { readonly source: Accessor; readonly values: readonly number[]; readonly components: number }
interface PrimitiveData { readonly positions: readonly number[]; readonly normals?: readonly number[]; readonly uvs?: readonly number[]; readonly indices?: readonly number[]; readonly material: SpatialGlbMaterial }
interface ModelState {
  readonly document: Gltf
  readonly accessors: readonly DecodedAccessor[]
  readonly meshPrimitives: readonly (readonly PrimitiveData[])[]
  readonly images: readonly SpatialGlbImage[]
  readonly parents: readonly (number | null)[]
  readonly order: readonly number[]
  readonly reachable: ReadonlySet<number>
  readonly clipDurations: readonly number[]
}

function readAccessors(document: Gltf, binary: Uint8Array): readonly DecodedAccessor[] {
  let totalValues = 0
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  for (const [index, view] of document.bufferViews.entries()) {
    if (view.byteOffset + view.byteLength > document.buffers[0]!.byteLength) fail("Buffer view exceeds the declared BIN payload.", `bufferViews.${index}`)
    if (view.byteStride !== undefined && view.byteStride % 4 !== 0) fail("Vertex stride must be a multiple of four.", `bufferViews.${index}`)
  }
  return Object.freeze(document.accessors.map((accessor, index) => {
    const path = `accessors.${index}`
    const view = at(document.bufferViews, accessor.bufferView, path)
    const bytes = accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : 4
    const components = accessor.type === "SCALAR" ? 1 : Number(accessor.type.slice(3))
    const stride = view.byteStride ?? components * bytes
    if (accessor.byteOffset % bytes !== 0 || (view.byteOffset + accessor.byteOffset) % bytes !== 0 || stride < components * bytes || stride % bytes !== 0) fail("Accessor alignment or stride is invalid.", path)
    if (accessor.byteOffset + (accessor.count - 1) * stride + components * bytes > view.byteLength) fail("Accessor exceeds its buffer view.", path)
    if (accessor.normalized && (accessor.componentType === 5125 || accessor.componentType === 5126)) fail("Only unsigned byte/short UVs support normalized storage in this profile.", path)
    totalValues += accessor.count * components
    if (totalValues > SPATIAL_GLB_LIMITS.decodedAccessorValues) fail("Decoded accessor budget exceeded.", path)
    const values: number[] = []
    const low = new Array<number>(components).fill(Infinity), high = new Array<number>(components).fill(-Infinity)
    for (let element = 0; element < accessor.count; element++) for (let component = 0; component < components; component++) {
      const offset = view.byteOffset + accessor.byteOffset + element * stride + component * bytes
      const raw = accessor.componentType === 5121 ? data.getUint8(offset) : accessor.componentType === 5123 ? data.getUint16(offset, true) : accessor.componentType === 5125 ? data.getUint32(offset, true) : data.getFloat32(offset, true)
      if (!Number.isFinite(raw)) fail("Accessor contains nonfinite data.", path)
      low[component] = Math.min(low[component]!, raw); high[component] = Math.max(high[component]!, raw)
      values.push(accessor.normalized ? raw / (accessor.componentType === 5121 ? 255 : 65535) : raw)
    }
    for (const [declared, computed, label] of [[accessor.min, low, "min"], [accessor.max, high, "max"]] as const) {
      if (declared !== undefined && (declared.length !== components || declared.some((value, component) => Math.abs(value - computed[component]!) > 1e-6 * Math.max(1, Math.abs(value))))) fail(`Accessor ${label} does not match decoded values.`, path)
    }
    return Object.freeze({ source: accessor, components, values: Object.freeze(values) })
  }))
}

function validateViewRoles(document: Gltf): void {
  const roles = new Map<number, string>(), vertexAccessors = new Map<number, Set<number>>()
  const assign = (viewIndex: number, role: string) => {
    const previous = roles.get(viewIndex)
    if (previous !== undefined && previous !== role) fail(`Buffer view mixes ${previous} and ${role} data.`, `bufferViews.${viewIndex}`)
    roles.set(viewIndex, role)
  }
  const accessor = (index: number, role: string) => {
    const source = at(document.accessors, index, "accessors")
    assign(source.bufferView, role)
    if (role === "vertex") {
      const ids = vertexAccessors.get(source.bufferView) ?? new Set<number>()
      ids.add(index); vertexAccessors.set(source.bufferView, ids)
    }
  }
  for (const mesh of document.meshes) for (const primitive of mesh.primitives) {
    for (const index of Object.values(primitive.attributes)) if (index !== undefined) accessor(index, "vertex")
    if (primitive.indices !== undefined) accessor(primitive.indices, "index")
  }
  for (const clip of document.animations) for (const sampler of clip.samplers) { accessor(sampler.input, "animation"); accessor(sampler.output, "animation") }
  for (const image of document.images) assign(image.bufferView, "image")
  for (const [viewIndex, ids] of vertexAccessors) if (ids.size > 1 && at(document.bufferViews, viewIndex, "bufferViews").byteStride === undefined) fail("Shared vertex-attribute views require an explicit stride.", `bufferViews.${viewIndex}`)
}

function cleanSampler(sampler: Sampler | undefined): SpatialGlbSampler {
  return Object.freeze({ wrapS: sampler?.wrapS ?? 10497, wrapT: sampler?.wrapT ?? 10497,
    ...(sampler?.magFilter === undefined ? {} : { magFilter: sampler.magFilter }), ...(sampler?.minFilter === undefined ? {} : { minFilter: sampler.minFilter }) })
}
function materials(document: Gltf): readonly SpatialGlbMaterial[] {
  for (const texture of document.textures) {
    at(document.images, texture.source, "textures.source")
    if (texture.sampler !== undefined) at(document.samplers, texture.sampler, "textures.sampler")
  }
  return deepFreezeJson(document.materials.map(material => {
    const pbr = material.pbrMetallicRoughness
    const texture = pbr?.baseColorTexture === undefined ? undefined : at(document.textures, pbr.baseColorTexture.index, "baseColorTexture")
    return {
      baseColorLinear: pbr?.baseColorFactor ?? [1, 1, 1, 1] as const, metalness: pbr?.metallicFactor ?? 1, roughness: pbr?.roughnessFactor ?? 1,
      alphaMode: material.alphaMode, alphaCutoff: material.alphaCutoff, doubleSided: material.doubleSided,
      ...(texture === undefined ? {} : { baseColorTexture: { imageIndex: texture.source, sampler: cleanSampler(texture.sampler === undefined ? undefined : document.samplers[texture.sampler]) } }),
    }
  }))
}

function readMeshes(document: Gltf, accessors: readonly DecodedAccessor[]): readonly (readonly PrimitiveData[])[] {
  const sources = materials(document)
  const defaultMaterial: SpatialGlbMaterial = { baseColorLinear: [1, 1, 1, 1], metalness: 1, roughness: 1, alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false }
  let primitiveCount = 0, triangles = 0
  return deepFreezeJson(document.meshes.map((mesh, meshIndex) => mesh.primitives.map((primitive, primitiveIndex) => {
    const path = `meshes.${meshIndex}.primitives.${primitiveIndex}`
    if (++primitiveCount > SPATIAL_GLB_LIMITS.primitives) fail("Source primitive count exceeds this profile.", path)
    const positions = at(accessors, primitive.attributes.POSITION, path)
    const normals = primitive.attributes.NORMAL === undefined ? undefined : at(accessors, primitive.attributes.NORMAL, path)
    const uvs = primitive.attributes.TEXCOORD_0 === undefined ? undefined : at(accessors, primitive.attributes.TEXCOORD_0, path)
    const indices = primitive.indices === undefined ? undefined : at(accessors, primitive.indices, path)
    if (positions.source.type !== "VEC3" || positions.source.componentType !== 5126 || positions.source.normalized || positions.source.min === undefined || positions.source.max === undefined || positions.source.count > SPATIAL_GLB_LIMITS.verticesPerPrimitive) fail("POSITION requires bounded float32 VEC3 with declared min/max.", path)
    for (const attribute of [positions, normals, uvs]) if (attribute !== undefined) {
      const view = document.bufferViews[attribute.source.bufferView]!
      if ((view.byteOffset + attribute.source.byteOffset) % 4 !== 0 || attribute.source.byteOffset % 4 !== 0 || (view.target !== undefined && view.target !== 34962)) fail("Vertex attributes require four-byte alignment and ARRAY_BUFFER target.", path)
      const componentBytes = attribute.source.componentType === 5121 ? 1 : attribute.source.componentType === 5123 ? 2 : 4
      if ((view.byteStride ?? attribute.components * componentBytes) % 4 !== 0) fail("Every vertex attribute element must remain four-byte aligned.", path)
      if (attribute.source.count !== positions.source.count || attribute.values.some(value => Math.abs(value) > 1e6)) fail("Vertex attributes require matching counts and bounded coordinates.", path)
    }
    if (normals) {
      if (normals.source.type !== "VEC3" || normals.source.componentType !== 5126 || normals.source.normalized) fail("NORMAL requires float32 VEC3.", path)
      for (let i = 0; i < normals.values.length; i += 3) if (Math.abs(Math.hypot(...normals.values.slice(i, i + 3)) - 1) > 1e-4) fail("Normals must be unit vectors.", path)
    }
    if (uvs && (uvs.source.type !== "VEC2" || (uvs.source.componentType !== 5126 && !([5121, 5123].includes(uvs.source.componentType) && uvs.source.normalized)))) fail("TEXCOORD_0 requires float32 or normalized unsigned byte/short VEC2.", path)
    if (indices) {
      const view = document.bufferViews[indices.source.bufferView]!
      if (indices.source.type !== "SCALAR" || ![5121, 5123, 5125].includes(indices.source.componentType) || indices.source.normalized || view.byteStride !== undefined || (view.target !== undefined && view.target !== 34963)) fail("Triangle indices require tightly packed unsigned scalar storage.", path)
      const restart = indices.source.componentType === 5121 ? 255 : indices.source.componentType === 5123 ? 65535 : 0xffffffff
      if (indices.values.some(value => value >= positions.source.count || value === restart)) fail("Triangle index is out of range or reserved for primitive restart.", path)
    }
    const vertices = indices?.values.length ?? positions.source.count
    if (vertices % 3 !== 0) fail("TRIANGLES require complete index or vertex triples.", path)
    triangles += vertices / 3
    if (triangles > SPATIAL_GLB_LIMITS.triangles) fail("Source triangle budget exceeded.", path)
    const material = primitive.material === undefined ? defaultMaterial : at(sources, primitive.material, path)
    if (material.baseColorTexture && uvs === undefined) fail("Base-color textures require TEXCOORD_0.", path)
    return { positions: positions.values, ...(normals === undefined ? {} : { normals: normals.values }), ...(uvs === undefined ? {} : { uvs: uvs.values }), ...(indices === undefined ? {} : { indices: indices.values }), material }
  })))
}

function hierarchy(document: Gltf) {
  const parents: (number | null)[] = document.nodes.map(() => null)
  for (const [index, node] of document.nodes.entries()) {
    nodeTransform(node, `nodes.${index}`)
    if (node.mesh !== undefined) at(document.meshes, node.mesh, `nodes.${index}.mesh`)
    const seen = new Set<number>()
    for (const child of node.children) {
      at(document.nodes, child, `nodes.${index}.children`)
      if (seen.has(child) || parents[child] !== null) fail("Nodes may have only one parent and unique child references.", `nodes.${index}`)
      seen.add(child); parents[child] = index
    }
  }
  const roots = document.nodes.map((_, index) => index).filter(index => parents[index] === null)
  const order: number[] = [], seen = new Set<number>(), pending = [...roots]
  while (pending.length) {
    const index = pending.pop()!
    if (seen.has(index)) fail("Node hierarchy contains a cycle.")
    seen.add(index); order.push(index); pending.push(...document.nodes[index]!.children)
  }
  if (seen.size !== document.nodes.length) fail("Node hierarchy contains a cycle.")
  for (const scene of document.scenes) {
    const unique = new Set<number>()
    for (const index of scene.nodes) {
      at(document.nodes, index, "scenes.nodes")
      if (parents[index] !== null || unique.has(index)) fail("Scene roots must be unique nodes without parents.")
      unique.add(index)
    }
  }
  if (document.scene === undefined && document.scenes.length !== 1) fail("Multiple scenes require an explicit glTF default scene.")
  const scene = at(document.scenes, document.scene ?? 0, "scene")
  const reachable = new Set<number>(), visit = [...scene.nodes]
  while (visit.length) { const index = visit.pop()!; reachable.add(index); visit.push(...document.nodes[index]!.children) }
  return { parents: Object.freeze(parents), order: Object.freeze(order), reachable }
}

function animationDurations(document: Gltf, accessors: readonly DecodedAccessor[]): readonly number[] {
  let totalChannels = 0
  return Object.freeze(document.animations.map((clip, clipIndex) => {
    totalChannels += clip.channels.length
    if (totalChannels > SPATIAL_GLB_LIMITS.channels) fail("Animation channel budget exceeded.")
    let duration = 0
    for (const sampler of clip.samplers) {
      const input = at(accessors, sampler.input, "animation input"), output = at(accessors, sampler.output, "animation output")
      if (input.source.type !== "SCALAR" || input.source.componentType !== 5126 || input.source.normalized || input.source.count > SPATIAL_GLB_LIMITS.animationKeys || input.source.min === undefined || input.source.max === undefined) fail("Animation input requires bounded float32 scalar seconds with min/max.")
      if (output.source.componentType !== 5126 || output.source.normalized || output.source.count !== input.source.count) fail("Animation output must be float32 with matching key count.")
      for (const accessor of [input, output]) {
        const view = document.bufferViews[accessor.source.bufferView]!
        if (view.byteStride !== undefined || view.target !== undefined) fail("Animation data must be tightly packed without a GPU buffer target.")
      }
      let previous = -1
      for (const time of input.values) {
        if (time < 0 || time <= previous || time > SPATIAL_GLB_LIMITS.durationSeconds) fail("Animation times must be strictly ordered nonnegative seconds within the duration profile.")
        previous = time
      }
      duration = Math.max(duration, previous)
    }
    const writers = new Set<string>()
    for (const channel of clip.channels) {
      const node = at(document.nodes, channel.target.node, "animation target")
      if (node.matrix) fail("Animated nodes must use TRS, never a matrix.")
      const key = `${channel.target.node}:${channel.target.path}`
      if (writers.has(key)) fail("Animation has multiple writers for one node property.", `animations.${clipIndex}`)
      writers.add(key)
      const sampler = at(clip.samplers, channel.sampler, "animation sampler")
      const output = accessors[sampler.output]!
      if (output.source.type !== (channel.target.path === "rotation" ? "VEC4" : "VEC3")) fail("Animation output arity does not match its target property.")
      if (channel.target.path === "rotation") for (let i = 0; i < output.values.length; i += 4) normalizedRotation(output.values.slice(i, i + 4), "animation rotation")
      else if (output.values.some(value => Math.abs(value) > 1e6 || (channel.target.path === "scale" && value === 0))) fail("Animation transform values are unbounded or singular.")
      if (channel.target.path === "scale" && sampler.interpolation === "LINEAR") for (let i = 3; i < output.values.length; i++) if (Math.sign(output.values[i]!) !== Math.sign(output.values[i - 3]!)) fail("Linear scale animation crosses a singular transform.")
    }
    return duration
  }))
}

/** Opaque model retains decoded authored data; callers cannot mutate its geometry or source images. */
export class SpatialGlbModel {
  readonly profile = SPATIAL_GLB_PROFILE
  readonly nodeCount: number
  readonly clipDurationsSeconds: readonly number[]
  readonly #state: ModelState

  private constructor(state: ModelState) {
    this.#state = state
    this.nodeCount = state.document.nodes.length
    this.clipDurationsSeconds = state.clipDurations
    Object.freeze(this)
  }

  static parse(input: Uint8Array): SpatialGlbModel {
    if (!(input instanceof Uint8Array) || input.byteLength < 28 || input.byteLength > SPATIAL_GLB_LIMITS.bytes || input.buffer instanceof SharedArrayBuffer) fail("Expected bounded, non-shared GLB bytes.")
    const bytes = Uint8Array.from(input)
    const header = new DataView(bytes.buffer)
    if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== bytes.length) fail("Invalid GLB 2.0 header or total length.")
    const jsonLength = header.getUint32(12, true)
    if (header.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 !== 0 || jsonLength < 4 || jsonLength > SPATIAL_GLB_LIMITS.jsonBytes || 20 + jsonLength + 8 > bytes.length) fail("Expected bounded first JSON chunk and following BIN chunk.")
    const binHeader = 20 + jsonLength, binLength = header.getUint32(binHeader, true)
    if (header.getUint32(binHeader + 4, true) !== 0x004e4942 || binLength % 4 !== 0 || binHeader + 8 + binLength !== bytes.length) fail("Expected exactly one BIN chunk and no trailing chunks.")
    let json: unknown
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, binHeader))) } catch { return fail("GLB JSON must be valid UTF-8 JSON.") }
    const document = schemaValue(gltfSchema, json, "gltf")
    const payloadLength = document.buffers[0]!.byteLength
    if (payloadLength > binLength || binLength - payloadLength > 3) fail("Declared BIN length does not match its padding.")
    const binary = bytes.subarray(binHeader + 8)
    if (binary.subarray(payloadLength).some(byte => byte !== 0)) fail("BIN padding must contain zero bytes.")
    validateViewRoles(document)
    const accessors = readAccessors(document, binary)
    const meshPrimitives = readMeshes(document, accessors)
    const graph = hierarchy(document)
    const clipDurations = animationDurations(document, accessors)
    let totalImageBytes = 0, totalPixels = 0
    const images = document.images.map((image, imageIndex) => {
      const view = at(document.bufferViews, image.bufferView, "images.bufferView")
      if (view.byteStride !== undefined || view.target !== undefined || view.byteLength > SPATIAL_GLB_LIMITS.imageBytes) fail("Embedded images require bounded untargeted byte views.")
      totalImageBytes += view.byteLength
      if (totalImageBytes > SPATIAL_GLB_LIMITS.imageTotalBytes) fail("Embedded image byte budget exceeded.")
      const imageBytes = binary.slice(view.byteOffset, view.byteOffset + view.byteLength)
      const dimensions = imageHeader(imageBytes, image.mimeType)
      totalPixels += dimensions.width * dimensions.height
      if (totalPixels > SPATIAL_GLB_LIMITS.imagePixels) fail("Embedded decoded image pixel budget exceeded.")
      return Object.freeze({ imageIndex, mimeType: image.mimeType, ...dimensions, bytes: imageBytes })
    })
    return new SpatialGlbModel({ document: deepFreezeJson(document), accessors, meshPrimitives, images: Object.freeze(images), ...graph, clipDurations })
  }

  evaluate(input: SpatialGlbEvaluateOptions): SpatialGlbGeometry {
    const options = schemaValue(optionsSchema, input, "glb evaluation")
    const state = this.#state, document = state.document
    if (options.nodeIndex !== undefined && !state.reachable.has(options.nodeIndex)) fail("Selected node is absent from the default scene.", "nodeIndex")
    let sourceTimeSeconds: number | null = null
    const animated = new Map<number, { translation?: Vec3; rotation?: Quaternion; scale?: Vec3 }>()
    if (options.clip !== undefined) {
      const clip = at(document.animations, options.clip.index, "clip.index")
      const duration = state.clipDurations[options.clip.index]!
      const requested = (options.timeUs + options.clip.offsetUs) / 1_000_000
      if (options.clip.offsetUs / 1_000_000 > duration) fail("Clip source offset exceeds its duration.")
      if (options.clip.playback === "once" && requested > duration) fail("Once clip playback exceeds its duration.")
      sourceTimeSeconds = options.clip.playback === "loop" ? duration === 0 ? 0 : requested % duration : Math.min(requested, duration)
      for (const channel of clip.channels) {
        const sampler = clip.samplers[channel.sampler]!, times = state.accessors[sampler.input]!.values, output = state.accessors[sampler.output]!
        let lower = 0, upper = times.length - 1
        if (sourceTimeSeconds <= times[0]!) upper = 0
        else if (sourceTimeSeconds >= times[upper]!) lower = upper
        else while (upper - lower > 1) { const middle = Math.floor((lower + upper) / 2); if (times[middle]! <= sourceTimeSeconds) lower = middle; else upper = middle }
        const left = output.values.slice(lower * output.components, (lower + 1) * output.components)
        let value: readonly number[] = left
        if (sampler.interpolation === "LINEAR" && upper !== lower) {
          const right = output.values.slice(upper * output.components, (upper + 1) * output.components)
          const t = (sourceTimeSeconds - times[lower]!) / (times[upper]! - times[lower]!)
          value = channel.target.path === "rotation" ? slerpQuaternion(left as unknown as Quaternion, right as unknown as Quaternion, t) : left.map((part, index) => part + (right[index]! - part) * t)
        }
        const pose = animated.get(channel.target.node) ?? {}
        if (channel.target.path === "rotation") pose.rotation = normalizedRotation(value, "evaluated clip rotation")
        else pose[channel.target.path] = value as Vec3
        animated.set(channel.target.node, pose)
      }
    }
    // Source X-up rotates +90° around Z; source Z-up rotates -90° around X.
    const rotation: Quaternion = options.sourceUp === "x" ? [0, 0, Math.SQRT1_2, Math.SQRT1_2] : options.sourceUp === "z" ? [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, 0, 1]
    const conversion = composeTransform({ position: [0, 0, 0], rotation, scale: [options.metersPerUnit, options.metersPerUnit, options.metersPerUnit] })
    const matrices = new Map<number, Mat4>()
    for (const index of state.order) {
      const node = document.nodes[index]!, overrides = animated.get(index)
      const local = overrides ? nodeTransform({ ...node, ...overrides }, `nodes.${index}`) : nodeTransform(node, `nodes.${index}`)
      const parent = state.parents[index]
      matrices.set(index, multiplyTransforms(parent === null ? conversion : matrices.get(parent!)!, local))
    }
    const selected = new Set<number>()
    if (options.nodeIndex === undefined) for (const index of state.reachable) selected.add(index)
    else {
      const pending = [options.nodeIndex]
      while (pending.length) { const index = pending.pop()!; selected.add(index); pending.push(...document.nodes[index]!.children) }
    }
    const primitives: SpatialGlbPrimitive[] = [], imageIds = new Set<number>()
    let triangles = 0
    for (const sourceNodeIndex of [...selected].sort((a, b) => a - b)) {
      const node = document.nodes[sourceNodeIndex]!
      if (node.mesh === undefined) continue
      const matrix = safeMatrix(matrices.get(sourceNodeIndex)!, `nodes.${sourceNodeIndex}`)
      for (const [sourcePrimitiveIndex, primitive] of state.meshPrimitives[node.mesh]!.entries()) {
        if (primitives.length >= SPATIAL_GLB_LIMITS.primitives) fail("Instanced primitive budget exceeded.")
        triangles += (primitive.indices?.length ?? primitive.positions.length / 3) / 3
        if (triangles > SPATIAL_GLB_LIMITS.triangles) fail("Instanced triangle budget exceeded.")
        const bounds = vertexBounds(primitive.positions, primitive.indices, matrix)
        const { material, ...geometry } = primitive
        if (options.materialMode === "source" && material.baseColorTexture) imageIds.add(material.baseColorTexture.imageIndex)
        primitives.push({ ...geometry, matrix, bounds, sourceNodeIndex, sourcePrimitiveIndex, ...(options.materialMode === "source" ? { material } : {}) })
      }
    }
    if (primitives.length === 0) fail("Selected scene or subtree contains no triangle geometry.")
    const bounds = combineBounds(primitives.map(primitive => primitive.bounds))
    const images = [...imageIds].sort((a, b) => a - b).map(index => { const image = state.images[index]!; return Object.freeze({ ...image, bytes: image.bytes.slice() }) })
    return Object.freeze({ profile: SPATIAL_GLB_PROFILE, primitives: deepFreezeJson(primitives), images: Object.freeze(images), bounds, sourceTimeSeconds })
  }
}

function vertexBounds(positions: readonly number[], indices: readonly number[] | undefined, matrix: Mat4): Bounds {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity]
  const count = indices?.length ?? positions.length / 3
  for (let index = 0; index < count; index++) {
    const offset = (indices?.[index] ?? index) * 3
    const point = transformPoint(matrix, [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!])
    for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis]!, point[axis]!); high[axis] = Math.max(high[axis]!, point[axis]!) }
  }
  return deepFreezeJson({ min: low as unknown as Vec3, max: high as unknown as Vec3 })
}
function combineBounds(bounds: readonly Bounds[]): Bounds {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const bound of bounds) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, bound.min[axis]!); max[axis] = Math.max(max[axis]!, bound.max[axis]!) }
  return deepFreezeJson({ min: min as unknown as Vec3, max: max as unknown as Vec3 })
}

export function parseSpatialGlb(bytes: Uint8Array): SpatialGlbModel { return SpatialGlbModel.parse(bytes) }
export function evaluateSpatialGlb(model: SpatialGlbModel, options: SpatialGlbEvaluateOptions): SpatialGlbGeometry {
  if (!(model instanceof SpatialGlbModel)) fail("Evaluation requires a parsed GLB model.")
  return model.evaluate(options)
}
