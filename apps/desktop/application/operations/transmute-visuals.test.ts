import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type {
  VectorizeOptions,
  VectorizeReceipt,
  VectorizeResult,
} from "@hraness/transmute";
import {
  createProcessLocalHostResourceCoordinator,
  type HostResourceCoordinator,
} from "@hraness/transmute/host-resources";

import type { OperationExecutionContext } from "../operation";
import { writeOperationCompletionCheckpoint } from "../operation-completion-checkpoint";
import { OperationRegistry } from "../registry";
import { reconcileLocalVerifiedReceiptOperation } from "../verified-receipt-reconciliation";
import { canonicalJsonSha256 } from "../../core/canonical-json";
import { operationApplicationContext } from "./test-support";
import { MediaIngestInputSchema } from "./media/ingest";
import { MediaOverlayInputSchema } from "./media/overlay";
import {
  createMediaOperationWorkspace,
  publishContentAddressedReceipt,
} from "./media/shared";
import {
  BoundTransmuteDiagramRenderInputSchema,
  BoundTransmuteImageVectorizeInputSchema,
  TransmuteDiagramCheckInputSchema,
  TransmuteDiagramCheckOutputSchema,
  TransmuteDiagramRenderInputSchema,
  TransmuteDiagramRenderOutputSchema,
  TransmuteImageVectorizeInputSchema,
  TransmuteImageVectorizeOutputSchema,
  TransmuteImageVectorizeReceiptSchema,
  bindTransmuteVisualOperationInput,
  createTransmuteDiagramCheckOperationDefinition,
  createTransmuteDiagramRenderOperationDefinition,
  createTransmuteImageVectorizeOperationDefinition,
} from "./transmute-visuals";

const roots: string[] = [];
const RASTER_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const DIAGRAM_SOURCE = '{"version":1,"name":"system","canvas":{"width":10,"height":10},"shapes":[],"edges":[]}\n';
const VECTOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function vectorizeFixture(
  options: VectorizeOptions,
  overrides: Partial<Pick<
    VectorizeReceipt,
    "alphaCutoff" | "bytes" | "inputBytes" | "outputMode" | "sourceSha256" | "svgSha256"
  >> = {},
): Promise<VectorizeResult> {
  if (options.outputPath === undefined) throw new Error("Expected staged output path.");
  await writeFile(options.outputPath, VECTOR_SVG);
  return {
    outputPath: options.outputPath,
    receipt: {
      alphaCutoff: 8,
      bytes: Buffer.byteLength(VECTOR_SVG),
      candidatesEvaluated: 1,
      format: "png",
      height: 1,
      inputBytes: RASTER_BYTES.byteLength,
      outputMode: "color",
      pathCount: 1,
      profile: "balanced",
      provenance: {
        arch: process.arch,
        platform: process.platform,
        sharp: "0.34.4",
        sharpVersions: { sharp: "0.34.4" },
        vips: "8.17.2",
        vtracerSha256: "a".repeat(64),
        vtracerSource: "official-release",
        vtracerVersion: "0.6.4",
      },
      quality: {
        alphaRmse: 0,
        colorRmse: 0,
        outsideAlphaRatio: 0,
        sampleHeight: 1,
        sampleWidth: 1,
        supportRecall: 1,
      },
      receiptVersion: 1,
      representation: "color-paths",
      sourceSha256: sha256(RASTER_BYTES),
      svgSha256: sha256(VECTOR_SVG),
      width: 1,
      ...overrides,
    },
    svg: VECTOR_SVG,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    await rm(root, { force: true, recursive: true });
  }));
});

