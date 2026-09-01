# Contents

- `contracts.ts` – bounded authoring, resource, timing, parameter, and absolute-frame schemas.
- `libraries.ts` – the exact browser-library lock registry and canonical private-origin import maps.
- `random.ts` – the versioned deterministic random sequence shared with the injected browser runtime.
- `runtime.ts` – source generation for the page-visible authoring API and host-only frame controller.
- `scaffolds.ts` – transparent plain DOM, Motion, Paper Shaders, Three.js, and vgpu starting documents.
- `index.ts` – the portable HTML-overlay authoring surface.
- `*.test.ts` and `*.property.test.ts` – deterministic examples, boundary rejection, and algebraic checks.

# Guidelines

- Keep this boundary side-effect-free and browser-portable. It may parse values and generate strings or data, but it must not read files, fetch modules, start browsers, or depend on ambient clocks or randomness.
- Parse every foreign value through strict bounded schemas. Normalize unordered resources by logical name and libraries by exact bare specifier before hashing, rendering, or receipt creation.
- Emit `atet.*` identities for new authoring state. Accept a named Atet value only through an explicit compatibility parser or normalization path that keeps persisted v1 work readable.
- Treat `APPROVED_HTML_OVERLAY_LIBRARY_LOCKS` as the complete allowlist. Never accept ranges, redirects, subpath imports, mutable URLs, or caller-supplied lock metadata.
- Keep author code on an absolute Atet-owned clock. The host seeks browser and tracked animations before invoking frame callbacks; visible output must not depend on wall time.
- Keep generated routes root-relative so ephemeral loopback ports do not change authored identities. The effectful browser boundary remains responsible for denying all undeclared requests.
