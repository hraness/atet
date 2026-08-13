import Foundation

private final class CaptureSegmentCloseGateIdentity: @unchecked Sendable {}

struct CaptureSegmentCloseScope: Equatable, Sendable {
    fileprivate let gateIdentity: CaptureSegmentCloseGateIdentity
    let generation: UInt64
    let segmentIndex: Int

    fileprivate init(
        gateIdentity: CaptureSegmentCloseGateIdentity,
        generation: UInt64,
        segmentIndex: Int
    ) {
        self.gateIdentity = gateIdentity
        self.generation = generation
        self.segmentIndex = segmentIndex
    }

    static func == (lhs: CaptureSegmentCloseScope, rhs: CaptureSegmentCloseScope) -> Bool {
        lhs.gateIdentity === rhs.gateIdentity
            && lhs.generation == rhs.generation
            && lhs.segmentIndex == rhs.segmentIndex
    }
}

enum CaptureSegmentRequestedCloseReason: String, Equatable, Sendable {
    case pause
    case stop
    case shutdown
    case termination
    case startFailure = "start-failure"
}

enum CaptureSegmentCloseCause: Equatable, Sendable {
    case requested(CaptureSegmentRequestedCloseReason)
    case interruption(CaptureInterruptionSeed)
}

struct CaptureSegmentClose: Equatable, Sendable {
    let scope: CaptureSegmentCloseScope
    let stamp: TimelineStamp
    let cause: CaptureSegmentCloseCause

    func resolvedInterruption(recoverable: Bool) throws -> CaptureInterruption? {
        guard case .interruption(let seed) = cause else {
            return nil
        }
        return try seed.resolve(at: stamp, recoverable: recoverable)
    }

    /// Resolves fatal interruption evidence for a segment that was never
    /// persisted. Its native timestamp remains the incident boundary, while
    /// logical time is anchored to the last persisted bundle frontier.
    func resolvedUnpersistedInterruption(
        sourceFrontierUs: UInt64
    ) throws -> CaptureInterruption? {
        guard case .interruption(let seed) = cause else {
            return nil
        }
        guard sourceFrontierUs <= stamp.sourceTimeUs else {
            throw CaptureSegmentCloseGateError.invalidFailureSourceFrontier
        }
        return try seed.resolve(
            at: TimelineStamp(
                nativeTimeUs: stamp.nativeTimeUs,
                sourceTimeUs: sourceFrontierUs
            ),
            recoverable: false
        )
    }
}

enum CaptureSegmentCloseClaimResult: Equatable, Sendable {
    case accepted(CaptureSegmentClose)
    case alreadyClaimed(CaptureSegmentClose)
    case inactive
    case stale(activeScope: CaptureSegmentCloseScope)
}

enum CaptureSegmentCloseRetireResult: Equatable, Sendable {
    case retired(CaptureSegmentClose?)
    case inactive
    case stale(activeScope: CaptureSegmentCloseScope)
}

enum CaptureSegmentCloseGateError: Error, Equatable {
    case alreadyArmed
    case generationExhausted
    case invalidFailureSourceFrontier
    case interruptionSegmentMismatch
    case invalidSegmentIndex
}

final class CaptureSegmentCloseGate: @unchecked Sendable {
    private struct ArmedSegment {
        let scope: CaptureSegmentCloseScope
        var close: CaptureSegmentClose?
    }

    private let lock = NSLock()
    private let identity = CaptureSegmentCloseGateIdentity()
    private let timeline: CaptureTimeline
    private var armed: ArmedSegment?
    private var generation: UInt64 = 0

    init(timeline: CaptureTimeline) {
        self.timeline = timeline
    }

    func arm(segmentIndex: Int) throws -> CaptureSegmentCloseScope {
        lock.lock()
        defer { lock.unlock() }
        guard armed == nil else {
            throw CaptureSegmentCloseGateError.alreadyArmed
        }
        guard segmentIndex >= 0, segmentIndex < maximumCaptureSegments else {
            throw CaptureSegmentCloseGateError.invalidSegmentIndex
        }
        let (nextGeneration, overflow) = generation.addingReportingOverflow(1)
        guard !overflow else {
            throw CaptureSegmentCloseGateError.generationExhausted
        }
        generation = nextGeneration
        let scope = CaptureSegmentCloseScope(
            gateIdentity: identity,
            generation: nextGeneration,
            segmentIndex: segmentIndex
        )
        armed = ArmedSegment(scope: scope, close: nil)
        return scope
    }

    func claimRequested(
        scope: CaptureSegmentCloseScope,
        reason: CaptureSegmentRequestedCloseReason
    ) throws -> CaptureSegmentCloseClaimResult {
        try claim(scope: scope, cause: .requested(reason))
    }

    func claimInterruption(
        scope: CaptureSegmentCloseScope,
        seed: CaptureInterruptionSeed
    ) throws -> CaptureSegmentCloseClaimResult {
        try claim(scope: scope, cause: .interruption(seed))
    }

    @discardableResult
    func retire(scope: CaptureSegmentCloseScope) -> CaptureSegmentCloseRetireResult {
        lock.lock()
        defer { lock.unlock() }
        guard let current = armed else {
            return .inactive
        }
        guard current.scope == scope else {
            return .stale(activeScope: current.scope)
        }
        armed = nil
        return .retired(current.close)
    }

    private func claim(
        scope: CaptureSegmentCloseScope,
        cause: CaptureSegmentCloseCause
    ) throws -> CaptureSegmentCloseClaimResult {
        lock.lock()
        defer { lock.unlock() }
        guard let current = armed else {
            return .inactive
        }
        guard current.scope == scope else {
            return .stale(activeScope: current.scope)
        }
        if let close = current.close {
            return .alreadyClaimed(close)
        }

        let stamp: TimelineStamp
        switch cause {
        case .requested:
            stamp = try timeline.endActive()
        case .interruption(let seed):
            // The callback identity must be proven safe before it is allowed
            // to freeze the user-visible timeline.
            try seed.validate()
            guard seed.segmentIndex == scope.segmentIndex else {
                throw CaptureSegmentCloseGateError.interruptionSegmentMismatch
            }
            stamp = try timeline.endActive(atNativeTimeUs: seed.nativeTimeUs)
        }

        let close = CaptureSegmentClose(scope: scope, stamp: stamp, cause: cause)
        armed = ArmedSegment(scope: scope, close: close)
        return .accepted(close)
    }
}
