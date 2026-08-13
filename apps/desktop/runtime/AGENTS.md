# Contents

- `src/` – the compiled Bun gateway that exposes bounded recorder snapshot and dispatch requests to the Zig host.
- `run-native.ts` – development entry that resolves the gateway, capture helper, repository root, and Zig toolchain.
- `run-zig.ts` and `zig-toolchain.ts` – pinned Native SDK Zig invocation helpers.
- `package-macos.ts` – sidecar staging, privacy plist keys, entitlements, signing, and package verification.
- colocated runtime and packaging tests.

# Guidelines

- Keep the gateway a thin adapter over the same recording controller used by the CLI. Do not put a second recording state machine in the desktop path.
- Accept only the two declared bridge commands and parse their payloads from `unknown`. Return bounded snapshots and mutation receipts; metadata stays on disk.
- Resolve development paths explicitly from the repository. A packaged app must reject recording until a repository checkout is configured; never choose an application-support fallback.
- Build one complete sanitized child environment. Do not forward credentials, proxy settings, dynamic-loader variables, or Bun/Node option injection to packaged helpers.
- Package the compiled gateway and capture helper as immutable app resources, add exact camera, microphone, screen, and system-audio usage descriptions, then sign and verify the completed bundle.
