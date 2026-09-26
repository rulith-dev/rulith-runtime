// SPDX-License-Identifier: Apache-2.0
/**
 * Several Local instances on one computer, and the separations that make them several.
 *
 * Each arm drives the real manager: real registry writes, real hosts on real loopback
 * sockets, real child processes, real pairing against the device-contract fixture. The
 * stand-in for the Agent and Worker reports the environment it was actually given, so the
 * isolation arms assert against what a child received rather than against what this host
 * meant to pass it.
 *
 * Instances here are *attached* before they are started, because that is now the rule: a
 * managed instance runs under a device grant, and both the manager's own endpoints and the
 * instance host's `/control` and `/setup` routes consult that grant rather than trusting
 * whoever holds a loopback key.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Socket, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createManagerServer, localAuthoringSaveRequestId, localAuthoringResultVersions } from '../local/manager-server.mjs'
import { processAlive } from '../local/manager-registry.mjs'
import { loadInstanceConfig, saveInstanceConfig } from '../local/instance-manager.mjs'
import { isolatedEnvironmentBase } from '../local/rulith-local.mjs'
import { materialDeviceFingerprint, materialIdentity, openMaterialStore } from '../worker/material-store.mjs'
import { authoringNode, proposalDigest, recordLocalAuthoringResult } from '../worker/local-authoring.mjs'
import { createDevicesGateway } from './support/local-devices-gateway.mjs'

const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex')

const ECHO = resolve(import.meta.dirname, 'support', 'echo-role.mjs')
const TASK_AGENT = resolve(import.meta.dirname, 'support', 'task-agent.mjs')
const ORPHAN_PARENT = resolve(import.meta.dirname, 'support', 'orphan-parent.mjs')
const KEY = 'manager-instance-key'
const AGENTS = ['agent-alpha', 'agent-beta', 'agent-gamma']

test('private-save request identity survives a retry and changes with the certified proposal', () => {
  const proposal = { accountId: 'account-1', agentId: 'agent-1', caseId: 'case-1', materialId: 'mat_' + 'a'.repeat(32),
    documentDigest: 'sha256:' + 'b'.repeat(64), proposalDigest: 'sha256:' + 'c'.repeat(64) }
  const first = localAuthoringSaveRequestId(proposal)
  assert.match(first, /^local-save:[0-9a-f]{64}$/)
  assert.equal(localAuthoringSaveRequestId({ ...proposal }), first)
  for (const field of Object.keys(proposal)) {
    assert.notEqual(localAuthoringSaveRequestId({ ...proposal, [field]: proposal[field] + '-different' }), first, field)
  }
})

test('checked authoring versions are ordered, deduplicated and scoped to the selected Agent', () => {
  const identity = { profile: 'agent-one-profile', owner: 'agent-one-owner' }
  const first = { ...identity, resultId: 'res_' + '1'.repeat(32), materialId: 'mat_' + 'a'.repeat(32),
    custodyId: 'mat_' + 'a'.repeat(32), documentDigest: 'sha256:' + 'a'.repeat(64), node: 'node_' + 'a'.repeat(32),
    resultDigest: 'sha256:' + 'a'.repeat(64), proposalDigest: 'sha256:' + 'b'.repeat(64), checkedAt: '2026-09-25T10:00:00Z' }
  const second = { ...identity, resultId: 'res_' + '2'.repeat(32), materialId: 'mat_' + 'c'.repeat(32),
    custodyId: 'mat_' + 'c'.repeat(32), documentDigest: 'sha256:' + 'c'.repeat(64), node: 'node_' + 'c'.repeat(32),
    resultDigest: 'sha256:' + 'c'.repeat(64), proposalDigest: 'sha256:' + 'd'.repeat(64), checkedAt: '2026-09-25T11:00:00Z' }
  const { owned, availableResults } = localAuthoringResultVersions([first,
    { ...first, owner: 'another-agent', resultId: 'res_' + '3'.repeat(32) },
    { ...first, resultId: 'invalid', checkedAt: '2026-09-26T00:00:00Z' },
    { ...first, resultId: 'res_' + '4'.repeat(32), materialId: 42, checkedAt: '2026-09-26T00:00:00Z' },
    { ...first, resultId: 'res_' + '5'.repeat(32), resultDigest: undefined, checkedAt: '2026-09-27T00:00:00Z' }, second, first], identity)
  assert.equal(owned.length, 3, 'malformed same-Agent rows cannot become the default selected result')
  assert.deepEqual(availableResults.map(row => row.resultId), [second.resultId, first.resultId])
  assert.equal(JSON.stringify(availableResults).includes('another-agent'), false)
  const revisions = Array.from({ length: 205 }, (_, i) => ({ ...first,
    resultId: `res_${i.toString(16).padStart(32, '0')}`,
    checkedAt: new Date(Date.UTC(2026, 8, 25) + i * 1000).toISOString() }))
  const recent = localAuthoringResultVersions(revisions, identity)
  assert.equal(recent.availableResults.length, 200)
  assert.equal(recent.availableResults[0].resultId, revisions.at(-1).resultId)
  const restored = localAuthoringResultVersions(revisions, identity, revisions[0].resultId)
  assert.equal(restored.availableResults.length, 201)
  assert.equal(restored.availableResults.at(-1).resultId, revisions[0].resultId,
    'an explicitly named older result remains reviewable after more than 200 checks')
})

test('manager reopens an older checked result after newer checks without changing its material or proposal', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await addInstance(manager, 'Document versions', { agentId: 'agent-alpha' })
    const identity = materialIdentity({ configFile: join(instance.directory, 'local.json'),
      gatewayUrl: gateway.origin, connectionId: manager.instances.overview().find(row => row.id === instance.id).connectionId,
      agentId: 'agent-alpha', modelUrl: 'http://127.0.0.1:11434/v1' })
    const root = join(instance.directory, 'materials')
    const store = openMaterialStore(root, identity)
    const material = store.put({ name: 'rules.txt', mediaType: 'text/plain', bytes: Buffer.from('Original policy text') })
    store.submitSelected(material.uiHandle, { sessionKey: 'version-case' })
    const drafts = Array.from({ length: 205 }, (_, i) => ({ program: { id: `p${i}`, title: `Version ${i}` },
      caseContracts: [], citations: [], examples: [] }))
    const records = await Promise.all(drafts.map(async (draft, i) => {
      const candidate = proposalDigest(draft)
      const result = store.putResult({ name: `check-${i}.json`, mediaType: 'application/json', encoding: 'utf8',
        bytes: Buffer.from(JSON.stringify({ draft, report: { proposalDigest: candidate, compiled: true } })) })
      await recordLocalAuthoringResult(root, { profile: identity.profile, owner: identity.owner,
        materialId: material.selector, custodyId: material.id, documentDigest: material.digest,
        node: authoringNode(material.selector, material.digest), proposalDigest: candidate,
        resultId: result.id, resultDigest: result.digest,
        checkedAt: new Date(Date.UTC(2026, 8, 25) + i * 1000).toISOString() })
      return result
    }))
    const review = async resultId => {
      const response = await fetch(`http://127.0.0.1:${manager.port}/manager/authoring/review`, {
        method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: instance.id, ...(resultId ? { resultId } : {}) }) })
      return { status: response.status, body: await response.json() }
    }
    const latest = await review('')
    assert.equal(latest.status, 200, JSON.stringify(latest.body))
    assert.equal(latest.body.resultId, records.at(-1).id)
    assert.equal(latest.body.availableResults.length, 200)
    const older = await review(records[0].id)
    assert.equal(older.status, 200, JSON.stringify(older.body))
    assert.equal(older.body.resultId, records[0].id)
    assert.equal(older.body.draft.program.title, 'Version 0')
    assert.equal(older.body.availableResults.length, 201)
    assert.equal(older.body.availableResults.at(-1).resultId, records[0].id)
    assert.equal(older.body.materialId, material.selector)
    assert.equal(older.body.proposalDigest, proposalDigest(drafts[0]))
  })
})

/** A manager and a Gateway on real sockets, signed in unless a scenario asks otherwise. */
async function withManager(t, run, { signIn = true, agents = AGENTS, ...managerOptions } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rulith-instances-'))
  const gateway = createDevicesGateway()
  await gateway.listen()
  const manager = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json'), startConfirmMs: 8000, ...managerOptions })
  await manager.listen()
  t.after(async () => {
    await manager.close()
    await gateway.close()
    rmSync(root, { recursive: true, force: true })
  })
  let deviceId = ''
  if (signIn) {
    const started = await manager.device.start({ consoleUrl: gateway.origin, name: 'Test computer' })
    deviceId = gateway.approve(started.code, agents).deviceId
    await manager.device.poll()
  }
  await run({ manager, root, gateway, deviceId })
}

/**
 * An instance attached to `agentId`, then re-pointed at the reporting stand-in.
 *
 * Attaching first is what a real instance does, so the credentials the roles are launched
 * with are the ones a real pairing delivered.
 */
async function addInstance(manager, name, { agentId, exit = false, mode = 'local_agent', attach = true } = {}) {
  const created = await manager.instances.create({ name, mode })
  if (attach) await manager.instances.pair(created.id, { agentId })
  await manager.instances.closeHost(created.id)
  const config = loadInstanceConfig(created.directory)
  config.paths = { agent: ECHO, worker: ECHO }
  // Existing profiles remain custom. Give the executable fixture a local model endpoint so
  // these lifecycle arms exercise their purpose rather than failing the model readiness gate.
  config.agent.env = { ...config.agent.env, RULITH_MODEL_URL: 'http://127.0.0.1:11434/v1', RULITH_MODEL: 'fixture-model',
    RULITH_TEST_IDENTITY: agentId ?? name, ...(exit ? { RULITH_TEST_EXIT: '1' } : {}) }
  config.worker.env = { ...config.worker.env, RULITH_TEST_IDENTITY: agentId ?? name }
  saveInstanceConfig(created.directory, config)
  return created
}

const childEvents = (manager, id, src) => manager.instances.hosts.get(id).host.events().filter((row) => row.src === src)
const observedEnv = (manager, id, src) => childEvents(manager, id, src).find((row) => row.observed !== undefined)?.observed

test('managed attachment registers its durable selection with the device before Agent forwarding', async (t) => {
  await withManager(t, async ({ manager, gateway, deviceId }) => {
    const instance = await addInstance(manager, 'Material task', { agentId: 'agent-alpha' })
    const taskLog = join(instance.directory, 'tasks.jsonl')
    const config = loadInstanceConfig(instance.directory)
    config.paths.agent = TASK_AGENT
    config.agent.env = { ...config.agent.env, RULITH_TEST_AGENT_ID: 'agent-alpha',
      RULITH_TEST_TASK_LOG: taskLog }
    saveInstanceConfig(instance.directory, config)
    assert.equal((await manager.instances.start(instance.id)).started, true)
    assert.equal(observedEnv(manager, instance.id, 'worker')?.RULITH_MATERIALS_DEVICE_ID, deviceId)
    assert.equal(JSON.parse(readFileSync(join(instance.directory, 'materials', 'store.json'), 'utf8')).deviceFingerprint,
      materialDeviceFingerprint(deviceId))
    const url = new URL((await manager.instances.open(instance.id)).url)
    const call = async (path, body) => {
      const response = await fetch(url.origin + path, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k'),
          origin: url.origin }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    const added = await call('/materials', { name: 'private.txt', mediaType: 'text/plain',
      bytes: Buffer.from('PRIVATE-BYTES').toString('base64') })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    const submission = { text: 'read this', requestId: 'managed-click-1234', sessionKey: 'ctx-one',
      attachments: [added.body.material.id] }
    gateway.failNext('/local-devices/material-submissions')
    const blocked = await call('/cases', submission)
    assert.equal(blocked.status, 503)
    assert.equal(blocked.body.errorCode, 'material_registration_unconfirmed')
    const tasks = () => existsSync(taskLog) ? readFileSync(taskLog, 'utf8').trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line)).filter(row => row.kind === 'task') : []
    assert.equal(tasks().length, 0, 'an unconfirmed registration cannot start an Agent task')
    const accepted = await call('/cases', submission)
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body))
    assert.equal(tasks().length, 1)
    const sent = gateway.requests.filter(row => row.path === '/local-devices/material-submissions')
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[0].body, sent[1].body, 'retry must use the elected Host receipt')
    assert.equal(sent[1].body.agentId, 'agent-alpha')
    assert.equal(sent[1].body.submissionId, accepted.body.submissionReceipt.submissionId)
    assert.deepEqual(Object.keys(sent[1].body).sort(), ['agentId', 'attachments', 'custodyBindings', 'proofDigest', 'requestId', 'selectionDigest', 'sessionKey', 'submissionId'])
    assert.equal(sent[1].body.custodyBindings.length, 1)
    assert.equal(sent[1].body.custodyBindings[0].selector, sent[1].body.attachments[0].selector)
    assert.notEqual(sent[1].body.custodyBindings[0].custodyId, sent[1].body.attachments[0].selector)
    assert.equal([...gateway.materialSubmissions.values()][0].body.custodyBindings[0].custodyId,
      sent[1].body.custodyBindings[0].custodyId,
      'the managed Host must persist its private mapping through the authenticated device registration')
    assert.match(sent[1].body.proofDigest, /^sha256:[0-9a-f]{64}$/u)
    assert.match(sent[1].body.selectionDigest, /^sha256:[0-9a-f]{64}$/u)
    assert.notEqual(sent[1].body.selectionDigest, sent[1].body.proofDigest)
    assert.doesNotMatch(JSON.stringify(sent), /PRIVATE-BYTES|proofSecret/u)
    assert.doesNotMatch(JSON.stringify(accepted.body), new RegExp(sent[1].body.custodyBindings[0].custodyId, 'u'))
    assert.doesNotMatch(JSON.stringify(tasks()), new RegExp(sent[1].body.custodyBindings[0].custodyId, 'u'))
    assert.doesNotMatch(JSON.stringify(tasks()), new RegExp(manager.device.peek().token, 'u'))
    gateway.disableAgent('agent-alpha')
    const denied = await call('/cases', { ...submission, requestId: 'managed-click-5678' })
    assert.equal(denied.status, 503)
    assert.equal(tasks().length, 1, 'a revoked Agent scope must not forward another task')
  })
})

