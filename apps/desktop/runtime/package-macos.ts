import { createHash } from "node:crypto";
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { join, resolve, sep } from "node:path";

import { verifyFaceAnalyzerIdentity } from "../analysis/build";
import {
  DesktopResponseSchema,
  ATET_DESKTOP_PROTOCOL,
  ATET_DESKTOP_PROTOCOL_VERSION,
} from "../contracts";
import { HostResponseSchema } from "./src/host-protocol";

const desktopRoot = resolve(import.meta.dir, "..");
const packageRoot = join(desktopRoot, "zig-out", "package");
export const macOSAppPath = join(packageRoot, "atet-2.0.0-macos-ReleaseFast.app");

type RuntimeManifest = Readonly<{
  capture: Readonly<{ name: "atet-capture"; sha256: string }>;
  faceAnalyzer: Readonly<{ name: "atet-face-analyzer"; sha256: string }>;
  gateway: Readonly<{ bunVersion: string; name: "atet-gateway"; sha256: string }>;
  schemaVersion: 2;
}>;

export const requiredUsageDescriptions = Object.freeze({
  NSAudioCaptureUsageDescription: "Atet records system audio as a separate editing source.",
  NSCameraUsageDescription: "Atet records the selected camera as a separate editing source.",
  NSMicrophoneUsageDescription: "Atet records the selected microphone as a separate editing source.",
  NSScreenCaptureUsageDescription: "Atet records each display as a separate editing source.",
});

async function assertExecutable(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error(`${label} is not a regular file.`);
  await access(canonical, constants.X_OK);
  return canonical;
}

async function assertInsidePackage(path: string): Promise<string> {
  const canonicalPackageRoot = await realpath(packageRoot);
  const canonicalAppRoot = await realpath(path);
  if (!canonicalAppRoot.startsWith(`${canonicalPackageRoot}${sep}`) || !canonicalAppRoot.endsWith(".app")) {
    throw new Error("Refusing to stage Atet resources outside the expected package root.");
  }
  return canonicalAppRoot;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value)) {
    throw new Error("Packaged runtime manifest must be an object.");
  }
  const component = (
    name: "capture" | "faceAnalyzer" | "gateway",
    expectedName: string,
    expectedKeys: readonly string[],
  ): Readonly<Record<string, unknown>> => {
    const raw = value[name];
    if (!isRecord(raw)) {
      throw new Error(`Packaged runtime manifest omits ${name}.`);
    }
    if (
      Object.keys(raw).sort().join(",") !== [...expectedKeys].sort().join(",")
      || raw.name !== expectedName
      || typeof raw.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(raw.sha256)
    ) {
      throw new Error(`Packaged runtime manifest has an invalid ${name} entry.`);
    }
    return raw;
  };
  const capture = component("capture", "atet-capture", ["name", "sha256"]);
  const faceAnalyzer = component("faceAnalyzer", "atet-face-analyzer", ["name", "sha256"]);
  const gateway = component("gateway", "atet-gateway", ["bunVersion", "name", "sha256"]);
  if (
    value.schemaVersion !== 2
    || Object.keys(value).sort().join(",") !== "capture,faceAnalyzer,gateway,schemaVersion"
    || typeof gateway.bunVersion !== "string"
    || gateway.bunVersion.length === 0
    || typeof capture.sha256 !== "string"
    || typeof faceAnalyzer.sha256 !== "string"
    || typeof gateway.sha256 !== "string"
  ) {
    throw new Error("Packaged runtime manifest has an invalid envelope.");
  }
  return {
    capture: { name: "atet-capture", sha256: capture.sha256 },
    faceAnalyzer: { name: "atet-face-analyzer", sha256: faceAnalyzer.sha256 },
    gateway: { bunVersion: gateway.bunVersion, name: "atet-gateway", sha256: gateway.sha256 },
    schemaVersion: 2,
  };
}

