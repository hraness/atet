# Atet desktop and CLI

Atet captures synchronized raw inputs into repository-local bundles, combines independent camera and audio takes on one typed project clock, then applies non-destructive edits through the `atet` CLI. The CLI is the product surface for agents. The macOS window remains only start, pause, resume, stop, and input status.

## Recording bundles

The default root is `artifacts/atet/recordings/`, resolved from the Atet checkout. `artifacts/` is gitignored and excluded from Vercel uploads. Atet never falls back to an external data directory.

```text
rec_<id>/
├── manifest.json
├── events/
│   ├── segment_0001-cursor.jsonl
│   ├── segment_0001-input.jsonl
│   ├── segment_0001-windows.jsonl
│   └── segment_0001-focus.jsonl
├── segments/
│   ├── segment_0001/
│   │   ├── display_<id>.mp4
│   │   ├── camera_<id>.mov
│   │   └── microphone_<id>.m4a
│   └── segment_0002/
├── edits/
├── analysis/
└── renders/
```

Each connected display is recorded independently. System audio, microphone audio, and webcam video remain independently addressable logical tracks even when a native container carries multiple streams. Pause finalizes the current synchronized segment; resume opens another. Finalized media and event streams are immutable.

Cursor, click, key activity, focused-input bounds, window geometry, display topology, and lifecycle metadata use integer source-time microseconds plus native monotonic timestamps. Typed-text capture is disabled by default. Secure fields are always redacted.

## Multi-asset projects

Projects live under the equally gitignored `artifacts/atet/projects/` root. Generated images, videos, speech, transcripts, local effects, and immutable invocation receipts live under `artifacts/atet/generated/`. A project owns references to immutable recording tracks and content-addressed imported media, not rewritten raw files.

```text
project_<id>/
├── project.json                  # assets, streams, placements, sync maps, analysis refs
├── imports/                     # extension-independent, content-addressed camera/audio takes
├── edits/current.json           # one global project-time edit plan
├── analysis/
│   ├── alignment/               # immutable audio-alignment evidence
│   ├── faces/                   # local face boxes and geometry-continuity tracks
│   ├── inactivity/              # synchronized freeze, silence, and interaction evidence
│   ├── music/                   # presence, tempo/changes, and musical key
│   ├── scenes/                  # sampled-frame descriptions and upload provenance
│   ├── speech/                  # words, utterances, and filler candidates
│   └── scene-frames/            # bounded derived JPEG samples
├── assets/                      # content-addressed overlay inputs
└── renders/                     # immutable plans plus verified video receipts
```

Every imported take starts with an `unverified` placement. Audio alignment produces immutable candidates; applying one creates a checked, drift-aware map from that asset clock into project time. Cuts, trims, speed changes, camera moves, metadata zooms, and overlays exist once in project time, so all video and audio placements remain synchronized. Every asset-derived filler decision records the placement sync hash used to project it; stale decisions fail closed.

One output-time camera evaluator drives both the rendered video crop and the
metadata compositor. Cursor samples, click cues, and focused-input typing
therefore follow manual or face-derived pans and pushes through cuts and speed
changes instead of detaching from the pixels they annotate.

## CLI

Run commands from the repository root:

```sh
# Capture and inspect one synchronized recording.
atet doctor
atet record start
atet record start \
  --display <display-id> \
  --camera-device <camera-id> \
  --microphone-device <microphone-id>
atet record pause
atet record resume
atet record stop
atet recordings list --json
atet inspect <recording>
atet events <recording> --kind click --around 12.5s --jsonl
atet render plan <recording> --display primary --json
atet render run <recording> --output renders/final.mp4

# Build and align a multi-angle project.
atet projects create --from-recording <recording> --name 'Atet take'
atet project add <project> camera-a.mov --role camera
atet project add <project> field-recorder.wav --role portable-audio
atet align analyze <project> --reference <asset:audio-stream> --target <asset:audio-stream> --apply
atet project inspect <project> --json

# Discover and run every current Vercel AI Gateway media model.
atet ai models list --type image --json
atet ai models list --type video --json
atet ai models show google/veo-3.1-generate-001 --json
AI_GATEWAY_API_KEY="$AI_GATEWAY_API_KEY" atet ai models list --type image
atet ai image generate --model openai/gpt-image-1.5 --prompt 'minimal chapter card'
atet ai image generate --model google/gemini-3.1-flash-image \
  --prompt 'revise this composition' --image reference.png --allow-cloud-upload
atet ai video generate --model google/veo-3.1-generate-001 \
  --prompt-file shot.txt --frame first=opening.png --frame last=closing.png \
  --duration 8 --resolution 1080p --generate-audio true --allow-cloud-upload
atet ai video generate --model alibaba/wan-v2.7-r2v \
  --prompt 'continue the camera move' \
  --reference 'https://cdn.example/source.mp4' \
  --provider-options artifacts/atet/private/wan-reference.json --allow-cloud-upload
atet ai speech generate --model xai/grok-tts --text-file narration.txt --voice eve
atet ai transcribe interview.wav --model openai/whisper-1 \
  --allow-cloud-audio-upload --format all

# Create non-destructive local derivatives.
atet media audio interview.wav --denoise --compressor --volume-db -2
atet media audio screen.mp4 --delay-ms 160 --reverb room
atet media color screen.mp4 --preset cinematic --temperature 0.08

# Structure local media evidence.
atet analyze inactivity <project> --min-duration 3s --handle cut
atet analyze inactivity <project> --min-duration 3s --handle cut --apply
atet analyze music <project> --source <asset:audio-stream> --window 20s
atet analyze faces <project> --source <asset:video-stream>
atet faces list <project> <face-analysis-id> --min-duration 750ms
atet analyze scenes <project> --source <asset:video-stream>
AI_GATEWAY_API_KEY=… atet doctor
atet analyze scenes <project> --source <asset:video-stream> --execute --allow-cloud-upload
atet analyze speech <project> --source <asset:audio-stream> --model /path/to/ggml-model.bin
atet fillers list <project> <speech-analysis-id> --auto-only
atet fillers apply <project> <speech-analysis-id> <candidate-id>

# Project-wide edits and output.
atet project edit <project> cut 8s 11.2s
atet project edit <project> speed 20s 35s 1.5
atet project edit <project> camera push --placement <id> --stream <id> --from 4s --to 6s --center 0.68,0.42 --end-zoom 1.8
atet project edit <project> camera reframe --placement <id> --stream <id> --from 10s --to 14s --from-frame 0.5,0.5,1 --to-frame 0.67,0.45,2
atet project edit <project> camera path --placement <id> --stream <id> --keyframe 0s,0.5,0.5,1 --keyframe 2s,0.65,0.42,1.4 --keyframe 5s,0.4,0.5,2
atet project edit <project> camera follow-faces --placement <id> --analysis <face-analysis-id> --from 20s --to 35s --select largest
atet project edit <project> zoom --from 12s --to 16s --target focused-input --source-placement <recording-placement>
atet project edit <project> cursor on --click-highlight true --source-placement <recording-placement>
atet project edit <project> typed-text on --idle-timeout 900ms --source-placement <recording-placement>
atet project edit <project> overlay add --kind gif --source reaction.gif --from 4s --to 9s --loop
atet project render plan <project> --json
atet project render run <project> --output renders/final.mp4
```

