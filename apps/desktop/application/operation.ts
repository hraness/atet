import type { z } from "zod";

import type { ApplicationContext } from "./context";

export const OPERATION_KINDS = [
  "project.snapshot",
  "analysis.project-inactivity",
  "analysis.faces",
  "analysis.music",
  "analysis.scenes",
  "analysis.project-auto-zooms",
  "derive.edit-batch",
  "project.commit-edits",
  "derive.follow-faces",
  "edit.create-revision",
  "edit.create-candidate-revision",
  "edit.bind-candidate-revision",
  "edit.freeze-revision",
  "iteration.create-candidate",
  "iteration.create-matrix",
  "iteration.select",
  "project.promote-selection",
  "render.bind-candidate-output",
  "render.project-plan",
  "render.project",
  "render.materialize-selection",
  "media.ingest",
  "media.overlay",
  "media.html-overlay",
  "media.audio-effects",
  "media.color-grade",
  "gateway.image",
  "gateway.video",
  "gateway.speech",
  "gateway.transcription",
  "recording.start",
  "recording.pause",
  "recording.resume",
  "recording.stop",
  "atet.diagram.check",
  "atet.diagram.render",
  "atet.image.vectorize",
  "atet.image.generate",
] as const;

export type OperationKind = typeof OPERATION_KINDS[number];

export const RESOURCE_KINDS = [
  "cpu",
  "local-io",
  "ffmpeg",
  "vision",
  "whisper",
  "network",
  "paid-call",
  "project-render",
  "project-publication",
  "output-publication",
  "capture-device",
  "browser",
] as const;

export type OperationResourceKind = typeof RESOURCE_KINDS[number];

export type OperationEffectClass =
  | "pure"
  | "local-read"
  | "local-derived-write"
  | "project-mutation"
  | "paid-cloud"
  | "live-control";

export type OperationResumeClass =
  | "deterministic"
  | "verified-receipt"
  | "recoverable-transaction"
  | "ambiguous-after-dispatch"
  | "non-resumable-live";

export interface OperationResourceClaim {
  readonly amount: number;
  readonly resource: OperationResourceKind;
}

export interface OperationPolicy {
  readonly cache: "none" | "exact-run" | "content-addressed";
  readonly cancellable: boolean;
  readonly effect: OperationEffectClass;
  readonly maxDurationMs: number;
  readonly maxFanOut: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly preparation: readonly (
    | "project-state"
    | "recording-metadata"
    | "screen-capture"
    | "camera"
    | "microphone"
    | "system-audio"
    | "typed-text"
    | "window-metadata"
    | "local-media"
    | "provider-options"
  )[];
  readonly resources: readonly OperationResourceClaim[];
  readonly resume: OperationResumeClass;
}

export interface BoundedOperationSummary {
  readonly fields: Readonly<Record<string, boolean | null | number | string>>;
  readonly kind: OperationKind;
}

export interface OperationExecutionContext {
  readonly abortSignal: AbortSignal;
  readonly application: ApplicationContext;
  readonly expectedProjectGeneration?: string;
  readonly runFence?: {
    readonly generation: number;
    readonly owner: string;
    readonly token: string;
  };
  /**
   * Ephemeral runner-owned state. It is never accepted from graph input or
   * persisted as operation authority.
   */
  readonly workflow?: {
    /**
     * Revalidates the physical run fence and durable cancellation marker at
     * the last safe point before an operation publishes external bytes.
     */
    beforePublication(): Promise<void>;
    readonly nodeKey: string;
    readonly nodePlanSha256: string;
    readonly runId: string;
    /** Private, deterministic, exact-run/node-plan staging directory. */
    readonly workspaceDirectory: string;
  };
}

interface LifecycleBase<Input, Output> {
  execute(context: OperationExecutionContext, input: Input): Promise<Output>;
}

export interface PureLifecycle<Input, Output> extends LifecycleBase<Input, Output> {
  readonly kind: "pure";
}

export interface LocalArtifactLifecycle<Input, Output> extends LifecycleBase<Input, Output> {
  readonly kind: "local-artifact";
}

export interface ProjectTransactionLifecycle<Input, Output> extends LifecycleBase<Input, Output> {
  readonly kind: "project-transaction";
}

export interface PaidDispatchLifecycle<Input, Output> extends LifecycleBase<Input, Output> {
  readonly kind: "paid-dispatch";
}

export interface LiveControlLifecycle<Input, Output> extends LifecycleBase<Input, Output> {
  readonly kind: "live-control";
}

export type OperationLifecycle<Input, Output> =
  | PureLifecycle<Input, Output>
  | LocalArtifactLifecycle<Input, Output>
  | ProjectTransactionLifecycle<Input, Output>
  | PaidDispatchLifecycle<Input, Output>
  | LiveControlLifecycle<Input, Output>;

export interface OperationDefinition<
  Kind extends OperationKind = OperationKind,
  Input = unknown,
  Output = unknown,
> {
  readonly inputSchema: z.ZodType<Input>;
  readonly inputSchemaId: string;
  readonly kind: Kind;
  readonly lifecycle: OperationLifecycle<Input, Output>;
  readonly outputSchema: z.ZodType<Output>;
  readonly outputSchemaId: string;
  readonly policy: OperationPolicy;
  /**
   * Selects the operation-owned authoritative receipt after output parsing.
   * The scheduler records this reference; it does not replace the receipt.
   */
  readonly receiptReference?: (output: Output) => string | undefined;
  summarize(output: Output): BoundedOperationSummary;
  readonly version: number;
}

export interface OperationRequest {
  readonly input: unknown;
  readonly kind: OperationKind;
  readonly version: number;
}

export interface OperationResult {
  readonly kind: OperationKind;
  readonly output: unknown;
  readonly receiptReference?: string;
  readonly summary: BoundedOperationSummary;
  readonly version: number;
}
