import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private let maximumMetadataLineBytes = 64 * 1024
private let maximumPendingMetadataWrites = 2_048
private let maximumWindowRecords = 96
private let eventTapThreadShutdownTimeoutSeconds = 2

struct MetadataFileCompletion {
    let relativePath: String
    let eventKinds: [String]
    let recordCount: UInt64
    let droppedEvents: UInt64

    var json: [String: Any] {
        [
            "path": relativePath,
            "eventKinds": eventKinds,
            "recordCount": recordCount,
            "droppedEvents": droppedEvents,
        ]
    }
}

private struct DropSnapshot {
    let count: UInt64
    let firstNativeTimeUs: UInt64
    let lastNativeTimeUs: UInt64
}

private final class BoundedEventFile: @unchecked Sendable {
    let relativePath: String
    let eventKinds: [String]
    private let handle: FileHandle
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var pending = 0
    private var records: UInt64 = 0
    private var dropped: UInt64 = 0
    private var firstDroppedNativeTimeUs: UInt64 = 0
    private var lastDroppedNativeTimeUs: UInt64 = 0
    private var closed = false

    init(session: SessionDirectory, relativePath: String, eventKinds: [String]) throws {
        self.relativePath = relativePath
        self.eventKinds = eventKinds
        handle = try session.createExclusiveFile(relativePath)
        queue = DispatchQueue(label: "com.hraness.atet.capture.metadata.\(relativePath)")
    }

    @discardableResult
    func append(_ object: [String: Any], nativeTimeUs: UInt64) -> Bool {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              data.count + 1 <= maximumMetadataLineBytes else {
            recordDrop(nativeTimeUs: nativeTimeUs)
            return false
        }
        data.append(0x0A)
        lock.lock()
        guard !closed else {
            lock.unlock()
            return false
        }
        guard pending < maximumPendingMetadataWrites else {
            dropped &+= 1
            if firstDroppedNativeTimeUs == 0 { firstDroppedNativeTimeUs = nativeTimeUs }
            lastDroppedNativeTimeUs = nativeTimeUs
            lock.unlock()
            return false
        }
        pending += 1
        lock.unlock()
        queue.async {
            var wrote = false
            do {
                try self.handle.write(contentsOf: data)
                wrote = true
            } catch {
                wrote = false
            }
            self.lock.lock()
            self.pending -= 1
            if wrote {
                self.records &+= 1
            } else {
                self.dropped &+= 1
                if self.firstDroppedNativeTimeUs == 0 { self.firstDroppedNativeTimeUs = nativeTimeUs }
                self.lastDroppedNativeTimeUs = nativeTimeUs
            }
            self.lock.unlock()
        }
        return true
    }

    func flush() {
        queue.sync {}
    }

    func dropSnapshot() -> DropSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return DropSnapshot(
            count: dropped,
            firstNativeTimeUs: firstDroppedNativeTimeUs,
            lastNativeTimeUs: lastDroppedNativeTimeUs
        )
    }

    func completion() -> MetadataFileCompletion {
        lock.lock()
        closed = true
        lock.unlock()
        flush()
        lock.lock()
        let result = MetadataFileCompletion(
            relativePath: relativePath,
            eventKinds: eventKinds,
            recordCount: records,
            droppedEvents: dropped
        )
        lock.unlock()
        try? handle.synchronize()
        try? handle.close()
        return result
    }

    private func recordDrop(nativeTimeUs: UInt64) {
        lock.lock()
        guard !closed else {
            lock.unlock()
            return
        }
        dropped &+= 1
        if firstDroppedNativeTimeUs == 0 { firstDroppedNativeTimeUs = nativeTimeUs }
        lastDroppedNativeTimeUs = nativeTimeUs
        lock.unlock()
    }
}

private struct FocusSnapshot {
    let signature: String
    let target: [String: Any]
    let frontmost: [String: Any]
    let secure: Bool
    let allowsTypedText: Bool
    let bounds: CGRect?
    let fieldId: String?
    let processId: pid_t?
    let windowId: String?
    let windowTitle: String?
}

private struct FocusWindowIdentity {
    let identifier: String
    let title: String?
}

private struct WindowRecord {
    let identifier: String
    let isFocused: Bool
    let json: [String: Any]
    let signature: Data
}

