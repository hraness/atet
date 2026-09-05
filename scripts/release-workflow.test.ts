import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

import { verifyNpmPackageIdentity } from "./npm-package-identity"
import { verifyNpmPublishAuthority } from "./npm-publish-authority"
import { verifyNpmPublishConfig, verifyNpmPublishManifest } from "./npm-publish-policy"
import {
  admitPublishedNpmVersion,
  admitRemoteReleaseTags,
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

test("the write job reauthorizes the exact run attempt and rejects collaborator reruns", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:\n"))
  const authorizationIndex = publishJob.indexOf("Reauthorize current release attempt")
  const immediateLatestIndex = publishJob.indexOf(
    "npm latest changed immediately before GitHub Release publication",
  )
  const mutationIndex = publishJob.indexOf('gh release create "$GITHUB_REF_NAME"')
  expect(publishJob).toContain("permissions:\n      actions: read\n      contents: write")
  expect(authorizationIndex).toBeGreaterThan(-1)
  expect(authorizationIndex).toBeLessThan(mutationIndex)
  expect(immediateLatestIndex).toBeGreaterThan(authorizationIndex)
  expect(immediateLatestIndex).toBeLessThan(mutationIndex)
  expect(publishJob).toContain(
    '"/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT"',
  )
  expect(publishJob).toContain('EXPECTED_WORKFLOW_ID: "320001524"')
  expect(publishJob).toContain('EXPECTED_DEFAULT_BRANCH: "main"')
  expect(publishJob).toContain('attempt.triggering_actor?.id !== actorId')
  expect(publishJob).toContain('attempt.triggering_actor?.type !== "User"')
  expect(publishJob).toContain('EXPECTED_RELEASE_AUTHOR_ID: "41898282"')
  expect(publishJob).toContain("atet-release-provenance:v1")
  expect(publishJob).toContain("Existing GitHub Release is not the exact GitHub Actions provenance-bound release")

  const script = workflowStepScript(workflow, "Reauthorize current release attempt")
  const directory = await mkdtemp(join(tmpdir(), "atet-release-attempt-"))
  const binaryDirectory = join(directory, "bin")
  const attemptPath = join(directory, "attempt.json")
  const workflowPath = join(directory, "workflow.json")
  const stageAttemptPath = join(directory, "stage-attempt.json")
  const stageJobsPath = join(directory, "stage-jobs.json")
  const stageWorkflowPath = join(directory, "stage-workflow.json")
  const repositoryPath = join(directory, "repository.json")
  const commandLog = join(directory, "gh.log")
  const sourceSha = "a".repeat(40)
  const attempt = {
    id: 12345,
    run_attempt: 2,
    workflow_id: 320001524,
    name: "Release",
    path: ".github/workflows/release.yml",
    event: "push",
    head_branch: "v3.2.0",
    head_sha: sourceSha,
    status: "in_progress",
    conclusion: null,
    actor: { id: 894119, type: "User" },
    triggering_actor: { id: 894119, type: "User" },
    repository: {
      id: 1310516748,
      full_name: "hraness/atet",
      private: false,
    },
  }
  const stageAttempt = {
    id: 67890,
    run_attempt: 3,
    workflow_id: 344208600,
    name: "Stage npm package",
    path: ".github/workflows/npm-stage.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
    actor: { id: 894119, type: "User" },
    triggering_actor: { id: 894119, type: "User" },
    repository: {
      id: 1310516748,
      full_name: "hraness/atet",
      private: false,
    },
  }
  const stageJobs = {
    total_count: 1,
    jobs: [{
      name: "Stage exact package v3.2.0",
      head_sha: sourceSha,
      conclusion: "success",
      steps: [
        { name: "Record exclusive stable-stage intent", conclusion: "success" },
        { name: "Revalidate current main and stage exact package", conclusion: "success" },
      ],
    }],
  }

  try {
    await mkdir(binaryDirectory, { recursive: true })
    await writeFile(
      join(binaryDirectory, "gh"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'printf \'%s\\n\' "$*" >> "$GH_COMMAND_LOG"',
        'endpoint=""',
        'for argument in "$@"; do endpoint="$argument"; done',
        'case "$endpoint" in',
        '  */actions/runs/67890/attempts/3/jobs?per_page=100) cat "$MOCK_STAGE_JOBS_JSON" ;;',
        '  */actions/runs/67890/attempts/3) cat "$MOCK_STAGE_ATTEMPT_JSON" ;;',
        '  */actions/runs/*) cat "$MOCK_ATTEMPT_JSON" ;;',
        '  */actions/workflows/344208600) cat "$MOCK_STAGE_WORKFLOW_JSON" ;;',
        '  */actions/workflows/*) cat "$MOCK_WORKFLOW_JSON" ;;',
        '  */commits/v3.2.0) printf \'%s\\n\' "$MOCK_SOURCE_SHA" ;;',
        '  */commits/main) printf \'%s\\n\' "$MOCK_SOURCE_SHA" ;;',
        '  */compare/*) printf \'identical\\n\' ;;',
        '  /repos/hraness/atet) cat "$MOCK_REPOSITORY_JSON" ;;',
        '  *) echo "unexpected gh endpoint: $endpoint" >&2; exit 2 ;;',
        "esac",
      ].join("\n"),
    )
    await chmod(join(binaryDirectory, "gh"), 0o755)
    await Promise.all([
      writeFile(attemptPath, JSON.stringify(attempt)),
      writeFile(workflowPath, JSON.stringify({
        id: 320001524,
        name: "Release",
        path: ".github/workflows/release.yml",
        state: "active",
      })),
      writeFile(stageAttemptPath, JSON.stringify(stageAttempt)),
      writeFile(stageJobsPath, JSON.stringify(stageJobs)),
      writeFile(stageWorkflowPath, JSON.stringify({
        id: 344208600,
        name: "Stage npm package",
        path: ".github/workflows/npm-stage.yml",
        state: "active",
      })),
      writeFile(repositoryPath, JSON.stringify({
        id: 1310516748,
        full_name: "hraness/atet",
        visibility: "public",
        private: false,
        default_branch: "main",
      })),
    ])
    const environment = {
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      GH_COMMAND_LOG: commandLog,
      MOCK_ATTEMPT_JSON: attemptPath,
      MOCK_WORKFLOW_JSON: workflowPath,
      MOCK_STAGE_ATTEMPT_JSON: stageAttemptPath,
      MOCK_STAGE_JOBS_JSON: stageJobsPath,
      MOCK_STAGE_WORKFLOW_JSON: stageWorkflowPath,
      MOCK_REPOSITORY_JSON: repositoryPath,
      MOCK_SOURCE_SHA: sourceSha,
      RUNNER_TEMP: directory,
      EXPECTED_ACTOR_ID: "894119",
      EXPECTED_REPOSITORY: "hraness/atet",
      EXPECTED_REPOSITORY_ID: "1310516748",
      EXPECTED_DEFAULT_BRANCH: "main",
      EXPECTED_WORKFLOW_ID: "320001524",
      EXPECTED_WORKFLOW_NAME: "Release",
      EXPECTED_WORKFLOW_PATH: ".github/workflows/release.yml",
      EXPECTED_STAGE_RUN_ID: "67890",
      EXPECTED_STAGE_RUN_ATTEMPT: "3",
      EXPECTED_STAGE_WORKFLOW_ID: "344208600",
      EXPECTED_STAGE_WORKFLOW_NAME: "Stage npm package",
      EXPECTED_STAGE_WORKFLOW_PATH: ".github/workflows/npm-stage.yml",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: "hraness/atet",
      GITHUB_REPOSITORY_ID: "1310516748",
      GITHUB_REF: "refs/tags/v3.2.0",
      GITHUB_SHA: sourceSha,
      VERIFIED_TAG: "v3.2.0",
      VERIFIED_STAGE_RUN_ID: "67890",
      VERIFIED_STAGE_RUN_ATTEMPT: "3",
    }
    const admitted = await runWorkflowScript(script, environment)
    expect(admitted.exitCode).toBe(0)
    expect(await readFile(commandLog, "utf8")).toContain(
      "actions/runs/12345/attempts/2",
    )

    for (const conclusion of ["failure", "cancelled", "timed_out"] as const) {
      await Promise.all([
        writeFile(stageAttemptPath, JSON.stringify({ ...stageAttempt, conclusion })),
        writeFile(stageJobsPath, JSON.stringify({
          ...stageJobs,
          jobs: [{
            ...stageJobs.jobs[0],
            conclusion,
            steps: [
              { name: "Record exclusive stable-stage intent", conclusion: "success" },
              { name: "Revalidate current main and stage exact package", conclusion },
            ],
          }],
        })),
      ])
      const ambiguousAcceptedStage = await runWorkflowScript(script, environment)
      expect(ambiguousAcceptedStage.exitCode).toBe(0)
    }

    await Promise.all([
      writeFile(stageAttemptPath, JSON.stringify(stageAttempt)),
      writeFile(stageJobsPath, JSON.stringify({
        ...stageJobs,
        jobs: [{
          ...stageJobs.jobs[0],
          steps: [
            { name: "Revalidate current main and stage exact package", conclusion: "success" },
            { name: "Record exclusive stable-stage intent", conclusion: "success" },
          ],
        }],
      })),
    ])
    const misorderedIntent = await runWorkflowScript(script, environment)
    expect(misorderedIntent.exitCode).not.toBe(0)
    expect(misorderedIntent.stderr).toContain("lacks the exact pre-mutation intent")

    await writeFile(stageJobsPath, JSON.stringify(stageJobs))

    await writeFile(attemptPath, JSON.stringify({
      ...attempt,
      triggering_actor: { id: 123456, type: "User" },
    }))
    const hostileRerun = await runWorkflowScript(script, environment)
    expect(hostileRerun.exitCode).not.toBe(0)
    expect(hostileRerun.stderr).toContain(
      "Current release attempt is not owner-authorized",
    )

    await writeFile(attemptPath, JSON.stringify(attempt))
    await writeFile(stageAttemptPath, JSON.stringify({
      ...stageAttempt,
      triggering_actor: { id: 123456, type: "User" },
    }))
    const hostileStageRerun = await runWorkflowScript(script, environment)
    expect(hostileStageRerun.exitCode).not.toBe(0)
    expect(hostileStageRerun.stderr).toContain(
      "Signed npm provenance does not resolve to the owner-authorized staging attempt",
    )

    await writeFile(stageAttemptPath, JSON.stringify(stageAttempt))
    await writeFile(repositoryPath, JSON.stringify({
      id: 1310516748,
      full_name: "hraness/atet",
      visibility: "private",
      private: true,
      default_branch: "main",
    }))
    const privateRepository = await runWorkflowScript(script, environment)
    expect(privateRepository.exitCode).not.toBe(0)
    expect(privateRepository.stderr).toContain(
      "Current release attempt is not owner-authorized",
    )

    await writeFile(repositoryPath, JSON.stringify({
      id: 1310516748,
      full_name: "hraness/atet",
      visibility: "public",
      private: false,
      default_branch: "main",
    }))
    const movedTag = await runWorkflowScript(script, {
      ...environment,
      MOCK_SOURCE_SHA: "c".repeat(40),
    })
    expect(movedTag.exitCode).not.toBe(0)
    expect(movedTag.stdout).toContain("Tag v3.2.0 moved")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the final write job re-reads exact npm latest and signed authority metadata", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")
  const script = workflowStepScript(workflow, "Revalidate live public npm authority")
  const directory = await mkdtemp(join(tmpdir(), "atet-live-npm-authority-"))
  const binaryDirectory = join(directory, "bin")
  const versionPath = join(directory, "version.json")
  const tagsPath = join(directory, "tags.json")
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`
  const attestationUrl =
    "https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fatet@3.2.0"
  const versionReceipt = {
    name: "@hraness/atet",
    version: "3.2.0",
    dist: {
      integrity,
      signatures: [{
        keyid: "SHA256:fixture",
        sig: Buffer.from("registry signature").toString("base64"),
      }],
      attestations: {
        url: attestationUrl,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  }
  try {
    await mkdir(binaryDirectory, { recursive: true })
    await writeFile(join(binaryDirectory, "curl"), `#!/bin/bash
set -euo pipefail
case "$*" in
  *dist-tags) cat "$MOCK_DIST_TAGS" ;;
  *) cat "$MOCK_VERSION_VIEW" ;;
