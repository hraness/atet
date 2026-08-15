import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ImageIO
import Vision

private let analyzerKind = "atet.face-analysis"
private let analyzerSchemaVersion = 1
private let analyzerVersion = "1.0.0"
private let pinnedVisionRevision = VNDetectFaceRectanglesRequestRevision3

private let hardMaximumArguments = 32
private let hardMaximumArgumentBytes = 4_096
private let hardMaximumInputBytes: Int64 = 4 * 1_024 * 1_024 * 1_024 * 1_024
private let hardMaximumTimelineUs: Int64 = 86_400_000_000
private let hardMaximumFrames = 100_000
private let hardMaximumFacesPerFrame = 128
private let hardMaximumOutputBytes = 64 * 1_024 * 1_024
private let hardMaximumLineBytes = 1 * 1_024 * 1_024
private let terminalOutputReserveBytes = 4_096

private struct AnalyzerFailure: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = String(message.prefix(1_024))
    }
}

private struct NullableInt64: Encodable {
    let value: Int64?

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let value {
            try container.encode(value)
        } else {
            try container.encodeNil()
        }
    }
}

private struct Backend: Encodable {
    let architecture: String
    let helperVersion = analyzerVersion
    let implementation = "apple-vision"
    let offline = true
    let osBuild: String
    let operatingSystem: String
    let request = "VNDetectFaceRectanglesRequest"
    let revision: Int
    let runtimeVersion: String
}

private struct HardLimits: Encodable {
    let maximumArgumentBytes = hardMaximumArgumentBytes
    let maximumArguments = hardMaximumArguments
    let maximumFacesPerFrame = hardMaximumFacesPerFrame
    let maximumFrames = hardMaximumFrames
    let maximumInputBytes = hardMaximumInputBytes
    let maximumLineBytes = hardMaximumLineBytes
    let maximumOutputBytes = hardMaximumOutputBytes
    let maximumTimelineUs = hardMaximumTimelineUs
}

private struct ProbeEvent: Encodable {
    let backend: Backend
    let event = "probe"
    let kind = analyzerKind
    let limits = HardLimits()
    let schemaVersion = analyzerSchemaVersion
}

private struct PreferredTransform: Encodable {
    let a: Double
    let b: Double
    let c: Double
    let d: Double
    let tx: Double
    let ty: Double
}

private struct SampleAspectRatio: Encodable {
    let denominator: Int
    let numerator: Int
}

private struct OrientationProvenance: Encodable {
    let encodedPixelHeight: Int
    let encodedPixelWidth: Int
    let mirroredHorizontally: Bool
    let origin = "top-left"
    let pixelHeight: Int
    let pixelWidth: Int
    let preferredTransform: PreferredTransform
    let rotationDegrees: Int
    let sampleAspectRatio: SampleAspectRatio
    let units = "normalized"
    let visionOrientation: String
    let xAxis = "right"
    let yAxis = "down"
}

private struct TrackProvenance: Encodable {
    let nominalFrameRate: Double
    let persistentTrackId: Int
    let totalVideoTracks: Int
    let videoTrackOrdinal: Int
}

private struct RequestedLimits: Encodable {
    let endUs: Int64
    let maximumFacesPerFrame: Int
    let maximumFrames: Int
    let maximumOutputBytes: Int
    let minimumConfidence: Double
    let sampleIntervalUs: Int64
    let startUs: Int64
}

private struct StartedEvent: Encodable {
    let backend: Backend
    let event = "started"
    let kind = analyzerKind
    let limits: RequestedLimits
    let orientation: OrientationProvenance
    let schemaVersion = analyzerSchemaVersion
    let track: TrackProvenance
}

private struct NormalizedBounds: Encodable {
    let height: Double
    let width: Double
    let x: Double
    let y: Double
}

private struct FaceDetection: Encodable {
    let bounds: NormalizedBounds
    let confidence: Double
    let detectionIndex: Int
}

