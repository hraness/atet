# Vercel provider runbook

Atet's public site deploys from `apps/web` in the existing Hraness Vercel project. The provider project, stable-preview environment, domains, and Git refs form one serving contract. Preserve them in place.

## Provider identity

- GitHub source: `hraness/atet`.
- Vercel project: `atet`, ID `prj_RvNXCVvEYKYhW71OA1442SAILmAS`, root directory `apps/web`.
- Production branch: `main`.
- Production domains: `atet.sh`, `hraness.graphics`, and `hraness.studio`.
- Production Vercel alias: `atet-hraness.vercel.app`.
- Stable-preview custom environment: `staging`, ID `env_h9oyPAG0ZOwx0qFQxk0QByLL8c2D`.
- Stable-preview branch matcher: exact branch name `preview`.
- Stable-preview domains: `preview.atet.sh` and `preview.hraness.graphics`.
- Stable-preview Vercel alias: `atet-env-staging-hraness.vercel.app`.

The remote `preview` branch name is provider authority. Do not delete, rename, repurpose, or force-push the branch without a deliberate provider migration. Do not fast-forward it as branch cleanup. Advancing `preview` is a staging release and requires an explicit content decision plus provider verification.

Production, stable preview, and pull-request previews are separate:

- `main` supplies Production and the production domains.
- `preview` is the exact matcher for the durable `staging` custom environment.
- Pull requests whose head branch is not `preview` use Vercel's built-in Preview environment and ephemeral branch aliases. Any push to `preview`, including while it is a pull-request head, matches `staging` and is a staging release that can move the stable-preview aliases.

A custom-environment matcher does not prove which Git ref produced the deployment currently behind an alias. Vercel can point the stable-preview domains at a Ready `staging` deployment whose recorded Git ref is `main`. Treat a branch update and an alias assignment as separate provider changes.

## Pre-change audit

Run this audit before changing the `preview` ref, the custom environment, a stable-preview domain, or an alias. It is read-only.

1. Inspect the project and custom environment.

   ```sh
   vercel project inspect atet --scope hraness
   vercel api /v9/projects/prj_RvNXCVvEYKYhW71OA1442SAILmAS/custom-environments/staging --scope hraness --raw
   ```

   Confirm the project ID and root directory. Confirm that `staging` has ID `env_h9oyPAG0ZOwx0qFQxk0QByLL8c2D` and an `equals` branch matcher whose pattern is `preview`.

2. Inspect every project-domain binding.

   ```sh
   vercel api /v9/projects/prj_RvNXCVvEYKYhW71OA1442SAILmAS/domains --scope hraness --raw
   ```

   Confirm that both stable-preview domains are verified and carry the exact `customEnvironmentId`. Confirm that production domains remain on the same project without a custom-environment binding.

3. Resolve the aliases to their deployment IDs.

   ```sh
   vercel api '/v4/aliases?projectId=prj_RvNXCVvEYKYhW71OA1442SAILmAS&limit=100' --scope hraness --raw
   vercel inspect <stable-preview-deployment-id> --scope hraness
   vercel api /v13/deployments/<stable-preview-deployment-id> --scope hraness --raw
   ```

   Confirm that `preview.atet.sh`, `preview.hraness.graphics`, and `atet-env-staging-hraness.vercel.app` resolve to the same Ready deployment. Read its custom-environment ID, target, `meta.githubCommitRef`, and `meta.githubCommitSha`; do not infer them from the domain or matcher.

4. Refresh and record the exact remote Git refs without changing a worktree.

   ```sh
   git ls-remote --heads origin main preview
   git fetch origin refs/heads/main:refs/remotes/origin/main refs/heads/preview:refs/remotes/origin/preview
   git rev-parse origin/main origin/main^{tree} origin/preview origin/preview^{tree}
   git rev-list --left-right --count origin/main...origin/preview
   ```

   Review the commits unique to each branch before deciding whether staging content should change. A stale or divergent `preview` ref is not sufficient reason to delete or synchronize it.

Record the exact provider IDs, deployment ID, deployment Git ref and SHA, domain bindings, alias mapping, remote commit IDs, tree IDs, and ahead/behind counts in the change or pull request that performs a provider migration.

## Migration order

If the stable-preview branch name must change, keep `preview` intact until the replacement ref, custom-environment matcher, domains, and alias target have been verified together. Change one authority at a time, verify the resulting deployment metadata and public responses, then retire the former ref through an ordinary reviewed deletion. Never use a force-push to perform the migration.