esac
`, "utf8")
    await chmod(join(binaryDirectory, "curl"), 0o755)
    await Promise.all([
      writeFile(versionPath, JSON.stringify(versionReceipt)),
      writeFile(tagsPath, JSON.stringify({ latest: "3.2.0" })),
    ])
    const environment = {
      MOCK_DIST_TAGS: tagsPath,
      MOCK_VERSION_VIEW: versionPath,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: directory,
      VERIFIED_NPM_ATTESTATION_URL: attestationUrl,
      VERIFIED_NPM_INTEGRITY: integrity,
      VERIFIED_TAG: "v3.2.0",
    }
    expect((await runWorkflowScript(script, environment)).exitCode).toBe(0)

    await writeFile(tagsPath, JSON.stringify({ latest: "3.3.0" }))
    const movedLatest = await runWorkflowScript(script, environment)
    expect(movedLatest.exitCode).not.toBe(0)
    expect(movedLatest.stderr).toContain(
      "Live npm latest, archive, signatures, or attestations changed",
    )

    await Promise.all([
      writeFile(tagsPath, JSON.stringify({ latest: "3.2.0" })),
      writeFile(versionPath, JSON.stringify({
        ...versionReceipt,
        dist: { ...versionReceipt.dist, signatures: [] },
      })),
    ])
    const missingSignature = await runWorkflowScript(script, environment)
    expect(missingSignature.exitCode).not.toBe(0)
    expect(missingSignature.stderr).toContain(
      "Live npm latest, archive, signatures, or attestations changed",
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test("the GitHub Release write rejects moved latest and provenance front-running", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")
  const script = workflowStepScript(workflow, "Publish verified GitHub Release")
  const directory = await mkdtemp(join(tmpdir(), "atet-release-publication-"))
  const binaryDirectory = join(directory, "bin")
  const commandLog = join(directory, "gh.log")
  const mutationMarker = join(directory, "release-created")
  const releasePath = join(directory, "release.json")
  const tagsPath = join(directory, "tags.json")
  const sourceSha = "a".repeat(40)
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`
  const attestationUrl =
    "https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fatet@3.2.0"
  const provenance = `<!-- atet-release-provenance:v1
workflow=.github/workflows/release.yml
repository=hraness/atet
tag=v3.2.0
source-sha=${sourceSha}
stage-run-id=67890
stage-run-attempt=3
npm-integrity=${integrity}
npm-attestation=${attestationUrl}
-->
`
  const exactRelease = {
    author: { id: 41898282, login: "github-actions[bot]" },
    body: `${provenance}\nGenerated notes`,
    draft: false,
    name: "Atet v3.2.0",
    prerelease: false,
    tag_name: "v3.2.0",
  }

  try {
    await mkdir(binaryDirectory, { recursive: true })
    await Promise.all([
      writeFile(join(binaryDirectory, "curl"), `#!/bin/bash
set -euo pipefail
cat "$MOCK_DIST_TAGS"
`),
      writeFile(join(binaryDirectory, "gh"), `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_COMMAND_LOG"
if [[ "\${1-}" == release && "\${2-}" == view ]]; then
  if [[ "$*" == *'--json'* ]]; then
    printf 'v3.2.0\tAtet v3.2.0\tfalse\tfalse\ttrue\t0\n'
  fi
elif [[ "\${1-}" == release && "\${2-}" == create ]]; then
  printf 'created\n' > "$MUTATION_MARKER"
elif [[ "\${1-}" == api && "$*" == *'/releases/tags/v3.2.0'* ]]; then
  cat "$MOCK_RELEASE_JSON"
elif [[ "\${1-}" == api && "$*" == *'/releases/latest'* ]]; then
  printf 'v3.2.0\n'
else
  echo "unexpected gh invocation: $*" >&2
  exit 64
fi
`),
      writeFile(releasePath, JSON.stringify(exactRelease)),
      writeFile(tagsPath, JSON.stringify({ latest: "3.2.0" })),
    ])
    await Promise.all([
      chmod(join(binaryDirectory, "curl"), 0o755),
      chmod(join(binaryDirectory, "gh"), 0o755),
    ])
    const environment = {
      EXPECTED_RELEASE_AUTHOR_ID: "41898282",
      EXPECTED_RELEASE_AUTHOR_LOGIN: "github-actions[bot]",
      GH_COMMAND_LOG: commandLog,
      GITHUB_REF_NAME: "v3.2.0",
      GITHUB_REPOSITORY: "hraness/atet",
      GITHUB_SHA: sourceSha,
      MOCK_DIST_TAGS: tagsPath,
      MOCK_RELEASE_JSON: releasePath,
      MUTATION_MARKER: mutationMarker,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: directory,
      VERIFIED_NPM_ATTESTATION_URL: attestationUrl,
      VERIFIED_NPM_INTEGRITY: integrity,
      VERIFIED_STAGE_RUN_ATTEMPT: "3",
      VERIFIED_STAGE_RUN_ID: "67890",
      VERIFIED_TAG: "v3.2.0",
    }
    expect((await runWorkflowScript(script, environment)).exitCode).toBe(0)
    expect(await Bun.file(mutationMarker).exists()).toBe(false)

    for (const frontRun of [
      { ...exactRelease, author: { id: 894119, login: "0thernet" } },
      { ...exactRelease, body: "Generated notes without bound provenance" },
    ]) {
      await writeFile(releasePath, JSON.stringify(frontRun))
      const rejected = await runWorkflowScript(script, environment)
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stderr).toContain(
        "Existing GitHub Release is not the exact GitHub Actions provenance-bound release",
      )
      expect(await Bun.file(mutationMarker).exists()).toBe(false)
    }

    await Promise.all([
      writeFile(releasePath, JSON.stringify(exactRelease)),
      writeFile(tagsPath, JSON.stringify({ latest: "3.3.0" })),
      rm(commandLog, { force: true }),
    ])
    const movedLatest = await runWorkflowScript(script, environment)
    expect(movedLatest.exitCode).not.toBe(0)
    expect(movedLatest.stderr).toContain(
      "npm latest changed immediately before GitHub Release publication",
    )
    expect(await Bun.file(commandLog).exists()).toBe(false)
    expect(await Bun.file(mutationMarker).exists()).toBe(false)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test("owner-created stable tags pass the complete immutable release gate", async () => {
  const workflow = await readWorkflow("public-release.yml", "release.yml")

  expect(workflow).toContain('tags:\n      - "v*"\n      - "!v*-beta.*"')
  expect(workflow).toContain("Authorize owner release tag")
  expect(workflow).toContain('EXPECTED_ACTOR_ID: "894119"')
  expect(workflow).toContain('EXPECTED_REPOSITORY_ID: "1310516748"')
  expect(workflow).toContain('event.repository?.visibility !== "public"')
  expect(workflow).toContain('event.repository?.private !== false')
  expect(workflow).toContain("github.ref_protected")
  expect(workflow).toContain("needs: authorize")
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
    'npm view "$package_name@$package_version" name version dist dist-tags --json',
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
  expect(workflow).toContain("npm install npm@11.19.0")
  expect(workflow).toContain('--prefix "$npm_tool_directory"')
  expect(workflow).toContain("--ignore-scripts")
  expect(workflow).toContain("audit signatures")
  expect(workflow).toContain("--include-attestations")
  expect(workflow).toContain("bun run ./scripts/npm-publish-authority.ts")
  expect(workflow).toContain("stage_run_id: ${{ steps.npm_authority.outputs.stage_run_id }}")
  expect(workflow).toContain("stage_run_attempt: ${{ steps.npm_authority.outputs.stage_run_attempt }}")
  expect(workflow).toContain("npm_integrity: ${{ steps.npm_authority.outputs.npm_integrity }}")
  expect(workflow).toContain("npm_attestation_url: ${{ steps.npm_authority.outputs.npm_attestation_url }}")
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
  expect(workflow).toContain('current_tag_sha="$(gh api --method GET --jq')
  expect(workflow).toContain(
    '"/repos/$GITHUB_REPOSITORY/compare/$GITHUB_SHA...$current_default_sha"',
  )
  expect(workflow).toContain('EXPECTED_STAGE_WORKFLOW_ID: "344208600"')
  expect(workflow).toContain("stageAttempt.triggering_actor?.id !== actorId")
  expect(workflow).toContain('stageAttempt.status !== "completed"')
  expect(workflow).toContain('terminalConclusions.has(stageAttempt.conclusion)')
  expect(workflow).toContain(
    'actions/runs/$VERIFIED_STAGE_RUN_ID/attempts/$VERIFIED_STAGE_RUN_ATTEMPT/jobs?per_page=100',
  )
  expect(workflow).toContain('job?.name === `Stage exact package v${expectedVersion}`')
  expect(workflow).toContain('step?.name === "Record exclusive stable-stage intent"')
  expect(workflow).toContain(
    'step?.name === "Revalidate current main and stage exact package"',
  )
  expect(workflow).toContain("mutationIndexes[0] !== intentIndexes[0] + 1")
  expect(workflow).not.toContain('stageAttempt.conclusion !== "success"')
  expect(workflow).toContain("name: Revalidate live public npm authority")
  expect(workflow).toContain("https://registry.npmjs.org/-/package/@hraness%2Fatet/dist-tags")
  expect(workflow).toContain("Live npm latest, archive, signatures, or attestations changed")
  const finalAttemptIndex = workflow.indexOf("name: Reauthorize current release attempt")
  const finalNpmIndex = workflow.indexOf("name: Revalidate live public npm authority")
  const releaseMutationIndex = workflow.indexOf('gh release create "$GITHUB_REF_NAME"')
  expect(finalAttemptIndex).toBeLessThan(finalNpmIndex)
  expect(finalNpmIndex).toBeLessThan(releaseMutationIndex)
  expect(workflow).toContain('gh release create "$GITHUB_REF_NAME"')
  expect(workflow).toContain("--verify-tag")
  expect(workflow).toContain("--generate-notes")
  expect(workflow).toContain("--latest")
  expect(workflow).toContain('--title "Atet $GITHUB_REF_NAME"')
  expect(workflow).toContain(
    "--json assets,isDraft,isImmutable,isPrerelease,name,tagName",
  )
  expect(workflow).toContain('--notes-file "$release_notes"')
  expect(workflow).toContain('release?.author?.id !== authorId')
  expect(workflow).toContain('release?.author?.login !== process.env.EXPECTED_RELEASE_AUTHOR_LOGIN')
  expect(workflow).toContain('!release.body.startsWith(provenance)')
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
    filename: "hraness-atet-3.2.0.tgz",
    files,
    id: "@hraness/atet@3.2.0",
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    name: "@hraness/atet",
    shasum: createHash("sha1").update(archive).digest("hex"),
    size: archive.length,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    version: "3.2.0",
  }]
}

