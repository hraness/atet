import { join, relative, resolve, sep } from "node:path";
import type { ApplicationContext } from "../application/context";
import { importSavedSpatialWorld, SavedSpatialWorldImportInputSchema, SpatialWorldImportError } from "../application/spatial-world-import";
import { planWorldLabsGeneration, WorldLabsGenerationInputSchema, type WorldLabsAttemptSummary, type WorldLabsService } from "../application/world-labs-port";
import type { SpatialWorldCommand } from "./args";
import { CliError, type CliErrorCode } from "./errors";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { readSpatialJson } from "./spatial-scene-service";
import { createWorldLabsService, WorldLabsError, type WorldLabsErrorCode } from "./world-labs-service";
import type { GatewayMediaDownload } from "./gateway-media-service";

const errors: Readonly<Record<WorldLabsErrorCode, CliErrorCode>> = {
  "invalid-request": "invalid-data", "permission-required": "authorization-required",
  "credential-unavailable": "unavailable", "budget-exhausted": "conflict", "price-mismatch": "conflict", conflict: "conflict",
  "attempt-unavailable": "not-found", "provider-unavailable": "unavailable",
  "invalid-response": "invalid-data", "download-failed": "unavailable", "unsafe-artifact": "unsafe-path",
};

function summary(value: WorldLabsAttemptSummary) {
  return { ...value, nextCommand: value.status === "pending"
    ? `atet scene world resume ${value.attemptId} --json`
    : value.status === "ambiguous" || value.status === "prepared"
      ? `atet scene world inspect ${value.attemptId} --json` : null };
}

export async function executeSpatialWorldCommand(
  application: ApplicationContext,
  command: SpatialWorldCommand,
  adapter: Readonly<{ environment: Readonly<Record<string, string | undefined>>; signal?: AbortSignal; service?: WorldLabsService;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; download?: GatewayMediaDownload }>,
): Promise<unknown> {
  const repositoryRoot = application.paths.repositoryRoot;
  let attemptId = "attemptId" in command && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(command.attemptId) ? command.attemptId : undefined;
  // Cancellation must not prevent the provider's final secret-free operation
  // binding after an accepted POST. Each cancellable phase checks its own signal.
  const assertOwned = async () => { await application.hostResourceLease?.assertOwned(); };
  try {
    if (adapter.signal?.aborted) throw new CliError("cancelled", "World command cancelled before dispatch.");
    if (command.action === "import") {
      const input = SavedSpatialWorldImportInputSchema.safeParse(await readSpatialJson(resolve(repositoryRoot, command.input)));
      if (!input.success) throw new CliError("invalid-data", "The saved world import input is invalid.");
      const outputRoot = resolve(repositoryRoot, command.outputRoot);
      const generatedRoot = join(repositoryRoot, "artifacts", "atet", "generated");
      const outputRelative = relative(generatedRoot, outputRoot);
      if (outputRelative === "" || outputRelative.startsWith(`..${sep}`) || outputRelative === ".." || resolve(generatedRoot, outputRelative) !== outputRoot) {
        throw new CliError("unsafe-path", "World imports require a dedicated directory below artifacts/atet/generated.");
      }
      const destinationRoot = await ensurePhysicalPrivateDirectoryWithin(repositoryRoot, relative(repositoryRoot, outputRoot));
      return await importSavedSpatialWorld({ sourceRoot: resolve(repositoryRoot, command.sourceRoot), destinationRoot, input: input.data,
        signal: adapter.signal ?? new AbortController().signal, beforePublication: assertOwned });
    }
    if (command.action === "plan") {
      const input = WorldLabsGenerationInputSchema.safeParse(await readSpatialJson(resolve(repositoryRoot, command.input)));
      if (!input.success) throw new CliError("invalid-data", "The World Labs plan input is invalid.");
      return planWorldLabsGeneration(input.data);
    }
    const service = adapter.service ?? createWorldLabsService({ repositoryRoot,
      loadCredential: async () => adapter.environment["WORLDLABS_API_KEY"] ?? "", assertOwned,
      ...(adapter.fetch === undefined ? {} : { fetch: adapter.fetch }),
      ...(adapter.download === undefined ? {} : { download: adapter.download }) });
    switch (command.action) {
      case "generate": {
        const input = await readSpatialJson(resolve(repositoryRoot, command.input));
        if (typeof input === "object" && input !== null && "attemptId" in input && typeof input.attemptId === "string"
          && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.attemptId)) attemptId = input.attemptId;
        return summary(await service.generate(input, {
          grant: { allowPaidGeneration: command.allowPaidGeneration, budgetId: command.budgetId, maximumCredits: command.maximumCredits }, ...(adapter.signal === undefined ? {} : { signal: adapter.signal }),
        }));
      }
      case "inspect": return summary(await service.inspect({ attemptId: command.attemptId }));
      case "resume": return summary(await service.resume({ attemptId: command.attemptId }, { allowProviderRead: true, ...(adapter.signal === undefined ? {} : { signal: adapter.signal }) }));
      case "recover": return summary(await service.recover({ attemptId: command.attemptId, operationId: command.operationId }, { allowOperationRecovery: true, ...(adapter.signal === undefined ? {} : { signal: adapter.signal }) }));
    }
  } catch (error) {
    if (error instanceof SpatialWorldImportError) throw new CliError(adapter.signal?.aborted ? "cancelled" : "conflict", error.message, {
      published: error.published, attempted: error.attempted,
      ...(command.action === "import" ? { outputRoot: command.outputRoot } : {}),
    });
    const recovery = attemptId === undefined ? undefined : { attemptId, nextCommand: `atet scene world inspect ${attemptId} --json` };
    if (adapter.signal?.aborted && !(error instanceof WorldLabsError && error.code === "conflict")) {
      throw new CliError("cancelled", "World command cancelled. Inspect the same attempt before continuing; generation may already have been accepted.", recovery);
    }
    if (error instanceof WorldLabsError) throw new CliError(errors[error.code], error.message, recovery);
    if (command.action === "import" && error instanceof RangeError) throw new CliError("invalid-data", error.message);
    throw error;
  }
}
