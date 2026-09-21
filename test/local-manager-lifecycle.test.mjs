// SPDX-License-Identifier: Apache-2.0
/**
 * Two things the per-instance lock cannot express, and the races that proved it.
 *
 *   · **One workbench per installation.** Opening an instance is read `runtime`, build a host,
 *     listen, record the pid — several awaits long — and the registry's per-edit lock only
 *     serializes the writes inside that. Two managers on one root both saw no owner, both
 *     listened, and each wrote its pid over the other's; they also shared one `device.json`,
 *     where interleaved read-modify-write loses account state neither process can see.
 *   · **A drain that is actually a drain.** `signOut` and `closeAll` snapshotted the instances
 *     and then awaited stops and a network revoke. A `start`, `pair`, `open` or `create`
 *     arriving in that window slipped past the snapshot, so the manager could answer
 *     `signed_out` with a child it had just started still alive and owned.
 *
 * The workbench arms use real separate processes, because a claim that is only ever contended
 * inside one process is not a claim that has been tested.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createManagerServer } from '../local/manager-server.mjs'
import { acquireWorkbenchLease, processAlive, WorkbenchBusyError } from '../local/manager-registry.mjs'
import { loadInstanceConfig, saveInstanceConfig } from '../local/instance-manager.mjs'
import { createDevicesGateway } from './support/local-devices-gateway.mjs'

const HOLDER = resolve(import.meta.dirname, 'support', 'workbench-holder.mjs')
const ECHO = resolve(import.meta.dirname, 'support', 'echo-role.mjs')
const KEY = 'manager-lifecycle-key'
const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex')

/** Start the holder process and read its one JSON line. */
function holdWorkbench(t, root, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOLDER], {
      env: { ...process.env, WORKBENCH_ROOT: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => child.kill())
    let out = ''
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    child.stdout.on('data', (chunk) => {
      out += chunk
      const line = out.trim().split('\n').pop()
      if (line.endsWith('}')) done({ child, ...JSON.parse(line) })
    })
    child.on('exit', (code) => { if (out.trim() === '') fail(new Error(`the holder exited with ${code}: ${err}`)) })
  })
}

async function withManager(t, run, { signIn = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rulith-lifecycle-'))
  const gateway = createDevicesGateway()
  await gateway.listen()
  const manager = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json'), startConfirmMs: 8000 })
  await manager.listen()
  t.after(async () => {
    await manager.close().catch(() => undefined)
    await gateway.close()
    rmSync(root, { recursive: true, force: true })
  })
  if (signIn) {
    const started = await manager.device.start({ consoleUrl: gateway.origin, name: 'Test computer' })
    gateway.approve(started.code, ['agent-alpha', 'agent-beta'])
    await manager.device.poll()
  }
  await run({ manager, root, gateway })
}

/** An attached instance whose roles are the reporting stand-in, optionally slow to stop. */
async function addInstance(manager, name, { agentId, stopDelayMs = 0 } = {}) {
  const created = await manager.instances.create({ name, mode: 'local_agent' })
  await manager.instances.pair(created.id, { agentId })
  await manager.instances.closeHost(created.id)
  const config = loadInstanceConfig(created.directory)
  config.paths = { agent: ECHO, worker: ECHO }
  const extra = stopDelayMs > 0 ? { RULITH_TEST_STOP_DELAY_MS: String(stopDelayMs) } : {}
  config.agent.env = { ...config.agent.env, RULITH_TEST_IDENTITY: agentId, ...extra }
  config.worker.env = { ...config.worker.env, RULITH_TEST_IDENTITY: agentId, ...extra }
  saveInstanceConfig(created.directory, config)
  return created
}

// ── One workbench per installation ───────────────────────────────────────────

test('a second workbench on one installation refuses, and says what to do', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-claim-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const first = await holdWorkbench(t, root)
  assert.equal(first.held, true, JSON.stringify(first))
  assert.ok(first.port > 0)
  assert.equal(existsSync(join(root, 'workbench.lock')), true)

  // A real second `rulith` against the same installation. It must not get its own web host,
  // and it must not start sharing one `device.json`.
  const second = await holdWorkbench(t, root, { WORKBENCH_KEY: 'second-key-0123456789' })
  assert.equal(second.held, false, 'a second workbench opened its own host on one installation')
  assert.equal(second.name, 'WorkbenchBusyError')
  assert.match(second.teaching, /already running on this installation/)
  assert.match(second.teaching, new RegExp(String(first.pid)))
  assert.match(second.teaching, /RULITH_MANAGER_HOME/, 'the way to run a second one is named')
  assert.match(second.teaching, /write over each other's account state/)

  // The first is untouched: its claim, and its host, are still there.
  assert.equal(JSON.parse(readFileSync(join(root, 'workbench.lock'), 'utf8')).pid, first.pid)
  assert.equal((await fetch(`http://127.0.0.1:${first.port}/manager/state?k=holder-key-0123456789`)).status, 200)
})

test('a claim whose owner is gone is recovered; a living owner is never stolen, however old', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-claim-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lockFile = join(root, 'workbench.lock')

  // Ten minutes old, owner alive. An expiry rule — the thing this deliberately does not have —
  // would take it here.
  const alive = await holdWorkbench(t, root, { MODE: 'lock' })
  assert.ok(Date.now() - JSON.parse(readFileSync(lockFile, 'utf8')).at > 60_000)
  const refused = await acquireWorkbenchLease(lockFile).then(() => undefined, (error) => error)
  assert.ok(refused instanceof WorkbenchBusyError, String(refused))
  assert.match(refused.message, new RegExp(`running process ${alive.pid}`))
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, alive.pid, 'a live owner\'s claim was replaced')

  // The owner dies. Only then is it recoverable, and the recovery is by proof, not by age.
  alive.child.kill()
  await new Promise((done) => alive.child.once('exit', done))
  assert.equal(processAlive(alive.pid), false)
  const lease = await acquireWorkbenchLease(lockFile)
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid)

  // Release unlinks only a claim that is still ours.
  lease.release()
  assert.equal(existsSync(lockFile), false)
})

