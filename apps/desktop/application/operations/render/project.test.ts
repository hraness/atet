import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  SpeechAnalysisV1Schema,
  VideoProjectV1Schema,
} from "../../../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  createDefaultProjectEditPlan,
  hashProjectStructure,
  saveProjectEditPlan,
  saveVideoProject,
  sha256Hex,
} from "../../../core";
import type {
  ApplicationContext,
  ApplicationProcessRunner,
} from "../../context";
import {
  createCreativeBaseV1,
  createCreativeCandidateIdentityV1,
  creativeBaseIdentityV1,
  CreativeCandidateRevisionReferenceV1Schema,
} from "../../creative-iteration";
import { ApplicationError } from "../../errors";
import { OperationRegistry } from "../../registry";
import {
  ProjectRenderReceiptV2Schema,
  RenderableProjectEditRevisionReferenceSchema,
  createProjectEditRevisionDocument,
  hashProjectEditRevisionOutputGeometry,
  type ProjectRenderPlanReference,
} from "../../receipts";
import { hashProjectGeneration } from "../../project-store";
import {
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  ProjectRenderPlanOutputSchema,
  bindProjectRenderPlanInput,
  bindProjectRenderPlanInputV2,
  hashProjectCaptionSource,
  loadExactProjectRenderPlan,
  projectRenderPlanOperationDefinition,
  projectRenderPlanOperationDefinitionV2,
} from "./project-plan";
import {
  CandidateProjectRenderInputSchema,
  CandidateRenderDerivationV1Schema,
  ATET_PROJECT_RENDERER_ABI,
  bindCandidateRenderOutputInput,
  bindCandidateRenderOutputOperationDefinition,
  candidateRenderDerivationSha256,
  candidateRenderOutputPath,
} from "./bind-candidate-output";
import {
  ProjectRenderOutputSchema,
  bindProjectRenderInput,
  bindProjectRenderInputV2,
  bindProjectRenderInputV3,
  bindProjectRenderToolchain,
  projectRenderOperationDefinition,
  projectRenderOperationDefinitionV2,
  projectRenderOperationDefinitionV3,
  reconcileProjectRender,
} from "./project";

const NODE_PLAN_SHA256 = "b".repeat(64);
const EXECUTION_IDENTITY = {
  nodeKey: "render",
  nodePlanSha256: NODE_PLAN_SHA256,
  runId: "run_render01",
} as const;
const RENDERED_BYTES = Buffer.from("deterministic rendered bytes\n", "utf8");
const FIXTURE_EXECUTABLE = Bun.which("true") ?? "/usr/bin/true";

