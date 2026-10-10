// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { conversationFile, openConversations, readConversations, readUnreadOutcomes, conversationList } from '../agent/conversation-store.mjs'
import { runAgent, freePort, callTool, declareGoal, TEST_AGENT_ID } from './support/agent-harness.mjs'
const ROLE = resolve(import.meta.dirname, 'support/lifecycle-role.mjs')
const until = async (check, timeout = 8000) => {
  const end = Date.now() + timeout
  while (!check()) { if (Date.now() > end) throw new Error('Fixture condition timed out'); await new Promise(r => setTimeout(r, 15)) }
}
async function hostFixture(t, { enabled = false, agentEnv = {}, workerEnv = {}, delays = [30, 70], hostOptions = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-011-')), log = join(root, 'roles.jsonl'), file = join(root, 'local.json')
  const cfg = defaultLocalConfig()
  cfg.paths = { agent: ROLE, worker: ROLE }
  cfg.agent.env = { ...cfg.agent.env, RULITH_SERVE_PORT: String(await freePort()), RULITH_TEST_LIFECYCLE_LOG: log, ...agentEnv }
  cfg.worker = { enabled, env: { RULITH_CONNECTION: 'test-connection', RULITH_CONNECTION_KEY: 'test-key',
    RULITH_TOOLS_FILE: join(root, 'tools.json'), RULITH_SECRETS_FILE: join(root, 'vault.json'), RULITH_WORKER_ROOT: root,
    RULITH_TEST_LIFECYCLE_LOG: log, ...workerEnv } }
  writeFileSync(file, JSON.stringify(cfg))
  const host = createLocalHost({ configFile: file, config: cfg, roles: cfg.roles, port: 0, isolateEnvironment: true,
    workerRestartDelays: delays, startConfirmMs: 3000, ...hostOptions })
  await host.listen()
  t.after(async () => { await host.close(); await until(() => host.children().length === 0); rmSync(root, { recursive: true, force: true }) })
  const rows = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${host.port}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rulith-local': host.key }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  return { host, rows, post, root, file }
}

const registered = receipt => ({ state: 'registered', agentId: receipt.agent,
  submissionId: receipt.submissionId, requestId: receipt.requestId, sessionKey: receipt.sessionKey,
  proofDigest: receipt.proofDigest, selectionDigest: receipt.selectionDigest,
  attachments: receipt.attachments, registeredAt: new Date().toISOString() })
const addMaterial = post => post('/materials', { name: 'fixture.txt', mediaType: 'text/plain',
  bytes: Buffer.from('fixture').toString('base64') })

test('failed first-message Agent startup creates no material registration', async t => {
  const registrations = []
  const { host, post } = await hostFixture(t, { agentEnv: { RULITH_TEST_EXIT_CODE: '3' },
    hostOptions: { conversationOwner: { origin: 'http://localhost:9', accountId: 'fixture', agentId: 'test-agent' },
      registerMaterialSubmission: async receipt => { registrations.push(receipt); return registered(receipt) } } })
  const added = await addMaterial(post)
  assert.equal(added.body.ok, true, JSON.stringify(added))
  const sent = await post('/cases', { text: 'read this', sessionKey: 'one', requestId: 'failed-start-click-001',
    attachments: [added.body.material.id] })
  assert.equal(sent.body.ok, false)
  assert.match(sent.body.teaching, /exited during startup/)
  assert.equal(registrations.length, 0)
  assert.equal(host.status().agent, false)
})

test('material submission identity comes from the Agent process rather than the conversation owner', async t => {
  const registrations = []
  const { host, post } = await hostFixture(t, { hostOptions: {
    conversationOwner: { origin: 'http://localhost:9', accountId: 'fixture', agentId: 'registry-agent' },
    registerMaterialSubmission: async receipt => { registrations.push(receipt); return registered(receipt) },
  } })
  assert.equal(host.agentId, 'unconfigured')
  const added = await addMaterial(post)
  assert.equal(added.body.ok, true, JSON.stringify(added))
  const sent = await post('/cases', { text: 'read this', sessionKey: 'one', requestId: 'process-id-click-001',
    attachments: [added.body.material.id] })
  assert.equal(sent.status, 202, JSON.stringify(sent))
  assert.equal(registrations[0].agent, 'test-agent')
  assert.equal(sent.body.submissionReceipt.agent, host.agentId)
  assert.notEqual(sent.body.submissionReceipt.agent, 'registry-agent')
})

test('Worker credential rejection stops automatic retries and reports needs setup', async t => {
  const { host, rows, post } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_EXIT_CODE: '3' } })
  await until(() => !!host.status().workerSetting.failure)
  assert.equal(host.status().workerSetting.state, 'needs setup')
  assert.match(host.status().workerSetting.failure, /credential was rejected/)
  assert.equal(host.status().workerSetting.retryAt, null)
  await new Promise(done => setTimeout(done, 150))
  await post('/setup/pair/poll', {})
  await host.resumeWorker()
  assert.equal(rows().filter(row => row.type === 'spawn').length, 1)
})

