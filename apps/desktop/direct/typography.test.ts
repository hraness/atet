import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

async function emittedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await emittedFiles(path));
    else files.push(path);
  }
  return files;
}

describe("Direct desktop typography", () => {
  test("loads Nebula Sans before the production styles", async () => {
    const source = await readFile(resolve(import.meta.dir, "main.tsx"), "utf8");

    expect(source.indexOf('import "@hraness/design-kit/fonts.css";'))
      .toBeLessThan(source.indexOf('import "../frontend/src/index.css";'));
  });

  test("emits the canonical WOFF2 payload from the Direct Vite path", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atet-direct-fonts-"));
    try {
      await build({
        build: { emptyOutDir: true, outDir: temporaryRoot },
        configFile: resolve(import.meta.dir, "vite.config.ts"),
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
