import { describe, expect, test } from "bun:test";
import { createContext, runInContext, runInNewContext } from "node:vm";

import {
  createHtmlOverlayRuntimeFrame,
  type HtmlOverlayParameters,
} from "./contracts";
import { createHtmlOverlayRandom, htmlOverlayRandomFor } from "./random";
import { createHtmlOverlayBrowserRuntimeSource } from "./runtime";

interface FakeAnimation {
  currentTime?: number;
  pause(): void;
  time?: number;
}

interface PublicOverlayApi {
  readonly parameters: unknown;
  readonly random: () => number;
  readonly randomFor: (key: string) => number;
  asset(name: string): string;
  onFrame(callback: (frame: unknown) => Promise<void> | void): () => void;
  ready(promise: Promise<unknown>): Promise<unknown>;
  trackAnimation<T extends FakeAnimation>(animation: T): T;
}

interface HostController {
  renderFrame(frame: unknown): Promise<void>;
}

function runtimeFixture(parameters: HtmlOverlayParameters = { label: "hello" }) {
  const canvas = { deviceScaleFactor: 1, height: 360, width: 640 };
  const timing = { durationUs: 2_000_000, fps: 30 };
  const source = createHtmlOverlayBrowserRuntimeSource({
    canvas,
    parameters,
    resources: [{
      bytes: 4,
      mediaType: "image/png",
      name: "logo",
      sha256: "a".repeat(64),
      urlPath: "images/logo.png",
    }],
    seed: 42,
    timing,
  });
  return { canvas, source, timing };
}

