import { expect, test } from "bun:test";
import { parseCliArgs } from "./args";
import { commandHelp, completions } from "./help";
import type { CliIo } from "./io";
import { createCliTestRunner } from "./run-cli-test-helper";
import { parseCliTime } from "./time";

const runCli = createCliTestRunner(import.meta.url);

test("parses agent-friendly microsecond, millisecond, second, clock, and frame times", () => {
  expect(parseCliTime("42us")).toBe(42);
  expect(parseCliTime("12ms")).toBe(12_000);
  expect(parseCliTime("1.5s")).toBe(1_500_000);
  expect(parseCliTime("00:01:02.500")).toBe(62_500_000);
  expect(parseCliTime("30f", 60)).toBe(500_000);
  expect(() => parseCliTime("30f")).toThrow("requires --fps");
});

test("parses exact capture-source IDs and rejects ambiguous or duplicate selections", () => {
  expect(parseCliArgs([
    "record", "start",
    "--display", "display-left",
    "--display", "display-right",
    "--camera-device", "camera-external",
    "--microphone-device", "microphone-usb",
  ])).toMatchObject({
    action: "start",
    cameraDeviceId: "camera-external",
    displays: ["display-left", "display-right"],
    kind: "record",
    microphone: true,
    microphoneDeviceId: "microphone-usb",
    systemAudio: true,
    webcam: true,
  });
  expect(() => parseCliArgs([
    "record", "start", "--display", "display-left", "--display", "display-left",
  ])).toThrow(/unique/u);
  expect(() => parseCliArgs([
    "record", "start", "--webcam", "false", "--camera-device", "camera-external",
  ])).toThrow(/cannot be combined/u);
  expect(() => parseCliArgs([
    "record", "start", "--microphone", "false", "--microphone-device", "microphone-usb",
  ])).toThrow(/cannot be combined/u);
});

test("parses manual zoom transition timing and emoji overlay providers", () => {
  const zoom = parseCliArgs([
    "edit", "rec_example001", "zoom", "add",
    "--from", "1s", "--to", "4s", "--target", "cursor",
    "--enter-duration", "200ms", "--exit-duration", "350ms",
  ]);
  expect(zoom).toMatchObject({
    edit: { enterDuration: "200ms", exitDuration: "350ms", operation: "zoom-add" },
    kind: "edit",
  });

  const overlay = parseCliArgs([
    "edit", "rec_example001", "overlay", "add",
    "--kind", "emoji", "--source", "transmute", "--provider", "brand-catalog",
    "--from", "1s", "--to", "4s", "--easing", "spring",
  ]);
  expect(overlay).toMatchObject({
    edit: { easing: "spring", operation: "overlay-add", provider: "brand-catalog" },
    kind: "edit",
  });

  expect(parseCliArgs([
    "assets", "emoji", "resolve", "transmute", "--provider", "brand-catalog",
  ])).toMatchObject({ kind: "emoji-resolve", provider: "brand-catalog", variant: undefined });
});

test("parses synchronized analysis, filler, and fully featured project overlay commands", () => {
  expect(parseCliArgs([
    "analyze", "inactivity", "project_example001",
    "--handle", "speed", "--speed-rate", "12", "--apply",
  ])).toMatchObject({
    apply: true,
    handle: "speed",
    kind: "analyze-inactivity",
    recording: "project_example001",
    speedRate: 12,
  });
  expect(parseCliArgs([
    "analyze", "scenes", "project_example001",
    "--source", "asset_screen001:stream_video001",
    "--execute", "--allow-cloud-upload", "--json",
  ])).toMatchObject({
    execute: true,
    json: true,
    kind: "analyze-scenes",
    model: "google/gemini-3-flash",
  });
  expect(() => parseCliArgs([
    "analyze", "scenes", "project_example001",
    "--source", "asset_screen001:stream_video001",
    "--execute",
  ])).toThrow(/allow-cloud-upload/u);
  expect(parseCliArgs([
    "analyze", "speech", "project_example001",
    "--source", "asset_audio001:stream_audio001",
    "--model", "/models/ggml.bin",
  ])).toMatchObject({ kind: "analyze-speech", protectMusic: true });
  expect(parseCliArgs([
    "fillers", "apply", "project_example001", "analysis_speech01", "filler_candidate01",
    "--placement", "placement_dialogue01",
  ])).toMatchObject({ kind: "fillers-apply", placement: "placement_dialogue01" });

  const projectOverlay = parseCliArgs([
    "project", "edit", "project_example001", "overlay", "add",
    "--kind", "video", "--source", "/tmp/callout.mp4", "--from", "1s", "--to", "4s",
    "--fit", "cover", "--crop", "0.1,0.2,0.1,0", "--corner-radius", "24",
    "--blend-mode", "screen", "--animated-audio", "duck", "--audio-volume", "0.6",
    "--duck-primary-to", "0.3", "--entrance", "scale", "--entrance-from-scale", "0.5",
    "--keyframe", "0,-20,0,0.8,-5,0", "--keyframe", "1,20,0,1,5,1",
  ]);
  expect(projectOverlay).toMatchObject({
    edit: {
      animatedAudio: "duck",
      blendMode: "screen",
      fit: "cover",
      motionKeyframes: [{ offset: 0 }, { offset: 1 }],
      operation: "overlay-add",
    },
    kind: "project-overlay-edit",
  });
  expect(parseCliArgs([
    "project", "edit", "project_example001", "zoom", "add",
    "--from", "1s", "--to", "3s", "--target", "point", "--point", "100,200",
    "--source-placement", "placement_screen001", "--fps", "60",
  ])).toMatchObject({
    edit: { operation: "zoom-add", point: [100, 200] },
    fps: 60,
    kind: "project-metadata-edit",
    sourcePlacement: "placement_screen001",
  });
  expect(parseCliArgs([
    "project", "edit", "project_example001", "typed-text", "on",
    "--source-placement=placement_screen001", "--idle-timeout", "900ms",
  ])).toMatchObject({
    edit: { enabled: true, idleTimeout: "900ms", operation: "typed-text" },
    kind: "project-metadata-edit",
    sourcePlacement: "placement_screen001",
  });
  expect(() => parseCliArgs([
    "edit", "rec_example001", "overlay", "add", "--kind", "video", "--source", "/tmp/a.mp4",
    "--from", "0", "--to", "1s", "--animated-audio", "replace",
  ])).toThrow(/animated-audio/u);
});

