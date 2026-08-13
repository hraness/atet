import { z } from "zod";

import {
  PROJECT_EXPORT_PROFILE_IDS,
  ProjectExportVariantSchema,
  ProjectRenderOutputPathSchema,
  ProjectRenderSyncPolicySchema,
  projectExportVariantId,
  resolveProjectRenderTarget,
} from "../contracts";
import type {
  ProjectCaptionRequest,
  ProjectExportVariant,
  ProjectRenderTarget,
  ProjectRenderTier,
} from "../contracts";
import {
  MediaOverlayInputSchema as MediaOverlayOperationInputSchema,
  type ProjectRenderOutput,
  type ProjectRenderPlanOutput,
} from "../application/operations";
import type {
  CommittedProjectHandle,
  PreparedOverlayHandle,
  ProjectEditRevisionHandle,
  ProjectHandle,
  Ref,
  WorkflowBuilder,
} from "../code/public";

const WorkflowOverlayBodySchema = MediaOverlayOperationInputSchema.omit({
  capabilityBindings: true,
  project: true,
});

export const WorkflowOverlayRequestSchema = WorkflowOverlayBodySchema.extend({
  key: z.string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
}).strict().superRefine((overlay, context) => {
  if (overlay.source.kind === "emoji" && overlay.source.resolved !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Workflow overlay inputs cannot carry host-resolved emoji authority.",
      path: ["source", "resolved"],
    });
  }
});

export type WorkflowOverlayRequest = z.infer<
  typeof WorkflowOverlayRequestSchema
>;

export const WorkflowOverlaySetSchema = z.array(WorkflowOverlayRequestSchema)
  .min(1)
  .max(256)
  .superRefine((overlays, context) => {
    const seen = new Set<string>();
    for (const [index, overlay] of overlays.entries()) {
      if (seen.has(overlay.key)) {
        context.addIssue({
          code: "custom",
          message: "Workflow overlay keys must be unique.",
          path: [index, "key"],
        });
      }
      seen.add(overlay.key);
    }
  });

export interface ComposedOverlaySet {
  readonly prepared: readonly PreparedOverlayHandle[];
  readonly project: CommittedProjectHandle;
}

export function prepareAndCommitOverlays(
  workflow: WorkflowBuilder,
  key: string,
  input: {
    readonly overlays: readonly WorkflowOverlayRequest[];
    readonly project: ProjectHandle;
  },
): ComposedOverlaySet {
  const overlays = WorkflowOverlaySetSchema.parse(input.overlays);
  const fragment = workflow.namespace(key);
  const preparation = fragment.namespace("prepare");
  const prepared = overlays.map((overlay) => {
    const { key: overlayKey, ...request } = overlay;
    return preparation.media.overlay(overlayKey, {
      ...request,
      identityKey: request.identityKey ?? overlayKey,
      project: input.project,
    });
  });
  const batch = fragment.edits.addOverlays("batch", prepared);
  const project = fragment.project.commitEdits("commit", {
    batch,
    project: input.project,
  });
  return Object.freeze({
    prepared: Object.freeze(prepared),
    project,
  });
}

export const WorkflowRenderOptionsSchema = z.strictObject({
  maximumBytes: z.number()
    .int()
    .safe()
    .positive()
    .max(1_099_511_627_776)
    .optional(),
  output: ProjectRenderOutputPathSchema.optional(),
  syncPolicy: ProjectRenderSyncPolicySchema.optional(),
});

export type WorkflowRenderOptions = z.infer<
  typeof WorkflowRenderOptionsSchema
>;

/**
 * Exact render geometry has one owner. New workflows select a render target;
 * legacy callers may still provide explicit dimensions without a render tier.
 */
export type WorkflowProjectRenderGeometry =
  | {
    readonly target: ProjectRenderTarget;
    readonly frameRate?: never;
    readonly pixelHeight?: never;
    readonly pixelWidth?: never;
  }
  | {
    readonly target?: undefined;
    readonly frameRate?: number;
    readonly pixelHeight: number;
    readonly pixelWidth: number;
  };

export interface ResolvedWorkflowRenderOptions {
  readonly maximumBytes: number;
  readonly output: z.infer<typeof ProjectRenderOutputPathSchema>;
  readonly syncPolicy: z.infer<typeof ProjectRenderSyncPolicySchema>;
}

export function resolveWorkflowRenderOptions(
  options: WorkflowRenderOptions | undefined,
  defaultOutput: string,
): ResolvedWorkflowRenderOptions {
  return {
    maximumBytes: options?.maximumBytes ?? 8 * 1024 * 1024 * 1024,
    output: ProjectRenderOutputPathSchema.parse(
      options?.output ?? defaultOutput,
    ),
    syncPolicy: options?.syncPolicy ?? "require-verified",
  };
}

