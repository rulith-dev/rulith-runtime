// SPDX-License-Identifier: Apache-2.0
/** Health reads and repairs use the real loopback manager and device pairing fixture. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createManagerServer } from '../local/manager-server.mjs'
import { mergeManagerHealth, managerHealthGroups } from '../local/manager-health.mjs'
import { managerPage } from '../local/manager-ui.mjs'
import { loadInstanceConfig, saveInstanceConfig } from '../local/instance-manager.mjs'
import { createDevicesGateway } from './support/local-devices-gateway.mjs'
import { runPageScript } from './support/mini-dom.mjs'
import { startFixtureInstance } from './support/local-role-controls.mjs'

const KEY = 'health-manager-test-key'
const ORIGIN = 'https://console.example', ACCOUNT = 'acct-1'
const device = { state: 'linked', origin: ORIGIN, account: { id: ACCOUNT }, deviceId: 'dev-1', deviceName: 'Computer',
  agents: [{ id: 'agent-alpha', name: 'Alpha' }] }
const local = { id: 'inst-000000000001', name: 'Alpha here', agentId: 'agent-alpha', agentName: 'Alpha',
  origin: ORIGIN, accountId: ACCOUNT, connectionId: 'conn-1', paired: true, mode: 'local_agent',
  workerSetting: { enabled: true }, agent: true, worker: false }
const cloudAgent = (overrides = {}) => ({ agentId: 'agent-alpha', name: 'Alpha', key: { state: 'active' },
  connections: [{ connectionId: 'conn-1', name: 'Office', state: 'active', registeredHere: true, workerOnline: true,
    workerLastSeen: '2026-10-07T10:00:00Z' }], reconnectable: [], sources: [{ name: 'Files', state: 'ready' }],
  program: { state: 'current' }, console: { runtime: '/console/#/agents/agent-alpha?tab=runtime',
    configuration: '/console/#/agents/agent-alpha?tab=configuration' }, ...overrides })
const healthOf = (agent = cloudAgent(), instances = [local], overrides = {}) => mergeManagerHealth({ device, instances,
  gateway: { device: { deviceId: device.deviceId, state: 'approved' }, agents: [agent] }, ...overrides })
const problemRows = health => managerHealthGroups(health).flatMap(group => group.rows).filter(row => row.problem)
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)) }

async function fixture(t, { signIn = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rulith-health-')), gateway = createDevicesGateway()
  await gateway.listen()
  const manager = createManagerServer({ root, port: 0, key: KEY, directoryRefreshMs: 3600_000, startConfirmMs: 8000 })
  await manager.listen()
  t.after(async () => { await manager.close(); await gateway.close(); rmSync(root, { recursive: true, force: true }) })
  if (signIn) {
    const pending = await manager.device.start({ consoleUrl: gateway.origin, name: 'Computer' })
    gateway.approve(pending.code, ['agent-alpha', 'agent-beta'])
    await manager.device.poll()
  }
  const get = async (path = '/manager/health', headers = { 'x-rulith-manager': KEY }) => {
    const response = await fetch(`http://127.0.0.1:${manager.port}${path}`, { headers })
    return { status: response.status, text: await response.text() }
  }
  return { manager, gateway, root, get }
}

async function attached(manager, agentId = 'agent-alpha') {
  const row = await manager.instances.create({ name: 'Local ' + agentId })
  await manager.instances.pair(row.id, { agentId })
  return row
}

test('health merges processes and pairing by account, origin and Agent, including local-only instances', () => {
  const health = healthOf(cloudAgent(), [local, { ...local, id: 'other', name: 'Other account', accountId: 'other' },
    { ...local, id: 'missing', agentId: 'agent-missing', pendingAgentId: 'agent-missing' }])
  assert.equal(health.agents.length, 3)
  assert.deepEqual(health.agents[0].instances.map(row => row.instanceId), [local.id])
  assert.equal(health.agents[0].instances[0].agentRunning, true)
  assert.equal(health.agents[0].instances[0].workerRunning, false)
  assert.equal(health.agents[0].instances[0].workerEnabled, true)
  assert.equal(health.agents[1].authorized, false)
  assert.equal(health.agents[2].instances[0].pairingPending, true)
  assert.match(problemRows(health).find(row => row.label === 'Agent').value, /Not authorized for this computer/)
  const partial = healthOf(cloudAgent(), [{ ...local, agentId: 'missing' }], { gateway: { agents: [], truncated: true } })
  assert.equal(partial.agents[0].authorized, null, 'a partial read cannot withdraw access')
})

test('each problem offers one existing operation or the scoped Console tab', () => {
  for (const state of ['replaced', 'revoked', 'absent']) {
    const key = problemRows(healthOf(cloudAgent({ key: { state } }))).find(row => row.label === 'Agent key')
    assert.deepEqual(key.action, { kind: 'pair', label: 'Replace key and connect', instanceId: local.id,
      agentId: local.agentId, replaceAgentToken: true })
  }
  assert.equal(problemRows(healthOf(cloudAgent({ key: { state: 'expired' } }))).find(row => row.label === 'Agent key').action, undefined)
  const reconnect = problemRows(healthOf(cloudAgent({ connections: [], reconnectable: [{ connectionId: 'old', name: 'Office' }] })))
    .find(row => row.label === 'Reconnectable')
  assert.equal(reconnect.value, 'Office')
  assert.equal(reconnect.action.replaceAgentToken, false)
  assert.equal(reconnect.action.kind, 'pair')
  assert.equal(problemRows(healthOf(cloudAgent({ connections: [], reconnectable: [{ connectionId: 'old', name: 'Office' }] }), []))
    .find(row => row.label === 'Reconnectable').action.kind, 'setup')
  const offlineAgent = cloudAgent({ connections: [{ ...cloudAgent().connections[0], workerOnline: false }] })
  const worker = problemRows(healthOf(offlineAgent)).find(row => row.label.startsWith('Worker'))
  assert.deepEqual(worker.action, { kind: 'worker', label: 'Start Worker', instanceId: local.id })
  const liveWorker = problemRows(healthOf(offlineAgent, [{ ...local, worker: true }])).find(row => row.label.startsWith('Worker'))
  assert.equal(liveWorker.action, undefined)
  assert.match(liveWorker.value, /Restart Rulith/)
  for (const state of ['needs_binding', 'needs_relock', 'binding_attention', 'publication_pending', 'identity_only']) {
    const source = problemRows(healthOf(cloudAgent({ sources: [{ name: 'Files', state }] }))).find(row => row.label.startsWith('Source'))
    assert.equal(source.action.url, ORIGIN + '/console/#/agents/agent-alpha?tab=configuration')
  }
  const health = healthOf(cloudAgent({ program: { state: 'rejected', refusal: { errorCode: 'bad_program', message: 'Review the rules' } },
    pendingCall: { tool: 'ApplyAction', label: 'Write', phase: 'reconciliation_required', needsPerson: true } }))
  const rows = problemRows(health)
  assert.match(rows.find(row => row.label === 'Program').value, /Review the rules/)
  assert.equal(rows.find(row => row.label === 'Pending call').action.url, ORIGIN + '/console/#/agents/agent-alpha?tab=runtime')
  for (const state of ['none', 'revoked', 'expired', 'unusable', 'unreadable']) {
    const groups = managerHealthGroups(healthOf(cloudAgent(), [], { device: { ...device, state } }))
    assert.equal(groups.find(group => group.name === 'This computer').rows[0].action.kind, 'signin')
  }
  const noStart = healthOf(offlineAgent, [{ ...local, workerSetting: { enabled: false } }])
  assert.equal(problemRows(noStart).find(row => row.label.startsWith('Worker')).action, undefined)
  const noRepair = healthOf(cloudAgent({ key: { state: 'revoked' } }), [{ ...local, orphaned: { children: [] } }])
  assert.equal(problemRows(noRepair).find(row => row.label === 'Agent key').action, undefined)
})

test('health projects known fields only and refuses credential-bearing or foreign Console paths', () => {
  const secret = 'sentinel-private-credential'
  const agent = cloudAgent({ token: secret, key: { state: 'revoked', key: secret },
    name: 'Name ' + secret, program: { state: 'rejected', refusal: { message: 'Refused ' + secret, token: secret } },
    console: { runtime: '/console/#/agents/agent-alpha?tab=runtime&key=' + secret, configuration: '//evil.example/' + secret } })
  const health = healthOf(agent, [{ ...local, token: secret, name: 'Local ' + secret }], { secrets: [secret] })
  assert.equal(JSON.stringify(health).includes(secret), false)
  assert.deepEqual(health.agents[0].console, { runtime: '', configuration: '' })
  assert.equal(JSON.stringify(health).includes('token'), false)
})

test('manager health is gated, authenticates the device bearer, and merges real local facts', async t => {
  const { manager, gateway, get } = await fixture(t)
  const row = await attached(manager)
  const missing = await manager.instances.create({ name: 'Not attached' })
  gateway.setHealth({ agents: [cloudAgent()] })
  assert.equal((await get('/manager/health', {})).status, 401)
  assert.equal((await get('/manager/health', { 'x-rulith-manager': KEY, origin: 'https://foreign.example' })).status, 403)
  const before = gateway.requests.length
  const reply = await get()
  assert.equal(reply.status, 200)
  const health = JSON.parse(reply.text).health
  assert.equal(health.device.signedIn, true)
  assert.equal(health.agents[0].instances[0].instanceId, row.id)
  assert.equal(health.agents[1].instances[0].instanceId, missing.id)
  const calls = gateway.requests.slice(before).filter(row => row.path === '/local-devices/health')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].origin, undefined)
  await get('/manager/state')
  assert.equal(gateway.requests.filter(row => row.path === '/local-devices/health').length, 1, 'state reads do not poll health')
})

test('404 falls back to local facts and preserves a usable device', async t => {
  const { manager, get } = await fixture(t)
  await attached(manager)
  assert.equal(await manager.device.health(), null)
  const reply = await get(), health = JSON.parse(reply.text).health
  assert.equal(reply.status, 200)
  assert.equal(health.gatewayState, 'unsupported')
  assert.equal(health.agents.length, 1)
  assert.equal(health.agents[0].authorized, null)
  assert.equal(manager.device.status().state, 'linked')
})

for (const refusal of ['revoked', 'expired']) test('device ' + refusal + ' is a health state with sign-in recovery', async t => {
  const { manager, gateway, get } = await fixture(t)
  const deviceId = manager.device.status().deviceId
  if (refusal === 'revoked') gateway.revokeDeviceFromConsole(deviceId)
  else gateway.expireDevice(deviceId)
  const reply = await get(), health = JSON.parse(reply.text).health
  assert.equal(reply.status, 200)
  assert.equal(manager.device.status().state, 'unusable')
  assert.equal(health.device.signedIn, false)
  assert.equal(managerHealthGroups(health)[0].rows[0].action.kind, 'signin')
})

test('missing and unreadable device records still offer Health without a Gateway read', async t => {
  const { manager, gateway, root, get } = await fixture(t, { signIn: false })
  const health = JSON.parse((await get()).text).health
  assert.equal(health.device.recordExists, false)
  assert.equal(gateway.requests.length, 0)
  writeFileSync(join(root, 'device.json'), '{broken')
  assert.equal(JSON.parse((await get()).text).health.device.state, 'unreadable')
  assert.equal(gateway.requests.length, 0)
  assert.equal(manager.device.status().state, 'unreadable')
})

test('neither health JSON nor the rendered page contains stored or reflected credentials', async t => {
  const { manager, gateway, get } = await fixture(t)
  const row = await attached(manager), config = loadInstanceConfig(row.directory)
  config.agent.env.RULITH_MODEL_KEY = 'sentinel-model-secret'
  saveInstanceConfig(row.directory, config)
  const secrets = [KEY, gateway.deviceToken(manager.device.status().deviceId), config.agent.env.RULITH_TOKEN,
    config.worker.env.RULITH_CONNECTION_KEY, config.agent.env.RULITH_MODEL_KEY]
  gateway.setHealth({ token: secrets[1], key: secrets[3], agents: [cloudAgent({ token: secrets[2],
    name: 'Name ' + secrets[2], connections: [{ ...cloudAgent().connections[0], key: secrets[3] }],
    program: { state: 'rejected', refusal: { message: secrets.join(' / '), secret: secrets[1] } } })] })
  const reply = await get(), served = await get('/'), health = JSON.parse(reply.text).health
  const current = manager.state()
  const page = await runPageScript(served.text, { respond: async path => ({ body: path === '/manager/health' ? { ok: true, health } : { ok: true, ...current } }) })
  await page.$('health-open').onclick()
  for (const secret of secrets) {
    assert.equal(reply.text.includes(secret), false, 'health must redact credential values')
    assert.equal(served.text.includes(secret), false, 'HTML must contain no stored credentials')
    assert.equal(page.$('health-items').innerHTML.includes(secret), false, 'health rendering must contain no credentials')
  }
  assert.match(page.$('health-items').innerHTML, /\[redacted\]/)
})

async function pageFor(health, overrides = {}) {
  const state = { ok: true, device, instances: [local], ...overrides }
  return runPageScript(managerPage, { respond: async path => ({ body: path === '/manager/health' ? { ok: true, health } : state }) })
}
function pressAction(page, label) {
  const match = [...page.$('health-items').innerHTML.matchAll(/data-health-action="(\d+)"[^>]*>([^<]+)<\/button>/g)].find(row => row[2] === label)
  assert.ok(match, 'Health offers ' + label)
  return page.$('health-items').onclick({ target: { dataset: { healthAction: match[1] } } })
}

test('Health reads only on open or Refresh, lists problems first and collapses healthy Agents', async () => {
  const health = healthOf(cloudAgent({ key: { state: 'revoked' }, name: '<Alpha>' }), [{ ...local, worker: true }],
    { gateway: { agents: [cloudAgent({ agentId: 'healthy', name: 'Healthy' }), cloudAgent({ key: { state: 'revoked' }, name: '<Alpha>' })] } })
  const page = await pageFor(health)
  assert.equal(page.calls.some(call => call.path === '/manager/health'), false)
  await page.$('health-open').onclick()
  const html = page.$('health-items').innerHTML
  assert.ok(html.includes('&lt;Alpha&gt;'))
  assert.ok(html.indexOf('&lt;Alpha&gt;') < html.indexOf('Healthy ·'))
  assert.ok(html.includes('<details><summary>Healthy ·'))
  assert.ok(html.indexOf('Agent key') < html.indexOf('Source'))
  await page.api('/manager/state')
  page.render()
  assert.equal(page.calls.filter(call => call.path === '/manager/health').length, 1)
  await page.$('health-refresh').onclick()
  assert.equal(page.calls.filter(call => call.path === '/manager/health').length, 2)
})

test('the old-service message keeps local health and sign-in opens the existing account dialog', async () => {
  const health = healthOf(cloudAgent(), [local], { gatewayState: 'unsupported', device: { ...device, state: 'revoked' } })
  const page = await pageFor(health, { device: { ...device, state: 'revoked' } })
  await page.$('health-open').onclick()
  assert.equal(page.$('health-service').textContent, 'This Rulith service does not offer the health check yet')
  pressAction(page, 'Sign in')
  assert.equal(page.$('dlg-account').hidden, false)
  assert.equal(page.$('signin-reset').hidden, false)
})

test('Health key replacement uses the existing checkbox and pairing operation on the attached profile', async () => {
  const page = await pageFor(healthOf(cloudAgent({ key: { state: 'replaced' } })))
  await page.$('health-open').onclick()
  await pressAction(page, 'Replace key and connect')
  assert.equal(page.$('dlg-attach').hidden, false)
  assert.equal(page.$('attach-form').hidden, false)
  assert.equal(page.$('attach-repair-copy').hidden, false)
  assert.equal(page.$('pair').disabled, true)
  page.$('replace').checked = true; page.$('replace').onchange(); page.applyControls()
  assert.equal(page.$('pair').disabled, false)
  page.$('pair').onclick(); await settle()
  assert.deepEqual(page.calls.find(call => call.path === '/manager/instances/pair').body,
    { instanceId: local.id, agentId: local.agentId, replaceAgentToken: true })
})

test('Health reconnect uses the named existing choice and never silently chooses a Connection', async () => {
  const candidates = [{ connectionId: 'conn-old', name: 'Office', createdAt: '2026-10-01T00:00:00Z' }]
  const page = await pageFor(healthOf(cloudAgent({ connections: [], reconnectable: candidates })),
    { device: { ...device, agents: [{ ...device.agents[0], reconnectable: candidates }] } })
  await page.$('health-open').onclick(); await pressAction(page, 'Reconnect a Connection')
  assert.equal(page.$('pair').disabled, true)
  assert.match(page.$('pair-connection-options').innerHTML, /Reconnect “Office”/)
  page.$('pair-connections').onchange({ target: { name: 'reconnect-choice', checked: true, value: 'conn-old' } })
  assert.equal(page.$('pair').disabled, false)
  page.$('pair').onclick(); await settle()
  assert.equal(page.calls.find(call => call.path === '/manager/instances/pair').body.reconnectConnectionId, 'conn-old')
})

test('Health Worker start uses the existing local-tools operation and Console links use their specified tabs', async () => {
  const page = await pageFor(healthOf(cloudAgent({ connections: [{ ...cloudAgent().connections[0], workerOnline: false }],
    sources: [{ name: '<Files>', state: 'needs_relock' }], pendingCall: { tool: 'ApplyAction', phase: 'waiting', needsPerson: true } })))
  await page.$('health-open').onclick()
  const html = page.$('health-items').innerHTML
  assert.match(html, /&lt;Files&gt;/)
  assert.ok(html.includes(ORIGIN + '/console/#/agents/agent-alpha?tab=configuration'))
  assert.ok(html.includes(ORIGIN + '/console/#/agents/agent-alpha?tab=runtime'))
  await pressAction(page, 'Start Worker')
  assert.deepEqual(page.calls.find(call => call.path === '/manager/instances/worker-setting').body, { instanceId: local.id, enabled: true })
})

test('replacing an attached key reuses the same profile and model settings through encrypted pairing', async t => {
  const { manager, gateway } = await fixture(t)
  const row = await attached(manager), before = manager.registry.instance(row.id)
  const config = loadInstanceConfig(row.directory), oldToken = config.agent.env.RULITH_TOKEN
  config.agent.env.RULITH_MODEL = 'kept-model'
  config.agent.env.RULITH_MODEL_KEY = 'kept-model-key'
  saveInstanceConfig(row.directory, config)
  await assert.rejects(manager.instances.pair(row.id, { agentId: 'agent-beta', replaceAgentToken: true }), /already holds execution credentials/)
  await manager.instances.pair(row.id, { agentId: 'agent-alpha', replaceAgentToken: true })
  const after = manager.registry.instance(row.id), saved = loadInstanceConfig(row.directory)
  assert.equal(after.id, before.id)
  assert.equal(after.directory, before.directory)
  assert.equal(after.agentId, before.agentId)
  assert.equal(saved.agent.env.RULITH_MODEL, 'kept-model')
  assert.equal(saved.agent.env.RULITH_MODEL_KEY, 'kept-model-key')
  assert.notEqual(saved.agent.env.RULITH_TOKEN, oldToken)
  assert.equal(gateway.requests.filter(row => row.path === '/local-devices/pair').at(-1).body.replaceAgentToken, true)
})

test('an attached profile reconnects its named Connection and keeps its identity', async t => {
  const { manager, gateway } = await fixture(t)
  const row = await attached(manager), before = manager.registry.instance(row.id)
  gateway.setReconnectable('agent-alpha', [{ connectionId: before.connectionId, name: 'Office', createdAt: '' }])
  await manager.device.refresh()
  const oldKey = loadInstanceConfig(row.directory).worker.env.RULITH_CONNECTION_KEY
  await manager.instances.pair(row.id, { agentId: 'agent-alpha', replaceAgentToken: true, reconnectConnectionId: before.connectionId })
  assert.equal(manager.registry.instance(row.id).connectionId, before.connectionId)
  assert.notEqual(loadInstanceConfig(row.directory).worker.env.RULITH_CONNECTION_KEY, oldKey)
})

test('the existing Worker setting restarts an enabled offline instance without starting its Agent', async t => {
  const { manager } = await fixture(t)
  const row = await attached(manager), config = loadInstanceConfig(row.directory)
  config.paths = { agent: resolve(import.meta.dirname, 'support/echo-role.mjs'), worker: resolve(import.meta.dirname, 'support/echo-role.mjs') }
  saveInstanceConfig(row.directory, config)
  await manager.instances.setWorkerEnabled(row.id, true)
  const status = manager.instances.overview().find(instance => instance.id === row.id)
  assert.equal(status.worker, true)
  assert.equal(status.agent, false)
})

test('repair stops owned roles before rewriting credentials and keeps the same Agent identity', async t => {
  const { manager } = await fixture(t)
  const row = await attached(manager), config = loadInstanceConfig(row.directory)
  config.paths = { agent: resolve(import.meta.dirname, 'support/echo-role.mjs'), worker: resolve(import.meta.dirname, 'support/echo-role.mjs') }
  config.agent.env.RULITH_MODEL_URL = 'http://127.0.0.1:11434/v1'
  config.agent.env.RULITH_MODEL = 'fixture-model'
  saveInstanceConfig(row.directory, config)
  await startFixtureInstance(manager.instances, row.id)
  const oldHost = manager.instances.hosts.get(row.id).host
  assert.equal(oldHost.status().agent, true)
  assert.equal(oldHost.status().worker, true)
  await manager.instances.pair(row.id, { agentId: 'agent-alpha', replaceAgentToken: true })
  assert.equal(oldHost.status().agent, false)
  assert.equal(oldHost.status().worker, false)
  assert.equal(manager.registry.instance(row.id).agentId, 'agent-alpha')
})

test('a failed repair retains its proof and the existing Check attachment operation finishes it', async t => {
  const { manager, gateway } = await fixture(t)
  const row = await attached(manager)
  gateway.failNext('/local-devices/pair')
  await assert.rejects(manager.instances.pair(row.id, { agentId: 'agent-alpha', replaceAgentToken: true }))
  const pending = manager.registry.instance(row.id).pairing
  assert.equal(pending.repair, true)
  assert.equal(pending.replaceAgentToken, true)
  const proof = manager.instances.hosts.get(row.id).host.configFile + '.setup.json'
  const requestId = JSON.parse(readFileSync(proof, 'utf8')).requestId
  await manager.instances.pairPoll(row.id)
  assert.equal(manager.registry.instance(row.id).pairing, undefined)
  assert.equal(JSON.parse(readFileSync(proof, 'utf8')).requestId, requestId)
})

test('Health repair consent is invalidated when the account changes and never reaches another attachment', async () => {
  const page = await pageFor(healthOf(cloudAgent({ key: { state: 'revoked' } })))
  await page.$('health-open').onclick(); await pressAction(page, 'Replace key and connect')
  page.$('replace').checked = true; page.$('replace').onchange(); page.applyControls()
  page.render({ device: { ...device, account: { id: 'other' } }, instances: [local] })
  assert.equal(page.$('pair').disabled, true)
  page.$('pair').onclick(); await settle()
  assert.equal(page.calls.some(call => call.path === '/manager/instances/pair'), false)
  assert.equal(page.$('health-items').innerHTML, '')
})

test('a health refusal cannot reflect the device bearer into its recovery teaching or page', async t => {
  const { manager, gateway, get } = await fixture(t)
  const token = gateway.deviceToken(manager.device.status().deviceId)
  gateway.refuseHealth('Authorization ' + token + ' was refused')
  const reply = await get()
  assert.equal(reply.text.includes(token), false)
  assert.equal(manager.device.status().teaching.includes(token), false)
  const current = manager.state()
  const page = await runPageScript(managerPage, { respond: async () => ({ body: current }) })
  assert.equal(page.$('unusable-teaching').textContent.includes(token), false)
})

test('a response for another device cannot invalidate this device or claim its Agents', async t => {
  const { manager, gateway, get } = await fixture(t)
  gateway.setHealth({ device: { deviceId: 'other-device', state: 'revoked' }, agents: [cloudAgent()] })
  const reply = await get(), health = JSON.parse(reply.text).health
  assert.equal(health.gatewayState, 'unavailable')
  assert.equal(health.agents.length, 0)
  assert.equal(manager.device.status().state, 'linked')
})

test('ordinary state polling preserves the Health document and its expanded healthy details', async () => {
  const page = await pageFor(healthOf(cloudAgent(), [{ ...local, worker: true }]))
  await page.$('health-open').onclick()
  const node = page.$('health-items')
  let html = node.innerHTML, writes = 0
  Object.defineProperty(node, 'innerHTML', { get: () => html, set: value => { writes++; html = value } })
  await page.api('/manager/state')
  page.render()
  assert.equal(writes, 0, 'replacing the Health DOM would close expanded details and lose focus')
  assert.equal(page.calls.filter(call => call.path === '/manager/health').length, 1)
})
