# Transmute web

`transmute.rocks` is a dependency-free static product note. It has no server,
account surface, API route, analytics, or browser credential path. Generation
runs in the local Transmute SDK or CLI with a Vercel AI Gateway credential.

```sh
bun run check
```

The build copies an explicit allowlist from `src/` into `dist/`. Configure the
Vercel project with this directory as its Root Directory. The checked
`vercel.json` performs no dependency install and serves only the built files.
