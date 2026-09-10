# Make an educational video

Use Manim for mathematical visuals and keep narration, music and sound effects in an ordinary Slopcamera project. Use a native Blender scene when the explanation depends on detailed 3D, or a spatial scene when named geometry and world-space media need editable camera direction.

This Manim path requires the [current-source studio commands](../reference/capabilities.md), a selected Python environment with Manim Community and the starter's Typst dependency, and FFmpeg/FFprobe.

## Author the lesson

```sh
slopcamera studio init lesson --template manim-lesson --json
```

Inspect `lesson/lesson.json`, `scene.py`, `lesson.py` and `toolkit.py`. The starter is a ten-second portrait lesson with an original presenter and a 3–4–5 triangle. Its 9 and 16 tiles rearrange into a 25-tile square; that example does not establish a general proof of Pythagoras.

Edit the script, supported mathematical parameters and cues. Declare every helper and input asset in `source.json`. Keep layout space for the presenter, diagram and captions, and use the lesson's half-open microsecond cue intervals. [The lesson reference](../../examples/studio/education/README.md) documents supported parameters and conversion helpers.

## Render silent visuals

```sh
slopcamera studio bundle lesson/source.json --json > lesson-bundle.json
```

Before planning, copy the returned bundle digest into a fresh job. Save and run this as `prepare-lesson.ts` with Bun:

```ts
const job = await Bun.file("lesson/job.json").json();
const bundle = await Bun.file("lesson-bundle.json").json();
job.bundleSha256 = bundle.bundleSha256;
job.jobId = `studio_lesson_${crypto.randomUUID()}`;
await Bun.write("lesson/current.job.json", JSON.stringify(job, null, 2));
```

```sh
bun prepare-lesson.ts
slopcamera studio plan lesson/current.job.json --json
slopcamera studio probe lesson/current.job.json --python /absolute/venv/bin/python --json
slopcamera studio run lesson/current.job.json --python /absolute/venv/bin/python --allow-trusted-code --json
```

Preserve the selected virtual-environment path. Inspect the actual frames and receipt before assembling:

```sh
slopcamera studio assemble <studio-id> --output-id beauty --name "Geometry lesson" --json
```

The Manim driver rejects source-side audio. Lesson audio IDs and cue metadata are authoring references; they do not automatically fetch, synthesize, import or place audio. Add selected retained audio through the ordinary project explicitly.

## Add narration and sound

Use supplied audio or [generate narration](generate-media.md) with an authorized Gateway call. Preserve the exact waveform and returned receipt. Then place it in the returned project:

```sh
slopcamera project add <project-id> narration.wav --role dialogue --at 0us --json
slopcamera project add <project-id> tile-click.wav --role other --at 7600000us --json
```

Those placements express authored timing. They are not proof of word alignment or lip sync. The lesson's authored mouth/word cues must remain labeled as such. Rhubarb mouth-shape output can be converted using `rhubarb_mouth_cues`; retain its original result and recognizer identity. Mouth shapes do not supply word timestamps, and measured words require their own evidence.

If project overlays own visible captions, disable the lesson's caption layer instead of rendering the same words twice. Keep the selected cue clock consistent with the video. Scene or diagram images may also be mounted on spatial planes, but their pixels do not become hidden 3D geometry.

## Check the final explanation

Render the ordinary project at the intended portrait dimensions. For deliberately authored unverified placements, acknowledge `--allow-unverified-sync`; otherwise apply the relevant synchronization evidence first. Use [video delivery checks](edit-video.md#render-and-inspect-the-delivery).

Inspect numerical labels, units, diagram geometry, presenter/caption collisions and each cue boundary. Listen to the assembled narration and check its pacing against the picture before describing it as synchronized. If listening or playback is unavailable, report the signal/frame checks you performed and the missing review. Keep mathematical source and native frames when audio changes so that a narration revision does not require a new visual render.