private struct FrameEvent: Encodable {
    let durationUs: NullableInt64
    let event = "frame"
    let faces: [FaceDetection]
    let kind = analyzerKind
    let ptsUs: Int64
    let sampleIndex: Int
    let schemaVersion = analyzerSchemaVersion
}

private struct CompletedEvent: Encodable {
    let event = "completed"
    let faceDetections: Int
    let firstPtsUs: NullableInt64
    let framesAnalyzed: Int
    let framesRead: Int
    let kind = analyzerKind
    let lastPtsUs: NullableInt64
    let schemaVersion = analyzerSchemaVersion
}

private struct ErrorEvent: Encodable {
    let code: String
    let event = "error"
    let kind = analyzerKind
    let message: String
    let schemaVersion = analyzerSchemaVersion
}

private final class JSONLineWriter {
    private let encoder: JSONEncoder
    private let maximumBytes: Int
    private var writtenBytes = 0

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    }

    func write<Value: Encodable>(_ value: Value, terminal: Bool = false) throws {
        var data: Data
        do {
            data = try encoder.encode(value)
        } catch {
            throw AnalyzerFailure("frame-read-failed", "The analyzer could not encode its bounded protocol event.")
        }
        data.append(0x0A)
        if data.count > hardMaximumLineBytes {
            throw AnalyzerFailure("output-limit-exceeded", "One analyzer event exceeded the maximum JSONL line size.")
        }
        let budget = terminal ? maximumBytes : maximumBytes - terminalOutputReserveBytes
        if writtenBytes > budget - data.count {
            throw AnalyzerFailure("output-limit-exceeded", "Analyzer output exceeded the requested byte limit.")
        }
        do {
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            throw AnalyzerFailure("output-limit-exceeded", "The analyzer could not write its protocol output.")
        }
        writtenBytes += data.count
    }
}

private struct AnalyzeOptions {
    let endUs: Int64?
    let inputPath: String
    let maximumFacesPerFrame: Int
    let maximumFrames: Int
    let maximumOutputBytes: Int
    let minimumConfidence: Double
    let sampleIntervalUs: Int64
    let startUs: Int64
    let videoTrackOrdinal: Int
}

private enum Mode {
    case analyze(AnalyzeOptions)
    case probe
    case version

    var outputLimit: Int {
        switch self {
        case .analyze(let options):
            return options.maximumOutputBytes
        case .probe, .version:
            return hardMaximumLineBytes
        }
    }
}

private func parseInteger(
    _ values: [String: String],
    _ name: String,
    default defaultValue: Int64,
    minimum: Int64,
    maximum: Int64
) throws -> Int64 {
    guard let raw = values[name] else {
        return defaultValue
    }
    guard let value = Int64(raw), value >= minimum, value <= maximum else {
        throw AnalyzerFailure("usage", "\(name) must be an integer from \(minimum) through \(maximum).")
    }
    return value
}

private func parseDouble(
    _ values: [String: String],
    _ name: String,
    default defaultValue: Double,
    minimum: Double,
    maximum: Double
) throws -> Double {
    guard let raw = values[name] else {
        return defaultValue
    }
    guard let value = Double(raw), value.isFinite, value >= minimum, value <= maximum else {
        throw AnalyzerFailure("usage", "\(name) must be a finite number from \(minimum) through \(maximum).")
    }
    return value
}

