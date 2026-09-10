import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSlopcameraProductionBoundary } from "./check-production-boundary";

async function boundaryFailure(desktop: string): Promise<string> {
  try {
    await checkSlopcameraProductionBoundary(desktop, join(desktop, "package.json"));
  } catch (reason: unknown) {
    return reason instanceof Error ? reason.message : String(reason);
  }
  throw new Error("Expected the production boundary to reject the fixture.");
}

test("Direct stays outside every production source and emitted graph", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-boundary-clean-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export const product = true;\n");
    await writeFile(join(desktop, "frontend", "dist", "app.js"), "export const product = true;\n");

    const result = await checkSlopcameraProductionBoundary(desktop, join(desktop, "package.json"));
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

  expect(document).toContain('<html lang="en" data-slopcamera-surface="product"');
  expect(document).toContain('<body data-slopcamera-surface="product">');
});

test("rejects a relative import that reaches the Direct workspace package", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-boundary-"));
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

test("relative Direct markers require a module segment or suffix boundary", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-relative-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "dist", "app.js"), "export {};\n");
    const source = join(desktop, "frontend", "src", "main.ts");
    for (const specifier of [
      "./direct", "../direct", "../../direct", "./direct/index", "../direct/runtime",
      "./direct.ts", "../direct.js", "./direct.mjs", "../direct.cjs", "./direct.tsx",
      "../direct.zig", "./direct?raw", "../direct#fixture", "./direct/../direct/index",
    ]) {
      await writeFile(source, `import ${JSON.stringify(specifier)};\n`);
      expect(await boundaryFailure(desktop)).toContain("./direct");
    }
    for (const contents of [
      "export { fixture } from '../direct';\n",
      "const fixture = import(`./direct`);\n",
      "const fixture = require('../direct');\n",
      "../direct", // A bare marker at EOF still has an exact suffix boundary.
      "./direct\n",
      'import "./direct\\\\runtime";\n',
    ]) {
      await writeFile(source, contents);
      expect(await boundaryFailure(desktop)).toContain("./direct");
    }
    for (const specifier of [
      "./directing-plan", "./directing-media.ts", "../directing-contract", "../../directing/index",
      "./directory", "../director", "./direct-helper", "../direct_helpers", "./direct2",
    ]) {
      await writeFile(source, `import ${JSON.stringify(specifier)};\n`);
      const result = await checkSlopcameraProductionBoundary(desktop, join(desktop, "package.json"));
      expect(result.source.scanned).toContain(source);
      expect(result.source.violations).toEqual([]);
    }
    await writeFile(source, 'import "./directing-plan"; import "../direct/session";\n');
    expect(await boundaryFailure(desktop)).toContain("../direct");
    await writeFile(source, 'import "./directing-media"; import "@hraness/direct"; const wire = "direct.runtime/v99";\n');
    const mixed = await boundaryFailure(desktop);
    expect(mixed).toContain("@hraness/direct");
    expect(mixed).toContain("direct.runtime/v");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("a legitimate directing module cannot bypass package or emitted Direct exclusions", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-directing-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await mkdir(join(desktop, "frontend", "dist"), { recursive: true });
    const manifest = join(desktop, "package.json");
    await writeFile(manifest, '{"dependencies":{"@hraness/direct":"1.0.0"}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), 'import "./directing-media";\n');
    await writeFile(join(desktop, "frontend", "dist", "app.js"), "export {};\n");
    expect(await boundaryFailure(desktop)).toContain("cannot be a production dependency");
    await writeFile(manifest, '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "dist", "app.js"), '"__direct";\n');
    expect(await boundaryFailure(desktop)).toContain("__direct");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("rejects future Direct probe schemas from production output", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-probe-boundary-"));
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
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-coverage-boundary-"));
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
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-manifest-boundary-"));
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
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-packaged-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export {};\n");
    const packagedRuntime = join(
      desktop,
      "zig-out",
      "package",
      "Slopcamera.app",
      "Contents",
      "Resources",
      "runtime",
      "bin",
    );
    await mkdir(packagedRuntime, { recursive: true });
    await writeFile(join(packagedRuntime, "slopcamera-capture"), "jungle.direct\n");
    expect(await boundaryFailure(desktop)).toContain("slopcamera-capture");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});

test("scans the packaged face analyzer at its runtime resource path", async () => {
  const desktop = await mkdtemp(join(tmpdir(), "slopcamera-packaged-face-boundary-"));
  try {
    await mkdir(join(desktop, "frontend", "src"), { recursive: true });
    await writeFile(join(desktop, "package.json"), '{"dependencies":{}}\n');
    await writeFile(join(desktop, "frontend", "src", "main.ts"), "export {};\n");
    const packagedRuntime = join(
      desktop,
      "zig-out",
      "package",
      "Slopcamera.app",
      "Contents",
      "Resources",
      "runtime",
      "bin",
    );
    await mkdir(packagedRuntime, { recursive: true });
    await writeFile(join(packagedRuntime, "slopcamera-face-analyzer"), "jungle.direct\n");
    expect(await boundaryFailure(desktop)).toContain("slopcamera-face-analyzer");
  } finally {
    await rm(desktop, { force: true, recursive: true });
  }
});
