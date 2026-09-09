# Authored CAD studio examples

`bracket.py` builds a parametric millimeter-scale instrument mount with counterbored mounting holes, an upright circular aperture, fillets, and a separate isolation pad. Its `build(context)` hook returns a CadQuery `Assembly`; the driver uses that return value as the configured `exportVariable`.

`import_step.py` imports an exact caller-declared STEP dependency, defaulting to `assets/bracket.step`. It preserves the assembly import surface supported by the installed CadQuery reader. STEP is the resulting CAD solid/assembly; the Python source retains the editable feature program.

Use a build job with STEP and GLB file outputs. Automatic native CAD geometry uses millimeters and right-handed Z-up. STEP output must declare that space; standard GLB output must declare meters and right-handed Y-up. The driver records solid validity, volume, bounds, face/solid counts, and tessellation settings. STEP uses CadQuery's assembly writer. GLB uses CadQuery's colored assembly conversion with OCCT's explicit unit and coordinate-system converter: input 0.001 meters per unit, output one meter per unit, Z-up to Y-up. This conversion includes mesh positions and assembly transforms; CadQuery 2.8's high-level GLB writer alone leaves numeric millimeters unchanged.

Parameters for the bracket are `widthMm` (default 100), `depthMm` (64), `heightMm` (56), and `thicknessMm` (8). Optional `rootTranslationMm` and `rootRotationDegrees` exercise translated and Z-rotated assemblies. The fixture bounds each parameter. A practical initial mesh tolerance is 0.1mm with angular tolerance 0.1 radians. Inspect GLB vertex bounds and complete node transforms after conversion; the existence of a file does not establish correct scale.

To photograph the generated GLB, include it in a new Blender source bundle with `import_model.py` and `studio_scene.py`. This separates exact CAD source, tessellated delivery geometry, and the cinematic scene while keeping their source identities available for review.

IGES is not exposed by this high-level CadQuery adapter. Additional OCCT/FreeCAD ingestion is a separate future qualified capability. The driver does not install packages, download assets, accept arbitrary executable arguments, or silently repair failed CAD geometry.
