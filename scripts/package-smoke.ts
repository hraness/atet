import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
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

import { verifyNpmPublishConfig } from "./npm-publish-policy";

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
const maximumPackedBytes = 3_750_000;
const maximumUnpackedBytes = 8_900_000;
const requiredPackedPaths = [
  "DISCLOSURE",
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
  "apps/desktop/dist/cli/NebulaSans-Bold-26se8aek.otf",
  "apps/desktop/dist/cli/NebulaSans-Bold-bcz7y08t.woff2",
  "apps/desktop/dist/cli/NebulaSans-Book-5ax05zvn.woff2",
  "apps/desktop/dist/cli/NebulaSans-Book-8cenzchw.otf",
  "dist/NebulaSans-Bold-26se8aek.otf",
  "dist/NebulaSans-Bold-bcz7y08t.woff2",
  "dist/NebulaSans-Book-5ax05zvn.woff2",
  "dist/NebulaSans-Book-8cenzchw.otf",
  "package.json",
  "schema/diagram.schema.json",
  "skills/atet/SKILL.md",
  "skills/atet/references/rubber-stamp-examples/poster-example-1.jpg",
  "skills/atet/references/rubber-stamp-examples/stamp-style-1.png",
  "skills/atet/scripts/compose-rubber-stamp-field-note.ts",
  "src/assets/fonts/nebula-sans/LICENSE.txt",
  "src/assets/fonts/nebula-sans/NebulaSans-Bold.otf",
  "src/assets/fonts/nebula-sans/NebulaSans-Bold.woff2",
  "src/assets/fonts/nebula-sans/NebulaSans-Book.otf",
  "src/assets/fonts/nebula-sans/NebulaSans-Book.woff2",
  "src/assets/fonts/nebula-sans/PROVENANCE.md",
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
  readonly fileSizes: ReadonlyMap<string, number>;
  readonly paths: ReadonlySet<string>;
  readonly unpackedBytes: number;
}

interface NpmPackFile {
  readonly mode: number;
  readonly path: string;
  readonly size: number;
}

interface NpmPackResult {
  readonly entryCount: number;
  readonly files: readonly NpmPackFile[];
  readonly filename: string;
  readonly integrity: string;
  readonly name: string;
  readonly shasum: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly version: string;
}

interface PackageSmokeArguments {
  readonly archive?: string;
  readonly packJson?: string;
}

async function scanPackedPackage(directory: string): Promise<PackedPackageStats> {
  const problems: string[] = [];
  const fileSizes = new Map<string, number>();
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
    fileSizes.set(packedPath, info.size);
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
  return { fileCount: paths.size, fileSizes, paths, unpackedBytes };
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
  const contentPolicy = record(manifest.contentPolicy, "package.json contentPolicy");
  if (contentPolicy.class !== "dual-use") {
    throw new Error("packed package.json must retain contentPolicy.class=dual-use.");
  }
  verifyNpmPublishConfig(manifest.publishConfig);
  const [sourceDisclosure, packedDisclosure] = await Promise.all([
    readFile(join(process.cwd(), "DISCLOSURE")),
    readFile(join(packageRoot, "DISCLOSURE")),
  ]);
  if (!sourceDisclosure.equals(packedDisclosure)) {
    throw new Error("packed DISCLOSURE differs from the reviewed source disclosure.");
  }
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
  for (const field of ["filename", "integrity", "name", "shasum", "version"] as const) {
    if (typeof result[field] !== "string" || result[field].length === 0) {
      throw new Error(`npm pack result ${field} must be a nonempty string.`);
    }
  }
  if (result.name !== packageName) {
    throw new Error(`npm pack reported package ${String(result.name)} instead of ${packageName}.`);
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(String(result.version))) {
    throw new Error(`npm pack reported non-stable version ${String(result.version)}.`);
  }
  const expectedFilename = `hraness-atet-${String(result.version)}.tgz`;
  if (result.filename !== expectedFilename) {
    throw new Error(
      `npm pack reported filename ${String(result.filename)} instead of ${expectedFilename}.`,
    );
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(String(result.integrity))) {
    throw new Error("npm pack result integrity must be a SHA-512 SRI value.");
  }
  if (!/^[a-f0-9]{40}$/u.test(String(result.shasum))) {
    throw new Error("npm pack result shasum must be a lowercase SHA-1 digest.");
  }
  if (!Array.isArray(result.files) || result.files.length !== result.entryCount) {
    throw new Error("npm pack files must match entryCount.");
  }
  const files: NpmPackFile[] = [];
  const seen = new Set<string>();
  for (const [index, value] of result.files.entries()) {
    const file = record(value, `npm pack result file ${String(index + 1)}`);
    if (typeof file.path !== "string" || file.path.length === 0 || seen.has(file.path)) {
      throw new Error(`npm pack result file ${String(index + 1)} has an invalid path.`);
    }
    for (const field of ["mode", "size"] as const) {
      if (!Number.isSafeInteger(file[field]) || Number(file[field]) < 0) {
        throw new Error(
          `npm pack result file ${String(index + 1)} ${field} must be a nonnegative safe integer.`,
        );
      }
    }
    seen.add(file.path);
    files.push(file as unknown as NpmPackFile);
  }
  return { ...(result as unknown as NpmPackResult), files };
}

