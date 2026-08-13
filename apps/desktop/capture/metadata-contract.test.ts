import { describe, expect, test } from "bun:test";
import { RecordingEventV1Schema } from "../contracts/recording";

const base = { nativeTimeUs: 10_000, sequence: 0, sourceTimeUs: 1_000 } as const;

const helperMetadataFixtures = [
  { ...base, displayId: "1", position: { x: 10, y: 20 }, type: "cursor.sample", visible: true },
  {
    ...base,
    button: "left",
    clickCount: 1,
    displayId: "1",
    phase: "down",
    position: { x: 10, y: 20 },
    type: "mouse.click",
  },
  {
    ...base,
    activity: { kind: "printable", modifiers: [], phase: "down", repeat: false, token: "[PRINTABLE]" },
    type: "key.activity",
  },
  {
    ...base,
    activity: { kind: "shortcut", keyCode: "keycode-8", modifiers: ["command"], phase: "down", repeat: false },
    type: "key.activity",
  },
  {
    ...base,
    input: {
      action: "insert",
      bounds: { height: 28, width: 240, x: 100, y: 80 },
      fieldId: "search",
      secure: false,
      text: "a",
      windowId: "42",
    },
    type: "typing.input",
  },
  {
    ...base,
    target: {
      bounds: { height: 28, width: 240, x: 100, y: 80 },
      fieldId: "[REDACTED]",
      kind: "secure-input",
      redacted: true,
      role: "secure-text-field",
      windowId: "42",
    },
    type: "focus.changed",
  },
  {
    ...base,
    type: "window.snapshot",
    windows: [{
      applicationBundleId: "com.example.app",
      applicationName: "Example",
      bounds: { height: 600, width: 800, x: 10, y: 20 },
      displayId: "1",
      isFocused: true,
      layer: 0,
      title: { state: "available", value: "Document" },
      windowId: "42",
    }],
  },
  {
    ...base,
    displays: [{
      bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
      displayId: "1",
      isPrimary: true,
      label: "Primary display",
      pixelSize: { height: 2_160, width: 3_840 },
      refreshRateHz: 60,
      scaleFactor: 2,
    }],
    type: "display.topology",
  },
  { ...base, marker: "segment-opened", segmentId: "segment_00000001", type: "lifecycle.marker" },
  {
    ...base,
    category: "cursor",
    droppedCount: 4,
    firstDroppedNativeTimeUs: 9_000,
    lastDroppedNativeTimeUs: 9_500,
    reason: "bounded metadata queue or JSONL line limit",
    type: "diagnostic.dropped-events",
  },
];