const stageRequiredPaths = [
  "DISCLOSURE",
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
  "skills/atet/SKILL.md",
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

type StageTarMutation = (tar: Buffer) => void

async function writeStageArtifactFixture(
  root: string,
  mutation?: StageTarMutation,
): Promise<Readonly<{ metadata: string; registryView: string; tarball: string }>> {
  const artifactDirectory = join(root, "atet-npm-stage")
  const tarballName = "hraness-atet-3.2.0.tgz"
  const manifest = `${JSON.stringify({
    name: "@hraness/atet",
    version: "3.2.0",
    type: "module",
    contentPolicy: { class: "dual-use" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  })}\n`
  const entries: PackageFixtureEntry[] = stageRequiredPaths.map(path => ({
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
        tarball: "https://registry.npmjs.org/@hraness/atet/-/atet-3.2.0.tgz",
        unpackedSize: packResult.unpackedSize,
      },
      name: "@hraness/atet",
      version: "3.2.0",
    })),
    writeFile(
      join(artifactDirectory, "npm-package.sha256"),
      `${createHash("sha256").update(archive).digest("hex")}  ${tarballName}\n${createHash("sha256").update(metadata).digest("hex")}  npm-pack.json\n`,
    ),
  ])
  return {
    metadata: join(artifactDirectory, "npm-pack.json"),
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

test("npm publication authority binds latest, registry signatures, signed provenance, and stage invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-npm-authority-"))
  const entries = [
    { body: "read me\n", mode: 0o644, path: "README.md" },
    { body: '{"name":"@hraness/atet","version":"3.2.0"}\n', mode: 0o644, path: "package.json" },
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
      name: "pkg:npm/%40hraness/atet@3.2.0",
      digest: { sha512 },
    }]
    const publishStatement = {
      _type: "https://in-toto.io/Statement/v0.1",
      subject,
      predicateType: publishPredicate,
      predicate: {
        name: "@hraness/atet",
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
              repository: "https://github.com/hraness/atet",
              ref: "refs/heads/main",
              path: ".github/workflows/npm-stage.yml",
            },
          },
          internalParameters: {
            github: {
              event_name: "workflow_dispatch",
              repository_id: "1310516748",
              repository_owner_id: "307125679",
            },
          },
          resolvedDependencies: [{
            uri: "git+https://github.com/hraness/atet@refs/heads/main",
            digest: { gitCommit: sourceSha },
          }],
        },
        runDetails: {
          builder: { id: "https://github.com/actions/runner/github-hosted" },
          metadata: {
            invocationId: "https://github.com/hraness/atet/actions/runs/45678/attempts/2",
          },
        },
      },
    }
    const attestationUrl = "https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fatet@3.2.0"
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
        name: "@hraness/atet",
        version: "3.2.0",
        location: "node_modules/@hraness/atet",
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
      expectedName: "@hraness/atet",
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
            uri: "git+https://github.com/hraness/atet@refs/heads/main",
            digest: { gitCommit: "b".repeat(40) },
          }],
        },
      },
    })
    await Bun.write(auditPath, JSON.stringify(wrongSourceAudit))
    await expect(verifyNpmPublishAuthority(input)).rejects.toThrow(
      "does not bind the exact npm staging workflow and source",
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
    name: "@hraness/atet",
    version: "3.2.0",
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org",
    },
  })).not.toThrow()
  expect(() => verifyNpmPublishManifest({
    name: "@hraness/atet",
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
    "exceeds npm 11's safe SemVer component bound",
  )
  expect(() => admitPublishedNpmVersion({
    name: "@hraness/atet",
    version: "3.2.0",
    "dist-tags": { latest: "3.1.1" },
  }, "3.2.0")).toThrow("Public npm latest must identify")
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

  const script = await readFile(join(import.meta.dir, "push-npm-release-tag.ts"), "utf8")
  expect(script).toContain("Release tag creation")
  expect(script).toContain("Immutable version tags")
  expect(script).toContain("Verify public npm latest")
  expect(script).toContain('["git", "push", "origin", `refs/tags/${release.tag}:refs/tags/${release.tag}`]')
  expect(script).not.toMatch(/npm publish(?:\s|$)/u)
})

