/** Exact, profile-scoped extension. Never change the historical runtime source. */
const legacyObjectUrls = `  if (typeof globalThis.URL?.createObjectURL === "function") {
    const rejectObjectUrl = () => {
      throw new DOMException(
        "Blob object URLs are unavailable; declare the overlay asset with SlopcameraOverlay.asset().",
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
  }`;

const boundedSparkWorkers = `  let sparkWorkerFailure = null;
  {
    const NativeWorker = globalThis.Worker;
    const nativeCreateUrl = globalThis.URL.createObjectURL.bind(globalThis.URL);
    const nativeRevokeUrl = globalThis.URL.revokeObjectURL.bind(globalThis.URL);
    const nativeTerminate = NativeWorker.prototype.terminate;
    const nativeAddListener = EventTarget.prototype.addEventListener;
    const apply = Reflect.apply;
    const nativeBlobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size").get;
    const nativeBlobType = Object.getOwnPropertyDescriptor(Blob.prototype, "type").get;
    const urls = new Map();
    const workers = new Set();
    let liveBytes = 0, createdUrls = 0, createdWorkers = 0;
    const revoke = (url) => {
      if (typeof url !== "string") throw new TypeError("Spark worker URL must be a string.");
      const bytes = urls.get(url);
      if (bytes !== undefined) { liveBytes -= bytes; urls.delete(url); nativeRevokeUrl(url); }
    };
    replaceRuntimeValue(globalThis.URL, "createObjectURL", (blob) => {
      const size = apply(nativeBlobSize, blob, []), type = apply(nativeBlobType, blob, []);
      if (!["application/javascript", "text/javascript", "text/javascript;charset=utf-8"].includes(type)
        || size < 1 || size > 8388608 || urls.size >= 8 || createdUrls >= 128
        || liveBytes + size > 33554432) throw new RangeError("Spark worker Blob exceeds the closed script or lifecycle budget.");
      const url = nativeCreateUrl(blob);
      urls.set(url, size); liveBytes += size; createdUrls++;
      return url;
    });
    replaceRuntimeValue(globalThis.URL, "revokeObjectURL", revoke);
    function SlopcameraSparkWorker(url, options) {
      if (!new.target) throw new TypeError("Spark Worker requires construction.");
      const name = options?.name, type = options?.type;
      if (typeof url !== "string" || !urls.has(url) || workers.size >= 4 || createdWorkers >= 64
        || (options !== undefined && (options === null || typeof options !== "object"
          || Object.keys(options).some(key => key !== "name" && key !== "type")
          || (type !== undefined && type !== "classic")
          || (name !== undefined && (typeof name !== "string" || name.length > 128))))) {
        throw new RangeError("Spark requires bounded owned Blob workers with classic scripts.");
      }
      const worker = new NativeWorker(url, { type: "classic", ...(name === undefined ? {} : { name }) });
      workers.add(worker); createdWorkers++;
      const terminate = () => { workers.delete(worker); apply(nativeTerminate, worker, []); };
      Object.defineProperty(worker, "terminate", { configurable: false, writable: false, value: terminate });
      apply(nativeAddListener, worker, ["error", () => { sparkWorkerFailure = new Error("Spark worker failed."); }]);
      apply(nativeAddListener, worker, ["messageerror", () => { sparkWorkerFailure = new Error("Spark worker message failed."); }]);
      return worker;
    }
    Object.defineProperty(SlopcameraSparkWorker, "prototype", { value: NativeWorker.prototype, writable: false });
    Object.defineProperty(NativeWorker.prototype, "constructor", { configurable: false, writable: false, value: SlopcameraSparkWorker });
    replaceRuntimeValue(globalThis, "Worker", SlopcameraSparkWorker);
    replaceRuntimeValue(globalThis, "SharedWorker", function () { throw new Error("Shared workers are unavailable in a spatial render."); });
    apply(nativeAddListener, globalThis, ["pagehide", () => {
      for (const worker of workers) apply(nativeTerminate, worker, []);
      workers.clear();
      for (const url of urls.keys()) nativeRevokeUrl(url);
      urls.clear(); liveBytes = 0;
    }, { once: true }]);
  }`;

function replaceExactlyOnce(source: string, target: string, replacement: string): string {
  const offset = source.indexOf(target);
  if (offset < 0 || source.indexOf(target, offset + target.length) !== -1) throw new Error("Spark runtime extension requires one exact historical runtime seam.");
  return source.slice(0, offset) + replacement + source.slice(offset + target.length);
}

export function createSparkHtmlOverlayRuntimeSource(legacySource: string): string {
  const source = replaceExactlyOnce(legacySource, legacyObjectUrls, boundedSparkWorkers);
  return replaceExactlyOnce(source, "return securityViolations;", "return securityViolations + (sparkWorkerFailure === null ? 0 : 1);");
}
