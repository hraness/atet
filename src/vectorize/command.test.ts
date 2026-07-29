import { expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  runBoundedCommand,
  runBoundedPathOutputCommand,
} from "./command.ts"
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
  const work = await mkdtemp(join(tmpdir(), "transmute-command-kill-"))
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

test("bounded pathname output streams through a portable private endpoint", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-output-"))
  let outputPath: string | undefined
  try {
    const program = [
      "const output = process.argv[1]",
      'await Bun.write(output, "<svg>portable</svg>")',
      'console.log("traced")',
    ].join(";")
    const result = await runBoundedPathOutputCommand(
      (path) => {
        outputPath = path
        return [process.execPath, "-e", program, path]
      },
      1_000,
      "trace_failed",
      {
        maxOutputBytes: 1_024,
        temporaryRoot: work,
      },
    )
    expect(result).toEqual({
      output: "<svg>portable</svg>",
      stderr: "",
      stdout: "traced\n",
    })
    expect(outputPath).toBeDefined()
    await expect(lstat(outputPath!)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(work)).toEqual([])
  } finally {
    await rm(work, { force: true, recursive: true })
  }
})

test("bounded pathname output drains fast writers after process exit", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-output-exit-"))
  try {
    const program = [
      "const output = process.argv[1]",
      "const value = process.argv[2]",
      "await Bun.write(output, value)",
    ].join(";")
    for (let index = 0; index < 4; index += 1) {
      const expected = `<svg>${index}</svg>`
      const result = await runBoundedPathOutputCommand(
        (path) => [process.execPath, "-e", program, path, expected],
        1_000,
        "trace_failed",
        {
          maxOutputBytes: 1_024,
          temporaryRoot: work,
        },
      )
      expect(result.output).toBe(expected)
    }
    expect(await readdir(work)).toEqual([])
  } finally {
    await rm(work, { force: true, recursive: true })
  }
})

test("bounded pathname output stops at its streaming quota and cleans each endpoint", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-output-limit-"))
  let outputPath: string | undefined
  try {
    const program = [
      "const output = process.argv[1]",
      "const chunk = Buffer.alloc(1_024, 97)",
      "for (let index = 0; index < 1_000; index += 1) { await Bun.write(output, chunk); await Bun.sleep(2) }",
    ].join(";")
    await expect(
      runBoundedPathOutputCommand(
        (path) => {
          outputPath = path
          return [process.execPath, "-e", program, path]
        },
        5_000,
        "trace_failed",
        {
          maxOutputBytes: 4_096,
          temporaryRoot: work,
        },
      ),
    ).rejects.toMatchObject({
      code: "output_limit",
      details: {
        bytes: 4_097,
        maximumBytes: 4_096,
      },
    })
    expect(outputPath).toBeDefined()
    await expect(lstat(outputPath!)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(work)).toEqual([])
  } finally {
    await rm(work, { force: true, recursive: true })
  }
})

test("bounded pathname cleanup refuses a replaced output inode", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-output-race-"))
  let outputPath: string | undefined
  try {
    const program = [
      'const { chmod, unlink } = await import("node:fs/promises")',
      'const { dirname } = await import("node:path")',
      "const output = process.argv[1]",
      "await chmod(dirname(output), 0o700)",
      "await unlink(output)",
      'await Bun.write(output, "replacement")',
    ].join(";")
    await expect(
      runBoundedPathOutputCommand(
        (path) => {
          outputPath = path
          return [process.execPath, "-e", program, path]
        },
        1_000,
        "trace_failed",
        {
          maxOutputBytes: 1_024,
          temporaryRoot: work,
        },
      ),
    ).rejects.toMatchObject({ code: "trace_failed" })
    expect(outputPath).toBeDefined()
    expect(await readFile(outputPath!, "utf8")).toBe("replacement")
  } finally {
    await rm(work, { force: true, recursive: true })
  }
})

test("bounded pathname cleanup never follows a replaced output directory", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-directory-race-"))
  const target = join(work, "unrelated-target")
  const targetOutput = join(target, "output.svg")
  let outputPath: string | undefined
  try {
    await mkdir(target, { mode: 0o755 })
    await chmod(target, 0o755)
    await writeFile(targetOutput, "unrelated")
    const program = [
      'const { chmod, rename, symlink } = await import("node:fs/promises")',
      'const { dirname } = await import("node:path")',
      "const output = process.argv[1]",
      "const directory = dirname(output)",
      "await chmod(directory, 0o700)",
      'await rename(directory, `${directory}-moved`)',
      `await symlink(${JSON.stringify(target)}, directory, "dir")`,
    ].join(";")
    await expect(
      runBoundedPathOutputCommand(
        (path) => {
          outputPath = path
          return [process.execPath, "-e", program, path]
        },
        1_000,
        "trace_failed",
        {
          maxOutputBytes: 1_024,
          temporaryRoot: work,
        },
      ),
    ).rejects.toMatchObject({ code: "trace_failed" })
    expect(outputPath).toBeDefined()
    expect((await lstat(dirname(outputPath!))).isSymbolicLink()).toBe(true)
    expect(await readFile(targetOutput, "utf8")).toBe("unrelated")
    expect((await lstat(target)).mode & 0o777).toBe(0o755)
  } finally {
    await rm(work, { force: true, recursive: true })
  }
})