private func parseArguments(_ arguments: [String]) throws -> Mode {
    if arguments.count > hardMaximumArguments {
        throw AnalyzerFailure("usage", "The analyzer accepts at most \(hardMaximumArguments) arguments.")
    }
    if arguments.contains(where: { $0.utf8.count == 0 || $0.utf8.count > hardMaximumArgumentBytes }) {
        throw AnalyzerFailure("usage", "Analyzer arguments must contain 1-\(hardMaximumArgumentBytes) UTF-8 bytes.")
    }
    if arguments == ["--probe"] || arguments == ["--json"] {
        return .probe
    }
    if arguments == ["--version"] {
        return .version
    }
    if arguments.contains("--probe") || arguments.contains("--json") || arguments.contains("--version") {
        throw AnalyzerFailure("usage", "--probe, --json, and --version cannot be combined with other arguments.")
    }
    if arguments.count % 2 != 0 {
        throw AnalyzerFailure("usage", "Analysis arguments must be exact --name value pairs.")
    }
    let known = Set([
        "--end-us",
        "--input",
        "--max-faces-per-frame",
        "--max-frames",
        "--max-output-bytes",
        "--minimum-confidence",
        "--sample-interval-us",
        "--start-us",
        "--video-track-ordinal",
    ])
    var values: [String: String] = [:]
    var index = 0
    while index < arguments.count {
        let name = arguments[index]
        let value = arguments[index + 1]
        guard known.contains(name) else {
            throw AnalyzerFailure("usage", "Unknown analyzer argument: \(name)")
        }
        guard values[name] == nil else {
            throw AnalyzerFailure("usage", "Analyzer argument appears more than once: \(name)")
        }
        values[name] = value
        index += 2
    }
    guard let inputPath = values["--input"] else {
        throw AnalyzerFailure("usage", "Analysis requires --input with one absolute physical media path.")
    }
    if inputPath.utf8.count > hardMaximumArgumentBytes || inputPath.utf8.contains(0) {
        throw AnalyzerFailure("unsafe-input", "The input path is empty, oversized, or contains a null byte.")
    }
    let startUs = try parseInteger(
        values,
        "--start-us",
        default: 0,
        minimum: 0,
        maximum: hardMaximumTimelineUs - 1
    )
    let endUs = values["--end-us"] == nil
        ? nil
        : try parseInteger(
            values,
            "--end-us",
            default: 0,
            minimum: 1,
            maximum: hardMaximumTimelineUs
        )
    if let endUs, endUs <= startUs {
        throw AnalyzerFailure("usage", "--end-us must be greater than --start-us.")
    }
    let outputBytes = try parseInteger(
        values,
        "--max-output-bytes",
        default: 16 * 1_024 * 1_024,
        minimum: 8_192,
        maximum: Int64(hardMaximumOutputBytes)
    )
    return .analyze(AnalyzeOptions(
        endUs: endUs,
        inputPath: inputPath,
        maximumFacesPerFrame: Int(try parseInteger(
            values,
            "--max-faces-per-frame",
            default: 32,
            minimum: 1,
            maximum: Int64(hardMaximumFacesPerFrame)
        )),
        maximumFrames: Int(try parseInteger(
            values,
            "--max-frames",
            default: 10_000,
            minimum: 1,
            maximum: Int64(hardMaximumFrames)
        )),
        maximumOutputBytes: Int(outputBytes),
        minimumConfidence: try parseDouble(
            values,
            "--minimum-confidence",
            default: 0,
            minimum: 0,
            maximum: 1
        ),
        sampleIntervalUs: try parseInteger(
            values,
            "--sample-interval-us",
            default: 33_333,
            minimum: 1_000,
            maximum: 60_000_000
        ),
        startUs: startUs,
        videoTrackOrdinal: Int(try parseInteger(
            values,
            "--video-track-ordinal",
            default: 0,
            minimum: 0,
            maximum: 63
        ))
    ))
}

private func processArchitecture() -> String {
#if arch(arm64)
    return "arm64"
#elseif arch(x86_64)
    return "x86_64"
#else
    return "unsupported"
#endif
}

private func operatingSystemBuild() throws -> String {
    let name = "kern.osversion"
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 1, size <= 129 else {
        throw AnalyzerFailure("unsupported-backend", "The analyzer could not read the bounded macOS build identifier.")
    }
    var buffer = [CChar](repeating: 0, count: size)
    let result = buffer.withUnsafeMutableBytes { bytes in
        sysctlbyname(name, bytes.baseAddress, &size, nil, 0)
    }
    guard result == 0 else {
        throw AnalyzerFailure("unsupported-backend", "The analyzer could not read the macOS build identifier.")
    }
    let build = String(cString: buffer)
    guard !build.isEmpty, build.utf8.count <= 128 else {
        throw AnalyzerFailure("unsupported-backend", "The macOS build identifier is empty or oversized.")
    }
    return build
}

