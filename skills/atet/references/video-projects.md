# Edit a video project

Use this workflow for screen recordings, talking-head videos, product demos,
imported camera or audio takes, captions, motion layers, creative alternatives,
and multi-format delivery. Atet records editing decisions in a local project
and leaves original media unchanged.

## Define the finished result

Before editing, identify:

- the source recording or existing project;
- the intended audience and approximate duration;
- what should be removed, emphasized, or left untouched;
- whether the project needs generated images, video, speech, or transcripts;
- the required captions, logo, overlays, music, and audio treatment; and
- the final aspect ratios and clean or captioned versions.

Ask only when a missing choice would materially change the edit. Do not invent
brand assets, remove content merely to make the video shorter, or select a creative alternative outside the user’s supplied criteria.

## Inspect the host and project

Run these before building exact commands:

```sh
atet doctor --json
atet recordings list --json
atet projects list --json
atet workflows list --json
```

Use `atet inspect <recording> --json` for a recording bundle and
`atet project inspect <project> --json` for a project. Read IDs, streams,
placements, synchronization, analyses, and current edit state from those
results. Never guess them.

Check the bootstrap before promising a file-only edit. There is no public empty-project or arbitrary-media project creator: `projects create` requires a real stopped ATET recording, and `project add` / SDK `media.ingest` require an existing project. Current-source `studio assemble` creates one from a real successful native sequence; `direct assemble` uses accepted generated takes. Neither is a generic file import. Do not fabricate recording manifests or receipts, run paid generation to obtain an empty project, or hand-edit private state. If the request permits, use a standalone spatial scene for visuals and disclose any separate local audio/editor step; otherwise report the missing project bootstrap precisely.

If the work begins with a new Atet recording, create the project from that
recording, then add any independent footage or audio:

```sh
atet projects create --from-recording <recording-id> --name '<name>' --json
atet project add <project-id> camera.mov --role camera --json
atet project add <project-id> narration.wav --role dialogue --json
```

Imported media begins with unverified synchronization. When timing with another
track matters, inspect and apply audio alignment before cuts, filler removal,
camera moves, or rendering depend on it.

## Analyze before changing the edit

Use only the evidence the requested edit needs:

- `atet analyze inactivity` for long still or silent ranges;
- `atet analyze speech` and `atet fillers list` for words and safe filler
  candidates;
- `atet analyze faces` and `atet faces list` for local face geometry used
  by framing;
- `atet analyze music` before applying filler removal that must protect music;
- `atet analyze scenes` for scene boundaries or bounded scene descriptions;
  and
- recording events for cursor, click, keystroke, focused-input, and typed-text
  timing.

Face analysis is local geometry tracking, not recognition. Scene descriptions
upload only selected derived frames and require `--allow-cloud-upload`.
Speech analysis may use the configured local Whisper runtime; Gateway
transcription is the separate workflow in
[gateway-media.md](gateway-media.md).

## Make non-destructive editorial changes

Run `atet help project` for the current grammar. The project editor supports:

- cuts, trims, and speed changes in project time;
- camera push, reframe, arbitrary camera paths, and local face-follow framing;
- screen zooms tied to a rectangle, point, cursor, window, or focused input;
- cursor, click, keystroke, and typed-text presentation;
- direct image, SVG, GIF, video and emoji overlays;
- captions and interaction metadata; and
- captions, clean outputs, and captioned outputs.

Preserve the original recording and imported media. Apply changes to the
project or its editable scene source, then inspect the resulting project hash.
When an edit depends on evidence, use the evidence identifier returned by its
analysis rather than recomputing or approximating it.

Direct `project edit` does not accept HTML or arbitrary audio/color filters. Render HTML/Canvas/Three/WGSL through the local workflow `media.htmlOverlay` operation, then use its returned video as a project layer. `media audio` and `media color` produce separate controlled derivatives.

Overlay `--position x,y` is an offset from its selected anchor. Use `--anchor center --position 0,0` to center a layer, or `--anchor top-left --position 42,70` for an actual top-left pixel position. A full-frame overlay uses top-left at `0,0`. Do not add half the canvas dimensions to center offsets.

