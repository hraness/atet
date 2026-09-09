import { basename, dirname, join, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import type { ApplicationContext } from "../application/context";
import { createApplicationOperationRegistry } from "../application/default-registry";
import { bindProjectRenderInputV4 } from "../application/operations/render/project";
import { withSpatialProjectLease } from "../application/spatial-project-lease";
import { prepareSpatialProjectRender, SpatialProjectRenderPreparationInputSchema } from "../application/spatial-project-render-preparation";
import { spatialProjectStorePorts } from "../application/spatial-project-authority";
import { readSpatialProjectAuthority } from "../application/spatial-project-store";
import { ProjectRenderOutputRequestSchema, ProjectRenderSyncPolicySchema, ProjectRenderTargetSchema } from "../contracts/project-render";
import { SPATIAL_PROJECT_LIMITS } from "../contracts/spatial-project";
import type { SpatialProjectCommand } from "./args";
import { CliError } from "./errors";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { bindSpatialCliExecutionProfile, publishSpatialSource, readSpatialJson } from "./spatial-scene-service";

const preparationDeliverySchema = z.strictObject({
  output: ProjectRenderOutputRequestSchema,
  syncPolicy: ProjectRenderSyncPolicySchema,
  tier: z.enum(["preview", "final"]),
}).superRefine((value, context) => {
  if (value.output.maximumBytes > 256 * 1024 * 1024) context.addIssue({ code: "custom", message: "Spatial project delivery permits at most 256 MiB of output." });
});

export async function executeSpatialProjectCommand(application: ApplicationContext, command: SpatialProjectCommand): Promise<unknown> {
  const request = command.action === "snapshot" ? {} : await readSpatialJson(resolve(application.paths.repositoryRoot, command.input), SPATIAL_PROJECT_LIMITS.documentBytes);
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw new CliError("invalid-data", "A spatial project request must be a JSON object.");
  if ("project" in request && request.project !== command.project) throw new CliError("conflict", "Project argument differs from the request project.");
  if (command.action === "prepare-render") {
    const { delivery: unparsedDelivery, ...preparation } = request as Record<string, unknown>;
    const delivery = preparationDeliverySchema.parse(unparsedDelivery);
    const input = SpatialProjectRenderPreparationInputSchema.parse({ ...preparation, project: command.project,
      profile: bindSpatialCliExecutionProfile(preparation.profile, command.executionProfile) });
    const target = ProjectRenderTargetSchema.parse({
      canvas: { kind: "custom", pixelWidth: input.profile.pixelWidth, pixelHeight: input.profile.pixelHeight, frameRate: input.profile.frameRate.numerator / input.profile.frameRate.denominator },
      tier: delivery.tier,
    });
    const requestedOutputPath = resolve(application.paths.repositoryRoot, command.output);
    const preparedParent = await realpath(dirname(requestedOutputPath));
    const preparedParentIdentity = await lstat(preparedParent);
    const outputPath = join(preparedParent, basename(requestedOutputPath));
    try {
      await lstat(outputPath);
      throw new CliError("conflict", "Prepared render output already exists. Choose a new path before rendering.");
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    const prepared = await withSpatialProjectLease(application, command.project, async leasedApplication => {
      const ports = await spatialProjectStorePorts(leasedApplication, command.project);
      const snapshot = await readSpatialProjectAuthority(ports);
      if (snapshot.version !== 2 || input.expected.version !== 2 || snapshot.basis.sha256 !== input.expected.sha256) throw new CliError("conflict", "Scene delivery requires the exact current V2 project basis.");
      if (delivery.syncPolicy === "require-verified" && snapshot.contents.legacy.project.placements.some(placement => placement.enabled && placement.sync.provenance.kind === "unverified")) throw new CliError("conflict", "Scene delivery includes unverified placement synchronization. Resolve it before migration or explicitly allow unverified synchronization.");
      const projectDirectory = leasedApplication.spatialProjectCustody!.projectDirectory;
      const finalOutput = join(projectDirectory, delivery.output.path);
      if (finalOutput === outputPath) throw new CliError("conflict", "Prepared request and final video require distinct output paths.");
      const finalParent = await ensurePhysicalPrivateDirectoryWithin(projectDirectory, dirname(delivery.output.path));
      if (finalParent !== dirname(finalOutput)) throw new CliError("unsafe-path", "Scene delivery output parent changed.");
      try {
        await lstat(finalOutput);
        throw new CliError("conflict", "Scene delivery output already exists. Choose a new path before rendering.");
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      }
      await ports.custody.assertHeld();
      return await prepareSpatialProjectRender({ application: leasedApplication, abortSignal: new AbortController().signal }, input);
    });
    try {
      const render = await bindProjectRenderInputV4(application, { plan: prepared.plan, spatial: prepared.spatial, output: delivery.output, syncPolicy: delivery.syncPolicy, target });
      await publishSpatialSource(outputPath, render, async () => {
        const current = await lstat(preparedParent);
        if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== preparedParentIdentity.dev || current.ino !== preparedParentIdentity.ino
          || await realpath(preparedParent) !== preparedParent) throw new CliError("conflict", "Prepared render output parent changed during rendering.");
        await application.hostResourceLease?.assertOwned();
      });
    } catch (error) {
      throw new CliError("conflict", `Scene preparation completed, but the prepared delivery file could not be published: ${error instanceof Error ? error.message : String(error)}`, { prepared, preparedRender: outputPath });
    }
    return { sourceBasis: prepared.sourceBasis, projectionSha256: prepared.projectionSha256, plan: prepared.plan, preparedRender: outputPath, workflow: "directed-scene" };
  }
  const registry = createApplicationOperationRegistry();
  const result = await withSpatialProjectLease(application, command.project, async leasedApplication => await registry.execute({
    application: leasedApplication, abortSignal: new AbortController().signal,
  }, { kind: `spatial.project.${command.action}`, version: 1, input: { ...request, project: command.project } }), undefined, command.action === "migrate" ? "mutation" : "read");
  if (command.action !== "snapshot") {
    const disposition = result.output as { readonly kind?: string; readonly message?: string };
    if (disposition.kind !== "completed") throw new CliError(disposition.kind === "ambiguous" ? "ambiguous" : "conflict", disposition.message ?? "Spatial publication did not complete.", { spatialPublication: result.output });
  }
  return result.output;
}
