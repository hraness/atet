import AVFoundation
import Darwin
import Foundation

private final class ActiveSegment: @unchecked Sendable {
    let index: Int
    let start: TimelineStamp
    let screen: ScreenSegmentRecorder
    let camera: CameraSegmentRecorder?
    let cameraUnavailableReason: String
    let microphone: MicrophoneSegmentRecorder?
    let microphoneUnavailableReason: String
    let metadata: MetadataCoordinator?
    let diagnostics: [CaptureDiagnostic]
    let selectedSources: CaptureControllerRequestlessObject
    let interruptionReporter: CaptureInterruptionReporter

    init(
        index: Int,
        start: TimelineStamp,
        screen: ScreenSegmentRecorder,
        camera: CameraSegmentRecorder?,
        cameraUnavailableReason: String,
        microphone: MicrophoneSegmentRecorder?,
        microphoneUnavailableReason: String,
        metadata: MetadataCoordinator?,
        diagnostics: [CaptureDiagnostic],
        selectedSources: CaptureControllerRequestlessObject,
        interruptionReporter: CaptureInterruptionReporter
    ) {
        self.index = index
        self.start = start
        self.screen = screen
        self.camera = camera
        self.cameraUnavailableReason = cameraUnavailableReason
        self.microphone = microphone
        self.microphoneUnavailableReason = microphoneUnavailableReason
        self.metadata = metadata
        self.diagnostics = diagnostics
        self.selectedSources = selectedSources
        self.interruptionReporter = interruptionReporter
    }
}

private struct PreparedCaptureStart: Sendable {
    let index: Int
    let start: TimelineStamp
    let timelineInterval: TimelinePreparedInterval
    let scope: CaptureSegmentCloseScope
    let coordinator: CaptureControllerStartCoordinator
    let fallbackState: HelperState
    let interruptionReporter: CaptureInterruptionReporter
}

private enum CameraStartAttempt: @unchecked Sendable {
    case notRequested
    case started(CameraSegmentRecorder)
    case failed(String)
}

private enum MicrophoneStartAttempt: @unchecked Sendable {
    case notRequested
    case started(MicrophoneSegmentRecorder)
    case failed(String)
}

private func attemptScreenStart(
    session: SessionDirectory,
    segmentIndex: Int,
    options: CaptureOptions,
    permissions: PermissionSnapshot,
    sources: ScreenSourceSelection,
    interruptionReporter: CaptureInterruptionReporter,
    coordinator: CaptureControllerStartCoordinator
) async -> Result<ScreenSegmentRecorder, HelperFailure> {
    let result: Result<ScreenSegmentRecorder, HelperFailure>
    do {
        result = .success(try await ScreenSegmentRecorder.start(
            session: session,
            segmentIndex: segmentIndex,
            options: options,
            permissions: permissions,
            sources: sources,
            interruptionReporter: interruptionReporter
        ))
    } catch let failure as HelperFailure {
        result = .failure(failure)
    } catch {
        result = .failure(HelperFailure(
            code: "screen-start-failed",
            message: error.localizedDescription,
            recoverable: true
        ))
    }
    switch result {
    case .success(let recorder):
        coordinator.complete(.screen, cleanup: {
            _ = try? await recorder.stop()
        })
    case .failure:
        coordinator.complete(.screen)
    }
    return result
}

private func attemptCameraStart(
    device: AVCaptureDevice?,
    session: SessionDirectory,
    segmentIndex: Int,
    interruptionReporter: CaptureInterruptionReporter,
    coordinator: CaptureControllerStartCoordinator
) async -> CameraStartAttempt {
    guard let device else {
        coordinator.complete(.camera)
        return .notRequested
    }
    let result: CameraStartAttempt
    do {
        result = .started(try await CameraSegmentRecorder.start(
            sessionDirectory: session,
            segmentIndex: segmentIndex,
            device: device,
            interruptionReporter: interruptionReporter
        ))
    } catch {
        result = .failed(error.localizedDescription)
    }
    switch result {
    case .started(let recorder):
        coordinator.complete(.camera, cleanup: {
            _ = await recorder.stop()
        })
    case .failed, .notRequested:
        coordinator.complete(.camera)
    }
    return result
}

private func attemptMicrophoneStart(
    device: AVCaptureDevice?,
    session: SessionDirectory,
    segmentIndex: Int,
    interruptionReporter: CaptureInterruptionReporter,
    coordinator: CaptureControllerStartCoordinator
) async -> MicrophoneStartAttempt {
    guard let device else {
        coordinator.complete(.microphone)
        return .notRequested
    }
    let result: MicrophoneStartAttempt
    do {
        result = .started(try await MicrophoneSegmentRecorder.start(
            sessionDirectory: session,
            segmentIndex: segmentIndex,
            device: device,
            interruptionReporter: interruptionReporter
        ))
    } catch {
        result = .failed(error.localizedDescription)
    }
    switch result {
    case .started(let recorder):
        coordinator.complete(.microphone, cleanup: {
            _ = await recorder.stop()
        })
    case .failed, .notRequested:
        coordinator.complete(.microphone)
    }
    return result
}

private func preparedFailure(
    from error: Error,
    state: HelperState
) -> CaptureControllerPreparedFailure {
    if let failure = error as? HelperFailure {
        return CaptureControllerPreparedFailure(
            code: failure.code,
            message: controllerFailureMessage(failure.message),
            recoverable: failure.recoverable,
            state: state
        )
    }
    return CaptureControllerPreparedFailure(
        code: "segment-start-failed",
        message: controllerFailureMessage(error.localizedDescription),
        recoverable: false,
        state: state
    )
}

private func controllerFailureMessage(_ value: String) -> String {
    let sanitized = value.replacingOccurrences(of: "\0", with: " ")
    return bounded(
        sanitized.isEmpty ? "Capture operation failed." : sanitized,
        maximumUTF8Bytes: 4_096
    )
}

private func finalMarker(for close: CaptureSegmentClose) -> String {
    switch close.cause {
    case .requested(.pause):
        return "paused"
    case .requested(.stop), .requested(.shutdown), .requested(.termination):
        return "stopped"
    case .requested(.startFailure):
        return "failed"
    case .interruption:
        return "interrupted"
    }
}

private func controllerFinalizationFailure(
    code: String,
    message: String,
    state: HelperState,
    close: CaptureSegmentClose,
    failureSourceFrontierUs: UInt64,
    recoverable: Bool = false
) -> CaptureControllerFinalizationFailure {
    do {
        let interruption = try close.resolvedUnpersistedInterruption(
            sourceFrontierUs: failureSourceFrontierUs
        )
        return try CaptureControllerFinalizationFailure(
            code: code,
            message: controllerFailureMessage(message),
            recoverable: interruption == nil ? recoverable : false,
            state: interruption == nil ? state : .stopped,
            interruption: interruption
        )
    } catch {
        preconditionFailure("Controller finalization failure is invalid.")
    }
}

