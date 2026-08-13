import { describe, expect, test } from "bun:test";

import {
  GatewayCredentialError,
  inspectGatewayCredential,
  loadGatewayCredential,
} from "./gateway-credential";

const API_KEY = "vck_test_gateway_key_1234567890";
const OIDC_TOKEN = "ey.test-oidc-token.1234567890";

describe("Gateway environment credentials", () => {
  test("prefers the explicit API key without exposing it", () => {
    const credential = loadGatewayCredential({
      AI_GATEWAY_API_KEY: API_KEY,
      VERCEL_OIDC_TOKEN: OIDC_TOKEN,
    });
    expect(credential.toJSON()).toEqual({ source: "AI_GATEWAY_API_KEY" });
    expect(JSON.stringify(credential)).not.toContain(API_KEY);
    expect(credential.withApiKey(value => value === API_KEY)).toBeTrue();
  });

  test("uses the Vercel OIDC token injected by vercel env run", () => {
    const credential = loadGatewayCredential({ VERCEL_OIDC_TOKEN: OIDC_TOKEN });
    expect(credential.toJSON()).toEqual({ source: "VERCEL_OIDC_TOKEN" });
    expect(inspectGatewayCredential({ VERCEL_OIDC_TOKEN: OIDC_TOKEN })).toEqual({
      configured: true,
      source: "VERCEL_OIDC_TOKEN",
    });
  });

  test("fails closed when neither supported variable is present", () => {
    expect(() => loadGatewayCredential({})).toThrow(GatewayCredentialError);
    expect(inspectGatewayCredential({})).toEqual({
      configured: false,
      source: null,
    });
  });

  test("rejects whitespace and control characters instead of trimming secrets", () => {
    expect(() => loadGatewayCredential({
      AI_GATEWAY_API_KEY: `${API_KEY}\n`,
    })).toThrow(GatewayCredentialError);
  });
});
