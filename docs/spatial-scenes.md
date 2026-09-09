# Directed scenes

Atet keeps a visual composition as editable scene data and renders it through named cameras. A scene can combine geometry, images, video, diagrams, text, and animation. Agents inspect stable entity IDs and apply typed changes to retained source; frames and videos carry receipts identifying the source that produced them.

This is the initial scene foundation. The Three.js renderer supports a bounded asset profile and offline rendering. Interactive world editing, neural world representations, simulation, and automatic video-model refinement are future adapters. Existing HTML authoring and media-editing commands remain available.

## Render an editable scene

Use a CLI built from this checkout until the scene commands appear in a published release. Check `atet scene --help` and `atet doctor` first. Source inspection and edits need Bun; rendering also needs the admitted local Chrome runtime, and video decoding or encoding needs FFmpeg and FFprobe.

```sh
atet scene init product.scene.json --json
atet scene inspect product.scene.json --json
atet scene evaluate product.scene.json --camera camera_hero --time-us 1000000 --json
```

The starter contains a turning product, a pedestal, lights, and a calibrated 960 × 540 camera. Save this request as `frame.json`:

```json
{
  "cameraId": "camera_hero",
  "selection": { "kind": "frame", "timeUs": 1000000 },
  "mode": { "kind": "beauty" }
}
```

```sh
atet scene plan product.scene.json --request frame.json --json
atet scene render product.scene.json --request frame.json --json
```

`plan` validates the source and estimates bounded rendering work without opening a browser. `render` writes a PNG, retained source and assets, and a receipt beneath the ignored artifact root. It checks asset bytes and native runtime identity before using them. Unsupported asset features fail explicitly.

To inspect animation, replace `selection` with:

```json
{
  "kind": "contact-sheet",
  "timesUs": [0, 1000000, 2000000],
  "columns": 3,
  "cellWidth": 320,
  "cellHeight": 180,
  "fit": "contain"
}
```

Each sample renders at the camera's calibrated resolution, then resizes into its contact-sheet cell. To encode a transparent MOV, use:

```json
{
  "kind": "video",
  "range": { "startUs": 0, "endUs": 4000000 },
  "frameRate": { "numerator": 30000, "denominator": 1001 }
}
```

The video profile uses lossless qtrle with straight alpha. Final project delivery converts scene footage through the ordinary project compositor.

## Make a semantic edit

Read `sceneSha256` and `editableControls` from inspection. Save a patch using that exact digest:

```json
{
  "kind": "atet.spatial-scene-patch",
  "schemaVersion": 1,
  "expectedSceneSha256": "<digest from inspection>",
  "operations": [
    { "kind": "set-color", "entityId": "entity_product", "color": "#f97316" }
  ]
}
```

```sh
atet scene patch product.scene.json --patch patch.json --output product-orange.scene.json --json
```

A stale digest rejects the edit. The command requires a new output path, so both sources remain available. Patches also support transforms, cameras, animation channels, hierarchy changes, and explicitly declared generated-part overrides. Generated entities retain their generator/key correspondence; inspecting, seeking, and patching never rerun generator source. Replacing generator output is an explicit operation carrying new provenance.

Camera changes affect view identity without changing the evaluated world state. Shot overrides affect only that shot. An animated property cannot receive a conflicting constant override. Imported GLB source-material mode exposes transform edits; color and opacity edits require entity-material mode and are rejected when they would have no effect.

Use `add-asset` or `replace-asset` to declare asset manifests and `set-mesh-geometry` to replace an authored mesh's representation while retaining its entity ID, name, pose, and animation. GLB node and clip indices are local to that exact payload. Replacing addressed GLB bytes requires explicitly setting the new geometry addresses in the same patch; Atet does not infer internal-node correspondence after reimport. Generated-part asset changes require explicit retained generator output replacement. Inspect controls after a representation change, because source-material mode can remove color/opacity editability.

## Direct a project through shots

A shot identifies a retained scene digest, a camera, its project range, its scene start time, and explicit `once`, `loop`, or `freeze` playback. Shot ranges use the project's source clock. The compositor applies existing global cuts and speed once, preserves existing audio, and places scene video above legacy footage and below overlays.

Create or edit the ordinary media project before migration. Snapshot its exact basis:

```sh
atet scene project snapshot <project-id> --json
atet operations show spatial.project.migrate --json
```

The migration request contains `expected` from that snapshot, a fresh `transactionId` (`transaction_` plus 32 hexadecimal characters), `scenes` containing `{sceneSha256, document}`, and `shots`. A shot has this shape:

```json
{
  "shotId": "shot_hero",
  "sceneSha256": "<scene digest>",
  "cameraId": "camera_hero",
  "range": { "startUs": 0, "endUs": 4000000 },
  "sceneStartUs": 0,
  "playback": "once",
  "overrides": []
}
```

Keep shot ranges within the existing project duration. Install declared asset payloads at their manifest paths inside the project directory before migration. Their sizes and digests must match; migration does not search arbitrary source directories or download assets. Inspect the operation schema for the complete bounded request.

```sh
atet scene project migrate <project-id> --input migrate.json --json
atet scene project snapshot <project-id> --json
```

Migration publishes one V2 project head pointing to an immutable aggregate. It retains the original media project and edit plan within that aggregate. Legacy project writers reject V2 heads; they cannot modify frozen audio or timeline state after migration. The initial V2 commands edit scenes, shots, and candidates. Plan ordinary media edits before migration until a V2 media-edit adapter is added.

`scene project patch` takes the whole current project basis, a scene patch, a fresh transaction ID, and `retarget: {"kind":"all"}` or `{"kind":"shots","shotIds":[...]}`. An all-shot edit and an edit to one shot are explicit choices. Old sources remain retained. Candidate records bind their derivation to exact scene and shot digests; selections become stale when those inputs change. The initial compositor renders authored shots; selecting a candidate does not yet substitute generated footage into delivery.

