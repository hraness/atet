import { describe, expect, test } from "bun:test";

import {
  createAtetDirectWorld,
  fixtureIdleSnapshot,
  fullEditEvidence,
  fullProjectEvidence,
  parseAtetDirectWorld,
} from "./world";

describe("Atet Direct world", () => {
  test("contains token-efficient evidence for every requested edit surface", () => {
    const world = createAtetDirectWorld({ initial: fixtureIdleSnapshot(false), transitions: [] });

    expect(world.version).toBe(6);
    expect(world.runtime.initial.sources).toEqual({
      audioSources: [],
      cameras: [],
      displays: [],
    });
    expect(world.runtime.initial.availableSources.displays).toHaveLength(2);
    expect(world.runtime.initial.lastInterruption).toBeNull();
    expect(world.editEvidence.analyzer.map(({ kind }) => kind).toSorted()).toEqual(["freeze", "silence"]);
    expect(world.editEvidence.metadata.map(({ kind }) => kind).toSorted()).toEqual([
      "click",
      "cursor",
      "typing",
      "typing",
      "window",
    ]);
    expect(world.editEvidence.edits.map(({ kind }) => kind).toSorted()).toEqual(["cut", "speed", "zoom"]);
    expect(world.editEvidence.overlays.map(({ kind }) => kind).toSorted()).toEqual([
      "emoji",
      "gif",
      "image",
      "svg",
      "video",
    ]);

    const {
      acceptedAlignments,
      camera,
      editPlan,
      music,
      project,
      provenance,
      scenes,
      speech,
    } = world.projectEvidence;
    expect(project.assets.map(({ role }) => role).toSorted()).toEqual(["camera", "camera", "screen"]);
    expect(project.placements).toHaveLength(3);
    expect(project.placements.filter(({ sync }) => sync.provenance.kind === "audio-alignment")).toHaveLength(2);
    expect(acceptedAlignments).toHaveLength(2);
    expect(editPlan.speed).toEqual([{ range: { endUs: 24_000_000, startUs: 20_000_000 }, rate: 1.75 }]);
    expect(editPlan.keep).toHaveLength(3);
    expect(editPlan.cameraMoves.map(({ cameraMoveId, keyframes, origin }) => ({
      cameraMoveId: String(cameraMoveId),
      keyframes: keyframes.length,
      origin: origin.kind,
    }))).toEqual([
      { cameraMoveId: "camera_kenburns001", keyframes: 2, origin: "manual" },
      { cameraMoveId: "camera_faces0001", keyframes: 6, origin: "face-analysis" },
    ]);
    const manualMove = editPlan.cameraMoves[0]!;
    expect(manualMove.keyframes[0]?.pose).not.toEqual(manualMove.keyframes.at(-1)?.pose);
    const faceMove = editPlan.cameraMoves[1]!;
    expect(faceMove.origin.kind === "face-analysis"
      ? faceMove.origin.trackIds.map(String)
      : []).toEqual([
      "face_track00001",
      "face_track00002",
    ]);
    expect(camera.operations.map(({ receipt, technique }) => ({
      cameraMoveId: String(receipt.cameraMoveId),
      cameraMoves: receipt.cameraMoves,
      keyframes: receipt.keyframeCount,
      technique,
    }))).toEqual([
      {
        cameraMoveId: "camera_kenburns001",
        cameraMoves: 1,
        keyframes: 2,
        technique: "ken-burns-digital-pan-zoom",
      },
      {
        cameraMoveId: "camera_faces0001",
        cameraMoves: 2,
        keyframes: 6,
        technique: "face-follow",
      },
    ]);
    const faceOperation = camera.operations[1]!;
    expect(faceOperation.technique === "face-follow" ? faceOperation.gapPolicy : null).toEqual({
      kind: "hold",
      maximumHoldUs: 3_000_000,
      whenExpired: "fallback",
    });
    expect(faceOperation.receipt.selection === null ? null : {
      ...faceOperation.receipt.selection,
      trackIds: faceOperation.receipt.selection.trackIds.map(String),
    }).toEqual({
      kind: "explicit",
      requireAllSelected: true,
      trackIds: ["face_track00001", "face_track00002"],
    });
    expect(camera.faceAnalysis.privacy).toEqual({
      biometricIdentification: "not-performed",
      execution: "local-only",
      storedEvidence: "bounding-boxes-only",
      tracking: "geometry-continuity-only",
    });
    expect(music.tempoRegions.at(-1)?.changeFromPrevious).toMatchObject({ deltaBpm: 14 });
    expect(music.keyRegions.map(({ key }) => key.kind)).toEqual(["key", "key"]);
    expect(provenance).toMatchObject({
      localBoundaryDetector: "PySceneDetect-compatible reference",
      pythonRuntimeRequired: false,
      remoteExecutionRequired: false,
    });
    expect(scenes.map(({ subjects }) => String(subjects[0]?.streamId))).toEqual([
      "stream_screen_video",
      "stream_cam_a_video",
    ]);
    expect(scenes.every(({ usage }) => usage.uploadedImages === 0)).toBe(true);
    expect(speech.result.status).toBe("transcribed");
    if (speech.result.status === "transcribed") {
      expect(speech.result.fillers.map(({ musicProtected }) => musicProtected)).toEqual([false, false, true]);
      expect(speech.result.fillers.map(({ autoApplicable }) => autoApplicable)).toEqual([true, false, false]);
    }
    expect(editPlan.overlays.map(({ source }) => source.kind).toSorted()).toEqual([
      "emoji",
      "gif",
      "image",
      "svg",
      "video",
    ]);
    expect(editPlan.overlays.some(({ motion }) => motion.kind === "keyframes")).toBe(true);
    expect(editPlan.overlays.some(({ source }) => source.kind === "video" && source.audioPolicy.kind === "duck-primary")).toBe(true);

    const workflow = world.workflowEvidence;
    expect(workflow.nodes.some(({ executor }) => executor.kind === "compute")).toBe(true);
    expect(workflow.waves.some((wave) => (
      wave.includes("analyze/faces")
      && wave.includes("analyze/inactivity")
      && wave.includes("analyze/music")
    ))).toBe(true);
    expect(workflow.runs.map(({ summary }) => summary.status)).toEqual([
      "ambiguous-code",
      "completed",
    ]);
    expect(workflow.runs[0]?.nodes.find(({ key }) => key === "curate")).toMatchObject({
      attempt: 1,
      status: "ambiguous-code",
    });
    expect(workflow.runs[1]?.nodes.find(({ key }) => key === "curate")).toMatchObject({
      attempt: 2,
      status: "completed",
    });
    expect(workflow.recovery.command).toContain("--replay-ambiguous-code curate");
    expect(workflow.durableRun.outputsDocument.graphPlanSha256).toBe(
      workflow.graphPlanSha256,
    );
    const outputs = workflow.durableRun.outputsDocument.outputs;
    if (typeof outputs !== "object" || outputs === null || Array.isArray(outputs)) {
      throw new Error("Workflow run outputs must be a keyed object.");
    }
    expect(Object.keys(outputs).toSorted()).toEqual([
      "curated",
      "edits",
    ]);
    expect(Object.keys(workflow.durableRun.outputsDocument.nodeOutputDigests).toSorted()).toEqual([
      "curate",
      "edits",
    ]);
  });

  test("rejects inverted evidence ranges and repeated overlay kinds", () => {
    const inverted = createAtetDirectWorld({ initial: fixtureIdleSnapshot(false), transitions: [] });
    inverted.editEvidence.analyzer[0]!.endUs = inverted.editEvidence.analyzer[0]!.startUs;
    expect(() => parseAtetDirectWorld(inverted)).toThrow("positive duration");

    const evidence = fullEditEvidence();
    evidence.overlays[1]!.kind = evidence.overlays[0]!.kind;
    expect(() => createAtetDirectWorld(
      { initial: fixtureIdleSnapshot(false), transitions: [] },
      evidence,
    )).toThrow("at most once");
  });

  test("rejects project evidence that loses sync, camera, privacy, or local-execution provenance", () => {
    const invalidAlignment = createAtetDirectWorld({ initial: fixtureIdleSnapshot(false), transitions: [] });
    invalidAlignment.projectEvidence.acceptedAlignments[0]!.candidateId = "candidate_missing1";
    expect(() => parseAtetDirectWorld(invalidAlignment)).toThrow("Accepted alignment evidence");

    const externalScene = fullProjectEvidence();
    externalScene.scenes[0]!.usage.uploadedImages = 1;
    expect(() => createAtetDirectWorld(
      { initial: fixtureIdleSnapshot(false), transitions: [] },
      fullEditEvidence(),
      externalScene,
    )).toThrow("cannot require cloud execution");

    const mismatchedCameraReceipt = fullProjectEvidence();
    Reflect.set(
      mismatchedCameraReceipt.camera.operations[1]!.receipt,
      "cameraMoveId",
      "camera_other0001",
    );
    expect(() => createAtetDirectWorld(
      { initial: fixtureIdleSnapshot(false), transitions: [] },
      fullEditEvidence(),
      mismatchedCameraReceipt,
    )).toThrow("receipts must match");

    const biometricFaceEvidence = fullProjectEvidence();
    Reflect.set(
      biometricFaceEvidence.camera.faceAnalysis.privacy,
      "biometricIdentification",
      "performed",
    );
    expect(() => createAtetDirectWorld(
      { initial: fixtureIdleSnapshot(false), transitions: [] },
      fullEditEvidence(),
      biometricFaceEvidence,
    )).toThrow();
  });
});
