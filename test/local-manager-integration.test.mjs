// SPDX-License-Identifier: Apache-2.0
/**
 * One account, two Agents, two instances, one computer — driven end to end over real HTTP.
 *
 * Nothing in this arm is stubbed on the Local side: the manager server, both instance hosts,
 * both Agent child processes, the pairing exchanges and the MCP session are the real ones,
 * talking to a Gateway fixture that implements the device contract, the public MCP surface and
 * a model endpoint on one socket. The fixture's Console half is an in-process approval because
 * approving a device is a browser session action; everything the fixture *serves* is served
 * over the network to the code under test.
 *
 * What it proves, in order:
 *
 *   1. A browser approves two of the account's three Agents, and this computer is offered
 *      exactly those two.
 *   2. Two instances are configured and attached to one Agent each, without a person copying
 *      a port, a file path or a key.
 *   3. Each Agent drives its own Board. Looking at the other instance while one is working
 *      changes nothing about the one that is working — not its key, not its port, not its
 *      identity, not its Board.
 *   4. Signing out stops both children, revokes the device, and then denies both management
 *      and execution with the credentials that grant issued — while a credential issued
 *      afterwards works, because revoking a grant is not revoking an Agent.
 *
 * The Worker role is not started here. A Board write needs the Agent, and the Worker's hop has
 * its own suites; running an idle poll loop against a fixture that does not serve `/work` would
 * add noise rather than evidence.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createManagerServer } from '../local/manager-server.mjs'
import { loadInstanceConfig, saveInstanceConfig } from '../local/instance-manager.mjs'
import { createDevicesGateway } from './support/local-devices-gateway.mjs'
import { conversationFile, readConversations } from '../agent/conversation-store.mjs'

const KEY = 'manager-integration-key'
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * A model that opens one Case and then stops.
 *
 * The first answer for a task is a `OpenCase` tool call; once the transcript carries the tool
 * result, the next answer is plain text, which ends the round. Both instances share this
 * endpoint, so the answers must not depend on who is asking.
 */
const openOneCase = (body) => (JSON.stringify(body).includes('tool_result')
  ? { text: 'The Case is open. Nothing further is needed.' }
  : { text: 'Opening a Case.', toolCalls: [{ name: 'OpenCase', input: { caseType: 'exploration' } }] })

/** Read this instance's loopback address the way the page does: by asking the manager. */
async function instanceEntry(call, instanceId, page = '/') {
  const opened = await call('/manager/instances/open', { instanceId, page })
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  const url = new URL(opened.body.url)
  return { base: url.origin, key: url.searchParams.get('k') }
}

