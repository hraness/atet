import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import type { ApplicationContext } from "../application/context";
import { ApplicationError } from "../application/errors";
import {
  GatewayMediaSourceReferenceSchema,
  GatewayOperationNameSchema,
  GatewayOperationResultSchema,
  GatewayPortRequestSchema,
  GatewayRequestIdSchema,
  type ApplicationGatewayPort,
  type GatewayMediaSourceReference,
  type GatewayOperationResult,
  type GatewayPortDispatch,
  type GatewayPortPrepare,
  type GatewayPortReconcile,
  type GatewayPortRequest,
} from "../application/gateway-port";
import {
  bindRepositoryMedia,
  loadRepositoryMedia,
} from "../application/operations";
import {
  RepositoryRelativePathSchema,
  Sha256Schema,
} from "../contracts";
import {
  canonicalJson,
  sha256Hex,
} from "../core/canonical-json";
import { createNodeBundleFileSystem } from "../core/storage";
import type { GatewayMediaArtifactBundle } from "./gateway-media-artifacts";
import type {
  GatewayMediaDispatchEvent,
  GatewayMediaInput,
  GatewayMediaService,
} from "./gateway-media-service";
import { GATEWAY_MEDIA_UPLOAD_POLICY } from "./gateway-media-service";
import { gatewayMediaBytesMatchType } from "./gateway-media-signature";
import {
  gatewayProviderOptionsSummary,
  type GatewayProviderOptions,
} from "./gateway-provider-options";
import { withMutationLock } from "./mutation-lock";
import {
  ensurePhysicalPrivateDirectoryWithin,
  ensurePrivateDirectory,
} from "./paths";

const GATEWAY_REQUEST_DIGEST_DOMAIN =
  "studio.gateway-application-request/v1";
const GATEWAY_FAILURE_DIGEST_DOMAIN =
  "studio.gateway-application-failure/v1";
const GATEWAY_CONFLICT_DIGEST_DOMAIN =
  "studio.gateway-application-conflict/v1";
const GATEWAY_JOURNAL_FILE = "request.json";
const MAXIMUM_GATEWAY_SOURCE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_GATEWAY_RECEIPT_BYTES = 256 * 1024;

const GatewayJournalSchema = z.strictObject({
  chargeMayHaveOccurred: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  failureSha256: Sha256Schema.optional(),
  kind: z.union([
    z.literal("atet.gateway-workflow-request"),
    z.literal("studio.gateway-workflow-request"),
  ]),
  model: z.string().min(3).max(256),
  operation: GatewayOperationNameSchema,
  requestId: GatewayRequestIdSchema,
  requestSha256: Sha256Schema,
  result: GatewayOperationResultSchema.optional(),
  schemaVersion: z.literal(1),
  state: z.enum(["prepared", "dispatched", "completed"]),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine((journal, context) => {
  if (
    (journal.state === "completed") !== (journal.result !== undefined)
    || journal.chargeMayHaveOccurred === (journal.state === "prepared")
    || (
      journal.result !== undefined
      && (
        journal.result.operation !== journal.operation
        || journal.result.model !== journal.model
        || journal.result.requestId !== journal.requestId
      )
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Gateway workflow journal state is inconsistent.",
    });
  }
});

type GatewayJournal = z.infer<typeof GatewayJournalSchema>;

export interface GatewayApplicationMediaFacts {
  readonly durationSeconds?: number;
  readonly height?: number;
  readonly width?: number;
}

export interface GatewayApplicationMediaInspectionInput {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
}

export type GatewayApplicationMediaInspector = (
  inputs: readonly GatewayApplicationMediaInspectionInput[],
  signal: AbortSignal,
  hostResourceLease: ApplicationContext["hostResourceLease"],
) => Promise<readonly GatewayApplicationMediaFacts[]>;

export type GatewayApplicationProviderOptionsResolver = (
  reference: Readonly<{
    readonly namespaces: readonly string[];
    readonly sha256: string;
  }>,
  signal: AbortSignal,
) => Promise<GatewayProviderOptions | undefined>;

export interface GatewayApplicationServiceCallbacks {
  readonly beforePublication: () => Promise<void>;
  readonly onDispatch: (event: GatewayMediaDispatchEvent) => Promise<void>;
}

export type GatewayApplicationServiceFactory = (
  callbacks: GatewayApplicationServiceCallbacks,
  hostResourceLease: ApplicationContext["hostResourceLease"],
) => Promise<GatewayMediaService>;

export interface CreateGatewayApplicationPortOptions {
  readonly application: ApplicationContext;
  readonly createService: GatewayApplicationServiceFactory;
  readonly inspectMedia: GatewayApplicationMediaInspector;
  readonly now?: () => Date;
  readonly resolveProviderOptions?: GatewayApplicationProviderOptionsResolver;
}

interface LoadedGatewaySource {
  readonly data: Uint8Array;
  readonly source: GatewayMediaSourceReference;
}

interface PreparedGatewayRequest {
  readonly loaded: readonly LoadedGatewaySource[];
  readonly request: GatewayPortRequest;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ApplicationError("cancelled", "Gateway operation was cancelled.");
  }
}

