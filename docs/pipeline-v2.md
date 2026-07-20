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

| Runtime  | resolve-image | deploy   |
| -------- | ------------- | -------- |
| cloudrun | implemented   | implemented |
| ecs      | stub (throws) | stub (throws) |
| lambda   | stub (throws) | stub (throws) |

Both actions use a router that dispatches on `type`. The stubs throw a clear
"lands in a later v2 pass" error, so ECS/Lambda get filled in later without any
change to the action interfaces.

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
