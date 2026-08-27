import { z } from "zod";

import { SourceIntervalSchema, type SourceInterval } from "../contracts/edit";

const MAXIMUM_PIXEL_DIMENSION = 16_384;
const MAXIMUM_PANELS = 64;
const MAXIMUM_CLIPS = 4_096;

const PixelSizeSchema = z.strictObject({
  height: z.number().int().positive().max(MAXIMUM_PIXEL_DIMENSION),
  width: z.number().int().positive().max(MAXIMUM_PIXEL_DIMENSION),
});

const PixelRectSchema = PixelSizeSchema.extend({
  x: z.number().int().nonnegative().max(MAXIMUM_PIXEL_DIMENSION),
  y: z.number().int().nonnegative().max(MAXIMUM_PIXEL_DIMENSION),
});

const CanvasSizeSchema = PixelSizeSchema.superRefine((canvas, context) => {
  if (canvas.width % 2 !== 0 || canvas.height % 2 !== 0) {
    context.addIssue({ code: "custom", message: "Montage canvas dimensions must be even." });
  }
});

const MontagePanelInputSchema = z.strictObject({
  cell: PixelRectSchema,
  panelId: z.string().min(1).max(128),
  source: PixelSizeSchema,
});

const ContainedMosaicInputSchema = z.strictObject({
  canvas: CanvasSizeSchema,
  panels: z.array(MontagePanelInputSchema).min(1).max(MAXIMUM_PANELS),
}).superRefine((input, context) => {
  const panelIds = new Set<string>();
  for (const [index, panel] of input.panels.entries()) {
    if (panelIds.has(panel.panelId)) {
      context.addIssue({
        code: "custom",
        message: `Montage panel IDs must be unique; received ${panel.panelId} more than once.`,
        path: ["panels", index, "panelId"],
      });
    }
    panelIds.add(panel.panelId);
    if (
      panel.cell.x + panel.cell.width > input.canvas.width
      || panel.cell.y + panel.cell.height > input.canvas.height
    ) {
      context.addIssue({
        code: "custom",
        message: `Montage panel ${panel.panelId} exceeds the canvas.`,
        path: ["panels", index, "cell"],
      });
    }
  }
  for (let leftIndex = 0; leftIndex < input.panels.length; leftIndex += 1) {
    const left = input.panels[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < input.panels.length; rightIndex += 1) {
      const right = input.panels[rightIndex];
      if (right === undefined) continue;
      const overlaps = left.cell.x < right.cell.x + right.cell.width
        && right.cell.x < left.cell.x + left.cell.width
        && left.cell.y < right.cell.y + right.cell.height
        && right.cell.y < left.cell.y + left.cell.height;
      if (overlaps) {
        context.addIssue({
          code: "custom",
          message: `Montage panel cells ${left.panelId} and ${right.panelId} overlap.`,
          path: ["panels", rightIndex, "cell"],
        });
      }
    }
  }
});

const MontageClipInputSchema = z.strictObject({
  clipId: z.string().min(1).max(128),
  source: SourceIntervalSchema,
});

const MontageSequenceInputSchema = z.strictObject({
  clips: z.array(MontageClipInputSchema).min(1).max(MAXIMUM_CLIPS),
  preferredTransitionDurationUs: z.number().int().positive().max(5_000_000),
}).superRefine((input, context) => {
  const clipIds = new Set<string>();
  for (const [index, clip] of input.clips.entries()) {
    if (clipIds.has(clip.clipId)) {
      context.addIssue({
        code: "custom",
        message: `Montage clip IDs must be unique; received ${clip.clipId} more than once.`,
        path: ["clips", index, "clipId"],
      });
    }
    clipIds.add(clip.clipId);
    if (input.clips.length > 1 && clip.source.endUs - clip.source.startUs < 2) {
      context.addIssue({
        code: "custom",
        message: "Every clip in a multi-clip montage must be at least two microseconds long.",
        path: ["clips", index, "source"],
      });
    }
  }
});

export interface PixelSize {
  readonly height: number;
  readonly width: number;
}

export interface PixelRect extends PixelSize {
  readonly x: number;
  readonly y: number;
}

