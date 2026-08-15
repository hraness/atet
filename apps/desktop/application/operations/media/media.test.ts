import { createHash } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  ProjectAssetV1Schema,
  type AudioEffectsTransformV1,
  type ColorGradeTransformV1,
} from "../../../contracts";
import type { ProbedMedia } from "../../../cli/media-ingest";
import { ApplicationError } from "../../errors";
import type { OperationExecutionContext } from "../../operation";
import {
  OPERATION_COMPLETION_CHECKPOINT_FILE,
} from "../../operation-completion-checkpoint";
import { openProjectSnapshot } from "../../project-store";
import { OperationRegistry } from "../../registry";
import {
  reconcileLocalVerifiedReceiptOperation,
} from "../../verified-receipt-reconciliation";
import {
  OPERATION_TEST_HASH,
  createOperationProjectFixture,
  operationApplicationContext,
  operationTestProject,
} from "../test-support";
import {
  MediaAudioEffectsOutputSchema,
  bindMediaAudioEffectsInput,
  createMediaAudioEffectsOperationDefinition,
} from "./audio-effects";
import {
  MediaColorGradeOutputSchema,
  bindMediaColorGradeInput,
  createMediaColorGradeOperationDefinition,
} from "./color-grade";
import {
  MediaIngestOutputSchema,
  bindMediaIngestInput,
  createMediaIngestOperationDefinition,
} from "./ingest";
import {
  MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
  bindRepositoryMedia,
} from "./shared";

const roots: string[] = [];
const FIXTURE_EXECUTABLE = Bun.which("true") ?? "/usr/bin/true";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atet-media-operation-"));
  roots.push(root);
  return root;
}

