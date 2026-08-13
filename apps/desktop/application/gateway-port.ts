import { z } from "zod";

import {
  RepositoryRelativePathSchema,
  Sha256Schema,
} from "../contracts";
import {
  canonicalJson,
  sha256Hex,
} from "../core/canonical-json";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import type { OperationKind } from "./operation";

const GATEWAY_REQUEST_ID_DOMAIN = "studio.gateway-operation-request/v1";
const MAXIMUM_GATEWAY_OUTPUT_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_GATEWAY_OUTPUTS = 32;
const MAXIMUM_GATEWAY_RECEIPT_BYTES = 256 * 1024;
const MAXIMUM_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
const MAXIMUM_IMAGE_INPUT_TOTAL_BYTES = 200 * 1024 * 1024;
const MAXIMUM_REFERENCE_INPUT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_REFERENCE_INPUT_TOTAL_BYTES = 512 * 1024 * 1024;

const BoundedTextSchema = z.string().max(100_000).refine(
  value => [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined
      && codePoint !== 0
      && (
        codePoint >= 32
        || codePoint === 9
        || codePoint === 10
        || codePoint === 13
      );
  }),
  "Gateway text contains a disallowed control character.",
);

export const GatewayModelIdSchema = z.string()
  .min(3)
  .max(256)
  .regex(
    /^[^\s/]+(?:\/[^\s/]+)+$/u,
    "Gateway model IDs must be nonempty slash-separated identifiers.",
  );

export const GatewayMediaTypeSchema = z.string()
  .min(3)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u,
    "Expected a normalized media type.",
  );

export const GatewayProviderOptionsReferenceSchema = z.strictObject({
  namespaces: z.array(
    z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  ).max(64),
  sha256: Sha256Schema,
}).superRefine((reference, context) => {
  const canonical = [...new Set(reference.namespaces)].sort((left, right) =>
    left.localeCompare(right));
  if (
    canonical.length !== reference.namespaces.length
    || canonical.some((namespace, index) =>
      namespace !== reference.namespaces[index])
  ) {
    context.addIssue({
      code: "custom",
      message: "Provider-option namespaces must be unique and canonically sorted.",
    });
  }
});

export const GatewayMediaSourceReferenceSchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(512 * 1024 * 1024),
  facts: z.strictObject({
    durationSeconds: z.number().finite().positive().max(1_000_000_000).optional(),
    height: z.number().int().safe().positive().max(1_000_000).optional(),
    width: z.number().int().safe().positive().max(1_000_000).optional(),
  }).optional(),
  mediaType: GatewayMediaTypeSchema,
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
});

const GatewayCommonRequestFields = {
  model: GatewayModelIdSchema,
  providerOptions: GatewayProviderOptionsReferenceSchema.optional(),
  timeoutMs: z.number().int().safe().positive().max(30 * 60_000).optional(),
} as const;