async function fixture(): Promise<Readonly<{
  context: OperationExecutionContext;
  diagramPath: string;
  rasterPath: string;
  root: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), "transmute-visual-operation-"));
  roots.push(root);
  const inputDirectory = join(root, "scraps");
  await mkdir(inputDirectory, { recursive: true });
  const diagramPath = join(inputDirectory, "system.diagram.json");
  const rasterPath = join(inputDirectory, "sketch.png");
  await Promise.all([
    writeFile(diagramPath, DIAGRAM_SOURCE),
    writeFile(rasterPath, RASTER_BYTES),
  ]);
  return {
    context: {
      abortSignal: new AbortController().signal,
      application: operationApplicationContext(root),
    },
    diagramPath: relative(root, diagramPath),
    rasterPath: relative(root, rasterPath),
    root,
  };
}

async function recoveryContext(
  context: OperationExecutionContext,
  nodeKey: string,
): Promise<OperationExecutionContext & {
  readonly workflow: NonNullable<OperationExecutionContext["workflow"]>;
}> {
  const workspaceDirectory = join(
    context.application.paths.privateRoot,
    "workflow-runs",
    nodeKey,
  );
  await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  return {
    ...context,
    workflow: {
      beforePublication: () => Promise.resolve(),
      nodeKey,
      nodePlanSha256: sha256(nodeKey),
      runId: `run_${nodeKey}`,
      workspaceDirectory,
    },
  };
}

