import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

private let interactionFixtureProtocolVersion = 1
private let interactionFixturePublicFieldIdPrefix = "atet-fixture-public-"
private let interactionFixtureSecureFieldId = "atet-fixture-secure"
private let interactionFixtureNeutralTargetId = "atet-fixture-neutral"
private let maximumInteractionFixtureCommands = 8
private let fixtureFocusTimeoutSeconds = 3.0
private let fixtureValueTimeoutSeconds = 2.0
private let fixtureMetadataObservationSeconds = 0.45

enum InteractionFixture {
    static func canonicalIdentifier(_ value: String) -> String? {
        guard value.utf8.count == 36,
              value == value.lowercased(),
              let parsed = UUID(uuidString: value),
              parsed.uuidString.lowercased() == value else {
            return nil
        }
        return value
    }

    @MainActor
    static func run(fixtureId: String) -> Int32 {
        let runtime = InteractionFixtureRuntime(fixtureId: fixtureId)
        return runtime.run()
    }
}

private enum FixtureCommand: String {
    case exercise
    case shutdown
}

private struct FixtureRequest {
    let command: FixtureCommand
    let requestId: String
}

private struct FixtureFailure: LocalizedError {
    let code: String
    let message: String

    var errorDescription: String? { message }
}

private enum FixtureRequestParser {
    static func parse(line: String, expectedFixtureId: String) throws -> FixtureRequest {
        guard let data = line.data(using: .utf8), !data.isEmpty else {
            throw FixtureFailure(code: "invalid-request", message: "Fixture request must be nonempty UTF-8.")
        }
        guard data.count <= maximumProtocolLineBytes else {
            throw FixtureFailure(code: "request-too-large", message: "Fixture request exceeds the protocol line limit.")
        }
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw FixtureFailure(code: "invalid-json", message: "Fixture request is not valid JSON.")
        }
        guard let object = value as? [String: Any],
              Set(object.keys) == ["command", "fixtureId", "fixtureProtocolVersion", "requestId"] else {
            throw FixtureFailure(code: "invalid-request", message: "Fixture request must contain exactly the documented fields.")
        }
        guard fixtureInteger(object["fixtureProtocolVersion"]) == interactionFixtureProtocolVersion else {
            throw FixtureFailure(code: "unsupported-protocol", message: "Fixture protocol version must be 1.")
        }
        guard let fixtureId = object["fixtureId"] as? String,
              fixtureId == expectedFixtureId,
              InteractionFixture.canonicalIdentifier(fixtureId) != nil else {
            throw FixtureFailure(code: "fixture-identity-mismatch", message: "Fixture request identity does not match this process.")
        }
        guard let commandValue = object["command"] as? String,
              let command = FixtureCommand(rawValue: commandValue),
              let requestId = object["requestId"] as? String,
              requestId == command.rawValue else {
            throw FixtureFailure(code: "invalid-command", message: "Fixture command and requestId must be the exact supported pair.")
        }
        return FixtureRequest(command: command, requestId: requestId)
    }

    private static func fixtureInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.rounded() == number.doubleValue else {
            return nil
        }
        return number.intValue
    }
}

private enum FixtureInputRecord {
    case line(String)
    case oversized
    case invalidUTF8
    case readFailure
    case endOfFile
}

private final class FixtureLineReader {
    private var buffer = Data()
    private var discardingOversizedLine = false

