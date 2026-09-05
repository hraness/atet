# Publish Atet

Atet used an interactive first npm publication and now uses direct OIDC trusted
publishing for every later version. The bootstrap remains here only as history;
routine beta and stable releases need no maintainer npm session, one-time
password, staging approval, or long-lived publishing token.

## Bootstrap the npm package

This section records the one-time `3.1.1` bootstrap. Do not reuse the
interactive path for a later release; follow
[Publish a later version](#publish-a-later-version) instead. The bootstrap started
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

4. Publish that reviewed tarball from the signed-in maintainer session.

   ```sh
   npm publish "$atet_npm_artifact/hraness-atet-3.1.1.tgz" \
     --access public \
     --ignore-scripts \
     --registry=https://registry.npmjs.org
   ```

   Complete npm's two-factor authentication prompt. Stop if npm does not
   enforce two-factor authentication. Never put an npm password, one-time
   password, recovery code, session cookie, or token in Git, a workflow, a task
   file, or chat.

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
the npm package settings with this exact identity. If a staged-publishing
connection already exists, delete and recreate it once because npm does not let
a trusted publisher's workflow, environment, or allowed action be edited in
place:

- organization or owner: `hraness`
- repository: `atet`
- workflow filename: `npm-stage.yml`
- allowed action: direct `npm publish` (`--allow-publish`)
- environment: `npm-stage` (`--environment npm-stage`)

Do not grant `--allow-stage` or any staged-publishing permission. Create a
GitHub environment named `npm-stage`, disable administrator bypass, and use
custom deployment policies rather than protected-branch admission. Its sole
protection rule must be `branch_policy`, with no required deployment reviewers;
its sole deployment policy must be tag pattern `v*`. Add no environment secret.
After the read-only verification job succeeds, the
dependent publishing job must start automatically. This GitHub environment binds
the trusted-publisher identity and tag without adding a separate human gate;
only the minimal publishing job may
reference this environment or request an OIDC token. The npm trusted-publisher
environment must match `npm-stage` exactly.

GitHub Actions may retain read-and-write workflow permissions for the stable
Release job's narrowly declared `contents: write` permission. No workflow gets
`contents: write` authority to create a tag or `actions: write` authority to
dispatch another workflow. In particular, never give the generic GitHub Actions
integration a release-tag ruleset bypass: repository branch workflows can
request a write-capable `GITHUB_TOKEN`.

Enable immutable releases in the repository settings before the first stable
OIDC release. The Release workflow requires GitHub's immutable readback; it does
not emulate immutability in workflow code.

Set package publishing access to **Require two-factor authentication and
disallow tokens**. Remove traditional publishing tokens. Do not add an npm
publishing token to GitHub. Preserve `contentPolicy.class=dual-use` and the
root `DISCLOSURE` in every version.

The trusted workflow's only registry mutation is equivalent to:

```sh
npm publish <reviewed-tarball> \
  --access public \
  --ignore-scripts \
  --provenance \
  --tag <latest-or-beta> \
  --registry=https://registry.npmjs.org
```

## Publish a later version

1. Merge one unique, strictly increasing version to `main`. Stable versions use
   `M.m.p`; beta versions use `M.m.p-beta.N`, with an increasing numeric `N`.
   An agent operating under the repository's standing release authorization
   then runs the checked local tag command from a clean current `main` checkout:

   ```sh
   bun run ./scripts/push-npm-release-tag.ts <exact-version>
   ```

   The command uses only already-available `gh` and Git credentials; it never
   reads or prints a token. Before its first mutation it requires authenticated
   immutable owner `User` ID `894119`, public repository ID `1310516748`, the
   exact active **Release tag creation** and **Immutable version tags** rulesets,
   and a
   live `npm-stage` environment with administrator bypass disabled and only
   the `v*` tag deployment policy, a clean exact protected current `main`,
   matching package identity, the exact
   active `.github/workflows/ci.yml`, its sole successful `push` run for that
   commit and exact attempt, and that attempt's successful **Required** job. It
   reads a bounded remote-tag inventory twice, enforces monotonic stable or beta
   SemVer, refuses conflicting or inherited local refs, creates one annotated
   `v<version>` tag, and pushes only that exact ref. If the same annotated remote
   tag already identifies the same commit, the command reports idempotent proof
   and does nothing. Missing authentication or ambiguous evidence fails closed.
2. The protected tag push starts **Publish npm package** and, for stable tags,
   **Release**. Each workflow first binds the push actor and event sender to
   owner `User` ID `894119`, the immutable public repository ID, and a protected
   tag before checkout. The dependent OIDC job is bound to the exact
   `npm-stage` environment and starts without GitHub deployment approval. It
   checks out no source and
   runs no repository code. It downloads and revalidates the three verified
   files, fetches the current default-branch head and owner-created tag into a
   new bare Git directory, rehashes the package, proves the exact tag commit,
   publishes the exact tarball directly, and polls until registry integrity,
   inventory, channel, signatures, and SLSA provenance match. Stable versions
   publish with `--tag latest`; beta versions publish with `--tag beta`. Never use
   `npm dist-tag` promotion: a beta promoted to stable is a new stable version
   and a new exact publication. If the workflow fails because `main`
   advanced before the tag was created, update to current `main` and rerun the
   local command. If a tag-bound workflow later fails transiently, rerun that
   exact workflow run; never dispatch it against another ref or move the tag.
3. Review the uniquely named artifact from the read-only verification job. It
   contains exactly the tarball, `npm-pack.json`, and `npm-package.sha256`.
   Confirm the source commit, version, inventory, sizes, SHA-1, SHA-512
   integrity, independent SHA-256 digests, dual-use declaration, and
   disclosure.
4. If npm accepted the package but registry readback timed out, verify the exact
   version and intended channel instead of rerunning publication. Published npm
   versions are immutable and must never be reused.
5. For a stable version, the parallel Release workflow waits for exact npm
   readback, then independently rechecks the protected annotated tag, npm
   delivery, source, and official VTracer matrix before it creates the immutable
   GitHub Release. Beta tags do not start the Release workflow.

Finish one stable version and its GitHub Release before publishing the next
stable version so concurrent runs cannot reorder the `latest` channel.

## Protect npm release tags without a sudo prompt

Create two repository rulesets matching `refs/tags/v*`. Name **Immutable
version tags** restricts updates and deletions with an empty bypass list. Name
**Release tag creation** restricts creation and gives only immutable owner `User` ID
`894119` an always bypass. It grants no update or delete bypass and includes no
administrator, repository-role, team, deploy-key, or integration actor. Never
give GitHub Actions integration ID `15368` this bypass: any same-repository
branch workflow could otherwise mint a release tag. Do not combine the two
rules in one bypassable ruleset, and do not create throwaway or probe tags.
After this one-time ruleset setup, the owner's existing local Git credential can
push the script's exact annotated ref without routine GitHub sudo approval;
neither the credential nor an approval is stored in the repository. Publication
and Release require `github.ref_protected`, the exact owner/event sender and
public repository identity, annotated-tag identity, package version, and source
commit before any provider mutation. The local tag command reads back both exact
active rulesets and refuses any namespace, rule, enforcement, or bypass drift.

For a larger maintainer group, replace the owner-local boundary with a dedicated
Release GitHub App only after its isolated credential and immutable installed
App ID are configured explicitly in the script/workflow and creation ruleset.
Do not use the generic Actions integration or trust an unconfigured/name-only
App.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/), [package
provenance](https://docs.npmjs.com/viewing-package-provenance/), and [dual-use
content](https://docs.npmjs.com/policies/dual-use/).