export const GatewayImageOperationInputSchema = z.strictObject({
  ...GatewayCommonRequestFields,
  aspectRatio: z.string()
    .max(32)
    .regex(/^[1-9]\d{0,5}:[1-9]\d{0,5}$/u)
    .optional(),
  images: z.array(GatewayMediaSourceReferenceSchema).max(32).optional(),
  mask: GatewayMediaSourceReferenceSchema.optional(),
  maxImagesPerCall: z.number().int().safe().min(1).max(32).optional(),
  maxOutputTokens: z.number().int().safe().min(1).max(1_000_000).optional(),
  n: z.number().int().safe().min(1).max(32).optional(),
  prompt: BoundedTextSchema,
  seed: z.number().int().safe().min(0).max(0xffff_ffff).optional(),
  size: z.string()
    .max(32)
    .regex(/^[1-9]\d{0,5}x[1-9]\d{0,5}$/u)
    .optional(),
  stopSequences: z.array(z.string().min(1).max(1_024)).max(64).optional(),
  temperature: z.number().finite().min(0).max(100).optional(),
}).superRefine((input, context) => {
  const images = input.images ?? [];
  const totalBytes = images.reduce(
    (total, image) => total + image.bytes,
    input.mask?.bytes ?? 0,
  );
  if (totalBytes > MAXIMUM_IMAGE_INPUT_TOTAL_BYTES) {
    context.addIssue({
      code: "custom",
      message: "Gateway image inputs exceed the 200 MiB aggregate bound.",
    });
  }
  if (
    images.some(image => image.bytes > MAXIMUM_IMAGE_INPUT_BYTES)
    || (
      input.mask !== undefined
      && input.mask.bytes > MAXIMUM_IMAGE_INPUT_BYTES
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "An individual Gateway image input exceeds the 50 MiB bound.",
    });
  }
  if (images.some(image => !image.mediaType.startsWith("image/"))) {
    context.addIssue({
      code: "custom",
      message: "Gateway image references must use image media types.",
    });
  }
  if (
    input.mask !== undefined
    && !input.mask.mediaType.startsWith("image/")
  ) {
    context.addIssue({
      code: "custom",
      message: "Gateway image masks must use an image media type.",
    });
  }
  if (input.mask !== undefined && images.length === 0) {
    context.addIssue({
      code: "custom",
      message: "A Gateway image mask requires at least one source image.",
    });
  }
  if (input.size !== undefined && input.aspectRatio !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Gateway image size and aspect ratio are mutually exclusive.",
    });
  }
  if (
    (input.n ?? 1) > 1
    && (
      input.maxImagesPerCall === undefined
      || input.maxImagesPerCall < (input.n ?? 1)
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Multiple Gateway images require a matching per-call bound.",
    });
  }
  if (input.prompt.trim().length === 0 && images.length === 0) {
    context.addIssue({
      code: "custom",
      message: "A Gateway image request without source images requires a prompt.",
    });
  }
});

const GatewayVideoFrameSchema = z.strictObject({
  frameType: z.enum(["first_frame", "last_frame"]),
  source: GatewayMediaSourceReferenceSchema,
});

export const GatewayVideoOperationInputSchema = z.strictObject({
  ...GatewayCommonRequestFields,
  aspectRatio: z.string()
    .max(32)
    .regex(/^[1-9]\d{0,5}:[1-9]\d{0,5}$/u)
    .optional(),
  durationSeconds: z.number().finite().min(0.01).max(3_600).optional(),
  fps: z.number().finite().min(0.01).max(1_000).optional(),
  frames: z.array(GatewayVideoFrameSchema).max(32).optional(),
  generateAudio: z.boolean().optional(),
  maxVideosPerCall: z.number().int().safe().min(1).max(32).optional(),
  n: z.number().int().safe().min(1).max(32).optional(),
  prompt: BoundedTextSchema,
  promptImage: GatewayMediaSourceReferenceSchema.optional(),
  references: z.array(GatewayMediaSourceReferenceSchema).max(32).optional(),
  resolution: z.string()
    .max(32)
    .regex(/^(?:[1-9]\d{0,5}x[1-9]\d{0,5}|[1-9]\d{2,4}p|[1-9]\d{0,2}k)$/iu)
    .optional(),
  seed: z.number().int().safe().min(0).max(0xffff_ffff).optional(),
}).superRefine((input, context) => {
  const frames = input.frames ?? [];
  const references = input.references ?? [];
  if (references.reduce(
    (total, source) => total + source.bytes,
    0,
  ) > MAXIMUM_REFERENCE_INPUT_TOTAL_BYTES) {
    context.addIssue({
      code: "custom",
      message: "Gateway video inputs exceed the 512 MiB aggregate bound.",
    });
  }
  if (
    references.some(reference =>
      reference.bytes > MAXIMUM_REFERENCE_INPUT_BYTES)
  ) {
    context.addIssue({
      code: "custom",
      message: "A Gateway video reference exceeds the 256 MiB bound.",
    });
  }
  if (
    [
      ...(input.promptImage === undefined ? [] : [input.promptImage]),
      ...frames.map(frame => frame.source),
    ].some(source => source.bytes > MAXIMUM_IMAGE_INPUT_BYTES)
  ) {
    context.addIssue({
      code: "custom",
      message: "A Gateway video image input exceeds the 50 MiB bound.",
    });
  }
  if (
    frames.reduce((total, frame) => total + frame.source.bytes, 0)
    > MAXIMUM_IMAGE_INPUT_TOTAL_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "Gateway video frames exceed the 200 MiB aggregate bound.",
    });
  }
  if (
    input.promptImage !== undefined
    && !input.promptImage.mediaType.startsWith("image/")
  ) {
    context.addIssue({
      code: "custom",
      message: "A Gateway video prompt image must use an image media type.",
    });
  }
  if (frames.some(frame => !frame.source.mediaType.startsWith("image/"))) {
    context.addIssue({
      code: "custom",
      message: "Gateway video frames must use image media types.",
    });
  }
  if (new Set(frames.map(frame => frame.frameType)).size !== frames.length) {
    context.addIssue({
      code: "custom",
      message: "Gateway video frame roles must be unique.",
    });
  }
  if (
    references.some(reference => ![
      "audio/",
      "image/",
      "video/",
    ].some(prefix => reference.mediaType.startsWith(prefix)))
  ) {
    context.addIssue({
      code: "custom",
      message: "Gateway video references must be image, video, or audio media.",
    });
  }
  if (frames.length > 0 && references.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Gateway video frames and references are mutually exclusive.",
    });
  }
  if (
    input.promptImage !== undefined
    && frames.some(frame => frame.frameType === "first_frame")
  ) {
    context.addIssue({
      code: "custom",
      message: "A Gateway video prompt image conflicts with a first frame.",
    });
  }
  if (
    frames.some(frame => frame.frameType === "last_frame")
    && input.promptImage === undefined
    && !frames.some(frame => frame.frameType === "first_frame")
  ) {
    context.addIssue({
      code: "custom",
      message: "A Gateway video last frame requires a first image.",
    });
  }
  if (
    (input.n ?? 1) > 1
    && (
      input.maxVideosPerCall === undefined
      || input.maxVideosPerCall < (input.n ?? 1)
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Multiple Gateway videos require a matching per-call bound.",
    });
  }
  if (
    input.prompt.trim().length === 0
    && input.promptImage === undefined
    && frames.length === 0
    && references.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "A Gateway video request without media inputs requires a prompt.",
    });
  }
});

