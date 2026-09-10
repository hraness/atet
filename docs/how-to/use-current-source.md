# Run commands from current source

Slopcamera currently installs from source; no renamed release archive has been published. Historical Atet releases retain their original package and command. Use this guide for the Slopcamera CLI, SDK and matching Agent Skill. The [capability reference](../reference/capabilities.md) names each workflow’s additional runtime requirements.

You need Git and Bun 1.3.14. Clone into a new directory, record the exact source commit and install its locked dependencies:

```sh
git clone --branch main https://github.com/hraness/slopcamera.git slopcamera-source
cd slopcamera-source
git rev-parse HEAD > ../slopcamera-source-commit.txt
bun install --frozen-lockfile --ignore-scripts
bun run build:sdk
bun run build:desktop:cli
```

These commands build the SDK and source-backed CLI. They do not build the desktop app or run a native scene. Keep the commit file with your work: the branch can advance while a source build retains the same package version.

In this shell, make `slopcamera` invoke that exact checkout:

```sh
export SLOPCAMERA_SOURCE_ROOT="$PWD"
slopcamera() { bun "$SLOPCAMERA_SOURCE_ROOT/apps/desktop/dist/cli/main.js" "$@"; }
slopcamera --help
slopcamera help studio
slopcamera doctor --json
slopcamera skill install --target agents
```

Use `--target claude` for Claude Code, or omit the target for Codex. The skill comes from the same source checkout. Start a new agent session after installing it.

The `slopcamera` function works in this shell. Programs that launch a child process, such as Vercel, cannot execute a shell function. Give them the built entrypoint instead:

```sh
vercel env run -- bun "$SLOPCAMERA_SOURCE_ROOT/apps/desktop/dist/cli/main.js" ai models list --type image --json
```

This optional example requires an already linked Vercel workspace. Its injected credentials belong only to that child invocation; repeat the same launcher for a generation command. `SLOPCAMERA_SOURCE_ROOT` comes from the source setup above and stays bound to that checkout.

Create your production workspace outside the source checkout and keep this shell open:

```sh
mkdir ../slopcamera-production
cd ../slopcamera-production
```

The function continues using the built CLI while artifacts belong to the caller's working directory. Save the checkout path and commit so a later shell can restore the same function. Do not replace an existing checkout, its dependencies or its generated build during an active durable run: resume checks the runtime identity.

Install only the native tools required by your chosen workflow. The [first native film tutorial](../tutorials/first-native-film.md) uses a specific local Blender installation; the [studio guide](../studio.md) also covers Python environments for Manim and CadQuery. The portable source build does not provide those engines, operating-system capture permissions or a GPU.
