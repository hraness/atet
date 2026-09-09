import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";

import type { SpatialSceneV1 } from "../../../src/spatial-scene/contracts";
import { fixtureAsset, fixtureCamera, fixtureEntity, fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { spatialAssetClosureDigests, spatialSceneSha256 } from "../../../src/spatial-scene/identity";
import { createNodeSpatialDurability } from "../core/spatial-durability";
import type { ApplicationContext } from "./context";
import { bindHtmlOverlayBrowserRuntime } from "./html-overlay-browser-runtime";
import { createHtmlOverlayExecutionBundle } from "./html-overlay-integrity";
import type { HtmlOverlayRenderer } from "./html-overlay-renderer";
import { hardwareEvidenceFixture } from "../html-overlay/execution-profile.testing";
import type { OperationExecutionContext } from "./operation";
import { publishContentAddressedMedia } from "./operations/media/shared";
import {
  planSpatialRender, renderSpatialScene, SpatialRenderFailure, SpatialRenderOutputSchema, SpatialRenderReceiptSchema,
  verifySpatialEncodedVideo, type SpatialRenderDependencies, type SpatialRenderPlan,
} from "./spatial-render";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function scene(): SpatialSceneV1 {
  const camera = fixtureCamera();
  return { ...fixtureScene(), cameras: [{ ...camera, projection: { ...camera.projection, width: 8, height: 4 } }] };
}
const frameRequest = { cameraId: "camera_main", selection: { kind: "frame", timeUs: 0 }, mode: { kind: "beauty" } } as const;
const videoRequest = { cameraId: "camera_main", selection: { kind: "video", range: { startUs: 0, endUs: 100_000 }, frameRate: { numerator: 30_000, denominator: 1_001 } }, mode: { kind: "beauty" } } as const;
const dependencies: SpatialRenderDependencies = {
  bindBrowserRuntime: async (capability, signal) => await bindHtmlOverlayBrowserRuntime(capability, signal, { allowUnverifiedRuntimeForTesting: true }),
};
function probeFor(plan: SpatialRenderPlan): unknown {
  if (plan.request.selection.kind !== "video") throw new Error("video required");
  const rate = plan.request.selection.frameRate;
  return { streams: [{ index: 0, codec_type: "video", codec_name: "qtrle", width: plan.width, height: plan.height,
    pix_fmt: "argb", r_frame_rate: `${rate.numerator}/${rate.denominator}`, avg_frame_rate: `${rate.numerator}/${rate.denominator}`,
    time_base: `1/${rate.numerator}`, start_pts: 0, duration_ts: plan.samples.length * rate.denominator, nb_frames: String(plan.samples.length) }],
  frames: plan.samples.map((_, index) => ({ stream_index: 0, pts: index * rate.denominator, duration: rate.denominator, best_effort_timestamp: index * rate.denominator })) };
}
async function fixture(options: {
  renderer?: (base: HtmlOverlayRenderer) => HtmlOverlayRenderer;
  probe?: unknown;
  signal?: AbortSignal;
  beforePublication?: () => Promise<void>;
} = {}): Promise<{ root: string; context: OperationExecutionContext; calls: readonly string[][] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-spatial-render-")));
  directories.push(root);
  const privateRoot = join(root, "artifacts", "atet", "private");
  await mkdir(privateRoot, { recursive: true });
  const bin = join(root, "bin"); await mkdir(bin);
  for (const name of ["ffmpeg", "ffprobe", "html-browser"]) await writeFile(join(bin, name), `fixture-${name}\n`, { mode: 0o700 });
  const calls: string[][] = [];
  const renderer: HtmlOverlayRenderer = {
    async renderFrames(request) {
      const frames = join(request.outputDirectory, "frames"); await mkdir(frames);
      const count = request.authoring.timing.durationUs / 1_000_000;
      for (let index = 0; index < count; index++) {
        const png = await sharp({ create: { width: request.authoring.canvas.width, height: request.authoring.canvas.height, channels: 4,
          background: { r: (index + 1) * 11 % 256, g: 31, b: 53, alpha: 0.5 } } }).png().toBuffer();
        await writeFile(join(frames, `frame-${String(index).padStart(8, "0")}.png`), png);
      }
      const bundle = createHtmlOverlayExecutionBundle(request.authoring, request.browserRuntime, request.executionProfile);
      return { executionIntegrity: bundle.integrity, libraryLocks: bundle.libraryLocks, frameCount: count, framePattern: join(frames, "frame-%08d.png"),
        ...(request.executionProfile === undefined ? {} : { gpuEvidence: hardwareEvidenceFixture(request.executionProfile) }) };
    },
  };
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, privateRoot, artifactRoot: join(root, "artifacts", "atet", "recordings"), desktopRoot: root, projectRoot: join(root, "artifacts", "atet", "projects") },
    clock: { now: () => new Date("2026-09-08T00:00:00Z"), timestampMilliseconds: () => 0 },
    capability: async name => ({ name, available: true, command: join(bin, name), version: "test fixture 1" }),
    capabilities: () => Promise.resolve([]),
    htmlOverlayRenderer: options.renderer?.(renderer) ?? renderer,
    runner: { async run(argv) {
      calls.push([...argv]);
      if (argv.includes("-show_frames")) return { exitCode: 0, stderr: "", stdout: JSON.stringify(options.probe ?? probeFor(planSpatialRender(scene(), videoRequest))) };
      await writeFile(argv.at(-1)!, "injected encoder fixture, not real qtrle");
      return { exitCode: 0, stderr: "", stdout: "" };
    } },
  };
  return { root, calls, context: { application, abortSignal: options.signal ?? new AbortController().signal,
    ...(options.beforePublication === undefined ? {} : { workflow: { nodeKey: "node_render", nodePlanSha256: "a".repeat(64), runId: "run_test",
      workspaceDirectory: privateRoot, beforePublication: options.beforePublication } }),
  } };
}
async function generatedFiles(root: string): Promise<string[]> {
  return await readdir(join(root, "artifacts", "atet", "generated", "media-operations", "outputs")).catch(() => []);
}

