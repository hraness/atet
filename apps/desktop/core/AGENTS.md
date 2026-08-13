# Contents

- bundle storage and atomic manifest/edit-plan persistence.
- multi-asset project planning, placement synchronization, and project-wide structural edit mapping.
- interval algebra and source-to-output time mapping.
- event querying, typing-span derivation, cursor smoothing, and window-target resolution.
- motion/audio analysis adapters and automatic cut planning.
- deterministic multi-face association/framing, audio alignment, project-clock inactivity, music/tempo/key, scene sampling, and speech/filler analysis primitives.
- overlay asset resolution and deterministic FFmpeg render planning.
- deterministic artistic-look preset expansion, receipts, and owned FFmpeg effect-graph compilation.
- colocated deterministic and property tests.

# Guidelines

- Keep this layer portable and side-effect-free by default. Put filesystem and subprocess effects behind injected ports.
- Preserve originals. Every transformation returns a normalized edit plan or render invocation; only explicit execute functions may create derived files.
- Canonicalize ordering and JSON so equivalent plans produce byte-identical output and stable hashes.
- Make interval laws, time-map round trips, plan normalization, and parser behavior property-tested.
- Treat PySceneDetect as an algorithm and CLI ergonomics reference. Prefer an owned analyzer contract and FFmpeg-native freeze/silence probes over a required Python runtime.
