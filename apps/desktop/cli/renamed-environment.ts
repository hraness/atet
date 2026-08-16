export function renamedEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  canonical: `ATET_${string}`,
): string | undefined {
  return environment[canonical];
}
