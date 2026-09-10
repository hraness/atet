import { planStudioJob, studioSourceBundleSha256 } from "../../../../src/studio";
import { BoundStudioRunInputSchema, StudioRunOutputSchema } from "../studio-port";

export function studioOperationFixture() {
  const sha = "a".repeat(64);
  const bundle = { kind: "slopcamera.studio-source-bundle", schemaVersion: 1, engine: "cadquery", entrypoint: { kind: "python", path: "part.py" }, files: [{ path: "part.py", bytes: 32, sha256: sha }] };
  const job = {
    kind: "slopcamera.studio-job", schemaVersion: 1, jobId: "studio_fixture", bundleSha256: studioSourceBundleSha256(bundle), stage: "build", parameters: {},
    engine: { engine: "cadquery", exportVariable: "result", tolerance: 0.1, angularTolerance: 0.1 },
    outputs: [{ kind: "file", id: "part", path: "part.step", format: "step", role: "model", interpretation: { kind: "model", sourceSpace: { units: "millimeters", upAxis: "z", handedness: "right" } } }],
    limits: { timeoutSeconds: 30, maximumOutputBytes: 1000, maximumOutputFiles: 1 }, execution: { trust: "trusted-current-user", isolation: "none", hermetic: false },
  };
  const runtime = {
    kind: "slopcamera.studio-runtime", schemaVersion: 1, engine: "cadquery", tool: { name: "Python", version: "fixture", executableSha256: sha }, driverSha256: sha,
    environment: { fingerprintSha256: sha, evidence: "observed-package-environment", hermetic: false },
    capabilities: ["python-authoring", "build", "model-export"].map(name => ({ name, support: "available", evidence: "probe" })),
  };
  const plan = planStudioJob({ bundle, job, runtime });
  const input = BoundStudioRunInputSchema.parse({ bundle: { path: `artifacts/slopcamera/private/studio/bundles/${plan.bundleSha256}/bundle.json`, bytes: 200, sha256: sha }, job: plan.job, plan });
  const output = StudioRunOutputSchema.parse({
    receipt: { path: "artifacts/slopcamera/private/studio/jobs/studio_fixture/receipt.json", bytes: 600, sha256: sha },
    document: { kind: "slopcamera.studio-receipt", schemaVersion: 1, jobId: job.jobId, attemptId: "attempt_fixture", planSha256: plan.planSha256, bundleSha256: plan.bundleSha256,
      jobSha256: plan.jobSha256, runtime: plan.runtime, runtimeSha256: plan.runtimeSha256, startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z", state: "succeeded", custody: "closed", exitCode: 0,
      outputs: [{ outputId: "part", path: "part.step", bytes: 100, sha256: sha, role: "model", format: "step" }],
    },
    outputs: [{ artifact: { path: "artifacts/slopcamera/private/studio/jobs/studio_fixture/outputs/part.step", bytes: 100, sha256: sha }, outputId: "part", role: "model", format: "step" }],
  });
  return { input, output };
}
