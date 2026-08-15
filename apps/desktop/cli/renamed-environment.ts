export class RenamedEnvironmentConflictError extends Error {
  constructor(canonical: string, predecessor: string) {
    super(`${canonical} and ${predecessor} disagree; remove one or set both to the same value.`);
    this.name = "RenamedEnvironmentConflictError";
  }
}

/** Resolve an Atet environment value while preserving one fail-closed Transmute fallback. */
export function renamedEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  canonical: `ATET_${string}`,
): string | undefined {
  const predecessor = canonical.replace(/^ATET_/u, "TRANSMUTE_");
  const current = environment[canonical];
  const legacy = environment[predecessor];
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new RenamedEnvironmentConflictError(canonical, predecessor);
  }
  return current ?? legacy;
}
