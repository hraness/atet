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
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

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
const nodeImportSpecifiers = importSpecifiers.slice(0, 8);
const maximumPackedFiles = 350;
const maximumPackedBytes = 2_750_000;
const maximumUnpackedBytes = 7_500_000;
const requiredPackedPaths = [
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "SECURITY.md",
  "apps/desktop/analysis/protocol.ts",
  "apps/desktop/capture/protocol.ts",
  "apps/desktop/code/worker-entry.ts",
  "apps/desktop/code/worker-lease-guardian.ts",
  "apps/desktop/code/worker-process-identity.ts",
  "apps/desktop/dist/cli/main.js",
  "package.json",
  "schema/diagram.schema.json",
  "skills/atet/SKILL.md",
  "skills/atet/references/rubber-stamp-examples/poster-example-1.jpg",
  "skills/atet/references/rubber-stamp-examples/stamp-style-1.png",
  "skills/atet/scripts/compose-rubber-stamp-field-note.ts",
] as const;
const forbiddenPackedPaths = [
  { label: "repository agent guide", pattern: /(?:^|\/)AGENTS\.md$/u },
  { label: "test source", pattern: /\.test\.[cm]?[jt]sx?$/u },
  { label: "test support", pattern: /(?:^|\/)test-support\.[cm]?[jt]sx?$/u },
  {
    label: "desktop capture build tree",
    pattern: /^apps\/desktop\/capture\/(?!protocol\.ts$)/u,
  },
  { label: "Direct workbench", pattern: /^apps\/desktop\/direct\//u },
  { label: "frontend workbench", pattern: /^apps\/desktop\/frontend\//u },
  { label: "native runtime build tree", pattern: /^apps\/desktop\/runtime\//u },
  { label: "native shell source", pattern: /^apps\/desktop\/src\//u },
  { label: "property-test support", pattern: /^apps\/desktop\/testing\//u },
  { label: "development example", pattern: /^examples\//u },
  { label: "native application manifest", pattern: /^apps\/desktop\/app\.zon$/u },
  { label: "native build graph", pattern: /^apps\/desktop\/build\.zig(?:\.zon)?$/u },
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
  { label: "private source path", pattern: /projects\/atet/u },
  { label: "private fixture path", pattern: /\/(?:tmp|work)\/jungle\//u },
  { label: "account database runtime", pattern: /(?:^|[^a-z])convex(?:[^a-z]|$)/iu },
  { label: "hosted auth runtime", pattern: /better-auth/iu },
  { label: "hosted account runtime", pattern: /suite[-_ ]accounts/iu },
  { label: "hosted account origin", pattern: /account\.hraness\.com/iu },
  { label: "legacy Graphics runtime", pattern: /graphics-compat/iu },
] as const;

interface PackedPackageStats {
  readonly fileCount: number;
  readonly paths: ReadonlySet<string>;
  readonly unpackedBytes: number;
}

interface NpmPackResult {
  readonly entryCount: number;
  readonly filename: string;
  readonly name: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly version: string;
}

async function scanPackedPackage(directory: string): Promise<PackedPackageStats> {
  const problems: string[] = [];
  const paths = new Set<string>();
  let unpackedBytes = 0;
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
    const packedPath = relative(directory, path).split(sep).join("/");
    paths.add(packedPath);
    unpackedBytes += info.size;
    for (const rule of forbiddenPackedPaths) {
      if (rule.pattern.test(packedPath)) {
        problems.push(`${packedPath} contains ${rule.label}`);
      }
    }
    const extension = /\.[^./]+$/u.exec(path)?.[0] ?? "";
    if (!packageTextExtensions.has(extension) && basename(path) !== "LICENSE") return;
    const text = await readFile(path, "utf8");
    for (const rule of forbiddenPackageText) {
      if (rule.pattern.test(text)) problems.push(`${path} contains ${rule.label}`);
    }
  }
  await visit(directory);
  for (const required of requiredPackedPaths) {
    if (!paths.has(required)) problems.push(`${required} is missing from the packed package`);
  }
  if (paths.size > maximumPackedFiles) {
    problems.push(
      `packed package has ${String(paths.size)} files; maximum is ${String(maximumPackedFiles)}`,
    );
  }
  if (unpackedBytes > maximumUnpackedBytes) {
    problems.push(
      `packed package is ${String(unpackedBytes)} unpacked bytes; maximum is ${String(maximumUnpackedBytes)}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`Packed standalone boundary failed:\n${problems.sort().join("\n")}`);
  }
  return { fileCount: paths.size, paths, unpackedBytes };
}

async function run(
  command: string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
  }
}

async function runOutput(
  command: string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
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

async function runFailure(
  command: string[],
  cwd: string,
  expectedDiagnostic: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
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

async function existingFile(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && Reflect.get(error, "code") === "ENOENT"
  );
}

async function resolvePackedImport(
  packageRoot: string,
  manifest: Record<string, unknown>,
  importer: string,
  specifier: string,
): Promise<string | undefined> {
  let unresolved: string;
  if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
    const exports = record(manifest.exports, "package.json exports");
    const key = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
    const targetValue = exports[key];
    if (typeof targetValue === "string") unresolved = resolve(packageRoot, targetValue);
    else {
      const target = record(targetValue, `package.json exports ${key}`);
      if (typeof target.import !== "string") return undefined;
      unresolved = resolve(packageRoot, target.import);
    }
  } else {
    if (!specifier.startsWith(".")) return undefined;
    unresolved = resolve(dirname(importer), specifier);
  }

  const candidates = [unresolved];
  const extension = extname(unresolved);
  if (extension === ".js") {
    candidates.push(`${unresolved.slice(0, -3)}.ts`, `${unresolved.slice(0, -3)}.tsx`);
  }
  if (extension.length === 0) {
    candidates.push(
      `${unresolved}.ts`,
      `${unresolved}.tsx`,
      `${unresolved}.js`,
      `${unresolved}.json`,
      join(unresolved, "index.ts"),
      join(unresolved, "index.tsx"),
      join(unresolved, "index.js"),
    );
  }
  return await existingFile(candidates);
}

async function verifyPackedRuntimeClosure(
  packageRoot: string,
  stats: PackedPackageStats,
): Promise<void> {
  const manifest = record(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as unknown,
    "packed package.json",
  );
  const entryTargets = new Set<string>();
  for (const [key, value] of Object.entries(record(manifest.exports, "package.json exports"))) {
    if (typeof value === "string") entryTargets.add(value);
    else {
      for (const target of Object.values(record(value, `package.json exports ${key}`))) {
        if (typeof target === "string") entryTargets.add(target);
      }
    }
  }
  for (const value of Object.values(record(manifest.bin, "package.json bin"))) {
    if (typeof value === "string") entryTargets.add(value);
  }
  if (typeof manifest.main === "string") entryTargets.add(manifest.main);
  if (typeof manifest.types === "string") entryTargets.add(manifest.types);
  if (!Array.isArray(manifest.sideEffects)) {
    throw new Error("packed package.json sideEffects must be an array.");
  }
  for (const sideEffect of manifest.sideEffects) {
    if (typeof sideEffect !== "string") {
      throw new Error("packed package.json sideEffects entries must be strings.");
    }
    entryTargets.add(sideEffect);
  }

  const problems: string[] = [];
  for (const target of entryTargets) {
    const targetPath = target.replace(/^\.\//u, "");
    if (!stats.paths.has(targetPath)) problems.push(`package entry target ${target} is missing`);
  }

  for (const packedPath of [...stats.paths].sort()) {
    const extension = extname(packedPath);
    if (![".cjs", ".js", ".mjs", ".ts", ".tsx"].includes(extension)) continue;
    const absolutePath = join(packageRoot, packedPath);
    const loader = extension === ".tsx" ? "tsx" : extension === ".ts" ? "ts" : "js";
    const source = (await readFile(absolutePath, "utf8")).replace(/^#![^\n]*(?:\n|$)/u, "");
    for (const imported of new Bun.Transpiler({ loader }).scanImports(source)) {
      if (!imported.path.startsWith(".") && !imported.path.startsWith(packageName)) continue;
      const resolvedImport = await resolvePackedImport(
        packageRoot,
        manifest,
        absolutePath,
        imported.path,
      );
      if (resolvedImport === undefined) {
        problems.push(`${packedPath} has unresolved packed import ${imported.path}`);
        continue;
      }
      const relativeImport = relative(packageRoot, resolvedImport);
      if (
        relativeImport === ".."
        || relativeImport.startsWith(`..${sep}`)
        || isAbsolute(relativeImport)
      ) {
        problems.push(`${packedPath} resolves ${imported.path} outside the package`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Packed runtime closure failed:\n${problems.sort().join("\n")}`);
  }
}

function parseNpmPackResult(value: unknown): NpmPackResult {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("npm pack must report exactly one package.");
  }
  const result = record(value[0], "npm pack result");
  for (const field of ["entryCount", "size", "unpackedSize"] as const) {
    if (!Number.isSafeInteger(result[field]) || Number(result[field]) < 0) {
      throw new Error(`npm pack result ${field} must be a nonnegative safe integer.`);
    }
  }
  for (const field of ["filename", "name", "version"] as const) {
    if (typeof result[field] !== "string" || result[field].length === 0) {
      throw new Error(`npm pack result ${field} must be a nonempty string.`);
    }
  }
  return result as unknown as NpmPackResult;
}

async function createNpmArchive(
  repository: string,
  packDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly archive: string; readonly result: NpmPackResult }> {
  await mkdir(packDirectory, { recursive: true });
  const output = await runOutput([
    "npm",
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDirectory,
  ], repository, environment);
  const result = parseNpmPackResult(JSON.parse(output) as unknown);
  return { archive: join(packDirectory, result.filename), result };
}

const repository = process.cwd();
if (process.argv.length > 3) {
  throw new Error("Usage: bun scripts/package-smoke.ts [package.tgz]");
}
const providedArchive = process.argv[2] === undefined
  ? undefined
  : resolve(repository, process.argv[2]);
const work = await mkdtemp(join(tmpdir(), "atet-package-smoke-"));
try {
  const packageEnvironment = {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: join(work, "bun-cache"),
    TMPDIR: work,
    npm_config_cache: join(work, "npm-cache"),
  };
  const packed = providedArchive === undefined
    ? await createNpmArchive(repository, join(work, "pack"), packageEnvironment)
    : undefined;
  const archive = packed?.archive ?? providedArchive;
  if (archive === undefined) throw new Error("Packed archive path is unavailable.");
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.size === 0) {
    throw new Error(`Packed archive is not a nonempty regular file: ${archive}`);
  }
  if (archiveInfo.size > maximumPackedBytes) {
    throw new Error(
      `Packed archive is ${String(archiveInfo.size)} bytes; maximum is ${String(maximumPackedBytes)}.`,
    );
  }
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await run(
    [process.execPath, "add", archive, "--ignore-scripts"],
    consumer,
    packageEnvironment,
  );
  const installedPackage = await realpath(
    join(consumer, "node_modules", "@hraness", "atet"),
  );
  const packedStats = await scanPackedPackage(installedPackage);
  await verifyPackedRuntimeClosure(installedPackage, packedStats);
  if (packed !== undefined) {
    if (packed.result.name !== packageName) {
      throw new Error(`npm pack reported package ${packed.result.name} instead of ${packageName}.`);
    }
    if (packed.result.entryCount !== packedStats.fileCount) {
      throw new Error(
        `npm pack reported ${String(packed.result.entryCount)} files, but the clean install contains ${String(packedStats.fileCount)}.`,
      );
    }
    if (packed.result.size !== archiveInfo.size) {
      throw new Error(
        `npm pack reported ${String(packed.result.size)} packed bytes, but the archive has ${String(archiveInfo.size)}.`,
      );
    }
    if (packed.result.unpackedSize !== packedStats.unpackedBytes) {
      throw new Error(
        `npm pack reported ${String(packed.result.unpackedSize)} unpacked bytes, but the clean install contains ${String(packedStats.unpackedBytes)}.`,
      );
    }
  }
  await run([
    process.execPath,
    "-e",
    `await Promise.all(${JSON.stringify(importSpecifiers)}.map(specifier => import(specifier)))`,
  ], consumer);
  await run([
    join(consumer, "node_modules", ".bin", "atet"),
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
  const rubberStampReferencePath = join(
    installedSkill,
    "references",
    "rubber-stamp-field-notes.md",
  );
  const rubberStampReference = await readFile(rubberStampReferencePath, "utf8");
  for (const required of [
    '$skill_root/references/rubber-stamp-examples/stamp-style-1.png',
    '$skill_root/scripts/compose-rubber-stamp-field-note.ts',
  ]) {
    if (!rubberStampReference.includes(required)) {
      throw new Error(`Packed rubber-stamp workflow is missing ${required}.`);
    }
  }
  if ([...rubberStampReference.matchAll(/skill_root="\$\(atet skill path\)"/gu)].length !== 2) {
    throw new Error("Packed rubber-stamp steps do not resolve their skill root independently.");
  }
  const posterExample = join(
    installedSkill,
    "references",
    "rubber-stamp-examples",
    "poster-example-1.jpg",
  );
  const stampStyle = join(
    installedSkill,
    "references",
    "rubber-stamp-examples",
    "stamp-style-1.png",
  );
  const compositor = join(
    installedSkill,
    "scripts",
    "compose-rubber-stamp-field-note.ts",
  );
  const compositorOutput = join(consumer, "atet-rubber-stamp-smoke.jpg");
  await run([
    process.execPath,
    compositor,
    "--photo",
    posterExample,
    "--stamp",
    stampStyle,
    "--output",
    compositorOutput,
    "--place",
    "TEST",
    "--number",
    "01",
    "--keywords",
    "installed / skill / proof",
    "--year",
    "2026",
    "--width",
    "640",
    "--height",
    "480",
  ], consumer);
  const compositorOutputStat = await lstat(compositorOutput);
  if (!compositorOutputStat.isFile() || compositorOutputStat.size === 0) {
    throw new Error("Packed rubber-stamp compositor did not produce a JPEG.");
  }
  await run([
    join(consumer, "node_modules", ".bin", "atet"),
    "skill",
    "install",
    "--target",
    "agents",
    "--scope",
    "project",
    "--project",
    consumer,
  ], consumer);
  const runnerSkill = await realpath(join(consumer, ".agents", "skills", "atet"));
  if (runnerSkill.startsWith(`${installedPackage}${sep}`)) {
    throw new Error("Packed skill install did not exercise a runner-specific copied layout.");
  }
  const runnerRubberStampReference = await readFile(
    join(runnerSkill, "references", "rubber-stamp-field-notes.md"),
    "utf8",
  );
  if ([...runnerRubberStampReference.matchAll(/skill_root="\$\(atet skill path\)"/gu)].length !== 2) {
    throw new Error("Runner-installed skill lost packaged-resource discovery.");
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
  const publicTypeFixture = `
if (surface0.atetApi !== surface0.diagramApi) {
  throw new Error("Deprecated diagramApi must be the canonical atetApi object.");
}
void [
  surface0.atetApi.defineAtetWorkflow,
  surface0.atetApi.runAtetWorkflow,
  surface0.atetApi.executeAtetOperation,
  surface0.atetApi.generateAtetImage,
  surface0.atetApi.searchAtetOperations,
];
`;
  await writeFile(
    join(consumer, "index.ts"),
    `${imports}\nvoid [${uses}];\n${publicTypeFixture}`,
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

  const npmConsumer = join(work, "npm-consumer");
  await mkdir(npmConsumer);
  await writeFile(
    join(npmConsumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await run([
    "npm",
    "install",
    archive,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ], npmConsumer, packageEnvironment);
  const npmInstalledPackage = await realpath(
    join(npmConsumer, "node_modules", "@hraness", "atet"),
  );
  const npmPackedStats = await scanPackedPackage(npmInstalledPackage);
  await verifyPackedRuntimeClosure(npmInstalledPackage, npmPackedStats);
  if (
    npmPackedStats.fileCount !== packedStats.fileCount
    || npmPackedStats.unpackedBytes !== packedStats.unpackedBytes
  ) {
    throw new Error("npm and Bun consumers installed different Atet package contents.");
  }
  await run([
    "node",
    "--input-type=module",
    "-e",
    `await Promise.all(${JSON.stringify(nodeImportSpecifiers)}.map(specifier => import(specifier)))`,
  ], npmConsumer, packageEnvironment);
  await run([
    join(npmConsumer, "node_modules", ".bin", "atet"),
    "--version",
  ], npmConsumer, packageEnvironment);
  console.log(
    `Verified ${String(packedStats.fileCount)} packed files, ${String(archiveInfo.size)} packed bytes, and ${String(packedStats.unpackedBytes)} unpacked bytes.`,
  );
} finally {
  await rm(work, { force: true, recursive: true });
}
