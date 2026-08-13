# Contents

- `src/` – the production React recorder controls and typed runtime bridge.
- `index.html` – the production Vite document and restrictive content policy.
- `vite.config.ts` – fixed-port build and development configuration.

# Guidelines

- Keep the production UI limited to current source/permission status, elapsed time, recording path, and start, pause, resume, and stop controls.
- Render the real runtime state machine. Disable illegal actions instead of recovering from contradictory renderer state.
- Keep filesystem paths, native events, and capture metadata behind the typed runtime bridge; the renderer has no direct process or filesystem capability.
- Keep the small local UI primitives accessible and task-oriented. Do not add a timeline editor to the recorder surface.
- Keep Direct imports outside this directory and the production Vite graph.
