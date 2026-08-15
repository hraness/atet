import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CliError } from "./errors";

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export async function discoverRepositoryRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    if (
      await isFile(join(candidate, "package.json"))
      && await isDirectory(join(candidate, "apps", "desktop"))
    ) {
      return await realpath(candidate);
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new CliError(
    "not-found",
    `Could not find a Atet checkout from ${resolve(start)} (expected package.json and apps/desktop).`,
  );
}

export type ArtifactNamespace = "atet" | "transmute";

export function defaultArtifactRoot(
  repositoryRoot: string,
  namespace: ArtifactNamespace = "atet",
): string {
  return join(repositoryRoot, "artifacts", namespace, "recordings");
}

function defaultProjectRoot(repositoryRoot: string, namespace: ArtifactNamespace): string {
  return join(repositoryRoot, "artifacts", namespace, "projects");
}

function defaultPrivateRoot(repositoryRoot: string, namespace: ArtifactNamespace): string {
  return join(repositoryRoot, "artifacts", namespace, "private");
}

function renamedPathEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  canonical: string,
  predecessor: string,
): string | undefined {
  const current = env[canonical];
  const legacy = env[predecessor];
  if (
    current !== undefined
    && legacy !== undefined
    && resolve(current) !== resolve(legacy)
  ) {
    throw new CliError(
      "unsafe-path",
      `${canonical} and ${predecessor} disagree; remove one or set both to the same path.`,
    );
  }
  return current ?? legacy;
}

/** Shared local state coordinates resource admission across checkouts. */
export function defaultCliStateRoot(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const userHome = homedir();
  if (platform === "darwin") {
    return join(userHome, "Library", "Application Support", "Transmute", "cli");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    return join(
      localAppData !== undefined && isAbsolute(localAppData)
        ? localAppData
        : join(userHome, "AppData", "Local"),
      "Transmute",
      "cli",
    );
  }
  const stateHome = env.XDG_STATE_HOME;
  return join(
    stateHome !== undefined && isAbsolute(stateHome)
      ? stateHome
      : join(userHome, ".local", "state"),
    "transmute",
  );
}

export function displayPath(repositoryRoot: string, path: string): string {
  const pathRelative = relative(repositoryRoot, path);
  if (pathRelative === "") return ".";
  if (!pathRelative.startsWith("..") && !isAbsolute(pathRelative)) return pathRelative;
  return path;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new CliError("unsafe-path", `Private directory must be a real directory, not a symlink or file: ${path}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(path, { mode: 0o700, recursive: true });
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new CliError("unsafe-path", `Private directory creation was redirected: ${path}`);
    }
  }
  await chmod(path, 0o700);
}

/** Create a private directory by walking physical components below an existing physical root. */
export async function ensurePhysicalPrivateDirectoryWithin(
  root: string,
  requested: string,
): Promise<string> {
  if (requested.trim() === "" || isAbsolute(requested)) {
    throw new CliError("unsafe-path", `Private directory must be relative to its root: ${requested}`);
  }
  const lexicalRoot = resolve(root);
  const rootDetails = await lstat(lexicalRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new CliError("unsafe-path", `Private directory root must be a physical directory: ${root}`);
  }
  const physicalRoot = await realpath(lexicalRoot);
  const target = resolve(physicalRoot, requested);
  if (!isWithin(physicalRoot, target) || target === physicalRoot) {
    throw new CliError("unsafe-path", `Private directory escapes its root: ${requested}`);
  }
  let current = physicalRoot;
  for (const part of relative(physicalRoot, target).split(sep)) {
    current = join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new CliError("unsafe-path", `Private directory requires physical components: ${requested}`);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) {
          throw mkdirError;
        }
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new CliError("unsafe-path", `Private directory creation was redirected: ${requested}`);
      }
    }
  }
  return current;
}

function isWithin(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

async function nearestExistingPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return candidate;
      candidate = parent;
    }
  }
}

export async function resolveSafePath(root: string, requested: string): Promise<string> {
  if (requested.trim() === "") {
    throw new CliError("usage", "Output path cannot be empty.");
  }
  const absoluteRoot = resolve(root);
  const rootDetails = await lstat(absoluteRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new CliError("unsafe-path", `Output root must be a physical directory: ${absoluteRoot}`);
  }
  const target = isAbsolute(requested) ? resolve(requested) : resolve(absoluteRoot, requested);
  if (!isWithin(absoluteRoot, target)) {
    throw new CliError("unsafe-path", `Output path escapes ${absoluteRoot}: ${requested}`);
  }

  const [realRoot, existing] = await Promise.all([realpath(absoluteRoot), nearestExistingPath(target)]);
  const realExisting = await realpath(existing);
  if (!isWithin(realRoot, realExisting)) {
    throw new CliError("unsafe-path", `Output path crosses a symlink outside ${absoluteRoot}: ${requested}`);
  }

  try {
    const targetRealPath = await realpath(target);
    if (!isWithin(realRoot, targetRealPath)) {
      throw new CliError("unsafe-path", `Output path resolves outside ${absoluteRoot}: ${requested}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    // A missing leaf is safe because its nearest existing ancestor was checked.
  }
  return target;
}

