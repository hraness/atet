import { z } from "zod";

import type {
  ApplicationCapability,
  ApplicationCapabilityName,
  ApplicationContext,
} from "../context";
import { ApplicationError } from "../errors";

export const ProjectReferenceSchema = z.string()
  .min(9)
  .max(128)
  .regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u);

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ApplicationError("cancelled", "Operation was cancelled.");
  }
}

export function requireCapability(
  capabilities: readonly ApplicationCapability[],
  name: string,
): ApplicationCapability & { readonly command: string } {
  const capability = capabilities.find(candidate => candidate.name === name);
  if (
    capability === undefined
    || !capability.available
    || capability.command === undefined
    || capability.command === ""
  ) {
    throw new ApplicationError(
      "unavailable",
      `${name} is unavailable: ${capability?.reason ?? "capability was not probed"}`,
      { capability: name },
    );
  }
  return { ...capability, command: capability.command };
}

export async function requireCapabilities(
  application: ApplicationContext,
  names: readonly ApplicationCapabilityName[],
): Promise<ReadonlyMap<string, ApplicationCapability & { readonly command: string }>> {
  return new Map(await Promise.all(names.map(async name => [
    name,
    requireCapability([await application.capability(name)], name),
  ] as const)));
}

export function requiredCapabilityCommand(
  capabilities: ReadonlyMap<string, ApplicationCapability & { readonly command: string }>,
  name: string,
): string {
  const capability = capabilities.get(name);
  if (capability === undefined) {
    throw new ApplicationError("internal", `Required capability was not resolved: ${name}`);
  }
  return capability.command;
}

export function requiredCapabilityVersion(
  capabilities: ReadonlyMap<string, ApplicationCapability & { readonly command: string }>,
  name: string,
): string {
  return capabilities.get(name)?.version ?? "unknown";
}
