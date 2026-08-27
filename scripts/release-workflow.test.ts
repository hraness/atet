import { expect, test } from "bun:test"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

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
  expect(workflow).toContain('const { createHash } = require("node:crypto")')
  expect(workflow).toContain('value.integrity !== integrity || value.shasum !== shasum')
  expect(workflow).toContain('"entryCount", "filename", "integrity", "name", "shasum", "size", "unpackedSize"')
  expect(workflow).toContain("published npm inventory differs from the checked source artifact")
  expect(workflow).toContain('cmp --silent "$source_archive" "$registry_archive"')
  expect(workflow).toContain("sha512sum \"$source_archive\" \"$registry_archive\"")
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

  const artifactReferenceIndex = stageJob.indexOf("Bind artifact reference")
  const downloadIndex = stageJob.indexOf("Download reviewed package")
  const rebindIndex = stageJob.indexOf("Rebind downloaded package")
  const fetchIndex = stageJob.lastIndexOf('git --git-dir="$current_main" fetch')
  const rehashIndex = stageJob.lastIndexOf('current_archive_sha256="$(sha256sum "$TARBALL"')
  const stageIndex = stageJob.indexOf('npm stage publish "$TARBALL"')
  expect(artifactReferenceIndex).toBeLessThan(downloadIndex)
  expect(downloadIndex).toBeLessThan(rebindIndex)
  expect(rebindIndex).toBeLessThan(fetchIndex)
  expect(fetchIndex).toBeLessThan(rehashIndex)
  expect(rehashIndex).toBeLessThan(stageIndex)
  expect(stageIndex).toBeGreaterThan(-1)
  expect(stageJob.slice(stageIndex)).toContain("--access public")
  expect(stageJob.slice(stageIndex)).toContain("--registry=https://registry.npmjs.org")
  expect(workflow.match(/--registry=https:\/\/registry\.npmjs\.org/gu)?.length).toBeGreaterThanOrEqual(5)
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toMatch(/npm publish(?:\s|$)/u)
  expect(workflow).not.toContain("push:")
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
  expect(publishing).toContain("allowed action: `npm stage publish` only")
  expect(publishing).toContain("Require two-factor authentication and")
  expect(publishing).toContain("disallow tokens")
  expect(publishing).toContain("Do not create the matching Git tag yet")
  expect(publishing).toContain("only job with OIDC authority")
  expect(publishing).toContain("checks out no source and runs no repository code")
  expect(publishing).toContain("npm-package.sha256")

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
