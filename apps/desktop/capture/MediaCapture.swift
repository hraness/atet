import AVFoundation
import AudioToolbox
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct CaptureDiagnostic: Sendable {
    let code: String
    let message: String
    let recoverable: Bool
    let source: String

    var json: [String: Any] {
        [
            "code": bounded(code, maximumUTF8Bytes: 128),
            "message": bounded(message, maximumUTF8Bytes: 512),
            "recoverable": recoverable,
            "source": source,
        ]
    }
}

struct DisplayGeometry: Equatable, Sendable {
    let displayId: CGDirectDisplayID
    let bounds: CGRect
    let pixelWidth: Int
    let pixelHeight: Int
    let scaleFactor: Double
    let isPrimary: Bool

    init(display: SCDisplay, isPrimary: Bool? = nil) {
        displayId = display.displayID
        bounds = display.frame
        pixelWidth = max(1, CGDisplayPixelsWide(display.displayID))
        pixelHeight = max(1, CGDisplayPixelsHigh(display.displayID))
        let horizontalScale = Double(pixelWidth) / max(1, bounds.width)
        let verticalScale = Double(pixelHeight) / max(1, bounds.height)
        scaleFactor = max(horizontalScale, verticalScale)
        self.isPrimary = isPrimary ?? (CGDisplayIsMain(display.displayID) != 0)
    }

    init(displayId: CGDirectDisplayID, isPrimary: Bool? = nil) {
        self.displayId = displayId
        bounds = CGDisplayBounds(displayId)
        pixelWidth = max(1, CGDisplayPixelsWide(displayId))
        pixelHeight = max(1, CGDisplayPixelsHigh(displayId))
        let horizontalScale = Double(pixelWidth) / max(1, bounds.width)
        let verticalScale = Double(pixelHeight) / max(1, bounds.height)
        scaleFactor = max(horizontalScale, verticalScale)
        self.isPrimary = isPrimary ?? (CGDisplayIsMain(displayId) != 0)
    }

    var identifier: String { String(displayId) }

    var json: [String: Any] {
        [
            "displayId": identifier,
            "bounds": [
                "x": bounds.origin.x,
                "y": bounds.origin.y,
                "width": bounds.width,
                "height": bounds.height,
            ],
            "pixelWidth": pixelWidth,
            "pixelHeight": pixelHeight,
            "scaleFactor": scaleFactor,
            "isPrimary": isPrimary,
        ]
    }

    var topologyJSON: [String: Any] {
        [
            "displayId": identifier,
            "label": isPrimary ? "Primary display" : "Display \(identifier)",
            "bounds": [
                "x": bounds.origin.x,
                "y": bounds.origin.y,
                "width": bounds.width,
                "height": bounds.height,
            ],
            "pixelSize": ["width": pixelWidth, "height": pixelHeight],
            "scaleFactor": scaleFactor,
            "refreshRateHz": displayRefreshRate(displayId),
            "isPrimary": isPrimary,
        ]
    }
}

func currentDisplayTopology() -> [DisplayGeometry] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var identifiers = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &identifiers, &count) == .success else { return [] }
    return identifiers.prefix(Int(count))
        .map { DisplayGeometry(displayId: $0) }
        .sorted { lhs, rhs in
            if lhs.isPrimary != rhs.isPrimary { return lhs.isPrimary }
            return lhs.displayId < rhs.displayId
        }
}

private func availableDevices(for mediaType: AVMediaType, limit: Int) -> [AVCaptureDevice] {
    let defaultId = AVCaptureDevice.default(for: mediaType)?.uniqueID
    let deviceTypes: [AVCaptureDevice.DeviceType] = mediaType == .audio
        ? [.microphone]
        : [
            .builtInWideAngleCamera,
            .continuityCamera,
            .deskViewCamera,
            .external,
        ]
    let discovered = AVCaptureDevice.DiscoverySession(
        deviceTypes: deviceTypes,
        mediaType: mediaType,
        position: .unspecified
    ).devices
    return Array(
        discovered
            .reduce(into: [String: AVCaptureDevice]()) { devices, device in
                devices[device.uniqueID] = device
            }
            .values
            .sorted { left, right in
                if (left.uniqueID == defaultId) != (right.uniqueID == defaultId) {
                    return left.uniqueID == defaultId
                }
                let labelOrder = left.localizedName.localizedStandardCompare(right.localizedName)
                if labelOrder != .orderedSame { return labelOrder == .orderedAscending }
                return left.uniqueID < right.uniqueID
            }
            .prefix(limit)
    )
}

private func selectedDevice(
    _ selection: CaptureDeviceSelection,
    mediaType: AVMediaType,
    label: String
) throws -> AVCaptureDevice? {
    switch selection {
    case .disabled:
        return nil
    case .defaultDevice:
        return AVCaptureDevice.default(for: mediaType)
    case .device(let deviceId):
        guard let device = availableDevices(for: mediaType, limit: 64).first(where: {
            $0.uniqueID == deviceId
        }) else {
            throw HelperFailure(
                code: "\(label)-device-unknown",
                message: "The selected \(label) device ID is not available.",
                recoverable: true
            )
        }
        return device
    }
}

private func selectedDisplayTopology(
    _ selection: CaptureDisplaySelection
) throws -> [DisplayGeometry] {
    let available = currentDisplayTopology()
    let selected: [DisplayGeometry]
    switch selection {
    case .all:
        guard available.count <= 16 else {
            throw HelperFailure(
                code: "too-many-displays",
                message: "At most 16 displays can be recorded.",
                recoverable: true
            )
        }
        selected = available
    case .selected(let displayIds):
        let byId = Dictionary(uniqueKeysWithValues: available.map { ($0.identifier, $0) })
        selected = try displayIds.map { displayId in
            guard let display = byId[displayId] else {
                throw HelperFailure(
                    code: "display-unknown",
                    message: "Selected display ID \(displayId) is not connected.",
                    recoverable: true
                )
            }
            return display
        }
    }
    guard !selected.isEmpty else {
        throw HelperFailure(
            code: "no-displays",
            message: "No selected display is connected.",
            recoverable: true
        )
    }
    let ordered = selected.sorted { lhs, rhs in
        if lhs.isPrimary != rhs.isPrimary { return lhs.isPrimary }
        return lhs.displayId < rhs.displayId
    }
    return ordered.enumerated().map { index, display in
        DisplayGeometry(displayId: display.displayId, isPrimary: index == 0)
    }
}

func discoverAvailableSourceInventory() -> [String: Any] {
    var audio: [[String: Any]] = []
    audio.append([
        "audioSourceId": "system-audio",
        "channels": 2,
        "kind": "system",
        "label": "System audio",
        "sampleRateHz": 48_000,
    ])
    audio.append(contentsOf: availableDevices(for: .audio, limit: 63).map {
        audioSourceJSON(device: $0)
    })
    return [
        "audio": audio,
        "cameras": availableDevices(for: .video, limit: 32).map {
            cameraSourceJSON(device: $0)
        },
        "displays": currentDisplayTopology().prefix(16).map(\.topologyJSON),
    ]
}

func discoverSelectedSourceInventory(options: CaptureOptions) throws -> [String: Any] {
    var audio: [[String: Any]] = []
    if options.systemAudio {
        audio.append([
            "audioSourceId": "system-audio",
            "channels": 2,
            "kind": "system",
            "label": "System audio",
            "sampleRateHz": 48_000,
        ])
    }
    if let microphone = try selectedDevice(
        options.microphone,
        mediaType: .audio,
        label: "microphone"
    ) {
        audio.append(audioSourceJSON(device: microphone))
    }
    let camera = try selectedDevice(options.camera, mediaType: .video, label: "camera")
    return [
        "audio": audio,
        "cameras": camera.map { [cameraSourceJSON(device: $0)] } ?? [],
        "displays": try selectedDisplayTopology(options.displays).map(\.topologyJSON),
    ]
}

private func displayRefreshRate(_ displayId: CGDirectDisplayID) -> Double {
    guard let mode = CGDisplayCopyDisplayMode(displayId) else { return 60 }
    return mode.refreshRate > 0 ? mode.refreshRate : 60
}

private struct AssetInspection {
    let containerDurationUs: UInt64
    let streams: [[String: Any]]
    let diagnostics: [CaptureDiagnostic]
}

private struct InspectedTrack {
    let streamIndex: Int
    let trackId: Int32
    let mediaType: AVMediaType
    let codec: String
    let sampleRateHz: Int?
    let channels: Int?
    let timing: FileSampleTiming
}

