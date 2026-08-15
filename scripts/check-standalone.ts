import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  compareLegacyIdentityInventory,
  duplicateIdentityAlternatives,
  isGeneratedLegacyIdentityPath,
  legacyIdentitySnapshot,
  planLegacyIdentityInventoryUpdate,
  validateInventoryEntries,
  type LegacyIdentityInventoryEntry,
  type LegacyIdentitySnapshot,
} from "./legacy-identity";

const ROOT = new URL("../", import.meta.url).pathname;
const LEGACY_IDENTITY_INVENTORY_PATH = join(
  ROOT,
  "scripts/legacy-identity.inventory.json",
);
const LEGACY_IDENTITY_BOUNDARY_FILES = new Set([
  "scripts/check-standalone.ts",
  "scripts/legacy-identity.inventory.json",
  "scripts/legacy-identity.test.ts",
  "scripts/legacy-identity.ts",
]);
const REVIEWED_PREDECESSOR_PATHS = new Set([
  "apps/desktop/cli/transmute.ts",
  "apps/desktop/dist/cli/transmute.js",
]);
const UPDATE_LEGACY_IDENTITY_INVENTORY =
  process.argv.length === 3
  && process.argv[2] === "--update-legacy-identity-inventory";
if (
  process.argv.length > 2
  && !UPDATE_LEGACY_IDENTITY_INVENTORY
) {
  console.error(
    "Usage: bun scripts/check-standalone.ts [--update-legacy-identity-inventory]",
  );
  process.exit(2);
}
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
const CANONICAL_TEXT_SENTINELS = [
  {
    path: "src/version.ts",
    values: ['export const ATET_VERSION = "2.0.0" as const'],
  },
  {
    path: "src/operations.ts",
    values: [
      '"atet.diagram.check"',
      '"atet.diagram.render"',
      '"atet.image.generate"',
      '"atet.image.vectorize"',
    ],
  },
  {
    path: "apps/desktop/core/storage.ts",
    values: ["canonicalAtetPersistenceDocument"],
  },
  {
    path: "apps/desktop/cli/project-state-transaction.ts",
    values: ['kind: "atet.project-state-transaction"'],
  },
  {
    path: "apps/desktop/dist/cli/main.js",
    values: [
      '"2.0.0"',
      '"atet.diagram.check"',
      '"atet.edit-plan"',
      '"atet.video-project"',
    ],
  },
] as const;

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
  /\btransmute\.(?!config\b|rocks\b)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\b/gu,
  /\b(?:execute|search)_transmute\b/gu,
] as const;
const DEPRECATED_TYPESCRIPT_API = /\b[A-Za-z0-9_]*(?:Transmute|transmute|TRANSMUTE)[A-Za-z0-9_]*\b/gu;
const PREDECESSOR_ENVIRONMENT = /\bTRANSMUTE_[A-Z][A-Z0-9_]*\b/gu;
const PREDECESSOR_HYPHENATED_IDENTITY = /\btransmute-[a-z0-9-]+(?:\/v[0-9]+)?\b/gu;
const PREDECESSOR_OPERATION_REGEX = /transmute\\\./gu;
const PREDECESSOR_OPERATION_PREFIX = /transmute\./gu;
const PREDECESSOR_LOCAL_IMPORT = /@hraness\/transmute\/local\/(?:code(?:\/(?:advanced|workflows))?|html-overlay)/gu;
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
    [/"transmute": "\.\/apps\/desktop\/dist\/cli\/transmute\.js"/gu],
  ],
  [
    "scripts/package-smoke.ts",
    [
      /pattern: \/projects\\\/\(\?:atet\|transmute\)\/u/gu,
      /pattern: \/transmute\\\.rocks\\\/api\/iu/gu,
      /join\(consumer, "node_modules", "\.bin", "transmute"\)/gu,
    ],
  ],
  ["src/cli.ts", [DEPRECATED_TYPESCRIPT_API]],
  ["src/cloud-errors.ts", [DEPRECATED_TYPESCRIPT_API]],
  ["src/code/contracts.ts", [PREDECESSOR_HYPHENATED_IDENTITY]],
  ["src/code/errors.ts", [DEPRECATED_TYPESCRIPT_API]],
  ["src/code/public-operations.ts", [DEPRECATED_TYPESCRIPT_API, PREDECESSOR_OPERATION_REGEX, PREDECESSOR_OPERATION_PREFIX]],
  ["src/code/runtime.ts", [DEPRECATED_TYPESCRIPT_API]],
  [
    "src/config.ts",
    [/transmute\.config\.(?:ts|mjs|js|json)/gu],
  ],
  [
    "src/config.test.ts",
    [/atet-config-transmute-/gu, /transmute\.config\.(?:ts|mjs|js|json)/gu],
  ],
  ["src/generate.ts", [DEPRECATED_TYPESCRIPT_API]],
  ["src/host-resource-posix.ts", [DEPRECATED_TYPESCRIPT_API]],
  [
    "src/host-resources.ts",
    [DEPRECATED_TYPESCRIPT_API, /\bTransmute\b/gu, /"transmute"/gu],
  ],
  ["src/operations.ts", [DEPRECATED_TYPESCRIPT_API, PREDECESSOR_OPERATION_REGEX, PREDECESSOR_OPERATION_PREFIX]],
  ["src/vectorize/tool.ts", [PREDECESSOR_ENVIRONMENT, /TRANSMUTE_/gu]],
  ["src/workflow.ts", [DEPRECATED_TYPESCRIPT_API]],
  ["apps/desktop/README.md", [/`TransmuteOverlay`/gu]],
  ["apps/desktop/application/registry.ts", [PREDECESSOR_OPERATION_REGEX, PREDECESSOR_OPERATION_PREFIX]],
  ["apps/desktop/capture/hardware-smoke-config.ts", [PREDECESSOR_ENVIRONMENT, /TRANSMUTE_/gu]],
  ["apps/desktop/cli/capabilities.test.ts", [PREDECESSOR_ENVIRONMENT, PREDECESSOR_HYPHENATED_IDENTITY]],
  [
    "apps/desktop/cli/main.test.ts",
    [DEPRECATED_TYPESCRIPT_API, /"transmute"/gu, /transmute\.exe/gu, /transmute-helper/gu, /transmute is deprecated; use atet/gu],
  ],
  [
    "apps/desktop/cli/main.ts",
    [DEPRECATED_TYPESCRIPT_API, /"transmute"/gu, /transmute is deprecated; use atet/gu],
  ],
  [
    "apps/desktop/cli/transmute.ts",
    [/"transmute"/gu],
  ],
  [
    "apps/desktop/cli/paths.test.ts",
    [PREDECESSOR_ENVIRONMENT, /\bTransmute\b/gu, /"transmute"/gu, /\/transmute/gu, /artifacts\/transmute/gu],
  ],
  [
    "apps/desktop/cli/paths.ts",
    [PREDECESSOR_ENVIRONMENT, DEPRECATED_TYPESCRIPT_API, /"Transmute"/gu, /"transmute"/gu, /artifacts\/transmute/gu],
  ],
  ["apps/desktop/cli/renamed-environment.ts", [PREDECESSOR_ENVIRONMENT, /TRANSMUTE_/gu, /\bTransmute\b/gu]],
  ["apps/desktop/code/plan-contracts.ts", [PREDECESSOR_HYPHENATED_IDENTITY]],
  ["apps/desktop/code/run-contracts.ts", [PREDECESSOR_HYPHENATED_IDENTITY]],
  ["apps/desktop/code/runtime-identity.ts", [/\btransmute\//gu]],
  ["apps/desktop/code/scheduler.ts", [PREDECESSOR_OPERATION_REGEX, PREDECESSOR_OPERATION_PREFIX]],
  [
    "apps/desktop/code/source-bundle.test.ts",
    [PREDECESSOR_LOCAL_IMPORT, /@hraness\/transmute\/local\//gu, /\bTransmute\b/gu],
  ],
  ["apps/desktop/code/source-bundle.ts", [PREDECESSOR_LOCAL_IMPORT]],
  ["apps/desktop/contracts/recording.test.ts", [/"transmute"/gu]],
  ["apps/desktop/contracts/recording.ts", [/"transmute"/gu]],
  ["apps/desktop/contracts/runtime.ts", [DEPRECATED_TYPESCRIPT_API, /artifacts\/transmute/gu]],
  ["apps/desktop/html-overlay/runtime.test.ts", [DEPRECATED_TYPESCRIPT_API]],
  ["apps/desktop/html-overlay/runtime.ts", [DEPRECATED_TYPESCRIPT_API]],
  [
    "apps/desktop/runtime/src/main.test.ts",
    [/\bTransmute\b/gu, /Movies\\\/Transmute/gu],
  ],
  [
    "apps/desktop/runtime/src/main.ts",
    [PREDECESSOR_ENVIRONMENT, /\bTransmute\b/gu, /"transmute"/gu, /artifacts\/transmute/gu],
  ],
  ["apps/desktop/runtime/src/recording-service.ts", [/artifacts\/transmute/gu]],
  ["apps/desktop/src/runtime_host.zig", [PREDECESSOR_ENVIRONMENT]],
  [
    "apps/web/site.test.ts",
    [/\bTransmute\b/gu, /(?:preview\.)?transmute\.rocks/gu, /transmute\\\.rocks/gu],
  ],
  ["apps/web/vercel.json", [/(?:preview\.)?transmute\.rocks/gu]],
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

async function trackedRepositoryPaths(): Promise<ReadonlySet<string>> {
  const git = Bun.spawn(
    ["git", "ls-files", "--cached", "-z", "--"],
    { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    git.exited,
    new Response(git.stdout).text(),
    new Response(git.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Unable to enumerate tracked standalone files: ${stderr.trim() || `git exited ${exitCode}`}`,
    );
  }
  return new Set(stdout.split("\0").filter(path => path.length > 0));
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
}))).flat().concat(SCANNED_ROOT_FILES.map(file => join(ROOT, file))).sort();
const trackedPaths = await trackedRepositoryPaths();

const inventoryInput: unknown = JSON.parse(
  await readFile(LEGACY_IDENTITY_INVENTORY_PATH, "utf8"),
);
const inventoryStructureProblems = [...validateInventoryEntries(inventoryInput)];
const inventoryEntries = inventoryStructureProblems.length === 0
  ? inventoryInput as readonly LegacyIdentityInventoryEntry[]
  : [];
const inventoriedIdentityPaths = new Set(inventoryEntries.map(entry => entry.path));

const sourceProblems: string[] = [];
const legacyIdentitySnapshots: LegacyIdentitySnapshot[] = [];
for (const file of files) {
  const rootRelative = relative(ROOT, file).split(sep).join("/");
  if (
    !REVIEWED_PREDECESSOR_PATHS.has(rootRelative)
    && LEGACY_IDENTITY.test(rootRelative)
  ) {
    sourceProblems.push(`${rootRelative} retains a pre-Atet source path`);
  }
  if (
    !TEXT_EXTENSIONS.has(extension(file))
    && !SCANNED_ROOT_FILES.includes(rootRelative)
  ) continue;
  const text = await readFile(file, "utf8");
  const identityBoundaryFile = LEGACY_IDENTITY_BOUNDARY_FILES.has(rootRelative);
  const generatedOutput = isGeneratedLegacyIdentityPath(rootRelative);
  // Source review includes new files. Generated identity mirrors only what Git
  // will package, never ignored build output left behind by a prior phase.
  const inventoryEligible = !generatedOutput || trackedPaths.has(rootRelative);
  if (!identityBoundaryFile && rootRelative !== "scripts/package-smoke.ts") {
    for (const rule of FORBIDDEN_SOURCE) {
      if (rule.pattern.test(text)) {
        sourceProblems.push(`${rootRelative} contains ${rule.label}`);
      }
    }
  }
  if (!identityBoundaryFile && inventoryEligible) {
    const snapshot = legacyIdentitySnapshot(rootRelative, text);
    if (snapshot !== null) legacyIdentitySnapshots.push(snapshot);
    sourceProblems.push(...duplicateIdentityAlternatives(rootRelative, text));
  }
  const unreviewedIdentity = identityBoundaryFile
    ? ""
    : removeReviewedLegacyCompatibility(rootRelative, text);
  if (
    !generatedOutput
    && !inventoriedIdentityPaths.has(rootRelative)
    && LEGACY_IDENTITY.test(unreviewedIdentity)
  ) {
    sourceProblems.push(
      `${rootRelative} contains an unreviewed pre-Atet identity outside serialized or CLI compatibility`,
    );
  }
}

legacyIdentitySnapshots.sort((left, right) => left.path.localeCompare(right.path));

const inventoryProblems = UPDATE_LEGACY_IDENTITY_INVENTORY
  ? []
  : compareLegacyIdentityInventory(
      inventoryEntries,
      legacyIdentitySnapshots,
      trackedPaths,
    );
const inventoryUpdate = UPDATE_LEGACY_IDENTITY_INVENTORY
  ? planLegacyIdentityInventoryUpdate(
      inventoryEntries,
      legacyIdentitySnapshots,
      trackedPaths,
    )
  : { entries: [], problems: [] };

const problems = [
  ...packageProblems,
  ...sourceProblems,
  ...inventoryStructureProblems,
  ...inventoryProblems,
  ...inventoryUpdate.problems,
];
const rootPackage = await readJson(join(ROOT, "package.json"));
const expectedDescription = "Atet, named for Ra's solar barque, is an open-source TypeScript SDK and Bun CLI for carrying ideas and raw assets into images, diagrams, animated loops, and video.";
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
  || Reflect.get(bins, "transmute") !== "./apps/desktop/dist/cli/transmute.js"
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
    ["src/version.ts", `ATET_VERSION = ${JSON.stringify(packageVersion)}`],
  ] as const;
  for (const [path, expected] of versionContracts) {
    if (!(await readFile(join(ROOT, path), "utf8")).includes(expected)) {
      problems.push(`${path} does not match package version ${packageVersion}`);
    }
  }
}
for (const sentinel of CANONICAL_TEXT_SENTINELS) {
  const text = await readFile(join(ROOT, sentinel.path), "utf8");
  for (const value of sentinel.values) {
    if (!text.includes(value)) {
      problems.push(
        `${sentinel.path} is missing canonical Atet sentinel ${JSON.stringify(value)}`,
      );
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

if (UPDATE_LEGACY_IDENTITY_INVENTORY) {
  await writeFile(
    LEGACY_IDENTITY_INVENTORY_PATH,
    `${JSON.stringify(inventoryUpdate.entries, null, 2)}\n`,
  );
  console.log(
    `Updated generated legacy identity inventory across ${inventoryUpdate.entries.length} files.`,
  );
  process.exit(0);
}

console.log(`Standalone boundary verified across ${files.length} source files.`);
