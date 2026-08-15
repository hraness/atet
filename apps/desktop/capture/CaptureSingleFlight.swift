import Foundation

enum CaptureCleanupFailClosedKind: String, Sendable {
    case lateOutputFile
    case lateRecordingActivity
    case muxFinalizationTimeout
    case recordingOutputRemovalFailure
    case sessionStartTimeout
    case sessionStopTimeout
    case streamStartCallbackFailure
    case streamStartTimeout
    case streamStopCallbackFailure
    case streamStopTimeout
    case outputSecurityFailure
}

struct CaptureCleanupFailClosedIncident: Equatable, Sendable {
    let kind: CaptureCleanupFailClosedKind
    let subject: String
    let detail: String

    init(
        kind: CaptureCleanupFailClosedKind,
        subject: String,
        detail: String
    ) {
        precondition(!subject.isEmpty)
        precondition(subject.utf8.count <= 256)
        precondition(!detail.isEmpty)
        precondition(detail.utf8.count <= 512)
        self.kind = kind
        self.subject = subject
        self.detail = detail
    }
}

typealias CaptureCleanupFailClosedAction =
    @Sendable (CaptureCleanupFailClosedIncident) -> Void

let captureExit70AfterCleanupFailure: CaptureCleanupFailClosedAction = {
    incident in
    let message = "atet-capture fatal [\(incident.kind.rawValue)] \(incident.subject): \(incident.detail)\n"
    let diagnostic = Data(message.utf8.prefix(1_024))
    let existingFlags = fcntl(STDERR_FILENO, F_GETFL)
    if existingFlags >= 0 {
        _ = fcntl(STDERR_FILENO, F_SETFL, existingFlags | O_NONBLOCK)
    }
    diagnostic.withUnsafeBytes { bytes in
        guard let address = bytes.baseAddress else { return }
        _ = write(STDERR_FILENO, address, bytes.count)
    }
    _exit(70)
}

func captureApplyFailClosed(
    _ incident: CaptureCleanupFailClosedIncident,
    action: CaptureCleanupFailClosedAction
) {
    action(incident)
}

/// Opens the side-effect boundary only when no fatal cleanup incident exists.
///
/// A returning injected action still leaves the gate closed, which lets tests
/// prove that blocking native stop actions, terminal publication, and waiter
/// signaling remain unreachable after late activity is detected.
func capturePassImmediateFailClosedGate(
    _ incident: CaptureCleanupFailClosedIncident?,
    action: CaptureCleanupFailClosedAction
) -> Bool {
    guard let incident else { return true }
    captureApplyFailClosed(incident, action: action)
    return false
}

struct CaptureNativeStopCallbackFailure: Error, Equatable, Sendable {
    let code: String
    let message: String

    init(code: String, message: String) {
        precondition(!code.isEmpty)
        precondition(code.utf8.count <= 128)
        precondition(!message.isEmpty)
        precondition(message.utf8.count <= 320)
        self.code = code
        self.message = message
    }
}

struct CaptureNativeStartCallbackFailure: Error, Equatable, Sendable {
    let code: String
    let message: String

    init(code: String, message: String) {
        precondition(!code.isEmpty)
        precondition(code.utf8.count <= 128)
        precondition(!message.isEmpty)
        precondition(message.utf8.count <= 320)
        self.code = code
        self.message = message
    }
}

struct CaptureNativeFileFinalizationFailure:
    Error,
    Equatable,
    LocalizedError,
    Sendable
{
    let code: String
    let message: String

    init(code: String, message: String) {
        precondition(!code.isEmpty)
        precondition(code.utf8.count <= 128)
        precondition(!message.isEmpty)
        precondition(message.utf8.count <= 320)
        self.code = code
        self.message = message
    }

    var errorDescription: String? { message }
}

enum CaptureStreamStartDisposition: Equatable, Sendable {
    case started
    case failClosed(CaptureCleanupFailClosedIncident)
}

