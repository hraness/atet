# Authored Blender studio examples

These examples use Blender's native Python APIs through SLOPCAMERA's explicitly trusted source-bundle workflow. Include the selected entrypoint and `studio_scene.py` as declared bundle files. Imported assets and their dependencies must also be declared. The scripts do not download anything or use a provider.

| Entrypoint | Features | Initial qualification job |
| --- | --- | --- |
| `product.py` | Machined metal, glass, fine surface detail, key/fill/rim lighting, camera move and focus pull | Render frames `[1,25)` at 24fps; start at 320×180/16 samples, then select 960×540/64-sample review frames |
| `character.py` | Weighted continuous arm, IK goal and pole, articulated skeleton, blink/smile/jaw shape keys | Render `[1,25)` at 24fps; compare frames 1, 9, 18 and 24 |
| `import_model.py` | Standard GLB, glTF or OBJ/MTL import, measured bounds, framed camera and lighting | Parameter `input` names a declared relative asset path; optional `environment` names a retained linear Rec.709 HDR/EXR; loaded images are packed into the native scene |
| `cloth.py` | Cloth dynamics, collision, woven shading, completed native point cache and Alembic deformation export | Bake with native `native/scene.blend` and directory `cache/cloth`; subsequently render the retained `.blend` at frame 32 |
| `fluid.py` | Mantaflow liquid volume, collision basin, meshed splash, retained simulation data and surface cache | Bake with native `native/scene.blend` and directory `cache/fluid`; subsequently render the retained `.blend` around frames 12–24 |
| `color_chart.py` | Known linear emission patches, including values above one, against a transparent background | One frame with denoising disabled, explicit RGBA PNG/straight and half-float EXR/premultiplied declarations; compare decoded center values and alpha |

Simulation scripts define `build(context)` and `bake(context)`. The fixed driver executes the Python module, calls `build` when present, saves the declared native scene, and calls `bake` only for a bake job. A render job never implicitly calls `bake`. Fluid resolution defaults to 24 and is bounded to 16–48 in this fixture. Cloth uses 40 simulation frames and fluid uses 32. Cloth defaults to a free drape; parameter `pinBackCorners: true` adds two fully weighted pin vertices and verifies that their evaluated positions remain fixed throughout the completed bake. The cache evidence JSON records evaluated geometry after the real bake; it is not a substitute for inspecting rendered images or reloading the cache.

For native-source render jobs, make a new source bundle containing the retained `.blend` and its complete explicitly declared cache/input tree. Preserve the relative layout. The fluid example stores its cache path relative to the native scene. The cloth scene retains the completed point cache in its `.blend` and additionally publishes an Alembic deformation cache.

For `.blend` entrypoints, unpacked `FILE` images must resolve to exact physical files declared inside the source bundle; otherwise the driver fails before rendering. Packing image bytes avoids ambient original paths. The import example packs all imported file images, including HDR environments that Blender has not yet decoded. Broader native dependencies, such as linked libraries, sequences, volumes and arbitrary authored handlers, still require explicit source management and feature-specific qualification; this check does not claim a complete hermetic Blender dependency graph.

The driver supports automatic beauty PNG/EXR files or frame sequences and GLB/USD model exports. An image sequence uses exactly one `%06d` token and the job's half-open frame interval. A beauty file requires one frame. Use SLOPCAMERA's ordinary retained media pipeline for video encoding. Authored Python may use Blender's full compositor API to write separately declared auxiliary outputs.

Automatic PNG beauty declares sRGB, RGB/opaque or RGBA/straight alpha, uint8 or uint16, color semantic and unitless units. Automatic EXR beauty declares linear Rec.709, float16 or float32, RGB/opaque or RGBA/premultiplied alpha. The driver sets output conversion explicitly and reports the source working space. GLB output declares meters, right-handed Y-up; USD output requires a meter-scale scene and declares right-handed Z-up.

`SLOPCAMERA_CONTEXT` contains `parameters`, `stage`, `render`, `sourceRoot`, `outputRoot`, and `workingRoot`. Paths are absolute retained roots. The object is detached from the driver's admitted job. The driver and source run as the current user; hashes and declared outputs provide identity and verification, not an operating-system sandbox or hermetic execution.

Capability qualification should record native Blender build/device logs, exact source and output hashes, full pixel decoding, selected-frame contact sheets, and observed runtime/storage. A configured feature is not yet a qualified feature. GPU selection uses native Cycles discovery and rejects an unavailable requested GPU instead of silently selecting CPU. EEVEE requires an explicit GPU request.