export const GatewaySpeechOperationInputSchema = z.strictObject({
  ...GatewayCommonRequestFields,
  instructions: BoundedTextSchema.optional(),
  language: z.string().min(1).max(64).optional(),
  outputFormat: z.string()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._+-]*$/iu)
    .optional(),
  speed: z.number().finite().min(0.01).max(100).optional(),
  text: BoundedTextSchema.min(1),
  voice: z.string().min(1).max(256).optional(),
});

export const GatewayTranscriptionOperationInputSchema = z.strictObject({
  ...GatewayCommonRequestFields,
  audio: GatewayMediaSourceReferenceSchema,
}).superRefine((input, context) => {
  if (!input.audio.mediaType.startsWith("audio/")) {
    context.addIssue({
      code: "custom",
      message: "Gateway transcription input must use an audio media type.",
    });
  }
  if (input.audio.bytes > 256 * 1024 * 1024) {
    context.addIssue({
      code: "custom",
      message: "Gateway transcription input exceeds the 256 MiB bound.",
    });
  }
});

export const GatewayOperationNameSchema = z.enum([
  "image",
  "video",
  "speech",
  "transcription",
]);

export const GatewayPortRequestSchema = z.union([
  z.strictObject({
    operation: z.literal("image"),
    request: GatewayImageOperationInputSchema,
  }),
  z.strictObject({
    operation: z.literal("video"),
    request: GatewayVideoOperationInputSchema,
  }),
  z.strictObject({
    operation: z.literal("speech"),
    request: GatewaySpeechOperationInputSchema,
  }),
  z.strictObject({
    operation: z.literal("transcription"),
    request: GatewayTranscriptionOperationInputSchema,
  }),
]);

export const GatewayRequestIdSchema = z.string()
  .regex(/^gateway_[a-f0-9]{64}$/u);

export const GatewayOutputArtifactReferenceSchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(512 * 1024 * 1024),
  mediaType: GatewayMediaTypeSchema,
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
});

export const GatewayReceiptReferenceSchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(MAXIMUM_GATEWAY_RECEIPT_BYTES),
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
});

const GatewayOperationResultBaseFields = {
  model: GatewayModelIdSchema,
  outputs: z.array(GatewayOutputArtifactReferenceSchema)
    .min(1)
    .max(MAXIMUM_GATEWAY_OUTPUTS),
  receipt: GatewayReceiptReferenceSchema,
  requestId: GatewayRequestIdSchema,
} as const;

export const GatewayImageOperationResultSchema = z.strictObject({
  ...GatewayOperationResultBaseFields,
  operation: z.literal("image"),
});

