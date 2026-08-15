import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { inflateSync } from "node:zlib";

import { afterEach, expect, test } from "bun:test";
import type { Browser } from "playwright-core";

import {
  HtmlOverlayAuthoringInputSchema,
  createHtmlOverlayScaffold,
  serializeHtmlOverlayImportMap,
  type HtmlOverlayLibrarySpecifier,
  type HtmlOverlayScaffoldKind,
} from "../html-overlay";
import { bindExactCapability } from "../application/capability-binding";
import { bindHtmlOverlayBrowserRuntime } from "../application/html-overlay-browser-runtime";
import { PlaywrightHtmlOverlayRenderer } from "./html-overlay-renderer";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_RENDERER_SMOKE =
  process.env.ATET_RUN_HTML_OVERLAY_RENDERER_SMOKE === "1";
const RENDERER_SMOKE_UNAVAILABLE =
  !RUN_RENDERER_SMOKE
  || process.platform !== "darwin"
  || !await Bun.file(CHROME).exists();
const roots: string[] = [];

async function setUserImmutableFlag(path: string, immutable: boolean): Promise<void> {
  const child = Bun.spawn([
    "/usr/bin/chflags",
    immutable ? "uchg" : "nouchg",
    path,
  ], {
    env: {
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "ignore",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`chflags failed: ${stderr.trim() || String(exitCode)}`);
  }
}

async function removeTestRoot(root: string): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(root, { force: true, recursive: true });
      return;
    } catch (error) {
      failure = error;
      if (!(error instanceof Error && "code" in error && error.code === "EFAULT")) {
        throw error;
      }
      await Bun.sleep(25);
    }
  }
  throw failure;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeTestRoot(root);
  }
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (
    leftDistance <= aboveDistance
    && leftDistance <= upperLeftDistance
  ) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function readRgbaPngPixel(
  png: Buffer,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (
    png[24] !== 8
    || png[25] !== 6
    || png[26] !== 0
    || png[27] !== 0
    || png[28] !== 0
    || x < 0
    || x >= width
    || y < 0
    || y >= height
  ) {
    throw new Error(
      "Expected an in-bounds pixel in a non-interlaced 8-bit RGBA PNG.",
    );
  }

  const idat: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.byteLength;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
    if (type === "IEND") break;
  }
  if (idat.length === 0) throw new Error("PNG has no IDAT payload.");

  const compressedRows = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  if (compressedRows.byteLength !== height * (stride + 1)) {
    throw new Error("PNG scanline length does not match its declared dimensions.");
  }
  const pixels = Buffer.allocUnsafe(height * stride);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = compressedRows[sourceOffset++];
    for (let column = 0; column < stride; column += 1) {
      const raw = compressedRows[sourceOffset++]!;
      const target = row * stride + column;
      const left = column >= bytesPerPixel ? pixels[target - bytesPerPixel]! : 0;
      const above = row > 0 ? pixels[target - stride]! : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? pixels[target - stride - bytesPerPixel]!
        : 0;
      const decoded = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : filter === 4
                ? raw + paethPredictor(left, above, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(decoded)) {
        throw new Error(`Unsupported PNG filter ${String(filter)}.`);
      }
      pixels[target] = decoded & 0xff;
    }
  }
  const pixelOffset = y * stride + x * bytesPerPixel;
  return [
    pixels[pixelOffset]!,
    pixels[pixelOffset + 1]!,
    pixels[pixelOffset + 2]!,
    pixels[pixelOffset + 3]!,
  ];
}

let browserRuntimeBinding: ReturnType<typeof bindHtmlOverlayBrowserRuntime>
  | undefined;

async function browserRuntime() {
  browserRuntimeBinding ??= bindExactCapability({
    available: true,
    command: CHROME,
    name: "html-browser",
    version: "chrome integration",
  }).then(bindHtmlOverlayBrowserRuntime);
  return await browserRuntimeBinding;
}

