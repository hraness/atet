import { Effect } from "effect";
import { runStandaloneOperation, type OperationEffectFailure } from "../application/operation-effects";
import type { ProcessRunner } from "./io";
import type { IngestedProjectMedia, IngestProjectMediaOptions, ProbedMedia } from "./media-ingest-model";
import { MediaIngestPlatformLive } from "./media-ingest-platform";
import { ingestProjectMediaProgram, probeProjectMediaProgram } from "./media-ingest-program";

export {
  parseMediaProbe, SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
  type IngestedProjectMedia, type IngestProjectMediaOptions,
  type ProbedMedia, type ProbedMediaStream,
} from "./media-ingest-model";
export type { MediaIngestDurability } from "./media-ingest-platform";

/** Native composition beneath the application's existing operation owner. */
export function ingestProjectMediaEffect(options: IngestProjectMediaOptions): Effect.Effect<IngestedProjectMedia, OperationEffectFailure> {
  return ingestProjectMediaProgram(options).pipe(Effect.provide(MediaIngestPlatformLive(options.durability)));
}

export async function ingestProjectMedia(options: IngestProjectMediaOptions): Promise<IngestedProjectMedia> {
  return await runStandaloneOperation(ingestProjectMediaEffect(options));
}

export function probeProjectMediaEffect(ffprobe: string, runner: ProcessRunner, path: string): Effect.Effect<ProbedMedia, OperationEffectFailure> {
  return probeProjectMediaProgram(ffprobe, runner, path).pipe(Effect.provide(MediaIngestPlatformLive()));
}

export async function probeProjectMedia(ffprobe: string, runner: ProcessRunner, path: string): Promise<ProbedMedia> {
  return await runStandaloneOperation(probeProjectMediaEffect(ffprobe, runner, path));
}
