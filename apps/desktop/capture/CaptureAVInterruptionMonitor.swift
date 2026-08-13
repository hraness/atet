@preconcurrency import AVFoundation
import Foundation

struct CaptureNotificationObservationSource: @unchecked Sendable {
    typealias Handler = @Sendable (Notification) -> Void
    typealias Observe =
        (Notification.Name, @escaping Handler)
            -> CaptureInterruptionObserverCancellation

    private let observeAction: Observe

    init(observe: @escaping Observe) {
        observeAction = observe
    }

    func observe(
        name: Notification.Name,
        handler: @escaping Handler
    ) -> CaptureInterruptionObserverCancellation {
        observeAction(name, handler)
    }

    static func foundation(
        center: NotificationCenter = .default
    ) -> CaptureNotificationObservationSource {
        CaptureNotificationObservationSource { name, handler in
            let token = center.addObserver(
                forName: name,
                object: nil,
                queue: nil,
                using: handler
            )
            return CaptureInterruptionObserverCancellation {
                center.removeObserver(token)
            }
        }
    }
}

struct CaptureAVInterruptionNotificationNames: Sendable {
    let deviceDisconnected: Notification.Name
    let sessionInterrupted: Notification.Name
    let runtimeError: Notification.Name
    let sessionStopped: Notification.Name

    static let avFoundation = CaptureAVInterruptionNotificationNames(
        deviceDisconnected: AVCaptureDevice.wasDisconnectedNotification,
        sessionInterrupted: AVCaptureSession.wasInterruptedNotification,
        runtimeError: AVCaptureSession.runtimeErrorNotification,
        sessionStopped: AVCaptureSession.didStopRunningNotification
    )
}

enum CaptureAVInterruptionRole: Sendable {
    case camera
    case microphone

    fileprivate var deviceDisconnected: CaptureInterruptionIncident {
        switch self {
        case .camera:
            return .camera(.deviceDisconnected)
        case .microphone:
            return .microphone(.deviceDisconnected)
        }
    }

    fileprivate var sessionInterrupted: CaptureInterruptionIncident {
        switch self {
        case .camera:
            return .camera(.sessionInterrupted)
        case .microphone:
            return .microphone(.sessionInterrupted)
        }
    }

    fileprivate var runtimeError: CaptureInterruptionIncident {
        switch self {
        case .camera:
            return .camera(.runtimeError)
        case .microphone:
            return .microphone(.runtimeError)
        }
    }

    fileprivate var sessionStopped: CaptureInterruptionIncident {
        switch self {
        case .camera:
            return .camera(.sessionStopped)
        case .microphone:
            return .microphone(.sessionStopped)
        }
    }
}

/// NotificationCenter adapter for one AV capture source.
///
/// It intentionally does not observe interruption-ended: an interrupted
/// segment is immutable and only an explicit resume command may start another.
final class CaptureAVInterruptionMonitor: @unchecked Sendable {
    private enum Event {
        case deviceDisconnected
        case sessionInterrupted
        case runtimeError
        case sessionStopped
    }

    private let lock = NSLock()
    private let role: CaptureAVInterruptionRole
    private let sourceId: String
    private let expectedDevice: AnyObject
    private let expectedSession: AnyObject
    private let reporter: CaptureInterruptionReporter
    private let observations: CaptureNotificationObservationSource
    private let names: CaptureAVInterruptionNotificationNames
    private var cancellations: [CaptureInterruptionObserverCancellation] = []
    private var observing = false
    private var invalidated = false
    private var confirmedRunning = false
    private var pendingSessionStop = false

    init(
        role: CaptureAVInterruptionRole,
        sourceId: String,
        device: AnyObject,
        session: AnyObject,
        reporter: CaptureInterruptionReporter,
        observations: CaptureNotificationObservationSource = .foundation(),
        names: CaptureAVInterruptionNotificationNames = .avFoundation
    ) {
        precondition(!sourceId.isEmpty && sourceId.utf8.count <= 256)
        self.role = role
        self.sourceId = sourceId
        expectedDevice = device
        expectedSession = session
        self.reporter = reporter
        self.observations = observations
        self.names = names
    }

    func startObserving() {
        lock.lock()
        precondition(!observing)
        precondition(!invalidated)
        observing = true
        lock.unlock()

        let created = [
            observe(names.deviceDisconnected, event: .deviceDisconnected),
            observe(names.sessionInterrupted, event: .sessionInterrupted),
            observe(names.runtimeError, event: .runtimeError),
            observe(names.sessionStopped, event: .sessionStopped),
        ]

        lock.lock()
        if invalidated {
            lock.unlock()
            for cancellation in created {
                cancellation.cancel()
            }
            return
        }
        cancellations = created
        lock.unlock()

        reporter.registerObserverTeardown { [weak self] in
            self?.invalidate()
        }
    }

    /// Called on the source's session queue immediately after `startRunning`
    /// establishes that the exact session is running.
    func confirmRunning() {
        let shouldReportSessionStop: Bool
        lock.lock()
        guard !invalidated else {
            lock.unlock()
            return
        }
        confirmedRunning = true
        shouldReportSessionStop = pendingSessionStop
        pendingSessionStop = false
        lock.unlock()
        if shouldReportSessionStop {
            _ = reporter.report(
                incident: role.sessionStopped,
                sourceId: sourceId
            )
        }
    }

    func invalidate() {
        let pending: [CaptureInterruptionObserverCancellation]
        lock.lock()
        guard !invalidated else {
            lock.unlock()
            return
        }
        invalidated = true
        confirmedRunning = false
        pendingSessionStop = false
        pending = cancellations
        cancellations.removeAll(keepingCapacity: false)
        lock.unlock()
        for cancellation in pending {
            cancellation.cancel()
        }
    }

    private func observe(
        _ name: Notification.Name,
        event: Event
    ) -> CaptureInterruptionObserverCancellation {
        observations.observe(name: name) { [weak self] notification in
            self?.receive(event, notification: notification)
        }
    }

    private func receive(
        _ event: Event,
        notification: Notification
    ) {
        lock.lock()
        guard !invalidated else {
            lock.unlock()
            return
        }

        let matchesExpectedObject: Bool
        let incident: CaptureInterruptionIncident
        switch event {
        case .deviceDisconnected:
            matchesExpectedObject =
                (notification.object as AnyObject?) === expectedDevice
            incident = role.deviceDisconnected
        case .sessionInterrupted:
            matchesExpectedObject =
                (notification.object as AnyObject?) === expectedSession
            incident = role.sessionInterrupted
        case .runtimeError:
            matchesExpectedObject =
                (notification.object as AnyObject?) === expectedSession
            incident = role.runtimeError
        case .sessionStopped:
            matchesExpectedObject =
                (notification.object as AnyObject?) === expectedSession
            incident = role.sessionStopped
        }
        guard matchesExpectedObject else {
            lock.unlock()
            return
        }
        if case .sessionStopped = event, !confirmedRunning {
            pendingSessionStop = true
            lock.unlock()
            return
        }
        _ = reporter.report(incident: incident, sourceId: sourceId)
        lock.unlock()
    }
}