describe("spatial render planning", () => {
  test("native FFprobe's empty program and stream-group collections are accepted without admitting extra streams", () => {
    const plan = planSpatialRender(scene(), videoRequest);
    const probe = probeFor(plan) as Record<string, unknown>;
    expect(verifySpatialEncodedVideo(plan, { ...probe, programs: [], stream_groups: [] }).frameCount).toBe(3);
    expect(() => verifySpatialEncodedVideo(plan, { ...probe, programs: [{}] })).toThrow();
  });
  test("independent rational samples preserve source offset and avoid cumulative rounding", () => {
    const plan = planSpatialRender({ ...scene(), durationUs: 4_000_000 }, { ...videoRequest,
      selection: { kind: "video", range: { startUs: 100_001, endUs: 3_100_001 }, frameRate: { numerator: 60_000, denominator: 2_002 } } });
    expect(plan.request.selection).toMatchObject({ frameRate: { numerator: 30_000, denominator: 1_001 } });
    expect(plan.samples[1]).toEqual({ index: 1, timeUs: 133_368, exactTimeUs: { numerator: "400103", denominator: "3" } });
    for (const sample of plan.samples) {
      const numerator = 100_001n * 30_000n + BigInt(sample.index) * 1_000_000n * 1_001n;
      expect(BigInt(sample.exactTimeUs.numerator) * 30_000n).toBe(numerator * BigInt(sample.exactTimeUs.denominator));
      expect(sample.timeUs).toBe(Number((2n * numerator + 30_000n) / 60_000n));
    }
    expect(plan.outputDurationUs).toEqual({ numerator: "3003000", denominator: "1" });
    expect(Object.isFrozen(plan.samples[0])).toBe(true);
  });

  test("half-open nominal endpoints and contact-sheet calibrated dimensions are explicit", () => {
    expect(planSpatialRender(scene(), videoRequest).samples).toHaveLength(3);
    expect(() => planSpatialRender(scene(), { ...videoRequest, selection: { ...videoRequest.selection, range: { startUs: 10, endUs: 10 } } })).toThrow("nonempty");
    const plan = planSpatialRender(scene(), { ...frameRequest, selection: { kind: "contact-sheet", timesUs: [0, 300_000, 1_000_000], columns: 2, cellWidth: 12, cellHeight: 12 } });
    expect([plan.width, plan.height, plan.outputWidth, plan.outputHeight]).toEqual([8, 4, 24, 24]);
    expect(plan.request.selection).toMatchObject({ fit: "contain" });
  });

  test("rejects getters and impossible costs before any host work", async () => {
    let invoked = 0;
    expect(() => planSpatialRender(scene(), { get cameraId() { invoked++; return "camera_main"; } })).toThrow();
    expect(invoked).toBe(0);
    const camera = scene().cameras[0]!;
    const giant = { ...scene(), cameras: [{ ...camera, projection: { ...camera.projection, width: 8_192, height: 8_192 } }] };
    const host = await fixture();
    await expect(renderSpatialScene(host.context, { scene: giant, assetRoot: host.root, request: frameRequest }, dependencies)).rejects.toThrow("limit");
    expect(host.calls).toHaveLength(0);
    expect(await generatedFiles(host.root)).toEqual([]);
  });
});

