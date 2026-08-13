import { assertProperty, fc } from "../testing/property";

import { planSceneSampling } from "./scene-sampling";

const digest = "d".repeat(64);
const MAX_GENERATED_BOUNDARIES = 16;
const MAX_GENERATED_GAP_SCENES = 16;

const samplingWindowArbitrary = fc.integer({ min: 1, max: 200_000 }).chain(durationUs => fc.record({
  durationUs: fc.constant(durationUs),
  maximumSceneDurationUs: fc.integer({
    max: 200_000,
    min: Math.max(1, Math.ceil(durationUs / MAX_GENERATED_GAP_SCENES)),
  }),
}));

function requireInvariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assertProperty(fc.property(
  samplingWindowArbitrary,
  fc.array(fc.record({
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    kind: fc.constantFrom("event" as const, "motion" as const, "visual" as const),
    offsetUs: fc.integer({ min: 0, max: 200_000 }),
  }), { maxLength: MAX_GENERATED_BOUNDARIES }),
  ({ durationUs, maximumSceneDurationUs }, candidates) => {
    const boundaries = candidates.map(candidate => ({
      confidence: candidate.confidence,
      kind: candidate.kind,
      timeUs: candidate.offsetUs % (durationUs + 1),
    }));
    const input = {
      boundaries,
      inputDigest: digest,
      maximumSceneDurationUs,
      ranges: [{ endUs: durationUs, startUs: 0 }],
    };
    const plan = planSceneSampling(input);
    const reversedPlan = planSceneSampling({ ...input, boundaries: [...boundaries].reverse() });
    requireInvariant(
      JSON.stringify(reversedPlan) === JSON.stringify(plan),
      "Boundary input order changed the scene-sampling plan.",
    );
    requireInvariant(plan.scenes[0]?.range.startUs === 0, "The plan did not start at the input range.");
    requireInvariant(
      plan.scenes.at(-1)?.range.endUs === durationUs,
      "The plan did not end at the input range.",
    );
    const sceneIds = new Set(plan.scenes.map(scene => scene.sceneId));
    requireInvariant(sceneIds.size === plan.scenes.length, "Scene IDs were not unique.");
    requireInvariant(
      new Set(plan.samples.map(sample => sample.sampleId)).size === plan.samples.length,
      "Sample IDs were not unique.",
    );

    const samplesBySceneId = new Map<string, (typeof plan.samples)[number][]>();
    for (const sample of plan.samples) {
      const owned = samplesBySceneId.get(sample.sceneId) ?? [];
      owned.push(sample);
      samplesBySceneId.set(sample.sceneId, owned);
    }

    for (let index = 0; index < plan.scenes.length; index += 1) {
      const scene = plan.scenes[index]!;
      requireInvariant(
        scene.range.endUs - scene.range.startUs <= maximumSceneDurationUs,
        "A scene exceeded the maximum scene duration.",
      );
      requireInvariant(
        index === 0 || scene.range.startUs === plan.scenes[index - 1]!.range.endUs,
        "Adjacent scenes were not contiguous.",
      );
      const owned = samplesBySceneId.get(scene.sceneId) ?? [];
      requireInvariant(owned.length >= 1 && owned.length <= 3, "A scene did not own between one and three samples.");
      for (const sample of owned) {
        requireInvariant(
          sample.requestedAssetTimeUs >= scene.range.startUs
            && sample.requestedAssetTimeUs < scene.range.endUs,
          "A sample fell outside its owning scene.",
        );
      }
    }
    requireInvariant(
      [...samplesBySceneId.keys()].every(sceneId => sceneIds.has(sceneId)),
      "A sample referenced an unknown scene.",
    );
  },
), {
  interruptAfterTimeLimit: 30_000,
});
