import { describe, it, expect } from 'vitest'
import { COMPANION_LABEL_PREFIX, companionFamily, parseCompanions } from '../src/v2/companions.js'
import { composeCompanionTaskDefinition } from '../src/v2/aws.js'

const REGISTRY = '000000000000.dkr.ecr.us-east-1.amazonaws.com'
const APP_IMAGE = `${REGISTRY}/example-app@sha256:${'a'.repeat(64)}`
const DIGEST = `sha256:${'b'.repeat(64)}`
const parse = labels => parseCompanions(labels, { projectName: 'example-app', appImage: APP_IMAGE })

describe('parseCompanions', () => {
  it('reads each companion label, sorted by name, and ignores every other label', () => {
    expect(parse({
      'org.cru.companion.worker': `${REGISTRY}/example-app/worker@${DIGEST}`,
      'org.cru.companion.tool-runner': `${REGISTRY}/example-app/tools.v2@${DIGEST}`,
      'org.cru.sourcemaps': '1.2.3',
      'org.cru.companionship': 'not ours'
    })).toEqual([
      { name: 'tool-runner', image: `${REGISTRY}/example-app/tools.v2@${DIGEST}`, repository: 'example-app/tools.v2', digest: DIGEST },
      { name: 'worker', image: `${REGISTRY}/example-app/worker@${DIGEST}`, repository: 'example-app/worker', digest: DIGEST }
    ])
  })

  it.each([undefined, null, {}])('finds none in %j', labels => {
    expect(parse(labels)).toEqual([])
  })

  it.each([
    ['an empty name', COMPANION_LABEL_PREFIX, `${REGISTRY}/example-app/worker@${DIGEST}`, /the name must be/],
    ['a double dash', `${COMPANION_LABEL_PREFIX}a--b`, `${REGISTRY}/example-app/worker@${DIGEST}`, /the name must be/],
    ['a trailing dash', `${COMPANION_LABEL_PREFIX}worker-`, `${REGISTRY}/example-app/worker@${DIGEST}`, /the name must be/],
    ['a dot in the name', `${COMPANION_LABEL_PREFIX}a.b`, `${REGISTRY}/example-app/worker@${DIGEST}`, /the name must be/],
    ['the db-migrate name', `${COMPANION_LABEL_PREFIX}db-migrate`, `${REGISTRY}/example-app/worker@${DIGEST}`, /"db-migrate" is taken/],
    ['an empty value', `${COMPANION_LABEL_PREFIX}worker`, '', /the value is empty/],
    ['a short digest', `${COMPANION_LABEL_PREFIX}worker`, `${REGISTRY}/example-app/worker@sha256:abc`, /not pinned by a sha256 digest/],
    ['a tag', `${COMPANION_LABEL_PREFIX}worker`, `${REGISTRY}/example-app/worker:candidate-1`, /not pinned by a sha256 digest/],
    ['another registry', `${COMPANION_LABEL_PREFIX}worker`, `111111111111.dkr.ecr.us-east-1.amazonaws.com/example-app/worker@${DIGEST}`, /not in the app image's registry/],
    ['another app', `${COMPANION_LABEL_PREFIX}worker`, `${REGISTRY}/other-app/worker@${DIGEST}`, /repository "other-app\/worker" is not one name under "example-app\/"/],
    // The reason for the '/': a dash after the project name could be another
    // app whose name starts with this one's.
    ['an app whose name extends ours with a dash', `${COMPANION_LABEL_PREFIX}api`, `${REGISTRY}/example-app-api@${DIGEST}`, /is not one name under "example-app\/"/],
    ['an app whose name starts with ours', `${COMPANION_LABEL_PREFIX}worker`, `${REGISTRY}/example-application/worker@${DIGEST}`, /is not one name under "example-app\/"/],
    ['the app itself', `${COMPANION_LABEL_PREFIX}worker`, `${REGISTRY}/example-app@${DIGEST}`, /is not one name under/],
    ['an empty suffix', `${COMPANION_LABEL_PREFIX}worker`, `${REGISTRY}/example-app/@${DIGEST}`, /is not one name under/],
    ['a nested repository', `${COMPANION_LABEL_PREFIX}worker`, `${REGISTRY}/example-app/x/other@${DIGEST}`, /is not one name under/]
  ])('refuses %s', (_, label, value, message) => {
    expect(() => parse({ [label]: value })).toThrow(message)
  })

  it('names every broken label at once', () => {
    expect(() => parse({
      'org.cru.companion.a': `${REGISTRY}/other-app/a@${DIGEST}`,
      'org.cru.companion.b': `${REGISTRY}/example-app/b:latest`,
      'org.cru.companion.c': `${REGISTRY}/example-app/c@${DIGEST}`
    })).toThrow(/^The image's companion labels break the contract: org\.cru\.companion\.a: .*; org\.cru\.companion\.b: /)
  })

  it('escapes the project name, so a dot in it is not a wildcard', () => {
    expect(() => parseCompanions(
      { 'org.cru.companion.worker': `${REGISTRY}/aXb/worker@${DIGEST}` },
      { projectName: 'a.b', appImage: `${REGISTRY}/a.b@sha256:${'a'.repeat(64)}` }
    )).toThrow(/is not one name under "a.b\/"/)
  })
})

describe('companionFamily', () => {
  it('follows the <project>-<nick>-<name> convention', () => {
    expect(companionFamily('example-app', 'stage', 'worker')).toBe('example-app-stage-worker')
  })
})

describe('composeCompanionTaskDefinition', () => {
  const image = `${REGISTRY}/example-app/worker@${DIGEST}`
  const template = containerDefinitions => ({
    family: 'example-app-prod-worker',
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/example-app-prod-worker:3',
    revision: 3,
    status: 'ACTIVE',
    registeredAt: new Date(0),
    memory: '2048',
    containerDefinitions
  })

  it('swaps the scratch placeholder and the companion repository, and nothing else', () => {
    const composed = composeCompanionTaskDefinition(template([
      { name: 'worker', image: 'scratch', secrets: [{ name: 'A', valueFrom: '/a' }] },
      { name: 'helper', image: `${REGISTRY}/example-app/worker:old` },
      { name: 'app', image: `${REGISTRY}/example-app@sha256:${'0'.repeat(64)}` },
      { name: 'lookalike', image: `${REGISTRY}/other/example-app/worker:1` },
      { name: 'datadog', image: 'public.ecr.aws/datadog/agent:latest' }
    ]), { repository: 'example-app/worker', image, tags: [{ key: 'k', value: 'v' }] })

    expect(composed).toEqual({
      tags: [{ key: 'k', value: 'v' }],
      family: 'example-app-prod-worker',
      memory: '2048',
      containerDefinitions: [
        { name: 'worker', image, secrets: [{ name: 'A', valueFrom: '/a' }] },
        { name: 'helper', image },
        { name: 'app', image: `${REGISTRY}/example-app@sha256:${'0'.repeat(64)}` },
        { name: 'lookalike', image: `${REGISTRY}/other/example-app/worker:1` },
        { name: 'datadog', image: 'public.ecr.aws/datadog/agent:latest' }
      ]
    })
  })

  it('leaves out tags when the template has none', () => {
    const composed = composeCompanionTaskDefinition(template([{ name: 'worker', image: 'scratch' }]), { repository: 'example-app/worker', image })
    expect(composed).not.toHaveProperty('tags')
  })

  it('throws when no container runs the companion', () => {
    expect(() => composeCompanionTaskDefinition(
      template([{ name: 'datadog', image: 'public.ecr.aws/datadog/agent:latest' }, { name: 'empty' }]),
      { repository: 'example-app/worker', image }
    )).toThrow('No container in task definition family example-app-prod-worker runs example-app/worker or the scratch placeholder')
  })
})