export interface ContainedMosaicPanel {
  readonly cell: PixelRect;
  readonly content: PixelRect;
  readonly panelId: string;
  readonly source: PixelSize;
}

export interface ContainedMosaicPlan {
  readonly canvas: PixelSize;
  readonly panels: readonly ContainedMosaicPanel[];
}

export interface MontageClipPlan {
  readonly clipId: string;
  readonly output: SourceInterval;
  readonly source: SourceInterval;
}

export interface MontageTransitionPlan {
  readonly cutOutputUs: number;
  readonly durationUs: number;
  readonly fadeIn: SourceInterval;
  readonly fadeOut: SourceInterval;
  readonly fromClipId: string;
  readonly kind: "dip-to-black";
  readonly toClipId: string;
}

export interface MontageSequencePlan {
  readonly clips: readonly MontageClipPlan[];
  readonly durationUs: number;
  readonly transitions: readonly MontageTransitionPlan[];
}

function evenFloor(value: number): number {
  const integer = Math.floor(value);
  return integer % 2 === 0 ? integer : integer - 1;
}

/**
 * Place caller-selected panels into non-overlapping cells without stretching
 * their content. Even content dimensions remain safe for ordinary yuv420p
 * encoders while the cells retain their exact checked geometry.
 */
export function planContainedMosaic(input: unknown): ContainedMosaicPlan {
  const parsed = ContainedMosaicInputSchema.parse(input);
  return {
    canvas: parsed.canvas,
    panels: parsed.panels.map(panel => {
      const scale = Math.min(
        panel.cell.width / panel.source.width,
        panel.cell.height / panel.source.height,
      );
      const width = Math.min(panel.cell.width, evenFloor(panel.source.width * scale));
      const height = Math.min(panel.cell.height, evenFloor(panel.source.height * scale));
      if (width < 2 || height < 2) {
        throw new RangeError(
          `Montage panel ${panel.panelId} cannot fit encoder-safe even content inside its cell.`,
        );
      }
      return {
        cell: panel.cell,
        content: {
          height,
          width,
          x: panel.cell.x + Math.floor((panel.cell.width - width) / 2),
          y: panel.cell.y + Math.floor((panel.cell.height - height) / 2),
        },
        panelId: panel.panelId,
        source: panel.source,
      };
    }),
  };
}

/**
 * Map an ordered set of source clips onto one contiguous output clock and
 * plan symmetric dip-to-black transitions at every cut. A transition is
 * bounded by both neighboring clips, so even very short selections remain
 * valid and no fade can consume more than half of either clip.
 */
export function planMontageSequence(input: unknown): MontageSequencePlan {
  const parsed = MontageSequenceInputSchema.parse(input);
  let outputCursorUs = 0;
  const clips: MontageClipPlan[] = parsed.clips.map(clip => {
    const durationUs = clip.source.endUs - clip.source.startUs;
    if (!Number.isSafeInteger(outputCursorUs + durationUs)) {
      throw new RangeError("Montage output duration exceeds the safe integer range.");
    }
    const planned = {
      clipId: clip.clipId,
      output: { endUs: outputCursorUs + durationUs, startUs: outputCursorUs },
      source: clip.source,
    };
    outputCursorUs += durationUs;
    return planned;
  });
  const transitions: MontageTransitionPlan[] = [];
  for (let index = 1; index < clips.length; index += 1) {
    const from = clips[index - 1];
    const to = clips[index];
    if (from === undefined || to === undefined) continue;
    const fromDurationUs = from.output.endUs - from.output.startUs;
    const toDurationUs = to.output.endUs - to.output.startUs;
    const durationUs = Math.max(1, Math.min(
      parsed.preferredTransitionDurationUs,
      Math.floor(fromDurationUs / 2),
      Math.floor(toDurationUs / 2),
    ));
    transitions.push({
      cutOutputUs: from.output.endUs,
      durationUs,
      fadeIn: { endUs: to.output.startUs + durationUs, startUs: to.output.startUs },
      fadeOut: { endUs: from.output.endUs, startUs: from.output.endUs - durationUs },
      fromClipId: from.clipId,
      kind: "dip-to-black",
      toClipId: to.clipId,
    });
  }
  return { clips, durationUs: outputCursorUs, transitions };
}
