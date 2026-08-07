import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createDefaultHostResourceCoordinator,
  createHostResourceCoordinator,
  createProcessLocalHostResourceCoordinator,
  defaultTransmuteHostResourceProfile,
  HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
  normalizeHostResourceClaims,
  normalizeHostResourceProfile,
  type HostResourceProfile,
} from "./host-resources.ts"
import { runBoundedCommand } from "./vectorize/command.ts"

function profile(
  capacities: Readonly<Record<string, number>>,
): HostResourceProfile {
  return normalizeHostResourceProfile({
    id: `test.${randomBytes(8).toString("hex")}/v1`,
    capacities: Object.entries(capacities).map(([resource, limit]) => ({
      resource,
      limit,
    })),
  })
}

function deferred(): Readonly<{
  promise: Promise<void>
  resolve: () => void
}> {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await Promise.resolve(promise)
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds
  while (!(await predicate())) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for deterministic coordinator state.")
    }
    await Bun.sleep(2)
  }
}

async function markerCount(stateRoot: string): Promise<number> {
  try {
    return (await readdir(stateRoot)).filter((name) => name.startsWith("lease-"))
      .length
  } catch {
    return 0
  }
}

async function temporaryStateRoot(): Promise<Readonly<{
  parent: string
  stateRoot: string
}>> {
  const parent = await mkdtemp(join(tmpdir(), "transmute-host-resources-"))
  return { parent, stateRoot: join(parent, "state") }
}

interface CapturedTimeout {
  readonly delayMilliseconds: number
  fire(): void
}

function captureTimeouts(): Readonly<{
  readonly scheduled: CapturedTimeout[]
  restore(): void
}> {
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: CapturedTimeout[] = []
  const handles: ReturnType<typeof setTimeout>[] = []
  globalThis.setTimeout = ((
    callback: (...arguments_: unknown[]) => void,
    delayMilliseconds = 0,
    ...arguments_: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const handle = originalSetTimeout(() => undefined, 60_000)
    handles.push(handle)
    scheduled.push({
      delayMilliseconds,
      fire: () => {
        clearTimeout(handle)
        callback(...arguments_)
      },
    })
    return handle
  }) as typeof setTimeout
  return {
    scheduled,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout
      for (const handle of handles) clearTimeout(handle)
    },
  }
}

const describeMachineHostResources = process.platform === "darwin"
  || process.platform === "linux"
  ? describe
  : describe.skip
const testPosixShell = process.platform === "darwin" || process.platform === "linux"
  ? test
  : test.skip