async function verifyNpmPackResult(
  archive: string,
  archiveBytes: Uint8Array,
  result: NpmPackResult,
  stats: PackedPackageStats,
): Promise<void> {
  const problems: string[] = [];
  if (basename(archive) !== result.filename) {
    problems.push(`archive filename ${basename(archive)} differs from ${result.filename}`);
  }
  if (result.entryCount !== stats.fileCount) {
    problems.push(
      `npm pack reported ${String(result.entryCount)} files, but the clean install contains ${String(stats.fileCount)}`,
    );
  }
  if (result.size !== archiveBytes.byteLength) {
    problems.push(
      `npm pack reported ${String(result.size)} packed bytes, but the archive has ${String(archiveBytes.byteLength)}`,
    );
  }
  if (result.unpackedSize !== stats.unpackedBytes) {
    problems.push(
      `npm pack reported ${String(result.unpackedSize)} unpacked bytes, but the clean install contains ${String(stats.unpackedBytes)}`,
    );
  }
  const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  if (actualIntegrity !== result.integrity) {
    problems.push("npm pack SHA-512 integrity does not match the exact archive bytes");
  }
  const actualShasum = createHash("sha1").update(archiveBytes).digest("hex");
  if (actualShasum !== result.shasum) {
    problems.push("npm pack SHA-1 shasum does not match the exact archive bytes");
  }
  const metadataFiles = new Map(result.files.map(file => [file.path, file.size] as const));
  for (const [path, size] of stats.fileSizes) {
    if (metadataFiles.get(path) !== size) {
      problems.push(`npm pack inventory differs for ${path}`);
    }
  }
  for (const path of metadataFiles.keys()) {
    if (!stats.fileSizes.has(path)) problems.push(`npm pack inventory contains absent path ${path}`);
  }
  if (problems.length > 0) {
    throw new Error(`npm pack metadata verification failed:\n${problems.sort().join("\n")}`);
  }
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
    "--registry=https://registry.npmjs.org",
  ], repository, environment);
  const result = parseNpmPackResult(JSON.parse(output) as unknown);
  return { archive: join(packDirectory, result.filename), result };
}

function parseArguments(args: readonly string[]): PackageSmokeArguments {
  if (args.length === 0) return {};
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      (option !== "--archive" && option !== "--pack-json")
      || value === undefined
      || value.length === 0
      || values.has(option)
    ) {
      throw new Error(
        "Usage: bun scripts/package-smoke.ts [--archive package.tgz --pack-json npm-pack.json]",
      );
    }
    values.set(option, value);
  }
  const archive = values.get("--archive");
  const packJson = values.get("--pack-json");
  if (archive === undefined || packJson === undefined || values.size !== 2) {
    throw new Error(
      "An external archive requires both --archive and --pack-json so its exact metadata can be verified.",
    );
  }
  return { archive: resolve(process.cwd(), archive), packJson: resolve(process.cwd(), packJson) };
}