test('building a manager claims nothing; listening claims, closing releases', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-claim-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lockFile = join(root, 'workbench.lock')

  // Several managers can be constructed in one process — the tests in this repository do
  // exactly that — and none of them has taken the installation.
  const a = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
  const b = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
  assert.equal(existsSync(lockFile), false)

  await a.listen()
  assert.equal(existsSync(lockFile), true)
  await assert.rejects(b.listen(), WorkbenchBusyError, 'two listening workbenches on one root')
  assert.equal(b.instances.hosts.size, 0)

  await a.close()
  assert.equal(existsSync(lockFile), false, 'closing hands the installation back')
  await b.listen()
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid)
  await b.close()
})

// ── The drain admits nothing new ─────────────────────────────────────────────

test('a reopened host has a new public generation independent of its browser credential', async (t) => {
  await withManager(t, async ({ manager }) => {
    const instance = await addInstance(manager, 'Reopened', { agentId: 'agent-alpha' })
    const first = await manager.instances.open(instance.id)
    await manager.instances.closeHost(instance.id)
    const second = await manager.instances.open(instance.id)
    assert.ok(first.hostGeneration)
    assert.notEqual(first.hostGeneration, second.hostGeneration)
    assert.equal(manager.instances.overview().find(row => row.id === instance.id).hostGeneration, second.hostGeneration)
    assert.notEqual(second.hostGeneration, new URL(second.url).searchParams.get('k'))
  })
})

test('a start held across sign-out finishes first, and is then stopped before anything is revoked', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    // Slow to stop, so "did the sign-out wait for it" has an observable answer.
    const instance = await addInstance(manager, 'Slow', { agentId: 'agent-alpha', stopDelayMs: 600 })

    // The start is admitted; the sign-out arrives while it is still running.
    const starting = manager.instances.start(instance.id)
    await new Promise((done) => setTimeout(done, 30))
    const out = manager.instances.signOut()

    const started = await starting
    assert.equal(started.started, true, JSON.stringify(started.results))
    const result = await out

    // Either the sign-out waited and stopped it, or it refused — never "signed out" with the
    // child alive. The drain waits, so this is the first.
    assert.equal(result.state, 'signed_out', JSON.stringify(result))
    const revoked = gateway.requests.filter((row) => row.path === '/local-devices/revoke')
    assert.equal(revoked.length, 1)
    for (const child of started.results) assert.equal(child.ok, true)
    const row = manager.registry.instance(instance.id)
    assert.equal(row.runtime, undefined, 'nothing owned survives a completed sign-out')
    assert.equal(manager.instances.hosts.size, 0)
    assert.equal(manager.device.status().state, 'none')
  })
})