private func inspectScreenAsset(
    url: URL,
    includesSystemAudio: Bool,
    liveVideoAccumulator: SampleTimingAccumulator,
    liveAudioAccumulator: SampleTimingAccumulator?
) async throws -> AssetInspection {
    do {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let tracks = try await asset.load(.tracks)
        var inspected: [InspectedTrack] = []
        for (index, track) in tracks.enumerated() {
            guard track.mediaType == .video || track.mediaType == .audio else {
                continue
            }
            let descriptions = try await track.load(.formatDescriptions)
            let description = descriptions.first
            let subtype = description.map(CMFormatDescriptionGetMediaSubType)
            var sampleRate: Int?
            var channels: Int?
            if track.mediaType == .audio,
               let description,
               let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description) {
                sampleRate = Int(basic.pointee.mSampleRate.rounded())
                channels = Int(basic.pointee.mChannelsPerFrame)
            }
            inspected.append(InspectedTrack(
                streamIndex: index,
                trackId: track.trackID,
                mediaType: track.mediaType,
                codec: subtype.map(codecName) ?? "unknown",
                sampleRateHz: sampleRate,
                channels: channels,
                timing: try inspectCompressedTrackTiming(asset: asset, track: track)
            ))
        }
        let videoTracks = inspected.filter { $0.mediaType == .video }
        guard videoTracks.count == 1, let videoTrack = videoTracks.first else {
            throw HelperFailure(code: "screen-video-track-invalid", message: "Finalized display container must have exactly one video track.", recoverable: false)
        }
        let audioTracks = inspected.filter { $0.mediaType == .audio }
        let diagnostics: [CaptureDiagnostic] = []
        if includesSystemAudio && audioTracks.isEmpty {
            throw HelperFailure(code: "system-audio-track-missing", message: "Finalized display container has no requested system-audio track.", recoverable: false)
        }
        let liveVideoTiming: MediaSampleTiming
        let liveAudioTiming: MediaSampleTiming?
        do {
            liveVideoTiming = try liveVideoAccumulator.finish(
                finalizedTimingFallback: videoTrack.timing
            )
            try validateLiveAndFileTiming(
                live: liveVideoTiming,
                file: videoTrack.timing,
                source: "display-video",
                requireMatchingCounts: true
            )
            if includesSystemAudio, let liveAudioAccumulator, let audioTrack = audioTracks.first {
                let timing = try liveAudioAccumulator.finish(
                    finalizedTimingFallback: audioTrack.timing
                )
                try validateLiveAndFileTiming(
                    live: timing,
                    file: audioTrack.timing,
                    source: "system-audio"
                )
                liveAudioTiming = timing
            } else {
                liveAudioTiming = nil
            }
        } catch let failure as SampleTimingFailure {
            throw HelperFailure(
                code: "screen-sample-timing-invalid",
                message: failure.message,
                recoverable: false
            )
        }
        var audioOrdinal = 0
        var streamJSON: [[String: Any]] = []
        for track in inspected {
            let role: String
            let mapping: String
            let liveTiming: MediaSampleTiming?
            if track.mediaType == .video {
                role = "display-video"
                mapping = "exact"
                liveTiming = liveVideoTiming
            } else if track.mediaType == .audio {
                if includesSystemAudio {
                    role = audioOrdinal == 0 ? "system-audio" : "unclassified-audio"
                    mapping = audioOrdinal == 0 ? "exact" : "provisional"
                    liveTiming = audioOrdinal == 0 ? liveAudioTiming : nil
                } else {
                    role = "unclassified-audio"
                    mapping = "provisional"
                    liveTiming = nil
                }
                audioOrdinal += 1
            } else {
                continue
            }
            var output: [String: Any] = [
                "role": role,
                "mapping": mapping,
                "streamIndex": track.streamIndex,
                "trackId": Int(track.trackId),
                "codec": track.codec,
            ]
            if let sampleRate = track.sampleRateHz { output["sampleRateHz"] = sampleRate }
            if let channels = track.channels { output["channels"] = channels }
            if role != "unclassified-audio" {
                guard let liveTiming else {
                    throw HelperFailure(
                        code: "screen-sample-timing-missing",
                        message: "A finalized display stream has no live sample timing.",
                        recoverable: false
                    )
                }
                output["timing"] = liveTiming.json
            }
            streamJSON.append(output)
        }
        let seconds = duration.isNumeric ? max(0, CMTimeGetSeconds(duration)) : 0
        guard seconds > 0 else {
            throw HelperFailure(code: "screen-duration-invalid", message: "Finalized display container has no positive duration.", recoverable: false)
        }
        return AssetInspection(
            containerDurationUs: UInt64(seconds * 1_000_000),
            streams: streamJSON,
            diagnostics: diagnostics
        )
    } catch let failure as HelperFailure {
        throw failure
    } catch {
        throw HelperFailure(code: "screen-asset-inspection-failed", message: "Finalized display media could not be inspected.", recoverable: false)
    }
}

private func codecName(_ value: FourCharCode) -> String {
    switch value {
    case kCMVideoCodecType_H264: return "h264"
    case kCMVideoCodecType_HEVC: return "hevc"
    case kAudioFormatMPEG4AAC: return "aac"
    case kAudioFormatLinearPCM: return "pcm"
    default:
        let bytes: [UInt8] = [
            UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff), UInt8(value & 0xff),
        ]
        let text = String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown"
        return text.isEmpty ? "unknown" : text
    }
}

private func timedScreenSample(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard CMSampleBufferIsValid(sampleBuffer),
          CMSampleBufferDataIsReady(sampleBuffer),
          let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer,
            createIfNecessary: false
          ) as? [[SCStreamFrameInfo: Any]],
          let first = attachments.first,
          let rawStatus = first[.status] as? Int,
          let status = SCFrameStatus(rawValue: rawStatus) else {
        return false
    }
    // `.started` carries the first real surface. `.complete` carries later
    // generated frames. Idle, blank, suspended, and stopped buffers are
    // control/placeholders and must not become media timing observations.
    return status == .started || status == .complete
}

private struct DisplayRecorderFailure: Error, Sendable {
    let code: String
    let message: String
    let recoverable: Bool

    init(code: String, message: String, recoverable: Bool) {
        self.code = code
        self.message = message
        self.recoverable = recoverable
    }

    init(_ failure: HelperFailure) {
        self.init(
            code: failure.code,
            message: failure.message,
            recoverable: failure.recoverable
        )
    }

    init(error: any Error, fallbackCode: String, recoverable: Bool) {
        if let failure = error as? HelperFailure {
            self.init(failure)
        } else {
            self.init(
                code: fallbackCode,
                message: error.localizedDescription,
                recoverable: recoverable
            )
        }
    }

    var helperFailure: HelperFailure {
        HelperFailure(code: code, message: message, recoverable: recoverable)
    }
}

private struct DisplayStartOutcome: Sendable {
    let recorder: DisplayRecorder
    let result: Result<Void, DisplayRecorderFailure>
}

