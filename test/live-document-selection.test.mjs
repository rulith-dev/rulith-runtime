import test from 'node:test'
import assert from 'node:assert/strict'
import { selectLiveDocumentAgent } from './browser/live-document-selection.mjs'

const row = (name, agentId, paired = true) => ({ name, agentId, paired, id: `instance-${agentId}` })
const state = (agents, instances, linked = true) => ({
  device: { state: linked ? 'linked' : 'idle', agents: agents.map(([id, name]) => ({ id, name })) },
  instances,
})

test('real-account acceptance selects only an enabled paired Agent', () => {
  const enabled = row('Document QA', 'agent-enabled')
  const disabled = row('Old QA', 'agent-disabled')
  assert.equal(selectLiveDocumentAgent(state([['agent-enabled', 'Document QA']], [enabled, disabled]), 'Document QA'), enabled)
  assert.throws(() => selectLiveDocumentAgent(state([['agent-enabled', 'Document QA']], [enabled, disabled]), 'Old QA'),
    /not enabled for the linked account/)
})

test('real-account acceptance refuses missing, unlinked and ambiguous targets before opening a browser', () => {
  assert.throws(() => selectLiveDocumentAgent(state([], []), 'Missing'), /No paired enabled QA Agent/)
  assert.throws(() => selectLiveDocumentAgent(state([], [], false), 'Missing'), /not linked/)
  const duplicate = [row('QA', 'one'), row('QA', 'two')]
  assert.throws(() => selectLiveDocumentAgent(state([['one', 'QA'], ['two', 'QA']], duplicate), 'QA'), /ambiguous/)
})
