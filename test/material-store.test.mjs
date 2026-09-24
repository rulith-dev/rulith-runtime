// SPDX-License-Identifier: Apache-2.0
/**
 * The material area, exercised against a real directory on a real filesystem.
 *
 * Every arm here is about a way the stored bytes could stop being the bytes somebody added:
 * a chunk edited underneath the process, a chunk that has gone, a write that died half way,
 * a credential rotated so the owner binding no longer holds, a model destination changed
 * after the fact, a store written by a build that meant something else by the same files.
 * Each one has its own refusal, because "it did not work" and "it worked and gave you the
 * wrong document" are not the same failure and must not read the same.
 *
 * The positive arms are calibration: an assertion that a corrupt chunk is refused would also
 * pass against a store that refused everything.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MATERIAL_CHUNK_BYTES, MATERIAL_ID_PATTERN, MATERIAL_STORE_VERSION, MaterialError, decodeCanonicalBase64,
  defaultMaterialRoot, isLoopbackDestination, materialDisplayName, materialIdentity,
  materialAgentFingerprint, materialIdentityFromFingerprints, materialTextOf, normalizeModelDestination, openMaterialStore,
  trimToCodePoints,
} from '../worker/material-store.mjs'

const REMOTE_MODEL = 'https://api.anthropic.com/v1/messages'
const LOCAL_MODEL = 'http://127.0.0.1:1234'
const GATEWAY = 'https://api.rulith.ai'

function area(run, { connection = 'con-first', agent = 'ag_first', gateway = GATEWAY, modelUrl = REMOTE_MODEL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-materials-'))
  const configFile = join(dir, 'local.json')
  const root = defaultMaterialRoot(configFile)
  const identityFor = (options = {}) => materialIdentity({
    configFile,
    gatewayUrl: options.gateway ?? gateway,
    connectionId: options.connection ?? connection,
    agentId: options.agent ?? agent,
    modelUrl: options.modelUrl ?? modelUrl,
  })
  try {
    return run({ dir, configFile, root, identityFor, store: () => openMaterialStore(root, identityFor()) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const refusal = (fn) => {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MaterialError, `expected a MaterialError, received ${error}`)
    return error.code
  }
  return assert.fail('the call was expected to refuse and returned instead')
}

test('public selector is issued only on submission and survives restart with exact private custody', () => {
  area(({ root, identityFor, store }) => {
    const first = store()
    const record = first.put({ name: 'private.txt', mediaType: 'text/plain', bytes: Buffer.from('version one') })
    const second = first.put({ name: 'unused.txt', mediaType: 'text/plain', bytes: Buffer.from('not submitted') })
    const publicRow = first.publicMaterial(record)
    assert.match(publicRow.id, /^ui_[0-9a-f]{32}$/u)
    assert.notEqual(publicRow.id, record.selector)
    assert.notEqual(record.selector, record.id)
    assert.equal(refusal(() => first.resolveSubmitted(record.selector)), 'material_not_found')
    assert.equal(refusal(() => first.resolveSubmitted(second.selector)), 'material_not_found')
    assert.equal(refusal(() => first.resolveSubmitted(record.id)), 'material_not_found')
    assert.equal(refusal(() => first.resolveSubmitted(`mat_${'0'.repeat(32)}`)), 'material_not_found')
    assert.equal(first.submitSelected(publicRow.id, { sessionKey: 'case-a', caseId: 'case-a' }).id, record.selector)
    const reopened = openMaterialStore(root, identityFor(), { create: false })
    assert.equal(reopened.resolveSubmitted(record.selector).id, record.id)
    assert.equal(reopened.read(record.id, { modelDestination: REMOTE_MODEL }).bytes.toString(), 'version one')
    assert.equal(refusal(() => reopened.resolveSubmitted(second.selector)), 'material_not_found')
    const submitted = JSON.parse(readFileSync(join(root, 'objects', record.id, 'submission.json'), 'utf8'))
    assert.deepEqual(submitted.submissions, [{ sessionKey: 'case-a', caseId: 'case-a', requestId: '' }])
    assert.equal(submitted.custodyId, record.id)
    assert.equal(submitted.digest, record.digest)
  })
})

test('one click receipt survives restart and refuses a changed selection for the same request', () => {
  area(({ root, identityFor, store }) => {
    const first = store()
    const a = first.put({ name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('a') })
    const b = first.put({ name: 'b.txt', mediaType: 'text/plain', bytes: Buffer.from('b') })
    const context = { requestId: 'exact-request', sessionKey: 'untrusted-conversation', caseId: 'forged-case' }
    const initial = first.submitSelectedSet([a.uiHandle], context)
    assert.match(initial.receipt.submissionId, /^sub_[0-9a-f]{32}$/u)
    assert.match(initial.receipt.proofSecret, /^[0-9a-f]{64}$/u)
    assert.match(initial.receipt.selectionSecret, /^[0-9a-f]{64}$/u)
    assert.notEqual(initial.receipt.selectionSecret, initial.receipt.proofSecret)
    assert.equal(createHash('sha256').update(Buffer.from(initial.receipt.proofSecret, 'hex')).digest('hex').length, 64)
    assert.deepEqual(initial.receipt.attachments,
      [{ selector: a.selector, digest: a.digest, totalBytes: a.totalBytes }])
    assert.equal(initial.receipt.caseId, undefined)
    assert.equal(initial.receipt.sessionKey, 'untrusted-conversation')
    assert.equal(JSON.stringify(initial.receipt).includes(a.id), false)
    const reopened = openMaterialStore(root, identityFor(), { create: false })
    assert.deepEqual(reopened.submitSelectedSet([a.uiHandle], context).receipt,
      initial.receipt)
    assert.equal(refusal(() => reopened.submitSelectedSet([a.uiHandle],
      { requestId: 'exact-request', sessionKey: 'changed' })), 'material_submission_mismatch')
    assert.equal(refusal(() => reopened.submitSelectedSet([b.uiHandle], context)), 'material_submission_mismatch')
    assert.equal(refusal(() => reopened.submitSelectedSet([a.uiHandle, b.uiHandle], context)), 'material_submission_mismatch')
    assert.equal(refusal(() => reopened.resolveSubmitted(b.selector)), 'material_not_found')
    // Simulate interruption after the central receipt lands but before its object ledger.
    rmSync(join(root, 'objects', a.id, 'submission.json'))
    assert.equal(reopened.submitSelectedSet([a.uiHandle], context).receipt.submissionId,
      initial.receipt.submissionId)
    assert.equal(reopened.resolveSubmitted(a.selector).id, a.id)
    const separate = reopened.submitSelectedSet([b.uiHandle], { requestId: 'another-request', sessionKey: 'x' })
    assert.notEqual(separate.receipt.submissionId, initial.receipt.submissionId)
    assert.notEqual(separate.receipt.proofSecret, initial.receipt.proofSecret)
    assert.notEqual(separate.receipt.selectionSecret, initial.receipt.selectionSecret)
    assert.equal(readdirSync(join(root, 'submissions')).filter((name) => name.endsWith('.json')).length, 2)
  })
})

test('competing Host clicks elect one immutable receipt without a stranded global lock', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-receipt-contention-'))
  const configFile = join(dir, 'local.json')
  const root = defaultMaterialRoot(configFile)
  const identity = materialIdentity({ configFile, gatewayUrl: GATEWAY, connectionId: 'con-first',
    agentId: 'ag_first', modelUrl: REMOTE_MODEL })
  const store = openMaterialStore(root, identity)
  const a = store.put({ name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('a') })
  const b = store.put({ name: 'b.txt', mediaType: 'text/plain', bytes: Buffer.from('b') })
  const children = [a, b].map((record, number) => spawn(process.execPath,
    [join(import.meta.dirname, 'material-submission-child.mjs'), configFile, root, record.uiHandle,
      String(number), 'receipt'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
  try {
    await Promise.all(children.map(async (child) => (await once(child, 'message'))[0]))
    const results = children.map(async (child) => {
      const result = (await once(child, 'message'))[0]
      const [code] = await once(child, 'exit')
      assert.equal(code, 0)
      return result
    })
    for (const child of children) child.send({ go: true })
    const settled = await Promise.all(results)
    assert.equal(settled.filter((row) => row.done === true).length, 1)
    assert.equal(settled.filter((row) => /^material_submission_mismatch:/u.test(row.error ?? '')).length, 1)
    assert.equal(readdirSync(join(root, 'submissions')).filter((name) => name.endsWith('.json')).length, 1)
    assert.equal(existsSync(join(root, 'submissions', 'submission.lock')), false)
    const winner = settled.find((row) => row.done === true)
    const record = JSON.parse(readFileSync(join(root, 'submissions',
      readdirSync(join(root, 'submissions')).find((name) => name.endsWith('.json'))), 'utf8'))
    assert.equal(record.submissionId, winner.submissionId)
  } finally {
    for (const child of children) child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same request id in another Agent area gets an independent receipt', () => {
  let firstId
  area(({ store }) => {
    const current = store()
    const record = current.put({ name: 'same.txt', mediaType: 'text/plain', bytes: Buffer.from('same') })
    firstId = current.submitSelectedSet([record.uiHandle], { requestId: 'shared', sessionKey: 'x' }).receipt.submissionId
  }, { agent: 'ag_first' })
  area(({ store }) => {
    const current = store()
    const record = current.put({ name: 'same.txt', mediaType: 'text/plain', bytes: Buffer.from('same') })
    const receipt = current.submitSelectedSet([record.uiHandle], { requestId: 'shared', sessionKey: 'x' }).receipt
    assert.equal(receipt.agent, 'ag_second')
    assert.notEqual(receipt.submissionId, firstId)
  }, { agent: 'ag_second' })
})

test('separate Host processes retain every context submitted for one selector', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-material-contention-'))
  const configFile = join(dir, 'local.json')
  const root = defaultMaterialRoot(configFile)
  const identity = materialIdentity({ configFile, gatewayUrl: GATEWAY, connectionId: 'con-first',
    agentId: 'ag_first', modelUrl: REMOTE_MODEL })
  const store = openMaterialStore(root, identity)
  const record = store.put({ name: 'shared.txt', mediaType: 'text/plain', bytes: Buffer.from('private') })
  const children = []
  try {
    for (let number = 0; number < 12; number++) {
      const child = spawn(process.execPath,
        [join(import.meta.dirname, 'material-submission-child.mjs'), configFile, root, record.uiHandle, String(number)],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      children.push(child)
    }
    const ready = await Promise.all(children.map(async (child) => (await once(child, 'message'))[0]))
    assert.ok(ready.every((message) => message.ready === true))
    const results = children.map(async (child) => {
      const message = (await once(child, 'message'))[0]
      const [code] = await once(child, 'exit')
      assert.equal(code, 0)
      assert.deepEqual(message, { done: true })
    })
    for (const child of children) child.send({ go: true })
    await Promise.all(results)
    const submitted = JSON.parse(readFileSync(join(root, 'objects', record.id, 'submission.json'), 'utf8'))
    assert.deepEqual(submitted.submissions.map((row) => row.sessionKey).sort(),
      Array.from({ length: children.length }, (_, number) => `session-${number}`).sort())
    assert.equal(openMaterialStore(root, identity, { create: false }).resolveSubmitted(record.selector).id, record.id)
    assert.equal(existsSync(join(root, 'objects', record.id, 'submission.lock')), false)
  } finally {
    for (const child of children) child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('submitted selector refuses changed digest, Agent, Connection and stored bytes', () => {
  area(({ root, identityFor, store }) => {
    const first = store()
    const record = first.put({ name: 'version.txt', mediaType: 'text/plain', bytes: Buffer.from('original') })
    first.submitSelected(record.uiHandle, { sessionKey: 'case-a' })
    const file = join(root, 'objects', record.id, 'submission.json')
    const original = readFileSync(file, 'utf8')
    const mapping = JSON.parse(original)
    writeFileSync(file, JSON.stringify({ ...mapping, digest: 'sha256:' + '0'.repeat(64) }))
    assert.equal(refusal(() => store().resolveSubmitted(record.selector)), 'material_submission_mismatch')
    writeFileSync(file, '{truncated')
    assert.equal(refusal(() => store().resolveSubmitted(record.selector)), 'material_submission_mismatch')
    writeFileSync(file, original)
    assert.equal(refusal(() => openMaterialStore(root, identityFor({ agent: 'ag_other' }), { create: false })), 'materials_store_owner_mismatch')
    assert.equal(refusal(() => openMaterialStore(root, identityFor({ connection: 'con-other' }), { create: false })), 'materials_store_owner_mismatch')
    const wrongWorker = materialIdentityFromFingerprints({ profile: mapping.owner.profile,
      owner: mapping.owner.owner, agentFingerprint: materialAgentFingerprint('ag_other'), modelDestination: REMOTE_MODEL })
    assert.equal(refusal(() => openMaterialStore(root, wrongWorker, { create: false }).resolveSubmitted(record.selector)), 'material_submission_mismatch')
    writeFileSync(join(root, 'objects', record.id, 'chunks', '000000.bin'), 'tampered')
    assert.equal(refusal(() => store().resolveSubmitted(record.selector)), 'material_chunk_corrupt')
  })
})

test('a stored material survives a restart, keeps its chunk manifest, and reads back byte for byte', () => {
  area(({ root, identityFor }) => {
    // Larger than one chunk on purpose: a manifest that only ever sees one chunk proves
    // nothing about chunking.
    const bytes = Buffer.concat([Buffer.alloc(MATERIAL_CHUNK_BYTES, 0x61), Buffer.from('tail\n', 'utf8')])
    const first = openMaterialStore(root, identityFor())
    const record = first.put({ name: 'notes.txt', mediaType: 'text/plain; charset=utf-8', bytes })
    assert.match(record.id, MATERIAL_ID_PATTERN)
    assert.equal(record.chunkBytes, MATERIAL_CHUNK_BYTES)
    assert.equal(record.chunks.length, 2, 'a 64 KiB + 5 byte object must be two fixed chunks')
    assert.equal(record.totalBytes, bytes.byteLength)
    assert.equal(record.retention.immutable, true)

    // A second process opening the same directory sees the same object. The store is on
    // disk, not in this handle.
    const reopened = openMaterialStore(root, identityFor())
    assert.deepEqual(reopened.list().map((row) => [row.id, row.name, row.totalBytes]),
      [[record.id, 'notes.txt', bytes.byteLength]])
    const read = reopened.read(record.id, { modelDestination: REMOTE_MODEL })
    assert.ok(read.bytes.equals(bytes), 'the bytes read back are not the bytes stored')
    assert.equal(read.record.digest, record.digest)
  })
})

test('the id is opaque, and the display name never becomes a path', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const record = store.put({ name: 'report 2026.txt', mediaType: 'text/plain', bytes: Buffer.from('x') })
    assert.doesNotMatch(record.id, /[\\/]|report/u, 'the id carries the caller-supplied name or a path separator')
    assert.equal(readdirSync(join(root, 'objects')).includes(record.id), true)
    assert.equal(readdirSync(join(root, 'objects')).some((entry) => entry.includes('report')), false,
      'the display name reached the storage path')
  })

  for (const [name, code] of [
    ['', 'material_name_invalid'],
    ['a/b.txt', 'material_name_path'],
    ['a\\b.txt', 'material_name_path'],
    ['C:evil.txt', 'material_name_path'],
    ['..', 'material_name_traversal'],
    ['../../secret', 'material_name_path'],
    ['a..b', 'material_name_traversal'],
    ['CON', 'material_name_reserved'],
    ['lpt1.txt', 'material_name_reserved'],
    ['trailing.', 'material_name_invalid'],
    [' leading', 'material_name_invalid'],
    ['a'.repeat(256), 'material_name_invalid'],
    [`nul${String.fromCharCode(0)}byte.txt`, 'material_name_control'],
  ]) {
    assert.equal(refusal(() => materialDisplayName(name)), code, `${JSON.stringify(name)} was not refused as ${code}`)
  }
  assert.equal(materialDisplayName('ok name.txt'), 'ok name.txt', 'an ordinary name was refused (calibration)')
})

test('bytes must be canonical base64, so the digest is a function of what the caller sent', () => {
  const canonical = Buffer.from('hello').toString('base64')
  assert.equal(decodeCanonicalBase64(canonical).toString('utf8'), 'hello')
  for (const [raw, code] of [
    ['', 'material_bytes_invalid'],
    ['aGVsbG8', 'material_bytes_invalid'],
    ['aGVs bG8=', 'material_bytes_invalid'],
    ['aGVsbG8*', 'material_bytes_invalid'],
    // Trailing bits no encoder produces. `Buffer.from` decodes `aGl=` to the same two bytes
    // as the canonical `aGk=`, so two different texts would carry one digest — which is the
    // whole reason the decode is not trusted on its own.
    ['aGl=', 'material_bytes_not_canonical'],
  ]) {
    assert.equal(refusal(() => decodeCanonicalBase64(raw)), code, `${JSON.stringify(raw)} was not refused as ${code}`)
  }
  assert.equal(Buffer.from('aGl=', 'base64').toString('utf8'), 'hi',
    'the permissive decode this check exists to catch no longer behaves that way (calibration)')
})

test('a chunk edited underneath the store is refused as corruption, never served as content', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const record = store.put({ name: 'notes.txt', mediaType: 'text/plain', bytes: Buffer.from('the original text', 'utf8') })
    const chunk = join(root, 'objects', record.id, 'chunks', '000000.bin')
    writeFileSync(chunk, 'the REPLACED text')
    assert.equal(refusal(() => store.read(record.id, { modelDestination: REMOTE_MODEL })), 'material_chunk_corrupt')
    assert.equal(refusal(() => store.verify(record.id)), 'material_chunk_corrupt')
    // A truncated chunk is the same failure and not a short read.
    writeFileSync(chunk, 'the orig')
    assert.equal(refusal(() => store.read(record.id, { modelDestination: REMOTE_MODEL })), 'material_chunk_corrupt')
  })
})

test('a record whose digest no longer describes its chunks is refused rather than reconciled', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const record = store.put({ name: 'notes.txt', mediaType: 'text/plain', bytes: Buffer.from('abc') })
    const file = join(root, 'objects', record.id, 'record.json')
    const edited = JSON.parse(readFileSync(file, 'utf8'))
    edited.digest = `sha256:${'0'.repeat(64)}`
    writeFileSync(file, JSON.stringify(edited))
    assert.equal(refusal(() => store.read(record.id, { modelDestination: REMOTE_MODEL })), 'material_digest_mismatch')
  })
})

test('bytes that are no longer on this machine are unavailable, not empty', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const record = store.put({ name: 'notes.txt', mediaType: 'text/plain', bytes: Buffer.from('offline soon') })
    rmSync(join(root, 'objects', record.id, 'chunks', '000000.bin'))
    assert.equal(refusal(() => store.read(record.id, { modelDestination: REMOTE_MODEL })), 'material_bytes_unavailable')
    // Still listed: the record is the profile's, and pretending the material never existed
    // would answer "you never added that" to somebody whose file is simply not readable.
    assert.equal(store.list().some((row) => row.id === record.id), true)
  })
})

test('a write that died half way leaves nothing a reader can reach', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    store.put({ name: 'good.txt', mediaType: 'text/plain', bytes: Buffer.from('landed') })
    // Exactly what a killed upload leaves behind: a staging directory with a partial object
    // in it. It is under `tmp/`, so nothing under `objects/` can name it.
    const staging = join(root, 'tmp', 'mat_' + 'f'.repeat(32) + '.half')
    mkdirSync(join(staging, 'chunks'), { recursive: true })
    writeFileSync(join(staging, 'chunks', '000000.bin'), 'half a file')
    assert.deepEqual(store.list().map((row) => row.name), ['good.txt'],
      'a half-written staging directory was listed as a material')
    assert.equal(refusal(() => store.read('mat_' + 'f'.repeat(32), { modelDestination: REMOTE_MODEL })), 'material_not_found')
    // And a successful put never leaves its own staging directory behind.
    assert.equal(readdirSync(join(root, 'tmp')).length, 1, 'a completed put left staging state behind')
  })
})

test('the owner binding survives a key rotation and refuses a different Gateway, Connection or Agent', () => {
  area(({ root, identityFor }) => {
    const first = openMaterialStore(root, identityFor())
    const record = first.put({ name: 'private.txt', mediaType: 'text/plain', bytes: Buffer.from('mine') })
    assert.equal(first.list().length, 1)

    // The owner is made of stable identity, not of secrets. Nothing about rotating a token or a
    // Connection key appears in it, so the same owner keeps reading its own files — which is the
    // whole reason a secret is not part of the binding.
    assert.equal(identityFor().owner, identityFor({ modelUrl: LOCAL_MODEL }).owner,
      'the model endpoint entered the owner binding, which is about identity rather than disclosure')

    // Each of the three moves the binding, and each fails closed at open. The Agent is bound on
    // first sighting rather than at creation, because a host only learns it from its running
    // Agent — so it is checked here as its own case rather than folded into the fingerprint.
    for (const changed of [{ connection: 'con-second' }, { agent: 'ag_second' }, { gateway: 'https://gateway.example' }]) {
      assert.equal(refusal(() => openMaterialStore(root, identityFor(changed))), 'materials_store_owner_mismatch',
        `${JSON.stringify(changed)} was adopted into an existing material area`)
    }
    // An Agent that has not reported its identity yet does not open another Agent's area by
    // declining to say who it is.
    assert.equal(refusal(() => openMaterialStore(root, identityFor({ agent: 'ag_second' }))), 'materials_store_owner_mismatch')
    // Calibration: the original owner still reads its own material.
    assert.equal(openMaterialStore(root, identityFor()).read(record.id, { modelDestination: REMOTE_MODEL })
      .bytes.toString(), 'mine')
  })
})

test('a profile with no Connection and no Agent has no owner to bind to, and is refused', () => {
  area(({ configFile }) => {
    assert.equal(refusal(() => materialIdentity({ configFile, gatewayUrl: GATEWAY, connectionId: '', agentId: '' })),
      'materials_owner_unidentified')
    // An Agent that has not reported an identity yet is not an identity either — it is the
    // placeholder this host uses while it waits.
    assert.equal(refusal(() => materialIdentity({ configFile, gatewayUrl: GATEWAY, connectionId: '', agentId: 'unconfigured' })),
      'materials_owner_unidentified')
    // Either one alone is enough. A Worker-only profile has a Connection and no Agent, and it
    // must not share an owner with every other unconfigured profile on the machine.
    const workerOnly = materialIdentity({ configFile, gatewayUrl: GATEWAY, connectionId: 'con-a', agentId: '' })
    const otherWorker = materialIdentity({ configFile, gatewayUrl: GATEWAY, connectionId: 'con-b', agentId: '' })
    assert.notEqual(workerOnly.owner, otherWorker.owner)
    assert.notEqual(materialIdentity({ configFile, gatewayUrl: GATEWAY, connectionId: '', agentId: 'ag_only' }).owner,
      workerOnly.owner)
  })
})

test('a material area belongs to one profile, and another profile is refused rather than adopted', () => {
  area(({ root, identityFor, dir }) => {
    openMaterialStore(root, identityFor()).put({ name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('a') })
    const other = materialIdentity({
      configFile: join(dir, 'other', 'local.json'), gatewayUrl: GATEWAY, connectionId: 'con-first',
      agentId: 'ag_first', modelUrl: REMOTE_MODEL,
    })
    assert.equal(refusal(() => openMaterialStore(root, other)), 'materials_store_profile_mismatch')
  })
})

test('a store written in another format is refused as migration-required, never reinterpreted', () => {
  area(({ root, identityFor }) => {
    openMaterialStore(root, identityFor())
    const marker = join(root, 'store.json')
    const written = JSON.parse(readFileSync(marker, 'utf8'))
    assert.equal(written.version, MATERIAL_STORE_VERSION)
    writeFileSync(marker, JSON.stringify({ ...written, version: 'rulith-materials/0' }))
    const error = refusal(() => openMaterialStore(root, identityFor()))
    assert.equal(error, 'materials_store_migration_required')
    // Unreadable is its own case, and also not a reason to start fresh over the top.
    writeFileSync(marker, 'not json at all')
    assert.equal(refusal(() => openMaterialStore(root, identityFor())), 'materials_store_unreadable')
  })
})

test('a material area that is a reparse point is refused', (t) => {
  area(({ dir, root, identityFor }) => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    try {
      symlinkSync(elsewhere, root, 'junction')
    } catch {
      return t.skip('this platform and account cannot create a directory junction')
    }
    assert.equal(existsSync(root), true, 'the fixture did not create a redirected material area (calibration)')
    assert.equal(refusal(() => openMaterialStore(root, identityFor())), 'materials_store_reparse')
  })
})

test('material object and staging directories cannot redirect outside the area', (t) => {
  for (const child of ['objects', 'tmp']) area(({ dir, root, identityFor }) => {
    mkdirSync(root, { recursive: true })
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    try { symlinkSync(elsewhere, join(root, child), 'junction') }
    catch { return t.skip('directory junction unavailable') }
    assert.equal(refusal(() => openMaterialStore(root, identityFor())), 'materials_store_reparse')
    assert.deepEqual(readdirSync(elsewhere), [], 'opening a redirected area wrote outside its boundary')
  })
})

test('disclosure is bound to the model destination the material was added under', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const record = store.put({ name: 'notes.txt', mediaType: 'text/plain', bytes: Buffer.from('confidential') })
    assert.equal(record.disclosure.modelDestination, normalizeModelDestination(REMOTE_MODEL))
    assert.equal(record.disclosure.localOnly, false)
    // The same store handle, asked for a different destination: refused. Changing where the
    // model lives does not carry an existing attachment's permission with it.
    assert.equal(refusal(() => store.read(record.id, { modelDestination: 'https://example.invalid/v1/messages' })),
      'material_disclosure_refused')
    assert.equal(refusal(() => store.read(record.id, { modelDestination: '' })), 'material_disclosure_refused')
    // Calibration: the destination it was added under still reads.
    assert.equal(store.read(record.id, { modelDestination: REMOTE_MODEL }).bytes.toString(), 'confidential')
  })
})

test('a material added under a local model is local-only and is refused to a remote one', () => {
  area(({ root, identityFor }) => {
    const local = openMaterialStore(root, identityFor({ modelUrl: LOCAL_MODEL }))
    const record = local.put({ name: 'secret.txt', mediaType: 'text/plain', bytes: Buffer.from('local only') })
    assert.equal(record.disclosure.localOnly, true)
    assert.equal(isLoopbackDestination(record.disclosure.modelDestination), true)
    // Same profile, same credential, the model endpoint edited afterwards.
    const repointed = openMaterialStore(root, identityFor({ modelUrl: REMOTE_MODEL }))
    assert.equal(refusal(() => repointed.read(record.id, { modelDestination: REMOTE_MODEL })), 'material_disclosure_refused')
    assert.equal(local.read(record.id, { modelDestination: LOCAL_MODEL }).bytes.toString(), 'local only')
  })
})

test('text is offered as text only when it really is UTF-8 text', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const utf8 = Buffer.from('# Title\n\nstraße — 汉字\n', 'utf8')
    const text = store.put({ name: 'notes.md', mediaType: 'text/markdown; charset=utf-8', bytes: utf8 })
    assert.equal(materialTextOf(text, utf8), utf8.toString('utf8'))

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    const binary = store.put({ name: 'pixel.png', mediaType: 'image/png', bytes: png })
    assert.equal(materialTextOf(binary, png), undefined, 'a PNG was offered as text')

    // A text media type whose bytes are not valid UTF-8 is still not text. Decoding it would
    // hand back replacement characters and call them the document.
    const mojibake = Buffer.from([0x68, 0x69, 0xff, 0xfe])
    const mislabelled = store.put({ name: 'claims.txt', mediaType: 'text/plain', bytes: mojibake })
    assert.equal(materialTextOf(mislabelled, mojibake), undefined)

    // And no container is opened: a DOCX is bytes, whatever is inside it.
    const docx = Buffer.from('PK not really a document', 'binary')
    const document = store.put({
      name: 'contract.docx', bytes: docx,
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    assert.equal(materialTextOf(document, docx), undefined, 'this build claimed to extract text from a DOCX')
  })
})

test('this host mints no capability of its own: a read is asked for by id and checked, never unlocked', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    // There is deliberately no ticket surface here. The only ticket in this protocol is the
    // Gateway's, minted per read and exchanged for a current authorization at the Gateway. A
    // host-signed one would be this host issuing itself permission to disclose somebody's file,
    // which is precisely the fallback the wire refuses to leave in place.
    for (const name of ['mintTicket', 'claimTicket', 'authorize', 'grant']) {
      assert.equal(store[name], undefined, `the store exposes ${name}, which would be a host-issued capability`)
    }
    assert.equal(existsSync(join(root, 'secret.key')), false,
      'the material area still holds a signing secret for a capability this protocol does not have')
  })
})

test('a window is trimmed to whole code points, and refuses rather than substituting one', () => {
  const text = Buffer.from('aé漢', 'utf8') // 1 + 2 + 3 bytes
  assert.equal(trimToCodePoints(text).text, 'aé漢')
  // A tail cut mid-character loses the partial character rather than decoding it to U+FFFD.
  assert.equal(trimToCodePoints(text.subarray(0, 4)).text, 'aé')
  assert.equal(trimToCodePoints(text.subarray(0, 3)).text, 'aé')
  assert.equal(trimToCodePoints(text.subarray(0, 1)).text, 'a')
  // A window that *starts* mid-character cannot be completed from its own bytes.
  assert.equal(refusal(() => trimToCodePoints(text.subarray(2))), 'material_offset_split_code_point')
  // A window holding no whole code point is empty, and an empty success would say the object
  // ends there.
  assert.equal(refusal(() => trimToCodePoints(text.subarray(3, 4))), 'material_window_empty')
  assert.equal(refusal(() => trimToCodePoints(Buffer.alloc(0))), 'material_window_empty')
  // Bytes declared UTF-8 that are not UTF-8 are refused by name, whether the offending byte is
  // inside the window or the last thing in it. Trimming a byte that starts no sequence at all
  // would quietly discard content this window really contains.
  assert.equal(refusal(() => trimToCodePoints(Buffer.from([0x68, 0xff, 0x69]))), 'material_encoding_unverifiable')
  assert.equal(refusal(() => trimToCodePoints(Buffer.from([0x68, 0x69, 0xff]))), 'material_encoding_unverifiable')
})

test('result bytes an action produced are stored and chunked exactly like a material', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const bytes = Buffer.concat([Buffer.alloc(MATERIAL_CHUNK_BYTES, 0x41), Buffer.from('end', 'utf8')])
    const produced = store.putResult({ mediaType: 'text/plain; charset=utf-8', encoding: 'utf8', bytes })
    assert.match(produced.id, /^res_[0-9a-f]{32}$/u)
    assert.equal(produced.encoding, 'utf8')
    assert.equal(produced.chunks.length, 2)
    assert.equal(store.verify(produced.id).digest, produced.digest)
    // A whole-chunk range reads back exactly, and a range outside the manifest is refused.
    const { chunks } = store.chunks(produced.id, 1, 1)
    assert.equal(chunks[0].toString('utf8'), 'end')
    assert.equal(refusal(() => store.chunks(produced.id, 1, 2)), 'material_chunk_range_invalid')
    assert.equal(refusal(() => store.chunks(produced.id, -1, 1)), 'material_chunk_range_invalid')
    // Produced objects are not listed as materials: `list` answers what a person attached.
    assert.deepEqual(store.list(), [])
    assert.equal(store.retention().some((row) => row.id === produced.id && row.kind === 'result'), true)
  })
})

test('a derived result is durable in its own right and reads the same bytes', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    const bytes = Buffer.from('the material text', 'utf8')
    const material = store.put({ name: 'notes.txt', mediaType: 'text/plain', bytes })
    const produced = store.deriveResult(material.id)
    assert.match(produced.id, /^res_[0-9a-f]{32}$/u)
    assert.equal(produced.digest, material.digest)
    assert.deepEqual(produced.chunks, material.chunks)
    assert.equal(produced.retention.dependsOn, material.id)

    // It survives a reopen, and it is not listed as a material: `list` answers what a person
    // attached, and a produced object is not one of those.
    const reopened = openMaterialStore(root, identityFor())
    assert.deepEqual(reopened.list().map((row) => row.id), [material.id])
    const retention = reopened.retention()
    assert.deepEqual(retention.map((row) => row.kind).sort(), ['material', 'result'])
    assert.equal(retention.every((row) => row.immutable === true), true)
  })
})

test('an identity built from fingerprints refuses anything that is not one', () => {
  const good = materialIdentityFromFingerprints({ profile: 'a'.repeat(64), owner: 'b'.repeat(64), modelDestination: LOCAL_MODEL })
  assert.equal(good.localOnly, true)
  assert.equal(good.modelDestination, normalizeModelDestination(LOCAL_MODEL))
  for (const binding of [
    {}, { profile: 'a'.repeat(64) }, { profile: 'short', owner: 'b'.repeat(64) },
    { profile: 'A'.repeat(64), owner: 'b'.repeat(64) },
  ]) {
    assert.equal(refusal(() => materialIdentityFromFingerprints(binding)), 'material_identity_invalid')
  }
})

test('the per-file ceiling is checked on the decoded bytes, and an empty file has nothing to read', () => {
  area(({ root, identityFor }) => {
    const store = openMaterialStore(root, identityFor())
    assert.equal(refusal(() => store.put({ name: 'empty.txt', mediaType: 'text/plain', bytes: Buffer.alloc(0) })),
      'material_empty')
    assert.equal(refusal(() => store.put({
      name: 'huge.bin', mediaType: 'application/octet-stream', bytes: Buffer.alloc(8 * 1024 * 1024 + 1),
    })), 'material_too_large')
    // Calibration: exactly the documented limit is accepted.
    const atLimit = store.put({ name: 'limit.bin', mediaType: 'application/octet-stream', bytes: Buffer.alloc(8 * 1024 * 1024, 7) })
    assert.equal(atLimit.totalBytes, 8 * 1024 * 1024)
    assert.equal(atLimit.chunks.length, 128)
  })
})