/** Raw request, so a hostile `Host` header can be sent; fetch forbids overriding it. */
function rawGet(port, path, headers = {}) {
  return new Promise((done, fail) => {
    const lines = [`GET ${path} HTTP/1.1`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), 'Connection: close', '', '']
    const socket = new Socket()
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { raw += chunk })
    socket.on('error', fail)
    socket.on('close', () => done({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0), raw }))
    socket.connect(port, '127.0.0.1', () => socket.end(lines.join('\r\n')))
  })
}

// ── Separation ───────────────────────────────────────────────────────────────

test('first-use allocation survives restart and concurrent retries without issuing credentials', async (t) => {
  await withManager(t, async ({ manager, root, gateway }) => {
    const setupTarget = { origin: gateway.origin, accountId: manager.device.status().account.id, agentId: 'agent-alpha' }
    const request = { name: 'Alpha', mode: 'existing_client', setupTarget }
    const first = await manager.instances.create(request)
    assert.deepEqual(manager.instances.overview()[0].setupTarget, setupTarget)
    assert.equal(manager.instances.overview()[0].paired, false)
    assert.equal(manager.instances.overview()[0].pendingAgentId, '')
    await manager.close()
    const restarted = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
    try {
      await restarted.listen()
      const retry = () => fetch(`http://127.0.0.1:${restarted.port}/manager/instances/create`, {
        method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' }, body: JSON.stringify(request),
      }).then(async response => { assert.equal(response.status, 200); return response.json() })
      const repeated = await Promise.all([retry(), retry()])
      assert.deepEqual(repeated.map(result => result.id), [first.id, first.id])
      assert.equal(restarted.instances.overview().length, 1)
      assert.equal(restarted.instances.hosts.size, 0)
      const config = loadInstanceConfig(first.directory)
      assert.ok(!config.agent.env.RULITH_TOKEN && !config.worker.env.RULITH_CONNECTION_KEY)
      await assert.rejects(restarted.instances.create({ ...request, setupTarget: { ...setupTarget, accountId: 'another-account' } }), /authorization changed/)
      await assert.rejects(restarted.instances.create({ ...request, setupTarget: { ...setupTarget, origin: 'https://other.example' } }), /authorization changed/)
      await assert.rejects(restarted.instances.create({ ...request, setupTarget: { ...setupTarget, agentId: 'not-authorized' } }), /authorization changed/)
      await assert.rejects(restarted.instances.create({ ...request, mode: 'local_agent' }), /different runtime mode/)
      assert.equal(restarted.instances.overview().length, 1)
    } finally { await restarted.close() }
  })
})

test('two instances are two installations: separate directories, ports, keys and state files', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const first = await addInstance(manager, 'Research', { agentId: 'agent-alpha' })
    const second = await addInstance(manager, 'Research', { agentId: 'agent-beta' })

    assert.notEqual(first.id, second.id, 'two instances may share a display name and must never share an id')
    assert.notEqual(first.directory, second.directory)
    assert.notEqual(first.servePort, second.servePort)

    const configs = [first, second].map((row) => loadInstanceConfig(row.directory))
    for (const [index, config] of configs.entries()) {
      const directory = [first, second][index].directory
      assert.equal(config.agent.env.RULITH_SESSION_FILE, join(directory, 'agent-sessions.json'))
      assert.equal(config.worker.env.RULITH_TOOLS_FILE, join(directory, 'worker-tools.json'))
      assert.equal(config.worker.env.RULITH_SECRETS_FILE, join(directory, 'worker-secrets.json'))
      assert.equal(config.worker.env.RULITH_WORKER_ROOT, join(directory, 'workspace'))
    }
    for (const field of ['RULITH_SESSION_FILE', 'RULITH_SERVE_PORT', 'RULITH_TOKEN']) {
      assert.notEqual(configs[0].agent.env[field], configs[1].agent.env[field], `${field} is shared between instances`)
    }
    for (const field of ['RULITH_TOOLS_FILE', 'RULITH_SECRETS_FILE', 'RULITH_WORKER_ROOT', 'RULITH_CONNECTION_KEY']) {
      assert.notEqual(configs[0].worker.env[field], configs[1].worker.env[field], `${field} is shared between instances`)
    }

    await manager.instances.open(first.id)
    await manager.instances.open(second.id)
    const hosts = [first, second].map((row) => manager.instances.hosts.get(row.id).host)
    assert.notEqual(hosts[0].port, hosts[1].port, 'two hosts must not share a port')
    assert.notEqual(hosts[0].key, hosts[1].key, 'each instance owns its own local access key')

    const crossed = await fetch(`http://127.0.0.1:${hosts[1].port}/status?k=${hosts[0].key}`)
    assert.equal(crossed.status, 401, 'one instance key must not authenticate against another instance')
    assert.equal((await fetch(`http://127.0.0.1:${hosts[1].port}/status?k=${hosts[1].key}`)).status, 200)

    for (const row of [first, second]) assert.equal(row.directory, join(root, 'instances', row.id))
  })
})

test('each role receives only its own instance\'s configuration, and inherits no credential from this process', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const before = { token: process.env.RULITH_TOKEN, key: process.env.ANTHROPIC_API_KEY, connection: process.env.RULITH_CONNECTION_KEY }
    process.env.RULITH_TOKEN = 'inherited-agent-token'
    process.env.ANTHROPIC_API_KEY = 'inherited-model-key'
    process.env.RULITH_CONNECTION_KEY = 'inherited-connection-key'
    t.after(() => {
      for (const [name, value] of [['RULITH_TOKEN', before.token], ['ANTHROPIC_API_KEY', before.key], ['RULITH_CONNECTION_KEY', before.connection]]) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })

    assert.deepEqual(Object.keys(isolatedEnvironmentBase({ PATH: 'p', RULITH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' })), ['PATH'])

    const instance = await addInstance(manager, 'Isolated', { agentId: 'agent-alpha' })
    const started = await manager.instances.start(instance.id)
    assert.equal(started.started, true, JSON.stringify(started.results))

    const agentEnv = observedEnv(manager, instance.id, 'agent')
    const workerEnv = observedEnv(manager, instance.id, 'worker')
    assert.ok(agentEnv && workerEnv, 'both roles reported the environment they were given')

    assert.match(agentEnv.RULITH_TOKEN, /^rlt_agt_/, 'the Agent gets the credential this instance\'s pairing delivered')
    assert.equal(agentEnv.RULITH_CONNECTION_KEY, undefined, 'the Worker credential must not reach the Agent')
    assert.equal(agentEnv.ANTHROPIC_API_KEY, undefined, 'an inherited provider key is a model credential the configuration never named')

    assert.ok(workerEnv.RULITH_CONNECTION_KEY)
    assert.equal(workerEnv.RULITH_TOKEN, undefined, 'the Agent credential must not reach the Worker')
    assert.equal(workerEnv.RULITH_MODEL_KEY, undefined, 'a model key belongs to the Agent role only')

    const everything = JSON.stringify({ agentEnv, workerEnv })
    for (const leaked of ['inherited-agent-token', 'inherited-model-key', 'inherited-connection-key']) {
      assert.equal(everything.includes(leaked), false, `a child inherited ${leaked} from the manager process`)
    }
    // And the device management credential, which is not a RULITH_* variable at all.
    const deviceToken = gateway.deviceToken(manager.device.peek().deviceId)
    const agentChild = childEvents(manager, instance.id, 'agent').find((row) => row.credentialNames !== undefined)
    const workerChild = childEvents(manager, instance.id, 'worker').find((row) => row.credentialNames !== undefined)
    assert.deepEqual(agentChild.credentialNames, ['RULITH_TOKEN'])
    assert.deepEqual(workerChild.credentialNames, [])
    assert.equal(JSON.stringify([agentChild, workerChild]).includes(deviceToken), false,
      'the device management credential is operator authority and must never enter a child environment')
  })
})

test('an instance pointed at the manager\'s own directory cannot start, but can still be repaired', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const instance = await addInstance(manager, 'Nosy', { agentId: 'agent-alpha' })
    await manager.instances.closeHost(instance.id)
    const config = loadInstanceConfig(instance.directory)
    // The manager root holds device.json and every other instance's configuration.
    config.worker.env.RULITH_WORKER_ROOT = root
    saveInstanceConfig(instance.directory, config)

    const refused = await manager.instances.start(instance.id).catch((error) => error)
    assert.match(refused.message, /overlaps the manager directory/)
    assert.match(refused.message, /device credential/)
    assert.match(manager.instances.overview()[0].blocked, /overlaps the manager directory/)

    // The pages that could repair it are still reachable. Refusing to *open* the host took
    // Setup and Tools with it — the only two pages that can fix the path — so the instance
    // could never be recovered from inside the product. Opening spawns nothing; starting does.
    const opened = await manager.instances.open(instance.id, '/setup')
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/setup\?k=/)
    assert.match(refused.message, /Setup or Tools page/)

    // A sibling instance's directory is refused for the same reason.
    const sibling = await addInstance(manager, 'Sibling', { agentId: 'agent-beta' })
    const nosy = loadInstanceConfig(instance.directory)
    nosy.worker.env.RULITH_WORKER_ROOT = sibling.directory
    saveInstanceConfig(instance.directory, nosy)
    assert.match((await manager.instances.start(instance.id).catch((error) => error)).message, /overlaps the manager directory/)

    // Its own directory is fine (calibration).
    const own = loadInstanceConfig(instance.directory)
    own.worker.env.RULITH_WORKER_ROOT = join(instance.directory, 'workspace')
    saveInstanceConfig(instance.directory, own)
    await manager.instances.closeHost(instance.id)
    assert.equal((await manager.instances.start(instance.id)).started, true)
  })
})

test('selecting or opening one instance does not start, stop or re-key another, and their events never cross', async (t) => {
  await withManager(t, async ({ manager }) => {
    const working = await addInstance(manager, 'Working', { agentId: 'agent-alpha' })
    const idle = await addInstance(manager, 'Idle', { agentId: 'agent-beta' })

    const started = await manager.instances.start(working.id)
    assert.equal(started.started, true, JSON.stringify(started.results))
    const workingHost = manager.instances.hosts.get(working.id).host
    const before = { key: workingHost.key, port: workingHost.port, agentId: workingHost.agentId, status: workingHost.status() }
    assert.equal(before.agentId, 'agent-alpha', 'the running Agent reports its own identity')

    await manager.instances.open(idle.id)
    await manager.instances.open(idle.id, '/setup')
    const overview = manager.instances.overview()
    assert.equal(overview.length, 2)

    const after = manager.instances.hosts.get(working.id).host
    assert.equal(after.key, before.key, 'viewing another instance re-keyed a running host')
    assert.equal(after.port, before.port, 'viewing another instance moved a running host')
    assert.equal(after.agentId, before.agentId, 'a running process must never change identity in flight')
    assert.deepEqual(after.status(), before.status, 'viewing another instance changed what was running')
    assert.equal(overview.find((row) => row.id === idle.id).agent, false, 'opening an instance page must not start its roles')

    const alphaEvents = JSON.stringify(manager.instances.hosts.get(working.id).host.events())
    const betaEvents = JSON.stringify(manager.instances.hosts.get(idle.id).host.events())
    assert.equal(alphaEvents.includes('agent-beta'), false)
    assert.equal(betaEvents.includes('agent-alpha'), false)
    assert.equal(betaEvents.includes('"observed"'), false, 'an instance whose roles were never started has no role events')
  })
})

