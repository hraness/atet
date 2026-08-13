import Foundation

private let maximumCaptureControllerTombstones = maximumCaptureSegments
private let maximumRequestlessObjectBytes = maximumProtocolLineBytes - 1_024

/// Immutable, canonical JSON fields without the protocol envelope.
///
/// Native finalizers can safely carry this value between tasks. The capture
/// controller adds `event`, `requestId`, and `protocolVersion` only after it
/// owns a delivery lease.
struct CaptureControllerRequestlessObject: Equatable, Sendable {
    private static let envelopeKeys: Set<String> = [
        "event",
        "protocolVersion",
        "requestId",
    ]

    private let canonicalJSON: Data

    init(_ fields: [String: Any]) throws {
        guard Set(fields.keys).isDisjoint(with: Self.envelopeKeys),
              JSONSerialization.isValidJSONObject(fields),
              let data = try? JSONSerialization.data(
                  withJSONObject: fields,
                  options: [.sortedKeys]
              ),
              data.count <= maximumRequestlessObjectBytes else {
            throw CaptureControllerFinalizationError.invalidRequestlessObject
        }
        canonicalJSON = data
    }

    func fields() throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: canonicalJSON)
            as? [String: Any] else {
            throw CaptureControllerFinalizationError.invalidRequestlessObject
        }
        return object
    }

    func protocolObject(event: String, requestId: String) throws -> [String: Any] {
        var object = try fields()
        object["event"] = event
        object["requestId"] = requestId
        return object
    }
}

struct CaptureControllerFinalizationCompletion: Equatable, Sendable {
    let segment: CaptureControllerRequestlessObject
    let interruption: CaptureInterruption?

    init(
        segment: CaptureControllerRequestlessObject,
        interruption: CaptureInterruption? = nil
    ) {
        self.segment = segment
        self.interruption = interruption
    }
}

struct CaptureControllerFinalizationFailure: Equatable, Sendable {
    let code: String
    let message: String
    let recoverable: Bool
    let state: HelperState
    let interruption: CaptureInterruption?

    init(
        code: String,
        message: String,
        recoverable: Bool,
        state: HelperState,
        interruption: CaptureInterruption? = nil
    ) throws {
        guard Self.validCode(code) else {
            throw CaptureControllerFinalizationError.invalidFailureCode
        }
        guard !message.isEmpty,
              message.utf8.count <= 4_096,
              !message.contains("\0") else {
            throw CaptureControllerFinalizationError.invalidFailureMessage
        }
        self.code = code
        self.message = message
        self.recoverable = recoverable
        self.state = state
        self.interruption = interruption
    }

    private static func validCode(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 128 else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 45, 46, 48...57, 58...90, 95, 97...122:
                return true
            default:
                return false
            }
        }
    }
}

enum CaptureControllerFinalizationOutcome: Equatable, Sendable {
    case completion(CaptureControllerFinalizationCompletion)
    case failure(CaptureControllerFinalizationFailure)
}

typealias CaptureControllerFinalizationJob =
    @Sendable (CaptureSegmentClose) async -> CaptureControllerFinalizationOutcome

/// Drains a start that was prepared but never announced.
///
/// Concrete recorders own their native timeouts. This wrapper never abandons a
/// cleanup task merely because the command awaiting it was cancelled.
struct CaptureControllerPreparedStartDrain: Sendable {
    let operation:
        @Sendable (CaptureSegmentClose) async -> CaptureControllerFinalizationFailure

    init(
        operation: @escaping
            @Sendable (CaptureSegmentClose) async -> CaptureControllerFinalizationFailure
    ) {
        self.operation = operation
    }

    fileprivate func run(
        close: CaptureSegmentClose
    ) async -> CaptureControllerFinalizationOutcome {
        .failure(await operation(close))
    }
}

enum CaptureControllerFinalizationError: Error, Equatable {
    case invalidFailureCode
    case invalidFailureMessage
    case invalidRequestlessObject
    case segmentAlreadyOwned
    case tombstoneCapacityExceeded
    case tokenExhausted
}

enum CaptureControllerFinalizationPhase: String, Equatable, Sendable {
    case none
    case prepared
    case announcing
    case active
    case finalizing
    case deferred
    case deliveryUncertain = "delivery-uncertain"
}

struct CaptureControllerStartAnnouncementToken: Equatable, Sendable {
    fileprivate let value: UInt64
    let scope: CaptureSegmentCloseScope
}

/// One-shot wakeup shared by every waiter that linearized against an
/// announcement-owned close.
///
/// Waiter cancellation never cancels or removes the wakeup. A cancelled
/// command therefore still rejoins the engine-owned finalizer after the
/// synchronous protocol writer eventually reports its disposition.
private final class CaptureControllerAnnouncementSettlement:
    @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if settled {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func settle() {
        lock.lock()
        guard !settled else {
            lock.unlock()
            return
        }
        settled = true
        let pending = waiters
        waiters.removeAll(keepingCapacity: false)
        lock.unlock()
        for waiter in pending {
            waiter.resume()
        }
    }
}