private func metadataEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let coordinator = Unmanaged<MetadataCoordinator>.fromOpaque(userInfo).takeUnretainedValue()
    coordinator.receiveInput(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

final class MetadataCoordinator: @unchecked Sendable {
    private let clock: CaptureTimeline
    private let options: CaptureOptions
    private let cursorFile: BoundedEventFile
    private let inputFile: BoundedEventFile
    private let windowsFile: BoundedEventFile
    private let displaysFile: BoundedEventFile
    private let focusFile: BoundedEventFile
    private let lifecycleFile: BoundedEventFile
    private let stateLock = NSLock()
    private let eventEmissionLock = NSLock()
    private let pollingQueue = DispatchQueue(
        label: "com.hraness.atet.capture.metadata.polling"
    )
    private let eventTapThreadReady = DispatchSemaphore(value: 0)
    private let eventTapThreadFinished = DispatchSemaphore(value: 0)
    private var sequence: UInt64 = 0
    private var stopped = false
    private var cursorTimer: DispatchSourceTimer?
    private var windowsTimer: DispatchSourceTimer?
    private var focusTimer: DispatchSourceTimer?
    private var displaysTimer: DispatchSourceTimer?
    private var eventTap: CFMachPort?
    private var eventTapRunLoop: CFRunLoop?
    private var eventTapScope = "session"
    private var eventTapStarted = false
    private var eventTapReadySignaled = false
    private var eventTapOperational = false
    private var hasWindowSnapshot = false
    private var lastFocusSignature: String?
    private var lastWindowRecords: [String: WindowRecord] = [:]
    private var lastTopologySignature: Data?
    private let segmentId: String

    init(session: SessionDirectory, segmentIndex: Int, clock: CaptureTimeline, options: CaptureOptions) throws {
        self.clock = clock
        self.options = options
        segmentId = String(format: "segment_%08d", segmentIndex + 1)
        let prefix = String(format: "events/segment_%04d", segmentIndex + 1)
        cursorFile = try BoundedEventFile(
            session: session,
            relativePath: "\(prefix)-cursor.jsonl",
            eventKinds: ["cursor.sample"]
        )
        inputFile = try BoundedEventFile(
            session: session,
            relativePath: "\(prefix)-input.jsonl",
            eventKinds: ["mouse.click", "key.activity", "typing.input"]
        )
        windowsFile = try BoundedEventFile(
            session: session,
            relativePath: "\(prefix)-windows.jsonl",
            eventKinds: ["window.snapshot", "window.changed"]
        )
        displaysFile = try BoundedEventFile(
            session: session,
            relativePath: "\(prefix)-displays.jsonl",
            eventKinds: ["display.topology"]
        )
        focusFile = try BoundedEventFile(
            session: session,
            relativePath: "\(prefix)-focus.jsonl",
            eventKinds: ["focus.changed"]
        )
        lifecycleFile = try BoundedEventFile(
            session: session,
            relativePath: "\(prefix)-lifecycle.jsonl",
            eventKinds: ["lifecycle.marker", "diagnostic.dropped-events"]
        )
    }

    func prepareInputEventTap() throws {
        let mask = [
            CGEventType.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp, .keyDown, .keyUp,
        ].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let tap: CFMachPort?
        let tapScope: String
        if let processId = options.interactionEventProcessIdentifier {
            tap = CGEvent.tapCreateForPid(
                pid: processId,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: mask,
                callback: metadataEventTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            )
            tapScope = "process-scoped"
        } else {
            tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: mask,
                callback: metadataEventTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            )
            tapScope = "session"
        }
        guard let tap else {
            if options.strictSources {
                throw HelperFailure(
                    code: "metadata-event-tap-unavailable",
                    message: "Strict capture could not create the \(tapScope) listen-only event tap required for interaction metadata.",
                    recoverable: true
                )
            }
            appendMetadataDiagnostic(
                category: "keyboard",
                reason: "\(tapScope) listen-only event tap unavailable"
            )
            return
        }
        CGEvent.tapEnable(tap: tap, enable: false)
        stateLock.lock()
        eventTap = tap
        eventTapScope = tapScope
        stateLock.unlock()
    }

    func start(marker: String) throws {
        appendLifecycle(marker: marker)
        try startPreparedEventTap()
        pollingQueue.sync {
            pollDisplays()
            pollFocus()
            pollWindows()
            pollCursor()
        }
        startCursorTimer()
        startEnvironmentTimers()
    }

    func appendLifecycle(marker: String) {
        appendEvent(to: lifecycleFile, type: "lifecycle.marker") { _ in
            [
                "marker": marker,
                "segmentId": segmentId,
            ]
        }
    }

    func stop(finalMarker: String) -> [MetadataFileCompletion] {
        stateLock.lock()
        if stopped {
            stateLock.unlock()
            return []
        }
        stopped = true
        let timers = [cursorTimer, windowsTimer, focusTimer, displaysTimer]
        cursorTimer = nil
        windowsTimer = nil
        focusTimer = nil
        displaysTimer = nil
        let runLoop = eventTapRunLoop
        let tap = eventTap
        let waitForEventTapThread = eventTapStarted
        eventTap = nil
        eventTapRunLoop = nil
        stateLock.unlock()

        timers.compactMap { $0 }.forEach { $0.cancel() }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let runLoop { CFRunLoopStop(runLoop) }
        let eventTapThreadStopped = !waitForEventTapThread || eventTapThreadFinished.wait(
            timeout: .now() + .seconds(eventTapThreadShutdownTimeoutSeconds)
        ) == .success
        if !eventTapThreadStopped {
            appendMetadataDiagnostic(
                category: "keyboard",
                reason: "listen-only event tap did not stop within \(eventTapThreadShutdownTimeoutSeconds) seconds; trailing interaction events may have been dropped"
            )
        }
        // Timer cancellation does not drain handlers already submitted to
        // their target queue. All pollers share one serial queue, so this
        // synchronous block first joins prior work and only then captures the
        // final state. Capture.swift calls stop after the media recorders have
        // drained; the closing cursor therefore brackets every retained
        // sample without racing a stale poll.
        pollingQueue.sync {
            pollDisplays(allowWhenStopped: true)
            pollFocus(allowWhenStopped: true)
            pollWindows(allowWhenStopped: true)
            pollCursor(allowWhenStopped: true)
        }
        appendLifecycle(marker: finalMarker)

        let categories: [(String, BoundedEventFile)] = [
            ("cursor", cursorFile),
            ("mouse", inputFile),
            ("window", windowsFile),
            ("display", displaysFile),
            ("lifecycle", focusFile),
            ("lifecycle", lifecycleFile),
        ]
        for (category, file) in categories where file !== lifecycleFile {
            file.flush()
            let drops = file.dropSnapshot()
            guard drops.count > 0 else { continue }
            appendEvent(to: lifecycleFile, type: "diagnostic.dropped-events") { _ in
                [
                    "category": category,
                    "droppedCount": drops.count,
                    "firstDroppedNativeTimeUs": drops.firstNativeTimeUs,
                    "lastDroppedNativeTimeUs": drops.lastNativeTimeUs,
                    "reason": "bounded metadata queue or JSONL line limit",
                ]
            }
        }

        let files = [cursorFile, inputFile, windowsFile, displaysFile, focusFile, lifecycleFile]
        let completions = files.map { $0.completion() }
        return completions
    }

    fileprivate func receiveInput(type: CGEventType, event: CGEvent) {
        stateLock.lock()
        let isStopped = stopped
        stateLock.unlock()
        if isStopped { return }
        switch type {
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp:
            appendClick(type: type, event: event)
        case .keyDown, .keyUp:
            appendKey(type: type, event: event)
        case .tapDisabledByTimeout:
            recoverEventTap(afterDisableReason: "callback timeout")
        case .tapDisabledByUserInput:
            recoverEventTap(afterDisableReason: "user input")
        default:
            break
        }
    }

    private func recoverEventTap(afterDisableReason reason: String) {
        stateLock.lock()
        let tapScope = eventTapScope
        let tap = eventTap
        stateLock.unlock()
        appendMetadataDiagnostic(
            category: "keyboard",
            reason: "\(tapScope) listen-only event tap disabled by \(reason); interaction events may have been dropped"
        )
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
    }

    private func startCursorTimer() {
        let timer = DispatchSource.makeTimerSource(queue: pollingQueue)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(16_666_667), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.pollCursor() }
        stateLock.lock()
        cursorTimer = timer
        stateLock.unlock()
        timer.resume()
    }

    private func startEnvironmentTimers() {
        windowsTimer = makeTimer(label: "windows", interval: .milliseconds(250)) { [weak self] in self?.pollWindows() }
        focusTimer = makeTimer(label: "focus", interval: .milliseconds(100)) { [weak self] in self?.pollFocus() }
        displaysTimer = makeTimer(label: "displays", interval: .seconds(1)) { [weak self] in self?.pollDisplays() }
    }

    private func makeTimer(label: String, interval: DispatchTimeInterval, action: @escaping @Sendable () -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: pollingQueue)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(20))
        timer.setEventHandler(handler: action)
        timer.resume()
        return timer
    }

    private func startPreparedEventTap() throws {
        stateLock.lock()
        guard !stopped, !eventTapStarted, let tap = eventTap else {
            stateLock.unlock()
            return
        }
        eventTapStarted = true
        stateLock.unlock()

        let thread = Thread { [weak self, tap] in
            guard let self else { return }
            defer {
                self.publishEventTapReadiness(operational: false)
                CGEvent.tapEnable(tap: tap, enable: false)
                self.eventTapThreadFinished.signal()
            }
            let runLoop = CFRunLoopGetCurrent()
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            CFRunLoopAddSource(runLoop, source, .commonModes)
            self.stateLock.lock()
            if self.stopped {
                self.stateLock.unlock()
                CFRunLoopRemoveSource(runLoop, source, .commonModes)
                return
            }
            self.eventTapRunLoop = runLoop
            CGEvent.tapEnable(tap: tap, enable: true)
            let tapOperational = CGEvent.tapIsEnabled(tap: tap)
            self.stateLock.unlock()
            self.publishEventTapReadiness(operational: tapOperational)
            guard tapOperational else {
                CFRunLoopRemoveSource(runLoop, source, .commonModes)
                self.stateLock.lock()
                self.eventTapRunLoop = nil
                self.stateLock.unlock()
                return
            }
            while self.isActive {
                _ = CFRunLoopRunInMode(.defaultMode, 0.25, true)
            }
            CFRunLoopRemoveSource(runLoop, source, .commonModes)
            self.stateLock.lock()
            self.eventTapRunLoop = nil
            self.stateLock.unlock()
        }
        thread.name = "atet-capture-input-events"
        thread.qualityOfService = .userInteractive
        thread.start()
        let ready = eventTapThreadReady.wait(
            timeout: .now() + .seconds(2)
        ) == .success
        stateLock.lock()
        let operational = eventTapOperational
        let tapScope = eventTapScope
        stateLock.unlock()
        guard ready, operational else {
            let reason = "\(tapScope) listen-only event tap did not become ready before capture"
            if options.strictSources {
                throw HelperFailure(
                    code: "metadata-event-tap-start-failed",
                    message: "Strict capture could not activate the \(tapScope) listen-only event tap before media startup.",
                    recoverable: true
                )
            }
            appendMetadataDiagnostic(category: "keyboard", reason: reason)
            return
        }
    }

    private func publishEventTapReadiness(operational: Bool) {
        stateLock.lock()
        guard !eventTapReadySignaled else {
            stateLock.unlock()
            return
        }
        eventTapReadySignaled = true
        eventTapOperational = operational
        stateLock.unlock()
        eventTapThreadReady.signal()
    }

    private func pollCursor(allowWhenStopped: Bool = false) {
        guard allowWhenStopped || isActive else { return }
        guard let event = CGEvent(source: nil) else { return }
        let location = globalLocation(for: event.location)
        guard let display = location.display else { return }
        appendEvent(to: cursorFile, type: "cursor.sample") { _ in
            [
                "displayId": display.identifier,
                "position": pointJSON(location.global),
                "visible": true,
            ]
        }
    }

    private func appendClick(type: CGEventType, event: CGEvent) {
        let location = globalLocation(for: event.location)
        guard let display = location.display else { return }
        let button: String
        switch type {
        case .leftMouseDown, .leftMouseUp: button = "left"
        case .rightMouseDown, .rightMouseUp: button = "right"
        default:
            let value = event.getIntegerValueField(.mouseEventButtonNumber)
            button = value == 2 ? "middle" : "other"
        }
        let phase = [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) ? "down" : "up"
        appendEvent(to: inputFile, type: "mouse.click") { _ in
            [
                "button": button,
                "clickCount": max(1, min(16, event.getIntegerValueField(.mouseEventClickState))),
                "displayId": display.identifier,
                "phase": phase,
                "position": pointJSON(location.global),
            ]
        }
    }

    private func appendKey(type: CGEventType, event: CGEvent) {
        let focus = readFocusSnapshot()
        let modifiers = modifierNames(event.flags)
        let phase = type == .keyUp ? "up" : "down"
        let repeatValue = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        // A redacted event per keystroke still reveals password length and cadence.
        guard !focus.secure else { return }
        let activity: [String: Any]
        if let control = controlKeyName(keyCode) {
            activity = [
                "kind": "control",
                "control": control,
                "modifiers": modifiers,
                "phase": phase,
                "repeat": repeatValue,
            ]
        } else if modifiers.contains(where: { $0 == "command" || $0 == "control" || $0 == "option" || $0 == "function" }) {
            activity = [
                "kind": "shortcut",
                "keyCode": "keycode-\(keyCode)",
                "modifiers": modifiers,
                "phase": phase,
                "repeat": repeatValue,
            ]
        } else {
            activity = [
                "kind": "printable",
                "modifiers": modifiers,
                "phase": phase,
                "repeat": repeatValue,
                "token": "[PRINTABLE]",
            ]
        }
        appendEvent(to: inputFile, type: "key.activity") { _ in
            ["activity": activity]
        }

        guard options.typedText, type == .keyDown, focus.allowsTypedText,
              let bounds = focus.bounds, let fieldId = focus.fieldId,
              let processId = focus.processId, let windowId = focus.windowId else { return }
        if let allowedFocusIdentities = options.typedTextFocusIdentities {
            guard let windowTitle = focus.windowTitle,
                  allowedFocusIdentities.contains(TypedTextFocusIdentity(
                    fieldId: fieldId,
                    processId: processId,
                    windowId: windowId,
                    windowTitle: windowTitle
                  )) else {
                return
            }
        }
        // Key activity retains shortcut evidence above, but a keystroke is not
        // a truthful field mutation when a non-text modifier is held. In
        // particular, Command-V inserts clipboard contents rather than "v",
        // and modified delete keys remove more than one scalar. Suppress the
        // derived callout instead of persisting a plausible but false edit.
        guard !hasNonTextEditingModifier(event.flags) else { return }
        let action: String
        let text: String
        if keyCode == 51 {
            action = "delete-backward"
            text = ""
        } else if keyCode == 117 {
            action = "delete-forward"
            text = ""
        } else {
            guard let printable = printableText(event), !printable.isEmpty else { return }
            action = "insert"
            text = printable
        }
        appendEvent(to: inputFile, type: "typing.input") { _ in
            [
                "input": [
                    "action": action,
                    "bounds": rectJSON(globalRect(bounds)),
                    "fieldId": bounded(fieldId, maximumUTF8Bytes: 512),
                    "secure": false,
                    "text": bounded(text, maximumUTF8Bytes: 4_096),
                    "windowId": bounded(windowId, maximumUTF8Bytes: 256),
                ],
            ]
        }
    }

    private func pollFocus(allowWhenStopped: Bool = false) {
        guard allowWhenStopped || isActive else { return }
        let focus = readFocusSnapshot()
        stateLock.lock()
        guard focus.signature != lastFocusSignature else {
            stateLock.unlock()
            return
        }
        lastFocusSignature = focus.signature
        stateLock.unlock()
        appendEvent(to: focusFile, type: "focus.changed") { _ in
            ["target": focus.target]
        }
    }

    private func pollDisplays(allowWhenStopped: Bool = false) {
        guard allowWhenStopped || isActive else { return }
        let displays = currentDisplayTopology()
        guard !displays.isEmpty else { return }
        let json = displays.map(\.topologyJSON)
        let signature = (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])) ?? Data()
        stateLock.lock()
        guard signature != lastTopologySignature else {
            stateLock.unlock()
            return
        }
        lastTopologySignature = signature
        stateLock.unlock()
        appendEvent(to: displaysFile, type: "display.topology") { _ in
            ["displays": json]
        }
    }

    private func pollWindows(allowWhenStopped: Bool = false) {
        guard allowWhenStopped || isActive else { return }
        let records = readWindowRecords()
        let newById = Dictionary(uniqueKeysWithValues: records.map { ($0.identifier, $0) })
        stateLock.lock()
        let oldById = lastWindowRecords
        if !hasWindowSnapshot {
            hasWindowSnapshot = true
            lastWindowRecords = newById
            stateLock.unlock()
            appendEvent(to: windowsFile, type: "window.snapshot") { _ in
                ["windows": records.map(\.json)]
            }
            return
        }
        lastWindowRecords = newById
        stateLock.unlock()

        var changes: [[String: Any]] = []
        for record in records {
            if let prior = oldById[record.identifier] {
                if !prior.isFocused && record.isFocused {
                    changes.append(["kind": "focused", "window": record.json])
                } else if prior.signature != record.signature {
                    changes.append(["kind": "updated", "window": record.json])
                }
            } else if record.isFocused {
                changes.append(["kind": "focused", "window": record.json])
            } else {
                changes.append(["kind": "created", "window": record.json])
            }
        }
        for identifier in oldById.keys where newById[identifier] == nil {
            changes.append(["kind": "destroyed", "windowId": identifier])
        }
        for change in changes.prefix(256) {
            appendEvent(to: windowsFile, type: "window.changed") { _ in
                ["change": change]
            }
        }
    }

    @discardableResult
    private func appendEvent(
        to file: BoundedEventFile,
        type: String,
        fields: (TimelineStamp) -> [String: Any]
    ) -> Bool {
        eventEmissionLock.lock()
        defer { eventEmissionLock.unlock() }
        let stamp = clock.sample()
        let eventSequence = sequence
        sequence &+= 1
        let event = [
            "type": type,
            "sequence": eventSequence,
            "nativeTimeUs": stamp.nativeTimeUs,
            "sourceTimeUs": stamp.sourceTimeUs,
        ].merging(fields(stamp)) { _, new in new }
        return file.append(event, nativeTimeUs: stamp.nativeTimeUs)
    }

    private var isActive: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return !stopped
    }

    private func appendMetadataDiagnostic(category: String, reason: String) {
        appendEvent(to: lifecycleFile, type: "diagnostic.dropped-events") { stamp in
            [
                "category": category,
                "droppedCount": 1,
                "firstDroppedNativeTimeUs": stamp.nativeTimeUs,
                "lastDroppedNativeTimeUs": stamp.nativeTimeUs,
                "reason": reason,
            ]
        }
    }
}

