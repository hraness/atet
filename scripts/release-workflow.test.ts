import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

test("version tags pass the complete immutable release gate", async () => {
  const workflow = await readFile(
    join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
    "utf8",
  )

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
