# Pipeline v2

Pipeline v2 is a clean-break rebuild of CruGlobal's shared build/deploy pipeline
around **build once, promote the artifact**. An env-neutral image is built a
single time from `main`, pushed to a shared registry, and every environment then
deploys *that exact artifact* — pinned by digest — rather than rebuilding per
environment.

This document covers:

- **Pass 1** — the `resolve-image` and `deploy` actions (Cloud Run, ECS, and
  Lambda all implemented).
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

| Tag                       | When       | Purpose                             |
| ------------------------- | ---------- | ----------------------------------- |
| `candidate-<date>-<n>`    | at build   | env-neutral build of `main`         |
| `sha-<gitsha>`            | at build   | git traceability                    |
| `release-<date>-<n>`      | at promote | promoted release / rollback target  |

`<date>` is the **build** date (`yyyy-mm-dd`, UTC), stamped once when the
candidate is built (D10): humans get age-at-a-glance in tag listings, dispatch
inputs, and Slack, while `<n>` (the build number) remains the unique key.
Promote reuses the candidate's full suffix, so a release always shares its
candidate's name. Legacy pre-D10 tags (`candidate-<n>` / `release-<n>`) remain
resolvable everywhere; new builds always carry the date.

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
| `tag`             | when `mode=tag`                | e.g. `candidate-2026-07-23-10056`, `release-2026-07-20-10041` — resolved against the shared registry  |
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

### `DD_VERSION`: baked at build, never injected at deploy

