// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-assisted account login, as this computer experiences it.
 *
 * Every arm drives the real manager server over real HTTP against the real device routes.
 * What they are protecting is narrow and specific:
 *
 *   · the grant is delivered **encrypted to a key this computer made**, and delivery survives
 *     a lost acknowledgement without asking for a second token;
 *   · nothing a page can read ever contains the device token, the proof or the private key;
 *   · a grant the Gateway stops accepting — revoked, expired, or gone with its account —
 *     makes this installation's status unusable, and nothing re-authorizes itself;
 *   · sign-out is stop, then revoke, then forget, and a step that did not happen is reported
 *     as incomplete rather than as a sign-out.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Socket } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createManagerServer } from '../local/manager-server.mjs'
import { createDevicesGateway } from './support/local-devices-gateway.mjs'

const KEY = 'manager-test-key'

/** A manager and a Gateway, both on real loopback sockets, torn down together. */
async function withManager(t, run) {
  const root = mkdtempSync(join(tmpdir(), 'rulith-manager-'))
  const gateway = createDevicesGateway()
  await gateway.listen()
  const manager = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
  await manager.listen()
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${manager.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-rulith-manager': KEY, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  t.after(async () => {
    await manager.close()
    await gateway.close()
    rmSync(root, { recursive: true, force: true })
  })
  await run({ manager, gateway, call, root })
}

/** Sign in end to end and return the device id the Gateway created. */
async function signIn(gateway, call, agentIds = ['agent-alpha', 'agent-beta']) {
  const started = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Test computer' })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  const approved = gateway.approve(started.body.device.code, agentIds)
  const linked = await call('/manager/device/poll', {})
  assert.equal(linked.status, 200, JSON.stringify(linked.body))
  assert.equal(linked.body.device.state, 'linked')
  return approved.deviceId
}

test('an approved login with a failed acknowledgement can reset only through confirmed sign-out', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    const start = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Reset computer' })
    const grant = gateway.approve(start.body.device.code, ['agent-alpha'])
    gateway.failNext('/local-devices/ack')
    const interrupted = await call('/manager/device/poll', {})
    assert.equal(interrupted.body.device.state, 'approved')
    const refused = await call('/manager/device/forget', {})
    assert.equal(refused.status, 400, 'delivered credentials must not be silently discarded')
    gateway.failNext('/local-devices/revoke')
    const retry = await call('/manager/device/signout', {})
    assert.equal(retry.body.state, 'incomplete')
    assert.equal(retry.body.device.state, 'approved', 'a failed revoke preserves the credential for retry')
    const reset = await call('/manager/device/signout', {})
    assert.equal(reset.body.state, 'signed_out')
    assert.equal(reset.body.device.state, 'none')
    assert.equal(gateway.revocationRecord(grant.deviceId).state, 'revoked')
  })
})

for (const failure of ['before request', 'after request']) test('unfinished sign-in retries its original proof ' + failure, async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    if (failure === 'before request') gateway.failNext('/local-devices/start')
    else gateway.dropResponseAfterEffect('/local-devices/start')
    const failed = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Retry computer' })
    assert.equal(failed.status, 400)
    assert.equal(failed.body.device.state, 'pending')
    assert.equal(failed.body.device.code, '')
    assert.match(failed.body.device.teaching, /Sign-in did not finish/)
    assert.match((await call('/manager/state')).body.device.teaching, /Sign-in did not finish/, 'failure remains visible after reloading')
    assert.equal((await call('/manager/device/poll', {})).status, 400)
    assert.equal(gateway.requests.some(request => request.path === '/local-devices/poll'), false, 'no meaningless poll without a device id')
    const retried = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Retry computer' })
    assert.equal(retried.status, 200)
    assert.match(retried.body.device.code, /^[A-Z0-9]{8}$/)
    assert.equal(retried.body.device.teaching, '')
    const starts = gateway.requests.filter(request => request.path === '/local-devices/start')
    assert.equal(starts.length, 2)
    assert.deepEqual(starts[0].body, starts[1].body, 'request identity and possession proof must survive the lost response')
    gateway.approve(retried.body.device.code, ['agent-alpha'])
    assert.equal((await call('/manager/device/poll', {})).body.device.state, 'linked')
  })
})