`record start` defaults to every connected display, system audio, the default
camera, and the default microphone. `doctor --json` exposes the exact selectable
IDs. Repeat `--display` for a bounded display subset, or pass
`--camera-device`/`--microphone-device` to pin a device instead of following the
system default. Duplicate IDs, unavailable IDs, and selections above the
16-display capture bound fail before media starts.

Read commands default to a bounded text summary and accept `--json`; event queries also accept `--jsonl`. Mutations write atomically and return a normalized plan hash. Camera mutation receipts additionally return the created move ID, keyframe count, bounded face selection when applicable, and exact `camera show`/`camera remove` next commands.

### Agent code mode

Code mode lets an agent describe the whole edit as a typed TypeScript graph instead of issuing one CLI command after another. Built-in workflows, custom programs, and the migrated CLI slices resolve through the same closed application-operation registry; legacy CLI-only analyzers and mutations remain characterized adapters until they are migrated operation by operation. The host owns every registered operation's schema, privacy classification, resource claims, retry rules, and receipts.

The surface is progressively disclosed:

| Need | Surface |
| --- | --- |
| One edit or analysis | Existing `atet` command |
| A common complete recipe | `atet workflows ...` |
| A project-specific composition | `@hraness/atet/local/code` semantic builder |
| A reusable operation set | A namespaced TypeScript workflow fragment |
| A new privileged capability | A reviewed application operation and registry entry |

Discover the installed vocabulary and the six reusable recipes:

```sh
atet operations list --json
atet operations show render.project@2 --json
atet workflows list --json
atet workflows show polished-screen-demo --json
atet workflows show creative-iteration --json
atet workflows show creative-selection --json
```

List output stays compact; `operations show <kind>[@<version>] --json`
expands the selected operation's owned input and output JSON Schemas. A kind
with multiple registered versions must include `@<version>`.
`workflows show --json` expands the selected workflow's input JSON Schema. An
agent can therefore discover one contract without loading the entire catalog.

`code check`, `code plan`, and `code run` semantically typecheck custom
TypeScript before evaluating it. Planning then builds and validates the
complete graph, derives its effect and resource envelope, binds the current
structural project state, and prints deterministic dependency waves. It does
not execute registered operations. Typechecking and bundling consume the same
private immutable snapshot of the bytes that passed import-policy scanning.
Running with an expected custom-code plan hash fails if source, input,
registry, Bun revision, worker implementation, selected native-helper bytes,
or a bound subject changed.

```sh
# A built-in workflow: independent analyses join at one checked edit commit,
# then a face-derived camera path becomes the immutable render revision.
atet workflows plan polished-screen-demo \
  --input artifacts/atet/private/polished-input.json --json
atet workflows run polished-screen-demo \
  --input artifacts/atet/private/polished-input.json --jobs 4 --jsonl

# A custom workflow starts from a non-overwriting typed template.
atet code init artifacts/atet/private/workflows/my-demo.ts
atet code check artifacts/atet/private/workflows/my-demo.ts --json
atet code plan artifacts/atet/private/workflows/my-demo.ts \
  --input artifacts/atet/private/my-demo-input.json --json
atet code run artifacts/atet/private/workflows/my-demo.ts \
  --input artifacts/atet/private/my-demo-input.json \
  --plan <graph-plan-sha256> --jobs 4 --jsonl
```

The polished input names the exact camera placement and project-time range; the
workflow never guesses which layer contains the presenter. Selecting `all`
uses group framing by default, while `largest` uses medium framing:

```json
{
  "cameraSource": "asset_camera01:stream_camera01",
  "faceFollow": {
    "placementId": "placement_camera01",
    "projectRange": { "startUs": 0, "endUs": 30000000 },
    "selection": { "kind": "all" }
  },
  "musicSource": "asset_music01:stream_music01",
  "project": "project_demo01"
}
```

Workflow construction is declarative: a method returns a typed `Ref<T>`, and embedding that reference in another node infers and independently verifies the dependency. Namespaces give reusable fragments stable node identities. Ordinary TypeScript remains available for loops over known variants, calculations from validated inputs, and composition:

```ts
import { z } from "zod";
import { defineWorkflow } from "@hraness/atet/local/code";
import {
  renderFrozenProject,
  resolveWorkflowRenderOptions,
} from "@hraness/atet/local/code/workflows";

const Input = z.strictObject({
  project: z.string(),
});

export default defineWorkflow({
  id: "my-demo",
  inputSchema: Input,
  inputSchemaId: "example.workflow.my-demo.input/v1",
  version: 1,
  build(workflow, input) {
    const project = workflow.project.snapshot("project", input.project);
    const evidence = workflow.namespace("evidence");
    const inactivity = evidence.analysis.inactivity("inactivity", { project });
    const edits = workflow.edits.batch("edits", {
      cutRanges: inactivity.select("cuts"),
    });
    const committed = workflow.project.commitEdits("commit", {
      batch: edits,
      project,
    });
    const rendered = renderFrozenProject(workflow, "final", {
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
      output: resolveWorkflowRenderOptions(
        undefined,
        "renders/my-demo/final.mp4",
      ),
      project: committed,
    });
    return { render: rendered.output };
  },
});
```

`social-variants@3` uses the same target model for 16:9, 9:16, 1:1, and 4:5.
It defaults to full-duration 24 fps preview geometry and accepts
`"tier": "final"` for the 30 fps final canvas sizes. When captions are requested,
clean and burn-in outputs share one immutable geometry revision; independent
geometry branches remain explicit in the graph. V2 render nodes reserve the
shared bounded CPU and FFmpeg pools plus one exclusive video-encode slot. Every
other FFmpeg operation also reserves the complete pools until its recipe binds
and proves a smaller execution-wide thread budget. On
macOS and Linux, that admission state is machine-global across Atet
processes and Git worktrees, so encodes from parallel agents cannot contend
with one another. Other ready work remains eligible when its declared
resources fit.

