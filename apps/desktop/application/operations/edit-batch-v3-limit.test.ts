import { describe, expect, test } from "bun:test";

import {
  deriveProjectEditBatchV3,
  OrderedProjectEditV3Schema,
} from "./derive/edit-batch";

function zoomIds(count: number, offset: number): readonly string[] {
  return Array.from(
    { length: count },
    (_, index) => `zoom_limit${String(offset + index).padStart(8, "0")}`,
  );
}

describe("project edit batch v3 limits", () => {
  test("rejects a direct derivation whose ordered edits expand beyond 10,000", () => {
    const ordered = [
      OrderedProjectEditV3Schema.parse({
        kind: "remove-zooms",
        zoomIds: zoomIds(5_000, 0),
      }),
      OrderedProjectEditV3Schema.parse({
        kind: "remove-zooms",
        zoomIds: zoomIds(5_001, 5_000),
      }),
    ];

    expect(() => deriveProjectEditBatchV3(ordered)).toThrow(
      /cannot expand beyond 10,000 ordered edits/u,
    );
  });
});
