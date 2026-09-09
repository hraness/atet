# Run commands from current source

Use this path when a command documented on `main` is absent from your installed release. The [capability reference](../reference/capabilities.md) distinguishes v3.2.3 from current source. For released functionality, use the [canonical release installation](../../README.md#install-atet).

You need Git and Bun 1.3.14. Clone into a new directory, record the exact source commit and install its locked dependencies:

```sh
git clone --branch main https://github.com/hraness/atet.git atet-source
cd atet-source
git rev-parse HEAD > ../atet-source-commit.txt
bun install --frozen-lockfile --ignore-scripts
bun run build:sdk
bun run build:desktop:cli
```

These commands build the SDK and source-backed CLI. They do not build the desktop app or run a native scene. Keep the commit file with your work: the branch can advance while a source build retains the same package version.

In this shell, make `atet` invoke that exact checkout:

```sh
export ATET_SOURCE_ROOT="$PWD"
atet() { bun "$ATET_SOURCE_ROOT/apps/desktop/dist/cli/main.js" "$@"; }
atet --help
atet help studio
atet doctor --json
```

Create your production workspace outside the source checkout and keep this shell open:

```sh
mkdir ../atet-production
cd ../atet-production
```

The function continues using the built CLI while artifacts belong to the caller's working directory. Save the checkout path and commit so a later shell can restore the same function. Do not replace an existing checkout, its dependencies or its generated build during an active durable run: resume checks the runtime identity.

Install only the native tools required by your chosen workflow. The [first native film tutorial](../tutorials/first-native-film.md) uses a specific local Blender installation; the [studio guide](../studio.md) also covers Python environments for Manim and CadQuery. The portable source build does not provide those engines, operating-system capture permissions or a GPU.