private final class DisplayRecorder:
    NSObject,
    SCRecordingOutputDelegate,
    SCStreamDelegate,
    SCStreamOutput,
    @unchecked Sendable
{
    let geometry: DisplayGeometry
    let relativePath: String
    let outputURL: URL
    let includesSystemAudio: Bool
    private let diagnosticLock = NSLock()
    private var storedDiagnostics: [CaptureDiagnostic] = []
    private let cleanupLease: CaptureRecordingCleanupLease
    private let interruptionReporter: CaptureInterruptionReporter
    private let muxTerminalBarrier =
        CaptureMuxTerminalBarrier<DisplayRecorderFailure>()
    private let timingQueue: DispatchQueue
    private let videoTiming = SampleTimingAccumulator()
    private let audioTiming = SampleTimingAccumulator()
    private var acceptsTimingSamples = true
    private let stopFlight =
        CaptureSingleFlight<DisplayRecordingCompletion, DisplayRecorderFailure>()
    private(set) var stream: SCStream!
    private(set) var recordingOutput: SCRecordingOutput!

    init(
        display: SCDisplay,
        isPrimary: Bool,
        excludedApplications: [SCRunningApplication],
        relativePath: String,
        outputURL: URL,
        includesSystemAudio: Bool,
        metadataEnabled: Bool,
        interruptionReporter: CaptureInterruptionReporter
    ) throws {
        geometry = DisplayGeometry(display: display, isPrimary: isPrimary)
        self.relativePath = relativePath
        self.outputURL = outputURL
        self.includesSystemAudio = includesSystemAudio
        self.interruptionReporter = interruptionReporter
        cleanupLease = CaptureRecordingCleanupLease(
            subject: "display \(display.displayID)"
        )
        timingQueue = DispatchQueue(
            label: "com.hraness.atet.capture.display-timing.\(display.displayID)",
            qos: .userInitiated
        )
        super.init()

        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApplications,
            exceptingWindows: []
        )
        let configuration = SCStreamConfiguration()
        configuration.width = geometry.pixelWidth
        configuration.height = geometry.pixelHeight
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 8
        configuration.showsCursor = !metadataEnabled
        configuration.capturesAudio = includesSystemAudio
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.excludesCurrentProcessAudio = true
        configuration.captureMicrophone = false
        configuration.microphoneCaptureDeviceID = nil
        configuration.captureResolution = .best

        let outputConfiguration = SCRecordingOutputConfiguration()
        outputConfiguration.outputURL = outputURL
        outputConfiguration.outputFileType = .mp4
        outputConfiguration.videoCodecType = .h264
        recordingOutput = SCRecordingOutput(configuration: outputConfiguration, delegate: self)
        stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: timingQueue)
        if includesSystemAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: timingQueue)
        }
        try stream.addRecordingOutput(recordingOutput)
    }

    func start() async throws {
        cleanupLease.markStartAttempted()
        await startStream(
            subject: "display \(geometry.displayId) start",
            timeoutNanoseconds: 15_000_000_000
        )
    }

    func stop() async throws -> DisplayRecordingCompletion {
        switch await stopResult() {
        case .success(let completion):
            return completion
        case .failure(let failure):
            throw failure.helperFailure
        }
    }

    func stopResult() async -> Result<DisplayRecordingCompletion, DisplayRecorderFailure> {
        await stopFlight.run { [self] in
            await performStop()
        }
    }

    private func performStop() async -> Result<DisplayRecordingCompletion, DisplayRecorderFailure> {
        do {
            return .success(try await performStopThrowing())
        } catch {
            return .failure(DisplayRecorderFailure(
                error: error,
                fallbackCode: "screen-finalization-failed",
                recoverable: false
            ))
        }
    }

    private func performStopThrowing() async throws -> DisplayRecordingCompletion {
        interruptionReporter.seal()
        await stopStream(
            subject: "normal display \(geometry.displayId) stop",
            timeoutNanoseconds: 15_000_000_000,
            fallbackCode: "screen-stop-failed"
        )
        detachTimingOutputs()
        await closeAndDrainTimingQueue()
        let muxFailure = await resolveCleanupDecision(
            cleanupLease.requireFinalizationAfterStreamStop(),
            timeoutNanoseconds: 15_000_000_000
        )
        secureRetainedOutputOrFailClosed()
        enforceCleanupDecision(cleanupLease.completeCleanup(
            nativeMediaEvidence: recordingOutputHasNativeMediaEvidence,
            fileEvidence: FileManager.default.fileExists(atPath: outputURL.path)
        ))
        if let muxFailure {
            throw muxFailure.helperFailure
        }
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            throw HelperFailure(code: "screen-output-missing", message: "Display recording output was not created.", recoverable: false)
        }
        let inspection = try await inspectScreenAsset(
            url: outputURL,
            includesSystemAudio: includesSystemAudio,
            liveVideoAccumulator: videoTiming,
            liveAudioAccumulator: includesSystemAudio ? audioTiming : nil
        )
        for diagnostic in inspection.diagnostics {
            appendDiagnostic(code: diagnostic.code, message: diagnostic.message, recoverable: diagnostic.recoverable)
        }
        return DisplayRecordingCompletion(
            geometry: geometry,
            relativePath: relativePath,
            containerDurationUs: inspection.containerDurationUs,
            streams: inspection.streams,
            diagnostics: diagnostics
        )
    }

    func abortBeforeStart() async {
        await performAbortBeforeStart()
    }

    private func performAbortBeforeStart() async {
        interruptionReporter.seal()
        // A constructed recorder that was never handed to `startCapture` has
        // no live stream to stop. Once a start was attempted, only the bounded
        // callback stop establishes the native stream boundary.
        if cleanupLease.wasStartAttempted {
            await stopStream(
                subject: "failed-start display \(geometry.displayId) abort",
                timeoutNanoseconds: 5_000_000_000,
                fallbackCode: "screen-start-abort-stop-failed"
            )
        }
        let recordingOutputRemovalSucceeded: Bool
        do {
            try stream.removeRecordingOutput(recordingOutput)
            recordingOutputRemovalSucceeded = true
        } catch {
            appendDiagnostic(
                code: "screen-recording-output-remove-failed",
                message: error.localizedDescription,
                recoverable: false
            )
            recordingOutputRemovalSucceeded = false
        }
        detachTimingOutputs()
        await closeAndDrainTimingQueue()

        let cleanupDecision = cleanupLease.sealFailedStart(
            recordingOutputRemovalSucceeded:
                recordingOutputRemovalSucceeded,
            nativeMediaEvidence: recordingOutputHasNativeMediaEvidence,
            fileEvidence: FileManager.default.fileExists(
                atPath: outputURL.path
            )
        )
        if case .failClosed = cleanupDecision {
            // Secure an already-created partial before enforcing an output
            // removal failure. The 0700 parent remains the fallback if native
            // code has not published the file yet.
            secureRetainedOutputOrFailClosed()
        }
        _ = await resolveCleanupDecision(
            cleanupDecision,
            timeoutNanoseconds: 15_000_000_000
        )
        secureRetainedOutputOrFailClosed()
        enforceCleanupDecision(cleanupLease.completeCleanup(
            nativeMediaEvidence: recordingOutputHasNativeMediaEvidence,
            fileEvidence: FileManager.default.fileExists(atPath: outputURL.path)
        ))
    }

    private func startStream(
        subject: String,
        timeoutNanoseconds: UInt64
    ) async {
        let outcome: CaptureBoundedCallbackWaitResult<
            Void,
            CaptureNativeStartCallbackFailure
        > = await CaptureBoundedCallbackWaiter.wait(
            label: subject,
            timeoutNanoseconds: timeoutNanoseconds,
            timeoutAction: { timeout in
                captureExit70AfterCleanupFailure(
                    CaptureCleanupFailClosedIncident(
                        kind: .streamStartTimeout,
                        subject: timeout.label,
                        detail: "The native start callback missed its \(timeout.timeoutNanoseconds / 1_000_000)-millisecond deadline."
                    )
                )
            },
            start: { [self] completion in
                stream.startCapture { error in
                    if let error {
                        let boundedMessage = bounded(
                            error.localizedDescription,
                            maximumUTF8Bytes: 320
                        )
                        completion(.failure(CaptureNativeStartCallbackFailure(
                            code: "screen-start-failed",
                            message: boundedMessage.isEmpty
                                ? "The native stream start callback failed."
                                : boundedMessage
                        )))
                    } else {
                        completion(.success(()))
                    }
                }
            }
        )
        switch captureStreamStartDisposition(outcome, subject: subject) {
        case .started:
            return
        case .failClosed(let incident):
            failClosed(incident)
        }
    }

    private func stopStream(
        subject: String,
        timeoutNanoseconds: UInt64,
        fallbackCode: String
    ) async {
        let outcome: CaptureBoundedCallbackWaitResult<
            Void,
            CaptureNativeStopCallbackFailure
        > = await CaptureBoundedCallbackWaiter.wait(
            label: subject,
            timeoutNanoseconds: timeoutNanoseconds,
            timeoutAction: { timeout in
                captureExit70AfterCleanupFailure(
                    CaptureCleanupFailClosedIncident(
                        kind: .streamStopTimeout,
                        subject: timeout.label,
                        detail: "The native stop callback missed its \(timeout.timeoutNanoseconds / 1_000_000)-millisecond deadline."
                    )
                )
            },
            start: { [self] completion in
                stream.stopCapture { error in
                    if let error {
                        let boundedMessage = bounded(
                            error.localizedDescription,
                            maximumUTF8Bytes: 320
                        )
                        completion(.failure(CaptureNativeStopCallbackFailure(
                            code: fallbackCode,
                            message: boundedMessage.isEmpty
                                ? "The native stream stop callback failed."
                                : boundedMessage
                        )))
                    } else {
                        completion(.success(()))
                    }
                }
            }
        )
        switch captureStreamStopDisposition(outcome, subject: subject) {
        case .stopped:
            return
        case .failClosed(let incident):
            failClosed(incident)
        }
    }

    private func resolveCleanupDecision(
        _ decision: CaptureRecordingCleanupDecision,
        timeoutNanoseconds: UInt64
    ) async -> DisplayRecorderFailure? {
        switch await captureJoinRecordingCleanup(
            decision: decision,
            terminalBarrier: muxTerminalBarrier,
            timeoutNanoseconds: timeoutNanoseconds
        ) {
        case .inactive, .success:
            return nil
        case .failure(let failure):
            return failure
        case .timedOut:
            // The private session directory already contains the partial, but
            // tighten its file mode before terminating when possible.
            secureRetainedOutputOrFailClosed()
            failClosed(cleanupLease.finalizationTimedOut())
        case .failClosed(let incident):
            failClosed(incident)
        }
    }

    private var recordingOutputHasNativeMediaEvidence: Bool {
        let duration = recordingOutput.recordedDuration
        return recordingOutput.recordedFileSize > 0
            || (duration.isValid && CMTimeCompare(duration, .zero) > 0)
    }

    private func secureRetainedOutputOrFailClosed() {
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            return
        }
        do {
            try secureFinalizedCaptureFile(outputURL)
        } catch {
            failClosed(cleanupLease.outputSecurityFailed())
        }
        if let lateFileIncident = cleanupLease.observeLateFileEvidence() {
            failClosed(lateFileIncident)
        }
    }

    private func enforceCleanupDecision(
        _ decision: CaptureRecordingCleanupDecision
    ) {
        if case .failClosed(let incident) = decision {
            failClosed(incident)
        }
    }

    private func failClosed(
        _ incident: CaptureCleanupFailClosedIncident
    ) -> Never {
        captureApplyFailClosed(
            incident,
            action: captureExit70AfterCleanupFailure
        )
        fatalError("A fail-closed capture cleanup action returned.")
    }

    var diagnostics: [CaptureDiagnostic] {
        diagnosticLock.lock()
        defer { diagnosticLock.unlock() }
        return storedDiagnostics
    }

    private func appendDiagnostic(code: String, message: String, recoverable: Bool) {
        diagnosticLock.lock()
        storedDiagnostics.append(CaptureDiagnostic(code: code, message: message, recoverable: recoverable, source: "screen"))
        diagnosticLock.unlock()
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        guard recordingOutput === self.recordingOutput else { return }
        if let incident = cleanupLease.observeRecordingStart() {
            failClosed(incident)
        }
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        guard recordingOutput === self.recordingOutput else { return }
        resolveFinalization(failureMessage: nil)
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: any Error) {
        guard recordingOutput === self.recordingOutput else { return }
        appendDiagnostic(code: "screen-recording-failed", message: error.localizedDescription, recoverable: false)
        resolveFinalization(failureMessage: error.localizedDescription)
    }

    private func resolveFinalization(failureMessage: String?) {
        let cleanupIncident = cleanupLease.observeRecordingFinalization()
        let outcome: Result<Void, DisplayRecorderFailure>
        if let failureMessage {
            outcome = .failure(DisplayRecorderFailure(
                code: "screen-recording-failed",
                message: failureMessage,
                recoverable: false
            ))
        } else {
            outcome = .success(())
        }
        let publication = capturePublishTerminalBeforeInterruption(
            publish: { [muxTerminalBarrier] in
                muxTerminalBarrier.publish(outcome)
            },
            reporter: interruptionReporter,
            incident: .screen(.recordingFailed),
            sourceId: geometry.identifier
        )
        guard case .published = publication else {
            failClosed(CaptureCleanupFailClosedIncident(
                kind: .lateRecordingActivity,
                subject: "display \(geometry.displayId)",
                detail: "The recording output published more than one terminal mux callback."
            ))
        }
        if let cleanupIncident {
            failClosed(cleanupIncident)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        guard stream === self.stream else { return }
        appendDiagnostic(code: "screen-stream-stopped", message: error.localizedDescription, recoverable: true)
        _ = interruptionReporter.report(
            incident: .screen(.streamStopped),
            sourceId: geometry.identifier
        )
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard acceptsTimingSamples else { return }
        switch outputType {
        case .screen:
            guard timedScreenSample(sampleBuffer) else { return }
            videoTiming.observe(sampleBuffer, synchronizationClock: stream.synchronizationClock)
        case .audio:
            audioTiming.observe(sampleBuffer, synchronizationClock: stream.synchronizationClock)
        case .microphone:
            return
        @unknown default:
            return
        }
    }

    private func detachTimingOutputs() {
        do {
            try stream.removeStreamOutput(self, type: .screen)
        } catch {
            appendDiagnostic(
                code: "screen-timing-output-remove-failed",
                message: error.localizedDescription,
                recoverable: true
            )
        }
        if includesSystemAudio {
            do {
                try stream.removeStreamOutput(self, type: .audio)
            } catch {
                appendDiagnostic(
                    code: "system-audio-timing-output-remove-failed",
                    message: error.localizedDescription,
                    recoverable: true
                )
            }
        }
    }

    private func closeAndDrainTimingQueue() async {
        await withCheckedContinuation { continuation in
            timingQueue.async {
                self.acceptsTimingSamples = false
                continuation.resume()
            }
        }
    }
}

struct DisplayRecordingCompletion: @unchecked Sendable {
    // `streams` is an immutable, helper-owned JSON value graph assembled before
    // this completion crosses the single-flight boundary.
    let geometry: DisplayGeometry
    let relativePath: String
    let containerDurationUs: UInt64
    let streams: [[String: Any]]
    let diagnostics: [CaptureDiagnostic]

    var json: [String: Any] {
        return [
            "container": "mp4",
            "display": geometry.json,
            "containerDurationUs": containerDurationUs,
            "path": relativePath,
            "streams": streams,
        ]
    }
}

struct SelectedScreenDisplay: @unchecked Sendable {
    let display: SCDisplay
    let isPrimary: Bool
}

struct ScreenSourceSelection: @unchecked Sendable {
    let displays: [SelectedScreenDisplay]
    let excludedApplications: [SCRunningApplication]
}

struct ResolvedCaptureSources: @unchecked Sendable {
    let camera: AVCaptureDevice?
    let microphone: AVCaptureDevice?
    let screen: ScreenSourceSelection

    func inventoryJSON(systemAudioRequested: Bool) -> [String: Any] {
        var audio: [[String: Any]] = []
        if systemAudioRequested {
            audio.append([
                "audioSourceId": "system-audio",
                "channels": 2,
                "kind": "system",
                "label": "System audio",
                "sampleRateHz": 48_000,
            ])
        }
        if let microphone {
            audio.append(audioSourceJSON(device: microphone))
        }
        return [
            "audio": audio,
            "cameras": camera.map { [cameraSourceJSON(device: $0)] } ?? [],
            "displays": screen.displays.map {
                DisplayGeometry(
                    display: $0.display,
                    isPrimary: $0.isPrimary
                ).topologyJSON
            },
        ]
    }
}

