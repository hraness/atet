import CoreMedia
import Darwin
import Foundation

private let maximumJSONSafeInteger: Int64 = 9_007_199_254_740_991

private let sampleTimingMachTimebase: mach_timebase_info_data_t = {
    var value = mach_timebase_info_data_t()
    mach_timebase_info(&value)
    return value
}()

struct SampleTimingFailure: Error {
    let message: String
}

struct SamplePresentationTiming {
    let firstPtsUs: Int64
    let lastPtsUs: Int64
    let endPtsUs: Int64
    let maximumSampleDurationUs: Int64

    var json: [String: Any] {
        [
            "firstPtsUs": firstPtsUs,
            "lastPtsUs": lastPtsUs,
            "endPtsUs": endPtsUs,
            "maximumSampleDurationUs": maximumSampleDurationUs,
        ]
    }
}

struct SampleClockAnchor {
    let ptsUs: Int64
    let nativeTimeUs: Int64
    let uncertaintyUs: Int64

    var json: [String: Any] {
        [
            "ptsUs": ptsUs,
            "nativeTimeUs": nativeTimeUs,
            "uncertaintyUs": uncertaintyUs,
        ]
    }
}

struct MediaSampleTiming {
    let bufferCount: Int64
    let sampleCount: Int64
    let presentation: SamplePresentationTiming
    let firstClockAnchor: SampleClockAnchor
    let endClockAnchor: SampleClockAnchor

    var json: [String: Any] {
        [
            "bufferCount": bufferCount,
            "sampleCount": sampleCount,
            "presentation": presentation.json,
            "clockAnchors": [
                "first": firstClockAnchor.json,
                "end": endClockAnchor.json,
            ],
        ]
    }
}

struct FileSampleTiming {
    let bufferCount: Int64
    let sampleCount: Int64
    let presentation: SamplePresentationTiming
}

private struct SampleObservation {
    let sampleCount: Int64
    let firstPts: CMTime
    let firstPtsUs: Int64
    let lastPtsUs: Int64
    let endPts: CMTime
    let endPtsUs: Int64
    let maximumSampleDurationUs: Int64
    let needsFinalDurationInference: Bool
}

private func numericMicroseconds(_ time: CMTime, allowNegative: Bool) -> Int64? {
    guard time.isValid, time.isNumeric, !time.isIndefinite else { return nil }
    let converted = CMTimeConvertScale(time, timescale: 1_000_000, method: .roundHalfAwayFromZero)
    let value = converted.value
    guard value <= maximumJSONSafeInteger,
          value >= (allowNegative ? -maximumJSONSafeInteger : 0) else { return nil }
    return value
}

private func positiveDurationMicroseconds(_ time: CMTime) -> Int64? {
    guard let value = numericMicroseconds(time, allowNegative: false), value > 0 else { return nil }
    return value
}

private func sampleTimingInfo(
    _ sampleBuffer: CMSampleBuffer,
    index: CMItemIndex
) -> CMSampleTimingInfo? {
    var timing = CMSampleTimingInfo()
    guard CMSampleBufferGetSampleTimingInfo(sampleBuffer, at: index, timingInfoOut: &timing) == noErr else {
        return nil
    }
    return timing
}

