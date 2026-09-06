import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { Effect } from "effect";
import { z } from "zod";
import { OperationRegistry } from "../application/registry";
import type { OperationExecutionContext } from "../application/operation";

const root = resolve(import.meta.dirname, "../../..");

function sourceDependencies(entry: string): Set<string> {
  const configPath = resolve(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, file => ts.sys.readFile(file));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const packages = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = ts.sys.readFile(file);
    if (text === undefined) throw new Error(`Missing graph file: ${file}`);
    const imports = ts.preProcessFile(text, true, true).importedFiles;
    for (const imported of imports) {
      const specifier = imported.fileName;
      if (specifier === "effect" || specifier.startsWith("effect/")) packages.add(specifier);
      const resolved = ts.resolveModuleName(specifier, file, parsed.options, ts.sys).resolvedModule;
      if (resolved !== undefined && !resolved.isExternalLibraryImport) visit(resolved.resolvedFileName);
    }
  };
  visit(resolve(root, entry));
  return packages;
}

test("portable graph and authoring type graphs do not acquire an Effect dependency", () => {
  for (const entry of ["src/workflow.ts", "src/code/index.ts", "src/code/advanced.ts"]) {
    expect([...sourceDependencies(entry)]).toEqual([]);
  }
});

const context: OperationExecutionContext = {
  abortSignal: new AbortController().signal,
  application: {
    capabilities: () => Promise.resolve([]),
    capability: name => Promise.resolve({ available: false, name }),
    clock: { now: () => new Date(0), timestampMilliseconds: () => 0 },
    paths: { artifactRoot: "/artifacts", desktopRoot: "/desktop", privateRoot: "/private", projectRoot: "/projects", repositoryRoot: dirname(root) },
    runner: { run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }) },
  },
};

test("the registry composes native execution and preserves its Promise and discovery contracts", async () => {
  const registry = new OperationRegistry();
  let executions = 0;
  registry.register({
    kind: "derive.edit-batch", version: 1,
    inputSchemaId: "test.input/v1", outputSchemaId: "test.output/v1",
    inputSchema: z.number(), outputSchema: z.number(),
    lifecycle: {
      kind: "pure",
      execute: () => Promise.reject(new Error("legacy execution must not run")),
      executeEffect: (_context, input) => Effect.sync(() => { executions += 1; return input * 2; }),
    },
    policy: { cache: "none", cancellable: true, effect: "pure", maxDurationMs: 100, maxFanOut: 0, maxInputBytes: 100, maxOutputBytes: 100, preparation: [], resources: [], resume: "deterministic" },
    summarize: output => ({ kind: "derive.edit-batch", fields: { value: output } }),
  });
  const operation = registry.get("derive.edit-batch", 1);
  const native = operation.executeEffect;
  if (native === undefined) throw new Error("Native program missing");
  expect((await Effect.runPromise(native(context, 2))).output).toBe(4);
  expect((await operation.execute(context, 3)).output).toBe(6);
  expect(executions).toBe(2);
  expect(Object.keys(operation.discovery).sort()).toEqual(["inputSchemaId", "kind", "lifecycle", "outputSchemaId", "policy", "version"]);
});
