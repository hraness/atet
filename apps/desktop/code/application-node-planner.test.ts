import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { ApplicationContext } from "../application/context";
import type {
  ApplicationGatewayPort,
  GatewayPortReconcile,
} from "../application/gateway-port";
import { createApplicationOperationRegistry } from "../application/default-registry";
import {
  createCreativeBaseV1,
  createCreativeCandidateIdentityV1,
  createEmptyCandidateProjectEditBatchV3,
  creativeBaseIdentityV1,
  CreativeCandidateRevisionReferenceV1Schema,
} from "../application/creative-iteration";
import {
  openProjectSnapshot,
  projectGenerationSha256FromHashes,
} from "../application/project-store";
import { withProjectPublicationLease } from "../application/project-publication-lease";
import {
  RenderableProjectEditRevisionReferenceSchema,
  ProjectRenderPlanReferenceSchema,
  hashProjectEditRevisionOutputGeometry,
} from "../application/receipts";
import {
  CommitProjectEditsInputV3Schema,
  BindCandidateRenderOutputInputSchema,
  ATET_PROJECT_RENDERER_ABI,
  deriveProjectEditBatchV2,
  deriveProjectEditBatchV3,
} from "../application/operations";
import { createAtetPortableOperationDefinitions } from "../application/operations/atet-portable";
import { OperationRegistry } from "../application/registry";
import {
  VideoProjectV1Schema,
  ZoomIdSchema,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
} from "../core/canonical-json";
import {
  APPLICATION_VERIFIED_RECEIPT_RECONCILER_KINDS,
  createApplicationNodePlanner,
} from "./application-node-planner";
import { fileCandidateDescriptor } from "./file-candidate-provenance";
import { createNodeInputHash } from "./run-contracts";
import {
  createOperationRecordingProjectFixture,
  createOperationProjectFixture,
  operationApplicationContext,
} from "../application/operations/test-support";
import type {
  NodeExecutionPlanningRequest,
  NodePreparationRequest,
  NodeReconciliationRequest,
} from "./scheduler";

const SPEECH_MODEL = "openai/tts-1";
const FIXTURE_EXECUTABLE = Bun.which("true") ?? "/usr/bin/true";

const application = {
  capabilities: () => Promise.resolve([]),
  capability: name => Promise.resolve({ available: false, name }),
  clock: {
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    timestampMilliseconds: () => 0,
  },
  paths: {
    artifactRoot: "/tmp/artifacts",
    desktopRoot: "/tmp/desktop",
    privateRoot: "/tmp/private",
    projectRoot: "/tmp/projects",
    repositoryRoot: "/tmp/repository",
  },
  runner: {
    run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
  },
} satisfies ApplicationContext;

function fixture<Value>(value: unknown): Value {
  return value as Value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

async function planBehindHeldProjectPublication<Value>(
  application: ApplicationContext,
  project: string,
  plan: () => Promise<Value>,
): Promise<Value> {
  const publicationEntered = deferred();
  const releasePublication = deferred();
  const publication = withProjectPublicationLease(
    application,
    "project.commit-edits",
    { project },
    async () => {
      publicationEntered.resolve();
      await releasePublication.promise;
    },
  );
  await publicationEntered.promise;

  let settled = false;
  const planning = plan().then(
    value => {
      settled = true;
      return { kind: "completed" as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { error, kind: "failed" as const };
    },
  );
  for (let turn = 0; turn < 32; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const settledWhilePublicationHeld = settled;

  releasePublication.resolve();
  await publication;
  const result = await planning;
  expect(settledWhilePublicationHeld).toBe(false);
  if (result.kind === "failed") throw result.error;
  return result.value;
}

function jsonRecord(
  value: NodePreparationRequest["resolvedInput"],
): value is Readonly<Record<string, NodePreparationRequest["resolvedInput"]>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordingLayerProject(project: VideoProjectV1): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    ...project,
    assets: project.assets.map(asset => ({
      ...asset,
      streams: asset.streams.map(stream => (
        stream.kind === "video"
          ? { ...stream, streamId: "stream_display01" }
          : stream
      )),
    })),
    placements: project.placements.map(placement => ({
      ...placement,
      video: placement.video.map(configured => ({
        ...configured,
        streamId: "stream_display01",
      })),
    })),
  });
}

function request(
  input: NodePreparationRequest["resolvedInput"],
): NodePreparationRequest {
  return {
    dependencyOutputs: {},
    graphPlan: fixture<NodePreparationRequest["graphPlan"]>({
      graphPlanSha256: "a".repeat(64),
      staticBindings: {
        initialSubjects: [{
          id: "project_example",
          kind: "project",
        }],
      },
    }),
    node: fixture<NodePreparationRequest["node"]>({
      key: "analyze",
    }),
    operation: fixture<NodePreparationRequest["operation"]>({
      kind: "analysis.faces",
      policy: {
        effect: "local-derived-write",
        maxInputBytes: 1_024,
        preparation: [],
        resources: [],
      },
    }),
    resolvedInput: input,
    runId: "run_example",
  };
}

