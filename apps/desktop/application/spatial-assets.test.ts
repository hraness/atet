import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { EvaluatedSpatialSceneSchema, type SpatialAssetManifest, type SpatialEntity } from "../../../src/spatial-scene/contracts";
import { composeTransform } from "../../../src/spatial-scene/math";
import { createSpatialOverlayBatch } from "../html-overlay/spatial";
import type { ApplicationProcessRunner } from "./context";
import { inertSpatialSvg, spatialOpenTypeFont, spatialVideoTimeUs, withPreparedSpatialAssets } from "./spatial-assets";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const transform = { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
const surface = { entityId: "entity_surface", name: "Surface", parentId: null, transform, placement: { kind: "world" }, origin: { kind: "authored" }, visible: true } as const;
const png = () => sharp(Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 0]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
const runner: ApplicationProcessRunner = { run: async () => { throw new Error("Unexpected native invocation"); } };
const imageEntity = (): SpatialEntity => ({ ...surface, kind: "image", assetId: "asset_image", width: 2, height: 1, fit: "stretch", opacity: 1 });
function manifest(bytes: Uint8Array, kind: "image" | "video" = "image"): SpatialAssetManifest {
  return { assetId: "asset_image", payload: { path: "asset.bin", sha256: sha(bytes), bytes: bytes.length }, dependencies: [],
    provenance: { source: "authored", description: "Original test fixture" },
    interpretation: kind === "image" ? { kind, width: 2, height: 1, colorSpace: "srgb", alpha: "straight", mimeType: "image/png" }
      : { kind, width: 2, height: 1, colorSpace: "srgb", alpha: "straight", durationUs: 1_000_000, frameRate: { numerator: 3, denominator: 1 } } };
}
function snapshot(assets: readonly SpatialAssetManifest[], entity = imageEntity(), timeUs = 0) {
  return EvaluatedSpatialSceneSchema.parse({ kind: "atet.spatial-snapshot", schemaVersion: 1, sceneSha256: "a".repeat(64), stateSha256: "b".repeat(64), viewSha256: "c".repeat(64), timeUs,
    assets, camera: { cameraId: "camera_main", name: "Main", pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      projection: { kind: "perspective", width: 320, height: 180, near: 0.1, far: 10, fx: 160, fy: 170, cx: 160, cy: 90 } },
    entities: [{ entity, worldMatrix: composeTransform(transform), visible: true, selectionId: 1 }] });
}
async function workspace<Result>(use: (root: string, parent: string) => Promise<Result>): Promise<Result> {
  const temporary = await mkdtemp(join(tmpdir(), "atet-spatial-assets-test-"));
  // /var aliases /private/var on macOS; the production boundary requires physical roots.
  const { realpath } = await import("node:fs/promises");
  const path = await realpath(temporary), root = join(path, "assets"), parent = join(path, "work");
  await mkdir(root); await mkdir(parent);
  try { return await use(root, parent); } finally { await rm(path, { force: true, recursive: true }); }
}

describe("contained spatial asset preparation", () => {
  test("captures exact source bytes, publishes immutable raster, and cleans after consumer settlement", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const bytes = await png(); await writeFile(join(assetRoot, "asset.bin"), bytes);
      const frame = snapshot([manifest(bytes)]);
      let outputPath = "";
      const result = await withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [frame] }, { runner }, new AbortController().signal, async prepared => {
        expect(prepared.preparedAssets).toHaveLength(1); expect(prepared.resources).toHaveLength(1);
        outputPath = prepared.resources[0]!.absolutePath;
        expect(sha(await readFile(outputPath))).toBe(prepared.resources[0]!.sha256);
        expect(createSpatialOverlayBatch({ snapshots: [frame], preparedAssets: prepared.preparedAssets, frameRate: { numerator: 30_000, denominator: 1_001 }, mode: { kind: "beauty" } }).authoring.resources).toHaveLength(1);
        expect(prepared.receipt.profiles).toContain("sdr-png-jpeg-sharp-0.35.3");
        return "consumed";
      });
      expect(result).toBe("consumed"); expect(await readdir(workspaceParent)).toEqual([]);
      await expect(access(outputPath)).rejects.toThrow();
      expect(sha(await readFile(join(assetRoot, "asset.bin")))).toBe(sha(bytes));
    });
  });

  test("rejects source substitution, final symlink, and parent symlink without publication", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const bytes = await png(), source = manifest(bytes), request = { assetRoot, workspaceParent, snapshots: [snapshot([source])] };
      await writeFile(join(assetRoot, "asset.bin"), new Uint8Array(bytes.length));
      await expect(withPreparedSpatialAssets(request, { runner }, new AbortController().signal, async () => undefined)).rejects.toThrow("digest");
      await rm(join(assetRoot, "asset.bin")); await writeFile(join(workspaceParent, "outside.png"), bytes);
      await symlink(join(workspaceParent, "outside.png"), join(assetRoot, "asset.bin"));
      await expect(withPreparedSpatialAssets(request, { runner }, new AbortController().signal, async () => undefined)).rejects.toThrow();
      await symlink(workspaceParent, join(assetRoot, "linked"));
      const withParent = { ...source, payload: { ...source.payload, path: "linked/outside.png" } };
      await expect(withPreparedSpatialAssets({ ...request, snapshots: [snapshot([withParent])] }, { runner }, new AbortController().signal, async () => undefined)).rejects.toThrow("physical");
    });
  });

  test("cleanup runs after a consumer throws and preserves immutable sources", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const bytes = await png(); await writeFile(join(assetRoot, "asset.bin"), bytes);
      await expect(withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([manifest(bytes)])] }, { runner }, new AbortController().signal, async () => { throw new Error("Consumer failed"); })).rejects.toThrow("Consumer failed");
      expect(await readdir(workspaceParent)).toEqual([]);
    });
  });

  test("rejects stale decoded dimensions and format interpretation", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const bytes = await png(); await writeFile(join(assetRoot, "asset.bin"), bytes);
      const source = manifest(bytes);
      const stale = { ...source, interpretation: { kind: "image", width: 3, height: 1, colorSpace: "srgb", alpha: "straight", mimeType: "image/png" } };
      await expect(withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([stale as SpatialAssetManifest])] }, { runner }, new AbortController().signal, async () => undefined)).rejects.toThrow("dimensions");
    });
  });

  test("aborted input never creates a staging directory", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const abort = new AbortController(); abort.abort(new Error("Stopped"));
      await expect(withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([])] }, { runner }, abort.signal, async () => undefined)).rejects.toThrow("Stopped");
      expect(await readdir(workspaceParent)).toEqual([]);
    });
  });
});

