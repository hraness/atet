# Contents

- `src/scene.ts` defines the bounded local scene-analysis request, response, and provider contracts.
- `src/index.ts` is the package export surface.

# Guidelines

- Keep this package provider-neutral and free of accounts, quotas, hosted APIs, and credentials.
- Parse foreign values with Zod and keep selected-frame uploads explicit and bounded.
- Never serialize API keys, OIDC tokens, or raw provider responses into scene contracts.
