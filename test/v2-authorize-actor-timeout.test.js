import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'

// The real @actions/github client against a local server that never answers,
// to prove the per-request timeout reaches the request and ends in a refusal.
vi.mock('@actions/core', () => ({
  getInput: () => '',
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  exportVariable: vi.fn()
}))

import { getOctokit } from '@actions/github'
import { authorize } from '../src/authorize-actor.js'

let server
let baseUrl
let requests = 0
const sockets = new Set()

beforeAll(async () => {
  server = http.createServer(() => { requests++ })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
})

describe('authorize against a GitHub API that never answers', () => {
  it('refuses after three timed-out tries, in a bounded time', async () => {
    const octokit = getOctokit('tok', { baseUrl })
    // Count tries at the client. The server may not see a request that runs
    // out of time before it even arrives.
    const real = octokit.rest.repos.getCollaboratorPermissionLevel
    let tries = 0
    octokit.rest.repos.getCollaboratorPermissionLevel = (args) => { tries++; return real(args) }
    const started = Date.now()
    await expect(authorize({
      octokit,
      repository: 'CruGlobal/some-app',
      operation: 'promote',
      actor: 'alice',
      actorId: '1001',
      triggeringActor: 'alice',
      runAttempt: '1',
      sleep: async () => {},
      timeoutMs: 300
    })).rejects.toThrow('could not read the permission of alice on CruGlobal/some-app (no answer within 0.3 seconds)')
    const elapsed = Date.now() - started
    expect(tries).toBe(3)
    expect(requests).toBeGreaterThanOrEqual(1)
    expect(elapsed).toBeGreaterThanOrEqual(850)
    expect(elapsed).toBeLessThan(5000)
  })
})
