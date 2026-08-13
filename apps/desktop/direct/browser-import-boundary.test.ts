import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const sdkSourceRoot = resolve(desktopRoot, "../../src");
const sceneSourceRoot = resolve(desktopRoot, "../../packages/scene/src");
const supportedSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const nodeBuiltins = new Set(builtinModules.flatMap(specifier => (
  specifier.startsWith("node:")
    ? [specifier]
    : [specifier, `node:${specifier}`]
)));

interface ImportParent {
  readonly importer: string;
  readonly specifier: string;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function displayPath(path: string): string {
  if (within(desktopRoot, path)) return relative(desktopRoot, path);
  if (within(sdkSourceRoot, path)) {
    return `@hraness/transmute/${relative(sdkSourceRoot, path)}`;
  }
  if (within(sceneSourceRoot, path)) {
    return `@hraness/transmute/scene/${relative(sceneSourceRoot, path)}`;
  }
  return path;
}

function browserImportChain(
  entry: string,
  importer: string,
  specifier: string,
  parents: ReadonlyMap<string, ImportParent>,
): string {
  const chain = [`${displayPath(importer)} -> ${specifier}`];
  let current = importer;
  while (current !== entry) {
    const parent = parents.get(current);
    if (parent === undefined) break;
    chain.unshift(`${displayPath(parent.importer)} -> ${parent.specifier}`);
    current = parent.importer;
  }
  return chain.join("\n");
}

async function browserImportBoundary(entry: string): Promise<Readonly<{
  failures: readonly string[];
  modules: readonly string[];
}>> {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const pending = [entry];
  const visited = new Set<string>();
  const parents = new Map<string, ImportParent>();
  const failures: string[] = [];
  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    for (const imported of transpiler.scanImports(await readFile(sourcePath))) {
      const specifier = imported.path;
      if (nodeBuiltins.has(specifier)) {
        failures.push(browserImportChain(
          entry,
          sourcePath,
          specifier,
          parents,
        ));
        continue;
      }
      if (
        !specifier.startsWith(".")
        && !specifier.startsWith("@hraness/transmute")
      ) continue;
      const resolved = await Bun.resolve(specifier, dirname(sourcePath));
      if (
        !within(desktopRoot, resolved)
        && !within(sdkSourceRoot, resolved)
        && !within(sceneSourceRoot, resolved)
      ) {
        failures.push(`${displayPath(sourcePath)} escapes the browser source roots through ${specifier}`);
        continue;
      }
      if (!supportedSourceExtensions.has(extname(resolved))) continue;
      if (!parents.has(resolved)) {
        parents.set(resolved, { importer: sourcePath, specifier });
      }
      pending.push(resolved);
    }
  }
  return {
    failures: failures.sort(),
    modules: [...visited]
      .map(displayPath)
      .sort(),
  };
}

test("the Direct browser graph cannot reach host-only Node modules", async () => {
  const entry = resolve(import.meta.dir, "main.tsx");
  const boundary = await browserImportBoundary(entry);
  expect(boundary.modules).toContain("direct/workflow-fixtures.ts");
  expect(boundary.modules).toContain("code/semantic-builder.ts");
  expect(boundary.modules).toContain(
    "@hraness/transmute/code/compiler.ts",
  );
  expect(boundary.failures).toEqual([]);
});
