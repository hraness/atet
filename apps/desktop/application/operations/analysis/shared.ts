import { z } from "zod";

import {
  AnalysisIdSchema,
  type ProjectAnalysisReferenceSchema,
  type VideoProjectV1,
} from "../../../contracts";
import { canonicalJson } from "../../../core/canonical-json";
import {
  ExactCapabilityApplicationRunner,
  ExactCapabilityBindingSchema,
  assertExactCapabilityBindings,
  bindExactCapabilities,
  exactCapabilityByName,
  type ExactCapabilityBinding,
} from "../../capability-binding";
import type {
  ApplicationCapability,
  ApplicationContext,
  ApplicationProcessRunner,
} from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationKind } from "../../operation";
import { openLeasedProjectSnapshot } from "../../project-publication-lease";
import {
  assertProjectEditBasis,
  ProjectEditBasisSchema,
  type OpenProjectSnapshot,
} from "../../project-store";
import {
  requiredCapabilityCommand,
} from "../shared";

const ANALYSIS_CAPABILITY_NAMES = [
  "face-analyzer",
  "ffmpeg",
  "ffprobe",
] as const;
type AnalysisCapabilityName = typeof ANALYSIS_CAPABILITY_NAMES[number];

export const AnalysisCapabilityBindingSchema = ExactCapabilityBindingSchema
  .extend({
    name: z.enum(ANALYSIS_CAPABILITY_NAMES),
  })
  .strict();

export const AnalysisCapabilityBindingsSchema = z.array(
  AnalysisCapabilityBindingSchema,
).max(ANALYSIS_CAPABILITY_NAMES.length).superRefine((bindings, context) => {
  for (let index = 0; index < bindings.length; index += 1) {
    const previous = bindings[index - 1];
    if (
      previous !== undefined
      && previous.name.localeCompare(bindings[index]!.name) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Analysis capability bindings must have unique sorted names.",
        path: [index, "name"],
      });
    }
  }
});

export const AnalysisProjectBindingSchema = ProjectEditBasisSchema;

const ANALYSIS_CAPABILITIES = {
  "analysis.faces": ["face-analyzer", "ffprobe"],
  "analysis.music": ["ffmpeg"],
  "analysis.project-inactivity": ["ffmpeg", "ffprobe"],
  "analysis.scenes": ["ffmpeg"],
} as const satisfies Partial<Record<OperationKind, readonly AnalysisCapabilityName[]>>;

export async function bindAnalysisCapabilityInput(
  application: ApplicationContext,
  kind: Extract<
    OperationKind,
    | "analysis.faces"
    | "analysis.music"
    | "analysis.project-inactivity"
    | "analysis.scenes"
  >,
  input: unknown,
): Promise<unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApplicationError("invalid-data", "Analysis operation input must be an object.");
  }
  const names = ANALYSIS_CAPABILITIES[kind];
  const project = "project" in input ? input.project : undefined;
  if (typeof project !== "string") {
    throw new ApplicationError(
      "invalid-data",
      "Analysis operation input must contain a project reference.",
    );
  }
  const [capabilityBindings, snapshot] = await Promise.all([
    bindExactCapabilities(application, names),
    openLeasedProjectSnapshot(application, project),
  ]);
  return {
    ...input,
    capabilityBindings: AnalysisCapabilityBindingsSchema.parse(
      capabilityBindings,
    ),
    projectBinding: snapshot.editBasis,
  };
}

export async function assertAnalysisCapabilityBindings(
  context: { readonly workflow?: unknown },
  expected: z.infer<typeof AnalysisCapabilityBindingsSchema> | undefined,
  application: ApplicationContext,
  names: readonly AnalysisCapabilityName[],
): Promise<void> {
  if (context.workflow !== undefined && expected === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Workflow analysis requires exact capability bindings.",
    );
  }
  if (expected !== undefined) {
    await assertExactCapabilityBindings(application, expected, names);
  }
}

export function analysisCapabilityCommand(
  expected: readonly ExactCapabilityBinding[] | undefined,
  capabilities: ReadonlyMap<
    string,
    ApplicationCapability & { readonly command: string }
  >,
  name: AnalysisCapabilityName,
): string {
  return expected === undefined
    ? requiredCapabilityCommand(capabilities, name)
    : exactCapabilityByName(expected, name).executablePath;
}

export function analysisCapabilityRunner(
  application: Pick<ApplicationContext, "paths" | "runner">,
  expected: readonly ExactCapabilityBinding[] | undefined,
): ApplicationProcessRunner {
  return expected === undefined
    ? application.runner
    : new ExactCapabilityApplicationRunner(
      application.runner,
      expected,
      application.paths.privateRoot,
    );
}

export function assertAnalysisProjectBinding(
  context: { readonly workflow?: unknown },
  expected: z.infer<typeof AnalysisProjectBindingSchema> | undefined,
  snapshot: OpenProjectSnapshot,
): void {
  if (context.workflow !== undefined && expected === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Workflow analysis requires an exact project edit basis.",
    );
  }
  if (expected !== undefined) {
    assertProjectEditBasis(expected, snapshot);
  }
}

export interface AnalysisIdDependencies {
  readonly nextAnalysisId: () => string;
}

export interface VersionedAnalysisDependencies extends AnalysisIdDependencies {
  readonly toolVersion: string;
}

export function resolveAnalysisId(
  requested: string | undefined,
  dependencies: AnalysisIdDependencies,
) {
  return AnalysisIdSchema.parse(requested ?? dependencies.nextAnalysisId());
}

export function resolveToolVersion(
  dependencies: VersionedAnalysisDependencies,
): string {
  return z.string().min(1).max(128).parse(dependencies.toolVersion);
}

export function assertPublishedAnalysisReference(
  project: VideoProjectV1,
  reference: z.infer<typeof ProjectAnalysisReferenceSchema>,
): void {
  const installed = project.analyses.find(
    candidate => candidate.analysisId === reference.analysisId,
  );
  if (installed === undefined || canonicalJson(installed) !== canonicalJson(reference)) {
    throw new ApplicationError(
      "internal",
      `Analysis publication did not install its authoritative ${reference.analysisId} reference.`,
    );
  }
}
