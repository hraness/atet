# Contents

- `src/` contains the complete static `atet.sh` document, visual system, appearance control, crawler files, favicons, and social preview.
- `scripts/build.ts` renders fingerprinted local assets into `dist/` from an explicit allowlist without dependencies or network access.
- `site.test.ts`, `package.json`, and `vercel.json` define the content, identity, accessibility, performance, legacy-host, and deployment contracts.

# Guidelines

- Keep the site static and useful without JavaScript. JavaScript may improve appearance controls, but it must never call a network API, load remote code, or receive credentials.
- Describe the released SDK, local host, and desktop capture shell as one Atet system. Do not introduce a hosted account, billing, authentication, or generation service.
- Keep generation credentials in local SDK or CLI processes. The browser must never accept, store, forward, or render an AI Gateway credential.
- Preserve the four public output families: images, diagrams, animated loops, and video. Treat audio and captions as composable project inputs rather than another project model.
- Use Atet, Ra's solar barque, respectfully as an abstract metaphor for passage and transformation. Do not imitate sacred figures, hieroglyphs, or archaeological objects.
- Keep the homepage concise, semantic, keyboard-operable, readable at 200% zoom, and free of analytics, remote fonts, client frameworks, and runtime network requests.
- Use the canonical Hraness footer lockup. Keep only the homepage in crawler discovery until another durable public route exists.
- Preserve permanent production and preview redirects for every reviewed predecessor host without redirecting canonical Atet hosts.
- Run `bun run check` in this directory after a site change.
