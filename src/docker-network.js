import * as core from '@actions/core'
import * as exec from '@actions/exec'

const IsPost = !!process.env['STATE_isPost']
const NETWORK_NAME = 'dockerNetworkName'

async function run () {
  try {
    core.info('Docker Network')
    core.saveState('isPost', 'true')
    const name = core.getInput('name', { required: true })
    core.saveState(NETWORK_NAME, name)
    await exec.exec('docker', ['network', 'create', name])
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function cleanup () {
  core.info('Docker Network :: Cleanup')
  const name = core.getState(NETWORK_NAME)
  await exec.exec('docker', ['network', 'rm', name])
}

if (!IsPost) {
  run()
} else {
  cleanup()
}
