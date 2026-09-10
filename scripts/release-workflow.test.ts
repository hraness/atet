import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

import { verifyNpmPackageIdentity } from "./npm-package-identity"
import { publishedArchiveUrl, publishedRelease, sourceInstall } from "../apps/web/src/published-release"
import { homeMarkdown } from "../apps/web/src/agent-pages"
import { verifyNpmPublishAuthority } from "./npm-publish-authority"
import { verifyNpmPublishConfig, verifyNpmPublishManifest } from "./npm-publish-policy"
import {
  admitPublishedGitHubRelease,
  admitRemoteReleaseTags,
  parseReleaseVersion,
} from "./push-release-tag"

async function readWorkflow(
  sourceName: string,
  publicName: string,
): Promise<string> {
  const packageRoot = join(import.meta.dir, "..")
  const reviewedSource = join(packageRoot, sourceName)
  try {
    await access(reviewedSource)
    return await readFile(reviewedSource, "utf8")
  } catch (error) {
    if (!isMissingFile(error)) throw error
    return await readFile(
      join(packageRoot, ".github", "workflows", publicName),
      "utf8",
    )
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

function workflowStepScript(workflow: string, name: string): string {
  const stepMarker = `      - name: ${name}\n`
  const stepStart = workflow.indexOf(stepMarker)
  if (stepStart < 0) throw new Error(`Workflow step not found: ${name}`)
  const runMarker = "        run: |\n"
  const runStart = workflow.indexOf(runMarker, stepStart)
  if (runStart < 0) throw new Error(`Workflow step has no run script: ${name}`)
  const script: string[] = []
  for (const line of workflow.slice(runStart + runMarker.length).split("\n")) {
    if (line === "") {
      script.push("")
      continue
    }
    if (!line.startsWith("          ")) break
    script.push(line.slice(10))
  }
  return script.join("\n")
}

function requireOwnerReleaseAuthorization(workflow: string): void {
  const start = workflow.indexOf("  authorize:\n")
  const end = workflow.indexOf("\n  verify:\n")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("release.yml is missing the leading authorization job")
  }
  const authorize = workflow.slice(start, end)
  if (!authorize.includes('"$GITHUB_ACTOR_ID" != "$EXPECTED_ACTOR_ID"')) {
    throw new Error("release.yml is missing the exact event actor guard")
  }
  if (!authorize.includes("event.sender?.id !== Number(process.env.EXPECTED_ACTOR_ID)")) {
    throw new Error("release.yml is missing the exact event sender guard")
  }
  if (!authorize.includes('event.sender?.type !== "User"')) {
    throw new Error("release.yml is missing the immutable sender type guard")
  }
  const firstCheckout = workflow.indexOf("actions/checkout@")
  if (firstCheckout === -1 || firstCheckout < end) {
    throw new Error("release.yml must authorize before checkout")
  }
}

async function runWorkflowScript(
  script: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn(["/bin/bash", "-c", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return Object.freeze({ exitCode, stderr, stdout })
}

test("public CI routes independent Slopcamera SDK, local-runtime, site, and native proofs", async () => {
  const workflow = await readWorkflow("public-ci.yml", "ci.yml")

  expect(workflow).toContain("plan:\n    name: Plan")
  expect(workflow).toContain("boundary:\n    name: Slopcamera standalone boundary")
  expect(workflow).toContain("sdk:\n    name: Slopcamera SDK")
  expect(workflow).toContain("desktop:\n    name: Slopcamera local runtime")
  expect(workflow).toContain("site:\n    name: Slopcamera site")
  expect(workflow).toContain("package:\n    name: Slopcamera packed consumer")
  expect(workflow).toContain("native:\n    name: Slopcamera macOS shell")
  expect(workflow).toContain("if: needs.plan.outputs.sdk == 'true'")
  expect(workflow).toContain("if: needs.plan.outputs.desktop == 'true'")
  expect(workflow).toContain("if: needs.plan.outputs.site == 'true'")
  expect(workflow).toContain("if: needs.plan.outputs.package == 'true'")
  expect(workflow).toContain("if: needs.plan.outputs.native == 'true'")
  expect(workflow).toContain("bun run check:standalone")
  expect(workflow).toContain("bun run check:sdk")
  expect(workflow).toContain("bun run check:desktop")
  expect(workflow).toContain("bash scripts/install-ci-ffmpeg.sh")
  expect(workflow).toContain("bun run check:web")
  expect(workflow).toContain("bun run test:package")
  expect(workflow).toContain("bun run test:desktop:macos")
  expect(workflow).toContain("bun run package:desktop:macos")
  expect(workflow).toContain(
    "mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29",
  )
  expect(workflow).toContain('version: "0.16.0"')
  expect(workflow).toContain("git status --porcelain --untracked-files=all -- dist bun.lock")
  expect(workflow).toContain("git status --porcelain --untracked-files=all -- apps/desktop/dist/cli bun.lock")
  expect(workflow).toContain("needs: [plan, boundary, sdk, desktop, site, package, native]")
  expect(workflow).toContain('[[ "$result" == success || "$result" == skipped ]]')
  expect(workflow).not.toContain(`@${"jungle"}/`)
  expect(workflow).not.toContain(["projects", "slopcamera"].join("/"))
})

function requireCompleteSourceCoverage(workflow: string): void {
  let priorWorkflow = workflow
  for (const [job, phase, label] of [
    ["sdk", "check:sdk", "SDK"],
    ["desktop", "check:desktop", "desktop"],
    ["site", "check:web", "site"],
  ]) {
    const jobSource = workflow.match(new RegExp(`\\n  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z]+:\\n|$)`))?.[0]
    const scan = `      - name: Check generated ${label} standalone boundary\n        run: bun run check:standalone\n`
    if (jobSource === undefined || jobSource.split(scan).length !== 2
      || jobSource.indexOf(scan) < jobSource.indexOf(`bun run ${phase}`)) {
      throw new Error(`CI must scan ${job} generated output after its complete phase`)
    }
    priorWorkflow = priorWorkflow.replace(scan, "")
  }
  // This additive comparison preserves every prior job, condition, command,
  // deadline and failure boundary. A future update needs a coverage review.
  const priorDigest = createHash("sha256").update(priorWorkflow).digest("hex")
  if (priorDigest !== "32f2de3515f5873abff676c478045898af79d51e7ccc91d5c1b4137893825de8") {
    throw new Error("CI differs from the independently reviewed prior coverage")
  }
}

test("complete source CI preserves every aggregate phase and adds post-build scans without weakening prior coverage", async () => {
  const workflow = await readWorkflow("public-ci.yml", "ci.yml")
  const root = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8"))
  const site = JSON.parse(await readFile(join(import.meta.dir, "../apps/web/package.json"), "utf8"))
  expect(root.scripts.check.split(" && ")).toEqual([
    "bun run check:standalone", "bun run check:sdk", "bun run check:desktop",
    "bun run check:web", "bun run check:standalone", "bun run test:package",
  ])
  expect(root.scripts["check:sdk"].split(" && ")).toEqual([
    "bun run typecheck:sdk", "bun run lint:sdk", "bun run build:sdk",
    "bun run test:sdk", "bun run check:release-workflows", "bun run check:schema", "bun run check:skill",
  ])
  expect(root.scripts["check:desktop"].split(" && ")).toEqual([
    "bun run check:effect", "bun run typecheck:desktop", "bun run lint:desktop",
    "bun run test:desktop", "bun run build:desktop",
  ])
  expect(root.scripts["check:web"]).toBe("bun run --cwd apps/web check")
  expect(site.scripts.check.split(" && ")).toEqual([
    "bun run typecheck:preview", "bun run test", "bun run build", "bun run verify:preview",
  ])
  expect(() => requireCompleteSourceCoverage(workflow)).not.toThrow()

  const sdkScan = "      - name: Check generated SDK standalone boundary\n        run: bun run check:standalone\n"
  expect(() => requireCompleteSourceCoverage(workflow.replace(sdkScan, ""))).toThrow("after its complete phase")
  expect(() => requireCompleteSourceCoverage(workflow.replace(
    `      - run: bun run check:sdk\n${sdkScan}`, `${sdkScan}      - run: bun run check:sdk\n`,
  ))).toThrow("after its complete phase")
  expect(() => requireCompleteSourceCoverage(workflow.replace(
    "if: needs.plan.outputs.sdk == 'true'", "if: false",
  ))).toThrow("prior coverage")
  expect(() => requireCompleteSourceCoverage(workflow.replace(
    "      - run: bun run check:desktop\n", "      - run: bun run check:desktop\n        continue-on-error: true\n",
  ))).toThrow("prior coverage")
})

test("site CI installs app-pinned Chromium in runner temp before the unchanged native gate", async () => {
  const workflow = await readWorkflow("public-ci.yml", "ci.yml")
  const site = workflow.slice(workflow.indexOf("\n  site:\n"), workflow.indexOf("\n  package:\n"))
  expect(site).toContain("timeout-minutes: 10")
  expect(site).toContain('bun-version: "1.3.14"')
  expect(site).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")
  expect(site).toContain('node-version: "24.18.1"')
  expect(site).toContain("package-manager-cache: false")
  expect(site).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(site.indexOf("bun install --frozen-lockfile --ignore-scripts")).toBeLessThan(
    site.indexOf("Verify the site with pinned Node and Chromium"),
  )
  const script = workflowStepScript(site, "Verify the site with pinned Node and Chromium")
  expect(script.trim().split("\n")).toEqual([
    "set -euo pipefail",
    'NODE_EXECUTABLE_PATH="$(command -v node)"',
    'PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d "$RUNNER_TEMP/slopcamera-playwright.XXXXXX")"',
    "export NODE_EXECUTABLE_PATH PLAYWRIGHT_BROWSERS_PATH",
    'playwright_cli="$("$NODE_EXECUTABLE_PATH" -e \'const { createRequire } = require("node:module"); const { dirname, resolve } = require("node:path"); const appRequire = createRequire(resolve("apps/web/package.json")); const manifest = appRequire.resolve("playwright-core/package.json"); console.log(resolve(dirname(manifest), appRequire(manifest).bin["playwright-core"]))\')"',
    '"$NODE_EXECUTABLE_PATH" "$playwright_cli" install --no-shell chromium',
    'SLOPCAMERA_CHROME_PATH="$("$NODE_EXECUTABLE_PATH" -e \'const { createRequire } = require("node:module"); const { resolve } = require("node:path"); console.log(createRequire(resolve("apps/web/package.json"))("playwright-core").chromium.executablePath())\')"',
    'test -x "$SLOPCAMERA_CHROME_PATH"',
    "export SLOPCAMERA_CHROME_PATH",
    "bun run check:web",
  ])
})

test("hostile actor or sender drift cannot reach the protected release workflow", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")
  expect(() => requireOwnerReleaseAuthorization(workflow)).not.toThrow()

  const actorDrift = workflow.replace(
    '"$GITHUB_ACTOR_ID" != "$EXPECTED_ACTOR_ID"',
    '"$GITHUB_ACTOR_ID" == "$EXPECTED_ACTOR_ID"',
  )
  expect(actorDrift).not.toBe(workflow)
  expect(() => requireOwnerReleaseAuthorization(actorDrift)).toThrow(
    "exact event actor guard",
  )

  const senderDrift = workflow.replace(
    "event.sender?.id !== Number(process.env.EXPECTED_ACTOR_ID)",
    "event.sender?.id !== 894120",
  )
  expect(senderDrift).not.toBe(workflow)
  expect(() => requireOwnerReleaseAuthorization(senderDrift)).toThrow(
    "exact event sender guard",
  )
})

interface PackageFixtureEntry {
  readonly body: string
  readonly mode: number
  readonly path: string
  readonly type?: "file" | "symbolic-link"
}

function writeTarOctal(
  header: Buffer,
  start: number,
  length: number,
  value: number,
): void {
  const digits = value.toString(8).padStart(length - 1, "0")
  header.write(`${digits}\0`, start, length, "ascii")
}

function packageFixtureTar(
  entries: readonly PackageFixtureEntry[],
  transportVariant = false,
): Buffer {
  const blocks: Buffer[] = []
  for (const entry of transportVariant ? entries.toReversed() : entries) {
    const header = Buffer.alloc(512)
    const path = `package/${entry.path}`
    header.write(path, 0, 100, "utf8")
    writeTarOctal(header, 100, 8, entry.mode)
    writeTarOctal(header, 108, 8, transportVariant ? 501 : 0)
    writeTarOctal(header, 116, 8, transportVariant ? 20 : 0)
    const body = entry.type === "symbolic-link" ? Buffer.alloc(0) : Buffer.from(entry.body)
    writeTarOctal(header, 124, 12, body.length)
    writeTarOctal(header, 136, 12, transportVariant ? 1_800_000_000 : 0)
    header.fill(32, 148, 156)
    header[156] = entry.type === "symbolic-link" ? "2".charCodeAt(0) : "0".charCodeAt(0)
    if (entry.type === "symbolic-link") header.write(entry.body, 157, 100, "utf8")
    header.write("ustar\0", 257, 6, "ascii")
    header.write("00", 263, 2, "ascii")
    if (transportVariant) {
      header.write("publisher", 265, 32, "utf8")
      header.write("staff", 297, 32, "utf8")
    }
    const checksum = header.reduce((total, byte) => total + byte, 0)
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii")
    header[154] = 0
    header[155] = 32
    blocks.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function npmPackFixture(
  archive: Buffer,
  entries: readonly PackageFixtureEntry[],
  reverseFiles = false,
): readonly Record<string, unknown>[] {
  const files = entries.map(entry => ({
    mode: entry.mode,
    path: entry.path,
    size: entry.type === "symbolic-link" ? 0 : Buffer.byteLength(entry.body),
  }))
  if (reverseFiles) files.reverse()
  return [{
    bundled: [],
    entryCount: files.length,
    filename: "hraness-slopcamera-3.2.0.tgz",
    files,
    id: "@hraness/slopcamera@3.2.0",
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    name: "@hraness/slopcamera",
    shasum: createHash("sha1").update(archive).digest("hex"),
    size: archive.length,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    version: "3.2.0",
  }]
}

const packedRequiredPaths = [
  "PRIVACY.md",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "SECURITY.md",
  "apps/desktop/dist/cli/main.js",
  "apps/desktop/dist/cli/NebulaSans-Bold-26se8aek.otf",
  "apps/desktop/dist/cli/NebulaSans-Bold-bcz7y08t.woff2",
  "apps/desktop/dist/cli/NebulaSans-Book-5ax05zvn.woff2",
  "apps/desktop/dist/cli/NebulaSans-Book-8cenzchw.otf",
  "dist/NebulaSans-Bold-26se8aek.otf",
  "dist/NebulaSans-Bold-bcz7y08t.woff2",
  "dist/NebulaSans-Book-5ax05zvn.woff2",
  "dist/NebulaSans-Book-8cenzchw.otf",
  "package.json",
  "skills/slopcamera/SKILL.md",
  "src/assets/fonts/nebula-sans/LICENSE.txt",
  "src/assets/fonts/nebula-sans/NebulaSans-Bold.otf",
  "src/assets/fonts/nebula-sans/NebulaSans-Bold.woff2",
  "src/assets/fonts/nebula-sans/NebulaSans-Book.otf",
  "src/assets/fonts/nebula-sans/NebulaSans-Book.woff2",
  "src/assets/fonts/nebula-sans/PROVENANCE.md",
] as const

function tarEntryOffset(tar: Buffer, expectedPath: string): number {
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number): string => {
      const bytes = header.subarray(start, start + length)
      const zero = bytes.indexOf(0)
      return (zero < 0 ? bytes : bytes.subarray(0, zero)).toString("utf8")
    }
    const name = field(0, 100)
    const prefix = field(345, 155)
    const path = prefix === "" ? name : `${prefix}/${name}`
    const sizeText = field(124, 12).trim()
    if (!/^[0-7]+$/u.test(sizeText)) throw new Error("Test tar entry size is invalid")
    if (path === expectedPath) return offset
    offset += 512 + Math.ceil(Number.parseInt(sizeText, 8) / 512) * 512
  }
  throw new Error(`Test tar is missing ${expectedPath}`)
}

function rewriteTarChecksum(tar: Buffer, headerOffset: number): void {
  const header = tar.subarray(headerOffset, headerOffset + 512)
  header.fill(32, 148, 156)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii")
  header[154] = 0
  header[155] = 32
}

function rewriteTarPath(
  tar: Buffer,
  headerOffset: number,
  name: string,
  prefix = "",
): void {
  const header = tar.subarray(headerOffset, headerOffset + 512)
  header.fill(0, 0, 100)
  header.fill(0, 345, 500)
  header.write(name, 0, 100, "utf8")
  header.write(prefix, 345, 155, "utf8")
  rewriteTarChecksum(tar, headerOffset)
}

function replacePackedManifestText(tar: Buffer, before: string, after: string): void {
  if (Buffer.byteLength(before) !== Buffer.byteLength(after)) {
    throw new Error("Test packed-manifest replacement must preserve bytes")
  }
  const headerOffset = tarEntryOffset(tar, "package/package.json")
  const header = tar.subarray(headerOffset, headerOffset + 512)
  const sizeField = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim()
  const size = Number.parseInt(sizeField, 8)
  const bodyOffset = headerOffset + 512
  const body = tar.subarray(bodyOffset, bodyOffset + size).toString("utf8")
  if (!body.includes(before)) throw new Error("Test packed manifest lacks mutation target")
  Buffer.from(body.replace(before, after), "utf8").copy(tar, bodyOffset)
  const replaced = tar.subarray(bodyOffset, bodyOffset + size).toString("utf8")
  if (!replaced.includes(after) || replaced.includes(before)) {
    throw new Error("Test packed-manifest mutation did not persist")
  }
}

type ArchiveTarMutation = (tar: Buffer) => void

async function writeReleaseArtifactFixture(
  root: string,
  mutation?: ArchiveTarMutation,
): Promise<Readonly<{ archiveSha256: string; metadata: string; metadataSha256: string; registryView: string; tarball: string }>> {
  const artifactDirectory = join(root, "slopcamera-release")
  const tarballName = "hraness-slopcamera-3.2.0.tgz"
  const manifest = `${JSON.stringify({
    name: "@hraness/slopcamera",
    version: "3.2.0",
    type: "module",
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  })}\n`
  const entries: PackageFixtureEntry[] = packedRequiredPaths.map(path => ({
    body: path === "package.json" ? manifest : `fixture for ${path}\n`,
    mode: 0o644,
    path,
  }))
  const tar = packageFixtureTar(entries)
  mutation?.(tar)
  const archive = gzipSync(tar, { level: 9 })
  const pack = npmPackFixture(archive, entries)
  const packResult = pack[0]!
  const metadata = `${JSON.stringify(pack)}\n`
  const registryView = join(root, "npm-view.json")
  await mkdir(artifactDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(artifactDirectory, tarballName), archive),
    writeFile(join(artifactDirectory, "npm-pack.json"), metadata),
    writeFile(registryView, JSON.stringify({
      dist: {
        fileCount: packResult.entryCount,
        integrity: packResult.integrity,
        shasum: packResult.shasum,
        tarball: "https://registry.npmjs.org/@hraness/slopcamera/-/slopcamera-3.2.0.tgz",
        unpackedSize: packResult.unpackedSize,
      },
      name: "@hraness/slopcamera",
      version: "3.2.0",
    })),
  ])
  return {
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    metadata: join(artifactDirectory, "npm-pack.json"),
    metadataSha256: createHash("sha256").update(metadata).digest("hex"),
    registryView,
    tarball: join(artifactDirectory, tarballName),
  }
}

