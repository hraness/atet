export const GATEWAY_CREDENTIAL_ENV_NAMES = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
] as const;

export type GatewayCredentialSource =
  | "AI_GATEWAY_API_KEY"
  | "VERCEL_OIDC_TOKEN";

export class GatewayCredentialError extends Error {
  readonly code: "invalid" | "missing";

  constructor(code: "invalid" | "missing") {
    super(code === "missing"
      ? "Set AI_GATEWAY_API_KEY, or run Transmute with `vercel env run -- …` so VERCEL_OIDC_TOKEN is available."
      : "The Vercel AI Gateway credential is invalid.");
    this.name = "GatewayCredentialError";
    this.code = code;
  }
}

function parseCredential(value: string | undefined): string | null {
  if (value === undefined) return null;
  const bytes = new TextEncoder().encode(value);
  if (
    bytes.byteLength < 16
    || bytes.byteLength > 16_384
    || !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new GatewayCredentialError("invalid");
  }
  return value;
}

export class ActiveGatewayCredential {
  readonly source: GatewayCredentialSource;
  readonly #value: string;

  constructor(source: GatewayCredentialSource, value: string) {
    const parsed = parseCredential(value);
    if (parsed === null) throw new GatewayCredentialError("invalid");
    this.source = source;
    this.#value = parsed;
  }

  withApiKey<Result>(operation: (apiKey: string) => Result): Result {
    return operation(this.#value);
  }

  toJSON(): Readonly<{ source: GatewayCredentialSource }> {
    return { source: this.source };
  }
}

export function inspectGatewayCredential(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{
  configured: boolean;
  source: GatewayCredentialSource | null;
}> {
  const apiKey = parseCredential(env.AI_GATEWAY_API_KEY);
  if (apiKey !== null) return { configured: true, source: "AI_GATEWAY_API_KEY" };
  const oidcToken = parseCredential(env.VERCEL_OIDC_TOKEN);
  return oidcToken === null
    ? { configured: false, source: null }
    : { configured: true, source: "VERCEL_OIDC_TOKEN" };
}

export function loadGatewayCredential(
  env: Readonly<Record<string, string | undefined>>,
): ActiveGatewayCredential {
  const apiKey = parseCredential(env.AI_GATEWAY_API_KEY);
  if (apiKey !== null) {
    return new ActiveGatewayCredential("AI_GATEWAY_API_KEY", apiKey);
  }
  const oidcToken = parseCredential(env.VERCEL_OIDC_TOKEN);
  if (oidcToken !== null) {
    return new ActiveGatewayCredential("VERCEL_OIDC_TOKEN", oidcToken);
  }
  throw new GatewayCredentialError("missing");
}