`creative-iteration@1` takes two through sixteen stable variant keys. Every
candidate uses the same frozen project snapshot, owns an immutable edit
revision, and renders a full-length preview at the selected standard profile.
The workflow closes the verified candidate set into a matrix and stops. It
does not choose or promote a winner:

```json
{
  "project": "project_demo01",
  "previewProfile": "portrait",
  "candidates": [
    { "variantKey": "baseline" },
    {
      "variantKey": "tight-cut",
      "ordered": [
        { "kind": "trim", "range": { "startUs": 0, "endUs": 30000000 } }
      ]
    }
  ]
}
```

Use `creative-selection@1` with the matrix reference returned by that run.
The selection is always an immutable artifact. Setting `"promote": true`
adds a checked editorial compare-and-swap. Named deliveries copy a selected
verified render without changing the current edit plan:

```json
{
  "matrix": { "...": "the exact matrix reference from the prior run" },
  "variantKey": "tight-cut",
  "promote": true,
  "deliveries": [
    {
      "deliveryKey": "review-copy",
      "renderName": "preview",
      "destinationPath": "renders/review/selected.mp4"
    }
  ]
}
```

Custom Bun workflows can split this lifecycle across agents. Parse prior run
outputs with `ProjectSnapshotOutputSchema`,
`CreativeCandidateReferenceV1Schema`, `VariantMatrixReferenceV1Schema`, or
`VariantSelectionReferenceV1Schema`. Then adopt them with
`workflow.iteration.baseFromSnapshot`, `candidateFromReference`,
`matrixFromReference`, or `selectionFromReference`. Immutable candidate
publication can overlap across processes. One canonical project store owns the
media state; worktrees are for code authoring, not competing project copies.
Promotion accepts only the exact frozen edit basis. A concurrent editorial
change leaves every candidate intact and rejects the promotion.
Candidate preview outputs use a stable full derivation identity. An exact run
can adopt the original immutable output and verified receipt before any FFmpeg
preparation; a changed revision, plan, target, encoder recipe, byte policy,
sync policy, Atet renderer ABI, or probed toolchain receives a distinct
path. This specialized
reuse does not claim that unrelated render operations share a generic cache.

References embedded in node inputs create data dependencies. For causal order
without passing a value, every semantic helper also accepts `after`:

```ts
const started = workflow.recording.start("start", recordingOptions);
const paused = workflow.recording.pause("pause", { after: started });
const resumed = workflow.recording.resume("resume", { after: paused });
const stopped = workflow.recording.stop("stop", { after: resumed });
```

An `after` reference must already belong to the same builder, so control edges
cannot point forward, cross graphs, or create a cycle.

Overlay preparation is also a first-class operation. Independent image, SVG,
GIF, video, and checked emoji preparations run in parallel; `addOverlays`
becomes their explicit join, and one checked project transaction publishes the
complete composition. A Gateway output reference can feed an overlay directly
without converting it to an ambient path:

```ts
const title = workflow.media.overlay("title", {
  project,
  range: { startUs: 0, endUs: 3_000_000 },
  source: { artifact: { path: "assets/title.svg" }, kind: "svg" },
});
const generated = workflow.gateway.image("generated-card", {
  model: "openai/gpt-image-1.5",
  prompt: "A restrained chapter card on transparent black.",
});
const generatedCard = workflow.media.overlay("generated-overlay", {
  project,
  range: { startUs: 3_000_000, endUs: 6_000_000 },
  source: {
    artifact: generated.select("outputs").at(0),
    kind: "image",
  },
});
const overlayBatch = workflow.edits.addOverlays(
  "overlay-batch",
  [title, generatedCard],
);
const composed = workflow.project.commitEdits("overlay-commit", {
  batch: overlayBatch,
  project,
});
```

Each prepared layer receives a content-derived ID, an immutable preparation
receipt, and a project-local content-addressed asset. Stable `identityKey`
values distinguish deliberate duplicate uses of the same bytes. The built-in
`chaptered-demo@3` packages the same prepare-many/commit-once pattern behind a
bounded overlay-set input.

Complete edit transactions are an explicit second layer. Ordinary
`edits.batch` / `commitEdits` nodes stay on the metadata-free version-1
contract. A workflow that needs interaction effects, manual camera moves, or
zoom operations opts into the stable `completeBatch` /
`commitCompleteEdits` semantic surface. Those names advance to the newest
resource-bounded host contract; workflow authors do not select storage
versions:

```ts
import {
  polishedInteractionEffects,
} from "@hraness/atet/local/code";

const autoZooms = workflow.analysis.projectAutoZooms("auto-zooms", {
  project,
});
const complete = workflow.edits.completeBatch("complete-edit", {
  ordered: [
    {
      kind: "add-zooms",
      zooms: autoZooms.select("operations"),
    },
    polishedInteractionEffects(autoZooms.select("sourcePlacementId")),
  ],
});
const polished = workflow.project.commitCompleteEdits("commit-complete", {
  batch: complete,
  project,
});
```

Manual zoom intent is the next additive layer. `manualZoom` accepts ordinary
string IDs and may omit both placement and display selectors. The host
transaction resolves those selectors from the current project and recording,
then binds the stopped manifest and accepted placement synchronization before
publishing:

```ts
import { manualZoom } from "@hraness/atet/local/code";

const focus = manualZoom({
  placementId: "placement_screen01",
  range: { startUs: 12_000_000, endUs: 16_000_000 },
  scale: 2,
  target: { kind: "focused-input", paddingPx: 24 },
  zoomId: "zoom_focusedinput01",
});
const zoomBatch = workflow.edits.addManualZooms("focus-zoom", [focus]);
const zoomed = workflow.project.commitCompleteEdits("commit-focus-zoom", {
  batch: zoomBatch,
  project,
});
```

The complete metadata edit replaces cursor, click, keystroke, typed-text, and
metadata-placement settings together, so a recipe never inherits hidden prior
state. `setMetadataEffects` exposes the exact form; the conservative
`polishedInteractionEffects` preset keeps typed text off. `cameraPush` and
`cameraReframe` create binding-free normalized keyframes, while
`addManualCameraMoves`, `removeCameraMoves`, and `removeZooms` compose them into
the same ordered batch. Camera poses apply only inside each move range, so
adjacent moves should share a boundary pose when the shot must remain
continuous. The host—not workflow code—binds camera geometry, manual-zoom
display/recording identity, placement synchronization, and the exact
recording-manifest hash needed by metadata-driven effects. It rechecks that
evidence at the publication gate. Persisted version-1 and version-2 graphs
remain runnable; exact historical authoring is intentionally isolated under
the advanced namespace for immutable built-in workflows and migrations.
The current complete-batch contract accepts at most 10,000 expanded atomic
edits arranged into at most 64 adjacent normalization phases. Put related
additions or removals in one array: the host reduces each phase in linear time,
then validates the normalized boundary once. Workflows that must reproduce an
older, more highly alternating version-2 graph can select the exact historical
contract through `workflow.advanced`.

