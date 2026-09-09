# Contents

- `bracket.py` – parametric millimeter solid assembly with counterbores and a mounting aperture.
- `import_step.py` – explicit retained STEP assembly reimport.
- `README.md` – source authority, units, tessellation and declared outputs.

# Guidelines

- Keep authored CadQuery dimensions in millimeters and preserve Python source as feature-history authority.
- Export STEP with explicit millimeter units and GLB with explicit meter, right-handed Y-up coordinates through the fixed adapter.
- Verify B-rep validity, solid counts, volume and physical mesh extents after export and reimport. STEP does not preserve the original Python feature program.
- Retain the exact imported file and every authored dependency in the source bundle. Never acquire remote assets implicitly.
