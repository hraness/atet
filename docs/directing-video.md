# Direct short generated clips

Use the [Slopcamera source installation](how-to/use-current-source.md) for the `direct` commands. For one generated artifact, use [Gateway media generation](how-to/generate-media.md).

Use `slopcamera direct` to turn a shot recipe into reviewed video takes and an editable media project. Each shot names its prompt, model, duration, and output settings. A later shot can use the accepted predecessor's final decoded frame as its opening image. Slopcamera retains the requests, media, review decisions, dependency identities, and estimated spending across revisions.

The workflow combines authored scene frames with ordinary Vercel AI Gateway video generation. Its continuity comes from images and explicit prompts. A single endpoint image doesn't preserve a model's neural checkpoint, motion history, hidden surfaces, or complete world state. Inspect joins for changes in motion, geometry, lighting, and identity before accepting a continuation.

## Prepare a recipe

Check `slopcamera direct --help` and `slopcamera doctor` first. Generation needs a Vercel AI Gateway credential; endpoint extraction and assembly need local FFmpeg and FFprobe. [Gateway configuration](vercel.md) describes the credential boundary.

Discover available video models and create a starter:

```sh
slopcamera ai models list --type video --json
slopcamera direct init film.recipe.json --json
```

Edit the starter to describe the shots you want. This example uses two 5-second shots, with the second opening on the first shot's accepted endpoint:

```json
{
  "kind": "slopcamera.directing-recipe",
  "schemaVersion": 1,
  "id": "direct_atrium",
  "title": "Atrium study",
  "shots": [
    {
      "id": "opening",
      "prompt": "A silver sculpture stands on a stone pedestal in a sunlit atrium. A slow camera push approaches the sculpture. Keep the object rigid and the lighting steady.",
      "model": "minimax/minimax-h3-max",
      "durationSeconds": 5,
      "resolution": "480p",
      "aspectRatio": "16:9",
      "fps": 24
    },
    {
      "id": "orbit",
      "prompt": "Continue from the supplied opening image. The camera moves slowly clockwise around the same silver sculpture and stone pedestal. Preserve their proportions and the atrium's daylight.",
      "model": "minimax/minimax-h3-max",
      "durationSeconds": 5,
      "resolution": "480p",
      "aspectRatio": "16:9",
      "fps": 24,
      "firstFrame": {
        "kind": "shot-end",
        "shotId": "opening"
      }
    }
  ]
}
```

