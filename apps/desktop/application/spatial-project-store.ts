import {
  SPATIAL_PROJECT_LIMITS,
  SpatialProjectAttemptV1Schema,
  SpatialProjectArtifactSchema,
  SpatialProjectBasisSchema,
  SpatialProjectHeadV2Schema,
  SpatialProjectRevisionV2Schema,
  SpatialProjectSettlementV1Schema,
  SpatialTransactionIdSchema,
  type SpatialProjectArtifact,
  type SpatialProjectBasis,
  type SpatialProjectHeadV2,
  type SpatialProjectRevisionV2,
  type SpatialProjectSceneSource,
} from "../contracts/spatial-project";
import { ProjectEditPlanV1Schema, VideoProjectV1Schema } from "../contracts/project";
import { canonicalJson, sha256Hex } from "../core/canonical-json";
import type { SpatialDurabilityPort } from "../core/spatial-durability";
import {
  spatialProjectArtifact,
  spatialProjectContents,
  spatialProjectDocumentText,
  spatialProjectRevisionSha256,
  validateSpatialProjectContents,
  type SpatialProjectContents,
} from "../core/spatial-project";
import { saveImmutableText, type BundleFileSystem } from "../core/storage";
import { parseSpatialScene, spatialSceneSha256 } from "../../../src/spatial-scene/index";
import { hashProjectGeneration } from "./project-store";
import { createProjectEditRevisionDocument } from "./receipts";

