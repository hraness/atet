# Direct a native film studio

These commands require current source; check [installation](install.md) and `slopcamera help studio`.

Use `slopcamera studio` when the deliverable needs native Blender, CadQuery or Manim authoring. Keep the native source, caches and exact settings alongside review frames and final clips. This complements the existing Three/Spark scene and ordinary video-project workflows.

1. Choose a starter with `slopcamera studio init <directory> --template blender-product|blender-character|blender-shaded-street|blender-cloth|blender-fluid|cadquery-bracket|manim-lesson`.
2. Edit the source, explicit file list and typed job. Retain all helpers and input assets with `slopcamera studio bundle <source.json> --json`. After source edits, use its new `bundleSha256` and a new job ID.
3. Inspect `slopcamera studio plan <job.json> --json`. It does not load a native engine. Use `studio probe` with an explicit `--blender-bin` or `--python` path to inspect the installed runtime.
4. Run the requested trusted source using `slopcamera studio run <job.json> --allow-trusted-code` and the same explicit runtime selection. This executes as the current user without an OS sandbox. Importing an asset or source is not permission to execute downloaded code.
5. Review actual geometry, frames, simulation caches and physical output receipts. For a successful PNG sequence, `slopcamera studio encode <studio-id> --output-id beauty --json` returns a verified video derivative. Use `studio assemble <studio-id> --output-id beauty --json` to create an ordinary project from an opaque sequence, add the selected video/audio with `project add`, and render the intended delivery.

The default Blender starter requests Cycles GPU. Missing GPU support fails instead of silently switching to CPU. A separate bake job retains a native scene and caches; rendering an existing cache is a separate source bundle and job. Native control rigs, materials and physics are broader than the portable spatial scene contract.

`studio assets search|describe|plan|import` provides a free Poly Haven HDRI/PBR/glTF route. Search and selections are JSON inputs, and import consumes the complete saved plan. Preserve attribution, license, all listed dependencies and returned hashes. Import does not insert or execute the asset. Other native assets should come from user-supplied or explicitly authorized downloads, with their actual license and dependencies retained.

Use the existing Gateway catalog, generation, speech and transcription operations for missing images, reference clips and narration. Provider calls use their normal cost and upload controls; native rendering does not make a paid call. Manim owns silent visuals. The ordinary project owns narration, music and effects, so audio revisions do not require rerendering mathematical animation. Distinguish authored word/mouth cues from measured alignment and review the final sound when playback is available; report signal-only checks otherwise.

A failed or interrupted job is never automatically rerun. `studio inspect` rechecks retained evidence; `studio reconcile` restores only a matching completed validation checkpoint. Review custody before choosing a new job. Do not delete a machine activity marker to bypass unresolved work.

See the shipped `docs/studio.md` and checked `examples/studio/` for source conventions, color/alpha rules, native caveats and the local `.studio.run()` workflow operation. Source/runtime identities are observed provenance, not a complete hash of every plugin, font, library or ambient read.

## Share a native output without re-executing it

`studio asset <studio-id> --output-id <id> --asset-id <id> --representation native|encoded-video [--frame <index>] --json` rechecks one successful output and returns its spatial asset, binding and receipt. It never rerenders or silently transcodes. Preserve all three together. A frame selection uses the native job’s explicit frame index; an encoded-video selection requires a previously retained unambiguous encode. Unsupported GLB materials, skins or morphs fail before rendering. Keep the original native rig and export a deliberate compatible static derivative.

Use [directed scenes](directed-scenes.md) for calibrated `scene camera-track` samples, world-space media and saved splats. Three and Blender share explicit geometry/camera data or rendered pixels, not one live renderer or automatic lighting equivalence. The external vgpu example uses its own pinned Node/Dawn environment, not a fourth studio engine.

Encoding preserves PNG masters. RGB sequences produce lossless RGB video; straight RGBA produces QTRLE MOV. A 16-bit sequence records its 8-bit derivative policy. `studio assemble` initially admits opaque sRGB sequences up to 4096 pixels per side, 4000 frames and 60 seconds; transparent and linear/data passes need their explicit compositing paths.

For `.studio.run()` inside a durable local workflow, use [workflows and SDK](workflows-sdk.md). Generic plan approval never supplies native authority: execution needs invocation-scoped `--allow-trusted-code` plus the selected studio runtime. For Manim visuals with narration, read [educational video](educational-video.md); lesson audio references do not automatically synthesize or place tracks.