export const GatewayVideoOperationResultSchema = z.strictObject({
  ...GatewayOperationResultBaseFields,
  operation: z.literal("video"),
});

export const GatewaySpeechOperationResultSchema = z.strictObject({
  ...GatewayOperationResultBaseFields,
  operation: z.literal("speech"),
});

export const GatewayTranscriptionOperationResultSchema = z.strictObject({
  ...GatewayOperationResultBaseFields,
  operation: z.literal("transcription"),
  transcript: z.strictObject({
    characters: z.number().int().safe().nonnegative().max(10_000_000),
    durationSeconds: z.number().finite().nonnegative().max(7 * 24 * 60 * 60),
    language: z.string().min(1).max(64).optional(),
    segments: z.number().int().safe().nonnegative().max(100_000),
    textSha256: Sha256Schema,
  }),
});

export const GatewayOperationResultSchema = z.union([
  GatewayImageOperationResultSchema,
  GatewayVideoOperationResultSchema,
  GatewaySpeechOperationResultSchema,
  GatewayTranscriptionOperationResultSchema,
]).superRefine((result, context) => {
  if (
    result.outputs.reduce((total, output) => total + output.bytes, 0)
    > MAXIMUM_GATEWAY_OUTPUT_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "Gateway outputs exceed the 1 GiB aggregate bound.",
    });
  }
  const identities = result.outputs.map(output => output.sha256);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: "custom",
      message: "Gateway output content identities must be unique.",
    });
  }
  const wrongMediaType = result.operation === "image"
    ? result.outputs.some(output => !output.mediaType.startsWith("image/"))
    : result.operation === "video"
      ? result.outputs.some(output => !output.mediaType.startsWith("video/"))
      : result.operation === "speech"
        ? result.outputs.some(output => !output.mediaType.startsWith("audio/"))
        : result.outputs.some(output => ![
            "application/json",
            "application/x-subrip",
            "text/plain",
            "text/vtt",
          ].includes(output.mediaType));
  if (wrongMediaType) {
    context.addIssue({
      code: "custom",
      message: `Gateway ${result.operation} output has the wrong media type.`,
    });
  }
});

export type GatewayImageOperationInput =
  z.infer<typeof GatewayImageOperationInputSchema>;
export type GatewayMediaSourceReference =
  z.infer<typeof GatewayMediaSourceReferenceSchema>;
export type GatewayVideoOperationInput =
  z.infer<typeof GatewayVideoOperationInputSchema>;
export type GatewaySpeechOperationInput =
  z.infer<typeof GatewaySpeechOperationInputSchema>;
export type GatewayTranscriptionOperationInput =
  z.infer<typeof GatewayTranscriptionOperationInputSchema>;
export type GatewayPortRequest = z.infer<typeof GatewayPortRequestSchema>;
export type GatewayOperationResult = z.infer<
  typeof GatewayOperationResultSchema
>;
export type GatewayImageOperationResult =
  z.infer<typeof GatewayImageOperationResultSchema>;
export type GatewayVideoOperationResult =
  z.infer<typeof GatewayVideoOperationResultSchema>;
export type GatewaySpeechOperationResult =
  z.infer<typeof GatewaySpeechOperationResultSchema>;
export type GatewayTranscriptionOperationResult =
  z.infer<typeof GatewayTranscriptionOperationResultSchema>;
export type GatewayOperationName = GatewayPortRequest["operation"];

export const GatewayPortReconciliationSchema = z.union([
  z.strictObject({
    operation: GatewayOperationNameSchema,
    requestId: GatewayRequestIdSchema,
    result: GatewayOperationResultSchema,
    status: z.literal("completed"),
  }),
  z.strictObject({
    operation: GatewayOperationNameSchema,
    requestId: GatewayRequestIdSchema,
    status: z.literal("not-dispatched"),
  }),
  z.strictObject({
    operation: GatewayOperationNameSchema,
    requestId: GatewayRequestIdSchema,
    status: z.literal("dispatched"),
  }),
  z.strictObject({
    failureReceipt: GatewayReceiptReferenceSchema,
    operation: GatewayOperationNameSchema,
    requestId: GatewayRequestIdSchema,
    status: z.literal("failed"),
  }),
  z.strictObject({
    operation: GatewayOperationNameSchema,
    reasonSha256: Sha256Schema,
    requestId: GatewayRequestIdSchema,
    status: z.literal("conflict"),
  }),
]);

