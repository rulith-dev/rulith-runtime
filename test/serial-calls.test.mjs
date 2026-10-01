// SPDX-License-Identifier: Apache-2.0
/**
 * One call at a time, and the authority decides when the last one is over.
 *
 * Nothing is settled on this host before the model is asked: a call still in progress is the
 * authority's to finish, it shows on the strip of the next result, and the authority's write
 * gate keeps another write from running meanwhile. What this host owns is narrower — it waits
 * for a call the authority answered `running`, it sends nothing the model chose before seeing
 * an answer it had to read, and it never re-sends a call whose answer was lost.
 *
 * The arms below spawn the real Agent against a scripted endpoint and assert on what reached
 * the wire and what reached the model.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HOP_FAILURE, TEST_TOKEN, callTool, defaultGateway, freePort, runAgent } from './support/agent-harness.mjs'

test('RT-REC-5 nothing outstanding costs nothing: no ping, no read, no Board call', async () => {
  // The strip must not become a tax on ordinary conversation. The handshake already showed the
  // Agent's operations, and a greeting crosses the handshake and stops there.
  const run = await runAgent({
    argv: [], chatLines: ['hello'],
    model: () => 'Hello.',
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.methods, ['initialize', 'notifications/initialized', 'tools/list'],
    `an ordinary greeting cost more than the handshake: ${run.methods.join(', ')}`)
  assert.equal(run.pings, 0)
  assert.deepEqual(run.verbs, [])
})

test('RT-REC-5b an operation a previous client left running costs a greeting nothing either', async () => {
  // It is named at startup from the strip initialize carried, and nothing is waited for or
  // asked: the model will find it in the strip of its next result.
  const run = await runAgent({
    argv: [], chatLines: ['hello'],
    priorOperations: [{ tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'running', stage: 'at_worker' }],
    model: () => 'Hello.',
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /ApplyAction demo\.ship is still running at the authority/)
  assert.deepEqual(run.methods, ['initialize', 'notifications/initialized', 'tools/list'])
  assert.equal(run.modelRequests.length, 1)
})

test('RT-REC-10 a `--case` focus whose answer is lost is said so, and not sent again', async () => {
  // `--case` and the Local UI reach the same public `OpenCase` over the same connection, so a
  // focus request whose answer never arrived is a transport failure like any other: named to
  // the model, never re-sent, and never claimed as focus.
  const run = await runAgent({
    argv: ['--case', 'CASE_X'], env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Carry on with that Case.'],
    captureLocalEvents: true,
    tool: (name) => (name === 'OpenCase' ? HOP_FAILURE : undefined),
    model: () => 'I could not confirm that Case.',
    timeoutMs: 25_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const sent = run.requests.filter((request) => request.method === 'tools/call')
  assert.equal(sent.length, 1, `the focus request was sent again: ${run.verbs.join(', ')}`)
  const told = JSON.stringify(run.modelRequests[0].messages)
  assert.match(told, /could not be brought into focus/)
  assert.match(told, /may or may not have run/)
  assert.match(told, /do not claim that Case is active/)
  assert.doesNotMatch(run.stdout, /Case "CASE_X" is in focus/)
})

test('RT-REC-11 the shadow reviewer does not write while an operation is unresolved', async () => {
  // `--shadow` asserts a finding on the Board. While an operation still keeps the execution
  // slot, the authority would refuse the write, and sending it anyway is this host proposing
  // work it knows cannot run.
  const run = await runAgent({
    argv: ['Do the governed work', '--shadow'],
    env: { RULITH_MAX_ROUNDS: '4' },
    captureLocalEvents: true,
    hold: (name) => (name === 'ApplyAction' ? { answer: 'needs_person' } : undefined),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyAction', { action: 'demo.ship', args: {} })
      return 'Stopping.'
    },
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.toolCalls.some((call) => call.name === 'ApplyBatch'), false,
    'the shadow reviewer wrote a finding while an operation needed reconciliation')
  assert.match(run.stdout, /ApplyAction is waiting for a person to reconcile it in Console/)
})

test('RT-REC-11b with nothing unresolved the shadow reviewer does write (calibration)', async () => {
  const run = await runAgent({
    argv: ['Do the governed work', '--shadow'],
    env: { RULITH_MAX_ROUNDS: '4', RULITH_SHADOW_MODEL: 'shadow-model' },
    model: (round, body) => (body.model === 'shadow-model' ? 'FINDING: the total is unsupported'
      : round === 1 ? callTool('OpenCase', {}) : 'Stopping.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.toolCalls.some((call) => call.name === 'ApplyBatch'), true, 'the shadow finding was never written')
})

test('RT-REC-17 a lost answer is not sold to the model as a de-duplicated retry', async () => {
  // The teaching used to promise that choosing the same step again "reaches that same
  // identity rather than becoming a second command". Since the transport key includes the
  // session and every submission mints a fresh id, that promise was false. What protects a
  // write now is the authority's gate, and the model is told to look before it decides.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3' },
    chatLines: ['Record a fact.'], captureLocalEvents: true,
    tool: (name) => (name === 'ApplyBatch' ? HOP_FAILURE : undefined),
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'Understood.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch').at(-1)
  assert.match(verdict.teaching, /transport failure, not the Board's answer/)
  assert.match(verdict.teaching, /Look there before you decide; do not repeat the call blindly/)
  assert.doesNotMatch(verdict.teaching, /reaches that same identity|rather than becoming a second command/,
    'the host still promises a de-duplication it cannot perform')
  assert.doesNotMatch(verdict.teaching, /\bunknown\b/i, 'a transport failure was taught as the unknown outcome')
})

test('RT-REC-5c a turn that ends in text after a write acknowledges its result with one ping on the same session', async () => {
  // The authority counts a delivered result as acknowledged once its session makes another
  // request. A turn that ends in text makes none; without a ping the result would stay
  // unacknowledged, and after a restart the next write would be refused with it.
  const run = await runAgent({
    argv: [], chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opened.'),
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.pings, 1, `the model's result was left unacknowledged, or acknowledged more than once: ${run.pings}`)
  const call = run.requests.find((request) => request.method === 'tools/call')
  const ping = run.requests.find((request) => request.method === 'ping')
  assert.equal(ping.sessionId, call.sessionId, 'the acknowledgement went to a session the result was never written to')
  assert.ok(run.requests.indexOf(ping) > run.requests.indexOf(call))
  // After the model has *read* the result: a ping sent as the result came back, or while it was
  // only queued for the model, acknowledges a result no model has seen yet.
  const pinged = run.order.findIndex((step) => step.kind === 'mcp' && step.method === 'ping')
  const read = run.order.findIndex((step) => step.kind === 'model' && step.n === 2)
  assert.ok(read >= 0 && pinged > read, `the ping came before the model read the result: ${JSON.stringify(run.order)}`)
  assert.equal(run.operations.find((op) => op.tool === 'OpenCase').acked, true)
})

test('RT-REC-5d a turn cut off at its round limit does not acknowledge the result it never showed the model', async () => {
  // The round limit ends the turn right after a write: its result is in the transcript, but no
  // model has read it. Nothing may count it as read — the model reads it in the next turn.
  const run = await runAgent({
    argv: [], chatLines: ['Open a Case.'], env: { RULITH_MAX_ROUNDS: '1' },
    model: () => callTool('OpenCase', {}),
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Stopped at the 1-round limit/)
  assert.equal(run.pings, 0, 'a ping acknowledged a result the model never read')
  assert.equal(run.operations.find((op) => op.tool === 'OpenCase').acked, false)
})

/** The strip a host notice showed the model, parsed from the text of a user message. */
const relayedStrip = (text) => {
  const marker = 'Read it before you decide:\n'
  const at = text.indexOf(marker)
  return at < 0 ? undefined : JSON.parse(text.slice(at + marker.length).split('\n')[0]).operations
}

