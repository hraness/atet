import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { admitAttempt, admitExpectedHandoff, admitMirrorAuthority, admitRelease, admitRemoteAssetBytes, authorizeRelease, authorityPaths, admitVerifiedProvenance, checksums, compareVersions, findReleaseForTag, hash, parseManifest, releaseBody, verifyHandoff } from "./github-release";
import { admitPublishedGitHubRelease } from "./push-release-tag";

const archive = Buffer.from("exact canonical bytes");
function manifest() {
  return parseManifest({ schema: "hraness-github-release-v1", repository: "hraness/slopcamera", repositoryId: 1310516748,
    package: "@hraness/slopcamera", version: "3.2.3", tag: "v3.2.3", sourceSha: "a".repeat(40),
    workflow: ".github/workflows/release.yml", workflowSha: "a".repeat(40), runId: 123, runAttempt: 1,
    archive: { name: "hraness-slopcamera-3.2.3.tgz", bytes: archive.length, sha256: hash(archive), sha512: hash(archive, "sha512") } });
}
function files() {
  const m = manifest();
  const pack = [{ name: m.package, version: m.version, filename: m.archive.name, size: archive.length,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`, shasum: hash(archive, "sha1") }];
  const result = new Map([[m.archive.name, archive], ["npm-pack.json", Buffer.from(JSON.stringify(pack))], ["release-manifest.json", Buffer.from(JSON.stringify(m))]]);
  result.set("SHA256SUMS", Buffer.from(checksums(result)));
  return result;
}
function attempt() {
  const m = manifest();
  return { id: m.runId, run_attempt: m.runAttempt, head_sha: m.sourceSha, head_branch: m.tag,
    workflow_id: 320001524, name: "Release", path: m.workflow, event: "push", status: "in_progress", conclusion: null,
    actor: { id: 894119, type: "User" }, triggering_actor: { id: 894119, type: "User" },
    repository: { id: 1310516748, full_name: "hraness/slopcamera", private: false } };
}
test("mirror binds an older canonical source to the current protected workflow without conflating them", () => {
  const m = manifest();
  const current = "b".repeat(40);
  const environment = { GITHUB_SHA: current, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "hraness/slopcamera", GITHUB_REPOSITORY_ID: "1310516748" };
  const ref = { object: { type: "commit", sha: current } };
  const branch = { protected: true, commit: { sha: current } };
  const comparison = { status: "ahead" };
  expect(() => admitMirrorAuthority(m, current, environment, ref, branch, comparison)).not.toThrow();
  expect(() => admitMirrorAuthority({ ...m, sourceSha: current }, current, environment, ref, branch, { status: "identical" })).not.toThrow();
  for (const status of ["behind", "diverged", "unknown"]) {
    expect(() => admitMirrorAuthority(m, current, environment, ref, branch, { status })).toThrow("ancestor");
  }
  expect(() => admitMirrorAuthority(m, current, environment, { object: { type: "commit", sha: "c".repeat(40) } }, branch, comparison)).toThrow();
  expect(() => admitMirrorAuthority(m, current, environment, ref, { ...branch, protected: false }, comparison)).toThrow();
  expect(() => admitMirrorAuthority(m, current, { ...environment, GITHUB_SHA: m.sourceSha }, ref, branch, comparison)).toThrow();
  expect(() => admitMirrorAuthority(m, current, { ...environment, GITHUB_EVENT_NAME: "push" }, ref, branch, comparison)).toThrow();
});
test("final npm admission binds immutable canonical source and exact complete asset identities", async () => {
  const stage = await readFile(new URL("../.github/workflows/npm-stage.yml", import.meta.url), "utf8");
  const marker = '          RELEASE_JSON="$release_json" node <<\'NODE\'\n';
  const start = stage.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const script = stage.slice(start + marker.length, stage.indexOf("          NODE\n", start)).split("\n").map(line => line.slice(10)).join("\n");
  const source = "a".repeat(40);
  const values = { EXPECTED_VERSION: "3.2.3", EXPECTED_SOURCE_SHA: "b".repeat(40), EXPECTED_CANONICAL_SOURCE_SHA: source,
    EXPECTED_ARCHIVE_SHA256: "1".repeat(64), EXPECTED_METADATA_SHA256: "2".repeat(64) };
  const release = { id: 1, tag_name: "v3.2.3", target_commitish: source, draft: false, prerelease: false, immutable: true,
    author: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    assets: ["hraness-slopcamera-3.2.3.tgz", "npm-pack.json", "release-manifest.json", "SHA256SUMS", "provenance.jsonl"]
      .map((name, index) => ({ id: index + 1, name, state: "uploaded", digest: `sha256:${String(index + 1).repeat(64)}` })) };
  const run = (value: unknown) => Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...values, RELEASE_JSON: JSON.stringify(value) }, timeout: 1_000, stdout: "pipe", stderr: "pipe",
  });
  expect(run(release).exitCode).toBe(0);
  for (const invalid of [{ ...release, target_commitish: values.EXPECTED_SOURCE_SHA }, { ...release, immutable: false },
    { ...release, author: { ...release.author, type: "User" } }, { ...release, assets: release.assets.slice(0, 4) },
    { ...release, assets: release.assets.map((asset, index) => index === 1 ? { ...asset, id: 1 } : asset) },
    { ...release, assets: release.assets.map((asset, index) => index === 1 ? { ...asset, digest: `sha256:${"0".repeat(64)}` } : asset) }]) {
    const result = run(invalid);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Canonical immutable GitHub mirror authority changed");
  }
});
test("canonical manifest rejects identity, bounds, override and path drift", () => {
  const m = manifest();
  expect(parseManifest(m)).toEqual(m);
  for (const change of [{ unexpected: true }, { repository: "other/slopcamera" }, { repositoryId: 1 }, { package: "slopcamera" }, { version: "3.2.3-beta.1" },
    { tag: "v3.2.4" }, { sourceSha: "main" }, { workflowSha: "main" }, { runId: 0 }, { runAttempt: 1.5 }, { workflow: ".github/workflows/npm-stage.yml" },
    { archive: { ...m.archive, name: "../package.tgz" } }, { archive: { ...m.archive, bytes: 4_300_001 } }, { archive: { ...m.archive, sha256: "0" } }]) {
    expect(() => parseManifest({ ...m, ...change })).toThrow();
  }
  expect(compareVersions("3.2.3", "3.2.2")).toBe(1);
  expect(() => compareVersions("9007199254740992.0.0", "3.2.2")).toThrow();
});
test("artifact admission binds exact files, bytes, metadata, source and trusted outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopcamera-canonical-handoff-"));
  try {
    const inputs = files();
    for (const [name, bytes] of inputs) await writeFile(join(root, name), bytes);
    const result = await verifyHandoff(root, false);
    const expected = { GITHUB_SHA: result.manifest.sourceSha, GITHUB_REF_NAME: result.manifest.tag,
      GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", EXPECTED_ARCHIVE_SHA256: hash(archive),
      EXPECTED_PACK_SHA256: hash(inputs.get("npm-pack.json")!), EXPECTED_MANIFEST_SHA256: hash(inputs.get("release-manifest.json")!),
      EXPECTED_SUMS_SHA256: hash(inputs.get("SHA256SUMS")!) };
    expect(() => admitExpectedHandoff(result, expected)).not.toThrow();
    expect(() => admitExpectedHandoff(result, { ...expected, GITHUB_RUN_ATTEMPT: "2" })).toThrow("exact run");
    expect(() => admitExpectedHandoff(result, { ...expected, EXPECTED_PACK_SHA256: "0".repeat(64) })).toThrow("trusted");
    await writeFile(join(root, "unexpected"), "injected");
    await expect(verifyHandoff(root, false)).rejects.toThrow("unexpected");
    await rm(join(root, "unexpected"));
    await writeFile(join(root, result.manifest.archive.name), "changed");
    await expect(verifyHandoff(root, false)).rejects.toThrow("archive differs");
    await rm(join(root, result.manifest.archive.name));
    await symlink("npm-pack.json", join(root, result.manifest.archive.name));
    await expect(verifyHandoff(root, false)).rejects.toThrow("regular release file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("release authorization rejects collaborator reruns and stale source or attempt", () => {
  const m = manifest();
  expect(() => admitAttempt(attempt(), m)).not.toThrow();
  for (const change of [{ triggering_actor: { id: 99, type: "User" } }, { actor: { id: 894119, type: "Bot" } }, { head_sha: "b".repeat(40) },
    { run_attempt: 2 }, { head_branch: "main" }, { workflow_id: 1 }, { event: "workflow_dispatch" }, { status: "completed", conclusion: "failure" },
    { repository: { id: 1310516748, full_name: "other/slopcamera", private: false } }]) {
    expect(() => admitAttempt({ ...attempt(), ...change }, m)).toThrow("exact authorized");
  }
  expect(() => admitAttempt({ ...attempt(), status: "completed", conclusion: "success" }, m, true)).not.toThrow();
  expect(() => admitAttempt(attempt(), m, true)).toThrow("exact authorized");
  expect(() => admitAttempt({ ...attempt(), status: "completed", conclusion: "failure" }, m, true)).toThrow("exact authorized");
});
function verified() {
  const m = manifest();
  return [{ verificationResult: { signature: { certificate: {
    issuer: "https://token.actions.githubusercontent.com", runnerEnvironment: "github-hosted",
    sourceRepositoryURI: "https://github.com/hraness/slopcamera", sourceRepositoryIdentifier: "1310516748",
    sourceRepositoryDigest: m.sourceSha, sourceRepositoryRef: `refs/tags/${m.tag}`,
    buildSignerDigest: m.sourceSha, buildConfigDigest: m.sourceSha, buildTrigger: "push",
    buildSignerURI: `https://github.com/hraness/slopcamera/${m.workflow}@refs/tags/${m.tag}`,
    buildConfigURI: `https://github.com/hraness/slopcamera/${m.workflow}@refs/tags/${m.tag}`,
    runInvocationURI: `https://github.com/hraness/slopcamera/actions/runs/${m.runId}/attempts/${m.runAttempt}`,
  } }, statement: { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: [...files()].map(([name, bytes]) => ({ name, digest: { sha256: hash(bytes) } })),
    predicate: { buildDefinition: { buildType: "https://actions.github.io/buildtypes/workflow/v1",
      externalParameters: { workflow: { repository: "https://github.com/hraness/slopcamera", path: m.workflow, ref: `refs/tags/${m.tag}` } },
      internalParameters: { github: { event_name: "push", repository_id: "1310516748", repository_owner_id: "307125679", runner_environment: "github-hosted" } },
      resolvedDependencies: [{ uri: `git+https://github.com/hraness/slopcamera@refs/tags/${m.tag}`, digest: { gitCommit: m.sourceSha } }] },
    runDetails: { builder: { id: `https://github.com/hraness/slopcamera/${m.workflow}@refs/tags/${m.tag}` },
      metadata: { invocationId: `https://github.com/hraness/slopcamera/actions/runs/${m.runId}/attempts/${m.runAttempt}` } } } } } }];
}
test("verified provenance binds every subject and exact hosted workflow/source/attempt", () => {
  const m = manifest();
  const subjects = new Map([...files()].map(([name, bytes]) => [name, hash(bytes)]));
  expect(() => admitVerifiedProvenance(verified(), m, subjects)).not.toThrow();
  expect(() => admitVerifiedProvenance(verified(), m, new Map(subjects).set(m.archive.name, "0".repeat(64)))).toThrow();
  expect(() => admitVerifiedProvenance(verified(), { ...m, runAttempt: 2 }, subjects)).toThrow("certificate");
  expect(() => admitVerifiedProvenance(verified(), { ...m, sourceSha: "b".repeat(40) }, subjects)).toThrow();
  const selfHosted = verified();
  selfHosted[0]!.verificationResult.statement.predicate.buildDefinition.internalParameters.github.runner_environment = "self-hosted";
  expect(() => admitVerifiedProvenance(selfHosted, m, subjects)).toThrow();
  const wrongBuilder = verified();
  wrongBuilder[0]!.verificationResult.statement.predicate.runDetails.builder.id = "https://github.com/hraness/slopcamera/.github/workflows/other.yml@main";
  expect(() => admitVerifiedProvenance(wrongBuilder, m, subjects)).toThrow();
  const relabeledAttempt = verified();
  relabeledAttempt[0]!.verificationResult.signature.certificate.runInvocationURI = "https://github.com/hraness/slopcamera/actions/runs/123/attempts/2";
  expect(() => admitVerifiedProvenance(relabeledAttempt, m, subjects)).toThrow("certificate");
  const duplicate = verified();
  duplicate[0]!.verificationResult.statement.subject[1] = duplicate[0]!.verificationResult.statement.subject[0]!;
  expect(() => admitVerifiedProvenance(duplicate, m, subjects)).toThrow("subject");

});
test("draft reconciliation admits only matching state and never substitutes historical provenance", () => {
  const m = manifest();
  const inputs = files(); inputs.set("provenance.jsonl", Buffer.from("signed bundle"));
  const draft = { id: 5, tag_name: m.tag, name: `Slopcamera ${m.tag}`, target_commitish: m.sourceSha, draft: true,
    prerelease: false, immutable: false, body: releaseBody(m), author: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    assets: [...inputs].map(([name, bytes], index) => ({ id: index + 1, name, state: "uploaded", size: bytes.length, digest: `sha256:${hash(bytes)}` })) };
  expect(admitRelease({ ...draft, assets: draft.assets.slice(0, 1) }, m, inputs, true).present.size).toBe(1);
  expect(() => admitRelease({ ...draft, assets: [] }, m, inputs, false)).toThrow("missing");
  expect(() => admitRelease({ ...draft, author: { id: 123, login: "other" } }, m, inputs, true)).toThrow();
  expect(() => admitRelease({ ...draft, body: releaseBody({ ...m, runAttempt: 2 }) }, m, inputs, true)).toThrow();
  expect(() => admitRelease({ ...draft, draft: false }, m, inputs, false)).toThrow();
  expect(admitRelease({ ...draft, draft: false, immutable: true }, m, inputs, false).draft).toBe(false);
  expect(() => admitRelease({ ...draft, assets: [{ ...draft.assets[0]!, digest: `sha256:${"0".repeat(64)}` }] }, m, inputs, true)).toThrow("differs");
  expect(() => admitRelease({ ...draft, assets: [{ ...draft.assets[0]!, id: 0 }] }, m, inputs, true)).toThrow("positive");
  expect(() => admitRelease({ ...draft, assets: [draft.assets[0], { ...draft.assets[1]!, id: draft.assets[0]!.id }] }, m, inputs, true)).toThrow("duplicated");
  const downloaded = new Map(draft.assets.map(asset => [asset.id, inputs.get(asset.name)!]));
  expect(() => admitRemoteAssetBytes(draft, inputs, downloaded)).not.toThrow();
  expect(() => admitRemoteAssetBytes(draft, inputs, new Map(downloaded).set(1, Buffer.from("changed after digest response")))).toThrow("bytes differ");
  expect(() => admitPublishedGitHubRelease({ ...draft, tag_name: "v3.2.4", draft: false, immutable: true }, "3.2.3")).toThrow("newer");
});
test("draft discovery uses the complete authenticated list and exact ID when tag lookup returns 404", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-draft-fixture-token";
  const draft = { id: 501, tag_name: "v3.2.3", draft: true };
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, tag_name: `v1.0.${index}`, draft: false }));
  let secondPage: unknown[] = [draft];
  let readback: unknown = draft;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname
      + new URL(typeof input === "string" || input instanceof URL ? input : input.url).search;
    paths.push(path);
    if (path === "/repos/hraness/slopcamera/releases/tags/v3.2.3") return new Response("Not Found", { status: 404 });
    if (path === "/repos/hraness/slopcamera/releases?per_page=100&page=1") return Response.json(firstPage);
    if (path === "/repos/hraness/slopcamera/releases?per_page=100&page=2") return Response.json(secondPage);
    if (path === "/repos/hraness/slopcamera/releases/501") return Response.json(readback);
    throw new Error(`Unexpected draft fixture request: ${path}`);
  }) as typeof fetch;
  try {
    expect(await findReleaseForTag("v3.2.3")).toEqual(draft);
    expect(paths).toEqual(["/repos/hraness/slopcamera/releases?per_page=100&page=1", "/repos/hraness/slopcamera/releases?per_page=100&page=2", "/repos/hraness/slopcamera/releases/501"]);
    secondPage = [draft, { ...draft, id: 502 }];
    await expect(findReleaseForTag("v3.2.3")).rejects.toThrow("Multiple releases");
    secondPage = [draft];
    readback = { ...draft, id: 502 };
    await expect(findReleaseForTag("v3.2.3")).rejects.toThrow("identity changed");
    readback = { ...draft, tag_name: "v3.2.4" };
    await expect(findReleaseForTag("v3.2.3")).rejects.toThrow("identity changed");
    secondPage = [{ ...draft, id: 0 }];
    await expect(findReleaseForTag("v3.2.3")).rejects.toThrow("positive");
    secondPage = [];
    expect(await findReleaseForTag("v3.2.3")).toBeNull();
    secondPage = [{ id: 1, tag_name: "v1.0.0", draft: false }];
    await expect(findReleaseForTag("v3.2.3")).rejects.toThrow("repeated an ID");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = originalToken;
  }
});
test("live admission rejects drift anywhere in the transitive release helper closure", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-test-token";
  const m = manifest();
  const current = "b".repeat(40);
  let changedPath: string | undefined;
  const reads = new Set<string>();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    expect(url.origin).toBe("https://api.github.com");
    const path = url.pathname;
    let value: unknown;
    if (path === "/repos/hraness/slopcamera") value = { id: 1310516748, full_name: "hraness/slopcamera", private: false, visibility: "public", default_branch: "main" };
    else if (path.endsWith("/actions/workflows/320001524")) value = { id: 320001524, path: m.workflow, name: "Release", state: "active" };
    else if (path.endsWith("/actions/runs/123/attempts/1")) value = attempt();
    else if (path.endsWith("/git/ref/heads/main")) value = { object: { type: "commit", sha: current } };
    else if (path.endsWith("/branches/main")) value = { protected: true, commit: { sha: current } };
    else if (path.includes("/compare/")) value = { status: "ahead" };
    else if (path.endsWith("/git/ref/tags/v3.2.3")) value = { object: { type: "tag", sha: "c".repeat(40) } };
    else if (path.includes("/git/tags/")) value = { object: { type: "commit", sha: m.sourceSha } };
    else if (path.includes("/contents/")) {
      const relative = path.split("/contents/")[1]!;
      reads.add(relative);
      value = { type: "file", encoding: "base64", content: Buffer.from(relative === changedPath && url.searchParams.get("ref") === current ? "changed authority" : "reviewed bytes").toString("base64") };
    } else throw new Error(`Unexpected test route ${path}`);
    return Response.json(value);
  }) as typeof fetch;
  const environment = { GITHUB_SHA: m.sourceSha, GITHUB_REF_NAME: m.tag, GITHUB_REF: `refs/tags/${m.tag}`, GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "push", GITHUB_ACTOR_ID: "894119", GITHUB_REPOSITORY: "hraness/slopcamera",
    GITHUB_REPOSITORY_ID: "1310516748", GITHUB_WORKFLOW_REF: `hraness/slopcamera/${m.workflow}@refs/tags/${m.tag}` };
  try {
    expect(await authorizeRelease(environment)).toBe(current);
    expect([...reads].sort()).toEqual([...authorityPaths].sort());
    for (const path of authorityPaths) {
      changedPath = path;
      await expect(authorizeRelease(environment)).rejects.toThrow("Current release authority changed");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});