private func observation(
    _ sampleBuffer: CMSampleBuffer,
    allowNegativePTS: Bool
) -> SampleObservation? {
    guard CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else { return nil }
    let rawSampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
    guard rawSampleCount > 0, rawSampleCount <= CMItemCount(maximumJSONSafeInteger) else { return nil }
    let sampleCount = Int64(rawSampleCount)
    let firstPts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard let firstPtsUs = numericMicroseconds(firstPts, allowNegative: allowNegativePTS) else { return nil }

    let firstTiming = sampleTimingInfo(sampleBuffer, index: 0)
    let lastTiming = sampleTimingInfo(sampleBuffer, index: rawSampleCount - 1)
    let lastPts = lastTiming?.presentationTimeStamp ?? firstPts
    guard let lastPtsUs = numericMicroseconds(lastPts, allowNegative: allowNegativePTS) else { return nil }

    let totalDuration = CMSampleBufferGetDuration(sampleBuffer)
    let lastDuration = lastTiming?.duration
    let endPts: CMTime
    if let lastDuration, positiveDurationMicroseconds(lastDuration) != nil {
        endPts = CMTimeAdd(lastPts, lastDuration)
    } else if positiveDurationMicroseconds(totalDuration) != nil {
        endPts = CMTimeAdd(firstPts, totalDuration)
    } else {
        endPts = lastPts
    }
    guard let endPtsUs = numericMicroseconds(endPts, allowNegative: allowNegativePTS) else { return nil }

    var maximumSampleDurationUs = max(
        firstTiming.flatMap { positiveDurationMicroseconds($0.duration) } ?? 0,
        lastTiming.flatMap { positiveDurationMicroseconds($0.duration) } ?? 0
    )
    if maximumSampleDurationUs == 0,
       let totalDurationUs = positiveDurationMicroseconds(totalDuration) {
        maximumSampleDurationUs = max(1, (totalDurationUs + sampleCount - 1) / sampleCount)
    }

    return SampleObservation(
        sampleCount: sampleCount,
        firstPts: firstPts,
        firstPtsUs: firstPtsUs,
        lastPtsUs: max(firstPtsUs, lastPtsUs),
        endPts: endPts,
        endPtsUs: max(lastPtsUs, endPtsUs),
        maximumSampleDurationUs: maximumSampleDurationUs,
        needsFinalDurationInference: endPtsUs <= lastPtsUs
    )
}

private func microsecondsFromMachTicks(_ ticks: UInt64) -> Int64? {
    let nanoseconds = Double(ticks)
        * Double(sampleTimingMachTimebase.numer)
        / Double(sampleTimingMachTimebase.denom)
    let microseconds = nanoseconds / 1_000
    guard microseconds.isFinite,
          microseconds >= 0,
          microseconds <= Double(maximumJSONSafeInteger) else { return nil }
    return Int64(microseconds.rounded(.down))
}

private func clockAnchor(
    pts: CMTime,
    ptsUs: Int64,
    synchronizationClock: CMClock
) -> SampleClockAnchor? {
    let hostClock = CMClockGetHostTimeClock()
    let hostTime = CMSyncConvertTime(pts, from: synchronizationClock, to: hostClock)
    guard hostTime.isValid, hostTime.isNumeric, !hostTime.isIndefinite else { return nil }
    let hostTicks = CMClockConvertHostTimeToSystemUnits(hostTime)

    // Bracket mach_absolute_time with continuous-clock reads. The midpoint
    // estimates their shared instant; half the bracket plus one microsecond
    // records the conversion and integer-rounding uncertainty.
    let continuousBefore = mach_continuous_time()
    let absoluteNow = mach_absolute_time()
    let continuousAfter = mach_continuous_time()
    guard continuousAfter >= continuousBefore else { return nil }
    let bracketTicks = continuousAfter - continuousBefore
    let continuousMidpoint = continuousBefore + bracketTicks / 2
    let nativeTicks: UInt64
    if continuousMidpoint >= absoluteNow {
        let continuousOffset = continuousMidpoint - absoluteNow
        guard hostTicks <= UInt64.max - continuousOffset else { return nil }
        nativeTicks = hostTicks + continuousOffset
    } else {
        let estimatedNegativeOffset = absoluteNow - continuousMidpoint
        guard hostTicks >= estimatedNegativeOffset else { return nil }
        nativeTicks = hostTicks - estimatedNegativeOffset
    }
    guard let nativeTimeUs = microsecondsFromMachTicks(nativeTicks),
          let halfBracketUs = microsecondsFromMachTicks((bracketTicks + 1) / 2) else { return nil }
    return SampleClockAnchor(
        ptsUs: ptsUs,
        nativeTimeUs: nativeTimeUs,
        uncertaintyUs: max(1, halfBracketUs + 1)
    )
}

