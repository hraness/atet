import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  HtmlOverlayAuthoringInputSchema,
  createHtmlOverlayScaffold,
} from "../html-overlay";
import type { ExactCapabilityBinding } from "./capability-binding";
import type { HtmlOverlayBrowserRuntimeBinding } from "./html-overlay-browser-runtime";
import {
  HTML_OVERLAY_RENDERER_CONTRACT,
  createHtmlOverlayExecutionBundle,
} from "./html-overlay-integrity";

const browser: ExactCapabilityBinding = {
  bytes: 1024,
  command: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  executableSha256: "a".repeat(64),
  name: "html-browser",
  version: "Chromium fixture",
};
const browserRuntime: HtmlOverlayBrowserRuntimeBinding = {
  capability: browser,
  manifest: {
    entries: [{
      bytes: browser.bytes,
      kind: "file",
      mode: 0o755,
      path: ".",
      sha256: browser.executableSha256,
    }],
    executableRelativePath: ".",
    layout: "single-executable",
    rootSha256: "e".repeat(64),
    schemaVersion: 1,
    totalBytes: browser.bytes,
  },
  provenance: { kind: "test-only-unverified" },
  sourceRoot: browser.executablePath,
};

const authoring = HtmlOverlayAuthoringInputSchema.parse({
  canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
  html: createHtmlOverlayScaffold("plain"),
  kind: "transmute.html-overlay",
  libraries: [],
  parameters: { title: "Integrity" },
  resources: [{
    bytes: 8,
    mediaType: "image/png",
    name: "logo",
    sha256: "b".repeat(64),
    urlPath: "images/logo.png",
  }],
  schemaVersion: 1,
  seed: 42,
  timing: { durationUs: 1_000_000, fps: 30 },
});

describe("HTML-overlay browser execution integrity", () => {
  test("pins the exact installed Playwright behavior version", () => {
    expect(HTML_OVERLAY_RENDERER_CONTRACT.browserVersion).toBe("1.62.0");
    expect(HTML_OVERLAY_RENDERER_CONTRACT.environment.inherited).toEqual([]);
    expect(HTML_OVERLAY_RENDERER_CONTRACT.runtimeSnapshot).toEqual({
      cleanupIdentity: "container-direct-children-and-complete-runtime-manifest",
      copyBufferBytes: 4 * 1024 * 1024,
      filesystemGuard: "anchor-basename-and-recursive-parent-watch-with-path-identities",
      macosAnchor: "/private/tmp",
      macosAnchorPolicy: "physical-root-owned-sticky-direct-child",
      orphanRecovery: "active-to-released-lease-last-atomic-quarantine-double-open-proof",
      verifiedMacosFilesystemFlags: "user-immutable-recursive",
    });
  });

  test("binds the complete generated runtime into the Merkle root", () => {
    const bundle = createHtmlOverlayExecutionBundle(authoring, browserRuntime);
    expect(bundle.integrity.runtimeSha256).toBe(
      createHash("sha256").update(bundle.runtimeSource).digest("hex"),
    );
    expect(bundle.integrity.leaves.map(({ key }) => key)).toContain("runtime");
    expect(bundle.integrity.leaves.map(({ key }) => key)).toContain("renderer-contract");
    expect(bundle.integrity.leaves.map(({ key }) => key)).toContain("resource:logo");
  });

  test("detects document, resource, runtime-config, and browser tampering", () => {
    const baseline = createHtmlOverlayExecutionBundle(authoring, browserRuntime);
    const variants = [
      createHtmlOverlayExecutionBundle({
        ...authoring,
        html: `${authoring.html}\n<!-- changed -->`,
      }, browserRuntime),
      createHtmlOverlayExecutionBundle({
        ...authoring,
        resources: [{ ...authoring.resources[0]!, sha256: "c".repeat(64) }],
      }, browserRuntime),
      createHtmlOverlayExecutionBundle({
        ...authoring,
        seed: 43,
      }, browserRuntime),
      createHtmlOverlayExecutionBundle(authoring, {
        ...browserRuntime,
        manifest: {
          ...browserRuntime.manifest,
          rootSha256: "d".repeat(64),
        },
      }),
    ];
    for (const variant of variants) {
      expect(variant.integrity.rootSha256).not.toBe(
        baseline.integrity.rootSha256,
      );
    }
  });
});
