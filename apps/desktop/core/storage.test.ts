import { expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "./canonical-json";
import { operationTestProject } from "../application/operations/test-support";
import { testManifest } from "./test-support";
import {
  createNodeBundleFileSystem,
  loadRecordingManifest,
  loadVideoProject,
  saveRecordingManifest,
  saveVideoProject,
} from "./storage";

test("mutable bundle persistence preserves predecessor reads and writes canonical Atet", async () => {
  const files = new Map<string, string>();
  const fileSystem = {
    readText: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing fixture file: ${path}`);
      return value;
    },
    writeTextAtomic: async (path: string, contents: string) => {
      files.set(path, contents);
    },
  };
  const recording = testManifest();
  const project = operationTestProject();
  files.set("manifest.json", `${JSON.stringify({
    ...recording,
    kind: "transmute.recording-bundle",
    tool: { ...recording.tool, name: "transmute" },
  })}\n`);
  files.set("project.json", `${JSON.stringify({
    ...project,
    kind: "transmute.video-project",
  })}\n`);

  const loadedRecording = await loadRecordingManifest(fileSystem);
  const loadedProject = await loadVideoProject(fileSystem);
  expect({
    kind: loadedRecording.kind,
    tool: loadedRecording.tool.name,
  }).toEqual({ kind: "transmute.recording-bundle", tool: "transmute" });
  expect(loadedProject.kind).toBe("transmute.video-project");

  await saveRecordingManifest(fileSystem, {
    ...loadedRecording,
    kind: "studio.recording-bundle",
    tool: { ...loadedRecording.tool, name: "studio" },
  });
  await saveVideoProject(fileSystem, {
    ...loadedProject,
    kind: "studio.video-project",
  });
  expect(JSON.parse(files.get("manifest.json")!)).toMatchObject({
    kind: "atet.recording-bundle",
    tool: { name: "atet" },
  });
  expect(JSON.parse(files.get("project.json")!)).toMatchObject({
    kind: "atet.video-project",
  });
});

test.skipIf(process.platform === "win32")("bundle storage rejects symlink leaves and redirected parent directories", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-storage-path-test-"));
  const bundle = join(temporary, "bundle");
  const outside = join(temporary, "outside");
  try {
    await Promise.all([mkdir(bundle), mkdir(outside)]);
    const target = join(bundle, "actual.json");
    await writeFile(target, "{}\n");
    await symlink(target, join(bundle, "manifest.json"));
    const fileSystem = createNodeBundleFileSystem(bundle);

    let readFailure: unknown;
    try {
      await fileSystem.readText("manifest.json");
    } catch (error) {
      readFailure = error;
    }
    expect(String(readFailure)).toContain("physical regular file");

    await symlink(outside, join(bundle, "analysis"));
    let writeFailure: unknown;
    try {
      await fileSystem.writeTextAtomic("analysis/result.json", "{}\n");
    } catch (error) {
      writeFailure = error;
    }
    expect(String(writeFailure)).toContain("physical directories");
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("bundle inspection retries one hard-link cleanup and rejects repeated instability", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-storage-inspection-test-"));
  const bundle = join(temporary, "bundle");
  try {
    await mkdir(bundle);
    const destination = join(bundle, "published.mp4");
    const firstStage = join(bundle, ".atet-copy-first.tmp");
    const secondStage = join(bundle, ".atet-copy-second.tmp");
    const source = "verified delivery bytes";
    await writeFile(destination, source);
    await Promise.all([
      link(destination, firstStage),
      link(destination, secondStage),
    ]);
    const attempts: number[] = [];
    const fileSystem = createNodeBundleFileSystem(bundle, {
      duringFileInspectionForTesting: async ({ attempt }) => {
        attempts.push(attempt);
        await rm(attempt === 1 ? firstStage : secondStage);
      },
    });

    expect(fileSystem.inspectFile!("published.mp4"))
      .rejects.toThrow(/changed while it was inspected/u);
    expect(attempts).toEqual([1, 2]);
    expect(await readFile(destination, "utf8")).toBe(source);

    const originalMode = (await lstat(destination)).mode & 0o777;
    const changedMode = originalMode === 0o600 ? 0o640 : 0o600;
    await link(destination, firstStage);
    attempts.length = 0;
    const metadataChangedFileSystem = createNodeBundleFileSystem(bundle, {
      duringFileInspectionForTesting: async ({ attempt }) => {
        attempts.push(attempt);
        await chmod(destination, changedMode);
        await rm(firstStage);
      },
    });
    expect(metadataChangedFileSystem.inspectFile!("published.mp4"))
      .rejects.toThrow(/changed while it was inspected/u);
    expect(attempts).toEqual([1]);
    await chmod(destination, originalMode);

    attempts.length = 0;
    const mutatedFileSystem = createNodeBundleFileSystem(bundle, {
      duringFileInspectionForTesting: async ({ attempt }) => {
        attempts.push(attempt);
        await writeFile(destination, "different bytes");
      },
    });
    expect(mutatedFileSystem.inspectFile!("published.mp4"))
      .rejects.toThrow(/changed while it was inspected/u);
    expect(attempts).toEqual([1]);

    await writeFile(destination, source);
    await link(destination, firstStage);
    attempts.length = 0;
    const stableFileSystem = createNodeBundleFileSystem(bundle, {
      duringFileInspectionForTesting: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) await rm(firstStage);
      },
    });
    expect(await stableFileSystem.inspectFile!("published.mp4")).toEqual({
      bytes: new TextEncoder().encode(source).byteLength,
      sha256: sha256Hex(source),
    });
    expect(attempts).toEqual([1, 2]);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("bundle inspection rejects a destination unlinked during hard-link cleanup", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-storage-unlink-test-"));
  const bundle = join(temporary, "bundle");
  try {
    await mkdir(bundle);
    const destination = join(bundle, "published.mp4");
    const stage = join(bundle, ".atet-copy-stage.tmp");
    const source = "verified delivery bytes";
    await writeFile(destination, source);
    await link(destination, stage);
    const attempts: number[] = [];
    const fileSystem = createNodeBundleFileSystem(bundle, {
      duringFileInspectionForTesting: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) await rm(destination);
      },
    });

    expect(fileSystem.inspectFile!("published.mp4"))
      .rejects.toThrow(/changed while it was inspected/u);
    expect(attempts).toEqual([1]);
    expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(stage, "utf8")).toBe(source);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("bundle inspection rejects a different-inode destination replacement", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-storage-replacement-test-"));
  const bundle = join(temporary, "bundle");
  try {
    await mkdir(bundle);
    const destination = join(bundle, "published.mp4");
    const stage = join(bundle, ".atet-copy-stage.tmp");
    const source = "verified delivery bytes";
    const replacement = "replacement delivery bytes";
    await writeFile(destination, source);
    const original = await lstat(destination);
    await link(destination, stage);
    const attempts: number[] = [];
    const fileSystem = createNodeBundleFileSystem(bundle, {
      duringFileInspectionForTesting: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) {
          await rm(destination);
          await writeFile(destination, replacement);
        }
      },
    });

    expect(fileSystem.inspectFile!("published.mp4"))
      .rejects.toThrow(/changed while it was inspected/u);
    expect(attempts).toEqual([1]);
    const installed = await lstat(destination);
    expect({ dev: installed.dev, ino: installed.ino }).not.toEqual({
      dev: original.dev,
      ino: original.ino,
    });
    expect(await readFile(destination, "utf8")).toBe(replacement);
    expect(await readFile(stage, "utf8")).toBe(source);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("immutable bundle copies publish atomically and preserve no-replace recovery", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-storage-copy-test-"));
  const bundle = join(temporary, "bundle");
  try {
    await mkdir(bundle);
    const source = "verified delivery bytes";
    await writeFile(join(bundle, "renders-source.mp4"), source);
    const fileSystem = createNodeBundleFileSystem(bundle);
    const expected = {
      bytes: new TextEncoder().encode(source).byteLength,
      sha256: sha256Hex(source),
    };
    expect(await fileSystem.copyFileNoReplace!(
      "renders-source.mp4",
      "renders/deliveries/final.mp4",
      expected,
    )).toBe("created");
    expect(await fileSystem.copyFileNoReplace!(
      "renders-source.mp4",
      "renders/deliveries/final.mp4",
      expected,
    )).toBe("exists");
    expect(await readFile(
      join(bundle, "renders/deliveries/final.mp4"),
      "utf8",
    )).toBe(source);

    const concurrent = await Promise.all([
      fileSystem.copyFileNoReplace!(
        "renders-source.mp4",
        "renders/deliveries/concurrent.mp4",
        expected,
      ),
      fileSystem.copyFileNoReplace!(
        "renders-source.mp4",
        "renders/deliveries/concurrent.mp4",
        expected,
      ),
    ]);
    expect(concurrent.toSorted()).toEqual(["created", "exists"]);
    expect(await readFile(
      join(bundle, "renders/deliveries/concurrent.mp4"),
      "utf8",
    )).toBe(source);
    expect((await readdir(join(bundle, "renders/deliveries"))).some(
      name => name.startsWith(".atet-copy-"),
    )).toBe(false);

    const wrong = { ...expected, sha256: "f".repeat(64) };
    expect(fileSystem.copyFileNoReplace!(
      "renders-source.mp4",
      "renders/deliveries/failed.mp4",
      wrong,
    )).rejects.toThrow(/failed verification/u);
    expect(lstat(join(bundle, "renders/deliveries/failed.mp4")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(bundle, "renders/deliveries"))).some(
      name => name.startsWith(".atet-copy-"),
    )).toBe(false);

    // Model a process killed after writing only its private staging inode.
    // An unpublished partial copy must not reserve or expose the final path.
    const interruptedStage = join(
      bundle,
      "renders/deliveries/.atet-copy-00000000-0000-4000-8000-000000000000.tmp",
    );
    await writeFile(interruptedStage, "partial copy", { mode: 0o600 });
    expect(lstat(join(bundle, "renders/deliveries/recovered.mp4")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await fileSystem.copyFileNoReplace!(
      "renders-source.mp4",
      "renders/deliveries/recovered.mp4",
      expected,
    )).toBe("created");
    expect(await readFile(
      join(bundle, "renders/deliveries/recovered.mp4"),
      "utf8",
    )).toBe(source);
    expect(await readFile(interruptedStage, "utf8")).toBe("partial copy");
    await rm(interruptedStage);

    await writeFile(join(bundle, "renders/deliveries/occupied.mp4"), "other");
    expect(fileSystem.copyFileNoReplace!(
      "renders-source.mp4",
      "renders/deliveries/occupied.mp4",
      expected,
    )).rejects.toThrow(/different bytes/u);
    expect(await readFile(
      join(bundle, "renders/deliveries/occupied.mp4"),
      "utf8",
    )).toBe("other");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