function noEntry(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

function requestSha256(request: GatewayPortRequest): string {
  return sha256Hex(
    `${GATEWAY_REQUEST_DIGEST_DOMAIN}\0${canonicalJson(request)}`,
  );
}

function failureSha256(error: unknown): string {
  const source = error instanceof Error
    ? `${error.name}\0${error.message}`
    : typeof error;
  return sha256Hex(`${GATEWAY_FAILURE_DIGEST_DOMAIN}\0${source}`);
}

function conflictSha256(reason: string): string {
  return sha256Hex(`${GATEWAY_CONFLICT_DIGEST_DOMAIN}\0${reason}`);
}

function journalMatches(
  journal: GatewayJournal,
  request: GatewayPortRequest,
  requestId: string,
  digest: string,
): boolean {
  return journal.requestId === requestId
    && journal.requestSha256 === digest
    && journal.operation === request.operation
    && journal.model === request.request.model;
}

async function gatewayRequestDirectory(
  application: ApplicationContext,
  requestId: string,
): Promise<string> {
  await ensurePrivateDirectory(application.paths.privateRoot);
  const root = await ensurePhysicalPrivateDirectoryWithin(
    application.paths.privateRoot,
    "gateway-workflow-requests",
  );
  return await ensurePhysicalPrivateDirectoryWithin(root, requestId);
}

async function readJournal(
  directory: string,
): Promise<GatewayJournal | null> {
  const fileSystem = createNodeBundleFileSystem(directory);
  let source: string;
  try {
    source = await fileSystem.readText(GATEWAY_JOURNAL_FILE);
  } catch (error) {
    if (noEntry(error)) return null;
    throw error;
  }
  try {
    return GatewayJournalSchema.parse(JSON.parse(source) as unknown);
  } catch {
    throw new ApplicationError(
      "conflict",
      "The durable Gateway request journal is invalid.",
    );
  }
}

async function writeJournal(
  directory: string,
  journal: GatewayJournal,
): Promise<GatewayJournal> {
  const parsed = GatewayJournalSchema.parse(journal);
  await createNodeBundleFileSystem(directory).writeTextAtomic(
    GATEWAY_JOURNAL_FILE,
    `${canonicalJson(parsed)}\n`,
  );
  return parsed;
}

function journalIdentity(
  journal: GatewayJournal,
): Omit<
  GatewayJournal,
  | "chargeMayHaveOccurred"
  | "failureSha256"
  | "result"
  | "state"
  | "updatedAt"
> {
  return {
    createdAt: journal.createdAt,
    kind: journal.kind,
    model: journal.model,
    operation: journal.operation,
    requestId: journal.requestId,
    requestSha256: journal.requestSha256,
    schemaVersion: journal.schemaVersion,
  };
}

function gatewaySources(
  request: GatewayPortRequest,
): readonly GatewayMediaSourceReference[] {
  switch (request.operation) {
    case "image":
      return [
        ...(request.request.images ?? []),
        ...(request.request.mask === undefined ? [] : [request.request.mask]),
      ];
    case "video":
      return [
        ...(request.request.promptImage === undefined
          ? []
          : [request.request.promptImage]),
        ...(request.request.frames ?? []).map(frame => frame.source),
        ...(request.request.references ?? []),
      ];
    case "speech":
      return [];
    case "transcription":
      return [request.request.audio];
  }
}

function replaceGatewaySources(
  request: GatewayPortRequest,
  sources: readonly GatewayMediaSourceReference[],
): GatewayPortRequest {
  let index = 0;
  const next = (): GatewayMediaSourceReference => {
    const source = sources[index];
    index += 1;
    if (source === undefined) {
      throw new ApplicationError(
        "internal",
        "Gateway preparation lost a media source.",
      );
    }
    return source;
  };
  let replaced: GatewayPortRequest;
  switch (request.operation) {
    case "image":
      replaced = GatewayPortRequestSchema.parse({
        operation: request.operation,
        request: {
          ...request.request,
          ...(request.request.images === undefined
            ? {}
            : { images: request.request.images.map(next) }),
          ...(request.request.mask === undefined ? {} : { mask: next() }),
        },
      });
      break;
    case "video":
      replaced = GatewayPortRequestSchema.parse({
        operation: request.operation,
        request: {
          ...request.request,
          ...(request.request.promptImage === undefined
            ? {}
            : { promptImage: next() }),
          ...(request.request.frames === undefined
            ? {}
            : {
                frames: request.request.frames.map(frame => ({
                  ...frame,
                  source: next(),
                })),
              }),
          ...(request.request.references === undefined
            ? {}
            : { references: request.request.references.map(next) }),
        },
      });
      break;
    case "speech":
      replaced = request;
      break;
    case "transcription":
      replaced = GatewayPortRequestSchema.parse({
        operation: request.operation,
        request: {
          ...request.request,
          audio: next(),
        },
      });
      break;
  }
  if (index !== sources.length) {
    throw new ApplicationError(
      "internal",
      "Gateway preparation returned an inconsistent media-source count.",
    );
  }
  return replaced;
}

async function readBoundSource(
  application: ApplicationContext,
  source: GatewayMediaSourceReference,
  signal: AbortSignal,
  requireMediaSignature = true,
): Promise<LoadedGatewaySource> {
  const loaded = await loadRepositoryMedia(
    application,
    {
      bytes: source.bytes,
      path: source.path,
      sha256: source.sha256,
    },
    signal,
    MAXIMUM_GATEWAY_SOURCE_BYTES,
  );
  throwIfAborted(signal);
  if (
    requireMediaSignature
    && !gatewayMediaBytesMatchType(loaded.data, source.mediaType)
  ) {
    throw new ApplicationError(
      "conflict",
      "Gateway media no longer matches its exact content identity.",
      { path: source.path },
    );
  }
  return { data: loaded.data, source };
}

async function prepareRequestMedia(
  options: CreateGatewayApplicationPortOptions,
  request: GatewayPortRequest,
  signal: AbortSignal,
  hostResourceLease: ApplicationContext["hostResourceLease"],
): Promise<PreparedGatewayRequest> {
  const sources = gatewaySources(request);
  const loaded: LoadedGatewaySource[] = [];
  for (const source of sources) {
    loaded.push(await readBoundSource(options.application, source, signal));
  }
  if (loaded.length === 0) return { loaded, request };
  const facts = await options.inspectMedia(
    loaded.map(item => ({
      data: item.data,
      mediaType: item.source.mediaType,
      path: item.source.path,
    })),
    signal,
    hostResourceLease,
  );
  throwIfAborted(signal);
  if (facts.length !== loaded.length) {
    throw new ApplicationError(
      "invalid-data",
      "Gateway media inspection returned an inconsistent result count.",
    );
  }
  const preparedSources = loaded.map((item, index) =>
    GatewayMediaSourceReferenceSchema.parse({
      ...item.source,
      facts: facts[index],
    }));
  return {
    loaded: loaded.map((item, index) => ({
      data: item.data,
      source: preparedSources[index]!,
    })),
    request: replaceGatewaySources(request, preparedSources),
  };
}

async function resolveProviderOptions(
  options: CreateGatewayApplicationPortOptions,
  request: GatewayPortRequest,
  signal: AbortSignal,
): Promise<GatewayProviderOptions | undefined> {
  const expected = request.request.providerOptions;
  if (expected === undefined) return undefined;
  throwIfAborted(signal);
  const resolved = await options.resolveProviderOptions?.(expected, signal);
  throwIfAborted(signal);
  if (resolved === undefined) {
    throw new ApplicationError(
      "authorization-required",
      "This exact Gateway request requires its digest-matching provider-options file.",
      {
        namespaces: expected.namespaces,
        providerOptionsSha256: expected.sha256,
      },
    );
  }
  const actual = gatewayProviderOptionsSummary(resolved);
  if (
    actual.sha256 !== expected.sha256
    || canonicalJson(actual.namespaces) !== canonicalJson(expected.namespaces)
  ) {
    throw new ApplicationError(
      "authorization-required",
      "The supplied provider-options file does not match this exact Gateway request.",
      {
        expectedNamespaces: expected.namespaces,
        expectedSha256: expected.sha256,
        suppliedNamespaces: actual.namespaces,
        suppliedSha256: actual.sha256,
      },
    );
  }
  return resolved;
}

function serviceInput(
  item: LoadedGatewaySource,
): GatewayMediaInput {
  const facts = item.source.facts;
  return {
    data: item.data,
    ...(facts === undefined
      ? {}
      : {
          facts: {
            ...(facts.durationSeconds === undefined
              ? {}
              : { durationSeconds: facts.durationSeconds }),
            ...(facts.height === undefined
              ? {}
              : { height: facts.height }),
            ...(facts.width === undefined
              ? {}
              : { width: facts.width }),
          },
        }),
    mediaType: item.source.mediaType,
  };
}

function serviceOperation(
  operation: GatewayPortRequest["operation"],
): GatewayMediaDispatchEvent["operation"] {
  switch (operation) {
    case "image": return "image.generate";
    case "video": return "video.generate";
    case "speech": return "speech.generate";
    case "transcription": return "transcription.create";
  }
}

function serviceConsent(now: Date) {
  return {
    acknowledgedAt: now.toISOString(),
    allowCloudUpload: true,
    policy: GATEWAY_MEDIA_UPLOAD_POLICY,
  } as const;
}

async function executeService(
  service: GatewayMediaService,
  prepared: PreparedGatewayRequest,
  providerOptions: GatewayProviderOptions | undefined,
  signal: AbortSignal,
  now: Date,
): Promise<Readonly<{
  bundle: GatewayMediaArtifactBundle;
  transcript?: Readonly<{
    readonly durationInSeconds?: number;
    readonly language?: string;
    readonly segments: readonly unknown[];
    readonly text: string;
  }>;
}>> {
  let index = 0;
  const next = (): GatewayMediaInput => {
    const loaded = prepared.loaded[index];
    index += 1;
    if (loaded === undefined) {
      throw new ApplicationError(
        "internal",
        "Gateway dispatch lost one prepared media source.",
      );
    }
    return serviceInput(loaded);
  };
  const execution = {
    signal,
    ...(prepared.request.request.timeoutMs === undefined
      ? {}
      : { timeoutMs: prepared.request.request.timeoutMs }),
  };
  let result: Readonly<{
    bundle: GatewayMediaArtifactBundle;
    transcript?: Readonly<{
      readonly durationInSeconds?: number;
      readonly language?: string;
      readonly segments: readonly unknown[];
      readonly text: string;
    }>;
  }>;
  switch (prepared.request.operation) {
    case "image": {
      const request = prepared.request.request;
      const bundle = await service.generateImage({
        ...(request.aspectRatio === undefined
          ? {}
          : { aspectRatio: request.aspectRatio }),
        consent: serviceConsent(now),
        images: (request.images ?? []).map(() => next()),
        ...(request.mask === undefined ? {} : { mask: next() }),
        ...(request.maxImagesPerCall === undefined
          ? {}
          : { maxImagesPerCall: request.maxImagesPerCall }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        model: request.model,
        ...(request.n === undefined ? {} : { n: request.n }),
        prompt: request.prompt,
        ...(providerOptions === undefined ? {} : { providerOptions }),
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        ...(request.size === undefined ? {} : { size: request.size }),
        ...(request.stopSequences === undefined
          ? {}
          : { stopSequences: request.stopSequences }),
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
      }, execution);
      result = { bundle };
      break;
    }
    case "video": {
      const request = prepared.request.request;
      const promptImage = request.promptImage === undefined
        ? undefined
        : next();
      const frameImages = (request.frames ?? []).map(frame => ({
        frameType: frame.frameType,
        image: next(),
      }));
      const inputReferences = (request.references ?? []).map(() => next());
      const bundle = await service.generateVideo({
        ...(request.aspectRatio === undefined
          ? {}
          : { aspectRatio: request.aspectRatio }),
        consent: serviceConsent(now),
        ...(request.durationSeconds === undefined
          ? {}
          : { duration: request.durationSeconds }),
        ...(request.fps === undefined ? {} : { fps: request.fps }),
        frameImages,
        ...(request.generateAudio === undefined
          ? {}
          : { generateAudio: request.generateAudio }),
        inputReferences,
        ...(request.maxVideosPerCall === undefined
          ? {}
          : { maxVideosPerCall: request.maxVideosPerCall }),
        model: request.model,
        ...(request.n === undefined ? {} : { n: request.n }),
        prompt: request.prompt,
        ...(promptImage === undefined
          ? {}
          : { promptImage }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
        ...(request.resolution === undefined
          ? {}
          : { resolution: request.resolution }),
        ...(request.seed === undefined ? {} : { seed: request.seed }),
      }, execution);
      result = { bundle };
      break;
    }
    case "speech": {
      const request = prepared.request.request;
      const bundle = await service.generateSpeech({
        consent: serviceConsent(now),
        ...(request.instructions === undefined
          ? {}
          : { instructions: request.instructions }),
        ...(request.language === undefined ? {} : { language: request.language }),
        model: request.model,
        ...(request.outputFormat === undefined
          ? {}
          : { outputFormat: request.outputFormat }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
        ...(request.speed === undefined ? {} : { speed: request.speed }),
        text: request.text,
        ...(request.voice === undefined ? {} : { voice: request.voice }),
      }, execution);
      result = { bundle };
      break;
    }
    case "transcription": {
      const request = prepared.request.request;
      const transcript = await service.transcribe({
        audio: next(),
        consent: serviceConsent(now),
        model: request.model,
        ...(providerOptions === undefined ? {} : { providerOptions }),
      }, execution);
      result = {
        bundle: transcript.artifact,
        transcript,
      };
      break;
    }
  }
  if (index !== prepared.loaded.length) {
    throw new ApplicationError(
      "internal",
      "Gateway dispatch did not consume every prepared media source.",
    );
  }
  return result;
}

function repositoryRelativePath(
  repositoryRoot: string,
  path: string,
): string {
  const root = resolve(repositoryRoot);
  const candidate = isAbsolute(path)
    ? resolve(path)
    : resolve(root, path);
  const fromRoot = relative(root, candidate);
  return RepositoryRelativePathSchema.parse(fromRoot);
}

async function verifiedBundleReferences(
  application: ApplicationContext,
  bundle: GatewayMediaArtifactBundle,
): Promise<Readonly<{
  outputs: GatewayOperationResult["outputs"];
  receipt: GatewayOperationResult["receipt"];
}>> {
  const finalizationSignal = new AbortController().signal;
  const outputs: GatewayOperationResult["outputs"][number][] = [];
  for (const output of bundle.outputs) {
    const path = repositoryRelativePath(
      application.paths.repositoryRoot,
      output.path,
    );
    const verified = await bindRepositoryMedia(
      application,
      {
        bytes: output.bytes,
        path,
        sha256: output.sha256,
      },
      finalizationSignal,
      MAXIMUM_GATEWAY_SOURCE_BYTES,
    );
    outputs.push({
      ...verified.artifact,
      mediaType: output.mediaType,
    });
  }
  const receiptPath = repositoryRelativePath(
    application.paths.repositoryRoot,
    bundle.receiptPath,
  );
  const receipt = (
    await bindRepositoryMedia(
      application,
      { path: receiptPath },
      finalizationSignal,
      MAXIMUM_GATEWAY_RECEIPT_BYTES,
    )
  ).artifact;
  return {
    outputs,
    receipt,
  };
}

async function operationResult(
  application: ApplicationContext,
  request: GatewayPortRequest,
  requestId: string,
  serviceResult: Awaited<ReturnType<typeof executeService>>,
): Promise<GatewayOperationResult> {
  const expectedOperation = serviceOperation(request.operation);
  const receipt = serviceResult.bundle.receipt;
  if (
    receipt.operation !== expectedOperation
    || receipt.model !== request.request.model
    || receipt.localValidation.status === "decode-failed"
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Gateway artifacts do not contain a valid authoritative receipt for the exact request.",
      { requestId },
    );
  }
  const references = await verifiedBundleReferences(
    application,
    serviceResult.bundle,
  );
  return GatewayOperationResultSchema.parse({
    model: request.request.model,
    operation: request.operation,
    outputs: references.outputs,
    receipt: references.receipt,
    requestId,
    ...(request.operation === "transcription"
      ? {
          transcript: {
            characters: serviceResult.transcript?.text.length ?? 0,
            durationSeconds:
              serviceResult.transcript?.durationInSeconds ?? 0,
            ...(serviceResult.transcript?.language === undefined
              ? {}
              : { language: serviceResult.transcript.language }),
            segments: serviceResult.transcript?.segments.length ?? 0,
            textSha256: createHash("sha256")
              .update(serviceResult.transcript?.text ?? "", "utf8")
              .digest("hex"),
          },
        }
      : {}),
  });
}

async function verifyCompletedResult(
  application: ApplicationContext,
  result: GatewayOperationResult,
  signal: AbortSignal,
): Promise<void> {
  for (const output of result.outputs) {
    await readBoundSource(
      application,
      GatewayMediaSourceReferenceSchema.parse(output),
      signal,
      /^(?:audio|image|video)\//u.test(output.mediaType),
    );
  }
  await bindRepositoryMedia(
    application,
    result.receipt,
    signal,
    MAXIMUM_GATEWAY_RECEIPT_BYTES,
  );
  throwIfAborted(signal);
}

function preDispatchError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  return new ApplicationError(
    "unavailable",
    "Gateway media preparation failed before paid dispatch.",
  );
}

export function createGatewayApplicationPort(
  options: CreateGatewayApplicationPortOptions,
): ApplicationGatewayPort {
  const now = options.now ?? (() => new Date());
  return {
    prepare: async (input: GatewayPortPrepare) => {
      const request = GatewayPortRequestSchema.parse(input.request);
      throwIfAborted(input.signal);
      await resolveProviderOptions(options, request, input.signal);
      return (await prepareRequestMedia(
        options,
        request,
        input.signal,
        input.hostResourceLease,
      )).request;
    },
    dispatch: async (input: GatewayPortDispatch) => {
      const request = GatewayPortRequestSchema.parse(input.request);
      const requestId = GatewayRequestIdSchema.parse(input.requestId);
      const digest = requestSha256(request);
      throwIfAborted(input.signal);
      const directory = await gatewayRequestDirectory(
        options.application,
        requestId,
      );
      return await withMutationLock(directory, {
        command: `gateway workflow dispatch ${requestId}`,
        label: `Gateway workflow request ${requestId}`,
        now,
      }, async () => {
        let journal = await readJournal(directory);
        if (
          journal !== null
          && !journalMatches(journal, request, requestId, digest)
        ) {
          throw new ApplicationError(
            "conflict",
            "Gateway request ID is already bound to different exact input.",
            { requestId },
          );
        }
        if (journal?.state === "completed") {
          try {
            await verifyCompletedResult(
              options.application,
              journal.result!,
              input.signal,
            );
          } catch {
            throwIfAborted(input.signal);
            throw new ApplicationError(
              "conflict",
              "The completed Gateway journal no longer matches its committed artifacts.",
              { requestId },
            );
          }
          return journal.result!;
        }
        if (journal?.state === "dispatched") {
          throw new ApplicationError(
            "ambiguous",
            "This exact Gateway request was already dispatched and has no completed local journal result.",
            { requestId },
          );
        }

        throwIfAborted(input.signal);
        const providerOptions = await resolveProviderOptions(
          options,
          request,
          input.signal,
        );
        const prepared = await prepareRequestMedia(
          options,
          request,
          input.signal,
          input.hostResourceLease,
        );
        if (canonicalJson(prepared.request) !== canonicalJson(request)) {
          throw new ApplicationError(
            "conflict",
            "Gateway media facts changed after the exact node plan was approved.",
            { requestId },
          );
        }
        const createdAt = journal?.createdAt ?? now().toISOString();
        journal = await writeJournal(directory, {
          chargeMayHaveOccurred: false,
          createdAt,
          kind: "atet.gateway-workflow-request",
          model: request.request.model,
          operation: request.operation,
          requestId,
          requestSha256: digest,
          schemaVersion: 1,
          state: "prepared",
          updatedAt: now().toISOString(),
        });
        const persistDispatched = async (
          failure?: unknown,
        ): Promise<void> => {
          journal = await writeJournal(directory, {
            ...journalIdentity(journal!),
            chargeMayHaveOccurred: true,
            ...(failure === undefined
              ? {}
              : { failureSha256: failureSha256(failure) }),
            state: "dispatched",
            updatedAt: now().toISOString(),
          });
        };
        try {
          const service = await options.createService({
            beforePublication: input.beforePublication,
            onDispatch: async event => {
              throwIfAborted(input.signal);
              if (
                journal?.state !== "prepared"
                || event.model !== request.request.model
                || event.operation !== serviceOperation(request.operation)
              ) {
                throw new ApplicationError(
                  "conflict",
                  "Gateway service dispatch did not match its durable prepared request.",
                  { requestId },
                );
              }
              await persistDispatched();
            },
          }, input.hostResourceLease);
          const executed = await executeService(
            service,
            prepared,
            providerOptions,
            input.signal,
            now(),
          );
          if (journal.state !== "dispatched") {
            await persistDispatched(
              new Error("Gateway service returned without a dispatch event."),
            );
            throw new ApplicationError(
              "ambiguous",
              "Gateway service returned paid output without its durable dispatch transition.",
              { requestId },
            );
          }
          const result = await operationResult(
            options.application,
            request,
            requestId,
            executed,
          );
          journal = await writeJournal(directory, {
            ...journalIdentity(journal),
            chargeMayHaveOccurred: true,
            result,
            state: "completed",
            updatedAt: now().toISOString(),
          });
          return result;
        } catch (error) {
          if (journal.state === "dispatched") {
            await persistDispatched(error).catch(() => undefined);
            throw new ApplicationError(
              "ambiguous",
              "Gateway paid dispatch did not produce a completed authoritative local journal result.",
              {
                failureSha256: failureSha256(error),
                requestId,
              },
            );
          }
          journal = await writeJournal(directory, {
            ...journalIdentity(journal),
            chargeMayHaveOccurred: false,
            failureSha256: failureSha256(error),
            state: "prepared",
            updatedAt: now().toISOString(),
          });
          throw preDispatchError(error);
        }
      });
    },
    reconcile: async (input: GatewayPortReconcile) => {
      const request = GatewayPortRequestSchema.parse(input.request);
      const requestId = GatewayRequestIdSchema.parse(input.requestId);
      const digest = requestSha256(request);
      throwIfAborted(input.signal);
      const directory = await gatewayRequestDirectory(
        options.application,
        requestId,
      );
      return await withMutationLock(directory, {
        command: `gateway workflow reconcile ${requestId}`,
        label: `Gateway workflow request ${requestId}`,
        now,
      }, async () => {
        const journal = await readJournal(directory);
        if (journal === null) {
          return {
            operation: request.operation,
            requestId,
            status: "not-dispatched",
          } as const;
        }
        if (!journalMatches(journal, request, requestId, digest)) {
          return {
            operation: request.operation,
            reasonSha256: conflictSha256(
              `${requestId}\0${digest}\0${journal.requestSha256}`,
            ),
            requestId,
            status: "conflict",
          } as const;
        }
        if (journal.state === "completed") {
          try {
            await verifyCompletedResult(
              options.application,
              journal.result!,
              input.signal,
            );
          } catch (error) {
            throwIfAborted(input.signal);
            return {
              operation: request.operation,
              reasonSha256: conflictSha256(
                `${requestId}\0completed-artifact-integrity\0${failureSha256(error)}`,
              ),
              requestId,
              status: "conflict",
            } as const;
          }
          return {
            operation: request.operation,
            requestId,
            result: journal.result!,
            status: "completed",
          } as const;
        }
        if (journal.state === "prepared") {
          return {
            operation: request.operation,
            requestId,
            status: "not-dispatched",
          } as const;
        }
        return {
          operation: request.operation,
          requestId,
          status: "dispatched",
        } as const;
      });
    },
  };
}

export async function assertGatewayApplicationJournalPrivate(
  application: ApplicationContext,
  requestId: string,
): Promise<void> {
  const directory = await gatewayRequestDirectory(application, requestId);
  const [physical, details] = await Promise.all([
    realpath(directory),
    lstat(directory),
  ]);
  if (
    physical !== directory
    || details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o077) !== 0
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Gateway workflow journal directory is not private and physical.",
    );
  }
}
