import { expect, test } from "bun:test";
import { runCaptureControllerFinalizationHarness } from "./build";

const harnessSource = String.raw`
import Foundation

enum HarnessFailure: Error {
    case assertion(String)
}

func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw HarnessFailure.assertion(message) }
}

final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: UInt64

    init(_ value: UInt64) {
        stored = value
    }

    func read() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func advance(_ delta: UInt64) {
        lock.lock()
        stored += delta
        lock.unlock()
    }
}

final class BatchAudit: @unchecked Sendable {
    private let lock = NSLock()
    private var batches: [Data] = []

    func append(_ batch: Data) {
        lock.lock()
        batches.append(batch)
        lock.unlock()
    }

    var decodedEvents: [[String: Any]] {
        lock.lock()
        let snapshot = batches
        lock.unlock()
        return snapshot.flatMap { batch in
            String(decoding: batch, as: UTF8.self)
                .split(separator: "\n")
                .compactMap { line in
                    guard let data = String(line).data(using: .utf8) else {
                        return nil
                    }
                    return try? JSONSerialization.jsonObject(with: data)
                        as? [String: Any]
                }
        }
    }
}

func failure(
    code: String,
    state: HelperState
) -> CaptureControllerFinalizationFailure {
    do {
        return try CaptureControllerFinalizationFailure(
            code: code,
            message: code,
            recoverable: true,
            state: state
        )
    } catch {
        preconditionFailure("Harness failure fixture was invalid.")
    }
}

func completion(
    index: Int
) -> CaptureControllerFinalizationOutcome {
    do {
        return .completion(CaptureControllerFinalizationCompletion(
            segment: try CaptureControllerRequestlessObject([
                "index": index,
            ])
        ))
    } catch {
        preconditionFailure("Harness completion fixture was invalid.")
    }
}

func lease(
    _ result: CaptureControllerDeliveryReservationResult
) throws -> CaptureControllerDeliveryLease {
    guard case .reserved(let lease) = result else {
        throw HarnessFailure.assertion("delivery lease was not reserved")
    }
    return lease
}

func outcome(
    engine: CaptureControllerFinalization,
    lease: CaptureControllerDeliveryLease
) async throws -> CaptureControllerReservedFinalization {
    guard case .outcome(let reserved) = await engine.awaitDelivery(lease) else {
        throw HarnessFailure.assertion("delivery did not produce an outcome")
    }
    return reserved
}

func preparedDrain(
    timeline: CaptureTimeline,
    interval: TimelinePreparedInterval,
    coordinator: CaptureControllerStartCoordinator,
    code: String,
    state: HelperState
) -> CaptureControllerPreparedStartDrain {
    CaptureControllerPreparedStartDrain(operation: { close in
        _ = await coordinator.drain()
        let discarded = timeline.discardPreparedInterval(
            interval,
            closedAt: close.stamp
        )
        guard discarded == .discarded
                || discarded == .alreadyDiscarded else {
            return failure(code: "discard-failed", state: .stopped)
        }
        return failure(code: code, state: state)
    })
}

func completionEvent(
    _ reserved: CaptureControllerReservedFinalization,
    requestId: String
) throws -> [String: Any] {
    guard case .completion(let completed) = reserved.outcome else {
        throw HarnessFailure.assertion("expected completion outcome")
    }
    return try completed.segment.protocolObject(
        event: "segment-completed",
        requestId: requestId
    )
}

func failureEvent(
    _ reserved: CaptureControllerReservedFinalization,
    requestId: String
) throws -> [String: Any] {
    guard case .failure(let failed) = reserved.outcome else {
        throw HarnessFailure.assertion("expected failure outcome")
    }
    return [
        "code": failed.code,
        "event": "error",
        "message": failed.message,
        "recoverable": failed.recoverable,
        "requestId": requestId,
        "state": failed.state.rawValue,
    ]
}

@main
struct HarnessMain {
    static func main() async throws {
        let audit = BatchAudit()
        let emitter = ProtocolEmitter(lineWriter: { batch in
            audit.append(batch)
        })

        // A deferred close is reconciled first. Permission failure belongs to
        // a newly armed prepared generation and therefore follows the old
        // completion under the same resume request.
        let clock = ManualClock(10_000)
        let timeline = CaptureTimeline(monotonicClock: { clock.read() })
        let gate = CaptureSegmentCloseGate(timeline: timeline)
        let engine = CaptureControllerFinalization()
        let oldInterval = try timeline.beginPreparedActive()
        let oldCoordinator = CaptureControllerStartCoordinator(
            fallbackFailure: CaptureControllerPreparedFailure(
                code: "old-unannounced",
                message: "old-unannounced",
                recoverable: true,
                state: .ready
            )
        )
        oldCoordinator.completeUnstarted(
            Set(CaptureControllerPreparedProducer.allCases)
        )
        let oldScope = try engine.beginPreparedStart(
            gate: gate,
            segmentIndex: 0,
            drain: preparedDrain(
                timeline: timeline,
                interval: oldInterval,
                coordinator: oldCoordinator,
                code: "old-unannounced",
                state: .ready
            )
        )
        guard case .began(let oldAnnouncement) =
            try engine.beginStartAnnouncement(
                scope: oldScope,
                activeJob: { _ in completion(index: 0) }
            ) else {
            throw HarnessFailure.assertion("old generation did not announce")
        }
        try require(
            timeline.commitPreparedInterval(oldInterval) == .committed,
            "old confirmed interval did not commit"
        )
        try require(
            try engine.finishStartAnnouncement(
                token: oldAnnouncement,
                disposition: .confirmed
            ) == .activated,
            "old generation did not activate"
        )
        clock.advance(200)
        guard case .launched = try engine.requestClose(
            scope: oldScope,
            reason: .pause
        ) else {
            throw HarnessFailure.assertion("deferred close did not launch")
        }

        let resumeRequestId = "resume-permission"
        let flushLease = try lease(engine.reserveDelivery(.flush))
        let oldOutcome = try await outcome(
            engine: engine,
            lease: flushLease
        )
        try require(
            emitter.emitBatch([
                try completionEvent(
                    oldOutcome,
                    requestId: resumeRequestId
                ),
            ]) == .confirmedNominal(eventCount: 1),
            "old completion did not emit"
        )
        try require(
            try engine.completeDelivery(
                flushLease,
                disposition: .confirmed
            ) == .confirmed,
            "old completion did not commit"
        )
        try require(
            timeline.sample().sourceTimeUs == 200,
            "old completion used the wrong frontier"
        )

        let failedResumeInterval = try timeline.beginPreparedActive()
        let failedResumeCoordinator = CaptureControllerStartCoordinator(
            fallbackFailure: CaptureControllerPreparedFailure(
                code: "screen-permission-denied",
                message: "screen-permission-denied",
                recoverable: true,
                state: .paused
            )
        )
        failedResumeCoordinator.completeUnstarted(
            Set(CaptureControllerPreparedProducer.allCases)
        )
        let failedResumeScope = try engine.beginPreparedStart(
            gate: gate,
            segmentIndex: 1,
            drain: preparedDrain(
                timeline: timeline,
                interval: failedResumeInterval,
                coordinator: failedResumeCoordinator,
                code: "screen-permission-denied",
                state: .paused
            )
        )
        let failedResumeLease = try lease(engine.reserveDelivery(.close(
            scope: failedResumeScope,
            reason: .startFailure
        )))
        let failedResumeOutcome = try await outcome(
            engine: engine,
            lease: failedResumeLease
        )
        try require(
            emitter.emitBatch([
                try failureEvent(
                    failedResumeOutcome,
                    requestId: resumeRequestId
                ),
            ]) == .confirmedNominal(eventCount: 1),
            "permission failure did not emit"
        )
        try require(
            try engine.completeDelivery(
                failedResumeLease,
                disposition: .confirmed
            ) == .confirmed,
            "permission failure did not commit"
        )
        try require(
            timeline.sample().sourceTimeUs == 200,
            "permission failure changed the resume frontier"
        )

        let retry = try timeline.beginPreparedActive()
        try require(
            retry.start.sourceTimeUs == 200,
            "retry inherited failed resume time"
        )
        try require(
            timeline.commitPreparedInterval(retry) == .committed,
            "retry did not commit"
        )
        let retryScope = try gate.arm(segmentIndex: 2)
        clock.advance(25)
        guard case .accepted(let retryStop) = try gate.claimRequested(
            scope: retryScope,
            reason: .stop
        ) else {
            throw HarnessFailure.assertion("retry stop was not accepted")
        }
        try require(
            retryStop.stamp.sourceTimeUs == 225,
            "retry stop included failed permission time"
        )

        // Rejected announcements must drain and discard even after every
        // producer has completed.
        let rejectionClock = ManualClock(20_000)
        let rejectionTimeline = CaptureTimeline(
            monotonicClock: { rejectionClock.read() }
        )
        let rejectionGate = CaptureSegmentCloseGate(
            timeline: rejectionTimeline
        )
        let rejectionEngine = CaptureControllerFinalization()
        let rejectedInterval = try rejectionTimeline.beginPreparedActive()
        let rejectedCoordinator = CaptureControllerStartCoordinator(
            fallbackFailure: CaptureControllerPreparedFailure(
                code: "announcement-rejected",
                message: "announcement-rejected",
                recoverable: true,
                state: .ready
            )
        )
        rejectedCoordinator.completeUnstarted(
            Set(CaptureControllerPreparedProducer.allCases)
        )
        let rejectedScope = try rejectionEngine.beginPreparedStart(
            gate: rejectionGate,
            segmentIndex: 3,
            drain: preparedDrain(
                timeline: rejectionTimeline,
                interval: rejectedInterval,
                coordinator: rejectedCoordinator,
                code: "announcement-rejected",
                state: .ready
            )
        )
        guard case .began(let rejectedAnnouncement) =
            try rejectionEngine.beginStartAnnouncement(
                scope: rejectedScope,
                activeJob: { _ in completion(index: 3) }
            ) else {
            throw HarnessFailure.assertion(
                "rejected generation did not announce"
            )
        }
        rejectionClock.advance(90)
        guard case .finalizing =
            try rejectionEngine.finishStartAnnouncement(
                token: rejectedAnnouncement,
                disposition: .rejectedBeforeWrite
            ) else {
            throw HarnessFailure.assertion(
                "announcement rejection did not finalize"
            )
        }
        let rejectedLease = try lease(
            rejectionEngine.reserveDelivery(.observe)
        )
        _ = try await outcome(
            engine: rejectionEngine,
            lease: rejectedLease
        )
        try require(
            rejectionTimeline.sample().sourceTimeUs == 0,
            "announcement rejection changed the frontier"
        )
        try require(
            try rejectionEngine.completeDelivery(
                rejectedLease,
                disposition: .confirmed
            ) == .confirmed,
            "announcement rejection did not commit"
        )

        // A close can win after producers complete but before announcement.
        // The current start request must observe and deliver that failure.
        let closedClock = ManualClock(30_000)
        let closedTimeline = CaptureTimeline(
            monotonicClock: { closedClock.read() }
        )
        let closedGate = CaptureSegmentCloseGate(timeline: closedTimeline)
        let closedEngine = CaptureControllerFinalization()
        let closedInterval = try closedTimeline.beginPreparedActive()
        let closedCoordinator = CaptureControllerStartCoordinator(
            fallbackFailure: CaptureControllerPreparedFailure(
                code: "closed-before-announcement",
                message: "closed-before-announcement",
                recoverable: true,
                state: .ready
            )
        )
        closedCoordinator.completeUnstarted(
            Set(CaptureControllerPreparedProducer.allCases)
        )
        let closedScope = try closedEngine.beginPreparedStart(
            gate: closedGate,
            segmentIndex: 4,
            drain: preparedDrain(
                timeline: closedTimeline,
                interval: closedInterval,
                coordinator: closedCoordinator,
                code: "closed-before-announcement",
                state: .ready
            )
        )
        closedClock.advance(60)
        guard case .launched = try closedEngine.requestClose(
            scope: closedScope,
            reason: .startFailure
        ) else {
            throw HarnessFailure.assertion(
                "pre-announcement close did not launch"
            )
        }
        guard case .closed =
            try closedEngine.beginStartAnnouncement(
                scope: closedScope,
                activeJob: { _ in completion(index: 4) }
            ) else {
            throw HarnessFailure.assertion(
                "closed preparation did not report its close"
            )
        }
        let closedLease = try lease(
            closedEngine.reserveDelivery(.observe)
        )
        let closedOutcome = try await outcome(
            engine: closedEngine,
            lease: closedLease
        )
        try require(
            emitter.emitBatch([
                try failureEvent(
                    closedOutcome,
                    requestId: "closed-before-announcement"
                ),
            ]) == .confirmedNominal(eventCount: 1),
            "closed preparation did not emit its terminal error"
        )
        try require(
            try closedEngine.completeDelivery(
                closedLease,
                disposition: .confirmed
            ) == .confirmed,
            "closed preparation delivery did not commit"
        )
        try require(
            closedTimeline.sample().sourceTimeUs == 0,
            "closed preparation changed the frontier"
        )

        let events = audit.decodedEvents
        let report: [String: Any] = [
            "events": events.compactMap { $0["event"] as? String },
            "requestIds": events.compactMap {
                $0["requestId"] as? String
            },
            "resumeFrontierUs": timeline.sample().sourceTimeUs,
            "rejectionFrontierUs":
                rejectionTimeline.sample().sourceTimeUs,
            "closedFrontierUs": closedTimeline.sample().sourceTimeUs,
        ]
        let data = try JSONSerialization.data(
            withJSONObject: report,
            options: [.sortedKeys]
        )
        try FileHandle.standardOutput.write(contentsOf: data)
        try FileHandle.standardOutput.write(contentsOf: Data([0x0A]))
    }
}
`;

