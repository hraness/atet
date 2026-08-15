import { existsSync } from "node:fs";
import path from "node:path";

import {
  checkBundleBoundary,
  type BundleBoundaryResult,
} from "./bundle-boundary";

const SOURCE_MARKERS = Object.freeze([
  "@hraness/direct",
  "packages/direct",
  "jungle.direct",
  "direct.browser-bridge/v",
  "direct.coverage/v",
  "direct.fixture/v",
  "direct.probe/v",
  "direct.runtime/v",
  "direct.session-manifest/v",
  "../direct",
  "./direct",
  "__scenario",
  "__direct",
  "Direct ready:",
]);

const EMITTED_MARKERS = Object.freeze([
  "jungle.direct",
  "direct.browser-bridge/v",
  "direct.coverage/v",
  "direct.fixture/v",
  "direct.probe/v",
  "direct.runtime/v",
  "direct.session-manifest/v",
  "__scenario",
  "__direct",
  "Direct ready:",
]);

export interface AtetProductionBoundaryResult {
  readonly emitted: BundleBoundaryResult;
  readonly source: BundleBoundaryResult;
}

function emptyResult(): BundleBoundaryResult {
  return { scanned: Object.freeze([]), violations: Object.freeze([]) };
}

function combineResults(results: readonly BundleBoundaryResult[]): BundleBoundaryResult {
  const scanned = new Set<string>();
  const violations = new Map<string, Set<string>>();
  for (const result of results) {
    for (const file of result.scanned) scanned.add(file);
    for (const violation of result.violations) {
      const markers = violations.get(violation.file) ?? new Set<string>();
      for (const marker of violation.markers) markers.add(marker);
      violations.set(violation.file, markers);
    }
  }
  return {
    scanned: Object.freeze([...scanned].sort()),
    violations: Object.freeze([...violations]
      .map(([file, markers]) => ({ file, markers: Object.freeze([...markers].sort()) }))
      .sort((left, right) => left.file.localeCompare(right.file))),
  };
}

async function scanExisting(
  directory: string,
  markers: readonly string[],
  patterns: readonly string[],
): Promise<BundleBoundaryResult> {
  return existsSync(directory)
    ? await checkBundleBoundary({ directory, markers, patterns })
    : emptyResult();
}

async function assertManifestBoundary(packageManifestPath: string): Promise<void> {
  const manifest: unknown = await Bun.file(packageManifestPath).json();
  if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) {
    throw new Error("Atet package manifest is not an object with production dependencies.");
  }
  const dependencies = Reflect.get(manifest, "dependencies");
  if (typeof dependencies === "object" && dependencies !== null && "@hraness/direct" in dependencies) {
    throw new Error("@hraness/direct cannot be a production dependency of Atet.");
  }
}

export async function checkAtetProductionBoundary(
  desktop = path.resolve(import.meta.dir, ".."),
  packageManifestPath = path.join(desktop, "..", "..", "package.json"),
): Promise<AtetProductionBoundaryResult> {
  await assertManifestBoundary(packageManifestPath);
  const source = combineResults(await Promise.all([
    scanExisting(path.join(desktop, "frontend", "src"), SOURCE_MARKERS, ["**/*.ts", "**/*.tsx"]),
    scanExisting(path.join(desktop, "runtime", "src"), SOURCE_MARKERS, ["**/*.ts", "**/*.js"]),
    scanExisting(path.join(desktop, "src"), SOURCE_MARKERS, ["**/*.zig"]),
    scanExisting(path.join(desktop, "cli"), SOURCE_MARKERS, ["**/*.ts", "!**/*.test.ts"]),
    scanExisting(path.join(desktop, "capture"), SOURCE_MARKERS, ["*.swift", "build.ts", "protocol.ts"]),
    scanExisting(path.join(desktop, "analysis"), SOURCE_MARKERS, ["*.swift", "build.ts", "protocol.ts"]),
    scanExisting(path.join(desktop, "contracts"), SOURCE_MARKERS, ["*.ts", "!*.test.ts", "!*.property.test.ts"]),
    scanExisting(path.join(desktop, "core"), SOURCE_MARKERS, ["*.ts", "!*.test.ts", "!*.property.test.ts"]),
    scanExisting(path.join(desktop, "application"), SOURCE_MARKERS, ["**/*.ts", "!**/*.test.ts", "!**/*.property.test.ts"]),
    scanExisting(path.join(desktop, "code"), SOURCE_MARKERS, ["**/*.ts", "!**/*.test.ts", "!**/*.property.test.ts"]),
    scanExisting(path.join(desktop, "workflows"), SOURCE_MARKERS, ["**/*.ts", "!**/*.test.ts", "!**/*.property.test.ts"]),
    scanExisting(desktop, SOURCE_MARKERS, ["app.zon", "build.zig"]),
  ]));
  const emitted = combineResults(await Promise.all([
    scanExisting(path.join(desktop, "frontend", "dist"), EMITTED_MARKERS, ["**/*"]),
    scanExisting(path.join(desktop, "runtime", "dist"), EMITTED_MARKERS, ["atet-gateway"]),
    scanExisting(path.join(desktop, "dist"), EMITTED_MARKERS, ["atet"]),
    scanExisting(path.join(desktop, "capture", "dist"), EMITTED_MARKERS, ["atet-capture"]),
    scanExisting(path.join(desktop, "analysis", "dist"), EMITTED_MARKERS, ["atet-face-analyzer"]),
    scanExisting(path.join(desktop, "zig-out", "bin"), EMITTED_MARKERS, ["atet"]),
    scanExisting(path.join(desktop, "zig-out", "package"), EMITTED_MARKERS, [
      "**/Contents/MacOS/atet",
      "**/Contents/Resources/frontend/dist/**/*",
      "**/Contents/Resources/runtime/bin/atet-gateway",
      "**/Contents/Resources/runtime/bin/atet-capture",
      "**/Contents/Resources/runtime/bin/atet-face-analyzer",
    ]),
  ]));

  const violations = [...source.violations, ...emitted.violations];
  if (violations.length > 0) {
    throw new Error([
      "Atet production assets contain Direct markers:",
      ...violations.map(({ file, markers }) => `${file}: ${markers.join(", ")}`),
    ].join("\n"));
  }
  if (source.scanned.length === 0) {
    throw new Error("Atet production boundary did not scan any source files.");
  }
  if (emitted.scanned.length === 0) {
    throw new Error("Atet production boundary did not scan any emitted assets.");
  }
  return { emitted, source };
}

if (import.meta.main) {
  const result = await checkAtetProductionBoundary();
  console.log(
    `Atet production boundary passed (${String(result.source.scanned.length)} source files, ${String(result.emitted.scanned.length)} emitted assets).`,
  );
}
