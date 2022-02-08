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

const tagReducer = (previousValue, currentValue) => {
  previousValue[currentValue.Key] = currentValue.Value
  return previousValue
}

const chunk = (arr, size) => arr.reduce((acc, _, i) => (i % size) ? acc : [...acc, arr.slice(i, i + size)], [])

export async function ecsListServices (regexp, cluster) {
  const client = new ECSClient({})
  const serviceArns = []
  for await (const page of paginateListServices({ client, pageSize: 50 }, { cluster })) {
    serviceArns.push(...page.serviceArns)
  }
  return serviceArns.filter(arn => regexp.test(arn))
}

export async function ecsServiceTaskDefinitions (serviceArns, cluster) {
  const client = new ECSClient({})
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
  const client = new ECSClient({})
  return client.send(new DescribeTaskDefinitionCommand({ taskDefinition, include: [TaskDefinitionField.TAGS] }))
}

export async function ecsRegisterTaskDefinition (taskDefinition) {
  const client = new ECSClient({})
  const response = await client.send(new RegisterTaskDefinitionCommand(taskDefinition))
  return response.taskDefinition.taskDefinitionArn
}

export async function ecsUpdateService (service, cluster, taskDefinition) {
  const client = new ECSClient({})
  const response = await client.send(new UpdateServiceCommand({ service, cluster, taskDefinition }))
  return response.service
}

export async function ssmParameters (prefix, decrypt = true) {
  const client = new SSMClient({ region: 'us-east-1' })
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
  const client = new DynamoDBClient({})
  return (await client.send(new UpdateItemCommand({
    TableName: 'ECSBuildNumbers',
    Key: { ProjectName: { 'S': projectName } },
    ExpressionAttributeNames: { '#buildNumber': 'BuildNumber' },
    ExpressionAttributeValues: { ':num': { 'N': '1' }, ':base': { 'N': '10000' } },
    UpdateExpression: 'SET #buildNumber = if_not_exists(#buildNumber, :base) + :num',
    ReturnValues: 'UPDATED_NEW'
  }))).Attributes.BuildNumber.N
}
