import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { createApplicationOperationRegistry } from "../application/default-registry";
import {
  createEmptyCandidateProjectEditBatchV3,
  createCreativeBaseV1,
  creativeBaseIdentityV1,
  variantMatrixPath,
  VariantMatrixReferenceV1Schema,
} from "../application/creative-iteration";
import { operationTestProject } from "../application/operations/test-support";
import { compileGraphPlan } from "../code/compiler";
import { buildWorkflow, defineWorkflow } from "../code/public";
import {
  TESTING_WORKFLOW_BUNDLE,
  TESTING_WORKFLOW_RUNTIME,
} from "../code/testing";
import {
  EditPlanIdSchema,
  ProjectCaptionRequestSchema,
  projectExportVariantId,
} from "../contracts";
import { createDefaultProjectEditPlan } from "../core";
import {
  renderCommonProjectVariants,
  renderProjectVariantMatrix,
  WorkflowProjectVariantMatrixSchema,
} from "./fragments";
import { BUILT_IN_WORKFLOWS, builtInWorkflow } from "./index";

describe("built-in workflow catalog", () => {
  test("is explicit, sorted, and versioned", () => {
    expect(BUILT_IN_WORKFLOWS.map(workflow => workflow.id)).toEqual([
      "chaptered-demo",
      "creative-iteration",
      "creative-selection",
      "polished-screen-demo",
      "social-variants",
      "talking-head-cleanup",
    ]);
    expect(builtInWorkflow("missing")).toBeUndefined();
    expect(BUILT_IN_WORKFLOWS.map(workflow => workflow.version)).toEqual([
      3,
      1,
      1,
      4,
      3,
      2,
    ]);
  });

  test("creative iteration fans immutable preview candidates out from one base and stops at a closed matrix", () => {
    const registry = createApplicationOperationRegistry({
      nextAnalysisId: () => "analysis_creativefixture",
      toolVersion: "test",
    });
    const workflow = builtInWorkflow("creative-iteration")!;
    const built = workflow.build(registry, {
      candidates: [
        { variantKey: "baseline" },
        {
          ordered: [{
            kind: "trim",
            range: { endUs: 4_000_000, startUs: 0 },
          }],
          variantKey: "tight-cut",
        },
      ],
      previewProfile: "portrait",
      project: "project_fixture",
    });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });

    expect(plan.topologicalWaves).toEqual([
      ["base"],
      ["candidates/baseline/revision", "candidates/tight-cut/revision"],
      [
        "candidates/baseline/preview/binding",
        "candidates/tight-cut/preview/binding",
      ],
      [
        "candidates/baseline/preview/plan",
        "candidates/tight-cut/preview/plan",
      ],
      [
        "candidates/baseline/preview/derivation",
        "candidates/tight-cut/preview/derivation",
      ],
      [
        "candidates/baseline/preview/output",
        "candidates/tight-cut/preview/output",
      ],
      ["candidates/baseline/candidate", "candidates/tight-cut/candidate"],
      ["matrix"],
    ]);
    expect(plan.envelope.operationKinds).toContain("iteration.create-candidate");
    expect(plan.envelope.operationKinds).toContain("iteration.create-matrix");
    expect(plan.envelope.operationKinds).toContain("render.bind-candidate-output");
    expect(plan.envelope.operationKinds).not.toContain("iteration.select");
    expect(plan.envelope.operationKinds).not.toContain("project.promote-selection");
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    expect(nodes.get("candidates/baseline/revision")?.input).toMatchObject({
      batch: createEmptyCandidateProjectEditBatchV3(),
    });
    for (const key of ["baseline", "tight-cut"]) {
      expect(nodes.get(`candidates/${key}/revision`)?.dependencies).toEqual([
        "base",
      ]);
      expect(nodes.get(`candidates/${key}/preview/derivation`)?.input)
        .toMatchObject({
          maximumBytes: 2 * 1024 * 1024 * 1024,
          target: {
            canvas: { kind: "profile", profileId: "portrait" },
            tier: "preview",
          },
        });
      expect(nodes.get(`candidates/${key}/preview/output`)?.input).toMatchObject({
        output: {
          $ref: {
            nodeKey: `candidates/${key}/preview/derivation`,
            path: ["output"],
          },
        },
        target: {
          $ref: {
            nodeKey: `candidates/${key}/preview/derivation`,
            path: ["target"],
          },
        },
      });
    }
    expect(nodes.get("matrix")?.dependencies).toEqual([
      "base",
      "candidates/baseline/candidate",
      "candidates/tight-cut/candidate",
    ]);
  });

  test("creative selection keeps choice, CAS promotion, and delivery as explicit nodes", () => {
    const registry = createApplicationOperationRegistry();
    const project = operationTestProject();
    const currentPlan = createDefaultProjectEditPlan(
      project,
      EditPlanIdSchema.parse("plan_selectionfixture"),
      project.updatedAt,
    );
    const base = creativeBaseIdentityV1(createCreativeBaseV1({
      currentPlan,
      project,
    }));
    const matrixSha256 = "b".repeat(64);
    const matrix = VariantMatrixReferenceV1Schema.parse({
      artifact: {
        bytes: 1,
        path: variantMatrixPath({
          baseSha256: base.baseSha256,
          matrixSha256,
        }),
        sha256: "c".repeat(64),
      },
      base,
      candidateCount: 2,
      candidateSetSha256: "d".repeat(64),
      kind: "atet.variant-matrix-reference",
      matrixSha256,
      schemaVersion: 1,
    });
    const built = builtInWorkflow("creative-selection")!.build(registry, {
      deliveries: [{
        deliveryKey: "review-copy",
        destinationPath: "renders/review/selected.mp4",
        renderName: "preview",
      }],
      matrix,
      promote: true,
      variantKey: "tight-cut",
    });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });

    expect(plan.topologicalWaves).toEqual([
      ["selection"],
      ["deliveries/review-copy/materialize", "promotion"],
    ]);
    expect(plan.envelope.operationKinds).toEqual([
      "iteration.select",
      "project.promote-selection",
      "render.materialize-selection",
    ]);
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    expect(nodes.get("selection")?.input).toMatchObject({
      matrix,
      project: project.projectId,
      variantKey: "tight-cut",
    });
    expect(nodes.get("promotion")?.dependencies).toEqual(["selection"]);
    expect(nodes.get("deliveries/review-copy/materialize")?.input)
      .toMatchObject({
        destinationPath: "renders/review/selected.mp4",
        renderName: "preview",
      });
  });

  test("polished demo commits one checked v2 batch and renders a provenance-bearing face revision", () => {
    const registry = createApplicationOperationRegistry({
      nextAnalysisId: () => "analysis_workflowfixture",
      toolVersion: "test",
    });
    const workflow = builtInWorkflow("polished-screen-demo")!;
    const built = workflow.build(registry, {
      cameraSource: "camera",
      faceFollow: {
        framing: "group",
        placementId: "placement_fixture01",
        projectRange: { endUs: 5_000_000, startUs: 0 },
        selection: { kind: "all" },
      },
      musicSource: "system-audio",
      project: "project_fixture",
    });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });

    expect(plan.topologicalWaves).toEqual([
      ["project"],
      ["analyze/auto-zooms", "analyze/faces", "analyze/inactivity", "analyze/music"],
      ["editorial-decisions"],
      ["commit-base-edits"],
      ["face-framing"],
      ["render/revision"],
      ["render/plan"],
      ["render/output"],
    ]);
    expect(plan.envelope.operationKinds).toContain("project.commit-edits");
    expect(plan.envelope.preparation).toContain("recording-metadata");
    expect(plan.envelope.resources).toContainEqual({
      amount: 2,
      resource: "project-publication",
    });
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    expect(nodes.get("editorial-decisions")?.executor).toEqual({
      kind: "operation",
      operation: { kind: "derive.edit-batch", version: 2 },
    });
    expect(nodes.get("editorial-decisions")?.dependencies).toEqual([
      "analyze/auto-zooms",
      "analyze/inactivity",
    ]);
    expect(nodes.get("editorial-decisions")?.input).toMatchObject({
      ordered: [
        {
          kind: "add-zooms",
          zooms: {
            $ref: {
              nodeKey: "analyze/auto-zooms",
              path: ["operations"],
            },
          },
        },
        {
          clicks: {
            enabled: true,
            style: "ring",
          },
          cursor: {
            enabled: true,
            smoothing: {
              algorithm: "exponential",
            },
          },
          keystrokes: {
            enabled: true,
            secureText: "hide",
          },
          kind: "set-metadata-effects",
          metadataPlacementId: {
            $ref: {
              nodeKey: "analyze/auto-zooms",
              path: ["sourcePlacementId"],
            },
          },
          typedText: { enabled: false },
        },
      ],
    });
    expect(nodes.get("commit-base-edits")?.executor).toEqual({
      kind: "operation",
      operation: { kind: "project.commit-edits", version: 2 },
    });
    expect(nodes.get("commit-base-edits")?.dependencies).toEqual([
      "analyze/faces",
      "analyze/music",
      "editorial-decisions",
      "project",
    ]);
    expect(nodes.get("face-framing")?.executor).toEqual({
      kind: "operation",
      operation: { kind: "derive.follow-faces", version: 1 },
    });
    expect(nodes.get("face-framing")?.dependencies).toEqual([
      "analyze/faces",
      "commit-base-edits",
    ]);
    expect(nodes.get("face-framing")?.input).toMatchObject({
      analysisId: {
        $ref: {
          nodeKey: "analyze/faces",
          path: ["analysisId"],
        },
      },
      aspect: "16:9",
      framing: "group",
      placementId: "placement_fixture01",
      project: {
        $ref: {
          nodeKey: "commit-base-edits",
          path: ["projectId"],
        },
      },
      projectRange: { endUs: 5_000_000, startUs: 0 },
      selection: { kind: "all" },
    });
    expect(nodes.get("render/revision")?.executor).toEqual({
      kind: "operation",
      operation: { kind: "edit.create-revision", version: 1 },
    });
    expect(nodes.get("render/revision")?.dependencies).toEqual([
      "commit-base-edits",
      "face-framing",
    ]);
    expect(plan.envelope.operationKinds).toContain("derive.follow-faces");
    expect(plan.envelope.operationKinds).toContain("edit.create-revision");
    expect(nodes.get("render/output")?.input).toMatchObject({
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
      output: {
        path: "renders/polished-screen-demo/final.mp4",
      },
    });
    expect(nodes.get("render/plan")?.input).toMatchObject({
      settings: { frameRate: 30 },
    });
  });

  test("polished demo rejects contradictory face-follow controls before graph construction", () => {
    const registry = createApplicationOperationRegistry();
    const workflow = builtInWorkflow("polished-screen-demo")!;
    expect(() => workflow.build(registry, {
      cameraSource: "camera",
      faceFollow: {
        maximumZoom: 2,
        minimumZoom: 3,
        placementId: "placement_fixture01",
        projectRange: { endUs: 5_000_000, startUs: 0 },
      },
      musicSource: "system-audio",
      project: "project_fixture",
    })).toThrow(/maximumZoom/u);
    expect(() => workflow.build(registry, {
      cameraSource: "camera",
      faceFollow: {
        placementId: "placement_fixture01",
        projectRange: { endUs: 5_000_000, startUs: 0 },
        requireAllSelectedFaces: true,
        selection: { kind: "largest" },
      },
      musicSource: "system-audio",
      project: "project_fixture",
    })).toThrow(/Largest-visible/u);
  });

  test("talking-head cleanup compiles analysis, cleanup, and render through the production registry", () => {
    const registry = createApplicationOperationRegistry({
      nextAnalysisId: () => "analysis_talkingheadfixture",
      toolVersion: "test",
    });
    const workflow = builtInWorkflow("talking-head-cleanup")!;
    const built = workflow.build(registry, {
      cameraSource: "camera",
      project: "project_fixture",
    });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });

    expect(plan.topologicalWaves).toEqual([
      ["project"],
      ["analyze/faces", "analyze/inactivity"],
      ["remove-long-pauses"],
      ["commit-cleanup"],
      ["render/revision"],
      ["render/plan"],
      ["render/output"],
    ]);
    expect(plan.envelope.operationKinds).toEqual([
      "analysis.faces",
      "analysis.project-inactivity",
      "derive.edit-batch",
      "edit.freeze-revision",
      "project.commit-edits",
      "project.snapshot",
      "render.project",
      "render.project-plan",
    ]);
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    expect(nodes.get("remove-long-pauses")?.dependencies).toEqual([
      "analyze/inactivity",
    ]);
    expect(nodes.get("commit-cleanup")?.dependencies).toEqual([
      "project",
      "remove-long-pauses",
    ]);
    expect(nodes.get("render/output")?.input).toMatchObject({
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
      output: {
        path: "renders/talking-head-cleanup/final.mp4",
      },
    });
    expect(nodes.get("render/revision")?.input).toMatchObject({
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    expect(nodes.get("render/plan")?.input).toMatchObject({
      settings: { frameRate: 30 },
    });
  });

  test("chaptered demo prepares overlays in parallel and commits one checked join", () => {
    const registry = createApplicationOperationRegistry();
    const workflow = builtInWorkflow("chaptered-demo")!;
    const built = workflow.build(registry, {
      overlays: [
        {
          key: "title",
          range: { endUs: 3_000_000, startUs: 0 },
          source: {
            artifact: { path: "fixtures/title.svg" },
            kind: "svg",
          },
        },
        {
          key: "badge",
          range: { endUs: 6_000_000, startUs: 1_000_000 },
          source: {
            artifact: { path: "fixtures/badge.svg" },
            kind: "svg",
          },
        },
      ],
      project: "project_fixture",
    });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });

    expect(plan.topologicalWaves).toEqual([
      ["project"],
      ["overlays/prepare/badge", "overlays/prepare/title"],
      ["overlays/batch"],
      ["overlays/commit"],
      ["render/revision"],
      ["render/plan"],
      ["render/output"],
    ]);
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    expect(nodes.get("overlays/batch")?.dependencies).toEqual([
      "overlays/prepare/badge",
      "overlays/prepare/title",
    ]);
    expect(nodes.get("overlays/commit")?.dependencies).toEqual([
      "overlays/batch",
      "project",
    ]);
    expect(nodes.get("render/revision")?.input).toMatchObject({
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    expect(nodes.get("render/plan")?.input).toMatchObject({
      settings: { frameRate: 30 },
    });
    expect(nodes.get("render/output")?.input).toMatchObject({
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
    });
    expect(plan.envelope.operationKinds).toContain("media.overlay");
    expect(plan.envelope.operationKinds).toContain("project.commit-edits");
  });

  test("social variants default to full-length preview targets", () => {
    const registry = createApplicationOperationRegistry();
    const workflow = builtInWorkflow("social-variants")!;
    const built = workflow.build(registry, { project: "project_fixture" });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });
    expect(plan.topologicalWaves).toEqual([
      ["project"],
      [
        "render/preview/feed-portrait/revision",
        "render/preview/landscape/revision",
        "render/preview/portrait/revision",
        "render/preview/square/revision",
      ],
      [
        "render/preview/feed-portrait/plan",
        "render/preview/landscape/plan",
        "render/preview/portrait/plan",
        "render/preview/square/plan",
      ],
      [
        "render/preview/feed-portrait/output",
        "render/preview/landscape/output",
        "render/preview/portrait/output",
        "render/preview/square/output",
      ],
    ]);
    const profiles = [
      {
        id: "feed-portrait",
        outputKey: "feedPortrait",
        pixelHeight: 540,
        pixelWidth: 432,
      },
      {
        id: "landscape",
        outputKey: "landscape",
        pixelHeight: 540,
        pixelWidth: 960,
      },
      {
        id: "portrait",
        outputKey: "portrait",
        pixelHeight: 960,
        pixelWidth: 540,
      },
      {
        id: "square",
        outputKey: "square",
        pixelHeight: 540,
        pixelWidth: 540,
      },
    ] as const;
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    for (const profile of profiles) {
      const revisionKey = `render/preview/${profile.id}/revision`;
      const planKey = `render/preview/${profile.id}/plan`;
      const outputKey = `render/preview/${profile.id}/output`;
      expect(nodes.get(revisionKey)?.input).toMatchObject({
        pixelHeight: profile.pixelHeight,
        pixelWidth: profile.pixelWidth,
      });
      expect(nodes.get(planKey)?.dependencies).toEqual([revisionKey]);
      expect(nodes.get(planKey)?.input).toMatchObject({
        settings: { frameRate: 24 },
      });
      expect(nodes.get(outputKey)?.input).toMatchObject({
        target: {
          canvas: { kind: "profile", profileId: profile.id },
          tier: "preview",
        },
        output: {
          path: `renders/social-variants/preview/${profile.id}.mp4`,
        },
      });
      expect(plan.graph.outputs).toMatchObject({
        [profile.outputKey]: {
          $ref: { nodeKey: outputKey },
        },
      });
    }
    expect(plan.graph.outputs).not.toHaveProperty("captioned");
    expect(plan.envelope.operationKinds).toContain("render.project");
    expect(plan.envelope.resources).toContainEqual({
      amount: 4,
      resource: "ffmpeg",
    });
    expect(plan.envelope.resources).toContainEqual({
      amount: 4,
      resource: "project-publication",
    });
  });

  test("social variants make full-quality rendering an explicit tier", () => {
    const registry = createApplicationOperationRegistry();
    const workflow = builtInWorkflow("social-variants")!;
    const built = workflow.build(registry, {
      project: "project_fixture",
      tier: "final",
    });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    expect(nodes.get("render/final/landscape/revision")?.input).toMatchObject({
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    expect(nodes.get("render/final/landscape/plan")?.input).toMatchObject({
      settings: { frameRate: 30 },
    });
    expect(nodes.get("render/final/landscape/output")?.input).toMatchObject({
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
      output: {
        path: "renders/social-variants/final/landscape.mp4",
      },
    });
  });

  test("common variants preserve the v1 helper shape and default to final", () => {
    const workflow = defineWorkflow({
      id: "common-variant-compatibility",
      inputSchema: z.strictObject({ project: z.string() }),
      inputSchemaId: "atet.workflow.common-variant-compatibility.input/v1",
      version: 1,
      build(builder, input) {
        const project = builder.project.snapshot("project", input.project);
        const outputs = renderCommonProjectVariants(builder, "matrix", {
          captions: ProjectCaptionRequestSchema.parse({
            analysisId: "analysis_caption0001",
            placementId: "placement_caption0001",
          }),
          maximumBytes: 1_024 * 1_024 * 1_024,
          outputDirectory: "renders/common",
          project,
          syncPolicy: "require-verified",
        });
        return {
          captionedPlan: outputs.landscape.captioned!.plan,
          output: outputs.landscape.output,
          plan: outputs.landscape.plan,
          revision: outputs.landscape.revision.revision,
        };
      },
    });
    const registry = createApplicationOperationRegistry();
    const built = buildWorkflow(workflow, registry, { project: "project_fixture" });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });
    expect(plan.graph.nodes.map(node => node.key)).toContain(
      "matrix/landscape/output",
    );
    expect(plan.graph.nodes.find(
      node => node.key === "matrix/landscape/output",
    )?.input).toMatchObject({
      output: { path: "renders/common/landscape.mp4" },
    });
    expect(plan.graph.outputs).toMatchObject({
      captionedPlan: {
        $ref: { nodeKey: "matrix/landscape/captioned/plan" },
      },
      output: { $ref: { nodeKey: "matrix/landscape/output" } },
      plan: { $ref: { nodeKey: "matrix/landscape/plan" } },
      revision: { $ref: { nodeKey: "matrix/landscape/revision" } },
    });
  });

  test("variant matrices reject duplicates and accept caption-only targets", () => {
    const clean = {
      captionMode: "clean" as const,
      profileId: "portrait" as const,
      tier: "preview" as const,
    };
    expect(() => WorkflowProjectVariantMatrixSchema.parse([
      clean,
      clean,
    ])).toThrow(/unique/u);
    expect(WorkflowProjectVariantMatrixSchema.parse([{
      ...clean,
      captionMode: "burn-in",
    }])).toEqual([{
      ...clean,
      captionMode: "burn-in",
    }]);
  });

  test("caption-only matrices do not schedule an unused clean render", () => {
    const variant = {
      captionMode: "burn-in" as const,
      profileId: "portrait" as const,
      tier: "preview" as const,
    };
    const workflow = defineWorkflow({
      id: "caption-only-matrix",
      inputSchema: z.strictObject({
        project: z.string(),
      }),
      inputSchemaId: "atet.workflow.caption-only-matrix.input/v1",
      version: 1,
      build(builder, input) {
        const project = builder.project.snapshot("project", input.project);
        const outputs = renderProjectVariantMatrix(builder, "matrix", {
          captions: ProjectCaptionRequestSchema.parse({
            analysisId: "analysis_caption0001",
            placementId: "placement_caption0001",
          }),
          maximumBytes: 1_024 * 1_024 * 1_024,
          outputDirectory: "renders/caption-only",
          project,
          syncPolicy: "require-verified",
          variants: [variant],
        });
        return {
          output: outputs[projectExportVariantId(variant)]!.output,
        };
      },
    });
    const registry = createApplicationOperationRegistry();
    const built = buildWorkflow(workflow, registry, { project: "project_fixture" });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });
    expect(plan.graph.nodes.map(node => node.key)).toEqual([
      "project",
      "matrix/preview/portrait/revision",
      "matrix/preview/portrait/captioned/plan",
      "matrix/preview/portrait/captioned/output",
    ].toSorted());
    expect(plan.graph.nodes.map(node => node.key)).not.toContain(
      "matrix/preview/portrait/output",
    );
  });

  test("social variants share four revisions across eight parallel clean and captioned outputs", () => {
    const registry = createApplicationOperationRegistry();
    const workflow = builtInWorkflow("social-variants")!;
    const built = workflow.build(registry, {
      captions: {
        analysisId: "analysis_caption0001",
        placementId: "placement_caption0001",
      },
      project: "project_fixture",
    });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph: built.graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: built.input,
    });

    expect(built.input).toMatchObject({
      captions: {
        analysisId: "analysis_caption0001",
        placementId: "placement_caption0001",
        style: "social-block-v1",
      },
    });
    expect(plan.topologicalWaves).toEqual([
      ["project"],
      [
        "render/preview/feed-portrait/revision",
        "render/preview/landscape/revision",
        "render/preview/portrait/revision",
        "render/preview/square/revision",
      ],
      [
        "render/preview/feed-portrait/captioned/plan",
        "render/preview/feed-portrait/plan",
        "render/preview/landscape/captioned/plan",
        "render/preview/landscape/plan",
        "render/preview/portrait/captioned/plan",
        "render/preview/portrait/plan",
        "render/preview/square/captioned/plan",
        "render/preview/square/plan",
      ],
      [
        "render/preview/feed-portrait/captioned/output",
        "render/preview/feed-portrait/output",
        "render/preview/landscape/captioned/output",
        "render/preview/landscape/output",
        "render/preview/portrait/captioned/output",
        "render/preview/portrait/output",
        "render/preview/square/captioned/output",
        "render/preview/square/output",
      ],
    ]);
    const profileIds = [
      "feed-portrait",
      "landscape",
      "portrait",
      "square",
    ] as const;
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    expect(plan.graph.nodes
      .filter(node => node.key.endsWith("/revision"))
      .map(node => node.key)).toEqual(profileIds.map(
        profileId => `render/preview/${profileId}/revision`,
      ));
    for (const profileId of profileIds) {
      const revisionKey = `render/preview/${profileId}/revision`;
      const cleanPlanKey = `render/preview/${profileId}/plan`;
      const captionedPlanKey = `render/preview/${profileId}/captioned/plan`;
      expect(nodes.get(cleanPlanKey)?.dependencies).toEqual([revisionKey]);
      expect(nodes.get(captionedPlanKey)?.dependencies).toEqual([revisionKey]);
      expect(nodes.get(cleanPlanKey)?.executor).toEqual({
        kind: "operation",
        operation: { kind: "render.project-plan", version: 1 },
      });
      expect(nodes.get(captionedPlanKey)?.executor).toEqual({
        kind: "operation",
        operation: { kind: "render.project-plan", version: 2 },
      });
      expect(nodes.get(captionedPlanKey)?.input).toMatchObject({
        settings: {
          captions: {
            analysisId: "analysis_caption0001",
            placementId: "placement_caption0001",
            style: "social-block-v1",
          },
          frameRate: 24,
        },
      });
      expect(nodes.get(`render/preview/${profileId}/output`)?.input).toMatchObject({
        target: {
          canvas: { kind: "profile", profileId },
          tier: "preview",
        },
        output: {
          path: `renders/social-variants/preview/${profileId}.mp4`,
        },
      });
      expect(nodes.get(`render/preview/${profileId}/captioned/output`)?.input)
        .toMatchObject({
          target: {
            canvas: { kind: "profile", profileId },
            tier: "preview",
          },
          output: {
            path: `renders/social-variants/preview/${profileId}-captioned.mp4`,
          },
        });
    }
    expect(plan.graph.outputs).toMatchObject({
      captioned: {
        feedPortrait: {
          $ref: { nodeKey: "render/preview/feed-portrait/captioned/output" },
        },
        landscape: {
          $ref: { nodeKey: "render/preview/landscape/captioned/output" },
        },
        portrait: {
          $ref: { nodeKey: "render/preview/portrait/captioned/output" },
        },
        square: {
          $ref: { nodeKey: "render/preview/square/captioned/output" },
        },
      },
    });
    const renderPaths = plan.graph.nodes
      .filter(node => (
        node.executor.kind === "operation"
        && node.executor.operation.kind === "render.project"
      ))
      .map(node => (
        node.input as { readonly output: { readonly path: string } }
      ).output.path);
    expect(renderPaths).toHaveLength(8);
    expect(new Set(renderPaths).size).toBe(8);
    expect(renderPaths.toSorted()).toEqual(profileIds.flatMap(profileId => [
      `renders/social-variants/preview/${profileId}-captioned.mp4`,
      `renders/social-variants/preview/${profileId}.mp4`,
    ]).toSorted());
    expect(plan.envelope.resources).toContainEqual({
      amount: 8,
      resource: "ffmpeg",
    });
    expect(plan.envelope.resources).toContainEqual({
      amount: 4,
      resource: "project-publication",
    });
  });
});