enum CaptureControllerStartAnnouncementBeginResult: Equatable, Sendable {
    case began(CaptureControllerStartAnnouncementToken)
    case alreadyAnnouncing(CaptureControllerStartAnnouncementToken)
    case alreadyActive
    case closed(CaptureSegmentClose)
    case inactive
    case stale(activeScope: CaptureSegmentCloseScope)
    case deliveryUncertain(CaptureSegmentClose?)
}

enum CaptureControllerStartAnnouncementDisposition: Equatable, Sendable {
    case confirmed
    case rejectedBeforeWrite
    case uncertainPartialOrWriterFailure
}

enum CaptureControllerStartAnnouncementFinishResult: Equatable, Sendable {
    case activated
    case finalizing(CaptureSegmentClose)
    case deliveryUncertain(CaptureSegmentClose)
    case alreadyFinished
    case inactive
    case staleToken
}

enum CaptureControllerFinalizationBeginResult: Equatable, Sendable {
    case launched(CaptureSegmentClose)
    case queuedDuringAnnouncement(CaptureSegmentClose)
    case alreadyFinalizing(CaptureSegmentClose)
    case alreadyDeferred(CaptureSegmentClose)
    case inactive
    case stale(activeScope: CaptureSegmentCloseScope)
    case deliveryUncertain(CaptureSegmentClose?)
}

enum CaptureControllerFinalizationSettleResult: Equatable, Sendable {
    case committed
    case alreadyCommitted
    case notFinalizing
    case inactive
    case conflictingClose
    case retirementMismatch
    case stale(activeScope: CaptureSegmentCloseScope)
}

enum CaptureControllerDeliveryRequest: Equatable, Sendable {
    /// Status or snapshot: reserve the outcome that already exists at entry.
    case observe
    /// Resume: flush an old generation before synchronously preparing a new one.
    case flush
    /// Pause, stop, or shutdown: claim and reserve the one finalizer atomically.
    case close(
        scope: CaptureSegmentCloseScope,
        reason: CaptureSegmentRequestedCloseReason
    )
    /// Process termination owns no stdout and may discard uncertain evidence.
    case termination(scope: CaptureSegmentCloseScope?)
}

fileprivate final class CaptureControllerDeliveryLeaseIdentity:
    @unchecked Sendable {}

struct CaptureControllerDeliveryLease: Equatable, Sendable {
    fileprivate let identity: CaptureControllerDeliveryLeaseIdentity
    fileprivate let value: UInt64
    fileprivate let permitsTerminationDiscard: Bool

    static func == (
        lhs: CaptureControllerDeliveryLease,
        rhs: CaptureControllerDeliveryLease
    ) -> Bool {
        lhs.identity === rhs.identity
            && lhs.value == rhs.value
            && lhs.permitsTerminationDiscard == rhs.permitsTerminationDiscard
    }
}

enum CaptureControllerDeliveryReservationResult: Equatable, Sendable {
    case reserved(CaptureControllerDeliveryLease)
    case busy
    case inactive
    case closed(CaptureSegmentClose)
    case stale(activeScope: CaptureSegmentCloseScope)
    case deliveryUncertain(CaptureSegmentClose?)
}

struct CaptureControllerReservedFinalization: Equatable, Sendable {
    let close: CaptureSegmentClose
    let outcome: CaptureControllerFinalizationOutcome
}

enum CaptureControllerDeliveryAwaitResult: Equatable, Sendable {
    case noOutcome
    case outcome(CaptureControllerReservedFinalization)
    case deliveryUncertain(CaptureSegmentClose?)
    case invalidLease
}

enum CaptureControllerDeliveryDisposition: Equatable, Sendable {
    case confirmed
    case rejectedBeforeWrite
    case uncertainPartialOrWriterFailure
    case terminationDiscard
}

enum CaptureControllerDeliveryCompletionResult: Equatable, Sendable {
    case confirmed
    case releasedPreservingEvidence
    case enteredDeliveryUncertain
    case discarded
    case notReady
    case forbidden
    case invalidLease
}

final class CaptureControllerFinalization: @unchecked Sendable {
    private struct PreparedOwnership {
        let gate: CaptureSegmentCloseGate
        let scope: CaptureSegmentCloseScope
        let drain: CaptureControllerPreparedStartDrain
    }

    private struct AnnouncingOwnership {
        let token: CaptureControllerStartAnnouncementToken
        let gate: CaptureSegmentCloseGate
        let scope: CaptureSegmentCloseScope
        let drain: CaptureControllerPreparedStartDrain
        let activeJob: CaptureControllerFinalizationJob
        let settlement: CaptureControllerAnnouncementSettlement
        var queuedClose: CaptureSegmentClose?
    }

    private struct ActiveOwnership {
        let gate: CaptureSegmentCloseGate
        let scope: CaptureSegmentCloseScope
        let job: CaptureControllerFinalizationJob
    }

    private struct FinalizingOwnership {
        let gate: CaptureSegmentCloseGate
        let close: CaptureSegmentClose
        let task: Task<CaptureControllerFinalizationOutcome, Never>
    }

    private struct DeferredOwnership {
        let gate: CaptureSegmentCloseGate
        let close: CaptureSegmentClose
        let retiredClose: CaptureSegmentClose
        let outcome: CaptureControllerFinalizationOutcome
    }