To undo a scene change, use `scene project restore` with `expected`, a fresh `transactionId`, `expectedSceneSha256`, a retained `restoreSceneSha256` from the same scene, and explicit `retarget`. Restore publishes a new revision that preserves current media and unrelated shots. It revalidates camera, override, and clock compatibility and recalculates candidate staleness; it does not rewind the project head or overwrite a later edit.

## Prepare and deliver a frozen composition

Save `prepare.json` using the current V2 basis:

```json
{
  "expected": { "version": 2, "sha256": "<project basis digest>" },
  "profile": {
    "pixelWidth": 960,
    "pixelHeight": 540,
    "frameRate": { "numerator": 30000, "denominator": 1001 },
    "background": "#101820ff",
    "colorSpace": "srgb"
  },
  "policy": {
    "kind": "full-frame-above-legacy-video-below-overlays",
    "alpha": "straight"
  },
  "delivery": {
    "output": { "path": "renders/directed-scene.mp4", "maximumBytes": 268435456 },
    "syncPolicy": "require-verified",
    "tier": "final"
  }
}
```

```sh
atet scene project prepare-render <project-id> --input prepare.json --output prepared-render.json --json
atet workflows plan directed-scene --input prepared-render.json --json
atet workflows run directed-scene --input prepared-render.json --json
```

Preparation holds the project's lease, validates every shot before starting native work, materializes source-clock footage, and retains its exact receipts. Cameras must match the requested dimensions; preparation does not silently resize them. The full-frame profile rejects overlapping shots. Animate two video surfaces within one scene for a visual crossfade, and arrange its audio in the media project.

The prepared file freezes the projection, render plan, native toolchain, cadence, and output request. The workflow receives a real durable run identity and verifies encoded dimensions, pixel format, frame timestamps, and audio duration before publishing output. Recovery repeats those checks. Later changes to the project head do not invalidate an already prepared historical composition. A changed source artifact or toolchain rejects the render.

The initial preparation path rejects legacy `zooms` and enabled click, cursor, keystroke, or typed-text effects before rendering. These effects require recording metadata that is not yet frozen in the spatial projection. Ordinary overlays, manual camera moves, cuts, speed changes, and audio remain in the derived composition.

`require-verified` rejects unverified placement synchronization. Use `allow-unverified` only when that existing timing uncertainty is acceptable for the intended delivery. Project output paths are project-relative and never overwrite another render.

## Asset and rendering profile

| Input | Initial support |
| --- | --- |
| Geometry | Boxes, planes, spheres, cylinders, and a closed GLB 2 triangle subset with TRS hierarchy and STEP/LINEAR transform clips |
| GLB appearance | Base-color PBR material and embedded PNG/JPEG textures; explicit entity-material or source-material mode |
| Images | PNG/JPEG with the admitted color profile, and inert shape-only SVG |
| Video | Bounded MOV/MP4, exact source PTS selection, alpha where supported, explicit once/loop/freeze and source offset |
| Diagrams | Existing version-one diagram source rasterized with declared fonts |
| Text | Declared OTF font and verified glyph coverage; missing glyphs reject instead of using a system fallback |
| Placement | World coordinates or camera-view pixel/normalized layers; view layers preserve flat-media framing |
| Cameras | Calibrated perspective and orthographic projection; explicit dimensions, clipping range, and pose |
| Outputs | Beauty PNG/MOV, contact sheet, stable object-ID pass, and encoded axial-depth pass with coverage and units |

Use right-handed Y-up coordinates in meters, camera-local negative Z, and XYZW quaternions. Author time in integer microseconds. Frame sampling uses the rational frame rate before one microsecond quantization; ranges are half-open.

The renderer rejects external GLB resources, unsupported extensions, skins, morph targets, sparse accessors, compressed meshes, cubic animation, WOFF2 fonts, undeclared text fallback, untagged YUV, and unsupported HDR/color profiles. Splat data has an authored representation slot but no admitted native renderer. Object-ID and depth passes have explicit alpha and no-hit rules in their receipts; they are picking and camera-depth products, not physics labels.

## Bounds and recovery

One source is at most 2 MiB, with up to 4,096 entities, 128 assets, and 64 cameras. A native scene render admits at most 1,800 frames, 1.1 billion rendered pixels, 256 MiB of source payloads, and 256 MiB of final output. Contact sheets admit 64 samples. Rendering proceeds in batches of 32 frames. The staged asset/frame budget is 8 GiB; this excludes the separately managed browser runtime, caches, and process memory. Output compression is not guaranteed, so a video that exceeds its hard byte limit fails qualification.

Project preparation additionally limits the program to 64 shots and shares the 1,800-frame, 1.1-billion-pixel, and 8-GiB staging budgets across them. It retains at most 1 GiB of distinct shot video inputs. These are first-release admission bounds, not claims about unlimited scene or world scale.

Receipts retain source, asset, request, view, runtime, and output identities. A failed or interrupted publication can return completed artifacts and an uncertain publication address. Preserve that evidence. For a project transaction, `scene project reconcile` accepts the exact retained attempt reference. For workflow execution, inspect and resume the original run through `atet runs`; do not relabel an ambiguous attempt as a new completed render. Reconciliation verifies immutable evidence before allowing recovery.

Run `bun run qualify:spatial-scenes` from a development checkout for the native mixed-scene qualification. It writes ignored media and a machine-readable report. Fast unit and property tests run under the ordinary repository check. Native rendering latency and scene complexity depend on the qualified host; the initial implementation does not promise an interactive editing latency.
