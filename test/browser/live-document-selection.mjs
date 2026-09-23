// SPDX-License-Identifier: Apache-2.0
/** Select one enabled account Agent for an opt-in real-account browser run. */
export function selectLiveDocumentAgent(state, agentName) {
  if (state?.device?.state !== 'linked') throw new Error('QA account is not linked')
  const enabled = new Set((Array.isArray(state.device.agents) ? state.device.agents : [])
    .map(agent => String(agent?.id ?? '')).filter(Boolean))
  const named = (Array.isArray(state.instances) ? state.instances : [])
    .filter(row => row?.paired === true && row?.name === agentName)
  const available = named.filter(row => enabled.has(String(row.agentId ?? '')))
  if (available.length === 1) return available[0]
  if (available.length > 1)
    throw new Error(`QA Agent name is ambiguous: ${agentName}. Use a unique enabled Agent name.`)
  if (named.length)
    throw new Error(`QA Agent is not enabled for the linked account: ${agentName}`)
  throw new Error(`No paired enabled QA Agent is named: ${agentName}`)
}
