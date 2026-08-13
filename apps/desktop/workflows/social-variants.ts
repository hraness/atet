import { z } from "zod";

import { defineWorkflow } from "../code/public";
import {
  ProjectCaptionRequestSchema,
  ProjectRenderTierSchema,
} from "../contracts";
import {
  renderCommonProjectVariants,
} from "./fragments";

export const SocialVariantsInputSchema = z.strictObject({
  captions: ProjectCaptionRequestSchema.optional(),
  maximumBytes: z.number()
    .int()
    .safe()
    .positive()
    .max(1_099_511_627_776)
    .optional(),
  outputDirectory: z.string()
    .regex(/^renders\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
    .refine(value => (
      !value.split("/").some(segment => segment === "." || segment === "..")
    ))
    .optional(),
  project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  syncPolicy: z.enum(["require-verified", "allow-unverified"]).optional(),
  tier: ProjectRenderTierSchema.optional(),
});

export const socialVariants = defineWorkflow({
  id: "social-variants",
  inputSchema: SocialVariantsInputSchema,
  inputSchemaId: "studio.workflow.social-variants.input/v3",
  version: 3,
  build(workflow, input) {
    const project = workflow.project.snapshot("project", input.project);
    const variants = renderCommonProjectVariants(workflow, "render", {
      ...(input.captions === undefined
        ? {}
        : { captions: input.captions }),
      maximumBytes: input.maximumBytes ?? 8 * 1024 * 1024 * 1024,
      outputDirectory: input.outputDirectory ?? "renders/social-variants",
      project,
      syncPolicy: input.syncPolicy ?? "require-verified",
      tier: input.tier ?? "preview",
    });
    const clean = {
      feedPortrait: variants.feedPortrait.output,
      landscape: variants.landscape.output,
      portrait: variants.portrait.output,
      square: variants.square.output,
    };
    if (input.captions === undefined) {
      return clean;
    }
    if (
      variants.feedPortrait.captioned === undefined
      || variants.landscape.captioned === undefined
      || variants.portrait.captioned === undefined
      || variants.square.captioned === undefined
    ) {
      throw new Error("Captioned social variants require all four profile branches.");
    }
    return {
      ...clean,
      captioned: {
        feedPortrait: variants.feedPortrait.captioned.output,
        landscape: variants.landscape.captioned.output,
        portrait: variants.portrait.captioned.output,
        square: variants.square.captioned.output,
      },
    };
  },
});