async function writePackageIdentityFixture(
  root: string,
  sourceEntries: readonly PackageFixtureEntry[],
  registryEntries: readonly PackageFixtureEntry[],
  transportOnlyDifference: boolean,
): Promise<Parameters<typeof verifyNpmPackageIdentity>[0]> {
  const sourceArchive = gzipSync(packageFixtureTar(sourceEntries), { level: 9 })
  const registryArchive = gzipSync(
    packageFixtureTar(registryEntries, transportOnlyDifference),
    { level: transportOnlyDifference ? 1 : 9 },
  )
  if (transportOnlyDifference) {
    registryArchive[9] = registryArchive[9] === 3 ? 0 : 3
  }
  const sourcePack = npmPackFixture(sourceArchive, sourceEntries)
  // npm's metadata order is transport output, not part of package identity.
  const registryPack = npmPackFixture(registryArchive, registryEntries, true)
  const registryResult = registryPack[0] ?? {}
  const registryView = {
    dist: {
      fileCount: registryResult.entryCount,
      integrity: registryResult.integrity,
      shasum: registryResult.shasum,
      tarball: "https://registry.npmjs.org/@hraness/slopcamera/-/slopcamera-3.2.0.tgz",
      unpackedSize: registryResult.unpackedSize,
    },
    name: "@hraness/slopcamera",
    version: "3.2.0",
  }
  const paths = {
    registryArchive: join(root, "registry", "hraness-slopcamera-3.2.0.tgz"),
    registryMetadata: join(root, "registry", "npm-pack.json"),
    registryView: join(root, "registry", "npm-view.json"),
    sourceArchive: join(root, "source", "hraness-slopcamera-3.2.0.tgz"),
    sourceMetadata: join(root, "source", "npm-pack.json"),
  }
  await Promise.all([
    mkdir(join(root, "registry"), { recursive: true }),
    mkdir(join(root, "source"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(paths.sourceArchive, sourceArchive),
    Bun.write(paths.sourceMetadata, JSON.stringify(sourcePack)),
    Bun.write(paths.registryArchive, registryArchive),
    Bun.write(paths.registryMetadata, JSON.stringify(registryPack)),
    Bun.write(paths.registryView, JSON.stringify(registryView)),
  ])
  return {
    expectedFilename: "hraness-slopcamera-3.2.0.tgz",
    expectedName: "@hraness/slopcamera",
    expectedVersion: "3.2.0",
    ...paths,
  }
}

test("npm release identity ignores transport metadata but binds contents, modes, and entry types", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopcamera-npm-identity-"))
  const ordinary = [
    { body: "read me\n", mode: 0o644, path: "README.md" },
    { body: '{"name":"@hraness/slopcamera","version":"3.2.0"}\n', mode: 0o644, path: "package.json" },
  ] as const
  try {
    const transportDifference = await writePackageIdentityFixture(
      join(root, "transport"),
      ordinary,
      ordinary,
      true,
    )
    expect(await readFile(transportDifference.sourceArchive)).not.toEqual(
      await readFile(transportDifference.registryArchive),
    )
    await expect(verifyNpmPackageIdentity(transportDifference)).resolves.toBeUndefined()
    const tamperedView = JSON.parse(
      await readFile(transportDifference.registryView, "utf8"),
    ) as { dist: { shasum: string } }
    tamperedView.dist.shasum = "0".repeat(40)
    await Bun.write(transportDifference.registryView, JSON.stringify(tamperedView))
    await expect(verifyNpmPackageIdentity(transportDifference)).rejects.toThrow(
      "Canonical npm registry dist metadata differs from the downloaded registry archive",
    )

    const changedContents = await writePackageIdentityFixture(
      join(root, "contents"),
      ordinary,
      [
        { body: "changed\n", mode: 0o644, path: "README.md" },
        ordinary[1],
      ],
      false,
    )
    await expect(verifyNpmPackageIdentity(changedContents)).rejects.toThrow(
      "Published npm package contents differ at package/README.md",
    )

    const changedMode = await writePackageIdentityFixture(
      join(root, "mode"),
      ordinary,
      [
        { ...ordinary[0], mode: 0o755 },
        ordinary[1],
      ],
      false,
    )
    await expect(verifyNpmPackageIdentity(changedMode)).rejects.toThrow(
      "Published npm metadata inventory differs from the checked source package",
    )

    const linked = await writePackageIdentityFixture(
      join(root, "link"),
      ordinary,
      [
        ...ordinary,
        { body: "README.md", mode: 0o777, path: "linked-readme", type: "symbolic-link" },
      ],
      false,
    )
    await expect(verifyNpmPackageIdentity(linked)).rejects.toThrow(
      "unsupported symbolic link entry package/linked-readme",
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

function auditAttestation(
  predicateType: string,
  statement: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ keyid: "fixture", sig: Buffer.from("signature").toString("base64") }],
      },
    },
  }
}

