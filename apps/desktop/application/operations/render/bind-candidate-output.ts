import { z } from "zod";

import {
  ProjectRenderEncoderRecipeSchema,
  ProjectRenderOutputRequestSchema,
  ProjectRenderSyncPolicySchema,
  ProjectRenderTargetSchema,
  ProjectRenderToolchainSchema,
  resolveProjectRenderEncoderRecipe,
  type ProjectRenderToolchain,
} from "../../../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
} from "../../../core";
import {
  CreativeCandidateRevisionReferenceV1Schema,
} from "../../creative-iteration";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import {
  ProjectRenderPlanReferenceSchema,
  RenderableProjectEditRevisionReferenceSchema,
} from "../../receipts";
import { throwIfAborted } from "../shared";

/**
 * Increment this ABI whenever Transmute's project-render implementation can
 * change encoded output without changing the render plan or encoder recipe.
 */
export const TRANSMUTE_PROJECT_RENDERER_ABI =
  "transmute-project-renderer-abi-v1" as const;

export const CandidateProjectRendererAbiSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^transmute-project-renderer-abi-v[1-9][0-9]*$/u);

const CandidateRenderDerivationBodyV1Schema = z.strictObject({
  binding: ProjectRenderToolchainSchema,
  candidateRevision: CreativeCandidateRevisionReferenceV1Schema,
  encoderRecipe: ProjectRenderEncoderRecipeSchema,
  kind: z.literal("transmute.candidate-render-derivation"),
  maximumBytes: ProjectRenderOutputRequestSchema.shape.maximumBytes,
  plan: ProjectRenderPlanReferenceSchema,
  rendererAbi: CandidateProjectRendererAbiSchema,
  revision: RenderableProjectEditRevisionReferenceSchema,
  schemaVersion: z.literal(1),
  syncPolicy: ProjectRenderSyncPolicySchema,
  target: ProjectRenderTargetSchema,
});

export const CandidateRenderDerivationV1Schema =
  CandidateRenderDerivationBodyV1Schema.extend({
    derivationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().superRefine((derivation, context) => {
    const body = CandidateRenderDerivationBodyV1Schema.parse({
      binding: derivation.binding,
      candidateRevision: derivation.candidateRevision,
      encoderRecipe: derivation.encoderRecipe,
      kind: derivation.kind,
      maximumBytes: derivation.maximumBytes,
      plan: derivation.plan,
      rendererAbi: derivation.rendererAbi,
      revision: derivation.revision,
      schemaVersion: derivation.schemaVersion,
      syncPolicy: derivation.syncPolicy,
      target: derivation.target,
    });
    if (candidateRenderDerivationSha256(body) !== derivation.derivationSha256) {
      context.addIssue({
        code: "custom",
        message: "Candidate render derivation hash does not match its exact inputs.",
        path: ["derivationSha256"],
      });
    }
    if (!candidateRenderRelationshipsAgree(derivation)) {
      context.addIssue({
        code: "custom",
        message: "Candidate revision, renderable revision, and render plan must describe one exact derivation.",
      });
    }
    if (
      canonicalJson(derivation.encoderRecipe)
      !== canonicalJson(resolveProjectRenderEncoderRecipe(derivation.target.tier))
    ) {
      context.addIssue({
        code: "custom",
        message: "Candidate render encoder recipe must match its exact target tier.",
        path: ["encoderRecipe"],
      });
    }
  });

export const BindCandidateRenderOutputInputRequestSchema = z.strictObject({
  binding: ProjectRenderToolchainSchema.optional(),
  candidateRevision: CreativeCandidateRevisionReferenceV1Schema,
  maximumBytes: ProjectRenderOutputRequestSchema.shape.maximumBytes,
  plan: ProjectRenderPlanReferenceSchema,
  rendererAbi: CandidateProjectRendererAbiSchema.optional(),
  revision: RenderableProjectEditRevisionReferenceSchema,
  syncPolicy: ProjectRenderSyncPolicySchema,
  target: ProjectRenderTargetSchema,
});

export const BindCandidateRenderOutputInputSchema =
  BindCandidateRenderOutputInputRequestSchema.extend({
    binding: ProjectRenderToolchainSchema,
    rendererAbi: CandidateProjectRendererAbiSchema,
  }).strict();

export const CandidateProjectRenderInputSchema = z.strictObject({
  binding: ProjectRenderToolchainSchema,
  derivation: CandidateRenderDerivationV1Schema,
  output: ProjectRenderOutputRequestSchema,
  plan: ProjectRenderPlanReferenceSchema,
  syncPolicy: ProjectRenderSyncPolicySchema,
  target: ProjectRenderTargetSchema,
}).superRefine((input, context) => {
  if (
    input.output.maximumBytes !== input.derivation.maximumBytes
    || canonicalJson(input.binding) !== canonicalJson(input.derivation.binding)
    || canonicalJson(input.plan) !== canonicalJson(input.derivation.plan)
    || input.syncPolicy !== input.derivation.syncPolicy
    || canonicalJson(input.target) !== canonicalJson(input.derivation.target)
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate render request does not match its complete derivation.",
    });
  }
  const expectedPath = candidateRenderOutputPath(input.derivation);
  if (input.output.path !== expectedPath) {
    context.addIssue({
      code: "custom",
      message: "Candidate render output path is not addressed by its complete derivation.",
      path: ["output", "path"],
    });
  }
});

