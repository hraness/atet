import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const captureDirectory = import.meta.dir;
const outputDirectory = join(captureDirectory, "dist");
const cacheDirectory = join(outputDirectory, "cache");
const infoPlistPath = join(captureDirectory, "Info.plist");
const captureHelperIdentifier = "com.hraness.transmute.capture";
export const captureHelperExecutablePath = join(outputDirectory, "transmute-capture");

export function resolveCaptureHelperPath(): string {
  return captureHelperExecutablePath;
}

const deploymentTarget = "15.0";
const frameworks = [
  "Foundation",
  "AppKit",
  "ApplicationServices",
  "AVFoundation",
  "AudioToolbox",
  "CoreGraphics",
  "CoreMedia",
  "ScreenCaptureKit",
] as const;

type Toolchain = Readonly<{
  sdkPath: string;
  swiftCompiler: string;
  swiftVersion: string;
  target: string;
  xcrun: string;
}>;

type BuildResult = Readonly<{
  cached: boolean;
  hash: string;
  path: string;
  swiftVersion: string;
  target: string;
}>;

export type CaptureSegmentCloseGateHarnessResult = Readonly<{
  stderr: string;
  stdout: string;
}>;

export type CaptureControllerFinalizationHarnessResult = Readonly<{
  stderr: string;
  stdout: string;
}>;

function targetTriple(): string {
  if (process.arch === "arm64") return `arm64-apple-macosx${deploymentTarget}`;
  if (process.arch === "x64") return `x86_64-apple-macosx${deploymentTarget}`;
  throw new Error(`Unsupported macOS capture architecture: ${process.arch}`);
}

