import { z } from "zod";

import {
  TypedTextFocusIdentitySchema,
  type TypedTextFocusIdentity,
} from "./protocol";

export const INTERACTION_FIXTURE_PROTOCOL_VERSION = 1 as const;
export const INTERACTION_FIXTURE_PUBLIC_FIELD_ID_PREFIX =
  "transmute-fixture-public-" as const;
export const INTERACTION_FIXTURE_TIMEOUT_MS = 15_000;

const MAXIMUM_FIXTURE_LINE_BYTES = 64 * 1024;
const FIXTURE_SHUTDOWN_TIMEOUT_MS = 5_000;
const FixtureIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);
const NativeTimeSchema = z.number().int().safe().positive();
const CoordinateSchema = z.number().finite();
const PointSchema = z.strictObject({
  x: CoordinateSchema,
  y: CoordinateSchema,
});
const BoundsSchema = z.strictObject({
  height: CoordinateSchema.positive(),
  width: CoordinateSchema.positive(),
  x: CoordinateSchema,
  y: CoordinateSchema,
});
const FixturePhaseSchema = z.strictObject({
  attemptedKeyPairs: z.literal(1),
  bounds: BoundsSchema,
  clickPoint: PointSchema,
  completedNativeTimeUs: NativeTimeSchema,
  focusConfirmedNativeTimeUs: NativeTimeSchema,
  inputStartedNativeTimeUs: NativeTimeSchema,
  valueMatches: z.literal(true),
}).superRefine((phase, context) => {
  if (
    phase.focusConfirmedNativeTimeUs >= phase.inputStartedNativeTimeUs
    || phase.inputStartedNativeTimeUs >= phase.completedNativeTimeUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Fixture phase timestamps must increase strictly.",
    });
  }
  const right = phase.bounds.x + phase.bounds.width;
  const bottom = phase.bounds.y + phase.bounds.height;
  if (
    phase.clickPoint.x < phase.bounds.x
    || phase.clickPoint.x > right
    || phase.clickPoint.y < phase.bounds.y
    || phase.clickPoint.y > bottom
  ) {
    context.addIssue({
      code: "custom",
      message: "Fixture click point must lie inside its reported bounds.",
    });
  }
});

const FixtureReadySchema = z.strictObject({
  event: z.literal("ready"),
  fixtureId: FixtureIdSchema,
  fixtureProtocolVersion: z.literal(INTERACTION_FIXTURE_PROTOCOL_VERSION),
  nativeTimeUs: NativeTimeSchema,
  publicFocusIdentity: TypedTextFocusIdentitySchema,
});

export const InteractionFixtureReceiptSchema = z.strictObject({
  completedNativeTimeUs: NativeTimeSchema,
  event: z.literal("completed"),
  fixtureId: FixtureIdSchema,
  fixtureProtocolVersion: z.literal(INTERACTION_FIXTURE_PROTOCOL_VERSION),
  neutralFocusConfirmedNativeTimeUs: NativeTimeSchema,
  publicAfter: FixturePhaseSchema,
  publicBefore: FixturePhaseSchema,
  publicFocusIdentity: TypedTextFocusIdentitySchema,
  requestId: z.literal("exercise"),
  secure: FixturePhaseSchema,
}).superRefine((receipt, context) => {
  if (
    receipt.publicFocusIdentity.fieldId
      !== interactionFixturePublicFieldId(receipt.fixtureId)
    || receipt.publicFocusIdentity.windowTitle
      !== interactionFixtureWindowTitle(receipt.fixtureId)
  ) {
    context.addIssue({
      code: "custom",
      message: "Fixture receipt focus identity must derive from its nonce.",
    });
  }
  if (
    receipt.publicBefore.completedNativeTimeUs
      >= receipt.secure.focusConfirmedNativeTimeUs
    || receipt.secure.completedNativeTimeUs
      >= receipt.publicAfter.focusConfirmedNativeTimeUs
    || receipt.publicAfter.completedNativeTimeUs
      >= receipt.neutralFocusConfirmedNativeTimeUs
    || receipt.neutralFocusConfirmedNativeTimeUs
      >= receipt.completedNativeTimeUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Fixture receipt phases must be ordered and non-overlapping.",
    });
  }
});

const FixtureShutdownSchema = z.strictObject({
  event: z.literal("shutdown"),
  fixtureId: FixtureIdSchema,
  fixtureProtocolVersion: z.literal(INTERACTION_FIXTURE_PROTOCOL_VERSION),
  requestId: z.literal("shutdown"),
});

const FixtureErrorSchema = z.strictObject({
  code: z.string().min(1).max(128),
  event: z.literal("error"),
  fixtureId: FixtureIdSchema,
  fixtureProtocolVersion: z.literal(INTERACTION_FIXTURE_PROTOCOL_VERSION),
  message: z.string().min(1).max(2_048),
  requestId: z.enum(["exercise", "shutdown"]).nullable(),
});

const FixtureEventSchema = z.discriminatedUnion("event", [
  FixtureReadySchema,
  InteractionFixtureReceiptSchema,
  FixtureShutdownSchema,
  FixtureErrorSchema,
]);