test("bounded commands terminate descendants in the isolated process tree", async () => {
  const work = await mkdtemp(join(tmpdir(), "transmute-command-tree-"))
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

test("bounded commands reap background descendants after a successful leader exit", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-success-tree-"))
  const childPidPath = join(work, "child-pid")
  let childPid: number | undefined
  try {
    const childProgram = [
      'process.on("SIGTERM", () => {})',
      `await Bun.write(${JSON.stringify(childPidPath)}, String(process.pid))`,
      "await Bun.sleep(10_000)",
    ].join(";")
    const parentProgram = [
      `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childProgram)}], { stderr: "inherit", stdin: "ignore", stdout: "inherit" })`,
      "child.unref()",
      `for (let attempt = 0; attempt < 200 && !(await Bun.file(${JSON.stringify(childPidPath)}).exists()); attempt += 1) await Bun.sleep(10)`,
      `if (!(await Bun.file(${JSON.stringify(childPidPath)}).exists())) process.exit(4)`,
    ].join(";")
    await runBoundedCommand(
      [process.execPath, "-e", parentProgram],
      5_000,
      "trace_failed",
    )
    childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10)
    await waitUntilGone(childPid)
  } finally {
    if (childPid !== undefined) {
      try {
        process.kill(childPid, "SIGKILL")
      } catch {
        // The expected path: successful command cleanup removed the descendant.
      }
    }
    await rm(work, { force: true, recursive: true })
  }
}, 10_000)

test("worker-local command cleanup kills the tracer's private process tree", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-worker-tree-"))
  const tracerPidPath = join(work, "tracer-pid")
  const descendantPidPath = join(work, "descendant-pid")
  const pids: number[] = []
  try {
    const descendantProgram = [
      'process.on("SIGTERM", () => {})',
      `await Bun.write(${JSON.stringify(descendantPidPath)}, String(process.pid))`,
      "await Bun.sleep(10_000)",
    ].join(";")
    const tracerProgram = [
      'process.on("SIGTERM", () => {})',
      `await Bun.write(${JSON.stringify(tracerPidPath)}, String(process.pid))`,
      `Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantProgram)}], { stderr: "ignore", stdin: "ignore", stdout: "ignore" })`,
      `for (let attempt = 0; attempt < 100 && !(await Bun.file(${JSON.stringify(descendantPidPath)}).exists()); attempt += 1) await Bun.sleep(10)`,
      `if (!(await Bun.file(${JSON.stringify(descendantPidPath)}).exists())) process.exit(4)`,
      "const chunk = Buffer.alloc(1_024, 97)",
      "for (let index = 0; index < 1_000; index += 1) { await Bun.write(Bun.stdout, chunk) }",
    ].join(";")
    const harnessProgram = [
      'import { forwardVectorizeWorkerTermination, runBoundedCommand } from "./src/vectorize/command.ts"',
      "forwardVectorizeWorkerTermination()",
      `try { await runBoundedCommand([process.execPath, "-e", ${JSON.stringify(tracerProgram)}], 15_000, "trace_failed", { maxStdoutBytes: 4_096 }); process.exit(2) } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "output_limit")) { console.error(error); process.exit(3) } }`,
    ].join(";")
    const harness = Bun.spawn(
      [process.execPath, "-e", harnessProgram],
      {
        cwd: process.cwd(),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      },
    )
    const [exitCode, stderr] = await Promise.all([
      harness.exited,
      new Response(harness.stderr).text(),
      new Response(harness.stdout).text(),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    pids.push(
      Number.parseInt(await readFile(tracerPidPath, "utf8"), 10),
      Number.parseInt(await readFile(descendantPidPath, "utf8"), 10),
    )
    await Promise.all(pids.map(waitUntilGone))
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The expected path: the worker-local command group removed the tree.
      }
    }
    await rm(work, { force: true, recursive: true })
  }
}, 20_000)

test("worker termination forwards a supervisor signal to active command groups", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-forward-signal-"))
  const tracerPidPath = join(work, "tracer-pid")
  const descendantPidPath = join(work, "descendant-pid")
  const readyPath = join(work, "ready")
  const pids: number[] = []
  let harness: ReturnType<typeof Bun.spawn> | undefined
  try {
    const descendantProgram = [
      `await Bun.write(${JSON.stringify(descendantPidPath)}, String(process.pid))`,
      "await Bun.sleep(10_000)",
    ].join(";")
    const tracerProgram = [
      `await Bun.write(${JSON.stringify(tracerPidPath)}, String(process.pid))`,
      `Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantProgram)}], { stderr: "inherit", stdin: "ignore", stdout: "inherit" })`,
      `await Bun.write(${JSON.stringify(readyPath)}, "ready")`,
      "await Bun.sleep(10_000)",
    ].join(";")
    const harnessProgram = [
      'import { forwardVectorizeWorkerTermination, runBoundedCommand } from "./src/vectorize/command.ts"',
      "forwardVectorizeWorkerTermination()",
      `await runBoundedCommand([process.execPath, "-e", ${JSON.stringify(tracerProgram)}], 15_000, "trace_failed")`,
    ].join(";")
    harness = Bun.spawn(
      [process.execPath, "-e", harnessProgram],
      {
        cwd: process.cwd(),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      },
    )
    await Promise.all([
      waitForFile(readyPath),
      waitForFile(tracerPidPath),
      waitForFile(descendantPidPath),
    ])
    pids.push(
      Number.parseInt(await readFile(tracerPidPath, "utf8"), 10),
      Number.parseInt(await readFile(descendantPidPath, "utf8"), 10),
    )
    process.kill(harness.pid, "SIGTERM")
    expect(await harness.exited).toBe(143)
    await Promise.all(pids.map(waitUntilGone))
  } finally {
    if (harness !== undefined && harness.exitCode === null) {
      try {
        harness.kill("SIGKILL")
      } catch {
        // The expected path: the forwarding handler already exited.
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The expected path: signal forwarding removed each command group.
      }
    }
    await rm(work, { force: true, recursive: true })
  }
}, 20_000)

test("spawn permission failures are normalized as VectorizeError", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-command-eacces-"))
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

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await lstat(path)
      return
    } catch {
      await Bun.sleep(10)
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}