final class SampleTimingAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var bufferCount: Int64 = 0
    private var sampleCount: Int64 = 0
    private var firstPtsUs: Int64?
    private var lastPtsUs: Int64?
    private var endPtsUs: Int64?
    private var maximumSampleDurationUs: Int64 = 0
    private var minimumPositiveCadenceUs: Int64?
    private var priorBufferFirstPtsUs: Int64?
    private var priorBufferSampleCount: Int64?
    private var finalSampleNeedsDurationInference = false
    private var sawDurationlessObservation = false
    private var firstClockAnchor: SampleClockAnchor?
    private var endClockAnchor: SampleClockAnchor?
    private var failureMessage: String?
    private var frozen = false

    func observe(_ sampleBuffer: CMSampleBuffer, synchronizationClock: CMClock?) {
        guard let synchronizationClock,
              let observed = observation(sampleBuffer, allowNegativePTS: false),
              let firstAnchor = clockAnchor(
                pts: observed.firstPts,
                ptsUs: observed.firstPtsUs,
                synchronizationClock: synchronizationClock
              ),
              let endAnchor = clockAnchor(
                pts: observed.endPts,
                ptsUs: observed.endPtsUs,
                synchronizationClock: synchronizationClock
              ) else {
            recordFailure("Capture produced a media sample with invalid timing or no synchronization clock.")
            return
        }

        lock.lock()
        defer { lock.unlock() }
        guard !frozen, failureMessage == nil else { return }
        guard bufferCount < maximumJSONSafeInteger,
              sampleCount <= maximumJSONSafeInteger - observed.sampleCount else {
            failureMessage = "Capture sample counters exceeded the protocol's safe-integer range."
            return
        }
        bufferCount += 1
        sampleCount += observed.sampleCount
        if let priorBufferFirstPtsUs,
           priorBufferSampleCount == 1,
           observed.sampleCount == 1 {
            let cadence = observed.firstPtsUs - priorBufferFirstPtsUs
            if cadence > 0 {
                minimumPositiveCadenceUs = min(
                    minimumPositiveCadenceUs ?? cadence,
                    cadence
                )
            }
        }
        priorBufferFirstPtsUs = observed.firstPtsUs
        priorBufferSampleCount = observed.sampleCount
        sawDurationlessObservation = sawDurationlessObservation
            || observed.needsFinalDurationInference
        if firstPtsUs == nil || observed.firstPtsUs < firstPtsUs! {
            firstPtsUs = observed.firstPtsUs
            firstClockAnchor = firstAnchor
        }
        if lastPtsUs == nil || observed.lastPtsUs >= lastPtsUs! {
            lastPtsUs = observed.lastPtsUs
            finalSampleNeedsDurationInference = observed.needsFinalDurationInference
        }
        if endPtsUs == nil || observed.endPtsUs >= endPtsUs! {
            endPtsUs = observed.endPtsUs
            endClockAnchor = endAnchor
        }
        maximumSampleDurationUs = max(maximumSampleDurationUs, observed.maximumSampleDurationUs)
    }

    func finish(finalizedTimingFallback: FileSampleTiming? = nil) throws -> MediaSampleTiming {
        lock.lock()
        defer { lock.unlock() }
        frozen = true
        if let failureMessage { throw SampleTimingFailure(message: failureMessage) }
        guard bufferCount > 0,
              sampleCount > 0,
              let firstPtsUs,
              let lastPtsUs,
              let endPtsUs,
              let firstClockAnchor,
              let endClockAnchor else {
            throw SampleTimingFailure(message: "Capture produced no valid media sample timing.")
        }
        let finalizedFinalDurationUs = finalizedTimingFallback.map {
            $0.presentation.endPtsUs - $0.presentation.lastPtsUs
        }.flatMap { $0 > 0 ? $0 : nil }
        let inferredFinalDurationUs = finalSampleNeedsDurationInference
            ? finalizedFinalDurationUs ?? (
                maximumSampleDurationUs > 0 ? maximumSampleDurationUs : nil
            ) ?? minimumPositiveCadenceUs
            : nil
        let finalizedMaximumFallbackUs = sawDurationlessObservation
            ? finalizedTimingFallback?.presentation.maximumSampleDurationUs ?? 0
            : 0
        let resolvedMaximumSampleDurationUs = max(
            maximumSampleDurationUs,
            inferredFinalDurationUs ?? 0,
            finalizedMaximumFallbackUs
        )
        guard resolvedMaximumSampleDurationUs > 0 else {
            throw SampleTimingFailure(
                message: "Capture could not establish a positive media-sample duration."
            )
        }
        let resolvedEndPtsUs: Int64
        let resolvedEndClockAnchor: SampleClockAnchor
        if endPtsUs > lastPtsUs {
            resolvedEndPtsUs = endPtsUs
            resolvedEndClockAnchor = endClockAnchor
        } else {
            guard let finalSampleDurationUs = inferredFinalDurationUs else {
                throw SampleTimingFailure(
                    message: "Capture could not establish its final media-sample duration."
                )
            }
            guard lastPtsUs <= maximumJSONSafeInteger - finalSampleDurationUs else {
                throw SampleTimingFailure(message: "Capture sample timing exceeds the protocol range.")
            }
            resolvedEndPtsUs = lastPtsUs + finalSampleDurationUs
            let anchorDeltaUs = resolvedEndPtsUs - endClockAnchor.ptsUs
            guard anchorDeltaUs >= 0,
                  endClockAnchor.nativeTimeUs <= maximumJSONSafeInteger - anchorDeltaUs else {
                throw SampleTimingFailure(message: "Capture clock anchor exceeds the protocol range.")
            }
            resolvedEndClockAnchor = SampleClockAnchor(
                ptsUs: resolvedEndPtsUs,
                nativeTimeUs: endClockAnchor.nativeTimeUs + anchorDeltaUs,
                uncertaintyUs: min(
                    1_000_000,
                    endClockAnchor.uncertaintyUs + finalSampleDurationUs
                )
            )
        }
        return MediaSampleTiming(
            bufferCount: bufferCount,
            sampleCount: sampleCount,
            presentation: SamplePresentationTiming(
                firstPtsUs: firstPtsUs,
                lastPtsUs: lastPtsUs,
                endPtsUs: resolvedEndPtsUs,
                maximumSampleDurationUs: resolvedMaximumSampleDurationUs
            ),
            firstClockAnchor: firstClockAnchor,
            endClockAnchor: resolvedEndClockAnchor
        )
    }

    private func recordFailure(_ message: String) {
        lock.lock()
        if !frozen, failureMessage == nil { failureMessage = message }
        lock.unlock()
    }
}