/** Adapter-owned authority. Never constructed from operation input. */
export interface SpatialProjectCustody {
  assertHeld(): Promise<void>;
  assertLegacyTransactionSettled(): Promise<void>;
}
export interface SpatialProjectStorePorts {
  /** Exact adapter-owned project identity, supplied by every production adapter. */
  readonly projectId?: string;
  readonly fileSystem: BundleFileSystem;
  readonly durability: SpatialDurabilityPort;
  readonly custody: SpatialProjectCustody;
}
export interface SpatialProjectSnapshot {
  readonly version: 2;
  readonly basis: SpatialProjectBasis;
  readonly headText: string;
  readonly head: SpatialProjectHeadV2;
  readonly revision: SpatialProjectRevisionV2;
  readonly contents: SpatialProjectContents;
}
export interface SpatialLegacyProjectSnapshot {
  readonly version: 1;
  readonly basis: SpatialProjectBasis;
  readonly headText: string;
  readonly contents: SpatialProjectContents;
}
export type SpatialProjectAuthority = SpatialProjectSnapshot | SpatialLegacyProjectSnapshot;
export type SpatialProjectCommitResult =
  | { readonly kind: "completed"; readonly attempt: SpatialProjectArtifact; readonly settlement: SpatialProjectArtifact; readonly projectRevisionSha256: string; readonly currentHeadMatches: boolean }
  | { readonly kind: "conflict" | "precommit"; readonly message: string; readonly attempt?: SpatialProjectArtifact }
  | { readonly kind: "ambiguous"; readonly attempt: SpatialProjectArtifact; readonly message: string };

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("Spatial publication cancelled before head dispatch.");
}
async function readBoundedText(fs: BundleFileSystem, path: string, maximum = SPATIAL_PROJECT_LIMITS.documentBytes): Promise<string> {
  if (fs.inspectFile !== undefined && (await fs.inspectFile(path, maximum)).bytes > maximum) throw new Error("Spatial structured byte budget exceeded.");
  const text = await fs.readText(path, maximum);
  if (new TextEncoder().encode(text).byteLength > maximum) throw new Error("Spatial structured byte budget exceeded.");
  return text;
}
async function readArtifact(fs: BundleFileSystem, input: SpatialProjectArtifact): Promise<string> {
  const ref = SpatialProjectArtifactSchema.parse(input);
  const text = await readBoundedText(fs, ref.path, ref.bytes);
  if (sha256Hex(text) !== ref.sha256 || new TextEncoder().encode(text).byteLength !== ref.bytes) throw new Error("Spatial artifact integrity mismatch.");
  return text;
}
async function publish(ports: SpatialProjectStorePorts, reference: SpatialProjectArtifact, text: string): Promise<void> {
  await ports.custody.assertHeld();
  await saveImmutableText({
    ...ports.fileSystem,
    readText: path => ports.fileSystem.readText(path, reference.bytes),
  }, reference.path, text, reference.sha256);
  await ports.durability.syncExactFile(reference.path, reference);
  if (await readArtifact(ports.fileSystem, reference) !== text) throw new Error("Spatial immutable durability readback changed.");
}
async function verifyPayloads(fs: BundleFileSystem, contents: SpatialProjectContents, durability?: SpatialDurabilityPort): Promise<void> {
  const payloads = new Map<string, { readonly path: string; readonly bytes: number; readonly sha256: string }>();
  let sourceBytes = 0;
  let outputBytes = 0;
  const add = (payload: { readonly path: string; readonly bytes: number; readonly sha256: string }, kind: "source" | "output"): void => {
    const prior = payloads.get(payload.path);
    if (prior !== undefined) {
      if (prior.bytes !== payload.bytes || prior.sha256 !== payload.sha256) throw new Error("Conflicting physical payload identity.");
      return;
    }
    payloads.set(payload.path, payload);
    if (kind === "source") sourceBytes += payload.bytes;
    else outputBytes += payload.bytes;
  };
  for (const scene of contents.scenes) for (const asset of scene.document.assets) add(asset.payload, "source");
  for (const candidate of contents.candidates) for (const output of candidate.outputs) add(output, "output");
  if (sourceBytes > 256 * 1024 * 1024 || outputBytes > 1_024 * 1024 * 1024) throw new Error("Spatial project payload budget exceeded.");
  if (payloads.size > 0 && fs.inspectFile === undefined) throw new Error("Physical payload inspection is required for spatial source and candidate publication.");
  for (const payload of payloads.values()) {
    const actual = await fs.inspectFile?.(payload.path, payload.bytes);
    if (actual === undefined || actual.bytes !== payload.bytes || actual.sha256 !== payload.sha256) throw new Error("Spatial physical payload integrity mismatch.");
    await durability?.syncExactFile(payload.path, payload);
  }
}
async function loadExactHead(fs: BundleFileSystem, head: SpatialProjectHeadV2, headText: string): Promise<SpatialProjectSnapshot> {
  const revisionText = await readArtifact(fs, head.revision);
  const revision = SpatialProjectRevisionV2Schema.parse(JSON.parse(revisionText));
  if (revisionText !== spatialProjectDocumentText(revision)
    || spatialProjectRevisionSha256(revision) !== head.projectRevisionSha256
    || revision.projectId !== head.projectId || revision.transactionId !== head.transactionId) throw new Error("Spatial head and revision binding mismatch.");
  // Reuse the unchanged V1 revision verifier, including its structural/hash laws.
  createProjectEditRevisionDocument(revision.legacy.project, revision.legacy.projectEditPlan);
  const scenes: SpatialProjectSceneSource[] = [];
  for (const reference of revision.scenes) {
    const text = await readArtifact(fs, reference.artifact);
    const document = parseSpatialScene(JSON.parse(text));
    if (text !== spatialProjectDocumentText(document) || spatialSceneSha256(document) !== reference.sceneSha256) throw new Error("Spatial source digest or canonical bytes mismatch.");
    scenes.push({ sceneSha256: reference.sceneSha256, document: structuredClone(document) as SpatialProjectSceneSource["document"] });
  }
  const contents = spatialProjectContents(revision, scenes);
  await verifyPayloads(fs, contents);
  return { version: 2, basis: { version: 2, sha256: head.projectRevisionSha256 }, headText, head, revision, contents };
}
/** V2 reads consult only project.json and immutable references, never historical V1 pointers. */
export async function loadSpatialProject(fs: BundleFileSystem): Promise<SpatialProjectSnapshot> {
  const text = await readBoundedText(fs, "project.json");
  const head = SpatialProjectHeadV2Schema.parse(JSON.parse(text));
  if (text !== spatialProjectDocumentText(head)) throw new Error("Noncanonical spatial head.");
  return await loadExactHead(fs, head, text);
}
export async function readSpatialProjectAuthority(ports: SpatialProjectStorePorts): Promise<SpatialProjectAuthority> {
  const text = await readBoundedText(ports.fileSystem, "project.json");
  const value: unknown = JSON.parse(text);
  const head = SpatialProjectHeadV2Schema.safeParse(value);
  if (head.success) {
    if (ports.projectId !== undefined && ports.projectId !== head.data.projectId) throw new Error("Spatial head belongs to another project.");
    if (text !== spatialProjectDocumentText(head.data)) throw new Error("Noncanonical spatial head.");
    return await loadExactHead(ports.fileSystem, head.data, text);
  }
  const project = VideoProjectV1Schema.parse(value);
  if (ports.projectId !== undefined && ports.projectId !== project.projectId) throw new Error("Legacy head belongs to another project.");
  await ports.custody.assertLegacyTransactionSettled();
  // Match the existing V1 reader's authoritative pair exactly, including a
  // nullable historical currentEditPlanPath field in the frozen project value.
  const projectEditPlan = ProjectEditPlanV1Schema.parse(JSON.parse(await readBoundedText(ports.fileSystem, "edits/current.json")));
  createProjectEditRevisionDocument(project, projectEditPlan);
  return {
    version: 1,
    basis: { version: 1, sha256: hashProjectGeneration(project, projectEditPlan).generationSha256 },
    headText: text,
    contents: { legacy: { project, projectEditPlan }, scenes: [], shots: [], candidates: [], selections: [] },
  };
}
export interface SpatialProjectCommitOptions {
  readonly ports: SpatialProjectStorePorts;
  readonly expected: SpatialProjectBasis;
  readonly transactionId: string;
  readonly change: (current: SpatialProjectAuthority) => SpatialProjectContents;
  readonly signal?: AbortSignal;
}
/** Must run under the existing publication lease, which remains owned until settlement. */
export async function commitSpatialProjectRevision(options: SpatialProjectCommitOptions): Promise<SpatialProjectCommitResult> {
  const { ports } = options;
  let attempt: SpatialProjectArtifact | undefined;
  let dispatched = false;
  try {
    await ports.custody.assertHeld();
    assertNotCancelled(options.signal);
    const expected = SpatialProjectBasisSchema.parse(options.expected);
    const transactionId = SpatialTransactionIdSchema.parse(options.transactionId);
    if (ports.fileSystem.writeTextAtomicGuarded === undefined) throw new Error("Spatial head publication requires the guarded atomic-replace capability.");
    const current = await readSpatialProjectAuthority(ports);
    if (canonicalJson(current.basis) !== canonicalJson(expected)) return { kind: "conflict", message: "Expected complete project revision is stale." };
    const contents = validateSpatialProjectContents(options.change(current));
    const scenes = contents.scenes.map(source => ({ sceneSha256: source.sceneSha256, artifact: spatialProjectArtifact("scenes", spatialProjectDocumentText(source.document)) }));
    const revision = SpatialProjectRevisionV2Schema.parse({
      kind: "slopcamera.spatial-project-revision", schemaVersion: 2, projectId: current.contents.legacy.project.projectId,
      parent: expected, transactionId, legacy: contents.legacy, scenes, shots: contents.shots, candidates: contents.candidates, selections: contents.selections,
    });
    // All source dependencies are validated and made durable before publishing a head.
    await verifyPayloads(ports.fileSystem, contents, ports.durability);
    for (const source of contents.scenes) {
      const text = spatialProjectDocumentText(source.document);
      await publish(ports, spatialProjectArtifact("scenes", text), text);
    }
    const revisionText = spatialProjectDocumentText(revision);
    const reference = spatialProjectArtifact("revisions", revisionText);
    await publish(ports, reference, revisionText);
    const after = SpatialProjectHeadV2Schema.parse({
      kind: "slopcamera.spatial-project-head", schemaVersion: 2, projectId: revision.projectId,
      projectRevisionSha256: spatialProjectRevisionSha256(revision), revision: reference, transactionId,
    });
    const attemptText = spatialProjectDocumentText(SpatialProjectAttemptV1Schema.parse({
      kind: "slopcamera.spatial-project-attempt", schemaVersion: 1, beforeHeadSha256: sha256Hex(current.headText), expected, after,
    }));
    attempt = spatialProjectArtifact("attempts", attemptText);
    await publish(ports, attempt, attemptText);
    await ports.custody.assertHeld();
    assertNotCancelled(options.signal);
    const last = await readSpatialProjectAuthority(ports);
    if (canonicalJson(last.basis) !== canonicalJson(expected) || last.headText !== current.headText) return { kind: "conflict", attempt, message: "Project changed before publication." };
    const afterText = spatialProjectDocumentText(after);
    // The final authority read is asynchronous. Its completion is not evidence
    // that the lease or cancellation state survived that read.
    await ports.custody.assertHeld();
    assertNotCancelled(options.signal);
    await ports.fileSystem.writeTextAtomicGuarded("project.json", afterText, async () => {
      // The native adapter stages and flushes its temporary file before this
      // fence, then starts rename immediately after it returns. A cancellation
      // or lost lease during staging therefore cannot publish an authority.
      await ports.custody.assertHeld();
      assertNotCancelled(options.signal);
      // Beyond this exact dispatch point a thrown write cannot prove noncommit.
      dispatched = true;
    });
    await ports.durability.syncExactFile("project.json", { bytes: new TextEncoder().encode(afterText).byteLength, sha256: sha256Hex(afterText) });
    if (await readBoundedText(ports.fileSystem, "project.json") !== afterText) throw new Error("Spatial head readback mismatch.");
    await loadExactHead(ports.fileSystem, after, afterText);
    const receiptText = settlementText(attempt, afterText);
    const settlement = spatialProjectArtifact("receipts", receiptText);
    await publish(ports, settlement, receiptText);
    return { kind: "completed", attempt, settlement, projectRevisionSha256: after.projectRevisionSha256, currentHeadMatches: true };
  } catch (error) {
    if (dispatched && attempt !== undefined) return { kind: "ambiguous", attempt, message: messageOf(error) };
    return { kind: "precommit", message: messageOf(error), ...(attempt === undefined ? {} : { attempt }) };
  }
}
export async function migrateSpatialProject(options: Omit<SpatialProjectCommitOptions, "change"> & {
  readonly scenes: readonly SpatialProjectSceneSource[];
  readonly shots: SpatialProjectContents["shots"];
}): Promise<SpatialProjectCommitResult> {
  return await commitSpatialProjectRevision({ ...options, change(current) {
    if (current.version !== 1) throw new Error("Spatial migration requires an existing V1 authority.");
    return { ...current.contents, scenes: options.scenes, shots: options.shots };
  } });
}
function settlementText(attempt: SpatialProjectArtifact, headText: string): string {
  return spatialProjectDocumentText(SpatialProjectSettlementV1Schema.parse({
    kind: "slopcamera.spatial-project-settlement", schemaVersion: 1, attempt, headSha256: sha256Hex(headText),
  }));
}
/** Reconciliation proves an exact commit; it never restores, overwrites, or replays a head. */
export async function reconcileSpatialProjectCommit(options: {
  readonly ports: SpatialProjectStorePorts;
  readonly attempt: SpatialProjectArtifact;
}): Promise<SpatialProjectCommitResult> {
  const { ports } = options;
  const reference = SpatialProjectArtifactSchema.parse(options.attempt);
  try {
    await ports.custody.assertHeld();
    if (!reference.path.startsWith("spatial/attempts/")) throw new Error("Reconciliation requires an immutable attempt reference.");
    const text = await readArtifact(ports.fileSystem, reference);
    const attempt = SpatialProjectAttemptV1Schema.parse(JSON.parse(text));
    if (ports.projectId !== undefined && ports.projectId !== attempt.after.projectId) throw new Error("Spatial attempt belongs to another project.");
    if (text !== spatialProjectDocumentText(attempt)) throw new Error("Noncanonical spatial attempt.");
    const headText = spatialProjectDocumentText(attempt.after);
    const receiptText = settlementText(reference, headText);
    const receipt = spatialProjectArtifact("receipts", receiptText);
    const snapshot = await loadExactHead(ports.fileSystem, attempt.after, headText);
    if (canonicalJson(snapshot.revision.parent) !== canonicalJson(attempt.expected)) throw new Error("Spatial attempt does not bind its revision parent.");
    let provenReceipt = false;
    try {
      if (await readArtifact(ports.fileSystem, receipt) !== receiptText) throw new Error("Spatial settlement receipt mismatch.");
      // Existing identical bytes may come from a failed link/fsync attempt.
      await ports.durability.syncExactFile(receipt.path, receipt);
      provenReceipt = true;
    } catch (error) { if (!isMissing(error)) throw error; }
    const matches = await readBoundedText(ports.fileSystem, "project.json") === headText;
    if (!provenReceipt) {
      if (!matches) throw new Error("No durable completion proof and current head differs; rollback and replay are forbidden.");
      await ports.durability.syncExactFile("project.json", { bytes: new TextEncoder().encode(headText).byteLength, sha256: sha256Hex(headText) });
      if (await readBoundedText(ports.fileSystem, "project.json") !== headText) throw new Error("Spatial head changed during reconciliation.");
      await publish(ports, receipt, receiptText);
    }
    return { kind: "completed", attempt: reference, settlement: receipt, projectRevisionSha256: attempt.after.projectRevisionSha256, currentHeadMatches: matches };
  } catch (error) { return { kind: "ambiguous", attempt: reference, message: messageOf(error) }; }
}
