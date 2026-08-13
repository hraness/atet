import Darwin
import Foundation

struct TimelineStamp: Equatable, Sendable {
    let nativeTimeUs: UInt64
    let sourceTimeUs: UInt64
}

private final class TimelinePreparedIntervalIdentity:
    @unchecked Sendable {}

struct TimelinePreparedInterval: Equatable, Sendable {
    fileprivate let identity: TimelinePreparedIntervalIdentity
    fileprivate let generation: UInt64
    let start: TimelineStamp

    static func == (
        lhs: TimelinePreparedInterval,
        rhs: TimelinePreparedInterval
    ) -> Bool {
        lhs.identity === rhs.identity
            && lhs.generation == rhs.generation
            && lhs.start == rhs.start
    }
}

enum TimelinePreparedCommitResult: Equatable, Sendable {
    case committed
    case alreadyCommitted
    case alreadyDiscarded
    case inactive
    case stale
}

enum TimelinePreparedDiscardResult: Equatable, Sendable {
    case discarded
    case alreadyDiscarded
    case alreadyCommitted
    case closeMismatch
    case notClosed
    case stale
}

final class CaptureTimeline: @unchecked Sendable {
    private enum PreparedSettlement {
        case committed
        case discarded
    }

    private struct PendingPreparedClosure {
        let interval: TimelinePreparedInterval
        let close: TimelineStamp
        let accumulatedBefore: UInt64
        let accumulatedAfter: UInt64
    }

    private let lock = NSLock()
    private let preparedIdentity = TimelinePreparedIntervalIdentity()
    private let monotonicClock: @Sendable () -> UInt64
    private var activeStartNativeUs: UInt64?
    private var activePublishedNativeUs: UInt64?
    private var activePreparedInterval: TimelinePreparedInterval?
    private var pendingPreparedClosure: PendingPreparedClosure?
    private var preparedSettlements: [UInt64: PreparedSettlement] = [:]
    private var preparedGeneration: UInt64 = 0
    private var accumulatedActiveUs: UInt64 = 0
    private var lastObservedNativeUs: UInt64?

    init(monotonicClock: @escaping @Sendable () -> UInt64 = { monotonicMicroseconds() }) {
        self.monotonicClock = monotonicClock
    }

    func beginActive() throws -> TimelineStamp {
        lock.lock()
        defer { lock.unlock() }
        return try beginActiveLocked()
    }

    func beginPreparedActive() throws -> TimelinePreparedInterval {
        lock.lock()
        defer { lock.unlock() }
        let start = try beginActiveLocked()
        let (generation, overflow) =
            preparedGeneration.addingReportingOverflow(1)
        guard !overflow else {
            activeStartNativeUs = nil
            activePublishedNativeUs = nil
            throw HelperFailure(
                code: "timeline-generation-exhausted",
                message: "Capture timeline generation exhausted.",
                recoverable: false
            )
        }
        preparedGeneration = generation
        let interval = TimelinePreparedInterval(
            identity: preparedIdentity,
            generation: generation,
            start: start
        )
        activePreparedInterval = interval
        return interval
    }

    func commitPreparedInterval(
        _ interval: TimelinePreparedInterval
    ) -> TimelinePreparedCommitResult {
        lock.lock()
        defer { lock.unlock() }
        guard interval.identity === preparedIdentity else {
            return .stale
        }
        if let settlement = preparedSettlements[interval.generation] {
            switch settlement {
            case .committed:
                return .alreadyCommitted
            case .discarded:
                return .alreadyDiscarded
            }
        }
        if activePreparedInterval == interval {
            activePreparedInterval = nil
            preparedSettlements[interval.generation] = .committed
            return .committed
        }
        if pendingPreparedClosure?.interval == interval {
            pendingPreparedClosure = nil
            preparedSettlements[interval.generation] = .committed
            return .committed
        }
        return .inactive
    }

    func discardPreparedInterval(
        _ interval: TimelinePreparedInterval,
        closedAt close: TimelineStamp
    ) -> TimelinePreparedDiscardResult {
        lock.lock()
        defer { lock.unlock() }
        guard interval.identity === preparedIdentity else {
            return .stale
        }
        if let settlement = preparedSettlements[interval.generation] {
            switch settlement {
            case .committed:
                return .alreadyCommitted
            case .discarded:
                return .alreadyDiscarded
            }
        }
        guard let pending = pendingPreparedClosure else {
            return activePreparedInterval == interval
                ? .notClosed
                : .stale
        }
        guard pending.interval == interval else {
            return .stale
        }
        guard pending.close == close,
              pending.interval.start == interval.start,
              accumulatedActiveUs == pending.accumulatedAfter else {
            return .closeMismatch
        }
        accumulatedActiveUs = pending.accumulatedBefore
        pendingPreparedClosure = nil
        preparedSettlements[interval.generation] = .discarded
        return .discarded
    }

