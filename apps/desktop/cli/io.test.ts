import { describe, expect, test } from "bun:test";

import { BunProcessRunner, environmentWithoutGatewayCredentials } from "./io";

const bun = process.execPath;

function outputBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

describe("BunProcessRunner", () => {
  test("never forwards Gateway credentials to tool children", async () => {
    const environment = environmentWithoutGatewayCredentials({
      AI_GATEWAY_API_KEY: "secret-api-key",
      Path: "/safe/bin",
      vercel_oidc_token: "secret-oidc-token",
    });
    expect(environment).toEqual({ Path: "/safe/bin" });

    const result = await new BunProcessRunner().run([
      bun,
      "-e",
      "process.stdout.write(JSON.stringify({ api: process.env.AI_GATEWAY_API_KEY, oidc: process.env.VERCEL_OIDC_TOKEN, marker: process.env.SAFE_MARKER }))",
    ], {
      env: {
        AI_GATEWAY_API_KEY: "secret-api-key",
        SAFE_MARKER: "preserved",
        VERCEL_OIDC_TOKEN: "secret-oidc-token",
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({ marker: "preserved" });
    expect(result.stdout).not.toContain("secret-api-key");
    expect(result.stdout).not.toContain("secret-oidc-token");
  });

  test("retains independently bounded stdout and stderr tails", async () => {
    const result = await new BunProcessRunner().run([
      bun,
      "-e",
      `process.stdout.write("o".repeat(100_000) + "stdout-tail");\nprocess.stderr.write("e".repeat(100_000) + "stderr-tail");`,
    ], { maxOutputBytes: 32 });

    expect(result.exitCode).toBe(0);
    expect(outputBytes(result.stdout)).toBeLessThanOrEqual(32);
    expect(outputBytes(result.stderr)).toBeLessThanOrEqual(32);
    expect(result.stdout).toEndWith("stdout-tail");
    expect(result.stderr).toEndWith("stderr-tail");
  });

  test("does not expose a replacement character when a byte cap bisects UTF-8", async () => {
    const result = await new BunProcessRunner().run([
      bun,
      "-e",
      `process.stdout.write("prefix🙂Z");\nprocess.stderr.write("prefix🙂E");`,
    ], { maxOutputBytes: 2 });

    expect(result).toEqual({ exitCode: 0, stderr: "E", stdout: "Z" });
  });

  test("decodes multibyte characters split across writes", async () => {
    const result = await new BunProcessRunner().run([
      bun,
      "-e",
      `const bytes = new TextEncoder().encode("🙂");\nfor (const byte of bytes) process.stdout.write(Uint8Array.of(byte));`,
    ], { maxOutputBytes: 4 });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "🙂" });
  });

  test("preserves nonzero exit codes and their stderr tail", async () => {
    const result = await new BunProcessRunner().run([
      bun,
      "-e",
      `process.stderr.write("discard-".repeat(1_000) + "useful failure");\nprocess.exitCode = 23;`,
    ], { maxOutputBytes: 32 });

    expect(result.exitCode).toBe(23);
    expect(result.stderr).toEndWith("useful failure");
    expect(outputBytes(result.stderr)).toBeLessThanOrEqual(32);
  });

  test("terminates a child and reports cancellation through the shared taxonomy", () => {
    const controller = new AbortController();
    const execution = new BunProcessRunner().run([
      bun,
      "-e",
      "setInterval(() => undefined, 1_000);",
    ], { abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    expect(execution).rejects.toMatchObject({ code: "cancelled" });
  });
});
