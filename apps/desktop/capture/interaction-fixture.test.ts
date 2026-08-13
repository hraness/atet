import { describe, expect, test } from "bun:test";

import {
  INTERACTION_FIXTURE_PROTOCOL_VERSION,
  InteractionFixtureError,
  interactionFixturePublicFieldId,
  interactionFixtureWindowTitle,
  parseInteractionFixtureReceipt,
  startInteractionFixture,
  type InteractionFixtureTransport,
  type InteractionFixtureTransportFactory,
} from "./interaction-fixture";

const fixtureId = "01234567-89ab-4cde-8fab-0123456789ab";
const publicFocusIdentity = {
  fieldId: interactionFixturePublicFieldId(fixtureId),
  processId: 42,
  windowId: "42",
  windowTitle: interactionFixtureWindowTitle(fixtureId),
} as const;

function phase(
  focusConfirmedNativeTimeUs: number,
  inputStartedNativeTimeUs: number,
  completedNativeTimeUs: number,
  x: number,
) {
  return {
    attemptedKeyPairs: 1,
    bounds: { height: 30, width: 240, x, y: 140 },
    clickPoint: { x: x + 120, y: 155 },
    completedNativeTimeUs,
    focusConfirmedNativeTimeUs,
    inputStartedNativeTimeUs,
    valueMatches: true,
  } as const;
}

