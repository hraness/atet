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
brand assets, remove content merely to make the video shorter, or select a
creative alternative on the user's behalf.

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
- image, SVG, GIF, video, emoji, HTML, shader, and Three.js overlays;
- local audio denoise, compression, volume, delay, and reverb;
- clean, warm, cool, cinematic, vivid, flat, mono, or manual color treatment;
  and
- captions, clean outputs, and captioned outputs.

Preserve the original recording and imported media. Apply changes to the
project or its editable scene source, then inspect the resulting project hash.
When an edit depends on evidence, use the evidence identifier returned by its
analysis rather than recomputing or approximating it.

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
6. render final outputs from the approved project state.

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
