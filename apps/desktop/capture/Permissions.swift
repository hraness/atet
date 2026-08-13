import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation

enum PermissionState: String {
    case notDetermined = "not-determined"
    case authorized
    case denied
    case restricted
    case unavailable
}

struct PermissionSnapshot {
    let accessibility: PermissionState
    let camera: PermissionState
    let inputMonitoring: PermissionState
    let microphone: PermissionState
    let screenCapture: PermissionState
    let systemAudio: PermissionState
    let windowMetadata: PermissionState

    var json: [String: Any] {
        [
            "accessibility": accessibility.rawValue,
            "camera": camera.rawValue,
            "inputMonitoring": inputMonitoring.rawValue,
            "microphone": microphone.rawValue,
            "screenCapture": screenCapture.rawValue,
            "systemAudio": systemAudio.rawValue,
            "windowMetadata": windowMetadata.rawValue,
        ]
    }
}

enum CapturePermissions {
    static func snapshot() -> PermissionSnapshot {
        let screen: PermissionState = CGPreflightScreenCaptureAccess() ? .authorized : .denied
        return PermissionSnapshot(
            accessibility: AXIsProcessTrusted() ? .authorized : .denied,
            camera: state(for: .video),
            inputMonitoring: CGPreflightListenEventAccess() ? .authorized : .denied,
            microphone: state(for: .audio),
            screenCapture: screen,
            systemAudio: screen,
            windowMetadata: screen
        )
    }

    static func request(options: CaptureOptions) async -> PermissionSnapshot {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        if options.metadata {
            if !CGPreflightListenEventAccess() {
                _ = CGRequestListenEventAccess()
            }
            if !AXIsProcessTrusted() {
                let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
                _ = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
            }
        }
        if options.camera.requested {
            _ = await requestAVAccessIfNeeded(for: .video)
        }
        if options.microphone.requested {
            _ = await requestAVAccessIfNeeded(for: .audio)
        }
        return snapshot()
    }

    private static func state(for mediaType: AVMediaType) -> PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: mediaType) {
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        case .denied: return .denied
        case .authorized: return .authorized
        @unknown default: return .unavailable
        }
    }

    private static func requestAVAccessIfNeeded(for mediaType: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: mediaType) {
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: mediaType) { granted in
                    continuation.resume(returning: granted)
                }
            }
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}
