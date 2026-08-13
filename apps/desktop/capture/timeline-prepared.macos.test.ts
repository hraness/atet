import { expect, test } from "bun:test";
import { runCaptureSegmentCloseGateHarness } from "./build";

const harnessSource = String.raw`
import Foundation

enum HarnessFailure: Error {
    case assertion(String)
}

func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw HarnessFailure.assertion(message) }
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

    func advance(_ delta: UInt64) {
        lock.lock()
        stored += delta
        lock.unlock()
    }
}

func requestedClose(
    _ result: CaptureSegmentCloseClaimResult
) throws -> CaptureSegmentClose {
    switch result {
    case .accepted(let close), .alreadyClaimed(let close):
        return close
    case .inactive:
        throw HarnessFailure.assertion("close gate was inactive")
    case .stale:
        throw HarnessFailure.assertion("close gate scope was stale")
    }
}

@main
struct HarnessMain {
    static func main() throws {
        var cases: [String] = []

        let rejectionClock = ManualClock(1_000)
        let rejectionTimeline = CaptureTimeline(
            monotonicClock: { rejectionClock.read() }
        )
        let rejectionGate = CaptureSegmentCloseGate(
            timeline: rejectionTimeline
        )
        let rejected = try rejectionTimeline.beginPreparedActive()
        let rejectedScope = try rejectionGate.arm(segmentIndex: 0)
        rejectionClock.advance(80)
        let rejectedClose = try requestedClose(
            rejectionGate.claimRequested(
                scope: rejectedScope,
                reason: .startFailure
            )
        )
        try require(
            rejectionTimeline.sample().sourceTimeUs == 80,
            "prepared close did not provisionally advance"
        )
        let wrongClose = TimelineStamp(
            nativeTimeUs: rejectedClose.stamp.nativeTimeUs,
            sourceTimeUs: rejectedClose.stamp.sourceTimeUs + 1
        )
        try require(
            rejectionTimeline.discardPreparedInterval(
                rejected,
                closedAt: wrongClose
            ) == .closeMismatch,
            "wrong close stamp discarded prepared time"
        )
        do {
            _ = try rejectionTimeline.beginActive()
            throw HarnessFailure.assertion(
                "unsettled prepared time allowed a new interval"
            )
        } catch let failure as HelperFailure {
            try require(
                failure.code == "timeline-prepared-interval-unsettled",
                "unsettled prepared interval used the wrong error"
            )
        }
        try require(
            rejectionTimeline.discardPreparedInterval(
                rejected,
                closedAt: rejectedClose.stamp
            ) == .discarded,
            "announcement rejection did not discard prepared time"
        )
        try require(
            rejectionTimeline.sample().sourceTimeUs == 0,
            "announcement rejection changed the session frontier"
        )
        try require(
            rejectionTimeline.discardPreparedInterval(
                rejected,
                closedAt: rejectedClose.stamp
            ) == .alreadyDiscarded,
            "prepared discard was not idempotent"
        )
        cases.append("announcement-rejection-discards")

        let foreignClock = ManualClock(2_000)
        let foreignTimeline = CaptureTimeline(
            monotonicClock: { foreignClock.read() }
        )
        let foreign = try foreignTimeline.beginPreparedActive()
        try require(
            rejectionTimeline.discardPreparedInterval(
                foreign,
                closedAt: rejectedClose.stamp
            ) == .stale,
            "foreign timeline token crossed identity"
        )
        let foreignGate = CaptureSegmentCloseGate(timeline: foreignTimeline)
        let foreignScope = try foreignGate.arm(segmentIndex: 1)
        let foreignClose = try requestedClose(
            foreignGate.claimRequested(
                scope: foreignScope,
                reason: .startFailure
            )
        )
        _ = foreignTimeline.discardPreparedInterval(
            foreign,
            closedAt: foreignClose.stamp
        )
        cases.append("identity-and-close-exact")

        let queuedClock = ManualClock(3_000)
        let queuedTimeline = CaptureTimeline(
            monotonicClock: { queuedClock.read() }
        )
        let queuedGate = CaptureSegmentCloseGate(timeline: queuedTimeline)
        let queued = try queuedTimeline.beginPreparedActive()
        let queuedScope = try queuedGate.arm(segmentIndex: 2)
        queuedClock.advance(40)
        let queuedClose = try requestedClose(
            queuedGate.claimRequested(
                scope: queuedScope,
                reason: .termination
            )
        )
        try require(
            queuedTimeline.commitPreparedInterval(queued) == .committed,
            "confirmed announcement did not retain a queued close"
        )
        try require(
            queuedTimeline.commitPreparedInterval(queued)
                == .alreadyCommitted,
            "confirmed interval commit was not idempotent"
        )
        try require(
            queuedTimeline.discardPreparedInterval(
                queued,
                closedAt: queuedClose.stamp
            ) == .alreadyCommitted,
            "confirmed queued close was later discarded"
        )
        try require(
            queuedTimeline.sample().sourceTimeUs == 40,
            "confirmed queued close lost retained time"
        )
        cases.append("queued-close-commit-retains")

        let resumeClock = ManualClock(4_000)
        let resumeTimeline = CaptureTimeline(
            monotonicClock: { resumeClock.read() }
        )
        _ = try resumeTimeline.beginActive()
        resumeClock.advance(200)
        let firstCompletion = try resumeTimeline.endActive()
        try require(
            firstCompletion.sourceTimeUs == 200,
            "ordinary confirmed segment used the wrong frontier"
        )

        let resumeGate = CaptureSegmentCloseGate(timeline: resumeTimeline)
        let failedResume = try resumeTimeline.beginPreparedActive()
        try require(
            failedResume.start.sourceTimeUs == 200,
            "failed resume began at the wrong frontier"
        )
        let failedResumeScope = try resumeGate.arm(segmentIndex: 3)
        resumeClock.advance(75)
        let failedResumeClose = try requestedClose(
            resumeGate.claimRequested(
                scope: failedResumeScope,
                reason: .startFailure
            )
        )
        try require(
            resumeTimeline.discardPreparedInterval(
                failedResume,
                closedAt: failedResumeClose.stamp
            ) == .discarded,
            "failed resume was not discarded"
        )
        _ = resumeGate.retire(scope: failedResumeScope)

        let retry = try resumeTimeline.beginPreparedActive()
        try require(
            retry.start.sourceTimeUs == 200,
            "retry inherited failed prepared duration"
        )
        try require(
            resumeTimeline.commitPreparedInterval(retry) == .committed,
            "retry did not commit"
        )
        let retryScope = try resumeGate.arm(segmentIndex: 4)
        resumeClock.advance(25)
        let stopped = try requestedClose(
            resumeGate.claimRequested(
                scope: retryScope,
                reason: .stop
            )
        )
        try require(
            stopped.stamp.sourceTimeUs == 225,
            "retry stop frontier included failed resume time"
        )
        try require(
            resumeTimeline.sample().sourceTimeUs == 225,
            "session frontier changed after retry stop"
        )
        cases.append("failed-resume-retry-frontier")

        let report: [String: Any] = [
            "caseCount": cases.count,
            "cases": cases,
            "finalFrontierUs": resumeTimeline.sample().sourceTimeUs,
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

test("prepared timeline intervals commit or roll back exactly once", async () => {
  if (process.platform !== "darwin") return;

  const { stderr, stdout } = await runCaptureSegmentCloseGateHarness(harnessSource);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    caseCount: 4,
    cases: [
      "announcement-rejection-discards",
      "identity-and-close-exact",
      "queued-close-commit-retains",
      "failed-resume-retry-frontier",
    ],
    finalFrontierUs: 225,
  });
}, 60_000);
