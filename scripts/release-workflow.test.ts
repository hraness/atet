import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { gzipSync } from "node:zlib"

import { verifyNpmPackageIdentity } from "./npm-package-identity"
import {
  admitActiveCiWorkflow,
  admitCiRequiredJob,
  admitCiRun,
  admitOwner,
  admitReleaseEnvironment,
  admitReleaseRulesets,
  admitRemoteRoutes,
  admitRemoteReleaseTags,
  admitRepository,
  parseReleaseVersion,
} from "./push-npm-release-tag"

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

function requireOwnerTagAuthorization(workflow: string, label: string): void {
  const start = workflow.indexOf("\n  authorize:\n")
  const end = workflow.indexOf("\n  verify:\n", start)
  if (start === -1 || end === -1) {
    throw new Error(`${label} is missing the leading authorization job`)
  }
  const authorize = workflow.slice(start, end)
  if (!authorize.includes('"$GITHUB_ACTOR_ID" != "$EXPECTED_ACTOR_ID"')) {
    throw new Error(`${label} is missing the exact event actor guard`)
  }
  if (!authorize.includes("event.sender?.id !== Number(process.env.EXPECTED_ACTOR_ID)")) {
    throw new Error(`${label} is missing the exact event sender guard`)
  }
  if (!authorize.includes('event.sender?.type !== "User"')) {
    throw new Error(`${label} is missing the immutable sender type guard`)
  }
  const firstCheckout = workflow.indexOf("actions/checkout@")
  if (firstCheckout === -1 || firstCheckout < end) {
    throw new Error(`${label} must authorize before checkout`)
  }
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

test("protected tag workflows fail closed on hostile actor or sender drift", async () => {
  for (const [sourceName, publicName] of [
    ["public-npm-stage.yml", "npm-stage.yml"],
    ["public-release.yml", "release.yml"],
  ] as const) {
    const workflow = await readWorkflow(sourceName, publicName)
    expect(() => requireOwnerTagAuthorization(workflow, publicName)).not.toThrow()

    const actorDrift = workflow.replace(
      '"$GITHUB_ACTOR_ID" != "$EXPECTED_ACTOR_ID"',
      '"$GITHUB_ACTOR_ID" == "$EXPECTED_ACTOR_ID"',
    )
    expect(actorDrift).not.toBe(workflow)
    expect(() => requireOwnerTagAuthorization(actorDrift, publicName)).toThrow(
      "exact event actor guard",
    )

    const senderDrift = workflow.replace(
      "event.sender?.id !== Number(process.env.EXPECTED_ACTOR_ID)",
      "event.sender?.id !== 894120",
    )
    expect(senderDrift).not.toBe(workflow)
    expect(() => requireOwnerTagAuthorization(senderDrift, publicName)).toThrow(
      "exact event sender guard",
    )
  }
})

test("owner-created stable tags pass the complete immutable release gate", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")

  expect(workflow).toContain('tags:\n      - "v*"\n      - "!v*-beta.*"')
  expect(workflow).toContain("Authorize owner release tag")
  expect(workflow).toContain("github.ref_protected")
  expect(workflow).toContain('EXPECTED_ACTOR_ID: "894119"')
  expect(workflow).toContain('EXPECTED_REPOSITORY_ID: "1310516748"')
  expect(workflow).toContain('event.sender?.type !== "User"')
  expect(workflow).toContain('event.repository?.visibility !== "public"')
  expect(workflow).toContain('event.repository?.private !== false')
  expect(workflow).toContain('needs: authorize')
  expect(workflow).toContain("permissions:\n  contents: read")
  expect(workflow).toContain("verify:\n    name: Verify")
  expect(workflow).toContain("publish:\n    name: Publish")
  expect(workflow).toContain("needs: [verify, official_vtracer, native_macos]")
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
  expect(workflow).toContain('git cat-file -t "$release_ref"')
  expect(workflow).toContain("Release requires the exact annotated release tag")
  expect(workflow).toContain(
    'git merge-base --is-ancestor "$GITHUB_SHA" "origin/$DEFAULT_BRANCH"',
  )
  expect(workflow).toContain('newest_stable_tag="$(git tag --list')
  expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(workflow).toContain("bun run check")
  expect(workflow).toContain("npm install --global --ignore-scripts npm@11.19.0")
  expect(workflow).toContain("Verify exact public npm artifact")
  expect(workflow).toContain("for registry_poll in {1..60}")
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
  expect(workflow).not.toContain("publication_run_id")
  expect(workflow).not.toContain("authorization_run_id")
  expect(workflow).not.toContain("actions: read")
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
    filename: "hraness-atet-3.2.0.tgz",
    files,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    name: "@hraness/atet",
    shasum: createHash("sha1").update(archive).digest("hex"),
    size: archive.length,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    version: "3.2.0",
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
      tarball: "https://registry.npmjs.org/@hraness/atet/-/atet-3.2.0.tgz",
      unpackedSize: registryResult.unpackedSize,
    },
    name: "@hraness/atet",
    version: "3.2.0",
  }
  const paths = {
    registryArchive: join(root, "registry", "hraness-atet-3.2.0.tgz"),
    registryMetadata: join(root, "registry", "npm-pack.json"),
    registryView: join(root, "registry", "npm-view.json"),
    sourceArchive: join(root, "source", "hraness-atet-3.2.0.tgz"),
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
    expectedFilename: "hraness-atet-3.2.0.tgz",
    expectedName: "@hraness/atet",
    expectedVersion: "3.2.0",
    ...paths,
  }
}

