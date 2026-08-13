import { createHash } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

import { ApplicationError } from "../application/errors";
import {
  GatewayOperationResultSchema,
  GatewayPortRequestSchema,
  GatewayPortReconciliationSchema,
  GatewayRequestIdSchema,
  type GatewayOperationResult,
  type GatewayPortReconciliation,
  type GatewayPortRequest,
} from "../application/gateway-port";
import {
  operationApplicationContext,
} from "../application/operations/test-support";
import type { ApplicationContext } from "../application/context";
import {
  type GatewayMediaArtifactBundle,
  type GatewayMediaReceipt,
} from "./gateway-media-artifacts";
import {
  createGatewayApplicationPort,
  assertGatewayApplicationJournalPrivate,
  type GatewayApplicationMediaFacts,
  type GatewayApplicationServiceCallbacks,
} from "./gateway-application-port";
import type {
  GatewayMediaDispatchEvent,
  GatewayMediaService,
} from "./gateway-media-service";
import {
  gatewayProviderOptionsSummary,
  parseGatewayProviderOptions,
  type GatewayProviderOptions,
} from "./gateway-provider-options";

const NOW = new Date("2026-07-23T16:00:00.000Z");
const SPEECH_MODEL = "openai/tts-1";
const IMAGE_MODEL = "openai/gpt-image-1";
const OUTPUT_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);

type ServiceMode = "complete" | "fail-before-dispatch" | "fail-after-dispatch";

interface GatewayHarness {
  readonly createPort: () => ReturnType<typeof createGatewayApplicationPort>;
  readonly state: {
    facts: GatewayApplicationMediaFacts;
    inspectionLeases: ApplicationContext["hostResourceLease"][];
    mode: ServiceMode;
    providerOptions: GatewayProviderOptions | undefined;
    publications: number;
    serviceCalls: number;
    serviceCreations: number;
    serviceLeases: ApplicationContext["hostResourceLease"][];
  };
}

const HOST_RESOURCE_LEASE: NonNullable<ApplicationContext["hostResourceLease"]> = {
  assertOwned: () => Promise.resolve(),
  claims: [
    { amount: 8, resource: "cpu" },
    { amount: 2, resource: "ffmpeg" },
  ],
  inheritedFileDescriptor: 42,
  inheritedFileDescriptors: [42],
  profile: {
    capacities: [],
    id: "gateway-application-port-test",
  },
  ticket: "gateway-application-port-test-ticket",
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestId(character: string) {
  return GatewayRequestIdSchema.parse(`gateway_${character.repeat(64)}`);
}

function speechRequest(
  options: Readonly<{
    providerOptions?: ReturnType<typeof gatewayProviderOptionsSummary>;
    text?: string;
  }> = {},
): GatewayPortRequest {
  return GatewayPortRequestSchema.parse({
    operation: "speech",
    request: {
      model: SPEECH_MODEL,
      ...(options.providerOptions === undefined
        ? {}
        : { providerOptions: options.providerOptions }),
      text: options.text ?? "Private narration text",
    },
  });
}

async function repositoryFixture(): Promise<Readonly<{
  application: ApplicationContext;
  root: string;
}>> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "transmute-gateway-application-port-")),
  );
  const application = operationApplicationContext(root, { now: NOW });
  await mkdir(application.paths.privateRoot, {
    mode: 0o700,
    recursive: true,
  });
  return { application, root };
}

function modelFromRequest(request: unknown): string {
  if (
    typeof request !== "object"
    || request === null
    || Array.isArray(request)
    || !("model" in request)
    || typeof request.model !== "string"
  ) {
    throw new Error("Fake Gateway service received no model.");
  }
  return request.model;
}

