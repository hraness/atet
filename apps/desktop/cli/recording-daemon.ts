import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  CaptureInterruptionSchema,
  CaptureDeviceSelectionSchema,
  CaptureDisplaySelectionSchema,
  CapturePermissionsSchema,
  CaptureSourceInventorySchema,
  TypedTextFocusIdentitiesSchema,
} from "../capture/protocol";
import { CliError, asCliError } from "./errors";
import { environmentWithoutGatewayCredentials } from "./io";
import {
  CaptureHelperRecordingController,
  executeRecordingAction,
  parseRecordingSnapshot,
  readRepositoryRecordingState,
  type RecordingController,
  type RecordingSnapshot,
  type RecordingStartOptions,
} from "./recording-controller";
import { ensurePrivateDirectory } from "./paths";

const CONTROL_PROTOCOL_VERSION = 1 as const;
const MAX_CONTROL_LINE_BYTES = 64 * 1024;
const MAX_COMPACT_RECOVERY_BYTES = 40 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

interface ControlMetadata {
  readonly nonce: string;
  readonly pid: number;
  readonly protocolVersion: 1;
  readonly socketPath: string;
  readonly startedAt: string;
  readonly uid: number | null;
}

export interface ControlRequest {
  readonly action: "start" | "pause" | "resume" | "stop" | "status";
  readonly nonce: string;
  readonly options?: RecordingStartOptions;
  readonly protocolVersion: 1;
  readonly requestId: string;
}

export type ControlResponse =
  | {
      readonly ok: true;
      readonly protocolVersion: 1;
      readonly requestId: string;
      readonly snapshot: RecordingSnapshot;
    }
  | {
      readonly error: { readonly code: string; readonly details?: Readonly<Record<string, unknown>>; readonly message: string };
      readonly ok: false;
      readonly protocolVersion: 1;
      readonly requestId: string;
    };

export interface SerializedRecordingDispatcher {
  (request: ControlRequest): Promise<ControlResponse>;
  drain(): Promise<void>;
}

interface ControlPaths {
  readonly lock: string;
  readonly metadata: string;
  readonly socket: string;
}

