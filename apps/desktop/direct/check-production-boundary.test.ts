import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkTransmuteProductionBoundary } from "./check-production-boundary";

async function boundaryFailure(desktop: string): Promise<string> {
  try {
    await checkTransmuteProductionBoundary(desktop, join(desktop, "package.json"));
  } catch (reason: unknown) {
    return reason instanceof Error ? reason.message : String(reason);
  }
  throw new Error("Expected the production boundary to reject the fixture.");
}

test("Direct stays outside every production source and emitted graph", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "transmute-boundary-clean-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export const product = true;\n");
    await writeFile(join(desktop, "frontend", "dist", "app.js"), "export const product = true;\n");

    const result = await checkTransmuteProductionBoundary(desktop, join(desktop, "package.json"));
    expect(result.source.scanned.length).toBeGreaterThan(0);
    expect(result.emitted.scanned.length).toBeGreaterThan(0);
    expect(result.source.violations).toEqual([]);
    expect(result.emitted.violations).toEqual([]);
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("the browser workbench opts into the production surface contract", async () => {
  const document = await Bun.file(new URL("./index.html", import.meta.url)).text();

  expect(document).toContain('<html lang="en" data-transmute-surface="product"');
  expect(document).toContain('<body data-transmute-surface="product">');
});

test("rejects a relative import that reaches the Direct workspace package", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "transmute-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(
      join(desktop, "frontend", "src", "main.ts"),
      'import "../../../../packages/direct/src";\n',
    );
    await writeFile(join(desktop, "frontend", "dist", "app.js"), "export {};\n");
    expect(await boundaryFailure(desktop)).toContain("packages/direct");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("rejects future Direct probe schemas from production output", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "transmute-probe-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export {};\n");
    await writeFile(join(desktop, "frontend", "dist", "index.js"), "direct.probe/v99\n");
    expect(await boundaryFailure(desktop)).toContain("direct.probe/v");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("rejects future Direct coverage schemas from production output", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "transmute-coverage-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export {};\n");
    await writeFile(join(desktop, "frontend", "dist", "index.js"), "direct.coverage/v99\n");
    expect(await boundaryFailure(desktop)).toContain("direct.coverage/v");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("rejects future Direct session manifests from production output", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "transmute-manifest-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export {};\n");
    await writeFile(
      join(desktop, "frontend", "dist", "index.js"),
      "direct.session-manifest/v99\n",
    );
    expect(await boundaryFailure(desktop)).toContain("direct.session-manifest/v");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("scans the packaged capture helper at its runtime resource path", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "transmute-packaged-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export {};\n");
    const packagedRuntime = join(
      desktop,
      "zig-out",
      "package",
      "Transmute.app",
      "Contents",
      "Resources",
      "runtime",
      "bin",
    );
    await mkdir(packagedRuntime, { recursive: true });
    await writeFile(join(packagedRuntime, "transmute-capture"), "jungle.direct\n");
    expect(await boundaryFailure(desktop)).toContain("transmute-capture");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("scans the packaged face analyzer at its runtime resource path", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "transmute-packaged-face-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export {};\n");
    const packagedRuntime = join(
      desktop,
      "zig-out",
      "package",
      "Transmute.app",
      "Contents",
      "Resources",
      "runtime",
      "bin",
    );
    await mkdir(packagedRuntime, { recursive: true });
    await writeFile(join(packagedRuntime, "transmute-face-analyzer"), "jungle.direct\n");
    expect(await boundaryFailure(desktop)).toContain("transmute-face-analyzer");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});
