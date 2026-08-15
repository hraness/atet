import Foundation

let captureProtocolVersion = 4
let captureHelperVersion = "0.4.0"
let maximumProtocolLineBytes = 64 * 1024
let maximumCaptureSegments = 128

enum HelperState: String {
    case unconfigured
    case ready
    case recording
    case paused
    case stopped
    case shuttingDown = "shutting-down"
}

struct TypedTextFocusIdentity: Hashable {
    let fieldId: String
    let processId: Int32
    let windowId: String
    let windowTitle: String

    var json: [String: Any] {
        [
            "fieldId": fieldId,
            "processId": processId,
            "windowId": windowId,
            "windowTitle": windowTitle,
        ]
    }

    var sortKey: String {
        "\(processId)\0\(windowId)\0\(fieldId)\0\(windowTitle)"
    }
}

enum CaptureDisplaySelection {
    case all
    case selected([String])

    var json: [String: Any] {
        switch self {
        case .all:
            return ["kind": "all"]
        case .selected(let displayIds):
            return ["kind": "selected", "displayIds": displayIds]
        }
    }
}

enum CaptureDeviceSelection {
    case disabled
    case defaultDevice
    case device(String)

    var requested: Bool {
        if case .disabled = self { return false }
        return true
    }

    var json: [String: Any] {
        switch self {
        case .disabled:
            return ["kind": "disabled"]
        case .defaultDevice:
            return ["kind": "default"]
        case .device(let deviceId):
            return ["kind": "device", "deviceId": deviceId]
        }
    }
}

struct CaptureOptions {
    let camera: CaptureDeviceSelection
    let displays: CaptureDisplaySelection
    let metadata: Bool
    let microphone: CaptureDeviceSelection
    let interactionEventProcessIdentifier: Int32?
    let strictSources: Bool
    let systemAudio: Bool
    let typedText: Bool
    let typedTextFocusIdentities: Set<TypedTextFocusIdentity>?
    let excludedBundleIdentifiers: Set<String>

    static let defaults = CaptureOptions(
        camera: .defaultDevice,
        displays: .all,
        metadata: true,
        microphone: .defaultDevice,
        interactionEventProcessIdentifier: nil,
        strictSources: false,
        systemAudio: true,
        typedText: false,
        typedTextFocusIdentities: nil,
        excludedBundleIdentifiers: ["com.hraness.atet"]
    )

    var json: [String: Any] {
        var output: [String: Any] = [
            "camera": camera.json,
            "displays": displays.json,
            "metadata": metadata,
            "microphone": microphone.json,
            "strictSources": strictSources,
            "systemAudio": systemAudio,
            "typedText": typedText,
            "excludedBundleIdentifiers": excludedBundleIdentifiers.sorted(),
        ]
        if let interactionEventProcessIdentifier {
            output["interactionEventProcessIdentifier"] = interactionEventProcessIdentifier
        }
        if let typedTextFocusIdentities {
            output["typedTextFocusIdentities"] = typedTextFocusIdentities
                .sorted { $0.sortKey < $1.sortKey }
                .map(\.json)
        }
        return output
    }
}

enum CaptureCommand: String {
    case configure
    case start
    case pause
    case resume
    case snapshot
    case status
    case stop
    case shutdown
}

struct CaptureRequest {
    let requestId: String
    let command: CaptureCommand
    let sessionDirectory: String?
    let options: CaptureOptions?
}

struct HelperFailure: LocalizedError {
    let code: String
    let message: String
    let recoverable: Bool

    var errorDescription: String? { message }
}