async function render(root: string): Promise<readonly Buffer[]> {
  const frames = join(root, "frames");
  const renderer = new PlaywrightHtmlOverlayRenderer({
    cacheRoot: join(root, "cache"),
    fetch: () => {
      throw new Error("The plain scaffold must not fetch a browser library.");
    },
  });
  const authoring = HtmlOverlayAuthoringInputSchema.parse({
    canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
    html: createHtmlOverlayScaffold("plain"),
    kind: "atet.html-overlay",
    libraries: [],
    parameters: {},
    resources: [],
    schemaVersion: 1,
    seed: 42,
    timing: { durationUs: 1_000_000, fps: 2 },
  });
  await mkdir(frames, { mode: 0o700 });
  const result = await renderer.renderFrames({
    authoring,
    browserRuntime: await browserRuntime(),
    outputDirectory: frames,
    resources: [],
  }, new AbortController().signal);
  expect(result.frameCount).toBe(2);
  return await Promise.all([0, 1].map(async frame =>
    await readFile(join(
      frames,
      "frames",
      `frame-${String(frame).padStart(8, "0")}.png`,
    ))));
}

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "renders deterministic transparent frames with the runtime installed before author code",
  async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "atet-html-renderer-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "atet-html-renderer-b-"));
    roots.push(firstRoot, secondRoot);
    const [first, second] = await Promise.all([
      render(firstRoot),
      render(secondRoot),
    ]);
    expect(first.map(digest)).toEqual(second.map(digest));
    expect(digest(first[0]!)).not.toBe(digest(first[1]!));
    for (const png of first) {
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(png.readUInt32BE(16)).toBe(320);
      expect(png.readUInt32BE(20)).toBe(180);
      expect(png[25]).toBe(6);
    }
  },
  600_000,
);