private func backend() throws -> Backend {
    guard VNDetectFaceRectanglesRequest.supportedRevisions.contains(Int(pinnedVisionRevision)) else {
        throw AnalyzerFailure(
            "unsupported-backend",
            "This operating system does not support Vision face-rectangle revision \(pinnedVisionRevision)."
        )
    }
    let architecture = processArchitecture()
    guard architecture == "arm64" || architecture == "x86_64" else {
        throw AnalyzerFailure("unsupported-backend", "The face analyzer supports only arm64 and x86_64 macOS.")
    }
    let runtimeVersion = ProcessInfo.processInfo.operatingSystemVersionString
    guard !runtimeVersion.isEmpty, runtimeVersion.utf8.count <= 128 else {
        throw AnalyzerFailure("unsupported-backend", "The macOS runtime version is empty or oversized.")
    }
    return Backend(
        architecture: architecture,
        osBuild: try operatingSystemBuild(),
        operatingSystem: runtimeVersion,
        revision: Int(pinnedVisionRevision),
        runtimeVersion: runtimeVersion
    )
}

private struct ResolvedOrientation {
    let imagePropertyOrientation: CGImagePropertyOrientation
    let provenance: OrientationProvenance
}

private func approximately(_ value: CGFloat, _ expected: CGFloat) -> Bool {
    abs(value - expected) <= 0.000_1
}

private func resolveOrientation(
    encodedSize: CGSize,
    sampleAspectRatio: SampleAspectRatio,
    transform: CGAffineTransform
) throws -> ResolvedOrientation {
    let candidates: [(CGFloat, CGFloat, CGFloat, CGFloat, CGImagePropertyOrientation, String, Int, Bool)] = [
        (1, 0, 0, 1, .up, "up", 0, false),
        (-1, 0, 0, 1, .upMirrored, "up-mirrored", 0, true),
        (-1, 0, 0, -1, .down, "down", 180, false),
        (1, 0, 0, -1, .downMirrored, "down-mirrored", 180, true),
        (0, -1, 1, 0, .left, "left", 270, false),
        (0, 1, 1, 0, .leftMirrored, "left-mirrored", 270, true),
        (0, 1, -1, 0, .right, "right", 90, false),
        (0, -1, -1, 0, .rightMirrored, "right-mirrored", 90, true),
    ]
    guard encodedSize.width > 0,
          encodedSize.height > 0,
          encodedSize.width <= 16_384,
          encodedSize.height <= 16_384,
          encodedSize.width * encodedSize.height <= 134_217_728
    else {
        throw AnalyzerFailure("unsupported-orientation", "The selected video track has invalid or oversized pixel geometry.")
    }
    guard let selected = candidates.first(where: { candidate in
        approximately(transform.a, candidate.0)
            && approximately(transform.b, candidate.1)
            && approximately(transform.c, candidate.2)
            && approximately(transform.d, candidate.3)
    }) else {
        throw AnalyzerFailure(
            "unsupported-orientation",
            "The selected video track uses a non-canonical preferred transform."
        )
    }
    let transformed = CGRect(origin: .zero, size: encodedSize).applying(transform).standardized
    let uprightWidth = abs(transformed.width)
    let uprightHeight = abs(transformed.height)
    guard uprightWidth > 0, uprightHeight > 0 else {
        throw AnalyzerFailure("unsupported-orientation", "The preferred transform produces an empty upright frame.")
    }
    return ResolvedOrientation(
        imagePropertyOrientation: selected.4,
        provenance: OrientationProvenance(
            encodedPixelHeight: Int(encodedSize.height),
            encodedPixelWidth: Int(encodedSize.width),
            mirroredHorizontally: selected.7,
            pixelHeight: Int(uprightHeight),
            pixelWidth: Int(uprightWidth),
            preferredTransform: PreferredTransform(
                a: Double(transform.a),
                b: Double(transform.b),
                c: Double(transform.c),
                d: Double(transform.d),
                tx: Double(transform.tx),
                ty: Double(transform.ty)
            ),
            rotationDegrees: selected.6,
            sampleAspectRatio: sampleAspectRatio,
            visionOrientation: selected.5
        )
    )
}

