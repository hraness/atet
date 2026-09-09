# Generate media through Vercel AI Gateway

Use this workflow when the user asks Atet to generate an image, video, spoken
audio, or transcript. The Atet process uses the caller's Vercel AI Gateway
credential. It has no Atet account, credential store, or hosted project.

## Start with the intended role

Clarify what the generated media needs to do in the final project:

- the subject or message;
- the source files that control identity, composition, or timing;
- the number of alternatives;
- the delivery aspect ratio and duration when relevant; and
- the details that must remain recognizable or unchanged.

Preserve the user’s subject, supplied copy, identity constraints and requested omissions. A literal generation request keeps its literal prompt; a creative brief can require authored scene details. Vary only the dimensions the request leaves open.

## Discover a current model

The Gateway catalog changes independently of Atet. Inspect it instead of
guessing a model ID or provider option:

```sh
atet ai models list --type image --json
atet ai models list --type video --json
atet ai models list --type speech --json
atet ai models list --type transcription --json
atet ai models show <model-id> --json
```

Choose a model whose reported capabilities match the requested input and
output. Do not assume that an image model accepts references, a video model
accepts first and last frames, or a speech model exposes a particular voice.
Use `atet help ai` for the current common flags. Put provider-specific options
in a private ignored JSON file and pass it with `--provider-options`.

## Keep credentials out of the project

Prefer a process-local environment variable:

```sh
export AI_GATEWAY_API_KEY='<value>'
```

When the workspace is linked and the user is authenticated with Vercel, prefer
`vercel env run -- <command>`. Atet reads `AI_GATEWAY_API_KEY` first and
`VERCEL_OIDC_TOKEN` second. Never place either credential on argv, in a
project file, in provider options, in a prompt, or in task output.

## Generate the requested media

Use a prompt file when the brief is long enough that shell quoting could alter
it.

```sh
atet ai image generate \
  --model <image-model-id> \
  --prompt-file image-brief.txt \
  --aspect-ratio 16:9 \
  --count 3

atet ai video generate \
  --model <video-model-id> \
  --prompt-file shot-brief.txt \
  --image product.png \
  --duration 6 \
  --aspect-ratio 16:9 \
  --allow-cloud-upload

atet ai speech generate \
  --model <speech-model-id> \
  --text-file script.txt \
  --format wav

atet ai transcribe interview.wav \
  --model <transcription-model-id> \
  --format all \
  --allow-cloud-audio-upload
```

The image and video commands also support masks, first and last frames,
multiple references, resolution, FPS, seed, generated audio, and bounded
provider options when the selected model reports those capabilities.

## Treat local upload as a separate decision

Atet never uploads local reference media or transcription audio implicitly.
Use `--allow-cloud-upload` only when the task authorizes sending each named local reference to Gateway and the model provider. Use `--allow-cloud-audio-upload` for authorized transcription audio. Reuse explicit authorization already given; ask only when the selected upload or spending scope is missing.

A public HTTPS reference may still be sensitive because its URL is visible in
shell and process history. Do not use signed, private, local-network, or
credential-bearing URLs.

## Inspect and import the selected output

Outputs and immutable receipts are written below
`artifacts/atet/generated/`. Atet decodes self-describing media before it
suggests a project import command. Inspect each candidate at its intended size
or duration. For a reference-led request, verify silhouette, lettering,
proportions, color, and other identity-bearing details before selecting it.

When a generated artifact belongs in an existing video project, use the exact
`atet project add ...` command returned by Atet rather than reconstructing its
path or role. Generated images and video normally enter as b-roll; generated
speech normally enters as dialogue.

Never automatically retry an interrupted or failed paid generation. Atet uses
zero client retries because an ambiguous request may still have been charged.
Report the failure receipt and reconcile the exact attempt. A deliberate new paid command needs authority within the user’s budget; do not infer that an ambiguous failure was free.

## Finish the task

Report:

- the selected model and the capability that justified it;
- which local files, if any, were explicitly uploaded;
- each useful generated output and receipt path;
- the project import command or imported placement when applicable; and
- what you inspected before accepting the result.

## Directing and the portable image command

Use [directing video](directing-video.md) for budgeted takes, accepted predecessor frames and local recovery. URL-only models can use its explicit private Blob path; do not paste short-lived signed URLs into CLI arguments or project files. Blob charges and authority are separate from Gateway.

The small portable `atet image generate '<prompt>' --output image.webp` command defaults to `recraft/recraft-v4.1-utility` and admits PNG/JPEG/WebP output. It is distinct from the local `ai` catalog workflow. Preserve literal prompts when requested, keep its output inside the intended workspace and never automatically retry a failed paid call.

## Style recipes

For the rubber-stamp travel field-note layout (photograph left, small hand-stamped
vignette and typewriter notes on paper right), do not ask Gateway to redraw the
whole poster. Follow [rubber-stamp-field-notes.md](rubber-stamp-field-notes.md):
generate only the stamp with a reference-capable model, then assemble with the
local compositor.
