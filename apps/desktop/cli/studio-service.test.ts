import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStudioJob } from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { captureStudioSource, retainStudioSource } from "./studio-files";
import type { StudioProcessPort, StudioProcessResult } from "./studio-process";
import { createStudioService, studioStorageRoot } from "./studio-service";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const fence = async () => {};
const finished = (stdout = ""): StudioProcessResult => ({ custody: "closed", exitCode: 0, stdout, stderr: "" });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-studio-service-"))); roots.push(root);
  const inputRoot = await ensurePhysicalPrivateDirectoryWithin(root, "authored");
  await writeFile(join(inputRoot, "scene.py"), "model = None\n");
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, desktopRoot: root, privateRoot: join(root, "private"), artifactRoot: join(root, "recordings"), projectRoot: join(root, "projects") },
    machineStateRoot: await ensurePhysicalPrivateDirectoryWithin(root, "machine"),
    clock: { now: () => new Date(), timestampMilliseconds: () => Date.now() },
    capabilities: async () => [], capability: async name => ({ name, available: false }),
    runner: { run: async () => { throw new Error("Ordinary runner must not execute native source."); } },
  };
  const bundle = await captureStudioSource({ sourceRoot: inputRoot, engine: "cadquery", entrypoint: { kind: "python", path: "scene.py" }, files: ["scene.py"] });
  const studioRoot = await studioStorageRoot(application), retained = await retainStudioSource({ studioRoot, sourceRoot: inputRoot, bundle, fence });
  const job = parseStudioJob({ kind: "slopcamera.studio-job", schemaVersion: 1, jobId: "studio_fixture", bundleSha256: retained.bundleSha256,
    stage: "build", parameters: {}, engine: { engine: "cadquery", exportVariable: "model", tolerance: 0.05, angularTolerance: 0.1 },
    outputs: [{ kind: "file", id: "solid", role: "model", format: "step", path: "model.step", interpretation: { kind: "model", sourceSpace: { units: "millimeters", upAxis: "z", handedness: "right" } } }],
    limits: { timeoutSeconds: 30, maximumOutputBytes: 1024 * 1024, maximumOutputFiles: 10 }, execution: { trust: "trusted-current-user", isolation: "none", hermetic: false } });
  const calls: string[][] = [];
  let onRun = async (request: { outputRoot: string; sourceRoot: string }) => { await writeFile(join(request.outputRoot, "model.step"), "ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;\nEND-ISO-10303-21;\n"); };
  let result = finished(), version = "2.8.0", probeResult: StudioProcessResult | undefined;
  const process: StudioProcessPort = { run: async (argv, options) => {
    calls.push([...argv]);
    await options.onSpawn?.(12345);
    if (argv.includes("--probe")) return probeResult ?? finished(`SLOPCAMERA_STUDIO_PROBE=${JSON.stringify({ name: "CadQuery", version, packages: { cadquery: version }, capabilities: ["python-authoring", "build", "model-export"] })}\n`);
    const request = JSON.parse(await readFile(argv[argv.indexOf("--request") + 1]!, "utf8")) as { outputRoot: string; sourceRoot: string };
    await onRun(request);
    return result;
  } };
  const service = createStudioService({ application, selection: { python: "/usr/bin/true", threads: 1 }, process });
  const control = { signal: signal(), allowTrustedCode: true as const, beforePublication: fence };
  return { root, studioRoot, application, retained, job, calls, service, control,
    onRun: (value: typeof onRun) => { onRun = value; }, probeResult: (value: StudioProcessResult) => { probeResult = value; }, result: (value: StudioProcessResult) => { result = value; }, version: (value: string) => { version = value; } };
}

