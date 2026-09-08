import assert from "node:assert/strict"

export const previewBrowserCloseMs = 5_000

export function assertOwnedPreviewEndpoint(bytes: Uint8Array, endpoint: string): void {
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 1024, "Invalid owned Chrome endpoint size")
  const match = /^(\d{1,5})\n(\/devtools\/browser\/[a-f0-9-]+)\n?$/u.exec(Buffer.from(bytes).toString())
  assert.ok(match !== null && Number(match[1]) > 0 && Number(match[1]) <= 65535, "Invalid owned Chrome endpoint")
  assert.equal(`ws://127.0.0.1:${Number(match[1])}${match[2]}`, endpoint,
    "Chrome endpoint no longer matches the parent-owned profile")
}

interface ShutdownIo {
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
}

interface OwnedBrowserShutdown {
  readonly signal: AbortSignal
  readonly proveOwnership: () => Promise<void>
  readonly createSession: () => Promise<{ send(method: "Browser.close"): Promise<unknown> }>
  readonly disconnect: () => Promise<void>
}

/** One graceful close, then one transport disconnect, under the existing
 * absolute protocol-close budget. Parent process custody remains independent. */
export function createPreviewBrowserShutdown(io: ShutdownIo) {
  return async (browser: OwnedBrowserShutdown): Promise<void> => {
    const deadline = io.now() + previewBrowserCloseMs
    const failures: unknown[] = []
    const timedOut = () => new Error(`Browser protocol close exceeded ${previewBrowserCloseMs}ms`)
    const withinBudget = <T>(running: Promise<T>, observeCancellation: boolean): Promise<T> => new Promise((resolve, reject) => {
      let finished = false
      let cancelTimer = () => {}
      const finish = (result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }) => {
        if (finished) return
        finished = true
        cancelTimer()
        browser.signal.removeEventListener("abort", abort)
        if (result.ok) resolve(result.value)
        else reject(result.error)
      }
      const fail = (error: unknown) => finish({ ok: false, error })
      const abort = () => fail(browser.signal.reason)
      cancelTimer = io.schedule(() => fail(timedOut()), Math.max(0, deadline - io.now()))
      if (observeCancellation) browser.signal.addEventListener("abort", abort, { once: true })
      void running.then(value => {
        if (finished) return
        if (observeCancellation && browser.signal.aborted) abort()
        else if (io.now() >= deadline) fail(timedOut())
        else finish({ ok: true, value })
      }, fail)
      if (observeCancellation && browser.signal.aborted) abort()
      else if (io.now() >= deadline) fail(timedOut())
    })
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      browser.signal.throwIfAborted()
      if (io.now() >= deadline) throw timedOut()
      return withinBudget(Promise.resolve().then(() => {
        browser.signal.throwIfAborted()
        if (io.now() >= deadline) throw timedOut()
        return operation()
      }), true)
    }
    try {
      await step(browser.proveOwnership)
      const session = await step(browser.createSession)
      await step(() => session.send("Browser.close"))
    } catch (error) { failures.push(error) }
    // Disconnect remains an attempted cleanup even after cancellation or a
    // failed/timed-out send, but receives no new deadline or success waiver.
    try { await withinBudget(Promise.resolve().then(browser.disconnect), false) } catch (error) { failures.push(error) }
    if (browser.signal.aborted && !failures.includes(browser.signal.reason)) failures.push(browser.signal.reason)
    if (failures.length > 0) throw new AggregateError(failures, "Owned Chrome graceful shutdown failed")
  }
}

export const closeOwnedPreviewBrowser = createPreviewBrowserShutdown({ now: () => performance.now(),
  schedule(callback, delayMs) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer) } })
