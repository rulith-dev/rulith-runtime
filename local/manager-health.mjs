// SPDX-License-Identifier: Apache-2.0
/**
 * The operator's health read: identities and states, never configuration or credentials.
 * The Gateway and local records are projected field by field. A new field in either record
 * must not silently become something a browser can read; Console links are exact tab paths,
 * not arbitrary URLs supplied by a service.
 */
export function mergeManagerHealth({ device, instances, gateway, gatewayState = 'available', secrets = [] }) {
  const hidden = secrets.filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length)
  const text = value => {
    if (typeof value !== 'string') return ''
    for (const secret of hidden) value = value.split(secret).join('[redacted]')
    return value.slice(0, 2048)
  }
  const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : []
  const state = (value, allowed) => allowed.includes(value) ? value : 'unconfirmed'
  let origin = ''
  try {
    const url = new URL(device.origin)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) origin = url.origin
  } catch { /* A missing or unreadable device has no Console origin. */ }
  const local = rows(instances).map(row => ({ instanceId: text(row.id), name: text(row.name),
    agentId: text(row.agentId), agentName: text(row.agentName), connectionId: text(row.connectionId),
    agentRunning: row.agent === true, workerRunning: row.worker === true,
    workerEnabled: row.workerSetting?.enabled === true, pairingPending: Boolean(row.pendingAgentId),
    pendingAgentId: text(row.pendingAgentId),
    // Keep the scope for the join only. It is not a credential or part of the public row.
    sameAccount: row.agentId ? row.origin === device.origin && row.accountId === device.account?.id
      : row.pendingOrigin === device.origin && row.pendingAccountId === device.account?.id,
    repairable: row.origin === device.origin && row.accountId === device.account?.id
      && !row.orphaned && !row.blocked && !row.pendingAgentId }))
  const agents = gatewayState === 'available' ? rows(gateway?.agents).map(row => {
    const agentId = text(row.agentId)
    const consoleLink = tab => {
      const path = '/console/#/agents/' + encodeURIComponent(agentId) + '?tab=' + tab
      return origin && row.console?.[tab] === path ? origin + path : ''
    }
    return { agentId, name: text(row.name) || agentId, authorized: true,
      key: { state: state(row.key?.state, ['active', 'replaced', 'revoked', 'expired', 'absent']) },
      connections: rows(row.connections).map(connection => ({ connectionId: text(connection.connectionId), name: text(connection.name),
        state: state(connection.state, ['active', 'deleted']), registeredHere: connection.registeredHere === true,
        workerOnline: connection.workerOnline === true, workerLastSeen: text(connection.workerLastSeen) })),
      reconnectable: rows(row.reconnectable).map(connection => ({ connectionId: text(connection.connectionId), name: text(connection.name) })),
      sources: rows(row.sources).map(source => ({ name: text(source.name),
        state: state(source.state, ['ready', 'needs_binding', 'needs_relock', 'binding_attention', 'publication_pending', 'identity_only']),
        connectionName: text(source.connectionName) })),
      ...(row.program ? { program: { state: state(row.program.state, ['current', 'pending', 'rejected', 'unconfirmed']),
        ...(row.program.refusal ? { refusal: { errorCode: text(row.program.refusal.errorCode), message: text(row.program.refusal.message) } } : {}) } } : {}),
      ...(row.pendingCall ? { pendingCall: { tool: text(row.pendingCall.tool), label: text(row.pendingCall.label),
        phase: state(row.pendingCall.phase, ['forwarding', 'waiting', 'reconciliation_required']), since: text(row.pendingCall.since),
        needsPerson: row.pendingCall.needsPerson === true } } : {}),
      console: { runtime: consoleLink('runtime'), configuration: consoleLink('configuration') },
      instances: local.filter(instance => instance.sameAccount && (instance.agentId || instance.pendingAgentId) === agentId) }
  }) : []
  for (const instance of local) {
    if (agents.some(agent => agent.instances.includes(instance))) continue
    // Absence from a truncated/unavailable read proves nothing about authorization.
    const authorized = !instance.sameAccount || (gatewayState === 'available' && gateway?.truncated !== true) ? false : null
    agents.push({ agentId: instance.agentId, name: instance.agentName || instance.name, authorized,
      localOnly: true, instances: [instance], connections: [], reconnectable: [], sources: [] })
  }
  for (const instance of local) delete instance.sameAccount
  return { device: { recordExists: device.state !== 'none', signedIn: device.state === 'linked', state: text(device.state),
    deviceId: text(device.deviceId), name: text(device.deviceName), expiresAt: text(device.expiresAt),
    ...(gatewayState === 'available' && gateway?.device ? { serviceState: state(gateway.device.state, ['approved', 'linked', 'revoked', 'expired']),
      expiresAt: text(gateway.device.expiresAt) || text(device.expiresAt) } : {}) },
    gatewayState, truncated: gateway?.truncated === true, agents }
}

