import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import { resolveZigExecutable } from "./zig-toolchain";

export type DevelopmentRuntimeResources = Readonly<{
  captureHelper: string;
  gateway: string;
  repositoryRoot: string;
}>;

function executable(path: string, label: string): string {
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isFile()) throw new Error("not a regular file");
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch (error: unknown) {
    throw new Error(`${label} is missing or is not executable: ${path}`, { cause: error });
  }
}

export function findRepositoryRoot(start: string): string {
  let candidate = realpathSync(start);
  const filesystemRoot = parse(candidate).root;
  while (true) {
    const marker = join(candidate, "package.json");
    const desktop = join(candidate, "apps", "desktop", "app.zon");
    try {
      if (statSync(marker).isFile() && statSync(desktop).isFile()) return candidate;
    } catch {
      // Continue toward the filesystem root.
    }
    if (candidate === filesystemRoot) break;
    candidate = dirname(candidate);
  }
  throw new Error("Could not find the Atet checkout containing Atet.");
}

export function resolveDevelopmentRuntimeResources(desktopRoot: string): DevelopmentRuntimeResources {
  const canonicalDesktopRoot = realpathSync(desktopRoot);
  return {
    captureHelper: executable(
      resolve(canonicalDesktopRoot, "capture", "dist", "atet-capture"),
      "Atet capture helper",
    ),
    gateway: executable(
      resolve(canonicalDesktopRoot, "runtime", "dist", "atet-gateway"),
      "Atet gateway",
    ),
    repositoryRoot: findRepositoryRoot(canonicalDesktopRoot),
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "dev" && mode !== "run") throw new Error("Expected `dev` or `run`.");

  const desktopRoot = resolve(import.meta.dir, "..");
  const resources = resolveDevelopmentRuntimeResources(desktopRoot);
  const child = Bun.spawn([
    resolveZigExecutable(),
    "build",
    mode,
    "-Dplatform=macos",
  ], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ATET_CAPTURE_HELPER: resources.captureHelper,
      ATET_GATEWAY_PATH: resources.gateway,
      ATET_REPOSITORY_ROOT: resources.repositoryRoot,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

if (import.meta.main) await main();
