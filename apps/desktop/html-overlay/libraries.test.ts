import { describe, expect, test } from "bun:test";

import {
  ACTIVE_HTML_OVERLAY_LIBRARY_LOCKS,
  APPROVED_HTML_OVERLAY_LIBRARY_LOCKS,
  HISTORICAL_HTML_OVERLAY_LIBRARY_LOCKS,
  HTML_OVERLAY_LIBRARY_SPECIFIERS,
  HtmlOverlayActiveLibraryLockSchema,
  HtmlOverlayActiveLibraryLocksSchema,
  HtmlOverlayLibraryLockSchema,
  HtmlOverlayLibraryLocksSchema,
  HtmlOverlayLibrarySelectionSchema,
  createHtmlOverlayImportMap,
  getApprovedHtmlOverlayLibraryLock,
  htmlOverlayLibraryLocalUrl,
  serializeHtmlOverlayImportMap,
} from "./libraries";

describe("HTML overlay locked libraries", () => {
  test("pins the exact active self-contained browser modules", () => {
    expect(ACTIVE_HTML_OVERLAY_LIBRARY_LOCKS).toEqual([
      {
        bytes: 196_909,
        license: "Apache-2.0",
        sha256: "4b7f8d053f6c91b4d3ec6abdcfd4b07b9fce7ec2b8086a0f0781f485c59d097e",
        specifier: "@paper-design/shaders",
        url: "https://esm.sh/@paper-design/shaders@0.0.77/es2022/shaders.bundle.mjs",
        version: "0.0.77",
      },
      {
        bytes: 12_098,
        license: "MIT",
        sha256: "0d89a96784df54ed726443ebd09be2bee6118d9f1e074166df580bce632c5b62",
        specifier: "motion",
        url: "https://esm.sh/motion@12.42.2/es2022/mini.bundle.mjs",
        version: "12.42.2",
      },
      {
        bytes: 1_101_741,
        license: "LGPL-2.1",
        sha256: "78062f4b654ec2d7eab8391cb9f960720e90a379789974f27b6fc4aed94fae21",
        specifier: "p5",
        url: "https://cdn.jsdelivr.net/npm/p5@2.3.2/lib/p5.esm.min.js",
        version: "2.3.2",
      },
      {
        bytes: 522_058,
        license: "MIT",
        sha256: "0e98a999fcb47006add9425200b18fab26eb09a154665b2893371d74e0a862d4",
        specifier: "two.js",
        url: "https://cdn.jsdelivr.net/npm/two.js@0.8.24/build/two.module.js",
        version: "0.8.24",
      },
      {
        bytes: 729_954,
        license: "MIT",
        sha256: "12e6dd7a5cceb3efd76f8c65acbf5aa55c74820115d9ebae874b28456b9ddb5c",
        specifier: "three",
        url: "https://esm.sh/three@0.185.1/es2022/three.bundle.mjs",
        version: "0.185.1",
      },
      {
        bytes: 181_522,
        license: "MIT",
        sha256: "f7ef874ca3dd29b165beaaf77297d64e06b65db1c48819ac472446da46f2cc9f",
        specifier: "vgpu",
        url: "https://esm.sh/vgpu@0.3.1/es2022/vgpu.bundle.mjs",
        version: "0.3.1",
      },
    ]);
    expect(APPROVED_HTML_OVERLAY_LIBRARY_LOCKS)
      .toBe(ACTIVE_HTML_OVERLAY_LIBRARY_LOCKS);
    expect(Object.isFrozen(HTML_OVERLAY_LIBRARY_SPECIFIERS)).toBe(true);
    expect(Object.isFrozen(ACTIVE_HTML_OVERLAY_LIBRARY_LOCKS)).toBe(true);
    expect(ACTIVE_HTML_OVERLAY_LIBRARY_LOCKS.every(Object.isFrozen)).toBe(true);
  });

  test("rejects every mutation of an otherwise valid lock", () => {
    const motion = getApprovedHtmlOverlayLibraryLock("motion");
    for (const mutation of [
      { ...motion, bytes: motion.bytes + 1 },
      { ...motion, license: "Apache-2.0" },
      { ...motion, sha256: "f".repeat(64) },
      { ...motion, specifier: "p5" },
      { ...motion, url: "https://esm.sh/motion@12.42.2/mini.mjs" },
      { ...motion, version: "12.42.3" },
      { ...motion, shell: true },
    ]) {
      expect(HtmlOverlayActiveLibraryLockSchema.safeParse(mutation).success)
        .toBe(false);
      expect(HtmlOverlayLibraryLockSchema.safeParse(mutation).success).toBe(false);
    }
  });

  test("keeps active authoring and append-only receipt validation separate", () => {
    expect(HISTORICAL_HTML_OVERLAY_LIBRARY_LOCKS)
      .toEqual(ACTIVE_HTML_OVERLAY_LIBRARY_LOCKS);
    expect(HISTORICAL_HTML_OVERLAY_LIBRARY_LOCKS)
      .not.toBe(ACTIVE_HTML_OVERLAY_LIBRARY_LOCKS);
    expect(Object.isFrozen(HISTORICAL_HTML_OVERLAY_LIBRARY_LOCKS)).toBe(true);
    expect(HtmlOverlayActiveLibraryLocksSchema.parse([
      getApprovedHtmlOverlayLibraryLock("two.js"),
      getApprovedHtmlOverlayLibraryLock("p5"),
    ]).map(lock => lock.specifier)).toEqual(["p5", "two.js"]);
    expect(HtmlOverlayLibraryLocksSchema.parse([
      getApprovedHtmlOverlayLibraryLock("two.js"),
      getApprovedHtmlOverlayLibraryLock("p5"),
    ]).map(lock => lock.specifier)).toEqual(["p5", "two.js"]);
  });

  test("allows only exact bare specifiers and rejects duplicates", () => {
    expect(HtmlOverlayLibrarySelectionSchema.parse([
      "vgpu",
      "three",
      "two.js",
      "p5",
      "motion",
    ])).toEqual(["motion", "p5", "three", "two.js", "vgpu"]);
    expect(HtmlOverlayLibrarySelectionSchema.safeParse(["motion", "motion"]).success).toBe(false);
    expect(HtmlOverlayLibrarySelectionSchema.safeParse(["motion/mini"]).success).toBe(false);
    expect(HtmlOverlayLibrarySelectionSchema.safeParse(["three/addons/"]).success).toBe(false);
    expect(() => getApprovedHtmlOverlayLibraryLock("unknown" as "motion")).toThrow();
  });

  test("generates a canonical port-independent import map", () => {
    const map = createHtmlOverlayImportMap([
      "vgpu",
      "three",
      "two.js",
      "p5",
      "@paper-design/shaders",
      "motion",
    ]);
    expect(map).toEqual({
      imports: {
        "@paper-design/shaders": htmlOverlayLibraryLocalUrl("@paper-design/shaders"),
        motion: htmlOverlayLibraryLocalUrl("motion"),
        p5: htmlOverlayLibraryLocalUrl("p5"),
        "two.js": htmlOverlayLibraryLocalUrl("two.js"),
        three: htmlOverlayLibraryLocalUrl("three"),
        vgpu: htmlOverlayLibraryLocalUrl("vgpu"),
      },
    });
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.imports)).toBe(true);
    expect(serializeHtmlOverlayImportMap(["three", "motion"]))
      .toBe(serializeHtmlOverlayImportMap(["motion", "three"]));
    expect(serializeHtmlOverlayImportMap(["motion"])).not.toContain("https://esm.sh");
  });
});
