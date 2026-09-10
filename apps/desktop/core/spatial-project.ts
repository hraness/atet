import {
  applySpatialScenePatch,
  parseSpatialScene,
  spatialSceneSha256,
  validateSpatialShot,
} from "../../../src/spatial-scene/index";
import { z } from "zod";
import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot";
import { SpatialDigestSchema, SpatialScenePatchV1Schema, SpatialShotV1Schema, type SpatialShotV1 } from "../../../src/spatial-scene/contracts";
import {
  SpatialCandidateSchema,
  SpatialCandidateSelectionSchema,
  SPATIAL_PROJECT_LIMITS,
  SpatialProjectArtifactSchema,
  SpatialProjectRevisionV2Schema,
  SpatialProjectLegacySchema,
  SpatialProjectSceneSourceSchema,
  SpatialShotRetargetSchema,
  type SpatialCandidate,
  type SpatialProjectArtifact,
  type SpatialProjectLegacy,
  type SpatialProjectRevisionV2,
  type SpatialProjectSceneSource,
  type SpatialShotRetarget,
} from "../contracts/spatial-project";
import { canonicalJson, canonicalJsonSha256, sha256Hex } from "./canonical-json";
import { hashProjectStructure } from "./project-plan";

export interface SpatialProjectContents {
  readonly legacy: SpatialProjectLegacy;
  readonly scenes: readonly SpatialProjectSceneSource[];
  readonly shots: readonly SpatialShotV1[];
  readonly candidates: readonly SpatialCandidate[];
  readonly selections: readonly { readonly shotId: string; readonly candidateId: string }[];
}
export const SpatialProjectContentsSchema = z.strictObject({
  legacy: SpatialProjectLegacySchema,
  scenes: z.array(SpatialProjectSceneSourceSchema).max(SPATIAL_PROJECT_LIMITS.scenes),
  shots: z.array(SpatialShotV1Schema).max(SPATIAL_PROJECT_LIMITS.shots),
  candidates: z.array(SpatialCandidateSchema).max(SPATIAL_PROJECT_LIMITS.candidates),
  selections: z.array(SpatialCandidateSelectionSchema).max(SPATIAL_PROJECT_LIMITS.shots),
});
function capture(input: unknown, maximumBytes = SPATIAL_PROJECT_LIMITS.documentBytes) {
  return createBoundedJsonValueSnapshot(input, maximumBytes, "spatial project value", { maximumDepth: 48, maximumValues: 2_000_000 }).value;
}
export function spatialProjectDocumentText(value: unknown): string {
  return `${canonicalJson(capture(value))}\n`;
}
export function spatialProjectArtifact(area: "scenes" | "revisions" | "attempts" | "receipts", text: string): SpatialProjectArtifact {
  const sha256 = sha256Hex(text);
  return SpatialProjectArtifactSchema.parse({ path: `spatial/${area}/${sha256}.json`, sha256, bytes: new TextEncoder().encode(text).byteLength });
}
export function spatialProjectRevisionSha256(input: unknown): string {
  return canonicalJsonSha256({ domain: "slopcamera.spatial-project-revision/v2", revision: SpatialProjectRevisionV2Schema.parse(capture(input)) });
}
export function spatialShotSha256(input: unknown): string {
  return canonicalJsonSha256({ domain: "slopcamera.spatial-shot/v1", shot: SpatialShotV1Schema.parse(capture(input)) });
}
export function validateSpatialProjectContents(input: SpatialProjectContents): SpatialProjectContents {
  const captured = SpatialProjectContentsSchema.parse(capture(input, SPATIAL_PROJECT_LIMITS.documentBytes + SPATIAL_PROJECT_LIMITS.totalSceneBytes));
  const legacy = captured.legacy;
  if (legacy.projectEditPlan.projectId !== legacy.project.projectId
    || legacy.projectEditPlan.projectStructureSha256 !== hashProjectStructure(legacy.project)) {
    throw new Error("Frozen V1 plan does not bind its exact project structure.");
  }
  const scenes = captured.scenes.map(source => {
    const parsed = SpatialProjectSceneSourceSchema.parse(source);
    const document = parseSpatialScene(parsed.document);
    if (spatialSceneSha256(document) !== parsed.sceneSha256) throw new Error("Scene source digest mismatch.");
    return SpatialProjectSceneSourceSchema.parse({ sceneSha256: parsed.sceneSha256, document });
  });
  const shots = captured.shots;
  for (const shot of shots) {
    const source = scenes.find(scene => scene.sceneSha256 === shot.sceneSha256);
    if (source === undefined) throw new Error("Shot source is absent from the project.");
    validateSpatialShot(source.document, shot);
  }
  // The admitted candidate owns its values across later asynchronous IO. A
  // trusted caller retaining the original object cannot mutate this snapshot.
  return deepFreezeJson({
    legacy, scenes, shots,
    candidates: captured.candidates,
    selections: captured.selections,
  });
}
export function spatialProjectLegacyProjection(contents: SpatialProjectContents): SpatialProjectLegacy {
  validateSpatialProjectContents(contents);
  return structuredClone(contents.legacy);
}
export function spatialCandidateStatus(contents: SpatialProjectContents, candidate: SpatialCandidate): "current" | "stale" {
  const shot = contents.shots.find(value => value.shotId === candidate.derivation.shotId);
  return shot !== undefined && shot.sceneSha256 === candidate.derivation.sceneSha256
    && spatialShotSha256(shot) === candidate.derivation.shotSha256 ? "current" : "stale";
}
export interface SpatialProjectSceneDiff {
  readonly beforeSceneSha256: string;
  readonly afterSceneSha256: string;
  readonly affectedShotIds: readonly string[];
  readonly untouchedShotIds: readonly string[];
  readonly selectedCandidates: readonly { readonly shotId: string; readonly candidateId: string; readonly status: "current" | "stale" }[];
}
function retargetSpatialProjectScene(current: SpatialProjectContents, beforeSceneSha256: string, afterSceneSha256: string, retargetInput: SpatialShotRetarget) {
  const retarget = SpatialShotRetargetSchema.parse(capture(retargetInput));
  const eligible = current.shots.filter(shot => shot.sceneSha256 === beforeSceneSha256);
  const ids = retarget.kind === "all" ? eligible.map(shot => shot.shotId) : retarget.shotIds;
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some(id => !eligible.some(shot => shot.shotId === id))) {
    throw new Error("Retarget must explicitly name unique shots of the exact source scene.");
  }
  const contents = validateSpatialProjectContents({ ...current, shots: current.shots.map(shot => ids.includes(shot.shotId) ? { ...shot, sceneSha256: afterSceneSha256 } : shot) });
  return deepFreezeJson({ contents, diff: {
    beforeSceneSha256, afterSceneSha256, affectedShotIds: [...ids].sort(),
    untouchedShotIds: current.shots.filter(shot => !ids.includes(shot.shotId)).map(shot => shot.shotId).sort(),
    selectedCandidates: contents.selections.map(selection => {
      const candidate = contents.candidates.find(value => value.candidateId === selection.candidateId);
      if (candidate === undefined) throw new Error("Selected candidate is absent.");
      return { ...selection, status: spatialCandidateStatus(contents, candidate) };
    }),
  } });
}
/** Creates a revision candidate; project-level CAS is performed only by publication. */
export function applySpatialProjectScenePatch(
  input: SpatialProjectContents,
  patchInput: unknown,
  retargetInput: SpatialShotRetarget,
): { readonly contents: SpatialProjectContents; readonly diff: SpatialProjectSceneDiff } {
  const current = validateSpatialProjectContents(input);
  const patch = SpatialScenePatchV1Schema.parse(capture(patchInput));
  const source = current.scenes.find(scene => scene.sceneSha256 === patch.expectedSceneSha256);
  if (source === undefined) throw new Error("Expected source scene is absent.");
  const document = applySpatialScenePatch(source.document, patch).scene;
  const sceneSha256 = spatialSceneSha256(document);
  return retargetSpatialProjectScene({
    ...current,
    scenes: current.scenes.some(scene => scene.sceneSha256 === sceneSha256) ? current.scenes
      : [...current.scenes, SpatialProjectSceneSourceSchema.parse({ sceneSha256, document })],
  }, patch.expectedSceneSha256, sceneSha256, retargetInput);
}
/** Explicit rollback of selected shot source bindings, never automatic head rollback or replay. */
export function restoreSpatialProjectScene(
  input: SpatialProjectContents,
  expectedSceneSha256Input: unknown,
  restoreSceneSha256Input: unknown,
  retargetInput: SpatialShotRetarget,
): { readonly contents: SpatialProjectContents; readonly diff: SpatialProjectSceneDiff } {
  const current = validateSpatialProjectContents(input);
  const expectedSceneSha256 = SpatialDigestSchema.parse(capture(expectedSceneSha256Input));
  const restoreSceneSha256 = SpatialDigestSchema.parse(capture(restoreSceneSha256Input));
  const source = current.scenes.find(scene => scene.sceneSha256 === expectedSceneSha256);
  const restored = current.scenes.find(scene => scene.sceneSha256 === restoreSceneSha256);
  if (source === undefined || restored === undefined) throw new Error("Restore requires both exact scene revisions to be retained in the current project.");
  if (source.document.sceneId !== restored.document.sceneId) throw new Error("Restore must select a retained revision of the same authored scene identity.");
  if (expectedSceneSha256 === restoreSceneSha256) throw new Error("Restore requires a different retained scene revision.");
  return retargetSpatialProjectScene(current, expectedSceneSha256, restoreSceneSha256, retargetInput);
}
/** Register exact provenance; this function neither generates nor buys media. */
export function addSpatialCandidate(input: SpatialProjectContents, candidateInput: unknown): SpatialProjectContents {
  const candidate = SpatialCandidateSchema.parse(capture(candidateInput));
  if (input.candidates.some(value => value.candidateId === candidate.candidateId)) throw new Error("Candidate identity is immutable and already exists.");
  if (spatialCandidateStatus(input, candidate) !== "current") throw new Error("New candidate must bind the exact current shot and source scene.");
  return { ...input, candidates: [...input.candidates, candidate] };
}
export function selectSpatialCandidate(input: SpatialProjectContents, candidateId: string): SpatialProjectContents {
  const candidate = input.candidates.find(value => value.candidateId === candidateId);
  if (candidate === undefined || spatialCandidateStatus(input, candidate) !== "current") throw new Error("Only a current verified candidate can be selected.");
  return { ...input, selections: [...input.selections.filter(selection => selection.shotId !== candidate.derivation.shotId), { shotId: candidate.derivation.shotId, candidateId }] };
}
export function spatialProjectContents(revision: SpatialProjectRevisionV2, scenes: readonly SpatialProjectSceneSource[]): SpatialProjectContents {
  return validateSpatialProjectContents({ legacy: revision.legacy, scenes, shots: revision.shots, candidates: revision.candidates, selections: revision.selections });
}