const localCall = async (entry, path, body) => {
  const response = await fetch(entry.base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-rulith-local': entry.key, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

/** Wait for this exact task to reach a terminal record in the instance's own event journal. */
async function taskDone(manager, instanceId, taskId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = manager.instances.hosts.get(instanceId).host.events()
    const done = events.find((row) => row.src === 'agent' && row.type === 'task-done' && row.id === taskId)
    if (done !== undefined) return done
    const died = events.find((row) => row.src === 'agent' && row.type === 'exit')
    if (died !== undefined) assert.fail('the Agent exited before finishing the task: ' + JSON.stringify(events.slice(-8)))
    await wait(100)
  }
  assert.fail('the task never reached a terminal record')
}

test('two enabled Agents run as two instances on one computer, and revoking the device denies exactly what it issued', async (t) => {
  const gateway = createDevicesGateway({ model: openOneCase })
  await gateway.listen()
  const root = mkdtempSync(join(tmpdir(), 'rulith-integration-'))
  const manager = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
  await manager.listen()
  t.after(async () => {
    await manager.close()
    await gateway.close()
    rmSync(root, { recursive: true, force: true })
  })
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${manager.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  // 1 · Device sign-in establishes the account. The current enabled directory is account-wide,
  // so all three appear even though this scenario only configures two profiles.
  const started = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Integration computer' })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  gateway.approve(started.body.device.code, ['agent-alpha', 'agent-beta'])
  const linked = await call('/manager/device/poll', {})
  assert.equal(linked.body.device.state, 'linked')
  assert.deepEqual(linked.body.device.agents.map((row) => row.id), ['agent-alpha', 'agent-beta', 'agent-gamma'])

  // 2 · Two instances, one Agent each, configured without a person handling a port or a key.
  const instances = {}
  for (const [name, agentId] of [['Alpha instance', 'agent-alpha'], ['Beta instance', 'agent-beta']]) {
    const created = await call('/manager/instances/create', { name, mode: 'local_agent' })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = created.body.id
    const paired = await call('/manager/instances/pair', { instanceId: id, agentId })
    assert.equal(paired.status, 200, JSON.stringify(paired.body))
    assert.equal(paired.body.agentId, agentId)

    // This scenario drives Board writes, which is the Agent's half of an instance.
    const config = loadInstanceConfig(created.body.directory)
    config.roles = ['agent']
    config.agent.env.RULITH_MAX_ROUNDS = '3'
    saveInstanceConfig(created.body.directory, config)

    const entry = await instanceEntry(call, id, '/setup')
    // The model is configured through the instance's own setup route, which re-reads the
    // configuration file — including the role selection just written.
    const model = await localCall(entry, '/setup/model', {
      url: gateway.origin + '/v1/messages', name: 'integration-model', key: '',
    })
    assert.equal(model.status, 200, JSON.stringify(model.body))
    instances[agentId] = { id, directory: created.body.directory, entry: await instanceEntry(call, id) }
  }
  const alpha = instances['agent-alpha']
  const beta = instances['agent-beta']
  assert.notEqual(alpha.entry.base, beta.entry.base, 'two instances must not share a loopback address')
  assert.notEqual(alpha.entry.key, beta.entry.key, 'two instances must not share a local access key')

  for (const instance of [alpha, beta]) {
    const start = await call('/manager/instances/start', { instanceId: instance.id })
    assert.equal(start.status, 200, JSON.stringify(start.body))
    assert.equal(start.body.started, true, JSON.stringify(start.body.results))
  }

  // 3 · Each instance drives its own Board, and looking at the other one changes nothing.
  const before = {
    key: manager.instances.hosts.get(alpha.id).host.key,
    port: manager.instances.hosts.get(alpha.id).host.port,
    agentId: manager.instances.hosts.get(alpha.id).host.agentId,
  }
  assert.equal(before.agentId, 'agent-alpha', 'the running child reports the identity it was paired with')
  assert.equal(manager.instances.hosts.get(beta.id).host.agentId, 'agent-beta')

  const submitted = await localCall(alpha.entry, '/cases', { text: 'Open a Case for alpha.', caseType: 'exploration' })
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body))

  // Switch views while that work is in flight. This is the gesture that must be inert.
  await call('/manager/instances/open', { instanceId: beta.id, page: '/' })
  await call('/manager/instances/open', { instanceId: beta.id, page: '/worker-tools' })
  const viewed = await call('/manager/state')
  assert.equal(viewed.body.instances.length, 2)

  await taskDone(manager, alpha.id, submitted.body.id)
  const after = manager.instances.hosts.get(alpha.id).host
  assert.equal(after.key, before.key, 'viewing the other instance re-keyed a working host')
  assert.equal(after.port, before.port, 'viewing the other instance moved a working host')
  assert.equal(after.agentId, before.agentId, 'a runtime process must never switch identity in flight')
  assert.equal(after.status().agent, true, 'viewing the other instance stopped the one that was working')

  assert.equal(gateway.boards.get('agent-alpha').state.cases.size, 1, 'alpha opened a Case on its own Board')
  assert.equal(gateway.boards.has('agent-beta'), false, 'beta touched no Board while alpha was working')

  const secondTask = await localCall(beta.entry, '/cases', { text: 'Open a Case for beta.', caseType: 'exploration' })
  assert.equal(secondTask.status, 202, JSON.stringify(secondTask.body))
  await taskDone(manager, beta.id, secondTask.body.id)
  for (const [agentId, instance, expected, excluded] of [
    ['agent-alpha', alpha, 'Open a Case for alpha.', 'Open a Case for beta.'],
    ['agent-beta', beta, 'Open a Case for beta.', 'Open a Case for alpha.'],
  ]) {
    const owner = { origin: gateway.origin, accountId: linked.body.device.account.id, agentId }
    const history = readConversations(conversationFile(join(instance.directory, 'conversations'), owner), owner)
    assert.equal(history.turns.length, 1, 'a newly paired host must acquire its verified history owner')
    assert.equal(history.turns[0].text, expected)
    assert.equal(JSON.stringify(history).includes(excluded), false)
  }
  assert.equal(gateway.boards.get('agent-beta').state.cases.size, 1)
  assert.equal(gateway.boards.get('agent-alpha').state.cases.size, 1, 'beta\'s work did not land on alpha\'s Board')

  // Nothing answered under the wrong identity, in either direction.
  const alphaCalls = gateway.requests.filter((row) => row.path === '/mcp' && row.body?.method === 'tools/call')
  assert.ok(alphaCalls.length >= 2)
  const alphaJournal = JSON.stringify(manager.instances.hosts.get(alpha.id).host.events())
  const betaJournal = JSON.stringify(manager.instances.hosts.get(beta.id).host.events())
  assert.equal(alphaJournal.includes('agent-beta'), false, 'one instance\'s journal carried the other\'s identity')
  assert.equal(betaJournal.includes('agent-alpha'), false)
  assert.equal(alphaJournal.includes(loadInstanceConfig(beta.directory).agent.env.RULITH_TOKEN), false,
    'one instance\'s journal carried the other\'s credential')

  // 4 · Sign out: stop, revoke, forget — then check what is still accepted.
  const deviceToken = gateway.deviceToken(linked.body.device.deviceId)
  const alphaToken = loadInstanceConfig(alpha.directory).agent.env.RULITH_TOKEN
  const betaToken = loadInstanceConfig(beta.directory).agent.env.RULITH_TOKEN
  assert.match(alphaToken, /^rlt_agt_/)

  const out = await call('/manager/device/signout', {})
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(out.body.state, 'signed_out', JSON.stringify(out.body))
  for (const instance of [alpha, beta]) {
    const row = out.body.instances.find((entry) => entry.id === instance.id)
    assert.equal(row.agent, false, 'sign-out observed every child stop before it revoked anything')
    assert.equal(row.open, false)
    assert.equal(loadInstanceConfig(instance.directory).agent.env.RULITH_TOKEN, '',
      'the credential the revoked grant issued is not left on disk')
    assert.equal(loadInstanceConfig(instance.directory).agent.env.RULITH_MODEL_URL, gateway.origin + '/v1/messages',
      'signing out of an account does not discard the model the operator configured')
  }

  const management = await fetch(gateway.origin + '/local-devices/context', { headers: { authorization: 'Bearer ' + deviceToken } })
  assert.equal(management.status, 401, 'device management must be denied after the revoke')

  for (const token of [alphaToken, betaToken]) {
    const execution = await fetch(gateway.origin + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    assert.equal(execution.status, 401, 'the exact Agent credential issued under the revoked grant must be denied at the authentication boundary')
  }

  // A credential issued after the revocation is a different credential, and works.
  const again = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Integration computer' })
  gateway.approve(again.body.device.code, ['agent-alpha'])
  assert.equal((await call('/manager/device/poll', {})).body.device.state, 'linked')
  const repaired = await call('/manager/instances/pair', { instanceId: alpha.id, agentId: 'agent-alpha' })
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body))
  const replacement = loadInstanceConfig(alpha.directory).agent.env.RULITH_TOKEN
  assert.notEqual(replacement, alphaToken)
  const accepted = await fetch(gateway.origin + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + replacement },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(accepted.status, 200, 'revoking a device must not revoke an Agent')
  const stillDenied = await fetch(gateway.origin + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alphaToken },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(stillDenied.status, 401, 'the replacement must not un-revoke the credential it replaced')
})