export async function writeFinalRuntimeManifest(runtimeRoot: string, bunVersion = Bun.version): Promise<RuntimeManifest> {
  const manifest: RuntimeManifest = {
    capture: { name: "atet-capture", sha256: await sha256(join(runtimeRoot, "bin", "atet-capture")) },
    faceAnalyzer: {
      name: "atet-face-analyzer",
      sha256: await sha256(join(runtimeRoot, "bin", "atet-face-analyzer")),
    },
    gateway: { bunVersion, name: "atet-gateway", sha256: await sha256(join(runtimeRoot, "bin", "atet-gateway")) },
    schemaVersion: 2,
  };
  const destination = join(runtimeRoot, "manifest.json");
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(destination, 0o600);
  return manifest;
}

export async function verifyFinalRuntimeManifest(runtimeRoot: string): Promise<void> {
  const manifestPath = join(runtimeRoot, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    throw new Error("Packaged runtime manifest is not valid JSON.");
  }
  const manifest = parseRuntimeManifest(value);
  const [
    captureHash,
    faceAnalyzerHash,
    gatewayHash,
  ] = await Promise.all([
    sha256(join(runtimeRoot, "bin", manifest.capture.name)),
    sha256(join(runtimeRoot, "bin", manifest.faceAnalyzer.name)),
    sha256(join(runtimeRoot, "bin", manifest.gateway.name)),
  ]);
  if (
    captureHash !== manifest.capture.sha256
    || faceAnalyzerHash !== manifest.faceAnalyzer.sha256
    || gatewayHash !== manifest.gateway.sha256
  ) {
    throw new Error("Packaged runtime manifest does not match the final signed sidecars.");
  }
}

