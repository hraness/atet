import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  canonicalJsonSha256,
  loadProjectEditPlan,
  saveProjectEditPlan,
  sha256Hex,
} from "../../../core";
import {
  candidateRevisionDerivationSha256,
  createEditorialPromotionReceiptV1,
  createEmptyCandidateProjectEditBatchV3,
  createVariantSelectionV1,
  CreativeCandidateV1Schema,
  DeliveryMaterializationReceiptV1Schema,
  VariantSelectionV1Schema,
} from "../../creative-iteration";
import { commitProjectStateTransaction } from "../../../cli/project-state-transaction";
import {
  hashProjectGeneration,
  projectEditBasis,
} from "../../project-store";
import {
  createProjectRenderReceiptV2,
  ProjectEditRevisionDocumentSchema,
  ProjectRenderOutputReferenceSchema,
  ProjectRenderPlanReferenceSchema,
  ProjectRenderReceiptReferenceSchema,
} from "../../receipts";
import { OperationRegistry } from "../../registry";
import {
  bindCandidateRevisionOperationDefinition,
} from "../edit/bind-candidate-revision";
import {
  bindCreateCandidateRevisionInput,
  createCandidateRevisionOperationDefinition,
} from "../edit/create-candidate-revision";
import { deriveProjectEditBatchV3 } from "../derive/edit-batch";
import {
  applyOrderedProjectEdit,
} from "../project/commit-edits";
import {
  bindPromoteVariantSelectionInput,
  promoteVariantSelectionOperationDefinition,
  reconcileVariantSelectionPromotion,
} from "../project/promote-selection";
import { ProjectSnapshotOutputSchema } from "../project/snapshot";
import {
  bindMaterializeVariantSelectionInput,
  materializeVariantSelectionOperationDefinition,
} from "../render/materialize-selection";
import {
  CandidateRenderDerivationV1Schema,
  ATET_PROJECT_RENDERER_ABI,
  bindCandidateRenderOutputOperationDefinition,
  candidateRenderDerivationSha256,
  candidateRenderOutputPath,
} from "../render/bind-candidate-output";
import {
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  bindCreateCreativeCandidateInput,
  createCreativeCandidateOperationDefinition,
} from "./create-candidate";
import { createVariantMatrixOperationDefinition } from "./create-matrix";
import { selectVariantOperationDefinition } from "./select";

function registry(): OperationRegistry {
  const value = new OperationRegistry();
  value.register(createCandidateRevisionOperationDefinition);
  value.register(bindCandidateRevisionOperationDefinition);
  value.register(bindCandidateRenderOutputOperationDefinition);
  value.register(createCreativeCandidateOperationDefinition);
  value.register(createVariantMatrixOperationDefinition);
  value.register(selectVariantOperationDefinition);
  value.register(promoteVariantSelectionOperationDefinition);
  value.register(materializeVariantSelectionOperationDefinition);
  return value;
}

function renderToolchain(seed = "2") {
  const tool = (name: "ffmpeg" | "ffprobe") => ({
    bytes: 1,
    command: name,
    executablePath: `/usr/bin/${name}`,
    executableSha256: seed.repeat(64),
    name,
    version: `fixture-${seed}`,
  });
  return {
    ffmpeg: tool("ffmpeg"),
    ffprobe: tool("ffprobe"),
    rsvgConvert: null,
  };
}

