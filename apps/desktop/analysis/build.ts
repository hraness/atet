import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const analysisDirectory = import.meta.dir;
const outputDirectory = join(analysisDirectory, "dist");
const cacheDirectory = join(outputDirectory, "cache");
const helperIdentifier = "com.hraness.transmute.face-analyzer";
const deploymentTarget = "15.0";
const buildRecipeVersion = "transmute-face-analyzer-build-v1";

export const faceAnalyzerExecutablePath = join(outputDirectory, "transmute-face-analyzer");

const frameworks = [
  "Foundation",
  "AVFoundation",
  "CoreGraphics",
  "CoreMedia",
  "CoreVideo",
  "ImageIO",
  "Vision",
] as const;

interface Toolchain {
  readonly sdkPath: string;
  readonly swiftCompiler: string;
  readonly swiftVersion: string;
  readonly target: string;
  readonly xcrun: string;
}

export interface FaceAnalyzerBuildResult {
  readonly cached: boolean;
  readonly hash: string;
  readonly path: string;
  readonly swiftVersion: string;
  readonly target: string;
}

export function resolveFaceAnalyzerPath(): string {
  return faceAnalyzerExecutablePath;
}

function targetTriple(): string {
  if (process.arch === "arm64") return `arm64-apple-macosx${deploymentTarget}`;
  if (process.arch === "x64") return `x86_64-apple-macosx${deploymentTarget}`;
  throw new Error(`Unsupported face-analyzer architecture: ${process.arch}`);
}

async function runCaptured(command: readonly string[]): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const child = Bun.spawn([...command], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return { stderr, stdout };
}

async function commandOutput(command: readonly string[]): Promise<string> {
  return (await runCaptured(command)).stdout.trim();
}

export async function discoverFaceAnalyzerToolchain(): Promise<Toolchain> {
  if (process.platform !== "darwin") {
    throw new Error("The Apple Vision face analyzer requires macOS 15 or newer.");
  }
  const xcrun = Bun.which("xcrun") ?? "/usr/bin/xcrun";
  try {
    const details = await stat(xcrun);
    if (!details.isFile()) throw new Error("not a file");
  } catch {
    throw new Error("xcrun was not found; install the Xcode command-line tools.");
  }
  const [swiftCompiler, sdkPath, swiftVersion, osVersion] = await Promise.all([
    commandOutput([xcrun, "--sdk", "macosx", "--find", "swiftc"]),
    commandOutput([xcrun, "--sdk", "macosx", "--show-sdk-path"]),
    commandOutput([xcrun, "swiftc", "--version"]),
    commandOutput(["/usr/bin/sw_vers", "-productVersion"]),
  ]);
  const osMajor = Number.parseInt(osVersion.split(".")[0] ?? "0", 10);
  if (!Number.isSafeInteger(osMajor) || osMajor < 15) {
    throw new Error(`The Apple Vision face analyzer requires macOS 15 or newer; found ${osVersion}.`);
  }
  return { sdkPath, swiftCompiler, swiftVersion, target: targetTriple(), xcrun };
}

async function swiftSources(): Promise<readonly string[]> {
  const entries = await readdir(analysisDirectory, { withFileTypes: true });
  const sources = entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".swift"))
    .map(entry => join(analysisDirectory, entry.name))
    .sort();
  if (sources.length === 0) throw new Error("No Swift face-analyzer sources were found.");
  return sources;
}

function compilerArguments(toolchain: Toolchain, sources: readonly string[]): readonly string[] {
  return [
    "-parse-as-library",
    "-swift-version", "5",
    "-target", toolchain.target,
    "-sdk", toolchain.sdkPath,
    ...frameworks.flatMap(framework => ["-framework", framework]),
    ...sources,
  ];
}

