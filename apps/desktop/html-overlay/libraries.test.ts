import { describe, expect, test } from "bun:test";

import {
  APPROVED_HTML_OVERLAY_LIBRARY_LOCKS,
  HtmlOverlayLibraryLockSchema,
  HtmlOverlayLibrarySelectionSchema,
  createHtmlOverlayImportMap,
  getApprovedHtmlOverlayLibraryLock,
  htmlOverlayLibraryLocalUrl,
  serializeHtmlOverlayImportMap,
} from "./libraries";

describe("HTML overlay locked libraries", () => {
  test("pins the exact direct resolved esm.sh modules", () => {
    expect(APPROVED_HTML_OVERLAY_LIBRARY_LOCKS).toEqual([
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
  });

  test("rejects every mutation of an otherwise valid lock", () => {
    const motion = getApprovedHtmlOverlayLibraryLock("motion");
    for (const mutation of [
      { ...motion, bytes: motion.bytes + 1 },
      { ...motion, license: "Apache-2.0" },
      { ...motion, sha256: "f".repeat(64) },
      { ...motion, url: "https://esm.sh/motion@12.42.2/mini.mjs" },
      { ...motion, version: "12.42.3" },
      { ...motion, shell: true },
    ]) {
      expect(HtmlOverlayLibraryLockSchema.safeParse(mutation).success).toBe(false);
    }
  });

  test("allows only exact bare specifiers and rejects duplicates", () => {
    expect(HtmlOverlayLibrarySelectionSchema.parse(["vgpu", "three", "motion"]))
      .toEqual(["motion", "three", "vgpu"]);
    expect(HtmlOverlayLibrarySelectionSchema.safeParse(["motion", "motion"]).success).toBe(false);
    expect(HtmlOverlayLibrarySelectionSchema.safeParse(["motion/mini"]).success).toBe(false);
    expect(HtmlOverlayLibrarySelectionSchema.safeParse(["three/addons/"]).success).toBe(false);
    expect(() => getApprovedHtmlOverlayLibraryLock("unknown" as "motion")).toThrow();
  });

  test("generates a canonical port-independent import map", () => {
    const map = createHtmlOverlayImportMap([
      "vgpu",
      "three",
      "@paper-design/shaders",
      "motion",
    ]);
    expect(map).toEqual({
      imports: {
        "@paper-design/shaders": htmlOverlayLibraryLocalUrl("@paper-design/shaders"),
        motion: htmlOverlayLibraryLocalUrl("motion"),
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