export type InteractionFixtureReceipt = Readonly<
  z.infer<typeof InteractionFixtureReceiptSchema>
>;
type FixtureEvent = Readonly<z.infer<typeof FixtureEventSchema>>;

export function interactionFixtureWindowTitle(fixtureId: string): string {
  return `Transmute Interaction Fixture · ${FixtureIdSchema.parse(fixtureId)}`;
}

export function interactionFixturePublicFieldId(fixtureId: string): string {
  return `${INTERACTION_FIXTURE_PUBLIC_FIELD_ID_PREFIX}${
    FixtureIdSchema.parse(fixtureId)
  }`;
}

export class InteractionFixtureError extends Error {
  readonly code:
    | "fixture-exited"
    | "fixture-protocol"
    | "fixture-rejected"
    | "fixture-timeout";

  constructor(
    code: InteractionFixtureError["code"],
    message: string,
  ) {
    super(message);
    this.name = "InteractionFixtureError";
    this.code = code;
  }
}

function parseFixtureLine(line: string): FixtureEvent {
  if (Buffer.byteLength(line) > MAXIMUM_FIXTURE_LINE_BYTES) {
    throw new InteractionFixtureError(
      "fixture-protocol",
      "Interaction fixture emitted an oversized protocol line.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new InteractionFixtureError(
      "fixture-protocol",
      "Interaction fixture emitted invalid JSON.",
    );
  }
  const parsed = FixtureEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new InteractionFixtureError(
      "fixture-protocol",
      "Interaction fixture emitted an invalid protocol event.",
    );
  }
  return parsed.data;
}

export function parseInteractionFixtureReceipt(
  value: unknown,
): InteractionFixtureReceipt {
  return InteractionFixtureReceiptSchema.parse(value);
}

export interface InteractionFixtureTransport {
  close(): Promise<void>;
  readLine(timeoutMs: number): Promise<string>;
  stderrTail(): string;
  write(value: string): Promise<void>;
}

export interface InteractionFixtureTransportFactory {
  spawn(
    executable: string,
    fixtureId: string,
  ): Promise<InteractionFixtureTransport>;
}

function spawnFixtureProcess(executable: string, fixtureId: string) {
  return Bun.spawn(
    [executable, "--interaction-fixture", fixtureId],
    {
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
      },
      stdin: "pipe" as const,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
  );
}

class BunInteractionFixtureTransport implements InteractionFixtureTransport {
  readonly #child: ReturnType<typeof spawnFixtureProcess>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #closed = false;
  #stderr = "";

  constructor(executable: string, fixtureId: string) {
    this.#child = spawnFixtureProcess(executable, fixtureId);
    this.#reader = this.#child.stdout.getReader();
    void this.#collectStderr();
  }

  async #collectStderr(): Promise<void> {
    try {
      for await (const chunk of this.#child.stderr) {
        this.#stderr = `${this.#stderr}${new TextDecoder().decode(chunk)}`.slice(
          -16_384,
        );
      }
    } catch {
      // Structured stdout remains authoritative.
    }
  }

  async readLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return line;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new InteractionFixtureError(
          "fixture-timeout",
          "Interaction fixture response timed out.",
        );
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this.#reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new InteractionFixtureError(
            "fixture-timeout",
            "Interaction fixture response timed out.",
          )), remaining);
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      if (result.done) {
        const details = this.#stderr.trim();
        throw new InteractionFixtureError(
          "fixture-exited",
          details === ""
            ? "Interaction fixture closed its protocol stream."
            : `Interaction fixture closed its protocol stream: ${details}`,
        );
      }
      this.#buffer += this.#decoder.decode(result.value, { stream: true });
      if (Buffer.byteLength(this.#buffer) > MAXIMUM_FIXTURE_LINE_BYTES) {
        throw new InteractionFixtureError(
          "fixture-protocol",
          "Interaction fixture emitted an oversized protocol line.",
        );
      }
    }
  }

  async write(value: string): Promise<void> {
    if (this.#closed) {
      throw new InteractionFixtureError(
        "fixture-exited",
        "Interaction fixture transport is closed.",
      );
    }
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
      // The child may close stdout first.
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      this.#child.exited.then(exitCode => ({
        exitCode,
        kind: "exited" as const,
      })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ kind: "timeout" }),
          FIXTURE_SHUTDOWN_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (outcome.kind === "timeout") {
      this.#child.kill(9);
      await this.#child.exited;
      throw new InteractionFixtureError(
        "fixture-exited",
        "Interaction fixture required forced termination after shutdown.",
      );
    }
    if (outcome.exitCode !== 0) {
      throw new InteractionFixtureError(
        "fixture-exited",
        `Interaction fixture exited with status ${String(outcome.exitCode)}.`,
      );
    }
  }
}

export class BunInteractionFixtureTransportFactory
implements InteractionFixtureTransportFactory {
  spawn(
    executable: string,
    fixtureId: string,
  ): Promise<InteractionFixtureTransport> {
    return Promise.resolve(
      new BunInteractionFixtureTransport(executable, fixtureId),
    );
  }
}

