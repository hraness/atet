import Foundation

private let maximumCaptureInterruptionSourceIDBytes = 256
private let maximumCaptureInterruptionSafeInteger: UInt64 = 9_007_199_254_740_991

enum CaptureInterruptionSource: String, Equatable, Sendable {
    case screen
    case systemAudio = "system-audio"
    case camera
    case microphone
}

enum ScreenCaptureInterruptionCode: String, Equatable, Sendable {
    case selectedDisplayDisconnected = "selected-display-disconnected"
    case streamStopped = "screen-stream-stopped"
    case recordingFailed = "screen-recording-failed"
}

enum SystemAudioCaptureInterruptionCode: String, Equatable, Sendable {
    case trackMissing = "system-audio-track-missing"
}

enum CameraCaptureInterruptionCode: String, Equatable, Sendable {
    case deviceDisconnected = "camera-device-disconnected"
    case sessionInterrupted = "camera-session-interrupted"
    case runtimeError = "camera-runtime-error"
    case sessionStopped = "camera-session-stopped"
    case recordingFailed = "camera-recording-failed"
}

enum MicrophoneCaptureInterruptionCode: String, Equatable, Sendable {
    case deviceDisconnected = "microphone-device-disconnected"
    case sessionInterrupted = "microphone-session-interrupted"
    case runtimeError = "microphone-runtime-error"
    case sessionStopped = "microphone-session-stopped"
    case recordingFailed = "microphone-recording-failed"
}

enum CaptureInterruptionIncident: Equatable, Sendable {
    case screen(ScreenCaptureInterruptionCode)
    case systemAudio(SystemAudioCaptureInterruptionCode)
    case camera(CameraCaptureInterruptionCode)
    case microphone(MicrophoneCaptureInterruptionCode)

    var source: CaptureInterruptionSource {
        switch self {
        case .screen:
            return .screen
        case .systemAudio:
            return .systemAudio
        case .camera:
            return .camera
        case .microphone:
            return .microphone
        }
    }

    var code: String {
        switch self {
        case .screen(let code):
            return code.rawValue
        case .systemAudio(let code):
            return code.rawValue
        case .camera(let code):
            return code.rawValue
        case .microphone(let code):
            return code.rawValue
        }
    }
}

enum CaptureInterruptionValueError: Error, Equatable {
    case invalidSegmentIndex
    case invalidSourceID
    case timestampExceedsJSONSafeInteger
    case invalidJSON
    case invalidMaximumByteCount
    case encodedValueTooLarge
}

private func validateCaptureInterruptionIdentityAndTimestamps(
    segmentIndex: Int,
    sourceId: String?,
    timestamps: UInt64...
) throws {
    guard segmentIndex >= 0, segmentIndex < maximumCaptureSegments else {
        throw CaptureInterruptionValueError.invalidSegmentIndex
    }
    if let sourceId {
        guard !sourceId.isEmpty,
              sourceId.utf8.count <= maximumCaptureInterruptionSourceIDBytes,
              !sourceId.contains("\0") else {
            throw CaptureInterruptionValueError.invalidSourceID
        }
    }
    guard timestamps.allSatisfy({ $0 <= maximumCaptureInterruptionSafeInteger }) else {
        throw CaptureInterruptionValueError.timestampExceedsJSONSafeInteger
    }
}

struct CaptureInterruptionSeed: Equatable, Sendable {
    let segmentIndex: Int
    let incident: CaptureInterruptionIncident
    let sourceId: String?
    let nativeTimeUs: UInt64

    init(
        segmentIndex: Int,
        incident: CaptureInterruptionIncident,
        sourceId: String?,
        nativeTimeUs: UInt64
    ) throws {
        try validateCaptureInterruptionIdentityAndTimestamps(
            segmentIndex: segmentIndex,
            sourceId: sourceId,
            timestamps: nativeTimeUs
        )
        self.segmentIndex = segmentIndex
        self.incident = incident
        self.sourceId = sourceId
        self.nativeTimeUs = nativeTimeUs
    }

    func validate() throws {
        try validateCaptureInterruptionIdentityAndTimestamps(
            segmentIndex: segmentIndex,
            sourceId: sourceId,
            timestamps: nativeTimeUs
        )
    }

    func resolve(at stamp: TimelineStamp, recoverable: Bool) throws -> CaptureInterruption {
        try CaptureInterruption(
            segmentIndex: segmentIndex,
            incident: incident,
            sourceId: sourceId,
            nativeTimeUs: stamp.nativeTimeUs,
            sourceTimeUs: stamp.sourceTimeUs,
            recoverable: recoverable
        )
    }
}

struct CaptureInterruption: Equatable, Sendable {
    let segmentIndex: Int
    let incident: CaptureInterruptionIncident
    let sourceId: String?
    let nativeTimeUs: UInt64
    let sourceTimeUs: UInt64
    let recoverable: Bool

    init(
        segmentIndex: Int,
        incident: CaptureInterruptionIncident,
        sourceId: String?,
        nativeTimeUs: UInt64,
        sourceTimeUs: UInt64,
        recoverable: Bool
    ) throws {
        try validateCaptureInterruptionIdentityAndTimestamps(
            segmentIndex: segmentIndex,
            sourceId: sourceId,
            timestamps: nativeTimeUs,
            sourceTimeUs
        )
        self.segmentIndex = segmentIndex
        self.incident = incident
        self.sourceId = sourceId
        self.nativeTimeUs = nativeTimeUs
        self.sourceTimeUs = sourceTimeUs
        self.recoverable = recoverable
    }

    var source: CaptureInterruptionSource {
        incident.source
    }

    var code: String {
        incident.code
    }

    var json: [String: Any] {
        var value: [String: Any] = [
            "code": code,
            "nativeTimeUs": NSNumber(value: nativeTimeUs),
            "recoverable": recoverable,
            "segmentIndex": segmentIndex,
            "source": source.rawValue,
            "sourceTimeUs": NSNumber(value: sourceTimeUs),
        ]
        value["sourceId"] = sourceId.map { $0 as Any } ?? NSNull()
        return value
    }

    func encodedJSON(maximumBytes: Int = maximumProtocolLineBytes) throws -> Data {
        guard maximumBytes > 0 else {
            throw CaptureInterruptionValueError.invalidMaximumByteCount
        }
        guard JSONSerialization.isValidJSONObject(json),
              let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) else {
            throw CaptureInterruptionValueError.invalidJSON
        }
        guard data.count <= maximumBytes else {
            throw CaptureInterruptionValueError.encodedValueTooLarge
        }
        return data
    }
}
