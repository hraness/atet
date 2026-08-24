# Atet web

`atet.sh` is the static public site and documentation for Atet. It
presents the SDK, Bun CLI, local runtime, and desktop capture shell without
adding a server, account surface, API route, remote font, or browser credential path.
Agents can read `/llms.txt` and request `Accept: text/markdown` on the homepage.
Generation runs from the local Atet SDK or CLI with the operator's Vercel AI
Gateway access.

```sh
bun run check
```

The build fingerprints the local stylesheet and appearance script, then copies
an explicit allowlist from `src/` into `dist/`. A configured Vercel Production
build also bundles the pinned PostHog client as a fingerprinted local asset.
That client sends one anonymous cookieless pageview from `https://atet.sh/` and
does not run on Preview, alternate hosts, or the not-found page. Configure the
Vercel project with this directory as its Root Directory. The checked
`vercel.json` installs from this directory's frozen Bun lockfile without relying
on the parent workspace catalog, serves only built files under a strict CSP,
and sends reviewed predecessor hosts to their matching Atet production or
preview host.
