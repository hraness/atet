import { expect, test } from "bun:test";
import { z } from "zod";

import { assertAppleSiliconMacosCompiledCliHost } from "./build-compiled";
import {
  daemonCommandFor,
  isEmbeddedVectorizeWorkerInvocation,
} from "./main";

test("self-spawns source and compiled CLI entrypoints without shell interpolation", () => {
  expect(daemonCommandFor("/opt/homebrew/bin/bun", "/repo/cli/main.ts"))
    .toEqual(["/opt/homebrew/bin/bun", "/repo/cli/main.ts"]);
  expect(daemonCommandFor("/repo/dist/transmute", "/$bunfs/root/cli/main.ts"))
    .toEqual(["/repo/dist/transmute"]);
  expect(daemonCommandFor("/repo/dist/transmute", "/repo/dist/transmute"))
    .toEqual(["/repo/dist/transmute"]);
});

test("accepts only the compiled bundle's exact internal vectorizer worker invocation", () => {
  expect(isEmbeddedVectorizeWorkerInvocation(
    ["/$bunfs/root/vectorize/worker.js"],
    "/$bunfs/root/cli/main.ts",
  )).toBe(true);
  expect(isEmbeddedVectorizeWorkerInvocation(
    ["/$bunfs/root/vectorize/worker.js", "extra"],
    "/$bunfs/root/cli/main.ts",
  )).toBe(false);
  expect(isEmbeddedVectorizeWorkerInvocation(
    ["/$bunfs/root/vectorize/worker.js"],
    "/repo/cli/main.ts",
  )).toBe(false);
});

test("keeps the copied native CLI behind its exact Apple Silicon macOS boundary", () => {
  expect(() => assertAppleSiliconMacosCompiledCliHost("darwin", "arm64"))
    .not.toThrow();
  expect(() => assertAppleSiliconMacosCompiledCliHost("linux", "x64"))
    .toThrow("Apple Silicon macOS artifact; received linux/x64");
  expect(() => assertAppleSiliconMacosCompiledCliHost("darwin", "x64"))
    .toThrow("Apple Silicon macOS artifact; received darwin/x64");
});

test("keeps portable and copied-native CLI builds as distinct manifest commands", async () => {
  const { scripts } = z.object({
    scripts: z.object({
      "build:desktop:cli": z.string(),
      "build:cli:macos": z.string(),
      "test:cli:compiled:macos": z.string(),
    }),
  }).parse(await Bun.file(new URL("../../../package.json", import.meta.url)).json());
  expect(scripts["build:desktop:cli"]).toBe(
    "bun -e 'await (await import(\"node:fs/promises\")).rm(\"./apps/desktop/dist/cli\", { recursive: true, force: true })' && bun build --target=bun --minify --sourcemap=none --packages external --external @hraness/transmute/cli apps/desktop/cli/main.ts --outdir apps/desktop/dist/cli",
  );
  expect(scripts["build:cli:macos"]).toBe("bun run ./apps/desktop/cli/build-compiled.ts");
  expect(scripts["test:cli:compiled:macos"]).toStartWith("bun run build:cli:macos &&");
});
