import { expect, test } from "bun:test";
import { runCaptureControllerFinalizationHarness } from "./build";

const harnessSource = String.raw`
import CoreGraphics
import Foundation

enum HarnessFailure: Error {
    case assertion(String)
}

final class SendableIdentity: NSObject, @unchecked Sendable {}

func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw HarnessFailure.assertion(message) }
}

func waitForSemaphore(
    _ semaphore: DispatchSemaphore,
    timeout: DispatchTimeInterval
) async -> DispatchTimeoutResult {
    await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            continuation.resume(
                returning: semaphore.wait(
                    timeout: DispatchTime.now() + timeout
                )
            )
        }
    }
}

func waitForGroup(
    _ group: DispatchGroup,
    timeout: DispatchTimeInterval
) async -> DispatchTimeoutResult {
    await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            continuation.resume(
                returning: group.wait(
                    timeout: DispatchTime.now() + timeout
                )
            )
        }
    }
}

final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64

    init(_ value: UInt64) {
        self.value = value
    }

    func read() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func advance(_ delta: UInt64) {
        lock.lock()
        value += delta
        lock.unlock()
    }
}

final class SeedAudit: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [CaptureInterruptionSeed] = []
    private var storedActions: [String] = []

    func append(_ seed: CaptureInterruptionSeed) {
        lock.lock()
        stored.append(seed)
        lock.unlock()
    }

    func action(_ value: String) {
        lock.lock()
        storedActions.append(value)
        lock.unlock()
    }

    var seeds: [CaptureInterruptionSeed] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    var actions: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storedActions
    }
}

final class OutputAudit: @unchecked Sendable {
    private let lock = NSLock()
    private var writes: [Data] = []

    func append(_ data: Data) {
        lock.lock()
        writes.append(data)
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return writes.count
    }
}

final class FakeNotifications: @unchecked Sendable {
    typealias Handler = CaptureNotificationObservationSource.Handler

    private let lock = NSLock()
    private var handlers: [
        Notification.Name: [UUID: Handler]
    ] = [:]
    private var removals = 0

    func source() -> CaptureNotificationObservationSource {
        CaptureNotificationObservationSource { [weak self] name, handler in
            guard let self else {
                return CaptureInterruptionObserverCancellation {}
            }
            let identifier = UUID()
            self.lock.lock()
            self.handlers[name, default: [:]][identifier] = handler
            self.lock.unlock()
            return CaptureInterruptionObserverCancellation { [weak self] in
                guard let self else { return }
                self.lock.lock()
                if self.handlers[name]?.removeValue(
                    forKey: identifier
                ) != nil {
                    self.removals += 1
                }
                self.lock.unlock()
            }
        }
    }

    func post(_ name: Notification.Name, object: AnyObject) {
        lock.lock()
        let snapshot = Array(handlers[name, default: [:]].values)
        lock.unlock()
        let notification = Notification(name: name, object: object)
        for handler in snapshot {
            handler(notification)
        }
    }

    var removalCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return removals
    }
}

final class FakeDisplayCallbacks: @unchecked Sendable {
    private let lock = NSLock()
    private var handler:
        CaptureDisplayReconfigurationSource.Handler?
    private var removals = 0

    func source() -> CaptureDisplayReconfigurationSource {
        CaptureDisplayReconfigurationSource { [weak self] handler in
            guard let self else {
                return CaptureInterruptionObserverCancellation {}
            }
            self.lock.lock()
            self.handler = handler
            self.lock.unlock()
            return CaptureInterruptionObserverCancellation { [weak self] in
                guard let self else { return }
                self.lock.lock()
                if self.handler != nil {
                    self.removals += 1
                }
                self.handler = nil
                self.lock.unlock()
            }
        }
    }

    func send(
        _ displayId: CGDirectDisplayID,
        _ flags: CGDisplayChangeSummaryFlags
    ) {
        lock.lock()
        let current = handler
        lock.unlock()
        current?(displayId, flags)
    }

    var removalCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return removals
    }
}

final class BlockingDisplayProvider: @unchecked Sendable {
    private let lock = NSLock()
    private var active: Set<CGDirectDisplayID>?
    private let blockedCall: Int?
    private var calls = 0
    private var concurrent = 0
    private var maximumConcurrent = 0
    let blockedEntered = DispatchSemaphore(value: 0)
    let releaseBlocked = DispatchSemaphore(value: 0)

    init(
        active: Set<CGDirectDisplayID>?,
        blockedCall: Int? = nil
    ) {
        self.active = active
        self.blockedCall = blockedCall
    }

    func read() -> Set<CGDirectDisplayID>? {
        lock.lock()
        calls += 1
        concurrent += 1
        maximumConcurrent = max(maximumConcurrent, concurrent)
        let call = calls
        let snapshot = active
        lock.unlock()
        if let blockedCall, call == blockedCall {
            blockedEntered.signal()
            _ = releaseBlocked.wait(timeout: .now() + 5)
        }
        lock.lock()
        concurrent -= 1
        lock.unlock()
        return snapshot
    }

    func update(_ value: Set<CGDirectDisplayID>?) {
        lock.lock()
        active = value
        lock.unlock()
    }

    func waitForBlockedComparison() async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning:
                    self.blockedEntered.wait(
                        timeout: .now() + 5
                    ) == .success
                )
            }
        }
    }

    var counts: (calls: Int, maximumConcurrent: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (calls, maximumConcurrent)
    }
}

func failure(
    close: CaptureSegmentClose,
    code: String,
    sourceFrontierUs: UInt64
) -> CaptureControllerFinalizationFailure {
    do {
        let interruption = try close.resolvedUnpersistedInterruption(
            sourceFrontierUs: sourceFrontierUs
        )
        return try CaptureControllerFinalizationFailure(
            code: code,
            message: code,
            recoverable: interruption == nil,
            state: interruption == nil ? .paused : .stopped,
            interruption: interruption
        )
    } catch {
        preconditionFailure("Harness failure value was invalid.")
    }
}

func deliveryLease(
    _ result: CaptureControllerDeliveryReservationResult
) throws -> CaptureControllerDeliveryLease {
    guard case .reserved(let lease) = result else {
        throw HarnessFailure.assertion("delivery was not reserved")
    }
    return lease
}

func exerciseAVMapping(
    role: CaptureAVInterruptionRole,
    event: Int,
    expectedCode: String,
    names: CaptureAVInterruptionNotificationNames
) throws -> Int {
    let device = NSObject()
    let session = NSObject()
    let unrelated = NSObject()
    let notifications = FakeNotifications()
    let audit = SeedAudit()
    let reporter = CaptureInterruptionReporter(
        segmentIndex: event,
        clock: { UInt64(4_000 + event) },
        submit: { audit.append($0) }
    )
    let monitor = CaptureAVInterruptionMonitor(
        role: role,
        sourceId: "source-\(event)",
        device: device,
        session: session,
        reporter: reporter,
        observations: notifications.source(),
        names: names
    )
    monitor.startObserving()

    let name: Notification.Name
    let expectedObject: AnyObject
    let expectedCountBeforeExpectedObject: Int
    switch event % 4 {
    case 0:
        name = names.deviceDisconnected
        expectedObject = device
        expectedCountBeforeExpectedObject = 0
    case 1:
        name = names.sessionInterrupted
        expectedObject = session
        expectedCountBeforeExpectedObject = 0
    case 2:
        name = names.runtimeError
        expectedObject = session
        expectedCountBeforeExpectedObject = 0
    default:
        name = names.sessionStopped
        expectedObject = session
        expectedCountBeforeExpectedObject = 1
        notifications.post(name, object: session)
        try require(
            audit.seeds.isEmpty,
            "session stop reported before running was confirmed"
        )
        monitor.confirmRunning()
        try require(
            audit.seeds.map(\.incident.code) == [expectedCode],
            "pre-confirmation session stop was not replayed"
        )
    }
    notifications.post(name, object: unrelated)
    try require(
        audit.seeds.count == expectedCountBeforeExpectedObject,
        "AV monitor accepted an unrelated object"
    )
    notifications.post(name, object: expectedObject)
    try require(
        audit.seeds.map(\.incident.code) == [expectedCode],
        "AV notification mapped to the wrong interruption"
    )
    reporter.seal()
    try require(
        notifications.removalCount == 4,
        "AV observer teardown did not remove every registration"
    )
    notifications.post(name, object: expectedObject)
    try require(
        audit.seeds.count == 1,
        "sealed AV observer submitted another interruption"
    )
    return notifications.removalCount
}

@main
struct HarnessMain {
    static func main() async throws {
        let names = CaptureAVInterruptionNotificationNames(
            deviceDisconnected: Notification.Name("fake.device"),
            sessionInterrupted: Notification.Name("fake.interrupted"),
            runtimeError: Notification.Name("fake.runtime"),
            sessionStopped: Notification.Name("fake.stopped")
        )
        let cameraCodes = [
            "camera-device-disconnected",
            "camera-session-interrupted",
            "camera-runtime-error",
            "camera-session-stopped",
        ]
        let microphoneCodes = [
            "microphone-device-disconnected",
            "microphone-session-interrupted",
            "microphone-runtime-error",
            "microphone-session-stopped",
        ]
        var observerRemovals = 0
        for offset in 0..<4 {
            observerRemovals += try exerciseAVMapping(
                role: .camera,
                event: offset,
                expectedCode: cameraCodes[offset],
                names: names
            )
            observerRemovals += try exerciseAVMapping(
                role: .microphone,
                event: offset + 4,
                expectedCode: microphoneCodes[offset],
                names: names
            )
        }
        let avRaceIterations = 32
        for iteration in 0..<avRaceIterations {
            let raceDevice = SendableIdentity()
            let raceSession = SendableIdentity()
            let raceNotifications = FakeNotifications()
            let raceAudit = SeedAudit()
            let raceReporter = CaptureInterruptionReporter(
                segmentIndex: 16 + iteration,
                clock: { UInt64(4_100 + iteration) },
                submit: { raceAudit.append($0) }
            )
            let raceMonitor = CaptureAVInterruptionMonitor(
                role: .camera,
                sourceId: "race-\(iteration)",
                device: raceDevice,
                session: raceSession,
                reporter: raceReporter,
                observations: raceNotifications.source(),
                names: names
            )
            raceMonitor.startObserving()
            let raceStart = DispatchSemaphore(value: 0)
            let raceGroup = DispatchGroup()
            raceGroup.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                _ = raceStart.wait(timeout: .now() + 5)
                raceNotifications.post(
                    names.sessionStopped,
                    object: raceSession
                )
                raceGroup.leave()
            }
            raceGroup.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                _ = raceStart.wait(timeout: .now() + 5)
                raceMonitor.confirmRunning()
                raceGroup.leave()
            }
            raceStart.signal()
            raceStart.signal()
            try require(
                await waitForGroup(
                    raceGroup,
                    timeout: .seconds(5)
                ) == .success,
                "AV stop/confirmation race timed out"
            )
            try require(
                raceAudit.seeds.map(\.incident.code)
                    == ["camera-session-stopped"],
                "AV stop/confirmation race did not report exactly once"
            )
            raceReporter.seal()
            observerRemovals += raceNotifications.removalCount
        }

        let firstWinnerAudit = SeedAudit()
        let firstWinnerClock = ManualClock(5_000)
        let firstWinner = CaptureInterruptionReporter(
            segmentIndex: 9,
            clock: { firstWinnerClock.read() },
            submit: { firstWinnerAudit.append($0) }
        )
        try require(
            firstWinner.report(
                incident: .camera(.runtimeError),
                sourceId: "camera-a"
            ) == .submitted(firstWinnerAudit.seeds[0]),
            "first interruption did not submit"
        )
        firstWinnerClock.advance(1)
        guard case .alreadyReported(let winner) = firstWinner.report(
            incident: .microphone(.sessionInterrupted),
            sourceId: "microphone-b"
        ) else {
            throw HarnessFailure.assertion(
                "cascading interruption was not suppressed"
            )
        }
        try require(
            winner.incident.code == "camera-runtime-error"
                && firstWinnerAudit.seeds.count == 1,
            "first interruption did not remain the winner"
        )

        let teardownAudit = SeedAudit()
        firstWinner.registerObserverTeardown {
            teardownAudit.action("removed")
        }
        firstWinner.seal()
        firstWinner.seal()
        try require(
            teardownAudit.actions == ["removed"],
            "reporter observer teardown was not exactly once"
        )

        let sealJoinAudit = SeedAudit()
        let sealJoinReporter = CaptureInterruptionReporter(
            segmentIndex: 48,
            clock: { 5_500 },
            submit: { _ in }
        )
        let initialTeardownEntered = DispatchSemaphore(value: 0)
        let releaseInitialTeardown = DispatchSemaphore(value: 0)
        sealJoinReporter.registerObserverTeardown {
            sealJoinAudit.action("initial-entered")
            initialTeardownEntered.signal()
            _ = releaseInitialTeardown.wait(timeout: .now() + 5)
            sealJoinAudit.action("initial-finished")
        }
        let firstSealDone = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            switch sealJoinReporter.seal() {
            case .sealed:
                sealJoinAudit.action("first-sealed")
            case .alreadySealed:
                sealJoinAudit.action("first-was-not-owner")
            }
            firstSealDone.signal()
        }
        try require(
            await waitForSemaphore(
                initialTeardownEntered,
                timeout: .seconds(5)
            ) == .success,
            "first seal did not enter teardown"
        )

        let secondSealStarted = DispatchSemaphore(value: 0)
        let secondSealDone = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            secondSealStarted.signal()
            switch sealJoinReporter.seal() {
            case .sealed:
                sealJoinAudit.action("second-became-owner")
            case .alreadySealed:
                sealJoinAudit.action("second-joined")
            }
            secondSealDone.signal()
        }
        try require(
            await waitForSemaphore(
                secondSealStarted,
                timeout: .seconds(5)
            ) == .success,
            "second seal did not start"
        )
        try require(
            await waitForSemaphore(
                secondSealDone,
                timeout: .milliseconds(100)
            ) == .timedOut,
            "concurrent seal returned before teardown"
        )

        let lateTeardownEntered = DispatchSemaphore(value: 0)
        let releaseLateTeardown = DispatchSemaphore(value: 0)
        let lateRegistrationDone = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            let registered = sealJoinReporter.registerObserverTeardown {
                sealJoinAudit.action("late-entered")
                lateTeardownEntered.signal()
                _ = releaseLateTeardown.wait(timeout: .now() + 5)
                sealJoinAudit.action("late-finished")
            }
            sealJoinAudit.action(
                registered ? "late-registered" : "late-joined"
            )
            lateRegistrationDone.signal()
        }
        try require(
            await waitForSemaphore(
                lateRegistrationDone,
                timeout: .seconds(5)
            ) == .success
                && sealJoinAudit.actions.contains("late-registered"),
            "teardown registration did not enter the sealer-owned queue"
        )
        releaseInitialTeardown.signal()
        try require(
            await waitForSemaphore(
                lateTeardownEntered,
                timeout: .seconds(5)
            ) == .success,
            "sealer did not drain a registration accepted while sealing"
        )
        let earlyFirstSeal = await waitForSemaphore(
            firstSealDone,
            timeout: .milliseconds(100)
        )
        let earlySecondSeal = await waitForSemaphore(
            secondSealDone,
            timeout: .milliseconds(100)
        )
        try require(
            earlyFirstSeal == .timedOut
                && earlySecondSeal == .timedOut,
            "seal callers did not join late teardown"
        )
        releaseLateTeardown.signal()
        let settledFirstSeal = await waitForSemaphore(
            firstSealDone,
            timeout: .seconds(5)
        )
        let settledSecondSeal = await waitForSemaphore(
            secondSealDone,
            timeout: .seconds(5)
        )
        try require(
            settledFirstSeal == .success
                && settledSecondSeal == .success,
            "joined seal teardown did not settle"
        )
        let sealJoinActions = sealJoinAudit.actions
        guard let lateFinished = sealJoinActions.firstIndex(
            of: "late-finished"
        ),
        let firstSealed = sealJoinActions.firstIndex(of: "first-sealed"),
        let secondJoined = sealJoinActions.firstIndex(of: "second-joined")
        else {
            throw HarnessFailure.assertion(
                "seal join results were not authoritative"
            )
        }
        try require(
            lateFinished < firstSealed
                && lateFinished < secondJoined
                && sealJoinActions.contains("late-registered")
                && !sealJoinActions.contains("first-was-not-owner")
                && !sealJoinActions.contains("second-became-owner"),
            "seal callers returned before joined teardown completed"
        )

        let sealedAudit = SeedAudit()
        let sealedReporter = CaptureInterruptionReporter(
            segmentIndex: 10,
            clock: { 6_000 },
            submit: { sealedAudit.append($0) }
        )
        sealedReporter.seal()
        guard case .sealed = sealedReporter.report(
            incident: .screen(.streamStopped),
            sourceId: "1"
        ) else {
            throw HarnessFailure.assertion(
                "sealed reporter accepted a callback"
            )
        }
        try require(
            sealedAudit.seeds.isEmpty,
            "seal-before-callback did not suppress submission"
        )

        let prelookupAudit = SeedAudit()
        let prelookupContext =
            try CaptureDisplayReconfigurationCallbackContext { _, _ in
                prelookupAudit.action("invoked")
            }
        let prelookupEntered = DispatchSemaphore(value: 0)
        let releasePrelookup = DispatchSemaphore(value: 0)
        let prelookupFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            // Models a callback that entered CoreGraphics before removal but
            // has not yet executed its first Swift registry lookup.
            prelookupEntered.signal()
            _ = releasePrelookup.wait(timeout: .now() + 5)
            captureDisplayReconfigurationCallback(
                displayId: 99,
                flags: .removeFlag,
                userInfo: prelookupContext.userInfo
            )
            prelookupFinished.signal()
        }
        try require(
            await waitForSemaphore(
                prelookupEntered,
                timeout: .seconds(5)
            ) == .success,
            "pre-lookup callback did not enter"
        )
        prelookupContext.deactivateAndDrain()
        releasePrelookup.signal()
        let prelookupSettlement = await waitForSemaphore(
            prelookupFinished,
            timeout: .seconds(5)
        )
        try require(
            prelookupSettlement == .success
                && prelookupAudit.actions.isEmpty,
            "post-removal callback dereferenced reclaimed context"
        )

        let inFlightAudit = SeedAudit()
        let inFlightEntered = DispatchSemaphore(value: 0)
        let releaseInFlight = DispatchSemaphore(value: 0)
        let inFlightContext =
            try CaptureDisplayReconfigurationCallbackContext { _, _ in
                inFlightAudit.action("entered")
                inFlightEntered.signal()
                _ = releaseInFlight.wait(timeout: .now() + 5)
                inFlightAudit.action("finished")
            }
        let inFlightCallbackDone = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            captureDisplayReconfigurationCallback(
                displayId: 98,
                flags: .removeFlag,
                userInfo: inFlightContext.userInfo
            )
            inFlightCallbackDone.signal()
        }
        try require(
            await waitForSemaphore(
                inFlightEntered,
                timeout: .seconds(5)
            ) == .success,
            "in-flight callback did not enter its handler"
        )
        let drainStarted = DispatchSemaphore(value: 0)
        let drainFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            drainStarted.signal()
            inFlightContext.deactivateAndDrain()
            inFlightAudit.action("drained")
            drainFinished.signal()
        }
        try require(
            await waitForSemaphore(
                drainStarted,
                timeout: .seconds(5)
            ) == .success,
            "callback drain did not start"
        )
        try require(
            await waitForSemaphore(
                drainFinished,
                timeout: .milliseconds(100)
            ) == .timedOut,
            "callback context drained before its entered callback"
        )
        releaseInFlight.signal()
        let callbackSettlement = await waitForSemaphore(
            inFlightCallbackDone,
            timeout: .seconds(5)
        )
        let drainSettlement = await waitForSemaphore(
            drainFinished,
            timeout: .seconds(5)
        )
        try require(
            callbackSettlement == .success
                && drainSettlement == .success,
            "callback entry drain did not settle"
        )
        captureDisplayReconfigurationCallback(
            displayId: 98,
            flags: .removeFlag,
            userInfo: inFlightContext.userInfo
        )
        try require(
            inFlightAudit.actions == ["entered", "finished", "drained"],
            "drained callback context accepted a later callback"
        )

        let callbackReuseCycles = maximumCaptureSegments * 2
        for _ in 0..<callbackReuseCycles {
            let context =
                try CaptureDisplayReconfigurationCallbackContext { _, _ in }
            context.deactivateAndDrain()
        }
        var retainedCallbackContexts:
            [CaptureDisplayReconfigurationCallbackContext] = []
        retainedCallbackContexts.reserveCapacity(maximumCaptureSegments)
        for _ in 0..<maximumCaptureSegments {
            retainedCallbackContexts.append(
                try CaptureDisplayReconfigurationCallbackContext { _, _ in }
            )
        }
        do {
            _ = try CaptureDisplayReconfigurationCallbackContext { _, _ in }
            throw HarnessFailure.assertion(
                "retained callback capacity was not bounded"
            )
        } catch CaptureDisplayInterruptionMonitorError.callbackCapacityExceeded {
            // A failed CoreGraphics removal retains its registry entry. New
            // registration fails explicitly once that process-wide bound is
            // full rather than leaking without limit or reusing an identity.
        }
        for context in retainedCallbackContexts {
            context.deactivateAndDrain()
        }
        let postCapacityContext =
            try CaptureDisplayReconfigurationCallbackContext { _, _ in }
        postCapacityContext.deactivateAndDrain()

        let selectedDisplays = [
            CaptureSelectedDisplayIdentity(
                displayId: 30,
                isPrimary: false
            ),
            CaptureSelectedDisplayIdentity(
                displayId: 20,
                isPrimary: true
            ),
            CaptureSelectedDisplayIdentity(
                displayId: 10,
                isPrimary: false
            ),
        ]

        let initialDisplayAudit = SeedAudit()
        let initialDisplayReporter = CaptureInterruptionReporter(
            segmentIndex: 11,
            clock: { 7_000 },
            submit: { initialDisplayAudit.append($0) }
        )
        let initialDisplayCallbacks = FakeDisplayCallbacks()
        let initialDisplayProvider = BlockingDisplayProvider(active: [])
        let initialDisplayMonitor = CaptureDisplayInterruptionMonitor(
            selected: selectedDisplays,
            reporter: initialDisplayReporter,
            source: initialDisplayCallbacks.source(),
            activeDisplays: { initialDisplayProvider.read() }
        )
        try initialDisplayMonitor.startObserving()
        await initialDisplayMonitor.flush()
        try require(
            initialDisplayAudit.seeds.map(\.sourceId) == ["20"]
                && initialDisplayProvider.counts.calls == 1,
            "initial display reconciliation missed a selected display"
        )
        initialDisplayCallbacks.send(20, .beginConfigurationFlag)
        await initialDisplayMonitor.flush()
        try require(
            initialDisplayProvider.counts.calls == 1,
            "begin display callback performed discovery"
        )
        initialDisplayReporter.seal()

        let cascadeDisplayAudit = SeedAudit()
        let cascadeDisplayReporter = CaptureInterruptionReporter(
            segmentIndex: 12,
            clock: { 7_100 },
            submit: { cascadeDisplayAudit.append($0) }
        )
        let cascadeDisplayCallbacks = FakeDisplayCallbacks()
        let cascadeDisplayProvider = BlockingDisplayProvider(
            active: Set([10, 20, 30]),
            blockedCall: 2
        )
        let cascadeDisplayMonitor = CaptureDisplayInterruptionMonitor(
            selected: selectedDisplays,
            reporter: cascadeDisplayReporter,
            source: cascadeDisplayCallbacks.source(),
            activeDisplays: { cascadeDisplayProvider.read() }
        )
        try cascadeDisplayMonitor.startObserving()
        await cascadeDisplayMonitor.flush()
        cascadeDisplayCallbacks.send(20, .beginConfigurationFlag)
        await cascadeDisplayMonitor.flush()
        try require(
            cascadeDisplayProvider.counts.calls == 1,
            "begin callback changed the initial comparison count"
        )
        cascadeDisplayProvider.update([])
        cascadeDisplayCallbacks.send(0, [])
        try require(
            await cascadeDisplayProvider.waitForBlockedComparison(),
            "display comparison did not start"
        )
        cascadeDisplayCallbacks.send(0, [])
        cascadeDisplayCallbacks.send(0, [])
        cascadeDisplayProvider.releaseBlocked.signal()
        await cascadeDisplayMonitor.flush()
        try require(
            cascadeDisplayAudit.seeds.map(\.sourceId) == ["20"],
            "missing display selection was not primary-then-ID"
        )
        try require(
            cascadeDisplayProvider.counts.calls == 3
                && cascadeDisplayProvider.counts.maximumConcurrent == 1,
            "display callbacks were not serial and coalesced"
        )
        cascadeDisplayReporter.seal()

        let reconnectDisplayAudit = SeedAudit()
        let reconnectDisplayReporter = CaptureInterruptionReporter(
            segmentIndex: 13,
            clock: { 7_200 },
            submit: { reconnectDisplayAudit.append($0) }
        )
        let reconnectDisplayCallbacks = FakeDisplayCallbacks()
        let reconnectDisplayProvider = BlockingDisplayProvider(
            active: Set([10, 20, 30])
        )
        let reconnectDisplayMonitor = CaptureDisplayInterruptionMonitor(
            selected: selectedDisplays,
            reporter: reconnectDisplayReporter,
            source: reconnectDisplayCallbacks.source(),
            activeDisplays: { reconnectDisplayProvider.read() }
        )
        try reconnectDisplayMonitor.startObserving()
        await reconnectDisplayMonitor.flush()
        reconnectDisplayProvider.update(Set([10, 20, 30]))
        reconnectDisplayCallbacks.send(30, .removeFlag)
        await reconnectDisplayMonitor.flush()
        try require(
            reconnectDisplayAudit.seeds.map(\.sourceId) == ["30"]
                && reconnectDisplayProvider.counts.calls == 1,
            "exact display removal was erased by a fast reconnect"
        )
        reconnectDisplayReporter.seal()

        let failedQueryDisplayAudit = SeedAudit()
        let failedQueryDisplayReporter = CaptureInterruptionReporter(
            segmentIndex: 14,
            clock: { 7_300 },
            submit: { failedQueryDisplayAudit.append($0) }
        )
        let failedQueryDisplayCallbacks = FakeDisplayCallbacks()
        let failedQueryDisplayProvider = BlockingDisplayProvider(
            active: Set([10, 20, 30])
        )
        let failedQueryDisplayMonitor = CaptureDisplayInterruptionMonitor(
            selected: selectedDisplays,
            reporter: failedQueryDisplayReporter,
            source: failedQueryDisplayCallbacks.source(),
            activeDisplays: { failedQueryDisplayProvider.read() }
        )
        try failedQueryDisplayMonitor.startObserving()
        await failedQueryDisplayMonitor.flush()
        failedQueryDisplayProvider.update(nil)
        failedQueryDisplayCallbacks.send(10, .removeFlag)
        await failedQueryDisplayMonitor.flush()
        try require(
            failedQueryDisplayAudit.seeds.map(\.sourceId) == ["10"]
                && failedQueryDisplayProvider.counts.calls == 1,
            "exact display removal was erased by a failed topology query"
        )
        failedQueryDisplayReporter.seal()

        let displayRemovalCount =
            initialDisplayCallbacks.removalCount
            + cascadeDisplayCallbacks.removalCount
            + reconnectDisplayCallbacks.removalCount
            + failedQueryDisplayCallbacks.removalCount
        try require(
            displayRemovalCount == 4,
            "display callback registrations were not removed exactly once"
        )
        failedQueryDisplayCallbacks.send(10, .removeFlag)
        await failedQueryDisplayMonitor.flush()
        try require(
            failedQueryDisplayAudit.seeds.count == 1,
            "sealed display callback submitted another interruption"
        )

        let barrierAudit = SeedAudit()
        let barrierReporter = CaptureInterruptionReporter(
            segmentIndex: 15,
            clock: { 8_000 },
            submit: {
                barrierAudit.action("submit")
                barrierAudit.append($0)
            }
        )
        let publication = capturePublishTerminalBeforeInterruption(
            publish: {
                barrierAudit.action("barrier")
                return true
            },
            reporter: barrierReporter,
            incident: .screen(.recordingFailed),
            sourceId: "40"
        )
        guard case .published = publication else {
            throw HarnessFailure.assertion(
                "terminal publication was rejected"
            )
        }
        try require(
            barrierAudit.actions == ["barrier", "submit"],
            "terminal barrier did not publish before submit"
        )

        let outputAudit = OutputAudit()
        let emitter = ProtocolEmitter(lineWriter: {
            outputAudit.append($0)
        })
        let closeClock = ManualClock(9_000)
        let closeTimeline = CaptureTimeline(
            monotonicClock: { closeClock.read() }
        )
        let closeInterval = try closeTimeline.beginPreparedActive()
        let closeGate = CaptureSegmentCloseGate(timeline: closeTimeline)
        let closeEngine = CaptureControllerFinalization()
        let closeScope = try closeEngine.beginPreparedStart(
            gate: closeGate,
            segmentIndex: 13,
            drain: CaptureControllerPreparedStartDrain(
                operation: { close in
                    _ = closeTimeline.discardPreparedInterval(
                        closeInterval,
                        closedAt: close.stamp
                    )
                    return failure(
                        close: close,
                        code: "native-interruption",
                        sourceFrontierUs:
                            closeInterval.start.sourceTimeUs
                    )
                }
            )
        )
        closeClock.advance(25)
        let closeReporter = CaptureInterruptionReporter(
            segmentIndex: 13,
            clock: { closeClock.read() },
            submit: { [weak closeEngine] seed in
                _ = try? closeEngine?.acceptInterruption(
                    scope: closeScope,
                    seed: seed
                )
            }
        )
        _ = closeReporter.report(
            incident: .screen(.streamStopped),
            sourceId: "50"
        )
        try require(
            outputAudit.count == 0,
            "native callback wrote stdout before a request"
        )
        let closeLease = try deliveryLease(
            closeEngine.reserveDelivery(.observe)
        )
        guard case .outcome(let closeOutcome) =
            await closeEngine.awaitDelivery(closeLease),
              case .failure(let closeFailure) = closeOutcome.outcome,
              let interruption = closeFailure.interruption else {
            throw HarnessFailure.assertion(
                "interruption outcome was not delivered"
            )
        }
        try require(
            interruption.nativeTimeUs == closeOutcome.close.stamp.nativeTimeUs
                && interruption.sourceTimeUs
                    == closeInterval.start.sourceTimeUs
                && interruption.sourceTimeUs
                    != closeOutcome.close.stamp.sourceTimeUs
                && interruption.segmentIndex == 13,
            "unpersisted interruption did not retain native incident time "
                + "at the persisted source frontier"
        )
        try require(
            !interruption.recoverable
                && !closeFailure.recoverable
                && closeFailure.state == .stopped,
            "unpersisted interruption failure was not fatal"
        )
        _ = emitter.error(
            requestId: "status-after-interruption",
            failure: HelperFailure(
                code: closeFailure.code,
                message: closeFailure.message,
                recoverable: closeFailure.recoverable
            ),
            state: closeFailure.state,
            interruption: interruption
        )
        try require(
            outputAudit.count == 1,
            "request-owned delivery did not write exactly once"
        )

        let manualClock = ManualClock(10_000)
        let manualTimeline = CaptureTimeline(
            monotonicClock: { manualClock.read() }
        )
        let manualInterval = try manualTimeline.beginPreparedActive()
        let manualGate = CaptureSegmentCloseGate(timeline: manualTimeline)
        let manualEngine = CaptureControllerFinalization()
        let manualScope = try manualEngine.beginPreparedStart(
            gate: manualGate,
            segmentIndex: 14,
            drain: CaptureControllerPreparedStartDrain(
                operation: { close in
                    _ = manualTimeline.discardPreparedInterval(
                        manualInterval,
                        closedAt: close.stamp
                    )
                    return failure(
                        close: close,
                        code: "manual-close",
                        sourceFrontierUs:
                            manualInterval.start.sourceTimeUs
                    )
                }
            )
        )
        manualClock.advance(10)
        _ = try manualEngine.requestClose(
            scope: manualScope,
            reason: .pause
        )
        let manualReporter = CaptureInterruptionReporter(
            segmentIndex: 14,
            clock: { manualClock.read() },
            submit: { [weak manualEngine] seed in
                _ = try? manualEngine?.acceptInterruption(
                    scope: manualScope,
                    seed: seed
                )
            }
        )
        _ = manualReporter.report(
            incident: .camera(.runtimeError),
            sourceId: "camera-manual-race"
        )
        let manualLease = try deliveryLease(
            manualEngine.reserveDelivery(.observe)
        )
        guard case .outcome(let manualOutcome) =
            await manualEngine.awaitDelivery(manualLease),
              case .failure(let manualFailure) = manualOutcome.outcome else {
            throw HarnessFailure.assertion(
                "manual race outcome was not delivered"
            )
        }
        try require(
            manualFailure.interruption == nil,
            "late native callback replaced the manual close"
        )
        try require(
            manualFailure.recoverable
                && manualFailure.state == .paused,
            "requested close inherited fatal interruption semantics"
        )

        let activeFailureClock = ManualClock(11_000)
        let activeFailureTimeline = CaptureTimeline(
            monotonicClock: { activeFailureClock.read() }
        )
        let persistedInterval =
            try activeFailureTimeline.beginPreparedActive()
        activeFailureClock.advance(40)
        _ = try activeFailureTimeline.endActive()
        try require(
            activeFailureTimeline.commitPreparedInterval(
                persistedInterval
            ) == .committed,
            "persisted prefix did not commit"
        )
        let unpersistedInterval =
            try activeFailureTimeline.beginPreparedActive()
        try require(
            activeFailureTimeline.commitPreparedInterval(
                unpersistedInterval
            ) == .committed,
            "active failed interval did not commit its announcement"
        )
        let activeFailureGate = CaptureSegmentCloseGate(
            timeline: activeFailureTimeline
        )
        let activeFailureScope = try activeFailureGate.arm(
            segmentIndex: 15
        )
        activeFailureClock.advance(20)
        let activeFailureSeed = try CaptureInterruptionSeed(
            segmentIndex: 15,
            incident: .screen(.recordingFailed),
            sourceId: "active-display",
            nativeTimeUs: activeFailureClock.read()
        )
        guard case .accepted(let activeFailureClose) =
            try activeFailureGate.claimInterruption(
                scope: activeFailureScope,
                seed: activeFailureSeed
            ) else {
            throw HarnessFailure.assertion(
                "active interruption did not own the close"
            )
        }
        let activeFailure = failure(
            close: activeFailureClose,
            code: "active-finalization-failed",
            sourceFrontierUs:
                unpersistedInterval.start.sourceTimeUs
        )
        try require(
            activeFailureClose.stamp.sourceTimeUs == 60
                && activeFailure.interruption?.nativeTimeUs
                    == activeFailureClose.stamp.nativeTimeUs
                && activeFailure.interruption?.sourceTimeUs == 40
                && activeFailure.interruption?.recoverable == false
                && !activeFailure.recoverable
                && activeFailure.state == HelperState.stopped,
            "active unpersisted failure did not roll back to the "
                + "persisted bundle frontier"
        )

        let report: [String: Any] = [
            "avMappings": cameraCodes.count + microphoneCodes.count,
            "avRaces": avRaceIterations,
            "callbackBarriers": 2,
            "callbackReuseCycles": callbackReuseCycles,
            "displayComparisons":
                initialDisplayProvider.counts.calls
                + cascadeDisplayProvider.counts.calls
                + reconnectDisplayProvider.counts.calls
                + failedQueryDisplayProvider.counts.calls,
            "firstWinner": winner.incident.code,
            "observerRemovals": observerRemovals
                + displayRemovalCount,
            "stdoutWrites": outputAudit.count,
        ]
        let data = try JSONSerialization.data(
            withJSONObject: report,
            options: [.sortedKeys]
        )
        print(String(decoding: data, as: UTF8.self))
    }
}
`;