    func next() -> FixtureInputRecord {
        while true {
            if let newline = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[..<newline]
                buffer.removeSubrange(...newline)
                if discardingOversizedLine {
                    discardingOversizedLine = false
                    return .oversized
                }
                let trimmed = lineData.last == 0x0D ? lineData.dropLast() : lineData[...]
                guard let line = String(data: trimmed, encoding: .utf8) else { return .invalidUTF8 }
                return .line(line)
            }
            var bytes = [UInt8](repeating: 0, count: 4_096)
            let byteCount = bytes.withUnsafeMutableBytes { storage in
                var result: Int
                repeat {
                    result = Darwin.read(STDIN_FILENO, storage.baseAddress, storage.count)
                } while result < 0 && errno == EINTR
                return result
            }
            if byteCount < 0 { return .readFailure }
            if byteCount == 0 {
                if discardingOversizedLine {
                    discardingOversizedLine = false
                    buffer.removeAll(keepingCapacity: false)
                    return .oversized
                }
                guard !buffer.isEmpty else { return .endOfFile }
                let final = buffer
                buffer.removeAll(keepingCapacity: false)
                guard let line = String(data: final, encoding: .utf8) else { return .invalidUTF8 }
                return .line(line)
            }
            let chunk = Data(bytes.prefix(byteCount))
            if discardingOversizedLine {
                if let newline = chunk.firstIndex(of: 0x0A) {
                    buffer = Data(chunk[chunk.index(after: newline)...])
                    discardingOversizedLine = false
                    return .oversized
                }
                continue
            }
            buffer.append(chunk)
            if buffer.count > maximumProtocolLineBytes {
                if let newline = buffer.firstIndex(of: 0x0A) {
                    buffer.removeSubrange(...newline)
                    return .oversized
                }
                buffer.removeAll(keepingCapacity: true)
                discardingOversizedLine = true
            }
        }
    }
}

private final class FixtureEmitter: @unchecked Sendable {
    private let fixtureId: String
    private let lock = NSLock()

    init(fixtureId: String) {
        self.fixtureId = fixtureId
    }

    @discardableResult
    func emit(_ value: [String: Any]) -> Bool {
        var event = value
        event["fixtureId"] = fixtureId
        event["fixtureProtocolVersion"] = interactionFixtureProtocolVersion
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]),
              data.count + 1 <= maximumProtocolLineBytes else {
            diagnostic("could not encode a bounded fixture protocol event")
            return false
        }
        lock.lock()
        defer { lock.unlock() }
        do {
            try FileHandle.standardOutput.write(contentsOf: data)
            try FileHandle.standardOutput.write(contentsOf: Data([0x0A]))
            return true
        } catch {
            diagnostic("fixture stdout write failed")
            return false
        }
    }

    func error(requestId: String?, code: String, message: String) {
        emit([
            "event": "error",
            "requestId": requestId as Any? ?? NSNull(),
            "code": bounded(code, maximumUTF8Bytes: 128),
            "message": bounded(message, maximumUTF8Bytes: 2_048),
        ])
    }

    func diagnostic(_ message: String) {
        let line = "atet-capture fixture: \(bounded(message, maximumUTF8Bytes: 8_192))\n"
        try? FileHandle.standardError.write(contentsOf: Data(line.utf8))
    }
}

private enum FixtureFocusTarget {
    case publicField
    case secureField
    case neutral
}

private struct FixtureFocusEvidence {
    let bounds: CGRect?
}

private struct FixturePhaseReceipt {
    let focusConfirmedNativeTimeUs: UInt64
    let inputStartedNativeTimeUs: UInt64
    let completedNativeTimeUs: UInt64
    let bounds: CGRect
    let clickPoint: CGPoint

    var json: [String: Any] {
        [
            "focusConfirmedNativeTimeUs": focusConfirmedNativeTimeUs,
            "inputStartedNativeTimeUs": inputStartedNativeTimeUs,
            "completedNativeTimeUs": completedNativeTimeUs,
            "bounds": fixtureRectJSON(bounds),
            "clickPoint": fixturePointJSON(clickPoint),
            "attemptedKeyPairs": 1,
            "valueMatches": true,
        ]
    }
}

@MainActor
private final class InteractionFixtureRuntime {
    private let fixtureId: String
    private let emitter: FixtureEmitter
    private let application = NSApplication.shared
    private let publicFieldId: String
    private let windowTitle: String
    private var window: NSWindow?
    private var publicField: NSTextField?
    private var secureField: NSTextField?
    private var neutralTarget: NSButton?
    private var exercised = false
    private var shuttingDown = false
    private var exitCode: Int32 = 0
    private var terminationSource: DispatchSourceSignal?
    private var interruptSource: DispatchSourceSignal?

    init(fixtureId: String) {
        self.fixtureId = fixtureId
        emitter = FixtureEmitter(fixtureId: fixtureId)
        publicFieldId = "\(interactionFixturePublicFieldIdPrefix)\(fixtureId)"
        windowTitle = "Atet Interaction Fixture · \(fixtureId)"
    }

