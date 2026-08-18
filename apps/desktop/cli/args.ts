import { CliError } from "./errors";
import { MAX_EVENT_QUERY_LIMIT } from "./query-limits";

export type OverlayKind = "image" | "svg" | "gif" | "video" | "emoji";
export type ZoomTargetKind = "rect" | "point" | "cursor" | "window" | "focused-input";
export type EmojiProvider = "apple-emoji-pack" | "brand-catalog";
export type ProjectMediaRole =
  | "screen"
  | "camera"
  | "b-roll"
  | "system-audio"
  | "microphone"
  | "portable-audio"
  | "music"
  | "dialogue"
  | "other";
export type CameraFraming = "tight" | "medium" | "wide" | "group";
export type CameraGapPolicy = "hold" | "fallback" | "fail";
export type CameraFrame = readonly [centerX: number, centerY: number, zoom: number];
export interface CameraPathKeyframe {
  readonly at: string;
  readonly frame: CameraFrame;
}
export type GatewayMediaModelType = "image" | "video" | "speech" | "transcription";
export type GatewayFrameType = "first" | "last";
export type TranscriptOutputFormat = "all" | "json" | "srt" | "text" | "vtt";
export type AudioReverbPreset = "room" | "hall" | "plate";
export type VideoColorPreset = "clean" | "cool" | "cinematic" | "flat" | "mono" | "vivid" | "warm";

export interface GatewayFrameInput {
  readonly frameType: GatewayFrameType;
  readonly path: string;
}

interface JsonOption {
  readonly json: boolean;
}

export type CliCommand =
  | { readonly kind: "help"; readonly topic: readonly string[] }
  | { readonly kind: "version" }
  | ({ readonly kind: "operations-list" } & JsonOption)
  | ({ readonly kind: "operations-show"; readonly operation: string } & JsonOption)
  | ({ readonly kind: "diagram-check"; readonly path: string } & JsonOption)
  | ({ readonly kind: "diagram-render"; readonly path: string; readonly scale: number | undefined } & JsonOption)
  | ({
      readonly alphaCutoff: number | undefined;
      readonly duotone: readonly [string, string] | undefined;
      readonly inputPath: string;
      readonly kind: "image-vectorize";
      readonly timeoutMs: number | undefined;
    } & JsonOption)
  | ({ readonly kind: "workflows-list" } & JsonOption)
  | ({ readonly kind: "workflows-show"; readonly workflow: string } & JsonOption)
  | ({
      readonly input: string;
      readonly kind: "workflows-plan";
      readonly workflow: string;
    } & JsonOption)
  | ({
      readonly input: string;
      readonly jobs: number;
      readonly jsonl: boolean;
      readonly kind: "workflows-run";
      readonly providerOptions: string | undefined;
      readonly workflow: string;
    } & JsonOption)
  | { readonly kind: "code-init"; readonly path: string }
  | ({ readonly kind: "code-check"; readonly path: string } & JsonOption)
  | ({
      readonly input: string;
      readonly kind: "code-plan";
      readonly path: string;
    } & JsonOption)
  | ({
      readonly input: string;
      readonly jobs: number;
      readonly jsonl: boolean;
      readonly kind: "code-run";
      readonly path: string;
      readonly plan: string | undefined;
      readonly providerOptions: string | undefined;
    } & JsonOption)
  | ({ readonly kind: "runs-list"; readonly limit: number } & JsonOption)
  | ({
      readonly kind: "runs-show";
      readonly nodes: "all" | "failed";
      readonly runId: string;
    } & JsonOption)
  | ({
      readonly jobs: number;
      readonly jsonl: boolean;
      readonly kind: "runs-resume";
      readonly providerOptions: string | undefined;
      readonly replayAmbiguousCode: readonly string[];
      readonly runId: string;
    } & JsonOption)
  | ({
      readonly kind: "runs-approve";
      readonly nodeKey: string;
      readonly planHash: string;
      readonly planKind: "effect" | "preparation";
      readonly runId: string;
    } & JsonOption)
  | ({ readonly kind: "runs-cancel"; readonly runId: string } & JsonOption)
  | ({ readonly kind: "doctor" } & JsonOption)
  | ({
      readonly kind: "ai-provider-options-inspect";
      readonly path: string;
    } & JsonOption)
  | ({
      readonly kind: "ai-models-list";
      readonly limit: number;
      readonly modelType: GatewayMediaModelType | "all";
      readonly provider: string | undefined;
      readonly query: string | undefined;
      readonly refresh: boolean;
    } & JsonOption)
  | ({
      readonly kind: "ai-models-show";
      readonly model: string;
      readonly refresh: boolean;
    } & JsonOption)
  | ({
      readonly allowCloudUpload: boolean;
      readonly aspectRatio: string | undefined;
      readonly count: number;
      readonly images: readonly string[];
      readonly kind: "ai-image-generate";
      readonly mask: string | undefined;
      readonly maxPerCall: number | undefined;
      readonly maxOutputTokens: number | undefined;
      readonly model: string;
      readonly prompt: string | undefined;
      readonly promptFile: string | undefined;
      readonly providerOptions: string | undefined;
      readonly seed: number | undefined;
      readonly size: string | undefined;
      readonly stopSequences: readonly string[];
      readonly temperature: number | undefined;
      readonly timeout: string;
    } & JsonOption)
  | ({
      readonly allowCloudUpload: boolean;
      readonly aspectRatio: string | undefined;
      readonly count: number;
      readonly durationSeconds: number | undefined;
      readonly fps: number | undefined;
      readonly frameImages: readonly GatewayFrameInput[];
      readonly generateAudio: boolean | undefined;
      readonly image: string | undefined;
      readonly inputReferences: readonly string[];
      readonly kind: "ai-video-generate";
      readonly maxPerCall: number | undefined;
      readonly model: string;
      readonly prompt: string | undefined;
      readonly promptFile: string | undefined;
      readonly providerOptions: string | undefined;
      readonly resolution: string | undefined;
      readonly seed: number | undefined;
      readonly timeout: string;
    } & JsonOption)
  | ({
      readonly instructions: string | undefined;
      readonly instructionsFile: string | undefined;
      readonly kind: "ai-speech-generate";
      readonly language: string | undefined;
      readonly model: string;
      readonly outputFormat: string | undefined;
      readonly providerOptions: string | undefined;
      readonly speed: number | undefined;
      readonly text: string | undefined;
      readonly textFile: string | undefined;
      readonly timeout: string;
      readonly voice: string | undefined;
    } & JsonOption)
  | ({
      readonly allowCloudAudioUpload: boolean;
      readonly format: TranscriptOutputFormat;
      readonly input: string;
      readonly kind: "ai-transcribe";
      readonly model: string;
      readonly providerOptions: string | undefined;
      readonly timeout: string;
    } & JsonOption)
  | ({
      readonly audioStreamIndex: number;
      readonly compressor: boolean;
      readonly compressorAttackMs: number;
      readonly compressorMakeupDb: number;
      readonly compressorRatio: number;
      readonly compressorReleaseMs: number;
      readonly compressorThresholdDb: number;
      readonly delayFeedback: number;
      readonly delayMix: number;
      readonly delayMs: number | undefined;
      readonly denoise: boolean;
      readonly denoiseReductionDb: number;
      readonly input: string;
      readonly kind: "media-audio";
      readonly output: string | undefined;
      readonly reverb: AudioReverbPreset | undefined;
      readonly reverbWet: number;
      readonly volumeDb: number | undefined;
    } & JsonOption)
  | ({
      readonly brightness: number | undefined;
      readonly contrast: number | undefined;
      readonly gamma: number | undefined;
      readonly hueDegrees: number | undefined;
      readonly input: string;
      readonly kind: "media-color";
      readonly output: string | undefined;
      readonly preset: VideoColorPreset | undefined;
      readonly saturation: number | undefined;
      readonly temperature: number | undefined;
      readonly tint: number | undefined;
      readonly videoStreamIndex: number;
    } & JsonOption)
  | ({
      readonly composition: string;
      readonly kind: "media-compose";
      readonly output: string | undefined;
    } & JsonOption)
  | ({ readonly kind: "recordings-list"; readonly limit: number } & JsonOption)
  | ({ readonly kind: "projects-list"; readonly limit: number } & JsonOption)
  | ({
      readonly kind: "projects-create";
      readonly name: string | undefined;
      readonly recording: string;
    } & JsonOption)
  | ({ readonly kind: "project-inspect"; readonly project: string } & JsonOption)
  | ({
      readonly at: string;
      readonly kind: "project-add";
      readonly path: string;
      readonly project: string;
      readonly role: ProjectMediaRole;
    } & JsonOption)
  | ({
      readonly action: "push";
      readonly center: readonly [number, number];
      readonly easing: string;
      readonly endZoom: number;
      readonly from: string;
      readonly kind: "project-camera-edit";
      readonly placement: string;
      readonly project: string;
      readonly startZoom: number;
      readonly stream: string;
      readonly to: string;
    } & JsonOption)
  | ({
      readonly action: "reframe";
      readonly easing: string;
      readonly from: string;
      readonly fromFrame: CameraFrame;
      readonly kind: "project-camera-edit";
      readonly placement: string;
      readonly project: string;
      readonly stream: string;
      readonly to: string;
      readonly toFrame: CameraFrame;
    } & JsonOption)
  | ({
      readonly action: "path";
      readonly easing: string;
      readonly keyframes: readonly CameraPathKeyframe[];
      readonly kind: "project-camera-edit";
      readonly placement: string;
      readonly project: string;
      readonly stream: string;
    } & JsonOption)
  | ({
      readonly action: "follow-faces";
      readonly analysis: string;
      readonly easing: string;
      readonly framing: CameraFraming;
      readonly from: string;
      readonly gapPolicy: CameraGapPolicy;
      readonly headroom: number;
      readonly kind: "project-camera-edit";
      readonly maxZoom: number;
      readonly minZoom: number;
      readonly outputHeight: number;
      readonly outputWidth: number;
      readonly placement: string;
      readonly project: string;
      readonly requireAllSelected: boolean;
      readonly select: "all" | "largest" | undefined;
      readonly smoothing: number;
      readonly to: string;
      readonly tracks: readonly string[];
    } & JsonOption)
  | ({
      readonly action: "show";
      readonly kind: "project-camera-edit";
      readonly project: string;
    } & JsonOption)
  | ({
      readonly action: "remove";
      readonly cameraMoveId: string;
      readonly kind: "project-camera-edit";
      readonly project: string;
    } & JsonOption)
  | ({
      readonly from: string;
      readonly kind: "project-edit";
      readonly operation: "cut" | "trim";
      readonly project: string;
      readonly to: string;
    } & JsonOption)
  | ({
      readonly edit: Extract<EditCommand, { readonly operation: "overlay-add" | "overlay-remove" }>;
      readonly fps: number | undefined;
      readonly kind: "project-overlay-edit";
      readonly project: string;
    } & JsonOption)
  | ({
      readonly edit: Extract<EditCommand, {
        readonly operation: "zoom-add" | "zoom-remove" | "cursor" | "clicks" | "keystrokes" | "typed-text";
      }>;
      readonly fps: number | undefined;
      readonly kind: "project-metadata-edit";
      readonly project: string;
      readonly sourcePlacement: string | undefined;
    } & JsonOption)
  | ({
      readonly action: "plan" | "run";
      readonly allowUnverifiedSync: boolean;
      readonly dryRun: boolean;
      readonly fps: number;
      readonly height: number;
      readonly kind: "project-render";
      readonly output: string | undefined;
      readonly project: string;
      readonly width: number;
    } & JsonOption)
  | ({
      readonly apply: boolean;
      readonly candidate: string | undefined;
      readonly kind: "align-analyze";
      readonly maxOffset: string | undefined;
      readonly project: string;
      readonly reference: string;
      readonly referencePlacement: string | undefined;
      readonly target: string;
      readonly targetPlacement: string | undefined;
    } & JsonOption)
  | ({
      readonly analysis: string;
      readonly candidate: string;
      readonly kind: "align-apply";
      readonly project: string;
      readonly referencePlacement: string | undefined;
      readonly targetPlacement: string | undefined;
    } & JsonOption)
  | ({
      readonly from: string;
      readonly kind: "project-edit";
      readonly operation: "speed";
      readonly project: string;
      readonly rate: number;
      readonly to: string;
    } & JsonOption)
  | ({
      readonly fields: readonly string[] | undefined;
      readonly kind: "inspect";
      readonly recording: string;
    } & JsonOption)
  | ({
      readonly kind: "analyze-music";
      readonly project: string;
      readonly source: string;
      readonly window: string;
    } & JsonOption)
  | ({
      readonly backend: "auto" | "vision";
      readonly kind: "analyze-faces";
      readonly maxFaces: number;
      readonly maxTrackGap: string;
      readonly minConfidence: number;
      readonly project: string;
      readonly sampleFps: number;
      readonly source: string;
    } & JsonOption)
  | ({
      readonly allowCloudUpload: boolean;
      readonly execute: boolean;
      readonly kind: "analyze-scenes";
      readonly maximumSceneDuration: string;
      readonly model: string;
      readonly project: string;
      readonly sceneThreshold: number;
      readonly source: string;
    } & JsonOption)
  | ({
      readonly kind: "analyze-speech";
      readonly language: string;
      readonly minimumFillerConfidence: number;
      readonly model: string | undefined;
      readonly noGpu: boolean;
      readonly processors: number;
      readonly protectMusic: boolean;
      readonly project: string;
      readonly source: string;
      readonly speechHandle: string;
      readonly threads: number;
      readonly whisper: string | undefined;
    } & JsonOption)
  | ({
      readonly analysis: string;
      readonly autoOnly: boolean;
      readonly kind: "fillers-list";
      readonly project: string;
    } & JsonOption)
  | ({
      readonly analysis: string;
      readonly at: string | undefined;
      readonly kind: "faces-list";
      readonly limit: number;
      readonly minConfidence: number;
      readonly minDuration: string;
      readonly project: string;
    } & JsonOption)
  | ({
      readonly analysis: string;
      readonly candidate: string;
      readonly kind: "fillers-apply";
      readonly placement: string | undefined;
      readonly project: string;
    } & JsonOption)
  | ({
      readonly around: string | undefined;
      readonly eventKinds: readonly string[];
      readonly fps: number | undefined;
      readonly format: "human" | "json" | "jsonl";
      readonly from: string | undefined;
      readonly kind: "events";
      readonly limit: number;
      readonly recording: string;
      readonly to: string | undefined;
    })
  | ({
      readonly action: "start";
      readonly cameraDeviceId: string | undefined;
      readonly displays: readonly string[];
      readonly microphone: boolean;
      readonly microphoneDeviceId: string | undefined;
      readonly strictInputs: boolean;
      readonly systemAudio: boolean;
      readonly typedText: boolean;
      readonly webcam: boolean;
    } & JsonOption & { readonly kind: "record" })
  | ({ readonly action: "pause" | "resume" | "stop" | "status" } & JsonOption & {
      readonly kind: "record";
    })
  | ({
      readonly edit: EditCommand;
      readonly fps: number | undefined;
      readonly kind: "edit";
      readonly recording: string;
    } & JsonOption)
  | ({
      readonly apply: boolean;
      readonly handle: "cut" | "speed" | "keep";
      readonly kind: "analyze-inactivity";
      readonly minDuration: string;
      readonly motionThreshold: number;
      readonly protectAudio: boolean;
      readonly recording: string;
      readonly speedRate: number;
    } & JsonOption)
  | ({
      readonly apply: boolean;
      readonly kind: "analyze-zooms";
      readonly plan: string | undefined;
      readonly recording: string;
    } & JsonOption)
  | ({
      readonly autoInactivity: boolean;
      readonly display: string;
      readonly kind: "render-plan";
      readonly output: string | undefined;
      readonly recording: string;
    } & JsonOption)
  | ({
      readonly autoInactivity: boolean;
      readonly display: string;
      readonly dryRun: boolean;
      readonly kind: "render-run";
      readonly output: string | undefined;
      readonly recording: string;
    } & JsonOption)
  | ({
      readonly kind: "emoji-search";
      readonly limit: number;
      readonly provider: EmojiProvider | "all";
      readonly query: string;
      readonly variant: "color" | "duotone" | undefined;
    } & JsonOption)
  | ({
      readonly kind: "emoji-resolve";
      readonly provider: EmojiProvider | "auto";
      readonly query: string;
      readonly variant: "color" | "duotone" | undefined;
    } & JsonOption)
  | { readonly kind: "complete"; readonly words: readonly string[] };