describe("unified Transmute visual operations", () => {
  test("reuses one capacity-one scheduler lease for default diagram operations", async () => {
    const testFixture = await fixture();
    const processCoordinator = createProcessLocalHostResourceCoordinator({
      profile: {
        capacities: [
          { limit: 1, resource: "cpu" },
          { limit: 1, resource: "local-io" },
        ],
        id: `transmute.visual-operation-test/${sha256(testFixture.root).slice(0, 16)}`,
      },
      waitTimeoutMilliseconds: 100,
    });
    let admissions = 0;
    const coordinator: HostResourceCoordinator = {
      profile: processCoordinator.profile,
      scope: processCoordinator.scope,
      withLease: async (claims, callback, options) => {
        admissions += 1;
        return await processCoordinator.withLease(claims, callback, options);
      },
    };
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramCheckOperationDefinition({
      hostResourceCoordinator: coordinator,
    }));
    registry.register(createTransmuteDiagramRenderOperationDefinition({
      hostResourceCoordinator: coordinator,
    }));
    const execute = async (
      kind: "transmute.diagram.check" | "transmute.diagram.render",
    ) => await coordinator.withLease([
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ], async lease => await registry.execute({
      ...testFixture.context,
      application: {
        ...testFixture.context.application,
        hostResourceLease: {
          assertOwned: async () => await lease.assertOwned(),
          claims: lease.claims,
          inheritedFileDescriptor: lease.inheritedFileDescriptor,
          inheritedFileDescriptors: [lease.inheritedFileDescriptor],
          profile: lease.profile,
          ticket: lease.ticket,
        },
      },
    }, {
      input: { path: testFixture.diagramPath },
      kind,
      version: 1,
    }), { waitTimeoutMilliseconds: 100 });

    expect((await execute("transmute.diagram.check")).summary.kind)
      .toBe("transmute.diagram.check");
    expect((await execute("transmute.diagram.render")).summary.kind)
      .toBe("transmute.diagram.render");
    expect(admissions).toBe(2);
  });

  test("accepts progressive paths and exact byte claims for every visual file input", () => {
    const exact = {
      bytes: 4,
      path: "scraps/input.bin",
      sha256: "a".repeat(64),
    };
    expect(TransmuteDiagramCheckInputSchema.parse({ path: exact }).path)
      .toEqual(exact);
    expect(TransmuteDiagramRenderInputSchema.parse({ path: "scraps/diagram.json" }))
      .toEqual({ path: "scraps/diagram.json" });
    expect(TransmuteImageVectorizeInputSchema.parse({ inputPath: exact }).inputPath)
      .toEqual(exact);
    expect(TransmuteDiagramRenderInputSchema.safeParse({
      path: { bytes: 4, path: exact.path, sha256: "short" },
    }).success).toBe(false);
  });

  test("rejects an integrity-bound diagram when its bytes change before execution", async () => {
    const testFixture = await fixture();
    const exactInput = await bindTransmuteVisualOperationInput(
      testFixture.context.application,
      "transmute.diagram.check",
      { path: testFixture.diagramPath },
      testFixture.context.abortSignal,
    );
    await writeFile(
      join(testFixture.root, testFixture.diagramPath),
      '{"version":1,"name":"changed","canvas":{"width":10,"height":10},"shapes":[],"edges":[]}\n',
    );
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramCheckOperationDefinition({
      checkDiagram: () => Promise.resolve({ findings: [] }),
    }));

    expect(registry.execute(testFixture.context, {
      input: exactInput,
      kind: "transmute.diagram.check",
      version: 1,
    })).rejects.toThrow(
      "Media no longer matches its integrity-bound workflow input.",
    );
  });

  test("checks an immutable diagram snapshot across a concurrent source edit", async () => {
    const testFixture = await fixture();
    const sourcePath = join(testFixture.root, testFixture.diagramPath);
    let checkedPath: string | undefined;
    let checkedSource: string | undefined;
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramCheckOperationDefinition({
      checkDiagram: async path => {
        checkedPath = path;
        try {
          await writeFile(
            sourcePath,
            '{"version":1,"name":"replacement","canvas":{"width":10,"height":10},"shapes":[],"edges":[]}\n',
          );
          checkedSource = await readFile(path, "utf8");
        } finally {
          await writeFile(sourcePath, DIAGRAM_SOURCE);
        }
        return { findings: [] };
      },
    }));

    const output = TransmuteDiagramCheckOutputSchema.parse((await registry.execute(
      testFixture.context,
      {
        input: { path: testFixture.diagramPath },
        kind: "transmute.diagram.check",
        version: 1,
      },
    )).output);

    expect(checkedPath).not.toBe(sourcePath);
    expect(checkedSource).toBe(DIAGRAM_SOURCE);
    expect(output.source.sha256).toBe(sha256(DIAGRAM_SOURCE));
  });

  test("renders an immutable diagram snapshot across a concurrent source edit", async () => {
    const testFixture = await fixture();
    const sourcePath = join(testFixture.root, testFixture.diagramPath);
    let renderedSource: string | undefined;
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramRenderOperationDefinition({
      renderDiagram: async input => {
        try {
          await writeFile(
            sourcePath,
            '{"version":1,"name":"replacement","canvas":{"width":10,"height":10},"shapes":[],"edges":[]}\n',
          );
          renderedSource = await readFile(input.path, "utf8");
        } finally {
          await writeFile(sourcePath, DIAGRAM_SOURCE);
        }
        await mkdir(input.outDirectory, { recursive: true });
        const artifacts = {
          darkPng: join(input.outDirectory, "system.dark.png"),
          darkSvg: join(input.outDirectory, "system.dark.svg"),
          lightPng: join(input.outDirectory, "system.light.png"),
          lightSvg: join(input.outDirectory, "system.light.svg"),
          spec: input.path,
          tldr: join(input.outDirectory, "system.tldr"),
        };
        await Promise.all([
          writeFile(artifacts.darkPng, "dark png snapshot"),
          writeFile(artifacts.darkSvg, "<svg>dark snapshot</svg>"),
          writeFile(artifacts.lightPng, "light png snapshot"),
          writeFile(artifacts.lightSvg, "<svg>light snapshot</svg>"),
          writeFile(artifacts.tldr, '{"records":["snapshot"]}\n'),
        ]);
        return { artifacts, findings: [] };
      },
    }));

    const output = TransmuteDiagramRenderOutputSchema.parse((await registry.execute(
      testFixture.context,
      {
        input: { path: testFixture.diagramPath },
        kind: "transmute.diagram.render",
        version: 1,
      },
    )).output);

    expect(renderedSource).toBe(DIAGRAM_SOURCE);
    expect(output.source.sha256).toBe(sha256(DIAGRAM_SOURCE));
    expect(await readFile(
      join(testFixture.root, output.artifacts.darkSvg.path),
      "utf8",
    )).toBe("<svg>dark snapshot</svg>");
  });

  test("rejects diagram publication when the bound source remains edited", async () => {
    const testFixture = await fixture();
    const sourcePath = join(testFixture.root, testFixture.diagramPath);
    let renderedSource: string | undefined;
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramRenderOperationDefinition({
      renderDiagram: async input => {
        await writeFile(
          sourcePath,
          '{"version":1,"name":"replacement","canvas":{"width":10,"height":10},"shapes":[],"edges":[]}\n',
        );
        renderedSource = await readFile(input.path, "utf8");
        await mkdir(input.outDirectory, { recursive: true });
        const artifacts = {
          darkPng: join(input.outDirectory, "system.dark.png"),
          darkSvg: join(input.outDirectory, "system.dark.svg"),
          lightPng: join(input.outDirectory, "system.light.png"),
          lightSvg: join(input.outDirectory, "system.light.svg"),
          spec: input.path,
          tldr: join(input.outDirectory, "system.tldr"),
        };
        await Promise.all([
          writeFile(artifacts.darkPng, "dark png unpublished"),
          writeFile(artifacts.darkSvg, "<svg>dark unpublished</svg>"),
          writeFile(artifacts.lightPng, "light png unpublished"),
          writeFile(artifacts.lightSvg, "<svg>light unpublished</svg>"),
          writeFile(artifacts.tldr, '{"records":["unpublished"]}\n'),
        ]);
        return { artifacts, findings: [] };
      },
    }));

    const error = await registry.execute(testFixture.context, {
      input: { path: testFixture.diagramPath },
      kind: "transmute.diagram.render",
      version: 1,
    }).catch((caught: unknown) => caught);
    expect(String(error)).toContain(
      "Media no longer matches its integrity-bound workflow input.",
    );
    expect(renderedSource).toBe(DIAGRAM_SOURCE);
  });

  test("checks a portable diagram through its integrity-bound application input", async () => {
    const testFixture = await fixture();
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramCheckOperationDefinition({
      checkDiagram: () => Promise.resolve({
        findings: [{ code: "empty", message: "Diagram is intentionally empty.", shapeIds: [] }],
      }),
    }));

    const result = await registry.execute(testFixture.context, {
      input: { path: testFixture.diagramPath },
      kind: "transmute.diagram.check",
      version: 1,
    });

    expect(result.summary.kind).toBe("transmute.diagram.check");
    expect(result.output).toMatchObject({
      findings: [{ code: "empty" }],
      source: { path: testFixture.diagramPath },
    });
  });

  test("publishes every diagram derivative by content hash and exposes composable media references", async () => {
    const testFixture = await fixture();
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramRenderOperationDefinition({
      renderDiagram: async input => {
        await mkdir(input.outDirectory, { recursive: true });
        const artifacts = {
          darkPng: join(input.outDirectory, "system.dark.png"),
          darkSvg: join(input.outDirectory, "system.dark.svg"),
          lightPng: join(input.outDirectory, "system.light.png"),
          lightSvg: join(input.outDirectory, "system.light.svg"),
          spec: input.path,
          tldr: join(input.outDirectory, "system.tldr"),
        };
        await Promise.all([
          writeFile(artifacts.darkPng, "dark png"),
          writeFile(artifacts.darkSvg, "<svg>dark</svg>"),
          writeFile(artifacts.lightPng, "light png"),
          writeFile(artifacts.lightSvg, "<svg>light</svg>"),
          writeFile(artifacts.tldr, '{"records":[]}\n'),
        ]);
        return { artifacts, findings: [] };
      },
    }));

    const result = await registry.execute(testFixture.context, {
      input: { path: testFixture.diagramPath, scale: 2 },
      kind: "transmute.diagram.render",
      version: 1,
    });
    const output = TransmuteDiagramRenderOutputSchema.parse(result.output);

    expect(Object.values(output.artifacts).every(artifact => (
      artifact.path.startsWith("artifacts/transmute/generated/media-operations/outputs/")
    ))).toBe(true);
    expect(output.receipt.path).toStartWith(
      "artifacts/transmute/generated/media-operations/receipts/",
    );
    expect(MediaIngestInputSchema.parse({
      project: "project_visual01",
      role: "b-roll",
      source: output.artifacts.lightPng,
    }).source).toEqual(output.artifacts.lightPng);
    expect(MediaOverlayInputSchema.parse({
      layout: {},
      project: "project_visual01",
      range: { endUs: 2_000_000, startUs: 0 },
      source: { artifact: output.artifacts.darkSvg, kind: "svg" },
    }).source).toMatchObject({ artifact: output.artifacts.darkSvg, kind: "svg" });
  });

  test("recovers diagram renders only while the exact receipt and every output remain intact", async () => {
    const testFixture = await fixture();
    const context = await recoveryContext(
      testFixture.context,
      "diagram_recovery",
    );
    const registry = new OperationRegistry();
    registry.register(createTransmuteDiagramRenderOperationDefinition({
      renderDiagram: async input => {
        await mkdir(input.outDirectory, { recursive: true });
        const artifacts = {
          darkPng: join(input.outDirectory, "system.dark.png"),
          darkSvg: join(input.outDirectory, "system.dark.svg"),
          lightPng: join(input.outDirectory, "system.light.png"),
          lightSvg: join(input.outDirectory, "system.light.svg"),
          spec: input.path,
          tldr: join(input.outDirectory, "system.tldr"),
        };
        await Promise.all([
          writeFile(artifacts.darkPng, "dark png recovery"),
          writeFile(artifacts.darkSvg, "<svg>dark recovery</svg>"),
          writeFile(artifacts.lightPng, "light png recovery"),
          writeFile(artifacts.lightSvg, "<svg>light recovery</svg>"),
          writeFile(artifacts.tldr, '{"records":["recovery"]}\n'),
        ]);
        return {
          artifacts,
          findings: [{
            code: "fixture",
            message: "Recovery fixture.",
            shapeIds: [],
          }],
        };
      },
    }));
    const exactInput = BoundTransmuteDiagramRenderInputSchema.parse(
      await bindTransmuteVisualOperationInput(
        context.application,
        "transmute.diagram.render",
        { path: testFixture.diagramPath, scale: 2 },
        context.abortSignal,
      ),
    );
    const output = TransmuteDiagramRenderOutputSchema.parse((await registry.execute(
      context,
      {
        input: exactInput,
        kind: "transmute.diagram.render",
        version: 1,
      },
    )).output);
    const request = {
      abortSignal: new AbortController().signal,
      beforePublication: () => Promise.resolve(),
      exactInput,
      identity: {
        inputSchemaId: "transmute.operation.diagram.render.input/v1",
        kind: "transmute.diagram.render" as const,
        nodeKey: context.workflow.nodeKey,
        nodePlanSha256: context.workflow.nodePlanSha256,
        outputSchemaId: "transmute.operation.diagram.render.output/v1",
        runId: context.workflow.runId,
        version: 1,
      },
      workspaceDirectory: context.workflow.workspaceDirectory,
    };

    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      request,
    )).toMatchObject({
      kind: "completed",
      receiptReference: output.receipt.path,
    });
    const sourcePath = join(testFixture.root, testFixture.diagramPath);
    const originalSource = await readFile(sourcePath);
    await writeFile(sourcePath, "changed diagram source");
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      request,
    )).toMatchObject({ kind: "incompatible" });
    await writeFile(sourcePath, originalSource);

    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      { ...request, exactInput: { ...exactInput, scale: 3 } },
    )).toMatchObject({ kind: "incompatible" });

    const artifactPath = join(context.application.paths.repositoryRoot, output.artifacts.darkPng.path);
    const original = await readFile(artifactPath);
    await writeFile(artifactPath, "tampered diagram output");
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      request,
    )).toMatchObject({ kind: "incompatible" });

    await writeFile(artifactPath, original);
    await rm(artifactPath);
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      request,
    )).toMatchObject({ kind: "incompatible" });
  });

  test("publishes a locally vectorized SVG and its exact quality receipt", async () => {
    const testFixture = await fixture();
    const registry = new OperationRegistry();
    let leaseChecks = 0;
    let inheritedFileDescriptors: readonly number[] | undefined;
    registry.register(createTransmuteImageVectorizeOperationDefinition({
      vectorize: async (_path: string, options: VectorizeOptions) => {
        inheritedFileDescriptors = options.inheritedFileDescriptors;
        return await vectorizeFixture(options);
      },
    }));

    const result = await registry.execute({
      ...testFixture.context,
      application: {
        ...testFixture.context.application,
        hostResourceLease: {
          assertOwned: () => {
            leaseChecks += 1;
            return Promise.resolve();
          },
          inheritedFileDescriptor: 42,
          claims: [{ amount: 1, resource: "cpu" }],
          inheritedFileDescriptors: [42],
          profile: {
            capacities: [],
            id: "transmute-visuals-test",
          },
          ticket: "transmute-visuals-test-ticket",
        },
      },
    }, {
      input: { inputPath: testFixture.rasterPath },
      kind: "transmute.image.vectorize",
      version: 1,
    });
    const output = TransmuteImageVectorizeOutputSchema.parse(result.output);

    expect(leaseChecks).toBe(1);
    expect(inheritedFileDescriptors).toEqual([42]);
    expect(output.artifact.path).toMatch(
      /^artifacts\/transmute\/generated\/media-operations\/outputs\/[a-f0-9]{64}\.svg$/u,
    );
    expect(output.vectorizer).toMatchObject({ pathCount: 1, receiptVersion: 1 });
    expect(MediaOverlayInputSchema.parse({
      layout: {},
      project: "project_visual01",
      range: { endUs: 2_000_000, startUs: 0 },
      source: { artifact: output.artifact, kind: "svg" },
    }).source).toMatchObject({ artifact: output.artifact, kind: "svg" });
  });

  test("recovers adaptive alpha selection only while exact input, receipt, and SVG agree", async () => {
    const testFixture = await fixture();
    const context = await recoveryContext(
      testFixture.context,
      "vectorize_recovery",
    );
    const registry = new OperationRegistry();
    registry.register(createTransmuteImageVectorizeOperationDefinition({
      vectorize: async (_path, options) => await vectorizeFixture(
        options,
        { alphaCutoff: 1 },
      ),
    }));
    const exactInput = BoundTransmuteImageVectorizeInputSchema.parse(
      await bindTransmuteVisualOperationInput(
        context.application,
        "transmute.image.vectorize",
        { alphaCutoff: 8, inputPath: testFixture.rasterPath },
        context.abortSignal,
      ),
    );
    const output = TransmuteImageVectorizeOutputSchema.parse((await registry.execute(
      context,
      {
        input: exactInput,
        kind: "transmute.image.vectorize",
        version: 1,
      },
    )).output);
    expect(output.vectorizer.alphaCutoff).toBe(1);
    const request = {
      abortSignal: new AbortController().signal,
      beforePublication: () => Promise.resolve(),
      exactInput,
      identity: {
        inputSchemaId: "transmute.operation.image.vectorize.input/v1",
        kind: "transmute.image.vectorize" as const,
        nodeKey: context.workflow.nodeKey,
        nodePlanSha256: context.workflow.nodePlanSha256,
        outputSchemaId: "transmute.operation.image.vectorize.output/v1",
        runId: context.workflow.runId,
        version: 1,
      },
      workspaceDirectory: context.workflow.workspaceDirectory,
    };

    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      request,
    )).toMatchObject({
      kind: "completed",
      receiptReference: output.receipt.path,
    });
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      {
        ...request,
        exactInput: { ...exactInput, duotone: ["#111", "#eee"] },
      },
    )).toMatchObject({ kind: "incompatible" });

    for (const [index, vectorizer] of [
      { ...output.vectorizer, inputBytes: output.source.bytes + 1 },
      { ...output.vectorizer, outputMode: "duotone" as const },
    ].entries()) {
      const mismatchContext = await recoveryContext(
        testFixture.context,
        `vectorize_evidence_${String(index)}`,
      );
      const workspace = await createMediaOperationWorkspace(mismatchContext);
      const receipt = await publishContentAddressedReceipt({
        context: mismatchContext,
        receipt: TransmuteImageVectorizeReceiptSchema.parse({
          artifact: output.artifact,
          createdAt: mismatchContext.application.clock.now().toISOString(),
          exactInputSha256: canonicalJsonSha256(exactInput),
          kind: "transmute.visual-artifact-receipt",
          operation: "transmute.image.vectorize",
          schemaVersion: 1,
          source: output.source,
          vectorizer,
        }),
        workspace,
      });
      const mismatchedOutput = TransmuteImageVectorizeOutputSchema.parse({
        ...output,
        receipt,
        vectorizer,
      });
      await writeOperationCompletionCheckpoint(mismatchContext, {
        inputSchemaId: "transmute.operation.image.vectorize.input/v1",
        kind: "transmute.image.vectorize",
        outputSchemaId: "transmute.operation.image.vectorize.output/v1",
        version: 1,
      }, mismatchedOutput);
      expect(await reconcileLocalVerifiedReceiptOperation(
        mismatchContext.application,
        {
          ...request,
          identity: {
            ...request.identity,
            nodeKey: mismatchContext.workflow.nodeKey,
            nodePlanSha256: mismatchContext.workflow.nodePlanSha256,
            runId: mismatchContext.workflow.runId,
          },
          workspaceDirectory: mismatchContext.workflow.workspaceDirectory,
        },
      )).toMatchObject({ kind: "incompatible" });
    }

    const artifactPath = join(context.application.paths.repositoryRoot, output.artifact.path);
    const original = await readFile(artifactPath);
    await writeFile(artifactPath, "tampered vector output");
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      request,
    )).toMatchObject({ kind: "incompatible" });

    await writeFile(artifactPath, original);
    await rm(artifactPath);
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      request,
    )).toMatchObject({ kind: "incompatible" });
  });

  test("rejects vectorizer receipts that do not bind the source and staged SVG", async () => {
    const cases = [
      {
        expected: "source hash",
        overrides: { sourceSha256: "d".repeat(64) },
      },
      {
        expected: "source hash or byte length",
        overrides: { inputBytes: RASTER_BYTES.byteLength + 1 },
      },
      {
        expected: "output mode",
        overrides: { outputMode: "duotone" },
      },
      {
        expected: "SVG hash or byte length",
        overrides: { svgSha256: "e".repeat(64) },
      },
      {
        expected: "SVG hash or byte length",
        overrides: { bytes: Buffer.byteLength(VECTOR_SVG) + 1 },
      },
    ] as const;
    for (const testCase of cases) {
      const testFixture = await fixture();
      const registry = new OperationRegistry();
      registry.register(createTransmuteImageVectorizeOperationDefinition({
        vectorize: async (_path, options) =>
          await vectorizeFixture(options, testCase.overrides),
      }));
      const error = await registry.execute(testFixture.context, {
        input: { inputPath: testFixture.rasterPath },
        kind: "transmute.image.vectorize",
        version: 1,
      }).catch((caught: unknown) => caught);
      expect(String(error)).toContain(testCase.expected);
    }
  });
});