test.skipIf(
  process.env.ATET_RUN_HTML_OVERLAY_LIBRARY_SMOKE !== "1"
  || process.platform !== "darwin"
  || !await Bun.file(CHROME).exists()
)(
  "loads an exact declared image as a deterministic Three.js texture",
  async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const resource = {
      bytes: png.byteLength,
      mediaType: "image/png",
      name: "generated-image",
      sha256: digest(png),
      urlPath: "images/generated-image",
    } as const;
    const html = `<!doctype html>
<style>html, body, #scene { width: 100%; height: 100%; margin: 0; } #scene { display: block; }</style>
<canvas id="scene"></canvas>
<script type="importmap">${serializeHtmlOverlayImportMap(["three"])}</script>
<script type="module">
  import * as THREE from "three";
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    canvas: document.querySelector("#scene"),
    premultipliedAlpha: false,
  });
  renderer.setSize(AtetOverlay.width, AtetOverlay.height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const material = new THREE.MeshBasicMaterial();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));
  AtetOverlay.ready(
    new THREE.TextureLoader()
      .loadAsync(AtetOverlay.asset("generated-image"))
      .then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        material.map = texture;
        material.needsUpdate = true;
      }),
  );
  AtetOverlay.onFrame(() => renderer.render(scene, camera));
</script>`;

    const renderOnce = async (root: string): Promise<Buffer> => {
      roots.push(root);
      const frames = join(root, "frames");
      const resourcePath = join(root, "generated.png");
      await Promise.all([
        mkdir(frames, { mode: 0o700 }),
        writeFile(resourcePath, png, { mode: 0o600 }),
      ]);
      const authoring = HtmlOverlayAuthoringInputSchema.parse({
        canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
        html,
        kind: "atet.html-overlay",
        libraries: ["three"],
        parameters: {},
        resources: [resource],
        schemaVersion: 1,
        seed: 42,
        timing: { durationUs: 500_000, fps: 1 },
      });
      const renderer = new PlaywrightHtmlOverlayRenderer({
        cacheRoot: join(root, "cache"),
      });
      await renderer.renderFrames({
        authoring,
        browserRuntime: await browserRuntime(),
        outputDirectory: frames,
        resources: [{ ...resource, absolutePath: resourcePath }],
      }, new AbortController().signal);
      return await readFile(join(frames, "frames", "frame-00000000.png"));
    };

    const first = await renderOnce(
      await mkdtemp(join(tmpdir(), "atet-html-three-texture-a-")),
    );
    const second = await renderOnce(
      await mkdtemp(join(tmpdir(), "atet-html-three-texture-b-")),
    );
    expect(digest(first)).toBe(digest(second));
    expect(first[25]).toBe(6);
    const [red, green, blue, alpha] = readRgbaPngPixel(first, 160, 90);
    expect(red).toBeGreaterThanOrEqual(240);
    expect(green).toBeLessThanOrEqual(10);
    expect(blue).toBeLessThanOrEqual(10);
    expect(alpha).toBeGreaterThanOrEqual(250);
    expect(readRgbaPngPixel(first, 0, 0)[3]).toBe(0);
  },
  1_800_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "rejects undeclared browser requests before publishing a frame sequence",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-renderer-blocked-"));
    roots.push(root);
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
      fetch: () => {
        throw new Error("An authored URL must never reach the module fetch boundary.");
      },
    });
    const authoring = HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
      html: [
        '<!doctype html><img src="https://example.com/undeclared.png" alt="">',
        "<script>window.open('https://example.com/undeclared-popup')</script>",
      ].join(""),
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [],
      schemaVersion: 1,
      seed: 42,
      timing: { durationUs: 500_000, fps: 1 },
    });
    expect(renderer.renderFrames({
      authoring,
      browserRuntime: await browserRuntime(),
      outputDirectory: frames,
      resources: [],
    }, new AbortController().signal)).rejects.toThrow("undeclared browser access");
  },
  90_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "parses authored HTML structure without treating comments as host elements",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-renderer-parser-"));
    roots.push(root);
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
    });
    const authoring = HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
      html: `<!doctype html>
<!-- <head> -->
<!-- <script type="importmap">{}</script> -->
<script type="import&#x6d;ap">{"imports":{}}</script>
<div id="proof"></div>
<script>
  if (document.querySelectorAll('script[type="importmap"]').length !== 1) {
    throw new Error("Atet must install exactly one import map.");
  }
  AtetOverlay.onFrame(() => {
    document.querySelector("#proof").style.cssText =
      "position:absolute;inset:0;background:#6d5dfc";
  });
</script>`,
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [],
      schemaVersion: 1,
      seed: 42,
      timing: { durationUs: 500_000, fps: 1 },
    });
    const result = await renderer.renderFrames({
      authoring,
      browserRuntime: await browserRuntime(),
      outputDirectory: frames,
      resources: [],
    }, new AbortController().signal);
    expect(result.frameCount).toBe(1);
    expect(
      (await readFile(
        join(frames, "frames", "frame-00000000.png"),
      )).readUInt32BE(16),
    ).toBe(320);
  },
  600_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "loads an integrity-bound declared PNG through AtetOverlay.asset",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-renderer-png-"));
    roots.push(root);
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlRFAAAAABJRU5ErkJggg==",
      "base64",
    );
    const resourcePath = join(root, "declared.png");
    await writeFile(resourcePath, png, { mode: 0o600 });
    const resource = {
      bytes: png.byteLength,
      mediaType: "image/png",
      name: "declared-pixel",
      sha256: digest(png),
      urlPath: "images/declared.png",
    } as const;
    const authoring = HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
      html: `<!doctype html>
<img id="declared" alt="" style="width:100%;height:100%;image-rendering:pixelated">
<script>
  const image = document.querySelector("#declared");
  image.src = AtetOverlay.asset("declared-pixel");
  AtetOverlay.ready(image.decode().then(() => {
    if (image.naturalWidth !== 1 || image.naturalHeight !== 1) {
      throw new Error("declared PNG dimensions changed");
    }
  }));
</script>`,
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [resource],
      schemaVersion: 1,
      seed: 42,
      timing: { durationUs: 500_000, fps: 1 },
    });
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
    });
    const result = await renderer.renderFrames({
      authoring,
      browserRuntime: await browserRuntime(),
      outputDirectory: frames,
      resources: [{ ...resource, absolutePath: resourcePath }],
    }, new AbortController().signal);
    const resourceLeaf = result.executionIntegrity.leaves.find(
      leaf => leaf.key === "resource:declared-pixel",
    );
    expect(resourceLeaf?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const screenshot = await readFile(
      join(frames, "frames", "frame-00000000.png"),
    );
    expect(screenshot.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  },
  90_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "publishes no partial frame directory when a later frame fails",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-renderer-partial-"));
    roots.push(root);
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
    });
    const authoring = HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
      html: `<!doctype html><script>
AtetOverlay.onFrame(({ frame }) => {
  if (frame === 1) throw new Error("the second frame failed");
});
</script>`,
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [],
      schemaVersion: 1,
      seed: 42,
      timing: { durationUs: 1_000_000, fps: 2 },
    });
    let failure: unknown;
    try {
      await renderer.renderFrames({
        authoring,
        browserRuntime: await browserRuntime(),
        outputDirectory: frames,
        resources: [],
      }, new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(await readdir(frames)).toEqual([]);
  },
  90_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "virtualizes ambient browser time and entropy",
  async () => {
    const renderAmbient = async (root: string): Promise<Buffer> => {
      const frames = join(root, "frames");
      await mkdir(frames, { mode: 0o700 });
      const renderer = new PlaywrightHtmlOverlayRenderer({
        cacheRoot: join(root, "cache"),
      });
      const authoring = HtmlOverlayAuthoringInputSchema.parse({
        canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
        html: `<!doctype html>
<div id="ambient"></div>
<style>
  #ambient {
    width: 100%;
    height: 100%;
  }
</style>
<script>
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const prototypeBytes = Object.getPrototypeOf(crypto).getRandomValues.call(
    crypto,
    new Uint8Array(2),
  );
  const uuid = crypto.randomUUID();
  const random = Math.random();
  const implicitFileTime = new File(["same"], "same.txt").lastModified;
  const prototypeFileTime =
    new (Object.getPrototypeOf(File.prototype).constructor)(
      ["same"],
      "same.txt",
    ).lastModified;
  const prototypeDate = Date.prototype.constructor.now();
  const prototypePerformance =
    Object.getPrototypeOf(performance).now.call(performance);
  const eventTime = new Event("same").timeStamp;
  const timelineTime = document.timeline.currentTime ?? 0;
  const intlTime = new Intl.DateTimeFormat(
    "en-US",
    { timeZone: "UTC", year: "numeric" },
  ).format();
  const intlValue = [...intlTime].reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  const navigationCount = performance.getEntriesByType("navigation").length;
  let objectUrlDenied = 0;
  try {
    URL.createObjectURL(new Blob(["same"]));
  } catch {
    objectUrlDenied = 1;
  }
  AtetOverlay.onFrame(({ timeMs }) => {
    const uuidValue = [...uuid].reduce((total, character) => total + character.charCodeAt(0), 0);
    const timeValue = Math.floor(
      Date.now()
      + performance.now()
      + implicitFileTime
      + prototypeFileTime
      + prototypeDate
      + prototypePerformance
      + eventTime
      + timelineTime
      + intlValue
      + navigationCount
      + objectUrlDenied
      + timeMs
      + random * 255
    );
    document.querySelector("#ambient").style.background =
      "rgb("
      + ((bytes[0] + uuidValue) % 256) + " "
      + ((bytes[1] + prototypeBytes[0] + timeValue) % 256) + " "
      + ((bytes[2] + bytes[7]) % 256)
      + ")";
  });
</script>`,
        kind: "atet.html-overlay",
        libraries: [],
        parameters: {},
        resources: [],
        schemaVersion: 1,
        seed: 42,
        timing: { durationUs: 500_000, fps: 1 },
      });
      await renderer.renderFrames({
        authoring,
        browserRuntime: await browserRuntime(),
        outputDirectory: frames,
        resources: [],
      }, new AbortController().signal);
      return await readFile(join(frames, "frames", "frame-00000000.png"));
    };

    const firstRoot = await mkdtemp(join(tmpdir(), "atet-html-ambient-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "atet-html-ambient-b-"));
    roots.push(firstRoot, secondRoot);
    const [first, second] = await Promise.all([
      renderAmbient(firstRoot),
      renderAmbient(secondRoot),
    ]);
    expect(digest(first)).toBe(digest(second));
  },
  90_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "bounds never-settling author readiness and closes the browser",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-renderer-timeout-"));
    roots.push(root);
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    const renderer = new PlaywrightHtmlOverlayRenderer({
      browserStepTimeoutMs: 120_000,
      cacheRoot: join(root, "cache"),
      frameTimeoutMs: 200,
    });
    const authoring = HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
      html: "<!doctype html><script>AtetOverlay.ready(new Promise(() => {}))</script>",
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [],
      schemaVersion: 1,
      seed: 42,
      timing: { durationUs: 500_000, fps: 1 },
    });
    expect(renderer.renderFrames({
      authoring,
      browserRuntime: await browserRuntime(),
      outputDirectory: frames,
      resources: [],
    }, new AbortController().signal)).rejects.toThrow("exceeded 200ms");
  },
  150_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "does not launch after cancellation and closes a launch that settles late",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-renderer-abort-"));
    roots.push(root);
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    let closeCalls = 0;
    let newContextCalls = 0;
    const trackedBrowser = {
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
      newContext: () => {
        newContextCalls += 1;
        return Promise.reject(new Error("newContext must not be called."));
      },
    } as unknown as Browser;
    let releaseLaunch = (): void => undefined;
    const launchGate = new Promise<void>(resolve => {
      releaseLaunch = resolve;
    });
    let announceLaunch = (): void => undefined;
    const launchStarted = new Promise<void>(resolve => {
      announceLaunch = resolve;
    });
    let launchCalls = 0;
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
      launch: async () => {
        launchCalls += 1;
        announceLaunch();
        await launchGate;
        return trackedBrowser;
      },
    });
    const authoring = HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
      html: createHtmlOverlayScaffold("plain"),
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [],
      schemaVersion: 1,
      seed: 42,
      timing: { durationUs: 500_000, fps: 1 },
    });
    const controller = new AbortController();
    const cancellation = new Error("renderer cancellation");
    const rendering = renderer.renderFrames({
      authoring,
      browserRuntime: await browserRuntime(),
      outputDirectory: frames,
      resources: [],
    }, controller.signal);
    await launchStarted;
    controller.abort(cancellation);
    releaseLaunch();
    expect(rendering).rejects.toBe(cancellation);
    await rendering.catch(() => undefined);
    expect({ closeCalls, launchCalls, newContextCalls }).toEqual({
      closeCalls: 1,
      launchCalls: 1,
      newContextCalls: 0,
    });

    let preCancelledLaunchCalls = 0;
    const preCancelledRenderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "pre-cancelled-cache"),
      launch: () => {
        preCancelledLaunchCalls += 1;
        return Promise.resolve(trackedBrowser);
      },
    });
    const preCancelled = new AbortController();
    preCancelled.abort(cancellation);
    expect(preCancelledRenderer.renderFrames({
      authoring,
      browserRuntime: await browserRuntime(),
      outputDirectory: frames,
      resources: [],
    }, preCancelled.signal)).rejects.toBe(cancellation);
    await Promise.resolve();
    expect(preCancelledLaunchCalls).toBe(0);
  },
  90_000,
);

