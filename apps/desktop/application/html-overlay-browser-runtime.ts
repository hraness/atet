import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { z } from "zod";

import { canonicalJson } from "../core/canonical-json";
import {
  ExactCapabilityBindingSchema,
  type ExactCapabilityBinding,
} from "./capability-binding";
import { ApplicationError } from "./errors";

const MAXIMUM_RUNTIME_ENTRIES = 10_000;
const MAXIMUM_RUNTIME_BYTES = 8 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const CODESIGN_MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const CODESIGN_TIMEOUT_MS = 60_000;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

function isSafeRelativeRuntimePath(path: string): boolean {
  if (path === ".") return true;
  return path.length > 0
    && path.length <= 4_096
    && !path.includes("\0")
    && !isAbsolute(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

const RuntimePathSchema = z.string().refine(
  isSafeRelativeRuntimePath,
  "Browser runtime paths must be normalized relative paths.",
);
const RuntimeModeSchema = z.number().int().min(0).max(0o7777);

const BrowserRuntimeDirectoryEntrySchema = z.strictObject({
  kind: z.literal("directory"),
  mode: RuntimeModeSchema,
  path: RuntimePathSchema,
});
const BrowserRuntimeFileEntrySchema = z.strictObject({
  bytes: z.number().int().safe().min(0).max(MAXIMUM_RUNTIME_BYTES),
  kind: z.literal("file"),
  mode: RuntimeModeSchema,
  path: RuntimePathSchema,
  sha256: Sha256Schema,
});
const BrowserRuntimeSymlinkEntrySchema = z.strictObject({
  kind: z.literal("symlink"),
  mode: RuntimeModeSchema,
  path: RuntimePathSchema,
  target: z.string().min(1).max(4_096).refine(
    target => !target.includes("\0") && !isAbsolute(target),
    "Browser runtime symlink targets must be relative and NUL-free.",
  ),
});

export const HtmlOverlayBrowserRuntimeEntrySchema = z.union([
  BrowserRuntimeDirectoryEntrySchema,
  BrowserRuntimeFileEntrySchema,
  BrowserRuntimeSymlinkEntrySchema,
]);
export type HtmlOverlayBrowserRuntimeEntry = Readonly<
  z.infer<typeof HtmlOverlayBrowserRuntimeEntrySchema>
>;

export interface HtmlOverlayBrowserRuntimePathIdentity {
  readonly ctimeNs: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly path: string;
  readonly size: string;
}

export const HtmlOverlayBrowserRuntimeManifestSchema = z.strictObject({
  entries: z.array(HtmlOverlayBrowserRuntimeEntrySchema)
    .min(1)
    .max(MAXIMUM_RUNTIME_ENTRIES)
    .superRefine((entries, context) => {
      if (entries[0]?.path !== ".") {
        context.addIssue({
          code: "custom",
          message: "Browser runtime manifests must begin with their root entry.",
          path: [0, "path"],
        });
      }
      for (let index = 1; index < entries.length; index += 1) {
        if (entries[index - 1]!.path >= entries[index]!.path) {
          context.addIssue({
            code: "custom",
            message: "Browser runtime entries must have unique ASCII-sorted paths.",
            path: [index, "path"],
          });
        }
      }
    }),
  executableRelativePath: RuntimePathSchema,
  layout: z.enum(["macos-app-bundle", "single-executable"]),
  rootSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  totalBytes: z.number().int().safe().positive().max(MAXIMUM_RUNTIME_BYTES),
});
export type HtmlOverlayBrowserRuntimeManifest = Readonly<
  z.infer<typeof HtmlOverlayBrowserRuntimeManifestSchema>
>;

export const HtmlOverlayBrowserRuntimeBindingSchema = z.strictObject({
  capability: ExactCapabilityBindingSchema,
  manifest: HtmlOverlayBrowserRuntimeManifestSchema,
  provenance: z.union([
    z.strictObject({
      bundleIdentifier: z.enum([
        "com.google.Chrome",
        "com.google.Chrome.beta",
        "com.google.Chrome.dev",
        "com.google.Chrome.canary",
      ]),
      designatedRequirementSha256: Sha256Schema,
      kind: z.literal("verified-macos-code-signature"),
      teamIdentifier: z.literal("EQHXZ8M8AV"),
    }),
    z.strictObject({
      kind: z.literal("test-only-unverified"),
    }),
  ]),
  sourceRoot: z.string().min(1).max(4_096).refine(
    path => isAbsolute(path) && !path.includes("\0"),
    "Browser runtime roots must be absolute and NUL-free.",
  ),
});
export type HtmlOverlayBrowserRuntimeBinding = Readonly<
  z.infer<typeof HtmlOverlayBrowserRuntimeBindingSchema>
>;

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfRuntimeInspectionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new ApplicationError("cancelled", "Browser runtime inspection was cancelled.");
}

function runtimeEntryPath(root: string, entryPath: string): string {
  return entryPath === "." ? root : join(root, ...entryPath.split("/"));
}

export async function captureHtmlOverlayBrowserRuntimePathIdentity(
  root: string,
  entries: readonly HtmlOverlayBrowserRuntimeEntry[],
  signal?: AbortSignal,
): Promise<readonly HtmlOverlayBrowserRuntimePathIdentity[]> {
  const identities: HtmlOverlayBrowserRuntimePathIdentity[] = [];
  for (const entry of entries) {
    throwIfRuntimeInspectionAborted(signal);
    const details = await lstat(runtimeEntryPath(root, entry.path), {
      bigint: true,
    });
    identities.push({
      ctimeNs: details.ctimeNs.toString(),
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      mode: Number(details.mode & 0o177777n),
      path: entry.path,
      size: details.size.toString(),
    });
  }
  return identities;
}

function runtimeRootSha256(
  input: Omit<HtmlOverlayBrowserRuntimeManifest, "rootSha256">,
): string {
  return createHash("sha256").update(canonicalJson({
    domain: "atet.html-overlay-browser-runtime/v1",
    ...input,
  })).digest("hex");
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

async function hashStableFile(
  absolutePath: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<Readonly<{ bytes: number; mode: number; sha256: string }>> {
  throwIfRuntimeInspectionAborted(signal);
  const lexicalBefore = await lstat(absolutePath);
  if (lexicalBefore.isSymbolicLink() || !lexicalBefore.isFile()) {
    throw new ApplicationError(
      "conflict",
      `Browser runtime file changed while it was inspected: ${relativePath}`,
    );
  }
  const handle = await open(
    absolutePath,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || !Number.isSafeInteger(before.size)
      || before.size < 0
      || before.size > MAXIMUM_RUNTIME_BYTES
    ) {
      throw new ApplicationError(
        "unsafe-path",
        `Browser runtime contains an invalid or oversized file: ${relativePath}`,
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < before.size) {
      throwIfRuntimeInspectionAborted(signal);
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const lexicalAfter = await lstat(absolutePath);
    if (
      offset !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs
      || lexicalBefore.dev !== lexicalAfter.dev
      || lexicalBefore.ino !== lexicalAfter.ino
      || lexicalBefore.size !== lexicalAfter.size
      || lexicalBefore.mode !== lexicalAfter.mode
      || lexicalBefore.mtimeMs !== lexicalAfter.mtimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        `Browser runtime file changed while it was hashed: ${relativePath}`,
      );
    }
    return {
      bytes: before.size,
      mode: before.mode & 0o7777,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function inspectEntry(
  root: string,
  absolutePath: string,
  relativePath: string,
  entries: HtmlOverlayBrowserRuntimeEntry[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfRuntimeInspectionAborted(signal);
  if (entries.length >= MAXIMUM_RUNTIME_ENTRIES) {
    throw new ApplicationError(
      "invalid-data",
      `Browser runtime exceeds ${String(MAXIMUM_RUNTIME_ENTRIES)} entries.`,
    );
  }
  const details = await lstat(absolutePath);
  const mode = details.mode & 0o7777;
  if (details.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    if (
      target.length === 0
      || target.length > 4_096
      || target.includes("\0")
      || isAbsolute(target)
      || !pathWithinRoot(root, resolve(dirname(absolutePath), target))
    ) {
      throw new ApplicationError(
        "unsafe-path",
        `Browser runtime symlink escapes its copied root: ${relativePath}`,
      );
    }
    entries.push({ kind: "symlink", mode, path: relativePath, target });
    return;
  }
  if (details.isFile()) {
    const identity = await hashStableFile(absolutePath, relativePath, signal);
    entries.push({
      bytes: identity.bytes,
      kind: "file",
      mode: identity.mode,
      path: relativePath,
      sha256: identity.sha256,
    });
    return;
  }
  if (!details.isDirectory()) {
    throw new ApplicationError(
      "unsafe-path",
      `Browser runtime contains an unsupported filesystem entry: ${relativePath}`,
    );
  }
  entries.push({ kind: "directory", mode, path: relativePath });
  const names = (await readdir(absolutePath)).sort(asciiCompare);
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new ApplicationError("unsafe-path", "Browser runtime contains an unsafe path name.");
    }
    await inspectEntry(
      root,
      join(absolutePath, name),
      relativePath === "." ? name : `${relativePath}/${name}`,
      entries,
      signal,
    );
  }
}

function appBundleRoot(executablePath: string): string | undefined {
  let candidate = dirname(executablePath);
  while (true) {
    if (basename(candidate).endsWith(".app")) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

const MACH_O_MAGICS = new Set([
  "cafebabe",
  "cafebabf",
  "bebafeca",
  "bfbafeca",
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf",
]);
const SUPPORTED_GOOGLE_CHROME_IDENTIFIERS = new Set([
  "com.google.Chrome",
  "com.google.Chrome.beta",
  "com.google.Chrome.dev",
  "com.google.Chrome.canary",
]);

async function codesignOutput(
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<Readonly<{ exitCode: number; output: string }>> {
  throwIfRuntimeInspectionAborted(signal);
  const subprocess = Bun.spawn(["/usr/bin/codesign", ...argv], {
    env: {
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill("SIGKILL");
  }, CODESIGN_TIMEOUT_MS);
  const abort = (): void => subprocess.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted === true) abort();
  const readBounded = async (
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > CODESIGN_MAXIMUM_OUTPUT_BYTES) {
          subprocess.kill("SIGKILL");
          throw new ApplicationError(
            "invalid-data",
            "Browser code-signature output is oversized.",
          );
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  };
  let exitCode: number;
  let stderr: string;
  let stdout: string;
  try {
    [exitCode, stderr, stdout] = await Promise.all([
      subprocess.exited,
      readBounded(subprocess.stderr),
      readBounded(subprocess.stdout),
    ]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  throwIfRuntimeInspectionAborted(signal);
  if (timedOut) {
    throw new ApplicationError(
      "unavailable",
      `Browser code-signature verification exceeded ${String(CODESIGN_TIMEOUT_MS)}ms.`,
    );
  }
  const output = `${stdout}\n${stderr}`.trim();
  return { exitCode, output };
}

export async function inspectSupportedHtmlOverlayMacBrowserProvenance(
  bundleRoot: string,
  executablePath: string,
  signal?: AbortSignal,
): Promise<Readonly<{
  bundleIdentifier: "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.dev" | "com.google.Chrome.canary";
  designatedRequirementSha256: string;
  kind: "verified-macos-code-signature";
  teamIdentifier: "EQHXZ8M8AV";
}>> {
  throwIfRuntimeInspectionAborted(signal);
  const handle = await open(executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.byteLength, 0);
    if (bytesRead !== magic.byteLength || !MACH_O_MAGICS.has(magic.toString("hex"))) {
      throw new ApplicationError(
        "unsafe-path",
        "HTML browser app launcher is not a native Mach-O executable.",
      );
    }
  } finally {
    await handle.close();
  }
  if (process.platform !== "darwin") {
    throw new ApplicationError(
      "unavailable",
      "This desktop build currently requires a verified macOS Chrome app runtime.",
    );
  }
  const [verification, details, requirement] = await Promise.all([
    codesignOutput(["--verify", "--deep", "--verbose=2", bundleRoot], signal),
    codesignOutput(["-dv", "--verbose=4", bundleRoot], signal),
    codesignOutput(["-dr", "-", bundleRoot], signal),
  ]);
  if (verification.exitCode !== 0 || details.exitCode !== 0 || requirement.exitCode !== 0) {
    throw new ApplicationError(
      "conflict",
      "HTML browser app bundle failed deep code-signature verification.",
    );
  }
  const bundleIdentifier = /^Identifier=(.+)$/mu.exec(details.output)?.[1]?.trim();
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(details.output)?.[1]?.trim();
  const signedExecutable = /^Executable=(.+)$/mu.exec(details.output)?.[1]?.trim();
  const designatedRequirement = /^designated => (.+)$/mu.exec(
    requirement.output,
  )?.[1]?.trim();
  const physicalExecutablePath = await realpath(executablePath);
  const physicalSignedExecutable = signedExecutable === undefined
    ? undefined
    : await realpath(signedExecutable).catch(() => undefined);
  if (
    bundleIdentifier === undefined
    || !SUPPORTED_GOOGLE_CHROME_IDENTIFIERS.has(bundleIdentifier)
    || teamIdentifier !== "EQHXZ8M8AV"
    || physicalSignedExecutable !== physicalExecutablePath
    || designatedRequirement === undefined
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "HTML browser app is not a directly launched supported Google Chrome distribution.",
    );
  }
  return {
    bundleIdentifier: bundleIdentifier as "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.dev" | "com.google.Chrome.canary",
    designatedRequirementSha256: createHash("sha256")
      .update(designatedRequirement)
      .digest("hex"),
    kind: "verified-macos-code-signature",
    teamIdentifier: "EQHXZ8M8AV",
  };
}

export async function assertSupportedHtmlOverlayBrowserExecutablePath(
  executablePathInput: string,
  signal?: AbortSignal,
): Promise<string> {
  const executablePath = await realpath(executablePathInput);
  const bundleRoot = appBundleRoot(executablePath);
  if (bundleRoot === undefined) {
    throw new ApplicationError(
      "unsafe-path",
      "HTML browser candidate is not inside a supported .app runtime.",
    );
  }
  const executableRelativePath = relative(bundleRoot, executablePath)
    .split(sep)
    .join("/");
  if (!/^Contents\/MacOS\/[^/]+$/u.test(executableRelativePath)) {
    throw new ApplicationError(
      "unsafe-path",
      "HTML browser candidate is not its app bundle's direct native executable.",
    );
  }
  await inspectSupportedHtmlOverlayMacBrowserProvenance(
    bundleRoot,
    executablePath,
    signal,
  );
  return executablePath;
}

export async function inspectHtmlOverlayBrowserRuntime(
  sourceRoot: string,
  layout: HtmlOverlayBrowserRuntimeManifest["layout"],
  executableRelativePath: string,
  signal?: AbortSignal,
): Promise<HtmlOverlayBrowserRuntimeManifest> {
  throwIfRuntimeInspectionAborted(signal);
  const entries: HtmlOverlayBrowserRuntimeEntry[] = [];
  await inspectEntry(sourceRoot, sourceRoot, ".", entries, signal);
  throwIfRuntimeInspectionAborted(signal);
  entries.sort((left, right) => asciiCompare(left.path, right.path));
  const totalBytes = entries.reduce(
    (total, entry) => total + (entry.kind === "file" ? entry.bytes : 0),
    0,
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAXIMUM_RUNTIME_BYTES) {
    throw new ApplicationError("invalid-data", "Browser runtime has an invalid total byte count.");
  }
  const manifestWithoutRoot = {
    entries,
    executableRelativePath,
    layout,
    schemaVersion: 1 as const,
    totalBytes,
  };
  return HtmlOverlayBrowserRuntimeManifestSchema.parse({
    ...manifestWithoutRoot,
    rootSha256: runtimeRootSha256(manifestWithoutRoot),
  });
}

export function assertHtmlOverlayBrowserRuntimeManifest(
  actual: HtmlOverlayBrowserRuntimeManifest,
  expected: HtmlOverlayBrowserRuntimeManifest,
  label: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ApplicationError(
      "conflict",
      `Browser runtime changed ${label}; refusing to launch unbound code.`,
    );
  }
}

export async function bindHtmlOverlayBrowserRuntime(
  capabilityInput: ExactCapabilityBinding,
  signal?: AbortSignal,
  options: Readonly<{
    readonly allowUnverifiedRuntimeForTesting?: boolean;
    readonly duringProvenanceInspectionForTesting?: () => Promise<void>;
  }> = {},
): Promise<HtmlOverlayBrowserRuntimeBinding> {
  throwIfRuntimeInspectionAborted(signal);
  const capability = ExactCapabilityBindingSchema.parse(capabilityInput);
  const bundleRoot = appBundleRoot(capability.executablePath);
  if (bundleRoot === undefined && options.allowUnverifiedRuntimeForTesting !== true) {
    throw new ApplicationError(
      "unsafe-path",
      "HTML browser must resolve directly to a supported .app runtime; wrapper and unbound distribution launchers are rejected.",
    );
  }
  const layout = bundleRoot === undefined
    ? "single-executable" as const
    : "macos-app-bundle" as const;
  const sourceRoot = bundleRoot ?? capability.executablePath;
  const executableRelativePath = bundleRoot === undefined
    ? "."
    : relative(bundleRoot, capability.executablePath).split(sep).join("/");
  if (!isSafeRelativeRuntimePath(executableRelativePath)) {
    throw new ApplicationError("unsafe-path", "Browser executable is outside its runtime root.");
  }
  if (
    layout === "macos-app-bundle"
    && !/^Contents\/MacOS\/[^/]+$/u.test(executableRelativePath)
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "HTML browser must be the direct native executable in its .app Contents/MacOS directory.",
    );
  }
  const manifestBefore = await inspectHtmlOverlayBrowserRuntime(
    sourceRoot,
    layout,
    executableRelativePath,
    signal,
  );
  const identityBefore = await captureHtmlOverlayBrowserRuntimePathIdentity(
    sourceRoot,
    manifestBefore.entries,
    signal,
  );
  await options.duringProvenanceInspectionForTesting?.();
  const provenance = options.allowUnverifiedRuntimeForTesting === true
    ? { kind: "test-only-unverified" as const }
    : await inspectSupportedHtmlOverlayMacBrowserProvenance(
        sourceRoot,
        capability.executablePath,
        signal,
      );
  const manifest = await inspectHtmlOverlayBrowserRuntime(
    sourceRoot,
    layout,
    executableRelativePath,
    signal,
  );
  const identityAfter = await captureHtmlOverlayBrowserRuntimePathIdentity(
    sourceRoot,
    manifest.entries,
    signal,
  );
  if (
    canonicalJson(manifest) !== canonicalJson(manifestBefore)
    || canonicalJson(identityAfter) !== canonicalJson(identityBefore)
  ) {
    throw new ApplicationError(
      "conflict",
      "Browser runtime changed while its signed provenance was verified.",
    );
  }
  const executable = manifest.entries.find(
    entry => entry.path === executableRelativePath,
  );
  if (
    executable?.kind !== "file"
    || (executable.mode & 0o111) === 0
    || executable.bytes !== capability.bytes
    || executable.sha256 !== capability.executableSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Browser executable does not match the complete runtime manifest.",
    );
  }
  return HtmlOverlayBrowserRuntimeBindingSchema.parse({
    capability,
    manifest,
    provenance,
    sourceRoot,
  });
}