async function bundle(
  application: ApplicationContext,
  operation: GatewayMediaDispatchEvent["operation"],
  model: string,
  sequence: number,
): Promise<GatewayMediaArtifactBundle> {
  const directory = join(
    application.paths.repositoryRoot,
    "artifacts",
    "transmute",
    "generated",
    "gateway-test",
    String(sequence),
  );
  await mkdir(directory, { mode: 0o700, recursive: true });
  const outputPath = join(directory, "speech.mp3");
  const receiptPath = join(directory, "receipt.json");
  await writeFile(outputPath, OUTPUT_BYTES, { mode: 0o600 });
  const output = {
    bytes: OUTPUT_BYTES.byteLength,
    file: "speech.mp3",
    mediaType: "audio/mpeg",
    path: outputPath,
    sha256: sha256(OUTPUT_BYTES),
  } as const;
  const receipt: GatewayMediaReceipt = {
    catalog: { snapshotId: "catalog_test", status: "fresh" },
    createdAt: NOW.toISOString(),
    inputs: [],
    kind: "studio.gateway-media-receipt",
    localValidation: {
      decodeValidatedOutputs: 0,
      signatureOnlyOutputs: 1,
      status: "signature-only",
    },
    model,
    nextCommands: [],
    operation,
    outputs: [output],
    request: {},
    routing: {
      attemptCount: 1,
      attempts: [{ model, provider: "openai", success: true }],
      attemptsTruncated: false,
      clientMaxRetries: 0,
      gatewayProviderFailover: "may-attempt-multiple-providers",
      providerCount: 1,
      providers: ["openai"],
      providersTruncated: false,
    },
    schemaVersion: 1,
    warnings: [],
  };
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    directory,
    outputs: [output],
    receipt,
    receiptPath,
  };
}

function gatewayHarness(
  application: ApplicationContext,
  options: Readonly<{
    facts?: GatewayApplicationMediaFacts;
    mode?: ServiceMode;
    providerOptions?: GatewayProviderOptions;
  }> = {},
): GatewayHarness {
  const state: GatewayHarness["state"] = {
    facts: options.facts ?? {},
    inspectionLeases: [],
    mode: options.mode ?? "complete",
    providerOptions: options.providerOptions,
    publications: 0,
    serviceCalls: 0,
    serviceCreations: 0,
    serviceLeases: [],
  };
  const createService = (
    callbacks: GatewayApplicationServiceCallbacks,
    hostResourceLease: ApplicationContext["hostResourceLease"],
  ): Promise<GatewayMediaService> => {
    state.serviceCreations += 1;
    state.serviceLeases.push(hostResourceLease);
    const execute = async (
      operation: GatewayMediaDispatchEvent["operation"],
      request: unknown,
    ): Promise<GatewayMediaArtifactBundle> => {
      state.serviceCalls += 1;
      if (state.mode === "fail-before-dispatch") {
        throw new Error("local setup failed");
      }
      const model = modelFromRequest(request);
      await callbacks.onDispatch({
        model,
        operation,
        startedAt: NOW.toISOString(),
      });
      if (state.mode === "fail-after-dispatch") {
        throw new Error("provider response was lost");
      }
      await callbacks.beforePublication();
      state.publications += 1;
      return await bundle(
        application,
        operation,
        model,
        state.serviceCalls,
      );
    };
    return Promise.resolve({
      generateImage: async request =>
        await execute("image.generate", request),
      generateSpeech: async request =>
        await execute("speech.generate", request),
      generateVideo: async request =>
        await execute("video.generate", request),
      transcribe: async (request) => ({
        artifact: await execute("transcription.create", request),
        durationInSeconds: 1,
        routing: {
          attemptCount: 1,
          attempts: [],
          attemptsTruncated: false,
          clientMaxRetries: 0,
          gatewayProviderFailover: "may-attempt-multiple-providers",
          providerCount: 0,
          providers: [],
          providersTruncated: false,
        },
        segments: [],
        text: "",
        warnings: [],
      }),
    });
  };
  return {
    createPort: () => createGatewayApplicationPort({
      application,
      createService,
      inspectMedia: (inputs, _signal, hostResourceLease) => {
        state.inspectionLeases.push(hostResourceLease);
        return Promise.resolve(inputs.map(() => state.facts));
      },
      now: () => NOW,
      resolveProviderOptions: () =>
        Promise.resolve(state.providerOptions),
    }),
    state,
  };
}