enum RequestParser {
    private static let identifierPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9._:-]{1,128}$")

    static func parse(line: String) throws -> CaptureRequest {
        guard let data = line.data(using: .utf8), !data.isEmpty else {
            throw HelperFailure(code: "invalid-request", message: "Request line is empty or invalid UTF-8.", recoverable: true)
        }
        guard data.count <= maximumProtocolLineBytes else {
            throw HelperFailure(code: "request-too-large", message: "Request exceeds \(maximumProtocolLineBytes) bytes.", recoverable: true)
        }
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw HelperFailure(code: "invalid-json", message: "Request is not valid JSON.", recoverable: true)
        }
        guard let object = value as? [String: Any] else {
            throw HelperFailure(code: "invalid-request", message: "Request must be a JSON object.", recoverable: true)
        }
        guard integer(object["protocolVersion"]) == captureProtocolVersion else {
            throw HelperFailure(code: "unsupported-protocol", message: "Expected capture protocol version \(captureProtocolVersion).", recoverable: true)
        }
        guard let requestId = object["requestId"] as? String, validIdentifier(requestId) else {
            throw HelperFailure(code: "invalid-request-id", message: "requestId must be a bounded protocol identifier.", recoverable: true)
        }
        guard let commandName = object["command"] as? String, let command = CaptureCommand(rawValue: commandName) else {
            throw HelperFailure(code: "invalid-command", message: "Unknown capture command.", recoverable: true)
        }

        let allowedKeys: Set<String> = command == .configure
            ? ["protocolVersion", "requestId", "command", "sessionDirectory", "options"]
            : ["protocolVersion", "requestId", "command"]
        guard Set(object.keys).isSubset(of: allowedKeys) else {
            throw HelperFailure(code: "unknown-request-field", message: "Request contains an unknown field.", recoverable: true)
        }

        if command == .configure {
            guard let directory = object["sessionDirectory"] as? String, validAbsolutePathSyntax(directory) else {
                throw HelperFailure(code: "invalid-session-directory", message: "sessionDirectory must be an absolute normalized macOS path.", recoverable: true)
            }
            let options = try parseOptions(object["options"])
            return CaptureRequest(requestId: requestId, command: command, sessionDirectory: directory, options: options)
        }
        return CaptureRequest(requestId: requestId, command: command, sessionDirectory: nil, options: nil)
    }

    private static func parseOptions(_ value: Any?) throws -> CaptureOptions {
        guard let value else { return .defaults }
        guard let object = value as? [String: Any] else {
            throw HelperFailure(code: "invalid-options", message: "options must be a JSON object.", recoverable: true)
        }
        let allowed: Set<String> = [
            "camera", "displays", "metadata", "microphone", "strictSources", "systemAudio", "typedText",
            "excludedBundleIdentifiers", "interactionEventProcessIdentifier", "typedTextFocusIdentities",
        ]
        guard Set(object.keys).isSubset(of: allowed) else {
            throw HelperFailure(code: "unknown-option", message: "Capture options contain an unknown field.", recoverable: true)
        }
        let defaults = CaptureOptions.defaults
        let identifiers: Set<String>
        if let rawIdentifiers = object["excludedBundleIdentifiers"] {
            guard let values = rawIdentifiers as? [Any], values.count <= 16 else {
                throw HelperFailure(code: "invalid-options", message: "excludedBundleIdentifiers must contain at most 16 values.", recoverable: true)
            }
            let strings = try values.map { value -> String in
                guard let string = value as? String, !string.isEmpty, string.utf8.count <= 256, !string.contains("\0") else {
                    throw HelperFailure(code: "invalid-options", message: "Invalid excluded bundle identifier.", recoverable: true)
                }
                return string
            }
            identifiers = Set(strings)
        } else {
            identifiers = defaults.excludedBundleIdentifiers
        }
        let typedTextFocusIdentities: Set<TypedTextFocusIdentity>?
        if let rawFocusIdentities = object["typedTextFocusIdentities"] {
            if rawFocusIdentities is NSNull {
                typedTextFocusIdentities = nil
            } else {
                guard let values = rawFocusIdentities as? [Any], values.count <= 16 else {
                    throw HelperFailure(code: "invalid-options", message: "typedTextFocusIdentities must contain at most 16 values.", recoverable: true)
                }
                let identities = try values.map { value -> TypedTextFocusIdentity in
                    guard let identity = value as? [String: Any],
                          Set(identity.keys) == ["fieldId", "processId", "windowId", "windowTitle"],
                          let fieldId = boundedNonNULString(identity["fieldId"], maximumUTF8Bytes: 512),
                          let processIdValue = integer(identity["processId"]),
                          processIdValue > 0,
                          processIdValue <= Int(Int32.max),
                          let windowId = boundedNonNULString(identity["windowId"], maximumUTF8Bytes: 32),
                          validPositiveDecimalIdentifier(windowId),
                          let windowTitle = boundedNonNULString(identity["windowTitle"], maximumUTF8Bytes: 256) else {
                        throw HelperFailure(code: "invalid-options", message: "Invalid typed-text focus identity.", recoverable: true)
                    }
                    return TypedTextFocusIdentity(
                        fieldId: fieldId,
                        processId: Int32(processIdValue),
                        windowId: windowId,
                        windowTitle: windowTitle
                    )
                }
                let unique = Set(identities)
                guard unique.count == identities.count else {
                    throw HelperFailure(code: "invalid-options", message: "typedTextFocusIdentities must be unique.", recoverable: true)
                }
                typedTextFocusIdentities = unique
            }
        } else {
            typedTextFocusIdentities = defaults.typedTextFocusIdentities
        }
        let interactionEventProcessIdentifier: Int32?
        if let rawProcessIdentifier = object["interactionEventProcessIdentifier"] {
            if rawProcessIdentifier is NSNull {
                interactionEventProcessIdentifier = nil
            } else {
                guard let value = integer(rawProcessIdentifier),
                      value > 0,
                      value <= Int(Int32.max) else {
                    throw HelperFailure(
                        code: "invalid-options",
                        message: "interactionEventProcessIdentifier must be a positive 32-bit process ID or null.",
                        recoverable: true
                    )
                }
                interactionEventProcessIdentifier = Int32(value)
            }
        } else {
            interactionEventProcessIdentifier = defaults.interactionEventProcessIdentifier
        }
        return CaptureOptions(
            camera: try deviceSelection(object["camera"], default: defaults.camera, label: "camera"),
            displays: try displaySelection(object["displays"], default: defaults.displays),
            metadata: try bool(object, "metadata", default: defaults.metadata),
            microphone: try deviceSelection(object["microphone"], default: defaults.microphone, label: "microphone"),
            interactionEventProcessIdentifier: interactionEventProcessIdentifier,
            strictSources: try bool(object, "strictSources", default: defaults.strictSources),
            systemAudio: try bool(object, "systemAudio", default: defaults.systemAudio),
            typedText: try bool(object, "typedText", default: defaults.typedText),
            typedTextFocusIdentities: typedTextFocusIdentities,
            excludedBundleIdentifiers: identifiers
        )
    }

    private static func displaySelection(
        _ value: Any?,
        default defaultValue: CaptureDisplaySelection
    ) throws -> CaptureDisplaySelection {
        guard let value else { return defaultValue }
        guard let object = value as? [String: Any],
              let kind = object["kind"] as? String else {
            throw HelperFailure(code: "invalid-options", message: "displays must be a capture-source selection.", recoverable: true)
        }
        if kind == "all" {
            guard Set(object.keys) == ["kind"] else {
                throw HelperFailure(code: "invalid-options", message: "The all-display selection contains an unknown field.", recoverable: true)
            }
            return .all
        }
        guard kind == "selected",
              Set(object.keys) == ["kind", "displayIds"],
              let values = object["displayIds"] as? [Any],
              !values.isEmpty,
              values.count <= 16 else {
            throw HelperFailure(code: "invalid-options", message: "Selected displays must contain 1 through 16 display IDs.", recoverable: true)
        }
        let displayIds = try values.map { value -> String in
            guard let displayId = boundedNonNULString(value, maximumUTF8Bytes: 64) else {
                throw HelperFailure(code: "invalid-options", message: "Selected display IDs must be bounded non-empty strings.", recoverable: true)
            }
            return displayId
        }
        guard Set(displayIds).count == displayIds.count else {
            throw HelperFailure(code: "invalid-options", message: "Selected display IDs must be unique.", recoverable: true)
        }
        return .selected(displayIds)
    }

    private static func deviceSelection(
        _ value: Any?,
        default defaultValue: CaptureDeviceSelection,
        label: String
    ) throws -> CaptureDeviceSelection {
        guard let value else { return defaultValue }
        guard let object = value as? [String: Any],
              let kind = object["kind"] as? String else {
            throw HelperFailure(code: "invalid-options", message: "\(label) must be a capture-device selection.", recoverable: true)
        }
        if kind == "disabled" || kind == "default" {
            guard Set(object.keys) == ["kind"] else {
                throw HelperFailure(code: "invalid-options", message: "The \(label) selection contains an unknown field.", recoverable: true)
            }
            return kind == "disabled" ? .disabled : .defaultDevice
        }
        guard kind == "device",
              Set(object.keys) == ["kind", "deviceId"],
              let deviceId = boundedNonNULString(object["deviceId"], maximumUTF8Bytes: 256) else {
            throw HelperFailure(code: "invalid-options", message: "The \(label) device selection requires one bounded deviceId.", recoverable: true)
        }
        return .device(deviceId)
    }

    private static func bool(_ object: [String: Any], _ key: String, default defaultValue: Bool) throws -> Bool {
        guard let value = object[key] else { return defaultValue }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw HelperFailure(code: "invalid-options", message: "\(key) must be boolean.", recoverable: true)
        }
        return number.boolValue
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double else { return nil }
        return number.intValue
    }

    private static func boundedNonNULString(_ value: Any?, maximumUTF8Bytes: Int) -> String? {
        guard let string = value as? String,
              !string.isEmpty,
              string.utf8.count <= maximumUTF8Bytes,
              !string.contains("\0") else {
            return nil
        }
        return string
    }

    private static func validPositiveDecimalIdentifier(_ value: String) -> Bool {
        guard value.first != "0" else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 48 && scalar.value <= 57
        }
    }

    private static func validIdentifier(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return identifierPattern.firstMatch(in: value, range: range) != nil
    }

    private static func validAbsolutePathSyntax(_ value: String) -> Bool {
        guard value.utf8.count <= 4_096, value.hasPrefix("/"), !value.contains("\0") else { return false }
        return !value.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == "." || $0 == ".." }
    }
}

