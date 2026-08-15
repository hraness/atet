# Atet web

`atet.sh` is the dependency-free public site for Atet. It presents the SDK,
Bun CLI, local runtime, and desktop capture shell without adding a server,
account surface, API route, analytics, remote font, or browser credential path.
Generation runs from the local Atet SDK or CLI with the operator's Vercel AI
Gateway access.

```sh
bun run check
```

The build fingerprints the local stylesheet and appearance script, then copies
an explicit allowlist from `src/` into `dist/`. Configure the Vercel project
with this directory as its Root Directory. The checked `vercel.json` performs
no dependency install, serves only built files under a strict CSP, and sends
reviewed predecessor hosts to their matching Atet production or preview host.
