import { describe, expect, test } from "bun:test";

import {
  AutomaticZoomSchema,
  ProjectPlacementV1Schema,
} from "../contracts";
import { mapAutomaticZoomsToProject } from "./project-auto-zoom";

function placement(provenance: "identity" | "unverified" = "identity") {
  return ProjectPlacementV1Schema.parse({
    assetId: "asset_autozoom01",
    assetRange: { endUs: 10_000_000, startUs: 0 },
    audio: [],
    enabled: true,
    placementId: "placement_autozoom01",
    sync: {
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 5_000_000 },
        { assetTimeUs: 10_000_000, projectTimeUs: 25_000_000 },
      ],
      provenance: provenance === "identity"
        ? { kind: "identity" }
        : { kind: "unverified", reason: "initial-placement" },
    },
    video: [],
  });
}

const zoom = AutomaticZoomSchema.parse({
  confidence: 0.9,
  displayId: "display-primary",
  easing: { kind: "ease-in-out" },
  enterDurationUs: 300_000,
  exitDurationUs: 300_000,
  kind: "automatic",
  range: { endUs: 3_000_000, startUs: 1_000_000 },
  reason: "typing",
  scale: 2,
  target: {
    kind: "point",
    point: { x: 640, y: 360 },
  },
  zoomId: "zoom_source001",
});

describe("project automatic zoom mapping", () => {
  test("maps recording time through accepted sync and binds the placement", () => {
    const result = mapAutomaticZoomsToProject(placement(), [zoom]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      operation: {
        range: { endUs: 11_000_000, startUs: 7_000_000 },
        reason: "typing",
      },
      placementId: "placement_autozoom01",
    });
    expect(JSON.stringify(result[0])).toMatch(
      /"zoomId":"zoom_auto[a-f0-9]{12}_0001"/u,
    );
    expect(mapAutomaticZoomsToProject(placement(), [zoom])).toEqual(result);
  });

  test("rejects unverified placement synchronization", () => {
    expect(() => {
      mapAutomaticZoomsToProject(placement("unverified"), [zoom]);
    }).toThrow(/unverified synchronization/u);
  });
});
