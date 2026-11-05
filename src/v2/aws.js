import escapeStringRegexp from 'escape-string-regexp'
import { TagNotFoundError } from './errors'

import {
  ECRClient,
  DescribeImagesCommand,
  BatchGetImageCommand,
  PutImageCommand,
  ImageAlreadyExistsException,
  ImageNotFoundException,
  RepositoryNotFoundException
} from '@aws-sdk/client-ecr'

import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { CloudFrontClient, CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'

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
//
// Exported because ./oci.js reads manifests out of the same registry and must
// accept exactly the same set: one list, so a format we can re-tag but not read
// (or the reverse) cannot drift into existence.
export const MANIFEST_MEDIA_TYPES = [
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

// Resolve an ECR tag (candidate-*, sha-<gitsha>, release-*) to its digest, and
// report every tag currently on that digest. Throws if the tag is absent — with
// one D10 fallback: a bare-build-number release (`release-<n>`) that doesn't
// exist as a tag falls back to a suffix search for the dated form
// `release-<yyyy-mm-dd>-<n>`. Humans say "rollback to 10056"; the tag says
// release-2026-07-23-10056.
export async function ecrResolveDigest (projectName, tag) {
  const client = ecrClient()
  try {
    return await ecrDescribeTag(client, projectName, tag)
  } catch (error) {
    const dated = await ecrFindDatedReleaseTag(client, projectName, tag).catch(() => undefined)
    if (!dated) throw error
    return ecrDescribeTag(client, projectName, dated)
  }
}

async function ecrDescribeTag (client, projectName, tag) {
  const response = await client.send(new DescribeImagesCommand({
    repositoryName: ecrRepo(projectName),
    imageIds: [{ imageTag: tag }]
  }))
  const detail = response.imageDetails?.[0]
  if (!detail?.imageDigest) {
    throw new TagNotFoundError(tag, `ECR repository ${ecrRepo(projectName)}`)
  }
  return { digest: detail.imageDigest, tags: detail.imageTags ?? [] }
}

// D10 fallback: find the dated release tag carrying a bare build number.
// Returns undefined unless `tag` is release-<n> and EXACTLY one matching
// release-<yyyy-mm-dd>-<n> exists (0 = nothing to find; >1 can't happen with a
// shared build counter, but ambiguity must never guess). Paginated repo scan —
// only runs on the miss path.
async function ecrFindDatedReleaseTag (client, projectName, tag) {
  const bare = tag.match(/^release-(\d+)$/)
  if (!bare) return undefined
  const pattern = new RegExp(`^release-\\d{4}-\\d{2}-\\d{2}-${bare[1]}$`)
  const matches = new Set()
  let nextToken
  do {
    const response = await client.send(new DescribeImagesCommand({
      repositoryName: ecrRepo(projectName),
      maxResults: 1000,
      ...(nextToken ? { nextToken } : {})
    }))
    for (const detail of response.imageDetails ?? []) {
      for (const t of detail.imageTags ?? []) {
        if (pattern.test(t)) matches.add(t)
      }
    }
    nextToken = response.nextToken
  } while (nextToken)
  if (matches.size !== 1) return undefined
  return [...matches][0]
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

// Whether a digest is in a repository. A missing image or repository is false;
// any other error (access, throttling past the retries) is thrown, since it
// says nothing about the image.
export async function ecrDigestExists (repositoryName, digest) {
  try {
    const response = await ecrClient().send(new DescribeImagesCommand({
      repositoryName,
      imageIds: [{ imageDigest: digest }]
    }))
    return (response.imageDetails ?? []).length > 0
  } catch (error) {
    if (error instanceof ImageNotFoundException || error instanceof RepositoryNotFoundException) return false
    throw error
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
export function composeTaskDefinition (taskDefinition, { projectName, image, secrets, tags = [] }) {
  const taskDef = registrationPayload(taskDefinition, tags)

  taskDef.containerDefinitions = (taskDef.containerDefinitions ?? []).map(container =>
    isEcsAppContainer(container, projectName)
      ? { ...container, image, secrets }
      : container
  )

  return taskDef
}

// The same, for a companion's family (see ./companions.js): swap the image of
// each container that runs the companion's repository, or still runs the
// scratch placeholder. Unlike the app container, its secrets are left as the
// template has them. The app's RUNTIME secrets belong to the app, and a
// companion gets only what its own Terraform gives it. Throws when no container
// runs the companion, since registering the template unchanged would run the
// wrong image.
export function composeCompanionTaskDefinition (taskDefinition, { repository, image, tags = [] }) {
  const taskDef = registrationPayload(taskDefinition, tags)

  // Matched on the whole <registry>/<repository> name, so a repository that
  // merely ends the same way is left alone.
  const companionName = parseImageRef(image).name
  let swapped = 0
  taskDef.containerDefinitions = (taskDef.containerDefinitions ?? []).map(container => {
    if (container.image !== 'scratch' && !(container.image && parseImageRef(container.image).name === companionName)) {
      return container
    }
    swapped++
    return { ...container, image }
  })
  if (swapped === 0) {
    throw new Error(
      `No container in task definition family ${taskDefinition.family} runs ${repository} or the scratch ` +
      'placeholder, so there is nothing to swap the companion image into'
    )
  }

  return taskDef
}

// A registration payload from a described task definition: the read-only
// fields stripped, and the template's tags carried over (AWS rejects an empty
// `tags` array, so the key is only set when there are some).
function registrationPayload (taskDefinition, tags) {
  const taskDef = {}
  if (tags.length > 0) {
    taskDef.tags = tags
  }
  for (const [key, value] of Object.entries(taskDefinition)) {
    if (READ_ONLY_TASK_DEF_KEYS.includes(key)) continue
    taskDef[key] = value
  }
  return taskDef
}

// --- Static sites (S3 + CloudFront) ----------------------------------------
//
// A static site deploys with a role of its own, the same shape as the ECS and
// Lambda deploy roles. It holds no S3 grant itself: each site's bucket policy
// grants it s3:PutObject, s3:GetObject and s3:ListBucket, and nothing more (no
// delete, no ACL). So when S3 or CloudFront says no, the message names the
// bucket or distribution and what must grant the role, because the fix is in
// that app's Terraform, not here.
export const STATIC_DEPLOY_ROLE = 'GitHubDeployStatic'

// The S3 actions a site's bucket policy must grant STATIC_DEPLOY_ROLE.
// ListBucket is there so a missing object is a 404: without it S3 answers 403
// for an object that does not exist, and a first deploy would look like a
// permissions error.
export const STATIC_BUCKET_ACTIONS = ['s3:PutObject', 's3:GetObject', 's3:ListBucket']

// The CloudFront actions STATIC_DEPLOY_ROLE's own policy must allow on the
// site's distribution.
export const STATIC_DISTRIBUTION_ACTIONS = ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation']

// Per-request bounds for the S3 and CloudFront clients. The connection timeout
// ends a connect that never completes, and the request timeout ends a request
// whose socket goes quiet for that long. Each attempt gets them, and the SDK's
// retries (RETRY_CONFIG) take over after. The whole-call limits below cap a
// call, retries included, so one object that keeps failing slowly cannot hold
// the deploy until the job's own limit.
export const STATIC_CONNECTION_TIMEOUT_MS = 10 * 1000
export const STATIC_REQUEST_TIMEOUT_MS = 60 * 1000
export const S3_PUT_CALL_TIMEOUT_MS = 5 * 60 * 1000
export const STATIC_READ_CALL_TIMEOUT_MS = 30 * 1000

const STATIC_REQUEST_HANDLER = {
  connectionTimeout: STATIC_CONNECTION_TIMEOUT_MS,
  requestTimeout: STATIC_REQUEST_TIMEOUT_MS
}

// One client of each for the whole action run, so thousands of uploads share
// their connections instead of opening new ones.
let s3
let cloudfront
function s3Client () {
  if (!s3) {
    // A bucket outside us-east-1 still works: S3's redirect names the region.
    s3 = new S3Client({ region: REGION, followRegionRedirects: true, ...RETRY_CONFIG, requestHandler: STATIC_REQUEST_HANDLER })
  }
  return s3
}
function cloudfrontClient () {
  if (!cloudfront) {
    cloudfront = new CloudFrontClient({ region: REGION, ...RETRY_CONFIG, requestHandler: STATIC_REQUEST_HANDLER })
  }
  return cloudfront
}

// Did AWS refuse the call on permissions? S3 and CloudFront both say
// AccessDenied, and a HeadObject carries no body, so all it has is the 403.
export function isAccessDenied (error) {
  return ['AccessDenied', 'AccessDeniedException', 'Forbidden'].includes(error?.name) ||
    error?.$metadata?.httpStatusCode === 403
}

function bucketError (error, action, bucket, key) {
  const where = `s3://${bucket}/${key}`
  const wrapped = isAccessDenied(error)
    ? new Error(
      `S3 refused ${action} on ${where} (access denied). The policy of bucket ${bucket} must grant the ` +
      `${STATIC_DEPLOY_ROLE} role ${STATIC_BUCKET_ACTIONS.join(', ')}.`
    )
    : new Error(`S3 ${action} on ${where} failed: ${error?.message ?? error}`)
  wrapped.cause = error
  return wrapped
}

function distributionError (error, action, distributionId) {
  const wrapped = isAccessDenied(error)
    ? new Error(
      `CloudFront refused ${action} on distribution ${distributionId} (access denied). The ${STATIC_DEPLOY_ROLE} ` +
      `role's policy must allow ${STATIC_DISTRIBUTION_ACTIONS.join(' and ')} on distribution ${distributionId}.`
    )
    : new Error(`CloudFront ${action} on distribution ${distributionId} failed: ${error?.message ?? error}`)
  wrapped.cause = error
  return wrapped
}

// Upload one object. Never sends an ACL: the bucket owns its objects and its
// policy is the only grant, so an ACL would either be refused or mean nothing.
export async function s3PutObject (bucket, key, body, { contentType, cacheControl, metadata } = {}) {
  try {
    await s3Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
      ...(metadata && Object.keys(metadata).length > 0 ? { Metadata: metadata } : {})
    }), { abortSignal: AbortSignal.timeout(S3_PUT_CALL_TIMEOUT_MS) })
  } catch (error) {
    throw bucketError(error, 's3:PutObject', bucket, key)
  }
}

// An object's user metadata, or null when there is no such object. S3
// lowercases metadata keys, so they read back as they were written.
export async function s3HeadObject (bucket, key) {
  try {
    const response = await s3Client().send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(STATIC_READ_CALL_TIMEOUT_MS) }
    )
    return { metadata: response.Metadata ?? {} }
  } catch (error) {
    if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null
    throw bucketError(error, 's3:GetObject (HeadObject)', bucket, key)
  }
}