enum ProtocolEmitterBatchRejection: String, Equatable, Sendable {
    case tooManyEvents = "too-many-events"
    case invalidOrOversizedEvent = "invalid-or-oversized-event"
}

/// The only delivery facts that a single `write` call can establish.
///
/// A throwing writer is always uncertain: Foundation does not prove that zero
/// bytes reached stdout before the error. Callers must never retry that batch.
enum ProtocolEmitterBatchResult: Equatable, Sendable {
    case confirmedNominal(eventCount: Int)
    case confirmedBoundedFallback(ProtocolEmitterBatchRejection)
    case uncertainWriterFailure
}

final class ProtocolEmitter: @unchecked Sendable {
    typealias LineWriter = @Sendable (Data) throws -> Void

    private let lock = NSLock()
    private let lineWriter: LineWriter
    private var deliveryUncertain = false

    init(lineWriter: @escaping LineWriter = { batch in
        try FileHandle.standardOutput.write(contentsOf: batch)
    }) {
        self.lineWriter = lineWriter
    }

    @discardableResult
    func emit(_ object: [String: Any]) -> ProtocolEmitterBatchResult {
        emitBatch([object])
    }

    /// Validates every line first, then makes one locked writer call for the
    /// complete newline-delimited batch. Nominal lines cannot interleave with
    /// another command, and a bounded fallback never has a nominal suffix.
    @discardableResult
    func emitBatch(_ objects: [[String: Any]]) -> ProtocolEmitterBatchResult {
        if objects.isEmpty {
            return emptyBatchResult()
        }
        guard objects.count <= 8 else {
            return emitFallback(
                for: objects.first,
                rejection: .tooManyEvents
            )
        }

        var lines: [Data] = []
        lines.reserveCapacity(objects.count)
        for object in objects {
            var output = object
            output["protocolVersion"] = captureProtocolVersion
            guard let line = encoded(output) else {
                return emitFallback(
                    for: object,
                    rejection: .invalidOrOversizedEvent
                )
            }
            lines.append(line)
        }

        var batch = Data()
        batch.reserveCapacity(lines.reduce(0) { $0 + $1.count + 1 })
        for line in lines {
            batch.append(line)
            batch.append(0x0A)
        }
        guard write(batch) else {
            return .uncertainWriterFailure
        }
        return .confirmedNominal(eventCount: objects.count)
    }

