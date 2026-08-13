import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCaptureSegmentCloseGateHarness } from "./build";
import { parseCaptureInterruption } from "./protocol";

const harnessSource = String.raw`
import Foundation

enum HarnessFailure: Error {
    case assertion(String)
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else {
        throw HarnessFailure.assertion(message)
    }
}

final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64
    private var readCountValue = 0

    init(_ value: UInt64) {
        self.value = value
    }

    func read() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        readCountValue += 1
        return value
    }

    func set(_ value: UInt64) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    var readCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return readCountValue
    }
}

final class ConcurrentClaimCounts: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var accepted = 0
    private(set) var alreadyClaimed = 0
    private(set) var failures: [String] = []
    private var winningClose: CaptureSegmentClose?

    func record(_ result: CaptureSegmentCloseClaimResult) {
        lock.lock()
        defer { lock.unlock() }
        switch result {
        case .accepted(let close):
            accepted += 1
            if let winningClose, winningClose != close {
                failures.append("accepted close disagreed with winner")
            } else {
                winningClose = close
            }
        case .alreadyClaimed(let close):
            alreadyClaimed += 1
            if let winningClose, winningClose != close {
                failures.append("cascade close disagreed with winner")
            } else {
                winningClose = close
            }
        case .inactive:
            failures.append("concurrent claim found inactive gate")
        case .stale:
            failures.append("concurrent claim found stale scope")
        }
    }

    func record(error: Error) {
        lock.lock()
        failures.append(String(describing: error))
        lock.unlock()
    }
}

func acceptedClose(_ result: CaptureSegmentCloseClaimResult) throws -> CaptureSegmentClose {
    guard case .accepted(let close) = result else {
        throw HarnessFailure.assertion("expected accepted close")
    }
    return close
}

func alreadyClaimedClose(_ result: CaptureSegmentCloseClaimResult) throws -> CaptureSegmentClose {
    guard case .alreadyClaimed(let close) = result else {
        throw HarnessFailure.assertion("expected already-claimed close")
    }
    return close
}

func interruptionSeed(
    segmentIndex: Int,
    nativeTimeUs: UInt64,
    sourceId: String? = "display-1"
) throws -> CaptureInterruptionSeed {
    try CaptureInterruptionSeed(
        segmentIndex: segmentIndex,
        incident: .screen(.streamStopped),
        sourceId: sourceId,
        nativeTimeUs: nativeTimeUs
    )
}

@main
struct CaptureSegmentCloseGateHarness {
    static func main() throws {
        try require(
            saturatingTimelineMicrosecondSum(UInt64.max - 4, 10) == UInt64.max,
            "sample arithmetic did not saturate"
        )

        let exactClock = ManualClock(100)
        let exactTimeline = CaptureTimeline(monotonicClock: { exactClock.read() })
        _ = try exactTimeline.beginActive()
        let exactGate = CaptureSegmentCloseGate(timeline: exactTimeline)
        let exactScope = try exactGate.arm(segmentIndex: 0)
        exactClock.set(130)
        let exactClose = try acceptedClose(try exactGate.claimInterruption(
            scope: exactScope,
            seed: interruptionSeed(segmentIndex: 0, nativeTimeUs: 120)
        ))
        try require(exactClose.stamp == TimelineStamp(nativeTimeUs: 120, sourceTimeUs: 20), "callback time was not exact")
        guard let resolvedInterruption = try exactClose.resolvedInterruption(recoverable: true) else {
            throw HarnessFailure.assertion("interruption close did not resolve")
        }

        let publishedClock = ManualClock(140)
        let publishedTimeline = CaptureTimeline(monotonicClock: { publishedClock.read() })
        _ = try publishedTimeline.beginActive()
        let publishedGate = CaptureSegmentCloseGate(timeline: publishedTimeline)
        let publishedScope = try publishedGate.arm(segmentIndex: 1)
        publishedClock.set(160)
        try require(
            publishedTimeline.sample() == TimelineStamp(nativeTimeUs: 160, sourceTimeUs: 20),
            "published sample was wrong"
        )
        publishedClock.set(170)
        let publishedClose = try acceptedClose(try publishedGate.claimInterruption(
            scope: publishedScope,
            seed: interruptionSeed(segmentIndex: 1, nativeTimeUs: 150)
        ))
        try require(
            publishedClose.stamp == TimelineStamp(nativeTimeUs: 160, sourceTimeUs: 20),
            "backdated callback ended before the published metadata frontier"
        )

        let beforeClock = ManualClock(200)
        let beforeTimeline = CaptureTimeline(monotonicClock: { beforeClock.read() })
        _ = try beforeTimeline.beginActive()
        let beforeGate = CaptureSegmentCloseGate(timeline: beforeTimeline)
        let beforeScope = try beforeGate.arm(segmentIndex: 1)
        beforeClock.set(230)
        let beforeClose = try acceptedClose(try beforeGate.claimInterruption(
            scope: beforeScope,
            seed: interruptionSeed(segmentIndex: 1, nativeTimeUs: 190)
        ))
        try require(beforeClose.stamp == TimelineStamp(nativeTimeUs: 200, sourceTimeUs: 0), "before-start callback did not clamp")

        let futureClock = ManualClock(300)
        let futureTimeline = CaptureTimeline(monotonicClock: { futureClock.read() })
        _ = try futureTimeline.beginActive()
        let futureGate = CaptureSegmentCloseGate(timeline: futureTimeline)
        let futureScope = try futureGate.arm(segmentIndex: 2)
        futureClock.set(330)
        let futureClose = try acceptedClose(try futureGate.claimInterruption(
            scope: futureScope,
            seed: interruptionSeed(segmentIndex: 2, nativeTimeUs: 400)
        ))
        try require(futureClose.stamp == TimelineStamp(nativeTimeUs: 330, sourceTimeUs: 30), "future callback did not clamp")

        let pauseClock = ManualClock(1_000)
        let pauseTimeline = CaptureTimeline(monotonicClock: { pauseClock.read() })
        let pauseGate = CaptureSegmentCloseGate(timeline: pauseTimeline)
        let firstPauseStart = try pauseTimeline.beginActive()
        try require(firstPauseStart == TimelineStamp(nativeTimeUs: 1_000, sourceTimeUs: 0), "first segment start was wrong")
        let pauseScope = try pauseGate.arm(segmentIndex: 3)
        pauseClock.set(1_050)
        let pauseClose = try acceptedClose(try pauseGate.claimRequested(scope: pauseScope, reason: .pause))
        try require(pauseClose.stamp.sourceTimeUs == 50, "pause duration was wrong")
        guard case .retired(let retiredPause?) = pauseGate.retire(scope: pauseScope) else {
            throw HarnessFailure.assertion("pause scope did not retire")
        }
        try require(retiredPause == pauseClose, "retired close changed")
        pauseClock.set(1_100)
        let resumedStart = try pauseTimeline.beginActive()
        try require(resumedStart == TimelineStamp(nativeTimeUs: 1_100, sourceTimeUs: 50), "resume did not retain accumulation")
        let resumeScope = try pauseGate.arm(segmentIndex: 4)
        pauseClock.set(1_150)
        let resumeClose = try acceptedClose(try pauseGate.claimInterruption(
            scope: resumeScope,
            seed: interruptionSeed(segmentIndex: 4, nativeTimeUs: 1_140)
        ))
        try require(resumeClose.stamp == TimelineStamp(nativeTimeUs: 1_140, sourceTimeUs: 90), "resume accumulation was wrong")

        let regressionClock = ManualClock(500)
        let regressionTimeline = CaptureTimeline(monotonicClock: { regressionClock.read() })
        _ = try regressionTimeline.beginActive()
        regressionClock.set(490)
        try require(regressionTimeline.sample() == TimelineStamp(nativeTimeUs: 500, sourceTimeUs: 0), "sample regressed")
        regressionClock.set(510)
        _ = try regressionTimeline.endActive()
        regressionClock.set(400)
        let regressedStart = try regressionTimeline.beginActive()
        try require(regressedStart == TimelineStamp(nativeTimeUs: 510, sourceTimeUs: 10), "begin regressed")
        _ = try regressionTimeline.endActive(atNativeTimeUs: 510)

        let concurrentClock = ManualClock(2_000)
        let concurrentTimeline = CaptureTimeline(monotonicClock: { concurrentClock.read() })
        _ = try concurrentTimeline.beginActive()
        let concurrentGate = CaptureSegmentCloseGate(timeline: concurrentTimeline)
        let concurrentScope = try concurrentGate.arm(segmentIndex: 5)
        concurrentClock.set(2_010)
        let concurrentSeed = try interruptionSeed(segmentIndex: 5, nativeTimeUs: 2_005)
        let counts = ConcurrentClaimCounts()
        let group = DispatchGroup()
        for contender in 0..<64 {
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                do {
                    if contender.isMultiple(of: 2) {
                        counts.record(try concurrentGate.claimRequested(scope: concurrentScope, reason: .stop))
                    } else {
                        counts.record(try concurrentGate.claimInterruption(
                            scope: concurrentScope,
                            seed: concurrentSeed
                        ))
                    }
                } catch {
                    counts.record(error: error)
                }
            }
        }
        group.wait()
        try require(counts.accepted == 1, "concurrent claims accepted more than once")
        try require(counts.alreadyClaimed == 63, "concurrent cascades were not retained")
        try require(counts.failures.isEmpty, "concurrent claims failed")
        let readsAfterConcurrentWinner = concurrentClock.readCount
        _ = try alreadyClaimedClose(try concurrentGate.claimRequested(scope: concurrentScope, reason: .pause))
        try require(concurrentClock.readCount == readsAfterConcurrentWinner, "same-generation cascade touched the clock")

        let requestedClock = ManualClock(3_000)
        let requestedTimeline = CaptureTimeline(monotonicClock: { requestedClock.read() })
        _ = try requestedTimeline.beginActive()
        let requestedGate = CaptureSegmentCloseGate(timeline: requestedTimeline)
        let requestedScope = try requestedGate.arm(segmentIndex: 6)
        requestedClock.set(3_020)
        let requestedWinner = try acceptedClose(try requestedGate.claimRequested(scope: requestedScope, reason: .shutdown))
        let callbackCascade = try alreadyClaimedClose(try requestedGate.claimInterruption(
            scope: requestedScope,
            seed: interruptionSeed(segmentIndex: 6, nativeTimeUs: 3_010)
        ))
        try require(callbackCascade == requestedWinner, "callback replaced requested winner")
        guard case .requested(.shutdown) = callbackCascade.cause else {
            throw HarnessFailure.assertion("requested winner cause changed")
        }

        let callbackClock = ManualClock(4_000)
        let callbackTimeline = CaptureTimeline(monotonicClock: { callbackClock.read() })
        _ = try callbackTimeline.beginActive()
        let callbackGate = CaptureSegmentCloseGate(timeline: callbackTimeline)
        let callbackScope = try callbackGate.arm(segmentIndex: 7)
        callbackClock.set(4_020)
        let callbackWinner = try acceptedClose(try callbackGate.claimInterruption(
            scope: callbackScope,
            seed: interruptionSeed(segmentIndex: 7, nativeTimeUs: 4_010)
        ))
        let requestedCascade = try alreadyClaimedClose(try callbackGate.claimRequested(scope: callbackScope, reason: .termination))
        try require(requestedCascade == callbackWinner, "requested close replaced callback winner")
        guard case .interruption = requestedCascade.cause else {
            throw HarnessFailure.assertion("callback winner cause changed")
        }

        let staleClock = ManualClock(5_000)
        let staleTimeline = CaptureTimeline(monotonicClock: { staleClock.read() })
        let staleGate = CaptureSegmentCloseGate(timeline: staleTimeline)
        _ = try staleTimeline.beginActive()
        let oldScope = try staleGate.arm(segmentIndex: 8)
        staleClock.set(5_010)
        _ = try staleGate.claimRequested(scope: oldScope, reason: .pause)
        _ = staleGate.retire(scope: oldScope)
        staleClock.set(5_100)
        _ = try staleTimeline.beginActive()
        let newScope = try staleGate.arm(segmentIndex: 9)
        staleClock.set(5_120)
        let readsBeforeStaleClaim = staleClock.readCount
        guard case .stale(let activeScope) = try staleGate.claimRequested(scope: oldScope, reason: .stop) else {
            throw HarnessFailure.assertion("old scope was not stale")
        }
        try require(activeScope == newScope, "stale result omitted current scope")
        try require(staleClock.readCount == readsBeforeStaleClaim, "stale scope touched the clock")
        let newClose = try acceptedClose(try staleGate.claimRequested(scope: newScope, reason: .stop))
        try require(newClose.scope == newScope, "stale scope ended new segment")

        let firstGateClock = ManualClock(5_500)
        let firstGateTimeline = CaptureTimeline(monotonicClock: { firstGateClock.read() })
        _ = try firstGateTimeline.beginActive()
        let firstGate = CaptureSegmentCloseGate(timeline: firstGateTimeline)
        let firstGateScope = try firstGate.arm(segmentIndex: 12)
        let secondGateClock = ManualClock(5_500)
        let secondGateTimeline = CaptureTimeline(monotonicClock: { secondGateClock.read() })
        _ = try secondGateTimeline.beginActive()
        let secondGate = CaptureSegmentCloseGate(timeline: secondGateTimeline)
        let secondGateScope = try secondGate.arm(segmentIndex: 12)
        try require(firstGateScope != secondGateScope, "different gates issued equal scopes")
        firstGateClock.set(5_510)
        secondGateClock.set(5_510)
        let secondGateReadsBeforeMisuse = secondGateClock.readCount
        guard case .stale(let actualSecondScope) = try secondGate.claimRequested(
            scope: firstGateScope,
            reason: .stop
        ) else {
            throw HarnessFailure.assertion("cross-gate claim was not stale")
        }
        try require(actualSecondScope == secondGateScope, "cross-gate claim omitted actual scope")
        guard case .stale(let retireSecondScope) = secondGate.retire(scope: firstGateScope) else {
            throw HarnessFailure.assertion("cross-gate retire was not stale")
        }
        try require(retireSecondScope == secondGateScope, "cross-gate retire omitted actual scope")
        try require(
            secondGateClock.readCount == secondGateReadsBeforeMisuse,
            "cross-gate misuse touched the other timeline"
        )
        _ = try acceptedClose(try secondGate.claimRequested(scope: secondGateScope, reason: .stop))
        _ = try acceptedClose(try firstGate.claimRequested(scope: firstGateScope, reason: .stop))

        let inactiveClock = ManualClock(6_000)
        let inactiveTimeline = CaptureTimeline(monotonicClock: { inactiveClock.read() })
        _ = try inactiveTimeline.beginActive()
        let inactiveGate = CaptureSegmentCloseGate(timeline: inactiveTimeline)
        let inactiveScope = try inactiveGate.arm(segmentIndex: 10)
        guard case .retired(nil) = inactiveGate.retire(scope: inactiveScope) else {
            throw HarnessFailure.assertion("unclaimed scope did not retire")
        }
        let readsBeforeInactiveClaim = inactiveClock.readCount
        guard case .inactive = try inactiveGate.claimRequested(scope: inactiveScope, reason: .stop) else {
            throw HarnessFailure.assertion("retired gate did not report inactive")
        }
        try require(inactiveClock.readCount == readsBeforeInactiveClaim, "inactive gate touched the clock")
        inactiveClock.set(6_010)
        let inactiveEnd = try inactiveTimeline.endActive()
        try require(inactiveEnd == TimelineStamp(nativeTimeUs: 6_010, sourceTimeUs: 10), "retire changed timeline")

        let mismatchClock = ManualClock(6_500)
        let mismatchTimeline = CaptureTimeline(monotonicClock: { mismatchClock.read() })
        _ = try mismatchTimeline.beginActive()
        let mismatchGate = CaptureSegmentCloseGate(timeline: mismatchTimeline)
        let mismatchScope = try mismatchGate.arm(segmentIndex: 13)
        mismatchClock.set(6_510)
        let readsBeforeMismatch = mismatchClock.readCount
        do {
            _ = try mismatchGate.claimInterruption(
                scope: mismatchScope,
                seed: interruptionSeed(segmentIndex: 14, nativeTimeUs: 6_505)
            )
            throw HarnessFailure.assertion("mismatched interruption segment was accepted")
        } catch CaptureSegmentCloseGateError.interruptionSegmentMismatch {
            // The gate validates scope identity before freezing the timeline.
        }
        try require(mismatchClock.readCount == readsBeforeMismatch, "mismatched seed touched the clock")
        let validAfterMismatch = try acceptedClose(try mismatchGate.claimInterruption(
            scope: mismatchScope,
            seed: interruptionSeed(segmentIndex: 13, nativeTimeUs: 6_505)
        ))
        try require(validAfterMismatch.stamp.sourceTimeUs == 5, "mismatched seed froze timeline")

        let invalidConstructorClock = ManualClock(7_000)
        let invalidConstructorTimeline = CaptureTimeline(monotonicClock: { invalidConstructorClock.read() })
        _ = try invalidConstructorTimeline.beginActive()
        let invalidConstructorGate = CaptureSegmentCloseGate(timeline: invalidConstructorTimeline)
        let invalidConstructorScope = try invalidConstructorGate.arm(segmentIndex: 11)
        invalidConstructorClock.set(7_010)
        let readsBeforeInvalidConstruction = invalidConstructorClock.readCount
        do {
            _ = try interruptionSeed(segmentIndex: 11, nativeTimeUs: 7_005, sourceId: "bad\u{0}source")
            throw HarnessFailure.assertion("invalid source ID was accepted")
        } catch CaptureInterruptionValueError.invalidSourceID {
            // Construction rejects malformed identity before the gate is called.
        }
        try require(
            invalidConstructorClock.readCount == readsBeforeInvalidConstruction,
            "invalid source constructor touched the clock"
        )
        let validAfterInvalidConstruction = try acceptedClose(try invalidConstructorGate.claimRequested(
            scope: invalidConstructorScope,
            reason: .stop
        ))
        try require(validAfterInvalidConstruction.stamp.sourceTimeUs == 10, "invalid constructor froze timeline")

        let data = try resolvedInterruption.encodedJSON()
        guard let line = String(data: data, encoding: .utf8) else {
            throw HarnessFailure.assertion("resolved interruption was not UTF-8")
        }
        print(line)
    }
}
`;

