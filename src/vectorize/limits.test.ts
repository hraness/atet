import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { resolveVectorizeLimits, vectorizeHardLimits } from "./limits.ts"
import { normalizedPixelToolchain, sharpProvenance } from "./pixels.ts"
import { canonicalizeVTracerSvg } from "./svg.ts"
import { VectorizeError } from "./types.ts"
import { vectorizeImage } from "./vectorize.ts"

test("caller limits may tighten but never exceed hard bounds", () => {
  expect(resolveVectorizeLimits({ maxPaths: 12 })).toMatchObject({ maxPaths: 12 })
  expect(() =>
    resolveVectorizeLimits({ maxDurationMs: vectorizeHardLimits.maxDurationMs + 1 }),
  ).toThrow(/no greater than/)
})

test("input byte and decoded-dimension limits fail before tool acquisition", async () => {
  if (process.platform === "win32") return
  const png = await sharp({
    create: {
      background: { alpha: 1, b: 0, g: 0, r: 255 },
      channels: 4,
      height: 2,
      width: 2,
    },
  })
    .png()
    .toBuffer()
  await expect(
    vectorizeImage(png, { limits: { maxInputBytes: png.length - 1 } }),
  ).rejects.toMatchObject({ code: "input_limit" })
  await expect(
    vectorizeImage(png, { limits: { maxDimension: 1 } }),
  ).rejects.toMatchObject({ code: "input_limit" })
})

test("canonicalization stops at the path limit", () => {
  expect(() =>
    canonicalizeVTracerSvg(
      '<svg><path d="M0 0z" fill="#000"/><path d="M1 1z" fill="#fff"/></svg>',
      2,
      2,
      1,
    ),
  ).toThrow(VectorizeError)
})

test("pixel-toolchain provenance is complete, sorted, and fail-closed", () => {
  expect(normalizedPixelToolchain({ vips: "8.17.3", sharp: "0.35.3" })).toEqual({
    sharp: "0.35.3",
    vips: "8.17.3",
  })
  expect(() => normalizedPixelToolchain({})).toThrow(/nonempty strings/)
  expect(() => normalizedPixelToolchain({ sharp: "" })).toThrow(/nonempty strings/)
  const provenance = sharpProvenance()
  const names = Object.keys(provenance.sharpVersions)
  expect(names).toEqual([...names].sort())
  expect(provenance.sharpVersions.sharp).toBe(provenance.sharp)
  expect(provenance.sharpVersions.vips).toBe(provenance.vips)
  expect(Object.isFrozen(provenance.sharpVersions)).toBe(true)
})

test("nonregular input is rejected without blocking on a FIFO", async () => {
  if (process.platform === "win32") return
  const work = await mkdtemp(join(tmpdir(), "graphics-input-fifo-"))
  try {
    const fifo = join(work, "input.png")
    const created = Bun.spawnSync(["mkfifo", fifo])
    expect(created.exitCode).toBe(0)
    await expect(
      vectorizeImage(fifo, { limits: { maxDurationMs: 1_000 } }),
    ).rejects.toMatchObject({ code: "invalid_input" })
  } finally {
    await rm(work, { force: true, recursive: true })
  }
})
