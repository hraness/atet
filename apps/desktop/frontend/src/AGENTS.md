# Contents

- `App.tsx` – minimal recorder state and controls.
- `runtime-bridge.ts` – validated Native SDK transport and browser-test adapter.
- `main.tsx` – production mount.
- `index.css` – product layout on shared design tokens.
- colocated deterministic component, view-model, and bridge tests.

# Guidelines

- Derive buttons and status text from the discriminated runtime snapshot; do not keep a second optimistic recorder state.
- Poll only as a recovery path. Apply bounded runtime events when the bridge supplies them and resnapshot after malformed or missed sequences.
- Keep buttons keyboard accessible, visibly focused, and at least 44 CSS pixels in both dimensions.
- Show partial-source and permission failures beside the affected source while preserving control of a valid active recording.
