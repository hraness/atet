import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { canonicalJson, sha256Hex } from "./canonical-json.js"
import {
  MAX_TRUSTED_COMPUTE_INPUT_BYTES,
  type Ref,
} from "./contracts.js"
import type {
  PortableAtetOperationResultMap,
} from "./public-operations.js"
import {
  buildWorkflow,
  defineCompute,
  defineWorkflow,
} from "./define-workflow.js"
import { AtetCodeError } from "./errors.js"
import {
  createAtetCodeHost,
  runWorkflow,
} from "./runtime.js"

describe("portable SDK immutable snapshots", () => {
  test("executes and receipts the same frozen bounded input", async () => {
    let projectedFindings: Ref<readonly {
      readonly code: string
      readonly message: string
      readonly shapeIds: readonly string[]
    }[]> | undefined
    let buildInputWasFrozen = false
    const definition = defineWorkflow({
      build(builder, input: {
        readonly source: { readonly path: string }
      }) {
        buildInputWasFrozen = Object.isFrozen(input)
          && Object.isFrozen(input.source)
        const checked = builder.diagram.check("check", input.source)
        projectedFindings = checked.select("findings")
        return { checked, projectedFindings }
      },
      id: "immutable-sdk-snapshot",
      inputSchema: z.strictObject({
        source: z.strictObject({ path: z.string().min(1) }),
      }),
      inputSchemaId: "atet.workflow.immutable-sdk-snapshot.input/v1",
      version: 1,
    })
    const callerInput = { source: { path: "system.json" } }
    const hostOutput = {
      configPath: null,
      findings: [{
        code: "fixture",
        message: "A stable finding",
        shapeIds: ["shape-1"],
      }],
    } as const
    let executedInput: unknown
    const host = createAtetCodeHost({
      execute: (request) => {
        executedInput = request.input
        expect(Object.isFrozen(request)).toBe(true)
        expect(Object.isFrozen(request.input)).toBe(true)
        expect(() => {
          ;(request.input as { path: string }).path = "mutated.json"
        }).toThrow()
        return Promise.resolve(hostOutput as unknown as (
          PortableAtetOperationResultMap[typeof request.kind]
        ))
      },
    })

    const result = await runWorkflow(definition, callerInput, { host })
    expect(buildInputWasFrozen).toBe(true)
    expect(executedInput).toEqual({ path: "system.json" })
    expect(result.receipts[0]?.inputSha256).toBe(sha256Hex(
      canonicalJson(executedInput),
    ))
    expect(result.receipts[0]?.outputSha256).toBe(sha256Hex(
      canonicalJson(result.output.checked),
    ))

    expect(Object.isFrozen(result.output)).toBe(true)
    expect(Object.isFrozen(result.output.checked)).toBe(true)
    expect(Object.isFrozen(result.output.checked.findings)).toBe(true)
    expect(Object.isFrozen(result.output.checked.findings[0])).toBe(true)
    expect(Object.isFrozen(result.output.checked.findings[0]?.shapeIds)).toBe(true)
    expect(() => {
      ;(result.output.checked.findings[0]?.shapeIds as string[])[0] = "changed"
    }).toThrow()
    ;(hostOutput.findings[0].shapeIds as unknown as string[])[0] = "host-mutated"
    expect(result.output.checked.findings[0]?.shapeIds).toEqual(["shape-1"])

    expect(projectedFindings).toBeDefined()
    expect(Object.isFrozen(projectedFindings?.serialized)).toBe(true)
    expect(Object.isFrozen(projectedFindings?.serialized.$ref)).toBe(true)
    expect(Object.isFrozen(projectedFindings?.serialized.$ref.path)).toBe(true)

    const built = buildWorkflow(definition, callerInput)
    expect(Object.isFrozen(built.input)).toBe(true)
    expect(Object.isFrozen((built.input as { readonly source: object }).source)).toBe(true)
    expect(Object.isFrozen(built.graph)).toBe(true)
    expect(Object.isFrozen(built.graph.nodes)).toBe(true)
    expect(Object.isFrozen(built.graph.nodes[0])).toBe(true)
    expect(Object.isFrozen(built.graph.nodes[0]?.dependencies)).toBe(true)
    expect(Object.isFrozen(built.graph.outputs)).toBe(true)

    callerInput.source.path = "caller-mutated.json"
    expect((built.input as { readonly source: { readonly path: string } }).source.path)
      .toBe("system.json")
  })

  test("freezes compute bounds and rejects missing definition capabilities", () => {
    const compute = defineCompute({
      inputSchema: z.strictObject({ value: z.number() }),
      inputSchemaId: "atet.compute.fixture.input/v1",
      key: "atet.compute.fixture/v1",
      outputSchema: z.strictObject({ value: z.number() }),
      outputSchemaId: "atet.compute.fixture.output/v1",
      run: input => input,
    })
    expect(Object.isFrozen(compute)).toBe(true)
    expect(Object.isFrozen(compute.bounds)).toBe(true)
    expect(() => {
      ;(compute.bounds as { maxDurationMs: number }).maxDurationMs = 1
    }).toThrow()

    expect(() => defineWorkflow({
      build: () => [],
      id: "missing-schema",
      // @ts-expect-error A JavaScript caller can provide a schema-shaped lie.
      inputSchema: {},
      inputSchemaId: "atet.workflow.missing-schema.input/v1",
      version: 1,
    })).toThrow(AtetCodeError)
    expect(() => defineCompute({
      inputSchema: z.unknown(),
      inputSchemaId: "atet.compute.missing-run.input/v1",
      key: "atet.compute.missing-run/v1",
      outputSchema: z.unknown(),
      outputSchemaId: "atet.compute.missing-run.output/v1",
      // @ts-expect-error A JavaScript caller can omit the execution capability.
      run: undefined,
    })).toThrow(AtetCodeError)
  })

  test("bounds hostile raw workflow inputs before user schemas or builders run", () => {
    let buildCalls = 0
    let schemaCalls = 0
    const definition = defineWorkflow({
      build: () => {
        buildCalls += 1
        return {}
      },
      id: "hostile-input-boundary",
      inputSchema: z.preprocess((value) => {
        schemaCalls += 1
        return value
      }, z.unknown()),
      inputSchemaId: "atet.workflow.hostile-input-boundary.input/v1",
      version: 1,
    })
    const expectRejected = (value: unknown, message: string): void => {
      try {
        buildWorkflow(definition, value)
      } catch (error) {
        expect(error).toBeInstanceOf(AtetCodeError)
        expect((error as AtetCodeError).code).toBe("invalid-data")
        expect((error as AtetCodeError).message).toContain(message)
        return
      }
      throw new Error("Expected hostile workflow input to be rejected.")
    }

    let nested: unknown = "leaf"
    for (let depth = 0; depth < 256; depth += 1) nested = { nested }
    expectRejected(nested, "nesting exceeds")

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expectRejected(cyclic, "cyclic")

    let getterExecuted = false
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        getterExecuted = true
        throw new Error("must not execute")
      },
    })
    expectRejected(accessor, "plain data properties")
    expect(getterExecuted).toBe(false)

    expectRejected(
      "x".repeat(MAX_TRUSTED_COMPUTE_INPUT_BYTES),
      "contains more than",
    )
    expect(buildCalls).toBe(0)
    expect(schemaCalls).toBe(0)
  })

  test("preserves workflow schema preprocessing and transforms before JSON snapshotting", () => {
    const definition = defineWorkflow({
      build: (builder, input: { readonly path: string }) => ({
        checked: builder.diagram.check("check", { path: input.path }),
      }),
      id: "transformed-input-boundary",
      inputSchema: z.preprocess(
        value => value instanceof Date ? value.toISOString() : value,
        z.string().transform(path => ({ path })),
      ),
      inputSchemaId: "atet.workflow.transformed-input-boundary.input/v1",
      version: 1,
    })
    const input = new Date("2026-08-04T12:34:56.000Z")
    const built = buildWorkflow(definition, input)

    expect(built.input).toEqual({ path: input.toISOString() })
    expect(Object.isFrozen(built.input)).toBe(true)
    expect(built.graph.nodes[0]?.input).toEqual({ path: input.toISOString() })
  })

  test("passes one captured plain-container view to a user schema", () => {
    let schemaInput: unknown
    const definition = defineWorkflow({
      build: (builder, input: { readonly value: string }) => ({
        checked: builder.diagram.check("check", { path: input.value }),
      }),
      id: "captured-schema-input",
      inputSchema: z.preprocess((value) => {
        schemaInput = value
        return value
      }, z.strictObject({ value: z.string() })),
      inputSchemaId: "atet.workflow.captured-schema-input.input/v1",
      version: 1,
    })
    let propertyReads = 0
    const input = new Proxy({ value: "captured" }, {
      get: (target, property, receiver) => {
        propertyReads += 1
        return Reflect.get(target, property, receiver) as unknown
      },
    })

    expect(buildWorkflow(definition, input).input).toEqual({ value: "captured" })
    expect(schemaInput).not.toBe(input)
    expect(propertyReads).toBe(0)
  })
})
