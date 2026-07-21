# Pipeline v2

Pipeline v2 is a clean-break rebuild of CruGlobal's shared build/deploy pipeline
around **build once, promote the artifact**. An env-neutral image is built a
single time from `main`, pushed to a shared registry, and every environment then
deploys *that exact artifact* — pinned by digest — rather than rebuilding per
environment.

This document covers:

- **Pass 1** — the `resolve-image` and `deploy` actions (Cloud Run implemented;
  ECS and Lambda stubbed).
- **Pass 2** — the four reusable workflows (`build-candidate`,
  `deploy-candidate`, `promote`, `rollback`) and the generic `dispatch` action
  that wire those actions into the promotion flow.

## Conventions

### Shared registry (Cloud Run)

One Artifact Registry repo per app in the shared GCP project
`cru-shared-artifacts`; the repo and the image are both named after the app:

```
us-central1-docker.pkg.dev/cru-shared-artifacts/<project-name>/<project-name>:<tag>
```

### Shared registry (ECS / ECR)

ECR needs **no shared-project work**: it is already org-shared — one registry
(account `056154071827`, region `us-east-1`), one repo per app. v2 just adds the
new tag families to the app's **existing** ECR repo:

```
056154071827.dkr.ecr.us-east-1.amazonaws.com/<project-name>:<tag>
```

**The project-name fix.** v1's ECS path keyed the ECR repo off the *repository
name* in some places and the *project name* in others. v2 keys everything —
build tagging, tag→digest resolution, the app-container image match — on the
**project name** consistently. The ECR repo is `<project-name>`; the app
container is the one whose image repo segment equals `<project-name>` (or the
`scratch` placeholder). This is the same "one repo per app, named after the app"
convention Cloud Run uses.

### Tag families

| Tag                | When            | Purpose                                   |
| ------------------ | --------------- | ----------------------------------------- |
| `candidate-<n>`    | at build        | env-neutral build of `main`               |
| `sha-<gitsha>`     | at build        | git traceability                          |
| `release-<r>`      | at promote      | promoted release / rollback target        |

### The deploy invariant

**v2 deploys digests, never tags.** Tags are always resolved to a digest first;
what runs in an environment is pinned by `@sha256:...`. The `deploy` action
*fails* if handed a tag reference. `resolve-image` exists to turn a tag (or the
image currently running in an environment) into a digest reference.

### Environment long names

v2 uses user-facing long names that map onto the existing v1 runtime nicknames.
Runtime infrastructure (per-app-per-env GCP projects) is unchanged from v1.

| Long name           | Nickname | Meaning                          |
| ------------------- | -------- | -------------------------------- |
| `production`        | `prod`   | live production                  |
| `release-candidate` | `stage`  | pre-prod candidate               |
| `preview`           | `lab`    | ephemeral / preview              |

## Action: `resolve-image`

Resolves a tag or a running environment to a digest-pinned image reference in
the shared registry.

### Inputs

| Input             | Required                       | Description                                                                 |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `type`            | yes                            | `ecs` \| `lambda` \| `cloudrun`                                             |
| `project-name`    | yes                            | Project name (shared-registry repo and image name)                          |
| `mode`            | yes                            | `environment` (resolve the RUNNING image) \| `tag` (resolve a tag)          |
| `environment`     | when `mode=environment`        | Long env name whose running image to resolve                                |
| `tag`             | when `mode=tag`                | e.g. `candidate-10012`, `release-3` — resolved against the shared registry  |
| `runtime-project` | cloudrun + `mode=environment`  | GCP project ID of the app's target-env project                              |

### Outputs

| Output   | Description                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| `image`  | Full digest reference, e.g. `us-central1-docker.pkg.dev/cru-shared-artifacts/hoax/hoax@sha256:...` |
| `digest` | The `sha256:...` digest portion                                                      |
| `tags`   | Comma-separated tags currently on that digest in the shared registry (when resolvable) |

## Action: `deploy`

Deploys a pre-built, digest-pinned image to a target environment.

### Inputs