    func run() -> Int32 {
        guard AXIsProcessTrusted() else {
            emitter.error(
                requestId: nil,
                code: "accessibility-not-authorized",
                message: "Accessibility must already be authorized for the interaction fixture."
            )
            return 77
        }
        guard CGPreflightPostEventAccess() else {
            emitter.error(
                requestId: nil,
                code: "event-posting-not-authorized",
                message: "Synthetic input posting must already be authorized for the interaction fixture."
            )
            return 77
        }
        configureApplication()
        installSignalHandlers()
        startInputReader()
        guard let window, window.windowNumber > 0 else {
            emitter.error(
                requestId: nil,
                code: "window-identity-unavailable",
                message: "Fixture could not establish its window identity before capture."
            )
            cleanUpWindow()
            return 78
        }
        emitter.emit([
            "event": "ready",
            "nativeTimeUs": monotonicMicroseconds(),
            "publicFocusIdentity": publicFocusIdentityJSON(window: window),
        ])
        application.run()
        cleanUpWindow()
        terminationSource?.cancel()
        interruptSource?.cancel()
        return exitCode
    }

    private func configureApplication() {
        application.setActivationPolicy(.regular)
        application.finishLaunching()

        let contentRect = CGRect(x: 0, y: 0, width: 560, height: 220)
        let fixtureWindow = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        fixtureWindow.title = windowTitle
        fixtureWindow.hidesOnDeactivate = false
        fixtureWindow.isReleasedWhenClosed = false
        fixtureWindow.collectionBehavior = [.moveToActiveSpace]
        fixtureWindow.level = .screenSaver

        let content = NSView(frame: contentRect)
        let publicInput = NSTextField(frame: CGRect(x: 80, y: 132, width: 400, height: 32))
        publicInput.placeholderString = "Public interaction fixture"
        publicInput.setAccessibilityIdentifier(publicFieldId)
        publicInput.stringValue = ""

        // Atet must prove its own AX-secure redaction rather than depending
        // on macOS Secure Event Input, which disables the event tap under
        // test. This ordinary field advertises the exact secure AX subrole,
        // accepts only the fixed "s" canary, renders it invisibly, and is
        // cleared before and after the phase.
        let secureInput = NSTextField(frame: CGRect(x: 80, y: 82, width: 400, height: 32))
        secureInput.placeholderString = "Secure interaction fixture"
        secureInput.setAccessibilityIdentifier(interactionFixtureSecureFieldId)
        secureInput.setAccessibilitySubrole(.secureTextField)
        secureInput.textColor = .clear
        secureInput.stringValue = ""

        let neutral = NSButton(frame: CGRect(x: 190, y: 24, width: 180, height: 32))
        neutral.title = "Fixture complete"
        neutral.bezelStyle = .rounded
        neutral.setAccessibilityIdentifier(interactionFixtureNeutralTargetId)

        content.addSubview(publicInput)
        content.addSubview(secureInput)
        content.addSubview(neutral)
        fixtureWindow.contentView = content
        fixtureWindow.center()
        fixtureWindow.orderOut(nil)

        window = fixtureWindow
        publicField = publicInput
        secureField = secureInput
        neutralTarget = neutral
    }

