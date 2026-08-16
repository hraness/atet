import {
  OverlayOperationSchema,
  ProjectCaptionStylePresetSchema,
  ProjectRenderPlanV1Schema,
  Sha256Schema,
  type ProjectRenderPlanV1,
} from "../../../contracts";
import {
  assertProjectRenderPlanComposition,
  canonicalJsonSha256,
  hashProjectRenderPlanComposition,
  renderSocialCaptionSvg,
  sha256Hex,
  type ProjectCaptionCue,
  type SocialCaptionSvg,
} from "../../../core";

const CAPTION_SPRITE_MAXIMUM_DIMENSION = 4_096;
const CAPTION_SPRITE_GUTTER = 4;
const MAXIMUM_CAPTION_SPRITE_BYTES = 16 * 1_024 * 1_024;

export const PROJECT_CAPTION_SPRITE_LIMITS = Object.freeze({
  maximumCount: 64,
  maximumTotalPixels: 64 * 1_024 * 1_024,
  maximumTotalSvgBytes: 64 * 1_024 * 1_024,
});

interface CaptionCard {
  readonly cue: ProjectCaptionCue;
  readonly rendered: SocialCaptionSvg;
}

interface PositionedCaptionCard extends CaptionCard {
  readonly x: number;
  readonly y: number;
}

interface CaptionSprite {
  readonly cards: readonly PositionedCaptionCard[];
  readonly height: number;
  readonly width: number;
}

export interface PreparedProjectCaptionArtifact {
  readonly contents: string;
  readonly path: string;
  readonly sha256: string;
}

export interface PrepareProjectCaptionPlanInput {
  readonly cues: readonly ProjectCaptionCue[];
  readonly plan: ProjectRenderPlanV1;
  readonly sourceSha256: string;
  readonly style: "social-block-v1";
}

export interface PreparedProjectCaptionPlan {
  readonly artifacts: readonly PreparedProjectCaptionArtifact[];
  readonly plan: ProjectRenderPlanV1;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function captionSprites(cards: readonly CaptionCard[]): readonly CaptionSprite[] {
  const sprites: CaptionSprite[] = [];
  let totalPixels = 0;
  let positioned: PositionedCaptionCard[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let usedWidth = 0;

  const finish = (): void => {
    if (positioned.length === 0) return;
    const height = nextPowerOfTwo(cursorY + rowHeight);
    const width = nextPowerOfTwo(usedWidth);
    const pixels = width * height;
    if (
      sprites.length >= PROJECT_CAPTION_SPRITE_LIMITS.maximumCount
      || totalPixels + pixels > PROJECT_CAPTION_SPRITE_LIMITS.maximumTotalPixels
    ) {
      throw new RangeError(
        "Generated caption sprites exceed the cumulative raster resource bound.",
      );
    }
    sprites.push({
      cards: positioned,
      height,
      width,
    });
    totalPixels += pixels;
    positioned = [];
    cursorX = 0;
    cursorY = 0;
    rowHeight = 0;
    usedWidth = 0;
  };

  for (const card of cards) {
    const { intrinsicHeight: height, intrinsicWidth: width } = card.rendered;
    if (
      width > CAPTION_SPRITE_MAXIMUM_DIMENSION
      || height > CAPTION_SPRITE_MAXIMUM_DIMENSION
    ) {
      throw new RangeError("A social caption card exceeds the sprite dimension bound.");
    }
    if (
      cursorX > 0
      && cursorX + width > CAPTION_SPRITE_MAXIMUM_DIMENSION
    ) {
      cursorX = 0;
      cursorY += rowHeight + CAPTION_SPRITE_GUTTER;
      rowHeight = 0;
    }
    if (
      cursorY > 0
      && cursorY + height > CAPTION_SPRITE_MAXIMUM_DIMENSION
    ) {
      finish();
    }
    positioned.push({ ...card, x: cursorX, y: cursorY });
    cursorX += width + CAPTION_SPRITE_GUTTER;
    rowHeight = Math.max(rowHeight, height);
    usedWidth = Math.max(usedWidth, cursorX - CAPTION_SPRITE_GUTTER);
  }
  finish();
  return sprites;
}

function svgBody(svg: string): string {
  const openingEnd = svg.indexOf(">");
  if (!svg.startsWith("<svg ") || openingEnd < 0 || !svg.endsWith("</svg>")) {
    throw new TypeError("Social caption renderer returned an unsupported SVG document.");
  }
  return svg.slice(openingEnd + 1, -"</svg>".length);
}

function spriteContents(sprite: CaptionSprite): Readonly<{
  bytes: number;
  contents: string;
}> {
  const body = sprite.cards.map(card => (
    `<g transform="translate(${card.x} ${card.y})">${svgBody(card.rendered.svg)}</g>`
  )).join("");
  const contents = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sprite.width}" height="${sprite.height}" viewBox="0 0 ${sprite.width} ${sprite.height}" fill="none">`,
    body,
    "</svg>\n",
  ].join("");
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > MAXIMUM_CAPTION_SPRITE_BYTES) {
    throw new RangeError("A generated caption sprite exceeds the 16 MiB SVG bound.");
  }
  return { bytes, contents };
}