func resolveCaptureSources(options: CaptureOptions) async throws -> ResolvedCaptureSources {
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        )
    } catch {
        throw HelperFailure(
            code: "screen-content-unavailable",
            message: error.localizedDescription,
            recoverable: true
        )
    }
    let available = content.displays.sorted { lhs, rhs in
        let lhsMain = CGDisplayIsMain(lhs.displayID) != 0
        let rhsMain = CGDisplayIsMain(rhs.displayID) != 0
        if lhsMain != rhsMain { return lhsMain }
        return lhs.displayID < rhs.displayID
    }
    let selected: [SCDisplay]
    switch options.displays {
    case .all:
        guard available.count <= 16 else {
            throw HelperFailure(
                code: "too-many-displays",
                message: "At most 16 displays can be recorded.",
                recoverable: true
            )
        }
        selected = available
    case .selected(let displayIds):
        let byId = Dictionary(uniqueKeysWithValues: available.map {
            (String($0.displayID), $0)
        })
        selected = try displayIds.map { displayId in
            guard let display = byId[displayId] else {
                throw HelperFailure(
                    code: "display-unknown",
                    message: "Selected display ID \(displayId) is not available to ScreenCaptureKit.",
                    recoverable: true
                )
            }
            return display
        }
    }
    guard !selected.isEmpty else {
        throw HelperFailure(
            code: "no-displays",
            message: "ScreenCaptureKit reported no selected connected displays.",
            recoverable: true
        )
    }
    let ordered = selected.sorted { lhs, rhs in
        let lhsMain = CGDisplayIsMain(lhs.displayID) != 0
        let rhsMain = CGDisplayIsMain(rhs.displayID) != 0
        if lhsMain != rhsMain { return lhsMain }
        return lhs.displayID < rhs.displayID
    }
    let excluded = content.applications.filter { application in
        application.processID == getpid()
            || options.excludedBundleIdentifiers.contains(application.bundleIdentifier)
    }
    return ResolvedCaptureSources(
        camera: try selectedDevice(options.camera, mediaType: .video, label: "camera"),
        microphone: try selectedDevice(
            options.microphone,
            mediaType: .audio,
            label: "microphone"
        ),
        screen: ScreenSourceSelection(
            displays: ordered.enumerated().map { index, display in
                SelectedScreenDisplay(display: display, isPrimary: index == 0)
            },
            excludedApplications: excluded
        )
    )
}

final class ScreenSegmentRecorder: @unchecked Sendable {
    private let recorders: [DisplayRecorder]
    private let interruptionReporter: CaptureInterruptionReporter
    private let displayInterruptionMonitor:
        CaptureDisplayInterruptionMonitor
    private let stopFlight =
        CaptureSingleFlight<[DisplayRecordingCompletion], DisplayRecorderFailure>()
    let displaySources: [DisplayGeometry]
    let systemAudioEnabled: Bool

    var audioSourcesJSON: [[String: Any]] {
        var sources: [[String: Any]] = []
        if systemAudioEnabled {
            sources.append([
                "audioSourceId": "system-audio",
                "channels": 2,
                "kind": "system",
                "label": "System audio",
                "sampleRateHz": 48_000,
            ])
        }
        return sources
    }

    private init(
        recorders: [DisplayRecorder],
        displaySources: [DisplayGeometry],
        systemAudioEnabled: Bool,
        interruptionReporter: CaptureInterruptionReporter,
        displayInterruptionMonitor: CaptureDisplayInterruptionMonitor
    ) {
        self.recorders = recorders
        self.displaySources = displaySources
        self.systemAudioEnabled = systemAudioEnabled
        self.interruptionReporter = interruptionReporter
        self.displayInterruptionMonitor = displayInterruptionMonitor
    }

    static func start(
        session: SessionDirectory,
        segmentIndex: Int,
        options: CaptureOptions,
        permissions: PermissionSnapshot,
        sources: ScreenSourceSelection,
        interruptionReporter: CaptureInterruptionReporter
    ) async throws -> ScreenSegmentRecorder {
        let systemAudioEnabled = options.systemAudio && permissions.systemAudio == .authorized
        var recorders: [DisplayRecorder] = []
        let segmentDirectory = String(format: "segments/segment_%04d", segmentIndex + 1)
        do {
            try session.prepareDirectory(segmentDirectory)
            for (position, selectedDisplay) in sources.displays.enumerated() {
                let display = selectedDisplay.display
                let relativePath = String(
                    format: "%@/display_%u.mp4",
                    segmentDirectory,
                    display.displayID
                )
                let outputURL = try session.outputURL(relativePath)
                recorders.append(try DisplayRecorder(
                    display: display,
                    isPrimary: selectedDisplay.isPrimary,
                    excludedApplications: sources.excludedApplications,
                    relativePath: relativePath,
                    outputURL: outputURL,
                    includesSystemAudio: position == 0 && systemAudioEnabled,
                    metadataEnabled: options.metadata
                        && permissions.inputMonitoring == .authorized,
                    interruptionReporter: interruptionReporter
                ))
            }
        } catch {
            await withTaskGroup(of: Void.self) { group in
                for recorder in recorders {
                    group.addTask { await recorder.abortBeforeStart() }
                }
            }
            throw HelperFailure(code: "screen-start-failed", message: error.localizedDescription, recoverable: true)
        }

        let displayInterruptionMonitor =
            CaptureDisplayInterruptionMonitor(
                selected: sources.displays.map {
                    CaptureSelectedDisplayIdentity(
                        displayId: $0.display.displayID,
                        isPrimary: $0.isPrimary
                    )
                },
                reporter: interruptionReporter
            )
        do {
            try displayInterruptionMonitor.startObserving()
        } catch {
            interruptionReporter.seal()
            await withTaskGroup(of: Void.self) { group in
                for recorder in recorders {
                    group.addTask { await recorder.abortBeforeStart() }
                }
            }
            throw HelperFailure(
                code: "screen-display-monitor-failed",
                message: "Selected display changes could not be monitored.",
                recoverable: true
            )
        }

        let startOutcomes = await withTaskGroup(
            of: DisplayStartOutcome.self,
            returning: [DisplayStartOutcome].self
        ) { group in
            for recorder in recorders {
                group.addTask {
                    do {
                        try await recorder.start()
                        return DisplayStartOutcome(recorder: recorder, result: .success(()))
                    } catch {
                        return DisplayStartOutcome(
                            recorder: recorder,
                            result: .failure(DisplayRecorderFailure(
                                error: error,
                                fallbackCode: "screen-start-failed",
                                recoverable: true
                            ))
                        )
                    }
                }
            }
            var outcomes: [DisplayStartOutcome] = []
            for await outcome in group {
                outcomes.append(outcome)
            }
            return outcomes.sorted {
                $0.recorder.geometry.displayId < $1.recorder.geometry.displayId
            }
        }
        let failedStarts = startOutcomes.filter {
            if case .failure = $0.result { return true }
            return false
        }
        if !failedStarts.isEmpty {
            interruptionReporter.seal()
            await withTaskGroup(of: Void.self) { group in
                for outcome in startOutcomes {
                    switch outcome.result {
                    case .success:
                        group.addTask { _ = await outcome.recorder.stopResult() }
                    case .failure:
                        group.addTask { await outcome.recorder.abortBeforeStart() }
                    }
                }
            }
            guard let lowestDisplayFailure = failedStarts.first else {
                preconditionFailure("A nonempty display failure set must have a first value.")
            }
            let selectedFailure = failedStarts.first {
                $0.recorder.geometry.isPrimary
            } ?? lowestDisplayFailure
            guard case .failure(let failure) = selectedFailure.result else {
                preconditionFailure("A selected failed display start must contain a failure.")
            }
            throw HelperFailure(
                code: "screen-start-failed",
                message: failure.message,
                recoverable: true
            )
        }

        return ScreenSegmentRecorder(
            recorders: recorders,
            displaySources: recorders.map(\.geometry),
            systemAudioEnabled: systemAudioEnabled,
            interruptionReporter: interruptionReporter,
            displayInterruptionMonitor: displayInterruptionMonitor
        )
    }

    func stop() async throws -> [DisplayRecordingCompletion] {
        interruptionReporter.seal()
        displayInterruptionMonitor.invalidate()
        switch await stopFlight.run({ [self] in await performStop() }) {
        case .success(let completions):
            return completions
        case .failure(let failure):
            throw failure.helperFailure
        }
    }

    private func performStop()
        async -> Result<[DisplayRecordingCompletion], DisplayRecorderFailure>
    {
        let operations = recorders.map { recorder in
            CaptureIndexedDrainOperation(
                index: recorder.geometry.displayId,
                isPrimary: recorder.geometry.isPrimary,
                operation: { await recorder.stopResult() }
            )
        }
        let outcomes = await captureDrainIndexed(operations)
        if let failure = capturePreferredDrainFailure(outcomes) {
            return .failure(failure)
        }
        return .success(outcomes.compactMap {
            if case .success(let completion) = $0.result { return completion }
            return nil
        })
    }
}

struct CameraRecordingCompletion: @unchecked Sendable {
    // `streams` is an immutable, helper-owned JSON value graph assembled before
    // this completion crosses the single-flight boundary.
    let availability: String
    let reason: String?
    let relativePath: String?
    let containerDurationUs: UInt64
    let deviceId: String?
    let label: String?
    let streams: [[String: Any]]
    let diagnostics: [CaptureDiagnostic]

    static func unavailable(_ reason: String, diagnostics: [CaptureDiagnostic] = []) -> CameraRecordingCompletion {
        CameraRecordingCompletion(
            availability: "unavailable",
            reason: reason,
            relativePath: nil,
            containerDurationUs: 0,
            deviceId: nil,
            label: nil,
            streams: [],
            diagnostics: diagnostics
        )
    }

    var json: [String: Any] {
        guard availability == "recorded", let relativePath, let deviceId, let label else {
            return ["availability": "unavailable", "reason": reason ?? "start-failed"]
        }
        return [
            "availability": "recorded",
            "container": "mov",
            "deviceId": bounded(deviceId, maximumUTF8Bytes: 256),
            "containerDurationUs": containerDurationUs,
            "label": bounded(label, maximumUTF8Bytes: 512),
            "path": relativePath,
            "streams": streams,
        ]
    }
}

private func failClosedCaptureProcess(
    _ incident: CaptureCleanupFailClosedIncident
) -> Never {
    captureApplyFailClosed(
        incident,
        action: captureExit70AfterCleanupFailure
    )
    fatalError("A fail-closed capture action returned.")
}

private func captureSessionStopDeadlineWatchdog(
    subject: String
) -> CaptureProcessDeadlineWatchdog {
    CaptureProcessDeadlineWatchdog(
        label: subject,
        timeoutNanoseconds: 15_000_000_000,
        timeoutAction: { timeout in
            failClosedCaptureProcess(
                CaptureCleanupFailClosedIncident(
                    kind: .sessionStopTimeout,
                    subject: timeout.label,
                    detail: "AVCaptureSession.stopRunning() missed its \(timeout.timeoutNanoseconds / 1_000_000)-millisecond deadline."
                )
            )
        }
    )
}

