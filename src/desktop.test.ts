import { describe, expect, test } from "bun:test"
import { selectDesktopAsset } from "./desktop.ts"

const release = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/tldraw/tldraw-offline/releases/tag/v1.2.3",
  assets: [
    {
      name: "tldraw-offline-mac-universal.dmg",
      browser_download_url: "https://example.com/mac",
      size: 1,
      digest: "sha256:a",
    },
    {
      name: "tldraw-offline-win-x64.exe",
      browser_download_url: "https://example.com/windows",
      size: 1,
      digest: "sha256:b",
    },
    {
      name: "tldraw-offline-linux-arm64.AppImage",
      browser_download_url: "https://example.com/linux",
      size: 1,
      digest: "sha256:c",
    },
  ],
}

describe("desktop release selection", () => {
  test("uses the official universal macOS image", () => {
    expect(selectDesktopAsset(release, "darwin", "arm64").name).toBe(
      "tldraw-offline-mac-universal.dmg",
    )
  })

  test("selects by Windows and Linux architecture", () => {
    expect(selectDesktopAsset(release, "win32", "x64").name).toBe(
      "tldraw-offline-win-x64.exe",
    )
    expect(selectDesktopAsset(release, "linux", "arm64").name).toBe(
      "tldraw-offline-linux-arm64.AppImage",
    )
  })
})
