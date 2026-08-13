# Contents

- `main.ts` – JSONL host loop and lifecycle.
- `host-protocol.ts` – strict request/response envelopes.
- `recording-service.ts` – adapter from desktop commands to the shared CLI recording controller.

# Guidelines

- Keep stdout protocol-only and serialize writes. Diagnostics go to stderr.
- Bound line length, pending requests, response size, and shutdown time.
- Convert thrown values into a small owned error taxonomy without leaking paths, environment values, or native diagnostics to the renderer.
- Make shutdown idempotent and stop an owned active capture cleanly before the gateway exits.