test('a message racing an Agent reload retries one refused task after the drain with the same request', async t => {
  const { host, rows, post } = await hostFixture(t, { agentEnv: { RULITH_TEST_TURN_MS: '350' } })
  assert.equal((await post('/cases', { text: 'first', sessionKey: 'one' })).status, 202)
  const originalFetch = globalThis.fetch
  let triggered = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/task') && JSON.parse(options.body).text === 'racing' && !triggered) {
      triggered = true
      host.setAgentModel({ url: 'http://localhost:9/v1', name: 'replacement' })
      await until(() => rows().some(row => row.role === 'agent' && row.type === 'drain'))
    }
    return originalFetch(url, options)
  })
  const sent = await post('/cases', { text: 'racing', sessionKey: 'one', requestId: 'reload-race-click-001' })
  assert.equal(sent.status, 202, JSON.stringify(sent))
  assert.equal(triggered, true)
  const refused = rows().filter(row => row.type === 'task-refused')
  const accepted = rows().filter(row => row.type === 'turn-start' && row.body.text === 'racing')
  assert.equal(refused.length, 1)
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0].body, refused[0].body)
  assert.notEqual(accepted[0].pid, refused[0].pid)
})

test('the host turn-stop route requires its page key and same origin before forwarding the conversation scope', async t => {
  const { host, rows, post } = await hostFixture(t)
  const url = `http://127.0.0.1:${host.port}`
  const stop = async (headers, query = '') => {
    const response = await fetch(url + '/turn/stop' + query, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sessionKey: 'one', id: 'turn-one' }) })
    return response.status
  }
  assert.equal(await stop({}), 401)
  assert.equal(await stop({}, '?k=' + host.key), 403, 'the mutation requires the header, not just a page URL key')
  assert.equal((await post('/cases', { text: 'first', sessionKey: 'one' })).status, 202)
  assert.equal(await stop({ 'x-rulith-local': 'wrong-key' }), 401)
  assert.equal(await stop({ 'x-rulith-local': host.key, origin: 'https://evil.example' }), 403)
  assert.equal(rows().filter(row => row.type === 'turn-stop').length, 0)
  assert.equal(await stop({ 'x-rulith-local': host.key, origin: url }), 200)
  const forwarded = rows().filter(row => row.type === 'turn-stop')
  assert.equal(forwarded.length, 1)
  assert.equal(forwarded[0].authorized, true, 'the host uses the Agent service key for the proxy hop')
  assert.deepEqual(forwarded[0].body, { sessionKey: 'one', id: 'turn-one' })
})

