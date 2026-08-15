import { z } from "zod";

import { canonicalJson } from "../core/canonical-json";
import {
  HtmlOverlayCanvasSchema,
  HtmlOverlayDeclaredResourcesSchema,
  HtmlOverlayParametersSchema,
  HtmlOverlayTimingSchema,
  htmlOverlayFrameCount,
} from "./contracts";
import { htmlOverlayAssetLocalUrl } from "./libraries";
import { HTML_OVERLAY_RANDOM_ALGORITHM } from "./random";

const Uint32Schema = z.number().int().safe().min(0).max(0xffff_ffff);

export const HtmlOverlayBrowserRuntimeConfigSchema = z.strictObject({
  canvas: HtmlOverlayCanvasSchema,
  parameters: HtmlOverlayParametersSchema,
  resources: HtmlOverlayDeclaredResourcesSchema,
  seed: Uint32Schema,
  timing: HtmlOverlayTimingSchema,
});
export type HtmlOverlayBrowserRuntimeConfig = Readonly<
  z.infer<typeof HtmlOverlayBrowserRuntimeConfigSchema>
>;

function scriptLiteral(value: unknown): string {
  return canonicalJson(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * Produces a complete JavaScript expression. Evaluating it installs the frozen
 * page-facing `globalThis.AtetOverlay` API and returns a host controller with
 * `renderFrame(frame)`. The controller is not stored on the page global.
 */
export function createHtmlOverlayBrowserRuntimeSource(
  input: HtmlOverlayBrowserRuntimeConfig,
): string {
  const config = HtmlOverlayBrowserRuntimeConfigSchema.parse(input);
  const assets = Object.fromEntries(
    config.resources.map(resource => [resource.name, htmlOverlayAssetLocalUrl(resource)]),
  );
  const embedded = scriptLiteral({
    assets,
    durationMs: config.timing.durationUs / 1_000,
    epochMs: Date.UTC(2000, 0, 1),
    fps: config.timing.fps,
    frameCount: htmlOverlayFrameCount(config.timing),
    height: config.canvas.height,
    parameters: config.parameters,
    randomAlgorithm: HTML_OVERLAY_RANDOM_ALGORITHM,
    seed: config.seed,
    width: config.canvas.width,
  });

  return `(() => {
  "use strict";
  const config = ${embedded};
  const callbacks = [];
  const readiness = [];
  const animationFrames = new Map();
  const timers = new Map();
  const trackedAnimations = new Set();
  let currentTimeMs = 0;
  let nextScheduledId = 1;
  let pendingReadiness = 0;
  let readinessSettled = false;
  let registrationOpen = true;
  let securityViolations = 0;

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("securitypolicyviolation", () => {
      securityViolations += 1;
    });
  }

  const deepFreeze = (value) => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  };

  const replaceRuntimeValue = (
    target,
    name,
    value,
    enumerable = false,
  ) => {
    const descriptor = {
      configurable: false,
      enumerable,
      value,
      writable: false,
    };
    let prototype = Object.getPrototypeOf(target);
    while (
      prototype !== null
      && prototype !== Object.prototype
      && prototype !== Function.prototype
    ) {
      if (Object.prototype.hasOwnProperty.call(prototype, name)) {
        Object.defineProperty(prototype, name, descriptor);
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    Object.defineProperty(target, name, descriptor);
  };

  const replaceRuntimeGetter = (target, name, get) => {
    const descriptor = {
      configurable: false,
      enumerable: false,
      get,
    };
    let prototype = Object.getPrototypeOf(target);
    while (
      prototype !== null
      && prototype !== Object.prototype
      && prototype !== Function.prototype
    ) {
      if (Object.prototype.hasOwnProperty.call(prototype, name)) {
        Object.defineProperty(prototype, name, descriptor);
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    Object.defineProperty(target, name, descriptor);
  };

  const hashDomain = (value) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  };

  const nextMulberry32 = (state) => {
    const nextState = (state + 0x6d2b79f5) >>> 0;
    let value = nextState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return [nextState, ((value ^ (value >>> 14)) >>> 0) / 4294967296];
  };

  const randomSeed = (namespace) =>
    hashDomain(config.randomAlgorithm + "\\0" + (config.seed >>> 0) + "\\0" + namespace);
  let sequenceState = randomSeed("sequence");
  const random = () => {
    const result = nextMulberry32(sequenceState);
    sequenceState = result[0];
    return result[1];
  };
  const randomFor = (key) => {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      throw new TypeError("AtetOverlay.randomFor requires a nonempty string key of at most 256 characters.");
    }
    return nextMulberry32(randomSeed("key\\0" + key))[1];
  };

  const deterministicRandomValues = (array) => {
    const supported = new Set([
      "[object BigInt64Array]",
      "[object BigUint64Array]",
      "[object Int8Array]",
      "[object Int16Array]",
      "[object Int32Array]",
      "[object Uint8Array]",
      "[object Uint8ClampedArray]",
      "[object Uint16Array]",
      "[object Uint32Array]",
    ]);
    if (
      array === null
      || typeof array !== "object"
      || !ArrayBuffer.isView(array)
      || !supported.has(Object.prototype.toString.call(array))
    ) {
      throw new TypeError("crypto.getRandomValues requires an integer TypedArray.");
    }
    if (array.byteLength > 65536) {
      throw new DOMException(
        "crypto.getRandomValues is limited to 65536 bytes.",
        "QuotaExceededError",
      );
    }
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(random() * 256);
    }
    return array;
  };

  const deterministicRandomUuid = () => {
    const bytes = deterministicRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, "0"));
    return (
      hex.slice(0, 4).join("")
      + "-" + hex.slice(4, 6).join("")
      + "-" + hex.slice(6, 8).join("")
      + "-" + hex.slice(8, 10).join("")
      + "-" + hex.slice(10).join("")
    );
  };

  replaceRuntimeValue(Math, "random", random);
  if (globalThis.crypto !== undefined) {
    replaceRuntimeValue(
      globalThis.crypto,
      "getRandomValues",
      deterministicRandomValues,
    );
    if (typeof globalThis.crypto.randomUUID === "function") {
      replaceRuntimeValue(
        globalThis.crypto,
        "randomUUID",
        deterministicRandomUuid,
      );
    }
    if (globalThis.crypto.subtle !== undefined) {
      const rejectAmbientEntropy = () => Promise.reject(
        new DOMException(
          "This Web Crypto operation uses ambient entropy and is unavailable in deterministic HTML overlays.",
          "NotSupportedError",
        ),
      );
      for (const method of ["encrypt", "generateKey", "sign", "wrapKey"]) {
        replaceRuntimeValue(
          globalThis.crypto.subtle,
          method,
          rejectAmbientEntropy,
        );
      }
    }
  }

  const NativeDate = globalThis.Date;
  function AtetDate(...args) {
    if (new.target === undefined) {
      return new NativeDate(config.epochMs + currentTimeMs).toString();
    }
    return Reflect.construct(
      NativeDate,
      args.length === 0
        ? [config.epochMs + currentTimeMs]
        : args,
      new.target,
    );
  }
  AtetDate.prototype = NativeDate.prototype;
  Object.defineProperty(NativeDate.prototype, "constructor", {
    configurable: false,
    enumerable: false,
    value: AtetDate,
    writable: false,
  });
  for (const [name, value] of [
    ["parse", NativeDate.parse.bind(NativeDate)],
    ["UTC", NativeDate.UTC.bind(NativeDate)],
  ]) {
    Object.defineProperty(AtetDate, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  Object.defineProperty(AtetDate, "now", {
    configurable: false,
    enumerable: false,
    value: () => config.epochMs + currentTimeMs,
    writable: false,
  });
  replaceRuntimeValue(globalThis, "Date", AtetDate);
  if (typeof globalThis.File === "function") {
    const NativeFile = globalThis.File;
    function AtetFile(bits, name, options) {
      const normalizedOptions = (
        options === undefined
        || options === null
        || typeof options !== "object"
      )
        ? { lastModified: config.epochMs + currentTimeMs }
        : (
          Object.prototype.hasOwnProperty.call(options, "lastModified")
            ? options
            : {
              ...options,
              lastModified: config.epochMs + currentTimeMs,
            }
        );
      return Reflect.construct(
        NativeFile,
        [bits, name, normalizedOptions],
        new.target ?? AtetFile,
      );
    }
    AtetFile.prototype = Object.create(NativeFile.prototype, {
      constructor: {
        configurable: false,
        enumerable: false,
        value: AtetFile,
        writable: false,
      },
    });
    Object.defineProperty(NativeFile.prototype, "constructor", {
      configurable: false,
      enumerable: false,
      value: AtetFile,
      writable: false,
    });
    Object.defineProperty(AtetFile, "name", {
      configurable: false,
      value: "File",
    });
    replaceRuntimeValue(globalThis, "File", AtetFile);
  }
  if (globalThis.performance !== undefined) {
    replaceRuntimeValue(
      globalThis.performance,
      "now",
      () => currentTimeMs,
    );
    replaceRuntimeValue(
      globalThis.performance,
      "timeOrigin",
      config.epochMs,
      true,
    );
    const emptyPerformanceEntries = () => Object.freeze([]);
    for (const name of [
      "getEntries",
      "getEntriesByName",
      "getEntriesByType",
    ]) {
      replaceRuntimeValue(
        globalThis.performance,
        name,
        emptyPerformanceEntries,
      );
    }
    const rejectPerformanceTimelineWrite = () => {
      throw new DOMException(
        "The ambient Performance Timeline is unavailable; use the AtetOverlay frame clock.",
        "NotSupportedError",
      );
    };
    for (const name of ["mark", "measure"]) {
      replaceRuntimeValue(
        globalThis.performance,
        name,
        rejectPerformanceTimelineWrite,
      );
    }
    const clearPerformanceEntries = () => undefined;
    for (const name of [
      "clearMarks",
      "clearMeasures",
      "clearResourceTimings",
      "setResourceTimingBufferSize",
    ]) {
      replaceRuntimeValue(
        globalThis.performance,
        name,
        clearPerformanceEntries,
      );
    }
    for (const [name, value] of [
      ["eventCounts", undefined],
      ["memory", Object.freeze({
        jsHeapSizeLimit: 0,
        totalJSHeapSize: 0,
        usedJSHeapSize: 0,
      })],
      ["navigation", Object.freeze({
        redirectCount: 0,
        type: 0,
      })],
      ["timing", Object.freeze({
        loadEventEnd: config.epochMs,
        loadEventStart: config.epochMs,
        navigationStart: config.epochMs,
      })],
    ]) {
      replaceRuntimeValue(globalThis.performance, name, value);
    }
    replaceRuntimeValue(
      globalThis.performance,
      "toJSON",
      () => Object.freeze({ timeOrigin: config.epochMs }),
    );
  }
  if (typeof globalThis.Event === "function") {
    replaceRuntimeGetter(
      globalThis.Event.prototype,
      "timeStamp",
      () => currentTimeMs,
    );
  }
  if (globalThis.document?.timeline !== undefined) {
    replaceRuntimeGetter(
      globalThis.document.timeline,
      "currentTime",
      () => currentTimeMs,
    );
  }
  if (typeof globalThis.Intl?.DateTimeFormat === "function") {
    const dateTimeFormatPrototype = globalThis.Intl.DateTimeFormat.prototype;
    const nativeFormatGetter = Object.getOwnPropertyDescriptor(
      dateTimeFormatPrototype,
      "format",
    )?.get;
    if (typeof nativeFormatGetter === "function") {
      Object.defineProperty(dateTimeFormatPrototype, "format", {
        configurable: false,
        enumerable: false,
        get() {
          const nativeFormat = nativeFormatGetter.call(this);
          return (value) => nativeFormat(
            value === undefined
              ? config.epochMs + currentTimeMs
              : value,
          );
        },
      });
    }
    const nativeFormatToParts = dateTimeFormatPrototype.formatToParts;
    if (typeof nativeFormatToParts === "function") {
      Object.defineProperty(dateTimeFormatPrototype, "formatToParts", {
        configurable: false,
        enumerable: false,
        value(value) {
          return nativeFormatToParts.call(
            this,
            value === undefined
              ? config.epochMs + currentTimeMs
              : value,
          );
        },
        writable: false,
      });
    }
  }
  if (typeof globalThis.PerformanceObserver === "function") {
    replaceRuntimeValue(
      globalThis,
      "PerformanceObserver",
      function () {
        throw new DOMException(
          "PerformanceObserver is unavailable; use the AtetOverlay frame clock.",
          "NotSupportedError",
        );
      },
    );
  }
  if (typeof globalThis.URL?.createObjectURL === "function") {
    const rejectObjectUrl = () => {
      throw new DOMException(
        "Blob object URLs are unavailable; declare the overlay asset with AtetOverlay.asset().",
        "NotSupportedError",
      );
    };
    replaceRuntimeValue(
      globalThis.URL,
      "createObjectURL",
      rejectObjectUrl,
    );
    replaceRuntimeValue(
      globalThis.URL,
      "revokeObjectURL",
      rejectObjectUrl,
    );
  }

  const installGlobalFunction = (name, value) => {
    replaceRuntimeValue(globalThis, name, value, true);
  };
  const nextId = () => {
    const id = nextScheduledId;
    nextScheduledId += 1;
    if (!Number.isSafeInteger(nextScheduledId)) {
      throw new RangeError("HTML overlay scheduled callback ID space is exhausted.");
    }
    return id;
  };
  const finiteDelay = (value, minimum) => {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) return minimum;
    return Math.max(minimum, numeric);
  };
  const scheduleTimer = (callback, delay, interval, args) => {
    if (typeof callback !== "function") {
      throw new TypeError("Deterministic HTML overlay timers require function callbacks.");
    }
    const id = nextId();
    const normalizedDelay = finiteDelay(delay, interval ? 1 : 0);
    timers.set(id, {
      args,
      at: currentTimeMs + normalizedDelay,
      callback,
      intervalMs: interval ? normalizedDelay : null,
    });
    return id;
  };
  installGlobalFunction("setTimeout", (callback, delay, ...args) =>
    scheduleTimer(callback, delay, false, args));
  installGlobalFunction("setInterval", (callback, delay, ...args) =>
    scheduleTimer(callback, delay, true, args));
  const clearTimer = (id) => {
    timers.delete(Number(id));
  };
  installGlobalFunction("clearTimeout", clearTimer);
  installGlobalFunction("clearInterval", clearTimer);
  installGlobalFunction("requestAnimationFrame", (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("requestAnimationFrame requires a function callback.");
    }
    const id = nextId();
    animationFrames.set(id, callback);
    return id;
  });
  installGlobalFunction("cancelAnimationFrame", (id) => {
    animationFrames.delete(Number(id));
  });
  installGlobalFunction("requestIdleCallback", (callback, options = {}) => {
    if (typeof callback !== "function") {
      throw new TypeError("requestIdleCallback requires a function callback.");
    }
    const timeout = (
      options !== null
      && typeof options === "object"
      && "timeout" in options
    ) ? options.timeout : 0;
    return scheduleTimer(
      () => callback(Object.freeze({
        didTimeout: false,
        timeRemaining: () => 50,
      })),
      timeout,
      false,
      [],
    );
  });
  installGlobalFunction("cancelIdleCallback", clearTimer);

  const nextTimerAt = () => {
    let next = null;
    for (const timer of timers.values()) {
      if (next === null || timer.at < next) next = timer.at;
    }
    return next;
  };
  const runScheduledWork = async (targetTimeMs, includeAnimationFrame = true) => {
    let executed = 0;
    while (true) {
      let selectedId = null;
      let selected = null;
      for (const [id, timer] of timers) {
        if (
          timer.at <= targetTimeMs
          && (
            selected === null
            || timer.at < selected.at
            || (timer.at === selected.at && id < selectedId)
          )
        ) {
          selectedId = id;
          selected = timer;
        }
      }
      if (selected === null || selectedId === null) break;
      executed += 1;
      if (executed > 10000) {
        throw new RangeError("HTML overlay scheduled too many callbacks in one frame.");
      }
      currentTimeMs = selected.at;
      if (selected.intervalMs === null) {
        timers.delete(selectedId);
      } else {
        selected.at += selected.intervalMs;
      }
      await selected.callback(...selected.args);
      await Promise.resolve();
    }
    currentTimeMs = targetTimeMs;
    if (includeAnimationFrame) {
      const batch = [...animationFrames.entries()];
      for (const [id] of batch) animationFrames.delete(id);
      for (const [, callback] of batch) {
        executed += 1;
        if (executed > 10000) {
          throw new RangeError("HTML overlay scheduled too many callbacks in one frame.");
        }
        await callback(targetTimeMs);
        await Promise.resolve();
      }
    }
  };

  const settleReadiness = async () => {
    await Promise.resolve();
    let startupCallbacks = 0;
    while (pendingReadiness > 0 && startupCallbacks < 10000) {
      if (animationFrames.size > 0) {
        startupCallbacks += animationFrames.size;
        await runScheduledWork(currentTimeMs, true);
        continue;
      }
      const nextAt = nextTimerAt();
      if (nextAt === null || nextAt > 60000) break;
      startupCallbacks += 1;
      await runScheduledWork(nextAt, false);
    }
    await Promise.all(readiness);
    currentTimeMs = 0;
  };

  const denyAmbientNetwork = (name) => {
    const denied = function () {
      throw new DOMException(
        name + " is unavailable in an isolated HTML overlay.",
        "SecurityError",
      );
    };
    replaceRuntimeValue(globalThis, name, denied);
  };
  for (const name of [
    "EventSource",
    "RTCPeerConnection",
    "WebSocket",
    "WebTransport",
    "webkitRTCPeerConnection",
  ]) {
    denyAmbientNetwork(name);
  }
  if (globalThis.Temporal?.Now !== undefined) {
    const rejectTemporalNow = () => {
      throw new DOMException(
        "Temporal.Now is unavailable; use the AtetOverlay frame clock.",
        "NotSupportedError",
      );
    };
    for (const name of Object.getOwnPropertyNames(globalThis.Temporal.Now)) {
      if (name === "prototype") continue;
      if (typeof globalThis.Temporal.Now[name] !== "function") continue;
      Object.defineProperty(globalThis.Temporal.Now, name, {
        configurable: false,
        enumerable: false,
        value: rejectTemporalNow,
        writable: false,
      });
    }
  }

  const requireRegistration = (name) => {
    if (!registrationOpen) {
      throw new Error("AtetOverlay." + name + " must be called before the first rendered frame.");
    }
  };

  const pauseAnimation = (animation) => {
    if (typeof animation.pause === "function") animation.pause();
  };

  const seekDocumentAnimation = (animation, timeMs) => {
    pauseAnimation(animation);
    animation.currentTime = timeMs;
  };

  const seekTrackedAnimation = (animation, timeMs) => {
    pauseAnimation(animation);
    if ("time" in animation) {
      animation.time = timeMs / 1000;
      return;
    }
    if ("currentTime" in animation) {
      animation.currentTime = timeMs;
      return;
    }
    throw new TypeError("A tracked animation must expose Motion time or WAAPI currentTime.");
  };

  const publicApi = Object.freeze({
    asset(name) {
      if (typeof name !== "string" || !Object.hasOwn(config.assets, name)) {
        throw new RangeError("HTML overlay asset is not declared: " + String(name));
      }
      return config.assets[name];
    },
    durationMs: config.durationMs,
    fps: config.fps,
    height: config.height,
    onFrame(callback) {
      requireRegistration("onFrame");
      if (typeof callback !== "function") {
        throw new TypeError("AtetOverlay.onFrame requires a callback.");
      }
      callbacks.push(callback);
      return () => {
        if (!registrationOpen) {
          throw new Error("Frame callbacks cannot be removed after rendering begins.");
        }
        const index = callbacks.indexOf(callback);
        if (index >= 0) callbacks.splice(index, 1);
      };
    },
    parameters: deepFreeze(config.parameters),
    random,
    randomFor,
    ready(promise) {
      requireRegistration("ready");
      if (
        (typeof promise !== "object" && typeof promise !== "function")
        || promise === null
        || typeof promise.then !== "function"
      ) {
        throw new TypeError("AtetOverlay.ready requires a promise or thenable.");
      }
      pendingReadiness += 1;
      const pending = Promise.resolve(promise).finally(() => {
        pendingReadiness -= 1;
      });
      void pending.catch(() => undefined);
      readiness.push(pending);
      return pending;
    },
    seed: config.seed,
    trackAnimation(animation) {
      requireRegistration("trackAnimation");
      if ((typeof animation !== "object" && typeof animation !== "function") || animation === null) {
        throw new TypeError("AtetOverlay.trackAnimation requires animation controls.");
      }
      if (!("time" in animation) && !("currentTime" in animation)) {
        throw new TypeError("A tracked animation must expose Motion time or WAAPI currentTime.");
      }
      pauseAnimation(animation);
      trackedAnimations.add(animation);
      return animation;
    },
    width: config.width,
  });

  if (
    Object.hasOwn(globalThis, "AtetOverlay")
    || Object.hasOwn(globalThis, "TransmuteOverlay")
  ) {
    throw new Error("The HTML overlay authoring API is already installed.");
  }
  Object.defineProperty(globalThis, "AtetOverlay", {
    configurable: false,
    enumerable: true,
    value: publicApi,
    writable: false,
  });
  Object.defineProperty(globalThis, "TransmuteOverlay", {
    configurable: false,
    enumerable: false,
    value: publicApi,
    writable: false,
  });
  const validateFrame = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("The HTML overlay frame must be an object.");
    }
    const keys = Object.keys(value).sort();
    const expectedKeys = ["deltaMs", "frame", "height", "progress", "timeMs", "width"];
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new TypeError("The HTML overlay frame has unknown or missing fields.");
    }
    if (!Number.isSafeInteger(value.frame) || value.frame < 0 || value.frame >= config.frameCount) {
      throw new RangeError("The HTML overlay frame index is outside the render range.");
    }
    const timeMs = value.frame * 1000 / config.fps;
    const expected = {
      deltaMs: value.frame === 0 ? 0 : 1000 / config.fps,
      frame: value.frame,
      height: config.height,
      progress: Math.min(1, timeMs / config.durationMs),
      timeMs,
      width: config.width,
    };
    for (const key of expectedKeys) {
      if (!Object.is(value[key], expected[key])) {
        throw new RangeError("HTML overlay frame field " + key + " does not match the absolute render clock.");
      }
    }
    return Object.freeze(expected);
  };

  return Object.freeze({
    async renderFrame(value) {
      const frame = validateFrame(value);
      registrationOpen = false;
      if (!readinessSettled) {
        await settleReadiness();
        readinessSettled = true;
      }
      currentTimeMs = frame.timeMs;
      await runScheduledWork(frame.timeMs);
      const animations = document.getAnimations();
      for (const animation of animations) seekDocumentAnimation(animation, frame.timeMs);
      for (const animation of trackedAnimations) {
        if (!animations.includes(animation)) seekTrackedAnimation(animation, frame.timeMs);
      }
      for (const callback of [...callbacks]) await callback(frame);
    },
    securityViolationCount() {
      return securityViolations;
    },
  });
})()`;
}
