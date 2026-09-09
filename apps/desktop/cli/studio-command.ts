import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { StudioEngineSchema, StudioPathSchema } from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import { createPolyHavenAssetService } from "../studio/assets/poly-haven";
import type { StudioCommand } from "./args";
import { CliError } from "./errors";
import { readSpatialJson } from "./spatial-scene-service";
import { captureStudioSource, retainStudioSource } from "./studio-files";
import { assembleStudioJob } from "./studio-assemble";
import { encodeStudioSequence } from "./studio-encode";
import { createStudioScaffold } from "./studio-scaffold";
import { createStudioService, studioStorageRoot } from "./studio-service";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";

const sourceDeclaration = z.strictObject({ engine: StudioEngineSchema,
  entrypoint: z.strictObject({ kind: z.enum(["python", "blend"]), path: StudioPathSchema }),
  files: z.array(StudioPathSchema).min(1).max(512),
});

export async function executeStudioCommand(application: ApplicationContext, command: StudioCommand, signal: AbortSignal): Promise<unknown> {
  const fence = async () => { await application.hostResourceLease?.assertOwned(); };
  if (signal.aborted) throw new CliError("cancelled", "Studio command cancelled.");
  if (command.action === "assets") {
    const storageRoot = await ensurePhysicalPrivateDirectoryWithin(application.paths.repositoryRoot, "artifacts/atet/generated/studio-assets/poly-haven");
    const service = createPolyHavenAssetService({ storageRoot, signal, beforePublication: fence });
    if (command.operation === "describe") return await service.describe(command.path);
    const input = await readSpatialJson(resolve(application.paths.repositoryRoot, command.path), 16 * 1024 * 1024);
    return command.operation === "search" ? await service.search(input) : command.operation === "plan" ? await service.plan(input) : await service.importAsset(input);
  }
  if (command.action === "init") return await createStudioScaffold(resolve(application.paths.repositoryRoot, command.path), command.template, fence);
  if (command.action === "bundle") {
    const manifest = resolve(application.paths.repositoryRoot, command.path), declaration = sourceDeclaration.parse(await readSpatialJson(manifest, 1024 * 1024));
    const sourceRoot = command.sourceRoot === undefined ? dirname(manifest) : resolve(application.paths.repositoryRoot, command.sourceRoot);
    const bundle = await captureStudioSource({ ...declaration, sourceRoot });
    const studioRoot = await studioStorageRoot(application), retained = await retainStudioSource({ studioRoot, sourceRoot, bundle, fence });
    return { bundle: retained.bundle, bundleSha256: retained.bundleSha256,
      manifest: relative(application.paths.repositoryRoot, resolve(retained.sourceRoot, "../bundle.json")), executed: false,
      next: "Bind bundleSha256 into a new job ID after source edits, then use studio plan and studio run." };
  }
  const selection = { threads: 1, ...(command.action !== "probe" && command.action !== "run" ? {} : {
    ...(command.blender === undefined ? {} : { blender: resolve(application.paths.repositoryRoot, command.blender) }),
    ...(command.python === undefined ? {} : { python: resolve(application.paths.repositoryRoot, command.python) }),
  }) };
  const service = createStudioService({ application, selection });
  if (command.action === "assemble") return await assembleStudioJob({ application, service, jobId: command.id, outputId: command.outputId, signal, beforePublication: fence, ...(command.title === undefined ? {} : { title: command.title }) });
  if (command.action === "encode") return await encodeStudioSequence({ application, service, jobId: command.id, outputId: command.outputId, signal, beforePublication: fence });
  if (command.action === "inspect") return await service.inspect(command.id);
  if (command.action === "reconcile") return await service.reconcile(command.id, fence);
  const job = await readSpatialJson(resolve(application.paths.repositoryRoot, command.path), 1024 * 1024);
  if (command.action === "plan") return await service.plan(job);
  if (command.action === "probe") return await service.bind(job, signal);
  if (!command.allowTrustedCode) throw new CliError("authorization-required", "Studio execution requires explicit trusted-code authorization.");
  return await service.run(job, { signal, allowTrustedCode: true, beforePublication: fence,
    ...(application.hostResourceLease === undefined ? {} : { inheritedFileDescriptors: application.hostResourceLease.inheritedFileDescriptors }) });
}