    private struct DeliveryUncertainOwnership {
        let gate: CaptureSegmentCloseGate?
        let close: CaptureSegmentClose?
        let task: Task<CaptureControllerFinalizationOutcome, Never>?
        let retiredClose: CaptureSegmentClose?
        let outcome: CaptureControllerFinalizationOutcome?
    }

    private struct ClosedGeneration {
        let gate: CaptureSegmentCloseGate
        let close: CaptureSegmentClose
    }

    private enum SegmentOwnership {
        case none
        case prepared(PreparedOwnership)
        case announcing(AnnouncingOwnership)
        case active(ActiveOwnership)
        case finalizing(FinalizingOwnership)
        case deferred(DeferredOwnership)
        case deliveryUncertain(DeliveryUncertainOwnership)
    }

    private enum ReservationBinding {
        /// The reservation observed no already-owned close at its entry point.
        case noOutcome
        /// The reservation exclusively owns delivery of this closed generation.
        case generation(CaptureSegmentClose)
        /// Only a termination reservation can own uncertain evidence.
        case uncertainty(CaptureSegmentClose?)
    }

    private struct DeliveryReservation {
        let lease: CaptureControllerDeliveryLease
        let binding: ReservationBinding
    }

    private struct Launch {
        let gate: CaptureSegmentCloseGate
        let close: CaptureSegmentClose
        let task: Task<CaptureControllerFinalizationOutcome, Never>
    }

    /// Lock ordering is engine -> close gate -> timeline. The engine never
    /// retains its lock across protocol I/O or an asynchronous recorder drain.
    private let lock = NSLock()
    private var ownership: SegmentOwnership = .none
    private var reservation: DeliveryReservation?
    private var tombstones: [ClosedGeneration] = []
    private let deliveryLeaseIdentity =
        CaptureControllerDeliveryLeaseIdentity()
    private var nextAnnouncementToken: UInt64 = 0
    private var nextDeliveryToken: UInt64 = 0

    var phase: CaptureControllerFinalizationPhase {
        lock.lock()
        defer { lock.unlock() }
        switch ownership {
        case .none:
            return .none
        case .prepared:
            return .prepared
        case .announcing:
            return .announcing
        case .active:
            return .active
        case .finalizing:
            return .finalizing
        case .deferred:
            return .deferred
        case .deliveryUncertain:
            return .deliveryUncertain
        }
    }

    func beginPreparedStart(
        gate: CaptureSegmentCloseGate,
        segmentIndex: Int,
        drain: CaptureControllerPreparedStartDrain
    ) throws -> CaptureSegmentCloseScope {
        lock.lock()
        defer { lock.unlock() }
        guard case .none = ownership else {
            throw CaptureControllerFinalizationError.segmentAlreadyOwned
        }
        guard reservation == nil else {
            throw CaptureControllerFinalizationError.segmentAlreadyOwned
        }
        guard tombstones.count < maximumCaptureControllerTombstones else {
            throw CaptureControllerFinalizationError.tombstoneCapacityExceeded
        }
        let scope = try gate.arm(segmentIndex: segmentIndex)
        ownership = .prepared(PreparedOwnership(
            gate: gate,
            scope: scope,
            drain: drain
        ))
        return scope
    }

    /// Takes the announcement lease without writing stdout.
    ///
    /// The caller writes `segment-started` outside the engine lock and then
    /// finishes the token. A close arriving between those calls is frozen and
    /// queued; its recorder drain starts only after the delivery result is
    /// known.
    func beginStartAnnouncement(
        scope: CaptureSegmentCloseScope,
        activeJob: @escaping CaptureControllerFinalizationJob
    ) throws -> CaptureControllerStartAnnouncementBeginResult {
        lock.lock()
        defer { lock.unlock() }
        switch ownership {
        case .none:
            if let tombstone = tombstone(scope: scope) {
                return .closed(tombstone.close)
            }
            return .inactive
        case .prepared(let prepared):
            guard prepared.scope == scope else {
                return .stale(activeScope: prepared.scope)
            }
            let token = try makeAnnouncementToken(scope: scope)
            ownership = .announcing(AnnouncingOwnership(
                token: token,
                gate: prepared.gate,
                scope: prepared.scope,
                drain: prepared.drain,
                activeJob: activeJob,
                settlement: CaptureControllerAnnouncementSettlement(),
                queuedClose: nil
            ))
            return .began(token)
        case .announcing(let announcing):
            guard announcing.scope == scope else {
                return .stale(activeScope: announcing.scope)
            }
            return .alreadyAnnouncing(announcing.token)
        case .active(let active):
            guard active.scope == scope else {
                return .stale(activeScope: active.scope)
            }
            return .alreadyActive
        case .finalizing(let finalizing):
            guard finalizing.close.scope == scope else {
                return .stale(activeScope: finalizing.close.scope)
            }
            return .closed(finalizing.close)
        case .deferred(let deferred):
            guard deferred.close.scope == scope else {
                return .stale(activeScope: deferred.close.scope)
            }
            return .closed(deferred.close)
        case .deliveryUncertain(let uncertain):
            return .deliveryUncertain(uncertain.close)
        }
    }

