import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRepositoryPaths } from "./paths";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async root => {
    await rm(root, { force: true, recursive: true });
  }));
});

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "transmute-paths-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps", "desktop"), { recursive: true });
  await writeFile(join(root, "package.json"), "{}\n");
  return root;
}

test("resolves a standalone Transmute checkout", async () => {
  const root = await repositoryFixture();
  const paths = await resolveRepositoryPaths(root, {}, root);
  const physicalRoot = await realpath(root);

  expect(paths.artifactRoot).toBe(join(physicalRoot, "artifacts", "transmute", "recordings"));
  expect(paths.desktopRoot).toBe(join(physicalRoot, "apps", "desktop"));
});

test("uses an ordinary caller directory as the project root while loading tools from the install", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "transmute-consumer-"));
  temporaryRoots.push(project);
  const paths = await resolveRepositoryPaths(project, {}, install);
  const physicalInstall = await realpath(install);
  const physicalProject = await realpath(project);

  expect(paths.repositoryRoot).toBe(physicalProject);
  expect(paths.desktopRoot).toBe(join(physicalInstall, "apps", "desktop"));
  expect(paths.artifactRoot).toBe(join(physicalProject, "artifacts", "transmute", "recordings"));
});

test("preserves the caller project directory mode while creating only owned state", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "transmute-mode-"));
  temporaryRoots.push(project);
  await chmod(project, 0o755);
  await Promise.all([
    mkdir(join(project, "artifacts", "transmute", "recordings"), { mode: 0o755, recursive: true }),
    mkdir(join(project, "artifacts", "transmute", "projects"), { mode: 0o755, recursive: true }),
    mkdir(join(project, "artifacts", "transmute", "private"), { mode: 0o755, recursive: true }),
  ]);

  await resolveRepositoryPaths(project, {}, install);

  expect((await lstat(project)).mode & 0o777).toBe(0o755);
  expect((await lstat(join(project, "artifacts", "transmute", "recordings"))).mode & 0o777)
    .toBe(0o700);
  expect((await lstat(join(project, "artifacts", "transmute", "projects"))).mode & 0o777)
    .toBe(0o700);
  expect((await lstat(join(project, "artifacts", "transmute", "private"))).mode & 0o777)
    .toBe(0o700);
});