private func globalLocation(for point: CGPoint) -> (global: CGPoint, local: CGPoint, display: DisplayGeometry?) {
    let displays = currentDisplayTopology()
    guard !displays.isEmpty else { return (point, point, nil) }
    let display = displays.first { $0.bounds.contains(point) }
    guard let display else { return (point, point, nil) }
    let local = CGPoint(x: point.x - display.bounds.minX, y: point.y - display.bounds.minY)
    return (point, local, display)
}

private func globalRect(_ rect: CGRect) -> CGRect {
    rect
}

private func pointJSON(_ point: CGPoint) -> [String: Any] {
    ["x": point.x, "y": point.y]
}

private func rectJSON(_ rect: CGRect) -> [String: Any] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}

private func readFocusSnapshot() -> FocusSnapshot {
    let frontmostApplication = NSWorkspace.shared.frontmostApplication
    let frontmost: [String: Any] = [
        "bundleIdentifier": bounded(frontmostApplication?.bundleIdentifier ?? "unknown", maximumUTF8Bytes: 512),
        "name": bounded(frontmostApplication?.localizedName ?? "Unknown application", maximumUTF8Bytes: 512),
        "processId": Int(frontmostApplication?.processIdentifier ?? 0),
    ]
    guard AXIsProcessTrusted() else {
        return FocusSnapshot(
            signature: "permission:\(frontmost)",
            target: ["kind": "none"],
            frontmost: frontmost,
            secure: true,
            allowsTypedText: false,
            bounds: nil,
            fieldId: nil,
            processId: nil,
            windowId: nil,
            windowTitle: nil
        )
    }
    let system = AXUIElementCreateSystemWide()
    guard let focused = axAttribute(system, kAXFocusedUIElementAttribute as String) else {
        return FocusSnapshot(
            signature: "none:\(frontmost)",
            target: ["kind": "none"],
            frontmost: frontmost,
            secure: true,
            allowsTypedText: false,
            bounds: nil,
            fieldId: nil,
            processId: nil,
            windowId: nil,
            windowTitle: nil
        )
    }
    let element = focused as! AXUIElement
    let role = (axAttribute(element, kAXRoleAttribute as String) as? String) ?? "unknown"
    let subrole = (axAttribute(element, kAXSubroleAttribute as String) as? String) ?? ""
    let secure = subrole == (kAXSecureTextFieldSubrole as String) || role.localizedCaseInsensitiveContains("secure")
    let position = axPoint(axAttribute(element, kAXPositionAttribute as String))
    let size = axSize(axAttribute(element, kAXSizeAttribute as String))
    let bounds = position.flatMap { position in size.map { CGRect(origin: position, size: $0) } }
    let inputRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
    ]
    let allowsTypedText = inputRoles.contains(role) && !secure && bounds != nil
    let rawFieldId = (axAttribute(element, kAXIdentifierAttribute as String) as? String) ?? role
    var focusedProcessId: pid_t = 0
    let processId: pid_t? = (
        AXUIElementGetPid(element, &focusedProcessId) == .success
        && focusedProcessId > 0
    ) ? focusedProcessId : nil
    let windowIdentity = bounds.flatMap { bounds in
        processId.flatMap { processId in
            findWindowIdentity(
                processId: processId,
                containing: CGPoint(x: bounds.midX, y: bounds.midY)
            )
        }
    }
    let windowId = windowIdentity?.identifier
        ?? processId.map { "pid-\($0)" }
        ?? "unresolved"
    var target: [String: Any]
    if secure, let bounds {
        target = [
            "kind": "secure-input",
            "bounds": rectJSON(globalRect(bounds)),
            "fieldId": "[REDACTED]",
            "redacted": true,
            "role": "secure-text-field",
            "windowId": windowId,
        ]
    } else if allowsTypedText, let bounds {
        target = [
            "kind": "public-input",
            "bounds": rectJSON(globalRect(bounds)),
            "fieldId": bounded(rawFieldId, maximumUTF8Bytes: 512),
            "role": bounded(role, maximumUTF8Bytes: 128),
            "windowId": windowId,
        ]
    } else {
        target = ["kind": "none"]
    }
    if let processId, target["kind"] as? String != "none" {
        target["processId"] = Int(processId)
    }
    let signature = "\(target)|\(frontmost)"
    return FocusSnapshot(
        signature: signature,
        target: target,
        frontmost: frontmost,
        secure: secure,
        allowsTypedText: allowsTypedText,
        bounds: bounds,
        fieldId: secure ? nil : rawFieldId,
        processId: processId,
        windowId: windowId,
        windowTitle: windowIdentity?.title
    )
}