    func finishStartAnnouncement(
        token: CaptureControllerStartAnnouncementToken,
        disposition: CaptureControllerStartAnnouncementDisposition
    ) throws -> CaptureControllerStartAnnouncementFinishResult {
        var launch: Launch?
        var announcementSettlement: CaptureControllerAnnouncementSettlement?
        let result: CaptureControllerStartAnnouncementFinishResult

        lock.lock()
        do {
            guard case .announcing(let announcing) = ownership else {
                if activeScope() == token.scope || tombstone(scope: token.scope) != nil {
                    result = .alreadyFinished
                } else {
                    result = .inactive
                }
                lock.unlock()
                return result
            }
            guard announcing.token == token else {
                lock.unlock()
                return .staleToken
            }
            announcementSettlement = announcing.settlement

            switch disposition {
            case .confirmed:
                if let close = announcing.queuedClose {
                    let created = makeLaunch(
                        gate: announcing.gate,
                        close: close,
                        job: announcing.activeJob
                    )
                    ownership = .finalizing(FinalizingOwnership(
                        gate: created.gate,
                        close: created.close,
                        task: created.task
                    ))
                    launch = created
                    result = .finalizing(close)
                } else {
                    ownership = .active(ActiveOwnership(
                        gate: announcing.gate,
                        scope: announcing.scope,
                        job: announcing.activeJob
                    ))
                    result = .activated
                }
            case .rejectedBeforeWrite, .uncertainPartialOrWriterFailure:
                let close: CaptureSegmentClose
                if let queued = announcing.queuedClose {
                    close = queued
                } else {
                    close = try acceptedClose(from: announcing.gate.claimRequested(
                        scope: announcing.scope,
                        reason: .startFailure
                    ))
                }
                let uncertain =
                    disposition == .uncertainPartialOrWriterFailure
                let created = makeLaunch(
                    gate: announcing.gate,
                    close: close,
                    job: { close in
                        await announcing.drain.run(close: close)
                    }
                )
                if uncertain {
                    ownership = .deliveryUncertain(DeliveryUncertainOwnership(
                        gate: created.gate,
                        close: created.close,
                        task: created.task,
                        retiredClose: nil,
                        outcome: nil
                    ))
                    result = .deliveryUncertain(close)
                } else {
                    ownership = .finalizing(FinalizingOwnership(
                        gate: created.gate,
                        close: created.close,
                        task: created.task
                    ))
                    result = .finalizing(close)
                }
                launch = created
            }
        } catch {
            lock.unlock()
            throw error
        }
        lock.unlock()
        announcementSettlement?.settle()
        if let launch {
            observe(launch)
        }
        return result
    }

    func acceptInterruption(
        scope: CaptureSegmentCloseScope,
        seed: CaptureInterruptionSeed
    ) throws -> CaptureControllerFinalizationBeginResult {
        try beginClose(scope: scope) { gate in
            try gate.claimInterruption(scope: scope, seed: seed)
        }
    }

    func requestClose(
        scope: CaptureSegmentCloseScope,
        reason: CaptureSegmentRequestedCloseReason
    ) throws -> CaptureControllerFinalizationBeginResult {
        try beginClose(scope: scope) { gate in
            try gate.claimRequested(scope: scope, reason: reason)
        }
    }

    private func beginClose(
        scope: CaptureSegmentCloseScope,
        claim: (CaptureSegmentCloseGate) throws -> CaptureSegmentCloseClaimResult
    ) throws -> CaptureControllerFinalizationBeginResult {
        var launch: Launch?
        let result: CaptureControllerFinalizationBeginResult
        lock.lock()
        do {
            switch ownership {
            case .none:
                if let tombstone = tombstone(scope: scope) {
                    result = .alreadyDeferred(tombstone.close)
                } else {
                    result = .inactive
                }
            case .prepared(let prepared):
                guard prepared.scope == scope else {
                    result = .stale(activeScope: prepared.scope)
                    break
                }
                let close = try acceptedClose(from: claim(prepared.gate))
                let created = makeLaunch(
                    gate: prepared.gate,
                    close: close,
                    job: { close in await prepared.drain.run(close: close) }
                )
                ownership = .finalizing(FinalizingOwnership(
                    gate: created.gate,
                    close: created.close,
                    task: created.task
                ))
                launch = created
                result = .launched(close)
            case .announcing(var announcing):
                guard announcing.scope == scope else {
                    result = .stale(activeScope: announcing.scope)
                    break
                }
                let close = try acceptedClose(from: claim(announcing.gate))
                announcing.queuedClose = close
                ownership = .announcing(announcing)
                result = .queuedDuringAnnouncement(close)
            case .active(let active):
                guard active.scope == scope else {
                    result = .stale(activeScope: active.scope)
                    break
                }
                let close = try acceptedClose(from: claim(active.gate))
                let created = makeLaunch(
                    gate: active.gate,
                    close: close,
                    job: active.job
                )
                ownership = .finalizing(FinalizingOwnership(
                    gate: created.gate,
                    close: created.close,
                    task: created.task
                ))
                launch = created
                result = .launched(close)
            case .finalizing(let finalizing):
                guard finalizing.close.scope == scope else {
                    result = .stale(activeScope: finalizing.close.scope)
                    break
                }
                result = .alreadyFinalizing(finalizing.close)
            case .deferred(let deferred):
                guard deferred.close.scope == scope else {
                    result = .stale(activeScope: deferred.close.scope)
                    break
                }
                result = .alreadyDeferred(deferred.close)
            case .deliveryUncertain(let uncertain):
                result = .deliveryUncertain(uncertain.close)
            }
        } catch {
            lock.unlock()
            throw error
        }
        lock.unlock()
        if let launch {
            observe(launch)
        }
        return result
    }