async function snapshotDirectory(root: string): Promise<string> {
  const rows: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        rows.push(`link\t${relativePath}\t${await readlink(path)}`);
      } else if (info.isDirectory()) {
        rows.push(`directory\t${relativePath}\t${String(info.mode)}`);
        await visit(path, relativePath);
      } else if (info.isFile()) {
        rows.push(
          `file\t${relativePath}\t${String(info.mode)}\t${String(info.size)}\t${String(info.mtimeMs)}`,
        );
      } else {
        rows.push(`other\t${relativePath}\t${String(info.mode)}`);
      }
    }
  }
  await visit(root, "");
  return rows.join("\n");
}

function describeSnapshotChanges(before: string, after: string): string {
  const beforeRows = new Set(before.split("\n").filter(Boolean));
  const afterRows = new Set(after.split("\n").filter(Boolean));
  const removed = [...beforeRows].filter(row => !afterRows.has(row)).map(row => `- ${row}`);
  const added = [...afterRows].filter(row => !beforeRows.has(row)).map(row => `+ ${row}`);
  return [...removed, ...added].slice(0, 40).join("\n");
}

function importSideEffectProbeSource(specifiers: readonly string[]): string {
  return `
import { createRequire, syncBuiltinESMExports } from "node:module";

const attempts = [];
const deny = name => (..._arguments) => {
  attempts.push(name);
  throw new Error("package import attempted " + name);
};
const require = createRequire(import.meta.url);
const patch = (specifier, names) => {
  const target = require(specifier);
  for (const name of names) {
    if (typeof target[name] !== "function") continue;
    try {
      target[name] = deny(specifier + "." + name);
    } catch {
      // Runtime permissions and the filesystem snapshot remain independent guards.
    }
  }
};

patch("node:child_process", [
  "exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync",
]);
patch("node:worker_threads", ["Worker"]);
patch("node:fs", [
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
  "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod",
  "fchmodSync", "fchown", "fchownSync", "fdatasync", "fdatasyncSync", "ftruncate",
  "ftruncateSync", "futimes", "futimesSync", "link", "linkSync", "lchmod",
  "lchmodSync", "lchown", "lchownSync", "lutimes", "lutimesSync", "mkdir",
  "mkdirSync", "mkdtemp", "mkdtempSync", "rename", "renameSync", "rm", "rmSync",
  "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync",
  "unlink", "unlinkSync", "utimes", "utimesSync", "write", "writeFile",
  "writeFileSync", "writeSync",
]);
patch("node:fs/promises", [
  "appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown", "link",
  "lutimes", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate",
  "unlink", "utimes", "writeFile",
]);
patch("node:http", ["createServer", "get", "request"]);
patch("node:https", ["createServer", "get", "request"]);
patch("node:http2", ["connect", "createSecureServer", "createServer"]);
patch("node:net", ["connect", "createConnection", "createServer"]);
patch("node:tls", ["connect", "createSecureContext", "createServer"]);
patch("node:dgram", ["createSocket"]);
patch("node:dns", [
  "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny",
  "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr",
  "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
]);
patch("node:dns/promises", [
  "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny",
  "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr",
  "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
]);
syncBuiltinESMExports();

for (const [name, value] of [
  ["fetch", deny("globalThis.fetch")],
  ["WebSocket", deny("globalThis.WebSocket")],
  ["EventSource", deny("globalThis.EventSource")],
]) {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  } catch {
    // The patched Node/Bun modules and permission boundary still apply.
  }
}
try {
  process.chdir = deny("process.chdir");
} catch {
  // The directory snapshot still detects writes below the controlled roots.
}
if (typeof Bun !== "undefined") {
  for (const name of ["connect", "listen", "serve", "spawn", "spawnSync", "udpSocket", "write"]) {
    if (typeof Bun[name] !== "function") continue;
    try {
      Bun[name] = deny("Bun." + name);
    } catch {
      // Node-compatible hooks above remain active in this runtime.
    }
  }
}

await Promise.all(${JSON.stringify(specifiers)}.map(specifier => import(specifier)));
if (attempts.length > 0) {
  throw new Error("package imports attempted side effects: " + attempts.join(", "));
}
`;
}

