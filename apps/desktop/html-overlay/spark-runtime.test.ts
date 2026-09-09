import { runInNewContext } from "node:vm";
import { expect, test } from "bun:test";
import { createHtmlOverlayBrowserRuntimeSource } from "./runtime";
import { createSparkHtmlOverlayRuntimeSource } from "./spark-runtime";

const config = { canvas: { deviceScaleFactor: 1, width: 8, height: 4 }, parameters: {}, resources: [], seed: 1, timing: { durationUs: 1_000_000, fps: 1 } };
function fixture() {
  const revoked: string[] = [], created: { terminated: boolean }[] = [];
  const listeners: { name: string; callback: () => void; target: unknown }[] = [];
  let sequence = 0;
  class FakeUrl {
    static createObjectURL(_blob: Blob) { return `blob:fixture-${++sequence}`; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  class FakeWorker {
    terminated = false;
    constructor(_url: string, _options?: unknown) { created.push(this); }
    terminate() { this.terminated = true; }
  }
  class FakeTarget { addEventListener(name: string, callback: () => void) { listeners.push({ name, callback, target: this }); } }
  const context = { URL: FakeUrl, Worker: FakeWorker, EventTarget: FakeTarget, Blob, DOMException, document: { getAnimations: () => [] } };
  const legacy = createHtmlOverlayBrowserRuntimeSource(config);
  const transformed = createSparkHtmlOverlayRuntimeSource(legacy);
  const host = runInNewContext(transformed, context) as { securityViolationCount(): number };
  return { context, host, listeners, revoked, created, legacy, transformed };
}
const script = () => new Blob(["self.onmessage=()=>{}"], { type: "text/javascript;charset=utf-8" });

test("Spark extension is exact and legacy generation remains byte-identical", () => {
  const f = fixture();
  expect(createHtmlOverlayBrowserRuntimeSource(config)).toBe(f.legacy);
  expect(f.transformed).not.toBe(f.legacy);
  expect(() => createSparkHtmlOverlayRuntimeSource(f.transformed)).toThrow("exact historical runtime seam");
  expect(() => createSparkHtmlOverlayRuntimeSource(f.legacy + f.legacy)).toThrow("exact historical runtime seam");
  expect(f.transformed).toContain("let sparkWorkerFailure = null");
});

test("Spark permits bounded owned classic workers, immediate revoke and disposal", () => {
  const f = fixture();
  const urls = Array.from({ length: 4 }, () => f.context.URL.createObjectURL(script()));
  const workers = urls.map(url => new f.context.Worker(url, { name: "spark" }));
  urls.forEach(url => f.context.URL.revokeObjectURL(url));
  const next = f.context.URL.createObjectURL(script());
  expect(() => new f.context.Worker(next)).toThrow("bounded owned Blob workers");
  workers[0]!.terminate();
  new f.context.Worker(next);
  expect(() => new f.context.Worker("data:application/javascript,void(0)")).toThrow();
  expect(() => new f.context.Worker(next, { type: "module" })).toThrow();
  for (const listener of f.listeners.filter(listener => listener.name === "pagehide")) listener.callback();
  expect(f.created.every(worker => worker.terminated)).toBe(true);
  expect(f.revoked).toContain(next);
});

test("worker errors fail capture checks and non-script blobs remain unavailable", () => {
  const f = fixture();
  expect(() => f.context.URL.createObjectURL(new Blob(["image"], { type: "image/png" }))).toThrow();
  const url = f.context.URL.createObjectURL(script()); new f.context.Worker(url);
  expect(f.host.securityViolationCount()).toBe(0);
  f.listeners.find(listener => listener.name === "messageerror")!.callback();
  expect(f.host.securityViolationCount()).toBe(1);
});
