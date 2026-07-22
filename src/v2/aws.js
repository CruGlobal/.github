import escapeStringRegexp from 'escape-string-regexp'

import {
  ECRClient,
  DescribeImagesCommand,
  BatchGetImageCommand,
  PutImageCommand,
  ImageAlreadyExistsException
} from '@aws-sdk/client-ecr'

import { DEFAULT_ACCOUNT, ecrRegistry } from '../ecs-config'
import { parseImageRef } from './image-ref'

// AWS SDK retry config, matching v1 (src/aws.js). ALL new v2 remote calls run
// through a client configured this way so transient failures (throttling, the
// occasional 503 the pilot hit) are retried automatically rather than failing a
// deploy.
export const RETRY_CONFIG = { maxAttempts: 5, retryMode: 'standard' }
const REGION = 'us-east-1'

// Media types an image manifest can take. Passed to BatchGetImage so the
// registry returns the manifest verbatim for a re-tag (covers Docker v2 single
// manifests, manifest lists, and their OCI equivalents / multi-arch images).
const MANIFEST_MEDIA_TYPES = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json'
]

// v2 fixes v1's repo-name-vs-project-name mismatch: the ECR repository is keyed
// on the PROJECT NAME (one repo per app in the org-shared registry, account
// 056154071827). Both the candidate/sha families at build and the release
// family at promote live in this one repo.
export function ecrRepo (projectName) {
  return projectName
}

// Digest-pinned ECR reference (<registry>/<project>@sha256:...) — what v2
// always deploys. The registry is the shared cruds account's ECR.
export function ecrImageRef (projectName, digest) {
  return `${ecrRegistry(DEFAULT_ACCOUNT)}/${ecrRepo(projectName)}@${digest}`
}

function ecrClient () {
  return new ECRClient({ region: REGION, ...RETRY_CONFIG })
}

// Resolve an ECR tag (candidate-<n>, sha-<gitsha>, release-<n>) to its digest,
// and report every tag currently on that digest. Throws if the tag is absent.
export async function ecrResolveDigest (projectName, tag) {
  const client = ecrClient()
  const response = await client.send(new DescribeImagesCommand({
    repositoryName: ecrRepo(projectName),
    imageIds: [{ imageTag: tag }]
  }))
  const detail = response.imageDetails?.[0]
  if (!detail?.imageDigest) {
    throw new Error(`Tag "${tag}" not found in ECR repository ${ecrRepo(projectName)}`)
  }
  return { digest: detail.imageDigest, tags: detail.imageTags ?? [] }
}

// Tags currently pointing at a digest in the app's ECR repo. Returns [] when the
// digest is not found, so it is safe to call opportunistically for reporting.
export async function ecrTagsForDigest (projectName, digest) {
  const client = ecrClient()
  try {
    const response = await client.send(new DescribeImagesCommand({
      repositoryName: ecrRepo(projectName),
      imageIds: [{ imageDigest: digest }]
    }))
    return response.imageDetails?.[0]?.imageTags ?? []
  } catch {
    return []
  }
}

// Add a tag to an existing digest by re-putting its manifest under the new tag
// (the ECR equivalent of `docker tag` without pulling/pushing layers). Used by
// the tag-image action to stamp release-<n> onto a promoted digest.
//
// Requires ecr:BatchGetImage + ecr:PutImage on the repo. Idempotent: re-tagging
// a digest that already carries the tag is treated as success.
export async function ecrRetagDigest (projectName, digest, tag) {
  const client = ecrClient()
  const repositoryName = ecrRepo(projectName)

  const batch = await client.send(new BatchGetImageCommand({
    repositoryName,
    imageIds: [{ imageDigest: digest }],
    acceptedMediaTypes: MANIFEST_MEDIA_TYPES
  }))
  const image = batch.images?.[0]
  if (!image?.imageManifest) {
    throw new Error(`Digest ${digest} not found in ECR repository ${repositoryName}`)
  }

  try {
    await client.send(new PutImageCommand({
      repositoryName,
      imageManifest: image.imageManifest,
      imageManifestMediaType: image.imageManifestMediaType,
      imageTag: tag
    }))
  } catch (error) {
    // Re-tagging a digest that already carries this exact tag is a no-op.
    if (!(error instanceof ImageAlreadyExistsException)) throw error
  }

  return { repository: repositoryName, digest, tag, image: ecrImageRef(projectName, digest) }
}

// Regexp that selects an app's ECS services in a cluster. Mirrors v1's
// convention `/<project>-(<env>|<nick>)-`: v1 infra names services with either
// the legacy long name or the nickname, so both are matched. The leading '/'
// anchors on the service-ARN path segment (…:service/<name>).
export function ecsServiceRegExp (projectName, legacyEnv, nickname) {
  return new RegExp(
    `/${escapeStringRegexp(projectName)}-(${escapeStringRegexp(legacyEnv)}|${escapeStringRegexp(nickname)})-`
  )
}

// Identify the app container within an ECS task definition. The app container is
// either the `scratch` placeholder (a service that has never been deployed — the
// Terraform template starts from scratch) or the container whose image repo is
// the project. Everything else (nginx, fluentbit, datadog, …) is a sidecar and
// is passed through untouched.
//
// Uses parseImageRef rather than v1's naive `image.split(':')` / indexOf, which
// mis-parses digest refs (…@sha256:… splits on the digest ':') and substring
// matches (project "app" would match repo "app-web").
export function isEcsAppContainer (container, projectName) {
  if (container.image === 'scratch') return true
  if (!container.image) return false
  const { name } = parseImageRef(container.image)
  return name.split('/').pop() === ecrRepo(projectName)
}

// Read-only ECS task-definition fields that DescribeTaskDefinition returns but
// RegisterTaskDefinition rejects. Stripped before re-registering. (camelCase, as
// the AWS SDK v3 returns them — v1 stripped snake_case keys that never matched.)
const READ_ONLY_TASK_DEF_KEYS = [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt'
]

// Compose a new task-definition registration payload from a base task definition
// (the family's LATEST revision — Terraform's template). Strips the read-only
// fields, then rewrites ONLY the app container's image + runtime secrets; every
// sidecar container passes through verbatim. Tags from the template are carried
// over (AWS rejects an empty `tags` array, so the key is only set when present).
//
// Pure function (no SDK calls) so the compose semantics are unit-testable.
export function composeTaskDefinition (taskDefinition, { projectName, image, secrets, tags = [] }) {
  const taskDef = {}
  if (tags.length > 0) {
    taskDef.tags = tags
  }
  for (const [key, value] of Object.entries(taskDefinition)) {
    if (READ_ONLY_TASK_DEF_KEYS.includes(key)) continue
    taskDef[key] = value
  }

  taskDef.containerDefinitions = (taskDef.containerDefinitions ?? []).map(container =>
    isEcsAppContainer(container, projectName)
      ? { ...container, image, secrets }
      : container
  )

  return taskDef
}