for (const busy of [false, true]) {
  test(`explicit stop bounds the graceful Agent ${busy ? 'held turn' : 'session cleanup'} and observes its forced exit`, async t => {
    const { host, post, rows } = await hostFixture(t, { agentEnv: {
      RULITH_TEST_TURN_MS: '30000', RULITH_TEST_DRAIN_MS: '30000' } })
    if (busy) await post('/cases', { text: 'held', sessionKey: 'one' })
    else await host.startRole('agent')
    const answer = await host.stopRole('agent', { forceAfterDrain: true, stopWaitMs: 60 })
    assert.equal(answer.body.state, 'stopped', JSON.stringify(answer))
    assert.equal(answer.body.forced, true)
    assert.match(answer.body.teaching, /killed after the graceful drain bound/)
    assert.ok(rows().some(row => row.type === 'drain'))
    assert.equal(rows().some(row => row.type === 'exit'), false, 'the child did not finish graceful cleanup')
    assert.equal(host.children().length, 0)
  })
}

test('enabling tools again during off-drain starts one replacement; close cancels a pending reload', async t => {
  const { host, rows, post } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_DRAIN_MS: '250' } })
  await until(() => host.status().workerSetting.state === 'online')
  await post('/worker-setting', { enabled: false })
  await post('/worker-setting', { enabled: true })
  await until(() => rows().filter(r => r.role === 'worker' && r.type === 'spawn').length === 2
    && !host.status().workerSetting.reloading && host.status().workerSetting.state === 'online')
  assert.equal(host.status().workerSetting.state, 'online')
  await post('/worker-setting', { enabled: false })
  await post('/worker-setting', { enabled: true })
  await host.close()
  await until(() => host.children().length === 0)
  await new Promise(r => setTimeout(r, 100))
  assert.equal(rows().filter(r => r.role === 'worker' && r.type === 'spawn').length, 2)
})

test('Worker status uses its reported availability, including offline lease and setup refusal', async t => {
  const { host } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_AVAILABILITY: JSON.stringify([
    { after: 120, state: 'online' }, { after: 280, state: 'offline' }, { after: 440, state: 'needs setup' },
  ]) } })
  await until(() => host.status().worker && host.status().workerSetting.state === 'offline')
  await until(() => host.status().workerSetting.state === 'online')
  await until(() => host.status().workerSetting.state === 'offline')
  await until(() => host.status().workerSetting.state === 'needs setup')
})

test('a Worker readiness event alone never claims Gateway availability', async t => {
  const { host } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_NO_AVAILABILITY: '1' } })
  await until(() => host.status().worker && host.events().some(e => e.src === 'worker' && e.type === 'up'))
  assert.equal(host.status().workerSetting.state, 'offline')
})

test('workspace tools reveal the setting without enabling it; an existing client keeps setting and status', async t => {
  const { host } = await hostFixture(t, { workerEnv: { RULITH_WORKSPACE_TOOLS: 'read' } })
  assert.equal(host.status().workerSetting.visible, true)
  assert.equal(host.status().workerSetting.enabled, false)
  const cfg = defaultLocalConfig(); cfg.roles = ['worker']
  const root = mkdtempSync(join(tmpdir(), 'runtime-011-client-'))
  const client = createLocalHost({ configFile: join(root, 'local.json'), config: cfg, roles: ['worker'], port: 0,
    isolateEnvironment: true })
  await client.listen()
  t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }) })
  assert.equal(client.status().workerSetting.visible, true)
  assert.equal(client.status().workerSetting.enabled, false)
  assert.equal(client.status().workerSetting.state, 'needs setup')
})