export type GatewayPortReconciliation = z.infer<
  typeof GatewayPortReconciliationSchema
>;

export interface GatewayPortDispatch {
  /**
   * Revalidates the workflow fence immediately before generated artifacts are
   * atomically published. The host service must invoke this at its final safe
   * publication boundary.
   */
  readonly beforePublication: () => Promise<void>;
  /**
   * Callback-scoped machine admission held by the active operation. This is
   * host authority, never part of the persisted or hashed Gateway request.
   */
  readonly hostResourceLease?: ApplicationContext["hostResourceLease"];
  /**
   * The host must durably claim this key before crossing the paid-dispatch
   * boundary. Repeating it may return a completed receipt but must never cause
   * another provider call.
   */
  readonly requestId: string;
  readonly request: GatewayPortRequest;
  readonly signal: AbortSignal;
}

export interface GatewayPortPrepare {
  readonly hostResourceLease?: ApplicationContext["hostResourceLease"];
  readonly request: GatewayPortRequest;
  readonly signal: AbortSignal;
}

export interface GatewayPortReconcile {
  /**
   * The host compares this complete authority-free request with the durable
   * dispatch-intent digest. A matching request ID alone is insufficient.
   */
  readonly request: GatewayPortRequest;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

/**
 * Host-owned paid-media boundary.
 *
 * Credentials, cloud consent, and raw provider options remain encapsulated by
 * this port. Only their separately prepared, secret-free integrity summary is
 * present in a request. Implementations must durably distinguish
 * `not-dispatched` from `dispatched`; absence of a result alone is not proof
 * that retrying a paid call is safe.
 */
export interface ApplicationGatewayPort {
  dispatch(input: GatewayPortDispatch): Promise<unknown>;
  prepare(input: GatewayPortPrepare): Promise<unknown>;
  reconcile(input: GatewayPortReconcile): Promise<unknown>;
}

export interface GatewayRequestIdentity {
  readonly nodeKey: string;
  readonly nodePlanSha256: string;
  readonly operation: GatewayOperationName;
  readonly runId: string;
}

export function gatewayRequestId(
  identity: GatewayRequestIdentity,
): string {
  if (
    identity.runId.length < 1
    || identity.runId.length > 256
    || identity.nodeKey.length < 1
    || identity.nodeKey.length > 256
    || identity.runId.includes("\0")
    || identity.nodeKey.includes("\0")
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Gateway request identity is outside its bounded envelope.",
    );
  }
  const nodePlanSha256 = Sha256Schema.parse(identity.nodePlanSha256);
  return GatewayRequestIdSchema.parse(
    `gateway_${sha256Hex(
      `${GATEWAY_REQUEST_ID_DOMAIN}\0${canonicalJson({
        nodeKey: identity.nodeKey,
        nodePlanSha256,
        operation: identity.operation,
        runId: identity.runId,
      })}`,
    )}`,
  );
}

type GatewayOperationKind = Extract<OperationKind, `gateway.${string}`>;

export function gatewayPortRequestForOperation(
  kind: GatewayOperationKind,
  input: unknown,
): GatewayPortRequest {
  switch (kind) {
    case "gateway.image":
      return GatewayPortRequestSchema.parse({
        operation: "image",
        request: GatewayImageOperationInputSchema.parse(input),
      });
    case "gateway.video":
      return GatewayPortRequestSchema.parse({
        operation: "video",
        request: GatewayVideoOperationInputSchema.parse(input),
      });
    case "gateway.speech":
      return GatewayPortRequestSchema.parse({
        operation: "speech",
        request: GatewaySpeechOperationInputSchema.parse(input),
      });
    case "gateway.transcription":
      return GatewayPortRequestSchema.parse({
        operation: "transcription",
        request: GatewayTranscriptionOperationInputSchema.parse(input),
      });
  }
}

function withoutSourceFacts(
  source: z.infer<typeof GatewayMediaSourceReferenceSchema>,
) {
  return {
    bytes: source.bytes,
    mediaType: source.mediaType,
    path: source.path,
    sha256: source.sha256,
  };
}