private func greatestCommonDivisor(_ left: Int, _ right: Int) -> Int {
    var a = abs(left)
    var b = abs(right)
    while b != 0 {
        (a, b) = (b, a % b)
    }
    return max(1, a)
}

private func sourceGeometry(_ descriptions: [CMFormatDescription]) throws -> (CGSize, SampleAspectRatio) {
    guard let description = descriptions.first(where: {
        CMFormatDescriptionGetMediaType($0) == kCMMediaType_Video
    }) else {
        throw AnalyzerFailure("reader-setup-failed", "The selected video track has no video format description.")
    }
    let dimensions = CMVideoFormatDescriptionGetDimensions(description)
    guard dimensions.width > 0, dimensions.height > 0 else {
        throw AnalyzerFailure("reader-setup-failed", "The selected video format has invalid encoded dimensions.")
    }

    var horizontalSpacing = 1
    var verticalSpacing = 1
    let extensions = CMFormatDescriptionGetExtensions(description) as NSDictionary?
    if let aspect = extensions?[kCMFormatDescriptionExtension_PixelAspectRatio] as? NSDictionary {
        guard let horizontal = aspect[kCMFormatDescriptionKey_PixelAspectRatioHorizontalSpacing] as? NSNumber,
              let vertical = aspect[kCMFormatDescriptionKey_PixelAspectRatioVerticalSpacing] as? NSNumber
        else {
            throw AnalyzerFailure("reader-setup-failed", "The video format contains an incomplete sample aspect ratio.")
        }
        horizontalSpacing = horizontal.intValue
        verticalSpacing = vertical.intValue
    }
    guard horizontalSpacing > 0, verticalSpacing > 0 else {
        throw AnalyzerFailure("reader-setup-failed", "The video format contains an invalid sample aspect ratio.")
    }
    let divisor = greatestCommonDivisor(horizontalSpacing, verticalSpacing)
    let numerator = horizontalSpacing / divisor
    let denominator = verticalSpacing / divisor
    guard numerator <= 1_000_000, denominator <= 1_000_000 else {
        throw AnalyzerFailure("reader-setup-failed", "The reduced sample aspect ratio exceeds protocol limits.")
    }
    return (
        CGSize(width: Int(dimensions.width), height: Int(dimensions.height)),
        SampleAspectRatio(denominator: denominator, numerator: numerator)
    )
}

private func physicalInputSize(_ path: String) throws -> Int64 {
    guard path.hasPrefix("/") else {
        throw AnalyzerFailure("unsafe-input", "The input path must be absolute.")
    }
    var details = stat()
    let result = path.withCString { pointer in
        lstat(pointer, &details)
    }
    guard result == 0 else {
        if errno == ENOENT {
            throw AnalyzerFailure("input-not-found", "The input media file does not exist.")
        }
        throw AnalyzerFailure("unsafe-input", "The input media path could not be inspected.")
    }
    guard details.st_mode & S_IFMT == S_IFREG else {
        throw AnalyzerFailure("unsafe-input", "The input media path must be a physical regular file.")
    }
    let size = Int64(details.st_size)
    guard size > 0 else {
        throw AnalyzerFailure("unsafe-input", "The input media file is empty.")
    }
    guard size <= hardMaximumInputBytes else {
        throw AnalyzerFailure("input-too-large", "The input media file exceeds the four-terabyte safety limit.")
    }
    return size
}

