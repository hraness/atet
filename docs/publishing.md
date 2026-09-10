# Publish Slopcamera

GitHub Releases are canonical. A protected stable tag produces one verified package archive, GitHub provenance, and an immutable Release, then the same workflow publishes those exact bytes to npm through trusted publishing. npm is a downstream mirror. The new `@hraness/slopcamera` package has no dual-use content declaration or classification-based disclosure requirement. Its npm publisher must be configured for this exact new identity; settings on historical `@hraness/atet` do not carry over.

Start with [canonical GitHub publication](#publish-a-canonical-github-release).
The [npm publication](#publish-the-canonical-release-to-npm) follows automatically in the same workflow.
Slopcamera v3.2.4 is the first canonical Slopcamera release; these procedures publish each later version the same way, and no archive is advertised before its live acceptance.

## Publish a canonical GitHub release

Keep the source candidate separate from a verified public release. `apps/web/published-release.json` names the verified canonical Slopcamera release that the site and README advertise. Keep source installation as the public default until a Slopcamera archive passes live verification. Then update the installation surface and its verified release datum together.

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

## Publish the canonical release to npm

npm publication is automatic. The same tag Release workflow that publishes the
immutable GitHub Release then runs `publish_npm`, which publishes the exact
canonical archive bytes to `@hraness/slopcamera` through npm trusted publishing
(OIDC) with npm provenance, and `admit_npm`, which verifies the public registry
copy against the canonical asset. No dispatch, staged approval, two-factor
prompt, or token is involved; Slopcamera is ordinary software and carries no
content-policy classification. Preserve account two-factor authentication and
the exact configured publisher; never substitute a long-lived publishing token.

`publish_npm` runs only after `publish` has verified immutable Latest. It checks
out no product source and installs no dependencies. It re-runs the owner and
current-main authority checks, loads the byte-identical current-main release
helper, downloads the attested five-file handoff by numeric artifact ID (so a
rerun of only the failed job still publishes the identical bytes), and admits it
through `github-release.ts npm-admit`: exact handoff bytes and trusted digests,
this run's source and tag, cryptographic provenance, and the published immutable
Latest release whose assets carry the same digests. The checkout-free USTAR and
packed-manifest reader then rejects any packed `tag`, non-canonical
`publishConfig`, or unsafe archive before the job requests OIDC.

Immediately before mutation the job scrubs ambient `npm_config_tag`, proves that
npm 11.19.0's clean default tag is `latest`, rehashes the archive, and reads the
registry version. An absent version must be newer than public `latest`; a
version that already publishes the identical SHA-512 integrity is an earlier
attempt of the same publication and completes without a second write; a
different integrity fails closed and is never overwritten. The only registry
mutation is equivalent to:

```sh
npm publish <attested-archive> \
  --@hraness:registry=https://registry.npmjs.org \
  --access public \
  --ignore-scripts \
  --provenance \
  --registry=https://registry.npmjs.org
```

It runs from a clean directory with separate empty user and global npm
configuration files and deliberately omits `--tag`, so npm keeps its built-in
monotonic-`latest` guard. The returned identity must match the archive
integrity exactly.

`admit_npm` checks out the verified tag read-only, downloads the immutable
GitHub asset and the registry archive, and compares them with
`npm-package-identity.ts` (complete content inventory, entry types, modes,
sizes and hashes; npm may re-encode transport bytes). It installs the exact
registry version in an isolated consumer, runs
`npm audit signatures --json --include-attestations --omit=dev`, and verifies
registry signatures plus the npm publish and SLSA attestations with
`npm-publish-authority.ts`, which binds the provenance to this repository, the
tag ref, the `push` event and the Release workflow. The isolated package smoke
runs against the registry archive. Those npm proofs are mirror acceptance; they
are not GitHub release authority. An npm write can succeed before its runner
reports failure, so rerun only the failed jobs and let the registry readback
reconcile the state; never republish a version or move `latest` backward.

The packed manifest must not contain a top-level `tag`, because npm gives that
field precedence over the command's explicit dist-tag. Its `publishConfig` must
contain exactly `access` and `registry`, with values `public` and
`https://registry.npmjs.org`. A scoped registry, proxy, authentication, tag,
provenance-file, or any other packed npm configuration is forbidden because npm
otherwise lets package metadata override its network and publication options.
The checkout-free publication parser and source/release identity parser both
require the exact eight-byte USTAR signature (`ustar\0` plus `00`) and
npm/node-tar's byte-475 prefix discriminator (zero means 130 prefix bytes;
nonzero means 155). Shared hostile fixtures keep both tar consumers
behaviorally aligned.

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
publishing](https://docs.npmjs.com/trusted-publishers/).

## Configure trusted publishing

`@hraness/slopcamera` publishes only through one GitHub Actions trusted
publisher with this exact identity:

- organization or owner: `hraness`
- repository: `slopcamera`
- workflow filename: `release.yml`
- environment: `npm-release`
- allowed action: `npm publish`

The one-time owner setup (passkey or two-factor prompt) is:

```sh
npm trust github @hraness/slopcamera --repo hraness/slopcamera --file release.yml --environment npm-release --allow-publish --yes
npm trust list @hraness/slopcamera
```

Revoke any earlier relationship that names another workflow file or
environment with `npm trust revoke @hraness/slopcamera --id <trust-id>`.

The GitHub environment `npm-release` has administrator bypass disabled, the
sole protection rule `branch_policy`, and the sole deployment policy tag `v*`.
It has no required reviewers and no secrets. Only `publish_npm` may reference
this environment or request the npm OIDC token; `attest` holds the only other
`id-token: write`. Set package publishing access to **Require two-factor
authentication and disallow tokens**, remove traditional publishing tokens, and
never add an npm token to GitHub. Do not copy historical Atet classification
metadata or its disclosure requirement into the new package.

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
