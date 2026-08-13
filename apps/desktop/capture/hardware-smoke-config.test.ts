import { describe, expect, test } from "bun:test";

import {
  HARDWARE_SMOKE_CAMERA_ENVIRONMENT_NAME,
  HARDWARE_SMOKE_CONFIRMATION_ENVIRONMENT_NAME,
  HARDWARE_SMOKE_CONFIRMATION_VALUE,
  HARDWARE_SMOKE_INTERACTIONS_ENVIRONMENT_NAME,
  HARDWARE_SMOKE_KEEP_ARTIFACTS_ENVIRONMENT_NAME,
  HARDWARE_SMOKE_MICROPHONE_ENVIRONMENT_NAME,
  HARDWARE_SMOKE_MIN_DISPLAYS_ENVIRONMENT_NAME,
  HARDWARE_SMOKE_SYSTEM_AUDIO_ENVIRONMENT_NAME,
  HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME,
  HardwareSmokeConfigError,
  hardwareSmokeRequested,
  parseHardwareSmokeConfig,
} from "./hardware-smoke-config";

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    [HARDWARE_SMOKE_CONFIRMATION_ENVIRONMENT_NAME]:
      HARDWARE_SMOKE_CONFIRMATION_VALUE,
    ...overrides,
  };
}

function captureConfigError(
  env: Readonly<Record<string, string | undefined>>,
): HardwareSmokeConfigError {
  try {
    parseHardwareSmokeConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(HardwareSmokeConfigError);
    return error as HardwareSmokeConfigError;
  }
  throw new Error("Expected hardware-smoke configuration to fail.");
}

describe("capture hardware-smoke configuration", () => {
  test("requires the exact opt-in phrase", () => {
    for (const confirmation of [
      undefined,
      "",
      "1",
      HARDWARE_SMOKE_CONFIRMATION_VALUE.toUpperCase(),
      `${HARDWARE_SMOKE_CONFIRMATION_VALUE} `,
    ]) {
      const env = environment({
        [HARDWARE_SMOKE_CONFIRMATION_ENVIRONMENT_NAME]: confirmation,
      });
      expect(hardwareSmokeRequested(env)).toBeFalse();
      expect(captureConfigError(env).code).toBe("confirmation-required");
    }
  });

  test("defaults to display-only capture and retains failed evidence", () => {
    expect(parseHardwareSmokeConfig(environment())).toEqual({
      camera: false,
      interactions: false,
      keepArtifacts: "on-failure",
      microphone: false,
      minimumDisplays: 1,
      systemAudio: false,
      typedText: false,
    });
  });

  test("accepts the full strict hardware profile", () => {
    expect(parseHardwareSmokeConfig(environment({
      [HARDWARE_SMOKE_CAMERA_ENVIRONMENT_NAME]: "true",
      [HARDWARE_SMOKE_INTERACTIONS_ENVIRONMENT_NAME]: "true",
      [HARDWARE_SMOKE_KEEP_ARTIFACTS_ENVIRONMENT_NAME]: "always",
      [HARDWARE_SMOKE_MICROPHONE_ENVIRONMENT_NAME]: "true",
      [HARDWARE_SMOKE_MIN_DISPLAYS_ENVIRONMENT_NAME]: "16",
      [HARDWARE_SMOKE_SYSTEM_AUDIO_ENVIRONMENT_NAME]: "true",
      [HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME]: "true",
    }))).toEqual({
      camera: true,
      interactions: true,
      keepArtifacts: "always",
      microphone: true,
      minimumDisplays: 16,
      systemAudio: true,
      typedText: true,
    });
  });

  test("accepts only exact boolean values", () => {
    expect(parseHardwareSmokeConfig(environment({
      [HARDWARE_SMOKE_CAMERA_ENVIRONMENT_NAME]: "false",
      [HARDWARE_SMOKE_MICROPHONE_ENVIRONMENT_NAME]: "false",
      [HARDWARE_SMOKE_SYSTEM_AUDIO_ENVIRONMENT_NAME]: "false",
    }))).toMatchObject({
      camera: false,
      microphone: false,
      systemAudio: false,
    });
    for (const name of [
      HARDWARE_SMOKE_CAMERA_ENVIRONMENT_NAME,
      HARDWARE_SMOKE_INTERACTIONS_ENVIRONMENT_NAME,
      HARDWARE_SMOKE_MICROPHONE_ENVIRONMENT_NAME,
      HARDWARE_SMOKE_SYSTEM_AUDIO_ENVIRONMENT_NAME,
      HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME,
    ]) {
      for (const value of ["", "1", "TRUE", "yes", "false "]) {
        expect(captureConfigError(environment({ [name]: value })).code)
          .toBe("invalid-boolean");
      }
    }
  });

  test("allows typed-text capture only inside the owned interaction fixture", () => {
    expect(captureConfigError(environment({
      [HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME]: "true",
    })).code).toBe("typed-text-requires-interactions");
    expect(parseHardwareSmokeConfig(environment({
      [HARDWARE_SMOKE_INTERACTIONS_ENVIRONMENT_NAME]: "true",
      [HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME]: "true",
    }))).toMatchObject({
      interactions: true,
      typedText: true,
    });
  });

  test("bounds the minimum connected-display requirement", () => {
    for (const value of ["", "0", "01", "1.5", "17", "-1", "two"]) {
      expect(captureConfigError(environment({
        [HARDWARE_SMOKE_MIN_DISPLAYS_ENVIRONMENT_NAME]: value,
      })).code).toBe("invalid-minimum-displays");
    }
    expect(parseHardwareSmokeConfig(environment({
      [HARDWARE_SMOKE_MIN_DISPLAYS_ENVIRONMENT_NAME]: "2",
    })).minimumDisplays).toBe(2);
  });

  test("bounds artifact-retention policy", () => {
    for (const value of ["", "true", "failure", "on_failure", "always "]) {
      expect(captureConfigError(environment({
        [HARDWARE_SMOKE_KEEP_ARTIFACTS_ENVIRONMENT_NAME]: value,
      })).code).toBe("invalid-keep-artifacts");
    }
    expect(parseHardwareSmokeConfig(environment({
      [HARDWARE_SMOKE_KEEP_ARTIFACTS_ENVIRONMENT_NAME]: "never",
    })).keepArtifacts).toBe("never");
  });
});
