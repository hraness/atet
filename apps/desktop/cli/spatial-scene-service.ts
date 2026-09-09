import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { canonicalJson } from "../../../src/code/canonical-json";
import { createSpatialSceneStarter } from "../../../src/spatial-scene/authoring";
import { SPATIAL_SCENE_LIMITS } from "../../../src/spatial-scene/contracts";
import { parseSpatialScene, spatialSceneSha256 } from "../../../src/spatial-scene/index";
import type { ApplicationContext } from "../application/context";
import { createApplicationOperationRegistry } from "../application/default-registry";
import { planSpatialRender } from "../application/spatial-render";
import { createNodeBundleFileSystem } from "../core/storage";
import type { SpatialCliExecutionProfile, SpatialSceneCommand } from "./args";
import { CliError } from "./errors";

/** Capture an explicit local regular file once, without following a leaf symlink. */
export async function readSpatialJson(path: string, maximumBytes: number = SPATIAL_SCENE_LIMITS.sourceBytes): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 32 * 1024 * 1024) throw new CliError("invalid-data", "Invalid spatial JSON byte limit.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) throw new CliError("invalid-data", "Scene source must be a bounded regular JSON file.");
    const bytes = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.byteLength - offset), offset);
      if (read.bytesRead === 0) throw new CliError("conflict", "Scene source ended while it was being read.");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (bytes.byteLength > maximumBytes || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new CliError("conflict", "Scene source changed while it was being read.");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally { await handle.close(); }
}

export async function publishSpatialSource(path: string, value: unknown, beforePublication?: () => Promise<void>): Promise<void> {
  const directory = await realpath(dirname(resolve(path)));
  const fileSystem = createNodeBundleFileSystem(directory);
  const written = await fileSystem.writeTextNoReplace?.(basename(path), `${canonicalJson(value)}\n`, beforePublication);
  if (written !== "created") throw new CliError("conflict", "Scene output already exists. Choose a new path to retain both revisions.");
}

/** An explicit CLI profile may fill an omitted request field, never replace one. */
export function bindSpatialCliExecutionProfile(request: unknown, executionProfile: SpatialCliExecutionProfile | undefined): unknown {
  if (executionProfile === undefined) return request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw new CliError("invalid-data", "A spatial render request must be a JSON object.");
  if ("executionProfile" in request && request.executionProfile !== executionProfile) throw new CliError("conflict", "--profile differs from the execution profile retained in the request.");
  return { ...request, executionProfile };
}

export async function executeSpatialSceneCommand(application: ApplicationContext, command: SpatialSceneCommand): Promise<unknown> {
  const sourcePath = resolve(application.paths.repositoryRoot, command.path);
  if (command.action === "init") {
    const scene = createSpatialSceneStarter();
    await publishSpatialSource(sourcePath, scene);
    return { path: sourcePath, sceneSha256: spatialSceneSha256(scene) };
  }
  const scene = parseSpatialScene(await readSpatialJson(sourcePath));
  if (command.action === "plan" || command.action === "render") {
    const request = bindSpatialCliExecutionProfile(await readSpatialJson(resolve(application.paths.repositoryRoot, command.request)), command.executionProfile);
    if (command.action === "plan") return planSpatialRender(scene, request);
    const result = await createApplicationOperationRegistry().execute({ application, abortSignal: new AbortController().signal }, {
      kind: "scene.render", version: 1, input: {
        source: { path: relative(application.paths.repositoryRoot, sourcePath) }, request,
        ...(command.assets === undefined ? {} : { assets: await readSpatialJson(resolve(application.paths.repositoryRoot, command.assets)) }),
      },
    });
    return result.output;
  }
  const registry = createApplicationOperationRegistry();
  const input = command.action === "patch"
    ? { scene, patch: await readSpatialJson(resolve(application.paths.repositoryRoot, command.patch)) }
    : command.action === "evaluate" ? { scene, cameraId: command.camera, timeUs: command.timeUs } : { scene };
  const result = await registry.execute({ application, abortSignal: new AbortController().signal }, {
    kind: command.action === "patch" ? "scene.patch" : command.action === "evaluate" ? "scene.evaluate" : "scene.inspect",
    version: 1, input,
  });
  if (command.action === "patch") {
    const output = result.output as { readonly scene: unknown };
    await publishSpatialSource(resolve(application.paths.repositoryRoot, command.output), output.scene);
  }
  return result.output;
}
