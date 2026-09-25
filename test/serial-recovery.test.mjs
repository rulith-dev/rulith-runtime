// SPDX-License-Identifier: Apache-2.0
/**
 * One call at a time, and the authority decides when the last one is over.
 *
 * While a call is unresolved this Agent runs no model turn and sends no business tool call.
 * It waits on the authority's recovery state through `ping`; `ReadOperation` is the separate
 * public read that can collect a ready original result without occupying the business slot.
 *
 * The arms below spawn the real Agent against a scripted endpoint and assert on what
 * reached the wire and what reached the model. A host that "knew" the right answer and
 * carried on regardless would satisfy nothing here: the observable is the absence of calls
 * and the absence of model turns.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { HOP_FAILURE, callTool, runAgent } from './support/agent-harness.mjs'

test('RT-REC-2 a waiting call is waited for, and the model is not asked in the meantime', async () => {
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '10000' },
    chatLines: ['Carry on.'],
    captureLocalEvents: true,
    // Still executing for the first two reads, then finished with nothing to hand over.
    recovery: ({ pings }) => (pings < 2
      ? { state: 'waiting', callRef: 'call-9', tool: 'ApplyAction', retryAfterMs: 150 }
      : { state: 'none' }),
    model: () => 'Nothing further is needed.',
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.pings >= 2, `the host stopped asking before the call settled: ${run.pings} ping(s)`)
  assert.deepEqual(run.verbs, [], `a tool call went out while an earlier call was executing: ${run.verbs.join(', ')}`)
  assert.equal(run.modelRequests.length, 1, 'the model was asked while the earlier call was still executing')
  assert.match(run.stdout, /still executing at the authority/)
  assert.match(run.stdout, /the model is not being asked anything/)
  const waiting = run.localEvents.find((event) => event.type === 'recovery' && event.state === 'waiting')
  assert.equal(waiting?.tool, 'ApplyAction', 'the waiting state was not reported to the local view')
})

test('RT-REC-3 a call needing operator reconciliation stops the turn instead of guessing', async () => {
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '5000' },
    chatLines: ['Carry on.'],
    captureLocalEvents: true,
    recovery: { state: 'reconciliation_required', callRef: 'call-9', tool: 'ApplyAction',
      teaching: 'The Worker was lost while the Action was in flight.' },
    model: () => 'The model should never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, [], `work continued past a call that needs reconciliation: ${run.verbs.join(', ')}`)
  assert.equal(run.modelRequests.length, 0,
    'the model was asked to decide something while an unreconciled call was outstanding')
  assert.match(run.stdout, /needs operator reconciliation/)
  assert.match(run.stdout, /The Worker was lost while the Action was in flight/)
  assert.match(run.stdout, /Automatic recovery has stopped/)
  // The unknown stays unknown. Waiting does not undo an effect that may have happened.
  assert.match(run.stdout, /not cancelled by waiting/)
  assert.ok(run.localEvents.some((event) => event.type === 'blocked' && event.reason === 'reconciliation_required'))
})

test('RT-REC-4 a recovery state this host cannot read blocks rather than reading as "nothing outstanding"', async () => {
  // The dangerous default. An unrecognised state read as `none` would let a host with an
  // unresolved call carry on as though there were none — the exact defect the gate prevents.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '2000' },
    chatLines: ['Carry on.'],
    recovery: { state: 'partially_settled', callRef: 'call-9' },
    model: () => 'The model should never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, [])
  assert.equal(run.modelRequests.length, 0)
  assert.match(run.stdout, /recovery state "partially_settled", which this Runtime does not understand/)
  assert.match(run.stdout, /will not proceed while it cannot tell whether a call is outstanding/)
})

test('RT-REC-5 nothing outstanding costs nothing: no ping, no read, no Board call', async () => {
  // The gate must not become a tax on ordinary conversation. The handshake already published
  // the recovery state, so a host that knows there is nothing outstanding asks again for
  // nothing — and a greeting still crosses the handshake and stops there.
  const run = await runAgent({
    argv: [], chatLines: ['hello'],
    recovery: { state: 'none' },
    model: () => 'Hello.',
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.methods, ['initialize', 'notifications/initialized', 'tools/list'],
    `an ordinary greeting cost more than the handshake: ${run.methods.join(', ')}`)
  assert.equal(run.pings, 0, 'the host polled for a recovery state the handshake had already given it')
  assert.deepEqual(run.verbs, [])
})

test('RT-REC-10 a `--case` focus whose outcome is unknown holds the Agent like any other call', async () => {
  // `--case` and the Local UI reach the same public `OpenCase` over the same connection, so
  // a focus request that ends unresolved holds the gate. The defect this replaces let the
  // turn continue straight into a model round and a further tool call.
  const run = await runAgent({
    argv: ['--case', 'CASE_X'], env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '600' },
    chatLines: ['Carry on with that Case.'],
    captureLocalEvents: true,
    tool: (name) => (name === 'OpenCase' ? HOP_FAILURE : undefined),
    recovery: ({ pings }) => (pings === 0
      ? { state: 'none' }
      : { state: 'waiting', callRef: 'call-1', tool: 'OpenCase', retryAfterMs: 150 }),
    model: () => callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] }),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const sent = run.requests.filter((request) => request.method === 'tools/call')
  assert.equal(sent.length, 1, `work continued past an unresolved focus request: ${run.verbs.join(', ')}`)
  assert.equal(run.modelRequests.length, 0,
    'the model was asked to work while the host feature\'s own call was unresolved')
  assert.match(run.stdout, /still executing at the authority/)
})

test('RT-REC-11 the shadow reviewer does not write after the turn was stopped', async () => {
  // `--shadow` asserts a finding on the Board. After a blocked turn the host has just said
  // that no further call will be sent, so sending one is the host contradicting itself —
  // and a write issued past the gate is a write issued past the gate, whoever proposed it.
  const run = await runAgent({
    argv: ['Do the governed work', '--shadow'],
    env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '500' },
    captureLocalEvents: true,
    tool: (name) => (name === 'ApplyAction' ? HOP_FAILURE : undefined),
    recovery: ({ pings }) => (pings === 0
      ? { state: 'none' }
      : { state: 'reconciliation_required', callRef: 'call-1', tool: 'ApplyAction', teaching: 'The Worker was lost.' }),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyAction', { action: 'demo.ship' })
      return 'Stopping.'
    },
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase', 'ApplyAction'],
    `a call went out after the turn was stopped: ${run.verbs.join(', ')}`)
  assert.equal(run.toolCalls.some((call) => call.name === 'ApplyBatch'), false,
    'the shadow reviewer wrote a finding after the host had said nothing further would be sent')
  assert.match(run.stdout, /needs operator reconciliation/)
})

test('RT-REC-12 an endpoint that publishes no recovery record is refused, not read as idle', async () => {
  // The record is required. Absence is not `none`: `none` is the authority saying there is
  // nothing outstanding, and absence is this host having no idea — which is the same
  // position as an unreadable state, and gets the same answer.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '900' },
    chatLines: ['Open a Case.'],
    recovery: null,
    model: () => 'The model should never be asked.',
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, [], `work began against an endpoint that never said what was outstanding: ${run.verbs.join(', ')}`)
  assert.equal(run.modelRequests.length, 0)
  assert.match(run.stdout, /published no recovery record/)
  assert.match(run.stdout, /will not proceed while it cannot tell whether a call is outstanding/)
  assert.ok(run.pings >= 1, 'the host did not even ask; it should ask once and then refuse')
})

test('RT-REC-17 an unknown outcome is not sold to the model as a de-duplicated retry', async () => {
  // The teaching used to promise that choosing the same step again "reaches that same
  // identity rather than becoming a second command". Since the transport key includes the
  // session and every submission mints a fresh id, that promise was false — and it is
  // exactly the claim §5.2 forbids a host from making about a model's new intent.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '600' },
    chatLines: ['Record a fact.'], captureLocalEvents: true,
    tool: (name) => (name === 'ApplyBatch' ? HOP_FAILURE : undefined),
    recovery: { state: 'none' },
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'Understood.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch').at(-1)
  assert.match(verdict.teaching, /outcome of this step is unknown/)
  assert.match(verdict.teaching, /keeps its identity \*\*at the authority\*\*/)
  assert.match(verdict.teaching, /Anything you choose next is a new command/)
  assert.doesNotMatch(verdict.teaching, /reaches that same identity/,
    'the host still promises a de-duplication it cannot perform')
  assert.doesNotMatch(verdict.teaching, /rather than becoming a second command/)
})
