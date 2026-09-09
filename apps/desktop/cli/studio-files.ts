import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../../../src/code/canonical-json";
import {
  parseStudioSourceBundle, StudioPathSchema, studioOutputPath, studioSourceBundleSha256,
  type StudioJob, type StudioOutputArtifact, type StudioSourceBundle,
} from "../../../src/studio";
import { createNodeBundleFileSystem } from "../core/storage";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";

export const studioBytesSha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const studioJson = (value: unknown): string => `${canonicalJson(value)}\n`;

export async function readStudioFileEdges(path: string, expectedBytes: number, edgeBytes = 256): Promise<{ readonly first: Buffer; readonly last: Buffer }> {
  if (!Number.isInteger(edgeBytes) || edgeBytes < 1 || edgeBytes > 1_048_576) throw new Error("Invalid studio header bound.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedBytes)) throw new Error("Studio output changed before header validation.");
    const length = Math.min(edgeBytes, expectedBytes), first = Buffer.alloc(length), last = Buffer.alloc(length);
    const a = await handle.read(first, 0, length, 0), b = await handle.read(last, 0, length, expectedBytes - length);
    const after = await handle.stat({ bigint: true });
    if (a.bytesRead !== length || b.bytesRead !== length || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Studio output changed during header validation.");
    return { first, last };
  } finally { await handle.close(); }
}

export async function readStudioBytes(path: string, expected: { readonly bytes: number; readonly sha256: string }, maximumBytes: number): Promise<Buffer> {
  if (expected.bytes > maximumBytes) throw new Error("Studio binary exceeds its decode profile.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.bytes)) throw new Error("Studio binary changed before decode.");
    const bytes = Buffer.alloc(expected.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset);
      if (result.bytesRead === 0) throw new Error("Studio binary ended during decode capture.");
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || studioBytesSha256(bytes) !== expected.sha256) throw new Error("Studio binary changed during decode capture.");
    return bytes;
  } finally { await handle.close(); }
}

export async function studioPhysicalRoot(path: string): Promise<string> {
  const root = resolve(path), stat = await lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Studio root must be a physical directory.");
  return await realpath(root);
}

/** The source root is selected explicitly; only named files are read. */
export async function captureStudioSource(input: {
  readonly sourceRoot: string; readonly engine: StudioSourceBundle["engine"];
  readonly entrypoint: StudioSourceBundle["entrypoint"]; readonly files: readonly string[];
}): Promise<StudioSourceBundle> {
  if (input.files.length < 1 || input.files.length > 512) throw new Error("Studio sources require 1–512 explicit files.");
  const root = await studioPhysicalRoot(input.sourceRoot), fs = createNodeBundleFileSystem(root);
  const files = [];
  let bytes = 0;
  for (const path of input.files) {
    StudioPathSchema.parse(path);
    const integrity = await fs.inspectFile!(path, 4_294_967_296 - bytes);
    bytes += integrity.bytes;
    files.push({ path, ...integrity });
  }
  return parseStudioSourceBundle({ kind: "atet.studio-source-bundle", schemaVersion: 1, engine: input.engine, entrypoint: input.entrypoint, files });
}

export async function verifyStudioSource(sourceRoot: string, bundle: StudioSourceBundle): Promise<void> {
  const fs = createNodeBundleFileSystem(await studioPhysicalRoot(sourceRoot));
  const inventory = await inventoryStudioFiles(sourceRoot, 512, 4_294_967_296);
  if (inventory.length !== bundle.files.length || inventory.some(item => !bundle.files.some(file => file.path === item.path && file.bytes === item.bytes))) throw new Error("Retained studio source contains an undeclared or changed file.");
  for (const file of bundle.files) {
    const found = await fs.inspectFile!(file.path, file.bytes);
    if (found.bytes !== file.bytes || found.sha256 !== file.sha256) throw new Error(`Studio source changed: ${file.path}`);
  }
}

/** Reuse the storage layer's inode-pinned exact copy and no-replace publication across two explicit roots. */
export async function copyStudioSource(sourceRoot: string, destinationRoot: string, bundle: StudioSourceBundle, fence: () => Promise<void>): Promise<void> {
  const source = await studioPhysicalRoot(sourceRoot), destination = await studioPhysicalRoot(destinationRoot);
  let ancestor = source;
  while (relative(ancestor, destination) === ".." || relative(ancestor, destination).startsWith(`..${sep}`)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Studio source and destination do not share a filesystem root.");
    ancestor = parent;
  }
  if (parse(source).root !== parse(destination).root) throw new Error("Studio copies require a shared filesystem root.");
  const fs = createNodeBundleFileSystem(ancestor);
  for (const file of bundle.files) {
    await fs.copyFileNoReplace!(relative(ancestor, join(source, file.path)), relative(ancestor, join(destination, file.path)), file, fence);
  }
}

