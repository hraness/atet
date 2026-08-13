import { expect, test } from "bun:test";

import { gatewayMediaBytesMatchType } from "./gateway-media-signature";

test("matches bounded media signatures and rejects extension-only disguises", () => {
  expect(gatewayMediaBytesMatchType(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    "image/png",
  )).toBe(true);
  expect(gatewayMediaBytesMatchType(
    new TextEncoder().encode("RIFFxxxxWAVE"),
    "audio/wav",
  )).toBe(true);
  expect(gatewayMediaBytesMatchType(
    new TextEncoder().encode("not actually a png"),
    "image/png",
  )).toBe(false);
  expect(gatewayMediaBytesMatchType(
    new TextEncoder().encode(
      '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    ),
    "image/svg+xml",
  )).toBe(false);
});
