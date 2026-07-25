import { describe, expect, test } from "bun:test"
import {
  assertSafeCanonicalSvg,
  buildAlphaMaskedSvg,
  canonicalizeVTracerSvg,
} from "./svg.ts"

describe("canonical vector SVG", () => {
  test("rebuilds VTracer paths into a deterministic aspect-preserving document", () => {
    const canonical = canonicalizeVTracerSvg(
      '<svg><path fill="#F00" d="M0 0h2v1H0z"/></svg>',
      2,
      1,
      10,
    )
    expect(canonical.svg).toContain('viewBox="0 0 2 1" width="2" height="1"')
    expect(canonical.svg).toContain('fill="#ff0000"')
    expect(canonical.svg).not.toContain("<title")
    expect(() => assertSafeCanonicalSvg(canonical.svg)).not.toThrow()
  })

  test("rejects active, external, or unsupported tracer output", () => {
    expect(() =>
      canonicalizeVTracerSvg(
        '<svg><script>alert(1)</script><path fill="#fff" d="M0 0z"/></svg>',
        1,
        1,
        10,
      ),
    ).toThrow(/active or referenced/)
    expect(() =>
      canonicalizeVTracerSvg(
        '<svg><path fill="url(https://example.com/x)" d="M0 0z"/></svg>',
        1,
        1,
        10,
      ),
    ).toThrow()
  })

  test("allows only a content-addressed internal alpha mask reference", () => {
    const artwork = canonicalizeVTracerSvg(
      '<svg><path fill="#123456" d="M0 0h2v2H0z"/></svg>',
      2,
      2,
      10,
    )
    const mask = canonicalizeVTracerSvg(
      '<svg><path fill="#808080" d="M0 0h2v2H0z"/></svg>',
      2,
      2,
      10,
    )
    const svg = buildAlphaMaskedSvg(artwork.paths, mask.paths, 2, 2)
    expect(svg).toContain('mask="url(#alpha-')
    expect(svg).not.toMatch(/href=|<image|<script/)
    expect(() => assertSafeCanonicalSvg(svg)).not.toThrow()
  })
})
