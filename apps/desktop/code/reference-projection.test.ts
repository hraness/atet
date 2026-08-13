import { describe, expect, test } from "bun:test";

import {
  WORKFLOW_REF_VERSION,
  type SerializedRefV1,
} from "./contracts";
import { projectReferenceValue } from "./reference-projection";

function reference(path: SerializedRefV1["$ref"]["path"]): SerializedRefV1 {
  return {
    $ref: {
      nodeKey: "source",
      ...(path === undefined ? {} : { path }),
      schemaId: "test.output/v1",
    },
    version: WORKFLOW_REF_VERSION,
  };
}

describe("workflow reference projection", () => {
  test("projects nested object and array paths", () => {
    expect(projectReferenceValue(
      reference(["items", 0, "label"]),
      { items: [{ label: "ok" }] },
    )).toBe("ok");
  });

  test("rejects invalid authored output projections", () => {
    expect(() => projectReferenceValue(
      reference(["items", 1, "label"]),
      { items: [{ label: "ok" }] },
    )).toThrow("invalid array projection");
  });
});