private func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

private func axPoint(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

private func axSize(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size), size.width > 0, size.height > 0 else { return nil }
    return size
}

private func findWindowIdentity(processId: pid_t, containing point: CGPoint) -> FocusWindowIdentity? {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for window in windows {
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processId,
              let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let identifier = window[kCGWindowNumber as String] as? NSNumber else { continue }
        var bounds = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(boundsDictionary, &bounds), bounds.contains(point) else { continue }
        let title: String? = (window[kCGWindowName as String] as? String).flatMap { value in
            guard !value.isEmpty,
                  value.utf8.count <= 256,
                  !value.contains("\0") else {
                return nil
            }
            return value
        }
        return FocusWindowIdentity(identifier: identifier.stringValue, title: title)
    }
    return nil
}

private func focusedWindowIdentifier(
    processId: pid_t,
    windows: [[String: Any]]
) -> String? {
    guard AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(processId)
    guard let rawWindow = axAttribute(
        application,
        kAXFocusedWindowAttribute as String
    ), CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else {
        return nil
    }
    let focusedWindow = rawWindow as! AXUIElement
    let position = axPoint(
        axAttribute(focusedWindow, kAXPositionAttribute as String)
    )
    let size = axSize(
        axAttribute(focusedWindow, kAXSizeAttribute as String)
    )
    guard let position, let size else { return nil }
    let focusedBounds = CGRect(origin: position, size: size)
    let focusedTitle = axAttribute(
        focusedWindow,
        kAXTitleAttribute as String
    ) as? String
    var boundsMatch: String?
    for window in windows {
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
                == processId,
              let boundsDictionary =
                window[kCGWindowBounds as String] as? NSDictionary,
              let identifier =
                window[kCGWindowNumber as String] as? NSNumber else {
            continue
        }
        var candidateBounds = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(
            boundsDictionary,
            &candidateBounds
        ) else {
            continue
        }
        let maximumDelta = max(
            abs(candidateBounds.minX - focusedBounds.minX),
            abs(candidateBounds.minY - focusedBounds.minY),
            abs(candidateBounds.width - focusedBounds.width),
            abs(candidateBounds.height - focusedBounds.height)
        )
        guard maximumDelta <= 2 else { continue }
        let candidateIdentifier = identifier.stringValue
        if let focusedTitle, !focusedTitle.isEmpty,
           window[kCGWindowName as String] as? String == focusedTitle {
            return candidateIdentifier
        }
        if boundsMatch == nil { boundsMatch = candidateIdentifier }
    }
    return boundsMatch
}

