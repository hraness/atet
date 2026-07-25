import { expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { vectorizeImage } from "./vectorize.ts"

test("Windows fails closed before raster or VTracer work", async () => {
  if (process.platform !== "win32") return
  await expect(
    vectorizeImage(Uint8Array.of(0), {
      cacheDirectory: "must-not-be-touched",
    }),
  ).rejects.toMatchObject({ code: "tool_platform" })
})

test("vectorizes a raster through a compatible override with a deterministic receipt", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "graphics-vectorize-test-"))
  const previousOverride = process.env.GRAPHICS_VTRACER_PATH
  try {
    const mock = join(work, "vtracer")
    await writeFile(
      mock,
      [
        "#!/usr/bin/env bun",
        'const args = process.argv.slice(2)',
        'if (args.includes("--version")) { console.log("VTracer 0.6.4"); process.exit(0) }',
        'const output = args[args.indexOf("--output") + 1]',
        "if (output === undefined) process.exit(2)",
        "await Bun.write(output, '<svg><path d=\"M0 0h1v1H0z\" fill=\"#ff0000\"/><path d=\"M1 0h1v1H1z\" fill=\"#0000ff\"/></svg>')",
        "",
      ].join("\n"),
    )
    await chmod(mock, 0o755)
    process.env.GRAPHICS_VTRACER_PATH = mock

    const input = join(work, "input.png")
    const output = join(work, "output.svg")
    await sharp(
      Uint8Array.from([
        255, 0, 0, 255,
        0, 0, 255, 255,
      ]),
      { raw: { channels: 4, height: 1, width: 2 } },
    )
      .png()
      .toFile(input)
    const inputLink = join(work, "input-link.png")
    await symlink(input, inputLink)
    await writeFile(output, "stale")

    const result = await vectorizeImage(inputLink, {
      duotone: ["#111", "#eee"],
      outputPath: output,
    })
    expect(result.outputPath).toBe(output)
    expect(result.receipt).toMatchObject({
      bytes: result.svg.length,
      height: 1,
      outputMode: "duotone",
      pathCount: 2,
      profile: "balanced",
      receiptVersion: 1,
      representation: "color-paths",
      width: 2,
    })
    expect(result.receipt.provenance).toMatchObject({
      sharpVersions: {
        sharp: result.receipt.provenance.sharp,
        vips: result.receipt.provenance.vips,
      },
      vtracerSource: "override",
      vtracerVersion: "0.6.4",
    })
    expect(Object.keys(result.receipt.provenance.sharpVersions)).toEqual(
      [...Object.keys(result.receipt.provenance.sharpVersions)].sort(),
    )
    expect(result.receipt.quality.colorRmse).toBe(0)
    expect(result.svg).toContain('viewBox="0 0 2 1"')
    expect(result.svg).toContain('fill="#111111"')
    expect(result.svg).toContain('fill="#eeeeee"')
    expect(await readFile(output, "utf8")).toBe(result.svg)

    const cliOutput = join(work, "cli.svg")
    const cli = Bun.spawn(
      [
        process.execPath,
        "run",
        "./src/cli.ts",
        "vectorize",
        input,
        "--output",
        cliOutput,
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, GRAPHICS_VTRACER_PATH: mock },
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      cli.exited,
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      outputPath: cliOutput,
      receiptVersion: 1,
      width: 2,
    })
    expect(await readFile(cliOutput, "utf8")).toContain('viewBox="0 0 2 1"')
  } finally {
    if (previousOverride === undefined) delete process.env.GRAPHICS_VTRACER_PATH
    else process.env.GRAPHICS_VTRACER_PATH = previousOverride
    await rm(work, { force: true, recursive: true })
  }
})

test("the public conversion boundary enforces one wall-clock budget", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "graphics-vectorize-deadline-"))
  const previousOverride = process.env.GRAPHICS_VTRACER_PATH
  let tracerPid: number | undefined
  let conversionRoot: string | undefined
  try {
    const mock = join(work, "vtracer")
    const tracerPidPath = join(work, "tracer-pid")
    const temporaryRootPath = join(work, "temporary-root")
    await writeFile(
      mock,
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2)",
        `if (args.includes("--version")) { const { dirname } = await import("node:path"); await Bun.write(${JSON.stringify(tracerPidPath)}, String(process.pid)); await Bun.write(${JSON.stringify(temporaryRootPath)}, dirname(process.argv[1] ?? "")); while (true) {} }`,
        "process.exit(2)",
        "",
      ].join("\n"),
    )
    await chmod(mock, 0o755)
    process.env.GRAPHICS_VTRACER_PATH = mock
    const input = await sharp({
      create: {
        background: { alpha: 1, b: 0, g: 0, r: 255 },
        channels: 4,
        height: 8,
        width: 8,
      },
    })
      .png()
      .toBuffer()

    const started = performance.now()
    await expect(
      vectorizeImage(input, { limits: { maxDurationMs: 1_000 } }),
    ).rejects.toMatchObject({ code: "timeout" })
    expect(performance.now() - started).toBeLessThan(1_000)
    tracerPid = Number.parseInt(await readFile(tracerPidPath, "utf8"), 10)
    await waitUntilGone(tracerPid)
    conversionRoot = await readFile(temporaryRootPath, "utf8")
    expect(conversionRoot).toContain("graphics-vectorize-")
    await expect(lstat(conversionRoot)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    if (tracerPid !== undefined) {
      try {
        process.kill(tracerPid, "SIGKILL")
      } catch {
        // The expected path: worker process-group cleanup removed the tracer.
      }
    }
    if (conversionRoot !== undefined) {
      await rm(conversionRoot, { force: true, recursive: true })
    }
    if (previousOverride === undefined) delete process.env.GRAPHICS_VTRACER_PATH
    else process.env.GRAPHICS_VTRACER_PATH = previousOverride
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
  throw new Error(`process ${pid} survived worker process-group cleanup`)
}

test("raw tracer output is stopped at the streaming byte quota", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "graphics-vectorize-quota-"))
  const previousOverride = process.env.GRAPHICS_VTRACER_PATH
  try {
    const mock = join(work, "vtracer")
    await writeFile(
      mock,
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2)",
        'if (args.includes("--version")) { console.log("VTracer 0.6.4"); process.exit(0) }',
        'const output = args[args.indexOf("--output") + 1]',
        "if (output === undefined) process.exit(2)",
        'await Bun.write(output, `<svg>${"<path d=\\"M0 0z\\"/>".repeat(10_000)}</svg>`)',
        "",
      ].join("\n"),
    )
    await chmod(mock, 0o755)
    process.env.GRAPHICS_VTRACER_PATH = mock
    const input = await sharp({
      create: {
        background: { alpha: 1, b: 0, g: 0, r: 255 },
        channels: 4,
        height: 2,
        width: 2,
      },
    })
      .png()
      .toBuffer()

    let caught: unknown
    try {
      await vectorizeImage(input, {
        limits: {
          maxDurationMs: 5_000,
          maxOutputBytes: 1_024,
        },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: "quality_limit" })
    expect(JSON.stringify(caught)).toContain("too much primary output")
  } finally {
    if (previousOverride === undefined) delete process.env.GRAPHICS_VTRACER_PATH
    else process.env.GRAPHICS_VTRACER_PATH = previousOverride
    await rm(work, { force: true, recursive: true })
  }
})