function descendantHarnessSource(
  pidReceiptPath: string,
  parentOutcome: "excessive-output" | "success",
): string {
  const childRedirect = parentOutcome === "success" ? "exec >/dev/null 2>&1; " : "";
  const parentAction = parentOutcome === "success"
    ? "print(\"parent-complete\")"
    : "try FileHandle.standardOutput.write(contentsOf: Data(repeating: 120, count: 200_000))\n        Thread.sleep(forTimeInterval: 30)";
  return String.raw`
import Darwin
import Foundation

@main
struct DescendantHarness {
    static func main() throws {
        let pidReceiptPath = ${JSON.stringify(pidReceiptPath)}
        let readinessPath = CommandLine.arguments[0] + ".ready"
        let script = "${childRedirect}trap '' TERM; : > '\(readinessPath)'; while :; do sleep 30; done"
        let arguments = ["/bin/sh", "-c", script]
        var argumentPointers = arguments.map { strdup($0) }
        guard argumentPointers.allSatisfy({ $0 != nil }) else {
            throw NSError(domain: "studio.capture.harness", code: 1)
        }
        argumentPointers.append(nil)
        defer {
            for pointer in argumentPointers {
                free(pointer)
            }
        }
        var descendant: pid_t = 0
        let spawnResult = "/bin/sh".withCString { executablePath in
            argumentPointers.withUnsafeMutableBufferPointer { buffer in
                posix_spawn(&descendant, executablePath, nil, nil, buffer.baseAddress, environ)
            }
        }
        guard spawnResult == 0, descendant > 0 else {
            throw NSError(domain: "studio.capture.harness", code: 2)
        }
        try String(descendant).write(toFile: pidReceiptPath, atomically: true, encoding: .utf8)
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: readinessPath) {
            usleep(10_000)
        }
        guard FileManager.default.fileExists(atPath: readinessPath) else {
            throw NSError(domain: "studio.capture.harness", code: 3)
        }
        ${parentAction}
    }
}
`;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  if (!(rejection instanceof Error)) {
    throw new Error("Expected harness operation to reject with an Error.");
  }
  return rejection.message;
}

