import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "slopcamera-paths-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps", "desktop"), { recursive: true });
  await writeFile(join(root, "package.json"), "{}\n");
  return root;
}

test("resolves a standalone Slopcamera checkout", async () => {
  const root = await repositoryFixture();
  const paths = await resolveRepositoryPaths(root, {}, root);
  const physicalRoot = await realpath(root);

  expect(paths.artifactRoot).toBe(join(physicalRoot, "artifacts", "slopcamera", "recordings"));
  expect(paths.desktopRoot).toBe(join(physicalRoot, "apps", "desktop"));
});

test("uses an ordinary caller directory as the project root while loading tools from the install", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "slopcamera-consumer-"));
  temporaryRoots.push(project);
  const paths = await resolveRepositoryPaths(project, {}, install);
  const physicalInstall = await realpath(install);
  const physicalProject = await realpath(project);

  expect(paths.repositoryRoot).toBe(physicalProject);
  expect(paths.desktopRoot).toBe(join(physicalInstall, "apps", "desktop"));
  expect(paths.artifactRoot).toBe(join(physicalProject, "artifacts", "slopcamera", "recordings"));
});

test("a copied executable uses physical caller state without requiring a source checkout", async () => {
  const install = await mkdtemp(join(tmpdir(), "slopcamera-copied-runtime-"));
  const project = await mkdtemp(join(tmpdir(), "slopcamera-copied-project-"));
  temporaryRoots.push(install, project);
  const executable = join(install, "slopcamera");
  await writeFile(executable, "copied executable fixture");
  const physicalProject = await realpath(project);
  for (const [cwd, environment] of [[project, {}], [install, { SLOPCAMERA_REPOSITORY_ROOT: project }]] as const) {
    const paths = await resolveRepositoryPaths(cwd, environment, "/$bunfs/root", executable);
    expect(paths.desktopRoot).toBe(await realpath(install));
    expect(paths.repositoryRoot).toBe(physicalProject);
    expect(paths.privateRoot).toBe(join(physicalProject, "artifacts", "slopcamera", "private"));
    expect(paths.projectRoot).toBe(join(physicalProject, "artifacts", "slopcamera", "projects"));
  }
  await expect(resolveRepositoryPaths("/$bunfs/root", {}, "/$bunfs/root", executable))
    .rejects.toThrow("physical caller workspace");
  await expect(resolveRepositoryPaths(project, { SLOPCAMERA_REPOSITORY_ROOT: "/$bunfs/root" }, "/$bunfs/root", executable))
    .rejects.toThrow("physical caller workspace");
  await expect(resolveRepositoryPaths(project, {}, install, executable))
    .rejects.toThrow("Could not find a Slopcamera checkout");
});

test("preserves the caller project directory mode while creating only owned state", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "slopcamera-mode-"));
  temporaryRoots.push(project);
  await chmod(project, 0o755);
  await Promise.all([
    mkdir(join(project, "artifacts", "slopcamera", "recordings"), { mode: 0o755, recursive: true }),
    mkdir(join(project, "artifacts", "slopcamera", "projects"), { mode: 0o755, recursive: true }),
    mkdir(join(project, "artifacts", "slopcamera", "private"), { mode: 0o755, recursive: true }),
  ]);

  await resolveRepositoryPaths(project, {}, install);

  expect((await lstat(project)).mode & 0o777).toBe(0o755);
  expect((await lstat(join(project, "artifacts", "slopcamera", "recordings"))).mode & 0o777)
    .toBe(0o700);
  expect((await lstat(join(project, "artifacts", "slopcamera", "projects"))).mode & 0o777)
    .toBe(0o700);
  expect((await lstat(join(project, "artifacts", "slopcamera", "private"))).mode & 0o777)
    .toBe(0o700);
});

test("keeps machine-global state under the Slopcamera identity", () => {
  expect(defaultCliStateRoot("darwin", {})).toContain("/Slopcamera/cli");
  expect(defaultCliStateRoot("linux", {})).toEndWith("/slopcamera");
});

test("rejects a Slopcamera namespace symlink", async () => {
  const install = await repositoryFixture();
  const project = await mkdtemp(join(tmpdir(), "slopcamera-symlinked-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "slopcamera-outside-artifacts-"));
  temporaryRoots.push(project, outside);
  await mkdir(join(project, "artifacts"), { recursive: true });
  await symlink(outside, join(project, "artifacts", "slopcamera"));

  await expect(resolveRepositoryPaths(project, {}, install))
    .rejects.toThrow("Private directory requires physical components");
});
