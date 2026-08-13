import { expect, test } from "bun:test";
import { runCaptureControllerFinalizationHarness } from "./build";

const harnessSource = String.raw`
import Foundation

enum HarnessFailure: Error {
    case assertion(String)
}

func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw HarnessFailure.assertion(message) }
}

final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func increment() {
        lock.lock()
        stored += 1
        lock.unlock()
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

final class AsyncThreshold: @unchecked Sendable {
    private let lock = NSLock()
    private let target: Int
    private var count = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(target: Int) {
        self.target = target
    }

    func arrive() {
        lock.lock()
        count += 1
        guard count >= target else {
            lock.unlock()
            return
        }
        let pending = waiters
        waiters.removeAll(keepingCapacity: false)
        lock.unlock()
        for waiter in pending {
            waiter.resume()
        }
    }

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if count >= target {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }
}

@main
struct HarnessMain {
    static func main() async throws {
        let fallback = CaptureControllerPreparedFailure(
            code: "fallback",
            message: "fallback failure",
            recoverable: true,
            state: .ready
        )
        let replacement = CaptureControllerPreparedFailure(
            code: "late-screen-failure",
            message: "the screen start callback failed",
            recoverable: false,
            state: .paused
        )
        let coordinator = CaptureControllerStartCoordinator(
            fallbackFailure: fallback
        )
        let mediaCleanupStarted = AsyncThreshold(target: 3)
        let cleanupRelease = AsyncGate()
        let cleanupFinished = LockedCounter()
        let metadataCleanupStarted = LockedCounter()

        let waiters = (0..<64).map { _ in
            Task {
                await coordinator.drain()
            }
        }
        for waiter in waiters.prefix(32) {
            waiter.cancel()
        }

        func mediaCleanup() -> CaptureControllerPreparedCleanup {
            {
                mediaCleanupStarted.arrive()
                await cleanupRelease.wait()
                cleanupFinished.increment()
            }
        }

        try require(
            coordinator.complete(.metadata, cleanup: {
                metadataCleanupStarted.increment()
                cleanupFinished.increment()
            }),
            "metadata did not resolve"
        )
        try require(
            coordinator.complete(.screen, cleanup: mediaCleanup()),
            "screen did not resolve"
        )
        try require(
            coordinator.complete(.camera, cleanup: mediaCleanup()),
            "camera did not resolve"
        )
        try require(
            cleanupFinished.value == 0,
            "cleanup ran before the final producer resolved"
        )
        coordinator.replaceFailure(replacement)
        try require(
            coordinator.complete(.microphone, cleanup: mediaCleanup()),
            "microphone did not resolve"
        )
        try require(
            !coordinator.complete(.microphone, cleanup: mediaCleanup()),
            "a producer resolved twice"
        )

        // Media cleanups run in parallel, while metadata remains live until
        // all media has drained.
        await mediaCleanupStarted.wait()
        try require(
            cleanupFinished.value == 0,
            "cleanup escaped its release gate"
        )
        try require(
            metadataCleanupStarted.value == 0,
            "metadata stopped before retained media drained"
        )
        try require(
            !coordinator.replaceFailure(fallback),
            "a running drain changed its shared outcome"
        )
        cleanupRelease.open()

        var outcomes: [CaptureControllerPreparedFailure] = []
        for waiter in waiters {
            outcomes.append(await waiter.value)
        }
        try require(
            cleanupFinished.value == 4,
            "shared drain did not execute each cleanup exactly once"
        )
        try require(
            outcomes.count == 64 && outcomes.allSatisfy { $0 == replacement },
            "cancelled or concurrent waiters did not replay one outcome"
        )

        let unstartedCleanup = LockedCounter()
        let unstarted = CaptureControllerStartCoordinator(
            fallbackFailure: fallback
        )
        try require(
            unstarted.complete(.metadata, cleanup: {
                unstartedCleanup.increment()
            }),
            "partial start metadata did not resolve"
        )
        unstarted.completeUnstarted([.screen, .camera, .microphone])
        let unstartedOutcome = await unstarted.drain()
        try require(
            unstartedOutcome == fallback,
            "partial start did not preserve its fallback failure"
        )
        try require(
            unstartedCleanup.value == 1,
            "partial start cleanup was not exact-once"
        )

        let report: [String: Any] = [
            "cleanupCount": cleanupFinished.value,
            "partialCleanupCount": unstartedCleanup.value,
            "waiterCount": outcomes.count,
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

test("prepared starts join late resources through one cancellation-safe drain", async () => {
  if (process.platform !== "darwin") return;

  const { stderr, stdout } = await runCaptureControllerFinalizationHarness(harnessSource);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    cleanupCount: 4,
    partialCleanupCount: 1,
    waiterCount: 64,
  });
}, 60_000);
