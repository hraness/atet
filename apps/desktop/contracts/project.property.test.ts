import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  ProjectMediaSegmentSchema,
  ProjectPlacementV1Schema,
  ProjectSyncMapSchema,
} from "./project";

const HASH = "0".repeat(64);

assertProperty(fc.property(
  fc.integer({ min: 0, max: 10_000_000 }),
  fc.integer({ min: 0, max: 10_000_000 }),
  fc.integer({ min: 1, max: 10_000_000 }),
  (assetStartUs, fileStartUs, durationUs) => {
    const segment = {
      assetRange: { endUs: assetStartUs + durationUs, startUs: assetStartUs },
      bytes: 1,
      codec: "pcm_s16le",
      container: "wav",
      fileRange: { endUs: fileStartUs + durationUs, startUs: fileStartUs },
      path: "imports/audio.wav",
      sha256: HASH,
      streamIndex: 0,
    };
    expect(ProjectMediaSegmentSchema.safeParse(segment).success).toBe(true);
    expect(ProjectMediaSegmentSchema.safeParse({
      ...segment,
      fileRange: { ...segment.fileRange, endUs: segment.fileRange.endUs + 1 },
    }).success).toBe(false);
  },
));

assertProperty(fc.property(
  fc.integer({ min: 1, max: 10_000_000 }),
  fc.integer({ min: 1, max: 10_000_000 }),
  fc.integer({ min: 1, max: 10_000_000 }),
  fc.integer({ min: 1, max: 10_000_000 }),
  (firstAssetUs, secondAssetUs, firstProjectUs, secondProjectUs) => {
    const anchors = [
      { assetTimeUs: 0, projectTimeUs: 0 },
      { assetTimeUs: firstAssetUs, projectTimeUs: firstProjectUs },
      {
        assetTimeUs: firstAssetUs + secondAssetUs,
        projectTimeUs: firstProjectUs + secondProjectUs,
      },
    ];
    expect(ProjectSyncMapSchema.safeParse({ anchors, provenance: { kind: "manual" } }).success).toBe(true);
    expect(ProjectSyncMapSchema.safeParse({
      anchors: [anchors[0], anchors[2], anchors[1]],
      provenance: { kind: "manual" },
    }).success).toBe(false);
  },
));

assertProperty(fc.property(
  fc.integer({ min: 1, max: 20_000_000 }),
  fc.integer({ min: 0, max: 20_000_000 }),
  fc.integer({ min: 0, max: 20_000_000 }),
  (durationUs, assetStartSeed, projectStartSeed) => {
    const assetStartUs = assetStartSeed % 1_000_000;
    const projectStartUs = projectStartSeed % 1_000_000;
    const placement = {
      assetId: "asset_property001",
      assetRange: { endUs: assetStartUs + durationUs, startUs: assetStartUs },
      audio: [],
      enabled: true,
      placementId: "placement_property001",
      sync: {
        anchors: [
          { assetTimeUs: assetStartUs, projectTimeUs: projectStartUs },
          { assetTimeUs: assetStartUs + durationUs, projectTimeUs: projectStartUs + durationUs },
        ],
        provenance: { kind: "identity" },
      },
      video: [],
    };
    expect(ProjectPlacementV1Schema.safeParse(placement).success).toBe(true);
    expect(ProjectPlacementV1Schema.safeParse({
      ...placement,
      sync: {
        ...placement.sync,
        anchors: [
          { assetTimeUs: assetStartUs + 1, projectTimeUs: projectStartUs },
          placement.sync.anchors[1],
        ],
      },
    }).success).toBe(false);
  },
));
