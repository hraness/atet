import { describe, expect, test } from "bun:test";

import { defaultAtetHostResourceProfile } from "@hraness/atet/host-resources";

import {
  CONCURRENCY_BENCHMARK_FIXTURE,
  CONCURRENCY_BENCHMARK_HOST_RESOURCE_PROFILE,
  createConcurrencyBenchmarkReport,
  runConcurrencyBenchmark,
} from "./concurrency-benchmark";

describe("code-mode concurrency benchmark", () => {
  test("isolates timer admission from production low-core headroom", () => {
    expect(CONCURRENCY_BENCHMARK_HOST_RESOURCE_PROFILE).toEqual({
      capacities: [{ limit: 4, resource: "cpu" }],
      id: "atet.concurrency-benchmark/v1",
    });
    expect(defaultAtetHostResourceProfile(2).capacities).toContainEqual({
      limit: 1,
      resource: "cpu",
    });
  });

  test("materially overlaps independent production-scheduler operations", async () => {
    const result = await runConcurrencyBenchmark();
    const expectedJoinValue = CONCURRENCY_BENCHMARK_FIXTURE.joinBaseValue
      + CONCURRENCY_BENCHMARK_FIXTURE.branches
        .reduce((sum, branch) => sum + branch.value, 0);

    expect(result.sequential.graphPlanSha256).toBe(result.graphPlanSha256);
    expect(result.parallel.graphPlanSha256).toBe(result.graphPlanSha256);
    expect(result.sequential.join).toEqual({ id: "join", value: expectedJoinValue });
    expect(result.parallel.join).toEqual({ id: "join", value: expectedJoinValue });
    expect(result.sequential.spans.map(span => span.nodeKey))
      .toEqual(["branch-a", "branch-b", "branch-c", "branch-d", "join"]);
    expect(result.parallel.spans.map(span => span.nodeKey).sort())
      .toEqual(["branch-a", "branch-b", "branch-c", "branch-d", "join"]);

    const materialOverlapMilliseconds =
      CONCURRENCY_BENCHMARK_FIXTURE.delayMilliseconds * 0.65;
    expect(result.rootPairOverlapMilliseconds).toBeGreaterThan(
      materialOverlapMilliseconds,
    );
    expect(result.branchElapsedRatio).toBeLessThan(0.65);
    expect(result.branchSpeedup).toBeGreaterThan(1.5);

    const report = createConcurrencyBenchmarkReport(result);
    expect(report).toMatchObject({
      correctness: {
        graphPlanSha256: result.graphPlanSha256,
        join: { id: "join", value: expectedJoinValue },
        sameImmutableGraphPlan: true,
      },
      method: {
        branchCount: 4,
        branchStart: "rendezvous-after-scheduler-admission",
        operationDelayMilliseconds:
          CONCURRENCY_BENCHMARK_FIXTURE.delayMilliseconds,
        parallelJobs: 4,
        primaryMeasurement: "independent-branch-wall-clock",
        scheduler: "DurableWorkflowScheduler",
        sequentialJobs: 1,
      },
      version: "atet-code-concurrency-benchmark-report/v1",
      verdict: {
        materialParallelism: true,
        thresholds: {
          maximumBranchElapsedRatio: 0.65,
          minimumPairOverlapMilliseconds:
            CONCURRENCY_BENCHMARK_FIXTURE.delayMilliseconds * 0.65,
        },
      },
    });
    process.stdout.write(
      `[atet concurrency] ${JSON.stringify(report.measurements)}\n`,
    );
  }, 30_000);
});
