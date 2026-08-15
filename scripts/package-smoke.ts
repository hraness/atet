import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";

const packageName = "@hraness/atet";
const importSpecifiers = [
  packageName,
  `${packageName}/cli`,
  `${packageName}/code`,
  `${packageName}/code/advanced`,
  `${packageName}/generate`,
  `${packageName}/host-resources`,
  `${packageName}/operations`,
  `${packageName}/workflow`,
  `${packageName}/scene`,
  `${packageName}/local/code`,
  `${packageName}/local/code/advanced`,
  `${packageName}/local/code/workflows`,
  `${packageName}/local/html-overlay`,
] as const;
const verificationPackages = [
  "@types/bun@^1.3.14",
  "@types/json-schema@^7.0.15",
  "@types/node@^24.10.0",
  "@types/react@^19.2.14",
  "@types/react-dom@^19.2.3",
  "ajv@8.17.1",
  "fast-check@^4.8.0",
  "react@19.2.3",
  "react-dom@19.2.3",
  "tldraw@5.2.5",
  "typescript@^6.0.3",
] as const;
const packageTextExtensions = new Set([
  ".c",
  ".conf",
  ".css",
  ".h",
  ".html",
  ".hpp",
  ".cjs",
  ".cpp",
  ".js",
  ".json",
  ".md",
  ".m",
  ".mm",
  ".mjs",
  ".plist",
  ".sh",
  ".swift",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zig",
  ".zon",
]);
const forbiddenPackageText = [
  { label: "private package", pattern: /@jungle\//u },
  { label: "private source path", pattern: /projects\/(?:atet|transmute)/u },
  { label: "private fixture path", pattern: /\/(?:tmp|work)\/jungle\//u },
  { label: "account database runtime", pattern: /(?:^|[^a-z])convex(?:[^a-z]|$)/iu },
  { label: "hosted auth runtime", pattern: /better-auth/iu },
  { label: "hosted account runtime", pattern: /suite[-_ ]accounts/iu },
  { label: "hosted account origin", pattern: /account\.hraness\.com/iu },
  { label: "legacy hosted API", pattern: /transmute\.rocks\/api/iu },
  { label: "legacy Graphics runtime", pattern: /graphics-compat/iu },
] as const;

async function scanPackedPackage(directory: string): Promise<void> {
  const problems: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      problems.push(`${path} is a symlink`);
      return;
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (!info.isFile()) return;
    const extension = /\.[^./]+$/u.exec(path)?.[0] ?? "";
    if (!packageTextExtensions.has(extension) && basename(path) !== "LICENSE") return;
    const text = await readFile(path, "utf8");
    for (const rule of forbiddenPackageText) {
      if (rule.pattern.test(text)) problems.push(`${path} contains ${rule.label}`);
    }
  }
  await visit(directory);
  if (problems.length > 0) {
    throw new Error(`Packed standalone boundary failed:\n${problems.sort().join("\n")}`);
  }
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
  }
}

async function runOutput(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: "inherit",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
  }
  return stdout;
}

