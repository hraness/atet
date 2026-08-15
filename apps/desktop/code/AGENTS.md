# Contents

- `contracts.ts`, `graph-builder.ts`, `define-workflow.ts`, `compiler.ts`, and `plan-contracts.ts` – compatibility facades over the canonical `@hraness/atet/code` graph, authoring, compilation, and identity contracts.
- `planning.ts` – trusted-source loading plus project and declared-file static preflight.
- `file-candidate.ts` – the progressive public declaration for compute-selectable local files.
- `creative-recipes.ts` – literal, typed media-treatment recipes for reusable Code Mode requests.
- `application-node-planner.ts` – exact host preparation, provenance checks, publication keys, and recovery routing for registered operations.
- `scheduler.ts` and `run-store.ts` – bounded concurrent execution, authorization, fencing, cancellation, recovery, and durable outputs.
- `source-bundle.ts`, `source-typecheck.ts`, and `worker-*` – same-snapshot semantic checking, exact trusted-source bundling, and the isolated code-worker protocol/pool.
- `public.ts` – the stable complete-local-host custom-workflow surface layered on the portable SDK.
- `advanced.ts` – explicit local-host planning, registry, and execution integration beside portable advanced exports.
- `testing.ts` – deterministic graph-planning identities and fixtures for workflow tests.
- colocated deterministic and property tests.

# Guidelines

- Keep the portable graph, references, compiler, canonical JSON, errors, and identity rules in the root `src/code` SDK. These local facades add host bindings; never fork or reimplement the core here.
- Keep authored graphs declarative. Building or compiling a graph must never execute an application operation, read credentials, upload media, contact a paid service, or mutate project state.
- Serialize every reference with its producer node key and output schema identity. Persist explicit causal dependencies separately, then independently rederive the complete data-plus-control dependency set during compilation.
- Derive effects, sensitive reads, resources, cost bounds, retry semantics, and fan-out only from `OperationRegistry` discovery. Reject policy-like metadata on authored graph nodes.
- Keep node identity independent of construction order and array position. Namespace fragment nodes with validated path segments and sort canonical graph records by stable key.
- Parse persisted graphs and plans from `unknown` through strict versioned schemas. Reject duplicate or dangling nodes, schema mismatches, cycles, and configured node, edge, depth, and fan-out limits before execution.
- Preserve the portable compiler's graph, node, reference, and plan identities. Local planning may bind runtime, bundle, registry, project, and requirement evidence through explicit host extension points, but it must not redefine canonical identity.
- Keep `/testing` helpers out of production workflow-loading paths. Public authoring, advanced graph access, and testing fixtures remain separate export surfaces.
- Author local workflows through `@hraness/atet/local/{code,code/advanced,code/workflows,html-overlay}`. Accept only the four exact `@hraness/transmute/local/*` predecessors as input-only migration aliases, and never emit or document them in new templates.
