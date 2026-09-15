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
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  paginateListFunctions,
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

export async function ecsUpdateService (service, cluster, taskDefinition) {
  const client = new ECSClient({...RETRY_CONFIG})
  const response = await client.send(new UpdateServiceCommand({ service, cluster, taskDefinition }))
  return response.service
}

// Full DescribeServices records (not just their task defs — see
// ecsServiceTaskDefinitions above). The pre-deploy migration phase reads a
// service's networkConfiguration / launchType / capacityProviderStrategy off
// this to run the db-migrate task on the same footing as the app.
export async function ecsDescribeServices (serviceArns, cluster) {
  const client = new ECSClient({...RETRY_CONFIG})
  const response = await client.send(new DescribeServicesCommand({ cluster, services: serviceArns }))
  return response.services ?? []
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

export async function lambdaGetFunction(functionName) {
  const client = new LambdaClient({...RETRY_CONFIG})
  const command = new GetFunctionCommand({ FunctionName: functionName })
  return await client.send(command)
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
