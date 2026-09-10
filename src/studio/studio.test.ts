import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  inspectStudioBundle, inspectStudioPlan, parseStudioJob, parseStudioPlan, parseStudioReceipt, parseStudioRuntimeIdentity, parseStudioSourceBundle,
  planStudioJob, STUDIO_LIMITS, studioJobSha256, studioOutputPath, studioRuntimeSha256, studioSourceBundleSha256, validateStudioReceipt,
} from "./index.js"

const sha = (letter = "a") => letter.repeat(64)
const source = () => ({ kind: "slopcamera.studio-source-bundle", schemaVersion: 1, engine: "blender", entrypoint: { kind: "python", path: "main.py" }, files: [{ path: "main.py", sha256: sha(), bytes: 128 }] })
const raster = () => ({ kind: "raster", colorSpace: "srgb", alpha: "opaque", dataType: "uint8", channels: ["R", "G", "B"], semantic: "color", unit: "unitless" })
const job = () => ({
  kind: "slopcamera.studio-job", schemaVersion: 1, jobId: "studio_fixture", bundleSha256: studioSourceBundleSha256(source()), stage: "render", parameters: { title: "Native scene", radius: 2 },
  engine: { engine: "blender", renderer: "cycles", device: "cpu", samples: 16, transparent: false, viewTransform: "AgX", denoise: true, seed: 42 },
  render: { width: 960, height: 540, frameRate: { numerator: 24, denominator: 1 }, startFrame: 1, endFrameExclusive: 4 },
  outputs: [{ kind: "sequence", id: "beauty", pathPattern: "beauty/%06d.png", format: "png", role: "beauty", interpretation: raster() }],
  limits: { timeoutSeconds: 120, maximumOutputBytes: 1024 ** 2, maximumOutputFiles: 10 }, execution: { trust: "trusted-current-user", isolation: "none", hermetic: false },
})
const runtime = () => ({
  kind: "slopcamera.studio-runtime", schemaVersion: 1, engine: "blender", tool: { name: "Blender", version: "fixture", executableSha256: sha("b") }, driverSha256: sha("c"),
  environment: { fingerprintSha256: sha("d"), evidence: "observed-package-environment", hermetic: false },
  capabilities: ["python-authoring", "blend-authoring", "render", "build", "bake", "image-sequence", "native-cache", "gpu-render", "model-export", "beauty-video", "auxiliary-passes", "audio-output"].map(name => ({ name, support: "available", evidence: "probe" })),
})
const plan = () => planStudioJob({ bundle: source(), job: job(), runtime: runtime() })
const receipt = () => {
  const expected = plan()
  return { kind: "slopcamera.studio-receipt", schemaVersion: 1, jobId: expected.job.jobId, attemptId: "attempt_fixture", planSha256: expected.planSha256, bundleSha256: expected.bundleSha256,
    jobSha256: expected.jobSha256, runtime: expected.runtime, runtimeSha256: expected.runtimeSha256, startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z",
    state: "succeeded", custody: "closed", exitCode: 0,
    outputs: [1, 2, 3].map(frame => ({ outputId: "beauty", path: `beauty/${String(frame).padStart(6, "0")}.png`, sha256: sha(), bytes: 100, role: "beauty", format: "png", frame })),
  }
}

