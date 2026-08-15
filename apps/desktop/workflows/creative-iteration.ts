import { z } from "zod";

import {
  CreativeVariantKeySchema,
  deriveProjectEditBatchV3,
  OrderedProjectEditV3Schema,
} from "../application";
import { defineWorkflow } from "../code/public";
import {
  ProjectExportProfileIdSchema,
  ProjectRenderSyncPolicySchema,
  resolveProjectExportProfile,
} from "../contracts";

export const CreativeIterationCandidateInputSchema = z.strictObject({
  ordered: z.array(OrderedProjectEditV3Schema).max(10_000).default([]),
  variantKey: CreativeVariantKeySchema,
});

export const CreativeIterationInputSchema = z.strictObject({
  candidates: z.array(CreativeIterationCandidateInputSchema)
    .min(2)
    .max(16),
  maximumBytes: z.number()
    .int()
    .safe()
    .positive()
    .max(1_099_511_627_776)
    .optional(),
  previewProfile: ProjectExportProfileIdSchema.optional(),
  project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  syncPolicy: ProjectRenderSyncPolicySchema.optional(),
}).superRefine((input, context) => {
  const variantKeys = input.candidates.map(candidate => candidate.variantKey);
  if (new Set(variantKeys).size !== variantKeys.length) {
    context.addIssue({
      code: "custom",
      message: "Creative iteration variant keys must be unique.",
      path: ["candidates"],
    });
  }
});

/**
 * Build complete, low-cost preview candidates from one exact frozen project.
 * Selection and promotion are deliberately separate workflow effects.
 */
export const creativeIteration = defineWorkflow({
  id: "creative-iteration",
  inputSchema: CreativeIterationInputSchema,
  inputSchemaId: "atet.workflow.creative-iteration.input/v1",
  version: 1,
  build(workflow, input) {
    const project = workflow.iteration.base("base", input.project);
    const profileId = input.previewProfile ?? "landscape";
    const profile = resolveProjectExportProfile(profileId, "preview");
    const maximumBytes = input.maximumBytes ?? 2 * 1024 * 1024 * 1024;
    const syncPolicy = input.syncPolicy ?? "require-verified";
    const target = {
      canvas: { kind: "profile" as const, profileId },
      tier: "preview" as const,
    };
    const candidates = input.candidates.map(candidateInput => {
      const branch = workflow.namespace("candidates")
        .namespace(candidateInput.variantKey);
      const batch = candidateInput.ordered.length === 0
        ? branch.iteration.baseline()
        : deriveProjectEditBatchV3(candidateInput.ordered);
      const revision = branch.iteration.createRevision("revision", {
        batch,
        project,
        variantKey: candidateInput.variantKey,
      });
      const preview = branch.namespace("preview");
      const bound = preview.iteration.bindRevision("binding", {
        pixelHeight: profile.pixelHeight,
        pixelWidth: profile.pixelWidth,
        revision,
      });
      const plan = preview.render.plan("plan", {
        revision: bound,
        settings: { frameRate: profile.frameRate },
      });
      const renderBinding = preview.render.bindCandidateOutput("derivation", {
        maximumBytes,
        plan,
        revision: bound,
        syncPolicy,
        target,
      });
      const render = preview.render.candidateProject("output", renderBinding);
      return branch.iteration.candidate("candidate", {
        renders: [{ name: "preview", render }],
        revision,
      });
    });
    const matrix = workflow.iteration.matrix("matrix", {
      candidates,
      project,
    });
    return {
      base: project.snapshot,
      candidates: candidates.map(candidate => candidate.reference),
      matrix: matrix.reference,
    };
  },
});
