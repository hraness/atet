import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { ApplicationError } from "../application/errors";
import { bindExactCapability } from "../application/capability-binding";
import type {
  ApplicationCapability,
  ApplicationContext,
} from "../application/context";
import {
  canonicalJson,
  sha256Hex,
} from "../core/canonical-json";
import {
  CODE_WORKER_ABI,
  GRAPH_ABI,
  GRAPH_COMPILER_ABI,
  GRAPH_SCHEDULER_ABI,
  WorkflowRuntimeIdentitySchema,
  type WorkflowRuntimeIdentity,
} from "./contracts";
import type { WorkflowSourceBundle } from "./source-bundle";

export interface CreateWorkflowRuntimeIdentityOptions {
  readonly applicationBuild?: string;
  readonly bundle: WorkflowSourceBundle;
}

const APPLICATION_BUILD_DOMAIN = "studio.application-build/v1";
const HOST_APPLICATION_BUILD_DOMAIN = "studio.host-application-build/v1";
const APPLICATION_SOURCE_EXTENSIONS = new Set([
  ".json",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".zig",
]);
const DESKTOP_SOURCE_DIRECTORIES = [
  "analysis",
  "application",
  "capture",
  "cli",
  "code",
  "contracts",
  "core",
  "runtime",
  "workflows",
] as const;
const MAXIMUM_APPLICATION_SOURCE_FILES = 4_096;
const MAXIMUM_APPLICATION_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
let cachedApplicationBuild: Promise<string> | undefined;

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
  );
}

function productionSourceFile(name: string): boolean {
  return APPLICATION_SOURCE_EXTENSIONS.has(extname(name))
    && !name.endsWith(".test.ts")
    && !name.endsWith(".test.tsx")
    && !name.endsWith(".property.test.ts")
    && !name.endsWith(".property.test.tsx");
}

async function collectSourceFiles(
  physicalRoot: string,
  directory: string,
  logicalPrefix: string,
  output: Array<{ readonly logicalPath: string; readonly path: string }>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      entry.name === "dist"
      || entry.name === "node_modules"
      || entry.name === ".generated"
    ) continue;
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new ApplicationError(
        "unsafe-path",
        `Application build source must not contain a symbolic link: ${logicalPrefix}/${entry.name}`,
      );
    }
    if (details.isDirectory()) {
      await collectSourceFiles(
        physicalRoot,
        path,
        `${logicalPrefix}/${entry.name}`,
        output,
      );
      continue;
    }
    if (!details.isFile() || !productionSourceFile(entry.name)) continue;
    const physical = await realpath(path);
    if (!isWithin(physicalRoot, physical)) {
      throw new ApplicationError(
        "unsafe-path",
        `Application build source escapes its root: ${logicalPrefix}/${entry.name}`,
      );
    }
    output.push({
      logicalPath: `${logicalPrefix}/${entry.name}`,
      path: physical,
    });
    if (output.length > MAXIMUM_APPLICATION_SOURCE_FILES) {
      throw new ApplicationError(
        "unsupported-plan",
        "Application build source exceeds its bounded file count.",
      );
    }
  }
}

async function computeApplicationBuildIdentity(options: {
  readonly desktopRoot: string;
  readonly repositoryRoot: string;
}): Promise<string> {
  const desktopRoot = await realpath(options.desktopRoot);
  const repositoryRoot = await realpath(options.repositoryRoot);
  if (!isWithin(repositoryRoot, desktopRoot) || desktopRoot === repositoryRoot) {
    throw new ApplicationError(
      "unsafe-path",
      "Atet desktop sources must be inside the repository root.",
    );
  }
  const sources: Array<{ readonly logicalPath: string; readonly path: string }> = [];
  for (const directory of DESKTOP_SOURCE_DIRECTORIES) {
    await collectSourceFiles(
      desktopRoot,
      join(desktopRoot, directory),
      `apps/desktop/${directory}`,
      sources,
    );
  }
  for (const source of [
    {
      logicalPrefix: "src",
      path: join(repositoryRoot, "src"),
    },
    {
      logicalPrefix: "packages/scene",
      path: join(repositoryRoot, "packages", "scene", "src"),
    },
  ]) {
    await collectSourceFiles(
      repositoryRoot,
      source.path,
      source.logicalPrefix,
      sources,
    );
  }
  for (const [logicalPath, path] of [
    ["bun.lock", join(repositoryRoot, "bun.lock")],
    ["package.json", join(repositoryRoot, "package.json")],
  ] as const) {
    const physical = await realpath(path);
    if (!isWithin(repositoryRoot, physical)) {
      throw new ApplicationError("unsafe-path", `Application build source escapes: ${logicalPath}`);
    }
    sources.push({ logicalPath, path: physical });
  }
  sources.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const hash = createHash("sha256").update(`${APPLICATION_BUILD_DOMAIN}\0`);
  for (const source of sources) {
    const before = await lstat(source.path);
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.size > MAXIMUM_APPLICATION_SOURCE_FILE_BYTES
    ) {
      throw new ApplicationError(
        "unsafe-path",
        `Application build source is unsafe or oversized: ${source.logicalPath}`,
      );
    }
    const bytes = await readFile(source.path);
    const after = await lstat(source.path);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        `Application build source changed while hashing: ${source.logicalPath}`,
      );
    }
    hash.update(source.logicalPath);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `atet/${hash.digest("hex")}`;
}