test('a start that fails belongs to its own instance, and a stop is reported from the observed exit', async (t) => {
  await withManager(t, async ({ manager }) => {
    const broken = await addInstance(manager, 'Broken', { agentId: 'agent-alpha', exit: true })
    const healthy = await addInstance(manager, 'Healthy', { agentId: 'agent-beta' })

    const failed = await manager.instances.start(broken.id)
    assert.equal(failed.started, false)
    assert.match(failed.results.find((row) => row.role === 'agent').teaching, /exited during startup/)
    assert.equal(failed.results.find((row) => row.role === 'worker').ok, true,
      'one role failing to start says nothing about the other')

    const good = await manager.instances.start(healthy.id)
    assert.equal(good.started, true, JSON.stringify(good.results))
    const stopped = await manager.instances.stop(healthy.id)
    assert.equal(stopped.stopped, true, JSON.stringify(stopped.results))
    assert.equal(manager.instances.hosts.has(healthy.id), false, 'a fully stopped instance closes its host')
    assert.equal(manager.instances.hosts.has(broken.id), true, 'stopping one instance must not close another')
    assert.equal(manager.instances.overview().find((row) => row.id === broken.id).worker, true)
  })
})

// ── The device grant decides what may run ────────────────────────────────────

test('an unattached instance starts nothing, and neither does one with no signed-in device', async (t) => {
  await withManager(t, async ({ manager }) => {
    const unattached = await manager.instances.create({ name: 'Unattached', mode: 'local_agent' })
    const refused = await manager.instances.start(unattached.id).catch((error) => error)
    assert.match(refused.message, /not attached to an Agent yet/)
  })
  // The same, with nobody signed in at all.
  await withManager(t, async ({ manager }) => {
    const instance = await manager.instances.create({ name: 'No account', mode: 'local_agent' })
    const refused = await manager.instances.start(instance.id).catch((error) => error)
    assert.match(refused.message, /Sign in to a Rulith account/)
    assert.match(manager.instances.overview()[0].blocked, /Sign in to a Rulith account/)
  }, { signIn: false })
})

test('an Agent removed from the grant stops covering the instance it was attached to', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await addInstance(manager, 'Covered', { agentId: 'agent-alpha' })
    assert.equal((await manager.instances.start(instance.id)).started, true)
    await manager.instances.stop(instance.id)

    gateway.disableAgent('agent-alpha')
    await manager.device.refresh()
    const dropped = await manager.instances.start(instance.id).catch((error) => error)
    assert.match(dropped.message, /no longer enabled in this account/)
    assert.match(manager.instances.overview()[0].blocked, /no longer enabled in this account/)
  })
})

test('an instance page cannot start a role or re-pair around the manager', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await addInstance(manager, 'Direct', { agentId: 'agent-alpha' })
    const opened = await manager.instances.open(instance.id)
    const url = new URL(opened.url)
    const call = (path, body) => fetch(url.origin + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k') },
      body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }))

    // While the grant covers it, the page works exactly as a standalone Local page does.
    const allowed = await call('/control', { role: 'agent', operation: 'start' })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
    assert.equal((await call('/control', { role: 'agent', operation: 'stop' })).status, 200)

    // Pairing from the page is refused: the manager reserves the Agent first, and a pairing
    // nobody reserved is the duplicate-attach hole reopened through the side door.
    const paired = await call('/setup/pair/start', { consoleUrl: gateway.origin, name: 'sneaky', clientMode: 'local_agent' })
    assert.equal(paired.status, 409)
    assert.match(paired.body.teaching, /started from the Rulith manager/)

    // Once the device is signed out, the page cannot start anything — including a page opened
    // freshly afterwards, which is the strongest form of the question: the key is current, the
    // host is running, and the answer is still no.
    await manager.instances.stop(instance.id)
    await manager.instances.signOut()
    const fresh = new URL((await manager.instances.open(instance.id)).url)
    const afterSignOut = await fetch(fresh.origin + '/control', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-local': fresh.searchParams.get('k') },
      body: JSON.stringify({ role: 'agent', operation: 'start' }),
    }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }))
    assert.equal(afterSignOut.status, 409, 'a signed-out device must not leave an instance page able to start execution')
    assert.match(afterSignOut.body.teaching, /Sign in to a Rulith account|not attached/)
    assert.equal(manager.instances.overview()[0].agent, false)
  })
})

// ── Attaching Agents ─────────────────────────────────────────────────────────

test('one cloud Agent runs in one instance, and the reservation is taken before the network', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const first = await manager.instances.create({ name: 'Alpha', mode: 'local_agent' })
    const second = await manager.instances.create({ name: 'Beta', mode: 'local_agent' })

    const paired = await manager.instances.pair(first.id, { agentId: 'agent-alpha' })
    assert.equal(paired.state, 'delivered')
    assert.equal(paired.agentId, 'agent-alpha')
    assert.equal(manager.registry.instance(first.id).pairing, undefined, 'a finished attachment releases its reservation')

    const clash = await manager.instances.pair(second.id, { agentId: 'agent-alpha' }).catch((error) => error)
    assert.match(clash.message, /already attached/)
    assert.equal(loadInstanceConfig(manager.registry.instance(second.id).directory).agent.env.RULITH_TOKEN, '')
    assert.equal(gateway.pairings.size, 1, 'a refused attachment starts no pairing at the account service')

    const other = await manager.instances.pair(second.id, { agentId: 'agent-beta' })
    assert.equal(other.agentId, 'agent-beta')
    const configs = [first, second].map((row) => loadInstanceConfig(manager.registry.instance(row.id).directory))
    assert.notEqual(configs[0].agent.env.RULITH_TOKEN, configs[1].agent.env.RULITH_TOKEN)
  })
})

test('two attachments racing for one Agent cannot both pass, even asking to replace its token', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const first = await manager.instances.create({ name: 'Racer A', mode: 'local_agent' })
    const second = await manager.instances.create({ name: 'Racer B', mode: 'local_agent' })

    const outcomes = await Promise.allSettled([
      manager.instances.pair(first.id, { agentId: 'agent-alpha', replaceAgentToken: true }),
      manager.instances.pair(second.id, { agentId: 'agent-alpha', replaceAgentToken: true }),
    ])
    const won = outcomes.filter((row) => row.status === 'fulfilled')
    const lost = outcomes.filter((row) => row.status === 'rejected')
    assert.equal(won.length, 1, 'both attachments succeeded: one Agent now has two installations')
    assert.equal(lost.length, 1)
    assert.match(String(lost[0].reason?.message), /already (attached|being attached)/)

    const tokens = [first, second].map((row) => loadInstanceConfig(manager.registry.instance(row.id).directory).agent.env.RULITH_TOKEN)
    assert.equal(tokens.filter((token) => token !== '').length, 1, 'only one instance may hold a credential for one Agent')
    assert.equal([...gateway.agentTokens.values()].filter((row) => row.agentId === 'agent-alpha' && !row.revoked && !row.superseded).length, 1)
  })
})

test('a reservation outlives the process that made it, and only its Agent may be delivered', async (t) => {
  await withManager(t, async ({ manager, gateway, root }) => {
    const instance = await manager.instances.create({ name: 'Interrupted', mode: 'local_agent' })
    // Interrupt between approval and delivery: the acknowledgement never lands.
    gateway.failNext('/local-setup/poll')
    const interrupted = await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch((error) => error)
    assert.ok(interrupted instanceof Error)
    const reserved = manager.registry.instance(instance.id).pairing
    assert.equal(reserved.agentId, 'agent-alpha')
    assert.ok(readFileSync(manager.registry.file, 'utf8').includes('agent-alpha'), 'the reservation is on disk, not only in memory')

    // Another instance cannot take that Agent while the reservation stands.
    const other = await manager.instances.create({ name: 'Opportunist', mode: 'local_agent' })
    const blocked = await manager.instances.pair(other.id, { agentId: 'agent-alpha' }).catch((error) => error)
    assert.match(blocked.message, /already being attached/)

    // A delivery naming a different Agent is refused, and records nothing.
    gateway.mispairNext('agent-beta')
    const mispaired = await manager.instances.pairPoll(instance.id).catch((error) => error)
    assert.match(mispaired.message, /different Agent than this instance approved|not the agent-alpha it reserved/)
    assert.equal(manager.registry.instance(instance.id).agentId, undefined)

    // The honest retry finishes it.
    const finished = await manager.instances.pairPoll(instance.id)
    assert.equal(finished.agentId, 'agent-alpha')
    assert.equal(manager.registry.instance(instance.id).pairing, undefined)
    assert.equal(root.length > 0, true)
  })
})

for (const lostApprovalReceipt of [false, true]) {
test('an issued credential can be collected after disable and refresh, without allowing execution (lost receipt: ' + lostApprovalReceipt + ')', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const row = await manager.instances.create({ name: 'Disabled during delivery', mode: 'local_agent' })
    if (lostApprovalReceipt) gateway.dropResponseAfterEffect('/local-devices/pair')
    else gateway.failNext('/local-setup/poll')
    await assert.rejects(manager.instances.pair(row.id, { agentId: 'agent-alpha' }))
    assert.equal([...gateway.pairings.values()][0].state, 'approved')
    gateway.disableAgent('agent-alpha')
    await manager.instances.refreshDevice()
    assert.ok(!manager.device.peek().agents.some(agent => agent.id === 'agent-alpha'))
    assert.equal((await manager.instances.pairPoll(row.id)).agentId, 'agent-alpha')
    assert.equal(manager.registry.instance(row.id).pairing, undefined)
    assert.equal(gateway.agentTokens.size, 1)
    await assert.rejects(manager.instances.start(row.id), /not authorized|no longer enabled|not enabled|does not authorize/i)
  })
})
}

for (const failedPath of ['/local-setup/start', '/local-devices/pair']) {
test('Check again retries ' + failedPath + ' using the original request and proof', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const row = await manager.instances.create({ name: 'Retry approval', mode: 'local_agent' })
    gateway.failNext(failedPath)
    await assert.rejects(manager.instances.pair(row.id, { agentId: 'agent-alpha' }))
    const original = gateway.requests.find(r => r.path === '/local-setup/start').body
    const finished = await manager.instances.pairPoll(row.id)
    assert.equal(finished.agentId, 'agent-alpha')
    assert.equal(gateway.pairings.size, 1)
    const approvals = gateway.requests.filter(r => r.path === '/local-devices/pair')
    assert.equal(approvals.length, failedPath === '/local-devices/pair' ? 2 : 1)
    assert.equal(approvals.at(-1).body.pairingId, original.requestId)
    assert.equal(sha256Hex(approvals.at(-1).body.deviceSecret), original.deviceDigest)
    assert.equal(manager.instances.overview()[0].pendingError, null)
  })
})
}

test('an existing Agent key is visible and never replaced by Check again', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const prior = { jti: 'existing', agentId: 'agent-alpha', revoked: false }
    gateway.agentTokens.set('rlt_agt_existing', prior)
    const row = await manager.instances.create({ name: 'Existing key', mode: 'local_agent' })
    await assert.rejects(manager.instances.pair(row.id, { agentId: 'agent-alpha' }), { errorCode: 'runtime_credential_exists' })
    assert.equal(manager.instances.overview()[0].pendingError.code, 'runtime_credential_exists')
    await assert.rejects(manager.instances.pairPoll(row.id), { errorCode: 'runtime_credential_exists' })
    assert.equal(gateway.agentTokens.size, 1)
    assert.equal(prior.superseded, undefined)
    const original = [...gateway.pairings.keys()][0]
    await manager.instances.cancelPairing(row.id)
    gateway.failNext('/local-devices/pair')
    await assert.rejects(manager.instances.pair(row.id, { agentId: 'agent-alpha', replaceAgentToken: true }))
    assert.equal(manager.instances.overview()[0].pendingReplace, true, 'a replacement retry is visibly different from ordinary connection')
    assert.equal(prior.superseded, undefined)
    await manager.instances.pairPoll(row.id)
    assert.equal(gateway.pairings.get(original).state, 'cancelled')
    assert.equal(prior.superseded, true)
    assert.equal(manager.instances.overview()[0].paired, true)
  })
})

