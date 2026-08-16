import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "../core/canonical-json";
import type {
  GatewayJsonValue,
  GatewayMediaKind,
} from "./gateway-media-catalog";
import { gatewayMediaBytesMatchType } from "./gateway-media-signature";

const MAXIMUM_GENERATED_FILE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_GENERATED_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_OUTPUTS = 32;
const MAXIMUM_RECEIPT_BYTES = 256 * 1024;

export interface GatewayGeneratedFile {
  readonly mediaType: string;
  readonly uint8Array: Uint8Array;
}

export interface GatewayMediaInputDigest {
  readonly bytes: number;
  readonly mediaType: string;
  readonly role: string;
  readonly sha256: string;
  readonly source: "inline" | "url";
}

export interface GatewayMediaReceiptOutput {
  readonly bytes: number;
  readonly file: string;
  readonly mediaType: string;
  readonly sha256: string;
}

export interface GatewayMediaRoutingReceipt {
  readonly attemptCount: number;
  readonly attempts: readonly Readonly<{
    readonly configuredTimeoutMs?: number;
    readonly credentialType?: string;
    readonly error?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly providerTimeout?: boolean;
    readonly statusCode?: number;
    readonly success?: boolean;
  }>[];
  readonly attemptsTruncated: boolean;
  readonly clientMaxRetries: 0;
  readonly gatewayProviderFailover: "may-attempt-multiple-providers";
  readonly generationId?: string;
  readonly providerCount: number;
  readonly providers: readonly string[];
  readonly providersTruncated: boolean;
}

export interface GatewayMediaReceipt {
  readonly catalog: Readonly<{
    snapshotId: string;
    status: "fresh" | "stale";
  }>;
  readonly createdAt: string;
  readonly inputs: readonly GatewayMediaInputDigest[];
  readonly kind:
    | "atet.gateway-media-receipt"
    | "studio.gateway-media-receipt";
  readonly localValidation: Readonly<{
    readonly decodeValidatedOutputs: number;
    readonly failureSha256?: string;
    readonly signatureOnlyOutputs: number;
    readonly status: "decode-failed" | "decode-passed" | "signature-only";
  }>;
  readonly model: string;
  readonly nextCommands: readonly string[];
  readonly operation: "image.generate" | "speech.generate" | "transcription.create" | "video.generate";
  readonly outputs: readonly GatewayMediaReceiptOutput[];
  readonly request: Readonly<Record<string, GatewayJsonValue>>;
  readonly routing: GatewayMediaRoutingReceipt;
  readonly sampleFulfillment?: Readonly<{
    readonly produced: number;
    readonly requested: number;
    readonly status: "complete" | "overproduced" | "partial";
  }>;
  readonly schemaVersion: 1;
  readonly warnings: readonly string[];
}

export interface GatewayMediaArtifactBundle {
  readonly directory: string;
  readonly outputs: readonly Readonly<GatewayMediaReceiptOutput & { readonly path: string }>[];
  readonly receipt: GatewayMediaReceipt;
  readonly receiptPath: string;
}

export interface GatewayMediaArtifactStore {
  commit(input: Readonly<{
    catalog: GatewayMediaReceipt["catalog"];
    createdAt: string;
    files: readonly GatewayGeneratedFile[];
    inputs: readonly GatewayMediaInputDigest[];
    mediaKind: GatewayMediaKind;
    model: string;
    operation: GatewayMediaReceipt["operation"];
    request: Readonly<Record<string, GatewayJsonValue>>;
    routing: GatewayMediaRoutingReceipt;
    signal: AbortSignal;
    sampleFulfillment?: Readonly<{
      readonly produced: number;
      readonly requested: number;
    }>;
    warnings: readonly string[];
  }>): Promise<GatewayMediaArtifactBundle>;
}

export type GatewayMediaArtifactErrorCode =
  | "artifact-invalid"
  | "artifact-unavailable"
  | "output-too-large"
  | "unsafe-output";

const ERROR_MESSAGES: Readonly<Record<GatewayMediaArtifactErrorCode, string>> = {
  "artifact-invalid": "The generated Gateway media output is invalid.",
  "artifact-unavailable": "The generated Gateway media output could not be saved.",
  "output-too-large": "The generated Gateway media output exceeds its local size limit.",
  "unsafe-output": "The Gateway media output directory is unsafe.",
};

