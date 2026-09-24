// SPDX-License-Identifier: Apache-2.0
// Separate Host process for the submission-ledger contention test.
import { openMaterialStore, materialIdentity } from '../worker/material-store.mjs'

const [configFile, root, handle, number] = process.argv.slice(2)
const identity = materialIdentity({ configFile, gatewayUrl: 'https://api.rulith.ai',
  connectionId: 'con-first', agentId: 'ag_first', modelUrl: 'https://api.anthropic.com/v1/messages' })
const store = openMaterialStore(root, identity, { create: false })
process.send({ ready: true })
process.once('message', () => {
  try {
    store.submitSelected(handle, { sessionKey: `session-${number}`, caseId: `case-${number}`, requestId: `request-${number}` })
    process.send({ done: true })
  } catch (error) {
    process.send({ error: `${error?.code ?? error?.name}: ${error?.message}` })
  }
})
