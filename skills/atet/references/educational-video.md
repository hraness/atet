# Make an educational film

Use current-source `studio init lesson --template manim-lesson` for Manim visuals, or combine existing diagrams and spatial scenes when they better express the subject. Read [native studio](native-studio.md) for retained jobs and [video projects](video-projects.md) for composition.

Preserve supplied mathematical facts, units and labels. Separate an explanatory illustration from a measured simulation or formal proof. Use tested lesson helpers for layout, axes, typography, equations and camera framing; inspect the actual rendered notation and endpoints rather than trusting syntactically valid code.

## Retain and render visuals

The Manim starter contains a scene, lesson data and explicit toolkit helpers. Its initial profile is Cairo, 480×854, 24 fps and ten seconds of silent visuals. Select the exact Python environment; dependencies such as Typst belong to that environment. Edit the scene/data, retain every helper with `studio bundle`, then copy the returned bundle hash into a new job ID. Use `studio plan`, `probe` and an explicitly trusted `run` before `inspect`, `encode` and `assemble`.

Native frame intervals are half-open. Keep the lesson's animation clock inside the declared interval; a requested duration does not stretch or align independently authored content. Retain the original high-precision frames and source, even if an ordinary delivery uses a smaller derivative.

## Place narration and effects explicitly

Manim owns silent visuals. Narration or SFX references in lesson data do not automatically synthesize, import, align or place audio. Use caller-supplied audio, an authorized local voice tool, or [Gateway speech](gateway-media.md), then inspect duration and place its exact file in the ordinary project:

```sh
atet project add <project-id> narration.wav --role dialogue --at 0 --json
atet project add <project-id> cue.wav --role other --at 3 --json
```

Imported audio has unverified synchronization. For independently authored timestamps, inspect the complete edit and use `--allow-unverified-sync` only when that provisional timing is intended. For synchronized recordings, measure/apply alignment first. Keep subtitles and transcript wording reviewable; authored word times and mouth cues are not measured alignment. Rhubarb cues describe mouth shapes, not word boundaries.

## Review the explanation

Inspect meaningful frames, equations, crop and safe areas at delivery dimensions. Check that narration describes the visible state at the same time, effects do not mask speech, and the ending has no clipped sound or black padding. Play the actual audio when supported; otherwise report duration, levels and timing checks without claiming listening. Keep the explanation's original source, audio and project timing independently revisable.