test('a device grant is delivered encrypted, survives a lost acknowledgement, and asks for no second token', async (t) => {
  await withManager(t, async ({ gateway, call, root }) => {
    const started = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Test computer' })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.device.state, 'pending')
    assert.match(started.body.device.code, /^[A-Z0-9]{8}$/)
    assert.match(started.body.device.consoleUrl, /\/console\/#\/devices\?code=/)

    const grant = gateway.requests.find((row) => row.path === '/local-devices/start')
    assert.deepEqual(Object.keys(grant.body).sort(), ['deviceDigest', 'name', 'publicKey', 'requestId'])
    assert.equal(grant.origin, undefined, 'a server-to-server route must not be called with a browser origin')
    assert.equal(grant.query, '', 'no secret may travel in a query string')
    assert.equal(JSON.stringify(gateway.requests).includes('PRIVATE KEY'), false)

    assert.equal((await call('/manager/device/poll', {})).body.device.state, 'pending', 'nothing is delivered before a browser approves')

    gateway.approve(started.body.device.code, ['agent-alpha', 'agent-beta'])
    // The acknowledgement fails once. The token is already persisted, so the retry must
    // finish the same delivery rather than request another one.
    gateway.failNext('/local-devices/ack')
    const interrupted = await call('/manager/device/poll', {})
    assert.equal(interrupted.status, 400)
    assert.equal(interrupted.body.device.state, 'approved', 'a persisted-but-unacknowledged grant is not reported as linked')

    const resumed = await call('/manager/device/poll', {})
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.equal(resumed.body.device.state, 'linked')
    assert.equal(gateway.requests.filter((row) => row.path === '/local-devices/poll').length, 2,
      'the resumed delivery acknowledges the token it already holds instead of fetching a replacement')
    assert.deepEqual(resumed.body.device.agents.map((row) => row.id), ['agent-alpha', 'agent-beta', 'agent-gamma'])

    // What is on disk after delivery, and what a page can read.
    const stored = JSON.parse(readFileSync(join(root, 'device.json'), 'utf8'))
    assert.equal(stored.privateKey, undefined, 'the delivery key is not kept after delivery')
    assert.equal(stored.deviceSecret, undefined, 'the one-time proof is not kept after delivery')
    assert.match(stored.token, /^rlt_dev_/)
    const page = JSON.stringify(resumed.body)
    for (const secret of [stored.token, 'PRIVATE KEY', 'deviceSecret', 'rlt_dev_']) {
      assert.equal(page.includes(secret), false, `manager state disclosed ${secret}`)
    }
  })
})

test('the device proof is what claims a delivery, and a wrong one claims nothing', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    const started = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Test computer' })
    const approved = gateway.approve(started.body.device.code, ['agent-alpha'])
    const wrong = await fetch(gateway.origin + '/local-devices/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: approved.deviceId, deviceSecret: 'f'.repeat(64) }),
    })
    assert.equal(wrong.status, 403)
    assert.equal((await wrong.json()).encryptedDeviceToken, undefined)
    // The real proof still works afterwards: a refused attempt consumes nothing.
    assert.equal((await call('/manager/device/poll', {})).body.device.state, 'linked')
  })
})

test('a second sign-in is refused while one is already signed in', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    await signIn(gateway, call)
    const again = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Another' })
    assert.equal(again.status, 400)
    assert.match(again.body.teaching, /already signed in/i)
    assert.equal(again.body.device.state, 'linked', 'the refusal did not disturb the existing grant')
  })
})

test('enabled Agents are synchronized from the account, not remembered from sign-in', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    gateway.disableAgent('agent-beta')
    await signIn(gateway, call, ['agent-alpha'])
    assert.deepEqual((await call('/manager/state')).body.device.agents.map((row) => row.id), ['agent-alpha', 'agent-gamma'])
    gateway.enableAgent('agent-beta')
    const refreshed = await call('/manager/device/refresh', {})
    assert.equal(refreshed.status, 200)
    assert.deepEqual(refreshed.body.device.agents.map((row) => row.id), ['agent-alpha', 'agent-beta', 'agent-gamma'],
      'an enabled Agent omitted during sign-in appears after refresh')
    assert.deepEqual(refreshed.body.addedAgents.map((row) => row.id), ['agent-beta'])
    gateway.disableAgent('agent-beta')
    const disabled = await call('/manager/device/refresh', {})
    assert.deepEqual(disabled.body.device.agents.map((row) => row.id), ['agent-alpha', 'agent-gamma'])
    assert.deepEqual(disabled.body.removedAgents.map((row) => row.id), ['agent-beta'])
  })
})

