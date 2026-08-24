# Vercel provider runbook

Atet's public site deploys from `apps/web` in one existing Hraness Vercel
project. Production is its only durable remote environment. Vercel's built-in
Preview target may build pull requests at disposable generated URLs, but it
does not own a persistent branch, custom environment, domain, alias, database,
or production-only variable.

## Provider identity

- GitHub source: `hraness/atet`.
- Vercel project: `atet`, ID `prj_RvNXCVvEYKYhW71OA1442SAILmAS`.
- Root directory: `apps/web`.
- Production branch: `main`.
- Production domains: `atet.sh`, `hraness.graphics`, and `hraness.studio`.
- Production Vercel alias: `atet-hraness.vercel.app`.

Do not create a custom Vercel environment, a provider-authoritative Preview
branch, or a persistent Preview domain. A branch Preview is disposable
application evidence. It must not become a release channel or another durable
backend.

## Production analytics

Set `NEXT_PUBLIC_POSTHOG_KEY` only in Vercel's Production environment. It is
the public client token for shared PostHog project `543691`, not a personal API
key. `NEXT_PUBLIC_POSTHOG_HOST` may be omitted; when present it must equal
`https://us.i.posthog.com`.

The build emits no analytics asset when the token is missing or `VERCEL_ENV`
is not `production`. The bundled client also checks for the exact
`https://atet.sh/` page before it initializes or sends an event. Built-in
Preview deployments, predecessor hosts, and `404.html` remain inert. Keep
PostHog's cookieless server hash mode enabled.

## Provider audit

Audit before changing the project, domains, Git connection, or environment
variables. These reads must not print variable values.

1. Inspect the project and require the immutable ID, `apps/web` root, `main`
   production branch, and an empty `customEnvironments` list.

   ```sh
   vercel project inspect atet --scope hraness
   vercel api /v9/projects/prj_RvNXCVvEYKYhW71OA1442SAILmAS --scope hraness --raw
   ```

2. Inspect every project-domain binding. Require only reviewed Production
   domains and no `customEnvironmentId`.

   ```sh
   vercel api /v9/projects/prj_RvNXCVvEYKYhW71OA1442SAILmAS/domains --scope hraness --raw
   ```

3. Inspect environment-variable metadata without reading values. Production
   may own the public PostHog key. No record may target a custom environment,
   and built-in Preview must not receive production-only configuration.

4. Resolve each Production alias to a Ready deployment from `main`, then read
   that deployment's exact Git commit. A deployment's historical alias list is
   not proof of current ownership.

5. Confirm that GitHub has `main` and no durable `preview` branch.

   ```sh
   git ls-remote --heads origin main preview
   ```

Provider cleanup must address exact immutable IDs. Remove an obsolete custom
environment's domains, variables, and deployments explicitly before deleting
the environment; Vercel does not document those resources as cascading. Read
the project, domains, aliases, deployments, environment metadata, and remote
branches back afterward. Never infer cleanup from a successful DELETE alone.
