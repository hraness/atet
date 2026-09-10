# Use SDKs and durable workflows

Use `slopcamera workflows list --json` and `slopcamera workflows show <id> --json` to discover checked recipes and their actual inputs. Built-ins include `talking-head-cleanup`, `polished-screen-demo`, `chaptered-demo`, `social-variants`, `creative-iteration`, `creative-selection` and `directed-scene`. Keep ordinary project edits complete before a V2 scene migration.

```sh
slopcamera workflows plan <id> --input input.json --json
slopcamera workflows run <id> --input input.json --json
```

For custom local authoring, use `slopcamera code init workflow.ts`, inspect the starter and its input schema, then `code check`, `code plan` and `code run`. Use `slopcamera help code` for their required `--input` and exact `--plan` flags. Loading a custom module for check or plan runs its trusted Bun top-level code; withheld registered effects are not an OS sandbox.

## Select the SDK boundary

`@hraness/slopcamera/code` is the portable fixed four-operation diagram/image projection. Portable scene and studio schemas do not grant native executors. `@hraness/slopcamera/workflow` preserves the explicitly imported imperative API. `@hraness/slopcamera/local/code` adds the complete closed local media builder, including `.scene`, `.spatialProject`, `.studio`, `.gateway`, `.media`, `.project` and `.render`. Use `@hraness/slopcamera/local/code/workflows` for built-ins, never the nonexistent portable `code/workflows` or `code/testing` imports.

Discover exact local inputs with `slopcamera operations list|show`. No host accepts arbitrary new operation registration or caller-selected shell/argv. The fixed `slopcamera.studio.run` is an explicit exception for previously retained native source: its bundle/job input remains typed, while executable paths and trusted-current-user authority belong to the host invocation. The checked `examples/studio/native-workflow.ts` uses `defineWorkflow` and `StudioRunInputSchema` from the local entrypoint.

`media.ingest` needs an existing ordinary project. There is no public arbitrary-file project bootstrap or SDK project-create operation. Follow [video projects](video-projects.md) for the supported recording/native/directing entry paths; never synthesize their receipts or depend on private constructors.

## Inspect, approve and resume exact work

```sh
slopcamera runs show <run-id> --json
slopcamera runs resume <run-id> --json
```

If paused for approval, read the returned exact preparation or node plan and use `runs approve` with its `--preparation-plan` or `--node-plan` flag. Approval records a decision; a later resume performs work. Do not grant a broader plan than the task authorized.

Native workflow execution also needs `--allow-trusted-code` and the selected `--studio-blender-bin` or `--studio-python` on the execution/resume invocation. A generic effect approval cannot confer native source authority. A completed exact receipt may replay without those execution settings. Private Gateway provider options must be supplied again with the same digest when required; do not store credentials in workflow JSON.

Keep run IDs, errors and receipts after failure. A missing journal does not prove that an effect was never dispatched. Use `--replay-ambiguous-code <node>` only for an explicitly authorized new execution of uncertain trusted code, not as a routine retry. Cancellation does not undo a published output or provider charge.

## Use the portable MCP surface narrowly

When connected, use `check_diagram` and `render_diagram` for compatibility calls, or `search_slopcamera` and `execute_slopcamera` with one exact returned operation and typed JSON. No tool rewrites source.

- Use root-relative paths. A diagram must end in `.diagram.json`.
- Diagram render replaces the five documented exports, never its source.
- MCP bounds diagrams to 64 shapes and 128 edges and reports at most 40 findings. Use the CLI for larger checked sources.
- MCP uses built-in themes/icons and never executes workspace configuration; trusted custom config belongs to the CLI.
- `slopcamera.image.vectorize` keeps raster bytes local and needs no login.
- `slopcamera.image.generate` accepts a root-relative `.webp` output and the two exact registry model IDs; it has no automatic retry.
- Never submit source code, shell text, dynamic imports, arbitrary remote URLs or unregistered names to semantic execution.

The equivalent portable CLI is `slopcamera code search '<terms>' --limit 4` followed by `slopcamera code execute <exact-code> --input '<strict JSON>'`. This small semantic surface is distinct from loading an explicitly trusted local workflow module.