describe("portable studio source and identity", () => {
  test("parses without getters, prototype behavior, cycles, or unsupported values", () => {
    let invoked = false
    const getter = { ...source(), get surprise() { invoked = true; return 1 } }
    const cyclic: Record<string, unknown> = { ...source() }; cyclic.self = cyclic
    for (const value of [getter, Object.assign(Object.create({ inherited: true }) as object, source()), cyclic, { ...source(), unexpected: true }, { ...source(), files: [{ ...source().files[0], bytes: NaN }] }]) expect(() => parseStudioSourceBundle(value)).toThrow()
    expect(invoked).toBe(false)
    expect(inspectStudioBundle(source())).toMatchObject({ executed: false, dependencyDiscovery: "explicit-files-only" })
  })
  test.each(["../main.py", "/main.py", "a//main.py", "a/./main.py", "a/../main.py", "C:/main.py", "a\\main.py", "a /main.py", "a./main.py", "main.py\u0000"])("rejects unsafe path %s", path => {
    expect(() => parseStudioSourceBundle({ ...source(), entrypoint: { kind: "python", path }, files: [{ path, bytes: 1, sha256: sha() }] })).toThrow()
  })
  test("requires explicit entrypoint closure and unambiguous physical names", () => {
    for (const files of [[], [{ path: "other.py", bytes: 1, sha256: sha() }], [{ path: "main.py", bytes: 0, sha256: sha() }], [...source().files, { path: "MAIN.py", bytes: 1, sha256: sha() }], [...source().files, { path: "main.py-other", bytes: 1, sha256: sha() }, { path: "main.py/child", bytes: 1, sha256: sha() }]]) expect(() => parseStudioSourceBundle({ ...source(), files })).toThrow()
    expect(parseStudioSourceBundle({ ...source(), files: [...source().files, { path: "package/__init__.py", bytes: 0, sha256: sha() }] }).files).toHaveLength(2)
    expect(() => parseStudioSourceBundle({ ...source(), engine: "manim", entrypoint: { kind: "blend", path: "scene.blend" }, files: [{ path: "scene.blend", bytes: 1, sha256: sha() }] })).toThrow()
  })
  test("enforces aggregate source and collection budgets", () => {
    expect(() => parseStudioSourceBundle({ ...source(), files: [{ ...source().files[0], bytes: STUDIO_LIMITS.sourceBytes }, { path: "extra", bytes: 1, sha256: sha() }] })).toThrow()
    expect(() => parseStudioSourceBundle({ ...source(), files: Array.from({ length: 513 }, (_, index) => ({ path: index === 0 ? "main.py" : `file${index}`, bytes: 1, sha256: sha() })) })).toThrow()
  })
  test("bundle identity is permutation invariant, detached, and sensitive to every file fact", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 10000 }), { minLength: 1, maxLength: 20 }), values => {
      const input = { ...source(), files: [...source().files, ...values.map(value => ({ path: `inputs/file${value}`, bytes: value, sha256: sha() }))] }
      const parsed = parseStudioSourceBundle(input)
      expect(studioSourceBundleSha256(input)).toBe(studioSourceBundleSha256({ ...input, files: [...input.files].reverse() }))
      expect(parseStudioSourceBundle(parsed)).toEqual(parsed)
      expect(Object.isFrozen(parsed.files[0])).toBe(true)
      input.files[0]!.bytes += 1
      expect(studioSourceBundleSha256(input)).not.toBe(studioSourceBundleSha256(parsed))
    }), { seed: 6201, numRuns: 60 })
  })
})