func captureStreamStartDisposition(
    _ outcome: CaptureBoundedCallbackWaitResult<
        Void,
        CaptureNativeStartCallbackFailure
    >,
    subject: String
) -> CaptureStreamStartDisposition {
    switch outcome {
    case .success:
        return .started
    case .failure(let failure):
        return .failClosed(CaptureCleanupFailClosedIncident(
            kind: .streamStartCallbackFailure,
            subject: subject,
            detail: "\(failure.code): \(failure.message)"
        ))
    case .timedOut:
        return .failClosed(CaptureCleanupFailClosedIncident(
            kind: .streamStartTimeout,
            subject: subject,
            detail: "The native start callback missed its deadline."
        ))
    }
}

enum CaptureStreamStopDisposition: Equatable, Sendable {
    case stopped
    case failClosed(CaptureCleanupFailClosedIncident)
}

func captureStreamStopDisposition(
    _ outcome: CaptureBoundedCallbackWaitResult<
        Void,
        CaptureNativeStopCallbackFailure
    >,
    subject: String
) -> CaptureStreamStopDisposition {
    switch outcome {
    case .success:
        return .stopped
    case .failure(let failure):
        return .failClosed(CaptureCleanupFailClosedIncident(
            kind: .streamStopCallbackFailure,
            subject: subject,
            detail: "\(failure.code): \(failure.message)"
        ))
    case .timedOut:
        return .failClosed(CaptureCleanupFailClosedIncident(
            kind: .streamStopTimeout,
            subject: subject,
            detail: "The native stop callback missed its deadline."
        ))
    }
}

enum CaptureRecordingCleanupDecision: Equatable, Sendable {
    case inactive
    case finalized
    case awaitFinalization
    case failClosed(CaptureCleanupFailClosedIncident)
}

enum CaptureMuxTerminalWaitResult<
    Failure: Error & Sendable
>: Sendable {
    case success
    case failure(Failure)
    case timedOut
}

/// Publishes the mux terminal outcome once and lets every waiter join the same
/// cached result. The cleanup lease and this outcome are deliberately separate:
/// seeing the lease finalize never implies success before this barrier joins.
final class CaptureMuxTerminalBarrier<
    Failure: Error & Sendable
>: @unchecked Sendable {
    private enum State {
        case pending
        case published(Result<Void, Failure>)
    }

    private let lock = NSLock()
    private let completionGroup = DispatchGroup()
    private var state: State = .pending

    init() {
        completionGroup.enter()
    }

    @discardableResult
    func publish(_ outcome: Result<Void, Failure>) -> Bool {
        lock.lock()
        guard case .pending = state else {
            lock.unlock()
            return false
        }
        state = .published(outcome)
        completionGroup.leave()
        lock.unlock()
        return true
    }

    func wait(
        timeoutNanoseconds: UInt64
    ) async -> CaptureMuxTerminalWaitResult<Failure> {
        precondition(timeoutNanoseconds > 0)
        precondition(timeoutNanoseconds <= 60_000_000_000)
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let completed = self.completionGroup.wait(
                    timeout: .now()
                        + .nanoseconds(Int(timeoutNanoseconds))
                ) == .success
                guard completed else {
                    continuation.resume(returning: .timedOut)
                    return
                }
                self.lock.lock()
                let result: CaptureMuxTerminalWaitResult<Failure>
                switch self.state {
                case .pending:
                    preconditionFailure(
                        "A completed mux barrier must publish an outcome."
                    )
                case .published(.success):
                    result = .success
                case .published(.failure(let failure)):
                    result = .failure(failure)
                }
                self.lock.unlock()
                continuation.resume(returning: result)
            }
        }
    }
}

enum CaptureRecordingCleanupJoinResult<
    Failure: Error & Sendable
>: Sendable {
    case inactive
    case success
    case failure(Failure)
    case timedOut
    case failClosed(CaptureCleanupFailClosedIncident)
}

func captureJoinRecordingCleanup<
    Failure: Error & Sendable
>(
    decision: CaptureRecordingCleanupDecision,
    terminalBarrier: CaptureMuxTerminalBarrier<Failure>,
    timeoutNanoseconds: UInt64
) async -> CaptureRecordingCleanupJoinResult<Failure> {
    switch decision {
    case .inactive:
        return .inactive
    case .finalized, .awaitFinalization:
        switch await terminalBarrier.wait(
            timeoutNanoseconds: timeoutNanoseconds
        ) {
        case .success:
            return .success
        case .failure(let failure):
            return .failure(failure)
        case .timedOut:
            return .timedOut
        }
    case .failClosed(let incident):
        return .failClosed(incident)
    }
}