| Input             | Required          | Description                                                          |
| ----------------- | ----------------- | -------------------------------------------------------------------- |
| `type`            | yes               | `ecs` \| `lambda` \| `cloudrun`                                     |
| `project-name`    | yes               | Project name                                                         |
| `environment`     | yes               | Long env name to deploy to                                          |
| `image`           | yes               | FULL DIGEST reference (`name@sha256:...`); a tag ref fails the action |
| `runtime-project` | cloudrun          | GCP project ID of the target-env project                            |

### Outputs

| Output           | Description                                     |
| ---------------- | ----------------------------------------------- |
| `deployed-image` | The digest reference that was deployed          |
| `services`       | Comma-separated names of the services updated   |

## Implemented vs stubbed

| Runtime  | resolve-image | deploy      | build-candidate |
| -------- | ------------- | ----------- | --------------- |
| cloudrun | implemented   | implemented | implemented     |
| ecs      | implemented   | implemented | implemented     |
| lambda   | stub (throws) | stub (throws) | stub (fails)  |

Both actions use a router that dispatches on `type`. The Lambda stubs throw a
clear "lands in a later v2 pass" error, so Lambda gets filled in later without
any change to the action interfaces.

### Cloud Run implementation notes

- **tag -> digest**: `resolve-image mode=tag` lists Artifact Registry
  `dockerImages` in `cru-shared-artifacts/<project-name>` (REST API,
  authenticated via `google-auth-library` ADC) and finds the image whose `tags`
  include the requested tag; the digest is parsed from that image's canonical
  `uri`.