function reconciliationControl() {
  return {
    abortSignal: new AbortController().signal,
    beforePublication: () => Promise.resolve(),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

async function immutableRenderFixture(
  repositoryRoot: string,
  options: { readonly captions?: boolean } = {},
) {
  const fixture = await createOperationProjectFixture(repositoryRoot);
  const mediaBytes = Buffer.from("immutable-media-v1\n", "utf8");
  const mediaPath = join(repositoryRoot, "fixtures", "operation.mp4");
  await mkdir(dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, mediaBytes);
  const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");
  const mediaProject = VideoProjectV1Schema.parse({
    ...fixture.project,
    assets: fixture.project.assets.map(asset => ({
      ...asset,
      streams: asset.streams.map(stream => ({
        ...stream,
        segments: stream.segments.map(segment => ({
          ...segment,
          bytes: mediaBytes.byteLength,
          sha256: mediaSha256,
        })),
      })),
    })),
  });
  const audioStream = mediaProject.assets[0]!.streams.find(
    stream => stream.kind === "audio",
  );
  if (audioStream?.kind !== "audio") {
    throw new Error("Immutable render fixture requires an audio stream.");
  }
  const speechAnalysis = options.captions === true
    ? SpeechAnalysisV1Schema.parse({
        analysisId: "analysis_caption0001",
        config: {
          language: "en",
          minimumFillerConfidence: 0.7,
          speechHandleUs: 100_000,
        },
        createdAt: mediaProject.createdAt,
        durationUs: mediaProject.assets[0]!.durationUs,
        inputDigest: "c".repeat(64),
        kind: "atet.speech-analysis",
        result: {
          detectedLanguage: "en",
          fillers: [],
          status: "transcribed",
          utterances: [],
          words: [
            {
              confidence: 0.99,
              range: { endUs: 900_000, startUs: 400_000 },
              speaker: "speaker-one",
              text: "Hello",
              wordIndex: 0,
            },
            {
              confidence: 0.98,
              range: { endUs: 1_400_000, startUs: 950_000 },
              speaker: "speaker-one",
              text: "world.",
              wordIndex: 1,
            },
            {
              confidence: 0.97,
              range: { endUs: 2_400_000, startUs: 2_000_000 },
              speaker: "speaker-one",
              text: "Second",
              wordIndex: 2,
            },
            {
              confidence: 0.96,
              range: { endUs: 2_900_000, startUs: 2_450_000 },
              speaker: "speaker-one",
              text: "caption.",
              wordIndex: 3,
            },
          ],
        },
        schemaVersion: 1,
        subject: {
          assetId: mediaProject.assets[0]!.assetId,
          integritySha256: canonicalJsonSha256({
            assetDurationUs: mediaProject.assets[0]!.durationUs,
            stream: audioStream,
          }),
          streamId: audioStream.streamId,
        },
        tool: {
          name: "caption-fixture",
          profile: "word-timestamps-v1",
          version: "1.0.0",
        },
      })
    : undefined;
  const speechContents = speechAnalysis === undefined
    ? undefined
    : `${canonicalJson(speechAnalysis)}\n`;
  const speechPath = "analysis/speech-caption.json";
  const project = VideoProjectV1Schema.parse({
    ...mediaProject,
    analyses: speechAnalysis === undefined || speechContents === undefined
      ? []
      : [{
          analysisId: speechAnalysis.analysisId,
          assetId: speechAnalysis.subject.assetId,
          createdAt: speechAnalysis.createdAt,
          fillerCount: speechAnalysis.result.status === "transcribed"
            ? speechAnalysis.result.fillers.length
            : 0,
          kind: "speech",
          path: speechPath,
          sha256: sha256Hex(speechContents),
          streamId: speechAnalysis.subject.streamId,
          wordCount: speechAnalysis.result.status === "transcribed"
            ? speechAnalysis.result.words.length
            : 0,
        }],
  });
  const plan = createDefaultProjectEditPlan(
    project,
    fixture.plan.planId,
    fixture.plan.createdAt,
  );
  await saveVideoProject(fixture.fileSystem, project);
  await saveProjectEditPlan(fixture.fileSystem, plan);
  if (speechContents !== undefined) {
    await fixture.fileSystem.writeTextNoReplace!(speechPath, speechContents);
  }
  const document = createProjectEditRevisionDocument(project, plan);
  const revisionContents = `${canonicalJson(document)}\n`;
  const artifactSha256 = sha256Hex(revisionContents);
  const artifactPath = `edits/revisions/${artifactSha256}.json`;
  await fixture.fileSystem.writeTextNoReplace!(
    artifactPath,
    revisionContents,
  );
  const revision = RenderableProjectEditRevisionReferenceSchema.parse({
    artifact: {
      bytes: new TextEncoder().encode(revisionContents).byteLength,
      path: artifactPath,
      sha256: artifactSha256,
    },
    baseGeneration: hashProjectGeneration(project, plan),
    kind: "studio.project-edit-revision-reference",
    outputGeometrySha256: hashProjectEditRevisionOutputGeometry({
      pixelHeight: 720,
      pixelWidth: 1_280,
      revisionSha256: document.revisionSha256,
    }),
    pixelHeight: 720,
    pixelWidth: 1_280,
    planId: plan.planId,
    projectEditPlanSha256: document.projectEditPlanSha256,
    projectId: project.projectId,
    projectSha256: document.projectSha256,
    projectStructureSha256: hashProjectStructure(project),
    revisionSha256: document.revisionSha256,
    schemaVersion: 1,
  });
  return {
    ...fixture,
    mediaBytes,
    mediaPath,
    plan,
    project,
    revision,
    speechAnalysis,
  };
}

function exactCapabilities(): ApplicationContext["capabilities"] {
  return () => Promise.resolve([
    {
      available: true,
      command: FIXTURE_EXECUTABLE,
      name: "ffmpeg",
      version: "ffmpeg exact fixture",
    },
    {
      available: true,
      command: FIXTURE_EXECUTABLE,
      name: "ffprobe",
      version: "ffprobe exact fixture",
    },
    {
      available: true,
      command: FIXTURE_EXECUTABLE,
      name: "rsvg-convert",
      version: "rsvg exact fixture",
    },
  ]);
}

function renderApplication(
  repositoryRoot: string,
  runner: ApplicationProcessRunner,
): ApplicationContext {
  return {
    ...operationApplicationContext(repositoryRoot, {
      capabilities: exactCapabilities(),
    }),
    runner,
  };
}

async function compileFrozenPlan(
  application: ApplicationContext,
  revision: ReturnType<
    typeof RenderableProjectEditRevisionReferenceSchema.parse
  >,
  beforePublication?: () => Promise<void>,
): Promise<ProjectRenderPlanReference> {
  const registry = new OperationRegistry();
  registry.register(projectRenderPlanOperationDefinition);
  const context = beforePublication === undefined
    ? {
        abortSignal: new AbortController().signal,
        application,
      }
    : await workflowContext(application, beforePublication);
  const result = await registry.execute(context, {
    input: await bindProjectRenderPlanInput(application, {
      revision,
      settings: {
        background: "#112233ff",
        frameRate: 30,
      },
    }),
    kind: "render.project-plan",
    version: 1,
  });
  const output = ProjectRenderPlanOutputSchema.parse(result.output);
  expect(output.kind).toBe("atet.project-render-plan-reference");
  return output;
}

async function workflowContext(
  application: ApplicationContext,
  beforePublication: () => Promise<void> = () => Promise.resolve(),
  abortSignal: AbortSignal = new AbortController().signal,
  execution: {
    readonly nodeKey: string;
    readonly nodePlanSha256: string;
    readonly runId: string;
  } = EXECUTION_IDENTITY,
) {
  const nodeDigest = createHash("sha256")
    .update(execution.nodeKey)
    .digest("hex");
  const workspaceDirectory = join(
    application.paths.privateRoot,
    "workflow-runs",
    execution.runId,
    "staging",
    nodeDigest,
    execution.nodePlanSha256,
  );
  await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  return {
    abortSignal,
    application,
    workflow: {
      ...execution,
      beforePublication,
      workspaceDirectory,
    },
  };
}

function publicationPrecommitPath(
  application: ApplicationContext,
  execution: {
    readonly nodeKey: string;
    readonly nodePlanSha256: string;
    readonly runId: string;
  } = EXECUTION_IDENTITY,
): string {
  const nodeDigest = createHash("sha256")
    .update(execution.nodeKey)
    .digest("hex");
  return join(
    application.paths.privateRoot,
    "workflow-runs",
    execution.runId,
    "staging",
    nodeDigest,
    execution.nodePlanSha256,
    "project-render-publication-precommit.v1.json",
  );
}

async function exactRenderInput(
  application: ApplicationContext,
  plan: ProjectRenderPlanReference,
  path = "renders/final.mp4",
) {
  return await bindProjectRenderInput(application, {
    output: {
      maximumBytes: 16 * 1024 * 1024,
      path,
    },
    plan,
    syncPolicy: "require-verified",
  });
}

async function exactCandidateRenderInput(
  application: ApplicationContext,
  fixture: Awaited<ReturnType<typeof immutableRenderFixture>>,
  plan: ProjectRenderPlanReference,
) {
  const base = creativeBaseIdentityV1(createCreativeBaseV1({
    currentPlan: fixture.plan,
    project: fixture.project,
  }));
  const candidate = createCreativeCandidateIdentityV1({
    base,
    variantKey: "rerun",
  });
  const candidateRevision = CreativeCandidateRevisionReferenceV1Schema.parse({
    artifact: fixture.revision.artifact,
    base,
    batchSha256: "8".repeat(64),
    bindingsSha256: "9".repeat(64),
    candidate,
    derivationSha256: "a".repeat(64),
    kind: "atet.creative-candidate-revision-reference",
    planId: fixture.revision.planId,
    projectEditPlanSha256: fixture.revision.projectEditPlanSha256,
    projectId: fixture.revision.projectId,
    projectSha256: fixture.revision.projectSha256,
    projectStructureSha256: fixture.revision.projectStructureSha256,
    revisionSha256: fixture.revision.revisionSha256,
    schemaVersion: 1,
    updatedAt: fixture.plan.updatedAt,
  });
  const exact = bindCandidateRenderOutputInput({
    candidateRevision,
    maximumBytes: 16 * 1024 * 1024,
    plan,
    revision: fixture.revision,
    syncPolicy: "require-verified",
    target: {
      canvas: {
        frameRate: 30,
        kind: "custom",
        pixelHeight: 720,
        pixelWidth: 1_280,
      },
      tier: "preview",
    },
  }, await bindProjectRenderToolchain(application));
  const registry = new OperationRegistry();
  registry.register(bindCandidateRenderOutputOperationDefinition);
  return bindCandidateRenderOutputOperationDefinition.outputSchema.parse((
    await registry.execute({
      abortSignal: new AbortController().signal,
      application,
    }, {
      input: exact,
      kind: "render.bind-candidate-output",
      version: 1,
    })
  ).output);
}

function candidateRenderInputWithRendererAbi(
  input: Awaited<ReturnType<typeof exactCandidateRenderInput>>,
  rendererAbi: string,
) {
  const body = {
    binding: input.derivation.binding,
    candidateRevision: input.derivation.candidateRevision,
    encoderRecipe: input.derivation.encoderRecipe,
    kind: input.derivation.kind,
    maximumBytes: input.derivation.maximumBytes,
    plan: input.derivation.plan,
    rendererAbi,
    revision: input.derivation.revision,
    schemaVersion: input.derivation.schemaVersion,
    syncPolicy: input.derivation.syncPolicy,
    target: input.derivation.target,
  } as const;
  const derivation = CandidateRenderDerivationV1Schema.parse({
    ...body,
    derivationSha256: candidateRenderDerivationSha256(body),
  });
  return CandidateProjectRenderInputSchema.parse({
    ...input,
    derivation,
    output: {
      ...input.output,
      path: candidateRenderOutputPath(derivation),
    },
  });
}

describe("immutable workflow project rendering", () => {
  test("render-plan publication revalidates the workflow fence", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-plan-fence-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      const application = renderApplication(repositoryRoot, {
        run: () => Promise.reject(new Error("Render planning must not invoke FFmpeg.")),
      });
      let checks = 0;
      expect(compileFrozenPlan(application, fixture.revision, () => {
        checks += 1;
        return Promise.reject(new ApplicationError(
          "cancelled",
          "The durable workflow fence is no longer current.",
        ));
      })).rejects.toMatchObject({ code: "cancelled" });
      expect(checks).toBe(1);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("derives packed social captions from an exact frozen speech analysis", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-captioned-render-plan-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot, {
        captions: true,
      });
      const application = renderApplication(repositoryRoot, {
        run: () => Promise.reject(new Error("Caption planning must not invoke FFmpeg.")),
      });
      const input = await bindProjectRenderPlanInputV2(application, {
        revision: fixture.revision,
        settings: {
          captions: {
            analysisId: "analysis_caption0001",
            placementId: "placement_operation01",
          },
          frameRate: 30,
        },
      });
      expect(input.captionBinding).toMatchObject({
        analysisId: "analysis_caption0001",
        assetId: "asset_operation01",
        placementId: "placement_operation01",
        streamId: "stream_operation02",
        wordCount: 4,
      });
      if (input.captionBinding === undefined) {
        throw new Error("Expected an exact caption binding.");
      }

      const registry = new OperationRegistry();
      registry.register(projectRenderPlanOperationDefinitionV2);
      const result = await registry.execute(
        await workflowContext(application),
        {
          input,
          kind: "render.project-plan",
          version: 2,
        },
      );
      const reference = ProjectRenderPlanOutputSchema.parse(result.output);
      const captioned = await loadExactProjectRenderPlan(application, reference);
      expect(captioned.document.plan.output.frameRate).toBe(30);
      expect(captioned.document.plan.overlays).toHaveLength(2);
      expect(new Set(captioned.document.plan.overlays.map(
        overlay => overlay.operation.overlayId,
      )).size).toBe(1);
      expect(captioned.document.plan.overlays.map(
        overlay => overlay.operation.crop.kind,
      )).toEqual(["normalized-insets", "normalized-insets"]);
      const sources = captioned.document.plan.overlays.map(
        overlay => overlay.operation.source,
      );
      expect(sources.every(source => source.kind === "svg")).toBe(true);
      expect(new Set(sources.map(source => canonicalJson(source))).size).toBe(1);
      expect(new Set(captioned.document.plan.overlays.map(
        overlay => canonicalJson(overlay.operation.intrinsicSize),
      )).size).toBe(1);
      const source = sources[0]!;
      if (source.kind !== "svg") throw new Error("Expected a caption SVG sprite.");
      expect(source.asset.provenance).toMatchObject({
        kind: "generated",
        sourceSha256: hashProjectCaptionSource({
          binding: input.captionBinding,
          output: captioned.document.plan.output,
          projectEditPlanSha256: fixture.revision.projectEditPlanSha256,
          revisionSha256: fixture.revision.revisionSha256,
          style: "social-block-v1",
        }),
      });
      expect(hashProjectCaptionSource({
        binding: input.captionBinding,
        output: captioned.document.plan.output,
        projectEditPlanSha256: fixture.revision.projectEditPlanSha256,
        revisionSha256: "e".repeat(64),
        style: "social-block-v1",
      })).not.toBe(source.asset.provenance.sourceSha256);
      expect(source.asset.path).toMatch(/^renders\/caption-assets\/[a-f0-9]{64}\.svg$/u);
      expect(await fixture.fileSystem.readText(source.asset.path)).toContain("Hello world.");
      expect(await fixture.fileSystem.readText(source.asset.path)).toContain("Second caption.");

      const clean = await compileFrozenPlan(application, fixture.revision);
      const cleanPlan = await loadExactProjectRenderPlan(application, clean);
      expect(cleanPlan.document.plan.overlays).toEqual([]);
      expect(clean.revisionSha256).toBe(reference.revisionSha256);
      expect(clean.planSha256).not.toBe(reference.planSha256);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("fails closed when a caption binding changes after node planning", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-caption-binding-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot, {
        captions: true,
      });
      const application = renderApplication(repositoryRoot, {
        run: () => Promise.reject(new Error("Caption planning must not invoke FFmpeg.")),
      });
      const input = await bindProjectRenderPlanInputV2(application, {
        revision: fixture.revision,
        settings: {
          captions: {
            analysisId: "analysis_caption0001",
            placementId: "placement_operation01",
          },
        },
      });
      const registry = new OperationRegistry();
      registry.register(projectRenderPlanOperationDefinitionV2);
      expect(registry.execute(
        await workflowContext(application),
        {
          input: {
            ...input,
            captionBinding: {
              ...input.captionBinding!,
              placementSyncSha256: "d".repeat(64),
            },
          },
          kind: "render.project-plan",
          version: 2,
        },
      )).rejects.toMatchObject({
        code: "conflict",
        message: "Caption source changed after the render-plan node was bound.",
      });
      if (
        fixture.speechAnalysis === undefined
        || fixture.speechAnalysis.result.status !== "transcribed"
      ) {
        throw new Error("Expected the caption fixture speech analysis.");
      }
      const changedAnalysis = SpeechAnalysisV1Schema.parse({
        ...fixture.speechAnalysis,
        result: {
          ...fixture.speechAnalysis.result,
          words: fixture.speechAnalysis.result.words.map((word, index) => (
            index === 0 ? { ...word, text: "Changed" } : word
          )),
        },
      });
      await fixture.fileSystem.writeTextAtomic(
        "analysis/speech-caption.json",
        `${canonicalJson(changedAnalysis)}\n`,
      );
      expect(registry.execute(
        await workflowContext(application),
        {
          input,
          kind: "render.project-plan",
          version: 2,
        },
      )).rejects.toMatchObject({
        code: "conflict",
        message: "Speech analysis analysis_caption0001 is stale or failed its exact identity check.",
      });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("current project and plan mutation cannot change a revision render", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-operation-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      expect(() => RenderableProjectEditRevisionReferenceSchema.parse({
        ...fixture.revision,
        pixelWidth: fixture.revision.pixelWidth + 2,
      })).toThrow(/geometry/u);
      let rendererCalls = 0;
      let publicationChecks = 0;
      let observedCwd: string | undefined;
      const runner: ApplicationProcessRunner = {
        run: async (argv, options) => {
          rendererCalls += 1;
          observedCwd = options?.cwd;
          expect(argv[0]).toContain("/capability-pins-v1/");
          expect(argv[0]).toEndWith("/true");
          expect(argv).toContain("-n");
          await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      };
      const application = renderApplication(repositoryRoot, runner);

      // Neither planning nor rendering may reopen these mutable pointers.
      await fixture.fileSystem.writeTextAtomic("project.json", "{}\n");
      await fixture.fileSystem.writeTextAtomic("edits/current.json", "{}\n");
      const plan = await compileFrozenPlan(application, fixture.revision);
      const exactPlan = await loadExactProjectRenderPlan(application, plan);
      expect(exactPlan.document.plan.output).toMatchObject({
        background: "#112233ff",
        durationUs: 10_000_000,
        frameRate: 30,
        pixelHeight: 720,
        pixelWidth: 1_280,
      });
      const input = await exactRenderInput(application, plan);
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinition);
      const context = await workflowContext(application, () => {
        publicationChecks += 1;
        return Promise.resolve();
      });
      const result = await registry.execute(context, {
        input,
        kind: "render.project",
        version: 1,
      });
      const output = ProjectRenderOutputSchema.parse(result.output);
      expect(rendererCalls).toBe(1);
      expect(publicationChecks).toBe(1);
      expect(observedCwd).toBe(
        await realpath(context.workflow.workspaceDirectory),
      );
      expect(result.receiptReference).toBe(output.receipt.path);
      expect(await readFile(
        join(fixture.projectDirectory, output.output.path),
      )).toEqual(RENDERED_BYTES);

      const receipt = ProjectRenderReceiptV2Schema.parse(JSON.parse(
        await fixture.fileSystem.readText(output.receipt.path),
      ) as unknown);
      expect(receipt.plan).toEqual(plan);
      expect(receipt.run).toEqual(EXECUTION_IDENTITY);
      expect(receipt.toolchain).toEqual(input.binding);
      expect(receipt.output).toEqual(output.output);

      expect(await reconcileProjectRender(
        application,
        input,
        EXECUTION_IDENTITY,
        reconciliationControl(),
      )).toEqual({ kind: "completed", output });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("adopts an exact candidate render across runs from immutable source evidence", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-candidate-render-adoption-",
    ));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      let rendererCalls = 0;
      let publicationChecks = 0;
      const application = renderApplication(repositoryRoot, {
        run: async argv => {
          rendererCalls += 1;
          await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      });
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactCandidateRenderInput(
        application,
        fixture,
        plan,
      );
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinitionV3);
      const beforePublication = () => {
        publicationChecks += 1;
        return Promise.resolve();
      };

      const first = ProjectRenderOutputSchema.parse((await registry.execute(
        await workflowContext(application, beforePublication),
        { input, kind: "render.project", version: 3 },
      )).output);
      expect(rendererCalls).toBe(1);
      const reusePath = `renders/receipts/derivations/${input.derivation.derivationSha256}.json`;
      expect(JSON.parse(await fixture.fileSystem.readText(reusePath)))
        .toMatchObject({
          derivationSha256: input.derivation.derivationSha256,
          rendererAbi: ATET_PROJECT_RENDERER_ABI,
          sourceReceipt: { path: first.receipt.path },
        });

      const incompatibleInput = candidateRenderInputWithRendererAbi(
        input,
        "atet-project-renderer-abi-v2",
      );
      expect(incompatibleInput.output.path).not.toBe(input.output.path);
      const incompatibleError: unknown = await bindProjectRenderInputV3(
        application,
        incompatibleInput,
      ).then(() => undefined, (error: unknown) => error);
      expect(incompatibleError).toBeInstanceOf(ApplicationError);
      if (!(incompatibleError instanceof ApplicationError)) {
        throw new Error("Expected candidate renderer ABI rejection.");
      }
      expect(incompatibleError.code).toBe("incompatible");
      expect(incompatibleError.message).toContain("renderer ABI");
      await rm(join(fixture.projectDirectory, reusePath));

      const secondExecution = {
        ...EXECUTION_IDENTITY,
        runId: "run_render02",
      } as const;
      const second = ProjectRenderOutputSchema.parse((await registry.execute(
        await workflowContext(
          application,
          beforePublication,
          new AbortController().signal,
          secondExecution,
        ),
        { input, kind: "render.project", version: 3 },
      )).output);
      expect(rendererCalls).toBe(1);
      expect(second).toEqual(first);
      expect(JSON.parse(await fixture.fileSystem.readText(reusePath)))
        .toMatchObject({
          derivationSha256: input.derivation.derivationSha256,
          rendererAbi: ATET_PROJECT_RENDERER_ABI,
          sourceReceipt: { path: first.receipt.path },
        });

      const thirdExecution = {
        nodeKey: "render-copy",
        nodePlanSha256: "c".repeat(64),
        runId: "run_render03",
      } as const;
      const third = ProjectRenderOutputSchema.parse((await registry.execute(
        await workflowContext(
          application,
          beforePublication,
          new AbortController().signal,
          thirdExecution,
        ),
        { input, kind: "render.project", version: 3 },
      )).output);
      expect(rendererCalls).toBe(1);
      expect(publicationChecks).toBe(3);
      expect(third).toEqual(first);
      const sourceReceipt = ProjectRenderReceiptV2Schema.parse(JSON.parse(
        await fixture.fileSystem.readText(third.receipt.path),
      ) as unknown);
      expect(sourceReceipt.run).toEqual(EXECUTION_IDENTITY);
      expect(fixture.fileSystem.readText(
        `renders/receipts/${thirdExecution.nodePlanSha256}.json`,
      )).rejects.toMatchObject({ code: "ENOENT" });

      const validReuseContents = await fixture.fileSystem.readText(reusePath);
      const validReuseRecord = JSON.parse(validReuseContents) as Record<
        string,
        unknown
      >;
      const {
        recordSha256: validRecordSha256,
        ...validReuseBody
      } = validReuseRecord;
      expect(validRecordSha256).toMatch(/^[a-f0-9]{64}$/u);
      const incompatibleReuseBody = {
        ...validReuseBody,
        rendererAbi: "atet-project-renderer-abi-v2",
      };
      const incompatibleReuseRecord = {
        ...incompatibleReuseBody,
        recordSha256: canonicalJsonSha256({
          domain: "atet.candidate-render-reuse-record/v1",
          ...incompatibleReuseBody,
        }),
      };
      const reuseAbsolute = join(fixture.projectDirectory, reusePath);
      await rm(reuseAbsolute);
      await writeFile(
        reuseAbsolute,
        `${canonicalJson(incompatibleReuseRecord)}\n`,
        { flag: "wx" },
      );
      const incompatibleReuseExecution = {
        nodeKey: "render-incompatible-reuse",
        nodePlanSha256: "1".repeat(64),
        runId: "run_renderidentity01",
      } as const;
      expect(registry.execute(
        await workflowContext(
          application,
          beforePublication,
          new AbortController().signal,
          incompatibleReuseExecution,
        ),
        { input, kind: "render.project", version: 3 },
      )).rejects.toThrow(/does not match the exact derivation/u);
      expect(rendererCalls).toBe(1);
      await rm(reuseAbsolute);
      await writeFile(reuseAbsolute, validReuseContents, { flag: "wx" });

      await rm(join(fixture.projectDirectory, input.output.path));
      const recordOnlyExecution = {
        nodeKey: "render-record-only",
        nodePlanSha256: "d".repeat(64),
        runId: "run_render04",
      } as const;
      expect(registry.execute(
        await workflowContext(
          application,
          beforePublication,
          new AbortController().signal,
          recordOnlyExecution,
        ),
        { input, kind: "render.project", version: 3 },
      )).rejects.toThrow(/without its immutable output/u);

      await writeFile(
        join(fixture.projectDirectory, input.output.path),
        RENDERED_BYTES,
        { flag: "wx" },
      );
      await Promise.all([
        rm(join(fixture.projectDirectory, reusePath)),
        rm(join(fixture.projectDirectory, first.receipt.path)),
      ]);
      const outputOnlyExecution = {
        nodeKey: "render-output-only",
        nodePlanSha256: "e".repeat(64),
        runId: "run_render05",
      } as const;
      expect(registry.execute(
        await workflowContext(
          application,
          beforePublication,
          new AbortController().signal,
          outputOnlyExecution,
        ),
        { input, kind: "render.project", version: 3 },
      )).rejects.toThrow(/without an exact receipt or reuse record/u);
      expect(rendererCalls).toBe(1);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("reconciliation recovers a candidate output from its exact run-private precommit", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-candidate-render-precommit-recovery-",
    ));
    const receiptDirectory = join(
      repositoryRoot,
      "artifacts",
      "atet",
      "projects",
      "project_operation01",
      "renders",
      "receipts",
    );
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      let rendererCalls = 0;
      const application = renderApplication(repositoryRoot, {
        run: async argv => {
          rendererCalls += 1;
          await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
          await chmod(receiptDirectory, 0o500);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      });
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactCandidateRenderInput(
        application,
        fixture,
        plan,
      );
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinitionV3);
      const receiptPath = `renders/receipts/${NODE_PLAN_SHA256}.json`;
      const reusePath = `renders/receipts/derivations/${input.derivation.derivationSha256}.json`;

      expect(await rejection(registry.execute(
        await workflowContext(application),
        { input, kind: "render.project", version: 3 },
      ))).toBeInstanceOf(Error);
      await chmod(receiptDirectory, 0o700);

      expect(rendererCalls).toBe(1);
      expect(await readFile(
        join(fixture.projectDirectory, input.output.path),
      )).toEqual(RENDERED_BYTES);
      expect(await fixture.fileSystem.readText(receiptPath).catch(() => null))
        .toBeNull();
      expect(await fixture.fileSystem.readText(reusePath).catch(() => null))
        .toBeNull();
      expect(await readFile(
        publicationPrecommitPath(application),
        "utf8",
      )).toContain("atet.project-render-publication-precommit");

      let publicationChecks = 0;
      const reconciliation = await reconcileProjectRender(
        application,
        input,
        EXECUTION_IDENTITY,
        {
          abortSignal: new AbortController().signal,
          beforePublication: () => {
            publicationChecks += 1;
            return Promise.resolve();
          },
        },
      );
      expect(reconciliation.kind).toBe("completed");
      if (reconciliation.kind !== "completed") {
        throw new Error("Expected candidate render reconciliation to complete.");
      }
      expect(publicationChecks).toBe(1);
      expect(reconciliation.output.receipt.path).toBe(receiptPath);
      const receipt = ProjectRenderReceiptV2Schema.parse(JSON.parse(
        await fixture.fileSystem.readText(receiptPath),
      ) as unknown);
      expect(receipt.run).toEqual(EXECUTION_IDENTITY);
      expect(receipt.output).toEqual(reconciliation.output.output);
      expect(JSON.parse(await fixture.fileSystem.readText(reusePath)))
        .toMatchObject({
          derivationSha256: input.derivation.derivationSha256,
          output: reconciliation.output.output,
          rendererAbi: ATET_PROJECT_RENDERER_ABI,
          sourceReceipt: { path: receiptPath },
        });
      expect(rendererCalls).toBe(1);
      expect(await reconcileProjectRender(
        application,
        input,
        EXECUTION_IDENTITY,
        reconciliationControl(),
      )).toEqual(reconciliation);
    } finally {
      await chmod(receiptDirectory, 0o700).catch(() => undefined);
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects a canvas target that disagrees with the exact render plan", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-target-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      let rendererCalls = 0;
      const application = renderApplication(repositoryRoot, {
        run: () => {
          rendererCalls += 1;
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        },
      });
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await bindProjectRenderInputV2(application, {
        target: {
          canvas: { kind: "profile", profileId: "landscape" },
          tier: "final",
        },
        output: {
          maximumBytes: 16 * 1024 * 1024,
          path: "renders/mismatched-target.mp4",
        },
        plan,
        syncPolicy: "require-verified",
      });
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinitionV2);

      expect(registry.execute(
        await workflowContext(application),
        { input, kind: "render.project", version: 2 },
      )).rejects.toMatchObject({
        code: "conflict",
        message: "Project render plan geometry does not match its exact canvas target.",
      });
      expect(rendererCalls).toBe(0);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("a cancellation requested at the publication point cannot strand an output without its receipt", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-finalize-cancel-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      const application = renderApplication(repositoryRoot, {
        run: async argv => {
          await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      });
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactRenderInput(application, plan);
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinition);
      const cancellation = new AbortController();
      let publicationChecks = 0;
      const context = await workflowContext(application, () => {
        publicationChecks += 1;
        cancellation.abort();
        return Promise.resolve();
      }, cancellation.signal);

      const result = await registry.execute(context, {
        input,
        kind: "render.project",
        version: 1,
      });
      const output = ProjectRenderOutputSchema.parse(result.output);
      expect(cancellation.signal.aborted).toBeTrue();
      expect(publicationChecks).toBe(1);
      expect(await readFile(
        join(fixture.projectDirectory, output.output.path),
      )).toEqual(RENDERED_BYTES);
      expect(await fixture.fileSystem.readText(output.receipt.path))
        .toBe(`${canonicalJson(ProjectRenderReceiptV2Schema.parse(JSON.parse(
          await fixture.fileSystem.readText(output.receipt.path),
        ) as unknown))}\n`);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("reconciliation finalizes an exact receipt after failure between output and receipt publication", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-precommit-recovery-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      const receiptDirectory = join(
        fixture.projectDirectory,
        "renders",
        "receipts",
      );
      const application = renderApplication(repositoryRoot, {
        run: async argv => {
          await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
          await chmod(receiptDirectory, 0o500);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      });
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactRenderInput(application, plan);
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinition);

      expect(await rejection(registry.execute(
        await workflowContext(application),
        { input, kind: "render.project", version: 1 },
      ))).toBeInstanceOf(Error);
      await chmod(receiptDirectory, 0o700);

      expect(await readFile(
        join(fixture.projectDirectory, input.output.path),
      )).toEqual(RENDERED_BYTES);
      expect(await fixture.fileSystem.readText(
        `renders/receipts/${NODE_PLAN_SHA256}.json`,
      ).catch(() => null)).toBeNull();
      expect(await readFile(
        publicationPrecommitPath(application),
        "utf8",
      )).toContain("atet.project-render-publication-precommit");

      const fenced = await reconcileProjectRender(
        application,
        input,
        EXECUTION_IDENTITY,
        {
          abortSignal: new AbortController().signal,
          beforePublication: () => Promise.reject(new ApplicationError(
            "cancelled",
            "Reconciliation claim was released.",
          )),
        },
      );
      expect(fenced).toMatchObject({
        kind: "conflict",
        message: "Reconciliation claim was released.",
      });
      expect(await fixture.fileSystem.readText(
        `renders/receipts/${NODE_PLAN_SHA256}.json`,
      ).catch(() => null)).toBeNull();

      let barrierArrivals = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>(resolve => {
        releaseBarrier = resolve;
      });
      const racingControl = () => ({
        abortSignal: new AbortController().signal,
        beforePublication: async () => {
          barrierArrivals += 1;
          if (barrierArrivals === 2) releaseBarrier();
          await barrier;
        },
      });
      const [reconciliation, identicalRace] = await Promise.all([
        reconcileProjectRender(
          application,
          input,
          EXECUTION_IDENTITY,
          racingControl(),
        ),
        reconcileProjectRender(
          application,
          input,
          EXECUTION_IDENTITY,
          racingControl(),
        ),
      ]);
      expect(reconciliation.kind).toBe("completed");
      if (reconciliation.kind !== "completed") {
        throw new Error("Expected interrupted render reconciliation to complete.");
      }
      expect(identicalRace).toEqual(reconciliation);
      expect(await fixture.fileSystem.readText(
        reconciliation.output.receipt.path,
      )).toContain(reconciliation.output.output.sha256);
      expect(await reconcileProjectRender(
        application,
        input,
        EXECUTION_IDENTITY,
        reconciliationControl(),
      )).toEqual(reconciliation);
    } finally {
      await chmod(
        join(repositoryRoot, "artifacts", "atet", "projects", "project_operation01", "renders", "receipts"),
        0o700,
      ).catch(() => undefined);
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("reconciliation rejects forged and differently-bound publication precommits", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-precommit-forgery-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      const receiptDirectory = join(
        fixture.projectDirectory,
        "renders",
        "receipts",
      );
      const application = renderApplication(repositoryRoot, {
        run: async argv => {
          await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
          await chmod(receiptDirectory, 0o500);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      });
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactRenderInput(application, plan);
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinition);
      expect(await rejection(registry.execute(
        await workflowContext(application),
        { input, kind: "render.project", version: 1 },
      ))).toBeInstanceOf(Error);
      await chmod(receiptDirectory, 0o700);

      const validPrecommit = await readFile(
        publicationPrecommitPath(application),
        "utf8",
      );
      const otherExecution = {
        nodeKey: "render-other",
        nodePlanSha256: "c".repeat(64),
        runId: EXECUTION_IDENTITY.runId,
      } as const;
      const otherPrecommitPath = publicationPrecommitPath(
        application,
        otherExecution,
      );
      await mkdir(dirname(otherPrecommitPath), {
        mode: 0o700,
        recursive: true,
      });
      await writeFile(otherPrecommitPath, validPrecommit, {
        flag: "wx",
        mode: 0o600,
      });
      const mismatched = await reconcileProjectRender(
        application,
        input,
        otherExecution,
        reconciliationControl(),
      );
      expect(mismatched.kind).toBe("conflict");
      if (mismatched.kind !== "conflict") {
        throw new Error("Expected differently-bound precommit to conflict.");
      }
      expect(mismatched.message).toContain("exact input, run, plan");

      const forgedExecution = {
        nodeKey: "render-forged",
        nodePlanSha256: "d".repeat(64),
        runId: EXECUTION_IDENTITY.runId,
      } as const;
      const forgedPath = publicationPrecommitPath(
        application,
        forgedExecution,
      );
      const forgedValue = JSON.parse(validPrecommit) as Record<
        string,
        unknown
      >;
      forgedValue.precommitSha256 = "e".repeat(64);
      await mkdir(dirname(forgedPath), { mode: 0o700, recursive: true });
      await writeFile(
        forgedPath,
        `${canonicalJson(forgedValue)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      expect(await reconcileProjectRender(
        application,
        input,
        forgedExecution,
        reconciliationControl(),
      )).toMatchObject({
        kind: "conflict",
      });
      expect(await fixture.fileSystem.readText(
        `renders/receipts/${otherExecution.nodePlanSha256}.json`,
      ).catch(() => null)).toBeNull();
      expect(await fixture.fileSystem.readText(
        `renders/receipts/${forgedExecution.nodePlanSha256}.json`,
      ).catch(() => null)).toBeNull();
    } finally {
      await chmod(
        join(repositoryRoot, "artifacts", "atet", "projects", "project_operation01", "renders", "receipts"),
        0o700,
      ).catch(() => undefined);
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("media mutation after encoding prevents public output and receipt publication", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-media-race-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      const runner: ApplicationProcessRunner = {
        run: async argv => {
          await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
          await writeFile(fixture.mediaPath, "mutated-media\n");
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      };
      const application = renderApplication(repositoryRoot, runner);
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactRenderInput(application, plan);
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinition);

      expect(await rejection(registry.execute(
        await workflowContext(application),
        { input, kind: "render.project", version: 1 },
      ))).toMatchObject({ code: "invalid-data" });
      expect(await readFile(
        join(fixture.projectDirectory, input.output.path),
      ).catch(() => null)).toBeNull();
      expect(await fixture.fileSystem.readText(
        `renders/receipts/${NODE_PLAN_SHA256}.json`,
      ).catch(() => null)).toBeNull();
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("a pre-existing unrelated output is preserved without dispatch", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-no-replace-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      let rendererCalls = 0;
      const runner: ApplicationProcessRunner = {
        run: () => {
          rendererCalls += 1;
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        },
      };
      const application = renderApplication(repositoryRoot, runner);
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactRenderInput(
        application,
        plan,
        "renders/preserved.mp4",
      );
      const outputAbsolute = join(
        fixture.projectDirectory,
        input.output.path,
      );
      await mkdir(dirname(outputAbsolute), { mode: 0o700, recursive: true });
      await writeFile(outputAbsolute, "unrelated output");
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinition);

      expect(await rejection(registry.execute(
        await workflowContext(application),
        { input, kind: "render.project", version: 1 },
      ))).toMatchObject({ code: "conflict" });
      expect(rendererCalls).toBe(0);
      expect(await readFile(outputAbsolute, "utf8")).toBe("unrelated output");
      expect(await reconcileProjectRender(
        application,
        input,
        EXECUTION_IDENTITY,
        reconciliationControl(),
      )).toMatchObject({
        kind: "conflict",
      });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects same-version executable replacement after exact node planning", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-tool-binding-"));
    try {
      const fixture = await immutableRenderFixture(repositoryRoot);
      const ffmpeg = join(repositoryRoot, "ffmpeg-fixture");
      const ffprobe = join(repositoryRoot, "ffprobe-fixture");
      await Promise.all([
        writeFile(ffmpeg, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
        writeFile(ffprobe, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      ]);
      await Promise.all([chmod(ffmpeg, 0o700), chmod(ffprobe, 0o700)]);
      let rendererCalls = 0;
      const capabilities: ApplicationContext["capabilities"] = () => (
        Promise.resolve([
          {
            available: true,
            command: ffmpeg,
            name: "ffmpeg",
            version: "ffmpeg same-version fixture",
          },
          {
            available: true,
            command: ffprobe,
            name: "ffprobe",
            version: "ffprobe same-version fixture",
          },
          {
            available: false,
            name: "rsvg-convert",
            reason: "not needed by this plan",
          },
        ])
      );
      const application: ApplicationContext = {
        ...operationApplicationContext(repositoryRoot),
        capabilities,
        capability: async name => (
          (await capabilities()).find(candidate => candidate.name === name)
          ?? { available: false, name }
        ),
        runner: {
          run: () => {
            rendererCalls += 1;
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
          },
        },
      };
      const plan = await compileFrozenPlan(application, fixture.revision);
      const input = await exactRenderInput(application, plan);
      await writeFile(ffmpeg, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const registry = new OperationRegistry();
      registry.register(projectRenderOperationDefinition);

      expect(await rejection(registry.execute(
        await workflowContext(application),
        { input, kind: "render.project", version: 1 },
      ))).toMatchObject({ code: "conflict" });
      expect(rendererCalls).toBe(0);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
