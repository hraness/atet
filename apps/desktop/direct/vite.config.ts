import react from "@vitejs/plugin-react";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const directRoot = resolve(import.meta.dirname);

const NODE_BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((specifier) => (
    specifier.startsWith("node:")
      ? [specifier]
      : [specifier, `node:${specifier}`]
  )),
);

function rejectNodeBuiltins(): Plugin {
  return {
    name: "transmute-direct-browser-only",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer !== undefined && NODE_BUILTIN_SPECIFIERS.has(source)) {
        this.error(
          `Transmute Direct browser module ${JSON.stringify(importer)} imports Node builtin ${JSON.stringify(source)}.`,
        );
      }
      return null;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [rejectNodeBuiltins(), react()],
  root: directRoot,
  build: {
    emptyOutDir: true,
    outDir: resolve(directRoot, "../dist-direct"),
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