test('model edits while a turn drains coalesce and the replacement uses the latest model', async t => {
  const { host, rows, post } = await hostFixture(t, { agentEnv: { RULITH_TEST_TURN_MS: '350' } })
  await post('/cases', { text: 'first', sessionKey: 'one' })
  await post('/setup/model', { url: 'http://localhost:9/v1', name: 'intermediate', key: '' })
  await post('/setup/model', { url: 'http://localhost:9/v1', name: 'latest', key: '' })
  await until(() => rows().filter(r => r.role === 'agent' && r.type === 'spawn').length === 2
    && !host.status().agentReloading)
  assert.equal(rows().filter(r => r.role === 'agent' && r.type === 'spawn')[1].model, 'latest')
  await new Promise(r => setTimeout(r, 100))
  assert.equal(rows().filter(r => r.role === 'agent' && r.type === 'spawn').length, 2)
})

test('adding a local file reveals the per-Agent tools setting without enabling it or starting a Worker', async t => {
  const { host, post, rows } = await hostFixture(t)
  await post('/cases', { text: 'hello', sessionKey: 'one' })
  assert.equal(host.status().workerSetting.visible, false)
  const stored = await post('/materials', { name: 'fixture.txt', mediaType: 'text/plain', bytes: Buffer.from('fixture').toString('base64') })
  assert.equal(stored.body.ok, true, JSON.stringify(stored))
  assert.equal(host.status().workerSetting.visible, true)
  assert.equal(host.status().workerSetting.enabled, false)
  assert.equal(host.status().worker, false)
  assert.equal(rows().some(r => r.role === 'worker'), false)
})