private func readWindowRecords() -> [WindowRecord] {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let focusedWindowId = frontPid.flatMap {
        focusedWindowIdentifier(processId: $0, windows: windows)
    }
    let displays = currentDisplayTopology()
    var output: [WindowRecord] = []
    output.reserveCapacity(min(maximumWindowRecords, windows.count))
    for window in windows.prefix(maximumWindowRecords) {
        guard let number = window[kCGWindowNumber as String] as? NSNumber,
              let ownerPid = window[kCGWindowOwnerPID as String] as? NSNumber,
              let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary else { continue }
        var bounds = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(boundsDictionary, &bounds), bounds.width > 0, bounds.height > 0 else { continue }
        let identifier = number.stringValue
        let pid = ownerPid.int32Value
        let application = NSRunningApplication(processIdentifier: pid)
        let applicationName = bounded(
            (window[kCGWindowOwnerName as String] as? String) ?? application?.localizedName ?? "Unknown application",
            maximumUTF8Bytes: 512
        )
        let bundleIdentifier = bounded(application?.bundleIdentifier ?? "unknown", maximumUTF8Bytes: 512)
        let titleValue = (window[kCGWindowName as String] as? String).map { bounded($0, maximumUTF8Bytes: 2_048) }
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let display = displays.first { $0.bounds.contains(center) }
        let isFocused = focusedWindowId == identifier
        let title: [String: Any] = titleValue.map { ["state": "available", "value": $0] }
            ?? ["state": "redacted", "reason": CGPreflightScreenCaptureAccess() ? "unavailable" : "permission"]
        let json: [String: Any] = [
            "windowId": identifier,
            "applicationBundleId": bundleIdentifier,
            "applicationName": applicationName,
            "bounds": rectJSON(globalRect(bounds)),
            "displayId": display?.identifier ?? "unknown",
            "isFocused": isFocused,
            "layer": (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
            "title": title,
        ]
        let signature = (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])) ?? Data()
        output.append(WindowRecord(identifier: identifier, isFocused: isFocused, json: json, signature: signature))
    }
    return output
}

