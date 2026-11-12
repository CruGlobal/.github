import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadYaml, findStep, runShellStep, removeFakes } from './support/workflow-steps.js'

// The dependency audit step in node-security.yml, run under bash with fake
// yarn, npm and corepack on PATH. Each fake records the arguments it was given and
// exits with FAKE_AUDIT_STATUS, so the step's own pass/fail logic is what is
// checked, including yarn classic's severity bitmask.

const { job, step } = findStep(loadYaml('.github/workflows/node-security.yml'), 'dependencies', 'Audit')

const FAKE_PACKAGE_MANAGER = `#!/bin/bash
if [ "$1" = --version ]; then echo "$FAKE_YARN_VERSION"; exit 0; fi
printf '%s\\n' "$(basename "$0") $*" >> "$FAKE_AUDIT_OUT/calls"
exit "\${FAKE_AUDIT_STATUS:-0}"
`

let bin
beforeAll(() => {
  bin = mkdtempSync(path.join(tmpdir(), 'audit-fakes-'))
  for (const name of ['yarn', 'npm', 'pnpm']) {
    writeFileSync(path.join(bin, name), FAKE_PACKAGE_MANAGER)
    chmodSync(path.join(bin, name), 0o755)
  }
  writeFileSync(path.join(bin, 'corepack'), '#!/bin/bash\nexit 0\n')
  chmodSync(path.join(bin, 'corepack'), 0o755)
})

afterAll(() => {
  rmSync(bin, { recursive: true, force: true })
  removeFakes()
})

// runShellStep runs in the test's own directory, so the job's
// working-directory is stood in for by a cd into a project dir holding the
// lockfile under test.
async function audit ({ lockfile, level, prodOnly = 'false', status = 0, yarnVersion = '1.22.22' }) {
  const project = mkdtempSync(path.join(tmpdir(), 'audit-project-'))
  try {
    if (lockfile) writeFileSync(path.join(project, lockfile), '')
    const result = await runShellStep({ job, step: { ...step, run: `cd '${project}'\n${step.run}` } }, {
      context: { 'inputs.audit-level': level, 'inputs.audit-production-only': prodOnly },
      runnerEnv: {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_AUDIT_OUT: project,
        FAKE_AUDIT_STATUS: String(status),
        FAKE_YARN_VERSION: yarnVersion
      }
    })
    const callsFile = path.join(project, 'calls')
    result.calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : []
    return result
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

describe('node-security.yml dependency audit', () => {
  it('fails on an audit-level it does not know, naming the input', async () => {
    const result = await audit({ lockfile: 'package-lock.json', level: 'severe' })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('audit-level')
    expect(result.calls).toEqual([])
  })

  describe('yarn classic', () => {
    it('fails at level high when a high finding is reported (exit 8)', async () => {
      const result = await audit({ lockfile: 'yarn.lock', level: 'high', status: 8 })
      expect(result.status).not.toBe(0)
      expect(result.calls).toEqual(['yarn audit --level high'])
    })

    it('passes at level high when only moderate findings are reported (exit 4)', async () => {
      const result = await audit({ lockfile: 'yarn.lock', level: 'high', status: 4 })
      expect(result.status).toBe(0)
    })

    it('fails at level low when a low finding is reported (exit 2)', async () => {
      const result = await audit({ lockfile: 'yarn.lock', level: 'low', status: 2 })
      expect(result.status).not.toBe(0)
    })
  })

  describe('npm', () => {
    it('passes --omit=dev when production-only is true', async () => {
      const result = await audit({ lockfile: 'package-lock.json', level: 'high', prodOnly: 'true' })
      expect(result.status).toBe(0)
      expect(result.calls).toEqual(['npm audit --audit-level=high --omit=dev'])
    })

    it('audits every dependency when production-only is false', async () => {
      const result = await audit({ lockfile: 'package-lock.json', level: 'high' })
      expect(result.calls).toEqual(['npm audit --audit-level=high'])
    })
  })
})
