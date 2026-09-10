import { z } from "zod";

import { createBoundedJsonValueSnapshot } from "../../../../src/code/json-snapshot";
import { parseSpatialScene, spatialSceneSha256 } from "../../../../src/spatial-scene/index";
import { SpatialDigestSchema, SpatialScenePatchV1Schema, SpatialShotV1Schema } from "../../../../src/spatial-scene/contracts";
import {
  SPATIAL_PROJECT_LIMITS,
  SpatialCandidateIdSchema,
  SpatialCandidateSchema,
  SpatialCandidateSelectionSchema,
  SpatialProjectArtifactSchema,
  SpatialProjectBasisSchema,
  SpatialProjectHeadV2Schema,
  SpatialProjectLegacySchema,
  SpatialProjectMutationOutputSchema,
  SpatialProjectSceneSourceSchema,
  SpatialShotRetargetSchema,
  SpatialTransactionIdSchema,
  type SpatialProjectMutationOutput,
} from "../../contracts/spatial-project";
export { SpatialProjectMutationOutputSchema, SpatialProjectSceneDiffSchema, type SpatialProjectMutationOutput } from "../../contracts/spatial-project";
import { VideoProjectIdSchema } from "../../contracts/project";
import { canonicalJson } from "../../core/canonical-json";
import {
  addSpatialCandidate,
  applySpatialProjectScenePatch,
  restoreSpatialProjectScene,
  selectSpatialCandidate,
  spatialCandidateStatus,
  spatialProjectDocumentText,
  type SpatialProjectContents,
  type SpatialProjectSceneDiff,
} from "../../core/spatial-project";
import { ApplicationError } from "../errors";
import type { OperationDefinition, OperationExecutionContext, OperationKind, OperationPolicy } from "../operation";
import { spatialProjectStorePorts } from "../spatial-project-authority";
import {
  commitSpatialProjectRevision,
  migrateSpatialProject,
  readSpatialProjectAuthority,
  reconcileSpatialProjectCommit,
  type SpatialProjectAuthority,
  type SpatialProjectStorePorts,
} from "../spatial-project-store";

const mutationBase = {
  project: VideoProjectIdSchema,
  expected: SpatialProjectBasisSchema,
  transactionId: SpatialTransactionIdSchema,
};
function boundedInput<Schema extends z.ZodType>(schema: Schema, maximumBytes = SPATIAL_PROJECT_LIMITS.documentBytes) {
  return z.preprocess(input => createBoundedJsonValueSnapshot(input, maximumBytes, "spatial operation input", { maximumDepth: 48, maximumValues: 2_000_000 }).value, schema);
}
export const SpatialProjectSnapshotInputSchema = boundedInput(z.strictObject({ project: VideoProjectIdSchema, expected: SpatialProjectBasisSchema.optional() }), 1_024);
export const SpatialProjectMigrateInputSchema = boundedInput(z.strictObject({
  ...mutationBase,
  scenes: z.array(SpatialProjectSceneSourceSchema).max(SPATIAL_PROJECT_LIMITS.scenes),
  shots: z.array(SpatialShotV1Schema).max(SPATIAL_PROJECT_LIMITS.shots),
}));
export const SpatialProjectPatchInputSchema = boundedInput(z.strictObject({ ...mutationBase, patch: SpatialScenePatchV1Schema, retarget: SpatialShotRetargetSchema }));
export const SpatialProjectRestoreInputSchema = boundedInput(z.strictObject({ ...mutationBase,
  expectedSceneSha256: SpatialDigestSchema, restoreSceneSha256: SpatialDigestSchema, retarget: SpatialShotRetargetSchema,
}));
export const SpatialProjectAddShotInputSchema = boundedInput(z.strictObject({
  ...mutationBase,
  shot: SpatialShotV1Schema,
  source: SpatialProjectSceneSourceSchema.optional(),
}));
export const SpatialProjectAddCandidateInputSchema = boundedInput(z.strictObject({ ...mutationBase, candidate: SpatialCandidateSchema }));
export const SpatialProjectSelectCandidateInputSchema = boundedInput(z.strictObject({ ...mutationBase, candidateId: SpatialCandidateIdSchema }));
export const SpatialProjectReconcileInputSchema = boundedInput(z.strictObject({ project: VideoProjectIdSchema, attempt: SpatialProjectArtifactSchema.refine(value => value.path.startsWith("spatial/attempts/")) }));