describe("injected HTML overlay browser runtime", () => {
  test("keeps renderFrame host-only and seeks animations after readiness before callbacks", async () => {
    const events: string[] = [];
    const documentAnimation: FakeAnimation = {
      currentTime: -1,
      pause: () => events.push("document-pause"),
    };
    const context: {
      document: { getAnimations(): FakeAnimation[] };
      AtetOverlay?: PublicOverlayApi;
    } = {
      document: { getAnimations: () => [documentAnimation] },
    };
    const { canvas, source, timing } = runtimeFixture();
    const host = runInNewContext(source, context) as HostController;
    const overlay = context.AtetOverlay;
    expect(overlay).toBeDefined();
    if (overlay === undefined) throw new Error("Runtime did not install AtetOverlay.");
    expect(Object.isFrozen(overlay)).toBe(true);
    expect(context.AtetOverlay).toBe(overlay);
    expect(Object.hasOwn(overlay, "renderFrame")).toBe(false);
    expect(Object.isFrozen(overlay.parameters)).toBe(true);
    expect(overlay.asset("logo"))
      .toBe(`/.atet-overlay/assets/${"a".repeat(64)}/images/logo.png`);
    expect(() => overlay.asset("missing")).toThrow("not declared");

    let releaseReady: (() => void) | undefined;
    void overlay.ready(new Promise<void>(resolve => {
      releaseReady = resolve;
    }));
    const motion: FakeAnimation = {
      pause: () => events.push("motion-pause"),
      time: -1,
    };
    overlay.trackAnimation(motion);
    overlay.onFrame(() => {
      events.push("callback");
      expect(documentAnimation.currentTime).toBe(1_000 / 30);
      expect(motion.time).toBe(1 / 30);
    });

    const rendering = host.renderFrame(createHtmlOverlayRuntimeFrame(1, canvas, timing));
    await Promise.resolve();
    expect(events).toEqual(["motion-pause"]);
    releaseReady?.();
    await rendering;
    expect(events).toEqual([
      "motion-pause",
      "document-pause",
      "motion-pause",
      "callback",
    ]);
    expect(() => overlay.onFrame(() => undefined)).toThrow("before the first");
  });

  test("shares the pinned random algorithm and rejects forged frames", () => {
    const context: {
      document: { getAnimations(): FakeAnimation[] };
      performance: { now(): number; timeOrigin: number };
      AtetOverlay?: PublicOverlayApi;
    } = {
      document: { getAnimations: () => [] },
      performance: { now: () => -1, timeOrigin: -1 },
    };
    const { canvas, source, timing } = runtimeFixture();
    const host = runInNewContext(source, context) as HostController;
    const overlay = context.AtetOverlay;
    if (overlay === undefined) throw new Error("Runtime did not install AtetOverlay.");
    expect(context.AtetOverlay).toBe(overlay);

    const expected = createHtmlOverlayRandom(42);
    expect([overlay.random(), overlay.random(), overlay.random()])
      .toEqual([expected(), expected(), expected()]);
    expect(overlay.randomFor("particle:7")).toBe(htmlOverlayRandomFor(42, "particle:7"));
    expect(overlay.randomFor("particle:7")).toBe(overlay.randomFor("particle:7"));
    expect(host.renderFrame({
      ...createHtmlOverlayRuntimeFrame(0, canvas, timing),
      timeMs: 1,
    })).rejects.toThrow("timeMs");
  });

  test("drives finite timer and animation-frame readiness on the absolute clock", async () => {
    const context: {
      document: { getAnimations(): FakeAnimation[] };
      performance: { now(): number; timeOrigin: number };
      AtetOverlay?: PublicOverlayApi;
    } = {
      document: { getAnimations: () => [] },
      performance: { now: () => -1, timeOrigin: -1 },
    };
    const { canvas, source, timing } = runtimeFixture();
    const sandbox = createContext(context);
    const host = runInContext(source, sandbox) as HostController;
    runInContext(`
      globalThis.readinessEvents = [];
      AtetOverlay.ready(new Promise(resolve => {
        setTimeout(() => {
          readinessEvents.push("timer:" + Date.now());
          resolve();
        }, 1);
      }));
      AtetOverlay.ready(new Promise(resolve => {
        requestAnimationFrame(timeMs => {
          readinessEvents.push("raf:" + timeMs);
          resolve();
        });
      }));
      AtetOverlay.onFrame(frame => {
        readinessEvents.push(
          "frame:" + frame.timeMs + ":" + Date.now() + ":" + performance.now()
        );
      });
    `, sandbox);

    await host.renderFrame(createHtmlOverlayRuntimeFrame(0, canvas, timing));
    expect(runInContext("readinessEvents", sandbox)).toEqual([
      "raf:0",
      "timer:946684800001",
      "frame:0:946684800000:0",
    ]);
  });

  test("removes native timing and object-URL entropy before author code", () => {
    class FakeFile {
      readonly lastModified: number;

      constructor(
        _bits: unknown,
        _name: unknown,
        options: { readonly lastModified?: number } = {},
      ) {
        this.lastModified = options.lastModified ?? -1;
      }
    }
    class FakeUrl {
      static createObjectURL(): string {
        return "blob:random";
      }

      static revokeObjectURL(): void {}
    }
    class FakeCrypto {
      getRandomValues<T>(value: T): T {
        return value;
      }
    }
    class FakeEvent {
      get timeStamp(): number {
        return Math.random();
      }
    }
    class FakePerformance {
      getEntries(): readonly unknown[] {
        return [{ duration: Math.random() }];
      }

      getEntriesByName(): readonly unknown[] {
        return [{ duration: Math.random() }];
      }

      getEntriesByType(): readonly unknown[] {
        return [{ duration: Math.random() }];
      }

      now(): number {
        return Math.random();
      }
    }
    class FakeTimeline {
      get currentTime(): number {
        return Math.random();
      }
    }
    const context = createContext({
      crypto: new FakeCrypto(),
      DOMException,
      Event: FakeEvent,
      File: FakeFile,
      PerformanceObserver: class {},
      URL: FakeUrl,
      document: {
        getAnimations: () => [],
        timeline: new FakeTimeline(),
      },
      performance: new FakePerformance(),
    });
    const { source } = runtimeFixture();
    runInContext(source, context);
    const evidence: unknown = runInContext(`(() => {
      let objectUrlDenied = false;
      let observerDenied = false;
      try {
        URL.createObjectURL({});
      } catch {
        objectUrlDenied = true;
      }
      try {
        new PerformanceObserver(() => {});
      } catch {
        observerDenied = true;
      }
      return {
        cryptoPrototypeMatches:
          Object.getPrototypeOf(crypto).getRandomValues === crypto.getRandomValues,
        datePrototypeTime: Date.prototype.constructor.now(),
        eventTime: new Event("same").timeStamp,
        entries: performance.getEntriesByType("navigation").length,
        fileTime: new File([], "same.txt").lastModified,
        filePrototypeTime:
          new (Object.getPrototypeOf(File.prototype).constructor)(
            [],
            "same.txt"
          ).lastModified,
        intlDefaultIsEpoch: (() => {
          const format = new Intl.DateTimeFormat(
            "en-US",
            { timeZone: "UTC", year: "numeric" }
          );
          return format.format() === format.format(946684800000);
        })(),
        objectUrlDenied,
        observerDenied,
        performancePrototypeTime:
          Object.getPrototypeOf(performance).now.call(performance),
        timelineTime: document.timeline.currentTime,
        timeOrigin: performance.timeOrigin,
        toJSON: performance.toJSON(),
      };
    })()`, context);
    expect(evidence).toEqual({
      cryptoPrototypeMatches: true,
      datePrototypeTime: 946_684_800_000,
      eventTime: 0,
      entries: 0,
      fileTime: 946_684_800_000,
      filePrototypeTime: 946_684_800_000,
      intlDefaultIsEpoch: true,
      objectUrlDenied: true,
      observerDenied: true,
      performancePrototypeTime: 0,
      timelineTime: 0,
      timeOrigin: 946_684_800_000,
      toJSON: { timeOrigin: 946_684_800_000 },
    });
  });

  test("canonicalizes embedded data and script-escapes hostile parameter text", () => {
    const left = runtimeFixture({ alpha: 1, closing: "</script>", zebra: 2 }).source;
    const right = runtimeFixture({ zebra: 2, closing: "</script>", alpha: 1 }).source;
    expect(left).toBe(right);
    expect(left).not.toContain("</script>");
    expect(left).toContain("\\u003c/script\\u003e");
  });
});
