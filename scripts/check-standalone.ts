import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SCANNED_ROOTS = [
  ".github",
  "apps",
  "dist",
  "docs",
  "examples",
  "packages",
  "schema",
  "scripts",
  "skills",
  "src",
];
const SCANNED_ROOT_FILES = [
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "SECURITY.md",
  "bun.lock",
  "eslint.config.mjs",
  "package.json",
  "tsconfig.json",
];
const IGNORED_NAMES = new Set([
  ".git",
  ".vercel",
  "node_modules",
  "zig-cache",
  "zig-out",
]);
const TEXT_EXTENSIONS = new Set([
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
  ".m",
  ".md",
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

const FORBIDDEN_SOURCE = [
  { label: "private Jungle package", pattern: /@jungle\//u },
  { label: "private Jungle source path", pattern: /projects\/(?:atet|transmute)/u },
  { label: "private Jungle fixture path", pattern: /\/(?:tmp|work)\/jungle\//u },
  { label: "Convex runtime", pattern: /(?:^|[^a-z])convex(?:[^a-z]|$)/iu },
  { label: "Better Auth runtime", pattern: /better-auth/iu },
  { label: "Suite Accounts runtime", pattern: /suite[-_ ]accounts/iu },
  { label: "hosted account service", pattern: /account\.hraness\.com/iu },
  { label: "legacy hosted API", pattern: /transmute\.rocks\/api/iu },
  { label: "legacy Graphics runtime", pattern: /graphics-compat/iu },
  {
    label: "duplicate compatibility schema alternative",
    pattern: /z\.literal\("((?:atet|transmute|studio)(?:\.[^"]+)?)"\),\s*z\.literal\("\1"\)/u,
  },
  {
    label: "duplicate compatibility type alternative",
    pattern: /"((?:atet|transmute|studio)(?:\.[^"]+)?)"\s*\|\s*"\1"/u,
  },
  {
    label: "duplicate compatibility reader branch",
    pattern: /!==\s*"((?:atet|transmute|studio)(?:\.[^"]+)?)"[^;\n]{0,200}!==\s*"\1"/u,
  },
];

const LEGACY_IDENTITY =
  /@hraness\/transmute|github\.com\/hraness\/transmute|transmute\.rocks|(?:Transmute|transmute|TRANSMUTE)/u;
const REVIEWED_SERIALIZED_COMPATIBILITY = [
  /\btransmute\.[a-z][a-z0-9.-]*(?:\.[a-z][a-z0-9.-]*)+\b/gu,
  /\b(?:execute|search)_transmute\b/gu,
] as const;
const REVIEWED_FILE_COMPATIBILITY = new Map<string, readonly RegExp[]>([
  [
    "AGENTS.md",
    [/Version 2 retains `transmute` only as a one-major CLI bin alias/gu],
  ],
  [
    "README.md",
    [/The former `transmute` executable remains an alias to `atet`/gu],
  ],
  [
    "package.json",
    [/"transmute": "\.\/apps\/desktop\/dist\/cli\/main\.js"/gu],
  ],
  [
    "scripts/package-smoke.ts",
    [
      /pattern: \/projects\\\/\(\?:atet\|transmute\)\/u/gu,
      /pattern: \/transmute\\\.rocks\\\/api\/iu/gu,
      /join\(consumer, "node_modules", "\.bin", "transmute"\)/gu,
    ],
  ],
]);

function removeReviewedLegacyCompatibility(
  path: string,
  source: string,
): string {
  let remaining = source;
  for (const pattern of REVIEWED_SERIALIZED_COMPATIBILITY) {
    remaining = remaining.replaceAll(pattern, "");
  }
  for (const pattern of REVIEWED_FILE_COMPATIBILITY.get(path) ?? []) {
    remaining = remaining.replaceAll(pattern, "");
  }
  return remaining;
}

function extension(path: string): string {
  const match = /\.[^./]+$/u.exec(path);
  return match?.[0] ?? "";
}

function isIgnored(path: string): boolean {
  const normalized = path.split(sep).join("/");
  return [...IGNORED_NAMES].some(name =>
    normalized === name || normalized.includes(`/${name}/`)
  );
}

