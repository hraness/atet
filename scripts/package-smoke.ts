import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@hraness/transmute";
const importSpecifiers = ["@hraness/transmute","@hraness/transmute/auth","@hraness/transmute/code","@hraness/transmute/code/advanced","@hraness/transmute/discovery","@hraness/transmute/generate","@hraness/transmute/host-resources","@hraness/transmute/operations","@hraness/transmute/workflow"];
const binNames = ["graphics","transmute"];
const verificationPackages = ["@types/bun@^1.3.14","ajv@8.17.1","fast-check@^4.8.0","react@19.2.3","react-dom@19.2.3","tldraw@5.2.5","typescript@^6.0.3"];

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

const repository = process.cwd();
const work = await mkdtemp(join(tmpdir(), "hraness-package-smoke-"));
try {
  const archive = join(work, "package.tgz");
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await run([
    process.execPath,
    "pm",
    "pack",
    "--filename",
    archive,
    "--ignore-scripts",
    "--quiet",
  ], repository);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run([process.execPath, "add", archive, "--ignore-scripts"], consumer);
  await run(["node", "--input-type=module", "-e", `await import(${JSON.stringify(packageName)})`], consumer);
  for (const binName of binNames) {
    await run([join(consumer, "node_modules", ".bin", binName), "--help"], consumer);
  }
  if (verificationPackages.length > 0) {
    await run([process.execPath, "add", ...verificationPackages, "--ignore-scripts"], consumer);
  }
  await run([
    "node",
    "--input-type=module",
    "-e",
    `await Promise.all(${JSON.stringify(importSpecifiers)}.map((specifier) => import(specifier)))`,
  ], consumer);
  await writeFile(join(consumer, "index.ts"), "import * as surface0 from \"@hraness/transmute\";\nimport * as surface1 from \"@hraness/transmute/auth\";\nimport * as surface2 from \"@hraness/transmute/code\";\nimport * as surface3 from \"@hraness/transmute/code/advanced\";\nimport * as surface4 from \"@hraness/transmute/discovery\";\nimport * as surface5 from \"@hraness/transmute/generate\";\nimport * as surface6 from \"@hraness/transmute/host-resources\";\nimport * as surface7 from \"@hraness/transmute/operations\";\nimport * as surface8 from \"@hraness/transmute/workflow\";\nvoid [surface0, surface1, surface2, surface3, surface4, surface5, surface6, surface7, surface8];\n");
  await writeFile(join(consumer, "tsconfig.bundler.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"Preserve\",\n    \"moduleResolution\": \"Bundler\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);

} finally {
  await rm(work, { recursive: true, force: true });
}
