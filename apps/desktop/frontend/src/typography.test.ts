import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const frontendMain = resolve(import.meta.dir, "main.tsx");
const frontendStyles = resolve(import.meta.dir, "index.css");

async function emittedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await emittedFiles(path));
    else files.push(path);
  }
  return files;
}

describe("desktop typography", () => {
  test("loads Nebula Sans before the shared product styles in production", async () => {
    const [manifestSource, productionSource, css] = await Promise.all([
      readFile(resolve(repositoryRoot, "package.json"), "utf8"),
      readFile(frontendMain, "utf8"),
      readFile(frontendStyles, "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      devDependencies?: Record<string, string>;
    };

    expect(manifest.devDependencies?.["@hraness/design-kit"])
      .toBe("github:hraness/design-kit#v0.3.0");
    expect(productionSource.indexOf('import "@hraness/design-kit/fonts.css";'))
      .toBeLessThan(productionSource.indexOf('import "./index.css";'));
    expect(css).toContain('--font-text: "Nebula Sans", ui-sans-serif, system-ui');
    expect(css).toContain('--font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace');
  });

  test("emits the canonical WOFF2 payload from the production Vite path", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atet-desktop-fonts-"));
    try {
      await build({
        build: { emptyOutDir: true, outDir: temporaryRoot },
        configFile: resolve(repositoryRoot, "apps/desktop/frontend/vite.config.ts"),
        logLevel: "silent",
      });
      const files = await emittedFiles(temporaryRoot);
      const fontFiles = files.filter(path => path.endsWith(".woff2"));
      const bundledCss = (await Promise.all(
        files.filter(path => path.endsWith(".css")).map(async path => await readFile(path, "utf8")),
      )).join("\n");

      expect(fontFiles.length).toBeGreaterThanOrEqual(2);
      expect(Math.min(...await Promise.all(
        fontFiles.map(async path => (await Bun.file(path).arrayBuffer()).byteLength),
      ))).toBeGreaterThan(60_000);
      expect(bundledCss).toMatch(/font-family:\s*["']?Nebula Sans/u);
      expect(bundledCss).toContain("--font-text");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