function processExists(processIdentifier: number): boolean {
  try {
    process.kill(processIdentifier, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(processIdentifier: number, maximumWaitMs = 1_000): Promise<boolean> {
  const deadline = performance.now() + maximumWaitMs;
  while (processExists(processIdentifier)) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(10, remainingMs));
    });
  }
  return true;
}

function parseProcessIdentifier(value: string): number {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error("Harness descendant PID receipt was invalid.");
  }
  const processIdentifier = Number(normalized);
  if (!Number.isSafeInteger(processIdentifier)) {
    throw new Error("Harness descendant PID receipt exceeded the safe integer range.");
  }
  return processIdentifier;
}

test("capture harness rejects malformed source before platform discovery", async () => {
  expect(
    await rejectionMessage(runCaptureSegmentCloseGateHarness("print(\"missing main\")")),
  ).toContain("bounded Swift @main source");
});

test("capture harness bounds output and kills a termination-ignoring descendant", async () => {
  if (process.platform !== "darwin") return;
  const receiptDirectory = await mkdtemp(join(tmpdir(), "transmute-capture-descendant-receipt-"));
  const pidReceiptPath = join(receiptDirectory, "descendant.pid");
  let descendantProcessIdentifier: number | undefined;
  const startedAt = performance.now();
  try {
    const message = await rejectionMessage(runCaptureSegmentCloseGateHarness(
      descendantHarnessSource(pidReceiptPath, "excessive-output"),
    ));
    descendantProcessIdentifier = parseProcessIdentifier(await readFile(pidReceiptPath, "utf8"));
    expect(message).toContain("stdout exceeded the 131072-byte harness output limit");
    expect(await waitForProcessExit(descendantProcessIdentifier)).toBeTrue();
    expect(performance.now() - startedAt).toBeLessThan(15_000);
  } finally {
    if (
      descendantProcessIdentifier !== undefined
      && processExists(descendantProcessIdentifier)
    ) {
      process.kill(descendantProcessIdentifier, "SIGKILL");
      await waitForProcessExit(descendantProcessIdentifier);
    }
    await rm(receiptDirectory, { force: true, recursive: true });
  }
}, 20_000);