- **environment -> digest**: `resolve-image mode=environment` lists the Cloud
  Run services in `runtime-project`, identifies the app container (single
  container, else image-repo match against the shared registry, else the
  container with a port — the same heuristic v1's deploy uses), and returns its
  image ref. A digest ref is returned as-is; a tag ref is resolved via the
  registry.
- **deploy**: ports v1's `src/deploy-cloudrun.js` orchestration using the
  explicit digest input instead of constructing a tag:
  1. if a `db-migrate` Cloud Run job exists, refresh its image + RUNTIME secrets
     and run it to completion first; a failure fails the deploy with services
     untouched.
  2. refresh other jobs' image/secrets without executing them.
  3. update each service, rewriting **only** the app container (sidecars such as
     the Datadog agent are preserved), re-attaching RUNTIME secrets as
     `secretKeyRef:latest`, and forcing a new revision.

### ECS implementation notes

ECS shares the Cloud Run action contracts but derives everything from the env
**nickname + naming conventions** — it takes **no `runtime-project`** (that input
is GCP-only). Long name → nickname (`prod`/`stage`/`lab`) → cluster; long name →
legacy long name (`production`/`staging`/`lab`) is also used, because v1 infra
named services with either the legacy long name or the nickname.

- **tag -> digest**: `resolve-image mode=tag` calls ECR `DescribeImages` by
  `imageTag` and returns the `imageDigest` (plus every tag on that digest). The
  full ref is `056154071827.dkr.ecr.us-east-1.amazonaws.com/<project>@<digest>`.
- **environment -> digest**: `resolve-image mode=environment` lists the app's
  services in the env cluster (regex `/<project>-(<legacy>|<nick>)-`), reads the
  app container's image off the service's **current** task definition, and
  normalizes it to a digest ref — resolving via ECR if it is a tag ref. The
  `scratch` placeholder (a service never deployed) is skipped.
- **deploy — RATIFIED compose-from-family-latest semantics** (deliberately
  different from v1's action, which *copied the service's live revision*):

  1. For each matching service, read its current task def **only to learn the
     family**, then `DescribeTaskDefinition` on the **bare family name** to get
     the family's **latest** revision — **Terraform's template**. (Terraform owns
     the task-definition shape; the aws/ecs/app module registers new revisions,
     and the deploy always builds on the newest one.)
  2. Compose a new registration from that template: strip the read-only fields,
     swap **only** the app container's `image` to the given digest and refresh
     its RUNTIME `secrets` from SSM (`/ecs/<project>/<nick>/`). Sidecars (nginx,
     fluentbit, …) pass through untouched.
  3. `RegisterTaskDefinition` → update **every** matching service to the new
     revision.
  4. Re-point EventBridge scheduled tasks: for each target under an
     `ecstask-<project>-<nick>` rule, compose from *its* family's latest revision
     the same way and `PutTargets`.

  **Why family-latest, not the live revision:** the aws/ecs/app module change
  (separate PR) owns the template. If the deploy copied the running revision it
  would freeze whatever the *previous* deploy composed and silently drop any
  Terraform-side changes (new sidecar, cpu/memory, log config). Composing from
  the family's latest revision means every deploy picks up the current template
  and changes only the one thing a deploy is allowed to change: the app image
  (and its runtime secrets).

- **app-container identification**: the `scratch` placeholder, or the container
  whose image **repo segment equals the project name** — using `parseImageRef`
  so digest refs (`…@sha256:…`) and multi-segment hosts parse correctly. (v1's
  `image.split(':')` / substring `indexOf` mis-parsed digest refs and could match
  `app` against a repo named `app-web`.)
- **digest invariant**: `deploy-ecs` calls `assertDigestRef(image)` up front, so
  a tag ref fails before any AWS call — same as the Cloud Run module.
- **transient-failure tolerance**: every ECR/ECS/EventBridge client is built with
  v1's retry config (`maxAttempts: 5`, standard mode), now policy for all v2
  remote calls after the pilot 503.

## Action: tag-image

Provider-agnostic **release tagging**. Adds a tag (e.g. `release-10038`) to an
already-pushed digest **without rebuilding or re-pushing layers** — the v2
replacement for promote's `gcloud artifacts docker tags add` CLI step.

| Input              | Required | Default               | Description                                      |
| ------------------ | -------- | --------------------- | ------------------------------------------------ |
| `type`             | yes      | —                     | `ecs` \| `lambda` \| `cloudrun`                 |
| `project-name`     | yes      | —                     | project name (shared-registry repo/image)        |
| `digest`           | yes      | —                     | the digest to tag, bare `sha256:...`             |
| `tag`              | yes      | —                     | tag to add, e.g. `release-10038`                 |
| `registry-project` | no       | `cru-shared-artifacts`| cloudrun only — GCP project of the registry      |

| Output  | Description                              |
| ------- | ---------------------------------------- |
| `image` | full digest reference that was tagged    |
| `tag`   | the tag that was applied                 |

- **cloudrun**: creates (or moves, idempotently) the tag via the Artifact
  Registry REST `tags` API — a Docker version's ID *is* its digest, and the
  package is the project name.
- **ecs / lambda**: re-tags the ECR manifest — `BatchGetImage` for the digest's
  manifest, then `PutImage` under the new tag (idempotent: an
  `ImageAlreadyExistsException` for the same tag+digest is treated as success).

## Multi-provider routing (D9 pattern, job level)

`deploy-candidate`, `promote`, and `rollback` are **routers**: a first `lookup`
job does the app-info fetch(es) (`curl | jq`) and outputs `provider`
(`gcp`/`aws`), `type` (from app-info's `Type`), and the per-env project-id(s);
then provider-specific jobs are gated on `needs.lookup.outputs.provider`. Only
one provider job runs per app (an app is one provider).

```
promote:
  lookup ─┬─(provider==gcp)→ promote-gcp   # WIF auth, cloudrun resolve→deploy→tag-image(cloudrun)→dora
          └─(provider==aws)→ promote-aws   # configure-aws-credentials, ecs resolve→deploy→tag-image(ecs)→dora
```

- **GCP jobs keep today's flow exactly** — WIF auth as the env `cru-deploy` SA,
  `resolve-image`/`deploy` with `type: cloudrun` and `runtime-project` — with one
  change: the `gcloud` release-tag step is replaced by `actions/tag-image`.
- **AWS jobs** `configure-aws-credentials@v6` assuming
  `arn:aws:iam::056154071827:role/GitHubDeployECS` (region `us-east-1`), then the
  same `resolve → deploy → tag-image → dora` sequence with `type` from app-info.
  The rc + prod ECS clusters share the cruds account, so — unlike GCP's per-env
  SA re-auth — one credential covers the whole promote. A guard step fails
  clearly for AWS types not yet supported (`lambda`, `serverless`).
- **Authorization** (promote/rollback) runs in the `lookup` job, which every
  provider job `needs`, so it **always** passes before any provider job mutates
  production — provider-agnostic by construction.
- **Concurrency locks** (`production-<project>`, `release-candidate-<project>`,
  `cancel-in-progress: false`) live on each provider job. Both providers declare
  the same group, and only one ever runs, so whichever runs holds the lock;
  promote and rollback still **share** `production-<project>`.
- **build-candidate** routes the same way (a `setup` job then per-`type` build
  jobs); the ECS build job mirrors the Cloud Run one (no-change guard via
  `resolve-image sha-<sha>`, `build-number`, buildx, `./build.sh` pushing
  `<ecr>/<project>:candidate-<n>` and `:sha-<sha>`, BUILD-secrets gated behind
  `build-secrets`). Lambda stays a stub.

# Pass 2: reusable workflows

Pass 2 wires the Pass 1 actions into four `workflow_call` reusable workflows and
one small `dispatch` action. The workflows live in this repo
(`CruGlobal/.github`); pilot apps and the `cru-deploy` control repo call them
(see the Pass 3 sketch at the end).

Every workflow takes a `workflow-ref` input (default `main`) and checks
`CruGlobal/.github` out into `cru-github-actions/` at that ref, so the actions it
uses are version-matched to the caller — the same pattern as the v1 workflows.

## Cross-cutting conventions (Pass 2)

### app-info lookup + environment-name translation

Per-app runtime metadata comes from the v1 info service:

```
GET https://93sm7cu7ne.execute-api.us-east-1.amazonaws.com/prod/info?project=<project-name>&environment=<legacy-env>
```

The response JSON includes `Provider` (cloud, e.g. `gcp`) and `ProjectId` (the
app's per-env GCP project ID). Each workflow that needs it inlines a small
`curl | jq` step. Two rules:

- **The service knows only legacy environment names.** Translate the v2 long
  name before calling:

  | v2 long name        | legacy name sent to info service |
  | ------------------- | -------------------------------- |
  | `release-candidate` | `staging`                        |
  | `production`        | `production`                     |
  | `preview`           | `lab`                            |

- **cloudrun only in this pass.** If `Provider != "gcp"` the step fails with
  *"only cloudrun apps are supported in this v2 pass"*.

`ProjectId` is used two ways: as the `runtime-project` input to
`resolve-image`/`deploy`, and to build the deploy identity
`cru-deploy@<ProjectId>.iam.gserviceaccount.com`.

`build-candidate` does **not** hit the info service — it is prod-bound and reads
the env-scoped `vars.GCP_*` directly (see "Candidate builds are prod-bound").

### Release numbering

`release-<n>` **reuses the promoted candidate's build number**. Promote reads
the `candidate-<n>` tag off the digest currently running in release-candidate and
adds `release-<n>` to that same digest — there is no separate release counter, so
releases are monotonic and traceable back to their candidate for free.

**Failure mode:** promote FAILS with a clear message if the running
release-candidate image carries no `candidate-*` tag (e.g. it was deployed by
something other than `deploy-candidate`). Deploy a candidate first.

### Datadog / telemetry (post-incident policy)

Telemetry must never fail a deploy. Every Datadog step uses:

- pinned `npx @datadog/datadog-ci@5`,
- `continue-on-error: true` on the step,
- `--no-fail` on `tag` commands,
- `dora deployment` marks with `--skip-git`, `--env` set to the **v2 long**
  environment name, and `--custom-tags "rollback:true"` on rollbacks.

### Concurrency locks

| Workflow(s)          | Group                              | `cancel-in-progress` |
| -------------------- | ---------------------------------- | -------------------- |
| `promote`, `rollback`| `production-<project-name>`        | `false`              |
| `deploy-candidate`   | `release-candidate-<project-name>` | `false`              |

Promote and rollback **share** the `production-<project-name>` group, so only one
production mutation per app runs at a time and it is never cancelled mid-flight.

### Authorization (promote + rollback only)

The first step of `promote` and `rollback` verifies the human:

```
gh api repos/CruGlobal/<project-name>/collaborators/${{ github.actor }}/permission
```

using the required `authz-token` `workflow_call` secret. Permission
`admin`, `write`, or `maintain` passes; anything else fails with a message naming
the actor and the app repo. `deploy-candidate` has **no** authz gate — the path
to release-candidate is automated by design.

> **TODO: replace PAT with a dedicated GitHub App.** The pilot uses a PAT
> (`CRU_DEVOPS_GITHUB_TOKEN`) as the `authz-token`; the collaborator-permission
> read should move to a dedicated GitHub App.

## Workflow: `build-candidate`

Builds an env-neutral image once from the triggering commit and pushes it to the
shared registry as `candidate-<n>` and `sha-<gitsha>`. Nothing is deployed.

- **Router:** a `setup` job resolves the project name and validates `type`; a
  per-runtime build job runs on the matching `type`. Only `cloudrun` is
  implemented (`ecs`/`lambda` jobs fail with *"…land in a later v2 pass"*).
- **No-change guard:** the cloudrun job first resolves `sha-<gitsha>` with
  `resolve-image` (`continue-on-error`). If it resolves, the existing
  `candidate-<n>` is reused and every build step is skipped; otherwise the guard
  "fails" and the build proceeds.
- **Output coalescing:** job outputs pick the reuse-path step outputs *or* the
  build-path step outputs with `||` (a skipped step's output is empty, so `||`
  selects whichever path ran); the workflow outputs coalesce across the three
  runtime jobs the same way.

| Input          | Required | Default     | Description                                   |
| -------------- | -------- | ----------- | --------------------------------------------- |
| `workflow-ref` | no       | `main`      | ref of `CruGlobal/.github` to check out       |
| `type`         | yes      | —           | `ecs` \| `lambda` \| `cloudrun`               |
| `project-name` | no       | *repo name* | shared-registry repo/image name               |

| Output         | Description                                   |
| -------------- | --------------------------------------------- |
| `project-name` | resolved project name                         |
| `build-number` | candidate build number `<n>`                  |
| `candidate`    | candidate tag (`candidate-<n>`)               |
| `image`        | full digest reference of the candidate        |
| `digest`       | `sha256:...` digest                           |

## Workflow: `deploy-candidate`

Deploys a candidate artifact to `release-candidate`. No authz gate.

| Input          | Required | Default | Description                          |
| -------------- | -------- | ------- | ------------------------------------ |
| `workflow-ref` | no       | `main`  | ref of `CruGlobal/.github`           |
| `project-name` | yes      | —       | project name                         |
| `tag`          | yes      | —       | candidate tag, e.g. `candidate-10012`|

| Secret           | Required | Description     |
| ---------------- | -------- | --------------- |
| `datadog-api-key`| yes      | DataDog API key |

Flow: app-info (`release-candidate`) → Datadog pipeline tag → GCP auth as the
release-candidate `cru-deploy` SA → `resolve-image` (mode `tag`) → `deploy`
(cloudrun, `release-candidate`) → `dora deployment` (env `release-candidate`).

## Workflow: `promote`

Promotes the release-candidate artifact to production (production lock).

| Input          | Required | Default | Description                |
| -------------- | -------- | ------- | -------------------------- |
| `workflow-ref` | no       | `main`  | ref of `CruGlobal/.github` |
| `project-name` | yes      | —       | project name               |

| Secret           | Required | Description                                 |
| ---------------- | -------- | ------------------------------------------- |
| `datadog-api-key`| yes      | DataDog API key                             |
| `authz-token`    | yes      | token for the collaborator-permission check |

Flow: authz → app-info for **both** `release-candidate` and `production` (two
`ProjectId`s) → GCP auth as the **rc** `cru-deploy` SA → `resolve-image` (mode
`environment`, capture digest + its `candidate-<n>`, fail if absent) → re-auth as
the **prod** `cru-deploy` SA → `deploy` (cloudrun, `production`) →
`gcloud artifacts docker tags add <image_base>@<digest> <image_base>:release-<n>`
→ `dora deployment` (env `production`, version `release-<n>`).

### Releases are permanent

Every promote creates a **permanent rollback target**: `release-*` tags are kept
forever and are never expired or deleted. The shared-registry module's KEEP
cleanup policy on `release-*` enforces this, so `rollback` can always resolve any
previously promoted release.

## Workflow: `rollback`

Redeploys a previously promoted release to production (production lock).

| Input          | Required | Default | Description                              |
| -------------- | -------- | ------- | ---------------------------------------- |
| `workflow-ref` | no       | `main`  | ref of `CruGlobal/.github`               |
| `project-name` | yes      | —       | project name                             |
| `release`      | yes      | —       | `release-10012` **or** bare `10012`      |

| Secret           | Required | Description                                 |
| ---------------- | -------- | ------------------------------------------- |
| `datadog-api-key`| yes      | DataDog API key                             |
| `authz-token`    | yes      | token for the collaborator-permission check |

Flow: authz → app-info (`production`) → normalize `release` to `release-<n>` →
GCP auth as the prod `cru-deploy` SA → `resolve-image` (mode `tag`) → `deploy`
(cloudrun, `production`) → `dora deployment` with `--custom-tags "rollback:true"`.

> Automatic "previous release" selection (roll back to `release-<n-1>` without
> naming it) lands in a later v2 pass; for now the target release is explicit.

## Action: `dispatch`

Generic cross-repo `workflow_dispatch` trigger — the v2 replacement for v1's
`trigger-deploy` action and its hardcoded deploy-type→workflow map. The caller
names the repo, workflow file, ref, and a JSON inputs payload.

| Input          | Required | Default               | Description                          |
| -------------- | -------- | --------------------- | ------------------------------------ |
| `github-token` | yes      | —                     | token authorized to dispatch         |
| `repo`         | no       | `CruGlobal/cru-deploy`| target `owner/name`                  |
| `workflow`     | yes      | —                     | workflow file, e.g. `promote.yml`    |
| `ref`          | no       | `main`                | target repo ref                      |
| `inputs-json`  | no       | `{}`                  | JSON object of workflow inputs       |

`inputs-json` must parse to a JSON object (never an array/scalar); a blank value
means no inputs. The action emits a `core.notice` linking to the target repo's
actions page.

## Grants matrix (new permissions Pass 2 depends on)

| Identity                                     | Needs                                          | Why                                            |
| -------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| app **prod** build SA (`github-actions@<prod-project>`) | **AR writer** on the app's `cru-shared-artifacts/<app>` repo | `build-candidate` pushes `candidate-*`/`sha-*` |
| each env's `cru-deploy@<env-project>` SA     | **AR reader** on `cru-shared-artifacts/<app>`  | `resolve-image` reads tags/digests             |
| **prod** `cru-deploy@<prod-project>` SA      | **AR writer** on `cru-shared-artifacts/<app>`  | `promote` adds the `release-<n>` tag           |
| `cru-deploy` control repo                    | `authz-token` secret (pilot: `CRU_DEVOPS_GITHUB_TOKEN`) | promote/rollback collaborator-permission check |
| `cru-deploy` control repo                    | `vars.GCP_WORKLOAD_IDENTITY_PROVIDER` + WIF trust so each env's `cru-deploy` SA is impersonable | GCP auth in deploy-candidate/promote/rollback |

Plain `roles/artifactregistry.writer` (tag create) suffices for the prod
`cru-deploy` SA — releases are permanent, so no `tags.delete` / `repoAdmin` grant
is needed.

### Grants matrix additions (ECS / AWS)

| Identity                                      | Needs                                                                          | Why                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| app **prod** ECS build role (`<project>-prod-GitHubRole`) | ECR **push** on the app's ECR repo + DynamoDB `UpdateItem` on `ECSBuildNumbers` | `build-candidate` (ECS) pushes `candidate-*`/`sha-*` and increments the build counter |
| `GitHubDeployECS` (`arn:aws:iam::056154071827:role/GitHubDeployECS`) | ECS deploy (`ecs:*TaskDefinition`, `ecs:UpdateService`), EventBridge (`events:*Targets`), SSM read, ECR `DescribeImages`/`BatchGetImage` | AWS `deploy-candidate`/`promote`/`rollback` resolve + deploy |
| `GitHubDeployECS`                              | **`ecr:PutImage`** on each app's ECR repo                                       | `promote` (ECS) stamps `release-<n>` via the tag-image manifest re-tag |

> **Terraform follow-ups (aws/ecs/app module, separate PR):**
> 1. Add a dedicated **`<project>-<env>-GitHubRole`** for builds and **remove
>    GitHub trust from `TaskRole`** — ending v1's dual-purpose role. Candidates
>    are prod-bound, so the ECS build identity is `<project>-prod-GitHubRole`.
> 2. Add **`ecr:PutImage`** to `GitHubDeployECS` — without it the `promote` ECS
>    release-tag step (`actions/tag-image`) fails. `BatchGetImage` +
>    `DescribeImages` are read-side and typically already granted.

## Pass 3 sketch: `cru-deploy` wrapper workflows

Pass 3 adds thin wrappers in `CruGlobal/cru-deploy` that call these reusable
workflows (and wires a pilot app, "hoax", to `build-candidate` +
`dispatch`). Sketches:

```yaml
# cru-deploy/.github/workflows/deploy-candidate.yml
name: Deploy Candidate
on:
  workflow_dispatch:
    inputs:
      project-name: { required: true, type: string }
      tag: { required: true, type: string }
jobs:
  deploy-candidate:
    uses: CruGlobal/.github/.github/workflows/deploy-candidate.yml@main
    permissions: { id-token: write, contents: read }
    with:
      project-name: ${{ inputs.project-name }}
      tag: ${{ inputs.tag }}
    secrets:
      datadog-api-key: ${{ secrets.DATADOG_API_KEY }}
```

```yaml
# cru-deploy/.github/workflows/promote.yml
name: Promote
on:
  workflow_dispatch:
    inputs:
      project-name: { required: true, type: string }
jobs:
  promote:
    uses: CruGlobal/.github/.github/workflows/promote.yml@main
    permissions: { id-token: write, contents: read }
    with:
      project-name: ${{ inputs.project-name }}
    secrets:
      datadog-api-key: ${{ secrets.DATADOG_API_KEY }}
      authz-token: ${{ secrets.CRU_DEVOPS_GITHUB_TOKEN }}
```

```yaml
# cru-deploy/.github/workflows/rollback.yml
name: Rollback
on:
  workflow_dispatch:
    inputs:
      project-name: { required: true, type: string }
      release: { required: true, type: string }
jobs:
  rollback:
    uses: CruGlobal/.github/.github/workflows/rollback.yml@main
    permissions: { id-token: write, contents: read }
    with:
      project-name: ${{ inputs.project-name }}
      release: ${{ inputs.release }}
    secrets:
      datadog-api-key: ${{ secrets.DATADOG_API_KEY }}
      authz-token: ${{ secrets.CRU_DEVOPS_GITHUB_TOKEN }}
```

An app builds candidates and hands off to `cru-deploy` via `dispatch`:

```yaml
# <app>/.github/workflows/build.yml  (on push to main)
jobs:
  build:
    uses: CruGlobal/.github/.github/workflows/build-candidate.yml@main
    permissions: { id-token: write, contents: read }
    with: { type: cloudrun }
  handoff:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { repository: CruGlobal/.github, path: cru-github-actions }
      - uses: ./cru-github-actions/actions/dispatch
        with:
          github-token: ${{ secrets.CRU_DEVOPS_GITHUB_TOKEN }}
          workflow: deploy-candidate.yml
          inputs-json: >-
            {"project-name": "${{ needs.build.outputs.project-name }}",
             "tag": "${{ needs.build.outputs.candidate }}"}
```

## Flagged decisions

1. **Candidate builds are prod-bound.** Candidate images authenticate with the
   app's *production*-env `github-actions` service account (the
   `gcp/cloudrun/app` module change will grant that SA `writer` on the app's
   shared-registry repo). A candidate is therefore built with prod-bound
   credentials.
2. **Promote authorization uses `CRU_DEVOPS_GITHUB_TOKEN` for the pilot.** The
   promote step's authorization check (the actor must have `push` on the app
   repo) will use `CRU_DEVOPS_GITHUB_TOKEN` for the pilot. **TODO:** move to a
   dedicated GitHub App.

## Pilot finding (2026-07-21): BUILD secrets gated pending D2 provisioning

The first hoax candidate build failed at `Import build secrets`: the
`cru-shared-artifacts` project does not have the Secret Manager API enabled,
and — the deeper issue — the shared BUILD-secrets store isn't designed yet for
multi-app use: the `gcp-secrets` action filters only by `param_type`, so in a
shared project it would import every app's BUILD secrets, and build SAs would
need cross-app Secret Manager read. Until the D2 store lands (API enablement,
per-app label filtering in `gcp-secrets`, scoped IAM), `build-candidate.yml`
gates the step behind a `build-secrets` input (default `false`). Consequence:
apps that need BUILD-type secrets cannot migrate to v2 until D2 ships; apps
without them (hoax) are unaffected.
