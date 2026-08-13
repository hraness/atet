import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializeFilterScript } from "./filter-script";

test("materializes and reuses a content-addressed private filter graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "transmute-filter-script-"));
  try {
    const first = await materializeFilterScript({
      graph: "color=black[out]",
      relativeDirectory: "derived/filter-graphs",
      root,
    });
    const second = await materializeFilterScript({
      graph: "color=black[out]",
      relativeDirectory: "derived/filter-graphs",
      root,
    });
    expect(second).toEqual(first);
    expect(await readFile(first.path, "utf8")).toBe("color=black[out]\n");
    expect(first.repositoryPath).toBe(`derived/filter-graphs/${first.sha256}.ffgraph`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
