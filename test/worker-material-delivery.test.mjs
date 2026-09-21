// SPDX-License-Identifier: Apache-2.0
/**
 * The real Worker process speaking the material wire, against a scripted Gateway.
 *
 * Three exchanges and one property. A produced object is made durable here and **registered**
 * — a manifest goes out and no payload byte does. A proxied read reaches this machine over a
 * delivery channel that runs beside the business loop, under the same lease, and answers with
 * whole verified chunks or with a named unavailability rather than with silence. A local read
 * arrives over the launching host's IPC pipe, is exchanged at the Gateway for a current
 * authorization, and only then produces one window of bytes.
 *
 * Everything is asserted from outside the Worker — the endpoint's request log, the bytes it
 * received, and the IPC messages the process sent — because a Worker cannot fake a request that
 * did not arrive and cannot un-send one that did.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MATERIAL_CHUNK_BYTES, defaultMaterialRoot, materialIdentity, openMaterialStore,
} from '../worker/material-store.mjs'
import { HOLD, actionRow, driveWorker, toolDigest } from './support/worker-harness.mjs'

const REF = `art_${'1'.repeat(32)}`
const REQUEST = `mdr_${'2'.repeat(32)}`
const TICKET = `mlt_${'9'.repeat(43)}`
const GATEWAY = 'https://api.rulith.ai'
const LOCAL_MODEL = 'http://127.0.0.1:1234'
/** The Source's current material permission, as it travels beside every delivery request. */
const PROXY_GRANTED = { sourceRecordId: 'materials', register: true, proxy: 'granted', localRead: 'granted', refusal: null }

/**
 * A profile's material area, built before the Worker starts, exactly as the launching host
 * would have left it.
 */