Local media passed directly to a media or Gateway node becomes a structural
file candidate automatically. If trusted compute must choose among files,
declare each workflow-input choice with `fileCandidate(...)` and validate it
with `WorkflowFileCandidateSchema`. Static planning binds the declared path,
media type, and optional exact byte/hash constraints without opening the file.
Only the chosen registered operation may then open and hash it while producing
the exact node plan; a compute-minted undeclared path fails before host
preparation or an approval prompt.

`workflow.analysis.scenes` runs the local FFmpeg scene planner without
uploading frames. Its node output contains the complete bounded scene ranges,
requested sample times, and sample reasons, while the ordinary completion
summary keeps only the plan digest and counts. Return the needed fields as
workflow outputs, or inspect the persisted evidence with
`atet runs show <run-id> --nodes all --json`. Gateway scene descriptions
remain an explicit local `atet analyze scenes ... --execute
--allow-cloud-upload` action.

The scheduler runs dependency-ready nodes concurrently while obeying the stricter of `--jobs`, the four-worker hard cap, and host resource pools for FFmpeg, Vision, local I/O, paid calls, output publication, project publication, and capture. Parallel analyses bind an append-only project edit basis, so one sibling may publish while another is paused without authorizing structural or prior-evidence drift. Mutable edits join into one ordered recoverable project transaction. Rendering first freezes the complete project and edit documents into an immutable geometry-bound revision, resolves an exact tool, media, and recording-metadata-bound plan, and publishes video plus receipt through an output-specific lease and durable precommit. Landscape, square, and portrait branches therefore remain independent.

Every run is durable under `artifacts/atet/private/workflow-runs/<run-id>/`. Inspect it with `runs list` and `runs show`; use `runs resume`, `runs approve`, or `runs cancel` when the bounded summary provides that next action. A normal resume reconstructs unfinished host operations from the persisted graph without evaluating the workflow bundle. Exact canonical analysis orphans and output-only render commits are adopted only through their run-bound recovery evidence. An interrupted arbitrary compute callback becomes `ambiguous-code` and requires an exact node-specific replay acknowledgement. Attached cancellation first aborts that callback's real signal, then force-retires an uncooperative worker after a bounded grace period. A paid request uses an exact request ID and durable dispatch journal; an unknown post-dispatch outcome is never submitted again automatically. Live recording actions reconcile against the same controller used by the desktop app and are never automatically replayed.

Custom code mode is trusted code, not a sandbox. Module top-level code and explicitly replayed compute callbacks run as the current user and can use ambient filesystem, process and network authority. Atet keeps its own credentials and privileged handles out of the worker, but it cannot contain malicious repository code. Review custom source before `code check`, `code plan`, or `code run`.

### Gateway media

`atet ai models` reads Vercel AI Gateway's public live catalog rather than a checked model allowlist. It includes image-model endpoints, image-generating language models, video, speech, and transcription. The cache uses conditional requests, a canonical revision, and stale-last-good fallback; `models show` preserves raw capabilities and exposes common settings plus the non-conflicting provider-option vocabulary known to this release. Batch and streaming transcription operations are labeled separately; the batch command rejects streaming-only models before credential access or dispatch. A bounded JSON object supplied with `--provider-options` remains the forward-compatible escape hatch for new service-owned fields. Gateway `models` fallback configuration is deliberately rejected because every paid model must be independently catalog-validated and durably accounted. Provider-specific sample-count fields are also rejected; use `--count` with `--max-per-call` at least as large so one Atet job maps to one AI SDK call.

Atet reads Vercel AI Gateway credentials from `AI_GATEWAY_API_KEY`, falling back to the `VERCEL_OIDC_TOKEN` injected by `vercel env run`. It never persists, prints, forwards to subprocesses, or accepts either value through argv.

Every paid invocation validates its live model kind, prompt, options, and all local files before dispatch. Reference images/videos require `--allow-cloud-upload`; transcription audio requires the separate `--allow-cloud-audio-upload`. Consent is per invocation. Atet resolves only each explicitly named physical file, bounds its bytes and media type, and records its SHA-256 without enumerating adjacent bundle files. The same image/video flags accept credential-free public HTTPS sources when the live catalog permits `url` or does not declare a source restriction; a catalog that explicitly lists only other source forms fails locally. Use the URL directly when its path has a recognized extension, or `<media-type>=<https-url>` when it does not. URLs with credentials, fragments, local hostnames, or private literal addresses fail locally. Remote bytes and intrinsic geometry remain provider-validated; durable state stores only a URL digest and declared media type, never the URL itself. Direct URL arguments remain visible to shell and process history, so use only references safe for that exposure.

Image generation exposes prompt/edit images, mask, count, batch size, dimensions, aspect ratio, and seed. Video exposes every AI SDK media input and common parameter: primary image, first/last frames, image/audio/video references, count, batch size, aspect ratio, resolution (including provider values such as `1080p`), duration, FPS, seed, and generated audio. Illegal precedence combinations fail locally: frames cannot accompany generic references, and a primary image cannot accompany a first frame. `--provider-options` accepts a bounded nested vocabulary spanning Google Vertex/Veo, Kling, Alibaba Wan, ByteDance Seedance, xAI Grok, Gateway routing, image-provider, speech, and transcription parameters; fields that can change model selection or duplicate a paid sample count are rejected in favor of the validated first-class flags. Those options can include BYOK credentials, webhook secrets, or similarly sensitive values: keep the source JSON gitignored and mode `0600`. Atet refuses a group- or world-accessible options file, forwards the parsed object for that invocation, and persists only its SHA-256 and namespace list—never the raw option values.