function controlPaths(artifactRoot: string): ControlPaths {
  return {
    lock: join(artifactRoot, ".recording-control.lock"),
    metadata: join(artifactRoot, ".recording-control.json"),
    socket: join(artifactRoot, ".recording-control.sock"),
  };
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function parseJsonLine(line: string, label: string): unknown {
  if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) {
    throw new CliError("invalid-data", `${label} exceeds ${MAX_CONTROL_LINE_BYTES} bytes.`);
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new CliError("invalid-data", `${label} is not valid JSON.`);
  }
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("invalid-data", `${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function recoveryControllerReusable(
  details: Readonly<Record<string, unknown>> | undefined,
): boolean | null {
  const recovery = optionalRecord(recordProperty(details, "recovery"));
  if (recovery === null) {
    return null;
  }
  const reusable = recordProperty(recovery, "controllerReusable");
  return typeof reusable === "boolean" ? reusable : null;
}

function recordProperty(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): unknown {
  if (value === undefined) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function optionalRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : null;
  } catch {
    return null;
  }
}

function boundedNullableString(value: unknown): string | null {
  return typeof value === "string" && Buffer.byteLength(value) <= 4_096
    ? value
    : null;
}

function compactRecoveryDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const source = optionalRecord(recordProperty(details, "recovery"));
  const controllerReusable = recordProperty(source ?? undefined, "controllerReusable");
  if (source === null || typeof controllerReusable !== "boolean") {
    return undefined;
  }
  const rawTerminalManifestState = recordProperty(source, "terminalManifestState");
  const terminalManifestState = rawTerminalManifestState === "failed"
    || rawTerminalManifestState === "stopped"
    || rawTerminalManifestState === "unsettled"
    ? rawTerminalManifestState
    : controllerReusable
      ? null
      : "unsettled";
  if (terminalManifestState === null) return undefined;

  const snapshotSource = optionalRecord(recordProperty(source, "snapshot"));
  const snapshot: Record<string, unknown> = {};
  if (snapshotSource !== null) {
    const lastInterruption = recordProperty(snapshotSource, "lastInterruption");
    if (lastInterruption === null) {
      snapshot.lastInterruption = null;
    } else {
      try {
        const interruption = CaptureInterruptionSchema.safeParse(
          lastInterruption,
        );
        if (interruption.success) snapshot.lastInterruption = interruption.data;
      } catch {
        // Hostile foreign diagnostics cannot prevent recovery disposition from
        // crossing the daemon boundary.
      }
    }
    const logicalTimeUs = recordProperty(snapshotSource, "logicalTimeUs");
    if (
      typeof logicalTimeUs === "number"
      && Number.isSafeInteger(logicalTimeUs)
      && logicalTimeUs >= 0
    ) {
      snapshot.logicalTimeUs = logicalTimeUs;
    }
    const rawPermissions = recordProperty(snapshotSource, "permissions");
    if (rawPermissions === null) {
      snapshot.permissions = null;
    } else {
      try {
        const permissions = CapturePermissionsSchema.safeParse(
          rawPermissions,
        );
        if (permissions.success) snapshot.permissions = permissions.data;
      } catch {
        // Ignore untrusted optional frontier evidence.
      }
    }
    for (const name of ["availableSources", "sources"] as const) {
      try {
        const sources = CaptureSourceInventorySchema.safeParse(
          recordProperty(snapshotSource, name),
        );
        if (sources.success) snapshot[name] = sources.data;
      } catch {
        // Ignore untrusted optional frontier evidence.
      }
    }
  }

  const recovery = {
    controllerReusable,
    recordingId: boundedNullableString(recordProperty(source, "recordingId")),
    recordingRoot: boundedNullableString(recordProperty(source, "recordingRoot")),
    ...(Object.keys(snapshot).length === 0 ? {} : { snapshot }),
    terminalManifestState,
  };
  const compact = { recovery };
  if (Buffer.byteLength(JSON.stringify(compact)) <= MAX_COMPACT_RECOVERY_BYTES) {
    return compact;
  }
  delete snapshot.availableSources;
  delete snapshot.sources;
  return {
    recovery: {
      ...recovery,
      ...(Object.keys(snapshot).length === 0 ? { snapshot: undefined } : { snapshot }),
    },
  };
}

function ownedControlErrorMessage(
  error: Extract<ControlResponse, { readonly ok: false }>["error"],
): string {
  if (recoveryControllerReusable(error.details) === false) {
    return "Capture recovery was incomplete.";
  }
  switch (error.code) {
  case "usage":
    return "The recording request is invalid.";
  case "not-found":
    return "The requested recording resource was not found.";
  case "conflict":
    return "The recording command cannot run in the current state.";
  case "unavailable":
    return "The recording runtime is unavailable.";
  case "unsafe-path":
    return "The recording runtime refused an unsafe path.";
  case "invalid-data":
    return "The recording runtime returned invalid data.";
  case "subprocess":
    return "The capture helper failed.";
  case "unsupported-plan":
    return "The recording request is unsupported.";
  default:
    return "The recording control operation failed.";
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value) > 4_096) {
    throw new CliError("invalid-data", `${label} must be a bounded non-empty string.`);
  }
  return value;
}

function parseStartOptions(value: unknown): RecordingStartOptions {
  const options = object(value, "recording start options");
  const camera = CaptureDeviceSelectionSchema.safeParse(options.camera);
  if (!camera.success) throw new CliError("invalid-data", "Camera selection is invalid.");
  const displays = CaptureDisplaySelectionSchema.safeParse(options.displays);
  if (!displays.success) throw new CliError("invalid-data", "Display selection is invalid.");
  const microphone = CaptureDeviceSelectionSchema.safeParse(options.microphone);
  if (!microphone.success) throw new CliError("invalid-data", "Microphone selection is invalid.");
  const bool = (name: string): boolean => {
    const item = options[name];
    if (typeof item !== "boolean") throw new CliError("invalid-data", `${name} must be boolean.`);
    return item;
  };
  const rawProcessIdentifier = options.interactionEventProcessIdentifier;
  const interactionEventProcessIdentifier = rawProcessIdentifier === undefined
    ? undefined
    : rawProcessIdentifier === null
      ? null
      : typeof rawProcessIdentifier === "number"
        && Number.isInteger(rawProcessIdentifier)
        && rawProcessIdentifier > 0
        && rawProcessIdentifier <= 2_147_483_647
        ? rawProcessIdentifier
        : (() => {
            throw new CliError(
              "invalid-data",
              "interactionEventProcessIdentifier must be a positive 32-bit process ID or null.",
            );
          })();
  const rawFocusIdentities = options.typedTextFocusIdentities;
  const parsedFocusIdentities = rawFocusIdentities === undefined
    ? undefined
    : TypedTextFocusIdentitiesSchema.nullable().safeParse(rawFocusIdentities);
  if (
    parsedFocusIdentities !== undefined
    && !parsedFocusIdentities.success
  ) {
    throw new CliError(
      "invalid-data",
      "typedTextFocusIdentities must contain unique, bounded focus identities or null.",
    );
  }
  const typedTextFocusIdentities = parsedFocusIdentities?.data;
  return {
    camera: camera.data,
    displays: displays.data,
    ...(interactionEventProcessIdentifier === undefined
      ? {}
      : { interactionEventProcessIdentifier }),
    microphone: microphone.data,
    strictInputs: bool("strictInputs"),
    systemAudio: bool("systemAudio"),
    typedText: bool("typedText"),
    ...(typedTextFocusIdentities === undefined
      ? {}
      : {
          typedTextFocusIdentities: typedTextFocusIdentities === null
            ? null
            : typedTextFocusIdentities.map(identity => ({ ...identity })),
        }),
  };
}

function parseRequest(line: string): ControlRequest {
  const request = object(parseJsonLine(line, "Recording control request"), "Recording control request");
  if (request.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    throw new CliError("invalid-data", `Recording control protocol must be ${CONTROL_PROTOCOL_VERSION}.`);
  }
  const action = request.action;
  if (action !== "start" && action !== "pause" && action !== "resume" && action !== "stop" && action !== "status") {
    throw new CliError("invalid-data", "Recording control action is invalid.");
  }
  const allowed = new Set(action === "start"
    ? ["action", "nonce", "options", "protocolVersion", "requestId"]
    : ["action", "nonce", "protocolVersion", "requestId"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw new CliError("invalid-data", "Recording control request has unknown fields.");
  }
  const base = {
    action,
    nonce: string(request.nonce, "nonce"),
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    requestId: string(request.requestId, "requestId"),
  } as const;
  return action === "start"
    ? { ...base, action, options: parseStartOptions(request.options) }
    : { ...base, action };
}

function parseMetadata(value: unknown): ControlMetadata {
  const metadata = object(value, "Recording control metadata");
  if (
    metadata.protocolVersion !== CONTROL_PROTOCOL_VERSION
    || typeof metadata.pid !== "number"
    || !Number.isSafeInteger(metadata.pid)
    || metadata.pid <= 0
    || (metadata.uid !== null && (typeof metadata.uid !== "number" || !Number.isSafeInteger(metadata.uid)))
  ) {
    throw new CliError("invalid-data", "Recording control metadata has invalid process identity.");
  }
  return {
    nonce: string(metadata.nonce, "control nonce"),
    pid: metadata.pid,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    socketPath: string(metadata.socketPath, "control socket path"),
    startedAt: string(metadata.startedAt, "control start timestamp"),
    uid: metadata.uid,
  };
}

async function readMetadata(path: string): Promise<ControlMetadata | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new CliError("invalid-data", "Recording control metadata is not valid JSON.");
  }
  const metadata = parseMetadata(value);
  if (metadata.uid !== currentUid()) {
    throw new CliError("unsafe-path", "Recording control daemon belongs to another operating-system user.");
  }
  return metadata;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function responseLine(response: ControlResponse): string {
  const safeResponse: ControlResponse = response.ok
    ? response
    : (() => {
        const compactDetails = compactRecoveryDetails(response.error.details);
        const mustProjectRecovery =
          recoveryControllerReusable(response.error.details) === false;
        return {
          ...response,
          error: {
            code: response.error.code,
            ...(mustProjectRecovery
              ? compactDetails === undefined
                ? {}
                : { details: compactDetails }
              : response.error.details === undefined
                ? {}
                : { details: response.error.details }),
            message: ownedControlErrorMessage(response.error),
          },
        };
      })();
  let line = `${JSON.stringify(safeResponse)}\n`;
  if (
    Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES
    && !safeResponse.ok
  ) {
    const compactDetails = compactRecoveryDetails(
      safeResponse.error.details,
    );
    line = `${JSON.stringify({
      ...safeResponse,
      error: {
        code: safeResponse.error.code,
        ...(compactDetails === undefined ? {} : { details: compactDetails }),
        message: safeResponse.error.message,
      },
    } satisfies ControlResponse)}\n`;
  }
  if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) {
    throw new CliError("internal", "Recording control response exceeded its protocol bound.");
  }
  return line;
}

function requestLine(request: ControlRequest): string {
  const line = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) {
    throw new CliError("internal", "Recording control request exceeded its protocol bound.");
  }
  return line;
}

function parseResponse(line: string, requestId: string): RecordingSnapshot {
  const response = object(parseJsonLine(line, "Recording control response"), "Recording control response");
  if (response.protocolVersion !== CONTROL_PROTOCOL_VERSION || response.requestId !== requestId) {
    throw new CliError("invalid-data", "Recording control response identity does not match the request.");
  }
  if (response.ok === true) return parseRecordingSnapshot(response.snapshot);
  if (response.ok !== false) throw new CliError("invalid-data", "Recording control response omits status.");
  const error = object(response.error, "Recording control error");
  const code = string(error.code, "Recording control error code");
  const knownCode = ([
    "usage", "not-found", "conflict", "unavailable", "unsafe-path", "invalid-data", "subprocess",
    "unsupported-plan", "internal",
  ] as const).find(candidate => candidate === code);
  throw new CliError(
    knownCode === undefined ? "subprocess" : knownCode,
    string(error.message, "Recording control error message"),
    typeof error.details === "object" && error.details !== null && !Array.isArray(error.details)
      ? error.details as Readonly<Record<string, unknown>>
      : undefined,
  );
}

function socketRequest(
  metadata: ControlMetadata,
  action: ControlRequest["action"],
  options: RecordingStartOptions | undefined,
  timeoutMs: number,
): Promise<RecordingSnapshot> {
  const requestId = randomUUID();
  const request: ControlRequest = action === "start"
    ? {
        action,
        nonce: metadata.nonce,
        options: options ?? (() => { throw new CliError("internal", "Start options are missing."); })(),
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        requestId,
      }
    : { action, nonce: metadata.nonce, protocolVersion: CONTROL_PROTOCOL_VERSION, requestId };
  return new Promise((resolve, reject) => {
    const socket = createConnection(metadata.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, snapshot?: RecordingSnapshot): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== undefined) reject(error instanceof Error ? error : new Error("Unknown recording control failure."));
      else if (snapshot !== undefined) resolve(snapshot);
      else reject(new CliError("internal", "Recording control request ended without a result."));
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(requestLine(request));
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_CONTROL_LINE_BYTES) {
        finish(new CliError("invalid-data", "Recording control response is oversized."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(undefined, parseResponse(buffer.slice(0, newline), requestId));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("timeout", () => finish(new CliError("subprocess", "Recording control daemon timed out.")));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new CliError("subprocess", "Recording control daemon closed without a response.")));
  });
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export interface RecordingDaemonClientOptions {
  readonly artifactRoot: string;
  readonly daemonCommand: readonly [string, ...string[]];
  readonly helperExecutable: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export class RecordingDaemonClient implements RecordingController {
  readonly #artifactRoot: string;
  readonly #daemonCommand: readonly [string, ...string[]];
  readonly #helperExecutable: string;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(options: RecordingDaemonClientOptions) {
    this.#artifactRoot = options.artifactRoot;
    this.#daemonCommand = options.daemonCommand;
    this.#helperExecutable = options.helperExecutable;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #recoverStale(metadata: ControlMetadata | null, force = false): Promise<void> {
    const paths = controlPaths(this.#artifactRoot);
    if (!force && metadata !== null && processExists(metadata.pid)) return;
    const active = await readRepositoryRecordingState(this.#artifactRoot, this.#now);
    if (active.state !== "idle") {
      const stalePath = join(
        this.#artifactRoot,
        `.stale-recording-${this.#now().toISOString().replaceAll(/[:.]/gu, "-")}.json`,
      );
      await atomicWrite(stalePath, { reason: "control-daemon-exited", snapshot: active });
      await rm(join(this.#artifactRoot, ".active-recording.json"), { force: true });
    }
    await Promise.all([
      rm(paths.metadata, { force: true }),
      rm(paths.socket, { force: true }),
    ]);
  }

  async #existingMetadata(): Promise<ControlMetadata | null> {
    const metadata = await readMetadata(controlPaths(this.#artifactRoot).metadata);
    if (metadata !== null && metadata.socketPath !== controlPaths(this.#artifactRoot).socket) {
      throw new CliError("unsafe-path", "Recording control metadata points outside its repository socket.");
    }
    if (metadata !== null && processExists(metadata.pid)) return metadata;
    await this.#recoverStale(metadata);
    return null;
  }

  async #ensureDaemon(): Promise<ControlMetadata> {
    await ensurePrivateDirectory(this.#artifactRoot);
    const existing = await this.#existingMetadata();
    if (existing !== null) return existing;
    const paths = controlPaths(this.#artifactRoot);
    let ownsLock = false;
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      ownsLock = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const lock = await stat(paths.lock);
        if (Date.now() - lock.mtimeMs > 5_000 && await readMetadata(paths.metadata) === null) {
          await rm(paths.lock, { force: true, recursive: true });
          await mkdir(paths.lock, { mode: 0o700 });
          ownsLock = true;
        }
      } catch (lockError) {
        if (!(lockError instanceof Error && "code" in lockError && lockError.code === "ENOENT")) throw lockError;
      }
    }
    if (ownsLock) {
      const command = [
        ...this.#daemonCommand,
        "__record_daemon",
        "--artifact-root", this.#artifactRoot,
        "--helper", this.#helperExecutable,
      ];
      const child = Bun.spawn(command, {
        env: environmentWithoutGatewayCredentials(process.env),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      child.unref();
    }
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      try {
        const metadata = await readMetadata(paths.metadata);
        if (metadata !== null && processExists(metadata.pid)) return metadata;
      } catch (error) {
        if (!(error instanceof CliError && error.code === "invalid-data")) throw error;
      }
      await wait(25);
    }
    if (ownsLock) await rm(paths.lock, { force: true, recursive: true });
    throw new CliError("unavailable", "Recording control daemon did not become ready.");
  }

  async #request(action: ControlRequest["action"], options?: RecordingStartOptions): Promise<RecordingSnapshot> {
    const metadata = action === "status"
      ? await this.#existingMetadata()
      : await this.#ensureDaemon();
    if (metadata === null) return await readRepositoryRecordingState(this.#artifactRoot, this.#now);
    try {
      return await socketRequest(metadata, action, options, action === "start" ? 300_000 : 30_000);
    } catch (error) {
      if (
        error instanceof CliError
        && recoveryControllerReusable(error.details) === false
      ) {
        const deadline = Date.now() + this.#timeoutMs;
        while (processExists(metadata.pid) && Date.now() < deadline) {
          await wait(25);
        }
        if (!processExists(metadata.pid)) {
          try {
            await this.#recoverStale(metadata, true);
          } catch {
            // The original recovery failure remains authoritative. A later
            // request will retry stale-daemon cleanup before starting.
          }
        }
      }
      if (error instanceof Error && "code" in error && ["ECONNREFUSED", "ENOENT"].includes(String(error.code))) {
        await this.#recoverStale(metadata, true);
        if (action === "status") return await readRepositoryRecordingState(this.#artifactRoot, this.#now);
      }
      throw error;
    }
  }

  async start(options: RecordingStartOptions): Promise<RecordingSnapshot> {
    return await this.#request("start", options);
  }

  async pause(): Promise<RecordingSnapshot> {
    return await this.#request("pause");
  }

  async resume(): Promise<RecordingSnapshot> {
    return await this.#request("resume");
  }

  async stop(): Promise<RecordingSnapshot> {
    return await this.#request("stop");
  }

  async status(): Promise<RecordingSnapshot> {
    return await this.#request("status");
  }

  async close(): Promise<void> {
    // The daemon owns the helper across callers. Closing a client is a no-op.
  }
}

export function handleRecordingControlSocket(
  socket: Socket,
  dispatch: (request: ControlRequest) => Promise<ControlResponse>,
  nonce: string,
): void {
  socket.setEncoding("utf8");
  socket.setTimeout(DEFAULT_TIMEOUT_MS);
  let buffer = "";
  let handled = false;
  let claimed = false;
  const respond = (response: ControlResponse): void => {
    if (handled) return;
    const line = responseLine(response);
    handled = true;
    socket.end(line);
  };
  socket.on("data", (chunk: string) => {
    if (handled || claimed) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_CONTROL_LINE_BYTES) {
      respond({
        error: { code: "invalid-data", message: "Recording control request is oversized." },
        ok: false,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        requestId: "invalid",
      });
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    claimed = true;
    void (async () => {
      let requestId = "invalid";
      try {
        const request = parseRequest(buffer.slice(0, newline));
        requestId = request.requestId;
        if (request.nonce !== nonce) throw new CliError("conflict", "Recording control nonce does not match.");
        respond(await dispatch(request));
      } catch (error) {
        const failure = asCliError(error);
        respond({
          error: {
            code: failure.code,
            ...(failure.details === undefined ? {} : { details: failure.details }),
            message: failure.message,
          },
          ok: false,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          requestId,
        });
      }
    })();
  });
  socket.once("timeout", () => socket.destroy());
  socket.once("error", () => socket.destroy());
}

export function createSerializedRecordingDispatcher(
  controller: RecordingController,
  options: {
    readonly onControllerUnusable?: () => void;
  } = {},
): SerializedRecordingDispatcher {
  let tail = Promise.resolve();
  const completed = new Map<string, ControlResponse>();
  const inFlight = new Map<string, Promise<ControlResponse>>();
  let unusableFailure:
    | Extract<ControlResponse, { readonly ok: false }>["error"]
    | null = null;
  const remember = (
    requestId: string,
    response: ControlResponse,
  ): ControlResponse => {
    completed.set(requestId, response);
    if (completed.size > 1_024) {
      completed.delete(completed.keys().next().value!);
    }
    return response;
  };
  const unusableResponse = (
    requestId: string,
  ): Extract<ControlResponse, { readonly ok: false }> => {
    if (unusableFailure === null) {
      throw new CliError(
        "internal",
        "An unusable recording controller has no recovery failure.",
      );
    }
    return {
      error: unusableFailure,
      ok: false,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId,
    };
  };
  const dispatch = (async (request: ControlRequest) => {
    const prior = completed.get(request.requestId);
    if (prior !== undefined) return prior;
    const running = inFlight.get(request.requestId);
    if (running !== undefined) return await running;
    if (unusableFailure !== null) {
      return remember(
        request.requestId,
        unusableResponse(request.requestId),
      );
    }
    const operation = tail.then(async () => {
      // A request can be admitted while the preceding operation is still
      // discovering that the controller is unusable. Recheck at execution
      // time so no distinct queued action reaches that controller.
      if (unusableFailure !== null) {
        return unusableResponse(request.requestId);
      }
      try {
        const snapshot = await executeRecordingAction(controller, request.action, request.options);
        return {
          ok: true,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          requestId: request.requestId,
          snapshot,
        } satisfies ControlResponse;
      } catch (error) {
        const failure = asCliError(error);
        const response = {
          error: {
            code: failure.code,
            ...(failure.details === undefined ? {} : { details: failure.details }),
            message: failure.message,
          },
          ok: false,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          requestId: request.requestId,
        } satisfies ControlResponse;
        if (
          recoveryControllerReusable(failure.details) === false
          && unusableFailure === null
        ) {
          unusableFailure = response.error;
          options.onControllerUnusable?.();
        }
        return response;
      }
    });
    inFlight.set(request.requestId, operation);
    tail = operation.then(() => undefined, () => undefined);
    const response = await operation;
    inFlight.delete(request.requestId);
    return remember(request.requestId, response);
  }) as SerializedRecordingDispatcher;
  dispatch.drain = async () => {
    while (true) {
      const admitted = tail;
      await admitted;
      if (admitted === tail) return;
    }
  };
  return dispatch;
}

export interface RecordingDaemonOptions {
  readonly artifactRoot: string;
  readonly controller?: RecordingController;
  readonly helperExecutable: string;
  readonly now?: () => Date;
}

export async function runRecordingDaemon(options: RecordingDaemonOptions): Promise<void> {
  const now = options.now ?? (() => new Date());
  const paths = controlPaths(options.artifactRoot);
  await ensurePrivateDirectory(options.artifactRoot);
  const nonce = randomUUID();
  const controller = options.controller ?? new CaptureHelperRecordingController({
    artifactRoot: options.artifactRoot,
    executable: options.helperExecutable,
    io: { now },
  });
  await rm(paths.socket, { force: true });
  let server: Server | undefined;
  let serverClosed: Promise<void> | undefined;
  let retirementRequested = false;
  const dispatch = createSerializedRecordingDispatcher(controller, {
    onControllerUnusable: () => {
      if (retirementRequested) return;
      retirementRequested = true;
      server?.close();
    },
  });
  try {
    server = createServer((socket) => handleRecordingControlSocket(socket, dispatch, nonce));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(paths.socket, resolve);
    });
    serverClosed = new Promise<void>((resolve, reject) => {
      server!.once("close", resolve);
      server!.once("error", reject);
    });
    await chmod(paths.socket, 0o600);
    const metadata: ControlMetadata = {
      nonce,
      pid: process.pid,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      socketPath: paths.socket,
      startedAt: now().toISOString(),
      uid: currentUid(),
    };
    await atomicWrite(paths.metadata, metadata);
    await rm(paths.lock, { force: true, recursive: true });
    await serverClosed;
  } finally {
    if (server !== undefined) server.close();
    await dispatch.drain();
    await controller.close();
    await Promise.all([
      rm(paths.lock, { force: true, recursive: true }),
      rm(paths.metadata, { force: true }),
      rm(paths.socket, { force: true }),
    ]);
  }
}
