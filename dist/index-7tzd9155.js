// @bun
import {
  bundledSkillPath,
  installSkill,
  pathExists
} from "./index-7308egqr.js";
import {
  SlopcameraCodeError,
  boundedCanonicalJsonSha256,
  canonicalJson,
  compareUtf16Strings,
  createBoundedJsonValueSnapshot,
  deepFreezeJson
} from "./index-8txs6fkn.js";
import {
  SlopcameraWorkflowError,
  defineSlopcameraWorkflow,
  runSlopcameraWorkflow
} from "./index-mcy8z0br.js";
import {
  DiagramValidationError,
  SlopcameraOperationError,
  StackLayoutError,
  builtInIcons,
  executeSlopcameraOperation,
  lintDiagram,
  parseDiagramSource,
  parseDiagramSpec,
  parseSlopcameraOperationInput,
  renderPng,
  renderSvg,
  resolveDiagramSource,
  resolveEdge,
  resolveStackLayout,
  sanitizeIcon,
  searchSlopcameraOperations,
  serializeTldr,
  slopcameraOperationCodes,
  slopcameraOperationRegistry,
  stackLayoutDefaults,
  withSlopcameraOperationHostAdmission
} from "./index-z7239b4h.js";
import {
  VectorizeError,
  nonGatewayChildEnvironment,
  vectorizeHardLimits,
  vectorizeImage
} from "./index-p63wavx0.js";
import {
  SlopcameraCloudError,
  generateSlopcameraImage,
  generateSlopcameraImageFile,
  slopcameraGatewayCredentialStatus
} from "./index-r7gdhmsp.js";
import {
  createDefaultHostResourceCoordinator
} from "./index-sh6xbav6.js";

// src/artifacts.ts
import { mkdir, readFile as readFile2, rename, rm, writeFile } from "fs/promises";
import { basename, dirname as dirname2, join, resolve as resolve2 } from "path";