async function rejectedApplicationError(
  promise: Promise<unknown>,
): Promise<ApplicationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    return error as ApplicationError;
  }
  throw new Error("Expected an ApplicationError.");
}

function dispatch(
  port: ReturnType<typeof createGatewayApplicationPort>,
  request: GatewayPortRequest,
  id: string,
  hostResourceLease?: ApplicationContext["hostResourceLease"],
): Promise<GatewayOperationResult> {
  return port.dispatch({
    beforePublication: () => Promise.resolve(),
    ...(hostResourceLease === undefined ? {} : { hostResourceLease }),
    request,
    requestId: id,
    signal: new AbortController().signal,
  }).then(result => GatewayOperationResultSchema.parse(result));
}

function prepare(
  port: ReturnType<typeof createGatewayApplicationPort>,
  request: GatewayPortRequest,
  signal = new AbortController().signal,
  hostResourceLease?: ApplicationContext["hostResourceLease"],
): Promise<GatewayPortRequest> {
  return port.prepare({
    ...(hostResourceLease === undefined ? {} : { hostResourceLease }),
    request,
    signal,
  })
    .then(result => GatewayPortRequestSchema.parse(result));
}

function reconcile(
  port: ReturnType<typeof createGatewayApplicationPort>,
  request: GatewayPortRequest,
  id: string,
): Promise<GatewayPortReconciliation> {
  return port.reconcile({
    request,
    requestId: id,
    signal: new AbortController().signal,
  }).then(result => GatewayPortReconciliationSchema.parse(result));
}