test('manifest save/remove and MCP probe/apply/remove work with both roles running and reload only the Worker', async t => {
  const { host, post, rows, root } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_DRAIN_MS: '80' } })
  await until(() => host.status().workerSetting.state === 'online')
  await post('/cases', { text: 'hello', sessionKey: 'one' })
  const agent = host.children().find(c => c.role === 'agent').pid
  let workerStarts = 1
  const view = () => fetch(`http://127.0.0.1:${host.port}/worker-tools/state`,
    { headers: { 'x-rulith-local': host.key } }).then(r => r.json())
  const changed = async (path, body) => {
    const saved = await post(path, body)
    assert.equal(saved.body.ok, true, JSON.stringify(saved))
    assert.match(saved.body.teaching, /reloads automatically/)
    workerStarts += 1
    await until(() => rows().filter(r => r.role === 'worker' && r.type === 'spawn').length === workerStarts
      && !host.status().workerSetting.reloading)
    assert.equal(host.children().find(c => c.role === 'agent').pid, agent)
  }
  await changed('/worker-tools/save', { id: 'test.http@1', revision: (await view()).revision,
    definition: { adapter: 'http', sourceTypes: ['http'], entry: '/items', fence: { method: 'GET' }, params: {}, returns: [] } })
  await changed('/worker-tools/remove', { id: 'test.http@1', revision: (await view()).revision })
  const probed = await post('/mcp-services/probe', { name: 'mail', mode: 'stdio', command: process.execPath,
    args: [resolve(import.meta.dirname, 'support/local-mcp-server.mjs')], env: { MCP_FIXTURE_LOG: join(root, 'mcp-calls.jsonl') } })
  assert.equal(probed.body.ok, true, JSON.stringify(probed))
  assert.equal(rows().filter(r => r.role === 'worker' && r.type === 'spawn').length, workerStarts)
  await changed('/mcp-services/apply', { probeId: probed.body.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  await changed('/mcp-services/remove', { name: 'mail' })
  assert.equal(existsSync(join(root, 'mcp-calls.jsonl')), false, 'configuration never executes an MCP business tool')
})
test('first message starts one Agent automatically; idle chat Agents default to no Worker controls', async t => {
  const { host, post, rows } = await hostFixture(t)
  assert.equal(host.status().agent, false)
  assert.equal(host.status().workerSetting.visible, false)
  const replies = await Promise.all([post('/cases', { text: 'first', sessionKey: 'one' }), post('/cases', { text: 'second', sessionKey: 'two' })])
  assert.ok(replies.every(r => r.body.ok), JSON.stringify(replies))
  assert.equal(rows().filter(r => r.role === 'agent' && r.type === 'spawn').length, 1)
  assert.ok(host.events().some(e => e.type === 'agent-starting' && e.note === 'Starting…'))
})
test('model save during a turn restarts the Agent only after the turn; next message uses the new model', async t => {
  const { host, post, rows } = await hostFixture(t, { agentEnv: { RULITH_TEST_TURN_MS: '300' } })
  await post('/cases', { text: 'first', sessionKey: 'one' })
  const pid = host.children().find(c => c.role === 'agent').pid
  const saved = await post('/setup/model', { url: 'http://localhost:9/v1', name: 'replacement-model', key: '' })
  assert.equal(saved.body.ok, true, JSON.stringify(saved))
  assert.equal(host.children().find(c => c.role === 'agent').pid, pid)
  await until(() => rows().filter(r => r.type === 'spawn' && r.role === 'agent').length === 2)
  const oldDone = rows().find(r => r.type === 'turn-done' && r.pid === pid)
  const newStart = rows().find(r => r.type === 'spawn' && r.pid !== pid && r.role === 'agent')
  assert.ok(newStart.at >= oldDone.at)
  assert.equal(newStart.model, 'replacement-model')
  assert.ok((await post('/cases', { text: 'next', sessionKey: 'one' })).body.ok)
})
test('enabled Worker starts with Rulith, setting persists, and off drains and stops it', async t => {
  const { host, post, file } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_DRAIN_MS: '120' } })
  await until(() => host.status().workerSetting.state === 'online')
  assert.equal(host.status().agent, false)
  assert.equal((await post('/worker-setting', { enabled: false })).body.ok, true)
  assert.equal(JSON.parse(readFileSync(file)).worker.enabled, false)
  await until(() => !host.status().worker)
  assert.equal(host.status().workerSetting.state, 'offline')
  await new Promise(r => setTimeout(r, 120))
  assert.equal(host.status().worker, false)
})
test('Worker crashes restart with bounded backoff, then give up until the setting is enabled again', async t => {
  const { host, rows, post } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_CRASH_MS: '25' } })
  await until(() => !!host.status().workerSetting.failure)
  const starts = rows().filter(r => r.type === 'spawn'), crashes = rows().filter(r => r.type === 'crash')
  assert.equal(starts.length, 3)
  assert.ok(starts[1].at - crashes[0].at >= 30)
  assert.ok(starts[2].at - crashes[1].at >= 70)
  assert.match(host.status().workerSetting.failure, /repeatedly exited/)
  assert.equal(host.status().workerSetting.state, 'offline')
  assert.equal((await post('/setup/pair/poll', {})).body.ok, true)
  await new Promise(r => setTimeout(r, 150))
  assert.equal(rows().filter(r => r.type === 'spawn').length, 3, 'an unchanged setup poll cannot resume exhausted retries')
  assert.equal((await post('/worker-setting', { enabled: true })).body.ok, true)
  await until(() => !!host.status().workerSetting.failure)
  assert.equal(rows().filter(r => r.type === 'spawn').length, 6, 'enabling the setting again admits one bounded retry sequence')
})
test('tool changes reload the Worker after execution drain and leave the Agent running', async t => {
  const { host, post, rows } = await hostFixture(t, { enabled: true, workerEnv: { RULITH_TEST_DRAIN_MS: '150' } })
  await until(() => host.status().workerSetting.state === 'online')
  await post('/cases', { text: 'hello', sessionKey: 'one' })
  const agent = host.children().find(c => c.role === 'agent').pid
  const worker = host.children().find(c => c.role === 'worker').pid
  const view = await fetch(`http://127.0.0.1:${host.port}/worker-tools/state`, { headers: { 'x-rulith-local': host.key } }).then(r => r.json())
  const saved = await post('/worker-tools/workspace', { mode: 'off', revision: view.revision })
  assert.equal(saved.body.ok, true, JSON.stringify(saved))
  assert.match(saved.body.teaching, /reloads automatically/)
  assert.equal(host.children().find(c => c.role === 'worker').pid, worker)
  await until(() => rows().filter(r => r.role === 'worker' && r.type === 'spawn').length === 2)
  assert.equal(host.children().find(c => c.role === 'agent').pid, agent)
  const oldExit = rows().find(r => r.role === 'worker' && r.type === 'exit')
  assert.ok(rows().filter(r => r.role === 'worker' && r.type === 'spawn')[1].at >= oldExit.at)
})
async function serveFixture(t, options, run) {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-011-history-'))
  const owner = { origin: 'http://localhost:9', accountId: 'fixture-account', agentId: TEST_AGENT_ID }
  const port = await freePort(), key = 'runtime-011-serve-key'
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = await runAgent({ argv: ['--serve'], captureLocalEvents: true, waitForServeReady: true, stopAfterServe: true,
    ...options,
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: key,
      RULITH_CONVERSATION_DIR: directory, RULITH_CONVERSATION_OWNER: JSON.stringify(owner), ...options.env },
    onServeReady: async fixture => {
      const post = async (path, body, headers = {}) => {
        const r = await fetch(fixture.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-serve': key, ...headers }, body: JSON.stringify(body) })
        return { status: r.status, body: await r.json() }
      }
      await run({ ...fixture, post, historyFile: conversationFile(directory, owner), owner })
    } })
  return { result, history: readConversations(conversationFile(directory, owner), owner),
    unread: readUnreadOutcomes(conversationFile(directory, owner), owner) }
}

