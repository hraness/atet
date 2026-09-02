import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPTURE_PROTOCOL_VERSION,
  CaptureDeviceSelectionSchema,
  CaptureDisplaySelectionSchema,
  CaptureInterruptionSchema,
  CapturePermissionsSchema,
  CaptureSourceInventorySchema,
  encodeCaptureRequest,
  parseCaptureEventLine,
  TypedTextFocusIdentitiesSchema,
  type CaptureEvent,
  type CaptureInterruption,
  type CaptureOptions,
  type CapturePermissions,
  type CaptureRequest,
  type CaptureSourceInventory,
  type SegmentCompletion,
} from "../capture/protocol";
import { asCliError, CliError, errorMessage } from "./errors";
import { environmentWithoutGatewayCredentials, type CliIo } from "./io";
import { CaptureBundleWriter, CaptureMediaVerifier } from "./capture-bundle";
import type { ProcessRunner } from "./io";
import { ensurePrivateDirectory } from "./paths";

export type RecordingDeviceSelection =
  | { readonly kind: "disabled" }
  | { readonly kind: "default" }
  | { readonly deviceId: string; readonly kind: "device" };

export type RecordingDisplaySelection =
  | { readonly kind: "all" }
  | { readonly displayIds: readonly string[]; readonly kind: "selected" };

export interface RecordingStartOptions {
  readonly camera: RecordingDeviceSelection;
  readonly displays: RecordingDisplaySelection;
  readonly interactionEventProcessIdentifier?: number | null;
  readonly microphone: RecordingDeviceSelection;
  readonly strictInputs: boolean;
  readonly systemAudio: boolean;
  readonly typedText: boolean;
  readonly typedTextFocusIdentities?: CaptureOptions["typedTextFocusIdentities"];
}

export interface EffectiveRecordingConfig extends RecordingStartOptions {
  readonly metadata: true;
}

export type RecordingPhase = "idle" | "recording" | "paused";

export interface RecordingSnapshot {
  readonly availableSources: CaptureSourceInventory;
  readonly completedSegmentCount: number;
  readonly effectiveConfig: EffectiveRecordingConfig | null;
  readonly lastInterruption: CaptureInterruption | null;
  readonly logicalTimeUs: number;
  readonly permissions: CapturePermissions | null;
  readonly recordingId: string | null;
  readonly recordingRoot: string | null;
  readonly sources: CaptureSourceInventory;
  readonly state: RecordingPhase;
  readonly updatedAt: string;
}

export interface RecordingController {
  close(): Promise<void>;
  pause(): Promise<RecordingSnapshot>;
  resume(): Promise<RecordingSnapshot>;
  start(options: RecordingStartOptions): Promise<RecordingSnapshot>;
  status(): Promise<RecordingSnapshot>;
  stop(): Promise<RecordingSnapshot>;
}

export interface CaptureTransport {
  close(): Promise<void>;
  readLine(timeoutMs: number): Promise<string>;
  stderrTail(): string;
  write(value: string): Promise<void>;
}

export interface CaptureTransportFactory {
  spawn(executable: string): Promise<CaptureTransport>;
}

type CaptureResponseEventName = Exclude<CaptureEvent["event"], "error" | "ready">;
type CaptureResponseSequence = readonly CaptureResponseEventName[];

const CAPTURE_RESPONSE_SEQUENCES: Readonly<
  Record<CaptureRequest["command"], readonly CaptureResponseSequence[]>
> = {
  configure: [["configured"]],
  pause: [["segment-completed"]],
  resume: [
    ["segment-started"],
    ["segment-completed", "segment-started"],
  ],
  shutdown: [
    ["shutdown"],
    ["session-completed", "shutdown"],
    ["segment-completed", "session-completed", "shutdown"],
  ],
  snapshot: [
    ["status"],
    ["segment-completed", "status"],
    ["session-completed", "status"],
    ["segment-completed", "session-completed", "status"],
  ],
  start: [["segment-started"]],
  status: [
    ["status"],
    ["segment-completed", "status"],
    ["session-completed", "status"],
    ["segment-completed", "session-completed", "status"],
  ],
  stop: [
    ["session-completed"],
    ["segment-completed", "session-completed"],
  ],
};
const MAX_FAILURE_RECOVERY_SOURCES_BYTES = 24 * 1024;

class NonFatalCaptureCommandError extends CliError {
  constructor(
    code: "conflict" | "unavailable",
    event: Extract<CaptureEvent, { readonly event: "error" }>,
  ) {
    super(
      code,
      `Capture helper ${event.code}: ${event.message}`,
      { helperCode: event.code, recoverable: true, state: event.state },
    );
    this.name = "NonFatalCaptureCommandError";
  }
}

interface CaptureResponseFrontier {
  readonly completedSegmentCount: number;
  readonly lastInterruption: CaptureInterruption | null;
  readonly logicalTimeUs: number;
  readonly priorSnapshotLogicalTimeUs: number;
  readonly sessionCompletionPersisted: boolean;
  readonly sources: CaptureSourceInventory;
}

function isCaptureResponsePrefix(
  sequence: CaptureResponseSequence,
  events: readonly CaptureEvent[],
): boolean {
  return events.every((event, index) => sequence[index] === event.event);
}

function captureResponseNames(events: readonly CaptureEvent[]): string {
  return events.map(({ event }) => event).join(" -> ");
}

function invalidCaptureResponse(
  request: CaptureRequest,
  events: readonly CaptureEvent[],
  detail?: string,
): CliError {
  const suffix = detail === undefined ? "" : ` ${detail}`;
  return new CliError(
    "invalid-data",
    `Capture helper emitted an invalid ${request.command} response sequence: ${captureResponseNames(events)}.${suffix}`,
  );
}

function segmentCompletionIn(
  events: readonly CaptureEvent[],
): Extract<CaptureEvent, { readonly event: "segment-completed" }> | undefined {
  return events.find((
    event,
  ): event is Extract<CaptureEvent, { readonly event: "segment-completed" }> => (
    event.event === "segment-completed"
  ));
}

function sessionCompletionIn(
  events: readonly CaptureEvent[],
): Extract<CaptureEvent, { readonly event: "session-completed" }> | undefined {
  return events.find((
    event,
  ): event is Extract<CaptureEvent, { readonly event: "session-completed" }> => (
    event.event === "session-completed"
  ));
}