test('a login remains linked when the account currently has no enabled Agents', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    for (const agent of ['agent-alpha', 'agent-beta', 'agent-gamma']) gateway.disableAgent(agent)
    await signIn(gateway, call, ['agent-alpha'])
    const state = await call('/manager/state')
    assert.equal(state.body.device.state, 'linked')
    assert.deepEqual(state.body.device.agents, [], 'an empty dynamic directory is not a failed login')
  })
})

test('one denied Agent does not sign this computer out', async (t) => {
  await withManager(t, async ({ gateway, call, manager }) => {
    await signIn(gateway, call, ['agent-alpha', 'agent-beta'])
    // Console removes an Agent from the account. This computer has not refreshed yet, so it
    // still offers it — and the service refuses that one request, not the device.
    gateway.disableAgent('agent-beta')
    const instance = await manager.instances.create({ name: 'Beta', mode: 'local_agent' })
    const refused = await manager.instances.pair(instance.id, { agentId: 'agent-beta' }).catch((error) => error)
    assert.ok(refused instanceof Error)

    const pairRequest = gateway.requests.filter((row) => row.path === '/local-devices/pair')
    assert.equal(pairRequest.length, 1, 'the refusal came from the account service, not from a local list')
    assert.equal(manager.device.status().state, 'linked',
      'a request outside this grant\'s scope is not the grant being withdrawn')
    assert.equal((await call('/manager/state')).body.device.state, 'linked')

    // And the rest of the grant still works.
    const other = await manager.instances.create({ name: 'Alpha', mode: 'local_agent' })
    const paired = await manager.instances.pair(other.id, { agentId: 'agent-alpha' })
    assert.equal(paired.agentId, 'agent-alpha')
  })
})

test('a device-level refusal of an operation does make the grant unusable', async (t) => {
  await withManager(t, async ({ gateway, call, manager }) => {
    const deviceId = await signIn(gateway, call, ['agent-alpha'])
    const instance = await manager.instances.create({ name: 'Alpha', mode: 'local_agent' })
    // The owner revokes the device in Console between the sign-in and the attachment.
    gateway.revokeDeviceFromConsole(deviceId)
    const refused = await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch((error) => error)
    assert.ok(refused instanceof Error)
    assert.equal(manager.device.status().state, 'unusable',
      'the account service naming a device-level reason is the one case that changes local status')
  })
})

test('an expired grant becomes unusable and nothing re-authorizes itself', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    const deviceId = await signIn(gateway, call)
    gateway.expireDevice(deviceId)
    const refreshed = await call('/manager/device/refresh', {})
    assert.equal(refreshed.status, 400)
    assert.equal(refreshed.body.device.state, 'unusable')
    assert.match(refreshed.body.device.teaching, /expired/i)
    const before = gateway.requests.length
    assert.equal((await call('/manager/device/refresh', {})).status, 400)
    assert.equal(gateway.requests.length, before, 'an unusable grant is not retried against the account service')
  })
})

test('an unusable grant is cleared deliberately before another sign-in, not signed in over', async (t) => {
  await withManager(t, async ({ gateway, call, root }) => {
    const deviceId = await signIn(gateway, call)
    gateway.expireDevice(deviceId)
    await call('/manager/device/refresh', {})

    const over = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Test computer' })
    assert.equal(over.status, 400)
    assert.match(over.body.teaching, /Clear it first/)
    assert.equal(existsSync(join(root, 'device.json')), true, 'the unusable record is still there to be cleared')

    const cleared = await call('/manager/device/forget', {})
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.device.state, 'none')
    assert.equal((await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Test computer' })).status, 200)
  })
})

test('a signed-in device cannot be forgotten without revoking it', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    await signIn(gateway, call)
    const refused = await call('/manager/device/forget', {})
    assert.equal(refused.status, 400)
    assert.match(refused.body.teaching, /Sign out and stop this device/)
    assert.equal(refused.body.device.state, 'linked')
  })
})