/// Owns the boundary between a failed native start and safe helper reuse.
///
/// A start attempt always requires a terminal mux callback. A recorder that
/// was never started may seal inactive only after recording-output removal
/// succeeds. Any activity observed after that seal fails closed.
final class CaptureRecordingCleanupLease: @unchecked Sendable {
    private enum Phase {
        case open
        case inactive
        case awaitingFinalization
        case finalized
        case completedInactive
        case completedFinalized
        case failedClosed(CaptureCleanupFailClosedIncident)
    }

    private let lock = NSLock()
    private let subject: String
    private var phase: Phase = .open
    private var startAttempted = false
    private var didObserveStart = false
    private var didObserveFinalization = false

    init(subject: String) {
        precondition(!subject.isEmpty)
        precondition(subject.utf8.count <= 256)
        self.subject = subject
    }

    func markStartAttempted() {
        lock.lock()
        defer { lock.unlock() }
        guard case .open = phase else {
            preconditionFailure("A recording start cannot begin after cleanup.")
        }
        precondition(!startAttempted)
        startAttempted = true
    }

    func observeRecordingStart() -> CaptureCleanupFailClosedIncident? {
        lock.lock()
        defer { lock.unlock() }
        didObserveStart = true
        switch phase {
        case .open:
            if didObserveFinalization {
                return failClosedLocked(
                    kind: .lateRecordingActivity,
                    detail: "A recording-start callback arrived after mux finalization."
                )
            }
            return nil
        case .awaitingFinalization:
            return nil
        case .inactive, .completedInactive:
            return failClosedLocked(
                kind: .lateRecordingActivity,
                detail: "A recording-start callback arrived after the output was sealed inactive."
            )
        case .finalized, .completedFinalized:
            return failClosedLocked(
                kind: .lateRecordingActivity,
                detail: "A recording-start callback arrived after mux finalization."
            )
        case .failedClosed(let incident):
            return incident
        }
    }

    func observeRecordingFinalization() -> CaptureCleanupFailClosedIncident? {
        lock.lock()
        defer { lock.unlock() }
        didObserveFinalization = true
        switch phase {
        case .open:
            return nil
        case .awaitingFinalization:
            phase = .finalized
            return nil
        case .finalized, .completedFinalized:
            return nil
        case .inactive, .completedInactive:
            return failClosedLocked(
                kind: .lateRecordingActivity,
                detail: "A mux-finalization callback arrived after the output was sealed inactive."
            )
        case .failedClosed(let incident):
            return incident
        }
    }

    func requireFinalizationAfterStreamStop() -> CaptureRecordingCleanupDecision {
        lock.lock()
        defer { lock.unlock() }
        switch phase {
        case .open:
            if didObserveFinalization {
                phase = .finalized
                return .finalized
            }
            phase = .awaitingFinalization
            return .awaitFinalization
        case .awaitingFinalization:
            return .awaitFinalization
        case .finalized:
            return .finalized
        case .failedClosed(let incident):
            return .failClosed(incident)
        case .inactive, .completedInactive, .completedFinalized:
            return failClosedDecisionLocked(
                kind: .lateRecordingActivity,
                detail: "Normal stop reached an incompatible cleanup phase."
            )
        }
    }

    func sealFailedStart(
        recordingOutputRemovalSucceeded: Bool,
        nativeMediaEvidence: Bool,
        fileEvidence: Bool
    ) -> CaptureRecordingCleanupDecision {
        lock.lock()
        defer { lock.unlock() }
        guard case .open = phase else {
            return failClosedDecisionLocked(
                kind: .lateRecordingActivity,
                detail: "Failed-start cleanup attempted to seal the output twice."
            )
        }
        guard recordingOutputRemovalSucceeded else {
            return failClosedDecisionLocked(
                kind: .recordingOutputRemovalFailure,
                detail: "The recording output could not be detached after native stop completed."
            )
        }
        if didObserveFinalization {
            phase = .finalized
            return .finalized
        }
        if startAttempted || didObserveStart || nativeMediaEvidence || fileEvidence {
            phase = .awaitingFinalization
            return .awaitFinalization
        }
        phase = .inactive
        return .inactive
    }