function gatewayRequestAuthority(request: GatewayPortRequest): unknown {
  switch (request.operation) {
    case "image":
      return {
        ...request,
        request: {
          ...request.request,
          ...(request.request.images === undefined
            ? {}
            : {
                images: request.request.images.map(withoutSourceFacts),
              }),
          ...(request.request.mask === undefined
            ? {}
            : { mask: withoutSourceFacts(request.request.mask) }),
        },
      };
    case "video":
      return {
        ...request,
        request: {
          ...request.request,
          ...(request.request.frames === undefined
            ? {}
            : {
                frames: request.request.frames.map(frame => ({
                  ...frame,
                  source: withoutSourceFacts(frame.source),
                })),
              }),
          ...(request.request.promptImage === undefined
            ? {}
            : {
                promptImage: withoutSourceFacts(
                  request.request.promptImage,
                ),
              }),
          ...(request.request.references === undefined
            ? {}
            : {
                references:
                  request.request.references.map(withoutSourceFacts),
              }),
        },
      };
    case "speech":
      return request;
    case "transcription":
      return {
        ...request,
        request: {
          ...request.request,
          audio: withoutSourceFacts(request.request.audio),
        },
      };
  }
}

function requireGatewayPort(
  application: ApplicationContext,
): ApplicationGatewayPort {
  if (application.gatewayPort === undefined) {
    throw new ApplicationError(
      "unavailable",
      "The host Gateway media port is unavailable.",
    );
  }
  return application.gatewayPort;
}

export async function prepareGatewayOperation(
  application: ApplicationContext,
  input: GatewayPortPrepare,
): Promise<GatewayPortRequest> {
  const request = GatewayPortRequestSchema.parse(input.request);
  const prepared = GatewayPortRequestSchema.parse(
    await requireGatewayPort(application).prepare({
      ...(application.hostResourceLease === undefined
        ? {}
        : { hostResourceLease: application.hostResourceLease }),
      request,
      signal: input.signal,
    }),
  );
  if (
    canonicalJson(gatewayRequestAuthority(prepared))
    !== canonicalJson(gatewayRequestAuthority(request))
  ) {
    throw new ApplicationError(
      "conflict",
      "Gateway preparation changed request authority instead of deriving media facts.",
      { operation: request.operation },
    );
  }
  return prepared;
}

function assertReconciliationIdentity(
  reconciliation: GatewayPortReconciliation,
  request: GatewayPortRequest,
  requestId: string,
): void {
  if (
    reconciliation.operation !== request.operation
    || reconciliation.requestId !== requestId
    || (
      reconciliation.status === "completed"
      && (
        reconciliation.result.operation !== request.operation
        || reconciliation.result.requestId !== requestId
        || reconciliation.result.model !== request.request.model
      )
    )
  ) {
    throw new ApplicationError(
      "conflict",
      "Gateway reconciliation did not match the exact paid request.",
      { operation: request.operation, requestId },
    );
  }
}

export async function reconcileGatewayOperation(
  application: ApplicationContext,
  input: GatewayPortReconcile,
): Promise<GatewayPortReconciliation> {
  const request = GatewayPortRequestSchema.parse(input.request);
  const requestId = GatewayRequestIdSchema.parse(input.requestId);
  const reconciliation = GatewayPortReconciliationSchema.parse(
    await requireGatewayPort(application).reconcile({
      request,
      requestId,
      signal: input.signal,
    }),
  );
  assertReconciliationIdentity(reconciliation, request, requestId);
  return reconciliation;
}

export async function dispatchGatewayOperation(
  application: ApplicationContext,
  input: GatewayPortDispatch,
): Promise<GatewayOperationResult> {
  const request = GatewayPortRequestSchema.parse(input.request);
  const requestId = GatewayRequestIdSchema.parse(input.requestId);
  const result = GatewayOperationResultSchema.parse(
    await requireGatewayPort(application).dispatch({
      beforePublication: input.beforePublication,
      ...(application.hostResourceLease === undefined
        ? {}
        : { hostResourceLease: application.hostResourceLease }),
      request,
      requestId,
      signal: input.signal,
    }),
  );
  if (
    result.requestId !== requestId
    || result.operation !== request.operation
    || result.model !== request.request.model
  ) {
    throw new ApplicationError(
      "conflict",
      "Gateway dispatch result did not match the exact paid request.",
      {
        operation: request.operation,
        requestId,
      },
    );
  }
  return result;
}
