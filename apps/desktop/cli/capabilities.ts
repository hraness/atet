import { stat } from "node:fs/promises";
import { join } from "node:path";
import { assertSupportedHtmlOverlayBrowserExecutablePath } from "../application/html-overlay-browser-runtime";
import type { ApplicationCapabilityName } from "../application/context";
import type { ProcessRunner } from "./io";

export type CapabilityName = ApplicationCapabilityName;

export interface Capability {
  readonly available: boolean;
  readonly command: string | undefined;
  readonly name: CapabilityName;
  readonly reason: string | undefined;
  readonly version: string | undefined;
}

interface ProbeDefinition {
  readonly candidates: readonly string[];
  readonly name: CapabilityName;
  readonly versionArguments: readonly string[];
}

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/u).map((item) => item.trim()).find((item) => item !== "");
  return line === undefined ? undefined : line.slice(0, 300);
}

async function executableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function probe(
  runner: ProcessRunner,
  definition: ProbeDefinition,
  signal?: AbortSignal,
  inheritedFileDescriptors?: readonly number[],
): Promise<Capability> {
  const failures: string[] = [];
  for (const candidate of [...new Set(definition.candidates)]) {
    signal?.throwIfAborted();
    if (candidate.includes("/") && !await executableFile(candidate)) continue;
    const result = await runner.run(
      [candidate, ...definition.versionArguments],
      {
        ...(signal === undefined ? {} : { abortSignal: signal }),
        ...(inheritedFileDescriptors === undefined
          ? {}
          : { inheritedFileDescriptors }),
        maxOutputBytes: 32_000,
      },
    );
    signal?.throwIfAborted();
    if (result.exitCode === 0) {
      if (definition.name === "html-browser") {
        const executable = candidate.includes("/")
          ? candidate
          : Bun.which(candidate);
        if (executable === null) continue;
        try {
          await assertSupportedHtmlOverlayBrowserExecutablePath(
            executable,
            signal,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${candidate}: ${message.slice(0, 300)}`);
          continue;
        }
      }
      return {
        available: true,
        command: candidate,
        name: definition.name,
        reason: undefined,
        version: firstLine(result.stdout) ?? firstLine(result.stderr),
      };
    }
    const failure = firstLine(result.stderr) ?? firstLine(result.stdout);
    if (failure !== undefined) failures.push(`${candidate}: ${failure}`);
  }
  return {
    available: false,
    command: undefined,
    name: definition.name,
    reason: failures.at(-1) ?? "No candidate executable was found.",
    version: undefined,
  };
}

export function capabilityCandidates(
  desktopRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly ProbeDefinition[] {
  const captureCandidates = [
    env.TRANSMUTE_CAPTURE_HELPER,
    "transmute-capture",
    join(desktopRoot, "capture", "dist", "transmute-capture"),
    join(desktopRoot, "capture", ".build", "release", "transmute-capture"),
    join(desktopRoot, "capture", ".build", "debug", "transmute-capture"),
    join(desktopRoot, "dist", "transmute-capture"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "");
  const faceAnalyzerCandidates = [
    env.TRANSMUTE_FACE_ANALYZER,
    "transmute-face-analyzer",
    join(desktopRoot, "analysis", "dist", "transmute-face-analyzer"),
    join(desktopRoot, "dist", "transmute-face-analyzer"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "");
  const htmlBrowserCandidates = [
    env.TRANSMUTE_HTML_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "");
  return [
    {
      candidates: ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg"],
      name: "ffmpeg",
      versionArguments: ["-version"],
    },
    {
      candidates: ["ffprobe", "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/local/bin/ffprobe"],
      name: "ffprobe",
      versionArguments: ["-version"],
    },
    {
      candidates: [
        "rsvg-convert",
        "/opt/homebrew/bin/rsvg-convert",
        "/usr/local/bin/rsvg-convert",
        "/opt/local/bin/rsvg-convert",
      ],
      name: "rsvg-convert",
      versionArguments: ["--version"],
    },
    {
      candidates: [
        env.TRANSMUTE_WHISPER_CPP,
        "whisper-cli",
        "whisper-cpp",
        "/opt/homebrew/bin/whisper-cli",
        "/usr/local/bin/whisper-cli",
      ].filter((candidate): candidate is string => candidate !== undefined && candidate !== ""),
      name: "whisper-cpp",
      versionArguments: ["--help"],
    },
    {
      candidates: captureCandidates,
      name: "capture-helper",
      versionArguments: ["--version"],
    },
    {
      candidates: faceAnalyzerCandidates,
      name: "face-analyzer",
      versionArguments: ["--version"],
    },
    {
      candidates: htmlBrowserCandidates,
      name: "html-browser",
      versionArguments: ["--version"],
    },
  ];
}

export async function probeCapabilities(
  runner: ProcessRunner,
  desktopRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
  inheritedFileDescriptors?: readonly number[],
): Promise<readonly Capability[]> {
  return await Promise.all(capabilityCandidates(desktopRoot, env).map(async (definition) =>
    await probe(runner, definition, signal, inheritedFileDescriptors)
  ));
}

export async function probeCapability(
  runner: ProcessRunner,
  desktopRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  name: CapabilityName,
  signal?: AbortSignal,
  inheritedFileDescriptors?: readonly number[],
): Promise<Capability> {
  const definition = capabilityCandidates(desktopRoot, env)
    .find(candidate => candidate.name === name);
  if (definition === undefined) {
    return {
      available: false,
      command: undefined,
      name,
      reason: "Capability has no probe definition.",
      version: undefined,
    };
  }
  return await probe(runner, definition, signal, inheritedFileDescriptors);
}

export function capabilityByName(
  capabilities: readonly Capability[],
  name: CapabilityName,
): Capability {
  return capabilities.find((capability) => capability.name === name) ?? {
    available: false,
    command: undefined,
    name,
    reason: "Capability was not probed.",
    version: undefined,
  };
}