async function runCaptured(
  command: string[],
  cwd: string,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${String(exitCode)}): ${command.join(" ")}\n${stderr}`,
    );
  }
  return { stderr, stdout };
}

async function runFailure(
  command: string[],
  cwd: string,
  expectedDiagnostic: string,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode === 0) {
    throw new Error(`Command unexpectedly succeeded: ${command.join(" ")}`);
  }
  if (!stderr.includes(expectedDiagnostic)) {
    throw new Error(
      `Command did not emit ${JSON.stringify(expectedDiagnostic)}: ${JSON.stringify({ stderr, stdout })}`,
    );
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

const repository = process.cwd();
const work = await mkdtemp(join(tmpdir(), "atet-package-smoke-"));
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
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await run([process.execPath, "add", archive, "--ignore-scripts"], consumer);
  const installedPackage = await realpath(
    join(consumer, "node_modules", "@hraness", "atet"),
  );
  await scanPackedPackage(installedPackage);
  await run([
    process.execPath,
    "-e",
    `await Promise.all(${JSON.stringify(importSpecifiers)}.map(specifier => import(specifier)))`,
  ], consumer);
  await run([
    join(consumer, "node_modules", ".bin", "atet"),
    "--help",
  ], consumer);
  await run([
    join(consumer, "node_modules", ".bin", "transmute"),
    "--help",
  ], consumer);
  const doctorText = await runOutput([
    join(consumer, "node_modules", ".bin", "atet"),
    "doctor",
    "--json",
  ], consumer);
  const doctor = record(JSON.parse(doctorText) as unknown, "atet doctor --json");
  const consumerRoot = await realpath(consumer);
  if (doctor.repositoryRoot !== consumerRoot) {
    throw new Error(
      `Packed CLI resolved repositoryRoot ${JSON.stringify(doctor.repositoryRoot)} instead of caller root ${JSON.stringify(consumerRoot)}.`,
    );
  }
  const packageJson = record(
    JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as unknown,
    "package.json",
  );
  if (doctor.version !== packageJson.version) {
    throw new Error(
      `Packed CLI reports version ${JSON.stringify(doctor.version)} instead of package version ${JSON.stringify(packageJson.version)}.`,
    );
  }
  const predecessorDoctor = await runCaptured([
    join(consumer, "node_modules", ".bin", "transmute"),
    "doctor",
    "--json",
  ], consumer);
  const predecessorDoctorJson = record(
    JSON.parse(predecessorDoctor.stdout) as unknown,
    "transmute doctor --json",
  );
  if (
    predecessorDoctorJson.repositoryRoot !== consumerRoot
    || predecessorDoctorJson.version !== packageJson.version
  ) {
    throw new Error("Packed predecessor CLI did not retain canonical doctor behavior.");
  }
  if (predecessorDoctor.stderr !== "transmute is deprecated; use atet.\n") {
    throw new Error(
      `Packed predecessor CLI warning drifted: ${JSON.stringify(predecessorDoctor.stderr)}`,
    );
  }
  const operationsText = await runOutput([
    join(consumer, "node_modules", ".bin", "atet"),
    "operations",
    "list",
    "--json",
  ], consumer);
  const operations = record(
    JSON.parse(operationsText) as unknown,
    "atet operations list --json",
  ).operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("Packed CLI returned no local operations.");
  }
  const semanticSearchText = await runOutput([
    join(consumer, "node_modules", ".bin", "atet"),
    "code",
    "search",
    "--limit",
    "1",
  ], consumer);
  const semanticOperations = record(
    JSON.parse(semanticSearchText) as unknown,
    "atet code search --limit 1",
  ).operations;
  if (!Array.isArray(semanticOperations) || semanticOperations.length !== 1) {
    throw new Error("Packed CLI did not delegate semantic code search.");
  }
  const skillPath = (await runOutput([
    join(consumer, "node_modules", ".bin", "atet"),
    "skill",
    "path",
  ], consumer)).trim();
  const installedSkill = await realpath(skillPath);
  if (!installedSkill.startsWith(`${installedPackage}${sep}`)) {
    throw new Error(`Packed CLI resolved a skill outside its install: ${skillPath}`);
  }
  const canvasStatus = record(JSON.parse(await runOutput([
    join(consumer, "node_modules", ".bin", "atet"),
    "canvas",
    "status",
  ], consumer)) as unknown, "atet canvas status");
  if (!("installedPath" in canvasStatus) || !("server" in canvasStatus)) {
    throw new Error("Packed CLI did not delegate canvas status.");
  }
  await runFailure([
    join(consumer, "node_modules", ".bin", "atet"),
    "mcp",
  ], consumer, "--root is required");
  await run([
    process.execPath,
    "add",
    ...verificationPackages,
    "--ignore-scripts",
  ], consumer);

  const imports = importSpecifiers
    .map((specifier, index) => `import * as surface${String(index)} from ${JSON.stringify(specifier)};`)
    .join("\n");
  const uses = importSpecifiers.map((_, index) => `surface${String(index)}`).join(", ");
  const predecessorTypeFixture = `
import { executeTransmuteOperationWithLease } from "@hraness/atet";
import {
  createTransmuteCodeHost,
  type TransmuteCodeExecutionRequest,
  type TransmuteCodeExecutor,
} from "@hraness/atet/code";
import {
  defineTransmuteWorkflow,
  type TransmuteWorkflowExecutor,
} from "@hraness/atet/workflow";

const predecessorRequest: TransmuteCodeExecutionRequest<"transmute.diagram.check"> = {
  input: { path: "diagram.json" },
  kind: "transmute.diagram.check",
  nodeKey: "check",
  version: 2,
};
const predecessorCodeExecutor = (async request => {
  if (request.kind === "transmute.diagram.check") {
    return { configPath: null, findings: [] };
  }
  throw new Error("fixture does not execute");
}) as TransmuteCodeExecutor;
const predecessorHost = createTransmuteCodeHost({ execute: predecessorCodeExecutor });
const predecessorWorkflowExecutor = (async code => {
  if (code === "transmute.diagram.check") {
    return { configPath: null, findings: [] };
  }
  throw new Error("fixture does not execute");
}) as TransmuteWorkflowExecutor;
const predecessorWorkflow = defineTransmuteWorkflow({
  id: "predecessor-consumer",
  version: 1,
  parseInput: value => value as { readonly path: string },
  run: (context, input) => context.operation(
    "check",
    "transmute.diagram.check",
    input,
  ),
});
if (surface0.atetApi !== surface0.diagramApi) {
  throw new Error("Deprecated diagramApi must be the canonical atetApi object.");
}
void [
  surface0.atetApi.defineAtetWorkflow,
  surface0.atetApi.runAtetWorkflow,
  surface0.diagramApi.executeTransmuteOperation,
  surface0.diagramApi.generateTransmuteImage,
  surface0.diagramApi.generateTransmuteImageFile,
  surface0.diagramApi.searchTransmuteOperations,
  surface0.diagramApi.transmuteGatewayCredentialStatus,
  surface0.diagramApi.transmuteMcpProtocolVersion,
  surface0.diagramApi.transmuteMcpServerName,
  surface0.diagramApi.transmuteMcpTools,
  surface0.diagramApi.transmuteOperationRegistry,
  surface0.diagramApi.TransmuteMcpToolRuntime,
  predecessorRequest,
  predecessorHost,
  predecessorWorkflow,
  predecessorWorkflowExecutor,
  executeTransmuteOperationWithLease,
];
`;
  await writeFile(
    join(consumer, "index.ts"),
    `${imports}\nvoid [${uses}];\n${predecessorTypeFixture}`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2023",
        types: ["bun", "node"],
      },
      include: ["index.ts"],
    }, null, 2)}\n`,
  );
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.json"], consumer);
} finally {
  await rm(work, { force: true, recursive: true });
}
