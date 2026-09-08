import { expect, test } from "bun:test"
import { inspectPreviewCssResources } from "./preview-css"

test("parsed preview CSS inventory includes image-set strings, escaped URLs and font sources", () => {
  expect(inspectPreviewCssResources('@font-face{font-family:font;src:url(./font.woff2)}', "fixture.css"))
    .toEqual(["./font.woff2"])
  expect(inspectPreviewCssResources('.probe{background-image:image-set("https://example.test/a.png" 1x)}', "fixture.css"))
    .toEqual(["https://example.test/a.png"])
  expect(inspectPreviewCssResources(String.raw`.probe{background-image:u\72l(https://example.test/a.png)}`, "fixture.css"))
    .toEqual(["https://example.test/a.png"])
  expect(inspectPreviewCssResources('.probe{content:"url(https://example.test/not-a-request)"}', "fixture.css"))
    .toEqual([])
})

test("parsed preview CSS rejects imports, malformed CSS and unbounded resource references", () => {
  expect(() => inspectPreviewCssResources('@import "https://example.test/style.css";', "fixture.css")).toThrow()
  expect(() => inspectPreviewCssResources('.probe { color: rgb( ; }', "fixture.css")).toThrow()
  expect(() => inspectPreviewCssResources(Array.from({ length: 65 }, (_, index) =>
    `.probe${index}{background:url(./font-${index}.woff2)}`).join(""), "fixture.css")).toThrow()
})
