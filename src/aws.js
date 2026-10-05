import {
  ECSClient,
  paginateListServices,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  TaskDefinitionField,
  UpdateServiceCommand,
  waitUntilTasksStopped
} from '@aws-sdk/client-ecs'

import {
  SSMClient,
  paginateGetParametersByPath,
  GetParametersCommand,
  ListTagsForResourceCommand
} from '@aws-sdk/client-ssm'

import {
  DynamoDBClient,
  UpdateItemCommand
} from '@aws-sdk/client-dynamodb'

import {
  EventBridgeClient,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  PutTargetsCommand
} from '@aws-sdk/client-eventbridge'

import {
  ECRClient,
  BatchGetImageCommand
} from '@aws-sdk/client-ecr'

import {
  LambdaClient,
  DeleteFunctionCommand,
  GetAliasCommand,
  GetFunctionCommand,
  PublishVersionCommand,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  paginateListFunctions,
  paginateListVersionsByFunction,
  waitUntilFunctionUpdatedV2
} from '@aws-sdk/client-lambda'

const tagReducer = (previousValue, currentValue) => {
  previousValue[currentValue.Key] = currentValue.Value
  return previousValue
}

const chunk = (arr, size) => arr.reduce((acc, _, i) => (i % size) ? acc : [...acc, arr.slice(i, i + size)], [])
const RETRY_CONFIG = {maxAttempts: 5, retryMode: 'standard'}

export async function ecsListServices (regexp, cluster) {
  const client = new ECSClient({...RETRY_CONFIG})
  const serviceArns = []
  for await (const page of paginateListServices({ client, pageSize: 50 }, { cluster })) {
    serviceArns.push(...page.serviceArns)
  }
  return serviceArns.filter(arn => regexp.test(arn))
}

export async function ecsServiceTaskDefinitions (serviceArns, cluster) {
  const client = new ECSClient({...RETRY_CONFIG})
  const services = []
  for (const arns of chunk(serviceArns, 10)) {
    const result = await client.send(new DescribeServicesCommand({ cluster, services: arns }))
    services.push(...result.services)
  }
  return await services.reduce(async (acc, key) => {
    try {
      const taskDef = await ecsDescribeTaskDefinition(key.taskDefinition)
      return { ...await acc, [key.serviceArn]: taskDef.taskDefinition }
    } catch (error) {
      return { ...await acc, [key.serviceArn]: { error } }
    }
  }, {})
}

export async function ecsDescribeTaskDefinition (taskDefinition) {
  const client = new ECSClient({...RETRY_CONFIG})
  return client.send(new DescribeTaskDefinitionCommand({ taskDefinition, include: [TaskDefinitionField.TAGS] }))
}

export async function ecsRegisterTaskDefinition (taskDefinition) {
  const client = new ECSClient({...RETRY_CONFIG})
  const response = await client.send(new RegisterTaskDefinitionCommand(taskDefinition))
  return response.taskDefinition.taskDefinitionArn
}

// Returns the service as UpdateService answers with it, deployments included:
// the new PRIMARY deployment is the one this update made. `timeoutMs` bounds
// the whole call, retries included, so a call made near the end of a rollout
// wait cannot run past it.
export async function ecsUpdateService (service, cluster, taskDefinition, { timeoutMs } = {}) {
  const client = new ECSClient({...RETRY_CONFIG})
  const response = await client.send(
    new UpdateServiceCommand({ service, cluster, taskDefinition }),
    timeoutMs ? { abortSignal: AbortSignal.timeout(timeoutMs) } : undefined
  )
  return response.service
}

// Full DescribeServices records (not just their task defs — see
// ecsServiceTaskDefinitions above). The pre-deploy migration phase reads a
// service's networkConfiguration / launchType / capacityProviderStrategy off
// this to run the db-migrate task on the same footing as the app, and the
// running-image resolver reads each service's deployments. DescribeServices
// takes at most 10 services a call.
export async function ecsDescribeServices (serviceArns, cluster) {
  const client = new ECSClient({...RETRY_CONFIG})
  const services = []
  for (const arns of chunk(serviceArns, 10)) {
    const response = await client.send(new DescribeServicesCommand({ cluster, services: arns }))
    services.push(...(response.services ?? []))
  }
  return services
}