async function sourceHash(toolchain: Toolchain, sources: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const value of [
    buildRecipeVersion,
    toolchain.swiftCompiler,
    toolchain.swiftVersion,
    toolchain.sdkPath,
    toolchain.target,
    frameworks.join("\0"),
  ]) {
    hash.update(value);
    hash.update("\0");
  }
  for (const source of sources) {
    hash.update(source.slice(analysisDirectory.length));
    hash.update("\0");
    hash.update(new Uint8Array(await Bun.file(source).arrayBuffer()));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function runCompiler(command: readonly string[], environment: Record<string, string | undefined>): Promise<void> {
  const child = Bun.spawn([...command], {
    env: environment,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Swift face-analyzer compilation failed with exit code ${exitCode}.`);
}

export async function verifyFaceAnalyzerIdentity(path = faceAnalyzerExecutablePath): Promise<void> {
  await runCaptured(["/usr/bin/codesign", "--verify", "--strict", path]);
  const signature = await runCaptured(["/usr/bin/codesign", "-d", "--verbose=4", path]);
  const signatureText = `${signature.stdout}\n${signature.stderr}`;
  if (!signatureText.includes(`Identifier=${helperIdentifier}`)) {
    throw new Error("Face analyzer code signature has an unstable identifier.");
  }

  const linkage = await runCaptured(["/usr/bin/otool", "-L", path]);
  const linkedLines = linkage.stdout.split("\n").slice(1).map(line => line.trim()).filter(Boolean);
  for (const framework of frameworks) {
    const expected = `/System/Library/Frameworks/${framework}.framework/`;
    if (!linkedLines.some(line => line.startsWith(expected))) {
      throw new Error(`Face analyzer does not link the system ${framework} framework.`);
    }
  }
  const nonSystemFramework = linkedLines.find(line => (
    line.includes(".framework/") && !line.startsWith("/System/Library/Frameworks/")
  ));
  if (nonSystemFramework !== undefined) {
    throw new Error(`Face analyzer links a non-system framework: ${nonSystemFramework}`);
  }
}

async function signFaceAnalyzer(path: string): Promise<void> {
  await runCaptured([
    "/usr/bin/codesign",
    "--force",
    "--identifier", helperIdentifier,
    "--sign", "-",
    "--timestamp=none",
    path,
  ]);
  await verifyFaceAnalyzerIdentity(path);
}

async function installStableExecutable(cachedExecutable: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(outputDirectory, `.transmute-face-analyzer.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await copyFile(cachedExecutable, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, faceAnalyzerExecutablePath);
  } finally {
    await rm(temporary, { force: true });
  }
  await verifyFaceAnalyzerIdentity(faceAnalyzerExecutablePath);
}

export async function checkFaceAnalyzer(): Promise<FaceAnalyzerBuildResult> {
  const toolchain = await discoverFaceAnalyzerToolchain();
  const sources = await swiftSources();
  const hash = await sourceHash(toolchain, sources);
  await runCompiler(
    [toolchain.swiftCompiler, ...compilerArguments(toolchain, sources), "-typecheck"],
    { ...process.env, MACOSX_DEPLOYMENT_TARGET: deploymentTarget },
  );
  return {
    cached: false,
    hash,
    path: faceAnalyzerExecutablePath,
    swiftVersion: toolchain.swiftVersion.split("\n")[0] ?? toolchain.swiftVersion,
    target: toolchain.target,
  };
}

export async function buildFaceAnalyzer(): Promise<FaceAnalyzerBuildResult> {
  const toolchain = await discoverFaceAnalyzerToolchain();
  const sources = await swiftSources();
  const hash = await sourceHash(toolchain, sources);
  const hashedDirectory = join(cacheDirectory, hash);
  const cachedExecutable = join(hashedDirectory, "transmute-face-analyzer");
  await mkdir(hashedDirectory, { recursive: true, mode: 0o700 });

  let cached = false;
  try {
    const details = await stat(cachedExecutable);
    cached = details.isFile();
    if (cached) await verifyFaceAnalyzerIdentity(cachedExecutable);
  } catch {
    cached = false;
  }

  if (!cached) {
    const temporary = join(hashedDirectory, `.transmute-face-analyzer.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await runCompiler(
        [
          toolchain.swiftCompiler,
          ...compilerArguments(toolchain, sources),
          "-O",
          "-whole-module-optimization",
          "-o", temporary,
        ],
        { ...process.env, MACOSX_DEPLOYMENT_TARGET: deploymentTarget },
      );
      await chmod(temporary, 0o755);
      await signFaceAnalyzer(temporary);
      await rename(temporary, cachedExecutable);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  await installStableExecutable(cachedExecutable);
  return {
    cached,
    hash,
    path: faceAnalyzerExecutablePath,
    swiftVersion: toolchain.swiftVersion.split("\n")[0] ?? toolchain.swiftVersion,
    target: toolchain.target,
  };
}

function parseArguments(arguments_: readonly string[]): { readonly check: boolean; readonly json: boolean } {
  const known = new Set(["--check", "--json"]);
  const unknown = arguments_.filter(argument => !known.has(argument));
  if (unknown.length > 0) throw new Error(`Unknown face-analyzer build argument: ${unknown.join(", ")}`);
  return { check: arguments_.includes("--check"), json: arguments_.includes("--json") };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const result = arguments_.check ? await checkFaceAnalyzer() : await buildFaceAnalyzer();
  if (arguments_.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (arguments_.check) {
    process.stdout.write(`Face analyzer typecheck passed for ${result.target}.\n`);
  } else {
    process.stdout.write(`${result.path}\n`);
  }
}

if (import.meta.main) {
  await main();
}
