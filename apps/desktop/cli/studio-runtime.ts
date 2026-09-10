import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { parseStudioRuntimeIdentity, StudioCapabilityNameSchema, type StudioSourceBundle, type StudioRuntimeIdentity } from "../../../src/studio";
import { createNodeBundleFileSystem } from "../core/storage";
import blenderDriver from "../studio/drivers/blender_driver.py" with { type: "text" };
import cadqueryDriver from "../studio/drivers/cadquery_driver.py" with { type: "text" };
import manimDriver from "../studio/education/driver.py" with { type: "text" };
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { studioBytesSha256, studioJson } from "./studio-files";
import { studioChildEnvironment, type StudioProcessPort } from "./studio-process";

export interface StudioRuntimeSelection { readonly blender?: string; readonly python?: string; readonly threads: number }
export interface BoundStudioRuntime {
  readonly identity: StudioRuntimeIdentity; readonly executable: string; readonly driver: string;
  readonly environment: Readonly<Record<string, string>>; readonly workingRoot: string; readonly threads: number;
}
const drivers = { blender: blenderDriver, cadquery: cadqueryDriver, manim: manimDriver } as const;
const probeSchema = z.strictObject({
  name: z.string().min(1).max(128), version: z.string().min(1).max(512),
  packages: z.record(z.string().min(1).max(128), z.string().max(512)).refine(value => Object.keys(value).length <= 2048),
  capabilities: z.array(StudioCapabilityNameSchema).max(12),
});

/** Engine commands are fixed. The host selects an installed runtime; serialized jobs never carry argv. */
export function studioDriverArgv(runtime: Pick<BoundStudioRuntime, "executable" | "driver" | "threads">, engine: StudioSourceBundle["engine"], action: { readonly probe: true } | { readonly request: string }): readonly [string, ...string[]] {
  const tail = "probe" in action ? ["--probe"] : ["--request", action.request];
  return engine === "blender"
    ? [runtime.executable, "--factory-startup", "--background", "--disable-autoexec", "--python-exit-code", "23", "--threads", String(runtime.threads), "--python", runtime.driver, "--", ...tail]
    : [runtime.executable, runtime.driver, ...tail];
}

async function executableIdentity(path: string): Promise<{ readonly executable: string; readonly sha256: string }> {
  // Preserve the selected venv symlink in argv: resolving it changes Python's environment.
  const executable = resolve(path), physical = await realpath(executable), stat = await lstat(physical);
  if (!stat.isFile() || stat.size > 1024 * 1024 * 1024) throw new Error("Studio runtime must be a bounded installed executable.");
  await access(executable, constants.X_OK);
  const fs = createNodeBundleFileSystem(dirname(physical));
  return { executable, sha256: (await fs.inspectFile!(physical.slice(dirname(physical).length + 1), stat.size)).sha256 };
}

export async function probeStudioRuntime(input: {
  readonly engine: StudioSourceBundle["engine"]; readonly selection: StudioRuntimeSelection; readonly workingRoot: string;
  readonly process: StudioProcessPort; readonly signal: AbortSignal; readonly fence: () => Promise<void>;
  readonly inheritedFileDescriptors?: readonly number[];
}): Promise<BoundStudioRuntime> {
  const selected = input.engine === "blender" ? input.selection.blender : input.selection.python;
  if (selected === undefined) throw new Error(input.engine === "blender" ? "Select an installed Blender runtime with --blender-bin." : "Select an installed Python environment with --python.");
  const executable = await executableIdentity(selected), text = drivers[input.engine], driverSha256 = studioBytesSha256(text);
  for (const path of ["home", "tmp", "blender-user", "driver"]) await ensurePhysicalPrivateDirectoryWithin(input.workingRoot, path);
  const fs = createNodeBundleFileSystem(input.workingRoot), driverPath = `driver/${input.engine}-${driverSha256}.py`;
  const disposition = await fs.writeTextNoReplace!(driverPath, text, input.fence);
  if (disposition !== "created" && await fs.readText(driverPath) !== text) throw new Error("Fixed studio driver bytes changed.");
  const environment = studioChildEnvironment(executable.executable, input.workingRoot, input.selection.threads);
  const bound = { executable: executable.executable, driver: join(input.workingRoot, driverPath), environment, workingRoot: input.workingRoot, threads: input.selection.threads };
  await input.fence();
  const result = await input.process.run(studioDriverArgv(bound, input.engine, { probe: true }), {
    cwd: input.workingRoot, env: environment, timeoutMs: 120_000, maximumLogBytes: 1_048_576, signal: input.signal,
    ...(input.inheritedFileDescriptors === undefined ? {} : { inheritedFileDescriptors: input.inheritedFileDescriptors }),
  });
  if (result.custody !== "closed" || result.failure !== undefined || result.exitCode !== 0) throw new Error("Fixed native runtime probe did not finish with closed process custody.");
  const lines = result.stdout.split(/\r?\n/u).filter(line => line.startsWith("SLOPCAMERA_STUDIO_PROBE="));
  if (lines.length !== 1) throw new Error("Native runtime probe must emit one bounded identity document.");
  const probe = probeSchema.parse(JSON.parse(lines[0]!.slice("SLOPCAMERA_STUDIO_PROBE=".length)) as unknown);
  if (new Set(probe.capabilities).size !== probe.capabilities.length) throw new Error("Native runtime probe repeats a capability.");
  await input.fence();
  const after = await executableIdentity(selected);
  if (executable.sha256 !== after.sha256) throw new Error("Studio executable changed during probing.");
  const identity = parseStudioRuntimeIdentity({
    kind: "slopcamera.studio-runtime", schemaVersion: 1, engine: input.engine,
    tool: { name: probe.name, version: probe.version, executableSha256: executable.sha256 }, driverSha256,
    environment: { fingerprintSha256: studioBytesSha256(studioJson({ platform: process.platform, architecture: process.arch, packages: probe.packages, threads: input.selection.threads })), evidence: "observed-package-environment", hermetic: false },
    capabilities: probe.capabilities.map(name => ({ name, support: "available", evidence: "probe" })),
  });
  return { ...bound, identity };
}