function captionZIndex(plan: ProjectRenderPlanV1): number {
  const maximum = plan.overlays.reduce(
    (value, overlay) => Math.max(value, overlay.operation.zIndex),
    -1,
  );
  if (maximum >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Existing overlay z-index leaves no safe caption layer.");
  }
  return maximum + 1;
}

/**
 * Add output-specific burned captions without changing the immutable project
 * or edit revision. Cards are packed into bounded SVG sprites so the renderer
 * opens one input per sprite rather than one input per timed cue.
 */
export function prepareProjectCaptionPlan(
  input: PrepareProjectCaptionPlanInput,
): PreparedProjectCaptionPlan {
  const plan = assertProjectRenderPlanComposition(input.plan);
  const sourceSha256 = Sha256Schema.parse(input.sourceSha256);
  const style = ProjectCaptionStylePresetSchema.parse(input.style);
  if (input.cues.length === 0) {
    throw new TypeError("Captioned render planning requires at least one visible cue.");
  }
  const cards = input.cues.map((cue): CaptionCard => ({
    cue,
    rendered: renderSocialCaptionSvg(cue, plan.output),
  }));
  const zIndex = captionZIndex(plan);
  const artifacts: PreparedProjectCaptionArtifact[] = [];
  const overlays: ProjectRenderPlanV1["overlays"][number][] = [];
  let totalSvgBytes = 0;

  for (const [spriteIndex, sprite] of captionSprites(cards).entries()) {
    const { bytes, contents } = spriteContents(sprite);
    const sha256 = sha256Hex(contents);
    totalSvgBytes += bytes;
    if (
      totalSvgBytes
      > PROJECT_CAPTION_SPRITE_LIMITS.maximumTotalSvgBytes
    ) {
      throw new RangeError(
        "Generated caption sprites exceed the cumulative SVG byte bound.",
      );
    }
    const path = `renders/caption-assets/${sha256}.svg`;
    const overlayId = `overlay_caption_${canonicalJsonSha256({
      domain: "atet.social-caption-sprite/v1",
      sha256,
      sourceSha256,
      spriteIndex,
      style,
    }).slice(0, 32)}`;
    const source = {
      asset: {
        bytes,
        mediaType: "image/svg+xml" as const,
        path,
        provenance: {
          command: ["atet", "caption", style],
          generator: "atet-social-caption-sprite",
          generatorVersion: "1",
          kind: "generated" as const,
          sourceSha256,
        },
        sha256,
      },
      kind: "svg" as const,
    };
    artifacts.push({ contents, path, sha256 });

    for (const card of sprite.cards) {
      const crop = {
        bottom: (sprite.height - card.y - card.rendered.intrinsicHeight) / sprite.height,
        kind: "normalized-insets" as const,
        left: card.x / sprite.width,
        right: (sprite.width - card.x - card.rendered.intrinsicWidth) / sprite.width,
        top: card.y / sprite.height,
      };
      const operation = OverlayOperationSchema.parse({
        anchor: "bottom",
        crop,
        entrance: { kind: "none" },
        exit: { kind: "none" },
        intrinsicSize: {
          height: sprite.height,
          width: sprite.width,
        },
        opacity: 1,
        overlayId,
        position: {
          x: 0,
          y: -card.rendered.bottomSafeMargin,
        },
        range: card.cue.projectRange,
        rotationDegrees: 0,
        scale: 1,
        size: {
          height: card.rendered.intrinsicHeight,
          kind: "pixels",
          width: card.rendered.intrinsicWidth,
        },
        source,
        zIndex,
      });
      overlays.push({
        operation,
        outputRange: card.cue.outputRange,
        playbackOffsetUs: 0,
        projectRange: card.cue.projectRange,
        visibleDurationUs: card.cue.outputRange.endUs - card.cue.outputRange.startUs,
      });
    }
  }

  const placeholder = ProjectRenderPlanV1Schema.parse({
    ...plan,
    overlays: [...plan.overlays, ...overlays],
    planSha256: "0".repeat(64),
  });
  const captioned = assertProjectRenderPlanComposition(ProjectRenderPlanV1Schema.parse({
    ...placeholder,
    planSha256: hashProjectRenderPlanComposition(placeholder),
  }));
  return { artifacts, plan: captioned };
}