function sameCaptureInterruption(
  left: CaptureInterruption | null,
  right: CaptureInterruption | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.code === right.code
    && left.nativeTimeUs === right.nativeTimeUs
    && left.recoverable === right.recoverable
    && left.segmentIndex === right.segmentIndex
    && left.source === right.source
    && left.sourceId === right.sourceId
    && left.sourceTimeUs === right.sourceTimeUs;
}

function sameCaptureSourceInventory(
  left: CaptureSourceInventory,
  right: CaptureSourceInventory,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectedSourcesIn(
  event: CaptureEvent,
): CaptureSourceInventory | undefined {
  if (
    event.event === "configured"
    || event.event === "segment-started"
    || event.event === "status"
  ) {
    return event.sources;
  }
  return event.event === "segment-completed"
    ? event.segment.sources
    : undefined;
}

function validateCaptureError(
  request: CaptureRequest,
  response: readonly CaptureEvent[],
  error: Extract<CaptureEvent, { readonly event: "error" }>,
  frontier: CaptureResponseFrontier,
): "new-frontier" | "none" | "persisted" {
  const interruption = error.interruption;
  if (interruption === null) return "none";
  if (request.command === "configure") {
    throw invalidCaptureResponse(
      request,
      [error],
      "Configure errors cannot carry segment interruption evidence.",
    );
  }
  if (sameCaptureInterruption(interruption, frontier.lastInterruption)) {
    return "persisted";
  }

  const completion = segmentCompletionIn(response);
  if (
    completion !== undefined
    && interruption.segmentIndex === completion.segment.index
  ) {
    if (
      completion.interruption === null
      || !sameCaptureInterruption(interruption, completion.interruption)
    ) {
      throw invalidCaptureResponse(
        request,
        [...response, error],
        "An error cannot replace same-segment completion interruption evidence.",
      );
    }
    return "persisted";
  }

  const completedCount = frontier.completedSegmentCount
    + (completion === undefined ? 0 : 1);
  const sourceFrontierUs = completion?.segment.clock.end.sourceTimeUs
    ?? frontier.logicalTimeUs;
  const nativeFrontierUs = completion?.segment.clock.end.nativeTimeUs ?? 0;
  if (
    interruption.segmentIndex !== completedCount
    || interruption.sourceTimeUs !== sourceFrontierUs
    || interruption.nativeTimeUs < nativeFrontierUs
  ) {
    throw invalidCaptureResponse(
      request,
      [...response, error],
      "An unmatched error interruption must identify the next segment and the persisted source-time frontier.",
    );
  }
  return "new-frontier";
}

function validateCaptureResponse(
  request: CaptureRequest,
  events: readonly CaptureEvent[],
  frontier: CaptureResponseFrontier,
): void {
  const segment = segmentCompletionIn(events);
  const session = sessionCompletionIn(events);
  if (frontier.sessionCompletionPersisted && session !== undefined) {
    throw invalidCaptureResponse(
      request,
      events,
      "A completed session may not emit session-completed again.",
    );
  }

  const responseSegmentCount = segment === undefined ? 0 : 1;
  const expectedCompletedSegmentCount = frontier.completedSegmentCount + responseSegmentCount;
  const expectedLogicalTimeUs = segment?.segment.clock.end.sourceTimeUs ?? frontier.logicalTimeUs;
  if (
    segment !== undefined
    && segment.segment.index !== frontier.completedSegmentCount
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Segment completion indices must advance from the persisted bundle frontier.",
    );
  }
  if (
    segment !== undefined
    && segment.segment.clock.start.sourceTimeUs !== frontier.logicalTimeUs
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Segment completion must begin at the persisted bundle frontier.",
    );
  }
  if (
    session !== undefined
    && (
      session.segmentCount !== expectedCompletedSegmentCount
      || session.durationUs !== expectedLogicalTimeUs
    )
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Session completion must equal the persisted bundle plus its optional segment completion.",
    );
  }

  if (request.command === "resume" || request.command === "start") {
    const started = events.find((
      event,
    ): event is Extract<CaptureEvent, { readonly event: "segment-started" }> => (
      event.event === "segment-started"
    ));
    if (
      started !== undefined
      && (
        started.index !== expectedCompletedSegmentCount
        || started.startUs !== expectedLogicalTimeUs
      )
    ) {
      throw invalidCaptureResponse(
        request,
        events,
        "A started segment must use the next index and begin at the completed bundle frontier.",
      );
    }
  }

  if (request.command !== "configure") {
    for (const event of events) {
      const selectedSources = selectedSourcesIn(event);
      if (
        selectedSources !== undefined
        && !(
          event.event === "segment-started"
          && (request.command === "start" || request.command === "resume")
        )
        && !sameCaptureSourceInventory(selectedSources, frontier.sources)
      ) {
        throw invalidCaptureResponse(
          request,
          events,
          "Completion and status events must retain the current selected capture sources.",
        );
      }
    }
  }

  if (request.command !== "snapshot" && request.command !== "status") return;
  const status = events.at(-1);
  if (status?.event !== "status") {
    throw invalidCaptureResponse(request, events, "The response did not end with status.");
  }
  if (
    status.state !== "recording"
    && status.state !== "paused"
    && status.state !== "stopped"
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "An active recording may report only recording, paused, or proven stopped status.",
    );
  }
  if (frontier.sessionCompletionPersisted && status.state !== "stopped") {
    throw invalidCaptureResponse(
      request,
      events,
      "A completed session may report only stopped status.",
    );
  }
  if (
    (status.state === "stopped" && session === undefined && !frontier.sessionCompletionPersisted)
    || (status.state !== "stopped" && session !== undefined)
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "A stopped status requires session-completed proof, and no other status may follow same-request completion.",
    );
  }
  if (segment !== undefined && session === undefined && status.state !== "paused") {
    throw invalidCaptureResponse(
      request,
      events,
      "A segment completion without session completion must reconcile to paused.",
    );
  }
  if (
    status.state === "paused"
    && (
      status.completedSegmentCount !== expectedCompletedSegmentCount
      || status.logicalTimeUs !== expectedLogicalTimeUs
    )
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Paused status counters must equal the persisted bundle plus its optional segment completion.",
    );
  }
  const expectedActiveSegmentIndex = status.state === "recording"
    ? expectedCompletedSegmentCount
    : null;
  if (status.activeSegmentIndex !== expectedActiveSegmentIndex) {
    throw invalidCaptureResponse(
      request,
      events,
      "Status activeSegmentIndex must match the capture frontier and lifecycle state.",
    );
  }
  const expectedLastInterruption = segment?.interruption
    ?? frontier.lastInterruption;
  if (
    !sameCaptureInterruption(
      status.lastInterruption,
      expectedLastInterruption,
    )
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Status lastInterruption must match the latest accepted interruption evidence.",
    );
  }
  if (
    status.state === "recording"
    && (
      status.completedSegmentCount !== frontier.completedSegmentCount
      || status.logicalTimeUs < frontier.logicalTimeUs
      || status.logicalTimeUs < frontier.priorSnapshotLogicalTimeUs
    )
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Recording status must preserve the persisted segment count and advance monotonically from both bundle and live frontiers.",
    );
  }
  if (
    status.state === "stopped"
    && (
      status.completedSegmentCount !== expectedCompletedSegmentCount
      || status.logicalTimeUs !== expectedLogicalTimeUs
    )
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Stopped status counters must equal the completed bundle frontier.",
    );
  }
  if (
    session !== undefined
    && (
      status.completedSegmentCount !== session.segmentCount
      || status.logicalTimeUs !== session.durationUs
    )
  ) {
    throw invalidCaptureResponse(
      request,
      events,
      "Status counters must match the preceding session completion.",
    );
  }
}