test('deleting the account takes its device grants with it', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    await signIn(gateway, call)
    gateway.deleteAccount()
    const refreshed = await call('/manager/device/refresh', {})
    assert.equal(refreshed.status, 400)
    assert.equal(refreshed.body.device.state, 'unusable')
  })
})

test('sign-out revokes at the account service and then forgets the local record', async (t) => {
  await withManager(t, async ({ gateway, call, root }) => {
    const deviceId = await signIn(gateway, call)
    const token = gateway.deviceToken(deviceId)
    const out = await call('/manager/device/signout', {})
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(out.body.state, 'signed_out')
    assert.equal(out.body.device.state, 'none')
    assert.equal(existsSync(join(root, 'device.json')), false, 'the local device record is removed only after the revoke succeeded')

    const denied = await fetch(gateway.origin + '/local-devices/context', { headers: { authorization: 'Bearer ' + token } })
    assert.equal(denied.status, 401, 'management with the revoked grant must be denied at the service')
  })
})

test('a revoke the account service did not confirm leaves this device signed in, with the same retry identity', async (t) => {
  await withManager(t, async ({ gateway, call, root }) => {
    await signIn(gateway, call)
    gateway.failNext('/local-devices/revoke')
    const failed = await call('/manager/device/signout', {})
    assert.equal(failed.status, 200)
    assert.equal(failed.body.state, 'incomplete')
    assert.equal(failed.body.step, 'revoke')
    assert.equal(failed.body.device.state, 'linked', 'an unconfirmed revoke must never read as signed out')
    const firstRequestId = JSON.parse(readFileSync(join(root, 'device.json'), 'utf8')).revokeRequestId
    assert.ok(firstRequestId)

    const retried = await call('/manager/device/signout', {})
    assert.equal(retried.body.state, 'signed_out')
    const revokes = gateway.requests.filter((row) => row.path === '/local-devices/revoke')
    assert.equal(revokes.length, 2)
    assert.equal(revokes[0].body.requestId, revokes[1].body.requestId,
      'a retried sign-out repeats the same revoke request rather than issuing a second one')
  })
})

test('a self-revoke can be repeated after it has already taken effect', async (t) => {
  await withManager(t, async ({ gateway, call }) => {
    const deviceId = await signIn(gateway, call)
    const token = gateway.deviceToken(deviceId)
    await call('/manager/device/signout', {})
    const again = await fetch(gateway.origin + '/local-devices/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ requestId: 'retry-after-effect' }),
    })
    assert.equal(again.status, 200)
    const body = await again.json()
    assert.equal(body.state, 'revoked')
    assert.equal(body.alreadyRevoked, true, 'a repeat is the same fact, not a second revocation')
  })
})

test('a device the browser revoked first is signed out here without a second audit entry', async (t) => {
  await withManager(t, async ({ gateway, call, root }) => {
    const deviceId = await signIn(gateway, call)
    // The owner revokes it from the Console device list. This computer does not know yet.
    gateway.revokeDeviceFromConsole(deviceId)
    const consoleRecord = gateway.revocationRecord(deviceId)
    assert.equal(consoleRecord.revokedBy, 'console')

    const out = await call('/manager/device/signout', {})
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(out.body.state, 'signed_out', 'a grant that is already revoked is not a reason to refuse to finish signing out')
    assert.equal(out.body.alreadyRevoked, true)
    assert.equal(out.body.device.state, 'none')
    assert.equal(existsSync(join(root, 'device.json')), false)

    const after = gateway.revocationRecord(deviceId)
    assert.deepEqual(after, consoleRecord, 'the audit record belongs to whoever made the revocation and must not be rewritten')
  })
})

