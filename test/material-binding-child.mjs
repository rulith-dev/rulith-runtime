// SPDX-License-Identifier: Apache-2.0
import { materialIdentity, openMaterialStore } from '../worker/material-store.mjs'

const [configFile, root, deviceId] = process.argv.slice(2)
const identity = materialIdentity({
  configFile, gatewayUrl: 'https://api.rulith.ai', connectionId: 'con-first',
  agentId: 'ag_first', deviceId, modelUrl: 'https://api.anthropic.com/v1/messages',
})
process.send({ ready: true })
process.once('message', () => {
  let result
  try {
    const store = openMaterialStore(root, identity)
    store.assertSelectedDeviceId(deviceId)
    result = { done: true, deviceId }
  } catch (error) {
    result = { error: error?.code ?? String(error), deviceId }
  }
  process.send(result, () => process.exit(0))
})
