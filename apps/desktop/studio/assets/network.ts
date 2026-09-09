import { ASSET_LIMITS, POLY_HAVEN, downloadUrl } from "./contracts";

export type AssetFetch = (input: string, init: RequestInit) => Promise<Response>;
function aborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("Poly Haven asset operation was cancelled or timed out."); }
async function withCancellation<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Poly Haven response was cancelled or timed out."));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { if (onAbort !== undefined) signal.removeEventListener("abort", onAbort); }
}
export function createPolyHavenNetwork(options: { readonly fetch?: AssetFetch; readonly signal?: AbortSignal }) {
  const request = options.fetch ?? globalThis.fetch;
  const cancellation = options.signal;
  async function read(url: string, maximumBytes: number, expectedBytes?: number): Promise<Buffer> {
    const signal = AbortSignal.any([AbortSignal.timeout(ASSET_LIMITS.requestMs), ...(cancellation === undefined ? [] : [cancellation])]);
    aborted(signal);
    const response = await withCancellation(request(url, { method: "GET", redirect: "error", credentials: "omit", signal, headers: { "user-agent": POLY_HAVEN.userAgent, accept: "application/json, application/octet-stream;q=0.9" } }), signal);
    if (signal.aborted) { void response.body?.cancel().catch(() => undefined); aborted(signal); }
    if (response.status !== 200 || response.redirected || response.url !== "" && response.url !== url || response.body === null) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Poly Haven returned an unsupported response (HTTP ${response.status}).`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) {
      void response.body.cancel().catch(() => undefined);
      throw new Error("Poly Haven response exceeds its byte bound.");
    }
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        aborted(signal);
        const next = await withCancellation(reader.read(), signal);
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maximumBytes) throw new Error("Poly Haven response exceeds its byte bound.");
        chunks.push(Buffer.from(next.value));
      }
      aborted(signal);
      if (expectedBytes !== undefined && length !== expectedBytes) throw new Error("Poly Haven file length differs from its selected catalog entry.");
      return Buffer.concat(chunks, length);
    } catch (error) {
      // Cancellation of an injected or broken stream must not postpone failure.
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
  }
  return {
    async json(path: string, query?: URLSearchParams): Promise<unknown> {
      if (!/^\/(?:search|info\/[a-z0-9][a-z0-9_-]{0,127}|files\/[a-z0-9][a-z0-9_-]{0,127})$/u.test(path)) throw new Error("Unsupported Poly Haven API endpoint.");
      const url = `${POLY_HAVEN.api}${path}${query === undefined ? "" : `?${query.toString()}`}`;
      const bytes = await read(url, ASSET_LIMITS.jsonBytes);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    },
    async file(url: string, bytes: number): Promise<Buffer> {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ASSET_LIMITS.fileBytes) throw new Error("Asset file exceeds its byte bound.");
      return read(downloadUrl(url), bytes, bytes);
    },
  };
}