test('nothing new is admitted while signing out, and the workbench is usable again afterwards', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await addInstance(manager, 'Draining', { agentId: 'agent-alpha', stopDelayMs: 600 })
    await manager.instances.start(instance.id)

    const out = manager.instances.signOut()
    await new Promise((done) => setTimeout(done, 30))
    // Everything that would create work or change configuration is refused by name.
    for (const [what, attempt] of [
      ['second sign-out', () => manager.instances.signOut()],
      ['clear device', () => manager.instances.forgetDevice()],
      ['create', () => manager.instances.create({ name: 'New', mode: 'local_agent' })],
      ['open', () => manager.instances.open(instance.id)],
      ['start', () => manager.instances.start(instance.id)],
      ['scoped start', () => manager.instances.control(instance.id, { role: 'agent', operation: 'start' })],
      ['pair', () => manager.instances.pair(instance.id, { agentId: 'agent-beta' })],
      ['model copy', () => manager.instances.copyModelSettings(instance.id, instance.id)],
      ['device sign-in', () => manager.device.start({ consoleUrl: gateway.origin, name: 'x' })],
    ]) {
      const refused = await Promise.resolve().then(attempt).then(() => undefined, (error) => error)
      assert.ok(refused instanceof Error, `${what} was admitted during a sign-out`)
      if (what !== 'device sign-in') assert.match(refused.message, /signing out of its account/, what)
    }

    assert.equal((await out).state, 'signed_out')
    // Ready again: an account can be signed into, and instances used, straight afterwards.
    assert.equal(manager.instances.phase, 'ready')
    const again = await manager.instances.create({ name: 'After', mode: 'local_agent' })
    assert.ok(again.id)
  })
})

test('an incomplete sign-out leaves the workbench ready, not wedged', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await addInstance(manager, 'Stubborn', { agentId: 'agent-alpha', stopDelayMs: 9000 })
    await manager.instances.start(instance.id)
    await manager.instances.control(instance.id, { role: 'agent', operation: 'stop' }).catch(() => undefined)

    // A child that will not have exited inside the observation window: the sign-out reports
    // incomplete rather than revoking.
    const result = await manager.instances.signOut()
    assert.equal(result.state, 'incomplete')
    assert.equal(gateway.requests.some((row) => row.path === '/local-devices/revoke'), false)
    assert.equal(manager.device.status().state, 'linked')

    // And the manager still works. A phase that stuck here would make an installation
    // unusable for the sake of a sign-out that did not happen.
    assert.equal(manager.instances.phase, 'ready')
    assert.ok((await manager.instances.create({ name: 'Still usable', mode: 'local_agent' })).id)

    const workerPid = manager.registry.instance(instance.id).runtime.children[0]?.pid
    const deadline = Date.now() + 15_000
    while (workerPid !== undefined && processAlive(workerPid) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100))
    }
  })
})

test('an open in flight when the workbench closes leaves no listener behind', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-closing-'))
  const gateway = createDevicesGateway()
  await gateway.listen()
  const manager = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
  await manager.listen()
  t.after(async () => {
    await manager.close().catch(() => undefined)
    await gateway.close()
    rmSync(root, { recursive: true, force: true })
  })
  const started = await manager.device.start({ consoleUrl: gateway.origin, name: 'Test computer' })
  gateway.approve(started.code, ['agent-alpha'])
  await manager.device.poll()
  const instance = await addInstance(manager, 'Opening', { agentId: 'agent-alpha' })

  // `closeAll` used to snapshot `hosts`, so a host still being created was not in the snapshot
  // — and then outlived the manager, listening, with nothing tracking it.
  const opening = manager.instances.open(instance.id)
  const closing = manager.close()
  const opened = await opening.then((value) => value, () => undefined)
  await closing

  assert.equal(manager.instances.hosts.size, 0)
  if (opened !== undefined) {
    // It was admitted, so the close waited for it and then closed it.
    const reachable = await fetch(opened.url).then(() => true, () => false)
    assert.equal(reachable, false, `a host created during shutdown is still listening at ${opened.url}`)
  }
  assert.equal(manager.registry.instance(instance.id).runtime, undefined)
  assert.equal(existsSync(join(root, 'workbench.lock')), false)
})

