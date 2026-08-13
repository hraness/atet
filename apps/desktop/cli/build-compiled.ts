import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export function assertAppleSiliconMacosCompiledCliHost(
  platform: NodeJS.Platform,
  architecture: string,
): void {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new Error(
      `The copied Transmute CLI is an Apple Silicon macOS artifact; received ${platform}/${architecture}.`,
    );
  }
}

if (import.meta.main) {
  assertAppleSiliconMacosCompiledCliHost(process.platform, process.arch);
  const sharpPackageEntry = fileURLToPath(
    import.meta.resolve("@img/sharp-darwin-arm64/sharp.node"),
  );
  const sharpAddon = join(
    dirname(sharpPackageEntry),
    "lib",
    "sharp-darwin-arm64-0.35.3.node",
  );
  const result = await Bun.build({
    compile: { outfile: resolve(import.meta.dir, "..", "dist", "transmute") },
    entrypoints: [resolve(import.meta.dir, "compiled-bootstrap.ts")],
    minify: true,
    naming: { asset: "[name].[ext]" },
    plugins: [{
      name: "embed-sharp-darwin-arm64",
      setup(build) {
        build.onResolve(
          { filter: /^@img\/sharp-darwin-arm64\/sharp\.node$/u },
          () => ({ namespace: "transmute-native", path: "sharp.node" }),
        );
        build.onLoad(
          { filter: /^sharp\.node$/u, namespace: "transmute-native" },
          () => ({
            contents: `module.exports = require(${JSON.stringify(sharpAddon)});`,
            loader: "js",
          }),
        );
        build.onLoad(
          { filter: /\/sharp\/dist\/sharp\.mjs$/u },
          async args => {
            const source = await Bun.file(args.path).text();
            const declaration = "let sharp;";
            if (source.split(declaration).length !== 2) {
              throw new Error(
                "Pinned Sharp 0.35.3 loader no longer has its expected native-binding declaration.",
              );
            }
            return {
              contents: source.replace(
                declaration,
                'let sharp = globalThis[Symbol.for("transmute.sharp-darwin-arm64-addon/v1")];',
              ),
              loader: "js",
            };
          },
        );
      },
    }],
    sourcemap: "none",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
  }
}
