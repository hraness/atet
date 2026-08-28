# Publish Atet

Atet uses an interactive first npm publication and stage-only trusted
publishing for later versions. npm cannot stage a package name that does not
exist, and npm's dual-use policy requires two-factor authentication at the
interactive publish or staged-promotion boundary.

## Bootstrap the npm package

Start from the current `main` commit after its required checks pass. Use Node
24, npm 11.19.0, and Bun 1.3.14. Confirm that the signed-in npm maintainer has
publish access to the `hraness` organization and two-factor authentication
enabled. Do not create the matching Git tag yet.

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
the npm package settings with this exact identity:

- organization or owner: `hraness`
- repository: `atet`
- workflow filename: `npm-stage.yml`
- allowed action: `npm stage publish` only
- environment: `npm-stage`

Create a protected GitHub environment named `npm-stage`. Require approval from
the repository maintainer `0thernet` before deployment, allow that maintainer
to approve their own initiating run (`prevent_self_review: false`), and add no
environment secret. Only the minimal staging job may reference this environment
or request an OIDC token. The npm trusted-publisher environment must match
`npm-stage` exactly.

Set package publishing access to **Require two-factor authentication and
disallow tokens**. Remove traditional publishing tokens. Do not add an npm
publishing token to GitHub. Preserve `contentPolicy.class=dual-use` and the
root `DISCLOSURE` in every version.

The trusted workflow's only registry mutation is equivalent to:

```sh
npm stage publish <reviewed-tarball> \
  --access public \
  --ignore-scripts \
  --provenance \
  --registry=https://registry.npmjs.org
```

## Stage a later version

1. Merge one new stable version to `main`. A push that changes `package.json`
   starts **Stage npm package** automatically. Its read-only verification job
   repeats the complete gate before it can hand an artifact to the OIDC job. A
   `package.json` edit that leaves the stable version unchanged exits
   successfully without building, uploading, or staging a package.
2. Let the automatic workflow finish. If it fails because `main` advanced or a
   transient dependency was unavailable, dispatch **Stage npm package** from
   the current `main` HEAD to recover through the same checks. Automatic and
   manual runs both reject a tag, another branch, a stale commit, an existing
   version, or a branch that advances before staging. A push-triggered version
   must also increase strictly from the preceding `main` version.
3. Review the uniquely named artifact from the read-only verification job. It
   contains exactly the tarball, `npm-pack.json`, and `npm-package.sha256`.
   Confirm the source commit, version, inventory, sizes, SHA-1, SHA-512
   integrity, independent SHA-256 digests, dual-use declaration, and
   disclosure.
4. Approve the protected `npm-stage` environment as a required maintainer. This
   approval permits only the dependent staging job to request OIDC authority;
   it does not publish the package. The job checks out no source and runs no
   repository code. It downloads and revalidates the three reviewed files,
   fetches the current default-branch head into a new bare Git directory,
   rehashes the package, proves the matching Git tag is still absent, and only
   then runs the exact stage-only command.
5. Inspect the staged package with
   `npm stage view <stage-id> --registry=https://registry.npmjs.org` and
   download it with
   `npm stage download <stage-id> --registry=https://registry.npmjs.org` when
   an independent local inspection is required.
6. Approve the exact stage with
   `npm stage approve <stage-id> --registry=https://registry.npmjs.org` or
   npmjs.com and complete two-factor authentication. This npm approval is
   separate from the earlier GitHub environment review and is the action that
   makes the staged package public.
7. Download and verify the public registry artifact in a clean consumer.
8. Create and push the matching `v<version>` tag on the same `main` commit. The
   tag workflow verifies npm delivery before it creates the immutable GitHub
   Release.

Finish one staged version and its GitHub Release before staging the next stable
version so human approvals cannot reorder the `latest` tag.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/), [staged
publishing](https://docs.npmjs.com/staged-publishing/), and [dual-use
content](https://docs.npmjs.com/policies/dual-use/).