test("npm release identity ignores transport metadata but binds contents, modes, and entry types", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-npm-identity-"))
  const ordinary = [
    { body: "read me\n", mode: 0o644, path: "README.md" },
    { body: '{"name":"@hraness/atet","version":"3.2.0"}\n', mode: 0o644, path: "package.json" },
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

test("owner-tagged stable and beta npm publication is direct, exact, and least privilege", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")
  const publishStart = workflow.indexOf("\n  publish:\n")
  expect(publishStart).toBeGreaterThan(-1)
  const publishJob = workflow.slice(publishStart)

  for (const required of [
    'tags:\n      - "v*"',
    "Authorize owner release tag",
    'EXPECTED_ACTOR_ID: "894119"',
    'EXPECTED_REPOSITORY_ID: "1310516748"',
    "GITHUB_ACTOR_ID",
    'event.sender?.type !== "User"',
    'event.repository?.visibility !== "public"',
    "github.ref_protected",
    "needs: authorize",
    "publication_required: ${{ steps.identity.outputs.publication_required }}",
    "publish_tag: ${{ steps.identity.outputs.publish_tag }}",
    "Publication requires the exact annotated release tag",
    "environment:\n      name: npm-stage",
    "id-token: write",
    "Downloaded npm artifact must contain exactly the tarball, npm-pack.json, and npm-package.sha256",
    'npm view "$package_spec" version --json',
    "already public; verifying exact idempotent readback",
    'npm publish "$TARBALL"',
    '--tag "$PUBLISH_TAG"',
    'npm view "$package_spec" dist --json',
    "dist.attestations.provenance?.predicateType",
    "dist.signatures.length < 1",
  ]) expect(workflow).toContain(required)
  expect(workflow.match(/id-token: write/gu)).toHaveLength(1)
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toContain("workflow_dispatch:")
  expect(workflow).not.toContain("authorization_run_id")
  expect(workflow).not.toContain("actions: write")
  expect(workflow).not.toMatch(/\bnpm\s+(?:stage|dist-tag)\b/u)
  expect(publishJob).not.toContain("actions/checkout@")
  expect(publishJob).not.toContain("setup-bun@")
  expect(publishJob).not.toContain("./scripts/")
})

test("local release-tag policy rejects spoofed CI, private repositories, and tag conflicts", async () => {
  const sha = "a".repeat(40)
  const otherSha = "b".repeat(40)
  const workflowId = admitActiveCiWorkflow({
    id: 77,
    name: "CI",
    path: ".github/workflows/ci.yml",
    state: "active",
  })
  admitOwner({ id: 894119, type: "User" })
  admitRepository({
    archived: false,
    default_branch: "main",
    disabled: false,
    full_name: "hraness/atet",
    id: 1310516748,
    private: false,
    visibility: "public",
  })
  const releaseEnvironment = {
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    name: "npm-stage",
    protection_rules: [{ type: "branch_policy" }],
  }
  const releasePolicies = { branch_policies: [{ name: "v*", type: "tag" }], total_count: 1 }
  expect(() => admitReleaseEnvironment(releaseEnvironment, releasePolicies)).not.toThrow()
  expect(() => admitReleaseEnvironment(
    { ...releaseEnvironment, can_admins_bypass: true },
    releasePolicies,
  )).toThrow("administrator bypass")
  expect(() => admitReleaseEnvironment({
    ...releaseEnvironment,
    deployment_branch_policy: { custom_branch_policies: false, protected_branches: true },
  }, releasePolicies)).toThrow("branch_policy")
  expect(() => admitReleaseEnvironment({
    ...releaseEnvironment,
    protection_rules: [{ type: "branch_policy" }, { type: "required_reviewers" }],
  }, releasePolicies)).toThrow("only branch_policy")
  expect(() => admitReleaseEnvironment(releaseEnvironment, {
    branch_policies: [{ name: "main", type: "branch" }],
    total_count: 1,
  })).toThrow("v* tag policy")
  const ruleset = (id: number, name: string, rules: readonly string[], bypassOwner = false) => ({
    bypass_actors: bypassOwner
      ? [{ actor_id: 894119, actor_type: "User", bypass_mode: "always" }]
      : [],
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    enforcement: "active",
    id,
    name,
    rules: rules.map((type) => ({ type })),
    target: "tag",
  })
  const rulesetList = [
    { id: 1, name: "Release tag creation" },
    { id: 2, name: "Immutable version tags" },
  ]
  const rulesetDetails = new Map<string, unknown>([
    ["Release tag creation", ruleset(1, "Release tag creation", ["creation"], true)],
    ["Immutable version tags", ruleset(2, "Immutable version tags", ["update", "deletion"])],
  ])
  expect(() => admitReleaseRulesets(rulesetList, rulesetDetails)).not.toThrow()
  rulesetDetails.set("Release tag creation", {
    ...ruleset(1, "Release tag creation", ["creation"], true),
    bypass_actors: [{ actor_id: 15368, actor_type: "Integration", bypass_mode: "always" }],
  })
  expect(() => admitReleaseRulesets(rulesetList, rulesetDetails)).toThrow("unexpected bypass authority")
  rulesetDetails.set("Release tag creation", ruleset(1, "Release tag creation", ["creation"], true))
  rulesetDetails.set("Immutable version tags", ruleset(2, "Immutable version tags", ["creation", "update", "deletion"]))
  expect(() => admitReleaseRulesets(rulesetList, rulesetDetails)).toThrow("unexpected rules")
  expect(() => admitOwner({ id: 894119, type: "Bot" })).toThrow("owner User")
  expect(() => admitRepository({
    archived: false,
    default_branch: "main",
    disabled: false,
    full_name: "hraness/atet",
    id: 1310516748,
    private: true,
    visibility: "private",
  })).toThrow("active hraness/atet")
  admitRemoteRoutes("https://github.com/hraness/atet.git\n", "git@github.com:hraness/atet.git\n")
  expect(() => admitRemoteRoutes(
    "https://github.com/hraness/atet.git\n",
    "https://github.com/hraness/atet.git\nhttps://github.com/attacker/atet.git\n",
  )).toThrow("fetch and push routing")

  const exactRun = {
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_repository: { full_name: "hraness/atet" },
    head_sha: sha,
    id: 88,
    name: "CI",
    path: ".github/workflows/ci.yml",
    repository: { full_name: "hraness/atet" },
    run_attempt: 2,
    status: "completed",
    workflow_id: workflowId,
  }
  const run = admitCiRun({ total_count: 1, workflow_runs: [exactRun] }, workflowId, sha)
  expect(run).toEqual({ runAttempt: 2, runId: 88 })
  expect(() => admitCiRun({
    total_count: 1,
    workflow_runs: [{ ...exactRun, path: ".github/workflows/not-ci.yml" }],
  }, workflowId, sha)).toThrow("exactly one exact CI push run")
  expect(() => admitCiRun({ total_count: 2, workflow_runs: [exactRun] }, workflowId, sha)).toThrow("truncated")
  expect(admitCiRequiredJob({
    jobs: [{ conclusion: "success", head_sha: sha, id: 99, name: "Required", run_attempt: 2, run_id: 88, status: "completed" }],
    total_count: 1,
  }, run, sha)).toBe(99)
  expect(() => admitCiRequiredJob({
    jobs: [{ conclusion: "success", head_sha: sha, id: 99, name: "Required", run_attempt: 1, run_id: 88, status: "completed" }],
    total_count: 1,
  }, run, sha)).toThrow("one Required job")

  const inventory = `${otherSha}\trefs/tags/v3.2.0\n`
  expect(admitRemoteReleaseTags(inventory, "3.3.0", sha)).toBe("absent")
  expect(admitRemoteReleaseTags(inventory, "3.2.1-beta.0", sha)).toBe("absent")
  expect(() => admitRemoteReleaseTags(inventory, "3.1.9", sha)).toThrow("monotonically")
  expect(() => admitRemoteReleaseTags(inventory, "3.1.9-beta.1", sha)).toThrow("monotonically")
  const annotated = `${otherSha}\trefs/tags/v3.3.0\n${sha}\trefs/tags/v3.3.0^{}\n`
  expect(admitRemoteReleaseTags(annotated, "3.3.0", sha)).toBe("same-annotated-commit")
  expect(() => admitRemoteReleaseTags(`${otherSha}\trefs/tags/v3.3.0\n`, "3.3.0", sha)).toThrow("conflicts")
  expect(() => admitRemoteReleaseTags(annotated.replace(sha, otherSha), "3.3.0", sha)).toThrow()
  expect(() => parseReleaseVersion("3.3.0-beta.01")).toThrow("canonical")
})

test("local release-tag mutation follows all identity, CI, and monotonic checks", async () => {
  const source = await readFile(join(import.meta.dir, "push-npm-release-tag.ts"), "utf8")
  for (const required of [
    "PROCESS_TIMEOUT_MS = 30_000",
    "MAXIMUM_OUTPUT_BYTES = 1024 * 1024",
    'GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0"',
    '["git", "remote", "get-url", "--push", "--all", "origin"]',
    'admitOwner(await jsonCommand(["gh", "api", "user"]',
    "admitProtectedBranch(",
    "admitActiveCiWorkflow(",
    "admitCiRun(runInventory",
    "admitCiRequiredJob(jobs",
    "admitReleaseEnvironment(",
    "admitReleaseRulesets(rulesetList, rulesetDetails)",
    "repos/${EXPECTED_REPOSITORY}/rulesets",
    "/deployment-branch-policies",
    "const firstAdmission = admitRemoteReleaseTags",
    "const secondAdmission = admitRemoteReleaseTags",
    "refusing an inherited tag object",
    'command(["git", "tag", "--annotate"',
    '`refs/tags/${release.tag}:refs/tags/${release.tag}`',
    '["git", "update-ref", "-d", `refs/tags/${release.tag}`, createdTagObject]',
  ]) expect(source).toContain(required)
  const requiredJob = source.indexOf("const jobId = admitCiRequiredJob")
  const environmentAdmission = source.indexOf("  admitReleaseEnvironment(\n    await jsonCommand(")
  const rulesetAdmission = source.indexOf("  admitReleaseRulesets(rulesetList, rulesetDetails)")
  const secondInventory = source.indexOf("const secondAdmission = admitRemoteReleaseTags")
  const tagMutation = source.indexOf('["git", "tag", "--annotate"')
  const exactPush = source.indexOf('`refs/tags/${release.tag}:refs/tags/${release.tag}`')
  const compareDelete = source.indexOf('["git", "update-ref", "-d", `refs/tags/${release.tag}`, createdTagObject]')
  expect(requiredJob).toBeGreaterThan(-1)
  expect(environmentAdmission).toBeGreaterThan(-1)
  expect(rulesetAdmission).toBeGreaterThan(-1)
  expect(secondInventory).toBeGreaterThan(requiredJob)
  expect(tagMutation).toBeGreaterThan(secondInventory)
  expect(tagMutation).toBeGreaterThan(environmentAdmission)
  expect(tagMutation).toBeGreaterThan(rulesetAdmission)
  expect(exactPush).toBeGreaterThan(tagMutation)
  expect(compareDelete).toBeGreaterThan(exactPush)
})

test("version 3.2.0 publishes one Atet identity with npm install instructions", async () => {
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

  expect(manifest.version).toBe("3.2.0")
  expect(manifest.bin).toEqual({
    atet: "./apps/desktop/dist/cli/main.js",
  })
  expect((manifest as { readonly contentPolicy?: unknown }).contentPolicy).toEqual({
    class: "dual-use",
  })

  const npmCliInstall = "@hraness/atet@3.2.0"
  const immutableSkillInstall =
    "https://github.com/hraness/atet/tree/v3.2.0 --skill atet"
  for (const source of [readme, skillInstall, siteMarkdown, siteTemplate]) {
    expect(source).toContain(npmCliInstall)
  }
  for (const source of [readme, siteBuild, siteMarkdown]) {
    expect(source).toContain(immutableSkillInstall)
  }
  expect(siteTemplate).toContain('"softwareVersion": "3.2.0"')
  expect(siteTemplate).toContain('"version": "3.2.0"')
  expect(readme).toContain("github:hraness/atet#v3.2.0")
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
  const normalizedPublishing = publishing.replace(/\s+/gu, " ")
  expect(publishing).toContain("npm publish <reviewed-tarball>")
  expect(publishing).toContain("--ignore-scripts")
  expect(publishing).toContain("--provenance")
  expect(publishing).toContain("allowed action: direct `npm publish` (`--allow-publish`)")
  expect(publishing).toContain("environment: `npm-stage` (`--environment npm-stage`)")
  expect(normalizedPublishing).toContain(
    "its sole deployment policy must be tag pattern `v*`",
  )
  expect(normalizedPublishing).toContain("disable administrator bypass")
  expect(normalizedPublishing).toContain("with no required deployment reviewers")
  expect(normalizedPublishing).toContain("must match `npm-stage` exactly")
  expect(publishing).toContain("Do not grant `--allow-stage`")
  expect(publishing).toContain("Require two-factor authentication and")
  expect(publishing).toContain("disallow tokens")
  expect(publishing).toContain("This section records the one-time `3.1.1` bootstrap")
  expect(publishing).toContain("Do not reuse the")
  expect(normalizedPublishing).toContain("interactive path for a later release")
  expect(publishing).toContain("bun run ./scripts/push-npm-release-tag.ts <exact-version>")
  expect(normalizedPublishing).toContain(
    "requires authenticated immutable owner `User` ID `894119`, public repository ID `1310516748`",
  )
  expect(normalizedPublishing).toContain(
    "pushes only that exact ref",
  )
  expect(normalizedPublishing).toContain(
    "only the minimal publishing job may reference this environment",
  )
  expect(normalizedPublishing).toContain(
    "`npm-stage` environment and starts without GitHub deployment approval",
  )
  expect(normalizedPublishing).toContain("checks out no source and runs no repository code")
  expect(normalizedPublishing).toContain(
    "Stable versions publish with `--tag latest`; beta versions publish with `--tag beta`",
  )
  expect(publishing).toContain("npm-package.sha256")
  expect(normalizedPublishing).toContain(
    "rehashes the package, proves the exact tag commit, publishes the exact tarball directly",
  )
  expect(normalizedPublishing).toContain(
    "**Immutable version tags** restricts updates and deletions with an empty bypass list",
  )
  expect(normalizedPublishing).toContain(
    "**Release tag creation** restricts creation and gives only immutable owner `User` ID `894119` an always bypass",
  )
  expect(normalizedPublishing).toContain("Never give GitHub Actions integration ID `15368` this bypass")
  expect(publishing).toContain("Never use\n   `npm dist-tag` promotion")
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