// Start an invalidation and return its id. `callerReference` makes a retry
// safe: CloudFront answers a repeat of the same reference and paths with the
// invalidation it already made.
export async function cloudfrontCreateInvalidation (distributionId, paths, callerReference) {
  let response
  try {
    response = await cloudfrontClient().send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: callerReference,
        Paths: { Quantity: paths.length, Items: paths }
      }
    }), { abortSignal: AbortSignal.timeout(STATIC_READ_CALL_TIMEOUT_MS) })
  } catch (error) {
    throw distributionError(error, 'cloudfront:CreateInvalidation', distributionId)
  }
  return response.Invalidation?.Id
}

// An invalidation's status: "InProgress" or "Completed".
export async function cloudfrontInvalidationStatus (distributionId, id) {
  let response
  try {
    response = await cloudfrontClient().send(
      new GetInvalidationCommand({ DistributionId: distributionId, Id: id }),
      { abortSignal: AbortSignal.timeout(STATIC_READ_CALL_TIMEOUT_MS) }
    )
  } catch (error) {
    throw distributionError(error, 'cloudfront:GetInvalidation', distributionId)
  }
  return response.Invalidation?.Status
}

// The app's CruApplicationInfo row for one LEGACY environment name (staging,
// production, lab), as { attribute: string } for its string attributes, or
// null when there is no row. The workflows read the same row with the aws CLI
// before any deploy. A static deploy reads it again here for the two
// attributes only it needs (Bucket, DistributionId), so no action input had to
// change for them.
export async function appInfoItem (projectName, legacyEnvironmentName) {
  const client = new DynamoDBClient({ region: REGION, ...RETRY_CONFIG })
  let response
  try {
    response = await client.send(new GetItemCommand({
      TableName: 'CruApplicationInfo',
      Key: { Project: { S: projectName }, Environment: { S: legacyEnvironmentName } }
    }), { abortSignal: AbortSignal.timeout(STATIC_READ_CALL_TIMEOUT_MS) })
  } catch (error) {
    const wrapped = new Error(
      `Could not read the CruApplicationInfo row for ${projectName} (${legacyEnvironmentName}): ${error?.message ?? error}`
    )
    wrapped.cause = error
    throw wrapped
  }
  if (!response?.Item) return null
  const item = {}
  for (const [name, value] of Object.entries(response.Item)) {
    if (typeof value?.S === 'string') item[name] = value.S
  }
  return item
}

