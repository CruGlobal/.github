import {
  ECSClient,
  paginateListServices,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  TaskDefinitionField,
  UpdateServiceCommand
} from '@aws-sdk/client-ecs'

import {
  SSMClient,
  paginateGetParametersByPath,
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
  ListFunctionsCommand,
  UpdateFunctionCodeCommand
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

export async function ssmParameters (prefix, decrypt = true) {
  const client = new SSMClient({ region: 'us-east-1', ...RETRY_CONFIG })
  const params = []
  for await (const page of paginateGetParametersByPath({ client, pageSize: 10 }, {
    Path: prefix,
    WithDecryption: decrypt
  })) {
    params.push(...page.Parameters)
  }
  return await Promise.all(params.map(async (param) => {
    const tags = (await client.send(new ListTagsForResourceCommand({
      ResourceType: 'Parameter',
      ResourceId: param.Name
    }))).TagList
    return {
      name: param.Name,
      value: param.Value,
      tags: tags.reduce(tagReducer, {})
    }
  }))
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
  let Marker = undefined

  do {
    const command = new ListFunctionsCommand({ MaxItems: 50, Marker })
    const response = await client.send(command)
    functionNames.push(...response.Functions
      .filter(fn => fn.FunctionName.startsWith(`${projectName}-${environment}`))
      .map(fn => fn.FunctionName))
    Marker = response.NextToken
  } while (Marker)

  return functionNames
}

export async function lambdaGetFunction(functionName) {
  const client = new LambdaClient({...RETRY_CONFIG})
  const command = new GetFunctionCommand({ FunctionName: functionName })
  return await client.send(command)
}

export async function lambdaUpdateFunctionCode(functionName, imageDigestUri) {
  const client = new LambdaClient({...RETRY_CONFIG})
  const command = new UpdateFunctionCodeCommand({
    FunctionName: functionName,
    ImageUri: imageDigestUri
  })
  return await client.send(command)
}
