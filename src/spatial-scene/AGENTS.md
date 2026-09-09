# Contents

- `contracts.ts` – bounded authored spatial scene, asset, camera, animation and patch data.
- Pure identity, evaluation and inspection modules – scene source and derived state without host effects.
- Colocated deterministic and property tests – reference, transformation, time and edit laws.

# Guidelines

- Keep this boundary portable and effect-free. Parsing, inspection and compilation never read files, execute authored source, decode media, launch a renderer or contact a provider.
- Parse foreign input from `unknown` through the bounded canonical JSON snapshot and strict schemas before expensive work. Keep entity, camera, asset and generator references explicit and validate their closure.
- Preserve authored identity and retained generator output. Typed edits update authored data or declared overrides; they never patch a renderer instance or silently rerun source.
- Use the declared right-handed, Y-up meter coordinates, camera-local negative Z, XYZW quaternions and integer-microsecond authoring clock. Preserve exact rational frame sampling at the render boundary.
- Treat an evaluated snapshot as immutable derived state. Include effective view and shot overrides in render identity; rendering cannot advance shared state.
- Keep `packages/scene` and the existing `./scene` export dedicated to scene analysis. Shared graph identity and host capability authority remain owned by the existing code core.