test('a failed attachment keeps its reservation, and cancelling it asks the account service', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Denied', mode: 'local_agent' })
    // Console removed the Agent; this computer has not refreshed, so it offers it and the
    // service refuses the approval.
    gateway.disableAgent('agent-alpha')
    const refused = await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch((error) => error)
    assert.ok(refused instanceof Error)
    assert.match(refused.message, /still reserved: retry it, or cancel it/)

    // Nothing is released on this computer's own say-so. A local record showing no delivered
    // credential is also what a lost response and an in-flight approval look like from here.
    const reservation = manager.registry.instance(instance.id).pairing
    assert.equal(reservation.agentId, 'agent-alpha')
    assert.equal(manager.instances.overview()[0].pendingAgentId, 'agent-alpha')
    assert.equal(manager.instances.overview()[0].pendingOrigin, gateway.origin)
    assert.equal(manager.instances.overview()[0].pendingAccountId, manager.device.status().account.id)

    // Cancelling goes to the authority that owns the pairing, with its original proof.
    const cancelled = await manager.instances.cancelPairing(instance.id)
    assert.equal(cancelled.state, 'cancelled')
    const sent = gateway.requests.filter((row) => row.path === '/local-setup/cancel')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].body.pairingId, [...gateway.pairings.keys()][0], 'the original pairing id, not a new one')
    assert.equal(manager.registry.instance(instance.id).pairing, undefined)
    assert.equal([...gateway.pairings.values()][0].state, 'cancelled')
    assert.equal(manager.instances.overview()[0].pendingOrigin, '')
    assert.equal(manager.instances.overview()[0].pendingAccountId, '')

    // The pairing cannot be replayed afterwards, and the Agent is free for another instance.
    const other = await manager.instances.create({ name: 'Other', mode: 'local_agent' })
    assert.equal((await manager.instances.pair(other.id, { agentId: 'agent-beta' })).agentId, 'agent-beta')
  })
})

test('a cancellation whose answer was lost changes nothing here, and the same cancellation finishes it', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Interrupted cancel', mode: 'local_agent' })
    gateway.failNext('/local-devices/pair')
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch(() => undefined)
    const pairingId = [...gateway.pairings.keys()][0]
    const proof = gateway.requests.find((row) => row.path === '/local-setup/start').body.deviceDigest

    // The service cancels and the answer never arrives. Treating that as "nothing happened"
    // is the mistake; treating it as success is the other one.
    gateway.dropResponseAfterEffect('/local-setup/cancel')
    const lost = await manager.instances.cancelPairing(instance.id).catch((error) => error)
    assert.ok(lost instanceof Error)
    assert.match(lost.message, /Nothing was changed here|did not confirm/)
    assert.equal(manager.registry.instance(instance.id).pairing.agentId, 'agent-alpha',
      'an unconfirmed cancellation must not drop the reservation')
    assert.equal(gateway.pairings.get(pairingId).state, 'cancelled', 'the effect did happen at the service')

    // The retry is the same request, with the same proof, and it is idempotent.
    const finished = await manager.instances.cancelPairing(instance.id)
    assert.equal(finished.state, 'cancelled')
    const cancels = gateway.requests.filter((row) => row.path === '/local-setup/cancel')
    assert.equal(cancels.length, 2)
    assert.equal(cancels[0].body.pairingId, cancels[1].body.pairingId)
    assert.equal(cancels[0].body.deviceSecret, cancels[1].body.deviceSecret, 'the same proof, not a fresh one')
    assert.equal(sha256Hex(cancels[1].body.deviceSecret), proof, 'and it is the proof the pairing was created with')
    assert.equal(manager.registry.instance(instance.id).pairing, undefined)
  })
})

test('a cancellation that races an approval is refused by the service, and nothing is forgotten', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Racing', mode: 'local_agent' })
    // The approval succeeded; the delivery did not arrive. From here that is indistinguishable
    // from an approval still in flight — which is exactly why the service decides.
    gateway.failNext('/local-setup/poll')
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch(() => undefined)

    const refused = await manager.instances.cancelPairing(instance.id).catch((error) => error)
    assert.ok(refused instanceof Error)
    assert.match(refused.message, /already approved/)
    assert.match(refused.message, /Check attachment/)
    assert.match(refused.message, /revoke this device in Console/)
    assert.equal(manager.registry.instance(instance.id).pairing.agentId, 'agent-alpha',
      'a credential that exists is not made to disappear by a local button')
    assert.equal([...gateway.agentTokens.values()].filter((row) => row.agentId === 'agent-alpha').length, 1,
      'and nothing at the service was touched')
    assert.equal(manager.instances.overview()[0].pendingApproved, true,
      'the card now knows to offer the one action that can finish this')

    // Which it does.
    assert.equal((await manager.instances.pairPoll(instance.id)).agentId, 'agent-alpha')
  })
})

test('an attachment stuck after approval is not silently forgotten, and says what to do instead', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Interrupted', mode: 'local_agent' })
    gateway.failNext('/local-setup/poll')
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch(() => undefined)
    const reservation = manager.registry.instance(instance.id).pairing
    assert.equal(reservation.agentId, 'agent-alpha')
    assert.ok(reservation.approvedAt, 'the account service approved this one, so a credential exists for it')
    assert.equal(manager.instances.overview()[0].pendingApproved, true)

    const refused = await manager.instances.cancelPairing(instance.id).catch((error) => error)
    assert.match(refused.message, /already approved/)
    assert.match(refused.message, /Check attachment/)
    assert.match(refused.message, /revoke this device in Console/)
    assert.equal(manager.registry.instance(instance.id).pairing.agentId, 'agent-alpha',
      'an issued credential is not made to disappear by a local button')

    // Finishing it is the way out, and it works.
    const finished = await manager.instances.pairPoll(instance.id)
    assert.equal(finished.agentId, 'agent-alpha')
    assert.equal(manager.registry.instance(instance.id).pairing, undefined)
  })
})

test('an unapproved attachment can be cancelled, and the Agent is free again', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await manager.instances.create({ name: 'Abandoned', mode: 'local_agent' })
    // A reservation left by a manager that died between reserving and approving.
    await manager.registry.patchInstance(instance.id, () => ({ pairing: {
      agentId: 'agent-alpha', agentName: 'Alpha', origin: manager.device.peek().origin,
      accountId: manager.device.peek().account.id, clientMode: 'local_agent',
      replaceAgentToken: false, reservedAt: new Date().toISOString() } }))

    const other = await manager.instances.create({ name: 'Waiting', mode: 'local_agent' })
    const blocked = await manager.instances.pair(other.id, { agentId: 'agent-alpha' }).catch((error) => error)
    assert.match(blocked.message, /already being attached/)

    const cancelled = await manager.instances.cancelPairing(instance.id)
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(manager.registry.instance(instance.id).pairing, undefined)
    assert.equal((await manager.instances.pair(other.id, { agentId: 'agent-alpha' })).agentId, 'agent-alpha')
  })
})

test('one instance cannot have two different attachments in flight, and an identical retry is the same one', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Contended', mode: 'local_agent' })
    gateway.failNext('/local-setup/poll')
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch(() => undefined)
    const reserved = manager.registry.instance(instance.id).pairing
    assert.equal(reserved.agentId, 'agent-alpha')
    assert.equal(reserved.clientMode, 'local_agent', 'the mode is part of the target, because it decides what is issued')

    // A second request for the *same* instance naming a different Agent used to overwrite the
    // reservation — and the approver, which reads the persisted one, then spent the grant on
    // the other Agent and reported success to the caller who asked for neither.
    const refused = await manager.instances.pair(instance.id, { agentId: 'agent-beta' }).catch((error) => error)
    assert.match(refused.message, /already attaching Alpha/)
    assert.equal(manager.registry.instance(instance.id).pairing.agentId, 'agent-alpha')
    assert.equal(gateway.requests.filter((row) => row.path === '/local-devices/pair' && row.body.agentId === 'agent-beta').length, 0,
      'the refused request must not reach the account service at all')

    // The identical request again is the same attachment, retried: same pairing, same proof.
    const retried = await manager.instances.pair(instance.id, { agentId: 'agent-alpha' })
    assert.equal(retried.agentId, 'agent-alpha')
    assert.equal([...gateway.pairings.values()].length, 1, 'a retry reuses the pairing it already started')
    assert.equal(gateway.requests.filter((row) => row.path === '/local-devices/pair').length, 1,
      'an attachment the service already approved is collected, not approved a second time')
    assert.equal([...gateway.agentTokens.values()].filter((row) => row.agentId === 'agent-alpha').length, 1,
      'one attachment must produce one credential however many times it is retried')
  })
})

test('a pairing started under a different client mode than was reserved is refused', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Mode', mode: 'local_agent' })
    await manager.registry.patchInstance(instance.id, () => ({ pairing: {
      agentId: 'agent-alpha', agentName: 'Alpha', origin: manager.device.peek().origin,
      accountId: manager.device.peek().account.id, clientMode: 'local_agent',
      replaceAgentToken: false, reservedAt: new Date().toISOString() } }))
    const url = new URL((await manager.instances.open(instance.id, '/setup')).url)

    // The instance page starting the reserved pairing as an existing client would mint no
    // Agent token and rewrite this instance's roles, under a grant reserved for the other mode.
    const answer = await fetch(url.origin + '/setup/pair/start', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k') },
      body: JSON.stringify({ consoleUrl: gateway.origin, name: 'Mode', clientMode: 'existing_agent' }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))
    assert.equal(answer.status, 400, JSON.stringify(answer.body))
    assert.match(answer.body.teaching, /started as existing_agent, and the manager reserved local_agent/)
    assert.deepEqual(loadInstanceConfig(instance.directory).roles, ['agent', 'worker'], 'the instance\'s roles were not rewritten')
  })
})

test('a configured MCP server cannot be pointed at the manager directory through any of the three modes', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const instance = await addInstance(manager, 'Tools', { agentId: 'agent-alpha' })
    const url = new URL((await manager.instances.open(instance.id, '/worker-tools')).url)
    const probe = (body) => fetch(url.origin + '/mcp-services/probe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k') },
      body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))

    // The Filesystem branch has always refused this. The stdio branch builds the identical
    // launch line — `node <server> <directory>` — and used to accept it verbatim.
    const refused = await probe({ name: 'nosy', mode: 'stdio', isNew: true, command: process.execPath,
      args: [join(root, 'fake-server.js'), root], env: {} })
    assert.equal(refused.status, 400, 'a stdio server was allowed to be rooted at the manager directory')
    assert.match(refused.body.teaching, /overlaps Rulith's own configuration and credentials/)
    assert.match(refused.body.teaching, /cannot confine an executable it starts/,
      'the refusal must not claim to be a sandbox it is not')

    // A working directory inside the manager tree is refused the same way.
    const cwdRefused = await probe({ name: 'nosy', mode: 'stdio', isNew: true, command: process.execPath, args: [], cwd: root, env: {} })
    assert.equal(cwdRefused.status, 400)
    assert.match(cwdRefused.body.teaching, /working directory/)

    // A *file* argument too: `device.json` is the highest-value thing in that tree and it is
    // not a directory. The program a Node command runs is exempt — that is what is being
    // started, not something it is being pointed at.
    const fileRefused = await probe({ name: 'nosy', mode: 'stdio', isNew: true, command: process.execPath,
      args: [ECHO, join(root, 'device.json')], env: {} })
    assert.equal(fileRefused.status, 400)
    assert.match(fileRefused.body.teaching, /file argument/)
    assert.match(fileRefused.body.teaching, /device\.json/)

    // A directory outside Rulith's own state is not refused by this check (it fails later, on
    // discovery, because this command is not an MCP server).
    const project = mkdtempSync(join(tmpdir(), 'rulith-project-'))
    t.after(() => rmSync(project, { recursive: true, force: true }))
    const elsewhere = await probe({ name: 'nosy', mode: 'stdio', isNew: true, command: process.execPath,
      args: [project], env: {} })
    assert.doesNotMatch(String(elsewhere.body.teaching ?? ''), /overlaps Rulith's own configuration/)
  })
})

test('an Agent outside the authorized set is refused without signing this computer out', async (t) => {
  await withManager(t, async ({ manager }, ) => {
    const instance = await manager.instances.create({ name: 'Alpha', mode: 'local_agent' })
    const outside = await manager.instances.pair(instance.id, { agentId: 'agent-nobody' }).catch((error) => error)
    assert.match(outside.message, /enabled Agents in this account/)
    assert.equal(manager.device.status().state, 'linked', 'choosing the wrong Agent must not discard the account grant')

    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' })
    const again = await manager.instances.pair(instance.id, { agentId: 'agent-beta' }).catch((error) => error)
    assert.match(again.message, /already holds execution credentials/)
  })
})