private func microseconds(_ time: CMTime, allowZero: Bool = true) throws -> Int64 {
    guard time.isValid, time.isNumeric, !time.isIndefinite else {
        throw AnalyzerFailure("invalid-timestamp", "The media contains a non-numeric timestamp.")
    }
    let converted = CMTimeConvertScale(time, timescale: 1_000_000, method: .roundHalfAwayFromZero)
    let value = converted.value
    guard value >= (allowZero ? 0 : 1), value <= hardMaximumTimelineUs else {
        throw AnalyzerFailure("invalid-timestamp", "A media timestamp lies outside the supported 24-hour timeline.")
    }
    return value
}

private func optionalDurationMicroseconds(_ time: CMTime) -> Int64? {
    guard time.isValid, time.isNumeric, !time.isIndefinite, time > .zero else {
        return nil
    }
    let converted = CMTimeConvertScale(time, timescale: 1_000_000, method: .roundHalfAwayFromZero)
    return converted.value > 0 && converted.value <= hardMaximumTimelineUs ? converted.value : nil
}

private struct DetectionCandidate {
    let bounds: NormalizedBounds
    let confidence: Double
}

private func clamp(_ value: CGFloat) -> Double {
    Double(min(1, max(0, value)))
}

private func faceCandidate(_ observation: VNFaceObservation) throws -> DetectionCandidate {
    let box = observation.boundingBox
    let tolerance: CGFloat = 0.000_1
    guard box.width > 0,
          box.height > 0,
          box.minX >= -tolerance,
          box.minY >= -tolerance,
          box.maxX <= 1 + tolerance,
          box.maxY <= 1 + tolerance
    else {
        throw AnalyzerFailure("vision-failed", "Vision returned a face box outside normalized image bounds.")
    }
    let x = clamp(box.minX)
    let y = clamp(1 - box.maxY)
    let width = min(clamp(box.width), 1 - x)
    let height = min(clamp(box.height), 1 - y)
    guard width > 0, height > 0 else {
        throw AnalyzerFailure("vision-failed", "Vision returned an empty face box.")
    }
    return DetectionCandidate(
        bounds: NormalizedBounds(height: height, width: width, x: x, y: y),
        confidence: Double(observation.confidence)
    )
}

private func orderedDetections(
    _ observations: [VNFaceObservation],
    minimumConfidence: Double,
    maximumCount: Int
) throws -> [FaceDetection] {
    var candidates = try observations
        .filter { Double($0.confidence) >= minimumConfidence }
        .map(faceCandidate)
    if candidates.count > maximumCount {
        throw AnalyzerFailure(
            "face-limit-exceeded",
            "One frame contains \(candidates.count) accepted faces, above the requested limit of \(maximumCount)."
        )
    }
    candidates.sort { left, right in
        if left.bounds.x != right.bounds.x { return left.bounds.x < right.bounds.x }
        if left.bounds.y != right.bounds.y { return left.bounds.y < right.bounds.y }
        if left.bounds.width != right.bounds.width { return left.bounds.width < right.bounds.width }
        if left.bounds.height != right.bounds.height { return left.bounds.height < right.bounds.height }
        return left.confidence > right.confidence
    }
    return candidates.enumerated().map { index, candidate in
        FaceDetection(bounds: candidate.bounds, confidence: candidate.confidence, detectionIndex: index)
    }
}