describe("studio job admission", () => {
  test("normalizes rational cadence and retains explicit nonhermetic trust", () => {
    const expected = job(), equivalent = { ...expected, render: { ...expected.render, frameRate: { numerator: 24000, denominator: 1000 } } }
    expect(studioJobSha256(equivalent)).toBe(studioJobSha256(expected))
    expect(plan().readiness).toBe("authorization-required")
    expect(inspectStudioPlan(plan())).toMatchObject({ executed: false, frameCount: 3, outputCount: { minimum: 3, maximum: 3 }, execution: { hermetic: false, isolation: "none" } })
    for (const extra of [{ allowTrustedCode: true }, { arbitraryProviderOptions: {} }, { execution: { trust: "trusted-current-user", hermetic: true, isolation: "sandbox" } }]) expect(() => parseStudioJob({ ...job(), ...extra })).toThrow()
  })
  test("binds exact engine, source, and blend stage", () => {
    expect(() => planStudioJob({ bundle: source(), job: { ...job(), bundleSha256: sha("f") } })).toThrow("exact source")
    expect(() => planStudioJob({ bundle: source(), job: job(), runtime: { ...runtime(), engine: "manim" } })).toThrow("one engine")
    const bundle = { ...source(), entrypoint: { kind: "blend", path: "scene.blend" }, files: [{ path: "scene.blend", bytes: 1, sha256: sha() }] }
    expect(() => planStudioJob({ bundle, job: { ...job(), stage: "bake", bundleSha256: studioSourceBundleSha256(bundle) } })).toThrow("render stage only")
  })
  test("does not invent runtime availability or qualification", () => {
    expect(planStudioJob({ bundle: source(), job: job() }).readiness).toBe("runtime-unbound")
    expect(planStudioJob({ bundle: source(), job: job(), runtime: { ...runtime(), capabilities: [] } }).readiness).toBe("capability-unverified")
    expect(planStudioJob({ bundle: source(), job: job(), runtime: { ...runtime(), capabilities: runtime().capabilities.map(item => ({ ...item, support: "unavailable" })) } }).readiness).toBe("capability-unavailable")
    expect(() => parseStudioRuntimeIdentity({ ...runtime(), environment: { ...runtime().environment, hermetic: true } })).toThrow()
    expect(() => parseStudioRuntimeIdentity({ ...runtime(), capabilities: [{ name: "render", support: "available", evidence: "qualification" }] })).toThrow()
    expect(parseStudioRuntimeIdentity({ ...runtime(), capabilities: [{ name: "render", support: "available", evidence: "qualification", receiptSha256: sha() }] }).capabilities[0]?.evidence).toBe("qualification")
  })
  test("keeps engine options strict and bounded", () => {
    for (const engine of [{ ...job().engine, executable: "/bin/sh" }, { ...job().engine, samples: 4097 }, { ...job().engine, seed: -1 }, { ...job().engine, viewTransform: "unknown" }, { engine: "manim", scene: "Bad;exec", renderer: "cairo", transparent: false }, { engine: "cadquery", exportVariable: "result", tolerance: 0, angularTolerance: 0.1 }]) expect(() => parseStudioJob({ ...job(), engine })).toThrow()
    expect(parseStudioJob({ ...job(), engine: { engine: "manim", scene: "Lesson", renderer: "cairo", transparent: false } }).engine.engine).toBe("manim")
  })
  test("bounds parameters before recursion or native execution", () => {
    expect(() => parseStudioJob({ ...job(), parameters: { text: "x".repeat(STUDIO_LIMITS.parameterBytes) } })).toThrow()
    let deep: unknown = 1; for (let index = 0; index < 18; index++) deep = { nested: deep }
    expect(() => parseStudioJob({ ...job(), parameters: deep })).toThrow()
    expect(() => parseStudioJob({ ...job(), parameters: [] })).toThrow()
  })
  test("admits only bounded, half-open frames and output ceilings", () => {
    for (const render of [{ ...job().render, endFrameExclusive: 1 }, { ...job().render, startFrame: -1 }, { ...job().render, endFrameExclusive: 25_002 }, { ...job().render, width: 8193 }, { ...job().render, width: 8192, height: 8192 }]) expect(() => parseStudioJob({ ...job(), render })).toThrow()
    expect(() => parseStudioJob({ ...job(), limits: { ...job().limits, maximumOutputFiles: 2 } })).toThrow()
    expect(() => parseStudioJob({ ...job(), limits: { ...job().limits, timeoutSeconds: STUDIO_LIMITS.timeoutSeconds + 1 } })).toThrow()
  })
  test("rejects ambiguous patterns, collisions, and ancestor outputs", () => {
    for (const pathPattern of ["frames/*.png", "frames/%d.png", "frames/%06d-%06d.png", "../%06d.png", "frames/%06d.jpg", "frames/%06d%00.png"]) expect(() => parseStudioJob({ ...job(), outputs: [{ ...job().outputs[0], pathPattern }] })).toThrow()
    const output = job().outputs[0]!
    for (const path of ["beauty/000001.png", "BEAUTY/000001.png", "beauty/000001.png/inside.png"]) expect(() => planStudioJob({ bundle: source(), job: { ...job(), outputs: [output, { id: "other", kind: "file", path, role: "beauty", format: "png", interpretation: raster() }] } })).toThrow("paths")
    expect(studioOutputPath(plan().job.outputs[0]!, 2)).toBe("beauty/000002.png")
    expect(() => studioOutputPath(plan().job.outputs[0]!)).toThrow()
  })
  test("rejects tampered retained plan fields and recomputes all identities", () => {
    const expected = plan()
    for (const update of [{ frameCount: 2 }, { planSha256: sha() }, { sourceBytes: 0 }, { readiness: "runtime-unbound" }, { job: { ...expected.job, parameters: { radius: 3 } } }]) expect(() => parseStudioPlan({ ...expected, ...update })).toThrow()
  })
  test("preserves declared CAD units and refuses contradictory data-pass interpretation", () => {
    const model = { kind: "file", id: "model", path: "assembly.step", role: "model", format: "step", interpretation: { kind: "model", sourceSpace: { units: "millimeters", upAxis: "z", handedness: "right" } } } as const
    const request = { ...job(), engine: { engine: "cadquery", exportVariable: "result", tolerance: 0.1, angularTolerance: 0.1 }, stage: "build", outputs: [model] }
    expect(parseStudioJob(request).outputs[0]?.interpretation).toEqual(model.interpretation)
    expect(() => parseStudioJob({ ...request, outputs: [{ ...model, interpretation: { ...model.interpretation, sourceSpace: { ...model.interpretation.sourceSpace, units: "implicit" } } }] })).toThrow()
    const depth = { ...job().outputs[0], role: "auxiliary", format: "exr", pathPattern: "depth/%06d.exr", interpretation: { ...raster(), semantic: "depth", colorSpace: "data", channels: ["Z"], dataType: "float32", alpha: "none", unit: "meters" } }
    expect(parseStudioJob({ ...job(), outputs: [depth] }).outputs[0]?.role).toBe("auxiliary")
    for (const interpretation of [{ ...depth.interpretation, colorSpace: "srgb" }, { ...depth.interpretation, dataType: "uint8" }, { ...depth.interpretation, channels: ["Z", "Z"] }]) expect(() => parseStudioJob({ ...job(), outputs: [{ ...depth, interpretation }] })).toThrow()
    expect(() => parseStudioJob({ ...job(), outputs: [{ ...depth, role: "beauty" }] })).toThrow()
  })
})

