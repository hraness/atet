# Contents

- `driver.py` is the fixed Manim Community 0.21/Cairo adapter. It accepts a private studio request or probes the installed runtime.
- `lesson.py` validates retained lesson data and evaluates integer-microsecond cue boundaries without importing Manim.
- `toolkit.py` supplies the original Luma presenter, caption rail, geometric tile construction, and mathematical typesetting helpers.
- `test_driver.py` and `test_lesson.py` are pure standard-library tests. `qualify_native.py` is an opt-in admitted native qualification.

# Guidelines

- Keep pure checks executable with `python3 -B -m unittest discover -s apps/desktop/studio/education -p 'test_*.py'`; do not require Manim, Typst, or a task-local environment for these tests.
- Execute author Python only at the explicit trusted-current-user render boundary. Probe must not load the author bundle. Preserve the observed runtime environment and nonhermetic execution declarations.
- Keep the fixed driver standalone. Every author helper and lesson file must be explicitly included in the source bundle; do not resolve undeclared repository siblings.
- Preserve exact half-open native frame indices, rational movie PTS, static-frame repetition, explicit pixel/alpha interpretation, and bounded output publication. The owned sink must not start Manim's separate partial encoders.
- Detach author-visible context from admitted job data. Keep narration and sound-effect resolution in the ordinary SLOPCAMERA project audio layer.
- Distinguish authored timing from measured caption or Rhubarb timing. Do not infer word alignment from mouth cues or claim lip-sync quality without reviewing actual retained narration.
- Keep mathematical values, tile counts, and destinations derived from validated data. The integer-triangle example is not a proof for arbitrary triangles.
- Coordinate native qualification through the integration owner's HRA lane. Retain failed attempts and exact source/driver identities; a backend observation does not replace a host studio receipt.
