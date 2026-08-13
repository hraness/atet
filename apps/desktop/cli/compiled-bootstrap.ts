#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import embeddedLibvips from "@img/sharp-libvips-darwin-arm64/binary" with { type: "file" };

const NATIVE_ROOT_ENV = "TRANSMUTE_COMPILED_NATIVE_ROOT";

async function runChildWithNativeRuntime(): Promise<void> {
  const nativeRoot = join(tmpdir(), `transmute-native-${randomUUID()}`);
  const addonTemporaryRoot = join(nativeRoot, "tmp");
  const libvipsDirectory = join(
    nativeRoot,
    "node_modules",
    "@img",
    "sharp-libvips-darwin-arm64",
    "lib",
  );
  await mkdir(addonTemporaryRoot, { mode: 0o700, recursive: true });
  await mkdir(libvipsDirectory, { mode: 0o700, recursive: true });
  const libvipsPath = join(libvipsDirectory, "libvips-cpp.8.18.3.dylib");
  await writeFile(libvipsPath, await Bun.file(embeddedLibvips).bytes(), {
    flag: "wx",
    mode: 0o500,
  });
  const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
    env: {
      ...process.env,
      [NATIVE_ROOT_ENV]: nativeRoot,
      TMPDIR: addonTemporaryRoot,
    },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  const forwardInterrupt = (): void => child.kill("SIGINT");
  const forwardTermination = (): void => child.kill("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTermination);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
    await chmod(nativeRoot, 0o700).catch(() => undefined);
    await rm(nativeRoot, { force: true, recursive: true });
  }
}

if (process.env[NATIVE_ROOT_ENV] === undefined) {
  await runChildWithNativeRuntime();
} else {
  await import("./native-media-runtime.macos");
  const { runMainEntrypoint } = await import("./main");
  await runMainEntrypoint();
}