function candidateRenderPlanReference(
  revision: ReturnType<
    typeof bindCandidateRevisionOperationDefinition.outputSchema.parse
  >["revision"],
  discriminator: string,
) {
  const artifactSha256 = canonicalJsonSha256({
    discriminator,
    outputGeometrySha256: revision.outputGeometrySha256,
  });
  return ProjectRenderPlanReferenceSchema.parse({
    artifact: {
      bytes: 1,
      path: `renders/plans/${artifactSha256}.json`,
      sha256: artifactSha256,
    },
    kind: "atet.project-render-plan-reference",
    outputGeometrySha256: revision.outputGeometrySha256,
    planSha256: canonicalJsonSha256({ discriminator, kind: "edit-plan" }),
    projectEditPlanSha256: revision.projectEditPlanSha256,
    projectId: revision.projectId,
    projectSha256: revision.projectSha256,
    renderPlanSha256: canonicalJsonSha256({
      discriminator,
      kind: "render-plan",
    }),
    revisionSha256: revision.revisionSha256,
    schemaVersion: 1,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

async function fixture() {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "atet-creative-iteration-"),
  );
  const project = await createOperationProjectFixture(repositoryRoot);
  const application = operationApplicationContext(repositoryRoot);
  const context = {
    abortSignal: new AbortController().signal,
    application,
  };
  const snapshot = ProjectSnapshotOutputSchema.parse({
    currentPlan: project.plan,
    editBasis: projectEditBasis(project.project, project.plan),
    generation: hashProjectGeneration(project.project, project.plan),
    project: project.project,
  });
  return {
    application,
    context,
    project,
    repositoryRoot,
    snapshot,
  };
}

type IterationFixture = Awaited<ReturnType<typeof fixture>>;

async function publishRevision(
  input: IterationFixture,
  options: {
    readonly batch?: ReturnType<typeof deriveProjectEditBatchV3>;
    readonly variantKey: string;
  },
) {
  const batch = options.batch ?? createEmptyCandidateProjectEditBatchV3();
  const exact = await bindCreateCandidateRevisionInput(input.application, {
    batch,
    project: input.project.project.projectId,
    snapshot: input.snapshot,
    variantKey: options.variantKey,
  });
  const output = (await registry().execute(input.context, {
    input: exact,
    kind: "edit.create-candidate-revision",
    version: 1,
  })).output;
  return {
    batch,
    exact,
    revision: createCandidateRevisionOperationDefinition.outputSchema.parse(output),
  };
}

async function publishCandidate(
  input: IterationFixture,
  options: {
    readonly batch?: ReturnType<typeof deriveProjectEditBatchV3>;
    readonly renders?: readonly {
      readonly name: string;
      readonly output: ReturnType<typeof ProjectRenderOutputReferenceSchema.parse>;
      readonly receipt: ReturnType<typeof ProjectRenderReceiptReferenceSchema.parse>;
    }[];
    readonly variantKey: string;
  },
) {
  const revision = await publishRevision(input, options);
  const exact = await bindCreateCreativeCandidateInput(input.application, {
    batch: revision.batch,
    project: input.project.project.projectId,
    renders: options.renders ?? [],
    revision: revision.revision,
    snapshot: input.snapshot,
    variantKey: options.variantKey,
  });
  const output = (await registry().execute(input.context, {
    input: exact,
    kind: "iteration.create-candidate",
    version: 1,
  })).output;
  return {
    ...revision,
    candidate: createCreativeCandidateOperationDefinition.outputSchema.parse(output),
  };
}

async function matrixFor(
  input: IterationFixture,
  candidates: readonly Awaited<ReturnType<typeof publishCandidate>>["candidate"][],
) {
  return createVariantMatrixOperationDefinition.outputSchema.parse((
    await registry().execute(input.context, {
      input: {
        candidates,
        project: input.project.project.projectId,
      },
      kind: "iteration.create-matrix",
      version: 1,
    })
  ).output);
}

async function select(
  input: IterationFixture,
  matrix: Awaited<ReturnType<typeof matrixFor>>,
  variantKey: string,
) {
  return selectVariantOperationDefinition.outputSchema.parse((
    await registry().execute(input.context, {
      input: {
        matrix,
        project: input.project.project.projectId,
        variantKey,
      },
      kind: "iteration.select",
      version: 1,
    })
  ).output);
}

describe("creative iteration", () => {
  test("publishes a geometry-neutral baseline candidate without moving current", async () => {
    const input = await fixture();
    try {
      const baseline = await publishCandidate(input, {
        variantKey: "baseline",
      });
      expect(baseline.revision.projectEditPlanSha256)
        .toBe(input.snapshot.generation.currentPlanSha256);
      expect(await loadProjectEditPlan(input.project.fileSystem))
        .toEqual(input.project.plan);

      const bound = bindCandidateRevisionOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: {
            pixelHeight: 1_080,
            pixelWidth: 1_920,
            revision: baseline.revision,
          },
          kind: "edit.bind-candidate-revision",
          version: 1,
        })
      ).output);
      expect(bound.revision.revisionSha256)
        .toBe(baseline.revision.revisionSha256);
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("omitted candidate time is a logical frozen-base fact, not planner time", async () => {
    const input = await fixture();
    try {
      const request = {
        batch: createEmptyCandidateProjectEditBatchV3(),
        project: input.project.project.projectId,
        snapshot: input.snapshot,
        variantKey: "stable-time",
      };
      const earlyPlanner = operationApplicationContext(input.repositoryRoot, {
        now: new Date("2030-01-01T00:00:00.000Z"),
      });
      const latePlanner = operationApplicationContext(input.repositoryRoot, {
        now: new Date("2040-01-01T00:00:00.000Z"),
      });
      const early = await bindCreateCandidateRevisionInput(
        earlyPlanner,
        request,
      );
      const late = await bindCreateCandidateRevisionInput(
        latePlanner,
        request,
      );
      expect(late).toEqual(early);
      expect(early.updatedAt).toBe(
        Date.parse(input.snapshot.currentPlan.updatedAt)
          >= Date.parse(input.snapshot.project.updatedAt)
          ? input.snapshot.currentPlan.updatedAt
          : input.snapshot.project.updatedAt,
      );
      expect(bindCreateCandidateRevisionInput(input.application, {
        ...request,
        updatedAt: "2000-01-01T00:00:00.000Z",
      })).rejects.toThrow(/frozen project or edit plan/u);
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("candidate render paths bind every exact output-affecting derivation input", async () => {
    const input = await fixture();
    try {
      const persisted = await publishRevision(input, {
        variantKey: "path-law",
      });
      const bindRevision = async (pixelWidth: number, pixelHeight: number) => (
        bindCandidateRevisionOperationDefinition.outputSchema.parse((
          await registry().execute(input.context, {
            input: {
              pixelHeight,
              pixelWidth,
              revision: persisted.revision,
            },
            kind: "edit.bind-candidate-revision",
            version: 1,
          })
        ).output).revision
      );
      const landscape = await bindRevision(960, 540);
      const square = await bindRevision(540, 540);
      const landscapePlan = candidateRenderPlanReference(
        landscape,
        "landscape-24fps",
      );
      const alternateLandscapePlan = candidateRenderPlanReference(
        landscape,
        "landscape-24fps-alternate-plan",
      );
      const squarePlan = candidateRenderPlanReference(
        square,
        "square-24fps",
      );
      const thirtyFpsPlan = candidateRenderPlanReference(
        landscape,
        "landscape-30fps",
      );
      const bindOutput = async (overrides: Readonly<Record<string, unknown>> = {}) => (
        bindCandidateRenderOutputOperationDefinition.outputSchema.parse((
          await registry().execute(input.context, {
            input: {
              binding: renderToolchain(),
              candidateRevision: persisted.revision,
              maximumBytes: 2 * 1024 * 1024 * 1024,
              plan: landscapePlan,
              rendererAbi: ATET_PROJECT_RENDERER_ABI,
              revision: landscape,
              syncPolicy: "require-verified",
              target: {
                canvas: { kind: "profile", profileId: "landscape" },
                tier: "preview",
              },
              ...overrides,
            },
            kind: "render.bind-candidate-output",
            version: 1,
          })
        ).output)
      );

      const exact = await bindOutput();
      const exactRerun = await bindOutput();
      expect(exactRerun.output.path).toBe(exact.output.path);
      expect(exactRerun.derivation.derivationSha256)
        .toBe(exact.derivation.derivationSha256);

      const alternateRendererBody = {
        binding: exact.derivation.binding,
        candidateRevision: exact.derivation.candidateRevision,
        encoderRecipe: exact.derivation.encoderRecipe,
        kind: exact.derivation.kind,
        maximumBytes: exact.derivation.maximumBytes,
        plan: exact.derivation.plan,
        rendererAbi: "atet-project-renderer-abi-v2",
        revision: exact.derivation.revision,
        schemaVersion: exact.derivation.schemaVersion,
        syncPolicy: exact.derivation.syncPolicy,
        target: exact.derivation.target,
      } as const;
      const alternateRenderer = CandidateRenderDerivationV1Schema.parse({
        ...alternateRendererBody,
        derivationSha256: candidateRenderDerivationSha256(
          alternateRendererBody,
        ),
      });
      expect(alternateRenderer.derivationSha256)
        .not.toBe(exact.derivation.derivationSha256);
      expect(candidateRenderOutputPath(alternateRenderer))
        .not.toBe(exact.output.path);

      const changed = await Promise.all([
        bindOutput({
          plan: squarePlan,
          revision: square,
          target: {
            canvas: { kind: "profile", profileId: "square" },
            tier: "preview",
          },
        }),
        bindOutput({
          plan: thirtyFpsPlan,
          target: {
            canvas: {
              frameRate: 30,
              kind: "custom",
              pixelHeight: 540,
              pixelWidth: 960,
            },
            tier: "preview",
          },
        }),
        bindOutput({
          target: {
            canvas: {
              frameRate: 24,
              kind: "custom",
              pixelHeight: 540,
              pixelWidth: 960,
            },
            tier: "final",
          },
        }),
        bindOutput({ syncPolicy: "allow-unverified" }),
        bindOutput({ maximumBytes: 1_024 * 1_024 * 1_024 }),
        bindOutput({ binding: renderToolchain("8") }),
        bindOutput({ plan: alternateLandscapePlan }),
        bindOutput({
          target: {
            canvas: {
              frameRate: 24,
              kind: "custom",
              pixelHeight: 540,
              pixelWidth: 960,
            },
            tier: "preview",
          },
        }),
      ]);
      const paths = [exact, ...changed].map(value => value.output.path);
      expect(new Set(paths).size).toBe(paths.length);
      expect(changed[2].derivation.encoderRecipe).toMatchObject({
        schemaVersion: 1,
        tier: "final",
      });
      expect(CandidateRenderDerivationV1Schema.safeParse({
        ...exact.derivation,
        maximumBytes: exact.derivation.maximumBytes - 1,
      }).success).toBe(false);
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("same base and key keep revision identity distinct while matrices reject the duplicate candidate identity", async () => {
    const input = await fixture();
    try {
      const baseline = await publishCandidate(input, { variantKey: "same" });
      const edited = await publishCandidate(input, {
        batch: deriveProjectEditBatchV3([{
          kind: "cut",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
        }]),
        variantKey: "same",
      });
      expect(baseline.revision.candidate.candidateId)
        .toBe(edited.revision.candidate.candidateId);
      expect(baseline.revision.revisionSha256)
        .not.toBe(edited.revision.revisionSha256);
      const forgedRevision = {
        ...edited.revision,
        batchSha256: baseline.batch.sha256,
        bindingsSha256: canonicalJsonSha256(baseline.exact.bindings),
        candidate: baseline.exact.candidate,
        derivationSha256: candidateRevisionDerivationSha256({
          baseSha256: baseline.exact.base.baseSha256,
          batch: baseline.batch,
          bindings: baseline.exact.bindings,
          candidate: baseline.exact.candidate,
          projectEditPlanSha256: edited.revision.projectEditPlanSha256,
          revisionSha256: edited.revision.revisionSha256,
          updatedAt: baseline.exact.updatedAt,
        }),
        updatedAt: baseline.exact.updatedAt,
      };
      expect(registry().execute(input.context, {
        input: {
          base: baseline.exact.base,
          batch: baseline.batch,
          bindings: baseline.exact.bindings,
          candidate: baseline.exact.candidate,
          project: input.project.project.projectId,
          renders: [],
          revision: forgedRevision,
          updatedAt: baseline.exact.updatedAt,
        },
        kind: "iteration.create-candidate",
        version: 1,
      })).rejects.toThrow(/declared V3 batch/u);
      expect(registry().execute(input.context, {
        input: {
          candidates: [baseline.candidate, edited.candidate],
          project: input.project.project.projectId,
        },
        kind: "iteration.create-matrix",
        version: 1,
      })).rejects.toThrow();
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("selection binds chosen render-result hashes and rejects a tampered closed-set member", async () => {
    const input = await fixture();
    try {
      const baseline = await publishCandidate(input, { variantKey: "baseline" });
      const matrix = await matrixFor(input, [baseline.candidate]);
      const candidateText = await input.project.fileSystem.readText(
        baseline.candidate.artifact.path,
      );
      const candidate = CreativeCandidateV1Schema.parse(JSON.parse(candidateText));
      const selection = createVariantSelectionV1({
        candidate,
        chosen: baseline.candidate,
        matrix,
      });
      const badBody = {
        base: selection.base,
        chosen: {
          ...selection.chosen,
          renderSetSha256: "f".repeat(64),
        },
        kind: selection.kind,
        matrix: selection.matrix,
        result: selection.result,
        schemaVersion: selection.schemaVersion,
      };
      expect(() => VariantSelectionV1Schema.parse({
        ...badBody,
        selectionSha256: canonicalJsonSha256({
          domain: "studio.variant-selection/v1",
          ...badBody,
        }),
      })).toThrow(/result|base|chosen/u);

      expect(registry().execute(input.context, {
        input: {
          candidates: [{
            ...baseline.candidate,
            renderSetSha256: "f".repeat(64),
          }],
          project: input.project.project.projectId,
        },
        kind: "iteration.create-matrix",
        version: 1,
      })).rejects.toThrow(/does not match its reference/u);

      await input.project.fileSystem.writeTextAtomic(
        baseline.candidate.artifact.path,
        "{}\n",
      );
      expect(registry().execute(input.context, {
        input: {
          matrix,
          project: input.project.project.projectId,
          variantKey: "baseline",
        },
        kind: "iteration.select",
        version: 1,
      })).rejects.toThrow();
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("one base-scoped editorial winner excludes a second stale promotion even when baseline wins", async () => {
    const input = await fixture();
    try {
      const baseline = await publishCandidate(input, { variantKey: "baseline" });
      const edited = await publishCandidate(input, {
        batch: deriveProjectEditBatchV3([{
          kind: "cut",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
        }]),
        variantKey: "edited",
      });
      const matrix = await matrixFor(input, [baseline.candidate, edited.candidate]);
      const [baselineSelection, editedSelection] = await Promise.all([
        select(input, matrix, "baseline"),
        select(input, matrix, "edited"),
      ]);
      const promoteBaseline = bindPromoteVariantSelectionInput(
        input.application,
        { selection: baselineSelection },
      );
      await registry().execute(input.context, {
        input: promoteBaseline,
        kind: "project.promote-selection",
        version: 1,
      });
      const promoteEdited = bindPromoteVariantSelectionInput(
        input.application,
        { selection: editedSelection },
      );
      expect(registry().execute(input.context, {
        input: promoteEdited,
        kind: "project.promote-selection",
        version: 1,
      })).rejects.toMatchObject({ code: "conflict" });
      expect(await loadProjectEditPlan(input.project.fileSystem))
        .toEqual(input.project.plan);
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("does not adopt an identical current plan without the exact promotion transaction", async () => {
    const input = await fixture();
    try {
      const edited = await publishCandidate(input, {
        batch: deriveProjectEditBatchV3([{
          kind: "cut",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
        }]),
        variantKey: "edited",
      });
      const matrix = await matrixFor(input, [edited.candidate]);
      const selection = await select(input, matrix, "edited");
      const revision = ProjectEditRevisionDocumentSchema.parse(JSON.parse(
        await input.project.fileSystem.readText(edited.revision.artifact.path),
      ));
      await saveProjectEditPlan(
        input.project.fileSystem,
        revision.projectEditPlan,
      );
      expect(registry().execute(input.context, {
        input: bindPromoteVariantSelectionInput(input.application, { selection }),
        kind: "project.promote-selection",
        version: 1,
      })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("reconciles an exact completed promotion after a later editorial edit", async () => {
    const input = await fixture();
    try {
      const edited = await publishCandidate(input, {
        batch: deriveProjectEditBatchV3([{
          kind: "cut",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
        }]),
        variantKey: "edited",
      });
      const matrix = await matrixFor(input, [edited.candidate]);
      const selection = await select(input, matrix, "edited");
      const promotionInput = bindPromoteVariantSelectionInput(
        input.application,
        { selection },
      );
      const promoted = promoteVariantSelectionOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: promotionInput,
          kind: "project.promote-selection",
          version: 1,
        })
      ).output);
      const selectedPlan = await loadProjectEditPlan(input.project.fileSystem);
      const laterPlan = applyOrderedProjectEdit(
        input.project.project,
        selectedPlan,
        {
          kind: "cut",
          range: { endUs: 4_000_000, startUs: 3_000_000 },
        },
        "2026-08-02T12:00:00.000Z",
      );
      await saveProjectEditPlan(input.project.fileSystem, laterPlan);

      expect(promoteVariantSelectionOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: promotionInput,
          kind: "project.promote-selection",
          version: 1,
        })
      ).output)).toEqual(promoted);
      expect(await reconcileVariantSelectionPromotion(
        input.application,
        promotionInput,
      )).toEqual({ kind: "completed", output: promoted });
      expect(await loadProjectEditPlan(input.project.fileSystem)).toEqual(laterPlan);
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("recovers a committed promotion after its mutable transaction marker is superseded", async () => {
    const input = await fixture();
    try {
      const edited = await publishCandidate(input, {
        batch: deriveProjectEditBatchV3([{
          kind: "cut",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
        }]),
        variantKey: "edited",
      });
      const matrix = await matrixFor(input, [edited.candidate]);
      const selection = await select(input, matrix, "edited");
      const selectionDocument = VariantSelectionV1Schema.parse(JSON.parse(
        await input.project.fileSystem.readText(selection.artifact.path),
      ));
      const candidateDocument = CreativeCandidateV1Schema.parse(JSON.parse(
        await input.project.fileSystem.readText(edited.candidate.artifact.path),
      ));
      const revisionDocument = ProjectEditRevisionDocumentSchema.parse(JSON.parse(
        await input.project.fileSystem.readText(edited.revision.artifact.path),
      ));
      const promotion = createEditorialPromotionReceiptV1({
        base: selectionDocument.base,
        candidate: selectionDocument.chosen,
        frozenProject: candidateDocument.base.project,
        promotedPlan: revisionDocument.projectEditPlan,
        selection,
      });

      await commitProjectStateTransaction({
        after: {
          plan: revisionDocument.projectEditPlan,
          project: input.project.project,
        },
        before: {
          plan: input.project.plan,
          project: input.project.project,
        },
        fileSystem: input.project.fileSystem,
        transactionId: promotion.transactionId,
      });
      const laterPlan = applyOrderedProjectEdit(
        input.project.project,
        revisionDocument.projectEditPlan,
        {
          kind: "cut",
          range: { endUs: 4_000_000, startUs: 3_000_000 },
        },
        "2026-08-02T12:00:00.000Z",
      );
      await commitProjectStateTransaction({
        after: { plan: laterPlan, project: input.project.project },
        before: {
          plan: revisionDocument.projectEditPlan,
          project: input.project.project,
        },
        fileSystem: input.project.fileSystem,
        transactionId: "transaction_99999999999999999999999999999999",
      });
      const promotionInput = bindPromoteVariantSelectionInput(
        input.application,
        { selection },
      );

      expect(await reconcileVariantSelectionPromotion(
        input.application,
        promotionInput,
      )).toEqual({ kind: "retry" });
      const recovered = promoteVariantSelectionOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: promotionInput,
          kind: "project.promote-selection",
          version: 1,
        })
      ).output);
      expect(recovered.promotionSha256).toBe(promotion.promotionSha256);
      expect(await loadProjectEditPlan(input.project.fileSystem)).toEqual(laterPlan);
      expect(await reconcileVariantSelectionPromotion(
        input.application,
        promotionInput,
      )).toEqual({ kind: "completed", output: recovered });
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("materializes exact selected bytes concurrently without changing editorial state", async () => {
    const input = await fixture();
    try {
      const revision = await publishRevision(input, { variantKey: "delivery" });
      const bound = bindCandidateRevisionOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: {
            pixelHeight: 1_080,
            pixelWidth: 1_920,
            revision: revision.revision,
          },
          kind: "edit.bind-candidate-revision",
          version: 1,
        })
      ).output);
      const sourceContents = "verified render bytes";
      const sourcePath = `renders/iteration-fixtures/${revision.revision.revisionSha256}.mp4`;
      await input.project.fileSystem.writeTextNoReplace!(
        sourcePath,
        sourceContents,
      );
      const output = ProjectRenderOutputReferenceSchema.parse({
        bytes: new TextEncoder().encode(sourceContents).byteLength,
        kind: "atet.project-render-output-reference",
        path: sourcePath,
        planArtifactSha256: "1".repeat(64),
        projectId: input.project.project.projectId,
        revisionSha256: revision.revision.revisionSha256,
        schemaVersion: 1,
        sha256: sha256Hex(sourceContents),
      });
      const tool = (name: "ffmpeg" | "ffprobe") => ({
        bytes: 1,
        command: name,
        executablePath: `/usr/bin/${name}`,
        executableSha256: "2".repeat(64),
        name,
        version: "1.0",
      });
      const nodePlanSha256 = "3".repeat(64);
      const plan = {
        artifact: {
          bytes: 1,
          path: `renders/plans/${output.planArtifactSha256}.json`,
          sha256: output.planArtifactSha256,
        },
        kind: "atet.project-render-plan-reference" as const,
        outputGeometrySha256: bound.revision.outputGeometrySha256,
        planSha256: "4".repeat(64),
        projectEditPlanSha256: revision.revision.projectEditPlanSha256,
        projectId: input.project.project.projectId,
        projectSha256: revision.revision.projectSha256,
        renderPlanSha256: "5".repeat(64),
        revisionSha256: revision.revision.revisionSha256,
        schemaVersion: 1 as const,
      };
      const receiptDocument = createProjectRenderReceiptV2({
        createdAt: "2026-07-23T15:02:00.000Z",
        inputSha256: "6".repeat(64),
        invocation: {
          arguments: [],
          executable: "ffmpeg",
          filterGraph: {
            bytes: 1,
            path: "renders/filter.graph",
            sha256: "7".repeat(64),
          },
          outputPath: output.path,
          renderPlanSha256: plan.renderPlanSha256,
        },
        output,
        plan,
        run: {
          nodeKey: "render",
          nodePlanSha256,
          runId: "run_render01",
        },
        syncPolicy: "require-verified",
        toolchain: {
          ffmpeg: tool("ffmpeg"),
          ffprobe: tool("ffprobe"),
          rsvgConvert: null,
        },
      });
      const receiptContents = `${canonicalJson(receiptDocument)}\n`;
      const receiptPath = `renders/receipts/${nodePlanSha256}.json`;
      await input.project.fileSystem.writeTextNoReplace!(
        receiptPath,
        receiptContents,
      );
      const receipt = ProjectRenderReceiptReferenceSchema.parse({
        bytes: new TextEncoder().encode(receiptContents).byteLength,
        kind: "atet.project-render-receipt-reference",
        nodePlanSha256,
        outputSha256: output.sha256,
        path: receiptPath,
        projectId: output.projectId,
        receiptSha256: receiptDocument.receiptSha256,
        revisionSha256: output.revisionSha256,
        schemaVersion: 2,
        sha256: sha256Hex(receiptContents),
      });
      const candidateExact = await bindCreateCreativeCandidateInput(
        input.application,
        {
          batch: revision.batch,
          project: input.project.project.projectId,
          renders: [{ name: "preview", output, receipt }],
          revision: revision.revision,
          snapshot: input.snapshot,
          variantKey: "delivery",
        },
      );
      const candidate = createCreativeCandidateOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: candidateExact,
          kind: "iteration.create-candidate",
          version: 1,
        })
      ).output);
      const matrix = await matrixFor(input, [candidate]);
      const selection = await select(input, matrix, "delivery");
      const materialize = bindMaterializeVariantSelectionInput(
        input.application,
        {
          project: input.project.project.projectId,
          renderName: "preview",
          selection,
        },
      );
      const portraitMaterialize = bindMaterializeVariantSelectionInput(
        input.application,
        {
          deliveryKey: "portrait",
          project: input.project.project.projectId,
          renderName: "preview",
          selection,
        },
      );
      const landscapeMaterialize = bindMaterializeVariantSelectionInput(
        input.application,
        {
          deliveryKey: "landscape",
          project: input.project.project.projectId,
          renderName: "preview",
          selection,
        },
      );
      expect(portraitMaterialize.destinationPath).toContain("/portrait/");
      expect(landscapeMaterialize.destinationPath).toContain("/landscape/");
      expect(portraitMaterialize.destinationPath)
        .not.toBe(landscapeMaterialize.destinationPath);
      const firstEnteredPublication = deferred();
      const releaseFirstPublication = deferred();
      const firstPublication = registry().execute({
        ...input.context,
        workflow: {
          beforePublication: async () => {
            firstEnteredPublication.resolve();
            await releaseFirstPublication.promise;
          },
          nodeKey: "materialize-first",
          nodePlanSha256: "8".repeat(64),
          runId: "run_materialize_first01",
          workspaceDirectory: join(input.repositoryRoot, "materialize-first"),
        },
      }, {
        input: materialize,
        kind: "render.materialize-selection",
        version: 1,
      }).then(result => (
        materializeVariantSelectionOperationDefinition.outputSchema.parse(
          result.output,
        )
      ));
      await firstEnteredPublication.promise;

      let sameDestinationPublicationChecks = 0;
      const sameDestinationApplication = operationApplicationContext(
        input.repositoryRoot,
      );
      const sameDestinationPublication = registry().execute({
        abortSignal: new AbortController().signal,
        application: sameDestinationApplication,
        workflow: {
          beforePublication: () => {
            sameDestinationPublicationChecks += 1;
            return Promise.resolve();
          },
          nodeKey: "materialize-same",
          nodePlanSha256: "9".repeat(64),
          runId: "run_materialize_same01",
          workspaceDirectory: join(input.repositoryRoot, "materialize-same"),
        },
      }, {
        input: materialize,
        kind: "render.materialize-selection",
        version: 1,
      }).then(result => (
        materializeVariantSelectionOperationDefinition.outputSchema.parse(
          result.output,
        )
      ));

      const parallelMaterialize = bindMaterializeVariantSelectionInput(
        input.application,
        {
          destinationPath: "renders/deliveries/parallel/final.mp4",
          project: input.project.project.projectId,
          renderName: "preview",
          selection,
        },
      );
      let parallelPublicationChecks = 0;
      try {
        const parallel = materializeVariantSelectionOperationDefinition.outputSchema.parse((
          await registry().execute({
            abortSignal: new AbortController().signal,
            application: operationApplicationContext(input.repositoryRoot),
            workflow: {
              beforePublication: () => {
                parallelPublicationChecks += 1;
                return Promise.resolve();
              },
              nodeKey: "materialize-parallel",
              nodePlanSha256: "a".repeat(64),
              runId: "run_materialize_parallel01",
              workspaceDirectory: join(
                input.repositoryRoot,
                "materialize-parallel",
              ),
            },
          }, {
            input: parallelMaterialize,
            kind: "render.materialize-selection",
            version: 1,
          })
        ).output);
        expect(parallelPublicationChecks).toBe(1);
        expect(sameDestinationPublicationChecks).toBe(0);
        expect(parallel.output.path).toBe(parallelMaterialize.destinationPath);
        expect(await readFile(
          join(input.project.projectDirectory, parallel.output.path),
          "utf8",
        )).toBe(sourceContents);
      } finally {
        releaseFirstPublication.resolve();
      }

      const [first, second] = await Promise.all([
        firstPublication,
        sameDestinationPublication,
      ]);
      expect(second).toEqual(first);
      expect(sameDestinationPublicationChecks).toBe(0);
      expect(await readFile(
        join(input.project.projectDirectory, first.output.path),
        "utf8",
      )).toBe(sourceContents);
      expect(await loadProjectEditPlan(input.project.fileSystem))
        .toEqual(input.project.plan);

      const idempotent = materializeVariantSelectionOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: materialize,
          kind: "render.materialize-selection",
          version: 1,
        })
      ).output);
      expect(idempotent).toEqual(first);

      const persistedReceipt = DeliveryMaterializationReceiptV1Schema.parse(
        JSON.parse(await readFile(
          join(
            input.project.projectDirectory,
            first.receipt.artifact.path,
          ),
          "utf8",
        )) as unknown,
      );
      const foreignRevisionSha256 = "f".repeat(64);
      const forgedBody = {
        candidate: persistedReceipt.candidate,
        destination: {
          ...persistedReceipt.destination,
          revisionSha256: foreignRevisionSha256,
        },
        kind: persistedReceipt.kind,
        renderName: persistedReceipt.renderName,
        schemaVersion: persistedReceipt.schemaVersion,
        selection: persistedReceipt.selection,
        source: {
          ...persistedReceipt.source,
          revisionSha256: foreignRevisionSha256,
        },
      };
      expect(() => DeliveryMaterializationReceiptV1Schema.parse({
        ...forgedBody,
        materializationSha256: canonicalJsonSha256({
          domain: "studio.delivery-materialization-receipt/v1",
          ...forgedBody,
        }),
      })).toThrow(/selected render provenance/u);

      // Model interruption after atomic output publication but before the
      // deterministic materialization receipt was written.
      const recoveryMaterialize = bindMaterializeVariantSelectionInput(
        input.application,
        {
          destinationPath: "renders/deliveries/recovery/final.mp4",
          project: input.project.project.projectId,
          renderName: "preview",
          selection,
        },
      );
      expect(await input.project.fileSystem.copyFileNoReplace!(
        output.path,
        recoveryMaterialize.destinationPath,
        output,
      )).toBe("created");
      const recovered = materializeVariantSelectionOperationDefinition.outputSchema.parse((
        await registry().execute(input.context, {
          input: recoveryMaterialize,
          kind: "render.materialize-selection",
          version: 1,
        })
      ).output);
      expect(recovered.output.path).toBe(recoveryMaterialize.destinationPath);
      expect(await readFile(
        join(input.project.projectDirectory, recovered.output.path),
        "utf8",
      )).toBe(sourceContents);

      const poisonedPath = "renders/deliveries/poisoned/final.mp4";
      await input.project.fileSystem.writeTextNoReplace!(poisonedPath, "different");
      expect(registry().execute(input.context, {
        input: bindMaterializeVariantSelectionInput(input.application, {
          destinationPath: poisonedPath,
          project: input.project.project.projectId,
          renderName: "preview",
          selection,
        }),
        kind: "render.materialize-selection",
        version: 1,
      })).rejects.toThrow(/different bytes/u);
    } finally {
      await rm(input.repositoryRoot, { force: true, recursive: true });
    }
  });
});