    private func installSignalHandlers() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        termination.setEventHandler { [weak self] in
            self?.shutdown(requestId: "shutdown", emitEvent: true)
        }
        interrupt.setEventHandler { [weak self] in
            self?.shutdown(requestId: "shutdown", emitEvent: true)
        }
        termination.resume()
        interrupt.resume()
        terminationSource = termination
        interruptSource = interrupt
    }

    private func startInputReader() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let reader = FixtureLineReader()
            for commandIndex in 0...maximumInteractionFixtureCommands {
                let record = reader.next()
                let shouldStop = DispatchQueue.main.sync {
                    self.handleInput(record, commandLimitExceeded: commandIndex == maximumInteractionFixtureCommands)
                }
                if shouldStop { return }
            }
        }
    }

    private func handleInput(_ record: FixtureInputRecord, commandLimitExceeded: Bool) -> Bool {
        guard !shuttingDown else { return true }
        if commandLimitExceeded {
            emitter.error(requestId: nil, code: "request-limit", message: "Fixture command limit exceeded.")
            shutdown(requestId: "shutdown", emitEvent: true)
            return true
        }
        switch record {
        case .line(let line):
            do {
                let request = try FixtureRequestParser.parse(line: line, expectedFixtureId: fixtureId)
                switch request.command {
                case .exercise:
                    handleExercise(requestId: request.requestId)
                    return false
                case .shutdown:
                    shutdown(requestId: request.requestId, emitEvent: true)
                    return true
                }
            } catch let failure as FixtureFailure {
                emitter.error(requestId: fixtureRequestId(from: line), code: failure.code, message: failure.message)
            } catch {
                emitter.error(requestId: nil, code: "invalid-request", message: "Fixture request could not be parsed.")
            }
            return false
        case .oversized:
            emitter.error(requestId: nil, code: "request-too-large", message: "Fixture request exceeds the protocol line limit.")
            return false
        case .invalidUTF8:
            emitter.error(requestId: nil, code: "invalid-utf8", message: "Fixture request is not valid UTF-8.")
            return false
        case .readFailure:
            emitter.error(requestId: nil, code: "input-read-failed", message: "Fixture protocol input failed.")
            shutdown(requestId: "shutdown", emitEvent: true)
            return true
        case .endOfFile:
            shutdown(requestId: "shutdown", emitEvent: true)
            return true
        }
    }

    private func handleExercise(requestId: String) {
        guard !exercised else {
            emitter.error(requestId: requestId, code: "already-exercised", message: "Fixture can be exercised exactly once.")
            return
        }
        exercised = true
        do {
            let receipt = try exercise()
            if !shuttingDown { emitter.emit(receipt) }
        } catch let failure as FixtureFailure {
            clearInputs()
            if !shuttingDown {
                emitter.error(requestId: requestId, code: failure.code, message: failure.message)
            }
        } catch {
            clearInputs()
            if !shuttingDown {
                emitter.error(requestId: requestId, code: "exercise-failed", message: "Fixture exercise failed closed.")
            }
        }
    }

    private func exercise() throws -> [String: Any] {
        guard let window, let publicField, let secureField, let neutralTarget else {
            throw FixtureFailure(code: "fixture-unavailable", message: "Fixture controls are unavailable.")
        }
        clearInputs()

        let publicBefore = try exercisePhase(
            phaseLabel: "public-before",
            target: .publicField,
            control: publicField,
            fixedCharacter: "a",
            fixedKeyCode: 0
        )
        secureField.stringValue = ""
        let secure = try exercisePhase(
            phaseLabel: "secure",
            target: .secureField,
            control: secureField,
            fixedCharacter: "s",
            fixedKeyCode: 1
        )
        publicField.stringValue = ""
        let publicAfter = try exercisePhase(
            phaseLabel: "public-after",
            target: .publicField,
            control: publicField,
            fixedCharacter: "b",
            fixedKeyCode: 11
        )

        clearInputs()
        guard window.makeFirstResponder(neutralTarget) else {
            throw FixtureFailure(code: "neutral-focus-failed", message: "Fixture could not move focus to its neutral target.")
        }
        _ = try waitForFocus(.neutral)
        let neutralFocusConfirmedNativeTimeUs = monotonicMicroseconds()
        waitForMetadataObservation()
        _ = try requireFocus(.neutral)
        guard publicField.stringValue.isEmpty, secureField.stringValue.isEmpty else {
            throw FixtureFailure(code: "input-clear-failed", message: "Fixture controls did not clear.")
        }
        let completedNativeTimeUs = strictlyLaterMicroseconds(than: neutralFocusConfirmedNativeTimeUs)
        guard window.windowNumber > 0 else {
            throw FixtureFailure(code: "window-identity-unavailable", message: "Fixture window identity is unavailable.")
        }

        return [
            "event": "completed",
            "requestId": "exercise",
            "publicFocusIdentity": publicFocusIdentityJSON(window: window),
            "completedNativeTimeUs": completedNativeTimeUs,
            "neutralFocusConfirmedNativeTimeUs": neutralFocusConfirmedNativeTimeUs,
            "publicBefore": publicBefore.json,
            "secure": secure.json,
            "publicAfter": publicAfter.json,
        ]
    }

    private func activate(window: NSWindow) throws {
        _ = NSRunningApplication.current.activate(options: [.activateAllWindows])
        application.activate()
        // A command-line AppKit process has no cooperative foreground owner to
        // yield activation. This API remains available on the macOS 15 target
        // and is followed by fail-closed PID/key-window verification.
        application.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        window.makeKey()
        let deadline = Date().addingTimeInterval(fixtureFocusTimeoutSeconds)
        repeat {
            if application.isActive,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
               !window.isKeyWindow {
                window.makeKey()
            }
            if application.isActive,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
               window.isKeyWindow {
                return
            }
            waitOnMainRunLoop(seconds: 0.025)
        } while Date() < deadline
        emitter.diagnostic(
            "activation failed (appActive=\(application.isActive), keyWindow=\(window.isKeyWindow), canBecomeKey=\(window.canBecomeKey), visible=\(window.isVisible), policy=\(application.activationPolicy().rawValue), frontmostOwnPid=\(NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()))"
        )
        throw FixtureFailure(code: "fixture-not-frontmost", message: "Fixture refused input because its process is not frontmost and key.")
    }

    private func exercisePhase(
        phaseLabel: String,
        target: FixtureFocusTarget,
        control: NSTextField,
        fixedCharacter: String,
        fixedKeyCode: CGKeyCode
    ) throws -> FixturePhaseReceipt {
        guard let window else {
            throw FixtureFailure(code: "fixture-unavailable", message: "Fixture window is unavailable.")
        }
        try activate(window: window)
        guard window.makeFirstResponder(control) else {
            throw FixtureFailure(code: "focus-failed", message: "Fixture could not focus its owned input.")
        }
        try configureCurrentEditor(target: target, control: control)
        let evidence = try waitForFocus(target)
        guard let bounds = evidence.bounds else {
            throw FixtureFailure(code: "focus-bounds-unavailable", message: "Fixture input bounds are unavailable.")
        }
        let focusConfirmedNativeTimeUs = monotonicMicroseconds()
        let clickPoint = CGPoint(x: bounds.midX, y: bounds.midY)
        waitForMetadataObservation()
        try validatePostingTarget(target, clickPoint: clickPoint)

        let inputStartedNativeTimeUs = strictlyLaterMicroseconds(than: focusConfirmedNativeTimeUs)
        try postMousePair(target: target, clickPoint: clickPoint)
        waitOnMainRunLoop(seconds: 0.05)
        try configureCurrentEditor(target: target, control: control)
        _ = try requireFocus(target)
        try postKeyPair(
            target: target,
            clickPoint: clickPoint,
            keyCode: fixedKeyCode,
            character: fixedCharacter
        )
        guard waitForValue(control, expected: fixedCharacter) else {
            throw FixtureFailure(
                code: "input-not-received",
                message: "Fixture \(phaseLabel) control did not receive its fixed input."
            )
        }
        waitForMetadataObservation()
        try validatePostingTarget(target, clickPoint: clickPoint)
        let completedNativeTimeUs = strictlyLaterMicroseconds(than: inputStartedNativeTimeUs)
        return FixturePhaseReceipt(
            focusConfirmedNativeTimeUs: focusConfirmedNativeTimeUs,
            inputStartedNativeTimeUs: inputStartedNativeTimeUs,
            completedNativeTimeUs: completedNativeTimeUs,
            bounds: bounds,
            clickPoint: clickPoint
        )
    }

    private func postMousePair(target: FixtureFocusTarget, clickPoint: CGPoint) throws {
        try validatePostingTarget(target, clickPoint: clickPoint)
        guard let down = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: clickPoint,
            mouseButton: .left
        ), let up = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: clickPoint,
            mouseButton: .left
        ) else {
            throw FixtureFailure(code: "event-creation-failed", message: "Fixture could not create its fixed mouse event.")
        }
        try validatePostingTarget(target, clickPoint: clickPoint)
        down.postToPid(getpid())
        up.postToPid(getpid())
    }

    private func postKeyPair(
        target: FixtureFocusTarget,
        clickPoint: CGPoint,
        keyCode: CGKeyCode,
        character: String
    ) throws {
        try validatePostingTarget(target, clickPoint: clickPoint)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
            throw FixtureFailure(code: "event-creation-failed", message: "Fixture could not create its fixed key event.")
        }
        var unicode = Array(character.utf16)
        guard unicode.count == 1 else {
            throw FixtureFailure(code: "invalid-fixed-input", message: "Fixture fixed input is invalid.")
        }
        down.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: &unicode)
        up.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: &unicode)
        try validatePostingTarget(target, clickPoint: clickPoint)
        down.postToPid(getpid())
        up.postToPid(getpid())
    }

    private func validatePostingTarget(_ target: FixtureFocusTarget, clickPoint: CGPoint) throws {
        let evidence = try waitForFocus(target)
        guard let window,
              window.windowNumber > 0,
              evidence.bounds?
                .insetBy(dx: 1, dy: 1)
                .contains(clickPoint) == true else {
            throw FixtureFailure(code: "posting-point-invalid", message: "Fixture refused input outside its currently focused control.")
        }
    }

    private func configureCurrentEditor(target: FixtureFocusTarget, control: NSTextField) throws {
        guard let editor = control.currentEditor() else {
            throw FixtureFailure(code: "field-editor-unavailable", message: "Fixture field editor is unavailable.")
        }
        switch target {
        case .publicField:
            editor.setAccessibilityIdentifier(publicFieldId)
            editor.setAccessibilitySubrole(nil)
        case .secureField:
            editor.setAccessibilityIdentifier(interactionFixtureSecureFieldId)
            editor.setAccessibilitySubrole(.secureTextField)
        case .neutral:
            throw FixtureFailure(code: "invalid-fixed-input", message: "Fixture input phase target is invalid.")
        }
    }

    private func waitForFocus(_ target: FixtureFocusTarget) throws -> FixtureFocusEvidence {
        let deadline = Date().addingTimeInterval(fixtureFocusTimeoutSeconds)
        repeat {
            if let evidence = try? requireFocus(target) { return evidence }
            waitOnMainRunLoop(seconds: 0.025)
        } while Date() < deadline
        throw FixtureFailure(code: "focus-verification-failed", message: "Fixture could not verify owned Accessibility focus.")
    }

    private func requireFocus(_ target: FixtureFocusTarget) throws -> FixtureFocusEvidence {
        guard let window,
              application.isActive,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
              window.isKeyWindow else {
            throw FixtureFailure(code: "fixture-not-frontmost", message: "Fixture refused input because its process is not frontmost and key.")
        }
        let system = AXUIElementCreateSystemWide()
        guard let rawFocused = fixtureAXAttribute(system, kAXFocusedUIElementAttribute as String),
              CFGetTypeID(rawFocused) == AXUIElementGetTypeID() else {
            throw FixtureFailure(code: "focus-unavailable", message: "Fixture Accessibility focus is unavailable.")
        }
        let focused = rawFocused as! AXUIElement
        var processId: pid_t = 0
        guard AXUIElementGetPid(focused, &processId) == .success,
              processId == getpid() else {
            throw FixtureFailure(code: "focus-ownership-mismatch", message: "Fixture refused input because focus is not owned by this process.")
        }
        let identifier = fixtureAXAttribute(focused, kAXIdentifierAttribute as String) as? String
        let role = fixtureAXAttribute(focused, kAXRoleAttribute as String) as? String
        let subrole = fixtureAXAttribute(focused, kAXSubroleAttribute as String) as? String
        let position = fixtureAXPoint(fixtureAXAttribute(focused, kAXPositionAttribute as String))
        let size = fixtureAXSize(fixtureAXAttribute(focused, kAXSizeAttribute as String))
        let bounds = position.flatMap { origin in size.map { CGRect(origin: origin, size: $0) } }

        switch target {
        case .publicField:
            guard identifier == publicFieldId,
                  role == (kAXTextFieldRole as String),
                  subrole != (kAXSecureTextFieldSubrole as String),
                  bounds != nil else {
                throw FixtureFailure(code: "public-focus-mismatch", message: "Fixture public input focus identity does not match.")
            }
            return FixtureFocusEvidence(bounds: bounds)
        case .secureField:
            // AppKit may surface its private secure field editor after the
            // click, so the configured identifier is not stable throughout a
            // key pair. Bind the target by owned PID/key window, secure
            // subrole, and the phase's already verified in-bounds click point.
            guard subrole == (kAXSecureTextFieldSubrole as String),
                  bounds != nil else {
                emitter.diagnostic(
                    "secure focus mismatch (identifier=\(identifier ?? "nil"), role=\(role ?? "nil"), subrole=\(subrole ?? "nil"), boundsAvailable=\(bounds != nil))"
                )
                throw FixtureFailure(code: "secure-focus-mismatch", message: "Fixture secure input focus identity does not match.")
            }
            return FixtureFocusEvidence(bounds: bounds)
        case .neutral:
            let textRoles: Set<String> = [
                kAXTextFieldRole as String,
                kAXTextAreaRole as String,
                kAXComboBoxRole as String,
            ]
            guard identifier == interactionFixtureNeutralTargetId,
                  role.map({ !textRoles.contains($0) }) == true else {
                throw FixtureFailure(code: "neutral-focus-mismatch", message: "Fixture neutral focus identity does not match.")
            }
            return FixtureFocusEvidence(bounds: nil)
        }
    }

    private func waitForValue(_ control: NSTextField, expected: String) -> Bool {
        let deadline = Date().addingTimeInterval(fixtureValueTimeoutSeconds)
        repeat {
            if control.stringValue == expected { return true }
            waitOnMainRunLoop(seconds: 0.025)
        } while Date() < deadline
        return false
    }

    private func waitForMetadataObservation() {
        waitOnMainRunLoop(seconds: fixtureMetadataObservationSeconds)
    }

    private func clearInputs() {
        publicField?.stringValue = ""
        secureField?.stringValue = ""
    }

    private func publicFocusIdentityJSON(window: NSWindow) -> [String: Any] {
        [
            "fieldId": publicFieldId,
            "processId": getpid(),
            "windowId": String(window.windowNumber),
            "windowTitle": windowTitle,
        ]
    }

    private func shutdown(requestId: String, emitEvent: Bool) {
        guard !shuttingDown else { return }
        shuttingDown = true
        clearInputs()
        window?.orderOut(nil)
        if emitEvent {
            emitter.emit([
                "event": "shutdown",
                "requestId": requestId,
            ])
        }
        application.stop(nil)
        if let wakeEvent = NSEvent.otherEvent(
            with: .applicationDefined,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            subtype: 0,
            data1: 0,
            data2: 0
        ) {
            application.postEvent(wakeEvent, atStart: false)
        }
    }

    private func cleanUpWindow() {
        clearInputs()
        window?.orderOut(nil)
        window?.close()
        window = nil
        publicField = nil
        secureField = nil
        neutralTarget = nil
    }
}

