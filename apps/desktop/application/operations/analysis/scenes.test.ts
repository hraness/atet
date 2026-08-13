import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  planSceneSampling,
} from "../../../core";
import {
  resolveVideoAnalysisSubject,
} from "../../../cli/scene-analysis-service";
import { OperationRegistry } from "../../registry";
import {
  OPERATION_TEST_HASH,
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  SceneAnalysisOperationOutputSchema,
  createSceneAnalysisOperationDefinition,
} from "./scenes";

describe("scene analysis operation", () => {
  test("persists bounded scene ranges and sample reasons in its typed output", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-scene-operation-"),
    );
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const source = "asset_operation01:stream_operation01";
      const subject = resolveVideoAnalysisSubject(
        fixture.project,
        source,
      ).subject;
      const plan = planSceneSampling({
        boundaries: [{
          confidence: 0.8,
          kind: "visual",
          timeUs: 4_000_000,
        }],
        inputDigest: subject.integritySha256,
        maximumSceneDurationUs: 3_000_000,
        ranges: [{ endUs: 10_000_000, startUs: 0 }],
      });
      const calls: unknown[] = [];
      const registry = new OperationRegistry();
      registry.register(createSceneAnalysisOperationDefinition({
        plan: (options) => {
          calls.push(options);
          return Promise.resolve({ plan, subject });
        },
      }));
      const application = operationApplicationContext(repositoryRoot, {
        capabilities: () => Promise.resolve([{
          available: true,
          command: "/tools/ffmpeg",
          name: "ffmpeg",
          version: "7.1",
        }]),
      });
      const result = await registry.execute({
        abortSignal: new AbortController().signal,
        application,
      }, {
        input: {
          config: {
            maximumSceneDurationUs: 3_000_000,
            sceneThreshold: 0.42,
          },
          project: fixture.project.projectId,
          source,
        },
        kind: "analysis.scenes",
        version: 1,
      });
      const output = SceneAnalysisOperationOutputSchema.parse(result.output);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        ffmpeg: "/tools/ffmpeg",
        maximumSceneDurationUs: 3_000_000,
        sceneThreshold: 0.42,
        source,
      });
      expect(output.planDigest).toBe(plan.planDigest);
      expect(output.scenes.map(scene => scene.range)).toEqual([
        { endUs: 3_000_000, startUs: 0 },
        { endUs: 4_000_000, startUs: 3_000_000 },
        { endUs: 7_000_000, startUs: 4_000_000 },
        { endUs: 10_000_000, startUs: 7_000_000 },
      ]);
      expect(output.samples.find(sample => (
        sample.requestedAssetTimeUs === 4_000_000
      ))?.reasons).toEqual(["boundary"]);
      expect(result.summary.fields).toEqual({
        planDigest: plan.planDigest,
        projectId: fixture.project.projectId,
        samples: plan.samples.length,
        scenes: plan.scenes.length,
        source,
      });
      expect(result.summary.fields).not.toHaveProperty("ranges");
      expect(result.summary.fields).not.toHaveProperty("sampleReasons");
      expect(subject.integritySha256).not.toBe(OPERATION_TEST_HASH);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects scene evidence that no longer matches its digest", () => {
    const plan = planSceneSampling({
      boundaries: [],
      inputDigest: OPERATION_TEST_HASH,
      maximumSceneDurationUs: 3_000_000,
      ranges: [{ endUs: 3_000_000, startUs: 0 }],
    });
    expect(SceneAnalysisOperationOutputSchema.safeParse({
      planDigest: "b".repeat(64),
      projectId: "project_operation01",
      samples: plan.samples,
      samplingVersion: plan.samplingVersion,
      scenes: plan.scenes,
      source: "asset_operation01:stream_operation01",
      subject: {
        assetId: "asset_operation01",
        integritySha256: OPERATION_TEST_HASH,
        streamId: "stream_operation01",
      },
    }).success).toBe(false);
  });
});