describe("application node planner", () => {
  test("covers every production verified-receipt operation with reconciliation", () => {
    const registered = [...new Set(createApplicationOperationRegistry().list()
      .filter(operation => operation.policy.resume === "verified-receipt")
      .map(operation => operation.kind))]
      .sort();
    expect(registered).toEqual(
      [...APPLICATION_VERIFIED_RECEIPT_RECONCILER_KINDS].sort(),
    );
  });

  test("routes captioned render plans through the exact v2 host binder", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-caption-binding-",
    ));
    try {
      const projectId = "project_captionbinder";
      const projectSha256 = "1".repeat(64);
      const revisionSha256 = "2".repeat(64);
      const revision = RenderableProjectEditRevisionReferenceSchema.parse({
        artifact: {
          bytes: 1,
          path: `edits/revisions/${"3".repeat(64)}.json`,
          sha256: "3".repeat(64),
        },
        baseGeneration: {
          currentPlanSha256: "4".repeat(64),
          generationSha256: "5".repeat(64),
          projectSha256,
        },
        kind: "atet.project-edit-revision-reference",
        outputGeometrySha256: hashProjectEditRevisionOutputGeometry({
          pixelHeight: 1_920,
          pixelWidth: 1_080,
          revisionSha256,
        }),
        pixelHeight: 1_920,
        pixelWidth: 1_080,
        planId: "plan_captionbinder",
        projectEditPlanSha256: "6".repeat(64),
        projectId,
        projectSha256,
        projectStructureSha256: "7".repeat(64),
        revisionSha256,
        schemaVersion: 1,
      });
      const input = {
        revision,
        settings: {
          captions: {
            analysisId: "analysis_captionbinder",
            placementId: "placement_captionbinder",
          },
        },
      };
      const registry = createApplicationOperationRegistry();
      const operation = registry.get("render.project-plan", 2).discovery;
      const node = {
        dependencies: [],
        executor: {
          kind: "operation" as const,
          operation: { kind: "render.project-plan" as const, version: 2 },
        },
        input,
        inputSchemaId: operation.inputSchemaId,
        key: "captioned-plan",
        outputSchemaId: operation.outputSchemaId,
      };
      const planner = createApplicationNodePlanner(
        operationApplicationContext(repositoryRoot),
      );
      expect(planner.plan(fixture<NodeExecutionPlanningRequest>({
        dependencyOutputs: {},
        graphPlan: {
          graph: { nodes: [node] },
          graphPlanSha256: "8".repeat(64),
          staticBindings: {
            candidates: [],
            initialSubjects: [{
              descriptorSha256: "9".repeat(64),
              id: projectId,
              kind: "project",
              planSha256: revision.baseGeneration.currentPlanSha256,
              projectSha256,
            }],
            version: "atet-static-bindings-v1",
          },
        },
        node,
        operation,
        preparationPlan: {},
        resolvedInput: input,
        runId: "run_captionbinder",
      }))).rejects.toMatchObject({
        code: "not-found",
        message: "The project root does not exist.",
      });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("binds every visual file input and changes diagram cache identity when bytes change", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-visual-binding-",
    ));
    try {
      const fixtureDirectory = join(repositoryRoot, "fixtures");
      await mkdir(fixtureDirectory, { recursive: true });
      const diagramPath = "fixtures/system.diagram.json";
      const rasterPath = "fixtures/sketch.png";
      await Promise.all([
        writeFile(join(repositoryRoot, diagramPath), "diagram-v1"),
        writeFile(join(repositoryRoot, rasterPath), "raster-v1"),
      ]);
      const registry = createApplicationOperationRegistry();
      const planner = createApplicationNodePlanner(
        operationApplicationContext(repositoryRoot),
      );
      const plan = async (
        kind:
          | "atet.diagram.check"
          | "atet.diagram.render"
          | "atet.image.vectorize",
        input: Readonly<Record<string, unknown>>,
        path: string,
      ) => {
        const operation = registry.describe(kind, 1);
        const node = {
          dependencies: [],
          executor: {
            kind: "operation",
            operation: { kind, version: 1 },
          },
          input,
          inputSchemaId: operation.inputSchemaId,
          key: kind.replaceAll(".", "_"),
          outputSchemaId: operation.outputSchemaId,
        };
        return await planner.plan(fixture<NodeExecutionPlanningRequest>({
          dependencyOutputs: {},
          graphPlan: {
            graph: { nodes: [node] },
            graphPlanSha256: "9".repeat(64),
            staticBindings: {
              candidates: [fileCandidateDescriptor({
                id: path,
                kind: "file",
              })],
              initialSubjects: [],
              version: "atet-static-bindings-v1",
            },
          },
          node,
          operation,
          preparationPlan: {},
          resolvedInput: input,
          runId: "run_visual_binding",
        }));
      };

      const checkedV1 = await plan(
        "atet.diagram.check",
        { path: diagramPath },
        diagramPath,
      );
      const rendered = await plan(
        "atet.diagram.render",
        { path: diagramPath, scale: 2 },
        diagramPath,
      );
      const vectorized = await plan(
        "atet.image.vectorize",
        { inputPath: rasterPath },
        rasterPath,
      );
      expect(checkedV1.exactInput).toMatchObject({
        path: {
          bytes: 10,
          path: diagramPath,
          sha256: "5ceb33e9a0620cb5a8b92f80ebdc282d4fa523cfedd7dcefd34ae8cc6247ff8b",
        },
      });
      expect(rendered.exactInput).toMatchObject({
        path: {
          bytes: 10,
          path: diagramPath,
          sha256: "5ceb33e9a0620cb5a8b92f80ebdc282d4fa523cfedd7dcefd34ae8cc6247ff8b",
        },
        scale: 2,
      });
      expect(vectorized.exactInput).toMatchObject({
        inputPath: {
          bytes: 9,
          path: rasterPath,
          sha256: "dbc6c429926f239660331aa5504aec50fbc67a865159cb01c9d36bc54d4f23da",
        },
      });

      await writeFile(join(repositoryRoot, diagramPath), "diagram-v2");
      const checkedV2 = await plan(
        "atet.diagram.check",
        { path: diagramPath },
        diagramPath,
      );
      expect(checkedV2.exactInput).toMatchObject({
        path: {
          bytes: 10,
          path: diagramPath,
          sha256: "1d421654a6ea019548e6c1df304a9e39f3b9b57e6e5fdefbe891e49d8badc6c8",
        },
      });
      expect(checkedV2.exactInput).not.toEqual(checkedV1.exactInput);
      expect(createNodeInputHash(checkedV2.exactInput)).not.toBe(
        createNodeInputHash(checkedV1.exactInput),
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("pins portable v2 sources and serializes their exact output targets", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-portable-binding-",
    ));
    const externalRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-portable-external-",
    ));
    try {
      const fixtureDirectory = join(repositoryRoot, "fixtures");
      await mkdir(fixtureDirectory, { recursive: true });
      const diagramPath = "fixtures/system.diagram.json";
      const rasterPath = "fixtures/sketch.png";
      await Promise.all([
        writeFile(join(repositoryRoot, diagramPath), "diagram-v1"),
        writeFile(join(repositoryRoot, rasterPath), "raster-v1"),
      ]);
      const registry = createApplicationOperationRegistry();
      const boundApplication = operationApplicationContext(repositoryRoot);
      const planner = createApplicationNodePlanner(boundApplication);
      const plan = async (
        kind:
          | "atet.diagram.check"
          | "atet.diagram.render"
          | "atet.image.generate"
          | "atet.image.vectorize",
        input: Readonly<Record<string, unknown>>,
        sourcePath?: string,
      ) => {
        const operation = registry.describe(kind, 2);
        const node = {
          dependencies: [],
          executor: {
            kind: "operation",
            operation: { kind, version: 2 },
          },
          input,
          inputSchemaId: operation.inputSchemaId,
          key: kind.replaceAll(".", "_"),
          outputSchemaId: operation.outputSchemaId,
        };
        return await planner.plan(fixture<NodeExecutionPlanningRequest>({
          dependencyOutputs: {},
          graphPlan: {
            graph: { nodes: [node] },
            graphPlanSha256: "9".repeat(64),
            staticBindings: {
              candidates: sourcePath === undefined
                ? []
                : [fileCandidateDescriptor({
                    id: sourcePath,
                    kind: "file",
                  })],
              initialSubjects: [],
              version: "atet-static-bindings-v1",
            },
          },
          node,
          operation,
          preparationPlan: {},
          resolvedInput: input,
          runId: "run_portable_binding",
        }));
      };

      const checkedV1 = await plan(
        "atet.diagram.check",
        { path: diagramPath },
        diagramPath,
      );
      const checkedV1Input = checkedV1.exactInput as Readonly<{
        path: string;
      }>;
      const physicalPrivateRoot = await realpath(
        boundApplication.paths.privateRoot,
      );
      expect(checkedV1Input.path.startsWith(
        join(physicalPrivateRoot, "portable-operation-inputs/v1"),
      )).toBe(true);
      expect((await lstat(checkedV1Input.path)).mode & 0o777).toBe(0o400);
      expect(await readFile(checkedV1Input.path, "utf8")).toBe("diagram-v1");
      expect(checkedV1.publicationKeys).toEqual([]);

      const externalPath = join(externalRoot, "external.diagram.json");
      await writeFile(externalPath, "external-diagram");
      const checkedExternal = await plan(
        "atet.diagram.check",
        { path: externalPath },
        externalPath,
      );
      const checkedExternalInput = checkedExternal.exactInput as Readonly<{
        path: string;
      }>;
      expect(checkedExternalInput.path.startsWith(
        join(physicalPrivateRoot, "portable-operation-inputs/v1"),
      )).toBe(true);
      expect(await readFile(checkedExternalInput.path, "utf8"))
        .toBe("external-diagram");
      await symlink(externalRoot, join(fixtureDirectory, "external-alias"));
      const escapedRelativeSource = "fixtures/external-alias/external.diagram.json";
      expect(plan(
        "atet.diagram.check",
        { path: escapedRelativeSource },
        escapedRelativeSource,
      )).rejects.toBeInstanceOf(Error);

      const rendered = await plan(
        "atet.diagram.render",
        { path: diagramPath, scale: 2 },
        diagramPath,
      );
      expect(rendered.exactInput).toMatchObject({
        outDirectory: await realpath(fixtureDirectory),
        path: checkedV1Input.path,
        scale: 2,
      });
      expect(rendered.publicationKeys).toHaveLength(1);

      const vectorOutput = "generated/sketch.svg";
      const vectorized = await plan(
        "atet.image.vectorize",
        { inputPath: rasterPath, outputPath: vectorOutput },
        rasterPath,
      );
      const vectorizedInput = vectorized.exactInput as Readonly<{
        inputPath: string;
        outputPath: string;
      }>;
      expect(vectorizedInput.inputPath.startsWith(
        join(physicalPrivateRoot, "portable-operation-inputs/v1"),
      )).toBe(true);
      expect(await readFile(vectorizedInput.inputPath, "utf8")).toBe("raster-v1");
      expect(vectorizedInput.outputPath).toBe(join(
        await realpath(repositoryRoot),
        vectorOutput,
      ));
      expect(vectorized.publicationKeys).toHaveLength(1);
      expect((await plan(
        "atet.image.vectorize",
        { inputPath: rasterPath, outputPath: vectorOutput },
        rasterPath,
      )).publicationKeys).toEqual(vectorized.publicationKeys);
      const lexicalAliasOutput = await plan(
        "atet.image.vectorize",
        {
          inputPath: rasterPath,
          outputPath: join(repositoryRoot, "generated/platform-alias.svg"),
        },
        rasterPath,
      );
      const physicalAliasOutput = await plan(
        "atet.image.vectorize",
        {
          inputPath: rasterPath,
          outputPath: join(
            await realpath(repositoryRoot),
            "generated/platform-alias.svg",
          ),
        },
        rasterPath,
      );
      expect(lexicalAliasOutput.exactInput).toEqual(
        physicalAliasOutput.exactInput,
      );
      expect(lexicalAliasOutput.publicationKeys).toEqual(
        physicalAliasOutput.publicationKeys,
      );

      const generated = await plan("atet.image.generate", {
        model: "openai/gpt-image-1.5",
        outputPath: "generated/example.webp",
        prompt: "A deterministic fixture",
      });
      expect(generated.exactInput).toMatchObject({
        outputPath: join(
          await realpath(repositoryRoot),
          "generated/example.webp",
        ),
      });
      expect(generated.publicationKeys).toHaveLength(1);
      expect(generated.publicationKeys).toEqual(vectorized.publicationKeys);

      const renderCollision = await plan(
        "atet.image.vectorize",
        {
          inputPath: rasterPath,
          outputPath: "fixtures/system.light.svg",
        },
        rasterPath,
      );
      expect(renderCollision.publicationKeys).toEqual(rendered.publicationKeys);

      const physicalOutputDirectory = join(repositoryRoot, "physical-output");
      await mkdir(physicalOutputDirectory);
      await symlink(
        physicalOutputDirectory,
        join(repositoryRoot, "aliased-output"),
      );
      const aliasedOutput = await plan(
        "atet.image.vectorize",
        {
          inputPath: rasterPath,
          outputPath: "aliased-output/sketch.svg",
        },
        rasterPath,
      );
      expect(aliasedOutput.exactInput).toMatchObject({
        outputPath: join(
          await realpath(physicalOutputDirectory),
          "sketch.svg",
        ),
      });
      const physicalOutput = await plan(
        "atet.image.vectorize",
        {
          inputPath: rasterPath,
          outputPath: join(physicalOutputDirectory, "sketch.svg"),
        },
        rasterPath,
      );
      expect(aliasedOutput.publicationKeys).toEqual(
        physicalOutput.publicationKeys,
      );

      const externalOutputPath = join(externalRoot, "escaped.svg");
      await writeFile(externalOutputPath, "old-output");
      await symlink(externalRoot, join(repositoryRoot, "external-output-alias"));
      expect(plan(
        "atet.image.vectorize",
        {
          inputPath: rasterPath,
          outputPath: "external-output-alias/escaped.svg",
        },
        rasterPath,
      )).rejects.toMatchObject({ code: "unsafe-path" });

      await writeFile(join(repositoryRoot, diagramPath), "diagram-v2");
      const checkedV2 = await plan(
        "atet.diagram.check",
        { path: diagramPath },
        diagramPath,
      );
      const checkedV2Input = checkedV2.exactInput as Readonly<{
        path: string;
      }>;
      expect(checkedV2Input.path).not.toBe(checkedV1Input.path);
      expect(createNodeInputHash(checkedV2.exactInput)).not.toBe(
        createNodeInputHash(checkedV1.exactInput),
      );
      expect(await readFile(checkedV1Input.path, "utf8")).toBe("diagram-v1");
      expect(await readFile(checkedV2Input.path, "utf8")).toBe("diagram-v2");

      const symlinkPath = "fixtures/symlink.diagram.json";
      await symlink(join(repositoryRoot, diagramPath), join(repositoryRoot, symlinkPath));
      expect(plan(
        "atet.diagram.check",
        { path: symlinkPath },
        symlinkPath,
      )).rejects.toBeInstanceOf(Error);

      let pinnedExecutions = 0;
      const pinnedRegistry = new OperationRegistry();
      for (const definition of createAtetPortableOperationDefinitions({
        execute: async (_kind, input, dependencies) => {
          pinnedExecutions += 1;
          const pinnedPath = (input as Readonly<{ path: string }>).path;
          expect(pinnedPath.startsWith("/dev/fd/")).toBe(true);
          expect(await readFile(pinnedPath, "utf8")).toBe("diagram-v1");
          expect(dependencies?.inheritedFileDescriptors?.[0]).toBe(
            Number(pinnedPath.slice("/dev/fd/".length)),
          );
          return { configPath: null, findings: [] };
        },
        parseInput: (_kind, input) => input,
      })) pinnedRegistry.register(definition);
      await pinnedRegistry.execute({
        abortSignal: new AbortController().signal,
        application: boundApplication,
      }, {
        input: checkedV1.exactInput,
        kind: "atet.diagram.check",
        version: 2,
      });
      expect(pinnedExecutions).toBe(1);

      let vectorPinObserved = false;
      const vectorPinRegistry = new OperationRegistry();
      for (const definition of createAtetPortableOperationDefinitions({
        execute: async (kind, input, dependencies) => {
          if (kind !== "atet.image.vectorize") {
            throw new Error("Unexpected portable operation.");
          }
          vectorPinObserved = true;
          const pinnedInput = input as Readonly<{ inputPath: string }>;
          expect(pinnedInput.inputPath).toBe("/dev/fd/3");
          const descriptor = dependencies?.inheritedFileDescriptors?.[0];
          expect(typeof descriptor).toBe("number");
          expect(await readFile(`/dev/fd/${String(descriptor)}`, "utf8"))
            .toBe("raster-v1");
          throw new Error("vector-pin-observed");
        },
        parseInput: (_kind, input) => input,
      })) vectorPinRegistry.register(definition);
      expect(vectorPinRegistry.execute({
        abortSignal: new AbortController().signal,
        application: boundApplication,
      }, {
        input: vectorized.exactInput,
        kind: "atet.image.vectorize",
        version: 2,
      })).rejects.toThrow("vector-pin-observed");
      expect(vectorPinObserved).toBe(true);

      const movedPrivateRoot = `${physicalPrivateRoot}.moved`;
      const forgedPrivateRoot = join(externalRoot, "forged-private");
      const forgedSnapshotPath = join(
        forgedPrivateRoot,
        relative(physicalPrivateRoot, checkedV1Input.path),
      );
      await rename(physicalPrivateRoot, movedPrivateRoot);
      try {
        await mkdir(dirname(forgedSnapshotPath), { recursive: true });
        await writeFile(forgedSnapshotPath, "forged-snapshot");
        await chmod(forgedSnapshotPath, 0o400);
        await symlink(
          forgedPrivateRoot,
          boundApplication.paths.privateRoot,
        );
        let rootSwapExecutions = 0;
        const rootSwapRegistry = new OperationRegistry();
        for (const definition of createAtetPortableOperationDefinitions({
          execute: () => {
            rootSwapExecutions += 1;
            return Promise.resolve({ configPath: null, findings: [] });
          },
          parseInput: (_kind, input) => input,
        })) rootSwapRegistry.register(definition);
        let rootSwapError: unknown;
        try {
          await rootSwapRegistry.execute({
            abortSignal: new AbortController().signal,
            application: boundApplication,
          }, {
            input: checkedV1.exactInput,
            kind: "atet.diagram.check",
            version: 2,
          });
        } catch (error) {
          rootSwapError = error;
        }
        expect(rootSwapError).toMatchObject({ code: "conflict" });
        expect(rootSwapExecutions).toBe(0);
      } finally {
        await rm(boundApplication.paths.privateRoot, { force: true });
        await rename(movedPrivateRoot, physicalPrivateRoot);
      }

      const replacedSnapshotPath = `${checkedV2Input.path}.moved`;
      const replacementRegistry = new OperationRegistry();
      for (const definition of createAtetPortableOperationDefinitions({
        execute: async (_kind, input) => {
          const pinnedPath = (input as Readonly<{ path: string }>).path;
          await rename(checkedV2Input.path, replacedSnapshotPath);
          await writeFile(checkedV2Input.path, "replacement");
          expect(await readFile(pinnedPath, "utf8")).toBe("diagram-v2");
          return { configPath: null, findings: [] };
        },
        parseInput: (_kind, input) => input,
      })) replacementRegistry.register(definition);
      expect(replacementRegistry.execute({
        abortSignal: new AbortController().signal,
        application: boundApplication,
      }, {
        input: checkedV2.exactInput,
        kind: "atet.diagram.check",
        version: 2,
      })).rejects.toMatchObject({ code: "ambiguous" });

      await writeFile(join(repositoryRoot, diagramPath), "diagram-v1");
      expect(writeFile(checkedV1Input.path, "ordinary-tamper"))
        .rejects.toMatchObject({ code: "EACCES" });
      await chmod(checkedV1Input.path, 0o600);
      await writeFile(checkedV1Input.path, "tampered");
      let delegatedExecutions = 0;
      const executionRegistry = new OperationRegistry();
      for (const definition of createAtetPortableOperationDefinitions({
        execute: () => {
          delegatedExecutions += 1;
          return Promise.resolve({ configPath: null, findings: [] });
        },
        parseInput: (_kind, input) => input,
      })) executionRegistry.register(definition);
      expect(executionRegistry.execute({
        abortSignal: new AbortController().signal,
        application: boundApplication,
      }, {
        input: checkedV1.exactInput,
        kind: "atet.diagram.check",
        version: 2,
      })).rejects.toMatchObject({ code: "conflict" });
      expect(delegatedExecutions).toBe(0);
      expect(plan(
        "atet.diagram.check",
        { path: diagramPath },
        diagramPath,
      )).rejects.toThrow("destination contains different bytes");
    } finally {
      await Promise.all([
        rm(repositoryRoot, { force: true, recursive: true }),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  test("binds project snapshots to the static plan-time generation", async () => {
    const currentPlanSha256 = "1".repeat(64);
    const projectSha256 = "2".repeat(64);
    const base = request({ project: "project_example" });
    const planner = createApplicationNodePlanner(application);
    const planned = await planner.plan(fixture<NodeExecutionPlanningRequest>({
      ...base,
      graphPlan: {
        ...base.graphPlan,
        staticBindings: {
          candidates: [],
          initialSubjects: [{
            descriptorSha256: "3".repeat(64),
            id: "project_example",
            kind: "project",
            planSha256: currentPlanSha256,
            projectSha256,
          }],
          version: "atet-static-bindings-v1",
        },
      },
      node: {
        dependencies: [],
        executor: {
          kind: "operation",
          operation: { kind: "project.snapshot", version: 1 },
        },
        input: { project: "project_example" },
        inputSchemaId: "atet.operation.project.snapshot.input/v1",
        key: "project",
        outputSchemaId: "atet.operation.project.snapshot.output/v1",
      },
      operation: {
        kind: "project.snapshot",
        policy: {
          effect: "local-read",
          preparation: ["project-state"],
          resources: [],
        },
      },
      preparationPlan: {},
      resolvedInput: { project: "project_example" },
    }));
    expect(planned.expectedProjectGeneration).toBe(
      projectGenerationSha256FromHashes({
        currentPlanSha256,
        projectSha256,
      }),
    );
  });

  test("binds creative candidates to exactly one host-owned frozen snapshot", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-creative-base-",
    ));
    try {
      const fixtureProject = await createOperationProjectFixture(repositoryRoot);
      const boundApplication = operationApplicationContext(repositoryRoot);
      const snapshot = await openProjectSnapshot(
        boundApplication.paths.projectRoot,
        fixtureProject.project.projectId,
      );
      const snapshotOutput = {
        currentPlan: snapshot.plan,
        editBasis: snapshot.editBasis,
        generation: snapshot.generation,
        project: snapshot.project,
      };
      const registry = createApplicationOperationRegistry();
      const snapshotOperation = registry.get("project.snapshot", 1).discovery;
      const candidateOperation = registry.get(
        "edit.create-candidate-revision",
        1,
      ).discovery;
      const projectNode = {
        dependencies: [],
        executor: {
          kind: "operation" as const,
          operation: { kind: "project.snapshot" as const, version: 1 },
        },
        input: { project: fixtureProject.project.projectId },
        inputSchemaId: snapshotOperation.inputSchemaId,
        key: "base",
        outputSchemaId: snapshotOperation.outputSchemaId,
      };
      const input = {
        batch: createEmptyCandidateProjectEditBatchV3(),
        project: fixtureProject.project.projectId,
        snapshot: snapshotOutput,
        variantKey: "baseline",
      };
      const candidateNode = {
        dependencies: ["base"],
        executor: {
          kind: "operation" as const,
          operation: {
            kind: "edit.create-candidate-revision" as const,
            version: 1,
          },
        },
        input,
        inputSchemaId: candidateOperation.inputSchemaId,
        key: "candidate",
        outputSchemaId: candidateOperation.outputSchemaId,
      };
      const dependencyOutputs = {
        base: {
          digestSha256: "1".repeat(64),
          summary: {},
          value: snapshotOutput,
        },
      };
      const planningRequest = fixture<NodeExecutionPlanningRequest>({
        dependencyOutputs,
        graphPlan: {
          graph: { nodes: [projectNode, candidateNode] },
          graphPlanSha256: "2".repeat(64),
          staticBindings: {
            candidates: [],
            initialSubjects: [{
              descriptorSha256: "3".repeat(64),
              id: fixtureProject.project.projectId,
              kind: "project",
              planSha256: snapshot.generation.currentPlanSha256,
              projectSha256: snapshot.generation.projectSha256,
            }],
            version: "atet-static-bindings-v1",
          },
        },
        node: candidateNode,
        operation: candidateOperation,
        preparationPlan: {},
        resolvedInput: input,
        runId: "run_creativebase01",
      });
      const planner = createApplicationNodePlanner(boundApplication);
      const planned = await planner.plan(planningRequest);
      expect(planned.exactInput).toMatchObject({
        base: {
          projectId: fixtureProject.project.projectId,
        },
        candidate: { variantKey: "baseline" },
        project: fixtureProject.project.projectId,
      });
      expect(planned.expectedProjectGeneration).toBeUndefined();
      expect(planned.publicationKeys).toEqual([]);

      const persisted = await planner.plan(fixture<NodeExecutionPlanningRequest>({
        ...planningRequest,
        dependencyOutputs: {},
      }));
      expect(persisted.exactInput).toEqual(planned.exactInput);

      expect(planner.plan(fixture<NodeExecutionPlanningRequest>({
        ...planningRequest,
        dependencyOutputs: {},
        node: {
          ...candidateNode,
          input: {
            ...input,
            snapshot: {
              $ref: {
                nodeKey: "untrusted-compute",
                outputSchemaId: snapshotOperation.outputSchemaId,
                path: [],
                version: 1,
              },
            },
          },
        },
      }))).rejects.toMatchObject({
        code: "authorization-required",
      });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("binds candidate render derivations to the exact host toolchain", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-candidate-render-",
    ));
    try {
      const projectFixture = await createOperationProjectFixture(repositoryRoot);
      const base = creativeBaseIdentityV1(createCreativeBaseV1({
        currentPlan: projectFixture.plan,
        project: projectFixture.project,
      }));
      const candidate = createCreativeCandidateIdentityV1({
        base,
        variantKey: "planner",
      });
      const revisionSha256 = "a".repeat(64);
      const artifactSha256 = "b".repeat(64);
      const candidateRevision = CreativeCandidateRevisionReferenceV1Schema.parse({
        artifact: {
          bytes: 1,
          path: `edits/revisions/${artifactSha256}.json`,
          sha256: artifactSha256,
        },
        base,
        batchSha256: "c".repeat(64),
        bindingsSha256: "d".repeat(64),
        candidate,
        derivationSha256: "e".repeat(64),
        kind: "atet.creative-candidate-revision-reference",
        planId: projectFixture.plan.planId,
        projectEditPlanSha256: base.generation.currentPlanSha256,
        projectId: projectFixture.project.projectId,
        projectSha256: base.generation.projectSha256,
        projectStructureSha256: projectFixture.plan.projectStructureSha256,
        revisionSha256,
        schemaVersion: 1,
        updatedAt: projectFixture.plan.updatedAt,
      });
      const revision = RenderableProjectEditRevisionReferenceSchema.parse({
        artifact: candidateRevision.artifact,
        baseGeneration: base.generation,
        kind: "atet.project-edit-revision-reference",
        outputGeometrySha256: hashProjectEditRevisionOutputGeometry({
          pixelHeight: 540,
          pixelWidth: 960,
          revisionSha256,
        }),
        pixelHeight: 540,
        pixelWidth: 960,
        planId: candidateRevision.planId,
        projectEditPlanSha256: candidateRevision.projectEditPlanSha256,
        projectId: candidateRevision.projectId,
        projectSha256: candidateRevision.projectSha256,
        projectStructureSha256: candidateRevision.projectStructureSha256,
        revisionSha256,
        schemaVersion: 1,
      });
      const planArtifactSha256 = "f".repeat(64);
      const plan = ProjectRenderPlanReferenceSchema.parse({
        artifact: {
          bytes: 1,
          path: `renders/plans/${planArtifactSha256}.json`,
          sha256: planArtifactSha256,
        },
        kind: "atet.project-render-plan-reference",
        outputGeometrySha256: revision.outputGeometrySha256,
        planSha256: canonicalJsonSha256({ kind: "planner-plan" }),
        projectEditPlanSha256: revision.projectEditPlanSha256,
        projectId: revision.projectId,
        projectSha256: revision.projectSha256,
        renderPlanSha256: canonicalJsonSha256({ kind: "planner-render-plan" }),
        revisionSha256,
        schemaVersion: 1,
      });
      const input = {
        candidateRevision,
        maximumBytes: 2 * 1024 * 1024 * 1024,
        plan,
        revision,
        syncPolicy: "require-verified",
        target: {
          canvas: { kind: "profile", profileId: "landscape" },
          tier: "preview",
        },
      } as const;
      const boundApplication = operationApplicationContext(repositoryRoot, {
        capability: name => Promise.resolve({
          available: true,
          command: FIXTURE_EXECUTABLE,
          name,
          version: `${name} planner fixture`,
        }),
      });
      const registry = createApplicationOperationRegistry();
      const operation = registry.get(
        "render.bind-candidate-output",
        1,
      ).discovery;
      const node = {
        dependencies: [],
        executor: {
          kind: "operation" as const,
          operation: {
            kind: "render.bind-candidate-output" as const,
            version: 1,
          },
        },
        input,
        inputSchemaId: operation.inputSchemaId,
        key: "candidate-render-binding",
        outputSchemaId: operation.outputSchemaId,
      };
      const planned = await createApplicationNodePlanner(boundApplication).plan(
        fixture<NodeExecutionPlanningRequest>({
          dependencyOutputs: {},
          graphPlan: {
            graph: { nodes: [node] },
            graphPlanSha256: "1".repeat(64),
            staticBindings: {
              candidates: [],
              initialSubjects: [{
                descriptorSha256: "2".repeat(64),
                id: projectFixture.project.projectId,
                kind: "project",
                planSha256: base.generation.currentPlanSha256,
                projectSha256: base.generation.projectSha256,
              }],
              version: "atet-static-bindings-v1",
            },
          },
          node,
          operation,
          preparationPlan: {},
          resolvedInput: input,
          runId: "run_candidatebinding01",
        }),
      );
      const exact = BindCandidateRenderOutputInputSchema.parse(
        planned.exactInput,
      );
      expect(exact.binding.ffmpeg.executablePath)
        .toBe(FIXTURE_EXECUTABLE);
      expect(exact.binding.ffmpeg.executableSha256)
        .toBe(exact.binding.ffprobe.executableSha256);
      expect(exact.rendererAbi).toBe(ATET_PROJECT_RENDERER_ABI);
      expect(planned.expectedProjectGeneration).toBeUndefined();
      expect(planned.publicationKeys).toEqual([]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("binds v2 metadata commits to the exact recording manifest before hashing the node plan", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-v2-binding-",
    ));
    try {
      const fixtureProject = await createOperationRecordingProjectFixture(
        repositoryRoot,
      );
      const { manifest, project } = fixtureProject;
      const application = operationApplicationContext(repositoryRoot);
      const snapshot = await openProjectSnapshot(
        application.paths.projectRoot,
        project.projectId,
      );
      const batch = deriveProjectEditBatchV2([{
        clicks: {
          color: "#5B8CFF",
          durationUs: 450_000,
          enabled: true,
          radiusPx: 28,
          style: "ring",
        },
        cursor: {
          enabled: true,
          scale: 1.15,
          smoothing: { algorithm: "exponential", strength: 0.42 },
          style: "captured",
        },
        keystrokes: {
          enabled: true,
          holdUs: 900_000,
          maxKeys: 6,
          position: "bottom-center",
          secureText: "hide",
        },
        kind: "set-metadata-effects",
        metadataPlacementId: project.referencePlacementId,
        typedText: { enabled: false },
      }]);
      const input = {
        basis: snapshot.editBasis,
        batch,
        project: project.projectId,
      };
      const registry = createApplicationOperationRegistry();
      const snapshotOperation = registry.get("project.snapshot", 1).discovery;
      const commitOperation = registry.get("project.commit-edits", 2).discovery;
      const projectNode = {
        dependencies: [],
        executor: {
          kind: "operation",
          operation: { kind: "project.snapshot", version: 1 },
        },
        input: { project: project.projectId },
        inputSchemaId: snapshotOperation.inputSchemaId,
        key: "project",
        outputSchemaId: snapshotOperation.outputSchemaId,
      };
      const commitNode = {
        dependencies: ["project"],
        executor: {
          kind: "operation",
          operation: { kind: "project.commit-edits", version: 2 },
        },
        input,
        inputSchemaId: commitOperation.inputSchemaId,
        key: "commit",
        outputSchemaId: commitOperation.outputSchemaId,
      };
      const planner = createApplicationNodePlanner(application);
      const planningRequest = fixture<NodeExecutionPlanningRequest>({
        dependencyOutputs: {
          project: {
            digestSha256: "3".repeat(64),
            summary: {},
            value: {
              currentPlan: snapshot.plan,
              editBasis: snapshot.editBasis,
              generation: snapshot.generation,
              project: snapshot.project,
            },
          },
        },
        graphPlan: {
          graph: { nodes: [projectNode, commitNode] },
          graphPlanSha256: "4".repeat(64),
          staticBindings: {
            candidates: [],
            initialSubjects: [{
              descriptorSha256: "5".repeat(64),
              id: project.projectId,
              kind: "project",
              planSha256: snapshot.generation.currentPlanSha256,
              projectSha256: snapshot.generation.projectSha256,
            }],
            version: "atet-static-bindings-v1",
          },
        },
        node: commitNode,
        operation: commitOperation,
        preparationPlan: {},
        resolvedInput: input,
        runId: "run_v2binding01",
      });
      const prepared = await planner.prepare(planningRequest);
      const planned = await planBehindHeldProjectPublication(
        application,
        project.projectId,
        async () => await planner.plan(planningRequest),
      );
      if (
        !jsonRecord(prepared.inputDescriptors)
        || typeof prepared.inputDescriptors.bytes !== "number"
        || prepared.upperInputBytes === undefined
      ) {
        throw new TypeError("Expected conservative exact-input byte bounds.");
      }
      const exactInputBytes = new TextEncoder().encode(
        canonicalJson(planned.exactInput),
      ).byteLength;
      expect(prepared.upperInputBytes).toBe(
        commitOperation.policy.maxInputBytes,
      );
      expect(exactInputBytes).toBeGreaterThan(
        prepared.inputDescriptors.bytes,
      );
      expect(exactInputBytes).toBeLessThanOrEqual(
        prepared.upperInputBytes,
      );
      expect(planned.exactInput).toMatchObject({
        metadataBinding: {
          placementId: project.referencePlacementId,
          recordingId: manifest.recordingId,
        },
        updatedAt: "2026-07-23T15:01:00.000Z",
      });
      if (!jsonRecord(planned.exactInput)) {
        throw new TypeError("Expected an exact recording metadata binding.");
      }
      const metadataBinding = planned.exactInput.metadataBinding;
      if (metadataBinding === undefined || !jsonRecord(metadataBinding)) {
        throw new TypeError("Expected an exact recording metadata binding.");
      }
      expect(metadataBinding.manifestSha256)
        .toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("binds v3 manual zoom selectors before hashing the node plan", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-v3-zoom-binding-",
    ));
    try {
      const fixtureProject = await createOperationRecordingProjectFixture(
        repositoryRoot,
        { project: recordingLayerProject },
      );
      const { manifest, project } = fixtureProject;
      const boundApplication = operationApplicationContext(repositoryRoot);
      const snapshot = await openProjectSnapshot(
        boundApplication.paths.projectRoot,
        project.projectId,
      );
      const batch = deriveProjectEditBatchV3([{
        kind: "add-manual-zooms",
        zooms: [{
          easing: { kind: "ease-in-out" },
          enterDurationUs: 300_000,
          exitDurationUs: 300_000,
          range: { endUs: 4_000_000, startUs: 2_000_000 },
          scale: 2,
          target: {
            kind: "point",
            point: { x: 960, y: 540 },
          },
          zoomId: ZoomIdSchema.parse("zoom_planner001"),
        }],
      }]);
      const input = {
        basis: snapshot.editBasis,
        batch,
        project: project.projectId,
      };
      const registry = createApplicationOperationRegistry();
      const snapshotOperation = registry.get("project.snapshot", 1).discovery;
      const commitOperation = registry.get("project.commit-edits", 3).discovery;
      const projectNode = {
        dependencies: [],
        executor: {
          kind: "operation",
          operation: { kind: "project.snapshot", version: 1 },
        },
        input: { project: project.projectId },
        inputSchemaId: snapshotOperation.inputSchemaId,
        key: "project",
        outputSchemaId: snapshotOperation.outputSchemaId,
      };
      const commitNode = {
        dependencies: ["project"],
        executor: {
          kind: "operation",
          operation: { kind: "project.commit-edits", version: 3 },
        },
        input,
        inputSchemaId: commitOperation.inputSchemaId,
        key: "commit",
        outputSchemaId: commitOperation.outputSchemaId,
      };
      const planner = createApplicationNodePlanner(boundApplication);
      const planningRequest = fixture<NodeExecutionPlanningRequest>({
        dependencyOutputs: {
          project: {
            digestSha256: "3".repeat(64),
            summary: {},
            value: {
              currentPlan: snapshot.plan,
              editBasis: snapshot.editBasis,
              generation: snapshot.generation,
              project: snapshot.project,
            },
          },
        },
        graphPlan: {
          graph: { nodes: [projectNode, commitNode] },
          graphPlanSha256: "4".repeat(64),
          staticBindings: {
            candidates: [],
            initialSubjects: [{
              descriptorSha256: "5".repeat(64),
              id: project.projectId,
              kind: "project",
              planSha256: snapshot.generation.currentPlanSha256,
              projectSha256: snapshot.generation.projectSha256,
            }],
            version: "atet-static-bindings-v1",
          },
        },
        node: commitNode,
        operation: commitOperation,
        preparationPlan: {},
        resolvedInput: input,
        runId: "run_v3zoombinding01",
      });
      expect(canonicalJson(input)).not.toContain("manifestSha256");
      expect(canonicalJson(input)).not.toContain("syncSha256");
      const planned = await planBehindHeldProjectPublication(
        boundApplication,
        project.projectId,
        async () => await planner.plan(planningRequest),
      );
      expect(planned.exactInput).toMatchObject({
        manualZoomBindings: [{
          displayId: "display-primary",
          placementId: project.referencePlacementId,
          recordingId: manifest.recordingId,
          zoomId: "zoom_planner001",
        }],
        updatedAt: "2026-07-23T15:01:00.000Z",
      });
      const exactInput = CommitProjectEditsInputV3Schema.parse(
        planned.exactInput,
      );
      const binding = exactInput.manualZoomBindings?.[0];
      if (binding === undefined) {
        throw new TypeError("Expected one exact manual zoom binding.");
      }
      expect(binding.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(binding.syncSha256).toMatch(/^[a-f0-9]{64}$/u);
      const reconciliationBase = request(planned.exactInput);
      const nodePlanSha256 = "f".repeat(64);
      const reconciliationRequest = fixture<NodeReconciliationRequest>({
        ...reconciliationBase,
        abortSignal: new AbortController().signal,
        application: boundApplication,
        beforePublication: () => Promise.resolve(),
        executionPlan: {
          exactInput: planned.exactInput,
          nodePlanSha256,
          publicationKeys: [],
        },
        node: commitNode,
        operation: commitOperation,
        previous: {},
        preparationPlan: {},
        resolvedInput: planned.exactInput,
        resumeClass: "recoverable-transaction",
        runId: "run_v3zoombinding01",
      });
      const reconciliation = await planner.reconcile!(
        reconciliationRequest,
      );
      expect(reconciliation).toEqual({ kind: "retry" });
      await registry.execute({
        abortSignal: new AbortController().signal,
        application: boundApplication,
        workflow: {
          beforePublication: () => Promise.resolve(),
          nodeKey: "commit",
          nodePlanSha256,
          runId: "run_v3zoombinding01",
          workspaceDirectory: repositoryRoot,
        },
      }, {
        input: exactInput,
        kind: "project.commit-edits",
        version: 3,
      });
      expect(await planner.reconcile!(reconciliationRequest)).toMatchObject({
        kind: "completed",
        output: {
          projectId: project.projectId,
        },
      });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("reconciles interrupted v2 project commits with the matching exact schema", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-v2-commit-",
    ));
    try {
      const fixtureProject = await createOperationProjectFixture(
        repositoryRoot,
      );
      const boundApplication = operationApplicationContext(repositoryRoot);
      const snapshot = await openProjectSnapshot(
        fixtureProject.projectRoot,
        fixtureProject.project.projectId,
      );
      const batch = deriveProjectEditBatchV2([{
        clicks: { enabled: false },
        cursor: { enabled: false },
        keystrokes: { enabled: false },
        kind: "set-metadata-effects",
        metadataPlacementId: fixtureProject.project.referencePlacementId,
        typedText: { enabled: false },
      }]);
      const exactInput = {
        basis: snapshot.editBasis,
        batch,
        project: fixtureProject.project.projectId,
        updatedAt: "2026-07-23T15:01:00.000Z",
      };
      const registry = createApplicationOperationRegistry();
      const operation = registry.get("project.commit-edits", 2).discovery;
      const base = request(exactInput);
      const planner = createApplicationNodePlanner(boundApplication);
      const reconciliation = await planner.reconcile!(
        fixture<NodeReconciliationRequest>({
          ...base,
          abortSignal: new AbortController().signal,
          application: boundApplication,
          beforePublication: () => Promise.resolve(),
          executionPlan: {
            exactInput,
            nodePlanSha256: "f".repeat(64),
            publicationKeys: [],
          },
          node: {
            dependencies: [],
            executor: {
              kind: "operation",
              operation: { kind: "project.commit-edits", version: 2 },
            },
            input: exactInput,
            inputSchemaId: operation.inputSchemaId,
            key: "commit",
            outputSchemaId: operation.outputSchemaId,
          },
          operation,
          previous: {},
          preparationPlan: {},
          resolvedInput: exactInput,
          resumeClass: "recoverable-transaction",
          runId: "run_v2commit01",
        }),
      );
      expect(reconciliation).toEqual({ kind: "retry" });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("describes inputs by bounded identity rather than copying their contents", async () => {
    const planner = createApplicationNodePlanner(application);
    const prepared = await planner.prepare(request({
      project: "project_example",
      source: "asset:stream",
    }));
    if (!jsonRecord(prepared.inputDescriptors)) {
      throw new TypeError("Expected an object input descriptor.");
    }
    expect(prepared.inputDescriptors.bytes).toBe(53);
    expect(prepared.inputDescriptors.project).toBe("project_example");
    expect(prepared.inputDescriptors.inputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.upperInputBytes).toBe(1_024);
  });

  test("binds deterministic analysis IDs into exact execution inputs", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-node-planner-"));
    try {
      const project = await createOperationProjectFixture(repositoryRoot);
      const boundApplication = operationApplicationContext(repositoryRoot, {
        capabilities: () => Promise.resolve([
          {
            available: true,
            command: FIXTURE_EXECUTABLE,
            name: "face-analyzer",
            version: "face-analyzer fixture",
          },
          {
            available: true,
            command: FIXTURE_EXECUTABLE,
            name: "ffprobe",
            version: "ffprobe fixture",
          },
        ]),
      });
      const planner = createApplicationNodePlanner(boundApplication);
      const base = request({
        project: project.project.projectId,
        source: "asset_operation01:stream_operation01",
      });
      const planning = fixture<NodeExecutionPlanningRequest>({
        ...base,
        graphPlan: {
          ...base.graphPlan,
          staticBindings: {
            candidates: [],
            initialSubjects: [{
              descriptorSha256: "3".repeat(64),
              id: project.project.projectId,
              kind: "project",
              planSha256: "4".repeat(64),
              projectSha256: "5".repeat(64),
            }],
            version: "atet-static-bindings-v1",
          },
        },
        preparationPlan: {},
      });
      const first = await planner.plan(planning);
      const second = await planner.plan(planning);
      expect(first.exactInput).toEqual(second.exactInput);
      if (!jsonRecord(first.exactInput)) {
        throw new TypeError("Expected an object analysis input.");
      }
      expect(first.exactInput.analysisId).toMatch(/^analysis_[a-f0-9]{32}$/u);
      const capabilityBindings = first.exactInput.capabilityBindings;
      if (
        !Array.isArray(capabilityBindings)
        || !capabilityBindings.every(jsonRecord)
      ) {
        throw new TypeError("Expected exact analysis capability bindings.");
      }
      expect(capabilityBindings).toHaveLength(2);
      expect(typeof capabilityBindings[0]?.bytes).toBe("number");
      expect(capabilityBindings[0]?.executablePath).toMatch(/^\//u);
      expect(capabilityBindings[0]?.executableSha256)
        .toMatch(/^[a-f0-9]{64}$/u);
      expect(first.exactInput.projectBinding).toBeDefined();
      expect(first.expectedProjectGeneration).toBeUndefined();
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("does not inject an analysis ID into project auto-zoom input", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-node-planner-auto-zoom-",
    ));
    try {
      const project = await createOperationRecordingProjectFixture(
        repositoryRoot,
      );
      const boundApplication = operationApplicationContext(repositoryRoot);
      const registry = createApplicationOperationRegistry();
      const operation = registry.get(
        "analysis.project-auto-zooms",
        1,
      ).discovery;
      const input = { project: project.project.projectId };
      const base = request(input);
      const planned = await createApplicationNodePlanner(
        boundApplication,
      ).plan(fixture<NodeExecutionPlanningRequest>({
        ...base,
        graphPlan: {
          ...base.graphPlan,
          staticBindings: {
            candidates: [],
            initialSubjects: [{
              descriptorSha256: "3".repeat(64),
              id: project.project.projectId,
              kind: "project",
              planSha256: "4".repeat(64),
              projectSha256: "5".repeat(64),
            }],
            version: "atet-static-bindings-v1",
          },
        },
        node: {
          dependencies: [],
          executor: {
            kind: "operation",
            operation: {
              kind: "analysis.project-auto-zooms",
              version: 1,
            },
          },
          input,
          inputSchemaId: operation.inputSchemaId,
          key: "auto-zooms",
          outputSchemaId: operation.outputSchemaId,
        },
        operation,
        preparationPlan: {},
        resolvedInput: input,
      }));
      if (!jsonRecord(planned.exactInput)) {
        throw new TypeError("Expected an object automatic-zoom input.");
      }
      expect(planned.exactInput.analysisId).toBeUndefined();
      expect(planned.exactInput.binding).toBeDefined();
      expect(planned.exactInput.sourcePlacement)
        .toBe(project.project.referencePlacementId);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects authority-bearing project identities minted by compute output", () => {
    const planner = createApplicationNodePlanner(application);
    const planning = fixture<NodeExecutionPlanningRequest>({
      ...request({
        project: "project_not_bound",
        source: "asset:stream",
      }),
      preparationPlan: {},
    });
    expect(planner.plan(planning)).rejects.toMatchObject({
      code: "authorization-required",
    });
  });

  test("prepares exact Gateway input and reconciles completed or dispatched journals", async () => {
    const reconciliations: GatewayPortReconcile[] = [];
    let reconciliationStatus: "completed" | "dispatched" = "completed";
    const gatewayPort: ApplicationGatewayPort = {
      dispatch: () => Promise.reject(new Error("not executed by planner")),
      prepare: input => Promise.resolve(input.request),
      reconcile: (input) => {
        reconciliations.push(input);
        if (reconciliationStatus === "dispatched") {
          return Promise.resolve({
            operation: input.request.operation,
            requestId: input.requestId,
            status: "dispatched",
          });
        }
        return Promise.resolve({
          operation: "speech",
          requestId: input.requestId,
          result: {
            model: SPEECH_MODEL,
            operation: "speech",
            outputs: [{
              bytes: 5,
              mediaType: "audio/mpeg",
              path: "artifacts/atet/generated/speech.mp3",
              sha256: "b".repeat(64),
            }],
            receipt: {
              bytes: 100,
              path: "artifacts/atet/generated/receipt.json",
              sha256: "c".repeat(64),
            },
            requestId: input.requestId,
          },
          status: "completed",
        });
      },
    };
    const gatewayApplication = { ...application, gatewayPort };
    const planner = createApplicationNodePlanner(gatewayApplication);
    const base = request({
      model: SPEECH_MODEL,
      text: "Narrate the edit",
    });
    const operation = fixture<NodePreparationRequest["operation"]>({
      kind: "gateway.speech",
      policy: {
        effect: "paid-cloud",
        preparation: ["provider-options"],
        resources: [{ amount: 1, resource: "paid-call" }],
      },
    });
    const planning = fixture<NodeExecutionPlanningRequest>({
      ...base,
      node: { key: "narrate" },
      operation,
      preparationPlan: {},
    });
    const exact = await planner.plan(planning);
    expect(exact.exactInput).toEqual({
      model: SPEECH_MODEL,
      text: "Narrate the edit",
    });

    const reconciliationRequest = fixture<NodeReconciliationRequest>({
      ...planning,
      application: gatewayApplication,
      executionPlan: {
        exactInput: exact.exactInput,
        nodePlanSha256: "d".repeat(64),
      },
      previous: {},
      resumeClass: "ambiguous-after-dispatch",
    });
    expect(await planner.reconcile!(reconciliationRequest)).toMatchObject({
      kind: "completed",
      receiptReference: "artifacts/atet/generated/receipt.json",
      summary: {
        bytes: 5,
        model: SPEECH_MODEL,
        outputs: 1,
        receipt: "artifacts/atet/generated/receipt.json",
      },
    });
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]?.requestId).toMatch(/^gateway_[a-f0-9]{64}$/u);

    reconciliationStatus = "dispatched";
    const ambiguous = await planner.reconcile!(reconciliationRequest);
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind !== "ambiguous") {
      throw new Error("Expected dispatched Gateway ambiguity.");
    }
    expect(ambiguous.message).toContain("will not resubmit");
  });

  test("never treats ambient recording state as an exact live-action receipt", async () => {
    const recordingApplication: ApplicationContext = {
      ...application,
      recordingController: {
        execute: () => Promise.reject(new Error("Reconciliation must not dispatch.")),
        status: () => Promise.resolve({
          completedSegmentCount: 0,
          effectiveConfig: {
            camera: { kind: "default" },
            displays: { kind: "all" },
            metadata: true,
            microphone: { kind: "default" },
            strictInputs: true,
            systemAudio: true,
            typedText: false,
          },
          logicalTimeUs: 1_000_000,
          permissions: {
            accessibility: "authorized",
            camera: "authorized",
            inputMonitoring: "authorized",
            microphone: "authorized",
            screenCapture: "authorized",
            systemAudio: "authorized",
            windowMetadata: "authorized",
          },
          recordingId: "rec_unrelated01",
          recordingRoot: "/tmp/unrelated",
          state: "recording",
          updatedAt: "2026-07-23T00:00:00.000Z",
        }),
      },
    };
    const planner = createApplicationNodePlanner(recordingApplication);
    const reconciliation = await planner.reconcile!(fixture<NodeReconciliationRequest>({
      ...request({
        camera: { kind: "default" },
        displays: { kind: "all" },
        microphone: { kind: "default" },
        strictInputs: true,
        systemAudio: true,
        typedText: false,
      }),
      application: recordingApplication,
      node: fixture<NodeReconciliationRequest["node"]>({
        key: "recording-start",
      }),
      operation: fixture<NodeReconciliationRequest["operation"]>({
        kind: "recording.start",
        policy: {
          effect: "live-control",
          preparation: [],
          resources: [{ amount: 1, resource: "capture-device" }],
        },
      }),
      previous: {},
      resumeClass: "non-resumable-live",
    }));
    expect(reconciliation).toMatchObject({ kind: "ambiguous" });
    if (reconciliation.kind !== "ambiguous") {
      throw new TypeError("Expected live reconciliation ambiguity.");
    }
    expect(reconciliation.message).toContain("not an exact receipt");
    expect(reconciliation.message).toContain("rec_unrelated01");
  });
});
