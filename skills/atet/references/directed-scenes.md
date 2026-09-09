# Author and direct editable scenes

Use `atet scene --help` to check that the installed CLI includes the directed-scene foundation. The initial renderer uses Three.js and supports explicit scene JSON, semantic edits, calibrated cameras, native media surfaces, contact sheets, and transparent video.

Start with `atet scene init scene.json --json`, then `atet scene inspect scene.json --json`. Retain the original source. Use its stable entity IDs and exact `sceneSha256` in typed patches; save each edit with `--output` to a new file. Inspect `editableControls` before changing generated parts or imported materials. Do not replace named scene parts with opaque regenerated source merely to change one color or camera.

Use `atet scene plan scene.json --request request.json --json` before rendering. A frame request is:

```json
{
  "cameraId": "camera_hero",
  "selection": { "kind": "frame", "timeUs": 1000000 },
  "mode": { "kind": "beauty" }
}
```

Render with `atet scene render scene.json --request request.json --json`. Inspect the actual output before delivery. A contact sheet uses explicit `timesUs`, `columns`, `cellWidth`, and `cellHeight`; a video uses a half-open microsecond range and rational `{numerator, denominator}` frame rate. Keep images, text, and diagrams in camera-view layers when their flat layout matters. A different aspect requires an explicit camera/layout decision.

Keep asset payloads local, declared, and digest-bound. Never invent provenance, units, font coverage, or color metadata to force admission. Unsupported GLB features, fonts, and color profiles need an explicit asset conversion or a different authoring workflow. The scene parser never executes source or downloads resources. Existing reviewed HTML workflows remain suitable for effects outside the closed scene profile.

For a media project, finish ordinary timeline/audio edits before V2 migration. Read `atet operations show spatial.project.migrate --json` and snapshot the exact project basis. Migration retains the old media state in one immutable aggregate; old editing commands then reject the V2 head. Scene patches require both the project basis and scene digest, plus explicit all-shot or selected-shot retargeting.

Use `scene project restore` to select an earlier retained scene for explicit shots in a new project revision. Use `add-asset`/`replace-asset` and `set-mesh-geometry` for authored representation changes. Preserve the entity ID and explicitly readdress GLB node/clip indices after a payload replacement; inspect available controls again afterward.

Prepare a camera program with `atet scene project prepare-render <project-id> --input prepare.json --output prepared-render.json --json`. The input declares the exact basis, calibrated output profile, straight-alpha full-frame scene policy, and delivery output/sync policy/tier. Then run `atet workflows plan directed-scene --input prepared-render.json --json` and `atet workflows run directed-scene --input prepared-render.json --json`. Use `atet workflows show directed-scene --json` for the complete prepared-input schema.

Keep receipts and the original run ID after interruption. Inspect `atet runs` and reconcile the exact attempt instead of blindly repeating a possibly published operation. Candidate records preserve derivation and staleness; candidate selection does not yet replace authored footage in the scene compositor. Interactive worlds, neural scene rendering, and simulation are outside the initial scene profile.
