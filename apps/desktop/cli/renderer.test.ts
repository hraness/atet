import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RecordingEventV1Schema,
  RecordingManifestV1Schema,
  RenderPlanV1Schema,
  type OverlayOperation,
  type RecordingManifestV1,
} from "../contracts";
import { compileRenderPlan, createDefaultEditPlan, normalizeEditPlan } from "../core";
import { testManifest, testPlan } from "../core/test-support";
import type { ProcessRunner } from "./io";
import {
  applyMetadataEffects,
  buildMetadataClickSprite,
  buildMetadataCursorSprite,
  buildFfmpegInvocation,
  prepareOverlaySources,
  type PreparedOverlaySource,
} from "./renderer";

const HASH = "1".repeat(64);
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"].find((path) => existsSync(path));

async function runProcess(argv: readonly [string, ...string[]]): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

async function renderRawFrame(
  ffmpeg: string,
  filters: readonly string[],
  width: number,
  height: number,
): Promise<Uint8Array> {
  const child = Bun.spawn([
    ffmpeg,
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", filters.join(","),
    "-frames:v", "1",
    "-pix_fmt", "rgba",
    "-f", "rawvideo",
    "pipe:1",
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Could not render procedural metadata sprite: ${stderr}`);
  const frame = new Uint8Array(stdout);
  expect(frame.byteLength).toBe(width * height * 4);
  return frame;
}

async function renderDelayedClickPulseFrame(
  ffmpeg: string,
  outputTimeUs: number,
): Promise<Uint8Array> {
  const width = 96;
  const height = 96;
  const filters = [
    `color=c=black:s=${width}x${height}:r=10:d=1.5,format=rgba[video_base]`,
  ];
  const { currentVideo } = applyMetadataEffects({
    cameraKeyframes: [],
    effects: {
      clickCues: [{
        button: "left",
        clickCount: 1,
        coordinateSpace: "output-pixels",
        displayId: "display-primary",
        outputTimeUs,
        phase: "down",
        position: { x: width / 2, y: height / 2 },
        sourceTimeUs: outputTimeUs,
      }],
      clicks: {
        color: "#ffffff",
        durationUs: 400_000,
        enabled: true,
        radiusPx: 20,
        style: "pulse",
      },
      cursor: { enabled: false },
      cursorSamples: [],
      keystrokeCues: [],
      keystrokes: { enabled: false },
      typedText: { enabled: false },
      typingSpans: [],
    },
    output: {
      durationUs: 1_500_000,
      frameRate: 10,
      pixelHeight: height,
      pixelWidth: width,
    },
  }, filters, "video_base", 0);
  filters.push(
    `[${currentVideo}]select='eq(n,11)',setpts=PTS-STARTPTS,format=rgba[click_frame]`,
  );

  const child = Bun.spawn([
    ffmpeg,
    "-hide_banner", "-loglevel", "error",
    "-filter_complex", filters.join(";"),
    "-map", "[click_frame]",
    "-frames:v", "1",
    "-pix_fmt", "rgba",
    "-f", "rawvideo",
    "pipe:1",
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Could not render delayed click pulse: ${stderr}`);
  const frame = new Uint8Array(stdout);
  expect(frame.byteLength).toBe(width * height * 4);
  return frame;
}

function rgbaAt(
  frame: Uint8Array,
  width: number,
  x: number,
  y: number,
): readonly [red: number, green: number, blue: number, alpha: number] {
  const offset = (y * width + x) * 4;
  return [
    frame[offset]!,
    frame[offset + 1]!,
    frame[offset + 2]!,
    frame[offset + 3]!,
  ];
}

async function readFilterGraph(argv: readonly string[]): Promise<string> {
  const index = argv.indexOf("-filter_complex_script");
  if (index < 0 || argv[index + 1] === undefined) throw new Error("Missing FFmpeg filter graph script.");
  return await readFile(argv[index + 1]!, "utf8");
}

function importedAsset<const MediaType extends OverlayOperation["source"]["asset"]["mediaType"]>(
  path: string,
  mediaType: MediaType,
) {
  const provenance: OverlayOperation["source"]["asset"]["provenance"] = {
    kind: "imported",
    originalName: path.split("/").at(-1) ?? path,
    sourceSha256: HASH,
  };
  return {
    bytes: 10,
    mediaType,
    path,
    provenance,
    sha256: HASH,
  };
}

function overlaySource(value: OverlayOperation["source"]): OverlayOperation["source"] {
  return value;
}

function overlay(
  overlayId: string,
  zIndex: number,
  source: OverlayOperation["source"],
  animation: OverlayOperation["entrance"] = { kind: "none" },
): OverlayOperation {
  return {
    anchor: "center",
    coordinateSpace: "output-pixels",
    entrance: animation,
    exit: { kind: "none" },
    intrinsicSize: { height: 64, width: 64 },
    opacity: 0.9,
    overlayId,
    position: { x: 0, y: 0 },
    range: { endUs: 5_000_000, startUs: 1_000_000 },
    rotationDegrees: 0,
    scale: 1,
    size: { kind: "intrinsic" },
    source,
    zIndex,
  };
}

function manifestWithVideoGap() {
  const base = testManifest();
  return RecordingManifestV1Schema.parse({
    ...base,
    capture: { ...base.capture, typedText: "enabled" },
    tracks: base.tracks.map((track) => {
      if (track.kind !== "display-video" || track.source.displayId !== "display-primary") return track;
      const original = track.segments[0]!;
      if (original.timing.kind !== "legacy-estimate") throw new Error("Expected legacy fixture timing.");
      return {
        ...track,
        segments: [
          {
            ...original,
            endUs: 4_000_000,
            fileRange: { endUs: 4_000_000, startUs: 0 },
            timing: {
              ...original.timing,
              nativeRange: { endUs: 5_000_000, startUs: 1_000_000 },
            },
          },
          {
            ...original,
            endUs: 10_000_000,
            fileRange: { endUs: 4_000_000, startUs: 0 },
            path: "media/segment-gap.mp4",
            segmentId: "segment_video_gap01",
            startUs: 6_000_000,
            timing: {
              ...original.timing,
              nativeRange: { endUs: 11_000_000, startUs: 7_000_000 },
            },
          },
        ],
      };
    }),
  });
}

function metadataEvents() {
  const window = {
    applicationBundleId: "com.example",
    applicationName: "Example",
    bounds: { height: 600, width: 800, x: 100, y: 100 },
    displayId: "display-primary",
    isFocused: true,
    layer: 1,
    title: { state: "available", value: "Example" },
    windowId: "window-primary",
  } as const;
  return [
    {
      nativeTimeUs: 0,
      sequence: 0,
      sourceTimeUs: 0,
      type: "window.snapshot",
      windows: [window],
    },
    {
      displayId: "display-primary",
      nativeTimeUs: 1_000_000,
      position: { x: 200, y: 200 },
      sequence: 1,
      sourceTimeUs: 1_000_000,
      type: "cursor.sample",
      visible: true,
    },
    {
      displayId: "display-primary",
      nativeTimeUs: 2_000_000,
      position: { x: 400, y: 300 },
      sequence: 2,
      sourceTimeUs: 2_000_000,
      type: "cursor.sample",
      visible: true,
    },
    {
      button: "left",
      clickCount: 1,
      displayId: "display-primary",
      nativeTimeUs: 2_000_000,
      phase: "down",
      position: { x: 400, y: 300 },
      sequence: 3,
      sourceTimeUs: 2_000_000,
      type: "mouse.click",
    },
    {
      activity: {
        keyCode: "K",
        kind: "shortcut",
        modifiers: ["command"],
        phase: "down",
        repeat: false,
      },
      nativeTimeUs: 2_100_000,
      sequence: 4,
      sourceTimeUs: 2_100_000,
      type: "key.activity",
    },
    {
      input: {
        action: "insert",
        bounds: { height: 40, width: 300, x: 250, y: 350 },
        fieldId: "field-primary",
        secure: false,
        text: "hello: 100%",
        windowId: "window-primary",
      },
      nativeTimeUs: 2_200_000,
      sequence: 5,
      sourceTimeUs: 2_200_000,
      type: "typing.input",
    },
  ].map((event) => RecordingEventV1Schema.parse(event));
}

test("builds bounded procedural cursor and click sprites without placeholder boxes", () => {
  const cursor = buildMetadataCursorSprite({ scale: 1, style: "captured" }, 60, 1_000_000);
  const cursorFilter = cursor.filters.join(",");
  expect(cursor.width).toBeLessThan(cursor.height);
  expect(cursor.hotspotX).toBeLessThan(cursor.width / 4);
  expect(cursor.hotspotY).toBeLessThan(cursor.height / 4);
  expect(cursorFilter).toContain("geq=");
  expect(cursorFilter).toContain("abs(");
  expect(cursorFilter).not.toContain("drawbox=");

  const dotFilter = buildMetadataCursorSprite({ scale: 1, style: "dot" }, 60, 1_000_000)
    .filters.join(",");
  const ringFilter = buildMetadataCursorSprite({ scale: 1, style: "ring" }, 60, 1_000_000)
    .filters.join(",");
  expect(dotFilter).toContain("hypot(");
  expect(ringFilter).toContain("hypot(");
  expect(ringFilter).not.toBe(dotFilter);

  const click = buildMetadataClickSprite({
    color: "#ffcc00cc",
    radiusPx: 12,
    style: "pulse",
  }, 60, 250_000);
  const clickFilter = click.filters.join(",");
  expect(click.width).toBe(click.height);
  expect(clickFilter).toContain("hypot(");
  expect(clickFilter).toContain("geq=r='255':g='204':b='0':a='204*(");
  expect(clickFilter).toContain("flags=bicubic");
  expect(clickFilter).toContain("fade=t=out");
  expect(clickFilter).not.toContain("drawbox=");

  expect(() =>
    buildMetadataClickSprite({
      color: "#ffffff",
      radiusPx: 9_000,
      style: "ring",
    }, 60, 250_000)
  ).toThrow("render safety limit");
});

test.skipIf(FFMPEG === undefined)("renders an arrow-shaped cursor and antialiased circular click ring", async () => {
  if (FFMPEG === undefined) return;
  const cursor = buildMetadataCursorSprite({ scale: 1, style: "captured" }, 60, 100_000);
  const cursorFrame = await renderRawFrame(
    FFMPEG,
    cursor.filters,
    cursor.width,
    cursor.height,
  );
  const occupied = Array.from({ length: cursor.height }, (_, y) =>
    Array.from({ length: cursor.width }, (_, x) => rgbaAt(cursorFrame, cursor.width, x, y)[3] > 16)
  );
  const occupiedCount = occupied.reduce(
    (count, row) => count + row.filter(Boolean).length,
    0,
  );
  const occupiedCoordinates = occupied.flatMap((row, y) =>
    row.flatMap((isOccupied, x) => isOccupied ? [{ x, y }] : [])
  );
  const minX = Math.min(...occupiedCoordinates.map(({ x }) => x));
  const maxX = Math.max(...occupiedCoordinates.map(({ x }) => x));
  const minY = Math.min(...occupiedCoordinates.map(({ y }) => y));
  const maxY = Math.max(...occupiedCoordinates.map(({ y }) => y));
  const occupiedBoundsArea = (maxX - minX + 1) * (maxY - minY + 1);
  const headWidth = occupied[Math.round(cursor.height * 0.5)]!.filter(Boolean).length;
  const stemWidth = occupied[Math.round(cursor.height * 0.82)]!.filter(Boolean).length;
  const cursorPixels = Array.from({ length: cursor.width * cursor.height }, (_, index) => {
    const offset = index * 4;
    return {
      alpha: cursorFrame[offset + 3]!,
      luminance: cursorFrame[offset]!,
    };
  });
  expect(occupiedCount / occupiedBoundsArea).toBeLessThan(0.7);
  expect(headWidth).toBeGreaterThan(stemWidth * 1.7);
  expect(rgbaAt(cursorFrame, cursor.width, Math.round(cursor.hotspotX), Math.round(cursor.hotspotY))[3])
    .toBeGreaterThan(64);
  expect(rgbaAt(cursorFrame, cursor.width, cursor.width - 1, 0)[3]).toBe(0);
  expect(rgbaAt(cursorFrame, cursor.width, 0, cursor.height - 1)[3]).toBe(0);
  expect(cursorPixels.some(({ alpha, luminance }) => alpha > 200 && luminance > 220)).toBe(true);
  expect(cursorPixels.some(({ alpha, luminance }) => alpha > 150 && luminance < 32)).toBe(true);
  expect(cursorPixels.some(({ alpha }) => alpha > 0 && alpha < 255)).toBe(true);

  const click = buildMetadataClickSprite({
    color: "#ffcc00cc",
    radiusPx: 12,
    style: "ring",
  }, 60, 100_000);
  const clickFrame = await renderRawFrame(FFMPEG, click.filters, click.width, click.height);
  const centerLow = Math.floor((click.width - 1) / 2);
  const centerHigh = Math.ceil((click.width - 1) / 2);
  expect(rgbaAt(clickFrame, click.width, centerLow, centerLow)[3]).toBe(0);
  const axisPixels = [
    rgbaAt(clickFrame, click.width, centerLow - 10, centerLow)[3],
    rgbaAt(clickFrame, click.width, centerHigh + 10, centerLow)[3],
    rgbaAt(clickFrame, click.width, centerLow, centerLow - 10)[3],
    rgbaAt(clickFrame, click.width, centerLow, centerHigh + 10)[3],
  ];
  expect(Math.max(...axisPixels) - Math.min(...axisPixels)).toBeLessThanOrEqual(2);
  expect(Math.min(...axisPixels)).toBeGreaterThan(180);
  const ringPixel = rgbaAt(clickFrame, click.width, centerHigh + 10, centerLow);
  expect(ringPixel.slice(0, 3)).toEqual([255, 204, 0]);
  expect(Array.from({ length: click.width * click.height }, (_, index) => clickFrame[index * 4 + 3]!)
    .some((alpha) => alpha > 0 && alpha < 204)).toBe(true);
}, 10_000);

test.skipIf(FFMPEG === undefined)("starts a non-frame-aligned click cue on the first pulse phase", async () => {
  if (FFMPEG === undefined) return;
  const delayed = await renderDelayedClickPulseFrame(FFMPEG, 1_050_000);
  const frameAligned = await renderDelayedClickPulseFrame(FFMPEG, 1_100_000);
  const hasVisiblePulse = delayed.some((channel, index) => index % 4 !== 3 && channel > 0);
  expect(hasVisiblePulse).toBe(true);
  expect(Buffer.from(delayed).equals(Buffer.from(frameAligned))).toBe(true);
}, 10_000);

async function materializeManifestMedia(
  bundleRoot: string,
  input: RecordingManifestV1,
): Promise<RecordingManifestV1> {
  const integrityByPath = new Map<string, { readonly bytes: number; readonly sha256: string }>();
  for (const track of input.tracks) {
    for (const segment of track.segments) {
      if (integrityByPath.has(segment.path)) continue;
      const absolute = join(bundleRoot, segment.path);
      await mkdir(dirname(absolute), { recursive: true });
      if (!existsSync(absolute)) await writeFile(absolute, `renderer fixture for ${segment.path}\n`);
      const bytes = await readFile(absolute);
      integrityByPath.set(segment.path, {
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return RecordingManifestV1Schema.parse({
    ...input,
    tracks: input.tracks.map(track => ({
      ...track,
      segments: track.segments.map(segment => ({
        ...segment,
        integrity: { ...integrityByPath.get(segment.path)!, state: "verified" as const },
      })),
    })),
  });
}

test("trims recording media from its exact rebased file range", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-rebased-render-test-"));
  try {
    const base = testManifest();
    const rebased = RecordingManifestV1Schema.parse({
      ...base,
      tracks: base.tracks.map(track => ({
        ...track,
        segments: track.segments.map(segment => ({
          ...segment,
          fileRange: {
            endUs: segment.fileRange.endUs + 500_000,
            startUs: segment.fileRange.startUs + 500_000,
          },
        })),
      })),
    });
    const manifest = await materializeManifestMedia(temporary, rebased);
    const display = manifest.tracks.find(track => (
      track.kind === "display-video"
      && track.source.displayId === "display-primary"
    ));
    const systemAudio = manifest.tracks.find(track => track.kind === "system-audio");
    if (display === undefined || systemAudio === undefined) {
      throw new Error("Rebased renderer fixture omits primary media.");
    }
    const render = compileRenderPlan(manifest, testPlan(), [], {
      audioTrackIds: [systemAudio.trackId],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: "ffmpeg",
      outputPath: join(temporary, "renders", "rebased.mp4"),
      overlaySources: [],
    });
    const filter = await readFilterGraph(built.argv);
    expect(filter).toContain("trim=start=0.5:end=10.5");
    expect(filter).toContain("atrim=start=0.5:end=10.5");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("verifies overlay assets and regenerates SVG derivatives without trusting cache leaves", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-svg-prepare-test-"));
  const assetDirectory = join(temporary, "assets");
  try {
    await mkdir(assetDirectory, { recursive: true });
    const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><path d='M0 0h1v1z'/></svg>");
    const sha256 = createHash("sha256").update(svgBytes).digest("hex");
    const assetPath = join(assetDirectory, "verified.svg");
    await writeFile(assetPath, svgBytes);
    const operation = overlay("overlay_verified_svg", 0, overlaySource({
      asset: {
        bytes: svgBytes.byteLength,
        mediaType: "image/svg+xml",
        path: "assets/verified.svg",
        provenance: { kind: "imported", originalName: "verified.svg", sourceSha256: sha256 },
        sha256,
      },
      kind: "svg",
    }));
    const edit = normalizeEditPlan({ ...testPlan(), overlays: [operation] });
    const manifest = testManifest();
    const display = manifest.tracks.find(track => track.kind === "display-video");
    if (display === undefined) throw new Error("Missing display fixture.");
    const plan = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    let calls = 0;
    const runner: ProcessRunner = {
      run: async (argv) => {
        calls += 1;
        const outputIndex = argv.indexOf("-o") + 1;
        const output = argv[outputIndex];
        if (output === undefined) throw new Error("Missing SVG output argument.");
        const png = new Uint8Array(24);
        png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(png.buffer);
        view.setUint32(16, 64, false);
        view.setUint32(20, 64, false);
        await writeFile(output, png);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const options = { bundleRoot: temporary, dryRun: false, rsvgConvert: "rsvg-convert", runner };
    const first = await prepareOverlaySources(plan, options);
    await prepareOverlaySources(plan, options);
    expect(calls).toBe(2);
    expect((await stat(first.sources[0]!.path)).isFile()).toBe(true);

    const tampered = Uint8Array.from(svgBytes);
    const tamperIndex = tampered.byteLength - 2;
    tampered[tamperIndex] = tampered[tamperIndex]! ^ 1;
    await writeFile(assetPath, tampered);
    let tamperFailure: unknown;
    try {
      await prepareOverlaySources(plan, { ...options, dryRun: true });
    } catch (error) {
      tamperFailure = error;
    }
    expect(String(tamperFailure)).toMatch(/integrity/u);
    await writeFile(assetPath, svgBytes);

    const outside = join(temporary, "outside.png");
    await writeFile(outside, Uint8Array.from([1]));
    await rm(first.sources[0]!.path);
    await symlink(outside, first.sources[0]!.path);
    let symlinkFailure: unknown;
    try {
      await prepareOverlaySources(plan, options);
    } catch (error) {
      symlinkFailure = error;
    }
    expect(String(symlinkFailure)).toMatch(/physical regular file/u);
    expect(calls).toBe(2);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("renders legacy null-index animated overlays from probed non-cover streams", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-legacy-overlay-stream-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const assetPath = "assets/legacy.mp4";
    const assetBytes = new TextEncoder().encode("legacy animated overlay");
    await mkdir(dirname(join(temporary, assetPath)), { recursive: true });
    await writeFile(join(temporary, assetPath), assetBytes);
    const assetSha256 = createHash("sha256").update(assetBytes).digest("hex");
    const operation = overlay("overlay_legacy_stream", 0, overlaySource({
      asset: {
        bytes: assetBytes.byteLength,
        mediaType: "video/mp4",
        path: assetPath,
        provenance: { kind: "imported", originalName: "legacy.mp4", sourceSha256: assetSha256 },
        sha256: assetSha256,
      },
      audioPolicy: { kind: "mix", volume: 1 },
      kind: "video",
      playback: {
        audioEndUs: 1_000_000,
        audioStartUs: 0,
        endBehavior: "hide",
        playbackRate: 1,
        sourceInUs: 0,
        sourceOutUs: 1_000_000,
        streamStartUs: 0,
      },
    }));
    const edit = normalizeEditPlan({ ...testPlan(), overlays: [operation] });
    const systemAudio = manifest.tracks.find(track => track.kind === "system-audio")!;
    const display = manifest.tracks.find(track => (
      track.kind === "display-video" && track.source.displayId === "display-primary"
    ))!;
    const render = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [systemAudio.trackId],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const runner: ProcessRunner = {
      run: () => Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          format: { duration: "1" },
          streams: [{
            codec_type: "video",
            disposition: { attached_pic: 1 },
            height: 600,
            index: 0,
            width: 600,
          }, {
            codec_type: "video",
            duration: "1",
            height: 64,
            index: 4,
            width: 64,
          }, {
            codec_type: "audio",
            duration: "1",
            index: 7,
          }],
        }),
      }),
    };
    const prepared = await prepareOverlaySources(render, {
      bundleRoot: temporary,
      dryRun: true,
      ffprobe: "ffprobe-test",
      rsvgConvert: undefined,
      runner,
    });

    expect(prepared.sources).toMatchObject([{
      audioStreamIndex: 7,
      overlayId: operation.overlayId,
      videoStreamIndex: 4,
    }]);
    expect(prepared.sources[0]?.path.endsWith(`/${assetPath}`)).toBe(true);
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: "ffmpeg",
      outputPath: join(temporary, "renders", "legacy.mp4"),
      overlaySources: prepared.sources,
    });
    const filter = await readFilterGraph(built.argv);
    expect(filter).toContain("[1:4]");
    expect(filter).toContain("[1:7]");
    expect(filter).not.toContain("[1:v:0]");
    expect(filter).not.toContain("[1:a:0]");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("builds gap-preserving metadata effects and z-ordered image/SVG/GIF/video overlays", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-renderer-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, manifestWithVideoGap());
    const base = testPlan();
    const overlays: readonly OverlayOperation[] = [
      overlay("overlay_image001", 10, overlaySource({
        asset: importedAsset("assets/image.png", "image/png"),
        kind: "image",
      }), {
        durationUs: 250_000,
        easing: { kind: "ease-in" },
        fromScale: 0.5,
        kind: "scale",
      }),
      overlay("overlay_svg00001", 5, overlaySource({
        asset: importedAsset("assets/vector.svg", "image/svg+xml"),
        kind: "svg",
      })),
      overlay("overlay_gifloop1", -20, overlaySource({
        asset: importedAsset("assets/loop.gif", "image/gif"),
        audioPolicy: { kind: "mute" },
        kind: "gif",
        playback: { endBehavior: "loop", playbackRate: 1, sourceInUs: 0, sourceOutUs: 1_000_000 },
      })),
      overlay("overlay_vidfreeze", -10, overlaySource({
        asset: importedAsset("assets/freeze.mp4", "video/mp4"),
        audioPolicy: { kind: "mute" },
        kind: "video",
        playback: { endBehavior: "freeze-end", playbackRate: 1, sourceInUs: 0, sourceOutUs: 1_000_000 },
      })),
      overlay("overlay_videohide", 0, overlaySource({
        asset: importedAsset("assets/hide.mp4", "video/mp4"),
        audioPolicy: { kind: "mute" },
        kind: "video",
        playback: { endBehavior: "hide", playbackRate: 1, sourceInUs: 0, sourceOutUs: 1_000_000 },
      })),
    ];
    const edit = normalizeEditPlan({
      ...base,
      effects: {
        clicks: { color: "#ffcc00cc", durationUs: 400_000, enabled: true, radiusPx: 24, style: "pulse" },
        cursor: {
          enabled: true,
          scale: 1,
          smoothing: { algorithm: "exponential", strength: 0.7 },
          style: "dot",
        },
        keystrokes: {
          enabled: true,
          holdUs: 1_000_000,
          maxKeys: 8,
          position: "bottom-right",
          secureText: "hide",
        },
        typedText: {
          enabled: true,
          idleTimeoutUs: 1_000_000,
          maxCharacters: 100,
          placement: "input",
          secureText: "hide",
        },
      },
      overlays,
      recordingId: manifest.recordingId,
      zooms: [{
        displayId: "display-primary",
        easing: { kind: "ease-in-out" },
        enterDurationUs: 250_000,
        exitDurationUs: 250_000,
        kind: "manual",
        range: { endUs: 4_000_000, startUs: 1_000_000 },
        scale: 2,
        target: { kind: "point", point: { x: 400, y: 300 } },
        zoomId: "zoom_renderer001",
      }],
    });
    const events = metadataEvents();
    const compiled = compileRenderPlan(manifest, edit, events.filter(({ type }) => type !== "cursor.sample"), {
      audioTrackIds: [],
      camera: { kind: "none" },
      displayTrackId: manifest.tracks.find((track) =>
        track.kind === "display-video" && track.source.displayId === "display-primary"
      )!.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const render: typeof compiled = {
      ...compiled,
      effects: {
        ...compiled.effects,
        cursorSamples: events.filter((event) => event.type === "cursor.sample").map((event) => ({
          coordinateSpace: "output-pixels" as const,
          displayId: event.displayId,
          outputTimeUs: event.sourceTimeUs,
          position: event.position,
          sourceTimeUs: event.sourceTimeUs,
          visible: event.visible,
        })),
      },
    };
    const prepared: PreparedOverlaySource[] = overlays.map(({ overlayId, source }) => ({
      audioStreamIndex: source.kind === "video" ? source.playback.audioStreamIndex ?? null : null,
      overlayId,
      path: join(temporary, source.asset.path),
      videoStreamIndex: source.kind === "gif" || source.kind === "video"
        ? source.playback.videoStreamIndex ?? null
        : null,
    }));
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      outputPath: join(temporary, "renders", "output.mp4"),
      overlaySources: prepared,
    });
    const filter = await readFilterGraph(built.argv);
    expect(filter).toContain("color=c=black:s=1920x1080");
    expect(filter).toContain("+6/TB");
    expect(filter).not.toContain("concat=n=");
    expect(filter).toContain("cursor_source_");
    expect(filter).toContain("video_click_");
    expect(filter).toContain("geq=");
    expect(filter).toContain("hypot(");
    expect(filter).toContain("settb=expr=1/1000000,setpts=PTS-STARTPTS+");
    expect(filter).not.toContain("drawbox=");
    expect(filter).toContain("zoompan=z=");
    expect(filter).toContain(")*1920/(");
    expect(filter).toContain(")*1080/(");
    expect(filter).toContain("drawtext=text='command+K'");
    expect(filter).toContain("hello\\: 100\\%");
    expect(filter).toContain("loop=loop=-1");
    expect(filter).toContain("tpad=stop_mode=clone");
    expect(filter).toContain("pow(");
    const inputOrder = ["loop.gif", "freeze.mp4", "hide.mp4", "vector.svg", "image.png"]
      .map((name) => built.argv.findIndex((argument) => argument.endsWith(name)));
    expect(inputOrder).toEqual([...inputOrder].sort((left, right) => left - right));
    expect(built.argv).toContain("10");
    let unsafeOutputFailure: unknown;
    try {
      await buildFfmpegInvocation(manifest, render, {
        bundleRoot: temporary,
        ffmpeg: "/opt/homebrew/bin/ffmpeg",
        outputPath: join(temporary, "media", "overwrite-raw.mp4"),
        overlaySources: prepared,
      });
    } catch (error) {
      unsafeOutputFailure = error;
    }
    expect(String(unsafeOutputFailure)).toContain("under renders/");

    await writeFile(join(temporary, render.sourceSegments[0]!.path), "tampered recording media");
    let tamperedMediaFailure: unknown;
    try {
      await buildFfmpegInvocation(manifest, render, {
        bundleRoot: temporary,
        ffmpeg: "/opt/homebrew/bin/ffmpeg",
        outputPath: join(temporary, "renders", "tampered.mp4"),
        overlaySources: prepared,
      });
    } catch (error) {
      tamperedMediaFailure = error;
    }
    expect(String(tamperedMediaFailure)).toMatch(/byte length changed|integrity check/u);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("keeps a normal multi-minute cursor graph out of process argv", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-filter-argv-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const display = manifest.tracks.find(track => track.kind === "display-video")!;
    const base = compileRenderPlan(manifest, normalizeEditPlan({
      ...testPlan(),
      baseSpeed: 1 / 30,
    }), [], {
      audioTrackIds: [],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const render = RenderPlanV1Schema.parse({
      ...base,
      effects: {
        ...base.effects,
        cursor: { enabled: true, scale: 1, smoothing: { algorithm: "none", strength: 0 }, style: "dot" },
        cursorSamples: Array.from({ length: 18_000 }, (_, index) => ({
          coordinateSpace: "output-pixels",
          displayId: "display-primary",
          outputTimeUs: Math.floor(index * base.output.durationUs / 18_000),
          position: { x: index % 1_920, y: index % 1_080 },
          sourceTimeUs: Math.floor(index * 10_000_000 / 18_000),
          visible: true,
        })),
      },
    });
    expect(render.output.durationUs).toBe(300_000_000);
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: "ffmpeg",
      outputPath: join(temporary, "renders", "cursor.mp4"),
      overlaySources: [],
    });
    expect(built.argv).toContain("-filter_complex_script");
    expect(Buffer.byteLength(built.argv.join("\0"))).toBeLessThan(64_000);
    expect(built.invocation.filterGraph.bytes).toBeGreaterThan(1_000_000);
    expect(await readFilterGraph(built.argv)).toHaveLength(built.invocation.filterGraph.bytes);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}, 30_000);

test("clamps overlay transitions to the post-speed output duration", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-speed-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const fade = { durationUs: 400_000, easing: { kind: "linear" as const }, kind: "fade" as const };
    const operation: OverlayOperation = {
      ...overlay("overlay_speedfade01", 0, overlaySource({
        asset: importedAsset("assets/speed.png", "image/png"),
        kind: "image",
      }), fade),
      exit: fade,
      range: { endUs: 2_000_000, startUs: 1_000_000 },
    };
    const edit = normalizeEditPlan({
      ...testPlan(),
      overlays: [operation],
      speed: [{ range: operation.range, rate: 4 }],
    });
    const render = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [],
      camera: { kind: "none" },
      displayTrackId: manifest.tracks.find((track) => (
        track.kind === "display-video" && track.source.displayId === "display-primary"
      ))!.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG ?? "ffmpeg",
      outputPath: join(temporary, "renders", "speed.mp4"),
      overlaySources: [{
        audioStreamIndex: null,
        overlayId: operation.overlayId,
        path: join(temporary, operation.source.asset.path),
        videoStreamIndex: null,
      }],
    });
    const filter = await readFilterGraph(built.argv);

    expect(render.overlays[0]?.output).toEqual({ endUs: 1_250_000, startUs: 1_000_000 });
    expect(filter).toContain("fade=t=in:st=1:d=0.125:alpha=1");
    expect(filter).toContain("fade=t=out:st=1.125:d=0.125:alpha=1");
    expect(filter).not.toContain("fade=t=out:st=0.85");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("keeps animated video and audio on one clock across cuts and speed boundaries", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-continuity-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const operation: OverlayOperation = {
      ...overlay("overlay_continuous01", 0, overlaySource({
        asset: importedAsset("assets/continuous.mp4", "video/mp4"),
        audioPolicy: { duckPrimaryTo: 0.25, kind: "duck-primary", volume: 1 },
        kind: "video",
        playback: {
          audioEndUs: 2_550_000,
          audioStartUs: 550_000,
          audioStreamIndex: 7,
          endBehavior: "hide",
          playbackRate: 1,
          sourceInUs: 250_000,
          sourceOutUs: 9_000_000,
          streamStartUs: 100_000,
          videoStreamIndex: 4,
        },
      })),
      range: { endUs: 6_000_000, startUs: 500_000 },
    };
    const edit = normalizeEditPlan({
      ...testPlan(),
      keep: [{ endUs: 2_000_000, startUs: 0 }, { endUs: 8_000_000, startUs: 3_000_000 }],
      overlays: [operation],
      speed: [{ range: { endUs: 5_000_000, startUs: 1_000_000 }, rate: 0.5 }],
    });
    const systemAudio = manifest.tracks.find(track => track.kind === "system-audio");
    const display = manifest.tracks.find(track => (
      track.kind === "display-video" && track.source.displayId === "display-primary"
    ));
    if (systemAudio === undefined || display === undefined) throw new Error("Missing render fixture tracks.");
    const render = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [systemAudio.trackId],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG ?? "ffmpeg",
      outputPath: join(temporary, "renders", "continuous.mp4"),
      overlaySources: [{
        audioStreamIndex: null,
        overlayId: operation.overlayId,
        path: join(temporary, operation.source.asset.path),
        videoStreamIndex: null,
      }],
    });
    const filter = await readFilterGraph(built.argv);

    expect(render.overlays).toHaveLength(1);
    expect(render.overlays[0]?.output).toEqual({ endUs: 8_000_000, startUs: 500_000 });
    expect(filter.match(/\[1:4\]/gu)).toHaveLength(1);
    expect(filter.match(/\[1:7\]/gu)).toHaveLength(1);
    expect(filter).not.toContain("[1:v:0]");
    expect(filter).not.toContain("[1:a:0]");
    expect(filter).toContain("trim=start=0.35:end=7.85");
    expect(filter).toContain("atrim=start=0.35:end=7.85");
    expect(filter).toContain("adelay=200:all=1");
    expect(filter).toContain("setpts=(PTS-STARTPTS)/1+0.5/TB");
    expect(filter).toContain("asetpts=PTS-STARTPTS+0.5/TB");
    expect(filter).toContain("volume='if(between(t,0.7,2.7),0.25,1)':eval=frame");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("omits overlay audio when the selected source window ends before audio starts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-silent-window-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const operation = overlay("overlay_silent_window", 0, overlaySource({
      asset: importedAsset("assets/silent-window.mp4", "video/mp4"),
      audioPolicy: { duckPrimaryTo: 0.2, kind: "duck-primary", volume: 1 },
      kind: "video",
      playback: {
        audioStartUs: 1_000_000,
        endBehavior: "loop",
        playbackRate: 1,
        sourceInUs: 0,
        sourceOutUs: 500_000,
        streamStartUs: 0,
      },
    }));
    const edit = normalizeEditPlan({ ...testPlan(), overlays: [operation] });
    const systemAudio = manifest.tracks.find(track => track.kind === "system-audio")!;
    const display = manifest.tracks.find(track => (
      track.kind === "display-video" && track.source.displayId === "display-primary"
    ))!;
    const render = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [systemAudio.trackId],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG ?? "ffmpeg",
      outputPath: join(temporary, "renders", "silent-window.mp4"),
      overlaySources: [{
        audioStreamIndex: null,
        overlayId: operation.overlayId,
        path: join(temporary, operation.source.asset.path),
        videoStreamIndex: null,
      }],
    });
    const filter = await readFilterGraph(built.argv);

    expect(filter).toContain("format=rgba,loop=loop=-1:size=30:start=0");
    expect(filter).not.toContain("[1:a:0]");
    expect(filter).not.toContain("audio_ducked_");
    expect(filter).not.toContain("overlay_audio_");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("loops delayed overlay audio in a deterministic format and ducks only audible phases", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-audio-loop-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const operation = overlay("overlay_delayed_loop", 0, overlaySource({
      asset: importedAsset("assets/delayed-loop.mp4", "video/mp4"),
      audioPolicy: { duckPrimaryTo: 0.4, kind: "duck-primary", volume: 0.75 },
      kind: "video",
      playback: {
        audioEndUs: 750_000,
        audioStartUs: 250_000,
        endBehavior: "loop",
        playbackRate: 1,
        sourceInUs: 0,
        sourceOutUs: 1_000_000,
        streamStartUs: 0,
      },
    }));
    const edit = normalizeEditPlan({ ...testPlan(), overlays: [operation] });
    const systemAudio = manifest.tracks.find(track => track.kind === "system-audio")!;
    const display = manifest.tracks.find(track => (
      track.kind === "display-video" && track.source.displayId === "display-primary"
    ))!;
    const render = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [systemAudio.trackId],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG ?? "ffmpeg",
      outputPath: join(temporary, "renders", "delayed-loop.mp4"),
      overlaySources: [{
        audioStreamIndex: null,
        overlayId: operation.overlayId,
        path: join(temporary, operation.source.asset.path),
        videoStreamIndex: null,
      }],
    });
    const filter = await readFilterGraph(built.argv);

    expect(filter).toContain("format=rgba,loop=loop=-1:size=60:start=0");
    expect(filter).toContain("apad=pad_dur=0.25,atrim=duration=1,aformat=sample_fmts=flt:channel_layouts=stereo,aloop=loop=-1:size=48000");
    expect(filter).toContain("adelay=250:all=1");
    expect(filter).toContain("volume='if(between(t,1,5)*gte(mod((t-1)*1,1),0.25)*lt(mod((t-1)*1,1),0.75),0.4,1)':eval=frame");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("applies overlapping duck targets once to captured primary audio without touching earlier overlays", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-primary-duck-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const animatedOverlay = (
      overlayId: string,
      zIndex: number,
      path: string,
      audioPolicy: Extract<OverlayOperation["source"], { readonly kind: "video" }>["audioPolicy"],
    ): OverlayOperation => overlay(overlayId, zIndex, overlaySource({
      asset: importedAsset(path, "video/mp4"),
      audioPolicy,
      kind: "video",
      playback: {
        endBehavior: "hide",
        playbackRate: 1,
        sourceInUs: 0,
        sourceOutUs: 2_000_000,
      },
    }));
    const mixed = animatedOverlay(
      "overlay_mixed_audio",
      0,
      "assets/mixed.mp4",
      { kind: "mix", volume: 0.8 },
    );
    const duckA = animatedOverlay(
      "overlay_duck_audio1",
      1,
      "assets/duck-a.mp4",
      { duckPrimaryTo: 0.5, kind: "duck-primary", volume: 0.6 },
    );
    const duckB = animatedOverlay(
      "overlay_duck_audio2",
      2,
      "assets/duck-b.mp4",
      { duckPrimaryTo: 0.5, kind: "duck-primary", volume: 0.7 },
    );
    const operations = [mixed, duckA, duckB];
    const edit = normalizeEditPlan({ ...testPlan(), overlays: operations });
    const systemAudio = manifest.tracks.find(track => track.kind === "system-audio")!;
    const display = manifest.tracks.find(track => (
      track.kind === "display-video" && track.source.displayId === "display-primary"
    ))!;
    const render = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [systemAudio.trackId],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG ?? "ffmpeg",
      outputPath: join(temporary, "renders", "primary-duck.mp4"),
      overlaySources: operations.map(operation => ({
        audioStreamIndex: null,
        overlayId: operation.overlayId,
        path: join(temporary, operation.source.asset.path),
        videoStreamIndex: null,
      })),
    });
    const filter = await readFilterGraph(built.argv);
    const mixedOverlayLabel = filter.match(/\[1:a:0\][^;]*\[(overlay_audio_\d+)\]/u)?.[1];
    const duckOverlayLabelA = filter.match(/\[2:a:0\][^;]*\[(overlay_audio_\d+)\]/u)?.[1];
    const duckOverlayLabelB = filter.match(/\[3:a:0\][^;]*\[(overlay_audio_\d+)\]/u)?.[1];
    const duckedPrimaryLabel = filter.match(
      /\[audio_primary\]volume='min\(if\(between\(t,1,3\),0\.5,1\),if\(between\(t,1,3\),0\.5,1\)\)':eval=frame\[(audio_ducked_\d+)\]/u,
    )?.[1];

    expect(mixedOverlayLabel).toBeDefined();
    expect(duckOverlayLabelA).toBeDefined();
    expect(duckOverlayLabelB).toBeDefined();
    expect(duckedPrimaryLabel).toBeDefined();
    expect(filter).toContain(
      `[${duckedPrimaryLabel}][${mixedOverlayLabel}][${duckOverlayLabelA}][${duckOverlayLabelB}]amix=inputs=4`,
    );
    expect(filter.match(/\[audio_primary\]volume=/gu)).toHaveLength(1);
    expect(filter).not.toMatch(/\[audio_mix_\d+\]volume=/u);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("ends hide transitions and primary-audio ducking with visible overlay media", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-hide-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const fade = { durationUs: 800_000, easing: { kind: "linear" as const }, kind: "fade" as const };
    const operation: OverlayOperation = {
      ...overlay("overlay_hideaudio01", 0, overlaySource({
        asset: importedAsset("assets/hide-audio.mp4", "video/mp4"),
        audioPolicy: { duckPrimaryTo: 0.25, kind: "duck-primary", volume: 1 },
        kind: "video",
        playback: { endBehavior: "hide", playbackRate: 1, sourceInUs: 0, sourceOutUs: 1_000_000 },
      }), fade),
      exit: fade,
    };
    const edit = normalizeEditPlan({ ...testPlan(), overlays: [operation] });
    const systemAudio = manifest.tracks.find((track) => track.kind === "system-audio");
    const display = manifest.tracks.find((track) => (
      track.kind === "display-video" && track.source.displayId === "display-primary"
    ));
    if (systemAudio === undefined || display === undefined) throw new Error("Missing render fixture tracks.");
    const render = compileRenderPlan(manifest, edit, [], {
      audioTrackIds: [systemAudio.trackId],
      camera: { kind: "none" },
      displayTrackId: display.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG ?? "ffmpeg",
      outputPath: join(temporary, "renders", "hide.mp4"),
      overlaySources: [{
        audioStreamIndex: null,
        overlayId: operation.overlayId,
        path: join(temporary, operation.source.asset.path),
        videoStreamIndex: null,
      }],
    });
    const filter = await readFilterGraph(built.argv);

    expect(filter).toContain("fade=t=in:st=1:d=0.5:alpha=1");
    expect(filter).toContain("fade=t=out:st=1.5:d=0.5:alpha=1");
    expect(filter).toContain("enable='between(t,1,2)'");
    expect(filter).toContain("volume='if(between(t,1,2),0.25,1)':eval=frame");
    expect(filter).not.toContain("volume='if(between(t,1,5),0.25,1)':eval=frame");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("does not interpolate across the gap between independent hard zooms", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-zoom-gap-test-"));
  try {
    const manifest = await materializeManifestMedia(temporary, testManifest());
    const plan = normalizeEditPlan({
      ...testPlan(),
      zooms: [
        {
          displayId: "display-primary",
          easing: { kind: "linear" },
          enterDurationUs: 0,
          exitDurationUs: 0,
          kind: "manual",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
          scale: 2,
          target: { kind: "point", point: { x: 200, y: 200 } },
          zoomId: "zoom_gap_first",
        },
        {
          displayId: "display-primary",
          easing: { kind: "linear" },
          enterDurationUs: 0,
          exitDurationUs: 0,
          kind: "manual",
          range: { endUs: 5_000_000, startUs: 4_000_000 },
          scale: 2,
          target: { kind: "point", point: { x: 1_500, y: 800 } },
          zoomId: "zoom_gap_second",
        },
      ],
    });
    const render = compileRenderPlan(manifest, plan, [], {
      audioTrackIds: [],
      camera: { kind: "none" },
      displayTrackId: manifest.tracks.find((track) => (
        track.kind === "display-video" && track.source.displayId === "display-primary"
      ))!.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG ?? "ffmpeg",
      outputPath: join(temporary, "renders", "zoom-gap.mp4"),
      overlaySources: [],
    });
    const filter = await readFilterGraph(built.argv);

    expect(filter).toContain("gte(on/60,1)*lt(on/60,2)");
    expect(filter).toContain("gte(on/60,4)*lt(on/60,5)");
    expect(filter).not.toContain("between(on/60,2,4)");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(FFMPEG === undefined)("executes the metadata compositor with FFmpeg", async () => {
  if (FFMPEG === undefined) return;
  const temporary = await mkdtemp(join(tmpdir(), "atet-render-execution-test-"));
  try {
    const mediaDirectory = join(temporary, "media");
    const renderDirectory = join(temporary, "renders");
    await mkdir(mediaDirectory, { recursive: true });
    await mkdir(renderDirectory, { recursive: true });
    const mediaPath = join(mediaDirectory, "segment-1.mp4");
    const generated = await runProcess([
      FFMPEG,
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      mediaPath,
    ]);
    if (generated.exitCode !== 0) throw new Error(`Could not generate renderer fixture: ${generated.stderr}`);
    const imagePath = join(temporary, "overlay.png");
    const gifPath = join(temporary, "overlay.gif");
    const videoPath = join(temporary, "overlay.mp4");
    for (const [output, input, outputArguments] of [
      [imagePath, "color=c=red:s=32x32:d=0.5", ["-frames:v", "1"]],
      [gifPath, "color=c=green:s=32x32:r=10:d=0.5", ["-vf", "format=rgb24"]],
      [videoPath, "color=c=yellow:s=32x32:r=30:d=0.5", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]],
    ] as const) {
      const fixture = await runProcess([
        FFMPEG,
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", input,
        ...outputArguments,
        output,
      ]);
      if (fixture.exitCode !== 0) throw new Error(`Could not generate overlay fixture: ${fixture.stderr}`);
    }

    const base = testManifest();
    const primary = base.tracks.find((track) =>
      track.kind === "display-video" && track.source.displayId === "display-primary"
    );
    if (primary === undefined) throw new Error("Missing primary fixture track.");
    const primarySegment = primary.segments[0]!;
    if (primarySegment.timing.kind !== "legacy-estimate") throw new Error("Expected legacy fixture timing.");
    const manifest = await materializeManifestMedia(temporary, RecordingManifestV1Schema.parse({
      ...base,
      capture: { ...base.capture, typedText: "enabled" },
      timeline: { durationUs: 1_000_000, timebase: "microseconds" },
      tracks: [{
        ...primary,
        segments: [{
          ...primarySegment,
          endUs: 1_000_000,
          fileRange: { endUs: 1_000_000, startUs: 0 },
          timing: {
            ...primarySegment.timing,
            nativeRange: { endUs: 2_000_000, startUs: 1_000_000 },
          },
        }],
      }],
    }));
    const runtimeOverlays: readonly OverlayOperation[] = ([
      {
        ...overlay("overlay_runtime_img", 0, overlaySource({
          asset: importedAsset("assets/runtime.png", "image/png"),
          kind: "image",
        })),
        blendMode: "screen",
        crop: { bottom: 0.05, kind: "normalized-insets", left: 0.05, right: 0.05, top: 0.05 },
        fit: "cover",
        mask: { kind: "rounded-rectangle", radiusPx: 6 },
        motion: {
          keyframes: [{
            easing: { kind: "ease-in-out" },
            offset: 0,
            opacityMultiplier: 0.25,
            positionOffset: { x: -10, y: 0 },
            rotationOffsetDegrees: -3,
            scaleMultiplier: 0.8,
          }, {
            easing: { kind: "linear" },
            offset: 1,
            opacityMultiplier: 1,
            positionOffset: { x: 10, y: 0 },
            rotationOffsetDegrees: 3,
            scaleMultiplier: 1,
          }],
          kind: "keyframes",
          timeline: "visible-output",
        },
        size: { height: 40, kind: "pixels", width: 64 },
      },
      overlay("overlay_runtime_svg", 1, overlaySource({
        asset: importedAsset("assets/runtime.svg", "image/svg+xml"),
        kind: "svg",
      })),
      overlay("overlay_runtime_emoji", 2, overlaySource({
        asset: importedAsset("assets/runtime-emoji.png", "image/png"),
        kind: "emoji",
        provider: "apple-emoji-pack",
        selector: { kind: "unicode", value: "🎬" },
      })),
      overlay("overlay_runtime_gif", 3, overlaySource({
        asset: importedAsset("assets/runtime.gif", "image/gif"),
        audioPolicy: { kind: "mute" },
        kind: "gif",
        playback: { endBehavior: "loop", playbackRate: 1, sourceInUs: 0, sourceOutUs: 400_000 },
      })),
      overlay("overlay_runtime_vid", 4, overlaySource({
        asset: importedAsset("assets/runtime.mp4", "video/mp4"),
        audioPolicy: { kind: "mute" },
        kind: "video",
        playback: { endBehavior: "freeze-end", playbackRate: 1, sourceInUs: 0, sourceOutUs: 400_000 },
      })),
    ] satisfies readonly OverlayOperation[]).map((operation) => ({
      ...operation,
      range: { endUs: 900_000, startUs: 100_000 },
    }));
    const plan = normalizeEditPlan({
      ...createDefaultEditPlan(manifest, testPlan().planId, "2026-07-22T12:00:00.000Z"),
      effects: {
        clicks: { color: "#ffcc00cc", durationUs: 250_000, enabled: true, radiusPx: 12, style: "pulse" },
        cursor: { enabled: true, scale: 1, smoothing: { algorithm: "none", strength: 0 }, style: "dot" },
        keystrokes: {
          enabled: true,
          holdUs: 300_000,
          maxKeys: 4,
          position: "bottom-right",
          secureText: "hide",
        },
        typedText: {
          enabled: true,
          idleTimeoutUs: 300_000,
          maxCharacters: 100,
          placement: "input",
          secureText: "hide",
        },
      },
      overlays: runtimeOverlays,
      zooms: [{
        displayId: "display-primary",
        easing: { kind: "ease-in-out" },
        enterDurationUs: 100_000,
        exitDurationUs: 100_000,
        kind: "manual",
        range: { endUs: 900_000, startUs: 100_000 },
        scale: 2,
        target: { kind: "point", point: { x: 100, y: 100 } },
        zoomId: "zoom_runtime001",
      }],
    });
    const window = {
      applicationBundleId: "com.example",
      applicationName: "Example",
      bounds: { height: 100, width: 200, x: 0, y: 0 },
      displayId: "display-primary",
      isFocused: true,
      layer: 1,
      title: { state: "available", value: "Example" },
      windowId: "window-primary",
    } as const;
    const eventValues = [
      { nativeTimeUs: 0, sequence: 0, sourceTimeUs: 0, type: "window.snapshot", windows: [window] },
      {
        button: "left",
        clickCount: 1,
        displayId: "display-primary",
        nativeTimeUs: 200_000,
        phase: "down",
        position: { x: 100, y: 100 },
        sequence: 1,
        sourceTimeUs: 200_000,
        type: "mouse.click",
      },
      {
        activity: {
          control: "enter",
          kind: "control",
          modifiers: [],
          phase: "down",
          repeat: false,
        },
        nativeTimeUs: 300_000,
        sequence: 2,
        sourceTimeUs: 300_000,
        type: "key.activity",
      },
      {
        input: {
          action: "insert",
          bounds: { height: 30, width: 100, x: 50, y: 50 },
          fieldId: "field-primary",
          secure: false,
          text: "ok",
          windowId: "window-primary",
        },
        nativeTimeUs: 400_000,
        sequence: 3,
        sourceTimeUs: 400_000,
        type: "typing.input",
      },
    ];
    const events = eventValues.map((event) => RecordingEventV1Schema.parse(event));
    const compiled = compileRenderPlan(manifest, plan, events, {
      audioTrackIds: [],
      camera: { kind: "none" },
      displayTrackId: primary.trackId,
      frameRate: 30,
      pixelHeight: 180,
      pixelWidth: 320,
    });
    const render: typeof compiled = {
      ...compiled,
      effects: {
        ...compiled.effects,
        cursorSamples: [{
          coordinateSpace: "output-pixels",
          displayId: "display-primary",
          outputTimeUs: 100_000,
          position: { x: 40, y: 40 },
          sourceTimeUs: 100_000,
          visible: true,
        }, {
          coordinateSpace: "output-pixels",
          displayId: "display-primary",
          outputTimeUs: 800_000,
          position: { x: 240, y: 120 },
          sourceTimeUs: 800_000,
          visible: true,
        }],
      },
    };
    const output = join(renderDirectory, "output.mp4");
    const built = await buildFfmpegInvocation(manifest, render, {
      bundleRoot: temporary,
      ffmpeg: FFMPEG,
      outputPath: output,
      overlaySources: [
        { audioStreamIndex: null, overlayId: "overlay_runtime_img", path: imagePath, videoStreamIndex: null },
        { audioStreamIndex: null, overlayId: "overlay_runtime_svg", path: imagePath, videoStreamIndex: null },
        { audioStreamIndex: null, overlayId: "overlay_runtime_emoji", path: imagePath, videoStreamIndex: null },
        { audioStreamIndex: null, overlayId: "overlay_runtime_gif", path: gifPath, videoStreamIndex: null },
        { audioStreamIndex: null, overlayId: "overlay_runtime_vid", path: videoPath, videoStreamIndex: null },
      ],
    });
    const filter = await readFilterGraph(built.argv);
    expect(filter).toContain("blend=all_mode=screen");
    expect(filter).toContain("alphaextract");
    expect(filter).toContain("maskedmerge");
    expect(filter).toContain("geq=r='r(X,Y)'");
    expect(filter).toContain("between(T,0.1,0.9)");
    expect(filter).toContain("force_original_aspect_ratio=increase");
    const rendered = await runProcess(built.argv);
    if (rendered.exitCode !== 0) throw new Error(`Metadata compositor failed: ${rendered.stderr}`);
    expect((await stat(output)).size).toBeGreaterThan(0);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}, 20_000);
