import { basename, resolve } from "node:path";

import { VideoProjectIdSchema } from "../contracts/project";
import { createNodeSpatialDurability } from "../core/spatial-durability";
import { createNodeBundleFileSystem } from "../core/storage";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import type { SpatialProjectStorePorts } from "./spatial-project-store";

/**
 * Binds the fixed operation input to an adapter-owned, already-held lease.
 * Directory resolution and lease acquisition belong to the caller. Neither
 * serialized paths nor operation input can grant publication authority.
 */
export async function spatialProjectStorePorts(
  application: ApplicationContext,
  projectInput: string,
): Promise<SpatialProjectStorePorts> {
  const projectId = VideoProjectIdSchema.parse(projectInput);
  const custody = application.spatialProjectCustody;
  if (custody === undefined) throw new ApplicationError("conflict", "Spatial project access requires an existing publication lease.");
  if (custody.projectId !== projectId || basename(resolve(custody.projectDirectory)) !== projectId) {
    throw new ApplicationError("conflict", "Spatial project input does not match its adapter-owned directory and lease.");
  }
  await custody.assertHeld();
  return {
    projectId,
    fileSystem: createNodeBundleFileSystem(custody.projectDirectory),
    durability: createNodeSpatialDurability(custody.projectDirectory),
    custody: {
      assertHeld: () => custody.assertHeld(),
      assertLegacyTransactionSettled: () => custody.assertLegacyTransactionSettled(),
    },
  };
}