export type EditCommand =
  | { readonly operation: "init" }
  | { readonly operation: "show" }
  | { readonly from: string; readonly operation: "trim"; readonly to: string }
  | { readonly from: string; readonly operation: "cut"; readonly to: string }
  | { readonly from: string; readonly operation: "speed"; readonly rate: number; readonly to: string }
  | {
      readonly display: string | undefined;
      readonly easing: string;
      readonly enterDuration: string | undefined;
      readonly exitDuration: string | undefined;
      readonly from: string;
      readonly operation: "zoom-add";
      readonly point: readonly [number, number] | undefined;
      readonly rect: readonly [number, number, number, number] | undefined;
      readonly scale: number;
      readonly target: ZoomTargetKind;
      readonly to: string;
      readonly window: string | undefined;
    }
  | { readonly id: string; readonly operation: "zoom-remove" }
  | ({ readonly operation: "overlay-add" } & OverlayAddOptions)
  | { readonly id: string; readonly operation: "overlay-remove" }
  | {
      readonly clickHighlight: boolean | undefined;
      readonly enabled: boolean;
      readonly operation: "cursor";
      readonly smoothing: number | undefined;
    }
  | {
      readonly enabled: boolean;
      readonly operation: "keystrokes";
      readonly stopAfter: string | undefined;
    }
  | {
      readonly color: string;
      readonly duration: string;
      readonly enabled: boolean;
      readonly operation: "clicks";
      readonly radius: number;
      readonly style: "pulse" | "ring" | "fill";
    }
  | {
      readonly enabled: boolean;
      readonly idleTimeout: string;
      readonly maxCharacters: number;
      readonly operation: "typed-text";
      readonly placement: "input" | "caption";
    };

export interface OverlayAddOptions {
  readonly anchor: "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";
  readonly animatedAudio: "mute" | "mix" | "duck";
  readonly audioVolume: number;
  readonly blendMode: "normal" | "addition" | "darken" | "lighten" | "multiply" | "overlay" | "screen";
  readonly cornerRadius: number | undefined;
  readonly crop: readonly [number, number, number, number] | undefined;
  readonly duckPrimaryTo: number;
  readonly entrance: string | undefined;
  readonly entranceDuration: string | undefined;
  readonly entranceFromScale: number;
  readonly easing: string;
  readonly exit: string | undefined;
  readonly exitDuration: string | undefined;
  readonly exitToScale: number;
  readonly fit: "contain" | "cover" | "fill";
  readonly freezeEnd: boolean;
  readonly from: string;
  readonly height: number | undefined;
  readonly loop: boolean;
  readonly motionKeyframes: readonly Readonly<{
    offset: number;
    opacity: number;
    position: readonly [number, number];
    rotation: number;
    scale: number;
  }>[];
  readonly opacity: number;
  readonly overlayKind: OverlayKind;
  readonly provider: EmojiProvider | "auto";
  readonly playbackRate: number;
  readonly position: readonly [number, number];
  readonly rotation: number;
  readonly scale: number;
  readonly source: string;
  readonly sourceIn: string | undefined;
  readonly sourceOut: string | undefined;
  readonly slideDistance: number;
  readonly to: string;
  readonly variant: "color" | "duotone" | undefined;
  readonly width: number | undefined;
  readonly zIndex: number;
}

type OptionKind = "flag" | "value" | "repeat";
type OptionSpec = Readonly<Record<string, OptionKind>>;
type OptionValue = boolean | string | readonly string[];

interface ParsedOptions {
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly positionals: readonly string[];
}

function fail(message: string): never {
  throw new CliError("usage", message);
}

function parseOptions(argv: readonly string[], spec: OptionSpec): ParsedOptions {
  const options: Record<string, OptionValue> = {};
  const positionals: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (optionsEnded || !argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      optionsEnded = true;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    const kind = spec[name];
    if (kind === undefined) fail(`Unknown option: ${name}`);
    if (kind === "flag") {
      if (inlineValue !== undefined) fail(`${name} does not take a value.`);
      if (options[name] !== undefined) fail(`Option may be specified only once: ${name}`);
      options[name] = true;
      continue;
    }
    const nextValue = inlineValue ?? argv[index + 1];
    if (nextValue === undefined || (inlineValue === undefined && nextValue.startsWith("--"))) {
      fail(`Option requires a value: ${name}`);
    }
    if (inlineValue === undefined) index += 1;
    if (kind === "value") {
      if (options[name] !== undefined) fail(`Option may be specified only once: ${name}`);
      options[name] = nextValue;
    } else {
      const previous = options[name];
      options[name] = previous === undefined
        ? [nextValue]
        : [...requireStringArray(previous, name), nextValue];
    }
  }
  return { options, positionals };
}

function requireStringArray(value: OptionValue, option: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`Internal parser error for ${option}.`);
  }
  return value;
}

function optionString(parsed: ParsedOptions, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`Internal parser error for ${name}.`);
  return value;
}

function optionStrings(parsed: ParsedOptions, name: string): readonly string[] {
  const value = parsed.options[name];
  if (value === undefined) return [];
  return requireStringArray(value, name);
}

function optionFlag(parsed: ParsedOptions, name: string): boolean {
  return parsed.options[name] === true;
}

