import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { OperationExecutionContext } from "../../operation";
import { openProjectSnapshot } from "../../project-store";
import { OperationRegistry } from "../../registry";
import { reconcileLocalVerifiedReceiptOperation } from "../../verified-receipt-reconciliation";
import {
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  BoundMediaOverlayInputSchema,
  MediaOverlayOutputSchema,
  bindMediaOverlayInput,
  createMediaOverlayOperationDefinition,
} from "./overlay";

const roots: string[] = [];
const EXECUTABLE = Bun.which("true") ?? "/usr/bin/true";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "transmute-overlay-operation-"));
  roots.push(root);
  return root;
}

async function operationContext(
  root: string,
  identity: string,
): Promise<OperationExecutionContext> {
  const application = operationApplicationContext(root, {
    capabilities: () => Promise.resolve([{
      available: true,
      command: EXECUTABLE,
      name: "ffprobe",
      version: "ffprobe fixture",
    }]),
  });
  const workspaceDirectory = join(
    application.paths.privateRoot,
    "runs",
    identity,
  );
  await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  return {
    abortSignal: new AbortController().signal,
    application,
    workflow: {
      beforePublication: () => Promise.resolve(),
      nodeKey: identity,
      nodePlanSha256: sha256(Buffer.from(identity)),
      runId: `run_${identity}`,
      workspaceDirectory,
    },
  };
}

