# Install and diagnose Atet

Use this reference only when `atet` is unavailable or `atet doctor` reports a
dependency required by the selected media workflow.

## Install the CLI

Atet requires Bun 1.3.14 or newer. Check the current machine before changing
it:

```sh
command -v bun
command -v atet
```

If Bun is missing, stop and direct the user to the official
[Bun installation guide](https://bun.sh/docs/installation). Do not switch
package managers or pipe an unreviewed installer into a shell.

When the user asked to install or use Atet, install the current immutable
release, then inspect its real capabilities:

```sh
bun add --global @hraness/atet@3.1.2
atet --help
atet doctor --json
atet workflows list --json
```

Do not clone the source repository merely to run Atet. `atet skill path` prints
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
