import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { canonicalJsonSha256 } from "../../../core";
import {
  createHtmlOverlayScaffold,
  getApprovedHtmlOverlayLibraryLock,
  htmlOverlayFrameCount,
  type HtmlOverlayLibraryLock,
} from "../../../html-overlay";
import { PlaywrightHtmlOverlayRenderer } from "../../../cli/html-overlay-renderer";
import { BunProcessRunner } from "../../../cli/io";
import { createHtmlOverlayExecutionBundle } from "../../html-overlay-integrity";
import { bindHtmlOverlayBrowserRuntime } from "../../html-overlay-browser-runtime";
import type { ApplicationCapability } from "../../context";
import type { OperationExecutionContext } from "../../operation";
import { OPERATION_COMPLETION_CHECKPOINT_FILE } from "../../operation-completion-checkpoint";
import { openProjectSnapshot } from "../../project-store";
import { OperationRegistry } from "../../registry";
import { reconcileLocalVerifiedReceiptOperation } from "../../verified-receipt-reconciliation";
import {
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  BoundHtmlOverlayInputSchema,
  HtmlOverlayOutputSchema,
  HtmlOverlayReceiptSchema,
  bindHtmlOverlayInput,
  createHtmlOverlayOperationDefinition,
} from "./html-overlay";

const roots: string[] = [];
const EXECUTABLE = Bun.which("true") ?? "/usr/bin/true";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = Bun.which("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = Bun.which("ffprobe") ?? "/opt/homebrew/bin/ffprobe";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixtureCapabilities(
  root: string,
): Promise<readonly ApplicationCapability[]> {
  const browser = join(
    root,
    "Fixture Browser.app",
    "Contents",
    "MacOS",
    "Fixture Browser",
  );
  await mkdir(join(browser, ".."), { mode: 0o755, recursive: true });
  if (!existsSync(browser)) {
    await copyFile(EXECUTABLE, browser);
    await chmod(browser, 0o755);
  }
  return [
    {
      available: true,
      command: browser,
      name: "ffmpeg",
      version: "ffmpeg fixture",
    },
    {
      available: true,
      command: EXECUTABLE,
      name: "ffprobe",
      version: "ffprobe fixture",
    },
    {
      available: true,
      command: EXECUTABLE,
      name: "html-browser",
      version: "browser fixture",
    },
  ];
}

async function bindFixtureBrowserRuntime(
  ...args: Parameters<typeof bindHtmlOverlayBrowserRuntime>
) {
  return await bindHtmlOverlayBrowserRuntime(
    args[0],
    args[1],
    { allowUnverifiedRuntimeForTesting: true },
  );
}

async function workflowContext(
  root: string,
  identity: string,
  libraryLocks: readonly HtmlOverlayLibraryLock[],
): Promise<OperationExecutionContext> {
  const base = operationApplicationContext(root, {
    capabilities: async () => await fixtureCapabilities(root),
  });
  const workspaceDirectory = join(
    base.paths.privateRoot,
    "runs",
    identity,
  );
  await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  const renderedBytes = Buffer.from("fixture qtrle alpha video");
  return {
    abortSignal: new AbortController().signal,
    application: {
      ...base,
      htmlOverlayRenderer: {
        renderFrames: request => Promise.resolve({
          executionIntegrity: createHtmlOverlayExecutionBundle(
            request.authoring,
            request.browserRuntime,
          ).integrity,
          frameCount: htmlOverlayFrameCount(request.authoring.timing),
          framePattern: join(request.outputDirectory, "frame-%08d.png"),
          libraryLocks,
        }),
      },
      runner: {
        run: async argv => {
          if (argv.includes("-show_entries")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                streams: [{
                  codec_name: "qtrle",
                  height: 180,
                  pix_fmt: "argb",
                  width: 320,
                }],
              }),
            };
          }
          const outputPath = argv.at(-1);
          if (outputPath === undefined) {
            throw new Error("Expected an HTML-overlay encoder output path.");
          }
          await writeFile(outputPath, renderedBytes, { mode: 0o600 });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    },
    workflow: {
      beforePublication: () => Promise.resolve(),
      nodeKey: identity,
      nodePlanSha256: sha256(Buffer.from(identity)),
      runId: `run_${identity}`,
      workspaceDirectory,
    },
  };
}