test('an existing-client instance pairs a Worker Connection and mints no Agent token', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await manager.instances.create({ name: 'Existing client', mode: 'existing_client' })
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' })
    const config = loadInstanceConfig(manager.registry.instance(instance.id).directory)
    assert.equal(config.agent.env.RULITH_TOKEN, '', 'existing-client mode must not mint an Agent token')
    assert.ok(config.worker.env.RULITH_CONNECTION_KEY)
    assert.deepEqual(config.roles, ['worker'])
  })
})

// ── One instance, one owned host ─────────────────────────────────────────────

/** Every loopback port in a set that currently answers a TCP connection. */
async function listening(ports) {
  const live = []
  for (const port of ports) {
    const open = await new Promise((done) => {
      const probe = new Socket()
      probe.setTimeout(500)
      probe.once('connect', () => { probe.destroy(); done(true) })
      probe.once('timeout', () => { probe.destroy(); done(false) })
      probe.once('error', () => done(false))
      probe.connect(Number(port), '127.0.0.1')
    })
    if (open) live.push(port)
  }
  return live
}

test('simultaneous opens of one instance create one host, on one port', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Contended open', { agentId: 'agent-alpha' })
    await manager.instances.closeHost(instance.id)

    // `ensureHost` read `hosts`, then awaited a stale sweep, a port probe and a `listen`
    // before writing the entry back. Two requests arriving together both passed the check and
    // both listened: two loopback hosts with two keys for one registered instance, only the
    // second tracked — and the first unstoppable, because `close()` walks `hosts`.
    const opened = await Promise.allSettled(Array.from({ length: 4 }, () => manager.instances.open(instance.id)))
    assert.equal(opened.every((row) => row.status === 'fulfilled'), true, JSON.stringify(opened))
    const urls = opened.map((row) => new URL(row.value.url))
    const ports = new Set(urls.map((url) => url.port))
    const keys = new Set(urls.map((url) => url.searchParams.get('k')))
    assert.equal(ports.size, 1, `one instance produced ${ports.size} ports: ${[...ports]}`)
    assert.equal(keys.size, 1, 'and one key, because there is one host')
    assert.equal(manager.instances.hosts.size, 1)
    assert.equal([...ports][0], String(manager.instances.hosts.get(instance.id).host.port))

    // Nothing else is listening: a second host would still be answering here.
    const reachable = await listening([...ports])
    assert.deepEqual(reachable, [...ports])
    assert.equal(manager.registry.instance(instance.id).hostPort, Number([...ports][0]),
      'the tracked host is the one the registry records')
  })
})

test('opens, starts and stops of one instance interleave without losing a child or a host', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Interleaved', { agentId: 'agent-alpha' })
    await manager.instances.closeHost(instance.id)

    const results = await Promise.allSettled([
      manager.instances.open(instance.id),
      manager.instances.start(instance.id),
      manager.instances.open(instance.id, '/setup'),
      manager.instances.stop(instance.id),
      manager.instances.open(instance.id, '/worker-tools'),
    ])
    assert.equal(results.filter((row) => row.status === 'rejected').length, 0, JSON.stringify(results.map((r) => String(r.reason ?? ''))))
    const ports = new Set(results.filter((row) => row.value?.url).map((row) => new URL(row.value.url).port))
    assert.equal(ports.size <= 1, true, `interleaving produced ${ports.size} ports`)
    assert.equal(manager.instances.hosts.size <= 1, true)

    // Whatever order they ran in, the record and the reality agree at the end.
    const row = manager.registry.instance(instance.id)
    const open = manager.instances.hosts.get(instance.id)
    if (open === undefined) {
      assert.equal(row.runtime, undefined, 'a closed instance records no processes')
    } else {
      const recorded = row.runtime.children.map((child) => child.pid)
      const actual = open.host.children().map((child) => child.pid)
      assert.deepEqual(recorded.sort(), actual.sort(), 'the recorded children are the ones that exist')
      for (const pid of actual) assert.equal(processAlive(pid), true)
    }

    // And the instance is still usable afterwards.
    const stopped = await manager.instances.stop(instance.id)
    assert.equal(stopped.stopped, true, JSON.stringify(stopped.results))
    assert.equal((await manager.instances.start(instance.id)).started, true)
  })
})

test('a manager that closes with a draining child records it rather than claiming it stopped', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const instance = await addDrainingInstance(manager, 'Shutdown', { agentId: 'agent-alpha', ms: 9000 })
    const url = new URL((await manager.instances.open(instance.id)).url)
    await fetch(url.origin + '/control', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k') },
      body: JSON.stringify({ role: 'worker', operation: 'start' }),
    })
    const workerPid = manager.registry.instance(instance.id).runtime.children[0].pid

    // Shutting down is not licence to record a child as gone. `close()` here is a library
    // call: this process may well continue, and the Worker is still finishing.
    const result = await manager.close()
    assert.equal(result.unobserved.length, 1, 'a child that had not exited must be reported, not assumed away')
    assert.equal(result.unobserved[0].children[0].pid, workerPid)
    assert.deepEqual(result.failures, [])
    assert.equal(processAlive(workerPid), true)

    const recorded = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')).instances[0]
    assert.equal(recorded.runtime.children[0].pid, workerPid, 'the exact child ownership survives for the next run')
    assert.ok(recorded.unobservedAt)

    // A closed workbench admits nothing further, and releases the installation.
    await assert.rejects(manager.instances.open(instance.id), /shutting down/)
    assert.equal(existsSync(join(root, 'workbench.lock')), false)

    // Which is what makes the *next* workbench refuse to open a second host over that child.
    await manager.registry.patchInstance(instance.id, (row) => ({ runtime: { ...row.runtime, pid: 999_999 } }))
    const next = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
    await next.listen()
    t.after(() => next.close())
    assert.ok(next.registry.instance(instance.id).orphaned, 'the marker the previous run left is read by this one')
    await assert.rejects(next.instances.open(instance.id), /still has processes from a Rulith manager that is gone/)

    const deadline = Date.now() + 15_000
    while (processAlive(workerPid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
    assert.equal(processAlive(workerPid), false)
  })
})

// ── A child that is still finishing ──────────────────────────────────────────

/** An attached instance whose roles take `ms` to finish after they are asked to stop. */
async function addDrainingInstance(manager, name, { agentId, ms = 4000, mode = 'local_agent' } = {}) {
  const created = await addInstance(manager, name, { agentId, mode })
  const config = loadInstanceConfig(created.directory)
  config.agent.env = { ...config.agent.env, RULITH_TEST_STOP_DELAY_MS: String(ms) }
  config.worker.env = { ...config.worker.env, RULITH_TEST_STOP_DELAY_MS: String(ms) }
  saveInstanceConfig(created.directory, config)
  return created
}

test('nothing tears down a host while a child is still finishing, and nothing calls that stopped', async (t) => {
  await withManager(t, async ({ manager }) => {
    // A Local-agent instance with only its Worker started: the exact shape that used to slip
    // past a refusal written against the Agent alone.
    const instance = await addDrainingInstance(manager, 'Draining', { agentId: 'agent-alpha', ms: 9000 })
    const url = new URL((await manager.instances.open(instance.id)).url)
    const control = (role, operation) => fetch(url.origin + '/control', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k') },
      body: JSON.stringify({ role, operation }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))
    assert.equal((await control('worker', 'start')).status, 200)
    const workerPid = manager.registry.instance(instance.id).runtime.children.find((child) => child.role === 'worker').pid
    assert.equal(processAlive(workerPid), true)
    assert.equal(manager.instances.overview()[0].agent, false, 'only the Worker is running')

    // Copying model settings used to close the host here — with the Worker mid-call — leaving
    // a live child that nothing on the machine tracked.
    const other = await addInstance(manager, 'Configured', { agentId: 'agent-beta' })
    const configured = loadInstanceConfig(other.directory)
    configured.agent.env = { ...configured.agent.env, RULITH_MODEL_URL: 'http://127.0.0.1:8080/v1', RULITH_MODEL: 'shared' }
    saveInstanceConfig(other.directory, configured)
    const refusedCopy = await manager.instances.copyModelSettings(instance.id, other.id).catch((error) => error)
    assert.match(refusedCopy.message, /is running its worker/)
    assert.match(refusedCopy.message, /will not close a host while a child may still be finishing/)
    assert.equal(manager.instances.hosts.has(instance.id), true, 'the host was closed out from under a running child')

    // Closing directly is refused for the same reason.
    const refusedClose = await manager.instances.closeHost(instance.id).catch((error) => error)
    assert.match(refusedClose.message, /still running its worker/)

    // A stop that has been asked for and not yet observed is `stopping`, and the instance is
    // still listed as running, still recorded, still there to be stopped.
    const stopped = await manager.instances.stop(instance.id)
    assert.equal(stopped.stopped, false, 'a child that has not exited must not be reported as stopped')
    assert.equal(stopped.results.find((row) => row.role === 'worker').state, 'stopping')
    assert.equal(manager.instances.hosts.has(instance.id), true)
    assert.equal(processAlive(workerPid), true)
    assert.deepEqual(manager.registry.instance(instance.id).runtime.children.map((child) => child.role), ['worker'],
      'a draining child is still this instance\'s child')

    // And sign-out will not revoke the device while it is still there.
    const out = await manager.instances.signOut()
    assert.equal(out.state, 'incomplete')
    assert.equal(out.step, 'stop')
    assert.equal(manager.device.status().state, 'linked')

    // Once it really goes, everything agrees.
    const deadline = Date.now() + 15_000
    while (processAlive(workerPid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
    assert.equal(processAlive(workerPid), false)
    // The OS can report process death before Node delivers ChildProcess's exit event.
    // Wait for the host's independently observed exit too; no timing assumption may turn
    // a truthful, still-unconfirmed stop into a failure under a busy full test run.
    while (manager.instances.hosts.get(instance.id)?.host.status().worker && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 25))
    }
    assert.equal(manager.instances.hosts.get(instance.id)?.host.status().worker, false)
    const after = await manager.instances.stop(instance.id)
    assert.equal(after.stopped, true)
    assert.equal(manager.instances.hosts.has(instance.id), false)
  })
})

test('a role started from the instance page is recorded as this instance\'s child', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Direct start', { agentId: 'agent-alpha' })
    const url = new URL((await manager.instances.open(instance.id)).url)
    assert.deepEqual(manager.registry.instance(instance.id).runtime.children, [], 'nothing is running yet')

    // Exactly what the instance's own page does. It never goes through the manager.
    const answer = await fetch(url.origin + '/control', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k') },
      body: JSON.stringify({ role: 'worker', operation: 'start' }),
    })
    assert.equal(answer.status, 200, JSON.stringify(await answer.json()))

    const recorded = manager.registry.instance(instance.id).runtime.children
    assert.deepEqual(recorded.map((child) => child.role), ['worker'],
      'a child the manager did not start is still a child a later manager must not step over')
    assert.equal(processAlive(recorded[0].pid), true)

    // The marker is what stops a second manager opening this directory over a live child.
    await manager.registry.patchInstance(instance.id, (row) => ({ runtime: { ...row.runtime, pid: 999_999 } }))
    await manager.registry.reclaimStale()
    assert.ok(manager.registry.instance(instance.id).orphaned, 'a dead manager with a living child is not a stale marker')

    await manager.registry.patchInstance(instance.id, () => ({ runtime: { pid: process.pid, children: recorded }, orphaned: undefined }))
    await manager.instances.stop(instance.id)
    assert.deepEqual(manager.registry.instance(instance.id).runtime, undefined)
  })
})

// ── Processes that outlive their manager ─────────────────────────────────────

/** Spawn the host script, wait for the role it reports as running, and hand back its pid. */
async function runningChildOf(t, env) {
  const child = spawn(process.execPath, [ORPHAN_PARENT], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  t.after(() => child.kill())
  let out = ''
  child.stderr.resume()
  const ready = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('the host never reported a running child: ' + out)), 30_000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      const line = out.trim().split('\n').pop()
      if (line.endsWith('}')) { clearTimeout(timer); done(JSON.parse(line)) }
    })
    child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`the host exited with ${code}: ${out}`)) })
  })
  assert.equal(ready.ready, true, JSON.stringify(ready))
  const pid = ready.children[0].pid
  assert.equal(processAlive(pid), true)
  return { host: child, pid }
}

/** Kill the host outright and wait for the kernel to agree the child has gone. */
async function outlives(pid, host) {
  host.kill('SIGKILL')
  let waited = 0
  while (processAlive(pid) && waited < 15_000) {
    await new Promise((done) => setTimeout(done, 100))
    waited += 100
  }
  return processAlive(pid)
}