export class GatewayMediaArtifactError extends Error {
  readonly code: GatewayMediaArtifactErrorCode;

  constructor(code: GatewayMediaArtifactErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.name = "GatewayMediaArtifactError";
  }
}

function canonicalTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  return value;
}

function validateMediaType(value: string): string {
  if (
    value.length < 3
    || value.length > 128
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)
  ) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  return value.toLocaleLowerCase("en-US");
}

function extensionForMediaType(mediaType: string): string {
  const extensions: Readonly<Record<string, string>> = {
    "audio/aac": ".aac",
    "audio/aiff": ".aiff",
    "audio/alaw": ".alaw",
    "audio/basic": ".au",
    "audio/flac": ".flac",
    "audio/l16": ".pcm",
    "audio/m4a": ".m4a",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/mulaw": ".mulaw",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/pcm": ".pcm",
    "audio/wav": ".wav",
    "audio/webm": ".weba",
    "audio/x-wav": ".wav",
    "application/json": ".json",
    "application/x-subrip": ".srt",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
    "text/plain": ".txt",
    "text/vtt": ".vtt",
    "video/mp4": ".mp4",
    "video/mpeg": ".mpeg",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
  };
  return extensions[mediaType] ?? ".bin";
}

function boundedWarning(value: string): string {
  const normalized = [...value].map((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (
      codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
    )
      ? " "
      : character;
  }).join("");
  return normalized.slice(0, 2_000);
}