    /// Reserves protocol delivery at command entry.
    ///
    /// A reservation binds either the already-owned generation or an immutable
    /// no-outcome boundary. An incident that arrives after a no-outcome
    /// reservation remains deferred for a later command.
    func reserveDelivery(
        _ request: CaptureControllerDeliveryRequest
    ) throws -> CaptureControllerDeliveryReservationResult {
        var launch: Launch?
        let result: CaptureControllerDeliveryReservationResult
        lock.lock()
        do {
            guard reservation == nil else {
                lock.unlock()
                return .busy
            }
            switch request {
            case .observe, .flush:
                result = try reserveObservedDelivery(
                    permitsTerminationDiscard: false
                )
            case .close(let scope, let reason):
                let reserved = try reserveRequestedClose(
                    scope: scope,
                    reason: reason,
                    permitsTerminationDiscard: false
                )
                result = reserved.result
                launch = reserved.launch
            case .termination:
                if case .deliveryUncertain(let uncertain) = ownership {
                    let lease = try makeDeliveryLease(
                        permitsTerminationDiscard: true
                    )
                    reservation = DeliveryReservation(
                        lease: lease,
                        binding: .uncertainty(uncertain.close)
                    )
                    result = .reserved(lease)
                } else if let scope = activeScope() {
                    // The caller's scope is only a snapshot. Termination must
                    // always drain the generation that is current at this
                    // linearization point, including a resumed generation.
                    let reserved = try reserveRequestedClose(
                        scope: scope,
                        reason: .termination,
                        permitsTerminationDiscard: true
                    )
                    result = reserved.result
                    launch = reserved.launch
                } else {
                    let lease = try makeDeliveryLease(
                        permitsTerminationDiscard: true
                    )
                    reservation = DeliveryReservation(
                        lease: lease,
                        binding: .noOutcome
                    )
                    result = .reserved(lease)
                }
            }
        } catch {
            lock.unlock()
            throw error
        }
        lock.unlock()
        if let launch {
            observe(launch)
        }
        return result
    }

    /// Awaits only the shared finalizer Task selected by the reservation.
    ///
    /// There are no command-owned continuations and caller cancellation cannot
    /// cancel the engine-owned recorder drain.
    func awaitDelivery(
        _ lease: CaptureControllerDeliveryLease
    ) async -> CaptureControllerDeliveryAwaitResult {
        while true {
            let snapshot = deliveryAwaitSnapshot(lease)
            switch snapshot {
            case .result(let result):
                return result
            case .task(let close, let task):
                let outcome = await task.value
                _ = settle(close: close, outcome: outcome)
            case .announcementPending(let settlement):
                await settlement.wait()
            }
        }
    }

    func completeDelivery(
        _ lease: CaptureControllerDeliveryLease,
        disposition: CaptureControllerDeliveryDisposition
    ) throws -> CaptureControllerDeliveryCompletionResult {
        var launch: Launch?
        let result: CaptureControllerDeliveryCompletionResult
        lock.lock()
        do {
            guard let current = reservation, current.lease == lease else {
                lock.unlock()
                return .invalidLease
            }

            switch disposition {
            case .confirmed:
                result = completeConfirmed(current)
            case .rejectedBeforeWrite:
                reservation = nil
                result = .releasedPreservingEvidence
            case .uncertainPartialOrWriterFailure:
                let converted = try enterDeliveryUncertain(from: current)
                launch = converted.launch
                if converted.result != .notReady {
                    reservation = nil
                }
                result = converted.result
            case .terminationDiscard:
                guard lease.permitsTerminationDiscard else {
                    result = .forbidden
                    break
                }
                result = completeTerminationDiscard(current)
            }
        } catch {
            lock.unlock()
            throw error
        }
        lock.unlock()
        if let launch {
            observe(launch)
        }
        return result
    }

