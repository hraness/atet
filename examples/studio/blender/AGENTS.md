# Contents

- `studio_scene.py` – reusable authored material, geometry, camera and lighting helpers.
- `product.py`, `character.py`, and `import_model.py` – cinematic product, skinned IK/facial animation, and retained mesh import examples.
- `cloth.py` and `fluid.py` – bounded native simulation bakes with explicit retained cache evidence.
- `color_chart.py` – known linear emission values for output color, float range and alpha qualification.
- `README.md` – source-bundle hooks, output declarations and example limitations.

# Guidelines

- Keep these ordinary full Blender Python programs; do not replace the native API with a parallel scene language.
- Snapshot every helper and imported dependency in the portable source bundle. Keep generated native scenes, cache trees and frames under declared output paths.
- Demonstrate actual visible geometry, animation and simulation rather than flags. Verify saved rigs and caches in a new native process before claiming reuse.
- Keep draft dimensions, sample counts and simulation resolution bounded. Measure runtime and storage before increasing sample quality.
- Distinguish qualified behavior from unsupported or untested engine features; preserve failed qualification artifacts and repair source in a new retained attempt.
