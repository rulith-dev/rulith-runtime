// SPDX-License-Identifier: Apache-2.0
/**
 * The two ways a registry loses instances, reproduced and then refused.
 *
 * Both were real behaviours of the first implementation, not hypotheses:
 *
 *   · **A live holder's lock was stolen.** The lock was treated as abandoned once it was
 *     thirty seconds old, and an unreadable lock — which is what a lock looks like for the
 *     microsecond between being created and being written — was treated as proof that its
 *     owner had died. Two managers then read-modify-wrote one file.
 *   · **Corruption was normalized into loss.** A parse error answered with an empty registry
 *     and a malformed record was silently dropped, so one bad byte turned into "this computer
 *     has no instances", and the next write made that true.
 *
 * The lock arms use a real second process, because a lock that is only ever contended inside
 * one process is not a lock that has been tested.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createManagerRegistry, RegistryLockedError, RegistryUnreadableError, validateRegistry, processAlive } from '../local/manager-registry.mjs'

const HOLDER = resolve(import.meta.dirname, 'support', 'registry-lock-holder.mjs')
const instance = (id, directory, extra = {}) => ({ id, name: id, directory, mode: 'local_agent', ...extra })

function withRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'rulith-registry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** Start the holder and resolve once it says the lock exists. */
function holdLock(t, lockFile, shape) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOLDER, lockFile, shape], { stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => child.kill())
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('held')) done(child) })
    child.on('exit', (code) => fail(new Error(`the lock holder exited with ${code}`)))
  })
}

test('a lock held by a living process is never taken, however old it looks', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root, lockWaitMs: 500 })
  await registry.update((state) => { state.instances.push(instance('inst-000000000001', join(root, 'a'))); return state })
  const before = readFileSync(registry.file, 'utf8')

  // Ten minutes old, and its owner is running. The previous rule deleted it after thirty
  // seconds; a slow install or a paused machine is exactly that shape.
  const holder = await holdLock(t, registry.lockFile, 'stale')
  const held = JSON.parse(readFileSync(registry.lockFile, 'utf8'))
  assert.equal(held.pid, holder.pid)
  assert.equal(processAlive(held.pid), true)
  assert.ok(Date.now() - held.at > 60_000, 'the lock is old enough that an age rule would have taken it')

  const refused = await registry.update((state) => { state.instances.push(instance('inst-000000000002', join(root, 'b'))); return state })
    .then(() => undefined, (error) => error)
  assert.ok(refused instanceof RegistryLockedError, String(refused))
  assert.match(refused.message, /Nothing was changed/)
  assert.match(refused.message, new RegExp(String(holder.pid)))
  assert.equal(readFileSync(registry.file, 'utf8'), before, 'a refused edit must not have written anything')
  assert.equal(existsSync(registry.lockFile), true, 'the other process still holds its lock')
  assert.equal(JSON.parse(readFileSync(registry.lockFile, 'utf8')).pid, holder.pid, 'the live holder\'s lock was replaced')
})

test('a lock whose owner has not been written yet is ambiguous, not dead', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root, lockWaitMs: 400 })
  await registry.update((state) => state)
  const before = readFileSync(registry.file, 'utf8')

  await holdLock(t, registry.lockFile, 'empty')
  assert.equal(readFileSync(registry.lockFile, 'utf8'), '', 'the lock exists and says nothing about its owner')

  const refused = await registry.update((state) => { state.instances.push(instance('inst-000000000003', join(root, 'c'))); return state })
    .then(() => undefined, (error) => error)
  assert.ok(refused instanceof RegistryLockedError, String(refused))
  assert.match(refused.message, /has not been recorded yet/)
  assert.equal(readFileSync(registry.file, 'utf8'), before)
  assert.equal(existsSync(registry.lockFile), true, 'an unreadable lock was deleted on the assumption its owner had died')
})

test('a lock whose owner is proven gone is reclaimed, and the edit proceeds', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root, lockWaitMs: 4000 })
  const holder = await holdLock(t, registry.lockFile, 'stale')
  holder.kill()
  await new Promise((done) => holder.once('exit', done))
  assert.equal(processAlive(holder.pid), false)

  const next = await registry.update((state) => { state.instances.push(instance('inst-000000000004', join(root, 'd'))); return state })
  assert.deepEqual(next.instances.map((row) => row.id), ['inst-000000000004'])
  assert.equal(existsSync(registry.lockFile), false, 'the lock is released when the edit finishes')
})

test('a lock recorded on another machine is waited on rather than judged by a local pid', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root, lockWaitMs: 300 })
  await registry.update((state) => state)
  // A pid that is certainly not running here, but recorded against a different host: on that
  // machine it may be very much alive, and this one cannot tell.
  writeFileSync(registry.lockFile, JSON.stringify({ pid: 999_999, host: hostname() + '-elsewhere', id: 'foreign', at: Date.now() }))
  const refused = await registry.update((state) => state).then(() => undefined, (error) => error)
  assert.ok(refused instanceof RegistryLockedError, String(refused))
  assert.match(refused.message, /on .*-elsewhere/)
  assert.equal(existsSync(registry.lockFile), true)
})