final class FileSampleTimingAccumulator {
    private var bufferCount: Int64 = 0
    private var sampleCount: Int64 = 0
    private var firstPtsUs: Int64?
    private var lastPtsUs: Int64?
    private var endPtsUs: Int64?
    private var maximumSampleDurationUs: Int64 = 0
    private var minimumPositiveCadenceUs: Int64?
    private var priorBufferFirstPtsUs: Int64?
    private var priorBufferSampleCount: Int64?
    private var finalSampleNeedsDurationInference = false

    func observe(_ sampleBuffer: CMSampleBuffer) throws {
        guard let observed = observation(sampleBuffer, allowNegativePTS: true) else {
            throw SampleTimingFailure(message: "Finalized media contains a sample with invalid timing.")
        }
        guard bufferCount < maximumJSONSafeInteger,
              sampleCount <= maximumJSONSafeInteger - observed.sampleCount else {
            throw SampleTimingFailure(message: "Finalized media sample counters exceed the supported range.")
        }
        bufferCount += 1
        sampleCount += observed.sampleCount
        if let priorBufferFirstPtsUs,
           priorBufferSampleCount == 1,
           observed.sampleCount == 1 {
            let cadence = observed.firstPtsUs - priorBufferFirstPtsUs
            if cadence > 0 {
                minimumPositiveCadenceUs = min(
                    minimumPositiveCadenceUs ?? cadence,
                    cadence
                )
            }
        }
        priorBufferFirstPtsUs = observed.firstPtsUs
        priorBufferSampleCount = observed.sampleCount
        firstPtsUs = min(firstPtsUs ?? observed.firstPtsUs, observed.firstPtsUs)
        if lastPtsUs == nil || observed.lastPtsUs >= lastPtsUs! {
            lastPtsUs = observed.lastPtsUs
            finalSampleNeedsDurationInference = observed.needsFinalDurationInference
        }
        endPtsUs = max(endPtsUs ?? observed.endPtsUs, observed.endPtsUs)
        maximumSampleDurationUs = max(maximumSampleDurationUs, observed.maximumSampleDurationUs)
    }

