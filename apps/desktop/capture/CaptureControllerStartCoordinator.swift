import Foundation

enum CaptureControllerPreparedProducer: CaseIterable, Hashable, Sendable {
    case metadata
    case screen
    case camera
    case microphone
}

struct CaptureControllerPreparedFailure: Equatable, Sendable {
    let code: String
    let message: String
    let recoverable: Bool
    let state: HelperState

    init(
        code: String,
        message: String,
        recoverable: Bool,
        state: HelperState
    ) {
        precondition(!code.isEmpty)
        precondition(code.utf8.count <= 128)
        precondition(!message.isEmpty)
        precondition(message.utf8.count <= 4_096)
        precondition(!message.contains("\0"))
        self.code = code
        self.message = message
        self.recoverable = recoverable
        self.state = state
    }
}

typealias CaptureControllerPreparedCleanup = @Sendable () async -> Void

private final class CaptureControllerPreparedReadySignal:
    @unchecked Sendable {
    private let lock = NSLock()
    private var ready = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if ready {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func signal() {
        lock.lock()
        guard !ready else {
            lock.unlock()
            return
        }
        ready = true
        let pending = waiters
        waiters.removeAll(keepingCapacity: false)
        lock.unlock()
        for waiter in pending {
            waiter.resume()
        }
    }
}

/// Owns every resource that can resolve while a segment start is suspended.
///
/// A close can begin before native start callbacks return. Each producer
/// publishes its cleanup before leaving the pending set, so the engine-owned
/// drain waits for late successes and then executes one immutable cleanup set.
/// Waiter cancellation never cancels that shared drain.
final class CaptureControllerStartCoordinator: @unchecked Sendable {
    private enum ProducerState {
        case pending
        case completed(CaptureControllerPreparedCleanup?)
    }

    private let lock = NSLock()
    private let readySignal = CaptureControllerPreparedReadySignal()
    private var producers: [
        CaptureControllerPreparedProducer: ProducerState
    ] = Dictionary(
        uniqueKeysWithValues: CaptureControllerPreparedProducer.allCases.map {
            ($0, .pending)
        }
    )
    private var failure: CaptureControllerPreparedFailure
    private var drainTask: Task<CaptureControllerPreparedFailure, Never>?

    init(fallbackFailure: CaptureControllerPreparedFailure) {
        failure = fallbackFailure
    }

    @discardableResult
    func complete(
        _ producer: CaptureControllerPreparedProducer,
        cleanup: CaptureControllerPreparedCleanup? = nil
    ) -> Bool {
        lock.lock()
        guard case .pending? = producers[producer] else {
            lock.unlock()
            return false
        }
        producers[producer] = .completed(cleanup)
        let becameReady = producers.values.allSatisfy {
            if case .completed = $0 { return true }
            return false
        }
        lock.unlock()
        if becameReady {
            readySignal.signal()
        }
        return true
    }

    @discardableResult
    func completeUnstarted(
        _ unstarted: Set<CaptureControllerPreparedProducer>
    ) -> Int {
        precondition(!unstarted.isEmpty)
        var completed = 0
        for producer in unstarted {
            if complete(producer) {
                completed += 1
            }
        }
        return completed
    }

    @discardableResult
    func replaceFailure(
        _ replacement: CaptureControllerPreparedFailure
    ) -> Bool {
        lock.lock()
        guard drainTask == nil else {
            lock.unlock()
            return false
        }
        failure = replacement
        lock.unlock()
        return true
    }

    func drain() async -> CaptureControllerPreparedFailure {
        await readySignal.wait()
        let task = sharedDrainTask()
        return await task.value
    }

    private func sharedDrainTask()
        -> Task<CaptureControllerPreparedFailure, Never> {
        lock.lock()
        defer { lock.unlock() }
        if let drainTask {
            return drainTask
        }
        let cleanupPairs = CaptureControllerPreparedProducer.allCases
            .compactMap {
            producer -> (
                CaptureControllerPreparedProducer,
                CaptureControllerPreparedCleanup
            )? in
            guard case .completed(let cleanup)? = producers[producer] else {
                preconditionFailure(
                    "A prepared start cannot drain before every producer resolves."
                )
            }
            return cleanup.map { (producer, $0) }
        }
        let cleanups = Dictionary(uniqueKeysWithValues: cleanupPairs)
        let resolvedFailure = failure
        let created = Task.detached {
            await withTaskGroup(of: Void.self) { group in
                for producer in [
                    CaptureControllerPreparedProducer.screen,
                    .camera,
                    .microphone,
                ] {
                    guard let cleanup = cleanups[producer] else { continue }
                    group.addTask {
                        await cleanup()
                    }
                }
            }
            // Metadata remains live until every recorder has drained so its
            // closing snapshots bracket every retained media sample.
            if let metadataCleanup = cleanups[.metadata] {
                await metadataCleanup()
            }
            return resolvedFailure
        }
        drainTask = created
        return created
    }
}