describe("media.html-overlay application operation", () => {
  test("binds an HTML document, declared assets, and exact host capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-html-operation-"));
    roots.push(root);
    const inputDirectory = join(root, "overlay-inputs");
    await mkdir(inputDirectory, { recursive: true });
    const document = Buffer.from("<!doctype html><p>Bound overlay</p>");
    const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const data = Buffer.from('{"answer":42}');
    const documentPath = join(inputDirectory, "overlay.html");
    const logoPath = join(inputDirectory, "logo.png");
    const dataPath = join(inputDirectory, "data.json");
    await Promise.all([
      writeFile(documentPath, document),
      writeFile(logoPath, logo),
      writeFile(dataPath, data),
    ]);
    const capabilities: readonly ApplicationCapability[] = [
        {
          available: true,
          command: EXECUTABLE,
          name: "ffmpeg",
          version: "ffmpeg fixture",
        },
        {
          available: true,
          command: EXECUTABLE,
          name: "ffprobe",
          version: "ffprobe fixture",
        },
        {
          available: true,
          command: EXECUTABLE,
          name: "html-browser",
          version: "browser fixture",
        },
      ];
    const requestedCapabilities: string[] = [];
    const application = operationApplicationContext(root, {
      capabilities: () => Promise.resolve(capabilities),
      capability: name => {
        requestedCapabilities.push(name);
        return Promise.resolve(capabilities.find(candidate => (
          candidate.name === name
        )) ?? { available: false, name });
      },
    });
    const bound = await bindHtmlOverlayInput(application, {
      canvas: { deviceScaleFactor: 1, height: 720, width: 1_280 },
      document: { path: relative(root, documentPath) },
      libraries: ["three", "motion"],
      project: "project_operation01",
      range: { endUs: 2_000_000, startUs: 0 },
      resources: [
        {
          artifact: { path: relative(root, logoPath) },
          mediaType: "image/png",
          name: "logo",
          urlPath: "images/logo.png",
        },
        {
          artifact: { path: relative(root, dataPath) },
          mediaType: "application/json",
          name: "data",
          urlPath: "data/content.json",
        },
      ],
      timing: { durationUs: 2_000_000, fps: 30 },
    }, new AbortController().signal);
    const parsed = BoundHtmlOverlayInputSchema.parse(bound);
    expect(parsed.document).toEqual({
      bytes: document.byteLength,
      path: relative(root, documentPath),
      sha256: sha256(document),
    });
    expect(parsed.libraries).toEqual(["motion", "three"]);
    expect(parsed.resources.map(resource => resource.name)).toEqual([
      "data",
      "logo",
    ]);
    expect(parsed.resources[0]).toMatchObject({
      artifact: {
        bytes: data.byteLength,
        sha256: sha256(data),
      },
      bytes: data.byteLength,
      sha256: sha256(data),
    });
    expect(parsed.capabilityBindings?.map(binding => binding.name)).toEqual([
      "ffmpeg",
      "ffprobe",
      "html-browser",
    ]);
    expect(requestedCapabilities.sort()).toEqual([
      "ffmpeg",
      "ffprobe",
      "html-browser",
    ]);
  });

  test("binds inline HTML deterministically without a repository document", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-html-operation-inline-"));
    roots.push(root);
    const application = operationApplicationContext(root, {
      capabilities: async () => await fixtureCapabilities(root),
    });
    const input = {
      canvas: { deviceScaleFactor: 1, height: 720, width: 1_280 },
      document: { html: "<!doctype html><p>Inline overlay</p>" },
      project: "project_inline01",
      range: { endUs: 2_000_000, startUs: 0 },
      timing: { durationUs: 2_000_000, fps: 30 },
    } as const;

    const first = await bindHtmlOverlayInput(
      application,
      input,
      new AbortController().signal,
    );
    const second = await bindHtmlOverlayInput(
      application,
      input,
      new AbortController().signal,
    );

    expect(first.document).toEqual(input.document);
    expect(BoundHtmlOverlayInputSchema.parse(first)).toEqual(first);
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
  });

  test("binds generated Gateway images as exact HTML overlay resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-html-generated-resource-"));
    roots.push(root);
    const image = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const imagePath = join(root, "generated", "reference.png");
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(imagePath, image);
    const artifact = {
      bytes: image.byteLength,
      mediaType: "image/png",
      path: relative(root, imagePath),
      sha256: sha256(image),
    } as const;
    const application = operationApplicationContext(root, {
      capabilities: async () => await fixtureCapabilities(root),
    });
    const request = {
      canvas: { deviceScaleFactor: 1, height: 720, width: 1_280 },
      document: { html: "<!doctype html><canvas></canvas>" },
      project: "project_generated_resource01",
      range: { endUs: 2_000_000, startUs: 0 },
      resources: [{
        artifact,
        mediaType: "image/png",
        name: "reference-image",
        urlPath: "assets/reference-image",
      }],
      timing: { durationUs: 2_000_000, fps: 30 },
    } as const;

    const bound = await bindHtmlOverlayInput(
      application,
      request,
      new AbortController().signal,
    );
    expect(bound.resources).toEqual([{
      artifact: {
        bytes: artifact.bytes,
        path: artifact.path,
        sha256: artifact.sha256,
      },
      bytes: artifact.bytes,
      mediaType: artifact.mediaType,
      name: "reference-image",
      sha256: artifact.sha256,
      urlPath: "assets/reference-image",
    }]);

    // Bun's asynchronous rejection matcher is typed as returning void.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(bindHtmlOverlayInput(
      application,
      {
        ...request,
        resources: [{
          ...request.resources[0],
          mediaType: "image/webp",
        }],
      },
      new AbortController().signal,
    )).rejects.toThrow(
      "declares image/webp but its generated artifact is image/png",
    );
    // Bun's asynchronous rejection matcher is typed as returning void.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(bindHtmlOverlayInput(
      application,
      {
        ...request,
        resources: [{
          ...request.resources[0],
          artifact: { ...artifact, bytes: artifact.bytes + 1 },
        }],
      },
      new AbortController().signal,
    )).rejects.toThrow(
      "Media no longer matches its integrity-bound workflow input",
    );
  });

  test("rejects fake renderer lock and execution-integrity evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-html-operation-locks-"));
    roots.push(root);
    const fixture = await createOperationProjectFixture(root);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const motion = getApprovedHtmlOverlayLibraryLock("motion");
    const cases = [
      {
        expected: "do not exactly match",
        locks: [] as readonly HtmlOverlayLibraryLock[],
      },
      {
        expected: "version",
        locks: [{
          ...motion,
          version: "forged",
        }] as unknown as readonly HtmlOverlayLibraryLock[],
      },
      {
        expected: "integrity evidence",
        locks: [motion] as readonly HtmlOverlayLibraryLock[],
        tamperIntegrity: true,
      },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const application = operationApplicationContext(root, {
        capabilities: async () => await fixtureCapabilities(root),
      });
      const registry = new OperationRegistry();
      registry.register(createHtmlOverlayOperationDefinition({
        bindBrowserRuntime: bindFixtureBrowserRuntime,
      }));
      const error = await registry.execute({
        abortSignal: new AbortController().signal,
        application: {
          ...application,
          htmlOverlayRenderer: {
            renderFrames: request => {
              const executionIntegrity = createHtmlOverlayExecutionBundle(
                request.authoring,
                request.browserRuntime,
              ).integrity;
              return Promise.resolve({
                executionIntegrity: "tamperIntegrity" in testCase
                  ? { ...executionIntegrity, rootSha256: "f".repeat(64) }
                  : executionIntegrity,
                frameCount: htmlOverlayFrameCount(request.authoring.timing),
                framePattern: join(
                  request.outputDirectory,
                  `frame-${String(index)}-%08d.png`,
                ),
                libraryLocks: testCase.locks,
              });
            },
          },
        },
        expectedProjectGeneration: snapshot.generation.generationSha256,
      }, {
        input: {
          canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
          document: { html: "<!doctype html><p>Lock boundary</p>" },
          libraries: ["motion"],
          project: fixture.project.projectId,
          range: { endUs: 2_000_000, startUs: 0 },
          timing: { durationUs: 2_000_000, fps: 1 },
        },
        kind: "media.html-overlay",
        version: 1,
      }).catch((caught: unknown) => caught);
      expect(String(error)).toContain(testCase.expected);
    }
  });

  test("publishes exact locks and fail-closed checkpoint recovery evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-html-operation-recovery-"));
    roots.push(root);
    const fixture = await createOperationProjectFixture(root);
    const motion = getApprovedHtmlOverlayLibraryLock("motion");
    const three = getApprovedHtmlOverlayLibraryLock("three");
    const context = await workflowContext(
      root,
      "html_overlay_recovery",
      [three, motion],
    );
    const exactInput = await bindHtmlOverlayInput(
      context.application,
      {
        canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
        document: { html: "<!doctype html><p>Recover me</p>" },
        libraries: ["three", "motion"],
        project: fixture.project.projectId,
        range: { endUs: 2_000_000, startUs: 0 },
        timing: { durationUs: 2_000_000, fps: 1 },
      },
      context.abortSignal,
    );
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const definition = createHtmlOverlayOperationDefinition({
      bindBrowserRuntime: bindFixtureBrowserRuntime,
      ingest: async (projectDirectory, input) => {
        const bytes = await readFile(input.path);
        const digest = sha256(bytes);
        const path = `assets/${digest}.mov`;
        await mkdir(join(projectDirectory, "assets"), {
          mode: 0o700,
          recursive: true,
        });
        await writeFile(join(projectDirectory, path), bytes, { mode: 0o600 });
        return {
          bytes: bytes.byteLength,
          created: true,
          mediaType: "video/quicktime",
          path,
          provenance: {
            command: input.command,
            generator: input.generator,
            generatorVersion: input.generatorVersion,
            kind: "generated",
            sourceSha256: input.sourceSha256,
          },
          sha256: digest,
        };
      },
      probe: () => Promise.resolve({
        audioEndUs: null,
        audioStartUs: 0,
        audioStreamIndex: null,
        durationUs: 2_000_000,
        hasAudio: false,
        pixelHeight: 180,
        pixelWidth: 320,
        videoStartUs: 0,
        videoStreamIndex: 0,
      }),
      toolVersion: "transmute-fixture",
    });
    const registry = new OperationRegistry();
    registry.register(definition);
    const result = await registry.execute({
      ...context,
      expectedProjectGeneration: snapshot.generation.generationSha256,
    }, {
      input: exactInput,
      kind: "media.html-overlay",
      version: 1,
    });
    const output = HtmlOverlayOutputSchema.parse(result.output);
    expect(result.receiptReference).toBe(output.receipt.path);
    const receipt = HtmlOverlayReceiptSchema.parse(JSON.parse(
      await readFile(join(root, output.receipt.path), "utf8"),
    ));
    expect(receipt.kind).toBe("transmute.html-overlay-preparation-receipt");
    expect(receipt.libraryLocks).toEqual([motion, three]);
    expect(receipt.libraryLocksSha256).toBe(
      canonicalJsonSha256(receipt.libraryLocks),
    );

    if (context.workflow === undefined) {
      throw new Error("Expected an HTML-overlay workflow context.");
    }
    const identity = {
      inputSchemaId: "studio.operation.media.html-overlay.input/v1",
      kind: "media.html-overlay",
      nodeKey: context.workflow.nodeKey,
      nodePlanSha256: context.workflow.nodePlanSha256,
      outputSchemaId: "studio.operation.media.html-overlay.output/v1",
      runId: context.workflow.runId,
      version: 1,
    } as const;
    const recoveryRequest = {
      abortSignal: new AbortController().signal,
      beforePublication: () => Promise.resolve(),
      exactInput,
      expectedProjectGeneration: snapshot.generation.generationSha256,
      identity,
      workspaceDirectory: context.workflow.workspaceDirectory,
    };
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      recoveryRequest,
    )).toMatchObject({
      kind: "completed",
      output,
      receiptReference: output.receipt.path,
    });
    const emptyWorkspaceDirectory = join(
      context.application.paths.privateRoot,
      "runs",
      "html_overlay_unpublished",
    );
    await mkdir(emptyWorkspaceDirectory, { mode: 0o700, recursive: true });
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      {
        ...recoveryRequest,
        identity: {
          ...identity,
          nodeKey: "html_overlay_unpublished",
          nodePlanSha256: "e".repeat(64),
          runId: "run_html_overlay_unpublished",
        },
        workspaceDirectory: emptyWorkspaceDirectory,
      },
    )).toEqual({ kind: "retry" });
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      {
        ...recoveryRequest,
        exactInput: { ...exactInput, seed: exactInput.seed + 1 },
      },
    )).toMatchObject({ kind: "incompatible" });
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      {
        ...recoveryRequest,
        expectedProjectGeneration: "f".repeat(64),
      },
    )).toMatchObject({ kind: "incompatible" });

    const checkpointPath = join(
      context.workflow.workspaceDirectory,
      OPERATION_COMPLETION_CHECKPOINT_FILE,
    );
    const checkpointSource = await readFile(checkpointPath, "utf8");
    const checkpoint = JSON.parse(checkpointSource) as {
      output: { created: boolean };
    };
    checkpoint.output.created = !checkpoint.output.created;
    await writeFile(
      checkpointPath,
      `${JSON.stringify(checkpoint)}\n`,
      { mode: 0o600 },
    );
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      recoveryRequest,
    )).toMatchObject({ kind: "incompatible" });
    await writeFile(checkpointPath, checkpointSource, { mode: 0o600 });

    const receiptPath = join(root, output.receipt.path);
    const receiptSource = await readFile(receiptPath, "utf8");
    await writeFile(receiptPath, receiptSource.replace(
      "ffmpeg fixture",
      "ffmpeg tampered",
    ), { mode: 0o600 });
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      recoveryRequest,
    )).toMatchObject({ kind: "incompatible" });
    await writeFile(receiptPath, receiptSource, { mode: 0o600 });

    await writeFile(join(root, output.artifact.path), "tampered");
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      recoveryRequest,
    )).toMatchObject({ kind: "incompatible" });
  });

  test.skipIf(
    process.env.TRANSMUTE_RUN_HTML_OVERLAY_OPERATION_SMOKE !== "1"
    || process.platform !== "darwin"
    || !existsSync(CHROME)
    || !existsSync(FFMPEG)
    || !existsSync(FFPROBE)
  )(
    "renders, alpha-encodes, ingests, and prepares a real compositor overlay",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "transmute-html-operation-real-"));
      roots.push(root);
      const fixture = await createOperationProjectFixture(root);
      const inputDirectory = join(root, "overlay-inputs");
      await mkdir(inputDirectory, { recursive: true });
      const documentPath = join(inputDirectory, "overlay.html");
      await writeFile(documentPath, createHtmlOverlayScaffold("plain"));
      const base = operationApplicationContext(root, {
        capabilities: () => Promise.resolve([
          {
            available: true,
            command: FFMPEG,
            name: "ffmpeg",
            version: "ffmpeg smoke",
          },
          {
            available: true,
            command: FFPROBE,
            name: "ffprobe",
            version: "ffprobe smoke",
          },
          {
            available: true,
            command: CHROME,
            name: "html-browser",
            version: "chrome smoke",
          },
        ]),
      });
      const application = {
        ...base,
        htmlOverlayRenderer: new PlaywrightHtmlOverlayRenderer({
          cacheRoot: join(base.paths.privateRoot, "html-overlay-modules-v1"),
        }),
        runner: new BunProcessRunner(),
      };
      const registry = new OperationRegistry();
      registry.register(createHtmlOverlayOperationDefinition({
        toolVersion: "transmute-smoke",
      }));
      const snapshot = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      const result = await registry.execute({
        abortSignal: new AbortController().signal,
        application,
        expectedProjectGeneration: snapshot.generation.generationSha256,
      }, {
        input: {
          canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
          document: { path: relative(root, documentPath) },
          project: fixture.project.projectId,
          range: { endUs: 500_000, startUs: 0 },
          timing: { durationUs: 500_000, fps: 2 },
        },
        kind: "media.html-overlay",
        version: 1,
      });
      const output = HtmlOverlayOutputSchema.parse(result.output);
      expect(output.operation).toMatchObject({
        intrinsicSize: { height: 180, width: 320 },
        source: {
          audioPolicy: { kind: "mute" },
          kind: "video",
        },
      });
      expect(output.operation.source.asset.mediaType).toBe("video/quicktime");
      expect(output.operation.source.asset.path).toMatch(/^assets\/[a-f0-9]{64}\.mov$/u);
      const bytes = await readFile(join(fixture.projectDirectory, output.operation.source.asset.path));
      expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
    },
    600_000,
  );
});