    @discardableResult
    private func settle(
        close: CaptureSegmentClose,
        outcome: CaptureControllerFinalizationOutcome
    ) -> CaptureControllerFinalizationSettleResult {
        lock.lock()
        defer { lock.unlock() }
        switch ownership {
        case .none:
            return tombstone(scope: close.scope) == nil
                ? .inactive
                : .alreadyCommitted
        case .prepared(let prepared):
            return prepared.scope == close.scope
                ? .notFinalizing
                : .stale(activeScope: prepared.scope)
        case .announcing(let announcing):
            return announcing.scope == close.scope
                ? .notFinalizing
                : .stale(activeScope: announcing.scope)
        case .active(let active):
            return active.scope == close.scope
                ? .notFinalizing
                : .stale(activeScope: active.scope)
        case .finalizing(let finalizing):
            guard finalizing.close.scope == close.scope else {
                return .stale(activeScope: finalizing.close.scope)
            }
            guard finalizing.close == close else {
                return .conflictingClose
            }
            let retirement = retire(
                gate: finalizing.gate,
                close: close,
                outcome: outcome
            )
            ownership = .deferred(DeferredOwnership(
                gate: finalizing.gate,
                close: close,
                retiredClose: retirement.close,
                outcome: retirement.outcome
            ))
            return retirement.result
        case .deferred(let deferred):
            guard deferred.close.scope == close.scope else {
                return .stale(activeScope: deferred.close.scope)
            }
            return deferred.close == close
                ? .alreadyCommitted
                : .conflictingClose
        case .deliveryUncertain(let uncertain):
            guard let uncertainClose = uncertain.close else {
                return .inactive
            }
            guard uncertainClose.scope == close.scope else {
                return .stale(activeScope: uncertainClose.scope)
            }
            guard uncertainClose == close else {
                return .conflictingClose
            }
            guard uncertain.outcome == nil, let gate = uncertain.gate else {
                return .alreadyCommitted
            }
            let retirement = retire(
                gate: gate,
                close: close,
                outcome: outcome
            )
            ownership = .deliveryUncertain(DeliveryUncertainOwnership(
                gate: gate,
                close: close,
                task: uncertain.task,
                retiredClose: retirement.close,
                outcome: retirement.outcome
            ))
            return retirement.result
        }
    }

    private enum DeliveryAwaitSnapshot {
        case result(CaptureControllerDeliveryAwaitResult)
        case task(
            close: CaptureSegmentClose,
            task: Task<CaptureControllerFinalizationOutcome, Never>
        )
        case announcementPending(CaptureControllerAnnouncementSettlement)
    }

    private func deliveryAwaitSnapshot(
        _ lease: CaptureControllerDeliveryLease
    ) -> DeliveryAwaitSnapshot {
        lock.lock()
        defer { lock.unlock() }
        guard let current = reservation, current.lease == lease else {
            return .result(.invalidLease)
        }
        switch current.binding {
        case .noOutcome:
            return .result(.noOutcome)
        case .generation(let close):
            switch ownership {
            case .announcing(let announcing)
                where announcing.queuedClose == close:
                return .announcementPending(announcing.settlement)
            case .finalizing(let finalizing)
                where finalizing.close == close:
                return .task(close: close, task: finalizing.task)
            case .deferred(let deferred)
                where deferred.close == close:
                return .result(.outcome(CaptureControllerReservedFinalization(
                    close: close,
                    outcome: deferred.outcome
                )))
            case .deliveryUncertain(let uncertain)
                where uncertain.close == close:
                if let task = uncertain.task, uncertain.outcome == nil {
                    return .task(close: close, task: task)
                }
                return .result(.deliveryUncertain(uncertain.close))
            default:
                return .result(.invalidLease)
            }
        case .uncertainty(let close):
            guard case .deliveryUncertain(let uncertain) = ownership,
                  uncertain.close == close else {
                return .result(.invalidLease)
            }
            if let close, let task = uncertain.task, uncertain.outcome == nil {
                return .task(close: close, task: task)
            }
            return .result(.deliveryUncertain(close))
        }
    }

    private func reserveObservedDelivery(
        permitsTerminationDiscard: Bool
    ) throws -> CaptureControllerDeliveryReservationResult {
        let binding: ReservationBinding
        switch ownership {
        case .finalizing(let finalizing):
            binding = .generation(finalizing.close)
        case .deferred(let deferred):
            binding = .generation(deferred.close)
        case .announcing(let announcing):
            if let queuedClose = announcing.queuedClose {
                binding = .generation(queuedClose)
            } else {
                binding = .noOutcome
            }
        case .deliveryUncertain(let uncertain):
            return .deliveryUncertain(uncertain.close)
        case .none, .prepared, .active:
            binding = .noOutcome
        }
        let lease = try makeDeliveryLease(
            permitsTerminationDiscard: permitsTerminationDiscard
        )
        reservation = DeliveryReservation(lease: lease, binding: binding)
        return .reserved(lease)
    }