describe("shape-only SVG and declared font qualification", () => {
  test("renders a diagram v1 through the existing parser with only declared fonts", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const font = await readFile(new URL("../../../src/assets/fonts/nebula-sans/NebulaSans-Book.otf", import.meta.url));
      const diagram = new TextEncoder().encode(JSON.stringify({ version: 1, name: "original-diagram", canvas: { width: 320, height: 180 }, shapes: [{ id: "box", type: "rect", x: 20, y: 20, width: 280, height: 140, label: "Evidence", icon: "check" }], edges: [] }));
      await writeFile(join(assetRoot, "font.otf"), font); await writeFile(join(assetRoot, "diagram.json"), diagram);
      const assets: SpatialAssetManifest[] = [
        { assetId: "asset_font", payload: { path: "font.otf", bytes: font.length, sha256: sha(font) }, interpretation: { kind: "font", format: "otf", family: "Nebula Sans" }, dependencies: [], provenance: { source: "imported", description: "Declared bundled font" } },
        { assetId: "asset_diagram", payload: { path: "diagram.json", bytes: diagram.length, sha256: sha(diagram) }, interpretation: { kind: "diagram", schemaVersion: 1, theme: "light" }, dependencies: ["asset_font"], provenance: { source: "authored", description: "Original diagram" } },
      ];
      const entity: SpatialEntity = { ...surface, kind: "diagram", assetId: "asset_diagram", width: 2, height: 1, fit: "contain", opacity: 1 };
      const frame = snapshot(assets, entity);
      await withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [frame] }, { runner }, new AbortController().signal, async prepared => {
        expect(prepared.preparedAssets[0]).toMatchObject({ kind: "raster", width: 320, height: 180 });
        createSpatialOverlayBatch({ snapshots: [frame], preparedAssets: prepared.preparedAssets, frameRate: { numerator: 24, denominator: 1 }, mode: { kind: "beauty" } });
      });
      await expect(withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([{ ...assets[1]!, dependencies: [] }], entity)] }, { runner }, new AbortController().signal, async () => undefined)).rejects.toThrow("declared font");
    });
  });
  test("rebuilds original SVG shapes and rejects every active/reference seam", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect x="0" y="0" width="2" height="1" fill="#ff0000"/></svg>';
    expect(inertSpatialSvg(source)).toBe(source);
    for (const markup of ['<script/>', '<image href="file:///secret"/>', '<text>Hi</text>', '<rect style="fill:red"/>', '<g onclick="bad()"/>', '<use href="#x"/>', '<foreignObject/>', '<path fill="url(#x)" d="M0 0L1 1Z"/>']) {
      expect(() => inertSpatialSvg(`<svg>${markup}</svg>`)).toThrow();
    }
    expect(() => inertSpatialSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg/>')).toThrow();
    expect(() => inertSpatialSvg('<svg><g></svg>')).toThrow();
    expect(() => inertSpatialSvg('<svg/><svg/>')).toThrow();
  });

  test("OTF coverage verifies actual family and missing glyphs without font discovery", async () => {
    const bytes = await readFile(new URL("../../../src/assets/fonts/nebula-sans/NebulaSans-Book.otf", import.meta.url));
    const font = spatialOpenTypeFont(bytes, "Nebula Sans");
    expect(font.hasGlyph(65)).toBe(true); expect(font.hasGlyph(0x10ffff)).toBe(false);
    expect(() => spatialOpenTypeFont(bytes, "Invented Family")).toThrow("family");
    expect(() => spatialOpenTypeFont(bytes.subarray(0, 100), "Nebula Sans")).toThrow();
  });

  test("declared OTF text is rasterized with exact content binding; overflow is explicit", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const bytes = await readFile(new URL("../../../src/assets/fonts/nebula-sans/NebulaSans-Book.otf", import.meta.url));
      await writeFile(join(assetRoot, "font.otf"), bytes);
      const source: SpatialAssetManifest = { assetId: "asset_font", payload: { path: "font.otf", sha256: sha(bytes), bytes: bytes.length }, interpretation: { kind: "font", family: "Nebula Sans", format: "otf" }, dependencies: [], provenance: { source: "imported", description: "Bundled OFL font fixture" } };
      const entity: SpatialEntity = { ...surface, kind: "text", fontAssetId: "asset_font", text: "Hello", fontSize: 0.1, width: 2, color: "#ff0000", align: "left" };
      const frame = snapshot([source], entity);
      await withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [frame] }, { runner }, new AbortController().signal, async prepared => {
        const asset = prepared.preparedAssets[0]!;
        expect(asset.kind).toBe("raster"); if (asset.kind !== "raster") throw new Error("Expected raster");
        expect(asset.entityContentSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(createSpatialOverlayBatch({ snapshots: [frame], preparedAssets: prepared.preparedAssets, frameRate: { numerator: 24, denominator: 1 }, mode: { kind: "beauty" } }).metadata.frames[0]?.objects[0]?.representation).toBe("prepared-text-raster");
      });
      await expect(withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([source], { ...entity, width: 0.01 })] }, { runner }, new AbortController().signal, async () => undefined)).rejects.toThrow("explicit width");
      await expect(withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([source], { ...entity, text: String.fromCodePoint(0x10ffff) })] }, { runner }, new AbortController().signal, async () => undefined)).rejects.toThrow("codepoint");
    });
  });
});

