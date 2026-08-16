import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import {
  ProjectRenderInvocationSchema,
  resolveProjectRenderEncoderRecipe,
  type OverlayOperation,
  type ProjectRenderEncoderRecipe,
  type ProjectRenderInvocation,
  type ProjectRenderPlanV1,
  type ProjectRenderTier,
  type ResolvedProjectOverlay,
  type ResolvedProjectVideoSlice,
} from "../contracts";
import {
  assertProjectCameraSpatialLayerGeometry,
  buildProjectCameraSpatialIndex,
  canonicalJson,
  canonicalJsonSha256,
  evaluateProjectCameraSpatialViewport,
  projectCameraSegmentsOverlapping,
  projectCameraSpatialLayer,
  type ProjectCameraSpatialAlgebra,
  type ProjectCameraSpatialIndex,
} from "../core";
import { probeVisualMediaSummary } from "./analyzer";
import { inspectPngIntrinsicSize, inspectSvgIntrinsicSize } from "./asset-ingest";
import { CliError } from "./errors";
import { materializeFilterScript } from "./filter-script";
import type { ProcessRunner } from "./io";
import {
  assertAudioLoopBufferWithinLimit,
  assertVideoLoopBufferWithinLimit,
  resolveAudibleSourceRange,
} from "./overlay-playback";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import {
  fingerprintPhysicalProjectMedia,
  resolvePhysicalProjectMedia,
  resolveVerifiedProjectMedia,
  verifyPhysicalProjectMedia,
  type ExpectedProjectMediaIntegrity,
} from "./project-media-integrity";
import { applyMetadataEffects } from "./renderer";

const MAXIMUM_SVG_CACHE_MANIFEST_BYTES = 64 * 1_024;
const MAXIMUM_SVG_DERIVATIVE_BYTES = 512 * 1_024 * 1_024;
const SVG_RASTER_RECIPE_VERSION = "atet-rsvg-convert-v1";

