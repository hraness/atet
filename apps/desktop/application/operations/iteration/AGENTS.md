# Contents

- immutable creative candidate, closed matrix, and explicit selection publication operations.
- shared content-addressed document and render-verification helpers.
- colocated deterministic tests for closure, stale evidence, and immutable recovery.

# Guidelines

- Keep creative candidates rooted in one exact frozen base and never move the current project pointer from this boundary.
- Publish canonical documents with no-replace and read-back verification. Preserve both semantic document hashes and physical byte hashes in references.
- Load every matrix member and the chosen candidate before selection. A compact reference is evidence only after its immutable artifact has been verified.
- Keep candidate sets between one and sixteen entries, sorted and unique by stable candidate identity. Keep render names bounded, sorted, and unique.
- Do not accept caller-computed candidate IDs, namespaces, or content hashes when the host can derive them from resolved operation outputs.