function spawnCaptureProcess(executable: string) {
  return Bun.spawn([executable], {
    env: environmentWithoutGatewayCredentials(process.env),
    stdin: "pipe" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  });
}

const CAPTURE_HELPER_GRACEFUL_EXIT_TIMEOUT_MS = 30_000;

class BunCaptureTransport implements CaptureTransport {
  readonly #child: ReturnType<typeof spawnCaptureProcess>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #closed = false;
  #stderr = "";

  constructor(executable: string) {
    this.#child = spawnCaptureProcess(executable);
    this.#reader = this.#child.stdout.getReader();
    void this.#collectStderr();
  }

  async #collectStderr(): Promise<void> {
    try {
      for await (const chunk of this.#child.stderr) {
        this.#stderr = `${this.#stderr}${new TextDecoder().decode(chunk)}`.slice(-16_384);
      }
    } catch {
      // The structured protocol remains authoritative; stderr is best-effort evidence.
    }
  }

  async readLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return line;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CliError("subprocess", "Capture helper response timed out.");
      const result = await Promise.race([
        this.#reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new CliError("subprocess", "Capture helper response timed out.")), remaining);
        }),
      ]);
      if (result.done) {
        throw new CliError(
          "subprocess",
          `Capture helper closed its protocol stream${this.#stderr === "" ? "." : `: ${this.#stderr.trim()}`}`,
        );
      }
      this.#buffer += this.#decoder.decode(result.value, { stream: true });
      if (new TextEncoder().encode(this.#buffer).byteLength > 64 * 1024) {
        throw new CliError("invalid-data", "Capture helper emitted an oversized protocol line.");
      }
    }
  }

  async write(value: string): Promise<void> {
    if (this.#closed) throw new CliError("conflict", "Capture helper transport is closed.");
    void this.#child.stdin.write(value);
    await this.#child.stdin.flush();
  }

  stderrTail(): string {
    return this.#stderr;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    void this.#child.stdin.end();
    try {
      await this.#reader.cancel();
    } catch {
      // Closing stdout lets a finalizing helper exit even when its terminal
      // events would otherwise fill the unread protocol pipe.
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      this.#child.exited.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), CAPTURE_HELPER_GRACEFUL_EXIT_TIMEOUT_MS);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (!exited) this.#child.kill();
  }
}

export class BunCaptureTransportFactory implements CaptureTransportFactory {
  spawn(executable: string): Promise<CaptureTransport> {
    return Promise.resolve(new BunCaptureTransport(executable));
  }
}

function emptyCaptureSourceInventory(): CaptureSourceInventory {
  return { audio: [], cameras: [], displays: [] };
}

function idleSnapshot(now: Date): RecordingSnapshot {
  return {
    availableSources: emptyCaptureSourceInventory(),
    completedSegmentCount: 0,
    effectiveConfig: null,
    lastInterruption: null,
    logicalTimeUs: 0,
    permissions: null,
    recordingId: null,
    recordingRoot: null,
    sources: emptyCaptureSourceInventory(),
    state: "idle",
    updatedAt: now.toISOString(),
  };
}

function activeStatePath(artifactRoot: string): string {
  return join(artifactRoot, ".active-recording.json");
}

function parseEffectiveConfig(value: unknown): EffectiveRecordingConfig | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("invalid-data", "Recording effective config is invalid.");
  }
  const config = value as Readonly<Record<string, unknown>>;
  const booleanField = (field: string): boolean => {
    const item = config[field];
    if (typeof item !== "boolean") {
      throw new CliError("invalid-data", `Recording effective config ${field} is invalid.`);
    }
    return item;
  };
  const metadata = booleanField("metadata");
  if (!metadata) throw new CliError("invalid-data", "Recording metadata cannot be disabled.");
  const rawProcessIdentifier = config.interactionEventProcessIdentifier;
  const interactionEventProcessIdentifier = rawProcessIdentifier === undefined
    ? undefined
    : rawProcessIdentifier === null
    ? null
    : (
        typeof rawProcessIdentifier === "number"
        && Number.isInteger(rawProcessIdentifier)
        && rawProcessIdentifier > 0
        && rawProcessIdentifier <= 2_147_483_647
      )
    ? rawProcessIdentifier
    : (() => {
        throw new CliError(
          "invalid-data",
          "Recording effective config interaction event process ID is invalid.",
        );
      })();
  const rawFocusIdentities = config.typedTextFocusIdentities;
  const parsedFocusIdentities = rawFocusIdentities === undefined
    ? undefined
    : TypedTextFocusIdentitiesSchema.nullable().safeParse(rawFocusIdentities);
  if (
    parsedFocusIdentities !== undefined
    && !parsedFocusIdentities.success
  ) {
    throw new CliError(
      "invalid-data",
      "Recording effective config typed-text focus identities are invalid.",
    );
  }
  const typedTextFocusIdentities = parsedFocusIdentities?.data;
  const parsedCamera = CaptureDeviceSelectionSchema.safeParse(config.camera);
  if (!parsedCamera.success) {
    throw new CliError("invalid-data", "Recording effective config camera selection is invalid.");
  }
  const parsedDisplays = CaptureDisplaySelectionSchema.safeParse(config.displays);
  if (!parsedDisplays.success) {
    throw new CliError("invalid-data", "Recording effective config display selection is invalid.");
  }
  const parsedMicrophone = CaptureDeviceSelectionSchema.safeParse(config.microphone);
  if (!parsedMicrophone.success) {
    throw new CliError("invalid-data", "Recording effective config microphone selection is invalid.");
  }
  return {
    camera: parsedCamera.data,
    displays: parsedDisplays.data,
    ...(interactionEventProcessIdentifier === undefined
      ? {}
      : { interactionEventProcessIdentifier }),
    metadata: true,
    microphone: parsedMicrophone.data,
    strictInputs: booleanField("strictInputs"),
    systemAudio: booleanField("systemAudio"),
    typedText: booleanField("typedText"),
    ...(typedTextFocusIdentities === undefined
      ? {}
      : {
          typedTextFocusIdentities: typedTextFocusIdentities === null
            ? null
            : typedTextFocusIdentities.map(identity => ({ ...identity })),
        }),
  };
}