    private func encoded(_ object: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              data.count + 1 <= maximumProtocolLineBytes else { return nil }
        return data
    }

    private func emitFallback(
        for object: [String: Any]?,
        rejection: ProtocolEmitterBatchRejection
    ) -> ProtocolEmitterBatchResult {
        let requestId = validProtocolIdentifier(object?["requestId"] as? String)
            ?? "invalid-request"
        let candidateState = object?["state"] as? String
        let state = candidateState.flatMap(HelperState.init(rawValue:))?.rawValue
            ?? HelperState.shuttingDown.rawValue
        let failure: [String: Any] = [
            "code": "response-too-large",
            "event": "error",
            "interruption": NSNull(),
            "message": "Capture helper response exceeded the bounded protocol envelope.",
            "protocolVersion": captureProtocolVersion,
            "recoverable": false,
            "requestId": requestId,
            "state": state,
        ]
        guard let failureData = encoded(failure) else {
            poisonDelivery()
            diagnostic("capture helper could not encode the bounded protocol failure")
            return .uncertainWriterFailure
        }
        var batch = failureData
        batch.append(0x0A)
        guard write(batch) else {
            return .uncertainWriterFailure
        }
        diagnostic("capture helper replaced an invalid or oversized protocol batch with a bounded failure")
        return .confirmedBoundedFallback(rejection)
    }