private final class MediaFileDelegate:
    NSObject,
    AVCaptureFileOutputDelegate,
    AVCaptureFileOutputRecordingDelegate,
    @unchecked Sendable
{
    private enum Phase {
        case idle
        case armed
        case starting
        case recording
        case stopPending
        case finishing
        case finished
    }

    private enum StopPreparation {
        case alreadyFinishing
        case fallback
        case waitForSample
    }

    private let lock = NSLock()
    private let cleanupLease: CaptureRecordingCleanupLease
    private let expectedOutput: AVCaptureFileOutput
    private let interruptionReporter: CaptureInterruptionReporter
    private let recordingFailureIncident: CaptureInterruptionIncident
    private let interruptionSourceId: String
    private let terminalBarrier =
        CaptureMuxTerminalBarrier<CaptureNativeFileFinalizationFailure>()
    private var finishedError: CaptureNativeFileFinalizationFailure?
    private var finished = false
    private var failedStartCleanupActive = false
    private var failedStartStopAction: (() -> Void)?
    private var startResolved = false
    private var started = false
    private var phase: Phase = .idle
    private var startAction: (() -> Void)?
    private var synchronizationClock: (() -> CMClock?)?
    private var fallbackStopUsed = false
    private var interruptionReportingEnabled = true
    private let timing = SampleTimingAccumulator()
    private let startSemaphore = DispatchSemaphore(value: 0)
    private let stopIssuedSemaphore = DispatchSemaphore(value: 0)

    init(
        subject: String,
        expectedOutput: AVCaptureFileOutput,
        interruptionReporter: CaptureInterruptionReporter,
        recordingFailureIncident: CaptureInterruptionIncident,
        interruptionSourceId: String
    ) {
        cleanupLease = CaptureRecordingCleanupLease(subject: subject)
        self.expectedOutput = expectedOutput
        self.interruptionReporter = interruptionReporter
        self.recordingFailureIncident = recordingFailureIncident
        self.interruptionSourceId = interruptionSourceId
        super.init()
    }

    func sealInterruptionReporting() {
        lock.lock()
        interruptionReportingEnabled = false
        lock.unlock()
    }

    func arm(
        synchronizationClock: @escaping () -> CMClock?,
        startAction: @escaping () -> Void
    ) {
        lock.lock()
        precondition(phase == .idle)
        self.synchronizationClock = synchronizationClock
        self.startAction = startAction
        phase = .armed
        lock.unlock()
    }

    func beginFailedStartCleanup(
        stopAction: @escaping () -> Void
    ) -> CaptureRecordingCleanupDecision {
        var immediateStopAction: (() -> Void)?
        lock.lock()
        failedStartCleanupActive = true
        failedStartStopAction = stopAction
        if phase != .finished {
            phase = .finishing
        }
        startAction = nil
        synchronizationClock = nil
        let decision = cleanupLease.sealFailedStart(
            recordingOutputRemovalSucceeded: true,
            nativeMediaEvidence: started,
            fileEvidence: false
        )
        if started, !finished {
            immediateStopAction = failedStartStopAction
            failedStartStopAction = nil
        }
        lock.unlock()
        immediateStopAction?()
        return decision
    }

    func requestFailedStartStopForNativeEvidence() {
        var action: (() -> Void)?
        lock.lock()
        if failedStartCleanupActive, !finished {
            action = failedStartStopAction
            failedStartStopAction = nil
        }
        lock.unlock()
        action?()
    }

    func joinFailedStartCleanup(
        _ decision: CaptureRecordingCleanupDecision,
        timeoutNanoseconds: UInt64
    ) async -> CaptureRecordingCleanupJoinResult<
        CaptureNativeFileFinalizationFailure
    > {
        await captureJoinRecordingCleanup(
            decision: decision,
            terminalBarrier: terminalBarrier,
            timeoutNanoseconds: timeoutNanoseconds
        )
    }

    func completeFailedStartCleanup(
        nativeMediaEvidence: Bool,
        fileEvidence: Bool
    ) -> CaptureRecordingCleanupDecision {
        cleanupLease.completeCleanup(
            nativeMediaEvidence: nativeMediaEvidence,
            fileEvidence: fileEvidence
        )
    }

    func observeLateFileEvidence() -> CaptureCleanupFailClosedIncident? {
        cleanupLease.observeLateFileEvidence()
    }

    func failedStartFinalizationTimedOut()
        -> CaptureCleanupFailClosedIncident
    {
        cleanupLease.finalizationTimedOut()
    }

    func outputSecurityFailed() -> CaptureCleanupFailClosedIncident {
        cleanupLease.outputSecurityFailed()
    }

    func fileOutputShouldProvideSampleAccurateRecordingStart(_ output: AVCaptureFileOutput) -> Bool {
        true
    }

    func captureOutput(
        _ output: AVCaptureFileOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard output === expectedOutput else { return }
        var action: (() -> Void)?
        var clock: CMClock?
        var shouldObserve = false
        var shouldStop = false
        lock.lock()
        switch phase {
        case .armed:
            phase = .starting
            // This is the exact escape boundary: cleanup can no longer prove
            // inactivity without joining a terminal file-output callback.
            cleanupLease.markStartAttempted()
            action = startAction
            startAction = nil
            clock = synchronizationClock?()
            shouldObserve = true
        case .starting, .recording:
            clock = synchronizationClock?()
            shouldObserve = true
        case .stopPending:
            // AVCaptureFileOutput guarantees that stopRecording invoked from
            // this callback writes the samples immediately preceding this one.
            // The current buffer is deliberately not included in timing.
            phase = .finishing
            shouldStop = true
        case .idle, .finishing, .finished:
            break
        }
        lock.unlock()
        if shouldObserve {
            timing.observe(sampleBuffer, synchronizationClock: clock)
        }
        action?()
        if shouldStop {
            output.stopRecording()
            stopIssuedSemaphore.signal()
        }
    }

    func waitForStart() async -> (
        started: Bool,
        finished: Bool,
        error: CaptureNativeFileFinalizationFailure?
    ) {
        _ = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: self.startSemaphore.wait(timeout: .now() + 10) == .success)
            }
        }
        return startSnapshot()
    }

    private func startSnapshot() -> (
        started: Bool,
        finished: Bool,
        error: CaptureNativeFileFinalizationFailure?
    ) {
        lock.lock()
        defer { lock.unlock() }
        return (started, finished, finishedError)
    }

    func requestSampleAccurateStop() async -> Bool {
        switch prepareStopRequest() {
        case .alreadyFinishing:
            return true
        case .fallback:
            return false
        case .waitForSample:
            break
        }
        let issued = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: self.stopIssuedSemaphore.wait(timeout: .now() + 1) == .success)
            }
        }
        if issued { return true }
        return markStopFallbackAfterTimeout()
    }

    private func prepareStopRequest() -> StopPreparation {
        lock.lock()
        defer { lock.unlock() }
        if phase == .starting || phase == .recording {
            phase = .stopPending
            return .waitForSample
        } else if phase == .finished || phase == .finishing {
            return .alreadyFinishing
        } else {
            fallbackStopUsed = true
            phase = .finishing
            return .fallback
        }
    }

    private func markStopFallbackAfterTimeout() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if phase == .stopPending {
            fallbackStopUsed = true
            phase = .finishing
            return false
        }
        return phase == .finishing || phase == .finished
    }

    var usedFallbackStop: Bool {
        lock.lock()
        defer { lock.unlock() }
        return fallbackStopUsed
    }

    func finishTiming(finalizedTimingFallback: FileSampleTiming) throws -> MediaSampleTiming {
        try timing.finish(finalizedTimingFallback: finalizedTimingFallback)
    }

    func waitForFinish() async -> (
        finished: Bool,
        error: CaptureNativeFileFinalizationFailure?
    ) {
        switch await terminalBarrier.wait(
            timeoutNanoseconds: 15_000_000_000
        ) {
        case .success:
            return (true, nil)
        case .failure(let failure):
            return (true, failure)
        case .timedOut:
            return (false, nil)
        }
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: (any Error)?
    ) {
        guard output === expectedOutput else { return }
        var signalStart = false
        var signalStop = false
        var shouldReportInterruption = false
        let terminalFailure: CaptureNativeFileFinalizationFailure?
        let cleanupIncident: CaptureCleanupFailClosedIncident?
        lock.lock()
        let unexpectedFinish =
            phase == .armed
                || phase == .starting
                || phase == .recording
        finished = true
        signalStop = phase == .stopPending
        phase = .finished
        startAction = nil
        synchronizationClock = nil
        failedStartStopAction = nil
        cleanupIncident = cleanupLease.observeRecordingFinalization()
        if cleanupIncident == nil {
            let successfulDespiteError = (error as NSError?)?
                .userInfo[AVErrorRecordingSuccessfullyFinishedKey]
                as? Bool == true
            terminalFailure = successfulDespiteError
                ? nil
                : error.map(Self.finalizationFailure)
            finishedError = terminalFailure
            shouldReportInterruption =
                interruptionReportingEnabled
                    && (unexpectedFinish || terminalFailure != nil)
            if !startResolved {
                startResolved = true
                signalStart = true
            }
        } else {
            terminalFailure = nil
        }
        lock.unlock()

        guard capturePassImmediateFailClosedGate(
            cleanupIncident,
            action: captureExit70AfterCleanupFailure
        ) else {
            fatalError(
                "A late AVFoundation terminal callback returned after failing closed."
            )
        }
        let terminalOutcome: Result<
            Void,
            CaptureNativeFileFinalizationFailure
        > = terminalFailure.map(Result.failure) ?? .success(())
        let terminalPublished: Bool
        if shouldReportInterruption {
            let publication = capturePublishTerminalBeforeInterruption(
                publish: { [terminalBarrier] in
                    terminalBarrier.publish(terminalOutcome)
                },
                reporter: interruptionReporter,
                incident: recordingFailureIncident,
                sourceId: interruptionSourceId
            )
            if case .published = publication {
                terminalPublished = true
            } else {
                terminalPublished = false
            }
        } else {
            terminalPublished = terminalBarrier.publish(terminalOutcome)
        }
        guard terminalPublished else {
            failClosedCaptureProcess(CaptureCleanupFailClosedIncident(
                kind: .lateRecordingActivity,
                subject: "AVFoundation file output",
                detail: "The file output published more than one terminal callback."
            ))
        }
        if signalStart { startSemaphore.signal() }
        if signalStop { stopIssuedSemaphore.signal() }
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        from connections: [AVCaptureConnection]
    ) {
        guard output === expectedOutput else { return }
        resolveStart()
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        startPTS: CMTime,
        from connections: [AVCaptureConnection]
    ) {
        guard output === expectedOutput else { return }
        resolveStart()
    }

    private func resolveStart() {
        var signalStart = false
        var cleanupStopAction: (() -> Void)?
        let cleanupIncident: CaptureCleanupFailClosedIncident?
        lock.lock()
        started = true
        cleanupIncident = cleanupLease.observeRecordingStart()
        if cleanupIncident == nil {
            if failedStartCleanupActive {
                cleanupStopAction = failedStartStopAction
                failedStartStopAction = nil
                if phase != .finished { phase = .finishing }
            } else if phase == .starting {
                phase = .recording
            }
            if !startResolved {
                startResolved = true
                signalStart = true
            }
        }
        lock.unlock()
        guard capturePassImmediateFailClosedGate(
            cleanupIncident,
            action: captureExit70AfterCleanupFailure
        ) else {
            fatalError(
                "A late AVFoundation start callback returned after failing closed."
            )
        }
        cleanupStopAction?()
        if signalStart { startSemaphore.signal() }
    }

    private static func finalizationFailure(
        _ error: any Error
    ) -> CaptureNativeFileFinalizationFailure {
        let nativeError = error as NSError
        let code = bounded(
            "\(nativeError.domain)#\(nativeError.code)",
            maximumUTF8Bytes: 128
        )
        let nativeMessage = bounded(
            nativeError.localizedDescription,
            maximumUTF8Bytes: 320
        )
        return CaptureNativeFileFinalizationFailure(
            code: code.isEmpty ? "avfoundation-finalization-failed" : code,
            message: nativeMessage.isEmpty
                ? "AVFoundation file finalization failed."
                : nativeMessage
        )
    }
}

