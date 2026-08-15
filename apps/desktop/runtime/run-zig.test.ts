import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { zigArgumentsWithWorkerBudget } from "./run-zig";

test("the ejected desktop build resolves the root-owned Native SDK package", async () => {
  const source = await readFile(resolve(import.meta.dir, "..", "build.zig"), "utf8");

  expect(source).toContain(
    'const default_native_sdk_path = "../../node_modules/@native-sdk/cli";',
  );
  expect(source).not.toContain(
    'const default_native_sdk_path = "node_modules/@native-sdk/cli";',
  );
  expect(source).toContain("package_exe.root_module.strip = true;");
});

test("caps uncapped Zig builds at the admitted worker budget", () => {
  expect(zigArgumentsWithWorkerBudget(
    ["build", "test", "-Dplatform=macos"],
    { ATET_WORKER_BUDGET: "3" },
  )).toEqual(["build", "-j3", "test", "-Dplatform=macos"]);
});

test("preserves non-build and explicitly capped Zig commands", () => {
  expect(zigArgumentsWithWorkerBudget(
    ["version"],
    { ATET_WORKER_BUDGET: "3" },
  )).toEqual(["version"]);
  expect(zigArgumentsWithWorkerBudget(
    ["build", "-j2", "test"],
    { ATET_WORKER_BUDGET: "3" },
  )).toEqual(["build", "-j2", "test"]);
  expect(zigArgumentsWithWorkerBudget(["build", "test"], {}))
    .toEqual(["build", "test"]);
});

test("rejects malformed scheduler worker budgets", () => {
  expect(() => zigArgumentsWithWorkerBudget(
    ["build"],
    { ATET_WORKER_BUDGET: "0" },
  )).toThrow("ATET_WORKER_BUDGET must be a positive integer");
  expect(() => zigArgumentsWithWorkerBudget(
    ["build"],
    { ATET_WORKER_BUDGET: "many" },
  )).toThrow("ATET_WORKER_BUDGET must be a positive integer");
});