test("npm publication authority binds latest, registry signatures, signed provenance, and tag release invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopcamera-npm-authority-"))
  const entries = [
    { body: "read me\n", mode: 0o644, path: "README.md" },
    { body: '{"name":"@hraness/slopcamera","version":"3.2.0"}\n', mode: 0o644, path: "package.json" },
  ] as const
  const sourceSha = "a".repeat(40)
  const publishPredicate = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1"
  const slsaPredicate = "https://slsa.dev/provenance/v1"
  try {
    const identity = await writePackageIdentityFixture(root, entries, entries, false)
    const archive = await readFile(identity.registryArchive)
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`
    const sha512 = createHash("sha512").update(archive).digest("hex")
    const subject = [{
      name: "pkg:npm/%40hraness/slopcamera@3.2.0",
      digest: { sha512 },
    }]
    const publishStatement = {
      _type: "https://in-toto.io/Statement/v0.1",
      subject,
      predicateType: publishPredicate,
      predicate: {
        name: "@hraness/slopcamera",
        version: "3.2.0",
        registry: "https://registry.npmjs.org",
      },
    }
    const slsaStatement = {
      _type: "https://in-toto.io/Statement/v1",
      subject,
      predicateType: slsaPredicate,
      predicate: {
        buildDefinition: {
          buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
          externalParameters: {
            workflow: {
              repository: "https://github.com/hraness/slopcamera",
              ref: "refs/tags/v3.2.0",
              path: ".github/workflows/release.yml",
            },
          },
          internalParameters: {
            github: {
              event_name: "push",
              repository_id: "1310516748",
              repository_owner_id: "307125679",
            },
          },
          resolvedDependencies: [{
            uri: "git+https://github.com/hraness/slopcamera@refs/tags/v3.2.0",
            digest: { gitCommit: sourceSha },
          }],
        },
        runDetails: {
          builder: { id: "https://github.com/actions/runner/github-hosted" },
          metadata: {
            invocationId: "https://github.com/hraness/slopcamera/actions/runs/45678/attempts/2",
          },
        },
      },
    }
    const attestationUrl = "https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fslopcamera@3.2.0"
    const attestations = {
      url: attestationUrl,
      provenance: { predicateType: slsaPredicate },
    }
    const registryView = JSON.parse(await readFile(identity.registryView, "utf8")) as Record<string, unknown>
    const dist = registryView.dist as Record<string, unknown>
    dist.integrity = integrity
    dist.signatures = [{ keyid: "SHA256:fixture", sig: Buffer.from("registry-signature").toString("base64") }]
    dist.attestations = attestations
    registryView["dist-tags"] = { latest: "3.2.0" }
    await Bun.write(identity.registryView, JSON.stringify(registryView))
    const auditPath = join(root, "audit.json")
    const audit = {
      invalid: [],
      missing: [],
      verified: [{
        name: "@hraness/slopcamera",
        version: "3.2.0",
        location: "node_modules/@hraness/slopcamera",
        registry: "https://registry.npmjs.org",
        attestations,
        attestationBundles: [
          auditAttestation(publishPredicate, publishStatement),
          auditAttestation(slsaPredicate, slsaStatement),
        ],
      }],
    }
    await Bun.write(auditPath, JSON.stringify(audit))
    const input = {
      auditJson: auditPath,
      expectedName: "@hraness/slopcamera",
      expectedSourceSha: sourceSha,
      expectedVersion: "3.2.0",
      registryArchive: identity.registryArchive,
      registryView: identity.registryView,
    }
    await expect(verifyNpmPublishAuthority(input)).resolves.toEqual({
      attestationUrl,
      integrity,
      runAttempt: 2,
      runId: 45678,
    })

    registryView["dist-tags"] = { latest: "3.1.1" }
    await Bun.write(identity.registryView, JSON.stringify(registryView))
    await expect(verifyNpmPublishAuthority(input)).rejects.toThrow(
      "version, integrity, or latest channel differs",
    )
    registryView["dist-tags"] = { latest: "3.2.0" }
    await Bun.write(identity.registryView, JSON.stringify(registryView))

    const wrongSourceAudit = structuredClone(audit)
    const wrongSourceEntry = wrongSourceAudit.verified[0]!
    const wrongSourceBundles = wrongSourceEntry.attestationBundles
    wrongSourceBundles[1] = auditAttestation(slsaPredicate, {
      ...slsaStatement,
      predicate: {
        ...slsaStatement.predicate,
        buildDefinition: {
          ...slsaStatement.predicate.buildDefinition,
          resolvedDependencies: [{
            uri: "git+https://github.com/hraness/slopcamera@refs/tags/v3.2.0",
            digest: { gitCommit: "b".repeat(40) },
          }],
        },
      },
    })
    await Bun.write(auditPath, JSON.stringify(wrongSourceAudit))
    await expect(verifyNpmPublishAuthority(input)).rejects.toThrow(
      "does not bind the exact tag release workflow and source",
    )

    await Bun.write(auditPath, JSON.stringify({ ...audit, invalid: [{ code: "EATTESTATIONVERIFY" }] }))
    await expect(verifyNpmPublishAuthority(input)).rejects.toThrow(
      "reported missing or invalid authority",
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("packed npm publishing configuration rejects every credential-boundary override", () => {
  expect(() => verifyNpmPublishConfig({
    access: "public",
    registry: "https://registry.npmjs.org",
  })).not.toThrow()
  for (const override of [
    { tag: "beta" },
    { "@hraness:registry": "https://attacker.invalid" },
    { proxy: "https://attacker.invalid" },
    { "https-proxy": "https://attacker.invalid" },
    { "//registry.npmjs.org/:_authToken": "secret" },
    { provenance: false },
    { "provenance-file": "/tmp/attacker.sigstore" },
  ]) {
    expect(() => verifyNpmPublishConfig({
      access: "public",
      registry: "https://registry.npmjs.org",
      ...override,
    })).toThrow("must contain exactly access and registry")
  }
  expect(() => verifyNpmPublishManifest({
    name: "@hraness/slopcamera",
    version: "3.2.0",
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org",
    },
  })).not.toThrow()
  expect(() => verifyNpmPublishManifest({
    name: "@hraness/slopcamera",
    version: "3.2.0",
    tag: "beta",
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org",
    },
  })).toThrow("top-level tag")
})

test("the safe stable-tag creator fails closed before its one exact tag push", async () => {
  expect(parseReleaseVersion("3.2.0").tag).toBe("v3.2.0")
  expect(() => parseReleaseVersion("3.2.0-beta.1")).toThrow("canonical stable SemVer")
  expect(() => parseReleaseVersion("9007199254740992.0.0")).toThrow(
    "exceeds the safe SemVer component bound",
  )
  expect(() => admitPublishedGitHubRelease({
    tag_name: "v3.2.0", draft: false, prerelease: false, immutable: false,
    author: { id: 41898282, login: "github-actions[bot]" },
  }, "3.2.3")).toThrow("immutable Actions-authored authority")
  const sourceSha = "a".repeat(40)
  const olderTags = [
    `${"b".repeat(40)}\trefs/tags/v3.1.1`,
    `${"c".repeat(40)}\trefs/tags/v3.1.1^{}`,
  ].join("\n") + "\n"
  expect(admitRemoteReleaseTags(olderTags, "3.2.0", sourceSha)).toBe("absent")
  expect(() => admitRemoteReleaseTags(
    `${"b".repeat(40)}\trefs/tags/v3.2.0\n${"c".repeat(40)}\trefs/tags/v3.2.0^{}\n`,
    "3.2.0",
    sourceSha,
  )).toThrow("conflicts with the requested annotated tag")

  const script = await readFile(join(import.meta.dir, "push-release-tag.ts"), "utf8")
  expect(script).toContain("Release tag creation")
  expect(script).toContain("Immutable version tags")
  expect(script).toContain("Verify latest immutable GitHub release")
  expect(script).toContain('["git", "push", "origin", `refs/tags/${release.tag}:refs/tags/${release.tag}`]')
  expect(script).not.toMatch(/npm publish(?:\s|$)/u)
})

test("the tag workflow publishes the exact immutable release bytes to npm through OIDC only", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")
  const publishStart = workflow.indexOf("\n  publish_npm:\n")
  const admitStart = workflow.indexOf("\n  admit_npm:\n")
  expect(publishStart).toBeGreaterThan(workflow.indexOf("\n  publish:\n"))
  expect(admitStart).toBeGreaterThan(publishStart)
  const publishJob = workflow.slice(publishStart, admitStart)
  const admitJob = workflow.slice(admitStart)

  expect(workflow.slice(0, workflow.indexOf("permissions:"))).not.toContain("workflow_dispatch")
  expect(publishJob).toContain("name: Publish exact npm package")
  expect(publishJob).toContain("needs: [verify, official_vtracer, native_macos, attest, publish]")
  expect(publishJob).toContain("environment: npm-release")
  expect(publishJob).toContain("permissions:\n      actions: read\n      contents: read\n      id-token: write")
  expect(workflow.match(/environment: npm-release/gu)).toHaveLength(1)
  expect(workflow.match(/id-token: write/gu)).toHaveLength(2)
  expect(publishJob).not.toContain("actions/checkout@")
  expect(publishJob).not.toContain("setup-bun@")
  expect(publishJob).not.toContain("bun install")
  expect(publishJob).not.toContain("bun run")
  expect(publishJob).not.toContain("./scripts/")
  expect(publishJob).toContain("name: Load current release authority")
  expect(publishJob).toContain("run.triggering_actor?.id !== 894119")
  expect(publishJob).toContain("run.workflow_id !== 320001524")
  expect(publishJob).toContain("current.equals(decode(e.GITHUB_SHA))")
  expect(publishJob).toContain('node "$RUNNER_TEMP/github-release.ts" authorize "$RUNNER_TEMP"')
  expect(publishJob).toContain("npm install --global --ignore-scripts npm@11.19.0")
  expect(publishJob).toContain("artifact-ids: ${{ needs.attest.outputs.artifact_id }}")
  expect(publishJob).not.toContain("github.run_attempt")
  expect(publishJob).toContain('node "$RUNNER_TEMP/github-release.ts" npm-admit "$RUNNER_TEMP/slopcamera-release"')
  expect(publishJob).toContain("name: Rebind attested package before OIDC")
  expect(publishJob).toContain('const expectedName = "@hraness/slopcamera"')
  expect(publishJob).toContain("const maximumFiles = 450")
  expect(publishJob).toContain("const maximumPackedBytes = 4_300_000")
  expect(publishJob).toContain("const maximumUnpackedBytes = 11_300_000")
  expect(publishJob).toContain("record.files.length !== record.entryCount")
  expect(publishJob).toContain("unpackedSize !== record.unpackedSize")
  expect(publishJob).toContain('"src/assets/fonts/nebula-sans/PROVENANCE.md"')
  expect(publishJob).toContain("Downloaded files differ from the trusted verification digests")
  expect(publishJob).toContain('JSON.stringify(["access", "registry"])')
  expect(publishJob).toContain("Packed package manifest can override the canonical npm publication boundary")
  expect(publishJob).toContain("header.subarray(257, 265).equals(ustarSignature)")
  expect(publishJob).toContain("header[475] === 0 ? 130 : 155")
  expect(publishJob).toContain("Packed npm tar duplicates normalized path")
  expect(publishJob).toContain("Pinned npm's clean default publication tag is not latest")
  expect(publishJob).toContain('name.toLowerCase() === "npm_config_tag"')
  expect(publishJob).toContain("never overwrite it")
  expect(publishJob).toContain('if [[ "$registry_state" == published ]]')
  expect(publishJob).toContain("Release candidate must be newer than current npm latest")
  expect(publishJob).toContain("9007199254740991n")
  expect(publishJob).not.toContain("stable-stage intent")
  expect(publishJob).not.toContain("resolved_stage_version")

  const authorityIndex = publishJob.indexOf("Load current release authority")
  const setupIndex = publishJob.indexOf("npm install --global")
  const downloadIndex = publishJob.indexOf("actions/download-artifact@")
  const admitIndex = publishJob.indexOf("github-release.ts\" npm-admit")
  const rebindIndex = publishJob.indexOf("Rebind attested package before OIDC")
  const rehashIndex = publishJob.lastIndexOf('current_archive_sha256="$(sha256sum "$TARBALL"')
  const registryIndex = publishJob.indexOf('if [[ "$registry_state" == published ]]')
  const latestIndex = publishJob.indexOf("Release candidate must be newer than current npm latest")
  const publishIndex = publishJob.indexOf('npm publish "$TARBALL"')
  expect(authorityIndex).toBeGreaterThan(-1)
  expect(authorityIndex).toBeLessThan(setupIndex)
  expect(setupIndex).toBeLessThan(downloadIndex)
  expect(downloadIndex).toBeLessThan(admitIndex)
  expect(admitIndex).toBeLessThan(rebindIndex)
  expect(rebindIndex).toBeLessThan(rehashIndex)
  expect(rehashIndex).toBeLessThan(registryIndex)
  expect(registryIndex).toBeLessThan(latestIndex)
  expect(latestIndex).toBeLessThan(publishIndex)
  const publishCommand = publishJob.slice(publishIndex)
  expect(publishCommand).toContain("--access public")
  expect(publishCommand).toContain("--ignore-scripts")
  expect(publishCommand).toContain("--provenance")
  expect(publishCommand).not.toContain("--tag")
  expect(publishCommand).toContain('--globalconfig="$clean_global_config"')
  expect(publishCommand).toContain('--userconfig="$clean_user_config"')
  expect(publishCommand).toContain("--@hraness:registry=https://registry.npmjs.org")
  expect(publishCommand).toContain("--registry=https://registry.npmjs.org")
  expect(publishCommand).toContain("output.integrity !== process.env.EXPECTED_ARCHIVE_INTEGRITY")
  expect(workflow.match(/npm publish "\$TARBALL"/gu)).toHaveLength(1)
  expect(workflow.match(/--provenance/gu)).toHaveLength(1)
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toContain("npm stage")

  expect(admitJob).toContain("name: Admit the public npm package")
  expect(admitJob).toContain("needs: [verify, publish_npm]")
  expect(admitJob).toContain("permissions:\n      contents: read")
  expect(admitJob).not.toContain("id-token")
  expect(admitJob).not.toContain("environment:")
  expect(admitJob).toContain("persist-credentials: false")
  expect(admitJob).toContain("bun run scripts/npm-package-identity.ts")
  expect(admitJob).toContain("npm audit signatures --json --include-attestations --omit=dev")
  expect(admitJob).toContain("bun run scripts/npm-publish-authority.ts")
  expect(admitJob).toContain("bun run scripts/package-smoke.ts")
  expect(admitJob).not.toContain("npm publish")
})

test("both tar consumers reject hostile USTAR headers and packed dist-tag overrides", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")
  const script = workflowStepScript(workflow, "Rebind attested package before OIDC")
  const identitySource = await readFile(
    join(import.meta.dir, "npm-package-identity.ts"),
    "utf8",
  )
  expect(identitySource).toContain("header.subarray(257, 265).equals(ustarSignature)")
  expect(identitySource).toContain("header[475] === 0 ? 130 : 155")
  const root = await mkdtemp(join(tmpdir(), "slopcamera-release-archive-"))
  const output = join(root, "github-output.txt")
  const runFixture = async (
    mutation?: ArchiveTarMutation,
  ): Promise<Readonly<{
    identity: Parameters<typeof verifyNpmPackageIdentity>[0]
    stage: Awaited<ReturnType<typeof runWorkflowScript>>
  }>> => {
    await Promise.all([
      rm(join(root, "slopcamera-release"), { force: true, recursive: true }),
      rm(output, { force: true }),
    ])
    const artifact = await writeReleaseArtifactFixture(root, mutation)
    const environment = {
      EXPECTED_ARCHIVE_NAME: "hraness-slopcamera-3.2.0.tgz",
      EXPECTED_ARCHIVE_SHA256: artifact.archiveSha256,
      EXPECTED_PACK_SHA256: artifact.metadataSha256,
      EXPECTED_VERSION: "3.2.0",
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: root,
    }
    return {
      identity: {
        expectedFilename: "hraness-slopcamera-3.2.0.tgz",
        expectedName: "@hraness/slopcamera",
        expectedVersion: "3.2.0",
        registryArchive: artifact.tarball,
        registryMetadata: artifact.metadata,
        registryView: artifact.registryView,
        sourceArchive: artifact.tarball,
        sourceMetadata: artifact.metadata,
      },
      stage: await runWorkflowScript(script, environment),
    }
  }

  try {
    const canonical = await runFixture()
    if (canonical.stage.exitCode !== 0) {
      throw new Error(`Canonical USTAR fixture was rejected:\n${canonical.stage.stderr}${canonical.stage.stdout}`)
    }
    await expect(verifyNpmPackageIdentity(canonical.identity)).resolves.toBeUndefined()

    const topLevelTag = await runFixture(tar => {
      replacePackedManifestText(tar, '"type":"module"', '"tag":"beta"   ')
    })
    expect(topLevelTag.stage.exitCode).not.toBe(0)
    expect(topLevelTag.stage.stderr).toContain(
      "Packed package manifest can override the canonical npm publication boundary",
    )
    const wrongDigest = await runFixture()
    expect(wrongDigest.stage.exitCode).toBe(0)
    const driftedDigest = await runWorkflowScript(script, {
      EXPECTED_ARCHIVE_NAME: "hraness-slopcamera-3.2.0.tgz",
      EXPECTED_ARCHIVE_SHA256: "0".repeat(64),
      EXPECTED_PACK_SHA256: "0".repeat(64),
      EXPECTED_VERSION: "3.2.0",
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: root,
    })
    expect(driftedDigest.exitCode).not.toBe(0)
    expect(driftedDigest.stderr).toContain("Downloaded files differ from the trusted verification digests")

    for (const [label, mutation, expectedIdentity, expectedStage] of [
      [
        "magic",
        (tar: Buffer) => {
          const offset = tarEntryOffset(tar, "package/package.json")
          rewriteTarPath(tar, offset, "package.json", "package")
          tar[offset + 257] = "x".charCodeAt(0)
          rewriteTarChecksum(tar, offset)
        },
        "must use the exact USTAR signature",
        "Packed npm tar header is invalid",
      ],
      [
        "version",
        (tar: Buffer) => {
          const offset = tarEntryOffset(tar, "package/package.json")
          rewriteTarPath(tar, offset, "package.json", "package")
          tar[offset + 263] = 0
          tar[offset + 264] = 0
          rewriteTarChecksum(tar, offset)
        },
        "must use the exact USTAR signature",
        "Packed npm tar header is invalid",
      ],
      [
        "prefix normalization",
        (tar: Buffer) => {
          const offset = tarEntryOffset(tar, "package/package.json")
          rewriteTarPath(tar, offset, "package.json", "package/.")
        },
        "npm package tar path is unsafe",
        "Packed npm tar path is unsafe or non-canonical",
      ],
      [
        "extended prefix",
        (tar: Buffer) => {
          const offset = tarEntryOffset(tar, "package/package.json")
          const header = tar.subarray(offset, offset + 512)
          header.fill(0, 0, 100)
          header.fill("a".charCodeAt(0), 345, 475)
          header.fill(0, 475, 500)
          header.write("package/", 345, "ascii")
          header.write("/../package", 475, "ascii")
          header.write("package.json", 0, "ascii")
          rewriteTarChecksum(tar, offset)
        },
        "npm package tar path is unsafe",
        "Packed npm tar path is unsafe or non-canonical",
      ],
      [
        "duplicate package.json",
        (tar: Buffer) => {
          const offset = tarEntryOffset(tar, "package/README.md")
          rewriteTarPath(tar, offset, "package.json", "package")
        },
        "duplicate file-directory path package/package.json",
        "Packed npm tar duplicates normalized path package.json",
      ],
    ] as const) {
      const rejected = await runFixture(mutation)
      await expect(verifyNpmPackageIdentity(rejected.identity)).rejects.toThrow(expectedIdentity)
      expect(rejected.stage.exitCode, label).not.toBe(0)
      expect(rejected.stage.stderr, label).toContain(expectedStage)
    }
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("Slopcamera source installs stay distinct from historical Atet archives", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { readonly bin?: unknown; readonly version?: unknown }
  const [privacy, publishing, readme, security, skillInstall, siteBuild, siteProducer,
    siteContent, siteRenderer, siteMarkdown, siteTemplate] =
    await Promise.all([
      readFile(join(packageRoot, "PRIVACY.md"), "utf8"),
      readFile(join(packageRoot, "docs", "publishing.md"), "utf8"),
      readFile(join(packageRoot, "README.md"), "utf8"),
      readFile(join(packageRoot, "SECURITY.md"), "utf8"),
      readFile(join(packageRoot, "skills", "slopcamera", "references", "install.md"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "scripts", "build.ts"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "scripts", "build-site.ts"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "src", "site-content.ts"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "src", "site-renderer.ts"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "src", "agent-pages.ts"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "src", "index.html"), "utf8"),
    ])

  expect(manifest.version).toBe("3.2.5")
  expect(manifest.bin).toEqual({
    slopcamera: "./apps/desktop/dist/cli/main.js",
  })
  expect(Object.prototype.hasOwnProperty.call(manifest, "contentPolicy")).toBe(false)
  expect(publishedRelease.version).toBe("3.2.4")
  expect(publishedArchiveUrl).toBe("https://github.com/hraness/slopcamera/releases/download/v3.2.4/hraness-slopcamera-3.2.4.tgz")
  for (const source of [readme, skillInstall, homeMarkdown]) {
    expect(source).toContain(sourceInstall.checkoutCommand)
  }
  for (const source of [readme, skillInstall]) {
    expect(source).toContain("bun install --frozen-lockfile --ignore-scripts")
    expect(source).toContain("bun run build:sdk")
    expect(source).toContain("bun run build:desktop:cli")
  }
  expect(siteContent).toContain('import { archiveInstall, sourceInstall } from "./published-release"')
  for (const slot of ["SOURCE_CHECKOUT_COMMAND", "SOURCE_ENTER_COMMAND", "SOURCE_INSTALL_URL"]) {
    expect(siteTemplate.match(new RegExp(`\\{\\{${slot}\\}\\}`, "gu"))).toHaveLength(1)
  }
  expect(siteContent).toContain("sourceInstall.alternateSkillCommand")
  expect(siteContent).toContain("sourceInstall.skillCommand")
  expect(siteRenderer).toContain('import { siteContentSlots, type SiteAssets, type SiteDocument } from "./site-content"')
  expect(siteRenderer).toContain("for (const [placeholder, value, count] of siteContentSlots(document, assets))")
  expect(siteRenderer).toContain("rendered = replaceSiteSlot(rendered, placeholder, value, count)")
  expect(siteBuild).toContain("const site = await buildSite(appDirectory, { themePath, analyticsPath })")
  for (const source of ["src/site-content.ts", "src/site-renderer.ts", "src/published-release.ts"]) {
    expect(siteProducer).toContain(`"${source}"`)
  }
  expect(siteProducer).toContain('entrypoints: [below(root, join(app, "src/site-renderer.ts"))], id: "site-renderer", kind: "ssr"')
  const produce = siteProducer.indexOf("const html: unknown = module.renderSiteDocument(")
  const seal = siteProducer.indexOf("await sealStylexProducedTemplate(generation, document)")
  const finalize = siteProducer.indexOf("await finalizeStylexGeneration(")
  expect(produce).toBeGreaterThan(-1)
  expect(seal).toBeGreaterThan(produce)
  expect(finalize).toBeGreaterThan(seal)
  expect(siteMarkdown).toContain('import { archiveInstall, publishedRelease, sourceInstall } from "./published-release"')
  expect(siteTemplate).not.toContain("{{PUBLISHED_VERSION}}")
  expect(siteTemplate).not.toContain('"softwareVersion"')
  expect(siteTemplate).not.toContain("{{PUBLISHED_ARCHIVE_URL}}")
  for (const capability of [
    "screen",
    "camera",
    "microphone",
    "system audio",
    "typed text",
  ]) {
    expect(privacy.toLowerCase()).toContain(capability)
  }
  expect(readme).toContain("(PRIVACY.md)")
  expect(security).toContain("(PRIVACY.md)")
  expect(publishing).toContain("GitHub Releases are canonical")
  expect(publishing).toContain("npm publish <attested-archive>")
  expect(publishing).toContain("--file release.yml --environment npm-release --allow-publish")
  expect(publishing).not.toContain("resolved_stage_version")
  expect(publishing).not.toContain("npm-stage")
  expect(publishing).toContain("npm-package-identity.ts")
  expect(publishing).toContain("npm may re-encode transport bytes")
  expect(publishing).toContain("npm is a downstream mirror")

  for (const source of [readme, skillInstall, siteBuild, siteMarkdown, siteTemplate]) {
    expect(source).not.toContain("v3.1.0")
    expect(source).not.toContain("v3.0.0")
    expect(source).not.toContain("v2.0.0")
    expect(source).not.toContain('"softwareVersion": "2.0.0"')
  }
})

test("the package smoke proves metadata and bounded import side effects", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const smoke = await readFile(join(packageRoot, "scripts", "package-smoke.ts"), "utf8")

  for (const required of [
    '"PRIVACY.md"',
    'Object.prototype.hasOwnProperty.call(manifest, "contentPolicy")',
    "--pack-json",
    "npm pack SHA-512 integrity does not match the exact archive bytes",
    "npm pack SHA-1 shasum does not match the exact archive bytes",
    'patch("node:child_process"',
    'patch("node:fs"',
    'patch("node:http"',
    'deny("globalThis.fetch")',
    '"--permission"',
    '"--allow-fs-read=*"',
    "package imports changed the controlled consumer filesystem",
  ]) {
    expect(smoke).toContain(required)
  }
  expect(smoke).not.toContain('await Promise.all(${JSON.stringify(importSpecifiers)}.map(specifier => import(specifier)))`')
})

