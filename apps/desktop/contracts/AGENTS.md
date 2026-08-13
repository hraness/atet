# Contents

- `recording.ts` – recording-bundle identity, source, segment, track, permission, event, and lifecycle schemas.
- `edit.ts` – non-destructive keep/speed/zoom/overlay/cursor/keystroke edit-plan schemas.
- `project.ts` – multi-asset project, stream, placement, drift-aware sync-map, analysis-reference, and global project-edit schemas.
- `project-render.ts` – fully resolved asset/project/output slices for deterministic multi-angle rendering.
- `analysis.ts` – local face geometry, audio-alignment, project inactivity, music/tempo/key, scene-description, transcript, and filler-analysis schemas.
- `media-effects.ts` – ordered audio-effect chains and deterministic video color-grade selections for repository-local derived media.
- `video-effects.ts` – backend-neutral artistic look graphs, bounded grain/diffusion/dither primitives, and stable preset inputs.
- `runtime.ts` – bounded desktop bridge requests, responses, snapshots, and events.
- colocated `*.test.ts` and `*.property.test.ts` files – concrete and law-based boundary coverage.

# Guidelines

- Export schemas and inferred readonly types together. Parse external values from `unknown`; do not duplicate hand-written wire types.
- Use strict discriminated unions, opaque prefixed identifiers, repository-relative paths, finite values, and integer microseconds.
- Keep raw source time distinct from rendered output time. Edit operations refer to the immutable logical source timeline.
- Keep asset-local evidence distinct from project time. Only accepted placement sync maps project asset clocks; global structural edits exist once in project time.
- Store immutable analysis evidence separately from an accepted sync map. Applying evidence must remain an explicit, stale-checkable action.
- Keep face evidence local-only and geometry-only: normalized boxes and continuity track IDs are allowed; identity, embeddings, names, crops, and thumbnails are not.
- Model overlay source differences explicitly for image, SVG, GIF, video, and emoji assets; do not create optional-field bags that admit contradictory playback settings.
- Keep bridge payloads bounded. Detailed frame, window, cursor, and typing metadata belongs in bundle JSONL files, not renderer events.
- Reuse `SceneDescriptionSchema` and the selected-frame upload policy from `@hraness/transmute/scene`; persisted analysis contracts must not drift from the local provider boundary.
- Model local audio effects and color grades as strict versioned transforms with bounded numeric controls, explicit ordering, output profiles, and no arbitrary FFmpeg expressions.
- Keep artistic dither in the ordered look graph and codec/output dither in renderer policy; they solve different problems and must not be conflated.