private func fixtureRequestId(from line: String) -> String? {
    guard let data = line.data(using: .utf8),
          data.count <= maximumProtocolLineBytes,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let requestId = object["requestId"] as? String,
          requestId == FixtureCommand.exercise.rawValue || requestId == FixtureCommand.shutdown.rawValue else {
        return nil
    }
    return requestId
}

private func fixtureAXAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

private func fixtureAXPoint(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

private func fixtureAXSize(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size),
          size.width > 0,
          size.height > 0 else {
        return nil
    }
    return size
}

private func fixturePointJSON(_ point: CGPoint) -> [String: Any] {
    ["x": point.x, "y": point.y]
}

private func fixtureRectJSON(_ rect: CGRect) -> [String: Any] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}

private func waitOnMainRunLoop(seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        let nextDeadline = min(deadline, Date().addingTimeInterval(0.025))
        if let event = NSApplication.shared.nextEvent(
            matching: .any,
            until: nextDeadline,
            inMode: .default,
            dequeue: true
        ) {
            NSApplication.shared.sendEvent(event)
        }
        NSApplication.shared.updateWindows()
    } while Date() < deadline
}

private func strictlyLaterMicroseconds(than earlier: UInt64) -> UInt64 {
    let sampled = monotonicMicroseconds()
    if sampled > earlier { return sampled }
    waitOnMainRunLoop(seconds: 0.001)
    return max(monotonicMicroseconds(), earlier + 1)
}