describe("studio receipt reconciliation", () => {
  test("requires exact success coverage while allowing retained partial failures", () => {
    expect(validateStudioReceipt({ plan: plan(), receipt: receipt() }).state).toBe("succeeded")
    expect(() => validateStudioReceipt({ plan: plan(), receipt: { ...receipt(), outputs: receipt().outputs.slice(1) } })).toThrow("every declared")
    const failed = { ...receipt(), state: "failed", custody: "closed", exitCode: 1, outputs: receipt().outputs.slice(1), failure: { code: "subprocess", message: "Native execution failed." } }
    expect(validateStudioReceipt({ plan: plan(), receipt: failed }).outputs).toHaveLength(2)
    expect(validateStudioReceipt({ plan: plan(), receipt: { ...failed, state: "unknown-custody", custody: "unknown" } }).state).toBe("unknown-custody")
    expect(() => parseStudioReceipt({ ...receipt(), custody: "unknown" })).toThrow()
  })
  test("rejects changed output identity, paths, role, format, frame, or budgets", () => {
    for (const update of [{ path: "other.png" }, { path: "beauty/000004.png", frame: 4 }, { frame: 0 }, { role: "auxiliary" }, { format: "exr" }, { outputId: "other" }, { bytes: 1024 ** 2 }]) expect(() => validateStudioReceipt({ plan: plan(), receipt: { ...receipt(), outputs: [{ ...receipt().outputs[0], ...update }, ...receipt().outputs.slice(1)] } })).toThrow()
    expect(() => validateStudioReceipt({ plan: plan(), receipt: { ...receipt(), outputs: [...receipt().outputs, receipt().outputs[0]] } })).toThrow()
    for (const key of ["jobId", "planSha256", "bundleSha256", "jobSha256", "runtimeSha256"] as const) expect(() => validateStudioReceipt({ plan: plan(), receipt: { ...receipt(), [key]: key === "jobId" ? "studio_other" : sha("f") } })).toThrow()
    expect(() => parseStudioReceipt({ ...receipt(), finishedAt: "2026-09-08T00:00:00Z" })).toThrow()
  })
  test("cache directories retain an explicit bounded inventory", () => {
    const cacheJob = { ...job(), stage: "bake", outputs: [{ kind: "directory", id: "cache", path: "simulation", role: "simulation-cache", format: "cache", interpretation: { kind: "cache", semantics: "opaque-native" } }] }
    const expected = planStudioJob({ bundle: source(), job: cacheJob, runtime: runtime() })
    const actual = { ...receipt(), planSha256: expected.planSha256, jobSha256: expected.jobSha256,
      outputs: [{ outputId: "cache", path: "simulation/solver/frame_1.bin", bytes: 100, sha256: sha(), role: "simulation-cache", format: "cache" }] }
    expect(validateStudioReceipt({ plan: expected, receipt: actual }).outputs).toHaveLength(1)
    expect(() => validateStudioReceipt({ plan: expected, receipt: { ...actual, outputs: [] } })).toThrow()
    expect(() => validateStudioReceipt({ plan: expected, receipt: { ...actual, outputs: [{ ...actual.outputs[0], path: "simulation-other/frame.bin" }] } })).toThrow()
  })
  test("requires a bound runtime even when a self-consistent receipt exists", () => {
    const unbound = planStudioJob({ bundle: source(), job: job() })
    expect(() => validateStudioReceipt({ plan: unbound, receipt: { ...receipt(), planSha256: unbound.planSha256 } })).toThrow("runtime binding")
    expect(studioRuntimeSha256(runtime())).not.toBe(studioRuntimeSha256({ ...runtime(), driverSha256: sha("e") }))
  })
  test("sequence output coverage obeys arbitrary bounded frame intervals", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 15 }), (startFrame, count) => {
      const request = { ...job(), render: { ...job().render, startFrame, endFrameExclusive: startFrame + count }, limits: { ...job().limits, maximumOutputFiles: 20 } }
      const expected = planStudioJob({ bundle: source(), job: request, runtime: runtime() })
      const actual = { ...receipt(), planSha256: expected.planSha256, jobSha256: expected.jobSha256,
        outputs: Array.from({ length: count }, (_, offset) => { const frame = startFrame + offset; return { outputId: "beauty", path: studioOutputPath(expected.job.outputs[0]!, frame), bytes: 10, sha256: sha(), role: "beauty", format: "png", frame } }) }
      expect(validateStudioReceipt({ plan: expected, receipt: actual }).outputs).toHaveLength(count)
      expect(() => validateStudioReceipt({ plan: expected, receipt: { ...actual, outputs: actual.outputs.slice(1) } })).toThrow()
    }), { seed: 6202, numRuns: 60 })
  })
  test("aggregate actual output bytes cannot exceed the planned ceiling", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), bytes => {
      const request = { ...job(), limits: { ...job().limits, maximumOutputBytes: bytes * 3 } }
      const expected = planStudioJob({ bundle: source(), job: request, runtime: runtime() })
      const actual = { ...receipt(), planSha256: expected.planSha256, jobSha256: expected.jobSha256, outputs: receipt().outputs.map(output => ({ ...output, bytes })) }
      expect(validateStudioReceipt({ plan: expected, receipt: actual }).state).toBe("succeeded")
      actual.outputs[0]!.bytes += 1
      expect(() => validateStudioReceipt({ plan: expected, receipt: actual })).toThrow("budget")
    }), { seed: 6203, numRuns: 40 })
  })
})