test.skipIf(RENDERER_SMOKE_UNAVAILABLE)(
  "rejects a signed whole-app-root swap even when owner flags and bytes are restored",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-root-swap-"));
    roots.push(root);
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    let observedMaliciousRoot = false;
    let newContextCalls = 0;
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
      launch: async options => {
        const runtimeRoot = join(options.executablePath!, "..", "..", "..");
        const snapshotParent = dirname(runtimeRoot);
        const originalRoot = join(snapshotParent, "Original.app");
        await setUserImmutableFlag(runtimeRoot, false);
        await rename(runtimeRoot, originalRoot);
        try {
          const substituteExecutable = join(
            runtimeRoot,
            "Contents",
            "MacOS",
            basename(options.executablePath!),
          );
          await mkdir(dirname(substituteExecutable), {
            mode: 0o755,
            recursive: true,
          });
          await writeFile(substituteExecutable, "malicious signed-root substitute", {
            mode: 0o755,
          });
          observedMaliciousRoot = await Bun.file(substituteExecutable).exists();
          await rm(runtimeRoot, { force: true, recursive: true });
        } finally {
          await rename(originalRoot, runtimeRoot);
        }
        await setUserImmutableFlag(runtimeRoot, true);
        return {
          close: () => Promise.resolve(),
          newContext: () => {
            newContextCalls += 1;
            return Promise.reject(new Error("must not create a context"));
          },
        } as unknown as Browser;
      },
    });
    const authoring = HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
      html: createHtmlOverlayScaffold("plain"),
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [],
      schemaVersion: 1,
      seed: 42,
      timing: { durationUs: 500_000, fps: 1 },
    });
    const rendering = renderer.renderFrames({
      authoring,
      browserRuntime: await browserRuntime(),
      outputDirectory: frames,
      resources: [],
    }, new AbortController().signal);
    expect(rendering).rejects.toThrow(
      /Browser runtime (?:snapshot container identity|filesystem) changed during browser launch/u,
    );
    await rendering.catch(() => undefined);
    expect(observedMaliciousRoot).toBe(true);
    expect(newContextCalls).toBe(0);
  },
  600_000,
);