test("parses local face analysis and first-class camera moves", () => {
  expect(parseCliArgs([
    "analyze", "faces", "project_example001",
    "--source", "asset_camera001:stream_camera001",
    "--sample-fps", "12", "--max-faces", "8", "--json",
  ])).toMatchObject({
    backend: "auto",
    json: true,
    kind: "analyze-faces",
    maxFaces: 8,
    sampleFps: 12,
  });
  expect(parseCliArgs([
    "faces", "list", "project_example001", "analysis_faces001",
    "--at", "2s", "--min-confidence", "0.75", "--limit", "4",
  ])).toMatchObject({
    analysis: "analysis_faces001",
    at: "2s",
    kind: "faces-list",
    limit: 4,
    minConfidence: 0.75,
  });
  expect(parseCliArgs([
    "project", "edit", "project_example001", "camera", "push",
    "--placement", "placement_camera001", "--stream", "stream_camera001",
    "--from", "1s", "--to", "4s", "--center", "0.55,0.42", "--end-zoom", "1.6",
  ])).toMatchObject({
    action: "push",
    center: [0.55, 0.42],
    endZoom: 1.6,
    kind: "project-camera-edit",
  });
  expect(parseCliArgs([
    "project", "edit", "project_example001", "camera", "reframe",
    "--placement", "placement_camera001", "--stream", "stream_camera001",
    "--from", "1s", "--to", "4s",
    "--from-frame", "0.5,0.5,1", "--to-frame", "0.65,0.4,2",
  ])).toMatchObject({
    action: "reframe",
    fromFrame: [0.5, 0.5, 1],
    kind: "project-camera-edit",
    toFrame: [0.65, 0.4, 2],
  });
  expect(parseCliArgs([
    "project", "edit", "project_example001", "camera", "path",
    "--placement", "placement_camera001", "--stream", "stream_camera001",
    "--keyframe", "1s,0.5,0.5,1",
    "--keyframe", "2.5s,0.6,0.45,1.4",
    "--keyframe", "4s,0.42,0.5,2",
  ])).toMatchObject({
    action: "path",
    keyframes: [
      { at: "1s", frame: [0.5, 0.5, 1] },
      { at: "2.5s", frame: [0.6, 0.45, 1.4] },
      { at: "4s", frame: [0.42, 0.5, 2] },
    ],
    kind: "project-camera-edit",
  });
  expect(() => parseCliArgs([
    "project", "edit", "project_example001", "camera", "path",
    "--placement", "placement_camera001", "--stream", "stream_camera001",
    "--keyframe", "1s,0.5,0.5,1",
  ])).toThrow(/between 2 and 4096/u);
  expect(parseCliArgs([
    "project", "edit", "project_example001", "camera", "follow-faces",
    "--placement", "placement_camera001", "--analysis", "analysis_faces001",
    "--from", "1s", "--to", "4s", "--track", "face_track0001", "--track", "face_track0002",
    "--framing", "group", "--gap-policy", "hold", "--require-all-selected",
  ])).toMatchObject({
    action: "follow-faces",
    framing: "group",
    kind: "project-camera-edit",
    requireAllSelected: true,
    tracks: ["face_track0001", "face_track0002"],
  });
  expect(() => parseCliArgs([
    "project", "edit", "project_example001", "camera", "follow-faces",
    "--placement", "placement_camera001", "--analysis", "analysis_faces001",
    "--from", "1s", "--to", "4s", "--track", "face_track0001", "--select", "all",
  ])).toThrow(/either one or more --track/u);
  expect(() => parseCliArgs([
    "project", "edit", "project_example001", "camera", "follow-faces",
    "--placement", "placement_camera001", "--analysis", "analysis_faces001",
    "--from", "1s", "--to", "4s", "--select", "largest", "--require-all-selected",
  ])).toThrow(/dynamic --select largest/u);
});