// How long one quick read may take. See ecsDescribeService.
export const ECS_QUICK_READ_TIMEOUT_MS = 20 * 1000

// One service, or null when ECS reports it missing. A rollout wait reads with
// `quick`: ONE attempt, bounded by a short timeout, since the wait's own next
// look is the retry, and a read that retried for minutes could carry the wait
// past its bound.
export async function ecsDescribeService (serviceArn, cluster, { quick = false } = {}) {
  const client = new ECSClient(quick ? { maxAttempts: 1 } : {...RETRY_CONFIG})
  const response = await client.send(
    new DescribeServicesCommand({ cluster, services: [serviceArn] }),
    quick ? { abortSignal: AbortSignal.timeout(ECS_QUICK_READ_TIMEOUT_MS) } : undefined
  )
  return response.services?.[0] ?? null
}

// Launch a one-off ECS task (used to run db-migrate to completion before a
// deploy touches any service). Returns the raw RunTask response so the caller
// can read tasks[].taskArn and failures[].
export async function ecsRunTask ({ cluster, taskDefinition, count = 1, startedBy, networkConfiguration, launchType, capacityProviderStrategy }) {
  const client = new ECSClient({...RETRY_CONFIG})
  return client.send(new RunTaskCommand({
    cluster,
    taskDefinition,
    count,
    startedBy,
    networkConfiguration,
    launchType,
    capacityProviderStrategy
  }))
}

export async function ecsDescribeTasks (cluster, tasks) {
  const client = new ECSClient({...RETRY_CONFIG})
  return client.send(new DescribeTasksCommand({ cluster, tasks }))
}

// Block until the given tasks reach STOPPED (or the wait times out — the SDK
// waiter throws on TIMEOUT/FAILURE). Reaching STOPPED is not success on its own:
// the caller still inspects the container exit code. maxWaitTime is seconds.
export async function ecsWaitUntilTasksStopped (cluster, tasks, maxWaitTime = 900) {
  const client = new ECSClient({...RETRY_CONFIG})
  return waitUntilTasksStopped({ client, maxWaitTime }, { cluster, tasks })
}

export async function ssmParameters (prefix, decrypt = true) {
  // Adaptive retry rate-limits the client once SSM starts throttling, so
  // contended calls slow down and succeed instead of exhausting retries
  const client = new SSMClient({ region: 'us-east-1', maxAttempts: 10, retryMode: 'adaptive' })
  const params = []
  for await (const page of paginateGetParametersByPath({ client, pageSize: 10 }, {
    Path: prefix,
    WithDecryption: decrypt
  })) {
    params.push(...page.Parameters)
  }
  // Fetch tags in small batches — one concurrent ListTagsForResource per
  // parameter exceeds the account-wide SSM rate limit when deploys overlap
  const results = []
  for (const batch of chunk(params, 5)) {
    results.push(...await Promise.all(batch.map(async (param) => {
      const tags = (await client.send(new ListTagsForResourceCommand({
        ResourceType: 'Parameter',
        ResourceId: param.Name
      }))).TagList
      return {
        name: param.Name,
        value: param.Value,
        tags: tags.reduce(tagReducer, {})
      }
    })))
  }
  return results
}

// How long ssmParameterValue will spend on ONE parameter, retries included.
//
// The client below already retries; this bounds the whole call instead of
// stacking a second retry loop on top of it — the same reasoning src/gcp.js
// applies to accessSecret, and for the same caller. The ECS source-map upload
// (src/v2/sourcemaps.js) is optional telemetry sitting on the rollback path —
// the emergency path — so a read that hangs is strictly worse than a source map
// that never lands.
export const SSM_PARAMETER_TIMEOUT_MS = 30 * 1000