test("canonical workflow preserves all source/native gates before scoped signing and immutable publication", async () => {
  const source = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const command of ["bun run check", "bun run test:vectorize:official", "bun run test:desktop:macos", "bun run package:desktop:macos",
    "bun run scripts/package-smoke.ts", "bun run scripts/prepare-github-release.ts"]) expect(source).toContain(command);
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) expect(source).toContain(`target: ${platform}`);
  expect(source).toContain("needs: [verify, official_vtracer, native_macos, attest]");
  expect(source).toContain("fetch-tags: false");
  expect(source).toContain('git fetch --no-tags --unshallow origin "refs/heads/main:refs/remotes/origin/main"');
  const privileged = source.slice(source.indexOf("\n  attest:\n"));
  expect(privileged).not.toContain("actions/checkout@");
  expect(privileged).not.toContain("bun install");
  expect(privileged).not.toContain("npm install");
  expect(privileged).toContain("run.triggering_actor?.id !== 894119");
  expect(privileged).toContain("current.equals(decode(e.GITHUB_SHA))");
  expect(privileged).toContain("artifact-ids: ${{ needs.verify.outputs.artifact_id }}");
  expect(privileged).toContain("artifact-ids: ${{ needs.attest.outputs.artifact_id }}");
  expect(privileged.indexOf("Rebind verified artifact before OIDC")).toBeLessThan(privileged.indexOf("actions/attest@"));
  expect(source).not.toContain("npm latest");
  expect(source).not.toContain("npm stage");
  expect(source).not.toContain("npm-publish-authority");
  const stage = await readFile(new URL("../.github/workflows/npm-stage.yml", import.meta.url), "utf8");
  expect(stage.slice(0, stage.indexOf("permissions:"))).not.toContain("  push:");
  expect(stage).toContain("node scripts/github-release.ts mirror");
  expect(stage).toContain('git worktree add --detach "$source_directory" "$canonical_source_sha"');
  expect(stage).toContain('working-directory: ${{ steps.canonical.outputs.source_directory }}');
  expect(stage).toContain('bun run "$GITHUB_WORKSPACE/scripts/package-smoke.ts"');
  expect(stage).toContain('bun run check');
  expect(stage).toContain("Canonical immutable GitHub mirror authority changed immediately before npm staging");
  expect(stage).toContain("npm publish");
  expect(stage).toContain("cd \"$clean_npm_directory\"");
});
