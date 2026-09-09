import { expect, test } from "bun:test";
import { SpatialShotV1Schema } from "../../../src/spatial-scene/contracts";
import { spatialSceneSha256 } from "../../../src/spatial-scene/identity";
import { fixtureCamera, fixtureEntity, fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { editedPlan, syncedProject } from "../application/spatial-project-fixture.testing";
import { restoreSpatialProjectScene, spatialProjectDocumentText, type SpatialProjectContents } from "./spatial-project";

test("restoring a source revalidates camera, override and time closure instead of blindly repointing a digest", () => {
  const project = syncedProject(), original = fixtureScene();
  const current = { ...original, durationUs: 2_000_000, entities: [...original.entities, fixtureEntity("entity_added")], cameras: [...original.cameras, fixtureCamera("camera_added")] };
  const originalSha = spatialSceneSha256(original), currentSha = spatialSceneSha256(current);
  const contents = (cameraId: string, endUs: number): SpatialProjectContents => ({
    legacy: { project, projectEditPlan: editedPlan(project) }, scenes: [{ document: original, sceneSha256: originalSha }, { document: current, sceneSha256: currentSha }],
    shots: [SpatialShotV1Schema.parse({ shotId: "shot_restore", sceneSha256: currentSha, cameraId, range: { startUs: 0, endUs }, sceneStartUs: 0, playback: "once", overrides: [] })], candidates: [], selections: [],
  });
  const overrideBase = contents("camera_main", 100_000);
  const overridden = { ...overrideBase, shots: [SpatialShotV1Schema.parse({ ...overrideBase.shots[0], overrides: [{ entityId: "entity_added", property: "color", value: "#ff0000" }] })] };
  for (const value of [contents("camera_added", 100_000), contents("camera_main", 2_000_000), overridden]) {
    const before = spatialProjectDocumentText(value);
    expect(() => restoreSpatialProjectScene(value, currentSha, originalSha, { kind: "all" })).toThrow();
    expect(spatialProjectDocumentText(value)).toBe(before);
  }
  const different = { ...original, sceneId: "scene_unrelated" }, differentSha = spatialSceneSha256(different);
  const value = contents("camera_main", 100_000);
  expect(() => restoreSpatialProjectScene({ ...value, scenes: [...value.scenes, { document: different, sceneSha256: differentSha }] }, currentSha, differentSha, { kind: "all" })).toThrow("same authored scene identity");
});