Video is one long-lived Gateway SSE request; Gateway does not expose a resumable job/status API. Atet writes a local pre-dispatch receipt, sets the AI SDK client's `maxRetries` to zero, and never resubmits an interrupted paid call. AI Gateway may still route or fail over that one request across multiple providers, so a single command can produce multiple provider attempts, and provider timeouts may still incur charges; receipts retain bounded generation/provider-attempt metadata when the SDK returns it, including on failures. An interrupted dispatched request remains visibly ambiguous. Retrying is always a new explicit command and may charge again. Successful media downloads reject private/local network targets, validate every redirect, share a per-request aggregate byte budget, and are preserved with privacy-safe warning hashes, catalog revision, normalized settings, input/output hashes, and explicit complete/partial/overproduced sample fulfillment. Atet fully decodes self-describing generated media locally before emitting an exact project-add command. Failed decode keeps the paid bytes and a hash-only quarantine receipt but returns an error and emits no import command. Headerless `audio/pcm`, `audio/l16`, `audio/alaw`, `audio/basic`, and `audio/mulaw` speech remains saved and hashed but deliberately receives no project-add suggestion; convert it with explicit sample metadata first.

`atet media audio` and `atet media color` never contact the network. Audio uses one documented deterministic order—denoise, compression, volume, delay, then deterministic multi-tap reverb—while omitting unrequested stages. Color combines seven common presets with brightness, contrast, saturation, gamma, temperature, tint, and hue. Both use bounded typed controls, checked FFmpeg argv, a verified descriptor-pinned input, fresh no-replace output publication, SHA-256 receipts, and leave the source unchanged. A path swap or in-place input mutation before publication fails closed without exposing the derived output. Output publication and receipt publication are sequential rather than one atomic pair: a process crash between them can leave an output without a receipt, and the next run reports a conflict so an agent can inspect and remove that orphan explicitly.

Resolved render plans are stored by their full composition hash, including the selected display. Every successful recording or project render writes a strict receipt beside the video that points to the immutable plan and records the output path, byte count, and SHA-256. Failed encodes never relabel an older output, and a receipt-publication failure removes any stale receipt.

Structural project mutations publish `project.json` and the current edit plan as one recoverable generation. Immutable before/after evidence lives under `state/transactions/`; an interrupted mutating command recovers it while holding the project lease, while unlocked readers fail closed until that recovery occurs.

### Overlay model

Overlay sources may be images, sanitized SVGs, GIFs, videos, or generated emoji. Animated sources have explicit source trim, loop/hide/freeze-end behavior, playback rate, volume, and mix/duck policy. Every overlay supports contain/cover/fill, normalized crop, anchor and pixel position, size, rotation, opacity, z-index, blend mode, rounded mask, entrance/exit motion, and repeatable transform/opacity keyframes. Playback stays continuous through project cuts and speed boundaries.

Diagrams, vectorization, generated media, and timeline composition share the
same application-operation registry and content-addressed artifact references.
The CLI therefore returns outputs that can be passed directly to media ingest
or overlay operations rather than copied through ambient temporary paths:

```sh
atet diagram init concepts/system-map.diagram.json
atet diagram check concepts/system-map.diagram.json --strict
atet diagram render concepts/system-map.diagram.json --scale 2
atet image vectorize artwork/mark.png \
  --output artwork/mark.svg --duotone '#111827,#f9fafb' --alpha-cutoff 8 --json
atet html catalog
atet html scaffold paper-shaders --output overlays/title.html
```

Diagram rendering publishes light and dark SVG/PNG variants plus editable
`.tldr` source. Vectorization publishes an inert bounded SVG and a quality
receipt. Both bind the exact input bytes and publish by content hash under
`artifacts/atet/generated/`; repeated equivalent work reuses the same
artifact. PNG outputs can feed `media.ingest`, while SVG outputs already match
the `media.overlay` artifact contract. This is the common interchange layer
for stills, diagrams, animated loops, generated imagery, and final video.

### Deterministic HTML overlays

`workflow.media.htmlOverlay` turns ordinary HTML, CSS, SVG, Canvas, WebGL, or a
declared local image into a transparent alpha-video layer. Start from the
portable authoring package instead of hand-writing CDN tags:

```ts
import { createHtmlOverlayScaffoldInput } from "@hraness/atet/local/html-overlay";

const scaffold = createHtmlOverlayScaffoldInput("paper-shaders");
const title = workflow.media.htmlOverlay("chapter-title", {
  canvas: { deviceScaleFactor: 1, height: 1080, width: 1920 },
  ...scaffold,
  parameters: { label: "A new shape" },
  project,
  range: { startUs: 0, endUs: 3_000_000 },
  resources: [{
    artifact: { path: "artwork/logo.png" },
    mediaType: "image/png",
    name: "logo",
    urlPath: "images/logo.png",
  }],
  seed: 42,
  timing: { durationUs: 3_000_000, fps: 30 },
});
```

