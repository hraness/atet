export function renamedEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  canonical: `SLOPCAMERA_${string}`,
): string | undefined {
  return environment[canonical];
}
