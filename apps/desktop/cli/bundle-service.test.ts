import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingManifestV1Schema } from "../contracts";
import { createNodeBundleFileSystem, saveRecordingManifest } from "../core";
import { testManifest } from "../core/test-support";
import { loadRecordingEvents, openRecording } from "./bundle-service";

function event(sequence: number, sourceTimeUs: number): string {
  return JSON.stringify({
    displayId: "display-primary",
    nativeTimeUs: sourceTimeUs + 1_000_000,
    position: { x: sequence, y: sequence },
    sequence,
    sourceTimeUs,
    type: "cursor.sample",
    visible: true,
  });
}

test("streams, validates, filters, and explicitly limits event JSONL", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-events-test-"));
  const recordingRoot = join(temporary, "rec_example001");
  const laterPath = "events/cursor-later.jsonl";
  const earlierPath = "events/cursor-earlier.jsonl";
  const laterContents = `${event(2, 2_000_000)}\n${event(3, 3_000_000)}\n`;
  const earlierContents = `${event(1, 1_000_000)}\n`;
  try {
    await mkdir(join(recordingRoot, "events"), { recursive: true });
    await writeFile(join(recordingRoot, laterPath), laterContents);
    await writeFile(join(recordingRoot, earlierPath), earlierContents);
    const base = testManifest();
    const manifest = RecordingManifestV1Schema.parse({
      ...base,
      eventStreams: [
        {
          endUs: 4_000_000,
          eventKinds: ["cursor.sample"],
          eventStreamId: "events_later001",
          integrity: {
            bytes: Buffer.byteLength(laterContents),
            sha256: createHash("sha256").update(laterContents).digest("hex"),
            state: "verified",
          },
          path: laterPath,
          recordCount: 2,
          startUs: 0,
        },
        {
          endUs: 4_000_000,
          eventKinds: ["cursor.sample"],
          eventStreamId: "events_earlier01",
          integrity: {
            bytes: Buffer.byteLength(earlierContents),
            sha256: createHash("sha256").update(earlierContents).digest("hex"),
            state: "verified",
          },
          path: earlierPath,
          recordCount: 1,
          startUs: 0,
        },
      ],
    });
    await saveRecordingManifest(createNodeBundleFileSystem(recordingRoot), manifest);
    const recording = await openRecording(temporary, manifest.recordingId);

    expect(await loadRecordingEvents(recording)).toHaveLength(3);
    expect((await loadRecordingEvents(recording, { limit: 2 })).map(item => item.sourceTimeUs))
      .toEqual([1_000_000, 2_000_000]);
    expect(await loadRecordingEvents(recording, { startUs: 2_000_000, types: ["cursor.sample"] }))
      .toHaveLength(2);

    await writeFile(join(recordingRoot, laterPath), laterContents.replace("\"x\":2", "\"x\":20"));
    let failure: unknown;
    try {
      await loadRecordingEvents(recording);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("integrity check failed");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