test('a real Worker exits when the host that launched it dies', async (t) => {
  const { host, pid } = await runningChildOf(t, { ORPHAN_ROLE: 'worker' })
  assert.equal(await outlives(pid, host), false,
    'a Worker that outlives its host keeps its lease and its credentials while nothing left on the machine knows it exists')
})

test('a real Agent exits when the host that launched it dies', async (t) => {
  // A real Agent needs a real MCP endpoint and a real credential, so this one is paired first.
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Orphan agent', mode: 'local_agent' })
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' })
    const token = loadInstanceConfig(manager.registry.instance(instance.id).directory).agent.env.RULITH_TOKEN
    assert.match(token, /^rlt_agt_/)
    await manager.instances.closeHost(instance.id)

    const { host, pid } = await runningChildOf(t, {
      ORPHAN_ROLE: 'agent', ORPHAN_GATEWAY: gateway.origin, ORPHAN_TOKEN: token,
      ORPHAN_SERVE_PORT: String(await freeServePort()),
    })
    assert.equal(await outlives(pid, host), false,
      'an Agent that outlives its host still holds this Agent\'s one connection and can still write to a Board')
  })
})

/** A loopback port nothing is on, for the orphan Agent's task endpoint. */
function freeServePort() {
  return new Promise((done) => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)) })
  })
}

test('a manager that died is only reclaimed once its children are gone too', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Contested', { agentId: 'agent-alpha' })
    await manager.instances.closeHost(instance.id)

    // A dead manager whose child is still running. Clearing the marker here would let a second
    // host open the same directory over a live Agent.
    const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    t.after(() => survivor.kill())
    await manager.registry.patchInstance(instance.id, () => ({
      runtime: { pid: 999_999, startedAt: new Date().toISOString(), children: [{ role: 'agent', pid: survivor.pid }] } }))

    await manager.registry.reclaimStale()
    const orphaned = manager.registry.instance(instance.id).orphaned
    assert.ok(orphaned, 'a dead manager with a living child is not a stale marker to delete')
    assert.equal(orphaned.children[0].pid, survivor.pid)

    const refused = await manager.instances.open(instance.id).catch((error) => error)
    assert.match(refused.message, /still has processes from a Rulith manager that is gone/)
    assert.match(refused.message, new RegExp(String(survivor.pid)))
    assert.match(manager.instances.overview()[0].blocked, /still has processes/)

    survivor.kill()
    await new Promise((done) => survivor.once('exit', done))
    await manager.registry.reclaimStale()
    assert.equal(manager.registry.instance(instance.id).orphaned, undefined)
    assert.equal(manager.registry.instance(instance.id).runtime, undefined)
    assert.match((await manager.instances.open(instance.id)).url, /^http:\/\/127\.0\.0\.1:\d+\//)
  })
})

test('a running instance records the pids it owns, so the next manager can ask the kernel', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Recorded', { agentId: 'agent-alpha' })
    await manager.instances.start(instance.id)
    const runtime = manager.registry.instance(instance.id).runtime
    assert.equal(runtime.pid, process.pid)
    assert.deepEqual(runtime.children.map((child) => child.role).sort(), ['agent', 'worker'])
    for (const child of runtime.children) assert.equal(processAlive(child.pid), true)

    await manager.instances.stop(instance.id)
    assert.equal(manager.registry.instance(instance.id).runtime, undefined)
  })
})

// ── Convenience that must not become a credential path ───────────────────────

test('model settings can be reused between instances, and nothing else travels with them', async (t) => {
  await withManager(t, async ({ manager }) => {
    const source = await addInstance(manager, 'Configured', { agentId: 'agent-alpha' })
    const target = await addInstance(manager, 'Fresh', { agentId: 'agent-beta' })
    const configured = loadInstanceConfig(source.directory)
    configured.agent.env = { ...configured.agent.env,
      RULITH_MODEL_URL: 'http://127.0.0.1:8080/v1/messages', RULITH_MODEL: 'shared-model',
      RULITH_MODEL_KEY: 'provider-key', RULITH_MODEL_THINKING: 'enabled', RULITH_MODEL_MAX_OUTPUT_TOKENS: '12000' }
    saveInstanceConfig(source.directory, configured)

    const result = await manager.instances.copyModelSettings(target.id, source.id)
    assert.equal(result.model, 'shared-model')
    assert.equal(result.modelKeyCopied, true)
    assert.equal(JSON.stringify(result).includes('provider-key'), false, 'a model key must not come back in a response')

    const applied = loadInstanceConfig(target.directory).agent.env
    assert.equal(applied.RULITH_MODEL_URL, 'http://127.0.0.1:8080/v1/messages')
    assert.equal(applied.RULITH_MODEL_KEY, 'provider-key')
    assert.equal(applied.RULITH_MODEL_THINKING, 'enabled')
    assert.equal(applied.RULITH_MODEL_MAX_OUTPUT_TOKENS, '12000')
    // The identity of each instance is untouched.
    assert.notEqual(applied.RULITH_TOKEN, configured.agent.env.RULITH_TOKEN)
    assert.match(applied.RULITH_TOKEN, /^rlt_agt_/)
    assert.notEqual(loadInstanceConfig(target.directory).worker.env.RULITH_CONNECTION,
      loadInstanceConfig(source.directory).worker.env.RULITH_CONNECTION)

    // Not while the Agent it would change is running.
    await manager.instances.start(target.id)
    const busy = await manager.instances.copyModelSettings(target.id, source.id).catch((error) => error)
    assert.match(busy.message, /Stop it before changing its model configuration/)
  })
})

test('model settings are refused for a Worker-only instance and for itself', async (t) => {
  await withManager(t, async ({ manager }) => {
    const source = await addInstance(manager, 'Configured', { agentId: 'agent-alpha' })
    const worker = await addInstance(manager, 'Worker only', { agentId: 'agent-beta', mode: 'existing_client' })
    const configured = loadInstanceConfig(source.directory)
    configured.agent.env = { ...configured.agent.env, RULITH_MODEL_URL: 'http://127.0.0.1:8080/v1', RULITH_MODEL: 'm' }
    saveInstanceConfig(source.directory, configured)

    await assert.rejects(manager.instances.copyModelSettings(worker.id, source.id), /no model of its own/)
    await assert.rejects(manager.instances.copyModelSettings(source.id, source.id), /different instance/)
  })
})

test('copying an inherited model creates an independent override and replaces obsolete keys', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const source = await addInstance(manager, 'Default source', { agentId: 'agent-alpha' })
    const target = await addInstance(manager, 'Copy target', { agentId: 'agent-beta' })
    const scope = { expectedOrigin: gateway.origin, expectedAccountId: manager.device.status().account.id }
    await manager.instances.setDefaultModel({ ...scope, url: 'https://provider.example/v1', name: 'default', key: 'default-key', thinking: 'enabled' })
    await manager.instances.setInstanceModel(source.id, { ...scope, source: 'default' })
    const result = await manager.instances.copyModelSettings(target.id, source.id)
    assert.equal(result.model, 'default')
    assert.equal(result.modelKeyCopied, true)
    assert.equal(manager.instances.overview().find(row => row.id === target.id).model.source, 'custom')
    assert.equal(loadInstanceConfig(target.directory).agent.env.RULITH_MODEL_KEY, 'default-key')
    assert.equal(JSON.stringify(result).includes('default-key'), false)
    await manager.instances.setDefaultModel({ ...scope, url: 'http://127.0.0.1:8080/v1', name: 'keyless', key: '', thinking: 'standard' })
    assert.equal(loadInstanceConfig(target.directory).agent.env.RULITH_MODEL, 'default', 'the copied model is now independent')
    for (const open of [false, true]) {
      if (open) await manager.instances.open(target.id, '/setup')
      await manager.instances.setInstanceModel(target.id, { ...scope, source: 'custom', url: 'http://127.0.0.1:8080/v1',
        name: 'previous', key: 'obsolete-key', thinking: 'enabled' })
      const copied = await manager.instances.copyModelSettings(target.id, source.id)
      const env = loadInstanceConfig(target.directory).agent.env
      assert.equal(env.RULITH_MODEL, 'keyless')
      assert.equal(env.RULITH_MODEL_KEY, '', 'a copy clears the old key in both closed and open hosts')
      assert.equal(env.RULITH_MODEL_THINKING, '')
      assert.equal(copied.modelKeyCopied, false)
    }
  })
})

test('disabled thinking survives account inheritance, overrides, copying, and an open host', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const source = await addInstance(manager, 'Source', { agentId: 'agent-alpha' })
    const target = await addInstance(manager, 'Target', { agentId: 'agent-beta' })
    const scope = { expectedOrigin: gateway.origin, expectedAccountId: manager.device.status().account.id }
    await manager.instances.setDefaultModel({ ...scope, url: 'http://127.0.0.1:8080/v1', name: 'model', thinking: 'disabled', maxOutputTokens: 12000 })
    await manager.instances.setInstanceModel(source.id, { ...scope, source: 'default' })
    assert.equal(manager.instances.overview().find(row => row.id === source.id).model.thinking, 'disabled')
    assert.equal(manager.instances.overview().find(row => row.id === source.id).model.maxOutputTokens, 12000)
    for (const open of [false, true]) {
      if (open) await manager.instances.open(target.id, '/setup')
      await manager.instances.setInstanceModel(target.id, { ...scope, source: 'custom', url: 'http://127.0.0.1:8080/v1', name: 'other', thinking: 'enabled' })
      await manager.instances.copyModelSettings(target.id, source.id)
      assert.equal(loadInstanceConfig(target.directory).agent.env.RULITH_MODEL_THINKING, 'disabled')
      assert.equal(loadInstanceConfig(target.directory).agent.env.RULITH_MODEL_MAX_OUTPUT_TOKENS, '12000')
      assert.equal(manager.instances.overview().find(row => row.id === target.id).model.thinking, 'disabled')
    }
    await manager.instances.setDefaultModel({ ...scope, url: 'http://127.0.0.1:8080/v1', name: 'model' })
    assert.equal(manager.instances.overview().find(row => row.id === source.id).model.thinking, 'disabled', 'omitting thinking preserves the choice')
    assert.equal(manager.instances.overview().find(row => row.id === source.id).model.maxOutputTokens, 12000,
      'omitting the output budget preserves the choice')
  })
})

// ── The way back, and the rest of the surface ────────────────────────────────

test('an opened instance is given the manager\'s own address to return to, and never the device token', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await addInstance(manager, 'Linked back', { agentId: 'agent-alpha' })
    const opened = await manager.instances.open(instance.id)
    const url = new URL(opened.url)
    const back = new URL(url.searchParams.get('manager'))
    assert.equal(back.origin, `http://127.0.0.1:${manager.port}`)
    assert.equal(back.pathname, '/')
    assert.equal(back.searchParams.get('k'), KEY, 'the page needs the manager key to get back in; GET / is authenticated')
    assert.match(back.searchParams.get('k'), /^[A-Za-z0-9_-]{16,128}$/, 'the shape the Local pages will render')

    // Following it works, first time and every time.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(back.href)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /<title>Rulith<\/title>/)
    }

    // The cloud device management token is a different thing entirely and appears nowhere.
    const deviceToken = gateway.deviceToken(manager.device.peek().deviceId)
    const status = await fetch(`${url.origin}/status?k=${url.searchParams.get('k')}`).then((response) => response.json())
    const everything = JSON.stringify(status) + opened.url + JSON.stringify(manager.state())
    assert.equal(everything.includes(deviceToken), false)
    assert.equal(status.runtime.managerReturn, undefined, 'a machine-readable status body is not where a browser key belongs')
  })
})

test('the retired /mcp-services address keeps the way back', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Redirecting', { agentId: 'agent-alpha' })
    const url = new URL((await manager.instances.open(instance.id, '/worker-tools')).url)
    const manager_param = url.searchParams.get('manager')
    const response = await fetch(`${url.origin}/mcp-services?k=${encodeURIComponent(url.searchParams.get('k'))}&manager=${encodeURIComponent(manager_param)}`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    const location = new URL(response.headers.get('location'), url.origin)
    assert.equal(location.pathname, '/worker-tools')
    assert.equal(location.searchParams.get('manager'), manager_param,
      'a redirect that drops the launcher address leaves that one page with no way back')
  })
})

