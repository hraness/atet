// @bun
import {
  desktopDownloadPage,
  desktopStatus,
  findDesktopApplication,
  getLatestDesktopRelease,
  installDesktop,
  openInDesktop,
  selectDesktopAsset
} from "./index-h67mtvfj.js";
import {
  bundledSkillPath,
  installSkill,
  pathExists
} from "./index-mjemj725.js";
import {
  TransmuteOperationError,
  executeTransmuteOperation,
  parseTransmuteOperationInput,
  searchTransmuteOperations,
  transmuteOperationCodes,
  transmuteOperationRegistry,
  withTransmuteOperationHostAdmission
} from "./index-m6kydsys.js";
import {
  DiagramValidationError,
  StackLayoutError,
  builtInIcons,
  lintDiagram,
  parseDiagramSource,
  parseDiagramSpec,
  renderPng,
  renderSvg,
  resolveDiagramSource,
  resolveEdge,
  resolveStackLayout,
  sanitizeIcon,
  serializeTldr,
  stackLayoutDefaults
} from "./index-15w61te4.js";
import {
  VectorizeError,
  vectorizeHardLimits,
  vectorizeImage
} from "./index-y5zkj6v2.js";
import {
  generateTransmuteImage,
  generateTransmuteImageFile
} from "./index-mxht0dzb.js";
import {
  loginTransmute,
  logoutTransmute,
  requireTransmuteAuthentication,
  transmuteAuthStatus
} from "./index-3291mzra.js";
import {
  TransmuteCloudError,
  fetchTransmuteDiscovery,
  parseTransmuteDiscovery
} from "./index-yz7y9m2g.js";
import {
  createDefaultHostResourceCoordinator
} from "./index-eq77wsng.js";

// src/artifacts.ts
import { mkdir, readFile as readFile2, rename, rm, writeFile } from "fs/promises";
import { basename, dirname as dirname2, join, resolve as resolve2 } from "path";

// src/config.ts
import { readFile } from "fs/promises";
import { dirname, extname, isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";
var configNames = [
  { current: "transmute.config.ts", legacy: "diagram.config.ts" },
  { current: "transmute.config.mjs", legacy: "diagram.config.mjs" },
  { current: "transmute.config.js", legacy: "diagram.config.js" },
  { current: "transmute.config.json", legacy: "diagram.config.json" }
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseFont(value, at) {
  if (!isRecord(value) || typeof value.family !== "string" || value.family.trim() === "") {
    throw new Error(`${at} must have a non-empty family`);
  }
  if (value.files !== undefined && !Array.isArray(value.files)) {
    throw new Error(`${at}.files must be an array`);
  }
  const files = (value.files ?? []).map((file, index) => {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.trim() === "") {
      throw new Error(`${at}.files[${index}].path must be a non-empty string`);
    }
    if (file.weight !== undefined && (typeof file.weight !== "number" || !Number.isFinite(file.weight))) {
      throw new Error(`${at}.files[${index}].weight must be a finite number`);
    }
    if (file.style !== undefined && file.style !== "normal" && file.style !== "italic") {
      throw new Error(`${at}.files[${index}].style must be normal or italic`);
    }
    if (file.embed !== undefined && typeof file.embed !== "boolean") {
      throw new Error(`${at}.files[${index}].embed must be a boolean`);
    }
    const style = file.style;
    return {
      path: file.path,
      ...file.weight === undefined ? {} : { weight: file.weight },
      ...style === undefined ? {} : { style },
      ...file.embed === undefined ? {} : { embed: file.embed }
    };
  });
  return { family: value.family, ...files.length === 0 ? {} : { files } };
}
function parseIcons(value, at) {
  if (!isRecord(value))
    throw new Error(`${at} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([name, icon]) => {
    if (!isRecord(icon) || typeof icon.viewBox !== "string" || typeof icon.body !== "string") {
      throw new Error(`${at}.${name} must have string viewBox and body fields`);
    }
    return [name, sanitizeIcon({ viewBox: icon.viewBox, body: icon.body })];
  }));
}
function parseTheme(value, at) {
  if (!isRecord(value))
    throw new Error(`${at} must be an object`);
  const scalarKeys = ["background", "foreground", "muted", "stroke"];
  for (const key of scalarKeys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${at}.${key} must be a CSS color string`);
    }
  }
  if (value.tones !== undefined && !isRecord(value.tones)) {
    throw new Error(`${at}.tones must be an object`);
  }
  return value;
}
function parseConfig(value) {
  if (!isRecord(value))
    throw new Error("Transmute config must export an object");
  const font = value.font === undefined ? undefined : parseFont(value.font, "font");
  const icons = value.icons === undefined ? undefined : parseIcons(value.icons, "icons");
  let theme;
  if (value.theme !== undefined) {
    if (!isRecord(value.theme))
      throw new Error("theme must be an object");
    theme = {
      ...value.theme.light === undefined ? {} : { light: parseTheme(value.theme.light, "theme.light") },
      ...value.theme.dark === undefined ? {} : { dark: parseTheme(value.theme.dark, "theme.dark") }
    };
  }
  return {
    ...font === undefined ? {} : { font },
    ...icons === undefined ? {} : { icons: { ...builtInIcons, ...icons } },
    ...theme === undefined ? {} : { theme }
  };
}
async function discoverConfig(directory) {
  for (const names of configNames) {
    const candidate = resolve(directory, names.current);
    if (await pathExists(candidate))
      return candidate;
  }
  for (const names of configNames) {
    const candidate = resolve(directory, names.legacy);
    if (await pathExists(candidate)) {
      const replacement = resolve(directory, names.current);
      throw new Error(`Legacy Transmute config found at ${candidate}. Rename it to ${replacement}; Transmute does not auto-load diagram.config.*.`);
    }
  }
  return null;
}
async function loadDiagramConfig(options) {
  const filePath = options.explicitPath === undefined ? await discoverConfig(options.searchDirectory) : resolve(options.explicitPath);
  if (filePath === null) {
    return {
      filePath: null,
      baseDirectory: options.searchDirectory,
      value: { icons: builtInIcons }
    };
  }
  if (!await pathExists(filePath))
    throw new Error(`Config does not exist: ${filePath}`);
  const raw = extname(filePath) === ".json" ? JSON.parse(await readFile(filePath, "utf8")) : (await import(`${pathToFileURL(filePath).href}?v=${Date.now()}`)).default;
  const value = parseConfig(raw);
  const baseDirectory = dirname(filePath);
  const font = value.font === undefined ? undefined : {
    ...value.font,
    ...value.font.files === undefined ? {} : {
      files: value.font.files.map((file) => ({
        ...file,
        path: isAbsolute(file.path) ? file.path : resolve(baseDirectory, file.path)
      }))
    }
  };
  return {
    filePath,
    baseDirectory,
    value: {
      ...value,
      icons: { ...builtInIcons, ...value.icons },
      ...font === undefined ? {} : { font }
    }
  };
}

