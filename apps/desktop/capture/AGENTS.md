# Contents

- `Capture.swift` and focused Swift sources – macOS ScreenCaptureKit, AVFoundation webcam capture, interaction metadata, and JSONL control protocol.
- `build.ts` – deterministic `xcrun swiftc` compilation and platform/toolchain checks.
- `protocol.ts` – TypeScript validation for the helper's bounded stdin/stdout JSONL messages.
- colocated protocol and build tests.

# Guidelines

- Target macOS 15 or newer for `SCRecordingOutput` plus direct system-audio capture. Report this boundary explicitly instead of silently dropping a requested source.
- Start one ScreenCaptureKit stream per display. Only the primary stream captures system audio; expose it as a distinct logical stream in helper results even though its native samples share the display MP4.
- Capture webcam video and microphone audio through separate AVFoundation outputs. A missing or denied optional device yields a typed unavailable result; strict mode may fail the session before writing media.
- Hide the native cursor only when metadata capture is active. Poll cursor position and record clicks, key activity, focused-input bounds, display topology, and changed window snapshots on the same monotonic clock.
- Never persist typed text unless the request explicitly enables it. Detect secure fields and redact them even when text capture is enabled.
- Pausing must finalize the current media segment. Resuming creates new files; never append across a pause or rewrite a finalized segment.
- Treat stdout as protocol-only JSONL and send diagnostics to stderr. Bound line sizes, collections, event rates, and queued writes.
- Compile only through `build.ts`, using `xcrun` and an explicit deployment target. Keep macOS compilation out of portable repository checks.
