// SPDX-License-Identifier: Apache-2.0
/**
 * One call at a time, and the authority decides when the last one is over.
 *
 * While a call is unresolved this Agent runs no model turn and sends no tool call — not a
 * write, not `QueryBoard`, not `ReadArtifact`. That rule is only worth anything if the host
 * can find out what "unresolved" means without asking the model to help, so the state comes
 * from the authority over the base protocol's own `ping`, whose empty result carries the
 * recovery record. Four states, four mechanical answers, and no seventh tool.
 *
 * The arms below spawn the real Agent against a scripted endpoint and assert on what
 * reached the wire and what reached the model. A host that "knew" the right answer and
 * carried on regardless would satisfy nothing here: the observable is the absence of calls
 * and the absence of model turns.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'

import { HOP_FAILURE, callTool, runAgent } from './support/agent-harness.mjs'

/** The Board result an earlier, already-determined call produced. */
const EARLIER_RESULT = {
  accepted: true,
  revision: 'r7',
  payload: {
    roots: [{ caseId: 'CASE_OLD', root: 'ROOT_OLD', status: 'running' }],
    cases: { directory: [{ caseId: 'CASE_OLD', root: 'ROOT_OLD', status: 'running' }], total: 1 },
    gaps: [], nodes: [], actions: [],
  },
}

test('RT-REC-1 a determined result is handed over before the model is asked anything', async () => {
  // The takeover case: a previous client dispatched an Action, the authority determined its
  // outcome, and nobody has collected it. This host collects it with exactly one claim —
  // which executes nothing — and puts the outcome in front of the model as its own to judge.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3' },
    chatLines: ['Carry on with the work.'],
    captureLocalEvents: true,
    recovery: ({ handoffsDelivered }) => (handoffsDelivered === 0
      ? { state: 'result_ready', callRef: 'call-9', tool: 'ApplyAction' }
      : { state: 'none' }),
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT },
    model: () => 'The earlier Action landed; nothing further is needed.',
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)

  // One claim, and it is a tool call like any other — no recovery-only tool was invented.
  assert.deepEqual(run.verbs, ['QueryBoard'], `the handoff cost more than one claim: ${run.verbs.join(', ')}`)
  assert.deepEqual(run.toolCalls[0].args, {}, 'the claim must be the safe default, not a query of its own')
  assert.ok(run.pings >= 1, 'the recovery state was never read')

  // The model was asked once, after the outcome was in hand.
  assert.equal(run.modelRequests.length, 1)
  const messages = run.modelRequests[0].messages
  const note = messages.find((message) => String(message.content ?? '').includes('[Host recovery'))
  assert.ok(note, `the recovered outcome never reached the model: ${JSON.stringify(messages)}`)
  assert.equal(note.role, 'user', 'a host-recovery note must not be dressed up as something the model said')
  assert.match(note.content, /executed nothing/)
  assert.match(note.content, /earlier ApplyAction call/)
  assert.match(note.content, /"revision":"r7"/, 'the outcome itself must travel, not a summary of it')

  // And it is not attributed to the model. Forging an assistant tool_call for a call the
  // model never made would invite it to "continue" a step it never chose.
  const forged = messages.filter((message) => message.role === 'assistant' && message.tool_calls !== undefined)
  assert.deepEqual(forged, [], `the host forged an assistant tool call: ${JSON.stringify(forged)}`)
  assert.equal(messages.some((message) => message.role === 'tool'), false,
    'the handoff was presented as a tool result for a call this model never made')

  // The handed-over Board data belongs to the earlier call and to the moment it ran, so it
  // does not become this conversation's focus or its current view.
  const focus = run.localEvents.filter((event) => event.type === 'focus')
  assert.equal(focus.some((event) => JSON.stringify(event.roots).includes('CASE_OLD')), false,
    'old data became the current focus')
  assert.doesNotMatch(run.stdout, /Case Context in focus/)
  assert.match(run.stdout, /Recovered the outcome of an earlier ApplyAction call/)
})

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

