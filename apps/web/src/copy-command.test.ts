import { afterEach, describe, expect, test } from "bun:test"
import { installCopyCommands } from "./copy-command"

// Exercise the real installed listener with finite DOM/clipboard/timer ports.
// This proves transitions and cleanup, not native DOM paint or clipboard access.
const restorations: Array<() => void> = []
afterEach(() => { for (const restore of restorations.splice(0).reverse()) restore() })
function globalPort(name: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  restorations.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  })
}

function fixture() {
  let click: (() => Promise<void>) | undefined
  let clock = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const writes: string[] = []
  let write: (value: string) => Promise<void> = async () => {}
  let exec: () => boolean = () => true
  let select: () => void = () => {}
  const attached: typeof clones = []
  const clones: Array<{ value: string; readOnly: boolean; className: string; removed: boolean; select(): void; setSelectionRange(start: number, end: number): void; remove(): void }> = []
  const selection: Array<readonly [number, number]> = []
  const status = { textContent: "" }
  const command = { textContent: "npx skills add https://github.com/hraness/atet/tree/v0.6.0 --skill atet" }
  const dataset: Record<string, string | undefined> = {
    copyIdleClass: "copy-command__button xIdle",
    copyCopiedClass: "copy-command__button xCopied",
    copyFailedClass: "copy-command__button xFailed",
  }
  const button = {
    hidden: true, textContent: "Copy", className: dataset.copyIdleClass, dataset, focusCalls: 0,
    focus() { this.focusCalls++ },
    addEventListener(event: string, listener: () => Promise<void>) { expect(event).toBe("click"); click = listener },
  }
  const textarea = {
    cloneNode(deep: boolean) {
      expect(deep).toBe(true)
      const node = {
        value: "", readOnly: true, className: "xOffscreen", removed: false,
        select() { select() },
        setSelectionRange(start: number, end: number) { selection.push([start, end]) },
        remove() { this.removed = true; attached.splice(attached.indexOf(this), 1) },
      }
      clones.push(node)
      return node
    },
  }
  const parts = new Map<string, unknown>([
    ["[data-copy-command-value]", command], ["[data-copy-command-button]", button],
    ["[data-copy-command-status]", status],
    ["template[data-copy-command-fallback]", { content: { querySelector: (selector: string) => { expect(selector).toBe("textarea"); return textarea } } }],
  ])
  let execCalls = 0
  const document = {
    querySelectorAll: (selector: string) => { expect(selector).toBe("[data-copy-command]"); return [{ querySelector: (key: string) => parts.get(key) ?? null }] },
    body: { append(node: (typeof clones)[number]) { attached.push(node) } },
    execCommand(action: string) { expect(action).toBe("copy"); execCalls++; return exec() },
  }
  globalPort("navigator", { clipboard: { async writeText(value: string) { writes.push(value); await write(value) } } })
  globalPort("window", {
    setTimeout(callback: () => void, milliseconds: number) { const id = ++nextTimer; timers.set(id, { at: clock + milliseconds, callback }); return id },
    clearTimeout(id: number) { timers.delete(id) },
  })
  return {
    button, command, status, parts, writes, timers, clones, attached, selection,
    install() { installCopyCommands(document as unknown as Document) },
    async click() { expect(click).toBeDefined(); await click?.() },
    writeWith(value: typeof write) { write = value }, execWith(value: typeof exec) { exec = value }, selectWith(value: typeof select) { select = value },
    execCalls: () => execCalls,
    advance(milliseconds: number) { clock += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback() } },
  }
}