private func analyze(
    options: AnalyzeOptions,
    writer: JSONLineWriter,
    backend backendInfo: Backend
) async throws {
    _ = try physicalInputSize(options.inputPath)
    let asset = AVURLAsset(url: URL(fileURLWithPath: options.inputPath, isDirectory: false))
    let tracks: [AVAssetTrack]
    do {
        tracks = try await asset.loadTracks(withMediaType: .video)
    } catch {
        throw AnalyzerFailure("reader-setup-failed", "AVFoundation could not enumerate the input video tracks.")
    }
    guard !tracks.isEmpty else {
        throw AnalyzerFailure("no-video-track", "The input media contains no video tracks.")
    }
    guard tracks.count <= 64 else {
        throw AnalyzerFailure("reader-setup-failed", "The input media exceeds the 64-video-track safety limit.")
    }
    guard options.videoTrackOrdinal < tracks.count else {
        throw AnalyzerFailure(
            "video-track-out-of-range",
            "Video-track ordinal \(options.videoTrackOrdinal) is outside the input's \(tracks.count) video tracks."
        )
    }
    let track = tracks[options.videoTrackOrdinal]
    let encodedSize: CGSize
    let sampleAspectRatio: SampleAspectRatio
    let transform: CGAffineTransform
    let nominalFrameRate: Float
    let assetDuration: CMTime
    do {
        let formatDescriptions = try await track.load(.formatDescriptions)
        (encodedSize, sampleAspectRatio) = try sourceGeometry(formatDescriptions)
        transform = try await track.load(.preferredTransform)
        nominalFrameRate = try await track.load(.nominalFrameRate)
        assetDuration = try await asset.load(.duration)
    } catch {
        throw AnalyzerFailure("reader-setup-failed", "AVFoundation could not load the selected video-track geometry.")
    }
    let orientation = try resolveOrientation(
        encodedSize: encodedSize,
        sampleAspectRatio: sampleAspectRatio,
        transform: transform
    )
    let assetDurationUs = try microseconds(assetDuration, allowZero: false)
    let endUs = options.endUs ?? assetDurationUs
    guard endUs <= assetDurationUs else {
        throw AnalyzerFailure("invalid-timestamp", "The requested analysis end exceeds the media duration.")
    }
    guard options.startUs < endUs else {
        throw AnalyzerFailure("invalid-timestamp", "The requested analysis range does not intersect the media timeline.")
    }

    try writer.write(StartedEvent(
        backend: backendInfo,
        limits: RequestedLimits(
            endUs: endUs,
            maximumFacesPerFrame: options.maximumFacesPerFrame,
            maximumFrames: options.maximumFrames,
            maximumOutputBytes: options.maximumOutputBytes,
            minimumConfidence: options.minimumConfidence,
            sampleIntervalUs: options.sampleIntervalUs,
            startUs: options.startUs
        ),
        orientation: orientation.provenance,
        track: TrackProvenance(
            nominalFrameRate: Double(nominalFrameRate),
            persistentTrackId: Int(track.trackID),
            totalVideoTracks: tracks.count,
            videoTrackOrdinal: options.videoTrackOrdinal
        )
    ))

    let reader: AVAssetReader
    do {
        reader = try AVAssetReader(asset: asset)
    } catch {
        throw AnalyzerFailure("reader-setup-failed", "AVFoundation could not create the video reader.")
    }
    let output = AVAssetReaderTrackOutput(
        track: track,
        outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
    )
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
        throw AnalyzerFailure("reader-setup-failed", "AVFoundation rejected the selected video-track output.")
    }
    reader.add(output)
    reader.timeRange = CMTimeRange(
        start: CMTime(value: options.startUs, timescale: 1_000_000),
        end: CMTime(value: endUs, timescale: 1_000_000)
    )
    guard reader.startReading() else {
        throw AnalyzerFailure("reader-setup-failed", "AVFoundation could not start reading the selected video track.")
    }

    let request = VNDetectFaceRectanglesRequest()
    request.revision = pinnedVisionRevision
    var framesRead = 0
    var framesAnalyzed = 0
    var faceDetections = 0
    var firstPtsUs: Int64?
    var lastPtsUs: Int64?
    var lastReadPtsUs: Int64?
    var lastAnalyzedPtsUs: Int64?

    while let sample = output.copyNextSampleBuffer() {
        framesRead += 1
        let ptsUs = try microseconds(CMSampleBufferGetPresentationTimeStamp(sample))
        if let lastReadPtsUs, ptsUs < lastReadPtsUs {
            throw AnalyzerFailure("invalid-timestamp", "Decoded video presentation timestamps move backward.")
        }
        lastReadPtsUs = ptsUs
        if ptsUs < options.startUs || ptsUs >= endUs {
            continue
        }
        if let lastAnalyzedPtsUs, ptsUs - lastAnalyzedPtsUs < options.sampleIntervalUs {
            continue
        }
        if framesAnalyzed >= options.maximumFrames {
            throw AnalyzerFailure(
                "frame-limit-exceeded",
                "The analysis contains more eligible frames than the requested limit of \(options.maximumFrames)."
            )
        }
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sample) else {
            throw AnalyzerFailure("frame-read-failed", "A decoded video sample does not contain a pixel buffer.")
        }
        let handler = VNImageRequestHandler(
            cvPixelBuffer: imageBuffer,
            orientation: orientation.imagePropertyOrientation,
            options: [:]
        )
        do {
            try handler.perform([request])
        } catch {
            throw AnalyzerFailure("vision-failed", "Apple Vision could not analyze one decoded video frame.")
        }
        let detections = try orderedDetections(
            request.results ?? [],
            minimumConfidence: options.minimumConfidence,
            maximumCount: options.maximumFacesPerFrame
        )
        try writer.write(FrameEvent(
            durationUs: NullableInt64(value: optionalDurationMicroseconds(CMSampleBufferGetDuration(sample))),
            faces: detections,
            ptsUs: ptsUs,
            sampleIndex: framesAnalyzed
        ))
        framesAnalyzed += 1
        faceDetections += detections.count
        firstPtsUs = firstPtsUs ?? ptsUs
        lastPtsUs = ptsUs
        lastAnalyzedPtsUs = ptsUs
    }

    if reader.status == .failed {
        throw AnalyzerFailure("frame-read-failed", "AVFoundation failed while decoding the selected video track.")
    }
    if reader.status == .cancelled {
        throw AnalyzerFailure("frame-read-failed", "AVFoundation cancelled the selected video-track read.")
    }
    try writer.write(CompletedEvent(
        faceDetections: faceDetections,
        firstPtsUs: NullableInt64(value: firstPtsUs),
        framesAnalyzed: framesAnalyzed,
        framesRead: framesRead,
        lastPtsUs: NullableInt64(value: lastPtsUs)
    ), terminal: true)
}

