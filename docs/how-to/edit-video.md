# Edit and deliver video

Use the ordinary media project when you need to revise footage, audio, cuts, camera framing, overlays or delivery variants. This guide assumes you have a recording, an existing project, or a retained clip from studio/directing assembly. See [capabilities and installation](../reference/capabilities.md) for the available host.

## Inspect the source and project

```sh
slopcamera doctor --json
slopcamera recordings list --json
slopcamera projects list --json
slopcamera project inspect <project-id> --json
```

Use `slopcamera inspect <recording-id> --json` for a recording bundle. If a new recording is the source, create its project:

```sh
slopcamera projects create --from-recording <recording-id> --name "Product demonstration" --json
```

`projects create` is recording-based; it does not accept an invented `--from-video` flag. Current-source `studio assemble` and `direct assemble` also create ordinary projects. Retain the project ID they return.

If you have only independent media files and no project, there is currently no public empty-project or arbitrary-file bootstrap command. `project add` and the SDK’s `media.ingest` both need an existing project. Do not manufacture a recording, native receipt or generated take to get past that boundary. A standalone scene can render visual assets without a media project; an external editor or explicit local audio mux remains a separate workflow, not a Slopcamera project import.

## Add and time the selected media

```sh
slopcamera project add <project-id> camera.mov --role camera --json
slopcamera project add <project-id> narration.wav --role dialogue --at 0us --json
```

Read the imported placement and stream IDs from inspection. Imported synchronization starts unverified. For recordings of the same event, use `slopcamera help align`, analyze the chosen reference/target audio streams, inspect the evidence and apply the exact returned alignment.

For an authored montage, `--at` declares placement time. It is not evidence that independently recorded streams are synchronized. If delivery intentionally uses that timing, pass `--allow-unverified-sync` explicitly on the render; its receipt remains provisional.

## Apply the needed edit

Use project time for structural cuts, trims and speeds. They affect all placements:

```sh
slopcamera project edit <project-id> trim 0s 16s --json
slopcamera project edit <project-id> cut 4s 5s --json
```

Those commands are examples of separate decisions; do not apply a cut merely because it appears here. `slopcamera help project` describes camera moves and screen effects. Camera framing addresses a placed video stream. Cursor, window and focused-input zooms need recording-backed metadata.

Choose evidence for the edit: local faces for framing, speech/filler analysis for spoken-word cleanup, music analysis before protecting music during cuts, or inactivity for long gaps. Scene descriptions use selected cloud-uploaded frames and require their acknowledgement. `media audio` and `media color` create typed local treatment derivatives; they are separate command families, not arbitrary `project edit` filters.

## Place graphics without clipping

Project image/video overlays use a position **offset from the selected anchor**. For a 720×1280 portrait output, this places a 636×180 caption with 42-pixel side margins:

```sh
slopcamera project edit <project-id> overlay add --kind image --source caption.png \
  --from 0s --to 3s --anchor top-left --position 42,70 \
  --width 636 --height 180 --json
```

To center an overlay, use `--anchor center --position 0,0`. A full-frame still uses a top-left anchor at `0,0` and the output dimensions. Inspect the returned edit and actual frames, especially where the overlay enters or leaves.

The direct overlay grammar accepts image, SVG, GIF, video and checked emoji sources. For HTML, Three or WGSL graphics, render a reviewed document through the local `media.htmlOverlay` workflow operation, then use the returned video layer. [The HTML guide](../html-overlay-creative-toolkit.md) explains the available authoring profiles.

## Render and inspect the delivery

```sh
slopcamera project render plan <project-id> --width 720 --height 1280 --fps 24 --output renders/portrait.mp4 --json
slopcamera project render run <project-id> --width 720 --height 1280 --fps 24 --output renders/portrait.mp4 --json
```

Render output paths are relative to the project directory. With the default workspace layout, the example writes `artifacts/slopcamera/projects/<project-id>/renders/portrait.mp4`, not a top-level `renders/` directory. The returned invocation includes its full physical path. Inspect the whole edit's picture and sound, caption margins, each cut, and the first and last frames. Check the final duration, dimensions and streams. A successful encode is not evidence that the story or synchronization is correct; record any review you could not perform.

For repeated work, inspect a built-in workflow such as `talking-head-cleanup`, `polished-screen-demo`, `chaptered-demo` or `social-variants`. See [run or recover a workflow](run-workflows.md).

Complete ordinary media edits before [V2 spatial-project migration](../spatial-scenes.md#direct-a-project-through-shots). Its current adapter freezes the media/edit pair and rejects later legacy writers; it is not a general replacement for the ordinary editor.