Digest-pinned deploys otherwise leave Datadog's version telemetry stale. The
answer is a **build-arg**: every candidate build passes
`--build-arg VERSION=<yyyy-mm-dd>-<n>` (the tag family's bare suffix — identical
for the candidate and its future release under D10's full-suffix reuse). Apps opt
in with two Dockerfile lines, placed at the END of the Dockerfile so they cost no
build cache:

```dockerfile
ARG VERSION="dev"
ENV DD_VERSION=${VERSION}
```

Why baked instead of deploy-time injection (the original design, reverted):

- **One true version per build, in every environment.** Injection reported
  `candidate-X` on release-candidate and `release-X` in production — a "version
  change" on promote when the bytes never changed. The baked suffix is the build's
  identity, like the `sha-` tag.
- **Zero Terraform drift, all three runtimes.** Image ENV is invisible to
  Terraform's env management. Deploy-time injection was only drift-safe on ECS
  (task_definition wholly ignored); on Cloud Run the app container's env is
  Terraform-managed (`ignore_changes` covers the image only), and on Lambda the
  function env is Terraform-owned tenant config — injection would flap or fight.
  Function-config env overlays image ENV per-name, and nothing sets `DD_VERSION`
  there, so the baked value shines through everywhere — **including Lambda**.
- **Graceful degradation.** An app without the `ARG` just logs an unused
  build-arg warning and has no `DD_VERSION`, exactly as today.
- The no-change guard composes correctly: a reused candidate keeps its original
  baked version — which is that artifact's identity.

The deployment **events** (and ledger rows) continue to carry the full revision
tag (`candidate-*` / `release-*`) per event — the deploy-time record of *what was
deployed where*; `DD_VERSION` is the runtime record of *what is running*.


## Implemented vs stubbed

| Runtime  | resolve-image | deploy      | build-candidate |
| -------- | ------------- | ----------- | --------------- |
| cloudrun | implemented   | implemented | implemented     |
| ecs      | implemented   | implemented | implemented     |
| lambda   | implemented   | implemented | implemented     |

Both actions use a router that dispatches on `type`. All three runtimes are now
implemented against the same `{ image, digest, tags }` / `{ deployedImage,
services }` contracts.

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
- **transient-failure tolerance**: the AWS SDK clients already retry
  (`maxAttempts: 5`); the Artifact Registry **REST** calls did not, and a
  transient AR 503 failed a pilot rollback at the resolve step (pre-mutation — the
  rerun succeeded). All three `client.request` sites in `src/v2/gcp.js`
  (`listDockerImages` pagination + the tag create/move POST/PATCH) now pass gaxios
  retry options (`retry: true`, 5 attempts, 500ms base, `GET`/`POST` on `429` and
  any `5xx`). google-auth-library's `client.request` wraps gaxios and passes these
  through. The POST tag-create retry is safe: an `alreadyExists` on a retried
  create is already treated as success (`addTag`'s 409 → move handler).

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
- **deploy — pre-deploy database migrations (before any service is touched):**
  first, `DescribeTaskDefinition` on the convention family
  `<project>-<nick>-db-migrate`. Presence of that family (created by the
  aws/ecs/app module only when the app opts into `database_migrations`) is the
  switch — no family (the SDK throws `ClientException`) means the app hasn't opted
  in, so the phase logs and is skipped. When present, the deploy composes a
  revision from the family's latest (release digest + refreshed RUNTIME secrets,
  identical to the service path), then **runs it to completion** via `RunTask`
  (count 1, `startedBy: cru-pipeline-v2`) and `waitUntilTasksStopped` (900s). The
  migration's **run configuration is borrowed from the app's own infrastructure**
  — the first matching service's `networkConfiguration` + launch type /
  capacity-provider strategy, or, for a jobs-only app, the EventBridge
  scheduled-task target's network configuration (its PascalCase awsvpc keys are
  converted to RunTask's camelCase); if neither exists the deploy throws rather
  than guess. After the task stops, the `db-migrate` container's **exit code must
  be 0** — a nonzero exit, a `stopCode`/`stoppedReason` failure, or a wait timeout
  **throws and fails the deploy**. Because this runs **before** `updateServices`,
  a failed migration leaves the running services **completely untouched**. This
  mirrors the Cloud Run `db-migrate` job exactly.

  This phase runs for **every** ECS deploy — rc deploys, promote, and rollback —
  since `deployEcs` is shared. That is intended: migrations are applied **once per
  deploy** (the old sidecar re-ran them on every task launch/scale-up), and a
  rollback's older image simply **no-ops against already-applied migrations**,
  matching Cloud Run.

  **Why pre-deploy, not a sidecar (retired):** the previous ECS model ran
  migrations as a `db-migrate` sidecar container the app container `dependsOn`'d.
  That dependency used `condition = "START"` with `essential = false`, which is
  **verified broken**: `START` only waits for the migrate container to *start*
  (not finish), so the app raced the migration and could serve against the
  un-migrated schema, and because the sidecar was non-essential a **failed
  migration did not block the app or the deploy**. Making the migration a discrete
  pre-deploy task that must finish cleanly first closes both holes: completion is
  gated, and failure fails the deploy.

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

### Lambda implementation notes

Lambda shares the ECS action contracts and the same org-shared ECR registry /
per-app repo (keyed on the **project name**). Like ECS it takes **no
`runtime-project`** — everything derives from the env nickname + naming
conventions (functions are named `<project>-<nick>*`, resolved via v1's
`lambdaListFunctionNames` prefix filter). All functions are **image (container)**
functions.

- **tag -> digest**: identical to ECS — ECR `DescribeImages` by `imageTag`
  returns the `imageDigest` plus every tag on it; the full ref is
  `056154071827.dkr.ecr.us-east-1.amazonaws.com/<project>@<digest>`.
- **environment -> digest**: lists the app's `<project>-<nick>*` functions,
  `GetFunction`s each, and returns the first that is an **Image** function whose
  `Code.ResolvedImageUri` is in the app's ECR repo. A function's
  `ResolvedImageUri` is **always a digest ref**, so — unlike ECS — there is no
  tag-ref branch to resolve. Functions still on the shared **`scratch`**
  placeholder (`<registry>/scratch@…`) have never been deployed and are skipped
  (the same skip ECS applies to its `scratch` placeholder).
- **deploy — v1's RATIFIED selection semantics**: update **every**
  `<project>-<nick>*` function that is an Image function AND whose currently
  resolved image is either the app's ECR repo **OR** the shared `scratch` repo,
  calling `UpdateFunctionCode` with the digest-pinned `image`. Non-image /
  other-repo functions are logged and skipped. The **scratch match is
  load-bearing**: Terraform (aws/lambda/app module) boots NEW functions on
  `scratch:latest`, and the deploy is what flips them to the real image on their
  first deploy. Prod may run several functions (e.g. one per tenant); all are
  updated to the same digest.
- **deploy waits for completion (v2 hardening over v1)**: `UpdateFunctionCode` is
  **async** — it returns before the new image is live (`LastUpdateStatus:
  InProgress`). v2 therefore blocks on `waitUntilFunctionUpdatedV2` (max ~300s
  per function, `LastUpdateStatus: Failed` → error) after each update. The pilot
  hit a read-back race where promote/rollback verified the running digest before
  the function had actually switched images; deploy must not return until every
  function runs the new image. (v1 slept 5s between updates instead; the wait
  subsumes that spacing.)
- **digest invariant**: `deploy-lambda` calls `assertDigestRef(image)` up front,
  so a tag ref fails before any AWS call — same as ECS / Cloud Run.
- **the wait helper** (`lambdaWaitForFunctionUpdated`, `src/aws.js`) is built with
  the same `maxAttempts: 5` retry config as the other Lambda helpers.

**Dry-run release-candidate gate (tenant-target apps).** The Lambda pilot
(`okta-api-keypalive`) uses release-candidate as a **`DRY_RUN=true` surface**: the
rc function runs the candidate image on its normal cron with side effects
disabled, so a bad candidate is caught before it can touch tenants. Promote then
ships **that exact digest** to the production functions (which run for real).
`DRY_RUN` is a per-env function env var owned by Terraform (aws/lambda/app), not
baked into the image — the candidate is env-neutral and the same digest runs in
both environments. This is the recommended pattern for any app whose production
functions fan out to multiple tenants: candidate → dry-run rc on cron → promote
the same digest to prod.

## Action: tag-image

Provider-agnostic **release tagging**. Adds a tag (e.g. `release-2026-07-20-10038`) to an
already-pushed digest **without rebuilding or re-pushing layers** — the v2
replacement for promote's `gcloud artifacts docker tags add` CLI step.

| Input              | Required | Default               | Description                                      |
| ------------------ | -------- | --------------------- | ------------------------------------------------ |
| `type`             | yes      | —                     | `ecs` \| `lambda` \| `cloudrun`                 |
| `project-name`     | yes      | —                     | project name (shared-registry repo/image)        |
| `digest`           | yes      | —                     | the digest to tag, bare `sha256:...`             |
| `tag`              | yes      | —                     | tag to add, e.g. `release-2026-07-20-10038`                 |
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
          └─(provider==aws)→ promote-aws   # configure-aws-credentials (ECS/Lambda role), resolve→deploy→tag-image→event
```

- **GCP jobs keep today's flow exactly** — WIF auth as the env `cru-deploy` SA,
  `resolve-image`/`deploy` with `type: cloudrun` and `runtime-project` — with one
  change: the `gcloud` release-tag step is replaced by `actions/tag-image`.
- **AWS jobs** `configure-aws-credentials@v6` assuming a **type-keyed** deploy
  role (region `us-east-1`): `arn:aws:iam::056154071827:role/GitHubDeployLambda`
  for `type == lambda`, else `…/GitHubDeployECS`. Both are cru-deploy-scoped and
  live in the cruds account. Then the same `resolve → deploy → tag-image → event`
  sequence with `type` from app-info. The rc + prod ECS clusters / Lambda
  functions share the cruds account, so — unlike GCP's per-env SA re-auth — one
  credential covers the whole promote. A guard step accepts `ecs` and `lambda`
  and fails clearly for AWS types not yet supported (`serverless`). `tag-image`
  routes `ecs` and `lambda` down the same ECR manifest re-tag path, so the
  release-tag step needs `ecr:PutImage` on whichever deploy role was assumed.
- **Authorization** (promote/rollback) runs in the `lookup` job, which every
  provider job `needs`, so it **always** passes before any provider job mutates
  production — provider-agnostic by construction.
- **Concurrency locks** (`production-<project>`, `release-candidate-<project>`,
  `cancel-in-progress: false`) live on each provider job. Both providers declare
  the same group, and only one ever runs, so whichever runs holds the lock;
  promote and rollback still **share** `production-<project>`.
- **build-candidate** routes the same way (a `setup` job then per-`type` build
  jobs); the ECS and Lambda build jobs mirror the Cloud Run one (no-change guard
  via `resolve-image sha-<sha>`, `build-number`, buildx, `./build.sh` pushing
  `<ecr>/<project>:candidate-<date>-<n>` and `:sha-<sha>`, `BUILD_*` repo secrets
  exported). The Lambda job carries two deliberate differences from ECS —
  see "Lambda candidate build differences" below.

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

Per-app runtime metadata comes from the `CruApplicationInfo` DynamoDB table
(`Project` hash key, `Environment` range key; defined in cru-terraform's
`aws/lambda/cru-app-info`), read **directly**:

```
aws dynamodb get-item --table-name CruApplicationInfo \
  --key '{"Project": {"S": "<project-name>"}, "Environment": {"S": "<legacy-env>"}}'
```

Deliberately **not** the `GET /info` endpoint of the cru-app-info API that sits
in front of the same table: that API is being extracted into an application
deployed by this very pipeline, so depending on it at deploy time would make
every deploy — including the one that fixes a broken cru-app-info — contingent
on it being up. A `GetItem` has no such cycle.

The attributes the pipeline reads, all written by the app's Terraform module
(`gcp/cloudrun/app`, `aws/ecs/app`, `aws/lambda/app`):

| attribute        | set by                 | used for                                                        |
| ---------------- | ---------------------- | --------------------------------------------------------------- |
| `Provider`       | the module (cloud)     | provider fan-out; `gcp` or `aws`, anything else fails the lookup  |
| `Type`           | the module             | AWS routing: `ecs` or `lambda`                                    |
| `ProjectId`      | the module             | `runtime-project` + the deploy identity (GCP)                     |
| `SlackChannel`   | `slack_channel`        | notification destination; presence is the enable switch           |
| `MigrationsPath` | `database_migrations`  | rollback-safety classification at promote                         |
| `Migrations`     | the module             | `none` declares the app has NO migrations ⇒ promote reports safe   |
| `AppUrl`         | `app_url` (or derived) | links the environment name in Slack messages; absent ⇒ plain text |

Each workflow that needs it inlines a small
`get-item | jq` step (jq reads the DynamoDB-typed shape, `.Item.Provider.S`),
and the job carries `permissions: id-token: write` plus a
`configure-aws-credentials` step assuming `GitHubDeployECS` — the same role for
every provider, since the lookup runs before the provider fan-out and the role's
trust is cru-deploy-repo-scoped. A missing row fails the job. Two rules:

- **The table is keyed by legacy environment names.** Translate the v2 long
  name before reading:

  | v2 long name        | legacy name used as the range key |
  | ------------------- | --------------------------------- |
  | `release-candidate` | `staging`                         |
  | `production`        | `production`                      |
  | `preview`           | `lab`                             |

- **`gcp` and `aws` providers.** The lookup step fails for any other
  `Provider`. AWS apps route by `Type`: `ecs` and `lambda` are supported;
  the provider job's "Guard supported AWS type" step fails clearly for
  anything else (`serverless`).

`ProjectId` is used two ways: as the `runtime-project` input to
`resolve-image`/`deploy`, and to build the deploy identity
`cru-deploy@<ProjectId>.iam.gserviceaccount.com`.

`build-candidate` does **not** hit the info service — it is prod-bound and reads
the env-scoped `vars.GCP_*` directly (see "Candidate builds are prod-bound").

### Release naming

`release-<date>-<n>` **reuses the promoted candidate's full suffix** (build
date + build number). Promote reads the `candidate-*` tag off the digest
currently running in release-candidate and adds the matching `release-*` tag to
that same digest — there is no separate release counter, so releases are
monotonic and traceable back to their candidate for free. (A legacy pre-D10
candidate yields a matching legacy `release-<n>`.)

**Failure mode:** promote FAILS with a clear message if the running
release-candidate image carries no `candidate-*` tag (e.g. it was deployed by
something other than `deploy-candidate`). Deploy a candidate first.

### Datadog / telemetry (post-incident policy)

Telemetry must never fail a deploy. Every Datadog step uses:

- pinned `npx @datadog/datadog-ci@5`,
- `continue-on-error: true` on the step (the belt),
- `--no-fail` on `tag` commands,
- a trailing `|| echo "::warning title=Datadog telemetry failed::… (non-blocking)"`
  (the suspenders): `continue-on-error` **swallows** a failed post silently, so
  every Datadog step also appends a `::warning` annotation so a failure is
  **visible** on the run summary instead of vanishing. For the multi-line
  `jq | curl` event posts the warning fires if **any** part of the pipeline fails
  (the runner shell runs with `pipefail`).

Deployment telemetry itself is a structured **Events API** post (see the
self-owned-telemetry decision below), not a `dora deployment` mark.

### Slack notifications

Each pipeline step that changes what is running posts a Slack message to the
app's own destination — and so does each one that tried and **failed**.

- **Config source: `SlackChannel` in app-info, per env.** The same
  `get-item | jq` lookup that reads `Provider`/`ProjectId` also extracts
  `SlackChannel` (`jq -r '.SlackChannel.S // empty'`) and exposes it as the
  `lookup` job's `slack-channel` output. **Presence is the enable switch** —
  set a value and the app opts in; leave it unset and every notify step
  no-ops silently. `deploy-candidate` reads it from its single
  release-candidate lookup; `promote` and `rollback` read it from the
  **production** lookup, so production results notify the production
  destination.
- **Channel *or* user.** The value is passed straight to Slack's
  `chat.postMessage` `channel` field, which accepts a public/private channel
  (`#name` or a `C…` id) or a user (`U…`) for a bot DM.
- **Posting uses a bot token,** supplied as the optional `slack-bot-token`
  `workflow_call` secret (unset ⇒ posting disabled). The Slack app needs
  `chat:write` (post to channels it's in), `chat:write.public` (post to public
  channels without being invited), and `im:write` (open a DM for `U…`
  destinations).
- **NEVER fails a deploy.** Same policy as all telemetry: the step is
  `continue-on-error: true` and shares its siblings' skip-gating; Slack returns
  HTTP 200 with `ok: false` on errors, so success is tested by
  `jq -e '.ok'` and any failure (or a failed `curl`) surfaces as a non-blocking
  `::warning`, never a failed job.
- **Failures notify too — plainly.** Every provider job ends with a second
  `Notify Slack (failure)` step gated on `if: failure()` (plus
  `continue-on-error: true`: a notification must never change a run's outcome, in
  either direction). It exists because a failed cru-deploy run is otherwise
  invisible — the app-repo dispatch does not propagate the result, so the app
  repo stays green and only someone watching cru-deploy's Actions tab would
  notice. (Two days of failed weekend nightly deploys, notified to no one, is
  what bought this step.) The message is deliberately **minimal**: `:x:`, what
  failed, and the workflow-run URL as the whole second line — no `AppUrl` link
  (the env link celebrates something now running; a failure has nothing to go
  look at) and no changelog link. It tracks the **job's** outcome, so any red
  provider job announces itself. Every value it prints comes from a workflow
  input or the `lookup` job — never from a step that may not have run — with the
  single exception of promote's release name, which degrades to `the
  release-candidate image` when the run died before it was derived. A **no-op**
  candidate deploy does not notify: with `skip=true` the remaining steps are
  *skipped*, not failed, so `failure()` stays false (and a failed
  `continue-on-error` step never trips it either).
- **When `lookup` itself fails, nothing is posted.** `SlackChannel` is read *by*
  `lookup`, so a failure in authorization, the app-info read, or release-tag
  normalization leaves no destination to notify — accepted rather than papered
  over with a hardcoded fallback channel; the fallback for those is the
  cru-deploy Actions tab.
- **The closing line is a changelog link.** Every *success* message ends with one
  link into the deploys dashboard's changelog page rather than the raw
  workflow-run URL (failure messages invert this — see above):
  `deploys.cru.org/changelog?project=<p>&from=<ref>&to=<ref>`. Either end may be
  a pipeline revision name (`release-2026-07-26-1234`) or a raw git sha — the page
  resolves names through the deployments ledger — so the pipeline passes whichever
  it already holds, preferring the revision name:

  | message | `from` | `to` | link text |
  | ------- | ------ | ---- | --------- |
  | `deploy-candidate` | the `Sha` running in production, from a public GET on the ledger (`/deployments?project=<p>&environment=production&limit=1`) | the candidate tag being deployed | `what's in this candidate` |
  | `promote` | the production baseline the rollback-safety classifier already fetched (the previous production `Sha`) | the new `release-<…>` tag | `what's in this release` |
  | `rollback` | the release being rolled back **to** | what production was running: the newest production ledger event's `Revision` (or its `Sha` for rows that predate named revisions), from the same fetch the rollback-safety advisory makes | `what this rollback reverts` |

  **Rollback inverts `from`/`to`** deliberately: the page then shows what
  production is *losing*, which is the question a rollback raises.

  **Graceful bootstrap.** When the baseline doesn't exist — a first deploy or
  first promote, a rollback with no prior production event (or one naming the same
  release), or a failed best-effort ledger query — the closing line is simply
  omitted: no link is better than a wrong one, and the run URL is always one
  click away in the ledger row (`RunUrl`) and the Actions tab. This link
  supersedes the earlier `changes since production` GitHub compare link: one
  link per message, not three.
- **The environment name links to the running app.** Where a message names the
  environment the change landed in — `stage` in the candidate message,
  `production` in the promote and rollback messages — that word becomes a Slack
  link (`<url|stage>`) to the app's `AppUrl` from the same app-info row, and
  stays plain text when the row has no `AppUrl`. The candidate message says
  **stage**, not `release-candidate`: the word names the thing a human can go
  look at, and it matches the hostname the link points to
  (`app-stage.cru.org`). The link is built inside the `jq -n` payload
  construction, so there is no shell-quoting hazard and Slack's `<url|text>`
  angle brackets survive JSON encoding untouched.

  `AppUrl` is written by the app's Terraform module from the DNS name it already
  manages (`app_url` overrides it; `app_url = ""` suppresses it). CloudRun apps
  on the shared ALB and ECS apps with a zone get one automatically; Lambda apps
  never derive one.

Messages, with and without an `AppUrl` (`|` marks the linked span):

```
deploy-candidate  :package: *myapp `candidate-2026-07-26-1234` is on <https://myapp-stage.cru.org|stage>*
                  :package: *myapp `candidate-2026-07-26-1234` is on stage*

promote           :white_check_mark: *myapp promoted `release-2026-07-26-1234` to <https://myapp.cru.org|production>* by bzoetewey
                  :white_check_mark: *myapp promoted `release-2026-07-26-1234` to production* by bzoetewey

rollback          :rewind: *myapp rolled back to `release-2026-07-25-1233` in <https://myapp.cru.org|production>* by bzoetewey
                  :rewind: *myapp rolled back to `release-2026-07-25-1233` in production* by bzoetewey
```

The follow-on lines are the promote-dispatch link (candidate only), the
rollback-safety advisory (promote / rollback), and the closing changelog link:

```
deploy-candidate  :package: *myapp `candidate-2026-07-26-1234` is on <https://myapp-stage.cru.org|stage>*
                  Promote: <https://github.com/CruGlobal/cru-deploy/actions/workflows/promote.yml|Promote (v2) dispatch>
                  <https://deploys.cru.org/changelog?project=myapp&from=a1b2c3d&to=candidate-2026-07-26-1234|what's in this candidate>

promote           :white_check_mark: *myapp promoted `release-2026-07-26-1234` to <https://myapp.cru.org|production>* by bzoetewey
                  :shield: rollback-safe (migrations additive)
                  <https://deploys.cru.org/changelog?project=myapp&from=a1b2c3d&to=release-2026-07-26-1234|what's in this release>

rollback          :rewind: *myapp rolled back to `release-2026-07-25-1233` in <https://myapp.cru.org|production>* by bzoetewey
                  :warning: rolling back FROM a release with destructive migrations (…); this rollback does NOT revert the schema
                  <https://deploys.cru.org/changelog?project=myapp&from=release-2026-07-25-1233&to=release-2026-07-26-1234|what this rollback reverts>

bootstrap         :package: *myapp `candidate-2026-07-26-1234` is on <https://myapp-stage.cru.org|stage>*
(no baseline —    Promote: <https://github.com/CruGlobal/cru-deploy/actions/workflows/promote.yml|Promote (v2) dispatch>
 first deploy)    (no changelog line — the closing line is omitted when no baseline exists)
```

Failure messages — two lines, nothing linked except the run, whichever step died:

```
deploy-candidate  :x: *myapp `candidate-2026-07-26-1234` deploy to stage FAILED*
                  https://github.com/CruGlobal/cru-deploy/actions/runs/16428899123

promote           :x: *myapp promote `release-2026-07-26-1234` to production FAILED* by bzoetewey
                  https://github.com/CruGlobal/cru-deploy/actions/runs/16428899123

promote           :x: *myapp promote the release-candidate image to production FAILED* by bzoetewey
(died before the  https://github.com/CruGlobal/cru-deploy/actions/runs/16428899123
 release name)

rollback          :x: *myapp rollback in production FAILED* by bzoetewey
                  https://github.com/CruGlobal/cru-deploy/actions/runs/16428899123

lookup failed     (nothing — SlackChannel is read by the job that failed; the
                   cru-deploy Actions tab is the fallback)
```

### Rollback-safety classification

Ported from **flightdeck** (the CTO's reference app). At **promote** time we ask
one question about the SQL migrations added between the release currently in
production and the promoted candidate:

> Can the **previous** image still run against the **new** schema?

- **EXPAND** — every added migration is additive / backward-compatible (new
  tables, new nullable/defaulted columns, new indexes, new enum values, seed
  inserts, comments, grants). The old image keeps working, so a rollback (image
  swap back) stays safe.
- **CONTRACT** — at least one migration is destructive: drops, renames,
  tightening constraints (`ADD CONSTRAINT`, `SET NOT NULL`, column type
  changes), or data migrations (`UPDATE` / `DELETE` / `TRUNCATE`). The old image
  would break against the new schema, so a rollback would **not** revert cleanly.

**Three-state verdict:** `safe` · `unsafe` · `unclassified`. How each is reached,
from the app's `CruApplicationInfo` item:

| app-info                                       | verdict        | reason                                                        |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------- |
| `Migrations = "none"`                          | `safe`         | `no database migrations` — decided with **no compare at all** |
| `MigrationsPath`, every added migration EXPAND | `safe`         | none (nothing to report)                                      |
| `MigrationsPath`, any migration CONTRACT       | `unsafe`       | one per destructive statement, path-prefixed                  |
| `MigrationsPath`, no baseline / no `sha-` tag  | `unclassified` | nothing to diff against — see bootstrap below                 |
| **neither attribute**                          | `unclassified` | migrations may exist, but the classifier cannot see them      |

The last two rows are the reason the declaration exists. An absent
`MigrationsPath` conflates two situations that deserve opposite answers: an app
that **has** no migrations (trivially rollback-safe on every promote) and an app
whose migrations the classifier **cannot see** (genuinely unknown). Absence of
evidence is not evidence of absence, so the app's Terraform module states it
positively with `Migrations = "none"`, and the classifier only claims `safe` when
that declaration is there. A `MigrationsPath` always wins over the declaration —
the two are mutually exclusive by construction, and a declaration must never
mask migrations that can actually be read.

**Advisory only — never blocks anything.** The classify step is
`continue-on-error: true` and the action itself never fails; the verdict only
*informs*. It surfaces in three places:

- **Ledger.** The promote's `CruDeploymentLedger` row gets `RollbackSafe`
  (`"true"`/`"false"`) when the verdict is decided, plus `RollbackSafeReasons`
  (a JSON-array string) when there are reasons. `unclassified` writes neither.
- **Promote Slack message.** A trailing line: `:shield: rollback-safe (migrations
  additive)`, `:shield: rollback-safe (no database migrations)` for a declared-none
  app, `:warning: NOT rollback-safe: <first 2 reasons>`, or
  `rollback safety: unclassified`. The parenthetical is the classifier's own first
  reason when it supplied one, so a `safe` verdict says *why* it is safe.
- **Rollback warning.** `rollback` reads the most recent production ledger row
  carrying a verdict; if it was `"false"`, it emits a loud `::warning` and a
  `:warning:` Slack line — the release being rolled back **from** shipped
  destructive migrations, so the image swap will **not** revert the schema.

**Config — both attributes come from the app module, no per-app wiring needed.**
The **production** app-info lookup reads `MigrationsPath` and `Migrations` and
exposes them to both promote jobs.

- **`MigrationsPath`** — an app with migrations opts in by setting
  `database_migrations.path` on `gcp/cloudrun/app` or `aws/ecs/app` to the
  repo-relative directory of its `.sql` migrations (e.g. `drizzle`).
- **`Migrations = "none"`** — written automatically when the module can prove
  there are no migrations: `database_migrations.enabled = false` with no `path`
  on `gcp/cloudrun/app` / `aws/ecs/app`, and **unconditionally** on
  `aws/lambda/app`, where it is structurally true — that module has no
  `database_migrations` variable and the v2 lambda deploy runs nothing before
  publishing a new function version, so there is nothing the pipeline *could*
  run. `database_migrations.enabled = true` with no `path` writes neither
  attribute: that is the deliberately-`unclassified` can't-see case.

**Mechanics.** The classify action diffs `base...head` via the GitHub compare
API (`base` = the git sha currently in production, from the deployments ledger;
`head` = the candidate's `sha-<gitsha>` tag), filters to the migrations path,
fetches each **added** `.sql` file's content at `head`, splits it on drizzle's
`--> statement-breakpoint` markers and semicolons (comments stripped), and runs
each statement through an ordered EXPAND/CONTRACT rule table.

**First promote bootstraps to `unclassified`.** With no production baseline yet
(the ledger has no prior production `Sha`), `base-sha` is empty and the action
reports `unclassified` — nothing to diff against. The same happens if the
candidate carries no `sha-` tag or the migrations path is unset. A declared-none
app is the exception: it needs no baseline and no diff, so even its **first**
promote reports `safe`.

**Conservative by construction.** Anything the rule table does not positively
recognise as additive is treated as **unsafe**: unrecognised statements, data
migrations, and constraint additions all classify CONTRACT. Rewriting applied
history (a `modified`/`removed`/`renamed` `.sql`) is unsafe, and a non-`.sql`
migration artifact is `unsupported migration format` (drizzle `meta/`
bookkeeping and non-SQL dotfiles are ignored). Only plain `.sql` migrations are
classified today; other migration frameworks land in a later pass.

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
shared registry as `candidate-<date>-<n>` and `sha-<gitsha>`. Nothing is deployed.

- **Router:** a `setup` job resolves the project name and validates `type`; a
  per-runtime build job runs on the matching `type`. All three (`cloudrun`,
  `ecs`, `lambda`) are implemented.
- **No-change guard:** each build job first resolves `sha-<gitsha>` with
  `resolve-image` (`continue-on-error`). If it resolves, the existing
  the existing `candidate-*` tag is reused and every build step is skipped; otherwise the guard
  "fails" and the build proceeds.
- **Output coalescing:** job outputs pick the reuse-path step outputs *or* the
  build-path step outputs with `||` (a skipped step's output is empty, so `||`
  selects whichever path ran); the workflow outputs coalesce across the three
  runtime jobs the same way.

### Lambda candidate build differences

The Lambda build job is the ECS job (prod-bound `<project>-prod-GitHubRole`,
no-change guard, `build-number`, buildx, ECR login, `BUILD_*` secret export,
`./build.sh` pushing `<ecr>/<project>:candidate-<date>-<n>` + `:sha-<gitsha>`) with **two
deliberate differences**, both commented in the workflow:

1. **`--provenance=false`** in `DOCKER_ARGS`. Lambda cannot run an image whose
   top-level manifest is an OCI image index / attestation manifest — exactly what
   buildx emits by default (provenance attestations produce a manifest list);
   `UpdateFunctionCode` rejects such images. The flag forces a single image
   manifest. v1's `build-lambda.yml` carries the same flag for the same reason.
2. **No `--build-arg PROJECT_NAME/ENVIRONMENT/BUILD_NUMBER`** (v1 passed these).
   v2 candidates are **env-neutral**: the aws/lambda/app Terraform module injects
   `PROJECT_NAME` and `ENVIRONMENT` as function env vars at runtime, and
   `BUILD_NUMBER` is unused. Baking an environment into the image would break
   build-once/promote.

No buildx cache and no docker-network (v2 build jobs use neither), matching the
ECS job.

| Input          | Required | Default     | Description                                   |
| -------------- | -------- | ----------- | --------------------------------------------- |
| `workflow-ref` | no       | `main`      | ref of `CruGlobal/.github` to check out       |
| `type`         | yes      | —           | `ecs` \| `lambda` \| `cloudrun`               |
| `project-name` | no       | *repo name* | shared-registry repo/image name               |

| Output         | Description                                   |
| -------------- | --------------------------------------------- |
| `project-name` | resolved project name                         |
| `build-number` | candidate build number `<n>`                  |
| `candidate`    | candidate tag (`candidate-<date>-<n>`)        |
| `image`        | full digest reference of the candidate        |
| `digest`       | `sha256:...` digest                           |

## Workflow: `deploy-candidate`

Deploys a candidate artifact to `release-candidate`. No authz gate.

| Input          | Required | Default | Description                          |
| -------------- | -------- | ------- | ------------------------------------ |
| `workflow-ref` | no       | `main`  | ref of `CruGlobal/.github`           |
| `project-name` | yes      | —       | project name                         |
| `tag`          | yes      | —       | candidate tag, e.g. `candidate-2026-07-23-10056`|
| `force`        | no       | `false` | redeploy even when release-candidate already runs this digest |

| Secret           | Required | Description     |
| ---------------- | -------- | --------------- |
| `datadog-api-key`| yes      | DataDog API key |
| `slack-bot-token`| no       | Slack bot token for notifications; unset disables posting |

**Idempotent by default:** after resolving the candidate, the workflow reads
what release-candidate is currently running; if the digests match (and `force`
is unset) the deploy, Datadog event, and notice are skipped. This makes
scheduled app workflows safe to dispatch unconditionally — a quiet night is a
true no-op. `force` exists for deliberate same-digest redeploys (e.g. picking
up an applied Terraform task-definition template on ECS).

**Cadence is the app workflow's choice — nightly-if-changed is the DEFAULT
for onboarding apps** (ratified 2026-07-24). Every v2 app runs the nightly at
**midnight UTC (`0 0 * * *`)** — one shared slot, unstaggered; the earlier
per-app ~noon-UTC slots are retired. `on: schedule` + `workflow_dispatch`: the
build's no-change guard reuses the existing candidate when `main` hasn't moved,
and this workflow's no-op guard skips the redeploy — a quiet night is a true
no-op. Per-merge (`on: push` to `main`) remains supported for apps that want
a candidate per merge; no reusable-workflow changes either way.

GitHub's scheduled dispatch is best-effort, and top-of-hour crons — `00:00` UTC
most of all — sit in the busiest queue: a nightly run can start many minutes
after the nominal time when the shared scheduler is under load. That lateness is
expected, not a failure; judge a nightly by whether it ran and what it produced,
not by its start minute.

Flow: app-info (`release-candidate`) → GCP auth as the
release-candidate `cru-deploy` SA → `resolve-image` (mode `tag`) → `deploy`
(cloudrun, `release-candidate`) → deployment event via the Events API (env `release-candidate`).

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
| `slack-bot-token`| no       | Slack bot token for notifications; unset disables posting |

Flow: authz → app-info for **both** `release-candidate` and `production` (two
`ProjectId`s) → GCP auth as the **rc** `cru-deploy` SA → `resolve-image` (mode
`environment`, capture digest + its `candidate-*` tag, fail if absent) → re-auth as
the **prod** `cru-deploy` SA → `deploy` (cloudrun, `production`) →
`gcloud artifacts docker tags add <image_base>@<digest> <image_base>:release-<date>-<n>`
→ deployment event via the Events API (env `production`, version `release-<date>-<n>`).

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
| `release`      | yes      | —       | `release-2026-07-20-10041` (the `release-` prefix is optional) — or just the build number: a bare `<n>` resolves the dated release by suffix (and legacy pre-D10 tags directly) |

| Secret           | Required | Description                                 |
| ---------------- | -------- | ------------------------------------------- |
| `datadog-api-key`| yes      | DataDog API key                             |
| `authz-token`    | yes      | token for the collaborator-permission check |
| `slack-bot-token`| no       | Slack bot token for notifications; unset disables posting |

Flow: authz → app-info (`production`) → normalize `release` to a full tag →
GCP auth as the prod `cru-deploy` SA → `resolve-image` (mode `tag`) → `deploy`
(cloudrun, `production`) → deployment event via the Events API with a `rollback:true` tag.

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
| **prod** `cru-deploy@<prod-project>` SA      | **AR writer** on `cru-shared-artifacts/<app>`  | `promote` adds the `release-*` tag           |
| `cru-deploy` control repo                    | `authz-token` secret (pilot: `CRU_DEVOPS_GITHUB_TOKEN`) | promote/rollback collaborator-permission check |
| `cru-deploy` control repo                    | `vars.GCP_WORKLOAD_IDENTITY_PROVIDER` + WIF trust so each env's `cru-deploy` SA is impersonable | GCP auth in deploy-candidate/promote/rollback |

Plain `roles/artifactregistry.writer` (tag create) suffices for the prod
`cru-deploy` SA — releases are permanent, so no `tags.delete` / `repoAdmin` grant
is needed.

### Grants matrix additions (ECS / AWS)

| Identity                                      | Needs                                                                          | Why                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| app **prod** build role (`<project>-prod-GitHubRole`) | ECR **push** on the app's ECR repo + DynamoDB `UpdateItem` on `ECSBuildNumbers` | `build-candidate` (ECS **and Lambda**) pushes `candidate-*`/`sha-*` and increments the build counter (Lambda reuses the same build-number counter) |
| `GitHubDeployECS` (`arn:aws:iam::056154071827:role/GitHubDeployECS`) | ECS deploy (`ecs:*TaskDefinition`, `ecs:UpdateService`), EventBridge (`events:*Targets`), SSM read, ECR `DescribeImages`/`BatchGetImage` | AWS `deploy-candidate`/`promote`/`rollback` resolve + deploy for **ecs** |
| `GitHubDeployLambda` (`arn:aws:iam::056154071827:role/GitHubDeployLambda`) | Lambda `ListFunctions`/`GetFunction`/`GetFunctionConfiguration`/`UpdateFunctionCode`, ECR `DescribeImages`/`BatchGetImage` | AWS `deploy-candidate`/`promote`/`rollback` resolve + deploy for **lambda** |
| `GitHubDeployECS` / `GitHubDeployLambda`       | **`ecr:PutImage`** on each app's ECR repo                                       | `promote` stamps `release-*` via the tag-image manifest re-tag (shared ECR path for ecs + lambda) |

> **Terraform follow-ups (aws/ecs/app + aws/lambda/app modules, separate PR):**
> 1. Add a dedicated **`<project>-<env>-GitHubRole`** for builds and **remove
>    GitHub trust from `TaskRole`** — ending v1's dual-purpose role. Candidates
>    are prod-bound, so the build identity is `<project>-prod-GitHubRole`.
> 2. Add **`ecr:PutImage`** to `GitHubDeployECS` **and `GitHubDeployLambda`** —
>    without it the `promote` release-tag step (`actions/tag-image`) fails.
>    `BatchGetImage` + `DescribeImages` are read-side and typically already
>    granted.
> 3. `GitHubDeployLambda` already exists (cru-deploy-scoped, like the ECS role);
>    confirm it grants `GetFunctionConfiguration` (the completion-wait poll) and
>    `UpdateFunctionCode` across every app's `<project>-<nick>*` functions.

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

## Decision (D2, ratified 2026-07-23): BUILD secrets are GitHub repo secrets

BUILD-time secrets live in the app repo as Actions secrets named `BUILD_<NAME>`.
The repo is the isolation boundary — exactly matching the build's repo-scoped
OIDC identity — and one mechanism serves all three runtimes (the earlier plan,
a shared Secret Manager store, needed API enablement, per-app label filtering,
name-prefix IAM conditions, and still left GCP and AWS apps on different
mechanisms). BUILD secrets are app-level, not env-level: v1's per-env copies
were an artifact of per-env builds.

Mechanics: the app workflow passes `secrets: inherit` to `build-candidate`;
each build job serializes the secrets context, exports ONLY `BUILD_*` keys
(prefix stripped: `BUILD_NPM_TOKEN` → `NPM_TOKEN`) into the build environment,
and no-ops when none exist — there is no gate input. The prefix filter is
load-bearing: `inherit` exposes org secrets to the workflow, and nothing
outside `BUILD_*` may reach `build.sh`. Values remain Actions-masked in logs.

Writes need repo admin: DevOps sets them (`gh secret set BUILD_X --repo ...`)
until `cru secret` learns a brokered write path via the planned GitHub App
(the same App replacing `CRU_DEVOPS_GITHUB_TOKEN`, same push-access authz as
D5). Explicitly out of scope for `cru app secrets`, which stays runtime-only:
build secrets are part of the build, which is GitHub. The 2026-07-21 pilot
finding (Secret Manager API missing on `cru-shared-artifacts`, no multi-app
scoping in `gcp-secrets`) is MOOT — that store is not being built.

## Decision (2026-07-22): self-owned deployment telemetry, no DORA product

Cru pays for Datadog CI Visibility on the single cru-deploy repo (one
committer), which already gives fleet-wide pipeline visibility. Datadog's DORA
Metrics is a separate per-committer SKU with unclear per-app billing exposure,
so the pipeline does NOT use `datadog-ci dora deployment` (RETIRED). Instead every
deploy/promote/rollback posts a structured event to the standard Datadog
Events API (included with the platform): tags `source:cru-pipeline-v2`,
`service`, `environment`, `action:deploy|promote|rollback`, `revision`,
`actor:<github.actor>`, plus `candidate:`/`rollback:` context and — when the
resolved digest carries a `sha-<gitsha>` tag — `sha:<gitsha>` (the `sha-` prefix
stripped; omitted cleanly when absent). Events power dashboards, monitors, and
deploy-correlation overlays.

The `actor:` and `sha:` tags were adopted from **flightdeck** (the CTO's
reference app) — its field-tested event shape attributes every promotion/rollback
to the human and joins it to a commit. They are the **deployments-ledger
precursor**: with actor + git sha on every event, the ledger math below can be
derived without a separate emit path.

Deferred (phase 2): a deployments ledger via an app-info service extension
(POST endpoint -> DynamoDB) as the queryable source of truth for DORA-style
math (deployment frequency, lead time from the `sha-` tags, rollback rate) —
computed by us, billed by no one.

### Deployments ledger

The phase-2 ledger now lands in pipeline-v2 as the durable, queryable record of
every deploy/promote/rollback — the fleet dashboard / DORA data spine. It is
defined next to `CruApplicationInfo` in cru-terraform (`aws/lambda/cru-app-info`).
One design change from the sketch above: writes go **directly to DynamoDB** from
the deploy workflows (no POST endpoint), reusing the existing deploy roles rather
than standing up a separate emit service.

**Table `CruDeploymentLedger`** — `PAY_PER_REQUEST`, PITR + deletion protection,
**no TTL** (rows are permanent, matching releases-are-permanent):

| Attribute   | Role         | Notes |
| ----------- | ------------ | ----- |
| `Project`   | hash key     | app / project name |
| `EventAt`   | range key    | ISO8601 UTC millis + `#<run-id>-<attempt>` uniqueness suffix; lexicographically time-sortable |
| `EventDate` | GSI hash key | `yyyy-mm-dd` |
| `Environment`, `Action`, `Source`, `Revision`, `Digest`, `Sha`, `Actor`, `RunId`, `RunUrl`, `Provider`, `Type` | schema-on-write payload | `Sha` is omitted cleanly when the resolved digest carries no `sha-` tag |

GSI `EventDate-EventAt-index` (hash `EventDate`, range `EventAt`, projection
`ALL`) is the fleet-wide-feed / DORA date-range access path.

**Writers.** Each provider job of `deploy-candidate`, `promote`, and `rollback`
appends one event with `aws dynamodb put-item`, immediately after the Datadog
event step (`Action` = `deploy` | `promote` | `rollback`; `Source` =
`cru-pipeline-v2`). The grant is a single `dynamodb:PutItem` statement added
inline to the existing `GitHubDeployECS` / `GitHubDeployLambda` roles — **no
dedicated ledger role** (mirroring how `ecr:PutImage` was added for release
tagging). GCP (Cloud Run) jobs hold no AWS creds, so they assume one of those
roles (ECS, chosen arbitrarily — the trust is cru-deploy-repo-scoped, not
runtime-scoped) via a `configure-aws-credentials` step placed **after** all GCP
steps so its credential env vars can't interfere with the deploy.

**Never fails the deploy.** Same policy as all telemetry: the step is
`continue-on-error: true` with a trailing
`|| echo "::warning title=Ledger write failed::… (non-blocking)"`.

**Read path.** `GET /deployments` on the app-info API (same Lambda / API Gateway
as `/info`): requires `project`, optional `environment` filter, optional `limit`
(default 20, clamped 1..100). Returns `{Items, Count}` newest-first (`Query` on
`Project`, `ScanIndexForward: false`).

**Sequencing.** The cru-terraform table + role grant must apply **before** these
workflow changes go live; until then the ledger steps emit benign `::warning`
annotations (missing table/grant) and deploys are unaffected.

**v1 deferred to wave-2.** Only pipeline-v2 deploys write to the ledger; v1
workflows are unchanged and will be wired in a later wave.
