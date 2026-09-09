# SDK and workflow surfaces

ATET exposes a portable Bun SDK and a complete local media host. Imports select their capability boundary; installing a package does not enable every operation in every host. See [version and capability support](capabilities.md) before using current-source additions.

## Public entrypoints

| Import | Contract |
| --- | --- |
| `@hraness/atet` | Diagram schemas/rendering, vectorization and portable scene/studio contracts and pure planning helpers. |
| `@hraness/atet/code` | Declarative authoring and compilation against the portable, fixed four-operation projection. |
| `@hraness/atet/code/advanced` | Lower-level portable graph, compiler and planning contracts. |
| `@hraness/atet/operations` | The fixed portable semantic operation registry. |
| `@hraness/atet/workflow` | Preserved imperative v0.8 API for explicitly imported trusted Bun workflows. |
| `@hraness/atet/host-resources` | Host resource admission contracts. |
| `@hraness/atet/local/code` | Local declarative authoring, schemas and complete media capability projection. |
| `@hraness/atet/local/code/advanced` | Local graph planning, execution and host integration. |
| `@hraness/atet/local/code/workflows` | Checked built-in local workflow definitions. |
| `@hraness/atet/local/html-overlay` | Local HTML overlay authoring, profiles and contracts. |

There is no public `@hraness/atet/code/testing` or portable `@hraness/atet/code/workflows` entrypoint. The local subpaths need the source-backed Bun distribution; they are not browser SDKs.

## Portable and local operations

The portable projection contains diagram check/render and image generate/vectorize. Portable spatial and studio schemas can parse, hash and plan values without making their local executors available. A graph containing an unsupported operation fails before executor or resource admission.

The local builder adds `analysis`, `edits`, `gateway`, `iteration`, `studio`, `scene`, `spatialProject`, `media`, `project`, `render` and `recording` operations. Inspect the current registry and built-in schemas through the host:

```sh
atet operations list --json
atet operations show atet.studio.run --json
atet workflows list --json
atet workflows show directed-scene --json
```

The registries are closed. An operation input is typed data, not a caller-selected executable, shell command, dynamic loader or registration hook.

Local `media.ingest` imports into an existing project. The public CLI creates ordinary projects from a stopped recording or a successful studio/directing assembly; there is no public SDK project-create operation for arbitrary independent files. Access to TypeScript types does not authorize calling private storage constructors.

## Checked examples

| Example | Host and purpose |
| --- | --- |
| [declarative-workflow.ts](../../examples/declarative-workflow.ts) | Portable diagram workflow and graph authoring. |
| [render-workflow.ts](../../examples/render-workflow.ts) | Preserved imperative Bun workflow. |
| [native-workflow.ts](../../examples/studio/native-workflow.ts) | Local native job through the durable scheduler. |
| [hybrid-scene.ts](../../examples/studio/hybrid-scene.ts) | Pure shared-city and world-media scene construction from admitted assets. |

The native example exports this workflow definition:

```ts
import { defineWorkflow, StudioRunInputSchema } from "@hraness/atet/local/code";

export default defineWorkflow({
  id: "native-studio-shot",
  version: 1,
  inputSchemaId: "native-studio-shot-input-v1",
  inputSchema: StudioRunInputSchema,
  build(workflow, input) {
    return { shot: workflow.studio.run("produce-shot", input) };
  },
});
```

Its input binds the retained bundle manifest and exact job. The host invocation supplies runtime paths and the separate `--allow-trusted-code` authorization; those permissions are not stored in the graph. The result contains generic output file references and a native receipt, not a new project type. Follow [running workflows](../how-to/run-workflows.md) for plan, approval and resume commands.

## Execution and trust

Pure schema parsing and portable planning do not execute authored native source. Loading a custom TypeScript workflow for `code check` or `code plan` does execute the trusted Bun module's top-level code; withholding registered effects is not an OS sandbox.

The local scheduler binds exact artifacts, operation plans and observed runtime identities. It admits physical work under resource claims, retains progress and receipts, and rejects incompatible inputs on resume. Runtime identity is evidence about the selected tools and observed environment, not proof of a hermetic operating system.

Effect approval and native source authorization have different scopes. `runs approve` records an exact preparation or node plan. Native execution also needs an invocation-scoped trusted-current-user envelope. An ambiguous external or native attempt must be reconciled; a missing journal is not proof that nothing ran. Cancellation cannot roll back a completed provider request or published artifact.

## MCP and canvas interchange

`atet mcp` offers compatibility diagram tools and the bounded portable semantic registry. Paths are root-relative, configuration is inert, and diagram tools admit at most 64 shapes and 128 edges with at most 40 reported findings. The CLI supports larger checked diagrams and trusted workspace configuration.

Generated `.tldr` is editable interchange. `atet canvas open <file.tldr>` passes it to tldraw Offline; saving there creates the app's native `.tldraw` bundle. The diagram JSON remains ATET's authored source. See the [diagram tutorial](../tutorials/first-diagram.md) for source and export behavior.
