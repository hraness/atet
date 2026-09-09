# Native film studio

ATET lets an agent retain a production scene, direct a native renderer, inspect its exact outputs and bring the result into an ordinary video project. Blender handles detailed 3D, CadQuery handles parametric solids and STEP, and Manim Community handles educational animation. Existing Three/Spark rendering, diagrams, image generation, narration, captions, effects and short-clip directing remain available in the same CLI.

Native authoring preserves the engine's control. A Blender source can use armatures, skinning, IK, shape keys, geometry nodes, materials, lights, cameras and simulation caches. A CadQuery program preserves dimensions and solid operations. A Manim scene preserves mathematical objects and timing. Portable meshes and finished videos are derivatives; retain the native source when later edits require it.

## Make the first shot

Install a supported engine yourself, or use an existing installation. ATET does not silently install or upgrade native tools. The initial qualified versions are Blender 5.2.1 LTS, CadQuery 2.8.0 and Manim Community 0.21.0. Select the exact Blender executable or Python virtual environment for each invocation.

```sh
atet studio init product --template blender-product --json
atet studio bundle product/source.json --json
atet studio plan product/job.json --json
atet studio probe product/job.json --blender-bin /Applications/Blender.app/Contents/MacOS/Blender --json
atet studio run product/job.json --blender-bin /Applications/Blender.app/Contents/MacOS/Blender --allow-trusted-code --json
```

The scaffold creates `scene.py`, any explicit helpers, `source.json` and `job.json`. Edit the source and job to direct the shot. After a source edit, run `studio bundle` again, copy the returned `bundleSha256` into the job and choose a new `jobId`. Reusing an old job ID with changed inputs is a conflict. `studio plan` parses and hashes the request without loading a native engine.

The default Blender product job requests Cycles GPU rendering. An unavailable GPU fails clearly. Select `device: "cpu"` in a new job when CPU rendering is intended; no fallback is implicit. Initial Metal shader compilation can make the first render substantially slower than later frames.

Other starters:

```sh
atet studio init character --template blender-character
atet studio init cloth --template blender-cloth
atet studio init liquid --template blender-fluid
atet studio init bracket --template cadquery-bracket
atet studio init lesson --template manim-lesson
```

Run CAD or Manim with `--python /absolute/path/to/venv/bin/python`. Preserve that virtual-environment path: resolving its interpreter symlink to a system Python can select the wrong package environment.

## Source and output contract

`source.json` lists exactly the files to retain. Its paths are relative to the manifest's directory, or to an explicit `--source-root`. Imports do not recursively discover siblings, follow file symlinks or run Python.

```json
{
  "engine": "blender",
  "entrypoint": { "kind": "python", "path": "scene.py" },
  "files": ["scene.py", "studio_scene.py", "models/product.glb", "textures/basecolor.png"]
}
```

The host stores a content-addressed manifest and immutable file copies under `artifacts/atet/private/studio/bundles/`. Jobs bind those retained bytes, typed engine settings, parameters, a stage, output declarations and limits. The source may execute at module scope or use the documented engine hooks. Blender and CadQuery support `build(context)`; an explicit bake job may call `bake(context)`. Manim selects a named scene class. See the checked examples for the exact hook contracts.

`ATET_CONTEXT` supplies detached parameters, stage, render clock and the private source/output/working roots. Helpers and imported assets belong in the explicit bundle. Diagnostics and temporary files belong in the working root; only declared deliverables belong in the output root. The host rejects undeclared files, links, empty outputs, missing frames and exceeded limits.

Frame intervals are half-open: `startFrame: 24, endFrameExclusive: 48` means 24 frames. Frame rate is a reduced rational numerator/denominator. Raster outputs declare channels, precision, color space, alpha and semantic meaning. Model outputs declare units, up axis and handedness. CadQuery's adapter explicitly converts its millimeter geometry into meter-scale, Y-up GLB; STEP remains millimeters and Z-up.