test('RT-REC-6 an unresolved call is settled before the next turn, not carried into it', async () => {
  // Across turns, not just within one: the first message leaves a call whose outcome this
  // host never learned, and the second message must not start until that is settled.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '2', RULITH_RECOVERY_WAIT_MS: '8000' },
    chatLines: ['Record a fact.', 'Now tell me where that got to.'],
    recovery: ({ toolCalls, handoffsDelivered }) => {
      if (toolCalls === 0) return { state: 'none' }
      return handoffsDelivered === 0
        ? { state: 'result_ready', callRef: 'call-1', tool: 'ApplyBatch' }
        : { state: 'none' }
    },
    // `afterCall: 1` is what makes this a handoff of the *earlier* call rather than an
    // answer to the write itself: the write is the call whose outcome went missing.
    handoff: { tool: 'ApplyBatch', callRef: 'call-1', result: EARLIER_RESULT, afterCall: 1 },
    breakStreamOnCall: 1, sseResults: true, refuseResume: true,
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'Understood.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  // The write went once. Everything after it is recovery: one claim, and no second write.
  assert.deepEqual(run.verbs, ['ApplyBatch', 'QueryBoard'],
    `the unresolved write was re-issued or the queue kept running: ${run.verbs.join(', ')}`)
  const transcripts = run.modelRequests.map((request) => JSON.stringify(request.messages))
  assert.ok(transcripts.some((transcript) => transcript.includes('[Host recovery')),
    'the outcome of the unresolved write never reached the model')
  assert.match(run.stdout, /Recovered the outcome of an earlier ApplyBatch call/)
  // And the submission this host was holding open is closed by the handover. Left open, it
  // would be reported at the next startup as an unknown outcome that is no longer unknown.
  assert.doesNotMatch(run.stderr, /have an unknown outcome/)
})

// ── The model's own request, answered as a handoff ───────────────────────────

test('RT-REC-7 a handoff of the model\'s own request is not passed off as that request succeeding', async () => {
  // The regression this exists for: the Gateway answered a real `ApplyBatch` with the
  // *earlier* `ApplyAction`'s public result, and the host handed that JSON back as the
  // ApplyBatch's own tool result. `accepted: true` belonged to a call from another turn, so
  // the model concluded its write had landed when the write had never run — with no log
  // line, no event and no marker anywhere in what the model could see.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Record a fact.'],
    captureLocalEvents: true,
    // The authority reports nothing outstanding, and hands the earlier outcome over at the
    // first new request anyway — §5.2's normal path, and the case where the old defect bit:
    // the host had no warning, so it had to read the answer it was actually given.
    recovery: { state: 'none' },
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT },
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'The write did not run; I will decide again.'),
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)

  // Whatever the host does with it, the model must not read it as its own write succeeding.
  const results = run.modelRequests.at(-1).messages.filter((message) => message.role === 'tool')
  assert.ok(results.length >= 1, 'the model got no result at all for the request it made')
  const answered = JSON.parse(results.at(-1).content)
  assert.equal(answered.accepted, false, 'an earlier call\'s acceptance was reported as this write\'s')
  assert.equal(answered.requestExecuted, false)
  assert.equal(answered.errorCode, 'request_not_executed')
  assert.equal(answered.handedOverFrom, 'ApplyAction', 'the model was not told whose outcome it is holding')
  assert.match(answered.teaching, /ApplyBatch was not executed/)
  assert.match(answered.teaching, /decide again/)
  // The earlier outcome still travels, whole, as data under a name that says whose it is.
  assert.equal(answered.earlierResult.revision, 'r7')
  assert.equal(answered.earlierResult.accepted, true)
  // And it is visible outside the model too, rather than living only in `_meta`.
  assert.match(run.stdout, /ApplyBatch was not executed/)
  assert.ok(run.localEvents.some((event) => event.type === 'handoff' && event.tool === 'ApplyAction'))
})

test('RT-REC-8 a handoff marker without isError is an unknown outcome, not a delivery', async () => {
  // The two channels have to agree. A metadata marker saying "your request did not run"
  // on a result the protocol says was served is a server contradicting itself, and picking
  // either side would be this host inventing the answer.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '600' },
    chatLines: ['Record a fact.'], captureLocalEvents: true,
    recovery: ({ pings }) => (pings === 0 ? { state: 'none' } : { state: 'none' }),
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT, withoutIsError: true },
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'That was not a usable answer.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch').at(-1)
  assert.match(verdict.teaching, /handoff marker but was not marked as an error result/)
  assert.match(verdict.teaching, /whether it executed is not known/)
  // Unknown means unknown: the earlier result is not adopted as this call's answer.
  assert.equal(verdict.accepted, false)
  assert.doesNotMatch(run.stdout, /Recovered the outcome/)
})

// ── The claim has an identity of its own ─────────────────────────────────────

