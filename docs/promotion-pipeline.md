# Promotion Pipeline — draft design

**Status: DRAFT.** Implementation sketch for the "Flight" half of the Agentic
Development Lifecycle RFC (build once, promote the artifact). Opened as a draft
PR to make the adoption discussion concrete — not for merge as-is.

**Scope.** Delivery machinery only: candidate builds, stage deploys, promotion,
release tags, rollback, and the production lock. Merge-gate / review-policy
changes are explicitly out of scope — this pipeline works identically whether a
repo requires human PR review or not, which is what lets it ship first.

## Image flow

```
tip of main
   │  candidate build (env-neutral)
   ▼
candidate-<n>  (+ sha-<gitsha>)
   │  deploy to stage (scheduled daily / manual)
   ▼
[ Stage ]  ── human review / UAT ──►  Promote (human gate, cru-deploy)
                                          │  same digest, no rebuild
                                          ▼
                                    [ Production ]
                                          │
                                          ▼
                                    release-<r> tag  ◄── rollback target
```

## Naming

| Tag | Applied | Meaning |
|---|---|---|
| `candidate-<n>` | at build | Environment-neutral image from tip of `main`. `<n>` continues to come from the DynamoDB `ECSBuildNumbers` counter — monotonic per project. |
| `sha-<gitsha>` | at build | Traceability back to the exact commit. |
| `release-<r>` | at promote | Added to the exact digest deployed to production. Monotonic per project. `Rollback = redeploy release-<r-1>`. |

The current `<environment>-<build>` tags retire per-app after migration.

## Components

| Piece | Where | Status |
|---|---|---|
| `build-candidate.yml` reusable workflow | this repo | skeleton in this PR |
| Stage deploy | existing `deploy-*.yml` + candidate tag | needs action change (below) |
| `promote.yml` reusable workflow (digest-based) | this repo | skeleton in this PR |
| `rollback.yml` reusable workflow | this repo | skeleton in this PR |
| Production lock | `concurrency: production-<project>` on promote/rollback/hotfix jobs | in the skeletons |
| Human gate | GitHub Environment `production` on **cru-deploy** with required reviewers | config, not code |
| Hotfix (cut from release tag + back-merge PR) | later phase | not in this PR |
| Rollback-safety detection (migration classifier) | later phase; only gates *auto*-rollback | not in this PR |

## cru-deploy side (wrappers)

Two new `workflow_dispatch` workflows in cru-deploy, mirroring the existing
pattern (thin wrappers over the reusables here):

```yaml
# cru-deploy/.github/workflows/promote.yml
on:
  workflow_dispatch:
    inputs:
      project-name: { required: true, type: string }
      deploy-type:  { required: true, type: choice, options: [ecs, lambda, cloudrun] }
      project:      { required: false, type: string, description: GCP project (cloudrun only) }
jobs:
  promote:
    uses: CruGlobal/.github/.github/workflows/promote.yml@v1
    with: { project-name: ..., deploy-type: ..., project: ... }
    secrets: { datadog-api-key: ${{ secrets.DD_API_KEY }} }
```

`rollback.yml` is identical plus a `release` input (defaults to the previous
release). Deploy/Promote/Rollback all bind the `production` GitHub Environment
so required reviewers apply, and share one concurrency group per project.

## Required changes to existing code

1. **Deploy actions accept an explicit image.** `actions/deploy-ecs`,
   `deploy-lambda`, `deploy-cloudrun` currently construct
   `<registry>/<project>:<env>-<build>` internally (`src/ecs-config.js`,
   `src/gcp.js`). They need an optional `image` input (full reference,
   digest preferred) that bypasses tag construction. Stage deploys pass
   `candidate-<n>`; promote/rollback pass the resolved digest.
2. **Terraform IAM for re-tagging.** Adding `release-<r>` to an existing
   manifest requires `ecr:PutImage` (AWS) / Artifact Registry tag write (GCP)
   on the **deploy** identities, which today are read-only against registries.
   Alternative: keep registries immutable and record releases in a ledger
   (DynamoDB) instead of tags. → Open question 3.
3. **Lambda env-neutrality.** `build-lambda.yml` currently bakes
   `PROJECT_NAME` / `ENVIRONMENT` / `BUILD_NUMBER` as build args. Env-specifics
   move to runtime configuration (Terraform `aws/lambda/app` change).

## App-repo migration (per repo, Phase 2)

1. Replace `build-deploy-*.yml` with a candidate workflow: `push: [main]`
   builds `candidate-<n>`; stage deploy on schedule (or on-push while piloting).
2. Delete the `staging` branch, `.github/merge-bot.yml`, and the "On Staging"
   label flow after cutover.
3. Old workflows remain until Phase 4 — reverting a pilot is a file revert.

## Open questions

1. **BUILD secrets for env-neutral images.** Candidate builds can't pull
   env-scoped BUILD secrets. Draft assumes the `prod` namespace (candidates are
   prod-bound); the better end state is a `shared` namespace or moving
   env-variance fully to runtime.
2. **Daily stage build scheduling.** Per-app cron in the app repo (simple,
   distributed) vs. a central matrix cron in cru-deploy (one place, needs an
   app registry — `CruApplicationInfo` could serve).
3. **Release record of truth.** Registry tag, git tag in the app repo, GitHub
   Release, or a DynamoDB release ledger. Draft: registry tag + git tag.
4. **Preview/lab.** Tag-driven preview deploys (per RFC comments) — out of
   scope here, worth designing alongside Phase 2.

## Phasing

This PR is Phase 1 of the adoption plan. Phase 2 puts pilot repos (one per
runtime) on it with human review still required. Gate changes (Phase 3) are a
separate, later decision per repo.
