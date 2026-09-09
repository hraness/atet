import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalJsonSha256 } from "../core/canonical-json";

import {
  HtmlOverlayAuthoringInputSchema,
  createHtmlOverlayScaffold,
} from "../html-overlay";
import type { ExactCapabilityBinding } from "./capability-binding";
import type { HtmlOverlayBrowserRuntimeBinding } from "./html-overlay-browser-runtime";
import {
  HTML_OVERLAY_RENDERER_CONTRACT,
  createHtmlOverlayExecutionBundle,
  htmlOverlayRendererContract,
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
  kind: "atet.html-overlay",
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
  test("unflagged resources preserve all three historical renderer contract hashes", () => {
    const hashes = [
      [undefined, "c24b91734534f97d856ad05e5be84b65c8810af58759cb60589393f2572562a1"],
      ["three-webgl2-hardware-v1", "74b6a6f1c4a667fedcad154abb6e6804b3f5aa518a47896bce87a76758da510f"],
      ["three-spark-webgl2-hardware-v1", "80dd7d52053842eca0f0690c2f9e661b1d36fd9b0a89c2ed7566b6326ad7e4f4"],
    ] as const;
    for (const [profile, expected] of hashes) {
      expect(canonicalJsonSha256(htmlOverlayRendererContract(profile))).toBe(expected);
      expect(canonicalJsonSha256(htmlOverlayRendererContract(profile, authoring.resources))).toBe(expected);
    }
    expect(htmlOverlayRendererContract(undefined, authoring.resources)).toBe(HTML_OVERLAY_RENDERER_CONTRACT);
  });

  test("fetch opt-in permits only the exact hash-addressed private paths in canonical order", () => {
    const first = { ...authoring.resources[0]!, name: "alpha", urlPath: "geometry/first.json", transport: "fetch" as const };
    const second = { ...first, name: "zebra", urlPath: "geometry/second.json", sha256: "d".repeat(64) };
    const resources = [second, authoring.resources[0]!, first];
    const expected = `connect-src https://atet-overlay.invalid/.atet-overlay/assets/${first.sha256}/geometry/first.json https://atet-overlay.invalid/.atet-overlay/assets/${second.sha256}/geometry/second.json`;
    for (const profile of [undefined, "three-webgl2-hardware-v1"] as const) {
      const legacy = htmlOverlayRendererContract(profile), current = htmlOverlayRendererContract(profile, resources);
      expect(current.contentSecurityPolicy.find(directive => directive.startsWith("connect-src "))).toBe(expected);
      expect(current.schemaVersion).toBe(3);
      expect(current.contentSecurityPolicy.filter(directive => !directive.startsWith("connect-src ")))
        .toEqual(legacy.contentSecurityPolicy.filter(directive => !directive.startsWith("connect-src ")));
      expect(current.launch).toEqual(legacy.launch);
      expect(current.routing).toEqual(legacy.routing);
      expect(current).toEqual(htmlOverlayRendererContract(profile, [...resources].reverse()));
    }
    const spark = htmlOverlayRendererContract("three-spark-webgl2-hardware-v1");
    expect(htmlOverlayRendererContract("three-spark-webgl2-hardware-v1", resources)).toEqual(spark);
    for (const urlPath of ["https://outside.example/geometry.json", "../other.json", "geometry/a.json?token=x", "geometry/%2e%2e/other.json"]) {
      expect(() => htmlOverlayRendererContract(undefined, [{ ...first, urlPath }])).toThrow();
    }
  });

  test("fetch authority changes both the resource and renderer Merkle leaves without changing runtime bytes", () => {
    const original = createHtmlOverlayExecutionBundle(authoring, browserRuntime);
    const opted = { ...authoring, resources: [{ ...authoring.resources[0]!, transport: "fetch" as const }] };
    const changed = createHtmlOverlayExecutionBundle(opted, browserRuntime);
    const changedKeys = changed.integrity.leaves.filter(leaf => original.integrity.leaves.find(item => item.key === leaf.key)?.sha256 !== leaf.sha256).map(leaf => leaf.key);
    expect(changedKeys).toEqual(["renderer-contract", "resource:logo"]);
    expect(changed.integrity.rootSha256).not.toBe(original.integrity.rootSha256);
    expect(changed.runtimeSource).toBe(original.runtimeSource);
    expect(createHtmlOverlayExecutionBundle({ ...opted, resources: authoring.resources }, browserRuntime)).toEqual(original);
    const moved = createHtmlOverlayExecutionBundle({ ...opted, resources: [{ ...opted.resources[0]!, urlPath: "moved/logo.png" }] }, browserRuntime);
    expect(moved.integrity.leaves.find(leaf => leaf.key === "renderer-contract")?.sha256)
      .not.toBe(changed.integrity.leaves.find(leaf => leaf.key === "renderer-contract")?.sha256);
  });

  test("opted CSP obeys resource permutation and hash-address separation laws", () => {
    const name = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), { minLength: 1, maxLength: 12 }).map(characters => `r${characters.join("")}`);
    const segment = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~@+-"), { minLength: 1, maxLength: 20 }).map(characters => `p${characters.join("")}`);
    const resources = fc.uniqueArray(fc.record({ name, segment,
      sha256: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(bytes => Buffer.from(bytes).toString("hex")),
      bytes: fc.integer({ min: 1, max: 4096 }),
    }), { minLength: 1, maxLength: 8, selector: resource => resource.name }).map(items => items.map(({ segment, ...resource }) => ({
      ...resource, mediaType: "application/json", transport: "fetch" as const, urlPath: `geometry/${resource.name}/${segment}.json`,
    })));
    const cases = resources.chain(items => fc.tuple(fc.constant(items), fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length }),
      fc.integer({ min: 0, max: items.length - 1 }), fc.boolean()));
    fc.assert(fc.property(cases, ([items, permutation, changedIndex, hardware]) => {
      const profile = hardware ? "three-webgl2-hardware-v1" : undefined;
      const first = htmlOverlayRendererContract(profile, items), permuted = htmlOverlayRendererContract(profile, permutation);
      expect(canonicalJsonSha256(permuted)).toBe(canonicalJsonSha256(first));
      const url = (resource: typeof items[number]) => `https://atet-overlay.invalid/.atet-overlay/assets/${resource.sha256}/${resource.urlPath}`;
      const sources = (contract: typeof first) => contract.contentSecurityPolicy.find(directive => directive.startsWith("connect-src "))!.slice("connect-src ".length).split(" ");
      expect(sources(first)).toEqual([...items].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0).map(url));
      const selected = items[changedIndex]!;
      const replacement = { ...selected, sha256: `${selected.sha256[0] === "0" ? "1" : "0"}${selected.sha256.slice(1)}` };
      const changed = htmlOverlayRendererContract(profile, items.map((resource, index) => index === changedIndex ? replacement : resource));
      expect(canonicalJsonSha256(changed)).not.toBe(canonicalJsonSha256(first));
      expect(sources(changed)).toContain(url(replacement));
      expect(sources(changed)).not.toContain(url(selected));
      expect(sources(changed).filter(source => source !== url(replacement))).toEqual(sources(first).filter(source => source !== url(selected)));
    }), { seed: 7092026, numRuns: 100 });
  });

  test("hardware changes only the selected renderer contract while preserving absent legacy identity", () => {
    const input = { ...authoring, libraries: ["three" as const] };
    const legacy = createHtmlOverlayExecutionBundle(input, browserRuntime);
    expect(createHtmlOverlayExecutionBundle(input, browserRuntime, undefined)).toEqual(legacy);
    expect(htmlOverlayRendererContract()).toBe(HTML_OVERLAY_RENDERER_CONTRACT);
    const hardware = createHtmlOverlayExecutionBundle(input, browserRuntime, "three-webgl2-hardware-v1");
    expect(hardware.integrity.rootSha256).not.toBe(legacy.integrity.rootSha256);
    expect(hardware.runtimeSource).toBe(legacy.runtimeSource);
    expect(hardware.integrity.leaves.filter(leaf => leaf.key !== "renderer-contract")).toEqual(legacy.integrity.leaves.filter(leaf => leaf.key !== "renderer-contract"));
    expect(htmlOverlayRendererContract("three-webgl2-hardware-v1").contentSecurityPolicy).toEqual(HTML_OVERLAY_RENDERER_CONTRACT.contentSecurityPolicy);
    const spark = htmlOverlayRendererContract("three-spark-webgl2-hardware-v1");
    expect(spark.contentSecurityPolicy).toContain("worker-src blob:");
    expect(spark.contentSecurityPolicy).toContain("connect-src https://atet-overlay.invalid data:");
    expect(spark.contentSecurityPolicy.some(value => value.includes("'wasm-unsafe-eval'"))).toBe(true);
    expect(() => createHtmlOverlayExecutionBundle(authoring, browserRuntime, "three-webgl2-hardware-v1")).toThrow("exact approved scene library");
  });
  test("pins the exact installed Playwright behavior version", () => {
    expect(HTML_OVERLAY_RENDERER_CONTRACT.browserVersion).toBe("1.62.0");
    expect(HTML_OVERLAY_RENDERER_CONTRACT.environment.inherited).toEqual([]);
    expect(HTML_OVERLAY_RENDERER_CONTRACT.launch.libraryArgs.vgpu).toEqual([
      "--enable-unsafe-webgpu",
      "--use-webgpu-adapter=swiftshader",
    ]);
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
