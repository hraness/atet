# A narrated geometry lesson

This example renders a ten-second portrait Manim scene. Luma, an original copper lantern robot, points to a right triangle while 25 unit tiles rearrange into a five-by-five square. The final formula uses Manim Community's Typst renderer. The example demonstrates the 3–4–5 triangle; it does not prove Pythagoras for arbitrary triangles.

## Author the retained lesson

`lesson.json` contains the mathematical parameters, presentation text, cue times, and timing provenance. Times are integer microseconds. Caption words, mouth shapes, and gestures use half-open intervals; gaps between mouth cues select the resting mouth.

The checked example has authored caption and mouth timings. These timings are a creative draft, not measured speech alignment. The complete narration script is:

> A right triangle. Three up, four across. Square both legs: nine plus sixteen. That's twenty-five. So the long side is five.

Use `parameters.lessonFile: "lesson.json"`, or supply the same validated data in `parameters.lesson`. The supported tile template takes two integer legs, each at most 12, with an integer hypotenuse at most 15. All displayed triangle lengths, square counts, and tile destinations derive from those values. Other explanations use an explicitly trusted Python scene with the reusable presenter, caption rail, `math_label`, and timing helpers.

Include exactly these source files in the retained bundle:

| Bundle path | Source |
| --- | --- |
| `scene.py` | This example's explicit entrypoint |
| `lesson.json` | This example's retained lesson |
| `lesson.py` | `apps/desktop/studio/education/lesson.py` |
| `toolkit.py` | `apps/desktop/studio/education/toolkit.py` |

The host records each file's bytes and digest. The fixed driver is separate from the author bundle. Importing or planning a bundle does not execute these files. Rendering runs explicitly trusted current-user Python; it is not a security sandbox or a hermetic build.

## Render the scene

Select Manim Community 0.21 with its Typst optional dependency, the Cairo renderer, `scene: "PythagoreanLesson"`, and `transparent: false`. The sample uses 480×854, 24/1 FPS, and frames `[0, 240)`. The reusable layout supports portrait aspect ratios from 0.48 through 0.75 and fits its title, panel, presenter, and captions inside the camera.

Declare `beauty` PNG frames at `frames/%06d.png` and/or one opaque MP4 at `lesson.mp4`. PNG still output captures the last frame in the requested interval. Frame numbers retain the requested native indices; movie PTS starts at zero at the same exact rational cadence. Output interpretation is sRGB, uint8, RGB, opaque, color, unitless. Transparent rendering requires PNG with RGBA and straight alpha. The MP4 uses lossless RGB encoding so ordinary project assembly can avoid an extra chroma conversion during handoff.

The driver profile supports up to 2048 pixels per dimension, four megapixels, 60 FPS, and intervals ending by frame 14,400. It checks the declared output byte and file limits, and the host independently checks physical outputs and decoded media. Cairo is a CPU profile. The driver does not claim GPU rendering or generate audio.

## Bind narration, sound effects, and delivery captions

The optional narration shape is `{"assetId":"voice_luma","transcript":"..."}`. Sound effects use `{"assetId":"tile_click","atUs":7600000,"gainDb":-18}`. These are inert references to existing retained SLOPCAMERA assets; the host verifies the source bytes and places audio in the ordinary project clock. The Manim driver never resolves credentials, synthesizes speech, or fetches an asset.

For measured mouth movement, run Rhubarb on the exact retained WAV/OGG and import its JSON with `rhubarb_mouth_cues`. Retain the original cue receipt and recognizer identity with the audio, set `mouthTiming: "rhubarb"`, and retain the returned microsecond cues in the lesson. The converter discards absolute `soundFile` metadata and rejects overlap, nonfinite timestamps, or cues outside the lesson. Rhubarb mouth shapes are not word alignment; supply measured word timings separately before setting `captionTiming: "aligned"`.

Set `showCaptions: false` when the ordinary project caption layer owns visible delivery captions. Keep the same retained word timings so the delivery can preserve exact emphasis without rendering captions twice. Review actual frames and the assembled voice together before claiming lip-sync quality.

## Focused checks

`python -B -m unittest discover -s apps/desktop/studio/education -p 'test_*.py'` runs pure parser, geometry, timing, profile, and path tests without importing Manim. Native qualification is a separate admitted host run and must inspect the actual decoded frames, exact cadence, text margins, triangle/tile geometry, and narration synchronization.

The opt-in `apps/desktop/studio/education/qualify_native.py --output <fresh-absolute-directory>` runs static-frame, rational-cadence, alpha, short-scene, byte-budget, and portrait fixtures with the invoking Python runtime. It retains source manifests, jobs, logs, per-file digests, decoded PNG/MP4 pixel comparisons, and a contact sheet. Its observation file is explicitly separate from the host's authoritative studio receipt. Run it through the repository's native-work admission process.