// Read the decrypted value of ONE SSM parameter by full name, e.g.
// /ecs/<project>/<env>/ROLLBAR_ACCESS_TOKEN.
//
// Returns null when the parameter does not exist, which callers use as a signal
// rather than an error: ssmParameters above reads a whole path, but a caller
// asking for a specific name is asking a question ("is this environment wired
// for X?") whose answer may legitimately be no.
//
// GetParameters (plural) with a single name, NOT GetParameter: they are separate
// IAM actions, and ssm:GetParameters is the one the deploy roles already hold.
// The plural call is also the one that answers a miss with an InvalidParameters
// entry instead of throwing, which is exactly the signal wanted here.
//
// SecureStrings under /ecs/ are encrypted with the AWS-managed alias/aws/ssm
// key, whose policy admits any same-account principal calling through SSM — so
// WithDecryption needs no kms:Decrypt grant of its own. The v1 build path
// (secrets() in src/ecs-config.js) has read these the same way all along.
export async function ssmParameterValue (name, { timeoutMs = SSM_PARAMETER_TIMEOUT_MS } = {}) {
  const client = new SSMClient({ region: 'us-east-1', ...RETRY_CONFIG })
  const response = await client.send(
    new GetParametersCommand({ Names: [name], WithDecryption: true }),
    { abortSignal: AbortSignal.timeout(timeoutMs) }
  )
  return response.Parameters?.[0]?.Value ?? null
}

export async function ecsBuildNumber (projectName) {
  const client = new DynamoDBClient({...RETRY_CONFIG})
  return (await client.send(new UpdateItemCommand({
    TableName: 'ECSBuildNumbers',
    Key: { ProjectName: { 'S': projectName } },
    ExpressionAttributeNames: { '#buildNumber': 'BuildNumber' },
    ExpressionAttributeValues: { ':num': { 'N': '1' }, ':base': { 'N': '10000' } },
    UpdateExpression: 'SET #buildNumber = if_not_exists(#buildNumber, :base) + :num',
    ReturnValues: 'UPDATED_NEW'
  }))).Attributes.BuildNumber.N
}

export async function eventBridgeListRules (prefix) {
  const client = new EventBridgeClient({...RETRY_CONFIG})
  const rules = []
  let NextToken = undefined

  do {
    const command = new ListRulesCommand({ NamePrefix: prefix, Limit: 10, NextToken })
    const response = await client.send(command)
    rules.push(...response.Rules)
    NextToken = response.NextToken
  } while (NextToken)
  return rules
}

export async function eventBridgeListTargets (ruleName) {
  const client = new EventBridgeClient({...RETRY_CONFIG})
  const targets = []
  let NextToken = undefined

  do {
    const command = new ListTargetsByRuleCommand({ Rule: ruleName, Limit: 10, NextToken })
    const response = await client.send(command)
    targets.push(...response.Targets)
    NextToken = response.NextToken
  } while (NextToken)
  return targets
}

export async function eventBridgeUpdateTarget(ruleName, target) {
  const client = new EventBridgeClient({...RETRY_CONFIG})
  const command = new PutTargetsCommand({Rule: ruleName, Targets: [target]})
  return await client.send(command)
}

export async function ecrGetImageDigest(projectName, environment, buildNumber) {
  const client = new ECRClient({...RETRY_CONFIG})
  const repositoryName = `${projectName}`
  const imageTag = `${environment}-${buildNumber}`
  const command = new BatchGetImageCommand({
    repositoryName,
    imageIds: [{ imageTag }],
    acceptedMediaTypes: ['application/vnd.docker.distribution.manifest.v2+json']
  })
  return (await client.send(command)).images[0].imageId.imageDigest
}

export async function lambdaListFunctionNames(projectName, environment) {
  const client = new LambdaClient({...RETRY_CONFIG})
  const functionNames = []

  for await (const page of paginateListFunctions({ client, pageSize: 50 }, {})) {
    functionNames.push(...page.Functions
      .filter(fn => fn.FunctionName.startsWith(`${projectName}-${environment}`))
      .map(fn => fn.FunctionName))
  }

  return functionNames
}

// `qualifier` reads one published version (or an alias) instead of $LATEST.
export async function lambdaGetFunction(functionName, qualifier) {
  const client = new LambdaClient({...RETRY_CONFIG})
  const command = new GetFunctionCommand({ FunctionName: functionName, ...(qualifier ? { Qualifier: qualifier } : {}) })
  return await client.send(command)
}

export async function lambdaGetAlias(functionName, name) {
  const client = new LambdaClient({...RETRY_CONFIG})
  return await client.send(new GetAliasCommand({ FunctionName: functionName, Name: name }))
}