async function collectFiles(path: string): Promise<string[]> {
  if (isIgnored(relative(ROOT, path))) return [];
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Standalone source must not contain a symlink: ${relative(ROOT, path)}`);
  }
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry =>
    collectFiles(join(path, entry.name))
  ));
  return nested.flat();
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function dependencyNames(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value);
}

async function checkPackage(path: string): Promise<string[]> {
  const packageJson = await readJson(path);
  const names = [
    ...dependencyNames(packageJson.dependencies),
    ...dependencyNames(packageJson.devDependencies),
    ...dependencyNames(packageJson.optionalDependencies),
    ...dependencyNames(packageJson.peerDependencies),
  ];
  return names
    .filter(name => name.startsWith("@jungle/"))
    .map(name => `${relative(ROOT, path)} depends on private package ${name}`);
}

const packageFiles = [
  join(ROOT, "package.json"),
  join(ROOT, "apps/web/package.json"),
  join(ROOT, "packages/scene/package.json"),
];
const packageProblems = (await Promise.all(packageFiles.map(async path => {
  try {
    return await checkPackage(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}))).flat();

const files = (await Promise.all(SCANNED_ROOTS.map(async root => {
  try {
    return await collectFiles(join(ROOT, root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}))).flat().concat(SCANNED_ROOT_FILES.map(file => join(ROOT, file)));

const sourceProblems: string[] = [];
for (const file of files) {
  if (file === import.meta.path) continue;
  if (relative(ROOT, file) === "scripts/check-standalone.ts") continue;
  const rootRelative = relative(ROOT, file);
  if (LEGACY_IDENTITY.test(rootRelative)) {
    sourceProblems.push(`${rootRelative} retains a pre-Atet source path`);
  }
  if (
    !TEXT_EXTENSIONS.has(extension(file))
    && !SCANNED_ROOT_FILES.includes(rootRelative)
  ) continue;
  const text = await readFile(file, "utf8");
  if (rootRelative !== "scripts/package-smoke.ts") {
    for (const rule of FORBIDDEN_SOURCE) {
      if (rule.pattern.test(text)) {
        sourceProblems.push(`${relative(ROOT, file)} contains ${rule.label}`);
      }
    }
  }
  const unreviewedIdentity = removeReviewedLegacyCompatibility(rootRelative, text);
  if (LEGACY_IDENTITY.test(unreviewedIdentity)) {
    sourceProblems.push(
      `${rootRelative} contains an unreviewed pre-Atet identity outside serialized or CLI compatibility`,
    );
  }
}

const problems = [...packageProblems, ...sourceProblems];
const rootPackage = await readJson(join(ROOT, "package.json"));
const expectedDescription = "Open-source TypeScript SDK, Bun CLI, and local runtime for turning ideas and raw assets into images, diagrams, animated loops, and video.";
if (rootPackage.name !== "@hraness/atet") {
  problems.push("package.json name must be @hraness/atet");
}
if (rootPackage.description !== expectedDescription) {
  problems.push("package.json description does not match the canonical Atet description");
}
if (rootPackage.homepage !== "https://atet.sh/") {
  problems.push("package.json homepage must be https://atet.sh/");
}
const repository = rootPackage.repository;
if (
  repository === null
  || typeof repository !== "object"
  || Array.isArray(repository)
  || Reflect.get(repository, "url") !== "git+https://github.com/hraness/atet.git"
) {
  problems.push("package.json repository must be hraness/atet");
}
const bugs = rootPackage.bugs;
if (
  bugs === null
  || typeof bugs !== "object"
  || Array.isArray(bugs)
  || Reflect.get(bugs, "url") !== "https://github.com/hraness/atet/issues"
) {
  problems.push("package.json bugs URL must be the hraness/atet issue tracker");
}
const bins = rootPackage.bin;
if (
  bins === null
  || typeof bins !== "object"
  || Array.isArray(bins)
  || Object.keys(bins).sort().join(",") !== "atet,transmute"
  || Reflect.get(bins, "atet") !== "./apps/desktop/dist/cli/main.js"
  || Reflect.get(bins, "transmute") !== "./apps/desktop/dist/cli/main.js"
) {
  problems.push("package.json bins must expose canonical atet plus the version-2 transmute alias");
}
const packageVersion = rootPackage.version;
if (typeof packageVersion !== "string") {
  problems.push("package.json version must be a string");
} else if (packageVersion !== "2.0.0") {
  problems.push("package.json version must be 2.0.0 for the Atet identity cutover");
} else {
  const versionContracts = [
    ["apps/desktop/app.zon", `.version = ${JSON.stringify(packageVersion)}`],
    ["apps/desktop/build.zig", `{s}-${packageVersion}-{s}-{s}{s}`],
    [
      "apps/desktop/capture/Info.plist",
      `<key>CFBundleShortVersionString</key>\n  <string>${packageVersion}</string>`,
    ],
    [
      "apps/desktop/cli/commands.ts",
      `export const ATET_VERSION = ${JSON.stringify(packageVersion)}`,
    ],
    [
      "apps/desktop/cli/recording-controller.ts",
      `toolVersion: ${JSON.stringify(packageVersion)}`,
    ],
    [
      "apps/desktop/runtime/package-macos.ts",
      `atet-${packageVersion}-macos-ReleaseFast.app`,
    ],
  ] as const;
  for (const [path, expected] of versionContracts) {
    if (!(await readFile(join(ROOT, path), "utf8")).includes(expected)) {
      problems.push(`${path} does not match package version ${packageVersion}`);
    }
  }
}
const gitignore = await readFile(join(ROOT, ".gitignore"), "utf8");
const gitignoreLines = gitignore.split(/\r?\n/u);
for (const required of ["/artifacts/", ".env", ".env.*"]) {
  if (!gitignoreLines.includes(required)) {
    problems.push(`.gitignore must contain ${required}`);
  }
}
if (gitignoreLines.includes("!.env") || gitignoreLines.includes("!.env.*")) {
  problems.push(".gitignore must not re-include credential dotenv files");
}
problems.sort();
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

console.log(`Standalone boundary verified across ${files.length} source files.`);