test("resume and prepared-close orchestration preserves ordered evidence and time", async () => {
  if (process.platform !== "darwin") return;

  const { stderr, stdout } = await runCaptureControllerFinalizationHarness(harnessSource);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    closedFrontierUs: 0,
    events: ["segment-completed", "error", "error"],
    rejectionFrontierUs: 0,
    requestIds: [
      "resume-permission",
      "resume-permission",
      "closed-before-announcement",
    ],
    resumeFrontierUs: 225,
  });
}, 60_000);

test("live controller reserves and prepares before start preflight suspension", async () => {
  const capture = await Bun.file(new URL("./Capture.swift", import.meta.url)).text();
  const start = capture.indexOf("private func start(requestId: String, resumed: Bool)");
  const flush = capture.indexOf(
    "let lease = try reserveControllerDelivery(.flush)",
    start,
  );
  const prepare = capture.indexOf(
    "let prepared = try prepareStartGeneration(",
    flush,
  );
  const resolve = capture.indexOf("await resolvePreparedStart(", prepare);
  const permission = capture.indexOf(
    "let permissions = await CapturePermissions.request(options: options)",
    resolve,
  );
  const sources = capture.indexOf(
    "let sources = try await resolveCaptureSources(options: options)",
    permission,
  );

  expect(start).toBeGreaterThanOrEqual(0);
  expect(flush).toBeGreaterThan(start);
  expect(prepare).toBeGreaterThan(flush);
  expect(resolve).toBeGreaterThan(prepare);
  expect(permission).toBeGreaterThan(resolve);
  expect(sources).toBeGreaterThan(permission);
});

