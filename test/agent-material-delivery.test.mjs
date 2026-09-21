// SPDX-License-Identifier: Apache-2.0
/**
 * Negotiated local delivery, driven through the real Agent against a scripted authority.
 *
 * The rule under test: the model asks for an artifact the ordinary way, the Agent negotiates
 * local delivery on that MCP call, and the authority answers with **no bytes** — a visible
 * `local_delivery_incomplete` plus a per-read ticket in a host-only `_meta` namespace. The host
 * hands the ticket to its custodian and substitutes the result before the model sees anything.
 * A host that cannot complete it therefore leaves the model with a visible unavailable, never a
 * fabricated empty success.
 *
 * Two things this file is deliberately *not* about. The ticket is the authority's, minted per
 * read and exchanged at the authority for a current authorization — that exchange is driven
 * against the real Worker in `worker-material-delivery.test.mjs`, and here the Rulith host's
 * delivery endpoint is a stand-in so the arms stay about what the **Agent** does. And a
 * a refused local delivery does not silently change the next read to a proxy.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { TEST_AGENT_ID, callTool, defaultGateway, freePort, runAgent, withMeta } from './support/agent-harness.mjs'

const GATEWAY_REF = `art_${'a'.repeat(32)}`
const OTHER_REF = `art_${'b'.repeat(32)}`
const TICKET = `mlt_${'9'.repeat(43)}`
const SECRET = 'MATERIAL-CONTENT-MARKER not on any wire'
const MATERIALS_KEY = 'materials-key-for-the-agent'
const LOCAL_DELIVERY_HEADER = 'x-rulith-local-delivery'

/**
 * A stand-in for the Rulith host's local read endpoint.
 *
 * It records every claim it was handed and answers whatever the scenario scripts, so an arm can
 * be about the Agent's behaviour on each answer rather than about a custodian's.
 */
async function withDeliveryEndpoint(run, { answer } = {}) {
  const claims = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
      claims.push({ body, key: request.headers['x-rulith-material'] ?? null })
      const scripted = answer?.(body, claims) ?? { status: 200, body: { ok: true, result: {
        ref: body.ref, mediaType: 'text/plain; charset=utf-8', encoding: 'utf8', data: SECRET,
        offset: 0, nextOffset: null, totalBytes: Buffer.byteLength(SECRET), complete: true, truncated: false } } }
      response.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(scripted.body))
    })
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address()
  try {
    return await run({
      claims,
      env: {
        RULITH_MATERIALS_DELIVER_URL: `http://127.0.0.1:${port}/materials/deliver`,
        RULITH_MATERIALS_KEY: MATERIALS_KEY,
        RULITH_MATERIALS_CONNECTION: 'con-local-materials',
      },
    })
  } finally {
    await new Promise((closed) => server.close(closed))
  }
}

/**
 * The authority's negotiated answer: a visible unavailable, and the ticket beside it.
 *
 * `_meta["rulith/local-delivery/v1"]` is a sibling of the host-metadata block and equally
 * host-only; the model receives only the text content, which is the refusal.
 */
const negotiated = (block = {}) => (name, args) => (name !== 'ReadArtifact' ? undefined : withMeta({
  accepted: false, errorCode: 'local_delivery_incomplete',
  teaching: 'This bounded read was authorized for local delivery on the requesting host. The service carried no bytes.'
    + ' Restore the local custodian before trying again.',
}, {
  agentId: TEST_AGENT_ID,
  'rulith/local-delivery/v1': {
    protocol: 'rulith-local-delivery/1', ticket: TICKET, ref: String(args.ref),
    custodyId: `res_${'c'.repeat(32)}`, claimPath: '/work/artifact/claim', expiresInMillis: 15_000,
    ...block,
  },
}))

/** Every message body this run sent to the model, as one string. */
const modelText = (run) => JSON.stringify(run.modelRequests)
/** The tool result fragments the last model request carried. */
const fragments = (run) => run.modelRequests.at(-1).messages
  .filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content))

