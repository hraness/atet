import { z } from "zod";

import type { ApplicationContext } from "../../context";
import {
  MediaAudioEffectsInputSchema,
  bindMediaAudioEffectsInput,
} from "./audio-effects";
import {
  MediaColorGradeInputSchema,
  bindMediaColorGradeInput,
} from "./color-grade";
import {
  MediaIngestInputSchema,
  bindMediaIngestInput,
} from "./ingest";
import {
  HtmlOverlayInputSchema,
  bindHtmlOverlayInput,
} from "./html-overlay";
import {
  MediaOverlayInputSchema,
  bindMediaOverlayInput,
} from "./overlay";

export const MEDIA_OPERATION_KINDS = [
  "media.ingest",
  "media.html-overlay",
  "media.overlay",
  "media.audio-effects",
  "media.color-grade",
] as const;

export const MediaOperationKindSchema = z.enum(MEDIA_OPERATION_KINDS);
export type MediaOperationKind = z.infer<typeof MediaOperationKindSchema>;

/**
 * Resolve a progressive path-only request into the exact byte identity that a
 * workflow node plan hashes. Execution binds the same input again immediately
 * before use, so planning does not substitute for the descriptor-pinned read.
 */
export async function bindMediaOperationInput(
  application: ApplicationContext,
  kind: MediaOperationKind,
  input: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  switch (kind) {
    case "media.ingest":
      return await bindMediaIngestInput(
        application,
        MediaIngestInputSchema.parse(input),
        signal,
      );
    case "media.overlay":
      return await bindMediaOverlayInput(
        application,
        MediaOverlayInputSchema.parse(input),
        signal,
      );
    case "media.html-overlay":
      return await bindHtmlOverlayInput(
        application,
        HtmlOverlayInputSchema.parse(input),
        signal,
      );
    case "media.audio-effects":
      return await bindMediaAudioEffectsInput(
        application,
        MediaAudioEffectsInputSchema.parse(input),
        signal,
      );
    case "media.color-grade":
      return await bindMediaColorGradeInput(
        application,
        MediaColorGradeInputSchema.parse(input),
        signal,
      );
  }
}
