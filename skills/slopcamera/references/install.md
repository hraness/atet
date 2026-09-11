# Install and diagnose Slopcamera

Use this reference when the CLI is unavailable, a command differs from the installed release, or `slopcamera doctor` reports a missing dependency for the selected workflow.

## Install the CLI

Slopcamera requires Bun 1.3.14 or newer. Check the current machine before changing
it:

```sh
command -v bun
command -v slopcamera
```

A restricted shell can omit package-manager paths. Check known host installation paths before declaring a tool unavailable. If Bun is genuinely absent, follow its official [installation guide](https://bun.sh/docs/installation) within the user’s authorized setup scope. Do not switch package managers or pipe an unreviewed installer into a shell.

Slopcamera installs from its verified release archive: `bun add --global https://github.com/hraness/slopcamera/releases/download/v3.2.6/hraness-slopcamera-3.2.6.tgz`, then `slopcamera doctor --json`. Building from source is the contributor path. Historical Atet archives do not install the renamed CLI; never substitute `slopcamera` into an old archive URL.

Use an existing compatible source build when available. Otherwise follow the [complete source-install guide](https://github.com/hraness/slopcamera/blob/main/docs/how-to/use-current-source.md): clone into a new directory, record its exact commit, install locked dependencies without lifecycle scripts, build the SDK and source CLI, then define the shell command against that checkout. A clone or skill installation alone does not install the executable. Do not alter an existing active checkout to satisfy this path.

For a new source checkout:

```sh
git clone --branch main https://github.com/hraness/slopcamera.git slopcamera-source
cd slopcamera-source
git rev-parse HEAD > ../slopcamera-source-commit.txt
bun install --frozen-lockfile --ignore-scripts
bun run build:sdk
bun run build:desktop:cli
export SLOPCAMERA_SOURCE_ROOT="$PWD"
slopcamera() { bun "$SLOPCAMERA_SOURCE_ROOT/apps/desktop/dist/cli/main.js" "$@"; }
```

Keep the checkout and commit record. Restore the same path and function in a later shell. The function is local to that shell; another program cannot launch it as an executable. For an already linked Vercel workspace, use the built entrypoint explicitly:

```sh
vercel env run -- bun "$SLOPCAMERA_SOURCE_ROOT/apps/desktop/dist/cli/main.js" ai models list --type image --json
```

Vercel injects credentials only into that child. Use the same explicit launcher for each provider call that needs those credentials. Do not infer the source root from the current production directory. Inspect the resulting host:

```sh
slopcamera --help
slopcamera doctor --json
slopcamera workflows list --json
slopcamera skill path
```

`slopcamera skill install` installs that same checkout’s guide for Codex by default; use `--target claude` or `--target agents` for another Agent Skill reader. Optional native engines remain separate. Do not invoke historical paid World Labs commands as a substitute for missing capabilities.

## Add only required optional tools

Treat `slopcamera doctor --json` as the readiness report. Install FFmpeg, a supported
browser, native capture support, VTracer, tldraw Offline, or another optional
dependency only when the requested workflow needs it and the user has
authorized that machine change. Slopcamera obtains its checksum-pinned VTracer on
first vectorization use; do not replace that path with an unverified binary.

Gateway generation uses the caller's `AI_GATEWAY_API_KEY` or
`VERCEL_OIDC_TOKEN`. Keep credentials in the process environment and never
persist, print, or place them on argv. A missing credential is not permission
to switch providers.