test('RT-REC-12 a Case focus refused with an earlier outcome shows the model that outcome before it decides anything', async () => {
  // An earlier write's answer never reached this client. The operator's Case selection is this
  // host's own OpenCase, and the write gate refuses it with that earlier result — delivering it
  // to this session, after which the model's next write would run. So the model is shown that
  // result, verbatim, in the message it reads first; and the focus, asked for once more, runs.
  const earlier = { accepted: true, result: { action: 'demo.ship', done: true, ok: true, status: 'confirmed' } }
  const run = await runAgent({
    argv: ['--case', 'CASE_X'], env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Carry on with that Case.'], captureLocalEvents: true,
    gateway: defaultGateway({ cases: [{ caseId: 'CASE_X', root: 'ROOT_X' }], queryIndependent: true }),
    priorOperations: [{ tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'done', core: earlier }],
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'Recorded, after reading the earlier shipment.'),
    timeoutMs: 25_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase', 'OpenCase', 'ApplyBatch'], 'the focus was not asked for once more, or was asked too often')
  const [first] = run.modelRequests[0].messages.filter((message) => message.role === 'user')
  const text = String(first.content)
  assert.match(text, /This Agent's recent operations, as the authority showed them to this Runtime while it brought Case "CASE_X" into focus/)
  assert.match(text, /not a call you made and not the user's words/)
  const shown = relayedStrip(text)?.find((entry) => entry.label === 'ApplyAction demo.ship')
  assert.equal(JSON.parse(shown.result.content[0].text).result.status, 'confirmed', 'the earlier outcome was not shown in full')
  // Shown once, in that first message, and not as a tool result of the model's own.
  assert.equal(run.modelRequests[0].messages.filter((message) => message.role === 'tool').length, 0)
  const notices = run.modelRequests[1].messages.filter((message) => message.role === 'user'
    && relayedStrip(String(message.content)) !== undefined)
  assert.equal(notices.length, 1)
  // The focus ran on the second request, and the model's write after it.
  assert.match(run.stdout, /Case "CASE_X" is in focus for this conversation/)
  assert.equal(run.operations.find((op) => op.tool === 'ApplyBatch')?.state, 'done')
})

test('RT-REC-11c the shadow reviewer does not write after a call of the turn lost its answer', async () => {
  // Its write would be judged — and could be refused carrying an outcome — while the model has
  // not read what became of its own call.
  const run = await runAgent({
    argv: ['Do the governed work', '--shadow'],
    env: { RULITH_MAX_ROUNDS: '4', RULITH_SHADOW_MODEL: 'shadow-model' },
    tool: (name) => (name === 'ApplyBatch' ? HOP_FAILURE : undefined),
    model: (round, body) => (body.model === 'shadow-model' ? 'FINDING: the total is unsupported'
      : round === 1 ? callTool('OpenCase', {})
        : round === 2 ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
          : 'Stopping.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.toolCalls.filter((call) => call.name === 'ApplyBatch').length, 1,
    'the shadow reviewer wrote after a call of the turn lost its answer')
})

test('RT-REC-11d the shadow reviewer does not write when the turn ended with results the model never read', async () => {
  // The round limit cut the turn right after a call: its result was never shown to the model,
  // and a shadow write on the same session would acknowledge it.
  const run = await runAgent({
    argv: ['Do the governed work', '--shadow'],
    env: { RULITH_MAX_ROUNDS: '2', RULITH_SHADOW_MODEL: 'shadow-model' },
    model: (round, body) => (body.model === 'shadow-model' ? 'FINDING: the total is unsupported'
      : round === 1 ? callTool('OpenCase', {}) : callTool('ApplyAction', { action: 'demo.ship', args: {} })),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Stopped at the 2-round limit/)
  assert.equal(run.toolCalls.some((call) => call.name === 'ApplyBatch'), false,
    'the shadow reviewer wrote while a result was still unread')
})

for (const readable of [true, false]) {
  test(`RT-REC-18 a record Runtime 0.9 left is named once, and the strip is said to show only what it lists${readable ? ''
    : ', which is nothing when initialize carried none'}`, async () => {
    // The strip lists the latest operations, any still in progress and the latest settled write —
    // not every call. And a strip initialize did not carry says nothing about that call either way.
    const dir = mkdtempSync(join(tmpdir(), 'rulith-legacy-record-'))
    const store = join(dir, 'agent-sessions.json')
    const listenPort = await freePort()
    const endpoint = `http://127.0.0.1:${listenPort}#${createHash('sha256').update(TEST_TOKEN, 'utf8').digest('hex').slice(0, 16)}`
    writeFileSync(store, JSON.stringify({ schema: 'rulith-agent-sessions/1',
      endpoints: { [endpoint]: { unresolved: { requestId: 'req-legacy-1', tool: 'ApplyAction' } } } }))
    try {
      const run = await runAgent({
        argv: [], sessionFile: store, listenPort, chatLines: ['hello'], model: () => 'Hello.',
        ...(readable ? {} : { omitStrip: (method) => method === 'initialize' }),
        timeoutMs: 20_000,
      })
      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
      assert.match(run.stderr, /Runtime 0\.9 recorded an ApplyAction call from a previous run whose answer it never received/)
      assert.match(run.stderr, /lists this Agent's latest operations, any still in progress and the latest settled write/)
      assert.doesNotMatch(run.stderr, /shows every call/)
      if (readable) {
        assert.match(run.stderr, /The strip shows no operation still in progress\./)
      } else {
        assert.match(run.stderr, /The initialize answer carried no readable recent-operations strip/)
        assert.doesNotMatch(run.stderr, /The strip shows no operation still in progress/,
          'a strip initialize never carried was said to show nothing in progress')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