test('RT-REC-9 the mechanical claim never borrows the identity of a model QueryBoard', async () => {
  // The claim is a `QueryBoard` with the safe default — byte for byte what the model sends
  // when it wants the Case directory. A body-derived identity made the two collide: the
  // claim inherited the in-flight request id, the authority answered it as a re-send of
  // that call, and the handoff never happened.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '4000' },
    chatLines: ['Look at the Board.'],
    captureLocalEvents: true,
    tool: (name) => (name === 'QueryBoard' ? HOP_FAILURE : undefined),
    recovery: ({ pings }) => (pings === 0
      ? { state: 'none' }
      : { state: 'result_ready', callRef: 'call-1', tool: 'QueryBoard' }),
    handoff: { tool: 'QueryBoard', callRef: 'call-1', result: EARLIER_RESULT, afterCall: 1 },
    model: (round) => (round === 1 ? callTool('QueryBoard', {}) : 'I have the earlier answer.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const queries = run.toolCalls.filter((call) => call.name === 'QueryBoard')
  assert.equal(queries.length, 2, `expected the model's query and one claim: ${run.verbs.join(', ')}`)
  assert.deepEqual(queries[0].args, queries[1].args, 'the claim is the same safe default, byte for byte')
  assert.notEqual(queries[0].id, queries[1].id,
    'the claim went out under the unresolved call\'s own request id, so the authority answered it as a re-send')
  assert.match(run.stdout, /Recovered the outcome of an earlier QueryBoard call/)
})

// ── Host features are not exemptions ─────────────────────────────────────────

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

test('RT-REC-13 a handoff stops the rest of the turn instead of running proposals made blind', async () => {
  // The model proposed three steps against a Board it turned out to be wrong about: the
  // first did not run at all, and what came back belongs to an earlier call. Carrying on
  // with the other two would execute decisions taken before the model saw any of that —
  // and would do it while the model has had no chance to reconsider.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3' },
    chatLines: ['Do all three steps.'], captureLocalEvents: true,
    recovery: { state: 'none' },
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT },
    model: (round) => (round === 1
      ? {
          text: '',
          toolCalls: [
            { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] } },
            { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'F2', predicate: 'y', args: {} }] } },
            { name: 'QueryBoard', input: {} },
          ],
        }
      : 'I see: the write never ran. I will decide again.'),
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch'],
    `proposals made before the handoff were executed anyway: ${run.verbs.join(', ')}`)
  const suspension = run.localEvents.find((event) => event.type === 'queue-suspended')
  assert.equal(suspension?.notSent, 2)
  // The unsent calls are answered, honestly, rather than dropped.
  const results = run.modelRequests.at(-1).messages.filter((message) => message.role === 'tool')
  const unsent = results.map((message) => JSON.parse(message.content)).filter((value) => value.errorCode === 'call_queue_suspended')
  assert.equal(unsent.length, 2, 'a proposal the host declined to carry was dropped rather than answered')
  assert.match(unsent[0].teaching, /handing back an earlier result instead of/)
  // And the model is asked again, with the earlier outcome in hand.
  assert.equal(run.modelRequests.length, 2)
})

// ── The handoff envelope is the result, not just the text ────────────────────

