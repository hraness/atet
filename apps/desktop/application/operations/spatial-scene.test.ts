import { expect, test } from "bun:test";
import { createSpatialSceneStarter } from "../../../../src/spatial-scene/authoring";
import { spatialSceneSha256 } from "../../../../src/spatial-scene/index";
import { createApplicationOperationRegistry } from "../default-registry";
import { operationApplicationContext } from "./test-support";

const registry = createApplicationOperationRegistry();
const context = { application: operationApplicationContext("/tmp/slopcamera-pure-scene-unused"), abortSignal: new AbortController().signal };

test("closed scene operations expose complete JSON schemas and execute without host effects", async () => {
  const scene = createSpatialSceneStarter();
  for (const kind of ["scene.inspect", "scene.patch", "scene.evaluate"] as const) {
    const description = registry.describe(kind, 1);
    expect(description.inputJsonSchema.type).toBe("object");
    expect(description.policy.effect).toBe("pure");
  }
  const output = await registry.execute(context, { kind: "scene.inspect", version: 1, input: { scene } });
  expect(output.summary.fields.sceneSha256).toBe(spatialSceneSha256(scene));
  expect(output.summary.fields.entities).toBe(4);
  const evaluated = await registry.execute(context, { kind: "scene.evaluate", version: 1, input: { scene, cameraId: "camera_hero", timeUs: 1_000_000 } });
  expect(evaluated.summary.fields.timeUs).toBe(1_000_000);
});

test("scene registry rejects accessors before Zod field traversal and checks graph closure", async () => {
  let reads = 0;
  const input = Object.defineProperty({}, "scene", { enumerable: true, get: () => { reads++; return createSpatialSceneStarter(); } });
  await expect(registry.execute(context, { kind: "scene.inspect", version: 1, input })).rejects.toThrow();
  expect(reads).toBe(0);
  const scene = structuredClone(createSpatialSceneStarter());
  const invalid = { ...scene, entities: scene.entities.map((entity, index) => index === 0 ? { ...entity, parentId: "entity_missing" } : entity) };
  await expect(registry.execute(context, { kind: "scene.inspect", version: 1, input: { scene: invalid } })).rejects.toThrow();
});

test("registered patch returns a new revision and rejects a stale basis", async () => {
  const scene = createSpatialSceneStarter();
  const before = spatialSceneSha256(scene);
  const patch = { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: before, operations: [{ kind: "rename-entity", entityId: "entity_product", name: "Renamed product" }] };
  const output = await registry.execute(context, { kind: "scene.patch", version: 1, input: { scene, patch } });
  expect(output.summary.fields.sceneSha256).not.toBe(before);
  expect(spatialSceneSha256(scene)).toBe(before);
  const result = output.output as { readonly scene: unknown };
  await expect(registry.execute(context, { kind: "scene.patch", version: 1, input: { scene: result.scene, patch } })).rejects.toThrow();
});
