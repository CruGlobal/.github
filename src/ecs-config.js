import { ssmParameters } from './aws'

const ACCOUNTS = {
  'cruds': '056154071827',
  'great-lakes': '149713003610',
  'snowplow': '699385956789',
  'oracle-dr': '831196674197',
  'r-and-d': '972493202329',
  'cru-prod': '151451362611',
  'user-bastion': '725722162525'
}
const DEFAULT_ACCOUNT = 'cruds'

export const PARAM_TYPES = ['BUILD', 'RUNTIME', 'ALL']
export const BUILD_PARAM_TYPES = ['BUILD', 'ALL']
export const RUNTIME_PARAM_TYPES = ['RUNTIME', 'ALL']

export function environmentNickname (environment) {
  switch (environment) {
    case 'production':
      return 'prod'
    case 'staging':
      return 'stage'
    case 'development':
      return 'dev'
    default:
      return environment
  }
}

export function environmentFromBranch (branch) {
  switch (branch) {
    case 'main':
    case 'master':
    case 'production':
      return 'production'
    case 'staging':
    default:
      return 'staging'
  }
}

export function ecsCluster (environment) {
  switch (environment) {
    case 'production':
    case 'prod':
      return 'prod'
    case 'development':
    case 'dev':
    case 'lab':
      return 'lab'
    default:
      return 'stage'
  }
}

export function awsAccountNumber (awsAccount = DEFAULT_ACCOUNT) {
  // If account is 12+ digits, return it
  if (/^\d{12,}$/.test(awsAccount))
    return awsAccount

  if (!ACCOUNTS.hasOwnProperty(awsAccount))
    throw new TypeError(`Unknown AWS account alias: ${awsAccount}`)

  // Otherwise, lookup account number
  return ACCOUNTS[awsAccount]
}

export function taskRoleARN (projectName, environment, awsAccount = DEFAULT_ACCOUNT) {
  const env = environmentNickname(environment)
  return `arn:aws:iam::${awsAccountNumber(awsAccount)}:role/${projectName}-${env}-TaskRole`
}

export function ecrRegistry (account, region = 'us-east-1') {
  const accountNumber = awsAccountNumber(account)
  return `${accountNumber}.dkr.ecr.${region}.amazonaws.com`
}

export function ecrImageTag (projectName, environment, buildNumber) {
  return `${ecrRegistry(DEFAULT_ACCOUNT)}/${projectName}:${environment}-${buildNumber}`
}

export async function secrets (projectName, environment, types = PARAM_TYPES) {
  const env = environmentNickname(environment)
  return (await ssmParameters(`/ecs/${projectName}/${env}/`))
    .filter(param => types.includes(param.tags['param_type']))
    .reduce((acc, key) => ({ ...acc, [key.name.split('/').pop()]: key.value }), {})
}

export async function runtimeSecrets (projectName, environment) {
  const env = environmentNickname(environment)
  return (await ssmParameters(`/ecs/${projectName}/${env}/`, false))
    .filter(param => RUNTIME_PARAM_TYPES.includes(param.tags['param_type']))
    .reduce((acc, key) => [...acc, { name: key.name.split('/').pop(), valueFrom: key.name }], [])
}