test('RT-REC-14 a `--case` focus answered with a handoff claims no focus and hands the outcome over', async () => {
  // `--case CASE_X` sends `OpenCase({caseId})`, which is exactly §5.2's "first new tool
  // request" — so the authority may answer it by handing back an earlier call's outcome.
  // The regression this arm exists for: only the model-facing `text` was rewritten, so
  // `result` still carried the earlier call's `accepted: true`, and this path read it and
  // announced a focus that had not happened while dropping the outcome on the floor.
  const run = await runAgent({
    argv: ['--case', 'CASE_X'], env: { RULITH_MAX_ROUNDS: '3' },
    chatLines: ['Carry on with that Case.'],
    captureLocalEvents: true,
    recovery: { state: 'none' },
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT },
    model: () => 'The Action landed and the Case was not focused; I will decide again.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)

  // One OpenCase, and it is not re-sent after the handoff.
  assert.deepEqual(run.verbs, ['OpenCase'], `the focus request was replayed: ${run.verbs.join(', ')}`)
  // Nothing claims the Case is in focus — not the terminal, not the local view.
  assert.doesNotMatch(run.stdout, /is in focus for this conversation/)
  assert.equal(run.localEvents.some((event) => event.type === 'case-open'), false,
    'a Case was announced as opened by a request that never ran')
  const focus = run.localEvents.filter((event) => event.type === 'focus')
  assert.equal(focus.some((event) => (event.roots ?? []).length > 0), false,
    'an unexecuted focus request produced a focused root')
  assert.match(run.stdout, /was not brought into focus/)

  // And the earlier outcome reaches the model, labelled, rather than being discarded.
  const messages = run.modelRequests.at(-1).messages
  const note = messages.find((message) => String(message.content ?? '').includes('[Host recovery'))
  assert.ok(note, `the handed-over outcome never reached the model: ${JSON.stringify(messages).slice(0, 400)}`)
  assert.match(note.content, /earlier ApplyAction call/)
  assert.match(note.content, /"revision":"r7"/)
  assert.ok(run.localEvents.some((event) => event.type === 'handoff' && event.insteadOf === 'OpenCase'))
})

test('RT-REC-15 a shadow finding answered with a handoff is not reported as written', async () => {
  // The shadow reviewer judged by `result.accepted` too. With the earlier call's verdict
  // still in `result`, a finding that never reached the Board read as one that had.
  const run = await runAgent({
    argv: ['Do the governed work', '--shadow'],
    env: { RULITH_MAX_ROUNDS: '4' },
    captureLocalEvents: true,
    recovery: { state: 'none' },
    // Not the model's own calls: the handoff lands on the shadow's write, which is the
    // third tool call of the run and the only one it makes.
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT, afterCall: 2 },
    model: (round, body) => {
      const transcript = JSON.stringify(body)
      if (transcript.includes('adversarial shadow reviewer')) return 'FINDING: the recorded value is not supported.'
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded; I have nothing further.'
    },
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const shadowWrite = run.toolCalls.filter((call) => call.name === 'ApplyBatch'
    && JSON.stringify(call.args).includes('shadow_finding'))
  assert.equal(shadowWrite.length, 1, `the shadow finding was written ${shadowWrite.length} time(s)`)
  // The claim that matters: it is reported as not written, and not as rejected either.
  assert.match(run.stdout, /The shadow finding was not written/)
  assert.match(run.stdout, /The finding is not on the Board/)
  assert.doesNotMatch(run.stdout, /Board rejected the shadow finding/)
  assert.ok(run.localEvents.some((event) => event.type === 'shadow-not-written'))
})

test('RT-REC-16 the handoff envelope replaces the result every consumer reads', async () => {
  // The narrow fix would have been to rewrite the model-facing text and leave `result`
  // alone. This asserts the value itself: whatever a caller inspects, the verdict is this
  // request's — not executed — and the earlier outcome is reachable only under a name that
  // says whose it is.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3' },
    chatLines: ['Record a fact.'],
    recovery: { state: 'none' },
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT },
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'It did not run.'),
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const results = run.modelRequests.at(-1).messages.filter((message) => message.role === 'tool')
  const answered = JSON.parse(results.at(-1).content)
  assert.equal(answered.accepted, false)
  assert.equal(answered.requestExecuted, false)
  assert.equal(answered.errorCode, 'request_not_executed')
  // The earlier outcome is present and whole, and it is not the top-level verdict.
  assert.equal(answered.earlierResult.accepted, true)
  assert.equal(answered.earlierResult.revision, 'r7')
  assert.equal(answered.handedOverFrom, 'ApplyAction')
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

test('RT-REC-18 a repeated claim keeps its identity within a session, and is re-minted across one', async () => {
  // §5.2: a resent claim must hit the same handoff rather than ask for a second one, so the
  // identity is held while the claim itself is unresolved. It is *not* held across a session
  // change: the transport key includes the session, so the old id under a new session would
  // be a different call — the same rule the submission path follows.
  let claims = 0
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '4000', RULITH_RECOVERY_POLL_MS: '120' },
    chatLines: ['Carry on.'],
    // The first claim fails at the hop; the second is answered with the handoff.
    tool: (name) => (name === 'QueryBoard' && ++claims === 1 ? HOP_FAILURE : undefined),
    recovery: ({ handoffsDelivered }) => (handoffsDelivered === 0
      ? { state: 'result_ready', callRef: 'call-9', tool: 'ApplyAction' }
      : { state: 'none' }),
    handoff: { tool: 'ApplyAction', callRef: 'call-9', result: EARLIER_RESULT, afterCall: 1 },
    model: () => 'I have the earlier outcome.',
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const attempts = run.toolCalls.filter((call) => call.name === 'QueryBoard')
  assert.equal(attempts.length, 2, `expected one failed claim and one that was answered: ${run.verbs.join(', ')}`)
  assert.equal(attempts[0].id, attempts[1].id,
    'the resent claim asked under a new identity, so the authority would owe it a second handoff')
  assert.equal(attempts[0].sessionId, attempts[1].sessionId)
  // The claim executes nothing, so its own failure never becomes an unresolved submission.
  assert.doesNotMatch(run.stdout, /holding a QueryBoard call/)
  assert.match(run.stdout, /Recovered the outcome of an earlier ApplyAction call/)

  // The cross-session half: the identity is bound to the session that will carry it.
  const source = readFileSync(new URL('../agent/rulith-agent.mjs', import.meta.url), 'utf8')
  assert.match(source, /board\.claim === undefined \|\| board\.claim\.sessionId !== connection\.id/,
    'the claim identity is not re-minted when the session changes')
})