for (const outcome of ['conversation', 'stopped', 'interrupted', 'user-stopped']) {
  test(`status polls after restoring a ${outcome} turn observe Board work only for an explicit user stop`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-011-restored-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const owner = { origin: 'http://localhost:9', accountId: 'fixture-account', agentId: TEST_AGENT_ID }
    const at = '2026-10-04T00:00:00Z'
    const store = await openConversations(directory, owner)
    try {
      store.accept({ id: 'earlier-turn', sessionKey: 'one', text: 'Earlier work', at: Date.now(), attachments: [] },
        { ok: true, id: 'earlier-turn', sessionKey: 'one' }, '', '')
      store.start('earlier-turn')
      if (outcome !== 'interrupted') store.finish('earlier-turn', 'Earlier turn ended.', outcome)
      store.saveUnreadOutcomes({ one: [{ tool: 'ApplyAction', label: 'ApplyAction fixture.work', at, state: 'running', unread: false }] })
    } finally { store.close() }
    const userStopped = outcome === 'user-stopped'
    const run = await runAgent({ argv: ['--serve'], captureLocalEvents: true, waitForServeReady: true, stopAfterServe: true,
      env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'restored-turn-key',
        RULITH_CONVERSATION_DIR: directory, RULITH_CONVERSATION_OWNER: JSON.stringify(owner) },
      priorOperations: [{ tool: 'ApplyAction', label: 'ApplyAction fixture.work', at, state: 'done', acked: false,
        core: { accepted: true, result: { marker: 'settled-work-content' } } }],
      model: () => 'Hello.',
      onServeReady: async ({ url, key, child, toolCalls, localEvents, modelRequests }) => {
        // /status sends observe over this IPC channel; standalone /runs uses the same gate.
        child.send({ protocol: 'rulith-local-control', operation: 'observe' })
        for (let poll = 0; poll < 3; poll++) {
          await fetch(url + '/runs', { headers: { 'x-rulith-serve': key } }).then(r => r.json())
          await new Promise(done => setTimeout(done, 40))
        }
        if (userStopped) await until(() => toolCalls.some(call => call.name === 'QueryBoard'))
        else assert.equal(toolCalls.length, 0, 'a restored ordinary turn does not authorize a host QueryBoard')
        assert.equal(modelRequests.length, 0)
        const response = await fetch(url + '/task', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rulith-serve': key },
          body: JSON.stringify({ text: 'Just say hello.', sessionKey: 'one' }) })
        const task = await response.json()
        assert.equal(response.status, 202, JSON.stringify(task))
        await until(() => localEvents.some(event => event.type === 'task-done' && event.id === task.id))
        if (!userStopped) assert.doesNotMatch(JSON.stringify(modelRequests[0]), /settled-work-content|observed work from a stopped turn/)
      } })
    assert.equal(run.modelRequests.length, 1)
    assert.deepEqual(run.verbs, userStopped ? ['QueryBoard'] : [])
    if (!userStopped) assert.equal(run.pings, 0, 'polling alone cannot ping the Board for an ordinary restored turn')
  })
}
test('Stop aborts the model at once, records a user stop, and leaves another conversation unaffected', async t => {
  let aborted = false
  const { result, history } = await serveFixture(t, {
    model: async (n, input, { response }) => {
      if (n > 1) return 'Other conversation answered.'
      await new Promise(done => response.once('close', () => { aborted = true; done() }))
      return 'must not be delivered'
    },
  }, async ({ post, localEvents, modelRequests }) => {
    const a = await post('/task', { text: 'first', sessionKey: 'one' })
    await until(() => modelRequests.length === 1)
    const b = await post('/task', { text: 'other', sessionKey: 'two' })
    assert.equal((await post('/turn/stop', { sessionKey: 'missing' })).body.state, 'idle')
    assert.equal((await post('/turn/stop', { sessionKey: 'one', id: a.body.id })).body.state, 'stopping')
    await until(() => aborted && localEvents.some(e => e.type === 'task-done' && e.id === b.body.id))
  })
  assert.equal(result.modelRequests.length, 2)
  assert.equal(history.turns.find(t => t.sessionKey === 'one').outcome, 'user-stopped')
  assert.match(history.turns.find(t => t.sessionKey === 'one').note, /Stopped by the user/)
  assert.equal(history.turns.find(t => t.sessionKey === 'two').outcome, 'conversation')
})
test('Stop waits for an in-flight held Rulith answer, records it, and makes no further model call', async t => {
  const { result, history, unread } = await serveFixture(t, {
    model: () => callTool('ApplyBatch', declareGoal()),
    hold: name => name === 'ApplyBatch' ? { answer: 'running', holdMs: 150,
      settle: seen => seen.pings >= 2 ? { state: 'done' } : undefined } : undefined,
  }, async ({ post, localEvents, toolCalls }) => {
    const task = await post('/task', { text: 'work', sessionKey: 'one' })
    await until(() => toolCalls.length > 0)
    await post('/turn/stop', { sessionKey: 'one', id: task.body.id })
    await until(() => localEvents.some(e => e.type === 'task-done' && e.id === task.body.id))
  })
  assert.equal(result.modelRequests.length, 1)
  assert.ok(result.localEvents.some(e => e.type === 'tool-result' && e.cmd === 'ApplyBatch' && e.authoritative))
  assert.equal(history.turns[0].outcome, 'user-stopped')
  assert.ok(unread.one?.some(e => e.tool === 'ApplyBatch' && e.state === 'done' && e.unread), JSON.stringify(unread))
})
test('turn Stop requires serve authentication, local Host/Origin, valid scope and current turn identity', async t => {
  await serveFixture(t, {}, async ({ post, url, key }) => {
    assert.equal((await post('/turn/stop', { sessionKey: 'one' }, { 'x-rulith-serve': '' })).status, 403)
    assert.equal((await post('/turn/stop', { sessionKey: 'one' }, { origin: 'https://evil.example' })).status, 403)
    const status = await new Promise((accept, reject) => {
      const req = request(url + '/turn/stop', { method: 'POST', headers: { host: 'evil.example', 'x-rulith-serve': key } }, res => { res.resume(); accept(res.statusCode) })
      req.on('error', reject); req.end(JSON.stringify({ sessionKey: 'one' }))
    })
    assert.equal(status, 403)
    assert.equal((await post('/turn/stop', { sessionKey: 1 })).status, 400)
    assert.equal((await post('/turn/stop', { sessionKey: 'one', global: true })).status, 400)
    assert.equal((await post('/turn/stop', { sessionKey: 'one', id: 'old-turn' })).body.state, 'idle')
  })
})