const snapshotBase = {
  projectId: VideoProjectIdSchema,
  basis: SpatialProjectBasisSchema,
  legacy: SpatialProjectLegacySchema,
  scenes: z.array(SpatialProjectSceneSourceSchema).max(SPATIAL_PROJECT_LIMITS.scenes),
  shots: z.array(SpatialShotV1Schema).max(SPATIAL_PROJECT_LIMITS.shots),
  candidates: z.array(SpatialCandidateSchema).max(SPATIAL_PROJECT_LIMITS.candidates),
  selections: z.array(SpatialCandidateSelectionSchema.extend({ status: z.enum(["current", "stale"]) })).max(SPATIAL_PROJECT_LIMITS.shots),
};
export const SpatialProjectSnapshotOutputSchema = z.discriminatedUnion("version", [
  z.strictObject({ ...snapshotBase, version: z.literal(1) }),
  z.strictObject({ ...snapshotBase, version: z.literal(2), head: SpatialProjectHeadV2Schema }),
]).superRefine((snapshot, context) => {
  if (snapshot.basis.version !== snapshot.version || (snapshot.version === 2 && snapshot.head.projectRevisionSha256 !== snapshot.basis.sha256)) context.addIssue({ code: "custom", message: "Snapshot basis must match its exact authority version and head." });
});
export type SpatialProjectSnapshotInput = z.infer<typeof SpatialProjectSnapshotInputSchema>;
export type SpatialProjectSnapshotOutput = z.infer<typeof SpatialProjectSnapshotOutputSchema>;
export type SpatialProjectMigrateInput = z.infer<typeof SpatialProjectMigrateInputSchema>;
export type SpatialProjectPatchInput = z.infer<typeof SpatialProjectPatchInputSchema>;
export type SpatialProjectRestoreInput = z.infer<typeof SpatialProjectRestoreInputSchema>;
export type SpatialProjectAddShotInput = z.infer<typeof SpatialProjectAddShotInputSchema>;
export type SpatialProjectAddCandidateInput = z.infer<typeof SpatialProjectAddCandidateInputSchema>;
export type SpatialProjectSelectCandidateInput = z.infer<typeof SpatialProjectSelectCandidateInputSchema>;
export type SpatialProjectReconcileInput = z.infer<typeof SpatialProjectReconcileInputSchema>;

async function ownedPorts(context: OperationExecutionContext, project: string, mode: "read" | "write" = "write"): Promise<SpatialProjectStorePorts> {
  const ports = await spatialProjectStorePorts(context.application, project);
  return { ...ports, custody: { ...ports.custody, assertHeld: async () => {
    await ports.custody.assertHeld();
    if (mode === "write") await context.workflow?.beforePublication();
  } } };
}
function requireSpatial(current: SpatialProjectAuthority): SpatialProjectContents {
  if (current.version !== 2) throw new ApplicationError("conflict", "This mutation requires V2 spatial authority; migrate the checked V1 project first.");
  return current.contents;
}
const mutationPolicy: OperationPolicy = {
  cache: "none", cancellable: true, effect: "project-mutation", maxDurationMs: 120_000, maxFanOut: 0,
  maxInputBytes: SPATIAL_PROJECT_LIMITS.documentBytes, maxOutputBytes: 2 * 1024 * 1024,
  preparation: ["project-state"], resources: [{ amount: 1, resource: "local-io" }, { amount: 1, resource: "project-publication" }],
  resume: "ambiguous-after-dispatch",
};
function mutationDefinition<Kind extends OperationKind, Input>(
  kind: Kind,
  inputSchema: z.ZodType<Input>,
  execute: (context: OperationExecutionContext, input: Input) => Promise<SpatialProjectMutationOutput>,
): OperationDefinition<Kind, Input, SpatialProjectMutationOutput> {
  return {
    kind, version: 1, inputSchema, inputSchemaId: `slopcamera.operation.${kind}.input/v1`,
    outputSchema: SpatialProjectMutationOutputSchema, outputSchemaId: `slopcamera.operation.${kind}.output/v1`,
    lifecycle: { kind: "project-transaction", execute: async (context, input) => await execute(context, inputSchema.parse(input)) },
    policy: mutationPolicy,
    receiptReference: output => output.kind === "completed" ? output.settlement.path : undefined,
    summarize: output => ({ kind, fields: { disposition: output.kind, ...(output.kind === "completed" ? { projectRevisionSha256: output.projectRevisionSha256 } : { message: output.message }) } }),
  };
}