function validateDigest(value: GatewayMediaInputDigest): GatewayMediaInputDigest {
  if (
    !Number.isSafeInteger(value.bytes)
    || value.bytes < 0
    || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || value.role.length < 1
    || value.role.length > 128
    || (value.source !== "inline" && value.source !== "url")
    || (value.source === "inline" && value.bytes < 1)
    || (value.source === "url" && value.bytes !== 0)
  ) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  return {
    bytes: value.bytes,
    mediaType: validateMediaType(value.mediaType),
    role: value.role,
    sha256: value.sha256,
    source: value.source,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRouting(value: unknown): GatewayMediaRoutingReceipt {
  const boundedString = (candidate: unknown): string | undefined => {
    if (candidate === undefined) return undefined;
    if (
      typeof candidate !== "string"
      || candidate.length < 1
      || candidate.length > 256
    ) {
      throw new GatewayMediaArtifactError("artifact-invalid");
    }
    return boundedWarning(candidate);
  };
  if (!isRecord(value)) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  const attemptsValue = value.attempts;
  const providersValue = value.providers;
  if (
    !Array.isArray(attemptsValue)
    || attemptsValue.length > 32
    || !Number.isSafeInteger(value.attemptCount)
    || (value.attemptCount as number) < attemptsValue.length
    || (value.attemptCount as number) > 1_000_000
    || typeof value.attemptsTruncated !== "boolean"
    || value.attemptsTruncated
      !== ((value.attemptCount as number) !== attemptsValue.length)
    || value.clientMaxRetries !== 0
    || value.gatewayProviderFailover !== "may-attempt-multiple-providers"
    || !Array.isArray(providersValue)
    || providersValue.length > 32
    || !Number.isSafeInteger(value.providerCount)
    || (value.providerCount as number) < providersValue.length
    || (value.providerCount as number) > 1_000_000
    || typeof value.providersTruncated !== "boolean"
    || value.providersTruncated
      !== ((value.providerCount as number) !== providersValue.length)
  ) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  const providers = providersValue.map((provider) => {
    const parsed = boundedString(provider);
    if (parsed === undefined) {
      throw new GatewayMediaArtifactError("artifact-invalid");
    }
    return parsed;
  });
  const attempts = attemptsValue.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new GatewayMediaArtifactError("artifact-invalid");
    }
    const configuredTimeoutMs = candidate.configuredTimeoutMs;
    const credentialType = boundedString(candidate.credentialType);
    const error = boundedString(candidate.error);
    const model = boundedString(candidate.model);
    const provider = boundedString(candidate.provider);
    const statusCode = candidate.statusCode;
    if (
      (
        configuredTimeoutMs !== undefined
        && (
          !Number.isSafeInteger(configuredTimeoutMs)
          || (configuredTimeoutMs as number) < 0
        )
      )
      || (
        candidate.credentialType !== undefined
        && credentialType === undefined
      )
      || (
        candidate.error !== undefined
        && (
          error === undefined
          || !/^sha256:[a-f0-9]{64}$/u.test(error)
        )
      )
      || (candidate.model !== undefined && model === undefined)
      || (candidate.provider !== undefined && provider === undefined)
      || (
        candidate.providerTimeout !== undefined
        && typeof candidate.providerTimeout !== "boolean"
      )
      || (
        statusCode !== undefined
        && (
          !Number.isSafeInteger(statusCode)
          || (statusCode as number) < 0
          || (statusCode as number) > 999
        )
      )
      || (
        candidate.success !== undefined
        && typeof candidate.success !== "boolean"
      )
    ) {
      throw new GatewayMediaArtifactError("artifact-invalid");
    }
    return {
      ...(configuredTimeoutMs === undefined
        ? {}
        : { configuredTimeoutMs: configuredTimeoutMs as number }),
      ...(credentialType === undefined ? {} : { credentialType }),
      ...(error === undefined ? {} : { error }),
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
      ...(candidate.providerTimeout === undefined
        ? {}
        : { providerTimeout: candidate.providerTimeout }),
      ...(statusCode === undefined
        ? {}
        : { statusCode: statusCode as number }),
      ...(candidate.success === undefined
        ? {}
        : { success: candidate.success }),
    };
  });
  const generationId = boundedString(value.generationId);
  if (value.generationId !== undefined && generationId === undefined) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  return {
    attemptCount: value.attemptCount as number,
    attempts,
    attemptsTruncated: value.attemptsTruncated,
    clientMaxRetries: 0,
    gatewayProviderFailover: "may-attempt-multiple-providers",
    ...(generationId === undefined ? {} : { generationId }),
    providerCount: value.providerCount as number,
    providers: [...new Set(providers)],
    providersTruncated: value.providersTruncated,
  };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(
  path: string,
  body: Uint8Array | string,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function operationStem(operation: GatewayMediaReceipt["operation"]): string {
  switch (operation) {
    case "image.generate":
      return "image";
    case "speech.generate":
      return "speech";
    case "transcription.create":
      return "transcript";
    case "video.generate":
      return "video";
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

const NON_SELF_DESCRIBING_SPEECH_MEDIA_TYPES = new Set([
  "audio/alaw",
  "audio/basic",
  "audio/l16",
  "audio/mulaw",
  "audio/pcm",
]);

export function gatewayMediaTypeIsSelfDescribing(
  mediaType: string,
): boolean {
  return /^(?:audio|image|video)\//u.test(mediaType)
    && !NON_SELF_DESCRIBING_SPEECH_MEDIA_TYPES.has(mediaType);
}

function nextCommands(
  operation: GatewayMediaReceipt["operation"],
  finalDirectory: string,
  outputs: readonly GatewayMediaReceiptOutput[],
  repositoryRoot: string,
): readonly string[] {
  const role = operation === "speech.generate"
    ? "dialogue"
    : operation === "transcription.create"
      ? undefined
      : "b-roll";
  return role === undefined
    ? []
    : outputs
      .filter(output => (
        operation !== "speech.generate"
        || !NON_SELF_DESCRIBING_SPEECH_MEDIA_TYPES.has(output.mediaType)
      ))
      .map(output => (
        `atet project add <project> ${
          shellArgument(
            relative(
              repositoryRoot,
              join(finalDirectory, output.file),
            ).split(sep).join("/"),
          )
        } --role ${role}`
      ));
}

function runDirectoryName(
  operation: GatewayMediaReceipt["operation"],
  createdAt: string,
  randomId: string,
): string {
  return `${createdAt.replace(/[-:.]/gu, "").replace("Z", "Z")}-${operationStem(operation)}-${randomId}`;
}

function validateFile(
  file: GatewayGeneratedFile,
): Readonly<GatewayGeneratedFile & { readonly mediaType: string }> {
  if (!(file.uint8Array instanceof Uint8Array) || file.uint8Array.byteLength < 1) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  if (file.uint8Array.byteLength > MAXIMUM_GENERATED_FILE_BYTES) {
    throw new GatewayMediaArtifactError("output-too-large");
  }
  const mediaType = validateMediaType(file.mediaType);
  if (
    /^(?:audio|image|video)\//u.test(mediaType)
    && !gatewayMediaBytesMatchType(file.uint8Array, mediaType)
  ) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  return {
    mediaType,
    uint8Array: file.uint8Array,
  };
}

function sampleFulfillment(
  value: Readonly<{ readonly produced: number; readonly requested: number }>,
): NonNullable<GatewayMediaReceipt["sampleFulfillment"]> {
  if (
    !Number.isSafeInteger(value.requested)
    || value.requested < 1
    || value.requested > MAXIMUM_OUTPUTS
    || !Number.isSafeInteger(value.produced)
    || value.produced < 1
    || value.produced > MAXIMUM_OUTPUTS
  ) {
    throw new GatewayMediaArtifactError("artifact-invalid");
  }
  return {
    produced: value.produced,
    requested: value.requested,
    status: value.produced === value.requested
      ? "complete"
      : value.produced < value.requested
        ? "partial"
        : "overproduced",
  };
}

export function createFileGatewayMediaArtifactStore(options: Readonly<{
  beforePublication?: () => Promise<void>;
  outputRoot: string;
  randomId?: () => string;
  repositoryRoot: string;
  validateMediaFile?: (
    file: Readonly<GatewayGeneratedFile & {
      readonly path: string;
    }>,
    signal: AbortSignal,
  ) => Promise<void>;
}>): GatewayMediaArtifactStore {
  if (!isAbsolute(options.outputRoot) || !isAbsolute(options.repositoryRoot)) {
    throw new GatewayMediaArtifactError("unsafe-output");
  }
  const outputRelative = relative(options.repositoryRoot, options.outputRoot);
  if (
    outputRelative.length === 0
    || outputRelative === ".."
    || outputRelative.startsWith(`..${sep}`)
    || isAbsolute(outputRelative)
  ) {
    throw new GatewayMediaArtifactError("unsafe-output");
  }
  const randomId = options.randomId ?? (() => randomUUID().slice(0, 12));
  return {
    commit: async (input) => {
      input.signal.throwIfAborted();
      if (input.files.length < 1 || input.files.length > MAXIMUM_OUTPUTS) {
        throw new GatewayMediaArtifactError("artifact-invalid");
      }
      const files = input.files.map(validateFile);
      const totalBytes = files.reduce((sum, file) => sum + file.uint8Array.byteLength, 0);
      if (totalBytes > MAXIMUM_GENERATED_TOTAL_BYTES) {
        throw new GatewayMediaArtifactError("output-too-large");
      }
      const createdAt = canonicalTimestamp(input.createdAt);
      const identifier = randomId();
      if (!/^[a-z0-9_-]{4,64}$/iu.test(identifier)) {
        throw new GatewayMediaArtifactError("artifact-invalid");
      }
      const directoryName = runDirectoryName(input.operation, createdAt, identifier);
      const finalDirectory = join(options.outputRoot, directoryName);
      const stagingDirectory = join(options.outputRoot, `.${directoryName}.tmp`);
      let published = false;
      const receiptOutputs: GatewayMediaReceiptOutput[] = [];
      const stagedFiles: Readonly<GatewayGeneratedFile & {
        readonly path: string;
      }>[] = [];
      try {
        await mkdir(options.outputRoot, { mode: 0o700, recursive: true });
        const rootDetails = await lstat(options.outputRoot);
        if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
          throw new GatewayMediaArtifactError("unsafe-output");
        }
        await chmod(options.outputRoot, 0o700);
        input.signal.throwIfAborted();
        await mkdir(stagingDirectory, { mode: 0o700 });
        for (const [index, file] of files.entries()) {
          input.signal.throwIfAborted();
          const fileName = `${operationStem(input.operation)}-${String(index + 1).padStart(2, "0")}${extensionForMediaType(file.mediaType)}`;
          const outputPath = join(stagingDirectory, fileName);
          await writePrivateFile(outputPath, file.uint8Array);
          stagedFiles.push({
            mediaType: file.mediaType,
            path: outputPath,
            uint8Array: file.uint8Array,
          });
          receiptOutputs.push({
            bytes: file.uint8Array.byteLength,
            file: fileName,
            mediaType: file.mediaType,
            sha256: createHash("sha256").update(file.uint8Array).digest("hex"),
          });
          input.signal.throwIfAborted();
        }
        const decodeCandidates = stagedFiles.filter(file => (
          gatewayMediaTypeIsSelfDescribing(file.mediaType)
        ));
        let localValidation: GatewayMediaReceipt["localValidation"];
        if (
          decodeCandidates.length === 0
          || options.validateMediaFile === undefined
        ) {
          localValidation = {
            decodeValidatedOutputs: 0,
            signatureOnlyOutputs: stagedFiles.length,
            status: "signature-only",
          };
        } else {
          try {
            for (const file of decodeCandidates) {
              input.signal.throwIfAborted();
              await options.validateMediaFile(file, input.signal);
              input.signal.throwIfAborted();
            }
            localValidation = {
              decodeValidatedOutputs: decodeCandidates.length,
              signatureOnlyOutputs:
                stagedFiles.length - decodeCandidates.length,
              status: "decode-passed",
            };
          } catch (error) {
            input.signal.throwIfAborted();
            const failureSource = error instanceof Error
              ? `${error.name}\u0000${error.message}`
              : typeof error === "string"
                ? error
                : typeof error;
            localValidation = {
              decodeValidatedOutputs: 0,
              failureSha256: createHash("sha256")
                .update(failureSource, "utf8")
                .digest("hex"),
              signatureOnlyOutputs:
                stagedFiles.length - decodeCandidates.length,
              status: "decode-failed",
            };
          }
        }
        input.signal.throwIfAborted();
        const receipt: GatewayMediaReceipt = {
          catalog: input.catalog,
          createdAt,
          inputs: input.inputs.map(validateDigest),
          kind: "atet.gateway-media-receipt",
          localValidation,
          model: input.model,
          nextCommands: localValidation.status === "decode-passed"
            ? nextCommands(
                input.operation,
                finalDirectory,
                receiptOutputs,
                options.repositoryRoot,
              )
            : [],
          operation: input.operation,
          outputs: receiptOutputs,
          request: input.request,
          routing: validateRouting(input.routing),
          ...(input.sampleFulfillment === undefined
            ? {}
            : {
                sampleFulfillment: sampleFulfillment(
                  input.sampleFulfillment,
                ),
              }),
          schemaVersion: 1,
          warnings: input.warnings.slice(0, 100).map(boundedWarning),
        };
        let receiptSource: string;
        try {
          receiptSource = `${canonicalJson(receipt)}\n`;
        } catch {
          throw new GatewayMediaArtifactError("artifact-invalid");
        }
        if (new TextEncoder().encode(receiptSource).byteLength > MAXIMUM_RECEIPT_BYTES) {
          throw new GatewayMediaArtifactError("artifact-invalid");
        }
        await writePrivateFile(join(stagingDirectory, "receipt.json"), receiptSource);
        await syncDirectory(stagingDirectory);
        input.signal.throwIfAborted();
        await options.beforePublication?.();
        input.signal.throwIfAborted();
        await rename(stagingDirectory, finalDirectory);
        published = true;
        await syncDirectory(options.outputRoot);
        return {
          directory: finalDirectory,
          outputs: receiptOutputs.map(output => ({
            ...output,
            path: join(finalDirectory, output.file),
          })),
          receipt,
          receiptPath: join(finalDirectory, "receipt.json"),
        };
      } catch (error) {
        if (!published) input.signal.throwIfAborted();
        if (error instanceof GatewayMediaArtifactError) throw error;
        throw new GatewayMediaArtifactError("artifact-unavailable");
      } finally {
        await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
      }
    },
  };
}

export function displayGatewayArtifactFile(
  bundle: GatewayMediaArtifactBundle,
  file: string,
): string {
  const name = basename(file);
  return bundle.outputs.find(output => output.file === name)?.path ?? file;
}