    private func validProtocolIdentifier(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.utf8.count <= 128 else {
            return nil
        }
        let valid = value.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 45, 46, 48...57, 58, 65...90, 95, 97...122:
                return true
            default:
                return false
            }
        }
        return valid ? value : nil
    }

    @discardableResult
    private func write(_ data: Data) -> Bool {
        lock.lock()
        guard !deliveryUncertain else {
            lock.unlock()
            return false
        }
        do {
            try lineWriter(data)
            lock.unlock()
            return true
        } catch {
            deliveryUncertain = true
            lock.unlock()
            diagnostic("stdout protocol write failed: \(error.localizedDescription)")
            return false
        }
    }

    private func emptyBatchResult() -> ProtocolEmitterBatchResult {
        lock.lock()
        defer { lock.unlock() }
        return deliveryUncertain
            ? .uncertainWriterFailure
            : .confirmedNominal(eventCount: 0)
    }

    private func poisonDelivery() {
        lock.lock()
        deliveryUncertain = true
        lock.unlock()
    }

    @discardableResult
    func error(
        requestId: String,
        failure: HelperFailure,
        state: HelperState,
        interruption: CaptureInterruption? = nil
    ) -> ProtocolEmitterBatchResult {
        emit([
            "event": "error",
            "requestId": requestId,
            "code": failure.code,
            "interruption": interruption?.json ?? NSNull(),
            "message": bounded(failure.message, maximumUTF8Bytes: 4_096),
            "recoverable": failure.recoverable,
            "state": state.rawValue,
        ])
    }

    func diagnostic(_ message: String) {
        let line = "atet-capture: \(bounded(message, maximumUTF8Bytes: 8_192))\n"
        guard let data = line.data(using: .utf8) else { return }
        try? FileHandle.standardError.write(contentsOf: data)
    }
}

func bounded(_ value: String, maximumUTF8Bytes: Int) -> String {
    if value.utf8.count <= maximumUTF8Bytes { return value }
    var output = ""
    output.reserveCapacity(maximumUTF8Bytes)
    for character in value {
        let candidate = output + String(character)
        if candidate.utf8.count > maximumUTF8Bytes - 3 { break }
        output = candidate
    }
    return output + "..."
}