test('a lock whose file cannot be read is not mistaken for no lock, and does not poison later edits', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root, lockWaitMs: 300 })
  await registry.update((state) => { state.instances.push(instance('inst-00000000000e', join(root, 'e'))); return state })
  const before = readFileSync(registry.file, 'utf8')

  // A lock path that exists and cannot be read as a file. This stands for the transient
  // read failures — a scanner or an indexer holding the file — that used to be collapsed
  // into "there is no lock"; after this process created its own with `wx`, that reading said
  // somebody had taken it, so it looped, left the lock behind, and then waited out the whole
  // window on a lock owned by a living pid: itself. Every later edit did the same.
  mkdirSync(registry.lockFile, { recursive: true })
  const refused = await registry.update((state) => state).then(() => undefined, (error) => error)
  assert.ok(refused instanceof RegistryLockedError, String(refused))
  assert.match(refused.message, /could not be read/)
  assert.equal(readFileSync(registry.file, 'utf8'), before)

  // Once the obstruction is gone, ordinary edits work again — the process did not wedge.
  rmSync(registry.lockFile, { recursive: true, force: true })
  const next = await registry.update((state) => { state.instances.push(instance('inst-00000000000f', join(root, 'f'))); return state })
  assert.equal(next.instances.length, 2)
  assert.equal(existsSync(registry.lockFile), false)
})

test('an edit that loses its lock mid-flight writes nothing and leaves the new holder alone', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root, lockWaitMs: 300 })
  await registry.update((state) => { state.instances.push(instance('inst-000000000005', join(root, 'e'))); return state })
  const before = readFileSync(registry.file, 'utf8')

  const foreign = JSON.stringify({ pid: process.pid, host: hostname(), id: 'somebody-else', at: Date.now() })
  const refused = await registry.update((state) => {
    // Somebody reclaimed and re-took the lock while this edit was being computed.
    writeFileSync(registry.lockFile, foreign)
    state.instances.push(instance('inst-000000000006', join(root, 'f')))
    return state
  }).then(() => undefined, (error) => error)

  assert.ok(refused instanceof RegistryLockedError, String(refused))
  assert.match(refused.message, /lost the registry lock/)
  assert.equal(readFileSync(registry.file, 'utf8'), before, 'a writer that no longer held the lock wrote anyway')
  assert.equal(readFileSync(registry.lockFile, 'utf8'), foreign, 'releasing unlinked a lock belonging to somebody else')
})

// ── Corruption is reported, never absorbed ───────────────────────────────────

test('a registry that cannot be parsed is an error with the path in it, and is left alone', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root })
  await registry.update((state) => { state.instances.push(instance('inst-000000000007', join(root, 'g'))); return state })
  const damaged = readFileSync(registry.file, 'utf8').slice(0, 40)
  writeFileSync(registry.file, damaged)

  assert.throws(() => registry.read(), RegistryUnreadableError)
  assert.throws(() => registry.read(), /invalid JSON/)
  assert.throws(() => registry.read(), new RegExp(registry.file.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')))
  await assert.rejects(registry.update((state) => state), RegistryUnreadableError)
  assert.equal(readFileSync(registry.file, 'utf8'), damaged,
    'a damaged registry was overwritten with a fresh one, taking every profile with it')
  assert.equal(existsSync(registry.lockFile), false, 'the lock is released even when the read fails')
})

test('a record that cannot be addressed is refused by name, never dropped', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root })
  const good = instance('inst-0000000000aa', join(root, 'keep'))
  for (const [label, rows, pattern] of [
    ['no id', [good, { name: 'nameless', directory: join(root, 'x') }], /no usable instance id/],
    ['a malformed id', [good, instance('laptop', join(root, 'x'))], /no usable instance id/],
    ['a duplicate id', [good, instance('inst-0000000000aa', join(root, 'x'))], /repeats instance id/],
    ['a duplicate directory', [good, instance('inst-0000000000bb', join(root, 'keep'))], /shares a directory/],
    ['no directory', [good, { id: 'inst-0000000000cc', name: 'n', directory: '' }], /has no directory/],
  ]) {
    const raw = JSON.stringify({ format: 'rulith-local-manager/1', instances: rows })
    writeFileSync(registry.file, raw)
    assert.throws(() => registry.read(), pattern, label)
    await assert.rejects(registry.update((state) => state), RegistryUnreadableError, label)
    assert.equal(readFileSync(registry.file, 'utf8'), raw, `${label}: the file was rewritten`)
  }

  // Calibration: the same shape without the defect is accepted and keeps every field.
  writeFileSync(registry.file, JSON.stringify({ format: 'rulith-local-manager/1',
    instances: [{ ...good, agentId: 'agent-alpha', unknownFutureField: 42 }] }))
  const read = registry.read()
  assert.equal(read.instances.length, 1)
  assert.equal(read.instances[0].agentId, 'agent-alpha')
  assert.equal(read.instances[0].unknownFutureField, 42, 'a field this version does not know is not a reason to discard a record')
})

test('a foreign format is refused rather than reinterpreted', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root })
  writeFileSync(registry.file, JSON.stringify({ format: 'something-else/9', instances: [] }))
  assert.throws(() => registry.read(), /is not rulith-local-manager\/1/)
  assert.throws(() => validateRegistry([], 'x'), /not a JSON object/)
  assert.throws(() => validateRegistry({ instances: {} }, 'x'), /"instances" is not an array/)
})

test('a missing registry is not corruption, and concurrent edits still keep every record', async (t) => {
  const root = withRoot(t)
  const registry = createManagerRegistry({ root })
  assert.deepEqual(registry.read().instances, [], 'a first run has no registry and no problem')

  await Promise.all(Array.from({ length: 20 }, (_unused, index) => registry.update((state) => {
    state.instances.push(instance('inst-' + String(index).padStart(12, '0'), join(root, 'i' + index)))
    return state
  })))
  assert.equal(registry.read().instances.length, 20)

  await assert.rejects(registry.update(() => { throw new Error('refused') }))
  await registry.update((state) => { state.instances.push(instance('inst-aaaaaaaaaaaa', join(root, 'after'))); return state })
  assert.equal(registry.read().instances.length, 21, 'one failed edit wedged the ones behind it')
  assert.equal(existsSync(registry.lockFile), false)
})