test('a negotiated read is completed from custody, and the model reads bytes that never left', async () => {
  await withDeliveryEndpoint(async ({ claims, env }) => {
    const port = await freePort()
    const run = await runAgent({
      argv: [], listenPort: port, captureLocalEvents: true,
      env: { RULITH_MAX_ROUNDS: '4', ...env },
      chatLines: ['Read what was attached.'],
      gateway: defaultGateway(),
      tool: negotiated(),
      model: (round) => (round === 1 ? callTool('ReadArtifact', { ref: GATEWAY_REF }) : 'I have read it.'),
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)

    // The authority was asked first, the ordinary way, with the reference it issued — and the
    // negotiation travelled as a header beside the call, never as an argument.
    assert.deepEqual(run.verbs, ['ReadArtifact'])
    assert.deepEqual(run.toolCalls[0].args, { ref: GATEWAY_REF })
    const negotiations = run.requests.filter((entry) => entry.method === 'tools/call')
    assert.equal(negotiations.length, 1)
    assert.equal(negotiations[0].headers?.[LOCAL_DELIVERY_HEADER], 'rulith-local-delivery/1',
      'the read did not negotiate local delivery')
    assert.equal(negotiations[0].headers?.['x-rulith-local-custodian'], 'con-local-materials')

    // The ticket went to the custodian with this Agent's model destination, under the key that
    // opens only that endpoint.
    assert.equal(claims.length, 1)
    assert.equal(claims[0].key, MATERIALS_KEY)
    assert.equal(claims[0].body.ticket, TICKET)
    assert.equal(claims[0].body.ref, GATEWAY_REF)
    assert.equal(claims[0].body.modelDestination, `http://127.0.0.1:${port}`)

    // The model received the locally completed fragment, in the shape ReadArtifact answers in,
    // and never saw the authority's placeholder refusal.
    const read = fragments(run)
    assert.equal(read.length, 1)
    assert.equal(read[0].accepted, true)
    assert.equal(read[0].result.ref, GATEWAY_REF)
    assert.equal(read[0].result.data, SECRET)
    assert.equal(read[0].result.complete, true)
    assert.doesNotMatch(modelText(run), /local_delivery_incomplete/u,
      'the authority\'s placeholder reached the model beside the bytes that replaced it')

    // The ticket and the delivery key are host state. Neither reaches the model, and neither
    // reaches the authority.
    assert.doesNotMatch(modelText(run), new RegExp(TICKET, 'u'), 'the delivery ticket reached the model')
    assert.doesNotMatch(modelText(run), new RegExp(MATERIALS_KEY, 'u'), 'the local delivery key reached the model')
    assert.doesNotMatch(JSON.stringify(run.toolCalls), new RegExp(`${MATERIALS_KEY}|MATERIAL-CONTENT-MARKER`, 'u'))

    const delivered = run.localEvents.filter((event) => event.type === 'material-read')
    assert.deepEqual(delivered.map((event) => [event.ref, event.complete]), [[GATEWAY_REF, true]])
  })
})

test('an Agent with no custodian does not negotiate, and takes the ordinary proxied path', async () => {
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4', RULITH_MATERIALS_DELIVER_URL: 'http://127.0.0.1:1/materials/deliver',
      RULITH_MATERIALS_KEY: MATERIALS_KEY, RULITH_MATERIALS_CONNECTION: '' },
    chatLines: ['Read that.'],
    gateway: defaultGateway({ artifacts: { [GATEWAY_REF]: { mediaType: 'text/plain', text: 'proxied bytes' } } }),
    model: (round) => (round === 1 ? callTool('ReadArtifact', { ref: GATEWAY_REF }) : 'Read.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const negotiations = run.requests.filter((entry) => entry.method === 'tools/call')
  assert.equal(negotiations[0].headers?.[LOCAL_DELIVERY_HEADER], undefined,
    'a host with no custodian negotiated a local delivery it could not complete')
  assert.equal(fragments(run).at(-1).result.data, 'proxied bytes')
})

test('maximum binary and escaped UTF-8 material windows reach the model through the MCP envelope', async () => {
  for (const encoding of ['base64', 'utf8']) {
    const bytes = Buffer.alloc(1_048_576, encoding === 'base64' ? 0xff : 0)
    const data = bytes.toString(encoding === 'base64' ? 'base64' : 'utf8')
    const run = await runAgent({ argv: [], env: { RULITH_MAX_ROUNDS: '4' }, chatLines: ['Read the whole window.'],
      tool: name => name === 'ReadArtifact' ? { accepted: true, result: {
        ref: GATEWAY_REF, mediaType: encoding === 'base64' ? 'application/octet-stream' : 'text/plain',
        encoding, data, offset: 0, nextOffset: null, totalBytes: bytes.length, complete: true, truncated: false,
      } } : undefined,
      model: round => round === 1 ? callTool('ReadArtifact', { ref: GATEWAY_REF, length: bytes.length }) : 'Read.',
    })
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(run.verbs, ['ReadArtifact'], 'a valid bounded result should not enter recovery')
    assert.ok(fragments(run).at(-1)?.result?.data === data, `${encoding} was truncated or refused`)
  }
})

test('a local delivery this host cannot complete is a visible refusal, never an empty success', async () => {
  for (const [label, answer, expected] of [
    ['the custodian refused', () => ({ status: 400, body: { ok: false, errorCode: 'local_ticket_expired', teaching: 'That ticket has expired.' } }), /local_ticket_expired/u],
    ['the custodian answered nothing usable', () => ({ status: 200, body: { ok: true, result: { ref: GATEWAY_REF } } }), /local_delivery_malformed/u],
    ['the custodian answered about another object', () => ({ status: 200, body: { ok: true, result: {
      ref: OTHER_REF, mediaType: 'text/plain', encoding: 'utf8', data: 'somebody else\'s',
      offset: 0, nextOffset: null, totalBytes: 15, complete: true, truncated: false } } }), /local_delivery_malformed/u],
  ]) {
    await withDeliveryEndpoint(async ({ env }) => {
      const run = await runAgent({
        argv: [], env: { RULITH_MAX_ROUNDS: '3', ...env },
        chatLines: ['Read that.'],
        gateway: defaultGateway(),
        tool: negotiated(),
        model: (round) => (round === 1 ? callTool('ReadArtifact', { ref: GATEWAY_REF }) : 'It was refused.'),
      })
      assert.equal(run.code, 0, `${label}: ${run.stdout}\n${run.stderr}`)
      const body = modelText(run)
      assert.match(body, expected, `${label}: the refusal did not reach the model by name`)
      assert.doesNotMatch(body, /MATERIAL-CONTENT-MARKER|somebody else/u, `${label}: content reached the model`)
      assert.doesNotMatch(body, new RegExp(`${TICKET}|${MATERIALS_KEY}`, 'u'), `${label}: host state reached the model`)
      assert.doesNotMatch(body, /"data":""/u, `${label}: an unreadable object was presented as an empty one`)
    }, { answer })
  }
})

test('a metadata block this host cannot act on is a refusal too, and nothing is invented', async () => {
  for (const [label, block] of [
    ['no ticket', { ticket: '' }],
    // A ticket is single use and the first claim spends it, so a value that cannot be one is
    // refused before it is carried anywhere — a guess must not cost somebody a real read handle.
    ['a ticket of another shape', { ticket: 'not-a-ticket' }],
    ['a ticket of the right prefix and the wrong length', { ticket: `mlt_${'A'.repeat(20)}` }],
    ['no reference', { ref: 'not-a-ref' }],
    ['a protocol this host does not speak', { protocol: 'rulith-local-delivery/2' }],
    // The claim happens at the authority on the route the contract names. A block naming another
    // one is not a redirection this host follows.
    ['a claim route this protocol does not fix', { claimPath: '/work/artifact/elsewhere' }],
  ]) {
    await withDeliveryEndpoint(async ({ claims, env }) => {
      const run = await runAgent({
        argv: [], env: { RULITH_MAX_ROUNDS: '3', ...env },
        chatLines: ['Read that.'],
        gateway: defaultGateway(),
        tool: negotiated(block),
        model: (round) => (round === 1 ? callTool('ReadArtifact', { ref: GATEWAY_REF }) : 'It was refused.'),
      })
      assert.equal(run.code, 0, `${label}: ${run.stdout}\n${run.stderr}`)
      assert.deepEqual(claims, [], `${label}: an unreadable block was still carried to the custodian`)
      assert.match(modelText(run), /local_delivery_malformed|local_delivery_protocol_unknown/u, label)
      assert.doesNotMatch(modelText(run), /MATERIAL-CONTENT-MARKER/u, `${label}: content reached the model`)
    }, { answer: () => ({ status: 500, body: { ok: false, errorCode: 'should_not_be_called' } }) })
  }
})

test('a failed local read never silently changes the next read to a proxy', async () => {
  await withDeliveryEndpoint(async ({ claims, env }) => {
    const run = await runAgent({
      argv: [], env: { RULITH_MAX_ROUNDS: '5', ...env },
      chatLines: ['Read that.'],
      gateway: defaultGateway({ artifacts: { [GATEWAY_REF]: { mediaType: 'text/plain', text: 'proxied after all' } } }),
      tool: negotiated(),
      model: (round) => (round <= 2 ? callTool('ReadArtifact', { ref: GATEWAY_REF }) : 'Read.'),
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)

    const calls = run.requests.filter((entry) => entry.method === 'tools/call')
    assert.equal(calls.length, 2, `the model did not read twice: ${run.verbs.join(', ')}`)
    assert.equal(calls[0].headers?.[LOCAL_DELIVERY_HEADER], 'rulith-local-delivery/1',
      'the first read did not negotiate local delivery (calibration)')
    assert.equal(calls[1].headers?.[LOCAL_DELIVERY_HEADER], 'rulith-local-delivery/1')

    assert.equal(claims.length, 2)
    assert.equal(fragments(run).at(-1).errorCode, 'local_ticket_expired')
    assert.doesNotMatch(modelText(run), /proxied after all/)
    assert.match(run.stdout, /Local delivery of art_[0-9a-f]{32} was refused \(local_ticket_expired\)/u)
  }, { answer: () => ({ status: 400, body: { ok: false, errorCode: 'local_ticket_expired', teaching: 'gone' } }) })
})

test('an earlier locally delivered read keeps its handoff identity and receives the actual bytes', async () => {
  await withDeliveryEndpoint(async ({env,claims}) => {
    const response=negotiated()('ReadArtifact',{ref:GATEWAY_REF})
    const run=await runAgent({argv:[],env:{RULITH_MAX_ROUNDS:'4',...env},chatLines:['Continue.'],
      gateway:defaultGateway(),handoff:{tool:'ReadArtifact',callRef:'call-9',result:response.__core,
        localDelivery:response.__meta['rulith/local-delivery/v1']},
      model:round=>round===1?callTool('QueryBoard',{}):'Received earlier material.'})
    assert.equal(run.code,0,run.stdout+'\n'+run.stderr)
    assert.equal(claims.length,1)
    const read=fragments(run).at(-1)
    assert.equal(read.requestExecuted,false)
    assert.equal(read.handedOverFrom,'ReadArtifact')
    assert.equal(read.earlierResult.accepted,true)
    assert.equal(read.earlierResult.result.data,SECRET)
    assert.doesNotMatch(modelText(run),new RegExp(TICKET))
    assert.equal(run.requests.find(row=>row.method==='tools/call').headers[LOCAL_DELIVERY_HEADER],'rulith-local-delivery/1')
  })
})
