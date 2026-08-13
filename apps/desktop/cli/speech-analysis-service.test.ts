import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  MusicAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
  type BundleFileSystem,
} from "../core";
import { resolveAudioAnalysisSubject } from "./audio-analysis";
import type { ProcessRunner, RunResult } from "./io";
import {
  buildWhisperCppSpeechArgv,
  loadLatestMusicProtectionAnalysis,
  parseWhisperCppWordJson,
  persistSpeechAnalysis,
  runLocalSpeechAnalysis,
  type LocalSpeechAnalysisConfig,
} from "./speech-analysis-service";

const NOW = "2026-07-22T12:00:00.000Z";
const HASH = "a".repeat(64);
const MEDIA_CONTENT = "media";
const MEDIA_SHA256 = sha256Hex(MEDIA_CONTENT);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory =>
    await rm(directory, { force: true, recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "transmute-speech-analysis-"));
  temporaryDirectories.push(path);
  return path;
}

function baseProject(): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_dialogue0001",
      createdAt: NOW,
      durationUs: 3_000_000,
      label: "Dialogue",
      role: "dialogue",
      source: {
        importedAt: NOW,
        kind: "imported",
        originalName: "dialogue.mov",
        sourceSha256: MEDIA_SHA256,
      },
      streams: [{
        channels: 2,
        kind: "audio",
        label: "Dialogue audio",
        role: "dialogue",
        sampleRateHz: 48_000,
        segments: [{
          assetRange: { endUs: 3_000_000, startUs: 0 },
          bytes: Buffer.byteLength(MEDIA_CONTENT),
          codec: "aac",
          container: "mov",
          fileRange: { endUs: 3_000_000, startUs: 0 },
          path: "media/dialogue.mov",
          sha256: MEDIA_SHA256,
          streamIndex: 1,
        }],
        streamId: "stream_dialogue001",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Dialogue edit",
    placements: [{
      assetId: "asset_dialogue0001",
      assetRange: { endUs: 3_000_000, startUs: 0 },
      audio: [{
        presentation: { enabled: true, gainDb: 0, pan: 0 },
        streamId: "stream_dialogue001",
      }],
      enabled: true,
      placementId: "placement_dialogue01",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 3_000_000, projectTimeUs: 3_000_000 },
        ],
        provenance: { kind: "identity" },
      },
      video: [],
    }],
    projectId: "project_dialogue001",
    referencePlacementId: "placement_dialogue01",
    schemaVersion: 1,
    timeline: { durationUs: 3_000_000, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

function config(): LocalSpeechAnalysisConfig {
  return {
    language: "en-US",
    minimumFillerConfidence: 0.7,
    processors: 1,
    speechHandleUs: 100_000,
    threads: 4,
    useGpu: false,
  };
}

function whisperOutput(): unknown {
  return {
    result: { language: "en" },
    transcription: [
      {
        offsets: { from: 0, to: 500 },
        text: " Hello",
        tokens: [{ p: 0.98, text: " Hello" }],
      },
      {
        offsets: { from: 1_000, to: 1_200 },
        text: " um",
        tokens: [
          { p: 1, text: "[_BEG_]" },
          { p: 0.99, text: " um" },
        ],
      },
      {
        offsets: { from: 1_600, to: 2_200 },
        text: " world",
        tokens: [{ p: 0.97, text: " world" }],
      },
    ],
  };
}

class MemoryBundleFileSystem implements BundleFileSystem {
  readonly values = new Map<string, string>();

  readText(path: string): Promise<string> {
    const value = this.values.get(path);
    if (value === undefined) return Promise.reject(new Error(`missing ${path}`));
    return Promise.resolve(value);
  }

  writeTextAtomic(path: string, contents: string): Promise<void> {
    this.values.set(path, contents);
    return Promise.resolve();
  }
}

class SpeechRunner implements ProcessRunner {
  readonly calls: readonly string[][] = [];
  decodedSamples = 48_000;
  workDirectory: string | null = null;
  whisperExitCode = 0;
  whisperJson: unknown = whisperOutput();

  async run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    (this.calls as string[][]).push([...argv]);
    if (argv[0] === "ffmpeg") {
      const dataBytes = this.decodedSamples * 2;
      const wav = Buffer.alloc(44 + dataBytes);
      wav.write("RIFF", 0, "ascii");
      wav.writeUInt32LE(wav.byteLength - 8, 4);
      wav.write("WAVE", 8, "ascii");
      wav.write("fmt ", 12, "ascii");
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16_000, 24);
      wav.writeUInt32LE(32_000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36, "ascii");
      wav.writeUInt32LE(dataBytes, 40);
      await writeFile(argv.at(-1)!, wav);
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    const prefixIndex = argv.indexOf("--output-file") + 1;
    const prefix = argv[prefixIndex]!;
    this.workDirectory = dirname(prefix);
    if (this.whisperExitCode === 0) await writeFile(`${prefix}.json`, JSON.stringify(this.whisperJson));
    return { exitCode: this.whisperExitCode, stderr: this.whisperExitCode === 0 ? "" : "failed", stdout: "" };
  }
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function projectWithMusic(
  project: VideoProjectV1,
  fileSystem: MemoryBundleFileSystem,
): VideoProjectV1 {
  const subject = resolveAudioAnalysisSubject(project, "asset_dialogue0001:stream_dialogue001").subject;
  const analysis = MusicAnalysisV1Schema.parse({
    analysisId: "analysis_musicnew001",
    config: {
      hopSize: 256,
      minimumMusicUs: 500_000,
      sampleRateHz: 8_000,
      tempoWindowUs: 2_000_000,
      windowSize: 1_024,
    },
    createdAt: NOW,
    durationUs: 3_000_000,
    inputDigest: HASH,
    keyRegions: [],
    kind: "studio.music-analysis",
    musicRegions: [{ confidence: 0.95, range: { endUs: 1_300_000, startUs: 900_000 } }],
    schemaVersion: 1,
    subject,
    tempoRegions: [],
    tool: { name: "studio", profile: "music-v1", version: "0.1.0" },
  });
  const path = "analysis/music/analysis_musicnew001.json";
  const contents = `${canonicalJson(analysis)}\n`;
  fileSystem.values.set(path, contents);
  const reference = ProjectAnalysisReferenceSchema.parse({
    analysisId: analysis.analysisId,
    assetId: subject.assetId,
    createdAt: analysis.createdAt,
    keyRegions: 0,
    kind: "music",
    musicRegions: 1,
    path,
    sha256: sha256Hex(contents),
    streamId: subject.streamId,
    tempoRegions: 0,
  });
  return VideoProjectV1Schema.parse({ ...project, analyses: [reference] });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise rejection.");
}

describe("whisper.cpp speech adapter", () => {
  test("builds a direct argv with forced word-level JSON options", () => {
    const argv = buildWhisperCppSpeechArgv({
      config: config(),
      inputWavPath: "/tmp/input with spaces.wav",
      outputPrefix: "/tmp/out;still-one-argument",
      runtime: { executable: "/tools/whisper-cli", modelPath: "/models/model.bin", version: "1.8.0" },
    });
    expect(argv).toEqual([
      "/tools/whisper-cli",
      "--model", "/models/model.bin",
      "--file", "/tmp/input with spaces.wav",
      "--language", "en",
      "--threads", "4",
      "--processors", "1",
      "--no-gpu",
      "--split-on-word",
      "--max-len", "1",
      "--output-json-full",
      "--output-file", "/tmp/out;still-one-argument",
      "--no-prints",
    ]);
    expect(() => buildWhisperCppSpeechArgv({
      config: { ...config(), language: "en --output-file /tmp/leak" },
      inputWavPath: "/tmp/in.wav",
      outputPrefix: "/tmp/out",
      runtime: { executable: "whisper-cli", modelPath: "/m", version: "1" },
    })).toThrow(/language/u);
  });

  test("parses strict one-word segments and rejects coarse segment timestamps", () => {
    expect(parseWhisperCppWordJson(whisperOutput(), 3_000_000)).toEqual({
      detectedLanguage: "en",
      words: [
        { confidence: 0.98, range: { endUs: 500_000, startUs: 0 }, speaker: null, text: "Hello" },
        { confidence: 0.99, range: { endUs: 1_200_000, startUs: 1_000_000 }, speaker: null, text: "um" },
        { confidence: 0.97, range: { endUs: 2_200_000, startUs: 1_600_000 }, speaker: null, text: "world" },
      ],
    });
    expect(() => parseWhisperCppWordJson({
      result: { language: "en" },
      transcription: [{
        offsets: { from: 0, to: 1_000 },
        text: "two words",
        tokens: [{ p: 0.9, text: " two" }, { p: 0.9, text: " words" }],
      }],
    }, 3_000_000)).toThrow(/word timestamps are unavailable.*not one word/u);
    expect(() => parseWhisperCppWordJson({
      result: { language: "en" },
      transcription: [{ offsets: { from: 0, to: 1_000 }, text: "word", tokens: [] }],
    }, 3_000_000)).toThrow(/no matching token probability/u);
  });
});

describe("local project speech analysis", () => {
  test("uses latest same-stream music protection, persists a reference, and cleans temporary media", async () => {
    const repositoryRoot = await temporaryDirectory();
    await mkdir(join(repositoryRoot, "media"));
    await writeFile(join(repositoryRoot, "media", "dialogue.mov"), MEDIA_CONTENT);
    const projectDirectory = join(repositoryRoot, "artifacts", "project_dialogue001");
    const fileSystem = new MemoryBundleFileSystem();
    const project = projectWithMusic(baseProject(), fileSystem);
    const selected = resolveAudioAnalysisSubject(project, "asset_dialogue0001:stream_dialogue001");
    const loaded = await loadLatestMusicProtectionAnalysis({ fileSystem, project, subject: selected.subject });
    expect(String(loaded?.analysis.analysisId)).toBe("analysis_musicnew001");

    const runner = new SpeechRunner();
    const result = await runLocalSpeechAnalysis({
      analysisId: "analysis_speech0001",
      config: config(),
      ffmpeg: "ffmpeg",
      fileSystem,
      now: new Date(NOW),
      project,
      projectDirectory,
      repositoryRoot,
      runner,
      runtime: { executable: "/tools/whisper-cli", modelPath: "/models/ggml.bin", version: "1.8.0" },
      source: "asset_dialogue0001:stream_dialogue001",
      useLatestMusicAnalysis: true,
    });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.[0]).toBe("ffmpeg");
    expect(runner.calls[0]?.join(" ")).toContain("[0:1]atrim");
    expect(runner.calls[1]?.[0]).toBe("/tools/whisper-cli");
    expect(result.musicAnalysisId).toBe("analysis_musicnew001");
    expect(result.analysis.kind).toBe("transmute.speech-analysis");
    expect(result.analysis.result.status).toBe("transcribed");
    if (result.analysis.result.status !== "transcribed") throw new Error("expected transcript");
    expect(result.analysis.result.fillers).toHaveLength(1);
    expect(result.analysis.result.fillers[0]).toMatchObject({
      autoApplicable: false,
      musicProtected: true,
      recommendedCut: null,
      text: "um",
    });
    expect(result.reference).toMatchObject({ fillerCount: 1, kind: "speech", wordCount: 3 });
    expect(runner.workDirectory).not.toBeNull();
    expect(await missing(runner.workDirectory!)).toBe(true);

    const nextProject = await persistSpeechAnalysis({ fileSystem, project, result });
    expect(nextProject.analyses.map(reference => reference.kind)).toEqual(["music", "speech"]);
    expect(fileSystem.values.has(result.analysisPath)).toBe(true);
    expect(JSON.parse(fileSystem.values.get(result.analysisPath)!) as unknown).toEqual(result.analysis);
    expect(JSON.parse(fileSystem.values.get("project.json")!) as unknown).toEqual(nextProject);
  });

  test("cleans the work directory when whisper.cpp exits unsuccessfully", async () => {
    const repositoryRoot = await temporaryDirectory();
    await mkdir(join(repositoryRoot, "media"));
    await writeFile(join(repositoryRoot, "media", "dialogue.mov"), MEDIA_CONTENT);
    const runner = new SpeechRunner();
    runner.whisperExitCode = 9;
    const error = await rejection(runLocalSpeechAnalysis({
      config: config(),
      ffmpeg: "ffmpeg",
      now: new Date(NOW),
      project: baseProject(),
      projectDirectory: join(repositoryRoot, "artifacts", "project_dialogue001"),
      repositoryRoot,
      runner,
      runtime: { executable: "whisper-cli", modelPath: "/models/ggml.bin", version: "1.8.0" },
      source: "asset_dialogue0001:stream_dialogue001",
    }));
    expect(error).toMatchObject({ code: "subprocess" });
    expect(runner.workDirectory).not.toBeNull();
    expect(await missing(runner.workDirectory!)).toBe(true);
  });

  test("rejects a truncated successful decode before invoking Whisper", async () => {
    const repositoryRoot = await temporaryDirectory();
    await mkdir(join(repositoryRoot, "media"));
    await writeFile(join(repositoryRoot, "media", "dialogue.mov"), MEDIA_CONTENT);
    const runner = new SpeechRunner();
    runner.decodedSamples = 1;

    const error = await rejection(runLocalSpeechAnalysis({
      config: config(),
      ffmpeg: "ffmpeg",
      now: new Date(NOW),
      project: baseProject(),
      projectDirectory: join(repositoryRoot, "artifacts", "project_dialogue001"),
      repositoryRoot,
      runner,
      runtime: { executable: "whisper-cli", modelPath: "/models/ggml.bin", version: "1.8.0" },
      source: "asset_dialogue0001:stream_dialogue001",
    }));

    expect(error).toMatchObject({ code: "invalid-data" });
    expect(String(error)).toContain("incomplete PCM timeline coverage");
    expect(runner.calls).toHaveLength(1);
  });

  test("rejects stale music protection instead of silently enabling filler cuts", async () => {
    const fileSystem = new MemoryBundleFileSystem();
    const project = projectWithMusic(baseProject(), fileSystem);
    const selected = resolveAudioAnalysisSubject(project, "asset_dialogue0001:stream_dialogue001");
    const altered = {
      ...selected.subject,
      integritySha256: canonicalJsonSha256("different media"),
    };
    expect(await rejection(loadLatestMusicProtectionAnalysis({ fileSystem, project, subject: altered })))
      .toMatchObject({ code: "conflict" });
  });
});