async function run(command: readonly string[], inherit = true): Promise<Readonly<{ stderr: string; stdout: string }>> {
  const child = Bun.spawn([...command], {
    cwd: desktopRoot,
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    inherit ? Promise.resolve("") : new Response(child.stdout).text(),
    inherit ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${(stderr || stdout).trim()}`);
  }
  return { stderr, stdout };
}

async function setPlistString(infoPlist: string, key: string, value: string): Promise<void> {
  const replace = Bun.spawnSync([
    "/usr/bin/plutil", "-replace", key, "-string", value, infoPlist,
  ], { stdout: "pipe", stderr: "pipe" });
  if (replace.exitCode === 0) return;
  await run(["/usr/bin/plutil", "-insert", key, "-string", value, infoPlist]);
}

async function verifyPlistString(infoPlist: string, key: string, expected: string): Promise<void> {
  const result = await run(["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", infoPlist], false);
  if (result.stdout.trim() !== expected) throw new Error(`Packaged Info.plist has the wrong ${key}.`);
}

async function verifyMinimumMacOS(executable: string): Promise<void> {
  const result = await run(["/usr/bin/vtool", "-show-build", executable], false);
  if (!/^\s*minos 15\.0\s*$/mu.test(result.stdout)) {
    throw new Error("Packaged Zig host was not linked with a macOS 15.0 minimum.");
  }
}

async function verifyStagedGateway(gateway: string, captureHelper: string): Promise<void> {
  const request = {
    command: "atet.runtime.snapshot",
    id: "package-probe",
    payload: {
      payload: { kind: "snapshot" },
      protocol: ATET_DESKTOP_PROTOCOL,
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      requestId: "request_packageprobe1",
    },
  };
  const environment: Record<string, string> = {
    ATET_CAPTURE_HELPER: captureHelper,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
  const temporaryHome = await mkdtemp(join(tmpdir(), "atet-package-home-"));
  environment.HOME = temporaryHome;
  const child = Bun.spawn([gateway], { env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await child.stdin.write(`${JSON.stringify(request)}\n`);
  await child.stdin.flush();
  await child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await rm(temporaryHome, { force: true, recursive: true });
  if (exitCode !== 0) throw new Error(`Staged gateway probe failed (${exitCode}): ${stderr.trim()}`);
  if (Buffer.byteLength(stdout) > 64 * 1024) throw new Error("Staged gateway probe response is oversized.");
  const lines = stdout.trim().split("\n");
  if (lines.length !== 1) throw new Error("Staged gateway probe returned unexpected protocol frames.");
  let value: unknown;
  try {
    value = JSON.parse(lines[0] ?? "") as unknown;
  } catch {
    throw new Error("Staged gateway probe returned invalid JSON.");
  }
  const hostResponse = HostResponseSchema.parse(value);
  if (!hostResponse.ok) throw new Error(`Packaged gateway transport failed: ${hostResponse.error.code}`);
  const response = DesktopResponseSchema.parse(hostResponse.result);
  if (!response.ok) throw new Error(`Packaged gateway snapshot failed: ${response.error.code}`);
  if (response.snapshot.state.state !== "idle") {
    throw new Error("Packaged gateway did not initialize its user-owned workspace.");
  }
}

async function assertTreeOmitsCheckoutPath(root: string, checkoutRoot: string): Promise<void> {
  const forbidden = Buffer.from(checkoutRoot, "utf8");
  const visit = async (path: string): Promise<void> => {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      if (Buffer.from(await readlink(path), "utf8").includes(forbidden)) {
        throw new Error("Packaged application embeds the build checkout path in a symlink.");
      }
      return;
    }
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (details.isFile() && (await readFile(path)).includes(forbidden)) {
      throw new Error("Packaged application embeds the build checkout path in its bytes.");
    }
  };
  await visit(root);
}

async function verifyRelocatedPackage(appRoot: string): Promise<void> {
  const checkoutRoot = await realpath(resolve(desktopRoot, "../.."));
  await assertTreeOmitsCheckoutPath(appRoot, checkoutRoot);
  const relocationRoot = await mkdtemp(join(tmpdir(), "atet-relocation-proof-"));
  const relocatedApp = join(relocationRoot, "Renamed Atet.app");
  try {
    await cp(appRoot, relocatedApp, { recursive: true });
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", relocatedApp]);
    const relocatedRuntime = join(relocatedApp, "Contents", "Resources", "runtime");
    await verifyFinalRuntimeManifest(relocatedRuntime);
    await assertTreeOmitsCheckoutPath(relocatedApp, checkoutRoot);
    await verifyStagedGateway(
      join(relocatedRuntime, "bin", "atet-gateway"),
      join(relocatedRuntime, "bin", "atet-capture"),
    );
  } finally {
    await rm(relocationRoot, { force: true, recursive: true });
  }
}

export async function stageMacOSPackage(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Atet macOS packaging requires macOS.");

  const appRoot = await assertInsidePackage(macOSAppPath);
  const resourcesRoot = join(appRoot, "Contents", "Resources");
  const runtimeRoot = join(resourcesRoot, "runtime");
  const runtimeBin = join(runtimeRoot, "bin");
  const frontendDestination = join(resourcesRoot, "frontend", "dist");
  const gatewaySource = await assertExecutable(
    join(desktopRoot, "runtime", "dist", "atet-gateway"),
    "Compiled Atet gateway",
  );
  const captureSource = await assertExecutable(
    join(desktopRoot, "capture", "dist", "atet-capture"),
    "Atet capture helper",
  );
  const faceAnalyzerSource = await assertExecutable(
    join(desktopRoot, "analysis", "dist", "atet-face-analyzer"),
    "Atet face analyzer",
  );
  await verifyFaceAnalyzerIdentity(faceAnalyzerSource);
  const frontendSource = await realpath(join(desktopRoot, "frontend", "dist"));
  if (!(await stat(frontendSource)).isDirectory()) throw new Error("Built Atet frontend is missing.");

  await Promise.all([
    rm(runtimeRoot, { force: true, recursive: true }),
    rm(frontendDestination, { force: true, recursive: true }),
  ]);
  await Promise.all([
    mkdir(runtimeBin, { recursive: true }),
    mkdir(join(resourcesRoot, "frontend"), { recursive: true }),
  ]);

  const gatewayDestination = join(runtimeBin, "atet-gateway");
  const captureDestination = join(runtimeBin, "atet-capture");
  const faceAnalyzerDestination = join(runtimeBin, "atet-face-analyzer");
  await Promise.all([
    copyFile(gatewaySource, gatewayDestination),
    copyFile(captureSource, captureDestination),
    copyFile(faceAnalyzerSource, faceAnalyzerDestination),
    cp(frontendSource, frontendDestination, { force: true, recursive: true }),
  ]);
  await Promise.all([
    chmod(gatewayDestination, 0o755),
    chmod(captureDestination, 0o755),
    chmod(faceAnalyzerDestination, 0o755),
  ]);

  const infoPlist = join(appRoot, "Contents", "Info.plist");
  await setPlistString(infoPlist, "LSMinimumSystemVersion", "15.0");
  for (const [key, value] of Object.entries(requiredUsageDescriptions)) {
    await setPlistString(infoPlist, key, value);
  }

  // Exercise the exact staged sidecars before ad-hoc signing. A release identity
  // is required for macOS to authorize Bun's JIT entitlements consistently;
  // integrity of the ad-hoc development signature is verified below.
  await verifyStagedGateway(gatewayDestination, captureDestination);
  await Promise.all([
    run(["/usr/bin/codesign", "--verify", "--strict", captureDestination]),
    verifyFaceAnalyzerIdentity(faceAnalyzerDestination),
  ]);
  await run([
    "/usr/bin/codesign", "--force", "--identifier", "com.hraness.atet.gateway",
    "--entitlements", join(desktopRoot, "runtime", "gateway.entitlements.plist"),
    "--sign", "-", "--timestamp=none", gatewayDestination,
  ]);
  await run([
    "/usr/bin/codesign", "--force", "--identifier", "com.hraness.atet.capture",
    "--sign", "-", "--timestamp=none", captureDestination,
  ]);
  await run([
    "/usr/bin/codesign", "--force", "--identifier", "com.hraness.atet.face-analyzer",
    "--sign", "-", "--timestamp=none", faceAnalyzerDestination,
  ]);
  await Promise.all([
    run(["/usr/bin/codesign", "--verify", "--strict", captureDestination]),
    verifyFaceAnalyzerIdentity(faceAnalyzerDestination),
  ]);
  // Hash only the final signed sidecars. The outer application signature then
  // seals these final sidecar bytes without embedding a build-machine path.
  await writeFinalRuntimeManifest(runtimeRoot);
  await verifyFinalRuntimeManifest(runtimeRoot);
  await run([
    "/usr/bin/codesign", "--force", "--identifier", "com.hraness.atet",
    "--sign", "-", "--timestamp=none", appRoot,
  ]);
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", appRoot]);
  await verifyFinalRuntimeManifest(runtimeRoot);
  await verifyMinimumMacOS(join(appRoot, "Contents", "MacOS", "atet"));

  await verifyPlistString(infoPlist, "CFBundleIdentifier", "com.hraness.atet");
  await verifyPlistString(infoPlist, "LSMinimumSystemVersion", "15.0");
  for (const [key, value] of Object.entries(requiredUsageDescriptions)) {
    await verifyPlistString(infoPlist, key, value);
  }
  await Promise.all([
    access(join(frontendDestination, "index.html"), constants.R_OK),
    access(gatewayDestination, constants.X_OK),
    access(captureDestination, constants.X_OK),
    access(faceAnalyzerDestination, constants.X_OK),
  ]);
  await verifyRelocatedPackage(appRoot);

  process.stdout.write(`Staged and verified Atet.app resources at ${resourcesRoot}\n`);
}

if (import.meta.main) await stageMacOSPackage();
