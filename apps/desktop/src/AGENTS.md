# Contents

- `main.zig` – Transmute identity, frontend source, gateway lifecycle, bridge dispatcher, navigation policy, icon, and initial window.
- `runtime_host.zig` – asynchronous gateway process, bounded JSONL request/response transport, and UI-loop responder delivery.
- `runner.zig` – pinned Native SDK lifecycle, logging, platform, and WebView integration.

# Guidelines

- Keep product composition in `main.zig`; keep `runner.zig` aligned with the pinned Native SDK scaffold.
- Keep child I/O off the UI thread and call bridge responders only while draining effects on the UI loop.
- Keep bridge command names and allowed origins identical in `runtime_host.zig`, `app.zon`, and TypeScript contracts.
- Resolve packaged gateway and capture-helper paths only inside the signed app resources. Development overrides must be absolute and are ignored from a packaged app.
- Do not expose generic filesystem, process, clipboard, network, camera, or microphone capabilities to the renderer. Recording crosses one owned bridge command.