export async function retainStudioSource(input: {
  readonly studioRoot: string; readonly sourceRoot: string; readonly bundle: StudioSourceBundle; readonly fence: () => Promise<void>;
}): Promise<{ readonly bundle: StudioSourceBundle; readonly bundleSha256: string; readonly sourceRoot: string }> {
  const bundle = parseStudioSourceBundle(input.bundle), bundleSha256 = studioSourceBundleSha256(bundle);
  const directory = await ensurePhysicalPrivateDirectoryWithin(input.studioRoot, `bundles/${bundleSha256}`);
  const sourceRoot = await ensurePhysicalPrivateDirectoryWithin(directory, "source");
  await copyStudioSource(input.sourceRoot, sourceRoot, bundle, input.fence);
  const fs = createNodeBundleFileSystem(directory), text = studioJson(bundle);
  const disposition = await fs.writeTextNoReplace!("bundle.json", text, input.fence);
  if (disposition !== "created" && await fs.readText("bundle.json") !== text) throw new Error("Retained studio bundle conflicts with its digest.");
  await verifyStudioSource(sourceRoot, bundle);
  return { bundle, bundleSha256, sourceRoot };
}

export interface StudioFileInventory { readonly path: string; readonly bytes: number }

/** Bounded traversal is restricted to the newly owned output/cache directory, never an asset source. */
export async function inventoryStudioFiles(rootInput: string, maximumFiles: number, maximumBytes: number, mode: "settled" | "live" = "settled"): Promise<readonly StudioFileInventory[]> {
  const root = await studioPhysicalRoot(rootInput), found: StudioFileInventory[] = [];
  const rootIdentity = await lstat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new Error("Studio output root must remain a physical directory.");
  const pending = [""], names = new Set<string>();
  // Native caches atomically rename and remove temporary descendants. A live
  // observation may omit an already removed entry; settled publication may not.
  const disappeared = (error: unknown): boolean => mode === "live" && error instanceof Error && "code" in error && error.code === "ENOENT";
  let bytes = 0, entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let directory;
    try { directory = await opendir(join(root, current)); }
    catch (error) { if (current !== "" && disappeared(error)) continue; throw error; }
    for await (const entry of directory) {
      if (++entries > maximumFiles * 8 + 1024) throw new Error("Studio output directory-entry budget exceeded.");
      const path = current === "" ? entry.name : `${current}/${entry.name}`;
      StudioPathSchema.parse(path);
      if (path.split("/").length > 32 || names.has(path.toLowerCase())) throw new Error("Studio output paths exceed depth or collide.");
      names.add(path.toLowerCase());
      let stat;
      try { stat = await lstat(join(root, path)); }
      catch (error) { if (disappeared(error)) continue; throw error; }
      // APFS can return the just-unlinked inode with nlink=0 instead of ENOENT.
      // Reobserve once; only disappearance or a valid replacement can pass.
      if (mode === "live" && stat.isFile() && stat.nlink === 0) {
        try { stat = await lstat(join(root, path)); }
        catch (error) { if (disappeared(error)) continue; throw error; }
      }
      if (stat.isSymbolicLink()) throw new Error("Studio outputs cannot contain symlinks.");
      if (stat.isDirectory()) pending.push(path);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)) throw new Error("Studio output must be a singly linked regular file.");
        bytes += stat.size;
        if (found.length >= maximumFiles || bytes > maximumBytes) throw new Error("Studio output budget exceeded.");
        found.push({ path, bytes: stat.size });
      }
    }
  }
  // Disappearance of the owned root itself is always a failure, including when
  // an open directory iterator could otherwise finish after its unlink.
  if (await studioPhysicalRoot(rootInput) !== root) throw new Error("Studio output root changed during inventory.");
  const after = await lstat(root, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== rootIdentity.dev || after.ino !== rootIdentity.ino) throw new Error("Studio output root changed during inventory.");
  return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function inspectStudioOutputs(root: string, job: StudioJob): Promise<readonly StudioOutputArtifact[]> {
  const inventory = await inventoryStudioFiles(root, job.limits.maximumOutputFiles, job.limits.maximumOutputBytes);
  const files = new Map<string, { readonly output: StudioJob["outputs"][number]; readonly frame?: number }>();
  for (const output of job.outputs) {
    if (output.kind === "file") files.set(output.path, { output });
    else if (output.kind === "sequence") for (let frame = job.render!.startFrame; frame < job.render!.endFrameExclusive; frame++) files.set(studioOutputPath(output, frame), { output, frame });
  }
  const fs = createNodeBundleFileSystem(root), artifacts: StudioOutputArtifact[] = [];
  for (const item of inventory) {
    const match = files.get(item.path);
    const output = match?.output ?? job.outputs.find(output => output.kind === "directory" && item.path.startsWith(`${output.path}/`));
    if (output === undefined || item.bytes === 0) throw new Error(`Undeclared or empty studio output: ${item.path}`);
    const integrity = await fs.inspectFile!(item.path, item.bytes);
    artifacts.push({ outputId: output.id, path: item.path, ...integrity, role: output.role, format: output.format, ...(match?.frame === undefined ? {} : { frame: match.frame }) });
  }
  return artifacts;
}