describe("media.overlay application operation", () => {
  test("prepares static overlays without consuming the encoder pool", () => {
    expect(createMediaOverlayOperationDefinition().policy.resources).toEqual([
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "output-publication" },
    ]);
  });

  test("accepts a Gateway-shaped source and prepares a recoverable deterministic overlay", async () => {
    const root = await fixtureRoot();
    const fixture = await createOperationProjectFixture(root);
    const sourceBytes = Buffer.from("gateway image bytes");
    const sourcePath = join(root, "artifacts", "transmute", "generated", "image.png");
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    const context = await operationContext(root, "overlay_first");
    const exactInput = await bindMediaOverlayInput(
      context.application,
      {
        project: fixture.project.projectId,
        range: { endUs: 4_000_000, startUs: 1_000_000 },
        source: {
          artifact: {
            bytes: sourceBytes.byteLength,
            mediaType: "image/png",
            path: relative(root, sourcePath),
            sha256: sha256(sourceBytes),
          },
          kind: "image",
        },
      },
      context.abortSignal,
    );
    expect(BoundMediaOverlayInputSchema.parse(exactInput).source)
      .not.toHaveProperty("artifact.mediaType");
    const definition = createMediaOverlayOperationDefinition({
      ingestFile: async (projectDirectory, _source, kind) => {
        expect(kind).toBe("image");
        const bytes = sourceBytes;
        const digest = sha256(bytes);
        const relativePath = `assets/${digest}.png`;
        const path = join(projectDirectory, relativePath);
        await mkdir(join(projectDirectory, "assets"), {
          mode: 0o700,
          recursive: true,
        });
        const created = await stat(path).then(
          () => false,
          () => true,
        );
        if (created) await writeFile(path, bytes, { mode: 0o600 });
        return {
          bytes: bytes.byteLength,
          created,
          mediaType: "image/png",
          path: relativePath,
          provenance: {
            kind: "imported",
            originalName: "image.png",
            sourceSha256: sha256(sourceBytes),
          },
          sha256: digest,
        };
      },
      probe: () => Promise.resolve({
        audioEndUs: null,
        audioStartUs: 0,
        audioStreamIndex: null,
        durationUs: null,
        hasAudio: false,
        pixelHeight: 720,
        pixelWidth: 1_280,
        videoStartUs: 0,
        videoStreamIndex: 0,
      }),
    });
    const registry = new OperationRegistry();
    registry.register(definition);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const firstResult = await registry.execute({
      ...context,
      expectedProjectGeneration: snapshot.generation.generationSha256,
    }, {
      input: exactInput,
      kind: "media.overlay",
      version: 1,
    });
    const first = MediaOverlayOutputSchema.parse(firstResult.output);
    expect(JSON.parse(
      await readFile(join(root, first.receipt.path), "utf8"),
    )).toMatchObject({ kind: "transmute.local-overlay-preparation-receipt" });
    expect(first.operation).toMatchObject({
      intrinsicSize: { height: 720, width: 1_280 },
      range: { endUs: 4_000_000, startUs: 1_000_000 },
      source: { kind: "image" },
    });
    expect(first.operation.overlayId).toMatch(/^overlay_[a-f0-9]{32}$/u);
    expect(first.operation.source.asset.path).toMatch(/^assets\//u);
    expect(first.artifact.path).toContain(
      `${fixture.project.projectId}/${first.operation.source.asset.path}`,
    );
    expect(await readFile(join(root, first.artifact.path), "utf8"))
      .toBe("gateway image bytes");

    if (context.workflow === undefined) throw new Error("Expected workflow.");
    const recoveryRequest = {
      abortSignal: new AbortController().signal,
      beforePublication: () => Promise.resolve(),
      exactInput,
      expectedProjectGeneration: snapshot.generation.generationSha256,
      identity: {
        inputSchemaId: "studio.operation.media.overlay.input/v1",
        kind: "media.overlay" as const,
        nodeKey: context.workflow.nodeKey,
        nodePlanSha256: context.workflow.nodePlanSha256,
        outputSchemaId: "studio.operation.media.overlay.output/v1",
        runId: context.workflow.runId,
        version: 1,
      },
      workspaceDirectory: context.workflow.workspaceDirectory,
    };
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      recoveryRequest,
    )).toMatchObject({
      kind: "completed",
      receiptReference: first.receipt.path,
    });

    const secondContext = await operationContext(root, "overlay_second");
    const second = MediaOverlayOutputSchema.parse((await registry.execute({
      ...secondContext,
      expectedProjectGeneration: snapshot.generation.generationSha256,
    }, {
      input: exactInput,
      kind: "media.overlay",
      version: 1,
    })).output);
    expect(second.operation.overlayId).toBe(first.operation.overlayId);
    expect(second.created).toBe(false);

    const copiedSourcePath = join(
      root,
      "artifacts",
      "transmute",
      "generated",
      "copied-image.png",
    );
    await writeFile(copiedSourcePath, sourceBytes, { mode: 0o600 });
    const copiedInput = await bindMediaOverlayInput(
      context.application,
      {
        ...exactInput,
        source: {
          artifact: { path: relative(root, copiedSourcePath) },
          kind: "image",
        },
      },
      context.abortSignal,
    );
    const copiedContext = await operationContext(root, "overlay_copied_source");
    const copied = MediaOverlayOutputSchema.parse((await registry.execute({
      ...copiedContext,
      expectedProjectGeneration: snapshot.generation.generationSha256,
    }, {
      input: copiedInput,
      kind: "media.overlay",
      version: 1,
    })).output);
    expect(copied.operation.overlayId).toBe(first.operation.overlayId);

    const movedContext = await operationContext(root, "overlay_moved");
    const moved = MediaOverlayOutputSchema.parse((await registry.execute({
      ...movedContext,
      expectedProjectGeneration: snapshot.generation.generationSha256,
    }, {
      input: {
        ...exactInput,
        layout: {
          ...exactInput.layout,
          position: { x: 40, y: 20 },
        },
      },
      kind: "media.overlay",
      version: 1,
    })).output);
    expect(moved.operation.overlayId).not.toBe(first.operation.overlayId);

    await writeFile(join(root, first.artifact.path), "tampered");
    expect(await reconcileLocalVerifiedReceiptOperation(
      context.application,
      recoveryRequest,
    )).toMatchObject({ kind: "incompatible" });
  });

  test("rejects an ingester that substitutes bytes after exact input binding", async () => {
    const root = await fixtureRoot();
    const fixture = await createOperationProjectFixture(root);
    const sourceBytes = Buffer.from("exact source bytes");
    const sourcePath = join(root, "fixtures", "source.png");
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    const substitutedBytes = Buffer.from("substituted bytes");
    const substitutedSha256 = sha256(substitutedBytes);
    const definition = createMediaOverlayOperationDefinition({
      ingestFile: async projectDirectory => {
        const path = `assets/${substitutedSha256}.png`;
        await mkdir(join(projectDirectory, "assets"), { recursive: true });
        await writeFile(join(projectDirectory, path), substitutedBytes, {
          mode: 0o600,
        });
        return {
          bytes: substitutedBytes.byteLength,
          created: true,
          mediaType: "image/png",
          path,
          provenance: {
            kind: "imported",
            originalName: "source.png",
            sourceSha256: sha256(sourceBytes),
          },
          sha256: substitutedSha256,
        };
      },
    });
    const registry = new OperationRegistry();
    registry.register(definition);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const context = await operationContext(root, "overlay_substitution");
    const error = await registry.execute({
      ...context,
      expectedProjectGeneration: snapshot.generation.generationSha256,
    }, {
      input: {
        project: fixture.project.projectId,
        range: { endUs: 2_000_000, startUs: 0 },
        source: {
          artifact: { path: relative(root, sourcePath) },
          kind: "image",
        },
      },
      kind: "media.overlay",
      version: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "conflict",
      message: "Prepared overlay bytes disagree with the exact bound source.",
    });
  });

  test("prepares SVG, GIF, video, and checked emoji sources through one contract", async () => {
    const root = await fixtureRoot();
    const fixture = await createOperationProjectFixture(root);
    const sourceDirectory = join(root, "fixtures");
    await mkdir(sourceDirectory, { recursive: true });
    const sourcePaths = {
      gif: join(sourceDirectory, "animation.gif"),
      svg: join(sourceDirectory, "title.svg"),
      video: join(sourceDirectory, "clip.mp4"),
    } as const;
    await Promise.all([
      writeFile(sourcePaths.gif, "GIF89a"),
      writeFile(
        sourcePaths.svg,
        "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'></svg>",
      ),
      writeFile(
        sourcePaths.video,
        Buffer.from([
          0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70,
          0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
        ]),
      ),
    ]);
    const emojiPath = join(sourceDirectory, "emoji.svg");
    const emojiBytes = Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'></svg>",
    );
    await writeFile(emojiPath, emojiBytes);
    const media = {
      gif: { extension: "gif", mediaType: "image/gif" },
      image: { extension: "png", mediaType: "image/png" },
      svg: { extension: "svg", mediaType: "image/svg+xml" },
      video: { extension: "mp4", mediaType: "video/mp4" },
    } as const;
    const publish = async (
      projectDirectory: string,
      label: keyof typeof media | "emoji",
      bytes: Buffer,
    ) => {
      const format = label === "emoji"
        ? { extension: "svg", mediaType: "image/svg+xml" as const }
        : media[label];
      const digest = sha256(bytes);
      const path = `assets/${digest}.${format.extension}`;
      await mkdir(join(projectDirectory, "assets"), { recursive: true });
      await writeFile(join(projectDirectory, path), bytes);
      return {
        bytes: bytes.byteLength,
        created: true,
        mediaType: format.mediaType,
        path,
        provenance: {
          kind: "imported" as const,
          originalName: `${label}.${format.extension}`,
          sourceSha256: digest,
        },
        sha256: digest,
      };
    };
    const resolveEmoji = () => Promise.resolve({
      available: { color: true, duotone: true },
      emoji: "✨",
      group: "symbols",
      id: "2728",
      name: "sparkles",
      path: emojiPath,
      provider: "apple-emoji-pack" as const,
      sha256: sha256(emojiBytes),
      subgroup: "other-symbol",
      variant: "color" as const,
    });
    const definition = createMediaOverlayOperationDefinition({
      ingestEmoji: async (projectDirectory, resolved) =>
        await publish(
          projectDirectory,
          "emoji",
          await readFile(resolved.path),
        ),
      ingestFile: async (projectDirectory, source, kind) =>
        await publish(projectDirectory, kind, await readFile(source)),
      inspectSvg: () => Promise.resolve({ height: 180, width: 320 }),
      probe: () => Promise.resolve({
        audioEndUs: 5_000_000,
        audioStartUs: 0,
        audioStreamIndex: 1,
        durationUs: 5_000_000,
        hasAudio: true,
        pixelHeight: 720,
        pixelWidth: 1_280,
        videoStartUs: 0,
        videoStreamIndex: 0,
      }),
      resolveEmoji,
    });
    const registry = new OperationRegistry();
    registry.register(definition);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const requests = [
      {
        source: {
          artifact: { path: relative(root, sourcePaths.svg) },
          kind: "svg",
        },
      },
      {
        source: {
          artifact: { path: relative(root, sourcePaths.gif) },
          kind: "gif",
        },
      },
      {
        source: {
          artifact: { path: relative(root, sourcePaths.video) },
          audioPolicy: { kind: "mix", volume: 0.7 },
          kind: "video",
        },
      },
      {
        source: {
          kind: "emoji",
          provider: "apple-emoji-pack",
          query: "✨",
        },
      },
    ] as const;
    const prepared = [];
    for (const [index, request] of requests.entries()) {
      const context = await operationContext(root, `overlay_kind_${index}`);
      const result = await registry.execute({
        ...context,
        expectedProjectGeneration: snapshot.generation.generationSha256,
      }, {
        input: {
          project: fixture.project.projectId,
          range: { endUs: 4_000_000, startUs: 0 },
          ...request,
        },
        kind: "media.overlay",
        version: 1,
      });
      prepared.push(MediaOverlayOutputSchema.parse(result.output));
    }

    expect(prepared.map(output => output.operation.source.kind)).toEqual([
      "svg",
      "gif",
      "video",
      "emoji",
    ]);
    expect(new Set(prepared.map(output => output.operation.overlayId)).size)
      .toBe(4);
    expect(prepared[1]?.operation.source).toMatchObject({
      audioPolicy: { kind: "mute" },
      kind: "gif",
      playback: { sourceInUs: 0, sourceOutUs: 5_000_000 },
    });
    expect(prepared[2]?.operation.source).toMatchObject({
      audioPolicy: { kind: "mix", volume: 0.7 },
      kind: "video",
    });
    expect(prepared[3]?.operation.source).toMatchObject({
      kind: "emoji",
      provider: "apple-emoji-pack",
      selector: { kind: "unicode", value: "✨" },
    });
  });

  test("prepares independent overlays concurrently on a fresh project bundle", async () => {
    const root = await fixtureRoot();
    const fixture = await createOperationProjectFixture(root);
    const sourceDirectory = join(root, "fixtures");
    await mkdir(sourceDirectory, { recursive: true });
    const sources = [
      join(sourceDirectory, "first.png"),
      join(sourceDirectory, "second.png"),
    ];
    await Promise.all(sources.map(async (path, index) =>
      await writeFile(path, Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index,
      ]))));
    const definition = createMediaOverlayOperationDefinition({
      probe: () => Promise.resolve({
        audioEndUs: null,
        audioStartUs: 0,
        audioStreamIndex: null,
        durationUs: null,
        hasAudio: false,
        pixelHeight: 180,
        pixelWidth: 320,
        videoStartUs: 0,
        videoStreamIndex: 0,
      }),
    });
    const registry = new OperationRegistry();
    registry.register(definition);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const contexts = await Promise.all([
      operationContext(root, "overlay_parallel_first"),
      operationContext(root, "overlay_parallel_second"),
    ]);
    const results = await Promise.all(sources.map(async (source, index) =>
      MediaOverlayOutputSchema.parse((await registry.execute({
        ...contexts[index]!,
        expectedProjectGeneration: snapshot.generation.generationSha256,
      }, {
        input: {
          identityKey: `parallel-${index}`,
          project: fixture.project.projectId,
          range: {
            endUs: 2_000_000 + index * 1_000_000,
            startUs: index * 1_000_000,
          },
          source: {
            artifact: { path: relative(root, source) },
            kind: "image",
          },
        },
        kind: "media.overlay",
        version: 1,
      })).output)));

    expect(new Set(results.map(output => output.artifact.path)).size).toBe(2);
    expect(results.every(output => output.created)).toBe(true);
    expect(await Promise.all(results.map(async output =>
      (await stat(join(root, output.artifact.path))).isFile(),
    ))).toEqual([true, true]);
  });

  test("re-resolves and rejects an authored emoji binding", async () => {
    const root = await fixtureRoot();
    const fixture = await createOperationProjectFixture(root);
    const emojiBytes = Buffer.from("<svg width=\"10\" height=\"10\"></svg>");
    const emojiPath = join(root, "packages", "brand-catalog", "emoji.svg");
    await mkdir(join(emojiPath, ".."), { recursive: true });
    await writeFile(emojiPath, emojiBytes, { mode: 0o600 });
    const application = operationApplicationContext(root);
    const error = await bindMediaOverlayInput(application, {
      project: fixture.project.projectId,
      range: { endUs: 2_000_000, startUs: 0 },
      source: {
        kind: "emoji",
        provider: "brand-catalog",
        query: "transmute",
        resolved: {
          artifact: {
            bytes: emojiBytes.byteLength,
            path: relative(root, emojiPath),
            sha256: "0".repeat(64),
          },
          id: "wrong",
          provider: "brand-catalog",
          selector: { kind: "name", value: "transmute" },
          variant: "duotone",
        },
      },
    }, new AbortController().signal, {
      resolveEmoji: () => Promise.resolve({
        available: { color: true, duotone: true },
        emoji: "🌴",
        group: "brand",
        id: "transmute",
        name: "Transmute",
        path: emojiPath,
        provider: "brand-catalog",
        sha256: sha256(emojiBytes),
        subgroup: "brand",
        variant: "duotone",
      }),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "conflict" });
  });
});