private func finalizeCaptureSegment(
    _ segment: ActiveSegment,
    close: CaptureSegmentClose
) async -> CaptureControllerFinalizationOutcome {
    segment.interruptionReporter.seal()
    segment.metadata?.appendLifecycle(marker: "segment-closed")
    async let displayCompletion = segment.screen.stop()
    async let cameraCompletion: CameraRecordingCompletion = {
        if let camera = segment.camera { return await camera.stop() }
        return .unavailable(segment.cameraUnavailableReason)
    }()
    async let microphoneCompletion: MicrophoneRecordingCompletion = {
        if let microphone = segment.microphone {
            return await microphone.stop()
        }
        return .unavailable(segment.microphoneUnavailableReason)
    }()

    let camera = await cameraCompletion
    let microphone = await microphoneCompletion
    var displays: [DisplayRecordingCompletion] = []
    var displayFailure: HelperFailure?
    do {
        displays = try await displayCompletion
    } catch let failure as HelperFailure {
        displayFailure = failure
    } catch {
        displayFailure = HelperFailure(
            code: "screen-finalization-failed",
            message: "Display recording could not be finalized.",
            recoverable: false
        )
    }

    let metadataCompletion = segment.metadata?.stop(
        finalMarker: displayFailure == nil ? finalMarker(for: close) : "failed"
    ) ?? []
    if let displayFailure {
        return .failure(controllerFinalizationFailure(
            code: displayFailure.code,
            message: displayFailure.message,
            state: .stopped,
            close: close,
            failureSourceFrontierUs: segment.start.sourceTimeUs,
            recoverable: displayFailure.recoverable
        ))
    }

    let diagnostics = (
        segment.diagnostics
            + displays.flatMap(\.diagnostics)
            + camera.diagnostics
            + microphone.diagnostics
    ).prefix(32)
    do {
        let completion = try CaptureControllerRequestlessObject([
            "index": segment.index,
            "clock": [
                "kind": "mach-continuous-microseconds",
                "start": [
                    "nativeTimeUs": segment.start.nativeTimeUs,
                    "sourceTimeUs": segment.start.sourceTimeUs,
                ],
                "end": [
                    "nativeTimeUs": close.stamp.nativeTimeUs,
                    "sourceTimeUs": close.stamp.sourceTimeUs,
                ],
            ],
            "displays": displays.map(\.json),
            "camera": camera.json,
            "microphone": microphone.json,
            "metadata": metadataCompletion.map(\.json),
            "diagnostics": diagnostics.map(\.json),
            "sources": try segment.selectedSources.fields(),
        ])
        return .completion(CaptureControllerFinalizationCompletion(
            segment: completion,
            interruption: try? close.resolvedInterruption(recoverable: true)
        ))
    } catch {
        return .failure(controllerFinalizationFailure(
            code: "segment-completion-invalid",
            message: "Finalized segment metadata exceeded the protocol boundary.",
            state: .stopped,
            close: close,
            failureSourceFrontierUs: segment.start.sourceTimeUs
        ))
    }
}

private enum ControllerDeliveryResolution {
    case noOutcome
    case outcome(CaptureControllerReservedFinalization)
}

private enum ControllerEmissionDisposition {
    case nominal
    case boundedFallback
    case uncertain
}

private func emptyCaptureSourceInventory() -> [String: Any] {
    [
        "audio": [],
        "cameras": [],
        "displays": [],
    ]
}

