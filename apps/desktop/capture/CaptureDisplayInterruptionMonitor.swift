import CoreGraphics
import Foundation

struct CaptureSelectedDisplayIdentity: Equatable, Sendable {
    let displayId: CGDirectDisplayID
    let isPrimary: Bool
}

enum CaptureDisplayInterruptionMonitorError: Error, Equatable {
    case callbackCapacityExceeded
    case callbackIdentityExhausted
    case registrationFailed(Int32)
}

/// Owns callback handlers behind opaque, process-monotonic pointer tokens.
///
/// CoreGraphics documents callback removal as unregistering, not as an
/// in-flight callback drain. The C callback therefore treats `userInfo` only
/// as an identity key and never dereferences it. Registry entry/exit is the
/// lifetime barrier for the Swift handler.
private final class CaptureDisplayReconfigurationCallbackRegistry:
    @unchecked Sendable {
    typealias Handler =
        @Sendable (CGDirectDisplayID, CGDisplayChangeSummaryFlags) -> Void

    private final class Entry {
        let handler: Handler
        var acceptingCallbacks = true
        var inFlightCallbacks = 0

        init(handler: @escaping Handler) {
            self.handler = handler
        }
    }

    static let shared = CaptureDisplayReconfigurationCallbackRegistry()

    private let condition = NSCondition()
    private var entries: [UInt: Entry] = [:]
    private var nextToken: UInt = 1

    func install(
        handler: @escaping Handler
    ) throws -> UnsafeMutableRawPointer {
        condition.lock()
        guard entries.count < maximumCaptureSegments else {
            condition.unlock()
            throw CaptureDisplayInterruptionMonitorError
                .callbackCapacityExceeded
        }
        let key = nextToken
        let (followingToken, overflow) = key.addingReportingOverflow(1)
        guard !overflow,
              let pointer = UnsafeMutableRawPointer(bitPattern: key) else {
            condition.unlock()
            throw CaptureDisplayInterruptionMonitorError
                .callbackIdentityExhausted
        }
        nextToken = followingToken
        entries[key] = Entry(handler: handler)
        condition.unlock()
        return pointer
    }

    func invoke(
        pointer: UnsafeMutableRawPointer,
        displayId: CGDirectDisplayID,
        flags: CGDisplayChangeSummaryFlags
    ) {
        let key = UInt(bitPattern: pointer)
        let entry: Entry
        condition.lock()
        guard let current = entries[key],
              current.acceptingCallbacks else {
            condition.unlock()
            return
        }
        current.inFlightCallbacks += 1
        entry = current
        condition.unlock()

        entry.handler(displayId, flags)

        condition.lock()
        precondition(entry.inFlightCallbacks > 0)
        entry.inFlightCallbacks -= 1
        if !entry.acceptingCallbacks && entry.inFlightCallbacks == 0 {
            condition.broadcast()
        }
        condition.unlock()
    }

    func deactivateAndDrain(pointer: UnsafeMutableRawPointer) {
        let key = UInt(bitPattern: pointer)
        condition.lock()
        guard let entry = entries[key] else {
            condition.unlock()
            return
        }
        entry.acceptingCallbacks = false
        while entry.inFlightCallbacks > 0 {
            condition.wait()
        }
        entries.removeValue(forKey: key)
        condition.unlock()

        // A callback that entered CoreGraphics before removal may still carry
        // this value. Tokens are process-monotonic and never reused, so its
        // later registry miss cannot alias a future registration.
    }

    func discardUnregistered(pointer: UnsafeMutableRawPointer) {
        let key = UInt(bitPattern: pointer)
        condition.lock()
        guard let entry = entries[key] else {
            condition.unlock()
            return
        }
        precondition(entry.inFlightCallbacks == 0)
        entries.removeValue(forKey: key)
        condition.unlock()
    }
}

final class CaptureDisplayReconfigurationCallbackContext:
    @unchecked Sendable {
    let userInfo: UnsafeMutableRawPointer

    init(
        handler: @escaping CaptureDisplayReconfigurationSource.Handler
    ) throws {
        userInfo = try CaptureDisplayReconfigurationCallbackRegistry.shared
            .install(handler: handler)
    }

    func deactivateAndDrain() {
        CaptureDisplayReconfigurationCallbackRegistry.shared
            .deactivateAndDrain(pointer: userInfo)
    }

    func discardUnregistered() {
        CaptureDisplayReconfigurationCallbackRegistry.shared
            .discardUnregistered(pointer: userInfo)
    }
}

func captureDisplayReconfigurationCallback(
    displayId: CGDirectDisplayID,
    flags: CGDisplayChangeSummaryFlags,
    userInfo: UnsafeMutableRawPointer?
) {
    guard let userInfo else { return }
    CaptureDisplayReconfigurationCallbackRegistry.shared.invoke(
        pointer: userInfo,
        displayId: displayId,
        flags: flags
    )
}

struct CaptureDisplayReconfigurationSource: @unchecked Sendable {
    typealias Handler =
        @Sendable (CGDirectDisplayID, CGDisplayChangeSummaryFlags) -> Void
    typealias Register =
        (@escaping Handler) throws -> CaptureInterruptionObserverCancellation

    private let registerAction: Register

    init(register: @escaping Register) {
        registerAction = register
    }

    func register(
        _ handler: @escaping Handler
    ) throws -> CaptureInterruptionObserverCancellation {
        try registerAction(handler)
    }

