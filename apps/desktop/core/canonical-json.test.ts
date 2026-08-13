import { expect, test } from "bun:test";

import { canonicalJson, sha256Hex } from "./canonical-json";

test("canonical JSON orders keys recursively", () => {
  expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
});

test("portable SHA-256 matches the standard vector", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
