const GLOBAL_HELP = `transmute — agent-first local screen recorder and non-destructive editor

Usage: transmute <command> [options]

Commands:
  operations list|show           Discover host-owned typed operations and policies
  diagram init|check|render      Create, validate, or render portable diagram sources
  image vectorize|generate      Create a local SVG or generated image file
  html scaffold                  Create a transparent HTML overlay starter
  workflows list|show|plan|run   Plan or run a reviewed reusable workflow
  code init|check|plan|run       Author, preflight, and run trusted TypeScript workflows
  runs list|show|resume|approve|cancel
                                 Inspect and control durable workflow runs
  doctor                         Check local capture, render, and asset capabilities
  ai models|image|video|speech|transcribe
                                 Discover and run Vercel AI Gateway media models
  media audio|caption|color|compose
                                 Apply effects, caption, or compose local media
  record start|pause|resume|stop|status
                                 Control the repository-local capture session
  recordings list               List recording bundles
  projects list|create           List projects or create one from a recording
  project inspect|add|edit|render
                                 Manage synchronized project media, global edits, and output
  align analyze|apply            Align independent project clips from their audio
  fillers list|apply             Inspect or safely apply synchronized filler-word cuts
  faces list                     Inspect bounded local face-geometry tracks
  inspect <recording>            Summarize tracks, segments, events, and edits
  events <recording>             Query bounded metadata events
  edit <recording> <operation>   Build a non-destructive edit plan
  analyze faces|inactivity|music|scenes|speech
                                 Analyze inactivity or structured project media
  render plan|run <recording>    Resolve or execute a render plan
  assets emoji search|resolve    Find checked local emoji overlays

Run transmute help <command> for command-specific help.`;

