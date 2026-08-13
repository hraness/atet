import { expect, test } from "bun:test"
import { nonGatewayChildEnvironment } from "./process-environment.ts"

test("non-Gateway children never inherit Gateway credentials", () => {
  const source = {
    AI_GATEWAY_API_KEY: "gateway-secret",
    Path: "/usr/bin:/bin",
    SAFE_MARKER: "preserved",
    vercel_oidc_token: "oidc-secret",
  }
  const environment = nonGatewayChildEnvironment(source)

  expect(environment).toEqual({
    Path: "/usr/bin:/bin",
    SAFE_MARKER: "preserved",
  })
  expect(source).toHaveProperty("AI_GATEWAY_API_KEY")
  expect(source).toHaveProperty("vercel_oidc_token")
})
