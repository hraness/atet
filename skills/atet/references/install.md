# Install and diagnose Atet

Use this reference when the CLI is unavailable, a command differs from the installed release, or `atet doctor` reports a missing dependency for the selected workflow.

## Install the CLI

Atet requires Bun 1.3.14 or newer. Check the current machine before changing
it:

```sh
command -v bun
command -v atet
```

A restricted shell can omit package-manager paths. Check known host installation paths before declaring a tool unavailable. If Bun is genuinely absent, follow its official [installation guide](https://bun.sh/docs/installation) within the user’s authorized setup scope. Do not switch package managers or pipe an unreviewed installer into a shell.

When the user asked to install or use Atet, install the current immutable
release, then inspect its real capabilities:

```sh
bun add --global https://github.com/hraness/atet/releases/download/v3.2.3/hraness-atet-3.2.3.tgz
atet --help
atet doctor --json
atet workflows list --json
```

The release includes core `scene` commands, hardware Three/Spark profiles and saved-world import. The newer `studio`, `direct` and `scene camera-track` commands are absent from v3.2.3. For those tasks, use an existing compatible source build or the [current-source installation guide](https://github.com/hraness/atet/blob/main/docs/how-to/use-current-source.md); record the exact commit and inspect its help. Do not invoke historical paid World Labs commands as a substitute. For released commands, a source clone is unnecessary. `atet skill path` prints
the version-matched packaged skill, while `atet skill install` can install that
copy for a named agent runner when the public `skills` CLI is not being used.

## Add only required optional tools

Treat `atet doctor --json` as the readiness report. Install FFmpeg, a supported
browser, native capture support, VTracer, tldraw Offline, or another optional
dependency only when the requested workflow needs it and the user has
authorized that machine change. Atet obtains its checksum-pinned VTracer on
first vectorization use; do not replace that path with an unverified binary.

Gateway generation uses the caller's `AI_GATEWAY_API_KEY` or
`VERCEL_OIDC_TOKEN`. Keep credentials in the process environment and never
persist, print, or place them on argv. A missing credential is not permission
to switch providers.