describe("copy command real listener transitions (process-free)", () => {
  test("is hidden until its complete finite SSR class/template contract is available", () => {
    for (const key of ["[data-copy-command-value]", "[data-copy-command-button]", "[data-copy-command-status]", "template[data-copy-command-fallback]"]) {
      const f = fixture(); f.parts.delete(key); f.install(); expect(f.button.hidden).toBe(true)
    }
    for (const value of [undefined, "", "copy-command__button", 'copy-command__button x\" style=\"color:red', "copy-command__button x\nx2", "foreign x1"]) {
      for (const key of ["copyIdleClass", "copyCopiedClass", "copyFailedClass"]) {
        const f = fixture(); f.button.dataset[key] = value; f.install(); expect(f.button.hidden).toBe(true)
      }
    }
    const f = fixture(); f.install(); expect(f.button.hidden).toBe(false); expect(f.status.textContent).toBe(""); expect(f.writes).toEqual([])
  })

  test("copies exact text and preserves pending state, focus, live success and exact 2500ms reset", async () => {
    const f = fixture(); let release: (() => void) | undefined
    f.writeWith(() => new Promise<void>(resolve => { release = resolve })); f.install()
    const pending = f.click()
    expect(f.writes).toEqual([f.command.textContent]); expect(f.button.textContent).toBe("Copy")
    expect(f.button.className).toBe("copy-command__button xIdle"); expect(f.timers.size).toBe(0)
    expect(release).toBeDefined(); release?.(); await pending
    expect(f.button.textContent).toBe("Copied"); expect(f.button.dataset.copyState).toBe("copied")
    expect(f.button.className).toBe("copy-command__button xCopied"); expect(f.status.textContent).toBe("Install command copied.")
    expect(f.button.focusCalls).toBe(1); expect(f.execCalls()).toBe(0); expect(f.clones).toEqual([])
    f.advance(2499); expect(f.button.textContent).toBe("Copied")
    f.advance(1); expect(f.button.textContent).toBe("Copy"); expect(f.button.dataset.copyState).toBeUndefined()
    expect(f.button.className).toBe("copy-command__button xIdle"); expect(f.status.textContent).toBe(""); expect(f.timers.size).toBe(0)
  })

  test("a repeat activation cancels the old success reset and binds the replacement deadline", async () => {
    const f = fixture(); f.install(); await f.click(); f.advance(1000); await f.click()
    expect(f.timers.size).toBe(1); f.advance(1500); expect(f.button.dataset.copyState).toBe("copied")
    f.advance(1000); expect(f.button.dataset.copyState).toBeUndefined(); expect(f.writes).toHaveLength(2)
  })

  for (const outcome of ["success", "false", "throw", "selection-throw"] as const) {
    test(`clipboard rejection uses the compiled template and collects the fallback after ${outcome}`, async () => {
      const f = fixture(); f.writeWith(async () => { throw new Error("clipboard denied") })
      f.execWith(() => { if (outcome === "throw") throw new Error("legacy denied"); return outcome === "success" })
      if (outcome === "selection-throw") f.selectWith(() => { throw new Error("selection denied") })
      f.install(); await f.click()
      expect(f.clones).toHaveLength(1); expect(f.clones[0]).toMatchObject({ value: f.command.textContent, readOnly: true, className: "xOffscreen", removed: true })
      expect(f.attached).toEqual([]); expect(f.button.focusCalls).toBe(1)
      expect(f.execCalls()).toBe(outcome === "selection-throw" ? 0 : 1)
      expect(f.selection).toEqual(outcome === "selection-throw" ? [] : [[0, f.command.textContent.length]])
      if (outcome === "success") {
        expect(f.button.dataset.copyState).toBe("copied"); expect(f.button.className).toBe("copy-command__button xCopied")
      } else {
        expect(f.button.textContent).toBe("Copy"); expect(f.button.dataset.copyState).toBe("failed")
        expect(f.button.className).toBe("copy-command__button xFailed")
        expect(f.status.textContent).toBe("Could not copy the command. Select it and copy it manually.")
        expect(f.timers.size).toBe(0); f.advance(10_000); expect(f.button.dataset.copyState).toBe("failed")
      }
    })
  }

  test("a later failed copy cannot be cleared by a previous success timer; retry can succeed", async () => {
    const f = fixture(); f.install(); await f.click(); f.advance(1000)
    f.writeWith(async () => { throw new Error("denied") }); f.execWith(() => false); await f.click()
    expect(f.timers.size).toBe(0); f.advance(2500); expect(f.button.dataset.copyState).toBe("failed")
    f.writeWith(async () => {}); await f.click(); expect(f.button.className).toBe("copy-command__button xCopied")
    f.advance(2500); expect(f.button.className).toBe("copy-command__button xIdle")
  })
})