describe("qualified GLB host integration", () => {
  function triangleGlb(): Uint8Array {
    const data = Buffer.alloc(36);
    [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => data.writeFloatLE(value, index * 4));
    const object = { asset: { version: "2.0" }, buffers: [{ byteLength: data.length }], bufferViews: [{ buffer: 0, byteLength: data.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }], scenes: [{ nodes: [0] }], scene: 0,
      nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.123456, 0.2, 0.3, 0.4], metallicFactor: 0.2, roughnessFactor: 0.7 }, alphaMode: "OPAQUE" }] };
    const json = Buffer.from(JSON.stringify(object)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded);
    const glb = Buffer.alloc(12 + 8 + padded.length + 8 + data.length);
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
    const binaryOffset = 20 + padded.length; glb.writeUInt32LE(data.length, binaryOffset); glb.writeUInt32LE(0x004e4942, binaryOffset + 4); data.copy(glb, binaryOffset + 8);
    return glb;
  }

  test("two instances retain separate entity/source material policies without 8-bit color loss", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      const bytes = triangleGlb(); await writeFile(join(assetRoot, "model.glb"), bytes);
      const asset: SpatialAssetManifest = { assetId: "asset_glb", payload: { path: "model.glb", bytes: bytes.length, sha256: sha(bytes) }, interpretation: { kind: "gltf", format: "glb", metersPerUnit: 1, sourceUp: "y" }, dependencies: [], provenance: { source: "authored", description: "Original triangle" } };
      const source: SpatialEntity = { ...surface, kind: "mesh", geometry: { kind: "asset", assetId: "asset_glb", materialMode: "source" }, material: { kind: "unlit", color: "#ff0000", opacity: 1 } };
      const entity: SpatialEntity = { ...source, entityId: "entity_instance", geometry: { kind: "asset", assetId: "asset_glb", materialMode: "entity" } };
      const base = snapshot([asset], source), frame = { ...base, entities: [...base.entities, { ...base.entities[0]!, entity, selectionId: 2 }] };
      await withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [frame, { ...frame, timeUs: 500_000 }] }, { runner }, new AbortController().signal, async prepared => {
        expect(prepared.preparedAssets).toHaveLength(2);
        const [a, b] = prepared.preparedAssets;
        if (a?.kind !== "geometry" || b?.kind !== "geometry") throw new Error("Expected geometry");
        expect(a.entityId).not.toBe(b.entityId); expect(a.primitives[0]?.linearColor).toEqual([0.123456, 0.2, 0.3]);
        expect(a.primitives[0]?.material?.opacity).toBe(1); expect(b.primitives[0]?.material).toBeUndefined();
        expect(prepared.resources).toHaveLength(2);
        for (const geometry of [a, b]) {
          if (geometry.resource === undefined) throw new Error("Expected geometry resource");
          const resource = prepared.resources.find(item => item.name === geometry.resource!.name)!;
          const bytes = await readFile(resource.absolutePath);
          expect(resource.mediaType).toBe("application/json");
          expect(bytes.byteLength).toBe(geometry.resource.bytes);
          expect(sha(bytes)).toBe(geometry.resource.sha256);
          expect(JSON.parse(bytes.toString())).toEqual(geometry.primitives);
        }
        expect(prepared.receipt.outputBytes).toBe(prepared.resources.reduce((sum, item) => sum + item.bytes, 0));
        const batch = createSpatialOverlayBatch({ snapshots: [frame, { ...frame, timeUs: 500_000 }], preparedAssets: prepared.preparedAssets, frameRate: { numerator: 24, denominator: 1 }, mode: { kind: "beauty" } });
        expect(batch.authoring.resources).toEqual(prepared.resources.map(({ absolutePath: _path, ...resource }) => resource).sort((left, right) => left.name.localeCompare(right.name)));
      });
    });
  });
});