final class CameraSegmentRecorder: @unchecked Sendable {
    let relativePath: String
    private let outputURL: URL
    private let device: AVCaptureDevice
    private let session: AVCaptureSession
    private let output: AVCaptureMovieFileOutput
    private let delegate: MediaFileDelegate
    private let interruptionReporter: CaptureInterruptionReporter
    private let interruptionMonitor: CaptureAVInterruptionMonitor
    private let sessionQueue = DispatchQueue(label: "com.hraness.atet.capture.camera")
    private let stopFlight = CaptureSingleFlight<CameraRecordingCompletion, Never>()
    let sourceJSON: [String: Any]

    private init(
        relativePath: String,
        outputURL: URL,
        device: AVCaptureDevice,
        session: AVCaptureSession,
        output: AVCaptureMovieFileOutput,
        delegate: MediaFileDelegate,
        interruptionReporter: CaptureInterruptionReporter,
        interruptionMonitor: CaptureAVInterruptionMonitor
    ) {
        self.relativePath = relativePath
        self.outputURL = outputURL
        self.device = device
        self.session = session
        self.output = output
        self.delegate = delegate
        self.interruptionReporter = interruptionReporter
        self.interruptionMonitor = interruptionMonitor
        sourceJSON = cameraSourceJSON(device: device)
    }

    static func start(
        sessionDirectory: SessionDirectory,
        segmentIndex: Int,
        device: AVCaptureDevice,
        interruptionReporter: CaptureInterruptionReporter
    ) async throws -> CameraSegmentRecorder {
        let segmentDirectory = String(format: "segments/segment_%04d", segmentIndex + 1)
        try sessionDirectory.prepareDirectory(segmentDirectory)
        let relativePath = "\(segmentDirectory)/camera_\(safeFileComponent(device.uniqueID)).mov"
        let outputURL = try sessionDirectory.outputURL(relativePath)
        let captureSession = AVCaptureSession()
        let movieOutput = AVCaptureMovieFileOutput()
        let delegate = MediaFileDelegate(
            subject: "camera segment \(segmentIndex + 1)",
            expectedOutput: movieOutput,
            interruptionReporter: interruptionReporter,
            recordingFailureIncident: .camera(.recordingFailed),
            interruptionSourceId: device.uniqueID
        )
        do {
            let input = try AVCaptureDeviceInput(device: device)
            captureSession.beginConfiguration()
            captureSession.sessionPreset = .high
            guard captureSession.canAddInput(input), captureSession.canAddOutput(movieOutput) else {
                captureSession.commitConfiguration()
                throw HelperFailure(code: "camera-configuration-failed", message: "The selected camera cannot be attached to the capture session.", recoverable: true)
            }
            captureSession.addInput(input)
            captureSession.addOutput(movieOutput)
            captureSession.commitConfiguration()
            movieOutput.delegate = delegate
            if let connection = movieOutput.connection(with: .video) {
                movieOutput.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: connection)
            }
        } catch let failure as HelperFailure {
            throw failure
        } catch {
            throw HelperFailure(code: "camera-configuration-failed", message: error.localizedDescription, recoverable: true)
        }
        let interruptionMonitor = CaptureAVInterruptionMonitor(
            role: .camera,
            sourceId: device.uniqueID,
            device: device,
            session: captureSession,
            reporter: interruptionReporter
        )
        let recorder = CameraSegmentRecorder(
            relativePath: relativePath,
            outputURL: outputURL,
            device: device,
            session: captureSession,
            output: movieOutput,
            delegate: delegate,
            interruptionReporter: interruptionReporter,
            interruptionMonitor: interruptionMonitor
        )
        interruptionMonitor.startObserving()
        try await recorder.startRunning()
        return recorder
    }

    private func startRunning() async throws {
        delegate.arm(
            synchronizationClock: { [weak session] in session?.synchronizationClock },
            startAction: { [weak output, weak delegate, outputURL] in
                guard let output, let delegate else { return }
                output.startRecording(to: outputURL, recordingDelegate: delegate)
            }
        )

        let sessionStarted = await startSessionWithWatchdog()
        guard sessionStarted else {
            let cleanupFailure = await stopAfterFailedStart()
            throw HelperFailure(
                code: "camera-start-failed",
                message: failedStartMessage(
                    "Camera session did not start.",
                    terminalFailure: cleanupFailure
                ),
                recoverable: true
            )
        }

        let start = await delegate.waitForStart()
        guard start.started, !start.finished else {
            let cleanupFailure = await stopAfterFailedStart()
            let message = start.error == nil
                ? "Camera recording did not begin within 10 seconds."
                : "Camera recording failed before producing media."
            throw HelperFailure(
                code: "camera-start-failed",
                message: failedStartMessage(
                    message,
                    terminalFailure: cleanupFailure ?? start.error
                ),
                recoverable: true
            )
        }
    }

    private func startSessionWithWatchdog() async -> Bool {
        let watchdog = CaptureProcessDeadlineWatchdog(
            label: "camera session start",
            timeoutNanoseconds: 15_000_000_000,
            timeoutAction: { timeout in
                failClosedCaptureProcess(
                    CaptureCleanupFailClosedIncident(
                        kind: .sessionStartTimeout,
                        subject: timeout.label,
                        detail: "AVCaptureSession.startRunning() missed its \(timeout.timeoutNanoseconds / 1_000_000)-millisecond deadline."
                    )
                )
            }
        )
        watchdog.arm()
        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                self.session.startRunning()
                let isRunning = self.session.isRunning
                if isRunning {
                    self.interruptionMonitor.confirmRunning()
                }
                guard watchdog.disarm() else {
                    fatalError(
                        "The camera start watchdog returned after failing closed."
                    )
                }
                continuation.resume(returning: isRunning)
            }
        }
    }

    private func stopAfterFailedStart() async
        -> CaptureNativeFileFinalizationFailure?
    {
        invalidateLocalInterruptionObservers()
        let decision = delegate.beginFailedStartCleanup(
            stopAction: { [weak output] in
                guard let output, output.isRecording else { return }
                output.stopRecording()
            }
        )
        let nativeMediaEvidence = await stopSessionWithWatchdog(
            subject: "camera failed-start session stop",
            prepare: { [self] in
                let wasRecording = self.output.isRecording
                if wasRecording {
                    self.delegate
                        .requestFailedStartStopForNativeEvidence()
                }
                return wasRecording || self.output.isRecording
            }
        )

        let terminalFailure: CaptureNativeFileFinalizationFailure?
        switch await delegate.joinFailedStartCleanup(
            decision,
            timeoutNanoseconds: 15_000_000_000
        ) {
        case .inactive, .success:
            terminalFailure = nil
        case .failure(let failure):
            terminalFailure = failure
        case .timedOut:
            secureFailedStartOutputOrFailClosed()
            failClosedCaptureProcess(
                delegate.failedStartFinalizationTimedOut()
            )
        case .failClosed(let incident):
            secureFailedStartOutputOrFailClosed()
            failClosedCaptureProcess(incident)
        }

        secureFailedStartOutputOrFailClosed()
        let fileEvidence = FileManager.default.fileExists(
            atPath: outputURL.path
        )
        if case .failClosed(let incident) =
            delegate.completeFailedStartCleanup(
                nativeMediaEvidence: nativeMediaEvidence,
                fileEvidence: fileEvidence
            )
        {
            failClosedCaptureProcess(incident)
        }
        return terminalFailure
    }

    private func secureFailedStartOutputOrFailClosed() {
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            return
        }
        do {
            try secureFinalizedCaptureFile(outputURL)
        } catch {
            failClosedCaptureProcess(delegate.outputSecurityFailed())
        }
        if let incident = delegate.observeLateFileEvidence() {
            failClosedCaptureProcess(incident)
        }
    }

    private func failedStartMessage(
        _ message: String,
        terminalFailure: CaptureNativeFileFinalizationFailure?
    ) -> String {
        guard let terminalFailure else { return message }
        return bounded(
            "\(message) Cleanup reached a terminal callback with \(terminalFailure.code): \(terminalFailure.message)",
            maximumUTF8Bytes: 512
        )
    }

    private func stopSessionWithWatchdog<Result: Sendable>(
        subject: String,
        prepare: @escaping @Sendable () -> Result
    ) async -> Result {
        interruptionMonitor.invalidate()
        let watchdog = captureSessionStopDeadlineWatchdog(
            subject: subject
        )
        watchdog.arm()
        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                let result = prepare()
                self.session.stopRunning()
                guard watchdog.disarm() else {
                    fatalError(
                        "The camera stop watchdog returned after failing closed."
                    )
                }
                continuation.resume(returning: result)
            }
        }
    }

    func stop() async -> CameraRecordingCompletion {
        await stopFlight.runInfallible { [self] in
            await performStop()
        }
    }

    private func performStop() async -> CameraRecordingCompletion {
        sealForTeardown()
        let sampleAccurateStop = await delegate.requestSampleAccurateStop()
        if !sampleAccurateStop {
            await withCheckedContinuation { continuation in
                sessionQueue.async {
                    if self.output.isRecording { self.output.stopRecording() }
                    continuation.resume()
                }
            }
        }
        let finalization = await delegate.waitForFinish()
        await stopSessionWithWatchdog(
            subject: "camera normal session stop",
            prepare: { () }
        )
        var diagnostics: [CaptureDiagnostic] = []
        let fallbackDiagnostic: CaptureDiagnostic? = delegate.usedFallbackStop
            ? CaptureDiagnostic(
                code: "camera-sample-stop-fallback",
                message: "Camera recording used its bounded direct-stop fallback after no sample boundary arrived within one second.",
                recoverable: true,
                source: "camera"
            )
            : nil
        if !finalization.finished {
            diagnostics.append(CaptureDiagnostic(
                code: "camera-finalization-timeout",
                message: "Camera recording did not report mux finalization within 15 seconds.",
                recoverable: true,
                source: "camera"
            ))
        }
        if finalization.error != nil {
            diagnostics.append(CaptureDiagnostic(
                code: "camera-recording-failed",
                message: "Camera recording failed while finalizing.",
                recoverable: true,
                source: "camera"
            ))
        }
        if !FileManager.default.fileExists(atPath: outputURL.path) {
            diagnostics.append(CaptureDiagnostic(
                code: "camera-output-missing",
                message: "Camera recording output was not created.",
                recoverable: true,
                source: "camera"
            ))
        }
        if FileManager.default.fileExists(atPath: outputURL.path) {
            do {
                try secureFinalizedCaptureFile(outputURL)
            } catch {
                diagnostics.append(CaptureDiagnostic(
                code: "camera-output-security-failed",
                message: "Finalized camera output could not be secured.",
                recoverable: true,
                source: "camera"
                ))
            }
        }
        if !diagnostics.isEmpty { return .unavailable("finalization-failed", diagnostics: diagnostics) }
        let inspection: AssetInspection
        do {
            inspection = try await inspectCameraAsset(
                url: outputURL,
                timingDelegate: delegate
            )
        } catch {
            return .unavailable("inspection-failed", diagnostics: [CaptureDiagnostic(
                code: "camera-asset-inspection-failed",
                message: "Finalized camera media could not be inspected.",
                recoverable: true,
                source: "camera"
            )])
        }
        return CameraRecordingCompletion(
            availability: "recorded",
            reason: nil,
            relativePath: relativePath,
            containerDurationUs: inspection.containerDurationUs,
            deviceId: device.uniqueID,
            label: device.localizedName,
            streams: inspection.streams,
            diagnostics: inspection.diagnostics + (fallbackDiagnostic.map { [$0] } ?? [])
        )
    }

    private func invalidateLocalInterruptionObservers() {
        interruptionMonitor.invalidate()
        delegate.sealInterruptionReporting()
    }

    private func sealForTeardown() {
        interruptionReporter.seal()
        invalidateLocalInterruptionObservers()
    }
}