export const spatialProjectSnapshotOperationDefinition: OperationDefinition<"spatial.project.snapshot", SpatialProjectSnapshotInput, SpatialProjectSnapshotOutput> = {
  kind: "spatial.project.snapshot", version: 1,
  inputSchema: SpatialProjectSnapshotInputSchema, inputSchemaId: "slopcamera.operation.spatial.project.snapshot.input/v1",
  outputSchema: SpatialProjectSnapshotOutputSchema, outputSchemaId: "slopcamera.operation.spatial.project.snapshot.output/v1",
  lifecycle: { kind: "local-artifact", execute: async (context, input) => {
    const request = SpatialProjectSnapshotInputSchema.parse(input);
    if (context.abortSignal.aborted) throw new ApplicationError("cancelled", "Spatial snapshot cancelled.");
    const ports = await ownedPorts(context, request.project, "read");
    const current = await readSpatialProjectAuthority(ports);
    await ports.custody.assertHeld();
    if (context.abortSignal.aborted) throw new ApplicationError("cancelled", "Spatial snapshot cancelled.");
    if (request.expected !== undefined && canonicalJson(request.expected) !== canonicalJson(current.basis)) throw new ApplicationError("conflict", "Spatial snapshot basis is stale.");
    const result = SpatialProjectSnapshotOutputSchema.parse({
      projectId: current.contents.legacy.project.projectId, version: current.version, basis: current.basis,
      ...current.contents,
      selections: current.contents.selections.map(selection => {
        const candidate = current.contents.candidates.find(value => value.candidateId === selection.candidateId);
        if (candidate === undefined) throw new ApplicationError("invalid-data", "Selected spatial candidate is absent.");
        return { ...selection, status: spatialCandidateStatus(current.contents, candidate) };
      }),
      ...(current.version === 2 ? { head: current.head } : {}),
    });
    if (new TextEncoder().encode(spatialProjectDocumentText(result)).byteLength > SPATIAL_PROJECT_LIMITS.documentBytes) throw new ApplicationError("invalid-data", "Spatial snapshot exceeds its 32 MiB output budget.");
    return result;
  } },
  policy: { ...mutationPolicy, effect: "local-read", cache: "none", maxInputBytes: 1_024, maxOutputBytes: SPATIAL_PROJECT_LIMITS.documentBytes, resume: "deterministic" },
  summarize: output => ({ kind: "spatial.project.snapshot", fields: { projectId: output.projectId, version: output.version, projectRevisionSha256: output.basis.sha256, scenes: output.scenes.length, shots: output.shots.length } }),
};