test.skipIf(
  process.env.ATET_RUN_HTML_OVERLAY_LIBRARY_SMOKE !== "1"
  || process.platform !== "darwin"
  || !await Bun.file(CHROME).exists()
)(
  "renders every approved animated scaffold through its exact browser module",
  async () => {
    const cases: readonly {
      readonly kind: HtmlOverlayScaffoldKind;
      readonly libraries: readonly HtmlOverlayLibrarySpecifier[];
    }[] = [
      { kind: "motion", libraries: ["motion"] },
      { kind: "paper-shaders", libraries: ["@paper-design/shaders"] },
      { kind: "three", libraries: ["three"] },
    ];
    for (const item of cases) {
      const root = await mkdtemp(join(tmpdir(), `atet-html-${item.kind}-`));
      roots.push(root);
      const frames = join(root, "frames");
      await mkdir(frames, { mode: 0o700 });
      const authoring = HtmlOverlayAuthoringInputSchema.parse({
        canvas: { deviceScaleFactor: 1, height: 180, width: 320 },
        html: createHtmlOverlayScaffold(item.kind),
        kind: "atet.html-overlay",
        libraries: item.libraries,
        parameters: {},
        resources: [],
        schemaVersion: 1,
        seed: 42,
        timing: { durationUs: 500_000, fps: 1 },
      });
      const renderer = new PlaywrightHtmlOverlayRenderer({
        cacheRoot: join(root, "cache"),
      });
      const result = await renderer.renderFrames({
        authoring,
        browserRuntime: await browserRuntime(),
        outputDirectory: frames,
        resources: [],
      }, new AbortController().signal);
      expect(result.frameCount).toBe(1);
      expect(
        (
          await readFile(join(frames, "frames", "frame-00000000.png"))
        ).readUInt32BE(16),
      ).toBe(320);
    }
  },
  1_800_000,
);
