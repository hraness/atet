import {
  chmod,
  lchmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, LaunchOptions } from "playwright-core";

import { bindExactCapability } from "../application/capability-binding";
import { bindHtmlOverlayBrowserRuntime } from "../application/html-overlay-browser-runtime";
import {
  HtmlOverlayAuthoringInputSchema,
  createHtmlOverlayScaffold,
} from "../html-overlay";
import {
  PlaywrightHtmlOverlayRenderer,
  createHtmlOverlayBrowserLaunchArgs,
} from "./html-overlay-renderer";

const roots: string[] = [];

setDefaultTimeout(30_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "atet-browser-snapshot-"));
  roots.push(root);
  const source = join(root, "fixture-browser");
  const original = Buffer.from("#!/bin/sh\nexit 0\n");
  await writeFile(source, original, { mode: 0o755 });
  await chmod(source, 0o755);
  const capability = await bindExactCapability({
    available: true,
    command: source,
    name: "html-browser",
    version: "fixture",
  });
  return {
    authoring: HtmlOverlayAuthoringInputSchema.parse({
      canvas: { deviceScaleFactor: 1, height: 18, width: 32 },
      html: createHtmlOverlayScaffold("plain"),
      kind: "atet.html-overlay",
      libraries: [],
      parameters: {},
      resources: [],
      schemaVersion: 1,
      seed: 1,
      timing: { durationUs: 1_000_000, fps: 1 },
    }),
    browserRuntime: await bindHtmlOverlayBrowserRuntime(
      capability,
      undefined,
      { allowUnverifiedRuntimeForTesting: true },
    ),
    cache: join(root, "cache"),
    frames: join(root, "frames"),
    original,
    source,
  };
}

function failingBrowser(onClose: () => void): Browser {
  return {
    close: () => {
      onClose();
      return Promise.resolve();
    },
    newContext: () => Promise.reject(new Error("fixture stops after launch verification")),
  } as unknown as Browser;
}