export const spatialProjectMigrateOperationDefinition = mutationDefinition("spatial.project.migrate", SpatialProjectMigrateInputSchema, async (context, input) => {
  const ports = await ownedPorts(context, input.project);
  return SpatialProjectMutationOutputSchema.parse({ projectId: input.project, ...await migrateSpatialProject({ ports, expected: input.expected, transactionId: input.transactionId, scenes: input.scenes, shots: input.shots, signal: context.abortSignal }) });
});
export const spatialProjectPatchOperationDefinition = mutationDefinition("spatial.project.patch", SpatialProjectPatchInputSchema, async (context, input) => {
  const ports = await ownedPorts(context, input.project);
  let diff: SpatialProjectSceneDiff | undefined;
  const result = await commitSpatialProjectRevision({ ports, expected: input.expected, transactionId: input.transactionId, signal: context.abortSignal, change: current => {
    const patch = applySpatialProjectScenePatch(requireSpatial(current), input.patch, input.retarget);
    diff = patch.diff;
    return patch.contents;
  } });
  return SpatialProjectMutationOutputSchema.parse({ projectId: input.project, ...result, ...(result.kind === "completed" && diff !== undefined ? { diff } : {}) });
});
export const spatialProjectRestoreOperationDefinition = mutationDefinition("spatial.project.restore", SpatialProjectRestoreInputSchema, async (context, input) => {
  const ports = await ownedPorts(context, input.project);
  let diff: SpatialProjectSceneDiff | undefined;
  const result = await commitSpatialProjectRevision({ ports, expected: input.expected, transactionId: input.transactionId, signal: context.abortSignal, change: current => {
    const restored = restoreSpatialProjectScene(requireSpatial(current), input.expectedSceneSha256, input.restoreSceneSha256, input.retarget);
    diff = restored.diff;
    return restored.contents;
  } });
  return SpatialProjectMutationOutputSchema.parse({ projectId: input.project, ...result, ...(result.kind === "completed" && diff !== undefined ? { diff } : {}) });
});
export const spatialProjectAddShotOperationDefinition = mutationDefinition("spatial.project.add-shot", SpatialProjectAddShotInputSchema, async (context, input) => {
  const ports = await ownedPorts(context, input.project);
  return SpatialProjectMutationOutputSchema.parse({ projectId: input.project, ...await commitSpatialProjectRevision({ ports, expected: input.expected, transactionId: input.transactionId, signal: context.abortSignal, change: current => {
    const contents = requireSpatial(current);
    if (contents.shots.some(shot => shot.shotId === input.shot.shotId)) throw new ApplicationError("conflict", "Shot identity already exists.");
    let scenes = contents.scenes;
    if (input.source !== undefined) {
      const document = parseSpatialScene(input.source.document);
      const digest = spatialSceneSha256(document);
      if (digest !== input.source.sceneSha256 || digest !== input.shot.sceneSha256) throw new ApplicationError("invalid-data", "New shot must bind its exact source scene.");
      if (!scenes.some(scene => scene.sceneSha256 === digest)) scenes = [...scenes, { document, sceneSha256: digest }];
    }
    return { ...contents, scenes, shots: [...contents.shots, input.shot] };
  } }) });
});
export const spatialProjectAddCandidateOperationDefinition = mutationDefinition("spatial.project.add-candidate", SpatialProjectAddCandidateInputSchema, async (context, input) => {
  const ports = await ownedPorts(context, input.project);
  return SpatialProjectMutationOutputSchema.parse({ projectId: input.project, ...await commitSpatialProjectRevision({ ports, expected: input.expected, transactionId: input.transactionId, signal: context.abortSignal, change: current => addSpatialCandidate(requireSpatial(current), input.candidate) }) });
});
export const spatialProjectSelectCandidateOperationDefinition = mutationDefinition("spatial.project.select-candidate", SpatialProjectSelectCandidateInputSchema, async (context, input) => {
  const ports = await ownedPorts(context, input.project);
  return SpatialProjectMutationOutputSchema.parse({ projectId: input.project, ...await commitSpatialProjectRevision({ ports, expected: input.expected, transactionId: input.transactionId, signal: context.abortSignal, change: current => selectSpatialCandidate(requireSpatial(current), input.candidateId) }) });
});
export const spatialProjectReconcileOperationDefinition = mutationDefinition("spatial.project.reconcile", SpatialProjectReconcileInputSchema, async (context, input) => {
  const ports = await ownedPorts(context, input.project);
  return SpatialProjectMutationOutputSchema.parse({ projectId: input.project, ...await reconcileSpatialProjectCommit({ ports, attempt: input.attempt }) });
});
