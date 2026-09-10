# Publish Slopcamera

GitHub Releases are canonical. A protected stable tag produces one verified package archive, GitHub provenance, and an immutable Release. npm is an optional downstream mirror. The new `@hraness/slopcamera` package has no dual-use content declaration or classification-based disclosure requirement. Its npm publisher must be configured for this exact new identity; settings on historical `@hraness/atet` do not carry over.

Start with [canonical GitHub publication](#publish-a-canonical-github-release).
The [npm mirror](#mirror-a-canonical-release-to-npm) is optional.
Slopcamera currently installs from source. These procedures describe future publication; no renamed archive is advertised before its live acceptance.

## Publish a canonical GitHub release

Keep the source candidate separate from a verified public release. `apps/web/published-release.json` retains the historical Atet release datum; it is not a Slopcamera download. Keep source installation as the public default until a Slopcamera archive passes live verification. Then update the installation surface and its verified release datum together.

1. Merge the new stable source through the current-head Required gate and complete the repository's local and native acceptance. From clean current `main`, run `bun run ./scripts/push-release-tag.ts <exact-stable-version>`. Its sole annotated-tag push follows owner, repository, protected-main, exact CI run/attempt/Required job, both live tag rulesets, immutable GitHub latest and monotonic remote-tag checks. It never publishes npm, moves a tag, or deletes a remote ref.
2. The protected tag workflow repeats owner and sender ID `894119`, repository ID `1310516748`, annotated tag, source ancestry and current-main workflow/helper closure checks. The read-only job runs the complete source gate, builds one `npm pack --ignore-scripts` archive, independently validates its bounded USTAR inventory and metadata, and exercises the exact archive in isolated Bun and npm consumers. Five official VTracer targets and the existing macOS shell tests/package must pass before attestation.
3. A checkout-free job reauthorizes the current run and loads only the byte-identical current-main/tagged release helper. It verifies the four-file handoff against the verification job's digests before requesting OIDC. Pinned `actions/attest` signs the archive, `npm-pack.json`, `release-manifest.json` and `SHA256SUMS`. `provenance.jsonl` carries the returned bundle. No package or product code runs with attestation or release credentials.
4. The dependent publisher independently verifies the five exact files, cryptographic provenance and hosted source/run/attempt identity. It creates an Actions-authored draft, uploads only missing matching assets, checks all provider names, sizes and digests, rechecks live source/authority and version ordering, then publishes immutable Latest. It never overwrites an asset or deletes/recreates a release. Discover existing drafts through the bounded authenticated release list, require one exact-tag match, and use its positive release ID for readback; GitHub may return 404 for a draft at the tag endpoint. Matching state from the same attempt is reconciled; a prior attempt's different manifest or bundle stops with its exact state rather than relabeling historical provenance.
5. Verify the live release, download its five assets into a fresh directory, and verify the archive before installation:

   ```sh
   gh release verify v<version> --repo hraness/slopcamera
   gh release download v<version> --repo hraness/slopcamera --dir <fresh-directory>
   gh release verify-asset v<version> <fresh-directory>/hraness-slopcamera-<version>.tgz --repo hraness/slopcamera
   gh attestation verify <fresh-directory>/hraness-slopcamera-<version>.tgz --repo hraness/slopcamera --signer-workflow hraness/slopcamera/.github/workflows/release.yml --signer-digest <source-sha> --source-digest <source-sha> --source-ref refs/tags/v<version> --deny-self-hosted-runners --bundle <fresh-directory>/provenance.jsonl
   ```

   Check every checksum against the downloaded bytes and bind the manifest to the verified source, tag and release attempt. Run `scripts/package-smoke.ts --archive <archive> --pack-json <npm-pack.json>` against the exact tagged source in an isolated consumer. A checksum or unsigned manifest alone is not provenance.
6. After live asset and installation acceptance, update the public release datum and installation references in a normal checked change, then verify Production HTML, Markdown and download targets. The one-command CLI install and update is `bun add --global https://github.com/hraness/slopcamera/releases/download/v<version>/hraness-slopcamera-<version>.tgz`; omit `--global` for an SDK dependency. Package and command names stay `@hraness/slopcamera` and `slopcamera`. Resolve Latest discovery to an immutable version before verification; do not install a mutable latest URL or pipe a downloaded script into a shell.

The manifest has exactly schema `hraness-github-release-v1`, repository/name and numeric repository ID, package, stable version/tag, source SHA, release workflow/current authority SHA, numeric run ID/attempt, and archive name/bytes/SHA-256/SHA-512. Every file is bounded and regular; unexpected files, symlinks, traversal, unsafe packed configuration and inconsistent bytes reject. Native package construction remains release acceptance; native binaries are not added to this distribution without separately enumerated asset and installation proof.

## Mirror a canonical release to npm

The **Stage npm package** workflow is dispatch-only. Canonical publication owns artifact construction; the optional mirror must download that exact immutable GitHub archive, verify its complete signed handoff and successful release attempt, and smoke it. It must not rebuild different bytes and call them the same canonical artifact. The mirror retains its full source gate, with pinned Node and Chromium, followed by fresh canonical provenance/asset admission and isolated installation of those exact bytes. A failed or incomplete canonical release run cannot admit a mirror.

The dispatch runs from current protected `main`. `package_version` selects an exact canonical version and defaults to the current source version. Keep the immutable artifact source distinct from the workflow source: the full gate runs in an isolated checkout of the canonical source, while the current workflow's smoke and npm policy helpers admit its archive. The canonical source must remain an ancestor of current `main`; later documentation or version changes do not relabel it. Staging rechecks the current workflow, annotated canonical tag, immutable archive and metadata digests, complete asset identities and npm latest immediately before mutation.

From current `main` at the released source, dispatch:

```sh
gh workflow run npm-stage.yml --ref main -f publish_to_npm=true
```

The current-main dispatch must be newer than npm's public `latest`. The checkout-free OIDC job retains its exact owner/triggering-actor, workflow, repository, environment and source guards. It recognizes every attempted terminal npm mutation before considering a stage-job display name. Every attempted write requires exactly one successful durable intent at the immediately preceding safe positive Actions step number. It revalidates the three-file staging handoff (`.tgz`, `npm-pack.json`, `npm-package.sha256`), independently parses the bounded archive/configuration, rechecks protected source and the immutable GitHub asset digest immediately before mutation, and captures npm's returned stage ID.

Leave `resolved_stage_version` empty normally. Resolve an ambiguous or rejected exact provider attempt before an owner dispatch clears that version's retained intent. A completed publication advances `latest` and releases the intent automatically. Keep the stage-only publisher as the sole staging authority; a newer GitHub release does not clear an unresolved npm intent.

Publication is direct: the trusted publisher's `npm publish` makes the exact
canonical bytes public as `latest` in one step, with npm provenance. No staged
approval or two-factor promotion step follows; Slopcamera is ordinary software
and carries no content-policy classification. Preserve account two-factor
authentication and the exact configured publisher; do not substitute a
long-lived publishing token.

After publication, download the registry archive and use `npm-package-identity.ts` plus isolated package smoke to compare the complete canonical content inventory, entry types, modes, sizes and hashes against the GitHub artifact. npm may re-encode transport bytes; preserve both archives and their own metadata rather than claim different gzip or tar bytes are identical. Verify registry signatures and the npm-publish/SLSA attestations using `npm audit signatures --json --include-attestations --omit=dev` and `npm-publish-authority.ts`. Those npm proofs remain mirror acceptance; they are no longer GitHub release authority. An npm write can succeed before its runner reports failure, so reconcile the cryptographically verified provider state before retrying.

Never dispatch the next stable version while a previous dispatch's mutation
is unresolved. The workflow records a version-bound successful intent
immediately before mutation and scans that intent across all retained attempts,
failing closed until public `latest` advances or the owner explicitly names the
resolved intent through `resolved_stage_version`. Human dispatch order controls
`latest`; workflow concurrency alone cannot serialize an external mutation.

## Protect release tags without a sudo prompt

Keep two active repository rulesets matching `refs/tags/v*`. **Immutable
version tags** restricts update and deletion with an empty bypass list.
**Release tag creation** restricts creation only and gives immutable owner
`User` ID `894119` the sole always-bypass entry. Do not grant the generic
GitHub Actions integration, an administrator, a repository role, a team, or
another integration this bypass, and never combine creation with update or
deletion. This one-time provider setup lets the already-authenticated owner
create the exact release tag under standing task authority without a routine
GitHub sudo approval. Never create probe tags or move a version tag. The canonical GitHub gate is independent of optional npm mirroring.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/), [staged
publishing](https://docs.npmjs.com/staged-publishing/).

## Configure trusted publishing

After `@hraness/slopcamera` exists, configure one GitHub Actions trusted publisher in
the npm package settings with this exact identity:

- organization or owner: `hraness`
- repository: `slopcamera`
- workflow filename: `npm-stage.yml`
- allowed action: `npm publish`
- environment: `npm-stage`

Create a GitHub environment named `npm-stage`. Disable administrator bypass.
Its sole protection rule must be `branch_policy`, and its sole deployment
policy must be the selected branch `main` with type `branch`. Configure no
required deployment reviewers and add no environment secret. Optional manual dispatches first verify and upload the exact canonical GitHub archive without OIDC. A dispatch with its default false input stops there. The dependent staging job starts only when a current-main
owner manual dispatch explicitly sets `publish_to_npm=true`. The staging job
re-reads that exact run attempt and requires both the original actor and the
attempt's triggering actor to be immutable owner `User` ID `894119` before it
sets up npm or requests an OIDC token. This GitHub environment binds
the trusted-publisher identity and branch without adding a separate human gate;
publication makes the package public as `latest`. Only the minimal staging job may
reference this environment or request an OIDC token. The npm trusted-publisher
environment must match `npm-stage` exactly.

Set package publishing access to **Require two-factor authentication and
disallow tokens**. Remove traditional publishing tokens. Do not add an npm
publishing token to GitHub. Do not copy historical Atet classification metadata
or its disclosure requirement into the new package.

The trusted workflow's only registry mutation is equivalent to:

```sh
npm publish <reviewed-tarball> \
  --@hraness:registry=https://registry.npmjs.org \
  --access public \
  --ignore-scripts \
  --provenance \
  --registry=https://registry.npmjs.org
```

The job runs that command from a clean directory with separate empty user and
global npm configuration files. It rejects any ambient `npm_config_tag`, proves
that npm 11.19.0's untouched default tag is `latest`, and deliberately omits
`--tag`: npm treats an explicit tag as non-default and would otherwise skip its
built-in monotonic-`latest` guard. The workflow also performs its own immediate
live-version comparison before mutation.

The packed manifest must not contain a top-level `tag`, because npm gives that
field precedence over the command's explicit dist-tag. Its `publishConfig` must
contain exactly `access` and `registry`, with values `public` and
`https://registry.npmjs.org`. A scoped registry, proxy, authentication, tag,
provenance-file, or any other packed npm configuration is forbidden because npm
otherwise lets package metadata override its network and publication options.
The checkout-free staging parser and source/release identity parser both require
the exact eight-byte USTAR signature (`ustar\0` plus `00`) and npm/node-tar's
byte-475 prefix discriminator (zero means 130 prefix bytes; nonzero means 155).
Shared hostile fixtures keep both tar consumers behaviorally aligned.

## Historical Atet publication

Atet's one-time npm bootstrap published `@hraness/atet@3.1.1` as
`hraness-atet-3.1.1.tgz`. That package used a dual-use declaration and a
classification-specific disclosure. The [retained publication record](https://github.com/hraness/atet/blob/7ec55465c00db47553f2ac9d79181c6be01c9cc1/docs/publishing.md#bootstrap-the-npm-package)
describes the original commands and checks. Those requirements and artifacts
belong to the historical package; they do not describe Slopcamera's package or
prove that its registry publisher has been configured.

Preserve the historical tags, archives, package versions, attestations and
receipts unchanged. A GitHub repository redirect does not rename their package
contents or archive filenames. Never recreate an old artifact under a new name
and call it the original publication.
