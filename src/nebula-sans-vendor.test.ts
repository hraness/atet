import { expect, test } from "bun:test"

const expectedHashes = {
  "NebulaSans-Bold.otf": "91617d3e2281e8213f64f6bf359f387022d3149b35000b38365c32130a25bfa8",
  "NebulaSans-Bold.woff2": "0801b78a64e731db50c2a0badac7bc1e9138a8916e8f4774aeb8de6f86c6f1fd",
  "NebulaSans-Book.otf": "4cc650f856591af1affc4add4f50e260c8239a2542bafe77909b78006023f091",
  "NebulaSans-Book.woff2": "4d396c7c7f93b3f9d8e90d5a8c5e28b29266243946d4320783abc3628d9ef8df",
} as const

test("bundled Nebula Sans assets remain byte-identical to the canonical release", async () => {
  for (const [name, expectedHash] of Object.entries(expectedHashes)) {
    const bytes = new Uint8Array(await Bun.file(
      new URL(`./assets/fonts/nebula-sans/${name}`, import.meta.url),
    ).arrayBuffer())
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(expectedHash)
  }
})

test("bundled Nebula Sans retains its license and release provenance", async () => {
  const directory = new URL("./assets/fonts/nebula-sans/", import.meta.url)
  const [license, provenance] = await Promise.all([
    Bun.file(new URL("LICENSE.txt", directory)).text(),
    Bun.file(new URL("PROVENANCE.md", directory)).text(),
  ])

  expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1")
  expect(license).toContain("Reserved Font Name 'Nebula'")
  expect(provenance).toContain("@hraness/design-kit` v0.2.1")
  expect(provenance).toContain("a9b56ef15e24b6e8195af7457cc75f714ecf5501fc3c20a69f546c8f589e7bdb")
})