test("help and version do not require repository discovery", async () => {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd: () => "/",
    env: {},
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    platform: process.platform,
    stderr: (value) => { stderr += value; },
    stdout: (value) => { stdout += value; },
  };
  expect(await runCli(["--version"], { io, version: "test-version" })).toBe(0);
  expect(stdout).toBe("test-version\n");
  expect(stderr).toBe("");

  stdout = "";
  expect(await runCli(["help", "record"], { io })).toBe(0);
  expect(stdout).toContain("transmute record");
  expect(stderr).toBe("");
});

test("parses the canonical diagram and image operation commands", () => {
  expect(parseCliArgs(["diagram", "check", "ideas/system.diagram.json", "--json"]))
    .toEqual({
      json: true,
      kind: "diagram-check",
      path: "ideas/system.diagram.json",
    });
  expect(parseCliArgs([
    "diagram", "render", "ideas/system.diagram.json", "--scale", "3",
  ])).toEqual({
    json: false,
    kind: "diagram-render",
    path: "ideas/system.diagram.json",
    scale: 3,
  });
  expect(parseCliArgs([
    "image", "vectorize", "scraps/sketch.png",
    "--duotone", "#112233,#aabbcc",
    "--alpha-cutoff", "12",
    "--timeout-ms", "45000",
    "--json",
  ])).toEqual({
    alphaCutoff: 12,
    duotone: ["#112233", "#aabbcc"],
    inputPath: "scraps/sketch.png",
    json: true,
    kind: "image-vectorize",
    timeoutMs: 45_000,
  });
  expect(() => parseCliArgs([
    "image", "vectorize", "scraps/sketch.png", "--alpha-cutoff", "2.5",
  ])).toThrow(/positive integer/u);
  expect(commandHelp([])).toContain("diagram init|check|render");
  expect(commandHelp(["image"])).toContain("content hash");
});

test("global help and completion expose project rendering", () => {
  expect(commandHelp([])).toContain("project inspect|add|edit|render");
  expect(completions(["project", ""])).toContain("render");
});

