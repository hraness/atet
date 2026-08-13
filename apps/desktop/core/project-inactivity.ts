import {
  ProjectEditDerivationSchema,
  ProjectInactivityAnalysisV1Schema,
  type ProjectEditPlanV1,
  type ProjectInactivityAnalysisV1,
  type VideoProjectV1,
} from "../contracts";
import {
  cutProjectPlan,
  hashProjectStructure,
  normalizeProjectEditPlan,
  setProjectSpeed,
  unverifiedEnabledPlacementIds,
} from "./project-plan";

type ProjectEditDerivation = ProjectEditPlanV1["derivations"][number];

export type ProjectInactivityProjection =
  | {
      readonly derivations: readonly ProjectEditDerivation[];
      readonly status: "projected";
    }
  | {
      readonly actualProjectStructureSha256?: string;
      readonly expectedProjectStructureSha256?: string;
      readonly reason:
        | "decision-count-mismatch"
        | "project-mismatch"
        | "stale-project-structure"
        | "unverified-sync";
      readonly status: "rejected";
      readonly unverifiedPlacementIds?: readonly VideoProjectV1["placements"][number]["placementId"][];
    };

export interface ProjectInactivityProjectionInput {
  readonly analysis: ProjectInactivityAnalysisV1;
  readonly decisionIds: readonly string[];
  readonly operation: "cut" | "speed";
  readonly project: VideoProjectV1;
}

export interface ApplyProjectInactivityPlanInput extends ProjectInactivityProjectionInput {
  readonly plan: ProjectEditPlanV1;
  readonly speedRate: number;
  readonly updatedAt: string;
}

export type ProjectInactivityPlanApplication =
  | Exclude<ProjectInactivityProjection, { readonly status: "projected" }>
  | {
      readonly derivations: readonly ProjectEditDerivation[];
      readonly plan: ProjectEditPlanV1;
      readonly status: "applied";
    };

/** Convert one immutable project-wide analysis into stale-checkable global edit provenance. */
export function projectInactivityDerivations(
  input: ProjectInactivityProjectionInput,
): ProjectInactivityProjection {
  const analysis = ProjectInactivityAnalysisV1Schema.parse(input.analysis);
  if (analysis.projectId !== input.project.projectId) {
    return { reason: "project-mismatch", status: "rejected" };
  }
  const actualProjectStructureSha256 = hashProjectStructure(input.project);
  if (actualProjectStructureSha256 !== analysis.projectStructureSha256) {
    return {
      actualProjectStructureSha256,
      expectedProjectStructureSha256: analysis.projectStructureSha256,
      reason: "stale-project-structure",
      status: "rejected",
    };
  }
  if (input.decisionIds.length !== analysis.result.recommendedRanges.length) {
    return { reason: "decision-count-mismatch", status: "rejected" };
  }
  return {
    derivations: analysis.result.recommendedRanges.map((projectRange, index) => (
      ProjectEditDerivationSchema.parse({
        decisionId: input.decisionIds[index],
        operation: input.operation,
        origin: {
          analysisId: analysis.analysisId,
          inputDigest: analysis.inputDigest,
          kind: "project-analysis",
          projectStructureSha256: analysis.projectStructureSha256,
        },
        projectRange,
      })
    )),
    status: "projected",
  };
}

/** Apply every recommendation once on the shared project clock and retain its exact analysis derivation. */
export function applyProjectInactivityPlan(
  input: ApplyProjectInactivityPlanInput,
): ProjectInactivityPlanApplication {
  const projection = projectInactivityDerivations(input);
  if (projection.status === "rejected") return projection;
  const unverifiedPlacementIds = unverifiedEnabledPlacementIds(input.project);
  if (unverifiedPlacementIds.length > 0) {
    return { reason: "unverified-sync", status: "rejected", unverifiedPlacementIds };
  }
  let plan = input.plan;
  for (const derivation of projection.derivations) {
    plan = input.operation === "cut"
      ? cutProjectPlan(input.project, plan, derivation.projectRange, input.updatedAt)
      : setProjectSpeed(
          input.project,
          plan,
          derivation.projectRange,
          input.speedRate,
          input.updatedAt,
        );
  }
  return {
    derivations: projection.derivations,
    plan: normalizeProjectEditPlan({
      ...plan,
      derivations: [...plan.derivations, ...projection.derivations],
      updatedAt: input.updatedAt,
    }),
    status: "applied",
  };
}