    func observeLateFileEvidence() -> CaptureCleanupFailClosedIncident? {
        lock.lock()
        defer { lock.unlock() }
        switch phase {
        case .inactive, .completedInactive:
            return failClosedLocked(
                kind: .lateOutputFile,
                detail: "A recording file appeared after the output was sealed inactive."
            )
        case .open, .awaitingFinalization, .finalized, .completedFinalized:
            return nil
        case .failedClosed(let incident):
            return incident
        }
    }

    func finalizationTimedOut() -> CaptureCleanupFailClosedIncident {
        lock.lock()
        defer { lock.unlock() }
        return failClosedLocked(
            kind: .muxFinalizationTimeout,
            detail: "The mux finalization callback missed its deadline."
        )
    }

    func outputSecurityFailed() -> CaptureCleanupFailClosedIncident {
        lock.lock()
        defer { lock.unlock() }
        return failClosedLocked(
            kind: .outputSecurityFailure,
            detail: "A retained recording file could not be secured."
        )
    }

    func completeCleanup(
        nativeMediaEvidence: Bool,
        fileEvidence: Bool
    ) -> CaptureRecordingCleanupDecision {
        lock.lock()
        defer { lock.unlock() }
        switch phase {
        case .inactive:
            if nativeMediaEvidence || fileEvidence {
                return failClosedDecisionLocked(
                    kind: .lateOutputFile,
                    detail: "Media evidence appeared while the inactive cleanup seal was being committed."
                )
            }
            phase = .completedInactive
            return .inactive
        case .finalized:
            phase = .completedFinalized
            return .finalized
        case .awaitingFinalization:
            return failClosedDecisionLocked(
                kind: .muxFinalizationTimeout,
                detail: "Cleanup completed without a terminal mux callback."
            )
        case .failedClosed(let incident):
            return .failClosed(incident)
        case .open, .completedInactive, .completedFinalized:
            return failClosedDecisionLocked(
                kind: .lateRecordingActivity,
                detail: "Cleanup completion reached an incompatible lease phase."
            )
        }
    }

    var hasFinalized: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didObserveFinalization
    }

    var wasStartAttempted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return startAttempted
    }

    private func failClosedDecisionLocked(
        kind: CaptureCleanupFailClosedKind,
        detail: String
    ) -> CaptureRecordingCleanupDecision {
        .failClosed(failClosedLocked(kind: kind, detail: detail))
    }

    private func failClosedLocked(
        kind: CaptureCleanupFailClosedKind,
        detail: String
    ) -> CaptureCleanupFailClosedIncident {
        if case .failedClosed(let incident) = phase { return incident }
        let incident = CaptureCleanupFailClosedIncident(
            kind: kind,
            subject: subject,
            detail: detail
        )
        phase = .failedClosed(incident)
        return incident
    }
}

enum CaptureBoundedCallbackWaitResult<
    Success: Sendable,
    Failure: Error & Sendable
>: Sendable {
    case success(Success)
    case failure(Failure)
    case timedOut
}

struct CaptureBoundedCallbackTimeout: Equatable, Sendable {
    let label: String
    let timeoutNanoseconds: UInt64
}

/// Terminates ownership of a synchronous native operation at one absolute
/// deadline. Native calls such as `AVCaptureSession.startRunning()` cannot be
/// canceled or safely abandoned, so capture's production timeout action exits
/// the helper process. Tests may inject a returning action to audit arbitration.
final class CaptureProcessDeadlineWatchdog: @unchecked Sendable {
    private enum State {
        case idle
        case armed(
            deadlineNanoseconds: UInt64,
            workItem: DispatchWorkItem
        )
        case disarmed
        case fired
    }

    private let lock = NSLock()
    private let timeout: CaptureBoundedCallbackTimeout
    private let timeoutAction:
        @Sendable (CaptureBoundedCallbackTimeout) -> Void
    private let timerQueue: DispatchQueue
    private var state: State = .idle