export interface InteractionFixtureController {
  close(): Promise<void>;
  exercise(): Promise<InteractionFixtureReceipt>;
  readonly publicFocusIdentity: TypedTextFocusIdentity;
}

function fixtureCommand(
  fixtureId: string,
  command: "exercise" | "shutdown",
): string {
  return `${JSON.stringify({
    command,
    fixtureId,
    fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
    requestId: command,
  })}\n`;
}

class RunningInteractionFixture implements InteractionFixtureController {
  readonly #fixtureId: string;
  readonly #publicFocusIdentity: TypedTextFocusIdentity;
  readonly #transport: InteractionFixtureTransport;
  #closed = false;
  #exercised = false;

  constructor(
    fixtureId: string,
    publicFocusIdentity: TypedTextFocusIdentity,
    transport: InteractionFixtureTransport,
  ) {
    this.#fixtureId = fixtureId;
    this.#publicFocusIdentity = Object.freeze({ ...publicFocusIdentity });
    this.#transport = transport;
  }

  get publicFocusIdentity(): TypedTextFocusIdentity {
    return this.#publicFocusIdentity;
  }

  async exercise(): Promise<InteractionFixtureReceipt> {
    if (this.#closed || this.#exercised) {
      throw new InteractionFixtureError(
        "fixture-protocol",
        "Interaction fixture can be exercised exactly once.",
      );
    }
    this.#exercised = true;
    await this.#transport.write(fixtureCommand(this.#fixtureId, "exercise"));
    const event = parseFixtureLine(
      await this.#transport.readLine(INTERACTION_FIXTURE_TIMEOUT_MS),
    );
    if (event.fixtureId !== this.#fixtureId) {
      throw new InteractionFixtureError(
        "fixture-protocol",
        "Interaction fixture response used the wrong fixture identity.",
      );
    }
    if (event.event === "error") {
      throw new InteractionFixtureError(
        "fixture-rejected",
        `Interaction fixture rejected exercise (${event.code}): ${event.message}`,
      );
    }
    if (event.event !== "completed") {
      throw new InteractionFixtureError(
        "fixture-protocol",
        `Interaction fixture emitted ${event.event} instead of completed.`,
      );
    }
    if (!sameFocusIdentity(
      event.publicFocusIdentity,
      this.#publicFocusIdentity,
    )) {
      throw new InteractionFixtureError(
        "fixture-protocol",
        "Interaction fixture completed with the wrong focus identity.",
      );
    }
    return event;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#transport.write(fixtureCommand(this.#fixtureId, "shutdown"));
      const event = parseFixtureLine(
        await this.#transport.readLine(INTERACTION_FIXTURE_TIMEOUT_MS),
      );
      if (
        event.event !== "shutdown"
        || event.fixtureId !== this.#fixtureId
      ) {
        throw new InteractionFixtureError(
          "fixture-protocol",
          "Interaction fixture did not acknowledge shutdown.",
        );
      }
    } finally {
      await this.#transport.close();
    }
  }
}

export async function startInteractionFixture(options: {
  readonly executable: string;
  readonly fixtureId: string;
  readonly transportFactory?: InteractionFixtureTransportFactory;
}): Promise<InteractionFixtureController> {
  const fixtureId = FixtureIdSchema.parse(options.fixtureId);
  const transport = await (
    options.transportFactory ?? new BunInteractionFixtureTransportFactory()
  ).spawn(options.executable, fixtureId);
  try {
    const event = parseFixtureLine(
      await transport.readLine(INTERACTION_FIXTURE_TIMEOUT_MS),
    );
    if (event.fixtureId !== fixtureId) {
      throw new InteractionFixtureError(
        "fixture-protocol",
        "Interaction fixture ready event used the wrong fixture identity.",
      );
    }
    if (event.event === "error") {
      throw new InteractionFixtureError(
        "fixture-rejected",
        `Interaction fixture could not start (${event.code}): ${event.message}`,
      );
    }
    const expectedFieldId = interactionFixturePublicFieldId(fixtureId);
    const expectedWindowTitle = interactionFixtureWindowTitle(fixtureId);
    if (
      event.event !== "ready"
      || event.publicFocusIdentity.fieldId !== expectedFieldId
      || event.publicFocusIdentity.windowTitle !== expectedWindowTitle
    ) {
      throw new InteractionFixtureError(
        "fixture-protocol",
        "Interaction fixture did not emit its exact ready identity.",
      );
    }
    return new RunningInteractionFixture(
      fixtureId,
      event.publicFocusIdentity,
      transport,
    );
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // Preserve the structured startup rejection over cleanup diagnostics.
    }
    throw error;
  }
}

function sameFocusIdentity(
  left: TypedTextFocusIdentity,
  right: TypedTextFocusIdentity,
): boolean {
  return left.fieldId === right.fieldId
    && left.processId === right.processId
    && left.windowId === right.windowId
    && left.windowTitle === right.windowTitle;
}