test('a stopped Action settles later in operations without another model call or an unread-result acknowledgement', async t => {
  let finishAction = false
  const { result, unread } = await serveFixture(t, {
    env: { RULITH_HOST_WAIT_MS: '0' },
    model: n => n === 1 ? callTool('ApplyBatch', declareGoal()) : callTool('ApplyAction', { action: 'action-1' }),
    hold: name => name === 'ApplyAction' ? { answer: 'running', holdMs: 180,
      settle: () => finishAction ? { state: 'done' } : undefined } : undefined,
  }, async ({ post, url, key, localEvents, toolCalls, modelRequests, historyFile, owner }) => {
    const task = await post('/task', { text: 'work', sessionKey: 'one' })
    await until(() => toolCalls.some(call => call.name === 'ApplyAction'))
    await post('/turn/stop', { sessionKey: 'one', id: task.body.id })
    await until(() => localEvents.some(e => e.type === 'task-done' && e.id === task.body.id))
    finishAction = true
    await fetch(url + '/runs', { headers: { 'x-rulith-serve': key } }).then(r => r.json())
    await until(() => readUnreadOutcomes(historyFile, owner).one?.some(e => e.tool === 'ApplyAction' && e.state === 'done' && e.unread))
    assert.ok(toolCalls.some(call => call.name === 'QueryBoard'))
    assert.ok(localEvents.some(e => e.type === 'operations' && e.operations.some(op => op.tool === 'ApplyAction' && op.state === 'done')))
    const reads = toolCalls.length
    await fetch(url + '/runs', { headers: { 'x-rulith-serve': key } }).then(r => r.json())
    await new Promise(r => setTimeout(r, 50))
    assert.equal(toolCalls.length, reads, 'the outcome is kept until a model has read it')
    assert.equal(modelRequests.length, 2)
  })
  assert.equal(result.modelRequests.length, 2)
  assert.ok(unread.one?.some(e => e.tool === 'ApplyAction' && e.state === 'done' && e.unread), JSON.stringify(unread))
})

