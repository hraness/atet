# Contents

- `src/` contains the complete static `transmute.rocks` document, styles, appearance control, crawler files, and icon.
- `scripts/build.ts` copies the explicit public asset set into `dist/` without bundling or dependency installation.
- `site.test.ts`, `package.json`, and `vercel.json` define the content, performance, and deployment contract.

# Guidelines

- Keep the site static and usable without JavaScript. JavaScript may improve appearance controls, but it must not call a network API or receive credentials.
- Describe the released SDK, local host, and desktop capture shell as one Transmute system. Do not introduce a hosted account, billing, authentication, or generation service.
- Keep generation credentials in local SDK or CLI processes. The browser must never accept, store, forward, or render an AI Gateway credential.
- Preserve the four public output families: images, diagrams, animated loops, and video. Treat audio and captions as composable project inputs rather than another project model.
- Keep the homepage concise, semantic, keyboard-operable, readable at 200% zoom, and free of analytics, remote fonts, and client frameworks.
- Use the canonical Hraness footer lockup. Keep only the homepage in crawler discovery until another durable public route exists.
- Run `bun run check` in this directory after a site change.