function renderFrozenProjectPresentations(
  workflow: WorkflowBuilder,
  key: string,
  input: {
    readonly captioned?: {
      readonly captions: ProjectCaptionRequest;
      readonly output: ResolvedWorkflowRenderOptions;
    };
    readonly output?: ResolvedWorkflowRenderOptions;
    readonly project: ProjectHandle;
  } & WorkflowProjectRenderGeometry,
) {
  if (input.output === undefined && input.captioned === undefined) {
    throw new Error("A frozen project target requires at least one presentation.");
  }
  const fragment = workflow.namespace(key);
  const geometry = input.target === undefined
    ? {
        frameRate: input.frameRate,
        pixelHeight: input.pixelHeight,
        pixelWidth: input.pixelWidth,
      }
    : resolveProjectRenderTarget(input.target);
  const revision = fragment.project.freezeRevision("revision", {
    pixelHeight: geometry.pixelHeight,
    pixelWidth: geometry.pixelWidth,
    project: input.project,
  });
  const clean = input.output === undefined
    ? undefined
    : (() => {
        const plan = fragment.render.plan("plan", {
          revision,
          ...(geometry.frameRate === undefined
            ? {}
            : { settings: { frameRate: geometry.frameRate } }),
        });
        return Object.freeze({
          output: fragment.render.project("output", {
            ...(input.target === undefined
              ? {}
              : { target: input.target }),
            output: {
              maximumBytes: input.output.maximumBytes,
              path: input.output.output,
            },
            plan,
            syncPolicy: input.output.syncPolicy,
          }),
          plan,
        });
      })();
  const captioned = input.captioned === undefined
    ? undefined
    : (() => {
        const fragmentCaptioned = fragment.namespace("captioned");
        const plan = fragmentCaptioned.render.captionedPlan("plan", {
          revision,
          settings: {
            captions: input.captioned.captions,
            ...(geometry.frameRate === undefined
              ? {}
              : { frameRate: geometry.frameRate }),
          },
        });
        return Object.freeze({
          output: fragmentCaptioned.render.project("output", {
            ...(input.target === undefined
              ? {}
              : { target: input.target }),
            output: {
              maximumBytes: input.captioned.output.maximumBytes,
              path: input.captioned.output.output,
            },
            plan,
            syncPolicy: input.captioned.output.syncPolicy,
          }),
          plan,
        });
      })();
  return Object.freeze({ captioned, clean, revision });
}

export function renderFrozenProject(
  workflow: WorkflowBuilder,
  key: string,
  input: {
    readonly captioned?: {
      readonly captions: ProjectCaptionRequest;
      readonly output: ResolvedWorkflowRenderOptions;
    };
    readonly output: ResolvedWorkflowRenderOptions;
    readonly project: ProjectHandle;
  } & WorkflowProjectRenderGeometry,
) {
  const rendered = renderFrozenProjectPresentations(workflow, key, input);
  if (rendered.clean === undefined) {
    throw new Error("A frozen project render omitted its required clean presentation.");
  }
  return Object.freeze({
    captioned: rendered.captioned,
    output: rendered.clean.output,
    plan: rendered.clean.plan,
    revision: rendered.revision,
  });
}

export interface RenderedProjectVariant {
  readonly output: Ref<ProjectRenderOutput>;
  readonly plan: Ref<ProjectRenderPlanOutput>;
  readonly revision: ProjectEditRevisionHandle;
}

export const WorkflowProjectVariantMatrixSchema = z.array(
  ProjectExportVariantSchema,
).min(1).max(16).superRefine((variants, context) => {
  const identities = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    const identity = projectExportVariantId(variant);
    if (identities.has(identity)) {
      context.addIssue({
        code: "custom",
        message: "Project export variants must be unique.",
        path: [index],
      });
    }
    identities.add(identity);
  }
});

/**
 * Expands orthogonal canvas, quality, and caption choices into independent
 * graph branches. Clean and captioned presentations of one concrete target
 * share the same immutable revision. The graph keeps distinct geometries
 * independent even though today's conservative project-render resource
 * serializes their expensive FFmpeg work.
 */