async function verifySideEffectFreeImports(
  consumer: string,
  specifiers: readonly string[],
  runtime: "bun" | "node",
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const stateRoot = join(consumer, `.atet-${runtime}-import-state`);
  for (const directory of [
    stateRoot,
    join(stateRoot, "cache"),
    join(stateRoot, "config"),
    join(stateRoot, "data"),
    join(stateRoot, "home"),
    join(stateRoot, "tmp"),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  const probe = join(consumer, `.atet-${runtime}-import-probe.mjs`);
  await writeFile(probe, importSideEffectProbeSource(specifiers));
  const probeEnvironment = {
    ...environment,
    ATET_CACHE_DIR: join(stateRoot, "cache", "atet"),
    ATET_TEST_STATE_ROOT: join(stateRoot, "data", "atet"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HOME: join(stateRoot, "home"),
    TMPDIR: join(stateRoot, "tmp"),
    XDG_CACHE_HOME: join(stateRoot, "cache"),
    XDG_CONFIG_HOME: join(stateRoot, "config"),
    XDG_DATA_HOME: join(stateRoot, "data"),
  };
  const before = await snapshotDirectory(consumer);
  if (runtime === "bun") {
    await run([process.execPath, probe], consumer, probeEnvironment);
  } else {
    await run([
      "node",
      "--permission",
      "--allow-addons",
      "--allow-fs-read=*",
      probe,
    ], consumer, probeEnvironment);
  }
  const after = await snapshotDirectory(consumer);
  if (after !== before) {
    throw new Error(
      `${runtime} package imports changed the controlled consumer filesystem:\n${describeSnapshotChanges(before, after)}`,
    );
  }
}

const repository = process.cwd();
const arguments_ = parseArguments(process.argv.slice(2));
const providedArchive = arguments_.archive;
const providedPackResult = arguments_.packJson === undefined
  ? undefined
  : parseNpmPackResult(
    JSON.parse(await readFile(arguments_.packJson, "utf8")) as unknown,
  );
const work = await mkdtemp(join(tmpdir(), "atet-package-smoke-"));
try {
  const packageEnvironment = {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: join(work, "bun-cache"),
    TMPDIR: work,
    npm_config_cache: join(work, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org",
  };
  const packed = providedArchive === undefined
    ? await createNpmArchive(repository, join(work, "pack"), packageEnvironment)
    : undefined;
  const archive = packed?.archive ?? providedArchive;
  const packResult = packed?.result ?? providedPackResult;
  if (archive === undefined) throw new Error("Packed archive path is unavailable.");
  if (packResult === undefined) throw new Error("npm pack metadata is unavailable.");
  const packageJson = record(
    JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as unknown,
    "package.json",
  );
  if (packResult.version !== packageJson.version) {
    throw new Error(
      `npm pack reported version ${packResult.version} instead of ${String(packageJson.version)}.`,
    );
  }
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.size === 0) {
    throw new Error(`Packed archive is not a nonempty regular file: ${archive}`);
  }
  if (archiveInfo.size > maximumPackedBytes) {
    throw new Error(
      `Packed archive is ${String(archiveInfo.size)} bytes; maximum is ${String(maximumPackedBytes)}.`,
    );
  }
  const archiveBytes = await readFile(archive);
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
  await verifyNpmPackResult(archive, archiveBytes, packResult, packedStats);
  await verifySideEffectFreeImports(
    consumer,
    importSpecifiers,
    "bun",
    packageEnvironment,
  );
  await run([
    process.execPath,
    "-e",
    `const { renderPng, renderSvg } = await import("@hraness/atet");
const source = weight => ({ version: 1, name: \`installed-font-proof-\${weight}\`, canvas: { width: 320, height: 120 }, shapes: [{ id: "label", type: "text", x: 16, y: 16, text: "Nebula Sans", fontSize: 42, weight }] });
const blank = await renderSvg({ version: 1, name: "installed-font-blank", canvas: { width: 320, height: 120 }, shapes: [] }, "light", {});
const blankPng = renderPng(blank, {}, 1);
const pngs = [];
for (const weight of [400, 700]) {
  const rendered = await renderSvg(source(weight), "light", {});
  if (!rendered.svg.includes('font-family="Nebula Sans"') || (rendered.svg.match(/data:font\\/woff2;base64,/g) ?? []).length !== 2) throw new Error("Packed SDK did not embed both Nebula Sans web faces.");
  const png = renderPng(rendered, {}, 1);
  if (png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) throw new Error("Packed SDK did not render a PNG with its bundled font.");
  if (Buffer.from(png).equals(Buffer.from(blankPng))) throw new Error(\`Packed SDK did not render visible Nebula Sans \${weight} glyphs.\`);
  pngs.push(png);
}
if (Buffer.from(pngs[0]).equals(Buffer.from(pngs[1]))) throw new Error("Packed SDK did not preserve distinct Book and Bold raster faces.");`,
  ], consumer);
  await run([
    join(consumer, "node_modules", ".bin", "atet"),
    "--help",
  ], consumer);
  const htmlCatalogText = await runOutput([
    join(consumer, "node_modules", ".bin", "atet"),
    "html",
    "catalog",
    "--json",
  ], consumer);
  const htmlCatalog = record(
    JSON.parse(htmlCatalogText) as unknown,
    "atet html catalog --json",
  );
  if (htmlCatalog.schemaVersion !== 1 || !Array.isArray(htmlCatalog.profiles)) {
    throw new Error("Packed CLI returned an invalid HTML scaffold catalog.");
  }
  const installedHtmlProfiles = htmlCatalog.profiles.map((value, index) =>
    record(value, `atet html catalog profile ${String(index)}`)
  );
  if (
    JSON.stringify(installedHtmlProfiles.map(profile => profile.kind))
      !== JSON.stringify([
        "plain",
        "motion",
        "p5",
        "two",
        "paper-shaders",
        "three",
        "vgpu",
      ])
  ) {
    throw new Error("Packed CLI lost the stable HTML scaffold profile order.");
  }
  const installedP5 = installedHtmlProfiles.find(profile => profile.kind === "p5");
  const installedTwo = installedHtmlProfiles.find(profile => profile.kind === "two");
  if (
    JSON.stringify(installedP5?.libraries) !== JSON.stringify([
      { specifier: "p5", version: "2.3.2" },
    ])
    || JSON.stringify(installedTwo?.libraries) !== JSON.stringify([
      { specifier: "two.js", version: "0.8.24" },
    ])
  ) {
    throw new Error("Packed CLI returned stale executable HTML library locks.");
  }
  const installedP5Scaffold = join(consumer, "installed-p5-overlay.html");
  await run([
    join(consumer, "node_modules", ".bin", "atet"),
    "html",
    "scaffold",
    "p5",
    "--output",
    installedP5Scaffold,
  ], consumer);
  const installedP5Html = await readFile(installedP5Scaffold, "utf8");
  if (
    !installedP5Html.includes('from "p5"')
    || !installedP5Html.includes("await sketch.redraw()")
  ) {
    throw new Error("Packed CLI did not emit the admitted p5 scaffold.");
  }
  const installedTwoScaffold = join(consumer, "installed-two-overlay.html");
  await run([
    join(consumer, "node_modules", ".bin", "atet"),
    "html",
    "scaffold",
    "two",
    "--output",
    installedTwoScaffold,
  ], consumer);
  const installedTwoHtml = await readFile(installedTwoScaffold, "utf8");
  if (
    !installedTwoHtml.includes('from "two.js"')
    || !installedTwoHtml.includes("AtetOverlay.onFrame")
  ) {
    throw new Error("Packed CLI did not emit the admitted Two.js scaffold.");
  }
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
    "--registry=https://registry.npmjs.org",
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
  await verifySideEffectFreeImports(
    npmConsumer,
    nodeImportSpecifiers,
    "node",
    packageEnvironment,
  );
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
