# Run or recover a workflow

Use a workflow when the same explicit media operations should be planned, reviewed and resumed together. Built-in recipes and custom local Code Mode share the complete host's closed operation registry. The [SDK reference](../reference/sdk.md) distinguishes that host from the smaller portable projection.

## Start with a built-in recipe

```sh
slopcamera workflows list --json
slopcamera workflows show social-variants --json
```

Prepare `input.json` against the returned schema using an inspected project ID and the requested output choices. Then plan and run that same input:

```sh
slopcamera workflows plan social-variants --input input.json --json
slopcamera workflows run social-variants --input input.json --json
```

The built-ins cover talking-head cleanup, polished screen demos, chaptered compositions, social variants, creative iteration/selection, and prepared directed-scene delivery. Their input schemas differ; do not reuse another recipe's JSON blindly.

Planning does not execute registered media effects. It binds the relevant structure and policy; execution can still pause when a particular node needs an exact preparation or effect approval.

## Author a local graph

Use the source-backed Bun distribution for local Code Mode:

```sh
slopcamera code init film.ts
slopcamera code check film.ts --json
slopcamera code plan film.ts --input input.json --json
slopcamera code run film.ts --input input.json --plan <returned-plan-sha256> --json
```

Edit the scaffold and its input to the required operations before planning. `--plan` rejects a changed source, input, structural binding, registry or runtime. Author through `@hraness/slopcamera/local/code` and the supported local import surfaces; discover operation schemas instead of inventing names or policy fields.

Loading a custom workflow evaluates trusted TypeScript, including module top-level code. Checking and planning trusted source are not an OS sandbox. The graph itself is declarative, and graph construction must not execute the registered operations. Keep native authoring in its explicit studio adapter rather than adding a shell-command operation.

## Inspect and authorize a paused run

```sh
slopcamera runs list --json
slopcamera runs show <run-id> --nodes all --json
```

Use the exact node key and plan digest reported by the run. The two approval forms authorize different boundaries:

```sh
slopcamera runs approve <run-id> <node-key> --preparation-plan <sha256> --json
slopcamera runs approve <run-id> <node-key> --node-plan <sha256> --json
```

Choose the form requested by that paused node. Approval records authority; it does not execute the node. Resume the original run afterward:

```sh
slopcamera runs resume <run-id> --json
```

For studio execution, separately pass `--studio-blender-bin <executable>` or `--studio-python <venv-python>` and `--allow-trusted-code` on `code run`, `workflows run` or `runs resume`. A runtime path or generic write grant does not authorize native source. See [native workflow execution](../studio.md#use-native-jobs-in-an-agent-workflow).

## Recover without duplicating work

Keep the original run ID, source and receipts. Normal resume reuses matching retained outcomes; it does not automatically replay ambiguous trusted compute or issue a new uncertain paid request. Use `--replay-ambiguous-code <node-key>` only after inspecting the exact ambiguity and deliberately authorizing that next attempt.

If a paid node used a provider-options file, supply the same digest-matching file on resume. Its raw contents cannot be recovered from the journal. Do not substitute changed settings while claiming the old plan.

To stop new work:

```sh
slopcamera runs cancel <run-id> --json
```

Cancellation is durable, but does not roll back artifacts already published. Inspect the retained result and any unresolved custody before beginning a replacement run. Studio reconciliation, directing resume and Blob cleanup have their own narrower commands; none is a universal retry mechanism.