describe("private HTML-overlay browser runtime launch", () => {
  test("adds the integrity-bound WebGPU flags only for vgpu", () => {
    const flags = [
      "--enable-unsafe-webgpu",
      "--use-webgpu-adapter=swiftshader",
    ];
    const plainArgs = createHtmlOverlayBrowserLaunchArgs([]);
    const vgpuArgs = createHtmlOverlayBrowserLaunchArgs(["vgpu"]);
    for (const flag of flags) {
      expect(plainArgs).not.toContain(flag);
      expect(vgpuArgs.filter(argument => argument === flag)).toHaveLength(1);
    }
  });

  test("source substitution and ambient secrets cannot redirect or enter the browser", async () => {
    const item = await setup();
    await mkdir(item.frames, { mode: 0o700 });
    let launched: LaunchOptions | undefined;
    let launchedBytes: Buffer | undefined;
    let closeCalls = 0;
    const previousSecret = process.env.ATET_BROWSER_SENTINEL_SECRET;
    const previousProxy = process.env.HTTPS_PROXY;
    process.env.ATET_BROWSER_SENTINEL_SECRET = "must-not-enter-browser";
    process.env.HTTPS_PROXY = "https://ambient-proxy.invalid";
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: item.cache,
      launch: async options => {
        launched = options;
        expect(options.args).not.toContain("--enable-unsafe-webgpu");
        expect(options.args).not.toContain("--use-webgpu-adapter=swiftshader");
        expect(options.env?.ATET_BROWSER_SENTINEL_SECRET).toBeUndefined();
        expect(options.env?.HTTPS_PROXY).toBeUndefined();
        expect(Object.keys(options.env ?? {}).sort()).toEqual([
          "HOME",
          "LANG",
          "LC_ALL",
          "PATH",
          "TMPDIR",
          "TZ",
        ]);
        expect(typeof options.env?.HOME).toBe("string");
        expect(options.env?.LANG).toBe("en_US.UTF-8");
        expect(options.env?.LC_ALL).toBe("en_US.UTF-8");
        expect(options.env?.PATH).toBe("/usr/bin:/bin");
        expect(typeof options.env?.TMPDIR).toBe("string");
        expect(options.env?.TZ).toBe("UTC");
        expect((await lstat(String(options.env?.HOME))).mode & 0o777).toBe(0o700);
        expect((await lstat(String(options.env?.TMPDIR))).mode & 0o777).toBe(0o700);
        await writeFile(item.source, "#!/bin/sh\nexit 99\n");
        launchedBytes = await readFile(options.executablePath!);
        return failingBrowser(() => {
          closeCalls += 1;
        });
      },
    });
    try {
      expect(renderer.renderFrames({
        authoring: item.authoring,
        browserRuntime: item.browserRuntime,
        outputDirectory: item.frames,
        resources: [],
      }, new AbortController().signal)).rejects.toThrow(/browser rendering failed/u);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.ATET_BROWSER_SENTINEL_SECRET;
      } else {
        process.env.ATET_BROWSER_SENTINEL_SECRET = previousSecret;
      }
      if (previousProxy === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = previousProxy;
      }
    }
    expect(launched?.executablePath).not.toBe(item.source);
    expect(launchedBytes).toEqual(item.original);
    expect(closeCalls).toBe(1);
  });

  test("launch-hook tampering of the private snapshot is detected before context creation", async () => {
    const item = await setup();
    await mkdir(item.frames, { mode: 0o700 });
    let newContextCalls = 0;
    let closeCalls = 0;
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: item.cache,
      launch: async options => {
        await writeFile(options.executablePath!, "tampered");
        return {
          close: () => {
            closeCalls += 1;
            return Promise.resolve();
          },
          newContext: () => {
            newContextCalls += 1;
            return Promise.reject(new Error("must not run"));
          },
        } as unknown as Browser;
      },
    });
    expect(renderer.renderFrames({
      authoring: item.authoring,
      browserRuntime: item.browserRuntime,
      outputDirectory: item.frames,
      resources: [],
    }, new AbortController().signal)).rejects.toThrow(/during browser launch/u);
    expect({ closeCalls, newContextCalls }).toEqual({
      closeCalls: 1,
      newContextCalls: 0,
    });
  });

  test("replace-launch-restore cannot erase snapshot executable identity evidence", async () => {
    const item = await setup();
    await mkdir(item.frames, { mode: 0o700 });
    let observedSubstitute = "";
    let newContextCalls = 0;
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: item.cache,
      launch: async options => {
        await writeFile(options.executablePath!, "substitute executable");
        observedSubstitute = await Bun.file(options.executablePath!).text();
        await writeFile(options.executablePath!, item.original);
        await chmod(options.executablePath!, 0o755);
        return {
          close: () => Promise.resolve(),
          newContext: () => {
            newContextCalls += 1;
            return Promise.reject(new Error("must not run"));
          },
        } as unknown as Browser;
      },
    });
    expect(renderer.renderFrames({
      authoring: item.authoring,
      browserRuntime: item.browserRuntime,
      outputDirectory: item.frames,
      resources: [],
    }, new AbortController().signal)).rejects.toThrow(
      /Browser runtime (?:snapshot identity|filesystem) changed during browser launch/u,
    );
    expect(observedSubstitute).toBe("substitute executable");
    expect(newContextCalls).toBe(0);
  });

  test("restored bundle resource and symlink substitutions remain detectable", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-browser-bundle-snapshot-"));
    roots.push(root);
    const bundle = join(root, "Fixture.app");
    const executable = join(bundle, "Contents", "MacOS", "Fixture");
    const resource = join(bundle, "Contents", "Resources", "snapshot.bin");
    const link = join(bundle, "Contents", "Resources", "CurrentSnapshot");
    await mkdir(join(bundle, "Contents", "MacOS"), { mode: 0o755, recursive: true });
    await mkdir(join(bundle, "Contents", "Resources"), { mode: 0o755, recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    await writeFile(resource, "bound resource", { mode: 0o644 });
    await symlink("snapshot.bin", link);
    if (process.platform === "darwin") await lchmod(link, 0o664);
    const browserRuntime = await bindHtmlOverlayBrowserRuntime(
      await bindExactCapability({
        available: true,
        command: executable,
        name: "html-browser",
        version: "bundle fixture",
      }),
      undefined,
      { allowUnverifiedRuntimeForTesting: true },
    );
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    let observedResource = "";
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
      launch: async options => {
        const snapshotContents = join(
          options.executablePath!,
          "..",
          "..",
          "Resources",
        );
        const snapshotResource = join(snapshotContents, "snapshot.bin");
        const snapshotLink = join(snapshotContents, "CurrentSnapshot");
        await writeFile(snapshotResource, "substitute resource");
        observedResource = await Bun.file(snapshotResource).text();
        await writeFile(snapshotResource, "bound resource");
        await unlink(snapshotLink);
        await symlink("missing.bin", snapshotLink);
        await unlink(snapshotLink);
        await symlink("snapshot.bin", snapshotLink);
        if (process.platform === "darwin") await lchmod(snapshotLink, 0o664);
        return failingBrowser(() => undefined);
      },
    });
    expect(renderer.renderFrames({
      authoring: itemAuthoring(),
      browserRuntime,
      outputDirectory: frames,
      resources: [],
    }, new AbortController().signal)).rejects.toThrow(
      /Browser runtime (?:snapshot identity|filesystem) changed during browser launch/u,
    );
    expect(observedResource).toBe("substitute resource");
  });

  test("whole app-root swap and restore cannot erase container pathname evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-browser-root-snapshot-"));
    roots.push(root);
    const bundle = join(root, "Fixture.app");
    const executable = join(bundle, "Contents", "MacOS", "Fixture");
    await mkdir(join(bundle, "Contents", "MacOS"), { mode: 0o755, recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    const browserRuntime = await bindHtmlOverlayBrowserRuntime(
      await bindExactCapability({
        available: true,
        command: executable,
        name: "html-browser",
        version: "whole-root fixture",
      }),
      undefined,
      { allowUnverifiedRuntimeForTesting: true },
    );
    const frames = join(root, "frames");
    await mkdir(frames, { mode: 0o700 });
    let observedMaliciousRoot = false;
    let newContextCalls = 0;
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(root, "cache"),
      launch: async options => {
        const snapshotRoot = join(options.executablePath!, "..", "..", "..");
        const snapshotParent = dirname(snapshotRoot);
        const originalRoot = join(snapshotParent, "Original.app");
        await rename(snapshotRoot, originalRoot);
        try {
          const substituteExecutable = join(
            snapshotRoot,
            "Contents",
            "MacOS",
            "Fixture",
          );
          await mkdir(dirname(substituteExecutable), {
            mode: 0o755,
            recursive: true,
          });
          await writeFile(substituteExecutable, "malicious app root", {
            mode: 0o755,
          });
          observedMaliciousRoot = await Bun.file(substituteExecutable).exists();
          await rm(snapshotRoot, { force: true, recursive: true });
        } finally {
          await rename(originalRoot, snapshotRoot);
        }
        return {
          close: () => Promise.resolve(),
          newContext: () => {
            newContextCalls += 1;
            return Promise.reject(new Error("must not run"));
          },
        } as unknown as Browser;
      },
    });
    const rendering = renderer.renderFrames({
      authoring: itemAuthoring(),
      browserRuntime,
      outputDirectory: frames,
      resources: [],
    }, new AbortController().signal);
    expect(rendering).rejects.toThrow(
      /Browser runtime (?:snapshot identity|snapshot container identity|filesystem) changed during browser launch/u,
    );
    await rendering.catch(() => undefined);
    expect(observedMaliciousRoot).toBe(true);
    expect(newContextCalls).toBe(0);
  });

  test.skipIf(process.platform !== "darwin")(
    "caller cache-root swap cannot enter the anchored launch path",
    async () => {
      const item = await setup();
      await mkdir(item.frames, { mode: 0o700 });
      await mkdir(item.cache, { mode: 0o700 });
      let launchedPath = "";
      let observedMaliciousExecutable = false;
      let newContextCalls = 0;
      const renderer = new PlaywrightHtmlOverlayRenderer({
        cacheRoot: item.cache,
        launch: async options => {
          launchedPath = options.executablePath!;
          const fromCache = relative(item.cache, launchedPath);
          const cacheIsAncestor = fromCache === ""
            || (!fromCache.startsWith("..") && !isAbsolute(fromCache));
          if (!cacheIsAncestor) {
            throw new Error("caller cache root is not a launch ancestor");
          }
          const originalCache = `${item.cache}.original`;
          await rename(item.cache, originalCache);
          try {
            await mkdir(dirname(launchedPath), { mode: 0o700, recursive: true });
            await writeFile(launchedPath, "malicious cache-root substitute", {
              mode: 0o755,
            });
            observedMaliciousExecutable = await Bun.file(launchedPath).exists();
            await rm(item.cache, { force: true, recursive: true });
          } finally {
            await rename(originalCache, item.cache);
          }
          return {
            close: () => Promise.resolve(),
            newContext: () => {
              newContextCalls += 1;
              return Promise.reject(new Error("must not create a context"));
            },
          } as unknown as Browser;
        },
      });
      const rendering = renderer.renderFrames({
        authoring: item.authoring,
        browserRuntime: item.browserRuntime,
        outputDirectory: item.frames,
        resources: [],
      }, new AbortController().signal);
      expect(rendering).rejects.toThrow(/browser rendering failed/u);
      await rendering.catch(() => undefined);
      expect(launchedPath.startsWith("/private/tmp/.atet-browser-runtime-"))
        .toBe(true);
      expect(observedMaliciousExecutable).toBe(false);
      expect(newContextCalls).toBe(0);
    },
  );

  test("cancellation during snapshot copying stops before launch and removes the private tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-browser-cancel-snapshot-"));
    roots.push(root);
    const bundle = join(root, "Fixture.app");
    const executable = join(bundle, "Contents", "MacOS", "Fixture");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(join(bundle, "Contents", "MacOS"), { mode: 0o755, recursive: true });
    await mkdir(resources, { mode: 0o755, recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    await Promise.all(Array.from({ length: 400 }, async (_, index) => {
      await writeFile(
        join(resources, `resource-${String(index).padStart(4, "0")}.bin`),
        `resource ${String(index)}`,
        { mode: 0o644 },
      );
    }));
    const browserRuntime = await bindHtmlOverlayBrowserRuntime(
      await bindExactCapability({
        available: true,
        command: executable,
        name: "html-browser",
        version: "cancellation fixture",
      }),
      undefined,
      { allowUnverifiedRuntimeForTesting: true },
    );
    const frames = join(root, "frames");
    const cache = join(root, "cache");
    const snapshotAnchor = process.platform === "darwin" ? "/private/tmp" : cache;
    const snapshotPrefix = ".atet-browser-runtime-";
    const beforeSnapshots = new Set(
      (await readdir(snapshotAnchor).catch(() => [] as string[]))
        .filter(name => name.startsWith(snapshotPrefix)),
    );
    await mkdir(frames, { mode: 0o700 });
    let launchCalls = 0;
    const renderer = new PlaywrightHtmlOverlayRenderer({
      cacheRoot: cache,
      launch: () => {
        launchCalls += 1;
        return Promise.reject(new Error("must not launch"));
      },
    });
    const controller = new AbortController();
    const cancellation = new Error("cancel during browser runtime snapshot");
    const rendering = renderer.renderFrames({
      authoring: itemAuthoring(),
      browserRuntime,
      outputDirectory: frames,
      resources: [],
    }, controller.signal);
    let observedSnapshotPath: string | undefined;
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const names = await readdir(snapshotAnchor).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.startsWith(snapshotPrefix) || beforeSnapshots.has(name)) continue;
        const candidate = join(snapshotAnchor, name);
        try {
          if ((await lstat(join(candidate, "Fixture.app"))).isDirectory()) {
            observedSnapshotPath = candidate;
            break;
          }
        } catch {
          // The copy may not have materialized its root yet.
        }
      }
      if (observedSnapshotPath !== undefined) break;
      await Bun.sleep(1);
    }
    expect(observedSnapshotPath).toBeDefined();
    controller.abort(cancellation);
    expect(rendering).rejects.toBe(cancellation);
    await rendering.catch(() => undefined);
    expect(launchCalls).toBe(0);
    let snapshotStillExists = false;
    try {
      await lstat(observedSnapshotPath!);
      snapshotStillExists = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    expect(snapshotStillExists).toBe(false);
  }, 30_000);
});

function itemAuthoring() {
  return HtmlOverlayAuthoringInputSchema.parse({
    canvas: { deviceScaleFactor: 1, height: 18, width: 32 },
    html: createHtmlOverlayScaffold("plain"),
    kind: "atet.html-overlay",
    libraries: [],
    parameters: {},
    resources: [],
    schemaVersion: 1,
    seed: 1,
    timing: { durationUs: 1_000_000, fps: 1 },
  });
}