test('a closed workbench stays closed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-closed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = createManagerServer({ root, port: 0, key: KEY, legacyConfigFile: join(root, 'absent.json') })
  await manager.listen()
  await manager.close()

  for (const attempt of [
    () => manager.instances.create({ name: 'After close', mode: 'local_agent' }),
    () => manager.instances.signOut(),
    () => manager.instances.forgetDevice(),
  ]) {
    const refused = await Promise.resolve().then(attempt).then(() => undefined, (error) => error)
    assert.ok(refused instanceof Error)
    assert.match(refused.message, /shutting down/)
  }
  assert.equal(manager.instances.phase, 'closing')
})

// ── An expired code is not an expired approval ───────────────────────────────

for (const operation of ['signOut', 'forgetDevice']) {
  for (const owner of ['dead', 'current']) {
    test(`${operation} preserves credentials until a surviving child of the ${owner} host exits`, async (t) => {
      await withManager(t, async ({ manager, gateway, root }) => {
        const instance = await addInstance(manager, 'Survivor', { agentId: 'agent-alpha' })
        const before = loadInstanceConfig(instance.directory).worker.env.RULITH_CONNECTION_KEY
        assert.ok(before)
        if (operation === 'forgetDevice') {
          gateway.expireDevice(manager.device.status().deviceId)
          await manager.device.refresh().catch(() => undefined)
          assert.equal(manager.device.status().state, 'unusable')
        }
        const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        t.after(() => survivor.kill())
        await new Promise((done, fail) => { survivor.once('spawn', done); survivor.once('error', fail) })
        assert.equal(processAlive(999_999), false)
        await manager.registry.patchInstance(instance.id, () => ({
          runtime: { pid: owner === 'dead' ? 999_999 : process.pid,
            children: [{ role: 'worker', pid: survivor.pid }], unobservedAt: new Date().toISOString() },
        }))
        await manager.registry.reclaimStale()
        if (owner === 'dead') assert.ok(manager.registry.instance(instance.id).orphaned)
        const result = await manager.instances[operation]()
        assert.equal(result.state, 'incomplete', JSON.stringify(result))
        assert.equal(result.step, 'stop')
        assert.match(result.running[0].results[0].teaching, new RegExp(String(survivor.pid)))
        assert.equal(gateway.requests.filter(row => row.path === '/local-devices/revoke').length, 0)
        assert.equal(loadInstanceConfig(instance.directory).worker.env.RULITH_CONNECTION_KEY, before)
        assert.equal(existsSync(join(root, 'device.json')), true)
        const exited = new Promise(done => survivor.once('exit', done))
        survivor.kill()
        await exited
        // No explicit reclaim: stale orphan metadata must not permanently wedge sign-out.
        const finished = await manager.instances[operation]()
        assert.equal(finished.state, operation === 'signOut' ? 'signed_out' : 'none', JSON.stringify(finished))
        assert.equal(gateway.requests.filter(row => row.path === '/local-devices/revoke').length, 1)
        assert.equal(loadInstanceConfig(instance.directory).worker.env.RULITH_CONNECTION_KEY, '')
      })
    })
  }
  test(`${operation} rechecks surviving children recorded while another host stops`, async (t) => {
    await withManager(t, async ({ manager, gateway }) => {
      const first = await addInstance(manager, 'Earlier', { agentId: 'agent-alpha' })
      const second = await addInstance(manager, 'Later', { agentId: 'agent-beta' })
      await manager.instances.open(second.id)
      if (operation === 'forgetDevice') {
        gateway.expireDevice(manager.device.status().deviceId)
        await manager.device.refresh().catch(() => undefined)
      }
      const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      t.after(() => survivor.kill())
      await new Promise((done, fail) => { survivor.once('spawn', done); survivor.once('error', fail) })
      const stop = manager.instances.stop
      manager.instances.stop = async (id) => {
        const result = await stop(id)
        // This is the marker closeAll records when a child outlives its host; it arrives
        // after the earlier row was inspected, while sign-out awaits the later host.
        await manager.registry.patchInstance(first.id, () => ({ runtime: {
          pid: process.pid, children: [{ role: 'worker', pid: survivor.pid }], unobservedAt: new Date().toISOString(),
        } }))
        return result
      }
      const result = await manager.instances[operation]()
      assert.equal(result.state, 'incomplete')
      assert.equal(result.step, 'stop')
      assert.equal(result.running[0].id, first.id)
      assert.equal(gateway.requests.filter(row => row.path === '/local-devices/revoke').length, 0)
      assert.ok(loadInstanceConfig(first.directory).worker.env.RULITH_CONNECTION_KEY)
      const exited = new Promise(done => survivor.once('exit', done))
      survivor.kill()
      await exited
    })
  })
}

