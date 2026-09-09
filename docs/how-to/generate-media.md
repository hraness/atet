# Generate images, video, or narration

Use Vercel AI Gateway when a project needs generated media or a cloud transcript. Keep the intended subject, reference files, duration and delivery role explicit. Model discovery is live; the examples below require real IDs returned by your current catalog.

## Discover a compatible model

```sh
atet ai models list --type image --json
atet ai models list --type video --json
atet ai models list --type speech --json
atet ai models list --type transcription --json
atet ai models show <model-id> --json
```

Check the model's actual input types and settings. A video model may not accept first/last frames or a requested duration; a streaming-only transcription entry is not a batch transcription model. For a long prompt, use a file so shell quoting cannot alter it.

## Supply credentials for this invocation

ATET reads `AI_GATEWAY_API_KEY`, falling back to `VERCEL_OIDC_TOKEN`. Set an existing credential in the process environment or use an already linked Vercel project:

```sh
vercel env run -- atet ai models list --type image --json
```

Do not put credentials on argv, in source, in a project, or in a provider-options file. The [Vercel runbook](../vercel.md) covers that integration. Generation can incur provider charges; discovery does not authorize spending beyond the task's scope.

## Generate the selected media

Run the command that matches the required output:

```sh
atet ai image generate --model <image-model-id> --prompt-file image-brief.txt --aspect-ratio 16:9 --json
atet ai video generate --model <video-model-id> --prompt-file shot-brief.txt --image product.png --duration 6 --aspect-ratio 16:9 --allow-cloud-upload --json
atet ai speech generate --model <speech-model-id> --text-file script.txt --format wav --json
atet ai transcribe interview.wav --model <transcription-model-id> --format all --allow-cloud-audio-upload --json
```

A local reference requires acknowledgement of uploading those exact files. Transcription has its separate audio-upload flag. Ordinary user-supplied URLs must meet the public-reference rules; do not put a signed or credential-bearing URL into shell history.

Use `atet help ai` for masks, references, counts and other common flags. When a provider exposes an additional control, retain a private bounded JSON options file, inspect it with `atet ai provider-options inspect`, and pass `--provider-options`. Provider fallback models and duplicate provider sample-count controls are rejected. Raw options are invocation-scoped; a resumed workflow may require the same file again.

## Inspect and retain the result

Generation returns content-addressed media and receipts beneath `artifacts/atet/generated/`. Check actual picture or sound, identity fidelity, duration and fulfillment count before selecting a result. A provider response can succeed while local media admission fails; preserve the returned paid bytes and failure evidence.

When an ordinary project should consume a result, use the exact suggested `project add` command. It binds the selected output without guessing its path or role.

Do not automatically repeat an ambiguous paid call. Zero client retries do not prove the provider performed only one internal attempt. Inspect the receipt, reconcile supported retained state, and make any new paid request an explicit decision within the existing authorization.

For several shots, accepted takes, endpoint continuity and one retained budget, use [short-video directing](../directing-video.md) on a compatible current-source CLI. Its private reference-hosting adapter is separate from ordinary URL inputs; Blob charges remain outside the model estimate.

For one explicitly named output file, the portable lane is `atet image generate '<prompt>' --output image.webp`. That lane has its own bounded model contract and does not expose the full content-addressed `ai` grammar. Vectorization is a separate local operation and requires no Gateway credential.
