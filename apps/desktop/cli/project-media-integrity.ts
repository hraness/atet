import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createNodeBundleFileSystem } from "../core/storage";
import { CliError } from "./errors";

export interface ExpectedProjectMediaIntegrity {
  readonly bytes: number;
  readonly sha256: string;
}

export interface PhysicalProjectMediaFingerprint extends ExpectedProjectMediaIntegrity {
  readonly path: string;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

function validateExpectation(expected: ExpectedProjectMediaIntegrity, label: string): void {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) {
    throw new CliError("invalid-data", `${label} has an invalid expected byte length.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(expected.sha256)) {
    throw new CliError("invalid-data", `${label} has an invalid expected SHA-256 digest.`);
  }
}

export async function fingerprintPhysicalProjectMedia(
  path: string,
  maximumBytes: number,
): Promise<PhysicalProjectMediaFingerprint> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new CliError("invalid-data", "Project media fingerprint byte bound must be positive.");
  }
  const lexical = await lstat(path);
  if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size <= 0 || lexical.size > maximumBytes) {
    throw new CliError("unsafe-path", `Project media must be a bounded physical regular file: ${path}`);
  }
  try {
    // The shared inspector pins one physical descriptor, bounds each read, and
    // accepts a metadata-only invalidation only after a stable second pass
    // reproduces the exact first digest. This never repeats an ingest or render.
    const integrity = await createNodeBundleFileSystem(dirname(path)).inspectFile!(basename(path), maximumBytes);
    if (integrity.bytes !== lexical.size) throw new Error("Project media byte length changed after admission.");
    return { ...integrity, path };
  } catch (cause) {
    throw new CliError("conflict", `Project media changed during validation: ${path}`, { cause });
  }
}

export async function verifyPhysicalProjectMedia(
  path: string,
  expected: ExpectedProjectMediaIntegrity,
  label: string,
): Promise<string> {
  validateExpectation(expected, label);
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new CliError("unsafe-path", `${label} must be a physical regular file.`);
  }
  if (details.size !== expected.bytes) {
    throw new CliError(
      "invalid-data",
      `${label} byte length changed: expected ${expected.bytes}, received ${details.size}.`,
    );
  }
  const actual = await fingerprintPhysicalProjectMedia(path, expected.bytes);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new CliError("invalid-data", `${label} failed its recorded SHA-256 integrity check.`);
  }
  return actual.path;
}

export async function resolveVerifiedProjectMedia(options: {
  readonly expected: ExpectedProjectMediaIntegrity;
  readonly label: string;
  readonly path: string;
  readonly repositoryRoot: string;
}): Promise<string> {
  const actual = await resolvePhysicalProjectMedia(options.repositoryRoot, options.path);
  return await verifyPhysicalProjectMedia(actual, options.expected, options.label);
}

export async function resolvePhysicalProjectMedia(
  repositoryRoot: string,
  path: string,
): Promise<string> {
  const root = await realpath(repositoryRoot);
  const lexical = resolve(root, path);
  if (!isWithin(root, lexical)) {
    throw new CliError("unsafe-path", `Project media path escapes the repository: ${path}`);
  }
  const pathFromRoot = relative(root, lexical);
  const parts = pathFromRoot === "" ? [] : pathFromRoot.split(sep);
  if (parts.length === 0) {
    throw new CliError("unsafe-path", `Project media path must identify a file: ${path}`);
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const details = await lstat(current);
    const leaf = index === parts.length - 1;
    if (details.isSymbolicLink() || (leaf ? !details.isFile() : !details.isDirectory())) {
      throw new CliError(
        "unsafe-path",
        `Project media path must use physical directories and a physical regular file: ${path}`,
      );
    }
  }
  const actual = await realpath(lexical);
  if (!isWithin(root, actual)) {
    throw new CliError("unsafe-path", `Project media path resolves outside the repository: ${path}`);
  }
  return actual;
}
