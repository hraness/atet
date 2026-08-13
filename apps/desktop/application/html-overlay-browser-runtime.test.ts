import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { ExactCapabilityBinding } from "./capability-binding";
import {
  bindHtmlOverlayBrowserRuntime,
  inspectHtmlOverlayBrowserRuntime,
} from "./html-overlay-browser-runtime";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<{
  readonly binding: ExactCapabilityBinding;
  readonly executable: string;
  readonly resource: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "transmute-browser-runtime-"));
  roots.push(root);
  const bundle = join(root, "Fixture.app");
  const executable = join(bundle, "Contents", "MacOS", "Fixture");
  const framework = join(bundle, "Contents", "Frameworks", "Fixture.framework");
  const version = join(framework, "Versions", "1");
  const resource = join(version, "Resources", "snapshot.bin");
  await mkdir(join(version, "Helpers"), { mode: 0o755, recursive: true });
  await mkdir(join(version, "Libraries", "SwiftShader"), {
    mode: 0o755,
    recursive: true,
  });
  await mkdir(join(bundle, "Contents", "MacOS"), { mode: 0o755, recursive: true });
  await mkdir(join(version, "Resources"), { mode: 0o755, recursive: true });
  const executableBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  await writeFile(executable, executableBytes, { mode: 0o755 });
  await chmod(executable, 0o755);
  await writeFile(join(version, "Helpers", "helper"), "helper", { mode: 0o755 });
  await chmod(join(version, "Helpers", "helper"), 0o755);
  await writeFile(resource, "snapshot", { mode: 0o644 });
  await writeFile(
    join(version, "Libraries", "SwiftShader", "libvk.dylib"),
    "swiftshader",
    { mode: 0o644 },
  );
  await symlink("1", join(framework, "Versions", "Current"));
  await symlink("Versions/Current/Resources", join(framework, "Resources"));
  return {
    binding: {
      bytes: executableBytes.byteLength,
      command: executable,
      executablePath: executable,
      executableSha256: digest(executableBytes),
      name: "html-browser",
      version: "fixture",
    },
    executable,
    resource,
    root,
  };
}

describe("complete HTML-overlay browser runtime binding", () => {
  test("binds helpers, resources, snapshots, SwiftShader, modes, and internal links", async () => {
    const item = await fixture();
    const runtime = await bindHtmlOverlayBrowserRuntime(
      item.binding,
      undefined,
      { allowUnverifiedRuntimeForTesting: true },
    );
    expect(runtime.manifest.layout).toBe("macos-app-bundle");
    expect(runtime.manifest.entries.map(entry => entry.path)).toEqual(
      [...runtime.manifest.entries.map(entry => entry.path)].sort(),
    );
    expect(runtime.manifest.entries.some(entry => (
      entry.kind === "file"
      && entry.mode === 0o755
      && entry.path === "Contents/MacOS/Fixture"
    ))).toBe(true);
    for (const suffix of [
      "Helpers/helper",
      "Resources/snapshot.bin",
      "SwiftShader/libvk.dylib",
    ]) {
      expect(runtime.manifest.entries.some(entry => (
        entry.kind === "file" && entry.path.endsWith(suffix)
      ))).toBe(true);
    }
    expect(runtime.manifest.entries.some(entry => (
      entry.kind === "symlink"
      && entry.path.includes("Versions/Current")
      && entry.target === "1"
    ))).toBe(true);
    const baseline = runtime.manifest.rootSha256;
    await writeFile(item.resource, "changed snapshot");
    const changed = await inspectHtmlOverlayBrowserRuntime(
      runtime.sourceRoot,
      runtime.manifest.layout,
      runtime.manifest.executableRelativePath,
    );
    expect(changed.rootSha256).not.toBe(baseline);
  });

  test("rejects a relative link whose resolved target leaves the copied root", async () => {
    const item = await fixture();
    await symlink(
      "../../../outside",
      join(item.root, "Fixture.app", "Contents", "escaping-link"),
    );
    expect(bindHtmlOverlayBrowserRuntime(
      item.binding,
      undefined,
      { allowUnverifiedRuntimeForTesting: true },
    )).rejects.toThrow(
      /symlink escapes/u,
    );
  });

  test("rejects a standalone or wrapper executable as an incomplete browser runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-browser-wrapper-"));
    roots.push(root);
    const executable = join(root, "browser-wrapper");
    const bytes = Buffer.from("#!/bin/sh\nexec /Applications/Other.app/Contents/MacOS/Other\n");
    await writeFile(executable, bytes, { mode: 0o755 });
    await chmod(executable, 0o755);
    expect(bindHtmlOverlayBrowserRuntime({
      bytes: bytes.byteLength,
      command: executable,
      executablePath: executable,
      executableSha256: digest(bytes),
      name: "html-browser",
      version: "wrapper fixture",
    })).rejects.toThrow(/wrapper and unbound distribution launchers/u);
  });

  test("rejects an app-shaped shell wrapper without trusted native provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-browser-shaped-wrapper-"));
    roots.push(root);
    const executable = join(root, "Fake.app", "Contents", "MacOS", "Fake");
    const bytes = Buffer.from("#!/bin/sh\nexec /Applications/Other.app/Contents/MacOS/Other\n");
    await mkdir(join(root, "Fake.app", "Contents", "MacOS"), {
      mode: 0o755,
      recursive: true,
    });
    await writeFile(executable, bytes, { mode: 0o755 });
    await chmod(executable, 0o755);
    expect(bindHtmlOverlayBrowserRuntime({
      bytes: bytes.byteLength,
      command: executable,
      executablePath: executable,
      executableSha256: digest(bytes),
      name: "html-browser",
      version: "shaped wrapper fixture",
    })).rejects.toThrow(/not a native Mach-O/u);
  });

  test("detects replace-and-restore while signed provenance is observed", async () => {
    const item = await fixture();
    expect(bindHtmlOverlayBrowserRuntime(
      item.binding,
      undefined,
      {
        allowUnverifiedRuntimeForTesting: true,
        duringProvenanceInspectionForTesting: async () => {
          await writeFile(item.resource, "substitute during provenance");
          await writeFile(item.resource, "snapshot");
        },
      },
    )).rejects.toThrow(/changed while its signed provenance was verified/u);
  });
});
