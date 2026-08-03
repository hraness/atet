import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { transmuteImageModels } from "./discovery.ts"
import type {
  HostResourceClaim,
  HostResourceCoordinator,
  HostResourceLease,
} from "./host-resources.ts"
import {
  executeTransmuteOperation,
  executeTransmuteOperationWithLease,
  transmuteOperationCodes,
  transmuteOperationRegistry,
  parseTransmuteOperationInput,
  searchTransmuteOperations,
  withTransmuteOperationHostAdmission,
} from "./operations.ts"

function recordingCoordinator(record: {
  assertions: number
  claims: HostResourceClaim[][]
}, inheritedFileDescriptor = 73): HostResourceCoordinator {
  const profile = {
    id: "transmute.test-host/v1",
    capacities: [],
  } as const
  return {
    profile,
    scope: "process",
    async withLease(claims, callback) {
      record.claims.push([...claims])
      return await callback({
        claims,
        inheritedFileDescriptor,
        profile,
        ticket: String(record.claims.length),
        assertOwned: () => {
          record.assertions += 1
          return Promise.resolve()
        },
      })
    },
  }
}

describe("canonical Transmute operations", () => {
  test("publishes four exact semantic codes in stable order", () => {
    expect(transmuteOperationRegistry.map(({ code }) => code)).toEqual(
      [...transmuteOperationCodes],
    )
    expect(
      transmuteOperationRegistry.find(
        ({ code }) => code === "transmute.image.generate",
      ),
    ).toMatchObject({
      execution: "hosted",
      authentication: "required",
      destructive: true,
      idempotent: false,
      transport: {
        method: "POST",
        endpointFromDiscovery: "endpoints.generateImage",
        authorization: "bearer",
        idempotencyHeader: "Idempotency-Key",
        retry: "never",
      },
    })
    expect(
      transmuteOperationRegistry.find(
        ({ code }) => code === "transmute.image.vectorize",
      ),
    ).toMatchObject({
      execution: "local",
      authentication: "none",
    })
    expect(
      transmuteOperationRegistry.map(({ code, resources }) => ({ code, resources })),
    ).toEqual([
      {
        code: "transmute.diagram.check",
        resources: [
          { resource: "cpu", amount: 1 },
          { resource: "local-io", amount: 1 },
        ],
      },
      {
        code: "transmute.diagram.render",
        resources: [
          { resource: "cpu", amount: 1 },
          { resource: "local-io", amount: 1 },
        ],
      },
      {
        code: "transmute.image.vectorize",
        resources: [
          { resource: "cpu", amount: 1 },
          { resource: "local-io", amount: 1 },
        ],
      },
      {
        code: "transmute.image.generate",
        resources: [
          { resource: "local-io", amount: 1 },
          { resource: "network", amount: 1 },
          { resource: "paid-call", amount: 1 },
        ],
      },
    ])
    expect(Object.isFrozen(transmuteOperationRegistry[0]?.resources)).toBe(true)
  })

  test("searches bounded semantic metadata without fuzzy execution", () => {
    expect(searchTransmuteOperations("diagram").map(({ code }) => code)).toEqual([
      "transmute.diagram.check",
      "transmute.diagram.render",
    ])
    expect(searchTransmuteOperations("hosted image", 1).map(({ code }) => code))
      .toEqual(["transmute.image.generate"])
    expect(() => searchTransmuteOperations("\0")).toThrow("[INVALID_SEARCH]")
  })

  test("rejects unknown fields and source text instead of evaluating it", () => {
    expect(() =>
      parseTransmuteOperationInput("transmute.diagram.check", {
        path: "flow.diagram.json",
        source: "await Bun.write('/tmp/executed', 'yes')",
      }),
    ).toThrow("[INVALID_OPERATION_INPUT]")
    expect(() =>
      parseTransmuteOperationInput("transmute.image.generate", {
        model: "other/provider-model",
        prompt: "anything",
      }),
    ).toThrow("[INVALID_OPERATION_INPUT]")
    expect(() =>
      parseTransmuteOperationInput("transmute.image.generate", {
        model: transmuteImageModels[0],
        prompt: "anything",
      }),
    ).toThrow("outputPath")
    expect(() =>
      parseTransmuteOperationInput("transmute.image.vectorize", {
        inputPath: "input.png",
        outputPath: "output.png",
      }),
    ).toThrow("must end in .svg")
  })

  test("executes a fixed local diagram adapter by exact code", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-operation-check-"))
    try {
      const path = join(root, "flow.diagram.json")
      const marker = join(root, "config-executed")
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          name: "flow",
          canvas: { width: 400, height: 200 },
          shapes: [
            {
              id: "one",
              type: "rect",
              x: 40,
              y: 40,
              width: 120,
              height: 80,
            },
          ],
        }),
      )
      await writeFile(
        join(root, "transmute.config.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {}\n`,
      )
      const admission = { assertions: 0, claims: [] as HostResourceClaim[][] }
      const result = await executeTransmuteOperation(
        "transmute.diagram.check",
        { path },
        { hostResourceCoordinator: recordingCoordinator(admission) },
      )
      expect(result).toMatchObject({
        configPath: null,
        findings: expect.any(Array),
      })
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(admission.claims).toEqual([[
        { resource: "cpu", amount: 1 },
        { resource: "local-io", amount: 1 },
      ]])
      expect(admission.assertions).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not contact discovery or auth before local vectorization", async () => {
    const networkInputs: string[] = []
    const admission = { assertions: 0, claims: [] as HostResourceClaim[][] }
    await expect(
      executeTransmuteOperation(
        "transmute.image.vectorize",
        {
          inputPath: "/private/caller-owned.png",
          outputPath: "/private/caller-owned.svg",
        },
        {
          fetch: async (input) => {
            networkInputs.push(String(input))
            return new Response(null, { status: 500 })
          },
          hostResourceCoordinator: recordingCoordinator(admission),
          secrets: {
            get: async () => null,
            set: async () => undefined,
            delete: async () => false,
          },
        },
      ),
    ).rejects.toThrow()
    expect(networkInputs).toEqual([])
    expect(admission.claims).toEqual([[
      { resource: "cpu", amount: 1 },
      { resource: "local-io", amount: 1 },
    ]])
  })

  test("exposes callback-scoped inherited authority for custom direct surfaces", async () => {
    const admission = { assertions: 0, claims: [] as HostResourceClaim[][] }
    const descriptor = await withTransmuteOperationHostAdmission(
      "transmute.image.vectorize",
      lease => lease.inheritedFileDescriptor,
      { hostResourceCoordinator: recordingCoordinator(admission, 91) },
    )
    expect(descriptor).toBe(91)
    expect(admission.claims).toEqual([[
      { resource: "cpu", amount: 1 },
      { resource: "local-io", amount: 1 },
    ]])
    expect(admission.assertions).toBe(1)
  })

  test("requires inherited authority to cover every operation-owned claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-operation-lease-"))
    let assertions = 0
    const profile = {
      capacities: [
        { limit: 4, resource: "cpu" },
        { limit: 4, resource: "local-io" },
        { limit: 4, resource: "network" },
      ],
      id: "transmute.operation-lease-test/v1",
    } as const
    const lease = (claims: readonly HostResourceClaim[]): HostResourceLease => ({
      assertOwned: () => {
        assertions += 1
        return Promise.resolve()
      },
      claims,
      inheritedFileDescriptor: 72,
      profile,
      ticket: String(assertions + 1),
    })
    try {
      const path = join(root, "flow.diagram.json")
      await writeFile(path, JSON.stringify({
        canvas: { height: 200, width: 400 },
        edges: [],
        name: "flow",
        shapes: [],
        version: 1,
      }))
      await expect(executeTransmuteOperationWithLease(
        "transmute.diagram.check",
        { path },
        lease([{ amount: 1, resource: "network" }]),
      )).rejects.toThrow("does not cover cpu:1, local-io:1")
      await expect(executeTransmuteOperationWithLease(
        "transmute.diagram.check",
        { path },
        lease([{ amount: 1, resource: "cpu" }]),
      )).rejects.toThrow("does not cover local-io:1")
      await expect(executeTransmuteOperationWithLease(
        "transmute.diagram.check",
        { path },
        lease([
          { amount: 2, resource: "cpu" },
          { amount: -1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ]),
      )).rejects.toThrow("contains invalid claims")

      const checked = await executeTransmuteOperationWithLease(
        "transmute.diagram.check",
        { path },
        lease([
          { amount: 2, resource: "cpu" },
          { amount: 1, resource: "local-io" },
          { amount: 1, resource: "network" },
        ]),
      )
      expect(checked.configPath).toBeNull()
      expect(assertions).toBe(4)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