test('a grant the service already refuses can still be cleared, with the revoke retried once more', async (t) => {
  await withManager(t, async ({ gateway, call, manager, root }) => {
    const deviceId = await signIn(gateway, call, ['agent-alpha'])
    const instance = await manager.instances.create({ name: 'Alpha', mode: 'local_agent' })
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' })
    const directory = manager.registry.instance(instance.id).directory

    // Expiry the browser never told this computer about: the status becomes unusable.
    gateway.expireDevice(deviceId)
    await call('/manager/device/refresh', {}).catch(() => undefined)
    assert.equal(manager.device.status().state, 'unusable')

    const before = gateway.requests.filter((row) => row.path === '/local-devices/revoke').length
    const cleared = await call('/manager/device/forget', {})
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.equal(cleared.body.state, 'none')
    assert.equal(gateway.requests.filter((row) => row.path === '/local-devices/revoke').length, before + 1,
      'an unusable local status must not permanently prevent the exact revoke from being retried')
    assert.equal(cleared.body.revoke, 'confirmed')
    assert.equal(existsSync(join(root, 'device.json')), false)

    // The credentials that grant issued are gone from the instance it issued them to.
    const config = JSON.parse(readFileSync(join(directory, 'local.json'), 'utf8'))
    assert.equal(config.agent.env.RULITH_TOKEN, '')
    assert.equal(config.worker.env.RULITH_CONNECTION_KEY, '')
    assert.equal(config.agent.env.RULITH_MODEL_URL !== '', true, 'clearing credentials is not clearing configuration')
  })
})

test('a device record that cannot be read is reported, not overwritten, and can still be cleared', async (t) => {
  await withManager(t, async ({ gateway, call, manager, root }) => {
    const deviceId = await signIn(gateway, call, ['agent-alpha'])
    const instance = await manager.instances.create({ name: 'Alpha', mode: 'local_agent' })
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' })
    const directory = manager.registry.instance(instance.id).directory

    const file = join(root, 'device.json')
    const damaged = readFileSync(file, 'utf8').slice(0, 30)
    writeFileSync(file, damaged)

    // The page still renders. Throwing here made one damaged file answer every request with
    // 400 — no state, no explanation, and no button, while both operations that could have
    // cleared it began by reading it.
    const state = await call('/manager/state')
    assert.equal(state.status, 200, JSON.stringify(state.body))
    assert.equal(state.body.device.state, 'unreadable')
    assert.match(state.body.device.teaching, /cannot be read/)
    assert.match(state.body.device.teaching, /Nothing was changed/)
    assert.match(state.body.device.teaching, new RegExp(file.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')))
    assert.match(state.body.device.teaching, /revoked in Console/,
      'the credential that would have revoked this device is the thing that could not be read, and that has to be said')
    assert.equal(state.body.instances.length, 1)
    assert.match(state.body.instances[0].blocked, /cannot be read/)
    assert.equal(readFileSync(file, 'utf8'), damaged, 'a damaged device record must never be repaired by overwriting it')

    // Nothing runs under a grant that cannot be read.
    await assert.rejects(manager.instances.start(instance.id), /cannot be read/)
    // Signing in over it is refused too: that would abandon a grant that may still be live.
    const over = await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Test computer' })
    assert.equal(over.status, 400)

    // Clearing it works, and says what it could not do.
    const cleared = await call('/manager/device/forget', {})
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.equal(cleared.body.device.state, 'none')
    assert.equal(cleared.body.revoke, 'unreadable')
    assert.match(cleared.body.teaching, /could not be read/)
    assert.equal(existsSync(file), false)
    assert.equal(gateway.revocationRecord(deviceId).state, 'approved', 'nothing was revoked, and nothing claimed to be')
    // And the credentials that grant issued are gone from the instance.
    assert.equal(JSON.parse(readFileSync(join(directory, 'local.json'), 'utf8')).agent.env.RULITH_TOKEN, '')
    assert.equal((await call('/manager/device/start', { consoleUrl: gateway.origin, name: 'Test computer' })).status, 200)
  })
})

test('concurrent device writes keep every instance entry and refuse a backwards step', async (t) => {
  await withManager(t, async ({ gateway, call, manager, root }) => {
    await signIn(gateway, call, ['agent-alpha', 'agent-beta'])
    // Two attachments finishing at once: both record what their pairing produced, and the
    // loser of a read-modify-write used to take its instance's entry with it.
    const first = await manager.instances.create({ name: 'A', mode: 'local_agent' })
    const second = await manager.instances.create({ name: 'B', mode: 'local_agent' })
    await Promise.all([
      manager.device.recordPairing(first.id, { pairingId: 'p1', agentId: 'agent-alpha', origin: 'x', accountId: 'acct-1' }),
      manager.device.recordPairing(second.id, { pairingId: 'p2', agentId: 'agent-beta', origin: 'x', accountId: 'acct-1' }),
    ])
    const stored = JSON.parse(readFileSync(join(root, 'device.json'), 'utf8'))
    assert.deepEqual(Object.keys(stored.instances).sort(), [first.id, second.id].sort(),
      'a concurrent write dropped an instance entry')
    assert.equal(stored.state, 'linked')

    // A refresh and a pairing record overlapping: the refresh's own snapshot predates the
    // network call it was waiting on, so the naive version wrote back a record without the
    // entry the other one had just added — and, worse, without whatever state had moved on.
    const third = await manager.instances.create({ name: 'C', mode: 'local_agent' })
    await Promise.all([
      manager.device.refresh(),
      manager.device.recordPairing(third.id, { pairingId: 'p3', agentId: 'agent-alpha', origin: 'x', accountId: 'acct-1' }),
    ])
    const after = JSON.parse(readFileSync(join(root, 'device.json'), 'utf8'))
    assert.deepEqual(Object.keys(after.instances).sort(), [first.id, second.id, third.id].sort(),
      'a write whose snapshot predated a network call dropped a concurrent entry')
    assert.equal(after.state, 'linked', 'no write may move this record backwards')
    assert.ok(after.refreshedAt, 'and the refresh still took effect')
  })
})

// ── The manager's own loopback gate ──────────────────────────────────────────

/** Raw request, so a hostile `Host` header can be sent; fetch forbids overriding it. */
function rawGet(port, path, headers = {}) {
  return new Promise((done, fail) => {
    const lines = [`GET ${path} HTTP/1.1`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), 'Connection: close', '', '']
    const socket = new Socket()
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { raw += chunk })
    socket.on('error', fail)
    socket.on('close', () => {
      const [head, ...rest] = raw.split('\r\n\r\n')
      done({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0), head, body: rest.join('\r\n\r\n') })
    })
    socket.connect(port, '127.0.0.1', () => socket.end(lines.join('\r\n')))
  })
}

