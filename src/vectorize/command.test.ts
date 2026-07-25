import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runBoundedCommand } from "./command.ts"
import { VectorizeError } from "./types.ts"

test("bounded commands terminate after the declared time limit", async () => {
  await expect(
    runBoundedCommand(
      [process.execPath, "-e", "await Bun.sleep(1_000)"],
      20,
      "trace_failed",
    ),
  ).rejects.toMatchObject({ code: "timeout" })
})

test("bounded commands escalate to SIGKILL and await process cleanup", async () => {
  const work = await mkdtemp(join(tmpdir(), "graphics-command-kill-"))
  const pidPath = join(work, "pid")
  let pid: number | undefined
  try {
    const program = [
      'process.on("SIGTERM", () => {})',
      `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))`,
      "await Bun.sleep(10_000)",
    ].join(";")
    const started = performance.now()
    await expect(
      runBoundedCommand(
        [process.execPath, "-e", program],
        1_000,
        "trace_failed",
      ),
    ).rejects.toMatchObject({ code: "timeout" })
    expect(performance.now() - started).toBeLessThan(2_500)
    pid = Number.parseInt(await readFile(pidPath, "utf8"), 10)
    expect(Number.isInteger(pid)).toBe(true)
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The expected path: cleanup already reaped the process.
      }
    }
    await rm(work, { force: true, recursive: true })
  }
})

test("bounded commands stop a growing primary-output stream", async () => {
  const program = [
    "const chunk = Buffer.alloc(1_024, 97)",
    "for (let index = 0; index < 1_000; index += 1) { await Bun.write(Bun.stdout, chunk); await Bun.sleep(2) }",
  ].join(";")
  await expect(
    runBoundedCommand(
      [process.execPath, "-e", program],
      5_000,
      "trace_failed",
      { maxStdoutBytes: 4_096 },
    ),
  ).rejects.toMatchObject({ code: "output_limit" })
})

test("bounded commands terminate descendants in the isolated process tree", async () => {
  const work = await mkdtemp(join(tmpdir(), "graphics-command-tree-"))
  const parentPidPath = join(work, "parent-pid")
  const childPidPath = join(work, "child-pid")
  const pids: number[] = []
  try {
    const childProgram = [
      'process.on("SIGTERM", () => {})',
      `await Bun.write(${JSON.stringify(childPidPath)}, String(process.pid))`,
      "await Bun.sleep(10_000)",
    ].join(";")
    const parentProgram = [
      'process.on("SIGTERM", () => {})',
      `await Bun.write(${JSON.stringify(parentPidPath)}, String(process.pid))`,
      `Bun.spawn([process.execPath, "-e", ${JSON.stringify(childProgram)}], { stderr: "ignore", stdin: "ignore", stdout: "ignore" })`,
      "await Bun.sleep(10_000)",
    ].join(";")
    await expect(
      runBoundedCommand(
        [process.execPath, "-e", parentProgram],
        1_500,
        "trace_failed",
      ),
    ).rejects.toMatchObject({ code: "timeout" })
    pids.push(
      Number.parseInt(await readFile(parentPidPath, "utf8"), 10),
      Number.parseInt(await readFile(childPidPath, "utf8"), 10),
    )
    await Promise.all(pids.map(waitUntilGone))
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The expected path: process-tree cleanup removed it.
      }
    }
    await rm(work, { force: true, recursive: true })
  }
})

test("spawn permission failures are normalized as VectorizeError", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "graphics-command-eacces-"))
  try {
    const command = join(work, "not-executable")
    await writeFile(command, "#!/bin/sh\nexit 0\n")
    await chmod(command, 0o600)
    let caught: unknown
    try {
      await runBoundedCommand([command], 1_000, "trace_failed")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(VectorizeError)
    expect(caught).toMatchObject({ code: "trace_failed" })
  } finally {
    await rm(work, { force: true, recursive: true })
  }
})

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(10)
    } catch {
      return
    }
  }
  throw new Error(`process ${pid} survived bounded-command cleanup`)
}