describe("retained native studio host", () => {
  test("planning is inert and authorization is checked before any native dispatch", async () => {
    const f = await fixture();
    expect((await f.service.plan(f.job)).readiness).toBe("runtime-unbound");
    await expect(f.service.run(f.job, { ...f.control, allowTrustedCode: false } as unknown as typeof f.control)).rejects.toThrow("authorization");
    expect(f.calls).toHaveLength(0);
  });
  test("retains exact source, output and runtime and reuses a verified receipt without dispatch", async () => {
    const f = await fixture(), output = await f.service.run(f.job, f.control);
    expect(output.document.state).toBe("succeeded");
    expect(output.document.outputs).toHaveLength(1);
    expect(f.calls).toHaveLength(3);
    expect((await f.service.run(f.job, f.control)).receipt).toEqual(output.receipt);
    expect(f.calls).toHaveLength(3);
    expect(output.outputs[0]!.artifact.path).toContain("/jobs/studio_fixture/outputs/model.step");
  });
  test("output mutation invalidates retained reuse", async () => {
    const f = await fixture(), output = await f.service.run(f.job, f.control);
    await writeFile(join(f.root, output.outputs[0]!.artifact.path), "replacement");
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("differ");
    expect(f.calls).toHaveLength(3);
  });
  test("missing declared outputs persist a failure receipt, never success", async () => {
    const f = await fixture(); f.onRun(async () => {});
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("did not complete");
    const receipt = JSON.parse(await readFile(join(f.studioRoot, "jobs/studio_fixture/receipt.json"), "utf8"));
    expect(receipt.state).toBe("failed"); expect(receipt.failure.code).toBe("validation");
    const count = f.calls.length;
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("retained failure");
    expect(f.calls).toHaveLength(count);
  });
  test("source mutation during trusted execution fails validation", async () => {
    const f = await fixture();
    f.onRun(async request => { await writeFile(join(request.sourceRoot, "scene.py"), "changed\n"); });
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("did not complete");
    expect(JSON.parse(await readFile(join(f.studioRoot, "jobs/studio_fixture/receipt.json"), "utf8")).state).toBe("failed");
  });
  test("invalid media retains its failed validation stage without foreign diagnostic text", async () => {
    const f = await fixture(); f.onRun(async request => { await writeFile(join(request.outputRoot, "model.step"), "not a STEP file"); });
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("did not complete");
    const diagnostic = JSON.parse(await readFile(join(f.studioRoot, "jobs/studio_fixture/validation-failure.json"), "utf8"));
    expect(diagnostic.stage).toBe("media-validation"); expect(diagnostic).not.toHaveProperty("stderr");
  });
  test("runtime change after native work does not publish a successful receipt", async () => {
    const f = await fixture(); f.onRun(async () => { f.version("2.9.0"); });
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("did not complete");
    expect(JSON.parse(await readFile(join(f.studioRoot, "jobs/studio_fixture/receipt.json"), "utf8")).failure.code).toBe("validation");
    expect(JSON.parse(await readFile(join(f.studioRoot, "jobs/studio_fixture/validation-failure.json"), "utf8")).stage).toBe("runtime-identity");
  });
  test("post-render verification custody remains unknown in the retained job receipt", async () => {
    const f = await fixture();
    f.onRun(async request => {
      await writeFile(join(request.outputRoot, "model.step"), "ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;\nEND-ISO-10303-21;\n");
      f.probeResult({ ...finished(), custody: "unknown", failure: "descendants" });
    });
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("did not complete");
    const receipt = JSON.parse(await readFile(join(f.studioRoot, "jobs/studio_fixture/receipt.json"), "utf8"));
    expect(receipt.state).toBe("unknown-custody"); expect(receipt.custody).toBe("unknown");
    expect(receipt.failure.code).toBe("custody");
  });
  test("unsettled custody persists a machine marker that blocks later probes", async () => {
    const f = await fixture(); f.result({ ...finished(), custody: "unknown", failure: "descendants" });
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("did not complete");
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("retained failure");
    await expect(f.service.bind(f.job, signal())).rejects.toThrow("Unsettled native");
    expect(f.calls).toHaveLength(2);
  });
  test("cancellation retains failure and closed custody even after invocation publication is revoked", async () => {
    const f = await fixture(), controller = new AbortController();
    f.onRun(async () => { controller.abort(); });
    f.result({ ...finished(), exitCode: null, failure: "cancelled" });
    await expect(f.service.run(f.job, { ...f.control, signal: controller.signal, beforePublication: async () => { if (controller.signal.aborted) throw new Error("revoked"); } })).rejects.toThrow("did not complete");
    const receipt = JSON.parse(await readFile(join(f.studioRoot, "jobs/studio_fixture/receipt.json"), "utf8"));
    expect(receipt.state).toBe("failed"); expect(receipt.failure.code).toBe("cancelled");
    expect(JSON.parse(await readFile(join(f.application.machineStateRoot!, "studio-native/activity.json"), "utf8")).state).toBe("closed");
    await expect(f.service.bind(f.job, signal())).resolves.toMatchObject({ readiness: "authorization-required" });
  });
  test("unreceipted intent cannot silently rerun", async () => {
    const f = await fixture(); await f.service.run(f.job, f.control);
    await rm(join(f.studioRoot, "jobs/studio_fixture/receipt.json"));
    await expect(f.service.run(f.job, f.control)).rejects.toThrow("will not be rerun");
    expect(f.calls).toHaveLength(3);
    expect((await f.service.reconcile(f.job.jobId)).document.state).toBe("succeeded");
    expect(f.calls).toHaveLength(3);
  });
  test("recovery checks requested plan identity before restoring a missing receipt", async () => {
    const f = await fixture(); await f.service.run(f.job, f.control);
    const receiptPath = join(f.studioRoot, "jobs/studio_fixture/receipt.json");
    await rm(receiptPath);
    await expect(f.service.reconcile(f.job.jobId, fence, "a".repeat(64))).rejects.toThrow("recovery identity");
    expect(await Bun.file(receiptPath).exists()).toBe(false);
    expect(f.calls).toHaveLength(3);
  });
  test("recovery refuses a changed previously validated output", async () => {
    const f = await fixture(), result = await f.service.run(f.job, f.control);
    await rm(join(f.studioRoot, "jobs/studio_fixture/receipt.json"));
    await writeFile(join(f.root, result.outputs[0]!.artifact.path), "ISO-10303-21;\nchanged\nEND-ISO-10303-21;\n");
    await expect(f.service.reconcile(f.job.jobId)).rejects.toThrow("changed after");
    expect(f.calls).toHaveLength(3);
  });
  test("the same job ID cannot replace parameters or source identity", async () => {
    const f = await fixture(); await f.service.run(f.job, f.control);
    await expect(f.service.run({ ...f.job, parameters: { changed: true } }, f.control)).rejects.toThrow("different plan");
  });
  test("binding rejects caller manifests outside retained storage", async () => {
    const f = await fixture();
    await expect(f.service.port.bind({ bundle: { path: "authored/source.json" }, job: f.job }, signal())).rejects.toThrow("exact retained");
    expect(f.calls).toHaveLength(0);
  });
});
