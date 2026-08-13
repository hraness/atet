# Architecture

Transmute turns source material into visual assets. Its public model has three
primitives:

- a still frame;
- a structured scene that can be inspected and edited;
- a time-based composition.

Images, diagrams, animated loops, and videos are the four common outputs built
from those primitives. HTML, SVG, tldraw, Three.js, shaders, captions, audio,
and recorded screens are composition inputs or rendering techniques rather
than separate project types.

## One engine

`@hraness/transmute` contains the portable graph, workflow, diagram, render,
vectorization, and operation contracts. `@hraness/transmute/local/*` adds the
durable project store, media pipeline, renderer, scheduler, and native capture
adapters. The command-line interface uses both layers.

The desktop application is a shell over that same local engine. It supplies a
preview window, operating-system permissions, screen and camera capture, and
native packaging. It does not define a second project model or a separate SDK.
A Bun script, the CLI, and the desktop application can therefore open and
render the same project.

## Project state and variants

A project commit is immutable. It identifies source assets, the composition
graph, timing, styling, and every input needed to reproduce an output. Export
requests refer to that commit and add a render profile:

```ts
type RenderProfile = {
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:5";
  captions: "none" | "burned-in" | "sidecar";
  quality: "preview" | "final";
};
```

One frozen commit can fan out into independent YouTube, Instagram, TikTok,
square, captioned, and clean variants. Variants never rewrite their parent.
Expensive encodes are admitted under a resource ceiling so concurrent jobs do
not make one another slower.

Creative alternatives use the same rule. Each candidate starts from an exact
base commit and records its own result. Selection promotes one candidate into
a new explicit commit. Conflicting editorial changes fail closed instead of
being merged silently.

## Cached work

Every deterministic stage derives a cache key from:

1. the operation and its version;
2. canonical parameters;
3. hashes of the input assets;
4. the renderer and toolchain identity;
5. the render profile where it affects pixels or timing.

Artifacts are immutable and content-addressed. A changed caption style can
reuse transcription, scene analysis, and decoded media. A different aspect
ratio can reuse source normalization and audio analysis. Failed or interrupted
work never publishes a complete cache entry.

The scheduler prepares each ready node once, reuses an exact cached result,
and bounds CPU, memory, local I/O, and heavyweight encodes. Independent nodes
may run in parallel; overlapping resource claims remain serialized.

## Preview and final rendering

Preview is a complete, lower-cost render rather than a partial simulation. It
uses the full timeline at reduced resolution, bitrate, sampling density, and
effect quality. That makes pacing, caption timing, cuts, and audio alignment
truthful throughout the project.

Final rendering resolves the same composition with the final profile. Cached
analysis and source preparation carry forward. A final artifact is published
only after its complete output and receipt have been written atomically.

## Network boundary

Local files, project state, recordings, and rendered assets remain local.
Model-backed operations call Vercel AI Gateway directly. Transmute reads an
`AI_GATEWAY_API_KEY` supplied to the process, or a short-lived
`VERCEL_OIDC_TOKEN` when it runs in a linked Vercel environment. It has no user
database, account service, hosted session, subscription system, or remote state
deployment.

The key is never accepted in command arguments or project files. A convenient
local invocation is:

```sh
vercel link
vercel env run -- transmute image generate "a polished metallic monogram" \
  --output monogram.webp
```

The same credential boundary serves image, video, speech, transcription, and
scene-description operations. Deterministic rendering and vectorization stay
network-silent.