export function parseRecordingSnapshot(value: unknown): RecordingSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("invalid-data", "Active recording state must be a JSON object.");
  }
  const state = value as Readonly<Record<string, unknown>>;
  if (state.state !== "idle" && state.state !== "recording" && state.state !== "paused") {
    throw new CliError("invalid-data", "Active recording state has an unknown phase.");
  }
  if (
    typeof state.completedSegmentCount !== "number"
    || !Number.isSafeInteger(state.completedSegmentCount)
    || state.completedSegmentCount < 0
    || typeof state.logicalTimeUs !== "number"
    || !Number.isSafeInteger(state.logicalTimeUs)
    || state.logicalTimeUs < 0
    || typeof state.updatedAt !== "string"
  ) {
    throw new CliError("invalid-data", "Active recording state has invalid counters or timestamp.");
  }
  const recordingId = state.recordingId;
  const recordingRoot = state.recordingRoot;
  const permissions = CapturePermissionsSchema.nullable().safeParse(
    state.permissions,
  );
  const sources = CaptureSourceInventorySchema.safeParse(state.sources);
  const availableSources = CaptureSourceInventorySchema.safeParse(
    state.availableSources,
  );
  const lastInterruption = CaptureInterruptionSchema.nullable().safeParse(
    state.lastInterruption,
  );
  if (
    (recordingId !== null && typeof recordingId !== "string")
    || (recordingRoot !== null && typeof recordingRoot !== "string")
    || !permissions.success
    || !sources.success
    || !availableSources.success
    || !lastInterruption.success
  ) {
    throw new CliError(
      "invalid-data",
      "Active recording state has invalid identity, permissions, sources, or interruption evidence.",
    );
  }
  return {
    availableSources: availableSources.data,
    completedSegmentCount: state.completedSegmentCount,
    effectiveConfig: parseEffectiveConfig(state.effectiveConfig),
    lastInterruption: lastInterruption.data,
    logicalTimeUs: state.logicalTimeUs,
    permissions: permissions.data,
    recordingId,
    recordingRoot,
    sources: sources.data,
    state: state.state,
    updatedAt: state.updatedAt,
  };
}

export async function readRepositoryRecordingState(
  artifactRoot: string,
  now: () => Date = () => new Date(),
): Promise<RecordingSnapshot> {
  try {
    const bytes = await readFile(activeStatePath(artifactRoot), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw new CliError("invalid-data", "Active recording state is not valid JSON.");
    }
    return parseRecordingSnapshot(value);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return idleSnapshot(now());
    throw error;
  }
}