private func normalizedFailure(_ error: Error) -> AnalyzerFailure {
    if let failure = error as? AnalyzerFailure {
        return failure
    }
    return AnalyzerFailure("frame-read-failed", "The face analyzer failed at an internal media boundary.")
}

private func writeVersion(_ backend: Backend) throws {
    let line = "atet-face-analyzer \(analyzerVersion) (schema \(analyzerSchemaVersion); "
        + "Apple Vision revision \(backend.revision); \(backend.architecture); \(backend.osBuild))\n"
    let data = Data(line.utf8)
    guard data.count > 0, data.count <= 512 else {
        throw AnalyzerFailure("output-limit-exceeded", "The analyzer version line is empty or oversized.")
    }
    do {
        try FileHandle.standardOutput.write(contentsOf: data)
    } catch {
        throw AnalyzerFailure("output-limit-exceeded", "The analyzer could not write its version line.")
    }
}

@main
private struct FaceAnalyzerMain {
    static func main() async {
        var writer: JSONLineWriter?
        do {
            let mode = try parseArguments(Array(CommandLine.arguments.dropFirst()))
            let activeWriter = JSONLineWriter(maximumBytes: mode.outputLimit)
            writer = activeWriter
            let backendInfo = try backend()
            switch mode {
            case .probe:
                try activeWriter.write(ProbeEvent(backend: backendInfo), terminal: true)
            case .analyze(let options):
                try await analyze(options: options, writer: activeWriter, backend: backendInfo)
            case .version:
                try writeVersion(backendInfo)
            }
        } catch {
            let failure = normalizedFailure(error)
            let activeWriter = writer ?? JSONLineWriter(maximumBytes: hardMaximumLineBytes)
            try? activeWriter.write(ErrorEvent(code: failure.code, message: failure.message), terminal: true)
            let diagnostic = "atet-face-analyzer [\(failure.code)]: \(failure.message)\n"
            FileHandle.standardError.write(Data(diagnostic.utf8))
            Darwin.exit(2)
        }
    }
}
