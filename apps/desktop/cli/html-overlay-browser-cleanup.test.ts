import { expect, test } from "bun:test";
import { boundedBrowserStep, HtmlOverlayBrowserCleanupError, requiredBrowserCleanup } from "./html-overlay-renderer";

test("required browser cleanup cannot silently turn rejection or timeout into completion", async () => {
  let closed = false;
  await requiredBrowserCleanup("fixture close", async () => { closed = true; }, 20);
  expect(closed).toBe(true);
  const failure = new Error("fixture native close failed");
  const rejected = await requiredBrowserCleanup("fixture close", () => Promise.reject(failure), 20).catch(error => error);
  expect(rejected).toBeInstanceOf(HtmlOverlayBrowserCleanupError);
  expect(rejected.cause).toBe(failure);
  const timedOut = await requiredBrowserCleanup("fixture close", () => new Promise(() => {}), 5).catch(error => error);
  expect(timedOut).toBeInstanceOf(HtmlOverlayBrowserCleanupError);
  expect(timedOut.message).toContain("process exit is unproven");
});

test("unsettled late launch retains cancellation as a cause and reports cleanup uncertainty", async () => {
  const controller = new AbortController(), cancellation = new Error("cancelled launch");
  let closed = false;
  const error = await boundedBrowserStep(() => {
    controller.abort(cancellation);
    return new Promise<unknown>(() => {});
  }, controller.signal, 5, "fixture launch", () => { closed = true; }).catch(error => error);
  expect(error).toBeInstanceOf(HtmlOverlayBrowserCleanupError);
  if (!(error instanceof HtmlOverlayBrowserCleanupError)) throw new Error("Expected browser cleanup failure");
  expect(error.cause).toBeInstanceOf(AggregateError);
  if (!(error.cause instanceof AggregateError)) throw new Error("Expected aggregated cancellation cause");
  expect(error.cause.errors[0]).toBe(cancellation);
  expect(closed).toBe(false);
});

test("late launch close failure preserves both the cancellation and cleanup cause", async () => {
  const controller = new AbortController(), cancellation = new Error("cancelled launch"), cleanup = new Error("late browser close failed");
  const error = await boundedBrowserStep(() => {
    controller.abort(cancellation);
    return Promise.resolve("late browser");
  }, controller.signal, 20, "fixture launch", () => Promise.reject(cleanup)).catch(error => error);
  expect(error).toBeInstanceOf(HtmlOverlayBrowserCleanupError);
  expect(error.cause.errors).toEqual([cancellation, cleanup]);
});