Successful receipts include the exact source/job/plan/runtime identities and every physical output hash and length. Runtime identity records executable and driver hashes plus observed package/version evidence. It is not a hash of every system library, font, installed plugin or external read. Native source runs as the current user and the profile is explicitly nonhermetic.

## Turn frames into a project clip

```sh
atet studio encode <studio-id> --output-id beauty --json
atet studio assemble <studio-id> --output-id beauty --name "The first shot" --json
```

Encoding accepts a successfully receipted PNG color sequence and creates a separately retained derivative. RGB becomes lossless H.264 RGB MP4; straight RGBA becomes lossless QTRLE MOV. The encoder checks every decoded frame against its source pixels and checks the exact clock. Native movie validation currently admits observed 8-bit RGB/RGBA interpretations; higher-precision video profiles require separate qualification. A 16-bit PNG sequence produces an explicitly recorded 8-bit derivative without dithering; the original masters remain intact. Linear EXR and data passes need an explicit compositing/color pipeline before delivery and are not silently converted by this command.

`studio assemble` reuses the verified encode and creates an ordinary video project with exact native/encode lineage. Its initial clip profile accepts opaque sRGB sequences up to 4096 pixels per side, 4000 frames and 60 seconds. Use `project add` for subsequent clips, narration and SFX, and `project render run` for delivery. Transparent sequences remain an explicit encode/overlay workflow.

The returned artifact is an ordinary local media reference. A repeated encode verifies its source and derivative receipts instead of resubmitting a completed conversion. Retain transparent MOV or linear masters for compositing; make a normal SDR delivery through the project renderer when broad player compatibility matters.

## Detailed assets, rigs and simulation