export type BindCandidateRenderOutputInput = z.infer<
  typeof BindCandidateRenderOutputInputSchema
>;
export type BindCandidateRenderOutputInputRequest = z.infer<
  typeof BindCandidateRenderOutputInputRequestSchema
>;
export type CandidateProjectRenderInput = z.infer<
  typeof CandidateProjectRenderInputSchema
>;
export type CandidateRenderDerivationV1 = z.infer<
  typeof CandidateRenderDerivationV1Schema
>;

function candidateRenderRelationshipsAgree(input: {
  readonly candidateRevision: BindCandidateRenderOutputInput["candidateRevision"];
  readonly plan: BindCandidateRenderOutputInput["plan"];
  readonly revision: BindCandidateRenderOutputInput["revision"];
}): boolean {
  const candidate = input.candidateRevision;
  const revision = input.revision;
  const plan = input.plan;
  return !(
    candidate.projectId !== revision.projectId
    || candidate.projectSha256 !== revision.projectSha256
    || candidate.projectStructureSha256 !== revision.projectStructureSha256
    || candidate.projectEditPlanSha256 !== revision.projectEditPlanSha256
    || candidate.revisionSha256 !== revision.revisionSha256
    || candidate.planId !== revision.planId
    || canonicalJson(candidate.artifact) !== canonicalJson(revision.artifact)
    || canonicalJson(candidate.base.generation) !== canonicalJson(revision.baseGeneration)
    || plan.projectId !== revision.projectId
    || plan.projectSha256 !== revision.projectSha256
    || plan.projectEditPlanSha256 !== revision.projectEditPlanSha256
    || plan.revisionSha256 !== revision.revisionSha256
    || plan.outputGeometrySha256 !== revision.outputGeometrySha256
  );
}

function validateCandidateRenderRelationships(
  input: BindCandidateRenderOutputInput,
): void {
  if (!candidateRenderRelationshipsAgree(input)) {
    throw new ApplicationError(
      "conflict",
      "Candidate revision, renderable revision, and render plan must describe one exact derivation.",
    );
  }
}

export function assertCurrentCandidateProjectRendererAbi(
  rendererAbi: string,
): void {
  if (rendererAbi !== TRANSMUTE_PROJECT_RENDERER_ABI) {
    throw new ApplicationError(
      "incompatible",
      "Candidate renderer ABI differs from the current Transmute project renderer.",
      {
        currentRendererAbi: TRANSMUTE_PROJECT_RENDERER_ABI,
        rendererAbi,
      },
    );
  }
}