const HELP: Readonly<Record<string, string>> = {
  diagram: `Usage:
  transmute diagram init [diagram.json]
  transmute diagram check <diagram.json> [--config <file>] [--strict]
  transmute diagram render <diagram.json> [--out-dir <directory>]
        [--config <file>] [--scale <number>]

These commands delegate to the canonical @hraness/transmute parser. Init never overwrites.
Check parses and lints without writing; --strict exits 2 on findings. Render replaces the same five
portable derivatives: editable .tldr plus light/dark SVG and PNG. The registered Transmute diagram
operations separately publish equivalent derivatives by content hash for workflow composition.`,
  image: `Usage:
  transmute image vectorize <raster-path> --output <file.svg> [--json]
        [--duotone '<#primary,#secondary>'] [--alpha-cutoff <n>] [--timeout-ms <n>]
  transmute image generate <prompt> --output <file.webp> [--model <model>]
        [--idempotency-key <key>] [--json]
  transmute image generate --model <gateway-model> --prompt <prompt>

Explicit --output file commands delegate to @hraness/transmute. Vectorization is local,
bounded, checksum-pinned, and emits inert SVG. File generation uses Vercel AI Gateway with the
caller's environment credential. The --prompt spelling without --output is an alias for the desktop
content-addressed \`ai image generate\` lane and returns project-composable content hash references.`,
  html: `Usage:
  transmute html scaffold <plain|motion|paper-shaders|three> --output <file.html>

Creates a complete transparent HTML overlay without overwriting an existing file. Scaffolds use
the existing @hraness/transmute/local/html-overlay API and exact locked import maps. Render the document
through workflow.media.htmlOverlay to receive a deterministic transparent video layer.`,
  operations: `Usage:
  transmute operations list [--json]
  transmute operations show <kind>[@<version>] [--json]

Operation discovery is generated from the closed host registry. Workflow code may request these
operations but cannot override their schemas, privacy policy, resources, consent, or retry class.
List output is compact; show --json expands only the selected operation's input and output JSON
Schemas.`,
  workflows: `Usage:
  transmute workflows list [--json]
  transmute workflows show <id> [--json]
  transmute workflows plan <id> --input <json-file> [--json]
  transmute workflows run <id> --input <json-file> [--provider-options <json-file>]
        [--jobs <n>] [--json|--jsonl]

Built-ins are explicit versioned TypeScript graph recipes over the same operation registry as
custom code. Planning resolves structural project identity and policy bounds without executing
registered effects. Workflow execution may still evaluate trusted repository code; it is not a
sandbox. List output is compact; show --json expands only the selected workflow's input JSON
Schema.

Provider options are invocation-scoped. The raw JSON is never stored in a run or journal; only its
digest and sorted provider namespaces enter the exact plan. A resume must supply the same file
before a matching paid Gateway request can dispatch.`,
  code: `Usage:
  transmute code init <path>
  transmute code check <path> [--json]
  transmute code plan <path> --input <json-file> [--json]
  transmute code run <path> --input <json-file> [--plan <sha256>]
        [--provider-options <json-file>] [--jobs <n>] [--json|--jsonl]

Code mode bundles one repository-local TypeScript module and its physical local imports, builds a
strict typed operation graph in a separate process, and keeps stdout/stderr separate from framed
protocol data. --plan fails if source, input, structural bindings, registry, or runtime changed.
Raw provider options are ephemeral: only their digest and namespace list may enter an exact plan.

Trusted code mode is not a sandbox. Module top-level and later acknowledged compute callbacks run
with the current user's filesystem, process, and network authority. Transmute injects no
credentials or privileged handles into the worker.`,
  runs: `Usage:
  transmute runs list [--limit <n>] [--json]
  transmute runs show <run-id> [--nodes failed|all] [--json]
  transmute runs resume <run-id> [--replay-ambiguous-code <node-key> ...]
        [--provider-options <json-file>] [--jobs <n>] [--json|--jsonl]
  transmute runs approve <run-id> <node-key> --preparation-plan <sha256> [--json]
  transmute runs approve <run-id> <node-key> --node-plan <sha256> [--json]
  transmute runs cancel <run-id> [--json]

Approvals bind one exact preparation or node plan. Approve records authority and releases the
claim; only a later resume executes work. A normal resume never evaluates persisted trusted code.
Each --replay-ambiguous-code option authorizes the exact bundle, compute callback, node plan, and
next attempt named by that node. Cancellation is durable and prevents new dispatch or publication
without rolling back already published outcomes. Paid Gateway nodes that reference provider
options require the digest-matching file again on resume; raw values are never recovered from the
run journal.`,
  ai: `Usage:
  transmute ai provider-options inspect <json-file> [--json]
  transmute ai models list [--type <all|image|video|speech|transcription>]
        [--provider <name>] [--query <text>] [--limit <n>] [--refresh] [--json]
  transmute ai models show <model-id> [--refresh] [--json]
  transmute ai image generate --model <id> (--prompt <text> | --prompt-file <path>)
        [--image <path-or-https-url> ...] [--mask <path-or-https-url>]
        [--count <n>] [--max-per-call <n>]
        [--size <width>x<height>] [--aspect-ratio <width>:<height>] [--seed <n>]
        [--max-output-tokens <n>] [--temperature <n>] [--stop <text> ...]
        [--provider-options <json-file>] [--timeout <time>]
        [--allow-cloud-upload] [--json]
  transmute ai video generate --model <id> [--prompt <text> | --prompt-file <path>]
        [--image <path-or-https-url>] [--frame first=<path-or-https-url>]
        [--frame last=<path-or-https-url>]
        [--reference <media-path-or-https-url> ...] [--count <n>] [--max-per-call <n>]
        [--aspect-ratio <width>:<height>] [--resolution <width>x<height>|<quality>]
        [--duration <seconds>] [--fps <n>] [--seed <n>] [--generate-audio <bool>]
        [--provider-options <json-file>] [--timeout <time>]
        [--allow-cloud-upload] [--json]
  transmute ai speech generate --model <id> (--text <text> | --text-file <path>)
        [--voice <id>] [--format <format>] [--instructions <text> | --instructions-file <path>]
        [--speed <0.25..4>] [--language <tag>] [--provider-options <json-file>]
        [--timeout <time>] [--json]
  transmute ai transcribe <audio-path> --model <id> --allow-cloud-audio-upload
        [--format <all|json|text|srt|vtt>] [--provider-options <json-file>]
        [--timeout <time>] [--json]

Set AI_GATEWAY_API_KEY in the process environment, or run through a linked Vercel project with
\`vercel env run -- transmute …\` so VERCEL_OIDC_TOKEN is injected. Transmute never persists,
prints, or accepts either credential through argv.

The media-model catalog is fetched live from Vercel AI Gateway and cached with a deterministic
revision. Every image, video, speech, and batch-transcription model of the matching operation is
executable; streaming-only transcription models remain discoverable and are labeled as such.
models are not limited by a checked adapter roster. models show preserves the live provider
capabilities and exposes model-aware parameter hints.

Provider-specific options are read from one bounded JSON object. Its outer keys are provider
names and its values are arbitrary bounded JSON objects, so newly released model controls remain
available without a CLI update. gateway.models is rejected because fallback models have not been
independently catalog-validated or accounted. Provider-specific sample-count fields are rejected;
use --count with --max-per-call at least as large so one job remains one AI SDK call. Options may contain BYOK credentials, webhook
secrets, or similar sensitive values: keep the source JSON ignored and owner-protected. Transmute
persists only its digest and namespace list, never its raw values. Common video controls are
first-class flags, including primary image, first/last frames, image/audio/video references, count,
aspect ratio, resolution, duration, FPS, seed, and generated audio. Frame inputs and generic
references are mutually exclusive because the AI SDK otherwise ignores the references; a primary
image cannot accompany a first frame.

provider-options inspect emits exactly the secret-free {sha256,namespaces} reference that workflow
nodes store in their exact request; it never prints or persists the raw option values.

Reference media and transcription audio never upload implicitly. The appropriate explicit
--allow-cloud-* acknowledgement is required after local files pass type and byte bounds. Image
and video references may instead use a public credential-free HTTPS URL when the live catalog
permits URL input or does not declare a source restriction; an explicit non-URL source list fails
locally. Add a <media-type>= prefix when the URL path has no recognized extension. Private/local
literal targets are rejected, and receipts retain only the URL digest and media type, never the
URL. Direct URL arguments remain visible to shell and process history, so use only references safe
for that exposure. The AI SDK client uses
maxRetries=0, and Transmute never resubmits an ambiguous paid call. AI Gateway can still route or
fail over one request across multiple providers, so one command may have multiple provider
attempts; provider timeouts may still incur charges. Outputs and immutable receipts are written
under gitignored artifacts/transmute/generated/. Receipts report complete, partial, or overproduced
sample fulfillment. Self-describing generated media is fully decoded locally before an import
command is emitted; invalid paid bytes remain quarantined with no import command. Headerless PCM, L16, A-law, basic, and mu-law speech
is saved and hashed but receives no project-add command; convert it with explicit sample metadata
first.`,
  analyze: `Usage:
  transmute analyze faces <project> --source <asset:video-stream> [options] [--json]
  transmute analyze inactivity <recording|project> [options]
  transmute analyze zooms <recording> [--apply] [--json]
  transmute analyze music <project> --source <asset:audio-stream> [--window <time>] [--json]
  transmute analyze scenes <project> --source <asset:video-stream> [options]
  transmute analyze speech <project> --source <asset:audio-stream> --model <whisper-model> [options]

Scene options: --max-scene-duration <time> --scene-threshold <0..1>
               --model <google/gemini-*> --execute --allow-cloud-upload --json
Scene analysis is local planning by default. Execution uploads only selected derived frames and requires explicit acknowledgement.

Face options: --backend <auto|vision> --sample-fps <n>
              --min-confidence <0..1> --max-track-gap <time> --max-faces <n> --json
Face detection runs locally against immutable project media. Track IDs are geometry continuity only; no recognition, embeddings, names, crops, or cloud upload are produced.

Inactivity options: --min-duration <time> --motion-threshold <0..1>
                    --protect-audio <bool> --handle <cut|speed|keep>
                    --speed-rate <1..64> --apply --json
Projects analyze every enabled screen stream, optionally require silence on every enabled audio stream, and map reference-recording interactions through accepted placement sync. Project evidence is always persisted; --apply adds one global cut or speed decision per recommended range.

Speech options: --whisper <path> --language <auto|tag> --threads <n> --processors <n>
                --no-gpu --min-filler-confidence <0..1> --speech-handle <time>
                --protect-music <bool> --json
The whisper executable may come from TRANSMUTE_WHISPER_CPP and the model from TRANSMUTE_WHISPER_MODEL.`,
  align: `Usage:
  transmute align analyze <project> --reference <asset:stream> --target <asset:stream>
        [--reference-placement <id>] [--target-placement <id>] [--max-offset <time>]
        [--apply] [--candidate <id>] [--json]
  transmute align apply <project> <analysis-id> --candidate <id>
        [--reference-placement <id>] [--target-placement <id>] [--json]

Analysis writes immutable evidence. Automatic application requires an unambiguous high-confidence candidate; an explicit candidate may be applied after inspection.`,
  assets: `Usage: transmute assets emoji <search|resolve> <glyph|name|hex-id|brand-domain> [options]

Options: --provider <all|auto|apple-emoji-pack|brand-catalog>
         --variant <color|duotone> --limit <n> --json

Brand-catalog overlays use checked duotone SVG assets.`,
  doctor: `Usage: transmute doctor [--json]`,
  edit: `Usage: transmute edit <recording> <operation> [options]

Operations:
  init | show
  trim <from> <to>
  cut <from> <to>
  speed <from> <to> <rate>
  zoom [add] --from <time> --to <time> --target <rect|point|cursor|window|focused-input>
       [--rect <x,y,width,height> | --point <x,y> | --window <id-or-title>]
       [--display <id>] [--scale <number>] [--enter-duration <time>]
       [--exit-duration <time>] [--easing <linear|ease-in|ease-out|ease-in-out|spring>]
  zoom remove <id>
  overlay add --kind <image|svg|gif|video|emoji> --source <value> --from <time> --to <time>
              [--position <x,y>] [--anchor <top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right>]
              [--width <px>] [--height <px>] [--scale <number>] [--rotation <degrees>]
              [--opacity <0..1>] [--z-index <integer>]
              [--entrance <none|fade|scale|slide-up|slide-down|slide-left|slide-right>]
              [--entrance-duration <time>] [--exit <none|fade|scale|slide-up|slide-down|slide-left|slide-right>]
              [--exit-duration <time>] [--easing <linear|ease-in|ease-out|ease-in-out|spring>]
              [--source-in <time>] [--source-out <time>] [--playback-rate <number>]
              [--loop <bool>] [--freeze-end <bool>] [--animated-audio <mute|mix|duck>]
              [--audio-volume <0..4>] [--duck-primary-to <0..1>]
              [--fit <contain|cover|fill>] [--crop <left,top,right,bottom>]
              [--blend-mode <normal|addition|darken|lighten|multiply|overlay|screen>]
              [--corner-radius <px>] [--slide-distance <px>]
              [--entrance-from-scale <number>] [--exit-to-scale <number>]
              [--keyframe <offset,x,y,scale,rotation,opacity>] (repeatable)
              [--provider <auto|apple-emoji-pack|brand-catalog>] [--variant <color|duotone>]
  overlay remove <id>
  cursor <on|off>
  clicks <on|off>
  keystrokes <on|off>
  typed-text <on|off>

All mutations support --json and return the resulting plan hash.`,
  events: `Usage: transmute events <recording> --kind <kind> [options]

Options: --kind <kind[,kind]> (repeatable) --from <time> --to <time>
         --around <time> --limit <1..10000> --json | --jsonl`,
  inspect: `Usage: transmute inspect <recording> [--fields <csv>] [--json]`,
  media: `Usage:
  transmute media audio <media-path> [effects] [--audio-stream <index>]
        [--output <relative-path>] [--json]
  transmute media caption <video-path> [--model <whisper-model-path>]
        [--language <auto|tag>] [--sample-fps <0.25..8>]
        [--vad-model <silero-model-path>] [--whisper-vad <helper-path>]
        [--encoder <h264|h264-videotoolbox>] [--output <relative-path.mp4>] [--json]
  transmute media color <video-path> [grade] [--video-stream <index>]
        [--output <relative-path>] [--json]
  transmute media compose <composition.json>
        [--output <relative-path.mp4>] [--json]

Audio effects may be combined in one deterministic chain:
  --volume-db <-60..24>
  --compressor [--compressor-threshold-db <-60..0>] [--compressor-ratio <1..20>]
               [--compressor-attack-ms <0.1..2000>] [--compressor-release-ms <1..9000>]
               [--compressor-makeup-db <0..36>]
  --delay-ms <1..10000> [--delay-mix <0..1>] [--delay-feedback <0..0.95>]
  --reverb <room|hall|plate> [--reverb-wet <0..1>]
  --denoise [--denoise-reduction-db <0.01..97>]

Color grading supports --preset <clean|warm|cool|cinematic|vivid|flat|mono> plus independently
bounded --brightness, --contrast, --saturation, --gamma, --temperature, --tint, and
--hue-degrees controls.

Composition reads a checked version-one JSON manifest whose paths are relative to the manifest.
It trims two through thirty-two ordered segments, normalizes portrait or landscape geometry and
audio, applies bounded fade/acrossfade transitions, and supports eased speed ranges with automatic
upper-right rate labels. H.264 software encoding is portable;
the explicit h264-videotoolbox profile provides a faster macOS delivery path.

Captioning runs local whisper.cpp word transcription and the offline Apple Vision face analyzer,
then burns two-line captions into face-avoiding positions above the bottom 32% reserved for social
platform metadata. Auto language is redetected in short speech windows. If the private Silero model
at artifacts/transmute/private/models/ggml-silero-v5.1.2.bin is present, local voice activity
detection skips wind and silent spans; --vad-model and TRANSMUTE_WHISPER_VAD_MODEL override it.
The speech model uses --model, TRANSMUTE_WHISPER_MODEL, or the private ggml-small.bin default.
No audio or frames leave the machine.

Transforms call the checked local FFmpeg executable with an argv array, never a shell. They never
overwrite the source. Each output uses fresh no-replace publication, then post-render verification
and a receipt under gitignored artifacts/transmute/generated/. A crash after output publication but
before receipt publication can leave an orphan; the next run reports a conflict for explicit
inspection and removal. JSON output includes SHA-256 provenance and an exact project-add next
command.`,
  fillers: `Usage:
  transmute fillers list <project> <speech-analysis-id> [--auto-only] [--json]
  transmute fillers apply <project> <speech-analysis-id> <candidate-id> [--placement <id>] [--json]

Apply accepts only candidates with safe acoustic boundaries and current placement synchronization. Every enabled audio stream must have a current music analysis; all detected music is projected into project time and missing coverage or overlap fails closed. Manual project cuts remain available for editorial overrides.`,
  faces: `Usage:
  transmute faces list <project> <face-analysis-id> [--at <asset-time>]
        [--min-duration <time>] [--min-confidence <0..1>] [--limit <1..1000>] [--json]

Face track IDs describe local geometry continuity inside one immutable analysis. They do not identify a person.`,
  record: `Usage:
  transmute record start [--display <id> ...]
        [--camera-device <id>] [--microphone-device <id>]
        [--webcam <true|false>] [--microphone <true|false>]
        [--system-audio <true|false>] [--typed-text <true|false>]
        [--strict-inputs] [--json]
  transmute record pause|resume|stop|status [--json]

Capture defaults to every current display, system audio, the default microphone,
and the default camera. Repeat --display to record an exact non-empty subset.
Device IDs select the exact camera or microphone reported by transmute doctor;
unknown or duplicate IDs fail closed. Typed-text capture remains opt-in with
--typed-text true.`,
  recordings: `Usage: transmute recordings list [--limit <n>] [--json]`,
  projects: `Usage:
  transmute projects list [--limit <n>] [--json]
  transmute projects create --from-recording <recording> [--name <name>] [--json]`,
  project: `Usage:
  transmute project inspect <project> [--json]
  transmute project add <project> <media-path> --role <screen|camera|b-roll|system-audio|microphone|portable-audio|music|dialogue|other> [--at <project-time>] [--json]
  transmute project edit <project> cut <from> <to> [--json]
  transmute project edit <project> trim <from> <to> [--json]
  transmute project edit <project> speed <from> <to> <rate> [--json]
  transmute project edit <project> camera push --placement <id> --stream <id>
        --from <time> --to <time> --center <x,y> --end-zoom <z>
        [--start-zoom <z>] [--easing <name>] [--json]
  transmute project edit <project> camera reframe --placement <id> --stream <id>
        --from <time> --to <time> --from-frame <x,y,z> --to-frame <x,y,z>
        [--easing <name>] [--json]
  transmute project edit <project> camera path --placement <id> --stream <id>
        --keyframe <time,x,y,zoom> --keyframe <time,x,y,zoom> [...]
        [--easing <name>] [--json]
  transmute project edit <project> camera follow-faces --placement <id> --analysis <id>
        --from <time> --to <time> (--track <id> ... | --select <largest|all>)
        [--framing <tight|medium|wide|group>] [--gap-policy <hold|fallback|fail>]
        [--require-all-selected]
        [--min-zoom <n>] [--max-zoom <n>] [--smoothing <seconds>] [--headroom <ratio>]
        [--output-width <even-px>] [--output-height <even-px>] [--json]
  transmute project edit <project> camera show|remove [camera-move-id] [--json]
  transmute project edit <project> zoom [add] --from <time> --to <time> --target <rect|point|cursor|window|focused-input>
        [zoom-options] [--source-placement <recording-backed-placement>] [--json]
  transmute project edit <project> zoom remove <id> [--json]
  transmute project edit <project> cursor|clicks|keystrokes|typed-text <on|off>
        [effect-options] [--source-placement <recording-backed-placement>] [--json]
  transmute project edit <project> overlay add --kind <image|svg|gif|video|emoji> --source <value> --from <time> --to <time> [overlay-options]
  transmute project edit <project> overlay remove <id> [--json]
  transmute project render <plan|run> <project> [--width <px>] [--height <px>] [--fps <n>]
                       [--output <renders/path.mp4>] [--dry-run] [--allow-unverified-sync] [--json]

Imported media starts unverified. Align its audio before relying on synchronization. Structural edits are project-time operations and affect every placement. Camera moves address any placed video stream; metadata-driven screen zooms still require a recording-backed source placement. Face analysis and geometry tracks remain local. --select largest follows the largest currently visible prepared-layer face per frame. --require-all-selected makes a missing explicit/all-selected face invoke the chosen gap policy.`,
  render: `Usage: transmute render <plan|run> <recording> [--display <id|primary>] [--output <path>] [--dry-run] [--keep-inactivity] [--json]

Long inactivity is analyzed and removed by default; use --keep-inactivity to opt out.`,
};

