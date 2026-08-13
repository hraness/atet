import { z } from "zod";

import {
  IsoTimestampSchema,
  ProjectEditPlanV1Schema,
  Sha256Schema,
  VideoProjectIdSchema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts";
import { canonicalJsonSha256 } from "../core/canonical-json";
import { hashProjectStructure } from "../core/project-plan";
import {
  loadCurrentProjectPlan,
  openProject,
  type OpenProject,
} from "../cli/project-service";
import { ApplicationError } from "./errors";

export const ProjectGenerationHashesSchema = z.strictObject({
  currentPlanSha256: Sha256Schema,
  generationSha256: Sha256Schema,
  projectSha256: Sha256Schema,
});

export type ProjectGenerationHashes = z.infer<typeof ProjectGenerationHashesSchema>;

/**
 * The mutable project state that editing is allowed to carry across parallel
 * analysis publication. The stable hash excludes analysis references and
 * their `updatedAt` watermark, while an ordered prefix commitment prevents
 * prior references from being removed, reordered, or rewritten. Every other
 * project field and the exact current plan remain bound.
 */
export const ProjectEditBasisSchema = z.strictObject({
  analysisCount: z.number().int().safe().nonnegative(),
  analysisPrefixSha256: Sha256Schema,
  currentPlanSha256: Sha256Schema,
  projectEditBasisSha256: Sha256Schema,
  projectId: VideoProjectIdSchema,
  projectStructureSha256: Sha256Schema,
  projectUpdatedAt: IsoTimestampSchema,
});

export type ProjectEditBasis = z.infer<typeof ProjectEditBasisSchema>;

export interface OpenProjectSnapshot {
  readonly editBasis: ProjectEditBasis;
  readonly generation: ProjectGenerationHashes;
  readonly openProject: OpenProject;
  readonly plan: ProjectEditPlanV1;
  readonly project: VideoProjectV1;
}

export function projectGenerationSha256FromHashes(input: {
  readonly currentPlanSha256: string;
  readonly projectSha256: string;
}): string {
  const currentPlanSha256 = Sha256Schema.parse(input.currentPlanSha256);
  const projectSha256 = Sha256Schema.parse(input.projectSha256);
  return canonicalJsonSha256({
    currentPlanSha256,
    projectSha256,
  });
}

export function hashProjectGeneration(
  projectInput: VideoProjectV1,
  planInput: ProjectEditPlanV1,
): ProjectGenerationHashes {
  const project = VideoProjectV1Schema.parse(projectInput);
  const plan = ProjectEditPlanV1Schema.parse(planInput);
  const currentPlanSha256 = canonicalJsonSha256(plan);
  const projectSha256 = canonicalJsonSha256(project);
  return ProjectGenerationHashesSchema.parse({
    currentPlanSha256,
    generationSha256: projectGenerationSha256FromHashes({
      currentPlanSha256,
      projectSha256,
    }),
    projectSha256,
  });
}

export function projectEditBasis(
  projectInput: VideoProjectV1,
  planInput: ProjectEditPlanV1,
): ProjectEditBasis {
  const project = VideoProjectV1Schema.parse(projectInput);
  const plan = ProjectEditPlanV1Schema.parse(planInput);
  const stableProject = {
    assets: project.assets,
    createdAt: project.createdAt,
    currentEditPlanPath: project.currentEditPlanPath,
    kind: project.kind,
    name: project.name,
    placements: project.placements,
    projectId: project.projectId,
    referencePlacementId: project.referencePlacementId,
    schemaVersion: project.schemaVersion,
    timeline: project.timeline,
  } satisfies Omit<VideoProjectV1, "analyses" | "updatedAt">;
  const currentPlanSha256 = canonicalJsonSha256(plan);
  return ProjectEditBasisSchema.parse({
    analysisCount: project.analyses.length,
    analysisPrefixSha256: canonicalJsonSha256(project.analyses),
    currentPlanSha256,
    projectEditBasisSha256: canonicalJsonSha256({
      currentPlanSha256,
      domain: "studio.project-edit-basis/v1",
      project: stableProject,
    }),
    projectId: project.projectId,
    projectStructureSha256: hashProjectStructure(project),
    projectUpdatedAt: project.updatedAt,
  });
}

export async function openProjectSnapshot(
  projectRoot: string,
  reference: string,
): Promise<OpenProjectSnapshot> {
  const opened = await openProject(projectRoot, reference);
  const plan = await loadCurrentProjectPlan(opened);
  return {
    editBasis: projectEditBasis(opened.project, plan),
    generation: hashProjectGeneration(opened.project, plan),
    openProject: opened,
    plan,
    project: opened.project,
  };
}

export function assertProjectGeneration(
  expectedGenerationSha256: string | undefined,
  actual: ProjectGenerationHashes,
): void {
  if (expectedGenerationSha256 === undefined) {
    throw new ApplicationError(
      "conflict",
      "A checked project operation requires an expected project generation.",
      { actualGenerationSha256: actual.generationSha256 },
    );
  }
  if (expectedGenerationSha256 !== actual.generationSha256) {
    throw new ApplicationError(
      "conflict",
      "Project state changed after the operation snapshot was prepared.",
      {
        actualGenerationSha256: actual.generationSha256,
        expectedGenerationSha256,
      },
    );
  }
}

export function projectMatchesEditBasis(
  expectedInput: ProjectEditBasis,
  snapshot: Pick<OpenProjectSnapshot, "editBasis" | "project">,
): boolean {
  const expected = ProjectEditBasisSchema.parse(expectedInput);
  const actual = ProjectEditBasisSchema.parse(snapshot.editBasis);
  return expected.projectId === actual.projectId
    && expected.currentPlanSha256 === actual.currentPlanSha256
    && expected.projectStructureSha256 === actual.projectStructureSha256
    && expected.projectEditBasisSha256 === actual.projectEditBasisSha256
    && snapshot.project.analyses.length >= expected.analysisCount
    && canonicalJsonSha256(
      snapshot.project.analyses.slice(0, expected.analysisCount),
    ) === expected.analysisPrefixSha256
    && Date.parse(snapshot.project.updatedAt) >= Date.parse(expected.projectUpdatedAt);
}

export function assertProjectEditBasis(
  expectedInput: ProjectEditBasis,
  snapshot: Pick<OpenProjectSnapshot, "editBasis" | "project">,
): void {
  const expected = ProjectEditBasisSchema.parse(expectedInput);
  const actual = ProjectEditBasisSchema.parse(snapshot.editBasis);
  if (!projectMatchesEditBasis(expected, snapshot)) {
    throw new ApplicationError(
      "conflict",
      "Project editing state changed after the workflow basis was prepared.",
      {
        actualAnalysisCount: actual.analysisCount,
        actualCurrentPlanSha256: actual.currentPlanSha256,
        actualProjectEditBasisSha256: actual.projectEditBasisSha256,
        expectedAnalysisCount: expected.analysisCount,
        expectedCurrentPlanSha256: expected.currentPlanSha256,
        expectedProjectEditBasisSha256: expected.projectEditBasisSha256,
        projectId: expected.projectId,
      },
    );
  }
}