// Publish $LATEST as a version, but only while it still holds the code and the
// config that were read: CodeSha256 and RevisionId make Lambda refuse the
// publish if either changed since.
export async function lambdaPublishVersion(functionName, { codeSha256, revisionId, description }) {
  const client = new LambdaClient({...RETRY_CONFIG})
  return await client.send(new PublishVersionCommand({
    FunctionName: functionName,
    CodeSha256: codeSha256,
    RevisionId: revisionId,
    Description: description
  }))
}

// Every published version of a function, as Lambda lists them (each with its
// Version and CodeSha256), without $LATEST. For an image function CodeSha256
// is the hex of the image's digest.
export async function lambdaListVersions(functionName) {
  const client = new LambdaClient({...RETRY_CONFIG})
  const versions = []
  for await (const page of paginateListVersionsByFunction({ client, pageSize: 50 }, { FunctionName: functionName })) {
    versions.push(...(page.Versions ?? []).filter(version => version.Version !== '$LATEST'))
  }
  return versions
}

// Point an alias at one version, sending it all the traffic. `revisionId` is
// the alias's own: Lambda refuses the move if the alias changed since it was
// read.
export async function lambdaUpdateAlias(functionName, name, functionVersion, revisionId) {
  const client = new LambdaClient({...RETRY_CONFIG})
  return await client.send(new UpdateAliasCommand({
    FunctionName: functionName,
    Name: name,
    FunctionVersion: functionVersion,
    RevisionId: revisionId
  }))
}

// Delete one published version. Anything but a version number is refused here:
// DeleteFunction without a qualifier deletes the whole function.
export async function lambdaDeleteFunctionVersion(functionName, version) {
  if (!/^[0-9]+$/.test(String(version ?? ''))) {
    throw new Error(`Refusing to delete ${functionName} at "${version}": only a published version number may be deleted`)
  }
  const client = new LambdaClient({...RETRY_CONFIG})
  return await client.send(new DeleteFunctionCommand({ FunctionName: functionName, Qualifier: String(version) }))
}

export async function lambdaUpdateFunctionCode(functionName, imageUri) {
  const client = new LambdaClient({...RETRY_CONFIG})
  const command = new UpdateFunctionCodeCommand({
    FunctionName: functionName,
    ImageUri: imageUri
  })
  return await client.send(command)
}

// Block until a function's in-flight code/config update completes. UpdateFunction
// Code returns before the image is actually live (LastUpdateStatus 'InProgress'),
// so v2 waits here before returning — otherwise a subsequent resolve/verify can
// read the OLD digest (the race the Lambda pilot hit). Polls GetFunction
// Configuration and rejects on a 'Failed' terminal state. Added for v2; v1's
// deploy-lambda did not wait (it slept 5s between updates instead).
export async function lambdaWaitForFunctionUpdated(functionName, maxWaitTime = 300) {
  const client = new LambdaClient({...RETRY_CONFIG})
  return await waitUntilFunctionUpdatedV2(
    { client, maxWaitTime },
    { FunctionName: functionName }
  )
}

// Did the waiter above give up on time, rather than see the update fail?
//
// The waiter ends in one of the util-waiter result states (the waiter code
// ships inside @smithy/core), and its checkExceptions turns each into an error
// whose message is the result as JSON, e.g.
// {"state":"TIMEOUT",...,"reason":"Waiter has timed out"}. TIMEOUT throws an
// Error named "TimeoutError", ABORTED one named "AbortError", and FAILURE
// (LastUpdateStatus Failed) a plain Error. A GetFunction call that fails
// during the wait never surfaces: the waiter counts it as "retry". So the name
// alone tells a slow update from a failed one, with no JSON to parse.
export function isWaiterTimeout(error) {
  return error?.name === 'TimeoutError'
}

// Is this AWS error an answer that will not change on a retry? The clients
// above already retried the passing ones (throttling, 5xx, the network), so
// what reaches a caller is either one of those that outlasted the retries or
// a real answer. A 4xx is a real answer (AccessDenied, ResourceNotFound, a
// bad request), except 429 and the throttling errors some services send with
// a 400. Anything else, a 5xx, a network error or no status at all, may pass.
const THROTTLING_ERRORS = ['ThrottlingException', 'TooManyRequestsException', 'RequestLimitExceeded']

export function isPermanentAwsError(error) {
  const status = error?.$metadata?.httpStatusCode
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429 &&
    !THROTTLING_ERRORS.includes(error?.name)
}