    static let coreGraphics = CaptureDisplayReconfigurationSource {
        handler in
        let context = try CaptureDisplayReconfigurationCallbackContext(
            handler: handler
        )
        let result = CGDisplayRegisterReconfigurationCallback(
            captureDisplayReconfigurationCallback,
            context.userInfo
        )
        guard result == .success else {
            context.discardUnregistered()
            throw CaptureDisplayInterruptionMonitorError
                .registrationFailed(result.rawValue)
        }
        return CaptureInterruptionObserverCancellation {
            let removal = CGDisplayRemoveReconfigurationCallback(
                captureDisplayReconfigurationCallback,
                context.userInfo
            )
            guard removal == .success else {
                // Retain the registry entry if CoreGraphics still owns the
                // registration. A bounded leak is safer than a callback UAF.
                return
            }
            context.deactivateAndDrain()
        }
    }
}

typealias CaptureActiveDisplayProvider =
    @Sendable () -> Set<CGDirectDisplayID>?

func captureActiveDisplayIdentifiers() -> Set<CGDirectDisplayID>? {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success else {
        return nil
    }
    var identifiers = Array(
        repeating: CGDirectDisplayID(),
        count: Int(count)
    )
    guard count == 0
            || CGGetActiveDisplayList(
                count,
                &identifiers,
                &count
            ) == .success else {
        return nil
    }
    return Set(identifiers.prefix(Int(count)))
}

/// Coalesces CoreGraphics cascades onto one serial active-display comparison.
final class CaptureDisplayInterruptionMonitor: @unchecked Sendable {
    private let stateLock = NSLock()
    private let selected: [CaptureSelectedDisplayIdentity]
    private let reporter: CaptureInterruptionReporter
    private let source: CaptureDisplayReconfigurationSource
    private let activeDisplays: CaptureActiveDisplayProvider
    private let queue: DispatchQueue
    private var cancellation: CaptureInterruptionObserverCancellation?
    private var observing = false
    private var invalidated = false
    private var scheduled = false
    private var dirty = false

    init(
        selected: [CaptureSelectedDisplayIdentity],
        reporter: CaptureInterruptionReporter,
        source: CaptureDisplayReconfigurationSource = .coreGraphics,
        activeDisplays: @escaping CaptureActiveDisplayProvider = {
            captureActiveDisplayIdentifiers()
        },
        queue: DispatchQueue = DispatchQueue(
            label: "com.hraness.atet.capture.display-interruptions",
            qos: .userInitiated
        )
    ) {
        precondition(!selected.isEmpty && selected.count <= 16)
        precondition(
            Set(selected.map(\.displayId)).count == selected.count
        )
        self.selected = selected.sorted { lhs, rhs in
            if lhs.isPrimary != rhs.isPrimary {
                return lhs.isPrimary
            }
            return lhs.displayId < rhs.displayId
        }
        self.reporter = reporter
        self.source = source
        self.activeDisplays = activeDisplays
        self.queue = queue
    }

    func startObserving() throws {
        stateLock.lock()
        precondition(!observing)
        precondition(!invalidated)
        observing = true
        stateLock.unlock()

        let created: CaptureInterruptionObserverCancellation
        do {
            created = try source.register { [weak self] displayId, flags in
                self?.receive(displayId: displayId, flags: flags)
            }
        } catch {
            stateLock.lock()
            invalidated = true
            stateLock.unlock()
            throw error
        }
        stateLock.lock()
        if invalidated {
            stateLock.unlock()
            created.cancel()
            return
        }
        cancellation = created
        stateLock.unlock()
        reporter.registerObserverTeardown { [weak self] in
            self?.invalidate()
        }
        requestComparison()
    }

    func invalidate() {
        let pending: CaptureInterruptionObserverCancellation?
        stateLock.lock()
        guard !invalidated else {
            stateLock.unlock()
            return
        }
        invalidated = true
        dirty = false
        pending = cancellation
        cancellation = nil
        stateLock.unlock()
        pending?.cancel()
    }

    func flush() async {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume()
            }
        }
    }

    private func receive(
        displayId: CGDirectDisplayID,
        flags: CGDisplayChangeSummaryFlags
    ) {
        guard !flags.contains(.beginConfigurationFlag) else { return }
        stateLock.lock()
        guard !invalidated else {
            stateLock.unlock()
            return
        }
        if flags.contains(.removeFlag),
           selected.contains(where: { $0.displayId == displayId }) {
            stateLock.unlock()
            _ = reporter.report(
                incident: .screen(.selectedDisplayDisconnected),
                sourceId: String(displayId)
            )
            return
        }
        dirty = true
        scheduleDrainLocked()
        stateLock.unlock()
    }

    private func requestComparison() {
        stateLock.lock()
        guard !invalidated else {
            stateLock.unlock()
            return
        }
        dirty = true
        scheduleDrainLocked()
        stateLock.unlock()
    }

    private func scheduleDrainLocked() {
        guard !scheduled else {
            return
        }
        scheduled = true
        queue.async { [weak self] in
            self?.drainChanges()
        }
    }

    private func drainChanges() {
        while true {
            stateLock.lock()
            guard !invalidated else {
                scheduled = false
                dirty = false
                stateLock.unlock()
                return
            }
            guard dirty else {
                scheduled = false
                stateLock.unlock()
                return
            }
            dirty = false
            stateLock.unlock()

            if let active = activeDisplays(),
               let missing = selected.first(where: {
                   !active.contains($0.displayId)
               }) {
                _ = reporter.report(
                    incident: .screen(.selectedDisplayDisconnected),
                    sourceId: String(missing.displayId)
                )
            }
        }
    }
}