test('Stop removes one queued turn and applies its pending archive while another conversation keeps running', async t => {
  const { history } = await serveFixture(t, {
    model: async (n, input, { response }) => {
      await new Promise(done => response.once('close', done))
      return 'must not be delivered'
    },
  }, async ({ post, modelRequests, localEvents }) => {
    const first = await post('/task', { text: 'busy', sessionKey: 'one' })
    await until(() => modelRequests.length === 1)
    const queued = await post('/task', { text: 'queued', sessionKey: 'two' })
    const archived = await post('/conversation/archive', { sessionKey: 'two', archived: true })
    assert.equal(archived.body.state, 'pending')
    assert.equal((await post('/turn/stop', { sessionKey: 'two', id: queued.body.id })).body.state, 'stopped')
    assert.ok(localEvents.some(e => e.type === 'conversation-archived' && e.session === 'two'))
    assert.equal(modelRequests.length, 1)
    assert.equal(localEvents.some(e => e.type === 'task-done' && e.id === first.body.id), false)
    await post('/turn/stop', { sessionKey: 'one', id: first.body.id })
    await until(() => localEvents.some(e => e.type === 'task-done' && e.id === first.body.id))
  })
  assert.equal(history.turns.find(t => t.sessionKey === 'two').outcome, 'user-stopped')
  assert.equal(conversationList(history, { archived: true }).items[0].sessionKey, 'two')
})
