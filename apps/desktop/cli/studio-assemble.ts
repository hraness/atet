import { join } from "node:path";
import { z } from "zod";
import { boundedCanonicalJsonSha256 } from "../../../src/code/canonical-json";
import { parseStudioPlan, validateStudioReceipt } from "../../../src/studio";
import { GatewayMediaSourceReferenceSchema, type GatewayMediaSourceReference } from "../application/gateway-port";
import { createNodeBundleFileSystem } from "../core/storage";
import { assembleDirectingClips, inspectDirectingClipDuration, type DirectingAssemblyResult } from "./directing-media";
import { CliError } from "./errors";
import { encodeStudioSequence, type StudioEncodeInput } from "./studio-encode";
import { studioJson } from "./studio-files";
import { studioStorageRoot } from "./studio-service";

export interface StudioAssemblyInput extends StudioEncodeInput { readonly title?: string; }
export interface StudioAssemblyResult extends DirectingAssemblyResult {
  readonly kind: "slopcamera.studio-assembly"; readonly schemaVersion: 1;
  readonly jobId: string; readonly outputId: string;
  readonly clip: GatewayMediaSourceReference;
  readonly encoded: Awaited<ReturnType<typeof encodeStudioSequence>>;
}

/** Native source stays authoritative; the delivery derivative enters the existing V1 project. */
export async function assembleStudioJob(input: StudioAssemblyInput): Promise<StudioAssemblyResult> {
  if (!/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u.test(input.jobId)) throw new CliError("invalid-data", "Invalid studio job ID.");
  const title = z.string().trim().min(1).max(512).parse(input.title ?? `Studio ${input.jobId}`);
  const fence = async () => {
    if (input.signal.aborted) throw new CliError("cancelled", "Studio assembly was cancelled.");
    await input.application.hostResourceLease?.assertOwned();
    await input.beforePublication();
    if (input.signal.aborted) throw new CliError("cancelled", "Studio assembly was cancelled.");
  };
  await fence();
  const native = await input.service.inspect(input.jobId);
  const fs = createNodeBundleFileSystem(join(await studioStorageRoot(input.application), "jobs", input.jobId));
  const plan = parseStudioPlan(JSON.parse(await fs.readText("plan.json", 32 * 1024 * 1024)) as unknown);
  const receipt = validateStudioReceipt({ plan, receipt: native.document });
  if (receipt.state !== "succeeded" || receipt.jobId !== input.jobId) throw new CliError("invalid-data", "Studio assembly requires a successful retained job.");
  const output = plan.job.outputs.find(item => item.id === input.outputId), render = plan.job.render;
  if (output?.kind !== "sequence" || output.format !== "png" || output.interpretation.kind !== "raster" || output.interpretation.semantic !== "color"
    || output.interpretation.colorSpace !== "srgb" || output.interpretation.alpha !== "opaque" || render === undefined) throw new CliError("unsupported-plan", "Studio assemble currently accepts opaque sRGB PNG sequences. Encode straight-alpha sequences separately for overlay composition.");
  const count = render.endFrameExclusive - render.startFrame;
  const durationNumerator = BigInt(count) * BigInt(render.frameRate.denominator) * 1_000_000n;
  const durationUs = Number((durationNumerator + BigInt(render.frameRate.numerator) / 2n) / BigInt(render.frameRate.numerator));
  // This is the existing media assembler's bounded profile, checked before encoding.
  if (render.width > 4096 || render.height > 4096 || count > 4000 || durationUs > 60_000_000 || durationUs < 1) throw new CliError("unsupported-plan", "Studio assembly currently supports at most 4096 pixels per side, 4000 frames, and 60 seconds per clip.");
  const encoded = await encodeStudioSequence(input);
  if (encoded.document.request.planSha256 !== plan.planSha256 || studioJson(encoded.document.request.nativeReceipt) !== studioJson(native.receipt)) throw new CliError("conflict", "Studio source changed between assembly planning and encoding.");
  const lease = input.application.hostResourceLease!;
  const application = { ...input.application, hostResourceLease: { ...lease, assertOwned: fence } };
  const source = GatewayMediaSourceReferenceSchema.parse({ ...encoded.artifact, mediaType: "video/mp4" });
  const measuredDurationUs = await inspectDirectingClipDuration(application, source, input.signal);
  const clip = GatewayMediaSourceReferenceSchema.parse({ ...source, facts: { width: render.width, height: render.height, durationSeconds: measuredDurationUs / 1_000_000 } });
  const recipeSha256 = boundedCanonicalJsonSha256({ kind: "slopcamera.studio-assembly-selection", schemaVersion: 1, title, jobId: input.jobId, outputId: input.outputId, planSha256: plan.planSha256, nativeReceipt: native.receipt, encodeReceipt: encoded.receipt, clip }, { maximumBytes: 1_048_576 });
  await fence();
  const assembled = await assembleDirectingClips(application, { id: `studio_${recipeSha256.slice(0, 40)}`, title, recipeSha256,
    clips: [{ shotId: input.outputId, attemptId: input.jobId, source: clip, durationUs: measuredDurationUs }] }, input.signal);
  await fence();
  return { kind: "slopcamera.studio-assembly", schemaVersion: 1, jobId: input.jobId, outputId: input.outputId, clip, encoded, ...assembled };
}
