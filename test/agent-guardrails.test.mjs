// SPDX-License-Identifier: Apache-2.0
/**
 * What one model turn is allowed to make this Agent Runtime do.
 *
 * The defects these arms close share a shape: the runtime treated a model turn as an
 * instruction rather than as a proposal, or treated one task's failure as the process's.
 * Each arm therefore asserts on the wire — what reached the scripted Board, and what the
 * process did afterwards — rather than on a message the Agent printed.
 *
 * The allow-list is now the tool list itself: four verbs, and nothing else can be named.
 * That is a stronger guard than the refusal table it replaced, so these arms enumerate
 * the family anyway: a guard written against one name passes while the sibling that
 * matters walks through.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { MODEL_VERBS, callTool, defaultGateway, runAgent } from './support/agent-harness.mjs'

// ── D. The model may not speak governance, lifecycle selection, or receipts ──

for (const forbidden of [
  { name: 'SealBoard', input: {} },
  { name: 'RegisterPack', input: { packType: 'domain', pack: {} } },
  { name: 'RemovePack', input: { packType: 'domain', name: 'verified-calculation' } },
  { name: 'SetBoardSuspended', input: { suspended: true, reason: 'r' } },
  { name: 'MaintainBoardShared', input: { operations: [] } },
  { name: 'PauseCase', input: {} },
  { name: 'ResumeCase', input: { caseId: 'case-guard-2' } },
  { name: 'RunDischarge', input: { root: 'case-guard-2' } },
  { name: 'GetProjection', input: {} },
  { name: 'ReportWork', input: { workType: 'action', id: 'inv_1', ok: true, result: 'shipped' } },
  { name: 'ClaimWork', input: { workType: 'action', id: 'inv_1' } },
  { name: 'GrantClearance', input: { norm: 'sql:destructive' } },
  { name: 'DefineRole', input: { role: 'admin' } },
]) {
  test(`the model cannot call ${forbidden.name}`, async () => {
    const run = await runAgent({
      argv: ['do the thing'],
      model: (round) => (round === 1 ? callTool(forbidden.name, forbidden.input) : 'I could not do that.'),
    })
    assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
    assert.equal(run.verbs.includes(forbidden.name), false,
      `${forbidden.name} was forwarded to the authority under the Agent's own credential: ${run.verbs.join(', ')}`)
    assert.equal(run.kinds.includes(forbidden.name), false,
      `${forbidden.name} reached the authority through the host protocol path: ${run.kinds.join(', ')}`)
    assert.match(run.stdout, /Refused locally/)
  })
}

test('the four verbs the tool list advertises are still forwarded (calibration)', async () => {
  // Without this arm, an allow-list that refused everything would make every assertion
  // above green while breaking the runtime.
  const run = await runAgent({
    argv: ['apply an action'],
    env: { RULITH_MAX_ROUNDS: '6' },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.value', args: { n: 1 } }] })
      if (round === 3) return callTool('ApplyAction', { action: 'acme.ship', target: 'L1' })
      if (round === 4) return callTool('CloseCase', { disposition: 'abandoned', reason: 'demonstration only' })
      return 'Done.'
    },
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.deepEqual(run.verbs.filter((verb) => MODEL_VERBS.includes(verb)),
    ['OpenCase', 'ApplyBatch', 'ApplyAction', 'CloseCase'])
  assert.doesNotMatch(run.stdout, /Refused locally/)
})

test('a Cloud endpoint that advertises no model verbs stops startup instead of inventing them', async () => {
  const run = await runAgent({ advertise: ['agent_protocol', 'GetCompletion'] })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.match(run.stderr, /does not advertise OpenCase, ApplyBatch, ApplyAction, CloseCase/)
  assert.doesNotMatch(run.stderr, /could not resolve this opaque Agent MCP token/i,
    'a surface that cannot serve this client must not be reported as a credential failure')
})

test('an oversized public MCP response is refused before the Agent buffers it without bound', async () => {
  const run = await runAgent({ oversizeMcpResponse: true })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0, 'an oversized tools/list response must stop startup')
  assert.match(run.stderr, /MCP response exceeded the 1048576-byte limit/)
  assert.doesNotMatch(run.stderr, /Cannot reach the public MCP endpoint/,
    'a size refusal must not be mislabeled as a connectivity failure')
})

// ── E. One task's failure is not the process's ───────────────────────────────

test('an Agent credential rejection terminates the process and never invents a pending Case id', async () => {
  const probe = createServer()
  let servePort
  await new Promise((ready) => probe.listen(0, '127.0.0.1', () => { servePort = probe.address().port; ready() }))
  await new Promise((closed) => probe.close(closed))
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(servePort), RULITH_SERVE_KEY: 'credential-test-key' },
    // The credential is rejected on the first model-verb tool call, which is the first
    // thing a governed turn does and the surface every client crosses.
    model: () => callTool('OpenCase', {}),
    rejectToolAfter: 1,
    serveTasks: ['first accepted task', 'second accepted task'],
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 3, `credential rejection must stop the host, not only one task:\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Task endpoint ready/, 'the test never entered --serve, so it proved only startup failure')
  assert.deepEqual(run.serveStatuses, [202, 202], 'both tasks must have crossed admission before the credential failure')
  assert.match(`${run.stdout}\n${run.stderr}`, /Agent MCP token rejected \(401\)/)
  assert.match(run.stdout, /Task never started: Agent credential rejected/,
    'the already-accepted queued task vanished without a terminal run record')
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /pending_case_id|Case remains open/,
    'no Case was opened, so the failure must not manufacture a resumable Case identity')
})

test('a token rejected by tools/list exits 3 instead of masquerading as an identity parse failure', async () => {
  const run = await runAgent({ rejectAllCredential: true })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 3, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Agent MCP token rejected \(401\)/)
  assert.doesNotMatch(run.stderr, /could not resolve this opaque Agent MCP token/i)
})

test('interactive mode reports a mid-session credential rejection without an unhandled stack', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['do the work'],
    model: () => callTool('OpenCase', {}),
    rejectToolAfter: 1,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 3, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Agent MCP token rejected \(401\)/)
  assert.doesNotMatch(run.stderr, /at mcpRpc|AgentCredentialRejectedError:/,
    'interactive credential failure leaked an unhandled exception stack')
  assert.match(run.stdout, /Stopped\./)
})

test('a one-shot run whose Case never opened exits non-zero', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    tool: (name) => (name === 'OpenCase'
      ? { accepted: false, errorCode: 'case_admission_refused', teaching: 'the Capability Release is not installed on this Board', view: undefined }
      : undefined),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The Case could not be opened, so nothing ran.'),
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(run.code, 1,
    `a task that never opened a Case must not report success; exit was ${run.code}:\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /No Case Context was opened, so this task never started/)
})

test('a one-shot run that the model closes as completed exits zero (calibration)', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '5' },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (round === 3) return callTool('CloseCase', { disposition: 'completed' })
      return 'Finished.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Closed Case .* with disposition "completed"/)
})

test('autopilot nudges once with the current view, then stops rather than looping', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '8' },
    gateway: defaultGateway({ certifyAfterBatch: false }),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'I have nothing further to add.'),
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 3,
    `the host must nudge exactly once and then stop; it made ${run.modelRequests.length} model calls`)
  assert.match(JSON.stringify(run.modelRequests[2]), /The Case is open and the Board has not certified it/)
  assert.match(run.stdout, /the board did not certify the case/)
  assert.match(run.stdout, /remains open/)
  assert.equal(run.verbs.includes('CloseCase'), false, 'the host closed a Case the model never closed')
})

test('autopilot stops on certification without another model turn spent on waiting', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '8' },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'The Board has what it needs.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 3)
  assert.match(run.stdout, /Board certified the case as deliverable \(floor=attested\)/)
  assert.match(run.stdout, /is certified and still open/,
    'a certified Case the model did not close must be reported as such, not booked as finished')
})

test('a void disposition ends the autopilot run as an explicit stop', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '8' },
    gateway: defaultGateway({ certifyAfterBatch: false }),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('CloseCase', { disposition: 'abandoned', reason: 'the required Source is not configured' })
      return 'unreachable'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 2, 'an explicit stop must not be followed by another model turn')
  assert.match(run.stdout, /The Case was closed as abandoned/)
  const closed = run.toolCalls.find((call) => call.name === 'CloseCase')
  assert.equal(closed.args.reason, 'the required Source is not configured')
})

// ── G. One requestId per submission, reused by an unchanged retry ────────────

test('distinct submissions carry distinct requestIds, and an answered one is not reused', async () => {
  // The other half of the retry ledger. An id that never got released would make every
  // repeated read share one identity, which is the same defect wearing the opposite sign.
  const run = await runAgent({
    argv: [],
    env: { RULITH_MAX_ROUNDS: '6' },
    chatLines: ['record two facts'],
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F2', predicate: 'x', args: {} }] })
      return 'Both recorded.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const ids = run.toolCalls.map((call) => call.args.requestId)
  assert.ok(ids.length >= 3, `only ${ids.length} tool calls were observed`)
  assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(String(id))), `every submission must carry a UUID requestId: ${ids.join(', ')}`)
  assert.equal(new Set(ids).size, ids.length, `distinct submissions shared one request identity: ${ids.join(', ')}`)
})

// ── J. A numeric knob with a typo falls back loudly ──────────────────────────

test('a non-numeric RULITH_MAX_ROUNDS warns and falls back instead of becoming NaN', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: 'twelve' },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Nothing further.'),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /RULITH_MAX_ROUNDS="twelve" is not an integer between 1 and 1000; using the default 12/)
  // NaN made every `round <= MAX_ROUNDS` false, so the loop ran zero rounds and the
  // segment ended without ever asking the model anything.
  assert.match(run.stdout, /— Round 1 —/, `the bound was not restored; the loop never ran:\n${run.stdout}`)
})

test('an out-of-range numeric knob is refused the same way', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_SETTLE_WAIT_MS: '-5' },
    model: () => 'Nothing further.',
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /RULITH_SETTLE_WAIT_MS="-5" is not an integer between 0 and 3600000; using the default 60000/)
})

test('a valid numeric knob is used and produces no warning (calibration)', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '5' },
    model: () => 'Nothing further.',
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(run.stderr, /RULITH_MAX_ROUNDS/)
})

// ── K. Trace never becomes the reason a finished run is still running ────────
//
// Trace is on by default and fire-and-forget by design, which is exactly why its failure
// mode is quiet: the run is finished, the exit status is set, and the process is still
// there. Two handles did it — the 1.5s batching timer, and the socket under the flush's
// own request, which the 45s abort budget was the only thing bounding. Every arm below
// times the exit from the endpoint's own clock rather than the harness's, so a slow
// machine cannot turn it into a flake.

test('a trace endpoint that never answers does not hold a finished one-shot run open', async () => {
  const started = Date.now()
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_TRACE: '' },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Nothing further.'),
    holdTrace: true,
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `the run never exited:\n${run.stdout}\n${run.stderr}`)
  assert.ok(run.firstTraceAt !== undefined,
    'no trace batch was sent, so this arm proves nothing about the flush that used to hang')
  // The bound is 1500ms; 8s leaves room for a loaded machine while staying far below the
  // 45s MCP abort budget that was the only thing ending this before.
  const heldFor = run.exitedAt - run.firstTraceAt
  assert.ok(heldFor < 8_000,
    `the wedged trace endpoint held the process for ${heldFor}ms after the batch arrived`
    + ` (total run ${run.exitedAt - started}ms):\n${run.stdout}\n${run.stderr}`)
})

test('a trace endpoint that sends headers but never finishes its body does not hold a finished run open', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_TRACE: '' },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Nothing further.'),
    holdTraceBody: true,
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `response headers must not end the trace timeout:\n${run.stdout}\n${run.stderr}`)
  assert.ok(run.firstTraceAt !== undefined, 'no trace batch reached the body-hanging endpoint')
  const heldFor = run.exitedAt - run.firstTraceAt
  assert.ok(heldFor < 8_000,
    `the body-hanging trace endpoint held the process for ${heldFor}ms after its headers arrived`)
})

test('trace is still sent when the endpoint answers, and the run still exits promptly (calibration)', async () => {
  // Without this arm, an Agent that had simply stopped tracing would satisfy the one
  // above — and the fix under test is about when the batch leaves, not whether it does.
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_TRACE: '' },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Nothing further.'),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const traced = run.calls.filter((call) => call.mode === 'trace')
  assert.ok(traced.length >= 1, 'the run reported no trace batch at all')
  const types = traced.flatMap((call) => (call.events ?? []).map((event) => String(event.type ?? '')))
  assert.ok(types.includes('end'),
    `the final batch was dropped rather than flushed; types seen: ${JSON.stringify(types)}`)
})