    private func reserveRequestedClose(
        scope: CaptureSegmentCloseScope,
        reason: CaptureSegmentRequestedCloseReason,
        permitsTerminationDiscard: Bool
    ) throws -> (
        result: CaptureControllerDeliveryReservationResult,
        launch: Launch?
    ) {
        let close: CaptureSegmentClose
        var launch: Launch?
        switch ownership {
        case .none:
            if let tombstone = tombstone(scope: scope) {
                return (.closed(tombstone.close), nil)
            }
            return (.inactive, nil)
        case .prepared(let prepared):
            guard prepared.scope == scope else {
                return (.stale(activeScope: prepared.scope), nil)
            }
            close = try acceptedClose(from: prepared.gate.claimRequested(
                scope: scope,
                reason: reason
            ))
            let created = makeLaunch(
                gate: prepared.gate,
                close: close,
                job: { close in await prepared.drain.run(close: close) }
            )
            ownership = .finalizing(FinalizingOwnership(
                gate: created.gate,
                close: created.close,
                task: created.task
            ))
            launch = created
        case .announcing(var announcing):
            guard announcing.scope == scope else {
                return (.stale(activeScope: announcing.scope), nil)
            }
            close = try acceptedClose(from: announcing.gate.claimRequested(
                scope: scope,
                reason: reason
            ))
            announcing.queuedClose = close
            ownership = .announcing(announcing)
        case .active(let active):
            guard active.scope == scope else {
                return (.stale(activeScope: active.scope), nil)
            }
            close = try acceptedClose(from: active.gate.claimRequested(
                scope: scope,
                reason: reason
            ))
            let created = makeLaunch(
                gate: active.gate,
                close: close,
                job: active.job
            )
            ownership = .finalizing(FinalizingOwnership(
                gate: created.gate,
                close: created.close,
                task: created.task
            ))
            launch = created
        case .finalizing(let finalizing):
            guard finalizing.close.scope == scope else {
                return (.stale(activeScope: finalizing.close.scope), nil)
            }
            close = finalizing.close
        case .deferred(let deferred):
            guard deferred.close.scope == scope else {
                return (.stale(activeScope: deferred.close.scope), nil)
            }
            close = deferred.close
        case .deliveryUncertain(let uncertain):
            return (.deliveryUncertain(uncertain.close), nil)
        }

        let lease = try makeDeliveryLease(
            permitsTerminationDiscard: permitsTerminationDiscard
        )
        reservation = DeliveryReservation(
            lease: lease,
            binding: .generation(close)
        )
        return (.reserved(lease), launch)
    }

    private func completeConfirmed(
        _ current: DeliveryReservation
    ) -> CaptureControllerDeliveryCompletionResult {
        switch current.binding {
        case .noOutcome:
            reservation = nil
            return .confirmed
        case .generation(let close):
            guard case .deferred(let deferred) = ownership,
                  deferred.close == close else {
                if case .deliveryUncertain = ownership {
                    return .forbidden
                }
                return .notReady
            }
            remember(deferred)
            ownership = .none
            reservation = nil
            return .confirmed
        case .uncertainty:
            return .forbidden
        }
    }

    private func enterDeliveryUncertain(
        from _: DeliveryReservation
    ) throws -> (
        result: CaptureControllerDeliveryCompletionResult,
        launch: Launch?
    ) {
        // A throwing stdout writer makes the process-wide delivery channel
        // uncertain. Preserve whatever segment ownership exists now, including
        // a close that correctly occurred after a no-outcome reservation.
        switch ownership {
        case .deliveryUncertain:
            return (.enteredDeliveryUncertain, nil)
        case .announcing:
            // The started-line lease must be finished before another delivery
            // can classify stdout as uncertain.
            return (.notReady, nil)
        case .none:
            ownership = .deliveryUncertain(DeliveryUncertainOwnership(
                gate: nil,
                close: nil,
                task: nil,
                retiredClose: nil,
                outcome: nil
            ))
            return (.enteredDeliveryUncertain, nil)
        case .prepared(let prepared):
            let close = try acceptedClose(from: prepared.gate.claimRequested(
                scope: prepared.scope,
                reason: .termination
            ))
            let launch = makeLaunch(
                gate: prepared.gate,
                close: close,
                job: { close in await prepared.drain.run(close: close) }
            )
            ownership = .deliveryUncertain(DeliveryUncertainOwnership(
                gate: launch.gate,
                close: launch.close,
                task: launch.task,
                retiredClose: nil,
                outcome: nil
            ))
            return (.enteredDeliveryUncertain, launch)
        case .active(let active):
            let close = try acceptedClose(from: active.gate.claimRequested(
                scope: active.scope,
                reason: .termination
            ))
            let launch = makeLaunch(
                gate: active.gate,
                close: close,
                job: active.job
            )
            ownership = .deliveryUncertain(DeliveryUncertainOwnership(
                gate: launch.gate,
                close: launch.close,
                task: launch.task,
                retiredClose: nil,
                outcome: nil
            ))
            return (.enteredDeliveryUncertain, launch)
        case .finalizing(let finalizing):
            ownership = .deliveryUncertain(DeliveryUncertainOwnership(
                gate: finalizing.gate,
                close: finalizing.close,
                task: finalizing.task,
                retiredClose: nil,
                outcome: nil
            ))
            return (.enteredDeliveryUncertain, Launch(
                gate: finalizing.gate,
                close: finalizing.close,
                task: finalizing.task
            ))
        case .deferred(let deferred):
            ownership = .deliveryUncertain(DeliveryUncertainOwnership(
                gate: deferred.gate,
                close: deferred.close,
                task: nil,
                retiredClose: deferred.retiredClose,
                outcome: deferred.outcome
            ))
            return (.enteredDeliveryUncertain, nil)
        }
    }