private func modifierNames(_ flags: CGEventFlags) -> [String] {
    var output: [String] = []
    if flags.contains(.maskCommand) { output.append("command") }
    if flags.contains(.maskControl) { output.append("control") }
    if flags.contains(.maskAlternate) { output.append("option") }
    if flags.contains(.maskShift) { output.append("shift") }
    if flags.contains(.maskAlphaShift) { output.append("caps-lock") }
    if flags.contains(.maskSecondaryFn) { output.append("function") }
    return output
}

private func hasNonTextEditingModifier(_ flags: CGEventFlags) -> Bool {
    flags.contains(.maskCommand)
        || flags.contains(.maskControl)
        || flags.contains(.maskAlternate)
        || flags.contains(.maskSecondaryFn)
}

private func controlKeyName(_ code: Int64) -> String? {
    switch code {
    case 36: return "enter"
    case 48: return "tab"
    case 51, 117: return "delete"
    case 53: return "escape"
    case 123: return "arrow-left"
    case 124: return "arrow-right"
    case 125: return "arrow-down"
    case 126: return "arrow-up"
    default: return nil
    }
}

private func printableText(_ event: CGEvent) -> String? {
    var actualLength = 0
    var buffer = [UniChar](repeating: 0, count: 64)
    event.keyboardGetUnicodeString(maxStringLength: buffer.count, actualStringLength: &actualLength, unicodeString: &buffer)
    guard actualLength > 0 else { return nil }
    let text = String(utf16CodeUnits: buffer, count: min(actualLength, buffer.count))
    guard text.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return nil }
    return bounded(text, maximumUTF8Bytes: 256)
}
