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
      uses: aws-actions/configure-aws-credentials@v1
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