function strictInteger(value: string | undefined, name: string, defaults: number): number {
  if (value === undefined) return defaults;
  if (!/^[1-9][0-9]*$/u.test(value)) fail(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} exceeds the safe integer range.`);
  return parsed;
}

function optionalStrictInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : strictInteger(value, name, 1);
}

function optionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(`${name} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} exceeds the safe integer range.`);
  return parsed;
}

function strictEvenPositiveInteger(value: string | undefined, name: string, defaults: number): number {
  const parsed = strictInteger(value, name, defaults);
  if (parsed % 2 !== 0) fail(`${name} must be an even positive integer.`);
  return parsed;
}

function strictNumber(
  value: string | undefined,
  name: string,
  defaults?: number,
): number {
  if (value === undefined) {
    if (defaults === undefined) fail(`${name} is required.`);
    return defaults;
  }
  if (value.trim() === "" || !Number.isFinite(Number(value))) fail(`${name} must be a finite number.`);
  return Number(value);
}

function boundedNumber(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  defaults?: number,
): number {
  const parsed = strictNumber(value, name, defaults);
  if (parsed < minimum || parsed > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function optionalBoundedNumber(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : boundedNumber(value, name, minimum, maximum);
}

function strictBoolean(value: string | undefined, name: string, defaults: boolean): boolean {
  if (value === undefined) return defaults;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`${name} must be true or false.`);
}

function captureSourceId(
  value: string | undefined,
  name: string,
  maximumUTF8Bytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0
    || value.includes("\0")
    || new TextEncoder().encode(value).byteLength > maximumUTF8Bytes
  ) {
    fail(`${name} must be a non-empty, non-NUL source ID of at most ${maximumUTF8Bytes} UTF-8 bytes.`);
  }
  return value;
}

function oneOf<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
  defaults?: T,
): T {
  if (value === undefined) {
    if (defaults === undefined) fail(`${name} is required.`);
    return defaults;
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) fail(`${name} must be one of: ${allowed.join(", ")}.`);
  return match;
}

function exactPositionals(parsed: ParsedOptions, count: number, usage: string): readonly string[] {
  if (parsed.positionals.length !== count) fail(`Usage: ${usage}`);
  return parsed.positionals;
}

const JSON_SPEC = { "--json": "flag" } as const;

function parseDoctor(argv: readonly string[]): CliCommand {
  const parsed = parseOptions(argv, JSON_SPEC);
  exactPositionals(parsed, 0, "transmute doctor [--json]");
  return { json: optionFlag(parsed, "--json"), kind: "doctor" };
}

function oneTextSource(
  parsed: ParsedOptions,
  inlineName: string,
  fileName: string,
  options: Readonly<{ required: boolean }>,
): Readonly<{ inline: string | undefined; path: string | undefined }> {
  const inline = optionString(parsed, inlineName);
  const path = optionString(parsed, fileName);
  if (inline !== undefined && path !== undefined) {
    fail(`${inlineName} and ${fileName} are mutually exclusive.`);
  }
  if (options.required && inline === undefined && path === undefined) {
    fail(`Exactly one of ${inlineName} or ${fileName} is required.`);
  }
  return { inline, path };
}

function parseGatewayFrameInputs(values: readonly string[]): readonly GatewayFrameInput[] {
  const frames: GatewayFrameInput[] = [];
  const seen = new Set<GatewayFrameType>();
  for (const value of values) {
    const separator = value.indexOf("=");
    const frameType = separator === -1 ? "" : value.slice(0, separator);
    const path = separator === -1 ? "" : value.slice(separator + 1);
    if ((frameType !== "first" && frameType !== "last") || path.trim() === "") {
      fail("--frame must use first=<path-or-https-url> or last=<path-or-https-url>.");
    }
    if (seen.has(frameType)) fail(`--frame ${frameType} may be specified only once.`);
    seen.add(frameType);
    frames.push({ frameType, path });
  }
  return frames;
}

function parseAiModels(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "list") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--limit": "value",
      "--provider": "value",
      "--query": "value",
      "--refresh": "flag",
      "--type": "value",
    });
    exactPositionals(parsed, 0, "transmute ai models list [options]");
    return {
      json: optionFlag(parsed, "--json"),
      kind: "ai-models-list",
      limit: (() => {
        const limit = strictInteger(optionString(parsed, "--limit"), "--limit", 100);
        if (limit > 500) fail("--limit must be at most 500.");
        return limit;
      })(),
      modelType: oneOf(optionString(parsed, "--type"), "--type", [
        "all", "image", "video", "speech", "transcription",
      ] as const, "all"),
      provider: optionString(parsed, "--provider"),
      query: optionString(parsed, "--query"),
      refresh: optionFlag(parsed, "--refresh"),
    };
  }
  if (action === "show") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--refresh": "flag",
    });
    const [model] = exactPositionals(parsed, 1, "transmute ai models show <model> [--refresh] [--json]");
    return {
      json: optionFlag(parsed, "--json"),
      kind: "ai-models-show",
      model: model!,
      refresh: optionFlag(parsed, "--refresh"),
    };
  }
  fail("Usage: transmute ai models <list|show> [options]");
}

function parseAiProviderOptions(argv: readonly string[]): CliCommand {
  if (argv[0] !== "inspect") {
    fail("Usage: transmute ai provider-options inspect <json-file> [--json]");
  }
  const parsed = parseOptions(argv.slice(1), JSON_SPEC);
  const [path] = exactPositionals(
    parsed,
    1,
    "transmute ai provider-options inspect <json-file> [--json]",
  );
  return {
    json: optionFlag(parsed, "--json"),
    kind: "ai-provider-options-inspect",
    path: path!,
  };
}

function parseAiImage(argv: readonly string[]): CliCommand {
  if (argv[0] !== "generate") fail("Usage: transmute ai image generate --model <id> [options]");
  const parsed = parseOptions(argv.slice(1), {
    ...JSON_SPEC,
    "--allow-cloud-upload": "flag",
    "--aspect-ratio": "value",
    "--count": "value",
    "--image": "repeat",
    "--mask": "value",
    "--max-per-call": "value",
    "--max-output-tokens": "value",
    "--model": "value",
    "--prompt": "value",
    "--prompt-file": "value",
    "--provider-options": "value",
    "--seed": "value",
    "--size": "value",
    "--stop": "repeat",
    "--temperature": "value",
    "--timeout": "value",
  });
  exactPositionals(parsed, 0, "transmute ai image generate --model <id> [options]");
  const prompt = oneTextSource(parsed, "--prompt", "--prompt-file", { required: false });
  const images = optionStrings(parsed, "--image");
  if (images.length > 16) fail("--image may be specified at most 16 times.");
  if (prompt.inline === undefined && prompt.path === undefined && images.length === 0) {
    fail("Image generation requires a prompt or at least one --image reference.");
  }
  const model = optionString(parsed, "--model");
  if (model === undefined) fail("--model is required.");
  const count = strictInteger(optionString(parsed, "--count"), "--count", 1);
  if (count > 16) fail("--count must be at most 16.");
  const maxPerCall = optionalStrictInteger(optionString(parsed, "--max-per-call"), "--max-per-call");
  if (maxPerCall !== undefined && maxPerCall > 16) fail("--max-per-call must be at most 16.");
  if (maxPerCall !== undefined && maxPerCall < count) {
    fail("--max-per-call must be at least --count; one CLI job maps to one paid Gateway call.");
  }
  return {
    allowCloudUpload: optionFlag(parsed, "--allow-cloud-upload"),
    aspectRatio: optionString(parsed, "--aspect-ratio"),
    count,
    images,
    json: optionFlag(parsed, "--json"),
    kind: "ai-image-generate",
    mask: optionString(parsed, "--mask"),
    maxPerCall,
    maxOutputTokens: optionalStrictInteger(optionString(parsed, "--max-output-tokens"), "--max-output-tokens"),
    model,
    prompt: prompt.inline,
    promptFile: prompt.path,
    providerOptions: optionString(parsed, "--provider-options"),
    seed: optionalNonNegativeInteger(optionString(parsed, "--seed"), "--seed"),
    size: optionString(parsed, "--size"),
    stopSequences: optionStrings(parsed, "--stop"),
    temperature: optionalBoundedNumber(optionString(parsed, "--temperature"), "--temperature", 0, 100),
    timeout: optionString(parsed, "--timeout") ?? "10m",
  };
}

function parseAiVideo(argv: readonly string[]): CliCommand {
  if (argv[0] !== "generate") fail("Usage: transmute ai video generate --model <id> [options]");
  const parsed = parseOptions(argv.slice(1), {
    ...JSON_SPEC,
    "--allow-cloud-upload": "flag",
    "--aspect-ratio": "value",
    "--count": "value",
    "--duration": "value",
    "--fps": "value",
    "--frame": "repeat",
    "--generate-audio": "value",
    "--image": "value",
    "--max-per-call": "value",
    "--model": "value",
    "--prompt": "value",
    "--prompt-file": "value",
    "--provider-options": "value",
    "--reference": "repeat",
    "--resolution": "value",
    "--seed": "value",
    "--timeout": "value",
  });
  exactPositionals(parsed, 0, "transmute ai video generate --model <id> [options]");
  const prompt = oneTextSource(parsed, "--prompt", "--prompt-file", { required: false });
  const image = optionString(parsed, "--image");
  const frameImages = parseGatewayFrameInputs(optionStrings(parsed, "--frame"));
  const inputReferences = optionStrings(parsed, "--reference");
  if (inputReferences.length > 32) {
    fail("--reference may be specified at most 32 times.");
  }
  if (frameImages.length > 0 && inputReferences.length > 0) {
    fail("--frame and --reference are mutually exclusive because frame images take precedence in AI SDK video requests.");
  }
  if (
    image !== undefined
    && frameImages.some(frame => frame.frameType === "first")
  ) {
    fail("--image and --frame first are mutually exclusive because the first frame takes precedence.");
  }
  if (
    frameImages.some(frame => frame.frameType === "last")
    && image === undefined
    && !frameImages.some(frame => frame.frameType === "first")
  ) {
    fail("--frame last requires --image or --frame first.");
  }
  if (
    prompt.inline === undefined
    && prompt.path === undefined
    && image === undefined
    && frameImages.length === 0
    && inputReferences.length === 0
  ) {
    fail("Video generation requires a prompt, --image, --frame, or --reference.");
  }
  const model = optionString(parsed, "--model");
  if (model === undefined) fail("--model is required.");
  const count = strictInteger(optionString(parsed, "--count"), "--count", 1);
  if (count > 8) fail("--count must be at most 8.");
  const maxPerCall = optionalStrictInteger(optionString(parsed, "--max-per-call"), "--max-per-call");
  if (maxPerCall !== undefined && maxPerCall > 8) fail("--max-per-call must be at most 8.");
  if (maxPerCall !== undefined && maxPerCall < count) {
    fail("--max-per-call must be at least --count; one CLI job maps to one paid Gateway call.");
  }
  return {
    allowCloudUpload: optionFlag(parsed, "--allow-cloud-upload"),
    aspectRatio: optionString(parsed, "--aspect-ratio"),
    count,
    durationSeconds: optionalBoundedNumber(optionString(parsed, "--duration"), "--duration", 0.1, 3_600),
    fps: optionalStrictInteger(optionString(parsed, "--fps"), "--fps"),
    frameImages,
    generateAudio: optionString(parsed, "--generate-audio") === undefined
      ? undefined
      : strictBoolean(optionString(parsed, "--generate-audio"), "--generate-audio", false),
    image,
    inputReferences,
    json: optionFlag(parsed, "--json"),
    kind: "ai-video-generate",
    maxPerCall,
    model,
    prompt: prompt.inline,
    promptFile: prompt.path,
    providerOptions: optionString(parsed, "--provider-options"),
    resolution: optionString(parsed, "--resolution"),
    seed: optionalNonNegativeInteger(optionString(parsed, "--seed"), "--seed"),
    timeout: optionString(parsed, "--timeout") ?? "30m",
  };
}

function parseAiSpeech(argv: readonly string[]): CliCommand {
  if (argv[0] !== "generate") fail("Usage: transmute ai speech generate --model <id> [options]");
  const parsed = parseOptions(argv.slice(1), {
    ...JSON_SPEC,
    "--format": "value",
    "--instructions": "value",
    "--instructions-file": "value",
    "--language": "value",
    "--model": "value",
    "--provider-options": "value",
    "--speed": "value",
    "--text": "value",
    "--text-file": "value",
    "--timeout": "value",
    "--voice": "value",
  });
  exactPositionals(parsed, 0, "transmute ai speech generate --model <id> [options]");
  const text = oneTextSource(parsed, "--text", "--text-file", { required: true });
  const instructions = oneTextSource(parsed, "--instructions", "--instructions-file", { required: false });
  const model = optionString(parsed, "--model");
  if (model === undefined) fail("--model is required.");
  return {
    instructions: instructions.inline,
    instructionsFile: instructions.path,
    json: optionFlag(parsed, "--json"),
    kind: "ai-speech-generate",
    language: optionString(parsed, "--language"),
    model,
    outputFormat: optionString(parsed, "--format"),
    providerOptions: optionString(parsed, "--provider-options"),
    speed: optionalBoundedNumber(optionString(parsed, "--speed"), "--speed", 0.25, 4),
    text: text.inline,
    textFile: text.path,
    timeout: optionString(parsed, "--timeout") ?? "5m",
    voice: optionString(parsed, "--voice"),
  };
}

function parseAiTranscribe(argv: readonly string[]): CliCommand {
  const parsed = parseOptions(argv, {
    ...JSON_SPEC,
    "--allow-cloud-audio-upload": "flag",
    "--format": "value",
    "--model": "value",
    "--provider-options": "value",
    "--timeout": "value",
  });
  const [input] = exactPositionals(
    parsed,
    1,
    "transmute ai transcribe <audio-path> --model <id> --allow-cloud-audio-upload [options]",
  );
  const model = optionString(parsed, "--model");
  if (model === undefined) fail("--model is required.");
  return {
    allowCloudAudioUpload: optionFlag(parsed, "--allow-cloud-audio-upload"),
    format: oneOf(optionString(parsed, "--format"), "--format", [
      "all", "json", "srt", "text", "vtt",
    ] as const, "all"),
    input: input!,
    json: optionFlag(parsed, "--json"),
    kind: "ai-transcribe",
    model,
    providerOptions: optionString(parsed, "--provider-options"),
    timeout: optionString(parsed, "--timeout") ?? "30m",
  };
}

function parseAi(argv: readonly string[]): CliCommand {
  switch (argv[0]) {
    case "models": return parseAiModels(argv.slice(1));
    case "provider-options": return parseAiProviderOptions(argv.slice(1));
    case "image": return parseAiImage(argv.slice(1));
    case "video": return parseAiVideo(argv.slice(1));
    case "speech": return parseAiSpeech(argv.slice(1));
    case "transcribe": return parseAiTranscribe(argv.slice(1));
    case undefined:
    default: fail("Usage: transmute ai <models|provider-options|image|video|speech|transcribe> [options]");
  }
}

function parseMediaAudio(argv: readonly string[]): CliCommand {
  const parsed = parseOptions(argv, {
    ...JSON_SPEC,
    "--audio-stream": "value",
    "--compressor": "flag",
    "--compressor-attack-ms": "value",
    "--compressor-makeup-db": "value",
    "--compressor-ratio": "value",
    "--compressor-release-ms": "value",
    "--compressor-threshold-db": "value",
    "--delay-feedback": "value",
    "--delay-mix": "value",
    "--delay-ms": "value",
    "--denoise": "flag",
    "--denoise-reduction-db": "value",
    "--output": "value",
    "--reverb": "value",
    "--reverb-wet": "value",
    "--volume-db": "value",
  });
  const [input] = exactPositionals(parsed, 1, "transmute media audio <media-path> [effects] [--output <path>] [--json]");
  const compressorConfigured = [
    "--compressor-attack-ms",
    "--compressor-makeup-db",
    "--compressor-ratio",
    "--compressor-release-ms",
    "--compressor-threshold-db",
  ].some(name => optionString(parsed, name) !== undefined);
  const denoiseConfigured = optionString(parsed, "--denoise-reduction-db") !== undefined;
  const volumeDb = optionalBoundedNumber(optionString(parsed, "--volume-db"), "--volume-db", -60, 24);
  const delayMs = optionalBoundedNumber(optionString(parsed, "--delay-ms"), "--delay-ms", 1, 10_000);
  if (delayMs !== undefined && !Number.isSafeInteger(delayMs)) {
    fail("--delay-ms must be a whole number of milliseconds.");
  }
  if (
    delayMs === undefined
    && (
      optionString(parsed, "--delay-feedback") !== undefined
      || optionString(parsed, "--delay-mix") !== undefined
    )
  ) {
    fail("--delay-mix and --delay-feedback require --delay-ms.");
  }
  const reverb = optionString(parsed, "--reverb") === undefined
    ? undefined
    : oneOf(optionString(parsed, "--reverb"), "--reverb", ["room", "hall", "plate"] as const);
  if (
    reverb === undefined
    && optionString(parsed, "--reverb-wet") !== undefined
  ) {
    fail("--reverb-wet requires --reverb.");
  }
  if (
    volumeDb === undefined
    && !optionFlag(parsed, "--compressor")
    && !compressorConfigured
    && delayMs === undefined
    && reverb === undefined
    && !optionFlag(parsed, "--denoise")
    && !denoiseConfigured
  ) {
    fail("At least one audio effect is required.");
  }
  const audioStreamIndex = optionalNonNegativeInteger(
    optionString(parsed, "--audio-stream"),
    "--audio-stream",
  ) ?? 0;
  if (audioStreamIndex > 255) fail("--audio-stream must be at most 255.");
  return {
    audioStreamIndex,
    compressor: optionFlag(parsed, "--compressor") || compressorConfigured,
    compressorAttackMs: boundedNumber(optionString(parsed, "--compressor-attack-ms"), "--compressor-attack-ms", 0.1, 2_000, 20),
    compressorMakeupDb: boundedNumber(optionString(parsed, "--compressor-makeup-db"), "--compressor-makeup-db", 0, 36, 0),
    compressorRatio: boundedNumber(optionString(parsed, "--compressor-ratio"), "--compressor-ratio", 1, 20, 4),
    compressorReleaseMs: boundedNumber(optionString(parsed, "--compressor-release-ms"), "--compressor-release-ms", 1, 9_000, 250),
    compressorThresholdDb: boundedNumber(optionString(parsed, "--compressor-threshold-db"), "--compressor-threshold-db", -60, 0, -18),
    delayFeedback: boundedNumber(optionString(parsed, "--delay-feedback"), "--delay-feedback", 0, 0.95, 0.35),
    delayMix: boundedNumber(optionString(parsed, "--delay-mix"), "--delay-mix", 0, 1, 0.25),
    delayMs,
    denoise: optionFlag(parsed, "--denoise") || denoiseConfigured,
    denoiseReductionDb: boundedNumber(optionString(parsed, "--denoise-reduction-db"), "--denoise-reduction-db", 0.01, 97, 12),
    input: input!,
    json: optionFlag(parsed, "--json"),
    kind: "media-audio",
    output: optionString(parsed, "--output"),
    reverb,
    reverbWet: boundedNumber(optionString(parsed, "--reverb-wet"), "--reverb-wet", 0, 1, 0.3),
    volumeDb,
  };
}

function parseMediaColor(argv: readonly string[]): CliCommand {
  const parsed = parseOptions(argv, {
    ...JSON_SPEC,
    "--brightness": "value",
    "--contrast": "value",
    "--gamma": "value",
    "--hue-degrees": "value",
    "--output": "value",
    "--preset": "value",
    "--saturation": "value",
    "--temperature": "value",
    "--tint": "value",
    "--video-stream": "value",
  });
  const [input] = exactPositionals(parsed, 1, "transmute media color <video-path> [grade] [--output <path>] [--json]");
  const preset = optionString(parsed, "--preset") === undefined
    ? undefined
    : oneOf(optionString(parsed, "--preset"), "--preset", [
        "clean", "cool", "cinematic", "flat", "mono", "vivid", "warm",
      ] as const);
  const explicitlyConfigured = [
    "--brightness", "--contrast", "--gamma", "--hue-degrees", "--saturation", "--temperature", "--tint",
  ].some(name => optionString(parsed, name) !== undefined);
  if (preset === undefined && !explicitlyConfigured) fail("A color preset or at least one grade control is required.");
  const videoStreamIndex = optionalNonNegativeInteger(
    optionString(parsed, "--video-stream"),
    "--video-stream",
  ) ?? 0;
  if (videoStreamIndex > 255) fail("--video-stream must be at most 255.");
  return {
    brightness: optionalBoundedNumber(optionString(parsed, "--brightness"), "--brightness", -0.5, 0.5),
    contrast: optionalBoundedNumber(optionString(parsed, "--contrast"), "--contrast", 0, 2),
    gamma: optionalBoundedNumber(optionString(parsed, "--gamma"), "--gamma", 0.1, 3),
    hueDegrees: optionalBoundedNumber(optionString(parsed, "--hue-degrees"), "--hue-degrees", -180, 180),
    input: input!,
    json: optionFlag(parsed, "--json"),
    kind: "media-color",
    output: optionString(parsed, "--output"),
    preset,
    saturation: optionalBoundedNumber(optionString(parsed, "--saturation"), "--saturation", 0, 3),
    temperature: optionalBoundedNumber(optionString(parsed, "--temperature"), "--temperature", -1, 1),
    tint: optionalBoundedNumber(optionString(parsed, "--tint"), "--tint", -1, 1),
    videoStreamIndex,
  };
}

function parseMediaCompose(argv: readonly string[]): CliCommand {
  const parsed = parseOptions(argv, {
    ...JSON_SPEC,
    "--output": "value",
  });
  const [composition] = exactPositionals(
    parsed,
    1,
    "transmute media compose <composition.json> [--output <path>] [--json]",
  );
  return {
    composition: composition!,
    json: optionFlag(parsed, "--json"),
    kind: "media-compose",
    output: optionString(parsed, "--output"),
  };
}

function parseMedia(argv: readonly string[]): CliCommand {
  switch (argv[0]) {
    case "audio": return parseMediaAudio(argv.slice(1));
    case "color": return parseMediaColor(argv.slice(1));
    case "compose": return parseMediaCompose(argv.slice(1));
    case undefined:
    default: fail("Usage: transmute media <audio|color|compose> ...");
  }
}

function parseRecordings(argv: readonly string[]): CliCommand {
  if (argv[0] !== "list") fail("Usage: transmute recordings list [--json] [--limit n]");
  const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--limit": "value" });
  exactPositionals(parsed, 0, "transmute recordings list [--json] [--limit n]");
  return {
    json: optionFlag(parsed, "--json"),
    kind: "recordings-list",
    limit: strictInteger(optionString(parsed, "--limit"), "--limit", 50),
  };
}

function parseProjects(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "list") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--limit": "value" });
    exactPositionals(parsed, 0, "transmute projects list [--json] [--limit n]");
    return {
      json: optionFlag(parsed, "--json"),
      kind: "projects-list",
      limit: strictInteger(optionString(parsed, "--limit"), "--limit", 50),
    };
  }
  if (action === "create") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--from-recording": "value",
      "--name": "value",
    });
    exactPositionals(parsed, 0, "transmute projects create --from-recording <recording> [--name <name>] [--json]");
    const recording = optionString(parsed, "--from-recording");
    if (recording === undefined) fail("projects create requires --from-recording.");
    return {
      json: optionFlag(parsed, "--json"),
      kind: "projects-create",
      name: optionString(parsed, "--name"),
      recording,
    };
  }
  fail("Usage: transmute projects <list|create> ...");
}

function cameraFrame(value: string | undefined, name: string): CameraFrame {
  const values = tupleNumbers(value, name, 3);
  if (values === undefined) fail(`${name} is required.`);
  return [values[0]!, values[1]!, values[2]!] as const;
}

function cameraCenter(value: string | undefined): readonly [number, number] {
  const values = tupleNumbers(value, "--center", 2);
  if (values === undefined) fail("--center is required.");
  return [values[0]!, values[1]!] as const;
}

function cameraPathKeyframe(value: string): CameraPathKeyframe {
  const fields = value.split(",").map(field => field.trim());
  if (fields.length !== 4 || fields.some(field => field.length === 0)) {
    fail("--keyframe must be <time,center-x,center-y,zoom>.");
  }
  return {
    at: fields[0]!,
    frame: [
      strictNumber(fields[1], "--keyframe center-x"),
      strictNumber(fields[2], "--keyframe center-y"),
      strictNumber(fields[3], "--keyframe zoom"),
    ],
  };
}

function parseProjectCamera(project: string, argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "show") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    exactPositionals(parsed, 0, "transmute project edit <project> camera show [--json]");
    return { action, json: optionFlag(parsed, "--json"), kind: "project-camera-edit", project };
  }
  if (action === "remove") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--id": "value" });
    if (parsed.positionals.length > 1) {
      fail("Usage: transmute project edit <project> camera remove <camera-move-id> [--json]");
    }
    const cameraMoveId = parsed.positionals[0] ?? optionString(parsed, "--id");
    if (cameraMoveId === undefined) fail("camera remove requires a camera-move ID.");
    return {
      action,
      cameraMoveId,
      json: optionFlag(parsed, "--json"),
      kind: "project-camera-edit",
      project,
    };
  }
  if (action === "push") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      ...TIME_RANGE_SPEC,
      "--center": "value",
      "--easing": "value",
      "--end-zoom": "value",
      "--placement": "value",
      "--start-zoom": "value",
      "--stream": "value",
    });
    const [from, to] = timeRange(
      parsed,
      "transmute project edit <project> camera push --placement <id> --stream <id> --from <time> --to <time> --center <x,y> --end-zoom <z>",
    );
    const placement = optionString(parsed, "--placement");
    const stream = optionString(parsed, "--stream");
    if (placement === undefined || stream === undefined) {
      fail("camera push requires --placement and --stream.");
    }
    return {
      action,
      center: cameraCenter(optionString(parsed, "--center")),
      easing: optionString(parsed, "--easing") ?? "ease-in-out",
      endZoom: strictNumber(optionString(parsed, "--end-zoom"), "--end-zoom"),
      from,
      json: optionFlag(parsed, "--json"),
      kind: "project-camera-edit",
      placement,
      project,
      startZoom: strictNumber(optionString(parsed, "--start-zoom"), "--start-zoom", 1),
      stream,
      to,
    };
  }
  if (action === "reframe") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      ...TIME_RANGE_SPEC,
      "--easing": "value",
      "--from-frame": "value",
      "--placement": "value",
      "--stream": "value",
      "--to-frame": "value",
    });
    const [from, to] = timeRange(
      parsed,
      "transmute project edit <project> camera reframe --placement <id> --stream <id> --from <time> --to <time> --from-frame <x,y,z> --to-frame <x,y,z>",
    );
    const placement = optionString(parsed, "--placement");
    const stream = optionString(parsed, "--stream");
    if (placement === undefined || stream === undefined) {
      fail("camera reframe requires --placement and --stream.");
    }
    return {
      action,
      easing: optionString(parsed, "--easing") ?? "ease-in-out",
      from,
      fromFrame: cameraFrame(optionString(parsed, "--from-frame"), "--from-frame"),
      json: optionFlag(parsed, "--json"),
      kind: "project-camera-edit",
      placement,
      project,
      stream,
      to,
      toFrame: cameraFrame(optionString(parsed, "--to-frame"), "--to-frame"),
    };
  }
  if (action === "path") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--easing": "value",
      "--keyframe": "repeat",
      "--placement": "value",
      "--stream": "value",
    });
    exactPositionals(
      parsed,
      0,
      "transmute project edit <project> camera path --placement <id> --stream <id> --keyframe <time,x,y,zoom> --keyframe <time,x,y,zoom> ...",
    );
    const placement = optionString(parsed, "--placement");
    const stream = optionString(parsed, "--stream");
    if (placement === undefined || stream === undefined) {
      fail("camera path requires --placement and --stream.");
    }
    const values = optionStrings(parsed, "--keyframe");
    if (values.length < 2 || values.length > 4_096) {
      fail("camera path requires between 2 and 4096 --keyframe values.");
    }
    return {
      action,
      easing: optionString(parsed, "--easing") ?? "ease-in-out",
      json: optionFlag(parsed, "--json"),
      keyframes: values.map(cameraPathKeyframe),
      kind: "project-camera-edit",
      placement,
      project,
      stream,
    };
  }
  if (action === "follow-faces") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      ...TIME_RANGE_SPEC,
      "--analysis": "value",
      "--easing": "value",
      "--framing": "value",
      "--gap-policy": "value",
      "--headroom": "value",
      "--max-zoom": "value",
      "--min-zoom": "value",
      "--output-height": "value",
      "--output-width": "value",
      "--placement": "value",
      "--require-all-selected": "flag",
      "--select": "value",
      "--smoothing": "value",
      "--track": "repeat",
    });
    const [from, to] = timeRange(
      parsed,
      "transmute project edit <project> camera follow-faces --placement <id> --analysis <id> --from <time> --to <time> (--track <id> ... | --select <largest|all>) [--require-all-selected]",
    );
    const placement = optionString(parsed, "--placement");
    const analysis = optionString(parsed, "--analysis");
    if (placement === undefined || analysis === undefined) {
      fail("camera follow-faces requires --placement and --analysis.");
    }
    const tracks = optionStrings(parsed, "--track");
    const selectValue = optionString(parsed, "--select");
    const select = selectValue === undefined
      ? undefined
      : oneOf(selectValue, "--select", ["all", "largest"] as const);
    if ((tracks.length === 0) === (select === undefined)) {
      fail("camera follow-faces requires either one or more --track values or one --select mode.");
    }
    const requireAllSelected = optionFlag(parsed, "--require-all-selected");
    if (select === "largest" && requireAllSelected) {
      fail("--require-all-selected cannot be combined with dynamic --select largest.");
    }
    const minZoom = strictNumber(optionString(parsed, "--min-zoom"), "--min-zoom", 1);
    const maxZoom = strictNumber(optionString(parsed, "--max-zoom"), "--max-zoom", 2.2);
    if (minZoom < 1 || maxZoom < minZoom || maxZoom > 10) {
      fail("Face-follow zooms must satisfy 1 <= --min-zoom <= --max-zoom <= 10.");
    }
    const smoothing = strictNumber(optionString(parsed, "--smoothing"), "--smoothing", 0.75);
    const headroom = strictNumber(optionString(parsed, "--headroom"), "--headroom", 0.18);
    if (smoothing < 0 || smoothing > 60) fail("--smoothing must be between zero and 60 seconds.");
    if (headroom < 0 || headroom > 1) fail("--headroom must be between zero and one.");
    return {
      action,
      analysis,
      easing: optionString(parsed, "--easing") ?? "ease-in-out",
      framing: oneOf(
        optionString(parsed, "--framing"),
        "--framing",
        ["tight", "medium", "wide", "group"] as const,
        "medium",
      ),
      from,
      gapPolicy: oneOf(
        optionString(parsed, "--gap-policy"),
        "--gap-policy",
        ["hold", "fallback", "fail"] as const,
        "hold",
      ),
      headroom,
      json: optionFlag(parsed, "--json"),
      kind: "project-camera-edit",
      maxZoom,
      minZoom,
      outputHeight: strictEvenPositiveInteger(
        optionString(parsed, "--output-height"),
        "--output-height",
        1_080,
      ),
      outputWidth: strictEvenPositiveInteger(
        optionString(parsed, "--output-width"),
        "--output-width",
        1_920,
      ),
      placement,
      project,
      requireAllSelected,
      select,
      smoothing,
      to,
      tracks,
    };
  }
  fail("Usage: transmute project edit <project> camera <push|reframe|path|follow-faces|show|remove> ...");
}

function parseProject(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "inspect") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    const [project] = exactPositionals(parsed, 1, "transmute project inspect <project> [--json]");
    return { json: optionFlag(parsed, "--json"), kind: "project-inspect", project: project! };
  }
  if (action === "add") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--at": "value",
      "--role": "value",
    });
    const [project, path] = exactPositionals(
      parsed,
      2,
      "transmute project add <project> <path> --role <role> [--at <project-time>] [--json]",
    );
    return {
      at: optionString(parsed, "--at") ?? "0s",
      json: optionFlag(parsed, "--json"),
      kind: "project-add",
      path: path!,
      project: project!,
      role: oneOf(optionString(parsed, "--role"), "--role", [
        "screen", "camera", "b-roll", "system-audio", "microphone", "portable-audio", "music", "dialogue", "other",
      ] as const),
    };
  }
  if (action === "edit") {
    const project = argv[1];
    const operation = argv[2];
    if (project !== undefined && operation === "camera") {
      return parseProjectCamera(project, argv.slice(3));
    }
    if (project !== undefined && operation === "overlay") {
      const cleanArgs: string[] = [];
      let json = false;
      let fps: number | undefined;
      const operationArgs = argv.slice(3);
      for (let index = 0; index < operationArgs.length; index += 1) {
        const argument = operationArgs[index]!;
        if (argument === "--json") {
          if (json) fail("Option may be specified only once: --json");
          json = true;
          continue;
        }
        if (argument === "--fps" || argument.startsWith("--fps=")) {
          if (fps !== undefined) fail("Option may be specified only once: --fps");
          const value = argument === "--fps" ? operationArgs[index + 1] : argument.slice("--fps=".length);
          if (value === undefined || value.startsWith("--")) fail("Option requires a value: --fps");
          if (argument === "--fps") index += 1;
          fps = strictNumber(value, "--fps");
          continue;
        }
        cleanArgs.push(argument);
      }
      const edit = parseOverlay(cleanArgs);
      if (edit.operation !== "overlay-add" && edit.operation !== "overlay-remove") {
        fail("Project overlay edit did not produce an overlay operation.");
      }
      return { edit, fps, json, kind: "project-overlay-edit", project };
    }
    if (
      project !== undefined
      && (operation === "zoom"
        || operation === "cursor"
        || operation === "clicks"
        || operation === "keystrokes"
        || operation === "typed-text")
    ) {
      const operationArgs = argv.slice(3);
      const cleanArgs: string[] = [];
      let sourcePlacement: string | undefined;
      for (let index = 0; index < operationArgs.length; index += 1) {
        const argument = operationArgs[index]!;
        if (argument === "--source-placement" || argument.startsWith("--source-placement=")) {
          if (sourcePlacement !== undefined) fail("Option may be specified only once: --source-placement");
          const value = argument === "--source-placement"
            ? operationArgs[index + 1]
            : argument.slice("--source-placement=".length);
          if (value === undefined || value === "" || value.startsWith("--")) {
            fail("Option requires a value: --source-placement");
          }
          if (argument === "--source-placement") index += 1;
          sourcePlacement = value;
          continue;
        }
        cleanArgs.push(argument);
      }
      const parsedEdit = parseEdit([project, operation, ...cleanArgs]);
      if (parsedEdit.kind !== "edit" || (
        parsedEdit.edit.operation !== "zoom-add"
        && parsedEdit.edit.operation !== "zoom-remove"
        && parsedEdit.edit.operation !== "cursor"
        && parsedEdit.edit.operation !== "clicks"
        && parsedEdit.edit.operation !== "keystrokes"
        && parsedEdit.edit.operation !== "typed-text"
      )) {
        fail("Project metadata edit did not produce a supported operation.");
      }
      return {
        edit: parsedEdit.edit,
        fps: parsedEdit.fps,
        json: parsedEdit.json,
        kind: "project-metadata-edit",
        project,
        sourcePlacement,
      };
    }
    if (project === undefined || (operation !== "cut" && operation !== "trim" && operation !== "speed")) {
      fail("Usage: transmute project edit <project> <cut|trim|speed|camera|zoom|overlay|cursor|clicks|keystrokes|typed-text> ...");
    }
    const parsed = parseOptions(argv.slice(3), JSON_SPEC);
    if (operation === "speed") {
      const [from, to, rate] = exactPositionals(
        parsed,
        3,
        "transmute project edit <project> speed <from> <to> <rate> [--json]",
      );
      return {
        from: from!,
        json: optionFlag(parsed, "--json"),
        kind: "project-edit",
        operation,
        project,
        rate: strictNumber(rate, "rate"),
        to: to!,
      };
    }
    const [from, to] = exactPositionals(
      parsed,
      2,
      `transmute project edit <project> ${operation} <from> <to> [--json]`,
    );
    return {
      from: from!,
      json: optionFlag(parsed, "--json"),
      kind: "project-edit",
      operation,
      project,
      to: to!,
    };
  }
  if (action === "render") {
    const renderAction = argv[1];
    if (renderAction !== "plan" && renderAction !== "run") {
      fail("Usage: transmute project render <plan|run> <project> [options]");
    }
    const parsed = parseOptions(argv.slice(2), {
      ...JSON_SPEC,
      "--allow-unverified-sync": "flag",
      "--dry-run": "flag",
      "--fps": "value",
      "--height": "value",
      "--output": "value",
      "--width": "value",
    });
    const [project] = exactPositionals(parsed, 1, `transmute project render ${renderAction} <project> [options]`);
    if (renderAction === "plan" && optionFlag(parsed, "--dry-run")) fail("--dry-run is valid only for project render run.");
    return {
      action: renderAction,
      allowUnverifiedSync: optionFlag(parsed, "--allow-unverified-sync"),
      dryRun: optionFlag(parsed, "--dry-run"),
      fps: strictNumber(optionString(parsed, "--fps"), "--fps", 60),
      height: strictEvenPositiveInteger(optionString(parsed, "--height"), "--height", 1_080),
      json: optionFlag(parsed, "--json"),
      kind: "project-render",
      output: optionString(parsed, "--output"),
      project: project!,
      width: strictEvenPositiveInteger(optionString(parsed, "--width"), "--width", 1_920),
    };
  }
  fail("Usage: transmute project <inspect|add|edit|render> ...");
}

function parseInspect(argv: readonly string[]): CliCommand {
  const parsed = parseOptions(argv, { ...JSON_SPEC, "--fields": "value" });
  const [recording] = exactPositionals(parsed, 1, "transmute inspect <recording> [--json] [--fields csv]");
  const fieldsValue = optionString(parsed, "--fields");
  const fields = fieldsValue === undefined
    ? undefined
    : fieldsValue.split(",").map((field) => field.trim()).filter((field) => field !== "");
  if (fields !== undefined && fields.length === 0) fail("--fields must name at least one field.");
  return { fields, json: optionFlag(parsed, "--json"), kind: "inspect", recording: recording! };
}

function parseEvents(argv: readonly string[]): CliCommand {
  const parsed = parseOptions(argv, {
    "--around": "value",
    "--from": "value",
    "--fps": "value",
    "--json": "flag",
    "--jsonl": "flag",
    "--kind": "repeat",
    "--limit": "value",
    "--to": "value",
  });
  const [recording] = exactPositionals(
    parsed,
    1,
    "transmute events <recording> --kind <kind> [--from time] [--to time] [--around time] [--limit n] [--json|--jsonl]",
  );
  const eventKinds = optionStrings(parsed, "--kind").flatMap((value) => value.split(","))
    .map((value) => value.trim()).filter((value) => value !== "");
  if (eventKinds.length === 0) fail("events requires at least one --kind.");
  const json = optionFlag(parsed, "--json");
  const jsonl = optionFlag(parsed, "--jsonl");
  if (json && jsonl) fail("--json and --jsonl are mutually exclusive.");
  const limit = strictInteger(optionString(parsed, "--limit"), "--limit", 100);
  if (limit > MAX_EVENT_QUERY_LIMIT) {
    fail(`--limit cannot exceed ${MAX_EVENT_QUERY_LIMIT}.`);
  }
  return {
    around: optionString(parsed, "--around"),
    eventKinds,
    fps: optionString(parsed, "--fps") === undefined
      ? undefined
      : strictNumber(optionString(parsed, "--fps"), "--fps"),
    format: json ? "json" : jsonl ? "jsonl" : "human",
    from: optionString(parsed, "--from"),
    kind: "events",
    limit,
    recording: recording!,
    to: optionString(parsed, "--to"),
  };
}

function parseRecord(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "start") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--camera-device": "value",
      "--display": "repeat",
      "--microphone": "value",
      "--microphone-device": "value",
      "--strict-inputs": "flag",
      "--system-audio": "value",
      "--typed-text": "value",
      "--webcam": "value",
    });
    exactPositionals(parsed, 0, "transmute record start [options]");
    const displays = optionStrings(parsed, "--display").map((displayId) =>
      captureSourceId(displayId, "--display", 64)!
    );
    if (displays.length > 16) fail("--display may be specified at most 16 times.");
    if (new Set(displays).size !== displays.length) fail("--display IDs must be unique.");
    const microphone = strictBoolean(optionString(parsed, "--microphone"), "--microphone", true);
    const webcam = strictBoolean(optionString(parsed, "--webcam"), "--webcam", true);
    const cameraDeviceId = captureSourceId(optionString(parsed, "--camera-device"), "--camera-device", 256);
    const microphoneDeviceId = captureSourceId(
      optionString(parsed, "--microphone-device"),
      "--microphone-device",
      256,
    );
    if (!webcam && cameraDeviceId !== undefined) {
      fail("--camera-device cannot be combined with --webcam false.");
    }
    if (!microphone && microphoneDeviceId !== undefined) {
      fail("--microphone-device cannot be combined with --microphone false.");
    }
    return {
      action,
      cameraDeviceId,
      displays,
      json: optionFlag(parsed, "--json"),
      kind: "record",
      microphone,
      microphoneDeviceId,
      strictInputs: optionFlag(parsed, "--strict-inputs"),
      systemAudio: strictBoolean(optionString(parsed, "--system-audio"), "--system-audio", true),
      typedText: strictBoolean(optionString(parsed, "--typed-text"), "--typed-text", false),
      webcam,
    };
  }
  if (action === "pause" || action === "resume" || action === "stop" || action === "status") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    exactPositionals(parsed, 0, `transmute record ${action} [--json]`);
    return { action, json: optionFlag(parsed, "--json"), kind: "record" };
  }
  fail("Usage: transmute record <start|pause|resume|stop|status> [options]");
}

const TIME_RANGE_SPEC = {
  "--end": "value",
  "--from": "value",
  "--start": "value",
  "--to": "value",
} as const;

function timeRange(parsed: ParsedOptions, positionalUsage: string): readonly [string, string] {
  const flaggedFrom = optionString(parsed, "--from") ?? optionString(parsed, "--start");
  const flaggedTo = optionString(parsed, "--to") ?? optionString(parsed, "--end");
  if (optionString(parsed, "--from") !== undefined && optionString(parsed, "--start") !== undefined) {
    fail("Use only one of --from and --start.");
  }
  if (optionString(parsed, "--to") !== undefined && optionString(parsed, "--end") !== undefined) {
    fail("Use only one of --to and --end.");
  }
  if (flaggedFrom !== undefined || flaggedTo !== undefined) {
    if (parsed.positionals.length !== 0 || flaggedFrom === undefined || flaggedTo === undefined) {
      fail(`Usage: ${positionalUsage}`);
    }
    return [flaggedFrom, flaggedTo];
  }
  const [from, to] = exactPositionals(parsed, 2, positionalUsage);
  return [from!, to!];
}

function tupleNumbers(value: string | undefined, name: string, size: number): readonly number[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",").map((part) => strictNumber(part.trim(), name));
  if (parts.length !== size) fail(`${name} requires ${size} comma-separated numbers.`);
  return parts;
}

function parseZoom(argv: readonly string[]): EditCommand {
  const verb = argv[0] === "add" || argv[0] === "remove" ? argv[0] : "add";
  const remaining = verb === "add" && argv[0] !== "add" ? argv : argv.slice(1);
  if (verb === "remove") {
    const parsed = parseOptions(remaining, { "--id": "value" });
    const positionalId = parsed.positionals[0];
    if (parsed.positionals.length > 1) fail("Usage: transmute edit <recording> zoom remove <id>");
    const id = positionalId ?? optionString(parsed, "--id");
    if (id === undefined) fail("zoom remove requires an ID.");
    return { id, operation: "zoom-remove" };
  }
  const parsed = parseOptions(remaining, {
    ...TIME_RANGE_SPEC,
    "--display": "value",
    "--easing": "value",
    "--enter-duration": "value",
    "--exit-duration": "value",
    "--point": "value",
    "--rect": "value",
    "--scale": "value",
    "--target": "value",
    "--window": "value",
  });
  const [from, to] = timeRange(parsed, "transmute edit <recording> zoom [add] --from <time> --to <time> --target <target>");
  const target = oneOf(optionString(parsed, "--target"), "--target", [
    "rect", "point", "cursor", "window", "focused-input",
  ] as const);
  const rectValues = tupleNumbers(optionString(parsed, "--rect"), "--rect", 4);
  const pointValues = tupleNumbers(optionString(parsed, "--point"), "--point", 2);
  const rect = rectValues === undefined
    ? undefined
    : [rectValues[0]!, rectValues[1]!, rectValues[2]!, rectValues[3]!] as const;
  const point = pointValues === undefined ? undefined : [pointValues[0]!, pointValues[1]!] as const;
  if (target === "rect" && rect === undefined) fail("A rect zoom requires --rect x,y,width,height.");
  if (target === "point" && point === undefined) fail("A point zoom requires --point x,y.");
  if (target === "window" && optionString(parsed, "--window") === undefined) {
    fail("A window zoom requires --window <window-id-or-title>.");
  }
  return {
    display: optionString(parsed, "--display"),
    easing: optionString(parsed, "--easing") ?? "ease-in-out",
    enterDuration: optionString(parsed, "--enter-duration"),
    exitDuration: optionString(parsed, "--exit-duration"),
    from,
    operation: "zoom-add",
    point,
    rect,
    scale: strictNumber(optionString(parsed, "--scale"), "--scale", 2),
    target,
    to,
    window: optionString(parsed, "--window"),
  };
}

function parseOverlay(argv: readonly string[]): EditCommand {
  const verb = argv[0];
  if (verb === "remove") {
    const parsed = parseOptions(argv.slice(1), { "--id": "value" });
    if (parsed.positionals.length > 1) fail("Usage: transmute edit <recording> overlay remove <id>");
    const id = parsed.positionals[0] ?? optionString(parsed, "--id");
    if (id === undefined) fail("overlay remove requires an ID.");
    return { id, operation: "overlay-remove" };
  }
  if (verb !== "add") fail("Usage: transmute edit <recording> overlay <add|remove> ...");
  const parsed = parseOptions(argv.slice(1), {
    ...TIME_RANGE_SPEC,
    "--anchor": "value",
    "--animated-audio": "value",
    "--audio-volume": "value",
    "--blend-mode": "value",
    "--corner-radius": "value",
    "--crop": "value",
    "--duck-primary-to": "value",
    "--entrance": "value",
    "--entrance-duration": "value",
    "--entrance-from-scale": "value",
    "--easing": "value",
    "--exit": "value",
    "--exit-duration": "value",
    "--exit-to-scale": "value",
    "--fit": "value",
    "--freeze-end": "value",
    "--height": "value",
    "--kind": "value",
    "--loop": "value",
    "--keyframe": "repeat",
    "--opacity": "value",
    "--playback-rate": "value",
    "--position": "value",
    "--provider": "value",
    "--rotation": "value",
    "--scale": "value",
    "--source": "value",
    "--source-in": "value",
    "--source-out": "value",
    "--slide-distance": "value",
    "--variant": "value",
    "--width": "value",
    "--z-index": "value",
  });
  const [from, to] = timeRange(parsed, "transmute edit <recording> overlay add --kind <kind> --source <path-or-emoji> --from <time> --to <time>");
  const overlayKind = oneOf(optionString(parsed, "--kind"), "--kind", [
    "image", "svg", "gif", "video", "emoji",
  ] as const);
  const source = optionString(parsed, "--source");
  if (source === undefined) fail("overlay add requires --source.");
  const positionValues = tupleNumbers(optionString(parsed, "--position"), "--position", 2) ?? [0, 0];
  const cropValues = tupleNumbers(optionString(parsed, "--crop"), "--crop", 4);
  const motionKeyframes = optionStrings(parsed, "--keyframe").map((value) => {
    const values = tupleNumbers(value, "--keyframe", 6)!;
    return {
      offset: values[0]!,
      opacity: values[5]!,
      position: [values[1]!, values[2]!] as const,
      rotation: values[4]!,
      scale: values[3]!,
    };
  });
  if (motionKeyframes.length === 1) fail("Overlay motion requires either zero or at least two --keyframe values.");
  return {
    anchor: oneOf(optionString(parsed, "--anchor"), "--anchor", [
      "top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right",
    ] as const, "center"),
    animatedAudio: oneOf(optionString(parsed, "--animated-audio"), "--animated-audio", [
      "mute", "mix", "duck",
    ] as const, "mute"),
    audioVolume: strictNumber(optionString(parsed, "--audio-volume"), "--audio-volume", 1),
    blendMode: oneOf(optionString(parsed, "--blend-mode"), "--blend-mode", [
      "normal", "addition", "darken", "lighten", "multiply", "overlay", "screen",
    ] as const, "normal"),
    cornerRadius: optionString(parsed, "--corner-radius") === undefined
      ? undefined
      : strictNumber(optionString(parsed, "--corner-radius"), "--corner-radius"),
    crop: cropValues === undefined
      ? undefined
      : [cropValues[0]!, cropValues[1]!, cropValues[2]!, cropValues[3]!] as const,
    duckPrimaryTo: strictNumber(optionString(parsed, "--duck-primary-to"), "--duck-primary-to", 0.25),
    entrance: optionString(parsed, "--entrance"),
    entranceDuration: optionString(parsed, "--entrance-duration"),
    entranceFromScale: strictNumber(optionString(parsed, "--entrance-from-scale"), "--entrance-from-scale", 0.8),
    easing: optionString(parsed, "--easing") ?? "ease-in-out",
    exit: optionString(parsed, "--exit"),
    exitDuration: optionString(parsed, "--exit-duration"),
    exitToScale: strictNumber(optionString(parsed, "--exit-to-scale"), "--exit-to-scale", 0.8),
    fit: oneOf(optionString(parsed, "--fit"), "--fit", ["contain", "cover", "fill"] as const, "fill"),
    freezeEnd: strictBoolean(optionString(parsed, "--freeze-end"), "--freeze-end", false),
    from,
    height: optionString(parsed, "--height") === undefined
      ? undefined
      : strictNumber(optionString(parsed, "--height"), "--height"),
    loop: strictBoolean(optionString(parsed, "--loop"), "--loop", false),
    motionKeyframes,
    opacity: strictNumber(optionString(parsed, "--opacity"), "--opacity", 1),
    operation: "overlay-add",
    overlayKind,
    playbackRate: strictNumber(optionString(parsed, "--playback-rate"), "--playback-rate", 1),
    position: [positionValues[0]!, positionValues[1]!],
    provider: oneOf(optionString(parsed, "--provider"), "--provider", [
      "auto", "apple-emoji-pack", "brand-catalog",
    ] as const, "auto"),
    rotation: strictNumber(optionString(parsed, "--rotation"), "--rotation", 0),
    scale: strictNumber(optionString(parsed, "--scale"), "--scale", 1),
    source,
    sourceIn: optionString(parsed, "--source-in"),
    sourceOut: optionString(parsed, "--source-out"),
    slideDistance: strictNumber(optionString(parsed, "--slide-distance"), "--slide-distance", 48),
    to,
    variant: optionString(parsed, "--variant") === undefined
      ? undefined
      : oneOf(optionString(parsed, "--variant"), "--variant", ["color", "duotone"] as const),
    width: optionString(parsed, "--width") === undefined
      ? undefined
      : strictNumber(optionString(parsed, "--width"), "--width"),
    zIndex: strictNumber(optionString(parsed, "--z-index"), "--z-index", 0),
  };
}

function parseEdit(argv: readonly string[]): CliCommand {
  const recording = argv[0];
  const operation = argv[1];
  if (recording === undefined || operation === undefined) {
    fail("Usage: transmute edit <recording> <init|show|trim|cut|speed|zoom|overlay|cursor|clicks|keystrokes|typed-text> ...");
  }
  const operationArgs = argv.slice(2);
  let json = false;
  let fps: number | undefined;
  let edit: EditCommand;
  if (operation === "init" || operation === "show") {
    const parsed = parseOptions(operationArgs, { "--fps": "value", "--json": "flag" });
    exactPositionals(parsed, 0, `transmute edit <recording> ${operation} [--json]`);
    json = optionFlag(parsed, "--json");
    fps = optionString(parsed, "--fps") === undefined
      ? undefined
      : strictNumber(optionString(parsed, "--fps"), "--fps");
    edit = { operation };
  } else {
    const cleanArgs: string[] = [];
    for (let index = 0; index < operationArgs.length; index += 1) {
      const argument = operationArgs[index]!;
      if (argument === "--json") {
        if (json) fail("Option may be specified only once: --json");
        json = true;
        continue;
      }
      if (argument === "--fps" || argument.startsWith("--fps=")) {
        if (fps !== undefined) fail("Option may be specified only once: --fps");
        const value = argument === "--fps" ? operationArgs[index + 1] : argument.slice("--fps=".length);
        if (value === undefined || value.startsWith("--")) fail("Option requires a value: --fps");
        if (argument === "--fps") index += 1;
        fps = strictNumber(value, "--fps");
        continue;
      }
      cleanArgs.push(argument);
    }
    if (operation === "trim" || operation === "cut") {
      const parsed = parseOptions(cleanArgs, TIME_RANGE_SPEC);
      const [from, to] = timeRange(parsed, `transmute edit <recording> ${operation} <from> <to>`);
      edit = { from, operation, to };
    } else if (operation === "speed") {
      const parsed = parseOptions(cleanArgs, { ...TIME_RANGE_SPEC, "--rate": "value" });
      let from: string;
      let to: string;
      let rate: number;
      if (parsed.positionals.length === 3 && optionString(parsed, "--rate") === undefined) {
        from = parsed.positionals[0]!;
        to = parsed.positionals[1]!;
        rate = strictNumber(parsed.positionals[2], "rate");
      } else {
        [from, to] = timeRange(parsed, "transmute edit <recording> speed --from <time> --to <time> --rate <number>");
        rate = strictNumber(optionString(parsed, "--rate"), "--rate");
      }
      edit = { from, operation, rate, to };
    } else if (operation === "zoom") {
      edit = parseZoom(cleanArgs);
    } else if (operation === "overlay") {
      edit = parseOverlay(cleanArgs);
    } else if (operation === "cursor") {
      const parsed = parseOptions(cleanArgs, {
        "--click-highlight": "value",
        "--enabled": "value",
        "--smoothing": "value",
      });
      if (parsed.positionals.length > 1) fail("Usage: transmute edit <recording> cursor <on|off> [options]");
      const toggle = parsed.positionals[0];
      if (toggle !== undefined && toggle !== "on" && toggle !== "off") fail("cursor state must be on or off.");
      edit = {
        clickHighlight: optionString(parsed, "--click-highlight") === undefined
          ? undefined
          : strictBoolean(optionString(parsed, "--click-highlight"), "--click-highlight", true),
        enabled: toggle === undefined
          ? strictBoolean(optionString(parsed, "--enabled"), "--enabled", true)
          : toggle === "on",
        operation: "cursor",
        smoothing: optionString(parsed, "--smoothing") === undefined
          ? undefined
          : strictNumber(optionString(parsed, "--smoothing"), "--smoothing"),
      };
    } else if (operation === "keystrokes") {
      const parsed = parseOptions(cleanArgs, { "--enabled": "value", "--stop-after": "value" });
      if (parsed.positionals.length > 1) fail("Usage: transmute edit <recording> keystrokes <on|off> [--stop-after time]");
      const toggle = parsed.positionals[0];
      if (toggle !== undefined && toggle !== "on" && toggle !== "off") fail("keystrokes state must be on or off.");
      edit = {
        enabled: toggle === undefined
          ? strictBoolean(optionString(parsed, "--enabled"), "--enabled", true)
          : toggle === "on",
        operation: "keystrokes",
        stopAfter: optionString(parsed, "--stop-after"),
      };
    } else if (operation === "clicks") {
      const parsed = parseOptions(cleanArgs, {
        "--color": "value",
        "--duration": "value",
        "--radius": "value",
        "--style": "value",
      });
      const [toggle] = exactPositionals(parsed, 1, "transmute edit <recording> clicks <on|off> [options]");
      if (toggle !== "on" && toggle !== "off") fail("clicks state must be on or off.");
      edit = {
        color: optionString(parsed, "--color") ?? "#ffcc00cc",
        duration: optionString(parsed, "--duration") ?? "350ms",
        enabled: toggle === "on",
        operation: "clicks",
        radius: strictNumber(optionString(parsed, "--radius"), "--radius", 28),
        style: oneOf(optionString(parsed, "--style"), "--style", ["pulse", "ring", "fill"] as const, "pulse"),
      };
    } else if (operation === "typed-text") {
      const parsed = parseOptions(cleanArgs, {
        "--idle-timeout": "value",
        "--max-characters": "value",
        "--placement": "value",
      });
      const [toggle] = exactPositionals(parsed, 1, "transmute edit <recording> typed-text <on|off> [options]");
      if (toggle !== "on" && toggle !== "off") fail("typed-text state must be on or off.");
      edit = {
        enabled: toggle === "on",
        idleTimeout: optionString(parsed, "--idle-timeout") ?? "1200ms",
        maxCharacters: strictInteger(optionString(parsed, "--max-characters"), "--max-characters", 160),
        operation: "typed-text",
        placement: oneOf(optionString(parsed, "--placement"), "--placement", ["input", "caption"] as const, "input"),
      };
    } else {
      fail(`Unknown edit operation: ${operation}`);
    }
  }
  return {
    edit,
    fps,
    json,
    kind: "edit",
    recording,
  };
}

function parseAnalyze(argv: readonly string[]): CliCommand {
  if (argv[0] === "faces") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--backend": "value",
      "--max-faces": "value",
      "--max-track-gap": "value",
      "--min-confidence": "value",
      "--sample-fps": "value",
      "--source": "value",
    });
    const [project] = exactPositionals(
      parsed,
      1,
      "transmute analyze faces <project> --source <asset:video-stream> [options] [--json]",
    );
    const source = optionString(parsed, "--source");
    if (source === undefined) fail("analyze faces requires --source.");
    const sampleFps = strictNumber(optionString(parsed, "--sample-fps"), "--sample-fps", 8);
    const minConfidence = strictNumber(
      optionString(parsed, "--min-confidence"),
      "--min-confidence",
      0.6,
    );
    const maxFaces = strictInteger(optionString(parsed, "--max-faces"), "--max-faces", 32);
    if (sampleFps <= 0 || sampleFps > 60) fail("--sample-fps must be greater than zero and at most 60.");
    if (minConfidence < 0 || minConfidence > 1) {
      fail("--min-confidence must be between zero and one.");
    }
    if (maxFaces > 128) fail("--max-faces must be at most 128.");
    return {
      backend: oneOf(
        optionString(parsed, "--backend"),
        "--backend",
        ["auto", "vision"] as const,
        "auto",
      ),
      json: optionFlag(parsed, "--json"),
      kind: "analyze-faces",
      maxFaces,
      maxTrackGap: optionString(parsed, "--max-track-gap") ?? "500ms",
      minConfidence,
      project: project!,
      sampleFps,
      source,
    };
  }
  if (argv[0] === "music") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--source": "value",
      "--window": "value",
    });
    const [project] = exactPositionals(parsed, 1, "transmute analyze music <project> --source <asset:stream> [--window <time>] [--json]");
    const source = optionString(parsed, "--source");
    if (source === undefined) fail("analyze music requires --source.");
    return {
      json: optionFlag(parsed, "--json"),
      kind: "analyze-music",
      project: project!,
      source,
      window: optionString(parsed, "--window") ?? "20s",
    };
  }
  if (argv[0] === "scenes") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--allow-cloud-upload": "flag",
      "--execute": "flag",
      "--max-scene-duration": "value",
      "--model": "value",
      "--scene-threshold": "value",
      "--source": "value",
    });
    const [project] = exactPositionals(
      parsed,
      1,
      "transmute analyze scenes <project> --source <asset:stream> [--execute --allow-cloud-upload] [options]",
    );
    const source = optionString(parsed, "--source");
    if (source === undefined) fail("analyze scenes requires --source.");
    const execute = optionFlag(parsed, "--execute");
    const allowCloudUpload = optionFlag(parsed, "--allow-cloud-upload");
    if (execute && !allowCloudUpload) {
      fail("Scene execution requires explicit --allow-cloud-upload acknowledgement.");
    }
    if (allowCloudUpload && !execute) {
      fail("--allow-cloud-upload is meaningful only with --execute.");
    }
    const sceneThreshold = strictNumber(optionString(parsed, "--scene-threshold"), "--scene-threshold", 0.35);
    if (sceneThreshold <= 0 || sceneThreshold > 1) fail("--scene-threshold must be greater than zero and at most one.");
    return {
      allowCloudUpload,
      execute,
      json: optionFlag(parsed, "--json"),
      kind: "analyze-scenes",
      maximumSceneDuration: optionString(parsed, "--max-scene-duration") ?? "20s",
      model: optionString(parsed, "--model") ?? "google/gemini-3-flash",
      project: project!,
      sceneThreshold,
      source,
    };
  }
  if (argv[0] === "speech") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--language": "value",
      "--min-filler-confidence": "value",
      "--model": "value",
      "--no-gpu": "flag",
      "--processors": "value",
      "--protect-music": "value",
      "--source": "value",
      "--speech-handle": "value",
      "--threads": "value",
      "--whisper": "value",
    });
    const [project] = exactPositionals(parsed, 1, "transmute analyze speech <project> --source <asset:stream> --model <path> [options]");
    const source = optionString(parsed, "--source");
    if (source === undefined) fail("analyze speech requires --source.");
    const minimumFillerConfidence = strictNumber(
      optionString(parsed, "--min-filler-confidence"),
      "--min-filler-confidence",
      0.82,
    );
    if (minimumFillerConfidence < 0 || minimumFillerConfidence > 1) {
      fail("--min-filler-confidence must be between zero and one.");
    }
    return {
      json: optionFlag(parsed, "--json"),
      kind: "analyze-speech",
      language: optionString(parsed, "--language") ?? "auto",
      minimumFillerConfidence,
      model: optionString(parsed, "--model"),
      noGpu: optionFlag(parsed, "--no-gpu"),
      processors: strictInteger(optionString(parsed, "--processors"), "--processors", 1),
      protectMusic: strictBoolean(optionString(parsed, "--protect-music"), "--protect-music", true),
      project: project!,
      source,
      speechHandle: optionString(parsed, "--speech-handle") ?? "120ms",
      threads: strictInteger(optionString(parsed, "--threads"), "--threads", 4),
      whisper: optionString(parsed, "--whisper"),
    };
  }
  if (argv[0] === "zooms") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--apply": "flag",
      "--plan": "value",
    });
    const [recording] = exactPositionals(parsed, 1, "transmute analyze zooms <recording> [--apply] [--plan <id>] [--json]");
    return {
      apply: optionFlag(parsed, "--apply"),
      json: optionFlag(parsed, "--json"),
      kind: "analyze-zooms",
      plan: optionString(parsed, "--plan"),
      recording: recording!,
    };
  }
  if (argv[0] !== "inactivity") {
    fail("Usage: transmute analyze <faces|inactivity|zooms|music|scenes|speech> ...");
  }
  const parsed = parseOptions(argv.slice(1), {
    ...JSON_SPEC,
    "--apply": "flag",
    "--handle": "value",
    "--min-duration": "value",
    "--motion-threshold": "value",
    "--protect-audio": "value",
    "--speed-rate": "value",
  });
  const [recording] = exactPositionals(parsed, 1, "transmute analyze inactivity <recording|project> [options]");
  const threshold = strictNumber(optionString(parsed, "--motion-threshold"), "--motion-threshold", 0.003);
  if (threshold < 0 || threshold > 1) fail("--motion-threshold must be between 0 and 1.");
  const speedRate = strictNumber(optionString(parsed, "--speed-rate"), "--speed-rate", 8);
  if (speedRate <= 1 || speedRate > 64) fail("--speed-rate must be greater than 1 and at most 64.");
  return {
    apply: optionFlag(parsed, "--apply"),
    handle: oneOf(optionString(parsed, "--handle"), "--handle", ["cut", "speed", "keep"] as const, "cut"),
    json: optionFlag(parsed, "--json"),
    kind: "analyze-inactivity",
    minDuration: optionString(parsed, "--min-duration") ?? "3s",
    motionThreshold: threshold,
    protectAudio: strictBoolean(optionString(parsed, "--protect-audio"), "--protect-audio", true),
    recording: recording!,
    speedRate,
  };
}

function parseFaces(argv: readonly string[]): CliCommand {
  if (argv[0] !== "list") {
    fail("Usage: transmute faces list <project> <analysis-id> [options] [--json]");
  }
  const parsed = parseOptions(argv.slice(1), {
    ...JSON_SPEC,
    "--at": "value",
    "--limit": "value",
    "--min-confidence": "value",
    "--min-duration": "value",
  });
  const [project, analysis] = exactPositionals(
    parsed,
    2,
    "transmute faces list <project> <analysis-id> [options] [--json]",
  );
  const minConfidence = strictNumber(
    optionString(parsed, "--min-confidence"),
    "--min-confidence",
    0.6,
  );
  if (minConfidence < 0 || minConfidence > 1) {
    fail("--min-confidence must be between zero and one.");
  }
  const limit = strictInteger(optionString(parsed, "--limit"), "--limit", 20);
  if (limit > 1_000) fail("--limit must be at most 1000.");
  return {
    analysis: analysis!,
    at: optionString(parsed, "--at"),
    json: optionFlag(parsed, "--json"),
    kind: "faces-list",
    limit,
    minConfidence,
    minDuration: optionString(parsed, "--min-duration") ?? "0s",
    project: project!,
  };
}

function parseFillers(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "list") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--auto-only": "flag" });
    const [project, analysis] = exactPositionals(
      parsed,
      2,
      "transmute fillers list <project> <speech-analysis-id> [--auto-only] [--json]",
    );
    return {
      analysis: analysis!,
      autoOnly: optionFlag(parsed, "--auto-only"),
      json: optionFlag(parsed, "--json"),
      kind: "fillers-list",
      project: project!,
    };
  }
  if (action === "apply") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--placement": "value" });
    const [project, analysis, candidate] = exactPositionals(
      parsed,
      3,
      "transmute fillers apply <project> <speech-analysis-id> <candidate-id> [--placement <id>] [--json]",
    );
    return {
      analysis: analysis!,
      candidate: candidate!,
      json: optionFlag(parsed, "--json"),
      kind: "fillers-apply",
      placement: optionString(parsed, "--placement"),
      project: project!,
    };
  }
  fail("Usage: transmute fillers <list|apply> ...");
}

function parseAlign(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "analyze") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--apply": "flag",
      "--candidate": "value",
      "--max-offset": "value",
      "--reference": "value",
      "--reference-placement": "value",
      "--target": "value",
      "--target-placement": "value",
    });
    const [project] = exactPositionals(parsed, 1, "transmute align analyze <project> --reference <asset:stream> --target <asset:stream> [options]");
    const reference = optionString(parsed, "--reference");
    const target = optionString(parsed, "--target");
    if (reference === undefined || target === undefined) fail("align analyze requires --reference and --target.");
    if (optionString(parsed, "--candidate") !== undefined && !optionFlag(parsed, "--apply")) {
      fail("--candidate is meaningful only with --apply.");
    }
    return {
      apply: optionFlag(parsed, "--apply"),
      candidate: optionString(parsed, "--candidate"),
      json: optionFlag(parsed, "--json"),
      kind: "align-analyze",
      maxOffset: optionString(parsed, "--max-offset"),
      project: project!,
      reference,
      referencePlacement: optionString(parsed, "--reference-placement"),
      target,
      targetPlacement: optionString(parsed, "--target-placement"),
    };
  }
  if (action === "apply") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--candidate": "value",
      "--reference-placement": "value",
      "--target-placement": "value",
    });
    const [project, analysis] = exactPositionals(
      parsed,
      2,
      "transmute align apply <project> <analysis-id> --candidate <candidate-id> [options]",
    );
    const candidate = optionString(parsed, "--candidate");
    if (candidate === undefined) fail("align apply requires --candidate.");
    return {
      analysis: analysis!,
      candidate,
      json: optionFlag(parsed, "--json"),
      kind: "align-apply",
      project: project!,
      referencePlacement: optionString(parsed, "--reference-placement"),
      targetPlacement: optionString(parsed, "--target-placement"),
    };
  }
  fail("Usage: transmute align <analyze|apply> ...");
}

function parseRender(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action !== "plan" && action !== "run") {
    fail("Usage: transmute render <plan|run> <recording> [options]");
  }
  const parsed = parseOptions(argv.slice(1), {
    ...JSON_SPEC,
    "--dry-run": "flag",
    "--display": "value",
    "--keep-inactivity": "flag",
    "--no-auto-inactivity": "flag",
    "--output": "value",
  });
  const [recording] = exactPositionals(parsed, 1, `transmute render ${action} <recording> [options]`);
  const keepInactivity = optionFlag(parsed, "--keep-inactivity");
  const noAutoInactivity = optionFlag(parsed, "--no-auto-inactivity");
  if (keepInactivity && noAutoInactivity) fail("Use only one inactivity opt-out flag.");
  const autoInactivity = !keepInactivity && !noAutoInactivity;
  if (action === "plan") {
    if (optionFlag(parsed, "--dry-run")) fail("--dry-run is valid only for render run.");
    return {
      autoInactivity,
      display: optionString(parsed, "--display") ?? "primary",
      json: optionFlag(parsed, "--json"),
      kind: "render-plan",
      output: optionString(parsed, "--output"),
      recording: recording!,
    };
  }
  return {
    autoInactivity,
    display: optionString(parsed, "--display") ?? "primary",
    dryRun: optionFlag(parsed, "--dry-run"),
    json: optionFlag(parsed, "--json"),
    kind: "render-run",
    output: optionString(parsed, "--output"),
    recording: recording!,
  };
}

function parseAssets(argv: readonly string[]): CliCommand {
  if (argv[0] !== "emoji" || (argv[1] !== "search" && argv[1] !== "resolve")) {
    fail("Usage: transmute assets emoji <search|resolve> <glyph|name|hex-id> [options]");
  }
  const action = argv[1];
  const parsed = parseOptions(argv.slice(2), {
    ...JSON_SPEC,
    "--limit": "value",
    "--provider": "value",
    "--variant": "value",
  });
  const [query] = exactPositionals(parsed, 1, `transmute assets emoji ${action} <glyph|name|hex-id> [options]`);
  const variant = optionString(parsed, "--variant") === undefined
    ? undefined
    : oneOf(optionString(parsed, "--variant"), "--variant", ["color", "duotone"] as const);
  const provider = oneOf(optionString(parsed, "--provider"), "--provider", [
    "auto", "all", "apple-emoji-pack", "brand-catalog",
  ] as const, action === "search" ? "all" : "auto");
  if (action === "search") {
    if (provider === "auto") fail("Emoji search provider must be all, apple-emoji-pack, or brand-catalog.");
    return {
      json: optionFlag(parsed, "--json"),
      kind: "emoji-search",
      limit: strictInteger(optionString(parsed, "--limit"), "--limit", 20),
      provider,
      query: query!,
      variant,
    };
  }
  if (provider === "all") fail("Emoji resolve provider must be auto, apple-emoji-pack, or brand-catalog.");
  return {
    json: optionFlag(parsed, "--json"),
    kind: "emoji-resolve",
    provider,
    query: query!,
    variant,
  };
}

const RUN_OUTPUT_SPEC = {
  ...JSON_SPEC,
  "--jobs": "value",
  "--jsonl": "flag",
} as const;

function parseJobs(parsed: ParsedOptions): number {
  const jobs = strictInteger(optionString(parsed, "--jobs"), "--jobs", 4);
  if (jobs < 1 || jobs > 64) fail("--jobs must be from 1 through 64.");
  return jobs;
}

function runOutput(parsed: ParsedOptions): {
  readonly jobs: number;
  readonly json: boolean;
  readonly jsonl: boolean;
} {
  const json = optionFlag(parsed, "--json");
  const jsonl = optionFlag(parsed, "--jsonl");
  if (json && jsonl) fail("Use only one of --json or --jsonl.");
  return { jobs: parseJobs(parsed), json: json || jsonl, jsonl };
}

function checkedSha256(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(`${name} must be a lowercase SHA-256 digest.`);
  return value;
}

function checkedRunId(value: string): string {
  if (!/^run_[a-z0-9][a-z0-9_-]{5,95}$/u.test(value)) {
    fail("Run IDs must use the run_<safe-id> form.");
  }
  return value;
}

function checkedNodeKey(value: string): string {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)*$/u.test(value)) {
    fail("Node keys must use slash-separated lowercase safe identifiers.");
  }
  return value;
}

function parseOperations(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "list") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    exactPositionals(parsed, 0, "transmute operations list [--json]");
    return { json: optionFlag(parsed, "--json"), kind: "operations-list" };
  }
  if (action === "show") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    const [operation] = exactPositionals(
      parsed,
      1,
      "transmute operations show <kind>[@<version>] [--json]",
    );
    return { json: optionFlag(parsed, "--json"), kind: "operations-show", operation: operation! };
  }
  fail("Usage: transmute operations <list|show> ...");
}

function parseDiagram(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "check") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    const [path] = exactPositionals(parsed, 1, "transmute diagram check <diagram.json> [--json]");
    return { json: optionFlag(parsed, "--json"), kind: "diagram-check", path: path! };
  }
  if (action === "render") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--scale": "value",
    });
    const [path] = exactPositionals(
      parsed,
      1,
      "transmute diagram render <diagram.json> [--scale <0..4>] [--json]",
    );
    return {
      json: optionFlag(parsed, "--json"),
      kind: "diagram-render",
      path: path!,
      scale: optionalBoundedNumber(optionString(parsed, "--scale"), "--scale", Number.EPSILON, 4),
    };
  }
  fail("Usage: transmute diagram <check|render> <diagram.json> [options]");
}

function parseDuotone(value: string | undefined): readonly [string, string] | undefined {
  if (value === undefined) return undefined;
  const colors = value.split(",");
  if (
    colors.length !== 2
    || !colors.every(color => /^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$/u.test(color))
  ) {
    fail("--duotone must be two comma-separated #RGB or #RRGGBB colors.");
  }
  return [colors[0]!, colors[1]!];
}

function parseImage(argv: readonly string[]): CliCommand {
  if (argv[0] !== "vectorize") {
    fail("Usage: transmute image vectorize <raster-path> [options]");
  }
  const parsed = parseOptions(argv.slice(1), {
    ...JSON_SPEC,
    "--alpha-cutoff": "value",
    "--duotone": "value",
    "--timeout-ms": "value",
  });
  const [inputPath] = exactPositionals(
    parsed,
    1,
    "transmute image vectorize <raster-path> [--duotone <#primary,#secondary>] [--alpha-cutoff <1..64>] [--timeout-ms <1..300000>] [--json]",
  );
  const alphaCutoff = optionalStrictInteger(
    optionString(parsed, "--alpha-cutoff"),
    "--alpha-cutoff",
  );
  if (alphaCutoff !== undefined && alphaCutoff > 64) {
    fail("--alpha-cutoff must be between 1 and 64.");
  }
  const timeoutMs = optionalStrictInteger(
    optionString(parsed, "--timeout-ms"),
    "--timeout-ms",
  );
  if (timeoutMs !== undefined && timeoutMs > 300_000) {
    fail("--timeout-ms must be between 1 and 300000.");
  }
  return {
    alphaCutoff,
    duotone: parseDuotone(optionString(parsed, "--duotone")),
    inputPath: inputPath!,
    json: optionFlag(parsed, "--json"),
    kind: "image-vectorize",
    timeoutMs,
  };
}

function parseWorkflows(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "list") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    exactPositionals(parsed, 0, "transmute workflows list [--json]");
    return { json: optionFlag(parsed, "--json"), kind: "workflows-list" };
  }
  if (action === "show") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    const [workflow] = exactPositionals(parsed, 1, "transmute workflows show <id> [--json]");
    return { json: optionFlag(parsed, "--json"), kind: "workflows-show", workflow: workflow! };
  }
  if (action === "plan") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--input": "value" });
    const [workflow] = exactPositionals(
      parsed,
      1,
      "transmute workflows plan <id> --input <json-file> [--json]",
    );
    const input = optionString(parsed, "--input");
    if (input === undefined) fail("workflows plan requires --input.");
    return {
      input,
      json: optionFlag(parsed, "--json"),
      kind: "workflows-plan",
      workflow: workflow!,
    };
  }
  if (action === "run") {
    const parsed = parseOptions(argv.slice(1), {
      ...RUN_OUTPUT_SPEC,
      "--input": "value",
      "--provider-options": "value",
    });
    const [workflow] = exactPositionals(
      parsed,
      1,
      "transmute workflows run <id> --input <json-file> [--provider-options <json-file>] [--jobs <n>] [--json|--jsonl]",
    );
    const input = optionString(parsed, "--input");
    if (input === undefined) fail("workflows run requires --input.");
    return {
      input,
      kind: "workflows-run",
      providerOptions: optionString(parsed, "--provider-options"),
      workflow: workflow!,
      ...runOutput(parsed),
    };
  }
  fail("Usage: transmute workflows <list|show|plan|run> ...");
}

function parseCode(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "init") {
    const parsed = parseOptions(argv.slice(1), {});
    const [path] = exactPositionals(parsed, 1, "transmute code init <path>");
    return { kind: "code-init", path: path! };
  }
  if (action === "check") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    const [path] = exactPositionals(parsed, 1, "transmute code check <path> [--json]");
    return { json: optionFlag(parsed, "--json"), kind: "code-check", path: path! };
  }
  if (action === "plan") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--input": "value" });
    const [path] = exactPositionals(
      parsed,
      1,
      "transmute code plan <path> --input <json-file> [--json]",
    );
    const input = optionString(parsed, "--input");
    if (input === undefined) fail("code plan requires --input.");
    return { input, json: optionFlag(parsed, "--json"), kind: "code-plan", path: path! };
  }
  if (action === "run") {
    const parsed = parseOptions(argv.slice(1), {
      ...RUN_OUTPUT_SPEC,
      "--input": "value",
      "--plan": "value",
      "--provider-options": "value",
    });
    const [path] = exactPositionals(
      parsed,
      1,
      "transmute code run <path> --input <json-file> [--plan <sha256>] [--provider-options <json-file>] [--jobs <n>] [--json|--jsonl]",
    );
    const input = optionString(parsed, "--input");
    if (input === undefined) fail("code run requires --input.");
    return {
      input,
      kind: "code-run",
      path: path!,
      plan: checkedSha256(optionString(parsed, "--plan"), "--plan"),
      providerOptions: optionString(parsed, "--provider-options"),
      ...runOutput(parsed),
    };
  }
  fail("Usage: transmute code <init|check|plan|run> ...");
}

function parseRuns(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action === "list") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--limit": "value" });
    exactPositionals(parsed, 0, "transmute runs list [--limit <n>] [--json]");
    const limit = strictInteger(optionString(parsed, "--limit"), "--limit", 20);
    if (limit < 1 || limit > 1_000) fail("--limit must be from 1 through 1000.");
    return { json: optionFlag(parsed, "--json"), kind: "runs-list", limit };
  }
  if (action === "show") {
    const parsed = parseOptions(argv.slice(1), { ...JSON_SPEC, "--nodes": "value" });
    const [runId] = exactPositionals(
      parsed,
      1,
      "transmute runs show <run-id> [--nodes failed|all] [--json]",
    );
    return {
      json: optionFlag(parsed, "--json"),
      kind: "runs-show",
      nodes: oneOf(optionString(parsed, "--nodes"), "--nodes", ["failed", "all"] as const, "failed"),
      runId: checkedRunId(runId!),
    };
  }
  if (action === "resume") {
    const parsed = parseOptions(argv.slice(1), {
      ...RUN_OUTPUT_SPEC,
      "--provider-options": "value",
      "--replay-ambiguous-code": "repeat",
    });
    const [runId] = exactPositionals(
      parsed,
      1,
      "transmute runs resume <run-id> [--provider-options <json-file>] [--replay-ambiguous-code <node-key> ...] [--jobs <n>] [--json|--jsonl]",
    );
    return {
      kind: "runs-resume",
      providerOptions: optionString(parsed, "--provider-options"),
      replayAmbiguousCode: optionStrings(parsed, "--replay-ambiguous-code")
        .map(checkedNodeKey),
      runId: checkedRunId(runId!),
      ...runOutput(parsed),
    };
  }
  if (action === "approve") {
    const parsed = parseOptions(argv.slice(1), {
      ...JSON_SPEC,
      "--node-plan": "value",
      "--preparation-plan": "value",
    });
    const [runId, nodeKey] = exactPositionals(
      parsed,
      2,
      "transmute runs approve <run-id> <node-key> (--preparation-plan <sha256>|--node-plan <sha256>) [--json]",
    );
    const preparation = checkedSha256(optionString(parsed, "--preparation-plan"), "--preparation-plan");
    const effect = checkedSha256(optionString(parsed, "--node-plan"), "--node-plan");
    if ((preparation === undefined) === (effect === undefined)) {
      fail("runs approve requires exactly one of --preparation-plan or --node-plan.");
    }
    return {
      json: optionFlag(parsed, "--json"),
      kind: "runs-approve",
      nodeKey: checkedNodeKey(nodeKey!),
      planHash: (preparation ?? effect)!,
      planKind: preparation === undefined ? "effect" : "preparation",
      runId: checkedRunId(runId!),
    };
  }
  if (action === "cancel") {
    const parsed = parseOptions(argv.slice(1), JSON_SPEC);
    const [runId] = exactPositionals(parsed, 1, "transmute runs cancel <run-id> [--json]");
    return { json: optionFlag(parsed, "--json"), kind: "runs-cancel", runId: checkedRunId(runId!) };
  }
  fail("Usage: transmute runs <list|show|resume|approve|cancel> ...");
}

function helpTopic(argv: readonly string[], index: number): readonly string[] {
  return argv.slice(0, index).filter((argument) => !argument.startsWith("-"));
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: "help", topic: [] };
  const helpIndex = argv.findIndex((argument) => argument === "--help" || argument === "-h");
  if (helpIndex !== -1) return { kind: "help", topic: helpTopic(argv, helpIndex) };
  if (argv[0] === "help") {
    if (argv.slice(1).some((argument) => argument.startsWith("-"))) fail("help takes only a command topic.");
    return { kind: "help", topic: argv.slice(1) };
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    if (argv.length !== 1) fail("--version does not take arguments.");
    return { kind: "version" };
  }
  const command = argv[0]!;
  switch (command) {
    case "operations": return parseOperations(argv.slice(1));
    case "diagram": return parseDiagram(argv.slice(1));
    case "image": return parseImage(argv.slice(1));
    case "workflows": return parseWorkflows(argv.slice(1));
    case "code": return parseCode(argv.slice(1));
    case "runs": return parseRuns(argv.slice(1));
    case "doctor": return parseDoctor(argv.slice(1));
    case "ai": return parseAi(argv.slice(1));
    case "media": return parseMedia(argv.slice(1));
    case "recordings": return parseRecordings(argv.slice(1));
    case "projects": return parseProjects(argv.slice(1));
    case "project": return parseProject(argv.slice(1));
    case "inspect": return parseInspect(argv.slice(1));
    case "events": return parseEvents(argv.slice(1));
    case "record": return parseRecord(argv.slice(1));
    case "edit": return parseEdit(argv.slice(1));
    case "analyze": return parseAnalyze(argv.slice(1));
    case "faces": return parseFaces(argv.slice(1));
    case "align": return parseAlign(argv.slice(1));
    case "fillers": return parseFillers(argv.slice(1));
    case "render": return parseRender(argv.slice(1));
    case "assets": return parseAssets(argv.slice(1));
    case "__complete": return { kind: "complete", words: argv.slice(1) };
    default: fail(`Unknown command: ${command}. Run transmute help.`);
  }
}