async function withArea(run, { modelUrl = LOCAL_MODEL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-worker-custody-'))
  try {
    const configFile = join(dir, 'local.json')
    const identity = materialIdentity({
      configFile, gatewayUrl: GATEWAY, connectionId: 'conn-p2', agentId: 'ag_custody', modelUrl,
    })
    const root = defaultMaterialRoot(configFile)
    const store = openMaterialStore(root, identity)
    return await run({
      dir, root, identity, store,
      env: {
        RULITH_MATERIALS_ROOT: root,
        RULITH_MATERIALS_PROFILE: identity.profile,
        RULITH_MATERIALS_OWNER: identity.owner,
        RULITH_MATERIALS_MODEL_DESTINATION: identity.modelDestination,
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Answer everything that is not a Poll or a lease call with a plain acceptance.
 *
 * The harness leaves `RenewLease` and `ReleaseLease` to its own conforming defaults, so those
 * fall through; a claim or a receipt just needs to be accepted for the arms below, which are
 * about the material surface rather than about the Board.
 */
const acceptOthers = (operation) => (['Poll', 'RenewLease', 'ReleaseLease'].includes(operation.kind)
  ? undefined : { body: { accepted: true, revision: 'b-material' } })

/**
 * Has this process taken the line yet?
 *
 * A second poll is the evidence: the first one is the acquiring poll, and only a process that
 * adopted the lease it answered with goes round again. A custodian with no lease may not claim,
 * so a scenario that sent its request earlier would be testing the fencing refusal.
 */
const leased = (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 2

/** The material read Tool as a dispatched action row, over a Source that is the area itself. */
const materialActionRow = (root, material) => actionRow({
  work: 'inv_material',
  tool: 'rulith.materials.read',
  toolContractId: 'rulith.materials.read@1',
  sourceRecordId: 'materials',
  toolDigest: toolDigest({ adapter: 'material', sourceTypes: ['file'], entry: 'read' }),
  args: JSON.stringify({ source: 'materials', material }),
  toolSpec: JSON.stringify({
    impl: 'worker-tool', exec: 'rulith.materials.read@1', kind: 'read',
    params: { material: 'string' }, sourceTypes: ['file'], returns: [],
  }),
})

test('a material read registers a manifest and reports a reference; no payload byte is sent', async () => {
  await withArea(async ({ root, store, env }) => {
    const material = store.put({
      name: 'notes.md', mediaType: 'text/markdown; charset=utf-8',
      bytes: Buffer.from('# Heading\n\nSECRET-MATERIAL-BODY\n', 'utf8'),
    })
    let dispatched = false
    const registrations = []
    const run = await driveWorker({
      env,
      sources: () => [{ name: 'materials', type: 'file', access: root }],
      reply: (operation) => {
        if (operation.kind !== 'Poll') return acceptOthers(operation)
        if (dispatched) return HOLD
        dispatched = true
        return { body: { accepted: true, payload: { work: [materialActionRow(root, material.id)] } } }
      },
      materialReply: (path, payload, entry) => {
        if (path !== '/artifact/register') return undefined
        registrations.push({ payload, headers: entry.headers })
        return { body: {
          ref: REF, mediaType: payload.mediaType, encoding: payload.encoding,
          totalBytes: payload.totalBytes, digest: payload.digest } }
      },
      done: (seen, output) => /\| receipt (?:not )?committed/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)

    // The Tool was advertised because this profile has an area, and the action ran.
    const advertised = run.of('Poll')[0].operation.tools.map((tool) => tool.id)
    assert.ok(advertised.includes('rulith.materials.read@1'), `the material Tool was not advertised: ${advertised}`)

    assert.equal(registrations.length, 1, `registration did not happen exactly once: ${run.output}`)
    const body = registrations[0].payload
    assert.equal(body.protocol, 'rulith-worker-material/1')
    assert.equal(body.chunkBytes, MATERIAL_CHUNK_BYTES)
    assert.equal(body.totalBytes, material.totalBytes)
    assert.equal(body.digest, material.digest)
    assert.deepEqual(body.chunkDigests, material.chunks)
    assert.equal(body.encoding, 'utf8')
    assert.deepEqual(body.custody, { durable: true, acknowledged: 'rulith-worker-custody/1' })
    assert.match(body.custodyId, /^res_[0-9a-f]{32}$/u, 'the registration named the material rather than the produced object')
    assert.equal(registrations[0].headers['x-rulith-worker-generation'], '7')

    // The one assertion this whole path exists for.
    const everythingSent = run.seen.map((entry) => entry.raw).join('\n')
    assert.doesNotMatch(everythingSent, /SECRET-MATERIAL-BODY/u, 'the material body was sent to the Gateway')
    assert.doesNotMatch(everythingSent, new RegExp(Buffer.from('SECRET-MATERIAL-BODY').toString('base64'), 'u'),
      'the material body was sent to the Gateway, base64-encoded')

    // The receipt carries the reference and no data, and no legacy byte upload was attempted.
    const receipt = run.seen.map((entry) => entry.operation).find((operation) => operation.kind === 'ReportWork')
    assert.deepEqual(receipt.artifacts, [{ ref: REF }])
    assert.equal(receipt.result, '')
    assert.equal(run.of('ArtifactUpload').length, 0, 'the retired payload upload route was called')
  })
})

test('an over-budget ordinary result is taken into custody here and registered, never uploaded', async () => {
  await withArea(async ({ root, env }) => {
    let dispatched = false
    const registrations = []
    const run = await driveWorker({
      env,
      sources: () => [{ name: 'materials', type: 'file', access: root }, { name: 'orders', type: 'file', access: root }],
      extraAdapters: {
        'bulk-adapter.mjs': "process.stdout.write('BULK-RESULT-'.repeat(400))\n",
      },
      extraTools: { 'acme.bulk@1': { adapter: 'run', sourceTypes: ['file'], entry: 'bulk-adapter.mjs' } },
      reply: (operation) => {
        if (operation.kind !== 'Poll') return acceptOthers(operation)
        if (dispatched) return HOLD
        dispatched = true
        return { body: { accepted: true, payload: { work: [actionRow({
          work: 'inv_bulk', tool: 'acme.bulk', toolContractId: 'acme.bulk@1',
          toolDigest: toolDigest({ adapter: 'run', sourceTypes: ['file'], entry: 'bulk-adapter.mjs' }),
          toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.bulk@1', kind: 'act', params: {}, sourceTypes: ['file'] }),
          // A budget this result plainly exceeds, so the arm is about the custody path rather
          // than about whatever the shared fixture's default policy happens to be today.
          artifactPolicy: { inlineBytes: 512, readBytes: 65_536, objectBytes: 1_048_576,
            totalBytes: 10_485_760, temporaryRetentionMs: 600_000 },
        })] } } }
      },
      materialReply: (path, payload) => {
        if (path !== '/artifact/register') return undefined
        registrations.push(payload)
        return { body: { accepted: true, payload: {
          ref: REF, mediaType: payload.mediaType, encoding: payload.encoding,
          totalBytes: payload.totalBytes, digest: payload.digest } } }
      },
      done: (seen, output) => /\| receipt (?:not )?committed/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(registrations.length, 1, `an over-budget result did not register a manifest: ${run.output}`)
    assert.equal(registrations[0].totalBytes, 'BULK-RESULT-'.length * 400)
    assert.match(registrations[0].custodyId, /^res_[0-9a-f]{32}$/u)
    assert.doesNotMatch(run.seen.map((entry) => entry.raw).join('\n'), /BULK-RESULT-BULK-RESULT/u,
      'the result bytes were sent to the Gateway')
    const receipt = run.seen.map((entry) => entry.operation).find((operation) => operation.kind === 'ReportWork')
    assert.deepEqual(receipt.artifacts, [{ ref: REF }])
  })
})

test('the delivery channel answers a proxied read with verified chunks, beside the business loop', async () => {
  await withArea(async ({ root, store, env }) => {
    const bytes = Buffer.concat([Buffer.alloc(MATERIAL_CHUNK_BYTES, 0x41), Buffer.from('tail', 'utf8')])
    const held = store.putResult({ mediaType: 'text/plain; charset=utf-8', encoding: 'utf8', bytes })
    let asked = false
    const delivered = []
    const run = await driveWorker({
      env,
      sources: () => [{ name: 'materials', type: 'file', access: root }],
      reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
      materialReply: (path, payload) => {
        if (path === '/artifact/delivery/result') {
          delivered.push(payload)
          return { body: { accepted: true, payload: { ref: payload.ref, requestId: payload.requestId, chunks: 1 } } }
        }
        if (path !== '/artifact/delivery') return undefined
        if (payload.kind === 'PollDelivery') {
          if (asked) return { body: { accepted: true, delivery: null } }
          asked = true
          return { body: { accepted: true, delivery: {
            requestId: REQUEST, ref: REF, custodyId: held.id, chunkBytes: MATERIAL_CHUNK_BYTES,
            firstChunk: 1, chunkCount: 1, lastChunkBytes: 4, digest: held.digest,
            chunkDigests: [held.chunks[1]], deadlineMillis: 20_000, sourceMaterial: PROXY_GRANTED } } }
        }
        return { body: { accepted: true, delivery: null } }
      },
      done: () => delivered.length > 0,
      timeoutMs: 25_000,
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(delivered.length, 1)
    const reply = delivered[0]
    assert.equal(reply.kind, 'DeliverChunks')
    assert.equal(reply.requestId, REQUEST)
    assert.equal(reply.ref, REF)
    assert.equal(reply.firstChunk, 1)
    assert.deepEqual(reply.chunks.map((chunk) => chunk.index), [1])
    assert.equal(Buffer.from(reply.chunks[0].bytes, 'base64').toString('utf8'), 'tail',
      'the delivered chunk is not the chunk that was asked for')
    // Only the chunks asked for. The custodian is never told the byte window the model chose,
    // and it does not send the whole object because one read wanted part of it.
    assert.equal(reply.chunks.length, 1)
    // The business loop kept running underneath: polls continued while the delivery was served.
    assert.ok(run.of('Poll').length >= 1, 'the business poll loop stopped while a delivery was in flight')
  })
})

test('a custodian that cannot serve a delivery says so by name rather than going quiet', async () => {
  await withArea(async ({ root, store, env }) => {
    const held = store.putResult({ mediaType: 'text/plain', encoding: 'utf8', bytes: Buffer.from('gone soon') })
    // The bytes go away after the manifest was recorded — exactly the "removed or offline"
    // case. A silent custodian would leave the waiting read to time out and be reported as
    // offline, which is a different and untrue thing.
    rmSync(join(root, 'objects', held.id, 'chunks', '000000.bin'))
    let asked = false
    const answers = []
    const run = await driveWorker({
      env,
      sources: () => [{ name: 'materials', type: 'file', access: root }],
      reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
      materialReply: (path, payload) => {
        if (path === '/artifact/delivery/result') {
          answers.push(payload)
          return { body: { accepted: true, payload: { ref: payload.ref, requestId: payload.requestId, unavailable: payload.reason } } }
        }
        if (path !== '/artifact/delivery') return undefined
        if (asked) return { body: { accepted: true, delivery: null } }
        asked = true
        return { body: { accepted: true, delivery: {
          requestId: REQUEST, ref: REF, custodyId: held.id, chunkBytes: MATERIAL_CHUNK_BYTES,
          firstChunk: 0, chunkCount: 1, lastChunkBytes: 9, digest: held.digest,
          chunkDigests: [held.chunks[0]], deadlineMillis: 20_000, sourceMaterial: PROXY_GRANTED } } }
      },
      done: () => answers.length > 0,
      timeoutMs: 25_000,
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(answers[0].kind, 'DeliverUnavailable')
    assert.equal(answers[0].reason, 'material_missing')
    assert.equal(answers[0].requestId, REQUEST)
  })
})

test('an authenticated delivery request is not permission: the custodian checks before it sends', async () => {
  for (const [label, permission, held] of [
    ['the Source may not be proxied now', { ...PROXY_GRANTED, proxy: 'denied', refusal: 'source_material_denied' }, 'result'],
    ['the Source permission is absent', { ...PROXY_GRANTED, proxy: 'absent', refusal: 'source_material_absent' }, 'result'],
    // A file a person added while this profile used a model on this machine. The Source grants
    // proxy now, and that does not reach back and re-decide what they chose.
    ['a person added it as local-only', PROXY_GRANTED, 'material'],
  ]) {
    await withArea(async ({ root, store, env }) => {
      const object = held === 'material'
        ? store.put({ name: 'attached.txt', mediaType: 'text/plain', bytes: Buffer.from('LOCAL-ONLY-BODY') })
        : store.putResult({ mediaType: 'text/plain', encoding: 'utf8', bytes: Buffer.from('PRODUCED-BODY') })
      let asked = false
      const answers = []
      const run = await driveWorker({
        env,
        sources: () => [{ name: 'materials', type: 'file', access: root }],
        reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
        materialReply: (path, payload) => {
          if (path === '/artifact/delivery/result') {
            answers.push(payload)
            return { body: { accepted: true, payload: { ref: payload.ref, requestId: payload.requestId, unavailable: payload.reason } } }
          }
          if (path !== '/artifact/delivery') return undefined
          if (asked) return { body: { accepted: true, delivery: null } }
          asked = true
          return { body: { accepted: true, delivery: {
            requestId: REQUEST, ref: REF, custodyId: object.id, chunkBytes: MATERIAL_CHUNK_BYTES,
            firstChunk: 0, chunkCount: 1, lastChunkBytes: object.totalBytes, digest: object.digest,
            chunkDigests: [object.chunks[0]], deadlineMillis: 20_000, sourceMaterial: permission } } }
        },
        done: () => answers.length > 0,
        timeoutMs: 25_000,
      })
      assert.equal(run.timedOut, false, `${label}: ${run.output}`)
      assert.equal(answers[0].kind, 'DeliverUnavailable', label)
      assert.equal(answers[0].reason, 'material_permission_withdrawn', label)
      assert.doesNotMatch(run.seen.map((entry) => entry.raw).join('\n'), /LOCAL-ONLY-BODY|PRODUCED-BODY/u,
        `${label}: the bytes were sent anyway`)
      assert.doesNotMatch(run.seen.map((entry) => entry.raw).join('\n'),
        new RegExp(Buffer.from('LOCAL-ONLY-BODY').toString('base64').slice(0, 12), 'u'),
        `${label}: the bytes were sent anyway, base64-encoded`)
    }, { modelUrl: LOCAL_MODEL })
  }
})

test('an ordinary action result is proxied normally on a profile that runs a local model', async () => {
  // Calibration for the arm above. Vetoing execution output on the model endpoint that happened
  // to be configured at production time would stop every local-model deployment from ever having
  // an artifact proxied — which is the decision the Source's own permission makes.
  await withArea(async ({ root, store, env }) => {
    const held = store.putResult({ mediaType: 'text/plain; charset=utf-8', encoding: 'utf8', bytes: Buffer.from('PRODUCED-BODY') })
    let asked = false
    const delivered = []
    const run = await driveWorker({
      env,
      sources: () => [{ name: 'materials', type: 'file', access: root }],
      reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
      materialReply: (path, payload) => {
        if (path === '/artifact/delivery/result') {
          delivered.push(payload)
          return { body: { accepted: true, payload: { ref: payload.ref, requestId: payload.requestId, chunks: 1 } } }
        }
        if (path !== '/artifact/delivery') return undefined
        if (asked) return { body: { accepted: true, delivery: null } }
        asked = true
        return { body: { accepted: true, delivery: {
          requestId: REQUEST, ref: REF, custodyId: held.id, chunkBytes: MATERIAL_CHUNK_BYTES,
          firstChunk: 0, chunkCount: 1, lastChunkBytes: held.totalBytes, digest: held.digest,
          chunkDigests: [held.chunks[0]], deadlineMillis: 20_000, sourceMaterial: PROXY_GRANTED } } }
      },
      done: () => delivered.length > 0,
      timeoutMs: 25_000,
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(delivered[0].kind, 'DeliverChunks')
    assert.equal(Buffer.from(delivered[0].chunks[0].bytes, 'base64').toString('utf8'), 'PRODUCED-BODY')
  }, { modelUrl: LOCAL_MODEL })
})

test('a value that cannot be a ticket is refused here, not spent at the Gateway', async () => {
  // A ticket is single use and the first claim consumes it whatever else follows. Refusing a
  // guess locally costs nothing; sending it would spend somebody's real read handle on it.
  await withArea(async ({ root, env }) => {
    const claims = []
    const sent = []
    const run = await driveWorker({
      env,
      ipc: true,
      sources: () => [{ name: 'materials', type: 'file', access: root }],
      reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
      materialReply: (path, payload) => {
        if (path === '/artifact/delivery') return { body: { accepted: true, delivery: null } }
        if (path !== '/artifact/claim') return undefined
        claims.push(payload)
        return { body: { accepted: false, errorCode: 'rejected', reason: 'local_ticket_unknown' } }
      },
      done: (seen, output, { messages, send }) => {
        if (leased(seen) && sent.length === 0) {
          sent.push('x')
          send({ protocol: 'rulith-local-material', operation: 'read', id: 'mlr-9',
            ticket: 'not-a-ticket', modelDestination: LOCAL_MODEL })
        }
        return messages.some((message) => message?.protocol === 'rulith-local-material' && message.id === 'mlr-9')
      },
      timeoutMs: 25_000,
    })
    assert.equal(run.timedOut, false, run.output)
    const answer = run.messages.find((message) => message?.protocol === 'rulith-local-material' && message.id === 'mlr-9')
    assert.equal(answer.ok, false)
    assert.equal(answer.errorCode, 'local_ticket_invalid')
    assert.deepEqual(claims, [], 'a value that cannot be a ticket was spent at the Gateway anyway')
  })
})

test('a local read is claimed at the Gateway first, and only its authorized window is disclosed', async () => {
  await withArea(async ({ root, store, env }) => {
    const bytes = Buffer.from('first half second half', 'utf8')
    const held = store.putResult({ mediaType: 'text/plain; charset=utf-8', encoding: 'utf8', bytes })
    const claims = []
    const replies = []
    const run = await driveWorker({
      env,
      ipc: true,
      sources: () => [{ name: 'materials', type: 'file', access: root }],
      reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
      materialReply: (path, payload) => {
        if (path === '/artifact/delivery') return { body: { accepted: true, delivery: null } }
        if (path !== '/artifact/claim') return undefined
        claims.push(payload)
        return { body: { accepted: true, payload: {
          protocol: 'rulith-local-delivery/1', ref: REF, custodyId: held.id,
          mediaType: held.mediaType, encoding: 'utf8', totalBytes: held.totalBytes, digest: held.digest,
          chunkBytes: MATERIAL_CHUNK_BYTES, firstChunk: 0, chunkDigests: [held.chunks[0]],
          offset: 0, maximumLength: 11, trimming: 'utf8-code-point/1', modelDisclosure: 'denied' } } }
      },
      // Sent only once a second Poll has arrived, which is this process telling the endpoint it
      // is running under the lease the first one confirmed. A custodian with no lease may not
      // claim, so sending earlier would test the fencing refusal rather than the read.
      done: (seen, output, { messages, send }) => {
        if (leased(seen) && replies.length === 0) {
          replies.push('sent')
          send({ protocol: 'rulith-local-material', operation: 'read', id: 'mlr-1',
            ticket: TICKET, modelDestination: LOCAL_MODEL })
        }
        return messages.some((message) => message?.protocol === 'rulith-local-material' && message.id === 'mlr-1')
      },
      timeoutMs: 25_000,
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(claims.length, 1, 'the ticket was not exchanged at the Gateway before bytes were read')
    assert.equal(claims[0].protocol, 'rulith-local-delivery/1')
    assert.equal(claims[0].kind, 'ClaimLocalRead')
    assert.equal(claims[0].ticket, TICKET)
    assert.equal(claims[0].workerGeneration, 7)

    const answer = run.messages.find((message) => message?.protocol === 'rulith-local-material' && message.id === 'mlr-1')
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.deepEqual(Object.keys(answer.result).sort(),
      ['complete', 'data', 'encoding', 'mediaType', 'nextOffset', 'offset', 'ref', 'totalBytes', 'truncated'])
    assert.equal(answer.result.ref, REF)
    assert.equal(answer.result.data, 'first half ', 'the disclosed window is not the one the Gateway authorized')
    assert.equal(answer.result.nextOffset, 11)
    assert.equal(answer.result.complete, false)
    // The Gateway said off-machine disclosure is denied, and this profile's model is on this
    // machine — so the read is served, and nothing about it left.
    assert.doesNotMatch(run.seen.map((entry) => entry.raw).join('\n'), /first half/u,
      'the disclosed bytes were sent to the Gateway')
  })
})

test('a local read for a model that is not on this machine needs a current off-machine grant', async () => {
  await withArea(async ({ root, store, env }) => {
    const held = store.putResult({ mediaType: 'text/plain; charset=utf-8', encoding: 'utf8', bytes: Buffer.from('LOCAL-ONLY-BODY') })
    const asked = []
    const sent = []
    const run = await driveWorker({
      env,
      ipc: true,
      sources: () => [{ name: 'materials', type: 'file', access: root }],
      reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
      materialReply: (path, payload) => {
        if (path === '/artifact/delivery') return { body: { accepted: true, delivery: null } }
        if (path !== '/artifact/claim') return undefined
        asked.push(payload)
        return { body: { accepted: true, payload: {
          protocol: 'rulith-local-delivery/1', ref: REF, custodyId: held.id,
          mediaType: held.mediaType, encoding: 'utf8', totalBytes: held.totalBytes, digest: held.digest,
          chunkBytes: MATERIAL_CHUNK_BYTES, firstChunk: 0, chunkDigests: [held.chunks[0]],
          offset: 0, maximumLength: 1024, trimming: 'utf8-code-point/1', modelDisclosure: 'denied' } } }
      },
      done: (seen, output, { messages, send }) => {
        if (leased(seen) && sent.length === 0) {
          sent.push('x')
          // This profile's recorded destination is the loopback model, and the caller states a
          // remote one. Two refusals could apply; the Worker must reach one of them and must
          // not disclose.
          send({ protocol: 'rulith-local-material', operation: 'read', id: 'mlr-2',
            ticket: TICKET, modelDestination: 'https://api.anthropic.com/v1/messages' })
        }
        return messages.some((message) => message?.protocol === 'rulith-local-material' && message.id === 'mlr-2')
      },
      timeoutMs: 25_000,
    })
    assert.equal(run.timedOut, false, run.output)
    const answer = run.messages.find((message) => message?.protocol === 'rulith-local-material' && message.id === 'mlr-2')
    assert.equal(answer.ok, false)
    assert.ok(['material_disclosure_refused', 'source_off_machine_denied'].includes(answer.errorCode),
      `an off-machine model was served anyway: ${JSON.stringify(answer)}`)
    assert.doesNotMatch(JSON.stringify(answer), /LOCAL-ONLY-BODY/u, 'the refusal carried the bytes it was refusing')
  })
})

test('a Worker with no material area holds custody of nothing and says so', async () => {
  const run = await driveWorker({
    reply: (operation) => (operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : acceptOthers(operation)),
    ipc: true,
    done: (seen, output, { messages, send }) => {
      if (/online ·/.test(output) && messages.length === 0) {
        send({ protocol: 'rulith-local-material', operation: 'read', id: 'mlr-3', ticket: 'mlt_x', modelDestination: LOCAL_MODEL })
      }
      return messages.some((message) => message?.protocol === 'rulith-local-material')
    },
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  const answer = run.messages.find((message) => message?.protocol === 'rulith-local-material')
  assert.equal(answer.ok, false)
  assert.equal(answer.errorCode, 'materials_not_configured')
  // No material Tool is advertised, and no delivery channel is polled at all.
  assert.equal(run.of('Poll')[0].operation.tools.some((tool) => tool.id === 'rulith.materials.read@1'), false)
  assert.equal(run.seen.some((entry) => String(entry.path ?? '').startsWith('/artifact/')), false,
    'a Worker with no custody polled the delivery channel anyway')
})