/** Shared with the page so tests exercise the actions a person actually sees. */
export function managerHealthGroups(health) {
  const groups = []
  const device = health.device || {}
  const signIn = { kind: 'signin', label: 'Sign in' }
  groups.push({ name: 'This computer', rows: [{ label: 'Device', value: device.state + (device.name ? ' · ' + device.name : '')
    + (device.expiresAt ? ' · Expires ' + device.expiresAt : ''),
    problem: !device.signedIn, ...(!device.signedIn ? { action: signIn } : {}) }] })
  for (const agent of health.agents || []) {
    const rows = []
    const add = (label, value, problem = false, action) => rows.push({ label, value, problem, ...(action ? { action } : {}) })
    const instance = agent.instances.find(row => row.repairable)
    const canRepair = device.signedIn && agent.authorized === true && instance
    const pairing = (label, replace = false) => canRepair ? { kind: 'pair', label, instanceId: instance.instanceId,
      agentId: agent.agentId, replaceAgentToken: replace } : undefined
    if (agent.localOnly) add('Agent', !agent.agentId ? 'Not attached to an Agent'
      : agent.authorized === false ? 'Not authorized for this computer' : 'Service health unavailable', true)
    if (agent.key) add('Agent key', agent.key.state, agent.key.state !== 'active',
      ['replaced', 'revoked', 'absent'].includes(agent.key.state) ? pairing('Replace key and connect', true) : undefined)
    const here = agent.connections.some(connection => connection.registeredHere && connection.state === 'active')
    for (const connection of agent.connections) {
      const attached = agent.instances.find(row => row.connectionId === connection.connectionId && row.workerEnabled && row.repairable)
      const offline = connection.state === 'active' && !connection.workerOnline
      const restart = offline && attached && !attached.workerRunning && device.signedIn ? { kind: 'worker', label: 'Start Worker', instanceId: attached.instanceId } : undefined
      add('Worker · ' + (connection.name || connection.connectionId), connection.state === 'deleted' ? 'Deleted'
        : (connection.workerOnline ? 'Online' : 'Offline') + (connection.workerLastSeen ? ' · Last seen ' + connection.workerLastSeen : '')
          + (offline && attached?.workerRunning ? ' · Restart Rulith' : ''),
      connection.state !== 'active' || offline, restart)
    }
    if (agent.reconnectable.length) add('Reconnectable', agent.reconnectable.map(row => row.name || row.connectionId).join(', '), !here,
      !here ? (pairing('Reconnect a Connection') || (device.signedIn && agent.authorized === true && !agent.instances.length
        ? { kind: 'setup', label: 'Reconnect a Connection', agentId: agent.agentId } : undefined)) : undefined)
    for (const source of agent.sources) add('Source · ' + source.name, source.state + (source.connectionName ? ' · ' + source.connectionName : ''),
      source.state !== 'ready', source.state !== 'ready' && agent.console?.configuration ? { kind: 'console', label: 'Open in Console', url: agent.console.configuration } : undefined)
    if (agent.program) add('Program', agent.program.state + (agent.program.state === 'rejected' && agent.program.refusal
      ? ' · ' + (agent.program.refusal.message || agent.program.refusal.errorCode) : ''), agent.program.state !== 'current',
    agent.program.state === 'rejected' && agent.console?.configuration ? { kind: 'console', label: 'Open in Console', url: agent.console.configuration } : undefined)
    if (agent.pendingCall) add('Pending call', (agent.pendingCall.label || agent.pendingCall.tool) + ' · ' + agent.pendingCall.phase
      + (agent.pendingCall.since ? ' · Since ' + agent.pendingCall.since : ''), agent.pendingCall.needsPerson,
    agent.pendingCall.needsPerson && agent.console?.runtime ? { kind: 'console', label: 'Open in Console', url: agent.console.runtime } : undefined)
    for (const local of agent.instances) {
      add('Local · ' + local.name, (local.agentRunning ? 'Agent running' : 'Agent stopped') + ' · '
        + (local.workerRunning ? 'Worker running' : local.workerEnabled ? 'Worker offline' : 'Local tools off')
        + (local.pairingPending ? ' · Pairing pending' : ''), local.pairingPending || (local.workerEnabled && !local.workerRunning),
      local.pairingPending ? { kind: 'attachment', label: 'Check attachment', instanceId: local.instanceId }
        : device.signedIn && agent.authorized !== false && local.workerEnabled && !local.workerRunning && local.repairable
          ? { kind: 'worker', label: 'Start Worker', instanceId: local.instanceId } : undefined)
    }
    groups.push({ name: agent.name, rows })
  }
  for (const group of groups) group.rows.sort((a, b) => Number(b.problem) - Number(a.problem))
  return groups.sort((a, b) => Number(b.rows.some(row => row.problem)) - Number(a.rows.some(row => row.problem)))
}