test('the manager answers exactly its documented control-plane operations', async (t) => {
  await withManager(t, async ({ manager }) => {
    const source = readFileSync(join(import.meta.dirname, '..', 'local', 'manager-server.mjs'), 'utf8')
    const routes = [...source.matchAll(/'(\/manager\/[a-z/]+)':/g)].map((match) => match[1]).sort()
    assert.deepEqual(routes, [
      '/manager/authoring/prepare', '/manager/authoring/review', '/manager/authoring/save', '/manager/authoring/status',
      '/manager/device/forget', '/manager/device/poll', '/manager/device/refresh', '/manager/device/signout',
      '/manager/device/start', '/manager/instances/control', '/manager/instances/create', '/manager/instances/forget', '/manager/instances/import',
      '/manager/instances/model', '/manager/instances/model/copy', '/manager/instances/open', '/manager/instances/pair',
      '/manager/instances/pair/cancel', '/manager/instances/pair/poll', '/manager/instances/start',
      '/manager/instances/stop', '/manager/model/default',
    ], 'a new manager operation is a new way to act on this computer and must be deliberate')
    assert.equal(routes.some((route) => /tool|resource|source|grant/.test(route)), false,
      'granting tools stays in Console and in each instance\'s own setup; the manager adds no second path')

    const unknown = await fetch(`http://127.0.0.1:${manager.port}/manager/instances/delete?k=${KEY}`, {
      method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(unknown.status, 404)
  })
})

test('direct authoring preparation refuses an unreadable material Source before any setup', async (t) => {
  await withManager(t, async ({ manager }) => {
    const call = async materialPermissions => {
      const response = await fetch(`http://127.0.0.1:${manager.port}/manager/authoring/prepare`, {
        method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: 'not-set-up', materialPermissions }),
      })
      return { status: response.status, body: await response.json() }
    }
    const denied = await call({ localRead: false, offMachine: false })
    assert.equal(denied.status, 400)
    assert.match(denied.body.teaching, /Choose local material delivery/)
    const malformed = await call({ localRead: true })
    assert.equal(malformed.status, 400)
    assert.match(malformed.body.teaching, /explicitly name localRead and offMachine/)
  })
})

test('document preparation checks Worker readiness before downloading and rechecks after a long installation', async t => {
  let downloads = 0, releaseInstall, enteredInstall
  const entered = new Promise(resolve => { enteredInstall = resolve })
  const installed = new Promise(resolve => { releaseInstall = resolve })
  await withManager(t, async ({ manager, gateway }) => {
    const row = await addInstance(manager, 'Preparation', { agentId: AGENTS[0] })
    const prepare = async () => {
      const response = await fetch(`http://127.0.0.1:${manager.port}/manager/authoring/prepare`, {
        method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: row.id, materialPermissions: { localRead: true, offMachine: false } }),
      })
      return { status: response.status, body: await response.json() }
    }
    const stopped = await prepare()
    assert.equal(stopped.status, 400)
    assert.match(stopped.body.teaching, /Start.*Worker/)
    assert.equal(downloads, 0, 'a known missing prerequisite does not download the checker')
    await manager.instances.control(row.id, { role: 'worker', operation: 'start' })
    const pending = prepare()
    try {
      await entered
      gateway.disableAgent(AGENTS[0])
      await manager.instances.refreshDevice()
    } finally { releaseInstall() }
    const changed = await pending
    assert.equal(changed.status, 400)
    assert.equal(downloads, 1)
    assert.equal(gateway.requests.some(request => /authoring\/prepare/.test(request.path)), false,
      'authorization withdrawn during download cannot create an installation')
  }, { installChecker: async () => { downloads += 1; enteredInstall(); await installed } })
})

test('a stalled public checker installation cannot delay stopping and signing out of the account', async t => {
  let releaseInstall, enteredInstall
  const entered = new Promise(resolve => { enteredInstall = resolve })
  const installed = new Promise(resolve => { releaseInstall = resolve })
  await withManager(t, async ({ manager, gateway }) => {
    const row = await addInstance(manager, 'Download sign-out', { agentId: AGENTS[0] })
    await manager.instances.start(row.id)
    const pending = fetch(`http://127.0.0.1:${manager.port}/manager/authoring/prepare`, {
      method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: row.id, materialPermissions: { localRead: true, offMachine: false } }),
    })
    await entered
    try {
      const response = await fetch(`http://127.0.0.1:${manager.port}/manager/device/signout`, {
        method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000),
      })
      assert.equal(response.status, 200)
      assert.equal(manager.device.status().state, 'none')
      assert.equal(manager.instances.hosts.has(row.id), false)
    } finally { releaseInstall() }
    const prepared = await pending
    assert.equal(prepared.status, 400)
    assert.equal(gateway.requests.some(request => /authoring\/prepare/.test(request.path)), false)
  }, { installChecker: async () => { enteredInstall(); await installed } })
})

test('the manager key must be a shape the Local pages will carry back', () => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-keyshape-'))
  try {
    for (const bad of ['short', 'has spaces in it!!', 'a'.repeat(129), 'plus+slash/chars=']) {
      assert.throws(() => createManagerServer({ root, port: 0, key: bad }), /16–128 characters/, bad)
    }
    const fine = createManagerServer({ root, port: 0, key: 'a'.repeat(32) })
    assert.equal(fine.key.length, 32)
    // The default is 32 hex, which the pages accept.
    assert.match(createManagerServer({ root, port: 0 }).key, /^[0-9a-f]{32}$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('removing an instance from the list keeps its directory and refuses while it is running', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Removable', { agentId: 'agent-alpha' })
    await manager.instances.start(instance.id)
    const refused = await manager.instances.forget(instance.id).catch((error) => error)
    assert.match(refused.message, /Stop this instance/)

    await manager.instances.stop(instance.id)
    const removed = await manager.instances.forget(instance.id)
    assert.equal(removed.directory, instance.directory)
    assert.equal(manager.registry.read().instances.length, 0)
    assert.equal(existsSync(join(instance.directory, 'local.json')), true,
      'tidying a list is not a reason to delete credentials and history')
  })
})

test('the manager page offers an existing installation without reading or changing it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rulith-offer-'))
  const root = join(home, 'manager')
  mkdirSync(root, { recursive: true })
  const legacyConfigFile = join(home, 'local.json')
  writeFileSync(legacyConfigFile, JSON.stringify({ roles: ['worker'], worker: { env: { RULITH_CONNECTION_KEY: 'legacy-connection-key' } } }, null, 2))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const before = readFileSync(legacyConfigFile, 'utf8')

  const manager = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile })
  await manager.listen()
  t.after(() => manager.close())
  const state = manager.state()
  assert.equal(state.legacyInstall.configFile, legacyConfigFile)
  assert.equal(state.legacyInstall.imported, false)
  assert.equal(readFileSync(legacyConfigFile, 'utf8'), before)
  assert.equal(JSON.stringify(state).includes('legacy-connection-key'), false,
    'offering an installation must not read its credentials into a page')
})

test('the manager page and its routes are gated against unauthenticated, cross-origin and rebound callers', async (t) => {
  await withManager(t, async ({ manager }) => {
    const port = manager.port
    const unauthenticated = await rawGet(port, '/', { Host: `127.0.0.1:${port}` })
    assert.equal(unauthenticated.status, 401)
    assert.doesNotMatch(unauthenticated.raw, /<!DOCTYPE html>/i, 'the manager page was served to an unauthenticated caller')
    assert.doesNotMatch(unauthenticated.raw, new RegExp(KEY))

    assert.equal((await rawGet(port, `/?k=${KEY}`, { Host: 'rulith-manager.attacker.example' })).status, 403)
    assert.equal((await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}`, Origin: 'https://attacker.example' })).status, 403)

    const page = await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}` })
    assert.equal(page.status, 200)
    assert.match(page.raw, /<title>Rulith<\/title>/)
    assert.doesNotMatch(page.raw.split('\r\n\r\n').slice(1).join(''), new RegExp(KEY),
      'the page must read its key from its address, not carry one')

    const other = await fetch(`http://127.0.0.1:${port}/manager/instances/create`, {
      method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json', origin: 'http://127.0.0.1:1' },
      body: JSON.stringify({ name: 'x' }),
    })
    assert.equal(other.status, 403)

    const extra = await fetch(`http://127.0.0.1:${port}/manager/device/start`, {
      method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ consoleUrl: 'https://console.rulith.ai', name: 'x', token: 'sneaky' }),
    })
    assert.equal(extra.status, 400)
    assert.match((await extra.json()).teaching, /Unexpected fields: token/)
  })
})


test('workbench Worker controls preserve its Agent and another instance, without replacing the conversation host', async t => {
  await withManager(t, async ({ manager }) => {
    const alpha = await addInstance(manager, 'alpha', { agentId: AGENTS[0] })
    const beta = await addInstance(manager, 'beta', { agentId: AGENTS[1] })
    await manager.instances.start(alpha.id)
    await manager.instances.start(beta.id)
    const before = manager.instances.hosts.get(alpha.id).host
    const betaBefore = manager.instances.hosts.get(beta.id).host
    const response = await fetch(`http://127.0.0.1:${manager.port}/manager/instances/control`, {
      method: 'POST', headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: alpha.id, role: 'worker', operation: 'stop' }),
    })
    const outcome = await response.json()
    assert.equal(response.status, 200)
    assert.equal(outcome.stopped, true)
    assert.equal(before.status().agent, true)
    assert.equal(before.status().worker, false)
    assert.equal(manager.instances.hosts.get(alpha.id).host, before)
    assert.equal(manager.instances.hosts.get(beta.id).host, betaBefore)
    assert.equal(betaBefore.status().agent, true)
    assert.equal(betaBefore.status().worker, true)
    const restarted = await manager.instances.control(alpha.id, { role: 'worker', operation: 'start' })
    assert.equal(restarted.started, true)
    await assert.rejects(manager.instances.control(alpha.id, { role: 'all', operation: 'stop' }), /Choose/)
    await assert.rejects(manager.instances.control(alpha.id, { role: 'worker', operation: 'restart' }), /Choose/)
  })
})

test('Worker-only profiles cannot start a model Agent through workbench role controls', async t => {
  await withManager(t, async ({ manager }) => {
    const row = await addInstance(manager, 'external client', { agentId: AGENTS[0], mode: 'existing_client' })
    await assert.rejects(manager.instances.control(row.id, { role: 'agent', operation: 'start' }), /does not run/)
    assert.equal((await manager.instances.control(row.id, { role: 'worker', operation: 'start' })).started, true)
    assert.equal(manager.instances.hosts.get(row.id).host.status().agent, false)
  })
})

test('refreshing the enabled account directory stops a disabled Agent and refuses another start', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const row = await addInstance(manager, 'Disabled after refresh', { agentId: AGENTS[0] })
    assert.equal((await manager.instances.start(row.id)).started, true)
    gateway.disableAgent(AGENTS[0])
    const refreshed = await manager.instances.refreshDevice()
    assert.deepEqual(refreshed.removedAgents.map(agent => agent.id), [AGENTS[0]])
    assert.deepEqual(refreshed.stoppedInstances.map(instance => instance.id), [row.id])
    assert.equal(manager.instances.hosts.has(row.id), false, 'the observed stop closes the host only after both roles exit')
    await assert.rejects(manager.instances.start(row.id), /no longer enabled/)
  })
})

test('a directory network failure preserves live work, while confirmed revocation attempts every stop and exposes failures', async t => {
  await withManager(t, async ({ manager, gateway, deviceId }) => {
    const first = await addInstance(manager, 'First', { agentId: AGENTS[0] })
    const second = await addInstance(manager, 'Second', { agentId: AGENTS[1] })
    const third = await addInstance(manager, 'Third', { agentId: AGENTS[2] })
    await manager.instances.start(first.id)
    await manager.instances.start(second.id)
    await manager.instances.start(third.id)
    gateway.failNext('/local-devices/context')
    await assert.rejects(manager.instances.refreshDevice())
    assert.equal(manager.device.status().state, 'linked')
    assert.equal(manager.instances.overview().every(row => row.agent && row.worker), true)
    const stop = manager.instances.stop, attempted = []
    manager.instances.stop = async id => {
      attempted.push(id)
      if (id === first.id) throw Error('simulated stop failure')
      if (id === second.id) return { stopped: false, results: [{ role: 'worker', state: 'stopping' }] }
      return stop(id)
    }
    try {
      gateway.revokeDeviceFromConsole(deviceId)
      await assert.rejects(manager.instances.refreshDevice(), error => {
        assert.match(error.message, /Local processes still need attention: First, Second/)
        assert.deepEqual(error.stoppingInstances.map(row => row.id), [first.id, second.id])
        return true
      })
      assert.deepEqual(attempted, [first.id, second.id, third.id])
      assert.equal(manager.instances.hosts.has(third.id), false)
      assert.match(manager.instances.overview().find(row => row.id === first.id).accessStopWarning, /simulated stop failure/)
      assert.match(manager.instances.overview().find(row => row.id === second.id).accessStopWarning, /have not exited/)
      assert.equal(manager.device.status().state, 'unusable')
    } finally { manager.instances.stop = stop }
    await stop(first.id)
    await stop(second.id)
    assert.equal(manager.instances.overview().find(row => row.id === first.id).accessStopWarning, '')
  })
})

