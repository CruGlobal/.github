import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mocked octokit + @actions/core. `inputs` is the per-test getInput backing map;
// getInput enforces `required` the same way @actions/core does so we can assert
// the missing-input failure paths.
const { createWorkflowDispatch, noticeMock, setFailedMock, inputs } = vi.hoisted(() => ({
  createWorkflowDispatch: vi.fn(),
  noticeMock: vi.fn(),
  setFailedMock: vi.fn(),
  inputs: {}
}))

vi.mock('@actions/github', () => ({
  getOctokit: () => ({ rest: { actions: { createWorkflowDispatch } } })
}))

vi.mock('@actions/core', () => ({
  getInput: (name, opts) => {
    const value = inputs[name] ?? ''
    if (opts?.required && value === '') {
      throw new Error(`Input required and not supplied: ${name}`)
    }
    return value
  },
  notice: noticeMock,
  setFailed: setFailedMock
}))

import { parseInputsJson, parseRepo, run } from '../src/dispatch.js'

beforeEach(() => {
  createWorkflowDispatch.mockReset()
  noticeMock.mockReset()
  setFailedMock.mockReset()
  for (const key of Object.keys(inputs)) delete inputs[key]
})

describe('parseInputsJson', () => {
  it('treats empty / blank input as no inputs', () => {
    expect(parseInputsJson('')).toEqual({})
    expect(parseInputsJson('   ')).toEqual({})
    expect(parseInputsJson(undefined)).toEqual({})
  })

  it('parses a JSON object payload', () => {
    expect(parseInputsJson('{"project-name":"hoax","release":"release-10012"}')).toEqual({
      'project-name': 'hoax',
      release: 'release-10012'
    })
  })

  it('throws on malformed JSON', () => {
    expect(() => parseInputsJson('{not json}')).toThrow(/not valid JSON/)
  })

  it('throws when the payload is not an object', () => {
    expect(() => parseInputsJson('[1,2,3]')).toThrow(/must be a JSON object/)
    expect(() => parseInputsJson('"hoax"')).toThrow(/must be a JSON object/)
    expect(() => parseInputsJson('null')).toThrow(/must be a JSON object/)
  })
})

describe('parseRepo', () => {
  it('splits an owner/name slug', () => {
    expect(parseRepo('CruGlobal/cru-deploy')).toEqual({ owner: 'CruGlobal', repo: 'cru-deploy' })
  })

  it.each(['', 'cru-deploy', 'a/b/c', '/cru-deploy', 'CruGlobal/'])(
    'rejects malformed slug %j',
    (slug) => {
      expect(() => parseRepo(slug)).toThrow(/owner\/name/)
    }
  )
})

describe('run', () => {
  it('dispatches with defaults and a parsed inputs payload', async () => {
    inputs['github-token'] = 'tok'
    inputs.workflow = 'promote.yml'
    inputs['inputs-json'] = '{"project-name":"hoax"}'

    await run()

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'CruGlobal',
      repo: 'cru-deploy',
      workflow_id: 'promote.yml',
      ref: 'main',
      inputs: { 'project-name': 'hoax' }
    })
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('promote.yml'))
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('honors an explicit repo and ref', async () => {
    inputs['github-token'] = 'tok'
    inputs.repo = 'CruGlobal/hoax'
    inputs.workflow = 'rollback.yml'
    inputs.ref = 'pipeline-v2'

    await run()

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'CruGlobal',
      repo: 'hoax',
      workflow_id: 'rollback.yml',
      ref: 'pipeline-v2',
      inputs: {}
    })
  })

  it('fails (never throws) on invalid inputs-json', async () => {
    inputs['github-token'] = 'tok'
    inputs.workflow = 'promote.yml'
    inputs['inputs-json'] = '{bad}'

    await run()

    expect(createWorkflowDispatch).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/))
  })

  it('fails when a required input is missing', async () => {
    inputs.workflow = 'promote.yml'

    await run()

    expect(createWorkflowDispatch).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(/github-token/))
  })
})
