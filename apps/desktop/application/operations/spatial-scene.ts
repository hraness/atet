import { z } from "zod";
import { createBoundedJsonValueSnapshot } from "../../../../src/code/json-snapshot";
import {
  EvaluatedSpatialSceneSchema, SpatialAssetManifestSchema, SpatialCameraSchema,
  SpatialDigestSchema, SpatialEntityIdSchema, SpatialGeneratorSchema,
  SpatialOriginSchema, SpatialScenePatchV1Schema, SpatialPlacementSchema, SpatialPoseSchema,
  SpatialSceneV1Schema, SpatialTimeUsSchema,
} from "../../../../src/spatial-scene/contracts";
import { applySpatialScenePatch, evaluateSpatialScene, inspectSpatialScene } from "../../../../src/spatial-scene/index";
import type { OperationDefinition, OperationPolicy } from "../operation";
import { throwIfAborted } from "./shared";

const boundedVector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const SpatialSceneInspectionOutputSchema = z.strictObject({
  sceneId: z.string(), sceneSha256: SpatialDigestSchema, durationUs: SpatialTimeUsSchema,
  entities: z.array(z.strictObject({
    entityId: SpatialEntityIdSchema, name: z.string(),
    kind: z.enum(["group", "mesh", "image", "diagram", "video", "text", "light", "splat"]),
    origin: SpatialOriginSchema, parentId: SpatialEntityIdSchema.nullable(), placement: SpatialPlacementSchema,
    editableControls: z.array(z.enum(["color", "opacity", "transform"])),
    animatedProperties: z.array(z.string()), assetIds: z.array(z.string()),
    bounds: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("authored-enclosure"), coordinateDomain: SpatialPlacementSchema,
        atTimeUs: z.literal(0), bounds: z.strictObject({ min: boundedVector, max: boundedVector }) }),
      z.strictObject({ status: z.literal("unknown"), reason: z.enum(["requires-asset-decoding", "requires-text-layout", "no-surface"]) }),
    ]),
  })).max(4096),
  cameras: z.array(SpatialCameraSchema).max(64),
  assets: z.array(z.strictObject({ assetId: z.string(), manifestSha256: SpatialDigestSchema, manifest: SpatialAssetManifestSchema })).max(128),
  generators: z.array(SpatialGeneratorSchema),
});
const capture = (value: unknown) => createBoundedJsonValueSnapshot(value, 4 * 1024 * 1024, "scene operation", { maximumDepth: 36, maximumValues: 400_000 }).value;
export const SpatialInspectInputSchema = z.preprocess(capture, z.strictObject({ scene: SpatialSceneV1Schema }));
export const SpatialPatchInputSchema = z.preprocess(capture, z.strictObject({ scene: SpatialSceneV1Schema, patch: SpatialScenePatchV1Schema }));
export const SpatialPatchOutputSchema = z.strictObject({
  scene: SpatialSceneV1Schema, sceneSha256: SpatialDigestSchema,
  diff: z.array(z.strictObject({
    kind: z.enum(["added", "removed", "changed"]),
    collection: z.enum(["entities", "cameras", "animations", "generators", "overrides", "assets"]),
    id: z.string(), properties: z.array(z.string()),
  })),
});
export const SpatialEvaluateInputSchema = z.preprocess(capture, z.strictObject({
  scene: SpatialSceneV1Schema, timeUs: SpatialTimeUsSchema, cameraId: z.string(),
  cameraPoseOverride: SpatialPoseSchema.optional(),
}));
export type SpatialInspectInput = z.infer<typeof SpatialInspectInputSchema>;
export type SpatialInspectOutput = z.infer<typeof SpatialSceneInspectionOutputSchema>;
export type SpatialPatchInput = z.infer<typeof SpatialPatchInputSchema>;
export type SpatialPatchOutput = z.infer<typeof SpatialPatchOutputSchema>;
export type SpatialEvaluateInput = z.infer<typeof SpatialEvaluateInputSchema>;
export type SpatialEvaluateOutput = z.infer<typeof EvaluatedSpatialSceneSchema>;

const purePolicy = Object.freeze({
  cache: "content-addressed", cancellable: true, effect: "pure", maxDurationMs: 10_000,
  maxFanOut: 0, maxInputBytes: 4 * 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024,
  preparation: [], resources: [{ amount: 1, resource: "cpu" }], resume: "deterministic",
} as const) satisfies OperationPolicy;

export const spatialInspectOperationDefinition = {
  kind: "scene.inspect", version: 1,
  inputSchema: SpatialInspectInputSchema, inputSchemaId: "atet.operation.scene.inspect.input/v1",
  outputSchema: SpatialSceneInspectionOutputSchema, outputSchemaId: "atet.operation.scene.inspect.output/v1",
  policy: purePolicy,
  lifecycle: { kind: "pure", execute: (context, input) => {
    throwIfAborted(context.abortSignal);
    return Promise.resolve(SpatialSceneInspectionOutputSchema.parse(inspectSpatialScene(input.scene)));
  } },
  summarize: output => ({ kind: "scene.inspect", fields: { sceneSha256: output.sceneSha256, entities: output.entities.length, cameras: output.cameras.length } }),
} satisfies OperationDefinition<"scene.inspect", SpatialInspectInput, SpatialInspectOutput>;

export const spatialPatchOperationDefinition = {
  kind: "scene.patch", version: 1,
  inputSchema: SpatialPatchInputSchema, inputSchemaId: "atet.operation.scene.patch.input/v1",
  outputSchema: SpatialPatchOutputSchema, outputSchemaId: "atet.operation.scene.patch.output/v1",
  policy: purePolicy,
  lifecycle: { kind: "pure", execute: (context, input) => {
    throwIfAborted(context.abortSignal);
    return Promise.resolve(SpatialPatchOutputSchema.parse(applySpatialScenePatch(input.scene, input.patch)));
  } },
  summarize: output => ({ kind: "scene.patch", fields: { sceneSha256: output.sceneSha256, changes: output.diff.length } }),
} satisfies OperationDefinition<"scene.patch", SpatialPatchInput, SpatialPatchOutput>;

export const spatialEvaluateOperationDefinition = {
  kind: "scene.evaluate", version: 1,
  inputSchema: SpatialEvaluateInputSchema, inputSchemaId: "atet.operation.scene.evaluate.input/v1",
  outputSchema: EvaluatedSpatialSceneSchema, outputSchemaId: "atet.operation.scene.evaluate.output/v1",
  policy: purePolicy,
  lifecycle: { kind: "pure", execute: (context, input) => {
    throwIfAborted(context.abortSignal);
    return Promise.resolve(EvaluatedSpatialSceneSchema.parse(evaluateSpatialScene(input.scene, {
      timeUs: input.timeUs, cameraId: input.cameraId,
      ...(input.cameraPoseOverride === undefined ? {} : { cameraPoseOverride: input.cameraPoseOverride }),
    })));
  } },
  summarize: output => ({ kind: "scene.evaluate", fields: { sceneSha256: output.sceneSha256, viewSha256: output.viewSha256, timeUs: output.timeUs } }),
} satisfies OperationDefinition<"scene.evaluate", SpatialEvaluateInput, SpatialEvaluateOutput>;