function reconciliationControl() {
  return {
    abortSignal: new AbortController().signal,
    beforePublication: () => Promise.resolve(),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function probe(kind: "audio" | "video", durationUs = 2_000_000): ProbedMedia {
  const base = {
    assetRange: { endUs: durationUs, startUs: 0 },
    codec_name: kind === "audio" ? "aac" : "h264",
    codec_type: kind,
    fileRange: { endUs: durationUs, startUs: 0 },
    index: 0,
  } as const;
  return {
    container: "fixture",
    durationUs,
    streams: kind === "audio"
      ? [{
          ...base,
          channels: 2,
          sample_rate: "48000",
        }]
      : [{
          ...base,
          avg_frame_rate: "30/1",
          height: 1_080,
          width: 1_920,
        }],
  };
}

async function operationContext(
  root: string,
  beforePublication: () => Promise<void>,
  identity = "media",
): Promise<OperationExecutionContext> {
  const application = operationApplicationContext(root, {
    capabilities: () => Promise.resolve([
      {
        available: true,
        command: FIXTURE_EXECUTABLE,
        name: "ffmpeg",
        version: "ffmpeg fixture",
      },
      {
        available: true,
        command: FIXTURE_EXECUTABLE,
        name: "ffprobe",
        version: "ffprobe fixture",
      },
    ]),
  });
  return {
    abortSignal: new AbortController().signal,
    application,
    workflow: {
      beforePublication,
      nodeKey: identity,
      nodePlanSha256: identity === "media"
        ? "b".repeat(64)
        : sha256(Buffer.from(identity)),
      runId: `run_media_operation_${identity}`,
      workspaceDirectory: await (async () => {
        const path = join(
          application.paths.privateRoot,
          "runs",
          `run_media_operation_${identity}`,
        );
        await mkdir(path, { mode: 0o700, recursive: true });
        return path;
      })(),
    },
  };
}

describe("media application operations", () => {
  test("keeps media inspection outside the encoder pool", () => {
    expect(createMediaIngestOperationDefinition().policy.resources).toEqual([
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "output-publication" },
    ]);
    for (const definition of [
      createMediaAudioEffectsOperationDefinition(),
      createMediaColorGradeOperationDefinition(),
    ]) {
      expect(definition.policy.resources).toContainEqual({
        amount: 1,
        resource: "ffmpeg",
      });
    }
  });

  test("audio and color effects publish verified content addresses and receipts", async () => {
    const root = await fixtureRoot();
    const sourceDirectory = join(root, "artifacts", "atet", "recordings");
    await mkdir(sourceDirectory, { recursive: true });
    const inputBytes = Buffer.from("immutable source media");
    const inputPath = join(sourceDirectory, "source.media");
    await writeFile(inputPath, inputBytes, { mode: 0o600 });
    let publicationChecks = 0;
    let forwardedAbortSignals = 0;
    const context = await operationContext(root, () => {
      publicationChecks += 1;
      return Promise.resolve();
    });
    const application = {
      ...context.application,
      runner: {
        run: (
          _argv: readonly [string, ...string[]],
          options: { readonly abortSignal?: AbortSignal } = {},
        ) => {
          if (options.abortSignal !== undefined) {
            forwardedAbortSignals += 1;
          }
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        },
      },
    };
    const executionContext = { ...context, application };
    const audioTransform: AudioEffectsTransformV1 = {
      audioStreamIndex: 0,
      effects: [{ gainDb: -3, kind: "volume" }],
      kind: "atet.audio-effects-transform",
      output: { kind: "audio-only", profile: "wav-pcm-s16le" },
      schemaVersion: 1,
    };
    const audioBytes = Buffer.from("rendered audio");
    const audioDefinition = createMediaAudioEffectsOperationDefinition({
      probe: (_ffprobe, _runner, path) => Promise.resolve(
        path === inputPath ? probe("audio") : probe("audio"),
      ),
      render: async options => {
        await options.runner.run([options.ffmpeg]);
        await writeFile(options.outputPath, audioBytes, { mode: 0o600 });
        return {
          bytes: audioBytes.byteLength,
          filterGraph: "[0:a:0]volume=volume=-3dB[audio_fx_0]",
          outputPath: options.outputPath,
          sha256: sha256(audioBytes),
          transform: options.transform,
        };
      },
    });
    const audioRegistry = new OperationRegistry();
    audioRegistry.register(audioDefinition);
    const firstAudio = MediaAudioEffectsOutputSchema.parse(
      (await audioRegistry.execute(executionContext, {
        input: await bindMediaAudioEffectsInput(application, {
          input: {
            path: relative(root, inputPath),
          },
          transform: audioTransform,
        }, new AbortController().signal),
        kind: "media.audio-effects",
        version: 1,
      })).output,
    );
    const secondAudio = MediaAudioEffectsOutputSchema.parse(
      (await audioRegistry.execute({
        ...await operationContext(root, () => {
          publicationChecks += 1;
          return Promise.resolve();
        }, "media_audio_second"),
        application,
      }, {
        input: await bindMediaAudioEffectsInput(application, {
          input: {
            bytes: inputBytes.byteLength,
            path: relative(root, inputPath),
            sha256: sha256(inputBytes),
          },
          transform: audioTransform,
        }, new AbortController().signal),
        kind: "media.audio-effects",
        version: 1,
      })).output,
    );
    expect(firstAudio.created).toBe(true);
    expect(secondAudio.created).toBe(false);
    expect(secondAudio.artifact).toEqual(firstAudio.artifact);
    expect(await readFile(join(root, firstAudio.artifact.path))).toEqual(audioBytes);
    expect(JSON.parse(
      await readFile(join(root, firstAudio.receipt.path), "utf8"),
    )).toMatchObject({
      input: {
        bytes: inputBytes.byteLength,
        sha256: sha256(inputBytes),
      },
      kind: "atet.local-media-transform-receipt",
      operation: "audio-effects",
      output: {
        bytes: audioBytes.byteLength,
        sha256: sha256(audioBytes),
      },
    });

    const colorTransform: ColorGradeTransformV1 = {
      grade: { kind: "preset", preset: "clean" },
      kind: "atet.color-grade-transform",
      outputProfile: "h264-mp4",
      schemaVersion: 1,
      videoStreamIndex: 0,
    };
    const videoBytes = Buffer.from("rendered video");
    const colorRegistry = new OperationRegistry();
    colorRegistry.register(createMediaColorGradeOperationDefinition({
      probe: () => Promise.resolve(probe("video")),
      render: async options => {
        await options.runner.run([options.ffmpeg]);
        await writeFile(options.outputPath, videoBytes, { mode: 0o600 });
        return {
          bytes: videoBytes.byteLength,
          filterGraph: "eq=brightness=0.02:contrast=1.04:saturation=1.02:gamma=1",
          outputPath: options.outputPath,
          sha256: sha256(videoBytes),
          transform: options.transform,
        };
      },
    }));
    const color = MediaColorGradeOutputSchema.parse(
      (await colorRegistry.execute({
        ...await operationContext(root, () => {
          publicationChecks += 1;
          return Promise.resolve();
        }, "media_color"),
        application,
      }, {
        input: await bindMediaColorGradeInput(application, {
          input: { path: relative(root, inputPath) },
          transform: colorTransform,
        }, new AbortController().signal),
        kind: "media.color-grade",
        version: 1,
      })).output,
    );
    expect(color.created).toBe(true);
    expect(color.artifact.path).toEndWith(`${sha256(videoBytes)}.mp4`);
    expect(await readFile(join(root, color.artifact.path))).toEqual(videoBytes);
    expect(forwardedAbortSignals).toBe(3);
    expect(publicationChecks).toBeGreaterThanOrEqual(6);
  });

  test("ingest returns an authority-free immutable candidate asset", async () => {
    const root = await fixtureRoot();
    const fixture = await createOperationProjectFixture(root);
    const inputDirectory = join(root, "artifacts", "atet", "recordings");
    await mkdir(inputDirectory, { recursive: true });
    const sourceBytes = Buffer.from("ingest source");
    const sourcePath = join(inputDirectory, "source.mp4");
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    const importedBytes = Buffer.from("ingested immutable media");
    const importedSha256 = sha256(importedBytes);
    const importedRelative = `artifacts/atet/projects/${fixture.project.projectId}/imports/${importedSha256}.media`;
    const importedAbsolute = join(root, importedRelative);
    const baseAsset = operationTestProject().assets[0]!;
    let receivedAbortSignal = false;
    const definition = createMediaIngestOperationDefinition({
      ingest: async options => {
        await options.runner.run([options.ffprobe]);
        receivedAbortSignal = true;
        await mkdir(join(fixture.projectDirectory, "imports"), {
          mode: 0o700,
          recursive: true,
        });
        await writeFile(importedAbsolute, importedBytes, { mode: 0o600 });
        const asset = ProjectAssetV1Schema.parse({
          ...baseAsset,
          createdAt: options.now.toISOString(),
          source: {
            importedAt: options.now.toISOString(),
            kind: "imported",
            originalName: "source.mp4",
            sourceSha256: importedSha256,
          },
          streams: baseAsset.streams.map(stream => ({
            ...stream,
            segments: stream.segments.map(segment => ({
              ...segment,
              bytes: importedBytes.byteLength,
              path: importedRelative,
              sha256: importedSha256,
            })),
          })),
        });
        return {
          absolutePath: importedAbsolute,
          asset,
          created: true,
        };
      },
    });
    const checks: number[] = [];
    const baseContext = await operationContext(root, () => {
      checks.push(checks.length);
      return Promise.resolve();
    });
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const registry = new OperationRegistry();
    registry.register(definition);
    const result = await registry.execute({
      ...baseContext,
      expectedProjectGeneration: snapshot.generation.generationSha256,
    }, {
      input: await bindMediaIngestInput(baseContext.application, {
        project: fixture.project.projectId,
        role: "screen",
        source: {
          bytes: sourceBytes.byteLength,
          path: relative(root, sourcePath),
          sha256: sha256(sourceBytes),
        },
      }, new AbortController().signal),
      kind: "media.ingest",
      version: 1,
    });
    const output = MediaIngestOutputSchema.parse(result.output);
    expect(JSON.parse(
      await readFile(join(root, output.receipt.path), "utf8"),
    )).toMatchObject({ kind: "atet.local-media-ingest-receipt" });
    expect(output.artifact).toEqual({
      bytes: importedBytes.byteLength,
      path: importedRelative,
      sha256: importedSha256,
    });
    expect(output.asset.assetId).toBe(baseAsset.assetId);
    expect(result.receiptReference).toBe(output.receipt.path);
    expect("project" in output).toBe(false);
    expect("projectId" in output).toBe(false);
    expect(receivedAbortSignal).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(2);

    if (baseContext.workflow === undefined) {
      throw new Error("Expected workflow operation context.");
    }
    const identity = {
      inputSchemaId: "atet.operation.media.ingest.input/v1",
      kind: "media.ingest",
      nodeKey: baseContext.workflow.nodeKey,
      nodePlanSha256: baseContext.workflow.nodePlanSha256,
      outputSchemaId: "atet.operation.media.ingest.output/v1",
      runId: baseContext.workflow.runId,
      version: 1,
    } as const;
    const exactInput = {
      project: fixture.project.projectId,
      role: "screen",
      source: {
        bytes: sourceBytes.byteLength,
        path: relative(root, sourcePath),
        sha256: sha256(sourceBytes),
      },
    };
    expect(await reconcileLocalVerifiedReceiptOperation(
      baseContext.application,
      {
        ...reconciliationControl(),
        exactInput,
        expectedProjectGeneration: snapshot.generation.generationSha256,
        identity,
        workspaceDirectory: baseContext.workflow.workspaceDirectory,
      },
    )).toMatchObject({
      kind: "completed",
      output: { artifact: output.artifact },
      receiptReference: output.receipt.path,
    });

    await rm(join(root, output.artifact.path));
    expect(await reconcileLocalVerifiedReceiptOperation(
      baseContext.application,
      {
        ...reconciliationControl(),
        exactInput,
        expectedProjectGeneration: snapshot.generation.generationSha256,
        identity,
        workspaceDirectory: baseContext.workflow.workspaceDirectory,
      },
    )).toMatchObject({ kind: "incompatible" });
    await writeFile(
      join(root, output.artifact.path),
      importedBytes,
      { mode: 0o600 },
    );

    const emptyContext = await operationContext(
      root,
      () => Promise.resolve(),
      "media_ingest_unpublished",
    );
    if (emptyContext.workflow === undefined) {
      throw new Error("Expected workflow operation context.");
    }
    expect(await reconcileLocalVerifiedReceiptOperation(
      emptyContext.application,
      {
        ...reconciliationControl(),
        exactInput,
        expectedProjectGeneration: snapshot.generation.generationSha256,
        identity: {
          ...identity,
          nodeKey: emptyContext.workflow.nodeKey,
          nodePlanSha256: emptyContext.workflow.nodePlanSha256,
          runId: emptyContext.workflow.runId,
        },
        workspaceDirectory: emptyContext.workflow.workspaceDirectory,
      },
    )).toEqual({ kind: "retry" });

    const checkpointPath = join(
      baseContext.workflow.workspaceDirectory,
      OPERATION_COMPLETION_CHECKPOINT_FILE,
    );
    const checkpoint = JSON.parse(
      await readFile(checkpointPath, "utf8"),
    ) as { output: { created: boolean } };
    checkpoint.output.created = !checkpoint.output.created;
    await writeFile(
      checkpointPath,
      `${JSON.stringify(checkpoint)}\n`,
      { mode: 0o600 },
    );
    expect(await reconcileLocalVerifiedReceiptOperation(
      baseContext.application,
      {
        ...reconciliationControl(),
        exactInput,
        expectedProjectGeneration: snapshot.generation.generationSha256,
        identity,
        workspaceDirectory: baseContext.workflow.workspaceDirectory,
      },
    )).toMatchObject({ kind: "incompatible" });
  });

  test("host binding rejects stale digests, symlinks, and cancellation", async () => {
    const root = await fixtureRoot();
    const sourceDirectory = join(root, "artifacts", "atet", "recordings");
    await mkdir(sourceDirectory, { recursive: true });
    const inputPath = join(sourceDirectory, "source.media");
    await writeFile(inputPath, "source", { mode: 0o600 });
    const aliasPath = join(sourceDirectory, "alias.media");
    await symlink(inputPath, aliasPath);
    const application = operationApplicationContext(root);
    const stale = await bindRepositoryMedia(
      application,
      {
        bytes: 6,
        path: relative(root, inputPath),
        sha256: OPERATION_TEST_HASH,
      },
      new AbortController().signal,
      MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
    ).catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: "conflict" });
    const symlinked = await bindRepositoryMedia(
      application,
      { path: relative(root, aliasPath) },
      new AbortController().signal,
      MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
    ).catch((error: unknown) => error);
    expect(symlinked).toMatchObject({ code: "unsafe-path" });
    const aborted = new AbortController();
    aborted.abort();
    const cancellation = await bindRepositoryMedia(
      application,
      { path: relative(root, inputPath) },
      aborted.signal,
      MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
    ).catch((error: unknown) => error);
    expect(cancellation).toBeInstanceOf(ApplicationError);
    expect(cancellation).toMatchObject({ code: "cancelled" });
  });

  test("host binding rejects a parent moved outside after physical resolution", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    const sourceDirectory = join(root, "fixtures");
    const externalDirectory = join(outside, "external");
    const heldDirectory = join(outside, "held");
    await Promise.all([
      mkdir(sourceDirectory, { recursive: true }),
      mkdir(externalDirectory, { recursive: true }),
    ]);
    const sourceBytes = Buffer.from("descriptor-bound repository media");
    const inputPath = join(sourceDirectory, "source.media");
    await writeFile(inputPath, sourceBytes, { mode: 0o600 });
    await link(inputPath, join(externalDirectory, "source.media"));
    const physicalInputPath = await realpath(inputPath);
    const originalOpen = fileSystem.open;
    let swapped = false;
    const openSpy = spyOn(fileSystem, "open").mockImplementation(
      async (path, flags, mode) => {
        if (!swapped && String(path) === physicalInputPath) {
          swapped = true;
          await rename(sourceDirectory, heldDirectory);
          await symlink(externalDirectory, sourceDirectory, "dir");
        }
        return await originalOpen(path, flags, mode);
      },
    );
    try {
      const failure = await bindRepositoryMedia(
        operationApplicationContext(root),
        {
          bytes: sourceBytes.byteLength,
          path: relative(root, inputPath),
          sha256: sha256(sourceBytes),
        },
        new AbortController().signal,
        MAXIMUM_MEDIA_EFFECT_INPUT_BYTES,
      ).catch((error: unknown) => error);
      expect(swapped).toBe(true);
      expect(failure).toMatchObject({ code: "conflict" });
    } finally {
      openSpy.mockRestore();
    }
  });
});
