import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checksums, hash, packageName, parseManifest, repository, repositoryId, verifyHandoff, workflow } from "./github-release";
import { verifyArchive } from "./npm-package-identity";
import { verifyNpmPublishManifest } from "./npm-publish-policy";

const [directoryArgument, ...extra] = process.argv.slice(2);
if (!directoryArgument || extra.length !== 0) throw new Error("Usage: bun scripts/prepare-github-release.ts <packed-directory>");
const directory = resolve(directoryArgument);
const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
verifyNpmPublishManifest(manifest);
if (manifest === null || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") throw new Error("Missing package version.");
const archiveName = `hraness-slopcamera-${manifest.version}.tgz`;
await verifyArchive(join(directory, archiveName), join(directory, "npm-pack.json"), "Canonical GitHub release", packageName, manifest.version, archiveName);
const archive = await readFile(join(directory, archiveName));
const releaseManifest = parseManifest({ schema: "hraness-github-release-v1", repository, repositoryId, package: packageName,
  version: manifest.version, tag: `v${manifest.version}`, sourceSha: process.env.GITHUB_SHA,
  workflow, workflowSha: process.env.CURRENT_AUTHORITY_SHA,
  runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  archive: { name: archiveName, bytes: archive.length, sha256: hash(archive), sha512: hash(archive, "sha512") } });
await writeFile(join(directory, "release-manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`, { flag: "wx" });
const files = new Map<string, Buffer>();
for (const name of [archiveName, "npm-pack.json", "release-manifest.json"]) files.set(name, await readFile(join(directory, name)));
await writeFile(join(directory, "SHA256SUMS"), checksums(files), { flag: "wx" });
const handoff = await verifyHandoff(directory, false);
if (!process.env.GITHUB_OUTPUT) throw new Error("Release preparation requires an Actions output boundary.");
for (const [name, key] of [[archiveName, "archive_sha256"], ["npm-pack.json", "pack_sha256"], ["release-manifest.json", "manifest_sha256"], ["SHA256SUMS", "sums_sha256"]] as const) {
  await writeFile(process.env.GITHUB_OUTPUT, `${key}=${hash(handoff.files.get(name)!)}\n`, { flag: "a" });
}
