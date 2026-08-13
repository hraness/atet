import { expect, test } from "bun:test";
import { parseCaptureEvent } from "./protocol";
import { runCaptureControllerFinalizationHarness } from "./build";

const harnessSource = String.raw`
import Foundation

enum HarnessFailure: Error {
    case assertion(String)
    case intentionalWriterFailure
}

final class AssertionCount: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func record() {
        lock.lock()
        stored += 1
        lock.unlock()
    }
}

let assertionCount = AssertionCount()

func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw HarnessFailure.assertion(message) }
    assertionCount.record()
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

    func advance(_ delta: UInt64 = 100) {
        lock.lock()
        stored += delta
        lock.unlock()
    }
}

final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func increment() {
        lock.lock()
        stored += 1
        lock.unlock()
    }
}

final class AsyncGate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if opened {
                lock.unlock()
                continuation.resume()
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func open() {
        lock.lock()
        guard !opened else {
            lock.unlock()
            return
        }
        opened = true
        let pending = waiters
        waiters.removeAll(keepingCapacity: false)
        lock.unlock()
        for waiter in pending {
            waiter.resume()
        }
    }
}

final class BatchAudit: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Data] = []

    var batchCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return stored.count
    }

    func append(_ batch: Data) {
        lock.lock()
        stored.append(batch)
        lock.unlock()
    }

    func base64Batches() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return stored.map { $0.base64EncodedString() }
    }
}

final class ReservationBag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [CaptureControllerDeliveryReservationResult] = []
    private var failures = 0

    func append(_ value: CaptureControllerDeliveryReservationResult) {
        lock.lock()
        stored.append(value)
        lock.unlock()
    }

    func appendFailure() {
        lock.lock()
        failures += 1
        lock.unlock()
    }

    var snapshot: (
        results: [CaptureControllerDeliveryReservationResult],
        failures: Int
    ) {
        lock.lock()
        defer { lock.unlock() }
        return (stored, failures)
    }
}

final class FailAfterBytesWriter: @unchecked Sendable {
    private let audit: BatchAudit

    init(audit: BatchAudit) {
        self.audit = audit
    }

    func write(_ batch: Data) throws {
        audit.append(batch)
        throw HarnessFailure.intentionalWriterFailure
    }
}

final class BlockingPartialFailureWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let release = DispatchSemaphore(value: 0)
    private var calls = 0
    private var partial = Data()

    var callCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return calls
    }

    var partialByteCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return partial.count
    }

    func write(_ batch: Data) throws {
        lock.lock()
        calls += 1
        let call = calls
        if call == 1 {
            partial = Data(batch.prefix(max(1, batch.count / 2)))
        }
        lock.unlock()
        if call == 1 {
            release.wait()
        }
        throw HarnessFailure.intentionalWriterFailure
    }

    func unblock() {
        release.signal()
    }
}

final class EmitterResultBag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [ProtocolEmitterBatchResult] = []

    func append(_ value: ProtocolEmitterBatchResult) {
        lock.lock()
        stored.append(value)
        lock.unlock()
    }

    var results: [ProtocolEmitterBatchResult] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

struct Fixture: Sendable {
    let engine: CaptureControllerFinalization
    let gate: CaptureSegmentCloseGate
    let timeline: CaptureTimeline
    let clock: ManualClock
    let scope: CaptureSegmentCloseScope
}

func waitUntil(
    _ message: String,
    maximumNanoseconds: UInt64 = 2_000_000_000,
    condition: @escaping @Sendable () -> Bool
) async throws {
    let started = DispatchTime.now().uptimeNanoseconds
    while !condition() {
        guard DispatchTime.now().uptimeNanoseconds - started
            < maximumNanoseconds else {
            throw HarnessFailure.assertion(message)
        }
        try await Task.sleep(nanoseconds: 100_000)
    }
}

func permissions() -> [String: Any] {
    [
        "accessibility": "authorized",
        "camera": "authorized",
        "inputMonitoring": "authorized",
        "microphone": "authorized",
        "screenCapture": "authorized",
        "systemAudio": "authorized",
        "windowMetadata": "authorized",
    ]
}

func displayGeometry() -> [String: Any] {
    [
        "bounds": [
            "height": 720.0,
            "width": 1_280.0,
            "x": 0.0,
            "y": 0.0,
        ],
        "displayId": "1",
        "isPrimary": true,
        "pixelHeight": 720,
        "pixelWidth": 1_280,
        "scaleFactor": 1.0,
    ]
}

func sources() -> [String: Any] {
    [
        "audio": [],
        "cameras": [],
        "displays": [
            [
                "bounds": [
                    "height": 720.0,
                    "width": 1_280.0,
                    "x": 0.0,
                    "y": 0.0,
                ],
                "displayId": "1",
                "isPrimary": true,
                "label": "Primary display",
                "pixelSize": [
                    "height": 720,
                    "width": 1_280,
                ],
                "refreshRateHz": 60.0,
                "scaleFactor": 1.0,
            ],
        ],
    ]
}

func timing(nativeStartUs: Int) -> [String: Any] {
    [
        "bufferCount": 10,
        "clockAnchors": [
            "end": [
                "nativeTimeUs": nativeStartUs + 1_000,
                "ptsUs": 1_000,
                "uncertaintyUs": 0,
            ],
            "first": [
                "nativeTimeUs": nativeStartUs,
                "ptsUs": 0,
                "uncertaintyUs": 0,
            ],
        ],
        "presentation": [
            "endPtsUs": 1_000,
            "firstPtsUs": 0,
            "lastPtsUs": 900,
            "maximumSampleDurationUs": 100,
        ],
        "sampleCount": 10,
    ]
}

func segmentFields(index: Int) throws -> CaptureControllerRequestlessObject {
    let nativeStartUs = 1_000_000 + index * 2_000
    return try CaptureControllerRequestlessObject([
        "camera": [
            "availability": "unavailable",
            "reason": "disabled",
        ],
        "clock": [
            "end": [
                "nativeTimeUs": nativeStartUs + 1_000,
                "sourceTimeUs": index * 1_000 + 1_000,
            ],
            "kind": "mach-continuous-microseconds",
            "start": [
                "nativeTimeUs": nativeStartUs,
                "sourceTimeUs": index * 1_000,
            ],
        ],
        "diagnostics": [],
        "displays": [
            [
                "container": "mp4",
                "containerDurationUs": 1_000,
                "display": displayGeometry(),
                "path": "segments/\(index)/display-1.mp4",
                "streams": [
                    [
                        "codec": "h264",
                        "mapping": "exact",
                        "role": "display-video",
                        "streamIndex": 0,
                        "timing": timing(nativeStartUs: nativeStartUs),
                    ],
                ],
            ],
        ],
        "index": index,
        "metadata": [],
        "microphone": [
            "availability": "unavailable",
            "reason": "disabled",
        ],
        "sources": sources(),
    ])
}

func startedFields(index: Int) throws -> CaptureControllerRequestlessObject {
    try CaptureControllerRequestlessObject([
        "index": index,
        "nativeStartUs": 1_000_000 + index * 2_000,
        "permissions": permissions(),
        "sources": sources(),
        "startUs": index * 1_000,
    ])
}

func statusFields(
    state: String,
    completed: Int
) throws -> CaptureControllerRequestlessObject {
    try CaptureControllerRequestlessObject([
        "activeSegmentIndex": NSNull(),
        "availableSources": sources(),
        "completedSegmentCount": completed,
        "lastInterruption": NSNull(),
        "logicalTimeUs": completed * 1_000,
        "permissions": permissions(),
        "sources": sources(),
        "state": state,
    ])
}

func completion(index: Int) -> CaptureControllerFinalizationOutcome {
    do {
        return .completion(CaptureControllerFinalizationCompletion(
            segment: try segmentFields(index: index)
        ))
    } catch {
        preconditionFailure("completion fixture is invalid")
    }
}

func failure(
    code: String,
    state: HelperState = .stopped
) -> CaptureControllerFinalizationFailure {
    do {
        return try CaptureControllerFinalizationFailure(
            code: code,
            message: code,
            recoverable: false,
            state: state
        )
    } catch {
        preconditionFailure("failure fixture is invalid")
    }
}

func preparedFixture(
    index: Int,
    drain: CaptureControllerPreparedStartDrain? = nil
) throws -> Fixture {
    let clock = ManualClock(UInt64(100_000 + index * 10_000))
    let timeline = CaptureTimeline(monotonicClock: { clock.read() })
    _ = try timeline.beginActive()
    let gate = CaptureSegmentCloseGate(timeline: timeline)
    let engine = CaptureControllerFinalization()
    let actualDrain = drain ?? CaptureControllerPreparedStartDrain(
        operation: { _ in
            failure(code: "prepared-start-closed", state: .ready)
        }
    )
    let scope = try engine.beginPreparedStart(
        gate: gate,
        segmentIndex: index,
        drain: actualDrain
    )
    return Fixture(
        engine: engine,
        gate: gate,
        timeline: timeline,
        clock: clock,
        scope: scope
    )
}

func protocolEmitter(_ audit: BatchAudit) -> ProtocolEmitter {
    ProtocolEmitter(lineWriter: { batch in audit.append(batch) })
}

func beginAnnouncement(
    _ fixture: Fixture,
    job: @escaping CaptureControllerFinalizationJob
) throws -> CaptureControllerStartAnnouncementToken {
    let result = try fixture.engine.beginStartAnnouncement(
        scope: fixture.scope,
        activeJob: job
    )
    guard case .began(let token) = result else {
        throw HarnessFailure.assertion("start announcement was not acquired")
    }
    return token
}

func emitStarted(
    _ fixture: Fixture,
    requestId: String,
    audit: BatchAudit
) throws {
    let result = protocolEmitter(audit).emitBatch([
        try startedFields(index: fixture.scope.segmentIndex)
            .protocolObject(event: "segment-started", requestId: requestId),
    ])
    try require(
        result == .confirmedNominal(eventCount: 1),
        "segment-started was not delivered nominally"
    )
}

func activate(
    _ fixture: Fixture,
    requestId: String,
    audit: BatchAudit,
    job: @escaping CaptureControllerFinalizationJob
) throws {
    let token = try beginAnnouncement(fixture, job: job)
    try emitStarted(fixture, requestId: requestId, audit: audit)
    let result = try fixture.engine.finishStartAnnouncement(
        token: token,
        disposition: .confirmed
    )
    try require(result == .activated, "announced start did not become active")
}

func interruptionSeed(_ fixture: Fixture) throws -> CaptureInterruptionSeed {
    fixture.clock.advance()
    return try CaptureInterruptionSeed(
        segmentIndex: fixture.scope.segmentIndex,
        incident: .screen(.streamStopped),
        sourceId: "display-1",
        nativeTimeUs: fixture.clock.read()
    )
}

func lease(
    _ result: CaptureControllerDeliveryReservationResult
) throws -> CaptureControllerDeliveryLease {
    guard case .reserved(let lease) = result else {
        throw HarnessFailure.assertion("delivery was not reserved")
    }
    return lease
}

func segmentEvent(
    _ reserved: CaptureControllerReservedFinalization,
    requestId: String
) throws -> [String: Any] {
    switch reserved.outcome {
    case .completion(let value):
        return [
            "event": "segment-completed",
            "interruption":
                (value.interruption?.json as Any?) ?? NSNull(),
            "requestId": requestId,
            "segment": try value.segment.fields(),
        ]
    case .failure(let value):
        return [
            "code": value.code,
            "event": "error",
            "interruption":
                (value.interruption?.json as Any?) ?? NSNull(),
            "message": value.message,
            "recoverable": value.recoverable,
            "requestId": requestId,
            "state": value.state.rawValue,
        ]
    }
}

func awaitOutcome(
    engine: CaptureControllerFinalization,
    lease: CaptureControllerDeliveryLease
) async throws -> CaptureControllerReservedFinalization {
    let result = await engine.awaitDelivery(lease)
    guard case .outcome(let reserved) = result else {
        throw HarnessFailure.assertion("reserved finalizer did not produce an outcome")
    }
    return reserved
}

func emitOrNoop(
    _ events: [[String: Any]],
    audit: BatchAudit
) -> ProtocolEmitterBatchResult {
    if events.isEmpty {
        return .confirmedNominal(eventCount: 0)
    }
    return protocolEmitter(audit).emitBatch(events)
}

func verifyStatusReservationWins(
    audit: BatchAudit
) async throws {
    let fixture = try preparedFixture(index: 0)
    try activate(
        fixture,
        requestId: "status-first-start",
        audit: audit,
        job: { _ in completion(index: 0) }
    )

    let firstLease = try lease(fixture.engine.reserveDelivery(.observe))
    let closeResult = try fixture.engine.acceptInterruption(
        scope: fixture.scope,
        seed: interruptionSeed(fixture)
    )
    guard case .launched = closeResult else {
        throw HarnessFailure.assertion("post-reservation interruption did not launch")
    }
    try require(
        await fixture.engine.awaitDelivery(firstLease) == .noOutcome,
        "status reservation retroactively captured a later interruption"
    )
    let status = try statusFields(state: "paused", completed: 0)
        .protocolObject(event: "status", requestId: "status-first")
    try require(
        protocolEmitter(audit).emitBatch([status])
            == .confirmedNominal(eventCount: 1),
        "status-only batch failed"
    )
    try require(
        try fixture.engine.completeDelivery(
            firstLease,
            disposition: .confirmed
        ) == .confirmed,
        "status-only delivery did not commit"
    )

    let secondLease = try lease(fixture.engine.reserveDelivery(.observe))
    let reserved = try await awaitOutcome(
        engine: fixture.engine,
        lease: secondLease
    )
    let events = [
        try segmentEvent(reserved, requestId: "status-second"),
        try statusFields(state: "paused", completed: 1)
            .protocolObject(event: "status", requestId: "status-second"),
    ]
    try require(
        protocolEmitter(audit).emitBatch(events)
            == .confirmedNominal(eventCount: 2),
        "deferred outcome/status batch failed"
    )
    try require(
        try fixture.engine.completeDelivery(
            secondLease,
            disposition: .confirmed
        ) == .confirmed,
        "deferred status delivery did not commit"
    )
    try require(fixture.engine.phase == .none, "confirmed outcome was not cleared")
    guard case .alreadyDeferred = try fixture.engine.requestClose(
        scope: fixture.scope,
        reason: .stop
    ) else {
        throw HarnessFailure.assertion("closed generation tombstone was forgotten")
    }
    assertionCount.record()
}

func verifyInterruptionReservationWins(
    audit: BatchAudit
) async throws {
    let fixture = try preparedFixture(index: 1)
    try activate(
        fixture,
        requestId: "incident-first-start",
        audit: audit,
        job: { _ in completion(index: 1) }
    )
    guard case .launched = try fixture.engine.acceptInterruption(
        scope: fixture.scope,
        seed: interruptionSeed(fixture)
    ) else {
        throw HarnessFailure.assertion("interruption did not launch")
    }
    let deliveryLease = try lease(fixture.engine.reserveDelivery(.observe))
    let reserved = try await awaitOutcome(
        engine: fixture.engine,
        lease: deliveryLease
    )
    let events = [
        try segmentEvent(reserved, requestId: "incident-first"),
        try statusFields(state: "paused", completed: 1)
            .protocolObject(event: "status", requestId: "incident-first"),
    ]
    try require(
        protocolEmitter(audit).emitBatch(events)
            == .confirmedNominal(eventCount: 2),
        "incident-first outcome was not emitted atomically"
    )
    try require(
        try fixture.engine.completeDelivery(
            deliveryLease,
            disposition: .confirmed
        ) == .confirmed,
        "incident-first delivery did not commit"
    )
}

func verifyAnnouncementRaces(
    audit: BatchAudit
) async throws {
    let pre = try preparedFixture(index: 2)
    let preRuns = LockedCounter()
    let preToken = try beginAnnouncement(pre, job: { _ in
        preRuns.increment()
        return completion(index: 2)
    })
    guard case .queuedDuringAnnouncement = try pre.engine.acceptInterruption(
        scope: pre.scope,
        seed: interruptionSeed(pre)
    ) else {
        throw HarnessFailure.assertion("pre-write incident was not queued")
    }
    guard case .queuedDuringAnnouncement = try pre.engine.requestClose(
        scope: pre.scope,
        reason: .pause
    ) else {
        throw HarnessFailure.assertion("pre-write requested close did not join the queue")
    }
    assertionCount.record()
    try require(pre.engine.phase == .announcing, "pre-write incident escaped announcement")
    try require(preRuns.value == 0, "active finalizer ran before started delivery")
    let preLease = try lease(pre.engine.reserveDelivery(.observe))
    try require(
        pre.engine.reserveDelivery(.observe) == .busy,
        "incident-first announcement outcome was not reserved exclusively"
    )
    let pendingAnnouncementWaiter = Task {
        await pre.engine.awaitDelivery(preLease)
    }
    pendingAnnouncementWaiter.cancel()
    for _ in 0..<16 {
        await Task.yield()
    }
    try require(
        pre.engine.phase == .announcing && preRuns.value == 0,
        "cancelled announcement waiter escaped the blocked writer boundary"
    )
    try emitStarted(pre, requestId: "announce-pre", audit: audit)
    guard case .finalizing = try pre.engine.finishStartAnnouncement(
        token: preToken,
        disposition: .confirmed
    ) else {
        throw HarnessFailure.assertion("queued pre-write incident did not finalize after delivery")
    }
    guard case .outcome(let preOutcome) = await pendingAnnouncementWaiter.value else {
        throw HarnessFailure.assertion(
            "cancelled announcement waiter did not rejoin settlement"
        )
    }
    assertionCount.record()
    try require(preRuns.value == 1, "pre-write incident did not run exactly once")
    try require(
        protocolEmitter(audit).emitBatch([
            try segmentEvent(preOutcome, requestId: "announce-pre-close"),
        ]) == .confirmedNominal(eventCount: 1),
        "pre-write close event failed"
    )
    try require(
        try pre.engine.completeDelivery(preLease, disposition: .confirmed)
            == .confirmed,
        "pre-write close was not committed"
    )

    let observeFirst = try preparedFixture(index: 14)
    let observeFirstRuns = LockedCounter()
    let observeFirstToken = try beginAnnouncement(observeFirst, job: { _ in
        observeFirstRuns.increment()
        return completion(index: 14)
    })
    let noOutcomeLease = try lease(
        observeFirst.engine.reserveDelivery(.observe)
    )
    guard case .queuedDuringAnnouncement = try observeFirst.engine
        .acceptInterruption(
            scope: observeFirst.scope,
            seed: interruptionSeed(observeFirst)
        ) else {
        throw HarnessFailure.assertion("observe-first incident was not queued")
    }
    try require(
        observeFirst.engine.reserveDelivery(.observe) == .busy,
        "observe-first announcement allowed another delivery owner"
    )
    try emitStarted(
        observeFirst,
        requestId: "announce-observe-first",
        audit: audit
    )
    guard case .finalizing = try observeFirst.engine
        .finishStartAnnouncement(
            token: observeFirstToken,
            disposition: .confirmed
        ) else {
        throw HarnessFailure.assertion("observe-first incident did not finalize")
    }
    try require(
        await observeFirst.engine.awaitDelivery(noOutcomeLease) == .noOutcome,
        "observe-first reservation captured a later announcement incident"
    )
    try require(
        try observeFirst.engine.completeDelivery(
            noOutcomeLease,
            disposition: .confirmed
        ) == .confirmed,
        "observe-first no-outcome boundary did not commit"
    )
    let laterLease = try lease(
        observeFirst.engine.reserveDelivery(.observe)
    )
    let laterOutcome = try await awaitOutcome(
        engine: observeFirst.engine,
        lease: laterLease
    )
    try require(
        observeFirstRuns.value == 1,
        "observe-first incident did not run exactly once"
    )
    try require(
        protocolEmitter(audit).emitBatch([
            try segmentEvent(
                laterOutcome,
                requestId: "announce-observe-first-close"
            ),
        ]) == .confirmedNominal(eventCount: 1),
        "observe-first deferred outcome was not deliverable later"
    )
    try require(
        try observeFirst.engine.completeDelivery(
            laterLease,
            disposition: .confirmed
        ) == .confirmed,
        "observe-first deferred outcome did not commit"
    )

    let post = try preparedFixture(index: 3)
    let postRuns = LockedCounter()
    let postToken = try beginAnnouncement(post, job: { _ in
        postRuns.increment()
        return completion(index: 3)
    })
    try emitStarted(post, requestId: "announce-post", audit: audit)
    try require(
        try post.engine.finishStartAnnouncement(
            token: postToken,
            disposition: .confirmed
        ) == .activated,
        "post-write start did not activate"
    )
    guard case .launched = try post.engine.acceptInterruption(
        scope: post.scope,
        seed: interruptionSeed(post)
    ) else {
        throw HarnessFailure.assertion("post-write incident did not launch")
    }
    let postLease = try lease(post.engine.reserveDelivery(.observe))
    let postOutcome = try await awaitOutcome(engine: post.engine, lease: postLease)
    try require(postRuns.value == 1, "post-write finalizer did not run exactly once")
    try require(
        protocolEmitter(audit).emitBatch([
            try segmentEvent(postOutcome, requestId: "announce-post-close"),
        ]) == .confirmedNominal(eventCount: 1),
        "post-write close event failed"
    )
    try require(
        try post.engine.completeDelivery(postLease, disposition: .confirmed)
            == .confirmed,
        "post-write close was not committed"
    )

    let rejectedRuns = LockedCounter()
    let rejected = try preparedFixture(
        index: 4,
        drain: CaptureControllerPreparedStartDrain(operation: { _ in
            rejectedRuns.increment()
            return failure(code: "start-rejected", state: .ready)
        })
    )
    let rejectedToken = try beginAnnouncement(
        rejected,
        job: { _ in completion(index: 4) }
    )
    guard case .finalizing = try rejected.engine.finishStartAnnouncement(
        token: rejectedToken,
        disposition: .rejectedBeforeWrite
    ) else {
        throw HarnessFailure.assertion("rejected start did not drain")
    }
    let rejectedLease = try lease(rejected.engine.reserveDelivery(.observe))
    let rejectedOutcome = try await awaitOutcome(
        engine: rejected.engine,
        lease: rejectedLease
    )
    try require(rejectedRuns.value == 1, "rejected start drain did not run once")
    guard case .failure(let rejectedFailure) = rejectedOutcome.outcome else {
        throw HarnessFailure.assertion("rejected start did not preserve failure")
    }
    try require(rejectedFailure.code == "start-rejected", "wrong rejected-start failure")
    try require(
        try rejected.engine.completeDelivery(
            rejectedLease,
            disposition: .rejectedBeforeWrite
        ) == .releasedPreservingEvidence,
        "pre-write rejection did not preserve deferred evidence"
    )
    let retryLease = try lease(rejected.engine.reserveDelivery(.observe))
    _ = try await awaitOutcome(engine: rejected.engine, lease: retryLease)
    try require(
        try rejected.engine.completeDelivery(
            retryLease,
            disposition: .confirmed
        ) == .confirmed,
        "preserved pre-write outcome could not be delivered later"
    )

    let uncertainDrainRuns = LockedCounter()
    let uncertain = try preparedFixture(
        index: 13,
        drain: CaptureControllerPreparedStartDrain(operation: { _ in
            uncertainDrainRuns.increment()
            return failure(code: "start-write-uncertain", state: .ready)
        })
    )
    let uncertainToken = try beginAnnouncement(
        uncertain,
        job: { _ in completion(index: 13) }
    )
    let terminationLease = try lease(
        uncertain.engine.reserveDelivery(.termination(scope: uncertain.scope))
    )
    guard case .deliveryUncertain = try uncertain.engine
        .finishStartAnnouncement(
            token: uncertainToken,
            disposition: .uncertainPartialOrWriterFailure
        ) else {
        throw HarnessFailure.assertion("uncertain start write did not fail closed")
    }
    guard case .deliveryUncertain = await uncertain.engine.awaitDelivery(
        terminationLease
    ) else {
        throw HarnessFailure.assertion("termination lease did not join uncertain start drain")
    }
    assertionCount.record()
    try require(
        uncertainDrainRuns.value == 1,
        "uncertain start drain did not run exactly once"
    )
    let beforeUncertainTermination = audit.batchCount
    try require(
        try uncertain.engine.completeDelivery(
            terminationLease,
            disposition: .terminationDiscard
        ) == .discarded,
        "termination stranded an uncertain announcement lease"
    )
    try require(
        audit.batchCount == beforeUncertainTermination,
        "uncertain announcement termination wrote stdout"
    )
    try require(
        uncertain.engine.phase == .none,
        "uncertain announcement evidence was not discarded"
    )
}

func verifyEmitterPoison() async throws {
    let writer = BlockingPartialFailureWriter()
    let emitter = ProtocolEmitter(lineWriter: { batch in
        try writer.write(batch)
    })
    let first = Task {
        emitter.emit([
            "event": "shutdown",
            "requestId": "poison-first",
        ])
    }
    try await waitUntil(
        "partial writer was never entered",
        condition: { writer.callCount == 1 }
    )
    try require(
        writer.partialByteCount > 0,
        "failing writer did not retain partial bytes"
    )

    let concurrent = EmitterResultBag()
    await withTaskGroup(of: Void.self) { group in
        for index in 0..<32 {
            group.addTask {
                concurrent.append(emitter.emit([
                    "event": "shutdown",
                    "requestId": "poison-concurrent-\(index)",
                ]))
            }
        }
        writer.unblock()
        await group.waitForAll()
    }

    try require(
        await first.value == .uncertainWriterFailure,
        "partial writer failure was not uncertain"
    )
    let results = concurrent.results
    try require(results.count == 32, "concurrent poison results were lost")
    try require(
        results.allSatisfy { $0 == .uncertainWriterFailure },
        "a concurrent emission escaped the poisoned writer"
    )
    try require(
        emitter.emitBatch([]) == .uncertainWriterFailure,
        "poisoned empty batch reported a false success"
    )
    try require(
        emitter.error(
            requestId: "poison-error",
            failure: HelperFailure(
                code: "poisoned",
                message: "poisoned",
                recoverable: false
            ),
            state: .shuttingDown
        ) == .uncertainWriterFailure,
        "poisoned error path did not report uncertainty"
    )
    try require(
        emitter.emit([
            "event": "shutdown",
            "requestId": "poison-after",
        ]) == .uncertainWriterFailure,
        "subsequent emit escaped the poisoned writer"
    )
    try require(
        writer.callCount == 1,
        "poisoned emitter called the writer after a partial failure"
    )
}

func verifyUncertainWriterAndTermination(
    audit: BatchAudit
) async throws {
    let fixture = try preparedFixture(index: 5)
    try activate(
        fixture,
        requestId: "uncertain-start",
        audit: audit,
        job: { _ in completion(index: 5) }
    )
    guard case .launched = try fixture.engine.requestClose(
        scope: fixture.scope,
        reason: .pause
    ) else {
        throw HarnessFailure.assertion("uncertain writer fixture did not close")
    }
    let deliveryLease = try lease(fixture.engine.reserveDelivery(.observe))
    let reserved = try await awaitOutcome(
        engine: fixture.engine,
        lease: deliveryLease
    )
    let partialAudit = BatchAudit()
    let failingWriter = FailAfterBytesWriter(audit: partialAudit)
    let result = ProtocolEmitter(lineWriter: { batch in
        try failingWriter.write(batch)
    }).emitBatch([
        try segmentEvent(reserved, requestId: "uncertain-write"),
    ])
    try require(result == .uncertainWriterFailure, "throwing writer was not uncertain")
    try require(partialAudit.batchCount == 1, "writer did not record bytes before failure")
    for batch in partialAudit.base64Batches() {
        guard let data = Data(base64Encoded: batch) else {
            throw HarnessFailure.assertion("partial audit was not base64")
        }
        audit.append(data)
    }
    try require(
        try fixture.engine.completeDelivery(
            deliveryLease,
            disposition: .uncertainPartialOrWriterFailure
        ) == .enteredDeliveryUncertain,
        "writer failure did not retain uncertain evidence"
    )
    guard case .deliveryUncertain = try fixture.engine.reserveDelivery(.observe) else {
        throw HarnessFailure.assertion("uncertain outcome was retryable")
    }
    assertionCount.record()

    let terminationLease = try lease(
        fixture.engine.reserveDelivery(.termination(scope: nil))
    )
    guard case .deliveryUncertain = await fixture.engine.awaitDelivery(
        terminationLease
    ) else {
        throw HarnessFailure.assertion("termination did not observe uncertain evidence")
    }
    assertionCount.record()
    let beforeTermination = audit.batchCount
    try require(
        try fixture.engine.completeDelivery(
            terminationLease,
            disposition: .terminationDiscard
        ) == .discarded,
        "termination did not discard uncertain evidence"
    )
    try require(
        audit.batchCount == beforeTermination,
        "termination emitted synthetic stdout"
    )
    try require(fixture.engine.phase == .none, "termination did not clear uncertainty")
}

func verifyEmptyNoopsAndResumePreparation(
    audit: BatchAudit
) async throws {
    let engine = CaptureControllerFinalization()
    let beforePause = audit.batchCount
    let pauseLease = try lease(engine.reserveDelivery(.observe))
    let foreignEngine = CaptureControllerFinalization()
    let foreignLease = try lease(foreignEngine.reserveDelivery(.observe))
    try require(
        await foreignEngine.awaitDelivery(pauseLease) == .invalidLease,
        "delivery lease crossed engine identity"
    )
    try require(
        await engine.awaitDelivery(foreignLease) == .invalidLease,
        "foreign delivery lease matched a local token counter"
    )
    try require(
        try foreignEngine.completeDelivery(
            foreignLease,
            disposition: .confirmed
        ) == .confirmed,
        "foreign identity fixture did not release"
    )
    try require(
        await engine.awaitDelivery(pauseLease) == .noOutcome,
        "empty pause unexpectedly owned an outcome"
    )
    try require(
        emitOrNoop([], audit: audit) == .confirmedNominal(eventCount: 0),
        "empty pause was not a successful no-op"
    )
    try require(audit.batchCount == beforePause, "empty pause invoked the writer")
    try require(
        try engine.completeDelivery(pauseLease, disposition: .confirmed)
            == .confirmed,
        "empty pause lease did not release"
    )

    let resumeLease = try lease(engine.reserveDelivery(.flush))
    try require(
        await engine.awaitDelivery(resumeLease) == .noOutcome,
        "empty resume unexpectedly owned an outcome"
    )
    try require(
        emitOrNoop([], audit: audit) == .confirmedNominal(eventCount: 0),
        "empty resume was not a successful no-op"
    )
    try require(
        try engine.completeDelivery(resumeLease, disposition: .confirmed)
            == .confirmed,
        "empty resume lease did not release"
    )

    // No suspension is permitted between the confirmed old-generation commit
    // and this synchronous preparation of the resumed segment.
    let clock = ManualClock(900_000)
    let timeline = CaptureTimeline(monotonicClock: { clock.read() })
    _ = try timeline.beginActive()
    let gate = CaptureSegmentCloseGate(timeline: timeline)
    let scope = try engine.beginPreparedStart(
        gate: gate,
        segmentIndex: 6,
        drain: CaptureControllerPreparedStartDrain(operation: { _ in
            failure(code: "resume-terminated", state: .ready)
        })
    )
    try require(engine.phase == .prepared, "resume did not prepare synchronously")

    let terminationLease = try lease(
        engine.reserveDelivery(.termination(scope: scope))
    )
    _ = try await awaitOutcome(engine: engine, lease: terminationLease)
    let beforeTermination = audit.batchCount
    try require(
        try engine.completeDelivery(
            terminationLease,
            disposition: .terminationDiscard
        ) == .discarded,
        "prepared resume did not terminate silently"
    )
    try require(
        audit.batchCount == beforeTermination,
        "prepared termination wrote stdout"
    )
}

func verifyStaleTerminationScopeDrainsCurrentGeneration(
    audit: BatchAudit
) async throws {
    let fixture = try preparedFixture(index: 15)
    try activate(
        fixture,
        requestId: "stale-termination-old-start",
        audit: audit,
        job: { _ in completion(index: 15) }
    )
    fixture.clock.advance()
    let oldLease = try lease(fixture.engine.reserveDelivery(.close(
        scope: fixture.scope,
        reason: .pause
    )))
    _ = try await awaitOutcome(engine: fixture.engine, lease: oldLease)
    try require(
        try fixture.engine.completeDelivery(
            oldLease,
            disposition: .confirmed
        ) == .confirmed,
        "old generation did not commit before resume"
    )

    fixture.clock.advance()
    _ = try fixture.timeline.beginActive()
    let resumedDrainRuns = LockedCounter()
    let resumedScope = try fixture.engine.beginPreparedStart(
        gate: fixture.gate,
        segmentIndex: 16,
        drain: CaptureControllerPreparedStartDrain(operation: { _ in
            resumedDrainRuns.increment()
            return failure(code: "resumed-termination", state: .ready)
        })
    )
    let terminationLease = try lease(
        fixture.engine.reserveDelivery(.termination(scope: fixture.scope))
    )
    let terminated = try await awaitOutcome(
        engine: fixture.engine,
        lease: terminationLease
    )
    try require(
        terminated.close.scope == resumedScope,
        "stale termination scope did not resolve the current generation"
    )
    guard case .requested(.termination) = terminated.close.cause else {
        throw HarnessFailure.assertion("current generation used the wrong close cause")
    }
    assertionCount.record()
    try require(
        resumedDrainRuns.value == 1,
        "stale-scope termination did not drain the resumed recorder"
    )
    let beforeDiscard = audit.batchCount
    try require(
        try fixture.engine.completeDelivery(
            terminationLease,
            disposition: .terminationDiscard
        ) == .discarded,
        "stale-scope termination did not discard current evidence"
    )
    try require(
        audit.batchCount == beforeDiscard,
        "stale-scope termination emitted stdout"
    )
    try require(
        fixture.engine.phase == .none,
        "stale-scope termination stranded resumed ownership"
    )
}

func verifyReservationExclusivity(
    audit: BatchAudit
) async throws {
    let fixture = try preparedFixture(index: 7)
    try activate(
        fixture,
        requestId: "exclusive-start",
        audit: audit,
        job: { _ in completion(index: 7) }
    )
    let bag = ReservationBag()
    await withTaskGroup(of: Void.self) { group in
        for _ in 0..<64 {
            group.addTask {
                do {
                    bag.append(try fixture.engine.reserveDelivery(.observe))
                } catch {
                    bag.appendFailure()
                }
            }
        }
    }
    let snapshot = bag.snapshot
    try require(snapshot.failures == 0, "concurrent reservations threw")
    let leases = snapshot.results.compactMap { result -> CaptureControllerDeliveryLease? in
        guard case .reserved(let lease) = result else { return nil }
        return lease
    }
    let busyCount = snapshot.results.filter { $0 == .busy }.count
    try require(leases.count == 1, "more than one command owned delivery")
    try require(busyCount == 63, "losing reservations were not typed busy")
    guard let owner = leases.first else {
        throw HarnessFailure.assertion("exclusive lease was missing")
    }
    try require(
        await fixture.engine.awaitDelivery(owner) == .noOutcome,
        "exclusive active reservation unexpectedly owned an outcome"
    )
    try require(
        try fixture.engine.completeDelivery(
            owner,
            disposition: .rejectedBeforeWrite
        ) == .releasedPreservingEvidence,
        "pre-write release failed"
    )
    let next = try lease(fixture.engine.reserveDelivery(.observe))
    try require(
        try fixture.engine.completeDelivery(next, disposition: .confirmed)
            == .confirmed,
        "released reservation remained busy"
    )

    let termination = try lease(
        fixture.engine.reserveDelivery(.termination(scope: fixture.scope))
    )
    _ = try await awaitOutcome(engine: fixture.engine, lease: termination)
    try require(
        try fixture.engine.completeDelivery(
            termination,
            disposition: .terminationDiscard
        ) == .discarded,
        "exclusive fixture did not terminate"
    )
}

func verifyRequestedCloseLease(
    audit: BatchAudit
) async throws {
    let fixture = try preparedFixture(index: 12)
    try activate(
        fixture,
        requestId: "requested-close-start",
        audit: audit,
        job: { _ in completion(index: 12) }
    )
    fixture.clock.advance()
    let closeLease = try lease(fixture.engine.reserveDelivery(.close(
        scope: fixture.scope,
        reason: .stop
    )))
    try require(
        fixture.engine.reserveDelivery(.observe) == .busy,
        "requested close did not reserve delivery atomically"
    )
    let reserved = try await awaitOutcome(
        engine: fixture.engine,
        lease: closeLease
    )
    try require(
        protocolEmitter(audit).emitBatch([
            try segmentEvent(reserved, requestId: "requested-close"),
        ]) == .confirmedNominal(eventCount: 1),
        "requested-close outcome was not deliverable"
    )
    try require(
        try fixture.engine.completeDelivery(
            closeLease,
            disposition: .confirmed
        ) == .confirmed,
        "requested-close delivery did not commit"
    )
}

func verifyMismatchAndCancellation(
    audit: BatchAudit
) async throws {
    let mismatchGate = AsyncGate()
    let mismatch = try preparedFixture(index: 8)
    try activate(
        mismatch,
        requestId: "mismatch-start",
        audit: audit,
        job: { _ in
            await mismatchGate.wait()
            return completion(index: 8)
        }
    )
    guard case .launched = try mismatch.engine.requestClose(
        scope: mismatch.scope,
        reason: .pause
    ) else {
        throw HarnessFailure.assertion("mismatch finalizer did not launch")
    }
    guard case .retired = mismatch.gate.retire(scope: mismatch.scope) else {
        throw HarnessFailure.assertion("harness could not force retirement mismatch")
    }
    let mismatchLease = try lease(mismatch.engine.reserveDelivery(.observe))
    mismatchGate.open()
    let mismatchOutcome = try await awaitOutcome(
        engine: mismatch.engine,
        lease: mismatchLease
    )
    guard case .failure(let mismatchFailure) = mismatchOutcome.outcome else {
        throw HarnessFailure.assertion("retirement mismatch was not failed closed")
    }
    try require(
        mismatchFailure.code == "finalization-retirement-mismatch",
        "retirement mismatch failure code changed"
    )
    try require(
        try mismatch.engine.completeDelivery(
            mismatchLease,
            disposition: .confirmed
        ) == .confirmed,
        "mismatch evidence did not commit"
    )

    let cancellationGate = AsyncGate()
    let runs = LockedCounter()
    let cancellation = try preparedFixture(index: 9)
    try activate(
        cancellation,
        requestId: "cancel-start",
        audit: audit,
        job: { _ in
            runs.increment()
            await cancellationGate.wait()
            return completion(index: 9)
        }
    )
    guard case .launched = try cancellation.engine.acceptInterruption(
        scope: cancellation.scope,
        seed: interruptionSeed(cancellation)
    ) else {
        throw HarnessFailure.assertion("cancellation finalizer did not launch")
    }
    let cancellationLease = try lease(
        cancellation.engine.reserveDelivery(.observe)
    )
    let waiter = Task {
        await cancellation.engine.awaitDelivery(cancellationLease)
    }
    waiter.cancel()
    cancellationGate.open()
    guard case .outcome = await waiter.value else {
        throw HarnessFailure.assertion("cancelled waiter abandoned shared drain")
    }
    assertionCount.record()
    try require(runs.value == 1, "caller cancellation duplicated finalization")
    try require(
        try cancellation.engine.completeDelivery(
            cancellationLease,
            disposition: .confirmed
        ) == .confirmed,
        "cancelled waiter could not commit shared outcome"
    )
}

func verifyScopeAndValueValidation(
    audit: BatchAudit
) async throws {
    do {
        _ = try CaptureControllerRequestlessObject([
            "event": "segment-completed",
        ])
        throw HarnessFailure.assertion("requestless value accepted envelope fields")
    } catch CaptureControllerFinalizationError.invalidRequestlessObject {
        assertionCount.record()
    }
    do {
        _ = try CaptureControllerFinalizationFailure(
            code: "bad code",
            message: "bad",
            recoverable: false,
            state: .stopped
        )
        throw HarnessFailure.assertion("failure accepted invalid code")
    } catch CaptureControllerFinalizationError.invalidFailureCode {
        assertionCount.record()
    }

    let owned = try preparedFixture(index: 10)
    let foreign = try preparedFixture(index: 11)
    guard case .stale(let activeScope) = try owned.engine.requestClose(
        scope: foreign.scope,
        reason: .stop
    ) else {
        throw HarnessFailure.assertion("cross-gate scope was not stale")
    }
    try require(activeScope == owned.scope, "stale result hid active scope")

    let ownedToken = try beginAnnouncement(
        owned,
        job: { _ in completion(index: 10) }
    )
    try emitStarted(owned, requestId: "scope-owned", audit: audit)
    try require(
        try owned.engine.finishStartAnnouncement(
            token: ownedToken,
            disposition: .confirmed
        ) == .activated,
        "owned scope did not activate"
    )
    let ownedTermination = try lease(
        owned.engine.reserveDelivery(.termination(scope: owned.scope))
    )
    _ = try await awaitOutcome(engine: owned.engine, lease: ownedTermination)
    try require(
        try owned.engine.completeDelivery(
            ownedTermination,
            disposition: .terminationDiscard
        ) == .discarded,
        "owned scope did not terminate"
    )

    let foreignTermination = try lease(
        foreign.engine.reserveDelivery(.termination(scope: foreign.scope))
    )
    _ = try await awaitOutcome(engine: foreign.engine, lease: foreignTermination)
    try require(
        try foreign.engine.completeDelivery(
            foreignTermination,
            disposition: .terminationDiscard
        ) == .discarded,
        "foreign fixture did not terminate"
    )

    let fallback = protocolEmitter(audit).emitBatch([
        [
            "event": "status",
            "requestId": "bounded-fallback",
            "invalid": NSObject(),
        ],
    ])
    try require(
        fallback == .confirmedBoundedFallback(.invalidOrOversizedEvent),
        "invalid batch did not produce a confirmed bounded fallback"
    )
    let emptyAudit = BatchAudit()
    try require(
        protocolEmitter(emptyAudit).emitBatch([])
            == .confirmedNominal(eventCount: 0),
        "empty emitter batch was not a no-op"
    )
    try require(emptyAudit.batchCount == 0, "empty emitter batch called writer")
}

@main
struct HarnessMain {
    static func main() async throws {
        let audit = BatchAudit()
        try await verifyStatusReservationWins(audit: audit)
        try await verifyInterruptionReservationWins(audit: audit)
        try await verifyAnnouncementRaces(audit: audit)
        try await verifyEmitterPoison()
        try await verifyUncertainWriterAndTermination(audit: audit)
        try await verifyEmptyNoopsAndResumePreparation(audit: audit)
        try await verifyStaleTerminationScopeDrainsCurrentGeneration(
            audit: audit
        )
        try await verifyReservationExclusivity(audit: audit)
        try await verifyRequestedCloseLease(audit: audit)
        try await verifyMismatchAndCancellation(audit: audit)
        try await verifyScopeAndValueValidation(audit: audit)

        let report: [String: Any] = [
            "assertions": assertionCount.value,
            "batches": audit.base64Batches(),
            "finalPhase": CaptureControllerFinalizationPhase.none.rawValue,
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

test("capture finalization leases serialize announcement, outcome, and delivery ownership", async () => {
  if (process.platform !== "darwin") return;

  const { stderr, stdout } = await runCaptureControllerFinalizationHarness(harnessSource);
  const report = JSON.parse(stdout) as {
    assertions: number;
    batches: string[];
    finalPhase: string;
  };

  let parsedLineCount = 0;
  for (const encoded of report.batches) {
    const batch = Buffer.from(encoded, "base64").toString("utf8");
    for (const line of batch.split("\n").filter(Boolean)) {
      parseCaptureEvent(JSON.parse(line) as unknown);
      parsedLineCount += 1;
    }
  }

  expect(report.assertions).toBeGreaterThanOrEqual(50);
  expect(report.batches.length).toBeGreaterThanOrEqual(12);
  expect(parsedLineCount).toBeGreaterThanOrEqual(14);
  expect(report.finalPhase).toBe("none");
  expect(stderr).toContain("stdout protocol write failed");
  expect(stderr).toContain("bounded failure");
}, 60_000);