// src/artifacts.ts
async function atomicWrite(filePath, data) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
async function readDiagramFile(filePath) {
  const absolutePath = resolve2(filePath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile2(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read diagram JSON at ${absolutePath}`, { cause: error });
  }
  return { absolutePath, spec: parseDiagramSpec(parsed) };
}
async function checkDiagramFile(options) {
  const { absolutePath, spec } = await readDiagramFile(options.filePath);
  const config = await loadDiagramConfig({
    ...options.configPath === undefined ? {} : { explicitPath: options.configPath },
    searchDirectory: dirname2(absolutePath)
  });
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && config.value.icons?.[shape.icon] === undefined) {
      throw new Error(`Unknown icon "${shape.icon}" on shape ${shape.id}`);
    }
  }
  return { findings: lintDiagram(spec), configPath: config.filePath };
}
async function renderDiagramFile(options) {
  const { absolutePath, spec } = await readDiagramFile(options.filePath);
  const outDirectory = resolve2(options.outDirectory ?? dirname2(absolutePath));
  const config = await loadDiagramConfig({
    ...options.configPath === undefined ? {} : { explicitPath: options.configPath },
    searchDirectory: dirname2(absolutePath)
  });
  const scale = options.scale ?? 2;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new Error("PNG scale must be greater than zero and no more than 8");
  }
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", config.value),
    renderSvg(spec, "dark", config.value)
  ]);
  const [lightPng, darkPng] = [renderPng(light, config.value, scale), renderPng(dark, config.value, scale)];
  const artifacts = {
    spec: absolutePath,
    tldr: join(outDirectory, `${spec.name}.tldr`),
    lightSvg: join(outDirectory, `${spec.name}.light.svg`),
    darkSvg: join(outDirectory, `${spec.name}.dark.svg`),
    lightPng: join(outDirectory, `${spec.name}.light.png`),
    darkPng: join(outDirectory, `${spec.name}.dark.png`)
  };
  await mkdir(outDirectory, { recursive: true });
  await Promise.all([
    atomicWrite(artifacts.tldr, serializeTldr(spec, config.value)),
    atomicWrite(artifacts.lightSvg, light.svg),
    atomicWrite(artifacts.darkSvg, dark.svg),
    atomicWrite(artifacts.lightPng, lightPng),
    atomicWrite(artifacts.darkPng, darkPng)
  ]);
  return { artifacts, findings: lintDiagram(spec), configPath: config.filePath };
}
function artifactSummary(artifacts) {
  return [
    `Rendered ${basename(artifacts.spec)}`,
    `  ${artifacts.tldr}`,
    `  ${artifacts.lightSvg}`,
    `  ${artifacts.darkSvg}`,
    `  ${artifacts.lightPng}`,
    `  ${artifacts.darkPng}`
  ].join(`
`);
}

// src/mcp/tools.ts
import { rename as rename2, rm as rm2, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname4, join as join3 } from "path";

// src/mcp/boundary.ts
import { open, mkdir as mkdir2, realpath, stat } from "fs/promises";
import {
  basename as basename2,
  dirname as dirname3,
  isAbsolute as isAbsolute2,
  join as join2,
  relative,
  resolve as resolve3,
  win32
} from "path";
var mcpSourceByteLimit = 1024 * 1024;

class WorkspaceBoundaryError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceBoundaryError";
    this.code = code;
  }
}
function filesystemCode(error) {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return;
}
function normalizeRelativePath(value, options) {
  if (value.length === 0 || value.includes("\x00")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Path must be a non-empty root-relative path.");
  }
  if (isAbsolute2(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Absolute paths are not allowed.");
  }
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Parent-directory traversal is not allowed.");
  }
  if (segments.length === 0) {
    if (!options.allowRoot) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Path must identify a file below the root.");
    }
    return { native: ".", portable: "." };
  }
  return {
    native: segments.join("/"),
    portable: segments.join("/")
  };
}
function isConfined(rootDirectory, target) {
  const fromRoot = relative(rootDirectory, target);
  return fromRoot === "" || !fromRoot.startsWith("..") && !isAbsolute2(fromRoot);
}
async function readUtf8WithCap(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new WorkspaceBoundaryError("SOURCE_NOT_FILE", "Diagram source must be a regular file.");
    }
    if (metadata.size > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`);
    }
    const buffer = Buffer.allocUnsafe(mcpSourceByteLimit + 1);
    let bytesRead = 0;
    while (bytesRead <= mcpSourceByteLimit) {
      const next = await handle.read(buffer, bytesRead, mcpSourceByteLimit + 1 - bytesRead, null);
      if (next.bytesRead === 0)
        break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new WorkspaceBoundaryError("SOURCE_ENCODING", "Diagram source must contain valid UTF-8.");
    }
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError)
      throw error;
    const code = filesystemCode(error);
    if (code === "ENOENT") {
      throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Diagram source does not exist.");
    }
    throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Diagram source could not be read.");
  } finally {
    await handle?.close();
  }
}

