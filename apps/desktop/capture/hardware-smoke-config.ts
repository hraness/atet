export const HARDWARE_SMOKE_CONFIRMATION_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_CONFIRM";
export const HARDWARE_SMOKE_CONFIRMATION_VALUE =
  "record-local-displays-and-selected-inputs";

export const HARDWARE_SMOKE_SYSTEM_AUDIO_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_SYSTEM_AUDIO";
export const HARDWARE_SMOKE_CAMERA_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_CAMERA";
export const HARDWARE_SMOKE_MICROPHONE_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_MICROPHONE";
export const HARDWARE_SMOKE_INTERACTIONS_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_INTERACTIONS";
export const HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_TYPED_TEXT";
export const HARDWARE_SMOKE_MIN_DISPLAYS_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_MIN_DISPLAYS";
export const HARDWARE_SMOKE_KEEP_ARTIFACTS_ENVIRONMENT_NAME =
  "ATET_CAPTURE_HARDWARE_KEEP_ARTIFACTS";

export const HARDWARE_SMOKE_ACTIVE_SEGMENT_MS = 2_500;
export const HARDWARE_SMOKE_PAUSE_MS = 750;
export const HARDWARE_SMOKE_MAX_CONTAINER_DURATION_SPREAD_US = 500_000;
export const HARDWARE_SMOKE_MIN_ACTIVE_SEGMENT_US = 2_400_000;
export const HARDWARE_SMOKE_MIN_NATIVE_PAUSE_US = 700_000;

export type HardwareSmokeArtifactRetention =
  | "always"
  | "never"
  | "on-failure";

export interface HardwareSmokeConfig {
  readonly camera: boolean;
  readonly interactions: boolean;
  readonly keepArtifacts: HardwareSmokeArtifactRetention;
  readonly microphone: boolean;
  readonly minimumDisplays: number;
  readonly systemAudio: boolean;
  readonly typedText: boolean;
}

export type HardwareSmokeConfigErrorCode =
  | "confirmation-required"
  | "invalid-boolean"
  | "invalid-keep-artifacts"
  | "invalid-minimum-displays"
  | "renamed-environment-conflict"
  | "typed-text-requires-interactions";

export class HardwareSmokeConfigError extends Error {
  readonly code: HardwareSmokeConfigErrorCode;

  constructor(code: HardwareSmokeConfigErrorCode, message: string) {
    super(message);
    this.name = "HardwareSmokeConfigError";
    this.code = code;
  }
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const predecessor = name.replace(/^ATET_/u, "TRANSMUTE_");
  const current = environment[name];
  const legacy = environment[predecessor];
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new HardwareSmokeConfigError(
      "renamed-environment-conflict",
      `${name} and ${predecessor} disagree; remove one or set both to the same value.`,
    );
  }
  return current ?? legacy;
}

export function hardwareSmokeRequested(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environmentValue(environment, HARDWARE_SMOKE_CONFIRMATION_ENVIRONMENT_NAME)
    === HARDWARE_SMOKE_CONFIRMATION_VALUE;
}

function booleanEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  const value = environmentValue(environment, name);
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HardwareSmokeConfigError(
    "invalid-boolean",
    `${name} must be exactly true or false.`,
  );
}

function minimumDisplaysEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const value = environmentValue(environment, HARDWARE_SMOKE_MIN_DISPLAYS_ENVIRONMENT_NAME);
  if (value === undefined) return 1;
  if (!/^(?:[1-9]|1[0-6])$/u.test(value)) {
    throw new HardwareSmokeConfigError(
      "invalid-minimum-displays",
      `${HARDWARE_SMOKE_MIN_DISPLAYS_ENVIRONMENT_NAME} must be an integer from 1 through 16.`,
    );
  }
  return Number(value);
}

function artifactRetentionEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): HardwareSmokeArtifactRetention {
  const value =
    environmentValue(environment, HARDWARE_SMOKE_KEEP_ARTIFACTS_ENVIRONMENT_NAME)
    ?? "on-failure";
  if (value === "always" || value === "never" || value === "on-failure") {
    return value;
  }
  throw new HardwareSmokeConfigError(
    "invalid-keep-artifacts",
    `${HARDWARE_SMOKE_KEEP_ARTIFACTS_ENVIRONMENT_NAME} must be always, never, or on-failure.`,
  );
}

export function parseHardwareSmokeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): HardwareSmokeConfig {
  if (!hardwareSmokeRequested(environment)) {
    throw new HardwareSmokeConfigError(
      "confirmation-required",
      `Set ${HARDWARE_SMOKE_CONFIRMATION_ENVIRONMENT_NAME}=${HARDWARE_SMOKE_CONFIRMATION_VALUE} to record local displays and selected inputs.`,
    );
  }
  const interactions = booleanEnvironment(
    environment,
    HARDWARE_SMOKE_INTERACTIONS_ENVIRONMENT_NAME,
  );
  const typedText = booleanEnvironment(
    environment,
    HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME,
  );
  if (typedText && !interactions) {
    throw new HardwareSmokeConfigError(
      "typed-text-requires-interactions",
      `${HARDWARE_SMOKE_TYPED_TEXT_ENVIRONMENT_NAME}=true requires ${HARDWARE_SMOKE_INTERACTIONS_ENVIRONMENT_NAME}=true so only owned fixture canaries can be captured.`,
    );
  }
  return {
    camera: booleanEnvironment(
      environment,
      HARDWARE_SMOKE_CAMERA_ENVIRONMENT_NAME,
    ),
    interactions,
    keepArtifacts: artifactRetentionEnvironment(environment),
    microphone: booleanEnvironment(
      environment,
      HARDWARE_SMOKE_MICROPHONE_ENVIRONMENT_NAME,
    ),
    minimumDisplays: minimumDisplaysEnvironment(environment),
    systemAudio: booleanEnvironment(
      environment,
      HARDWARE_SMOKE_SYSTEM_AUDIO_ENVIRONMENT_NAME,
    ),
    typedText,
  };
}
