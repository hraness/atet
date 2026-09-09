# Contents

- `blender_driver.py` – fixed Blender build, bake, render and native interchange adapter.
- `cadquery_driver.py` – fixed CadQuery solid construction and explicit STEP/GLB export adapter.
- `test_drivers.py` – standard-library driver boundary regressions without native imports.

# Guidelines

- Keep each production driver standalone so its exact source bytes define the complete adapter closure staged by the host.
- Execute authored Python only for an explicit request. Probes inspect installed engines and devices without opening user source.
- Treat authored source as trusted current-user code, never as an operating-system sandbox. Keep authorization, process custody, physical output verification and receipts in the host service.
- Preserve the admitted job by passing a detached authoring context. Verify retained source hashes before and after native reads, use fresh declared outputs, and enforce bounded output growth.
- Keep native units, frame intervals, color, alpha and device facts explicit. Validate CAD conversions using actual vertex positions and transforms, not format labels alone.
- Run portable regressions with `python3 -B -m unittest discover -s apps/desktop/studio/drivers -p test_drivers.py`. Native qualification requires the installed engine through the host scheduler; report versions and measured results separately.
