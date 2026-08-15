import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyOverlaySourceChunks,
  ingestGeneratedVideoOverlayAsset,
  ingestOverlayAsset,
  parseSvgIntrinsicSize,
} from "./asset-ingest";

function mp4Bytes(): Uint8Array {
  return Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
}

function movBytes(): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 20,
    0x66, 0x74, 0x79, 0x70,
    0x71, 0x74, 0x20, 0x20,
    0, 0, 0, 0,
    0x71, 0x74, 0x20, 0x20,
  ]);
}

test("content-addresses a generated MOV with exact generated provenance", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-generated-overlay-test-"));
  const bundle = join(temporary, "project_generated01");
  const source = join(temporary, "rendered.mov");
  const bytes = movBytes();
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const input = {
    command: ["bun", "run", "studio", "html-overlay", "render"],
    generator: "atet-html-overlay",
    generatorVersion: "1",
    path: source,
    sourceSha256,
  } as const;
  try {
    await writeFile(source, bytes);

    const first = await ingestGeneratedVideoOverlayAsset(bundle, input);
    const second = await ingestGeneratedVideoOverlayAsset(bundle, input);

    expect(first).toEqual({
      bytes: bytes.byteLength,
      created: true,
      mediaType: "video/quicktime",
      path: `assets/${sourceSha256}.mov`,
      provenance: {
        command: [...input.command],
        generator: input.generator,
        generatorVersion: input.generatorVersion,
        kind: "generated",
        sourceSha256,
      },
      sha256: sourceSha256,
    });
    expect(second).toEqual({ ...first, created: false });
    expect(await readFile(join(bundle, first.path))).toEqual(Buffer.from(bytes));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects a generated MOV whose expected hash does not match its rendered bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-generated-overlay-hash-test-"));
  const bundle = join(temporary, "project_generated02");
  const source = join(temporary, "rendered.mov");
  try {
    await writeFile(source, movBytes());

    expect(ingestGeneratedVideoOverlayAsset(bundle, {
      command: ["render-overlay"],
      generator: "test-renderer",
      generatorVersion: "1",
      path: source,
      sourceSha256: createHash("sha256").update("different bytes").digest("hex"),
    })).rejects.toThrow(/does not match the rendered MOV bytes/u);
    expect(await readdir(join(bundle, "assets"))).toEqual([]);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects invalid generated MOV signatures before publication", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-generated-overlay-signature-test-"));
  const bundle = join(temporary, "project_generated03");
  const source = join(temporary, "rendered.mov");
  const bytes = Buffer.from("not a QuickTime movie", "utf8");
  try {
    await writeFile(source, bytes);

    expect(ingestGeneratedVideoOverlayAsset(bundle, {
      command: ["render-overlay"],
      generator: "test-renderer",
      generatorVersion: "1",
      path: source,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    })).rejects.toThrow(/do not match video\/quicktime/u);
    expect(await readdir(join(bundle, "assets"))).toEqual([]);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("rejects symlink sources for generated MOV ingestion", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-generated-overlay-path-test-"));
  const source = join(temporary, "rendered.mov");
  const sourceLink = join(temporary, "rendered-link.mov");
  const bytes = movBytes();
  try {
    await writeFile(source, bytes);
    await symlink(source, sourceLink);

    expect(ingestGeneratedVideoOverlayAsset(join(temporary, "project_generated04"), {
      command: ["render-overlay"],
      generator: "test-renderer",
      generatorVersion: "1",
      path: sourceLink,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    })).rejects.toThrow(/may not be a symlink/u);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("content-addresses image, SVG, GIF, and video overlays", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-assets-test-"));
  const bundle = join(temporary, "rec_assets001");
  try {
    const inputs = [
      { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), kind: "image", name: "image.png" },
      { bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><use href='#safe'/></svg>"), kind: "svg", name: "safe.svg" },
      { bytes: new TextEncoder().encode("GIF89a"), kind: "gif", name: "animation.gif" },
      { bytes: mp4Bytes(), kind: "video", name: "clip.mp4" },
    ] as const;
    for (const input of inputs) {
      const source = join(temporary, input.name);
      await writeFile(source, input.bytes);
      const first = await ingestOverlayAsset(bundle, source, input.kind);
      const second = await ingestOverlayAsset(bundle, source, input.kind);
      expect(first.path).toBe(second.path);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(first.path).toStartWith(`assets/${first.sha256}.`);
      expect(first.provenance).toMatchObject({ kind: "imported", originalName: input.name });
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("concurrently creates a fresh asset directory without losing either overlay", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-assets-parallel-test-"));
  const bundle = join(temporary, "project_parallel01");
  const firstSource = join(temporary, "first.png");
  const secondSource = join(temporary, "second.png");
  try {
    await Promise.all([
      writeFile(
        firstSource,
        Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
        ]),
      ),
      writeFile(
        secondSource,
        Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2,
        ]),
      ),
    ]);

    const [first, second] = await Promise.all([
      ingestOverlayAsset(bundle, firstSource, "image"),
      ingestOverlayAsset(bundle, secondSource, "image"),
    ]);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.path).not.toBe(second.path);
    expect((await readdir(join(bundle, "assets"))).sort()).toEqual(
      [
        first.path.slice(first.path.lastIndexOf("/") + 1),
        second.path.slice(second.path.lastIndexOf("/") + 1),
      ].sort(),
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("settles same-content parallel publication before verifying the winner", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-assets-same-content-test-"));
  const source = join(temporary, "same.png");
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
  ]);
  try {
    await writeFile(source, bytes);
    for (let round = 0; round < 16; round += 1) {
      const bundle = join(temporary, `project_same_${round}`);
      await mkdir(join(bundle, "assets"), { mode: 0o700, recursive: true });

      const ingested = await Promise.all(
        Array.from({ length: 16 }, () => ingestOverlayAsset(bundle, source, "image")),
      );

      expect(ingested.filter(result => result.created)).toHaveLength(1);
      expect(new Set(ingested.map(result => result.path))).toHaveLength(1);
      expect(await readdir(join(bundle, "assets"))).toEqual([
        ingested[0]!.path.slice(ingested[0]!.path.lastIndexOf("/") + 1),
      ]);
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("streams large non-SVG overlays without applying the in-memory SVG bound", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-large-overlay-test-"));
  const bundle = join(temporary, "rec_large0001");
  const source = join(temporary, "large.mp4");
  const bytes = 40 * 1024 * 1024 + 17;
  try {
    const handle = await open(source, "wx", 0o600);
    try {
      await handle.write(mp4Bytes(), 0, mp4Bytes().byteLength, 0);
      await handle.truncate(bytes);
    } finally {
      await handle.close();
    }

    const ingested = await ingestOverlayAsset(bundle, source, "video");

    expect(ingested.bytes).toBe(bytes);
    expect(ingested.mediaType).toBe("video/mp4");
    const destination = join(bundle, ingested.path);
    expect((await stat(destination)).size).toBe(bytes);
    const ingestedHandle = await open(destination, "r");
    try {
      const prefix = Buffer.alloc(mp4Bytes().byteLength);
      expect((await ingestedHandle.read(prefix, 0, prefix.byteLength, 0)).bytesRead).toBe(prefix.byteLength);
      expect(prefix).toEqual(Buffer.from(mp4Bytes()));
    } finally {
      await ingestedHandle.close();
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("stream copier tolerates partial reads and writes without dropping bytes", async () => {
  const source = Buffer.from("partial reads and partial writes must still copy every byte", "utf8");
  const destination = Buffer.alloc(source.byteLength);
  const copied = await copyOverlaySourceChunks({
    read: (buffer, offset, length, position) => {
      const bytesRead = Math.min(3, length, source.byteLength - position);
      if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
      return Promise.resolve({ bytesRead });
    },
  }, {
    write: (buffer, offset, length, position) => {
      const bytesWritten = Math.min(2, length);
      buffer.copy(destination, position, offset, offset + bytesWritten);
      return Promise.resolve({ bytesWritten });
    },
  }, source.byteLength);

  expect(destination).toEqual(source);
  expect(copied).toMatchObject({
    bytes: source.byteLength,
    sha256: createHash("sha256").update(source).digest("hex"),
  });
  expect(copied.signature).toEqual(source);
});

test("stream copier rejects a source that ends before its declared size", () => {
  let reads = 0;
  const operation = copyOverlaySourceChunks({
    read: (buffer, offset) => {
      reads += 1;
      if (reads > 1) return Promise.resolve({ bytesRead: 0 });
      buffer[offset] = 1;
      return Promise.resolve({ bytesRead: 1 });
    },
  }, {
    write: (_buffer, _offset, length) => Promise.resolve({ bytesWritten: length }),
  }, 2);
  expect(operation).rejects.toThrow(/ended or changed/u);
});

test("verifies an existing content-addressed collision by streaming and preserves it", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-collision-test-"));
  const bundle = join(temporary, "rec_collision1");
  const assets = join(bundle, "assets");
  const source = join(temporary, "image.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const destination = join(assets, `${sha256}.png`);
  const collision = Buffer.alloc(bytes.byteLength, 7);
  try {
    await mkdir(assets, { recursive: true });
    await Promise.all([
      writeFile(source, bytes),
      writeFile(destination, collision, { mode: 0o600 }),
    ]);

    expect(ingestOverlayAsset(bundle, source, "image"))
      .rejects.toThrow(/content-addressed overlay collision/iu);
    expect(await readFile(destination)).toEqual(collision);
    expect(await readdir(assets)).toEqual([`${sha256}.png`]);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("rejects a persistent hardlink at a content-addressed asset leaf", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-overlay-hardlink-test-"));
  const bundle = join(temporary, "rec_hardlink1");
  const assets = join(bundle, "assets");
  const source = join(temporary, "source.png");
  const outside = join(temporary, "outside.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const destination = join(assets, `${sha256}.png`);
  try {
    await mkdir(assets, { recursive: true });
    await Promise.all([
      writeFile(source, bytes),
      writeFile(outside, bytes, { mode: 0o600 }),
    ]);
    await link(outside, destination);

    expect(ingestOverlayAsset(bundle, source, "image"))
      .rejects.toThrow(/not a private physical regular file/iu);
    expect(await readFile(destination)).toEqual(bytes);
    expect((await stat(destination)).nlink).toBe(2);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects oversized SVG intrinsic dimensions during ingestion", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-svg-size-test-"));
  try {
    const source = join(temporary, "huge.svg");
    await writeFile(source, "<svg xmlns='http://www.w3.org/2000/svg' width='20000' height='1'></svg>");
    expect(ingestOverlayAsset(join(temporary, "bundle"), source, "svg"))
      .rejects.toThrow(/intrinsic dimensions/u);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("keeps SVG sanitation on a bounded in-memory path", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-svg-byte-bound-test-"));
  const source = join(temporary, "oversized.svg");
  try {
    const handle = await open(source, "wx", 0o600);
    try {
      const prefix = Buffer.from("<svg width='1' height='1'></svg>", "utf8");
      await handle.write(prefix, 0, prefix.byteLength, 0);
      await handle.truncate(32 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    expect(ingestOverlayAsset(join(temporary, "bundle"), source, "svg"))
      .rejects.toThrow(/1 through 33554432 bytes/u);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("derives a missing SVG dimension from the viewBox aspect ratio", () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  expect(parseSvgIntrinsicSize(encode("<svg width='100' viewBox='0 0 1 10'></svg>")))
    .toEqual({ height: 1_000, width: 100 });
  expect(parseSvgIntrinsicSize(encode("<svg height='100' viewBox='0 0 10 1'></svg>")))
    .toEqual({ height: 100, width: 1_000 });
  expect(() => parseSvgIntrinsicSize(encode("<svg width='16384' viewBox='0 0 1 10'></svg>")))
    .toThrow(/intrinsic dimensions/u);
});

test("rejects active SVG content and external resource references", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-svg-test-"));
  const bundle = join(temporary, "rec_svg00001");
  const source = join(temporary, "unsafe.svg");
  const unsafe = [
    "<svg><script>alert(1)</script></svg>",
    "<svg><foreignObject><div>unsafe</div></foreignObject></svg>",
    "<svg><path onclick='run()'/></svg>",
    "<svg><image href='https://example.com/a.png'/></svg>",
    "<svg><image href='data:image/png;base64,AAAA'/></svg>",
    "<svg><style>@import 'https://example.com/a.css';</style></svg>",
    "<svg><style>.x { fill: url(https://example.com/a.svg); }</style></svg>",
  ];
  try {
    for (const contents of unsafe) {
      await writeFile(source, contents);
      let failure: unknown;
      try {
        await ingestOverlayAsset(bundle, source, "svg");
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("do not match image/svg+xml");
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("rejects symlink sources and asset-directory escapes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-asset-path-test-"));
  try {
    const source = join(temporary, "image.png");
    const sourceLink = join(temporary, "image-link.png");
    await writeFile(source, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await symlink(source, sourceLink);
    let sourceFailure: unknown;
    try {
      await ingestOverlayAsset(join(temporary, "rec_source01"), sourceLink, "image");
    } catch (error) {
      sourceFailure = error;
    }
    expect(String(sourceFailure)).toContain("may not be a symlink");

    const bundle = join(temporary, "rec_bundle01");
    const outside = join(temporary, "outside");
    await mkdir(bundle, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(bundle, "assets"));
    let directoryFailure: unknown;
    try {
      await ingestOverlayAsset(bundle, source, "image");
    } catch (error) {
      directoryFailure = error;
    }
    expect(String(directoryFailure)).toContain("asset directory is a symlink");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("rejects a symlink at a content-addressed asset leaf", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-asset-leaf-test-"));
  const bundle = join(temporary, "rec_leaf0001");
  const source = join(temporary, "image.png");
  const outside = join(temporary, "outside.png");
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  try {
    await writeFile(source, bytes);
    await writeFile(outside, bytes);
    const first = await ingestOverlayAsset(bundle, source, "image");
    const destination = join(bundle, first.path);
    await rm(destination);
    await symlink(outside, destination);

    let failure: unknown;
    try {
      await ingestOverlayAsset(bundle, source, "image");
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("may not be a symlink");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