describe("native metadata JSONL contract", () => {
  test("representative helper events parse at the strict recording boundary", () => {
    for (const event of helperMetadataFixtures) {
      expect(RecordingEventV1Schema.safeParse(event).success).toBeTrue();
    }
  });

  test("fixtures never encode a key event for a secure field", () => {
    const serialized = JSON.stringify(helperMetadataFixtures.filter(({ type }) => type === "key.activity"));
    expect(serialized.includes('"kind":"secure"')).toBeFalse();
  });

  test("retains raw global coordinates for a display left of the primary display", () => {
    const topology = RecordingEventV1Schema.parse({
      ...base,
      displays: [
        {
          bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
          displayId: "primary",
          isPrimary: true,
          label: "Primary display",
          pixelSize: { height: 2_160, width: 3_840 },
          refreshRateHz: 60,
          scaleFactor: 2,
        },
        {
          bounds: { height: 1_024, width: 1_280, x: -1_280, y: 56 },
          displayId: "left",
          isPrimary: false,
          label: "Left display",
          pixelSize: { height: 1_024, width: 1_280 },
          refreshRateHz: 60,
          scaleFactor: 1,
        },
      ],
      type: "display.topology",
    });
    const cursor = RecordingEventV1Schema.parse({
      ...base,
      displayId: "left",
      position: { x: -1_200, y: 156 },
      type: "cursor.sample",
      visible: true,
    });
    const leftDisplay = topology.type === "display.topology"
      ? topology.displays.find(({ displayId }) => displayId === "left")
      : undefined;

    expect(leftDisplay?.bounds.x).toBe(-1_280);
    expect(cursor.type === "cursor.sample" ? cursor.position : null).toEqual({ x: -1_200, y: 156 });
    expect((cursor.type === "cursor.sample" ? cursor.position.x : 0) - (leftDisplay?.bounds.x ?? 0)).toBe(80);
  });

  test("records both native event-tap disable reasons before re-enabling input capture", async () => {
    const source = await Bun.file(new URL("./MetadataCapture.swift", import.meta.url)).text();
    const timeoutCase = source.indexOf("case .tapDisabledByTimeout:");
    const userInputCase = source.indexOf("case .tapDisabledByUserInput:");
    const recovery = source.indexOf("private func recoverEventTap(afterDisableReason reason: String)");
    const diagnostic = source.indexOf("appendMetadataDiagnostic(", recovery);
    const reenable = source.indexOf("CGEvent.tapEnable(tap: tap, enable: true)", recovery);

    expect(timeoutCase).toBeGreaterThanOrEqual(0);
    expect(userInputCase).toBeGreaterThan(timeoutCase);
    expect(source.slice(timeoutCase, userInputCase)).toContain(
      'recoverEventTap(afterDisableReason: "callback timeout")',
    );
    expect(source.slice(userInputCase, recovery)).toContain(
      'recoverEventTap(afterDisableReason: "user input")',
    );
    expect(diagnostic).toBeGreaterThan(recovery);
    expect(reenable).toBeGreaterThan(diagnostic);
    expect(source.slice(diagnostic, reenable)).toContain(
      "interaction events may have been dropped",
    );
  });

  test("brackets retained media with synchronous metadata boundaries", async () => {
    const [capture, metadata] = await Promise.all([
      Bun.file(new URL("./Capture.swift", import.meta.url)).text(),
      Bun.file(new URL("./MetadataCapture.swift", import.meta.url)).text(),
    ]);
    const metadataStart = capture.indexOf(
      'metadataCoordinator.start(marker: "segment-opened")',
    );
    const screenStart = capture.indexOf(
      "async let screenAttempt = attemptScreenStart(",
    );
    expect(metadataStart).toBeGreaterThanOrEqual(0);
    expect(screenStart).toBeGreaterThan(metadataStart);

    const finalize = capture.indexOf("private func finalizeCaptureSegment(");
    const stopMedia = capture.indexOf(
      "async let displayCompletion = segment.screen.stop()",
      finalize,
    );
    const awaitMedia = capture.indexOf(
      "displays = try await displayCompletion",
      stopMedia,
    );
    const stopMetadata = capture.indexOf(
      "let metadataCompletion = segment.metadata?.stop(",
      awaitMedia,
    );
    expect(finalize).toBeGreaterThanOrEqual(0);
    expect(stopMedia).toBeGreaterThan(finalize);
    expect(awaitMedia).toBeGreaterThan(stopMedia);
    expect(stopMetadata).toBeGreaterThan(awaitMedia);
    expect(capture.slice(finalize, stopMedia)).toContain(
      "close: CaptureSegmentClose",
    );
    expect(capture.slice(stopMetadata)).toContain(
      '"nativeTimeUs": close.stamp.nativeTimeUs',
    );
    expect(capture.slice(stopMetadata)).toContain(
      '"sourceTimeUs": close.stamp.sourceTimeUs',
    );

    const start = metadata.indexOf("func start(marker: String)");
    const openingCursor = metadata.indexOf("pollCursor()", start);
    const startCursorTimer = metadata.indexOf("startCursorTimer()", start);
    const stop = metadata.indexOf(
      "func stop(finalMarker: String)",
      startCursorTimer,
    );
    const disable = metadata.indexOf("stateLock.lock()", stop);
    const markStopped = metadata.indexOf("stopped = true", disable);
    const cancelTimers = metadata.indexOf(
      "timers.compactMap { $0 }.forEach { $0.cancel() }",
      markStopped,
    );
    const drainPollers = metadata.indexOf(
      "pollingQueue.sync {",
      cancelTimers,
    );
    const closingCursor = metadata.indexOf(
      "pollCursor(allowWhenStopped: true)",
      drainPollers,
    );
    expect(openingCursor).toBeGreaterThan(start);
    expect(startCursorTimer).toBeGreaterThan(openingCursor);
    expect(disable).toBeGreaterThan(stop);
    expect(markStopped).toBeGreaterThan(disable);
    expect(cancelTimers).toBeGreaterThan(markStopped);
    expect(drainPollers).toBeGreaterThan(cancelTimers);
    expect(closingCursor).toBeGreaterThan(drainPollers);
    expect(metadata).toContain(
      "DispatchSource.makeTimerSource(queue: pollingQueue)",
    );
  });

  test("publishes post-request permissions and resolved sources with segment start", async () => {
    const capture = await Bun.file(new URL("./Capture.swift", import.meta.url)).text();
    const permissionRequest = capture.indexOf(
      "let permissions = await CapturePermissions.request(options: options)",
    );
    const sourceResolution = capture.indexOf(
      "let sources = try await resolveCaptureSources(options: options)",
      permissionRequest,
    );
    const segmentEvent = capture.indexOf(
      'event: "segment-started"',
      sourceResolution,
    );
    const permissionEvidence = capture.indexOf(
      '"permissions": permissions.json',
      sourceResolution,
    );
    const selectedSourceSnapshot = capture.indexOf(
      "selectedSourceInventory = try CaptureControllerRequestlessObject(",
      sourceResolution,
    );
    const sourceEvidence = capture.indexOf(
      '"sources": try selectedSourceInventory.fields()',
      selectedSourceSnapshot,
    );

    expect(permissionRequest).toBeGreaterThanOrEqual(0);
    expect(sourceResolution).toBeGreaterThan(permissionRequest);
    expect(selectedSourceSnapshot).toBeGreaterThan(sourceResolution);
    expect(permissionEvidence).toBeGreaterThan(selectedSourceSnapshot);
    expect(sourceEvidence).toBeGreaterThan(permissionEvidence);
    expect(segmentEvent).toBeGreaterThan(sourceEvidence);
  });

  test("waits for the input event tap before any media recorder starts", async () => {
    const [capture, metadata] = await Promise.all([
      Bun.file(new URL("./Capture.swift", import.meta.url)).text(),
      Bun.file(new URL("./MetadataCapture.swift", import.meta.url)).text(),
    ]);
    const startTap = metadata.indexOf(
      "private func startPreparedEventTap() throws",
    );
    const enabled = metadata.indexOf(
      "CGEvent.tapEnable(tap: tap, enable: true)",
      startTap,
    );
    const verifyEnabled = metadata.indexOf(
      "let tapOperational = CGEvent.tapIsEnabled(tap: tap)",
      enabled,
    );
    const publishReady = metadata.indexOf(
      "publishEventTapReadiness(operational: tapOperational)",
      verifyEnabled,
    );
    const startThread = metadata.indexOf("thread.start()", publishReady);
    const waitReady = metadata.indexOf(
      "eventTapThreadReady.wait(",
      startThread,
    );
    const requireReady = metadata.indexOf(
      "guard ready, operational else",
      waitReady,
    );
    const metadataStart = capture.indexOf(
      'try metadataCoordinator.start(marker: "segment-opened")',
    );
    const screenStart = capture.indexOf(
      "async let screenAttempt = attemptScreenStart(",
      metadataStart,
    );

    expect(startTap).toBeGreaterThanOrEqual(0);
    expect(enabled).toBeGreaterThan(startTap);
    expect(verifyEnabled).toBeGreaterThan(enabled);
    expect(publishReady).toBeGreaterThan(verifyEnabled);
    expect(startThread).toBeGreaterThan(publishReady);
    expect(waitReady).toBeGreaterThan(startThread);
    expect(requireReady).toBeGreaterThan(waitReady);
    expect(metadataStart).toBeGreaterThanOrEqual(0);
    expect(screenStart).toBeGreaterThan(metadataStart);
  });

  test("serializes timestamping, sequence assignment, and file enqueue across metadata producers", async () => {
    const source = await Bun.file(
      new URL("./MetadataCapture.swift", import.meta.url),
    ).text();
    const lockDeclaration = source.indexOf(
      "private let eventEmissionLock = NSLock()",
    );
    const helper = source.indexOf("private func appendEvent(");
    const lock = source.indexOf("eventEmissionLock.lock()", helper);
    const unlock = source.indexOf(
      "defer { eventEmissionLock.unlock() }",
      lock,
    );
    const timestamp = source.indexOf("let stamp = clock.sample()", unlock);
    const sequence = source.indexOf("let eventSequence = sequence", timestamp);
    const enqueue = source.indexOf(
      "return file.append(event, nativeTimeUs: stamp.nativeTimeUs)",
      sequence,
    );

    expect(lockDeclaration).toBeGreaterThanOrEqual(0);
    expect(helper).toBeGreaterThan(lockDeclaration);
    expect(lock).toBeGreaterThan(helper);
    expect(unlock).toBeGreaterThan(lock);
    expect(timestamp).toBeGreaterThan(unlock);
    expect(sequence).toBeGreaterThan(timestamp);
    expect(enqueue).toBeGreaterThan(sequence);
    expect(source).not.toContain("private func baseEvent(");
    expect(source).not.toContain("private func nextSequence()");
    for (const append of [
      'appendEvent(to: cursorFile, type: "cursor.sample")',
      'appendEvent(to: inputFile, type: "mouse.click")',
      'appendEvent(to: inputFile, type: "key.activity")',
      'appendEvent(to: inputFile, type: "typing.input")',
      'appendEvent(to: windowsFile, type: "window.snapshot")',
      'appendEvent(to: windowsFile, type: "window.changed")',
      'appendEvent(to: displaysFile, type: "display.topology")',
      'appendEvent(to: focusFile, type: "focus.changed")',
      'appendEvent(to: lifecycleFile, type: "lifecycle.marker")',
      'appendEvent(to: lifecycleFile, type: "diagnostic.dropped-events")',
    ]) {
      expect(source).toContain(append);
    }
  });

  test("bounds event-tap teardown before metadata files are finalized", async () => {
    const source = await Bun.file(
      new URL("./MetadataCapture.swift", import.meta.url),
    ).text();
    const stop = source.indexOf("func stop(finalMarker: String)");
    const wait = source.indexOf(
      "eventTapThreadFinished.wait(",
      stop,
    );
    const timeout = source.indexOf(
      ".seconds(eventTapThreadShutdownTimeoutSeconds)",
      wait,
    );
    const timeoutDiagnostic = source.indexOf(
      "listen-only event tap did not stop within",
      timeout,
    );
    const finalizeFiles = source.indexOf(
      "let completions = files.map { $0.completion() }",
      timeoutDiagnostic,
    );
    const stopSource = source.slice(
      stop,
      source.indexOf("fileprivate func receiveInput", stop),
    );

    expect(stop).toBeGreaterThanOrEqual(0);
    expect(wait).toBeGreaterThan(stop);
    expect(timeout).toBeGreaterThan(wait);
    expect(timeoutDiagnostic).toBeGreaterThan(timeout);
    expect(finalizeFiles).toBeGreaterThan(timeoutDiagnostic);
    expect(stopSource).not.toContain("eventTapThreadFinished.wait()");
  });

  test("derives metadata coverage from the full retained stream envelope", async () => {
    const source = await Bun.file(
      new URL("./hardware-smoke.macos.test.ts", import.meta.url),
    ).text();
    const coverage = source.indexOf(
      "const segmentCoverage = completed.map((segment) =>",
    );
    const retained = source.indexOf(
      "const retainedStreams = [",
      coverage,
    );
    const camera = source.indexOf(
      'segment.camera.availability === "recorded"',
      retained,
    );
    const microphone = source.indexOf(
      'segment.microphone.availability === "recorded"',
      camera,
    );
    const earliest = source.indexOf(
      "const firstRetainedSampleNativeTimeUs = Math.min(",
      microphone,
    );
    const latest = source.indexOf(
      "const lastRetainedSampleNativeTimeUs = Math.max(",
      earliest,
    );

    expect(coverage).toBeGreaterThanOrEqual(0);
    expect(retained).toBeGreaterThan(coverage);
    expect(camera).toBeGreaterThan(retained);
    expect(microphone).toBeGreaterThan(camera);
    expect(earliest).toBeGreaterThan(microphone);
    expect(latest).toBeGreaterThan(earliest);
    expect(source.slice(coverage, earliest)).not.toContain(
      "display.isPrimary",
    );
  });

  test("selects exactly one scoped or session event tap", async () => {
    const source = await Bun.file(
      new URL("./MetadataCapture.swift", import.meta.url),
    ).text();
    const processBranch = source.indexOf(
      "if let processId = options.interactionEventProcessIdentifier",
    );
    const scopedTap = source.indexOf(
      "CGEvent.tapCreateForPid(",
      processBranch,
    );
    const sessionBranch = source.indexOf("} else {", scopedTap);
    const sessionTap = source.indexOf("CGEvent.tapCreate(", sessionBranch);
    const unavailable = source.indexOf("guard let tap else", sessionTap);

    expect(processBranch).toBeGreaterThanOrEqual(0);
    expect(scopedTap).toBeGreaterThan(processBranch);
    expect(sessionBranch).toBeGreaterThan(scopedTap);
    expect(sessionTap).toBeGreaterThan(sessionBranch);
    expect(unavailable).toBeGreaterThan(sessionTap);
    expect(source.slice(processBranch, unavailable)).toContain(
      'tapScope = "process-scoped"',
    );
    expect(source.slice(processBranch, unavailable)).toContain(
      'tapScope = "session"',
    );
  });

  test("resolves the actual accessibility-focused window instead of the first window for the frontmost PID", async () => {
    const source = await Bun.file(
      new URL("./MetadataCapture.swift", import.meta.url),
    ).text();
    const resolver = source.indexOf(
      "private func focusedWindowIdentifier(",
    );
    const focusedAttribute = source.indexOf(
      "kAXFocusedWindowAttribute as String",
      resolver,
    );
    const recordReader = source.indexOf(
      "private func readWindowRecords()",
      resolver,
    );
    const resolvedIdentity = source.indexOf(
      "let focusedWindowId = frontPid.flatMap",
      recordReader,
    );
    const assignment = source.indexOf(
      "let isFocused = focusedWindowId == identifier",
      resolvedIdentity,
    );

    expect(resolver).toBeGreaterThanOrEqual(0);
    expect(focusedAttribute).toBeGreaterThan(resolver);
    expect(recordReader).toBeGreaterThan(focusedAttribute);
    expect(resolvedIdentity).toBeGreaterThan(recordReader);
    expect(assignment).toBeGreaterThan(resolvedIdentity);
    expect(source).not.toContain(
      "let isFocused = !focusedWindowAssigned && frontPid == pid",
    );
  });

  test("matches the complete native focus tuple before persisting opted-in text", async () => {
    const source = await Bun.file(
      new URL("./MetadataCapture.swift", import.meta.url),
    ).text();
    const typedTextGuard = source.indexOf(
      "guard options.typedText, type == .keyDown",
    );
    const identityGuard = source.indexOf(
      "options.typedTextFocusIdentities",
      typedTextGuard,
    );
    const typingAppend = source.indexOf(
      'appendEvent(to: inputFile, type: "typing.input")',
      typedTextGuard,
    );

    expect(typedTextGuard).toBeGreaterThanOrEqual(0);
    expect(identityGuard).toBeGreaterThan(typedTextGuard);
    expect(typingAppend).toBeGreaterThan(identityGuard);
    expect(source.slice(typedTextGuard, identityGuard)).toContain(
      "let processId = focus.processId",
    );
    const guardedSource = source.slice(identityGuard, typingAppend);
    for (const component of [
      "fieldId: fieldId",
      "processId: processId",
      "windowId: windowId",
      "windowTitle: windowTitle",
    ]) {
      expect(guardedSource).toContain(component);
    }
    expect(guardedSource).toContain(
      "allowedFocusIdentities.contains(TypedTextFocusIdentity(",
    );
  });

  test("retains shortcut activity without misrepresenting it as typed text", async () => {
    const source = await Bun.file(
      new URL("./MetadataCapture.swift", import.meta.url),
    ).text();
    const activityAppend = source.indexOf(
      'appendEvent(to: inputFile, type: "key.activity")',
    );
    const shortcutGuard = source.indexOf(
      "guard !hasNonTextEditingModifier(event.flags) else { return }",
      activityAppend,
    );
    const typingAppend = source.indexOf(
      'appendEvent(to: inputFile, type: "typing.input")',
      shortcutGuard,
    );
    const modifierClassifier = source.indexOf(
      "private func hasNonTextEditingModifier(",
    );

    expect(activityAppend).toBeGreaterThanOrEqual(0);
    expect(shortcutGuard).toBeGreaterThan(activityAppend);
    expect(typingAppend).toBeGreaterThan(shortcutGuard);
    expect(modifierClassifier).toBeGreaterThan(typingAppend);
    const classifier = source.slice(
      modifierClassifier,
      source.indexOf("private func controlKeyName(", modifierClassifier),
    );
    for (const modifier of [
      ".maskCommand",
      ".maskControl",
      ".maskAlternate",
      ".maskSecondaryFn",
    ]) {
      expect(classifier).toContain(modifier);
    }
    expect(classifier).not.toContain(".maskShift");
    expect(classifier).not.toContain(".maskAlphaShift");
  });

  test("emits a positive process identity on captured input focus", async () => {
    const source = await Bun.file(
      new URL("./MetadataCapture.swift", import.meta.url),
    ).text();
    const targetStart = source.indexOf("var target: [String: Any]");
    const signature = source.indexOf(
      'let signature = "\\(target)|\\(frontmost)"',
      targetStart,
    );
    const targetSource = source.slice(targetStart, signature);

    expect(targetStart).toBeGreaterThanOrEqual(0);
    expect(signature).toBeGreaterThan(targetStart);
    expect(targetSource).toContain(
      'if let processId, target["kind"] as? String != "none"',
    );
    expect(targetSource).toContain(
      'target["processId"] = Int(processId)',
    );
    expect(source).not.toContain(
      ": (frontmostApplication?.processIdentifier ?? 0)",
    );
  });
});
