# Cru Actions and Workflows

This repository defines the [Workflow Templates](https://docs.github.com/en/actions/using-workflows/creating-starter-workflows-for-your-organization), [Reusable Workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows) and [Actions](https://docs.github.com/en/actions/creating-actions/about-custom-actions) used by other CruGlobal applications and repositories. 

## Workflow Templates
Workflows that repositories can use when creating a new workflow. These will appear in the list of available Workflows
when using the GitHub `New Workflow` (https://github.com/CruGlobal/{repo-name}/actions/new) button in a repo.
Repositories will only see Workflow Templates that match specific filePatterns of the template.

Example: `Build & Deploy ECS` [requires a file](https://github.com/CruGlobal/.github/blob/main/workflow-templates/build-deploy-ecs.properties.json#L5) named `build.sh` in the root of the project.

### Build and Deploy to ECS [link](https://github.com/CruGlobal/.github/blob/main/workflow-templates/build-deploy-ecs.yml)
Basic Build and Deploy of docker containers to ECS. This template requires an executable file named `build.sh` in the
root of the repo. This file is executed during the build process and is expected to run docker build and push. Any
`BUILD` type secrets are provided as environment variables. Applications Built and deployed to ECS must have an
implementation of `aws/ecs/app` module in [cru-terraform](https://github.com/CruGlobal/cru-terraform/tree/master/applications).

Example `build.sh` using `buildx` and `--build-arg` to pass environment variables to the builder.
```shell
#!/bin/bash
docker buildx build $DOCKER_ARGS \
  --build-arg DD_API_KEY=$DD_API_KEY \
  --build-arg SIDEKIQ_CREDS=$SIDEKIQ_CREDS \
  .
```
`$DOCKER_ARGS` includes builder name (`--builder`), cache arguments (`--cache-from`, `--cache-to`), tag (`--tag`) and push (`--push`) to automatically push the container to ECR.

## Reusable Workflows
Reusable workflows must be public and reside in the `.github/workflows` folder. Reusable workflows use the
[`workflow_call`]() event.  

### Build & Push to ECR [link](https://github.com/CruGlobal/.github/blob/main/.github/workflows/build-ecs.yml)
This reusable actions performs the bulk of building a docker container using the `build.sh` file. This workflow is
primarily used by Workflow Templates. This workflow requires that GitHub has access to assume the application TaskRole.
These permissions are usually provided by terraform.

#### Inputs
| Name         | Required | Description                                            |
|--------------|----------|--------------------------------------------------------|
| workflow-ref | [ ]      | Branch, tag or commit used when calling the workflow. Required if calling the workflow from non default 'v1' tag. |

#### Outputs
| Name          | Description                                  |
|---------------|----------------------------------------------|
| project-name  | Project Name, defaults to GitHub repo name.  |
| environment   | Environment (staging/production)             |
| build-number  | Build Number/Tag                             |

### Deploy to ECS [link](https://github.com/CruGlobal/.github/blob/main/.github/workflows/deploy-ecs.yml) 
This workflow updates an ECS Service with the latest SSM Parameter Store secrets and ECR container image. This workflow
should only be run in the [cru-deploy](https://github.com/CruGlobal/cru-deploy) repo which has the necessary IAM permissions to deploy/update ECS services.

#### Inputs
| Name         | Required | Description                                                                                                       |
|--------------|----------|-------------------------------------------------------------------------------------------------------------------|
| workflow-ref | [ ]      | Branch, tag or commit used when calling the workflow. Required if calling the workflow from non default 'v1' tag. |
| project-name | [x]      | Project Name, defaults to GitHub repo name.                                                                       |
| environment  | [x]      | Environment (staging/production)                                                                                  |
| build-number | [x]      | Build Number/Tag                                                                                                  |


## Actions
The following actions are primarily used to build and deploy CruGlobal apps, but may be beneficial elsewhere.
Actions must be public to be called from other repo workflows.

### build-number [link](https://github.com/CruGlobal/.github/tree/main/actions/build-number)
Increments a build-number per project name key. If project name does not have an build-number number, `10000` is
returned instead. This action is atomic, meaning multiple calls will all result sequentially incrementing new
build-numbers.

#### Inputs
| Name         | Required | Description                                                        |
|--------------|----------|--------------------------------------------------------------------|
| project-name | [ ]      | Project name. Defaults to PROJECT_NAME from environment variable.  |

#### Outputs
| Name         | Description                                                       |
|--------------|-------------------------------------------------------------------|
| build-number | Build number. Also exported to BUILD_NUMBER environment variable. |

#### Example
```yaml
...
  steps:
    - name: Increment Build Number
      uses: CruGlobal/.github/actions/build-number@v1
      with:
        project-name: Name
```


### secrets [link](https://github.com/CruGlobal/.github/tree/main/actions/secrets)
Exports application AWS SSM Parameter Store secrets to GitHub Actions environment variables. This requires
that the job is already configured for AWS access and that the IAM Role allows access to SSM Parameter Store.

#### Inputs
| Name         | Required | Description                                                                     |
|--------------|----------|---------------------------------------------------------------------------------|
| project-name | [ ]      | Project name. Defaults to PROJECT_NAME from environment variable.               |
| environment  | [ ]      | Environment (staging/production). Defaults to ENVIRONMENT environment variable. |
| type         | [ ]      | Parameter Type (BUILD, RUNTIME, ALL)                                            |

#### Outputs
Secrets are exported to the environment.

#### Example
```yaml
...
  steps:
    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v2
      with:
        aws-region: us-east-1
        role-to-assume: role_arn
    - name: Build Secrets
      uses: CruGlobal/.github/actions/secrets@v1
      with:
        project-name: Name
        environment: staging
        type: BUILD
```


### flightdeck-sourcemaps [link](https://github.com/CruGlobal/.github/tree/main/actions/flightdeck-sourcemaps)
Uploads the browser source maps in a directory of built files to Flightdeck, so a minified stack frame from the
browser shows the original source. It is for apps that build and deploy in their own workflow, for example a build
that is synced to an S3 bucket. Pipeline v2 apps don't need it: their deploy already uploads the maps their image
carries.

How it works:
- Each `.js` and `.mjs` file is paired with its map through the `//# sourceMappingURL=` comment at the end of
  the file, read relative to that file. The map's file name is never used to guess the pair, because some bundlers
  (Turbopack, for one) hash a file and its map separately, and a map uploaded under the wrong URL fails silently.
- Each map is uploaded under its `.js` file's public URL: `base-url` plus the file's path in `directory`.
- `sourcesContent` is removed before upload, the same way every time, so a re-run sends the same bytes and
  Flightdeck counts the map as `unchanged`.
- A file with an inline `data:` map, or with no comment at all, is skipped and logged.
- When it is done, every map in `directory` is deleted, whether the upload worked or not. That is every file
  ending in `.map` (in any case) or in `.map.gz`, `.map.br` or `.map.zst`, and any other file a `.js` file names
  that reads as a source map.

**Keep maps off the public site.** Run this action after the build and before the step that publishes the
directory. A build that writes source maps, followed by `aws s3 sync dist s3://<bucket>`, publishes every `.map`
file, and the source code inside it, to anyone who asks. This action deletes them first unless `delete-maps` is
`false`. Maps that an earlier deploy already published stay in the bucket unless the sync runs with `--delete`.
The `.js` files keep their `sourceMappingURL` comment, which then points at a missing file; that is harmless.

The action never reaches outside `directory`. A folder inside it that is a symbolic link is not followed, but
`aws s3 sync` follows links by default, so the action warns that any map under such a folder will be published.
It also warns when a folder cannot be read, when any map is left behind, and when `directory` holds
`node_modules` or `.git`, which means it is probably set too high.

**Have the bundler write separate `.map` files and keep the comment.** A "hidden" source map setting leaves the
comment out, and then nothing can be paired or uploaded. An inline map is not uploaded, and it publishes the source
with the `.js` file.

**A clean upload is not proof the maps work.** Flightdeck accepts a well-formed map under any URL and version. Once
errors arrive, check each map's `applied_count` in the Flightdeck project's source map settings. If it stays at 0,
the map matched nothing, which means `base-url` or `version` does not match what the browser reports.

Telemetry never blocks a deploy, so this action never fails the job. A missing token or directory is a warning and
no upload, and every other problem is a warning too. The outputs count what happened.

#### Inputs
| Name        | Required | Description                                                                                                                      |
|-------------|----------|----------------------------------------------------------------------------------------------------------------------------------|
| directory   | [x]      | Directory of built files, laid out the way they are served.                                                                      |
| base-url    | [x]      | Public URL the directory is served from, e.g. `https://example-app.example.org/`.                                                |
| version     | [x]      | Code version the app's browser SDK reports (`code_version`), exactly.                                                            |
| token       | [ ]      | The app's server-scope Flightdeck ingestion token, not the client token in the browser bundle. Unset skips the upload.          |
| endpoint    | [ ]      | Flightdeck base URL, or any https URL on it. Only its origin is kept, and maps go to `/api/1/sourcemap` there.                   |
| delete-maps | [ ]      | Delete every map in the directory after the upload, as described above. Defaults to `true`.                                     |

#### Outputs
| Name      | Description                                                                                                          |
|-----------|----------------------------------------------------------------------------------------------------------------------|
| uploaded  | Maps Flightdeck stored, new or replacing different bytes.                                                            |
| unchanged | Maps Flightdeck already had byte for byte, as on a re-run of the same build.                                        |
| failed    | Maps a `.js` file names that did not land: the upload failed or was stopped, or the map is missing or unusable.     |

#### Example
```yaml
...
  steps:
    - name: Build
      run: npm run build # writes dist/, with source maps
    - name: Upload source maps
      uses: CruGlobal/.github/actions/flightdeck-sourcemaps@v2
      with:
        directory: dist
        base-url: https://example-app.example.org/
        version: ${{ github.sha }} # the same value the build gives the browser SDK
        token: ${{ secrets.ROLLBAR_ACCESS_TOKEN }}
    - name: Publish
      run: aws s3 sync dist s3://example-app-bucket --delete
```
