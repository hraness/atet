# Direct a native film studio

Use `atet studio` when the deliverable needs native Blender, CadQuery or Manim authoring. Keep the native source, caches and exact settings alongside review frames and final clips. This complements the existing Three/Spark scene and ordinary video-project workflows.

1. Choose a starter with `atet studio init <directory> --template blender-product|blender-character|blender-cloth|blender-fluid|cadquery-bracket|manim-lesson`.
2. Edit the source, explicit file list and typed job. Retain all helpers and input assets with `atet studio bundle <source.json> --json`. After source edits, use its new `bundleSha256` and a new job ID.
3. Inspect `atet studio plan <job.json> --json`. It does not load a native engine. Use `studio probe` with an explicit `--blender-bin` or `--python` path to inspect the installed runtime.
4. Run the requested trusted source using `atet studio run <job.json> --allow-trusted-code` and the same explicit runtime selection. This executes as the current user without an OS sandbox. Importing an asset or source is not permission to execute downloaded code.
5. Review actual geometry, frames, simulation caches and physical output receipts. For a successful PNG sequence, `atet studio encode <studio-id> --output-id beauty --json` returns a verified video derivative. Use `studio assemble <studio-id> --output-id beauty --json` to create an ordinary project from an opaque sequence, add the selected video/audio with `project add`, and render the intended delivery.

The default Blender starter requests Cycles GPU. Missing GPU support fails instead of silently switching to CPU. A separate bake job retains a native scene and caches; rendering an existing cache is a separate source bundle and job. Native control rigs, materials and physics are broader than the portable spatial scene contract.

`studio assets search|describe|plan|import` provides a free Poly Haven HDRI/PBR/glTF route. Search and selections are JSON inputs, and import consumes the complete saved plan. Preserve attribution, license, all listed dependencies and returned hashes. Import does not insert or execute the asset. Other native assets should come from user-supplied or explicitly authorized downloads, with their actual license and dependencies retained.

Use the existing Gateway catalog, generation, speech and transcription operations for missing images, reference clips and narration. Provider calls use their normal cost and upload controls; native rendering does not make a paid call. Manim owns silent visuals. The ordinary project owns narration, music and effects, so audio revisions do not require rerendering mathematical animation. Distinguish authored word/mouth cues from measured alignment and listen to the final film.

A failed or interrupted job is never automatically rerun. `studio inspect` rechecks retained evidence; `studio reconcile` restores only a matching completed validation checkpoint. Review custody before choosing a new job. Do not delete a machine activity marker to bypass unresolved work.

See the shipped `docs/studio.md` and checked `examples/studio/` for source conventions, color/alpha rules, native caveats and the local `.studio.run()` workflow operation. Source/runtime identities are observed provenance, not a complete hash of every plugin, font, library or ambient read.
