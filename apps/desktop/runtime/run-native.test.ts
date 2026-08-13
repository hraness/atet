import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findRepositoryRoot, resolveDevelopmentRuntimeResources } from "./run-native";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })));
});

async function developmentFixture(): Promise<{ desktop: string; repository: string }> {
  const root = await mkdtemp(join(tmpdir(), "transmute-native-resources-"));
  temporaryDirectories.push(root);
  const desktop = join(root, "apps", "desktop");
  const gateway = join(desktop, "runtime", "dist", "transmute-gateway");
  const helper = join(desktop, "capture", "dist", "transmute-capture");
  await Promise.all([
    mkdir(join(desktop, "runtime", "dist"), { recursive: true }),
    mkdir(join(desktop, "capture", "dist"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "package.json"), "{}\n"),
    writeFile(join(desktop, "app.zon"), ".{}\n"),
    writeFile(gateway, "#!/bin/sh\n", { mode: 0o755 }),
    writeFile(helper, "#!/bin/sh\n", { mode: 0o755 }),
  ]);
  await Promise.all([chmod(gateway, 0o755), chmod(helper, 0o755)]);
  return { desktop, repository: await realpath(root) };
}

test("development resource discovery anchors both sidecars to one Transmute checkout", async () => {
  const fixture = await developmentFixture();
  const resources = resolveDevelopmentRuntimeResources(fixture.desktop);
  expect(resources.repositoryRoot).toBe(fixture.repository);
  expect(resources.gateway).toBe(await realpath(join(fixture.desktop, "runtime", "dist", "transmute-gateway")));
  expect(resources.captureHelper).toBe(await realpath(join(fixture.desktop, "capture", "dist", "transmute-capture")));
  expect(findRepositoryRoot(join(fixture.desktop, "runtime", "dist"))).toBe(fixture.repository);
});

test("development resource discovery fails closed when either sidecar is absent", async () => {
  const fixture = await developmentFixture();
  await rm(join(fixture.desktop, "capture", "dist", "transmute-capture"));
  expect(() => resolveDevelopmentRuntimeResources(fixture.desktop)).toThrow(/capture helper is missing/u);
});