test("live controller owns one selected-source inventory per announced segment", async () => {
  const capture = await Bun.file(new URL("./Capture.swift", import.meta.url)).text();
  const canonicalization = capture.indexOf(
    "selectedSourceInventory = try CaptureControllerRequestlessObject(",
  );
  const startedInventory = capture.indexOf(
    '"sources": try selectedSourceInventory.fields(),',
    canonicalization,
  );
  const activeOwnership = capture.indexOf(
    "selectedSources: selectedSourceInventory,",
    startedInventory,
  );
  const announcementCommit = capture.indexOf(
    "selectedSources = selectedSourceInventory",
    activeOwnership,
  );
  const completionInventory = capture.indexOf(
    '"sources": try segment.selectedSources.fields(),',
  );
  const statusInventory = capture.indexOf(
    '"sources": try selectedSources?.fields()',
  );

  expect(canonicalization).toBeGreaterThanOrEqual(0);
  expect(startedInventory).toBeGreaterThan(canonicalization);
  expect(activeOwnership).toBeGreaterThan(startedInventory);
  expect(announcementCommit).toBeGreaterThan(activeOwnership);
  expect(completionInventory).toBeGreaterThanOrEqual(0);
  expect(statusInventory).toBeGreaterThan(announcementCommit);
  expect(capture).not.toContain("configuredSources");
  expect(capture).not.toContain("segment.screen.audioSourcesJSON");
});
