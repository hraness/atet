import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import {
  OverlayOperationSchema,
  ProjectRenderPlanV1Schema,
  type OverlayOperation,
  type ProjectRenderPlanV1,
} from "../contracts";
import { buildProjectFfmpegInvocation } from "./project-renderer";
import type { ProcessRunner, RunResult } from "./io";

const HASH = "1".repeat(64);
const FFMPEG = Bun.which("ffmpeg");
const FFPROBE = Bun.which("ffprobe");
const RSVG_CONVERT = Bun.which("rsvg-convert");

const DISABLED_METADATA_EFFECTS: ProjectRenderPlanV1["effects"] = {
  clickCues: [],
  clicks: { enabled: false },
  cursor: { enabled: false },
  cursorSamples: [],
  keystrokeCues: [],
  keystrokes: { enabled: false },
  typedText: { enabled: false },
  typingSpans: [],
};

async function runProcess(argv: readonly [string, ...string[]]): Promise<RunResult> {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function readFilterGraph(argv: readonly string[]): Promise<string> {
  const index = argv.indexOf("-filter_complex_script");
  if (index < 0 || argv[index + 1] === undefined) throw new Error("Missing FFmpeg filter graph script.");
  return await readFile(argv[index + 1]!, "utf8");
}

const runner: ProcessRunner = { run: argv => runProcess(argv) };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

function integrity(contents: string | Uint8Array) {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function fileIntegrity(path: string) {
  return integrity(await readFile(path));
}

function importedAsset<const MediaType extends OverlayOperation["source"]["asset"]["mediaType"]>(
  path: string,
  mediaType: MediaType,
) {
  const originalName = path.split("/").at(-1)!;
  const contents = originalName === "vector.svg"
    ? "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'></svg>"
    : originalName;
  const expected = integrity(contents);
  return {
    ...expected,
    mediaType,
    path,
    provenance: { kind: "imported" as const, originalName, sourceSha256: expected.sha256 },
  };
}

function overlay(
  overlayId: string,
  zIndex: number,
  source: OverlayOperation["source"],
): OverlayOperation {
  return {
    anchor: "center",
    coordinateSpace: "output-pixels",
    entrance: { kind: "none" },
    exit: { kind: "none" },
    intrinsicSize: { height: 64, width: 64 },
    opacity: 1,
    overlayId,
    position: { x: 0, y: 0 },
    range: { endUs: 2_000_000, startUs: 0 },
    rotationDegrees: 0,
    scale: 1,
    size: { kind: "intrinsic" },
    source,
    zIndex,
  };
}

function resolved(operation: OverlayOperation): ProjectRenderPlanV1["overlays"][number] {
  return {
    operation: OverlayOperationSchema.parse(operation),
    outputRange: { endUs: 2_000_000, startUs: 0 },
    playbackOffsetUs: 0,
    projectRange: { endUs: 2_000_000, startUs: 0 },
    visibleDurationUs: 2_000_000,
  };
}

function renderPlan(input: Partial<ProjectRenderPlanV1> = {}): ProjectRenderPlanV1 {
  return ProjectRenderPlanV1Schema.parse({
    audioSlices: [],
    cameraKeyframes: [],
    cameraSegments: [],
    effects: DISABLED_METADATA_EFFECTS,
    kind: "studio.project-render-plan",
    output: {
      background: "#000000ff",
      durationUs: 2_000_000,
      frameRate: 30,
      pixelHeight: 720,
      pixelWidth: 1_280,
    },
    overlays: [],
    planSha256: HASH,
    projectEditPlanSha256: HASH,
    projectId: "project_integrity01",
    projectStructureSha256: HASH,
    schemaVersion: 1,
    videoSlices: [],
    warnings: [],
    ...input,
  });
}

test("uses explicit preview and final encoder recipes without changing v1 compatibility", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-render-tier-"));
  try {
    const requestedProjectDirectory = join(
      repositoryRoot,
      "artifacts/atet/projects/project_integrity01",
    );
    await mkdir(join(requestedProjectDirectory, "renders"), { recursive: true });
    const projectDirectory = await realpath(requestedProjectDirectory);
    const build = async (
      output: string,
      renderTier?: "preview" | "final",
    ) => await buildProjectFfmpegInvocation(renderPlan(), {
      dryRun: true,
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, `renders/${output}.mp4`),
      projectDirectory,
      ...(renderTier === undefined ? {} : { renderTier }),
      repositoryRoot,
    });
    const [legacy, preview, final] = await Promise.all([
      build("legacy"),
      build("preview", "preview"),
      build("final", "final"),
    ]);
    expect(legacy.argv).not.toContain("-preset");
    expect(legacy.argv).not.toContain("-crf");
    expect(legacy.argv).not.toContain("-filter_complex_threads");
    expect(preview.argv.slice(
      preview.argv.indexOf("-c:v") + 2,
      preview.argv.indexOf("-c:v") + 10,
    )).toEqual([
      "-threads:v", "1",
      "-preset", "veryfast", "-crf", "28", "-b:a", "128k",
    ]);
    expect(final.argv.slice(
      final.argv.indexOf("-c:v") + 2,
      final.argv.indexOf("-c:v") + 10,
    )).toEqual([
      "-threads:v", "1",
      "-preset", "medium", "-crf", "18", "-b:a", "192k",
    ]);
    expect(preview.argv[preview.argv.indexOf("-filter_threads") + 1]).toBe("1");
    expect(preview.argv[preview.argv.indexOf("-filter_complex_threads") + 1]).toBe("1");
    expect(preview.invocation.arguments).toEqual(preview.argv.slice(1));
    expect(final.invocation.arguments).toEqual(final.argv.slice(1));
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("reuses one SVG sprite input across independently timed caption crops", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-caption-sprite-renderer-"));
  try {
    const requestedProjectDirectory = join(
      repositoryRoot,
      "artifacts/atet/projects/project_captionsprite",
    );
    await Promise.all([
      mkdir(join(requestedProjectDirectory, "assets"), { recursive: true }),
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);
    const spriteContents = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128">',
      '<rect width="256" height="64" fill="white"/>',
      '<rect y="64" width="256" height="64" fill="yellow"/>',
      "</svg>",
    ].join("");
    await writeFile(join(projectDirectory, "assets/captions.svg"), spriteContents);
    const spriteIntegrity = integrity(spriteContents);
    const source = {
      asset: {
        ...spriteIntegrity,
        mediaType: "image/svg+xml" as const,
        path: "assets/captions.svg",
        provenance: {
          kind: "imported" as const,
          originalName: "captions.svg",
          sourceSha256: spriteIntegrity.sha256,
        },
      },
      kind: "svg" as const,
    };
    const cue = (
      range: { readonly endUs: number; readonly startUs: number },
      crop: { readonly bottom: number; readonly top: number },
    ) => ProjectRenderPlanV1Schema.shape.overlays.element.parse({
      operation: OverlayOperationSchema.parse({
        ...overlay("overlay_caption_sprite01", 10, source),
        anchor: "bottom",
        crop: {
          ...crop,
          kind: "normalized-insets",
          left: 0,
          right: 0,
        },
        intrinsicSize: { height: 128, width: 256 },
        range,
        size: { height: 64, kind: "pixels", width: 256 },
      }),
      outputRange: range,
      playbackOffsetUs: 0,
      projectRange: range,
      visibleDurationUs: range.endUs - range.startUs,
    });
    const plan = renderPlan({
      overlays: [
        cue({ endUs: 900_000, startUs: 100_000 }, { bottom: 0.5, top: 0 }),
        cue({ endUs: 1_900_000, startUs: 1_100_000 }, { bottom: 0, top: 0.5 }),
      ],
    });
    const built = await buildProjectFfmpegInvocation(plan, {
      dryRun: true,
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders/output.mp4"),
      projectDirectory,
      renderTier: "preview",
      repositoryRoot,
      rsvgConvert: "rsvg-convert",
      rsvgConvertVersion: "rsvg-convert version fixture",
      runner: {
        run: () => Promise.reject(new Error("Caption sprite dry run must not spawn.")),
      },
    });
    const filter = await readFilterGraph(built.argv);
    expect(built.argv.filter(argument => argument === "-i")).toHaveLength(1);
    const inputIndex = built.argv.indexOf("-i");
    expect(built.argv.slice(inputIndex - 2, inputIndex)).toEqual([
      "-threads",
      "1",
    ]);
    expect(filter.match(/crop=w=/gu)).toHaveLength(2);
    expect(filter).toContain("between(t,0.1,0.9)");
    expect(filter).toContain("between(t,1.1,1.9)");
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("rasterizes owned caption sprites deterministically with Resvg and the vendored font", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-caption-resvg-renderer-"));
  try {
    const requestedProjectDirectory = join(
      repositoryRoot,
      "artifacts/atet/projects/project_captionresvg",
    );
    await Promise.all([
      mkdir(join(requestedProjectDirectory, "renders/caption-assets"), { recursive: true }),
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);
    const spriteContents = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128" fill="none">',
      '<text x="128" y="78" fill="#ffffff" font-family="Nebula Sans" font-size="40" font-weight="700" text-anchor="middle">More is more</text>',
      "</svg>",
    ].join("");
    const spriteIntegrity = integrity(spriteContents);
    const spritePath = `renders/caption-assets/${spriteIntegrity.sha256}.svg`;
    await writeFile(join(projectDirectory, spritePath), spriteContents);
    const operation: OverlayOperation = {
      ...overlay("overlay_caption_resvg01", 10, {
        asset: {
          ...spriteIntegrity,
          mediaType: "image/svg+xml",
          path: spritePath,
          provenance: {
            command: ["atet", "caption", "social-block-v1"],
            generator: "atet-social-caption-sprite",
            generatorVersion: "1",
            kind: "generated",
            sourceSha256: HASH,
          },
        },
        kind: "svg",
      }),
      intrinsicSize: { height: 128, width: 256 },
    };
    const plan = renderPlan({ overlays: [resolved(operation)] });
    const options = {
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders/output.mp4"),
      projectDirectory,
      repositoryRoot,
    } as const;

    const first = await buildProjectFfmpegInvocation(plan, options);
    const firstInput = first.argv[first.argv.indexOf("-i") + 1];
    expect(firstInput).toBeDefined();
    const firstPng = await readFile(firstInput!);
    const firstDigest = createHash("sha256").update(firstPng).digest("hex");
    expect(firstDigest).toBe("7b943454e799258c646a52800112866f1bbe73c4c2f3834cfed4c5f9fe220fca");
    const metadata = await sharp(firstPng).metadata();
    const visiblePixels = (await sharp(firstPng).ensureAlpha().raw().toBuffer())
      .reduce((count, value, index) => count + (index % 4 === 3 && value > 0 ? 1 : 0), 0);
    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(128);
    expect(visiblePixels).toBeGreaterThan(100);

    const cacheDirectory = join(projectDirectory, "renders/.overlay-cache");
    const manifestName = (await readdir(cacheDirectory)).find(name => name.endsWith(".json"));
    expect(manifestName).toBeDefined();
    const manifest = JSON.parse(await readFile(join(cacheDirectory, manifestName!), "utf8")) as {
      readonly recipe: {
        readonly arguments: {
          readonly defaultFontFamily: string;
          readonly fontBytes: number;
          readonly fontSha256: string;
          readonly fontWeight: number;
          readonly loadSystemFonts: boolean;
        };
        readonly renderer: string;
        readonly rendererVersion: string;
        readonly source: {
          readonly bytes: number;
          readonly mediaType: string;
          readonly pixelHeight: number;
          readonly pixelWidth: number;
          readonly sha256: string;
        };
        readonly version: string;
      };
    };
    expect(manifest.recipe).toEqual({
      arguments: {
        defaultFontFamily: "Nebula Sans",
        fontBytes: 145_348,
        fontSha256: "91617d3e2281e8213f64f6bf359f387022d3149b35000b38365c32130a25bfa8",
        fontWeight: 700,
        loadSystemFonts: false,
      },
      renderer: "@resvg/resvg-js",
      rendererVersion: "2.6.2",
      source: {
        bytes: spriteIntegrity.bytes,
        mediaType: "image/svg+xml",
        pixelHeight: 128,
        pixelWidth: 256,
        sha256: spriteIntegrity.sha256,
      },
      version: "atet-caption-resvg-v1",
    });

    await rm(cacheDirectory, { recursive: true });
    const second = await buildProjectFfmpegInvocation(plan, options);
    const secondInput = second.argv[second.argv.indexOf("-i") + 1];
    expect(secondInput).toBeDefined();
    const secondPng = await readFile(secondInput!);
    expect(createHash("sha256").update(secondPng).digest("hex")).toBe(firstDigest);
    expect(secondPng).toEqual(firstPng);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("builds project overlays for image, SVG, emoji, looping GIF, and audible frozen video", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-overlay-test-"));
  try {
    const requestedProjectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_overlaytest");
    await mkdir(join(requestedProjectDirectory, "renders"), { recursive: true });
    const assetDirectory = join(requestedProjectDirectory, "assets");
    await mkdir(assetDirectory, { recursive: true });
    const projectDirectory = await realpath(requestedProjectDirectory);
    for (const name of ["image.png", "vector.svg", "emoji.png", "motion.gif", "clip.mp4"]) {
      await writeFile(
        join(assetDirectory, name),
        name === "vector.svg"
          ? "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'></svg>"
          : name,
      );
    }

    const image: OverlayOperation = {
      ...overlay("overlay_project_image", 0, {
        asset: importedAsset("assets/image.png", "image/png"),
        kind: "image",
      }),
      blendMode: "multiply",
      crop: { bottom: 0.1, kind: "normalized-insets", left: 0.1, right: 0.1, top: 0.1 },
      fit: "cover",
      mask: { kind: "rounded-rectangle", radiusPx: 18 },
      motion: {
        keyframes: [{
          easing: { kind: "ease-in-out" },
          offset: 0,
          opacityMultiplier: 0.2,
          positionOffset: { x: -40, y: 0 },
          rotationOffsetDegrees: -10,
          scaleMultiplier: 0.75,
        }, {
          easing: { kind: "linear" },
          offset: 1,
          opacityMultiplier: 1,
          positionOffset: { x: 40, y: 0 },
          rotationOffsetDegrees: 10,
          scaleMultiplier: 1,
        }],
        kind: "keyframes",
        timeline: "visible-output",
      },
      size: { height: 180, kind: "pixels", width: 320 },
    };
    const svg = overlay("overlay_project_svg01", 1, {
      asset: importedAsset("assets/vector.svg", "image/svg+xml"),
      kind: "svg",
    });
    const emoji: OverlayOperation = {
      ...overlay("overlay_project_emoji", 2, {
        asset: importedAsset("assets/emoji.png", "image/png"),
        kind: "emoji",
        provider: "brand-catalog",
        selector: { kind: "name", value: "atet" },
      }),
      fit: "contain",
      size: { height: 96, kind: "pixels", width: 96 },
    };
    const gif = overlay("overlay_project_gif01", 3, {
      asset: importedAsset("assets/motion.gif", "image/gif"),
      audioPolicy: { kind: "mute" },
      kind: "gif",
      playback: { endBehavior: "loop", playbackRate: 2, sourceInUs: 100_000, sourceOutUs: 600_000 },
    });
    const video = overlay("overlay_project_video", 4, {
      asset: importedAsset("assets/clip.mp4", "video/mp4"),
      audioPolicy: { duckPrimaryTo: 0.3, kind: "duck-primary", volume: 0.6 },
      kind: "video",
      playback: {
        audioEndUs: 400_000,
        audioStartUs: 250_000,
        endBehavior: "freeze-end",
        playbackRate: 1,
        sourceInUs: 0,
        sourceOutUs: 500_000,
      },
    });
    const plan = ProjectRenderPlanV1Schema.parse({
      audioSlices: [],
      cameraKeyframes: [],
      cameraSegments: [],
      effects: DISABLED_METADATA_EFFECTS,
      kind: "studio.project-render-plan",
      output: {
        background: "#000000ff",
        durationUs: 2_000_000,
        frameRate: 30,
        pixelHeight: 720,
        pixelWidth: 1_280,
      },
      overlays: [image, svg, emoji, gif, video].map(resolved),
      planSha256: HASH,
      projectEditPlanSha256: HASH,
      projectId: "project_overlaytest",
      projectStructureSha256: HASH,
      schemaVersion: 1,
      videoSlices: [],
      warnings: [],
    });
    const built = await buildProjectFfmpegInvocation(plan, {
      dryRun: true,
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      ffprobe: "ffprobe-test",
      outputPath: join(projectDirectory, "renders/output.mp4"),
      projectDirectory,
      repositoryRoot,
      rsvgConvert: "/opt/homebrew/bin/rsvg-convert",
      rsvgConvertVersion: "rsvg-convert version 2.58.0",
      runner: {
        run: () => Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: '{"format":{"duration":"1"},"streams":[{"codec_type":"video","disposition":{"attached_pic":1},"height":600,"index":0,"width":600},{"codec_type":"video","duration":"1","height":64,"index":6,"width":64},{"codec_type":"audio","duration":"1","index":8}]}',
        }),
      },
    });
    const filter = await readFilterGraph(built.argv);

    expect(filter).toContain("crop=w='iw*0.8'");
    expect(filter).toContain("force_original_aspect_ratio=increase");
    expect(filter).toContain("force_original_aspect_ratio=decrease");
    expect(filter).toContain("geq=r='r(X,Y)'");
    expect(filter).toContain("between(T,0,2)");
    expect(filter).toContain("blend=all_mode=multiply");
    expect(filter).toContain("alphaextract");
    expect(filter).toContain("maskedmerge");
    expect(filter).toContain("loop=loop=-1");
    expect(filter).toContain("tpad=stop_mode=clone");
    expect(filter).toContain("volume=0.6");
    expect(filter).toContain("[3:6]");
    expect(filter).toContain("[4:6]");
    expect(filter).toContain("[4:8]");
    expect(filter).not.toContain("[3:v:0]");
    expect(filter).not.toContain("[4:v:0]");
    expect(filter).not.toContain("[4:a:0]");
    expect(filter).toContain("volume='if(between(t,0.25,0.4),0.3,1)'");
    expect(filter).not.toContain("volume='if(between(t,0,0.5),0.3,1)'");
    expect(built.argv.filter(argument => argument === "-loop")).toHaveLength(3);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test.skipIf(FFMPEG === null || FFPROBE === null || RSVG_CONVERT === null)(
  "executes image, SVG, emoji, animated GIF, and audible video overlays with FFmpeg",
  async () => {
    if (FFMPEG === null || FFPROBE === null || RSVG_CONVERT === null) return;
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-overlay-exec-"));
    try {
      const requestedProjectDirectory = join(
        repositoryRoot,
        "artifacts/atet/projects/project_overlayexec",
      );
      const assetDirectory = join(requestedProjectDirectory, "assets");
      await Promise.all([
        mkdir(assetDirectory, { recursive: true }),
        mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
      ]);
      const projectDirectory = await realpath(requestedProjectDirectory);
      const imagePath = join(assetDirectory, "image.png");
      const svgPath = join(assetDirectory, "vector.svg");
      const emojiPath = join(assetDirectory, "emoji.png");
      const gifPath = join(assetDirectory, "motion.gif");
      const videoPath = join(assetDirectory, "clip.mp4");
      const generatedFixtures: readonly (readonly [readonly string[], string])[] = [
        [[
          "-f", "lavfi", "-i", "color=c=red:s=16x16:d=0.1",
          "-frames:v", "1",
          imagePath,
        ], "image"],
        [[
          "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1",
          "-frames:v", "1",
          emojiPath,
        ], "emoji"],
        [[
          "-f", "lavfi", "-i", "color=c=yellow:s=16x16:r=10:d=0.3",
          "-f", "lavfi", "-i", "color=c=magenta:s=16x16:r=10:d=0.3",
          "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=rgb24[out]",
          "-map", "[out]",
          gifPath,
        ], "GIF"],
        [[
          "-f", "lavfi", "-i", "color=c=cyan:s=16x16:r=30:d=0.3",
          "-f", "lavfi", "-i", "color=c=white:s=16x16:r=30:d=0.3",
          "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=0.6",
          "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[out]",
          "-map", "[out]", "-map", "2:a:0",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
          videoPath,
        ], "video"],
      ];
      for (const [arguments_, label] of generatedFixtures) {
        const generated = await runProcess([
          FFMPEG,
          "-hide_banner", "-loglevel", "error", "-y",
          ...arguments_,
        ]);
        if (generated.exitCode !== 0) {
          throw new Error(`Could not generate ${label} overlay fixture: ${generated.stderr}`);
        }
      }
      const svgContents = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
        '<rect width="16" height="16" fill="#00ff00"/>',
        "</svg>",
      ].join("");
      await writeFile(svgPath, svgContents);

      const [imageIntegrity, emojiIntegrity, gifIntegrity, videoIntegrity] = await Promise.all([
        fileIntegrity(imagePath),
        fileIntegrity(emojiPath),
        fileIntegrity(gifPath),
        fileIntegrity(videoPath),
      ]);
      const svgIntegrity = integrity(svgContents);
      const imported = <const MediaType extends
        "image/gif" | "image/png" | "image/svg+xml" | "video/mp4">(
        path: string,
        originalName: string,
        mediaType: MediaType,
        expected: Readonly<{ readonly bytes: number; readonly sha256: string }>,
      ) => ({
        ...expected,
        mediaType,
        path,
        provenance: {
          kind: "imported" as const,
          originalName,
          sourceSha256: expected.sha256,
        },
      });
      const durationUs = 600_000;
      const placed = (
        overlayId: string,
        zIndex: number,
        x: number,
        source: OverlayOperation["source"],
      ): ProjectRenderPlanV1["overlays"][number]["operation"] => OverlayOperationSchema.parse({
        ...overlay(overlayId, zIndex, source),
        anchor: "top-left",
        intrinsicSize: { height: 16, width: 16 },
        position: { x, y: 8 },
        range: { endUs: durationUs, startUs: 0 },
      });
      const operations = [
        placed("overlay_exec_image", 0, 0, {
          asset: imported("assets/image.png", "image.png", "image/png", imageIntegrity),
          kind: "image",
        }),
        placed("overlay_exec_svg01", 1, 32, {
          asset: imported("assets/vector.svg", "vector.svg", "image/svg+xml", svgIntegrity),
          kind: "svg",
        }),
        placed("overlay_exec_emoji", 2, 64, {
          asset: imported("assets/emoji.png", "emoji.png", "image/png", emojiIntegrity),
          kind: "emoji",
          provider: "brand-catalog",
          selector: { kind: "name", value: "atet" },
        }),
        placed("overlay_exec_gif01", 3, 96, {
          asset: imported("assets/motion.gif", "motion.gif", "image/gif", gifIntegrity),
          audioPolicy: { kind: "mute" },
          kind: "gif",
          playback: {
            endBehavior: "hide",
            playbackRate: 1,
            sourceInUs: 0,
            sourceOutUs: durationUs,
          },
        }),
        placed("overlay_exec_video", 4, 128, {
          asset: imported("assets/clip.mp4", "clip.mp4", "video/mp4", videoIntegrity),
          audioPolicy: { kind: "mix", volume: 1 },
          kind: "video",
          playback: {
            endBehavior: "hide",
            playbackRate: 1,
            sourceInUs: 0,
            sourceOutUs: durationUs,
          },
        }),
      ] satisfies readonly ProjectRenderPlanV1["overlays"][number]["operation"][];
      const range = { endUs: durationUs, startUs: 0 };
      const plan = renderPlan({
        output: {
          background: "#000000ff",
          durationUs,
          frameRate: 30,
          pixelHeight: 96,
          pixelWidth: 160,
        },
        overlays: operations.map(operation => ({
          operation,
          outputRange: range,
          playbackOffsetUs: 0,
          projectRange: range,
          visibleDurationUs: durationUs,
        })),
        projectId: ProjectRenderPlanV1Schema.shape.projectId.parse("project_overlayexec"),
      });
      const outputPath = join(projectDirectory, "renders", "overlay-proof.mp4");
      const built = await buildProjectFfmpegInvocation(plan, {
        ffmpeg: FFMPEG,
        ffprobe: FFPROBE,
        outputPath,
        projectDirectory,
        repositoryRoot,
        rsvgConvert: RSVG_CONVERT,
        rsvgConvertVersion: "rsvg-convert integration-test",
        runner,
      });
      const filter = await readFilterGraph(built.argv);
      expect(filter.match(/\]overlay=x=/gu)).toHaveLength(5);
      expect(filter).toContain("volume=1");
      expect(filter).toContain("graphic_audio_");
      const rendered = await runProcess(built.argv);
      if (rendered.exitCode !== 0) throw new Error(`Overlay render failed: ${rendered.stderr}`);
      expect((await stat(outputPath)).size).toBeGreaterThan(1_000);

      const extractFrame = async (at: string, name: string): Promise<Buffer> => {
        const path = join(projectDirectory, "renders", name);
        const extracted = await runProcess([
          FFMPEG,
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", outputPath, "-ss", at, "-frames:v", "1",
          "-pix_fmt", "rgb24", "-f", "rawvideo", path,
        ]);
        if (extracted.exitCode !== 0) throw new Error(extracted.stderr);
        const frame = await readFile(path);
        expect(frame.byteLength).toBe(160 * 96 * 3);
        return frame;
      };
      const pixel = (frame: Buffer, x: number, y: number): readonly [number, number, number] => {
        const offset = (y * 160 + x) * 3;
        return [frame[offset]!, frame[offset + 1]!, frame[offset + 2]!];
      };
      const early = await extractFrame("0.12", "early.rgb");
      const late = await extractFrame("0.45", "late.rgb");
      const [red, green, blue, earlyGif, earlyVideo] = [8, 40, 72, 104, 136]
        .map(x => pixel(early, x, 16));
      const lateGif = pixel(late, 104, 16);
      const lateVideo = pixel(late, 136, 16);
      expect(red![0]).toBeGreaterThan(180);
      expect(red![1]).toBeLessThan(80);
      expect(green![1]).toBeGreaterThan(140);
      expect(green![0]).toBeLessThan(80);
      expect(blue![2]).toBeGreaterThan(180);
      expect(blue![0]).toBeLessThan(80);
      expect(earlyGif![0]).toBeGreaterThan(150);
      expect(earlyGif![1]).toBeGreaterThan(150);
      expect(earlyGif![2]).toBeLessThan(100);
      expect(lateGif[0]).toBeGreaterThan(150);
      expect(lateGif[1]).toBeLessThan(100);
      expect(lateGif[2]).toBeGreaterThan(150);
      expect(earlyVideo![0]).toBeLessThan(100);
      expect(earlyVideo![1]).toBeGreaterThan(150);
      expect(earlyVideo![2]).toBeGreaterThan(150);
      expect(lateVideo.every(channel => channel > 180)).toBe(true);

      const audioPath = join(projectDirectory, "renders", "overlay-audio.s16le");
      const extractedAudio = await runProcess([
        FFMPEG,
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", outputPath, "-vn", "-ac", "1", "-ar", "48000",
        "-f", "s16le", audioPath,
      ]);
      if (extractedAudio.exitCode !== 0) throw new Error(extractedAudio.stderr);
      const audio = await readFile(audioPath);
      let sumOfSquares = 0;
      for (let offset = 0; offset + 1 < audio.length; offset += 2) {
        const sample = audio.readInt16LE(offset);
        sumOfSquares += sample * sample;
      }
      const sampleCount = Math.floor(audio.length / 2);
      expect(sampleCount).toBeGreaterThan(20_000);
      expect(Math.sqrt(sumOfSquares / sampleCount)).toBeGreaterThan(1_000);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  },
  20_000,
);

test("buffers project overlay loops only when playback crosses the source end", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-overlay-loop-test-"));
  try {
    const requestedProjectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_overlayloop");
    const assetDirectory = join(requestedProjectDirectory, "assets");
    await Promise.all([
      mkdir(assetDirectory, { recursive: true }),
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(assetDirectory, "long.mp4"), "long.mp4"),
      writeFile(join(assetDirectory, "short.mp4"), "short.mp4"),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);

    const loopingVideo = (
      overlayId: string,
      path: string,
      sourceOutUs: number,
      durationUs: number,
      audioWindow?: { readonly endUs: number; readonly startUs: number },
    ): ProjectRenderPlanV1["overlays"][number] => {
      const operation: OverlayOperation = {
        ...overlay(overlayId, 0, {
          asset: importedAsset(path, "video/mp4"),
          audioPolicy: audioWindow === undefined
            ? { kind: "mix", volume: 1 }
            : { duckPrimaryTo: 0.4, kind: "duck-primary", volume: 1 },
          kind: "video",
          playback: {
            ...(audioWindow === undefined
              ? {}
              : { audioEndUs: audioWindow.endUs, audioStartUs: audioWindow.startUs }),
            endBehavior: "loop",
            playbackRate: 1,
            sourceInUs: 0,
            sourceOutUs,
          },
        }),
        range: { endUs: durationUs, startUs: 0 },
      };
      return ProjectRenderPlanV1Schema.shape.overlays.element.parse({
        operation,
        outputRange: { endUs: durationUs, startUs: 0 },
        playbackOffsetUs: 0,
        projectRange: { endUs: durationUs, startUs: 0 },
        visibleDurationUs: durationUs,
      });
    };
    const plan = renderPlan({
      output: {
        background: "#000000ff",
        durationUs: 3_000_000,
        frameRate: 30,
        pixelHeight: 720,
        pixelWidth: 1_280,
      },
      overlays: [
        loopingVideo("overlay_long_loop01", "assets/long.mp4", 300_000_000, 1_000_000),
        loopingVideo(
          "overlay_short_loop1",
          "assets/short.mp4",
          1_000_000,
          3_000_000,
          { endUs: 750_000, startUs: 250_000 },
        ),
      ],
    });
    const built = await buildProjectFfmpegInvocation(plan, {
      dryRun: true,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe-test",
      outputPath: join(projectDirectory, "renders/output.mp4"),
      projectDirectory,
      repositoryRoot,
      runner: {
        run: () => Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: '{"format":{"duration":"300"},"streams":[{"codec_type":"video","duration":"300","height":64,"index":0,"width":64},{"codec_type":"audio","duration":"300","index":1}]}',
        }),
      },
    });
    const filter = await readFilterGraph(built.argv);

    expect(filter.match(/(?<!a)loop=loop=-1/gu)).toHaveLength(1);
    expect(filter.match(/aloop=loop=-1/gu)).toHaveLength(1);
    expect(filter).toContain("format=rgba,loop=loop=-1:size=30:start=0");
    expect(filter).toContain("apad=pad_dur=0.25,atrim=duration=1,aformat=sample_fmts=flt:channel_layouts=stereo,aloop=loop=-1:size=48000");
    expect(filter).toContain("volume='if(between(t,0,3)*gte(mod(0+(t-0)*1,1),0.25)*lt(mod(0+(t-0)*1,1),0.75),0.4,1)'");
    expect(filter).not.toContain("trim=start=0:end=300");
    expect(filter).not.toContain("atrim=start=0:end=300");
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("ducks only project primary audio when an earlier overlay is already mixed", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-overlay-duck-test-"));
  try {
    const requestedProjectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_overlayduck");
    const assetDirectory = join(requestedProjectDirectory, "assets");
    await Promise.all([
      mkdir(assetDirectory, { recursive: true }),
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(assetDirectory, "mixed.mp4"), "mixed.mp4"),
      writeFile(join(assetDirectory, "duck.mp4"), "duck.mp4"),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);

    const animatedOverlay = (
      overlayId: string,
      zIndex: number,
      path: string,
      audioPolicy: Extract<OverlayOperation["source"], { readonly kind: "video" }>["audioPolicy"],
    ): OverlayOperation => overlay(overlayId, zIndex, {
      asset: importedAsset(path, "video/mp4"),
      audioPolicy,
      kind: "video",
      playback: {
        endBehavior: "hide",
        playbackRate: 1,
        sourceInUs: 0,
        sourceOutUs: 2_000_000,
      },
    });
    const plan = renderPlan({
      overlays: [
        animatedOverlay("overlay_mixed_audio", 0, "assets/mixed.mp4", { kind: "mix", volume: 0.8 }),
        animatedOverlay("overlay_duck_audio1", 1, "assets/duck.mp4", {
          duckPrimaryTo: 0.25,
          kind: "duck-primary",
          volume: 0.6,
        }),
      ].map(resolved),
    });
    const built = await buildProjectFfmpegInvocation(plan, {
      dryRun: true,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe-test",
      outputPath: join(projectDirectory, "renders/output.mp4"),
      projectDirectory,
      repositoryRoot,
      runner: {
        run: () => Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: '{"format":{"duration":"2"},"streams":[{"codec_type":"video","duration":"2","height":64,"index":0,"width":64},{"codec_type":"audio","duration":"2","index":1}]}',
        }),
      },
    });
    const filter = await readFilterGraph(built.argv);
    const mixedOverlayLabel = filter.match(/\[0:1\][^;]*\[(graphic_audio_\d+)\]/u)?.[1];
    const duckOverlayLabel = filter.match(/\[1:1\][^;]*\[(graphic_audio_\d+)\]/u)?.[1];
    const duckedPrimaryLabel = filter.match(
      /\[primary_audio\]volume='if\(between\(t,0,2\),0\.25,1\)':eval=frame\[(ducked_\d+)\]/u,
    )?.[1];

    expect(mixedOverlayLabel).toBeDefined();
    expect(duckOverlayLabel).toBeDefined();
    expect(duckedPrimaryLabel).toBeDefined();
    expect(filter).toContain(
      `[${duckedPrimaryLabel!}][${mixedOverlayLabel!}][${duckOverlayLabel!}]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0`,
    );
    expect(filter).not.toContain(`[primary_audio][${mixedOverlayLabel!}]amix=inputs=2`);
    expect(filter).not.toContain(`[${mixedOverlayLabel!}]volume='if(`);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("uses the strongest active target instead of multiplying overlapping project ducks", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-overlapping-ducks-test-"));
  try {
    const requestedProjectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_multiduck01");
    const assetDirectory = join(requestedProjectDirectory, "assets");
    await Promise.all([
      mkdir(assetDirectory, { recursive: true }),
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(assetDirectory, "duck-a.mp4"), "duck-a.mp4"),
      writeFile(join(assetDirectory, "duck-b.mp4"), "duck-b.mp4"),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);
    const duckOverlay = (overlayId: string, zIndex: number, path: string): OverlayOperation => (
      overlay(overlayId, zIndex, {
        asset: importedAsset(path, "video/mp4"),
        audioPolicy: { duckPrimaryTo: 0.5, kind: "duck-primary", volume: 1 },
        kind: "video",
        playback: {
          endBehavior: "hide",
          playbackRate: 1,
          sourceInUs: 0,
          sourceOutUs: 2_000_000,
        },
      })
    );
    const plan = renderPlan({
      overlays: [
        duckOverlay("overlay_duck_first", 0, "assets/duck-a.mp4"),
        duckOverlay("overlay_duck_second", 1, "assets/duck-b.mp4"),
      ].map(resolved),
    });
    const built = await buildProjectFfmpegInvocation(plan, {
      dryRun: true,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe-test",
      outputPath: join(projectDirectory, "renders/output.mp4"),
      projectDirectory,
      repositoryRoot,
      runner: {
        run: () => Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: '{"format":{"duration":"2"},"streams":[{"codec_type":"video","duration":"2","height":64,"index":0,"width":64},{"codec_type":"audio","duration":"2","index":1}]}',
        }),
      },
    });
    const filter = await readFilterGraph(built.argv);
    const expectedDuck = "[primary_audio]volume='min(if(between(t,0,2),0.5,1),if(between(t,0,2),0.5,1))':eval=frame";

    expect(filter).toContain(expectedDuck);
    expect(filter.match(/\[primary_audio\]volume=/gu)).toHaveLength(1);
    expect(filter.match(/\[ducked_\d+\]volume=/gu)).toBeNull();
    expect(filter).not.toContain("0.25");
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("rejects tampered project media and overlay inputs before constructing FFmpeg inputs", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-integrity-"));
  try {
    const requestedProjectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_integrity01");
    await Promise.all([
      mkdir(join(requestedProjectDirectory, "assets"), { recursive: true }),
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
      mkdir(join(repositoryRoot, "media"), { recursive: true }),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);
    const mediaPath = join(repositoryRoot, "media", "input.mp4");
    await writeFile(mediaPath, "trusted");
    const expectedMedia = integrity("trusted");
    const videoSlice = ProjectRenderPlanV1Schema.shape.videoSlices.element.parse({
      assetId: "asset_integrity01",
      assetRange: { endUs: 1_000_000, startUs: 0 },
      ...expectedMedia,
      codec: "h264",
      container: "mp4",
      fileRange: { endUs: 1_000_000, startUs: 0 },
      kind: "video",
      outputRange: { endUs: 1_000_000, startUs: 0 },
      path: "media/input.mp4",
      placementId: "placement_integrity01",
      presentation: {
        blendMode: "normal",
        crop: { kind: "none" },
        enabled: true,
        fit: "contain",
        layer: 0,
        layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
        opacity: 1,
      },
      projectRange: { endUs: 1_000_000, startUs: 0 },
      projectSpeed: 1,
      role: "screen",
      streamId: "stream_integrity01",
      streamIndex: 0,
    });
    await writeFile(mediaPath, "altered");
    expect(String(await rejection(buildProjectFfmpegInvocation(renderPlan({ videoSlices: [videoSlice] }), {
      dryRun: true,
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders", "media.mp4"),
      projectDirectory,
      repositoryRoot,
    })))).toMatch(/SHA-256 integrity check/u);

    await writeFile(mediaPath, "trusted");
    const blendedSlice = ProjectRenderPlanV1Schema.shape.videoSlices.element.parse({
      ...videoSlice,
      presentation: { ...videoSlice.presentation, blendMode: "multiply" },
    });
    const blended = await buildProjectFfmpegInvocation(renderPlan({ videoSlices: [blendedSlice] }), {
      dryRun: true,
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders", "blend.mp4"),
      projectDirectory,
      repositoryRoot,
    });
    const blendFilter = await readFilterGraph(blended.argv);
    expect(blendFilter).toContain("video_blend_positioned_");
    expect(blendFilter).toContain("blend=all_mode=multiply");
    expect(blendFilter).toContain("alphaextract");
    expect(blendFilter).toContain("maskedmerge");

    await symlink(join(repositoryRoot, "media"), join(repositoryRoot, "linked-media"));
    expect(String(await rejection(buildProjectFfmpegInvocation(renderPlan({
      videoSlices: [{ ...videoSlice, path: "linked-media/input.mp4" }],
    }), {
      dryRun: true,
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders", "linked.mp4"),
      projectDirectory,
      repositoryRoot,
    })))).toMatch(/physical directories/u);

    const overlayPath = join(projectDirectory, "assets", "image.png");
    await writeFile(overlayPath, "trusted");
    const image = overlay("overlay_integrity01", 0, {
      asset: {
        ...expectedMedia,
        mediaType: "image/png",
        path: "assets/image.png",
        provenance: { kind: "imported", originalName: "image.png", sourceSha256: expectedMedia.sha256 },
      },
      kind: "image",
    });
    await writeFile(overlayPath, "altered");
    expect(String(await rejection(buildProjectFfmpegInvocation(renderPlan({ overlays: [resolved(image)] }), {
      dryRun: true,
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders", "overlay.mp4"),
      projectDirectory,
      repositoryRoot,
    })))).toMatch(/SHA-256 integrity check/u);

    await writeFile(overlayPath, "trusted");
    expect(String(await rejection(buildProjectFfmpegInvocation(renderPlan({ overlays: [resolved(image)] }), {
      dryRun: true,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe-test",
      outputPath: join(projectDirectory, "renders", "overlay-dimensions.mp4"),
      projectDirectory,
      repositoryRoot,
      runner: {
        run: () => Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: '{"format":{"duration":"1"},"streams":[{"codec_type":"video","duration":"1","height":64,"index":0,"width":128}]}',
        }),
      },
    })))).toMatch(/intrinsic dimensions/u);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("binds SVG cache entries to the probed renderer version and regenerates stale derivatives", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-svg-cache-"));
  try {
    const requestedProjectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_integrity01");
    await Promise.all([
      mkdir(join(requestedProjectDirectory, "assets"), { recursive: true }),
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);
    const sourceContents = "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><circle r='1'/></svg>";
    await writeFile(join(projectDirectory, "assets", "vector.svg"), sourceContents);
    const sourceIntegrity = integrity(sourceContents);
    const svg = overlay("overlay_svgcache01", 0, {
      asset: {
        ...sourceIntegrity,
        mediaType: "image/svg+xml",
        path: "assets/vector.svg",
        provenance: { kind: "imported", originalName: "vector.svg", sourceSha256: sourceIntegrity.sha256 },
      },
      kind: "svg",
    });
    const plan = renderPlan({ overlays: [resolved(svg)] });
    let conversions = 0;
    const svgRunner: ProcessRunner = {
      run: async argv => {
        conversions += 1;
        const outputIndex = argv.indexOf("-o");
        const output = argv[outputIndex + 1];
        if (output === undefined) throw new Error("Missing SVG derivative output path.");
        const png = new Uint8Array(24);
        png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(png.buffer);
        view.setUint32(16, 64, false);
        view.setUint32(20, 64, false);
        await writeFile(output, png);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const options = {
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders", "svg.mp4"),
      projectDirectory,
      repositoryRoot,
      rsvgConvert: "rsvg-convert",
      rsvgConvertVersion: "rsvg-convert version 2.58.0",
      runner: svgRunner,
    } as const;

    await buildProjectFfmpegInvocation(plan, options);
    await buildProjectFfmpegInvocation(plan, options);
    expect(conversions).toBe(1);
    const cacheDirectory = join(projectDirectory, "renders", ".overlay-cache");
    const entries = await readdir(cacheDirectory);
    const manifestName = entries.find(name => name.endsWith(".json"));
    const derivativeName = entries.find(name => name.endsWith(".png"));
    expect(manifestName).toBeDefined();
    expect(derivativeName).toBeDefined();
    const manifest = JSON.parse(await readFile(join(cacheDirectory, manifestName!), "utf8")) as {
      readonly recipe: {
        readonly rendererVersion: string;
        readonly source: { readonly sha256: string };
        readonly version: string;
      };
    };
    expect(manifest.recipe).toMatchObject({
      rendererVersion: "rsvg-convert version 2.58.0",
      source: { sha256: sourceIntegrity.sha256 },
      version: "atet-rsvg-convert-v1",
    });

    await buildProjectFfmpegInvocation(plan, {
      ...options,
      rsvgConvertVersion: "rsvg-convert version 2.60.0",
    });
    expect(conversions).toBe(2);
    expect((await readdir(cacheDirectory)).filter(name => name.endsWith(".json"))).toHaveLength(2);

    await writeFile(join(cacheDirectory, derivativeName!), "tampered-derivative");
    await buildProjectFfmpegInvocation(plan, {
      ...options,
      rsvgConvertVersion: "rsvg-convert version 2.60.0",
    });
    expect(conversions).toBe(3);
    expect((await readFile(join(cacheDirectory, derivativeName!))).byteLength).toBe(24);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("fades only true audio discontinuities, not internal speed or anchor slice joins", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-audio-joins-"));
  try {
    const requestedProjectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_integrity01");
    await Promise.all([
      mkdir(join(requestedProjectDirectory, "renders"), { recursive: true }),
      mkdir(join(repositoryRoot, "media"), { recursive: true }),
    ]);
    const projectDirectory = await realpath(requestedProjectDirectory);
    const source = "logical-audio-stream";
    await writeFile(join(repositoryRoot, "media", "audio.mov"), source);
    const expected = integrity(source);
    const audioSlice = (
      startUs: number,
      endUs: number,
      outputStartUs: number,
      outputEndUs: number,
      projectSpeed: number,
    ): ProjectRenderPlanV1["audioSlices"][number] => ProjectRenderPlanV1Schema.shape.audioSlices.element.parse({
      assetId: "asset_integrity01",
      assetRange: { endUs, startUs },
      ...expected,
      codec: "aac",
      container: "mov",
      fileRange: { endUs, startUs },
      kind: "audio",
      outputRange: { endUs: outputEndUs, startUs: outputStartUs },
      path: "media/audio.mov",
      placementId: "placement_integrity01",
      presentation: { enabled: true, gainDb: 0, pan: 0 },
      projectRange: { endUs, startUs },
      projectSpeed,
      role: "dialogue",
      streamId: "stream_integrity01",
      streamIndex: 0,
    });
    const plan = renderPlan({
      audioSlices: [
        audioSlice(0, 500_000, 0, 500_000, 1),
        audioSlice(500_000, 1_000_000, 500_000, 750_000, 2),
        audioSlice(2_000_000, 2_500_000, 750_000, 1_250_000, 1),
      ],
      output: {
        background: "#000000ff",
        durationUs: 1_250_000,
        frameRate: 30,
        pixelHeight: 720,
        pixelWidth: 1_280,
      },
    });
    const built = await buildProjectFfmpegInvocation(plan, {
      dryRun: true,
      ffmpeg: "ffmpeg",
      outputPath: join(projectDirectory, "renders", "audio.mp4"),
      projectDirectory,
      repositoryRoot,
    });
    const filter = await readFilterGraph(built.argv);
    const chains = filter.split(";").filter(chain => (
      chain.includes("]atrim=start=") && chain.includes("[project_audio_")
    ));

    expect(chains).toHaveLength(3);
    expect(chains[0]).toContain("afade=t=in");
    expect(chains[0]).not.toContain("afade=t=out");
    expect(chains[1]).not.toContain("afade=t=in");
    expect(chains[1]).toContain("afade=t=out");
    expect(chains[2]).toContain("afade=t=in");
    expect(chains[2]).toContain("afade=t=out");
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test.skipIf(FFMPEG === null)("keeps project speed through zoom cadence normalization", async () => {
  if (FFMPEG === null) return;
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-zoom-speed-"));
  try {
    const projectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_zoomspeed1");
    const mediaDirectory = join(repositoryRoot, "media");
    await Promise.all([
      mkdir(join(projectDirectory, "renders"), { recursive: true }),
      mkdir(mediaDirectory, { recursive: true }),
    ]);
    const physicalProjectDirectory = await realpath(projectDirectory);
    const source = join(mediaDirectory, "source.mp4");
    const generated = await runProcess([
      FFMPEG,
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=320x180:r=60:d=0.5",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=60:d=0.5",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[out]",
      "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      source,
    ]);
    if (generated.exitCode !== 0) throw new Error(generated.stderr);
    const expected = await fileIntegrity(source);
    const plan = ProjectRenderPlanV1Schema.parse({
      ...renderPlan(),
      cameraKeyframes: [{
        displayId: "display-primary",
        easing: { kind: "linear" },
        layerPixelHeight: 180,
        layerPixelWidth: 320,
        outputTimeUs: 0,
        placementId: "placement_zoomspeed1",
        scale: 2,
        sourceTimeUs: 0,
        streamId: "stream_zoomspeed_video",
        viewport: { height: 90, width: 160, x: 0, y: 0 },
        zoomId: "zoom_zoomspeed1",
      }, {
        displayId: "display-primary",
        easing: { kind: "linear" },
        layerPixelHeight: 180,
        layerPixelWidth: 320,
        outputTimeUs: 500_000,
        placementId: "placement_zoomspeed1",
        scale: 2,
        sourceTimeUs: 1_000_000,
        streamId: "stream_zoomspeed_video",
        viewport: { height: 90, width: 160, x: 0, y: 0 },
        zoomId: "zoom_zoomspeed1",
      }],
      output: {
        background: "#000000ff",
        durationUs: 500_000,
        frameRate: 30,
        pixelHeight: 180,
        pixelWidth: 320,
      },
      videoSlices: [{
        assetId: "asset_zoomspeed1",
        assetRange: { endUs: 1_000_000, startUs: 0 },
        ...expected,
        codec: "h264",
        container: "mp4",
        fileRange: { endUs: 1_000_000, startUs: 0 },
        kind: "video",
        outputRange: { endUs: 500_000, startUs: 0 },
        path: "media/source.mp4",
        placementId: "placement_zoomspeed1",
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "fill",
          layer: 0,
          layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
          opacity: 1,
        },
        projectRange: { endUs: 1_000_000, startUs: 0 },
        projectSpeed: 2,
        role: "screen",
        streamId: "stream_zoomspeed_video",
        streamIndex: 0,
      }],
    });
    const output = join(physicalProjectDirectory, "renders", "zoom-speed.mp4");
    const built = await buildProjectFfmpegInvocation(plan, {
      ffmpeg: FFMPEG,
      outputPath: output,
      projectDirectory: physicalProjectDirectory,
      repositoryRoot,
    });
    const filter = await readFilterGraph(built.argv);
    expect(filter).toContain("fps=30,zoompan=");
    const rendered = await runProcess(built.argv);
    if (rendered.exitCode !== 0) throw new Error(rendered.stderr);

    const finalPixel = join(physicalProjectDirectory, "renders", "last.rgb");
    const extracted = await runProcess([
      FFMPEG,
      "-hide_banner", "-loglevel", "error", "-y",
      "-sseof", "-0.05", "-i", output,
      "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo",
      finalPixel,
    ]);
    if (extracted.exitCode !== 0) throw new Error(extracted.stderr);
    const pixel = await readFile(finalPixel);
    expect(pixel.byteLength).toBe(3);
    expect(pixel[2]!).toBeGreaterThan(pixel[0]!);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
}, 20_000);

test.skipIf(FFMPEG === null)("renders log-zoom camera paths with CSS cubic-bezier timing", async () => {
  if (FFMPEG === null) return;
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-camera-path-"));
  try {
    const projectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_camerapath");
    const mediaDirectory = join(repositoryRoot, "media");
    await Promise.all([
      mkdir(join(projectDirectory, "renders"), { recursive: true }),
      mkdir(mediaDirectory, { recursive: true }),
    ]);
    const physicalProjectDirectory = await realpath(projectDirectory);
    const source = join(mediaDirectory, "source.mp4");
    const generated = await runProcess([
      FFMPEG,
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      source,
    ]);
    if (generated.exitCode !== 0) throw new Error(generated.stderr);
    const expected = await fileIntegrity(source);
    const plan = ProjectRenderPlanV1Schema.parse({
      ...renderPlan(),
      cameraSegments: [{
        assetRange: { endUs: 1_000_000, startUs: 0 },
        cameraMoveId: "camera_filterpath",
        geometrySha256: HASH,
        layerPixelHeight: 180,
        layerPixelWidth: 320,
        outputRange: { endUs: 500_000, startUs: 0 },
        placementId: "placement_camerapath",
        projectRange: { endUs: 1_000_000, startUs: 0 },
        streamId: "stream_camerapath01",
        syncSha256: HASH,
        transforms: [{
          activeProjectRange: { endUs: 1_000_000, startUs: 0 },
          fromPose: {
            centerX: 0.5,
            centerY: 0.5,
            space: "prepared-video-layer-normalized-v1",
            zoom: 1,
          },
          interpolationProjectRange: { endUs: 1_000_000, startUs: 0 },
          outgoingEasing: {
            kind: "cubic-bezier",
            x1: 0.42,
            x2: 0.58,
            y1: 0,
            y2: 1,
          },
          toPose: {
            centerX: 0.7,
            centerY: 0.5,
            space: "prepared-video-layer-normalized-v1",
            zoom: 2,
          },
        }],
      }],
      output: {
        background: "#000000ff",
        durationUs: 500_000,
        frameRate: 30,
        pixelHeight: 180,
        pixelWidth: 320,
      },
      videoSlices: [{
        assetId: "asset_camerapath1",
        assetRange: { endUs: 1_000_000, startUs: 0 },
        ...expected,
        codec: "h264",
        container: "mp4",
        fileRange: { endUs: 1_000_000, startUs: 0 },
        kind: "video",
        outputRange: { endUs: 500_000, startUs: 0 },
        path: "media/source.mp4",
        placementId: "placement_camerapath",
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "fill",
          layer: 0,
          layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
          opacity: 1,
        },
        projectRange: { endUs: 1_000_000, startUs: 0 },
        projectSpeed: 2,
        role: "camera",
        streamId: "stream_camerapath01",
        streamIndex: 0,
      }],
    });
    const built = await buildProjectFfmpegInvocation(plan, {
      ffmpeg: FFMPEG,
      outputPath: join(physicalProjectDirectory, "renders", "camera-path.mp4"),
      projectDirectory: physicalProjectDirectory,
      repositoryRoot,
    });
    const filter = await readFilterGraph(built.argv);
    expect(filter).toContain("zoompan=z='");
    expect(filter).toContain("exp(");
    expect(filter).toContain("root(");
    const rendered = await runProcess(built.argv);
    if (rendered.exitCode !== 0) throw new Error(rendered.stderr);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
}, 20_000);

test.skipIf(FFMPEG === null || RSVG_CONVERT === null)(
  "executes a synchronized two-angle project with audio and a project-local SVG overlay",
  async () => {
    if (FFMPEG === null || RSVG_CONVERT === null) return;
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-render-exec-"));
    try {
      const projectDirectory = join(repositoryRoot, "artifacts/atet/projects/project_execute01");
      const mediaDirectory = join(repositoryRoot, "media");
      await Promise.all([
        mkdir(join(projectDirectory, "assets"), { recursive: true }),
        mkdir(join(projectDirectory, "renders"), { recursive: true }),
        mkdir(mediaDirectory, { recursive: true }),
      ]);
      const screen = join(mediaDirectory, "screen.mp4");
      const camera = join(mediaDirectory, "camera.mp4");
      for (const [path, color, frequency, size] of [
        [screen, "blue", "440", "320x180"],
        [camera, "red", "660", "160x90"],
      ] as const) {
        const generated = await runProcess([
          FFMPEG,
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=30:d=1`,
          "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1`,
          "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
        ]);
        if (generated.exitCode !== 0) throw new Error(generated.stderr);
      }
      const screenIntegrity = await fileIntegrity(screen);
      const cameraIntegrity = await fileIntegrity(camera);
      const svgPath = join(projectDirectory, "assets", "badge.svg");
      const svgContents = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="22" fill="#00ff88"/></svg>`;
      await writeFile(svgPath, svgContents);
      const svgIntegrity = integrity(svgContents);

      const baseSlice = {
        assetRange: { endUs: 1_000_000, startUs: 0 },
        codec: "h264",
        container: "mp4",
        fileRange: { endUs: 1_000_000, startUs: 0 },
        outputRange: { endUs: 1_000_000, startUs: 0 },
        projectRange: { endUs: 1_000_000, startUs: 0 },
        projectSpeed: 1,
      } as const;
      const svg = OverlayOperationSchema.parse({
        ...overlay("overlay_execute_svg", 10, {
          asset: {
            ...svgIntegrity,
            mediaType: "image/svg+xml",
            path: "assets/badge.svg",
            provenance: { kind: "imported", originalName: "badge.svg", sourceSha256: svgIntegrity.sha256 },
          },
          kind: "svg",
        }),
        intrinsicSize: { height: 48, width: 48 },
        position: { x: 8, y: 8 },
        range: { endUs: 900_000, startUs: 100_000 },
        size: { height: 48, kind: "pixels", width: 48 },
      });
      const plan = ProjectRenderPlanV1Schema.parse({
        audioSlices: [{
          ...baseSlice,
          ...screenIntegrity,
          assetId: "asset_execscreen",
          kind: "audio",
          path: "media/screen.mp4",
          placementId: "placement_execscreen",
          presentation: { enabled: true, gainDb: -6, pan: -0.2 },
          role: "system-audio",
          streamId: "stream_execscreen_audio",
          streamIndex: 1,
        }, {
          ...baseSlice,
          ...cameraIntegrity,
          assetId: "asset_execcamera",
          kind: "audio",
          path: "media/camera.mp4",
          placementId: "placement_execcamera",
          presentation: { enabled: true, gainDb: -9, pan: 0.2 },
          role: "microphone",
          streamId: "stream_execcamera_audio",
          streamIndex: 1,
        }],
        cameraKeyframes: [],
        cameraSegments: [],
        effects: DISABLED_METADATA_EFFECTS,
        kind: "studio.project-render-plan",
        output: { background: "#000000ff", durationUs: 1_000_000, frameRate: 30, pixelHeight: 180, pixelWidth: 320 },
        overlays: [{
          operation: svg,
          outputRange: { endUs: 900_000, startUs: 100_000 },
          playbackOffsetUs: 0,
          projectRange: { endUs: 900_000, startUs: 100_000 },
          visibleDurationUs: 800_000,
        }],
        planSha256: HASH,
        projectEditPlanSha256: HASH,
        projectId: "project_execute01",
        projectStructureSha256: HASH,
        schemaVersion: 1,
        videoSlices: [{
          ...baseSlice,
          ...screenIntegrity,
          assetId: "asset_execscreen",
          kind: "video",
          path: "media/screen.mp4",
          placementId: "placement_execscreen",
          presentation: {
            blendMode: "normal",
            crop: { kind: "none" },
            enabled: true,
            fit: "fill",
            layer: 0,
            layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
            opacity: 1,
          },
          role: "screen",
          streamId: "stream_execscreen_video",
          streamIndex: 0,
        }, {
          ...baseSlice,
          ...cameraIntegrity,
          assetId: "asset_execcamera",
          kind: "video",
          path: "media/camera.mp4",
          placementId: "placement_execcamera",
          presentation: {
            blendMode: "normal",
            crop: { kind: "none" },
            enabled: true,
            fit: "cover",
            layer: 1,
            layout: { height: 0.35, kind: "normalized", width: 0.35, x: 0.62, y: 0.6 },
            opacity: 1,
          },
          role: "camera",
          streamId: "stream_execcamera_video",
          streamIndex: 0,
        }],
        warnings: [],
      });
      const actualProjectDirectory = await realpath(projectDirectory);
      const outputPath = join(actualProjectDirectory, "renders", "two-angle.mp4");
      const built = await buildProjectFfmpegInvocation(plan, {
        ffmpeg: FFMPEG,
        outputPath,
        projectDirectory: actualProjectDirectory,
        repositoryRoot,
        rsvgConvert: RSVG_CONVERT,
        rsvgConvertVersion: "rsvg-convert probed test version",
        runner,
      });
      const rendered = await runProcess(built.argv);
      if (rendered.exitCode !== 0) throw new Error(rendered.stderr);
      expect((await stat(outputPath)).size).toBeGreaterThan(1_000);
      expect(built.argv.join(" ")).toContain(".overlay-cache");
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  },
);