    init(
        label: String,
        timeoutNanoseconds: UInt64,
        timerQueue: DispatchQueue = .global(qos: .userInitiated),
        timeoutAction: @escaping @Sendable (
            CaptureBoundedCallbackTimeout
        ) -> Void
    ) {
        precondition(!label.isEmpty)
        precondition(label.utf8.count <= 256)
        precondition(timeoutNanoseconds > 0)
        precondition(timeoutNanoseconds <= 60_000_000_000)
        timeout = CaptureBoundedCallbackTimeout(
            label: label,
            timeoutNanoseconds: timeoutNanoseconds
        )
        self.timerQueue = timerQueue
        self.timeoutAction = timeoutAction
    }

    func arm() {
        let deadline = DispatchTime.now().uptimeNanoseconds
            .addingReportingOverflow(timeout.timeoutNanoseconds)
        precondition(!deadline.overflow)
        let workItem = DispatchWorkItem { [weak self] in
            self?.fire()
        }

        lock.lock()
        guard case .idle = state else {
            lock.unlock()
            preconditionFailure("A process deadline watchdog can arm only once.")
        }
        state = .armed(
            deadlineNanoseconds: deadline.partialValue,
            workItem: workItem
        )
        lock.unlock()

        timerQueue.asyncAfter(
            deadline: DispatchTime(
                uptimeNanoseconds: deadline.partialValue
            ),
            execute: workItem
        )
    }

    /// Returns true only when completion beat the absolute deadline.
    ///
    /// The timeout action runs while arbitration remains locked. Production
    /// exits from that action; a returning test action leaves a stable `.fired`
    /// state that a late native return cannot disarm.
    @discardableResult
    func disarm() -> Bool {
        lock.lock()
        switch state {
        case .armed(let deadlineNanoseconds, let workItem):
            if DispatchTime.now().uptimeNanoseconds >= deadlineNanoseconds {
                state = .fired
                workItem.cancel()
                timeoutAction(timeout)
                lock.unlock()
                return false
            }
            state = .disarmed
            workItem.cancel()
            lock.unlock()
            return true
        case .fired:
            lock.unlock()
            return false
        case .idle:
            lock.unlock()
            preconditionFailure(
                "A process deadline watchdog cannot disarm before arming."
            )
        case .disarmed:
            lock.unlock()
            preconditionFailure(
                "A process deadline watchdog cannot disarm more than once."
            )
        }
    }

    private func fire() {
        lock.lock()
        guard case .armed = state else {
            lock.unlock()
            return
        }
        state = .fired
        timeoutAction(timeout)
        lock.unlock()
    }
}

private final class CaptureBoundedCallbackResolution<
    Success: Sendable,
    Failure: Error & Sendable
>: @unchecked Sendable {
    typealias Outcome = CaptureBoundedCallbackWaitResult<Success, Failure>

    private let lock = NSLock()
    private let continuation: CheckedContinuation<Outcome, Never>
    private var resolved = false
    private var timeoutWorkItem: DispatchWorkItem?

    init(continuation: CheckedContinuation<Outcome, Never>) {
        self.continuation = continuation
    }

    func install(timeoutWorkItem: DispatchWorkItem) {
        lock.lock()
        if resolved {
            lock.unlock()
            timeoutWorkItem.cancel()
            return
        }
        self.timeoutWorkItem = timeoutWorkItem
        lock.unlock()
    }

    func resolveCallback(
        _ outcome: Outcome,
        deadlineNanoseconds: UInt64,
        timeout: CaptureBoundedCallbackTimeout,
        timeoutAction: @Sendable (CaptureBoundedCallbackTimeout) -> Void
    ) {
        lock.lock()
        guard !resolved else {
            lock.unlock()
            return
        }
        let missedDeadline =
            DispatchTime.now().uptimeNanoseconds >= deadlineNanoseconds
        resolved = true
        let pendingTimeout = timeoutWorkItem
        timeoutWorkItem = nil
        lock.unlock()
        pendingTimeout?.cancel()
        if missedDeadline {
            timeoutAction(timeout)
            continuation.resume(returning: .timedOut)
        } else {
            continuation.resume(returning: outcome)
        }
    }

    func resolveTimeout(
        _ timeout: CaptureBoundedCallbackTimeout,
        action: @Sendable (CaptureBoundedCallbackTimeout) -> Void
    ) {
        guard claimResolution() else { return }
        // The production action terminates the dedicated helper and therefore
        // never reaches the resume. Tests inject a returning action to prove
        // timeout arbitration without killing the harness process.
        action(timeout)
        continuation.resume(returning: .timedOut)
    }

    private func claimResolution() -> Bool {
        lock.lock()
        guard !resolved else {
            lock.unlock()
            return false
        }
        resolved = true
        let pendingTimeout = timeoutWorkItem
        timeoutWorkItem = nil
        lock.unlock()
        pendingTimeout?.cancel()
        return true
    }
}