test("build and bake raster files require explicit dimensions and frame clock", () => {
  const { render, ...withoutRender } = job()
  const outputs = [{ kind: "file", id: "still", path: "still.png", format: "png", role: "beauty", interpretation: raster() }]
  for (const stage of ["build", "bake"]) {
    expect(() => parseStudioJob({ ...withoutRender, stage, outputs })).toThrow("dimensions and a frame interval")
    expect(parseStudioJob({ ...withoutRender, stage, outputs, render }).render).toEqual(render)
  }
})

test("a success receipt cannot contradict unavailable bound runtime capabilities", () => {
  const observed = { ...runtime(), capabilities: runtime().capabilities.map(item => ({ ...item, support: "unavailable" })) }
  const expected = planStudioJob({ bundle: source(), job: job(), runtime: observed })
  const actual = { ...receipt(), planSha256: expected.planSha256, runtime: expected.runtime, runtimeSha256: expected.runtimeSha256 }
  expect(() => validateStudioReceipt({ plan: expected, receipt: actual })).toThrow("available observed runtime")
  expect(validateStudioReceipt({ plan: expected, receipt: { ...actual, state: "failed", custody: "closed", exitCode: 1, failure: { code: "unavailable", message: "Runtime unavailable." } } }).state).toBe("failed")
})