export function commandHelp(topic: readonly string[]): string {
  if (topic.length === 0) return GLOBAL_HELP;
  return HELP[topic[0]!] ?? GLOBAL_HELP;
}

export function completions(words: readonly string[]): readonly string[] {
  const topLevel = [
    "operations", "diagram", "image", "workflows", "code", "runs", "doctor", "ai", "media", "record", "recordings", "projects", "project", "inspect", "events", "edit", "analyze", "align", "faces", "fillers", "render", "assets",
  ];
  if (words.length <= 1) return topLevel;
  const command = words[0];
  if (command === "operations") return ["list", "show"];
  if (command === "diagram") return ["check", "render"];
  if (command === "image") return ["vectorize"];
  if (command === "workflows") return ["list", "show", "plan", "run"];
  if (command === "code") return ["init", "check", "plan", "run"];
  if (command === "runs") return ["list", "show", "resume", "approve", "cancel"];
  if (command === "record") return ["start", "pause", "resume", "stop", "status"];
  if (command === "recordings") return ["list"];
  if (command === "projects") return ["list", "create"];
  if (command === "project") return ["inspect", "add", "edit", "render"];
  if (command === "edit") return ["init", "show", "trim", "cut", "speed", "zoom", "overlay", "cursor", "clicks", "keystrokes", "typed-text"];
  if (command === "analyze") return ["faces", "inactivity", "zooms", "music", "scenes", "speech"];
  if (command === "faces") return ["list"];
  if (command === "align") return ["analyze", "apply"];
  if (command === "fillers") return ["list", "apply"];
  if (command === "ai") return ["models", "provider-options", "image", "video", "speech", "transcribe"];
  if (command === "media") return ["audio", "caption", "color", "compose"];
  if (command === "render") return ["plan", "run"];
  if (command === "assets") return ["emoji"];
  return [];
}
