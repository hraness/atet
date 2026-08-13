const gatewayCredentialNames = new Set([
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
])

/** Copy an environment for a non-Gateway child without delegating authority. */
export function nonGatewayChildEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment = { ...source }
  for (const name of Object.keys(environment)) {
    if (gatewayCredentialNames.has(name.toLocaleUpperCase("en-US"))) {
      delete environment[name]
    }
  }
  return environment
}