async function commandOutput(command: readonly string[]): Promise<string> {
  const processHandle = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

export async function discoverCaptureToolchain(): Promise<Toolchain> {
  if (process.platform !== "darwin") {
    throw new Error("The native capture helper requires macOS 15 or newer.");
  }
  const xcrun = Bun.which("xcrun") ?? "/usr/bin/xcrun";
  try {
    const info = await stat(xcrun);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new Error("xcrun was not found; install the Xcode command-line tools.");
  }
  const [swiftCompiler, sdkPath, swiftVersion, osVersion] = await Promise.all([
    commandOutput([xcrun, "--sdk", "macosx", "--find", "swiftc"]),
    commandOutput([xcrun, "--sdk", "macosx", "--show-sdk-path"]),
    commandOutput([xcrun, "swiftc", "--version"]),
    commandOutput(["/usr/bin/sw_vers", "-productVersion"]),
  ]);
  const major = Number.parseInt(osVersion.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 15) {
    throw new Error(`The native capture helper requires macOS 15 or newer; found ${osVersion}.`);
  }
  return { sdkPath, swiftCompiler, swiftVersion, target: targetTriple(), xcrun };
}

async function swiftSources(): Promise<readonly string[]> {
  const entries = await readdir(captureDirectory, { withFileTypes: true });
  const sources = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
    .map((entry) => join(captureDirectory, entry.name))
    .sort();
  if (sources.length === 0) throw new Error("No Swift capture sources were found.");
  return sources;
}

function compilerArguments(toolchain: Toolchain, sources: readonly string[]): string[] {
  return [
    "-parse-as-library",
    "-swift-version", "5",
    "-target", toolchain.target,
    "-sdk", toolchain.sdkPath,
    ...frameworks.flatMap((framework) => ["-framework", framework]),
    ...sources,
  ];
}

function embeddedPlistArguments(): string[] {
  return [
    "-Xlinker", "-sectcreate",
    "-Xlinker", "__TEXT",
    "-Xlinker", "__info_plist",
    "-Xlinker", infoPlistPath,
  ];
}

async function sourceHash(toolchain: Toolchain, sources: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  hash.update("transmute-capture-build-v2\0");
  hash.update(toolchain.swiftCompiler);
  hash.update("\0");
  hash.update(toolchain.swiftVersion);
  hash.update("\0");
  hash.update(toolchain.sdkPath);
  hash.update("\0");
  hash.update(toolchain.target);
  hash.update("\0");
  hash.update(frameworks.join("\0"));
  hash.update("\0Info.plist\0");
  hash.update(new Uint8Array(await Bun.file(infoPlistPath).arrayBuffer()));
  for (const source of sources) {
    hash.update("\0");
    hash.update(source.slice(captureDirectory.length));
    hash.update("\0");
    hash.update(new Uint8Array(await Bun.file(source).arrayBuffer()));
  }
  return hash.digest("hex");
}

async function runChecked(command: readonly string[]): Promise<{ stderr: string; stdout: string }> {
  const processHandle = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  return { stderr, stdout };
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteCount += result.value.byteLength;
      if (byteCount > maximumBytes) {
        throw new Error(`${label} exceeded the ${maximumBytes}-byte harness output limit.`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

async function runBoundedCommand(
  command: readonly string[],
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<CaptureSegmentCloseGateHarnessResult> {
  const processHandle = Bun.spawn([...command], {
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = processHandle.exited;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${command[0]} exceeded the ${timeoutMs}-millisecond harness time limit.`));
    }, timeoutMs);
  });
  const completion = Promise.all([
    exit,
    readBoundedOutput(processHandle.stdout, maximumOutputBytes, "stdout"),
    readBoundedOutput(processHandle.stderr, maximumOutputBytes, "stderr"),
  ]);
  void completion.catch(() => {});

  const groupExists = (): boolean => {
    try {
      process.kill(-processHandle.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-processHandle.pid, signal);
      return;
    } catch {
      // A platform without detached process-group signaling still gets a
      // direct-child termination attempt.
    }
    try {
      processHandle.kill(signal);
    } catch {
      // The child may have exited between observation and signaling.
    }
  };
  const waitForGroupExit = async (maximumWaitMs: number): Promise<boolean> => {
    const deadline = performance.now() + maximumWaitMs;
    while (groupExists()) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, remainingMs));
      });
    }
    return true;
  };
  const terminateProcessGroup = async (): Promise<void> => {
    if (!groupExists()) return;
    signalGroup("SIGTERM");
    if (await waitForGroupExit(100)) return;
    signalGroup("SIGKILL");
    await waitForGroupExit(250);
  };

  let result: [number, string, string];
  try {
    result = await Promise.race([
      completion,
      timeoutFailure,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await terminateProcessGroup();
  }
  const [exitCode, stdout, stderr] = result;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return { stderr, stdout };
}

export async function runCaptureSegmentCloseGateHarness(
  harnessSource: string,
): Promise<CaptureSegmentCloseGateHarnessResult> {
  const maximumHarnessSourceBytes = 256 * 1024;
  if (
    harnessSource.length === 0
    || new TextEncoder().encode(harnessSource).byteLength > maximumHarnessSourceBytes
    || !harnessSource.includes("@main")
  ) {
    throw new Error("Capture close-gate harness must be a bounded Swift @main source.");
  }
  const toolchain = await discoverCaptureToolchain();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "transmute-capture-close-gate-"));
  const harnessPath = join(temporaryDirectory, "Harness.swift");
  const executablePath = join(temporaryDirectory, "capture-close-gate-harness");
  const productionSources = [
    "Protocol.swift",
    "Timeline.swift",
    "CaptureInterruption.swift",
    "CaptureSegmentCloseGate.swift",
  ].map((name) => join(captureDirectory, name));
  try {
    await writeFile(harnessPath, harnessSource, { encoding: "utf8", mode: 0o600 });
    await runBoundedCommand(
      [
        toolchain.swiftCompiler,
        ...compilerArguments(toolchain, [...productionSources, harnessPath]),
        "-o", executablePath,
      ],
      30_000,
      128 * 1024,
    );
    return await runBoundedCommand([executablePath], 10_000, 128 * 1024);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function runCaptureControllerFinalizationHarness(
  harnessSource: string,
): Promise<CaptureControllerFinalizationHarnessResult> {
  const maximumHarnessSourceBytes = 256 * 1024;
  if (
    harnessSource.length === 0
    || new TextEncoder().encode(harnessSource).byteLength > maximumHarnessSourceBytes
    || !harnessSource.includes("@main")
  ) {
    throw new Error("Capture finalization harness must be a bounded Swift @main source.");
  }
  const toolchain = await discoverCaptureToolchain();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "transmute-capture-finalization-"));
  const harnessPath = join(temporaryDirectory, "Harness.swift");
  const executablePath = join(temporaryDirectory, "capture-finalization-harness");
  const productionSources = [
    "Protocol.swift",
    "Timeline.swift",
    "CaptureInterruption.swift",
    "CaptureInterruptionReporter.swift",
    "CaptureAVInterruptionMonitor.swift",
    "CaptureDisplayInterruptionMonitor.swift",
    "CaptureSegmentCloseGate.swift",
    "CaptureSingleFlight.swift",
    "CaptureControllerFinalization.swift",
    "CaptureControllerStartCoordinator.swift",
  ].map((name) => join(captureDirectory, name));
  try {
    await writeFile(harnessPath, harnessSource, { encoding: "utf8", mode: 0o600 });
    await runBoundedCommand(
      [
        toolchain.swiftCompiler,
        "-parse-as-library",
        "-swift-version", "5",
        "-strict-concurrency=complete",
        "-warn-concurrency",
        "-warnings-as-errors",
        "-target", toolchain.target,
        "-sdk", toolchain.sdkPath,
        "-framework", "AVFoundation",
        "-framework", "CoreGraphics",
        ...productionSources,
        harnessPath,
        "-o", executablePath,
      ],
      60_000,
      128 * 1024,
    );
    return await runBoundedCommand([executablePath], 10_000, 128 * 1024);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function verifyCaptureHelperIdentity(path = captureHelperExecutablePath): Promise<void> {
  await runChecked(["/usr/bin/codesign", "--verify", "--strict", path]);
  const signature = await runChecked(["/usr/bin/codesign", "-d", "--verbose=4", path]);
  const signatureText = `${signature.stdout}\n${signature.stderr}`;
  if (!signatureText.includes(`Identifier=${captureHelperIdentifier}`)) {
    throw new Error("Capture helper code signature has an unstable identifier.");
  }
  const section = await runChecked(["/usr/bin/otool", "-X", "-s", "__TEXT", "__info_plist", path]);
  const hex = section.stdout.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/u).slice(1);
    return fields.flatMap((word) => {
      const bytes = word.match(/[0-9a-f]{2}/gu);
      return bytes === null ? [] : [bytes.reverse().join("")];
    });
  }).join("");
  const plist = Buffer.from(hex, "hex").toString("utf8").replaceAll("\0", "");
  const requiredValues = [
    captureHelperIdentifier,
    "LSMinimumSystemVersion",
    "NSAudioCaptureUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSScreenCaptureUsageDescription",
  ] as const;
  for (const required of requiredValues) {
    if (!plist.includes(required)) throw new Error(`Capture helper embedded Info.plist omits ${required}.`);
  }
}

async function signCaptureHelper(path: string): Promise<void> {
  await runChecked([
    "/usr/bin/codesign",
    "--force",
    "--identifier", captureHelperIdentifier,
    "--sign", "-",
    "--timestamp=none",
    path,
  ]);
  await verifyCaptureHelperIdentity(path);
}

async function runCompiler(command: readonly string[], environment: Record<string, string | undefined>): Promise<void> {
  const processHandle = Bun.spawn([...command], {
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error(`Swift capture compilation failed with exit code ${exitCode}.`);
}

export async function checkCaptureHelper(): Promise<BuildResult> {
  const toolchain = await discoverCaptureToolchain();
  const sources = await swiftSources();
  const hash = await sourceHash(toolchain, sources);
  await runCompiler(
    [toolchain.swiftCompiler, ...compilerArguments(toolchain, sources), "-typecheck"],
    { ...process.env, MACOSX_DEPLOYMENT_TARGET: deploymentTarget },
  );
  return {
    cached: false,
    hash,
    path: captureHelperExecutablePath,
    swiftVersion: toolchain.swiftVersion.split("\n")[0] ?? toolchain.swiftVersion,
    target: toolchain.target,
  };
}

async function installStableExecutable(cachedExecutable: string): Promise<void> {
  const temporary = join(outputDirectory, `.transmute-capture.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await copyFile(cachedExecutable, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, captureHelperExecutablePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function buildCaptureHelper(): Promise<BuildResult> {
  const toolchain = await discoverCaptureToolchain();
  const sources = await swiftSources();
  const hash = await sourceHash(toolchain, sources);
  const hashedDirectory = join(cacheDirectory, hash);
  const cachedExecutable = join(hashedDirectory, "transmute-capture");
  await mkdir(hashedDirectory, { recursive: true });
  let cached = true;
  try {
    const info = await stat(cachedExecutable);
    cached = info.isFile();
  } catch {
    cached = false;
  }
  if (!cached) {
    const temporary = join(hashedDirectory, `.transmute-capture.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await runCompiler(
        [
          toolchain.swiftCompiler,
          ...compilerArguments(toolchain, sources),
          ...embeddedPlistArguments(),
          "-O",
          "-whole-module-optimization",
          "-o", temporary,
        ],
        { ...process.env, MACOSX_DEPLOYMENT_TARGET: deploymentTarget },
      );
      await chmod(temporary, 0o755);
      await rename(temporary, cachedExecutable);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await installStableExecutable(cachedExecutable);
  await signCaptureHelper(captureHelperExecutablePath);
  return {
    cached,
    hash,
    path: captureHelperExecutablePath,
    swiftVersion: toolchain.swiftVersion.split("\n")[0] ?? toolchain.swiftVersion,
    target: toolchain.target,
  };
}

function parseArguments(arguments_: readonly string[]): { check: boolean; json: boolean } {
  const known = new Set(["--check", "--json"]);
  const unknown = arguments_.filter((argument) => !known.has(argument));
  if (unknown.length > 0) throw new Error(`Unknown capture build argument: ${unknown.join(", ")}`);
  return { check: arguments_.includes("--check"), json: arguments_.includes("--json") };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const result = arguments_.check ? await checkCaptureHelper() : await buildCaptureHelper();
  if (arguments_.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (arguments_.check) {
    process.stdout.write(`Capture helper typecheck passed for ${result.target}.\n`);
  } else {
    process.stdout.write(`${result.path}\n`);
  }
}

if (import.meta.main) {
  await main();
}
