import { expect, test } from "bun:test"
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runBoundedPathOutputCommand } from "./command.ts"
import { VectorizeDeadline } from "./limits.ts"
import { sha256 } from "./metrics.ts"
import { ensureVTracer } from "./tool.ts"

test("a conversion executes a private verified copy after the override path changes", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-tool-private-"))
  const previousOverride = process.env.TRANSMUTE_VTRACER_PATH
  try {
    const source = join(work, "vtracer")
    const original = mockVTracer("original")
    await writeFile(source, original)
    await chmod(source, 0o700)
    const sourceLink = join(work, "vtracer-link")
    await symlink(source, sourceLink)
    process.env.TRANSMUTE_VTRACER_PATH = sourceLink

    const privateDirectory = join(work, "private")
    const tool = await ensureVTracer(
      new VectorizeDeadline(5_000),
      privateDirectory,
    )
    expect(tool.path).not.toBe(source)
    expect(tool.path.startsWith(`${privateDirectory}/`)).toBe(true)
    expect(tool.sha256).toBe(sha256(original))

    await writeFile(source, mockVTracer("replacement"))
    const result = await runBoundedPathOutputCommand(
      (outputPath) => [
        tool.path,
        "--input",
        "ignored",
        "--output",
        outputPath,
      ],
      1_000,
      "trace_failed",
      {
        maxOutputBytes: 64,
        temporaryRoot: work,
      },
    )
    expect(result.output).toBe("original")
    expect(sha256(await readFile(tool.path))).toBe(tool.sha256)
  } finally {
    if (previousOverride === undefined) delete process.env.TRANSMUTE_VTRACER_PATH
    else process.env.TRANSMUTE_VTRACER_PATH = previousOverride
    await rm(work, { force: true, recursive: true })
  }
})

test("a FIFO tool override is rejected without blocking", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "transmute-tool-fifo-"))
  const previousOverride = process.env.TRANSMUTE_VTRACER_PATH
  try {
    const source = join(work, "vtracer")
    expect(Bun.spawnSync(["mkfifo", source]).exitCode).toBe(0)
    process.env.TRANSMUTE_VTRACER_PATH = source
    const started = performance.now()
    await expect(
      ensureVTracer(new VectorizeDeadline(500), join(work, "private")),
    ).rejects.toMatchObject({ code: "tool_version" })
    expect(performance.now() - started).toBeLessThan(400)
  } finally {
    if (previousOverride === undefined) delete process.env.TRANSMUTE_VTRACER_PATH
    else process.env.TRANSMUTE_VTRACER_PATH = previousOverride
    await rm(work, { force: true, recursive: true })
  }
})

function mockVTracer(marker: string): string {
  return [
    "#!/usr/bin/env bun",
    "const args = process.argv.slice(2)",
    `if (args.includes("--version")) { console.log("VTracer 0.6.4 ${marker}"); process.exit(0) }`,
    'const output = args[args.indexOf("--output") + 1]',
    "if (output === undefined) process.exit(2)",
    `await Bun.write(output, ${JSON.stringify(marker)})`,
    "",
  ].join("\n")
}