    private func completeTerminationDiscard(
        _ current: DeliveryReservation
    ) -> CaptureControllerDeliveryCompletionResult {
        switch current.binding {
        case .noOutcome:
            guard case .none = ownership else {
                return .notReady
            }
            reservation = nil
            return .discarded
        case .generation(let close):
            if case .deferred(let deferred) = ownership,
               deferred.close == close {
                remember(deferred)
                ownership = .none
                reservation = nil
                return .discarded
            }
            guard case .deliveryUncertain(let uncertain) = ownership,
                  uncertain.close == close else {
                return .notReady
            }
            guard uncertain.outcome != nil else {
                return .notReady
            }
            if let gate = uncertain.gate,
               let retiredClose = uncertain.retiredClose {
                remember(gate: gate, close: retiredClose)
            }
            ownership = .none
            reservation = nil
            return .discarded
        case .uncertainty(let close):
            guard case .deliveryUncertain(let uncertain) = ownership,
                  uncertain.close == close else {
                return .notReady
            }
            if uncertain.close != nil, uncertain.outcome == nil {
                return .notReady
            }
            if let gate = uncertain.gate,
               let retiredClose = uncertain.retiredClose {
                remember(gate: gate, close: retiredClose)
            }
            ownership = .none
            reservation = nil
            return .discarded
        }
    }

    private func makeLaunch(
        gate: CaptureSegmentCloseGate,
        close: CaptureSegmentClose,
        job: @escaping CaptureControllerFinalizationJob
    ) -> Launch {
        Launch(
            gate: gate,
            close: close,
            task: Task { await job(close) }
        )
    }

    private func observe(_ launch: Launch) {
        Task { [weak self] in
            let outcome = await launch.task.value
            _ = self?.settle(close: launch.close, outcome: outcome)
        }
    }

    private func acceptedClose(
        from claim: CaptureSegmentCloseClaimResult
    ) throws -> CaptureSegmentClose {
        switch claim {
        case .accepted(let close), .alreadyClaimed(let close):
            return close
        case .inactive, .stale:
            throw CaptureControllerFinalizationError.segmentAlreadyOwned
        }
    }

    private func retire(
        gate: CaptureSegmentCloseGate,
        close: CaptureSegmentClose,
        outcome: CaptureControllerFinalizationOutcome
    ) -> (
        close: CaptureSegmentClose,
        outcome: CaptureControllerFinalizationOutcome,
        result: CaptureControllerFinalizationSettleResult
    ) {
        switch gate.retire(scope: close.scope) {
        case .retired(let winner?) where winner == close:
            return (winner, outcome, .committed)
        case .retired, .inactive, .stale:
            return (close, retirementMismatchOutcome(), .retirementMismatch)
        }
    }

    private func retirementMismatchOutcome() -> CaptureControllerFinalizationOutcome {
        do {
            return .failure(try CaptureControllerFinalizationFailure(
                code: "finalization-retirement-mismatch",
                message: "Capture finalization could not retire its close generation safely.",
                recoverable: false,
                state: .shuttingDown
            ))
        } catch {
            preconditionFailure("static retirement mismatch failure is invalid")
        }
    }

    private func makeAnnouncementToken(
        scope: CaptureSegmentCloseScope
    ) throws -> CaptureControllerStartAnnouncementToken {
        let (next, overflow) = nextAnnouncementToken.addingReportingOverflow(1)
        guard !overflow else {
            throw CaptureControllerFinalizationError.tokenExhausted
        }
        nextAnnouncementToken = next
        return CaptureControllerStartAnnouncementToken(value: next, scope: scope)
    }

    private func makeDeliveryLease(
        permitsTerminationDiscard: Bool
    ) throws -> CaptureControllerDeliveryLease {
        let (next, overflow) = nextDeliveryToken.addingReportingOverflow(1)
        guard !overflow else {
            throw CaptureControllerFinalizationError.tokenExhausted
        }
        nextDeliveryToken = next
        return CaptureControllerDeliveryLease(
            identity: deliveryLeaseIdentity,
            value: next,
            permitsTerminationDiscard: permitsTerminationDiscard
        )
    }

    private func activeScope() -> CaptureSegmentCloseScope? {
        switch ownership {
        case .prepared(let prepared):
            return prepared.scope
        case .announcing(let announcing):
            return announcing.scope
        case .active(let active):
            return active.scope
        case .finalizing(let finalizing):
            return finalizing.close.scope
        case .deferred(let deferred):
            return deferred.close.scope
        case .deliveryUncertain(let uncertain):
            return uncertain.close?.scope
        case .none:
            return nil
        }
    }

    private func tombstone(
        scope: CaptureSegmentCloseScope
    ) -> ClosedGeneration? {
        tombstones.last { $0.close.scope == scope }
    }

    private func remember(_ deferred: DeferredOwnership) {
        remember(gate: deferred.gate, close: deferred.retiredClose)
    }

    private func remember(
        gate: CaptureSegmentCloseGate,
        close: CaptureSegmentClose
    ) {
        guard tombstones.last?.close.scope != close.scope else { return }
        precondition(tombstones.count < maximumCaptureControllerTombstones)
        tombstones.append(ClosedGeneration(gate: gate, close: close))
    }
}