test("a stable version builds automatically and only an owner dispatch stages the exact npm artifact", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")

  const verifyStart = workflow.indexOf("  verify:\n")
  const stageStart = workflow.indexOf("\n  stage:\n")
  expect(verifyStart).toBeGreaterThan(-1)
  expect(stageStart).toBeGreaterThan(verifyStart)
  const verifyJob = workflow.slice(verifyStart, stageStart)
  const stageJob = workflow.slice(stageStart)

  expect(workflow).toContain("push:\n    branches:\n      - main\n    paths:\n      - package.json")
  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow).toContain(
    "publish_to_npm:\n        description: Stage the verified package through npm trusted publishing\n        required: false\n        default: false\n        type: boolean",
  )
  expect(workflow).toContain(
    "resolved_stage_version:\n        description: Exact cleared stage-intent version that releases the retained history lock",
  )
  expect(workflow).toContain("stage_required: ${{ steps.identity.outputs.stage_required }}")
  expect(verifyJob).toContain("name: Verify exact package")
  expect(verifyJob).toContain("permissions:\n      contents: read")
  expect(verifyJob).not.toContain("id-token: write")
  expect(verifyJob).not.toContain("environment:")
  expect(verifyJob).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0")
  expect(verifyJob).toContain('node-version: "24"')
  expect(verifyJob).toContain('bun-version: "1.3.14"')
  expect(verifyJob).toContain("npm install --global --ignore-scripts npm@11.19.0")
  expect(verifyJob).toContain('[[ "$(npm --version)" == "11.19.0" ]]')
  expect(verifyJob).toContain('if [[ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]]')
  expect(verifyJob).toContain('"$GITHUB_SHA" != "$default_sha" || "$checked_out_sha" != "$default_sha"')
  expect(verifyJob).toContain('case "$GITHUB_EVENT_NAME" in')
  expect(verifyJob).toContain('git cat-file -e "$PUSH_BEFORE^{commit}"')
  expect(verifyJob).toContain('git merge-base --is-ancestor "$PUSH_BEFORE" "$GITHUB_SHA"')
  expect(verifyJob).toContain('git show "$PUSH_BEFORE:package.json"')
  expect(verifyJob).toContain("package.json changed without changing version")
  expect(verifyJob).toContain("stage_required=false")
  expect(verifyJob).toContain("stage_required=true")
  expect(verifyJob).toContain("must be newer than")
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
  expect(verifyJob.match(/if: steps\.identity\.outputs\.stage_required == 'true'/gu)).toHaveLength(6)

  expect(stageJob).toContain("name: Stage exact package v${{ needs.verify.outputs.package_version }}")
  expect(stageJob).toContain("needs: verify")
  expect(stageJob).toContain(
    "if: needs.verify.outputs.stage_required == 'true' && inputs.publish_to_npm == true",
  )
  expect(stageJob).toContain("environment:\n      name: npm-stage")
  expect(stageJob).toContain("permissions:\n      actions: read\n      id-token: write")
  expect(workflow.match(/environment:\n {6}name: npm-stage/gu)).toHaveLength(1)
  expect(workflow.match(/id-token: write/gu)).toHaveLength(1)
  expect(stageJob).not.toContain("actions/checkout@")
  expect(stageJob).not.toContain("setup-bun@")
  expect(stageJob).not.toContain("bun install")
  expect(stageJob).not.toContain("bun run")
  expect(stageJob).not.toContain("./scripts/")
  expect(stageJob).toContain("name: Reauthorize exact staging attempt")
  expect(stageJob).toContain('EXPECTED_WORKFLOW_ID: "344208600"')
  expect(stageJob).toContain('attempt.actor?.id !== actorId')
  expect(stageJob).toContain('attempt.triggering_actor?.id !== actorId')
  expect(stageJob).toContain('attempt.status !== "in_progress"')
  expect(stageJob).toContain('"$PUBLISH_TO_NPM" != true')
  expect(stageJob).toContain('node-version: "24"')
  expect(stageJob).toContain("npm install --global --ignore-scripts npm@11.19.0")
  expect(stageJob).toContain("name: Bind artifact reference")
  expect(stageJob).toContain("name: Reject unresolved stable-stage intent")
  expect(stageJob).toContain("completed npm-stage workflow runs")
  expect(stageJob).toContain("already reserved stable stage")
  expect(stageJob).toContain("has a terminal write without one durable intent")
  expect(stageJob).toContain(
    "terminal write is not immediately preceded by its durable intent",
  )
  expect(stageJob).toContain("jobs?filter=all&per_page=100")
  expect(stageJob).toContain("RESOLVED_STAGE_VERSION: ${{ inputs.resolved_stage_version }}")
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
  expect(stageJob).toContain('JSON.stringify(["access", "registry"])')
  expect(stageJob).toContain("Packed package manifest can override the canonical npm staging boundary")
  expect(stageJob).toContain("header.subarray(257, 265).equals(ustarSignature)")
  expect(stageJob).toContain("header[475] === 0 ? 130 : 155")
  expect(stageJob).toContain("Packed npm tar duplicates normalized path")
  expect(stageJob).toContain('git init --quiet --bare "$current_main"')
  expect(stageJob).toContain('"https://github.com/$GITHUB_REPOSITORY.git"')
  expect(stageJob).toContain("Default branch advanced to $current_default_sha after verification")
  expect(stageJob).toContain("EXPECTED_VERSION: ${{ needs.verify.outputs.package_version }}")
  expect(stageJob).toContain('tag_ref="refs/tags/v$EXPECTED_VERSION"')
  expect(stageJob).toContain("git ls-remote --exit-code --refs")
  expect(stageJob).toContain('case "$tag_lookup_status" in')
  expect(stageJob).toContain('if [[ -n "$tag_lookup_output" ]]')
  expect(stageJob).toContain("Remote tag lookup returned an ambiguous absence result")
  expect(stageJob).toContain("npm delivery must precede the Git tag")
  expect(stageJob).toContain("Could not prove that tag v$EXPECTED_VERSION is absent")
  expect(stageJob).toContain("name: Record exclusive stable-stage intent")
  expect(stageJob).toContain("name: Record cleared stable-stage intent v${{ inputs.resolved_stage_version }}")
  expect(stageJob).not.toContain("npm stage list @hraness/atet --json")
  expect(stageJob).toContain("Pinned npm's clean default publication tag is not latest")
  expect(stageJob).toContain('name.toLowerCase() === "npm_config_tag"')

  const artifactReferenceIndex = stageJob.indexOf("Bind artifact reference")
  const downloadIndex = stageJob.indexOf("Download reviewed package")
  const rebindIndex = stageJob.indexOf("Rebind downloaded package")
  const fetchIndex = stageJob.lastIndexOf('git --git-dir="$current_main" fetch')
  const tagIndex = stageJob.lastIndexOf("git ls-remote --exit-code --refs")
  const intentIndex = stageJob.lastIndexOf("Record exclusive stable-stage intent")
  const rehashIndex = stageJob.lastIndexOf('current_archive_sha256="$(sha256sum "$TARBALL"')
  const stageIndex = stageJob.indexOf('npm stage publish "$TARBALL"')
  expect(artifactReferenceIndex).toBeLessThan(downloadIndex)
  expect(downloadIndex).toBeLessThan(rebindIndex)
  expect(rebindIndex).toBeLessThan(fetchIndex)
  expect(fetchIndex).toBeLessThan(rehashIndex)
  expect(rehashIndex).toBeLessThan(tagIndex)
  expect(intentIndex).toBeLessThan(stageIndex)
  expect(tagIndex).toBeLessThan(stageIndex)
  expect(stageIndex).toBeGreaterThan(-1)
  expect(stageJob.slice(stageIndex)).toContain("--access public")
  expect(stageJob.slice(stageIndex)).toContain("--ignore-scripts")
  expect(stageJob.slice(stageIndex)).toContain("--provenance")
  expect(stageJob.slice(stageIndex)).not.toContain("--tag latest")
  expect(stageJob.slice(stageIndex)).toContain('--globalconfig="$clean_global_config"')
  expect(stageJob.slice(stageIndex)).toContain('--userconfig="$clean_user_config"')
  expect(stageJob.slice(stageIndex)).toContain("--@hraness:registry=https://registry.npmjs.org")
  expect(stageJob.slice(stageIndex)).toContain("--registry=https://registry.npmjs.org")
  expect(stageJob).toContain("Staged candidate must be newer than current npm latest")
  expect(stageJob).toContain("9007199254740991n")
  expect(stageJob.match(/--provenance/gu)).toHaveLength(1)
  expect(workflow.match(/--registry=https:\/\/registry\.npmjs\.org/gu)?.length).toBeGreaterThanOrEqual(5)
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toMatch(/npm publish(?:\s|$)/u)
  expect(workflow).not.toContain("tags:")
})