test("capture harness cleans descendants after a successful parent exit", async () => {
  if (process.platform !== "darwin") return;
  const receiptDirectory = await mkdtemp(join(tmpdir(), "transmute-capture-success-receipt-"));
  const pidReceiptPath = join(receiptDirectory, "descendant.pid");
  let descendantProcessIdentifier: number | undefined;
  try {
    const result = await runCaptureSegmentCloseGateHarness(
      descendantHarnessSource(pidReceiptPath, "success"),
    );
    descendantProcessIdentifier = parseProcessIdentifier(await readFile(pidReceiptPath, "utf8"));
    expect(result).toEqual({ stderr: "", stdout: "parent-complete\n" });
    expect(await waitForProcessExit(descendantProcessIdentifier)).toBeTrue();
  } finally {
    if (
      descendantProcessIdentifier !== undefined
      && processExists(descendantProcessIdentifier)
    ) {
      process.kill(descendantProcessIdentifier, "SIGKILL");
      await waitForProcessExit(descendantProcessIdentifier);
    }
    await rm(receiptDirectory, { force: true, recursive: true });
  }
}, 20_000);

test("capture segment close gate freezes once across requests and native callbacks", async () => {
  if (process.platform !== "darwin") return;
  const { stderr, stdout } = await runCaptureSegmentCloseGateHarness(harnessSource);
  expect(stderr).toBe("");
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const interruption = parseCaptureInterruption(JSON.parse(lines[0] ?? "null") as unknown);
  expect(interruption).toEqual({
    code: "screen-stream-stopped",
    nativeTimeUs: 120,
    recoverable: true,
    segmentIndex: 0,
    source: "screen",
    sourceId: "display-1",
    sourceTimeUs: 20,
  });
}, 60_000);
