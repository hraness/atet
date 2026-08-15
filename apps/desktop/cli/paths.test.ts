import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultCliStateRoot, resolveRepositoryPaths } from "./paths";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async root => {
    await rm(root, { force: true, recursive: true });
  }));
});

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atet-paths-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps", "desktop"), { recursive: true });
  await writeFile(join(root, "package.json"), "{}\n");
  return root;
}

test("resolves a standalone Atet checkout", async () => {
  const root = await repositoryFixture();
  const paths = await resolveRepositoryPaths(root, {}, root);
  const physicalRoot = await realpath(root);

  expect(paths.artifactRoot).toBe(join(physicalRoot, "artifacts", "atet", "recordings"));
  expect(paths.desktopRoot).toBe(join(physicalRoot, "apps", "desktop"));
});

test("uses an ordinary caller directory as the project root while loading tools from the install", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "atet-consumer-"));
  temporaryRoots.push(project);
  const paths = await resolveRepositoryPaths(project, {}, install);
  const physicalInstall = await realpath(install);
  const physicalProject = await realpath(project);

  expect(paths.repositoryRoot).toBe(physicalProject);
  expect(paths.desktopRoot).toBe(join(physicalInstall, "apps", "desktop"));
  expect(paths.artifactRoot).toBe(join(physicalProject, "artifacts", "atet", "recordings"));
});

test("preserves the caller project directory mode while creating only owned state", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "atet-mode-"));
  temporaryRoots.push(project);
  await chmod(project, 0o755);
  await Promise.all([
    mkdir(join(project, "artifacts", "atet", "recordings"), { mode: 0o755, recursive: true }),
    mkdir(join(project, "artifacts", "atet", "projects"), { mode: 0o755, recursive: true }),
    mkdir(join(project, "artifacts", "atet", "private"), { mode: 0o755, recursive: true }),
  ]);

  await resolveRepositoryPaths(project, {}, install);

  expect((await lstat(project)).mode & 0o777).toBe(0o755);
  expect((await lstat(join(project, "artifacts", "atet", "recordings"))).mode & 0o777)
    .toBe(0o700);
  expect((await lstat(join(project, "artifacts", "atet", "projects"))).mode & 0o777)
    .toBe(0o700);
  expect((await lstat(join(project, "artifacts", "atet", "private"))).mode & 0o777)
    .toBe(0o700);
});

test("keeps machine-global state shared with Transmute processes", () => {
  expect(defaultCliStateRoot("darwin", {})).toContain("/Transmute/cli");
  expect(defaultCliStateRoot("linux", {})).toEndWith("/transmute");
});

test("reads an existing predecessor artifact namespace without migrating it", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "atet-predecessor-artifacts-"));
  temporaryRoots.push(project);
  await mkdir(join(project, "artifacts", "transmute"), { recursive: true });
  const paths = await resolveRepositoryPaths(project, {
    TRANSMUTE_REPOSITORY_ROOT: project,
  }, install);
  expect(paths.artifactRoot).toBe(join(await realpath(project), "artifacts", "transmute", "recordings"));
});

test("fails closed on renamed environment and artifact namespace conflicts", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "atet-conflicting-artifacts-"));
  temporaryRoots.push(project);
  await Promise.all([
    mkdir(join(project, "artifacts", "atet"), { recursive: true }),
    mkdir(join(project, "artifacts", "transmute"), { recursive: true }),
  ]);
  await expect(resolveRepositoryPaths(project, {}, install))
    .rejects.toThrow("Both artifacts/atet and artifacts/transmute exist");
  await expect(resolveRepositoryPaths(project, {
    ATET_REPOSITORY_ROOT: project,
    TRANSMUTE_REPOSITORY_ROOT: install,
  }, install)).rejects.toThrow("ATET_REPOSITORY_ROOT and TRANSMUTE_REPOSITORY_ROOT disagree");
});