test("CI FFmpeg setup bounds Ubuntu mirror failures without weakening runtime checks", async () => {
  const scriptPath = join(import.meta.dir, "install-ci-ffmpeg.sh")
  const script = await readFile(scriptPath, "utf8")
  const syntaxCheck = Bun.spawn(["bash", "-n", scriptPath], {
    stderr: "pipe",
    stdout: "pipe",
  })
  const syntaxError = await new Response(syntaxCheck.stderr).text()

  expect(await syntaxCheck.exited).toBe(0)
  expect(syntaxError).toBe("")

  expect(script).toContain("printf '%s\\t%s\\n'")
  expect(script).toContain(
    "'https://archive.ubuntu.com/ubuntu/' 'priority:1'",
  )
  expect(script).toContain(
    "'https://security.ubuntu.com/ubuntu/' 'priority:2'",
  )
  expect(script).toContain(
    "'http://azure.archive.ubuntu.com/ubuntu/' 'priority:3'",
  )
  expect(script).toContain("Acquire::Retries=2")
  expect(script).toContain("Acquire::http::Timeout=20")
  expect(script).toContain("Acquire::https::Timeout=20")
  expect(script).toMatch(
    /^sudo env DEBIAN_FRONTEND=noninteractive timeout --signal=TERM --kill-after=10s 180s \\\n {2}apt-get "\$\{apt_network_options\[@\]\}" update$/m,
  )
  expect(script).toMatch(
    /^sudo env DEBIAN_FRONTEND=noninteractive timeout --signal=TERM --kill-after=10s 600s \\\n {2}apt-get "\$\{apt_network_options\[@\]\}" install --yes --no-install-recommends ffmpeg$/m,
  )
  expect(script).toContain("ffmpeg -version")
  expect(script).toContain("ffprobe -version")
})

test("public Slopcamera VTracer workflow verifies every reviewed platform without write permissions", async () => {
  const workflow = await readWorkflow("public-vectorizer.yml", "vectorizer.yml")

  expect(workflow).toContain("permissions:\n  contents: read")
  expect(workflow).toContain("name: Slopcamera VTracer")
  expect(workflow).toContain("pull_request:")
  expect(workflow).toContain("branches: [main]")
  for (const target of [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
  ]) {
    expect(workflow).toContain(`target: ${target}`)
  }
  expect(workflow).toContain("bun run test:vectorize:official")
  expect(workflow).not.toContain("contents: write")
})