function receipt() {
  return {
    completedNativeTimeUs: 8_000,
    event: "completed",
    fixtureId,
    fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
    neutralFocusConfirmedNativeTimeUs: 7_500,
    publicAfter: phase(5_500, 6_000, 6_500, 120),
    publicBefore: phase(1_000, 1_500, 2_000, 120),
    publicFocusIdentity,
    requestId: "exercise",
    secure: phase(3_000, 3_500, 4_000, 120),
  } as const;
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

function json(value: string): unknown {
  return JSON.parse(value) as unknown;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected fixture operation to reject.");
}

class FakeTransport implements InteractionFixtureTransport {
  readonly writes: string[] = [];
  closed = false;
  readonly #lines: string[];

  constructor(lines: readonly string[]) {
    this.#lines = [...lines];
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  readLine(): Promise<string> {
    const next = this.#lines.shift();
    if (next === undefined) throw new Error("Fake fixture has no next line.");
    return Promise.resolve(next);
  }

  stderrTail(): string {
    return "";
  }

  write(value: string): Promise<void> {
    this.writes.push(value);
    return Promise.resolve();
  }
}

class FakeTransportFactory implements InteractionFixtureTransportFactory {
  readonly transport: FakeTransport;
  spawned: readonly [string, string] | undefined;

  constructor(lines: readonly string[]) {
    this.transport = new FakeTransport(lines);
  }

  spawn(
    executable: string,
    identity: string,
  ): Promise<InteractionFixtureTransport> {
    this.spawned = [executable, identity];
    return Promise.resolve(this.transport);
  }
}

function ready(identity = fixtureId): Readonly<Record<string, unknown>> {
  return {
    event: "ready",
    fixtureId: identity,
    fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
    nativeTimeUs: 500,
    publicFocusIdentity: {
      ...publicFocusIdentity,
      fieldId: interactionFixturePublicFieldId(identity),
      windowTitle: interactionFixtureWindowTitle(identity),
    },
  };
}

describe("owned interaction fixture protocol", () => {
  test("keeps the native fixture fixed-input, fail-closed, and receipt-safe", async () => {
    const source = await Bun.file(
      new URL("./InteractionFixture.swift", import.meta.url),
    ).text();
    expect(source).toContain(
      `private let interactionFixtureProtocolVersion = ${String(INTERACTION_FIXTURE_PROTOCOL_VERSION)}`,
    );
    expect(source).toContain(
      'private let interactionFixturePublicFieldIdPrefix = "transmute-fixture-public-"',
    );
    expect(source).toContain(
      'publicFieldId = "\\(interactionFixturePublicFieldIdPrefix)\\(fixtureId)"',
    );
    expect(source).toContain(
      'windowTitle = "Transmute Interaction Fixture · \\(fixtureId)"',
    );
    expect(source).toContain(
      'Set(object.keys) == ["command", "fixtureId", "fixtureProtocolVersion", "requestId"]',
    );
    expect(source.match(/fixedCharacter: "[asb]"/gu)).toEqual([
      'fixedCharacter: "a"',
      'fixedCharacter: "s"',
      'fixedCharacter: "b"',
    ]);
    expect(source).toContain("CGPreflightPostEventAccess()");
    expect(source).toContain(
      "NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()",
    );
    expect(source).toContain(
      "subrole == (kAXSecureTextFieldSubrole as String)",
    );
    expect(source).toContain(".insetBy(dx: 1, dy: 1)");
    expect(source).toContain(".contains(clickPoint) == true");
    expect(source).toContain("fixtureWindow.level = .screenSaver");
    expect(source).toContain(
      "secureInput.setAccessibilitySubrole(.secureTextField)",
    );
    expect(source).toContain("editor.setAccessibilitySubrole(nil)");
    expect(source).toContain(
      "subrole != (kAXSecureTextFieldSubrole as String)",
    );
    expect(source).toContain("down.postToPid(getpid())");
    expect(source).toContain("up.postToPid(getpid())");
    expect(source).not.toContain(".post(tap: .cghidEventTap)");
    expect(source).toContain("Darwin.read(STDIN_FILENO");

    const receiptStart = source.indexOf('return [\n            "event": "completed"');
    const receiptEnd = source.indexOf(
      "\n    private func activate(",
      receiptStart,
    );
    expect(receiptStart).toBeGreaterThanOrEqual(0);
    expect(receiptEnd).toBeGreaterThan(receiptStart);
    const receiptSource = source.slice(receiptStart, receiptEnd);
    expect(receiptSource).not.toContain('"text"');
    expect(receiptSource).not.toContain('"value"');
    expect(receiptSource).not.toContain('"length"');

    const inputReceived = source.indexOf("guard waitForValue(");
    const postInputDrain = source.indexOf(
      "waitForMetadataObservation()",
      inputReceived,
    );
    const phaseCompleted = source.indexOf(
      "let completedNativeTimeUs",
      inputReceived,
    );
    expect(inputReceived).toBeGreaterThanOrEqual(0);
    expect(postInputDrain).toBeGreaterThan(inputReceived);
    expect(phaseCompleted).toBeGreaterThan(postInputDrain);

    const driver = await Bun.file(
      new URL("./interaction-fixture.ts", import.meta.url),
    ).text();
    expect(driver).toContain("await this.#child.exited;");
    expect(driver).toContain(
      "Interaction fixture required forced termination after shutdown.",
    );
    expect(driver).toContain("if (outcome.exitCode !== 0)");
  });

  test("strictly parses an ordered privacy-safe completion receipt", () => {
    expect(parseInteractionFixtureReceipt(receipt())).toEqual(receipt());
    expect(() => parseInteractionFixtureReceipt({
      ...receipt(),
      secure: {
        ...receipt().secure,
        attemptedKeyPairs: 0,
      },
    })).toThrow();
    expect(() => parseInteractionFixtureReceipt({
      ...receipt(),
      publicBefore: {
        ...receipt().publicBefore,
        clickPoint: { x: 1_000, y: 1_000 },
      },
    })).toThrow();
    expect(() => parseInteractionFixtureReceipt({
      ...receipt(),
      publicAfter: {
        ...receipt().publicAfter,
        focusConfirmedNativeTimeUs: 3_900,
      },
    })).toThrow();
    expect(() => parseInteractionFixtureReceipt({
      ...receipt(),
      secretText: "must never be admitted",
    })).toThrow();
  });

  test("binds ready, exercise, receipt, and shutdown to one exact identity", async () => {
    const factory = new FakeTransportFactory([
      line(ready()),
      line(receipt()),
      line({
        event: "shutdown",
        fixtureId,
        fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
        requestId: "shutdown",
      }),
    ]);
    const fixture = await startInteractionFixture({
      executable: "/tmp/transmute-capture",
      fixtureId,
      transportFactory: factory,
    });
    expect(factory.spawned).toEqual(["/tmp/transmute-capture", fixtureId]);
    expect(fixture.publicFocusIdentity).toEqual(publicFocusIdentity);
    expect(await fixture.exercise()).toEqual(receipt());
    await fixture.close();
    expect(factory.transport.closed).toBeTrue();
    expect(factory.transport.writes.map(json))
      .toEqual([
        {
          command: "exercise",
          fixtureId,
          fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
          requestId: "exercise",
        },
        {
          command: "shutdown",
          fixtureId,
          fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
          requestId: "shutdown",
        },
      ]);
  });

  test("rejects a startup failure without reflecting unknown protocol data", async () => {
    const factory = new FakeTransportFactory([
      line({
        code: "event-posting-not-authorized",
        event: "error",
        fixtureId,
        fixtureProtocolVersion: INTERACTION_FIXTURE_PROTOCOL_VERSION,
        message: "Synthetic input posting is not pre-authorized.",
        requestId: null,
      }),
    ]);
    let failure: unknown;
    try {
      await startInteractionFixture({
        executable: "/tmp/transmute-capture",
        fixtureId,
        transportFactory: factory,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InteractionFixtureError);
    expect((failure as InteractionFixtureError).code).toBe("fixture-rejected");
    expect(factory.transport.closed).toBeTrue();
  });

  test("rejects identity drift and noncanonical fixture IDs", async () => {
    const otherId = "fedcba98-7654-4abc-9def-fedcba987654";
    const factory = new FakeTransportFactory([line(ready(otherId))]);
    expect(await rejection(startInteractionFixture({
      executable: "/tmp/transmute-capture",
      fixtureId,
      transportFactory: factory,
    }))).toMatchObject({ code: "fixture-protocol" });
    expect(factory.transport.closed).toBeTrue();
    expect(await rejection(startInteractionFixture({
      executable: "/tmp/transmute-capture",
      fixtureId: fixtureId.toUpperCase(),
      transportFactory: factory,
    }))).toBeDefined();
  });

  test("rejects nonce drift at ready and every receipt focus-identity drift", async () => {
    const drift = {
      fieldId: "transmute-fixture-public-fedcba98-7654-4abc-9def-fedcba987654",
      processId: 99,
      windowId: "99",
      windowTitle:
        "Transmute Interaction Fixture · fedcba98-7654-4abc-9def-fedcba987654",
    } as const;
    for (const key of ["fieldId", "windowTitle"] as const) {
      const factory = new FakeTransportFactory([
        line({
          ...ready(),
          publicFocusIdentity: {
            ...publicFocusIdentity,
            [key]: drift[key],
          },
        }),
      ]);
      expect(await rejection(startInteractionFixture({
        executable: "/tmp/transmute-capture",
        fixtureId,
        transportFactory: factory,
      }))).toMatchObject({ code: "fixture-protocol" });
      expect(factory.transport.closed).toBeTrue();
    }
    for (const invalidIdentity of [
      { ...publicFocusIdentity, processId: 0 },
      { ...publicFocusIdentity, windowId: "0" },
    ]) {
      const factory = new FakeTransportFactory([
        line({ ...ready(), publicFocusIdentity: invalidIdentity }),
      ]);
      expect(await rejection(startInteractionFixture({
        executable: "/tmp/transmute-capture",
        fixtureId,
        transportFactory: factory,
      }))).toMatchObject({ code: "fixture-protocol" });
      expect(factory.transport.closed).toBeTrue();
    }

    for (const key of Object.keys(drift) as Array<keyof typeof drift>) {
      const factory = new FakeTransportFactory([
        line(ready()),
        line({
          ...receipt(),
          publicFocusIdentity: {
            ...publicFocusIdentity,
            [key]: drift[key],
          },
        }),
      ]);
      const fixture = await startInteractionFixture({
        executable: "/tmp/transmute-capture",
        fixtureId,
        transportFactory: factory,
      });
      expect(await rejection(fixture.exercise()))
        .toMatchObject({ code: "fixture-protocol" });
      await fixture.close().catch(() => undefined);
    }
  });

  test("bounds ready identity strings by UTF-8 bytes", async () => {
    const factory = new FakeTransportFactory([
      line({
        ...ready(),
        publicFocusIdentity: {
          ...publicFocusIdentity,
          windowTitle: "🦎".repeat(65),
        },
      }),
    ]);
    expect(await rejection(startInteractionFixture({
      executable: "/tmp/transmute-capture",
      fixtureId,
      transportFactory: factory,
    }))).toMatchObject({ code: "fixture-protocol" });
    expect(factory.transport.closed).toBeTrue();
  });
});