/// Adapts one native callback into an async result with a real deadline.
///
/// The timeout action runs after winning arbitration and before the awaiting
/// caller is resumed. Capture uses a non-returning process-termination action;
/// deterministic harnesses can inject a returning observer.
enum CaptureBoundedCallbackWaiter {
    static func wait<
        Success: Sendable,
        Failure: Error & Sendable
    >(
        label: String,
        timeoutNanoseconds: UInt64,
        timeoutAction: @escaping @Sendable (CaptureBoundedCallbackTimeout) -> Void,
        start: @escaping @Sendable (
            @escaping @Sendable (Result<Success, Failure>) -> Void
        ) -> Void
    ) async -> CaptureBoundedCallbackWaitResult<Success, Failure> {
        precondition(!label.isEmpty)
        precondition(label.utf8.count <= 256)
        precondition(timeoutNanoseconds > 0)
        precondition(timeoutNanoseconds <= 60_000_000_000)

        let timeout = CaptureBoundedCallbackTimeout(
            label: label,
            timeoutNanoseconds: timeoutNanoseconds
        )
        let deadline = DispatchTime.now().uptimeNanoseconds
            .addingReportingOverflow(timeoutNanoseconds)
        precondition(!deadline.overflow)
        return await withCheckedContinuation { continuation in
            let resolution = CaptureBoundedCallbackResolution<
                Success,
                Failure
            >(continuation: continuation)
            let timeoutWorkItem = DispatchWorkItem {
                resolution.resolveTimeout(timeout, action: timeoutAction)
            }
            resolution.install(timeoutWorkItem: timeoutWorkItem)
            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: DispatchTime(uptimeNanoseconds: deadline.partialValue),
                execute: timeoutWorkItem
            )
            start { result in
                switch result {
                case .success(let value):
                    resolution.resolveCallback(
                        .success(value),
                        deadlineNanoseconds: deadline.partialValue,
                        timeout: timeout,
                        timeoutAction: timeoutAction
                    )
                case .failure(let error):
                    resolution.resolveCallback(
                        .failure(error),
                        deadlineNanoseconds: deadline.partialValue,
                        timeout: timeout,
                        timeoutAction: timeoutAction
                    )
                }
            }
        }
    }
}

struct CaptureIndexedDrainOperation<
    Index: Comparable & Hashable & Sendable,
    Success: Sendable,
    Failure: Error & Sendable
>: Sendable {
    let index: Index
    let isPrimary: Bool
    let operation: @Sendable () async -> Result<Success, Failure>
}

struct CaptureIndexedDrainOutcome<
    Index: Comparable & Hashable & Sendable,
    Success: Sendable,
    Failure: Error & Sendable
>: Sendable {
    let index: Index
    let isPrimary: Bool
    let result: Result<Success, Failure>
}

/// Runs every cleanup operation and returns outcomes in deterministic order.
///
/// Failures remain values, so one native failure cannot cancel sibling drains.
func captureDrainIndexed<
    Index: Comparable & Hashable & Sendable,
    Success: Sendable,
    Failure: Error & Sendable
