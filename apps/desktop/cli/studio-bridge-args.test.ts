import { expect, test } from "bun:test";
import { parseCliArgs } from "./args";

test("retained native and encoded outputs have explicit, inert asset selection", () => {
  expect(parseCliArgs(["studio", "asset", "studio_city", "--output-id", "city", "--asset-id", "asset_city", "--representation", "native", "--json"]))
    .toEqual({ kind: "studio", action: "asset", id: "studio_city", outputId: "city", assetId: "asset_city", representation: "native", json: true });
  for (const extra of [["--frame", "NaN"], ["--frame", "-1"], ["--allow-trusted-code"]]) {
    expect(() => parseCliArgs(["studio", "asset", "studio_city", "--output-id", "city", "--asset-id", "asset_city", "--representation", "encoded-video", ...extra])).toThrow();
  }
  expect(() => parseCliArgs(["studio", "asset", "studio_city", "--output-id", "city"])).toThrow();
});

test("camera-track requires a retained sampling request and a fresh output destination", () => {
  expect(parseCliArgs(["scene", "camera-track", "scene.json", "--request", "clock.json", "--output", "track.json"]))
    .toEqual({ kind: "spatial-scene", action: "camera-track", path: "scene.json", request: "clock.json", output: "track.json", json: false });
  expect(() => parseCliArgs(["scene", "camera-track", "scene.json", "--output", "track.json"])).toThrow();
});