describe("spatial render execution", () => {
  test("hardware render binds its synthetic adapter evidence in the receipt and every retained batch", async () => {
    const host = await fixture();
    const request = { ...frameRequest, executionProfile: "three-webgl2-hardware-v1" } as const;
    const result = await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request }, dependencies);
    const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(host.root, result.receipt.path), "utf8")));
    expect(receipt.runtime.gpuEvidence).toEqual(hardwareEvidenceFixture());
    for (const reference of receipt.batches) {
      const batch = JSON.parse(await readFile(join(host.root, reference.path), "utf8"));
      expect(batch.gpuEvidence).toEqual(receipt.runtime.gpuEvidence);
      expect(batch.metadata.executionProfile).toBe(request.executionProfile);
    }
    expect(SpatialRenderReceiptSchema.safeParse({ ...receipt, runtime: { ...receipt.runtime, gpuEvidence: undefined } }).success).toBe(false);
    expect(SpatialRenderReceiptSchema.safeParse({ ...receipt, request: frameRequest }).success).toBe(false);
  });

  test("hardware render rejects missing GPU evidence before publication", async () => {
    const host = await fixture({ renderer: base => ({ async renderFrames(request, signal) {
      const result = await base.renderFrames(request, signal);
      return { executionIntegrity: result.executionIntegrity, libraryLocks: result.libraryLocks, frameCount: result.frameCount, framePattern: result.framePattern };
    } }) });
    await expect(renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: { ...frameRequest, executionProfile: "three-webgl2-hardware-v1" } }, dependencies)).rejects.toThrow();
    expect(await generatedFiles(host.root)).toEqual([]);
  });

  test("a hardware change between batches fails before publication", async () => {
    let calls = 0;
    const host = await fixture({ renderer: base => ({ async renderFrames(request, signal) {
      const result = await base.renderFrames(request, signal);
      const evidence = hardwareEvidenceFixture();
      return { ...result, gpuEvidence: { ...evidence, osRelease: ++calls === 1 ? evidence.osRelease : "26.0.0" } };
    } }) });
    const request = { executionProfile: "three-webgl2-hardware-v1", cameraId: "camera_main", mode: { kind: "beauty" },
      selection: { kind: "contact-sheet", timesUs: Array.from({ length: 33 }, () => 0), columns: 8, cellWidth: 8, cellHeight: 4 } };
    await expect(renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request }, dependencies)).rejects.toThrow("hardware between batches");
    expect(await generatedFiles(host.root)).toEqual([]);
  });
  test("publishes exact frame, canonical scene, original asset closure and calibrated selection evidence", async () => {
    const host = await fixture();
    const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    await mkdir(join(host.root, "assets")); await writeFile(join(host.root, "assets", "image.png"), image);
    const asset = fixtureAsset();
    const input = { ...scene(), assets: [{ ...asset, payload: { ...asset.payload, sha256: createHash("sha256").update(image).digest("hex"), bytes: image.length },
      interpretation: { ...asset.interpretation, width: 2, height: 2 } }] };
    const result = await renderSpatialScene(host.context, { scene: input, assetRoot: host.root, request: frameRequest }, dependencies);
    expect(result).toEqual(SpatialRenderOutputSchema.parse(result));
    const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(host.root, result.receipt.path), "utf8")));
    expect(receipt.sceneSha256).toBe(spatialSceneSha256(input));
    expect(receipt.source.sourceManifests).toEqual(spatialAssetClosureDigests(input.assets));
    expect(receipt.frameArtifacts).toEqual([result.artifact]);
    expect(result.retainedAssets).toHaveLength(1);
    expect(await readFile(join(host.root, result.retainedAssets[0]!.artifact.path))).toEqual(image);
    expect(createHash("sha256").update(await readFile(join(host.root, result.artifact.path))).digest("hex")).toBe(receipt.samples[0]!.pngSha256);
    expect(await readdir(join(host.context.application.paths.privateRoot, "media-operations"))).toEqual([]);
    expect(host.calls).toHaveLength(0);
  });

  test("contact sheet contains calibrated real PNG samples with explicit transparent contain fit", async () => {
    const host = await fixture();
    const request = { ...frameRequest, selection: { kind: "contact-sheet", timesUs: [200_000, 0, 200_000], columns: 2, cellWidth: 8, cellHeight: 8 } };
    const result = await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request }, dependencies);
    const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(host.root, result.receipt.path), "utf8")));
    expect(result.render).toEqual({ kind: "contact-sheet", frameCount: 3, width: 16, height: 16 });
    expect(receipt.frameArtifacts).toHaveLength(3);
    expect(receipt.samples.map(item => item.sample.timeUs)).toEqual([200_000, 0, 200_000]);
    const { data, info } = await sharp(await readFile(join(host.root, result.artifact.path))).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([16, 16, 4]);
    expect(data[3]).toBe(0); // letterbox row
    expect(data[(3 * 16 + 3) * 4 + 3]).toBeGreaterThan(0);
    expect(receipt.contactSheet).toEqual({ fit: "contain", resampling: "lanczos3", calibratedProjectionResized: false });
  });

  test("video passes exact FFmpeg input/output clocks and verifies actual returned probe fields", async () => {
    const host = await fixture();
    const result = await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: videoRequest }, dependencies);
    const command = host.calls.find(call => call.includes("-framerate"))!;
    expect(command[command.indexOf("-framerate") + 1]).toBe("30000/1001");
    expect(command[command.indexOf("-enc_time_base") + 1]).toBe("1001/30000");
    expect(command[command.indexOf("-video_track_timescale") + 1]).toBe("30000");
    expect(result.render.encodedEvidence).toMatchObject({ frameRate: { numerator: 30_000, denominator: 1_001 }, frameCount: 3, firstPts: "0", lastPts: "2002", endPts: "3003", outputDurationUs: { numerator: "100100", denominator: "1" } });
  });

  test("multiple batches retain independently evaluated source times with at most 32 browser frames", async () => {
    const lengths: number[] = [];
    const request = { ...frameRequest, selection: { kind: "contact-sheet", timesUs: Array.from({ length: 33 }, (_, index) => index * 1_000), columns: 8, cellWidth: 8, cellHeight: 4 } };
    const host = await fixture({ renderer: base => ({ async renderFrames(value, signal) {
      lengths.push(value.authoring.timing.durationUs / 1_000_000);
      return await base.renderFrames(value, signal);
    } }) });
    const result = await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request }, dependencies);
    const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(host.root, result.receipt.path), "utf8")));
    expect(lengths).toEqual([32, 1]);
    expect(receipt.batches).toHaveLength(2);
    expect(receipt.samples.map(item => item.sample.index)).toEqual(Array.from({ length: 33 }, (_, index) => index));
    expect(receipt.samples.at(-1)!.sample.exactTimeUs).toEqual({ numerator: "32000", denominator: "1" });
  });

  test("hardware oversized windows publish exact global sample partitions and never retry a failed browser", async () => {
    const lengths: number[] = [];
    const input = { ...scene(), entities: Array.from({ length: 160 }, (_, index) => fixtureEntity(`entity_${index}`)) };
    const request = { ...frameRequest, executionProfile: "three-webgl2-hardware-v1", selection: { kind: "contact-sheet", timesUs: Array.from({ length: 33 }, (_, index) => (32 - index) * 1_000), columns: 8, cellWidth: 8, cellHeight: 4 } };
    const host = await fixture({ renderer: base => ({ async renderFrames(value, signal) {
      lengths.push(value.authoring.timing.durationUs / 1_000_000);
      return await base.renderFrames(value, signal);
    } }) });
    const result = await renderSpatialScene(host.context, { scene: input, assetRoot: host.root, request }, dependencies);
    const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(host.root, result.receipt.path), "utf8")));
    expect(lengths.length).toBeGreaterThan(2);
    expect(lengths.at(-1)).toBe(1);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(33);
    const batches = await Promise.all(receipt.batches.map(async artifact => JSON.parse(await readFile(join(host.root, artifact.path), "utf8")) as { samples: unknown[]; preparation: { outputBytes: number } }));
    expect(batches.map(batch => batch.samples.length)).toEqual(lengths);
    expect(batches.flatMap(batch => batch.samples)).toEqual(receipt.samples);
    expect(receipt.samples.map(item => item.sample.exactTimeUs)).toEqual(request.selection.timesUs.map(time => ({ numerator: String(time), denominator: "1" })));
    let failures = 0;
    const failed = await fixture({ renderer: () => ({ async renderFrames() { failures++; throw new Error("GPU context lost after admission"); } }) });
    await expect(renderSpatialScene(failed.context, { scene: input, assetRoot: failed.root, request }, dependencies)).rejects.toThrow("GPU context lost");
    expect(failures).toBe(1);
    expect(await generatedFiles(failed.root)).toEqual([]);
  });

  test("incorrect encoded timestamps reject before publication", async () => {
    const probe = probeFor(planSpatialRender(scene(), videoRequest)) as { frames: { pts: number }[] };
    probe.frames[1]!.pts++;
    const host = await fixture({ probe });
    await expect(renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: videoRequest }, dependencies)).rejects.toThrow("timestamps");
    expect(await generatedFiles(host.root)).toEqual([]);
  });

  test("the last publication hook rechecks adapter-owned custody", async () => {
    const host = await fixture(); let hookCalls = 0;
    await expect(renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, { ...dependencies,
      publishMedia: async options => {
        expect(options.beforePublication).toBeDefined();
        await options.beforePublication!();
        hookCalls++;
        throw new Error("publication fence stopped this write");
      },
    })).rejects.toThrow("publication fence");
    expect(hookCalls).toBe(1);
    expect(await generatedFiles(host.root)).toEqual([]);
  });

  test("rejects corrupted integrity, library locks, frame count and path before publication", async () => {
    for (const corruption of ["integrity", "locks", "count", "path"] as const) {
      const host = await fixture({ renderer: base => ({ async renderFrames(request, signal) {
        const result = await base.renderFrames(request, signal);
        if (corruption === "integrity") return { ...result, executionIntegrity: { ...result.executionIntegrity, rootSha256: "f".repeat(64) } };
        if (corruption === "locks") return { ...result, libraryLocks: [] };
        if (corruption === "count") return { ...result, frameCount: 2 };
        return { ...result, framePattern: join(request.outputDirectory, "other-%08d.png") };
      } }) });
      await expect(renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, dependencies)).rejects.toBeInstanceOf(SpatialRenderFailure);
      expect(await generatedFiles(host.root)).toEqual([]);
    }
  });

  test("rejects a wrong calibrated PNG and a symlink frame", async () => {
    for (const symlinked of [false, true]) {
      const host = await fixture({ renderer: base => ({ async renderFrames(request, signal) {
        const result = await base.renderFrames(request, signal);
        const frame = join(request.outputDirectory, "frames", "frame-00000000.png");
        const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "red" } }).png().toBuffer();
        if (symlinked) {
          const target = join(request.outputDirectory, "bad.png"); await writeFile(target, png); await rm(frame); await symlink(target, frame);
        } else await writeFile(frame, png);
        return result;
      } }) });
      await expect(renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, dependencies)).rejects.toBeInstanceOf(SpatialRenderFailure);
      expect(await generatedFiles(host.root)).toEqual([]);
    }
  });

  test("cancellation drains an active renderer before disposing its workspace", async () => {
    const controller = new AbortController();
    let settled = false;
    const host = await fixture({ signal: controller.signal, renderer: base => ({ async renderFrames(request, signal) {
      controller.abort(new Error("cancelled fixture"));
      const result = await base.renderFrames(request, signal);
      expect(await readdir(request.outputDirectory)).toContain("frames");
      settled = true;
      return result;
    } }) });
    await expect(renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, dependencies)).rejects.toThrow("cancelled");
    expect(settled).toBe(true);
    expect(await generatedFiles(host.root)).toEqual([]);
    expect(await readdir(join(host.context.application.paths.privateRoot, "media-operations"))).toEqual([]);
  });

  test("retains completed artifact evidence and the exact uncertain publication after a linked write throws", async () => {
    const host = await fixture(); let publications = 0;
    let failure: SpatialRenderFailure | undefined;
    try {
      await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, { ...dependencies,
        publishMedia: async options => {
          const result = await publishContentAddressedMedia(options);
          if (++publications === 2) throw new Error("injected post-link sync uncertainty");
          return result;
        },
      });
    } catch (error) { if (!(error instanceof SpatialRenderFailure)) throw error; failure = error; }
    expect(publications).toBe(2);
    expect(failure!.evidence.published).toHaveLength(1);
    expect(failure!.evidence.uncertainPublication).toBeDefined();
    const uncertain = failure!.evidence.uncertainPublication!;
    expect(createHash("sha256").update(await readFile(join(host.root, uncertain.path))).digest("hex")).toBe(uncertain.sha256);
    expect(Object.isFrozen(failure!.evidence.published)).toBe(true);
  });

  test("flushes exact new and existing winners including the completion receipt", async () => {
    const host = await fixture(), synced: string[] = [];
    const durable = createNodeSpatialDurability(host.root);
    const overrides = { ...dependencies, durability: { async syncExactFile(path: string, expected: { bytes: number; sha256: string }) {
      await durable.syncExactFile(path, expected); synced.push(path);
    } } };
    const first = await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, overrides);
    const firstCount = synced.length;
    const second = await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, overrides);
    expect(first.artifact).toEqual(second.artifact);
    expect(synced.slice(firstCount)).toContain(first.artifact.path);
    expect(synced.slice(firstCount)).toContain(first.sceneSource.path);
    expect(synced.at(-1)).toBe(second.receipt.path);
  });

  test("a failed winner durability proof retains the exact uncertain reference without a completed receipt", async () => {
    const host = await fixture(); let failure: SpatialRenderFailure | undefined;
    try {
      await renderSpatialScene(host.context, { scene: scene(), assetRoot: host.root, request: frameRequest }, { ...dependencies,
        durability: { syncExactFile: () => Promise.reject(new Error("injected inode fsync failure")) },
      });
    } catch (error) { if (!(error instanceof SpatialRenderFailure)) throw error; failure = error; }
    expect(failure!.evidence.published).toHaveLength(1);
    expect(failure!.evidence.uncertainPublication).toEqual(failure!.evidence.published[0]!);
    expect(failure!.evidence.completion).toBeUndefined();
  });
});