export function candidateRenderDerivationSha256(
  input: z.input<typeof CandidateRenderDerivationBodyV1Schema>,
): string {
  const body = CandidateRenderDerivationBodyV1Schema.parse(input);
  return canonicalJsonSha256({
    domain: "transmute.candidate-render-derivation/v1",
    ...body,
  });
}

export function createCandidateRenderDerivationV1(
  input: BindCandidateRenderOutputInput,
): CandidateRenderDerivationV1 {
  const exact = BindCandidateRenderOutputInputSchema.parse(input);
  assertCurrentCandidateProjectRendererAbi(exact.rendererAbi);
  validateCandidateRenderRelationships(exact);
  const encoderRecipe = resolveProjectRenderEncoderRecipe(exact.target.tier);
  const body = CandidateRenderDerivationBodyV1Schema.parse({
    ...exact,
    encoderRecipe,
    kind: "transmute.candidate-render-derivation",
    schemaVersion: 1,
  });
  return CandidateRenderDerivationV1Schema.parse({
    ...body,
    derivationSha256: candidateRenderDerivationSha256(body),
  });
}

export function candidateRenderOutputPath(
  derivationInput: CandidateRenderDerivationV1,
): string {
  const derivation = CandidateRenderDerivationV1Schema.parse(derivationInput);
  return ProjectRenderOutputRequestSchema.shape.path.parse(
    `renders/${derivation.candidateRevision.candidate.namespace}/${derivation.revision.revisionSha256}/derivations/${derivation.derivationSha256}.mp4`,
  );
}

export function bindCandidateRenderOutputInput(
  resolvedInput: unknown,
  hostToolchain: ProjectRenderToolchain,
): BindCandidateRenderOutputInput {
  const requested = BindCandidateRenderOutputInputRequestSchema.parse(
    resolvedInput,
  );
  const binding = ProjectRenderToolchainSchema.parse(hostToolchain);
  if (
    requested.binding !== undefined
    && canonicalJson(requested.binding) !== canonicalJson(binding)
  ) {
    throw new ApplicationError(
      "conflict",
      "Candidate render tool binding changed after exact node planning.",
    );
  }
  if (requested.rendererAbi !== undefined) {
    assertCurrentCandidateProjectRendererAbi(requested.rendererAbi);
  }
  const exact = BindCandidateRenderOutputInputSchema.parse({
    ...requested,
    binding,
    rendererAbi: TRANSMUTE_PROJECT_RENDERER_ABI,
  });
  validateCandidateRenderRelationships(exact);
  return exact;
}

export const bindCandidateRenderOutputOperationDefinition = {
  inputSchema: BindCandidateRenderOutputInputSchema,
  inputSchemaId: "studio.operation.render.bind-candidate-output.input/v1",
  kind: "render.bind-candidate-output",
  lifecycle: {
    kind: "pure",
    execute: (context, input) => {
      throwIfAborted(context.abortSignal);
      const derivation = createCandidateRenderDerivationV1(input);
      return Promise.resolve(CandidateProjectRenderInputSchema.parse({
        binding: input.binding,
        derivation,
        output: {
          maximumBytes: input.maximumBytes,
          path: candidateRenderOutputPath(derivation),
        },
        plan: input.plan,
        syncPolicy: input.syncPolicy,
        target: input.target,
      }));
    },
  },
  outputSchema: CandidateProjectRenderInputSchema,
  outputSchemaId: "studio.operation.render.bind-candidate-output.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "pure",
    maxDurationMs: 5_000,
    maxFanOut: 0,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 64 * 1024,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      derivationSha256: output.derivation.derivationSha256,
      outputPath: output.output.path,
      renderPlanSha256: output.plan.renderPlanSha256,
    },
    kind: "render.bind-candidate-output",
  }),
  version: 1,
} satisfies OperationDefinition<
  "render.bind-candidate-output",
  BindCandidateRenderOutputInput,
  CandidateProjectRenderInput
>;
