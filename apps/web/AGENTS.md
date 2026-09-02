# Contents

- `src/` contains the static `atet.sh` homepage and documentation, inert `/preview` composition, visual system, appearance control, crawler files, favicons, social preview, and machine-readable page bodies.
- `src/negotiate.ts`, `src/negotiate-request.ts`, and `middleware.ts` select HTML or markdown from `Accept` for document routes.
- `scripts/build.ts` renders fingerprinted local assets into `dist/` from an explicit allowlist and bundles the pinned PostHog browser client only for a configured Production build.
- `site.test.ts`, `package.json`, and `vercel.json` define the content, identity, accessibility, performance, legacy-host, and deployment contracts.

# Guidelines

- Keep the site static and useful without JavaScript. Browser code may load only fingerprinted local assets. The sole runtime request is the reviewed PostHog pageview boundary below.
- Use the framework-neutral `@hraness/design-kit` appearance menu as the final action in every ordinary HTML header. Keep exactly one Light, Dark, and System icon-menu control per page, default to System, and never place it inside navigation or a footer.
- Keep `apps/web` independently installable from its Vercel Root Directory: pin every dependency exactly in this package and commit its local `bun.lock`. Verify an isolated `bun install --frozen-lockfile --ignore-scripts`; do not depend on the parent workspace catalog or lockfile.
- Describe the released SDK, local host, and desktop capture shell as one Atet system. Do not introduce a hosted account, billing, authentication, or generation service.
- Keep generation credentials in local SDK or CLI processes. The browser must never accept, store, forward, or render an AI Gateway credential.
- Preserve the four public output families: images, diagrams, animated loops, and video. Treat audio and captions as composable project inputs rather than another project model.
- Use Atet, Ra's solar barque, respectfully as an abstract metaphor for passage and transformation. Do not imitate sacred figures, hieroglyphs, or archaeological objects.
- Keep every page semantic, keyboard-operable, readable at 200% zoom, and free of remote fonts and client frameworks. Analytics may emit one anonymous cookieless `$pageview` from `https://atet.sh/` to `https://us.i.posthog.com`, tagged with `site_id=atet` and `analytics_schema_version=1`. Keep persons, persistence, autocapture, replay, flags, surveys, heatmaps, pageleave, web vitals, referrer, URL, query, hash, page text, content, and custom events disabled. Do not initialize analytics on built-in Preview deployments, alternate hosts, or `404.html`.
- Organize `/docs` by user intent: guided learning, goal-oriented how-to, factual reference, and conceptual explanation. Do not mix those modes into one undifferentiated command catalog.
- Render the canonical `@hraness/site-footer` markup and styles on every ordinary HTML page. Keep product links and disclosures outside the footer. The noindex `/preview` composition is the sole exception: keep it free of scripts, analytics, actions, authentication, user data, and crawler discovery.
- The reading collection is intentionally empty. Before adding a route, score the proposed page from 0–2 on reader utility, original evidence, factual confidence, Atet fit, voice integrity, and maintenance. Publish only at 9/12 or higher with no zero; revise or consolidate at 6–8; reject at 5 or lower. Record the reader job, three nearest existing URLs and merge rationale, evidence owner, refresh trigger, and a 28–56 day reassessment date in the same change.
- A reading must add first-party evidence or a genuinely Atet-specific conclusion beyond summarizing another Hraness note. Do not invent first-person experience, pad a page to satisfy length or heading quotas, manufacture an “X, not Y” frame, or create a sibling-link web to make a thin collection appear substantial.
- Keep editorial discovery selective. Do not generate art before the page clears editorial admission, add generic “Ask AI about this” chrome to editorial pages, or treat keyword coverage, article count, image count, internal-link volume, or word count as evidence of value.
- If a reading is admitted, publish crawlable HTML with a matching markdown mirror and keep visible figures, captions, responsive image delivery, social metadata, schema, feeds, and sitemaps synchronized through the `editorial-image-seo` skill. Retain reviewed image provenance without exposing internal paths publicly.
- Publish `/llms.txt` as `text/plain` with an H1, summary, and a when-to-use section. Publish `/sitemap.md` and `/index.md` as markdown. Honor `Accept: text/markdown` on the homepage with `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`. Return `406` when the request rejects every produced type. Keep unknown routes as real `404` or `410` responses, and give markdown 404s recovery links to the home page, `llms.txt`, and sitemaps.
- Do not add a public API, OAuth, GraphQL, MCP, account, or commerce surface to the website.
- Preserve permanent production redirects for every reviewed predecessor host without redirecting canonical Atet hosts. Do not create a durable Preview hostname as a compatibility target.
- Run `bun run check` in this directory after a site change.