test('retrying an attachment after its code expires does not throw away the proof of an unknown approval', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Lost receipt', mode: 'local_agent' })

    // The service approves and the answer is lost. Nothing local records the approval — which
    // is exactly why the local record cannot be read as "it did not happen".
    gateway.dropResponseAfterEffect('/local-devices/pair')
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch(() => undefined)
    const pairingId = [...gateway.pairings.keys()][0]
    const proof = gateway.requests.find((row) => row.path === '/local-setup/start').body.deviceDigest
    assert.equal(gateway.pairings.get(pairingId).state, 'approved', 'the service did approve it')
    assert.equal(manager.registry.instance(instance.id).pairing.approvedAt, undefined, 'and this computer never heard')

    // The code expires, and the operator retries. Regenerating here would mint a new proof and
    // leave that issued credential unreachable and uncancelled.
    const setupFile = join(manager.registry.instance(instance.id).directory, 'local.json.setup.json')
    const expired = JSON.parse(readFileSync(setupFile, 'utf8'))
    expired.expiresAt = new Date(Date.now() - 1000).toISOString()
    writeFileSync(setupFile, JSON.stringify(expired, null, 2))

    const retried = await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch((error) => error)
    assert.ok(retried instanceof Error)
    assert.match(retried.message, /already approved/, 'the authority is asked, and it says a credential exists')
    assert.equal([...gateway.pairings.keys()].length, 1, 'no second pairing was minted')
    assert.equal(gateway.requests.filter((row) => row.path === '/local-setup/start').length, 1)

    // The original proof is still on disk, so collecting the credential still works.
    const kept = JSON.parse(readFileSync(setupFile, 'utf8'))
    assert.equal(kept.requestId, pairingId)
    assert.equal(sha256Hex(kept.deviceSecret), proof, 'the proof that names that credential was kept')
    const finished = await manager.instances.pairPoll(instance.id)
    assert.equal(finished.agentId, 'agent-alpha')
  })
})

test('a stale pairing whose cancellation is confirmed is replaced, and only then', async (t) => {
  await withManager(t, async ({ manager, gateway }) => {
    const instance = await manager.instances.create({ name: 'Stale code', mode: 'local_agent' })
    gateway.failNext('/local-devices/pair')
    await manager.instances.pair(instance.id, { agentId: 'agent-alpha' }).catch(() => undefined)
    const firstPairing = [...gateway.pairings.keys()][0]

    const setupFile = join(manager.registry.instance(instance.id).directory, 'local.json.setup.json')
    const expired = JSON.parse(readFileSync(setupFile, 'utf8'))
    expired.expiresAt = new Date(Date.now() - 1000).toISOString()
    writeFileSync(setupFile, JSON.stringify(expired, null, 2))

    const retried = await manager.instances.pair(instance.id, { agentId: 'agent-alpha' })
    assert.equal(retried.agentId, 'agent-alpha')
    // The old one was cancelled at the authority before a new proof existed.
    assert.equal(gateway.pairings.get(firstPairing).state, 'cancelled')
    assert.equal(gateway.requests.filter((row) => row.path === '/local-setup/cancel').length, 1)
    assert.equal(gateway.requests.find((row) => row.path === '/local-setup/cancel').body.pairingId, firstPairing)
    assert.notEqual(JSON.parse(readFileSync(setupFile, 'utf8')).requestId, firstPairing)
  })
})

test('instances of different Agents still run in parallel while the workbench is ready', async (t) => {
  await withManager(t, async ({ manager }) => {
    const first = await addInstance(manager, 'Alpha', { agentId: 'agent-alpha' })
    const second = await addInstance(manager, 'Beta', { agentId: 'agent-beta' })

    // The admission gate counts; it does not queue. Two Agents starting together must overlap,
    // or the fix for the drain has cost the product the thing it exists for.
    const began = Date.now()
    const [a, b] = await Promise.all([manager.instances.start(first.id), manager.instances.start(second.id)])
    assert.equal(a.started, true, JSON.stringify(a.results))
    assert.equal(b.started, true, JSON.stringify(b.results))

    const overlapping = [first, second].map((row) => manager.instances.hosts.get(row.id).host.children().length)
    assert.deepEqual(overlapping, [2, 2], 'both instances are running both roles at the same time')
    assert.ok(Date.now() - began < 30_000)
    assert.equal(manager.instances.phase, 'ready')
  })
})
