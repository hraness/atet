import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { parseSpatialGlb } from "../../../src/spatial-scene/gltf";
import { createBoundedJsonSnapshot } from "../../../src/code/json-snapshot";
import { SpatialAssetManifestSchema, SpatialEntitySchema } from "../../../src/spatial-scene/contracts";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import { createNodeSpatialDurability } from "../core/spatial-durability";
import { createNodeBundleFileSystem } from "../core/storage";
import { SavedSpatialWorldImportInputSchema, SavedSpatialWorldImportOutputSchema, SpatialWorldImportManifestSchema, SPATIAL_SPLAT_LIMITS, type SavedSpatialWorldImportOutput } from "../contracts/spatial-world";
import { inspectSpatialSpz } from "./spatial-spz";
import { WorldLabsProvenanceSchema } from "./spatial-world-provenance";

export { SavedSpatialWorldImportInputSchema } from "../contracts/spatial-world";
export type { SavedSpatialWorldImportInput, SavedSpatialWorldImportOutput, SpatialWorldImportManifest } from "../contracts/spatial-world";
type Artifact = { readonly path: string; readonly bytes: number; readonly sha256: string };

async function physicalRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new RangeError("Saved world roots must be absolute physical directories without symlinks.");
  return path;
}
async function readExact(root: string, artifact: Artifact, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const fs = createNodeBundleFileSystem(root);
  const actual = await fs.inspectFile!(artifact.path, artifact.bytes);
  if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) throw new RangeError("Saved world source differs from its exact artifact reference.");
  const target = join(root, artifact.path);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== artifact.bytes || await realpath(target) !== target) throw new RangeError("Saved world source changed during admission.");
    const bytes = new Uint8Array(artifact.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (read.bytesRead === 0) throw new RangeError("Saved world source was truncated.");
      offset += read.bytesRead;
    }
    const after = await handle.stat(), pathAfter = await lstat(target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || await realpath(target) !== target || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new RangeError("Saved world source changed while captured.");
    signal.throwIfAborted();
    return bytes;
  } finally { await handle.close(); }
}

/** Retained evidence survives cancellation and publication/cleanup uncertainty; no caller should replay a provider request because import failed. */
export class SpatialWorldImportError extends Error {
  readonly published: readonly Artifact[];
  readonly attempted: readonly Artifact[];
  constructor(cause: unknown, published: readonly Artifact[], attempted: readonly Artifact[] = published) { super("Saved world import did not complete; retain its exact source and publication evidence.", { cause }); this.name = "SpatialWorldImportError"; this.published = Object.freeze([...published]); this.attempted = Object.freeze([...attempted]); }
}