describe("absolute video frame preparation", () => {
  const video = (playback: "once" | "loop" | "freeze" = "once"): Extract<SpatialEntity, { kind: "video" }> => ({ ...surface, kind: "video", assetId: "asset_image", width: 2, height: 1, fit: "stretch", opacity: 1, sourceOffsetUs: 0, playback });
  const bytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  function videoRunner(selected: number[], pixelFormat = "rgba"): ApplicationProcessRunner {
    return { run: async argv => {
      if (argv[0] === "ffprobe-fixture") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ streams: [{ width: 2, height: 1, pix_fmt: pixelFormat, avg_frame_rate: "3/1", time_base: "1/3", color_transfer: "iec61966-2-1", color_primaries: "bt709", color_space: "gbr" }], frames: [
        { best_effort_timestamp: 0, best_effort_timestamp_time: "0.000000", duration: 1 }, { best_effort_timestamp: 1, best_effort_timestamp_time: "0.333333", duration: 1 }, { best_effort_timestamp: 2, best_effort_timestamp_time: "0.666667", duration: 1 },
      ] }) };
      const filter = argv[argv.indexOf("-vf") + 1]!;
      if (pixelFormat === "gbrp") expect(filter).toMatch(/,format=rgba$/u);
      const index = Number(/select=eq\(n\\,(\d+)\)/u.exec(filter)?.[1]);
      selected.push(index); expect(argv).toContain("-enable_drefs"); expect(argv).toContain("-use_absolute_path");
      await writeFile(argv.at(-1)!, await png());
      return { exitCode: 0, stdout: "", stderr: "" };
    } };
  }

  test("integer once, loop, and freeze clock laws are explicit", () => {
    expect(spatialVideoTimeUs(video("loop"), 1_500_000, 1_000_000)).toBe(500_000);
    expect(spatialVideoTimeUs(video("freeze"), 1_500_000, 1_000_000)).toBe(999_999);
    expect(() => spatialVideoTimeUs(video(), 1_000_000, 1_000_000)).toThrow("half-open");
  });

  test("Studio lossless RGB gbrp video prepares exact world-surface frames without a YUV transfer conversion", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      await writeFile(join(assetRoot, "asset.bin"), bytes);
      const source = manifest(bytes, "video");
      if (source.interpretation.kind !== "video") throw new Error("Expected video");
      const opaque = { ...source, interpretation: { ...source.interpretation, alpha: "opaque" as const } }, selected: number[] = [];
      const entity = { ...video(), sourceOffsetUs: 100_000 };
      const frames = [snapshot([opaque], entity, 566_667), snapshot([opaque], entity, 0), snapshot([opaque], entity, 566_667)];
      await withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: frames, exactSceneTimesUs: [
        { numerator: "1700000", denominator: "3" }, { numerator: "0", denominator: "1" }, { numerator: "1700000", denominator: "3" },
      ] }, { runner: videoRunner(selected, "gbrp"), ffmpegCommand: "ffmpeg-fixture", ffprobeCommand: "ffprobe-fixture" }, new AbortController().signal, async prepared => {
        expect(selected).toEqual([2,0]);
        expect(prepared.preparedAssets).toHaveLength(2);
        expect(prepared.preparedAssets[0]).toMatchObject({ kind: "raster", alpha: "opaque", sourceFrameIndex: 2, sourcePts: 2,
          sourceTimeBase: { numerator: "1", denominator: "3" }, sourceExactTimeUs: { numerator: "2000000", denominator: "3" } });
        createSpatialOverlayBatch({ snapshots: frames, preparedAssets: prepared.preparedAssets, frameRate: { numerator: 3, denominator: 1 }, mode: { kind: "beauty" } });
      });
    });
  });

  test("reverse, repeated, and last fractional samples decode exact frame indices once", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      await writeFile(join(assetRoot, "asset.bin"), bytes);
      const source = manifest(bytes, "video"), selected: number[] = [];
      const frames = [snapshot([source], video(), 700_000), snapshot([source], video(), 0), snapshot([source], video(), 700_000), snapshot([source], video(), 1_000_000)];
      await withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: frames, exactSceneTimesUs: [
        { numerator: "700000", denominator: "1" }, { numerator: "0", denominator: "1" }, { numerator: "700000", denominator: "1" }, { numerator: "9999996", denominator: "10" },
      ] }, { runner: videoRunner(selected), ffmpegCommand: "ffmpeg-fixture", ffprobeCommand: "ffprobe-fixture" }, new AbortController().signal, async prepared => {
        expect(selected).toEqual([2, 0]);
        expect(prepared.preparedAssets).toHaveLength(3);
        const last = prepared.preparedAssets[2]!;
        if (last.kind !== "raster") throw new Error("Expected raster");
        expect(last.sourceFrameIndex).toBe(2); expect(last.sourcePresentationTimeUs).toBe(666_667);
        expect(last.sourceExactTimeUs).toEqual({ numerator: "4999998", denominator: "5" });
        createSpatialOverlayBatch({ snapshots: frames, preparedAssets: prepared.preparedAssets, frameRate: { numerator: 3, denominator: 1 }, mode: { kind: "beauty" } });
      });
    });
  });

  test("rejects exact-time collisions and cleans native work after failure", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      await writeFile(join(assetRoot, "asset.bin"), bytes);
      const source = manifest(bytes, "video");
      await expect(withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([source], video(), 0), snapshot([source], video(), 0)], exactSceneTimesUs: [{ numerator: "0", denominator: "1" }, { numerator: "1", denominator: "10" }] },
        { runner: videoRunner([]), ffmpegCommand: "ffmpeg-fixture", ffprobeCommand: "ffprobe-fixture" }, new AbortController().signal, async () => undefined)).rejects.toThrow("collide");
      expect(await readdir(workspaceParent)).toEqual([]);
    });
  });
  test("native integer PTS prevents early selection at rounded decimal boundaries", async () => {
    await workspace(async (assetRoot, workspaceParent) => {
      await writeFile(join(assetRoot, "asset.bin"), bytes);
      const source = manifest(bytes, "video"), selected: number[] = [];
      await withPreparedSpatialAssets({ assetRoot, workspaceParent, snapshots: [snapshot([source], video(), 333_333)], exactSceneTimesUs: [{ numerator: "3333331", denominator: "10" }] },
        { runner: videoRunner(selected), ffmpegCommand: "ffmpeg-fixture", ffprobeCommand: "ffprobe-fixture" }, new AbortController().signal, async prepared => {
          expect(selected).toEqual([0]);
          expect(prepared.preparedAssets[0]).toMatchObject({ sourcePts: 0, sourceTimeBase: { numerator: "1", denominator: "3" } });
        });
    });
  });
});