// src/config.ts
import { readFile } from "fs/promises";
import { dirname, extname, isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";
var configNames = [
  { current: "slopcamera.config.ts", retired: "diagram.config.ts" },
  { current: "slopcamera.config.mjs", retired: "diagram.config.mjs" },
  { current: "slopcamera.config.js", retired: "diagram.config.js" },
  { current: "slopcamera.config.json", retired: "diagram.config.json" }
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
  if (value.monoFamily !== undefined && (typeof value.monoFamily !== "string" || value.monoFamily.trim() === "")) {
    throw new Error(`${at}.monoFamily must be a non-empty string when present`);
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
  return {
    family: value.family,
    ...value.monoFamily === undefined ? {} : { monoFamily: value.monoFamily },
    ...files.length === 0 ? {} : { files }
  };
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
    throw new Error("Slopcamera config must export an object");
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
  let current = null;
  for (const names of configNames) {
    const candidate = resolve(directory, names.current);
    if (await pathExists(candidate)) {
      current = candidate;
      break;
    }
  }
  if (current !== null)
    return current;
  for (const names of configNames) {
    const candidate = resolve(directory, names.retired);
    if (await pathExists(candidate)) {
      const replacement = resolve(directory, names.current);
      throw new Error(`Legacy Slopcamera config found at ${candidate}. Rename it to ${replacement}; Slopcamera does not auto-load diagram.config.*.`);
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

// src/desktop.ts
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { chmod, mkdir as mkdir2, readFile as readFile3, rename as rename2, rm as rm2 } from "fs/promises";
import { homedir, platform as hostPlatform, arch as hostArch } from "os";
import { dirname as dirname3, join as join2, resolve as resolve3 } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
var releaseApi = "https://api.github.com/repos/tldraw/tldraw-offline/releases/latest";
var desktopDownloadPage = "https://offline.tldraw.com";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseRelease(value) {
  if (!isRecord2(value) || typeof value.tag_name !== "string" || typeof value.html_url !== "string" || !Array.isArray(value.assets)) {
    throw new Error("GitHub returned an invalid tldraw Offline release");
  }
  const assets = value.assets.map((asset, index) => {
    if (!isRecord2(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string" || typeof asset.size !== "number" || asset.digest !== null && asset.digest !== undefined && typeof asset.digest !== "string") {
      throw new Error(`GitHub returned an invalid release asset at index ${index}`);
    }
    return {
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest ?? null
    };
  });
  return { tag_name: value.tag_name, html_url: value.html_url, assets };
}
function selectDesktopAsset(release, platform = hostPlatform(), architecture = hostArch()) {
  const expectedName = platform === "darwin" ? "tldraw-offline-mac-universal.dmg" : platform === "win32" ? architecture === "arm64" ? "tldraw-offline-win-arm64.exe" : "tldraw-offline-win-x64.exe" : platform === "linux" ? architecture === "arm64" ? "tldraw-offline-linux-arm64.AppImage" : "tldraw-offline-linux-x86_64.AppImage" : null;
  if (expectedName === null) {
    throw new Error(`tldraw Offline has no automated installer for ${platform}/${architecture}`);
  }
  const asset = release.assets.find((candidate) => candidate.name === expectedName);
  if (asset === undefined) {
    throw new Error(`The latest tldraw Offline release does not contain ${expectedName}`);
  }
  return asset;
}
async function getLatestDesktopRelease() {
  const response = await fetch(releaseApi, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "hraness-slopcamera",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok)
    throw new Error(`GitHub release lookup failed with HTTP ${response.status}`);
  return parseRelease(await response.json());
}
async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath))
    hash.update(chunk);
  return hash.digest("hex");
}
async function download(asset, filePath) {
  const response = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "hraness-slopcamera" },
    redirect: "follow"
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Installer download failed with HTTP ${response.status}`);
  }
  const temporary = `${filePath}.part-${process.pid}`;
  await mkdir2(dirname3(filePath), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 384 }));
    const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null;
    if (expected === null) {
      throw new Error("GitHub did not publish a SHA-256 digest for this installer");
    }
    const actual = await sha256(temporary);
    if (actual !== expected) {
      throw new Error(`Installer checksum mismatch: expected ${expected}, received ${actual}`);
    }
    await rename2(temporary, filePath);
  } catch (error) {
    await rm2(temporary, { force: true });
    throw error;
  }
}
function spawnDetached(command) {
  const child = Bun.spawn([...command], {
    env: nonGatewayChildEnvironment(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  });
  child.unref();
}
async function installDesktop(options) {
  const release = await getLatestDesktopRelease();
  const asset = selectDesktopAsset(release);
  const cacheDirectory = join2(homedir(), ".cache", "slopcamera", "installers", release.tag_name);
  const installerPath = join2(cacheDirectory, asset.name);
  let reusable = false;
  if (await pathExists(installerPath)) {
    const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null;
    reusable = expected !== null && await sha256(installerPath) === expected;
  }
  if (!reusable)
    await download(asset, installerPath);
  if (hostPlatform() === "linux") {
    const installedPath = join2(homedir(), ".local", "bin", "tldraw-offline");
    await mkdir2(dirname3(installedPath), { recursive: true });
    const temporary = `${installedPath}.tmp-${process.pid}`;
    await Bun.write(temporary, Bun.file(installerPath));
    await chmod(temporary, 493);
    await rename2(temporary, installedPath);
    if (!options.downloadOnly)
      spawnDetached([installedPath]);
    return { filePath: installedPath, release: release.tag_name };
  }
  if (!options.downloadOnly) {
    if (hostPlatform() === "darwin") {
      spawnDetached(["open", installerPath]);
    } else {
      spawnDetached(["cmd.exe", "/d", "/s", "/c", "start", "", installerPath]);
    }
  }
  return { filePath: installerPath, release: release.tag_name };
}
async function findDesktopApplication() {
  const candidates = hostPlatform() === "darwin" ? [
    "/Applications/tldraw offline.app",
    join2(homedir(), "Applications", "tldraw offline.app")
  ] : hostPlatform() === "linux" ? [join2(homedir(), ".local", "bin", "tldraw-offline")] : [
    join2(process.env.LOCALAPPDATA ?? join2(homedir(), "AppData", "Local"), "Programs", "tldraw offline", "tldraw offline.exe")
  ];
  for (const candidate of candidates)
    if (await pathExists(candidate))
      return candidate;
  return null;
}
function serverFilePath() {
  if (hostPlatform() === "darwin") {
    return join2(homedir(), "Library", "Application Support", "tldraw", "server.json");
  }
  if (hostPlatform() === "win32") {
    return join2(process.env.APPDATA ?? join2(homedir(), "AppData", "Roaming"), "tldraw", "server.json");
  }
  return join2(process.env.XDG_CONFIG_HOME ?? join2(homedir(), ".config"), "tldraw", "server.json");
}
async function desktopStatus() {
  const installedPath = await findDesktopApplication();
  const filePath = serverFilePath();
  if (!await pathExists(filePath))
    return { installedPath, server: null };
  try {
    const parsed = JSON.parse(await readFile3(filePath, "utf8"));
    if (!isRecord2(parsed) || typeof parsed.port !== "number") {
      return { installedPath, server: null };
    }
    return {
      installedPath,
      server: {
        port: parsed.port,
        pid: typeof parsed.pid === "number" ? parsed.pid : null
      }
    };
  } catch {
    return { installedPath, server: null };
  }
}
async function openInDesktop(filePath) {
  const absolutePath = resolve3(filePath);
  if (!await pathExists(absolutePath))
    throw new Error(`File does not exist: ${absolutePath}`);
  const application = await findDesktopApplication();
  if (application === null) {
    throw new Error(`tldraw Offline is not installed. Run "slopcamera canvas install" or visit ${desktopDownloadPage}`);
  }
  if (hostPlatform() === "darwin") {
    spawnDetached(["open", "-a", application, absolutePath]);
  } else if (hostPlatform() === "win32") {
    spawnDetached(["cmd.exe", "/d", "/s", "/c", "start", "", absolutePath]);
  } else {
    spawnDetached([application, absolutePath]);
  }
}

// src/mcp/tools.ts
import { rename as rename3, rm as rm3, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname5, join as join4 } from "path";

// src/mcp/boundary.ts
import { open, mkdir as mkdir3, realpath, stat } from "fs/promises";
import {
  basename as basename2,
  dirname as dirname4,
  isAbsolute as isAbsolute2,
  join as join3,
  relative,
  resolve as resolve4,
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
      resolvedRoot = await realpath(resolve4(rootDirectory));
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
    const lexicalPath = resolve4(this.rootDirectory, normalized.native);
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
    const lexicalPath = resolve4(this.rootDirectory, normalized.native);
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
    const directory = await this.prepareOutputDirectory(dirname4(normalized.native));
    const absolutePath = join3(directory.absolutePath, fileName);
    this.assertConfined(absolutePath);
    return {
      absolutePath,
      relativePath: this.toRelativePath(absolutePath)
    };
  }
  async prepareOutputDirectory(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: true });
    const lexicalPath = resolve4(this.rootDirectory, normalized.native);
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
        const parent = dirname4(ancestor);
        if (parent === ancestor) {
          throw new WorkspaceBoundaryError("PATH_OUTSIDE_ROOT", "Output directory resolves outside the MCP root.");
        }
        ancestor = parent;
      }
    }
    try {
      await mkdir3(lexicalPath, { recursive: true });
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
var slopcameraMcpTools = deepFreeze([
  {
    name: "check_diagram",
    title: "Check diagram",
    description: "Parse and lint one root-relative Slopcamera diagram source without changing files. Uses only built-in icons and themes.",
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
    description: "Render one root-relative Slopcamera diagram source with built-in icons and themes, overwriting its paired .tldr, light/dark SVG, and light/dark PNG artifacts.",
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
    name: "search_slopcamera",
    title: "Search Slopcamera operations",
    description: "Search the fixed semantic Slopcamera operation registry by bounded text. This never executes code or changes files.",
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
      title: "Search Slopcamera operations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "execute_slopcamera",
    title: "Execute Slopcamera operation",
    description: "Execute one exact operation code with typed JSON input. Never accepts or evaluates source code. Local paths remain confined to the configured workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "input"],
      properties: {
        operation: {
          type: "string",
          enum: slopcameraOperationCodes
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
        operation: { type: "string", enum: slopcameraOperationCodes },
        result: { type: "object" }
      }
    },
    annotations: {
      title: "Execute Slopcamera operation",
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
function isRecord3(value) {
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
  if (!isRecord3(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["path"]));
  return { path: parsePath(value.path) };
}
function parseRenderArguments(value) {
  if (!isRecord3(value)) {
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
  if (!isRecord3(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["query", "limit"]));
  const query = value.query ?? "";
  const limit = value.limit ?? slopcameraOperationCodes.length;
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ToolFailure("INVALID_ARGUMENTS", "query must be a bounded string and limit must be an integer from 1 through 20.");
  }
  return { query, limit };
}
function parseExecuteArguments(value) {
  if (!isRecord3(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["operation", "input"]));
  if (typeof value.operation !== "string" || !slopcameraOperationCodes.includes(value.operation) || !isRecord3(value.input)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "operation must be an exact Slopcamera operation code and input must be an object.");
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
  if (!isRecord3(value))
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
  } else if (error instanceof SlopcameraCloudError) {
    code = error.code;
    message = safeFragment(error.message.replace(/^\[[A-Z_]+\]\s*/u, ""), 320);
  } else if (error instanceof SlopcameraOperationError) {
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
  const temporaryPath = join4(dirname5(filePath), `.${crypto.randomUUID()}.slopcamera-mcp.tmp`);
  try {
    await writeFile2(temporaryPath, data, { flag: "wx" });
    try {
      await rename3(temporaryPath, filePath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code !== "EEXIST" && code !== "EPERM")
        throw error;
      await rm3(filePath, { force: true });
      await rename3(temporaryPath, filePath);
    }
  } finally {
    await rm3(temporaryPath, { force: true });
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

class SlopcameraMcpToolRuntime {
  boundary;
  generateDependencies;
  hostResourceCoordinator;
  renderQueue = Promise.resolve();
  constructor(boundary, generateDependencies, hostResourceCoordinator) {
    this.boundary = boundary;
    this.generateDependencies = generateDependencies;
    this.hostResourceCoordinator = hostResourceCoordinator;
  }
  static async create(rootDirectory, generateDependencies = {}, hostResourceCoordinator) {
    return new SlopcameraMcpToolRuntime(await WorkspaceBoundary.create(rootDirectory), generateDependencies, hostResourceCoordinator ?? createDefaultHostResourceCoordinator());
  }
  async withHostAdmission(operation, callback) {
    return await withSlopcameraOperationHostAdmission(operation, callback, {
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
        return await this.withHostAdmission("slopcamera.diagram.check", async () => await this.check(options));
      }
      if (name === "render_diagram") {
        const options = parseRenderArguments(argumentsValue);
        return await this.enqueueRender(async () => await this.withHostAdmission("slopcamera.diagram.render", async () => await this.render(options)));
      }
      if (name === "search_slopcamera") {
        const options = parseSearchArguments(argumentsValue);
        const operations = searchSlopcameraOperations(options.query, options.limit);
        return successResult(`Found ${operations.length} Slopcamera operation${operations.length === 1 ? "" : "s"}.`, { ok: true, operations });
      }
      if (name === "execute_slopcamera") {
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
    if (options.operation === "slopcamera.diagram.check") {
      const input = parseSlopcameraOperationInput(options.operation, options.input);
      return this.wrapSemanticResult(options.operation, await this.withHostAdmission(options.operation, async () => await this.check({ path: input.path })));
    }
    if (options.operation === "slopcamera.diagram.render") {
      const input = parseSlopcameraOperationInput(options.operation, options.input);
      return this.enqueueRender(async () => await this.withHostAdmission(options.operation, async () => this.wrapSemanticResult(options.operation, await this.render({
        path: input.path,
        ...input.outDirectory === undefined ? {} : { outDirectory: input.outDirectory },
        scale: input.scale ?? defaultScale
      }))));
    }
    if (options.operation === "slopcamera.image.vectorize") {
      const input = parseSlopcameraOperationInput(options.operation, options.input);
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
      const input = parseSlopcameraOperationInput(options.operation, options.input);
      const output = await this.boundary.prepareOutputFile(input.outputPath);
      const generated = await generateSlopcameraImageFile({ ...input, outputPath: output.absolutePath }, this.generateDependencies);
      return successResult(`Executed ${options.operation}: ${output.relativePath} (request ${safeFragment(generated.requestId, 256)}).`, {
        ok: true,
        operation: options.operation,
        result: {
          bytes: generated.bytes,
          mediaType: generated.mediaType,
          model: generated.model,
          outputPath: output.relativePath,
          provider: generated.provider,
          requestId: generated.requestId,
          sha256: generated.sha256,
          warnings: generated.warnings
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
      tldr: join4(outputDirectory.absolutePath, `${spec.name}.tldr`),
      lightSvg: join4(outputDirectory.absolutePath, `${spec.name}.light.svg`),
      darkSvg: join4(outputDirectory.absolutePath, `${spec.name}.dark.svg`),
      lightPng: join4(outputDirectory.absolutePath, `${spec.name}.light.png`),
      darkPng: join4(outputDirectory.absolutePath, `${spec.name}.dark.png`)
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

// src/version.ts
var SLOPCAMERA_VERSION = "3.2.5";

// src/mcp/server.ts
var slopcameraMcpProtocolVersion = "2025-11-25";
var slopcameraMcpServerName = "hraness-slopcamera";
var maximumMessageBytes = 1024 * 1024;
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonRpcId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
}
function isInitializeParams(value) {
  return isRecord4(value) && typeof value.protocolVersion === "string" && isRecord4(value.capabilities) && isRecord4(value.clientInfo) && typeof value.clientInfo.name === "string" && typeof value.clientInfo.version === "string";
}
function parseRequest(value) {
  if (!isRecord4(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || "id" in value && !isJsonRpcId(value.id)) {
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
  if (!isRecord4(params) || typeof params.name !== "string" || params.arguments !== undefined && !isRecord4(params.arguments)) {
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

class SlopcameraMcpSession {
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
        protocolVersion: slopcameraMcpProtocolVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: slopcameraMcpServerName,
          version: this.serverVersion
        },
        instructions: "Use check_diagram/render_diagram or search_slopcamera followed by execute_slopcamera with an exact registry code and typed JSON. Local paths are root-relative; source code is never accepted or evaluated."
      });
    }
    if (this.state !== "ready") {
      return failure(id, -32002, "Server is not initialized");
    }
    if (request.method === "ping")
      return success(id, {});
    if (request.method === "tools/list") {
      if (request.params !== undefined && (!isRecord4(request.params) || Object.keys(request.params).length > 0)) {
        return failure(id, -32602, "Invalid tools/list parameters");
      }
      return success(id, { tools: slopcameraMcpTools });
    }
    if (request.method === "tools/call") {
      try {
        const toolCall = parseToolCall(request.params);
        if (!slopcameraMcpTools.some((tool) => tool.name === toolCall.name)) {
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
  await new Promise((resolve5, reject) => {
    process.stdout.write(`${line}
`, (error) => {
      if (error === null || error === undefined)
        resolve5();
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
  const runtime = await SlopcameraMcpToolRuntime.create(options.rootDirectory ?? process.cwd(), options.generateDependencies);
  const session = new SlopcameraMcpSession(runtime, options.serverVersion ?? SLOPCAMERA_VERSION);
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
// src/studio/contracts.ts
import { z as z2 } from "zod";

// src/studio/shared.ts
import { z } from "zod";
var STUDIO_LIMITS = Object.freeze({
  documentBytes: 32 * 1024 * 1024,
  documentDepth: 32,
  documentValues: 500000,
  sourceFiles: 512,
  sourceBytes: 4 * 1024 ** 3,
  outputSpecifications: 32,
  outputFiles: 25000,
  outputBytes: 64 * 1024 ** 3,
  timeoutSeconds: 6 * 60 * 60,
  frames: 25000,
  frameIndexExclusive: 1e6,
  dimension: 8192,
  pixels: 33554432,
  parameterBytes: 256 * 1024,
  parameterDepth: 16,
  parameterValues: 20000
});
function studioDocument(schema, name) {
  return z.preprocess((value) => value === undefined ? undefined : createBoundedJsonValueSnapshot(value, STUDIO_LIMITS.documentBytes, name, { maximumDepth: STUDIO_LIMITS.documentDepth, maximumValues: STUDIO_LIMITS.documentValues }).value, schema);
}
function parseStudioValue(schema, input) {
  try {
    return deepFreezeJson(schema.parse(input));
  } catch (error) {
    if (error instanceof SlopcameraCodeError)
      throw error;
    throw new SlopcameraCodeError("invalid-data", error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid studio document." : "Invalid studio document.");
  }
}
function studioHash(domain, value) {
  return boundedCanonicalJsonSha256({ domain, value }, { maximumBytes: STUDIO_LIMITS.documentBytes, maximumDepth: STUDIO_LIMITS.documentDepth + 2, maximumValues: STUDIO_LIMITS.documentValues + 4 });
}
var studioCompare = compareUtf16Strings;
function studioRequire(condition, message) {
  if (!condition)
    throw new SlopcameraCodeError("invalid-data", message);
}
function pathKey(path) {
  return path.toLowerCase();
}
function assertDistinctPaths(paths) {
  const names = new Set(paths.map(pathKey));
  studioRequire(names.size === paths.length, "Studio paths collide.");
  for (const name of names) {
    for (let offset = name.indexOf("/");offset !== -1; offset = name.indexOf("/", offset + 1)) {
      studioRequire(!names.has(name.slice(0, offset)), "Studio paths use a file as an ancestor.");
    }
  }
}

// src/studio/contracts.ts
var StudioDigestSchema = z2.string().regex(/^[a-f0-9]{64}$/u);
var StudioEngineSchema = z2.enum(["blender", "manim", "cadquery"]);
var StudioPathSchema = z2.string().min(1).max(1024).refine((path) => path.normalize("NFC") === path && !path.startsWith("/") && !/[\\:\u0000-\u001f\u007f]/u.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/[. ]$/u.test(part)), "Studio paths must be normalized, contained POSIX-relative names.");
var identifier = z2.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
var stableId = z2.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u);
var sourceFile = z2.strictObject({ path: StudioPathSchema, sha256: StudioDigestSchema, bytes: z2.number().int().safe().nonnegative().max(STUDIO_LIMITS.sourceBytes) });
var sourceBundleShape = z2.strictObject({
  kind: z2.literal("slopcamera.studio-source-bundle"),
  schemaVersion: z2.literal(1),
  engine: StudioEngineSchema,
  entrypoint: z2.discriminatedUnion("kind", [z2.strictObject({ kind: z2.literal("python"), path: StudioPathSchema.refine((path) => path.endsWith(".py")) }), z2.strictObject({ kind: z2.literal("blend"), path: StudioPathSchema.refine((path) => path.endsWith(".blend")) })]),
  files: z2.array(sourceFile).min(1).max(STUDIO_LIMITS.sourceFiles)
}).superRefine((value, context) => {
  const issue = (message) => context.addIssue({ code: "custom", message });
  try {
    assertDistinctPaths(value.files.map((file) => file.path));
  } catch {
    issue("Source paths must be distinct and cannot have file ancestors.");
  }
  if (value.files.reduce((total, file) => total + file.bytes, 0) > STUDIO_LIMITS.sourceBytes)
    issue("Source bundle exceeds four GiB.");
  if (!value.files.some((file) => file.path === value.entrypoint.path && file.bytes > 0))
    issue("Entrypoint must name a declared nonempty source file.");
  if (value.entrypoint.kind === "blend" && value.engine !== "blender")
    issue("Blend entrypoints require Blender.");
});
var sourceBundle = sourceBundleShape.transform((value) => ({ ...value, files: [...value.files].sort((a, b) => studioCompare(a.path, b.path)) })).pipe(sourceBundleShape);
var StudioSourceBundleSchema = studioDocument(sourceBundle, "studio source bundle");
var parseStudioSourceBundle = (input) => parseStudioValue(StudioSourceBundleSchema, input);
var StudioSourceSpaceSchema = z2.strictObject({ units: z2.enum(["meters", "millimeters", "centimeters"]), upAxis: z2.enum(["x", "y", "z"]), handedness: z2.enum(["right", "left"]) });
var StudioOutputRoleSchema = z2.enum(["native-source", "model", "beauty", "auxiliary", "simulation-cache", "audio"]);
var StudioOutputFormatSchema = z2.enum(["py", "blend", "usd", "usda", "usdc", "glb", "step", "png", "exr", "mp4", "mov", "webm", "wav", "flac", "mp3", "cache"]);
var raster = z2.strictObject({
  kind: z2.literal("raster"),
  colorSpace: z2.enum(["srgb", "linear-rec709", "data", "unspecified"]),
  alpha: z2.enum(["opaque", "straight", "premultiplied", "none"]),
  dataType: z2.enum(["uint8", "uint16", "float16", "float32"]),
  channels: z2.array(z2.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u)).min(1).max(32),
  semantic: z2.enum(["color", "depth", "normal", "object-id", "mask", "custom"]),
  unit: z2.enum(["unitless", "meters", "millimeters", "centimeters"])
}).superRefine((value, context) => {
  if (new Set(value.channels).size !== value.channels.length)
    context.addIssue({ code: "custom", message: "Raster channels must be unique." });
  if (value.semantic !== "color" && value.colorSpace !== "data")
    context.addIssue({ code: "custom", message: "Non-color raster passes must declare data color space." });
  if (value.semantic === "color" && value.colorSpace === "data")
    context.addIssue({ code: "custom", message: "Color output cannot declare data color space." });
  if (value.semantic !== "depth" && value.unit !== "unitless")
    context.addIssue({ code: "custom", message: "Only depth passes declare distance units." });
});
var StudioOutputInterpretationSchema = z2.discriminatedUnion("kind", [
  raster,
  z2.strictObject({ kind: z2.literal("model"), sourceSpace: StudioSourceSpaceSchema }),
  z2.strictObject({ kind: z2.literal("native-source") }),
  z2.strictObject({ kind: z2.literal("cache"), semantics: z2.literal("opaque-native") }),
  z2.strictObject({ kind: z2.literal("audio"), sampleRate: z2.number().int().min(8000).max(384000), channels: z2.number().int().min(1).max(32) })
]);
var outputCommon = { id: stableId, role: StudioOutputRoleSchema, format: StudioOutputFormatSchema, interpretation: StudioOutputInterpretationSchema };
var pattern = z2.string().max(1024).refine((value) => value.split("%06d").length === 2 && !value.replace("%06d", "").includes("%") && StudioPathSchema.safeParse(value.replace("%06d", "000000")).success, "Sequence paths require exactly one %06d placeholder in a safe relative path.");
function compatibleOutput(value) {
  if (value.role === "native-source")
    return ["py", "blend"].includes(value.format) && value.interpretation.kind === "native-source";
  if (value.role === "model")
    return ["blend", "usd", "usda", "usdc", "glb", "step"].includes(value.format) && value.interpretation.kind === "model";
  if (value.role === "simulation-cache")
    return value.format === "cache" && value.interpretation.kind === "cache";
  if (value.role === "audio")
    return ["wav", "flac", "mp3"].includes(value.format) && value.interpretation.kind === "audio";
  return ["png", "exr", "mp4", "mov", "webm"].includes(value.format) && value.interpretation.kind === "raster" && (value.role !== "beauty" || value.interpretation.semantic === "color");
}
var StudioOutputSpecSchema = z2.discriminatedUnion("kind", [
  z2.strictObject({ ...outputCommon, kind: z2.literal("file"), path: StudioPathSchema }),
  z2.strictObject({ ...outputCommon, kind: z2.literal("sequence"), pathPattern: pattern }),
  z2.strictObject({ ...outputCommon, kind: z2.literal("directory"), path: StudioPathSchema })
]).superRefine((value, context) => {
  const issue = (message) => context.addIssue({ code: "custom", message });
  if (!compatibleOutput(value))
    issue("Output role, format, and interpretation disagree.");
  if (value.kind === "directory" !== (value.format === "cache"))
    issue("Only native cache outputs use directory declarations.");
  if (value.kind === "sequence" && !["png", "exr"].includes(value.format))
    issue("Numbered sequences support PNG or EXR only.");
  if (value.kind !== "directory") {
    const path = value.kind === "sequence" ? value.pathPattern : value.path;
    if (!path.endsWith(`.${value.format}`) && !(value.format === "step" && path.endsWith(".stp")))
      issue("Output extension must agree with its declared format.");
  }
  if (value.interpretation.kind === "raster") {
    if (value.format === "png" && !["uint8", "uint16"].includes(value.interpretation.dataType))
      issue("PNG declares integer sample data.");
    if (value.format === "exr" && !["float16", "float32"].includes(value.interpretation.dataType))
      issue("The admitted EXR profile declares floating point sample data.");
  }
});
var frameRateShape = z2.strictObject({ numerator: z2.number().int().min(1).max(1e6), denominator: z2.number().int().min(1).max(1e6) }).refine((value) => value.numerator / value.denominator <= 240, "Studio cadence exceeds 240 fps.");
var frameRate = frameRateShape.transform((value) => {
  let { numerator: a, denominator: b } = value;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return { numerator: value.numerator / a, denominator: value.denominator / a };
}).pipe(frameRateShape);
var StudioRenderSchema = z2.strictObject({
  width: z2.number().int().min(1).max(STUDIO_LIMITS.dimension),
  height: z2.number().int().min(1).max(STUDIO_LIMITS.dimension),
  frameRate,
  startFrame: z2.number().int().nonnegative().max(STUDIO_LIMITS.frameIndexExclusive - 1),
  endFrameExclusive: z2.number().int().positive().max(STUDIO_LIMITS.frameIndexExclusive)
}).refine((value) => value.endFrameExclusive > value.startFrame && value.endFrameExclusive - value.startFrame <= STUDIO_LIMITS.frames && value.width * value.height <= STUDIO_LIMITS.pixels, "Render requires a bounded, nonempty half-open frame interval and pixel area.");
var StudioEngineOptionsSchema = z2.discriminatedUnion("engine", [
  z2.strictObject({ engine: z2.literal("blender"), renderer: z2.enum(["cycles", "eevee"]), device: z2.enum(["cpu", "gpu"]), samples: z2.number().int().min(1).max(4096), transparent: z2.boolean(), viewTransform: z2.enum(["AgX", "Standard"]), denoise: z2.boolean(), seed: z2.number().int().min(0).max(4294967295) }),
  z2.strictObject({ engine: z2.literal("manim"), scene: identifier, renderer: z2.literal("cairo"), transparent: z2.boolean() }),
  z2.strictObject({ engine: z2.literal("cadquery"), exportVariable: identifier, tolerance: z2.number().finite().positive().max(1), angularTolerance: z2.number().finite().positive().max(Math.PI) })
]);
var parameters = z2.preprocess((value) => value === undefined ? undefined : createBoundedJsonValueSnapshot(value, STUDIO_LIMITS.parameterBytes, "studio parameters", { maximumDepth: STUDIO_LIMITS.parameterDepth, maximumValues: STUDIO_LIMITS.parameterValues }).value, z2.record(z2.string(), z2.unknown()));
var StudioExecutionProfileSchema = z2.strictObject({ trust: z2.literal("trusted-current-user"), isolation: z2.literal("none"), hermetic: z2.literal(false) });
var jobShape = z2.strictObject({
  kind: z2.literal("slopcamera.studio-job"),
  schemaVersion: z2.literal(1),
  jobId: z2.string().regex(/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u),
  bundleSha256: StudioDigestSchema,
  stage: z2.enum(["build", "bake", "render"]),
  parameters,
  engine: StudioEngineOptionsSchema,
  render: StudioRenderSchema.optional(),
  outputs: z2.array(StudioOutputSpecSchema).min(1).max(STUDIO_LIMITS.outputSpecifications),
  limits: z2.strictObject({ timeoutSeconds: z2.number().int().min(1).max(STUDIO_LIMITS.timeoutSeconds), maximumOutputBytes: z2.number().int().safe().min(1).max(STUDIO_LIMITS.outputBytes), maximumOutputFiles: z2.number().int().min(1).max(STUDIO_LIMITS.outputFiles) }),
  execution: StudioExecutionProfileSchema
}).superRefine((value, context) => {
  if (value.render === undefined && (value.stage === "render" && value.engine.engine !== "cadquery" || value.outputs.some((output) => output.kind === "sequence" || output.interpretation.kind === "raster")))
    context.addIssue({ code: "custom", message: "Raster outputs, render stage, and numbered sequences require explicit dimensions and a frame interval." });
  if (new Set(value.outputs.map((output) => output.id)).size !== value.outputs.length)
    context.addIssue({ code: "custom", message: "Output IDs must be unique." });
  const count = value.outputs.reduce((sum, output) => sum + (output.kind === "sequence" && value.render !== undefined ? value.render.endFrameExclusive - value.render.startFrame : 1), 0);
  if (count > value.limits.maximumOutputFiles)
    context.addIssue({ code: "custom", message: "Declared outputs exceed the job's output-file limit." });
});
var job = jobShape.transform((value) => ({ ...value, outputs: [...value.outputs].sort((a, b) => studioCompare(a.id, b.id)) })).pipe(jobShape);
var StudioJobSchema = studioDocument(job, "studio job");
var parseStudioJob = (input) => parseStudioValue(StudioJobSchema, input);
var StudioCapabilityNameSchema = z2.enum(["python-authoring", "blend-authoring", "build", "bake", "render", "gpu-render", "image-sequence", "beauty-video", "model-export", "auxiliary-passes", "native-cache", "audio-output"]);
var capability = z2.strictObject({ name: StudioCapabilityNameSchema, support: z2.enum(["available", "unavailable", "unverified"]), evidence: z2.enum(["probe", "qualification"]), receiptSha256: StudioDigestSchema.optional() }).refine((value) => value.evidence !== "qualification" || value.receiptSha256 !== undefined, "Qualification evidence requires a retained receipt digest.");
var runtimeShape = z2.strictObject({
  kind: z2.literal("slopcamera.studio-runtime"),
  schemaVersion: z2.literal(1),
  engine: StudioEngineSchema,
  tool: z2.strictObject({ name: z2.string().min(1).max(128), version: z2.string().min(1).max(512), executableSha256: StudioDigestSchema }),
  driverSha256: StudioDigestSchema,
  environment: z2.strictObject({ fingerprintSha256: StudioDigestSchema, evidence: z2.literal("observed-package-environment"), hermetic: z2.literal(false) }),
  capabilities: z2.array(capability).max(12)
}).refine((value) => new Set(value.capabilities.map((item) => item.name)).size === value.capabilities.length, "Runtime capability names must be unique.");
var runtime = runtimeShape.transform((value) => ({ ...value, capabilities: [...value.capabilities].sort((a, b) => studioCompare(a.name, b.name)) })).pipe(runtimeShape);
var StudioRuntimeIdentitySchema = studioDocument(runtime, "studio runtime identity");
var parseStudioRuntimeIdentity = (input) => parseStudioValue(StudioRuntimeIdentitySchema, input);
var StudioOutputArtifactSchema = z2.strictObject({
  outputId: stableId,
  path: StudioPathSchema,
  sha256: StudioDigestSchema,
  bytes: z2.number().int().safe().positive().max(STUDIO_LIMITS.outputBytes),
  role: StudioOutputRoleSchema,
  format: StudioOutputFormatSchema,
  frame: z2.number().int().nonnegative().max(STUDIO_LIMITS.frameIndexExclusive - 1).optional()
});

// src/studio/plan.ts
import { z as z3 } from "zod";
var studioSourceBundleSha256 = (input) => studioHash("slopcamera.studio-source-bundle/v1", parseStudioSourceBundle(input));
var studioJobSha256 = (input) => studioHash("slopcamera.studio-job/v1", parseStudioJob(input));
var studioRuntimeSha256 = (input) => studioHash("slopcamera.studio-runtime/v1", parseStudioRuntimeIdentity(input));
function studioOutputPath(output, frame) {
  if (output.kind === "sequence") {
    studioRequire(Number.isInteger(frame) && frame >= 0 && frame < STUDIO_LIMITS.frameIndexExclusive, "Sequence output requires an admitted frame index.");
    return output.pathPattern.replace("%06d", String(frame).padStart(6, "0"));
  }
  studioRequire(frame === undefined, "Only sequence outputs have a frame index.");
  return output.path;
}
function declaration(job2) {
  const files = [];
  const directories = [];
  for (const output of job2.outputs) {
    if (output.kind === "directory")
      directories.push({ id: output.id, path: output.path });
    else if (output.kind === "file")
      files.push({ id: output.id, path: output.path });
    else {
      studioRequire(job2.render !== undefined, "Sequence requires a render interval.");
      for (let frame = job2.render.startFrame;frame < job2.render.endFrameExclusive; frame++)
        files.push({ id: output.id, path: studioOutputPath(output, frame), frame });
    }
  }
  studioRequire(files.length + directories.length <= job2.limits.maximumOutputFiles, "Declared outputs exceed the output-file budget.");
  assertDistinctPaths([...files, ...directories].map((item) => item.path));
  return { files, directories };
}
function requiredCapabilities(bundle, job2) {
  const values = new Set([bundle.entrypoint.kind === "blend" ? "blend-authoring" : "python-authoring", job2.stage]);
  if (job2.engine.engine === "blender" && job2.engine.device === "gpu" && job2.stage === "render")
    values.add("gpu-render");
  for (const output of job2.outputs) {
    if (output.kind === "sequence")
      values.add("image-sequence");
    if (output.role === "beauty" && ["mov", "mp4", "webm"].includes(output.format))
      values.add("beauty-video");
    if (output.role === "model")
      values.add("model-export");
    if (output.role === "auxiliary")
      values.add("auxiliary-passes");
    if (output.role === "simulation-cache")
      values.add("native-cache");
    if (output.role === "audio")
      values.add("audio-output");
  }
  return [...values].sort(studioCompare);
}
function derivePlan(input) {
  const { bundle, job: job2, runtime: runtime2 } = input;
  const bundleSha256 = studioSourceBundleSha256(bundle), jobSha256 = studioJobSha256(job2);
  studioRequire(bundleSha256 === job2.bundleSha256, "Job does not bind the exact source bundle.");
  studioRequire(bundle.engine === job2.engine.engine && (runtime2 === undefined || runtime2.engine === bundle.engine), "Bundle, job, and runtime must use one engine.");
  studioRequire(bundle.entrypoint.kind !== "blend" || job2.stage === "render", "Blend entrypoints support render stage only; explicit Python authoring owns builds and bakes.");
  const declared = declaration(job2), required = requiredCapabilities(bundle, job2);
  const capabilityChecks = required.map((name) => ({ name, support: runtime2 === undefined ? "unbound" : runtime2.capabilities.find((item) => item.name === name)?.support ?? "unverified" }));
  const readiness = runtime2 === undefined ? "runtime-unbound" : capabilityChecks.some((item) => item.support === "unavailable") ? "capability-unavailable" : capabilityChecks.some((item) => item.support === "unverified") ? "capability-unverified" : "authorization-required";
  const body = {
    kind: "slopcamera.studio-plan",
    schemaVersion: 1,
    bundle,
    job: job2,
    ...runtime2 === undefined ? {} : { runtime: runtime2, runtimeSha256: studioRuntimeSha256(runtime2) },
    bundleSha256,
    jobSha256,
    sourceBytes: bundle.files.reduce((total, file) => total + file.bytes, 0),
    frameCount: job2.render === undefined ? 0 : job2.render.endFrameExclusive - job2.render.startFrame,
    outputCount: { minimum: declared.files.length + declared.directories.length, maximum: declared.directories.length === 0 ? declared.files.length : job2.limits.maximumOutputFiles },
    requiredCapabilities: required,
    capabilityChecks,
    readiness
  };
  return { ...body, planSha256: studioHash("slopcamera.studio-plan/v1", body) };
}
var plan = z3.strictObject({
  kind: z3.literal("slopcamera.studio-plan"),
  schemaVersion: z3.literal(1),
  bundle: StudioSourceBundleSchema,
  job: StudioJobSchema,
  runtime: StudioRuntimeIdentitySchema.optional(),
  runtimeSha256: StudioDigestSchema.optional(),
  bundleSha256: StudioDigestSchema,
  jobSha256: StudioDigestSchema,
  planSha256: StudioDigestSchema,
  sourceBytes: z3.number().int().safe().nonnegative().max(STUDIO_LIMITS.sourceBytes),
  frameCount: z3.number().int().nonnegative().max(STUDIO_LIMITS.frames),
  outputCount: z3.strictObject({ minimum: z3.number().int().positive().max(STUDIO_LIMITS.outputFiles), maximum: z3.number().int().positive().max(STUDIO_LIMITS.outputFiles) }),
  requiredCapabilities: z3.array(StudioCapabilityNameSchema).min(1).max(12),
  capabilityChecks: z3.array(z3.strictObject({ name: StudioCapabilityNameSchema, support: z3.enum(["available", "unavailable", "unverified", "unbound"]) })).min(1).max(12),
  readiness: z3.enum(["runtime-unbound", "capability-unavailable", "capability-unverified", "authorization-required"])
}).superRefine((value, context) => {
  try {
    const derived = derivePlan({ bundle: value.bundle, job: value.job, ...value.runtime === undefined ? {} : { runtime: value.runtime } });
    if (canonicalJson(derived) !== canonicalJson(value))
      context.addIssue({ code: "custom", message: "Studio plan differs from its canonical source, job, runtime, or admission derivation." });
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid studio plan." });
  }
});
var StudioPlanSchema = studioDocument(plan, "studio plan");
var parseStudioPlan = (input) => parseStudioValue(StudioPlanSchema, input);
function planStudioJob(input) {
  const captured = parseStudioValue(studioDocument(z3.strictObject({ bundle: StudioSourceBundleSchema, job: StudioJobSchema, runtime: StudioRuntimeIdentitySchema.optional() }), "studio planning input"), input);
  return parseStudioPlan(derivePlan(captured));
}
var failure2 = z3.strictObject({ code: z3.enum(["subprocess", "cancelled", "deadline", "validation", "custody", "publication", "unavailable"]), message: z3.string().min(1).max(2048) });
var receiptCommon = {
  kind: z3.literal("slopcamera.studio-receipt"),
  schemaVersion: z3.literal(1),
  jobId: z3.string().regex(/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u),
  attemptId: z3.string().regex(/^attempt_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u),
  planSha256: StudioDigestSchema,
  bundleSha256: StudioDigestSchema,
  jobSha256: StudioDigestSchema,
  runtime: StudioRuntimeIdentitySchema,
  runtimeSha256: StudioDigestSchema,
  startedAt: z3.iso.datetime({ offset: true }),
  finishedAt: z3.iso.datetime({ offset: true }),
  outputs: z3.array(StudioOutputArtifactSchema).max(STUDIO_LIMITS.outputFiles)
};
var receiptShape = z3.discriminatedUnion("state", [
  z3.strictObject({ ...receiptCommon, state: z3.literal("succeeded"), custody: z3.literal("closed"), exitCode: z3.literal(0) }),
  z3.strictObject({ ...receiptCommon, state: z3.literal("failed"), custody: z3.literal("closed"), exitCode: z3.number().int().min(-255).max(255).nullable(), failure: failure2 }),
  z3.strictObject({ ...receiptCommon, state: z3.literal("unknown-custody"), custody: z3.literal("unknown"), exitCode: z3.number().int().min(-255).max(255).nullable(), failure: failure2 })
]).superRefine((value, context) => {
  if (studioRuntimeSha256(value.runtime) !== value.runtimeSha256)
    context.addIssue({ code: "custom", message: "Receipt runtime digest differs from its evidence." });
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt))
    context.addIssue({ code: "custom", message: "Receipt finishes before it starts." });
  try {
    assertDistinctPaths(value.outputs.map((item) => item.path));
  } catch {
    context.addIssue({ code: "custom", message: "Receipt output paths collide." });
  }
  if (value.outputs.reduce((sum, item) => sum + item.bytes, 0) > STUDIO_LIMITS.outputBytes)
    context.addIssue({ code: "custom", message: "Receipt exceeds the global output byte bound." });
});
var receipt = receiptShape.transform((value) => ({ ...value, outputs: [...value.outputs].sort((a, b) => studioCompare(a.path, b.path)) })).pipe(receiptShape);
var StudioReceiptSchema = studioDocument(receipt, "studio receipt");
var parseStudioReceipt = (input) => parseStudioValue(StudioReceiptSchema, input);
function validateStudioReceipt(input) {
  const captured = parseStudioValue(studioDocument(z3.strictObject({ plan: StudioPlanSchema, receipt: StudioReceiptSchema }), "studio receipt validation input"), input);
  const { plan: plan2, receipt: receipt2 } = captured;
  studioRequire(receipt2.jobId === plan2.job.jobId && receipt2.planSha256 === plan2.planSha256 && receipt2.jobSha256 === plan2.jobSha256 && receipt2.bundleSha256 === plan2.bundleSha256, "Receipt identity differs from the exact planned job.");
  studioRequire(plan2.runtime !== undefined && receipt2.runtimeSha256 === plan2.runtimeSha256 && canonicalJson(receipt2.runtime) === canonicalJson(plan2.runtime), "Execution receipt requires the exact planned runtime binding.");
  if (receipt2.state === "succeeded")
    studioRequire(plan2.readiness === "authorization-required", "A successful receipt requires available observed runtime capabilities; consent remains host-owned.");
  studioRequire(receipt2.outputs.length <= plan2.job.limits.maximumOutputFiles && receipt2.outputs.reduce((total, output) => total + output.bytes, 0) <= plan2.job.limits.maximumOutputBytes, "Receipt exceeds the planned output budget.");
  const declared = declaration(plan2.job), expected = new Map(declared.files.map((file) => [file.path, file]));
  const counts = new Map;
  for (const artifact of receipt2.outputs) {
    const specification = plan2.job.outputs.find((output) => output.id === artifact.outputId);
    studioRequire(specification !== undefined, "Receipt contains an undeclared output ID.");
    studioRequire(artifact.role === specification.role && artifact.format === specification.format, "Receipt output role or format differs from its declaration.");
    if (specification.kind === "directory") {
      studioRequire(artifact.path.startsWith(`${specification.path}/`) && artifact.frame === undefined, "Cache artifact must be a file inside its declared directory.");
    } else {
      const wanted = expected.get(artifact.path);
      studioRequire(wanted !== undefined && wanted.id === artifact.outputId && artifact.frame === wanted.frame, "Receipt contains an undeclared file or incorrect frame index.");
      expected.delete(artifact.path);
    }
    counts.set(artifact.outputId, (counts.get(artifact.outputId) ?? 0) + 1);
  }
  if (receipt2.state === "succeeded") {
    studioRequire(expected.size === 0 && declared.directories.every((directory) => (counts.get(directory.id) ?? 0) > 0), "Successful receipt must cover every declared file, frame, and cache directory.");
  }
  return deepFreezeJson(receipt2);
}
function inspectStudioBundle(input) {
  const bundle = parseStudioSourceBundle(input);
  return deepFreezeJson({
    engine: bundle.engine,
    entrypoint: bundle.entrypoint,
    bundleSha256: studioSourceBundleSha256(bundle),
    files: bundle.files.length,
    sourceBytes: bundle.files.reduce((total, file) => total + file.bytes, 0),
    executed: false,
    dependencyDiscovery: "explicit-files-only"
  });
}
function inspectStudioPlan(input) {
  const plan2 = parseStudioPlan(input);
  return deepFreezeJson({
    jobId: plan2.job.jobId,
    stage: plan2.job.stage,
    engine: plan2.job.engine.engine,
    planSha256: plan2.planSha256,
    sourceBytes: plan2.sourceBytes,
    frameCount: plan2.frameCount,
    outputCount: plan2.outputCount,
    readiness: plan2.readiness,
    capabilityChecks: plan2.capabilityChecks,
    execution: plan2.job.execution,
    limits: plan2.job.limits,
    executed: false,
    outputs: plan2.job.outputs.map((output) => ({ id: output.id, role: output.role, format: output.format, kind: output.kind, path: output.kind === "sequence" ? output.pathPattern : output.path }))
  });
}

// src/index.ts
var slopcameraApi = Object.freeze({
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  defineSlopcameraWorkflow,
  DiagramValidationError,
  findDesktopApplication,
  generateSlopcameraImage,
  generateSlopcameraImageFile,
  getLatestDesktopRelease,
  slopcameraGatewayCredentialStatus,
  slopcameraMcpProtocolVersion,
  slopcameraMcpServerName,
  slopcameraMcpTools,
  slopcameraOperationRegistry,
  SlopcameraMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveEdge,
  resolveDiagramSource,
  resolveStackLayout,
  runSlopcameraWorkflow,
  runMcpServer,
  searchSlopcameraOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  SlopcameraWorkflowError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeSlopcameraOperation
});
var diagramApi = slopcameraApi;
export { readDiagramFile, checkDiagramFile, renderDiagramFile, artifactSummary, desktopDownloadPage, selectDesktopAsset, getLatestDesktopRelease, installDesktop, findDesktopApplication, desktopStatus, openInDesktop, mcpSourceByteLimit, WorkspaceBoundaryError, WorkspaceBoundary, mcpMaximumScale, mcpMaximumRenderedPixels, slopcameraMcpTools, SlopcameraMcpToolRuntime, SLOPCAMERA_VERSION, slopcameraMcpProtocolVersion, slopcameraMcpServerName, runMcpServer, STUDIO_LIMITS, StudioDigestSchema, StudioEngineSchema, StudioPathSchema, StudioSourceBundleSchema, parseStudioSourceBundle, StudioSourceSpaceSchema, StudioOutputRoleSchema, StudioOutputFormatSchema, StudioOutputInterpretationSchema, StudioOutputSpecSchema, StudioRenderSchema, StudioEngineOptionsSchema, StudioExecutionProfileSchema, StudioJobSchema, parseStudioJob, StudioCapabilityNameSchema, StudioRuntimeIdentitySchema, parseStudioRuntimeIdentity, StudioOutputArtifactSchema, studioSourceBundleSha256, studioJobSha256, studioRuntimeSha256, studioOutputPath, StudioPlanSchema, parseStudioPlan, planStudioJob, StudioReceiptSchema, parseStudioReceipt, validateStudioReceipt, inspectStudioBundle, inspectStudioPlan, slopcameraApi, diagramApi };