    func endActive() throws -> TimelineStamp {
        try endActive(requestedNativeTimeUs: nil)
    }

    func endActive(atNativeTimeUs requestedNativeTimeUs: UInt64) throws -> TimelineStamp {
        try endActive(requestedNativeTimeUs: requestedNativeTimeUs)
    }

    private func endActive(requestedNativeTimeUs: UInt64?) throws -> TimelineStamp {
        lock.lock()
        defer { lock.unlock() }
        guard let start = activeStartNativeUs else {
            throw HelperFailure(code: "timeline-not-active", message: "Capture timeline is not active.", recoverable: false)
        }
        let currentNativeTimeUs = observeMonotonicClockLocked()
        let publishedNativeTimeUs = activePublishedNativeUs ?? start
        let lowerBoundNativeTimeUs = max(start, publishedNativeTimeUs)
        let native = min(
            max(requestedNativeTimeUs ?? currentNativeTimeUs, lowerBoundNativeTimeUs),
            currentNativeTimeUs
        )
        let (durationUs, subtractionOverflow) = native.subtractingReportingOverflow(start)
        guard !subtractionOverflow else {
            throw HelperFailure(code: "timeline-overflow", message: "Capture timeline duration overflowed.", recoverable: false)
        }
        let (nextAccumulatedActiveUs, additionOverflow) = accumulatedActiveUs.addingReportingOverflow(durationUs)
        guard !additionOverflow else {
            throw HelperFailure(code: "timeline-overflow", message: "Capture timeline duration overflowed.", recoverable: false)
        }
        let accumulatedBefore = accumulatedActiveUs
        accumulatedActiveUs = nextAccumulatedActiveUs
        activeStartNativeUs = nil
        activePublishedNativeUs = nil
        let close = TimelineStamp(
            nativeTimeUs: native,
            sourceTimeUs: accumulatedActiveUs
        )
        if let interval = activePreparedInterval {
            pendingPreparedClosure = PendingPreparedClosure(
                interval: interval,
                close: close,
                accumulatedBefore: accumulatedBefore,
                accumulatedAfter: accumulatedActiveUs
            )
            activePreparedInterval = nil
        }
        return close
    }

    func sample() -> TimelineStamp {
        lock.lock()
        defer { lock.unlock() }
        let native = observeMonotonicClockLocked()
        let logical: UInt64
        if let start = activeStartNativeUs {
            activePublishedNativeUs = max(activePublishedNativeUs ?? start, native)
            let (durationUs, subtractionOverflow) = native.subtractingReportingOverflow(start)
            if subtractionOverflow {
                logical = accumulatedActiveUs
            } else {
                logical = saturatingTimelineMicrosecondSum(accumulatedActiveUs, durationUs)
            }
        } else {
            logical = accumulatedActiveUs
        }
        return TimelineStamp(nativeTimeUs: native, sourceTimeUs: logical)
    }

    private func observeMonotonicClockLocked() -> UInt64 {
        let observed = monotonicClock()
        let monotonic = max(lastObservedNativeUs ?? observed, observed)
        lastObservedNativeUs = monotonic
        return monotonic
    }

    private func beginActiveLocked() throws -> TimelineStamp {
        guard activeStartNativeUs == nil else {
            throw HelperFailure(
                code: "timeline-already-active",
                message: "Capture timeline is already active.",
                recoverable: false
            )
        }
        guard pendingPreparedClosure == nil else {
            throw HelperFailure(
                code: "timeline-prepared-interval-unsettled",
                message: "Capture timeline has an unsettled prepared interval.",
                recoverable: false
            )
        }
        let native = observeMonotonicClockLocked()
        activeStartNativeUs = native
        activePublishedNativeUs = native
        activePreparedInterval = nil
        return TimelineStamp(
            nativeTimeUs: native,
            sourceTimeUs: accumulatedActiveUs
        )
    }
}

func saturatingTimelineMicrosecondSum(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
    let (sum, overflow) = lhs.addingReportingOverflow(rhs)
    return overflow ? UInt64.max : sum
}

private let machTimebase: mach_timebase_info_data_t = {
    var value = mach_timebase_info_data_t()
    mach_timebase_info(&value)
    return value
}()

func monotonicMicroseconds() -> UInt64 {
    let ticks = mach_continuous_time()
    let nanoseconds = Double(ticks) * Double(machTimebase.numer) / Double(machTimebase.denom)
    return UInt64(nanoseconds / 1_000.0)
}
