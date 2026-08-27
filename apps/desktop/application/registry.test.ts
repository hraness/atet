import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  PORTABLE_ATET_OPERATION_CONTRACTS,
  PORTABLE_ATET_OPERATION_KINDS,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
} from "@hraness/atet/code/advanced";

import { createApplicationOperationRegistry } from "./default-registry";
import { ApplicationError } from "./errors";
import { ATET_APPLICATION_TOOL_VERSION } from "./operation";
import { OperationRegistry } from "./registry";
import type { OperationDefinition } from "./operation";

function definition(version = 1): OperationDefinition<"derive.edit-batch", { readonly value: number }, { readonly doubled: number }> {
  return {
    inputSchema: z.strictObject({ value: z.number().int() }),
    inputSchemaId: "test.input/v1",
    kind: "derive.edit-batch",
    lifecycle: {
      kind: "pure",
      execute: (_context, input) => Promise.resolve({
        doubled: input.value * 2,
      }),
    },
    outputSchema: z.strictObject({ doubled: z.number().int() }),
    outputSchemaId: "test.output/v1",
    policy: {
      cache: "content-addressed",
      cancellable: true,
      effect: "pure",
      maxDurationMs: 1_000,
      maxFanOut: 0,
      maxInputBytes: 1_024,
      maxOutputBytes: 1_024,
      preparation: [],
      resources: [{ amount: 1, resource: "cpu" }],
      resume: "deterministic",
    },
    summarize: output => ({
      fields: { doubled: output.doubled },
      kind: "derive.edit-batch",
    }),
    version,
  };
}

describe("operation registry", () => {
  test("sorts discovery and rejects duplicate versions", () => {
    const registry = new OperationRegistry();
    registry.register(definition(2));
    registry.register(definition(1));
    expect(registry.list().map(item => item.version)).toEqual([1, 2]);
    expect(() => registry.register(definition(1))).toThrow(ApplicationError);
  });

  test("progressively exposes owned input and output JSON Schemas", () => {
    const registry = new OperationRegistry();
    registry.register(definition());
    const description = registry.describe("derive.edit-batch", 1);
    expect(description.inputJsonSchema).toMatchObject({
      $id: "test.input/v1",
      additionalProperties: false,
      properties: {
        value: { type: "integer" },
      },
      required: ["value"],
      type: "object",
    });
    expect(description.outputJsonSchema).toMatchObject({
      $id: "test.output/v1",
      additionalProperties: false,
      properties: {
        doubled: { type: "integer" },
      },
      required: ["doubled"],
      type: "object",
    });
    expect(registry.list()[0]).not.toHaveProperty("inputJsonSchema");
  });

  test("describes every production operation schema on demand", () => {
    const registry = createApplicationOperationRegistry({
      nextAnalysisId: () => "analysis_registry0001",
    });
    const descriptions = registry.list().map(operation => (
      registry.describe(operation.kind, operation.version)
    ));
    expect(ATET_APPLICATION_TOOL_VERSION).toBe("atet-3.1.0");
    expect(registry.list().every(operation => (
      operation.inputSchemaId.startsWith("atet.operation.")
      && operation.outputSchemaId.startsWith("atet.operation.")
    ))).toBe(true);
    expect(descriptions).toHaveLength(49);
    const portableKinds = new Set<string>(
      PORTABLE_ATET_OPERATION_KINDS.map(
        kind => PORTABLE_ATET_OPERATION_CONTRACTS[kind].kind,
      ),
    );
    const portableProjection = registry.list().filter(operation => (
      operation.version === 2 && portableKinds.has(operation.kind)
    ));
    expect(portableProjection as unknown).toEqual(
      PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery,
    );
    expect(registry.list().length).toBeGreaterThan(portableProjection.length);
    expect(registry.list().filter(operation => (
      operation.version === 1 && portableKinds.has(operation.kind)
    )).map(operation => operation.kind)).toEqual([
      "atet.diagram.check",
      "atet.diagram.render",
      "atet.image.vectorize",
    ]);
    expect(registry.describe("atet.image.generate", 2).version).toBe(2);
    expect(() => registry.describe("atet.image.generate", 1))
      .toThrow(ApplicationError);
    expect(registry.list().filter(operation => (
      operation.kind.startsWith("iteration.")
    )).map(operation => operation.kind)).toEqual([
      "iteration.create-candidate",
      "iteration.create-matrix",
      "iteration.select",
    ]);
    expect(registry.list().filter(operation => (
      operation.kind === "render.project-plan"
    )).map(operation => operation.version)).toEqual([1, 2]);
    expect(registry.list().filter(operation => (
      operation.kind === "render.project"
    )).map(operation => operation.version)).toEqual([1, 2, 3]);
    expect(registry.describe("render.project", 2).policy.resources).toEqual([
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "ffmpeg" },
      { amount: 1, resource: "output-publication" },
      { amount: 1, resource: "project-render" },
    ]);
    expect(descriptions.every(description => (
      description.inputJsonSchema.$id === description.inputSchemaId
      && description.outputJsonSchema.$id === description.outputSchemaId
    ))).toBe(true);
  });

  test("parses input and output through the owned schemas", async () => {
    const registry = new OperationRegistry();
    registry.register(definition());
    const result = await registry.execute({
      abortSignal: new AbortController().signal,
      application: {
        capabilities: () => Promise.resolve([]),
        capability: name => Promise.resolve({ available: false, name }),
        clock: { now: () => new Date(0), timestampMilliseconds: () => 0 },
        paths: {
          artifactRoot: "/recordings",
          desktopRoot: "/desktop",
          privateRoot: "/private",
          projectRoot: "/projects",
          repositoryRoot: "/repo",
        },
        runner: {
          run: () => Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: "",
          }),
        },
      },
    }, {
      input: { value: 3 },
      kind: "derive.edit-batch",
      version: 1,
    });
    expect(result.output).toEqual({ doubled: 6 });
    expect(registry.execute({
      abortSignal: new AbortController().signal,
      application: {
        capabilities: () => Promise.resolve([]),
        capability: name => Promise.resolve({ available: false, name }),
        clock: { now: () => new Date(0), timestampMilliseconds: () => 0 },
        paths: {
          artifactRoot: "/recordings",
          desktopRoot: "/desktop",
          privateRoot: "/private",
          projectRoot: "/projects",
          repositoryRoot: "/repo",
        },
        runner: {
          run: () => Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: "",
          }),
        },
      },
    }, {
      input: { value: "3" },
      kind: "derive.edit-batch",
      version: 1,
    })).rejects.toThrow();
  });
});