export async function importSavedSpatialWorld(options: {
  readonly sourceRoot: string; readonly destinationRoot: string; readonly input: unknown; readonly signal: AbortSignal; readonly beforePublication?: () => Promise<void>;
}): Promise<SavedSpatialWorldImportOutput> {
  const input = SavedSpatialWorldImportInputSchema.parse(options.input);
  if (input.provenance.receipt !== undefined && input.provenance.receipt.bytes > SPATIAL_SPLAT_LIMITS.metadataBytes) throw new RangeError("World provenance receipt exceeds one MiB.");
  const sourceClosureBytes = input.splat.bytes + (input.collider?.bytes ?? 0) + (input.provenance.receipt?.bytes ?? 0);
  // Reserve the bounded import manifest as part of the returned asset closure
  // before reading/copying any payload, so a successful import is renderable
  // under the same 256 MiB source-asset ceiling.
  if (sourceClosureBytes + SPATIAL_SPLAT_LIMITS.metadataBytes > 256 * 1024 * 1024) throw new RangeError("World source closure including its retained manifest exceeds 256 MiB.");
  options.signal.throwIfAborted();
  const sourceRoot = await physicalRoot(options.sourceRoot), destinationRoot = await physicalRoot(options.destinationRoot);
  const splatBytes = await readExact(sourceRoot, input.splat, options.signal);
  const facts = await inspectSpatialSpz(splatBytes, options.signal);
  const colliderBytes = input.collider === undefined ? undefined : await readExact(sourceRoot, input.collider, options.signal);
  if (colliderBytes !== undefined) parseSpatialGlb(colliderBytes);
  const providerBytes = input.provenance.receipt === undefined ? undefined : await readExact(sourceRoot, input.provenance.receipt, options.signal);
  if (providerBytes !== undefined) {
    const captured = createBoundedJsonSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(providerBytes)), 256 * 1024, "World provider provenance", { maximumDepth: 24, maximumValues: 32_768 });
    const value = WorldLabsProvenanceSchema.parse(captured.value);
    const matches = (actual: Artifact, expected: Artifact) => actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
    if (!matches(value.assets.splat, input.splat) || input.collider === undefined || !matches(value.assets.collider, input.collider)
      || (input.provenance.worldId !== undefined && value.world.worldId !== input.provenance.worldId)) throw new RangeError("World provider provenance does not match the retained world and exact SPZ/collider bytes.");
  }
  const fs = createNodeBundleFileSystem(destinationRoot), durability = createNodeSpatialDurability(destinationRoot);
  const published: Artifact[] = [];
  const attempted: Artifact[] = [];
  const fence = async () => { options.signal.throwIfAborted(); await options.beforePublication?.(); options.signal.throwIfAborted(); };
  await fence();
  const workspace = await mkdtemp(join(destinationRoot, ".slopcamera-world-import-"));
  let result: SavedSpatialWorldImportOutput | undefined, failure: { error: unknown } | undefined;
  const publishBytes = async (bytes: Uint8Array, extension: "spz" | "glb" | "json"): Promise<Artifact> => {
    const sha256 = createHash("sha256").update(bytes).digest("hex"), artifact = { path: `spatial/worlds/assets/${sha256}.${extension}`, sha256, bytes: bytes.byteLength };
    const staged = join(workspace, `${sha256}.${extension}`);
    await writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
    attempted.push(artifact);
    await fs.copyFileNoReplace!(relative(destinationRoot, staged), artifact.path, artifact, fence);
    published.push(artifact);
    await durability.syncExactFile(artifact.path, artifact);
    return artifact;
  };
  try {
    const splat = await publishBytes(splatBytes, "spz"), collider = colliderBytes === undefined ? undefined : await publishBytes(colliderBytes, "glb");
    const receipt = providerBytes === undefined ? undefined : await publishBytes(providerBytes, "json");
    const manifest = SpatialWorldImportManifestSchema.parse({ kind: "slopcamera.spatial-world-import", schemaVersion: 1,
      splat: { payload: splat, facts }, collider: collider === undefined ? null : { payload: collider, role: "approximate-collider", validation: "bounded-glb-structure-only" },
      identities: input.identities, normalization: input.normalization,
      provenance: { ...input.provenance, ...(receipt === undefined ? {} : { receipt }) },
      capabilities: { beauty: true, semanticIds: "authored-wrapper-only", depth: "unsupported", objectId: "unsupported", physics: collider === undefined ? "unavailable" : "unvalidated" },
    });
    const text = `${canonicalJson(manifest)}\n`, sha256 = createHash("sha256").update(text).digest("hex");
    const manifestArtifact = { path: `spatial/worlds/receipts/${sha256}.json`, sha256, bytes: Buffer.byteLength(text) };
    if (manifestArtifact.bytes > SPATIAL_SPLAT_LIMITS.metadataBytes || sourceClosureBytes + manifestArtifact.bytes > 256 * 1024 * 1024) throw new RangeError("World import manifest exceeds its reserved complete-closure budget.");
    attempted.push(manifestArtifact);
    await fs.writeTextNoReplace!(manifestArtifact.path, text, fence);
    published.push(manifestArtifact);
    await durability.syncExactFile(manifestArtifact.path, manifestArtifact);
    const provenance = { source: input.provenance.kind === "saved" ? "imported" : "generated", description: input.provenance.description, receiptSha256: manifestArtifact.sha256 };
    const interpretation = { metersPerUnit: input.normalization.metersPerUnit, sourceUp: input.normalization.sourceUp };
    const manifestAssetId = `asset_world_manifest_${manifestArtifact.sha256}`;
    const receiptAssetId = receipt === undefined ? undefined : `asset_world_provider_${receipt.sha256}`;
    const assets = [
      ...(collider === undefined ? [] : [SpatialAssetManifestSchema.parse({ assetId: input.identities.colliderAssetId, payload: collider, interpretation: { kind: "gltf", format: "glb", ...interpretation }, dependencies: [], provenance })]),
      SpatialAssetManifestSchema.parse({ assetId: manifestAssetId, payload: manifestArtifact, interpretation: { kind: "metadata", format: "json", schema: "slopcamera.spatial-world-import" }, dependencies: receiptAssetId === undefined ? [] : [receiptAssetId], provenance }),
      ...(receipt === undefined ? [] : [SpatialAssetManifestSchema.parse({ assetId: receiptAssetId, payload: receipt, interpretation: { kind: "metadata", format: "json", schema: "slopcamera.world-labs-provenance" }, dependencies: [], provenance })]),
      SpatialAssetManifestSchema.parse({ assetId: input.identities.assetId, payload: splat, interpretation: { kind: "splat", format: "spz", ...interpretation }, dependencies: [...(input.identities.colliderAssetId === undefined ? [] : [input.identities.colliderAssetId]), manifestAssetId], provenance }),
    ];
    if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) throw new RangeError("World metadata asset IDs conflict with requested identities.");
    const entity = SpatialEntitySchema.parse({ kind: "splat", entityId: input.identities.entityId, name: input.identities.name, parentId: null, assetId: input.identities.assetId, transform: input.normalization.transform, placement: { kind: "world" }, origin: { kind: "authored" }, visible: true });
    result = SavedSpatialWorldImportOutputSchema.parse({ manifest, manifestArtifact, assets, entity, manifestSha256: canonicalJsonSha256(manifest) });
  } catch (error) { failure = { error }; }
  finally {
    try { await rm(workspace, { recursive: true, force: true }); }
    catch (error) { failure = { error: failure === undefined ? error : new AggregateError([failure.error, error], "Saved world import and workspace cleanup failed.") }; }
  }
  if (failure !== undefined) throw new SpatialWorldImportError(failure.error, published, attempted);
  if (result === undefined) throw new SpatialWorldImportError(new Error("Saved world import did not settle."), published, attempted);
  return result;
}