For independently authored media, explicit `project add --at` timing may be appropriate. Rendering with `--allow-unverified-sync` acknowledges provisional synchronization; it does not turn authored times into measured alignment. Finish ordinary edits before V2 spatial migration, because ordinary editing rejects the migrated head.

## Choose one HTML authoring surface

Run `atet html catalog` before creating a transparent HTML overlay. Choose the
profile by its primary job:

- `plain` for document layout, CSS, SVG, and native browser drawing;
- `motion` for seekable DOM or SVG choreography;
- `p5` for an immediate-mode Canvas 2D sketch;
- `two` for a retained vector 2D scene;
- `paper-shaders` for a parameterized texture or gradient;
- `three` for a retained 3D scene; and
- `vgpu` for explicit WGSL, compute, or pass-level GPU control.

Atet owns the clock and declared assets in every profile. Keep p5 in P2D instance
mode with an empty startup draw, `noLoop()`, and one awaited `redraw()`. Keep
Two.js on its explicit WebGL renderer with `autostart: false` and one manual
`render()`. Derive all visible state from the absolute Atet frame and
`AtetOverlay.randomFor`; never add a CDN, live input, ambient asset loader, or
second frame loop.

## Use vgpu for explicit WebGPU effects

Choose `atet html scaffold vgpu --output <file.html>` for a reviewed fullscreen
WGSL effect or a composition that needs explicit WebGPU passes. The
starter is one transparent pass; extend its checked source for bounded
multipass work instead of introducing a second animation clock.

- Derive motion from the absolute `timeMs` supplied by `AtetOverlay.onFrame`.
- Submit explicit `frame()` passes and wait for both frame completion and GPU
  settlement before the callback resolves.
- Keep the transparent clear and premultiplied-alpha contract intact.
- Expect the render to fail closed when WebGPU or its adapter is unavailable;
  do not add a silent Canvas, WebGL, or static-image fallback.

Prefer Motion for DOM animation, Paper Shaders for its existing texture and
gradient treatments, and Three.js for full 3D scenes. vgpu is not a reason to
rewrite an overlay that already fits one of those paths.

## Prefer a built-in workflow for a complete known job

Inspect the exact input schema with
`atet workflows show <id> --json` before preparing its JSON input.

- `talking-head-cleanup` removes long pauses, keeps local face evidence, and
  renders a final landscape talking-head video.
- `polished-screen-demo` analyzes inactivity, screen actions, faces, and
  music before applying cleanup, interaction effects, and face-aware framing.
- `chaptered-demo` adds a reviewed overlay composition and renders an exact
  final video.
- `social-variants` renders 16:9, 9:16, 1:1, and 4:5 branches, with clean and
  optional captioned outputs.
- `creative-iteration` makes two to sixteen independent preview candidates
  from one frozen project.
- `creative-selection` records an explicit human or task selection, promotes
  it when requested, and materializes named deliveries.

Read [workflows and SDK](workflows-sdk.md) for custom Bun authoring, exact plan approval and durable recovery. The seventh built-in, `directed-scene`, consumes prepared V2 scene render inputs.

Plan a workflow before running it. Do not choose or promote a creative
candidate unless the user has selected it or the request supplies a
deterministic selection rule.

## Preview before final delivery

For substantial edits:

1. inspect the current project;
2. plan or apply the requested edits;
3. render the complete timeline at preview quality;
4. inspect picture, sound, captions, transitions, framing, and the first and
   last frames;
5. revise the project, not the preview file; and
6. render final outputs from the selected project state.

Ordinary project render `--output` paths are relative to that project’s directory. Under the default workspace, `--output renders/final.mp4` means `artifacts/atet/projects/<project-id>/renders/final.mp4`. Resolve returned relative receipt paths against that project, not the shell directory.

Preview and final use the same timeline and composition. A preview is evidence
about the final edit, but still check the final file's duration, dimensions,
streams, and output path.

## Report the creative result

Tell the user:

- which recording or project was edited;
- what was generated, analyzed, removed, added, or reframed;
- which decisions remain alternatives rather than the current project state;
- the preview path they can review;
- every final output path and aspect ratio; and
- any upload, model, synchronization, or local-tool limitation that affected
  the result.