test("the earliest OIDC job step rejects collaborator dispatches and reruns", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")
  const stageJob = workflow.slice(workflow.indexOf("\n  stage:\n"))
  const authorizationIndex = stageJob.indexOf("Reauthorize exact staging attempt")
  const setupIndex = stageJob.indexOf("actions/setup-node@")
  expect(authorizationIndex).toBeGreaterThan(-1)
  expect(authorizationIndex).toBeLessThan(setupIndex)

  const script = workflowStepScript(workflow, "Reauthorize exact staging attempt")
  const directory = await mkdtemp(join(tmpdir(), "atet-stage-attempt-"))
  const binaryDirectory = join(directory, "bin")
  const attemptPath = join(directory, "attempt.json")
  const workflowPath = join(directory, "workflow.json")
  const repositoryPath = join(directory, "repository.json")
  const sourceSha = "b".repeat(40)
  const attempt = {
    id: 45678,
    run_attempt: 2,
    workflow_id: 344208600,
    name: "Stage npm package",
    path: ".github/workflows/npm-stage.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sourceSha,
    status: "in_progress",
    conclusion: null,
    actor: { id: 894119, type: "User" },
    triggering_actor: { id: 894119, type: "User" },
    repository: { id: 1310516748, full_name: "hraness/atet", private: false },
  }
  try {
    await mkdir(binaryDirectory, { recursive: true })
    await writeFile(join(binaryDirectory, "gh"), [
      "#!/bin/bash",
      "set -euo pipefail",
      'endpoint=""',
      'for argument in "$@"; do endpoint="$argument"; done',
      'case "$endpoint" in',
      '  */actions/runs/*) cat "$MOCK_ATTEMPT_JSON" ;;',
      '  */actions/workflows/*) cat "$MOCK_WORKFLOW_JSON" ;;',
      '  /repos/hraness/atet) cat "$MOCK_REPOSITORY_JSON" ;;',
      '  *) exit 2 ;;',
      "esac",
    ].join("\n"))
    await chmod(join(binaryDirectory, "gh"), 0o755)
    await Promise.all([
      writeFile(attemptPath, JSON.stringify(attempt)),
      writeFile(workflowPath, JSON.stringify({
        id: 344208600,
        name: "Stage npm package",
        path: ".github/workflows/npm-stage.yml",
        state: "active",
      })),
      writeFile(repositoryPath, JSON.stringify({
        id: 1310516748,
        full_name: "hraness/atet",
        visibility: "public",
        private: false,
        default_branch: "main",
      })),
    ])
    const environment = {
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      MOCK_ATTEMPT_JSON: attemptPath,
      MOCK_WORKFLOW_JSON: workflowPath,
      MOCK_REPOSITORY_JSON: repositoryPath,
      RUNNER_TEMP: directory,
      PUBLISH_TO_NPM: "true",
      REF_PROTECTED: "true",
      EXPECTED_ACTOR_ID: "894119",
      EXPECTED_REPOSITORY: "hraness/atet",
      EXPECTED_REPOSITORY_ID: "1310516748",
      EXPECTED_SOURCE_SHA: sourceSha,
      EXPECTED_WORKFLOW_ID: "344208600",
      EXPECTED_WORKFLOW_NAME: "Stage npm package",
      EXPECTED_WORKFLOW_PATH: ".github/workflows/npm-stage.yml",
      GITHUB_ACTOR_ID: "894119",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "hraness/atet",
      GITHUB_REPOSITORY_ID: "1310516748",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "45678",
      GITHUB_SHA: sourceSha,
    }
    expect((await runWorkflowScript(script, environment)).exitCode).toBe(0)

    await writeFile(attemptPath, JSON.stringify({
      ...attempt,
      triggering_actor: { id: 123456, type: "User" },
    }))
    const hostileRerun = await runWorkflowScript(script, environment)
    expect(hostileRerun.exitCode).not.toBe(0)
    expect(hostileRerun.stderr).toContain("Current npm staging attempt is not owner-authorized")

    await writeFile(attemptPath, JSON.stringify({
      ...attempt,
      actor: { id: 123456, type: "User" },
      triggering_actor: { id: 123456, type: "User" },
    }))
    const hostileDispatch = await runWorkflowScript(script, {
      ...environment,
      GITHUB_ACTOR_ID: "123456",
    })
    expect(hostileDispatch.exitCode).not.toBe(0)
    expect(`${hostileDispatch.stdout}${hostileDispatch.stderr}`).toContain(
      "npm staging requires the owner-authorized exact protected-main dispatch",
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test("automatic npm staging distinguishes version changes from package metadata edits", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")
  const script = workflowStepScript(
    workflow,
    "Verify default-branch package identity",
  )
  const directory = await mkdtemp(join(tmpdir(), "atet-stage-identity-"))
  const binaryDirectory = join(directory, "bin")
  const gitLog = join(directory, "git.log")
  const npmLog = join(directory, "npm.log")
  const output = join(directory, "github-output.txt")
  const sourceSha = "b".repeat(40)
  const previousSha = "a".repeat(40)

  try {
    await mkdir(binaryDirectory, { recursive: true })
    await Promise.all([
      writeFile(join(binaryDirectory, "git"), `#!/bin/bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$GIT_COMMAND_LOG"
case "\${1-}" in
  fetch|cat-file|merge-base) exit 0 ;;
  show)
    printf '{"name":"@hraness/atet","version":"%s"}\\n' "$MOCK_PREVIOUS_VERSION"
    exit 0
    ;;
  rev-parse)
    case "$*" in
      "rev-parse origin/main"|"rev-parse HEAD") printf '%s\\n' "$GITHUB_SHA"; exit 0 ;;
      "rev-parse --verify --quiet refs/tags/v3.2.0") exit 1 ;;
    esac
    ;;
esac
echo "unexpected git command: $*" >&2
exit 64
`, "utf8"),
      writeFile(join(binaryDirectory, "npm"), `#!/bin/bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$NPM_COMMAND_LOG"
case "$*" in
  "view @hraness/atet name --json --@hraness:registry=https://registry.npmjs.org --registry=https://registry.npmjs.org")
    printf '"@hraness/atet"\\n'
    exit 0
    ;;
  "view @hraness/atet@3.2.0 version --json --@hraness:registry=https://registry.npmjs.org --registry=https://registry.npmjs.org")
    echo 'npm error code E404' >&2
    exit 1
    ;;
esac
echo "unexpected npm command: $*" >&2
exit 64
`, "utf8"),
    ])
    await Promise.all([
      chmod(join(binaryDirectory, "git"), 0o755),
      chmod(join(binaryDirectory, "npm"), 0o755),
    ])

    const runIdentity = async (
      eventName: "push" | "workflow_dispatch",
      previousVersion: string,
    ) => {
      await Promise.all([
        rm(gitLog, { force: true }),
        rm(npmLog, { force: true }),
        rm(output, { force: true }),
      ])
      const result = await runWorkflowScript(script, {
        DEFAULT_BRANCH: "main",
        GIT_COMMAND_LOG: gitLog,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_OUTPUT: output,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: sourceSha,
        MOCK_PREVIOUS_VERSION: previousVersion,
        NPM_COMMAND_LOG: npmLog,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        PUSH_BEFORE: eventName === "push" ? previousSha : "",
        RUNNER_TEMP: directory,
      })
      return Object.freeze({
        ...result,
        npmCommands: await Bun.file(npmLog).exists()
          ? await readFile(npmLog, "utf8")
          : "",
        outputs: await Bun.file(output).exists()
          ? await readFile(output, "utf8")
          : "",
      })
    }

    const unchanged = await runIdentity("push", "3.2.0")
    expect(unchanged.exitCode).toBe(0)
    expect(unchanged.outputs).toBe("stage_required=false\n")
    expect(unchanged.npmCommands).toBe("")
    expect(`${unchanged.stdout}${unchanged.stderr}`).toContain(
      "package.json changed without changing version 3.2.0",
    )

    const increased = await runIdentity("push", "3.1.0")
    expect(increased.exitCode).toBe(0)
    expect(increased.outputs).toBe(
      `stage_required=true\nsource_sha=${sourceSha}\n`,
    )
    expect(increased.npmCommands).toContain("npm view @hraness/atet name --json")
    expect(increased.npmCommands).toContain(
      "npm view @hraness/atet@3.2.0 version --json",
    )

    const decreased = await runIdentity("push", "3.3.0")
    expect(decreased.exitCode).not.toBe(0)
    expect(`${decreased.stdout}${decreased.stderr}`).toContain(
      "Package version 3.2.0 must be newer than 3.3.0",
    )
    expect(decreased.npmCommands).toBe("")

    const recovered = await runIdentity("workflow_dispatch", "3.2.0")
    expect(recovered.exitCode).toBe(0)
    expect(recovered.outputs).toBe(
      `stage_required=true\nsource_sha=${sourceSha}\n`,
    )
    expect(recovered.npmCommands).toContain("npm view @hraness/atet name --json")
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test("both tar consumers reject hostile USTAR headers and packed dist-tag overrides", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")
  const script = workflowStepScript(workflow, "Rebind downloaded package")
  const identitySource = await readFile(
    join(import.meta.dir, "npm-package-identity.ts"),
    "utf8",
  )
  expect(identitySource).toContain("header.subarray(257, 265).equals(ustarSignature)")
  expect(identitySource).toContain("header[475] === 0 ? 130 : 155")
  const root = await mkdtemp(join(tmpdir(), "atet-stage-archive-"))
  const output = join(root, "github-output.txt")
  const environment = {
    EXPECTED_SOURCE_SHA: "a".repeat(40),
    EXPECTED_TARBALL_NAME: "hraness-atet-3.2.0.tgz",
    EXPECTED_VERSION: "3.2.0",
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: root,
  }
  const runFixture = async (
    mutation?: StageTarMutation,
  ): Promise<Readonly<{
    identity: Parameters<typeof verifyNpmPackageIdentity>[0]
    stage: Awaited<ReturnType<typeof runWorkflowScript>>
  }>> => {
    await Promise.all([
      rm(join(root, "atet-npm-stage"), { force: true, recursive: true }),
      rm(output, { force: true }),
    ])
    const artifact = await writeStageArtifactFixture(root, mutation)
    return {
      identity: {
        expectedFilename: "hraness-atet-3.2.0.tgz",
        expectedName: "@hraness/atet",
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
      "Packed package manifest can override the canonical npm staging boundary",
    )

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

test("the retained stage-intent lock survives a failed job and same-run rerun", async () => {
  const workflow = await readWorkflow("public-npm-stage.yml", "npm-stage.yml")
  const script = workflowStepScript(workflow, "Reject unresolved stable-stage intent")
  const root = await mkdtemp(join(tmpdir(), "atet-stage-history-"))
  const binaryDirectory = join(root, "bin")
  const currentJobsPath = join(root, "current-jobs.json")
  const runsPath = join(root, "runs.json")
  const jobsPath = join(root, "jobs.json")
  try {
    await mkdir(binaryDirectory)
    await Promise.all([
      writeFile(join(binaryDirectory, "npm"), `#!/bin/bash
set -euo pipefail
if [[ "\${1-}" == view ]]; then printf '"3.1.1"\\n'; else exit 64; fi
`),
      writeFile(join(binaryDirectory, "gh"), `#!/bin/bash
set -euo pipefail
case "$*" in
  *'/runs?'*) cat "$RUNS_JSON" ;;
  *'/actions/runs/999/jobs?'*) cat "$CURRENT_JOBS_JSON" ;;
  *'/jobs?'*) cat "$JOBS_JSON" ;;
  *) exit 64 ;;
esac
`),
      writeFile(runsPath, JSON.stringify({ total_count: 0, workflow_runs: [] })),
      writeFile(currentJobsPath, JSON.stringify({ total_count: 0, jobs: [] })),
      writeFile(jobsPath, JSON.stringify({ total_count: 0, jobs: [] })),
    ])
    await Promise.all([
      chmod(join(binaryDirectory, "npm"), 0o755),
      chmod(join(binaryDirectory, "gh"), 0o755),
    ])
    const environment = {
      EXPECTED_VERSION: "3.3.0",
      EXPECTED_WORKFLOW_ID: "344208600",
      CURRENT_JOBS_JSON: currentJobsPath,
      GITHUB_REPOSITORY: "hraness/atet",
      GITHUB_RUN_ID: "999",
      JOBS_JSON: jobsPath,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      RESOLVED_STAGE_VERSION: "",
      RUNNER_TEMP: root,
      RUNS_JSON: runsPath,
    }
    expect((await runWorkflowScript(script, environment)).exitCode).toBe(0)

    await Promise.all([
      writeFile(runsPath, JSON.stringify({
        total_count: 1,
        workflow_runs: [{
          id: 123,
          workflow_id: 344208600,
          event: "workflow_dispatch",
          head_branch: "main",
          status: "completed",
        }],
      })),
      writeFile(jobsPath, JSON.stringify({
        total_count: 1,
        jobs: [{
          name: "Stage exact package v3.2.0",
          conclusion: "failure",
          steps: [{
            name: "Record exclusive stable-stage intent",
            conclusion: "success",
            number: 7,
          }, {
            name: "Revalidate current main and stage exact package",
            conclusion: "failure",
            number: 8,
          }],
        }],
      })),
    ])
    const blocked = await runWorkflowScript(script, environment)
    expect(blocked.exitCode).not.toBe(0)
    expect(blocked.stderr).toContain("run 123 already reserved stable stage 3.2.0")
    expect((await runWorkflowScript(script, {
      ...environment,
      RESOLVED_STAGE_VERSION: "3.2.0",
    })).exitCode).toBe(0)

    await Promise.all([
      writeFile(runsPath, JSON.stringify({ total_count: 0, workflow_runs: [] })),
      writeFile(currentJobsPath, await readFile(jobsPath, "utf8")),
    ])
    const blockedRerun = await runWorkflowScript(script, environment)
    expect(blockedRerun.exitCode).not.toBe(0)
    expect(blockedRerun.stderr).toContain("run 999 already reserved stable stage 3.2.0")
    expect((await runWorkflowScript(script, {
      ...environment,
      RESOLVED_STAGE_VERSION: "3.2.0",
    })).exitCode).toBe(0)

    await Promise.all([
      writeFile(runsPath, JSON.stringify({
        total_count: 1,
        workflow_runs: [{
          id: 123,
          workflow_id: 344208600,
          event: "workflow_dispatch",
          head_branch: "main",
          status: "completed",
        }],
      })),
      writeFile(currentJobsPath, JSON.stringify({ total_count: 0, jobs: [] })),
      writeFile(jobsPath, JSON.stringify({
        total_count: 1,
        jobs: [{
          name: "Renamed terminal npm writer",
          conclusion: "failure",
          steps: [{
            name: "Record exclusive stable-stage intent",
            conclusion: "success",
            number: 7,
          }, {
            name: "Revalidate current main and stage exact package",
            conclusion: "failure",
            number: 8,
          }],
        }],
      })),
    ])
    const renamedTerminalJob = await runWorkflowScript(script, environment)
    expect(renamedTerminalJob.exitCode).not.toBe(0)
    expect(renamedTerminalJob.stderr).toContain("lacks a version-bound stage job")

    await writeFile(jobsPath, JSON.stringify({
      total_count: 1,
      jobs: [{
        name: "Stage exact package v3.2.0",
        conclusion: "failure",
        steps: [{
          name: "Revalidate current main and stage exact package",
          conclusion: "failure",
          number: 7,
        }, {
          name: "Record exclusive stable-stage intent",
          conclusion: "success",
          number: 8,
        }],
      }],
    }))
    const reversedIntent = await runWorkflowScript(script, environment)
    expect(reversedIntent.exitCode).not.toBe(0)
    expect(reversedIntent.stderr).toContain(
      "terminal write is not immediately preceded by its durable intent",
    )

    for (const [label, intentNumber, terminalNumber] of [
      ["missing intent step number", undefined, 8],
      ["missing terminal step number", 7, undefined],
      ["non-integer intent step number", 7.5, 8],
      ["non-integer terminal step number", 7, 8.5],
      ["zero intent step number", 0, 1],
      ["zero terminal step number", 1, 0],
    ] as const) {
      await writeFile(jobsPath, JSON.stringify({
        total_count: 1,
        jobs: [{
          name: "Stage exact package v3.2.0",
          conclusion: "failure",
          steps: [{
            name: "Record exclusive stable-stage intent",
            conclusion: "success",
            number: intentNumber,
          }, {
            name: "Revalidate current main and stage exact package",
            conclusion: "failure",
            number: terminalNumber,
          }],
        }],
      }))
      const unsafeStepNumber = await runWorkflowScript(script, environment)
      expect(unsafeStepNumber.exitCode, label).not.toBe(0)
      expect(unsafeStepNumber.stderr, label).toContain(
        "terminal write is not immediately preceded by its durable intent",
      )
    }
  } finally {
    await rm(root, { force: true, recursive: true })
  }
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
  const tarball = join(directory, "hraness-atet-3.2.0.tgz")
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
    present) printf '%s\\trefs/tags/v3.2.0\\n' "$GITHUB_SHA"; exit 0 ;;
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
if [[ "\${1-}" == "config" && "\${2-}" == "get" && "\${3-}" == "tag" ]]; then
  printf 'latest\\n'
elif [[ "\${1-}" == "view" ]]; then
  printf '"3.1.1"\\n'
elif [[ "\${1-}" == "stage" && "\${2-}" == "publish" ]]; then
  printf 'staged\\n' > "$PUBLISH_MARKER"
  printf '{"@hraness/atet":{"name":"@hraness/atet","version":"3.2.0","stageId":"11111111-1111-4111-8111-111111111111"}}\\n'
else
  exit 64
fi
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
      EXPECTED_VERSION: "3.2.0",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "hraness/atet",
      GITHUB_SHA: sourceSha,
      GITHUB_OUTPUT: join(directory, "github-output.txt"),
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
    expect(hashIndex).toBeGreaterThan(fetchIndex)
    expect(tagIndex).toBeGreaterThan(hashIndex)
    expect(publishIndex).toBeGreaterThan(tagIndex)
    expect(commands).not.toContain("--tag latest")

    for (const [status, message] of [
      ["present", "npm delivery must precede the Git tag"],
      ["ambiguous", "ambiguous absence result"],
      ["failure", "Could not prove that tag v3.2.0 is absent"],
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
  expect(publishing).toContain("npm stage publish <reviewed-tarball>")
  expect(publishing).toContain("--ignore-scripts")
  expect(publishing).toContain("--provenance")
  expect(publishing).not.toContain("--tag latest")
  expect(normalizedPublishing).toContain(
    "proves that npm 11.19.0's untouched default tag is `latest`, and deliberately omits `--tag`",
  )
  expect(publishing).toContain("allowed action: `npm stage publish` only")
  expect(publishing).toContain("environment: `npm-stage`")
  expect(normalizedPublishing).toContain(
    "Its sole protection rule must be `branch_policy`, and its sole deployment policy must be the selected branch `main` with type `branch`",
  )
  expect(normalizedPublishing).toContain("Disable administrator bypass")
  expect(normalizedPublishing).toContain("Configure no required deployment reviewers")
  expect(publishing).not.toContain("repository maintainer `0thernet`")
  expect(publishing).not.toContain("prevent_self_review")
  expect(normalizedPublishing).toContain("must match `npm-stage` exactly")
  expect(publishing).toContain("Require two-factor authentication and")
  expect(publishing).toContain("disallow tokens")
  expect(publishing).toContain("This section records the one-time `3.1.1` bootstrap")
  expect(publishing).toContain("Do not reuse the")
  expect(normalizedPublishing).toContain("interactive path for a later release")
  expect(publishing).toContain("starts **Stage npm package** automatically")
  expect(publishing).toContain("leaves the stable version unchanged exits")
  expect(publishing).toContain(
    "gh workflow run npm-stage.yml --ref main -f publish_to_npm=true",
  )
  expect(normalizedPublishing).toContain(
    "Only the minimal staging job may reference this environment",
  )
  expect(normalizedPublishing).toContain(
    "Pushes and default manual dispatches stop after the read-only verification job uploads the exact candidate artifact",
  )
  expect(publishing).toContain("publish_to_npm=true")
  expect(publishing).toContain("resolved_stage_version")
  expect(normalizedPublishing).toContain("version-bound successful intent immediately before mutation")
  expect(normalizedPublishing).toContain(
    "recognizes every attempted terminal npm mutation before it considers the stage-job display name",
  )
  expect(normalizedPublishing).toContain(
    "exactly one successful durable intent at the immediately preceding safe positive Actions step number",
  )
  expect(normalizedPublishing).toContain(
    "exact eight-byte USTAR signature (`ustar\\0` plus `00`) and npm/node-tar's byte-475 prefix discriminator",
  )
  expect(normalizedPublishing).toContain(
    "The attempt or job may have failed, been cancelled, or timed out after npm accepted the stage",
  )
  expect(normalizedPublishing).toContain(
    "cryptographically verified public artifact is the durable acceptance proof",
  )
  expect(normalizedPublishing).toContain("trusted short-lived tokens cannot run other `npm stage` subcommands")
  expect(normalizedPublishing).toContain("checks out no source and runs no repository code")
  expect(normalizedPublishing).toContain(
    "This mandatory npm approval is the only human approval in the stable train",
  )
  expect(normalizedPublishing).toContain(
    "**Immutable version tags** restricts update and deletion with an empty bypass list",
  )
  expect(normalizedPublishing).toContain(
    "**Release tag creation** restricts creation only and gives immutable owner `User` ID `894119` the sole always-bypass entry",
  )
  expect(publishing).toContain("npm-package.sha256")
  expect(normalizedPublishing).toContain(
    "rehashes the package, proves the matching Git tag is absent, records a successful version-bound Actions intent, and only then runs the stage-only command",
  )
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
