// @bun
import {
  pathExists
} from "./index-mjemj725.js";

// src/desktop.ts
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { chmod, mkdir, readFile, rename, rm } from "fs/promises";
import { homedir, platform as hostPlatform, arch as hostArch } from "os";
import { dirname, join, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
var releaseApi = "https://api.github.com/repos/tldraw/tldraw-offline/releases/latest";
var desktopDownloadPage = "https://offline.tldraw.com";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseRelease(value) {
  if (!isRecord(value) || typeof value.tag_name !== "string" || typeof value.html_url !== "string" || !Array.isArray(value.assets)) {
    throw new Error("GitHub returned an invalid tldraw Offline release");
  }
  const assets = value.assets.map((asset, index) => {
    if (!isRecord(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string" || typeof asset.size !== "number" || asset.digest !== null && asset.digest !== undefined && typeof asset.digest !== "string") {
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
      "User-Agent": "hraness-transmute",
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
    headers: { "User-Agent": "hraness-transmute" },
    redirect: "follow"
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Installer download failed with HTTP ${response.status}`);
  }
  const temporary = `${filePath}.part-${process.pid}`;
  await mkdir(dirname(filePath), { recursive: true });
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
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
function spawnDetached(command) {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  });
  child.unref();
}
async function installDesktop(options) {
  const release = await getLatestDesktopRelease();
  const asset = selectDesktopAsset(release);
  const cacheDirectory = join(homedir(), ".cache", "transmute", "installers", release.tag_name);
  const installerPath = join(cacheDirectory, asset.name);
  let reusable = false;
  if (await pathExists(installerPath)) {
    const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null;
    reusable = expected !== null && await sha256(installerPath) === expected;
  }
  if (!reusable)
    await download(asset, installerPath);
  if (hostPlatform() === "linux") {
    const installedPath = join(homedir(), ".local", "bin", "tldraw-offline");
    await mkdir(dirname(installedPath), { recursive: true });
    const temporary = `${installedPath}.tmp-${process.pid}`;
    await Bun.write(temporary, Bun.file(installerPath));
    await chmod(temporary, 493);
    await rename(temporary, installedPath);
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
    join(homedir(), "Applications", "tldraw offline.app")
  ] : hostPlatform() === "linux" ? [join(homedir(), ".local", "bin", "tldraw-offline")] : [
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "tldraw offline", "tldraw offline.exe")
  ];
  for (const candidate of candidates)
    if (await pathExists(candidate))
      return candidate;
  return null;
}
function serverFilePath() {
  if (hostPlatform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "tldraw", "server.json");
  }
  if (hostPlatform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "tldraw", "server.json");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tldraw", "server.json");
}
async function desktopStatus() {
  const installedPath = await findDesktopApplication();
  const filePath = serverFilePath();
  if (!await pathExists(filePath))
    return { installedPath, server: null };
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!isRecord(parsed) || typeof parsed.port !== "number") {
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
  const absolutePath = resolve(filePath);
  if (!await pathExists(absolutePath))
    throw new Error(`File does not exist: ${absolutePath}`);
  const application = await findDesktopApplication();
  if (application === null) {
    throw new Error(`tldraw Offline is not installed. Run "transmute canvas install" or visit ${desktopDownloadPage}`);
  }
  if (hostPlatform() === "darwin") {
    spawnDetached(["open", "-a", application, absolutePath]);
  } else if (hostPlatform() === "win32") {
    spawnDetached(["cmd.exe", "/d", "/s", "/c", "start", "", absolutePath]);
  } else {
    spawnDetached([application, absolutePath]);
  }
}

export { desktopDownloadPage, selectDesktopAsset, getLatestDesktopRelease, installDesktop, findDesktopApplication, desktopStatus, openInDesktop };