async function writeRepositoryRecordingState(
  artifactRoot: string,
  snapshot: RecordingSnapshot,
): Promise<void> {
  await ensurePrivateDirectory(artifactRoot);
  const destination = activeStatePath(artifactRoot);
  try {
    if ((await lstat(destination)).isSymbolicLink()) {
      throw new CliError("unsafe-path", `Active recording state is a symlink: ${destination}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = join(artifactRoot, `.active-recording.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function permissionsFrom(event: Extract<
  CaptureEvent,
  { readonly event: "configured" | "segment-started" | "status" }
>): CapturePermissions {
  return { ...event.permissions };
}

function notifyCaptureObserver(
  observer: ((event: CaptureEvent) => void) | undefined,
  event: CaptureEvent,
): void {
  if (observer === undefined) return;
  try {
    // Observers receive evidence, not authority over the controller's parsed
    // protocol object. Their diagnostics must not fail or mutate capture.
    observer(structuredClone(event));
  } catch {
    // Capture remains authoritative when optional observation fails.
  }
}

export interface CaptureHelperRecordingControllerOptions {
  readonly artifactRoot: string;
  readonly executable: string;
  readonly io: Pick<CliIo, "now">;
  readonly onCaptureEvent?: (event: CaptureEvent) => void;
  readonly requestTimeoutMs?: number;
  readonly ffprobeExecutable?: string;
  readonly runner?: ProcessRunner;
  readonly transportFactory?: CaptureTransportFactory;
}

interface FailedSegmentCompletion {
  readonly failure: unknown;
  readonly interruption: CaptureInterruption | null;
  readonly segment: SegmentCompletion;
}

export class CaptureHelperRecordingController implements RecordingController {
  readonly #artifactRoot: string;
  readonly #executable: string;
  readonly #now: () => Date;
  readonly #onCaptureEvent: ((event: CaptureEvent) => void) | undefined;
  readonly #requestTimeoutMs: number;
  readonly #transportFactory: CaptureTransportFactory;
  #transport: CaptureTransport | undefined;
  #bundleWriter: CaptureBundleWriter | undefined;
  #snapshot: RecordingSnapshot;
  #effectiveConfig: EffectiveRecordingConfig | null = null;
  #closed = false;
  #requestCounter = 0;
  #helperVersion = "unknown";
  #sessionCompletionPersisted = false;
  #failedSegmentCompletion: FailedSegmentCompletion | undefined;
  #pendingFailureInterruption: CaptureInterruption | undefined;
  readonly #verifier: CaptureMediaVerifier;

  constructor(options: CaptureHelperRecordingControllerOptions) {
    this.#artifactRoot = options.artifactRoot;
    this.#executable = options.executable;
    this.#now = options.io.now;
    this.#onCaptureEvent = options.onCaptureEvent;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 240_000;
    this.#transportFactory = options.transportFactory ?? new BunCaptureTransportFactory();
    this.#verifier = new CaptureMediaVerifier({
      ...(options.ffprobeExecutable === undefined ? {} : { ffprobe: options.ffprobeExecutable }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    this.#snapshot = idleSnapshot(this.#now());
  }

  async #ensureTransport(): Promise<CaptureTransport> {
    if (this.#closed) throw new CliError("conflict", "Recording controller is closed.");
    if (this.#transport !== undefined) return this.#transport;
    try {
      if (!(await stat(this.#executable)).isFile()) {
        throw new CliError("unavailable", `Capture helper is not a file: ${this.#executable}`);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        "unavailable",
        `Capture helper is unavailable at ${this.#executable}. Run: bun run build:desktop:capture:macos`,
      );
    }
    const transport = await this.#transportFactory.spawn(this.#executable);
    this.#transport = transport;
    const ready = parseCaptureEventLine(await transport.readLine(this.#requestTimeoutMs));
    notifyCaptureObserver(this.#onCaptureEvent, ready);
    if (ready.event !== "ready") {
      await transport.close();
      this.#transport = undefined;
      throw new CliError("invalid-data", `Capture helper emitted ${ready.event} before ready.`);
    }
    this.#helperVersion = ready.helperVersion;
    return transport;
  }

  #requestId(command: string): string {
    this.#requestCounter += 1;
    return `cli:${command}:${this.#requestCounter}`;
  }

  async #settleSessionFailure(error: unknown): Promise<never> {
    const failedRecordingId = this.#snapshot.recordingId ?? this.#bundleWriter?.manifest.recordingId ?? null;
    const failedRecordingRoot = this.#snapshot.recordingRoot;
    const pendingFailureInterruption = this.#pendingFailureInterruption;
    const failedLastInterruption =
      pendingFailureInterruption ?? this.#snapshot.lastInterruption;
    const failedSources = structuredClone(this.#snapshot.sources);
    const includeFailedSources = Buffer.byteLength(
      JSON.stringify(failedSources),
    ) <= MAX_FAILURE_RECOVERY_SOURCES_BYTES;
    const failedSnapshot = {
      lastInterruption: failedLastInterruption === null
        ? null
        : structuredClone(failedLastInterruption),
      logicalTimeUs: this.#snapshot.logicalTimeUs,
      permissions: this.#snapshot.permissions === null
        ? null
        : structuredClone(this.#snapshot.permissions),
      ...(includeFailedSources ? { sources: failedSources } : {}),
    } as const;
    const recoveryErrors: string[] = [];
    const failedSegmentCompletion = this.#failedSegmentCompletion;
    let failedSegmentCompletionPersisted = failedSegmentCompletion === undefined;
    const persistFailedSegmentCompletion = async (
      errorPrefix: "completion frontier: " | "completion frontier retry: ",
    ): Promise<void> => {
      if (
        failedSegmentCompletion === undefined
        || this.#bundleWriter === undefined
      ) return;
      try {
        await this.#bundleWriter.recordFailedSegmentCompletion(
          failedSegmentCompletion.segment,
          failedSegmentCompletion.interruption,
          failedSegmentCompletion.failure,
        );
        failedSegmentCompletionPersisted = true;
        for (let index = recoveryErrors.length - 1; index >= 0; index -= 1) {
          if (recoveryErrors[index]?.startsWith("completion frontier")) {
            recoveryErrors.splice(index, 1);
          }
        }
      } catch (persistenceError) {
        recoveryErrors.push(`${errorPrefix}${errorMessage(persistenceError)}`);
      }
    };
    await persistFailedSegmentCompletion("completion frontier: ");
    let pendingFailureInterruptionPersisted =
      pendingFailureInterruption === undefined;
    const persistPendingFailureInterruption = async (
      errorPrefix: "failure interruption: " | "failure interruption retry: ",
    ): Promise<void> => {
      if (
        pendingFailureInterruption === undefined
        || this.#bundleWriter === undefined
      ) return;
      try {
        await this.#bundleWriter.recordFailureInterruption(
          pendingFailureInterruption,
        );
        pendingFailureInterruptionPersisted = true;
        for (let index = recoveryErrors.length - 1; index >= 0; index -= 1) {
          if (recoveryErrors[index]?.startsWith("failure interruption")) {
            recoveryErrors.splice(index, 1);
          }
        }
      } catch (persistenceError) {
        recoveryErrors.push(`${errorPrefix}${errorMessage(persistenceError)}`);
      }
    };
    await persistPendingFailureInterruption("failure interruption: ");
    let terminalManifestState: "failed" | "stopped" | "unsettled" = this.#sessionCompletionPersisted
      ? "stopped"
      : "unsettled";

    if (this.#bundleWriter !== undefined && !this.#sessionCompletionPersisted) {
      const durationUs = this.#bundleWriter.manifest.timeline.durationUs;
      try {
        await this.#bundleWriter.setState("failed", durationUs);
        terminalManifestState = "failed";
      } catch (settlementError) {
        recoveryErrors.push(`manifest: ${errorMessage(settlementError)}`);
      }
    }

    const transport = this.#transport;
    this.#transport = undefined;
    if (transport !== undefined) {
      try {
        await transport.close();
      } catch (transportError) {
        recoveryErrors.push(`helper: ${errorMessage(transportError)}`);
      }
    }

    if (!failedSegmentCompletionPersisted) {
      await persistFailedSegmentCompletion("completion frontier retry: ");
    }
    if (!pendingFailureInterruptionPersisted) {
      await persistPendingFailureInterruption("failure interruption retry: ");
    }

    if (terminalManifestState === "unsettled" && this.#bundleWriter !== undefined) {
      try {
        await this.#bundleWriter.setState(
          "failed",
          this.#bundleWriter.manifest.timeline.durationUs,
        );
        terminalManifestState = "failed";
        const manifestFailureIndex = recoveryErrors.findIndex((item) => item.startsWith("manifest: "));
        if (manifestFailureIndex !== -1) recoveryErrors.splice(manifestFailureIndex, 1);
      } catch (settlementError) {
        const message = `manifest retry: ${errorMessage(settlementError)}`;
        if (!recoveryErrors.includes(message)) recoveryErrors.push(message);
      }
    }

    try {
      await rm(activeStatePath(this.#artifactRoot), { force: true });
    } catch (activeStateError) {
      recoveryErrors.push(`active state: ${errorMessage(activeStateError)}`);
    }

    this.#bundleWriter = undefined;
    this.#effectiveConfig = null;
    this.#failedSegmentCompletion = undefined;
    this.#pendingFailureInterruption = undefined;
    this.#sessionCompletionPersisted = false;
    this.#snapshot = idleSnapshot(this.#now());
    if (recoveryErrors.length > 0) this.#closed = true;

    const failure = asCliError(error);
    const recovery = {
      controllerReusable: recoveryErrors.length === 0,
      recordingId: failedRecordingId,
      recordingRoot: failedRecordingRoot,
      snapshot: failedSnapshot,
      terminalManifestState,
    } as const;
    if (recoveryErrors.length > 0) {
      throw new CliError(
        "internal",
        `${failure.message} Capture recovery was incomplete: ${recoveryErrors.join("; ")}`,
        {
          captureFailure: { code: failure.code, details: failure.details ?? null },
          recovery,
          recoveryErrors,
        },
      );
    }
    throw new CliError(failure.code, failure.message, {
      ...(failure.details ?? {}),
      recovery,
    });
  }

  async #discardUninitializedSession(recordingRoot: string, error: unknown): Promise<never> {
    const recoveryErrors: string[] = [];
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport !== undefined) {
      try {
        await transport.close();
      } catch (transportError) {
        recoveryErrors.push(`helper: ${errorMessage(transportError)}`);
      }
    }
    try {
      await rm(recordingRoot, { force: true, recursive: true });
      await rm(activeStatePath(this.#artifactRoot), { force: true });
    } catch (cleanupError) {
      recoveryErrors.push(`recording cleanup: ${errorMessage(cleanupError)}`);
    }
    this.#bundleWriter = undefined;
    this.#effectiveConfig = null;
    this.#failedSegmentCompletion = undefined;
    this.#pendingFailureInterruption = undefined;
    this.#sessionCompletionPersisted = false;
    this.#snapshot = idleSnapshot(this.#now());
    if (recoveryErrors.length > 0) this.#closed = true;

    const failure = asCliError(error);
    if (recoveryErrors.length > 0) {
      throw new CliError(
        "internal",
        `${failure.message} Capture recovery was incomplete: ${recoveryErrors.join("; ")}`,
        { captureFailure: { code: failure.code, details: failure.details ?? null }, recoveryErrors },
      );
    }
    throw failure;
  }

  async #runSessionMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof NonFatalCaptureCommandError) throw error;
      return await this.#settleSessionFailure(error);
    }
  }

  #responseFrontier(): CaptureResponseFrontier {
    const manifest = this.#bundleWriter?.manifest;
    return {
      completedSegmentCount:
        manifest?.timeline.nativeClock.segments.length
        ?? this.#snapshot.completedSegmentCount,
      lastInterruption: this.#snapshot.lastInterruption,
      logicalTimeUs: manifest?.timeline.durationUs ?? this.#snapshot.logicalTimeUs,
      priorSnapshotLogicalTimeUs: this.#snapshot.logicalTimeUs,
      sessionCompletionPersisted: this.#sessionCompletionPersisted,
      sources: this.#snapshot.sources,
    };
  }

  async #applyResponseEvent(event: CaptureEvent): Promise<void> {
    if (event.event === "segment-completed") {
      try {
        await this.#bundleWriter?.appendSegment(
          event.segment,
          event.interruption,
        );
      } catch (failure) {
        this.#failedSegmentCompletion = {
          failure,
          interruption: event.interruption,
          segment: event.segment,
        };
        this.#snapshot = {
          ...this.#snapshot,
          completedSegmentCount: this.#snapshot.completedSegmentCount + 1,
          lastInterruption:
            event.interruption ?? this.#snapshot.lastInterruption,
          logicalTimeUs: Math.max(
            this.#snapshot.logicalTimeUs,
            event.segment.clock.end.sourceTimeUs,
          ),
          updatedAt: this.#now().toISOString(),
        };
        throw failure;
      }
      this.#snapshot = {
        ...this.#snapshot,
        completedSegmentCount: this.#snapshot.completedSegmentCount + 1,
        lastInterruption:
          event.interruption ?? this.#snapshot.lastInterruption,
        logicalTimeUs: Math.max(
          this.#snapshot.logicalTimeUs,
          event.segment.clock.end.sourceTimeUs,
        ),
        updatedAt: this.#now().toISOString(),
      };
    }
    if (event.event === "session-completed") {
      if (this.#bundleWriter === undefined) {
        throw new CliError("internal", "Capture helper completed a session without an initialized recording bundle.");
      }
      await this.#bundleWriter.setState("stopped", event.durationUs);
      this.#sessionCompletionPersisted = true;
      this.#snapshot = {
        ...this.#snapshot,
        completedSegmentCount: event.segmentCount,
        logicalTimeUs: event.durationUs,
        state: "idle",
        updatedAt: this.#now().toISOString(),
      };
    }
  }

  async #send(request: CaptureRequest): Promise<CaptureEvent> {
    const transport = await this.#ensureTransport();
    await transport.write(encodeCaptureRequest(request));
    const response: CaptureEvent[] = [];
    const sequences = CAPTURE_RESPONSE_SEQUENCES[request.command];
    const frontier = this.#responseFrontier();
    while (true) {
      const event = parseCaptureEventLine(await transport.readLine(this.#requestTimeoutMs));
      if (!("requestId" in event) || event.requestId !== request.requestId) {
        throw new CliError(
          "invalid-data",
          `Capture helper response ID ${
            "requestId" in event ? event.requestId : "<missing>"
          } did not match ${request.requestId}.`,
        );
      }
      notifyCaptureObserver(this.#onCaptureEvent, event);
      if (event.event === "error") {
        const mayFollowDeferredResumeCompletion = (
          request.command === "resume"
          && response.length === 1
          && response[0]?.event === "segment-completed"
        );
        if (response.length > 0 && !mayFollowDeferredResumeCompletion) {
          throw invalidCaptureResponse(
            request,
            [...response, event],
            "Errors may not follow completion evidence.",
          );
        }
        const completedResponse = [...response, event];
        const interruptionDisposition = validateCaptureError(
          request,
          response,
          event,
          frontier,
        );
        if (response.length > 0) {
          validateCaptureResponse(request, completedResponse, frontier);
        }
        const nominallyNonFatal = event.recoverable
          && (request.command === "resume" || event.code === "invalid-state");
        const nonFatal = nominallyNonFatal
          && interruptionDisposition !== "new-frontier";
        if (!nonFatal && event.interruption !== null) {
          this.#pendingFailureInterruption = event.interruption;
        }
        for (const acceptedEvent of response) {
          await this.#applyResponseEvent(acceptedEvent);
        }
        if (event.interruption !== null) {
          this.#snapshot = {
            ...this.#snapshot,
            lastInterruption: event.interruption,
            updatedAt: this.#now().toISOString(),
          };
        }
        if (
          event.interruption !== null
          && this.#bundleWriter !== undefined
        ) {
          const alreadyPersisted = this.#bundleWriter.manifest.interruptions
            .some(candidate =>
              sameCaptureInterruption(candidate, event.interruption)
            );
          if (nonFatal && !alreadyPersisted) {
            throw invalidCaptureResponse(
              request,
              completedResponse,
              "A recoverable error cannot introduce interruption evidence that was not persisted by completion.",
            );
          }
          if (!nonFatal) {
            await this.#bundleWriter.recordFailureInterruption(
              event.interruption,
            );
          }
        }
        if (request.command === "resume" && nonFatal && event.state === "paused") {
          if (this.#bundleWriter === undefined) {
            throw new CliError("internal", "Capture helper rejected resume without a recording bundle.");
          }
          this.#snapshot = {
            ...this.#snapshot,
            state: "paused",
            updatedAt: this.#now().toISOString(),
          };
          await this.#bundleWriter.setState("paused", this.#snapshot.logicalTimeUs);
          await writeRepositoryRecordingState(this.#artifactRoot, this.#snapshot);
        } else if (
          nonFatal
          && this.#snapshot.recordingId !== null
        ) {
          await writeRepositoryRecordingState(
            this.#artifactRoot,
            this.#snapshot,
          );
        }
        if (nonFatal) {
          throw new NonFatalCaptureCommandError(
            event.code === "invalid-state" ? "conflict" : "unavailable",
            event,
          );
        }
        throw new CliError(
          event.recoverable ? "unavailable" : "subprocess",
          `Capture helper ${event.code}: ${event.message}`,
          {
            helperCode: event.code,
            interruption: event.interruption,
            recoverable: event.recoverable,
            state: event.state,
          },
        );
      }
      response.push(event);
      const candidates = sequences.filter(sequence => isCaptureResponsePrefix(sequence, response));
      if (candidates.length === 0) {
        throw invalidCaptureResponse(request, response);
      }
      const complete = candidates.find(sequence => sequence.length === response.length);
      if (complete !== undefined) {
        validateCaptureResponse(request, response, frontier);
        for (const acceptedEvent of response) {
          await this.#applyResponseEvent(acceptedEvent);
        }
        return event;
      }
    }
  }

  async start(options: RecordingStartOptions): Promise<RecordingSnapshot> {
    if (this.#snapshot.state !== "idle") {
      throw new CliError("conflict", `Cannot start while recording is ${this.#snapshot.state}.`);
    }
    const recordingId = `rec_${this.#now().toISOString().replaceAll(/[-:.TZ]/gu, "")}_${randomUUID().slice(0, 8)}`;
    const recordingRoot = join(this.#artifactRoot, recordingId);
    this.#bundleWriter = undefined;
    this.#effectiveConfig = null;
    this.#failedSegmentCompletion = undefined;
    this.#pendingFailureInterruption = undefined;
    this.#sessionCompletionPersisted = false;
    await ensurePrivateDirectory(this.#artifactRoot);
    await mkdir(recordingRoot, { mode: 0o700, recursive: false });
    const effectiveConfig: EffectiveRecordingConfig = { ...options, metadata: true };
    const captureOptions: CaptureOptions = {
      camera: { ...options.camera },
      displays: options.displays.kind === "all"
        ? { kind: "all" }
        : { displayIds: [...options.displays.displayIds], kind: "selected" },
      excludedBundleIdentifiers: ["com.hraness.atet"],
      interactionEventProcessIdentifier:
        options.interactionEventProcessIdentifier ?? null,
      metadata: true,
      microphone: { ...options.microphone },
      strictSources: options.strictInputs,
      systemAudio: options.systemAudio,
      typedText: options.typedText,
      typedTextFocusIdentities:
        options.typedTextFocusIdentities === undefined
        || options.typedTextFocusIdentities === null
          ? null
          : options.typedTextFocusIdentities.map(identity => ({ ...identity })),
    };
    try {
      const configured = await this.#send({
        command: "configure",
        options: captureOptions,
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: this.#requestId("configure"),
        sessionDirectory: recordingRoot,
      });
      if (configured.event !== "configured") {
        throw new CliError("invalid-data", "Capture helper did not acknowledge configuration.");
      }
      this.#effectiveConfig = effectiveConfig;
      this.#bundleWriter = new CaptureBundleWriter({
        bundleRoot: recordingRoot,
        captureOptions,
        configured,
        helperVersion: this.#helperVersion,
        now: this.#now,
        recordingId,
        toolVersion: "3.2.0",
        verifier: this.#verifier,
      });
      await this.#bundleWriter.initialize();
      this.#snapshot = {
        availableSources: configured.availableSources,
        completedSegmentCount: 0,
        effectiveConfig,
        lastInterruption: configured.lastInterruption,
        logicalTimeUs: 0,
        permissions: permissionsFrom(configured),
        recordingId,
        recordingRoot,
        sources: configured.sources,
        state: "paused",
        updatedAt: this.#now().toISOString(),
      };
      const started = await this.#send({
        command: "start",
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: this.#requestId("start"),
      });
      if (started.event !== "segment-started") {
        throw new CliError("invalid-data", "Capture helper did not start a segment.");
      }
      await this.#bundleWriter.setCaptureEnvironment(
        started.permissions,
        started.sources,
      );
      this.#snapshot = {
        ...this.#snapshot,
        logicalTimeUs: started.startUs,
        permissions: permissionsFrom(started),
        sources: started.sources,
        state: "recording",
        updatedAt: this.#now().toISOString(),
      };
      await this.#bundleWriter.setState("recording", started.startUs);
      await writeRepositoryRecordingState(this.#artifactRoot, this.#snapshot);
      return this.#snapshot;
    } catch (error) {
      if (this.#bundleWriter === undefined) {
        return await this.#discardUninitializedSession(recordingRoot, error);
      }
      return await this.#settleSessionFailure(error);
    }
  }

  async pause(): Promise<RecordingSnapshot> {
    if (this.#snapshot.state !== "recording") {
      throw new CliError("conflict", `Cannot pause while recording is ${this.#snapshot.state}.`);
    }
    return await this.#runSessionMutation(async () => {
      const completed = await this.#send({
        command: "pause",
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: this.#requestId("pause"),
      });
      if (completed.event !== "segment-completed") {
        throw new CliError("invalid-data", "Capture helper did not complete the active segment.");
      }
      this.#snapshot = { ...this.#snapshot, state: "paused", updatedAt: this.#now().toISOString() };
      await this.#bundleWriter?.setState("paused", this.#snapshot.logicalTimeUs);
      await writeRepositoryRecordingState(this.#artifactRoot, this.#snapshot);
      return this.#snapshot;
    });
  }

  async resume(): Promise<RecordingSnapshot> {
    if (this.#snapshot.state === "idle" || this.#snapshot.recordingId === null) {
      throw new CliError("conflict", `Cannot resume while recording is ${this.#snapshot.state}.`);
    }
    return await this.#runSessionMutation(async () => {
      const started = await this.#send({
        command: "resume",
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: this.#requestId("resume"),
      });
      if (started.event !== "segment-started") {
        throw new CliError("invalid-data", "Capture helper did not resume capture.");
      }
      await this.#bundleWriter?.setCaptureEnvironment(
        started.permissions,
        started.sources,
      );
      this.#snapshot = {
        ...this.#snapshot,
        logicalTimeUs: started.startUs,
        permissions: permissionsFrom(started),
        sources: started.sources,
        state: "recording",
        updatedAt: this.#now().toISOString(),
      };
      await this.#bundleWriter?.setState("recording", this.#snapshot.logicalTimeUs);
      await writeRepositoryRecordingState(this.#artifactRoot, this.#snapshot);
      return this.#snapshot;
    });
  }

  async status(): Promise<RecordingSnapshot> {
    if (this.#transport === undefined) {
      this.#snapshot = await readRepositoryRecordingState(this.#artifactRoot, this.#now);
      return this.#snapshot;
    }
    return await this.#runSessionMutation(async () => {
      const status = await this.#send({
        command: "status",
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: this.#requestId("status"),
      });
      if (status.event !== "status") throw new CliError("invalid-data", "Capture helper omitted status.");
      const state = status.state === "recording" ? "recording" : status.state === "paused" ? "paused" : "idle";
      if (status.state === "paused" || status.state === "stopped") {
        if (this.#bundleWriter === undefined) {
          throw new CliError("internal", `Capture helper reported ${status.state} without a recording bundle.`);
        }
        await this.#bundleWriter.setState(status.state, status.logicalTimeUs);
      }
      this.#snapshot = {
        ...this.#snapshot,
        availableSources: status.availableSources,
        completedSegmentCount: status.completedSegmentCount,
        effectiveConfig: state === "idle" ? null : this.#effectiveConfig,
        lastInterruption: status.lastInterruption,
        logicalTimeUs: status.logicalTimeUs,
        permissions: permissionsFrom(status),
        recordingId: state === "idle" ? null : this.#snapshot.recordingId,
        recordingRoot: state === "idle" ? null : this.#snapshot.recordingRoot,
        sources: status.sources,
        state,
        updatedAt: this.#now().toISOString(),
      };
      await writeRepositoryRecordingState(this.#artifactRoot, this.#snapshot);
      return this.#snapshot;
    });
  }

  async stop(): Promise<RecordingSnapshot> {
    if (this.#snapshot.state === "idle") throw new CliError("conflict", "No recording is active.");
    return await this.#runSessionMutation(async () => {
      const completed = await this.#send({
        command: "stop",
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: this.#requestId("stop"),
      });
      if (completed.event !== "session-completed") {
        throw new CliError("invalid-data", "Capture helper did not complete the session.");
      }
      const stopped: RecordingSnapshot = {
        ...this.#snapshot,
        completedSegmentCount: completed.segmentCount,
        logicalTimeUs: completed.durationUs,
        state: "idle",
        updatedAt: this.#now().toISOString(),
      };
      this.#snapshot = stopped;
      await rm(activeStatePath(this.#artifactRoot), { force: true });
      return stopped;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const transport = this.#transport;
    if (transport === undefined) {
      this.#closed = true;
      return;
    }
    try {
      try {
        const sessionNeedsCompletion = this.#bundleWriter !== undefined && !this.#sessionCompletionPersisted;
        const event = await this.#send({
          command: "shutdown",
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: this.#requestId("shutdown"),
        });
        if (event.event !== "shutdown") {
          throw new CliError("invalid-data", `Capture helper emitted ${event.event} while shutting down.`);
        }
        if (sessionNeedsCompletion && !this.#sessionCompletionPersisted) {
          throw new CliError("invalid-data", "Capture helper shut down without completing the active session.");
        }
        if (this.#sessionCompletionPersisted) {
          await rm(activeStatePath(this.#artifactRoot), { force: true });
        }
      } catch (error) {
        return await this.#settleSessionFailure(error);
      }
    } finally {
      this.#closed = true;
      this.#transport = undefined;
      await transport.close();
    }
  }
}

export async function executeRecordingAction(
  controller: RecordingController,
  action: "start" | "pause" | "resume" | "stop" | "status",
  options?: RecordingStartOptions,
): Promise<RecordingSnapshot> {
  switch (action) {
    case "start":
      if (options === undefined) throw new CliError("internal", "Start options are missing.");
      return await controller.start(options);
    case "pause": return await controller.pause();
    case "resume": return await controller.resume();
    case "stop": return await controller.stop();
    case "status": return await controller.status();
  }
}