describe("Gateway application port", () => {
  test("dispatches at most once across restarts and verifies completed reconciliation", async () => {
    const fixture = await repositoryFixture();
    try {
      const harness = gatewayHarness(fixture.application);
      const request = speechRequest();
      const id = requestId("1");
      const first = await dispatch(
        harness.createPort(),
        request,
        id,
        HOST_RESOURCE_LEASE,
      );
      expect(harness.state.serviceCalls).toBe(1);
      expect(harness.state.publications).toBe(1);
      expect(harness.state.serviceLeases).toEqual([HOST_RESOURCE_LEASE]);

      const restarted = harness.createPort();
      expect(await dispatch(restarted, request, id)).toEqual(first);
      expect(harness.state.serviceCalls).toBe(1);
      expect(harness.state.serviceCreations).toBe(1);
      expect(await reconcile(restarted, request, id)).toMatchObject({
        requestId: id,
        status: "completed",
      });

      const output = first.outputs[0]!;
      await writeFile(
        join(fixture.root, output.path),
        new Uint8Array([0x49, 0x44, 0x33, 0xff]),
      );
      const tampered = await reconcile(restarted, request, id);
      expect(tampered).toMatchObject({
        operation: "speech",
        requestId: id,
        status: "conflict",
      });
      if (tampered.status !== "conflict") {
        throw new Error("Expected completed-artifact conflict.");
      }
      expect(tampered.reasonSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect((await rejectedApplicationError(
        dispatch(restarted, request, id),
      )).code).toBe("conflict");
      expect(harness.state.serviceCalls).toBe(1);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("retries only a journal-proven pre-dispatch failure", async () => {
    const fixture = await repositoryFixture();
    try {
      const harness = gatewayHarness(fixture.application, {
        mode: "fail-before-dispatch",
      });
      const port = harness.createPort();
      const request = speechRequest();
      const id = requestId("2");
      expect((await rejectedApplicationError(
        dispatch(port, request, id),
      )).code).toBe("unavailable");
      expect(await reconcile(port, request, id))
        .toMatchObject({ status: "not-dispatched" });

      harness.state.mode = "complete";
      await dispatch(port, request, id);
      expect(harness.state.serviceCalls).toBe(2);
      expect(await reconcile(port, request, id))
        .toMatchObject({ status: "completed" });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("never redrives a post-dispatch ambiguity", async () => {
    const fixture = await repositoryFixture();
    try {
      const harness = gatewayHarness(fixture.application, {
        mode: "fail-after-dispatch",
      });
      const port = harness.createPort();
      const request = speechRequest();
      const id = requestId("3");
      expect((await rejectedApplicationError(
        dispatch(port, request, id),
      )).code).toBe("ambiguous");
      expect(await reconcile(port, request, id))
        .toMatchObject({ status: "dispatched" });

      harness.state.mode = "complete";
      expect((await rejectedApplicationError(
        dispatch(harness.createPort(), request, id),
      )).code).toBe("ambiguous");
      expect(harness.state.serviceCalls).toBe(1);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("binds a request ID to one exact digest", async () => {
    const fixture = await repositoryFixture();
    try {
      const harness = gatewayHarness(fixture.application, {
        mode: "fail-before-dispatch",
      });
      const port = harness.createPort();
      const id = requestId("4");
      const original = speechRequest({ text: "first exact request" });
      await rejectedApplicationError(dispatch(port, original, id));
      const changed = speechRequest({ text: "different exact request" });
      expect((await rejectedApplicationError(
        dispatch(port, changed, id),
      )).code).toBe("conflict");
      expect(await reconcile(port, changed, id))
        .toMatchObject({ status: "conflict" });
      expect(harness.state.serviceCalls).toBe(1);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("requires digest-matching ephemeral provider options and journals no raw values", async () => {
    const fixture = await repositoryFixture();
    try {
      const expected = parseGatewayProviderOptions({
        openai: { apiKey: "raw-secret-never-persist" },
      });
      const mismatched = parseGatewayProviderOptions({
        openai: { apiKey: "wrong-secret" },
      });
      const request = speechRequest({
        providerOptions: gatewayProviderOptionsSummary(expected),
        text: "raw-prompt-never-persist",
      });
      const id = requestId("5");
      const harness = gatewayHarness(fixture.application, {
        providerOptions: mismatched,
      });
      expect((await rejectedApplicationError(
        prepare(harness.createPort(), request),
      )).code).toBe("authorization-required");
      expect(harness.state.serviceCreations).toBe(0);

      harness.state.providerOptions = expected;
      await dispatch(harness.createPort(), request, id);
      await assertGatewayApplicationJournalPrivate(fixture.application, id);
      const journalPath = join(
        fixture.application.paths.privateRoot,
        "gateway-workflow-requests",
        id,
        "request.json",
      );
      const journal = await readFile(journalPath, "utf8");
      expect(journal).not.toContain("raw-secret-never-persist");
      expect(journal).not.toContain("raw-prompt-never-persist");
      expect(journal).not.toContain("\"request\":");
      expect(journal).toContain("\"requestSha256\":");
      expect((await lstat(journalPath)).isFile()).toBe(true);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("loads physical content-addressed sources and rejects mutation, signatures, symlinks, aborts, and changed facts", async () => {
    const fixture = await repositoryFixture();
    try {
      const mediaDirectory = join(fixture.root, "fixtures");
      await mkdir(mediaDirectory, { recursive: true });
      const imagePath = join(mediaDirectory, "source.png");
      await writeFile(imagePath, PNG_BYTES);
      const source = {
        bytes: PNG_BYTES.byteLength,
        mediaType: "image/png",
        path: "fixtures/source.png",
        sha256: sha256(PNG_BYTES),
      } as const;
      const request = GatewayPortRequestSchema.parse({
        operation: "image",
        request: {
          images: [source],
          model: IMAGE_MODEL,
          prompt: "Restyle this image",
        },
      });
      const harness = gatewayHarness(fixture.application, {
        facts: { height: 720, width: 1_280 },
      });
      const port = harness.createPort();
      const prepared = await prepare(
        port,
        request,
        new AbortController().signal,
        HOST_RESOURCE_LEASE,
      );
      expect(harness.state.inspectionLeases).toEqual([HOST_RESOURCE_LEASE]);
      expect(prepared).toMatchObject({
        request: {
          images: [{
            facts: { height: 720, width: 1_280 },
          }],
        },
      });

      harness.state.facts = { height: 1_080, width: 1_920 };
      expect((await rejectedApplicationError(
        dispatch(port, prepared, requestId("6")),
      )).code).toBe("conflict");
      expect(harness.state.serviceCreations).toBe(0);

      await writeFile(imagePath, new Uint8Array([...PNG_BYTES, 0x02]));
      expect((await rejectedApplicationError(
        prepare(port, request),
      )).code).toBe("conflict");

      const invalidBytes = new Uint8Array([0x01, 0x02, 0x03]);
      const invalidPath = join(mediaDirectory, "invalid.png");
      await writeFile(invalidPath, invalidBytes);
      const invalidRequest = GatewayPortRequestSchema.parse({
        operation: "image",
        request: {
          images: [{
            bytes: invalidBytes.byteLength,
            mediaType: "image/png",
            path: "fixtures/invalid.png",
            sha256: sha256(invalidBytes),
          }],
          model: IMAGE_MODEL,
          prompt: "Invalid signature",
        },
      });
      expect((await rejectedApplicationError(
        prepare(port, invalidRequest),
      )).code).toBe("conflict");

      const targetPath = join(mediaDirectory, "target.png");
      const linkPath = join(mediaDirectory, "link.png");
      await writeFile(targetPath, PNG_BYTES);
      await symlink(targetPath, linkPath);
      const linkedRequest = GatewayPortRequestSchema.parse({
        operation: "image",
        request: {
          images: [{
            ...source,
            path: "fixtures/link.png",
          }],
          model: IMAGE_MODEL,
          prompt: "Symlink",
        },
      });
      expect((await rejectedApplicationError(
        prepare(port, linkedRequest),
      )).code).toBe("unsafe-path");

      const controller = new AbortController();
      controller.abort();
      expect((await rejectedApplicationError(
        prepare(port, request, controller.signal),
      )).code).toBe("cancelled");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("consumes verified bytes without reopening a swapped parent path", async () => {
    const fixture = await repositoryFixture();
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "transmute-gateway-parent-swap-")),
    );
    const mediaDirectory = join(fixture.root, "fixtures");
    const externalDirectory = join(outside, "external");
    const heldDirectory = join(outside, "held");
    const imagePath = join(mediaDirectory, "source.png");
    await Promise.all([
      mkdir(mediaDirectory, { recursive: true }),
      mkdir(externalDirectory, { recursive: true }),
    ]);
    await writeFile(imagePath, PNG_BYTES);
    await link(imagePath, join(externalDirectory, "source.png"));
    const originalOpen = fileSystem.open;
    let swapped = false;
    let targetOpens = 0;
    const openSpy = spyOn(fileSystem, "open").mockImplementation(
      async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode);
        if (String(path) === imagePath) {
          targetOpens += 1;
          if (targetOpens === 1) {
            const originalClose = handle.close.bind(handle);
            spyOn(handle, "close").mockImplementation(async () => {
              await originalClose();
              if (!swapped) {
                swapped = true;
                await rename(mediaDirectory, heldDirectory);
                await symlink(externalDirectory, mediaDirectory, "dir");
              }
            });
          }
        }
        return handle;
      },
    );
    try {
      const request = GatewayPortRequestSchema.parse({
        operation: "image",
        request: {
          images: [{
            bytes: PNG_BYTES.byteLength,
            mediaType: "image/png",
            path: "fixtures/source.png",
            sha256: sha256(PNG_BYTES),
          }],
          model: IMAGE_MODEL,
          prompt: "Use the descriptor-bound image",
        },
      });
      const prepared = await prepare(
        gatewayHarness(fixture.application, {
          facts: { height: 720, width: 1_280 },
        }).createPort(),
        request,
      );
      expect(prepared).toMatchObject({
        request: {
          images: [{
            facts: { height: 720, width: 1_280 },
          }],
        },
      });
      expect(swapped).toBe(true);
      expect(targetOpens).toBe(1);
    } finally {
      openSpy.mockRestore();
      await Promise.all([
        rm(fixture.root, { force: true, recursive: true }),
        rm(outside, { force: true, recursive: true }),
      ]);
    }
  });
});
