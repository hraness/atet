import Foundation

enum CaptureInterruptionReportResult: Equatable, Sendable {
    case submitted(CaptureInterruptionSeed)
    case alreadyReported(CaptureInterruptionSeed)
    case sealed(CaptureInterruptionSeed?)
    case invalid
}

enum CaptureInterruptionReporterSealResult: Equatable, Sendable {
    case sealed(CaptureInterruptionSeed?)
    case alreadySealed(CaptureInterruptionSeed?)
}

enum CaptureTerminalInterruptionPublicationResult:
    Equatable,
    Sendable {
    case duplicateTerminal
    case published(CaptureInterruptionReportResult)
}

typealias CaptureInterruptionSubmit =
    @Sendable (CaptureInterruptionSeed) -> Void
typealias CaptureInterruptionObserverTeardown = @Sendable () -> Void

private final class CaptureInterruptionTeardownSettlement:
    @unchecked Sendable {
    private let condition = NSCondition()
    private var completed = false

    func complete() {
        condition.lock()
        precondition(!completed)
        completed = true
        condition.broadcast()
        condition.unlock()
    }

    func wait() {
        condition.lock()
        while !completed {
            condition.wait()
        }
        condition.unlock()
    }
}

final class CaptureInterruptionObserverCancellation:
    @unchecked Sendable {
    private let lock = NSLock()
    private var action: (() -> Void)?

    init(_ action: @escaping () -> Void) {
        self.action = action
    }

    @discardableResult
    func cancel() -> Bool {
        lock.lock()
        guard let action else {
            lock.unlock()
            return false
        }
        self.action = nil
        lock.unlock()
        action()
        return true
    }

    deinit {
        cancel()
    }
}

/// A segment-scoped, first-winner interruption boundary.
///
/// Native callbacks synchronously submit at most one validated seed into the
/// controller finalization engine. They never write protocol output. `seal()`
/// linearizes after any in-flight submit and synchronously unregisters every
/// attached observer before it returns.
final class CaptureInterruptionReporter: @unchecked Sendable {
    private enum Phase {
        case open
        case reported(CaptureInterruptionSeed)
        case sealing(
            CaptureInterruptionSeed?,
            CaptureInterruptionTeardownSettlement
        )
        case sealed(CaptureInterruptionSeed?)
    }

    private let lock = NSLock()
    private let segmentIndex: Int
    private let clock: @Sendable () -> UInt64
    private let submit: CaptureInterruptionSubmit
    private var phase: Phase = .open
    private var observerTeardowns: [CaptureInterruptionObserverTeardown] = []

    init(
        segmentIndex: Int,
        clock: @escaping @Sendable () -> UInt64 = {
            monotonicMicroseconds()
        },
        submit: @escaping CaptureInterruptionSubmit
    ) {
        precondition(
            segmentIndex >= 0 && segmentIndex < maximumCaptureSegments
        )
        self.segmentIndex = segmentIndex
        self.clock = clock
        self.submit = submit
    }

    @discardableResult
    func report(
        incident: CaptureInterruptionIncident,
        sourceId: String?
    ) -> CaptureInterruptionReportResult {
        let seed: CaptureInterruptionSeed
        do {
            seed = try CaptureInterruptionSeed(
                segmentIndex: segmentIndex,
                incident: incident,
                sourceId: sourceId,
                nativeTimeUs: clock()
            )
        } catch {
            return .invalid
        }

        lock.lock()
        switch phase {
        case .open:
            phase = .reported(seed)
            // Submit while holding the reporter lock. A concurrent seal cannot
            // return while this call is still entering the finalization engine.
            submit(seed)
            lock.unlock()
            return .submitted(seed)
        case .reported(let winner):
            lock.unlock()
            return .alreadyReported(winner)
        case .sealing(let winner, _):
            lock.unlock()
            return .sealed(winner)
        case .sealed(let winner):
            lock.unlock()
            return .sealed(winner)
        }
    }

    /// Attaches an observer removal action to the segment lifecycle.
    ///
    /// Registration racing with a completed seal is removed immediately, so
    /// a prepared-start teardown cannot leak an observer installed slightly
    /// later by a native start path.
    @discardableResult
    func registerObserverTeardown(
        _ teardown: @escaping CaptureInterruptionObserverTeardown
    ) -> Bool {
        lock.lock()
        switch phase {
        case .open, .reported, .sealing:
            precondition(
                observerTeardowns.count < 64,
                "A capture segment registered too many interruption observers."
            )
            observerTeardowns.append(teardown)
            lock.unlock()
            return true
        case .sealed:
            lock.unlock()
            teardown()
            return false
        }
    }

    @discardableResult
    func seal() -> CaptureInterruptionReporterSealResult {
        let winner: CaptureInterruptionSeed?
        let settlement: CaptureInterruptionTeardownSettlement
        lock.lock()
        switch phase {
        case .open:
            winner = nil
        case .reported(let seed):
            winner = seed
        case .sealing(let seed, let activeSettlement):
            lock.unlock()
            activeSettlement.wait()
            return .alreadySealed(seed)
        case .sealed(let seed):
            lock.unlock()
            return .alreadySealed(seed)
        }
        settlement = CaptureInterruptionTeardownSettlement()
        phase = .sealing(winner, settlement)
        lock.unlock()

        while true {
            let teardowns: [CaptureInterruptionObserverTeardown]
            lock.lock()
            if observerTeardowns.isEmpty {
                // Closing admission and publishing completion share this lock.
                // A racing registration either entered the queue above or
                // observes `.sealed` and removes itself synchronously.
                phase = .sealed(winner)
                settlement.complete()
                lock.unlock()
                return .sealed(winner)
            }
            teardowns = observerTeardowns
            observerTeardowns.removeAll(keepingCapacity: true)
            lock.unlock()
            for teardown in teardowns {
                teardown()
            }
        }
    }
}

/// Bridges the no-await gap between arming a prepared finalizer and creating
/// its scope-bound reporter.
final class CaptureInterruptionReporterRegistration:
    @unchecked Sendable {
    private let lock = NSLock()
    private var reporter: CaptureInterruptionReporter?
    private var sealRequested = false

    func install(_ reporter: CaptureInterruptionReporter) {
        lock.lock()
        precondition(self.reporter == nil)
        self.reporter = reporter
        let shouldSeal = sealRequested
        lock.unlock()
        if shouldSeal {
            reporter.seal()
        }
    }

    func seal() {
        lock.lock()
        sealRequested = true
        let installed = reporter
        lock.unlock()
        installed?.seal()
    }
}

/// Makes terminal media state publication structurally precede interruption
/// submission. Recorder delegates use the same injectable primitive exercised
/// by the strict native harness.
func capturePublishTerminalBeforeInterruption(
    publish: @Sendable () -> Bool,
    reporter: CaptureInterruptionReporter,
    incident: CaptureInterruptionIncident,
    sourceId: String?
) -> CaptureTerminalInterruptionPublicationResult {
    guard publish() else { return .duplicateTerminal }
    return .published(reporter.report(
        incident: incident,
        sourceId: sourceId
    ))
}
