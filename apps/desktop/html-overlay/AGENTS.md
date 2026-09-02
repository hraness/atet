# Contents

- `contracts.ts` – bounded authoring, resource, timing, parameter, and absolute-frame schemas.
- `catalog.ts` – the exhaustive supported-profile taxonomy and scaffold library selection.
- `libraries.ts` – active authoring locks, append-only historical receipt locks, and canonical private-origin import maps.
- `random.ts` – the versioned deterministic random sequence shared with the injected browser runtime.
- `runtime.ts` – source generation for the page-visible authoring API and host-only frame controller.
- `scaffolds.ts` – transparent plain DOM, Motion, p5.js, Two.js, Paper Shaders, Three.js, and vgpu starting documents.
- `index.ts` – the portable HTML-overlay authoring surface.
- `*.test.ts` and `*.property.test.ts` – deterministic examples, boundary rejection, and algebraic checks.

# Guidelines

- Keep this boundary side-effect-free and browser-portable. It may parse values and generate strings or data, but it must not read files, fetch modules, start browsers, or depend on ambient clocks or randomness.
- Parse every foreign value through strict bounded schemas. Normalize unordered resources by logical name and libraries by exact bare specifier before hashing, rendering, or receipt creation.
- Emit `atet.*` identities for new authoring state. Accept a named Atet value only through an explicit compatibility parser or normalization path that keeps persisted v1 work readable.
- Resolve new authoring only through the active exact lock registry. Historical locks are append-only receipt evidence, not an executable selection surface. Never accept ranges, redirects, subpath imports, mutable URLs, or caller-supplied lock metadata.
- Give every supported profile one unique primary authoring job. Put composable capabilities, authored-asset runtimes, and external creative tools behind separate seams instead of adding overlapping scaffold kinds.
- Keep author code on an absolute Atet-owned clock. The host seeks browser and tracked animations before invoking frame callbacks; visible output must not depend on wall time.
- Keep generated routes root-relative so ephemeral loopback ports do not change authored identities. The effectful browser boundary remains responsible for denying all undeclared requests.