export interface RepositoryPaths {
  readonly artifactRoot: string;
  readonly desktopRoot: string;
  readonly privateRoot: string;
  readonly projectRoot: string;
  readonly repositoryRoot: string;
}

export async function resolveRepositoryPaths(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  installedFrom: string = import.meta.dir,
): Promise<RepositoryPaths> {
  const toolRoot = await discoverRepositoryRoot(installedFrom);
  const repositoryRootInput = renamedPathEnvironmentValue(
    env,
    "ATET_REPOSITORY_ROOT",
    "TRANSMUTE_REPOSITORY_ROOT",
  );
  const requestedRoot = resolve(repositoryRootInput ?? cwd);
  if (!await isDirectory(requestedRoot)) {
    throw new CliError("not-found", `Atet project root is not a directory: ${requestedRoot}`);
  }
  const repositoryRoot = await realpath(requestedRoot);
  const [hasAtetArtifacts, hasTransmuteArtifacts] = await Promise.all([
    isDirectory(join(repositoryRoot, "artifacts", "atet")),
    isDirectory(join(repositoryRoot, "artifacts", "transmute")),
  ]);
  if (hasAtetArtifacts && hasTransmuteArtifacts) {
    throw new CliError(
      "unsafe-path",
      "Both artifacts/atet and artifacts/transmute exist. Resolve the namespace conflict before Atet writes artifacts.",
    );
  }
  const artifactNamespace: ArtifactNamespace = hasTransmuteArtifacts ? "transmute" : "atet";
  const requiredArtifactRoot = defaultArtifactRoot(repositoryRoot, artifactNamespace);
  const configuredArtifactRoot = renamedPathEnvironmentValue(
    env,
    "ATET_ARTIFACT_ROOT",
    "TRANSMUTE_ARTIFACT_ROOT",
  );
  if (
    configuredArtifactRoot !== undefined
    && resolve(configuredArtifactRoot) !== resolve(requiredArtifactRoot)
  ) {
    throw new CliError(
      "unsafe-path",
      `ATET_ARTIFACT_ROOT must remain ${requiredArtifactRoot}; external recording roots are forbidden.`,
    );
  }
  const artifactRoot = await ensurePhysicalPrivateDirectoryWithin(
    repositoryRoot,
    `artifacts/${artifactNamespace}/recordings`,
  );
  const projectRoot = await ensurePhysicalPrivateDirectoryWithin(
    repositoryRoot,
    relative(repositoryRoot, defaultProjectRoot(repositoryRoot, artifactNamespace)),
  );
  const privateRoot = await ensurePhysicalPrivateDirectoryWithin(
    repositoryRoot,
    relative(repositoryRoot, defaultPrivateRoot(repositoryRoot, artifactNamespace)),
  );
  await Promise.all([
    ensurePrivateDirectory(artifactRoot),
    ensurePrivateDirectory(projectRoot),
    ensurePrivateDirectory(privateRoot),
  ]);
  return {
    artifactRoot,
    desktopRoot: join(toolRoot, "apps", "desktop"),
    privateRoot,
    projectRoot,
    repositoryRoot,
  };
}