struct MicrophoneRecordingCompletion: @unchecked Sendable {
    // `streams` is an immutable, helper-owned JSON value graph assembled before
    // this completion crosses the single-flight boundary.
    let availability: String
    let reason: String?
    let relativePath: String?
    let containerDurationUs: UInt64
    let deviceId: String?
    let label: String?
    let streams: [[String: Any]]
    let diagnostics: [CaptureDiagnostic]

    static func unavailable(_ reason: String, diagnostics: [CaptureDiagnostic] = []) -> MicrophoneRecordingCompletion {
        MicrophoneRecordingCompletion(
            availability: "unavailable",
            reason: reason,
            relativePath: nil,
            containerDurationUs: 0,
            deviceId: nil,
            label: nil,
            streams: [],
            diagnostics: diagnostics
        )
    }

    var json: [String: Any] {
        guard availability == "recorded", let relativePath, let deviceId, let label else {
            return ["availability": "unavailable", "reason": reason ?? "start-failed"]
        }
        return [
            "availability": "recorded",
            "container": "m4a",
            "deviceId": bounded(deviceId, maximumUTF8Bytes: 256),
            "containerDurationUs": containerDurationUs,
            "label": bounded(label, maximumUTF8Bytes: 512),
            "path": relativePath,
            "streams": streams,
        ]
    }
}

final class MicrophoneSegmentRecorder: @unchecked Sendable {
    let relativePath: String
    let sourceJSON: [String: Any]
    private let outputURL: URL
    private let device: AVCaptureDevice
    private let session: AVCaptureSession
    private let output: AVCaptureAudioFileOutput
    private let delegate: MediaFileDelegate
    private let interruptionReporter: CaptureInterruptionReporter
    private let interruptionMonitor: CaptureAVInterruptionMonitor
    private let sessionQueue = DispatchQueue(label: "com.hraness.atet.capture.microphone")
    private let stopFlight =
        CaptureSingleFlight<MicrophoneRecordingCompletion, Never>()

    private init(
        relativePath: String,
        outputURL: URL,
        device: AVCaptureDevice,
        session: AVCaptureSession,
        output: AVCaptureAudioFileOutput,
        delegate: MediaFileDelegate,
        interruptionReporter: CaptureInterruptionReporter,
        interruptionMonitor: CaptureAVInterruptionMonitor
    ) {
        self.relativePath = relativePath
        self.outputURL = outputURL
        self.device = device
        self.session = session
        self.output = output
        self.delegate = delegate
        self.interruptionReporter = interruptionReporter
        self.interruptionMonitor = interruptionMonitor
        sourceJSON = audioSourceJSON(device: device)
    }

    static func start(
        sessionDirectory: SessionDirectory,
        segmentIndex: Int,
        device: AVCaptureDevice,
        interruptionReporter: CaptureInterruptionReporter
    ) async throws -> MicrophoneSegmentRecorder {
        let segmentDirectory = String(format: "segments/segment_%04d", segmentIndex + 1)
        try sessionDirectory.prepareDirectory(segmentDirectory)
        let relativePath = "\(segmentDirectory)/microphone_\(safeFileComponent(device.uniqueID)).m4a"
        let outputURL = try sessionDirectory.outputURL(relativePath)
        let captureSession = AVCaptureSession()
        let audioOutput = AVCaptureAudioFileOutput()
        let delegate = MediaFileDelegate(
            subject: "microphone segment \(segmentIndex + 1)",
            expectedOutput: audioOutput,
            interruptionReporter: interruptionReporter,
            recordingFailureIncident: .microphone(.recordingFailed),
            interruptionSourceId: device.uniqueID
        )
        do {
            let input = try AVCaptureDeviceInput(device: device)
            captureSession.beginConfiguration()
            guard captureSession.canAddInput(input), captureSession.canAddOutput(audioOutput) else {
                captureSession.commitConfiguration()
                throw HelperFailure(code: "microphone-configuration-failed", message: "The selected microphone cannot be attached to the capture session.", recoverable: true)
            }
            captureSession.addInput(input)
            captureSession.addOutput(audioOutput)
            captureSession.commitConfiguration()
            audioOutput.delegate = delegate
            let source = audioSourceJSON(device: device)
            audioOutput.audioSettings = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: source["sampleRateHz"] as? Int ?? 48_000,
                AVNumberOfChannelsKey: source["channels"] as? Int ?? 1,
            ]
        } catch let failure as HelperFailure {
            throw failure
        } catch {
            throw HelperFailure(code: "microphone-configuration-failed", message: error.localizedDescription, recoverable: true)
        }
        let interruptionMonitor = CaptureAVInterruptionMonitor(
            role: .microphone,
            sourceId: device.uniqueID,
            device: device,
            session: captureSession,
            reporter: interruptionReporter
        )
        let recorder = MicrophoneSegmentRecorder(
            relativePath: relativePath,
            outputURL: outputURL,
            device: device,
            session: captureSession,
            output: audioOutput,
            delegate: delegate,
            interruptionReporter: interruptionReporter,
            interruptionMonitor: interruptionMonitor
        )
        interruptionMonitor.startObserving()
        try await recorder.startRunning()
        return recorder
    }

    private func startRunning() async throws {
        delegate.arm(
            synchronizationClock: { [weak session] in session?.synchronizationClock },
            startAction: { [weak output, weak delegate, outputURL] in
                guard let output, let delegate else { return }
                output.startRecording(to: outputURL, outputFileType: .m4a, recordingDelegate: delegate)
            }
        )

        let sessionStarted = await startSessionWithWatchdog()
        guard sessionStarted else {
            let cleanupFailure = await stopAfterFailedStart()
            throw HelperFailure(
                code: "microphone-start-failed",
                message: failedStartMessage(
                    "Microphone session did not start.",
                    terminalFailure: cleanupFailure
                ),
                recoverable: true
            )
        }

        let start = await delegate.waitForStart()
        guard start.started, !start.finished else {
            let cleanupFailure = await stopAfterFailedStart()
            let message = start.error == nil
                ? "Microphone recording did not begin within 10 seconds."
                : "Microphone recording failed before producing media."
            throw HelperFailure(
                code: "microphone-start-failed",
                message: failedStartMessage(
                    message,
                    terminalFailure: cleanupFailure ?? start.error
                ),
                recoverable: true
            )
        }
    }

    private func startSessionWithWatchdog() async -> Bool {
        let watchdog = CaptureProcessDeadlineWatchdog(
            label: "microphone session start",
            timeoutNanoseconds: 15_000_000_000,
            timeoutAction: { timeout in
                failClosedCaptureProcess(
                    CaptureCleanupFailClosedIncident(
                        kind: .sessionStartTimeout,
                        subject: timeout.label,
                        detail: "AVCaptureSession.startRunning() missed its \(timeout.timeoutNanoseconds / 1_000_000)-millisecond deadline."
                    )
                )
            }
        )
        watchdog.arm()
        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                self.session.startRunning()
                let isRunning = self.session.isRunning
                if isRunning {
                    self.interruptionMonitor.confirmRunning()
                }
                guard watchdog.disarm() else {
                    fatalError(
                        "The microphone start watchdog returned after failing closed."
                    )
                }
                continuation.resume(returning: isRunning)
            }
        }
    }

    private func stopAfterFailedStart() async
        -> CaptureNativeFileFinalizationFailure?
    {
        invalidateLocalInterruptionObservers()
        let decision = delegate.beginFailedStartCleanup(
            stopAction: { [weak output] in
                guard let output, output.isRecording else { return }
                output.stopRecording()
            }
        )
        let nativeMediaEvidence = await stopSessionWithWatchdog(
            subject: "microphone failed-start session stop",
            prepare: { [self] in
                let wasRecording = self.output.isRecording
                if wasRecording {
                    self.delegate
                        .requestFailedStartStopForNativeEvidence()
                }
                return wasRecording || self.output.isRecording
            }
        )

        let terminalFailure: CaptureNativeFileFinalizationFailure?
        switch await delegate.joinFailedStartCleanup(
            decision,
            timeoutNanoseconds: 15_000_000_000
        ) {
        case .inactive, .success:
            terminalFailure = nil
        case .failure(let failure):
            terminalFailure = failure
        case .timedOut:
            secureFailedStartOutputOrFailClosed()
            failClosedCaptureProcess(
                delegate.failedStartFinalizationTimedOut()
            )
        case .failClosed(let incident):
            secureFailedStartOutputOrFailClosed()
            failClosedCaptureProcess(incident)
        }

        secureFailedStartOutputOrFailClosed()
        let fileEvidence = FileManager.default.fileExists(
            atPath: outputURL.path
        )
        if case .failClosed(let incident) =
            delegate.completeFailedStartCleanup(
                nativeMediaEvidence: nativeMediaEvidence,
                fileEvidence: fileEvidence
            )
        {
            failClosedCaptureProcess(incident)
        }
        return terminalFailure
    }

    private func secureFailedStartOutputOrFailClosed() {
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            return
        }
        do {
            try secureFinalizedCaptureFile(outputURL)
        } catch {
            failClosedCaptureProcess(delegate.outputSecurityFailed())
        }
        if let incident = delegate.observeLateFileEvidence() {
            failClosedCaptureProcess(incident)
        }
    }

    private func failedStartMessage(
        _ message: String,
        terminalFailure: CaptureNativeFileFinalizationFailure?
    ) -> String {
        guard let terminalFailure else { return message }
        return bounded(
            "\(message) Cleanup reached a terminal callback with \(terminalFailure.code): \(terminalFailure.message)",
            maximumUTF8Bytes: 512
        )
    }

    private func stopSessionWithWatchdog<Result: Sendable>(
        subject: String,
        prepare: @escaping @Sendable () -> Result
    ) async -> Result {
        interruptionMonitor.invalidate()
        let watchdog = captureSessionStopDeadlineWatchdog(
            subject: subject
        )
        watchdog.arm()
        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                let result = prepare()
                self.session.stopRunning()
                guard watchdog.disarm() else {
                    fatalError(
                        "The microphone stop watchdog returned after failing closed."
                    )
                }
                continuation.resume(returning: result)
            }
        }
    }

    func stop() async -> MicrophoneRecordingCompletion {
        await stopFlight.runInfallible { [self] in
            await performStop()
        }
    }

    private func performStop() async -> MicrophoneRecordingCompletion {
        sealForTeardown()
        let sampleAccurateStop = await delegate.requestSampleAccurateStop()
        if !sampleAccurateStop {
            await withCheckedContinuation { continuation in
                sessionQueue.async {
                    if self.output.isRecording { self.output.stopRecording() }
                    continuation.resume()
                }
            }
        }
        let finalization = await delegate.waitForFinish()
        await stopSessionWithWatchdog(
            subject: "microphone normal session stop",
            prepare: { () }
        )
        var diagnostics: [CaptureDiagnostic] = []
        let fallbackDiagnostic: CaptureDiagnostic? = delegate.usedFallbackStop
            ? CaptureDiagnostic(
                code: "microphone-sample-stop-fallback",
                message: "Microphone recording used its bounded direct-stop fallback after no sample boundary arrived within one second.",
                recoverable: true,
                source: "microphone"
            )
            : nil
        if !finalization.finished {
            diagnostics.append(CaptureDiagnostic(
                code: "microphone-finalization-timeout",
                message: "Microphone recording did not report file finalization within 15 seconds.",
                recoverable: true,
                source: "microphone"
            ))
        }
        if finalization.error != nil {
            diagnostics.append(CaptureDiagnostic(
                code: "microphone-recording-failed",
                message: "Microphone recording failed while finalizing.",
                recoverable: true,
                source: "microphone"
            ))
        }
        if !FileManager.default.fileExists(atPath: outputURL.path) {
            diagnostics.append(CaptureDiagnostic(
                code: "microphone-output-missing",
                message: "Microphone recording output was not created.",
                recoverable: true,
                source: "microphone"
            ))
        }
        if FileManager.default.fileExists(atPath: outputURL.path) {
            do {
                try secureFinalizedCaptureFile(outputURL)
            } catch {
                diagnostics.append(CaptureDiagnostic(
                code: "microphone-output-security-failed",
                message: "Finalized microphone output could not be secured.",
                recoverable: true,
                source: "microphone"
                ))
            }
        }
        if !diagnostics.isEmpty { return .unavailable("finalization-failed", diagnostics: diagnostics) }
        let inspection: AssetInspection
        do {
            inspection = try await inspectMicrophoneAsset(
                url: outputURL,
                timingDelegate: delegate
            )
        } catch {
            return .unavailable("inspection-failed", diagnostics: [CaptureDiagnostic(
                code: "microphone-asset-inspection-failed",
                message: "Finalized microphone media could not be inspected.",
                recoverable: true,
                source: "microphone"
            )])
        }
        return MicrophoneRecordingCompletion(
            availability: "recorded",
            reason: nil,
            relativePath: relativePath,
            containerDurationUs: inspection.containerDurationUs,
            deviceId: device.uniqueID,
            label: device.localizedName,
            streams: inspection.streams,
            diagnostics: inspection.diagnostics + (fallbackDiagnostic.map { [$0] } ?? [])
        )
    }

    private func invalidateLocalInterruptionObservers() {
        interruptionMonitor.invalidate()
        delegate.sealInterruptionReporting()
    }

    private func sealForTeardown() {
        interruptionReporter.seal()
        invalidateLocalInterruptionObservers()
    }
}