test("parses the full Gateway media and local effect command surface", () => {
  expect(parseCliArgs([
    "ai", "models", "list", "--type", "video", "--provider", "xai", "--refresh", "--json",
  ])).toMatchObject({
    json: true,
    kind: "ai-models-list",
    modelType: "video",
    provider: "xai",
    refresh: true,
  });
  expect(parseCliArgs([
    "ai", "provider-options", "inspect", "/tmp/options.json", "--json",
  ])).toEqual({
    json: true,
    kind: "ai-provider-options-inspect",
    path: "/tmp/options.json",
  });
  expect(parseCliArgs([
    "ai", "image", "generate", "--model", "openai/gpt-image-1.5",
    "--prompt", "a precise diagram", "--image", "/tmp/reference.png",
    "--provider-options", "/tmp/options.json", "--allow-cloud-upload",
  ])).toMatchObject({
    allowCloudUpload: true,
    images: ["/tmp/reference.png"],
    kind: "ai-image-generate",
    providerOptions: "/tmp/options.json",
  });
  expect(parseCliArgs([
    "ai", "video", "generate", "--model", "google/veo-3.1-generate-001",
    "--prompt-file", "/tmp/prompt.txt", "--image", "/tmp/start.png",
    "--reference", "/tmp/style.png", "--reference", "/tmp/motion.mp4",
    "--duration", "8", "--fps", "24", "--resolution", "1920x1080",
    "--generate-audio", "true", "--allow-cloud-upload",
  ])).toMatchObject({
    durationSeconds: 8,
    fps: 24,
    frameImages: [],
    generateAudio: true,
    inputReferences: ["/tmp/style.png", "/tmp/motion.mp4"],
    kind: "ai-video-generate",
  });
  expect(parseCliArgs([
    "ai", "video", "generate", "--model", "google/veo-3.1-generate-001",
    "--frame", "first=/tmp/first.png", "--frame", "last=/tmp/last.png",
    "--allow-cloud-upload",
  ])).toMatchObject({
    frameImages: [
      { frameType: "first", path: "/tmp/first.png" },
      { frameType: "last", path: "/tmp/last.png" },
    ],
    inputReferences: [],
    kind: "ai-video-generate",
  });
  expect(parseCliArgs([
    "ai", "video", "generate", "--model", "alibaba/wan-v2.7-r2v",
    "--reference", "video/mp4=https://cdn.example/reference?id=42",
    "--allow-cloud-upload",
  ])).toMatchObject({
    inputReferences: ["video/mp4=https://cdn.example/reference?id=42"],
    kind: "ai-video-generate",
  });
  expect(parseCliArgs([
    "ai", "speech", "generate", "--model", "xai/grok-tts",
    "--text", "hello", "--voice", "eve", "--speed", "1.25",
  ])).toMatchObject({ kind: "ai-speech-generate", speed: 1.25, voice: "eve" });
  expect(parseCliArgs([
    "ai", "transcribe", "/tmp/interview.wav", "--model", "openai/whisper-1",
    "--allow-cloud-audio-upload", "--format", "srt",
  ])).toMatchObject({
    allowCloudAudioUpload: true,
    format: "srt",
    kind: "ai-transcribe",
  });
  expect(parseCliArgs([
    "media", "audio", "/tmp/raw.mov", "--volume-db", "-3", "--compressor",
    "--delay-ms", "180", "--reverb", "room", "--denoise", "--audio-stream", "2",
  ])).toMatchObject({
    compressor: true,
    audioStreamIndex: 2,
    delayMs: 180,
    denoise: true,
    kind: "media-audio",
    reverb: "room",
    volumeDb: -3,
  });
  expect(parseCliArgs([
    "media", "color", "/tmp/raw.mov", "--preset", "cinematic",
    "--temperature", "0.15", "--saturation", "0.9", "--video-stream", "1",
  ])).toMatchObject({
    kind: "media-color",
    preset: "cinematic",
    saturation: 0.9,
    temperature: 0.15,
    videoStreamIndex: 1,
  });
  expect(parseCliArgs([
    "media", "compose", "toro-verde.json",
    "--output", "trips/toro-verde.mp4", "--json",
  ])).toEqual({
    composition: "toro-verde.json",
    json: true,
    kind: "media-compose",
    output: "trips/toro-verde.mp4",
  });
  expect(completions(["media", ""])).toEqual(["audio", "color", "compose"]);

  expect(() => parseCliArgs([
    "ai", "video", "generate", "--model", "xai/grok-imagine-video",
  ])).toThrow(/requires a prompt, --image, --frame, or --reference/u);
  expect(() => parseCliArgs([
    "ai", "models", "list", "--limit", "501",
  ])).toThrow(/at most 500/u);
  expect(() => parseCliArgs([
    "ai", "video", "generate", "--model", "xai/grok-imagine-video",
    "--prompt", "test", "--frame", "middle=/tmp/frame.png",
  ])).toThrow(/first=<path-or-https-url> or last=<path-or-https-url>/u);
  expect(() => parseCliArgs([
    "ai", "video", "generate", "--model", "google/veo",
    "--frame", "first=/tmp/frame.png", "--reference", "/tmp/style.png",
  ])).toThrow(/mutually exclusive/u);
  expect(() => parseCliArgs([
    "media", "audio", "input.wav", "--volume-db", "-1",
    "--delay-mix", "0.5",
  ])).toThrow(/require --delay-ms/u);
  expect(() => parseCliArgs([
    "media", "audio", "input.wav", "--volume-db", "-1",
    "--reverb-wet", "0.5",
  ])).toThrow(/requires --reverb/u);
  expect(() => parseCliArgs([
    "ai", "video", "generate", "--model", "google/veo",
    "--image", "/tmp/image.png", "--frame", "first=/tmp/frame.png",
  ])).toThrow(/mutually exclusive/u);
  expect(() => parseCliArgs(["media", "audio", "/tmp/raw.mov"]))
    .toThrow(/At least one audio effect/u);
});

test("event queries enforce their bounded agent-output limit", () => {
  expect(parseCliArgs([
    "events", "rec_example001", "--kind", "cursor.sample", "--limit", "10000",
  ])).toMatchObject({ kind: "events", limit: 10_000 });
  expect(() => parseCliArgs([
    "events", "rec_example001", "--kind", "cursor.sample", "--limit", "10001",
  ])).toThrow("--limit cannot exceed 10000");
});

test("project render rejects dimensions that libx264 yuv420p cannot encode", () => {
  expect(parseCliArgs([
    "project", "render", "run", "project_example001", "--width", "320", "--height", "240",
  ])).toMatchObject({ height: 240, kind: "project-render", width: 320 });
  expect(() => parseCliArgs([
    "project", "render", "run", "project_example001", "--width", "321", "--height", "241",
  ])).toThrow(/even positive integer/u);
});
