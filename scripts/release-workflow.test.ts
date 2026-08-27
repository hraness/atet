import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

import { verifyNpmPackageIdentity } from "./npm-package-identity"

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
    if (!line.startsWith("          ")) break
    script.push(line.slice(10))
  }
  return script.join("\n")
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

test("public CI routes independent Atet SDK, local-runtime, site, and native proofs", async () => {
  const workflow = await readWorkflow("public-ci.yml", "ci.yml")

  expect(workflow).toContain("plan:\n    name: Plan")
  expect(workflow).toContain("boundary:\n    name: Atet standalone boundary")
  expect(workflow).toContain("sdk:\n    name: Atet SDK")
  expect(workflow).toContain("desktop:\n    name: Atet local runtime")
  expect(workflow).toContain("site:\n    name: Atet site")
  expect(workflow).toContain("package:\n    name: Atet packed consumer")
  expect(workflow).toContain("native:\n    name: Atet macOS shell")
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
  expect(workflow).not.toContain(["projects", "atet"].join("/"))
})

test("version tags pass the complete immutable release gate", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")

  expect(workflow).toContain('tags:\n      - "v*"')
  expect(workflow).toContain("permissions:\n  contents: read")
  expect(workflow).toContain("verify:\n    name: Verify")
  expect(workflow).toContain("publish:\n    name: Publish")
  expect(workflow).toContain("needs: verify")
  expect(workflow).toContain(`GH_REPO: \${{ github.repository }}`)
  expect(workflow).toContain("contents: write")
  expect(workflow).toContain("cancel-in-progress: false")
  expect(workflow).toContain("group: stable-release")
  expect(workflow).toContain("fetch-depth: 0")
  expect(workflow).toContain("persist-credentials: false")
  expect(workflow).toContain("is not a stable semantic version")
  expect(workflow).toContain(
    'Tag $GITHUB_REF_NAME does not match package version $expected_tag',
  )
  expect(workflow).toContain(
    'git merge-base --is-ancestor "$GITHUB_SHA" "origin/$DEFAULT_BRANCH"',
  )
  expect(workflow).toContain('newest_stable_tag="$(git tag --list')
  expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(workflow).toContain("bun run check")
  expect(workflow).toContain("npm install --global --ignore-scripts npm@11.19.0")
  expect(workflow).toContain("Verify exact public npm artifact")
  expect(workflow).toContain('npm pack "$package_name@$package_version"')
  expect(workflow).toContain("--registry=https://registry.npmjs.org")
  expect(workflow).toContain(
    'npm view "$package_name@$package_version" name version dist --json',
  )
  expect(workflow).toContain("bun run ./scripts/npm-package-identity.ts")
  expect(workflow).toContain('"$source_metadata" "$source_archive"')
  expect(workflow).toContain('"$registry_metadata" "$registry_archive"')
  expect(workflow).toContain('"$registry_view"')
  expect(workflow).not.toContain('cmp --silent "$source_archive" "$registry_archive"')
  expect(workflow).not.toContain('source[field] !== registry[field]')
  expect(workflow).toContain("bun run ./scripts/package-smoke.ts")
  expect(workflow).toContain('--archive "$registry_archive"')
  expect(workflow).toContain('--pack-json "$registry_metadata"')
  expect(workflow).toContain("bash scripts/install-ci-ffmpeg.sh")
  expect(workflow).toContain("native_macos:\n    name: Atet macOS shell")
  expect(workflow).toContain("bun run test:desktop:macos")
  expect(workflow).toContain("bun run package:desktop:macos")
  expect(workflow).toContain(
    "mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29",
  )
  expect(workflow).toContain('version: "0.16.0"')
  expect(workflow).toContain("needs: [verify, official_vtracer, native_macos]")
  expect(workflow).toContain("Verify clean source tree")
  expect(workflow).toContain("git status --porcelain --untracked-files=all")
  expect(workflow).toContain("is not newer than")
  expect(workflow).toContain('gh release create "$GITHUB_REF_NAME"')
  expect(workflow).toContain("--verify-tag")
  expect(workflow).toContain("--generate-notes")
  expect(workflow).toContain("--latest")
  expect(workflow).toContain('--title "Atet $GITHUB_REF_NAME"')
  expect(workflow).toContain(
    "--json assets,isDraft,isImmutable,isPrerelease,tagName",
  )
  expect(workflow).toContain("(.assets | length)")
  expect(workflow).toContain('"/repos/$GITHUB_REPOSITORY/releases/latest"')
  expect(workflow).not.toContain("pull_request:")
  expect(workflow).not.toContain("workflow_dispatch:")
  expect(workflow).not.toContain("--clobber")
  expect(workflow).not.toContain("/immutable-releases")
  expect(workflow).not.toContain("administration:")
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
    filename: "hraness-atet-3.1.1.tgz",
    files,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    name: "@hraness/atet",
    shasum: createHash("sha1").update(archive).digest("hex"),
    size: archive.length,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    version: "3.1.1",
  }]
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
      tarball: "https://registry.npmjs.org/@hraness/atet/-/atet-3.1.1.tgz",
      unpackedSize: registryResult.unpackedSize,
    },
    name: "@hraness/atet",
    version: "3.1.1",
  }
  const paths = {
    registryArchive: join(root, "registry", "hraness-atet-3.1.1.tgz"),
    registryMetadata: join(root, "registry", "npm-pack.json"),
    registryView: join(root, "registry", "npm-view.json"),
    sourceArchive: join(root, "source", "hraness-atet-3.1.1.tgz"),
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
    expectedFilename: "hraness-atet-3.1.1.tgz",
    expectedName: "@hraness/atet",
    expectedVersion: "3.1.1",
    ...paths,
  }
}

