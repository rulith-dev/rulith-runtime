// SPDX-License-Identifier: Apache-2.0
/**
 * The Worker's half of the material wire, checked against the frozen contract.
 *
 * Every message on this wire is either a manifest, a chunk range, or an authorization — and none
 * of them is a payload the Gateway keeps. So the arms here are all about the same question asked
 * three ways: **is this answer about the object I hold, and does it authorize what it claims to?**
 * A shape that parses is not an answer; a reference whose length or digest names other bytes is a
 * reference to something else; and an authorization that omits the off-machine permission is not
 * a grant of it.
 *
 * These functions hold no credentials and open no sockets, which is why they can be driven
 * directly. The process-level arms live in `worker-material-delivery.test.mjs`.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MATERIAL_CHUNK_BYTES, MaterialError, defaultMaterialRoot, materialIdentity, openMaterialStore,
} from '../worker/material-store.mjs'
import {
  LOCAL_DELIVERY_PROTOCOL, MATERIAL_PROTOCOL, MAX_DELIVERY_BYTES, MAX_WINDOW_BYTES, MAX_WINDOW_CHUNKS,
  assertDisclosurePermitted, assertProxyPermitted, claimAuthorization, custodyIdOf, deliveryChunks,
  deliveryRequestOf, localReadResult, localTicketOf, registrationBody, registrationResult,
  sourceMaterialPermission, uploadDecision,
} from '../worker/material-transport.mjs'

const REF = `art_${'1'.repeat(32)}`
const REQUEST = `mdr_${'2'.repeat(32)}`
const REMOTE_MODEL = 'https://api.anthropic.com/v1/messages'
const LOCAL_MODEL = 'http://127.0.0.1:1234'
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const refusal = (fn) => {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MaterialError, `expected a MaterialError, received ${error}`)
    return error.code
  }
  return assert.fail('the call was expected to refuse and returned instead')
}

/** A real store with one two-chunk object in it, so chunk arms are about real bytes. */
function withObject(run, { text } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-material-wire-'))
  try {
    const configFile = join(dir, 'local.json')
    const store = openMaterialStore(defaultMaterialRoot(configFile), materialIdentity({
      configFile, gatewayUrl: 'https://api.rulith.ai', connectionId: 'con-1', agentId: 'ag_1', modelUrl: REMOTE_MODEL,
    }))
    const bytes = text === undefined
      ? Buffer.concat([Buffer.alloc(MATERIAL_CHUNK_BYTES, 0x41), Buffer.from('tail', 'utf8')])
      : Buffer.from(text, 'utf8')
    const record = store.putResult({ mediaType: 'text/plain; charset=utf-8', encoding: 'utf8', bytes })
    return run({ store, record, bytes })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('registration states a manifest of bytes already durable here, and never the bytes', () => {
  withObject(({ record, bytes }) => {
    const body = registrationBody(record, 'grant-token')
    assert.equal(body.protocol, MATERIAL_PROTOCOL)
    assert.equal(body.executionGrant, 'grant-token')
    assert.equal(body.custodyId, record.id)
    assert.equal(body.chunkBytes, MATERIAL_CHUNK_BYTES)
    assert.equal(body.chunkDigests.length, Math.ceil(bytes.byteLength / MATERIAL_CHUNK_BYTES))
    assert.deepEqual(body.custody, { durable: true, acknowledged: 'rulith-worker-custody/1' })
    assert.equal(JSON.stringify(body).includes(bytes.toString('base64').slice(0, 40)), false,
      'the registration body carries the object bytes it is supposed to replace')
    // A record whose manifest does not describe its own length is refused before it is sent.
    assert.equal(refusal(() => registrationBody({ ...record, totalBytes: record.totalBytes * 4 }, 'g')), 'material_manifest_invalid')
    assert.equal(refusal(() => registrationBody({ ...record, chunkBytes: 1024 }, 'g')), 'material_chunk_size_mismatch')
    assert.equal(refusal(() => registrationBody({ ...record, id: '../escape' }, 'g')), 'material_custody_id_invalid')
  })
})

test('a reference is only accepted when the service agrees which bytes it refers to', () => {
  withObject(({ record }) => {
    const sound = {
      ref: REF, mediaType: record.mediaType, encoding: record.encoding,
      totalBytes: record.totalBytes, digest: record.digest,
    }
    assert.deepEqual(registrationResult(sound, record), { ref: REF })
    assert.deepEqual(registrationResult({ accepted: true, payload: sound }, record), { ref: REF })
    for (const [label, answer] of [
      ['no reference', { ...sound, ref: undefined }],
      ['a custody id where a reference belongs', { ...sound, ref: record.id }],
      ['another digest', { ...sound, digest: `sha256:${'0'.repeat(64)}` }],
      ['another length', { ...sound, totalBytes: record.totalBytes + 1 }],
      ['another media type', { ...sound, mediaType: 'application/octet-stream' }],
      ['another encoding', { ...sound, encoding: 'base64' }],
      ['nothing at all', undefined],
    ]) {
      assert.equal(registrationResult(answer, record), undefined, `${label} was accepted as this object's reference`)
    }
  })
})

/** The current Source permission the Gateway states beside every delivery request. */
const PROXY_GRANTED = { sourceRecordId: 'orders', register: true, proxy: 'granted', localRead: 'granted', refusal: null }

test('the three opaque values are opaque, not shapeless', () => {
  // A custody id is an index key the Gateway echoes back, never a location. The canonical charset
  // has no colon, so a drive-relative value cannot reach a caller that might one day join it.
  assert.equal(custodyIdOf(`mat_${'a'.repeat(32)}`), `mat_${'a'.repeat(32)}`)
  assert.equal(custodyIdOf('report.2026-01.txt'), 'report.2026-01.txt')
  for (const bad of ['', '.', '..', 'C:notes.txt', 'a/b', 'a\\b', '../escape', 'a'.repeat(129), undefined, 42]) {
    assert.equal(custodyIdOf(bad), undefined, `${JSON.stringify(bad)} passed as a custody id`)
  }

  // A ticket is single use and the first claim spends it, so a value that cannot be one is
  // refused before it is carried anywhere.
  const ticket = `mlt_${'A'.repeat(43)}`
  assert.equal(localTicketOf(ticket), ticket)
  assert.equal(localTicketOf(` ${ticket} `), ticket)
  for (const bad of ['', 'mlt_short', `mlt_${'A'.repeat(44)}`, `art_${'a'.repeat(32)}`, `mlt_${'+'.repeat(43)}`, undefined]) {
    assert.equal(localTicketOf(bad), undefined, `${JSON.stringify(bad)} passed as a delivery ticket`)
  }

  // A partly stated permission is unreadable rather than weaker: the whole reason it travels is
  // so the custodian can refuse without guessing.
  assert.deepEqual(sourceMaterialPermission(PROXY_GRANTED), PROXY_GRANTED)
  assert.deepEqual(sourceMaterialPermission({ ...PROXY_GRANTED, proxy: 'denied', refusal: 'source_material_denied' }),
    { ...PROXY_GRANTED, proxy: 'denied', refusal: 'source_material_denied' })
  for (const bad of [undefined, null, [], {}, { ...PROXY_GRANTED, register: 'yes' },
    { ...PROXY_GRANTED, localRead: undefined }, { ...PROXY_GRANTED, refusal: 'other' }]) {
    assert.equal(sourceMaterialPermission(bad), undefined, `${JSON.stringify(bad)} passed as a Source permission`)
  }
})

test('a delivery request names one contiguous run of whole chunks and a current permission', () => {
  withObject(({ store, record }) => {
    const sound = {
      requestId: REQUEST, ref: REF, custodyId: record.id, chunkBytes: MATERIAL_CHUNK_BYTES,
      firstChunk: 0, chunkCount: 2, digest: record.digest, chunkDigests: [...record.chunks],
      deadlineMillis: 20_000, sourceMaterial: PROXY_GRANTED,
    }
    assert.equal(deliveryRequestOf({ delivery: null }), null, 'the ordinary idle answer was read as a request')
    assert.equal(deliveryRequestOf({ accepted: true }), null)
    const request = deliveryRequestOf({ delivery: sound })
    assert.equal(request.requestId, REQUEST)
    assert.equal(request.chunkCount, 2)
    assert.deepEqual(request.sourceMaterial, PROXY_GRANTED)

    for (const [label, broken] of [
      ['a chunk size the deployment does not use', { ...sound, chunkBytes: 4096 }],
      ['a digest list that does not cover the range', { ...sound, chunkDigests: [record.chunks[0]] }],
      ['a negative first chunk', { ...sound, firstChunk: -1 }],
      ['no chunks at all', { ...sound, chunkCount: 0, chunkDigests: [] }],
      ['more chunks than one window can span', { ...sound, chunkCount: 18, chunkDigests: Array.from({ length: 18 }, () => record.chunks[0]) }],
      ['a custody id that is a path', { ...sound, custodyId: '../../local.json' }],
      // The canonical id charset has no colon: a drive-relative value must not reach a caller
      // that might one day join it.
      ['a custody id that is drive-relative', { ...sound, custodyId: 'C:notes.txt' }],
      ['a request id of another shape', { ...sound, requestId: 'req-1' }],
      ['no deadline', { ...sound, deadlineMillis: undefined }],
      // The permission is required, and a partly stated one is unreadable rather than weaker.
      ['no current Source permission', { ...sound, sourceMaterial: undefined }],
      ['a permission with no proxy value', { ...sound, sourceMaterial: { ...PROXY_GRANTED, proxy: undefined } }],
      ['a permission with an unknown value', { ...sound, sourceMaterial: { ...PROXY_GRANTED, proxy: 'maybe' } }],
      ['a permission with an unknown refusal', { ...sound, sourceMaterial: { ...PROXY_GRANTED, refusal: 'because' } }],
    ]) {
      assert.equal(refusal(() => deliveryRequestOf({ delivery: broken })), 'material_delivery_malformed', label)
    }

    // The chunks themselves are proved against **both** manifests: this host's pinned digests
    // and the ones the request echoed. A request naming this object with somebody else's digests
    // is refused before a byte is sent.
    const chunks = deliveryChunks(store, request)
    assert.deepEqual(chunks.map((chunk) => chunk.index), [0, 1])
    assert.equal(Buffer.from(chunks[1].bytes, 'base64').toString('utf8'), 'tail')
    assert.equal(refusal(() => deliveryChunks(store, { ...request, chunkDigests: [record.chunks[0], `sha256:${'0'.repeat(64)}`] })),
      'material_chunk_digest_mismatch')
    assert.equal(refusal(() => deliveryChunks(store, { ...request, firstChunk: 1, chunkCount: 2, chunkDigests: [record.chunks[1], record.chunks[1]] })),
      'material_chunk_range_invalid')
  })
})

test('an authenticated delivery request is not permission to send the bytes', () => {
  withObject(({ store, record }) => {
    const request = deliveryRequestOf({ delivery: {
      requestId: REQUEST, ref: REF, custodyId: record.id, chunkBytes: MATERIAL_CHUNK_BYTES,
      firstChunk: 0, chunkCount: 2, digest: record.digest, chunkDigests: [...record.chunks],
      deadlineMillis: 20_000, sourceMaterial: PROXY_GRANTED,
    } })
    // Calibration: with the Source's proxy permission granted now, the chunks are produced.
    assert.equal(deliveryChunks(store, request).length, 2)

    // The Source's *current* permission decides, and neither `denied` nor `absent` is a grant.
    for (const proxy of ['denied', 'absent']) {
      const withdrawn = { ...request, sourceMaterial: { ...PROXY_GRANTED, proxy } }
      assert.equal(refusal(() => assertProxyPermitted(withdrawn, record)), 'material_permission_withdrawn', proxy)
      assert.equal(refusal(() => deliveryChunks(store, withdrawn)), 'material_permission_withdrawn',
        `${proxy}: bytes were produced for a Source that may not be proxied`)
    }

    // And this host's own record decides too — for a file a **person** added. A proxied read
    // moves bytes off the machine, and the operator chose otherwise when they added it; a Source
    // granted off-machine disclosure afterwards does not reach back and re-decide that.
    const attached = { ...record, disclosure: { modelDestination: LOCAL_MODEL, localOnly: true, origin: 'operator' } }
    assert.equal(refusal(() => assertProxyPermitted(request, attached)), 'material_permission_withdrawn')

    // Bytes an action produced carry no such choice. Vetoing them on the model endpoint that
    // happened to be configured at production time would stop every local-model deployment from
    // ever having an artifact proxied — which is the decision the Source's own permission makes.
    const produced = { ...record, disclosure: { modelDestination: LOCAL_MODEL, localOnly: true, origin: 'execution' } }
    assert.equal(assertProxyPermitted(request, produced), true,
      'an ordinary action result was refused because this profile happens to run a local model')
  })
})

test('a window that does not begin on a chunk boundary still fits the delivery envelope', () => {
  // A 1 MiB window spans seventeen 64 KiB chunks when it is unaligned, not sixteen. A ceiling
  // expressed in window bytes would refuse the Gateway's own worst case, so the bound is the
  // chunk count and the byte ceiling is derived from it. Asserted here rather than left implied,
  // because the failure mode is an outage that waits for an unaligned offset.
  assert.equal(MAX_WINDOW_CHUNKS, 17)
  assert.equal(MAX_DELIVERY_BYTES, 17 * MATERIAL_CHUNK_BYTES)
  assert.ok(MAX_DELIVERY_BYTES > 1024 * 1024, 'the delivery ceiling cannot express a full unaligned window')

  withObject(({ store, record }) => {
    const request = deliveryRequestOf({ delivery: {
      requestId: REQUEST, ref: REF, custodyId: record.id, chunkBytes: MATERIAL_CHUNK_BYTES,
      firstChunk: 0, chunkCount: MAX_WINDOW_CHUNKS, digest: record.digest,
      chunkDigests: Array.from({ length: MAX_WINDOW_CHUNKS }, () => record.chunks[0]),
      deadlineMillis: 20_000, sourceMaterial: PROXY_GRANTED,
    } })
    assert.equal(request.chunkCount, MAX_WINDOW_CHUNKS, 'a seventeen-chunk request was refused as malformed')
    // This fixture object only has two chunks, so the range check refuses it — by range, which
    // is the correct reason, and not by an envelope that cannot hold a legal request.
    assert.equal(refusal(() => deliveryChunks(store, request)), 'material_chunk_range_invalid')
  }, { text: 'short' })
})

test('a seventeen-chunk window is delivered whole', () => {
  // The real case the arithmetic is about: an object large enough to span the full window, asked
  // for from an offset that is not a chunk boundary.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-material-window-'))
  try {
    const configFile = join(dir, 'local.json')
    const store = openMaterialStore(defaultMaterialRoot(configFile), materialIdentity({
      configFile, gatewayUrl: 'https://api.rulith.ai', connectionId: 'con-1', agentId: 'ag_1', modelUrl: REMOTE_MODEL,
    }))
    const bytes = Buffer.alloc(MAX_WINDOW_CHUNKS * MATERIAL_CHUNK_BYTES, 0x41)
    const record = store.putResult({ mediaType: 'application/octet-stream', encoding: 'base64', bytes })
    assert.equal(record.chunks.length, MAX_WINDOW_CHUNKS)
    const request = deliveryRequestOf({ delivery: {
      requestId: REQUEST, ref: REF, custodyId: record.id, chunkBytes: MATERIAL_CHUNK_BYTES,
      firstChunk: 0, chunkCount: MAX_WINDOW_CHUNKS, digest: record.digest,
      chunkDigests: [...record.chunks], deadlineMillis: 20_000, sourceMaterial: PROXY_GRANTED,
    } })
    const chunks = deliveryChunks(store, request)
    assert.equal(chunks.length, MAX_WINDOW_CHUNKS, 'the full window was refused by the delivery envelope')
    assert.equal(chunks.reduce((sum, chunk) => sum + Buffer.from(chunk.bytes, 'base64').byteLength, 0), bytes.byteLength)

    // And the authorization for that window is accepted at its documented ceiling.
    const authorization = claimAuthorization({ accepted: true, payload: {
      protocol: LOCAL_DELIVERY_PROTOCOL, ref: REF, custodyId: record.id, mediaType: 'application/octet-stream',
      encoding: 'base64', totalBytes: record.totalBytes, digest: record.digest, chunkBytes: MATERIAL_CHUNK_BYTES,
      firstChunk: 0, chunkDigests: [...record.chunks], offset: 1, maximumLength: MAX_WINDOW_BYTES,
      trimming: 'utf8-code-point/1', modelDisclosure: 'granted',
    } })
    assert.equal(authorization.maximumLength, MAX_WINDOW_BYTES)
    const read = localReadResult(authorization, chunks.map((chunk) => Buffer.from(chunk.bytes, 'base64')))
    assert.equal(Buffer.from(read.data, 'base64').byteLength, MAX_WINDOW_BYTES,
      'an unaligned full window did not read its whole authorized length')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an authorization that does not state the off-machine permission is not a grant of it', () => {
  withObject(({ record }) => {
    const sound = {
      protocol: LOCAL_DELIVERY_PROTOCOL, ref: REF, custodyId: record.id, mediaType: record.mediaType,
      encoding: 'utf8', totalBytes: record.totalBytes, digest: record.digest, chunkBytes: MATERIAL_CHUNK_BYTES,
      firstChunk: 0, chunkDigests: [record.chunks[0]], offset: 0, maximumLength: 1024,
      trimming: 'utf8-code-point/1', modelDisclosure: 'granted',
    }
    assert.equal(claimAuthorization({ accepted: true, payload: sound }).ref, REF)
    // The one field whose absence would turn a local-only object into a remote disclosure.
    const { modelDisclosure: _omitted, ...silent } = sound
    assert.equal(refusal(() => claimAuthorization(silent)), 'local_claim_disclosure_unstated')
    assert.equal(refusal(() => claimAuthorization({ ...sound, modelDisclosure: 'maybe' })), 'local_claim_disclosure_unstated')
    for (const [label, broken] of [
      ['another protocol', { ...sound, protocol: 'rulith-local-delivery/2' }],
      ['no window length', { ...sound, maximumLength: 0 }],
      ['another trimming rule', { ...sound, trimming: 'bytes/1' }],
      ['a chunk size the deployment does not use', { ...sound, chunkBytes: 4096 }],
      ['no covering chunks', { ...sound, chunkDigests: [] }],
      ['a custody id that is a path', { ...sound, custodyId: 'C:/secrets' }],
    ]) {
      assert.equal(refusal(() => claimAuthorization(broken)), 'local_claim_malformed', label)
    }
  })
})

test('local custody is not permission to forward bytes to a model somewhere else', () => {
  const authorization = { modelDisclosure: 'absent', custodyId: `res_${'a'.repeat(32)}` }
  // A model on this machine needs no off-machine permission, because nothing leaves.
  assert.equal(assertDisclosurePermitted(authorization, { modelDestination: LOCAL_MODEL }), LOCAL_MODEL)
  // A model anywhere else needs the Gateway's current grant, and neither `absent` nor `denied`
  // is one. Each refuses under its own name.
  assert.equal(refusal(() => assertDisclosurePermitted(authorization, { modelDestination: REMOTE_MODEL })),
    'source_permission_required')
  assert.equal(refusal(() => assertDisclosurePermitted({ ...authorization, modelDisclosure: 'denied' }, { modelDestination: REMOTE_MODEL })),
    'source_off_machine_denied')
  assert.equal(assertDisclosurePermitted({ ...authorization, modelDisclosure: 'granted' }, { modelDestination: REMOTE_MODEL }),
    REMOTE_MODEL)
  // An unstated destination is not a destination that was consented to.
  assert.equal(refusal(() => assertDisclosurePermitted(authorization, { modelDestination: '' })), 'material_destination_unstated')
  // And the host's own record still has to agree: editing the model endpoint after an attachment
  // was selected does not carry its permission with it.
  assert.equal(refusal(() => assertDisclosurePermitted({ ...authorization, modelDisclosure: 'granted' },
    { modelDestination: REMOTE_MODEL, recordDisclosure: LOCAL_MODEL })), 'material_disclosure_refused')
  // The committed permission rule is the same one, read the same way.
  assert.deepEqual(uploadDecision('granted', 'orders'),
    { sourceRecordId: 'orders', permission: 'granted', upload: true, refusal: null })
  assert.deepEqual(uploadDecision(undefined, ''),
    { sourceRecordId: '', permission: 'absent', upload: false, refusal: 'source_permission_required' })
})

test('a local read produces the same nine fields a proxy read does, over the window it was given', () => {
  const text = 'first half second half'
  const bytes = Buffer.from(text, 'utf8')
  const authorization = {
    ref: REF, custodyId: `res_${'a'.repeat(32)}`, mediaType: 'text/plain; charset=utf-8', encoding: 'utf8',
    totalBytes: bytes.byteLength, digest: sha256(bytes), chunkBytes: MATERIAL_CHUNK_BYTES,
    firstChunk: 0, chunkDigests: [sha256(bytes)], offset: 0, maximumLength: 11,
    trimming: 'utf8-code-point/1', modelDisclosure: 'granted',
  }
  const head = localReadResult(authorization, [bytes])
  assert.deepEqual(Object.keys(head).sort(),
    ['complete', 'data', 'encoding', 'mediaType', 'nextOffset', 'offset', 'ref', 'totalBytes', 'truncated'])
  assert.equal(head.data, 'first half ')
  assert.equal(head.complete, false)
  assert.equal(head.truncated, true)
  assert.equal(head.nextOffset, 11)

  const tail = localReadResult({ ...authorization, offset: 11, maximumLength: 1024 }, [bytes])
  assert.equal(tail.data, 'second half')
  assert.equal(tail.complete, true)
  assert.equal(tail.nextOffset, null)
  assert.equal(head.data + tail.data, text, 'the two fragments did not reconstruct the object')

  // `maximumLength` is a bound, not a length: the window shortens to whole code points, and the
  // continuation is reported from what was actually disclosed.
  const wide = Buffer.from('aé漢', 'utf8')
  const partial = localReadResult({
    ...authorization, totalBytes: wide.byteLength, digest: sha256(wide), maximumLength: 4,
  }, [wide])
  assert.equal(partial.data, 'aé')
  assert.equal(partial.nextOffset, 3, 'the continuation offset was reported from the untrimmed bound')

  // A truncated character at the true end is corrupt declared UTF-8, not a window boundary.
  const invalidEnd = Buffer.from([0x41, 0xe4, 0xb8])
  assert.equal(refusal(() => localReadResult({ ...authorization, totalBytes: invalidEnd.length,
    maximumLength: 1024 }, [invalidEnd])), 'material_encoding_unverifiable')

  // Binary is delivered as base64 with no trimming at all.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff])
  const raw = localReadResult({
    ...authorization, encoding: 'base64', mediaType: 'image/png', totalBytes: png.byteLength,
    digest: sha256(png), maximumLength: 1024,
  }, [png])
  assert.ok(Buffer.from(raw.data, 'base64').equals(png))
  assert.equal(raw.complete, true)

  // A window outside the chunks this host holds is a refusal, not a short read.
  assert.equal(refusal(() => localReadResult({ ...authorization, offset: bytes.byteLength }, [bytes])), 'material_window_empty')
  assert.equal(refusal(() => localReadResult({ ...authorization, firstChunk: 1 }, [bytes])), 'material_chunk_range_invalid')
})
