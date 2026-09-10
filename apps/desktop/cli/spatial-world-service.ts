import { join, relative, resolve, sep } from "node:path";
import type { ApplicationContext } from "../application/context";
import { importSavedSpatialWorld, SavedSpatialWorldImportInputSchema, SpatialWorldImportError } from "../application/spatial-world-import";
import type { SpatialWorldCommand } from "./args";
import { CliError } from "./errors";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { readSpatialJson } from "./spatial-scene-service";

export async function executeSpatialWorldCommand(
  application: ApplicationContext,
  command: SpatialWorldCommand,
  adapter: Readonly<{ signal?: AbortSignal }>,
): Promise<unknown> {
  const repositoryRoot = application.paths.repositoryRoot;
  try {
    if (adapter.signal?.aborted) throw new CliError("cancelled", "World import cancelled before reading source assets.");
    const input = SavedSpatialWorldImportInputSchema.safeParse(await readSpatialJson(resolve(repositoryRoot, command.input)));
    if (!input.success) throw new CliError("invalid-data", "The saved world import input is invalid.");
    const outputRoot = resolve(repositoryRoot, command.outputRoot);
    const generatedRoot = join(repositoryRoot, "artifacts", "slopcamera", "generated");
    const outputRelative = relative(generatedRoot, outputRoot);
    if (outputRelative === "" || outputRelative.startsWith(`..${sep}`) || outputRelative === ".." || resolve(generatedRoot, outputRelative) !== outputRoot) {
      throw new CliError("unsafe-path", "World imports require a dedicated directory below artifacts/slopcamera/generated.");
    }
    const destinationRoot = await ensurePhysicalPrivateDirectoryWithin(repositoryRoot, relative(repositoryRoot, outputRoot));
    return await importSavedSpatialWorld({
      sourceRoot: resolve(repositoryRoot, command.sourceRoot), destinationRoot, input: input.data,
      signal: adapter.signal ?? new AbortController().signal,
      beforePublication: async () => { await application.hostResourceLease?.assertOwned(); },
    });
  } catch (error) {
    if (error instanceof SpatialWorldImportError) throw new CliError(adapter.signal?.aborted ? "cancelled" : "conflict", error.message, {
      published: error.published, attempted: error.attempted, outputRoot: command.outputRoot,
    });
    if (adapter.signal?.aborted) throw new CliError("cancelled", "World import cancelled; retain its source and any publication evidence.");
    if (error instanceof RangeError) throw new CliError("invalid-data", error.message);
    throw error;
  }
}