>(
    _ operations: [
        CaptureIndexedDrainOperation<Index, Success, Failure>
    ]
) async -> [CaptureIndexedDrainOutcome<Index, Success, Failure>] {
    precondition(Set(operations.map(\.index)).count == operations.count)
    return await withTaskGroup(
        of: CaptureIndexedDrainOutcome<Index, Success, Failure>.self,
        returning: [CaptureIndexedDrainOutcome<Index, Success, Failure>].self
    ) { group in
        for operation in operations {
            group.addTask {
                CaptureIndexedDrainOutcome(
                    index: operation.index,
                    isPrimary: operation.isPrimary,
                    result: await operation.operation()
                )
            }
        }
        var outcomes: [
            CaptureIndexedDrainOutcome<Index, Success, Failure>
        ] = []
        outcomes.reserveCapacity(operations.count)
        for await outcome in group {
            outcomes.append(outcome)
        }
        return outcomes.sorted { $0.index < $1.index }
    }
}

/// Selects the primary failure, or the lowest-index failure when the primary
/// operation succeeded.
func capturePreferredDrainFailure<
    Index: Comparable & Hashable & Sendable,
    Success: Sendable,
    Failure: Error & Sendable
>(
    _ outcomes: [CaptureIndexedDrainOutcome<Index, Success, Failure>]
) -> Failure? {
    let failures = outcomes.compactMap {
        outcome -> (index: Index, isPrimary: Bool, failure: Failure)? in
        guard case .failure(let failure) = outcome.result else { return nil }
        return (outcome.index, outcome.isPrimary, failure)
    }
    return failures
        .filter(\.isPrimary)
        .min { $0.index < $1.index }?
        .failure
        ?? failures.min { $0.index < $1.index }?.failure
}

private final class CaptureSingleFlightLaunchBarrier: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiter: CheckedContinuation<Void, Never>?

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if opened {
                lock.unlock()
                continuation.resume()
                return
            }
            precondition(waiter == nil)
            waiter = continuation
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
        let pending = waiter
        waiter = nil
        lock.unlock()
        pending?.resume()
    }
}

/// Runs one shared asynchronous operation and retains its typed outcome.
///
/// The shared task is detached from every waiter, so cancelling any caller
/// cannot cancel native cleanup already in flight. The operation must not call
/// back into the same single-flight instance.
final class CaptureSingleFlight<Success: Sendable, Failure: Error & Sendable>:
    @unchecked Sendable
{
    typealias Outcome = Result<Success, Failure>

    private enum State {
        case idle
        case running(generation: UInt64, task: Task<Outcome, Never>)
        case completed(Outcome)
    }

    private enum Awaitable {
        case task(Task<Outcome, Never>)
        case value(Outcome)
    }

    private let lock = NSLock()
    private var nextGeneration: UInt64 = 0
    private var state: State = .idle

    func run(
        _ operation: @escaping @Sendable () async -> Outcome
    ) async -> Outcome {
        switch startOrReuse(operation) {
        case .task(let task):
            return await task.value
        case .value(let outcome):
            return outcome
        }
    }

    private func startOrReuse(
        _ operation: @escaping @Sendable () async -> Outcome
    ) -> Awaitable {
        lock.lock()
        defer { lock.unlock() }

        switch state {
        case .idle:
            nextGeneration &+= 1
            let generation = nextGeneration
            let launchBarrier = CaptureSingleFlightLaunchBarrier()
            let task = Task.detached(priority: nil) { [weak self] in
                await launchBarrier.wait()
                let outcome = await operation()
                self?.complete(outcome, generation: generation)
                return outcome
            }
            state = .running(generation: generation, task: task)
            // The task cannot complete before the running state is visible.
            launchBarrier.open()
            return .task(task)
        case .running(_, let task):
            return .task(task)
        case .completed(let outcome):
            return .value(outcome)
        }
    }

    private func complete(_ outcome: Outcome, generation: UInt64) {
        lock.lock()
        defer { lock.unlock() }

        guard case .running(let activeGeneration, _) = state,
              activeGeneration == generation else {
            return
        }
        // Dropping the task handle here also breaks the temporary retention
        // chain when an operation captures the recorder that owns this flight.
        state = .completed(outcome)
    }
}

extension CaptureSingleFlight where Failure == Never {
    func runInfallible(
        _ operation: @escaping @Sendable () async -> Success
    ) async -> Success {
        let outcome = await run {
            .success(await operation())
        }
        switch outcome {
        case .success(let value):
            return value
        case .failure(let impossible):
            switch impossible {}
        }
    }
}