class WorkspaceBoundary {
  rootDirectory;
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }
  static async create(rootDirectory) {
    let resolvedRoot;
    try {
      resolvedRoot = await realpath(resolve3(rootDirectory));
      if (!(await stat(resolvedRoot)).isDirectory()) {
        throw new WorkspaceBoundaryError("OUTPUT_NOT_DIRECTORY", "MCP root must be a directory.");
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "MCP root could not be opened.");
    }
    return new WorkspaceBoundary(resolvedRoot);
  }
  assertConfined(target) {
    if (!isConfined(this.rootDirectory, target)) {
      throw new WorkspaceBoundaryError("PATH_OUTSIDE_ROOT", "Path resolves outside the MCP root.");
    }
  }
  toRelativePath(absolutePath) {
    this.assertConfined(absolutePath);
    const fromRoot = relative(this.rootDirectory, absolutePath);
    return fromRoot === "" ? "." : fromRoot.split("\\").join("/");
  }
  async readSource(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const lexicalPath = resolve3(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let canonicalPath;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Diagram source does not exist.");
      }
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Diagram source could not be resolved.");
    }
    this.assertConfined(canonicalPath);
    return {
      absolutePath: canonicalPath,
      relativePath: this.toRelativePath(canonicalPath),
      text: await readUtf8WithCap(canonicalPath)
    };
  }
  async resolveInputFile(value, maximumBytes) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const lexicalPath = resolve3(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let canonicalPath;
    try {
      canonicalPath = await realpath(lexicalPath);
      this.assertConfined(canonicalPath);
      const metadata = await stat(canonicalPath);
      if (!metadata.isFile()) {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FILE", "Input must be a regular file.");
      }
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || metadata.size > maximumBytes) {
        throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Input exceeds the ${maximumBytes}-byte limit.`);
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      if (filesystemCode(error) === "ENOENT") {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Input does not exist.");
      }
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Input could not be resolved.");
    }
    return {
      absolutePath: canonicalPath,
      relativePath: this.toRelativePath(canonicalPath)
    };
  }
  async prepareOutputFile(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const fileName = basename2(normalized.native);
    if (fileName === "." || fileName === ".." || fileName.length === 0) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Output path must identify a file below the root.");
    }
    const directory = await this.prepareOutputDirectory(dirname3(normalized.native));
    const absolutePath = join2(directory.absolutePath, fileName);
    this.assertConfined(absolutePath);
    return {
      absolutePath,
      relativePath: this.toRelativePath(absolutePath)
    };
  }
  async prepareOutputDirectory(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: true });
    const lexicalPath = resolve3(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let ancestor = lexicalPath;
    for (;; ) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        this.assertConfined(canonicalAncestor);
        break;
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError)
          throw error;
        if (filesystemCode(error) !== "ENOENT") {
          throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Output directory could not be resolved.");
        }
        const parent = dirname3(ancestor);
        if (parent === ancestor) {
          throw new WorkspaceBoundaryError("PATH_OUTSIDE_ROOT", "Output directory resolves outside the MCP root.");
        }
        ancestor = parent;
      }
    }
    try {
      await mkdir2(lexicalPath, { recursive: true });
      const canonicalPath = await realpath(lexicalPath);
      this.assertConfined(canonicalPath);
      if (!(await stat(canonicalPath)).isDirectory()) {
        throw new WorkspaceBoundaryError("OUTPUT_NOT_DIRECTORY", "Output path must be a directory.");
      }
      return {
        absolutePath: canonicalPath,
        relativePath: this.toRelativePath(canonicalPath)
      };
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Output directory could not be created.");
    }
  }
}

// src/mcp/tools.ts
var mcpMaximumScale = 4;
var mcpMaximumRenderedPixels = 16777216;
var mcpMaximumShapes = 64;
var mcpMaximumEdges = 128;
var mcpMaximumReturnedFindings = 40;
var defaultScale = 2;
var maximumShapeIdsPerFinding = 12;
var builtInConfig = Object.freeze({ icons: builtInIcons });
var findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "shapeIds"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    shapeIds: { type: "array", items: { type: "string" } }
  }
};
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze(nested);
  return Object.freeze(value);
}
var transmuteMcpTools = deepFreeze([
  {
    name: "check_diagram",
    title: "Check diagram",
    description: "Parse and lint one root-relative Transmute diagram source without changing files. Uses only built-in icons and themes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum)."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "findings", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        findings: { type: "array", items: findingSchema },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated"
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" }
          }
        }
      }
    },
    annotations: {
      title: "Check diagram",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "render_diagram",
    title: "Render diagram",
    description: "Render one root-relative Transmute diagram source with built-in icons and themes, overwriting its paired .tldr, light/dark SVG, and light/dark PNG artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum)."
        },
        out_dir: {
          type: "string",
          description: "Optional root-relative output directory. Defaults to the source directory."
        },
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: mcpMaximumScale,
          default: defaultScale,
          description: "PNG scale. The scaled canvas may contain at most 16,777,216 pixels."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "scale", "findings", "artifacts", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        scale: { type: "number" },
        findings: { type: "array", items: findingSchema },
        artifacts: {
          type: "object",
          additionalProperties: false,
          required: ["tldr", "lightSvg", "darkSvg", "lightPng", "darkPng"],
          properties: {
            tldr: { type: "string" },
            lightSvg: { type: "string" },
            darkSvg: { type: "string" },
            lightPng: { type: "string" },
            darkPng: { type: "string" }
          }
        },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated"
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" }
          }
        }
      }
    },
    annotations: {
      title: "Render diagram",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "search_transmute",
    title: "Search Transmute operations",
    description: "Search the fixed semantic Transmute operation registry by bounded text. This never executes code or changes files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          maxLength: 200,
          description: "Optional terms matched against operation codes and descriptions."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 4
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operations"],
      properties: {
        ok: { const: true },
        operations: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: [
              "code",
              "title",
              "description",
              "execution",
              "authentication",
              "inputSchema"
            ]
          }
        }
      }
    },
    annotations: {
      title: "Search Transmute operations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "execute_transmute",
    title: "Execute Transmute operation",
    description: "Execute one exact operation code with typed JSON input. Never accepts or evaluates source code. Local paths remain confined to the configured workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "input"],
      properties: {
        operation: {
          type: "string",
          enum: transmuteOperationCodes
        },
        input: {
          type: "object",
          description: "Typed input matching the selected operation's registry schema."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operation", "result"],
      properties: {
        ok: { const: true },
        operation: { type: "string", enum: transmuteOperationCodes },
        result: { type: "object" }
      }
    },
    annotations: {
      title: "Execute Transmute operation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }
]);

class ToolFailure extends Error {
  code;
  issues;
  constructor(code, message, issues) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    if (issues !== undefined)
      this.issues = issues;
  }
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeFragment(value, maximumLength = 160) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}
function safeIssues(issues) {
  return issues.slice(0, 24).map((issue) => safeFragment(issue, 240));
}
function rejectUnknownKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ToolFailure("INVALID_ARGUMENTS", `Unsupported argument: ${safeFragment(unknown[0] ?? "unknown")}.`);
  }
}
function parsePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolFailure("INVALID_ARGUMENTS", "path must be a non-empty root-relative string.");
  }
  if (!value.toLowerCase().endsWith(".diagram.json")) {
    throw new ToolFailure("INVALID_ARGUMENTS", "path must end in .diagram.json.");
  }
  return value;
}
function parseCheckArguments(value) {
  if (!isRecord2(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["path"]));
  return { path: parsePath(value.path) };
}
function parseRenderArguments(value) {
  if (!isRecord2(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["path", "out_dir", "scale"]));
  const outDirectory = value.out_dir;
  if (outDirectory !== undefined && (typeof outDirectory !== "string" || outDirectory.length === 0)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "out_dir must be a non-empty root-relative string when present.");
  }
  const scale = value.scale ?? defaultScale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > mcpMaximumScale) {
    throw new ToolFailure("RENDER_LIMIT", `scale must be greater than zero and no more than ${mcpMaximumScale}.`);
  }
  return {
    path: parsePath(value.path),
    ...outDirectory === undefined ? {} : { outDirectory },
    scale
  };
}
function parseSearchArguments(value) {
  if (!isRecord2(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["query", "limit"]));
  const query = value.query ?? "";
  const limit = value.limit ?? transmuteOperationCodes.length;
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ToolFailure("INVALID_ARGUMENTS", "query must be a bounded string and limit must be an integer from 1 through 20.");
  }
  return { query, limit };
}
function parseExecuteArguments(value) {
  if (!isRecord2(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["operation", "input"]));
  if (typeof value.operation !== "string" || !transmuteOperationCodes.includes(value.operation) || !isRecord2(value.input)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "operation must be an exact Transmute operation code and input must be an object.");
  }
  return {
    operation: value.operation,
    input: value.input
  };
}
function assertBuiltInIcons(spec) {
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && !Object.hasOwn(builtInIcons, shape.icon)) {
      throw new ToolFailure("UNKNOWN_ICON", `Shape ${safeFragment(shape.id)} requests unavailable built-in icon ${safeFragment(shape.icon)}.`);
    }
  }
}
function assertComplexityLimits(spec) {
  const edgeCount = spec.edges?.length ?? 0;
  if (spec.shapes.length > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure("COMPLEXITY_LIMIT", `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`);
  }
}
function assertRawComplexityLimits(value) {
  if (!isRecord2(value))
    return;
  const shapeCount = Array.isArray(value.shapes) ? value.shapes.length : 0;
  const edgeCount = Array.isArray(value.edges) ? value.edges.length : 0;
  if (shapeCount > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure("COMPLEXITY_LIMIT", `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`);
  }
}
function assertRenderLimits(spec, scale) {
  const scaledWidth = spec.canvas.width * scale;
  const scaledHeight = spec.canvas.height * scale;
  const pixels = Math.ceil(scaledWidth) * Math.ceil(scaledHeight);
  if (!Number.isFinite(pixels) || scaledWidth < 1 || scaledHeight < 1 || pixels > mcpMaximumRenderedPixels) {
    throw new ToolFailure("RENDER_LIMIT", `Scaled canvas must be at least 1 pixel on each axis and no more than ${mcpMaximumRenderedPixels.toLocaleString("en-US")} pixels total.`);
  }
}
function publicFinding(finding) {
  return {
    code: safeFragment(finding.code, 64),
    message: safeFragment(finding.message, 240),
    shapeIds: finding.shapeIds.slice(0, maximumShapeIdsPerFinding).map((shapeId) => safeFragment(shapeId, 120))
  };
}
function publicFindings(findings) {
  return findings.slice(0, mcpMaximumReturnedFindings).map(publicFinding);
}
function diagramSummary(spec, findingCount, returnedFindingCount) {
  return {
    shapeCount: spec.shapes.length,
    edgeCount: spec.edges?.length ?? 0,
    findingCount,
    returnedFindingCount,
    findingsTruncated: returnedFindingCount < findingCount
  };
}
function successResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}
function failureResult(error) {
  let code = "INTERNAL_ERROR";
  let message = "The tool failed safely.";
  let issues;
  if (error instanceof ToolFailure) {
    code = error.code;
    message = safeFragment(error.message, 320);
    issues = error.issues;
  } else if (error instanceof WorkspaceBoundaryError) {
    code = error.code;
    message = safeFragment(error.message, 320);
  } else if (error instanceof TransmuteCloudError) {
    code = error.code;
    message = safeFragment(error.message.replace(/^\[[A-Z_]+\]\s*/u, ""), 320);
  } else if (error instanceof TransmuteOperationError) {
    code = error.code;
    message = safeFragment(error.message.replace(/^\[[A-Z_]+\]\s*/u, ""), 320);
  } else if (error instanceof VectorizeError) {
    code = `VECTORIZE_${error.code.toUpperCase()}`;
    message = "Local vectorization failed safely.";
  } else if (error instanceof DiagramValidationError) {
    code = "INVALID_DIAGRAM";
    message = "Diagram source did not pass validation.";
    issues = safeIssues(error.issues);
  } else if (typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues) && error.issues.every((issue) => typeof issue === "string")) {
    code = "INVALID_LAYOUT";
    message = "Diagram layout could not be resolved.";
    issues = safeIssues(error.issues);
  }
  const issueText = issues === undefined || issues.length === 0 ? "" : `
${issues.map((issue) => `- ${issue}`).join(`
`)}`;
  return {
    content: [{ type: "text", text: `[${code}] ${message}${issueText}` }],
    isError: true
  };
}
function portableDirectory(filePath) {
  const separator = filePath.lastIndexOf("/");
  return separator === -1 ? "." : filePath.slice(0, separator);
}
async function atomicOverwrite(filePath, data) {
  const temporaryPath = join3(dirname4(filePath), `.${crypto.randomUUID()}.transmute-mcp.tmp`);
  try {
    await writeFile2(temporaryPath, data, { flag: "wx" });
    try {
      await rename2(temporaryPath, filePath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code !== "EEXIST" && code !== "EPERM")
        throw error;
      await rm2(filePath, { force: true });
      await rename2(temporaryPath, filePath);
    }
  } finally {
    await rm2(temporaryPath, { force: true });
  }
}
async function loadDiagram(boundary, path) {
  const source = await boundary.readSource(path);
  let parsed;
  try {
    parsed = JSON.parse(source.text);
  } catch {
    throw new ToolFailure("INVALID_JSON", "Diagram source is not valid JSON.");
  }
  assertRawComplexityLimits(parsed);
  const spec = parseDiagramSpec(parsed);
  assertComplexityLimits(spec);
  assertBuiltInIcons(spec);
  return { source, spec };
}

class TransmuteMcpToolRuntime {
  boundary;
  authDependencies;
  hostResourceCoordinator;
  renderQueue = Promise.resolve();
  constructor(boundary, authDependencies, hostResourceCoordinator) {
    this.boundary = boundary;
    this.authDependencies = authDependencies;
    this.hostResourceCoordinator = hostResourceCoordinator;
  }
  static async create(rootDirectory, authDependencies = {}, hostResourceCoordinator) {
    return new TransmuteMcpToolRuntime(await WorkspaceBoundary.create(rootDirectory), authDependencies, hostResourceCoordinator ?? createDefaultHostResourceCoordinator());
  }
  async withHostAdmission(operation, callback) {
    return await withTransmuteOperationHostAdmission(operation, callback, {
      hostResourceCoordinator: this.hostResourceCoordinator
    });
  }
  enqueueRender(operation) {
    const result = this.renderQueue.then(operation, operation);
    this.renderQueue = result.then(() => {
      return;
    }, () => {
      return;
    });
    return result;
  }
  async call(name, argumentsValue) {
    try {
      if (name === "check_diagram") {
        const options = parseCheckArguments(argumentsValue);
        return await this.withHostAdmission("transmute.diagram.check", async () => await this.check(options));
      }
      if (name === "render_diagram") {
        const options = parseRenderArguments(argumentsValue);
        return await this.enqueueRender(async () => await this.withHostAdmission("transmute.diagram.render", async () => await this.render(options)));
      }
      if (name === "search_transmute") {
        const options = parseSearchArguments(argumentsValue);
        const operations = searchTransmuteOperations(options.query, options.limit);
        return successResult(`Found ${operations.length} Transmute operation${operations.length === 1 ? "" : "s"}.`, { ok: true, operations });
      }
      if (name === "execute_transmute") {
        const options = parseExecuteArguments(argumentsValue);
        return await this.execute(options);
      }
      throw new ToolFailure("UNKNOWN_TOOL", "Requested tool is not available.");
    } catch (error) {
      return failureResult(error);
    }
  }
  wrapSemanticResult(operation, result) {
    if (result.isError === true)
      return result;
    return {
      content: result.content,
      structuredContent: {
        ok: true,
        operation,
        result: result.structuredContent ?? {}
      }
    };
  }
  async execute(options) {
    if (options.operation === "transmute.diagram.check") {
      const input = parseTransmuteOperationInput(options.operation, options.input);
      return this.wrapSemanticResult(options.operation, await this.withHostAdmission(options.operation, async () => await this.check({ path: input.path })));
    }
    if (options.operation === "transmute.diagram.render") {
      const input = parseTransmuteOperationInput(options.operation, options.input);
      return this.enqueueRender(async () => await this.withHostAdmission(options.operation, async () => this.wrapSemanticResult(options.operation, await this.render({
        path: input.path,
        ...input.outDirectory === undefined ? {} : { outDirectory: input.outDirectory },
        scale: input.scale ?? defaultScale
      }))));
    }
    if (options.operation === "transmute.image.vectorize") {
      const input = parseTransmuteOperationInput(options.operation, options.input);
      return this.enqueueRender(async () => await this.withHostAdmission(options.operation, async (lease) => {
        const source = await this.boundary.resolveInputFile(input.inputPath, vectorizeHardLimits.maxInputBytes);
        const output = await this.boundary.prepareOutputFile(input.outputPath);
        const result = await vectorizeImage(source.absolutePath, {
          outputPath: output.absolutePath,
          ...input.duotone === undefined ? {} : { duotone: input.duotone },
          ...input.alphaCutoff === undefined ? {} : { alphaCutoff: input.alphaCutoff },
          ...input.timeoutMs === undefined ? {} : { limits: { maxDurationMs: input.timeoutMs } },
          inheritedFileDescriptors: [lease.inheritedFileDescriptor]
        });
        return successResult(`Executed ${options.operation}: ${output.relativePath}`, {
          ok: true,
          operation: options.operation,
          result: {
            inputPath: source.relativePath,
            outputPath: output.relativePath,
            receipt: result.receipt
          }
        });
      }));
    }
    return await this.withHostAdmission(options.operation, async () => {
      const input = parseTransmuteOperationInput(options.operation, options.input);
      const discovery = await requireTransmuteAuthentication(this.authDependencies);
      const output = await this.boundary.prepareOutputFile(input.outputPath);
      const generated = await generateTransmuteImageFile({ ...input, outputPath: output.absolutePath }, { ...this.authDependencies, discovery });
      return successResult(`Executed ${options.operation}: ${output.relativePath} (request ${safeFragment(generated.requestId, 256)}).`, {
        ok: true,
        operation: options.operation,
        result: {
          bytes: generated.bytes,
          idempotencyKey: generated.idempotencyKey,
          mediaType: generated.mediaType,
          model: generated.model,
          outputPath: output.relativePath,
          requestId: generated.requestId
        }
      });
    });
  }
  async check(options) {
    const { source, spec } = await loadDiagram(this.boundary, options.path);
    const allFindings = lintDiagram(spec);
    const findings = publicFindings(allFindings);
    const summary = diagramSummary(spec, allFindings.length, findings.length);
    const text = allFindings.length === 0 ? `Checked ${source.relativePath}: no findings.` : `Checked ${source.relativePath}: ${allFindings.length} finding${allFindings.length === 1 ? "" : "s"}; ${findings.length} returned in structured content${findings.length < allFindings.length ? " (truncated)" : ""}.`;
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      findings,
      summary
    });
  }
  async render(options) {
    const { source, spec } = await loadDiagram(this.boundary, options.path);
    assertRenderLimits(spec, options.scale);
    const outputDirectory = await this.boundary.prepareOutputDirectory(options.outDirectory ?? portableDirectory(source.relativePath));
    const tldr = serializeTldr(spec, builtInConfig);
    const [light, dark] = await Promise.all([
      renderSvg(spec, "light", builtInConfig),
      renderSvg(spec, "dark", builtInConfig)
    ]);
    const lightPng = renderPng(light, builtInConfig, options.scale);
    const darkPng = renderPng(dark, builtInConfig, options.scale);
    const absoluteArtifacts = {
      spec: source.absolutePath,
      tldr: join3(outputDirectory.absolutePath, `${spec.name}.tldr`),
      lightSvg: join3(outputDirectory.absolutePath, `${spec.name}.light.svg`),
      darkSvg: join3(outputDirectory.absolutePath, `${spec.name}.dark.svg`),
      lightPng: join3(outputDirectory.absolutePath, `${spec.name}.light.png`),
      darkPng: join3(outputDirectory.absolutePath, `${spec.name}.dark.png`)
    };
    await Promise.all([
      atomicOverwrite(absoluteArtifacts.tldr, tldr),
      atomicOverwrite(absoluteArtifacts.lightSvg, light.svg),
      atomicOverwrite(absoluteArtifacts.darkSvg, dark.svg),
      atomicOverwrite(absoluteArtifacts.lightPng, lightPng),
      atomicOverwrite(absoluteArtifacts.darkPng, darkPng)
    ]);
    const artifacts = {
      tldr: this.boundary.toRelativePath(absoluteArtifacts.tldr),
      lightSvg: this.boundary.toRelativePath(absoluteArtifacts.lightSvg),
      darkSvg: this.boundary.toRelativePath(absoluteArtifacts.darkSvg),
      lightPng: this.boundary.toRelativePath(absoluteArtifacts.lightPng),
      darkPng: this.boundary.toRelativePath(absoluteArtifacts.darkPng)
    };
    const allFindings = lintDiagram(spec);
    const findings = publicFindings(allFindings);
    const summary = diagramSummary(spec, allFindings.length, findings.length);
    const text = [
      `Rendered ${source.relativePath} with built-in assets:`,
      ...Object.values(artifacts).map((artifact) => `- ${artifact}`)
    ].join(`
`);
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      scale: options.scale,
      findings,
      artifacts,
      summary
    });
  }
}

// src/mcp/server.ts
var transmuteMcpProtocolVersion = "2025-11-25";
var transmuteMcpServerName = "hraness-transmute";
var maximumMessageBytes = 1024 * 1024;
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonRpcId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
}
function isInitializeParams(value) {
  return isRecord3(value) && typeof value.protocolVersion === "string" && isRecord3(value.capabilities) && isRecord3(value.clientInfo) && typeof value.clientInfo.name === "string" && typeof value.clientInfo.version === "string";
}
function parseRequest(value) {
  if (!isRecord3(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || "id" in value && !isJsonRpcId(value.id)) {
    throw new Error("invalid request");
  }
  return {
    jsonrpc: "2.0",
    ..."id" in value ? { id: value.id } : {},
    method: value.method,
    ..."params" in value ? { params: value.params } : {}
  };
}
function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function parseToolCall(params) {
  if (!isRecord3(params) || typeof params.name !== "string" || params.arguments !== undefined && !isRecord3(params.arguments)) {
    throw new Error("invalid params");
  }
  const unknownKeys = Object.keys(params).filter((key) => key !== "name" && key !== "arguments");
  if (unknownKeys.length > 0)
    throw new Error("invalid params");
  return {
    name: params.name,
    argumentsValue: params.arguments ?? {}
  };
}

class TransmuteMcpSession {
  runtime;
  serverVersion;
  state = "new";
  constructor(runtime, serverVersion) {
    this.runtime = runtime;
    this.serverVersion = serverVersion;
  }
  async handle(value) {
    let request;
    try {
      request = parseRequest(value);
    } catch {
      return failure(null, -32600, "Invalid Request");
    }
    const notification = request.id === undefined;
    if (request.method === "notifications/initialized") {
      if (!notification) {
        return failure(request.id, -32600, "Invalid Request");
      }
      if (this.state === "initializing")
        this.state = "ready";
      return null;
    }
    if (notification)
      return null;
    const id = request.id;
    if (request.method === "initialize") {
      if (this.state !== "new" || !isInitializeParams(request.params)) {
        return failure(id, -32602, "Invalid initialize parameters");
      }
      this.state = "initializing";
      return success(id, {
        protocolVersion: transmuteMcpProtocolVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: transmuteMcpServerName,
          version: this.serverVersion
        },
        instructions: "Use the compatibility check_diagram/render_diagram tools or search_transmute followed by execute_transmute with an exact registry code and typed JSON. Local paths are root-relative; source code is never accepted or evaluated."
      });
    }
    if (this.state !== "ready") {
      return failure(id, -32002, "Server is not initialized");
    }
    if (request.method === "ping")
      return success(id, {});
    if (request.method === "tools/list") {
      if (request.params !== undefined && (!isRecord3(request.params) || Object.keys(request.params).length > 0)) {
        return failure(id, -32602, "Invalid tools/list parameters");
      }
      return success(id, { tools: transmuteMcpTools });
    }
    if (request.method === "tools/call") {
      try {
        const toolCall = parseToolCall(request.params);
        if (!transmuteMcpTools.some((tool) => tool.name === toolCall.name)) {
          return failure(id, -32602, "Unknown tool");
        }
        return success(id, await this.runtime.call(toolCall.name, toolCall.argumentsValue));
      } catch {
        return failure(id, -32602, "Invalid tools/call parameters");
      }
    }
    return failure(id, -32601, "Method not found");
  }
}
async function defaultWriteLine(line) {
  await new Promise((resolve4, reject) => {
    process.stdout.write(`${line}
`, (error) => {
      if (error === null || error === undefined)
        resolve4();
      else
        reject(error);
    });
  });
}
function defaultInput() {
  return process.stdin;
}
async function emitResponse(writeLine, response) {
  await writeLine(JSON.stringify(response));
}
async function processLine(line, session, writeLine) {
  if (line.byteLength === 0)
    return;
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    if (text.trim() === "")
      return;
    value = JSON.parse(text);
  } catch {
    await emitResponse(writeLine, failure(null, -32700, "Parse error"));
    return;
  }
  if (Array.isArray(value)) {
    await emitResponse(writeLine, failure(null, -32600, "Invalid Request"));
    return;
  }
  const response = await session.handle(value);
  if (response !== null)
    await emitResponse(writeLine, response);
}
async function runMcpServer(options = {}) {
  const runtime = await TransmuteMcpToolRuntime.create(options.rootDirectory ?? process.cwd(), options.authDependencies);
  const session = new TransmuteMcpSession(runtime, options.serverVersion ?? "0.9.0");
  const writeLine = options.writeLine ?? defaultWriteLine;
  let buffered = Buffer.alloc(0);
  for await (const chunk of options.input ?? defaultInput()) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    buffered = Buffer.concat([buffered, bytes]);
    if (buffered.byteLength > maximumMessageBytes && !buffered.includes(10)) {
      buffered = Buffer.alloc(0);
      await emitResponse(writeLine, failure(null, -32700, "Parse error"));
      continue;
    }
    for (;; ) {
      const newline = buffered.indexOf(10);
      if (newline === -1)
        break;
      let line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.at(-1) === 13)
        line = line.subarray(0, -1);
      if (line.byteLength > maximumMessageBytes) {
        await emitResponse(writeLine, failure(null, -32700, "Parse error"));
      } else {
        await processLine(line, session, writeLine);
      }
    }
  }
  if (buffered.byteLength > 0) {
    if (buffered.byteLength > maximumMessageBytes) {
      await emitResponse(writeLine, failure(null, -32700, "Parse error"));
    } else {
      await processLine(buffered, session, writeLine);
    }
  }
}
// src/index.ts
var diagramApi = Object.freeze({
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  DiagramValidationError,
  findDesktopApplication,
  fetchTransmuteDiscovery,
  generateTransmuteImage,
  generateTransmuteImageFile,
  getLatestDesktopRelease,
  transmuteAuthStatus,
  transmuteMcpProtocolVersion,
  transmuteMcpServerName,
  transmuteMcpTools,
  transmuteOperationRegistry,
  TransmuteMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  loginTransmute,
  logoutTransmute,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  parseTransmuteDiscovery,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveEdge,
  resolveDiagramSource,
  resolveStackLayout,
  requireTransmuteAuthentication,
  runMcpServer,
  searchTransmuteOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeTransmuteOperation
});
export { readDiagramFile, checkDiagramFile, renderDiagramFile, artifactSummary, mcpSourceByteLimit, WorkspaceBoundaryError, WorkspaceBoundary, mcpMaximumScale, mcpMaximumRenderedPixels, transmuteMcpTools, TransmuteMcpToolRuntime, transmuteMcpProtocolVersion, transmuteMcpServerName, runMcpServer, diagramApi };