test(
  "native interruption reporters and observers are deterministic and request-owned",
  async () => {
    if (process.platform !== "darwin") return;

    const result = await runCaptureControllerFinalizationHarness(harnessSource);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      avMappings: 8,
      avRaces: 32,
      callbackBarriers: 2,
      callbackReuseCycles: 256,
      displayComparisons: 6,
      firstWinner: "camera-runtime-error",
      observerRemovals: 164,
      stdoutWrites: 1,
    });
  },
  90_000,
);

test("native recorder callbacks stay behind the interruption boundary", async () => {
  const captureSource = await Bun.file(
    new URL("./Capture.swift", import.meta.url),
  ).text();
  const mediaSource = await Bun.file(
    new URL("./MediaCapture.swift", import.meta.url),
  ).text();

  expect(mediaSource).not.toContain("ProtocolEmitter");
  expect(mediaSource).toContain("capturePublishTerminalBeforeInterruption(");
  expect(mediaSource).toContain("interruptionMonitor.startObserving()");
  expect(mediaSource).toContain("self.interruptionMonitor.confirmRunning()");
  expect(mediaSource).toContain("interruptionReporter.seal()");

  const preparedScope = captureSource.indexOf(
    "scope = try finalization.beginPreparedStart(",
  );
  const reporterCreation = captureSource.indexOf(
    "let interruptionReporter = CaptureInterruptionReporter(",
  );
  const reporterInstall = captureSource.indexOf(
    "reporterRegistration.install(interruptionReporter)",
  );
  expect(preparedScope).toBeGreaterThan(-1);
  expect(reporterCreation).toBeGreaterThan(preparedScope);
  expect(reporterInstall).toBeGreaterThan(reporterCreation);
});