describe("Transmute host-resource profiles", () => {
  test("process-local validation always rejects through the Promise contract", async () => {
    const coordinator = createProcessLocalHostResourceCoordinator({
      profile: profile({ cpu: 1 }),
    })
    const invalidClaims = coordinator.withLease(
      [{ amount: 2, resource: "cpu" }],
      () => undefined,
    )
    expect(invalidClaims).toBeInstanceOf(Promise)
    await expect(invalidClaims).rejects.toMatchObject({
      code: "INVALID_CLAIMS",
    })

    const invalidWait = coordinator.withLease(
      [{ amount: 1, resource: "cpu" }],
      () => undefined,
      { waitTimeoutMilliseconds: 0 },
    )
    expect(invalidWait).toBeInstanceOf(Promise)
    await expect(invalidWait).rejects.toMatchObject({
      code: "INVALID_CLAIMS",
    })
  })

  test("normalizes strict profiles and permits a fenced zero-claim lease", async () => {
    const normalized = normalizeHostResourceProfile({
      id: "test.normalized/v1",
      capacities: [
        { resource: "network", limit: 2 },
        { resource: "cpu", limit: 1 },
      ],
    })
    expect(normalized.capacities).toEqual([
      { resource: "cpu", limit: 1 },
      { resource: "network", limit: 2 },
    ])
    expect(Object.isFrozen(normalized.capacities)).toBe(true)
    expect(normalizeHostResourceClaims([], normalized)).toEqual([])
    expect(() => normalizeHostResourceClaims([
      { resource: "cpu", amount: 2 },
    ], normalized)).toThrow("exceeds its profile limit")
    expect(() => normalizeHostResourceProfile({
      id: "test.duplicate/v1",
      capacities: [
        { resource: "cpu", limit: 1 },
        { resource: "cpu", limit: 1 },
      ],
    })).toThrow("malformed or duplicated")

    const local = createProcessLocalHostResourceCoordinator({
      profile: normalized,
    })
    await expect(local.withLease([], async (lease) => {
      await lease.assertOwned()
      expect(lease.claims).toEqual([])
      expect(lease.inheritedFileDescriptor).toBeGreaterThanOrEqual(0)
      return "fenced"
    })).resolves.toBe("fenced")
  })

  test("reserves one logical processor on two-vCPU hosts", () => {
    expect(defaultTransmuteHostResourceProfile(2).capacities).toContainEqual({
      resource: "cpu",
      limit: 1,
    })
  })

  test("keeps video encodes independently serialized by default", () => {
    expect(HOST_RESOURCE_MAX_WAIT_MILLISECONDS).toBe(86_400_000)
    const defaults = defaultTransmuteHostResourceProfile(12)
    expect(defaults.capacities).toContainEqual({
      resource: "video-encode",
      limit: 1,
    })
    expect(defaults.capacities).toContainEqual({
      resource: "ffmpeg",
      limit: 2,
    })
  })

  test("selects one shared process ceiling for unsupported-platform defaults", async () => {
    const sharedProfile = profile({ cpu: 1 })
    const first = createDefaultHostResourceCoordinator(
      { profile: sharedProfile },
      "win32",
    )
    const second = createDefaultHostResourceCoordinator(
      { profile: sharedProfile },
      "win32",
    )
    expect(first.scope).toBe("process")
    expect(second.scope).toBe("process")
    const release = deferred()
    let firstEntered = false
    let secondEntered = false
    const firstRun = first.withLease([{ resource: "cpu", amount: 1 }], async () => {
      firstEntered = true
      await release.promise
    })
    await waitUntil(() => firstEntered)
    const secondRun = second.withLease([{ resource: "cpu", amount: 1 }], async () => {
      secondEntered = true
    })
    await Bun.sleep(15)
    expect(secondEntered).toBe(false)
    release.resolve()
    await Promise.all([firstRun, secondRun])
    expect(secondEntered).toBe(true)
  })

  testPosixShell("recovers process-local capacity after descriptor exhaustion", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "host-resources.ts")).href
    const childProgram = [
      "import { closeSync, constants, openSync } from 'node:fs'",
      `import { createProcessLocalHostResourceCoordinator } from ${JSON.stringify(moduleUrl)}`,
      "const coordinator = createProcessLocalHostResourceCoordinator({ profile: { id: 'test.descriptor-exhaustion/v1', capacities: [{ resource: 'cpu', limit: 1 }] }, waitTimeoutMilliseconds: 500 })",
      "const held = []",
      "while (true) { try { held.push(openSync('/dev/null', constants.O_RDONLY)) } catch { break } }",
      "const first = await coordinator.withLease([{ resource: 'cpu', amount: 1 }], () => 'unexpected').then(value => ({ value }), error => ({ cause: error.cause?.code, code: error.code }))",
      "closeSync(held.pop())",
      "const second = await coordinator.withLease([{ resource: 'cpu', amount: 1 }], async lease => { await lease.assertOwned(); return 'recovered' })",
      "console.log(JSON.stringify({ first, second }))",
      "for (const descriptor of held) { try { closeSync(descriptor) } catch {} }",
    ].join(";")
    const child = Bun.spawn([
      "/bin/sh",
      "-c",
      "ulimit -n 64 2>/dev/null || true; exec \"$1\" -e \"$2\"",
      "transmute-host-resource-test",
      process.execPath,
      childProgram,
    ], {
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    })
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      first: { cause: "EMFILE", code: "UNSAFE_STATE" },
      second: "recovered",
    })
  })
})