export async function createApplicationBuildIdentity(options: {
  readonly desktopRoot?: string;
  readonly repositoryRoot?: string;
} = {}): Promise<string> {
  const defaultDesktopRoot = resolve(import.meta.dir, "..");
  const defaultRepositoryRoot = resolve(defaultDesktopRoot, "../..");
  if (options.desktopRoot !== undefined || options.repositoryRoot !== undefined) {
    return await computeApplicationBuildIdentity({
      desktopRoot: options.desktopRoot ?? defaultDesktopRoot,
      repositoryRoot: options.repositoryRoot ?? defaultRepositoryRoot,
    });
  }
  cachedApplicationBuild ??= computeApplicationBuildIdentity({
    desktopRoot: defaultDesktopRoot,
    repositoryRoot: defaultRepositoryRoot,
  });
  return await cachedApplicationBuild;
}

async function executableIdentity(
  capability: ApplicationCapability,
): Promise<Readonly<Record<string, boolean | null | number | string>>> {
  if (
    !capability.available
    || capability.command === undefined
    || capability.command === ""
  ) {
    return {
      available: false,
      name: capability.name,
    };
  }
  return {
    available: true,
    ...await bindExactCapability(capability),
  };
}

/**
 * Binds operation semantics to both checked source and the exact native/media
 * executables selected by this application context. A persisted run cannot
 * silently resume under a replacement helper that happens to print the same
 * version string.
 */
export async function createHostApplicationBuildIdentity(
  application: ApplicationContext,
  options: {
    readonly inheritedFileDescriptors?: readonly number[];
  } = {},
): Promise<string> {
  const [sourceBuild, capabilities] = await Promise.all([
    createApplicationBuildIdentity(),
    application.capabilities(options.inheritedFileDescriptors),
  ]);
  const executableBindings = await Promise.all(
    [...capabilities]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(executableIdentity),
  );
  return `atet/${sha256Hex(
    `${HOST_APPLICATION_BUILD_DOMAIN}\0${canonicalJson({
      capabilities: executableBindings,
      sourceBuild,
    })}`,
  )}`;
}

export async function createWorkflowRuntimeIdentity(
  options: CreateWorkflowRuntimeIdentityOptions,
): Promise<WorkflowRuntimeIdentity> {
  const externalEntries = await Promise.all(
    options.bundle.externalImports.map(async external => ({
      entrySha256: createHash("sha256")
        .update(await readFile(external.resolvedPath))
        .digest("hex"),
      specifier: external.specifier,
    })),
  );
  externalEntries.sort((left, right) => left.specifier.localeCompare(right.specifier));
  return WorkflowRuntimeIdentitySchema.parse({
    applicationBuild:
      options.applicationBuild ?? await createApplicationBuildIdentity(),
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    bundlerConfigurationSha256: sha256Hex(
      `studio.workflow.bundler-configuration/v1\0${canonicalJson(options.bundle.identity)}`,
    ),
    bundlerName: "bun",
    bundlerRevision: Bun.revision,
    bundlerVersion: Bun.version,
    compilerAbi: GRAPH_COMPILER_ABI,
    codeWorkerAbi: CODE_WORKER_ABI,
    externals: {
      kind: externalEntries.length === 0 ? "deny-all" : "allowlist",
      modules: externalEntries.map(entry => entry.specifier),
      policySha256: sha256Hex(
        `studio.workflow.externals-policy/v2\0${canonicalJson(externalEntries)}`,
      ),
    },
    graphAbi: GRAPH_ABI,
    schedulerAbi: GRAPH_SCHEDULER_ABI,
  });
}
