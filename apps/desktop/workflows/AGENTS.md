# Contents

- Built-in workflow definitions – reviewed graph recipes composed from the public semantic code-mode surface.
- `index.ts` – the explicit discoverable catalog; production never scans arbitrary workflow directories.
- Colocated tests – deterministic graph shape, requirement-envelope, and composition fixtures.

# Guidelines

- Keep built-ins as ordinary versioned `defineWorkflow` modules and register them explicitly in `index.ts`.
- Compose only registered application operations and reviewed deterministic combinators. A checked-in workflow does not make arbitrary callback code pure.
- Use stable semantic node keys and namespaces; never derive durable identity from array position.
- Keep workflow inputs strict, bounded, JSON-safe, and free of consent, credentials, provider options, or authority claims.
- Build aspect-neutral edits once, then derive independent aspect-bound revisions for 16:9, 1:1, and 9:16 outputs.
- Test authored graph shape and policy requirements without executing effects. Rendering fixtures must still travel through production operation paths.