test('a Connection key replacement proves the fixed Worker identity before atomically saving it', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const row = await addInstance(manager, 'Connection replacement', { agentId: AGENTS[0] })
    const connected = manager.instances.overview().find(entry => entry.id === row.id)
    const scope = { expectedOrigin: gateway.origin, expectedAccountId: manager.device.status().account.id,
      expectedAgentId: connected.agentId, expectedConnectionId: connected.connectionId }
    const before = loadInstanceConfig(row.directory).worker.env.RULITH_CONNECTION_KEY
    const replacement = 'replacement-key-must-not-leak'
    gateway.replaceConnectionKey(connected.connectionId, replacement)

    assert.equal((await manager.instances.control(row.id, { role: 'worker', operation: 'start' })).started, true)
    await assert.rejects(manager.instances.setConnectionKey(row.id, { ...scope, key: replacement }), /Stop Worker/)
    assert.equal(loadInstanceConfig(row.directory).worker.env.RULITH_CONNECTION_KEY, before, 'a running Worker prevents any local write')
    assert.equal((await manager.instances.control(row.id, { role: 'worker', operation: 'stop' })).stopped, true)

    const rejected = await manager.instances.setConnectionKey(row.id, { ...scope, key: 'unverified-input-key' }).catch(error => error)
    assert.match(rejected.message, /could not verify the replacement Connection key/)
    assert.equal(rejected.message.includes('unverified-input-key'), false, 'a remote refusal cannot reflect the submitted key')
    assert.equal(loadInstanceConfig(row.directory).worker.env.RULITH_CONNECTION_KEY, before, 'failed verification leaves the old local value untouched')

    const saved = await manager.instances.setConnectionKey(row.id, { ...scope, key: replacement })
    assert.deepEqual(saved, { instanceId: row.id, agentId: connected.agentId, connectionId: connected.connectionId, keyConfigured: true })
    assert.equal(loadInstanceConfig(row.directory).worker.env.RULITH_CONNECTION_KEY, replacement)
    assert.equal(JSON.stringify(manager.state()).includes(replacement), false, 'a manager state response never discloses a Connection key')
    assert.equal(manager.instances.hosts.get(row.id).host.status().worker, false)
    assert.equal((await manager.instances.control(row.id, { role: 'worker', operation: 'start' })).started, true)
    assert.equal(childEvents(manager, row.id, 'worker').filter(event => event.observed !== undefined).at(-1).observed.RULITH_CONNECTION_KEY,
      replacement, 'the next Worker receives only the verified replacement')

    await assert.rejects(manager.instances.setConnectionKey(row.id, { ...scope, expectedConnectionId: 'conn-other', key: replacement }), /Agent or Connection changed/)
  })
})

test('account defaults are scoped, inherited at the next Agent start, and never leak their key', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const scope = { expectedOrigin: gateway.origin, expectedAccountId: manager.device.status().account.id }
    const call = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${manager.port}${path}`, { method: 'POST',
        headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { response, body: await response.json() }
    }
    const defaulted = await manager.instances.create({ name: 'Inherited', mode: 'local_agent',
      setupTarget: { origin: gateway.origin, accountId: scope.expectedAccountId, agentId: AGENTS[0] } })
    assert.equal(manager.instances.overview().find(row => row.id === defaulted.id).model.source, 'default')
    const saved = await call('/manager/model/default', { ...scope, url: 'https://provider.example/v1', name: 'remote-default',
      key: 'default-key-must-not-leak', maxOutputTokens: 12000 })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.body.modelDefaults.configured, true, 'a remote model with a key is configured')
    assert.equal(JSON.stringify(saved.body).includes('default-key-must-not-leak'), false)
    await manager.instances.pair(defaulted.id, { agentId: AGENTS[0] })
    await manager.instances.closeHost(defaulted.id)
    const config = loadInstanceConfig(defaulted.directory)
    config.paths = { agent: ECHO, worker: ECHO }
    saveInstanceConfig(defaulted.directory, config)
    assert.equal((await manager.instances.start(defaulted.id)).started, true)
    assert.equal(observedEnv(manager, defaulted.id, 'agent').RULITH_MODEL, 'remote-default', 'the actual child received the inherited model')
    assert.equal(observedEnv(manager, defaulted.id, 'agent').RULITH_MODEL_MAX_OUTPUT_TOKENS, '12000')
    assert.equal(observedEnv(manager, defaulted.id, 'agent').RULITH_MODEL_KEY, 'default-key-must-not-leak')
    assert.equal(observedEnv(manager, defaulted.id, 'worker').RULITH_MODEL_KEY, undefined, 'the Worker never receives the Agent model key')
    assert.equal(loadInstanceConfig(defaulted.directory).agent.env.RULITH_MODEL_KEY, '', 'an inherited key was not persisted in the profile')
    assert.equal(manager.instances.overview().find(row => row.id === defaulted.id).model.workerRestartRequired, false)

    const changed = await call('/manager/model/default', { ...scope, url: 'http://127.0.0.1:11434/v1',
      name: 'second-local', key: '', maxOutputTokens: 16000 })
    assert.equal(changed.response.status, 200)
    assert.equal(changed.body.modelDefaults.configured, true, 'loopback models may omit a provider key')
    assert.equal(changed.body.instances.find(row => row.id === defaulted.id).model.restartRequired, true)
    assert.equal((await manager.instances.control(defaulted.id, { role: 'agent', operation: 'stop' })).stopped, true)
    assert.equal(manager.instances.hosts.get(defaulted.id).host.status().worker, true, 'the Worker remains running while only Agent restarts')
    assert.equal((await manager.instances.control(defaulted.id, { role: 'agent', operation: 'start' })).started, true)
    assert.equal(childEvents(manager, defaulted.id, 'agent').filter(row => row.observed !== undefined).at(-1).observed.RULITH_MODEL,
      'second-local', 'a default change applies on the next Agent start')
    assert.equal(childEvents(manager, defaulted.id, 'agent').filter(row => row.observed !== undefined).at(-1).observed.RULITH_MODEL_MAX_OUTPUT_TOKENS,
      '16000', 'the changed budget applies on the next Agent start')
    assert.equal(manager.instances.overview().find(row => row.id === defaulted.id).model.workerRestartRequired, true,
      'a Worker still bound to the old endpoint must be named as needing restart for new attachments')
    await manager.instances.control(defaulted.id, { role: 'worker', operation: 'stop' })
    await manager.instances.control(defaulted.id, { role: 'worker', operation: 'start' })
    assert.equal(manager.instances.overview().find(row => row.id === defaulted.id).model.workerRestartRequired, false)
    await manager.instances.stop(defaulted.id)

    const opened = await manager.instances.open(defaulted.id, '/setup')
    const setupUrl = new URL(opened.url)
    const manual = await fetch(setupUrl.origin + '/setup/model', { method: 'POST',
      headers: { 'x-rulith-local': setupUrl.searchParams.get('k'), 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:11434/v1', name: 'manual-custom', key: '' }) })
    assert.equal(manual.status, 200)
    assert.equal(manager.instances.overview().find(row => row.id === defaulted.id).model.source, 'custom',
      'an existing Setup page write explicitly leaves inheritance')
    await manager.instances.closeHost(defaulted.id)

    const custom = await call('/manager/instances/model', { ...scope, instanceId: defaulted.id, source: 'custom',
      url: 'https://provider.example/v1', name: 'remote', key: 'do-not-return-this-key', thinking: 'enabled' })
    assert.equal(custom.response.status, 200)
    assert.equal(custom.body.instances.find(row => row.id === defaulted.id).model.source, 'custom')
    assert.equal(JSON.stringify(custom.body).includes('do-not-return-this-key'), false)
    const retained = await call('/manager/instances/model', { ...scope, instanceId: defaulted.id, source: 'custom',
      url: 'https://provider.example/v1', name: 'remote', key: '', clearKey: false })
    assert.equal(retained.response.status, 200)
    assert.equal(loadInstanceConfig(defaulted.directory).agent.env.RULITH_MODEL_KEY, 'do-not-return-this-key',
      'a blank key retains a key only for the same provider origin')
    const changedEndpoint = await call('/manager/instances/model', { ...scope, instanceId: defaulted.id, source: 'custom',
      url: 'https://other-provider.example/v1', name: 'other', key: '', clearKey: false })
    assert.equal(changedEndpoint.response.status, 200)
    assert.equal(changedEndpoint.body.instances.find(row => row.id === defaulted.id).model.configured, false)
    assert.equal(loadInstanceConfig(defaulted.directory).agent.env.RULITH_MODEL_KEY, '', 'a blank key cannot cross provider origins')
    const stale = await call('/manager/instances/model', { ...scope, expectedAccountId: 'another-account', instanceId: defaulted.id,
      source: 'default' })
    assert.equal(stale.response.status, 400)
    assert.match(stale.body.teaching, /account or Console address changed/)

    const old = await manager.instances.create({ name: 'Old profile' })
    const external = await manager.instances.create({ name: 'External', mode: 'existing_client' })
    const models = manager.instances.overview()
    assert.equal(models.find(row => row.id === old.id).model.source, 'custom', 'a profile without the new marker keeps its old model')
    assert.equal(models.find(row => row.id === external.id).model.source, 'external')
  })
})

test('leaving a keyed account default needs an explicit custom key', async t => {
  await withManager(t, async ({ manager, gateway }) => {
    const row = await addInstance(manager, 'Default to custom', { agentId: AGENTS[0] })
    const scope = { expectedOrigin: gateway.origin, expectedAccountId: manager.device.status().account.id }
    await manager.instances.setDefaultModel({ ...scope, url: 'https://provider.example/v1', name: 'account-default', key: 'account-default-key' })
    await manager.instances.setInstanceModel(row.id, { ...scope, source: 'default' })

    await manager.instances.setInstanceModel(row.id, { ...scope, source: 'custom',
      url: 'https://provider.example/v1', name: 'custom-name', key: '', clearKey: false })
    let model = manager.instances.overview().find(entry => entry.id === row.id).model
    assert.equal(model.source, 'custom')
    assert.equal(model.configured, false, 'a remote custom configuration without an entered key is not ready')
    assert.equal(loadInstanceConfig(row.directory).agent.env.RULITH_MODEL_KEY, '', 'the account default key was not copied into the profile')
    await assert.rejects(manager.instances.start(row.id), /no ready model configuration/)

    await manager.instances.setInstanceModel(row.id, { ...scope, source: 'custom',
      url: 'https://provider.example/v1', name: 'custom-name', key: 'explicit-custom-key' })
    assert.equal((await manager.instances.start(row.id)).started, true, 'an explicitly entered custom key starts the real Agent fixture')
    await manager.instances.stop(row.id)
    await manager.instances.setInstanceModel(row.id, { ...scope, source: 'custom',
      url: 'https://provider.example/v1', name: 'renamed-custom', key: '', clearKey: false })
    assert.equal(loadInstanceConfig(row.directory).agent.env.RULITH_MODEL_KEY, 'explicit-custom-key',
      'an existing custom configuration retains only its own same-service key')
    await manager.instances.setInstanceModel(row.id, { ...scope, source: 'custom',
      url: 'https://other-provider.example/v1', name: 'other-custom', key: '', clearKey: false })
    model = manager.instances.overview().find(entry => entry.id === row.id).model
    assert.equal(model.configured, false)
    assert.equal(loadInstanceConfig(row.directory).agent.env.RULITH_MODEL_KEY, '', 'a key does not cross provider origins')

    const live = await addInstance(manager, 'Live default to custom', { agentId: AGENTS[1] })
    await manager.instances.setInstanceModel(live.id, { ...scope, source: 'custom',
      url: 'https://provider.example/v1', name: 'old-custom', key: 'shadow-custom-key' })
    await manager.instances.open(live.id, '/setup')
    await manager.instances.setInstanceModel(live.id, { ...scope, source: 'default' })
    await manager.instances.setInstanceModel(live.id, { ...scope, source: 'custom',
      url: 'https://provider.example/v1', name: 'new-custom', key: '', clearKey: false })
    assert.equal(loadInstanceConfig(live.directory).agent.env.RULITH_MODEL_KEY, '',
      'an open host cannot re-retain its old custom key after leaving the default')
    await assert.rejects(manager.instances.start(live.id), /no ready model configuration/)
  })
})