test("npm release identity ignores transport metadata but binds contents, modes, and entry types", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-npm-identity-"))
  const ordinary = [
    { body: "read me\n", mode: 0o644, path: "README.md" },
    { body: '{"name":"@hraness/atet","version":"3.1.1"}\n', mode: 0o644, path: "package.json" },
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

test("the default-branch workflow stages one exact npm artifact through OIDC", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")

  const verifyStart = workflow.indexOf("  verify:\n")
  const stageStart = workflow.indexOf("\n  stage:\n")
  expect(verifyStart).toBeGreaterThan(-1)
  expect(stageStart).toBeGreaterThan(verifyStart)
  const verifyJob = workflow.slice(verifyStart, stageStart)
  const stageJob = workflow.slice(stageStart)

  expect(workflow).toContain("workflow_dispatch:")
  expect(verifyJob).toContain("name: Verify exact package")
  expect(verifyJob).toContain("permissions:\n      contents: read")
  expect(verifyJob).not.toContain("id-token: write")
  expect(verifyJob).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0")
  expect(verifyJob).toContain('node-version: "24"')
  expect(verifyJob).toContain('bun-version: "1.3.14"')
  expect(verifyJob).toContain("npm install --global --ignore-scripts npm@11.19.0")
  expect(verifyJob).toContain('[[ "$(npm --version)" == "11.19.0" ]]')
  expect(verifyJob).toContain('if [[ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]]')
  expect(verifyJob).toContain('"$GITHUB_SHA" != "$default_sha" || "$checked_out_sha" != "$default_sha"')
  expect(verifyJob).toContain('npm view "$package_name" name --json')
  expect(verifyJob).toContain('npm view "$package_name@$package_version" version --json')
  expect(verifyJob).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(verifyJob).toContain("bun run check")
  expect(verifyJob).toContain("Verify clean source tree")
  expect(verifyJob).toContain("git status --porcelain --untracked-files=all")
  expect(verifyJob).toContain("npm pack --ignore-scripts --json")
  expect(verifyJob).toContain('> "$metadata"')
  expect(verifyJob).toContain('cat "$metadata"')
  expect(verifyJob).toContain("bun run ./scripts/package-smoke.ts")
  expect(verifyJob).toContain('--archive "$archive"')
  expect(verifyJob).toContain('--pack-json "$metadata"')
  expect(verifyJob).toContain("npm-package.sha256")
  expect(verifyJob).toContain('sha256sum "$archive"')
  expect(verifyJob).toContain('sha256sum "$metadata"')
  expect(verifyJob).toContain("$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT")
  expect(verifyJob).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02")

  expect(stageJob).toContain("name: Stage exact package")
  expect(stageJob).toContain("needs: verify")
  expect(stageJob).toContain("permissions:\n      id-token: write")
  expect(workflow.match(/id-token: write/gu)).toHaveLength(1)
  expect(stageJob).not.toContain("actions/checkout@")
  expect(stageJob).not.toContain("setup-bun@")
  expect(stageJob).not.toContain("bun install")
  expect(stageJob).not.toContain("bun run")
  expect(stageJob).not.toContain("./scripts/")
  expect(stageJob).toContain('node-version: "24"')
  expect(stageJob).toContain("npm install --global --ignore-scripts npm@11.19.0")
  expect(stageJob).toContain("name: Bind artifact reference")
  expect(stageJob).toContain("$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT")
  expect(stageJob).toContain("Verified artifact name is not bound to this run and attempt")
  expect(stageJob).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093")
  expect(stageJob).toContain("name: ${{ needs.verify.outputs.artifact_name }}")
  expect(stageJob).toContain("Downloaded npm artifact must contain exactly the tarball, npm-pack.json, and npm-package.sha256")
  expect(stageJob).toContain('if [[ ! -f "$required_file" || -L "$required_file" ]]')
  expect(stageJob).toContain('expected_tarball_name="hraness-atet-$EXPECTED_VERSION.tgz"')
  expect(stageJob).toContain('const expectedName = "@hraness/atet"')
  expect(stageJob).toContain("const maximumFiles = 350")
  expect(stageJob).toContain("const maximumPackedBytes = 3_750_000")
  expect(stageJob).toContain("const maximumUnpackedBytes = 8_900_000")
  expect(stageJob).toContain("record.files.length !== record.entryCount")
  expect(stageJob).toContain("unpackedSize !== record.unpackedSize")
  expect(stageJob).toContain('"dist/NebulaSans-Book-5ax05zvn.woff2"')
  expect(stageJob).toContain('"src/assets/fonts/nebula-sans/LICENSE.txt"')
  expect(stageJob).toContain('"src/assets/fonts/nebula-sans/PROVENANCE.md"')
  expect(stageJob).toContain('createHash("sha1")')
  expect(stageJob).toContain('createHash("sha512")')
  expect(stageJob).toContain('createHash("sha256")')
  expect(stageJob).toContain("Downloaded files differ from the independent SHA-256 manifest")
  expect(stageJob).toContain('git init --quiet --bare "$current_main"')
  expect(stageJob).toContain('"https://github.com/$GITHUB_REPOSITORY.git"')
  expect(stageJob).toContain("Default branch advanced to $current_default_sha after verification")
  expect(stageJob).toContain('tag_ref="refs/tags/v$EXPECTED_VERSION"')
  expect(stageJob).toContain("git ls-remote --exit-code --refs")
  expect(stageJob).toContain('case "$tag_lookup_status" in')
  expect(stageJob).toContain('if [[ -n "$tag_lookup_output" ]]')
  expect(stageJob).toContain("Remote tag lookup returned an ambiguous absence result")
  expect(stageJob).toContain("npm delivery must precede the Git tag")
  expect(stageJob).toContain("Could not prove that tag v$EXPECTED_VERSION is absent")

  const artifactReferenceIndex = stageJob.indexOf("Bind artifact reference")
  const downloadIndex = stageJob.indexOf("Download reviewed package")
  const rebindIndex = stageJob.indexOf("Rebind downloaded package")
  const fetchIndex = stageJob.lastIndexOf('git --git-dir="$current_main" fetch')
  const tagIndex = stageJob.lastIndexOf("git ls-remote --exit-code --refs")
  const rehashIndex = stageJob.lastIndexOf('current_archive_sha256="$(sha256sum "$TARBALL"')
  const stageIndex = stageJob.indexOf('npm stage publish "$TARBALL"')
  expect(artifactReferenceIndex).toBeLessThan(downloadIndex)
  expect(downloadIndex).toBeLessThan(rebindIndex)
  expect(rebindIndex).toBeLessThan(fetchIndex)
  expect(fetchIndex).toBeLessThan(tagIndex)
  expect(tagIndex).toBeLessThan(rehashIndex)
  expect(rehashIndex).toBeLessThan(stageIndex)
  expect(stageIndex).toBeGreaterThan(-1)
  expect(stageJob.slice(stageIndex)).toContain("--access public")
  expect(stageJob.slice(stageIndex)).toContain("--ignore-scripts")
  expect(stageJob.slice(stageIndex)).toContain("--provenance")
  expect(stageJob.slice(stageIndex)).toContain("--registry=https://registry.npmjs.org")
  expect(stageJob.match(/--provenance/gu)).toHaveLength(1)
  expect(workflow.match(/--registry=https:\/\/registry\.npmjs\.org/gu)?.length).toBeGreaterThanOrEqual(5)
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toMatch(/npm publish(?:\s|$)/u)
  expect(workflow).not.toContain("push:")
})

test("the terminal npm stage rejects present, ambiguous, and failed remote tag lookups", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")
  const script = workflowStepScript(
    workflow,
    "Revalidate current main and stage exact package",
  )
  const directory = await mkdtemp(join(tmpdir(), "atet-stage-tag-"))
  const binaryDirectory = join(directory, "bin")
  const commandLog = join(directory, "commands.log")
  const publishMarker = join(directory, "published.txt")
  const tarball = join(directory, "hraness-atet-3.1.1.tgz")
  const metadata = join(directory, "npm-pack.json")
  const sourceSha = "b".repeat(40)
  const archiveSha256 = "c".repeat(64)
  const metadataSha256 = "d".repeat(64)

  try {
    await mkdir(binaryDirectory, { recursive: true })
    await Promise.all([
      writeFile(tarball, "reviewed archive fixture\n", "utf8"),
      writeFile(metadata, "reviewed metadata fixture\n", "utf8"),
      writeFile(join(binaryDirectory, "git"), `#!/bin/bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1-}" == "ls-remote" ]]; then
  case "$GIT_TAG_STATUS" in
    absent) exit 2 ;;
    ambiguous) printf 'ambiguous lookup output\\n'; exit 2 ;;
    present) printf '%s\\trefs/tags/v3.1.1\\n' "$GITHUB_SHA"; exit 0 ;;
    failure) echo 'simulated remote lookup failure' >&2; exit 128 ;;
  esac
fi
if [[ "$*" == *"rev-parse FETCH_HEAD"* ]]; then
  printf '%s\\n' "$GITHUB_SHA"
fi
`, "utf8"),
      writeFile(join(binaryDirectory, "sha256sum"), `#!/bin/bash
set -euo pipefail
printf 'sha256sum %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == "$TARBALL" ]]; then
  printf '%s  %s\\n' "$EXPECTED_ARCHIVE_SHA256" "$1"
elif [[ "$1" == "$METADATA" ]]; then
  printf '%s  %s\\n' "$EXPECTED_METADATA_SHA256" "$1"
else
  exit 1
fi
`, "utf8"),
      writeFile(join(binaryDirectory, "npm"), `#!/bin/bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$COMMAND_LOG"
printf 'staged\\n' > "$PUBLISH_MARKER"
`, "utf8"),
    ])
    await Promise.all([
      chmod(join(binaryDirectory, "git"), 0o755),
      chmod(join(binaryDirectory, "npm"), 0o755),
      chmod(join(binaryDirectory, "sha256sum"), 0o755),
    ])

    const baseEnvironment = Object.freeze({
      COMMAND_LOG: commandLog,
      DEFAULT_BRANCH: "main",
      EXPECTED_ARCHIVE_SHA256: archiveSha256,
      EXPECTED_METADATA_SHA256: metadataSha256,
      EXPECTED_SOURCE_SHA: sourceSha,
      EXPECTED_VERSION: "3.1.1",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "hraness/atet",
      GITHUB_SHA: sourceSha,
      METADATA: metadata,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      PUBLISH_MARKER: publishMarker,
      RUNNER_TEMP: directory,
      TARBALL: tarball,
    })

    const accepted = await runWorkflowScript(script, {
      ...baseEnvironment,
      GIT_TAG_STATUS: "absent",
    })
    expect(accepted.exitCode).toBe(0)
    expect(await readFile(publishMarker, "utf8")).toBe("staged\n")
    const commands = await readFile(commandLog, "utf8")
    const fetchIndex = commands.indexOf("fetch --quiet --no-tags --depth=1")
    const tagIndex = commands.indexOf("git ls-remote --exit-code --refs")
    const hashIndex = commands.indexOf("sha256sum")
    const publishIndex = commands.indexOf("npm stage publish")
    expect(fetchIndex).toBeGreaterThan(-1)
    expect(tagIndex).toBeGreaterThan(fetchIndex)
    expect(hashIndex).toBeGreaterThan(tagIndex)
    expect(publishIndex).toBeGreaterThan(hashIndex)

    for (const [status, message] of [
      ["present", "npm delivery must precede the Git tag"],
      ["ambiguous", "ambiguous absence result"],
      ["failure", "Could not prove that tag v3.1.1 is absent"],
    ] as const) {
      await Promise.all([
        rm(commandLog, { force: true }),
        rm(publishMarker, { force: true }),
      ])
      const rejected = await runWorkflowScript(script, {
        ...baseEnvironment,
        GIT_TAG_STATUS: status,
      })
      expect(rejected.exitCode).not.toBe(0)
      expect(`${rejected.stdout}${rejected.stderr}`).toContain(message)
      expect(await Bun.file(publishMarker).exists()).toBe(false)
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test("version 3.1.1 publishes one Atet identity with npm install instructions", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { readonly bin?: unknown; readonly version?: unknown }
  const [disclosure, publishing, readme, security, skillInstall, siteBuild, siteMarkdown, siteTemplate] =
    await Promise.all([
      readFile(join(packageRoot, "DISCLOSURE"), "utf8"),
      readFile(join(packageRoot, "docs", "publishing.md"), "utf8"),
      readFile(join(packageRoot, "README.md"), "utf8"),
      readFile(join(packageRoot, "SECURITY.md"), "utf8"),
      readFile(join(packageRoot, "skills", "atet", "references", "install.md"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "scripts", "build.ts"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "src", "agent-pages.ts"), "utf8"),
      readFile(join(packageRoot, "apps", "web", "src", "index.html"), "utf8"),
    ])

  expect(manifest.version).toBe("3.1.1")
  expect(manifest.bin).toEqual({
    atet: "./apps/desktop/dist/cli/main.js",
  })
  expect((manifest as { readonly contentPolicy?: unknown }).contentPolicy).toEqual({
    class: "dual-use",
  })

  const npmCliInstall = "@hraness/atet@3.1.1"
  const immutableSkillInstall =
    "https://github.com/hraness/atet/tree/v3.1.1 --skill atet"
  for (const source of [readme, skillInstall, siteMarkdown, siteTemplate]) {
    expect(source).toContain(npmCliInstall)
  }
  for (const source of [readme, siteBuild, siteMarkdown]) {
    expect(source).toContain(immutableSkillInstall)
  }
  expect(siteTemplate).toContain('"softwareVersion": "3.1.1"')
  expect(siteTemplate).toContain('"version": "3.1.1"')
  expect(readme).toContain("github:hraness/atet#v3.1.1")
  for (const capability of [
    "screen",
    "camera",
    "microphone",
    "system audio",
    "typed text",
  ]) {
    expect(disclosure.toLowerCase()).toContain(capability)
  }
  expect(readme).toContain("[`DISCLOSURE`](DISCLOSURE)")
  expect(security).toContain("[`DISCLOSURE`](DISCLOSURE)")
  expect(publishing).toContain("npm stage publish <reviewed-tarball>")
  expect(publishing).toContain("--ignore-scripts")
  expect(publishing).toContain("--provenance")
  expect(publishing).toContain("allowed action: `npm stage publish` only")
  expect(publishing).toContain("Require two-factor authentication and")
  expect(publishing).toContain("disallow tokens")
  expect(publishing).toContain("Do not create the matching Git tag yet")
  expect(publishing).toContain("only job with OIDC authority")
  expect(publishing).toContain("checks out no source and runs no repository code")
  expect(publishing).toContain("npm-package.sha256")
  expect(publishing).toContain("proves the matching Git tag is still absent")
  expect(publishing).toContain("npm-package-identity.ts")
  expect(publishing).toContain("different gzip or tar bytes")
  expect(publishing).not.toContain("archives are byte-identical")

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
    '"DISCLOSURE"',
    "contentPolicy.class=dual-use",
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

test("public Atet VTracer workflow verifies every reviewed platform without write permissions", async () => {
  const workflow = await readWorkflow("public-vectorizer.yml", "vectorizer.yml")

  expect(workflow).toContain("permissions:\n  contents: read")
  expect(workflow).toContain("name: Atet VTracer")
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