describeMachineHostResources("machine-global Transmute host-resource coordination", () => {
  test("desynchronizes ticket retries within adaptive bounds and aborts a parked wait", async () => {
    const temporary = await temporaryStateRoot()
    const sharedProfile = profile({ cpu: 1 })
    const coordinator = createHostResourceCoordinator({
      pollIntervalMilliseconds: 25,
      profile: sharedProfile,
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 2_000,
    })
    const smallPollCoordinator = createHostResourceCoordinator({
      pollIntervalMilliseconds: 2,
      profile: sharedProfile,
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 2_000,
    })
    const release = deferred()
    let holderEntered = false
    const retryDelays: number[][] = []
    let holder: Promise<void> | undefined
    try {
      holder = coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => {
          holderEntered = true
          await release.promise
        },
      )
      await waitUntil(() => holderEntered)

      for (const waitingCoordinator of [
        coordinator,
        coordinator,
        smallPollCoordinator,
      ]) {
        const controller = new AbortController()
        const captured = captureTimeouts()
        let callbackEntered = false
        let waiting: Promise<void> | undefined
        try {
          waiting = waitingCoordinator.withLease(
            [{ resource: "cpu", amount: 1 }],
            () => {
              callbackEntered = true
            },
            { signal: controller.signal },
          )
          for (let retry = 0; retry < 4; retry += 1) {
            await waitUntil(() => captured.scheduled.length > retry)
            if (retry < 3) captured.scheduled[retry]?.fire()
          }
          retryDelays.push(captured.scheduled.slice(0, 4).map(
            ({ delayMilliseconds }) => delayMilliseconds,
          ))
          controller.abort()
          captured.restore()
          expect(await rejection(waiting)).toMatchObject({ code: "WAIT_ABORTED" })
          expect(callbackEntered).toBe(false)
        } finally {
          controller.abort()
          captured.restore()
          await waiting?.catch(() => undefined)
        }
      }

      expect(retryDelays).toHaveLength(3)
      for (const delays of retryDelays.slice(0, 2)) {
        expect(delays[0]).toBeWithin(13, 26)
        expect(delays[1]).toBeWithin(25, 51)
        expect(delays[2]).toBeWithin(50, 101)
        expect(delays[3]).toBeWithin(100, 201)
      }
      expect(retryDelays[0]).not.toEqual(retryDelays[1])
      for (const delay of retryDelays[2] ?? []) {
        expect(delay).toBeWithin(1, 3)
      }
      release.resolve()
      await holder
    } finally {
      release.resolve()
      await holder?.catch(() => undefined)
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("resets adaptive delay when the relevant queue makes progress", async () => {
    const temporary = await temporaryStateRoot()
    const coordinator = createHostResourceCoordinator({
      pollIntervalMilliseconds: 25,
      profile: profile({ cpu: 2 }),
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 2_000,
    })
    const firstRelease = deferred()
    const secondRelease = deferred()
    let activeHolders = 0
    let captured: ReturnType<typeof captureTimeouts> | undefined
    const controller = new AbortController()
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    let waiting: Promise<void> | undefined
    try {
      first = coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => {
          activeHolders += 1
          await firstRelease.promise
        },
      )
      second = coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => {
          activeHolders += 1
          await secondRelease.promise
        },
      )
      await waitUntil(() => activeHolders === 2)
      const activeCapture = captureTimeouts()
      captured = activeCapture
      waiting = coordinator.withLease(
        [{ resource: "cpu", amount: 2 }],
        () => undefined,
        { signal: controller.signal },
      )
      await waitUntil(() => activeCapture.scheduled.length === 1)
      activeCapture.scheduled[0]?.fire()
      await waitUntil(() => activeCapture.scheduled.length === 2)
      activeCapture.scheduled[1]?.fire()
      await waitUntil(() => activeCapture.scheduled.length === 3)
      expect(activeCapture.scheduled[2]?.delayMilliseconds).toBeWithin(50, 101)

      firstRelease.resolve()
      await first
      activeCapture.scheduled[2]?.fire()
      await waitUntil(() => activeCapture.scheduled.length === 4)
      expect(activeCapture.scheduled[3]?.delayMilliseconds).toBeWithin(13, 26)

      controller.abort()
      activeCapture.restore()
      expect(await rejection(waiting)).toMatchObject({ code: "WAIT_ABORTED" })
      secondRelease.resolve()
      await second
    } finally {
      controller.abort()
      captured?.restore()
      await waiting?.catch(() => undefined)
      firstRelease.resolve()
      secondRelease.resolve()
      await Promise.allSettled([first, second].filter(
        (lease): lease is Promise<void> => lease !== undefined,
      ))
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("atomically admits vectors across separate coordinator instances", async () => {
    const temporary = await temporaryStateRoot()
    const sharedProfile = profile({ cpu: 2, "local-io": 1 })
    const options = {
      pollIntervalMilliseconds: 2,
      profile: sharedProfile,
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 2_000,
    } as const
    const first = createHostResourceCoordinator(options)
    const second = createHostResourceCoordinator(options)
    const release = deferred()
    let holding = false
    let vectorEntered = false
    try {
      const holder = first.withLease([{ resource: "cpu", amount: 1 }], async () => {
        holding = true
        await release.promise
      })
      await waitUntil(() => holding)
      const vector = second.withLease([{ resource: "cpu", amount: 2 }], async () => {
        vectorEntered = true
      })
      await waitUntil(async () => await markerCount(temporary.stateRoot) === 2)
      expect(vectorEntered).toBe(false)
      await expect(second.withLease(
        [{ resource: "local-io", amount: 1 }],
        async () => "disjoint",
      )).resolves.toBe("disjoint")
      expect(vectorEntered).toBe(false)
      release.resolve()
      await Promise.all([holder, vector])
      expect(vectorEntered).toBe(true)
    } finally {
      release.resolve()
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("serves overlapping tickets FIFO while allowing disjoint work through", async () => {
    const temporary = await temporaryStateRoot()
    const sharedProfile = profile({ cpu: 1, "local-io": 1, network: 1 })
    const options = {
      pollIntervalMilliseconds: 2,
      profile: sharedProfile,
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 3_000,
    } as const
    const first = createHostResourceCoordinator(options)
    const second = createHostResourceCoordinator(options)
    const holderRelease = deferred()
    const earlierRelease = deferred()
    const order: string[] = []
    try {
      const holder = first.withLease([{ resource: "cpu", amount: 1 }], async () => {
        order.push("holder")
        await holderRelease.promise
      })
      await waitUntil(() => order.includes("holder"))
      const earlier = second.withLease([
        { resource: "cpu", amount: 1 },
        { resource: "network", amount: 1 },
      ], async () => {
        order.push("earlier")
        await earlierRelease.promise
      })
      await waitUntil(async () => await markerCount(temporary.stateRoot) === 2)
      const laterOverlap = first.withLease(
        [{ resource: "network", amount: 1 }],
        async () => {
          order.push("later-overlap")
        },
      )
      await waitUntil(async () => await markerCount(temporary.stateRoot) === 3)
      await expect(second.withLease(
        [{ resource: "local-io", amount: 1 }],
        async () => "disjoint",
      )).resolves.toBe("disjoint")
      expect(order).toEqual(["holder"])
      holderRelease.resolve()
      await waitUntil(() => order.includes("earlier"))
      expect(order).toEqual(["holder", "earlier"])
      earlierRelease.resolve()
      await Promise.all([holder, earlier, laterOverlap])
      expect(order).toEqual(["holder", "earlier", "later-overlap"])
    } finally {
      holderRelease.resolve()
      earlierRelease.resolve()
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("does not release admitted capacity when its external signal aborts", async () => {
    const temporary = await temporaryStateRoot()
    const sharedProfile = profile({ cpu: 1 })
    const coordinator = createHostResourceCoordinator({
      pollIntervalMilliseconds: 2,
      profile: sharedProfile,
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 1_000,
    })
    const controller = new AbortController()
    const release = deferred()
    let entered = false
    try {
      const active = coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => {
          entered = true
          await release.promise
          return "settled"
        },
        { signal: controller.signal },
      )
      await waitUntil(() => entered)
      controller.abort()
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => "must wait",
        { waitTimeoutMilliseconds: 40 },
      )).rejects.toMatchObject({ code: "WAIT_TIMEOUT" })
      release.resolve()
      await expect(active).resolves.toBe("settled")
    } finally {
      release.resolve()
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("starts the callback when cancellation becomes visible only after admission", async () => {
    const temporary = await temporaryStateRoot()
    const sharedProfile = profile({ cpu: 1 })
    const coordinator = createHostResourceCoordinator({
      pollIntervalMilliseconds: 2,
      profile: sharedProfile,
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 2_000,
    })
    let callbackEntered = false
    const signal = {
      get aborted(): boolean {
        try {
          return readdirSync(temporary.stateRoot)
            .filter((name) => name.startsWith("lease-"))
            .some((name) => {
              const marker = JSON.parse(readFileSync(
                join(temporary.stateRoot, name),
                "utf8",
              )) as { readonly phase?: unknown }
              return marker.phase === "A"
            })
        } catch {
          return false
        }
      },
      addEventListener(): void {},
      removeEventListener(): void {},
    } as unknown as AbortSignal
    try {
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => {
          callbackEntered = true
          return "entered"
        },
        { signal },
      )).resolves.toBe("entered")
      expect(callbackEntered).toBe(true)
    } finally {
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("cancels a waiting ticket without invoking its callback", async () => {
    const temporary = await temporaryStateRoot()
    const coordinator = createHostResourceCoordinator({
      pollIntervalMilliseconds: 2,
      profile: profile({ cpu: 1 }),
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 1_000,
    })
    const release = deferred()
    const controller = new AbortController()
    let holderEntered = false
    let waitingInvoked = false
    try {
      const holder = coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => {
          holderEntered = true
          await release.promise
        },
      )
      await waitUntil(() => holderEntered)
      const waiting = coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => {
          waitingInvoked = true
        },
        { signal: controller.signal },
      )
      await waitUntil(async () => await markerCount(temporary.stateRoot) === 2)
      controller.abort()
      await expect(waiting).rejects.toMatchObject({ code: "WAIT_ABORTED" })
      expect(waitingInvoked).toBe(false)
      release.resolve()
      await holder
    } finally {
      release.resolve()
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("fails closed when processes declare different profiles", async () => {
    const temporary = await temporaryStateRoot()
    try {
      const first = createHostResourceCoordinator({
        profile: profile({ cpu: 1 }),
        stateRoot: temporary.stateRoot,
      })
      await first.withLease([], async () => undefined)
      const conflicting = createHostResourceCoordinator({
        profile: normalizeHostResourceProfile({
          id: first.profile.id,
          capacities: [{ resource: "cpu", limit: 2 }],
        }),
        stateRoot: temporary.stateRoot,
      })
      await expect(conflicting.withLease([], async () => undefined))
        .rejects.toMatchObject({ code: "PROFILE_MISMATCH" })
    } finally {
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("recovers a crash between private-root and profile initialization", async () => {
    const temporary = await temporaryStateRoot()
    const coordinator = createHostResourceCoordinator({
      profile: profile({ cpu: 1 }),
      stateRoot: temporary.stateRoot,
    })
    try {
      await mkdir(temporary.stateRoot, { mode: 0o700 })
      await writeFile(join(temporary.stateRoot, "control.lock"), "", {
        mode: 0o600,
      })
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => "initialized",
      )).resolves.toBe("initialized")
    } finally {
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("detects replacement of the exact descriptor-owned marker inode", async () => {
    const temporary = await temporaryStateRoot()
    const coordinator = createHostResourceCoordinator({
      profile: profile({ cpu: 1 }),
      stateRoot: temporary.stateRoot,
    })
    try {
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async (lease) => {
          const marker = (await readdir(temporary.stateRoot)).find(
            (name) => name.startsWith("lease-"),
          )
          if (marker === undefined) throw new Error("lease marker missing")
          const markerPath = join(temporary.stateRoot, marker)
          await rm(markerPath)
          await writeFile(markerPath, "", { mode: 0o600 })
          await lease.assertOwned()
        },
      )).rejects.toMatchObject({ code: "OWNERSHIP_LOST" })
    } finally {
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("recovers an abruptly lost process from its released kernel lock", async () => {
    const temporary = await temporaryStateRoot()
    const sharedProfile = profile({ cpu: 1 })
    const moduleUrl = pathToFileURL(join(import.meta.dir, "host-resources.ts")).href
    const program = [
      `import { createHostResourceCoordinator } from ${JSON.stringify(moduleUrl)}`,
      `const profile = ${JSON.stringify(sharedProfile)}`,
      "const coordinator = createHostResourceCoordinator({ profile, stateRoot: process.env.TRANSMUTE_TEST_STATE_ROOT, pollIntervalMilliseconds: 2, waitTimeoutMilliseconds: 2000 })",
      "await coordinator.withLease([{ resource: 'cpu', amount: 1 }], async () => { console.log('ready'); await new Promise(() => {}) })",
    ].join(";")
    const child = Bun.spawn([process.execPath, "-e", program], {
      env: {
        ...process.env,
        TRANSMUTE_TEST_STATE_ROOT: temporary.stateRoot,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    try {
      const reader = child.stdout.getReader()
      const ready = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(ready.value)).toContain("ready")
      const coordinator = createHostResourceCoordinator({
        pollIntervalMilliseconds: 2,
        profile: sharedProfile,
        stateRoot: temporary.stateRoot,
        waitTimeoutMilliseconds: 2_000,
      })
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => undefined,
        { waitTimeoutMilliseconds: 30 },
      )).rejects.toMatchObject({ code: "WAIT_TIMEOUT" })
      child.kill("SIGKILL")
      await child.exited
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async (lease) => {
          await lease.assertOwned()
          return "recovered"
        },
      )).resolves.toBe("recovered")
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {
        // The child may already have exited.
      }
      await child.exited.catch(() => undefined)
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("retains capacity until an explicitly inherited descriptor exits", async () => {
    const temporary = await temporaryStateRoot()
    const sharedProfile = profile({ cpu: 1 })
    const coordinator = createHostResourceCoordinator({
      pollIntervalMilliseconds: 2,
      profile: sharedProfile,
      stateRoot: temporary.stateRoot,
      waitTimeoutMilliseconds: 2_000,
    })
    let descendant: ReturnType<typeof Bun.spawn> | undefined
    try {
      await coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async (lease) => {
          descendant = Bun.spawn(
            [process.execPath, "-e", "await Bun.sleep(250)"],
            {
              stdio: [
                "ignore",
                "ignore",
                "ignore",
                lease.inheritedFileDescriptor,
              ],
            },
          )
        },
      )
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => "too early",
        { waitTimeoutMilliseconds: 35 },
      )).rejects.toMatchObject({ code: "WAIT_TIMEOUT" })
      await descendant?.exited
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async () => "after descendant",
      )).resolves.toBe("after descendant")
    } finally {
      descendant?.kill("SIGKILL")
      await descendant?.exited.catch(() => undefined)
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })

  test("maps lease authority through the worker and tracer descriptor chain", async () => {
    const temporary = await temporaryStateRoot()
    const coordinator = createHostResourceCoordinator({
      profile: profile({ cpu: 1 }),
      stateRoot: temporary.stateRoot,
    })
    const commandModule = pathToFileURL(
      join(import.meta.dir, "vectorize", "command.ts"),
    ).href
    const tracerProgram = [
      "import { fstatSync } from 'node:fs'",
      "if (!fstatSync(3)) process.exit(2)",
      "console.log('lease-held')",
    ].join(";")
    const workerProgram = [
      `import { runBoundedCommand, withInheritedCommandFileDescriptors } from ${JSON.stringify(commandModule)}`,
      `const tracer = ${JSON.stringify(tracerProgram)}`,
      "const result = await withInheritedCommandFileDescriptors([3], async () => await runBoundedCommand([process.execPath, '-e', tracer], 1000, 'trace_failed'))",
      "console.log(result.stdout.trim())",
    ].join(";")
    try {
      await expect(coordinator.withLease(
        [{ resource: "cpu", amount: 1 }],
        async (lease) => {
          const result = await runBoundedCommand(
            [process.execPath, "-e", workerProgram],
            2_000,
            "trace_failed",
            {
              inheritedFileDescriptors: [lease.inheritedFileDescriptor],
            },
          )
          return result.stdout.trim()
        },
      )).resolves.toBe("lease-held")
    } finally {
      await rm(temporary.parent, { recursive: true, force: true })
    }
  })
})
