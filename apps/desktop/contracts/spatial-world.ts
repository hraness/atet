import { z } from "zod";

import { createBoundedJsonSnapshot } from "../../../src/code/json-snapshot";
import { SpatialAssetIdSchema, SpatialAssetManifestSchema, SpatialDigestSchema, SpatialEntityIdSchema, SpatialEntitySchema, SpatialPayloadSchema, SpatialTransformSchema } from "../../../src/spatial-scene/contracts";

export const SPATIAL_SPLAT_LIMITS = Object.freeze({ splats: 500_000, sourceBytes: 128 * 1024 * 1024, decompressedBytes: 64 * 1024 * 1024, gpuBytes: 256 * 1024 * 1024, hostBytes: 768 * 1024 * 1024, metadataBytes: 1024 * 1024 });
export function spatialSpzAllocationBounds(splats: number, sourceBytes: number, decompressedBytes: number) {
  // Spark 2.1.0 utils.getTextureSize rounds rows to 2048; use a larger 65536 block.
  // Ext source+SH: 32+64 B/splat; three accumulator MRT sets: 3*(16+16+4);
  // ordering/readback buffers fit the remaining 52 B/splat. Browser/driver overhead
  // is not a claim of resident process memory. LoD/paging/raycast are disabled.
  const rounded = Math.ceil(splats / 65_536) * 65_536;
  return { gpuBytesBound: rounded * 256, hostBytesBound: 128 * 1024 * 1024 + rounded * 512 + sourceBytes * 3 + decompressedBytes * 2 };
}
export const SpatialSpzFactsSchema = z.strictObject({
  kind: z.literal("slopcamera.spz-admission"), schemaVersion: z.literal(1), version: z.union([z.literal(2), z.literal(3)]),
  splats: z.number().int().min(1).max(SPATIAL_SPLAT_LIMITS.splats), shDegree: z.number().int().min(0).max(3), fractionalBits: z.number().int().min(0).max(24),
  antialiased: z.literal(false), decompressedBytes: z.number().int().min(16).max(SPATIAL_SPLAT_LIMITS.decompressedBytes),
  gpuBytesBound: z.number().int().min(1).max(SPATIAL_SPLAT_LIMITS.gpuBytes), hostBytesBound: z.number().int().min(1).max(SPATIAL_SPLAT_LIMITS.hostBytes),
}).refine(value => value.decompressedBytes === 16 + value.splats * (19 + (value.version === 3 ? 1 : 0) + 3 * ((value.shDegree + 1) ** 2 - 1)), "SPZ body size must match the exact admitted attribute layout.");
export type SpatialSpzFacts = Readonly<z.infer<typeof SpatialSpzFactsSchema>>;

const normalizationSchema = z.strictObject({
  metersPerUnit: z.number().finite().min(0.000001).max(1_000_000),
  // Applied to decoded SPZ coordinates. Spark 2.1.0's SPZ decoder reads XYZ
  // directly, without the format conversion sometimes used for PLY/OpenCV.
  sourceUp: z.enum(["x", "y", "z"]), sourceHandedness: z.literal("right"),
  transform: SpatialTransformSchema.refine(value => value.scale[0] === value.scale[1] && value.scale[1] === value.scale[2], "The initial splat profile requires a uniform authored scale."),
});
const identitiesSchema = z.strictObject({ assetId: SpatialAssetIdSchema, colliderAssetId: SpatialAssetIdSchema.optional(), entityId: SpatialEntityIdSchema, name: z.string().min(1).max(256) })
  .refine(value => value.assetId !== value.colliderAssetId, "World and collider assets need distinct identities.");
const provenanceSchema = z.strictObject({ kind: z.enum(["saved", "worldlabs-marble"]), description: z.string().min(1).max(2048), worldId: z.string().min(1).max(256).optional(), receipt: SpatialPayloadSchema.optional() })
  .refine(value => value.kind !== "worldlabs-marble" || (value.worldId !== undefined && value.receipt !== undefined), "Generated Marble provenance requires its exact world ID and retained provider receipt.");
const importSchema = z.strictObject({ splat: SpatialPayloadSchema, collider: SpatialPayloadSchema.optional(), identities: identitiesSchema, normalization: normalizationSchema, provenance: provenanceSchema })
  .refine(value => (value.collider === undefined) === (value.identities.colliderAssetId === undefined), "Collider bytes and colliderAssetId must be supplied together.")
  .refine(value => value.provenance.kind !== "worldlabs-marble" || value.collider !== undefined, "Generated Marble provenance requires its retained collider.");
export const SavedSpatialWorldImportInputSchema = z.preprocess(value => createBoundedJsonSnapshot(value, SPATIAL_SPLAT_LIMITS.metadataBytes, "Saved world import", { maximumDepth: 16, maximumValues: 4096 }).value, importSchema);
export type SavedSpatialWorldImportInput = Readonly<z.infer<typeof SavedSpatialWorldImportInputSchema>>;
export const SpatialWorldImportManifestSchema = z.strictObject({
  kind: z.literal("slopcamera.spatial-world-import"), schemaVersion: z.literal(1),
  splat: z.strictObject({ payload: SpatialPayloadSchema, facts: SpatialSpzFactsSchema }),
  collider: z.strictObject({ payload: SpatialPayloadSchema, role: z.literal("approximate-collider"), validation: z.literal("bounded-glb-structure-only") }).nullable(),
  identities: identitiesSchema, normalization: normalizationSchema, provenance: provenanceSchema,
  capabilities: z.strictObject({ beauty: z.literal(true), semanticIds: z.literal("authored-wrapper-only"), depth: z.literal("unsupported"), objectId: z.literal("unsupported"), physics: z.enum(["unvalidated", "unavailable"]) }),
}).refine(value => (value.collider === null) === (value.identities.colliderAssetId === undefined) && value.capabilities.physics === (value.collider === null ? "unavailable" : "unvalidated"), "Collider presence and capability evidence must agree.");
export type SpatialWorldImportManifest = Readonly<z.infer<typeof SpatialWorldImportManifestSchema>>;
export const SavedSpatialWorldImportOutputSchema = z.strictObject({ manifest: SpatialWorldImportManifestSchema, manifestArtifact: SpatialPayloadSchema, assets: z.array(SpatialAssetManifestSchema).min(2).max(4), entity: SpatialEntitySchema, manifestSha256: SpatialDigestSchema });
export type SavedSpatialWorldImportOutput = Readonly<z.infer<typeof SavedSpatialWorldImportOutputSchema>>;
