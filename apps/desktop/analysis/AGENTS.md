# Contents

- `FaceAnalyzer.swift` – offline Apple Vision face detection over one selected video track with actual presentation timestamps and bounded JSONL output.
- `protocol.ts` – strict TypeScript validation for analyzer probe, start, frame, completion, and error events.
- `build.ts` – deterministic macOS 15 `xcrun swiftc` compilation, content-addressed caching, ad-hoc signing, and system-linkage verification.
- `face-positive-fixture.jpg` and `face-positive-fixture.md` – small provenance-documented fictional group portrait used only for positive offline Vision coverage.
- `tsconfig.json` – portable TypeScript and lint project boundary for the analyzer build/protocol sources.
- colocated build, protocol, and macOS integration tests.

# Guidelines

- Keep `atet-face-analyzer` offline. It reads only the explicitly supplied local media file and never opens a network connection or loads a provider model.
- Target macOS 15 or newer and use `VNDetectFaceRectanglesRequest` through Apple Vision. Report the bounded helper/runtime versions, pinned request revision, OS build, and process architecture in every probe and analysis header.
- Select video streams by zero-based video-track ordinal and report both the ordinal and persistent track ID. Never substitute the first track after an invalid selection.
- Use each decoded sample buffer's real presentation timestamp. Do not infer timestamps from frame count, nominal frame rate, or the requested sampling interval.
- Return every accepted face in a frame up to the explicit hard bound. Boxes use normalized upright top-left coordinates after applying the reported preferred-transform orientation; expose encoded and oriented dimensions, rotation, mirroring, and rational sample aspect ratio.
- Keep positive face fixtures fictional, compact, provenance-documented, and local to tests. Do not use recordings, photographs, names, identity labels, or biometric reference material from a real user.
- Treat stdout as bounded protocol-only JSONL except for the bounded `--version` capability line, and keep stderr diagnostics bounded. A run is usable only after its terminal `completed` event; partial output followed by `error` must be discarded.
- Compile only through `build.ts`, using `xcrun`, an explicit macOS 15 deployment target, a content-addressed cache, an ad-hoc stable identifier, and system Apple framework linkage. Keep `dist/` generated and ignored.
