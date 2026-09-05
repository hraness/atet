# Publish Atet

Atet uses an interactive first npm publication and stage-only trusted
publishing for later versions. npm cannot stage a package name that does not
exist, and npm's dual-use policy requires two-factor authentication at the
interactive publish or staged-promotion boundary.

## Bootstrap the npm package

This section records the one-time `3.1.1` bootstrap. Do not reuse the
interactive path for a later release; follow
[Stage a later version](#stage-a-later-version) instead. The bootstrap started
from the checked `main` commit with Node 24,
npm 11.19.0, and Bun 1.3.14. The signed-in npm maintainer had publish access
to the `hraness` organization and two-factor authentication enabled. The
matching Git tag was created only after the public package was verified.

1. Install without dependency lifecycle scripts and run the complete gate.

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   bun run check
   ```

2. Confirm that the gate did not change committed package outputs.

   ```sh
   git status --porcelain --untracked-files=all -- \
     dist apps/desktop/dist/cli bun.lock
   ```

   Continue only when the command produces no output.

3. Build one npm tarball and preserve its exact metadata.

   ```sh
   atet_npm_artifact="$(mktemp -d)"
   npm pack --ignore-scripts --json \
     --pack-destination "$atet_npm_artifact" \
     --registry=https://registry.npmjs.org \
     > "$atet_npm_artifact/npm-pack.json"
   cat "$atet_npm_artifact/npm-pack.json"
   bun run ./scripts/package-smoke.ts \
     --archive "$atet_npm_artifact/hraness-atet-3.1.1.tgz" \
     --pack-json "$atet_npm_artifact/npm-pack.json"
   shasum -a 512 "$atet_npm_artifact/hraness-atet-3.1.1.tgz"
   ```

   Review the filename, package identity, version, inventory, file count,
   packed size, unpacked size, SHA-1, and SHA-512 integrity in the JSON. The
   package smoke independently hashes the exact archive and checks those
   values, the reviewed bounds, the dual-use declaration and disclosure, clean
   Bun and npm consumers, package exports, the CLI, and the Agent Skill.

4. Historical bootstrap record: the signed-in maintainer published that exact
   reviewed tarball and completed npm's two-factor authentication prompt. The
   direct command is intentionally omitted because the package now exists and
   later versions must use the stage-only workflow below. Never put an npm
   password, one-time password, recovery code, session cookie, or token in Git,
   a workflow, a task file, or chat.

5. Download the public registry artifact and compare its canonical package
   identity with the reviewed source tarball.

   ```sh
   atet_npm_registry="$(mktemp -d)"
   npm pack @hraness/atet@3.1.1 \
     --ignore-scripts --json \
     --pack-destination "$atet_npm_registry" \
     --registry=https://registry.npmjs.org \
     > "$atet_npm_registry/npm-pack.json"
   npm view @hraness/atet@3.1.1 name version dist --json \
     --registry=https://registry.npmjs.org \
     > "$atet_npm_registry/npm-view.json"
   bun run ./scripts/npm-package-identity.ts \
     "$atet_npm_artifact/npm-pack.json" \
     "$atet_npm_artifact/hraness-atet-3.1.1.tgz" \
     "$atet_npm_registry/npm-pack.json" \
     "$atet_npm_registry/hraness-atet-3.1.1.tgz" \
     "$atet_npm_registry/npm-view.json" \
     @hraness/atet 3.1.1 hraness-atet-3.1.1.tgz
   bun run ./scripts/package-smoke.ts \
     --archive "$atet_npm_registry/hraness-atet-3.1.1.tgz" \
     --pack-json "$atet_npm_registry/npm-pack.json"
   npm view @hraness/atet dist-tags.latest \
     --json --registry=https://registry.npmjs.org
   ```

   npm can encode equivalent package contents into different gzip or tar bytes
   on different operating systems. Continue only when the comparator proves
   the complete safe path, entry type, mode, size, and file-hash identity;
   each archive matches its own npm metadata; the downloaded archive matches
   the canonical registry `dist` metadata; the package smoke passes; and
   `latest` names `3.1.1`.

6. Create and push `v3.1.1` on that same `main` commit. The tag workflow
   repeats the canonical content-identity, registry integrity, and package
   checks before it creates the immutable GitHub Release.

## Configure trusted publishing

After `@hraness/atet` exists, configure one GitHub Actions trusted publisher in
the npm package settings with this exact identity:

- organization or owner: `hraness`
- repository: `atet`
- workflow filename: `npm-stage.yml`
- allowed action: `npm stage publish` only
- environment: `npm-stage`

Create a GitHub environment named `npm-stage`. Disable administrator bypass.
Its sole protection rule must be `branch_policy`, and its sole deployment
policy must be the selected branch `main` with type `branch`. Configure no
required deployment reviewers and add no environment secret. Pushes and default
manual dispatches stop after the read-only verification job uploads the exact
candidate artifact. The dependent staging job starts only when a current-main
owner manual dispatch explicitly sets `publish_to_npm=true`. The staging job
re-reads that exact run attempt and requires both the original actor and the
attempt's triggering actor to be immutable owner `User` ID `894119` before it
sets up npm or requests an OIDC token. This GitHub environment binds
the trusted-publisher identity and branch without adding a separate human gate;
staging does not make the package public. Only the minimal staging job may
reference this environment or request an OIDC token. The npm trusted-publisher
environment must match `npm-stage` exactly.

Set package publishing access to **Require two-factor authentication and
disallow tokens**. Remove traditional publishing tokens. Do not add an npm
publishing token to GitHub. Preserve `contentPolicy.class=dual-use` and the
root `DISCLOSURE` in every version.

The trusted workflow's only registry mutation is equivalent to:

```sh
npm stage publish <reviewed-tarball> \
  --@hraness:registry=https://registry.npmjs.org \
  --access public \
  --ignore-scripts \
  --provenance \
  --tag latest \
  --registry=https://registry.npmjs.org
```

The packed `publishConfig` must contain exactly `access` and `registry`, with
values `public` and `https://registry.npmjs.org`. A scoped registry, proxy,
authentication, tag, provenance-file, or any other packed npm configuration is
forbidden because npm otherwise lets package metadata override its network and
publication options.

## Stage a later version

1. Merge one new stable version to `main`. A push that changes `package.json`
   starts **Stage npm package** automatically in build-only mode. Its read-only
   verification job repeats the complete gate and uploads the exact candidate
   artifact without requesting OIDC authority. A
   `package.json` edit that leaves the stable version unchanged exits
   successfully without building, uploading, or staging a package.
2. Finish the previous staged version, public promotion, stable tag, and
   immutable GitHub Release before preparing or dispatching another stable
   version. GitHub concurrency serializes workflow executions, not npm stages
   awaiting human approval; there must be at most one pending stable stage.
3. Review the uniquely named artifact from the read-only verification job. It
   contains exactly the tarball, `npm-pack.json`, and `npm-package.sha256`.
   Confirm the source commit, version, inventory, sizes, SHA-1, SHA-512
   integrity, independent SHA-256 digests, dual-use declaration, and
   disclosure.
4. When the stable train is intentionally ready for npm staging, the owner
   dispatches the
   exact workflow from current `main` with the explicit opt-in:

   ```sh
   gh workflow run npm-stage.yml --ref main -f publish_to_npm=true
   ```

   The run repeats candidate verification before the dependent OIDC job starts.
   Before using OIDC, that job proves the candidate is newer than the live
   public `latest` version using npm 11's safe SemVer component bounds,
   requires the canonical registry's pending-stage list to be empty, and
   reauthorizes the exact protected-main workflow run, attempt, owner actor,
   owner triggering actor, workflow ID, repository ID, and source commit.
   That job checks out no source and runs no repository code. It downloads and
   revalidates the three verified files, fetches current `main` into a new bare
   Git directory, rehashes the package, proves the matching Git tag is absent,
   and only then runs the stage-only command. A missing or false input, a push,
   another branch, a stale commit, an existing version, or a branch advance
   cannot reach npm.
5. Inspect the staged package with
   `npm stage view <stage-id> --registry=https://registry.npmjs.org` and
   download it with
   `npm stage download <stage-id> --registry=https://registry.npmjs.org` when
   an independent local inspection is required.
6. Batch the unavoidable human gate into an intentional stable release, then
   approve the exact stage with
   `npm stage approve <stage-id> --registry=https://registry.npmjs.org` or
   npmjs.com and complete two-factor authentication. This mandatory npm
   approval is the only human approval in the stable train and is the action that
   makes the staged package public.
7. Download and verify the public registry artifact in a clean consumer. The
   Release workflow installs npm 11.19.0 without lifecycle scripts in an
   isolated directory, runs `npm audit signatures --json
   --include-attestations --omit=dev`, and requires a valid registry signature
   plus the cryptographically verified npm-publish and SLSA attestations. Their exact
   package PURL and SHA-512 identify the downloaded tarball; the SLSA statement
   must name `npm-stage.yml`, `refs/heads/main`, `workflow_dispatch`, repository
   ID `1310516748`, owner ID `307125679`, the source commit, GitHub-hosted
   builder, and one signed run-attempt URL. The final write job re-reads that
   completed successful attempt and requires owner `actor` and
   `triggering_actor`, then re-reads canonical npm version metadata and
   `dist-tags.latest`. The live integrity, signature set, attestation URL, and
   SLSA summary must still match the cryptographically verified exact version.
8. From a clean, current `main` checkout, create and push the matching annotated
   `v<version>` tag with the guarded preflight-only tag command:

   ```sh
   bun run ./scripts/push-npm-release-tag.ts <exact-stable-version>
   ```

   This command has no npm publication authority. Before its sole exact tag
   push, it checks owner authentication, public repository identity, both live
   tag rulesets, the live main-only `npm-stage` environment, protected current
   `main`, the successful exact CI attempt and Required job, public npm
   `latest`, remote tag monotonicity, and local tag absence. It creates one
   canonical annotated tag and compare-deletes only the local tag it created if
   remote verification fails. The protected tag workflow repeats owner and
   event-sender ID `894119`, repository ID `1310516748`, npm authority, source,
   VTracer, and immutable Latest Release checks.

Never stage the next stable version while another stage awaits approval. Human
approval order controls `latest`; workflow concurrency alone cannot serialize
that external pending state.

## Protect release tags without a sudo prompt

Keep two active repository rulesets matching `refs/tags/v*`. **Immutable
version tags** restricts update and deletion with an empty bypass list.
**Release tag creation** restricts creation only and gives immutable owner
`User` ID `894119` the sole always-bypass entry. Do not grant the generic
GitHub Actions integration, an administrator, a repository role, a team, or
another integration this bypass, and never combine creation with update or
deletion. This one-time provider setup lets the already-authenticated owner
create the exact release tag under standing task authority without a routine
GitHub sudo approval. Never create probe tags, move a version tag, or tag before
the matching staged package has been promoted and independently verified.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/), [staged
publishing](https://docs.npmjs.com/staged-publishing/), and [dual-use
content](https://docs.npmjs.com/policies/dual-use/).