The seven scaffolds are `plain`, `motion`, `p5`, `two`, `paper-shaders`,
`three`, and `vgpu`. Use `plain` for native layout and SVG, `motion` for DOM/SVG
choreography, `p5` for immediate Canvas 2D sketches, `two` for retained vector
2D scenes, Paper Shaders for parameterized textures, Three.js for retained 3D, and
[vgpu](https://vgpu.sh) for explicit WGSL and WebGPU passes. `atet html catalog
--json` returns this selection model with exact active library versions. The
[creative toolkit guide](../../docs/html-overlay-creative-toolkit.md) classifies
the wider ecosystem without adding those tools to Atet's executable allowlist.

The p5 starter uses instance-mode P2D, makes p5's mandatory startup draw empty,
disables its native loop, and awaits one manual redraw from each absolute Atet
frame. The Two.js starter selects WebGL explicitly, leaves autostart disabled,
preallocates a bounded retained vector scene, and calls one manual render per
Atet frame. Both clear to transparent, use keyed Atet randomness, avoid system
fonts and remote assets, and release their resources on page exit. Their exact
browser modules, versions, byte lengths, licenses, and SHA-256 values are
allowlisted. Author code imports only the scaffold's bare specifier; the host
supplies the canonical private import map.

The vgpu starter compiles its shader before readiness, submits one pass from
each absolute Atet frame, waits for GPU completion, and clears to transparent.
It fails closed when the selected browser runtime cannot acquire WebGPU; it does
not silently replace the effect with another renderer.

The Three.js starter defines the authoring contract.
It has explicit sRGB output and ACES tone mapping, no shadows or postprocessing,
automatic camera framing, reusable tracked GPU resources, shader precompilation,
context-loss failure, and cleanup. Its default ceiling is 64 draw calls and
200,000 triangles per frame. Motion comes only from the absolute Atet frame
clock. `orbitTurns`, `zoom`, and `explode` are bounded parameters. Use a 1x
`deviceScaleFactor` for full-length previews and raise it only for a selected
final render.

Reference-image code generation is deliberately staged. Generate or select one
image, inspect it, create the `three` scaffold, and let the agent replace only
its `createSubject()` function. Review the source and several preview angles
before execution. The final workflow binds the exact reference artifact even
when the image is not visible in the scene:

```ts
import { createThreeReferenceScaffoldInput } from "@hraness/atet/local/html-overlay";

const generated = workflow.gateway.image("reference", imageOptions);
const reference = generated.select("outputs").at(0);
const binding = createThreeReferenceScaffoldInput(
  reference,
  reference.select("mediaType"),
);
const scene = workflow.media.htmlOverlay("reviewed-three-scene", {
  ...binding,
  document: { path: "overlays/reviewed-scene.html" },
  canvas: { deviceScaleFactor: 1, height: 1080, width: 1920 },
  parameters: { explode: 0.35, orbitTurns: 1, zoom: 1 },
  project,
  range: { startUs: 0, endUs: 3_000_000 },
  timing: { durationUs: 3_000_000, fps: 30 },
});
```

The reference is a normal generated output with exact bytes, media type, path,
and SHA-256. HTML resource binding verifies those facts and rejects a declared
media type that disagrees with the generated artifact. Atet never accepts
model-produced JavaScript as an executable operation input. Code Mode evaluates
only the local workflow and scene source that the agent or user reviewed.

For a texture that should be visible, load only the declared private asset and
settle it before frame zero:

```js
const texture = new THREE.TextureLoader()
  .loadAsync(AtetOverlay.asset("reference-image"))
  .then((loaded) => {
    loaded.colorSpace = THREE.SRGBColorSpace;
    return loaded;
  });
AtetOverlay.ready(texture);
```

Reference-led image treatments remain generated image derivatives in the same
Code Mode graph. The metallic-logo recipe preserves the supplied mark as the
shape authority and varies only the named brand, background color, and metal
color:

```ts
import { createMetallicLogoImageRequest } from "@hraness/atet/local/code";

const metallic = workflow.gateway.image("metallic-logo",
  createMetallicLogoImageRequest({
    backgroundColor: "warm gray",
    brandName: "Hraness",
    model: input.imageModel,
    objectColor: "brushed cobalt",
    reference: input.logo,
  }));
```

The model stays explicit because image-reference support is a live provider
capability. For CLI use, save the output of `createMetallicLogoPrompt(...)` as
`metallic-logo-prompt.txt`, inspect the live model first, and run a complete
reference-led request:

```sh
atet ai models show <reference-capable-model-id>
atet ai image generate \
  --model <reference-capable-model-id> \
  --prompt-file metallic-logo-prompt.txt \
  --image reference-logo.png \
  --aspect-ratio 1:1 \
  --count 1 \
  --allow-cloud-upload
```

Treat the output as a candidate until its silhouette, negative space,
proportions, and any lettering match the reference.

Author documents use the frozen `AtetOverlay` API:

- `onFrame(({ frame, timeMs, deltaMs, progress, width, height }) => …)` updates
  the document from Atet's absolute frame clock.
- `ready(promise)` holds frame zero for bounded asset or setup work, and
  `trackAnimation(controls)` lets the host seek Motion or Web Animations.
- `asset(name)` returns the private URL of a declared resource;
  `parameters`, `seed`, `random()`, and `randomFor(key)` provide immutable input
  and reproducible variation.
- `width`, `height`, `fps`, and `durationMs` expose the exact render geometry.

Keep `html` and `body` transparent and let the compositor place the result.
Remote fetches, popups, child frames, workers, object URLs, and undeclared
resources fail closed. Declare images, fonts, JSON, audio, and other local
bytes in `resources` and resolve them with `asset(name)`. Browser time, timers,
animation frames, `Date`, performance time, and entropy are virtualized so a
given input renders the same frames. Every render receipt carries a SHA-256
Merkle root over the full injected runtime, authored document, import map,
locked modules, declared resources, authoring configuration, and exact Chrome
runtime tree—not only its launcher. The same Merkle root binds the exact
Playwright Core version plus launch flags, fixed environment, context, routing,
CSP, and transparent-screenshot policy. Production accepts only a directly
launched native executable inside a supported Google Chrome app signed by
Google's `EQHXZ8M8AV` team; PATH shims, shell wrappers, other Chromium
distributions, and malformed app bundles are rejected.

Atet binds every sorted bundle path, entry kind, mode, file length and
hash, or internal symlink target. Abort-aware bounded reads copy the complete
signed app bundle into a fresh mode-0700 snapshot while source-before,
source-after, snapshot, and code-signature provenance checks bracket the copy.
The browser snapshot is never placed beneath the caller-selected module cache
or ambient `TMPDIR`. On macOS it is a unique direct child of validated physical,
root-owned, sticky `/private/tmp`; Atet binds that anchor's exact stable
metadata and watches the unique child basename. The verified app tree is then
recursively user-immutable. After private mode-0700 `HOME` and `TMPDIR`
siblings are created, Chrome launches only from that snapshot with a minimal
fixed environment. The mutable outer container is bound by exact identity and
anchor events while the app tree itself remains recursively immutable. The
parent is watched recursively, and its exact
device/inode/ctime/mode/size identity plus the full app manifest and child path
identities are rechecked after launch and through shutdown. macOS may change
only the app root's first-launch metadata; bound parent identity and root rename
events independently prove that the pathname was never swapped, while
every child ctime remains enforced. Signature checks and snapshot copying are
bounded and cancellation-aware, and the app-tree flags are released before the
private snapshot is removed afterward. A strict mode-0600 lease is held open for
the render lifetime. On startup, a bounded scavenger preserves every ambiguous,
live, open, foreign, or changing tree. It accepts either an authenticated
released cleanup or a stale, same-host, dead-owner tree, then atomically moves
the closed, identity-stable tree into a one-use quarantine pathname and proves
the moved tree closed a second time before cleanup. Normal teardown
rechecks the complete runtime manifest and every direct child, then
atomically changes its held active lease to a released marker before removing
validated children; that marker is unlinked last, so an interrupted cleanup is
recoverable even while the desktop process remains alive. These gates prevent
deletion from colliding with a new render container or a swapped peer subtree.
The signed snapshot is prepared once per render request and shared by every
frame in that sequence; callers should submit a complete loop or overlay range
rather than issuing one render request per frame.
The injected Playwright launcher remains a trusted host adapter. Authored
documents use the `AtetOverlay` API.

The prepared HTML result is the same overlay handle returned by image, SVG,
GIF, video, and emoji preparation, so it joins `edits.addOverlays` and one
recoverable `project.commitEdits` transaction. Set its range to one loop cycle
when authoring a reusable animated loop; ordinary video-overlay playback policy
can then loop, trim, hide, or freeze that immutable asset in later compositions.

The optional emoji provider reads ignored local outputs under `apps/desktop/.generated/emoji-pack/`. All non-emoji editing remains available without that pack.

### Camera motion and face following

Project camera moves provide Ken Burns-style digital push-ins, pull-outs, and pans for any enabled video layer. Coordinates are normalized against the prepared video layer after its crop and fit:

```sh
# Move from a centered 1x frame to the requested center and zoom.
atet project edit <project> camera push \
  --placement <id> --stream <id> --from 4s --to 6s \
  --center 0.68,0.42 --start-zoom 1 --end-zoom 1.8 --easing ease-in-out

# Move between two explicit center-x,center-y,zoom poses.
atet project edit <project> camera reframe \
  --placement <id> --stream <id> --from 10s --to 14s \
  --from-frame 0.5,0.5,1 --to-frame 0.67,0.45,2 --easing ease-in-out

# Author an arbitrary path; the first and last keyframes define its range.
atet project edit <project> camera path \
  --placement <id> --stream <id> \
  --keyframe 20s,0.5,0.5,1 \
  --keyframe 22s,0.68,0.4,1.5 \
  --keyframe 25s,0.42,0.52,2

atet project edit <project> camera show
atet project edit <project> camera remove <camera-move-id>
```

Zoom ranges from 1x through 10x, and each center must keep the viewport inside the prepared layer. Camera moves interpolate zoom in log space for symmetric push-ins and pull-outs. They are bound to the selected placement synchronization and prepared-layer geometry; changing either makes the move stale instead of silently retargeting it.

On macOS 15 or newer, the offline Apple Vision analyzer can detect and track multiple faces in one immutable project video stream:

```sh
atet analyze faces <project> --source <asset:video-stream> \
  --backend vision --sample-fps 8 --min-confidence 0.6 \
  --max-track-gap 500ms --max-faces 32

atet faces list <project> <face-analysis-id> \
  --at 12s --min-duration 750ms --min-confidence 0.7 --limit 20
```

`faces list` uses asset time. Face analysis is local-only, and normalized bounding boxes are the only stored visual evidence. Track IDs mean geometry continuity within that one analysis; Atet performs no face recognition or biometric identification and stores no names, embeddings, crops, or thumbnails.

Apply that evidence as an ordinary, deterministic camera move by choosing the largest currently visible face, every active face, or one or more explicit tracks:

```sh
atet project edit <project> camera follow-faces \
  --placement <id> --analysis <face-analysis-id> --from 20s --to 35s \
  --select largest

atet project edit <project> camera follow-faces \
  --placement <id> --analysis <face-analysis-id> --from 20s --to 35s \
  --select all --framing group

atet project edit <project> camera follow-faces \
  --placement <id> --analysis <face-analysis-id> --from 20s --to 35s \
  --track <face-track-id> --track <another-face-track-id> \
  --require-all-selected --gap-policy hold
```

`--select largest` reevaluates each analyzed frame after crop/fit mapping: visible box area wins, then confidence, then lexical track ID for a stable tie. `--framing tight|medium|wide|group` controls the space around visible faces. By default, multi-face framing continues with whichever selected faces remain visible. Add `--require-all-selected` with explicit `--track` values or `--select all` when one missing selected face should trigger `--gap-policy hold|fallback|fail`: briefly keep the last frame, return to the full prepared layer, or reject the edit. Use `--min-zoom` and `--max-zoom` to bound the crop, `--smoothing` for a 0–1 second response time, `--headroom` for a 0–1 top-padding ratio, and `--output-width`/`--output-height` to declare the even-pixel render dimensions used for framing. The defaults are 1920×1080, 1x–2.2x zoom, 0.75 seconds of smoothing, and 0.18 headroom.

For a normalized video-layer layout, face following records the declared output aspect ratio. Render planning rejects a different aspect ratio because it would change face framing; rerun `camera follow-faces` with the intended dimensions before switching, for example, between 16:9 and vertical output. The generated move also remains bound to the exact analysis file, analyzed media, selected tracks, placement sync, and prepared-layer geometry.

### Analysis boundaries

- Audio alignment uses bounded 8 kHz envelopes, reports ambiguity and drift, and never mutates a placement until a candidate is explicitly or safely automatically accepted.
- Face analysis runs only in the local macOS Apple Vision helper and persists normalized boxes with geometry-continuity track IDs. Face-follow application resolves that evidence into an ordinary camera path; rendering never invokes the detector.
- Project inactivity analysis requires simultaneous freeze evidence from every enabled screen stream and, by default, silence from every enabled audio stream. It projects asset detections and reference-recording interactions through each placement's current sync map, writes an immutable sidecar, and applies only global project-time cuts or speed ranges with analysis provenance.
- Music analysis writes presence regions, tempo regions and changes, beat evidence, and key regions into a sidecar referenced by the project.
- Scene analysis follows PySceneDetect's scene-boundary ergonomics as a reference while keeping an owned FFmpeg-native detector and typed evidence. Planning is local by default. Execution uploads only selected, resized derived frames, never a raw video, directly to Vercel AI Gateway through the same environment credential as other paid media commands and requires `--allow-cloud-upload`. Exact duplicate frames are collapsed per scene, and completed descriptions are reused only when the input, sampled-frame hashes, model, prompt, and sampling version all match.
- Speech analysis runs a caller-selected local whisper.cpp model and requires word timestamps. Before `fillers apply` can create a global cut, every enabled audio stream must have a current integrity-checked music analysis, and every other audible placement-stream must have complete current speech/no-speech evidence. Music regions and words are mapped through accepted placement sync into project time. Missing coverage, stale evidence, music, or speech overlap fails closed. Editorial overrides use an ordinary manual project cut.

## Development

Use Bun 1.3.14. Portable checks do not compile native capture:

```sh
bun test apps/desktop
bun x tsc --noEmit -p apps/desktop/tsconfig.json
bun x eslint apps/desktop
bun run build:desktop
bun run test:cli:compiled:macos
bun run test:html-overlay
bun run benchmark:code-concurrency
```

Native capture targets Apple Silicon macOS 15 or newer. It uses ScreenCaptureKit for every display and system audio, plus AVFoundation for independent webcam and microphone files.

```sh
bun x native doctor --manifest apps/desktop/app.zon --strict
bun run apps/desktop/capture/build.ts
bun run apps/desktop/analysis/build.ts
bun run dev:desktop
bun run build:desktop:macos
bun run package:desktop:macos
bun run verify:html-overlay:macos
```

`test:html-overlay` is portable and leaves the real-browser tests registered as
skipped. `test:html-overlay:browser:macos` runs the real Chrome frame suite,
including a declared PNG. `test:html-overlay:libraries:macos` additionally
downloads and verifies every exact Motion, p5.js, Two.js, Paper Shaders,
Three.js, and vgpu lock. The integrity-bound Chrome contract selects WebGPU's
SwiftShader fallback
adapter so identical browser receipts do not silently choose different GPUs.
`test:html-overlay:operation:macos` runs the complete Chrome → PNG frames →
FFmpeg qtrle/argb → project-ingest operation. The combined
`verify:html-overlay:macos` requires Google Chrome, FFmpeg, and FFprobe at the
paths reported by `atet doctor`.

`build:cli` emits the current-host Bun bundle used by the portable workspace
build. `build:cli:macos` emits `dist/atet`, a copied-binary-tested Apple Silicon macOS
CLI. It bundles the headless diagram renderer, the isolated VTracer worker, the
exact Sharp native addon, and libvips; the bootstrap expands native media assets
into a fresh private temporary runtime and removes them when the command exits.
The compiled smoke copies the executable away from the checkout and proves
diagram initialization/rendering plus PNG-to-SVG vectorization without
`node_modules`.

Screen recording, microphone, camera, Input Monitoring, and Accessibility are separate macOS permissions. A missing optional source becomes a typed diagnostic; strict-input mode fails before recording begins. Packaged local builds are ad hoc signed evidence until a release workflow adds Developer ID signing, notarization, and updates.

### Real capture hardware smoke

The real hardware smoke is deliberately outside portable and ordinary macOS
checks. Without the exact confirmation below it is registered as skipped and
does not build or probe the helper, inspect permissions, or create artifact
directories:

```sh
ATET_CAPTURE_HARDWARE_CONFIRM=record-local-displays-and-selected-inputs \
  bun run test:capture:hardware:macos
```

The default profile records every connected display twice, with a pause between
the two immutable segments. It leaves system audio, camera, microphone, and
typed text disabled. Enable selected inputs explicitly:

```sh
ATET_CAPTURE_HARDWARE_CONFIRM=record-local-displays-and-selected-inputs \
ATET_CAPTURE_HARDWARE_SYSTEM_AUDIO=true \
ATET_CAPTURE_HARDWARE_CAMERA=true \
ATET_CAPTURE_HARDWARE_MICROPHONE=true \
ATET_CAPTURE_HARDWARE_MIN_DISPLAYS=2 \
  bun run test:capture:hardware:macos
```

Add `ATET_CAPTURE_HARDWARE_INTERACTIONS=true` for the owned interaction
fixture. The fixture activates its nonce-titled window, performs one fixed
public → secure → public exercise against its own fields, and remains open with
neutral focus until capture stops. It can post only the built-in `a`, `s`, and
`b` canaries to its own PID at verified coordinates inside its focused window;
it accepts no arbitrary text, key, coordinate, or target from the caller. Do
not type, click, or switch applications until the command exits because doing
so can disturb focus or fixture timing. The fixture-PID event tap excludes
clicks and keys delivered to other applications from the exact evidence gate.
The profile binds the fixture's native-clock receipt to exact ordered click/key
pairs, display identity, fixture process identity, public and secure focus
transitions, and one native `focused` window transition. With the default
typed-text opt-out, the stopped bundle must contain no `typing.input` event and
no key cadence from the secure phase.

Set `ATET_CAPTURE_HARDWARE_TYPED_TEXT=true` together with the interaction
profile to verify explicit typed-text capture. That profile accepts exactly the
public `a` and `b` canaries in metadata; a native focus-identity allowlist binds
text persistence to the fixture's nonce-derived field ID, PID, window ID, and
nonce title. Text from any other input remains unpersisted, and the secure `s`
canary must remain absent. Failed typed-text evidence is deleted regardless of
the artifact retention setting. Typed-text hardware verification is
unavailable without the owned fixture.

Before capture, the smoke performs the helper's read-only strict probe. Screen
Recording, Input Monitoring, Accessibility, and window metadata must already be
authorized; each selected optional input must also be authorized and present.
An explicitly requested run fails before `start` when a prerequisite is
missing, so it cannot open a surprise permission prompt. Grant permissions by
running Atet interactively first. Strict capture also creates and disables
the listen-only input event tap before starting any media recorder, then waits
for the tap's run-loop thread to confirm that it is enabled. Metadata writes
display, focus, window, and cursor boundary snapshots only after that handshake
and before a recorder can emit its first sample. At pause or stop, the
user-visible clock freezes, every recorder drains, all metadata pollers are
cancelled and joined on one serial queue, and metadata takes a final boundary
snapshot; finalization latency therefore does not become blank footage.
Tap creation or activation failure aborts the strict segment instead of
silently losing clicks and keys. Window focus comes from the frontmost
application's actual Accessibility-focused window matched back to its
positioned Core Graphics record, not the first enumerated window owned by that
process.

The smoke writes to a unique directory below
`artifacts/atet/recordings/.hardware-smoke/`, verifies that Git ignores the
directory, drives the real start/pause/resume/stop controller, probes every
finalized media stream with FFprobe, and validates verified `capture-sync-v1`
sample-clock measurements in the manifest. Controller-lifecycle and
container-length checks are supplemental diagnostics, not substitutes for
sample timing. It also re-hashes every physical media file, streams and
re-hashes every event file through the production event parser, checks its
declared record count and time interval, and requires real cursor, display
topology, positioned-window, focus, and exact pause/resume lifecycle events.
For both active segments, opening lifecycle and environment snapshots must
precede the earliest retained sample across every selected display, system
audio, camera, and microphone stream, while a closing cursor and lifecycle
marker must follow the latest retained sample across that same complete
envelope.
Any native dropped-event diagnostic fails the run. Typed-text opt-out and any
observed secure-focus interval are checked directly against the parsed input
events.

Failed evidence is retained by default and its absolute path is printed. Set
`ATET_CAPTURE_HARDWARE_KEEP_ARTIFACTS=never` to remove every run or `always`
to keep successful runs too. Optional-input values must be exactly `true` or
`false`; the minimum-display value is bounded from 1 through 16.

## Direct

`bun run direct:atet` opens the deterministic recorder and project-evidence lab without native capture, FFmpeg, whisper.cpp, Python, or cloud calls. It exposes compact fixtures for multi-angle placement, alignment, music, scene boundaries/descriptions, speech fillers, synchronized edits, and all overlay kinds. Permission, analyzer, and project worlds are fixture evidence, not claims about live native execution. `bun run verify:atet:direct` drives every declared browser scenario and writes agent-readable evidence.