The supported Poly Haven adapter searches and imports free HDRIs, selected PBR maps and glTF model dependencies. A selection chooses one asset, resolution and file format; the plan retains author, license, API credit, catalog bytes and the complete dependency list. Imports verify those bytes and retain SHA-256 identities. Powered by [Poly Haven](https://polyhaven.com/).

```sh
atet studio assets search query.json --json
atet studio assets describe dirty_football --json
atet studio assets plan selection.json --json
atet studio assets import asset-plan.json --json
```

A search input is `{"provider":"poly-haven","query":"football","type":"models","limit":5}`. A model selection is `{"provider":"poly-haven","assetId":"dirty_football","resolution":"1k","kind":"model","format":"gltf"}`. Save the complete JSON plan returned by the plan command before importing it. The default total download bound is 50 MiB. Include the returned source files explicitly in a studio bundle; acquisition never executes or inserts an asset into a native scene. See the [asset adapter contract](../apps/desktop/studio/assets/README.md) for texture/HDRI selections, current terms and supported dependencies.

Use Blender's native importers for supplied GLB/glTF, OBJ/MTL, FBX and other supported formats. Retain all required textures, buffers and animation files. `examples/studio/blender/import_model.py` and the CadQuery STEP example show explicit local-input routes. Native imports have a broader feature set than ATET's deliberately bounded portable GLB parser; an imported native control rig is not automatically editable through portable spatial patches.

The original character example includes a deforming skeleton, blended weights, an IK target and facial shape keys. Keep control names and source parameters stable when directing later takes. Full upstream rigging APIs remain available to trusted authoring code, but arbitrary rig retargeting, production facial systems and third-party add-ons require their own setup and qualification.

Cloth and fluid starters use separate bake and render stages. Retain the resulting `.blend` and explicit caches, then create a source bundle with the native scene and its dependencies for a render job. A `.blend` entrypoint supports rendering with embedded-script execution disabled; rebuilding, rebaking, Python-dependent rig drivers or add-on initialization require an explicit authored Python setup. Unpacked FILE images must be exact existing declared bundle files, or their bytes must be packed in the scene. Linked libraries, volumes and other dependencies still need their own explicit source closure and validation. Preserve the relative cache layout when moving a bundle. Rendering a completed cache should not recompute its solver or depend on frame visitation order.

Physics settings are not proof of a bake. Review evaluated geometry, contact and cache evidence, then load the result in a fresh process. Cloth pins, collider thickness, object scale, time steps and warmup affect the image. Liquid surface and volume caches need explicit storage budgets. Keep native cache identity tied to the source and settings that produced it.

## Lighting, camera and color

The product source demonstrates beveled geometry, textured materials, glass, area lighting, a moving camera and depth of field. Native source can expose camera lens, focus, aperture, shutter and lighting parameters directly. Cycles and EEVEE have different rendering behavior; choosing EEVEE creates a different job and runtime profile.

Blender review PNGs use the chosen view transform and sRGB display output. Linear EXR beauty uses Linear Rec.709 and the declared half/full floating-point precision. Transparent PNG is straight alpha; transparent EXR is premultiplied. Auxiliary depth, normal, mask or object-ID files remain explicitly authored compositor outputs with data-space semantics. The host checks actual EXR channel precision and framing and decodes output files; physical units and coordinate meaning still need correct source and fixture validation.

Keep linear masters when grading or compositing requires them. Do not tone-map a review PNG a second time, apply a beauty transform to data passes or assume an exported GLB can reproduce arbitrary procedural materials. A splat capture describes observed appearance; it does not automatically provide editable objects, collision geometry or physically relightable materials.

## Educational films and generated media

The Manim starter produces a 10-second portrait example with an original Luma presenter, vector geometry, Typst mathematics, gestures and a caption rail. Its 3–4–5 construction rearranges nine plus sixteen equal-area tiles into a five-by-five square. This illustrates one Pythagoras example; it does not claim a general proof.

`lesson.json` retains the script, cue timing, gestures, mouth shapes and mathematical parameters. Cue provenance distinguishes authored timing from measured word or mouth alignment. Word highlights use half-open microsecond intervals; a resting mouth fills gaps. Portrait margins reserve room for the presenter, diagram and captions rather than cropping a landscape composition blindly. See `examples/studio/education/README.md` for the lesson fields and the standalone source closure.

Generate illustrations and narration through the existing Gateway operations, then retain their returned asset references:

```sh
atet ai models list --type image --json
atet ai image generate --model <image-model> --prompt-file illustration.txt --json
atet ai models list --type speech --json
atet ai speech generate --model <speech-model> --text-file narration.txt --json
```

These generation commands can incur provider charges. Use the live catalog and existing explicit upload controls. Studio execution itself makes no paid model call. It neither receives provider credentials in its child environment nor automatically regenerates narration or images when a scene renders.

Use `atet diagram init|check|render` for structured diagrams, `atet image vectorize` for local vectorization, existing transcription for measured captions, and ordinary audio/media operations for narration, music and SFX. Rhubarb mouth cues can be retained as measured performance input using the toolkit's conversion helper; mouth shapes are not word timestamps. A supplied or generated voice needs an actual listening/alignment review before authored cues can be described as synchronized speech.

The Manim driver owns silent visuals and exact frames. It rejects source-side audio so the existing ATET composition remains the audio owner. That separation lets an agent revise narration or sound independently while preserving the mathematical rendering and provider receipts.

## Qualified profiles and extension limits

Local acceptance used Blender 5.2.1 LTS on an Apple M4 Max, CadQuery 2.8.0 and Manim Community 0.21.0. These are measured fixtures, not a promise that every engine feature, device or imported asset behaves identically.

| Capability | Checked behavior | Boundary |
| --- | --- | --- |
| Cycles / EEVEE | Actual Metal renders; product materials, moving camera and depth of field | Other GPU backends need their own qualification; GPU rendering does not imply GPU physics |
| Character | Weighted mesh deformation, IK reach and facial shape keys survive native reload | Automatic production-rig retargeting is not supplied |
| Cloth / liquid | Real caches, changed evaluated geometry and fresh-process replay; liquid cache relocation | Solver validity and portable determinism depend on the source and runtime |
| CAD | Valid STEP round trip, preserved solid volume and measured meter/Y-up GLB bounds | Original third-party CAD feature history is not reconstructed |
| Color | Half-float linear EXR, preserved HDR values, premultiplied EXR and straight PNG edges | Auxiliary pass units and coordinate meaning require fixture-specific validation |
| Education | Portrait presenter, Typst mathematics, exact frame interval and transparent frame output | Authored cue timing is distinct from measured speech alignment |
| Acquisition | Free Poly Haven HDRI and complete glTF dependency closure, verified offline replay | Other catalogs use authorized supplied files; no generic marketplace automation |

Blender's native Python APIs can author Geometry Nodes, hair, volumes, additional solvers and compositor effects. Those APIs are available to trusted source; ATET does not advertise each as a separately qualified automatic workflow. USD, Alembic and other interchange retain only the semantics their particular exporters support. Robotics or RL environments additionally need step/reset, state/action, sensor and physical validation contracts; a cinematic scene or splat capture alone does not supply those guarantees.

## Use native jobs in an agent workflow

The checked `examples/studio/native-workflow.ts` accepts `{bundle: {path: "<retained manifest>"}, job: <job document>}` as its input JSON. The local declarative SDK exposes `.studio.run()` through `@hraness/atet/local/code`. Its closed operation is `atet.studio.run`. Inputs refer to the retained bundle manifest and a parsed studio job; planning binds the installed runtime under normal host admission. Outputs are ordinary hash-bound media references and a studio receipt, ready for subsequent retained media operations.

```sh
atet code run film.ts --input input.json --studio-python /absolute/venv/bin/python --allow-trusted-code --json
atet runs resume <run-id> --studio-python /absolute/venv/bin/python --allow-trusted-code --json
```

The same runtime/authorization flags are available on `workflows run`. Runtime selection alone does not authorize source execution. A missing native trust envelope pauses the node before dispatch; adding the explicit flag on resume permits the exact bound plan. Generic stored write approval cannot grant native code permission. Changing a runtime, source or job after binding requires a compatible new plan.

Use the source-backed Bun package for `code` workflows and local SDK imports. The copied macOS executable supports direct `studio` commands with embedded starters and drivers; its older workflow build-identity scanner still requires the installed source distribution.

Native results can be imported into ordinary ATET projects with their declared video/audio roles. The existing V2 spatial renderer still has its qualified Three-specific rendering path; attaching a native candidate does not make that path consume it. Preserve a native shot's source and receipt alongside its ordinary project media derivative.

## Inspection and recovery

```sh
atet studio inspect <studio-id> --json
atet studio reconcile <studio-id> --json
```

Inspection rechecks source and physical output hashes. Reconciliation can restore a missing receipt only when a closed successful process completion and an unchanged output-validation checkpoint exist. Earlier interrupted execution remains ambiguous and is never automatically resubmitted. Choose a new job ID for an explicitly revised attempt after custody is settled.

The supervisor bounds combined logs, the job deadline and termination/pipe-drain grace. It monitors output and scratch budgets, retains failure evidence and tracks native process groups. Live scans tolerate bounded disappearance of temporary cache entries; final output, source and scratch scans remain strict. Budget-monitor and validation failures retain a safe failed host stage separately from authored-process logs, without storing foreign exception text. A machine-wide durable activity marker survives CLI death; unresolved custody blocks later native dispatch. Detached sessions from authored source are unsupported. Do not delete an unresolved marker to bypass admission; inspect and resolve the actual process ownership first.

The native profile is trusted current-user execution without an OS sandbox. Private roots, clean environment variables, hashes and process supervision provide operational control and provenance. They do not confine arbitrary Python, installed plugins or native libraries. Keep unreviewed downloaded source inert until execution is explicitly authorized.