    func finish() throws -> FileSampleTiming {
        guard bufferCount > 0,
              sampleCount > 0,
              let firstPtsUs,
              let lastPtsUs,
              let endPtsUs else {
            throw SampleTimingFailure(message: "Finalized media contains no timed samples.")
        }
        let inferredFinalDurationUs = finalSampleNeedsDurationInference
            ? (
                maximumSampleDurationUs > 0 ? maximumSampleDurationUs : nil
            ) ?? minimumPositiveCadenceUs
            : nil
        let resolvedMaximumSampleDurationUs = max(
            maximumSampleDurationUs,
            inferredFinalDurationUs ?? 0
        )
        guard resolvedMaximumSampleDurationUs > 0 else {
            throw SampleTimingFailure(
                message: "Finalized media does not establish a positive sample duration."
            )
        }
        let resolvedEndPtsUs: Int64
        if endPtsUs > lastPtsUs {
            resolvedEndPtsUs = endPtsUs
        } else {
            guard let finalSampleDurationUs = inferredFinalDurationUs else {
                throw SampleTimingFailure(
                    message: "Finalized media does not establish its final sample duration."
                )
            }
            guard lastPtsUs <= maximumJSONSafeInteger - finalSampleDurationUs else {
                throw SampleTimingFailure(message: "Finalized media timing exceeds the supported range.")
            }
            resolvedEndPtsUs = lastPtsUs + finalSampleDurationUs
        }
        return FileSampleTiming(
            bufferCount: bufferCount,
            sampleCount: sampleCount,
            presentation: SamplePresentationTiming(
                firstPtsUs: firstPtsUs,
                lastPtsUs: lastPtsUs,
                endPtsUs: resolvedEndPtsUs,
                maximumSampleDurationUs: resolvedMaximumSampleDurationUs
            )
        )
    }
}

func validateLiveAndFileTiming(
    live: MediaSampleTiming,
    file: FileSampleTiming,
    source: String,
    requireMatchingCounts: Bool = false
) throws {
    let livePresentation = live.presentation
    let filePresentation = file.presentation
    let liveLastOffset = livePresentation.lastPtsUs - livePresentation.firstPtsUs
    let fileLastOffset = filePresentation.lastPtsUs - filePresentation.firstPtsUs
    let liveEndOffset = livePresentation.endPtsUs - livePresentation.firstPtsUs
    let fileEndOffset = filePresentation.endPtsUs - filePresentation.firstPtsUs
    let sampleQuantumUs = max(
        1,
        livePresentation.maximumSampleDurationUs,
        filePresentation.maximumSampleDurationUs
    )
    if requireMatchingCounts {
        guard live.bufferCount == file.bufferCount,
              live.sampleCount == file.sampleCount else {
            throw SampleTimingFailure(
                message: "Finalized \(source) sample counts disagree with live capture."
            )
        }
    }
    guard abs(liveLastOffset - fileLastOffset) <= sampleQuantumUs,
          abs(liveEndOffset - fileEndOffset) <= sampleQuantumUs else {
        throw SampleTimingFailure(
            message: "Finalized \(source) timing disagrees with live capture beyond one sample quantum."
        )
    }
}