private actor CaptureController {
    private let emitter: ProtocolEmitter
    private var state: HelperState = .unconfigured
    private var session: SessionDirectory?
    private var options = CaptureOptions.defaults
    private var selectedSources: CaptureControllerRequestlessObject?
    private var lastInterruption: CaptureInterruption?
    private var timeline: CaptureTimeline?
    private var closeGate: CaptureSegmentCloseGate?
    private var finalization = CaptureControllerFinalization()
    private var currentScope: CaptureSegmentCloseScope?
    private var currentInterruptionReporter: CaptureInterruptionReporter?
    private var pendingPreparedStart: PreparedCaptureStart?
    private var appliedFinalizationScopes: [CaptureSegmentCloseScope] = []
    private var active: ActiveSegment?
    private var nextSegmentIndex = 0
    private var completedSegmentCount = 0
    private var terminating = false
    private var terminationFinished = false
    private var controllerDeliveryLease: CaptureControllerDeliveryLease?
    private var deliveryWaiters: [CheckedContinuation<Void, Never>] = []
    private var terminationWaiters: [CheckedContinuation<Void, Never>] = []

    init(emitter: ProtocolEmitter) {
        self.emitter = emitter
    }

    func handle(_ request: CaptureRequest) async -> Bool {
        if terminating {
            await terminate(reason: "request-during-termination")
            return true
        }
        do {
            switch request.command {
            case .configure:
                if try configure(request) == .uncertainWriterFailure {
                    await terminate(reason: "stdout")
                    return true
                }
            case .start:
                try await start(requestId: request.requestId, resumed: false)
            case .resume:
                try await start(requestId: request.requestId, resumed: true)
            case .pause:
                try await pause(requestId: request.requestId)
            case .snapshot, .status:
                try await emitStatus(requestId: request.requestId)
            case .stop:
                try await stop(requestId: request.requestId)
            case .shutdown:
                await shutdown(requestId: request.requestId)
                return true
            }
        } catch let failure as HelperFailure {
            if emitter.error(
                requestId: request.requestId,
                failure: failure,
                state: state
            ) == .uncertainWriterFailure {
                await terminate(reason: "stdout")
                return true
            }
        } catch {
            if emitter.error(
                requestId: request.requestId,
                failure: HelperFailure(code: "internal-error", message: error.localizedDescription, recoverable: false),
                state: state
            ) == .uncertainWriterFailure {
                await terminate(reason: "stdout")
                return true
            }
        }
        return terminating && state == .shuttingDown
    }

    func rejectInput(_ failure: HelperFailure) async -> Bool {
        if terminating {
            await terminate(reason: "invalid-input-during-termination")
            return true
        }
        if emitter.error(
            requestId: "invalid-request",
            failure: failure,
            state: state
        ) == .uncertainWriterFailure {
            await terminate(reason: "stdout")
            return true
        }
        return false
    }

    func terminate(reason: String) async {
        _ = reason
        if terminating {
            await waitForTerminationCompletion()
            return
        }
        terminating = true
        terminationFinished = false
        if let pendingPreparedStart {
            completeUnstartedPreparedResources(pendingPreparedStart)
        }
        currentInterruptionReporter?.seal()
        while controllerDeliveryLease != nil {
            await waitForDeliveryIdle()
        }
        var ownedLease: CaptureControllerDeliveryLease?
        do {
            let lease = try reserveControllerDelivery(.termination(
                scope: currentScope
            ))
            ownedLease = lease
            switch await finalization.awaitDelivery(lease) {
            case .outcome(let outcome):
                applyFinalizationOnce(outcome)
            case .noOutcome, .deliveryUncertain:
                break
            case .invalidLease:
                throw HelperFailure(
                    code: "invalid-termination-lease",
                    message: "Capture termination ownership was lost.",
                    recoverable: false
                )
            }
            let completion = try finalization.completeDelivery(
                lease,
                disposition: .terminationDiscard
            )
            releaseControllerDelivery(lease)
            ownedLease = nil
            guard completion == .discarded else {
                finishTermination()
                return
            }
        } catch {
            if let ownedLease {
                releaseControllerDelivery(ownedLease)
            }
        }
        finishTermination()
    }

    private func configure(
        _ request: CaptureRequest
    ) throws -> ProtocolEmitterBatchResult {
        guard state == .unconfigured || state == .stopped else {
            throw invalidState("configure", expected: "unconfigured or stopped")
        }
        guard let path = request.sessionDirectory, let requestedOptions = request.options else {
            throw HelperFailure(code: "invalid-configure", message: "Configure request is incomplete.", recoverable: true)
        }
        let configuredSession = try SessionDirectory(path: path)
        let sources = try discoverSelectedSourceInventory(options: requestedOptions)
        let storedSources = try CaptureControllerRequestlessObject(sources)
        session = configuredSession
        options = requestedOptions
        selectedSources = storedSources
        lastInterruption = nil
        let configuredTimeline = CaptureTimeline()
        timeline = configuredTimeline
        closeGate = CaptureSegmentCloseGate(timeline: configuredTimeline)
        finalization = CaptureControllerFinalization()
        currentScope = nil
        currentInterruptionReporter = nil
        pendingPreparedStart = nil
        appliedFinalizationScopes.removeAll(keepingCapacity: false)
        active = nil
        nextSegmentIndex = try findNextSegmentIndex(session: configuredSession)
        completedSegmentCount = 0
        terminating = false
        terminationFinished = false
        controllerDeliveryLease = nil
        let staleWaiters = deliveryWaiters
        deliveryWaiters.removeAll(keepingCapacity: false)
        for waiter in staleWaiters {
            waiter.resume()
        }
        precondition(
            terminationWaiters.isEmpty,
            "A configured controller cannot retain termination waiters."
        )
        state = .ready
        return emitter.emit([
            "event": "configured",
            "requestId": request.requestId,
            "availableSources": discoverAvailableSourceInventory(),
            "lastInterruption": NSNull(),
            "options": options.json,
            "permissions": CapturePermissions.snapshot().json,
            "sources": sources,
            "state": HelperState.ready.rawValue,
        ])
    }

    private func start(requestId: String, resumed: Bool) async throws {
        let expectedState: HelperState = resumed ? .paused : .ready
        if resumed {
            guard state == .paused || state == .recording else {
                throw invalidState("resume", expected: "paused")
            }
        } else {
            guard state == expectedState else {
                throw invalidState("start", expected: expectedState.rawValue)
            }
        }
        guard let session, let timeline, let closeGate else {
            throw HelperFailure(code: "not-configured", message: "Configure the capture helper before starting.", recoverable: true)
        }

        if resumed {
            // Resume owns the old generation at command entry. Once its
            // delivery commits, the next generation is armed synchronously
            // before permission or source discovery can suspend.
            let lease = try reserveControllerDelivery(.flush)
            let resolution = try await awaitControllerDelivery(lease)
            var events: [[String: Any]] = []
            var failed = false
            do {
                if case .outcome(let outcome) = resolution {
                    applyFinalizationOnce(outcome)
                    events.append(try finalizationEvent(
                        outcome,
                        requestId: requestId
                    ))
                    failed = finalizationFailed(outcome)
                    if !failed, state == .recording {
                        state = .paused
                    }
                }
                guard failed || state == .paused else {
                    throw invalidState("resume", expected: "paused")
                }
            } catch {
                try rejectControllerDelivery(lease)
                throw error
            }
            let emission = try emitControllerBatch(lease, events: events)
            if emission == .uncertain {
                await terminate(reason: "stdout")
                return
            }
            guard emission == .nominal, !failed else { return }
        }

        guard nextSegmentIndex < maximumCaptureSegments else {
            throw HelperFailure(
                code: "segment-limit",
                message: "Capture reached the 128-segment protocol limit.",
                recoverable: false
            )
        }
        let prepared = try prepareStartGeneration(
            timeline: timeline,
            closeGate: closeGate,
            fallbackState: expectedState
        )
        await resolvePreparedStart(
            prepared,
            requestId: requestId,
            resumed: resumed,
            session: session,
            timeline: timeline
        )
    }

    private func resolvePreparedStart(
        _ prepared: PreparedCaptureStart,
        requestId: String,
        resumed: Bool,
        session: SessionDirectory,
        timeline: CaptureTimeline
    ) async {
        do {
            let permissions = await CapturePermissions.request(options: options)
            guard !terminating else {
                completeUnstartedPreparedResources(prepared)
                return
            }
            guard permissions.screenCapture == .authorized else {
                throw HelperFailure(
                    code: "screen-permission-denied",
                    message: "Screen Recording permission is required.",
                    recoverable: true
                )
            }
            let sources = try await resolveCaptureSources(options: options)
            guard !terminating else {
                completeUnstartedPreparedResources(prepared)
                return
            }
            try validateRequiredSources(
                permissions: permissions,
                sources: sources
            )
            await launchPreparedStart(
                prepared,
                requestId: requestId,
                resumed: resumed,
                session: session,
                timeline: timeline,
                permissions: permissions,
                sources: sources
            )
        } catch {
            completeUnstartedPreparedResources(prepared)
            await deliverPreparedStartFailure(
                prepared,
                requestId: requestId,
                error: error
            )
        }
    }

    private func prepareStartGeneration(
        timeline: CaptureTimeline,
        closeGate: CaptureSegmentCloseGate,
        fallbackState: HelperState
    ) throws -> PreparedCaptureStart {
        let segmentIndex = nextSegmentIndex
        let timelineInterval = try timeline.beginPreparedActive()
        let startStamp = timelineInterval.start
        let coordinator = CaptureControllerStartCoordinator(
            fallbackFailure: CaptureControllerPreparedFailure(
                code: "segment-start-not-announced",
                message: "Capture resources were drained before segment start was announced.",
                recoverable: true,
                state: fallbackState
            )
        )
        let reporterRegistration =
            CaptureInterruptionReporterRegistration()
        let scope: CaptureSegmentCloseScope
        do {
            scope = try finalization.beginPreparedStart(
                gate: closeGate,
                segmentIndex: segmentIndex,
                drain: CaptureControllerPreparedStartDrain(operation: {
                    close in
                    reporterRegistration.seal()
                    let failure = await coordinator.drain()
                    let discard = timeline.discardPreparedInterval(
                        timelineInterval,
                        closedAt: close.stamp
                    )
                    guard discard == .discarded
                            || discard == .alreadyDiscarded else {
                        return controllerFinalizationFailure(
                            code: "timeline-prepared-discard-failed",
                            message: "Prepared capture time could not be rolled back.",
                            state: .stopped,
                            close: close,
                            failureSourceFrontierUs:
                                timelineInterval.start.sourceTimeUs,
                            recoverable: false
                        )
                    }
                    return controllerFinalizationFailure(
                        code: failure.code,
                        message: failure.message,
                        state: failure.state,
                        close: close,
                        failureSourceFrontierUs:
                            timelineInterval.start.sourceTimeUs,
                        recoverable: failure.recoverable
                    )
                })
            )
        } catch {
            if let close = try? timeline.endActive() {
                _ = timeline.discardPreparedInterval(
                    timelineInterval,
                    closedAt: close
                )
            }
            throw error
        }
        let finalizationEngine = finalization
        let interruptionReporter = CaptureInterruptionReporter(
            segmentIndex: segmentIndex,
            submit: { [weak finalizationEngine] seed in
                guard let finalizationEngine else { return }
                _ = try? finalizationEngine.acceptInterruption(
                    scope: scope,
                    seed: seed
                )
            }
        )
        reporterRegistration.install(interruptionReporter)
        nextSegmentIndex += 1
        currentScope = scope
        currentInterruptionReporter = interruptionReporter
        let prepared = PreparedCaptureStart(
            index: segmentIndex,
            start: startStamp,
            timelineInterval: timelineInterval,
            scope: scope,
            coordinator: coordinator,
            fallbackState: fallbackState,
            interruptionReporter: interruptionReporter
        )
        pendingPreparedStart = prepared
        return prepared
    }

    private func completeUnstartedPreparedResources(
        _ prepared: PreparedCaptureStart
    ) {
        prepared.interruptionReporter.seal()
        if pendingPreparedStart?.scope == prepared.scope {
            pendingPreparedStart = nil
        }
        prepared.coordinator.completeUnstarted(
            Set(CaptureControllerPreparedProducer.allCases)
        )
    }

    private func launchPreparedStart(
        _ prepared: PreparedCaptureStart,
        requestId: String,
        resumed: Bool,
        session: SessionDirectory,
        timeline: CaptureTimeline,
        permissions: PermissionSnapshot,
        sources: ResolvedCaptureSources
    ) async {
        if terminating {
            completeUnstartedPreparedResources(prepared)
            return
        }
        if pendingPreparedStart?.scope == prepared.scope {
            pendingPreparedStart = nil
        }
        var metadata: MetadataCoordinator?
        do {
            if options.metadata {
                let metadataCoordinator = try MetadataCoordinator(
                    session: session,
                    segmentIndex: prepared.index,
                    clock: timeline,
                    options: options
                )
                metadata = metadataCoordinator
                try metadataCoordinator.prepareInputEventTap()
                // Metadata brackets every retained sample, so it starts before
                // the recorders and publishes cleanup before it resolves.
                try metadataCoordinator.start(marker: "segment-opened")
                prepared.coordinator.complete(.metadata, cleanup: {
                    _ = metadataCoordinator.stop(finalMarker: "failed")
                })
            } else {
                prepared.coordinator.complete(.metadata)
            }
        } catch {
            if let metadata {
                prepared.coordinator.complete(.metadata, cleanup: {
                    _ = metadata.stop(finalMarker: "failed")
                })
            } else {
                prepared.coordinator.complete(.metadata)
            }
            prepared.coordinator.completeUnstarted([
                .screen,
                .camera,
                .microphone,
            ])
            await deliverPreparedStartFailure(
                prepared,
                requestId: requestId,
                error: error
            )
            return
        }

        let shouldStartCamera = options.camera.requested
            && permissions.camera == .authorized
            && sources.camera != nil
        let shouldStartMicrophone = options.microphone.requested
            && permissions.microphone == .authorized
            && sources.microphone != nil
        async let screenAttempt = attemptScreenStart(
            session: session,
            segmentIndex: prepared.index,
            options: options,
            permissions: permissions,
            sources: sources.screen,
            interruptionReporter: prepared.interruptionReporter,
            coordinator: prepared.coordinator
        )
        async let cameraAttempt = attemptCameraStart(
            device: shouldStartCamera ? sources.camera : nil,
            session: session,
            segmentIndex: prepared.index,
            interruptionReporter: prepared.interruptionReporter,
            coordinator: prepared.coordinator
        )
        async let microphoneAttempt = attemptMicrophoneStart(
            device: shouldStartMicrophone ? sources.microphone : nil,
            session: session,
            segmentIndex: prepared.index,
            interruptionReporter: prepared.interruptionReporter,
            coordinator: prepared.coordinator
        )
        let (resolvedScreen, resolvedCamera, resolvedMicrophone) = await (
            screenAttempt,
            cameraAttempt,
            microphoneAttempt
        )
        guard !terminating else { return }

        var screen: ScreenSegmentRecorder?
        var camera: CameraSegmentRecorder?
        var microphone: MicrophoneSegmentRecorder?
        var diagnostics = unavailableSourceDiagnostics(
            permissions: permissions
        )
        var cameraUnavailableReason = options.camera.requested
            ? "start-failed"
            : "disabled"
        var microphoneUnavailableReason = options.microphone.requested
            ? "start-failed"
            : "disabled"
        var startFailure: HelperFailure?

        if case .started(let recorder) = resolvedCamera { camera = recorder }
        if case .started(let recorder) = resolvedMicrophone {
            microphone = recorder
        }
        switch resolvedScreen {
        case .success(let recorder):
            screen = recorder
        case .failure(let failure):
            startFailure = failure
        }
        switch resolvedCamera {
        case .started:
            break
        case .failed(let message):
            diagnostics.append(CaptureDiagnostic(
                code: "camera-start-failed",
                message: message,
                recoverable: !options.strictSources,
                source: "camera"
            ))
            if options.strictSources, startFailure == nil {
                startFailure = HelperFailure(
                    code: "camera-start-failed",
                    message: message,
                    recoverable: true
                )
            }
        case .notRequested:
            if options.camera.requested {
                cameraUnavailableReason = cameraReason(
                    permission: permissions.camera,
                    deviceAvailable: sources.camera != nil
                )
            }
        }
        switch resolvedMicrophone {
        case .started:
            break
        case .failed(let message):
            diagnostics.append(CaptureDiagnostic(
                code: "microphone-start-failed",
                message: message,
                recoverable: !options.strictSources,
                source: "microphone"
            ))
            if options.strictSources, startFailure == nil {
                startFailure = HelperFailure(
                    code: "microphone-start-failed",
                    message: message,
                    recoverable: true
                )
            }
        case .notRequested:
            if options.microphone.requested {
                microphoneUnavailableReason = microphoneReason(
                    permission: permissions.microphone,
                    deviceAvailable: sources.microphone != nil
                )
            }
        }
        if screen == nil, startFailure == nil {
            startFailure = HelperFailure(
                code: "screen-start-failed",
                message: "Screen capture did not initialize.",
                recoverable: true
            )
        }
        if let startFailure {
            await deliverPreparedStartFailure(
                prepared,
                requestId: requestId,
                error: startFailure
            )
            return
        }
        guard let screen else {
            preconditionFailure(
                "A prepared start without a failure must own its screen recorder."
            )
        }

        let selectedSourceInventory: CaptureControllerRequestlessObject
        let started: CaptureControllerRequestlessObject
        let startedEvent: [String: Any]
        do {
            selectedSourceInventory = try CaptureControllerRequestlessObject(
                sources.inventoryJSON(
                    systemAudioRequested: options.systemAudio
                )
            )
            started = try CaptureControllerRequestlessObject([
                "index": prepared.index,
                "nativeStartUs": prepared.start.nativeTimeUs,
                "permissions": permissions.json,
                "sources": try selectedSourceInventory.fields(),
                "startUs": prepared.start.sourceTimeUs,
            ])
            startedEvent = try started.protocolObject(
                event: "segment-started",
                requestId: requestId
            )
        } catch {
            await deliverPreparedStartFailure(
                prepared,
                requestId: requestId,
                error: error
            )
            return
        }
        let activeSegment = ActiveSegment(
            index: prepared.index,
            start: prepared.start,
            screen: screen,
            camera: camera,
            cameraUnavailableReason: cameraUnavailableReason,
            microphone: microphone,
            microphoneUnavailableReason: microphoneUnavailableReason,
            metadata: metadata,
            diagnostics: diagnostics,
            selectedSources: selectedSourceInventory,
            interruptionReporter: prepared.interruptionReporter
        )

        let announcement: CaptureControllerStartAnnouncementBeginResult
        do {
            announcement = try finalization.beginStartAnnouncement(
                scope: prepared.scope,
                activeJob: { close in
                    await finalizeCaptureSegment(activeSegment, close: close)
                }
            )
        } catch {
            await deliverPreparedStartFailure(
                prepared,
                requestId: requestId,
                error: error
            )
            return
        }
        guard case .began(let token) = announcement else {
            switch announcement {
            case .closed:
                await deliverClosedPreparedStart(
                    requestId: requestId
                )
                return
            case .deliveryUncertain:
                await terminate(reason: "stdout")
                return
            default:
                await deliverPreparedStartFailure(
                    prepared,
                    requestId: requestId,
                    error: HelperFailure(
                        code: "segment-start-ownership-lost",
                        message: "Capture start ownership changed before announcement.",
                        recoverable: false
                    )
                )
                return
            }
        }

        active = activeSegment
        let emission = emitter.emitBatch([startedEvent])
        let announcementDisposition:
            CaptureControllerStartAnnouncementDisposition
        switch emission {
        case .confirmedNominal:
            announcementDisposition = .confirmed
        case .confirmedBoundedFallback:
            prepared.interruptionReporter.seal()
            announcementDisposition = .rejectedBeforeWrite
        case .uncertainWriterFailure:
            prepared.interruptionReporter.seal()
            announcementDisposition = .uncertainPartialOrWriterFailure
        }
        if case .confirmedNominal = emission {
            let commit = timeline.commitPreparedInterval(
                prepared.timelineInterval
            )
            precondition(
                commit == .committed,
                "A confirmed segment start must commit its prepared timeline interval."
            )
            selectedSources = selectedSourceInventory
            metadata?.appendLifecycle(
                marker: resumed ? "resumed" : "recording-started"
            )
        }
        let finish: CaptureControllerStartAnnouncementFinishResult
        do {
            finish = try finalization.finishStartAnnouncement(
                token: token,
                disposition: announcementDisposition
            )
        } catch {
            preconditionFailure(
                "A valid start-announcement token must always settle: \(error)"
            )
        }
        switch (emission, finish) {
        case (.confirmedNominal, .activated),
             (.confirmedNominal, .finalizing):
            state = .recording
        case (.confirmedBoundedFallback, .finalizing):
            active = nil
            state = prepared.fallbackState
        case (.uncertainWriterFailure, .deliveryUncertain):
            active = nil
            await terminate(reason: "stdout")
        default:
            active = nil
            await terminate(reason: "start-announcement")
        }
    }

    private func deliverClosedPreparedStart(
        requestId: String
    ) async {
        guard !terminating, controllerDeliveryLease == nil else { return }
        do {
            let lease = try reserveControllerDelivery(.observe)
            let resolution = try await awaitControllerDelivery(lease)
            guard case .outcome(let outcome) = resolution else {
                try rejectControllerDelivery(lease)
                throw HelperFailure(
                    code: "missing-closed-prepared-segment",
                    message: "Closed capture preparation produced no outcome.",
                    recoverable: false
                )
            }
            applyFinalizationOnce(outcome)
            let event: [String: Any]
            do {
                event = try finalizationEvent(
                    outcome,
                    requestId: requestId
                )
            } catch {
                try rejectControllerDelivery(lease)
                throw error
            }
            let emission = try emitControllerBatch(
                lease,
                events: [event]
            )
            if emission == .uncertain {
                await terminate(reason: "stdout")
            }
        } catch {
            guard !terminating else { return }
            if emitter.error(
                requestId: requestId,
                failure: HelperFailure(
                    code: "closed-start-delivery-failed",
                    message: error.localizedDescription,
                    recoverable: false
                ),
                state: state
            ) == .uncertainWriterFailure {
                await terminate(reason: "stdout")
            }
        }
    }

    private func deliverPreparedStartFailure(
        _ prepared: PreparedCaptureStart,
        requestId: String,
        error: Error
    ) async {
        prepared.interruptionReporter.seal()
        prepared.coordinator.replaceFailure(preparedFailure(
            from: error,
            state: prepared.fallbackState
        ))
        guard !terminating else { return }

        do {
            let lease = try reserveControllerDelivery(.close(
                scope: prepared.scope,
                reason: .startFailure
            ))
            let resolution = try await awaitControllerDelivery(lease)
            guard case .outcome(let outcome) = resolution else {
                try rejectControllerDelivery(lease)
                throw HelperFailure(
                    code: "missing-prepared-segment",
                    message: "Prepared capture cleanup produced no outcome.",
                    recoverable: false
                )
            }
            applyFinalizationOnce(outcome)
            let event: [String: Any]
            do {
                event = try finalizationEvent(
                    outcome,
                    requestId: requestId
                )
            } catch {
                try rejectControllerDelivery(lease)
                throw error
            }
            let emission = try emitControllerBatch(
                lease,
                events: [event]
            )
            if emission == .uncertain {
                await terminate(reason: "stdout")
            }
        } catch {
            guard !terminating else { return }
            if emitter.error(
                requestId: requestId,
                failure: HelperFailure(
                    code: "segment-start-cleanup-failed",
                    message: error.localizedDescription,
                    recoverable: false
                ),
                state: state
            ) == .uncertainWriterFailure {
                await terminate(reason: "stdout")
            }
        }
    }

    private func pause(requestId: String) async throws {
        guard state == .recording, let scope = currentScope else {
            throw invalidState("pause", expected: "recording")
        }
        currentInterruptionReporter?.seal()
        active?.metadata?.appendLifecycle(marker: "pause-requested")
        let lease = try reserveControllerDelivery(.close(
            scope: scope,
            reason: .pause
        ))
        let resolution = try await awaitControllerDelivery(lease)
        guard case .outcome(let outcome) = resolution else {
            try rejectControllerDelivery(lease)
            throw HelperFailure(
                code: "missing-active-segment",
                message: "Pause did not own an active segment finalizer.",
                recoverable: false
            )
        }
        applyFinalizationOnce(outcome)
        let failed = finalizationFailed(outcome)
        if !failed { state = .paused }
        let event: [String: Any]
        do {
            event = try finalizationEvent(
                outcome,
                requestId: requestId
            )
        } catch {
            try rejectControllerDelivery(lease)
            throw error
        }
        let events = [event]
        let emission = try emitControllerBatch(lease, events: events)
        if emission == .uncertain {
            await terminate(reason: "stdout")
        }
    }

    private func stop(requestId: String) async throws {
        guard state == .recording || state == .paused || state == .ready else {
            throw invalidState("stop", expected: "ready, recording, or paused")
        }
        let lease: CaptureControllerDeliveryLease
        if let scope = currentScope {
            currentInterruptionReporter?.seal()
            active?.metadata?.appendLifecycle(marker: "stop-requested")
            lease = try reserveControllerDelivery(.close(
                scope: scope,
                reason: .stop
            ))
        } else {
            lease = try reserveControllerDelivery(.observe)
        }
        let resolution = try await awaitControllerDelivery(lease)
        var events: [[String: Any]] = []
        var failed = false
        do {
            if case .outcome(let outcome) = resolution {
                applyFinalizationOnce(outcome)
                events.append(try finalizationEvent(
                    outcome,
                    requestId: requestId
                ))
                failed = finalizationFailed(outcome)
            }
        } catch {
            try rejectControllerDelivery(lease)
            throw error
        }
        state = .stopped
        if !failed {
            events.append(sessionCompletedEvent(requestId: requestId))
        }
        let emission = try emitControllerBatch(lease, events: events)
        if emission == .uncertain {
            await terminate(reason: "stdout")
        }
    }

    private func shutdown(requestId: String) async {
        if state == .unconfigured || state == .stopped {
            state = .shuttingDown
            if emitter.emit([
                "event": "shutdown",
                "requestId": requestId,
            ]) == .uncertainWriterFailure {
                await terminate(reason: "stdout")
            }
            return
        }
        do {
            let lease: CaptureControllerDeliveryLease
            if let scope = currentScope {
                currentInterruptionReporter?.seal()
                active?.metadata?.appendLifecycle(marker: "stop-requested")
                lease = try reserveControllerDelivery(.close(
                    scope: scope,
                    reason: .shutdown
                ))
            } else {
                lease = try reserveControllerDelivery(.observe)
            }
            let resolution = try await awaitControllerDelivery(lease)
            var events: [[String: Any]] = []
            var failed = false
            do {
                if case .outcome(let outcome) = resolution {
                    applyFinalizationOnce(outcome)
                    events.append(try finalizationEvent(
                        outcome,
                        requestId: requestId
                    ))
                    failed = finalizationFailed(outcome)
                }
            } catch {
                try rejectControllerDelivery(lease)
                throw error
            }
            state = .stopped
            if !failed {
                events.append(sessionCompletedEvent(requestId: requestId))
                events.append([
                    "event": "shutdown",
                    "requestId": requestId,
                ])
            }
            let emission = try emitControllerBatch(lease, events: events)
            if emission == .uncertain {
                await terminate(reason: "stdout")
            }
        } catch {
            if emitter.error(
                requestId: requestId,
                failure: HelperFailure(
                    code: "finalization-failed",
                    message: error.localizedDescription,
                    recoverable: false
                ),
                state: state
            ) == .uncertainWriterFailure {
                await terminate(reason: "stdout")
            }
        }
        state = .shuttingDown
    }

    private func emitStatus(requestId: String) async throws {
        let lease = try reserveControllerDelivery(.observe)
        let resolution = try await awaitControllerDelivery(lease)
        var events: [[String: Any]] = []
        var failed = false
        do {
            if case .outcome(let outcome) = resolution {
                applyFinalizationOnce(outcome)
                events.append(try finalizationEvent(
                    outcome,
                    requestId: requestId
                ))
                failed = finalizationFailed(outcome)
                if !failed, state == .recording {
                    state = .paused
                }
            }
            if !failed {
                events.append([
                    "event": "status",
                    "requestId": requestId,
                    "activeSegmentIndex": active?.index as Any? ?? NSNull(),
                    "completedSegmentCount": completedSegmentCount,
                    "logicalTimeUs": timeline?.sample().sourceTimeUs ?? 0,
                    "availableSources": discoverAvailableSourceInventory(),
                    "lastInterruption":
                        (lastInterruption?.json as Any?) ?? NSNull(),
                    "permissions": CapturePermissions.snapshot().json,
                    "sources": try selectedSources?.fields()
                        ?? emptyCaptureSourceInventory(),
                    "state": state.rawValue,
                ])
            }
        } catch {
            try rejectControllerDelivery(lease)
            throw error
        }
        let emission = try emitControllerBatch(lease, events: events)
        if emission == .uncertain {
            await terminate(reason: "stdout")
        }
    }

    private func reserveControllerDelivery(
        _ request: CaptureControllerDeliveryRequest
    ) throws -> CaptureControllerDeliveryLease {
        guard controllerDeliveryLease == nil else {
            throw HelperFailure(
                code: "delivery-busy",
                message: "Another capture command owns protocol delivery.",
                recoverable: true
            )
        }
        let result = try finalization.reserveDelivery(request)
        guard case .reserved(let lease) = result else {
            let message: String
            switch result {
            case .busy:
                message = "Another capture command owns protocol delivery."
            case .inactive:
                message = "No capture generation is active."
            case .closed:
                message = "The requested capture generation is already closed."
            case .stale:
                message = "The requested capture generation is stale."
            case .deliveryUncertain:
                message = "Capture protocol delivery is uncertain."
            case .reserved:
                preconditionFailure("Reserved delivery must expose its lease.")
            }
            throw HelperFailure(
                code: "delivery-unavailable",
                message: message,
                recoverable: false
            )
        }
        controllerDeliveryLease = lease
        return lease
    }

    private func awaitControllerDelivery(
        _ lease: CaptureControllerDeliveryLease
    ) async throws -> ControllerDeliveryResolution {
        switch await finalization.awaitDelivery(lease) {
        case .noOutcome:
            return .noOutcome
        case .outcome(let outcome):
            return .outcome(outcome)
        case .deliveryUncertain:
            do {
                _ = try finalization.completeDelivery(
                    lease,
                    disposition: .uncertainPartialOrWriterFailure
                )
            } catch {
                releaseControllerDelivery(lease)
                throw error
            }
            releaseControllerDelivery(lease)
            await terminate(reason: "stdout")
            throw HelperFailure(
                code: "delivery-uncertain",
                message: "Capture protocol delivery is uncertain.",
                recoverable: false
            )
        case .invalidLease:
            releaseControllerDelivery(lease)
            throw HelperFailure(
                code: "invalid-delivery-lease",
                message: "Capture delivery ownership was lost.",
                recoverable: false
            )
        }
    }

    private func emitControllerBatch(
        _ lease: CaptureControllerDeliveryLease,
        events: [[String: Any]]
    ) throws -> ControllerEmissionDisposition {
        let result = events.isEmpty
            ? ProtocolEmitterBatchResult.confirmedNominal(eventCount: 0)
            : emitter.emitBatch(events)
        let engineDisposition: CaptureControllerDeliveryDisposition
        let expectedCompletion: CaptureControllerDeliveryCompletionResult
        let disposition: ControllerEmissionDisposition
        switch result {
        case .confirmedNominal:
            engineDisposition = .confirmed
            expectedCompletion = .confirmed
            disposition = .nominal
        case .confirmedBoundedFallback:
            engineDisposition = .rejectedBeforeWrite
            expectedCompletion = .releasedPreservingEvidence
            disposition = .boundedFallback
        case .uncertainWriterFailure:
            engineDisposition = .uncertainPartialOrWriterFailure
            expectedCompletion = .enteredDeliveryUncertain
            disposition = .uncertain
        }
        let completion: CaptureControllerDeliveryCompletionResult
        do {
            completion = try finalization.completeDelivery(
                lease,
                disposition: engineDisposition
            )
        } catch {
            releaseControllerDelivery(lease)
            throw error
        }
        releaseControllerDelivery(lease)
        guard completion == expectedCompletion else {
            throw HelperFailure(
                code: "delivery-commit-failed",
                message: "Capture delivery could not commit its ownership.",
                recoverable: false
            )
        }
        return disposition
    }

    private func rejectControllerDelivery(
        _ lease: CaptureControllerDeliveryLease
    ) throws {
        let result: CaptureControllerDeliveryCompletionResult
        do {
            result = try finalization.completeDelivery(
                lease,
                disposition: .rejectedBeforeWrite
            )
        } catch {
            releaseControllerDelivery(lease)
            throw error
        }
        releaseControllerDelivery(lease)
        guard result == .releasedPreservingEvidence else {
            throw HelperFailure(
                code: "delivery-release-failed",
                message: "Capture delivery could not preserve its evidence.",
                recoverable: false
            )
        }
    }

    private func releaseControllerDelivery(
        _ lease: CaptureControllerDeliveryLease
    ) {
        guard controllerDeliveryLease == lease else { return }
        controllerDeliveryLease = nil
        let waiters = deliveryWaiters
        deliveryWaiters.removeAll(keepingCapacity: false)
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func waitForDeliveryIdle() async {
        guard controllerDeliveryLease != nil else { return }
        await withCheckedContinuation { continuation in
            deliveryWaiters.append(continuation)
        }
    }

    private func waitForTerminationCompletion() async {
        guard !terminationFinished else { return }
        await withCheckedContinuation { continuation in
            terminationWaiters.append(continuation)
        }
    }

    private func finishTermination() {
        state = .shuttingDown
        terminationFinished = true
        let waiters = terminationWaiters
        terminationWaiters.removeAll(keepingCapacity: false)
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func applyFinalizationOnce(
        _ reserved: CaptureControllerReservedFinalization
    ) {
        guard !appliedFinalizationScopes.contains(reserved.close.scope) else {
            return
        }
        precondition(
            appliedFinalizationScopes.count < maximumCaptureSegments,
            "Capture finalization accounting exceeded the protocol segment limit."
        )
        appliedFinalizationScopes.append(reserved.close.scope)
        if currentScope == reserved.close.scope {
            currentScope = nil
            currentInterruptionReporter = nil
            if pendingPreparedStart?.scope == reserved.close.scope {
                pendingPreparedStart = nil
            }
            active = nil
        }
        switch reserved.outcome {
        case .completion(let completion):
            completedSegmentCount += 1
            if let interruption = completion.interruption {
                lastInterruption = interruption
            }
        case .failure(let failure):
            state = failure.state
            if let interruption = failure.interruption {
                lastInterruption = interruption
            }
        }
    }

    private func finalizationEvent(
        _ reserved: CaptureControllerReservedFinalization,
        requestId: String
    ) throws -> [String: Any] {
        switch reserved.outcome {
        case .completion(let completion):
            return [
                "event": "segment-completed",
                "interruption":
                    (completion.interruption?.json as Any?) ?? NSNull(),
                "requestId": requestId,
                "segment": try completion.segment.fields(),
            ]
        case .failure(let failure):
            return [
                "code": failure.code,
                "event": "error",
                "interruption":
                    (failure.interruption?.json as Any?) ?? NSNull(),
                "message": failure.message,
                "recoverable": failure.recoverable,
                "requestId": requestId,
                "state": failure.state.rawValue,
            ]
        }
    }

    private func finalizationFailed(
        _ reserved: CaptureControllerReservedFinalization
    ) -> Bool {
        if case .failure = reserved.outcome { return true }
        return false
    }

    private func sessionCompletedEvent(requestId: String) -> [String: Any] {
        [
            "event": "session-completed",
            "requestId": requestId,
            "durationUs": timeline?.sample().sourceTimeUs ?? 0,
            "segmentCount": completedSegmentCount,
            "state": HelperState.stopped.rawValue,
        ]
    }

    private func validateRequiredSources(
        permissions: PermissionSnapshot,
        sources: ResolvedCaptureSources
    ) throws {
        guard permissions.screenCapture == .authorized else {
            throw HelperFailure(code: "screen-permission-denied", message: "Screen Recording permission is required.", recoverable: true)
        }
        if options.strictSources {
            if options.camera.requested {
                guard permissions.camera == .authorized else {
                    throw HelperFailure(code: "camera-permission-denied", message: "Strict capture requires Camera permission.", recoverable: true)
                }
                guard sources.camera != nil else {
                    throw HelperFailure(code: "camera-missing", message: "Strict capture requires an available camera.", recoverable: true)
                }
            }
            if options.microphone.requested {
                guard permissions.microphone == .authorized else {
                    throw HelperFailure(code: "microphone-permission-denied", message: "Strict capture requires Microphone permission.", recoverable: true)
                }
                guard sources.microphone != nil else {
                    throw HelperFailure(code: "microphone-missing", message: "Strict capture requires an available microphone.", recoverable: true)
                }
            }
            if options.metadata && permissions.inputMonitoring != .authorized {
                throw HelperFailure(code: "input-monitoring-denied", message: "Strict capture requires Input Monitoring for interaction metadata.", recoverable: true)
            }
            if options.metadata && permissions.accessibility != .authorized {
                throw HelperFailure(code: "accessibility-denied", message: "Strict capture requires Accessibility for focused-input metadata.", recoverable: true)
            }
        }
    }

    private func unavailableSourceDiagnostics(permissions: PermissionSnapshot) -> [CaptureDiagnostic] {
        var diagnostics: [CaptureDiagnostic] = []
        if options.camera.requested && permissions.camera != .authorized {
            diagnostics.append(CaptureDiagnostic(code: "camera-unavailable", message: "Camera capture is unavailable because permission is not authorized.", recoverable: true, source: "camera"))
        }
        if options.microphone.requested && permissions.microphone != .authorized {
            diagnostics.append(CaptureDiagnostic(code: "microphone-unavailable", message: "Microphone capture is unavailable because permission is not authorized.", recoverable: true, source: "microphone"))
        }
        if options.metadata && permissions.inputMonitoring != .authorized {
            diagnostics.append(CaptureDiagnostic(code: "input-monitoring-unavailable", message: "Click and key activity are unavailable; the native cursor remains in display video.", recoverable: true, source: "metadata"))
        }
        if options.metadata && permissions.accessibility != .authorized {
            diagnostics.append(CaptureDiagnostic(code: "accessibility-unavailable", message: "Focused-input metadata is unavailable.", recoverable: true, source: "metadata"))
        }
        return diagnostics
    }

    private func cameraReason(
        permission: PermissionState,
        deviceAvailable: Bool
    ) -> String {
        switch permission {
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .authorized: return deviceAvailable ? "start-failed" : "missing"
        case .notDetermined, .unavailable: return "missing"
        }
    }

    private func microphoneReason(
        permission: PermissionState,
        deviceAvailable: Bool
    ) -> String {
        switch permission {
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .authorized: return deviceAvailable ? "start-failed" : "missing"
        case .notDetermined, .unavailable: return "missing"
        }
    }

    private func findNextSegmentIndex(session: SessionDirectory) throws -> Int {
        var highestUsedIndex = -1
        for index in 0..<maximumCaptureSegments {
            let segmentPath = String(format: "segments/segment_%04d", index + 1)
            let eventPath = String(format: "events/segment_%04d-cursor.jsonl", index + 1)
            let segmentURL = try session.outputURL(segmentPath, requireAbsent: false)
            let eventURL = try session.outputURL(eventPath, requireAbsent: false)
            if FileManager.default.fileExists(atPath: segmentURL.path)
                || FileManager.default.fileExists(atPath: eventURL.path) {
                highestUsedIndex = index
            }
        }
        let next = highestUsedIndex + 1
        guard next < maximumCaptureSegments else {
            throw HelperFailure(code: "segment-limit", message: "Session already contains 128 capture segments.", recoverable: false)
        }
        return next
    }

    private func invalidState(_ command: String, expected: String) -> HelperFailure {
        HelperFailure(
            code: "invalid-state",
            message: "Cannot \(command) while helper state is \(state.rawValue); expected \(expected).",
            recoverable: true
        )
    }
}

private enum InputRecord {
    case line(String)
    case oversized
    case invalidUTF8
    case endOfFile
}

private final class BoundedLineReader {
    private var buffer = Data()
    private var discardingOversizedLine = false

    func next() -> InputRecord {
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
            let chunk = FileHandle.standardInput.readData(ofLength: 4_096)
            if chunk.isEmpty {
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
            if discardingOversizedLine {
                if let newline = chunk.firstIndex(of: 0x0A) {
                    buffer = Data(chunk[chunk.index(after: newline)...])
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

@main
struct CaptureHelper {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--version"] {
            writeCommandLineOutput("\(captureHelperVersion)\n")
            return
        }
        if arguments == ["--json"] {
            let snapshot: [String: Any] = [
                "helperVersion": captureHelperVersion,
                "protocolVersion": captureProtocolVersion,
                "capabilities": [
                    "availableSources": true,
                    "camera": true,
                    "displayRecording": true,
                    "interruptionDiagnostics": true,
                    "metadata": true,
                    "microphone": true,
                    "minimumMacOSMajorVersion": 15,
                    "systemAudio": true,
                    "typedTextOptIn": true,
                ],
                "permissions": CapturePermissions.snapshot().json,
                "availableSources": discoverAvailableSourceInventory(),
            ]
            if let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]),
               let line = String(data: data, encoding: .utf8) {
                writeCommandLineOutput("\(line)\n")
                return
            }
            Darwin.exit(70)
        }
        if arguments.count == 2, arguments[0] == "--interaction-fixture" {
            guard let fixtureId = InteractionFixture.canonicalIdentifier(arguments[1]) else {
                let usage = "usage: transmute-capture [--version|--json|--interaction-fixture <canonical-uuid>]\n"
                try? FileHandle.standardError.write(contentsOf: Data(usage.utf8))
                Darwin.exit(64)
            }
            let fixtureExitCode = InteractionFixture.run(fixtureId: fixtureId)
            if fixtureExitCode != 0 { Darwin.exit(fixtureExitCode) }
            return
        }
        if !arguments.isEmpty {
            let usage = "usage: transmute-capture [--version|--json|--interaction-fixture <canonical-uuid>]\n"
            try? FileHandle.standardError.write(contentsOf: Data(usage.utf8))
            Darwin.exit(64)
        }
        let emitter = ProtocolEmitter()
        let controller = CaptureController(emitter: emitter)
        if emitter.emit([
            "event": "ready",
            "helperVersion": captureHelperVersion,
            "capabilities": [
                "availableSources": true,
                "camera": true,
                "displayRecording": true,
                "interruptionDiagnostics": true,
                "metadata": true,
                "microphone": true,
                "minimumMacOSMajorVersion": 15,
                "systemAudio": true,
                "typedTextOptIn": true,
            ],
        ]) == .uncertainWriterFailure {
            await controller.terminate(reason: "stdout")
            return
        }

        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .userInitiated))
        let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global(qos: .userInitiated))
        terminationSource.setEventHandler {
            Task {
                await controller.terminate(reason: "sigterm")
                Darwin.exit(0)
            }
        }
        interruptSource.setEventHandler {
            Task {
                await controller.terminate(reason: "sigint")
                Darwin.exit(0)
            }
        }
        terminationSource.resume()
        interruptSource.resume()

        let reader = BoundedLineReader()
        while true {
            switch reader.next() {
            case .line(let line):
                do {
                    let request = try RequestParser.parse(line: line)
                    if await controller.handle(request) { return }
                } catch let failure as HelperFailure {
                    if await controller.rejectInput(failure) { return }
                } catch {
                    if await controller.rejectInput(HelperFailure(
                        code: "invalid-request",
                        message: error.localizedDescription,
                        recoverable: true
                    )) { return }
                }
            case .oversized:
                if await controller.rejectInput(HelperFailure(
                    code: "request-too-large",
                    message: "Request exceeds \(maximumProtocolLineBytes) bytes.",
                    recoverable: true
                )) { return }
            case .invalidUTF8:
                if await controller.rejectInput(HelperFailure(
                    code: "invalid-utf8",
                    message: "Request line is not valid UTF-8.",
                    recoverable: true
                )) { return }
            case .endOfFile:
                await controller.terminate(reason: "eof")
                return
            }
        }
    }
}

private func writeCommandLineOutput(_ value: String) {
    try? FileHandle.standardOutput.write(contentsOf: Data(value.utf8))
}