private func audioSourceJSON(device: AVCaptureDevice) -> [String: Any] {
    var sampleRate = 48_000
    var channels = 1
    if let basic = CMAudioFormatDescriptionGetStreamBasicDescription(device.activeFormat.formatDescription) {
        sampleRate = max(1, Int(basic.pointee.mSampleRate.rounded()))
        channels = max(1, Int(basic.pointee.mChannelsPerFrame))
    }
    return [
        "audioSourceId": bounded(device.uniqueID, maximumUTF8Bytes: 256),
        "channels": min(64, channels),
        "kind": "microphone",
        "label": bounded(device.localizedName, maximumUTF8Bytes: 512),
        "sampleRateHz": sampleRate,
    ]
}

private func cameraSourceJSON(device: AVCaptureDevice) -> [String: Any] {
    let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
    let frameRate = device.activeVideoMaxFrameDuration.isValid && device.activeVideoMaxFrameDuration.seconds > 0
        ? 1.0 / device.activeVideoMaxFrameDuration.seconds
        : max(1, device.activeFormat.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30)
    let position: String
    switch device.position {
    case .front: position = "front"
    case .back: position = "back"
    default: position = device.deviceType == .external ? "external" : "unspecified"
    }
    return [
        "cameraId": bounded(device.uniqueID, maximumUTF8Bytes: 256),
        "frameRate": frameRate,
        "label": bounded(device.localizedName, maximumUTF8Bytes: 512),
        "pixelSize": ["width": max(1, Int(dimensions.width)), "height": max(1, Int(dimensions.height))],
        "position": position,
    ]
}

private func safeFileComponent(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    let scalars = value.unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "_" }
    let result = String(scalars.prefix(96))
    return result.isEmpty ? "default" : result
}

private func inspectCompressedTrackTiming(
    asset: AVAsset,
    track: AVAssetTrack
) throws -> FileSampleTiming {
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
        throw SampleTimingFailure(message: "AVFoundation rejected compressed timing inspection for a finalized track.")
    }
    reader.add(output)
    guard reader.startReading() else {
        throw SampleTimingFailure(message: "AVFoundation could not start compressed timing inspection.")
    }
    let timing = FileSampleTimingAccumulator()
    while let sampleBuffer = output.copyNextSampleBuffer() {
        try timing.observe(sampleBuffer)
    }
    guard reader.status == .completed else {
        throw SampleTimingFailure(message: "AVFoundation did not complete compressed timing inspection.")
    }
    return try timing.finish()
}

private func inspectCameraAsset(
    url: URL,
    timingDelegate: MediaFileDelegate
) async throws -> AssetInspection {
    do {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let tracks = try await asset.load(.tracks)
        var streams: [[String: Any]] = []
        for (index, track) in tracks.enumerated() where track.mediaType == .video && streams.isEmpty {
            let descriptions = try await track.load(.formatDescriptions)
            let codec = descriptions.first.map { codecName(CMFormatDescriptionGetMediaSubType($0)) } ?? "unknown"
            let fileTiming = try inspectCompressedTrackTiming(asset: asset, track: track)
            let liveTiming = try timingDelegate.finishTiming(
                finalizedTimingFallback: fileTiming
            )
            try validateLiveAndFileTiming(
                live: liveTiming,
                file: fileTiming,
                source: "camera-video",
                requireMatchingCounts: true
            )
            streams.append([
                "role": "camera-video",
                "mapping": "exact",
                "streamIndex": index,
                "trackId": Int(track.trackID),
                "codec": codec,
                "timing": liveTiming.json,
            ])
        }
        let seconds = duration.isNumeric ? max(0, CMTimeGetSeconds(duration)) : 0
        guard !streams.isEmpty else {
            throw HelperFailure(code: "camera-track-missing", message: "Finalized camera container has no video track.", recoverable: true)
        }
        guard seconds > 0 else {
            throw HelperFailure(code: "camera-duration-invalid", message: "Finalized camera container has no positive duration.", recoverable: true)
        }
        return AssetInspection(
            containerDurationUs: UInt64(seconds * 1_000_000),
            streams: streams,
            diagnostics: []
        )
    } catch let failure as HelperFailure {
        throw failure
    } catch {
        throw HelperFailure(code: "camera-asset-inspection-failed", message: "Finalized camera media could not be inspected.", recoverable: true)
    }
}

private func inspectMicrophoneAsset(
    url: URL,
    timingDelegate: MediaFileDelegate
) async throws -> AssetInspection {
    do {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let tracks = try await asset.load(.tracks)
        let audioTracks = tracks.enumerated().filter { $0.element.mediaType == .audio }
        guard audioTracks.count == 1, let (index, track) = audioTracks.first else {
            throw HelperFailure(code: "microphone-track-invalid", message: "Finalized microphone container must have exactly one audio track.", recoverable: true)
        }
        let descriptions = try await track.load(.formatDescriptions)
        let description = descriptions.first
        let codec = description.map { codecName(CMFormatDescriptionGetMediaSubType($0)) } ?? "unknown"
        let fileTiming = try inspectCompressedTrackTiming(asset: asset, track: track)
        let liveTiming = try timingDelegate.finishTiming(
            finalizedTimingFallback: fileTiming
        )
        try validateLiveAndFileTiming(live: liveTiming, file: fileTiming, source: "microphone-audio")
        var stream: [String: Any] = [
            "codec": codec,
            "mapping": "exact",
            "role": "microphone-audio",
            "streamIndex": index,
            "trackId": Int(track.trackID),
            "timing": liveTiming.json,
        ]
        if let description,
           let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description) {
            stream["sampleRateHz"] = max(1, Int(basic.pointee.mSampleRate.rounded()))
            stream["channels"] = max(1, Int(basic.pointee.mChannelsPerFrame))
        }
        let seconds = duration.isNumeric ? max(0, CMTimeGetSeconds(duration)) : 0
        guard seconds > 0 else {
            throw HelperFailure(code: "microphone-duration-invalid", message: "Finalized microphone container has no positive duration.", recoverable: true)
        }
        return AssetInspection(
            containerDurationUs: UInt64(seconds * 1_000_000),
            streams: [stream],
            diagnostics: []
        )
    } catch let failure as HelperFailure {
        throw failure
    } catch {
        throw HelperFailure(code: "microphone-asset-inspection-failed", message: "Finalized microphone media could not be inspected.", recoverable: true)
    }
}