Model availability and settings are live capabilities. Run `plan` after editing the recipe; it checks every shot against the current [Gateway model catalog](https://ai-gateway.vercel.sh/v1/models) and returns per-shot estimates, image transport requirements, and a first-pass total without generating media:

```sh
slopcamera direct plan film.recipe.json --json
```

Recipes contain one to 64 ordered shots with unique IDs. A `shot-end` reference must name an earlier shot. Each shot requires a nonempty prompt, model, integer duration from 1 to 60 seconds, resolution, and aspect ratio; optional controls are `fps`, `seed`, `firstFrame`, and `lastFrame`. The model must explicitly support the chosen operation and settings. A `lastFrame` requires a `firstFrame` and a model that supports first-and-last-frame conditioning. Recipes don't accept raw provider options, multiple samples per take, video references, or an audio-generation setting. One directing ID retains up to 128 recipe versions and 1024 attempts within a 32 MiB state bound.

The directing preflight currently admits batch video models with unambiguous per-second catalog pricing for the selected resolution. Models with unavailable capabilities, provider-dependent prices, or additional pricing conditions need a separately reviewed ordinary Gateway workflow.

## Use an authored scene as a reference

Render a calibrated frame with the [scene workflow](spatial-scenes.md). For example, after creating a scene and a frame request:

```sh
slopcamera scene render product.scene.json --request frame.json --json
```

Import the exact PNG path returned by the renderer. Replace `path/to/rendered-frame.png` below with that returned path:

```sh
slopcamera direct anchor --input path/to/rendered-frame.png --json
```

The command copies only the named image into retained local storage and returns its path, byte count, SHA-256, media type, and dimensions. Set a shot's `firstFrame` to an object with `kind: "image"` and `source` equal to that complete returned reference. Set `lastFrame` to another returned reference when you want to constrain the shot's ending composition. Preserve the returned fields; don't invent or hand-edit hashes.

Importing an anchor is local and doesn't upload it. Supported anchors are single unrotated PNG, JPEG, or WebP images, at most 30 MiB and 4096 pixels per side. A later generation call must separately acknowledge uploading its exact retained image references. Rendering with a hardware scene profile accelerates local scene rasterization; the video model still runs through Gateway.

## Configure private references for URL-only models

Check each shot's `inputTransport` in the plan. `none` means the shot has no image references. `inline` sends the exact retained image bytes with the Gateway request. `url` requires temporary hosting because the model accepts image URLs. H3 Max currently uses the URL path for image conditioning; the text-only opening shot above needs no Blob store.

For a `url` shot, make credentials for an existing private Vercel Blob store available to the CLI process. Slopcamera prefers `VERCEL_OIDC_TOKEN` together with `BLOB_STORE_ID`; otherwise it uses `BLOB_READ_WRITE_TOKEN`. If you also set `BLOB_STORE_ID` with a read-write token, both must identify the same store. Gateway authentication remains separate: it reads `AI_GATEWAY_API_KEY` before `VERCEL_OIDC_TOKEN`. A Gateway API key alone doesn't authorize Blob access. Use the [Vercel configuration guide](vercel.md) and [Blob authentication documentation](https://vercel.com/docs/vercel-blob/using-blob-sdk#authentication) for the environment setup. Slopcamera doesn't provision a store or refresh credentials through the Vercel CLI.

Authorize each generation with both `--allow-cloud-upload` and `--allow-reference-hosting`. The latter permits private copies of only that take's exact first and last images, at most two images of 30 MiB each. Slopcamera verifies the copied bytes and private access before giving Gateway a signed GET URL. Each URL expires 15 minutes after it is issued and stays in memory; credentials and signed URLs are absent from retained receipts. This workflow doesn't publish public image URLs. Signed GET access covers that object and operation only, so it doesn't imply compatibility with every provider's downloader. [Vercel signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls) describes this access scope.

Allow for Blob storage, operations, and transfer charges separately from the model budget. Expiry ends access through that URL; it doesn't delete the stored object. Generation attempts cleanup after a completed call or a call proven not dispatched. Use the retained cleanup receipt to confirm deletion, as described below.

## Generate and review each take

Start once with the total USD amount authorized for this directing ID. Replace `5.00` below with that amount; it is an example budget, not a model price:

```sh
slopcamera direct start film.recipe.json --budget-usd 5.00 --json
```

Starting retains the recipe and budget without generating video. Reusing the ID cannot reset its spending. Budgets accept positive USD values with at most six decimal places and are stored as integer microdollars.

Generate the opening take after making the credential available to this process. Slopcamera reads `AI_GATEWAY_API_KEY` before `VERCEL_OIDC_TOKEN`; a linked Vercel workspace can use `vercel env run -- bun "$SLOPCAMERA_SOURCE_ROOT/apps/desktop/dist/cli/main.js" direct generate <arguments>`. [Source installation](how-to/use-current-source.md) defines that root. The shell function cannot be launched by Vercel, and credential injection applies only to this child invocation. Keep credentials out of recipes, prompts, command arguments, and retained output.

```sh
slopcamera direct generate direct_atrium --shot opening --attempt take_opening_v1 \
  --allow-paid-generation --json
```

Each new `take_<id>` permits at most one new Gateway dispatch. The command rechecks the live catalog, retains its reservation before dispatch, and saves the resulting video and Gateway receipt before extracting the endpoint. A shot with a local anchor also needs `--allow-cloud-upload` on this invocation, plus `--allow-reference-hosting` when its plan requires `url` transport.

Inspect the returned video and final frame before accepting the take. Look for the requested subject, useful camera movement, stable geometry, and an ending composition suitable for the next shot. Record that review explicitly:

```sh
slopcamera direct inspect direct_atrium --json
slopcamera direct review direct_atrium --attempt take_opening_v1 \
  --decision accepted --note "The sculpture stays rigid and the endpoint supports the orbit." --json
```

Generate the continuation only after its predecessor is currently accepted. H3 Max needs private URL access to the predecessor's endpoint, so configure the private store first and acknowledge both the upload and hosting on this call:

```sh
slopcamera direct generate direct_atrium --shot orbit --attempt take_orbit_v1 \
  --allow-paid-generation --allow-cloud-upload --allow-reference-hosting --json
```

Inspect the join against the preceding video, then accept or reject the take:

```sh
slopcamera direct review direct_atrium --attempt take_orbit_v1 \
  --decision accepted --note "The join preserves the sculpture and the camera motion is usable." --json
```

To reject a take, use `--decision rejected` with a review note. Rejection retains the media and its spending reservation. A deliberate new generation requires a new attempt ID, such as `take_orbit_v2`, and another `--allow-paid-generation` invocation. Slopcamera doesn't retry rejected outputs automatically.

## Revise or recover work

Save edited shot instructions in a recipe file with the same directing ID, then activate that revision:

```sh
slopcamera direct revise direct_atrium --recipe revised.recipe.json --json
slopcamera direct inspect direct_atrium --json
```

Changing a shot invalidates its selected take and affected descendants. Choosing a different predecessor take also invalidates continuations bound to the previous one, even if the prompt is unchanged. Independent shots keep valid acceptance. Old recipes, takes, media, and review decisions remain retained; `inspect` distinguishes accepted, stale, and unselected shots. Assembly requires current acceptance for every shot.

After an interruption, reconcile the exact retained attempt:

```sh
slopcamera direct resume direct_atrium --attempt take_orbit_v1 --json
```

`resume` reads authoritative local Gateway receipts and can finish missing endpoint extraction. It never starts another provider request or resumes a provider's neural session. A completed video remains retained if endpoint extraction fails, and endpoint recovery is local. Repeating `generate` with an existing matching attempt ID also reconciles that attempt instead of dispatching another request.

A `reserved` or `ambiguous` attempt can still represent a charged call. A new reservation can be released when the generation invocation proves `not-dispatched`. After a restart, a missing local journal cannot release either a reserved or ambiguous take; `resume` keeps that reservation held. Recovery can still attach a completed local receipt. Use a new take ID only after deliberately accepting the possibility that the previous call also incurred a charge.

The retained USD values are catalog estimates, not settled provider invoices or a provider-enforced spending cap. Completed, rejected, and ambiguous calls keep their estimates against the budget. Slopcamera disables client retries, but Gateway can make multiple provider attempts within one request. Check provider billing when an exact settled total matters.

## Confirm or recover reference cleanup

Inspect `referenceHosting` in the generation result or error details. `cleanupRequired: true` means an object remains unresolved or its receipt couldn't be read; use the included `receiptPath` and `cleanupCommand`. When available, `referenceHosting.receipt` records each entry's `cleanup` as `pending`, `deleted`, or `uncertain`; only `deleted` confirms cleanup. Slopcamera retains upload intent before sending bytes, the exact store and object path, source identity, access expiry, and cleanup evidence in:

```text
artifacts/slopcamera/private/directing-blob/<direct-id>/<take-id>/receipt.json
```

Keep this private receipt after interruption, including when the video was retained but local endpoint extraction failed. It contains no usable signed URL. Blob access expires independently of the local command; a failed or interrupted cleanup can leave a stored object that still incurs storage charges.

Run cleanup for the exact take with access to the same Blob store:

```sh
slopcamera direct cleanup direct_atrium --attempt take_orbit_v1 --json
```

Cleanup makes Blob requests, verifies the exact object, conditionally deletes it, and checks its absence. It doesn't generate video or release a model spending reservation. Repeating cleanup skips confirmed deletions and can resolve earlier uncertainty. Preserve an `uncertain` result for follow-up; a successful CLI response alone doesn't mean every object was deleted. An upload whose remote outcome remains unknown can stay uncertain even if the object is currently absent.

Automatic cleanup leaves references available while a provider call is ambiguous. Let a potentially active generation finish before manual cleanup if it still needs its references; deleting them can prevent a later provider fetch. `resume` only reconciles local video receipts and endpoint extraction, so use `cleanup` separately for retained hosting objects. Cleanup closes that take's hosting session; another upload requires a deliberate new take.

## Assemble and edit the accepted clips

Assemble after every recipe shot has a current accepted take:

```sh
slopcamera direct assemble direct_atrium --json
```

The result includes an ordinary version-one video `projectId`, its project path, and an assembly receipt binding the accepted source bytes and recipe. Clips appear in recipe order with direct cuts. Their measured video spans determine the timeline, including any difference from the duration requested from the model. Audio plays at unity gain within each video span; leading or trailing audio beyond that span is trimmed at the cut. Longer audio cannot extend the clip into a black interval. The assembler doesn't synthesize narration, crossfade sound, or guarantee audio continuity. Use ordinary project edits to adjust audio, add music, trim clips, apply overlays, and set delivery dimensions.

Assembly sums native rational video durations before flooring cumulative cuts to integer microseconds. Its version-two timing receipt records the source media duration, selected video span, cut positions, and audio trims. The output remains an ordinary version-one media project. Existing sources, take records, and projects stay retained; the new timing policy creates a separate assembly identity.

For admitted YUV sources, assembly creates a retained RGB video using the same BT.709-to-sRGB interpretation as endpoint extraction. FFmpeg `libx264rgb` encodes these converted pixels losslessly and copies the complete source audio without re-encoding. The project placement applies the audio trims; the derivative retains the full source timing. Slopcamera checks native frame timestamps, final-frame duration, video and audio timing, frame count, and dimensions before using the derivative. Original source bytes remain unchanged; normalization receipts bind their hashes to the derivative, color interpretation, and encoder version. Already admitted opaque sRGB sources can be reused directly.

This conversion adds local encoding time and storage. Each derivative must finish within 120 seconds and fit the 512 MiB media bound; failure retains the source instead of lowering quality automatically. Keep the derivative and its receipts with the generated project. Final delivery still uses the ordinary project's chosen output encoding.

Use the returned project ID to inspect and render the composition:

```sh
slopcamera project inspect <returned-project-id> --json
slopcamera project render plan <returned-project-id> --width 848 --height 480 --fps 24 --json
slopcamera project render run <returned-project-id> --width 848 --height 480 --fps 24 --json
```

Review the rendered join and delivery before presenting the result. Reassembling the same accepted selection can reuse the exact initial project; it cannot overwrite subsequent project edits. A new accepted selection produces a separately retained assembly.

Recovery after interrupted assembly re-probes the verified media and checks the reconstructed project against its retained intent before publication. For YUV clips, keep the normalization receipt and use the same FFmpeg version: missing evidence or a changed encoder version causes a conflict before another encode.

This assembly path uses the ordinary media project and compositor. Selecting a generated candidate in a version-two spatial project still doesn't replace authored footage in that scene compositor. Interactive world editing and provider checkpoint continuation remain outside this workflow.

Review, revision, inspection, `resume`, and assembly work without cloud credentials. Hosting and `cleanup` need Blob credentials. A provider's successful generation still has to pass local media admission: self-contained MP4 or QuickTime clips with exactly one playable video stream, at most 60 seconds, 512 MiB, 4096 pixels per side, and 4000 decoded frames. Endpoint extraction checks ordered native presentation timestamps and the supported SDR color interpretation.

For supported opaque 8-bit YUV video with missing color tags, Slopcamera records `untagged-8bit-yuv-assume-bt709-v1` in endpoint and assembly receipts. Missing transfer, primaries, and matrix tags are interpreted as BT.709; missing range is interpreted as limited range. The receipts preserve observed tags and each assumption, and endpoint images are converted to sRGB. This declared interpretation doesn't prove the source's intended color. Conflicting tags, HDR metadata or transfer functions, 10-bit formats, and video with alpha require separate qualification or explicit conversion; this path performs no HDR tone mapping. Admitted RGB formats are opaque `rgb24`, `bgr24`, and `gbrp`. Retain unsupported paid media for inspection.