test('the manager page and its routes are gated exactly like an instance host', async (t) => {
  await withManager(t, async ({ manager, call }) => {
    const port = manager.port
    const unauthenticated = await rawGet(port, '/', { Host: `127.0.0.1:${port}` })
    assert.equal(unauthenticated.status, 401)
    assert.doesNotMatch(unauthenticated.body, /<!DOCTYPE html>/i, 'the manager page was served to an unauthenticated caller')
    assert.doesNotMatch(unauthenticated.body, new RegExp(KEY))

    const rebound = await rawGet(port, `/?k=${KEY}`, { Host: 'rulith-manager.attacker.example' })
    assert.equal(rebound.status, 403)
    assert.match(rebound.body, /Non-local Host rejected/)

    const crossOrigin = await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}`, Origin: 'https://attacker.example' })
    assert.equal(crossOrigin.status, 403)

    const page = await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}` })
    assert.equal(page.status, 200, page.head)
    assert.match(page.head, /cache-control: no-store/i)
    assert.match(page.body, /<title>Rulith<\/title>/)
    assert.doesNotMatch(page.body, new RegExp(KEY), 'the page must read its key from its address, not carry one')

    // A loopback origin that is not this exact origin is still refused for state changes.
    const other = await call('/manager/instances/create', { name: 'x' }, { origin: 'http://127.0.0.1:1' })
    assert.equal(other.status, 403)
    assert.match(other.body.teaching, /same origin/)

    // Unexpected fields are refused rather than ignored.
    const extra = await call('/manager/device/start', { consoleUrl: 'https://console.rulith.ai', name: 'x', token: 'sneaky' })
    assert.equal(extra.status, 400)
    assert.match(extra.body.teaching, /Unexpected fields: token/)
  })
})
