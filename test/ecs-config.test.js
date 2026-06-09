import { describe, it, expect } from 'vitest'
import {
  awsAccountNumber,
  DEFAULT_ACCOUNT,
  ecrImageTag,
  ecrRegistry,
  ecsCluster,
  environmentFromBranch,
  environmentNickname,
  taskRoleARN
} from '../src/ecs-config.js'

describe('environmentNickname', () => {
  it.each([
    ['production', 'prod'],
    ['staging', 'stage'],
    ['development', 'dev'],
    ['lab', 'lab']
  ])('maps %s -> %s', (environment, expected) => {
    expect(environmentNickname(environment)).toBe(expected)
  })

  it('passes through unknown environments unchanged', () => {
    expect(environmentNickname('integration')).toBe('integration')
  })
})

describe('environmentFromBranch', () => {
  it.each([
    ['main', 'production'],
    ['master', 'production'],
    ['production', 'production'],
    ['staging', 'staging']
  ])('maps %s -> %s', (branch, expected) => {
    expect(environmentFromBranch(branch)).toBe(expected)
  })

  it('maps lab-* branches to lab', () => {
    expect(environmentFromBranch('lab-feature-x')).toBe('lab')
  })

  it('defaults unknown branches to staging', () => {
    expect(environmentFromBranch('some-feature')).toBe('staging')
  })
})

describe('ecsCluster', () => {
  it.each([
    ['production', 'prod'],
    ['prod', 'prod'],
    ['development', 'lab'],
    ['dev', 'lab'],
    ['lab', 'lab'],
    ['staging', 'stage'],
    ['anything-else', 'stage']
  ])('maps %s -> %s', (environment, expected) => {
    expect(ecsCluster(environment)).toBe(expected)
  })
})

describe('awsAccountNumber', () => {
  it('resolves a known alias to its account number', () => {
    expect(awsAccountNumber('cruds')).toBe('056154071827')
  })

  it('defaults to the cruds account', () => {
    expect(awsAccountNumber()).toBe(awsAccountNumber(DEFAULT_ACCOUNT))
  })

  it('returns a 12+ digit account number as-is', () => {
    expect(awsAccountNumber('123456789012')).toBe('123456789012')
  })

  it('throws on an unknown alias', () => {
    expect(() => awsAccountNumber('not-a-real-account')).toThrow(TypeError)
  })
})

describe('taskRoleARN', () => {
  it('builds an IAM role ARN using the environment nickname', () => {
    expect(taskRoleARN('myproject', 'production', 'TaskRole')).toBe(
      'arn:aws:iam::056154071827:role/myproject-prod-TaskRole'
    )
  })
})

describe('ecrRegistry', () => {
  it('builds the ECR registry host for an account alias', () => {
    expect(ecrRegistry('cruds')).toBe('056154071827.dkr.ecr.us-east-1.amazonaws.com')
  })

  it('honors a custom region', () => {
    expect(ecrRegistry('cruds', 'us-west-2')).toBe('056154071827.dkr.ecr.us-west-2.amazonaws.com')
  })
})

describe('ecrImageTag', () => {
  it('builds a fully-qualified ECR image tag', () => {
    expect(ecrImageTag('myproject', 'staging', '10042')).toBe(
      '056154071827.dkr.ecr.us-east-1.amazonaws.com/myproject:staging-10042'
    )
  })
})