const SvgCacheManifestSchema = z.strictObject({
  derivative: z.strictObject({
    bytes: z.number().int().safe().positive().max(MAXIMUM_SVG_DERIVATIVE_BYTES),
    path: z.string().regex(/^[a-f0-9]{64}\.png$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  kind: z.union([
    z.literal("atet.svg-raster-cache"),
    z.literal("studio.svg-raster-cache"),
  ]),
  recipe: z.strictObject({
    arguments: z.tuple([
      z.literal("--keep-aspect-ratio"),
      z.literal("--width"),
      z.string().regex(/^[1-9][0-9]{0,4}$/u),
      z.literal("--height"),
      z.string().regex(/^[1-9][0-9]{0,4}$/u),
    ]),
    renderer: z.literal("rsvg-convert"),
    rendererVersion: z.string().trim().min(1).max(300),
    source: z.strictObject({
      bytes: z.number().int().safe().positive(),
      mediaType: z.literal("image/svg+xml"),
      pixelHeight: z.number().int().safe().positive().max(16_384),
      pixelWidth: z.number().int().safe().positive().max(16_384),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
    version: z.literal(SVG_RASTER_RECIPE_VERSION),
  }),
  recipeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(2),
});

function seconds(microseconds: number): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(10).replace(/0+$/u, "").replace(/\.$/u, "");
}

function atempo(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) throw new CliError("unsupported-plan", "Audio tempo rate must be positive.");
  const filters: string[] = [];
  let remaining = rate;
  while (remaining > 100) {
    filters.push("atempo=100");
    remaining /= 100;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${decimal(remaining)}`);
  return filters.join(",");
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function resolveProjectOverlayMedia(
  projectDirectory: string,
  repositoryRoot: string,
  path: string,
): Promise<string> {
  const projectRoot = await realpath(projectDirectory);
  try {
    return await resolvePhysicalProjectMedia(projectRoot, path);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  // Backward compatibility for plans that intentionally stored a repository-relative overlay path.
  return await resolvePhysicalProjectMedia(repositoryRoot, path);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readBoundedPhysicalText(path: string, maximumBytes: number): Promise<string> {
  const lexical = await lstat(path);
  if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size <= 0 || lexical.size > maximumBytes) {
    throw new CliError("invalid-data", `Cache manifest must be a bounded physical file: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== lexical.size) {
      throw new CliError("conflict", `Cache manifest changed before validation: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new CliError("conflict", `Cache manifest changed during validation: ${path}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function physicalOverlayCacheDirectory(
  projectDirectory: string,
  workspaceDirectory: string | undefined,
): Promise<string> {
  return await ensurePhysicalPrivateDirectoryWithin(
    workspaceDirectory ?? projectDirectory,
    workspaceDirectory === undefined ? "renders/.overlay-cache" : "overlay-cache",
  );
}

function svgRasterRecipe(overlay: OverlayOperation, rendererVersion: string) {
  const asset = overlay.source.asset;
  return SvgCacheManifestSchema.shape.recipe.parse({
    arguments: [
      "--keep-aspect-ratio",
      "--width", String(overlay.intrinsicSize.width),
      "--height", String(overlay.intrinsicSize.height),
    ],
    renderer: "rsvg-convert",
    rendererVersion,
    source: {
      bytes: asset.bytes,
      mediaType: "image/svg+xml",
      pixelHeight: overlay.intrinsicSize.height,
      pixelWidth: overlay.intrinsicSize.width,
      sha256: asset.sha256,
    },
    version: SVG_RASTER_RECIPE_VERSION,
  });
}

async function reusableSvgDerivative(
  cacheDirectory: string,
  recipeSha256: string,
  expectedSize: OverlayOperation["intrinsicSize"],
): Promise<string | null> {
  const manifestPath = join(cacheDirectory, `${recipeSha256}.json`);
  try {
    const parsed = SvgCacheManifestSchema.safeParse(
      JSON.parse(await readBoundedPhysicalText(manifestPath, MAXIMUM_SVG_CACHE_MANIFEST_BYTES)) as unknown,
    );
    if (
      !parsed.success
      || parsed.data.recipeSha256 !== recipeSha256
      || canonicalJsonSha256(parsed.data.recipe) !== recipeSha256
    ) return null;
    const derivative = join(cacheDirectory, parsed.data.derivative.path);
    try {
      const verified = await verifyPhysicalProjectMedia(derivative, parsed.data.derivative, "SVG cache derivative");
      const size = await inspectPngIntrinsicSize(verified);
      return size.width === expectedSize.width && size.height === expectedSize.height ? verified : null;
    } catch (error) {
      if (error instanceof CliError && (error.code === "invalid-data" || error.code === "conflict")) return null;
      throw error;
    }
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function createSvgDerivative(
  input: string,
  cacheDirectory: string,
  recipe: z.infer<typeof SvgCacheManifestSchema>["recipe"],
  recipeSha256: string,
  options: ProjectRenderBuildOptions,
): Promise<string> {
  if (options.rsvgConvert === undefined || options.runner === undefined) {
    throw new CliError("unavailable", "SVG overlays require rsvg-convert.");
  }
  const temporaryOutput = join(cacheDirectory, `.raster-${randomUUID()}.png`);
  const temporaryManifest = join(cacheDirectory, `.manifest-${randomUUID()}.json`);
  try {
    const result = await options.runner.run([
      options.rsvgConvert,
      ...recipe.arguments,
      "-o", temporaryOutput,
      input,
    ], { maxOutputBytes: 1_000_000 });
    if (result.exitCode !== 0) {
      throw new CliError("subprocess", `rsvg-convert failed: ${result.stderr.trim().slice(-4_000) || `exit ${result.exitCode}`}`);
    }
    const generated = await fingerprintPhysicalProjectMedia(temporaryOutput, MAXIMUM_SVG_DERIVATIVE_BYTES);
    const generatedSize = await inspectPngIntrinsicSize(temporaryOutput);
    if (
      generatedSize.width !== recipe.source.pixelWidth
      || generatedSize.height !== recipe.source.pixelHeight
    ) {
      throw new CliError("invalid-data", "SVG derivative dimensions do not match its bounded raster recipe.");
    }
    const derivativeName = `${generated.sha256}.png`;
    const derivative = join(cacheDirectory, derivativeName);
    await chmod(temporaryOutput, 0o600);
    try {
      await link(temporaryOutput, derivative);
      await rm(temporaryOutput);
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
      try {
        await verifyPhysicalProjectMedia(derivative, generated, "SVG cache derivative");
        await rm(temporaryOutput);
      } catch (verificationError) {
        const existing = await lstat(derivative);
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
          throw new CliError("unsafe-path", `SVG cache derivative is unsafe: ${derivative}`);
        }
        if (!(verificationError instanceof CliError)) throw verificationError;
        await rename(temporaryOutput, derivative);
      }
    }
    const manifest = SvgCacheManifestSchema.parse({
      derivative: { bytes: generated.bytes, path: derivativeName, sha256: generated.sha256 },
      kind: "atet.svg-raster-cache",
      recipe,
      recipeSha256,
      schemaVersion: 2,
    });
    await writeFile(temporaryManifest, `${canonicalJson(manifest)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryManifest, join(cacheDirectory, `${recipeSha256}.json`));
    return await verifyPhysicalProjectMedia(derivative, manifest.derivative, "SVG cache derivative");
  } finally {
    await Promise.all([
      rm(temporaryOutput, { force: true }),
      rm(temporaryManifest, { force: true }),
    ]);
  }
}

interface PreparedProjectOverlayMedia {
  readonly audioStreamIndex: number | null;
  readonly path: string;
  readonly sourcePath: string;
  readonly videoStreamIndex: number | null;
}

async function prepareProjectOverlayMedia(
  overlay: OverlayOperation,
  options: ProjectRenderBuildOptions,
): Promise<PreparedProjectOverlayMedia> {
  const input = await resolveProjectOverlayMedia(
    options.projectDirectory,
    options.repositoryRoot,
    overlay.source.asset.path,
  );
  await verifyPhysicalProjectMedia(input, overlay.source.asset, `Overlay ${overlay.overlayId}`);
  if (overlay.source.asset.mediaType !== "image/svg+xml") {
    if (options.ffprobe === undefined || options.runner === undefined) {
      throw new CliError("unavailable", `Overlay ${overlay.overlayId} requires FFprobe dimension verification.`);
    }
    const probed = await probeVisualMediaSummary(options.ffprobe, options.runner, input);
    if (
      probed.pixelWidth !== overlay.intrinsicSize.width
      || probed.pixelHeight !== overlay.intrinsicSize.height
    ) {
      throw new CliError("invalid-data", `Overlay ${overlay.overlayId} intrinsic dimensions do not match its media.`);
    }
    if (overlay.source.kind === "gif" || overlay.source.kind === "video") {
      const playback = overlay.source.playback;
      if (
        playback.videoStreamIndex !== null
        && playback.videoStreamIndex !== undefined
        && playback.videoStreamIndex !== probed.videoStreamIndex
      ) {
        throw new CliError("invalid-data", `Overlay ${overlay.overlayId} selected video stream does not match its media.`);
      }
      if (
        playback.audioStreamIndex !== null
        && playback.audioStreamIndex !== undefined
        && playback.audioStreamIndex !== probed.audioStreamIndex
      ) {
        throw new CliError("invalid-data", `Overlay ${overlay.overlayId} selected audio stream does not match its media.`);
      }
      if (
        overlay.source.kind === "video"
        && overlay.source.audioPolicy.kind !== "mute"
        && probed.audioStreamIndex === null
      ) {
        throw new CliError("invalid-data", `Overlay ${overlay.overlayId} requires an audio stream that is absent from its media.`);
      }
      return {
        audioStreamIndex: probed.audioStreamIndex,
        path: input,
        sourcePath: input,
        videoStreamIndex: probed.videoStreamIndex,
      };
    }
    return {
      audioStreamIndex: null,
      path: input,
      sourcePath: input,
      videoStreamIndex: null,
    };
  }
  const svgSize = await inspectSvgIntrinsicSize(input);
  if (svgSize.width !== overlay.intrinsicSize.width || svgSize.height !== overlay.intrinsicSize.height) {
    throw new CliError("invalid-data", `Overlay ${overlay.overlayId} intrinsic dimensions do not match its SVG.`);
  }
  if (
    options.rsvgConvert === undefined
    || options.rsvgConvertVersion === undefined
    || options.runner === undefined
  ) {
    throw new CliError("unavailable", `SVG overlay ${overlay.overlayId} requires rsvg-convert with a probed version.`);
  }
  const cacheDirectory = await physicalOverlayCacheDirectory(
    options.projectDirectory,
    options.workspaceDirectory,
  );
  const recipe = svgRasterRecipe(overlay, options.rsvgConvertVersion);
  const recipeSha256 = canonicalJsonSha256(recipe);
  const cached = await reusableSvgDerivative(cacheDirectory, recipeSha256, overlay.intrinsicSize);
  if (cached !== null) {
    return {
      audioStreamIndex: null,
      path: cached,
      sourcePath: input,
      videoStreamIndex: null,
    };
  }
  if (options.dryRun) {
    return {
      audioStreamIndex: null,
      path: join(cacheDirectory, `pending-${recipeSha256}.png`),
      sourcePath: input,
      videoStreamIndex: null,
    };
  }
  return {
    audioStreamIndex: null,
    path: await createSvgDerivative(input, cacheDirectory, recipe, recipeSha256, options),
    sourcePath: input,
    videoStreamIndex: null,
  };
}

function inputSpecifier(index: number, streamIndex: number): string {
  return `${index}:${streamIndex}`;
}

function animatedStreamSpecifier(
  inputIndex: number,
  streamType: "a" | "v",
  absoluteStreamIndex: number | null | undefined,
): string {
  return absoluteStreamIndex === null || absoluteStreamIndex === undefined
    ? `${inputIndex}:${streamType}:0`
    : inputSpecifier(inputIndex, absoluteStreamIndex);
}

function layoutPixels(
  presentation: Extract<ResolvedProjectVideoSlice["presentation"], { readonly enabled: true }>,
  outputWidth: number,
  outputHeight: number,
): { readonly height: number; readonly width: number; readonly x: number; readonly y: number } {
  if (presentation.layout.kind === "output-pixels") {
    return {
      height: Math.max(1, Math.round(presentation.layout.height)),
      width: Math.max(1, Math.round(presentation.layout.width)),
      x: Math.round(presentation.layout.x),
      y: Math.round(presentation.layout.y),
    };
  }
  return {
    height: Math.max(1, Math.round(presentation.layout.height * outputHeight)),
    width: Math.max(1, Math.round(presentation.layout.width * outputWidth)),
    x: Math.round(presentation.layout.x * outputWidth),
    y: Math.round(presentation.layout.y * outputHeight),
  };
}

function videoTransform(
  slice: ResolvedProjectVideoSlice,
  outputWidth: number,
  outputHeight: number,
): { readonly filters: readonly string[]; readonly x: number; readonly y: number } {
  if (!slice.presentation.enabled) throw new CliError("invalid-data", "Disabled video slice reached the renderer.");
  const presentation = slice.presentation;
  const filters: string[] = [];
  if (presentation.crop.kind === "normalized-insets") {
    const crop = presentation.crop;
    filters.push(
      `crop=w='iw*${decimal(1 - crop.left - crop.right)}':h='ih*${decimal(1 - crop.top - crop.bottom)}':x='iw*${decimal(crop.left)}':y='ih*${decimal(crop.top)}'`,
    );
  }
  const layout = layoutPixels(presentation, outputWidth, outputHeight);
  if (presentation.fit === "fill") {
    filters.push(`scale=${layout.width}:${layout.height}`);
  } else if (presentation.fit === "contain") {
    filters.push(
      `scale=${layout.width}:${layout.height}:force_original_aspect_ratio=decrease`,
      `pad=${layout.width}:${layout.height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
    );
  } else {
    filters.push(
      `scale=${layout.width}:${layout.height}:force_original_aspect_ratio=increase`,
      `crop=${layout.width}:${layout.height}`,
    );
  }
  filters.push("format=rgba");
  if (presentation.opacity !== 1) filters.push(`colorchannelmixer=aa=${decimal(presentation.opacity)}`);
  return { filters, x: layout.x, y: layout.y };
}

function overlayAnimationDuration(animation: OverlayOperation["entrance"]): number {
  return animation.kind === "none" ? 0 : animation.durationUs;
}

function effectiveAnimationBounds(
  overlay: OverlayOperation,
  visibleDurationUs: number,
): { readonly entranceUs: number; readonly exitUs: number } {
  const entranceUs = overlayAnimationDuration(overlay.entrance);
  const exitUs = overlayAnimationDuration(overlay.exit);
  if (entranceUs + exitUs <= visibleDurationUs || entranceUs + exitUs === 0) return { entranceUs, exitUs };
  const first = Math.floor(visibleDurationUs * entranceUs / (entranceUs + exitUs));
  return { entranceUs: first, exitUs: visibleDurationUs - first };
}

type OverlayEasing = Extract<OverlayOperation["entrance"], { readonly easing: unknown }>["easing"];

function eased(easing: OverlayEasing, progress: string): string {
  if (easing.kind === "linear") return progress;
  if (easing.kind === "ease-in") return `pow(${progress},2)`;
  if (easing.kind === "ease-out") return `1-pow(1-(${progress}),2)`;
  if (easing.kind === "ease-in-out") return `if(lt(${progress},0.5),2*pow(${progress},2),1-pow(-2*(${progress})+2,2)/2)`;
  if (easing.kind === "spring") return `min(1,max(0,1-exp(-6*(${progress}))*cos(8*(${progress}))))`;
  if (easing.kind === "cubic-bezier") {
    const bounded = `min(1,max(0,${progress}))`;
    const parameter = `root(${cubicBezierCoordinateExpression("ld(0)", easing.x1, easing.x2)}-(${bounded}),1)`;
    return cubicBezierCoordinateExpression(parameter, easing.y1, easing.y2);
  }
  return progress;
}

function cubicBezierCoordinateExpression(parameter: string, first: number, second: number): string {
  const inverse = `(1-(${parameter}))`;
  return `3*pow(${inverse},2)*(${parameter})*${decimal(first)}+3*(${inverse})*pow(${parameter},2)*${decimal(second)}+pow(${parameter},3)`;
}

const CAMERA_EXPRESSION_ALGEBRA = {
  add: (left: string, right: string) => `((${left})+(${right}))`,
  constant: decimal,
  divide: (left: string, right: string) => `((${left})/(${right}))`,
  easing: (easing: OverlayEasing, progress: string) => (
    eased(easing, progress)
  ),
  exponential: (value: string) => `exp(${value})`,
  maximum: (left: string, right: string) => `max(${left},${right})`,
  minimum: (left: string, right: string) => `min(${left},${right})`,
  multiply: (left: string, right: string) => `((${left})*(${right}))`,
  selectRange: (
    clock: string,
    range: { readonly endUs: number; readonly startUs: number },
    end: "inclusive" | "exclusive",
    active: string,
    fallback: string,
  ) => `if(gte(${clock},${decimal(range.startUs)})*${
    end === "inclusive" ? "lte" : "lt"
  }(${clock},${decimal(range.endUs)}),${active},${fallback})`,
  subtract: (left: string, right: string) => `((${left})-(${right}))`,
} satisfies ProjectCameraSpatialAlgebra<string>;

function projectCameraFilters(
  plan: ProjectRenderPlanV1,
  slice: ResolvedProjectVideoSlice,
  cameraIndex: ProjectCameraSpatialIndex,
): readonly string[] {
  const layerCamera = projectCameraSpatialLayer(
    cameraIndex,
    slice.placementId,
    slice.streamId,
  );
  if (layerCamera === null) return [];
  const segments = projectCameraSegmentsOverlapping(
    layerCamera.segments,
    slice.outputRange,
  );
  if (layerCamera.keyframeGroups.length === 0 && segments.length === 0) {
    return [];
  }
  const layout = layoutPixels(slice.presentation as Extract<ResolvedProjectVideoSlice["presentation"], { readonly enabled: true }>, plan.output.pixelWidth, plan.output.pixelHeight);
  const activeCamera = {
    keyframeGroups: layerCamera.keyframeGroups,
    segments,
  };
  try {
    assertProjectCameraSpatialLayerGeometry(
      activeCamera,
      layout.width,
      layout.height,
      `${slice.placementId}:${slice.streamId}`,
    );
  } catch {
    throw new CliError("invalid-data", `Camera geometry no longer matches layer ${slice.placementId}:${slice.streamId}.`);
  }
  const globalTimeUs = `(${decimal(slice.outputRange.startUs)}+on*1000000/${
    decimal(plan.output.frameRate)
  })`;
  const viewport = evaluateProjectCameraSpatialViewport(
    activeCamera,
    {
      outputTimeUs: globalTimeUs,
      pixelHeight: layout.height,
      pixelWidth: layout.width,
    },
    CAMERA_EXPRESSION_ALGEBRA,
  );
  return [
    // zoompan's d=1 clock is frame-count based. Normalize the already
    // speed-adjusted slice to the output cadence first so it cannot restore
    // source cadence or discard the project's speed map.
    `fps=${decimal(plan.output.frameRate)}`,
    `zoompan=z='${layout.width}/(${viewport.width})':x='${viewport.x}':y='${viewport.y}':d=1:s=${layout.width}x${layout.height}:fps=${decimal(plan.output.frameRate)}`,
    `setpts=PTS-STARTPTS+${seconds(slice.outputRange.startUs)}/TB`,
    "format=rgba",
  ];
}

function scaleExpression(
  overlay: OverlayOperation,
  fullStartUs: number,
  fullEndUs: number,
  entranceUs: number,
  exitUs: number,
): string {
  let expression = decimal(overlay.scale);
  if (overlay.entrance.kind === "scale" && entranceUs > 0) {
    const start = seconds(fullStartUs);
    const end = seconds(fullStartUs + entranceUs);
    const from = overlay.entrance.fromScale * overlay.scale;
    const progress = `(t-${start})/(${end}-${start})`;
    expression = `if(between(t,${start},${end}),${decimal(from)}+${decimal(overlay.scale - from)}*(${eased(overlay.entrance.easing, progress)}),${expression})`;
  }
  if (overlay.exit.kind === "scale" && exitUs > 0) {
    const start = seconds(fullEndUs - exitUs);
    const end = seconds(fullEndUs);
    const to = overlay.exit.fromScale * overlay.scale;
    const progress = `(t-${start})/(${end}-${start})`;
    expression = `if(between(t,${start},${end}),${decimal(overlay.scale)}+${decimal(to - overlay.scale)}*(${eased(overlay.exit.easing, progress)}),${expression})`;
  }
  const motionScale = overlayMotionExpression(overlay, "scaleMultiplier", fullStartUs, fullEndUs, 1);
  return motionScale === "1" ? expression : `(${expression})*(${motionScale})`;
}

type OverlayMotionField = "opacityMultiplier" | "positionX" | "positionY" | "rotationOffsetDegrees" | "scaleMultiplier";

function overlayMotionValue(
  keyframe: Extract<NonNullable<OverlayOperation["motion"]>, { readonly kind: "keyframes" }>["keyframes"][number],
  field: OverlayMotionField,
): number {
  if (field === "positionX") return keyframe.positionOffset.x;
  if (field === "positionY") return keyframe.positionOffset.y;
  return keyframe[field];
}

function overlayMotionExpression(
  overlay: OverlayOperation,
  field: OverlayMotionField,
  startUs: number,
  endUs: number,
  fallback: number,
  timeExpression = "t",
): string {
  const motion = overlay.motion ?? { kind: "none" as const };
  if (motion.kind === "none" || endUs <= startUs) return decimal(fallback);
  const keyframes = motion.keyframes;
  let expression = decimal(overlayMotionValue(keyframes.at(-1)!, field));
  for (let index = keyframes.length - 1; index > 0; index -= 1) {
    const left = keyframes[index - 1]!;
    const right = keyframes[index]!;
    const leftTimeUs = startUs + Math.round((endUs - startUs) * left.offset);
    const rightTimeUs = startUs + Math.round((endUs - startUs) * right.offset);
    if (rightTimeUs <= leftTimeUs) continue;
    const leftValue = overlayMotionValue(left, field);
    const rightValue = overlayMotionValue(right, field);
    const progress = `(${timeExpression}-${seconds(leftTimeUs)})/(${seconds(rightTimeUs)}-${seconds(leftTimeUs)})`;
    const value = leftValue === rightValue
      ? decimal(leftValue)
      : `${decimal(leftValue)}+${decimal(rightValue - leftValue)}*(${eased(left.easing, progress)})`;
    expression = `if(between(${timeExpression},${seconds(leftTimeUs)},${seconds(rightTimeUs)}),${value},${expression})`;
  }
  return expression;
}

function overlayGeometryFilters(
  overlay: OverlayOperation,
  fullStartUs: number,
  fullEndUs: number,
  entranceUs: number,
  exitUs: number,
): readonly string[] {
  const filters: string[] = [];
  const crop = overlay.crop ?? { kind: "none" as const };
  if (crop.kind === "normalized-insets") {
    filters.push(
      `crop=w='iw*${decimal(1 - crop.left - crop.right)}':h='ih*${decimal(1 - crop.top - crop.bottom)}':x='iw*${decimal(crop.left)}':y='ih*${decimal(crop.top)}'`,
    );
  }
  filters.push("format=rgba");
  if (overlay.size.kind === "pixels") {
    const width = decimal(overlay.size.width);
    const height = decimal(overlay.size.height);
    const fit = overlay.fit ?? "fill";
    if (fit === "fill") {
      filters.push(`scale=${width}:${height}`);
    } else if (fit === "contain") {
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      );
    } else {
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
      );
    }
  }
  const scale = scaleExpression(overlay, fullStartUs, fullEndUs, entranceUs, exitUs);
  filters.push(`scale=w='iw*(${scale})':h='ih*(${scale})':eval=frame`);
  const opacity = overlayMotionExpression(overlay, "opacityMultiplier", fullStartUs, fullEndUs, 1, "T");
  const mask = overlay.mask ?? { kind: "none" as const };
  if (mask.kind === "none" && opacity === "1") {
    filters.push(`colorchannelmixer=aa=${decimal(overlay.opacity)}`);
  } else {
    const radius = mask.kind === "rounded-rectangle"
      ? `min(${decimal(mask.radiusPx)},min(W/2,H/2))`
      : "0";
    const maskExpression = mask.kind === "rounded-rectangle"
      ? `gt(between(X,${radius},W-${radius})+between(Y,${radius},H-${radius})+lte(pow(X-min(max(X,${radius}),W-${radius}),2)+pow(Y-min(max(Y,${radius}),H-${radius}),2),pow(${radius},2)),0)`
      : "1";
    filters.push(
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${decimal(overlay.opacity)}*(${opacity})*(${maskExpression})'`,
    );
  }
  if (overlay.entrance.kind === "fade" && entranceUs > 0) {
    filters.push(`fade=t=in:st=${seconds(fullStartUs)}:d=${seconds(entranceUs)}:alpha=1`);
  }
  if (overlay.exit.kind === "fade" && exitUs > 0) {
    filters.push(`fade=t=out:st=${seconds(fullEndUs - exitUs)}:d=${seconds(exitUs)}:alpha=1`);
  }
  const rotationOffset = overlayMotionExpression(overlay, "rotationOffsetDegrees", fullStartUs, fullEndUs, 0);
  const rotation = rotationOffset === "0"
    ? decimal(overlay.rotationDegrees)
    : `${decimal(overlay.rotationDegrees)}+(${rotationOffset})`;
  if (rotation !== "0") {
    filters.push(`rotate='(${rotation})*PI/180':c=none:ow=rotw(iw):oh=roth(ih)`);
  }
  return filters;
}

function anchorPosition(anchor: OverlayOperation["anchor"], axis: "x" | "y"): string {
  if (axis === "x") {
    if (anchor.endsWith("left") || anchor === "left") return "0";
    if (anchor.endsWith("right") || anchor === "right") return "W-w";
    return "(W-w)/2";
  }
  if (anchor.startsWith("top") || anchor === "top") return "0";
  if (anchor.startsWith("bottom") || anchor === "bottom") return "H-h";
  return "(H-h)/2";
}

function slideExpression(
  overlay: OverlayOperation,
  axis: "x" | "y",
  fullStartUs: number,
  fullEndUs: number,
  entranceUs: number,
  exitUs: number,
): string {
  const expressions: string[] = [];
  for (const [animation, startUs, durationUs, entering] of [
    [overlay.entrance, fullStartUs, entranceUs, true],
    [overlay.exit, fullEndUs - exitUs, exitUs, false],
  ] as const) {
    if (animation.kind !== "slide" || durationUs === 0) continue;
    const onAxis = axis === "x"
      ? animation.direction === "left" || animation.direction === "right"
      : animation.direction === "up" || animation.direction === "down";
    if (!onAxis) continue;
    const sign = animation.direction === "left" || animation.direction === "up" ? -1 : 1;
    const start = seconds(startUs);
    const end = seconds(startUs + durationUs);
    const from = entering ? sign * animation.distancePx : 0;
    const delta = entering ? -sign * animation.distancePx : sign * animation.distancePx;
    const progress = `(t-${start})/(${end}-${start})`;
    expressions.push(`if(between(t,${start},${end}),${decimal(from)}+${decimal(delta)}*(${eased(animation.easing, progress)}),0)`);
  }
  return expressions.length === 0 ? "0" : expressions.join("+");
}

function overlayPositionExpression(
  overlay: OverlayOperation,
  axis: "x" | "y",
  fullStartUs: number,
  fullEndUs: number,
  entranceUs: number,
  exitUs: number,
): string {
  const field = axis === "x" ? "positionX" : "positionY";
  return `${anchorPosition(overlay.anchor, axis)}+${decimal(overlay.position[axis])}+${overlayMotionExpression(overlay, field, fullStartUs, fullEndUs, 0)}+${slideExpression(overlay, axis, fullStartUs, fullEndUs, entranceUs, exitUs)}`;
}

function overlayVideoChain(
  resolved: ResolvedProjectOverlay,
  fullStartUs: number,
  fullEndUs: number,
  frameRate: number,
): { readonly filters: readonly string[]; readonly visibleEndUs: number } | null {
  const overlay = resolved.operation;
  const sliceDurationUs = resolved.outputRange.endUs - resolved.outputRange.startUs;
  const filters: string[] = [];
  let visibleDurationUs = sliceDurationUs;
  if (overlay.source.kind === "gif" || overlay.source.kind === "video") {
    const playback = overlay.source.playback;
    const streamStartUs = playback.streamStartUs ?? 0;
    const sourceWindowUs = playback.sourceOutUs - playback.sourceInUs;
    const offsetSourceUs = Math.round(resolved.playbackOffsetUs * playback.playbackRate);
    const requiredSourceUs = Math.ceil(sliceDurationUs * playback.playbackRate);
    const requestedEndSourceUs = offsetSourceUs + requiredSourceUs;
    if (
      !Number.isSafeInteger(offsetSourceUs)
      || !Number.isSafeInteger(requiredSourceUs)
      || !Number.isSafeInteger(requestedEndSourceUs)
      || offsetSourceUs < 0
      || requiredSourceUs <= 0
    ) {
      throw new CliError("unsupported-plan", `Overlay ${overlay.overlayId} has an unsupported playback duration.`);
    }
    const needsLoop = playback.endBehavior === "loop" && requestedEndSourceUs > sourceWindowUs;
    const decodedSourceUs = Math.min(sourceWindowUs, requestedEndSourceUs);
    const effectiveSourceOutUs = streamStartUs + playback.sourceInUs + decodedSourceUs;
    if (!Number.isSafeInteger(effectiveSourceOutUs)) {
      throw new CliError("unsupported-plan", `Overlay ${overlay.overlayId} has an unsupported source window.`);
    }
    filters.push(
      `trim=start=${seconds(streamStartUs + playback.sourceInUs)}:end=${seconds(effectiveSourceOutUs)}`,
      "setpts=PTS-STARTPTS",
      `fps=${decimal(frameRate)}`,
    );
    if (needsLoop) {
      const frameCount = Math.max(1, Math.ceil(sourceWindowUs * frameRate / 1_000_000));
      if (frameCount > 1_000_000) throw new CliError("unsupported-plan", "Animated overlay loop exceeds the frame buffer bound.");
      assertVideoLoopBufferWithinLimit({
        frameCount,
        label: `Overlay ${overlay.overlayId}`,
        pixelHeight: overlay.intrinsicSize.height,
        pixelWidth: overlay.intrinsicSize.width,
      });
      filters.push("format=rgba");
      filters.push(`loop=loop=-1:size=${frameCount}:start=0`);
    } else if (playback.endBehavior === "freeze-end") {
      filters.push(`tpad=stop_mode=clone:stop_duration=${seconds(offsetSourceUs + requiredSourceUs)}`);
    } else {
      if (offsetSourceUs >= sourceWindowUs) return null;
      visibleDurationUs = Math.min(sliceDurationUs, (sourceWindowUs - offsetSourceUs) / playback.playbackRate);
    }
    filters.push(
      `trim=start=${seconds(offsetSourceUs)}:duration=${seconds(Math.min(requiredSourceUs, playback.endBehavior === "hide" ? sourceWindowUs - offsetSourceUs : requiredSourceUs))}`,
      `setpts=(PTS-STARTPTS)/${decimal(playback.playbackRate)}+${seconds(resolved.outputRange.startUs)}/TB`,
    );
  } else {
    filters.push(
      `trim=duration=${seconds(sliceDurationUs)}`,
      `setpts=PTS-STARTPTS+${seconds(resolved.outputRange.startUs)}/TB`,
    );
  }
  const { entranceUs, exitUs } = effectiveAnimationBounds(overlay, fullEndUs - fullStartUs);
  filters.push(...overlayGeometryFilters(overlay, fullStartUs, fullEndUs, entranceUs, exitUs));
  return { filters, visibleEndUs: resolved.outputRange.startUs + Math.round(visibleDurationUs) };
}

function overlayAudioChain(resolved: ResolvedProjectOverlay): {
  readonly audibleEndUs: number;
  readonly audibleStartUs: number;
  readonly filters: readonly string[];
  readonly loopDuck: {
    readonly audioDelayUs: number;
    readonly audioEndUs: number;
    readonly sourceOffsetUs: number;
    readonly sourceWindowUs: number;
  } | null;
} | null {
  const source = resolved.operation.source;
  if (source.kind !== "video" || source.audioPolicy.kind === "mute") return null;
  const playback = source.playback;
  const streamStartUs = playback.streamStartUs ?? 0;
  const audioDelayUs = Math.max(0, (playback.audioStartUs ?? streamStartUs) - (streamStartUs + playback.sourceInUs));
  const sliceDurationUs = resolved.outputRange.endUs - resolved.outputRange.startUs;
  const sourceWindowUs = playback.sourceOutUs - playback.sourceInUs;
  const selectedSourceStartUs = streamStartUs + playback.sourceInUs;
  const audioEndUs = Math.min(
    sourceWindowUs,
    Math.max(
      0,
      (playback.audioEndUs ?? selectedSourceStartUs + sourceWindowUs) - selectedSourceStartUs,
    ),
  );
  const offsetSourceUs = Math.round(resolved.playbackOffsetUs * playback.playbackRate);
  if (playback.endBehavior === "hide" && offsetSourceUs >= sourceWindowUs) return null;
  const requiredSourceUs = Math.ceil(sliceDurationUs * playback.playbackRate);
  const requestedEndSourceUs = offsetSourceUs + requiredSourceUs;
  if (
    !Number.isSafeInteger(offsetSourceUs)
    || !Number.isSafeInteger(requiredSourceUs)
    || !Number.isSafeInteger(requestedEndSourceUs)
    || offsetSourceUs < 0
    || requiredSourceUs <= 0
  ) {
    throw new CliError("unsupported-plan", `Overlay ${resolved.operation.overlayId} has an unsupported audio duration.`);
  }
  const needsLoop = playback.endBehavior === "loop" && requestedEndSourceUs > sourceWindowUs;
  const audibleSourceRange = resolveAudibleSourceRange({
    audioDelayUs,
    audioEndUs,
    endBehavior: playback.endBehavior,
    requestedDurationUs: requiredSourceUs,
    requestedStartUs: offsetSourceUs,
    sourceWindowUs,
  });
  if (audibleSourceRange === null) return null;
  const audibleStartUs = resolved.outputRange.startUs + Math.ceil(
    (audibleSourceRange.startUs - offsetSourceUs) / playback.playbackRate,
  );
  const audibleEndUs = Math.min(
    resolved.outputRange.endUs,
    resolved.outputRange.startUs + Math.floor(
      (audibleSourceRange.endUs - offsetSourceUs) / playback.playbackRate,
    ),
  );
  if (audibleEndUs <= audibleStartUs) return null;
  const decodedSourceUs = Math.min(sourceWindowUs, requestedEndSourceUs);
  const effectiveSourceOutUs = streamStartUs + playback.sourceInUs + decodedSourceUs;
  if (!Number.isSafeInteger(effectiveSourceOutUs)) {
    throw new CliError("unsupported-plan", `Overlay ${resolved.operation.overlayId} has an unsupported audio source window.`);
  }
  const filters = [
    `atrim=start=${seconds(streamStartUs + playback.sourceInUs)}:end=${seconds(effectiveSourceOutUs)}`,
    "aresample=48000",
    "asetpts=PTS-STARTPTS",
    ...(audioDelayUs === 0 ? [] : [`adelay=${decimal(audioDelayUs / 1_000)}:all=1`]),
  ];
  if (needsLoop) {
    const samples = Math.max(1, Math.ceil(sourceWindowUs * 48_000 / 1_000_000));
    if (samples > 10_000_000) throw new CliError("unsupported-plan", "Animated overlay audio loop exceeds its sample buffer bound.");
    assertAudioLoopBufferWithinLimit({ label: `Overlay ${resolved.operation.overlayId}`, sampleCount: samples });
    if (audioEndUs < sourceWindowUs) {
      filters.push(`apad=pad_dur=${seconds(sourceWindowUs - audioEndUs)}`);
    }
    filters.push(`atrim=duration=${seconds(sourceWindowUs)}`);
    filters.push("aformat=sample_fmts=flt:channel_layouts=stereo");
    filters.push(`aloop=loop=-1:size=${samples}`);
  }
  const usableSourceUs = playback.endBehavior === "loop"
    ? requiredSourceUs
    : Math.max(0, Math.min(requiredSourceUs, sourceWindowUs - offsetSourceUs));
  if (usableSourceUs === 0) return null;
  filters.push(
    `atrim=start=${seconds(offsetSourceUs)}:duration=${seconds(usableSourceUs)}`,
    atempo(playback.playbackRate),
    `asetpts=PTS-STARTPTS+${seconds(resolved.outputRange.startUs)}/TB`,
    `volume=${decimal(source.audioPolicy.volume)}`,
  );
  return {
    audibleEndUs,
    audibleStartUs,
    filters,
    loopDuck: needsLoop && (audioDelayUs > 0 || audioEndUs < sourceWindowUs)
      ? { audioDelayUs, audioEndUs, sourceOffsetUs: offsetSourceUs, sourceWindowUs }
      : null,
  };
}

function overlayVisibleEndUs(overlay: OverlayOperation, startUs: number, endUs: number): number {
  const source = overlay.source;
  if ((source.kind !== "gif" && source.kind !== "video") || source.playback.endBehavior !== "hide") return endUs;
  const sourceWindowUs = source.playback.sourceOutUs - source.playback.sourceInUs;
  return Math.min(endUs, startUs + Math.round(sourceWindowUs / source.playback.playbackRate));
}

type AudioSlice = ProjectRenderPlanV1["audioSlices"][number];

function audioSlicesAreContinuous(left: AudioSlice, right: AudioSlice): boolean {
  return left.placementId === right.placementId
    && left.streamId === right.streamId
    && left.outputRange.endUs === right.outputRange.startUs
    && left.projectRange.endUs === right.projectRange.startUs
    && left.assetRange.endUs === right.assetRange.startUs
    && left.presentation.enabled
    && right.presentation.enabled
    && left.presentation.gainDb === right.presentation.gainDb
    && left.presentation.pan === right.presentation.pan;
}

function audioFadeBoundaries(
  slices: readonly AudioSlice[],
): ReadonlyMap<AudioSlice, Readonly<{ readonly fadeIn: boolean; readonly fadeOut: boolean }>> {
  const groups = new Map<string, AudioSlice[]>();
  for (const slice of slices) {
    const key = `${slice.placementId}\u0000${slice.streamId}`;
    const group = groups.get(key) ?? [];
    group.push(slice);
    groups.set(key, group);
  }
  const boundaries = new Map<AudioSlice, { readonly fadeIn: boolean; readonly fadeOut: boolean }>();
  for (const group of groups.values()) {
    group.sort((left, right) => (
      left.outputRange.startUs - right.outputRange.startUs
      || left.projectRange.startUs - right.projectRange.startUs
      || left.assetRange.startUs - right.assetRange.startUs
    ));
    for (const [index, slice] of group.entries()) {
      const previous = group[index - 1];
      const next = group[index + 1];
      boundaries.set(slice, {
        fadeIn: previous === undefined || !audioSlicesAreContinuous(previous, slice),
        fadeOut: next === undefined || !audioSlicesAreContinuous(slice, next),
      });
    }
  }
  return boundaries;
}

export interface ProjectRenderBuildOptions {
  readonly dryRun?: boolean;
  readonly ffmpeg: string;
  readonly ffprobe?: string;
  readonly outputPath: string;
  readonly projectDirectory: string;
  /** Versioned host-owned encoder recipe. Omitted only for v1 compatibility. */
  readonly renderTier?: ProjectRenderTier;
  readonly repositoryRoot: string;
  readonly rsvgConvert?: string;
  readonly rsvgConvertVersion?: string;
  readonly runner?: ProcessRunner;
  /** Host-owned private root for filter graphs and SVG derivatives. */
  readonly workspaceDirectory?: string;
}

function projectRenderEncoderArguments(
  recipe: ProjectRenderEncoderRecipe | undefined,
): readonly string[] {
  return recipe === undefined
    ? []
    : [
        "-threads:v", String(recipe.video.threads),
        "-preset", recipe.video.preset,
        "-crf", String(recipe.video.crf),
        "-b:a", recipe.audio.bitrate,
      ];
}

function projectRenderFilterThreadArguments(
  recipe: ProjectRenderEncoderRecipe | undefined,
): readonly string[] {
  return recipe === undefined
    ? []
    : [
        "-filter_threads", String(recipe.filterThreads),
        "-filter_complex_threads", String(recipe.filterComplexThreads),
      ];
}

function projectRenderDecoderThreadArguments(
  recipe: ProjectRenderEncoderRecipe | undefined,
): readonly string[] {
  return recipe === undefined
    ? []
    : ["-threads", String(recipe.decoderThreads)];
}

export interface ProjectRenderPinnedInput extends ExpectedProjectMediaIntegrity {
  readonly label: string;
  readonly path: string;
}

export interface BuiltProjectRenderInvocation {
  readonly argv: readonly [string, ...string[]];
  readonly invocation: ProjectRenderInvocation;
  readonly pinnedInputs: readonly ProjectRenderPinnedInput[];
}

export async function reverifyProjectRenderInputs(
  inputs: readonly ProjectRenderPinnedInput[],
): Promise<void> {
  await Promise.all(inputs.map(async input => {
    await verifyPhysicalProjectMedia(input.path, input, input.label);
  }));
}

export async function buildProjectFfmpegInvocation(
  plan: ProjectRenderPlanV1,
  options: ProjectRenderBuildOptions,
): Promise<BuiltProjectRenderInvocation> {
  if (plan.output.durationUs <= 0) throw new CliError("unsupported-plan", "A zero-duration project cannot render.");
  const projectRoot = await realpath(options.projectDirectory);
  const output = resolve(options.outputPath);
  if (!isWithin(projectRoot, output)) throw new CliError("unsafe-path", "Project render output must remain in its project directory.");
  const outputRelative = relative(projectRoot, output);
  if (!outputRelative.startsWith("renders/") || isAbsolute(outputRelative)) {
    throw new CliError("unsafe-path", "Project render output must remain under renders/.");
  }
  const encoderRecipe = options.renderTier === undefined
    ? undefined
    : resolveProjectRenderEncoderRecipe(options.renderTier);

  const mediaIntegrity = new Map<string, ExpectedProjectMediaIntegrity>();
  for (const slice of [...plan.videoSlices, ...plan.audioSlices]) {
    const expected = { bytes: slice.bytes, sha256: slice.sha256 };
    const prior = mediaIntegrity.get(slice.path);
    if (prior !== undefined && (prior.bytes !== expected.bytes || prior.sha256 !== expected.sha256)) {
      throw new CliError("invalid-data", `Render slices disagree about media integrity for ${slice.path}.`);
    }
    mediaIntegrity.set(slice.path, expected);
  }
  const mediaInputIndex = new Map<string, number>();
  const inputArguments: string[] = [];
  const pinnedInputs: ProjectRenderPinnedInput[] = [];
  for (const [path, expected] of mediaIntegrity) {
    mediaInputIndex.set(path, mediaInputIndex.size);
    const physical = await resolveVerifiedProjectMedia({
      expected,
      label: `Project media ${path}`,
      path,
      repositoryRoot: options.repositoryRoot,
    });
    inputArguments.push(
      ...projectRenderDecoderThreadArguments(encoderRecipe),
      "-i",
      physical,
    );
    pinnedInputs.push({
      ...expected,
      label: `Project media ${path}`,
      path: physical,
    });
  }
  const overlayInputIndex = new Map<string, number>();
  const preparedOverlayMedia = new Map<string, PreparedProjectOverlayMedia>();
  for (const resolvedOverlay of plan.overlays) {
    const overlay = resolvedOverlay.operation;
    if (overlayInputIndex.has(overlay.overlayId)) continue;
    overlayInputIndex.set(overlay.overlayId, mediaInputIndex.size + overlayInputIndex.size);
    if (overlay.source.kind === "image" || overlay.source.kind === "svg" || overlay.source.kind === "emoji") {
      inputArguments.push("-loop", "1");
    }
    const prepared = await prepareProjectOverlayMedia(overlay, options);
    preparedOverlayMedia.set(overlay.overlayId, prepared);
    inputArguments.push(
      ...projectRenderDecoderThreadArguments(encoderRecipe),
      "-i",
      prepared.path,
    );
    pinnedInputs.push({
      bytes: overlay.source.asset.bytes,
      label: `Overlay ${overlay.overlayId}`,
      path: prepared.sourcePath,
      sha256: overlay.source.asset.sha256,
    });
    if (prepared.path !== prepared.sourcePath && !options.dryRun) {
      const derivative = await fingerprintPhysicalProjectMedia(
        prepared.path,
        MAXIMUM_SVG_DERIVATIVE_BYTES,
      );
      pinnedInputs.push({
        bytes: derivative.bytes,
        label: `Prepared overlay ${overlay.overlayId}`,
        path: derivative.path,
        sha256: derivative.sha256,
      });
    }
  }

  const filters: string[] = [
    `color=c=${plan.output.background}:s=${plan.output.pixelWidth}x${plan.output.pixelHeight}:r=${decimal(plan.output.frameRate)}:d=${seconds(plan.output.durationUs)},format=rgba[canvas_0]`,
  ];
  const cameraIndex = buildProjectCameraSpatialIndex(plan);
  let currentVideo = "canvas_0";
  let serial = 0;
  for (const slice of plan.videoSlices) {
    if (!slice.presentation.enabled) continue;
    const input = mediaInputIndex.get(slice.path)!;
    const label = `project_video_${serial++}`;
    const inputDurationUs = slice.fileRange.endUs - slice.fileRange.startUs;
    const outputDurationUs = slice.outputRange.endUs - slice.outputRange.startUs;
    const transform = videoTransform(slice, plan.output.pixelWidth, plan.output.pixelHeight);
    const chain = [
      `trim=start=${seconds(slice.fileRange.startUs)}:end=${seconds(slice.fileRange.endUs)}`,
      `setpts=(PTS-STARTPTS)*${decimal(outputDurationUs / inputDurationUs)}+${seconds(slice.outputRange.startUs)}/TB`,
      ...transform.filters,
      ...projectCameraFilters(plan, slice, cameraIndex),
    ];
    filters.push(`[${inputSpecifier(input, slice.streamIndex)}]${chain.join(",")}[${label}]`);
    const next = `canvas_${serial++}`;
    if (slice.presentation.blendMode === "normal") {
      filters.push(
        `[${currentVideo}][${label}]overlay=x=${transform.x}:y=${transform.y}:eof_action=pass:repeatlast=0:enable='between(t,${seconds(slice.outputRange.startUs)},${seconds(slice.outputRange.endUs)})'[${next}]`,
      );
    } else {
      const transparent = `video_blend_canvas_${serial++}`;
      const positioned = `video_blend_positioned_${serial++}`;
      const layerColor = `video_blend_color_${serial++}`;
      const layerAlphaSource = `video_blend_alpha_source_${serial++}`;
      const layerMask = `video_blend_mask_${serial++}`;
      const baseBlend = `video_blend_base_${serial++}`;
      const baseMerge = `video_blend_merge_${serial++}`;
      const blended = `video_blend_result_${serial++}`;
      const enable = `between(t,${seconds(slice.outputRange.startUs)},${seconds(slice.outputRange.endUs)})`;
      filters.push(
        `color=c=black@0:s=${plan.output.pixelWidth}x${plan.output.pixelHeight}:r=${decimal(plan.output.frameRate)}:d=${seconds(plan.output.durationUs)},format=rgba[${transparent}]`,
        `[${transparent}][${label}]overlay=x=${transform.x}:y=${transform.y}:eof_action=pass:repeatlast=0:enable='${enable}'[${positioned}]`,
        `[${positioned}]format=rgba,split=2[${layerColor}][${layerAlphaSource}]`,
        `[${layerAlphaSource}]alphaextract[${layerMask}]`,
        `[${currentVideo}]split=2[${baseBlend}][${baseMerge}]`,
        `[${baseBlend}][${layerColor}]blend=all_mode=${slice.presentation.blendMode}[${blended}]`,
        `[${baseMerge}][${blended}][${layerMask}]maskedmerge[${next}]`,
      );
    }
    currentVideo = next;
  }

  ({ currentVideo, serial } = applyMetadataEffects({
    cameraKeyframes: [],
    effects: plan.effects,
    output: plan.output,
  }, filters, currentVideo, serial));

  const orderedOverlays = [...plan.overlays].sort((left, right) => (
    left.operation.zIndex - right.operation.zIndex
    || left.outputRange.startUs - right.outputRange.startUs
    || left.operation.overlayId.localeCompare(right.operation.overlayId)
  ));
  const overlayBounds = new Map<string, { readonly endUs: number; readonly startUs: number }>();
  for (const resolvedOverlay of orderedOverlays) {
    const prior = overlayBounds.get(resolvedOverlay.operation.overlayId);
    overlayBounds.set(resolvedOverlay.operation.overlayId, {
      endUs: Math.max(prior?.endUs ?? 0, resolvedOverlay.outputRange.endUs),
      startUs: Math.min(prior?.startUs ?? Number.MAX_SAFE_INTEGER, resolvedOverlay.outputRange.startUs),
    });
  }
  for (const resolvedOverlay of orderedOverlays) {
    const bounds = overlayBounds.get(resolvedOverlay.operation.overlayId)!;
    const visibleFullEndUs = overlayVisibleEndUs(resolvedOverlay.operation, bounds.startUs, bounds.endUs);
    const chain = overlayVideoChain(resolvedOverlay, bounds.startUs, visibleFullEndUs, plan.output.frameRate);
    if (chain === null) continue;
    const input = overlayInputIndex.get(resolvedOverlay.operation.overlayId)!;
    const label = `graphic_${serial++}`;
    const source = resolvedOverlay.operation.source;
    const prepared = preparedOverlayMedia.get(resolvedOverlay.operation.overlayId)!;
    const videoStreamIndex = source.kind === "gif" || source.kind === "video"
      ? prepared.videoStreamIndex ?? source.playback.videoStreamIndex
      : null;
    filters.push(`[${animatedStreamSpecifier(input, "v", videoStreamIndex)}]${chain.filters.join(",")}[${label}]`);
    const overlay = resolvedOverlay.operation;
    const animations = effectiveAnimationBounds(overlay, visibleFullEndUs - bounds.startUs);
    const x = overlayPositionExpression(overlay, "x", bounds.startUs, visibleFullEndUs, animations.entranceUs, animations.exitUs);
    const y = overlayPositionExpression(overlay, "y", bounds.startUs, visibleFullEndUs, animations.entranceUs, animations.exitUs);
    const next = `canvas_${serial++}`;
    const enable = `between(t,${seconds(resolvedOverlay.outputRange.startUs)},${seconds(chain.visibleEndUs)})`;
    const blendMode = overlay.blendMode ?? "normal";
    if (blendMode === "normal") {
      filters.push(
        `[${currentVideo}][${label}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:enable='${enable}'[${next}]`,
      );
    } else {
      const transparent = `graphic_blend_canvas_${serial++}`;
      const positioned = `graphic_blend_positioned_${serial++}`;
      const layerColor = `graphic_blend_color_${serial++}`;
      const layerAlphaSource = `graphic_blend_alpha_source_${serial++}`;
      const layerMask = `graphic_blend_mask_${serial++}`;
      const baseBlend = `graphic_blend_base_${serial++}`;
      const baseMerge = `graphic_blend_merge_${serial++}`;
      const blended = `graphic_blend_result_${serial++}`;
      filters.push(
        `color=c=black@0:s=${plan.output.pixelWidth}x${plan.output.pixelHeight}:r=${decimal(plan.output.frameRate)}:d=${seconds(plan.output.durationUs)},format=rgba[${transparent}]`,
        `[${transparent}][${label}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:enable='${enable}'[${positioned}]`,
        `[${positioned}]format=rgba,split=2[${layerColor}][${layerAlphaSource}]`,
        `[${layerAlphaSource}]alphaextract[${layerMask}]`,
        `[${currentVideo}]split=2[${baseBlend}][${baseMerge}]`,
        `[${baseBlend}][${layerColor}]blend=all_mode=${blendMode}[${blended}]`,
        `[${baseMerge}][${blended}][${layerMask}]maskedmerge[${next}]`,
      );
    }
    currentVideo = next;
  }
  filters.push(`[${currentVideo}]format=yuv420p[video_out]`);

  const audioLabels: string[] = [];
  const fadeBoundaries = audioFadeBoundaries(plan.audioSlices);
  for (const slice of plan.audioSlices) {
    if (!slice.presentation.enabled) continue;
    const input = mediaInputIndex.get(slice.path)!;
    const label = `project_audio_${serial++}`;
    const inputDurationUs = slice.fileRange.endUs - slice.fileRange.startUs;
    const outputDurationUs = slice.outputRange.endUs - slice.outputRange.startUs;
    const playbackRate = inputDurationUs / outputDurationUs;
    const fadeUs = Math.min(5_000, Math.floor(outputDurationUs / 4));
    const boundary = fadeBoundaries.get(slice) ?? { fadeIn: true, fadeOut: true };
    const chain = [
      `atrim=start=${seconds(slice.fileRange.startUs)}:end=${seconds(slice.fileRange.endUs)}`,
      "asetpts=PTS-STARTPTS",
      "aresample=48000",
      atempo(playbackRate),
      `atrim=duration=${seconds(outputDurationUs)}`,
      ...(fadeUs > 0 && boundary.fadeIn ? [`afade=t=in:st=0:d=${seconds(fadeUs)}`] : []),
      ...(fadeUs > 0 && boundary.fadeOut
        ? [`afade=t=out:st=${seconds(outputDurationUs - fadeUs)}:d=${seconds(fadeUs)}`]
        : []),
      `volume=${decimal(slice.presentation.gainDb)}dB`,
      "aformat=channel_layouts=stereo",
      ...(slice.presentation.pan === 0 ? [] : [`stereotools=balance_out=${decimal(slice.presentation.pan)}`]),
      `asetpts=PTS-STARTPTS+${seconds(slice.outputRange.startUs)}/TB`,
    ];
    filters.push(`[${inputSpecifier(input, slice.streamIndex)}]${chain.join(",")}[${label}]`);
    audioLabels.push(label);
  }
  filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(plan.output.durationUs)}[silence]`);
  const primaryAudio = "primary_audio";
  filters.push(
    `[silence]${audioLabels.map(label => `[${label}]`).join("")}amix=inputs=${audioLabels.length + 1}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${seconds(plan.output.durationUs)}[${primaryAudio}]`,
  );
  const overlayAudioLabels: string[] = [];
  const duckEnvelopes: { readonly condition: string; readonly target: number }[] = [];
  for (const resolvedOverlay of orderedOverlays) {
    const overlayAudio = overlayAudioChain(resolvedOverlay);
    if (overlayAudio === null) continue;
    const input = overlayInputIndex.get(resolvedOverlay.operation.overlayId)!;
    const label = `graphic_audio_${serial++}`;
    const source = resolvedOverlay.operation.source;
    const prepared = preparedOverlayMedia.get(resolvedOverlay.operation.overlayId)!;
    const audioStreamIndex = source.kind === "video"
      ? prepared.audioStreamIndex ?? source.playback.audioStreamIndex
      : null;
    filters.push(`[${animatedStreamSpecifier(input, "a", audioStreamIndex)}]${overlayAudio.filters.join(",")}[${label}]`);
    if (source.kind === "video" && source.audioPolicy.kind === "duck-primary") {
      const duckCondition = overlayAudio.loopDuck === null
        ? `between(t,${seconds(overlayAudio.audibleStartUs)},${seconds(overlayAudio.audibleEndUs)})`
        : [
            `between(t,${seconds(resolvedOverlay.outputRange.startUs)},${seconds(resolvedOverlay.outputRange.endUs)})`,
            `gte(mod(${seconds(overlayAudio.loopDuck.sourceOffsetUs)}+(t-${seconds(resolvedOverlay.outputRange.startUs)})*${decimal(source.playback.playbackRate)},${seconds(overlayAudio.loopDuck.sourceWindowUs)}),${seconds(overlayAudio.loopDuck.audioDelayUs)})`,
            `lt(mod(${seconds(overlayAudio.loopDuck.sourceOffsetUs)}+(t-${seconds(resolvedOverlay.outputRange.startUs)})*${decimal(source.playback.playbackRate)},${seconds(overlayAudio.loopDuck.sourceWindowUs)}),${seconds(overlayAudio.loopDuck.audioEndUs)})`,
          ].join("*");
      duckEnvelopes.push({ condition: duckCondition, target: source.audioPolicy.duckPrimaryTo });
    }
    overlayAudioLabels.push(label);
  }
  let currentPrimaryAudio = primaryAudio;
  if (duckEnvelopes.length > 0) {
    const ducked = `ducked_${serial++}`;
    const duckVolume = duckEnvelopes
      .map(envelope => `if(${envelope.condition},${decimal(envelope.target)},1)`)
      .reduce((left, right) => `min(${left},${right})`);
    filters.push(`[${primaryAudio}]volume='${duckVolume}':eval=frame[${ducked}]`);
    currentPrimaryAudio = ducked;
  }
  let currentAudio = currentPrimaryAudio;
  if (overlayAudioLabels.length > 0) {
    const mixed = `mixed_${serial++}`;
    filters.push(
      `[${currentPrimaryAudio}]${overlayAudioLabels.map(label => `[${label}]`).join("")}amix=inputs=${overlayAudioLabels.length + 1}:duration=longest:dropout_transition=0:normalize=0[${mixed}]`,
    );
    currentAudio = mixed;
  }

  const filterGraph = await materializeFilterScript({
    graph: filters.join(";"),
    relativeDirectory: options.workspaceDirectory === undefined
      ? "renders/.filter-graphs"
      : "filter-graphs",
    root: options.workspaceDirectory ?? projectRoot,
  });
  const arguments_: string[] = [
    "-hide_banner", "-nostdin", "-y",
    ...projectRenderFilterThreadArguments(encoderRecipe),
    ...inputArguments,
    "-filter_complex_script", filterGraph.path,
    "-map", "[video_out]",
    "-map", `[${currentAudio}]`,
    "-c:v", encoderRecipe?.video.codec ?? "libx264",
    ...projectRenderEncoderArguments(encoderRecipe),
    "-pix_fmt", encoderRecipe?.video.pixelFormat ?? "yuv420p",
    "-c:a", encoderRecipe?.audio.codec ?? "aac",
    "-t", seconds(plan.output.durationUs),
    "-movflags", encoderRecipe?.container.movflags ?? "+faststart",
    output,
  ];
  const invocation = ProjectRenderInvocationSchema.parse({
    arguments: arguments_,
    executable: "ffmpeg",
    filterGraph: {
      bytes: filterGraph.bytes,
      path: filterGraph.repositoryPath,
      sha256: filterGraph.sha256,
    },
    outputPath: outputRelative,
    renderPlanSha256: canonicalJsonSha256(plan),
  });
  return {
    argv: [options.ffmpeg, ...arguments_],
    invocation,
    pinnedInputs,
  };
}
