import { expect, test } from "bun:test";
import { runCaptureControllerFinalizationHarness } from "./build";

const harnessSource = String.raw`
import Foundation

enum HarnessFailure: Error {
    case assertion(String)
}

enum TypedFailure: Error, Equatable, Sendable {
    case code(Int)
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw HarnessFailure.assertion(message) }
}

final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    @discardableResult
    func increment() -> Int {
        lock.lock()
        stored += 1
        let value = stored
        lock.unlock()
        return value
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
                return
            }
            waiters.append(continuation)
            lock.unlock()
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

final class TimeoutAudit: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [CaptureBoundedCallbackTimeout] = []

    var values: [CaptureBoundedCallbackTimeout] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func append(_ timeout: CaptureBoundedCallbackTimeout) {
        lock.lock()
        stored.append(timeout)
        lock.unlock()
    }
}

final class FailClosedAudit: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [CaptureCleanupFailClosedIncident] = []

    var values: [CaptureCleanupFailClosedIncident] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func append(_ incident: CaptureCleanupFailClosedIncident) {
        lock.lock()
        stored.append(incident)
        lock.unlock()
    }
}

func waitUntil(
    _ message: String,
    maximumNanoseconds: UInt64 = 2_000_000_000,
    condition: @escaping @Sendable () -> Bool
) async throws {
    let started = DispatchTime.now().uptimeNanoseconds
    while !condition() {
        guard DispatchTime.now().uptimeNanoseconds - started < maximumNanoseconds else {
            throw HarnessFailure.assertion(message)
        }
        try await Task.sleep(nanoseconds: 100_000)
    }
}

func requireSuccess(
    _ result: Result<Int, TypedFailure>,
    equals expected: Int,
    _ message: String
) throws {
    guard case .success(let value) = result, value == expected else {
        throw HarnessFailure.assertion(message)
    }
}

func blockForever() -> Never {
    DispatchSemaphore(value: 0).wait()
    fatalError("An intentionally blocking native side effect returned.")
}

func requireExit70Child(
    argument: String,
    expectedReason: String,
    label: String
) throws {
    let process = Process()
    process.executableURL = URL(
        fileURLWithPath: CommandLine.arguments[0]
    )
    process.arguments = [argument]
    process.standardInput = FileHandle.nullDevice
    let standardOutput = Pipe()
    let standardError = Pipe()
    process.standardOutput = standardOutput
    process.standardError = standardError
    try process.run()
    process.waitUntilExit()
    let output = standardOutput.fileHandleForReading.readDataToEndOfFile()
    let diagnostic = standardError.fileHandleForReading.readDataToEndOfFile()
    try require(process.terminationReason == .exit, "\(label) child was signaled")
    try require(process.terminationStatus == 70, "\(label) child did not exit 70")
    try require(output.isEmpty, "\(label) child wrote to protocol stdout")
    try require(
        diagnostic.count <= 1_024,
        "\(label) diagnostic exceeded its byte bound"
    )
    try require(
        String(data: diagnostic, encoding: .utf8)?
            .contains(expectedReason) == true,
        "\(label) diagnostic omitted \(expectedReason)"
    )
}

@main
struct RecorderSingleFlightHarness {
    static func main() async throws {
        if CommandLine.arguments.dropFirst() == [
            "--exercise-late-terminal-immediate-exit-70",
        ] {
            let lease = CaptureRecordingCleanupLease(
                subject: "late terminal child"
            )
            _ = lease.sealFailedStart(
                recordingOutputRemovalSucceeded: true,
                nativeMediaEvidence: false,
                fileEvidence: false
            )
            let incident = lease.observeRecordingFinalization()
            guard capturePassImmediateFailClosedGate(
                incident,
                action: captureExit70AfterCleanupFailure
            ) else {
                fatalError("The late-terminal fail-closed action returned.")
            }
            blockForever()
        }

        if CommandLine.arguments.dropFirst() == [
            "--exercise-late-start-before-blocking-stop-exit-70",
        ] {
            let lease = CaptureRecordingCleanupLease(
                subject: "late start child"
            )
            _ = lease.sealFailedStart(
                recordingOutputRemovalSucceeded: true,
                nativeMediaEvidence: false,
                fileEvidence: false
            )
            let incident = lease.observeRecordingStart()
            guard capturePassImmediateFailClosedGate(
                incident,
                action: captureExit70AfterCleanupFailure
            ) else {
                fatalError("The late-start fail-closed action returned.")
            }
            // Models an injected output.stopRecording() that never returns.
            blockForever()
        }

        if CommandLine.arguments.dropFirst() == [
            "--exercise-session-stop-watchdog-exit-70",
        ] {
            let watchdog = CaptureProcessDeadlineWatchdog(
                label: "hung camera session stop",
                timeoutNanoseconds: 5_000_000,
                timeoutAction: { timeout in
                    captureExit70AfterCleanupFailure(
                        CaptureCleanupFailClosedIncident(
                            kind: .sessionStopTimeout,
                            subject: timeout.label,
                            detail: "Intentional synchronous-stop watchdog verification."
                        )
                    )
                }
            )
            watchdog.arm()
            blockForever()
        }

        if CommandLine.arguments.dropFirst() == [
            "--exercise-session-start-watchdog-exit-70",
        ] {
            let watchdog = CaptureProcessDeadlineWatchdog(
                label: "hung camera session start",
                timeoutNanoseconds: 5_000_000,
                timeoutAction: { timeout in
                    captureExit70AfterCleanupFailure(
                        CaptureCleanupFailClosedIncident(
                            kind: .sessionStartTimeout,
                            subject: timeout.label,
                            detail: "Intentional synchronous-start watchdog verification."
                        )
                    )
                }
            )
            watchdog.arm()
            try await Task.sleep(nanoseconds: 60_000_000_000)
            fatalError("The synchronous-start watchdog returned.")
        }

        if CommandLine.arguments.dropFirst() == [
            "--exercise-start-timeout-exit-70",
        ] {
            let _: CaptureBoundedCallbackWaitResult<
                Void,
                CaptureNativeStartCallbackFailure
            > = await CaptureBoundedCallbackWaiter.wait(
                label: "missing start callback",
                timeoutNanoseconds: 5_000_000,
                timeoutAction: { timeout in
                    captureExit70AfterCleanupFailure(
                        CaptureCleanupFailClosedIncident(
                            kind: .streamStartTimeout,
                            subject: timeout.label,
                            detail: "Intentional missing-start-callback verification."
                        )
                    )
                },
                start: { _ in
                    // Deliberately never resolves.
                }
            )
            fatalError("The missing start callback returned to the helper.")
        }

        if CommandLine.arguments.dropFirst() == ["--exercise-exit-70"] {
            captureExit70AfterCleanupFailure(
                CaptureCleanupFailClosedIncident(
                    kind: .muxFinalizationTimeout,
                    subject: "subprocess display",
                    detail: "Intentional exit-policy verification."
                )
            )
            fatalError("The process fail-closed action returned.")
        }

        var cases: [String] = []

        // Sixty-four simultaneous callers and a late caller share one launch.
        let successFlight = CaptureSingleFlight<Int, TypedFailure>()
        let successCalls = LockedCounter()
        let successGate = AsyncGate()
        let successTask = Task {
            await withTaskGroup(
                of: Result<Int, TypedFailure>.self,
                returning: [Result<Int, TypedFailure>].self
            ) { group in
                for _ in 0..<64 {
                    group.addTask {
                        await successFlight.run {
                            successCalls.increment()
                            await successGate.wait()
                            return .success(41)
                        }
                    }
                }
                var results: [Result<Int, TypedFailure>] = []
                for await result in group {
                    results.append(result)
                }
                return results
            }
        }
        try await waitUntil("shared success operation did not launch") {
            successCalls.value == 1
        }
        successGate.open()
        let successResults = await successTask.value
        try require(successResults.count == 64, "a concurrent success waiter disappeared")
        for result in successResults {
            try requireSuccess(result, equals: 41, "concurrent success outcome changed")
        }
        let lateSuccess = await successFlight.run {
            successCalls.increment()
            return .success(99)
        }
        try requireSuccess(lateSuccess, equals: 41, "late success did not replay")
        try require(successCalls.value == 1, "shared success operation launched more than once")
        cases.append("concurrent-and-late-success")

        // Typed failures are retained and replayed without relaunching.
        let failureFlight = CaptureSingleFlight<Int, TypedFailure>()
        let failureCalls = LockedCounter()
        let firstFailure = await failureFlight.run {
            failureCalls.increment()
            return .failure(.code(17))
        }
        let lateFailure = await failureFlight.run {
            failureCalls.increment()
            return .success(0)
        }
        guard case .failure(.code(17)) = firstFailure,
              case .failure(.code(17)) = lateFailure else {
            throw HarnessFailure.assertion("typed failure was not cached")
        }
        try require(failureCalls.value == 1, "typed failure relaunched")
        cases.append("typed-failure-replay")

        // Cancelling one waiter cannot cancel or replace native cleanup.
        let cancellationFlight = CaptureSingleFlight<Int, TypedFailure>()
        let cancellationCalls = LockedCounter()
        let cancellationGate = AsyncGate()
        let canceledWaiter = Task {
            await cancellationFlight.run {
                cancellationCalls.increment()
                await cancellationGate.wait()
                return .success(Task.isCancelled ? -1 : 23)
            }
        }
        try await waitUntil("cancellation operation did not launch") {
            cancellationCalls.value == 1
        }
        canceledWaiter.cancel()
        let joiningWaiter = Task {
            await cancellationFlight.run {
                cancellationCalls.increment()
                return .success(-2)
            }
        }
        cancellationGate.open()
        try requireSuccess(
            await canceledWaiter.value,
            equals: 23,
            "waiter cancellation reached the detached operation"
        )
        try requireSuccess(
            await joiningWaiter.value,
            equals: 23,
            "a joining waiter replaced the detached operation"
        )
        try require(cancellationCalls.value == 1, "cancellation relaunched cleanup")
        cases.append("waiter-cancellation-isolated")

        // Immediate completion must not outrun publication of the running slot.
        for generation in 0..<128 {
            let flight = CaptureSingleFlight<Int, TypedFailure>()
            let calls = LockedCounter()
            let values = await withTaskGroup(
                of: Result<Int, TypedFailure>.self,
                returning: [Result<Int, TypedFailure>].self
            ) { group in
                for _ in 0..<16 {
                    group.addTask {
                        await flight.run {
                            calls.increment()
                            return .success(generation)
                        }
                    }
                }
                var results: [Result<Int, TypedFailure>] = []
                for await result in group {
                    results.append(result)
                }
                return results
            }
            try require(calls.value == 1, "immediate completion launched twice")
            for value in values {
                try requireSuccess(
                    value,
                    equals: generation,
                    "immediate completion changed its cached value"
                )
            }
        }
        cases.append("immediate-completion-stress")

        // Callback success, failure, and timeout each win exactly once.
        let timeoutAudit = TimeoutAudit()
        let successWait: CaptureBoundedCallbackWaitResult<Int, TypedFailure> =
            await CaptureBoundedCallbackWaiter.wait(
                label: "success",
                timeoutNanoseconds: 1_000_000_000,
                timeoutAction: { timeoutAudit.append($0) },
                start: { completion in
                    completion(.success(7))
                    completion(.failure(.code(1)))
                }
            )
        guard case .success(7) = successWait else {
            throw HarnessFailure.assertion("callback success did not win")
        }

        let errorWait: CaptureBoundedCallbackWaitResult<Int, TypedFailure> =
            await CaptureBoundedCallbackWaiter.wait(
                label: "error",
                timeoutNanoseconds: 1_000_000_000,
                timeoutAction: { timeoutAudit.append($0) },
                start: { completion in
                    completion(.failure(.code(8)))
                    completion(.success(9))
                }
            )
        guard case .failure(.code(8)) = errorWait else {
            throw HarnessFailure.assertion("callback failure did not win")
        }

        let timeoutWait: CaptureBoundedCallbackWaitResult<Int, TypedFailure> =
            await CaptureBoundedCallbackWaiter.wait(
                label: "timeout",
                timeoutNanoseconds: 5_000_000,
                timeoutAction: { timeoutAudit.append($0) },
                start: { completion in
                    DispatchQueue.global().asyncAfter(
                        deadline: .now() + .milliseconds(25)
                    ) {
                        completion(.success(10))
                    }
                }
            )
        guard case .timedOut = timeoutWait else {
            throw HarnessFailure.assertion("callback timeout did not win")
        }
        try await Task.sleep(nanoseconds: 40_000_000)
        try require(timeoutAudit.values == [
            CaptureBoundedCallbackTimeout(
                label: "timeout",
                timeoutNanoseconds: 5_000_000
            ),
        ], "timeout action was not exactly once")
        cases.append("bounded-callback-first-wins")

        // Synchronous native ownership uses the same absolute-deadline rule.
        // A timely return disarms exactly once. Even when the timer queue is
        // deliberately stalled, a late return detects the elapsed deadline
        // under the arbitration lock and cannot convert it into success.
        let timelyWatchdogAudit = TimeoutAudit()
        let timelyWatchdog = CaptureProcessDeadlineWatchdog(
            label: "timely native start",
            timeoutNanoseconds: 50_000_000,
            timeoutAction: { timelyWatchdogAudit.append($0) }
        )
        timelyWatchdog.arm()
        try require(
            timelyWatchdog.disarm(),
            "timely synchronous start did not disarm its watchdog"
        )
        try await Task.sleep(nanoseconds: 75_000_000)
        try require(
            timelyWatchdogAudit.values.isEmpty,
            "a disarmed synchronous watchdog fired later"
        )

        let delayedTimerQueue = DispatchQueue(
            label: "studio.capture.harness.delayed-watchdog"
        )
        delayedTimerQueue.suspend()
        let lateWatchdogAudit = TimeoutAudit()
        let lateWatchdog = CaptureProcessDeadlineWatchdog(
            label: "late native start",
            timeoutNanoseconds: 5_000_000,
            timerQueue: delayedTimerQueue,
            timeoutAction: { lateWatchdogAudit.append($0) }
        )
        lateWatchdog.arm()
        try await Task.sleep(nanoseconds: 20_000_000)
        let lateDisarmResult = lateWatchdog.disarm()
        delayedTimerQueue.resume()
        try await Task.sleep(nanoseconds: 20_000_000)
        try require(
            !lateDisarmResult,
            "late synchronous return disarmed after its absolute deadline"
        )
        try require(
            lateWatchdogAudit.values == [
                CaptureBoundedCallbackTimeout(
                    label: "late native start",
                    timeoutNanoseconds: 5_000_000
                ),
            ],
            "synchronous watchdog timeout action was not exact once"
        )
        cases.append("process-deadline-watchdog")

        // Start uses the same callback deadline, but both timeout and callback
        // failure are process-fatal because neither proves capture stayed off.
        let lateStartCompletionCalls = LockedCounter()
        let startTimeoutOutcome: CaptureBoundedCallbackWaitResult<
            Void,
            CaptureNativeStartCallbackFailure
        > = await CaptureBoundedCallbackWaiter.wait(
            label: "late display start",
            timeoutNanoseconds: 5_000_000,
            timeoutAction: { _ in
                // Production exits here. The harness returns so it can prove a
                // later native callback cannot replace the timeout outcome.
            },
            start: { completion in
                DispatchQueue.global().asyncAfter(
                    deadline: .now() + .milliseconds(25)
                ) {
                    lateStartCompletionCalls.increment()
                    completion(.success(()))
                }
            }
        )
        guard case .failClosed(let startTimeoutIncident) =
            captureStreamStartDisposition(
                startTimeoutOutcome,
                subject: "late display start"
            ) else {
            throw HarnessFailure.assertion("missing start callback stayed recoverable")
        }
        try require(
            startTimeoutIncident.kind == .streamStartTimeout,
            "missing start callback used the wrong fail-closed reason"
        )
        try await Task.sleep(nanoseconds: 40_000_000)
        try require(
            lateStartCompletionCalls.value == 1,
            "late native start completion did not exercise arbitration"
        )
        guard case .failClosed(let startErrorIncident) =
            captureStreamStartDisposition(
                CaptureBoundedCallbackWaitResult<
                    Void,
                    CaptureNativeStartCallbackFailure
                >.failure(CaptureNativeStartCallbackFailure(
                    code: "screen-start-failed",
                    message: "The native callback returned an error."
                )),
                subject: "failed display start"
            ) else {
            throw HarnessFailure.assertion("start callback error stayed recoverable")
        }
        try require(
            startErrorIncident.kind == .streamStartCallbackFailure,
            "start callback error used the wrong fail-closed reason"
        )
        let startFailureAudit = FailClosedAudit()
        for incident in [startTimeoutIncident, startErrorIncident] {
            captureApplyFailClosed(
                incident,
                action: { startFailureAudit.append($0) }
            )
        }
        try require(
            startFailureAudit.values == [
                startTimeoutIncident,
                startErrorIncident,
            ],
            "bounded start lost a fail-closed incident"
        )
        cases.append("bounded-start-fails-closed")

        // A native stop callback error is a fail-closed process incident, not a
        // recoverable recorder result.
        let stopFailureDisposition = captureStreamStopDisposition(
            CaptureBoundedCallbackWaitResult<
                Void,
                CaptureNativeStopCallbackFailure
            >.failure(CaptureNativeStopCallbackFailure(
                code: "native-stop-failed",
                message: "The callback returned an error."
            )),
            subject: "display stop"
        )
        guard case .failClosed(let stopFailureIncident) =
            stopFailureDisposition else {
            throw HarnessFailure.assertion("native stop error stayed recoverable")
        }
        try require(
            stopFailureIncident.kind == .streamStopCallbackFailure,
            "native stop error used the wrong fail-closed reason"
        )
        let stopFailureAudit = FailClosedAudit()
        captureApplyFailClosed(
            stopFailureIncident,
            action: { stopFailureAudit.append($0) }
        )
        try require(
            stopFailureAudit.values == [stopFailureIncident],
            "native stop fail-closed action was not exact once"
        )
        cases.append("stream-stop-errors-fail-closed")

        // Attempted starts never become safe merely because time passes. They
        // retain finalization ownership until the one terminal callback.
        let attemptedLease = CaptureRecordingCleanupLease(
            subject: "attempted display"
        )
        attemptedLease.markStartAttempted()
        try require(
            attemptedLease.sealFailedStart(
                recordingOutputRemovalSucceeded: true,
                nativeMediaEvidence: false,
                fileEvidence: false
            ) == .awaitFinalization,
            "an attempted start did not retain finalization ownership"
        )
        try await Task.sleep(nanoseconds: 300_000_000)
        try require(
            attemptedLease.observeRecordingStart() == nil,
            "late start inside the retained lease failed prematurely"
        )
        guard case .failClosed(let incompleteAttemptIncident) =
            attemptedLease.completeCleanup(
                nativeMediaEvidence: false,
                fileEvidence: false
            ) else {
            throw HarnessFailure.assertion(
                "cleanup concluded without mux finalization"
            )
        }
        try require(
            incompleteAttemptIncident.kind == .muxFinalizationTimeout,
            "incomplete cleanup used the wrong fail-closed reason"
        )

        let finalizedLease = CaptureRecordingCleanupLease(
            subject: "late-finalizing display"
        )
        finalizedLease.markStartAttempted()
        try require(
            finalizedLease.sealFailedStart(
                recordingOutputRemovalSucceeded: true,
                nativeMediaEvidence: false,
                fileEvidence: false
            ) == .awaitFinalization,
            "late-finalizing start did not retain its lease"
        )
        try await Task.sleep(nanoseconds: 300_000_000)
        try require(
            finalizedLease.observeRecordingStart() == nil,
            "retained lease rejected a late start callback"
        )
        try require(
            finalizedLease.observeRecordingFinalization() == nil,
            "retained lease rejected terminal mux finalization"
        )
        try require(
            finalizedLease.completeCleanup(
                nativeMediaEvidence: true,
                fileEvidence: true
            ) == .finalized,
            "finalized lease did not close"
        )

        // A recorder that was provably never started can seal inactive only
        // after output removal. Activity or files after that boundary fail
        // closed regardless of delay.
        let lateActivityLease = CaptureRecordingCleanupLease(
            subject: "inactive display"
        )
        try require(
            lateActivityLease.sealFailedStart(
                recordingOutputRemovalSucceeded: true,
                nativeMediaEvidence: false,
                fileEvidence: false
            ) == .inactive,
            "never-started recorder did not seal inactive"
        )
        try await Task.sleep(nanoseconds: 300_000_000)
        guard let lateActivityIncident =
            lateActivityLease.observeRecordingStart() else {
            throw HarnessFailure.assertion(
                "late activity crossed the inactive cleanup boundary"
            )
        }
        try require(
            lateActivityIncident.kind == .lateRecordingActivity,
            "late activity used the wrong fail-closed reason"
        )

        let removalFailureLease = CaptureRecordingCleanupLease(
            subject: "removal failure display"
        )
        guard case .failClosed(let removalFailureIncident) =
            removalFailureLease.sealFailedStart(
                recordingOutputRemovalSucceeded: false,
                nativeMediaEvidence: false,
                fileEvidence: false
            ) else {
            throw HarnessFailure.assertion("output removal failure stayed recoverable")
        }
        try require(
            removalFailureIncident.kind == .recordingOutputRemovalFailure,
            "output removal failure used the wrong reason"
        )

        let muxTimeoutLease = CaptureRecordingCleanupLease(
            subject: "mux timeout display"
        )
        muxTimeoutLease.markStartAttempted()
        _ = muxTimeoutLease.sealFailedStart(
            recordingOutputRemovalSucceeded: true,
            nativeMediaEvidence: true,
            fileEvidence: true
        )
        let muxTimeoutIncident = muxTimeoutLease.finalizationTimedOut()
        try require(
            muxTimeoutIncident.kind == .muxFinalizationTimeout,
            "mux timeout used the wrong fail-closed reason"
        )

        let lateFileLease = CaptureRecordingCleanupLease(
            subject: "late file display"
        )
        _ = lateFileLease.sealFailedStart(
            recordingOutputRemovalSucceeded: true,
            nativeMediaEvidence: false,
            fileEvidence: false
        )
        guard let lateFileIncident =
            lateFileLease.observeLateFileEvidence() else {
            throw HarnessFailure.assertion("late file evidence stayed recoverable")
        }
        try require(
            lateFileIncident.kind == .lateOutputFile,
            "late file evidence used the wrong fail-closed reason"
        )

        let securityLease = CaptureRecordingCleanupLease(
            subject: "insecure output display"
        )
        let securityIncident = securityLease.outputSecurityFailed()
        try require(
            securityIncident.kind == .outputSecurityFailure,
            "output security failure used the wrong fail-closed reason"
        )
        let leaseAudit = FailClosedAudit()
        for incident in [
            lateActivityIncident,
            removalFailureIncident,
            muxTimeoutIncident,
            lateFileIncident,
            securityIncident,
        ] {
            captureApplyFailClosed(incident, action: { leaseAudit.append($0) })
        }
        try require(
            leaseAudit.values.map(\.kind) == [
                .lateRecordingActivity,
                .recordingOutputRemovalFailure,
                .muxFinalizationTimeout,
                .lateOutputFile,
                .outputSecurityFailure,
            ],
            "cleanup lease lost a fail-closed incident"
        )
        cases.append("cleanup-lease-has-terminal-boundary")

        // Camera and microphone start actions mark the lease before escaping
        // the delegate lock. A failed start therefore tolerates a later
        // didStart callback only while it still owns terminal finalization,
        // and it preserves a typed terminal error instead of discarding it.
        let mediaCleanupLease = CaptureRecordingCleanupLease(
            subject: "failed camera start"
        )
        mediaCleanupLease.markStartAttempted()
        let mediaCleanupDecision = mediaCleanupLease.sealFailedStart(
            recordingOutputRemovalSucceeded: true,
            nativeMediaEvidence: false,
            fileEvidence: false
        )
        try require(
            mediaCleanupDecision == .awaitFinalization,
            "escaped media start action did not retain cleanup ownership"
        )
        try await Task.sleep(nanoseconds: 25_000_000)
        try require(
            mediaCleanupLease.observeRecordingStart() == nil,
            "late media didStart callback escaped failed-start cleanup"
        )
        try require(
            mediaCleanupLease.observeRecordingFinalization() == nil,
            "media cleanup rejected its terminal callback"
        )
        let mediaTerminalBarrier =
            CaptureMuxTerminalBarrier<
                CaptureNativeFileFinalizationFailure
            >()
        let expectedMediaFailure = CaptureNativeFileFinalizationFailure(
            code: "AVFoundation#-11800",
            message: "The file output reported a terminal error."
        )
        try require(
            mediaTerminalBarrier.publish(.failure(expectedMediaFailure)),
            "media terminal error did not publish"
        )
        guard case .failure(let observedMediaFailure) =
            await captureJoinRecordingCleanup(
                decision: mediaCleanupDecision,
                terminalBarrier: mediaTerminalBarrier,
                timeoutNanoseconds: 1_000_000_000
            ) else {
            throw HarnessFailure.assertion(
                "media terminal error was ignored"
            )
        }
        try require(
            observedMediaFailure == expectedMediaFailure,
            "media terminal error changed during cleanup"
        )
        try require(
            mediaCleanupLease.completeCleanup(
                nativeMediaEvidence: true,
                fileEvidence: true
            ) == .finalized,
            "errored terminal callback did not prove cleanup completion"
        )

        let mediaTimeoutLease = CaptureRecordingCleanupLease(
            subject: "timed-out microphone start"
        )
        mediaTimeoutLease.markStartAttempted()
        let mediaTimeoutDecision = mediaTimeoutLease.sealFailedStart(
            recordingOutputRemovalSucceeded: true,
            nativeMediaEvidence: false,
            fileEvidence: false
        )
        let missingMediaTerminalBarrier =
            CaptureMuxTerminalBarrier<
                CaptureNativeFileFinalizationFailure
            >()
        guard case .timedOut = await captureJoinRecordingCleanup(
            decision: mediaTimeoutDecision,
            terminalBarrier: missingMediaTerminalBarrier,
            timeoutNanoseconds: 5_000_000
        ) else {
            throw HarnessFailure.assertion(
                "missing media finish callback stayed recoverable"
            )
        }
        let mediaTimeoutIncident =
            mediaTimeoutLease.finalizationTimedOut()
        try require(
            mediaTimeoutIncident.kind == .muxFinalizationTimeout,
            "missing media finish callback used the wrong fatal reason"
        )

        let terminalFirstMediaLease = CaptureRecordingCleanupLease(
            subject: "terminal-first camera start"
        )
        try require(
            terminalFirstMediaLease.observeRecordingFinalization() == nil,
            "terminal-first media fixture rejected finalization"
        )
        guard let startAfterTerminalIncident =
            terminalFirstMediaLease.observeRecordingStart() else {
            throw HarnessFailure.assertion(
                "media start callback arrived after terminal finalization"
            )
        }
        try require(
            startAfterTerminalIncident.kind == .lateRecordingActivity,
            "start after terminal finalization used the wrong fatal reason"
        )
        let immediateGateAudit = FailClosedAudit()
        let blockedStopCalls = LockedCounter()
        let passedFatalGate = capturePassImmediateFailClosedGate(
            startAfterTerminalIncident,
            action: { immediateGateAudit.append($0) }
        )
        if passedFatalGate {
            blockedStopCalls.increment()
        }
        try require(
            !passedFatalGate,
            "returning fail-closed injection opened the native side-effect gate"
        )
        try require(
            immediateGateAudit.values == [startAfterTerminalIncident],
            "immediate fail-closed gate did not apply the exact incident"
        )
        try require(
            blockedStopCalls.value == 0,
            "late activity reached the injected stop action"
        )
        cases.append("media-failed-start-terminal-cleanup")

        // Force the old publication race: the lease sees finalization while the
        // typed terminal failure is deliberately withheld. A join must remain
        // pending and then receive the failure, never synthesize success.
        let terminalLease = CaptureRecordingCleanupLease(
            subject: "terminal barrier display"
        )
        terminalLease.markStartAttempted()
        _ = terminalLease.sealFailedStart(
            recordingOutputRemovalSucceeded: true,
            nativeMediaEvidence: true,
            fileEvidence: true
        )
        try require(
            terminalLease.observeRecordingFinalization() == nil,
            "terminal barrier fixture rejected finalization"
        )
        let finalizedDecision =
            terminalLease.requireFinalizationAfterStreamStop()
        try require(
            finalizedDecision == .finalized,
            "terminal barrier fixture did not expose finalized lease state"
        )
        let terminalBarrier = CaptureMuxTerminalBarrier<TypedFailure>()
        let terminalJoinStarted = LockedCounter()
        let terminalJoinCompleted = LockedCounter()
        let terminalJoin = Task {
            terminalJoinStarted.increment()
            let result = await captureJoinRecordingCleanup(
                decision: finalizedDecision,
                terminalBarrier: terminalBarrier,
                timeoutNanoseconds: 1_000_000_000
            )
            terminalJoinCompleted.increment()
            return result
        }
        try await waitUntil("terminal barrier join did not start") {
            terminalJoinStarted.value == 1
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        try require(
            terminalJoinCompleted.value == 0,
            "finalized lease bypassed the terminal outcome barrier"
        )
        try require(
            terminalBarrier.publish(.failure(.code(71))),
            "terminal failure did not publish"
        )
        guard case .failure(.code(71)) = await terminalJoin.value else {
            throw HarnessFailure.assertion(
                "forced terminal interleaving cached false success"
            )
        }
        guard case .failure(.code(71)) =
            await captureJoinRecordingCleanup(
                decision: finalizedDecision,
                terminalBarrier: terminalBarrier,
                timeoutNanoseconds: 1_000_000_000
            ) else {
            throw HarnessFailure.assertion(
                "late terminal waiter did not replay typed failure"
            )
        }
        try require(
            !terminalBarrier.publish(.success(())),
            "terminal outcome published more than once"
        )
        cases.append("mux-terminal-outcome-barrier")

        // Exercise the exact production action in a child copy of this harness.
        let exitProcess = Process()
        exitProcess.executableURL = URL(
            fileURLWithPath: CommandLine.arguments[0]
        )
        exitProcess.arguments = ["--exercise-exit-70"]
        exitProcess.standardInput = FileHandle.nullDevice
        let exitStandardOutput = Pipe()
        let exitStandardError = Pipe()
        exitProcess.standardOutput = exitStandardOutput
        exitProcess.standardError = exitStandardError
        try exitProcess.run()
        exitProcess.waitUntilExit()
        let exitOutput = exitStandardOutput.fileHandleForReading.readDataToEndOfFile()
        let exitDiagnostic = exitStandardError.fileHandleForReading.readDataToEndOfFile()
        try require(exitProcess.terminationReason == .exit, "fail-closed child was signaled")
        try require(exitProcess.terminationStatus == 70, "fail-closed child did not exit 70")
        try require(exitOutput.isEmpty, "fail-closed action wrote to protocol stdout")
        try require(
            exitDiagnostic.count <= 1_024,
            "fail-closed diagnostic exceeded its byte bound"
        )
        try require(
            String(data: exitDiagnostic, encoding: .utf8)?.contains(
                "muxFinalizationTimeout"
            ) == true,
            "fail-closed diagnostic omitted the typed reason"
        )
        cases.append("exit-70-policy")

        let startExitProcess = Process()
        startExitProcess.executableURL = URL(
            fileURLWithPath: CommandLine.arguments[0]
        )
        startExitProcess.arguments = ["--exercise-start-timeout-exit-70"]
        startExitProcess.standardInput = FileHandle.nullDevice
        let startExitStandardOutput = Pipe()
        let startExitStandardError = Pipe()
        startExitProcess.standardOutput = startExitStandardOutput
        startExitProcess.standardError = startExitStandardError
        try startExitProcess.run()
        startExitProcess.waitUntilExit()
        let startExitOutput =
            startExitStandardOutput.fileHandleForReading.readDataToEndOfFile()
        let startExitDiagnostic =
            startExitStandardError.fileHandleForReading.readDataToEndOfFile()
        try require(
            startExitProcess.terminationReason == .exit,
            "missing-start child was signaled"
        )
        try require(
            startExitProcess.terminationStatus == 70,
            "missing-start child did not exit 70"
        )
        try require(
            startExitOutput.isEmpty,
            "missing-start action wrote to protocol stdout"
        )
        try require(
            startExitDiagnostic.count <= 1_024,
            "missing-start diagnostic exceeded its byte bound"
        )
        try require(
            String(data: startExitDiagnostic, encoding: .utf8)?.contains(
                "streamStartTimeout"
            ) == true,
            "missing-start diagnostic omitted the typed reason"
        )
        cases.append("missing-start-callback-exit-70")

        let sessionStartExitProcess = Process()
        sessionStartExitProcess.executableURL = URL(
            fileURLWithPath: CommandLine.arguments[0]
        )
        sessionStartExitProcess.arguments = [
            "--exercise-session-start-watchdog-exit-70",
        ]
        sessionStartExitProcess.standardInput = FileHandle.nullDevice
        let sessionStartExitStandardOutput = Pipe()
        let sessionStartExitStandardError = Pipe()
        sessionStartExitProcess.standardOutput =
            sessionStartExitStandardOutput
        sessionStartExitProcess.standardError =
            sessionStartExitStandardError
        try sessionStartExitProcess.run()
        sessionStartExitProcess.waitUntilExit()
        let sessionStartExitOutput =
            sessionStartExitStandardOutput.fileHandleForReading
                .readDataToEndOfFile()
        let sessionStartExitDiagnostic =
            sessionStartExitStandardError.fileHandleForReading
                .readDataToEndOfFile()
        try require(
            sessionStartExitProcess.terminationReason == .exit,
            "hung-session-start child was signaled"
        )
        try require(
            sessionStartExitProcess.terminationStatus == 70,
            "hung-session-start child did not exit 70"
        )
        try require(
            sessionStartExitOutput.isEmpty,
            "hung-session-start action wrote to protocol stdout"
        )
        try require(
            sessionStartExitDiagnostic.count <= 1_024,
            "hung-session-start diagnostic exceeded its byte bound"
        )
        try require(
            String(
                data: sessionStartExitDiagnostic,
                encoding: .utf8
            )?.contains("sessionStartTimeout") == true,
            "hung-session-start diagnostic omitted the typed reason"
        )
        cases.append("hung-session-start-exit-70")

        try requireExit70Child(
            argument: "--exercise-session-stop-watchdog-exit-70",
            expectedReason: "sessionStopTimeout",
            label: "hung-session-stop"
        )
        cases.append("hung-session-stop-exit-70")

        try requireExit70Child(
            argument: "--exercise-late-start-before-blocking-stop-exit-70",
            expectedReason: "lateRecordingActivity",
            label: "late-start-before-blocking-stop"
        )
        cases.append("late-start-immediate-exit-70")

        try requireExit70Child(
            argument: "--exercise-late-terminal-immediate-exit-70",
            expectedReason: "lateRecordingActivity",
            label: "late-terminal"
        )
        cases.append("late-terminal-immediate-exit-70")

        // Every indexed drain settles. Results sort by index and select the
        // primary failure before the lowest-index fallback.
        let drainCalls = LockedCounter()
        let outcomes = await captureDrainIndexed([
            CaptureIndexedDrainOperation<Int, String, TypedFailure>(
                index: 9,
                isPrimary: false,
                operation: {
                    drainCalls.increment()
                    return .failure(.code(9))
                }
            ),
            CaptureIndexedDrainOperation<Int, String, TypedFailure>(
                index: 2,
                isPrimary: false,
                operation: {
                    drainCalls.increment()
                    return .success("two")
                }
            ),
            CaptureIndexedDrainOperation<Int, String, TypedFailure>(
                index: 5,
                isPrimary: true,
                operation: {
                    try? await Task.sleep(nanoseconds: 1_000_000)
                    drainCalls.increment()
                    return .failure(.code(5))
                }
            ),
            CaptureIndexedDrainOperation<Int, String, TypedFailure>(
                index: 1,
                isPrimary: false,
                operation: {
                    drainCalls.increment()
                    return .success("one")
                }
            ),
        ])
        try require(drainCalls.value == 4, "an indexed drain operation was canceled")
        try require(outcomes.map(\.index) == [1, 2, 5, 9], "drain outcomes were not sorted")
        try require(
            capturePreferredDrainFailure(outcomes) == .code(5),
            "primary drain failure did not win"
        )

        let fallbackOutcomes = await captureDrainIndexed([
            CaptureIndexedDrainOperation<Int, String, TypedFailure>(
                index: 9,
                isPrimary: false,
                operation: { .failure(.code(9)) }
            ),
            CaptureIndexedDrainOperation<Int, String, TypedFailure>(
                index: 5,
                isPrimary: false,
                operation: { .failure(.code(5)) }
            ),
        ])
        try require(
            capturePreferredDrainFailure(fallbackOutcomes) == .code(5),
            "lowest-index fallback drain failure did not win"
        )
        cases.append("deterministic-nonthrowing-drain")

        let output: [String: Any] = [
            "cases": cases,
            "caseCount": cases.count,
        ]
        let data = try JSONSerialization.data(
            withJSONObject: output,
            options: [.sortedKeys]
        )
        guard let line = String(data: data, encoding: .utf8) else {
            throw HarnessFailure.assertion("could not encode harness output")
        }
        print(line)
    }
}
`;

test("recorder finalizers are single-flight and native callback waits are bounded", async () => {
  if (process.platform !== "darwin") return;

  const result = await runCaptureControllerFinalizationHarness(harnessSource);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    caseCount: 18,
    cases: [
      "concurrent-and-late-success",
      "typed-failure-replay",
      "waiter-cancellation-isolated",
      "immediate-completion-stress",
      "bounded-callback-first-wins",
      "process-deadline-watchdog",
      "bounded-start-fails-closed",
      "stream-stop-errors-fail-closed",
      "cleanup-lease-has-terminal-boundary",
      "media-failed-start-terminal-cleanup",
      "mux-terminal-outcome-barrier",
      "exit-70-policy",
      "missing-start-callback-exit-70",
      "hung-session-start-exit-70",
      "hung-session-stop-exit-70",
      "late-start-immediate-exit-70",
      "late-terminal-immediate-exit-70",
      "deterministic-nonthrowing-drain",
    ],
  });
}, 60_000);