export function renderProjectVariantMatrix(
  workflow: WorkflowBuilder,
  key: string,
  input: {
    readonly captions?: ProjectCaptionRequest;
    readonly maximumBytes: number;
    readonly outputDirectory: string;
    readonly outputLayout?: "flat" | "tiered";
    readonly project: ProjectHandle;
    readonly syncPolicy: z.infer<typeof ProjectRenderSyncPolicySchema>;
    readonly variants: readonly ProjectExportVariant[];
  },
): Readonly<Record<string, RenderedProjectVariant>> {
  const directory = input.outputDirectory.replace(/\/+$/u, "");
  const requested = WorkflowProjectVariantMatrixSchema.parse(input.variants);
  const outputLayout = z.enum(["flat", "tiered"]).parse(
    input.outputLayout ?? "tiered",
  );
  if (
    outputLayout === "flat"
    && new Set(requested.map(variant => variant.tier)).size > 1
  ) {
    throw new Error("A flat project export matrix cannot contain multiple tiers.");
  }
  if (
    requested.some(variant => variant.captionMode === "burn-in")
    && input.captions === undefined
  ) {
    throw new Error("Captioned project export variants require a caption request.");
  }
  const namespace = workflow.namespace(key);
  const groups = new Map<string, {
    readonly profileId: ProjectExportVariant["profileId"];
    readonly tier: ProjectRenderTier;
    readonly modes: ReadonlySet<ProjectExportVariant["captionMode"]>;
  }>();
  for (const variant of requested) {
    const groupId = `${variant.tier}/${variant.profileId}`;
    if (groups.has(groupId)) continue;
    groups.set(groupId, {
      modes: new Set(requested
        .filter(candidate => (
          candidate.tier === variant.tier
          && candidate.profileId === variant.profileId
        ))
        .map(candidate => candidate.captionMode)),
      profileId: variant.profileId,
      tier: variant.tier,
    });
  }
  const outputs: Record<string, RenderedProjectVariant> = {};
  for (const group of groups.values()) {
    const groupDirectory = outputLayout === "tiered"
      ? `${directory}/${group.tier}`
      : directory;
    const rendered = renderFrozenProjectPresentations(
      outputLayout === "tiered" ? namespace.namespace(group.tier) : namespace,
      group.profileId,
      {
        ...(group.modes.has("burn-in") && input.captions !== undefined
          ? {
              captioned: {
                captions: input.captions,
                output: {
                  maximumBytes: input.maximumBytes,
                  output: ProjectRenderOutputPathSchema.parse(
                    `${groupDirectory}/${group.profileId}-captioned.mp4`,
                  ),
                  syncPolicy: input.syncPolicy,
                },
              },
            }
          : {}),
        ...(group.modes.has("clean")
          ? {
              output: {
                maximumBytes: input.maximumBytes,
                output: ProjectRenderOutputPathSchema.parse(
                  `${groupDirectory}/${group.profileId}.mp4`,
                ),
                syncPolicy: input.syncPolicy,
              },
            }
          : {}),
        target: {
          canvas: { kind: "profile", profileId: group.profileId },
          tier: group.tier,
        },
        project: input.project,
      },
    );
    if (group.modes.has("clean")) {
      if (rendered.clean === undefined) {
        throw new Error("Clean project export branch was not constructed.");
      }
      outputs[projectExportVariantId({
        captionMode: "clean",
        profileId: group.profileId,
        tier: group.tier,
      })] = Object.freeze({
        output: rendered.clean.output,
        plan: rendered.clean.plan,
        revision: rendered.revision,
      });
    }
    if (group.modes.has("burn-in")) {
      if (rendered.captioned === undefined) {
        throw new Error("Captioned project export branch was not constructed.");
      }
      outputs[projectExportVariantId({
        captionMode: "burn-in",
        profileId: group.profileId,
        tier: group.tier,
      })] = Object.freeze({
        output: rendered.captioned.output,
        plan: rendered.captioned.plan,
        revision: rendered.revision,
      });
    }
  }
  return Object.freeze(outputs);
}

export function renderCommonProjectVariants(
  workflow: WorkflowBuilder,
  key: string,
  input: {
    readonly captions?: ProjectCaptionRequest;
    readonly maximumBytes: number;
    readonly outputDirectory: string;
    readonly project: ProjectHandle;
    readonly syncPolicy: z.infer<typeof ProjectRenderSyncPolicySchema>;
    readonly tier?: ProjectRenderTier;
  },
) {
  const explicitTier = input.tier !== undefined;
  const tier = input.tier ?? "final";
  const variants = PROJECT_EXPORT_PROFILE_IDS.flatMap(profileId => [
    ProjectExportVariantSchema.parse({
      captionMode: "clean",
      profileId,
      tier,
    }),
    ...(input.captions === undefined
      ? []
      : [ProjectExportVariantSchema.parse({
          captionMode: "burn-in",
          profileId,
          tier,
        })]),
  ]);
  const outputs = renderProjectVariantMatrix(workflow, key, {
    ...(input.captions === undefined ? {} : { captions: input.captions }),
    maximumBytes: input.maximumBytes,
    outputDirectory: input.outputDirectory,
    outputLayout: explicitTier ? "tiered" : "flat",
    project: input.project,
    syncPolicy: input.syncPolicy,
    variants,
  });
  const profile = (profileId: ProjectExportVariant["profileId"]) => {
    const rendered = outputs[projectExportVariantId({
      captionMode: "clean",
      profileId,
      tier,
    })]!;
    const captioned = input.captions === undefined
      ? undefined
      : (() => {
          const variant = outputs[projectExportVariantId({
            captionMode: "burn-in",
            profileId,
            tier,
          })]!;
          return Object.freeze({
            output: variant.output,
            plan: variant.plan,
          });
        })();
    return Object.freeze({
      captioned,
      output: rendered.output,
      plan: rendered.plan,
      revision: rendered.revision,
    });
  };
  return Object.freeze({
    feedPortrait: profile("feed-portrait"),
    landscape: profile("landscape"),
    portrait: profile("portrait"),
    square: profile("square"),
  });
}