describe("encoded cadence verification", () => {
  test("accepts equivalent exact rational timebases and rejects rate/count/PTS/endpoints", () => {
    const plan = planSpatialRender(scene(), videoRequest);
    const probe = probeFor(plan) as { streams: { r_frame_rate: string; nb_frames: string; duration_ts: number; time_base: string }[]; frames: { pts: number; duration: number; best_effort_timestamp: number }[] };
    expect(verifySpatialEncodedVideo(plan, probe).frameCount).toBe(3);
    const twice = structuredClone(probe); twice.streams[0]!.time_base = "1/60000"; twice.streams[0]!.duration_ts *= 2;
    for (const frame of twice.frames) { frame.pts *= 2; frame.duration *= 2; frame.best_effort_timestamp *= 2; }
    expect(verifySpatialEncodedVideo(plan, twice).endPts).toBe("6006");
    for (const mutate of [
      (value: typeof probe) => { value.streams[0]!.r_frame_rate = "30/1"; },
      (value: typeof probe) => { value.streams[0]!.nb_frames = "2"; },
      (value: typeof probe) => { value.streams[0]!.duration_ts += 1; },
      (value: typeof probe) => { value.frames[1]!.pts += 1; },
      (value: typeof probe) => { value.frames[2]!.duration -= 1; },
    ]) { const corrupted = structuredClone(probe); mutate(corrupted); expect(() => verifySpatialEncodedVideo(plan, corrupted)).toThrow(); }
  });
});
