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
  expect(workflow).toContain(
    "git status --porcelain --untracked-files=all -- dist bun.lock",
  )
  expect(workflow).toContain("bun pm pack --dry-run --ignore-scripts")
  expect(workflow).toContain('"./dist/code/index.js"')
  expect(workflow).toContain('"./dist/code/advanced.js"')
  expect(workflow).toContain('"./dist/workflow.js"')
  expect(workflow).toContain("is not newer than")
  expect(workflow).toContain('gh release create "$GITHUB_REF_NAME"')
  expect(workflow).toContain("--verify-tag")
  expect(workflow).toContain("--generate-notes")
  expect(workflow).toContain("--latest")
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

test("public vectorizer workflow verifies every reviewed platform without write permissions", async () => {
  const workflow = await readWorkflow("public-vectorizer.yml", "vectorizer.yml")

  expect(workflow).toContain("permissions:\n  contents: read")
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
